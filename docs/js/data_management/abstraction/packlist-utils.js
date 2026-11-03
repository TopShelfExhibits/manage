import { Database, InventoryUtils, ProductionUtils, wrapMethods, GetParagraphMatchRating, todayISOString, parseDate, toISODateString, EditHistoryUtils, ApplicationUtils, invalidateCache, normalizeHeaderName, ProgressBus } from '../index.js';

/** Normalize an identifier for loose matching (strips spaces, case, non-alphanumeric) */
function _normalizeId(v) { return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/** Packlist metadata columns: row object key → sheet header. Always the last columns of a packlist tab. */
const PACKLIST_METADATA_COLUMNS = { metadata: 'MetaData', edithistory: 'EditHistory' };
const _isMetadataHeader = (header) => Object.values(PACKLIST_METADATA_COLUMNS).includes(String(header ?? '').trim());

/**
 * Utility functions for pack list operations
 */
class packListUtils_uncached {
    /**
     * Extract item information from text using regex pattern
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} text - Text to search for item information
     * @returns {Promise<Object>} Object with {quantity: number, itemNumber: string|null, description: string}
     */
    static async extractItemFromText(deps, text, ctgFilter = undefined) {
        if (!text || typeof text !== 'string') {
            return {
                quantity: 1,
                itemNumber: null,
                description: text || ''
            };
        }
        
        const itemRegex = /(?:\(([0-9]+)\))?\s*([A-Z]+-[0-9A-Za-z_○°]+)/;

        const match = text.match(itemRegex);
        
        if (match) {
            // If a match is found, check if that item number prefix exists in the inventory index
            const itemNumber = match[2];
            const tabName = await deps.call(InventoryUtils.getTabNameForItem, itemNumber);
            
            // Only return the item if its prefix exists in the inventory index
            // and matches the optional array ctgFilter (case insensitive)
            if (tabName && (!ctgFilter || ctgFilter.some(cat => cat.toUpperCase() === tabName.toUpperCase()))) {
                if (tabName === 'HARDWARE') {
                    return await deps.call(PackListUtils.extractHardwareFromText, text);
                } else {
                    // Extract clean description by removing the matched item code and quantity
                    const description = text
                        .replace(match[0], '') // Remove the entire match (quantity + item number)
                        .replace(/\s+/g, ' ')  // Normalize whitespace
                        .trim();               // Remove leading/trailing spaces
                    
                    return {
                        quantity: match[1] ? parseInt(match[1], 10) : 1,
                        itemNumber: itemNumber,
                        description: description
                    };
                }
            }
        }
        
        if (!ctgFilter || ctgFilter.includes('HARDWARE')) {
            // No item found via prefix match — fall back to scanning tabs with customItemNumbers.
            // This handles hardware-style item numbers that don't follow the LETTERS-NUMBERS pattern
            // (e.g. "901 00 030 MKII", "VUE-V2C-LP", "HH BOLTHOG 1-4 20 x 2.5").
            const hardwareResult = await deps.call(PackListUtils.extractHardwareFromText, text);
            if (hardwareResult.itemNumber) {
                return hardwareResult;
            }
        }

        // No item found in text within the specified categories
        return {
            quantity: 1,
            itemNumber: null,
            description: text
        };
    }

    /**
     * Extract hardware item information from text by checking against HARDWARE inventory
     * Searches for pattern: (qty) itemNumber where itemNumber exists in HARDWARE tab
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} text - Text to search for hardware item information
     * @returns {Promise<Object>} Object with {quantity: number, itemNumber: string|null, description: string}
     */
    static async extractHardwareFromText(deps, text) {
        if (!text || typeof text !== 'string') {
            return {
                quantity: 1,
                itemNumber: null,
                description: text || ''
            };
        }

        try {
            // Get all hardware items from the HARDWARE inventory tab
            const hardwareData = await deps.call(InventoryUtils.getInventoryTabData, 'HARDWARE', undefined, undefined, todayISOString());
            
            if (!hardwareData || hardwareData.length === 0) {
                return {
                    quantity: 1,
                    itemNumber: null,
                    description: text
                };
            }

            // Extract all hardware item numbers
            const hardwareItemNumbers = hardwareData
                .map(item => item.itemNumber)
                .filter(num => num && num.trim() !== '');

            // Check text for each hardware item number with pattern: (qty) itemNumber
            for (const itemNum of hardwareItemNumbers) {
                // Escape special regex characters in item number
                const escapedItemNum = itemNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                
                // Create regex pattern: optional (qty) followed by the item number
                const pattern = new RegExp(`(?:\\(([0-9]+)\\))?\\s*${escapedItemNum}`, 'i');
                const match = text.match(pattern);
                
                if (match) {
                    // Extract clean description by removing the matched hardware code and quantity
                    const description = text
                        .replace(match[0], '') // Remove the entire match (quantity + item number)
                        .replace(/\s+/g, ' ')  // Normalize whitespace
                        .trim();               // Remove leading/trailing spaces
                    
                    return {
                        quantity: match[1] ? parseInt(match[1], 10) : 1,
                        itemNumber: itemNum,
                        description: description
                    };
                }
            }

            // No hardware item found in text
            return {
                quantity: 1,
                itemNumber: null,
                description: text
            };

        } catch (error) {
            console.error('Error extracting hardware from text:', error);
            return {
                quantity: 1,
                itemNumber: null,
                description: text
            };
        }
    }
    /**
     * Get pack list content
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - The project identifier
     * @param {string} [itemColumnsStart="Pack"] - Column header where item data begins
     * @returns {Promise<Object>} Pack list content
     */
    static async getContent(deps, projectIdentifier, itemColumnsStart = "Pack") {
        // First verify the tab exists
        const tabs = await Database.getTabs('PACK_LISTS'); // Uncached so we don't invalidate on every tabs invalidation

        const matchedTab = await deps.call(ProductionUtils.findPackListTab, projectIdentifier, tabs);
        //console.log('[getContent]', projectIdentifier, '| tabs:', tabs?.map(t => t.title), '| found:', !!matchedTab);
        if (!matchedTab) {
            await deps.call(Database.getTabs, 'PACK_LISTS'); // Creates tabs cache dependency for nonexistant packlists
            return null;
        }
        const resolvedIdentifier = matchedTab.title;
        // Fetch the raw sheet data (2D array)
        const sheetData = await deps.call(Database.getData, 'PACK_LISTS', resolvedIdentifier, null);
        if (!sheetData || sheetData.length < 2) return [];
        // Extract headers from row 1 (index 0) and normalize them
        const headerRow = Array.isArray(sheetData[0]) 
            ? sheetData[0].map(h => normalizeHeaderName(h))
            : [];
        const normalizedItemStartHeader = normalizeHeaderName(itemColumnsStart);
        const itemStartIndex = headerRow.findIndex(header => header === normalizedItemStartHeader);
        if (itemStartIndex === -1) {
            throw new Error(`Header "${itemColumnsStart}" not found in the header row.`);
        }
        const mainHeaders = headerRow.slice(0, itemStartIndex);
        const itemHeaders = headerRow.slice(itemStartIndex);
        
        // Find metadata columns - they should be at the end of the header row
        // Support both old format (MetaData/EditHistory in item section) and new format (at the end)
        const metadataIndex = headerRow.findIndex(header => header === PACKLIST_METADATA_COLUMNS.metadata);
        const editHistoryIndex = headerRow.findIndex(header => header === PACKLIST_METADATA_COLUMNS.edithistory);
        
        // Filter out MetaData and EditHistory headers (attached to objects as metadata / edithistory)
        const filteredMainHeaders = mainHeaders.filter(h => {
            return !_isMetadataHeader(h);
        });
        const filteredItemHeaders = itemHeaders.filter(h => {
            return !_isMetadataHeader(h);
        });
        
        const crates = [];
        let currentCrate = null;
        // Process rows starting from row 2 (index 1)
        for (let i = 1; i < sheetData.length; i++) {
            const rowValues = sheetData[i] || [];
            const crateInfoArr = rowValues.slice(0, itemStartIndex);
            const crateContentsArr = rowValues.slice(itemStartIndex);
            
            // Calculate the actual end index for item columns (excluding metadata columns)
            // MetaData and EditHistory are at the end, so we need to exclude them from content checks
            let itemEndIndex = crateContentsArr.length;
            if (metadataIndex !== -1) {
                // Adjust to exclude metadata columns from the item content check
                itemEndIndex = Math.min(itemEndIndex, metadataIndex - itemStartIndex);
            }
            
            // Check if this is a crate row (has data in main columns, excluding metadata)
            const hasCrateInfo = crateInfoArr.some((cell, idx) => {
                return cell && cell.toString().trim() !== '';
            });
            
            if (hasCrateInfo) {
                if (currentCrate) {
                    crates.push(currentCrate);
                }
                // Map crate info to object with header keys
                const crateInfoObj = {};
                filteredMainHeaders.forEach((label, idx) => {
                    const originalIdx = mainHeaders.indexOf(label);
                    crateInfoObj[label] = originalIdx < crateInfoArr.length && crateInfoArr[originalIdx] !== undefined ? crateInfoArr[originalIdx] : '';
                });
                
                // Extract metadata from unified end columns
                if (metadataIndex !== -1 && metadataIndex < rowValues.length) {
                    crateInfoObj.metadata = rowValues[metadataIndex] || '';
                }
                if (editHistoryIndex !== -1 && editHistoryIndex < rowValues.length) {
                    crateInfoObj.edithistory = rowValues[editHistoryIndex] || '';
                }
                
                currentCrate = {
                    ...crateInfoObj,
                    Items: []
                };
            }
            // Check if this is an item row.
            // Keep rows with item cell content OR with metadata/history content so metadata-only
            // rows (such as blank group masters) are preserved through load/save cycles.
            const hasItemCellContent = crateContentsArr.slice(0, itemEndIndex).some((cell, idx) => {
                return cell && cell.toString().trim() !== '';
            });
            const hasItemMetadata = (metadataIndex !== -1 && metadataIndex < rowValues.length && rowValues[metadataIndex] && rowValues[metadataIndex].toString().trim() !== '')
                || (editHistoryIndex !== -1 && editHistoryIndex < rowValues.length && rowValues[editHistoryIndex] && rowValues[editHistoryIndex].toString().trim() !== '');
            // Special case: if this row is a crate row, metadata belongs to the crate row and
            // the inline item segment is considered empty/splittable noise.
            const hasItemContent = !hasCrateInfo && (hasItemCellContent || hasItemMetadata);
            
            if (hasItemContent && currentCrate) {
                const itemObj = {};
                filteredItemHeaders.forEach((label, idx) => {
                    const originalIdx = itemHeaders.indexOf(label);
                    itemObj[label] = originalIdx < crateContentsArr.length && crateContentsArr[originalIdx] !== undefined ? crateContentsArr[originalIdx] : '';
                });
                
                // Extract metadata from unified end columns
                if (metadataIndex !== -1 && metadataIndex < rowValues.length) {
                    itemObj.metadata = rowValues[metadataIndex] || '';
                }
                if (editHistoryIndex !== -1 && editHistoryIndex < rowValues.length) {
                    itemObj.edithistory = rowValues[editHistoryIndex] || '';
                }
                
                currentCrate.Items.push(itemObj);
            }
        }
        if (currentCrate) {
            crates.push(currentCrate);
        }
        return crates;
    // ...existing code...
    }

    /**
     * Extracts item quantities from a project's pack list
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - The project identifier
     * @returns {Promise<object>} Map of itemId to quantity
     */
    static async extractItems(deps, projectIdentifier, ctgFilter = undefined) {
        // Get pack list content (array of crate objects with Items arrays)
        const crates = await deps.call(PackListUtils.getContent, projectIdentifier, "Pack");

        // Return empty object if pack list not found
        if (!crates) return {};

        const itemMap = {};

        for (const crate of crates) {
            if (Array.isArray(crate.Items)) {
                for (const itemObj of crate.Items) {
                    // For each property in the item object, check for item codes
                    // Skip metadata fields — edithistory contains old description values that
                    // would be picked up by the item-code regex and inflate quantities.
                    for (const [key, cell] of Object.entries(itemObj)) {
                        if (key === 'edithistory' || key === 'metadata') continue;
                        if (!cell) continue;
                        const extracted = await deps.call(PackListUtils.extractItemFromText, cell, ctgFilter);
                        if (extracted.itemNumber) {
                            itemMap[extracted.itemNumber] = (itemMap[extracted.itemNumber] || 0) + extracted.quantity;
                        }
                    }
                }
            }
        }

        return itemMap;
    }

    /**
     * Extract and aggregate items from all packlists for a show, including suffix variants
     * (e.g., "LOCKHEED 2026 SNA MEETING ROOM" alongside "LOCKHEED 2026 SNA").
     * This is the preferred method for all analysis functions that need the full item set for a show.
     * @param {Object} deps
     * @param {string} projectIdentifier - Project identifier
     * @param {string|undefined} ctgFilter - Optional item category filter
     * @returns {Promise<Object>} Aggregated item map { itemId: totalQuantity }
     */
    static async extractAllItemsForShow(deps, projectIdentifier, ctgFilter = undefined) {
        const allTabs = await deps.call(Database.getTabs, 'PACK_LISTS');
        const validTabs = allTabs.filter(tab => tab.title !== '_TEMPLATE' && !tab.title.startsWith('_'));
        const matchingTabs = await deps.call(ProductionUtils.findAllPackListTabsForShow, projectIdentifier, validTabs);

        if (!matchingTabs.length) return {};

        const itemMap = {};
        for (const tab of matchingTabs) {
            const tabItems = await deps.call(PackListUtils.extractItems, tab.title, ctgFilter);
            for (const [itemId, qty] of Object.entries(tabItems)) {
                itemMap[itemId] = (itemMap[itemId] || 0) + qty;
            }
        }
        return itemMap;
    }

    // Walks the transship chain from identifier as root, returning max(qty) per item
    // across all chain members. Accepts either a canonical schedule id or a packlist tab title.
    static async extractChainItemsForIdentifier(deps, identifier, ctgFilter = undefined) {
        const combined = {};
        const visited = new Set();
        let current = identifier;
        while (current && !visited.has(current.toLowerCase())) {
            visited.add(current.toLowerCase());
            try {
                // Resolve schedule row first — handles both canonical ids and NameOverride tab titles
                const row = await deps.call(ProductionUtils.getShowDetails, current);
                const tabs = await deps.call(Database.getTabs, 'PACK_LISTS');
                const matchingTabs = row
                    ? await deps.call(ProductionUtils.findPacklistTabsForScheduleRow, row, tabs)
                    : [];
                // Sum across all tabs for this node (multi-booth: both tabs are active simultaneously)
                const nodeItems = {};
                const tabIds = matchingTabs.length ? matchingTabs.map(t => t.title) : [current];
                for (const tabId of tabIds) {
                    const tabItems = await deps.call(PackListUtils.extractAllItemsForShow, tabId, ctgFilter);
                    for (const [itemId, qty] of Object.entries(tabItems)) {
                        nodeItems[itemId] = (nodeItems[itemId] || 0) + qty;
                    }
                }
                // Max across chain nodes (transship: items travel show-to-show, peak demand governs)
                for (const [itemId, qty] of Object.entries(nodeItems)) {
                    combined[itemId] = Math.max(combined[itemId] || 0, qty);
                }
                // ScheduleOverrides stores canonical ids — always walk chain using canonical id
                const canonicalId = row
                    ? await deps.call(ProductionUtils.getCanonicalIdentifierForScheduleRow, row)
                    : null;
                current = canonicalId ? await deps.call(ProductionUtils.getTransshipDestinationsForShow, canonicalId) : null;
            } catch (_) {
                current = null;
            }
        }
        return combined;
    }

    /**
     * Save pack list data to the PACK_LISTS sheet.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tabName - The sheet/tab name.
     * @param {Array<Object>} crates - Array of crate objects, each with info and items arrays.
     * @param {Object} [headers] - { main: [...], items: [...] } (optional)
     * @param {string} [username] - Username making the change (for edithistory)
     * @returns {Promise<boolean>} Success status
     */
    static async savePackList(tabName, mappedData, headers = null, username = null, options = {}) {
        const { source = 'web' } = options;
        console.log('[PackListUtils.savePackList] crates input:', mappedData, 'options:', options);
        
        // CRITICAL: Check lock status before saving to prevent conflicts
        const lockInfo = await ApplicationUtils.getSheetLock('PACK_LISTS', tabName, username);
        if (lockInfo && lockInfo.user !== username) {
            const errorMsg = `Cannot save: pack list is locked by ${lockInfo.user}`;
            console.warn(`[PackListUtils.savePackList] ${errorMsg}`);
            throw new Error(errorMsg);
        }
        
        // Lock management is now handled by components via watchers on global locks store
        // Components acquire locks on edit mode entry and release on save completion

        let saveResult;
        try {
            const originalSheetData = await Database.getData('PACK_LISTS', tabName, null);
            console.log('[PackListUtils.savePackList] original sheet data:', originalSheetData);
            
            // Validate that originalSheetData is a 2D array
            if (!Array.isArray(originalSheetData) || originalSheetData.length === 0) {
                throw new Error('Pack list data is empty or invalid');
            }
            if (!Array.isArray(originalSheetData[0])) {
                throw new Error(`Pack list header row is malformed: expected array, got ${typeof originalSheetData[0]}`);
            }
            
            const headerRow = originalSheetData[0] || [];

        const itemColumnsStart = headerRow.findIndex(h => String(h ?? '').trim() === 'Pack');
        let mainHeaders = headerRow.slice(0, itemColumnsStart);
        let itemHeaders = headerRow.slice(itemColumnsStart);
        
        // Remove MetaData and EditHistory from both sections - they go at the end
        mainHeaders = mainHeaders.filter(h => {
            return !_isMetadataHeader(h);
        });
        itemHeaders = itemHeaders.filter(h => {
            return !_isMetadataHeader(h);
        });
        
        // Unified metadata columns at the END of all columns (after main + item)
        // This way both crate rows and item rows use the same column positions for metadata.
        // Row objects use the lowercase keys; the sheet uses the capitalized headers.
        const metadataHeaders = Object.values(PACKLIST_METADATA_COLUMNS);
        const metadataKeys = Object.keys(PACKLIST_METADATA_COLUMNS);

        // Read rows are keyed by normalized header names (getPackList collapses newlines, e.g.
        // "Packing/shop\nnotes" → "Packing/shop notes"); the sheet keeps the raw header
        const valueFor = (obj, header) => {
            if (obj[header] !== undefined) return obj[header];
            const normalized = obj[normalizeHeaderName(header)];
            return normalized !== undefined ? normalized : '';
        };

        // Clean crates: only keep properties in mainHeaders/itemHeaders, plus metadata keys
        const cleanCrates = Array.isArray(mappedData) ? mappedData.map(crate => {
            const cleanCrate = {};
            mainHeaders.forEach(h => {
                cleanCrate[h] = valueFor(crate, h);
            });
            metadataKeys.forEach(key => {
                if (crate[key] !== undefined) cleanCrate[key] = crate[key];
            });
            
            cleanCrate.Items = Array.isArray(crate.Items)
                ? crate.Items.map(itemObj => {
                    const cleanItem = {};
                    itemHeaders.forEach(h => {
                        cleanItem[h] = valueFor(itemObj, h);
                    });
                    metadataKeys.forEach(key => {
                        if (itemObj[key] !== undefined) cleanItem[key] = itemObj[key];
                    });
                    return cleanItem;
                })
                : [];
            return cleanCrate;
        }) : [];

        // If headers not provided, use those from original header row
        if (!headers) {
            headers = {
                main: mainHeaders,
                items: itemHeaders,
                metadata: metadataHeaders
            };
        }
        if (!headers) throw new Error('Cannot determine headers for saving packlist');

        // Create full mapping for all columns (enables automatic edithistory tracking)
        // Order: main columns + item columns + metadata columns (MetaData, EditHistory)
        const allHeaders = [...headers.main, ...headers.items, ...headers.metadata];
        const keyForHeader = Object.fromEntries(Object.entries(PACKLIST_METADATA_COLUMNS).map(([key, header]) => [header, key]));
        const packlistMapping = {};
        allHeaders.forEach(header => {
            packlistMapping[keyForHeader[header] || header] = header; // metadata columns → lowercase keys, others 1:1
        });
        
        // Add _orderedHeaders property to preserve column order (Object.values doesn't guarantee order)
        packlistMapping._orderedHeaders = allHeaders;
        const rowMetadataKeys = headers.metadata.map(header => keyForHeader[header]).filter(Boolean);
        
        // Flatten crates into row objects with ALL column properties
        const rowObjects = [];
        cleanCrates.forEach(crate => {
            // Crate row: main columns filled, item columns empty, metadata at end
            const crateRow = {};
            headers.main.forEach(h => {
                crateRow[h] = crate[h] !== undefined ? crate[h] : '';
            });
            headers.items.forEach(h => {
                crateRow[h] = ''; // Item columns empty for crate rows
            });
            rowMetadataKeys.forEach(key => {
                crateRow[key] = crate[key] !== undefined ? crate[key] : '';
            });
            rowObjects.push(crateRow);
            
            // Item rows: main columns empty, item columns filled, metadata at end
            if (Array.isArray(crate.Items)) {
                crate.Items.forEach(itemObj => {
                    const itemRow = {};
                    headers.main.forEach(h => {
                        itemRow[h] = ''; // Main columns empty for item rows
                    });
                    headers.items.forEach(h => {
                        itemRow[h] = itemObj[h] !== undefined ? itemObj[h] : '';
                    });
                    rowMetadataKeys.forEach(key => {
                        itemRow[key] = itemObj[key] !== undefined ? itemObj[key] : '';
                    });
                    rowObjects.push(itemRow);
                });
            }
        });
        
        // Save using object array with mapping - enables automatic edithistory tracking!
        // Database layer will handle diff calculation and history appending
        saveResult = await Database.setData('PACK_LISTS', tabName, rowObjects, packlistMapping, {
            username,
            skipMetadata: false, // Enable automatic history tracking
            source
        });
        } finally {
            // Lock management is handled by components
            // No lock release needed here
        }
        
        return saveResult;
    }

    /**
     * Compare item description with inventory description
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} itemNumber - The item number to look up in inventory
     * @param {string} description - The current item description to compare
     * @returns {Promise<Object|null>} Comparison result with score and descriptions, or null if no comparison possible
     */
    static async checkDescriptionMatch(deps, itemNumber, description) {
        if (!itemNumber || !description) {
            return null;
        }

        try {
            // Get inventory description for this item (current state, for description matching)
            const inventoryDescription = await deps.call(InventoryUtils.getItemDescription, itemNumber, todayISOString());
            
            if (!inventoryDescription) {
                return {
                    itemNumber,
                    inventoryFound: false,
                    score: 0
                };
            }

            // Extract clean descriptions using cached extraction functions
            // This removes item codes and quantities from both descriptions
            const packlistExtracted = await deps.call(PackListUtils.extractItemFromText, description);
            const inventoryExtracted = await deps.call(PackListUtils.extractItemFromText, inventoryDescription);
            
            const cleanPacklistDesc = packlistExtracted.description;
            const cleanInventoryDesc = inventoryExtracted.description;

            // Calculate similarity score
            const matchScore = GetParagraphMatchRating(cleanPacklistDesc, cleanInventoryDesc);

            return {
                itemNumber,
                inventoryFound: true,
                score: matchScore,
                packlistDescription: cleanPacklistDesc,
                inventoryDescription: cleanInventoryDesc
            };

        } catch (error) {
            console.error('Error checking description match:', error);
            return {
                itemNumber,
                inventoryFound: false,
                score: 0,
                error: error.message
            };
        }
    }

    /**
     * Get item quantities summary for a project (transformed to table format)
     * THIS WILL NOT RETURN INVENTORY FOR ITEMS IN SUB-PACKLISTS WITH SUFFIXES
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - The project identifier
     * @returns {Promise<Array<Object>>} Array of item objects for table display
     */
    static async getItemQuantitiesSummary(deps, projectIdentifier) {
        const quantitiesMap = await deps.call(PackListUtils.extractItems, projectIdentifier);
        
        // Transform to array format for table display
        return Object.entries(quantitiesMap).map(([itemId, quantity]) => ({
            itemId,
            quantity,
            tabName: null,        // Will be filled by first analysis
            available: null,      // Will be filled by second analysis
            remaining: null,      // Will be filled by fourth analysis  
            overlappingShows: []  // Will be filled by third analysis
        }));
    }

    /**
     * Get inventory quantity for a specific item
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} itemId - The item ID to look up
     * @returns {Promise<number|null>} Available inventory quantity, or null if item not found in inventory
     */
    static async getItemInventoryQuantity(deps, itemId, referenceDate) {
        const inventoryInfo = await deps.call(InventoryUtils.getItemInfo, itemId, ['quantity'], referenceDate);
        if (!inventoryInfo) return null;
        const item = inventoryInfo.find(i => i.itemName === itemId);
        
        // Return null if item not found or quantity is null/undefined/empty
        if (!item || item.quantity === null || item.quantity === undefined || item.quantity === '') {
            return null;
        }
        
        return parseInt(item.quantity, 10);
    }

    /**
     * Get overlapping projects that use a specific item
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} currentProjectId - Current project identifier
     * @param {string} itemId - Item ID to check for conflicts
     * @returns {Promise<Array<string>>} Array of overlapping project identifiers that use this item
     */
    static async getItemOverlappingPacklists(deps, currentProjectId, itemId) {
        // Resolve currentProjectId to canonical schedule identifier — handles NameOverride tab titles
        const currentRow = await deps.call(ProductionUtils.getShowDetails, currentProjectId);
        const currentScheduleId = currentRow
            ? await deps.call(ProductionUtils.getCanonicalIdentifierForScheduleRow, currentRow)
            : currentProjectId;

        // Get all overlapping projects for this project
        let overlappingProjects = await deps.call(ProductionUtils.getOverlappingShows, {
            dateFilters: [
                { column: 'Return', value: currentProjectId, type: 'after' },
                { column: 'Ship', value: currentProjectId, type: 'before' }
            ]
        });
        
        // Deduplicate to prevent listing the same show multiple times
        overlappingProjects = await deps.call(ProductionUtils.deduplicateScheduleByShow, overlappingProjects);
        
        // Identify transship source so it is not listed as conflicting demand
        const transshipSourceId = await deps.call(ProductionUtils.getTransshipSourceForShow, currentScheduleId);

        const conflictingShows = [];
        
        // Check each overlapping project to see if it uses this item
        for (const projectRow of overlappingProjects) {
            // Derive canonical schedule identifier — ScheduleOverrides stores canonical ids, not tab titles
            const scheduleProjectId = await deps.call(ProductionUtils.getCanonicalIdentifierForScheduleRow, projectRow);
            if (!scheduleProjectId) continue;
            
            if (_normalizeId(scheduleProjectId) === _normalizeId(currentScheduleId)) continue;
            if (transshipSourceId && _normalizeId(scheduleProjectId) === _normalizeId(transshipSourceId)) continue;
            // Skip transship destinations — their items are already covered by the chain root's chain items
            const isDestination = await deps.call(ProductionUtils.getTransshipSourceForShow, scheduleProjectId);
            if (isDestination) continue;
            
            try {
                const projectItems = await deps.call(PackListUtils.extractChainItemsForIdentifier, scheduleProjectId);
                if (projectItems[itemId] && projectItems[itemId] > 0) {
                    conflictingShows.push(scheduleProjectId);
                }
            } catch (e) {
                // Ignore projects that can't be loaded
            }
        }
        
        return conflictingShows;
    }

    /**
     * Calculate remaining quantity for an item based on inventory, current usage, and overlapping shows
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} currentProjectId - Current project identifier
     * @param {string} itemId - Item ID to calculate remaining quantity for
     * @returns {Promise<number|null>} Remaining available quantity, or null if item not found in inventory
     */
    static async calculateRemainingQuantity(deps, currentProjectId, itemId, referenceDate) {
        if (!itemId || !currentProjectId) {
            return null;
        }

        // Compute window end once; minimum quantity is sourced directly from timeline-based
        // logic in InventoryUtils.getItemMinQuantityInRange (which delegates to getItemTimeline).
        const returnDate = await deps.call(ProductionUtils.getProjectReturnDate, currentProjectId);
        //console.log(`[remaining] ${itemId} for ${currentProjectId}: window [${referenceDate} → ${returnDate}]`);
        return await deps.call(InventoryUtils.getItemMinQuantityInRange, itemId, referenceDate, returnDate);
    }

    /**
     * Extract items from multiple shows and aggregate quantities
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Array<string>} projectIdentifiers - Array of project identifiers to extract items from
     * @returns {Promise<Array>} Array of items with quantities per show and total
     */
    static async extractItemsFromMultipleShows(deps, projectIdentifiers, ctgFilter = undefined, includeEmptyShows = true) {
        const allItemsMap = {};
        const processedShows = [];
        
        // Extract items from each show
        let _showIdx = 0;
        for (const projectId of projectIdentifiers) {
            _showIdx++;
            // Emit progress every 5 shows and on the last one
            if (_showIdx % 5 === 0 || _showIdx === projectIdentifiers.length) {
                ProgressBus.emit('packlist:extractItemsFromMultipleShows', {
                    current: _showIdx,
                    total: projectIdentifiers.length,
                    message: `Loading pack list items from multiple shows: ${_showIdx} of ${projectIdentifiers.length}...`
                });
            }
            try {
                // Skip transship destinations; chain roots represent their entire chain via extractChainItemsForIdentifier
                const isDestination = await deps.call(ProductionUtils.getTransshipSourceForShow, projectId);
                if (isDestination) {
                    if (includeEmptyShows) processedShows.push(projectId);
                    continue;
                }
                const itemsMap = await deps.call(PackListUtils.extractChainItemsForIdentifier, projectId, ctgFilter);
                
                // Aggregate all unique items
                for (const [itemId, quantity] of Object.entries(itemsMap)) {
                    if (!allItemsMap[itemId]) {
                        allItemsMap[itemId] = {
                            itemId,
                            totalQuantity: 0,
                            shows: {},
                            tabName: null,
                            available: null,
                            remaining: null
                        };
                        // Backfill all previously processed shows as null for this new item
                        if (includeEmptyShows) {
                            for (const prevShowId of processedShows) {
                                allItemsMap[itemId].shows[prevShowId] = null;
                            }
                        }
                    }
                    allItemsMap[itemId].shows[projectId] = quantity;
                    allItemsMap[itemId].totalQuantity += quantity;
                }
                
                // For all existing items missing this show, set to null
                if (includeEmptyShows) {
                    for (const item of Object.values(allItemsMap)) {
                        if (!(projectId in item.shows)) {
                            item.shows[projectId] = null;
                        }
                    }
                }
            } catch (e) {
                console.warn(`Failed to load items for ${projectId}:`, e);
                // Add this show as null to all existing items
                if (includeEmptyShows) {
                    for (const item of Object.values(allItemsMap)) {
                        if (!(projectId in item.shows)) {
                            item.shows[projectId] = null;
                        }
                    }
                }
            }
            
            processedShows.push(projectId);
        }
        
        // Transform to array format for table display
        return Object.values(allItemsMap);
    }

    /**
     * Generate a summary description for a packlist
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - The project identifier (tab name)
     * @returns {Promise<Object>} Summary object with { totalCrates, totalItems, itemCount }
     */
    static async getPacklistSummary(deps, projectIdentifier) {
        try {
            // Get pack list content (array of crate objects with Items arrays)
            const crates = await deps.call(PackListUtils.getContent, projectIdentifier, "Pack");
            
            if (!crates || crates.length === 0) {
                return {
                    totalCrates: 0,
                    totalItems: 0,
                    itemCount: 0
                };
            }

            let totalItems = 0;
            const uniqueItems = new Set();

            // Count items and unique item numbers
            crates.forEach(crate => {
                if (crate.Items && Array.isArray(crate.Items)) {
                    crate.Items.forEach(item => {
                        totalItems++;
                        
                        // Extract item number from Description or other fields
                        const description = item.Description || item['Packing/shop notes'] || '';
                        const itemMatch = description.match(/([A-Z]+-\d+)/);
                        if (itemMatch) {
                            uniqueItems.add(itemMatch[1]);
                        }
                    });
                }
            });

            return {
                totalCrates: crates.length,
                totalItems: totalItems,
                itemCount: uniqueItems.size
            };
        } catch (error) {
            console.error(`Error generating packlist summary for ${projectIdentifier}:`, error);
            return {
                totalCrates: 0,
                totalItems: 0,
                itemCount: 0
            };
        }
    }

    /**
     * Get filtered packlists based on schedule parameters
     * Returns all packlist tabs (excluding _TEMPLATE) optionally filtered by schedule overlap
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {Object|string} filter - Filter parameters:
     *   - null: returns empty array (no filter selected)
     *   - { type: 'show-all' }: returns all packlists
     *   - { dateFilters }: filters by schedule overlap using dateFilters array
     * @returns {Promise<Array>} Array of packlist tab objects with title, sheetId
     */
    static async getPacklists(deps, filter = null) {
        // Get all available packlist tabs
        const allTabs = await deps.call(Database.getTabs, 'PACK_LISTS');
        
        // Filter out _TEMPLATE and hidden tabs
        let tabs = allTabs.filter(tab => tab.title !== '_TEMPLATE' && !tab.title.startsWith('_'));
        
        // If no filter, return empty array (user must select a filter)
        if (!filter) {
            return [];
        }
        
        // If "show all" filter, return all tabs
        if (filter.type === 'show-all') {
            return tabs;
        }
        
        // Otherwise, filter by schedule overlap
        try {
            // Get overlapping shows from production schedule
            const shows = await deps.call(ProductionUtils.getOverlappingShows, filter);
            
            // Filter tabs: for each overlapping show, find its packlist tabs (Direction 1)
            const matchedTitles = new Set();
            for (const show of shows) {
                const matchedTabs = await deps.call(ProductionUtils.findPacklistTabsForScheduleRow, show, tabs);
                matchedTabs.forEach(tab => matchedTitles.add(tab.title));
            }
            return tabs.filter(tab => matchedTitles.has(tab.title));
        } catch (error) {
            console.error('[PackListUtils] Error filtering packlists by schedule:', error);
            return [];
        }
    }
}

export const PackListUtils = wrapMethods(packListUtils_uncached, 'packlist_utils', ['savePackList']);