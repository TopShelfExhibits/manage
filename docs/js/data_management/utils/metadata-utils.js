/**
 * EditHistory Management Utilities
 *
 * Provides core functions for tracking row changes, managing history,
 * matching rows across saves, and archiving deleted rows to the _EditHistory tab.
 *
 * Canonical contract: docs/notes/metadata-implementation.md
 *
 * EditHistory Column Format (minimized):
 * {
 *   "i": 7,
 *   "h": [
 *     {
 *       "u": "dan",
 *       "t": 17309064000,
 *       "s": "web",
 *       "c": [
 *         { "n": "quantity", "o": "5" }
 *       ]
 *     }
 *   ],
 *   "p": [ ... ]
 * }
 *
 * Key mapping:
 * i = row identity (positive integer, unique per tab, immutable, assigned on first touch)
 * h = history, newest first
 * p = pending (scheduled) changes, inventory only
 * u = user (username before @)
 * t = timestamp (deciseconds since epoch - divide by 10 for seconds, multiply by 100 for milliseconds)
 * s = source ('web' | 'cad') or, for inventory saves, the user's note
 * c = changes ([] = creation marker)
 * n = field name (application mapping key)
 * o = old value
 */

/** Maximum number of entries kept in EditHistory.h */
export const MAX_HISTORY_ENTRIES = 10;

/** Adjacent entries from the same user and source within this window are merged (1 hour in deciseconds) */
export const HISTORY_AGGREGATION_WINDOW = 36000;

/** Tab (in each spreadsheet) that receives archived deleted rows */
export const ARCHIVE_TAB_NAME = '_EditHistory';

/** Archive tab columns, in write order (contract: "Archive Table") */
export const ARCHIVE_HEADERS = ['SourceTable', 'SourceTab', 'RowIdentifier', 'Username', 'Timestamp', 'Operation', 'RowData'];

/** Row object key holding the EditHistory column (sheet header 'EditHistory') */
export const HISTORY_KEY = 'edithistory';

/** CACHE/Preferences ID holding the maximum length of an inventory save note (EditHistory `s`) */
export const INVENTORY_NOTE_MAX_LENGTH_PREFERENCE = 'InventoryNoteMaxLength';

/** Note length used when the preference is missing or invalid */
export const DEFAULT_INVENTORY_NOTE_MAX_LENGTH = 25;

/**
 * Inventory note limit from preference rows ({ id, value }), e.g. Requests.getPreferences().
 * @param {Array<{id: string, value: string}>} preferences
 * @returns {number} Positive integer
 */
export function resolveInventoryNoteMaxLength(preferences) {
    const row = Array.isArray(preferences) ? preferences.find(p => p?.id === INVENTORY_NOTE_MAX_LENGTH_PREFERENCE) : null;
    const value = parseInt(row?.value, 10);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_INVENTORY_NOTE_MAX_LENGTH;
}

const DIFF_IGNORED_COLUMNS = [HISTORY_KEY, 'AppData'];

export class EditHistoryUtils {
    /**
     * Create a new edithistory entry for a row change
     * @param {string} username - User email making the change
     * @param {Array<{column: string, old: any, new: any}>} changes - List of changes
     * @param {string|null} source - Source system for this change ('web' | 'cad'), an inventory
     *   note, or null/'' to omit `s` (readers treat a missing `s` as 'web')
     * @returns {Object} Metadata entry object
     */
    static createEditHistoryEntry(username, changes, source = 'web') {
        // Extract username before @ symbol
        const shortUser = username ? username.split('@')[0] : 'unknown';
        
        // Convert changes to minimal format (only store old values)
        const minimalChanges = changes.map(change => ({
            n: change.column,  // n = name
            o: change.old      // o = old value (new value not stored)
        }));
        
        const entry = {
            u: shortUser,                           // u = user
            t: Math.floor(new Date().getTime() / 100)  // t = timestamp in deciseconds
        };
        if (source) entry.s = source;               // s = source system or inventory note
        entry.c = minimalChanges;                   // c = changes
        return entry;
    }

    /**
     * Append a new entry to existing edithistory history
     * @param {string|Object} existingEditHistory - Existing edithistory (JSON string or object)
     * @param {Object} newEntry - New edithistory entry to append
     * @param {number} maxHistory - Maximum history entries to keep
     * @param {Object} [currentRow] - Row values after the change; enables dropping reverted fields when aggregating
     * @returns {string} Updated edithistory as JSON string
     */
    static appendToEditHistory(existingEditHistory, newEntry, maxHistory = MAX_HISTORY_ENTRIES, currentRow = null) {
        const parsed = this.parseEditHistory(existingEditHistory);
        return JSON.stringify(this._addEntry(parsed ? { ...parsed } : {}, newEntry, maxHistory, currentRow));
    }

    /**
     * Add an entry to the front of an edithistory object's h array, merging it into the
     * newest entry when the aggregation rules allow, then applying the cap.
     * @private
     * @param {Object} edithistory - Parsed edithistory object (shallow copy; h is replaced, not mutated)
     * @returns {Object} The same object with an updated h array
     */
    static _addEntry(edithistory, newEntry, maxHistory = MAX_HISTORY_ENTRIES, currentRow = null) {
        const history = Array.isArray(edithistory.h) ? [...edithistory.h] : [];
        const prev = history[0];

        if (this._canAggregate(prev, newEntry)) {
            // prev.o values are older than newEntry's, so prev wins for fields it already lists
            const listed = new Set(prev.c.map(ch => ch.n));
            let merged = [...prev.c, ...newEntry.c.filter(ch => !listed.has(ch.n))];
            if (currentRow) {
                merged = merged.filter(ch => ch.n === undefined || !this._valuesEqual(ch.o, currentRow[ch.n]));
            }
            if (merged.length === 0) {
                history.shift(); // edited and reverted within the window: nothing left to record
            } else {
                history[0] = { ...prev, t: newEntry.t, c: merged };
            }
        } else {
            history.unshift(newEntry);
        }

        edithistory.h = history.slice(0, maxHistory);
        return edithistory;
    }

    /**
     * Whether newEntry can be merged into prev (the newest existing entry).
     * @private
     */
    static _canAggregate(prev, newEntry) {
        if (!prev || !newEntry) return false;
        if (prev.d !== undefined || newEntry.d !== undefined) return false;
        if (!Array.isArray(prev.c) || prev.c.length === 0) return false;
        if (!Array.isArray(newEntry.c) || newEntry.c.length === 0) return false;
        if (prev.c.some(ch => ch.n === undefined)) return false;
        if (prev.u !== newEntry.u) return false;
        if (this.normalizeSource(prev.s) !== this.normalizeSource(newEntry.s)) return false;
        const gap = newEntry.t - prev.t;
        return gap >= 0 && gap <= HISTORY_AGGREGATION_WINDOW;
    }

    /**
     * The user-facing note of a history entry: `s` unless it is only the default source
     * marker ('web' or legacy 'app'), which older inventory saves wrote when no note was given.
     * @param {Object} entry - History entry
     * @returns {string}
     */
    static entryNote(entry) {
        const s = entry?.s ?? '';
        return ['web', 'app'].includes(String(s).toLowerCase()) ? '' : String(s);
    }

    /**
     * Normalize an entry source for comparison: missing → 'web', legacy 'app' → 'web'.
     * Non-source values (inventory notes) are returned as-is.
     * @param {string} source
     * @returns {string}
     */
    static normalizeSource(source) {
        const value = String(source || 'web').toLowerCase();
        return value === 'app' ? 'web' : value;
    }

    /**
     * Calculate differences between two row objects
     * @param {Object} oldRow - Original row data
     * @param {Object} newRow - Updated row data
     * @param {Array<string>} ignoredColumns - Columns to ignore (e.g., 'edithistory', 'AppData')
     * @returns {Array<{column: string, old: any, new: any}>} Array of changes
     */
    static calculateRowDiff(oldRow, newRow, ignoredColumns = DIFF_IGNORED_COLUMNS) {
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

    // -------------------------------------------------------------------------
    // Row Identity (EditHistory.i)
    // -------------------------------------------------------------------------

    /**
     * Get a row's identity from its EditHistory.
     * @param {string|Object} edithistory - EditHistory value
     * @returns {number|null} Positive integer identity, or null if absent/invalid
     */
    static getRowIndex(edithistory) {
        const i = this.parseEditHistory(edithistory)?.i;
        return Number.isInteger(i) && i > 0 ? i : null;
    }

    /**
     * Next free identity for a tab: one more than the largest i among all given rows.
     * @param {Array<Array<Object>>} rowSets - Row arrays to scan (e.g. stored and incoming rows)
     * @returns {number}
     */
    static nextRowIndex(rowSets) {
        let max = 0;
        for (const rows of rowSets) {
            for (const row of rows || []) {
                const i = this.getRowIndex(row?.[HISTORY_KEY]);
                if (i !== null && i > max) max = i;
            }
        }
        return max + 1;
    }

    /**
     * Match incoming rows to stored rows for a save. Pure — no I/O.
     * Contract: docs/notes/metadata-implementation.md "Matching rows during a save".
     *
     * @param {Array<Object>} originalRows - Rows currently stored in the tab
     * @param {Array<Object>} updatedRows - Rows about to be saved
     * @returns {{
     *   matchOf: Array<number>,      // per updated row: index of matched original row, or -1
     *   duplicates: Set<number>,     // updated rows that copied another row's i and need a fresh identity
     *   deleted: Array<number>       // original row indices with no match
     * }}
     */
    static matchRows(originalRows, updatedRows) {
        const originals = Array.isArray(originalRows) ? originalRows : [];
        const updates = Array.isArray(updatedRows) ? updatedRows : [];
        const matchOf = new Array(updates.length).fill(-1);
        const duplicates = new Set();
        const claimed = new Set();

        const origIdx = originals.map(row => this.getRowIndex(row?.[HISTORY_KEY]));
        const updIdx = updates.map(row => this.getRowIndex(row?.[HISTORY_KEY]));

        // Pass 1: match by i. When several incoming rows share an i, the one closest
        // in position to the stored row keeps it; the rest are copies.
        const originalByIndex = new Map();
        origIdx.forEach((i, o) => {
            if (i !== null && !originalByIndex.has(i)) originalByIndex.set(i, o);
        });
        const updatedByIndex = new Map();
        updIdx.forEach((i, u) => {
            if (i === null) return;
            if (!updatedByIndex.has(i)) updatedByIndex.set(i, []);
            updatedByIndex.get(i).push(u);
        });
        for (const [i, candidates] of updatedByIndex) {
            if (originalByIndex.has(i)) {
                const o = originalByIndex.get(i);
                const keeper = candidates.reduce((best, u) => Math.abs(u - o) < Math.abs(best - o) ? u : best);
                matchOf[keeper] = o;
                claimed.add(o);
                candidates.forEach(u => { if (u !== keeper) duplicates.add(u); });
            } else {
                // i not stored in this tab: the first occurrence keeps it, later copies are duplicates
                candidates.slice(1).forEach(u => duplicates.add(u));
            }
        }

        // Legacy fallback: rows without i only match stored rows without i
        const legacyOriginals = new Set(origIdx.map((i, o) => i === null ? o : -1).filter(o => o !== -1));
        const isOpenLegacy = (o) => legacyOriginals.has(o) && !claimed.has(o);
        const legacyUpdates = updIdx.map((i, u) => i === null ? u : -1).filter(u => u !== -1);

        // Pass 2: identical content, nearest position wins
        const originalsBySignature = new Map();
        legacyOriginals.forEach(o => {
            const sig = this._rowSignature(originals[o]);
            if (!originalsBySignature.has(sig)) originalsBySignature.set(sig, []);
            originalsBySignature.get(sig).push(o);
        });
        for (const u of legacyUpdates) {
            const pool = (originalsBySignature.get(this._rowSignature(updates[u])) || []).filter(isOpenLegacy);
            if (pool.length === 0) continue;
            const o = pool.reduce((best, c) => Math.abs(c - u) < Math.abs(best - u) ? c : best);
            matchOf[u] = o;
            claimed.add(o);
        }

        // Pass 3: within the gap between the nearest matched neighbors, by similarity,
        // falling back to order when both sides of the gap have the same number of rows
        for (const u of legacyUpdates) {
            if (matchOf[u] !== -1) continue;
            let prev = u - 1;
            while (prev >= 0 && matchOf[prev] === -1) prev--;
            let next = u + 1;
            while (next < updates.length && matchOf[next] === -1) next++;
            const lowBound = prev >= 0 ? matchOf[prev] : -1;
            const highBound = next < updates.length ? matchOf[next] : originals.length;
            const lo = Math.min(lowBound, highBound);
            const hi = Math.max(lowBound, highBound);

            const gapCandidates = [];
            for (let o = lo + 1; o < hi; o++) if (isOpenLegacy(o)) gapCandidates.push(o);
            if (gapCandidates.length === 0) continue;

            let best = -1;
            let bestScore = 0;
            for (const o of gapCandidates) {
                const score = this._rowSimilarity(originals[o], updates[u]);
                if (score > bestScore) { best = o; bestScore = score; }
            }
            if (best === -1) {
                const unmatchedInGap = [];
                for (let k = prev + 1; k < next; k++) if (matchOf[k] === -1 && updIdx[k] === null) unmatchedInGap.push(k);
                if (unmatchedInGap.length === gapCandidates.length) best = gapCandidates[0];
            }
            if (best !== -1) {
                matchOf[u] = best;
                claimed.add(best);
            }
        }

        const deleted = [];
        originals.forEach((_, o) => { if (!claimed.has(o)) deleted.push(o); });
        return { matchOf, duplicates, deleted };
    }

    /**
     * Content signature for exact matching: non-empty field values, excluding history/AppData.
     * @private
     */
    static _rowSignature(row) {
        if (!row) return '';
        return JSON.stringify(Object.keys(row)
            .filter(key => !DIFF_IGNORED_COLUMNS.includes(key))
            .filter(key => !this._isEmptyValue(row[key]))
            .sort()
            .map(key => [key, String(row[key])]));
    }

    /**
     * Number of fields that are non-empty and equal in both rows.
     * @private
     */
    static _rowSimilarity(rowA, rowB) {
        if (!rowA || !rowB) return 0;
        let score = 0;
        for (const key of Object.keys(rowA)) {
            if (DIFF_IGNORED_COLUMNS.includes(key)) continue;
            if (this._isEmptyValue(rowA[key])) continue;
            if (String(rowA[key]) === String(rowB[key] ?? '')) score++;
        }
        return score;
    }

    /**
     * Whether a row has no field content and no history (not worth archiving).
     * @param {Object} row
     * @returns {boolean}
     */
    static isBlankRow(row) {
        if (!row) return true;
        return Object.keys(row).every(key => key === 'AppData' || this._isEmptyValue(row[key]));
    }

    /** @private */
    static _isEmptyValue(value) {
        return value === undefined || value === null || String(value).trim() === '';
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
     * Reconstruct a row's past states from its history (contract: "Reconstructing past row states").
     * Each h[k] holds the metadata of change k plus the OLD values of the fields it changed,
     * so the state after change k is the row with the old values of every newer entry applied.
     *
     * Returned rows, newest first:
     *   - 'current':  the row's values, paired with h[0] (the change that produced them)
     *   - 'change':   state after h[k], paired with h[k]
     *   - 'created':  the change row whose entry is a creation marker (c: []) — always last
     *   - 'earliest': oldest known state when history does not reach creation (entry: null)
     *
     * Pass the SAVED row (not one with unsaved edits), or every reconstructed state shifts.
     * Pending changes (p) are ignored.
     *
     * @param {Object} row - Row object with an edithistory field
     * @param {Array<string>} [fields] - Keys to include in each state (default: all except edithistory/AppData)
     * @returns {Array<{kind: string, state: Object, entry: Object|null, changed: Set<string>}>}
     */
    static getHistoryStates(row, fields = null) {
        const keys = fields || Object.keys(row || {}).filter(key => !DIFF_IGNORED_COLUMNS.includes(key));
        const parsedHistory = this.parseEditHistory(row?.[HISTORY_KEY])?.h;
        const entries = Array.isArray(parsedHistory) ? parsedHistory : [];
        // c items without n (planned move records) and fields outside `keys` are ignored
        const fieldChanges = (entry) => (Array.isArray(entry?.c) ? entry.c : []).filter(ch => ch?.n !== undefined && keys.includes(ch.n));
        const changedSet = (entry) => new Set(fieldChanges(entry).map(ch => ch.n));
        const isCreation = (entry) => Array.isArray(entry?.c) && entry.c.length === 0;

        const state = Object.fromEntries(keys.map(key => [key, row?.[key] ?? '']));
        const states = [{ kind: 'current', state: { ...state }, entry: entries[0] || null, changed: changedSet(entries[0]) }];

        for (let k = 1; k <= entries.length; k++) {
            // Rewind change k-1: restore the old values it recorded
            for (const ch of fieldChanges(entries[k - 1])) {
                state[ch.n] = ch.o ?? '';
            }
            if (k < entries.length) {
                const entry = entries[k];
                states.push({ kind: isCreation(entry) ? 'created' : 'change', state: { ...state }, entry, changed: changedSet(entry) });
            }
        }

        if (entries.length > 0 && !isCreation(entries[entries.length - 1])) {
            states.push({ kind: 'earliest', state: { ...state }, entry: null, changed: new Set() });
        }
        return states;
    }

    // -------------------------------------------------------------------------
    // Pending Change Schedule Helpers
    // -------------------------------------------------------------------------

    /**
     * Create a pending change entry for the p array.
     * t = effective date (deciseconds), d = creation timestamp (deciseconds).
     * changes is [{ n, ne }] — ne may be an absolute value or a delta string like "+1".
     * @param {string} username - User email
     * @param {Array<{n: string, ne: string|number}>} changes - Changed fields
     * @param {number} effectiveDateDeciseconds - Effective date in deciseconds
     * @param {string} note - Description/note
     * @param {number} [noteMaxLength] - InventoryNoteMaxLength preference; the note is truncated to it
     * @returns {Object} Pending entry object
     */
    static createPendingEntry(username, changes, effectiveDateDeciseconds, note, noteMaxLength = DEFAULT_INVENTORY_NOTE_MAX_LENGTH) {
        const shortUser = username ? username.split('@')[0] : 'unknown';
        return {
            u: shortUser,
            t: effectiveDateDeciseconds,
            d: Math.floor(Date.now() / 100),
            s: (note || '').slice(0, noteMaxLength),
            c: changes.map(ch => ({ n: ch.n, ne: ch.ne }))
        };
    }

    /**
     * Append a pending entry to EditHistory.p.
     * No cap on p array length — entries are removed when applied.
     * @param {string|Object} edithistory - Existing EditHistory value
     * @param {Object} entry - Pending entry to append
     * @returns {string} Updated EditHistory as JSON string
     */
    static appendToPendingChanges(edithistory, entry) {
        let parsed = this.parseEditHistory(edithistory) || {};
        if (!Array.isArray(parsed.h)) parsed.h = [];
        if (!Array.isArray(parsed.p)) parsed.p = [];
        parsed.p.push(entry);
        return JSON.stringify(parsed);
    }

    /**
     * Get all pending entries from EditHistory.p.
     * @param {string|Object} edithistory - EditHistory value
     * @returns {Array} Pending entries array (may be empty)
     */
    static getPendingEntries(edithistory) {
        const parsed = this.parseEditHistory(edithistory);
        return Array.isArray(parsed?.p) ? parsed.p : [];
    }

    /**
     * Apply a delta or absolute ne value to a current field value.
     * ne strings prefixed with '+' or '-' are treated as numeric deltas.
     * @param {*} currentValue - Current field value on the row
     * @param {string|number} ne - New-value descriptor from pending entry
     * @returns {string} Resulting field value, as a string like every other sheet cell value
     */
    static applyNeValue(currentValue, ne) {
        if (typeof ne === 'string' && /^[+\-]\d/.test(ne)) {
            const current = parseFloat(currentValue) || 0;
            return String(current + parseFloat(ne));
        }
        return ne === undefined || ne === null ? '' : String(ne);
    }

    /**
     * Pure helper — applies all pending changes due on or before referenceDateDeciseconds
     * to a copy of the items array. Does not perform any I/O.
     * Pending entries are sorted ascending by t before application.
     * Applied entries move from p to h (ne dropped, o computed from pre-apply value).
     * @param {Array<Object>} items - Inventory row objects (will be shallow-cloned)
     * @param {number} referenceDateDeciseconds - Cutoff in deciseconds (date only, ignores time)
     * @returns {{ updatedItems: Array<Object>, hasChanges: boolean }}
     */
    static applyPendingChangesToData(items, referenceDateDeciseconds) {
        // Normalise to start-of-day deciseconds for date-only comparison
        const refDate = new Date(referenceDateDeciseconds * 100);
        refDate.setHours(0, 0, 0, 0);
        const refCutoff = Math.floor(refDate.getTime() / 100);

        let hasChanges = false;
        const updatedItems = items.map(item => {
            const parsed = this.parseEditHistory(item.edithistory);
            if (!parsed) return item;

            const pending = Array.isArray(parsed.p) ? parsed.p : [];
            const due = pending.filter(entry => {
                const entryDate = new Date(entry.t * 100);
                entryDate.setHours(0, 0, 0, 0);
                return Math.floor(entryDate.getTime() / 100) <= refCutoff;
            });

            if (due.length === 0) return item;

            // Work on a shallow copy of the row
            const updatedItem = { ...item };
            due.sort((a, b) => a.t - b.t);

            const newHistoryEntries = [];
            for (const entry of due) {
                const historyChanges = [];
                for (const ch of entry.c) {
                    const oldValue = updatedItem[ch.n];
                    const newValue = this.applyNeValue(oldValue, ch.ne);
                    updatedItem[ch.n] = newValue;
                    historyChanges.push({ n: ch.n, o: oldValue });
                }
                // Build h entry — t becomes the change date in history
                newHistoryEntries.unshift({
                    u: entry.u,
                    t: entry.t,
                    d: entry.d,
                    s: entry.s,
                    c: historyChanges
                });
            }

            // Remove applied entries from p, prepend to h (capped)
            const appliedIds = new Set(due.map(e => e));
            const remainingPending = pending.filter(e => !appliedIds.has(e));
            const existingHistory = Array.isArray(parsed.h) ? parsed.h : [];
            const newHistory = [...newHistoryEntries, ...existingHistory].slice(0, MAX_HISTORY_ENTRIES);

            const updatedEditHistory = JSON.stringify({ ...parsed, h: newHistory, p: remainingPending });
            updatedItem.edithistory = updatedEditHistory;

            hasChanges = true;
            return updatedItem;
        });

        return { updatedItems, hasChanges };
    }
}
