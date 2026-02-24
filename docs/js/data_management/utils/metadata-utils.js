/**
 * EditHistory Management Utilities
 * 
 * Provides core functions for tracking row changes, managing history,
 * and archiving deleted rows to EditHistory table.
 * 
 * EditHistory Column Format (minimized):
 * {
 *   "h": [
 *     {
 *       "u": "dan",
 *       "t": 17309064000,
 *       "c": [
 *         { "n": "quantity", "o": "5" }
 *       ]
 *     }
 *   ],
 *   "a": { ... },
 *   "s": { ... }
 * }
 * 
 * Key mapping:
 * h = history
 * u = user (username before @)
 * t = timestamp (deciseconds since epoch - divide by 10 for seconds, multiply by 100 for milliseconds)
 * c = changes
 * n = column name
 * o = old value
 * a = cachedAnalytics
 * s = userSettings
 */

export class EditHistoryUtils {
    /**
     * Create a new edithistory entry for a row change
     * @param {string} username - User email making the change
     * @param {Array<{column: string, old: any, new: any}>} changes - List of changes
     * @returns {Object} Metadata entry object
     */
    static createEditHistoryEntry(username, changes) {
        // Extract username before @ symbol
        const shortUser = username ? username.split('@')[0] : 'unknown';
        
        // Convert changes to minimal format (only store old values)
        const minimalChanges = changes.map(change => ({
            n: change.column,  // n = name
            o: change.old      // o = old value (new value not stored)
        }));
        
        return {
            u: shortUser,                           // u = user
            t: Math.floor(new Date().getTime() / 100),  // t = timestamp in deciseconds
            c: minimalChanges                       // c = changes
        };
    }

    /**
     * Append a new entry to existing edithistory history
     * @param {string|Object} existingEditHistory - Existing edithistory (JSON string or object)
     * @param {Object} newEntry - New edithistory entry to append
     * @param {number} maxHistory - Maximum history entries to keep (default: 10)
     * @returns {string} Updated edithistory as JSON string
     */
    static appendToEditHistory(existingEditHistory, newEntry, maxHistory = 10) {
        let edithistory;
        
        // Parse existing edithistory
        if (typeof existingEditHistory === 'string') {
            try {
                edithistory = existingEditHistory ? JSON.parse(existingEditHistory) : { h: [] };
            } catch (error) {
                console.warn('Failed to parse existing edithistory, creating new:', error);
                edithistory = { h: [] };
            }
        } else if (typeof existingEditHistory === 'object' && existingEditHistory !== null) {
            edithistory = { ...existingEditHistory };
        } else {
            edithistory = { h: [] };
        }

        // Ensure history array exists (support both old 'history' and new 'h' format)
        if (!Array.isArray(edithistory.h)) {
            edithistory.h = [];
        }

        // Add new entry at the beginning (most recent first)
        edithistory.h.unshift(newEntry);

        // Trim to max history length
        if (edithistory.h.length > maxHistory) {
            edithistory.h = edithistory.h.slice(0, maxHistory);
        }

        return JSON.stringify(edithistory);
    }

    /**
     * Calculate differences between two row objects
     * @param {Object} oldRow - Original row data
     * @param {Object} newRow - Updated row data
     * @param {Array<string>} ignoredColumns - Columns to ignore (e.g., 'edithistory', 'AppData')
     * @returns {Array<{column: string, old: any, new: any}>} Array of changes
     */
    static calculateRowDiff(oldRow, newRow, ignoredColumns = ['edithistory', 'EditHistory', 'AppData']) {
        const changes = [];

        if (!oldRow || !newRow) {
            return changes;
        }

        // Get all unique keys from both objects
        const allKeys = new Set([
            ...Object.keys(oldRow),
            ...Object.keys(newRow)
        ]);

        for (const key of allKeys) {
            // Skip ignored columns
            if (ignoredColumns.includes(key)) {
                continue;
            }

            const oldValue = oldRow[key];
            const newValue = newRow[key];

            // Compare values (handle different types)
            if (!this._valuesEqual(oldValue, newValue)) {
                changes.push({
                    column: key,
                    old: oldValue,
                    new: newValue
                });
            }
        }

        return changes;
    }

    /**
     * Compare two values for equality (handles undefined, null, empty strings)
     * @private
     */
    static _valuesEqual(val1, val2) {
        // Normalize undefined, null, and empty strings
        const normalize = (val) => {
            if (val === undefined || val === null || val === '') {
                return null;
            }
            return val;
        };

        const normalized1 = normalize(val1);
        const normalized2 = normalize(val2);

        // Use JSON stringify for object comparison
        if (typeof normalized1 === 'object' || typeof normalized2 === 'object') {
            return JSON.stringify(normalized1) === JSON.stringify(normalized2);
        }

        return normalized1 === normalized2;
    }

    /**
     * Calculate diffs for multiple rows
     * @param {Array<Object>} originalRows - Original data array
     * @param {Array<Object>} updatedRows - Updated data array
     * @param {Array<string>} ignoredColumns - Columns to ignore
     * @returns {Array<{index: number, changes: Array}>} Array of row indices with their changes
     */
    static calculateBatchDiff(originalRows, updatedRows, ignoredColumns = ['edithistory', 'EditHistory', 'AppData']) {
        const results = [];

        if (!Array.isArray(originalRows) || !Array.isArray(updatedRows)) {
            return results;
        }

        const maxLength = Math.max(originalRows.length, updatedRows.length);

        for (let i = 0; i < maxLength; i++) {
            const oldRow = originalRows[i] || null;
            const newRow = updatedRows[i] || null;

            const changes = this.calculateRowDiff(oldRow, newRow, ignoredColumns);

            if (changes.length > 0) {
                results.push({
                    index: i,
                    changes: changes
                });
            }
        }

        return results;
    }

    /**
     * Detect deleted rows by comparing original and updated data
     * @param {Array<Object>} originalRows - Original data array
     * @param {Array<Object>} updatedRows - Updated data array
     * @param {string} identifierKey - Column name to use as row identifier (e.g., 'itemNumber', 'Piece #')
     * @returns {Array<{identifier: string, rowData: Object}>} Deleted rows with their identifiers
     */
    static detectDeletedRows(originalRows, updatedRows, identifierKey = null) {
        const deletedRows = [];

        if (!Array.isArray(originalRows) || !Array.isArray(updatedRows)) {
            return deletedRows;
        }

        // If no identifier key provided, detect by position
        if (!identifierKey) {
            if (originalRows.length > updatedRows.length) {
                // Rows were removed from the end
                for (let i = updatedRows.length; i < originalRows.length; i++) {
                    deletedRows.push({
                        identifier: `row_${i + 1}`,
                        rowData: originalRows[i]
                    });
                }
            }
            return deletedRows;
        }

        // Build a set of identifiers in updated data
        const updatedIdentifiers = new Set(
            updatedRows
                .map(row => row[identifierKey])
                .filter(id => id !== undefined && id !== null && id !== '')
        );

        // Find rows in original that aren't in updated
        for (const row of originalRows) {
            const identifier = row[identifierKey];
            if (identifier !== undefined && identifier !== null && identifier !== '' && 
                !updatedIdentifiers.has(identifier)) {
                deletedRows.push({
                    identifier: String(identifier),
                    rowData: row
                });
            }
        }

        return deletedRows;
    }

    /**
     * Create a edithistory object for archiving a deleted row
     * @param {string} sourceTable - Table identifier (e.g., 'INVENTORY', 'PACK_LISTS')
     * @param {string} sourceTab - Tab name
     * @param {string} rowIdentifier - Row identifier
     * @param {Object} rowData - Full row data
     * @param {string} username - User who deleted the row
     * @returns {Object} Archive entry object
     */
    static createArchiveEntry(sourceTable, sourceTab, rowIdentifier, rowData, username) {
        return {
            SourceTable: sourceTable,
            SourceTab: sourceTab,
            RowIdentifier: rowIdentifier,
            Username: username || 'unknown',
            Timestamp: Math.floor(new Date().getTime() / 100),
            Operation: 'delete',
            RowData: JSON.stringify(rowData)
        };
    }

    /**
     * Convert decisecond timestamp to Date object
     * @param {number} deciseconds - Timestamp in deciseconds (1/10th second)
     * @returns {Date} Date object
     */
    static decisecondToDate(deciseconds) {
        return new Date(deciseconds * 100);
    }

    /**
     * Format decisecond timestamp as ISO string
     * @param {number} deciseconds - Timestamp in deciseconds (1/10th second)
     * @returns {string} ISO 8601 formatted date string
     */
    static formatTimestamp(deciseconds) {
        return new Date(deciseconds * 100).toISOString();
    }

    /**
     * Format decisecond timestamp as human-readable string
     * @param {number} deciseconds - Timestamp in deciseconds (1/10th second)
     * @returns {string} Human-readable date string
     */
    static formatTimestampHuman(deciseconds) {
        return new Date(deciseconds * 100).toLocaleString();
    }

    /**
     * Parse edithistory from a row (handles both string and object formats)
     * @param {string|Object} edithistory - Metadata to parse
     * @returns {Object|null} Parsed edithistory object or null if invalid
     */
    static parseEditHistory(edithistory) {
        if (!edithistory) {
            return null;
        }

        if (typeof edithistory === 'object') {
            return edithistory;
        }

        if (typeof edithistory === 'string') {
            try {
                return JSON.parse(edithistory);
            } catch (error) {
                console.warn('Failed to parse edithistory:', error);
                return null;
            }
        }

        return null;
    }

    /**
     * Get the most recent change from edithistory
     * @param {string|Object} edithistory - Metadata to parse
     * @returns {Object|null} Most recent change entry or null
     */
    static getMostRecentChange(edithistory) {
        const parsed = this.parseEditHistory(edithistory);
        if (!parsed) return null;
        
        const history = parsed.h;
        if (!Array.isArray(history) || history.length === 0) {
            return null;
        }
        return history[0];
    }

    /**
     * Add or update cached analytics in edithistory
     * @param {string|Object} existingEditHistory - Existing edithistory
     * @param {string} analyticKey - Key for the cached analytic
     * @param {any} analyticValue - Value to cache
     * @returns {string} Updated edithistory as JSON string
     */
    static setCachedAnalytic(existingEditHistory, analyticKey, analyticValue) {
        let edithistory = this.parseEditHistory(existingEditHistory) || { h: [] };

        if (!edithistory.a) {
            edithistory.a = {};
        }

        edithistory.a[analyticKey] = analyticValue;

        return JSON.stringify(edithistory);
    }

    /**
     * Get cached analytic from edithistory
     * @param {string|Object} edithistory - Metadata to parse
     * @param {string} analyticKey - Key for the cached analytic
     * @returns {any|null} Cached value or null if not found
     */
    static getCachedAnalytic(edithistory, analyticKey) {
        const parsed = this.parseEditHistory(edithistory);
        if (!parsed) return null;
        
        const analytics = parsed.a;
        if (!analytics) return null;
        
        return analytics[analyticKey] || null;
    }

    /**
     * Add or update user setting in edithistory
     * @param {string|Object} existingEditHistory - Existing edithistory
     * @param {string} settingKey - Key for the user setting
     * @param {any} settingValue - Value to set
     * @returns {string} Updated edithistory as JSON string
     */
    static setUserSetting(existingEditHistory, settingKey, settingValue) {
        let edithistory = this.parseEditHistory(existingEditHistory) || { h: [] };

        if (!edithistory.s) {
            edithistory.s = {};
        }

        edithistory.s[settingKey] = settingValue;

        return JSON.stringify(edithistory);
    }

    /**
     * Get user setting from edithistory
     * @param {string|Object} edithistory - Metadata to parse
     * @param {string} settingKey - Key for the user setting
     * @returns {any|null} Setting value or null if not found
     */
    static getUserSetting(edithistory, settingKey) {
        const parsed = this.parseEditHistory(edithistory);
        if (!parsed) return null;
        
        // Support both old 'userSettings' and new 's' format
        const settings = parsed.s;
        if (!settings) return null;
        
        return settings[settingKey] || null;
    }
}
