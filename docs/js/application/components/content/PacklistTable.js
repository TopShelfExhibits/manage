import { html, TableComponent, DataView, Requests, getReactiveStore, NavigationRegistry, createAnalysisConfig, invalidateCache, Priority, tableRowSelectionState, EditHistoryUtils, authState, undoRegistry, todayISOString, statusColor, severityColor, SEVERITY, getInventoryTabList, INVENTORY_TAB_PREFERENCES, THUMBNAIL_FIELD } from '../../index.js';
import { resolveView } from '../../utils/views/resolveView.js';
import { thumbnailStyle } from '../../utils/views/viewStyles.js';
import { escapeHtml } from '../../utils/views/fieldFormat.js';
import { sheetLockMixin } from '../../utils/sheetLockMixin.js';
import { packlistIndexResolutionMixin } from '../interface/IndexResolutionModal.js';

// Packlist Table Hamburger Menu Component
export const PacklistTableMenuComponent = {
    name: 'PacklistTableMenuComponent',
    props: {
        getTableRef: { type: Function, required: false }
    },
    inject: ['$modal'],
    computed: {
        menuItems() {
            return [
                { label: 'Refresh', action: 'refresh' },
                { label: 'Clear All Alerts', action: 'clearAllAlerts' },
                { label: 'Show All Groups', action: 'showAllGroups' },
                { label: 'Hide All Groups', action: 'hideAllGroups' }
            ];
        }
    },
    methods: {
        handleAction(action) {
            const table = this.getTableRef?.();
            switch (action) {
                case 'refresh':
                    if (table?.handleRefresh) {
                        table.handleRefresh();
                    }
                    this.$emit('close-modal');
                    break;
                case 'clearAllAlerts':
                    if (table?.clearAllAlerts) {
                        table.clearAllAlerts();
                    }
                    this.$emit('close-modal');
                    break;
                case 'showAllGroups':
                    if (table) {
                        table.itemGroupVisibilityOverride = 'open';
                        table.$nextTick(() => { table.itemGroupVisibilityOverride = null; });
                    }
                    this.$emit('close-modal');
                    break;
                case 'hideAllGroups':
                    if (table) {
                        table.itemGroupVisibilityOverride = 'closed';
                        table.$nextTick(() => { table.itemGroupVisibilityOverride = null; });
                    }
                    this.$emit('close-modal');
                    break;
                default:
                    this.$modal.alert(`Action ${action} not implemented yet.`, 'Info');
            }
        }
    },
    template: html`
        <ul>
            <li v-for="item in menuItems" :key="item.action">
                <button 
                    @click="handleAction(item.action)"
                    :disabled="item.disabled"
                    :class="item.class">
                    {{ item.label }}
                </button>
            </li>
        </ul>
    `
};

// Row Options Menu Component for selected rows
const RowOptionsMenuComponent = {
    props: {
        selectedRows: { type: Array, required: true },
        clearRowAlertsCallback: Function,
        highlightRowsCallback: Function
    },
    inject: ['$modal'],
    computed: {
        anyHighlighted() {
            return this.selectedRows.some(({ row }) => {
                if (!row || !row.metadata) return false;
                try {
                    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
                    return metadata?.highlight?.class === 'yellow';
                } catch (e) {
                    return false;
                }
            });
        },
        menuItems() {
            const highlightLabel = this.anyHighlighted ? 'Unhighlight row(s)' : 'Highlight row(s)';
            const highlightDesc = this.anyHighlighted 
                ? `Remove highlight from ${this.selectedRows.length} row(s)` 
                : `Highlight ${this.selectedRows.length} row(s) in yellow`;
            
            return [
                { label: 'Hide Alerts', action: 'hideAlerts', description: `Clear alerts from ${this.selectedRows.length} row(s)` },
                { label: highlightLabel, action: 'toggleHighlight', description: highlightDesc }
            ];
        }
    },
    methods: {
        handleAction(action) {
            switch (action) {
                case 'hideAlerts':
                    if (this.clearRowAlertsCallback) {
                        this.clearRowAlertsCallback(this.selectedRows);
                    }
                    this.$emit('close-modal');
                    break;
                case 'toggleHighlight':
                    if (this.highlightRowsCallback) {
                        this.highlightRowsCallback(this.selectedRows, this.anyHighlighted);
                    }
                    this.$emit('close-modal');
                    break;
                default:
                    this.$modal.alert(`Action ${action} not implemented yet.`, 'Info');
            }
        }
    },
    template: html`
        <ul>
            <li v-for="item in menuItems" :key="item.action">
                <button 
                    @click="handleAction(item.action)"
                    :disabled="item.disabled"
                    :class="item.class"
                    :title="item.description">
                    {{ item.label }}
                </button>
            </li>
        </ul>
    `
};

// Use getReactiveStore for packlist table data
// Item rows inside each crate (views-and-renderers-plan §4.12, §5). Resolved once and shared by
// every crate's nested table. Pack/Check are hidden on screen and shown in print (variants.print).
const PACKLIST_ITEMS_VIEW = {
    id: 'packlist-items',
    layout: 'table',
    hidden: ['Pack', 'Check', 'Extracted Item', 'Extracted Qty'],
    table: { hideRowsOnSearch: false },
    style: {
        '*': { width: 40, font: 'narrow' },
        'Description': { width: 200, font: '' },
        'Packing/shop notes': { width: 200, font: '' }
    },
    variants: { print: { hidden: ['Extracted Item', 'Extracted Qty'] } }
};

// Editable headers; edits apply only while the page is in edit mode (tableEditMode 'batch')
const CRATE_EDITABLE = ['Type', 'L', 'W', 'H', 'Weight'];
const ITEM_EDITABLE = ['Description', 'Packing/shop notes'];

// The crates table's row number column (drawn by the page: the visible row count)
const PIECE_NUMBER = 'Piece #';

// Width/font by header for the crates table (structural class packlist-table, R3.6)
function crateColumnStyle(label) {
    if (label === PIECE_NUMBER) return { width: 10, font: 'narrow' };
    const width = ['Description', 'Packing/shop notes'].includes(label) ? 200 : ['L', 'W', 'H'].includes(label) ? 20 : 40;
    const font = ['Pack', 'Check', 'Weight'].includes(label) ? 'narrow' : undefined;
    return font ? { width, font } : { width };
}

export const PacklistTable = {
    mixins: [sheetLockMixin, packlistIndexResolutionMixin],
    components: { TableComponent },
    inject: ['$modal', 'appContext', '$notify'],
    props: {
        content: { type: Object, required: false, default: () => ({}) },
        tabName: { type: String, default: '' },
        containerPath: { type: String, default: '' }
    },
    data() {
        return {
            packlistTableStore: null,
            isPrinting: false,
            databaseItemHeaders: null,
            NavigationRegistry,
            PIECE_NUMBER,
            lockNamespace: 'PACK_LISTS',
            itemGroupVisibilityOverride: null,
            scheduleAttachment: null
        };
    },
    computed: {
        // Items view resolved once (print variant while printing); shared by all crates
        itemsResolved() {
            const fields = this.itemHeaders.map(key => ({ key, label: key, editable: ITEM_EDITABLE.includes(key) }));
            return resolveView(fields, PACKLIST_ITEMS_VIEW, { print: this.isPrinting, editMode: this.tableEditMode });
        },
        tableEditMode() {
            return this.editMode ? 'batch' : 'none';
        },
        // Item headers hidden by the items view (screen: Pack, Check, Extracted…; print: Extracted…)
        hiddenColumns() {
            return this.itemHeaders.filter(k => this.itemsResolved.hidden.has(k));
        },
        // Crates view: the sheet's crate headers, in sheet order. Piece # and the nested item table
        // are page cells (#cell); the item table's cell spans the item headers after it.
        cratesResolved() {
            const fields = this.mainHeaders.map(key => ({ key, label: key, editable: CRATE_EDITABLE.includes(key) }));
            const style = {};
            for (const key of this.mainHeaders) style[key] = crateColumnStyle(key);
            if (style[PIECE_NUMBER]) style[PIECE_NUMBER].cell = 'slot';
            if (style[this.itemHeadersStart]) Object.assign(style[this.itemHeadersStart], { cell: 'slot', colspan: this.itemHeaders.length });
            return resolveView(fields, {
                id: 'packlist-crates',
                layout: 'table',
                className: 'packlist-table',
                columns: this.mainHeaders,
                style,
                table: { hideRowsOnSearch: false }
            }, { editMode: this.tableEditMode });
        },
        mainHeaders() {
            // Use headers from the first crate if available, else use default schema
            const crates = this.mainTableData;
            if (crates.length > 0 && Object.keys(crates[0]).length > 0) {
                return [...Object.keys(crates[0]), ...this.itemHeaders].filter(k => k !== 'Items').filter(k => !this.hiddenColumns.includes(k));
            }
            // Fallback to content headers if present
            if (this.content && this.content.length > 0 && Object.keys(this.content[0]).length > 0) {
                const headers = Object.keys(this.content[0]).filter(k => k !== 'Items');
                return [...headers, ...this.itemHeaders].filter(k => !this.hiddenColumns.includes(k));
            }
            // Default schema when no data is available
            return ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes'];
        },
        mainTableData() {
            // Use the reactive array directly from the store
            if (this.packlistTableStore && Array.isArray(this.packlistTableStore.data)) {
                return this.packlistTableStore.data;
            }
            return [];
        },
        originalData() {
            if (this.packlistTableStore && Array.isArray(this.packlistTableStore.originalData)) {
                return JSON.parse(JSON.stringify(this.packlistTableStore.originalData));
            }
            return [];
        },
        // Loaded crates by row id, so a moved crate's item table compares with its own loaded items
        originalCratesById() {
            return new Map(this.originalData.map(crate => [crate?.AppData?._rowId, crate]));
        },
        itemHeaders() {
            // Try to infer item headers from the first crate's Items array
            const crates = this.mainTableData;
            if (crates.length > 0 && Array.isArray(crates[0].Items) && crates[0].Items.length > 0) {
                return Object.keys(crates[0].Items[0]);
            }
            // fallback to content
            if (this.content && this.content.length > 0 && Array.isArray(this.content[0].Items) && this.content[0].Items.length > 0) {
                return Object.keys(this.content[0].Items[0]);
            }
            // Use database headers if available, otherwise use default schema
            return this.databaseItemHeaders || ['Pack', 'Check', 'Description', 'Packing/shop notes'];
        },
        itemHeadersStart() {
            return this.itemHeaders.filter(k => !this.hiddenColumns.includes(k))[0];
        },
        error() {
            return this.packlistTableStore ? this.packlistTableStore.error : null;
        },
        isLoading() {
            return this.packlistTableStore ? this.packlistTableStore.isLoading : false;
        },
        loadingMessage() {
            const store = this.packlistTableStore;
            if (store?.isAnalyzing && !store.isLoading) return store.analysisMessage || 'Analyzing data...';
            return store?.loadingMessage || 'Loading data...';
        },
        // Check if data has been modified (uses reactive store's computed property)
        isDirty() {
            return this.packlistTableStore?.isModified || false;
        },
        lockKey() {
            return this.tabName;
        },
        activeStore() {
            return this.packlistTableStore;
        },
        hasExternalConflict() {
            return this.packlistTableStore?.externalConflict ?? false;
        },
        banners() {
            const banners = [
                {
                    key: 'error',
                    severity: SEVERITY.critical,
                    message: `Error: ${this.error}`,
                    visible: !!this.error
                },
                {
                    key: 'lock',
                    message: this.lockedBySelf
                        ? 'You have this pack list open for editing on another device.'
                        : `Locked for edit by: ${this.lockOwnerDisplay}`,
                    visible: this.lockedByOther && !this.isPrinting,
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
                                    this.packlistTableStore?.load('Reloading...');
                                },
                                null,
                                'Discard Changes',
                                'Discard',
                                'Cancel'
                            )
                    }
                }
            ];
            
            // Add schedule attachment banners
            if (this.scheduleAttachment && !this.scheduleAttachment.attached && this.scheduleAttachment.hasIdentifierParts) {
                const clientIssue = this.scheduleAttachment.clientIssue;
                const showIssue = this.scheduleAttachment.showIssue;
                
                if (clientIssue) {
                    banners.push({
                        key: 'client-missing',
                        severity: SEVERITY.critical,
                        message: 'Client missing from production schedule index',
                        visible: true,
                        dismissible: true,
                        action: {
                            label: 'Resolve',
                            fn: () => this.openPacklistIndexResolutionModal(this.tabName, 'client', clientIssue.rawValue)
                        }
                    });
                }
                
                if (showIssue) {
                    banners.push({
                        key: 'show-missing',
                        severity: SEVERITY.critical,
                        message: 'Show missing from production schedule index',
                        visible: true,
                        dismissible: true,
                        action: {
                            label: 'Resolve',
                            fn: () => this.openPacklistIndexResolutionModal(this.tabName, 'show', showIssue.rawValue)
                        }
                    });
                }
                
                // If suffix variant found, prompt user to confirm the link
                const suggestedMatch = this.scheduleAttachment.suggestedMatch;
                if (suggestedMatch) {
                    banners.push({
                        key: 'suggested-match',
                        severity: SEVERITY.critical,
                        message: `Possible schedule match: "${suggestedMatch}"`,
                        visible: true,
                        dismissible: true,
                        action: {
                            label: 'Link',
                            fn: () => this.openSuggestedMatchModal(this.tabName, suggestedMatch)
                        }
                    });
                } else if (!clientIssue && !showIssue) {
                    banners.push({
                        key: 'not-on-schedule',
                        severity: SEVERITY.critical,
                        message: 'Packlist not found on production schedule',
                        visible: true,
                        dismissible: true
                    });
                }
            }
            
            return banners;
        },
        
        editMode() {
            let path = this.containerPath;
            if (!path && this.tabName) {
                path = `packlist/${this.tabName}`;
            }
            const params = NavigationRegistry.getParametersForContainer(
                path,
                this.appContext?.currentPath
            );
            // Handle both boolean true and string "true" from URL parameters
            return params?.edit === true || params?.edit === 'true';
        }
    },
    watch: {
        banners: {
            handler(newBanners) {
                this.$notify.setBanners(this.containerPath, newBanners);
            },
            immediate: true
        },
        // Entering edit is a parameter-only change (the page isn't remounted), so re-check the
        // lock here as mount used to, and leave edit mode when another user holds it
        async editMode(isEdit) {
            if (!isEdit || !this.tabName) return;
            await this.checkLockStatus();
            if (this.editMode && this.lockedByOther) this.onForeignLockWhileClean();
        },
        isDirty(newValue) {
            if (newValue && !this.editMode && this.tabName && !this.lockedByOther && this.lockCheckComplete) {
                const editPath = NavigationRegistry.buildPathWithCurrentParams(
                    `packlist/${this.tabName}`,
                    this.appContext?.currentPath,
                    { edit: true }
                );
                this.$emit('navigate-to-path', { targetPath: editPath, replaceHistory: true });
            }

            this.handleLockState(newValue);
        }
    },
    beforeUnmount() {
        this.$notify.clearBanners(this.containerPath);
    },
    async mounted() {
        // Initialize store if tabName is available
        if (this.tabName) {
            this.initializeStore();
            await this.checkLockStatus();
            
            if (this.editMode && this.lockedByOther) {
                const currentParams = NavigationRegistry.getParametersForContainer(
                    `packlist/${this.tabName}`,
                    this.appContext?.currentPath
                );
                const { edit, ...paramsWithoutEdit } = currentParams;
                    this.$emit('navigate-to-path', {
                        targetPath: NavigationRegistry.buildPath(`packlist/${this.tabName}`, paramsWithoutEdit),
                        replaceHistory: true
                    });
            }
        }

        // Watch for tabName changes to handle direct URL navigation
        this.$watch('tabName', async (newTabName) => {
            if (newTabName && !this.packlistTableStore) {
                this.initializeStore();
                await this.checkLockStatus();
                
                if (this.editMode && this.lockedByOther) {
                    const currentParams = NavigationRegistry.getParametersForContainer(
                        `packlist/${newTabName}`,
                        this.appContext?.currentPath
                    );
                    const { edit, ...paramsWithoutEdit } = currentParams;
                    this.$emit('navigate-to-path', {
                        targetPath: NavigationRegistry.buildPath(`packlist/${newTabName}`, paramsWithoutEdit),
                        replaceHistory: true
                    });
                }
            }
        }, { immediate: true });
        
        // Watch for store loading completion to check schedule attachment
        this.$watch(() => this.packlistTableStore?.isLoading, async (isLoading, wasLoading) => {
            if (wasLoading && !isLoading && this.tabName) {
                // Store just finished loading, check schedule attachment
                try {
                    this.scheduleAttachment = await Requests.getPacklistScheduleAttachment(this.tabName);
                } catch (error) {
                    console.error('[PacklistTable] Failed to check schedule attachment:', error);
                }
            }
        });
    },
    methods: {
        onForeignLockWhileClean() {
            if (!this.tabName) return;

            const viewPath = NavigationRegistry.buildPathWithCurrentParams(
                `packlist/${this.tabName}`,
                this.appContext?.currentPath,
                { edit: undefined }
            );
            this.$emit('navigate-to-path', { targetPath: viewPath, replaceHistory: true });
        },
        async _reloadAfterPacklistAttachmentChange(packlistTitle) {
            this.scheduleAttachment = await Requests.getPacklistScheduleAttachment(packlistTitle);
        },
        initializeStore() {
            if (!this.tabName) return;
            
            // Create analysis configuration for item extraction
            const analysisConfig = [
                // Extract item number from Description and store in 'Extracted Item' column
                createAnalysisConfig(
                    Requests.extractItemNumber,
                    'extractedItem',
                    'Extracting item numbers...',
                    ['Description', 'Packing/shop notes'], // Try Description first, then notes
                    [],
                    'Extracted Item', // Target column name
                    false,
                    Priority.ANALYSIS,
                    false,
                    false // nonessential
                ),
                
                // Extract quantity from Description and store in 'Extracted Qty' column  
                createAnalysisConfig(
                    Requests.extractQuantity,
                    'extractedQty',
                    'Extracting quantities...',
                    ['Description', 'Packing/shop notes'], // Try Description first, then notes
                    [],
                    'Extracted Qty', // Target column name
                    false,
                    Priority.ANALYSIS,
                    false,
                    false // nonessential
                ),

                // Compare descriptions and store alert in AppData if mismatch
                createAnalysisConfig(
                    Requests.checkDescriptionMatch,
                    'descriptionAlert',
                    'Checking description match...',
                    ['Extracted Item', 'Description', 'Packing/shop notes'],
                    [],
                    null,
                    false,
                    Priority.ANALYSIS,
                    true, // extractColumnsAsObject
                    false // nonessential
                ),

                // Check inventory levels and create alerts for low quantities
                createAnalysisConfig(
                    Requests.checkInventoryLevel,
                    'inventoryAlert',
                    'Checking inventory levels...',
                    ['Description', 'Packing/shop notes'], // Source columns for nested detection (use existing columns, not generated ones)
                    [this.tabName], // Additional parameter: current project ID
                    null, // No targetColumn - results go to AppData
                    true, // passFullItem = true to get entire item object (API expects full item)
                    Priority.ANALYSIS,
                    false,
                    false // nonessential
                ),

                // Check declared variant counts (inventory description) against this and overlapping shows
                createAnalysisConfig(
                    Requests.checkVariantLevel,
                    'variantAlert',
                    'Checking variant quantities...',
                    ['Description', 'Packing/shop notes'],
                    [this.tabName],
                    null,
                    true, // passFullItem
                    Priority.ANALYSIS,
                    false,
                    false // nonessential
                ),

                // Check edit history source flow and flag rows changed in CAD after prior web/app edits
                createAnalysisConfig(
                    Requests.checkCadSourceHistory,
                    'cadSourceAlert',
                    'Checking CAD source history...',
                    'edithistory',
                    [],
                    null,
                    false,
                    Priority.ANALYSIS,
                    false,
                    false // nonessential
                )
            ];
            
            // Pass Requests.savePackList as the save function with analysis
            this.packlistTableStore = getReactiveStore(
                Requests.getPackList,
                Requests.savePackList,
                [this.tabName],
                analysisConfig // Add analysis configuration
            );
            
            // Load database headers
            this.loadItemHeaders();
        },
        async loadItemHeaders() {
            if (!this.tabName) return;
            try {
                this.databaseItemHeaders = await Requests.getItemHeaders(this.tabName);
            } catch (error) {
                console.warn('Failed to load item headers from database:', error);
                this.databaseItemHeaders = ['Pack', 'Check', 'Description', 'Packing/shop notes'];
            }
        },
        async handleRefresh() {
            // create a function for use in the modal
            const refreshData = async () => {
                // Invalidate cache for database first, then API call for the current pack list in case it was empty
                // Clear undo/redo history for this route
                const routeKey = this.$route?.path;
                if (routeKey) {
                    undoRegistry.clearRouteHistory(routeKey);
                }
                invalidateCache([
                    { namespace: 'database', methodName: 'getData', args: ['PACK_LISTS', this.tabName] },
                ], true);
                this.packlistTableStore?.load('Refreshing data...');
            };
            
            // if not in edit mode, just refresh the data
            if (!this.editMode) {
                await refreshData();
            } else {
                this.$modal.confirm(
                    'This removes undo history and clears unsaved changes.',
                    () => {
                        refreshData();
                    },
                    null,
                    'Refresh Data',
                    'Refresh Data',
                    'Cancel'
                );
            }
        },
        
        afterCheckLockComplete() {
            this.$nextTick(() => {
                if (this.isDirty && !this.editMode && this.tabName && !this.lockedByOther) {
                    const editPath = NavigationRegistry.buildPathWithCurrentParams(
                        `packlist/${this.tabName}`,
                        this.appContext?.currentPath,
                        { edit: true }
                    );
                    this.$emit('navigate-to-path', { targetPath: editPath, replaceHistory: true });
                }
            });
        },

        onLockAcquireFailed(lockInfo) {
            if (this.packlistTableStore) {
                this.packlistTableStore.setData(this.packlistTableStore.originalData);
            }
            if (this.editMode) {
                const viewPath = NavigationRegistry.buildPathWithCurrentParams(
                    `packlist/${this.tabName}`,
                    this.appContext?.currentPath,
                    { edit: undefined }
                );
                this.$emit('navigate-to-path', { targetPath: viewPath, replaceHistory: true });
            }
            this.$modal.alert(`Cannot edit: this pack list is locked by ${lockInfo?.user || 'another user'}`, 'Locked');
        },
        
        // cell-edit contract: (rowIndex, columnKey, value)
        async handleCellEdit(rowIdx, colKey, value, type = 'main') {
            const user = authState.user?.email;
            if (user && this.tabName) {
                if (!await this.acquireLockForEdit()) {
                    if (this.editMode && this.lockOwner) {
                        const currentParams = NavigationRegistry.getParametersForContainer(
                            `packlist/${this.tabName}`,
                            this.appContext?.currentPath
                        );
                        const { edit, ...paramsWithoutEdit } = currentParams;
                        this.$emit('navigate-to-path', {
                            targetPath: NavigationRegistry.buildPath(`packlist/${this.tabName}`, paramsWithoutEdit),
                            replaceHistory: true
                        });
                    }
                    if (this.lockOwner) {
                        this.$modal.alert(`Cannot edit: this pack list is locked by ${this.lockOwnerDisplay}`, 'Locked');
                    }
                    return;
                }
            }
            
            if (type === 'main') {
                if (colKey && this.mainTableData[rowIdx]) {
                    this.mainTableData[rowIdx][colKey] = value;
                }
            }
        },
        handleAddCrate() {
            // Capture state for undo before adding crate
            const routeKey = this.appContext?.currentPath?.split('?')[0];
            if (routeKey) {
                undoRegistry.capture(this.packlistTableStore.data, routeKey, { type: 'add-row' });
            }
            
            const headers = this.mainHeaders.filter(h => h !== 'Items');
            const infoObj = {};
            headers.forEach(label => {
                infoObj[label] = '';
            });
            infoObj['Piece #'] = this.mainTableData.length + 1;
            // Use the store's addRow to ensure reactivity and correct initialization
            if (this.packlistTableStore && typeof this.packlistTableStore.addRow === 'function') {
                this.packlistTableStore.addRow({
                    ...infoObj,
                    Items: []
                });
            }
        },
        handleAddItem(crateIdx, position = null) {
            // Immediately show inventory selector modal
            // position: { position: 'above'|'below', targetIndex: number } or null
            this.showInventorySelector(crateIdx, position);
        },
        
        addEmptyItem(crateIdx, position = null) {
            // Capture state for undo before adding item
            const routeKey = this.appContext?.currentPath?.split('?')[0];
            if (routeKey) {
                undoRegistry.capture(this.packlistTableStore.data, routeKey, { type: 'add-nested-row' });
            }
            
            const itemHeaders = this.itemHeaders;
            const itemObj = {};
            itemHeaders.forEach(label => {
                itemObj[label] = '';
            });
            // Use the store's addNestedRow to ensure reactivity and correct initialization
            if (
                this.packlistTableStore &&
                typeof this.packlistTableStore.addNestedRow === 'function'
            ) {
                this.packlistTableStore.addNestedRow(crateIdx, 'Items', itemObj, null, position);
            }
        },
        
        async showInventorySelector(crateIdx, position = null) {
            // Create inventory selector modal component - show immediately, load data inside
            // position: { position: 'above'|'below', targetIndex: number } or null
            const tabName = this.tabName; // Capture for use inside modal
            const InventorySelectorModal = {
                components: { DataView },
                props: ['onAddEmpty', 'onItemSelected', 'tabName'],
                data() {
                    return {
                        inventoryStore: null,
                        referenceDate: null,
                        error: null,
                        selectedCategory: null
                    };
                },
                computed: {
                    // Rows from Requests.getAllInventoryData (inventory rows carry their thumbnail)
                    fields() {
                        return [
                            THUMBNAIL_FIELD,
                            { key: 'itemNumber', label: 'Item#', type: 'item' },
                            { key: 'description', label: 'Description' },
                            { key: 'quantity', label: 'Available' }
                        ];
                    },
                    // Single-view registry in a modal (no URL); adding the item is the primary action (a row click)
                    registry() {
                        return {
                            id: 'packlist-inventory-selector',
                            default: 'table',
                            theme: 'purple',
                            views: [{
                                id: 'table', name: 'Inventory', layout: 'table',
                                columns: ['thumbnail', 'itemNumber', 'description', 'quantity'],
                                sortable: ['itemNumber', 'description', 'quantity'],
                                style: { thumbnail: thumbnailStyle('itemNumber'), itemNumber: { width: 120 }, quantity: { width: 100 } },
                                table: { sticky: { start: ['thumbnail'] } },
                                sort: { key: 'itemNumber', dir: 'asc' },
                                // Clicking a row adds the item
                                action: 'row'
                            }]
                        };
                    },
                    addAction() {
                        return { run: (row) => this.selectItem(row), label: '+ Add Item' };
                    },
                    allInventoryData() {
                        return this.inventoryStore ? this.inventoryStore.data : [];
                    },
                    availableCategories() {
                        const tabs = [...new Set(this.allInventoryData.map(item => item.tab).filter(Boolean))];
                        return tabs.sort();
                    },
                    inventoryData() {
                        if (!this.selectedCategory) return this.allInventoryData;
                        return this.allInventoryData.filter(item => item.tab === this.selectedCategory);
                    },
                    originalData() {
                        return this.inventoryStore && Array.isArray(this.inventoryStore.originalData)
                            ? JSON.parse(JSON.stringify(this.inventoryStore.originalData))
                            : [];
                    },
                    // Combine local loading state with store loading state
                    isLoading() {
                        return !this.inventoryStore || this.inventoryStore.isLoading;
                    }
                },
                async mounted() {
                    // Fetch the show's ship date so inventory quantities reflect state at time of packing
                    const shipDate = await Requests.getProjectShipDate(this.tabName);
                    this.referenceDate = shipDate || todayISOString();
                    
                    await this.loadStore();
                },
                methods: {
                    async loadStore() {
                        try {
                            this.error = null;
                            
                            // Initialize reactive store using the new API method
                            // Note: autoLoad is true by default, so data will load automatically
                            // Don't set isLoading to false - let the computed property track store.isLoading
                            this.inventoryStore = getReactiveStore(
                                Requests.getAllInventoryData,
                                null, // No save function (read-only)
                                [this.referenceDate || todayISOString()] // Apply pending changes as of reference date
                            );
                        } catch (error) {
                            console.error('Failed to load inventory data:', error);
                            this.error = 'Failed to load inventory data';
                        }
                    },
                    selectItem(item) {
                        if (this.onItemSelected) {
                            this.onItemSelected(item);
                        }
                        this.$emit('close-modal');
                    },
                    addEmpty() {
                        if (this.onAddEmpty) {
                            this.onAddEmpty();
                        }
                        this.$emit('close-modal');
                    }
                },
                template: html`
                    <div v-if="error" class="error-message">{{ error }}</div>
                    <DataView
                        v-else
                        :fields="fields"
                        :rows="inventoryData"
                        :registry="registry"
                        :action="addAction"
                        :original-data="originalData"
                        :isLoading="isLoading"
                        :isAnalyzing="inventoryStore && inventoryStore.isAnalyzing"
                        :showSearch="true"
                        :showRefresh="false"
                        :showFooter="true"
                        :emptyMessage="'No inventory items found'"
                        :loadingMessage="inventoryStore && inventoryStore.isAnalyzing ? 'Loading images...' : 'Loading inventory...'"
                    >
                        <template #header-area>
                            <button @click="addEmpty" class="large">+ Empty Row</button>
                            <p style="margin-left: 1em;">Or add from inventory below...</p>
                            <select :value="selectedCategory" @change="e => selectedCategory = e.target.value || null" style="margin-left: auto;">
                                <option value="">All Categories</option>
                                <option v-for="cat in availableCategories" :key="cat" :value="cat">{{ cat.charAt(0) + cat.slice(1).toLowerCase() }}</option>
                            </select>
                        </template>
                    </DataView>
                `
            };

            // Show the inventory selector modal
            this.$modal.custom(InventorySelectorModal, {
                onItemSelected: (item) => this.addItemFromInventory(crateIdx, item, position),
                size: 'page',
                tall: true,
                onAddEmpty: () => this.addEmptyItem(crateIdx, position),
                tabName
            }, 'Add Item');
        },
        
        async addItemFromInventory(crateIdx, inventoryItem, position = null) {
            // Capture state for undo before adding item from inventory
            const routeKey = this.appContext?.currentPath?.split('?')[0];
            if (routeKey) {
                undoRegistry.capture(this.packlistTableStore.data, routeKey, { type: 'add-nested-row' });
            }
            
            // Create a new item row populated with inventory data
            // position: { position: 'above'|'below', targetIndex: number } or null
            const itemHeaders = this.itemHeaders;
            const itemObj = {};
            
            // Initialize all fields to empty string
            itemHeaders.forEach(label => {
                itemObj[label] = '';
            });
            
            // Populate with inventory data
            // Format: (1) ITEM# Description
            // Description-only tabs (InventoryDescriptionOnly preference) add just the description, no item# or stub
            const itemNumber = inventoryItem.itemNumber || '';
            const description = inventoryItem.description || '';
            const itemTab = await Requests.getTabNameForItem(itemNumber).catch(() => null);
            const descriptionOnlyTabs = getInventoryTabList(INVENTORY_TAB_PREFERENCES.descriptionOnly);
            const formattedDescription = (itemTab && descriptionOnlyTabs.includes(itemTab))
                ? description
                : `(1) ${itemNumber} ${description}`;
            
            // Set the description field
            if (itemHeaders.includes('Description')) {
                itemObj['Description'] = formattedDescription;
            }
            
            // Set quantity if there's a field for it
            if (itemHeaders.includes('Qty')) {
                itemObj['Qty'] = '1';
            }
            
            // Use the store's addNestedRow to ensure reactivity and correct initialization
            if (
                this.packlistTableStore &&
                typeof this.packlistTableStore.addNestedRow === 'function'
            ) {
                this.packlistTableStore.addNestedRow(crateIdx, 'Items', itemObj, null, position);
            }
        },
        async handleSave() {
            if (!this.packlistTableStore) return;
            if (this.hasExternalConflict) {
                this.$modal.confirm(
                    'Another session changed this data. Saving will overwrite their changes.',
                    async () => {
                        await this.packlistTableStore.save('Saving packlist...');
                    },
                    null,
                    'External Changes Detected',
                    'Save Anyway',
                    'Cancel'
                );
                return;
            }
            await this.packlistTableStore.save('Saving packlist...');
        },


        /**
         * Card colour of an analysis alert: its severity's colour (application/utils/severity.js).
         * An alert without a severity shows as critical.
         * @param {Object} alert
         * @returns {string} Color class name for the card
         */
        getAlertColor(alert) {
            return statusColor(alert) || severityColor(SEVERITY.critical);
        },

        getRowGrouping(row) {
            if (!row || !row.metadata) return null;
            try {
                const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
                return metadata?.grouping || null;
            } catch (e) {
                return null;
            }
        },

        isGroupMasterRow(row) {
            const grouping = this.getRowGrouping(row);
            return grouping?.isGroupMaster === true;
        },

        getGroupChildRows(sourceArray, groupId) {
            if (!Array.isArray(sourceArray) || !groupId) return [];
            return sourceArray.filter(item => {
                const grouping = this.getRowGrouping(item);
                return grouping && grouping.groupId === groupId && grouping.isGroupMaster !== true;
            });
        },

        getAlertItemNumber(item) {
            const extracted = String(item?.['Extracted Item'] || '').trim();
            if (extracted) return extracted;

            const description = String(item?.Description || '').trim();
            const prefixedMatch = description.match(/^\(\s*\d+\s*\)\s*([^\s]+)/);
            if (prefixedMatch && prefixedMatch[1]) return prefixedMatch[1];

            return 'Unknown Item';
        },

        getAlertEntriesForItem(item, isSurfaced = false) {
            if (!item?.AppData || typeof item.AppData !== 'object') return [];

            return Object.entries(item.AppData)
                .filter(([key, value]) => value && typeof value === 'object' && value.message && !key.endsWith('_error'))
                .map(([key, alert]) => {
                    const itemNumber = this.getAlertItemNumber(item);
                    const message = isSurfaced ? `Item ${itemNumber}: ${alert.message}` : alert.message;

                    return {
                        key,
                        alert,
                        sourceItem: item,
                        message,
                        clickable: !!alert.clickable,
                        isSurfaced
                    };
                });
        },

        dedupeAlertEntries(entries) {
            if (!Array.isArray(entries) || entries.length === 0) return [];

            const seen = new Set();
            return entries.filter(entry => {
                const signature = [
                    entry?.isSurfaced ? 'surfaced' : 'row',
                    entry?.key || '',
                    entry?.message || ''
                ].join('|');

                if (seen.has(signature)) {
                    return false;
                }

                seen.add(signature);
                return true;
            });
        },

        getSurfacedAlertsForRow(sourceArray, row, areGroupMembersHidden = false) {
            if (!areGroupMembersHidden || !this.isGroupMasterRow(row)) {
                return [];
            }

            const grouping = this.getRowGrouping(row);
            const childRows = this.getGroupChildRows(sourceArray, grouping?.groupId);
            const surfacedChildAlerts = childRows.flatMap(child => this.getAlertEntriesForItem(child, true));

            return this.dedupeAlertEntries(surfacedChildAlerts);
        },

        shouldShowshowGroupCard(sourceArray, row, areGroupMembersHidden = false) {
            return this.getSurfacedAlertsForRow(sourceArray, row, areGroupMembersHidden).length > 0;
        },

        getRenderableAlertsForRow(sourceArray, row, areGroupMembersHidden = false) {
            const ownAlerts = this.getAlertEntriesForItem(row, false);
            const surfacedAlerts = this.getSurfacedAlertsForRow(sourceArray, row, areGroupMembersHidden);

            return this.dedupeAlertEntries([...ownAlerts, ...surfacedAlerts]);
        },

        clearAlertsFromItem(item) {
            if (!item?.AppData || typeof item.AppData !== 'object') return;

            Object.keys(item.AppData).forEach(key => {
                const value = item.AppData[key];
                if (value && typeof value === 'object' && value.message && !key.endsWith('_error')) {
                    delete item.AppData[key];
                }
            });
        },

        /**
         * Clear all alerts from all items in the table
         */
        clearAllAlerts() {
            if (!this.mainTableData || this.mainTableData.length === 0) {
                return;
            }

            // Iterate through all crates
            this.mainTableData.forEach(crate => {
                if (crate.Items && Array.isArray(crate.Items)) {
                    // Iterate through all items in the crate
                    crate.Items.forEach(item => {
                        this.clearAlertsFromItem(item);
                    });
                }
            });
        },

        /**
         * Handle click on an alert card
         * @param {Object} item - The item row containing the alert
         * @param {string} alertKey - The AppData key for this alert
         * @param {Object} alert - The alert object that was clicked
         */
        handleAlertClick(item, alertKey, alert) {
            // Handle different types of alerts
            if (alert.details) {
                // Variant alerts explain themselves
                this.$modal.alert(escapeHtml(alert.details), alert.message);
            } else if (alertKey === 'descriptionAlert' || alert.type === 'description mismatch') {
                this.showDescriptionMismatchModal(item, alert);
            } else if (alertKey === 'inventoryAlert' || ['item shortage', 'item warning', 'low-inventory'].includes(alert.type)) {
                this.navigateToInventoryDetails(item);
            } else if (alertKey === 'cadSourceAlert' || alert.type === 'cad-source-change') {
                this.showCadSourceRestoreModal(item, alert);
            } else {
                // Generic alert display
                this.$modal.alert(alert.message, alert.type || 'Info');
            }
        },

        /**
         * Apply a set of field changes to an item, capturing an undo snapshot first.
         * Used by modal callbacks to ensure undo is always recorded.
         * @param {Object} item - Reactive item object to mutate
         * @param {Array<{n: string, o: *}>} changes - Field changes: n=field name, o=value to apply
         * @param {string} alertKey - AppData key to clear after applying (e.g. 'cadSourceAlert')
         */
        applyItemChanges(item, changes, alertKey) {
            const routeKey = this.$route?.path;
            if (routeKey) {
                undoRegistry.capture(this.packlistTableStore.data, routeKey, { type: 'restore' });
            }
            if (Array.isArray(changes)) {
                changes.forEach(change => {
                    if (change && change.n !== undefined) {
                        item[change.n] = change.o;
                    }
                });
            }
            if (alertKey && item.AppData) {
                delete item.AppData[alertKey];
            }
        },

        /**
         * Show modal with pre-CAD edit context and option to restore previous values.
         * @param {Object} item - The item with CAD-source alert
         * @param {Object} alert - CAD alert payload from analysis
         */
        showCadSourceRestoreModal(item, alert) {
            const CadSourceRestoreComponent = {
                props: ['alert', 'editMode', 'onRestore', 'onClearAlert'],
                computed: {
                    previousSummary() {
                        return this.alert?.previousWebSummary || 'unknown';
                    },
                    restoreChanges() {
                        const changes = this.alert?.restoreChanges;
                        if (!Array.isArray(changes) || changes.length === 0) return [];
                        return changes;
                    }
                },
                methods: {
                    restore() {
                        if (!this.editMode) {
                            return;
                        }
                        if (this.onRestore) {
                            this.onRestore();
                        }
                        this.$emit('close-modal');
                    },
                    clearAlert() {
                        if (this.onClearAlert) {
                            this.onClearAlert();
                        }
                        this.$emit('close-modal');
                    },
                    close() {
                        this.$emit('close-modal');
                    }
                },
                template: html`
                    <slot>
                        <div>
                            <p>{{ alert.message }}</p>
                            <p>Previously: {{ previousSummary }}</p>
                            <div v-if="restoreChanges.length > 0">
                                <p>Restoring to:</p>
                                <p v-for="change in restoreChanges" :key="change.n">
                                    <strong>{{ change.n }}:</strong> {{ change.o }}
                                </p>
                            </div>
                        </div>
                        <div class="button-bar">
                            <button @click="restore" :disabled="!editMode" :title="!editMode ? 'Enable edit mode to restore values' : 'Restore values from before CAD changes'">Restore</button>
                            <button @click="clearAlert" class="gray">Clear Alert</button>
                            <button @click="close" class="gray">Close</button>
                        </div>
                    </slot>
                `
            };

            this.$modal.custom(CadSourceRestoreComponent, {
                alert,
                editMode: this.editMode,
                onRestore: () => {
                    if (!item || !Array.isArray(alert?.restoreChanges)) return;
                    this.applyItemChanges(item, alert.restoreChanges, 'cadSourceAlert');
                },
                onClearAlert: () => {
                    if (!item?.AppData) return;
                    delete item.AppData.cadSourceAlert;
                },
                modalClass: 'reading-menu',
                size: 'wide'
            }, 'CAD Source Change');
        },

        /**
         * Show detailed modal for description mismatch alerts
         * @param {Object} item - The item with the mismatch
         * @param {Object} alert - The alert data
         */
        showDescriptionMismatchModal(item, alert) {
            // A variant line keeps its variant (CAB-004b) when its description is updated
            const itemNumber = alert.variant || item['Extracted Item'] || 'Unknown';
            const extractedQty = item['Extracted Qty'] || '1';
            const matchPercentage = alert.score ? Math.round(alert.score * 100) : 0;
            const inventoryDescription = alert.inventoryDescription || 'N/A';
            
            const DescriptionMismatchComponent = {
                props: ['item', 'alert', 'editMode', 'onUpdate'],
                computed: {
                    packlistDescription() {
                        return this.alert.packlistDescription || this.item.Description || 'N/A';
                    },
                    inventoryDescription() {
                        return this.alert.inventoryDescription || 'N/A';
                    }
                },
                methods: {
                    updateDescription() {
                        if (this.onUpdate) {
                            this.onUpdate();
                        }
                        this.$emit('close-modal');
                    },
                    cancel() {
                        this.$emit('close-modal');
                    }
                },
                template: html`
                    <slot>
                        <div>
                            <p>Current Description:</p>
                            <div class="card orange">{{ packlistDescription }}</div>
                        </div>
                        <div>
                            <p>Inventory Description:</p>
                            <div class="card purple">{{ inventoryDescription }}</div>
                        </div>
                        <div v-if="editMode" class="button-bar">
                            <button @click="updateDescription">Update Description</button>
                            <button @click="cancel" class="gray">Cancel</button>
                        </div>
                    </slot>
                `
            };
            
            this.$modal.custom(DescriptionMismatchComponent, {
                item: item,
                alert: alert,
                editMode: this.editMode,
                onUpdate: () => {
                    const newDescription = `(${extractedQty}) ${itemNumber} ${inventoryDescription}`;
                    this.applyItemChanges(item, [{ n: 'Description', o: newDescription }], 'descriptionAlert');
                },
                modalClass: 'reading-menu',
                size: 'wide'
            }, `${itemNumber}`);
        },

        /**
         * Navigate to inventory item timeline page for an item
         * @param {Object} item - The item to view details for
         */
        async navigateToInventoryDetails(item) {
            const itemNumber = item['Extracted Item'];

            if (!itemNumber) {
                console.warn('Cannot navigate to details: no item number found');
                return;
            }

            // Resolve the inventory category tab for this item so we can build the correct path
            let tabName = item.AppData?.tabName || item.tabName || null;
            if (!tabName) {
                try {
                    tabName = await Requests.getTabNameForItem(itemNumber);
                } catch (_) {}
            }

            // Resolve the show's date window to pre-filter the timeline
            let dateFilters;
            try {
                const [shipDate, returnDate] = await Promise.all([
                    Requests.getProjectShipDate(this.tabName),
                    Requests.getProjectReturnDate(this.tabName)
                ]);
                if (shipDate && returnDate) {
                    dateFilters = [
                        { column: 'Date', value: shipDate,  type: 'after'  },
                        { column: 'Date', value: returnDate, type: 'before' }
                    ];
                }
            } catch (_) {}

            const basePath = tabName
                ? `inventory/${tabName.toLowerCase()}/${itemNumber}`
                : `packlist/${this.tabName}/details?searchTerm=${encodeURIComponent(itemNumber)}`;

            const finalPath = (tabName && dateFilters)
                ? NavigationRegistry.buildPath(basePath, { dateFilters })
                : basePath;

            this.$emit('navigate-to-path', finalPath);
        },

        async handlePrint() {
            //if not on the packlist page, navigate to the packlist page first
            this.$emit('navigate-to-path', this.containerPath);

            // The items view's print variant shows Pack and Check while printing
            this.isPrinting = true;

            // Wait for DOM update
            await this.$nextTick();
            
            // Print
            window.print();
            
            // Back to the screen view after printing
            setTimeout(() => {
                this.isPrinting = false;
            }, 100);
        },
        handleRowOptions(selectedRows) {
            // Show modal with custom options for selected rows
            this.$modal.custom(RowOptionsMenuComponent, {
                selectedRows: selectedRows,
                clearRowAlertsCallback: this.clearRowAlerts.bind(this),
                highlightRowsCallback: this.highlightRows.bind(this),
                modalClass: 'hamburger-menu'
            }, `Options for ${selectedRows.length} Row(s)`);
        },

        highlightRows(selectedRows, shouldRemove = false) {
            // Toggle highlight class in metadata for selected rows
            selectedRows.forEach(({ row }) => {
                if (row) {
                    // Parse metadata (handle both string and object formats)
                    let metadata = {};
                    if (row.metadata) {
                        try {
                            metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
                        } catch (e) {
                            metadata = {};
                        }
                    }
                    
                    if (shouldRemove) {
                        // Remove highlight
                        if (metadata.highlight) {
                            delete metadata.highlight.class;
                            // Clean up empty highlight object
                            if (Object.keys(metadata.highlight).length === 0) {
                                delete metadata.highlight;
                            }
                        }
                    } else {
                        // Add or update highlight class
                        if (!metadata.highlight) {
                            metadata.highlight = {};
                        }
                        metadata.highlight.class = 'yellow';
                    }
                    
                    // Store back as JSON string
                    row.metadata = JSON.stringify(metadata);
                }
            });
        },

        clearRowAlerts(selectedRows) {
            selectedRows.forEach(({ row, sourceArray }) => {
                this.clearAlertsFromItem(row);

                const grouping = this.getRowGrouping(row);
                if (grouping?.isGroupMaster && Array.isArray(sourceArray)) {
                    const childRows = this.getGroupChildRows(sourceArray, grouping.groupId);
                    childRows.forEach(child => this.clearAlertsFromItem(child));
                }
            });
        }
    },
    template: html`
        <slot>
            <!-- Print-only Header -->
            <div class="print-header">
                <img src="assets/logo.png" alt="Top Shelf Exhibits Logo" class="print-logo" />
                <h1>Pack List: <strong>{{ tabName }}</strong></h1>
                <span class="page-number"></span>
            </div>



            <!-- Main Packlist View -->
            <TableComponent
                    ref="mainTableComponent"
                    :data="mainTableData"
                    :originalData="originalData"
                    :resolved="cratesResolved"
                    :edit-mode="tableEditMode"
                    :class="cratesResolved.className"
                    :rowKey="'AppData._rowId'"
                    :title="tabName"
                    :showRefresh="!editMode"
                    :showSearch="true"
                    :sync-search-with-url="true"
                    :container-path="containerPath || 'packlist/' + tabName"
                    :navigate-to-path="(path) => $emit('navigate-to-path', path)"
                    :emptyMessage="'No crates'"
                    :draggable="editMode"
                    :newRow="editMode"
                    :isLoading="isLoading"
                    :isAnalyzing="packlistTableStore ? packlistTableStore.isAnalyzing : false"
                    :loading-message="loadingMessage"
                    :loading-progress="packlistTableStore && packlistTableStore.isAnalyzing ? packlistTableStore.analysisProgress : -1"
                    :drag-id="'packlist-crates'"
                    :hide-group-members="true"
                    @refresh="handleRefresh"
                    @cell-edit="handleCellEdit"
                    @new-row="handleAddCrate"
                    @on-save="handleSave"
                    
                >
                    <template #header-area>
                        <!-- Navigation Controls -->
                        <div class="button-bar">
                            <!-- Edit Mode Toggle -->
                            <template v-if="!editMode">
                                <button 
                                    @click="() => tabName ? $emit('navigate-to-path', NavigationRegistry.buildPathWithCurrentParams('packlist/' + tabName, appContext?.currentPath, { edit: true })) : null"
                                    :disabled="!lockCheckComplete || lockedByOther"
                                    :title="!lockCheckComplete ? 'Checking lock status...' : (lockedByOther ? 'Locked by ' + (lockOwner.includes('@') ? lockOwner.split('@')[0] : lockOwner) : 'Edit this pack list')"
                                    class="small"
                                >
                                    Edit
                                </button> 
                            </template>
                            <template v-else>
                                <button 
                                    @click="() => {
                                        if (tabName) {
                                            const currentParams = NavigationRegistry.getParametersForContainer('packlist/' + tabName, appContext?.currentPath);
                                            const { edit, ...paramsWithoutEdit } = currentParams;
                                            $emit('navigate-to-path', NavigationRegistry.buildPath('packlist/' + tabName, paramsWithoutEdit));
                                        }
                                    }"
                                    :disabled="isDirty"
                                    :title="isDirty ? 'Save or discard changes before returning to view mode' : 'Return to view mode'"
                                    class="small"
                                >
                                    View
                                </button>
                            </template>
                            <button @click="() => tabName ? $emit('navigate-to-path', 'packlist/' + tabName + '/details') : null" class="button-symbol" title="View Packlist Details">☷</button>

                            <button v-if="!editMode" @click="handlePrint" :disabled="isLoading || isAnalyzing" class="button-symbol white" title="Print Packlist">
                                <span class="material-symbols-outlined">print</span>
                            </button>
                            <!--this was moved span v-if="!editMode && lockedByOther" style="margin-left: 1rem; color: var(--color-text-secondary);">
                                Locked by {{ lockOwner.includes('@') ? lockOwner.split('@')[0] : lockOwner }}
                            </span-->
                        </div>
                    </template>
                    <template #cell="{ row, rowIndex, field: column, onInnerTableDirty }">
                        <template v-if="column && column.key === PIECE_NUMBER">
                            <!-- Only count visible (not marked-for-deletion) rows for Piece # -->
                            {{
                                mainTableData
                                    .filter(r => {
                                        if (!r || !r.metadata) return true;
                                        try {
                                            const metadata = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
                                            return metadata?.deletion?.marked !== true;
                                        } catch (e) {
                                            return true;
                                        }
                                    })
                                    .findIndex(r => r === row) + 1
                            }}
                        </template>
                        <template v-else-if="column && column.key === itemHeadersStart">
                            <TableComponent
                                v-if="row.Items"
                                :data="row.Items"
                                :originalData="originalCratesById.get(row.AppData?._rowId)?.Items || []"
                                :rowKey="'AppData._rowId'"
                                :resolved="itemsResolved"
                                :edit-mode="tableEditMode"
                                :emptyMessage="'No items'"
                                :draggable="editMode"
                                :newRow="editMode"
                                :allowDropOnto="editMode"
                                :hide-group-members="true"
                                :group-visibility-override="itemGroupVisibilityOverride"
                                :showFooter="false"
                                :showHeader="false"
                                :isLoading="isLoading"
                                :drag-id="'packlist-items'"
                                :parent-search-value="$refs.mainTableComponent?.search?.debouncedValue?.value || ''"
                                :showSearch="true"
                                :showSelectionBubble="editMode"
                                @cell-edit="(itemRowIdx, itemColKey, value) => { row.Items[itemRowIdx][itemColKey] = value; }"
                                @new-row="(positionData) => { handleAddItem(rowIndex, positionData); }"
                                @inner-table-dirty="onInnerTableDirty"
                                @row-options="handleRowOptions"
                                class="table-fixed"
                            >
                                <!-- Cell-extra slot for alerts (proper location for warnings/notifications) -->
                                <template #cell-extra="{ row: itemRow, column: itemColumn, isGroupMembersHidden, showGroup }">
                                    <!-- Display all AppData alerts as colored cards (visible in both view and edit modes) -->
                                    <template v-if="itemColumn.key === 'Packing/shop notes'">
                                        <div
                                            v-if="shouldShowshowGroupCard(row.Items, itemRow, isGroupMembersHidden)"
                                            class="card gray clickable"
                                            title="click to show grouped rows"
                                            @click="showGroup ? showGroup() : null"
                                        >
                                            hidden rows
                                        </div>
                                        <template v-for="(alertEntry, alertIndex) in getRenderableAlertsForRow(row.Items, itemRow, isGroupMembersHidden)" :key="alertEntry.key + '-' + alertIndex">
                                            <div 
                                                :class="['card', getAlertColor(alertEntry.alert), { 'clickable': alertEntry.clickable }]"
                                                @click="alertEntry.clickable ? handleAlertClick(alertEntry.sourceItem, alertEntry.key, alertEntry.alert) : null"
                                            >
                                                {{ alertEntry.message }}
                                            </div>
                                        </template>
                                    </template>
                                </template>
                            </TableComponent>
                        </template>
                        <template v-else>
                            {{ row[column.key] }}
                        </template>
                    </template>
                </TableComponent>
            </div>
        </slot>
    `
};

