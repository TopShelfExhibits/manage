/**
 * A1 ranges against a sheet's grid (its row and column count). Pure: no imports, no API calls.
 *
 * A Sheets range read or write past the grid fails with 400 "exceeds grid limits". The grid
 * shrinks to the data when rows are deleted (deleteSheetRows, a whole-tab write's truncation), so
 * the row after the last one is often outside it. GoogleSheetsService handles this the same way
 * for every range call: a write grows the grid and is retried, a read is clipped to the grid
 * (cells past it read as empty, like empty cells inside it).
 */

/** Whether an API error is a range outside the sheet's grid. */
export function isGridLimitError(error) {
    return String(error?.result?.error?.message || '').includes('exceeds grid limits');
}

function columnNumber(letters) {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
}

function columnLetters(n) {
    let s = '';
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
}

/**
 * Split an A1 range into its sheet and cell bounds (1-based; null where the range is open:
 * a whole tab, whole columns "A:C" or whole rows "2:5").
 * @param {string} range - "Tab!A7:C7", "'My Tab'!B2", "Tab!A:C" or "Tab"
 * @returns {{ sheetPart: string, sheet: string, startRow: number|null, startCol: number|null, endRow: number|null, endCol: number|null }}
 */
export function parseA1Range(range) {
    const text = String(range ?? '');
    const bang = text.lastIndexOf('!');
    const sheetPart = bang >= 0 ? text.slice(0, bang) : text;
    const sheet = /^'.*'$/.test(sheetPart) ? sheetPart.slice(1, -1).replace(/''/g, "'") : sheetPart;
    const cells = bang >= 0 ? text.slice(bang + 1).split(':') : [];
    const refs = cells.map(cell => {
        const m = /^([A-Z]*)(\d*)$/.exec(cell.trim().toUpperCase());
        return m ? { col: m[1] ? columnNumber(m[1]) : null, row: m[2] ? parseInt(m[2], 10) : null } : { col: null, row: null };
    });
    const start = refs[0] || { col: null, row: null };
    const end = refs[1] || start;
    return { sheetPart, sheet, startRow: start.row, startCol: start.col, endRow: end.row, endCol: end.col };
}

/**
 * The grid each sheet needs so every range fits.
 * @param {string[]} ranges
 * @returns {Map<string, { rows: number, cols: number }>} sheet name → minimum rows and columns
 */
export function gridNeeded(ranges) {
    const needs = new Map();
    for (const range of ranges || []) {
        const r = parseA1Range(range);
        const need = needs.get(r.sheet) || { rows: 0, cols: 0 };
        need.rows = Math.max(need.rows, r.endRow || r.startRow || 0);
        need.cols = Math.max(need.cols, r.endCol || r.startCol || 0);
        needs.set(r.sheet, need);
    }
    return needs;
}

/**
 * A range limited to a grid of rows × columns: its end is pulled in to the grid, and a range that
 * starts outside the grid is null (it holds no cells). Open ranges keep their open sides.
 * @param {string} range
 * @param {number} rows - The sheet's row count
 * @param {number} cols - The sheet's column count
 * @returns {string|null}
 */
export function clipRangeToGrid(range, rows, cols) {
    const r = parseA1Range(range);
    if (r.startRow === null && r.startCol === null) return range;
    if ((r.startRow && r.startRow > rows) || (r.startCol && r.startCol > cols)) return null;
    const ref = (col, row) => `${col ? columnLetters(col) : ''}${row ?? ''}`;
    const endRow = r.endRow === null ? null : Math.min(r.endRow, rows);
    const endCol = r.endCol === null ? null : Math.min(r.endCol, cols);
    return `${r.sheetPart}!${ref(r.startCol, r.startRow)}:${ref(endCol, endRow)}`;
}
