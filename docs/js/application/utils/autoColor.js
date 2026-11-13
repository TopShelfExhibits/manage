import { remainingSeverity } from '../../data_management/utils/severity.js';
import { severityColor } from './severity.js';

/**
 * Universal Auto-Color Classification System
 *
 * One rule for numbers across the app, the remaining-quantity severity (remainingSeverity):
 * - value < 0  → critical (red)
 * - value < 1  → warning (orange)
 * - value >= 1 → no color
 *
 * Usage:
 * 1. Views: a field's colour rule 'auto' (viewColor.js)
 * 2. Custom cells and calendar chips: getAutoColorClass(value)
 */

/**
 * Color class for a numeric value by the universal rule.
 * @param {Number|null|undefined} value - The numeric value to classify
 * @returns {String} Color class name ('red', 'orange', or empty string)
 */
export function getAutoColorClass(value) {
    return severityColor(remainingSeverity(value));
}
