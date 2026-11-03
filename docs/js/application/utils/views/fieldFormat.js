/**
 * Field value formatting shared by every renderer (table cells, calendar chips,
 * cards and the details grid). Extracted from TableComponent.formatCellValue.
 *
 * Pure: no Vue, no DOM. Safe to import from tests.
 */
import { parseDate, toUSDateString } from '../../../data_management/utils/helpers.js';

/**
 * Format a raw value for display according to its field definition.
 * @param {*} value
 * @param {{ format?: string }} [field]
 * @returns {*} formatted value ('' for null/undefined; the raw value when no format applies)
 */
export function formatValue(value, field) {
    if (value === null || value === undefined) return '';
    const format = field && field.format;
    if (!format) return value;
    if (value === '') return '';
    // Non-numeric values in numeric formats display as-is (never "NaN")
    if ((format === 'currency' || format === 'number' || format === 'percentage') && !Number.isFinite(parseFloat(value))) {
        return value;
    }

    switch (format) {
        case 'currency':
            return `$${parseFloat(value).toFixed(2)}`;
        case 'date': {
            const parsedDate = parseDate(value);
            return toUSDateString(parsedDate) ?? String(value);
        }
        case 'number':
            return parseFloat(value).toLocaleString();
        case 'percentage':
            return `${parseFloat(value).toFixed(1)}%`;
        case 'multiline':
            // Text with line breaks: <br> tags become newlines (renderers escape, then break lines)
            return String(value).replace(/<br\s*\/?>/gi, '\n');
        default:
            return value;
    }
}

/**
 * Format a value as display text: arrays of primitives are joined, objects render as ''.
 * Used by renderers that print values as text (chips, cards, details).
 * @param {*} value
 * @param {Object} [field]
 * @returns {string}
 */
export function formatText(value, field) {
    if (Array.isArray(value)) {
        return value.filter(v => v != null && typeof v !== 'object').map(v => String(formatValue(v, field))).join(', ');
    }
    if (value !== null && typeof value === 'object') return '';
    const out = formatValue(value, field);
    return out === null || out === undefined ? '' : String(out);
}

/**
 * Does a value have something to display? Blank, empty arrays and objects don't.
 * @param {*} value
 * @returns {boolean}
 */
export function hasDisplayValue(value) {
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    return typeof value !== 'object';
}

/**
 * Escape HTML special characters (XSS-safe text for v-html). The app's one escaper.
 * @param {*} text
 * @returns {string}
 */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
