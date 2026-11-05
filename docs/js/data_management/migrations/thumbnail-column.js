/**
 * One-time admin migration: CACHE/Thumbnails → the inventory Thumbnail columns.
 * Never imported by the app. Delete this file (and CACHE/Thumbnails) once the migration is done.
 *
 * Run it in the browser console on the live site while signed in, after the new version is
 * deployed and open sessions have reloaded. Start with a dry run:
 *
 *   const m = await import(new URL('js/data_management/migrations/thumbnail-column.js', document.baseURI));
 *   await m.migrateThumbnails();                  // dry run: report only
 *   await m.migrateThumbnails({ dryRun: false }); // write
 *
 * What it does (only blank cells are filled, so it can be run again safely):
 *   - Item records (ItemNumber = an item's ITEM#): the item's Thumbnail cell gets '["<File>"]', in
 *     every inventory tab that has a Thumbnail column. Tabs without one are reported and skipped.
 *   - Category records (ItemNumber = a PREFIX in CACHE/Inventory): that prefix's Thumbnail cell in
 *     the index gets the file. The index gets a Thumbnail header after its last column if it has none.
 *   - A cell that already holds a different image is left alone and reported as a conflict.
 *   - Tabs locked for editing are skipped (run again once they are free).
 * Only the Thumbnail cells are written; nothing else in any tab changes.
 */
import { Database, ApplicationUtils, normalizeHeaderName, parseThumbnails, serializeThumbnails } from '../index.js';

const THUMBNAIL_HEADER = 'Thumbnail';

/**
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<{ dryRun: boolean, tabs: Object[], index: Object, unmatched: string[] }>}
 */
export async function migrateThumbnails({ dryRun = true } = {}) {
    const records = await readRecords();
    const used = new Set();
    const report = { dryRun, tabs: [], index: null, unmatched: [] };

    // Inventory tabs
    const tabs = (await Database.getTabs('INVENTORY')).map(t => t.title).filter(title => !title.startsWith('_'));
    for (const tab of tabs) {
        const rows = await Database.readFresh('INVENTORY', tab);
        const result = planColumn(rows, 'ITEM#', records, used);
        const entry = { tab, ...result.summary };
        if (result.status === 'ok' && result.cells.length) {
            const lock = await ApplicationUtils.getSheetLock('INVENTORY', tab);
            if (lock?.user) {
                entry.status = `locked by ${lock.user}: skipped`;
            } else if (!dryRun) {
                await Database.setCellValues('INVENTORY', tab, result.cells);
                entry.status = 'written';
            }
        }
        report.tabs.push(entry);
    }

    // Category images in the index
    const indexRows = await Database.readFresh('CACHE', 'Inventory');
    const indexResult = planColumn(indexRows, 'PREFIX', records, used, { addColumn: true });
    report.index = { tab: 'CACHE/Inventory', ...indexResult.summary };
    if (indexResult.status === 'ok' && indexResult.cells.length && !dryRun) {
        await Database.setCellValues('CACHE', 'Inventory', indexResult.cells);
        report.index.status = 'written';
    }

    report.unmatched = [...records.keys()].filter(key => !used.has(key)).sort();

    console.log(`[migrateThumbnails] ${dryRun ? 'DRY RUN, nothing written' : 'Done'}. ${records.size} records.`);
    console.table([...report.tabs, report.index].map(({ tab, status, fill, already, conflicts, noColumnMatches }) =>
        ({ tab, status, fill, already, conflicts: conflicts.length, noColumnMatches })));
    const conflicts = [...report.tabs, report.index].flatMap(t => t.conflicts.map(c => ({ tab: t.tab, ...c })));
    if (conflicts.length) console.table(conflicts);
    if (report.unmatched.length) console.log('[migrateThumbnails] Records matching no item or prefix:', report.unmatched);
    return report;
}

/** CACHE/Thumbnails as Map<itemNumber or prefix, Drive file ID>. */
async function readRecords() {
    const rows = await Database.readFresh('CACHE', 'Thumbnails');
    const headers = (rows?.[0] || []).map(normalizeHeaderName);
    const keyCol = headers.indexOf('ItemNumber');
    const fileCol = headers.indexOf('File');
    if (keyCol === -1 || fileCol === -1) throw new Error('CACHE/Thumbnails needs ItemNumber and File columns');
    const records = new Map();
    for (const row of rows.slice(1)) {
        const key = String(row[keyCol] ?? '').trim();
        const file = String(row[fileCol] ?? '').trim();
        if (key && file) records.set(key, file);
    }
    return records;
}

/**
 * Plan the Thumbnail cells of one tab: rows whose key column matches a record and whose
 * Thumbnail cell is blank. Marks matched record keys in `used` (also in a tab without the column).
 * @returns {{ status: string, cells: Array<{rowNumber, columnNumber, value}>, summary: Object }}
 */
function planColumn(rows, keyHeader, records, used, { addColumn = false } = {}) {
    const headers = (rows?.[0] || []).map(normalizeHeaderName);
    const keyCol = headers.indexOf(keyHeader);
    let thumbCol = headers.indexOf(THUMBNAIL_HEADER);
    const summary = { status: 'nothing to do', fill: 0, already: 0, conflicts: [], noColumnMatches: 0 };
    const cells = [];
    if (keyCol === -1) {
        summary.status = `no ${keyHeader} column: skipped`;
        return { status: 'skipped', cells, summary };
    }

    const matches = rows.slice(1)
        .map((row, i) => ({ rowNumber: i + 2, key: String(row[keyCol] ?? '').trim(), row }))
        .filter(m => m.key && records.has(m.key));
    matches.forEach(m => used.add(m.key));
    if (thumbCol === -1 && !addColumn) {
        summary.status = 'no Thumbnail column: skipped';
        summary.noColumnMatches = matches.length;
        return { status: 'skipped', cells, summary };
    }
    if (thumbCol === -1) {
        thumbCol = headers.length;
        if (matches.length) cells.push({ rowNumber: 1, columnNumber: thumbCol + 1, value: THUMBNAIL_HEADER });
    }

    for (const { rowNumber, key, row } of matches) {
        const file = records.get(key);
        const current = parseThumbnails(row[thumbCol]);
        if (current.length === 0) {
            cells.push({ rowNumber, columnNumber: thumbCol + 1, value: serializeThumbnails([file]) });
            summary.fill++;
        } else if (current[0] === file) {
            summary.already++;
        } else {
            summary.conflicts.push({ key, current: current[0], record: file });
        }
    }
    if (cells.length) summary.status = 'to write';
    return { status: 'ok', cells, summary };
}
