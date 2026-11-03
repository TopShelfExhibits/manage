/**
 * Cards adapter (views-and-renderers-plan §4.6): rows + resolved view → card models for
 * CardsComponent. Pure: no Vue, no DOM.
 *
 *   rowsToCards(rows, resolved, hooks)                           one card per row
 *   bucketRowsToCards(rows, resolved, { bucketKeys, ... })       one card per distinct row[cards.bucketBy]
 *   → [{ id, title, content, contentFooter, footerActions, cardClass, hasDetails, AppData, row, rows, bucket }]
 *
 * Lines: cards.card[0] → title (plain text), other card lines → content (HTML, values escaped),
 * cards.footer → contentFooter. Field colour renders as a badge on the value; rowColor → cardClass.
 * Decorations are placed as in every renderer (placeDecorations): a decorated key shown on the card
 * gets its cards inline; the rest become footer actions, or footer text when marked `status: true`.
 *
 * NOTE: `bucketBy` is unrelated to packlist row groups (hideGroupMembers / MetaData grouping):
 * buckets are cards that summarize many rows; row groups are table rows nested under a master row.
 */
import { formatText, escapeHtml } from './fieldFormat.js';
import { colorFor, rowColorFor } from './viewColor.js';
import { placeDecorations } from './decorations.js';

function lineText(row, keys, resolved) {
    return keys
        .map(k => formatText(row[k], resolved.fieldMap.get(k) || { key: k }))
        .filter(v => v !== '')
        .join(' | ');
}

function lineHtml(row, keys, resolved, inlineCards) {
    const parts = [];
    for (const k of keys) {
        const field = resolved.fieldMap.get(k) || { key: k };
        const text = formatText(row[k], field);
        let html = '';
        if (text !== '') {
            const color = colorFor(row, field, resolved);
            const safe = escapeHtml(text).replace(/\n/g, '<br>');
            html = color ? `<span class="card ${escapeHtml(color)} value-badge">${safe}</span>` : safe;
        }
        for (const c of inlineCards.get(k) || []) {
            if (c.status || c.action) continue; // actionable cards can't live inside v-html content
            html += ` <span class="card ${escapeHtml(c.class || c.color || '')}">${c.message}</span>`;
        }
        if (html !== '') parts.push(html);
    }
    return parts.join(' | ');
}

/** Split decoration cards into footer status text and footer actions. */
function decorationsToFooter(cards) {
    const status = [];
    const actions = [];
    for (const c of cards || []) {
        if (c.status) status.push(c.message);
        else actions.push({ label: c.message, class: c.class || c.color || 'red', onClick: c.action && !c.disabled ? c.action : null, title: c.title || c.hoverMessage || '' });
    }
    return { status, actions };
}

/**
 * One card per row.
 * @param {Object[]} rows
 * @param {Object} resolved ResolvedView with layout 'cards'
 * @param {{ decorations?: Function, decorationKeys?: string[], idKey?: string }} [hooks]
 */
export function rowsToCards(rows, resolved, hooks = {}) {
    const { decorations = null, decorationKeys = [], idKey = null } = hooks;
    const [titleKeys = [], ...contentLines] = resolved.cards?.card || [];
    const footerLines = resolved.cards?.footer || [];
    const shownKeys = new Set(resolved.shown);
    return (rows || []).map((row, i) => {
        const { byKey, rowLevel } = placeDecorations(decorations, decorationKeys, row, shownKeys);
        const title = lineText(row, titleKeys, resolved);
        const content = contentLines.map(keys => lineHtml(row, keys, resolved, byKey)).filter(Boolean).join('<br>');
        const footerParts = footerLines.map(keys => lineHtml(row, keys, resolved, byKey)).filter(Boolean);
        const { status, actions } = decorationsToFooter(rowLevel);
        const contentFooter = [...footerParts, ...status].join('<br>') || undefined;

        return {
            id: idKey ? row[idKey] : (row.id ?? row.sheetId ?? title ?? i),
            title,
            content,
            contentFooter,
            footerActions: actions.length ? actions : undefined,
            cardClass: rowColorFor(row, resolved) || resolved.theme || 'gray',
            hasDetails: !!resolved.hasDetails,
            AppData: row.AppData,
            row,
            rows: [row],
            bucket: null
        };
    });
}

/**
 * One card per bucket (distinct row[cards.bucketBy]). Empty buckets come from bucketKeys.
 * Bucket cards have no details (R2.7); their primary action is the page's navigation.
 * @param {Object[]} rows member rows
 * @param {Object} resolved
 * @param {{ bucketKeys?: string[], bucketDecorations?: (key, rows) => Object[], bucketLabel?: (key) => string, bucketAppData?: (key) => Object }} [opts]
 */
export function bucketRowsToCards(rows, resolved, opts = {}) {
    const { bucketKeys = [], bucketDecorations = null, bucketLabel = null, bucketAppData = null } = opts;
    const by = resolved.cards?.bucketBy;
    const groups = new Map();
    for (const key of bucketKeys) if (!groups.has(key)) groups.set(key, []);
    if (by) {
        for (const row of rows || []) {
            const key = row?.[by];
            if (key === undefined || key === null || key === '') continue;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        }
    }
    const cards = [];
    for (const [key, members] of groups) {
        const decos = bucketDecorations ? (bucketDecorations(key, members) || []) : [];
        const { status, actions } = decorationsToFooter(decos);
        const title = bucketLabel ? bucketLabel(key) : String(key);
        cards.push({
            id: key,
            title,
            content: '',
            contentFooter: status.length ? status.join('<br>') : undefined,
            footerActions: actions.length ? actions : undefined,
            cardClass: resolved.theme || 'gray',
            hasDetails: false,
            AppData: bucketAppData ? bucketAppData(key) : undefined,
            row: { [by]: key, _bucket: key, _members: members },
            rows: members,
            bucket: key
        });
    }
    return cards;
}
