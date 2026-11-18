/**
 * Dashboard layout: pure helpers for the single-screen card grid (no Vue, no data access).
 *
 * The dashboard is a fixed grid of GRID.cols x GRID.rows cells (4 x 2) in landscape. Portrait
 * screens show the same layout transposed (2 x 4): CSS swaps the axes, so a layout is stored and
 * edited once, in landscape terms. A card covers a rect { x, y, w, h } in cells, 0-based.
 *
 * Stored entries (user data 'dashboard_containers') are { path, classes, x, y, w, h }. Older
 * entries have only { path, classes } (classes 'wide' / 'tall') or are a plain path string;
 * normalizeLayout places those first-fit when read, so old data needs no migration. `classes`
 * keeps being written from the size (classesForSize), so sessions on an older deploy still
 * draw something sensible.
 *
 * Groups: a group is one cell split into GROUP_SIDE x GROUP_SIDE half cells, holding small cards.
 * A card in a group covers one half cell, two (wide or tall), or all four. A group is stored as
 * { path: groupPath(id), group: id, x, y, w, h } and placed like a card. Older deploys read every
 * entry as a page and fail on one without a path; under the dashboard's own location
 * (dashboard/group:<id>) they draw it as an empty card. Groups stored before they had a path get
 * groupPath(id) when read (entryPath) and when next written. A card in a group is stored as
 * { path, classes, inGroup: id, slot: { x, y, w, h } } with no rect (an older deploy places it
 * first-fit). Its slot is a rect in half cells from the group's corner, in landscape terms, so
 * the rect helpers (rectsOverlap, resizeRect, sameRect) work on slots too; its rect on the grid
 * is the slot's (slotRect).
 */

export const GRID = Object.freeze({ cols: 4, rows: 2 });
export const GROUP_SIDE = 2;

/**
 * Miniature mode: below this cell size (px) cards stop being interactive and show a scaled
 * miniature of the page instead. A miniature renders the page MINI_BASE_WIDTH px wide per column
 * (the narrow container tier, like the old dashboard card), scaled down to fit its cells.
 */
export const MINI_MIN_CELL = Object.freeze({ width: 300, height: 200 });
export const MINI_BASE_WIDTH = 360;

/** A group's path: under the dashboard's own location, so it never names a page */
export function groupPath(id) {
    return `dashboard/group:${id}`;
}

/** Path of a stored entry (a plain string in old data; groupPath for a group stored without one). */
export function entryPath(entry) {
    if (typeof entry === 'string') return entry;
    return entry?.path || (entry?.group ? groupPath(entry.group) : '');
}

/** A group's half cells ({ x, y, w: 1, h: 1 } from its corner), row by row */
export function groupSlots(group) {
    const slots = [];
    for (let y = 0; y < group.h * GROUP_SIDE; y++) {
        for (let x = 0; x < group.w * GROUP_SIDE; x++) slots.push({ x, y, w: 1, h: 1 });
    }
    return slots;
}

/** The rect on the grid of a slot in a group (a slot is in half cells from the group's corner) */
export function slotRect(group, slot) {
    return {
        x: group.x + slot.x / GROUP_SIDE,
        y: group.y + slot.y / GROUP_SIDE,
        w: slot.w / GROUP_SIDE,
        h: slot.h / GROUP_SIDE
    };
}

/** A slot inside the group, in whole half cells, clear of the other cards in it */
function slotFits(group, slot, others) {
    const { x, y, w, h } = slot || {};
    const inside = [x, y, w, h].every(Number.isInteger) && w >= 1 && h >= 1 && x >= 0 && y >= 0
        && x + w <= group.w * GROUP_SIDE && y + h <= group.h * GROUP_SIDE;
    return inside && others.every(card => !rectsOverlap(card.slot, slot));
}

/** The cards of a group (any list of { inGroup, slot }) */
function cardsIn(cards, groupId) {
    return cards.filter(card => card.inGroup === groupId);
}

/** Path without URL parameters: one card per page path. */
export function cleanPath(path) {
    return String(path || '').split('?')[0];
}

/** The card (placed card or stored entry) for a page path, ignoring URL parameters, or undefined. */
export function findCard(cards, path) {
    const key = cleanPath(path);
    return cards.find(card => cleanPath(entryPath(card)) === key);
}

/** Size from legacy classes: 'wide' spans 2 columns, 'tall' spans 2 rows. */
export function sizeFromClasses(classes) {
    const set = new Set(String(classes || '').split(' ').filter(Boolean));
    return { w: set.has('wide') ? 2 : 1, h: set.has('tall') ? 2 : 1 };
}

/** Classes for a size, keeping any other classes the entry had. */
export function classesForSize(w, h, classes = '') {
    const set = new Set(String(classes || '').split(' ').filter(c => c && c !== 'wide' && c !== 'tall'));
    if (w >= 2) set.add('wide');
    if (h >= 2) set.add('tall');
    return Array.from(set).join(' ');
}

/** A rect of whole cells that lies inside the grid. */
export function isValidRect(rect) {
    if (!rect) return false;
    const { x, y, w, h } = rect;
    return [x, y, w, h].every(Number.isInteger)
        && w >= 1 && h >= 1 && x >= 0 && y >= 0
        && x + w <= GRID.cols && y + h <= GRID.rows;
}

/** Clamp a rect into the grid: size first (1..cols, 1..rows), then position. */
export function clampRect({ x = 0, y = 0, w = 1, h = 1 }) {
    const cw = Math.min(Math.max(1, Math.round(w)), GRID.cols);
    const ch = Math.min(Math.max(1, Math.round(h)), GRID.rows);
    return {
        x: Math.min(Math.max(0, Math.round(x)), GRID.cols - cw),
        y: Math.min(Math.max(0, Math.round(y)), GRID.rows - ch),
        w: cw,
        h: ch
    };
}

export function rectsOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function sameRect(a, b) {
    return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Swap axes: a landscape rect drawn on a portrait grid, and back. */
export function transpose({ x, y, w, h }) {
    return { x: y, y: x, w: h, h: w };
}

/**
 * Whether rect is inside the grid and free of the placed cards.
 * @param {Array<{path:string,x:number,y:number,w:number,h:number}>} placed
 * @param {Object} rect
 * @param {string} [ignorePath] - a card to leave out (the one being moved)
 */
export function fits(placed, rect, ignorePath = null) {
    if (!isValidRect(rect)) return false;
    const ignored = ignorePath == null ? null : findCard(placed, ignorePath);
    return placed.every(card => card === ignored || !rectsOverlap(card, rect));
}

/** The first free rect of size w x h, scanning rows then columns, or null. */
export function firstFreeSlot(placed, w = 1, h = 1) {
    for (let y = 0; y + h <= GRID.rows; y++) {
        for (let x = 0; x + w <= GRID.cols; x++) {
            const rect = { x, y, w, h };
            if (fits(placed, rect)) return rect;
        }
    }
    return null;
}

/** Free 1 x 1 cells, row by row. */
export function freeCells(placed) {
    const cells = [];
    for (let y = 0; y < GRID.rows; y++) {
        for (let x = 0; x < GRID.cols; x++) {
            const rect = { x, y, w: 1, h: 1 };
            if (fits(placed, rect)) cells.push(rect);
        }
    }
    return cells;
}

/** No room for another 1 x 1 card. */
export function isFull(placed) {
    return firstFreeSlot(placed, 1, 1) === null;
}

/**
 * Read stored entries into a layout.
 *   1. Entries with a valid stored rect keep it, in list order, unless it overlaps one before.
 *   2. The rest are placed first-fit in list order at their legacy size (classes), or 1 x 1 when
 *      that size has no room.
 *   3. Cards in a placed group take their slot, or else the group's first free half cell. Without
 *      one they are placed like any card.
 *   4. What still doesn't fit is unplaced: kept in the list, not drawn.
 * Duplicate paths (same page twice) keep the first.
 * @returns {{ placed: Array<{path,index,x,y,w,h,group?}>, unplaced: Array<{path,index}>,
 *             grouped: Array<{path,index,inGroup,slot,x,y,w,h}> }}
 *          placed holds cards and groups (group: its id); grouped holds the cards in groups.
 *          index is the entry's position in the stored list.
 */
export function normalizeLayout(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const placed = [];
    const unplaced = [];
    const grouped = [];
    const seen = new Set();
    const pending = [];
    const members = [];

    list.forEach((entry, index) => {
        const path = entryPath(entry);
        const key = cleanPath(path);
        if (!key || seen.has(key)) return;
        seen.add(key);
        if (entry.inGroup) {
            members.push({ path, index, entry });
            return;
        }
        const card = entry.group ? { path, index, group: entry.group } : { path, index };
        const stored = typeof entry === 'object' ? { x: entry.x, y: entry.y, w: entry.w, h: entry.h } : null;
        if (stored && isValidRect(stored) && fits(placed, stored)) {
            placed.push({ ...card, ...stored });
        } else {
            pending.push({ card, entry });
        }
    });

    const placeFirstFit = (card, classes) => {
        const size = sizeFromClasses(classes);
        const rect = firstFreeSlot(placed, size.w, size.h) || firstFreeSlot(placed, 1, 1);
        if (rect) placed.push({ ...card, ...rect });
        else unplaced.push(card);
    };
    for (const { card, entry } of pending) placeFirstFit(card, entry.classes);

    for (const { path, index, entry } of members) {
        const group = placed.find(card => card.group === entry.inGroup);
        const others = group ? cardsIn(grouped, group.group) : [];
        const slot = group && (slotFits(group, entry.slot, others) ? { ...entry.slot } : freeSlotsOf(group, grouped)[0]);
        if (!slot) placeFirstFit({ path, index }, entry.classes);
        else grouped.push({ path, index, inGroup: group.group, slot, ...slotRect(group, slot) });
    }

    placed.sort((a, b) => a.index - b.index);
    return { placed, unplaced, grouped };
}

/** A placed group's free half cells */
function freeSlotsOf(group, grouped) {
    const others = cardsIn(grouped, group.group);
    return groupSlots(group).filter(slot => slotFits(group, slot, others));
}

/** The free half cells of every placed group, group by group: [{ group: id, slot }] */
export function freeGroupSlots({ placed, grouped }) {
    return placed.filter(card => card.group)
        .flatMap(group => freeSlotsOf(group, grouped).map(slot => ({ group: group.group, slot })));
}

/**
 * Plan a move of one card to rect. Into free space it simply moves. Onto exactly one other card
 * it swaps: that card goes to the moved card's old position, keeping its size, when it fits there.
 * @returns {Array<{path,x,y,w,h}>|null} the rects to store, or null when the move isn't possible
 */
export function planMove(placed, path, rect) {
    const card = findCard(placed, path);
    if (!card || !isValidRect(rect)) return null;
    if (fits(placed, rect, path)) return [{ path: card.path, ...rect }];

    const others = placed.filter(c => c !== card);
    const hit = others.filter(c => rectsOverlap(c, rect));
    if (hit.length !== 1) return null;
    const target = hit[0];
    const targetRect = { x: card.x, y: card.y, w: target.w, h: target.h };
    const rest = others.filter(c => c !== target);
    const moved = { path: card.path, ...rect };
    if (!fits([...rest, moved], targetRect)) return null;
    return [moved, { path: target.path, ...targetRect }];
}

/**
 * The rect a resize drag makes, in one set of terms (display or stored): the dragged edges follow
 * the cell under the pointer and the opposite edges stay put. Dragging an edge past its opposite
 * one turns the card over that edge.
 * @param {{x,y,w,h}} rect - the card before the drag
 * @param {{left?:boolean,right?:boolean,top?:boolean,bottom?:boolean}} edges - the dragged edges
 * @param {{col:number,row:number}} cell - the cell under the pointer
 */
export function resizeRect(rect, edges, cell) {
    const span = (start, size, low, high, at) => {
        if (!low && !high) return [start, size];
        const anchor = low ? start + size - 1 : start;
        const from = Math.min(anchor, at);
        return [from, Math.max(anchor, at) - from + 1];
    };
    const [x, w] = span(rect.x, rect.w, edges.left, edges.right, cell.col);
    const [y, h] = span(rect.y, rect.h, edges.top, edges.bottom, cell.row);
    return { x, y, w, h };
}

/**
 * Plan a resize of one card to a new rect (from any edge, so its position can change too).
 * @returns {Array<{path,x,y,w,h}>|null} - null when the rect leaves the grid or covers another card
 */
export function planResize(placed, path, rect) {
    const card = findCard(placed, path);
    return card && fits(placed, rect, path) ? [{ path: card.path, ...rect }] : null;
}

/**
 * Plan dropping a card on a half cell ({ x, y }) of a group: from the grid or a card not on the
 * dashboard yet (it takes the half cell), or a card in a group (it keeps its size, its corner on
 * the half cell, kept inside the group). Onto another card in a group, a card in a group swaps
 * with it: each takes the other's corner at its own size. Every card must still fit.
 * @returns {Array<{path,inGroup,slot}>|null} the cards' new slots, or null when it isn't possible
 */
export function planSlotDrop({ placed, grouped }, path, group, { x, y }) {
    const target = placed.find(card => card.group === group);
    if (!target) return null;
    const moving = findCard(grouped, path);
    const size = moving ? { w: moving.slot.w, h: moving.slot.h } : { w: 1, h: 1 };
    const occupant = cardsIn(grouped, group).find(card => card !== moving && rectsOverlap(card.slot, { x, y, w: 1, h: 1 }));
    let moves;
    if (occupant) {
        if (!moving) return null;
        moves = [
            { path: moving.path, inGroup: group, slot: { x: occupant.slot.x, y: occupant.slot.y, ...size } },
            { path: occupant.path, inGroup: moving.inGroup, slot: { ...occupant.slot, x: moving.slot.x, y: moving.slot.y } }
        ];
    } else {
        const cols = target.w * GROUP_SIDE;
        const rows = target.h * GROUP_SIDE;
        const slot = { x: Math.min(x, cols - size.w), y: Math.min(y, rows - size.h), ...size };
        if (moving?.inGroup === group && sameRect(slot, moving.slot)) return null;
        moves = [{ path: moving?.path ?? path, inGroup: group, slot }];
    }
    return slotsFitAfter(placed, grouped, moves) ? moves : null;
}

/**
 * Plan resizing a card in a group to a new slot (wide, tall, or back to one half cell)
 * @returns {Array<{path,inGroup,slot}>|null}
 */
export function planSlotResize({ placed, grouped }, path, slot) {
    const card = findCard(grouped, path);
    if (!card) return null;
    const moves = [{ path: card.path, inGroup: card.inGroup, slot }];
    return slotsFitAfter(placed, grouped, moves) ? moves : null;
}

/** Whether the moved cards fit in their groups, among the cards in groups after the moves */
function slotsFitAfter(placed, grouped, moves) {
    const moved = new Set(moves.map(move => cleanPath(move.path)));
    const after = [...grouped.filter(card => !moved.has(cleanPath(card.path))), ...moves];
    return moves.every(move => {
        const group = placed.find(card => card.group === move.inGroup);
        return group && slotFits(group, move.slot, cardsIn(after, move.inGroup).filter(card => card !== move));
    });
}
