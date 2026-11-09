import { acquireSheetLock } from './sheetLockMixin.js';
import { Requests, authState, getReactiveStore, ProposalUtils, PROPOSAL_LOCK_NAMESPACE, NavigationRegistry, todayISOString } from '../index.js';

/**
 * Inventory proposal helpers for the application layer: the shared proposal list store, route
 * registration, and the two-pass commit. Plan: docs/notes/inventory-proposals-plan.md
 */

export const PROPOSALS_ROUTE = 'inventory-proposals';
export const PROPOSALS_PATH = `reports/${PROPOSALS_ROUTE}`;

/** Shared read-only store of every proposal entry (see ProposalUtils.parseRows) */
export function getProposalsStore() {
    return getReactiveStore(Requests.getInventoryProposals, null, []);
}

/**
 * Reload the proposal list. Called after every proposal write: an empty list is not cached, so
 * cache invalidation alone does not refresh a store that started out empty.
 */
export async function reloadProposals() {
    await getProposalsStore().load('Loading proposals...');
}

/**
 * Register one child route of reports/inventory-proposals per proposal (breadcrumb names, deep links).
 * The parent route is registered by ReportsContent, which calls this whenever the list changes.
 */
export function registerProposalRoutes(proposals = []) {
    // getRoute returns the deepest existing ancestor for a missing child, so read children directly
    const registered = NavigationRegistry.getRoute('reports')?.children?.[PROPOSALS_ROUTE]?.children || {};
    for (const proposal of proposals) {
        if (registered[proposal.slug]?.displayName !== proposal.name) {
            NavigationRegistry.addDynamicRoute(PROPOSALS_PATH, proposal.slug, { displayName: proposal.name });
        }
    }
}

export function proposalPath(name) {
    return `${PROPOSALS_PATH}/${ProposalUtils.slugify(name)}`;
}

/** A proposal page's table store (the proposal's rows; saving replaces its active entries) */
export function proposalTableStore(name) {
    return getReactiveStore(Requests.getInventoryProposalTable, Requests.saveInventoryProposalTable, [name]);
}

/**
 * A category store's edits as proposal items: each edited item's saved row and its changes
 * (ProposalUtils.diffRow). An item new to the category counts from quantity 0.
 * @returns {Array<{ inventoryRow: Object, changes: Array<{n, ne}> }>}
 */
export function proposalItemsFromStore(store) {
    const savedByItem = new Map((store.originalData || []).map(row => [row.itemNumber, row]));
    return (store.data || [])
        .filter(row => row.itemNumber)
        .map(row => {
            const saved = savedByItem.get(row.itemNumber) || { ...row, quantity: '0' };
            return { inventoryRow: saved, changes: ProposalUtils.diffRow(saved, row) };
        })
        .filter(item => item.changes.length > 0);
}

/**
 * Add items to a proposal, new or existing, the way the proposal page saves: through the
 * proposal's table store, under its edit lock. Each item's changes merge into its row
 * (ProposalUtils.mergeChanges: one row per item), or add a row; then the store saves.
 * @param {string} name - Proposal name
 * @param {string} category - Inventory tab of the items
 * @param {Array<{ inventoryRow: Object, changes: Array<{n, ne}> }>} items - see proposalItemsFromStore
 * @throws {Error} When the proposal has unsaved edits, is locked by someone else, or the save fails
 *   (the proposal is then left as it was)
 */
export async function saveToProposal(name, category, items) {
    const user = authState.user?.email;
    if (!user) throw new Error('Log in to update a proposal');
    const store = proposalTableStore(name);
    await waitForLoad(store);
    if (store.isModified) throw new Error(`Save or discard the unsaved changes in the ${name} proposal first.`);
    const release = await acquireSheetLock(PROPOSAL_LOCK_NAMESPACE, name, `The ${name} proposal`, 'Nothing was added.');
    try {
        for (const { inventoryRow, changes } of items) {
            const itemNumber = inventoryRow.itemNumber;
            const row = store.data.find(other => other.category === category && other.itemNumber === itemNumber);
            const merged = ProposalUtils.mergeChanges(row ? ProposalUtils.changesFromTableRow(row) : [], changes);
            const next = ProposalUtils.toTableRow({ category, itemNumber, changes: merged }, inventoryRow);
            if (row) Object.assign(row, next);
            else store.addRow(next);
        }
        const saved = await store.save('Saving proposal...');
        if (saved === false || store.isModified) {
            const message = store.error || `Could not save the ${name} proposal`;
            store.setData(store.originalData);
            throw new Error(message);
        }
    } finally {
        await release();
    }
    await reloadProposals();
}

function inventoryStore(category) {
    return getReactiveStore(Requests.getInventoryTabData, Requests.saveInventoryTabData, [category, undefined, undefined, undefined]);
}

async function waitForLoad(store) {
    for (let i = 0; i < 600 && (store.isLoading || store.initialLoad); i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (store.isLoading || store.initialLoad) throw new Error('Timed out loading inventory');
}

/**
 * Commit a proposal into inventory.
 *
 * Pass 1: refuse if any affected category has unsaved edits, lock every category, then apply the
 * proposal's changes to each category's store. Any failure restores the stores and releases the
 * locks taken, so nothing is saved unless every category locked.
 * Pass 2: save each category with the date and note (normal inventory save: history, scheduled
 * changes), release its lock, and mark that category's proposal rows committed.
 *
 * @param {string} name - Proposal name
 * @param {string} scheduledDate - ISO date (today = apply now, future = schedule)
 * @param {string} note - Save note
 * @returns {Promise<{committed: string[], failed: string[]}>} Categories saved / not saved
 * @throws {Error} When pass 1 fails (nothing was changed)
 */
export async function commitInventoryProposal(name, scheduledDate, note) {
    const user = authState.user?.email;
    if (!user) throw new Error('Log in to commit a proposal');

    await reloadProposals();
    const entries = ProposalUtils.activeEntries(getProposalsStore().data, name);
    if (entries.length === 0) throw new Error(`Proposal "${name}" has nothing left to commit`);

    const byCategory = new Map();
    for (const entry of entries) {
        if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
        byCategory.get(entry.category).push(entry);
    }
    const categories = [...byCategory.keys()];
    const stores = new Map(categories.map(category => [category, inventoryStore(category)]));
    for (const store of stores.values()) await waitForLoad(store);

    const dirty = categories.filter(category => stores.get(category).isModified);
    if (dirty.length > 0) {
        throw new Error(`Save or discard the unsaved changes in ${dirty.join(', ')} before committing this proposal.`);
    }

    // ── Pass 1: lock every category, then apply the changes ──
    const releases = new Map();
    const edited = [];
    try {
        for (const category of categories) {
            releases.set(category, await acquireSheetLock('INVENTORY', category, category, 'Nothing was committed.'));
        }
        for (const category of categories) {
            const store = stores.get(category);
            edited.push(category);
            for (const entry of byCategory.get(category)) {
                const index = store.data.findIndex(row => row.itemNumber === entry.itemNumber);
                if (index === -1) throw new Error(`${entry.itemNumber} no longer exists in ${category}. Nothing was committed.`);
                Object.assign(store.data[index], ProposalUtils.applyChanges(store.data[index], entry.changes));
            }
        }
    } catch (error) {
        for (const category of edited) {
            const store = stores.get(category);
            store.setData(store.originalData);
        }
        for (const release of releases.values()) await release();
        throw error;
    }

    // ── Pass 2: save each category and release its lock ──
    const committed = [];
    const failed = [];
    const isFuture = scheduledDate > todayISOString();
    for (const category of categories) {
        const store = stores.get(category);
        const result = await store.save('Committing proposal...', { scheduledDate, note });
        if (result === false || store.isModified) {
            failed.push(category);
            store.setData(store.originalData);
        } else {
            committed.push(category);
            // A scheduled save keeps today's values and records pending entries: show the saved state
            if (isFuture) await store.load('Loading...');
        }
        await releases.get(category)();
    }

    if (committed.length > 0) {
        await Requests.markInventoryProposalCommitted(name, committed);
    }
    await reloadProposals();
    return { committed, failed };
}
