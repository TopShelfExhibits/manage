import { html, NavigationRegistry, appSettings, undoRegistry } from '../../index.js';
import { GRID, GROUP_SIDE, MINI_MIN_CELL, MINI_BASE_WIDTH, transpose, clampRect, fits, planMove, planResize, planSlotDrop, planSlotResize, resizeRect, freeCells, freeGroupSlots, slotRect, sameRect, cleanPath } from '../../utils/dashboardLayout.js';

/**
 * Dashboard grid (single screen, 4 x 2 landscape / 2 x 4 portrait; layout rules in
 * utils/dashboardLayout.js).
 *
 * - #app-content is the grid on the dashboard. Every page container is wrapped in a DashboardCell,
 *   on every page, so a card keeps its component when it's expanded to the full page and back.
 *   Off the dashboard the cell is `display: contents`.
 * - Cards are placed with CSS variables (--col-start, --row-start, --col-span, --row-span) in
 *   landscape terms; a portrait media rule swaps the axes. Pointer math converts with transpose.
 *   The CSS grid has GROUP_SIDE tracks per cell, so a group's small cards are grid items too.
 * - Miniature mode: when cells are smaller than MINI_MIN_CELL, always while arranging, and always
 *   for a card in a group, a card renders its page MINI_BASE_WIDTH px wide per column, scaled down
 *   to fit, and inert. Clicking a miniature expands it.
 * - Arrange mode (DashboardRegistry.arranging): cards are dragged to move (onto one card swaps them)
 *   and resized from any edge or corner. Free cells offer the notices card, cards with no room and
 *   a new group; a group's free slots offer the same cards. A group moves like a card by its move
 *   button; the rest of it takes cards dropped onto its slots (planSlotDrop). A card in a group is
 *   dragged to another slot (onto a card in a group, the two swap) or out onto a free cell.
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

/** CSS variables placing a stored (landscape) rect on the grid, in grid tracks (GROUP_SIDE a cell) */
export function gridAreaStyle({ x, y, w, h }) {
    return {
        '--col-start': x * GROUP_SIDE + 1,
        '--row-start': y * GROUP_SIDE + 1,
        '--col-span': w * GROUP_SIDE,
        '--row-span': h * GROUP_SIDE
    };
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

/** The group whose cell is under a viewport point, or undefined */
function groupAt(clientX, clientY, placed) {
    const cell = cellAt(clientX, clientY);
    return placed.find(card => {
        const shown = card.group && toDisplay(card);
        return shown && shown.x === cell.col && shown.y === cell.row;
    });
}

/**
 * The half cell of a group nearest a viewport point: { x, y } from the group's corner, in stored
 * (landscape) terms. Each half cell reaches halfway across the gap after it.
 */
function halfCellAt(group, clientX, clientY) {
    const g = dashboardGeometry;
    const shown = toDisplay(group);
    const half = (at, origin, cellSize) => {
        const n = Math.floor((at - origin + g.gap / 2) / ((cellSize + g.gap) / GROUP_SIDE));
        return Math.min(Math.max(0, n), GROUP_SIDE - 1);
    };
    const across = half(clientX, g.left + shown.x * (g.cellWidth + g.gap), g.cellWidth);
    const down = half(clientY, g.top + shown.y * (g.cellHeight + g.gap), g.cellHeight);
    return g.portrait ? { x: down, y: across } : { x: across, y: down };
}

/** A card's resize zones along its edges and corners, as drawn: each drags the edges it names */
const RESIZE_ZONES = [
    { name: 'n', edges: { top: true } },
    { name: 's', edges: { bottom: true } },
    { name: 'e', edges: { right: true } },
    { name: 'w', edges: { left: true } },
    { name: 'nw', edges: { top: true, left: true } },
    { name: 'ne', edges: { top: true, right: true } },
    { name: 'sw', edges: { bottom: true, left: true } },
    { name: 'se', edges: { bottom: true, right: true } }
];
const CORNER_EDGES = { bottom: true, right: true };

/** The drag in progress, shared by the dragged cell and the arrange layer's drop preview */
export const dashboardDrag = Vue.reactive({
    path: null,
    mode: null, // 'move' | 'resize'
    rect: null, // target rect, stored terms
    slot: null, // or, over a group, { group, slot }: the half cell dropped on, or a resized slot
    valid: false
});

/**
 * Wraps one page container. On the dashboard it is the card's grid cell: it places the card,
 * scales it as a miniature, and draws the expand overlay and the arrange handles. In arrange mode
 * the card's header names it (its buttons give way to the remove button); a card without a header
 * (a bare card, or any card while headers are hidden) has its name on its handle instead.
 * A group's frame in arrange mode is a DashboardCell with no page: a bar at its centre moves it
 * (like a card) and removes it; it stays one cell. A card in a group is always a miniature; it
 * moves, and a button beside its remove button resizes it within the group (wide or tall).
 * Slot props, for the container: miniature (the page is inert), header (draw the container
 * header) and bare (no box of its own: the notices card's banners stand straight on the grid).
 */
export const DashboardCell = {
    props: {
        // The placed card ({ path, x, y, w, h }), or null off the dashboard
        card: { type: Object, default: null },
        title: { type: String, default: '' }
    },
    emits: ['expand'],
    created() {
        this.resizeZones = RESIZE_ZONES;
        this.cornerEdges = CORNER_EDGES;
    },
    computed: {
        onDashboard() {
            return !!this.card;
        },
        arranging() {
            return this.onDashboard && NavigationRegistry.dashboardRegistry.arranging;
        },
        isGroup() {
            return this.onDashboard && !!this.card.group;
        },
        inGroup() {
            return this.onDashboard && !!this.card.inGroup;
        },
        miniature() {
            return this.onDashboard && !this.isGroup && (this.arranging || dashboardGeometry.miniature || this.inGroup);
        },
        dragging() {
            return this.onDashboard && dashboardDrag.path === this.card.path;
        },
        bare() {
            return this.onDashboard && cleanPath(this.card.path) === NOTICES_PATH;
        },
        // Pages always have a header; cards unless bare or headers are hidden
        header() {
            return !this.onDashboard || (!this.bare && appSettings.showDashboardHeaders);
        },
        cellStyle() {
            if (!this.onDashboard) return null;
            const style = gridAreaStyle(this.card);
            if (this.miniature) {
                // The page renders MINI_BASE_WIDTH px wide per column (a card in a group as one
                // column), scaled down to the card's width; CSS sizes it below the header
                const g = dashboardGeometry;
                const shown = toDisplay(this.card);
                const width = g.cellWidth * shown.w + g.gap * (shown.w - 1);
                style['--mini-scale'] = width > 0 ? Math.min(1, width / (MINI_BASE_WIDTH * Math.max(1, shown.w))) : 1;
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
        // mode 'move' or 'resize'; a resize drags the given edges (as drawn)
        startDrag(mode, event, edges = null) {
            if (event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            const shown = toDisplay(this.card);
            const cell = cellAt(event.clientX, event.clientY);
            this._grab = { col: cell.col - shown.x, row: cell.row - shown.y };
            this._edges = edges;
            Object.assign(dashboardDrag, { path: this.card.path, mode, rect: { ...this.card }, slot: null, valid: true });
        },
        // The target under the pointer: a resized slot (a card in a group), a group's half cell
        // (a card over a group), a free cell (a card in a group), or the moved or resized rect
        onDrag(event) {
            if (!this.dragging) return;
            const layout = NavigationRegistry.dashboardRegistry.layout;
            const path = this.card.path;
            const shown = toDisplay(this.card);
            const cell = cellAt(event.clientX, event.clientY);
            const overGroup = dashboardDrag.mode === 'move' && !this.isGroup && groupAt(event.clientX, event.clientY, layout.placed);
            let target;
            if (dashboardDrag.mode === 'resize' && this.inGroup) {
                // The corner follows the half cell under the pointer, within the group
                const group = layout.placed.find(card => card.group === this.card.inGroup);
                const half = halfCellAt(group, event.clientX, event.clientY);
                const slot = resizeRect(this.card.slot, this._edges, { col: half.x, row: half.y });
                target = { rect: slotRect(group, slot), slot: { group: group.group, slot }, valid: !!planSlotResize(layout, path, slot) };
            } else if (dashboardDrag.mode === 'resize') {
                const rect = toDisplay(resizeRect(shown, this._edges, cell));
                target = { rect, slot: null, valid: !!planResize(layout.placed, path, rect) };
            } else if (overGroup) {
                // Previewed at the card's size: one half cell from the grid, its own from a group
                const half = halfCellAt(overGroup, event.clientX, event.clientY);
                const plan = planSlotDrop(layout, path, overGroup.group, half);
                const size = this.inGroup ? this.card.slot : { w: 1, h: 1 };
                const rect = slotRect(overGroup, plan ? plan[0].slot : { ...half, w: size.w, h: size.h });
                target = { rect, slot: { group: overGroup.group, slot: half }, valid: !!plan };
            } else if (this.inGroup) {
                const rect = toDisplay({ x: cell.col, y: cell.row, w: 1, h: 1 });
                target = { rect, slot: null, valid: fits(layout.placed, rect) };
            } else {
                const rect = clampRect(toDisplay({ x: cell.col - this._grab.col, y: cell.row - this._grab.row, w: shown.w, h: shown.h }));
                target = { rect, slot: null, valid: !!planMove(layout.placed, path, rect) };
            }
            Object.assign(dashboardDrag, target);
        },
        async endDrag(commit) {
            if (!this.dragging) return;
            const { mode, rect, slot, valid } = dashboardDrag;
            Object.assign(dashboardDrag, { path: null, mode: null, rect: null, slot: null, valid: false });
            if (!commit || !valid || !rect || sameRect(rect, this.card)) return;
            const registry = NavigationRegistry.dashboardRegistry;
            if (slot && mode === 'resize') await registry.resizeInGroup(this.card.path, slot.slot);
            else if (slot) await registry.placeInGroup(this.card.path, slot.group, slot.slot);
            else if (this.inGroup) await registry.placeAt(this.card.path, rect);
            else if (mode === 'move') await registry.move(this.card.path, rect);
            else await registry.resize(this.card.path, rect);
        },
        remove() {
            NavigationRegistry.dashboardRegistry.remove(this.card.path);
        }
    },
    template: html`
        <div class="dashboard-cell" :class="{ miniature, arranging, dragging, group: isGroup }" :style="cellStyle">
            <slot :miniature="miniature" :header="header" :bare="bare"></slot>
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
            <div v-if="arranging && isGroup" class="button-bar dashboard-group-controls">
                <button class="button-symbol white"
                        title="Drag to move the group"
                        @pointerdown="startDrag('move', $event)"
                        @pointermove="onDrag"
                        @pointerup="endDrag(true)"
                        @pointercancel="endDrag(false)">
                    <span class="material-symbols-outlined">open_with</span>
                </button>
                <button class="button-symbol red"
                        title="Remove the group (its cards go back to the grid)"
                        @click="remove">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <template v-else-if="arranging">
                <div class="dashboard-cell-handle"
                     :title="'Drag to move ' + title"
                     @pointerdown="startDrag('move', $event)"
                     @pointermove="onDrag"
                     @pointerup="endDrag(true)"
                     @pointercancel="endDrag(false)">
                    <span v-if="!header">{{ title }}</span>
                </div>
                <div class="button-bar dashboard-cell-controls">
                    <button v-if="inGroup"
                            class="button-symbol white slot-resize"
                            title="Drag to make it wide or tall"
                            @pointerdown="startDrag('resize', $event, cornerEdges)"
                            @pointermove="onDrag"
                            @pointerup="endDrag(true)"
                            @pointercancel="endDrag(false)">
                        <span class="material-symbols-outlined">open_in_full</span>
                    </button>
                    <button class="button-symbol red"
                            :title="'Remove ' + title + ' from the dashboard'"
                            @click="remove">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <template v-if="!inGroup">
                    <div v-for="zone in resizeZones"
                         :key="zone.name"
                         class="dashboard-cell-resize-zone"
                         :data-edge="zone.name"
                         title="Drag to resize"
                         @pointerdown="startDrag('resize', $event, zone.edges)"
                         @pointermove="onDrag"
                         @pointerup="endDrag(true)"
                         @pointercancel="endDrag(false)"></div>
                    <button class="button-symbol white dashboard-cell-resize"
                            title="Drag to resize"
                            @pointerdown="startDrag('resize', $event, cornerEdges)"
                            @pointermove="onDrag"
                            @pointerup="endDrag(true)"
                            @pointercancel="endDrag(false)">
                        <span class="material-symbols-outlined">open_in_full</span>
                    </button>
                </template>
            </template>
        </div>
    `
};

/**
 * Arrange mode's grid items: a slot in every free cell (offering the notices card, any card with
 * no room, and a new group), each group's frame and free slots (offering the same cards), the drop
 * preview while dragging, and the bar with Done.
 */
export const DashboardArrangeLayer = {
    components: { DashboardCell },
    inject: ['appContext'],
    computed: {
        canUndo() {
            return undoRegistry.canUndo(this.registry.arrangePath);
        },
        canRedo() {
            return undoRegistry.canRedo(this.registry.arrangePath);
        },
        registry() {
            return NavigationRegistry.dashboardRegistry;
        },
        freeCells() {
            return freeCells(this.registry.layout.placed);
        },
        groups() {
            return this.registry.layout.placed.filter(card => card.group);
        },
        // Free group slots, placed on the grid in half cells
        groupSlots() {
            return freeGroupSlots(this.registry.layout).map(({ group, slot }) => ({
                key: `${group}-${slot.x}-${slot.y}`,
                group,
                slot,
                style: gridAreaStyle(slotRect(this.groups.find(card => card.group === group), slot))
            }));
        },
        // Cards that can go into a free cell or group slot: the notices card when it isn't on the
        // dashboard, and cards on the dashboard that had no room
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
        // Arrange mode is its own page: undo and redo act on its layout history (and save)
        undo() {
            undoRegistry.undo();
        },
        redo() {
            undoRegistry.redo();
        },
        done() {
            this.appContext.navigateToPath('dashboard');
        }
    },
    template: html`
        <div v-for="cell in freeCells" :key="cellKey(cell)" class="dashboard-slot" :style="gridAreaStyle(cell)">
            <div class="cell-button-list">
                <button v-for="option in addable" :key="option.path" class="white" @click="addAt(option, cell)">
                    + {{ option.title }}
                </button>
                <button class="white" @click="registry.addGroup(cell)">+ Group</button>
            </div>
        </div>
        <DashboardCell v-for="group in groups" :key="group.path" :card="group" title="Group" />
        <div v-for="slot in groupSlots" :key="slot.key" class="dashboard-slot group-slot" :style="slot.style">
            <div v-if="addable.length" class="cell-button-list">
                <button v-for="option in addable" :key="option.path" class="white"
                        @click="registry.placeInGroup(option.path, slot.group, slot.slot)">
                    + {{ option.title }}
                </button>
            </div>
        </div>
        <div v-if="preview"
             class="dashboard-drop-preview"
             :class="preview.valid ? 'valid' : 'invalid'"
             :style="gridAreaStyle(preview.rect)"></div>
        <div class="button-bar dashboard-arrange-bar">
            <span>Drag a card to move it, an edge or corner to resize it</span>
            <button class="button-symbol white" title="Undo" :disabled="!canUndo" @click="undo"><span class="material-symbols-outlined">undo</span></button>
            <button class="button-symbol white" title="Redo" :disabled="!canRedo" @click="redo"><span class="material-symbols-outlined">redo</span></button>
            <button class="green" @click="done">Done</button>
        </div>
    `
};

/** Whether the notices card is on the dashboard grid (in a group it's too small for the banners) */
export function noticesOnDashboard() {
    const card = NavigationRegistry.dashboardRegistry.getPlaced(NOTICES_PATH);
    return !!card && !card.inGroup;
}
