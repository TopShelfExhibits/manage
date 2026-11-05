// Dynamic Google Sheets Service selection
import { isLocalhost, resolveSheetMapping } from '../utils/helpers.js';
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

import { wrapMethods, invalidateCache, stampDataChange, EditHistoryUtils, assertAppCurrent } from '../index.js';
import { ARCHIVE_TAB_NAME, ARCHIVE_HEADERS } from '../utils/metadata-utils.js';

class database_uncached {
    /**
     * Retrieves data for a table/tab and returns as array of JS objects
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table (INVENTORY, PACK_LISTS, etc.)
     * @param {string} tabName - Tab name or logical identifier
     * @param {Object} [mapping] - Optional mapping for object keys to sheet headers. A
     *   column-preserving mapping (`_preserveColumns`, see resolveSheetMapping) reads only the
     *   columns the tab actually has (an absent optional column gives rows without that key).
     * @returns {Promise<Array<Object>>} - Array of JS objects
     */
    static async getData(deps, tableId, tabName, mapping = null) {
        // One sheet read per tab: a mapped read transforms the tab's unmapped read, cached under the
        // key prefix the tab's writes and the poller invalidate
        const rawData = mapping
            ? await deps.call(Database.getData, tableId, tabName)
            : await GoogleSheetsService.getSheetData(tableId, tabName);
        if (mapping?._preserveColumns) {
            mapping = resolveSheetMapping(mapping, rawData?.[0]).read;
        }
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
     * Upload an item image to the Drive thumbnails folder. Only uploads: the caller puts the
     * returned file ID in the item's Thumbnail cell, and the table's save keeps it.
     *
     * Files are never deleted here: edit history and unsaved edits may still point at older
     * ones. An image already uploaded (same original bytes, matched by the sha256 app property
     * set on upload) is reused instead of uploaded again.
     * MUTATION — not cached.
     * @param {File} file - The image file to upload
     * @param {string} itemNumber - Item number, used in the file name
     * @param {string} folderId - Google Drive folder ID for thumbnails
     * @returns {Promise<{fileId: string, file: File, reused: boolean}|null>} The Drive file ID and
     *   the image as uploaded (already resized — lets the caller show it without downloading it
     *   back), or null on failure
     */
    static async uploadItemImage(file, itemNumber, folderId = window.ENDPOINT_IDS.THUMBNAILS) {
        await assertAppCurrent();
        const itemNumberStr = String(itemNumber).trim();
        const ext = file.type === 'image/png' ? 'png' : 'jpg';

        // Resize to max 512px before uploading. If the image is already within bounds,
        // resizedFile === file (no copy made). If larger, the original is kept as a backup.
        const MAX_UPLOAD_DIM = 512;
        const resizedFile = await database_uncached._resizeImageFile(file, MAX_UPLOAD_DIM);
        const wasResized = resizedFile !== file;

        // Deduplicate by the original's content hash (resizing isn't byte-stable across browsers)
        const sha256 = await database_uncached._sha256Hex(file);
        if (sha256) {
            const existing = await GoogleSheetsService.findDriveFileByAppProperty(folderId, 'sha256', sha256);
            if (existing?.id) return { fileId: existing.id, file: resizedFile, reused: true };
        }

        // A unique name per upload: older files stay valid for history and other sessions
        const baseName = `${itemNumberStr}_${Date.now()}`;
        if (wasResized) {
            await GoogleSheetsService.uploadDriveFile(file, `${baseName}_ORIGINAL.${ext}`, folderId)
                .catch(err => console.warn('[icons] Failed to save original image backup:', err));
        }
        const uploaded = await GoogleSheetsService.uploadDriveFile(resizedFile, `${baseName}.${ext}`, folderId, sha256 ? { sha256 } : null);
        if (!uploaded || !uploaded.id) return null;
        return { fileId: uploaded.id, file: resizedFile, reused: false };
    }

    /** SHA-256 of a file's bytes as hex, or null where Web Crypto is unavailable. */
    static async _sha256Hex(file) {
        try {
            const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
            return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        } catch {
            return null;
        }
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
    // Every write (uploadItemImage too) starts with assertAppCurrent(): a session running an
    // out-of-date version (a newer deploy is live) never writes shared data. Only the session's own
    // bookkeeping (user data, short links) passes `bookkeeping: true` to setData and createTab.


    /**
     * Updates data for a table/tab using JS objects
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table
     * @param {string} tabName - Tab name or logical identifier
     * @param {Array<Object>} updates - Array of JS objects to save
     * @param {Object} [mapping] - Optional mapping for object keys to sheet headers
     * @param {Object} [options] - Optional parameters for edithistory tracking
     * @param {boolean} [options.bookkeeping] - The session's own bookkeeping (user data, short links):
     *   allowed while the app is out of date (assertAppCurrent)
     * @param {string} [options.username] - Username making the change
     * @param {boolean} [options.skipMetadata] - Skip edithistory generation (caller manages EditHistory itself)
     * @param {string} [options.source] - Source for history entries ('web' | 'cad', or an inventory note)
     * @returns {Promise<boolean>} - Success status
     */
    static async setData(tableId, tabName, updates, mapping = null, options = {}) {
        if (!options.bookkeeping) await assertAppCurrent();
        const {
            username = null,
            skipMetadata = false,
            source = 'web'
        } = options;

        let updatesWithMetadata = updates;
        let deletedRows = [];

        // Add edithistory tracking if not skipped
        // Contract: docs/notes/metadata-implementation.md
        if (!skipMetadata && mapping && mapping.edithistory && Array.isArray(updates)) {
            try {
                // Get original data for comparison (use Database.getData to leverage cache)
                const transformedOriginal = await Database.getData(tableId, tabName, mapping);

                // Match rows by EditHistory.i, assign missing identities, append history
                const result = _addMetadataToRows(transformedOriginal, updates, username, source);
                updatesWithMetadata = result.rows;
                deletedRows = result.deletedRows;
            } catch (error) {
                console.warn('Failed to add edithistory, continuing with save:', error);
                // Continue with save even if edithistory fails
            }
        }

        // A column-preserving mapping writes under the live sheet's headers (read fresh: a column
        // added or moved since this tab was loaded must not be overwritten)
        const writeMapping = mapping?._preserveColumns
            ? resolveSheetMapping(mapping, (await GoogleSheetsService.getSheetData(tableId, tabName))?.[0]).write
            : mapping;
        const result = await GoogleSheetsService.setSheetData(tableId, tabName, updatesWithMetadata, writeMapping);
        
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

        // Archive only after the main write succeeded
        if (deletedRows.length > 0) {
            await _archiveDeletedRows(tableId, tabName, deletedRows, username);
        }

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
        await assertAppCurrent();
          const { username = null, source = 'web' } = options;

        const existingData = await GoogleSheetsService.getSheetData(tableId, tabName);

        // A column-preserving mapping reads and writes only the columns it owns (resolveSheetMapping)
        let writeMapping = mapping;
        if (mapping?._preserveColumns) {
            ({ read: mapping, write: writeMapping } = resolveSheetMapping(mapping, existingData?.[0]));
        }

        const transformedData = mapping
            ? GoogleSheetsService.transformSheetData(existingData, mapping, tabName)
            : GoogleSheetsService.sheetArrayToObjects(existingData);

        // Prefer row identity (EditHistory.i); fall back to the legacy key guess for rows not yet touched
        const updateIdentity = EditHistoryUtils.getRowIndex(update.edithistory);
        let rowIndex = updateIdentity !== null
            ? transformedData.findIndex(row => EditHistoryUtils.getRowIndex(row.edithistory) === updateIdentity)
            : -1;
        if (rowIndex === -1) {
            rowIndex = transformedData.findIndex(row => {
                const identifierKey = mapping ? Object.keys(mapping).find(k => k.includes('Number') || k.includes('Id')) : 'id';
                const updateKey = Object.keys(update).find(k => k.includes('Number') || k.includes('Id')) || Object.keys(update)[0];
                return row[identifierKey] === update[updateKey];
            });
        }

        if (rowIndex === -1) {
            throw new Error(`Row with identifier not found in tab ${tabName}`);
        }

        const originalRow = transformedData[rowIndex];

        // Calculate changes and add edithistory if mapping includes it
        let updatedRow = { ...originalRow, ...update };
        if (mapping && mapping.edithistory) {
            const edithistory = { ...(EditHistoryUtils.parseEditHistory(originalRow.edithistory) || {}) };
            if (EditHistoryUtils.getRowIndex(edithistory) === null) {
                edithistory.i = EditHistoryUtils.nextRowIndex([transformedData]);
            }
            const changes = EditHistoryUtils.calculateRowDiff(originalRow, updatedRow);
            if (changes.length > 0 && username) {
                const metaEntry = EditHistoryUtils.createEditHistoryEntry(username, changes, source);
                EditHistoryUtils._addEntry(edithistory, metaEntry, undefined, updatedRow);
            }
            updatedRow.edithistory = JSON.stringify(edithistory);
        }

        // Update the transformed row
        transformedData[rowIndex] = updatedRow;

        // Convert back to sheet format for saving
        const updatedSheetData = mapping
            ? GoogleSheetsService.reverseTransformSheetData(writeMapping, transformedData)
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
        await assertAppCurrent();
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
        await assertAppCurrent();
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
        await assertAppCurrent();
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
        await assertAppCurrent();
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
        await assertAppCurrent();
        await GoogleSheetsService.hideTabs(tableId, tabs);
    }
    
    /**
     * Shows specified logical tabs in a table
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table
     * @param {Array<{title: string, sheetId: number}>} tabs - Tabs to show
     */
    static async showTabs(tableId, tabs) {
        await assertAppCurrent();
        await GoogleSheetsService.showTabs(tableId, tabs);
    }
    
    /**
     * Creates a new logical tab by copying a template or creating blank
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} tableId - Identifier for the table
     * @param {{title: string, sheetId: number}|null} templateTab - Template tab to copy (null for blank tab)
     * @param {string} newTabName - Name for the new tab
     * @param {{bookkeeping?: boolean}} [options] - bookkeeping: as in setData
     * @returns {Promise<void>}
     */
    static async createTab(tableId, templateTab, newTabName, options = {}) {
        if (!options.bookkeeping) await assertAppCurrent();
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
 * Match incoming rows to stored rows by EditHistory.i, assign missing identities,
 * and append history entries for changed rows.
 * Contract: docs/notes/metadata-implementation.md "Row Identity" and "Write Rules".
 * @private
 * @returns {{ rows: Array<Object>, deletedRows: Array<{identifier: string, rowData: Object}> }}
 */
function _addMetadataToRows(originalRows, updatedRows, username, source = 'web') {
    const originals = Array.isArray(originalRows) ? originalRows : [];
    const { matchOf, duplicates, deleted } = EditHistoryUtils.matchRows(originals, updatedRows);
    let nextIndex = EditHistoryUtils.nextRowIndex([originals, updatedRows]);
    const creationHistory = () => username ? [EditHistoryUtils.createEditHistoryEntry(username, [], source)] : [];

    const rows = updatedRows.map((updatedRow, u) => {
        const o = matchOf[u];

        if (o !== -1) {
            // Existing row: stored history is authoritative, the incoming copy may be stale
            const originalRow = originals[o];
            const edithistory = {
                ...(EditHistoryUtils.parseEditHistory(originalRow.edithistory)
                    || EditHistoryUtils.parseEditHistory(updatedRow.edithistory)
                    || {})
            };
            if (EditHistoryUtils.getRowIndex(edithistory) === null) {
                edithistory.i = nextIndex++;
            }
            const changes = EditHistoryUtils.calculateRowDiff(originalRow, updatedRow);
            if (changes.length > 0 && username) {
                const entry = EditHistoryUtils.createEditHistoryEntry(username, changes, source);
                EditHistoryUtils._addEntry(edithistory, entry, undefined, updatedRow);
            }
            return { ...updatedRow, edithistory: JSON.stringify(edithistory) };
        }

        if (duplicates.has(u)) {
            // Copy of another row: new identity, history restarts (copied h and p are dropped)
            return { ...updatedRow, edithistory: JSON.stringify({ i: nextIndex++, h: creationHistory() }) };
        }

        const edithistory = { ...(EditHistoryUtils.parseEditHistory(updatedRow.edithistory) || {}) };
        if (EditHistoryUtils.getRowIndex(edithistory) !== null) {
            // Carries an identity not stored in this tab (moved in from elsewhere): keep as-is
            return updatedRow;
        }
        edithistory.i = nextIndex++;
        if (!Array.isArray(edithistory.h) || edithistory.h.length === 0) {
            edithistory.h = creationHistory();
        }
        return { ...updatedRow, edithistory: JSON.stringify(edithistory) };
    });

    const deletedRows = deleted
        .filter(o => !EditHistoryUtils.isBlankRow(originals[o]))
        .map(o => ({
            identifier: String(EditHistoryUtils.getRowIndex(originals[o].edithistory) ?? `row_${o + 1}`),
            rowData: originals[o]
        }));

    return { rows, deletedRows };
}


/**
 * Append deleted rows to the _EditHistory tab of the same spreadsheet.
 * Existing archive rows are never rewritten.
 * @private
 */
async function _archiveDeletedRows(sourceTable, sourceTab, deletedRows, username) {
    try {
        const tabs = await Database.getTabs(sourceTable);
        if (!tabs.some(tab => tab.title === ARCHIVE_TAB_NAME)) {
            await Database.createTab(sourceTable, null, ARCHIVE_TAB_NAME);
        }

        // Use the tab's own header order; write headers if the tab is new or unrecognized
        const rawData = await GoogleSheetsService.getSheetData(sourceTable, ARCHIVE_TAB_NAME);
        let headers = (rawData?.[0] || []).map(h => String(h ?? '').trim());
        if (!ARCHIVE_HEADERS.every(h => headers.includes(h))) {
            headers = ARCHIVE_HEADERS;
            const endCol = _numberToColumnLetter(headers.length);
            await GoogleSheetsService.setSheetData(sourceTable, `${ARCHIVE_TAB_NAME}!A1:${endCol}1`, [headers], null);
        }

        for (const deleted of deletedRows) {
            const entry = EditHistoryUtils.createArchiveEntry(
                sourceTable,
                sourceTab,
                deleted.identifier,
                deleted.rowData,
                username
            );
            await Database.appendSheetRow(sourceTable, ARCHIVE_TAB_NAME, headers.map(h => entry[h] ?? ''));
        }
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
