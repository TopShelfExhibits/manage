/**
 * Checkbox cell values (views-and-renderers-plan §4.16). Pure, no imports, so UI modules can
 * use it without pulling in the data layer (which has top-level await).
 *
 * Reading: `X` (or TRUE) is checked; any other value (blank, '-', 'FALSE', a date) is unchecked.
 * Writing: checking writes `X`; unchecking writes blank.
 */

/** @param {*} value @returns {boolean} */
export function isCheckedValue(value) {
    const v = String(value ?? '').trim().toUpperCase();
    return v === 'X' || v === 'TRUE';
}

/** @param {boolean} checked @returns {string} */
export function checkboxWriteValue(checked) {
    return checked ? 'X' : '';
}

// Values a checkbox column may hold: checked (X, TRUE) or a "not checked" marker (FALSE, -, N/a)
const CHECKBOX_VOCABULARY = new Set(['X', 'TRUE', 'FALSE', '-', 'N/A', 'NA']);
// Share of non-blank values that must be checkbox values for a checkbox column (due-date columns
// with an occasional X stay text: on the Schedule they sit below 0.3, task columns above 0.8)
const CHECKBOX_SHARE = 0.75;

/**
 * What kind of data a column holds, from its values (the data decides the cell type):
 *   'checkbox' — at least CHECKBOX_SHARE of the non-blank values are checkbox values, and at least
 *                one is checked (task columns sometimes hold a stray date, e.g. "8/1")
 *   'empty'    — every value is blank (the data can't tell)
 *   'text'     — anything else
 * @param {Iterable<*>} values
 * @returns {'checkbox'|'empty'|'text'}
 */
export function columnKind(values) {
    let filled = 0;
    let vocabulary = 0;
    let checked = false;
    for (const value of values) {
        const v = String(value ?? '').trim().toUpperCase();
        if (!v) continue;
        filled++;
        if (CHECKBOX_VOCABULARY.has(v)) vocabulary++;
        if (v === 'X' || v === 'TRUE') checked = true;
    }
    if (!filled) return 'empty';
    return checked && vocabulary / filled >= CHECKBOX_SHARE ? 'checkbox' : 'text';
}

/**
 * Column kinds for row objects, by key ('AppData' skipped).
 * @param {Object[]} rows
 * @returns {Object<string, 'checkbox'|'empty'|'text'>}
 */
export function columnKindsOfRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const keys = new Set();
    list.forEach(r => r && Object.keys(r).forEach(k => { if (k !== 'AppData') keys.add(k); }));
    const kinds = {};
    keys.forEach(k => { kinds[k] = columnKind(list.map(r => r?.[k])); });
    return kinds;
}
