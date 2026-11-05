import { wrapMethods, normalizeHeaderName, Database, InventoryUtils, PackListUtils, ProductionUtils, ApplicationUtils, EditHistoryUtils, InstantWriteUtils, ARCHIVE_TAB_NAME, ARCHIVE_HEADERS, offsetToISO, resolveShortageAlertDays, shortageAlertDateFilters, PREFERENCES_MAPPING, INVENTORY_TAB_PREFERENCES, sanitizeTabName, mapWithConcurrency, ProgressBus, getRandomLoadingQuote, DEFAULT_INVENTORY_MAPPING, ProposalUtils, PROPOSALS_TAB_NAME, PROPOSAL_MAPPING, resolveInventoryNoteMaxLength, firstThumbnail } from './index.js';
import { authState } from '../application/utils/auth.js';
import { instantWriteEntry, identityText, parseColoredName } from './utils/instant-write-config.js';
import { columnTypesEntry } from './utils/column-types.js';

// CACHE tabs with tracked history. EditHistory is always mapped to the key 'edithistory'.
const NOTES_MAPPING = { Path: 'Path', Note: 'Note', Color: 'Color', Size: 'Size', edithistory: 'EditHistory' };

/**
 * CACHING ARCHITECTURE NOTES:
 * 
 * This API layer uses automatic caching via wrapMethods() decorator. Most methods are cached,
 * but MUTATION methods are intentionally excluded from caching.
 * 
 * MUTATION METHODS (excluded from caching):
 * - saveData
 * - createNewTab
 * - showTabs
 * - hideTabs
 * - saveInventoryTabData
 * - savePackList
 * - storeUserData
 * - uploadItemImage
 * 
 * CRITICAL: Mutation methods must NOT:
 * 1. Accept 'deps' as first parameter
 * 2. Use deps.call() to invoke sub-functions
 * 3. Be wrapped by wrapMethods()
 * 
 * WHY: Mutation methods trigger cache invalidation through Database.setData(). If they were
 * cached or used deps.call(), it would create circular dependencies and break the invalidation
 * cascade system. The cache chain is independent from the mutation chain.
 * 
 * The cache invalidation flow:
 * 1. Mutation method calls Database.setData() (or similar)
 * 2. Database layer calls invalidateCache() with dependency info
 * 3. CacheManager cascades invalidation through dependency chain
 * 4. CacheInvalidationBus emits events for 'api' namespace
 * 5. ReactiveStores receive events and reload data
 */

// Define all API methods in a single class
class Requests_uncached {
    /**
     * Save JS objects to a table/tab
     * 
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     * Triggers cache invalidation through Database.setData()
     * 
     * @param {string} tableId - Table identifier
     * @param {string} tabName - Tab name
     * @param {Array<Object>} data - Array of JS objects to save
     * @param {Object} [mapping] - Optional mapping for object keys to sheet headers
     * @returns {Promise<boolean>} - Success status
     */
    static async saveData(tableId, tabName, data, mapping = null) {
        return await Database.setData(tableId, tabName, data, mapping);
    }
    
    /**
     * Get all available tabs for a table
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Table identifier
     * @param {boolean} includeHidden - Whether to include hidden tabs in the result
     * @returns {Promise<Array<{title: string, sheetId: number}>>}
     */
    static async getAvailableTabs(deps, tableId, includeHidden = false) {
        const tabs = await deps.call(Database.getTabs, tableId);
        return includeHidden ? tabs : tabs.filter(tab => !tab.title.startsWith('_'));
    }
    
    /**
     * Create a new tab based on a template
     * 
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     * Calls Database methods directly to avoid circular dependencies
     * 
     * @param {string} tableId - Table identifier
     * @param {string} templateName - Name of the template tab
     * @param {string} newTabName - Name for the new tab
     * @returns {Promise<boolean>} - Success status
     */
    static async createNewTab(tableId, templateName, newTabName) {
        const sanitizedName = sanitizeTabName(newTabName);
        if (!sanitizedName) throw new Error('Tab name cannot be empty after sanitization');
        
        const templateTab = await Database.findTabByName(tableId, templateName);
        if (!templateTab) throw new Error(`Template tab "${templateName}" not found`);
        await Database.createTab(tableId, templateTab, sanitizedName);
        return true;
    }
    
    /**
     * Show specified tabs
     * 
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     * Calls Database methods directly to avoid circular dependencies
     * 
     * @param {string} tableId - Table identifier
     * @param {string[]} tabNames - Names of tabs to show
     */
    static async showTabs(tableId, tabNames) {
        const allTabs = await Database.getTabs(tableId);
        const tabsToShow = allTabs.filter(tab => tabNames.includes(tab.title));
        if (tabsToShow.length === 0) return false;
        await Database.showTabs(tableId, tabsToShow);
        return true;
    }
    
    /**
     * Hide specified tabs
     * 
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     * Calls Database methods directly to avoid circular dependencies
     * 
     * @param {string} tableId - Table identifier
     * @param {string[]} tabNames - Names of tabs to hide
     */
    static async hideTabs(tableId, tabNames) {
        const allTabs = await Database.getTabs(tableId);
        const tabsToHide = allTabs.filter(tab => tabNames.includes(tab.title));
        if (tabsToHide.length === 0) return false;
        await Database.hideTabs(tableId, tabsToHide);
        return true;
    }
    
    static async getItemHeaders(deps, tabName) {
        const packlistData = await deps.call(PackListUtils.getContent, tabName);
        if (Array.isArray(packlistData)) {
            // Find the first crate that has items with actual data
            for (const crate of packlistData) {
                if (Array.isArray(crate.Items) && crate.Items.length > 0) {
                    return Object.keys(crate.Items[0]);
                }
            }
        }
        // Return default schema if no data found
        return;
    }
    
    /**
     * Get information about specific inventory items
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string|string[]} itemName - Item ID(s) to look up
     * @param {string|string[]} fields - Field(s) to retrieve
     * @returns {Promise<Array<Object>>} Item information
     */
    static async getInventoryInfo(deps, itemName, fields, referenceDate) {
        return await deps.call(InventoryUtils.getItemInfo, itemName, fields, referenceDate);
    }
    
    /**
     * Get pack list content for a project
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - The project identifier
     * @param {string} [itemColumnsStart="Pack"] - Column header where item data begins
     * @returns {Promise<Array<Object>>} Array of crate objects
     */
    static async getPackList(deps, projectIdentifier, itemColumnsStart = "Pack") {
        // Return the array of crate objects directly
        return await deps.call(PackListUtils.getContent, projectIdentifier, itemColumnsStart);
    }
    
    /**
     * Get filtered packlists based on schedule parameters
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object|string} filter - Filter parameters (null, {type: 'show-all'}, or schedule filter)
     * @returns {Promise<Array<Object>>} Array of packlist tab objects
     */
    static async getPacklists(deps, filter = null) {
        //console.log('[Requests.getPacklists] Called with filter:', filter);
        const result = await deps.call(PackListUtils.getPacklists, filter);
        //console.log('[Requests.getPacklists] Returning', result.length, 'packlists');
        return result;
    }
    
    /**
     * Store user-specific application data
     * 
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     * Calls ApplicationUtils directly to trigger cache invalidation
     * 
     * @param {Array} data - Array of data to store
     * @param {string} username - The username to store data for
     * @param {string} id - The ID to associate with the data
     * @returns {Promise<boolean>} Success status
     */
    static async storeUserData(data, username, id) {
        return await ApplicationUtils.storeUserData(username, id, data);
    }
    
    /**
     * Retrieve user-specific application data
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} username - The username to retrieve data for
     * @param {string} id - The ID to retrieve data for
     * @returns {Promise<Array|null>} Array of data or null if not found
     */
    static async getUserData(deps, username, id) {
        return await deps.call(ApplicationUtils.getUserData, username, id);
    }

    /**
     * Retrieve the most recent user data entry by ID prefix.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} username - The username to retrieve data for
     * @param {string} keyPrefix - Prefix to match against stored IDs
     * @returns {{id: string, value: *}|null} Matching entry or null if no match exists
     */
    static async getUserDataByPrefix(deps, username, keyPrefix) {
        return await deps.call(ApplicationUtils.getUserDataByPrefix, username, keyPrefix);
    }
    
    /**
     * Check if a user data key or key prefix exists
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} username - The username to check for
     * @param {string} keyOrPrefix - The exact key or prefix to check for
     * @param {boolean} prefixMatch - If true, checks for keys starting with keyOrPrefix
     * @returns {Promise<boolean>} True if key/prefix exists
     */
    static async hasUserDataKey(deps, username, keyOrPrefix, prefixMatch = false) {
        return await deps.call(ApplicationUtils.hasUserDataKey, username, keyOrPrefix, prefixMatch);
    }
    
    /**
     * Lock a spreadsheet tab for a user
     * 
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     * Calls ApplicationUtils directly to trigger cache invalidation
     * 
     * @param {string} spreadsheet - The spreadsheet name (e.g., 'INVENTORY', 'PACK_LISTS')
     * @param {string} tab - The tab name
     * @param {string} user - The user email claiming the lock
     * @returns {Promise<boolean>} Success status
     */
    static async lockSheet(spreadsheet, tab, user, deviceId = null) {
        return await ApplicationUtils.lockSheet(spreadsheet, tab, user, deviceId);
    }
    
    /**
     * Unlock a spreadsheet tab
     * 
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     * Calls ApplicationUtils directly to trigger cache invalidation
     * 
     * @param {string} spreadsheet - The spreadsheet name
     * @param {string} tab - The tab name
     * @param {string} user - The user email releasing the lock
     * @returns {Promise<boolean>} Success status
     */
    static async unlockSheet(spreadsheet, tab, user) {
        //console.log(`[api.unlockSheet] Called with spreadsheet=${spreadsheet}, tab=${tab}, user=${user}`);
        const result = await ApplicationUtils.unlockSheet(spreadsheet, tab, user);
        //console.log(`[api.unlockSheet] ApplicationUtils.unlockSheet returned:`, result);
        return result;
    }
    
    /**
     * Force unlock a spreadsheet tab (admin override)
     * This bypasses user validation and backs up any autosaved data before removing it
     * 
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     * 
     * @param {string} spreadsheet - The spreadsheet name (e.g., 'INVENTORY', 'PACK_LISTS')
     * @param {string} tab - The tab name (e.g., 'FURNITURE', 'ATSC 2025 NAB')
     * @param {string} reason - Optional reason for force unlock (for logging/audit)
     * @returns {Promise<Object>} Result object { success, backupCount, deletedCount, lockOwner, message }
     */
    static async forceUnlockSheet(spreadsheet, tab, reason = '') {
        //console.log(`[api.forceUnlockSheet] Called with spreadsheet=${spreadsheet}, tab=${tab}, reason=${reason}`);
        //console.log(`[api.forceUnlockSheet] ApplicationUtils type:`, typeof ApplicationUtils);
        //console.log(`[api.forceUnlockSheet] ApplicationUtils.forceUnlockSheet type:`, typeof ApplicationUtils.forceUnlockSheet);
        const result = await ApplicationUtils.forceUnlockSheet(spreadsheet, tab, reason);
        //console.log(`[api.forceUnlockSheet] ApplicationUtils.forceUnlockSheet returned:`, result);
        return result;
    }
    
    /**
     * Get lock details for a spreadsheet tab
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} spreadsheet - The spreadsheet name
     * @param {string} tab - The tab name
     * @param {string} [currentUser] - Optional current user email to filter out their own locks
     * @returns {Promise<Object|null>} Lock details or null if not locked
     */
    static async getSheetLock(deps, spreadsheet, tab, currentUser = null) {
        return await deps.call(ApplicationUtils.getSheetLock, spreadsheet, tab, currentUser);
    }
    
    /**
     * Get lock status for a packlist (specialized for analysis pipeline)
     * 
     * PASS-THROUGH METHOD - Not wrapped, calls already-wrapped ApplicationUtils
     * Does NOT accept deps parameter - delegates to ApplicationUtils which handles caching
     * 
     * This is a convenience wrapper for getSheetLock that's designed for use
     * in analysis configurations where only the tab name is provided.
     * 
     * @param {string} tabName - The packlist tab name
     * @param {string} [currentUser] - Optional current user email to filter out their own locks
     * @returns {Promise<Object|null>} Lock details or null if not locked (or locked by current user)
     */
    static async getPacklistLock(deps, tabName, currentUser = null) {
        return await deps.call(ApplicationUtils.getSheetLock, 'PACK_LISTS', tabName, currentUser);
    }
    
    /**
     * Get lock status for an inventory category (specialized for analysis pipeline)
     * 
     * PASS-THROUGH METHOD - Not wrapped, calls already-wrapped ApplicationUtils
     * Does NOT accept deps parameter - delegates to ApplicationUtils which handles caching
     * 
     * This is a convenience wrapper for getSheetLock that's designed for use
     * in analysis configurations where only the tab name is provided.
     * 
     * @param {string} tabName - The inventory category tab name
     * @param {string} [currentUser] - Optional current user email to filter out their own locks
     * @returns {Promise<Object|null>} Lock details or null if not locked (or locked by current user)
     */
    static async getInventoryLock(deps, tabName, currentUser = null) {
        return await deps.call(ApplicationUtils.getSheetLock, 'INVENTORY', tabName, currentUser);
    }
    
    /**
     * Get mapped inventory tab data (with default mapping and optional filters).
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tabOrItemName - Tab name or item name to resolve tab
     * @param {Object} [mapping] - Optional mapping object
     * @param {Object} [filters] - Optional filter parameters
     * @returns {Promise<Array<Object>>}
     */
    static async getInventoryTabData(deps, tabOrItemName, mapping, filters, referenceDate) {
        return await deps.call(InventoryUtils.getInventoryTabData, tabOrItemName, mapping, filters, referenceDate);
    }
    
    /**
     * Get all inventory data from all tabs
     * Each item is tagged with its category tab
     * @param {Object} deps - Dependency decorator for tracking calls
     * @returns {Promise<Array<Object>>} - All inventory items with tab property
     */
    static async getAllInventoryData(deps, referenceDate) {
        // Get all available tabs for INVENTORY
        const tabs = await deps.call(Requests.getAvailableTabs, 'INVENTORY');
        const inventoryTabs = tabs;
        // Every tab in one request; the loop below reads them from the cache
        Database.prefetch('INVENTORY', inventoryTabs.map(tab => tab.title));
        
        ProgressBus.emit('api:getAllInventoryData', {
            current: 0,
            total: inventoryTabs.length,
            message: `Loading inventory tabs...`
        });
        
        const allData = [];
        
        // Load data from each tab
        let tabIdx = 0;
        for (const tab of inventoryTabs) {
            tabIdx++;
            try {
                const tabData = await deps.call(InventoryUtils.getInventoryTabData, tab.title, undefined, undefined, referenceDate);
                
                ProgressBus.emit('api:getAllInventoryData', {
                    current: tabIdx,
                    total: inventoryTabs.length,
                    message: `Loading inventory... ${tabIdx} of ${inventoryTabs.length} tabs`
                });
                
                // Add tab information to each item
                if (Array.isArray(tabData)) {
                    const itemsWithTab = tabData.map(item => ({
                        ...item,
                        tab: tab.title
                    }));
                    allData.push(...itemsWithTab);
                }
            } catch (tabError) {
                console.warn(`[API] Failed to load data from tab ${tab.title}:`, tabError);
                // Continue loading other tabs even if one fails
            }
        }
        
        return allData;
    }
    
    /**
     * Save mapped inventory tab data (with default mapping and optional filters).
     * 
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     * Triggers cache invalidation through InventoryUtils.saveInventoryTabData()
     * 
     * @param {Array<Object>} mappedData - Array of mapped inventory objects
     * @param {string} tabOrItemName - Tab name or item name to resolve tab
     * @param {Object} [mapping] - Optional mapping object
     * @param {Object} [filters] - Optional filter parameters
     * @returns {Promise<boolean>}
     */
    static async saveInventoryTabData(mappedData, tabOrItemName, mapping, filters, referenceDate, options = {}) {
        const username = authState.user?.email || null;
        const { scheduledDate, note, ...rest } = options;
        const noteMaxLength = await Requests.getInventoryNoteMaxLength();
        return await InventoryUtils.saveInventoryTabData(mappedData, tabOrItemName, mapping, filters, username, {
            source: 'web',
            scheduledDate,
            note,
            noteMaxLength,
            ...rest
        });
    }
    
    /**
     * Save pack list data for a project
     * 
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     * Triggers cache invalidation through PackListUtils.savePackList()
     * 
     * @param {Array<Object>} crates - Array of crate objects (with keys/values, Items array)
     * @param {string} projectIdentifier - The project identifier (tab name)
     * @returns {Promise<boolean>} Success status
     */
    static async savePackList(crates, projectIdentifier) {
        console.log("API.savePackList called for project:", projectIdentifier);
        const username = authState.user?.email || null;
        // Pass data directly to PackListUtils.savePackList; transformation is handled there
        return await PackListUtils.savePackList(projectIdentifier, crates, null, username, {
            source: 'web'
        });
    }

    /**
     * Get production schedule data for the table (all, or filtered by overlap params and optional filters).
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object|string} [parameters] - Optional: date range or show identifier
     * @param {Object} [filters] - Optional filter parameters
     * @returns {Promise<Array<Object>>}
     */
    static async getProductionScheduleData(deps, parameters = null, filters = null) {
        return await deps.call(ProductionUtils.getOverlappingShows, parameters, filters);
    }

    /**
     * Get all shows deduplicated with their earliest ship and latest return dates.
     * Used to populate the show overlap selector modal.
     * Deduplicates by show name (using abbreviation matching) + year, ignoring client differences.
     * @param {Object} deps
     * @param {Object|null} filter - Optional filter parameters with { dateFilters, textFilters }
     * @returns {Promise<Array<{show, year, shipDate, returnDate}>>}
     */
    static async getDeduplicatedShowDates(deps, filter = null) {
        return await deps.call(ProductionUtils.getDeduplicatedShowDates, filter);
    }

    /**
     * Compute Identifier from client, year, and show data
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} showName - The name of the show
     * @param {string} clientName - The name of the client
     * @param {number} year - The year of the show
     * @returns {Promise<string>} The computed identifier
     */
    static async computeIdentifier(deps, showName, clientName, year) {
        return deps.call(ProductionUtils.computeIdentifier, showName, clientName, year);
    }

    /**
     * Analyze a schedule row's client/show value against reference index data.
     * Returns a clickable alert object when attention is needed, otherwise null.
     * Now supports checking for NameOverrides to suppress alerts when overrides exist.
     * @param {Object} deps
     * @param {string|Object} rawNameOrRow - Raw name string (legacy) or row object with Client/Show/Year
     * @param {'client'|'show'} referenceType
     * @returns {Promise<Object|null>}
     */
    static async checkScheduleReferenceState(deps, row, referenceType) {
        return await deps.call(ProductionUtils.checkReferenceNameState,
            row[referenceType === 'client' ? 'Client' : 'Show'],
            referenceType,
            row);
    }

    /**
     * Build modal resolution options for a schedule client/show reference value.
     * @param {Object} deps
     * @param {'client'|'show'} referenceType
     * @param {string} rawValue
     * @param {boolean} includeAllCandidates
     * @returns {Promise<{referenceType:string, rawValue:string, options:Array<Object>}>}
     */
    static async getScheduleReferenceResolutionOptions(deps, referenceType, rawValue, includeAllCandidates = false) {
        return await deps.call(ProductionUtils.getReferenceResolutionOptions, referenceType, rawValue, includeAllCandidates);
    }

    /**
     * Ensure CACHE index rows exist for client/show values found in schedule rows.
     * Mutation — uncached.
     * @param {Array<Object>} scheduleRows - Rows containing Client and Show fields
     * @returns {Promise<{clientsAdded:number, showsAdded:number}>}
     */
    static async ensureScheduleReferenceRows(scheduleRows) {
        return await ProductionUtils.ensureScheduleReferenceRows(scheduleRows);
    }

    /**
     * Add a new canonical client/show reference name.
     * Mutation — uncached.
     * @param {'client'|'show'} referenceType
     * @param {string} name
     * @returns {Promise<{added:boolean,rowNumber:number|null}>}
     */
    static async addScheduleReferenceName(referenceType, name) {
        const referenceTab = referenceType === 'show' ? 'Shows' : 'Clients';
        return await ProductionUtils.upsertReferenceEntry(referenceTab, name);
    }

    /**
     * Append an abbreviation token to an indexed client/show.
     * Mutation — uncached.
     * @param {'client'|'show'} referenceType
     * @param {string} canonicalName
     * @param {string} abbreviation
     * @returns {Promise<{updated:boolean,addedRow:boolean,rowNumber:number|null,abbreviations:string}>}
     */
    static async appendScheduleReferenceAbbreviation(referenceType, canonicalName, abbreviation) {
        const referenceTab = referenceType === 'show' ? 'Shows' : 'Clients';
        return await ProductionUtils.upsertReferenceEntry(referenceTab, canonicalName, abbreviation);
    }

    /**
     * Add a custom canonical client/show name and attach the unresolved value as an abbreviation.
     * Mutation — uncached.
     * @param {'client'|'show'} referenceType
     * @param {string} canonicalName
     * @param {string} abbreviation
     * @returns {Promise<{applied:boolean,addedRow:boolean,rowNumber:number|null,canonicalName:string,abbreviation:string,conflict:Object|null}>}
     */
    static async addCustomScheduleReferenceEntry(referenceType, canonicalName, abbreviation) {
        return await ProductionUtils.addCustomReferenceEntry(referenceType, canonicalName, abbreviation);
    }

    /**
     * Get show details by project identifier
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} identifier - Project identifier (e.g., "LOCKHEED MARTIN 2025 NGAUS")
     * @returns {Promise<Object|null>} Show details object or null if not found
     */
    static async getShowDetails(deps, identifier) {
        return await deps.call(ProductionUtils.getShowDetails, identifier);
    }

    /**
     * Diagnose whether a packlist tab title is attached to a schedule row.
     * Returns { attached, hasIdentifierParts, clientIssue, showIssue }.
     * @param {Object} deps
     * @param {string} identifier - Packlist tab title
     * @returns {Promise<Object>}
     */
    static async getPacklistScheduleAttachment(deps, identifier) {
        return await deps.call(ProductionUtils.diagnosePacklistAttachment, identifier);
    }

    /**
     * Aggregate all client/show name mismatches from the production schedule and all
     * packlist tabs. Deduplicates records with the same rawValue + referenceType.
     * @param {Object} deps
     * @returns {Promise<Array<{rawValue:string, referenceType:string, status:string, bestMatch:string|null, sources:Array}>>}
     */
    static async getIndexMismatches(deps) {
        return await deps.call(ProductionUtils.getMissingIndexReferences);
    }

    /**
     * Get all NameOverride mappings from CACHE/NameOverrides.
     * @param {Object} deps
     * @returns {Promise<Array<{schedule:string, packlist:string}>>}
     */
    static async getNameOverrides(deps) {
        return await deps.call(ProductionUtils.getNameOverrides);
    }

    /**
     * Append a NameOverride row linking a schedule identifier to a packlist tab.
     * Pass empty string for either side to permanently ignore that entry.
     * Mutation — uncached.
     * @param {string} scheduleId
     * @param {string} packlistId
     */
    static async addNameOverride(scheduleId, packlistId) {
        return await ProductionUtils.addNameOverride(scheduleId, packlistId);
    }

    // Mutations — uncached. Create or remove a transship link in CACHE/ScheduleOverrides.
    static async setTransshipLink(destinationIdentifier, sourceIdentifier) {
        return await ProductionUtils.setTransshipLink(destinationIdentifier, sourceIdentifier);
    }

    static async removeTransshipLink(destinationIdentifier) {
        return await ProductionUtils.removeTransshipLink(destinationIdentifier);
    }

    /**
     * Get all computed schedule identifiers, sorted alphabetically.
     * @param {Object} deps
     * @returns {Promise<string[]>}
     */
    static async getAllScheduleIdentifiers(deps) {
        return await deps.call(ProductionUtils.getAllScheduleIdentifiers);
    }

    /**
     * Get all non-template packlist tab names that are NOT currently attached to any schedule row.
     * Filters out packlists that have overrides or successfully match to schedule rows.
     * Used for override modals to prevent overriding existing valid matches.
     * @param {Object} deps
     * @returns {Promise<string[]>}
     */
    static async getUnattachedPacklistTabNames(deps) {
        return await deps.call(ProductionUtils.getUnattachedPacklistTabNames);
    }

    // Returns the correct target list for override modals: schedule identifiers when linking from a packlist, unattached packlists otherwise.
    static async getOverrideTargets(deps, sourceType) {
        return sourceType === 'packlist'
            ? await deps.call(ProductionUtils.getAllScheduleIdentifiers)
            : await deps.call(ProductionUtils.getUnattachedPacklistTabNames);
    }

    /**
     * Get the ship date for a project as an ISO date string (YYYY-MM-DD).
     * @param {Object} deps
     * @param {string} projectIdentifier
     * @returns {Promise<string|null>}
     */
    static async getTransshipSourceForShow(deps, identifier) {
        return await deps.call(ProductionUtils.getTransshipSourceForShow, identifier);
    }

    static async getTransshipSourceForScheduleRow(deps, rowObj) {
        return await deps.call(ProductionUtils.getTransshipSourceForScheduleRow, rowObj);
    }

    static async getTransshipDestinationsForShow(deps, identifier) {
        return await deps.call(ProductionUtils.getTransshipDestinationsForShow, identifier);
    }

    static async getTransshipDestinationsForScheduleRow(deps, rowObj) {
        return await deps.call(ProductionUtils.getTransshipDestinationsForScheduleRow, rowObj);
    }

    static async getTransshipSourceEndDateForRow(deps, rowObj) {
        return await deps.call(ProductionUtils.getTransshipSourceEndDateForRow, rowObj);
    }

    static async getProjectShipDate(deps, projectIdentifier) {
        return await deps.call(ProductionUtils.getProjectShipDate, projectIdentifier);
    }

    static async getProjectReturnDate(deps, projectIdentifier) {
        return await deps.call(ProductionUtils.getProjectReturnDate, projectIdentifier);
    }

    /**
     * Get a full item timeline for a date window.
     * Rows: inventory changes, scheduled changes, show ship/return events.
     * @param {Object} deps
     * @param {string} itemId - Item identifier (e.g. "F-101")
     * @param {string} startDate - ISO date string (YYYY-MM-DD), window start
     * @param {string} endDate - ISO date string (YYYY-MM-DD), window end
     * @returns {Promise<Array<{date, event, note, change, quantity}>>}
     */
    static async getItemTimeline(deps, itemId, startDate, endDate) {
        return await deps.call(InventoryUtils.getItemTimeline, itemId, startDate, endDate);
    }

    /**
     * Get the minimum inventory quantity for an item over a date range.
     * @param {Object} deps
     * @param {string} itemId
     * @param {string|null} startDate - ISO date string (YYYY-MM-DD)
     * @param {string|null} endDate - ISO date string (YYYY-MM-DD)
     * @returns {Promise<number|null>}
     */
    static async getItemMinQuantityInRange(deps, itemId, startDate, endDate) {
        return await deps.call(InventoryUtils.getItemMinQuantityInRange, itemId, startDate, endDate);
    }

    /**
     * Check if a packlist exists for a schedule row
     * Used by reactive store analysis to enrich schedule data with packlist information
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object} scheduleRow - Full schedule row object with Show, Client, Year properties
     * @returns {Promise<Object>} Object with { exists: boolean, identifier: string|null }
     */
    static async checkPacklistExists(deps, rowData) {
        const availableTabs = await deps.call(Database.getTabs, 'PACK_LISTS');
        const matchingTabs = await deps.call(ProductionUtils.findPacklistTabsForScheduleRow, rowData, availableTabs);
        
        if (matchingTabs.length > 0) {
            const identifier = matchingTabs[0]?.title || null;
            return {
                exists: true,
                identifier,
                identifiers: matchingTabs.map(t => t.title)
            };
        }
        
        // No match found - return the computed identifier for "Create Packlist" button
        const identifier = await deps.call(ProductionUtils.getCanonicalIdentifierForScheduleRow, rowData);
        return {
            exists: false,
            identifier
        };
    }

    /**
     * Normalize ship date to include year, guessing if missing
     * Used by reactive store analysis to ensure all ship dates display with years
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object} scheduleRow - Full schedule row object
     * @returns {Promise<string|null>} Normalized ship date with year or null
     */
    static async guessShipDate(deps, rowData) {
        // Always normalize to ensure year is included in display
        return await deps.call(ProductionUtils.guessShipDate, rowData);
    }

    /**
     * Normalize show start date to include year
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object} scheduleRow - Full schedule row object
     * @returns {Promise<string|null>} Normalized start date with year or null
     */
    static async normalizeStartDate(deps, rowData) {
        return await deps.call(ProductionUtils.normalizeStartDate, rowData);
    }

    /**
     * Normalize show end date to include year
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object} scheduleRow - Full schedule row object
     * @returns {Promise<string|null>} Normalized end date with year or null
     */
    static async normalizeEndDate(deps, rowData) {
        return await deps.call(ProductionUtils.normalizeEndDate, rowData);
    }

    /**
     * Item thumbnails for pages whose rows aren't inventory rows: [{ item, file }], the displayed
     * file ID of each item ('' when it has none) in tabs that have a Thumbnail column. Items of
     * other tabs are absent: they have no thumbnails. A bare file ID is a valid thumbnail value
     * (parseThumbnails), which keeps this small. Persisted (CACHE/Analytics): it reads every
     * inventory tab.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @returns {Promise<Array<{item: string, file: string}>>}
     */
    static async getItemThumbnails(deps) {
        const rows = await deps.call(Requests.getAllInventoryData);
        return rows
            .filter(row => row.itemNumber && 'thumbnail' in row)
            .map(row => ({ item: row.itemNumber, file: firstThumbnail(row.thumbnail) || '' }));
    }

    /**
     * Category images from the inventory INDEX: [{ prefix, file }] (Drive file ID).
     * @param {Object} deps - Dependency decorator for tracking calls
     * @returns {Promise<Array<{prefix: string, file: string}>>}
     */
    static async getCategoryThumbnails(deps) {
        return await deps.call(InventoryUtils.getCategoryThumbnails);
    }

    /**
     * Fetch a Drive file's raw content as a Blob.
     * NOT CACHED — excluded from wrapping; callers own the result (thumbnail cache, full-size image modal).
     * Does NOT accept deps parameter.
     * @param {string} fileId - Google Drive file ID
     * @returns {Promise<Blob|null>} The file content, or null on failure
     */
    static async getDriveFileBlob(fileId) {
        return await Database.getDriveFileBlob(fileId);
    }

    /**
     * Upload an item image to the Drive thumbnails folder (or reuse an identical one already
     * there). Only uploads: the caller puts the file ID in the item's Thumbnail cell, and the
     * table's save keeps it.
     *
     * MUTATION METHOD - Excluded from caching
     * Does NOT accept deps parameter or use deps.call()
     *
     * @param {File} file - The image file to upload
     * @param {string} itemNumber - Item number the image belongs to (used in the file name)
     * @returns {Promise<{fileId: string, file: File, reused: boolean}|null>} The Drive file ID and
     *   the uploaded (resized) image, or null on failure
     */
    static async uploadItemImage(file, itemNumber) {
        return await Database.uploadItemImage(file, itemNumber);
    }

    /**
     * Get the tab name for a specific item
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} itemName - The item name/ID to search for
     * @returns {Promise<string|null>} Tab name or null if not found
     */
    static async getTabNameForItem(deps, itemName) {
        return await deps.call(InventoryUtils.getTabNameForItem, itemName);
    }

    /**
     * Get the full inventory INDEX with parsed metadata.
     * Returns an array of { prefix, tab, folder, metadata } where metadata is a parsed object.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @returns {Promise<Array<{prefix:string, tab:string, folder:string, metadata:Object}>>}
     */
    static async getInventoryIndexData(deps) {
        return await deps.call(InventoryUtils.getInventoryIndex);
    }

    /**
     * Extract item number from text using regex
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} text - Text to search for item number
     * @returns {Promise<string|null>} Item number or null if not found
     */
    static async extractItemNumber(deps, text) {
        const extracted = await deps.call(PackListUtils.extractItemFromText, text);
        return extracted.itemNumber;
    }

    /**
     * Extract quantity from text using regex
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} text - Text to search for quantity
     * @returns {Promise<number>} Quantity found or 1 if no quantity specified
     */
    static async extractQuantity(deps, text) {
        const extracted = await deps.call(PackListUtils.extractItemFromText, text);
        return extracted.quantity;
    }

    /**
     * Extract an item with a nonstandard item number (tabs in InventoryCustomItemNumbers) from text
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} text - Text to extract the item from
     * @param {string[]} [ctgFilter] - Only these tabs (case insensitive)
     * @returns {Promise<Object>} Object with {quantity: number, itemNumber: string|null, description: string}
     */
    static async extractCustomItemFromText(deps, text, ctgFilter = undefined) {
        return await deps.call(PackListUtils.extractCustomItemFromText, text, ctgFilter);
    }

    /**
     * Compare item description with inventory description and return alert if mismatch
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object} item - Item object from packlist
     * @param {string} item['Extracted Item'] - The item number to look up in inventory
     * @param {string} item.Description - The current item description to compare
     * @param {string} item['Packing/shop notes'] - Alternative source for description
     * @returns {Promise<Object|null>} Alert object if match is poor, null if good match
     */
    static async checkDescriptionMatch(deps, itemData) {
        // Extract item number and description from the extracted columns
        const itemNumber = itemData['Extracted Item'];
        const description = itemData.Description || itemData['Packing/shop notes'] || '';
        
        if (!itemNumber || !description) {
            return null;
        }
        
        // Get comparison result from business logic layer
        const result = await deps.call(PackListUtils.checkDescriptionMatch, itemNumber, description);
        
        if (!result) {
            return null;
        }
        
        // Build alert object based on comparison result
        if (!result.inventoryFound) {
            return {
                type: 'item warning',
                color: 'purple',
                clickable: true,
                message: `No inventory description`,
                score: 0,
                error: result.error
            };
        }

        // A variant the base item's inventory description doesn't declare (it still counts as the base item)
        if (result.undeclared) {
            return {
                type: 'undeclared variant',
                color: 'yellow',
                clickable: true,
                message: `Undeclared variant of ${itemNumber}`,
                variant: result.variant,
                details: `${result.variant} counts as ${itemNumber}. To describe it, add a line to ${itemNumber}'s inventory description, such as:\n(1) ${result.variant} with ...`
            };
        }

        const color = result.score < 0.5 ? 'purple' : 'white';

        // Return alert if match is less than 100%
        if (result.score < 1) {
            return {
                type: 'description mismatch',
                color: color,
                clickable: true,
                message: `Description mismatch`,
                score: result.score,
                packlistDescription: result.packlistDescription,
                inventoryDescription: result.inventoryDescription,
                ...(result.variant ? { variant: result.variant } : {})
            };
        }

        // Good match, no alert needed
        return null;
    }

    /**
     * Check a pack list line's variant quantities (PackListUtils.checkVariantLevel) and return an
     * alert: a declared variant that runs short or has no spare, or a base line whose unmodified
     * pieces run short (a soft warning). Tabs in InventorySuppressCategoryAnalysis are skipped.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object} item - Item object from packlist
     * @param {string} currentProjectId - Current project identifier
     * @returns {Promise<Object|null>} Alert object, or null
     */
    static async checkVariantLevel(deps, item, currentProjectId) {
        const itemNumber = item['Extracted Item'];
        const text = item.Description || item['Packing/shop notes'] || '';
        if (!itemNumber || !text || !currentProjectId) return null;

        const tab = await deps.call(InventoryUtils.getTabNameForItem, itemNumber);
        const skippedTabs = await deps.call(InventoryUtils.getPreferenceTabs, INVENTORY_TAB_PREFERENCES.skipAnalysis);
        if (tab && skippedTabs.includes(tab)) return null;

        const level = await deps.call(PackListUtils.checkVariantLevel, text, currentProjectId);
        if (!level) return null;
        const { kind, remaining } = level;
        const name = kind === 'variant' ? level.itemNumber : `Unmodified ${level.itemNumber}`;
        const details = [
            `${name}: ${level.available} in inventory, ${level.needed} needed by this and overlapping shows.`,
            ...level.shows.map(entry => `${entry.show}: ${entry.quantity}`)
        ].join('\n');

        if (remaining < 0) {
            return {
                type: 'variant shortage',
                color: kind === 'variant' ? 'red' : 'orange',
                clickable: true,
                message: `${name}: ${-remaining} short`,
                details,
                remaining
            };
        }
        if (kind === 'variant' && remaining < 1) {
            return {
                type: 'variant shortage',
                color: 'orange',
                clickable: true,
                message: `${name}: no buffer`,
                details,
                remaining
            };
        }
        return null;
    }

    /**
     * Check edit history source timeline and create an alert for CAD-overwritten rows.
     * Condition: most recent edit source is CAD and a prior web/app edit exists.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string|Object} rawHistory - EditHistory string or parsed object
     * @returns {Promise<Object|null>} Alert object for AppData or null
     */
    static async checkCadSourceHistory(deps, rawHistory) {
        if (!rawHistory) {
            return null;
        }

        let parsedHistory;
        if (typeof rawHistory === 'string') {
            try {
                parsedHistory = JSON.parse(rawHistory);
            } catch (error) {
                return null;
            }
        } else if (typeof rawHistory === 'object') {
            parsedHistory = rawHistory;
        } else {
            return null;
        }

        const history = Array.isArray(parsedHistory?.h) ? parsedHistory.h : [];
        if (history.length === 0) {
            return null;
        }

        const normalizeSource = (entry) => {
            const sourceValue = String(entry?.s || entry?.source || 'web').toLowerCase();
            if (sourceValue === 'app') return 'web';
            return sourceValue;
        };

        const mostRecent = history[0];
        const mostRecentSource = normalizeSource(mostRecent);
        if (mostRecentSource !== 'cad') {
            return null;
        }

        const hasPriorWebOrAppEdit = history
            .slice(1)
            .some(entry => normalizeSource(entry) === 'web');

        if (!hasPriorWebOrAppEdit) {
            return null;
        }

        // CAD block is contiguous from newest entry while source is cad.
        const leadingCadEntries = [];
        for (const entry of history) {
            if (normalizeSource(entry) === 'cad') {
                leadingCadEntries.push(entry);
            } else {
                break;
            }
        }

        // Find the most recent web/app edit before any cad changes.
        const previousWebEntry = history
            .slice(leadingCadEntries.length)
            .find(entry => normalizeSource(entry) === 'web') || null;

        const previousWebSummary = previousWebEntry
            ? `${previousWebEntry.u || 'unknown'} at ${EditHistoryUtils.formatTimestampHuman(previousWebEntry.t)}`
            : 'unknown';

        // To restore pre-CAD state, apply old values from leading CAD entries newest->oldest.
        const restoreChanges = [];
        leadingCadEntries.forEach(entry => {
            if (Array.isArray(entry?.c)) {
                entry.c.forEach(change => {
                    if (change && change.n !== undefined) {
                        restoreChanges.push({ n: change.n, o: change.o });
                    }
                });
            }
        });

        return {
            type: 'cad-source-change',
            color: 'yellow',
            clickable: true,
            message: `changed in cad by ${mostRecent?.u || 'unknown'}`,
            cadUser: mostRecent?.u || 'unknown',
            previousWebSummary,
            previousWebEntry,
            restoreChanges,
            sourceTimeline: history.map(entry => ({
                s: normalizeSource(entry),
                u: entry?.u || 'unknown',
                t: entry?.t || null
            }))
        };
    }

    /**
     * Get item quantities summary for a project (transformed to table format)
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - The project identifier
     * @returns {Promise<Array<Object>>} Array of item objects for table display
     */
    static async getItemQuantitiesSummary(deps, projectIdentifier) {
        //sleep for a long time to simulate loading
        return await deps.call(PackListUtils.getItemQuantitiesSummary, projectIdentifier);
    }

    /**
     * Get item quantities summary for multiple shows based on search parameters
     * Finds shows matching the search criteria, then extracts items from them
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object|Array} filter - Schedule filter parameters (e.g., { dateFilters: [...] }) or legacy array of identifiers
     * @param {Object|string} searchParams - Search parameters for text filters, or legacy ctgFilter
     * @param {string|undefined} ctgFilter - Optional category filter (new signature) or undefined
     * @returns {Promise<Array<Object>>} Array of item objects with quantities per show
     */
    static async getMultipleShowsItemsSummary(deps, filter = null, searchParams = null, ctgFilter = undefined, includeEmptyShows = true) {
        // Legacy signature: (deps, projectIdentifiers, ctgFilter)
        if (Array.isArray(filter)) {
            return await deps.call(PackListUtils.extractItemsFromMultipleShows, filter, searchParams);
        }
        
        // New signature: (deps, filterParams, searchParams, ctgFilter)
        // Find all shows matching the search criteria
        const shows = await deps.call(ProductionUtils.getOverlappingShows, filter, searchParams);
        
        const resolvedShows = (await mapWithConcurrency(
            shows,
            async (showRow) => {
                const identifier = await deps.call(ProductionUtils.getCanonicalIdentifierForScheduleRow, showRow);
                if (!identifier) return null;

                const [shipDate, returnDate] = await Promise.all([
                    deps.call(ProductionUtils.getProjectShipDate, identifier).catch(() => null),
                    deps.call(ProductionUtils.getProjectReturnDate, identifier).catch(() => null)
                ]);

                return {
                    identifier,
                    shipDate: shipDate || null,
                    returnDate: returnDate || shipDate || null
                };
            },
            8,
            ({ processed, total }) => {
                ProgressBus.emit('api:getMultipleShowsItemsSummary', {
                    current: processed,
                    total,
                    message: `Step 1/3: Getting schedule data...`
                });
            }
        )).filter(Boolean);

        const projectIdentifiers = resolvedShows.map(show => show.identifier);

        // Extract items from the identified shows
        // Convert string filter to array as extractItemsFromMultipleShows expects an array
        const categoryFilterArray = ctgFilter ? [ctgFilter] : undefined;
        // Relay sub-function progress onto this function's topic so the loading indicator updates
        const _onExtractProgress = (data) => ProgressBus.emit('api:getMultipleShowsItemsSummary', data);
        ProgressBus.on('packlist:extractItemsFromMultipleShows', _onExtractProgress);
        let rawItemRows;
        try {
            rawItemRows = await deps.call(PackListUtils.extractItemsFromMultipleShows, projectIdentifiers, categoryFilterArray, includeEmptyShows);
        } finally {
            ProgressBus.off('packlist:extractItemsFromMultipleShows', _onExtractProgress);
        }

        // Leave out items in tabs the InventorySuppressCategoryAnalysis preference lists
        const skippedTabs = await deps.call(InventoryUtils.getPreferenceTabs, INVENTORY_TAB_PREFERENCES.skipAnalysis);
        const itemTabs = skippedTabs.length
            ? await mapWithConcurrency(rawItemRows, row => deps.call(InventoryUtils.getTabNameForItem, row.itemId), 8)
            : [];
        const itemRows = rawItemRows.filter((row, i) => !skippedTabs.includes(itemTabs[i]));

        const today = await deps.call(ApplicationUtils.getToday);
        const dateFilters = Array.isArray(filter?.dateFilters) ? filter.dateFilters : [];
        const getFilterDate = (column, type) => offsetToISO(dateFilters.find(f => f.column === column && f.type === type)?.value, today);

        let reportStart = getFilterDate('Date', 'after') || getFilterDate('Ship', 'after') || null;
        let reportEnd = getFilterDate('Date', 'before') || getFilterDate('Ship', 'before') || null;

        const shipDates = resolvedShows.map(show => show.shipDate).filter(Boolean).sort();
        const returnDates = resolvedShows.map(show => show.returnDate).filter(Boolean).sort();
        if (!reportStart) {
            reportStart = shipDates[0] || today;
        }
        if (!reportEnd) {
            reportEnd = returnDates[returnDates.length - 1] || shipDates[shipDates.length - 1] || reportStart;
        }

        const showRanges = new Map(
            resolvedShows.map(show => [show.identifier, { shipDate: show.shipDate, returnDate: show.returnDate || show.shipDate }])
        );
        const getShowsForRange = (rowShows, startDate, endDate) => {
            if (!rowShows || typeof rowShows !== 'object') return {};

            const filteredShows = {};
            for (const [showId, quantity] of Object.entries(rowShows)) {
                if (!quantity) continue;

                const range = showRanges.get(showId);
                if (!range) {
                    filteredShows[showId] = quantity;
                    continue;
                }

                const showStart = range.shipDate;
                const showEnd = range.returnDate || showStart;
                const overlaps = (!showStart || !endDate || showStart <= endDate)
                    && (!showEnd || !startDate || showEnd >= startDate);

                if (overlaps) {
                    filteredShows[showId] = quantity;
                }
            }

            return filteredShows;
        };

        if (includeEmptyShows) {
            return await mapWithConcurrency(itemRows, async (row) => ({
                ...row,
                startDate: reportStart || null,
                endDate: reportEnd || null,
                minQty: await deps.call(InventoryUtils.getItemMinQuantityInRange, row.itemId, reportStart, reportEnd)
            }));
        }

        const shortageRows = [];
        // NOTE: Explicit yield every 5 items — only needed while the abstraction layer runs on
        // the browser main thread. Remove when refactoring to a real backend API.
        let _shortageRowIdx = 0;
        for (const row of itemRows) {
            if (_shortageRowIdx++ > 0 && _shortageRowIdx % 5 === 0) {
                await new Promise(r => setTimeout(r, 0));
                ProgressBus.emit('api:getMultipleShowsItemsSummary', {
                    current: _shortageRowIdx,
                    total: itemRows.length,
                    message: `Step 3/3: Building report... ${getRandomLoadingQuote()}`
                });
            }
            const timeline = await deps.call(InventoryUtils.getItemTimeline, row.itemId, reportStart, reportEnd);

            if (!Array.isArray(timeline) || timeline.length === 0) {
                shortageRows.push({
                    ...row,
                    startDate: null,
                    endDate: null,
                    minQty: null,
                    shows: row.shows || {}
                });
                continue;
            }

            const quantities = timeline
                .map(event => event.quantity)
                .filter(quantity => quantity !== null && quantity !== undefined && !Number.isNaN(Number(quantity)))
                .map(quantity => Number(quantity));
            const overallMinQty = quantities.length ? Math.min(...quantities) : null;

            let activeShortage = null;
            let hasShortage = false;
            const finalizeShortage = () => {
                if (!activeShortage) return;

                shortageRows.push({
                    ...row,
                    startDate: activeShortage.startDate,
                    endDate: activeShortage.endDate || activeShortage.startDate,
                    minQty: activeShortage.minQty,
                    shows: getShowsForRange(row.shows, activeShortage.startDate, activeShortage.endDate || activeShortage.startDate)
                });
                activeShortage = null;
            };

            for (let index = 0; index < timeline.length; index++) {
                const event = timeline[index];
                const quantity = event.quantity === null || event.quantity === undefined ? null : Number(event.quantity);
                if (quantity === null || Number.isNaN(quantity)) continue;

                const nextDate = timeline[index + 1]?.date || reportEnd || event.date || reportStart;
                if (quantity < 1) {
                    hasShortage = true;
                    if (!activeShortage) {
                        activeShortage = {
                            startDate: event.date || reportStart || null,
                            endDate: nextDate || event.date || reportEnd || reportStart || null,
                            minQty: quantity
                        };
                    } else {
                        activeShortage.endDate = nextDate || activeShortage.endDate;
                        activeShortage.minQty = Math.min(activeShortage.minQty, quantity);
                    }
                    continue;
                }

                finalizeShortage();
            }

            finalizeShortage();

            if (!hasShortage) {
                shortageRows.push({
                    ...row,
                    startDate: null,
                    endDate: null,
                    minQty: overallMinQty,
                    shows: row.shows || {}
                });
            }
        }

        return shortageRows.sort((left, right) => {
            if ((left.startDate || '') !== (right.startDate || '')) {
                return (left.startDate || '') < (right.startDate || '') ? -1 : 1;
            }
            if (left.itemId !== right.itemId) {
                return left.itemId < right.itemId ? -1 : 1;
            }
            return (left.endDate || '') < (right.endDate || '') ? -1 : 1;
        });
    }

    /**
     * Inventory shortage alerts: the item shortage report for shows from today through the
     * InventoryShortageAlertDays preference, cut to the periods where an item runs out
     * (minimum quantity below 0). Persisted (CACHE/Analytics), so a session starts from the last
     * saved result unless its sources or the date changed since.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @returns {Promise<Array<{itemId: string, tabName: string|null, startDate: string|null,
     *          endDate: string|null, minQty: number, shows: string[]}>>} One row per shortage
     *          period; empty when the preference is missing or 0
     */
    static async getInventoryShortageAlerts(deps) {
        const days = resolveShortageAlertDays(await deps.call(Requests.getPreferences));
        if (!days) return [];
        // Same arguments as the report page opened on these filters, so the two share the cache
        const rows = await deps.call(Requests.getMultipleShowsItemsSummary, { dateFilters: shortageAlertDateFilters(days) }, {}, null, false);
        const shortages = rows.filter(row => typeof row.minQty === 'number' && row.minQty < 0);
        return await mapWithConcurrency(shortages, async (row) => ({
            itemId: row.itemId,
            tabName: await deps.call(InventoryUtils.getTabNameForItem, row.itemId),
            startDate: row.startDate || null,
            endDate: row.endDate || null,
            minQty: row.minQty,
            shows: Object.keys(row.shows || {}).filter(show => (row.shows[show] || 0) > 0)
        }), 8);
    }

    /**
     * Resolve a packlist identifier to its actual tab name
     * Handles abbreviations, case variations, and fuzzy matching
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} identifier - The identifier to resolve (could be abbreviation or variation)
     * @returns {Promise<string|null>} Actual tab name if found, null otherwise
     */
    static async resolvePacklistIdentifier(deps, identifier) {
        const tabs = await deps.call(Database.getTabs, 'PACK_LISTS');
        const resolvedTab = await deps.call(ProductionUtils.findPackListTab, identifier, tabs);
        return resolvedTab ? resolvedTab.title : null;
    }

    /**
     * Get packlist summary description
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - The project identifier (tab name)
     * @returns {Promise<string>} Formatted description string
     */
    static async getPacklistDescription(deps, projectIdentifier) {
        const summary = await deps.call(PackListUtils.getPacklistSummary, projectIdentifier);
        
        if (summary.totalCrates === 0 && summary.totalItems === 0) {
            return 'Empty packlist';
        }

        const parts = [];
        
        if (summary.totalCrates > 0) {
            parts.push(`${summary.totalCrates} crate${summary.totalCrates !== 1 ? 's' : ''}`);
        }
        
        if (summary.itemCount > 0) {
            parts.push(`${summary.itemCount} unique item${summary.itemCount !== 1 ? 's' : ''}`);
        }
        
        if (summary.totalItems > 0) {
            parts.push(`${summary.totalItems} total item${summary.totalItems !== 1 ? 's' : ''}`);
        }

        return parts.join('<br>');
    }

    /**
     * Get inventory quantity for a specific item
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} itemId - The item ID to look up
     * @returns {Promise<number|null>} Available inventory quantity, or null if item not found in inventory
     */
    static async getItemInventoryQuantity(deps, itemId, referenceDate) {
        return await deps.call(PackListUtils.getItemInventoryQuantity, itemId, referenceDate);
    }

    /**
     * Get overlapping projects that use a specific item
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} currentProjectId - Current project identifier
     * @param {string} itemId - Item ID to check for conflicts
     * @returns {Promise<Array<string>>} Array of overlapping project identifiers that use this item
     */
    static async getItemOverlappingPacklists(deps, currentProjectId, itemId) {
        return await deps.call(PackListUtils.getItemOverlappingPacklists, currentProjectId, itemId);
    }

    /**
     * Calculate remaining quantity for an item based on inventory, current usage, and overlapping shows
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} currentProjectId - Current project identifier
     * @param {string} itemId - Item ID to calculate remaining quantity for
     * @returns {Promise<number|null>} Remaining available quantity, or null if item not found in inventory
     */
    static async calculateRemainingQuantity(deps, currentProjectId, itemId, referenceDate) {
        return await deps.call(PackListUtils.calculateRemainingQuantity, currentProjectId, itemId, referenceDate);
    }

    /**
     * Check inventory levels for an item and return alert if low/shortage
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object} item - Item object from packlist
     * @param {string} item['Extracted Item'] - The item number to check
     * @param {string} currentProjectId - Current project identifier
     * @returns {Promise<Object|null>} Alert object if inventory is low/shortage, null if sufficient
     */
    static async checkInventoryLevel(deps, item, currentProjectId) {
        // item is the full item object (needed for all fields for context)
        const itemNumber = item['Extracted Item'];
        
        if (!itemNumber || !currentProjectId) {
            return null;
        }
        
        // Skip alert generation for tabs in InventorySuppressCategoryAnalysis preference
        const tab = await deps.call(InventoryUtils.getTabNameForItem, itemNumber);
        const skippedTabs = await deps.call(InventoryUtils.getPreferenceTabs, INVENTORY_TAB_PREFERENCES.skipAnalysis);
        if (tab && skippedTabs.includes(tab)) {
            return null;
        }
        
        try {
            // Resolve ship date so remaining quantity reflects inventory at time of packing
            const shipDate = await deps.call(ProductionUtils.getProjectShipDate, currentProjectId);
            const referenceDate = shipDate || await deps.call(ApplicationUtils.getToday);

            // Get remaining quantity from business logic layer
            const remaining = await deps.call(PackListUtils.calculateRemainingQuantity, currentProjectId, itemNumber, referenceDate);
            
            // Check if item not found in inventory
            if (remaining === null) {
                return {
                    type: 'item not found',
                    color: 'yellow',
                    clickable: true,
                    message: 'Not in inventory',
                    remaining: null
                };
            }
            
            // Build alert object based on inventory level
            // Universal autoColor rule: < 0 → red, < 1 → orange, >= 1 → no alert
            if (remaining < 0) {
                return {
                    type: 'item shortage',
                    clickable: true,
                    message: `Shortage: ${Math.abs(remaining)} units short`,
                    remaining
                };
            } else if (remaining < 1) {
                return {
                    type: 'item warning',
                    clickable: true,
                    message: 'No inventory buffer',
                    remaining
                };
            } else if (remaining <= 2) {
                return {
                    type: 'low-inventory',
                    color: 'white',
                    clickable: true,
                    message: `Low: ${remaining} remaining`,
                    remaining
                };
            }
            
            // Sufficient inventory, no alert needed
            return null;
        } catch (error) {
            console.error(`Error checking inventory for ${itemNumber}:`, error);
            return null;
        }
    }

    /**
     * Get full item description from inventory
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} itemId - The item identifier
     * @returns {Promise<string>} Full item description
     */
    static async getItemDescription(deps, itemId, referenceDate) {
        return await deps.call(InventoryUtils.getItemDescription, itemId, referenceDate);
    }

    /**
     * Get inventory rows that have a pending entry matching the given effective date.
     * Used to populate the scheduled-change editor modal.
     * @param {Object} deps
     * @param {string} tabOrItemName
     * @param {number} effectiveDateDeciseconds
     * @param {Object} [mapping]
     * @returns {Promise<Array<Object>>}
     */
    static async getInventoryRowsForPendingEntry(deps, tabOrItemName, effectiveDateDeciseconds, mapping) {
        return await deps.call(InventoryUtils.getInventoryRowsForPendingEntry, tabOrItemName, effectiveDateDeciseconds, mapping);
    }

    /**
     * Check and apply any pending inventory changes due today or earlier.
     * Mutation — uncached. Saves the tab if any changes were applied.
     * @param {string} tabOrItemName
     * @returns {Promise<{ applied: boolean }>}
     */
    static async checkAndApplyPendingChanges(tabOrItemName) {
        const username = authState.user?.email || null;
        return await InventoryUtils.checkAndApplyPendingChanges(tabOrItemName, username);
    }

    /**
     * Update a scheduled pending change entry (by effectiveDateDeciseconds) on matching rows.
     * Mutation — uncached. Only the EditHistory column is written back.
     * @param {string} tabOrItemName
     * @param {Array<Object>} originalRows
     * @param {Array<Object>} editedRows
     * @param {number} effectiveDateDeciseconds
     * @param {string} [note]
     * @returns {Promise<boolean>}
     */
    static async savePendingChangeEntry(tabOrItemName, originalRows, editedRows, effectiveDateDeciseconds, note) {
        const username = authState.user?.email || null;
        const noteMaxLength = await Requests.getInventoryNoteMaxLength();
        return await InventoryUtils.savePendingChangeEntry(tabOrItemName, originalRows, editedRows, effectiveDateDeciseconds, note, username, undefined, noteMaxLength);
    }

    /**
     * Delete a scheduled pending change entry by effectiveDateDeciseconds.
     * Mutation — uncached.
     * @param {string} tabOrItemName
     * @param {number} effectiveDateDeciseconds
     * @returns {Promise<boolean>}
     */
    static async deletePendingChangeEntry(tabOrItemName, effectiveDateDeciseconds) {
        const username = authState.user?.email || null;
        return await InventoryUtils.deletePendingChangeEntry(tabOrItemName, effectiveDateDeciseconds, username);
    }

    /**
     * Get rows archived (deleted) from one tab, newest first.
     * Reads the _EditHistory tab of the same spreadsheet (contract: "Archive Table").
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Spreadsheet id (INVENTORY, PACK_LISTS, CACHE)
     * @param {string} tabName - Source tab whose deleted rows to return
     * @returns {Promise<Array<{RowIdentifier: string, Username: string, Timestamp: number, Operation: string, RowData: Object}>>}
     */
    static async getArchivedRows(deps, tableId, tabName) {
        // Reading a missing tab throws on real Sheets, so check that the archive exists first
        const tabs = await deps.call(Database.getTabs, tableId);
        if (!tabs.some(tab => tab.title === ARCHIVE_TAB_NAME)) return [];

        const mapping = Object.fromEntries(ARCHIVE_HEADERS.map(header => [header, header]));
        const rows = await deps.call(Database.getData, tableId, ARCHIVE_TAB_NAME, mapping);
        return rows
            .filter(row => row.SourceTable === tableId && row.SourceTab === tabName)
            .map(row => {
                let rowData = {};
                try { rowData = JSON.parse(row.RowData || '{}'); } catch { /* unreadable archive row */ }
                return { ...row, Timestamp: Number(row.Timestamp) || 0, RowData: rowData };
            })
            .sort((a, b) => b.Timestamp - a.Timestamp);
    }

    /**
     * Get all page notes from the CACHE Notes tab.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @returns {Promise<Array<{Path: string, Note: string, Color: string, Size: string, edithistory: string}>>}
     */
    static async getPageNotes(deps) {
        return await deps.call(Database.getData, 'CACHE', 'Notes', NOTES_MAPPING);
    }

    // MUTATION METHOD — excluded from caching. History is tracked by Database.setData.
    static async savePageNotes(data) {
        const username = authState.user?.email || null;
        return await Database.setData('CACHE', 'Notes', data, NOTES_MAPPING, { username, source: 'web' });
    }

    static async getPreferences(deps) {
        return await deps.call(Database.getData, 'CACHE', 'Preferences', PREFERENCES_MAPPING);
    }

    /**
     * Maximum length of an inventory save note (InventoryNoteMaxLength preference, default 25).
     * @param {Object} deps - Dependency decorator for tracking calls
     * @returns {Promise<number>}
     */
    static async getInventoryNoteMaxLength(deps) {
        try {
            return resolveInventoryNoteMaxLength(await deps.call(Requests.getPreferences));
        } catch (error) {
            console.warn('[getInventoryNoteMaxLength] Preferences unavailable, using the default:', error);
            return resolveInventoryNoteMaxLength(null);
        }
    }

    // MUTATION METHOD — excluded from caching. History is tracked by Database.setData.
    static async savePreferences(data) {
        const username = authState.user?.email || null;
        return await Database.setData('CACHE', 'Preferences', data, PREFERENCES_MAPPING, { username, source: 'web' });
    }

    /**
     * Parsed value of a json-type preference (e.g. DesignQueueFields), or the fallback.
     * @param {Object} deps
     * @param {string} id
     * @param {*} [fallback]
     */
    static async getJsonPreference(deps, id, fallback = null) {
        const prefs = await deps.call(Database.getData, 'CACHE', 'Preferences', PREFERENCES_MAPPING);
        const pref = (prefs || []).find(p => p.id === id);
        if (!pref || pref.value === undefined || pref.value === null || pref.value === '') return fallback;
        try { return JSON.parse(pref.value); } catch { return fallback; }
    }

    /**
     * The InstantWriteTables entry for a database/tab, normalized ({ identity, columns: [names] }),
     * or null (see utils/instant-write-config.js).
     */
    static async getInstantWriteConfig(deps, database, tab) {
        const all = await deps.call(Requests.getJsonPreference, 'InstantWriteTables', {});
        return instantWriteEntry(all, database, tab);
    }

    /**
     * The declared column types of a tab, from the ColumnTypes preference (see
     * utils/column-types.js): [{ column, type, options? }]. Undeclared columns are not listed;
     * columnTypeOf gives them the name guess. The one cached read of column types for every page.
     */
    static async getColumnTypes(deps, database, tab) {
        const all = await deps.call(Requests.getJsonPreference, 'ColumnTypes', {});
        return columnTypesEntry(all, database, tab);
    }

    /**
     * What the design queue needs besides its rows, in one cached call (it follows the Preferences
     * and the tab's data). A one-item list, so it can back a reactive store:
     * [{ instant: { identity, columns } | null   InstantWriteTables entry for the tab
     *    fields: string[] | null                 DesignQueueFields (shown columns)
     *    assignees: string[]                     DesignQueueAssignees names (["Alex", "red"]: name + colour word)
     *    assigneeColors: { [name]: colour }      the colour words, for the names that have one
     *    types: [{ column, type, options? }] }]  getColumnTypes (declared column types)
     */
    static async getDesignQueueSetup(deps, database, tab) {
        const [instant, fields, assignees, types] = await Promise.all([
            deps.call(Requests.getInstantWriteConfig, database, tab),
            deps.call(Requests.getJsonPreference, 'DesignQueueFields', null),
            deps.call(Requests.getJsonPreference, 'DesignQueueAssignees', []),
            deps.call(Requests.getColumnTypes, database, tab)
        ]);
        const parsedAssignees = (Array.isArray(assignees) ? assignees : []).map(parseColoredName);
        return [{
            instant,
            fields: Array.isArray(fields) && fields.length ? fields.map(String) : null,
            assignees: parsedAssignees.map(a => a.name),
            assigneeColors: Object.fromEntries(parsedAssignees.filter(a => a.color).map(a => [a.name, a.color])),
            types
        }];
    }

    /**
     * MUTATION METHOD — excluded from caching.
     * Verified writes of several cells of one tab in one batch, each located by row identity and
     * column header (see instant-write-utils.js).
     * @param {Array<{ row: Object, column: string, value: string }>} items
     * @returns {Promise<Array<{ ok: boolean, reason?: string, warning?: string }>>} one result per item
     */
    static async writeCellsVerified(database, tab, items) {
        return await InstantWriteUtils.writeCellsVerified(database, tab, items);
    }

    /** Show notes from CACHE/ShowNotes as [{ Identifier, Note, edithistory }] ([] if the tab is missing). */
    static async getShowNotes(deps) {
        try {
            const data = await deps.call(Database.getData, 'CACHE', 'ShowNotes', { Identifier: 'Identifier', Note: 'Note', edithistory: 'EditHistory' });
            return Array.isArray(data) ? data.filter(r => r && r.Identifier) : [];
        } catch (e) {
            console.warn('[Requests.getShowNotes] ShowNotes tab unavailable:', e?.message || e);
            return [];
        }
    }

    /**
     * A schedule row's show note, for per-row analysis: { identifier, note }. identifier is
     * computeIdentifier(Show, Client, Year), '' when it can't be computed; note is '' when the show
     * has none. Cached, so it follows CACHE/ShowNotes and the identifier reference data.
     * @param {{ Show, Client, Year }} row
     */
    static async getShowNoteForRow(deps, row) {
        let identifier = '';
        try {
            identifier = (await deps.call(Requests.computeIdentifier, row?.Show, row?.Client, row?.Year)) || '';
        } catch {
            identifier = '';
        }
        if (!identifier) return { identifier: '', note: '' };
        const notes = await deps.call(Requests.getShowNotes);
        const key = identityText(identifier);
        const hit = notes.find(n => identityText(n.Identifier) === key);
        return { identifier, note: hit?.Note ?? '' };
    }

    /**
     * MUTATION METHOD — excluded from caching.
     * Upsert one show note keyed by computeIdentifier, verified by re-reading.
     */
    static async saveShowNote(identifier, text) {
        const username = authState.user?.email || null;
        return await InstantWriteUtils.saveShowNote(identifier, text, username);
    }

    // ── Inventory proposals ───────────────────────────────────────────────────
    // CACHE/InventoryProposals, one row per proposed item change; no EditHistory column, so
    // writes are never tracked. Plan: docs/notes/inventory-proposals-plan.md

    /**
     * Every proposal entry (active and committed), parsed.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @returns {Promise<Array>} See ProposalUtils.parseRows
     */
    static async getInventoryProposals(deps) {
        // Reading a missing tab throws on real Sheets; the tab is created by the first proposal
        const tabs = await deps.call(Database.getTabs, 'CACHE');
        if (!tabs.some(tab => tab.title === PROPOSALS_TAB_NAME)) return [];
        const rows = await deps.call(Database.getData, 'CACHE', PROPOSALS_TAB_NAME, PROPOSAL_MAPPING);
        return ProposalUtils.parseRows(rows);
    }

    /**
     * Rows for the proposal page: the proposal's active entries (all entries once committed),
     * joined with each item's current inventory values. See ProposalUtils.toTableRow.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} name - Proposal name (case-insensitive)
     */
    static async getInventoryProposalTable(deps, name) {
        const entries = ProposalUtils.entriesOf(await deps.call(Requests.getInventoryProposals), name);
        const shown = ProposalUtils.isCommitted(entries) ? entries : ProposalUtils.activeEntries(entries);
        const inventoryByCategory = {};
        for (const category of new Set(shown.map(entry => entry.category))) {
            try {
                inventoryByCategory[category] = await deps.call(Database.getData, 'INVENTORY', category, DEFAULT_INVENTORY_MAPPING);
            } catch (error) {
                console.warn(`[getInventoryProposalTable] Could not read inventory tab ${category}:`, error);
                inventoryByCategory[category] = [];
            }
        }
        return shown.map(entry => ProposalUtils.toTableRow(
            entry,
            inventoryByCategory[entry.category].find(row => row.itemNumber === entry.itemNumber)
        ));
    }

    /**
     * Merge item changes from a category page into a proposal (created if new).
     * MUTATION METHOD — excluded from caching.
     * @param {string} name - Proposal name
     * @param {string} category - Inventory tab
     * @param {Array<{itemNumber: string, changes: Array<{n, ne}>}>} updates
     */
    static async updateInventoryProposal(name, category, updates) {
        return await _updateProposalEntries((entries, user, now) =>
            ProposalUtils.mergeIntoProposal(entries, name, category, updates, user, now));
    }

    /**
     * Save edits from the proposal page (see ProposalUtils.replaceActiveEntries). Signature matches
     * the reactive store save call: (data, ...apiArgs, options).
     * MUTATION METHOD — excluded from caching.
     * @param {Array<Object>} rows - Proposal page rows (see ProposalUtils.toTableRow)
     * @param {string} name - Proposal name
     */
    static async saveInventoryProposalTable(rows, name) {
        return await _updateProposalEntries((entries, user, now) =>
            ProposalUtils.replaceActiveEntries(entries, name, rows, user, now));
    }

    /**
     * Mark a proposal's active rows in the given categories as committed.
     * MUTATION METHOD — excluded from caching.
     * @param {string} name - Proposal name
     * @param {Array<string>} categories - Inventory tabs that were committed
     */
    static async markInventoryProposalCommitted(name, categories) {
        return await _updateProposalEntries((entries, user, now) =>
            ProposalUtils.markCommitted(entries, name, categories, user, now));
    }

}

// ── Proposal storage (used by the mutation methods above) ─────────────────────

/**
 * Read every proposal entry, transform the list, and write it back (creating the tab on first use).
 * No edithistory in the mapping: Database.setData writes without history tracking.
 * @param {function(Array, string, number): Array} transform - (entries, short user, now in deciseconds) → entries
 */
async function _updateProposalEntries(transform) {
    const tabs = await Database.getTabs('CACHE');
    const tabExists = tabs.some(tab => tab.title === PROPOSALS_TAB_NAME);
    const entries = tabExists
        ? ProposalUtils.parseRows(await Database.getData('CACHE', PROPOSALS_TAB_NAME, PROPOSAL_MAPPING))
        : [];
    const user = (authState.user?.email || 'unknown').split('@')[0];
    const updated = transform(entries, user, Math.floor(Date.now() / 100));
    if (!tabExists) await Database.createTab('CACHE', null, PROPOSALS_TAB_NAME);
    return await Database.setData('CACHE', PROPOSALS_TAB_NAME, ProposalUtils.toRows(updated), PROPOSAL_MAPPING);
}

/**
 * Wrap the API class with automatic caching and dependency tracking.
 * 
 * MUTATION METHODS ARE EXCLUDED from wrapping to prevent circular dependencies:
 * - saveData: Triggers cache invalidation via Database.setData()
 * - createNewTab: Modifies sheet structure via Database.createTab()
 * - showTabs: Modifies sheet visibility via Database.showTabs()
 * - hideTabs: Modifies sheet visibility via Database.hideTabs()
 * - saveInventoryTabData: Triggers cache invalidation via InventoryUtils.saveInventoryTabData()
 * - savePackList: Triggers cache invalidation via PackListUtils.savePackList()
 * - storeUserData: Triggers cache invalidation via ApplicationUtils.storeUserData()
 * - lockSheet: Triggers cache invalidation via ApplicationUtils.lockSheet()
 * - unlockSheet: Triggers cache invalidation via ApplicationUtils.unlockSheet()
 * - forceUnlockSheet: Triggers cache invalidation via ApplicationUtils.forceUnlockSheet()
 * 
 * These mutation methods are passed through without modification, preserving their original
 * signatures (no deps parameter) and allowing them to trigger invalidation independently.
 */
export const Requests = wrapMethods(
    Requests_uncached, 
    'api', 
    [
        'saveData', 'createNewTab', 'showTabs', 'hideTabs',
        'saveInventoryTabData', 'savePackList', 'storeUserData', 'uploadItemImage',
        'lockSheet', 'unlockSheet', 'forceUnlockSheet',
        'checkAndApplyPendingChanges', 'savePendingChangeEntry', 'deletePendingChangeEntry',
        'ensureScheduleReferenceRows',
        'addScheduleReferenceName', 'appendScheduleReferenceAbbreviation',
        'addCustomScheduleReferenceEntry',
        'addNameOverride',
        'setTransshipLink',
        'removeTransshipLink',
        'savePageNotes',
        'savePreferences',
        'updateInventoryProposal', 'saveInventoryProposalTable', 'markInventoryProposalCommitted',
        'getDriveFileBlob', // Uncached read: callers own the Blob
        'writeCellsVerified',
        'saveShowNote'
    ], // Mutation methods (and fresh reads that must not be cached)
    ['computeIdentifier'], // Infinite cache methods
    {}, // No custom cache durations needed - lock methods delegate to ApplicationUtils caching
    ['getInventoryShortageAlerts', 'getItemThumbnails'] // Persisted methods (CACHE/Analytics)
);