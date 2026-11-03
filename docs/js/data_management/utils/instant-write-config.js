/**
 * Instant writes: the InstantWriteTables preference, how rows and cells are matched (keys), and
 * what each write failure means (views-and-renderers-plan §4.16). Pure, no imports, so UI
 * modules can read it without pulling in the data layer.
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

/** Whether `column` is one of the entry's instant-write columns (see columnText). */
export function isInstantColumn(entry, column) {
    const target = columnText(column);
    return !!entry && entry.columns.some(c => columnText(c) === target);
}

// ── Keys: how rows, cells and columns are matched ───────────────────────────

const KEY_SEPARATOR = '';

/** One key from several parts, joined with a character sheet values never hold. */
export function joinKey(...parts) {
    return parts.map(p => String(p ?? '')).join(KEY_SEPARATOR);
}

/** How identity values (and identifiers) match: trimmed, case-insensitive. */
export function identityText(value) {
    return String(value ?? '').trim().toLowerCase();
}

/** How column names match: line breaks and runs of spaces as one space, trimmed, case-insensitive. */
export function columnText(name) {
    return String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const COLOR_WORDS = Object.freeze(['gray', 'purple', 'red', 'orange', 'yellow', 'blue', 'green']);

/**
 * A preference entry as { name, color }: a [name, colour] pair (["Sam Smith", "red"]) or a bare
 * name. The colour is one of the global colour classes; any other word is ignored.
 */
export function parseColoredName(entry) {
    const [name, color] = Array.isArray(entry) ? entry : [entry];
    const word = String(color ?? '').trim().toLowerCase();
    return { name: String(name ?? '').trim(), color: COLOR_WORDS.includes(word) ? word : '' };
}

/**
 * A row's identity values, as they match.
 * @param {string[]} identity  the identity column names
 * @param {(name: string, k: number) => *} valueOf  the row's value for each
 */
export function identityParts(identity, valueOf) {
    return identity.map((name, k) => identityText(valueOf(name, k)));
}

/** A row's identity as one key: two rows with the same key are the same row to an instant write. */
export function identityKey(identity, valueOf) {
    return joinKey(...identityParts(identity, valueOf));
}

/** One cell: a row's identity key and a column name. */
export function cellKey(rowKey, column) {
    return joinKey(rowKey, columnText(column));
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
