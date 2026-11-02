/**
 * The InstantWriteTables preference (views-and-renderers-plan §4.16). Pure, no imports, so UI
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

/** Whether `column` is one of the entry's instant-write columns (trimmed, case-insensitive). */
export function isInstantColumn(entry, column) {
    const target = String(column ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    return !!entry && entry.columns.some(c => c.replace(/\s+/g, ' ').trim().toLowerCase() === target);
}
