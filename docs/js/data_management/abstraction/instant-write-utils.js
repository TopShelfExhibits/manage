import { Database, EditHistoryUtils, normalizeHeaderName } from '../index.js';
import { isCheckedValue, checkboxWriteValue } from '../utils/checkbox-values.js';

/**
 * Instant (single-cell, verified) writes — views-and-renderers-plan §4.16, Phase 2.
 *
 * Everything an instant-write page needs from the sheet lives in the live database:
 *   CACHE/Preferences  InstantWriteTables  { "<database>/<tab>": { identity: [...], columns: { name: type } } }
 *   CACHE/ShowNotes    Identifier | Note | EditHistory   (show notes, keyed by computeIdentifier)
 *
 * writeCellsVerified locates each target by identity (row) and header name (column), never by
 * position, resolving both to live sheet indices just before writing. A batch of cells (any rows
 * of one tab) goes through the same steps together, so a batch costs the same few requests as
 * one cell:
 *   1. refuse columns not listed in the preference
 *   2. read the live sheet; locate each row by identity (0 matches → fail, >1 → fail, never guess)
 *   3. read the header and the exact rows; skip any row that no longer matches (retried)
 *   4. write only the cells that differ from the desired value, in one request (a formula cell is
 *      replaced by the value). Every write therefore changes its cell, which step 5 relies on
 *   5. re-read the header and rows to verify. A row or column that moved while the write was in
 *      flight is re-located and retried once. If the move happened before the write landed, the
 *      value went to the cell that took the target's place; that cell's row is found in the
 *      step 2 read by its other cells (by column name) and its value restored, or, when the row or
 *      column wasn't there before (added mid-write), the result carries a warning to check it
 * writeCellVerified is the one-cell form. checkSheetHealth reports, read-only, whether a tab is
 * in a state these writes can rely on.
 */

const PREFERENCES_MAPPING = { id: 'ID', name: 'Name', description: 'Description', page: 'Page', type: 'Type', value: 'Value', editHistory: 'EditHistory' };
const SHOW_NOTES_TAB = 'ShowNotes';
const SHOW_NOTES_HEADERS = ['Identifier', 'Note', 'EditHistory'];

/** Values are compared trimmed and case-insensitively against the raw sheet values. */
export function sameValue(a, b) {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

export { isCheckedValue, checkboxWriteValue };

function headerIndex(headerRow, name) {
    const target = normalizeHeaderName(name).toLowerCase();
    return (headerRow || []).findIndex(h => normalizeHeaderName(h).toLowerCase() === target);
}

function parseJsonPreference(prefs, id, fallback) {
    const pref = (prefs || []).find(p => p.id === id);
    if (!pref || pref.value === undefined || pref.value === null || pref.value === '') return fallback;
    try { return JSON.parse(pref.value); } catch { return fallback; }
}

/** Map of normalized lowercase header name → cell value for one row (first column wins on duplicate names). */
function namedValues(header, line) {
    const map = new Map();
    (header || []).forEach((h, c) => {
        const name = normalizeHeaderName(h ?? '').toLowerCase();
        if (name && !map.has(name)) map.set(name, String(line?.[c] ?? ''));
    });
    return map;
}

/** Whether a row equals the named values in every column both sides have, except the excluded names. */
function rowMatchesNamed(line, header, named, exclude) {
    if (!line) return false;
    let compared = 0;
    const seen = new Set();
    for (let c = 0; c < (header || []).length; c++) {
        const name = normalizeHeaderName(header[c] ?? '').toLowerCase();
        if (!name || seen.has(name) || exclude.has(name) || !named.has(name)) continue;
        seen.add(name);
        if (String(line[c] ?? '') !== named.get(name)) return false;
        compared++;
    }
    return compared > 0;
}

export class InstantWriteUtils {
    /**
     * The InstantWriteTables entry for a database/tab, or null.
     * @returns {Promise<{ identity: string[], columns: Object<string,string> }|null>}
     */
    static async getInstantWriteConfig(database, tab) {
        const prefs = await Database.getData('CACHE', 'Preferences', PREFERENCES_MAPPING);
        const all = parseJsonPreference(prefs, 'InstantWriteTables', {});
        const entry = all && all[`${database}/${tab}`];
        if (!entry || !Array.isArray(entry.identity) || !entry.identity.length || !entry.columns) return null;
        return { identity: entry.identity, columns: entry.columns };
    }

    /** Read a JSON preference by id (page-level reads: DesignQueueFields, DesignQueueAssignees). */
    static async getJsonPreference(id, fallback = null) {
        const prefs = await Database.getData('CACHE', 'Preferences', PREFERENCES_MAPPING);
        return parseJsonPreference(prefs, id, fallback);
    }

    /**
     * Locate a row by identity in a raw sheet (header row first).
     * @returns {{ status: 'ok'|'not-found'|'duplicate'|'no-identity-columns', rowIndex?: number, idCols?: number[] }}
     */
    static locateRow(raw, identity, rowObj) {
        const header = raw?.[0] || [];
        const idCols = identity.map(name => headerIndex(header, name));
        if (idCols.some(i => i < 0)) return { status: 'no-identity-columns' };
        const wanted = identity.map(name => rowObj?.[name]);
        if (wanted.every(v => v === undefined || v === null || String(v).trim() === '')) return { status: 'not-found' };
        const hits = [];
        for (let r = 1; r < raw.length; r++) {
            const line = raw[r] || [];
            if (idCols.every((c, k) => sameValue(line[c], wanted[k]))) hits.push(r);
        }
        if (hits.length === 0) return { status: 'not-found', idCols };
        if (hits.length > 1) return { status: 'duplicate', idCols };
        return { status: 'ok', rowIndex: hits[0], idCols };
    }

    /**
     * Verified single-cell write by identity (writeCellsVerified with one cell).
     * @param {string} database   e.g. 'PROD_SCHED'
     * @param {string} tab        e.g. 'Production Schedule'
     * @param {Object} rowObj     the loaded row (keys = normalized header names), used for identity values
     * @param {string} column     header name of the target column
     * @param {string} value      the value to write (checkbox: 'X' or '')
     * @returns {Promise<{ ok: boolean, reason?: string, value?: string, rowNumber?: number, warning?: string }>}
     */
    static async writeCellVerified(database, tab, rowObj, column, value) {
        const [result] = await InstantWriteUtils.writeCellsVerified(database, tab, [{ row: rowObj, column, value }]);
        return result;
    }

    /**
     * Verified writes of several cells of one tab, by identity, as one batch (see the steps above).
     * @param {string} database
     * @param {string} tab
     * @param {Array<{ row: Object, column: string, value: string }>} items
     * @returns {Promise<Array<{ ok: boolean, reason?: string, value?: string, rowNumber?: number, warning?: string }>>}
     *          one result per item, in order. `warning` reports another row the batch may have changed.
     */
    static async writeCellsVerified(database, tab, items) {
        const list = Array.isArray(items) ? items : [];
        const results = new Array(list.length).fill(null);
        const config = await InstantWriteUtils.getInstantWriteConfig(database, tab);
        if (!config) return list.map(() => ({ ok: false, reason: 'no-config' }));

        // Refuse unlisted columns; the same cell twice in one batch: the last value wins
        let todo = [];
        const lastForCell = new Map();
        list.forEach((it, i) => {
            if (!Object.keys(config.columns).some(c => sameValue(c, it?.column))) {
                results[i] = { ok: false, reason: 'column-not-writable' };
                return;
            }
            const cellKey = config.identity.map(n => String(it.row?.[n] ?? '').trim().toLowerCase()).join('\u0001')
                + '\u0002' + normalizeHeaderName(it.column).toLowerCase();
            if (lastForCell.has(cellKey)) results[lastForCell.get(cellKey)] = { ok: false, reason: 'superseded' };
            lastForCell.set(cellKey, i);
        });
        todo = [...lastForCell.values()].sort((a, b) => a - b);

        const warnings = new Map();
        for (let round = 0; round < 2 && todo.length; round++) {
            const lastRound = round === 1;
            const outcome = await InstantWriteUtils._writeRound(database, tab, config, list, todo);
            todo = [];
            for (const [i, r] of outcome) {
                if (r.warning) warnings.set(i, [warnings.get(i), r.warning].filter(Boolean).join(' '));
                if (r.retry && !lastRound) { todo.push(i); continue; }
                const { retry, warning, ...final } = r;
                results[i] = final;
            }
        }
        for (const [i, w] of warnings) if (results[i]) results[i].warning = w;
        return results;
    }

    /** One locate → check → write → verify pass over the given item indices. @private */
    static async _writeRound(database, tab, config, list, indices) {
        const out = new Map();
        const raw = await Database.readFresh(database, tab);
        const header = raw?.[0] || [];

        // Locate every target in one full read
        const plan = [];
        for (const i of indices) {
            const { row, column, value } = list[i];
            const colIdx = headerIndex(header, column);
            if (colIdx < 0) { out.set(i, { ok: false, reason: 'column-missing' }); continue; }
            const loc = InstantWriteUtils.locateRow(raw, config.identity, row);
            if (loc.status !== 'ok') { out.set(i, { ok: false, reason: loc.status }); continue; }
            plan.push({ i, row, column, colIdx, idCols: loc.idCols, rowNumber: loc.rowIndex + 1, desired: value ?? '' });
        }
        if (!plan.length) return out;

        const width = Math.max(header.length, ...plan.map(p => p.colIdx + 1));
        const lastCol = Database.columnLetter(width);
        const rangeOf = n => Database.a1Range(tab, `A${n}:${lastCol}${n}`);
        const identityAt = (line, p) => p.idCols.every((c, k) => sameValue(line?.[c], p.row?.[config.identity[k]]));
        // The header still names the identity and target columns where step 2 found them
        const headerHolds = (line, p) => sameValue(normalizeHeaderName(line?.[p.colIdx] ?? ''), normalizeHeaderName(header[p.colIdx]))
            && p.idCols.every(c => sameValue(normalizeHeaderName(line?.[c] ?? ''), normalizeHeaderName(header[c])));
        const readRows = async (numbers) => {
            const blocks = await Database.readFreshRanges(database, [rangeOf(1), ...numbers.map(rangeOf)]);
            return { head: blocks[0]?.[0] || [], byRow: new Map(numbers.map((n, k) => [n, blocks[k + 1]?.[0] || []])) };
        };

        // Read the header and the exact rows just before writing; skip any that no longer match.
        // A cell that already holds its value needs no write, so every write below changes its cell
        // (verification can then tell where a write landed).
        const rowNumbers = [...new Set(plan.map(p => p.rowNumber))];
        const before = await readRows(rowNumbers);
        const writes = [];
        for (const p of plan) {
            const line = before.byRow.get(p.rowNumber);
            if (!headerHolds(before.head, p) || !identityAt(line, p)) {
                out.set(p.i, { ok: false, reason: 'moved', retry: true });
                continue;
            }
            if (String(line[p.colIdx] ?? '') === String(p.desired)) {
                out.set(p.i, { ok: true, value: p.desired, rowNumber: p.rowNumber });
                continue;
            }
            writes.push(p);
        }
        if (!writes.length) return out;

        await Database.setCellValues(database, tab, writes.map(p => ({ rowNumber: p.rowNumber, columnNumber: p.colIdx + 1, value: p.desired })));

        // Re-read the header and rows to verify
        const after = await readRows([...new Set(writes.map(p => p.rowNumber))]);
        const displaced = [];
        for (const p of writes) {
            const line = after.byRow.get(p.rowNumber);
            if (!headerHolds(after.head, p) || !identityAt(line, p)) {
                displaced.push({ ...p, afterHead: after.head, afterLine: line });
                continue;
            }
            if (String(line[p.colIdx] ?? '') !== String(p.desired)) {
                out.set(p.i, { ok: false, reason: 'verify-failed', retry: true });
                continue;
            }
            out.set(p.i, { ok: true, value: p.desired, rowNumber: p.rowNumber });
        }
        if (displaced.length) {
            // Columns whose cells this batch may have changed: every target column, and every column
            // a write landed in by the verify read's header (a shifted write fills a neighbour).
            // Rows are matched on their other cells only.
            const batchColumns = new Set([
                ...list.map(it => normalizeHeaderName(it?.column ?? '').toLowerCase()),
                ...writes.map(w => normalizeHeaderName(after.head[w.colIdx] ?? '').toLowerCase())
            ].filter(Boolean));
            for (const [i, r] of await InstantWriteUtils._resolveDisplaced(database, tab, config, raw, displaced, batchColumns, writes)) out.set(i, r);
        }
        return out;
    }

    /**
     * Rows or columns moved between the pre-write read and the verify read. Each displaced write
     * changed its cell (unchanged cells aren't written), so:
     *   - the intended row now holds the value, and no other write of this round put that value
     *     in that column → the write landed there before the move (done);
     *   - otherwise the value went to the cell that sat at that position: the verify read shows
     *     which row and column that is. The row is found in the step 2 read by its other cells
     *     (matched by column name, so a shifted column or a duplicate identity still matches) and
     *     its old value restored; a row or column that wasn't there before is reported instead.
     *     The intended row is then retried. @private
     */
    static async _resolveDisplaced(database, tab, config, raw, displaced, batchColumns, writes) {
        // How many writes of this round put each value in each column: when two did, a displaced
        // one may have filled the other's row, so "the row holds the value" proves nothing
        const sameWriteCount = new Map();
        for (const w of writes) {
            const k = normalizeHeaderName(w.column).toLowerCase() + '\u0001' + String(w.desired);
            sameWriteCount.set(k, (sameWriteCount.get(k) || 0) + 1);
        }
        const out = new Map();
        const fresh = await Database.readFresh(database, tab);
        const freshHeader = fresh?.[0] || [];
        const rawHeader = raw?.[0] || [];
        const describe = (named) => config.identity.map(n => named.get(normalizeHeaderName(n).toLowerCase())).filter(v => String(v ?? '').trim()).join(' / ') || 'a row without identity';

        for (const p of displaced) {
            const colNow = headerIndex(freshHeader, p.column);
            const own = InstantWriteUtils.locateRow(fresh, config.identity, p.row);
            const onlyWriter = sameWriteCount.get(normalizeHeaderName(p.column).toLowerCase() + '\u0001' + String(p.desired)) === 1;
            if (onlyWriter && own.status === 'ok' && colNow >= 0 && String(fresh[own.rowIndex][colNow] ?? '') === String(p.desired)) {
                out.set(p.i, { ok: true, value: p.desired, rowNumber: own.rowIndex + 1 });
                continue;
            }

            let warning = '';
            const afterLine = p.afterLine || [];
            if (String(afterLine[p.colIdx] ?? '') === String(p.desired)) {
                // The cell that received the value: its column by name, its row by the other cells
                const victimCol = normalizeHeaderName(p.afterHead?.[p.colIdx] ?? '').toLowerCase();
                const named = namedValues(p.afterHead, afterLine);
                const exclude = new Set([...batchColumns, victimCol]);
                const matches = (line, header) => rowMatchesNamed(line, header, named, exclude);
                const rawCol = headerIndex(rawHeader, victimCol);
                const hits = [];
                for (let r = 1; r < raw.length; r++) if (matches(raw[r], rawHeader)) hits.push(r);
                if (rawCol < 0) {
                    warning = `Saving ${p.column} may have written "${p.desired}" into a column added while saving (row ${describe(named)}); check that row.`;
                } else if (hits.length !== 1) {
                    warning = `Saving ${p.column} may have written "${p.desired}" into ${victimCol} of ${describe(named)}${hits.length ? '' : ', a row added while saving'}; check that row.`;
                } else {
                    const original = String(raw[hits[0]][rawCol] ?? '');
                    if (original !== String(p.desired)) {
                        const restored = await InstantWriteUtils._restoreCell(database, tab, matches, victimCol, String(p.desired), original);
                        if (!restored) warning = `Saving ${p.column} may have changed ${victimCol} of ${describe(named)} (was "${original}"); check that row.`;
                    }
                }
            }
            out.set(p.i, { ok: false, reason: 'moved', retry: true, ...(warning ? { warning } : {}) });
        }
        return out;
    }

    /**
     * Put `original` back into one cell of the single row that matches(line, header), only while
     * the cell still holds `expected`; verified. @returns {Promise<boolean>} false if it couldn't. @private
     */
    static async _restoreCell(database, tab, matches, column, expected, original) {
        const raw = await Database.readFresh(database, tab);
        const header = raw?.[0] || [];
        const colIdx = headerIndex(header, column);
        if (colIdx < 0) return false;
        const hits = [];
        for (let r = 1; r < raw.length; r++) if (matches(raw[r], header)) hits.push(r);
        if (hits.length !== 1) return false;
        if (String(raw[hits[0]][colIdx] ?? '') !== expected) return true; // changed since: leave it
        const rowNumber = hits[0] + 1;
        const range = Database.a1Range(tab, `A${rowNumber}:${Database.columnLetter(Math.max(header.length, colIdx + 1))}${rowNumber}`);
        const [before] = await Database.readFreshRanges(database, [range]);
        if (!matches(before?.[0], header) || String(before?.[0]?.[colIdx] ?? '') !== expected) return false;
        await Database.setCellValues(database, tab, [{ rowNumber, columnNumber: colIdx + 1, value: original }]);
        const [after] = await Database.readFreshRanges(database, [range]);
        return matches(after?.[0], header) && String(after?.[0]?.[colIdx] ?? '') === original;
    }

    /**
     * Read-only health check of an instant-write tab: can writes by identity rely on it?
     * @returns {Promise<{ ok: boolean, issues: Array<{ kind: string, message: string, rows?: number[] }> }>}
     *          rows are 1-based sheet rows
     */
    static async checkSheetHealth(database, tab) {
        const issues = [];
        const config = await InstantWriteUtils.getInstantWriteConfig(database, tab);
        if (!config) return { ok: false, issues: [{ kind: 'no-config', message: `No InstantWriteTables entry for ${database}/${tab}` }] };
        const raw = await Database.readFresh(database, tab);
        const header = raw?.[0] || [];
        if (!header.length || header.every(h => !String(h ?? '').trim())) {
            return { ok: false, issues: [{ kind: 'no-header', message: `${tab} has no header row` }] };
        }

        // Header names must be unique (columns are found by name)
        const seen = new Map();
        header.forEach((h, c) => {
            const name = normalizeHeaderName(h).toLowerCase();
            if (!name) return;
            if (seen.has(name)) issues.push({ kind: 'duplicate-header', message: `Header "${normalizeHeaderName(h)}" appears in columns ${Database.columnLetter(seen.get(name) + 1)} and ${Database.columnLetter(c + 1)}` });
            else seen.set(name, c);
        });
        const idCols = config.identity.map(n => headerIndex(header, n));
        config.identity.forEach((n, k) => { if (idCols[k] < 0) issues.push({ kind: 'missing-identity-column', message: `Identity column "${n}" is missing` }); });
        Object.keys(config.columns).forEach(n => { if (headerIndex(header, n) < 0) issues.push({ kind: 'missing-writable-column', message: `Writable column "${n}" is missing` }); });

        if (idCols.every(c => c >= 0)) {
            const byIdentity = new Map();
            for (let r = 1; r < raw.length; r++) {
                const line = raw[r] || [];
                if (!line.some(v => String(v ?? '').trim())) continue; // blank row
                const parts = idCols.map(c => String(line[c] ?? '').trim().toLowerCase());
                if (parts.every(v => !v)) {
                    issues.push({ kind: 'blank-identity', message: `Row ${r + 1} has data but no identity`, rows: [r + 1] });
                    continue;
                }
                const key = parts.join('\u0001');
                if (!byIdentity.has(key)) byIdentity.set(key, []);
                byIdentity.get(key).push(r + 1);
            }
            for (const [key, rows] of byIdentity) {
                if (rows.length > 1) issues.push({ kind: 'duplicate-identity', message: `Rows ${rows.join(', ')} share the identity ${key.split('\u0001').join(' / ')}`, rows });
            }
        }
        return { ok: issues.length === 0, issues };
    }

    /** All show notes as [{ Identifier, Note, EditHistory }] (cached read). */
    static async getShowNotes() {
        try {
            const data = await Database.getData('CACHE', SHOW_NOTES_TAB, { Identifier: 'Identifier', Note: 'Note', EditHistory: 'EditHistory' });
            return Array.isArray(data) ? data.filter(r => r && r.Identifier) : [];
        } catch (e) {
            console.warn('[InstantWriteUtils] ShowNotes tab unavailable:', e?.message || e);
            return [];
        }
    }

    /**
     * Upsert one show note: update the note row if it exists, append one otherwise, then verify.
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    static async saveShowNote(identifier, text, username = null) {
        if (!identifier) return { ok: false, reason: 'no-identifier' };
        const note = text ?? '';
        const raw = await Database.readFresh('CACHE', SHOW_NOTES_TAB);
        const header = raw?.[0] || [];
        if (!header.length || header.every(h => !h)) return { ok: false, reason: 'no-show-notes-tab' };
        const idCol = headerIndex(header, 'Identifier');
        const noteCol = headerIndex(header, 'Note');
        const histCol = headerIndex(header, 'EditHistory');
        if (idCol < 0 || noteCol < 0) return { ok: false, reason: 'show-notes-headers' };

        const matches = [];
        for (let r = 1; r < raw.length; r++) if (sameValue(raw[r]?.[idCol], identifier)) matches.push(r);
        if (matches.length > 1) return { ok: false, reason: 'duplicate' };

        let history = '';
        if (username) {
            const oldNote = matches.length ? (raw[matches[0]][noteCol] ?? '') : '';
            const changes = EditHistoryUtils.calculateRowDiff({ Note: oldNote }, { Note: note });
            if (changes.length) {
                const entry = EditHistoryUtils.createEditHistoryEntry(username, changes, 'web');
                history = EditHistoryUtils.appendToEditHistory(matches.length && histCol >= 0 ? (raw[matches[0]][histCol] ?? '') : '', entry);
            }
        }

        let rowNumber;
        if (matches.length === 1) {
            rowNumber = matches[0] + 1;
            await Database.setCellValue('CACHE', SHOW_NOTES_TAB, rowNumber, noteCol + 1, note);
            if (history && histCol >= 0) await Database.setCellValue('CACHE', SHOW_NOTES_TAB, rowNumber, histCol + 1, history);
        } else {
            const values = new Array(Math.max(header.length, SHOW_NOTES_HEADERS.length)).fill('');
            values[idCol] = identifier;
            values[noteCol] = note;
            if (histCol >= 0) values[histCol] = history;
            rowNumber = await Database.appendSheetRow('CACHE', SHOW_NOTES_TAB, values);
        }

        const lastCol = Database.columnLetter(Math.max(header.length, noteCol + 1));
        const after = await Database.readFresh('CACHE', `${SHOW_NOTES_TAB}!A${rowNumber}:${lastCol}${rowNumber}`);
        const line = after?.[0] || [];
        if (!sameValue(line[idCol], identifier) || String(line[noteCol] ?? '') !== String(note)) {
            return { ok: false, reason: 'verify-failed' };
        }
        return { ok: true };
    }
}
