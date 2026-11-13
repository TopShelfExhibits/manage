import { Requests, authState, CacheInvalidationBus, getDeviceId, undoRegistry } from '../index.js';

/**
 * sheetLockMixin — Vue Options API mixin for sheet-level write-lock management.
 *
 * Handles acquiring, releasing, and polling write locks on Google Sheets tabs so
 * that only one user can edit a sheet at a time.
 *
 * ─── CONTRACT ────────────────────────────────────────────────────────────────
 * The component using this mixin MUST provide:
 *
 *   data:
 *     lockNamespace  String  — Spreadsheet namespace passed to lock API calls.
 *                              e.g. 'INVENTORY' or 'PACK_LISTS'.
 *
 *   computed:
 *     lockKey        String  — The tab identifier used as the lock key.
 *                              e.g. `this.tabTitle` or `this.tabName`.
 *     activeStore    Object  — The reactive store instance for this component.
 *                              Used to wait for initial data load before deciding
 *                              whether to release a stale own-lock on mount.
 *                              e.g. `this.inventoryTableStore`.
 *     isDirty        Boolean — Whether the component has unsaved edits.
 *
 * ─── OPTIONAL HOOKS ──────────────────────────────────────────────────────────
 * Define these methods on the component to extend mixin behaviour:
 *
 *   afterCheckLockComplete()
 *     Called at the end of every checkLockStatus() run, after lockCheckComplete
 *     is set to true.  Use this for component-specific post-check navigation or
 *     side-effects (e.g. PacklistTable redirecting to edit mode).
 *
 *   onLockAcquireFailed(lockInfo)
 *     Called when a lock acquisition attempt in handleLockState() fails because
 *     another user already holds the lock.  Use this for component-specific
 *     recovery of edits still in the store (e.g. InventoryTable and PacklistTable drop them).
 *
 * ─── PROVIDED ────────────────────────────────────────────────────────────────
 * data:    isLocked, lockingInProgress, lockedByOther, lockedBySelf, lockOwner, lockCheckComplete
 *            lockedBySelf — true when lockedByOther is true but the lock owner is the current user
 *            on a different device. Lets components show a device-specific message and Claim action.
 * computed: lockOwnerDisplay
 * methods: setLockState, checkLockStatus, handleLockState, claimLock, acquireLockForEdit,
 *          editWithLock (an edit applied at once, the lock taken behind it; the way to edit)
 */
/**
 * Take a sheet's edit lock for an operation that runs outside the page that edits the sheet
 * (adding to a proposal, committing one). Refuses when someone else holds the lock, or when this
 * user holds it on another device: that session may have unsaved edits, and releasing its lock
 * afterwards would leave them unguarded (pages hand a lock over with the Claim banner instead).
 * @param {string} namespace - Lock namespace, e.g. 'INVENTORY'
 * @param {string} key - Lock key, e.g. a tab name
 * @param {string} what - What is locked, for the error, e.g. "The Spring buy proposal"
 * @param {string} [consequence] - Appended to the error, e.g. "Nothing was added."
 * @returns {Promise<Function>} release() — call it when done (it never throws)
 * @throws {Error} When the lock can't be taken
 */
export async function acquireSheetLock(namespace, key, what, consequence = '') {
    const user = authState.user?.email;
    if (!user) throw new Error('Log in first');
    const refuse = (holder) => new Error(`${what} is ${holder}.${consequence ? ' ' + consequence : ''}`);
    const held = await Requests.getSheetLock(namespace, key);
    if (held && held.user === user && held.deviceId && held.deviceId !== getDeviceId()) {
        throw refuse('being edited on another of your devices');
    }
    if (!await Requests.lockSheet(namespace, key, user, getDeviceId())) {
        const lockInfo = await Requests.getSheetLock(namespace, key, user);
        throw refuse(`locked${lockInfo?.user ? ` by ${lockInfo.user}` : ''}`);
    }
    return () => Requests.unlockSheet(namespace, key, user).catch(() => {});
}

export const sheetLockMixin = {
    data() {
        return {
            isLocked: false,
            lockingInProgress: false,
            lockedByOther: false,
            lockedBySelf: false,
            lockOwner: null,
            lockCheckComplete: false
        };
    },

    created() {
        this._lockInvalidationHandler = () => this.checkLockStatus();
        CacheInvalidationBus.on('api:getSheetLock', this._lockInvalidationHandler);
    },

    beforeUnmount() {
        if (this._lockInvalidationHandler) {
            CacheInvalidationBus.off('api:getSheetLock', this._lockInvalidationHandler);
        }
    },

    computed: {
        lockOwnerDisplay() {
            return this.lockOwner && this.lockOwner.includes('@')
                ? this.lockOwner.split('@')[0]
                : (this.lockOwner || 'Unknown');
        }
    },

    watch: {
        'activeStore.lockConflictOwner'(newOwner) {
            if (!newOwner) return;
            this.setLockState(false, newOwner);
            this.onLockConflictDetected?.(newOwner);
            if (this.activeStore) {
                this.$nextTick(() => {
                    if (this.activeStore.lockConflictOwner === newOwner) {
                        this.activeStore.lockConflictOwner = null;
                    }
                });
            }
        },

        'activeStore.error'(newError) {
            if (!newError) return;
            const match = newError.match(/locked by (.+)$/i);
            if (match) {
                const lockOwner = match[1];
                this.setLockState(false, lockOwner);
                if (typeof this.onLockConflictDetected === 'function') {
                    this.onLockConflictDetected(lockOwner);
                    return;
                }
                this.$modal.alert(`Cannot save: locked by ${lockOwner}`, 'Locked');
            }
        }
    },

    methods: {
        setLockState(isLocked, owner = null, isSelf = false) {
            const wasLockedByOther = this.lockedByOther;
            const previousOwner = this.lockOwner;

            this.isLocked = isLocked;
            this.lockedBySelf = isSelf;
            // isSelf means same user, different device — treat as foreign lock for all edit guards
            this.lockedByOther = !!(owner && (owner !== authState.user?.email || isSelf));
            this.lockOwner = owner;

            // When a foreign lock appears while this table has no unsaved changes,
            // immediately let the component exit edit mode.
            if (this.lockedByOther && (!wasLockedByOther || previousOwner !== owner)) {
                this.handleForeignLockDiscovery(owner);
            }
        },

        handleForeignLockDiscovery(owner) {
            if (!this.editMode || this.isDirty) return;
            this.onForeignLockWhileClean?.(owner);
        },

        /**
         * Reads the current lock for this sheet tab and reconciles component state.
         *
         * - If another user holds the lock: marks lockedByOther = true.
         * - If this user holds a stale lock and has no unsaved edits: releases it.
         * - If no lock exists: clears lock state.
         *
         * Always sets lockCheckComplete = true when done, then calls
         * afterCheckLockComplete() if the component defines it.
         *
         * Called on mount and on a 10-second interval while a foreign lock banner
         * is visible (via BannerNotifications poll config).
         */
        async checkLockStatus() {
            const user = authState.user?.email;
            if (!user || !this.lockKey) return;

            try {
                const lockInfo = await Requests.getSheetLock(this.lockNamespace, this.lockKey);

                if (lockInfo && lockInfo.user !== user) {
                    this.setLockState(false, lockInfo.user);
                    return;
                }

                if (lockInfo && lockInfo.user === user) {
                    // Lock belongs to this user — check whether it's from a different device.
                    // If so, don't release it: that would destroy the other session's work.
                    // Instead block editing on this device and show the "Claim" banner.
                    if (lockInfo.deviceId && lockInfo.deviceId !== getDeviceId()) {
                        this.setLockState(false, user, true); // isSelf = true
                        return;
                    }

                    this.setLockState(true, user);

                    // Wait for store to finish its initial load before deciding whether
                    // this is a stale own-lock. activeStore.initialLoad covers stores that
                    // track a separate "first load" flag; isLoading covers stores that don't.
                    if (this.activeStore && (this.activeStore.isLoading || this.activeStore.initialLoad)) {
                        await new Promise(resolve => {
                            const unwatch = this.$watch(
                                () => this.activeStore && !this.activeStore.isLoading && !this.activeStore.initialLoad,
                                (isReady) => {
                                    if (!isReady) return;
                                    unwatch();
                                    resolve();
                                }
                            );
                        });
                    }

                    if (!this.isDirty) {
                        const unlocked = await Requests.unlockSheet(this.lockNamespace, this.lockKey, user);
                        if (!unlocked) {
                            console.warn(`[sheetLockMixin] Failed to remove stale lock for ${this.lockKey}`);
                        }
                        this.setLockState(false, null);
                    }
                } else {
                    this.setLockState(false, null);
                }
            } catch (error) {
                console.error(`[sheetLockMixin] Failed to check lock status for ${this.lockKey}:`, error);
            } finally {
                this.lockCheckComplete = true;
                this.afterCheckLockComplete?.();
            }
        },

        /**
         * Acquires or releases the write lock in response to isDirty changes.
         *
         * - isDirty true  → acquire lock (if not already held).
         * - isDirty false → release lock (if held by this component).
         *
         * On acquire failure (another user holds it), sets lockedByOther and, if edits are still
         * in the store, calls onLockAcquireFailed({ user }) if the component defines it.
         *
         * Called from the component's isDirty watcher.
         */
        async handleLockState(isDirty) {
            if (!this.lockCheckComplete || this.lockingInProgress || this.lockedByOther) return;

            const user = authState.user?.email;
            if (!user || !this.lockKey) return;

            this.lockingInProgress = true;

            try {
                if (isDirty && !this.isLocked) {
                    // Shares an edit's request (editWithLock). That edit reverts itself on failure;
                    // the hook handles edits still left without the lock.
                    const lockAcquired = await this.acquireLockForEdit();
                    if (!lockAcquired && this.lockedByOther && this.isDirty) {
                        console.warn(`[sheetLockMixin] Sheet locked by ${this.lockOwner}`);
                        this.onLockAcquireFailed?.({ user: this.lockOwner });
                    }
                } else if (!isDirty && this.isLocked) {
                    const unlocked = await Requests.unlockSheet(this.lockNamespace, this.lockKey, user);
                    if (unlocked) {
                        this.setLockState(false, null);
                        // An edit made while the release was out still needs the lock
                        if (this.isDirty) Vue.nextTick(() => this.handleLockState(this.isDirty));
                    } else {
                        console.warn(`[sheetLockMixin] Failed to release lock for ${this.lockKey}`);
                    }
                }
            } catch (error) {
                console.error(`[sheetLockMixin] Lock operation failed for ${this.lockKey}:`, error);
                this.$modal.alert(
                    error.message?.includes('Failed to acquire write lock')
                        ? `Unable to acquire lock for ${this.lockKey}. The system is experiencing high concurrency. Please try again in a moment.`
                        : `Lock operation failed: ${error.message}`,
                    'Error'
                );
            } finally {
                this.lockingInProgress = false;
            }
        },

        /**
         * Claims this sheet's write-lock for the current device.
         *
         * Writes a new lock cell value with this device's ID, then applies any
         * autosave backup from the previous session so edits are not lost.
         * Finally refreshes lock state so the banner clears.
         */
        async claimLock() {
            const user = authState.user?.email;
            if (!user || !this.lockKey) return;

            await Requests.lockSheet(this.lockNamespace, this.lockKey, user, getDeviceId());

            // Restore the other device's last autosave onto this device's store
            if (this.activeStore?.applyLatestBackup) {
                await this.activeStore.applyLatestBackup();
            }

            await this.checkLockStatus();
        },

        /**
         * Take the edit lock, or confirm it's held. Calls made while a request is out (several
         * quick edits, the isDirty watcher) share that one request.
         * @returns {Promise<boolean>} whether this session holds the lock
         */
        acquireLockForEdit() {
            if (this.isLocked) return Promise.resolve(true);
            if (!this._lockRequest) {
                this._lockRequest = this._requestLock().finally(() => { this._lockRequest = null; });
            }
            return this._lockRequest;
        },

        /**
         * An optimistic edit: apply() changes the store at once and the lock is taken behind it,
         * so an edit never waits on the lock. If the lock can't be had, revert() undoes the change.
         * @param {Function} apply - Makes the edit
         * @param {Function} revert - Undoes it
         * @param {Object} [options]
         * @param {string} [options.action] - What the edit does ("delete"): a refused edit then tells
         *   the user who holds the lock (cell edits leave it out; the lock banner says so)
         * @param {string} [options.undo] - Undo step type ("deletion"): the store's rows are captured
         *   for undo first, and the step is dropped again if the edit is reverted
         * @returns {Promise<boolean>} whether the edit stands
         */
        async editWithLock(apply, revert, { action = null, undo = null } = {}) {
            const rows = this.activeStore?.data;
            const routeKey = undo && rows ? this.appContext?.currentPath?.split('?')[0] : null;
            if (routeKey) undoRegistry.capture(rows, routeKey, { type: undo });
            apply();
            if (await this.acquireLockForEdit()) return true;
            revert();
            if (routeKey) undoRegistry.discardLastSnapshotIfUnchanged(rows, routeKey);
            if (action) {
                this.$modal.alert(`Cannot ${action}: ${this.lockKey} is locked for editing by ${this.lockOwner ? this.lockOwnerDisplay : 'another user'}.`, 'Locked');
            }
            return false;
        },

        async _requestLock() {
            const user = authState.user?.email;
            if (!user || !this.lockKey) return false;

            try {
                const lockInfo = await Requests.getSheetLock(this.lockNamespace, this.lockKey, user);
                if (lockInfo) {
                    this.setLockState(false, lockInfo.user);
                    return false;
                }

                const lockAcquired = await Requests.lockSheet(this.lockNamespace, this.lockKey, user, getDeviceId());
                if (lockAcquired) {
                    this.setLockState(true, user);
                    return true;
                }

                const recheckInfo = await Requests.getSheetLock(this.lockNamespace, this.lockKey, user);
                if (recheckInfo) {
                    this.setLockState(false, recheckInfo.user);
                }
                return false;
            } catch (error) {
                console.error(`[sheetLockMixin] acquireLockForEdit failed for ${this.lockKey}:`, error);
                return false;
            }
        }
    }
};
