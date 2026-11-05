import { SEVERITY } from '../../data_management/utils/severity.js';

/**
 * The one colour of each severity (data_management/utils/severity.js). Alerts from the API,
 * banners and status cards carry a severity; this map turns it into a colour class
 * (global.css: red, orange, yellow, purple, white, blue, gray, green).
 */
export const SEVERITY_COLORS = Object.freeze({
    [SEVERITY.critical]: 'red',
    [SEVERITY.warning]: 'orange',
    [SEVERITY.attention]: 'yellow',
    [SEVERITY.review]: 'purple',
    [SEVERITY.note]: 'white',
    [SEVERITY.info]: 'blue',
    [SEVERITY.neutral]: 'gray',
    [SEVERITY.success]: 'green'
});

/** A severity's colour class ('' for none or an unknown severity). */
export function severityColor(severity) {
    return SEVERITY_COLORS[severity] || '';
}

/**
 * The colour class of an alert, banner or card. A status sets `severity`; an element styled for
 * itself (an action button, a decorative card) sets `class`. `color` is the older name for `class`.
 * @param {{ severity?: string, class?: string, color?: string }} item
 * @returns {string}
 */
export function statusColor(item) {
    return item?.class || item?.color || severityColor(item?.severity);
}
