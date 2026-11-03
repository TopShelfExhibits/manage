/**
 * Local dev tools for FakeGoogle — installed as `window.fakeGoogle` on localhost only.
 * Run `fakeGoogle.help()` in the browser console.
 *
 * Built for testing EditHistory locally (contract: docs/notes/metadata-implementation.md):
 * inspect raw history cells, simulate CAD writes and the passage of time, switch users,
 * and keep local data across reloads and browser tabs (see FakeGoogleState in FakeGoogle.js).
 */

import { FakeGoogleSheetsService, FakeGoogleState } from '../google_sheets_services/FakeGoogle.js';
import { invalidateCache, stampDataChange, triggerCachePoll } from '../data_management/index.js';

const HISTORY_HEADER = 'EditHistory';
const AUTO_TESTS_STORAGE_KEY = 'fakeGoogle:autoTests';
const DECISECONDS_PER_HOUR = 36000;
const MAX_HISTORY_ENTRIES = 10;

// Sheet header → application field name used in EditHistory `n` (spec: "Change item").
// Headers not listed map 1:1.
const FIELD_NAMES = {
    INVENTORY: { 'ITEM#': 'itemNumber', QTY: 'quantity', Description: 'description', NOTES: 'notes' },
    PACK_LISTS: { MetaData: 'metadata' },
    CACHE: { ID: 'id', Name: 'name', Description: 'description', Page: 'page', Type: 'type', Value: 'value' }
};

const _now = () => Math.floor(Date.now() / 100);
const _formatTime = (deciseconds) => new Date(deciseconds * 100).toLocaleString();

function _parse(cell) {
    if (!cell) return {};
    try { return JSON.parse(cell); } catch { return {}; }
}

function _sheet(table, tab) {
    const sheet = FakeGoogleSheetsService.mockData[table]?.[tab];
    if (!sheet) throw new Error(`No fake sheet ${table}/${tab}. Tabs: ${Object.keys(FakeGoogleSheetsService.mockData[table] || {}).join(', ')}`);
    return sheet;
}

function _historyColumn(sheet) {
    return (sheet[0] || []).map(h => String(h ?? '').trim()).indexOf(HISTORY_HEADER);
}

/** Short label for a row: its first non-empty business cell */
function _rowLabel(sheet, row) {
    const headers = sheet[0] || [];
    for (let col = 0; col < row.length; col++) {
        const header = String(headers[col] ?? '').trim();
        if (header === HISTORY_HEADER || header === 'MetaData') continue;
        if (row[col] !== undefined && String(row[col]).trim() !== '') return String(row[col]).slice(0, 40);
    }
    return '(blank)';
}

function _describeChanges(changes) {
    return (changes || []).map(ch => ch.n === undefined ? JSON.stringify(ch) : `${ch.n}: ${JSON.stringify(ch.o ?? ch.ne)}`).join(', ');
}

/** Reload app data for one tab (or everything) after a raw change, and persist it */
function _commit(table = null, tab = null) {
    if (table && tab) {
        stampDataChange(`database:getData:"${table}","${tab}"`);
        invalidateCache([{ namespace: 'database', methodName: 'getData', args: [table, tab] }], true);
    } else {
        refreshAppData();
    }
    FakeGoogleState.save();
}

/** Drop all cached sheet data so every open view reloads from FakeGoogle */
export function refreshAppData() {
    invalidateCache([
        { namespace: 'database', methodName: 'getData', args: [] },
        { namespace: 'database', methodName: 'getTabs', args: [] }
    ], true);
}

/** Whether the startup test suite should run (default: yes) */
export function autoTestsEnabled() {
    try { return localStorage.getItem(AUTO_TESTS_STORAGE_KEY) !== '0'; } catch { return true; }
}

export const fakeGoogleDevTools = {
    help() {
        console.log(`%cfakeGoogle dev tools%c  (local data: ${FakeGoogleState.isPersistent() ? 'saved across reloads' : 'resets on reload'}, user: ${FakeGoogleState.getUser()})

  Inspect
    fakeGoogle.tabs('PACK_LISTS')                         list tabs of a table
    fakeGoogle.history('INVENTORY', 'FURNITURE', 'CHAIR') summary of EditHistory per row (optional text filter)
    fakeGoogle.rowHistory('INVENTORY', 'FURNITURE', 7)    full history of one sheet row (row 1 = headers)
    fakeGoogle.archive('INVENTORY')                       rows archived to _EditHistory

  Simulate
    fakeGoogle.cadEdit('PACK_LISTS', 'TULIP 2025 NRF', 10, { Description: 'SEGs (14)' })
                                                          external CAD write (adds a s:'cad' entry)
    fakeGoogle.advanceClock(2)                            pretend 2 hours passed (ages history and
                                                          schedules; use 24 * days to make schedules due)
    fakeGoogle.unlockAll()                                clear all sheet locks
    fakeGoogle.setUser('sam@example.com')                 this browser tab's user (reloads; log in again)
    Open a second browser tab to act as another session — local data is shared between tabs.

  Local data
    fakeGoogle.persist(false)                             stop saving local data (true to resume)
    fakeGoogle.reset()                                    discard local changes, back to fixtures
    fakeGoogle.autoTests(false)                           skip the startup test suite (true to resume)
    fakeGoogle.refresh()                                  reload all views from fake data
`, 'font-weight:bold', '');
    },

    tabs(table) {
        return Object.keys(FakeGoogleSheetsService.mockData[table] || {});
    },

    history(table, tab, filter = '') {
        const sheet = _sheet(table, tab);
        const col = _historyColumn(sheet);
        if (col === -1) throw new Error(`${table}/${tab} has no ${HISTORY_HEADER} column`);
        const rows = [];
        for (let r = 1; r < sheet.length; r++) {
            const row = sheet[r] || [];
            if (filter && !row.join(' ').toLowerCase().includes(String(filter).toLowerCase())) continue;
            const eh = _parse(row[col]);
            const latest = eh.h?.[0];
            rows.push({
                row: r + 1,
                label: _rowLabel(sheet, row),
                i: eh.i ?? '',
                entries: eh.h?.length ?? 0,
                latest: latest ? `${latest.u} ${_formatTime(latest.t)} [${latest.s ?? 'web'}]` : '',
                'latest changes (old values)': latest ? (latest.c.length ? _describeChanges(latest.c) : '(created)') : '',
                pending: eh.p?.length ?? 0
            });
        }
        console.table(rows);
        return rows;
    },

    rowHistory(table, tab, rowNumber) {
        const sheet = _sheet(table, tab);
        const row = sheet[rowNumber - 1];
        if (!row || rowNumber < 2) throw new Error(`Row ${rowNumber} not found (row 1 is the header row)`);
        const eh = _parse(row[_historyColumn(sheet)]);
        console.log(`%c${table}/${tab} row ${rowNumber}: ${_rowLabel(sheet, row)}  (i: ${eh.i ?? 'none'})`, 'font-weight:bold');
        console.table((eh.h || []).map(e => ({
            when: _formatTime(e.t), user: e.u, source: e.s ?? 'web',
            changes: e.c.length ? _describeChanges(e.c) : '(created)',
            scheduled: e.d ? _formatTime(e.d) : ''
        })));
        if (eh.p?.length) {
            console.log('%cPending', 'font-weight:bold');
            console.table(eh.p.map(e => ({
                effective: _formatTime(e.t), user: e.u, note: e.s, changes: _describeChanges(e.c), created: _formatTime(e.d)
            })));
        }
        return eh;
    },

    archive(table) {
        const sheet = FakeGoogleSheetsService.mockData[table]?.['_EditHistory'];
        if (!sheet) {
            console.log(`${table} has no _EditHistory tab yet`);
            return [];
        }
        const [headers, ...rows] = sheet;
        const entries = rows.map(row => Object.fromEntries(headers.map((h, n) => [h, row[n]])))
            .map(e => ({ ...e, Timestamp: _formatTime(Number(e.Timestamp)) }));
        console.table(entries.map(({ RowData, ...rest }) => rest));
        return entries;
    },

    /**
     * Simulate an external CAD write following the spec's "Guidance for External Automation":
     * assign i if missing, record old values in a s:'cad' entry, cap history.
     * @param {Object} changes - { sheetHeader: newValue }
     */
    cadEdit(table, tab, rowNumber, changes, user = 'cadbot') {
        const sheet = _sheet(table, tab);
        const headers = (sheet[0] || []).map(h => String(h ?? '').trim());
        const row = sheet[rowNumber - 1];
        if (!row || rowNumber < 2) throw new Error(`Row ${rowNumber} not found (row 1 is the header row)`);
        const col = _historyColumn(sheet);
        if (col === -1) throw new Error(`${table}/${tab} has no ${HISTORY_HEADER} column`);

        const fieldNames = FIELD_NAMES[table] || {};
        const recorded = [];
        for (const [header, value] of Object.entries(changes)) {
            const target = headers.indexOf(header);
            if (target === -1) throw new Error(`No column "${header}". Columns: ${headers.join(', ')}`);
            const old = row[target] ?? '';
            if (String(old) === String(value)) continue;
            row[target] = value;
            recorded.push({ n: fieldNames[header] || header, o: old });
        }
        if (recorded.length === 0) return console.log('No changes');

        const eh = _parse(row[col]);
        if (!Number.isInteger(eh.i)) {
            const maxIndex = sheet.slice(1).reduce((max, r) => Math.max(max, _parse(r[col]).i || 0), 0);
            eh.i = maxIndex + 1;
        }
        eh.h = [{ u: user, t: _now(), s: 'cad', c: recorded }, ...(eh.h || [])].slice(0, MAX_HISTORY_ENTRIES);
        row[col] = JSON.stringify(eh);
        _commit(table, tab);
        return this.rowHistory(table, tab, rowNumber);
    },

    /** Pretend `hours` have passed: ages every history entry and scheduled change in all tables */
    advanceClock(hours) {
        const shift = Math.round(hours * DECISECONDS_PER_HOUR);
        let cells = 0;
        for (const tabs of Object.values(FakeGoogleSheetsService.mockData)) {
            for (const sheet of Object.values(tabs)) {
                const col = _historyColumn(sheet);
                if (col === -1) continue;
                for (let r = 1; r < sheet.length; r++) {
                    if (!sheet[r]?.[col]) continue;
                    const eh = _parse(sheet[r][col]);
                    for (const entry of [...(eh.h || []), ...(eh.p || [])]) {
                        if (typeof entry.t === 'number') entry.t -= shift;
                        if (typeof entry.d === 'number') entry.d -= shift;
                    }
                    sheet[r][col] = JSON.stringify(eh);
                    cells++;
                }
            }
        }
        _commit();
        console.log(`Aged ${cells} EditHistory cells by ${hours} hour(s). Reopen an inventory table to apply schedules now due.`);
        return cells;
    },

    unlockAll() {
        const locks = FakeGoogleSheetsService.mockData.CACHE?.Locks;
        if (!locks) return 0;
        let cleared = 0;
        for (let r = 1; r < locks.length; r++) {
            for (let c = 1; c < locks[r].length; c++) {
                if (locks[r][c] && locks[r][c] !== '0') { locks[r][c] = '0'; cleared++; }
            }
        }
        _commit('CACHE', 'Locks');
        console.log(`Cleared ${cleared} lock(s)`);
        return cleared;
    },

    setUser(email) {
        FakeGoogleState.setUser(email);
        console.log(`This tab's user is now ${FakeGoogleState.getUser()}. Reloading — log in again.`);
        location.reload();
    },

    persist(enabled = true) {
        FakeGoogleState.setPersistent(enabled);
        console.log(enabled ? 'Local data is saved across reloads.' : 'Local data now resets on reload.');
    },

    reset() {
        FakeGoogleState.reset();
        refreshAppData();
        console.log('Local data reset to fixtures.');
    },

    autoTests(enabled = true) {
        try { localStorage.setItem(AUTO_TESTS_STORAGE_KEY, enabled ? '1' : '0'); } catch {}
        console.log(enabled ? 'Startup tests will run on load.' : 'Startup tests skipped on load.');
    },

    refresh() {
        refreshAppData();
    }
};

export function installFakeGoogleDevTools() {
    window.fakeGoogle = fakeGoogleDevTools;
    // Another browser tab changed the shared local data: let the cache poller reload what changed
    FakeGoogleState.onExternalChange(() => triggerCachePoll());
    console.log('%cfakeGoogle dev tools ready — run fakeGoogle.help()', 'color:#6366f1');
}
