// Dashboard registry: the user's dashboard cards, kept in user data through a reactive store.
// The single-screen grid layout itself is pure logic in dashboardLayout.js.
import { authState } from './auth.js';
import { getReactiveStore } from './reactiveStores.js';
import { Requests } from '../../data_management/api.js';
import { undoRegistry } from './undoRegistry.js';
import { redirectPath } from './urlRouter.js';
import { DEFAULT_DASHBOARD, entryPath, findCard, groupPath, normalizeLayout, firstFreeSlot, freeGroupSlots, isFull, classesForSize, planMove, planResize, planSlotDrop, planSlotResize, fits } from './dashboardLayout.js';

export const DashboardRegistry = Vue.reactive({
    store: null,
    saveTimeout: null,
    isSaving: false, // Track save state to prevent invalidation-triggered reloads
    SAVE_DELAY_MS: 5000, // 5 seconds
    // Arrange mode: the dashboard's cards drawn as miniatures that can be moved and resized. It is
    // a mode of the dashboard page, not an address: app.js ends it when the page changes. Its
    // layout changes have their own undo history, under arrangeUndoKey, the dashboard's only one
    // (undo on the dashboard works only while arranging, app.js).
    arranging: false,
    arrangeUndoKey: 'dashboard/arrange',

    /**
     * Initialize the dashboard registry
     */
    async initialize() {
        if (!authState.isAuthenticated || !authState.user?.email) {
            return;
        }

        try {
            // Use existing reactive store system with custom save wrapper
            // Mark as exempt from eviction since this is a core store needed for navigation
            this.store = getReactiveStore(
                Requests.getUserData,
                null, // No automatic save call - we'll handle it manually
                [authState.user.email, 'dashboard_containers'],
                null, // No analysis config
                true, // autoLoad
                null, // No priority config
                true  // exemptFromEviction - this is a core store
            );

            // If the store was evicted and is being reloaded, wait for it to complete
            // This happens after logout/login when the store has needsReload=true
            if (this.store.needsReload && this.store.isLoading) {
                await new Promise(resolve => {
                    const unwatch = Vue.watch(
                        () => this.store.isLoading,
                        (isLoading) => {
                            if (!isLoading) {
                                unwatch();
                                resolve();
                            }
                        }
                    );
                });
            }

            // Once loaded: cards of moved pages follow them, and a user who has never saved a
            // dashboard gets the default one
            const store = this.store;
            const unwatchLoad = Vue.watch(() => store.initialLoad || store.isLoading, (loading) => {
                if (loading) return;
                Vue.nextTick(() => unwatchLoad());
                this._redirectMovedPages(store);
                this._storeDefaultIfNeverSaved(store);
            }, { immediate: true });

            // Override handleInvalidation to prevent reloads during save
            const originalHandleInvalidation = this.store.handleInvalidation.bind(this.store);
            this.store.handleInvalidation = async () => {
                // Skip reload if we're in the middle of saving
                if (this.isSaving) return;
                await originalHandleInvalidation();
            };

        } catch (error) {
            console.error('Failed to initialize dashboard registry:', error);
        }
    },

    /** Open arrange mode */
    startArranging() {
        this.arranging = true;
    },

    /**
     * Undo (or redo) a layout change of arrange mode. Its history is named, not taken from the
     * active route, which a table mounting in a card may have changed.
     */
    undoLayout(redo = false) {
        undoRegistry.setActiveRoute(this.arrangeUndoKey);
        return redo ? undoRegistry.redo() : undoRegistry.undo();
    },

    /** End arrange mode: its undo history goes with it */
    stopArranging() {
        if (!this.arranging) return;
        this.arranging = false;
        undoRegistry.clearRouteHistory(this.arrangeUndoKey);
    },

    /** Point the cards of moved pages (redirectPath) at their new paths, and save */
    _redirectMovedPages(store) {
        if (store !== this.store || store.error) return;
        let moved = false;
        this.containers.forEach((entry, index) => {
            const path = entryPath(entry);
            const target = redirectPath(path);
            if (target === path) return;
            moved = true;
            if (typeof entry === 'string') store.data[index] = target;
            else entry.path = target;
        });
        if (moved) this.saveNow();
    },

    /**
     * Store the default dashboard (DEFAULT_DASHBOARD) for a user with no saved one: no stored entry
     * at all, as opposed to one emptied on purpose, which stays empty. A failed read stores nothing.
     */
    async _storeDefaultIfNeverSaved(store) {
        if (store !== this.store || store.error || this.containers.length) return;
        try {
            if (await Requests.hasUserDataKey(authState.user.email, 'dashboard_containers')) return;
        } catch (error) {
            console.warn('[DashboardRegistry] Could not check for a saved dashboard:', error);
            return;
        }
        if (store !== this.store || this.containers.length) return;
        store.data = DEFAULT_DASHBOARD.map(entry => ({ ...entry }));
        await this.saveNow();
    },

    /**
     * Check if this is the initial load (first time loading dashboard data)
     */
    get isInitialLoad() {
        return this.store?.initialLoad && this.store?.isLoading;
    },

    /**
     * All stored dashboard entries, placed or not
     */
    get containers() {
        return Array.isArray(this.store?.data) ? this.store.data : [];
    },

    /**
     * The grid layout: placed cards with their rects, the cards in groups, and the cards that
     * don't fit (computed once per change of the stored entries)
     */
    get layout() {
        return _layout.value;
    },

    /**
     * No room for another card: no free cell and no free group slot
     */
    get isFull() {
        return isFull(this.layout.placed) && !freeGroupSlots(this.layout).length;
    },

    /**
     * Check if a container is on the dashboard (placed or not)
     * Compares clean paths (without parameters) for matching
     */
    has(containerPathWithParams) {
        return !!this.getContainer(containerPathWithParams);
    },

    /**
     * The drawn card for a path (on the grid or in a group), with its rect, or null (not on the
     * dashboard, or doesn't fit)
     */
    getPlaced(containerPathWithParams) {
        const { placed, grouped } = this.layout;
        return findCard(placed, containerPathWithParams) || findCard(grouped, containerPathWithParams) || null;
    },

    /**
     * Get a container's stored entry
     * Compares clean paths (without parameters) for matching
     */
    getContainer(containerPathWithParams) {
        return findCard(this.containers, containerPathWithParams);
    },

    /**
     * Add a container at rect when it's free, else at the first free cell, else in the first
     * free group slot. Returns false when the dashboard is full. Stores full path including
     * parameters.
     */
    async add(containerPathWithParams, rect = null) {
        if (!this.store) return false;
        if (this.has(containerPathWithParams)) return true;
        const at = (rect && fits(this.layout.placed, rect)) ? rect : firstFreeSlot(this.layout.placed, 1, 1);
        if (!at) {
            const slot = freeGroupSlots(this.layout)[0];
            return slot ? this.placeInGroup(containerPathWithParams, slot.group, slot.slot) : false;
        }
        this._begin();
        this.store.data.push({ path: containerPathWithParams, classes: '', ...at });
        return this._finish();
    },

    /**
     * Make a free cell a group of small cards. Its path (dashboard/group:<id>) keeps older deploys,
     * which read every entry as a page, from failing on it.
     */
    async addGroup(cell) {
        if (!this.store || !fits(this.layout.placed, cell)) return false;
        const id = Date.now().toString(36);
        this._begin();
        this.store.data.push({ path: groupPath(id), group: id, ...cell });
        return this._finish();
    },

    /**
     * Drop a card on a group's half cell (planSlotDrop): a free one takes it, and a card in a
     * group dropped on another swaps with it. A card already on the dashboard moves there (leaving
     * the grid or its slot); any other is added. Returns false when not possible.
     */
    async placeInGroup(containerPathWithParams, group, halfCell) {
        const moves = planSlotDrop(this.layout, containerPathWithParams, group, halfCell);
        if (!moves) return false;
        this._begin();
        if (!this.has(containerPathWithParams)) {
            this.store.data.push({ path: containerPathWithParams, classes: '', inGroup: group, slot: moves[0].slot });
        } else {
            this._writeSlots(moves);
        }
        return this._finish();
    },

    /**
     * Resize a card in a group to a new slot: wide, tall, or one half cell (planSlotResize).
     * Returns false when it doesn't fit.
     */
    async resizeInGroup(containerPathWithParams, slot) {
        const moves = planSlotResize(this.layout, containerPathWithParams, slot);
        if (!moves) return false;
        this._begin();
        this._writeSlots(moves);
        return this._finish();
    },

    /**
     * Put a card that's on the dashboard but not on the grid (no room, or in a group) into a
     * free rect
     */
    async placeAt(containerPathWithParams, rect) {
        const entry = this.getContainer(containerPathWithParams);
        const fitsThere = entry && fits(this.layout.placed, rect, containerPathWithParams);
        return this._applyRects(fitsThere ? [{ path: entryPath(entry), ...rect }] : null);
    },

    /**
     * Move a card; onto exactly one other card it swaps the two. Returns false when not possible.
     */
    async move(containerPathWithParams, rect) {
        return this._applyRects(planMove(this.layout.placed, containerPathWithParams, rect));
    },

    /**
     * Resize a card to a new rect (from any edge). Returns false when it doesn't fit.
     */
    async resize(containerPathWithParams, rect) {
        return this._applyRects(planResize(this.layout.placed, containerPathWithParams, rect));
    },

    /**
     * Remove container from dashboard. The other cards keep their places. A group's cards go
     * back to the grid, first-fit.
     * Compares clean paths (without parameters) for matching
     */
    async remove(containerPathWithParams) {
        if (!this.has(containerPathWithParams)) return;
        this._begin();
        const entry = this._entry(containerPathWithParams);
        if (entry.group) {
            for (const card of this.containers) {
                if (card?.inGroup === entry.group) _leaveGroup(card);
            }
        }
        this.store.data.splice(this.containers.indexOf(entry), 1);
        await this._finish();
    },

    /** Store a plan's rects (a card in a group given one leaves it for the grid) and save */
    async _applyRects(rects) {
        if (!rects) return false;
        this._begin();
        for (const rect of rects) this._writeRect(this._entry(rect.path), rect);
        return this._finish();
    },

    /** Store a plan's group slots (a card on the grid leaves it) */
    _writeSlots(moves) {
        for (const move of moves) {
            const entry = this._entry(move.path);
            delete entry.x; delete entry.y; delete entry.w; delete entry.h;
            Object.assign(entry, { inGroup: move.inGroup, slot: { ...move.slot } });
        }
    },

    /**
     * Start a layout change. In arrange mode it records the undo step first (undoing or redoing it
     * saves). Then every drawn card's rect is written into its stored entry: old entries are read
     * first-fit (normalizeLayout), and writing all of them keeps one card's change from shifting
     * the others. Cards that don't fit lose any stored rect. Entries are changed in place, so
     * entries found before still hold.
     */
    _begin() {
        if (!Array.isArray(this.store.data)) this.store.data = [];
        if (this.arranging) {
            undoRegistry.capture(this.store.data, this.arrangeUndoKey, { type: 'dashboard-layout', onRestore: () => this.save() });
        }
        const { placed, unplaced } = this.layout;
        for (const card of placed) this._writeRect(this._entry(card.path), card);
        for (const card of unplaced) {
            const entry = this._entry(card.path);
            delete entry.x; delete entry.y; delete entry.w; delete entry.h;
        }
    },

    /** Finish a layout change: save (debounced) */
    async _finish() {
        await this.save();
        return true;
    },

    // A card on the grid is in no group; a group keeps no classes (they size old deploys' cards)
    _writeRect(entry, { x, y, w, h }) {
        _leaveGroup(entry);
        if (!entry.group) entry.classes = classesForSize(w, h, entry.classes);
        Object.assign(entry, { x, y, w, h });
    },

    /**
     * A stored entry as an object, by path. Old data has plain path strings, replaced here by
     * objects; a group stored before groups had paths gets its path.
     */
    _entry(path) {
        const index = this.containers.indexOf(this.getContainer(path));
        if (index < 0) return null;
        const entry = this.store.data[index];
        if (typeof entry === 'string') {
            this.store.data[index] = { path: entry, classes: '' };
        } else if (entry.group && !entry.path) {
            entry.path = groupPath(entry.group);
        }
        return this.store.data[index];
    },

    /**
     * Update existing container's path with new parameters
     * This allows dashboard containers to preserve parameter state
     */
    async updatePath(cleanPathToUpdate, newPathWithParams) {
        const index = this.containers.indexOf(this.getContainer(cleanPathToUpdate));

        if (index > -1) {
            const oldPath = entryPath(this.store.data[index]);
            // Containers report their path as they load: an unchanged path is no save (each save
            // writes the user data tab)
            if (oldPath === newPathWithParams) return;

            if (typeof this.store.data[index] === 'string') {
                this.store.data[index] = newPathWithParams;
            } else {
                this.store.data[index].path = newPathWithParams;
            }
            await this.save();
        } else {
            console.warn('[DashboardRegistry] Container not found for path:', cleanPathToUpdate);
        }
    },

    /**
     * Save dashboard state with debouncing
     */
    async save() {
        if (!this.store) return;

        // Clear any existing timeout
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        // Set new timeout for delayed save
        this.saveTimeout = setTimeout(async () => {
            await this._performSave();
        }, this.SAVE_DELAY_MS);
    },

    /**
     * Save dashboard immediately (for critical operations)
     */
    async saveNow() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }

        await this._performSave();
    },

    /**
     * Internal save implementation that updates originalData without reloading
     */
    async _performSave() {
        if (!this.store) return;

        this.isSaving = true;
        this.store.setLoading(true, 'Saving dashboard...');
        this.store.setError(null);

        try {
            // Save current data to user storage
            const dataToSave = JSON.parse(JSON.stringify(this.store.data));
            await Requests.storeUserData(
                dataToSave,
                authState.user.email,
                'dashboard_containers'
            );

            // Update originalData to match current data (split-data pattern)
            // This makes the store "clean" without reloading from server
            this.store.setOriginalData(dataToSave);
        } catch (error) {
            console.error('[DashboardRegistry] Failed to save dashboard:', error);
            this.store.setError(error.message || 'Failed to save dashboard');
        } finally {
            this.store.setLoading(false, '');
            this.isSaving = false;
            this.saveTimeout = null;
        }
    },

    /**
     * Cleanup any pending saves and reset state
     */
    cleanup() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        this.store = null;
    }
});

// The layout of the stored entries, recomputed only when they change
const _layout = Vue.computed(() => normalizeLayout(DashboardRegistry.containers));

/** Take a stored entry out of its group */
function _leaveGroup(entry) {
    delete entry.inGroup;
    delete entry.slot;
}
