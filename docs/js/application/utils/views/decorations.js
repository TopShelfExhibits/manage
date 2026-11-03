/**
 * Decoration placement (views-and-renderers-plan §4.14), shared by every renderer.
 * A page's decorations(row, key) returns Card[] for a key, or for the row when key is null.
 *
 * Pure: no Vue, no DOM. Safe to import from tests.
 */

/**
 * Split a row's decorations into those placed inline on displayed keys and the rest
 * (row-level cards plus cards for decorated keys the renderer doesn't display).
 * @param {Function|null} decorations  (row, key) → Card[]
 * @param {string[]} decorationKeys    keys the page decorates
 * @param {Object} row
 * @param {Set<string>|string[]} displayedKeys
 * @returns {{ byKey: Map<string, Object[]>, rowLevel: Object[] }}
 */
export function placeDecorations(decorations, decorationKeys, row, displayedKeys) {
    const byKey = new Map();
    const rowLevel = [];
    if (typeof decorations !== 'function' || !row) return { byKey, rowLevel };
    const shown = displayedKeys instanceof Set ? displayedKeys : new Set(displayedKeys || []);
    const safe = (key) => {
        try { return decorations(row, key) || []; } catch (e) { console.warn('[views] decorations failed', e); return []; }
    };
    for (const key of decorationKeys || []) {
        const cards = safe(key);
        if (!cards.length) continue;
        if (shown.has(key)) byKey.set(key, cards);
        else rowLevel.push(...cards);
    }
    rowLevel.push(...safe(null));
    return { byKey, rowLevel };
}
