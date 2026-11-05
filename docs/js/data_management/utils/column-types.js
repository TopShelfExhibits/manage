/**
 * Column types: what a sheet column's values ARE (data behavior, not presentation).
 *
 * Declared per sheet in the ColumnTypes preference (json):
 *   { "<database>/<tab>": { "<column>": "<type>" | { "type": "select", "options": "<list name>" } } }
 *   e.g. { "PROD_SCHED/Production Schedule": { "Elev": "checkbox",
 *          "Assignee": { "type": "select", "options": "DesignQueueAssignees" } } }
 *
 * - Declared types win. An undeclared column is text, except that guessColumnType reads date,
 *   number and currency words in its name. guessColumnType is the only place the app guesses a
 *   column's type.
 * - select: "options" names an option list. The component that shows the column supplies its
 *   lists by name (the design queue takes DesignQueueAssignees from preferences).
 * - Which columns a table may write is separate: the InstantWriteTables preference.
 * - thumbnail: a JSON array of Drive file IDs (thumbnail-values.js). Its values are references,
 *   not text: they are never searched, pasted or copied out as text (isOpaqueType).
 * - Column names match as instant writes do (columnText: spacing and case ignored).
 *
 * Requests.getColumnTypes(database, tab) is the one cached read; this module is pure.
 */
import { columnText } from './instant-write-config.js';

export const COLUMN_TYPES = Object.freeze(['text', 'checkbox', 'select', 'date', 'number', 'currency', 'thumbnail']);

/** Types whose values are references rather than text: not searched, pasted or exported as text. */
const OPAQUE_TYPES = Object.freeze(['thumbnail']);

/** @param {string} type @returns {boolean} */
export function isOpaqueType(type) {
    return OPAQUE_TYPES.includes(type);
}

const DATE_WORDS = ['date', 'start', 'end', 'ship', 'due', 'deadline', 'created', 'updated', 'modified', 'time', 'return'];
const NUMBER_WORDS = ['qty', 'quantity'];
const CURRENCY_WORDS = ['price', 'cost', 'amount', 'fee', 'rate', 'budget', 'expense', 'revenue', 'total'];

/** The type of an undeclared column, from its name: date, number, currency, else text. */
export function guessColumnType(name) {
    const n = String(name ?? '').toLowerCase();
    if (n.includes('thumbnail')) return 'thumbnail';
    if (DATE_WORDS.some(w => n.includes(w))) return 'date';
    if (NUMBER_WORDS.some(w => n.includes(w)) || /^\d+$/.test(n)) return 'number';
    if (CURRENCY_WORDS.some(w => n.includes(w))) return 'currency';
    return 'text';
}

/**
 * One sheet's declared types from the whole ColumnTypes value, as a list:
 * [{ column, type, options? }]. Unknown types are skipped.
 */
export function columnTypesEntry(all, database, tab) {
    const entry = all && typeof all === 'object' ? all[`${database}/${tab}`] : null;
    if (!entry || typeof entry !== 'object') return [];
    const list = [];
    for (const [column, decl] of Object.entries(entry)) {
        const type = String((decl && typeof decl === 'object' ? decl.type : decl) ?? '').trim().toLowerCase();
        if (!column.trim() || !COLUMN_TYPES.includes(type)) continue;
        const item = { column: column.trim(), type };
        if (type === 'select' && decl?.options) item.options = String(decl.options);
        list.push(item);
    }
    return list;
}

/** Declared types (Requests.getColumnTypes list) by matched column name. */
export function columnTypeMap(list) {
    return new Map((Array.isArray(list) ? list : []).map(t => [columnText(t.column), t]));
}

/** A column's type: the declared one, else the guess. → { type, options? } */
export function columnTypeOf(typeMap, name) {
    const declared = typeMap?.get(columnText(name));
    return declared ? { type: declared.type, ...(declared.options ? { options: declared.options } : {}) } : { type: guessColumnType(name) };
}

/** FieldDef properties for a column type (type and display format). */
export function fieldTypeProps({ type, options } = {}) {
    switch (type) {
        case 'date': return { type: 'date', format: 'date' };
        case 'number': return { type: 'number', format: 'number' };
        case 'currency': return { format: 'currency' };
        case 'checkbox': return { type: 'checkbox' };
        case 'thumbnail': return { type: 'thumbnail', format: 'thumbnail' };
        // The field names its list (optionList); the page that shows it supplies field.options
        case 'select': return { type: 'select', ...(options ? { optionList: options } : {}) };
        default: return {};
    }
}
