// Dashboard registry: the user's dashboard cards, kept in user data through a reactive store.
// The single-screen grid layout itself is pure logic in dashboardLayout.js.
import { authState } from './auth.js';
import { getReactiveStore } from './reactiveStores.js';
import { Requests } from '../../data_management/api.js';
import { entryPath, cleanPath, normalizeLayout, firstFreeSlot, isFull, classesForSize, planMove, planResize, fits } from './dashboardLayout.js';

export const DashboardRegistry = Vue.reactive({
    store: null,
    saveTimeout: null,
    isSaving: false, // Track save state to prevent invalidation-triggered reloads
    SAVE_DELAY_MS: 5000, // 5 seconds
    arranging: false, // Arrange mode: cards drawn as miniatures that can be moved and resized

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
     * Check if dashboard is loading for the first time
     */
    get isLoading() {
        return this.store?.isLoading;
    },

    /**
     * Check if this is the initial load (first time loading dashboard data)
     */
    get isInitialLoad() {
        return this.store?.initialLoad && this.store?.isLoading;
    },

    /**
     * Get loading message (only shown during initial load)
     */
    get loadingMessage() {
        return this.isLoading ? (this.store?.loadingMessage || 'Loading dashboard...') : '';
    },

    /**
     * All stored dashboard entries, placed or not
     */
    get containers() {
        return Array.isArray(this.store?.data) ? this.store.data : [];
    },

    /**
     * Get container IDs in order
     */
    get containerIds() {
        return this.containers.map(entryPath);
    },

    /**
     * The grid layout: placed cards with their rects, and the cards that don't fit
     */
    get layout() {
        return normalizeLayout(this.containers);
    },

    /**
     * No room for another card
     */
    get isFull() {
        return isFull(this.layout.placed);
    },

    /**
     * Check if a container is on the dashboard (placed or not)
     * Compares clean paths (without parameters) for matching
     */
    has(containerPathWithParams) {
        const key = cleanPath(containerPathWithParams);
        return this.containerIds.some(id => cleanPath(id) === key);
    },

    /**
     * The placed card for a path, with its rect, or null (not on the dashboard, or doesn't fit)
     */
    getPlaced(containerPathWithParams) {
        const key = cleanPath(containerPathWithParams);
        return this.layout.placed.find(card => cleanPath(card.path) === key) || null;
    },

    /**
     * Get a container's stored entry
     * Compares clean paths (without parameters) for matching
     */
    getContainer(containerPathWithParams) {
        const key = cleanPath(containerPathWithParams);
        return this.containers.find(container => cleanPath(entryPath(container)) === key);
    },

    /**
     * Add a container at the first free cell. Returns false when the dashboard is full.
     * Stores full path including parameters
     */
    async add(containerPathWithParams) {
        if (!this.store) return false;
        if (this.has(containerPathWithParams)) return true;
        const rect = firstFreeSlot(this.layout.placed, 1, 1);
        if (!rect) return false;
        if (!Array.isArray(this.store.data)) this.store.data = [];
        this._commit([]);
        this.store.data.push({ path: containerPathWithParams, classes: '', ...rect });
        await this.save();
        return true;
    },

    /**
     * Put a card that's on the dashboard but not shown (no room) into a free rect
     */
    async placeAt(containerPathWithParams, rect) {
        if (!this.has(containerPathWithParams) || !fits(this.layout.placed, rect, containerPathWithParams)) return false;
        this._commit([{ path: entryPath(this.getContainer(containerPathWithParams)), ...rect }]);
        await this.save();
        return true;
    },

    /**
     * Move a card; onto exactly one other card it swaps the two. Returns false when not possible.
     */
    async move(containerPathWithParams, rect) {
        const rects = planMove(this.layout.placed, containerPathWithParams, rect);
        if (!rects) return false;
        this._commit(rects);
        await this.save();
        return true;
    },

    /**
     * Resize a card from its top-left cell. Returns false when the new size doesn't fit.
     */
    async resize(containerPathWithParams, w, h) {
        const rects = planResize(this.layout.placed, containerPathWithParams, w, h);
        if (!rects) return false;
        this._commit(rects);
        await this.save();
        return true;
    },

    /**
     * Write every placed card's rect into its stored entry, with the given rects applied.
     * Old entries are read first-fit (normalizeLayout); writing all of them on the first change
     * keeps one card's move from shifting the others. Cards that don't fit lose any stored rect.
     * @param {Array<{path,x,y,w,h}>} rects - new rects by path
     */
    _commit(rects) {
        const { placed, unplaced } = this.layout;
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
    },

    _writeRect(index, { x, y, w, h }) {
        const entry = this.store.data[index];
        const base = typeof entry === 'string' ? { path: entry, classes: '' } : entry;
        this.store.data[index] = { ...base, classes: classesForSize(w, h, base.classes), x, y, w, h };
    },

    /**
     * Update existing container's path with new parameters
     * This allows dashboard containers to preserve parameter state
     */
    async updatePath(cleanPathToUpdate, newPathWithParams) {
        const key = cleanPath(cleanPathToUpdate);
        const index = this.containers.findIndex(container => cleanPath(entryPath(container)) === key);

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
     * Remove container from dashboard. The other cards keep their places.
     * Compares clean paths (without parameters) for matching
     */
    async remove(containerPathWithParams) {
        const key = cleanPath(containerPathWithParams);
        if (!this.has(key)) return;
        this._commit([]);
        const index = this.containers.findIndex(container => cleanPath(entryPath(container)) === key);
        if (index > -1) {
            this.store.data.splice(index, 1);
            await this.save();
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
        this.arranging = false;
    }
});
