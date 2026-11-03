/**
 * Colour rules for views (§4.9). Colour is data only:
 *   'auto'            → getAutoColorClass(number) for numeric values; date proximity for date fields
 *   'value'           → the value itself is the class (for page-computed derived colour fields)
 *   'checked:<class>' → <class> when the value is a checked checkbox value (X / TRUE)
 *   other             → a literal class name
 *
 * Pure: no Vue, no DOM. Safe to import from tests.
 */
import { getAutoColorClass } from '../autoColor.js';
import { parseDate } from '../../../data_management/utils/helpers.js';
import { isCheckedValue } from '../../../data_management/utils/checkbox-values.js';

/**
 * Colour class for a date based on proximity to today (moved from TableComponent).
 * Within 2 days (or up to a week past) → red; within 7 days → orange; otherwise none.
 * @param {*} dateValue
 * @param {Date} [now]
 * @returns {string}
 */
export function getDateColorClass(dateValue, now = new Date()) {
    if (!dateValue) return '';
    const date = dateValue instanceof Date ? dateValue : parseDate(dateValue);
    if (!date || isNaN(date.getTime())) return '';

    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const target = new Date(date);
    target.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays < -7) return '';
    if (diffDays <= 2) return 'red';
    if (diffDays <= 7) return 'orange';
    return '';
}

function isDateField(field) {
    return !!field && (field.format === 'date' || field.type === 'date');
}

/**
 * Apply one colour rule to a value.
 * @param {string} rule
 * @param {*} value
 * @param {Object} [field]
 * @returns {string} class name or ''
 */
export function applyColorRule(rule, value, field) {
    if (!rule) return '';
    if (rule === 'auto') {
        if (value === null || value === undefined || value === '') return '';
        if (isDateField(field)) return getDateColorClass(value);
        const num = typeof value === 'number' ? value : parseFloat(value);
        if (!Number.isFinite(num)) return '';
        return getAutoColorClass(num);
    }
    if (rule === 'value') {
        if (value === null || value === undefined || value === '' || typeof value === 'object') return '';
        return String(value);
    }
    if (rule.startsWith('checked:')) return isCheckedValue(value) ? rule.slice('checked:'.length) : '';
    return String(rule);
}

/**
 * Cell colour for one field of a row, from the resolved view's style.
 * @param {Object} row
 * @param {{ key: string }} field
 * @param {{ style?: Object<string, { color?: string }> }} resolved
 * @returns {string}
 */
export function colorFor(row, field, resolved) {
    if (!row || !field) return '';
    const rule = resolved?.style?.[field.key]?.color;
    if (!rule) return '';
    return applyColorRule(rule, row[field.key], field);
}

/**
 * Row colour from the resolved view's rowColor: { field, rule, fallback }.
 * @param {Object} row
 * @param {{ rowColor?: { field: string, rule: string, fallback?: string }, fieldMap?: Map }} resolved
 * @returns {string}
 */
export function rowColorFor(row, resolved) {
    const rc = resolved?.rowColor;
    if (!row || !rc || !rc.field) return '';
    const field = resolved.fieldMap?.get?.(rc.field) || { key: rc.field };
    const cls = applyColorRule(rc.rule || 'value', row[rc.field], field);
    return cls || rc.fallback || '';
}
