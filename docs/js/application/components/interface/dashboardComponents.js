import { html, NavigationRegistry } from '../../index.js';
import { GRID, MINI_MIN_CELL, MINI_BASE_WIDTH, transpose, clampRect, planMove, planResize, freeCells, sameRect } from '../../utils/dashboardLayout.js';

/**
 * Dashboard grid (single screen, 4 x 2 landscape / 2 x 4 portrait; layout rules in
 * utils/dashboardLayout.js).
 *
 * - #app-content is the grid on the dashboard. Every page container is wrapped in a DashboardCell,
 *   on every page, so a card keeps its component when it's expanded to the full page and back.
 *   Off the dashboard the cell is `display: contents`.
 * - Cards are placed with CSS variables (--col-start, --row-start, --col-span, --row-span) in
 *   landscape terms; a portrait media rule swaps the axes. Pointer math converts with transpose.
 * - Miniature mode: when cells are smaller than MINI_MIN_CELL, and always while arranging, a card
 *   renders its page MINI_BASE_WIDTH px wide per column, scaled down to fit, and inert. Clicking a
 *   miniature expands it.
 * - Arrange mode (DashboardRegistry.arranging): cards are dragged to move (onto one card swaps them)
 *   and resized from their corner; free cells offer the notices card and cards with no room.
 */

/** The notices page: the app banners as a dashboard card (see NoticesContent) */
export const NOTICES_PATH = 'notices';

const PORTRAIT_QUERY = '(orientation: portrait)';

/** Grid geometry of #app-content, measured in px (viewport coordinates for the origin) */
export const dashboardGeometry = Vue.reactive({
    portrait: false,
    left: 0,
    top: 0,
    cellWidth: 0,
    cellHeight: 0,
    gap: 0,
    get cols() { return this.portrait ? GRID.rows : GRID.cols; },
    get rows() { return this.portrait ? GRID.cols : GRID.rows; },
    // Cells too small to use a page in: cards become miniatures
    get miniature() {
        return this.cellWidth > 0 && (this.cellWidth < MINI_MIN_CELL.width || this.cellHeight < MINI_MIN_CELL.height);
    }
});

let _gridEl = null;
let _observer = null;
let _portraitQuery = null;

/** Measure the grid's cells. Called on resize, orientation change and on entering the dashboard. */
export function measureDashboardGrid() {
    if (!_gridEl) return;
    const style = getComputedStyle(_gridEl);
    const rect = _gridEl.getBoundingClientRect();
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    const gap = parseFloat(style.columnGap) || 0;
    const portrait = !!_portraitQuery?.matches;
    const cols = portrait ? GRID.rows : GRID.cols;
    const rows = portrait ? GRID.cols : GRID.rows;
    const width = _gridEl.clientWidth - padLeft - padRight;
    const height = _gridEl.clientHeight - padTop - padBottom;
    Object.assign(dashboardGeometry, {
        portrait,
        left: rect.left + _gridEl.clientLeft + padLeft,
        top: rect.top + _gridEl.clientTop + padTop,
        gap,
        cellWidth: Math.max(0, (width - gap * (cols - 1)) / cols),
        cellHeight: Math.max(0, (height - gap * (rows - 1)) / rows)
    });
}

/** Start measuring the dashboard grid element (#app-content) */
export function observeDashboardGrid(el) {
    stopObservingDashboardGrid();
    _gridEl = el;
    _observer = new ResizeObserver(() => measureDashboardGrid());
    _observer.observe(el);
    _portraitQuery = window.matchMedia(PORTRAIT_QUERY);
    _portraitQuery.addEventListener('change', measureDashboardGrid);
    measureDashboardGrid();
}

export function stopObservingDashboardGrid() {
    _observer?.disconnect();
    _portraitQuery?.removeEventListener('change', measureDashboardGrid);
    _observer = null;
    _portraitQuery = null;
    _gridEl = null;
}

/** Every 1 x 1 cell of the grid, row by row (the loading placeholders) */
export const DASHBOARD_CELLS = Object.freeze(freeCells([]));

/** CSS variables placing a stored (landscape) rect on the grid */
export function gridAreaStyle({ x, y, w, h }) {
    return { '--col-start': x + 1, '--row-start': y + 1, '--col-span': w, '--row-span': h };
}

/** A stored rect as drawn on the current grid, and back (transpose is its own inverse) */
function toDisplay(rect) {
    return dashboardGeometry.portrait ? transpose(rect) : rect;
}

/** The display cell under a viewport point, clamped to the grid */
function cellAt(clientX, clientY) {
    const g = dashboardGeometry;
    const col = Math.floor((clientX - g.left + g.gap / 2) / (g.cellWidth + g.gap));
    const row = Math.floor((clientY - g.top + g.gap / 2) / (g.cellHeight + g.gap));
    return {
        col: Math.min(Math.max(0, col), g.cols - 1),
        row: Math.min(Math.max(0, row), g.rows - 1)
    };
}

/** The drag in progress, shared by the dragged cell and the arrange layer's drop preview */
export const dashboardDrag = Vue.reactive({
    path: null,
    mode: null, // 'move' | 'resize'
    rect: null, // target rect, stored terms
    valid: false
});

/**
 * Wraps one page container. On the dashboard it is the card's grid cell: it places the card,
 * scales it as a miniature, and draws the expand overlay and the arrange handles.
 * Slot props: { miniature } (the page is inert while true).
 */
export const DashboardCell = {
    props: {
        // The placed card ({ path, x, y, w, h }), or null off the dashboard
        card: { type: Object, default: null },
        title: { type: String, default: '' }
    },
    emits: ['expand'],
    computed: {
        onDashboard() {
            return !!this.card;
        },
        arranging() {
            return this.onDashboard && NavigationRegistry.dashboardRegistry.arranging;
        },
        miniature() {
            return this.onDashboard && (this.arranging || dashboardGeometry.miniature);
        },
        dragging() {
            return this.onDashboard && dashboardDrag.path === this.card.path;
        },
        cellStyle() {
            if (!this.onDashboard) return null;
            const style = gridAreaStyle(this.card);
            if (this.miniature) {
                // Render the page MINI_BASE_WIDTH px wide per column, scaled down to the cell
                const g = dashboardGeometry;
                const shown = toDisplay(this.card);
                const width = g.cellWidth * shown.w + g.gap * (shown.w - 1);
                const height = g.cellHeight * shown.h + g.gap * (shown.h - 1);
                const scale = width > 0 ? Math.min(1, width / (MINI_BASE_WIDTH * shown.w)) : 1;
                style['--mini-scale'] = scale;
                style['--mini-width'] = `${width / scale}px`;
                style['--mini-height'] = `${height / scale}px`;
            }
            return style;
        }
    },
    watch: {
        miniature(isMini) {
            // A miniature shows the top of its page (and drops any fixed sticky header)
            if (isMini) this.$el?.querySelector?.('.dashboard-card > .content')?.scrollTo({ top: 0 });
        }
    },
    methods: {
        startDrag(mode, event) {
            if (event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            const shown = toDisplay(this.card);
            const cell = cellAt(event.clientX, event.clientY);
            this._grab = { col: cell.col - shown.x, row: cell.row - shown.y };
            Object.assign(dashboardDrag, { path: this.card.path, mode, rect: { ...this.card }, valid: true });
        },
        onDrag(event) {
            if (!this.dragging) return;
            const placed = NavigationRegistry.dashboardRegistry.layout.placed;
            const shown = toDisplay(this.card);
            const cell = cellAt(event.clientX, event.clientY);
            let rect;
            let plan;
            if (dashboardDrag.mode === 'move') {
                rect = clampRect(toDisplay({ x: cell.col - this._grab.col, y: cell.row - this._grab.row, w: shown.w, h: shown.h }));
                plan = planMove(placed, this.card.path, rect);
            } else {
                const size = toDisplay({ x: shown.x, y: shown.y, w: Math.max(1, cell.col - shown.x + 1), h: Math.max(1, cell.row - shown.y + 1) });
                rect = { x: this.card.x, y: this.card.y, w: Math.min(size.w, GRID.cols - this.card.x), h: Math.min(size.h, GRID.rows - this.card.y) };
                plan = planResize(placed, this.card.path, rect.w, rect.h);
            }
            dashboardDrag.rect = rect;
            dashboardDrag.valid = !!plan;
        },
        async endDrag(commit) {
            if (!this.dragging) return;
            const { mode, rect, valid } = dashboardDrag;
            Object.assign(dashboardDrag, { path: null, mode: null, rect: null, valid: false });
            if (!commit || !valid || !rect || sameRect(rect, this.card)) return;
            const registry = NavigationRegistry.dashboardRegistry;
            if (mode === 'move') await registry.move(this.card.path, rect);
            else await registry.resize(this.card.path, rect.w, rect.h);
        },
        remove() {
            NavigationRegistry.dashboardRegistry.remove(this.card.path);
        }
    },
    template: html`
        <div class="dashboard-cell" :class="{ miniature, arranging, dragging }" :style="cellStyle">
            <slot :miniature="miniature"></slot>
            <div v-if="miniature && !arranging"
                 class="container-expand-overlay"
                 role="button"
                 tabindex="0"
                 :title="'Open ' + title"
                 @click="$emit('expand')"
                 @keydown.enter.prevent="$emit('expand')"
                 @keydown.space.prevent="$emit('expand')">
                <span class="material-symbols-outlined">expand_content</span>
            </div>
            <template v-if="arranging">
                <div class="dashboard-cell-handle"
                     :title="'Drag to move ' + title"
                     @pointerdown="startDrag('move', $event)"
                     @pointermove="onDrag"
                     @pointerup="endDrag(true)"
                     @pointercancel="endDrag(false)">
                    <span>{{ title }}</span>
                </div>
                <button class="button-symbol red dashboard-cell-remove"
                        :title="'Remove ' + title + ' from the dashboard'"
                        @click="remove">
                    <span class="material-symbols-outlined">close</span>
                </button>
                <button class="button-symbol white dashboard-cell-resize"
                        title="Drag to resize"
                        @pointerdown="startDrag('resize', $event)"
                        @pointermove="onDrag"
                        @pointerup="endDrag(true)"
                        @pointercancel="endDrag(false)">
                    <span class="material-symbols-outlined">open_in_full</span>
                </button>
            </template>
        </div>
    `
};

/**
 * Arrange mode's grid items: a slot in every free cell (offering the notices card and any card
 * with no room), the drop preview while dragging, and the bar with Done.
 */
export const DashboardArrangeLayer = {
    computed: {
        registry() {
            return NavigationRegistry.dashboardRegistry;
        },
        freeCells() {
            return freeCells(this.registry.layout.placed);
        },
        // Cards that can go into a free cell: the notices card when it isn't on the dashboard,
        // and cards on the dashboard that had no room
        addable() {
            const options = this.registry.layout.unplaced.map(card => ({
                path: card.path,
                title: NavigationRegistry.getDisplayName(card.path, true),
                onDashboard: true
            }));
            if (!this.registry.has(NOTICES_PATH)) {
                options.unshift({ path: NOTICES_PATH, title: NavigationRegistry.getDisplayName(NOTICES_PATH, true), onDashboard: false });
            }
            return options;
        },
        preview() {
            return dashboardDrag.path && dashboardDrag.rect ? dashboardDrag : null;
        }
    },
    methods: {
        gridAreaStyle,
        cellKey(cell) {
            return `${cell.x}-${cell.y}`;
        },
        async addAt(option, cell) {
            if (option.onDashboard) {
                await this.registry.placeAt(option.path, cell);
            } else {
                await this.registry.add(option.path);
                await this.registry.placeAt(option.path, cell);
            }
        },
        done() {
            this.registry.arranging = false;
        }
    },
    template: html`
        <div v-for="cell in freeCells" :key="cellKey(cell)" class="dashboard-slot" :style="gridAreaStyle(cell)">
            <div v-if="addable.length" class="cell-button-list">
                <button v-for="option in addable" :key="option.path" class="white" @click="addAt(option, cell)">
                    + {{ option.title }}
                </button>
            </div>
        </div>
        <div v-if="preview"
             class="dashboard-drop-preview"
             :class="preview.valid ? 'valid' : 'invalid'"
             :style="gridAreaStyle(preview.rect)"></div>
        <div class="button-bar dashboard-arrange-bar">
            <span>Drag a card to move it, its corner to resize it</span>
            <button class="green" @click="done">Done</button>
        </div>
    `
};

/** Whether the notices card is on the dashboard grid */
export function noticesOnDashboard() {
    return !!NavigationRegistry.dashboardRegistry.getPlaced(NOTICES_PATH);
}
