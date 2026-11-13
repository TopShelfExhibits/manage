import { html, Requests, DataView, getReactiveStore, NavigationRegistry, invalidateCache, authState, undoRegistry, EditHistoryUtils, todayISOString, ProposalUtils, getInventoryNoteMaxLength, getInventoryTabList, INVENTORY_TAB_PREFERENCES, getShortageAlertsStore, getShortageAlertDays, shortagesByItem, itemShortageCards, itemVariantCards, itemVariantFamilies, THUMBNAIL_FIELD, SEVERITY, isMarkedForDeletion, isTemporaryAdmin, paramToggleValue } from '../../index.js';
import { sheetLockMixin } from '../../utils/sheetLockMixin.js';
import { thumbnailStyle, iconLabel } from '../../utils/views/viewStyles.js';
import { CellRenderer, RowDeletionButton } from '../interface/cells.js';
import { getProposalsStore, proposalPath, sendEditsToProposal } from '../../utils/inventoryProposals.js';

/**
 * Modal displayed before any inventory save.
 * Asks for an effective date (today = apply immediately; future = schedule) and a required note.
 * With onProposal, a Proposal button switches to choosing a proposal instead (no date or note).
 *
 * Props:
 *   onConfirm(scheduledDate: string, note: string) — called with ISO date and trimmed note on confirm.
 *   onProposal(name: string, isNew: boolean) — optional; called when the edits go to a proposal.
 *   proposalNames — active proposals offered for update; allProposalNames — every name (uniqueness).
 *
 * Emits 'close-modal' to close itself.
 */
export const InventorySaveModal = {
    props: {
        onConfirm: {
            type: Function,
            required: true
        },
        hasQtyChanges: {
            type: Boolean,
            default: true
        },
        initialNote: {
            type: String,
            default: ''
        },
        // ISO date to start with (ignored if in the past)
        initialDate: {
            type: String,
            default: ''
        },
        onProposal: {
            type: Function,
            default: null
        },
        proposalNames: {
            type: Array,
            default: () => []
        },
        allProposalNames: {
            type: Array,
            default: () => []
        },
        // Rows marked for deletion: removed when saved now, so they can't be scheduled or proposed
        deletionCount: {
            type: Number,
            default: 0
        }
    },
    data() {
        return {
            scheduledDate: this.initialDate > todayISOString() ? this.initialDate : todayISOString(),
            note: (this.initialNote || '').slice(0, getInventoryNoteMaxLength()),
            error: null,
            mode: 'save',
            selectedProposal: this.proposalNames[0] || '',
            newProposalName: '',
            proposalError: null
        };
    },
    computed: {
        todayISO() {
            return todayISOString();
        },
        isFutureDate() {
            return this.scheduledDate > this.todayISO;
        },
        charCount() {
            return this.note.length;
        },
        // InventoryNoteMaxLength preference
        noteMaxLength() {
            return getInventoryNoteMaxLength();
        },
        proposalNameMaxLength() {
            return ProposalUtils.nameMaxLength(this.noteMaxLength);
        }
    },
    methods: {
        handleUpdateProposal() {
            if (this.deletionCount) {
                this.proposalError = 'Items marked for deletion can\'t go into a proposal: apply them now, or unmark them.';
                return;
            }
            const newName = this.newProposalName.trim();
            if (newName) {
                const error = ProposalUtils.validateName(newName, this.allProposalNames, this.noteMaxLength);
                if (error) {
                    this.proposalError = error;
                    return;
                }
                this.onProposal(newName, true);
            } else if (this.selectedProposal) {
                this.onProposal(this.selectedProposal, false);
            } else {
                this.proposalError = 'Choose a proposal or enter a new name';
                return;
            }
            this.$emit('close-modal');
        },
        validate() {
            if (this.hasQtyChanges && !this.note.trim()) {
                this.error = 'A note is required for quantity changes';
                return false;
            }
            if (!this.scheduledDate || this.scheduledDate < this.todayISO) {
                this.error = 'Date cannot be in the past';
                return false;
            }
            this.error = null;
            return true;
        },
        handleApplyNow() {
            if (!this.validate()) return;
            this.onConfirm(this.todayISO, this.note.trim());
            this.$emit('close-modal');
        },
        handleSchedule() {
            if (!this.validate()) return;
            if (!this.isFutureDate) {
                this.error = 'Select a future date to schedule';
                return;
            }
            if (this.deletionCount) return;
            this.onConfirm(this.scheduledDate, this.note.trim());
            this.$emit('close-modal');
        }
    },
    template: html`
        <div v-if="mode === 'proposal'" class="content">
            <div v-if="proposalNames.length" class="form-group">
                <label>Add to an active proposal</label>
                <label v-for="name in proposalNames" :key="name" class="proposal-choice">
                    <input type="radio" :value="name" v-model="selectedProposal" :disabled="!!newProposalName.trim()" />
                    {{ name }}
                </label>
            </div>
            <div class="form-group">
                <label>{{ proposalNames.length ? 'Or start a new proposal' : 'New proposal name' }}</label>
                <input
                    type="text"
                    v-model="newProposalName"
                    :maxlength="proposalNameMaxLength"
                    placeholder="Proposal name"
                    :class="{ red: !!proposalError }"
                    @input="proposalError = null"
                    @keyup.enter="handleUpdateProposal"
                />
                <span v-if="proposalError" class="red font-small">{{ proposalError }}</span>
                <span v-else class="font-small gray">Proposals do not change inventory until committed.</span>
            </div>
            <div class="button-bar">
                <button @click="handleUpdateProposal" class="purple">Update Proposal</button>
                <button @click="mode = 'save'">Back</button>
            </div>
        </div>
        <div v-else class="content">
            <div class="form-group">
                <label>Note <span v-if="hasQtyChanges" class="red">*</span></label>
                <input
                    type="text"
                    v-model="note"
                    :maxlength="noteMaxLength"
                    :placeholder="hasQtyChanges ? 'What changed and why?' : 'Optional note'"
                    :class="{ red: !!error && !note.trim() }"
                    autofocus
                    @keyup.enter="handleApplyNow"
                />
                <span v-if="error && !note.trim()" class="red font-small">{{ error }}</span>
                <span v-else class="font-small gray">{{ charCount }}/{{ noteMaxLength }}</span>
            </div>
            <div class="form-group">
                <label>Effective Date</label>
                <input type="date" v-model="scheduledDate" :min="todayISO" :class="{ red: !!error && scheduledDate < todayISO }" />
                <span v-if="error && scheduledDate < todayISO" class="red font-small">{{ error }}</span>
                <span v-else-if="isFutureDate && deletionCount" class="red font-small">Items marked for deletion can't be scheduled: apply them now, or unmark them</span>
                <span v-else-if="!isFutureDate" class="font-small gray">Changes will be immediate</span>
                <span v-else class="font-small gray">Changes will be scheduled</span>
            </div>
            <div class="button-bar">
                <button v-if="!isFutureDate" @click="handleApplyNow" class="purple">Apply Now</button>
                <button v-else @click="handleSchedule" class="purple" :disabled="deletionCount > 0" :title="'Schedule for ' + scheduledDate">Schedule</button>
                <button v-if="onProposal" @click="mode = 'proposal'" title="Save these edits to a proposal instead of inventory">Proposal</button>
                <button @click="$emit('close-modal')">Cancel</button>
            </div>
        </div>
    `
};

/**
 * Whether a category store's edits change a saved quantity (the save dialog then offers to
 * schedule the save). Rows pair by their EditHistory row id, since item numbers can repeat or be
 * blank; a row without history yet pairs by item number.
 */
export function hasQuantityChanges(store) {
    const key = (row) => EditHistoryUtils.getRowIndex(row?.edithistory) ?? `item:${row?.itemNumber}`;
    const saved = new Map((store.originalData || []).map(row => [key(row), row.quantity]));
    return (store.data || []).some(row => saved.has(key(row)) && String(saved.get(key(row))) !== String(row.quantity));
}

/**
 * Open the save dialog (InventorySaveModal) for a category's edits: save them to inventory, now or
 * scheduled, or send them to a proposal (sendEditsToProposal). The category table and the
 * categories view both save through here.
 * @param {Object} page - The component opening it (its $modal and appContext)
 * @param {Object} options
 * @param {Object} options.store - The category's inventory store
 * @param {string} options.category - Inventory tab
 * @param {string} [options.initialNote] - The note field's starting text
 * @param {boolean} [options.allowProposal=true] - Offer the Proposal button
 * @param {boolean} [options.reloadAfterSave=false] - Reload after any save, not only a scheduled one
 * @param {Function} [options.afterSave] - Called once the edits are saved to inventory
 */
export function openInventorySaveDialog(page, { store, category, initialNote = '', allowProposal = true, reloadAfterSave = false, afterSave = null }) {
    const proposals = ProposalUtils.groupProposals(getProposalsStore().data || []);
    const confirmNewItems = () => new Promise(resolve => page.$modal.confirm(
        'This will create and add new items to the table immediately set to quantity 0.',
        () => resolve(true),
        () => resolve(false),
        'New Items',
        'Create Items',
        'Cancel'
    ));
    const sendToProposal = async (name, isNew) => {
        try {
            if (!await sendEditsToProposal(store, category, name, confirmNewItems)) return;
        } catch (error) {
            console.error('[InventorySave] Proposal update failed:', error);
            page.$modal.alert(`Could not update the proposal: ${error.message}`, 'Error');
            return;
        }
        if (isNew) page.appContext?.navigateToPath?.(proposalPath(name));
    };
    page.$modal.custom(InventorySaveModal, {
        hasQtyChanges: hasQuantityChanges(store),
        initialNote,
        onProposal: allowProposal ? sendToProposal : null,
        proposalNames: proposals.filter(p => !p.committed).map(p => p.name),
        allProposalNames: proposals.map(p => p.name),
        deletionCount: (store.data || []).filter(isMarkedForDeletion).length,
        onConfirm: async (scheduledDate, note) => {
            await store.save('Saving inventory...', { scheduledDate, note });
            afterSave?.();
            // A scheduled (future) save keeps today's quantity and records a pending entry, while
            // the store still shows the edit: reload to show what was saved
            if (scheduledDate > todayISOString() || reloadAfterSave) await store.load('Loading...');
        }
    }, 'Save Changes');
}

// Simple modal component for entering new item number
const NewItemNumberPrompt = {
    props: ['initialItemNumber', 'existingItems', 'onConfirm'],
    data() {
        return {
            itemNumber: this.initialItemNumber,
            error: null,
            suggestion: null,
            isNewPrefix: false
        };
    },
    computed: {
        helperText() {
            if (this.error) {
                return null; // Error takes precedence
            }            if (this.isNewPrefix && this.itemNumber) {
                return `"${this.itemNumber}" is a new prefix`;
            }            if (this.suggestion) {
                return `Next available: ${this.suggestion}`;
            }
            return 'Creating a new item';
        },
        ghostText() {
            // Show the remainder of the suggestion that hasn't been typed yet
            if (!this.suggestion || !this.itemNumber) {
                return '';
            }
            
            if (this.suggestion.startsWith(this.itemNumber)) {
                return this.suggestion.substring(this.itemNumber.length);
            }
            
            return '';
        }
    },
    methods: {
        validate() {
            if (!this.itemNumber) {
                this.error = 'Item number is required';
                this.suggestion = null;
                return false;
            }
            
            const duplicate = this.existingItems.find(
                item => item.itemNumber === this.itemNumber
            );
            
            if (duplicate) {
                this.error = 'Item number already exists';
                this.suggestion = null;
                return false;
            }
            
            this.error = null;
            return true;
        },
        updateSuggestion() {
            // Detect if user is typing a prefix that matches existing items
            if (!this.itemNumber || this.itemNumber.length < 2) {
                this.isNewPrefix = false;
                return;
            }
            
            // Find items that start with the current input
            const matchingItems = this.existingItems
                .map(item => item.itemNumber)
                .filter(num => num && num.startsWith(this.itemNumber));
            
            if (matchingItems.length > 0) {
                // Try to extract pattern and suggest next number
                const pattern = this.detectPatternFromPrefix(this.itemNumber, matchingItems);
                if (pattern) {
                    this.suggestion = this.incrementPattern(pattern);
                    this.isNewPrefix = false;
                } else {
                    this.suggestion = null;
                    this.isNewPrefix = false;
                }
            } else {
                // No direct matches - check if user typed a complete item following an existing pattern
                // Extract the prefix part from user's input (e.g., "CHAIR-" from "CHAIR-005")
                const prefixMatch = this.itemNumber.match(/^([A-Za-z\-_]+)(\d+)$/);
                
                if (prefixMatch) {
                    const extractedPrefix = prefixMatch[1];
                    // Check if any items start with this extracted prefix
                    const prefixItems = this.existingItems
                        .map(item => item.itemNumber)
                        .filter(num => num && num.startsWith(extractedPrefix));
                    
                    if (prefixItems.length > 0) {
                        // This prefix exists, so not a new prefix - just show default text
                        this.suggestion = null;
                        this.isNewPrefix = false;
                    } else {
                        // Truly a new prefix
                        this.suggestion = null;
                        this.isNewPrefix = true;
                    }
                } else {
                    // User is typing a prefix (e.g., "BLAH-")
                    this.suggestion = null;
                    this.isNewPrefix = true;
                }
            }
        },
        detectPatternFromPrefix(prefix, matchingItems) {
            // Try to detect the full prefix pattern from matching items
            // even if user has only typed a partial prefix
            const patterns = {};
            
            matchingItems.forEach(item => {
                // Try to extract the full prefix including separators
                // Match patterns like "PROP-123", "PROPS001", "LT-05", etc.
                const match = item.match(/^([A-Za-z\-_]+)(\d+)$/);
                if (match) {
                    const fullPrefix = match[1];
                    const number = parseInt(match[2], 10);
                    const padding = match[2].length;
                    
                    // Only consider this pattern if the full prefix starts with user's input
                    if (fullPrefix.startsWith(prefix)) {
                        if (!patterns[fullPrefix]) {
                            patterns[fullPrefix] = {
                                numbers: [],
                                padding: padding
                            };
                        }
                        patterns[fullPrefix].numbers.push(number);
                    }
                }
            });
            
            // Find the most common prefix pattern
            let bestPrefix = null;
            let maxNumber = 0;
            let maxCount = 0;
            let bestPadding = 3;
            
            for (const [fullPrefix, data] of Object.entries(patterns)) {
                if (data.numbers.length > maxCount) {
                    maxCount = data.numbers.length;
                    bestPrefix = fullPrefix;
                    maxNumber = Math.max(...data.numbers);
                    bestPadding = data.padding;
                } else if (data.numbers.length === maxCount) {
                    // If tied, prefer shorter prefix (more specific)
                    if (!bestPrefix || fullPrefix.length < bestPrefix.length) {
                        bestPrefix = fullPrefix;
                        maxNumber = Math.max(...data.numbers);
                        bestPadding = data.padding;
                    }
                }
            }
            
            if (bestPrefix) {
                return {
                    prefix: bestPrefix,
                    nextNumber: maxNumber + 1,
                    padding: bestPadding
                };
            }
            
            return null;
        },
        incrementPattern(pattern) {
            const { prefix, nextNumber, padding } = pattern;
            return `${prefix}${String(nextNumber).padStart(padding, '0')}`;
        },
        handleKeydown(event) {
            // Accept suggestion on Tab key
            if (event.key === 'Tab' && this.suggestion) {
                event.preventDefault();
                this.itemNumber = this.suggestion;
            }
        },
        handleSubmit() {
            if (this.validate()) {
                this.onConfirm(this.itemNumber);
                this.$emit('close-modal');
            }
        }
    },
    watch: {
        itemNumber() {
            this.validate();
            this.updateSuggestion();
        }
    },
    template: html`
        <div class="content">
            <div class="form-group">
                <div class="autocomplete-wrapper">
                    <input 
                        id="item-number-input"
                        type="text"
                        v-model="itemNumber"
                        @keyup.enter="handleSubmit"
                        @keydown="handleKeydown"
                        :class="{ 'red': error }"
                        autofocus
                    />
                    <div class="ghost-text" v-if="ghostText">{{ itemNumber }}<span class="ghost">{{ ghostText }}</span></div>
                </div>
                <span v-if="error" class="font-small red">{{ error }}</span>
                <span v-else-if="helperText" class="font-small gray">{{ helperText }}</span>
            </div>
            <div class="button-bar">
                <button @click="handleSubmit" :disabled="!!error" class="purple">Add Item</button>
                <button @click="$emit('close-modal')">Cancel</button>
            </div>
        </div>
    `
};


// Fields shown in pending and history sub-rows, and restored by a history revert
const HISTORY_FIELDS = ['thumbnail', 'quantity', 'description', 'notes'];

// Red highlighting of changed values in sub-rows, per view:
// pending = scheduled-change rows on the category table, history = the Edit History page
const HIGHLIGHT_CHANGES = { pending: false, history: true };

/** Format a decisecond timestamp for the history columns, e.g. "Oct 6, 2026, 1:52 PM" */
function formatHistoryTime(deciseconds) {
    return new Date(deciseconds * 100).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });
}

// Inventory category table view (views-and-renderers-plan §5, Phase 4). Batch edit mode.
const INVENTORY_TABLE_VIEWS = {
    id: 'inventory-category',
    default: 'table',
    theme: 'purple',
    views: [{
        id: 'table',
        name: 'Items',
        layout: 'table',
        columns: ['thumbnail', 'itemNumber', 'quantity', 'description', 'notes'],
        sortable: ['itemNumber', 'quantity', 'description'],
        style: {
            thumbnail: thumbnailStyle('itemNumber', 64),
            itemNumber: { width: 120 },
            quantity: { width: 120 }
        },
        table: { sticky: { start: ['thumbnail'] } },
        sort: { key: 'itemNumber', dir: 'asc' }
    }]
};

// Edit History page (historyMode): the category table's columns, then revert and the change that
// produced each row's values. The page draws the history columns (#cell).
const historyMeta = (width) => ({ width, cell: 'slot', columnColor: 'history-meta' });
const INVENTORY_HISTORY_VIEWS = {
    id: 'inventory-edit-history',
    default: 'table',
    theme: 'purple',
    views: [{
        ...INVENTORY_TABLE_VIEWS.views[0],
        name: 'Edit History',
        columns: [...INVENTORY_TABLE_VIEWS.views[0].columns, '_revert', '_historyDate', '_historyUser', '_historyNote'],
        style: {
            ...INVENTORY_TABLE_VIEWS.views[0].style,
            _revert: { width: 36, labelHtml: iconLabel('history'), cell: 'slot' },
            _historyDate: historyMeta(160),
            _historyUser: historyMeta(90),
            _historyNote: historyMeta(160)
        }
    }]
};

// Sub-rows under inventory items, each shown or hidden by a URL toggle in the inventory menu
// (ParamToggles): pending = scheduled changes, proposals = changes in active proposals. Both start
// off; the URL holds a toggle only while it's on (pending:true).
export const INVENTORY_DETAIL_TOGGLES = [
    { param: 'pending', label: 'Pending', title: 'scheduled changes', default: false },
    { param: 'proposals', label: 'Proposals', title: 'proposed changes', default: false }
];

// Edit History page: rows deleted from the category (the _EditHistory archive); admins can restore them
const INVENTORY_DELETED_VIEWS = {
    id: 'inventory-deleted',
    default: 'table',
    theme: 'purple',
    views: [{
        id: 'table',
        name: 'Deleted items',
        layout: 'table',
        columns: ['itemNumber', 'quantity', 'description', 'notes', '_restore', 'deletedAt', 'deletedBy'],
        style: {
            itemNumber: { width: 120 },
            quantity: { width: 80 },
            _restore: { width: 36, labelHtml: iconLabel('restore_from_trash'), cell: 'slot' },
            deletedAt: historyMeta(160),
            deletedBy: historyMeta(90)
        }
    }]
};

export const InventoryTableComponent = {
    mixins: [sheetLockMixin],
    components: {
        DataView,
        CellRenderer,
        RowDeletionButton
    },
    inject: ['appContext', '$modal', '$notify'],
    props: {
        containerPath: {
            type: String,
            default: 'inventory'
        },
        inventoryName: {
            type: String,
            default: 'Inventory'
        },
        tabTitle: {
            type: String,
            default: undefined
        },
        // Edit History page: read-only past states under each item, with revert
        historyMode: {
            type: Boolean,
            default: false
        }
    },
    data() {
        return {
            inventoryTableStore: null,
            proposalsStore: null,
            archivedStore: null,
            revertNote: '',
            INVENTORY_DELETED_VIEWS,
            lockNamespace: 'INVENTORY',
            shortageAlertsStore: getShortageAlertsStore(),
            itemDecorationKeys: ['itemNumber', 'description']
        };
    },
    computed: {
        shortagesByItem() {
            return shortagesByItem(this.shortageAlertsStore?.data);
        },
        // What each inventory key is; edits apply only while the page's edit mode is 'batch' (§4.16).
        // The Edit History page adds its revert and history columns, which hold no data.
        fields() {
            const fields = [
                { ...THUMBNAIL_FIELD, editable: true },
                { key: 'itemNumber', label: 'Item#', type: 'item' },
                { key: 'quantity', label: 'Qty', format: 'number', type: 'number', editable: true },
                { key: 'description', label: 'Description (visible in pack lists)', editable: true },
                { key: 'notes', label: 'Notes (internal only)', editable: true }
            ];
            if (this.historyMode) {
                fields.push(
                    { key: '_revert', label: '' },
                    { key: '_historyDate', label: 'Date' },
                    { key: '_historyUser', label: 'User' },
                    { key: '_historyNote', label: 'Note' }
                );
            }
            return fields;
        },
        registry() {
            return this.historyMode ? INVENTORY_HISTORY_VIEWS : INVENTORY_TABLE_VIEWS;
        },
        // Row action: the item's timeline (the standard action button under a calendar header icon).
        // The Edit History page has none.
        timelineAction() {
            if (this.historyMode) return null;
            return {
                to: (row) => (row.itemNumber && this.tabTitle) ? `inventory/${this.tabTitle.toLowerCase()}/${row.itemNumber}` : null,
                disabled: (row) => !row.itemNumber,
                headerIcon: 'calendar_month',
                title: 'View item timeline'
            };
        },
        // Whether the tab has a Thumbnail column: its rows then carry the `thumbnail` key (the
        // inventory mapping reads an optional column only where it exists)
        hasThumbnails() {
            return (this.inventoryTableStore?.originalData || []).some(row => 'thumbnail' in row);
        },
        // Columns the tab's data lacks (data configuration → a view patch): a description-only tab
        // (InventoryDescriptionOnly preference) has no quantity or item number, and a tab without a
        // Thumbnail column has no thumbnails
        viewPatches() {
            const hide = [];
            if (getInventoryTabList(INVENTORY_TAB_PREFERENCES.descriptionOnly).includes(this.tabTitle)) hide.push('quantity', 'itemNumber');
            if (!this.hasThumbnails) hide.push('thumbnail');
            if (!hide.length) return [];
            const view = this.registry.views[0];
            return [{ patch: {
                columns: view.columns.filter(k => !hide.includes(k)),
                hidden: hide,
                table: { sticky: { start: view.table.sticky.start.filter(k => !hide.includes(k)) } }
            } }];
        },
        editModeName() {
            return this.allowEdit ? 'batch' : 'none';
        },
        // Only admins restore deleted items (TEMPORARY admin check: see isTemporaryAdmin)
        deletedViewPatches() {
            if (this.isAdmin) return [];
            return [{ patch: { columns: INVENTORY_DELETED_VIEWS.views[0].columns.filter(key => key !== '_restore') } }];
        },
        deletedFields() {
            return [
                { key: 'itemNumber', label: 'Item#', type: 'item' },
                { key: 'quantity', label: 'Qty', format: 'number' },
                { key: 'description', label: 'Description' },
                { key: 'notes', label: 'Notes' },
                { key: '_restore', label: '' },
                { key: 'deletedAt', label: 'Deleted' },
                { key: 'deletedBy', label: 'By' }
            ];
        },
        tableData() {
            return this.inventoryTableStore ? this.inventoryTableStore.data : [];
        },
        // Bases with a real letter variant item: their declared variants don't count
        variantFamilies() {
            return itemVariantFamilies(this.tableData.map(row => row.itemNumber));
        },
        // Past states per item, rebuilt from the SAVED rows so unsaved edits or reverts
        // don't shift the reconstruction (see EditHistoryUtils.getHistoryStates)
        historyByItem() {
            const map = new Map();
            if (!this.historyMode) return map;
            for (const row of this.inventoryTableStore?.originalData || []) {
                map.set(row.itemNumber, EditHistoryUtils.getHistoryStates(row, HISTORY_FIELDS));
            }
            return map;
        },
        // Active proposal entries for this category, by item number (shown under each item)
        proposalEntriesByItem() {
            const map = new Map();
            for (const entry of ProposalUtils.activeEntries(this.proposalsStore?.data || [])) {
                if (entry.category !== this.tabTitle) continue;
                if (!map.has(entry.itemNumber)) map.set(entry.itemNumber, []);
                map.get(entry.itemNumber).push(entry);
            }
            return map;
        },
        // The category's deleted items: a store, so every deletion (any page, any session) shows.
        // Rows back in the table (restored, saved or not) leave the list.
        deletedRows() {
            return EditHistoryUtils.currentDeletions(this.archivedStore?.data || [], this.tableData, 'itemNumber').map(entry => ({
                _entry: entry,
                itemNumber: entry.RowData.itemNumber ?? '',
                quantity: entry.RowData.quantity ?? '',
                description: entry.RowData.description ?? '',
                notes: entry.RowData.notes ?? '',
                deletedAt: entry.Timestamp ? formatHistoryTime(entry.Timestamp) : '',
                deletedBy: (entry.Username || '').split('@')[0]
            }));
        },
        originalData() {
            // Use the originalData from the store, not a copy of the reactive data
            return this.inventoryTableStore && Array.isArray(this.inventoryTableStore.originalData)
                ? JSON.parse(JSON.stringify(this.inventoryTableStore.originalData))
                : [];
        },
        error() {
            return this.inventoryTableStore ? this.inventoryTableStore.error : null;
        },
        loadingMessage() {
            return this.inventoryTableStore ? (this.inventoryTableStore.loadingMessage || 'Loading data...') : 'Loading data...';
        },
        isLoading() {
            return this.inventoryTableStore ? this.inventoryTableStore.isLoading : false;
        },
        isDirty() {
            return this.inventoryTableStore?.isModified || false;
        },
        lockKey() {
            return this.tabTitle;
        },
        activeStore() {
            return this.inventoryTableStore;
        },
        hasExternalConflict() {
            return this.inventoryTableStore?.externalConflict ?? false;
        },
        banners() {
            return [
                {
                    key: 'lock',
                    message: this.lockedBySelf
                        ? 'You have this table open for editing on another device.'
                        : `Locked for edit by: ${this.lockOwnerDisplay}`,
                    visible: this.lockedByOther,
                    dismissible: false,
                    action: this.lockedBySelf
                        ? { label: 'Claim this device', fn: () => this.claimLock() }
                        : null
                },
                {
                    key: 'conflict',
                    severity: SEVERITY.critical,
                    message: 'Another session changed this data while you have unsaved edits. Save to keep your changes or discard them.',
                    visible: this.hasExternalConflict,
                    action: {
                        label: 'Discard', fn: () =>
                            this.$modal.confirm(
                                'Are you sure you want to discard your changes?',
                                () => {
                                    this.inventoryTableStore?.load('Reloading...');
                                },
                                null,
                                'Discard Changes',
                                'Discard',
                                'Cancel'
                            )
                    }
                }
            ];
        },
        allowEdit() {
            // Inventory is always in edit mode, unless another user or device holds the lock
            return !this.lockedByOther && this.lockCheckComplete;
        },
        allowSave() {
            return this.isDirty && !this.lockedByOther && this.lockCheckComplete;
        },
        // TEMPORARY: shows or hides the admin-only buttons (delete, restore) until a real admin
        // system with permissions replaces isTemporaryAdmin
        isAdmin() {
            return isTemporaryAdmin();
        },
        // Which sub-rows show under items (INVENTORY_DETAIL_TOGGLES, kept in the URL)
        detailToggles() {
            const params = NavigationRegistry.getParametersForContainer(this.containerPath, this.appContext?.currentPath);
            return Object.fromEntries(INVENTORY_DETAIL_TOGGLES.map(toggle => [toggle.param, paramToggleValue(params, toggle)]));
        }
    },
    async mounted() {
        // Defensive: always set up the store before using it
        this.inventoryTableStore = getReactiveStore(
            Requests.getInventoryTabData,
            Requests.saveInventoryTabData,
            [this.tabTitle, undefined, undefined, undefined] // No filters needed - search is handled in UI
        );
        this.proposalsStore = getProposalsStore();

        if (this.historyMode && this.tabTitle) {
            this.archivedStore = getReactiveStore(Requests.getArchivedRows, null, ['INVENTORY', this.tabTitle]);
        }

        // Apply any pending changes that are due today or earlier
        if (this.tabTitle) {
            Requests.checkAndApplyPendingChanges(this.tabTitle).catch(err => {
                console.warn('[InventoryTable] Pending changes check failed:', err);
            });
        }
        
        // Check lock status when component mounts
        await this.checkLockStatus();
    },
    watch: {
        banners: {
            handler(newBanners) {
                this.$notify.setBanners(this.containerPath, newBanners);
            },
            immediate: true
        },
        isDirty(newValue) {
            this.handleLockState(newValue);
        }
    },
    beforeUnmount() {
        this.$notify.clearBanners(this.containerPath);
    },
    methods: {
        isMarkedForDeletion,
        // Decorations (§4.14): a shortage warning on the item number of items that run short, and
        // the variants declared in the description
        itemDecorations(row, key) {
            if (this.historyMode) return [];
            if (key === 'description') return itemVariantCards(row, (message, title) => this.$modal.alert(message, title), this.variantFamilies);
            if (key !== 'itemNumber') return [];
            return itemShortageCards(this.shortagesByItem.get(row.itemNumber), getShortageAlertDays(), this.appContext?.navigateToPath);
        },
        onLockAcquireFailed() {
            if (this.inventoryTableStore) {
                this.inventoryTableStore.setData(this.inventoryTableStore.originalData);
            }
        },

        async handleRefresh() {
            this.$modal.confirm(
                'This removes undo history and clears unsaved changes.',
                () => {
                    // Clear undo/redo history for this route
                    const routeKey = this.appContext?.currentPath?.split('?')[0];
                    if (routeKey) {
                        undoRegistry.clearRouteHistory(routeKey);
                    }
                    
                    invalidateCache([
                        { namespace: 'database', methodName: 'getData', args: ['INVENTORY', this.tabTitle] }
                    ], true);
                    this.inventoryTableStore?.load('Refreshing data...');
                },
                null,
                'Refresh Data',
                'Refresh Data',
                'Cancel'
            );
        },
        
        // cell-edit contract: (rowIndex, columnKey, value) — keyed by column, not position (fixes D4)
        async handleCellEdit(rowIdx, colKey, value) {
            const user = authState.user?.email;
            if (!user || !this.tabTitle) return;

            const row = colKey && this.inventoryTableStore?.data[rowIdx];
            if (!row) return;
            const previous = row[colKey];
            await this.editWithLock(() => { row[colKey] = value; }, () => { row[colKey] = previous; });
        },
        async handleNewRow(positionData) {
            // positionData: { position: 'above'|'below', targetIndex: number }
            
            // Generate next item number
            const nextItemNumber = await this.generateNextItemNumber();
            
            // Show prompt modal
            this.$modal.custom(NewItemNumberPrompt, {
                initialItemNumber: nextItemNumber,
                existingItems: this.inventoryTableStore?.data || [],
                onConfirm: (itemNumber) => {
                    this.addNewRow(itemNumber, positionData);
                },
                size: 'card'
            }, 'New Item');
        },
        
        async generateNextItemNumber() {
            const items = this.inventoryTableStore?.data || [];
            
            if (items.length === 0) {
                return `${this.tabTitle}-001`;
            }
            
            const itemNumbers = items.map(item => item.itemNumber).filter(Boolean);
            
            // Try to detect pattern
            const pattern = this.detectNumberingPattern(itemNumbers);
            
            if (pattern) {
                return this.incrementPattern(pattern);
            }
            
            // Fallback: category prefix + next number
            return `${this.tabTitle}-${String(items.length + 1).padStart(3, '0')}`;
        },
        
        detectNumberingPattern(itemNumbers) {
            // Look for common patterns like "PREFIX-###" or "PREFIX###"
            const patterns = {};
            
            itemNumbers.forEach(num => {
                // Match patterns like "ABC-123", "ABC123", etc.
                const match = num.match(/^([A-Za-z\-_]+)(\d+)$/);
                if (match) {
                    const prefix = match[1];
                    const number = parseInt(match[2], 10);
                    
                    if (!patterns[prefix]) {
                        patterns[prefix] = [];
                    }
                    patterns[prefix].push(number);
                }
            });
            
            // Find the most common prefix and its max number
            let bestPrefix = null;
            let maxNumber = 0;
            let maxCount = 0;
            
            for (const [prefix, numbers] of Object.entries(patterns)) {
                if (numbers.length > maxCount) {
                    maxCount = numbers.length;
                    bestPrefix = prefix;
                    maxNumber = Math.max(...numbers);
                }
            }
            
            if (bestPrefix) {
                return {
                    prefix: bestPrefix,
                    nextNumber: maxNumber + 1,
                    padding: 3 // Default to 3-digit padding
                };
            }
            
            return null;
        },
        
        incrementPattern(pattern) {
            const { prefix, nextNumber, padding } = pattern;
            return `${prefix}${String(nextNumber).padStart(padding, '0')}`;
        },
        
        addNewRow(itemNumber, positionData) {
            // Capture state for undo
            const routeKey = this.appContext?.currentPath?.split('?')[0];
            if (routeKey) {
                undoRegistry.capture(this.inventoryTableStore.data, routeKey, { type: 'add-row' });
            }
            
            // Create new item object (with an empty thumbnail where the tab has the column, so an
            // image can be added before the first save)
            const newItem = {
                itemNumber: itemNumber,
                quantity: 0,
                description: '',
                notes: '',
                ...(this.hasThumbnails ? { thumbnail: '' } : {})
            };
            
            const data = this.inventoryTableStore.data;
            
            if (positionData) {
                // Insert at specific position
                const insertIndex = positionData.position === 'above' 
                    ? positionData.targetIndex 
                    : positionData.targetIndex + 1;
                
                data.splice(insertIndex, 0, newItem);
            } else {
                // Add to end
                data.push(newItem);
            }
            
            // Navigate with searchTerm to highlight the new item
            const newPath = NavigationRegistry.buildPath(
                this.containerPath,
                { searchTerm: itemNumber }
            );
            
            if (this.appContext?.navigateToPath) {
                this.appContext.navigateToPath(newPath);
            }
            
            // Store is now dirty, save button will appear
        },
        
        handleSave() {
            if (!this.inventoryTableStore) return;
            openInventorySaveDialog(this, {
                store: this.inventoryTableStore,
                category: this.tabTitle,
                // The history page saves restores and reverts with their note; only the category
                // table sends edits to a proposal
                initialNote: this.historyMode ? this.revertNote : '',
                allowProposal: !this.historyMode,
                // On the history page, reload so the entry this save recorded appears right away
                reloadAfterSave: this.historyMode,
                afterSave: () => { this.revertNote = ''; }
            });
        },

        openProposal(entry) {
            this.appContext?.navigateToPath?.(proposalPath(entry.proposal));
        },

        getPendingEntries(item) {
            const eh = item?.edithistory;
            return EditHistoryUtils.getPendingEntries(eh);
        },

        // Returns pending entries sorted ascending by t, each annotated with cumulative
        // field values so quantity deltas stack correctly across multiple scheduled entries.
        getPendingEntriesForDisplay(item) {
            const entries = this.getPendingEntries(item);
            if (!entries.length) return [];
            const sorted = [...entries].sort((a, b) => a.t - b.t);
            const running = {};
            return sorted.map(entry => {
                const fields = {};
                for (const ch of entry.c) {
                    const base = running[ch.n] !== undefined ? running[ch.n] : (item[ch.n] ?? '');
                    const computed = EditHistoryUtils.applyNeValue(base, ch.ne);
                    fields[ch.n] = computed;
                    running[ch.n] = computed;
                }
                return { ...entry, fields };
            });
        },

        formatPendingDate(deciseconds) {
            return new Date(deciseconds * 100).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        },

        /**
         * Sub-rows under an item, in one shape for every kind, newest first:
         *   - pending (scheduled) changes and proposal changes, when their toggles are on
         *     (INVENTORY_DETAIL_TOGGLES), on both pages
         *   - edit history page: then the past states
         * @returns {Array<{label, fields, changed: Set, meta: {date, user, note}|null, revertState, rowClass}>}
         */
        getDetailRows(row) {
            const pending = !this.detailToggles.pending ? [] : this.getPendingEntriesForDisplay(row).map(entry => ({
                label: `${this.formatPendingDate(entry.t)}→`,
                fields: entry.fields,
                changed: HIGHLIGHT_CHANGES.pending ? new Set(Object.keys(entry.fields)) : new Set(),
                meta: null,
                revertState: null,
                rowClass: 'detail-row-pending'
            }));
            // Proposal rows: the proposed change (quantity as "+8"), never applied to the item
            const proposals = !this.detailToggles.proposals ? [] : (this.proposalEntriesByItem.get(row.itemNumber) || []).map(entry => {
                const fields = {};
                for (const ch of entry.changes) {
                    fields[ch.n] = ch.n === 'quantity' ? ProposalUtils.formatQuantityChange(ch.ne) : ch.ne;
                }
                return {
                    label: `${entry.proposal} proposal`,
                    fields,
                    changed: HIGHLIGHT_CHANGES.pending ? new Set(Object.keys(fields)) : new Set(),
                    meta: null,
                    revertState: null,
                    rowClass: 'detail-row-proposal',
                    proposal: entry
                };
            });
            if (!this.historyMode) return [...pending, ...proposals];
            const states = this.historyByItem.get(row.itemNumber) || [];
            // With unsaved changes the main row shows the live values, so the saved state
            // becomes the first history row
            const unsaved = this.unsavedFields(row).size > 0;
            const shown = unsaved ? states : states.slice(1);
            const above = (j) => unsaved ? (j === 0 ? row : states[j - 1].state) : states[j].state;
            // Highlight the fields where this past state differs from the next-newer one
            // (the row above it), i.e. the values that the newer change replaced
            return [...pending, ...proposals, ...shown.map((item, j) => ({
                label: item.kind === 'current' ? 'Saved'
                    : item.kind === 'created' ? 'Created'
                    : item.kind === 'earliest' ? 'Earliest recorded' : '',
                fields: item.state,
                changed: HIGHLIGHT_CHANGES.history
                    ? new Set(HISTORY_FIELDS.filter(key => String(item.state[key] ?? '') !== String(above(j)[key] ?? '')))
                    : new Set(),
                meta: this.historyMeta(item.entry),
                revertState: item.state,
                rowClass: 'detail-row-history'
            }))];
        },

        hasDetailRows(row) {
            if (this.detailToggles.pending && this.getPendingEntries(row).length > 0) return true;
            if (this.detailToggles.proposals && this.proposalEntriesByItem.has(row.itemNumber)) return true;
            if (!this.historyMode) return false;
            const count = this.historyByItem.get(row.itemNumber)?.length || 0;
            return count > 1 || (count > 0 && this.unsavedFields(row).size > 0);
        },

        // History fields whose live (store) value differs from the saved row, e.g. after a revert
        unsavedFields(row) {
            const saved = this.historyByItem.get(row.itemNumber)?.[0]?.state;
            if (!saved) return new Set();
            return new Set(HISTORY_FIELDS.filter(key => String(row[key] ?? '') !== String(saved[key] ?? '')));
        },

        historyMeta(entry) {
            if (!entry) return { date: '', user: '', note: '' };
            return { date: formatHistoryTime(entry.t), user: entry.u || '', note: EditHistoryUtils.entryNote(entry) };
        },

        // Metadata for the main row: the change that produced the current saved values,
        // or an "Unsaved" marker while the row has unsaved changes
        currentHistoryMeta(row) {
            if (this.unsavedFields(row).size > 0) {
                return { date: 'Unsaved', user: (authState.user?.email || '').split('@')[0], note: '', unsaved: true };
            }
            return this.historyMeta(this.historyByItem.get(row.itemNumber)?.[0]?.entry);
        },

        isHistoryField(key) {
            return HISTORY_FIELDS.includes(key);
        },

        /**
         * A sub-row's cells: the leading columns before the first text history field share one
         * label cell (e.g. item#), except a thumbnail, which shows that row's image in its own cell.
         * @returns {Array<{kind: 'label', key: string, span: number}|{kind: 'field', key: string, column: Object}>}
         */
        detailCells(visibleColumns) {
            const firstText = visibleColumns.findIndex(col => this.isHistoryField(col.key) && col.key !== 'thumbnail');
            const leading = firstText === -1 ? visibleColumns.length : firstText;
            const cells = [];
            let label = null;
            visibleColumns.forEach((column, i) => {
                if (i < leading && column.key !== 'thumbnail') {
                    if (!label) cells.push(label = { kind: 'label', key: '_label', span: 0 });
                    label.span++;
                } else {
                    cells.push({ kind: 'field', key: column.key, column });
                }
            });
            return cells;
        },

        /**
         * Mark an item for deletion, or unmark it (admins, history page). The same mark as the
         * table's Delete key: the row shows as marked, and saving removes it from the tab, which
         * archives it to the deleted items list (Database._archiveDeletedRows).
         */
        async toggleDeletion(row) {
            const store = this.inventoryTableStore;
            if (!store || store.indexOfRow(row) < 0) return;

            const toggle = () => store.toggleRowDeletion(row);
            await this.editWithLock(toggle, toggle, { action: 'delete', undo: 'deletion' });
        },

        /**
         * Put a deleted item back (admins, history page): its archived row, identity and history
         * return to the table as an unsaved change, and leave the deleted items list. Saving
         * restores it (its first entry records the restore); Discard or undo cancels it.
         */
        async restoreItem(entry) {
            const store = this.inventoryTableStore;
            if (!store || !entry?.RowData) return;
            const row = EditHistoryUtils.restoredRow(entry.RowData, store.data);
            if (row.itemNumber && store.data.some(other => other.itemNumber === row.itemNumber)) {
                this.$modal.alert(`${row.itemNumber} can't be restored: ${this.tabTitle} already has an item with that number.`, 'Restore');
                return;
            }
            // Fields the archived row lacks (a column added since) start empty
            const fieldNames = Object.keys(store.data[0] || {}).filter(key => key !== 'AppData');
            const restored = await this.editWithLock(
                () => store.addRow(row, fieldNames),
                () => store.data.splice(store.indexOfRow(row), 1), // the unsaved restored row only
                { action: 'restore', undo: 'restore' }
            );
            if (restored) this.revertNote = `restore ${row.itemNumber || 'item'}`.slice(0, getInventoryNoteMaxLength());
        },

        /**
         * Restore an item to a past state, rewinding every newer change. Applies the state to
         * the store (shared with the category table); the user saves it from either page.
         */
        async revertToState(row, detail) {
            const store = this.inventoryTableStore;
            const target = store?.data[store.indexOfRow(row)];
            if (!target || !detail.revertState) return;

            // Only the fields the row has (a tab without a Thumbnail column has no thumbnail)
            const fields = HISTORY_FIELDS.filter(field => field in target);
            const previous = Object.fromEntries(fields.map(field => [field, target[field]]));
            const reverted = await this.editWithLock(
                () => fields.forEach(field => { target[field] = detail.revertState[field] ?? ''; }),
                () => Object.assign(target, previous),
                { action: 'revert', undo: 'revert' }
            );
            if (!reverted) return;
            // Save note (InventoryNoteMaxLength), e.g. "revert to Oct 6, 2026" / "revert to earliest"
            const when = detail.meta?.date
                ? detail.meta.date.split(',').slice(0, 2).join(',')
                : (detail.label === 'Created' ? 'creation' : 'earliest');
            this.revertNote = `revert to ${when}`.slice(0, getInventoryNoteMaxLength());
        },

        handleReportsClick() {
            // Navigation to reports has been moved to primary navigation
            const path = this.tabTitle
                    ? NavigationRegistry.buildPath('reports/show-usage', { ctgFilter: this.tabTitle })
                    : 'reports/show-usage';
            this.appContext.navigateToPath(path);
        },
        navigateToItemPage(row) {
            if (!row.itemNumber || !this.tabTitle) return;
            const basePath = `inventory/${this.tabTitle.toLowerCase()}/${row.itemNumber}`;
            // Preserve searchTerm from current path
            const currentParams = NavigationRegistry.getParametersForContainer(
                this.containerPath,
                this.appContext?.currentPath
            );
            const newPath = NavigationRegistry.buildPath(basePath, { searchTerm: currentParams.searchTerm });
            if (this.appContext?.navigateToPath) {
                this.appContext.navigateToPath(newPath);
            }
        }
    },
    template: html `
        <slot>
            <DataView
                ref="tableComponent"
                :fields="fields"
                :rows="tableData"
                :registry="registry"
                :action="timelineAction"
                :decorations="itemDecorations"
                :decoration-keys="itemDecorationKeys"
                :patches="viewPatches"
                :edit-mode="editModeName"
                :title="inventoryName || tabTitle"
                :original-data="originalData"
                :isLoading="isLoading"
                :error="error"
                :showRefresh="true"
                :showSearch="true"
                :showNewRowButton="allowEdit"
                :sync-search-with-url="true"
                :container-path="containerPath"
                :navigate-to-path="appContext.navigateToPath"
                :newRow="allowEdit"
                :external-dirty-state="isDirty"
                :forceDetails="true"
                :rowDetailsVisible="hasDetailRows"
                emptyMessage="No inventory items found"
                :loading-message="loadingMessage"
                class="inventory-table-component"
                @refresh="handleRefresh"
                @cell-edit="handleCellEdit"
                @new-row="handleNewRow"
                @on-save="handleSave"
            >
                <template #header-area>
                    <div class="button-bar" style="display: none;"></div>
                </template>
                <template #cell="{ row, field }">
                    <span v-if="field.key === '_historyDate'" :class="['history-meta', { 'history-unsaved-label': currentHistoryMeta(row).unsaved }]">{{ currentHistoryMeta(row).date }}</span>
                    <span v-else-if="field.key === '_historyUser'" class="history-meta">{{ currentHistoryMeta(row).user }}</span>
                    <span v-else-if="field.key === '_historyNote'" class="history-meta">{{ currentHistoryMeta(row).note }}</span>
                    <!-- TEMPORARY admin check (isAdmin), until the admin system replaces it -->
                    <RowDeletionButton v-else-if="field.key === '_revert' && historyMode && isAdmin"
                        :marked="isMarkedForDeletion(row)"
                        title="Mark this item for deletion; saving removes it"
                        marked-title="Keep this item (unmark for deletion)"
                        @toggle="toggleDeletion(row)"
                    />
                </template>
                <template #row-detail-rows="{ row, visibleColumns, hasActionCell }">
                    <tr
                        v-for="(detail, i) in getDetailRows(row)"
                        :key="i"
                        :class="['detail-row', detail.rowClass, 'in-group']"
                    >
                        <template v-for="cell in detailCells(visibleColumns)" :key="cell.key">
                        <td v-if="cell.kind === 'label'" :colspan="cell.span">
                            <strong>{{ detail.label }}</strong>
                        </td>
                        <td
                            v-else
                            :class="{
                                'history-changed': detail.changed.has(cell.key),
                                'history-meta': cell.key.startsWith('_history')
                            }"
                        >
                            <template v-if="isHistoryField(cell.key)">
                                <span
                                    v-if="detail.changed.has(cell.key) && String(detail.fields[cell.key] ?? '').trim() === ''"
                                    class="history-empty"
                                >(empty)</span>
                                <CellRenderer
                                    v-else-if="cell.key === 'thumbnail' && detail.fields.thumbnail"
                                    :row="detail.fields"
                                    :field="cell.column"
                                    renderer="table"
                                />
                                <template v-else>{{ detail.fields[cell.key] ?? '' }}</template>
                            </template>
                            <template v-else-if="cell.key === '_historyDate' && detail.meta">{{ detail.meta.date }}</template>
                            <template v-else-if="cell.key === '_historyUser' && detail.meta">{{ detail.meta.user }}</template>
                            <template v-else-if="cell.key === '_historyNote' && detail.meta">{{ detail.meta.note }}</template>
                            <button
                                v-else-if="cell.key === '_revert' && detail.revertState"
                                class="button-symbol purple"
                                @click.stop="revertToState(row, detail)"
                                title="Revert to this state (undoes every newer change)"
                            >↶</button>
                            <!-- The history page has no row action column: its proposal rows open the proposal here -->
                            <button
                                v-else-if="cell.key === '_revert' && detail.proposal"
                                class="button-symbol purple"
                                @click.stop="openProposal(detail.proposal)"
                                :title="'Open the ' + detail.proposal.proposal + ' proposal'"
                            ><span class="material-symbols-outlined">info</span></button>
                        </td>
                        </template>
                        <!-- Under the row action (item timeline): a proposal row opens its proposal -->
                        <td v-if="hasActionCell">
                            <button
                                v-if="detail.proposal"
                                class="button-symbol purple"
                                @click.stop="openProposal(detail.proposal)"
                                :title="'Open the ' + detail.proposal.proposal + ' proposal'"
                            ><span class="material-symbols-outlined">info</span></button>
                        </td>
                    </tr>
                </template>
            </DataView>
            <DataView
                v-if="historyMode && deletedRows.length > 0"
                :fields="deletedFields"
                :rows="deletedRows"
                :registry="INVENTORY_DELETED_VIEWS"
                :patches="deletedViewPatches"
                title="Deleted items"
                :showSearch="false"
                :showRefresh="false"
                emptyMessage="No deleted items"
                class="inventory-deleted-rows"
            >
                <template #cell="{ row, field }">
                    <!-- TEMPORARY admin check (isAdmin), until the admin system replaces it -->
                    <button v-if="field.key === '_restore' && isAdmin"
                        class="button-symbol purple"
                        :title="'Put ' + row.itemNumber + ' back in ' + tabTitle + '; saving restores it'"
                        @click.stop="restoreItem(row._entry)"
                    ><span class="material-symbols-outlined">restore_from_trash</span></button>
                    <span v-else-if="field.key !== '_restore'" class="history-meta">{{ row[field.key] }}</span>
                </template>
            </DataView>
        </slot>
    `
};