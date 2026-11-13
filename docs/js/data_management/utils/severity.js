/**
 * Severity: what an alert, banner or status card means, from most to least urgent. The data layer
 * says the severity; the UI gives each severity one colour (application/utils/severity.js), so the
 * same meaning looks the same everywhere. Pure: no imports.
 */
export const SEVERITY = Object.freeze({
    critical: 'critical',   // wrong now: a shortage, a write conflict, a broken link or reference
    warning: 'warning',     // at risk or needs action: no spare, offline, an update to load
    attention: 'attention', // incomplete: not in inventory, an undeclared variant, a CAD change
    review: 'review',       // differs: a description that doesn't match
    note: 'note',           // minor: a close match, low but sufficient stock
    info: 'info',           // information
    neutral: 'neutral',     // settled or inactive status
    success: 'success'      // done
});

/**
 * The severity of a remaining quantity: below 0 runs short (critical), below 1 leaves no spare
 * (warning), otherwise none. Used by inventory alerts and number cells alike.
 * @param {number|null|undefined} remaining
 * @returns {string} A SEVERITY, or '' for none
 */
export function remainingSeverity(remaining) {
    if (remaining === null || remaining === undefined || isNaN(remaining)) return '';
    if (remaining < 0) return SEVERITY.critical;
    if (remaining < 1) return SEVERITY.warning;
    return '';
}
