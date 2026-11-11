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
 */

export const GRID = Object.freeze({ cols: 4, rows: 2 });

/**
 * Miniature mode: below this cell size (px) cards stop being interactive and show a scaled
 * miniature of the page instead. A miniature renders the page MINI_BASE_WIDTH px wide per column
 * (the narrow container tier, like the old dashboard card), scaled down to fit its cells.
 */
export const MINI_MIN_CELL = Object.freeze({ width: 300, height: 200 });
export const MINI_BASE_WIDTH = 360;

/** Path of a stored entry (a plain string in old data). */
export function entryPath(entry) {
    return typeof entry === 'string' ? entry : (entry?.path || '');
}

/** Path without URL parameters: one card per page path. */
export function cleanPath(path) {
    return String(path || '').split('?')[0];
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
    const ignore = ignorePath == null ? null : cleanPath(ignorePath);
    return placed.every(card => cleanPath(card.path) === ignore || !rectsOverlap(card, rect));
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
 *   3. What still doesn't fit is unplaced: kept in the list, not drawn.
 * Duplicate paths (same page twice) keep the first.
 * @returns {{ placed: Array<{path,index,x,y,w,h}>, unplaced: Array<{path,index}> }}
 *          index is the entry's position in the stored list.
 */
export function normalizeLayout(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const placed = [];
    const unplaced = [];
    const seen = new Set();
    const pending = [];

    list.forEach((entry, index) => {
        const path = entryPath(entry);
        const key = cleanPath(path);
        if (!key || seen.has(key)) return;
        seen.add(key);
        const stored = typeof entry === 'object' ? { x: entry.x, y: entry.y, w: entry.w, h: entry.h } : null;
        if (stored && isValidRect(stored) && fits(placed, stored)) {
            placed.push({ path, index, ...stored });
        } else {
            pending.push({ path, index, entry });
        }
    });

    for (const { path, index, entry } of pending) {
        const size = sizeFromClasses(typeof entry === 'object' ? entry.classes : '');
        const rect = firstFreeSlot(placed, size.w, size.h) || firstFreeSlot(placed, 1, 1);
        if (rect) placed.push({ path, index, ...rect });
        else unplaced.push({ path, index });
    }

    placed.sort((a, b) => a.index - b.index);
    return { placed, unplaced };
}

/**
 * Plan a move of one card to rect. Into free space it simply moves. Onto exactly one other card
 * it swaps: that card goes to the moved card's old position, keeping its size, when it fits there.
 * @returns {Array<{path,x,y,w,h}>|null} the rects to store, or null when the move isn't possible
 */
export function planMove(placed, path, rect) {
    const key = cleanPath(path);
    const card = placed.find(c => cleanPath(c.path) === key);
    if (!card || !isValidRect(rect)) return null;
    if (fits(placed, rect, path)) return [{ path: card.path, ...rect }];

    const others = placed.filter(c => cleanPath(c.path) !== key);
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
 * Plan a resize of one card to w x h, keeping its top-left cell.
 * @returns {Array<{path,x,y,w,h}>|null}
 */
export function planResize(placed, path, w, h) {
    const key = cleanPath(path);
    const card = placed.find(c => cleanPath(c.path) === key);
    if (!card) return null;
    const rect = { x: card.x, y: card.y, w, h };
    return fits(placed, rect, path) ? [{ path: card.path, ...rect }] : null;
}
