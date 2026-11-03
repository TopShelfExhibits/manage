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

import { wrapMethods, invalidateCache, stampDataChange, EditHistoryUtils } from '../index.js';
import { ApplicationUtils } from '../index.js';

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
            //console.log('[Database] Transformed data:', transformedData);
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
     * Resize a File to fit within maxDimension × maxDimension, preserving aspect ratio.
     * Returns the original File unchanged if it is already within bounds.
     * @param {File} file
     * @param {number} maxDimension
     * @returns {Promise<File>}
     */
    static _resizeImageFile(file, maxDimension) {
        return new Promise((resolve) => {
            const img = new Image();
            const objectUrl = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                if (img.width <= maxDimension && img.height <= maxDimension) {
                    resolve(file);
                    return;
                }
                const scale = Math.min(maxDimension / img.width, maxDimension / img.height);
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                const mimeType = file.type || 'image/jpeg';
                canvas.toBlob((blob) => {
                    resolve(new File([blob], file.name, { type: mimeType }));
                }, mimeType, 0.92);
            };
            img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); };
            img.src = objectUrl;
        });
    }

    /**
     * Upload an image for an item to the Drive thumbnails folder.
     * Replaces any existing image files for that item number.
     * MUTATION — not cached.
     * @param {File} file - The image file to upload
     * @param {string} itemNumber - The item number used to name the file
     * @param {string} folderId - Google Drive folder ID for thumbnails
     * @returns {Promise<{fileId: string, file: File}|null>} The new Drive file ID and the image
     *   that was uploaded (already resized — lets the caller show it without downloading it back),
     *   or null on failure
     */
    static async uploadItemImage(file, itemNumber, folderId = window.ENDPOINT_IDS.THUMBNAILS) {
        const itemNumberStr = String(itemNumber).trim();
        const ext = file.type === 'image/png' ? 'png' : 'jpg';
        const fileName = `${itemNumberStr}.${ext}`;

        // Resize to max 512px before uploading. If the image is already within bounds,
        // resizedFile === file (no copy made). If larger, upload the original as a backup first.
        const MAX_UPLOAD_DIM = 512;
        const resizedFile = await database_uncached._resizeImageFile(file, MAX_UPLOAD_DIM);
        const wasResized = resizedFile !== file;

        // Check if this item currently has a thumbnail record that points to a prefix file
        // If so, we need to preserve that file when uploading the item's own image
        const currentRecord = await ApplicationUtils.getThumbnailRecord(itemNumberStr);
        const prefixFileIdsToPreserve = new Set();
        if (currentRecord && currentRecord.file) {
            // Extract prefix from item number
            const separators = /[\s\-_]+/;
            const parts = itemNumberStr.split(separators);
            if (parts.length >= 2 && parts[0]) {
                const prefix = parts[0];
                // Check if the current file belongs to the prefix (not the item itself)
                const prefixRecord = await ApplicationUtils.getThumbnailRecord(prefix);
                if (prefixRecord && prefixRecord.file === currentRecord.file) {
                    // This item is using a prefix file - preserve it
                    prefixFileIdsToPreserve.add(prefixRecord.file);
                }
            }
        }

        // Find any existing files for this item to delete after upload
        const extensions = ['jpg', 'jpeg', 'png'];
        const existingFileIds = [];
        for (const existingExt of extensions) {
            const existing = await GoogleSheetsService.searchDriveFileInFolder(`${itemNumberStr}.${existingExt}`, folderId);
            if (existing && existing.id) {
                // Don't mark prefix files for deletion
                if (!prefixFileIdsToPreserve.has(existing.id)) {
                    existingFileIds.push(existing.id);
                }
            }
        }

        // If the image was resized, save the original under <itemNumber>_ORIGINAL.<ext>
        if (wasResized) {
            const originalFileName = `${itemNumberStr}_ORIGINAL.${ext}`;
            await GoogleSheetsService.uploadDriveFile(file, originalFileName, folderId)
                .catch(err => console.warn('[icons] Failed to save original image backup:', err));
        }

        const uploaded = await GoogleSheetsService.uploadDriveFile(resizedFile, fileName, folderId);
        if (!uploaded || !uploaded.id) return null;

        // Delete old files, skipping the newly uploaded file ID and any that can't be deleted
        // (e.g. files owned by another user — Drive returns 404 for those, handled in deleteDriveFile).
        for (const oldId of existingFileIds) {
            if (oldId === uploaded.id) continue;
            await GoogleSheetsService.deleteDriveFile(oldId);
        }

        ApplicationUtils.storeThumbnailRecord(itemNumberStr, uploaded.id, null)
            .catch(err => console.warn('[icons] Failed to store thumbnail record on upload:', err));
        return { fileId: uploaded.id, file: resizedFile };
    }

    /**
     * Fetch a Drive file's raw content as a Blob.
     * NOT CACHED — callers own the result: the thumbnail cache (application/utils/thumbnailCache.js)
     * downscales and persists it per device; the full-size image modal frees it on close.
     * @param {string} fileId - Google Drive file ID
     * @returns {Promise<Blob|null>} The file content, or null on failure
     */
    static async getDriveFileBlob(fileId) {
        if (!fileId) return null;
        return await GoogleSheetsService.getDriveFileBlob(fileId);
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
     * @param {string} [options.source] - Source system for history entries ('web' | 'cad')
     * @returns {Promise<boolean>} - Success status
     */
    static async setData(tableId, tabName, updates, mapping = null, options = {}) {
        const {
            username = null,
            skipMetadata = false,
            identifierKey = null,
            source = 'web'
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
                    mapping,
                    source
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
        
        // ═══════════════════════════════════════════════════════════════
        // CRITICAL — DO NOT REORDER THESE TWO CALLS
        //
        // stampDataChange MUST be called before invalidateCache.
        // stampDataChange captures `new Date().toISOString()` immediately
        // and writes it to the CACHE/Caching tab (async, fire-and-forget).
        // invalidateCache then clears the local in-memory cache.
        // After both complete, the caller (store.save) issues apiCall()
        // to repopulate the cache with entry.filled = now.
        //
        // Because the timestamp is captured BEFORE the cache is cleared
        // and refilled, remoteTs < entry.filled for THIS session, so the
        // poller correctly skips our own freshly-saved data.
        // Other sessions still have their old entry.filled < remoteTs
        // and are correctly invalidated on their next poll.
        //
        // Moving stampDataChange after invalidateCache or after the cache
        // repopulation would break cross-session change detection.
        // ═══════════════════════════════════════════════════════════════
        stampDataChange(`database:getData:"${tableId}","${tabName}"`);
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
      * @param {string} [options.source] - Source system for history entries ('web' | 'cad')
     * @returns {Promise<boolean>} - Success status
     */
    static async updateRow(tableId, tabName, update, mapping = null, options = {}) {
          const { username = null, source = 'web' } = options;

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
                const metaEntry = EditHistoryUtils.createEditHistoryEntry(username, changes, source);
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
        stampDataChange(`database:getData:"${tableId}","${tabName}"`);
        invalidateCache([
            { namespace: 'database', methodName: 'getData', args: [tableId, tabName] }
        ], true);

        return true;
    }

    /**
     * Read a tab or an A1 range straight from the sheet, bypassing the cache.
     * Used by verified writes (read → write → re-read), which must see the live sheet.
     * NOT cached (listed with the mutation methods in wrapMethods below).
     * @param {string} tableId
     * @param {string} rangeOrTab - Tab name, or "Tab!A1:B2"
     * @returns {Promise<Array<Array<string>>>} raw 2D array
     */
    static async readFresh(tableId, rangeOrTab) {
        return await GoogleSheetsService.getSheetData(tableId, rangeOrTab);
    }

    /** 1-based column number → A1 column letters (1 → A, 27 → AA). */
    static columnLetter(columnNumber) {
        return _numberToColumnLetter(columnNumber);
    }

    /** A1 range on a tab, quoting the sheet name when needed: a1Range('Production Schedule', 'A5:Z5'). */
    static a1Range(tabName, ref) {
        return `${_quoteSheetName(tabName)}!${ref}`;
    }

    /**
     * Read several ranges of one table in a single uncached request (values.batchGet).
     * @param {string} tableId
     * @param {string[]} ranges - full A1 ranges (see a1Range)
     * @returns {Promise<Array<Array<Array<string>>>>} one 2D array per range
     */
    static async readFreshRanges(tableId, ranges) {
        return await GoogleSheetsService.batchGetValues(tableId, ranges);
    }

    /**
     * Write several single cells of one tab in a single request (values.batchUpdate), then
     * invalidate the tab's cached data once.
     * @param {string} tableId
     * @param {string} tabName
     * @param {Array<{ rowNumber: number, columnNumber: number, value: string }>} cells - 1-based
     * @returns {Promise<boolean>}
     */
    static async setCellValues(tableId, tabName, cells) {
        if (!cells || !cells.length) return true;
        const data = cells.map(c => {
            const col = _numberToColumnLetter(c.columnNumber);
            return { range: Database.a1Range(tabName, `${col}${c.rowNumber}:${col}${c.rowNumber}`), values: [[c.value ?? '']] };
        });
        await GoogleSheetsService.batchSetValues(tableId, data);

        stampDataChange(`database:getData:"${tableId}","${tabName}"`);
        invalidateCache([
            { namespace: 'database', methodName: 'getData', args: [tableId, tabName] }
        ], true);

        return true;
    }

    /**
     * Write a single cell value using A1 notation range.
     * This avoids full-table writes for high-concurrency updates.
     * @param {string} tableId - Identifier for the table
     * @param {string} tabName - Sheet/tab name
     * @param {number} rowNumber - 1-based row number
     * @param {number} columnNumber - 1-based column number
     * @param {string} value - Cell value
     * @returns {Promise<boolean>}
     */
    static async setCellValue(tableId, tabName, rowNumber, columnNumber, value) {
        const colLetter = _numberToColumnLetter(columnNumber);
        const range = Database.a1Range(tabName, `${colLetter}${rowNumber}:${colLetter}${rowNumber}`);

        await GoogleSheetsService.setSheetData(tableId, range, [[value ?? '']], null);

        stampDataChange(`database:getData:"${tableId}","${tabName}"`);
        invalidateCache([
            { namespace: 'database', methodName: 'getData', args: [tableId, tabName] }
        ], true);

        return true;
    }

    /**
     * Delete whole rows of one tab in a single request, then invalidate the tab's cached data.
     * Positional: callers check the rows just before and verify after (rows move under it).
     * @param {string} tableId
     * @param {string} tabName
     * @param {number[]} rowNumbers - 1-based sheet rows (the header row is never deleted)
     * @returns {Promise<boolean>}
     */
    static async deleteSheetRows(tableId, tabName, rowNumbers) {
        if (!rowNumbers || !rowNumbers.length) return true;
        await GoogleSheetsService.deleteSheetRows(tableId, tabName, rowNumbers);

        stampDataChange(`database:getData:"${tableId}","${tabName}"`);
        invalidateCache([
            { namespace: 'database', methodName: 'getData', args: [tableId, tabName] }
        ], true);

        return true;
    }

    /**
     * Append a single row to the end of a tab using a targeted range write.
     * @param {string} tableId - Identifier for the table
     * @param {string} tabName - Sheet/tab name
     * @param {Array<string>} values - Row values in column order
     * @returns {Promise<number>} 1-based row number that was appended
     */
    static async appendSheetRow(tableId, tabName, values) {
        const rawData = await GoogleSheetsService.getSheetData(tableId, tabName);
        const nextRow = (Array.isArray(rawData) ? rawData.length : 0) + 1;
        const endCol = _numberToColumnLetter(Math.max(values.length, 1));
        const range = `${tabName}!A${nextRow}:${endCol}${nextRow}`;

        await GoogleSheetsService.setSheetData(tableId, range, [values], null);

        stampDataChange(`database:getData:"${tableId}","${tabName}"`);
        invalidateCache([
            { namespace: 'database', methodName: 'getData', args: [tableId, tabName] }
        ], true);

        return nextRow;
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
        
        // Invalidate related caches, including the possible attempt to get data from this tab before it existed
        stampDataChange(`database:getTabs:"${tableId}"`);
        invalidateCache([
            { namespace: 'database', methodName: 'getTabs', args: [tableId] },
            { namespace: 'database', methodName: 'getData', args: [tableId, newTabName] }
        ]);
    }
}

// Wrap and export the class with caching, excluding mutation methods
export const Database = wrapMethods(
    database_uncached, 
    'database', 
    ['createTab', 'hideTabs', 'showTabs', 'setData', 'updateRow', 'setCellValue', 'setCellValues', 'deleteSheetRows', 'appendSheetRow', 'uploadItemImage', 'getDriveFileBlob', 'readFresh', 'readFreshRanges', 'columnLetter', 'a1Range'], // getDriveFileBlob: uncached read (callers own the Blob)
    ['getTabs'], // Infinite cache
    {
        // Sheet data: infinite for INVENTORY and PACK_LISTS (cross-session poller handles freshness);
        // 20-minute default for everything else (PROD_SCHED, CACHE, etc.)
        'getData': (args) => (args[0] === 'INVENTORY' || args[0] === 'PACK_LISTS') ? null : undefined
    }
);


/**
 * Add edithistory to rows that have changed
 * @private
 */
async function _addMetadataToRows(originalRows, updatedRows, username, mapping, source = 'web') {
    if (!Array.isArray(updatedRows)) {
        return updatedRows;
    }

    return updatedRows.map((updatedRow, index) => {
        const originalRow = originalRows[index];

        // Calculate changes for this row
        const changes = EditHistoryUtils.calculateRowDiff(originalRow, updatedRow);

        // If changes exist, append to edithistory
        if (changes.length > 0 && username) {
            const metaEntry = EditHistoryUtils.createEditHistoryEntry(username, changes, source);
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
            //console.log('EditHistory tab does not exist yet, will create');
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
            '_EditHistory',
            updatedMetadata,
            edithistoryMapping
        );

        //console.log(`Archived ${deletedRows.length} deleted rows to EditHistory table`);
    } catch (error) {
        console.error('Failed to archive deleted rows:', error);
        // Don't throw - archival failure shouldn't block the main save
    }
}

/**
 * Convert a 1-based column number to A1 notation column letter(s).
 * @private
 */
function _numberToColumnLetter(num) {
    let letter = '';
    let n = Number(num);
    while (n > 0) {
        const remainder = (n - 1) % 26;
        letter = String.fromCharCode(65 + remainder) + letter;
        n = Math.floor((n - 1) / 26);
    }
    return letter;
}

/**
 * Quote a sheet name for an A1 range when it holds anything but letters, digits and underscores
 * ("Production Schedule" → "'Production Schedule'"); quotes inside are doubled.
 * @private
 */
function _quoteSheetName(name) {
    const s = String(name);
    return /^[A-Za-z0-9_]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}
