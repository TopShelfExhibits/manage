import { wrapMethods, Database, InventoryUtils, PackListUtils, ProductionUtils, ApplicationUtils } from './index.js';
import { authState } from '../application/utils/auth.js';

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
     * Fetch data from a table/tab as JS objects
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Table identifier (INVENTORY, PACK_LISTS, etc.)
     * @param {string} tabName - Tab name
     * @param {Object} [mapping] - Optional mapping for object keys to sheet headers
     * @returns {Promise<Array<Object>>} - Array of JS objects
     */
    static async fetchData(deps, tableId, tabName, mapping = null) {
        return await deps.call(Database.getData, tableId, tabName, mapping);
    }
    
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
        const templateTab = await Database.findTabByName(tableId, templateName);
        if (!templateTab) throw new Error(`Template tab "${templateName}" not found`);
        await Database.createTab(tableId, templateTab, newTabName);
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
    
    /**
     * Find a tab by name
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Table identifier
     * @param {string} tabName - Name of the tab to find
     * @returns {Promise<{title: string, sheetId: number}|null>}
     */
    static async findTab(deps, tableId, tabName) {
        return await deps.call(Database.findTabByName, tableId, tabName);
    }
    
    /**
     * Get headers/schema from a sheet without loading all data
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Table identifier
     * @param {string} tabName - Tab name
     * @returns {Promise<Array<string>>} - Array of column headers
     */
    static async getHeaders(deps, tableId, tabName) {
        const rawData = await deps.call(Database.getData, tableId, tabName);
        if (Array.isArray(rawData) && rawData.length > 0 && Array.isArray(rawData[0])) {
            return rawData[0]; // First row contains headers
        }
        return [];
    }
    
    /**
     * Get item headers/schema from a packlist by examining actual data
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tabName - Packlist tab name
     * @returns {Promise<Array<string>>} - Array of item column headers
     */
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
     * Executes a SQL-like query against sheet data
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - The table identifier
     * @param {string} query - SQL-like query string
     * @returns {Promise<Array<Object>>} Query results
     */
    static async queryData(deps, tableId, query) {
        return await deps.call(Database.queryData, tableId, query);
    }
    
    /**
     * Extracts item quantities from a project's pack list
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - The project identifier
     * @returns {Promise<object>} Map of itemId to quantity
     */
    static async getItemQuantities(deps, projectIdentifier) {
        return await deps.call(PackListUtils.extractItems, projectIdentifier);
    }
    
    /**
     * Check quantities and availability for items in a project
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - The project identifier
     * @returns {Promise<object>} Inventory status for all items in the project
     */
    static async checkAvailability(deps, projectIdentifier) {
        return await deps.call(InventoryUtils.checkItemAvailability, projectIdentifier);
    }
    
    /**
     * Check item quantities for a project (with overlapping shows analysis)
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - The project identifier
     * @returns {Promise<object>} Detailed inventory status for all items
     */
    static async checkItemQuantities(deps, projectIdentifier) {
        return await deps.call(PackListUtils.checkItemQuantities, projectIdentifier);
    }
    
    /**
     * Get information about specific inventory items
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string|string[]} itemName - Item ID(s) to look up
     * @param {string|string[]} fields - Field(s) to retrieve
     * @returns {Promise<Array<Object>>} Item information
     */
    static async getInventoryInfo(deps, itemName, fields) {
        return await deps.call(InventoryUtils.getItemInfo, itemName, fields);
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
        return await deps.call(PackListUtils.getPacklists, filter);
    }
    
    /**
     * Find projects that overlap with the given project or date range
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string|Object} parameters - Project identifier or date range parameters
     * @returns {Promise<string[]>} Array of overlapping project identifiers
     */
    static async getOverlappingProjects(deps, parameters) {
        return await deps.call(ProductionUtils.getOverlappingShows, parameters);
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
     * Get mapped inventory tab data (with default mapping and optional filters).
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tabOrItemName - Tab name or item name to resolve tab
     * @param {Object} [mapping] - Optional mapping object
     * @param {Object} [filters] - Optional filter parameters
     * @returns {Promise<Array<Object>>}
     */
    static async getInventoryTabData(deps, tabOrItemName, mapping, filters) {
        return await deps.call(InventoryUtils.getInventoryTabData, tabOrItemName, mapping, filters);
    }
    
    /**
     * Get all inventory data from all tabs (excluding INDEX)
     * Each item is tagged with its category tab
     * @param {Object} deps - Dependency decorator for tracking calls
     * @returns {Promise<Array<Object>>} - All inventory items with tab property
     */
    static async getAllInventoryData(deps) {
        // Get all available tabs for INVENTORY
        const tabs = await deps.call(Requests.getAvailableTabs, 'INVENTORY');
        const inventoryTabs = tabs.filter(tab => tab.title !== 'INDEX');
        
        const allData = [];
        
        // Load data from each tab
        for (const tab of inventoryTabs) {
            try {
                const tabData = await deps.call(InventoryUtils.getInventoryTabData, tab.title);
                
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
    static async saveInventoryTabData(mappedData, tabOrItemName, mapping, filters) {
        const username = authState.user?.email || null;
        return await InventoryUtils.saveInventoryTabData(mappedData, tabOrItemName, mapping, filters, username);
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
        return await PackListUtils.savePackList(projectIdentifier, crates, null, username);
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
     * Get show details by project identifier
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} identifier - Project identifier (e.g., "LOCKHEED MARTIN 2025 NGAUS")
     * @returns {Promise<Object|null>} Show details object or null if not found
     */
    static async getShowDetails(deps, identifier) {
        return await deps.call(ProductionUtils.getShowDetails, identifier);
    }

    /**
     * Check if a packlist exists for a schedule row
     * Used by reactive store analysis to enrich schedule data with packlist information
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object} scheduleRow - Full schedule row object with Show, Client, Year properties
     * @returns {Promise<Object>} Object with { exists: boolean, identifier: string|null }
     */
    static async checkPacklistExists(deps, scheduleRow) {
        // Compute the identifier from the row data
        const identifier = await deps.call(ProductionUtils.computeIdentifier, scheduleRow.Show, scheduleRow.Client, parseInt(scheduleRow.Year));
        
        // Get available tabs and check if packlist exists
        const availableTabs = await deps.call(Database.getTabs, 'PACK_LISTS');
        const tab = availableTabs.find(tab => tab.title === identifier);
        
        return {
            exists: !!tab,
            identifier: identifier
        };
    }

    /**
     * Guess ship date if missing based on other date fields
     * Used by reactive store analysis to fill in missing ship dates
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object} scheduleRow - Full schedule row object
     * @returns {Promise<string|undefined>} Guessed ship date or undefined (to preserve existing)
     */
    static async guessShipDate(deps, scheduleRow) {
        // Only guess if Ship field is empty or null
        if (!scheduleRow.Ship || scheduleRow.Ship.toString().trim() === '') {
            return await deps.call(ProductionUtils.guessShipDate, scheduleRow);
        }
        // Return undefined to preserve existing ship date
        return undefined;
    }

    /**
     * Get item image URL from Google Drive
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} itemNumber - The item number to search for
     * @returns {Promise<string|null>} Direct image URL or null if not found
     */
    static async getItemImageUrl(deps, itemNumber) {
        return await deps.call(Database.getItemImageUrl, itemNumber);
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
     * Extract hardware item information from text by checking against HARDWARE inventory
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} text - Text to extract hardware item information from
     * @returns {Promise<Object>} Object with {quantity: number, itemNumber: string|null, description: string}
     */
    static async extractHardwareFromText(deps, text) {
        return await deps.call(PackListUtils.extractHardwareFromText, text);
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
    static async checkDescriptionMatch(deps, item) {
        // Extract item number and description from the item object
        const itemNumber = item['Extracted Item'];
        const description = item.Description || item['Packing/shop notes'] || '';
        
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
                inventoryDescription: result.inventoryDescription
            };
        }
        
        // Good match, no alert needed
        return null;
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
     * Get item quantities summary for multiple projects
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Array<string>} projectIdentifiers - Array of project identifiers
     * @returns {Promise<Array<Object>>} Array of item objects with quantities per show
     */
    static async getMultipleShowsItemsSummary(deps, projectIdentifiers, itemCategoryFilter = undefined) {
        return await deps.call(PackListUtils.extractItemsFromMultipleShows, projectIdentifiers, itemCategoryFilter);
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
    static async getItemInventoryQuantity(deps, itemId) {
        return await deps.call(PackListUtils.getItemInventoryQuantity, itemId);
    }

    /**
     * Get overlapping projects that use a specific item
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} currentProjectId - Current project identifier
     * @param {string} itemId - Item ID to check for conflicts
     * @returns {Promise<Array<string>>} Array of overlapping project identifiers that use this item
     */
    static async getItemOverlappingShows(deps, currentProjectId, itemId) {
        return await deps.call(PackListUtils.getItemOverlappingShows, currentProjectId, itemId);
    }

    /**
     * Calculate remaining quantity for an item based on inventory, current usage, and overlapping shows
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} currentProjectId - Current project identifier
     * @param {string} itemId - Item ID to calculate remaining quantity for
     * @returns {Promise<number|null>} Remaining available quantity, or null if item not found in inventory
     */
    static async calculateRemainingQuantity(deps, currentProjectId, itemId) {
        return await deps.call(PackListUtils.calculateRemainingQuantity, currentProjectId, itemId);
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
        const itemNumber = item['Extracted Item'];
        
        if (!itemNumber || !currentProjectId) {
            return null;
        }
        
        try {
            // Get remaining quantity from business logic layer
            const remaining = await deps.call(PackListUtils.calculateRemainingQuantity, currentProjectId, itemNumber);
            
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
            if (remaining < 0) {
                return {
                    type: 'item shortage',
                    color: 'red',
                    clickable: true,
                    message: `Shortage: ${Math.abs(remaining)} units short`,
                    remaining
                };
            } else if (remaining === 0) {
                return {
                    type: 'item warning',
                    color: 'yellow',
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
    static async getItemDescription(deps, itemId) {
        return await deps.call(InventoryUtils.getItemDescription, itemId);
    }

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
 * 
 * These methods are passed through without modification, preserving their original
 * signatures (no deps parameter) and allowing them to trigger invalidation independently.
 */
export const Requests = wrapMethods(Requests_uncached, 'api', ['saveData', 'createNewTab', 'showTabs', 'hideTabs', 'saveInventoryTabData', 'savePackList', 'storeUserData']);