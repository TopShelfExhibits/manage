import { GoogleSheetsAuth } from './GoogleSheetsAuth.js';
import { SheetSql } from './sheetSql.js';
import { normalizeHeaderName } from '../data_management/utils/helpers.js';
import { ProgressBus } from '../data_management/utils/caching.js';
import { isGridLimitError, gridNeeded, clipRangeToGrid, parseA1Range } from './gridRanges.js';

export class GoogleSheetsService {

    // Rate limit testing flag
    static _simulateRateLimit = false;
    
    // Rate limit countdown guards - prevent multiple timers from running concurrently
    static _rateLimitCountdownActive = false;
    static _rateLimitCountdownPromise = null;
    
    static _throwAuthError() {
        const err = new Error('Authentication required');
        err.status = 401;
        err.result = { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Authentication required' } };
        throw err;
    }

    /**
     * Throws a simulated 429 rate limit error matching the real Google Sheets API response
     * @private
     */
    static _throwRateLimitError() {
        const error = new Error("Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user' of service 'sheets.googleapis.com' for consumer 'project_number:381868581846'.");
        error.status = 429;
        error.result = {
            error: {
                code: 429,
                message: "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user' of service 'sheets.googleapis.com' for consumer 'project_number:381868581846'.",
                status: "RESOURCE_EXHAUSTED",
                details: [
                    {
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        reason: "RATE_LIMIT_EXCEEDED",
                        domain: "googleapis.com",
                        metadata: {
                            quota_limit_value: "60",
                            service: "sheets.googleapis.com",
                            quota_unit: "1/min/{project}/{user}",
                            quota_limit: "ReadRequestsPerMinutePerUser",
                            consumer: "projects/381868581846",
                            quota_metric: "sheets.googleapis.com/read_requests",
                            quota_location: "global"
                        }
                    },
                    {
                        "@type": "type.googleapis.com/google.rpc.Help",
                        links: [
                            {
                                description: "Request a higher quota limit.",
                                url: "https://cloud.google.com/docs/quotas/help/request_increase"
                            }
                        ]
                    }
                ]
            }
        };
        throw error;
    }

    // Exponential backoff helper for Google Sheets API calls
    static async withExponentialBackoff(fn, maxRetries = 5, initialDelay = 500) {
        let attempt = 0;
        let delay = initialDelay;
        let lastError = null;
        let consecutiveRateLimits = 0;
        
        // Check if rate limit simulation is enabled
        if (GoogleSheetsService._simulateRateLimit) {
            console.warn('[GoogleSheetsService] 🚨 SIMULATING RATE LIMIT ERROR (429)');
            this._throwRateLimitError();
        }
        
        while (true) {
            try {
                return await fn();
            } catch (err) {
                // Immediately throw grid limit errors: the range calls grow or clip to the grid (gridRanges.js)
                if (isGridLimitError(err)) throw err;
                
                // Immediately throw auth errors — retrying won't help; the Auth layer handles re-auth
                const isAuthError = err && (
                    err.status === 401 ||
                    (err.result?.error?.code === 401) ||
                    err.result?.error?.status === 'UNAUTHENTICATED' ||
                    err.result?.error?.status === 'PERMISSION_DENIED' ||
                    err.result?.error?.message?.toLowerCase().includes('insufficient authentication') ||
                    err.result?.error?.message?.toLowerCase().includes('insufficient auth')
                );
                if (isAuthError) throw err;

                // Immediately throw network-level errors (no HTTP response) — no point retrying
                // when the device has no connectivity. The window 'offline' event sets the freeze state.
                const isNetworkError = err instanceof TypeError && !err.status && !err.result;
                if (isNetworkError) throw err;
                
                // Check for rate limit or quota errors (429, or 403 quota exhausted only)
                const isRateLimit = err && (
                    err.status === 429 ||
                    (err.result && err.result.error && (
                        err.result.error.status === 'RESOURCE_EXHAUSTED' ||
                        err.result.error.message?.toLowerCase().includes('rate limit') ||
                        err.result.error.message?.toLowerCase().includes('quota')
                    ))
                );
                
                if (isRateLimit) {
                    consecutiveRateLimits++;
                    // For rate limits, use much longer delays and more retries
                    // Google Sheets quota resets after 1 minute, so we need to wait
                    const rateLimitMaxRetries = 15; // Allow up to 15 retries for rate limits
                    const rateLimitDelay = Math.min(5000 * Math.pow(1.5, consecutiveRateLimits), 30000); // 5s, 7.5s, 11.25s... max 30s
                    
                    if (consecutiveRateLimits >= rateLimitMaxRetries) {
                        console.error('[GoogleSheetsService] Rate limit exceeded after maximum retries');
                        throw err;
                    }
                    
                    // Guard against multiple concurrent rate limit countdowns
                    // If a countdown is already running, just wait for it to finish
                    if (GoogleSheetsService._rateLimitCountdownActive) {
                        // Another call is already showing the countdown - just wait for it
                        await GoogleSheetsService._rateLimitCountdownPromise;
                    } else {
                        // This is the first call to hit rate limit - run the countdown
                        GoogleSheetsService._rateLimitCountdownActive = true;
                        GoogleSheetsService._rateLimitCountdownPromise = (async () => {
                            try {
                                // Emit countdown updates on system-level topic so all loading indicators show it
                                const delaySeconds = Math.ceil(rateLimitDelay / 1000);
                                for (let remaining = delaySeconds; remaining > 0; remaining--) {
                                    ProgressBus.emit('system:rateLimit', {
                                        current: delaySeconds - remaining,
                                        total: delaySeconds,
                                        message: `Waiting on Google resources... ${remaining}s`
                                    });
                                    await new Promise(res => setTimeout(res, 1000));
                                }
                                
                                // Clear the rate limit message
                                ProgressBus.emit('system:rateLimit', {
                                    current: delaySeconds,
                                    total: delaySeconds,
                                    message: null
                                });
                            } finally {
                                // Release the guard so future rate limits can run their own countdown
                                GoogleSheetsService._rateLimitCountdownActive = false;
                                GoogleSheetsService._rateLimitCountdownPromise = null;
                            }
                        })();
                        
                        // Wait for the countdown to finish before retrying
                        await GoogleSheetsService._rateLimitCountdownPromise;
                    }
                    
                    continue; // Retry without incrementing main attempt counter
                }
                
                // For non-rate-limit errors, use standard exponential backoff
                if (attempt >= maxRetries) throw err;
                
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
                attempt++;
                lastError = err;
            }
        }
    }

    /**
     * Get sheet data and return as raw 2D array (matches FakeGoogle interface)
     * @param {string} tableId
     * @param {string} range - Range including sheet name (e.g., "FURNITURE!" or "INDEX!A1:Z100")
     * @returns {Promise<Array<Array<string>>>}
     */
    static async getSheetData(tableId, range) {
        //console.warn(`[GoogleSheets READ] ${tableId} → ${range}`);
        
        await GoogleSheetsAuth.checkAuth();
        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[GoogleSheetsData.getSheetData] SPREADSHEET_NOT_FOUND: Spreadsheet ID not found for table: ${tableId}`);

        // Errors bubble up to the reactive store
        const [rawData] = await GoogleSheetsService._readRanges(spreadsheetId, [range]);
        return rawData;
    }

    /**
     * values.batchGet: read several ranges in one request.
     * @param {string} tableId
     * @param {string[]} ranges - A1 ranges including the sheet name
     * @returns {Promise<Array<Array<Array<string>>>>} one 2D array per range, in order ([[]] when empty)
     */
    static async batchGetValues(tableId, ranges) {
        await GoogleSheetsAuth.checkAuth();
        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[GoogleSheetsData.batchGetValues] SPREADSHEET_NOT_FOUND: Spreadsheet ID not found for table: ${tableId}`);
        if (!ranges || !ranges.length) return [];
        return await GoogleSheetsService._readRanges(spreadsheetId, ranges);
    }

    /**
     * values.batchUpdate: write several ranges in one request (same value input as setSheetData).
     * Only the given ranges change; nothing is truncated.
     * @param {string} tableId
     * @param {Array<{ range: string, values: Array<Array<string>> }>} data
     * @param {{raw?: boolean}} [options] - raw: store the strings as they are (valueInputOption RAW)
     * @returns {Promise<boolean>}
     */
    static async batchSetValues(tableId, data, options = {}) {
        if (!(await GoogleSheetsAuth.checkAuth())) GoogleSheetsService._throwAuthError();
        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[GoogleSheetsData.batchSetValues] SPREADSHEET_NOT_FOUND: Spreadsheet ID not found for table: ${tableId}`);
        if (!data || !data.length) return true;
        await GoogleSheetsService._writeGrowingGrid(spreadsheetId, gridNeeded(data.map(d => d.range)), () =>
            gapi.client.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId,
                resource: { valueInputOption: options.raw ? 'RAW' : 'USER_ENTERED', data }
            })
        );
        return true;
    }

    /**
     * values.append: add rows below the last row of the table in the range ("Caching!A:B"), as
     * one request. Two sessions appending at once each get their own rows (no row is computed
     * from an earlier read). Strings are stored as they are (RAW).
     * @param {string} tableId
     * @param {string} range - A1 range of the table's columns
     * @param {Array<Array<string>>} rows
     * @returns {Promise<boolean>}
     */
    static async appendSheetValues(tableId, range, rows) {
        if (!(await GoogleSheetsAuth.checkAuth())) GoogleSheetsService._throwAuthError();
        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[GoogleSheetsData.appendSheetValues] SPREADSHEET_NOT_FOUND: Spreadsheet ID not found for table: ${tableId}`);
        if (!rows || !rows.length) return true;
        await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId,
                range,
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                resource: { values: rows }
            })
        );
        return true;
    }

    /**
     * Delete whole rows of one tab in a single request (bottom up, so the numbers stay valid).
     * @param {string} tableId
     * @param {string} tabName
     * @param {number[]} rowNumbers - 1-based sheet rows
     * @returns {Promise<boolean>}
     */
    static async deleteSheetRows(tableId, tabName, rowNumbers) {
        if (!(await GoogleSheetsAuth.checkAuth())) GoogleSheetsService._throwAuthError();
        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[GoogleSheetsData.deleteSheetRows] SPREADSHEET_NOT_FOUND: Spreadsheet ID not found for table: ${tableId}`);
        const rows = [...new Set((rowNumbers || []).map(Number).filter(n => Number.isInteger(n) && n > 1))].sort((a, b) => b - a);
        if (!rows.length) return true;
        const info = await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.get({ spreadsheetId, includeGridData: false })
        );
        const sheet = (info.result?.sheets || []).find(s => s.properties.title === tabName);
        if (!sheet) throw new Error(`[GoogleSheetsData.deleteSheetRows] SHEET_NOT_FOUND: ${tabName}`);
        const requests = rows.map(n => ({
            deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: n - 1, endIndex: n } }
        }));
        await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } })
        );
        return true;
    }

    /**
     * Set sheet data from array of JS objects
     * @param {string} tableId
     * @param {string} tabName
     * @param {Array<Object>} updates - Array of JS objects to save
     * @param {Object} [mapping] - Optional mapping for object keys to sheet headers
     * @param {{returnValues?: boolean}} [options] - returnValues (whole-tab writes): return the tab
     *   as a read would return it right after the write, taken from the write's own response
     *   (includeValuesInResponse: formatted values, formulas computed), instead of true
     * @returns {Promise<boolean|Array<Array<string>>>}
     */
    static async setSheetData(tableId, tabName, updates, mapping = null, options = {}) {
        if (!(await GoogleSheetsAuth.checkAuth())) GoogleSheetsService._throwAuthError();
        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[GoogleSheetsData.setSheetData] SPREADSHEET_NOT_FOUND: Spreadsheet ID not found for table: ${tableId}`);
        
        // Convert JS objects to sheet format
        let values;
        if (Array.isArray(updates) && updates.length > 0 && Array.isArray(updates[0])) {
            // Already in 2D array format (e.g., [['Header1', 'Header2']])
            values = updates;
        } else if (Array.isArray(updates) && updates.length > 0) {
            // If mapping is provided, use reverse transform to get proper sheet format
            if (mapping) {
                values = this.reverseTransformSheetData(mapping, updates);
            } else {
                const headers = Object.keys(updates[0]);
                values = [headers, ...updates.map(obj => headers.map(h => obj[h] ?? ''))];
            }
        } else if (Array.isArray(updates) && updates.length === 0 && mapping) {
            // Empty array with mapping provided - create headers-only sheet
            const headers = mapping._orderedHeaders || Object.values(mapping).filter(v => v !== mapping._orderedHeaders);
            values = [mapping._orderedKeys ? headers.map((h, i) => mapping._orderedKeys[i] ? h : null) : headers];
        } else {
            throw new Error('[GoogleSheetsData.setSheetData] VALIDATION_ERROR: No valid updates provided');
        }
        // Setup range
        const range = `${tabName}`;
        // The requested range is the whole tab: the response holds every value in it
        const includeValuesInResponse = !!options.returnValues && !range.includes('!');

        // A range outside the grid grows it (a whole-tab write needs its rows and widest row)
        const needs = range.includes('!')
            ? gridNeeded([range])
            : new Map([[tabName, { rows: values.length, cols: Math.max(0, ...values.map(row => row.length)) }]]);
        const response = await GoogleSheetsService._writeGrowingGrid(spreadsheetId, needs, () =>
            gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED',
                includeValuesInResponse,
                resource: { values }
            })
        );
        // A range write ("Tab!A5:B5") leaves the rest of the tab as it is: nothing to truncate, and
        // the lookup below would cost a read request
        if (range.includes('!')) return true;

        // Truncate any rows below the new data
        // Get current sheet row count
        const sheetInfo = await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.get({
                spreadsheetId,
                ranges: [tabName],
                includeGridData: false
            })
        );
        const sheet = sheetInfo.result.sheets.find(s => s.properties.title === tabName);
        if (sheet) {
            const sheetRowCount = sheet.properties.gridProperties.rowCount;
            const newRowCount = values.length;
            if (sheetRowCount > newRowCount) {
                await GoogleSheetsService.withExponentialBackoff(() =>
                    gapi.client.sheets.spreadsheets.batchUpdate({
                        spreadsheetId,
                        resource: {
                            requests: [{
                                deleteDimension: {
                                    range: {
                                        sheetId: sheet.properties.sheetId,
                                        dimension: 'ROWS',
                                        startIndex: newRowCount,
                                        endIndex: sheetRowCount
                                    }
                                }
                            }]
                        }
                    })
                );
            }
        }
        if (!includeValuesInResponse) return true;
        // The rows below the written ones were just deleted. A read omits trailing empty cells and
        // rows, and returns [[]] for an empty tab.
        const tab = (response?.result?.updatedData?.values || []).slice(0, values.length).map(row => {
            const cells = Array.isArray(row) ? row.map(cell => cell ?? '') : [];
            while (cells.length && cells[cells.length - 1] === '') cells.pop();
            return cells;
        });
        while (tab.length && !tab[tab.length - 1].length) tab.pop();
        return tab.length ? tab : [[]];
    }
    /**
     * Transform raw sheet data to JS objects using mapping
     */
    static transformSheetData(rawData, mapping, sheetName = null) {
        if (!rawData || rawData.length < 2 || !mapping) return [];
        
        // Normalize headers to remove carriage returns and extra whitespace from Google Sheets
        const headers = Array.isArray(rawData[0]) 
            ? rawData[0].map(h => normalizeHeaderName(h))
            : [];
        if (headers.length === 0) {
            console.error('GoogleSheetsService.transformSheetData: headers is not an array or empty', headers, rawData);
            return [];
        }
        const rows = rawData.slice(1);
        const headerIdxMap = {};
        Object.entries(mapping).forEach(([key, headerName]) => {
            // Skip _orderedHeaders metadata property (used only for reverseTransformSheetData)
            if (key === '_orderedHeaders') return;
            
            const normalizedHeaderName = normalizeHeaderName(headerName);
            const idx = headers.findIndex(h => h === normalizedHeaderName);
            if (idx === -1) {
                console.warn(`GoogleSheetsService.transformSheetData: header '${normalizedHeaderName}' not found in sheet headers`, headers);
            }
            if (idx !== -1) headerIdxMap[key] = idx;
        });
        return rows.map(row => {
            const obj = {};
            Object.keys(mapping).forEach(key => {
                obj[key] = (Array.isArray(row) && headerIdxMap[key] !== undefined && row[headerIdxMap[key]] !== undefined)
                    ? String(row[headerIdxMap[key]])
                    : '';
            });
            return obj;
        }).filter(obj => Object.values(obj).some(val => val !== ''));
    }

    /**
     * Reverse transform JS objects to sheet data using mapping.
     * With `_orderedKeys` (a column-preserving mapping, see resolveSheetMapping) values are placed
     * by position and columns the mapping doesn't own are null, which the Sheets API skips on
     * write, leaving those cells (and their formulas) as they are.
     */
    static reverseTransformSheetData(mapping, mappedData) {
        if (!mappedData || mappedData.length === 0) return [];
        if (mapping._orderedKeys) {
            const keys = mapping._orderedKeys;
            const headerRow = mapping._orderedHeaders.map((h, i) => keys[i] ? h : null);
            return [headerRow, ...mappedData.map(obj => keys.map(key => key ? (obj[key] ?? '') : null))];
        }

        // Use _orderedHeaders if provided (to preserve column order), otherwise fall back to Object.values
        const headers = mapping._orderedHeaders || Object.values(mapping).filter(v => v !== mapping._orderedHeaders);
        
        const rows = mappedData.map(obj => headers.map(h => {
            const key = Object.keys(mapping).find(k => mapping[k] === h);
            return key ? obj[key] ?? '' : '';
        }));
        return [headers, ...rows];
    }
    
    /**
     * Each sheet's grid: title → { sheetId, rows, cols }. @private
     */
    static async _gridSizes(spreadsheetId) {
        const info = await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.get({ spreadsheetId, includeGridData: false })
        );
        return new Map((info.result?.sheets || []).map(sheet => [sheet.properties.title, {
            sheetId: sheet.properties.sheetId,
            rows: sheet.properties.gridProperties?.rowCount || 0,
            cols: sheet.properties.gridProperties?.columnCount || 0
        }]));
    }

    /**
     * Grow sheets to at least the rows and columns they need (gridNeeded), in one request. Rows
     * grow with 10 to spare, so the next appended rows fit. @private
     */
    static async _ensureGrid(spreadsheetId, needs) {
        const sizes = await GoogleSheetsService._gridSizes(spreadsheetId);
        const requests = [];
        for (const [sheet, need] of needs) {
            const size = sizes.get(sheet);
            if (!size) continue;
            if (need.rows > size.rows) {
                requests.push({ appendDimension: { sheetId: size.sheetId, dimension: 'ROWS', length: need.rows - size.rows + 10 } });
            }
            if (need.cols > size.cols) {
                requests.push({ appendDimension: { sheetId: size.sheetId, dimension: 'COLUMNS', length: need.cols - size.cols } });
            }
        }
        if (!requests.length) return;
        await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } })
        );
    }

    /**
     * Every range write goes through here: when a range is outside its sheet's grid, the grid
     * grows to the needs (gridNeeded) and the write runs once more. @private
     * @returns {Promise<*>} the write's response
     */
    static async _writeGrowingGrid(spreadsheetId, needs, write) {
        try {
            return await GoogleSheetsService.withExponentialBackoff(write);
        } catch (error) {
            if (!isGridLimitError(error)) throw error;
            await GoogleSheetsService._ensureGrid(spreadsheetId, needs);
            return await GoogleSheetsService.withExponentialBackoff(write);
        }
    }

    /**
     * Every range read goes through here (values.batchGet): one 2D array per range, [[]] when
     * empty. A range outside its sheet's grid is clipped to the grid, so cells past it read as
     * empty, as empty cells inside it do. @private
     */
    static async _readRanges(spreadsheetId, ranges) {
        const read = async (list) => {
            const response = await GoogleSheetsService.withExponentialBackoff(() =>
                gapi.client.sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges: list })
            );
            const valueRanges = response.result?.valueRanges || [];
            return list.map((_, i) => {
                const values = valueRanges[i]?.values;
                return Array.isArray(values) && values.length ? values : [[]];
            });
        };
        try {
            return await read(ranges);
        } catch (error) {
            if (!isGridLimitError(error)) throw error;
            const sizes = await GoogleSheetsService._gridSizes(spreadsheetId);
            const clipped = ranges.map(range => {
                const size = sizes.get(parseA1Range(range).sheet);
                return size ? clipRangeToGrid(range, size.rows, size.cols) : range;
            });
            const inside = clipped.filter(Boolean);
            const values = inside.length ? await read(inside) : [];
            let k = 0;
            return clipped.map(range => range ? values[k++] : [[]]);
        }
    }


    /**     
     * Retrieves the list of sheet tabs in a spreadsheet.
     * @param {string} tableId - The identifier for the table (e.g., 'INVENTORY').
     * @returns {Promise<Array<{title: string, sheetId: number}>>} - A promise that resolves to an array of objects with tab names and ids.
     */
    static async getSheetTabs(tableId) {
        await GoogleSheetsAuth.checkAuth();

        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[getSheetTabs] Spreadsheet ID not found for table: ${tableId}`);
        
        const response = await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.get({
                spreadsheetId
            })
        );

        // Return array of { title, sheetId }
        const tabs = response.result.sheets.map(sheet => ({
            title: sheet.properties.title,
            sheetId: sheet.properties.sheetId
        }));
        return tabs;
    }

    /**
     * Hides the specified tabs in the spreadsheet.
     * @param {string} tableId
     * @param {Array<{title: string, sheetId: number}>} tabs
     * @returns {Promise<void>}
     */
    static async hideTabs(tableId, tabs) {
        if (!(await GoogleSheetsAuth.checkAuth())) GoogleSheetsService._throwAuthError();

        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[hideTabs] Spreadsheet ID not found for table: ${tableId}`);

        // Use provided sheetId and title pairs
        const requests = tabs.map(tab => ({
            updateSheetProperties: {
                properties: { sheetId: tab.sheetId, hidden: true },
                fields: 'hidden'
            }
        }));

        if (requests.length > 0) {
            await GoogleSheetsService.withExponentialBackoff(() =>
                gapi.client.sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    resource: { requests }
                })
            );
        }
    }

    /**
     * Shows the specified tabs in the spreadsheet.
     * @param {string} tableId
     * @param {Array<{title: string, sheetId: number}>} tabs
     * @returns {Promise<void>}
     */
    static async showTabs(tableId, tabs) {
        if (!(await GoogleSheetsAuth.checkAuth())) GoogleSheetsService._throwAuthError();

        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[showTabs] Spreadsheet ID not found for table: ${tableId}`);

        // Use provided sheetId and title pairs
        const requests = tabs.map(tab => ({
            updateSheetProperties: {
                properties: { sheetId: tab.sheetId, hidden: false },
                fields: 'hidden'
            }
        }));

        if (requests.length > 0) {
            await GoogleSheetsService.withExponentialBackoff(() =>
                gapi.client.sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    resource: { requests }
                })
            );
        }
    }

    /**
     * Copy a sheet tab within a spreadsheet (e.g., to create a new tab from _TEMPLATE).
     * @param {string} tableId
     * @param {{title: string, sheetId: number}} sourceTab
     * @param {string} newTabName
     * @returns {Promise<void>}
     */
    static async copySheetTab(tableId, sourceTab, newTabName) {
        if (!(await GoogleSheetsAuth.checkAuth())) GoogleSheetsService._throwAuthError();

        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[copySheetTab] Spreadsheet ID not found for table: ${tableId}`);

        // Use provided sheetId directly
        const sourceSheetId = sourceTab.sheetId;

        // Copy the sheet
        const copyResponse = await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.sheets.copyTo({
                spreadsheetId,
                sheetId: sourceSheetId,
                resource: { destinationSpreadsheetId: spreadsheetId }
            })
        );
        // Rename the new sheet to newTabName
        const newSheetId = copyResponse.result.sheetId;
        await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: {
                    requests: [
                        {
                            updateSheetProperties: {
                                properties: {
                                    sheetId: newSheetId,
                                    title: newTabName
                                },
                                fields: 'title'
                            }
                        }
                    ]
                }
            })
        );
    }

    /**
     * Executes a SQL-like query against sheet data
     * @param {string} tableId - The identifier for the table (e.g., 'INVENTORY')
     * @param {string} query - SQL-like query string
     * @returns {Promise<Array<Object>>} - Query results as an array of objects
     */
    static async querySheetData(tableId, query) {
        await GoogleSheetsAuth.checkAuth();
        
        try {
            // Parse the query
            const parsedQuery = SheetSql.parseQuery(query);
            
            if (!parsedQuery.from) {
                throw new Error('[GoogleSheetsData.querySheetData] VALIDATION_ERROR: Invalid query - FROM clause is required');
            }
            
            // Get the data from the sheet
            const data = await this.getSheetData(tableId, parsedQuery.from);
            
            // Execute the query against the data
            const results = SheetSql.executeQuery(parsedQuery, data);
            
            return results;
        } catch (error) {
            console.error('Error executing sheet query:', error);
            throw new Error(`Failed to execute query: ${error.message}`);
        }
    }

    /**
     * Creates a new blank sheet tab in the spreadsheet.
     * @param {string} tableId - The identifier for the table (e.g., 'INVENTORY').
     * @param {string} newTabName - The name for the new tab.
     * @returns {Promise<void>}
     */
    static async createBlankTab(tableId, newTabName) {
        if (!(await GoogleSheetsAuth.checkAuth())) GoogleSheetsService._throwAuthError();

        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[createBlankTab] Spreadsheet ID not found for table: ${tableId}`);

        // Add the new sheet/tab
        await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: {
                    requests: [
                        {
                            addSheet: {
                                properties: {
                                    title: newTabName
                                }
                            }
                        }
                    ]
                }
            })
        );
    }

    /**
     * Converts a 2D array from Google Sheets to array of objects (first row = headers)
     */
    static sheetArrayToObjects(sheetArray) {
        if (!sheetArray || sheetArray.length < 2) return [];
        const headers = sheetArray[0];
        return sheetArray.slice(1).map(row => {
            const obj = {};
            headers.forEach((h, i) => obj[h] = row[i] ?? '');
            return obj;
        });
    }

    /**
     * Converts array of objects to 2D array for Google Sheets (first row = headers)
     */
    static objectsToSheetArray(data) {
        if (!Array.isArray(data) || data.length === 0) return [[]];
        const headers = Array.from(new Set(data.flatMap(obj => Object.keys(obj))));
        const values = [headers].concat(data.map(obj => headers.map(h => obj[h] ?? '')));
        return values;
    }

    /**
     * Drive modifiedTime of each table's spreadsheet (files.get: Drive quota, not Sheets). Any edit
     * moves it on, by hand or through the API; it can lag behind the edit, and changes that come in
     * through IMPORTRANGE or a Form don't move it.
     * @param {string[]} tableIds
     * @returns {Promise<Object<string, string>|null>} tableId → RFC 3339 time; null without auth
     */
    static async getModifiedTimes(tableIds) {
        if (!(await GoogleSheetsAuth.checkAuth())) return null;
        const entries = await Promise.all(tableIds.map(async (tableId) => {
            const fileId = window.ENDPOINT_IDS[tableId];
            if (!fileId) throw new Error(`[GoogleSheetsData.getModifiedTimes] SPREADSHEET_NOT_FOUND: Spreadsheet ID not found for table: ${tableId}`);
            const response = await GoogleSheetsService.withExponentialBackoff(() => gapi.client.request({
                path: `https://www.googleapis.com/drive/v3/files/${fileId}`,
                method: 'GET',
                params: { fields: 'modifiedTime', supportsAllDrives: true }
            }));
            return [tableId, response.result?.modifiedTime || null];
        }));
        return Object.fromEntries(entries);
    }

    /**
     * Search for a file in Google Drive by name within a specific folder
     * @param {string} fileName - Name of the file to search for
     * @param {string} folderId - ID of the folder to search in
     * @returns {Promise<Object|null>} File object with id and webViewLink, or null if not found
     */
    static async searchDriveFileInFolder(fileName, folderId) {
        return await this.withExponentialBackoff(async () => {
            try {
                if (typeof fileName !== 'string') {
                    console.error('fileName must be a string, received:', typeof fileName, fileName);
                    return null;
                }
                
                if (typeof folderId !== 'string') {
                    console.error('folderId must be a string, received:', typeof folderId, folderId);
                    return null;
                }
                
                const query = `name='${fileName}' and parents in '${folderId}' and trashed=false`;
                //console.log(`[icons] Drive search: "${fileName}" in folder ${folderId}`);

                // Log token scope so we can confirm drive.readonly was granted
                const _token = gapi.client.getToken();
                if (_token) {
                    //console.log('[icons] Token scope granted:', _token.scope || '(scope field not present in token)');
                } else {
                    console.warn('[icons] No OAuth token present — Drive call will fail');
                }

                const response = await gapi.client.request({
                    path: 'https://www.googleapis.com/drive/v3/files',
                    method: 'GET',
                    params: {
                        q: query,
                        fields: 'files(id,name,webViewLink,webContentLink,thumbnailLink)',
                        supportsAllDrives: true,
                        includeItemsFromAllDrives: true
                    }
                });

                const files = response.result?.files;
                if (files && files.length > 0) {
                    const file = files[0];
                    //console.log(`[icons] Found in Drive: "${file.name}" (id: ${file.id})`);
                    return {
                        id: file.id,
                        name: file.name,
                        webViewLink: file.webViewLink,
                        thumbnailLink: file.thumbnailLink || null
                    };
                }

                //console.log(`[icons] Not found in Drive: "${fileName}" (${files ? files.length : 'null'} results)`);
                return "";
            } catch (error) {
                const status = error?.result?.error?.code || error?.status;
                const message = error?.result?.error?.message || error?.message;
                console.error(`[icons] Drive API error (status ${status}): ${message}`, error);
                if (status === 403) console.error('[icons] 403 = insufficient scope or folder access. Verify drive.readonly is granted AND listed in the OAuth consent screen.');
                if (status === 401) console.error('[icons] 401 = unauthenticated. Token may be expired or missing drive scope.');
                return "";
            }
        });
    }

    /**
     * Fetch a Drive file's thumbnail link directly by file ID.
     * Unlike files.list search, this is immediate and not subject to indexing delays.
     * @param {string} fileId - Google Drive file ID
     * @returns {Promise<string|null>} The thumbnailLink URL, or null if not available
     */
    static async getDriveFileThumbnailLink(fileId) {
        try {
            const response = await gapi.client.request({
                path: `https://www.googleapis.com/drive/v3/files/${fileId}`,
                method: 'GET',
                params: { fields: 'thumbnailLink', supportsAllDrives: true }
            });
            return response.result?.thumbnailLink || null;
        } catch (error) {
            console.error('[icons] getDriveFileThumbnailLink error:', error);
            return null;
        }
    }

    /**
     * Fetch a Drive file's raw content as a Blob (authenticated — works for files that are not
     * publicly shared). Wrap it with URL.createObjectURL to show it in an <img>.
     * @param {string} fileId - Google Drive file ID
     * @returns {Promise<Blob|null>} The file content, or null on failure
     */
    static async getDriveFileBlob(fileId) {
        try {
            const token = gapi.client.getToken();
            if (!token || !token.access_token) {
                console.warn('[icons] getDriveFileBlob: no token available');
                return null;
            }
            const response = await fetch(
                `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
                { headers: { Authorization: `Bearer ${token.access_token}` } }
            );
            if (!response.ok) {
                console.warn(`[icons] getDriveFileBlob failed for ${fileId}: HTTP ${response.status}`);
                return null;
            }
            return await response.blob();
        } catch (error) {
            console.error('[icons] getDriveFileBlob error:', error);
            return null;
        }
    }


    /**
     * Find a file in a Drive folder by one of its app properties (private key/value metadata
     * set by this app on upload).
     * @param {string} folderId
     * @param {string} key
     * @param {string} value
     * @returns {Promise<{id: string, name: string}|null>}
     */
    static async findDriveFileByAppProperty(folderId, key, value) {
        try {
            const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const response = await this.withExponentialBackoff(() => gapi.client.request({
                path: 'https://www.googleapis.com/drive/v3/files',
                method: 'GET',
                params: {
                    q: `'${escape(folderId)}' in parents and trashed=false and appProperties has { key='${escape(key)}' and value='${escape(value)}' }`,
                    fields: 'files(id,name)',
                    pageSize: 1,
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true
                }
            }));
            return response.result?.files?.[0] || null;
        } catch (error) {
            console.warn('[icons] findDriveFileByAppProperty failed:', error);
            return null;
        }
    }

    /**
     * Upload a file to Google Drive using multipart upload
     * @param {File} file - The file object to upload
     * @param {string} fileName - Name to give the file in Drive
     * @param {string} folderId - ID of the destination folder
     * @param {Object<string,string>} [appProperties] - Private metadata (findDriveFileByAppProperty)
     * @returns {Promise<{id: string, name: string}|null>} Uploaded file metadata or null on failure
     */
    static async uploadDriveFile(file, fileName, folderId, appProperties = null) {
        return await this.withExponentialBackoff(async () => {
            try {
                const token = gapi.client.getToken();
                if (!token || !token.access_token) throw new Error('Not authenticated');

                const metadata = { name: fileName, parents: [folderId], ...(appProperties ? { appProperties } : {}) };
                const form = new FormData();
                form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                form.append('file', file);

                const response = await fetch(
                    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name',
                    {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token.access_token}` },
                        body: form
                    }
                );

                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(`Upload failed: ${response.status} ${err?.error?.message || ''}`);
                }

                return await response.json();
            } catch (error) {
                console.error('Error uploading Drive file:', error);
                return null;
            }
        });
    }

    /**
     * Delete a file from Google Drive
     * @param {string} fileId - ID of the file to delete
     * @returns {Promise<boolean>} True on success, false on failure
     */
    static async deleteDriveFile(fileId) {
        return await this.withExponentialBackoff(async () => {
            try {
                await gapi.client.request({
                    path: `https://www.googleapis.com/drive/v3/files/${fileId}`,
                    method: 'DELETE',
                    params: { supportsAllDrives: true }
                });
                return true;
            } catch (error) {
                const status = error?.result?.error?.code || error?.status;
                if (status === 404) {
                    // File not found — already deleted or owned by another user without delete permission.
                    // This is expected when a user replaces an image uploaded by someone else.
                    console.warn(`[icons] deleteDriveFile: file ${fileId} not found (404) — skipping`);
                    return false;
                }
                console.error('Error deleting Drive file:', error);
                return false;
            }
        });
    }

    /**
     * Get a direct image URL for a Google Drive file
     * @param {string} fileId - Google Drive file ID
     * @returns {string} Direct image URL
     */
    static getDriveImageUrl(fileId) {
        return `https://drive.google.com/uc?id=${fileId}&export=view`;
    }
}
