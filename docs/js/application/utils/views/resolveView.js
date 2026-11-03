/**
 * Views engine (§4.2–§4.4, §4.8, §4.15).
 *
 *   resolveView(fields, view, { size, print, patches, editMode }) → ResolvedView   (pure)
 *   resolveAction(actionDef, resolved, { hasRowDetails })            → ResolvedAction (pure)
 * Renderers read the ResolvedView directly (Phase 5 renderer contract, §4.4).
 *
 * Fields describe what the data is (FieldDef: key, label, type, format, editable, options).
 * Views describe presentation (ViewDef): which columns show and in what order, widths, fonts,
 * colours, header text and icons, which columns sort, and which cell draws a value (style).
 * A registry may hold `style` and `sortable` shared by all its views (withRegistryDefaults).
 * The resolved fields renderers read are the data fields with the view's presentation merged in.
 * Validation never throws: problems are reported through devWarn() and resolved to a safe result.
 *
 * Pure: no Vue, no DOM. Safe to import from tests.
 */
// ── Dev warnings ─────────────────────────────────────────────────────────────

const IS_DEV = typeof window !== 'undefined' && !!window.location && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.protocol === 'file:'
);
const defaultWarn = (msg) => console.warn('[views] ' + msg);
let warnHandler = defaultWarn;
const warnedMessages = new Set();

/** Replace the warning sink (tests). Pass null to restore the default. Clears the dedupe set. */
export function setViewWarningHandler(fn) {
    warnHandler = fn || defaultWarn;
    warnedMessages.clear();
}

/** Dev-only, de-duplicated warning. */
export function devWarn(msg) {
    if (warnHandler === defaultWarn && !IS_DEV) return;
    if (warnedMessages.has(msg)) return;
    warnedMessages.add(msg);
    warnHandler(msg);
}

// ── Constants ────────────────────────────────────────────────────────────────

const ALWAYS_HIDDEN = Object.freeze(['AppData', 'EditHistory', 'MetaData']);

/** Presentation properties that belong to views, not fields (§4.1). Ignored, with a dev warning. */
const LEGACY_FIELD_PROPS = Object.freeze([
    'width', 'font', 'autoColor', 'cellClass', 'columnClass', 'allowHide', 'details',
    'stackUnder', 'sticky', 'firstRow', 'secondRow', 'whenSmall',
    'labelHtml', 'title', 'sortable', 'cell', 'cellOptions', 'colspan', 'isIndex'
]);

/** View style properties merged into the resolved field renderers read (label overrides the field's). */
const STYLE_FIELD_PROPS = Object.freeze(['label', 'labelHtml', 'title', 'cell', 'cellOptions', 'colspan']);

/** Cells that follow the data type when the view names none (read-only ones render disabled). */
const TYPE_CELLS = Object.freeze({ checkbox: 'checkbox', select: 'select' });

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Set) && !(v instanceof Map);
}

/**
 * Deep merge for view patches/variants: objects merge deeply, arrays (and everything else) replace.
 * `undefined` values in the patch are ignored.
 */
export function mergeView(base, patch) {
    if (!isPlainObject(patch)) return base;
    const out = isPlainObject(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeView(out[k], v) : v;
    }
    return out;
}

/** Same rule as preferences page patterns: a trailing `*` matches by prefix; otherwise exact. */
export function matchesKeyPattern(pattern, key) {
    if (!pattern || typeof pattern !== 'string') return false;
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) return String(key).startsWith(pattern.slice(0, -1));
    return key === pattern;
}

function isPattern(entry) {
    return typeof entry === 'string' && entry.endsWith('*');
}

/** Expand one key or pattern against the known field keys (patterns keep field order). */
function expandEntry(entry, fieldKeys) {
    if (typeof entry !== 'string') return [];
    if (isPattern(entry)) return fieldKeys.filter(k => matchesKeyPattern(entry, k));
    return [entry];
}

/** Normalize a Line (key | key[]) to a key array, expanding patterns inline. */
function normalizeLine(line, fieldKeys) {
    const entries = Array.isArray(line) ? line : [line];
    return entries.flatMap(e => expandEntry(e, fieldKeys));
}

/** Normalize Line[] (chip, card, footer) to string[][]. */
function normalizeLines(lines, fieldKeys) {
    if (!lines) return [];
    const list = Array.isArray(lines) ? lines : [lines];
    return list.map(l => normalizeLine(l, fieldKeys)).filter(l => l.length > 0);
}

/**
 * Normalize the table `columns` list (Slot[]) to slots of lines.
 * A top-level pattern string expands into one slot per matching key; a pattern inside a
 * stack expands inline into that line.
 * @returns {string[][][]} slots → lines → keys
 */
function normalizeSlots(columns, fieldKeys) {
    const slots = [];
    for (const slot of columns || []) {
        if (typeof slot === 'string') {
            for (const key of expandEntry(slot, fieldKeys)) slots.push([[key]]);
        } else if (Array.isArray(slot)) {
            const lines = slot.map(line => normalizeLine(line, fieldKeys)).filter(l => l.length > 0);
            if (lines.length) slots.push(lines);
        }
    }
    return slots;
}

/** The view's sort ({ key, dir } or a list of them) as [{ key, direction: 'asc'|'desc' }]. */
function normalizeSort(sort) {
    return (Array.isArray(sort) ? sort : [sort])
        .filter(s => s && typeof s.key === 'string' && s.key)
        .map(s => ({ key: s.key, direction: s.dir === 'desc' ? 'desc' : 'asc' }));
}

/** Apply medium / narrow / print variants in cascade order. */
function applyVariants(view, size = 'wide', print = false) {
    const { variants, ...base } = view || {};
    let out = base;
    if (variants) {
        if (size === 'medium' || size === 'narrow') out = mergeView(out, variants.medium);
        if (size === 'narrow') out = mergeView(out, variants.narrow);
        if (print) out = mergeView(out, variants.print);
    }
    return out;
}

/**
 * A registry's view with the registry-level presentation under it: registry.style and
 * registry.sortable apply to every view; the view's own entries win (objects merge, lists replace).
 */
export function withRegistryDefaults(registry, view) {
    if (!view || !registry || (!registry.style && !registry.sortable)) return view;
    const defaults = {};
    if (registry.style) defaults.style = registry.style;
    if (registry.sortable) defaults.sortable = registry.sortable;
    return mergeView(defaults, view);
}

/** Apply component patches (§4.15) whose sizes include `size` (omitted sizes = all sizes). */
function applyPatches(view, patches = [], size = 'wide') {
    let out = view;
    for (const p of patches || []) {
        if (!p || !p.patch) continue;
        if (Array.isArray(p.sizes) && p.sizes.length && !p.sizes.includes(size)) continue;
        out = mergeView(out, p.patch);
    }
    return out;
}

// ── resolveView ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ResolvedSlot
 * @property {string}     key         the slot's primary key (first key of the first line)
 * @property {Object}     field       FieldDef of the primary key
 * @property {string[][]} lines       stack of lines, each a list of inline keys
 * @property {number}     [width]
 * @property {string}     [font]
 * @property {string}     [color]     colour rule for the primary key
 * @property {string}     [columnColor]
 * @property {'start'|'end'|null} sticky
 */

/**
 * Resolve a view against the page's fields.
 * @param {Object[]} fields  FieldDef[]
 * @param {Object}   view    ViewDef
 * @param {{ size?: 'wide'|'medium'|'narrow', print?: boolean, patches?: Array, editMode?: 'none'|'batch'|'instant', theme?: string }} [opts]
 * @returns {Object} ResolvedView
 */
export function resolveView(fields, view, opts = {}) {
    const { size = 'wide', print = false, patches = [], editMode = 'none', theme: fallbackTheme = '' } = opts;
    const viewId = view?.id || '';

    // 1–2. Variants, then patches
    const v = applyPatches(applyVariants(view || {}, size, print), patches, size);

    // Field universe (dedupe, first definition wins)
    const fieldMap = new Map();
    for (const f of fields || []) {
        if (!f || typeof f.key !== 'string' || fieldMap.has(f.key)) continue;
        const legacy = LEGACY_FIELD_PROPS.filter(p => f[p] !== undefined);
        if (legacy.length) devWarn(`field "${f.key}" has presentation props (${legacy.join(', ')}); they are ignored — set them in the view`);
        const data = { ...f };
        for (const p of legacy) delete data[p];
        fieldMap.set(f.key, data);
    }
    const fieldKeys = [...fieldMap.keys()];
    const known = (key) => fieldMap.has(key);
    const warnUnknown = (where, key) => devWarn(`view "${viewId}": unknown key "${key}" in ${where} (ignored)`);

    const tier = new Map(); // key → 'shown' | 'details' | 'hidden'
    for (const k of ALWAYS_HIDDEN) if (known(k)) tier.set(k, 'hidden');

    const layout = v.layout || 'table';

    // 3a. Shown tier: the layout's primary section
    let slotKeyLines = [];          // table: string[][][]
    let chip = [];                  // calendar: string[][]
    let card = [], footer = [];     // cards: string[][]
    const claimShown = (key, where) => {
        if (!known(key)) { warnUnknown(where, key); return false; }
        if (tier.has(key)) {
            if (!ALWAYS_HIDDEN.includes(key)) devWarn(`view "${viewId}": duplicate key "${key}" in ${where} (first tier wins)`);
            return false;
        }
        tier.set(key, 'shown');
        return true;
    };
    const claimLines = (lines, where) => lines
        .map(line => line.filter(k => claimShown(k, where)))
        .filter(line => line.length > 0);

    const tableColumnsDeclared = layout === 'table' && Array.isArray(v.columns);
    if (layout === 'table') {
        if (tableColumnsDeclared) {
            slotKeyLines = normalizeSlots(v.columns, fieldKeys)
                .map(lines => claimLines(lines, 'columns'))
                .filter(lines => lines.length > 0);
        }
    } else if (layout === 'calendar') {
        chip = claimLines(normalizeLines(v.calendar?.chip, fieldKeys), 'calendar.chip');
    } else if (layout === 'cards') {
        card = claimLines(normalizeLines(v.cards?.card, fieldKeys), 'cards.card');
        footer = claimLines(normalizeLines(v.cards?.footer, fieldKeys), 'cards.footer');
    }

    // 3b. Details and hidden lists
    let detailsRest = v.details === undefined || v.details === 'rest';
    let hiddenRest = v.hidden === 'rest';
    if (detailsRest && hiddenRest) {
        if (v.details === 'rest') devWarn(`view "${viewId}": both details and hidden are 'rest'; details wins`);
        hiddenRest = false;
    }
    const detailsOrder = [];
    const claim = (list, tierName, where) => {
        for (const entry of list) {
            for (const key of expandEntry(entry, fieldKeys)) {
                if (!known(key)) { warnUnknown(where, key); continue; }
                if (tier.has(key)) continue; // first tier wins (patterns may overlap silently)
                tier.set(key, tierName);
                if (tierName === 'details') detailsOrder.push(key);
            }
        }
    };
    if (Array.isArray(v.details)) claim(v.details, 'details', 'details');
    if (Array.isArray(v.hidden)) claim(v.hidden, 'hidden', 'hidden');

    // 3c. Unlisted fields
    const unlisted = fieldKeys.filter(k => !tier.has(k));
    if (layout === 'table' && !tableColumnsDeclared) {
        // No columns declared: every remaining field is a column, in field order.
        for (const k of unlisted) { tier.set(k, 'shown'); slotKeyLines.push([[k]]); }
    } else if (detailsRest) {
        for (const k of unlisted) { tier.set(k, 'details'); detailsOrder.push(k); }
    } else {
        if (unlisted.length && !hiddenRest) devWarn(`view "${viewId}": fields not placed in any tier are hidden: ${unlisted.join(', ')}`);
        for (const k of unlisted) tier.set(k, 'hidden');
    }

    // 4. Style per field (patterns first, in declaration order; exact keys override)
    const styleDecl = v.style || {};
    const style = {};
    for (const key of fieldKeys) {
        let s = {};
        for (const [pat, val] of Object.entries(styleDecl)) {
            if (isPattern(pat) && matchesKeyPattern(pat, key)) s = { ...s, ...val };
        }
        if (styleDecl[key]) s = { ...s, ...styleDecl[key] };
        if (Object.keys(s).length) style[key] = s;
    }
    for (const pat of Object.keys(styleDecl)) {
        if (!isPattern(pat) && !known(pat)) warnUnknown('style', pat);
    }

    // 4b. Resolved fields: the data field plus the view's presentation (style props, sortable,
    //     and a type's cell when the view names none)
    // (unknown names in `sortable` are ignored silently: a list may name headers a sheet lacks)
    const sortableDecl = Array.isArray(v.sortable) ? v.sortable.filter(e => typeof e === 'string') : [];
    for (const [key, f] of fieldMap) {
        const s = style[key] || {};
        const resolvedField = { ...f, sortable: sortableDecl.some(p => matchesKeyPattern(p, key)) };
        for (const p of STYLE_FIELD_PROPS) if (s[p] !== undefined) resolvedField[p] = s[p];
        if (!resolvedField.cell && TYPE_CELLS[f.type]) resolvedField.cell = TYPE_CELLS[f.type];
        fieldMap.set(key, resolvedField);
    }

    // Table section
    const stickyDecl = v.table?.sticky || {};
    const stickyStart = (stickyDecl.start || []).flatMap(e => expandEntry(e, fieldKeys));
    const stickyEnd = (stickyDecl.end || []).flatMap(e => expandEntry(e, fieldKeys));
    const table = {
        sticky: { start: stickyStart, end: stickyEnd },
        hideRowsOnSearch: v.table?.hideRowsOnSearch
    };

    const slots = slotKeyLines.map(lines => {
        const key = lines[0][0];
        const s = style[key] || {};
        return {
            key,
            field: fieldMap.get(key),
            lines,
            width: s.width,
            font: s.font,
            color: s.color,
            columnColor: s.columnColor,
            sticky: stickyStart.includes(key) ? 'start' : (stickyEnd.includes(key) ? 'end' : null)
        };
    });

    // Calendar section
    let calendar = null;
    let invalid = null;
    if (layout === 'calendar') {
        const c = v.calendar || {};
        calendar = { start: c.start, end: c.end, weekStart: c.weekStart || 'sunday', yearColumn: c.yearColumn || null, chip };
        if (!c.start || !c.end || !known(c.start) || !known(c.end)) {
            invalid = 'calendar-fields';
            devWarn(`view "${viewId}": calendar start/end field missing (${c.start}, ${c.end})`);
        }
    }

    // Cards section
    let cards = null;
    if (layout === 'cards') {
        const c = v.cards || {};
        cards = { bucketBy: c.bucketBy || null, card, footer, hideOnSearch: c.hideOnSearch !== false };
        if (c.bucketBy && !known(c.bucketBy)) warnUnknown('cards.bucketBy', c.bucketBy);
    }

    // 5. Trigger (edit-mode rule: a table being edited can't use the whole row as its trigger)
    let trigger = v.action === 'row' ? 'row' : 'button';
    if (trigger === 'row' && editMode !== 'none') {
        devWarn(`view "${viewId}": action 'row' is not allowed with editMode '${editMode}'; using 'button'`);
        trigger = 'button';
    }

    // 6. Output
    const shown = layout === 'table'
        ? slots.flatMap(s => s.lines.flat())
        : layout === 'calendar' ? chip.flat() : [...card.flat(), ...footer.flat()];
    const details = detailsOrder.map(k => fieldMap.get(k));
    const hidden = new Set(fieldKeys.filter(k => tier.get(k) === 'hidden'));
    for (const k of ALWAYS_HIDDEN) hidden.add(k);

    return {
        viewId,
        name: v.name || viewId,
        layout,
        theme: v.theme ?? fallbackTheme ?? '',
        className: v.className || '',
        // Full-width container mode: releases the page's max-width while this view shows
        fullWidth: !!v.fullWidth,
        fields: fieldKeys.map(k => fieldMap.get(k)),
        fieldMap,
        style,
        slots,
        shown,
        details,
        hidden,
        tier,
        rowColor: v.rowColor || null,
        sort: normalizeSort(v.sort),
        table,
        calendar,
        cards,
        trigger,
        editMode,
        size,
        print,
        hasDetails: details.length > 0,
        invalid
    };
}

// ── resolveAction ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ResolvedAction
 * @property {'navigate'|'run'|'details'|'none'} kind
 * @property {'button'|'row'} trigger
 * @property {string} [label]
 * @property {string} [icon]        a glyph ('☷') or a material symbol name ('calendar_month')
 * @property {string} [headerIcon]  the action column's header (glyph or symbol name)
 * @property {string} [title]       the button's tooltip
 * @property {(row) => string} [to]
 * @property {(row) => void} [run]
 * @property {(row) => boolean} [disabled]
 */

/**
 * Pick the row's one primary action (§4.8): page action, else details, else none.
 * The trigger is the resolved view's (resolveView applies the edit-mode rule).
 * @param {Object} [actionDef]  { to, run, label, icon, headerIcon, title, disabled }
 * @param {Object} resolved     ResolvedView
 * @param {{ hasRowDetails?: boolean }} [opts] hasRowDetails: the page supplies a #row-details slot
 * @returns {ResolvedAction}
 */
export function resolveAction(actionDef, resolved, opts = {}) {
    const trigger = resolved?.trigger === 'row' ? 'row' : 'button';
    const def = actionDef || {};
    const disabled = typeof def.disabled === 'function' ? def.disabled : null;

    if (def.to || def.run) {
        if (def.to && def.run) devWarn(`view "${resolved?.viewId}": action defines both to and run; using to`);
        const kind = def.to ? 'navigate' : 'run';
        if (kind === 'run' && resolved?.hasDetails) {
            devWarn(`view "${resolved?.viewId}": an in-place action hides details fields (${resolved.details.map(f => f.key).join(', ')}); move them to shown or hidden`);
        }
        return {
            kind,
            trigger,
            label: def.label || '',
            icon: def.icon || (def.label ? '' : '☷'),
            headerIcon: def.headerIcon || '',
            title: def.title || '',
            to: kind === 'navigate' ? def.to : null,
            run: kind === 'run' ? def.run : null,
            disabled
        };
    }
    if (resolved?.hasDetails || opts.hasRowDetails) {
        return { kind: 'details', trigger, label: def.label || '', icon: def.icon || '☷', headerIcon: def.headerIcon || '', title: def.title || '', to: null, run: null, disabled };
    }
    return { kind: 'none', trigger: 'button', label: '', icon: '', headerIcon: '', title: '', to: null, run: null, disabled: null };
}

/** Search tiers for matchRow: shown and details keys (hidden fields are never searched). */
export function searchTiers(resolved) {
    if (!resolved) return { shown: [], details: [] };
    return { shown: resolved.shown, details: resolved.details.map(f => f.key) };
}

/**
 * Pick the active view from a registry for a URL parameter set (§4.11).
 * `view` wins, then the legacy `layout` parameter, then the registry default. Unknown ids warn.
 * @param {{ views: Object[], default?: string }} registry
 * @param {{ view?: string, layout?: string }} [params]
 * @returns {Object} ViewDef
 */
export function pickView(registry, params = {}) {
    const views = registry?.views || [];
    if (!views.length) return null;
    const byId = (id) => views.find(v => v.id === id);
    const fallback = byId(registry.default) || views[0];
    const requested = params.view || params.layout;
    if (!requested) return fallback;
    const found = byId(requested);
    if (!found) {
        devWarn(`registry "${registry.id}": unknown view id "${requested}"; using "${fallback.id}"`);
        return fallback;
    }
    return found;
}
