import { Database, ProductionUtils, wrapMethods, searchFilter, ApplicationUtils, invalidateCache } from '../index.js';

/**
 * Utility functions for inventory operations
 */
class inventoryUtils_uncached {
    static DEFAULT_INVENTORY_MAPPING = {
        itemNumber: 'ITEM#',
        quantity: 'QTY',
        description: 'Description',
        notes: 'NOTES',
        edithistory: 'EditHistory'
    };

    static async getTabNameForItem(deps, itemName) {
        const indexData = await deps.call(Database.getData, 'INVENTORY', 'INDEX', { prefix: 'PREFIX', tab: 'INVENTORY' });
        // Build prefix-to-tab mapping from transformed objects
        const prefixToTab = {};
        indexData.forEach(row => {
            if (row.prefix && row.tab) {
                prefixToTab[row.prefix] = row.tab;
            }
        });
        
        let [prefix] = itemName.split('-');
        let tab = prefixToTab[prefix];
        if (!tab && prefix?.length > 0) {
            prefix = prefix[0];
            tab = prefixToTab[prefix];
        }
        
        // If prefix lookup failed, check HARDWARE table for exact item number match
        if (!tab) {
            try {
                const hardwareData = await deps.call(Database.getData, 'INVENTORY', 'HARDWARE', inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING);
                const hardwareItem = hardwareData.find(item => item.itemNumber === itemName);
                if (hardwareItem) {
                    return 'HARDWARE';
                }
            } catch (error) {
                console.error('Error checking HARDWARE table:', error);
            }
        }
        
        return tab || null;
    }

    static async getItemInfo(deps, itemName, fields) {
        const itemNames = Array.isArray(itemName) ? itemName : [itemName];
        const infoFields = Array.isArray(fields) ? fields : [fields];
        const itemsByTab = {};
        const unmappedItems = [];
        for (const item of itemNames) {
            if (!item) continue;
            const tab = await deps.call(InventoryUtils.getTabNameForItem, item);
            if (!tab) {
                unmappedItems.push(item);
                continue;
            }
            if (!itemsByTab[tab]) itemsByTab[tab] = [];
            itemsByTab[tab].push(item);
        };
        const results = [];
        for (const [tab, items] of Object.entries(itemsByTab)) {
            try {
                let tabData = await deps.call(Database.getData, 'INVENTORY', tab, inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING);
                items.forEach(item => {
                    const originalItem = item;
                    let foundObj = null;
                    if (item.includes('-')) {
                        const itemNumber = item.split('-')[1];
                        foundObj = tabData.find(obj => obj.itemNumber === itemNumber);
                        if (!foundObj) {
                            foundObj = tabData.find(obj => obj.itemNumber === originalItem);
                        }
                    } else {
                        foundObj = tabData.find(obj => obj.itemNumber === item);
                    }
                    const obj = { itemName: originalItem };
                    if (foundObj) {
                        infoFields.forEach(field => {
                            obj[field] = foundObj[field] ?? null;
                        });
                    } else {
                        infoFields.forEach(field => obj[field] = null);
                    }
                    results.push(obj);
                });
            } catch (error) {
                items.forEach(item => {
                    const obj = { itemName: item };
                    infoFields.forEach(field => obj[field] = null);
                    results.push(obj);
                });
            }
        }
        unmappedItems.forEach(item => {
            const obj = { itemName: item };
            infoFields.forEach(field => obj[field] = null);
            results.push(obj);
        });
        return results;
    }

    static async getInventoryTabData(deps, tabOrItemName, mapping = inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING, filters = null) {

        // Get all tabs on the inventory sheet
        const allTabs = await deps.call(Database.getTabs, 'INVENTORY');

        // Check if the tab exists
        const tabExists = allTabs.some(tab => tab.title === tabOrItemName);
        let resolvedTabName = tabOrItemName;

        if (!tabExists) {
            const foundTab = await deps.call(InventoryUtils.getTabNameForItem, tabOrItemName);
            if (!foundTab) throw new Error(`Inventory tab for "${tabOrItemName}" not found and could not be resolved from INDEX.`);
            resolvedTabName = foundTab;
        }

        // Get tab data as JS objects (mapping transforms 2D array to objects)
        let tabData = await deps.call(Database.getData, 'INVENTORY', resolvedTabName, mapping);

        // Apply search filter if filters are provided (after transformation to objects)
        if (filters) {
            tabData = searchFilter(tabData, filters);
        }

        return tabData;
    }

    static async saveInventoryTabData(mappedData, tabOrItemName, mapping = inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING, filters = null, username = null, options = {}) {
        const { force = false, reason = '', autoLock = false } = options;
        
        const allTabs = await Database.getTabs('INVENTORY');
        const tabExists = allTabs.some(tab => tab.title === tabOrItemName);
        let resolvedTabName = tabOrItemName;

        if (!tabExists) {
            const foundTab = await InventoryUtils.getTabNameForItem(tabOrItemName);
            if (!foundTab) throw new Error(`Inventory tab for "${tabOrItemName}" not found and could not be resolved from INDEX.`);
            resolvedTabName = foundTab;
        }
        
        // CRITICAL: Check lock status before saving to prevent conflicts
        const lockInfo = await ApplicationUtils.getSheetLock('INVENTORY', resolvedTabName, username);
        if (lockInfo) {
            const errorMsg = `Cannot save: inventory category is locked by ${lockInfo.user}`;
            console.error(`[InventoryUtils.saveInventoryTabData] ${errorMsg}`);
            throw new Error(errorMsg);
        }
        
        // Lock management is now handled by components via watchers on global locks store
        // Components acquire locks on edit mode entry and release on save completion

        let saveResult;
        try {
            if (filters) {
                // Fetch existing data from the tab
                const existingData = await Database.getData('INVENTORY', resolvedTabName, mapping);

                // Prepare batch updates
                const updates = mappedData.filter(item => {
                    const existingItem = existingData.find(row => row.itemNumber === item.itemNumber);
                    return existingItem && JSON.stringify(existingItem) !== JSON.stringify(item);
                });

                // Send updates one by one with username
                for (const update of updates) {
                    await Database.updateRow('INVENTORY', resolvedTabName, update, mapping, { username });
                }

                saveResult = true;
            } else {
                if (mappedData && typeof mappedData === 'object' && mappedData.__v_isReactive) {
                    mappedData = Array.from(mappedData);
                }

                // Save JS objects using mapping with edithistory options
                saveResult = await Database.setData('INVENTORY', resolvedTabName, mappedData, mapping, {
                    username,
                    identifierKey: 'itemNumber'
                });
            }
        } finally {
            // Lock management is handled by components
            // No lock release needed here
        }

        return saveResult;
    }


    /**
     * Check item availability for a project
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} projectIdentifier - Project identifier
     * @returns {Promise<Object>} Item availability map
     */
    static async checkItemAvailability(deps, projectIdentifier) {
        
        try {
            // 1. Get pack list items
            const itemMap = await deps.call(PackListUtils.extractItems, projectIdentifier);
            const itemIds = Object.keys(itemMap);

            // If no items, return empty result
            if (!itemIds.length) {
                return {};
            }

            // Get inventory quantities
            let inventoryInfo = await deps.call(InventoryUtils.getItemInfo, itemIds, "QTY");
            
            // Filter valid items and build result
            const result = {};
            itemIds.forEach(itemId => {
                const qty = inventoryInfo.find(i => i.itemName === itemId)?.quantity ?? null;
                if (qty !== null) {
                    result[itemId] = { available: qty, allocated: 0, onOrder: 0 };
                }
            });

            // Get overlapping shows
            let overlappingIds = await deps.call(ProductionUtils.getOverlappingShows, { identifier: projectIdentifier });
            
            // Process overlapping shows
            for (const overlapRow of overlappingIds) {
                // Extract identifier from the row object
                const overlapId = overlapRow.Identifier || 
                                 await deps.call(ProductionUtils.computeIdentifier, overlapRow.Show, overlapRow.Client, overlapRow.Year);
                
                if (overlapId === projectIdentifier) continue;
                
                const overlapInfo = await deps.call(PackListUtils.extractItems, overlapId);
                
                for (const itemId of Object.keys(overlapInfo)) {
                    if (!result[itemId]) continue;
                    
                    const allocated = result[itemId].allocated + (overlapInfo[itemId].allocated || 0);
                    const onOrder = result[itemId].onOrder + (overlapInfo[itemId].onOrder || 0);
                    result[itemId] = { ...result[itemId], allocated, onOrder };
                }
            }
            
            return result;
        } catch (error) {
            console.error('Failed to check quantities:', error);
            throw error;
        }
    }

    /**
     * Get inventory description for a specific item
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} itemNumber - The item number to look up
     * @returns {Promise<string|null>} Item description or null if not found
     */
    static async getItemDescription(deps, itemNumber) {
        if (!itemNumber) return null;
        
        try {
            const itemInfo = await deps.call(InventoryUtils.getItemInfo, itemNumber, ['description']);
            return itemInfo?.[0]?.description || null;
        } catch (error) {
            console.error(`Failed to get description for item ${itemNumber}:`, error);
            return null;
        }
    }

}

export const InventoryUtils = wrapMethods(inventoryUtils_uncached, 'inventory_utils', ['saveInventoryTabData']);