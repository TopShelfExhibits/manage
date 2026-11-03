import { undoRegistry } from './undoRegistry.js';
import { escapeHtml } from './views/fieldFormat.js';
import { isCheckedValue } from '../../data_management/utils/checkbox-values.js';
import { describeWriteFailure, joinKey } from '../../data_management/utils/instant-write-config.js';

/**
 * Cell edits — how tables edit, in both edit modes (views-and-renderers-plan §4.16).
 *
 * Both modes keep one state per cell, which the table shows as a class (`cell-<state>`):
 *   'unsaved'  batch: differs from the loaded row and isn't saved yet
 *              instant: queued or being written
 *   'failed'   instant: the write failed and the value was reverted (shown for a few seconds)
 *
 * useBatchEdits    Edits are held until Save. Each edit goes to the page (cell-edit), which
 *                  updates its rows; this tracks the changed cells, nested tables' changes,
 *                  revert, and the undo snapshots taken while typing. One per table.
 * useInstantEdits  Edits are written by the page after a short delay, in verified batches; the
 *                  cell shows the new value at once, on an overlay of the rows. One per DataView,
 *                  which holds the page's write hooks and feeds the overlaid rows to the renderer.
 *
 * Usage: create in setup() (the computeds belong to the component), e.g.
 *   setup(props, { emit }) { return { batchEdits: useBatchEdits({ rows: () => props.data, ... }) }; }
 */

/** Delay before an instant edit is written; every edit restarts it, so nearby edits share a batch. */
export const INSTANT_WRITE_DELAY_MS = 1200;
// A snapshot is taken before the first edit, and again after this long without edits
const UNDO_IDLE_MS = 5000;
// A saved instant edit's overlay is dropped after this long even if the reload never arrives
const SAVED_OVERLAY_MS = 20000;
// How long a failed instant edit keeps its failed state
const FAILED_STATE_MS = 6000;

// ── Shared ──────────────────────────────────────────────────────────────────

// Mark or unmark map[rowIndex][key]
function mark(map, rowIndex, key, on) {
    if (on) {
        if (!map[rowIndex]) map[rowIndex] = {};
        map[rowIndex][key] = true;
        return;
    }
    if (!map[rowIndex]) return;
    delete map[rowIndex][key];
    if (!Object.keys(map[rowIndex]).length) delete map[rowIndex];
}

function anyMarked(map) {
    return Object.values(map).some(cells => Object.keys(cells).length > 0);
}

// ── Batch ───────────────────────────────────────────────────────────────────

/**
 * Batch edits for one table.
 * @param {Object} host
 * @param {() => Array} host.rows               the table's rows (the page's array)
 * @param {() => Array} host.originalRows       the loaded rows, by index
 * @param {() => string|null} host.rowKey       dotted path matching rows to loaded rows (else by index)
 * @param {() => string|null} host.undoRoute    the route for undo snapshots, or null for none
 * @param {(rowIndex, key, value) => void} host.emitEdit   reports an edit to the page (cell-edit)
 */
export function useBatchEdits(host) {
    // [rowIndex][key] → true: cells this table changed; cells whose nested table changed
    const state = Vue.reactive({ changed: {}, nested: {} });
    const hasUnsaved = Vue.computed(() => anyMarked(state.changed) || anyMarked(state.nested));
    const undo = { captured: false, lastEdit: 0, idleTimer: null };

    const rowKeyValue = (row) => {
        const path = host.rowKey();
        if (!path || !row) return undefined;
        return path.split('.').reduce((obj, key) => obj?.[key], row);
    };
    const hasKey = (v) => v !== undefined && v !== null && v !== '';
    const originalsByKey = Vue.computed(() => {
        const originals = host.originalRows();
        if (!host.rowKey() || !Array.isArray(originals)) return null;
        const map = new Map();
        originals.forEach(row => {
            const v = rowKeyValue(row);
            if (hasKey(v)) map.set(String(v), row);
        });
        return map;
    });

    /** The loaded row for a row: by rowKey when the table has one, else by index. */
    function originalRow(row, rowIndex) {
        if (originalsByKey.value) {
            const v = rowKeyValue(row);
            return hasKey(v) ? originalsByKey.value.get(String(v)) : undefined;
        }
        return host.originalRows()?.[rowIndex];
    }

    function originalValue(row, rowIndex, key) {
        return originalRow(row, rowIndex)?.[key];
    }

    function isChanged(rowIndex, key) {
        return !!state.changed[rowIndex]?.[key];
    }

    /** 'unsaved' when the cell (or the nested table inside it) changed, else ''. */
    function cellState(rowIndex, key) {
        return isChanged(rowIndex, key) || state.nested[rowIndex]?.[key] ? 'unsaved' : '';
    }

    // Typing makes one undo step: a snapshot before the first edit and after each idle gap; a
    // snapshot that ends up changing nothing is dropped once the typing stops
    function snapshotForUndo(rowIndex, key) {
        const route = host.undoRoute();
        if (!route) return;
        const now = Date.now();
        if (!undo.captured || now - undo.lastEdit >= UNDO_IDLE_MS) {
            undoRegistry.clearCurrentEditCapture();
            undoRegistry.capture(host.rows(), route, { type: 'cell-edit', cellInfo: { rowIndex, columnKey: key }, preventDuplicates: true });
            undo.captured = true;
        }
        clearTimeout(undo.idleTimer);
        undo.idleTimer = setTimeout(() => {
            undo.idleTimer = null;
            undoRegistry.discardLastSnapshotIfUnchanged(host.rows(), route);
        }, UNDO_IDLE_MS);
        undo.lastEdit = now;
    }

    /** An edit: undo snapshot, report it to the page, mark the cell (unmarked when back to loaded). */
    function edit(rowIndex, key, value) {
        snapshotForUndo(rowIndex, key);
        host.emitEdit(rowIndex, key, value);
        mark(state.changed, rowIndex, key, value !== originalValue(host.rows()?.[rowIndex], rowIndex, key));
    }

    /** Put a cell back to its loaded value (an undoable step). */
    function revert(rowIndex, key) {
        const rows = host.rows();
        const route = host.undoRoute();
        if (route) undoRegistry.capture(rows, route, { type: 'cell-revert', cellInfo: { rowIndex, columnKey: key } });
        const value = originalValue(rows[rowIndex], rowIndex, key);
        if (rows[rowIndex]) rows[rowIndex][key] = value;
        mark(state.changed, rowIndex, key, false);
        host.emitEdit(rowIndex, key, value);
    }

    /** Leaving a cell ends its undo step: the next edit takes a new snapshot. */
    function endEdit() {
        undo.captured = false;
        undo.lastEdit = 0;
        undoRegistry.clearCurrentEditCapture();
        clearTimeout(undo.idleTimer);
        undo.idleTimer = null;
    }

    /**
     * Compare every row with its loaded row (originalRow) after rows change: the editable keys, and
     * the hidden metadata (marked under key -1, so the table counts as changed without a cell).
     * Rows added, removed or moved mark row -1, so Save sees the change without marking cells.
     */
    function compareAll(editableKeys) {
        const changed = {};
        const rows = host.rows();
        const originals = host.originalRows();
        if (Array.isArray(rows) && Array.isArray(originals)) {
            rows.forEach((row, rowIndex) => {
                const original = originalRow(row, rowIndex);
                const differs = (key) => row?.[key] !== (original ? original[key] : null);
                for (const key of editableKeys) if (differs(key)) mark(changed, rowIndex, key, true);
                if (row && Object.prototype.hasOwnProperty.call(row, 'metadata') && differs('metadata')) mark(changed, rowIndex, -1, true);
            });
            const moved = rows.length !== originals.length || rows.some((row, i) => originalRow(row, i) !== originals[i]);
            if (moved) mark(changed, -1, 'rows', true);
        }
        state.changed = changed;
    }

    /** A nested table inside a cell reports whether it has changes. */
    function setNested(rowIndex, key, isChangedNow) {
        mark(state.nested, rowIndex, key, isChangedNow);
    }

    function clearNested() {
        state.nested = {};
    }

    function dispose() {
        clearTimeout(undo.idleTimer);
    }

    return { state, hasUnsaved, cellState, isChanged, originalRow, originalValue, edit, revert, endEdit, compareAll, setNested, clearNested, dispose };
}

// ── Instant ─────────────────────────────────────────────────────────────────

/**
 * Instant edits for one DataView. An edit shows at once (overlay) and is held for the write delay;
 * one timer for the whole table restarts on every edit, so nearby edits are written together. A
 * cell returned to its loaded value within the delay is dropped. One batch is in flight at a time;
 * a newer edit to a cell being written is written next. Failures revert the cell, show one error
 * and ask the page to refresh; warnings (another row may have changed) are shown too. Queued
 * writes flush on stop(), and a leave prompt guards closing the tab while writes are queued.
 * @param {Object} host
 * @param {() => boolean} host.enabled           instant editing is on (mode, rowId and commitCells present)
 * @param {() => Array} host.rows                the loaded rows
 * @param {(row) => string} host.rowId           the row's identity (cells are keyed by it and the field key)
 * @param {(entries) => Promise<Array>} host.commitCells  the page's write: [{ row, key, value }] →
 *                                               [{ ok, reason, warning }], one result per entry
 * @param {(row) => Object} host.derive          recomputes the page's derived fields on an edited row
 * @param {(key) => Object|undefined} host.field the field for a key (checkbox comparison, labels)
 * @param {() => number} host.delay              the write delay in ms
 * @param {() => Object|null} host.modal         { error(message, title), alert(message, title, ...) }
 * @param {() => void} host.refresh              asks the page to reload (after a failure)
 */
export function useInstantEdits(host) {
    // joinKey(rowId, key) → { id, key, value, original, row, status: 'queued'|'writing'|'saved', next? }
    const pending = Vue.reactive({});
    // joinKey(rowId, key) → true while the failed state shows
    const failed = Vue.reactive({});
    const hasQueued = Vue.computed(() => Object.values(pending).some(p => p.status === 'queued' || p.status === 'writing'));
    let flushTimer = null;
    let flushing = null;
    let flushAgain = false;

    const cellKey = (id, key) => joinKey(id, key);
    const loadedRow = (id) => host.rows().find(r => host.rowId(r) === id) || null;

    function sameValue(key, a, b) {
        if (host.field(key)?.type === 'checkbox') return isCheckedValue(a) === isCheckedValue(b);
        return String(a ?? '').trim() === String(b ?? '').trim();
    }

    /** The rows with edits shown: an edited row is a copy with the new values, re-derived. */
    function overlay(rows) {
        const list = Object.values(pending);
        if (!list.length) return rows;
        const byRow = new Map();
        for (const p of list) {
            if (!byRow.has(p.id)) byRow.set(p.id, {});
            byRow.get(p.id)[p.key] = p.value;
        }
        return rows.map(r => {
            const over = byRow.get(host.rowId(r));
            return over ? host.derive({ ...r, ...over }) : r;
        });
    }

    /** '' | 'unsaved' (queued or writing) | 'failed' */
    function cellState(row, key) {
        if (!host.enabled()) return '';
        const k = cellKey(host.rowId(row), key);
        if (failed[k]) return 'failed';
        const p = pending[k];
        return p && (p.status === 'queued' || p.status === 'writing') ? 'unsaved' : '';
    }

    /** An edit: show it, hold it for the delay (or behind the write in flight for this cell). */
    function edit(row, key, value) {
        if (!host.enabled()) return;
        const id = host.rowId(row);
        const k = cellKey(id, key);
        const existing = pending[k];
        if (existing && existing.status === 'writing') {
            existing.next = value;
            existing.value = value;
            return;
        }
        const loaded = loadedRow(id);
        // What the sheet holds now: a saved entry's value (its reload may not have arrived yet),
        // a queued entry's original, or the loaded value
        const original = existing
            ? (existing.status === 'saved' ? existing.value : existing.original)
            : (loaded ? loaded[key] : undefined);
        delete failed[k];
        if (sameValue(key, value, original)) delete pending[k];
        else pending[k] = { id, key, value, original, status: 'queued', row: loaded || row };
        schedule();
    }

    /** The loaded rows changed: drop saved overlays the rows now carry. */
    function reconcile() {
        if (!host.enabled()) return;
        for (const [k, p] of Object.entries(pending)) {
            if (p.status !== 'saved') continue;
            const row = loadedRow(p.id);
            if (!row || sameValue(p.key, row[p.key], p.value)) delete pending[k];
        }
    }

    function schedule() {
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, host.delay());
    }

    /** Write every queued cell now, as one batch (after the batch in flight, if any). */
    async function flush() {
        clearTimeout(flushTimer);
        flushTimer = null;
        if (flushing) { flushAgain = true; return flushing; }
        const keys = Object.keys(pending).filter(k => pending[k].status === 'queued');
        if (!keys.length) return;
        flushing = writeBatch(keys);
        try { await flushing; } finally { flushing = null; }
        if (flushAgain) { flushAgain = false; await flush(); }
    }

    async function writeBatch(keys) {
        const entries = keys.map(k => pending[k]);
        const values = entries.map(e => e.value);
        entries.forEach(e => { e.status = 'writing'; });
        const results = await commit(entries, values);
        const problems = { failures: [], warnings: [] };
        let requeued = false;
        keys.forEach((k, n) => { if (settle(k, values[n], results[n], problems)) requeued = true; });
        if (requeued) schedule();
        report(problems);
    }

    // The page's write; a thrown error fails every entry
    async function commit(entries, values) {
        try {
            const results = await host.commitCells(entries.map((e, n) => ({ row: e.row, key: e.key, value: values[n] })));
            return Array.isArray(results) ? results : [];
        } catch (e) {
            return entries.map(() => ({ ok: false, reason: e?.message || 'error' }));
        }
    }

    // One cell's result. Saved, or queued again when a newer edit arrived during the write
    // (returns true); a failure reverts the cell and marks it failed.
    function settle(k, written, result, problems) {
        if (result?.warning) problems.warnings.push(escapeHtml(result.warning));
        const current = pending[k];
        if (!current) return false;
        if (result && result.ok) {
            if (current.next !== undefined && !sameValue(current.key, current.next, written)) {
                current.original = written;
                current.value = current.next;
                delete current.next;
                current.status = 'queued';
                return true;
            }
            current.status = 'saved';
            setTimeout(() => { if (pending[k]?.status === 'saved') delete pending[k]; }, SAVED_OVERLAY_MS);
            return false;
        }
        delete pending[k];
        failed[k] = true;
        setTimeout(() => { delete failed[k]; }, FAILED_STATE_MS);
        const label = host.field(current.key)?.label || current.key;
        problems.failures.push(escapeHtml(`${label}: ${describeWriteFailure(result?.reason)}`));
        return false;
    }

    // One message per batch: the failures (values reverted, data refreshed), else the warnings.
    // The modal renders HTML (newlines become line breaks); every part is escaped.
    function report({ failures, warnings }) {
        const modal = host.modal();
        if (failures.length) {
            const list = failures.length === 1 ? failures[0] : failures.map(f => `• ${f}`).join('\n');
            const head = failures.length === 1 ? 'Could not save ' : `Could not save ${failures.length} changes:\n`;
            const extra = warnings.length ? `\n\n${warnings.join('\n')}` : '';
            modal?.error?.(`${head}${list}.\nThe values were reverted and the data refreshed.${extra}`, 'Save failed');
            host.refresh();
        } else if (warnings.length) {
            modal?.alert?.(warnings.join('\n'), 'Check the sheet', false);
        }
    }

    // Closing the tab with writes queued: start them and ask the browser to confirm leaving
    function onBeforeUnload(e) {
        if (!hasQueued.value) return;
        flush();
        e.preventDefault();
        e.returnValue = '';
        return '';
    }

    /** Start guarding the tab close. */
    function start() {
        window.addEventListener('beforeunload', onBeforeUnload);
    }

    /** Stop guarding and write queued edits now (in-app navigation). */
    function stop() {
        window.removeEventListener('beforeunload', onBeforeUnload);
        flush();
    }

    return { pending, failed, hasQueued, overlay, cellState, edit, reconcile, flush, start, stop };
}
