// Dynamic Google Sheets Service selection
import { isLocalhost } from '../../google_sheets_services/FakeGoogle.js';
let GoogleSheetsService, GoogleSheetsAuth;

if (isLocalhost()) {
    // Dynamically import fake services
    // Note: This import must match the actual path and export names
    // If using a bundler, you may need to adjust this to static imports
    // eslint-disable-next-line no-undef
    console.warn('Running locally, using fake Google services.');
    ({ GoogleSheetsService, GoogleSheetsAuth } = await import('../../google_sheets_services/FakeGoogle.js'));
} else {
    // Use real services for production
    // eslint-disable-next-line no-undef
    ({ GoogleSheetsService, GoogleSheetsAuth } = await import('../../google_sheets_services/index.js'));
}

import { wrapMethods, invalidateCache, EditHistoryUtils } from '../index.js';

class database_uncached {
    /**
     * Retrieves data for a table/tab and returns as array of JS objects
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table (INVENTORY, PACK_LISTS, etc.)
     * @param {string} tabName - Tab name or logical identifier
     * @param {Object} [mapping] - Optional mapping for object keys to sheet headers
     * @returns {Promise<Array<Object>>} - Array of JS objects
     */
    static async getData(deps, tableId, tabName, mapping = null) {
        // Get raw sheet data from GoogleSheetsService
        const rawData = await GoogleSheetsService.getSheetData(tableId, tabName);
        //console.log('[Database] Raw data from GoogleSheetsService:', rawData);
        //console.log('[Database] Mapping provided:', mapping);
        
        // If mapping provided, transform to JS objects
        if (mapping) {
            const transformedData = GoogleSheetsService.transformSheetData(rawData, mapping, tabName);
            console.log('[Database] Transformed data:', transformedData);
            return transformedData;
        }
        // If no mapping, return raw 2D array
        return rawData;
    }
        
    /**
     * Gets all logical tabs for a table
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table
     * @returns {Promise<Array<{title: string, sheetId: number}>>} - List of logical tabs
     */
    static async getTabs(deps, tableId) {
        return await GoogleSheetsService.getSheetTabs(tableId);
    }
    
    /**
     * Executes a SQL-like query against logical table data
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - The table identifier
     * @param {string} query - SQL-like query string
     * @returns {Promise<Array<Object>>} Query results
     */
    static async queryData(deps, tableId, query) {
        return await GoogleSheetsService.querySheetData(tableId, query);
    }
    
    /**
     * Helper method to find a logical tab by name
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table
     * @param {string} tabName - Name of the tab to find
     * @returns {Promise<{title: string, sheetId: number}|null>} - The tab object or null if not found
     */
    static async findTabByName(deps, tableId, tabName) {
        const tabs = await deps.call(Database.getTabs, tableId);
        return tabs.find(tab => tab.title === tabName) || null;
    }


    /**
     * Search for an item image in Google Drive folder
     * @param {string} itemNumber - The item number to search for
     * @param {string} folderId - Google Drive folder ID containing the images
     * @returns {Promise<string|null>} Direct image URL or null if not found
     */
    static async getItemImageUrl(deps, itemNumber, folderId = '1rvWRUB38BsQJQyOPtF1JEG20qJPvTjZM') {
        // Defensive: handle null, undefined, or non-string values
        if (!itemNumber || itemNumber === null || itemNumber === undefined) {
            //console.warn('[Database.getItemImageUrl] No itemNumber provided, returning empty string');
            return '';
        }
        
        // Convert to string if not already
        const itemNumberStr = String(itemNumber).trim();
        
        if (!itemNumberStr) {
            //console.warn('[Database.getItemImageUrl] Empty itemNumber after trim, returning empty string');
            return '';
        }
        
        //console.log('[Database.getItemImageUrl] Searching for image:', itemNumberStr);
                
        // Try different file extensions
        const extensions = ['jpg', 'jpeg', 'png'];
        
        for (const ext of extensions) {
            const fileName = `${itemNumberStr}.${ext}`;            
            const file = await GoogleSheetsService.searchDriveFileInFolder(fileName, folderId);
            
            if (file && file.directImageUrl) {
                //console.log(`[Database.getItemImageUrl] Found image for ${itemNumberStr}: ${file.directImageUrl}`);
                return file.directImageUrl;
            }
        }
        
        // Fallback: Try splitting on common separators and search for the first part
        const separators = /[\s\-_]+/; // Split on space, hyphen, or underscore
        const parts = itemNumberStr.split(separators);
        
        if (parts.length > 1 && parts[0]) {
            // Recursively search with the first part (benefits from caching via deps.call)
            return await deps.call(Database.getItemImageUrl, parts[0], folderId);
        }
        
        return ''; // Return empty string if no image found
    }


    /* MUTATION FUNCTIONS */


    /**
     * Updates data for a table/tab using JS objects
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table
     * @param {string} tabName - Tab name or logical identifier
     * @param {Array<Object>} updates - Array of JS objects to save
     * @param {Object} [mapping] - Optional mapping for object keys to sheet headers
     * @param {Object} [options] - Optional parameters for edithistory tracking
     * @param {string} [options.username] - Username making the change
     * @param {boolean} [options.skipMetadata] - Skip edithistory generation (for EditHistory table itself)
     * @param {string} [options.identifierKey] - Key to identify rows (for deletion tracking)
     * @returns {Promise<boolean>} - Success status
     */
    static async setData(tableId, tabName, updates, mapping = null, options = {}) {
        const {
            username = null,
            skipMetadata = false,
            identifierKey = null
        } = options;

        let updatesWithMetadata = updates;

        // Add edithistory tracking if not skipped
        if (!skipMetadata && mapping && mapping.edithistory) {
            try {
                // Get original data for comparison (use Database.getData to leverage cache)
                const transformedOriginal = await Database.getData(tableId, tabName, mapping);

                // Add edithistory to updated rows
                updatesWithMetadata = await _addMetadataToRows(
                    transformedOriginal,
                    updates,
                    username,
                    mapping
                );

                // Detect and archive deleted rows
                if (identifierKey) {
                    const deletedRows = EditHistoryUtils.detectDeletedRows(
                        transformedOriginal,
                        updates,
                        identifierKey
                    );

                    if (deletedRows.length > 0) {
                        await _archiveDeletedRows(
                            tableId,
                            tabName,
                            deletedRows,
                            username
                        );
                    }
                }
            } catch (error) {
                console.warn('Failed to add edithistory, continuing with save:', error);
                // Continue with save even if edithistory fails
            }
        }

        const result = await GoogleSheetsService.setSheetData(tableId, tabName, updatesWithMetadata, mapping);
        
        // Invalidate related caches using prefix to handle custom mapped data
        invalidateCache([
            { namespace: 'database', methodName: 'getData', args: [tableId, tabName] }
        ], true);
        
        return result;
    }

    
    /**
     * Updates a single row in a table/tab using a unique identifier.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table
     * @param {string} tabName - Tab name or logical identifier
     * @param {Object} update - JS object representing the row to update
     * @param {Object} [mapping] - Optional mapping for object keys to sheet headers
     * @param {Object} [options] - Optional parameters for edithistory tracking
     * @param {string} [options.username] - Username making the change
     * @returns {Promise<boolean>} - Success status
     */
    static async updateRow(tableId, tabName, update, mapping = null, options = {}) {
        const { username = null } = options;

        const existingData = await GoogleSheetsService.getSheetData(tableId, tabName);

        const transformedData = mapping
            ? GoogleSheetsService.transformSheetData(existingData, mapping, tabName)
            : GoogleSheetsService.sheetArrayToObjects(existingData);

        const rowIndex = transformedData.findIndex(row => {
            const identifierKey = mapping ? Object.keys(mapping).find(k => k.includes('Number') || k.includes('Id')) : 'id';
            const updateKey = Object.keys(update).find(k => k.includes('Number') || k.includes('Id')) || Object.keys(update)[0];
            return row[identifierKey] === update[updateKey];
        });
        
        if (rowIndex === -1) {
            throw new Error(`Row with identifier not found in tab ${tabName}`);
        }

        const originalRow = transformedData[rowIndex];

        // Calculate changes and add edithistory if mapping includes it
        let updatedRow = { ...originalRow, ...update };
        if (mapping && mapping.edithistory && username) {
            const changes = EditHistoryUtils.calculateRowDiff(originalRow, update);
            if (changes.length > 0) {
                const metaEntry = EditHistoryUtils.createEditHistoryEntry(username, changes);
                const existingMetadata = originalRow.edithistory || originalRow.EditHistory || '';
                const newMetadata = EditHistoryUtils.appendToEditHistory(existingMetadata, metaEntry);
                updatedRow.edithistory = newMetadata;
            }
        }

        // Update the transformed row
        transformedData[rowIndex] = updatedRow;

        // Convert back to sheet format for saving
        const updatedSheetData = mapping
            ? GoogleSheetsService.reverseTransformSheetData(mapping, transformedData)
            : GoogleSheetsService.objectsToSheetArray(transformedData);

        await GoogleSheetsService.setSheetData(tableId, tabName, updatedSheetData);

        // Invalidate related caches using prefix to handle custom mapped data
        invalidateCache([
            { namespace: 'database', methodName: 'getData', args: [tableId, tabName] }
        ], true);

        return true;
    }
    
    /**
     * Hides specified logical tabs in a table
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table
     * @param {Array<{title: string, sheetId: number}>} tabs - Tabs to hide
     */
    static async hideTabs(tableId, tabs) {
        await GoogleSheetsService.hideTabs(tableId, tabs);
    }
    
    /**
     * Shows specified logical tabs in a table
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table
     * @param {Array<{title: string, sheetId: number}>} tabs - Tabs to show
     */
    static async showTabs(tableId, tabs) {
        await GoogleSheetsService.showTabs(tableId, tabs);
    }
    
    /**
     * Creates a new logical tab by copying a template or creating blank
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table
     * @param {{title: string, sheetId: number}|null} templateTab - Template tab to copy (null for blank tab)
     * @param {string} newTabName - Name for the new tab
     * @returns {Promise<void>}
     */
    static async createTab(tableId, templateTab, newTabName) {
        if (templateTab && templateTab.sheetId) {
            await GoogleSheetsService.copySheetTab(tableId, templateTab, newTabName);
        } else {
            await GoogleSheetsService.createBlankTab(tableId, newTabName);
        }
        
        // Invalidate related caches
        invalidateCache([
            { namespace: 'database', methodName: 'getTabs', args: [tableId] }
        ]);
    }
}

// Wrap and export the class with caching, excluding mutation methods
// Image URLs get infinite cache since they rarely change and are expensive Google Drive API calls
export const Database = wrapMethods(
    database_uncached, 
    'database', 
    ['createTab', 'hideTabs', 'showTabs', 'setData', 'updateRow'],
    ['getItemImageUrl'] // Infinite cache for image URLs
);


/**
 * Add edithistory to rows that have changed
 * @private
 */
async function _addMetadataToRows(originalRows, updatedRows, username, mapping) {
    if (!Array.isArray(updatedRows)) {
        return updatedRows;
    }

    return updatedRows.map((updatedRow, index) => {
        const originalRow = originalRows[index];

        // Calculate changes for this row
        const changes = EditHistoryUtils.calculateRowDiff(originalRow, updatedRow);

        // If changes exist, append to edithistory
        if (changes.length > 0 && username) {
            const metaEntry = EditHistoryUtils.createEditHistoryEntry(username, changes);
            const existingMetadata = updatedRow.edithistory || '';
            const newMetadata = EditHistoryUtils.appendToEditHistory(existingMetadata, metaEntry);

            // Update the edithistory field using the mapping key (always 'edithistory')
            return { ...updatedRow, edithistory: newMetadata };
        }

        return updatedRow;
    });
}

/**
 * Archive deleted rows to EditHistory table
 * @private
 */
async function _archiveDeletedRows(sourceTable, sourceTab, deletedRows, username) {
    try {
        // Get existing edithistory table data (use Database to leverage cache if available)
        let edithistoryTableData = [];
        try {
            // Try to get with mapping first
            const edithistoryMapping = {
                SourceTable: 'SourceTable',
                SourceTab: 'SourceTab',
                RowIdentifier: 'RowIdentifier',
                Username: 'Username',
                Timestamp: 'Timestamp',
                Operation: 'Operation',
                RowData: 'RowData'
            };
            
            edithistoryTableData = await Database.getData(sourceTable, 'EditHistory', edithistoryMapping);
        } catch (error) {
            // EditHistory tab doesn't exist yet, will be created
            console.log('EditHistory tab does not exist yet, will create');
            edithistoryTableData = [];
        }

        // Create archive entries for deleted rows
        const archiveEntries = deletedRows.map(deleted => 
            EditHistoryUtils.createArchiveEntry(
                sourceTable,
                sourceTab,
                deleted.identifier,
                deleted.rowData,
                username
            )
        );

        // Append to existing edithistory
        const updatedMetadata = [...edithistoryTableData, ...archiveEntries];

        // Save to EditHistory table (skip edithistory for this table itself)
        const edithistoryMapping = {
            SourceTable: 'SourceTable',
            SourceTab: 'SourceTab',
            RowIdentifier: 'RowIdentifier',
            Username: 'Username',
            Timestamp: 'Timestamp',
            Operation: 'Operation',
            RowData: 'RowData'
        };

        await GoogleSheetsService.setSheetData(
            sourceTable,
            'EditHistory',
            updatedMetadata,
            edithistoryMapping
        );

        console.log(`Archived ${deletedRows.length} deleted rows to EditHistory table`);
    } catch (error) {
        console.error('Failed to archive deleted rows:', error);
        // Don't throw - archival failure shouldn't block the main save
    }
}