/**
 * Production Schedule field definitions (views-and-renderers-plan §3, §4.1).
 *
 * Fields describe what each Schedule column IS: its name (label), data type and format.
 * They are shared by every page that shows Schedule rows (the Schedule page and the design
 * queue). Presentation (which columns show and sort, widths, colours, cells) belongs to each
 * page's views.
 *
 * The sheet's headers are dynamic, so fields are built from the loaded headers. The known
 * columns are always present, so views can reference them before data loads. Each field's type
 * comes from the ColumnTypes preference (Requests.getColumnTypes), else the name guess
 * (utils/column-types.js).
 *
 * Pure: no Vue, no DOM.
 */
import { columnTypeMap, columnTypeOf, fieldTypeProps } from '../utils/column-types.js';

/** Columns every Schedule view can rely on, in the sheet's usual order. */
export const SCHEDULE_KNOWN_COLUMNS = Object.freeze([
    'Show', 'Client', 'Year', 'City', 'Size', 'S. Start', 'S. End', 'Ship', 'Recieved'
]);

/** Synthetic field for the packlist cell (no sheet data; the page decorates it). */
export const PACKLIST_FIELD_KEY = 'packlist';

const LABELS = {
    'S. Start': 'Start Date',
    'S. End': 'End Date',
    'Booth#': 'Booth #',
    'Ship': 'Ship Date'
};

/** Human label for a sheet header (moved from ScheduleTable.formatColumnLabel). */
export function scheduleLabel(header) {
    if (LABELS[header]) return LABELS[header];
    if (['Year', 'Show', 'Client', 'City', 'Location'].includes(header)) return header;
    return String(header)
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .replace(/\.([a-zA-Z])/g, '. $1')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

/** FieldDef for one Schedule header; typeMap from columnTypeMap(declared types). */
export function scheduleField(header, typeMap = null) {
    return { key: header, label: scheduleLabel(header), ...fieldTypeProps(columnTypeOf(typeMap, header)) };
}

/**
 * Build Schedule fields from the loaded rows' headers.
 * @param {Object[]} rows Schedule rows (headers from the first row)
 * @param {{ packlist?: boolean, types?: Array<{ column, type, options? }> }} [opts]
 *        packlist: add the synthetic packlist field; types: Requests.getColumnTypes for the tab
 * @returns {Object[]} FieldDef[]
 */
export function buildScheduleFields(rows, opts = {}) {
    const { packlist = true, types = null } = opts;
    const typeMap = columnTypeMap(types);
    const headers = [];
    const seen = new Set();
    const add = (h) => { if (h && !seen.has(h) && h !== 'AppData') { seen.add(h); headers.push(h); } };
    const first = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (first) Object.keys(first).forEach(add);
    SCHEDULE_KNOWN_COLUMNS.forEach(add);
    const fields = headers.map(h => scheduleField(h, typeMap));
    // Synthetic: holds no data; the Schedule page draws it (custom, views-and-renderers-plan §4.14)
    if (packlist) fields.push({ key: PACKLIST_FIELD_KEY, label: 'Packlist' });
    return fields;
}
