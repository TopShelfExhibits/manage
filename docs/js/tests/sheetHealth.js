/**
 * Sheet health — TEST ONLY.
 *
 * Checks that a tab is in the state the app's reads and writes rely on: a header row, unique
 * header names, the identity and writable columns present, and every data row with a complete,
 * unique identity. The suite runs it on the fixture sheets after everything that writes to them,
 * so a process that damages a sheet fails the tests before it is deployed.
 *
 * Never loaded on the live site: only tests/tests.js imports this module, and app.js imports the
 * tests only on localhost. The live write path has its own checks (instant-write-utils.js locates
 * every cell by identity and header on a fresh read and refuses anything ambiguous); it never
 * depends on this report.
 *
 * Each rule is a function (sheet, spec) → issues. Add a rule to RULES for a new concern.
 *   sheet  { header: any[], rows: any[][] }      rows[0] is sheet row 2
 *   spec   { identity: string[], columns: string[] }
 *          identity: columns that together identify a row (none: identity rules are skipped)
 *          columns: columns the app writes (must exist)
 * Issue: { kind, message, rows?: number[] }   rows are 1-based sheet rows
 */
import { Database, InstantWriteUtils } from '../data_management/index.js';
import { columnText, identityParts, joinKey } from '../data_management/utils/instant-write-config.js';
import { normalizeHeaderName } from '../data_management/utils/helpers.js';

const sheetRow = (n) => n + 2; // rows[n] → 1-based sheet row
const isBlankLine = (line) => !(line || []).some(v => String(v ?? '').trim());
const indexOf = (header, name) => header.findIndex(h => columnText(h) === columnText(name));

/** Header names are unique (columns are found by name). */
function uniqueHeaders({ header }) {
    const issues = [];
    const seen = new Map();
    header.forEach((h, c) => {
        const name = columnText(h);
        if (!name) return;
        if (seen.has(name)) {
            issues.push({ kind: 'duplicate-header', message: `Header "${normalizeHeaderName(h)}" appears in columns ${Database.columnLetter(seen.get(name) + 1)} and ${Database.columnLetter(c + 1)}` });
        } else {
            seen.set(name, c);
        }
    });
    return issues;
}

/** Every column the spec names exists. */
function requiredColumns({ header }, spec) {
    const missing = (names, kind, what) => (names || [])
        .filter(n => indexOf(header, n) < 0)
        .map(n => ({ kind, message: `${what} column "${n}" is missing` }));
    return [
        ...missing(spec.identity, 'missing-identity-column', 'Identity'),
        ...missing(spec.columns, 'missing-writable-column', 'Writable')
    ];
}

/** Every data row has a complete identity, and no two rows share one. */
function identities({ header, rows }, spec) {
    if (!spec.identity?.length) return [];
    const cols = spec.identity.map(n => indexOf(header, n));
    if (cols.some(c => c < 0)) return []; // reported by requiredColumns
    const issues = [];
    const byIdentity = new Map();
    rows.forEach((line, n) => {
        if (isBlankLine(line)) return;
        const parts = identityParts(spec.identity, (name, k) => line[cols[k]]);
        if (parts.every(v => !v)) {
            issues.push({ kind: 'blank-identity', message: `Row ${sheetRow(n)} has data but no identity`, rows: [sheetRow(n)] });
            return;
        }
        const key = joinKey(...parts);
        if (!byIdentity.has(key)) byIdentity.set(key, { parts, rows: [] });
        byIdentity.get(key).rows.push(sheetRow(n));
    });
    for (const { parts, rows: dup } of byIdentity.values()) {
        if (dup.length > 1) issues.push({ kind: 'duplicate-identity', message: `Rows ${dup.join(', ')} share the identity ${parts.join(' / ')}`, rows: dup });
    }
    return issues;
}

const RULES = [uniqueHeaders, requiredColumns, identities];

/** The spec the app relies on for a tab: its InstantWriteTables entry (identity, writable columns). */
export async function sheetSpec(database, tab) {
    const instant = await InstantWriteUtils.getInstantWriteConfig(database, tab);
    return { identity: instant?.identity || [], columns: instant?.columns || [] };
}

/**
 * Health of one tab, read fresh (uncached).
 * @param {string} database
 * @param {string} tab
 * @param {{ identity?: string[], columns?: string[] }} [spec] defaults to sheetSpec(database, tab)
 * @returns {Promise<{ ok: boolean, issues: Array<{ kind: string, message: string, rows?: number[] }> }>}
 */
export async function checkSheetHealth(database, tab, spec = null) {
    const raw = await Database.readFresh(database, tab);
    const sheet = { header: raw?.[0] || [], rows: (raw || []).slice(1) };
    if (!sheet.header.some(h => String(h ?? '').trim())) {
        return { ok: false, issues: [{ kind: 'no-header', message: `${tab} has no header row` }] };
    }
    const s = { identity: [], columns: [], ...(spec || await sheetSpec(database, tab)) };
    const issues = RULES.flatMap(rule => rule(sheet, s));
    return { ok: issues.length === 0, issues };
}
