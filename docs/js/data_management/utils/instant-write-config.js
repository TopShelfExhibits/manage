/**
 * Instant writes: the InstantWriteTables preference and what each write failure means
 * (views-and-renderers-plan §4.16). Pure, no imports, so UI modules can read it without pulling
 * in the data layer.
 *
 *   { "<database>/<tab>": { "identity": ["Client", "Year", "Show"], "columns": ["Elev", "Panels"] } }
 *
 *   identity — the columns that together identify a row (writes locate rows by them)
 *   columns  — the columns that are written immediately on edit
 * The cell type of each column comes from the data (checkbox values, an options list), not from
 * the preference. The older form, "columns": { "Elev": "checkbox", ... }, is still read: its
 * keys are the columns and the types are ignored.
 */

/**
 * The entry for one table, normalized, or null when it is missing or incomplete.
 * @param {*} all - the parsed preference value
 * @param {string} database
 * @param {string} tab
 * @returns {{ identity: string[], columns: string[] }|null}
 */
export function instantWriteEntry(all, database, tab) {
    const entry = all && typeof all === 'object' ? all[`${database}/${tab}`] : null;
    if (!entry || typeof entry !== 'object') return null;
    const clean = (list) => list.map(v => String(v ?? '').trim()).filter(Boolean);
    const identity = Array.isArray(entry.identity) ? clean(entry.identity) : [];
    const columns = Array.isArray(entry.columns)
        ? clean(entry.columns)
        : (entry.columns && typeof entry.columns === 'object' ? clean(Object.keys(entry.columns)) : []);
    if (!identity.length || !columns.length) return null;
    return { identity, columns };
}

/** Whether `column` is one of the entry's instant-write columns (trimmed, case-insensitive). */
export function isInstantColumn(entry, column) {
    const target = String(column ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    return !!entry && entry.columns.some(c => c.replace(/\s+/g, ' ').trim().toLowerCase() === target);
}

/**
 * What each instant-write failure reason means, for the save-failed message. The reasons come
 * from writeCellsVerified and saveShowNote (and the page's routing); anything else is shown as is.
 */
const WRITE_FAILURE_MESSAGES = Object.freeze({
    'no-config': 'this table has no instant-write setup (InstantWriteTables preference)',
    'column-not-writable': 'this column is not listed as writable',
    'column-missing': 'the column was not found in the sheet',
    'not-found': 'the row was not found in the sheet',
    'duplicate': 'more than one row has this identity',
    'no-identity-columns': 'the identity columns were not found in the sheet',
    'moved': 'the row kept moving while saving',
    'verify-failed': 'the saved value did not read back correctly',
    'superseded': 'a later edit to the same cell replaced it',
    'no-identifier': 'this show has no note identifier yet',
    'no-show-notes-tab': 'the ShowNotes tab was not found',
    'show-notes-headers': 'the ShowNotes tab is missing its Identifier or Note header',
    'no-result': 'the save returned no result'
});

/** The message for a write failure reason. */
export function describeWriteFailure(reason) {
    return WRITE_FAILURE_MESSAGES[reason] || reason || 'unknown error';
}
