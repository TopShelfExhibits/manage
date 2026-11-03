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
