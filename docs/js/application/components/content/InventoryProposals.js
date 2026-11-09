import { html, DataView, ProposalUtils, PROPOSAL_LOCK_NAMESPACE, parseDate, todayISOString, getInventoryNoteMaxLength, THUMBNAIL_FIELD, SEVERITY, isMarkedForDeletion } from '../../index.js';
import { sheetLockMixin } from '../../utils/sheetLockMixin.js';
import { getProposalsStore, reloadProposals, proposalPath, proposalTableStore, commitInventoryProposal } from '../../utils/inventoryProposals.js';
import { thumbnailStyle } from '../../utils/views/viewStyles.js';
import { InventorySaveModal } from './InventoryTable.js';
import { InventorySelectorModal } from './InventorySelectorModal.js';
import { RowDeletionButton } from '../interface/cells.js';

/**
 * Inventory proposals pages (Reports → Inventory Proposals).
 * Plan: docs/notes/inventory-proposals-plan.md
 */

const formatDay = (deciseconds) => (deciseconds
    ? new Date(deciseconds * 100).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '');
const titleCase = (tab) => tab.charAt(0).toUpperCase() + tab.slice(1).toLowerCase();

// What each proposal card key is. _summary, _status and _committed are derived on a computed copy.
const PROPOSAL_FIELDS = [
    { key: 'name', label: 'Proposal' },
    { key: '_summary', label: 'Items' },
    { key: '_status', label: 'Status' },
    { key: '_committed', label: 'Committed' }
];

// One card per proposal, active first (purple), committed last (gray)
const PROPOSAL_GRID_VIEWS = {
    id: 'inventory-proposals',
    default: 'cards',
    theme: 'purple',
    views: [{
        id: 'cards',
        name: 'Inventory Proposals',
        layout: 'cards',
        cards: { card: [['name'], ['_summary']], footer: [['_status']] },
        hidden: ['_committed'],
        rowColor: { field: '_committed', rule: 'checked:gray', fallback: 'purple' },
        action: 'row'
    }]
};

/** reports/inventory-proposals — one card per proposal */
export const InventoryProposalsGrid = {
    components: { DataView },
    props: {
        containerPath: { type: String, default: 'reports/inventory-proposals' },
        navigateToPath: Function
    },
    data() {
        return {
            proposalsStore: getProposalsStore(),
            PROPOSAL_FIELDS,
            PROPOSAL_GRID_VIEWS,
            proposalAction: { to: (row) => proposalPath(row.name) }
        };
    },
    computed: {
        // groupProposals orders them: active first, then committed
        proposalRows() {
            return ProposalUtils.groupProposals(this.proposalsStore.data || []).map(proposal => ({
                name: proposal.name,
                _summary: `${proposal.itemCount} item${proposal.itemCount === 1 ? '' : 's'} in ${proposal.categories.map(titleCase).join(', ')}`,
                _status: proposal.committed
                    ? `Committed by ${proposal.committedBy} on ${formatDay(proposal.committed)}`
                    : `Updated by ${proposal.updatedBy} on ${formatDay(proposal.updated)}`,
                _committed: !!proposal.committed
            }));
        }
    },
    template: html`
        <DataView
            :fields="PROPOSAL_FIELDS"
            :rows="proposalRows"
            :registry="PROPOSAL_GRID_VIEWS"
            :action="proposalAction"
            :is-loading="proposalsStore.isLoading"
            :show-header="false"
            empty-message="No proposals yet. Save inventory edits as a proposal from a category's Save dialog."
            :container-path="containerPath"
            :navigate-to-path="navigateToPath"
        />
    `
};

// What each proposal row key is (ProposalUtils.toTableRow). _projected and _remove hold no data:
// the projected quantity and the remove button (the page draws both). The thumbnail is the proposed
// image (items of tabs without a Thumbnail column have none). Items are added with New Item
// (InventorySelectorModal; one row per item), and removed by marking them, then saving
// (CLAUDE.md "Deleting rows").
const PROPOSAL_TABLE_FIELDS = [
    { ...THUMBNAIL_FIELD, editable: true },
    { key: 'category', label: 'Category' },
    { key: 'itemNumber', label: 'Item#', type: 'item' },
    { key: 'currentQuantity', label: 'Current Qty' },
    { key: 'quantityChange', label: 'Change', format: 'number', type: 'number', editable: true },
    { key: '_projected', label: 'Projected Qty' },
    { key: 'description', label: 'Description', editable: true },
    { key: 'notes', label: 'Notes', editable: true },
    { key: '_remove', label: '' }
];

// The proposal's item changes. Batch edit mode while active; committed proposals drop the
// projection and remove columns (a view patch).
const PROPOSAL_TABLE_VIEWS = {
    id: 'inventory-proposal',
    default: 'table',
    theme: 'purple',
    views: [{
        id: 'table',
        name: 'Proposal',
        layout: 'table',
        columns: ['thumbnail', 'category', 'itemNumber', 'currentQuantity', 'quantityChange', '_projected', 'description', 'notes', '_remove'],
        details: [],
        hidden: 'rest',
        sortable: ['category', 'itemNumber', 'currentQuantity', 'quantityChange', 'description'],
        style: {
            // The item's edit history ends at its current thumbnail, not the proposed one
            thumbnail: thumbnailStyle('itemNumber', 32, { savedKey: 'currentThumbnail' }),
            category: { width: 130 },
            itemNumber: { width: 120 },
            currentQuantity: { width: 90, cell: 'slot' },
            quantityChange: { width: 100, color: 'sign:proposal-increase:proposal-decrease' },
            _projected: { width: 110, cell: 'slot' },
            // Proposed text that differs from the item's current text
            description: { color: 'differs:currentDescription:proposal-changed' },
            notes: { color: 'differs:currentNotes:proposal-changed' },
            _remove: { width: 36, cell: 'slot' }
        },
        table: { sticky: { start: ['thumbnail'], end: ['_remove'] } },
        sort: { key: 'category', dir: 'asc' }
    }]
};
const COMMITTED_COLUMNS = PROPOSAL_TABLE_VIEWS.views[0].columns.filter(key => key !== '_projected' && key !== '_remove');

/**
 * reports/inventory-proposals/<slug> — one table of the proposal's item changes.
 * Editable with the standard lock and Save/Discard; Commit applies it to inventory.
 */
export const InventoryProposalTable = {
    mixins: [sheetLockMixin],
    components: { DataView, RowDeletionButton },
    inject: ['appContext', '$modal', '$notify'],
    props: {
        proposalSlug: { type: String, required: true },
        containerPath: String,
        navigateToPath: Function
    },
    data() {
        return {
            proposalsStore: getProposalsStore(),
            tableStore: null,
            lockNamespace: PROPOSAL_LOCK_NAMESPACE,
            projectionDate: todayISOString(),
            todayISO: todayISOString(),
            committing: false,
            PROPOSAL_TABLE_FIELDS,
            PROPOSAL_TABLE_VIEWS
        };
    },
    computed: {
        // Reads every entry, so it also tracks in-place updates to the store's array
        proposals() {
            return ProposalUtils.groupProposals(this.proposalsStore.data || []);
        },
        proposal() {
            return this.proposals.find(proposal => proposal.slug === this.proposalSlug) || null;
        },
        proposalName() {
            return this.proposal?.name || null;
        },
        isCommitted() {
            return !!this.proposal?.committed;
        },
        notFound() {
            return !this.proposal && !this.proposalsStore.isLoading && !this.proposalsStore.initialLoad;
        },
        // sheetLockMixin contract
        lockKey() {
            return this.proposalName;
        },
        activeStore() {
            return this.tableStore;
        },
        isDirty() {
            return this.tableStore?.isModified || false;
        },
        editMode() {
            return !this.isCommitted;
        },
        allowEdit() {
            return !this.isCommitted && !this.lockedByOther && this.lockCheckComplete;
        },
        editModeName() {
            return this.allowEdit ? 'batch' : 'none';
        },
        // Committed changes are already in Current Qty, so only active proposals project
        viewPatches() {
            return this.isCommitted ? [{ patch: { columns: COMMITTED_COLUMNS } }] : [];
        },
        tableData() {
            return this.tableStore ? this.tableStore.data : [];
        },
        originalData() {
            return this.tableStore ? JSON.parse(JSON.stringify(this.tableStore.originalData)) : [];
        },
        projectionDeciseconds() {
            const date = parseDate(this.projectionDate) || new Date();
            return Math.floor(date.getTime() / 100);
        },
        banners() {
            return [
                {
                    key: 'lock',
                    message: this.lockedBySelf
                        ? 'You have this proposal open for editing on another device.'
                        : `Locked for edit by: ${this.lockOwnerDisplay}`,
                    visible: this.lockedByOther,
                    dismissible: false,
                    action: this.lockedBySelf ? { label: 'Claim this device', fn: () => this.claimLock() } : null
                },
                {
                    key: 'conflict',
                    severity: SEVERITY.critical,
                    message: 'Another session changed this proposal while you have unsaved edits. Save to keep your changes or discard them.',
                    visible: !!this.tableStore?.externalConflict,
                    action: { label: 'Discard', fn: () => this.handleRefresh() }
                },
                {
                    key: 'committed',
                    message: `Committed by ${this.proposal?.committedBy} on ${formatDay(this.proposal?.committed)}. Committed proposals are read-only.`,
                    visible: this.isCommitted,
                    dismissible: false
                }
            ];
        },
        canCommit() {
            return !!this.proposal && !this.isCommitted && !this.isDirty && !this.lockedByOther
                && !this.committing && this.tableData.length > 0;
        }
    },
    watch: {
        proposalName: {
            handler(name) {
                if (!name || this.tableStore) return;
                this.tableStore = proposalTableStore(name);
                this.checkLockStatus();
            },
            immediate: true
        },
        isDirty(value) {
            this.handleLockState(value);
        },
        banners: {
            handler(banners) {
                this.$notify.setBanners(this.containerPath, banners);
            },
            immediate: true
        }
    },
    beforeUnmount() {
        this.$notify.clearBanners(this.containerPath);
    },
    methods: {
        projected(row) {
            return ProposalUtils.projectQuantity(row, this.projectionDeciseconds);
        },
        // cell-edit contract: (rowIndex, columnKey, value)
        async handleCellEdit(rowIdx, key, value) {
            const row = this.tableStore?.data[rowIdx];
            if (!key || !row) return;
            const previous = row[key];
            await this.editWithLock(() => { row[key] = value; }, () => { row[key] = previous; });
        },
        isMarkedForDeletion,
        // Mark an item for removal from the proposal, or unmark it; saving removes the marked items
        async toggleRemoval(row) {
            const toggle = () => this.tableStore.toggleRowDeletion(row);
            await this.editWithLock(toggle, toggle, { action: 'remove items', undo: 'deletion' });
        },
        // New Item: pick an inventory item to add to the proposal
        handleAddItem() {
            this.$modal.custom(InventorySelectorModal, {
                onItemSelected: (item) => this.addItem(item),
                size: 'page',
                tall: true
            }, `Add to ${this.proposalName}`);
        },
        // One row per item: an added item starts with no changes (a row without changes saves no
        // entry). An item already in the proposal isn't added again; if it was marked for removal,
        // adding it unmarks it.
        async addItem(item) {
            const existing = this.tableData.find(row => row.category === item.tab && row.itemNumber === item.itemNumber);
            if (existing && !isMarkedForDeletion(existing)) {
                this.$modal.alert(`${item.itemNumber} is already in this proposal.`, 'Add Item');
                return;
            }
            if (existing) {
                await this.toggleRemoval(existing);
                return;
            }
            const store = this.tableStore;
            const row = ProposalUtils.toTableRow({ category: item.tab, itemNumber: item.itemNumber, changes: [] }, item);
            await this.editWithLock(() => store.addRow(row), () => store.data.splice(store.indexOfRow(row), 1), { action: 'add items', undo: 'add-row' });
        },
        async handleSave() {
            await this.tableStore.save('Saving proposal...');
            await reloadProposals();
        },
        handleRefresh() {
            this.$modal.confirm(
                'This clears unsaved changes to the proposal.',
                () => this.tableStore?.load('Refreshing proposal...'),
                null,
                'Refresh Data',
                'Refresh Data',
                'Cancel'
            );
        },
        handleCommit() {
            if (!this.canCommit) return;
            const name = this.proposalName;
            this.$modal.custom(InventorySaveModal, {
                hasQtyChanges: true,
                initialNote: ProposalUtils.commitNote(name, getInventoryNoteMaxLength()),
                initialDate: this.projectionDate,
                onConfirm: async (scheduledDate, note) => {
                    this.committing = true;
                    try {
                        const { committed, failed } = await commitInventoryProposal(name, scheduledDate, note);
                        if (failed.length > 0) {
                            this.$modal.alert(
                                `Committed ${committed.join(', ') || 'nothing'}. Could not save ${failed.join(', ')}; those items stay in the proposal so you can commit again.`,
                                'Partially Committed'
                            );
                        }
                        await this.tableStore.load('Loading proposal...');
                    } catch (error) {
                        this.$modal.alert(error.message, 'Commit Failed');
                    } finally {
                        this.committing = false;
                    }
                }
            }, `Commit ${name}`);
        }
    },
    template: html`
        <div v-if="notFound" class="card red">
            <h3>Proposal Not Found</h3>
            <p>There is no proposal named "{{ proposalSlug }}".</p>
        </div>
        <DataView
            v-else
            :fields="PROPOSAL_TABLE_FIELDS"
            :rows="tableData"
            :registry="PROPOSAL_TABLE_VIEWS"
            :patches="viewPatches"
            :edit-mode="editModeName"
            :original-data="originalData"
            :title="proposalName ? proposalName + (isCommitted ? ' (committed)' : ' proposal') : 'Proposal'"
            :isLoading="!tableStore || tableStore.isLoading || committing"
            :loading-message="committing ? 'Committing proposal...' : (tableStore?.loadingMessage || 'Loading proposal...')"
            :showRefresh="true"
            :showSearch="true"
            :sync-search-with-url="true"
            :container-path="containerPath"
            :navigate-to-path="navigateToPath"
            :external-dirty-state="isDirty"
            :showNewRowButton="allowEdit"
            emptyMessage="This proposal has no items."
            @new-row="handleAddItem"
            @cell-edit="handleCellEdit"
            @on-save="handleSave"
            @refresh="handleRefresh"
        >
            <template #header-area>
                <div v-if="!isCommitted" class="button-bar">
                    <div class="card white">
                        Projected on:
                    </div>
                    <input type="date" v-model="projectionDate" :min="todayISO" />
                    <button
                        class="purple"
                        :disabled="!canCommit"
                        :title="isDirty ? 'Save or discard your edits before committing' : 'Apply this proposal to inventory'"
                        @click="handleCommit"
                    >Commit</button>
                </div>
            </template>
            <template #cell="{ row, field }">
                <span v-if="field.key === '_projected'">{{ projected(row) }}</span>
                <template v-else-if="field.key === 'currentQuantity'">
                    <span v-if="row.missing" class="red" title="This item no longer exists in inventory">missing</span>
                    <template v-else>{{ row.currentQuantity }}</template>
                </template>
                <RowDeletionButton
                    v-else-if="field.key === '_remove' && allowEdit"
                    :marked="isMarkedForDeletion(row)"
                    title="Remove this item from the proposal; saving removes it"
                    marked-title="Keep this item in the proposal"
                    @toggle="toggleRemoval(row)"
                />
            </template>
        </DataView>
    `
};
