import { GoogleSheetsAuth } from './GoogleSheetsAuth.js';
import { SheetSql } from './sheetSql.js';
import { normalizeHeaderName } from '../data_management/utils/helpers.js';
import { ProgressBus } from '../data_management/utils/caching.js';

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
                // Immediately throw grid limit errors - these need to be caught by expansion logic, not retried
                if (err && err.status === 400 && err.result?.error?.message?.includes('exceeds grid limits')) {
                    throw err;
                }
                
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

        // Remove try/catch to allow errors to bubble up to reactive store
        const response = await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.values.get({
                spreadsheetId,
                range,
            })
        );
        
        const rawData = response.result && Array.isArray(response.result.values) ? response.result.values : [];
        if (!rawData || rawData.length === 0) return [[]];
        
        // Return raw 2D array data to match FakeGoogle interface
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
        const response = await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges })
        );
        const valueRanges = response.result?.valueRanges || [];
        return ranges.map((_, i) => {
            const values = valueRanges[i]?.values;
            return Array.isArray(values) && values.length ? values : [[]];
        });
    }

    /**
     * values.batchUpdate: write several ranges in one request (same value input as setSheetData).
     * Only the given ranges change; nothing is truncated.
     * @param {string} tableId
     * @param {Array<{ range: string, values: Array<Array<string>> }>} data
     * @returns {Promise<boolean>}
     */
    static async batchSetValues(tableId, data) {
        if (!(await GoogleSheetsAuth.checkAuth())) GoogleSheetsService._throwAuthError();
        const spreadsheetId = window.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[GoogleSheetsData.batchSetValues] SPREADSHEET_NOT_FOUND: Spreadsheet ID not found for table: ${tableId}`);
        if (!data || !data.length) return true;
        await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId,
                resource: { valueInputOption: 'USER_ENTERED', data }
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
     * @returns {Promise<boolean>}
     */
    static async setSheetData(tableId, tabName, updates, mapping = null) {
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
        
        // Write new data with automatic grid expansion on error
        try {
            await GoogleSheetsService.withExponentialBackoff(() =>
                gapi.client.sheets.spreadsheets.values.update({
                    spreadsheetId,
                    range,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values }
                })
            );
        } catch (error) {
            // Check if error is due to exceeding grid limits
            if (error.status === 400 && error.result?.error?.message?.includes('exceeds grid limits')) {
                //console.warn(`[setSheetData] Range exceeds grid limits, expanding sheet and retrying...`);
                
                // Let _ensureSheetSize parse the range to determine absolute position
                // Don't pass explicit row/col counts - let it extract from the range spec
                await this._ensureSheetSize(spreadsheetId, range, null, null);
                
                // Retry the write operation
                await GoogleSheetsService.withExponentialBackoff(() =>
                    gapi.client.sheets.spreadsheets.values.update({
                        spreadsheetId,
                        range,
                        valueInputOption: 'USER_ENTERED',
                        resource: { values }
                    })
                );
            } else {
                // Re-throw other errors
                throw error;
            }
        }
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
        return true;
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
     * Helper method to ensure a sheet has enough rows and columns for a given range
     * @private
     * @param {string} spreadsheetId
     * @param {string} tabName - The tab name (can include range like "Locks!D1:D1")
     * @param {number} [requiredRows] - Optional explicit row count requirement
     * @param {number} [requiredCols] - Optional explicit column count requirement
     */
    static async _ensureSheetSize(spreadsheetId, tabName, requiredRows = null, requiredCols = null) {
        if (typeof gapi === 'undefined' || !gapi.client?.sheets?.spreadsheets?.get) return;
        
        // Extract sheet name from range if provided (e.g., "Locks!D1:D1" -> "Locks")
        // (the sheet name may be quoted: "'Production Schedule'!A5:A5")
        const bang = tabName.lastIndexOf('!');
        const quoted = bang >= 0 ? tabName.slice(0, bang) : tabName;
        const sheetName = /^'.*'$/.test(quoted) ? quoted.slice(1, -1).replace(/''/g, "'") : quoted;
        const rangeSpec = bang >= 0 ? tabName.slice(bang + 1) : null;
        
        // Parse range to determine required rows/cols if not explicitly provided
        if (rangeSpec && (requiredRows === null || requiredCols === null)) {
            const match = rangeSpec.match(/([A-Z]+)(\d+)/);
            if (match) {
                const col = match[1];
                const row = parseInt(match[2]);
                
                // Convert column letter to number (A=1, B=2, Z=26, AA=27, etc.)
                let colNum = 0;
                for (let i = 0; i < col.length; i++) {
                    colNum = colNum * 26 + (col.charCodeAt(i) - 64);
                }
                
                if (requiredRows === null) requiredRows = row;
                if (requiredCols === null) requiredCols = colNum;
            }
        }
        
        const sheetInfo = await GoogleSheetsService.withExponentialBackoff(() =>
            gapi.client.sheets.spreadsheets.get({
                spreadsheetId,
                ranges: [sheetName],
                includeGridData: false
            })
        );
        
        const sheet = sheetInfo.result.sheets.find(s => s.properties.title === sheetName);
        if (!sheet) return;
        
        const currentRows = sheet.properties.gridProperties.rowCount;
        const currentCols = sheet.properties.gridProperties.columnCount;
        
        const requests = [];
        
        // Expand rows if needed, adding 10 extra rows as buffer
        if (requiredRows && requiredRows > currentRows) {
            //console.log(`[_ensureSheetSize] Expanding rows from ${currentRows} to ${requiredRows + 10}`);
            requests.push({
                appendDimension: {
                    sheetId: sheet.properties.sheetId,
                    dimension: 'ROWS',
                    length: requiredRows - currentRows + 10
                }
            });
        }
        
        // Expand columns if needed
        if (requiredCols && requiredCols > currentCols) {
            //console.log(`[_ensureSheetSize] Expanding columns from ${currentCols} to ${requiredCols}`);
            requests.push({
                appendDimension: {
                    sheetId: sheet.properties.sheetId,
                    dimension: 'COLUMNS',
                    length: requiredCols - currentCols
                }
            });
        }
        
        // Execute batch update if any requests were added
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
