// Dashboard registry: the user's dashboard cards, kept in user data through a reactive store.
// The single-screen grid layout itself is pure logic in dashboardLayout.js.
import { authState } from './auth.js';
import { getReactiveStore } from './reactiveStores.js';
import { Requests } from '../../data_management/api.js';
import { undoRegistry } from './undoRegistry.js';
import { entryPath, cleanPath, findCard, normalizeLayout, firstFreeSlot, freeGroupSlots, isFull, classesForSize, planMove, planResize, planSlotDrop, planSlotResize, fits } from './dashboardLayout.js';

export const DashboardRegistry = Vue.reactive({
    store: null,
    saveTimeout: null,
    isSaving: false, // Track save state to prevent invalidation-triggered reloads
    SAVE_DELAY_MS: 5000, // 5 seconds
    // Arrange mode: cards drawn as miniatures that can be moved and resized. It is a page of its
    // own (arrangePath), so its layout changes have their own undo history; app.js keeps
    // `arranging` in step with the address.
    arranging: false,
    arrangePath: 'dashboard/arrange',

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
     * The grid layout: placed cards with their rects, and the cards that don't fit
     */
    get layout() {
        return normalizeLayout(this.containers);
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
     * Add a container at the first free cell, or else the first free group slot. Returns false
     * when the dashboard is full. Stores full path including parameters
     */
    async add(containerPathWithParams) {
        if (!this.store) return false;
        if (this.has(containerPathWithParams)) return true;
        const rect = firstFreeSlot(this.layout.placed, 1, 1);
        if (rect) return this._push({ path: containerPathWithParams, classes: '', ...rect });
        const slot = freeGroupSlots(this.layout)[0];
        return slot ? this.placeInGroup(containerPathWithParams, slot.group, slot.slot) : false;
    },

    /**
     * Make a free cell a group of small cards
     */
    async addGroup(cell) {
        if (!this.store || !fits(this.layout.placed, cell)) return false;
        return this._push({ group: Date.now().toString(36), ...cell });
    },

    /**
     * Drop a card on a group's half cell (planSlotDrop): a free one takes it, and a card in a
     * group dropped on another swaps with it. A card already on the dashboard moves there (leaving
     * the grid or its slot); any other is added. Returns false when not possible.
     */
    async placeInGroup(containerPathWithParams, group, halfCell) {
        const moves = planSlotDrop(this.layout, containerPathWithParams, group, halfCell);
        if (moves && !this.has(containerPathWithParams)) {
            return this._push({ path: containerPathWithParams, classes: '', inGroup: group, slot: moves[0].slot });
        }
        return this._setSlots(moves);
    },

    /**
     * Resize a card in a group to a new slot: wide, tall, or one half cell (planSlotResize).
     * Returns false when it doesn't fit.
     */
    async resizeInGroup(containerPathWithParams, slot) {
        return this._setSlots(planSlotResize(this.layout, containerPathWithParams, slot));
    },

    /** Store a plan's group slots (each card leaves the grid if it was on it) and save */
    async _setSlots(moves) {
        if (!moves) return false;
        this._commit([]);
        // After the commit: it rewrites entries, so find each entry again
        for (const move of moves) {
            const index = this.containers.indexOf(this.getContainer(move.path));
            const { x, y, w, h, ...entry } = this._entryObject(index);
            this.store.data[index] = { ...entry, inGroup: move.inGroup, slot: { ...move.slot } };
        }
        await this.save();
        return true;
    },

    /** Add a stored entry, keeping every card in its place, and save */
    async _push(entry) {
        if (!Array.isArray(this.store.data)) this.store.data = [];
        this._commit([]);
        this.store.data.push(entry);
        await this.save();
        return true;
    },

    /**
     * Put a card that's on the dashboard but not on the grid (no room, or in a group) into a
     * free rect
     */
    async placeAt(containerPathWithParams, rect) {
        const entry = this.getContainer(containerPathWithParams);
        const fitsThere = entry && fits(this.layout.placed, rect, containerPathWithParams);
        return this._apply(fitsThere ? [{ path: entryPath(entry), ...rect }] : null);
    },

    /**
     * Move a card; onto exactly one other card it swaps the two. Returns false when not possible.
     */
    async move(containerPathWithParams, rect) {
        return this._apply(planMove(this.layout.placed, containerPathWithParams, rect));
    },

    /**
     * Resize a card to a new rect (from any edge). Returns false when it doesn't fit.
     */
    async resize(containerPathWithParams, rect) {
        return this._apply(planResize(this.layout.placed, containerPathWithParams, rect));
    },

    /** Store a plan's rects and save. Returns false for no plan (the change isn't possible). */
    async _apply(rects) {
        if (!rects) return false;
        this._commit(rects);
        await this.save();
        return true;
    },

    /**
     * Write every placed card's rect into its stored entry, with the given rects applied.
     * Old entries are read first-fit (normalizeLayout); writing all of them on the first change
     * keeps one card's move from shifting the others. Cards that don't fit lose any stored rect.
     * Every layout change starts here, so in arrange mode this records its undo step first
     * (undoing or redoing it saves).
     * @param {Array<{path,x,y,w,h}>} rects - new rects by path
     */
    _commit(rects) {
        if (this.arranging) {
            undoRegistry.capture(this.store.data, this.arrangePath, { type: 'dashboard-layout', onRestore: () => this.save() });
        }
        const { placed, unplaced, grouped } = this.layout;
        const updates = new Map(rects.map(r => [cleanPath(r.path), r]));
        for (const card of placed) {
            const rect = updates.get(cleanPath(card.path)) || card;
            this._writeRect(card.index, rect);
            updates.delete(cleanPath(card.path));
        }
        for (const card of unplaced) {
            const rect = updates.get(cleanPath(card.path));
            if (rect) {
                this._writeRect(card.index, rect);
            } else if (typeof this.store.data[card.index] === 'object') {
                const { x, y, w, h, ...rest } = this.store.data[card.index];
                this.store.data[card.index] = rest;
            }
        }
        // A card in a group given a rect leaves its group for the grid
        for (const card of grouped) {
            const rect = updates.get(cleanPath(card.path));
            if (rect) this._writeRect(card.index, rect);
        }
    },

    // A card on the grid is in no group; a group keeps no classes (they size old deploys' cards)
    _writeRect(index, { x, y, w, h }) {
        const { inGroup, slot, ...entry } = this._entryObject(index);
        if (!entry.group) entry.classes = classesForSize(w, h, entry.classes);
        this.store.data[index] = { ...entry, x, y, w, h };
    },

    /** A stored entry as an object (old data has plain path strings) */
    _entryObject(index) {
        const entry = this.store.data[index];
        return typeof entry === 'string' ? { path: entry, classes: '' } : entry;
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
     * Remove container from dashboard. The other cards keep their places. A group's cards go
     * back to the grid, first-fit.
     * Compares clean paths (without parameters) for matching
     */
    async remove(containerPathWithParams) {
        if (!this.has(containerPathWithParams)) return;
        this._commit([]);
        // After the commit: it rewrites entries, so find the entry again
        const entry = this.getContainer(containerPathWithParams);
        if (entry.group) {
            this.store.data.forEach((card, index) => {
                if (card?.inGroup !== entry.group) return;
                const { inGroup, slot, ...rest } = card;
                this.store.data[index] = rest;
            });
        }
        this.store.data.splice(this.containers.indexOf(entry), 1);
        await this.save();
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
        this.arranging = false;
    }
});
