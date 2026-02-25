import { html, TableComponent, Requests, getReactiveStore, NavigationRegistry, createAnalysisConfig, invalidateCache, Priority, tableRowSelectionState, EditHistoryUtils, authState, undoRegistry } from '../../index.js';
import { ItemImageComponent } from './InventoryTable.js';

// Packlist Table Hamburger Menu Component
const PacklistTableMenuComponent = {
    props: {
        clearAllAlertsCallback: Function,
        refreshCallback: Function
    },
    inject: ['$modal'],
    computed: {
        menuItems() {
            return [
                { label: 'Refresh', action: 'refresh' },
                { label: 'Clear All Alerts', action: 'clearAllAlerts' }
            ];
        }
    },
    methods: {
        handleAction(action) {
            switch (action) {
                case 'refresh':
                    if (this.refreshCallback) {
                        this.refreshCallback();
                    }
                    this.$emit('close-modal');
                    break;
                case 'clearAllAlerts':
                    if (this.clearAllAlertsCallback) {
                        this.clearAllAlertsCallback();
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
                if (!row || !row.MetaData) return false;
                try {
                    const metadata = typeof row.MetaData === 'string' ? JSON.parse(row.MetaData) : row.MetaData;
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
export const PacklistTable = {
    components: { TableComponent },
    inject: ['$modal', 'appContext'],
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
            hiddenColumns: ['Pack', 'Check', 'Extracted Item', 'Extracted Qty'],
            NavigationRegistry, // Make available in template
            isLocked: false, // Track lock state (owned by this component)
            lockingInProgress: false, // Prevent concurrent lock operations
            lockedByOther: false, // Track if locked by another user
            lockOwner: null, // Track who owns the lock
            lockCheckComplete: false // Track if initial lock check is done
        };
    },
    computed: {
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
        mainColumns() {
            return this.mainHeaders.map((label, idx) => {
                if (label === 'Piece #') {
                    return { key: label, label, editable: false, isIndex: true, width: 10, font: 'narrow'};
                }
                // Only make columns editable if editMode is true
                const isEditable = this.editMode && ['Type','L','W','H','Weight'].includes(label);

                // When not in edit mode, move Type, L, W, H, Weight to details
                //const isDetailsColumn = !this.editMode && ['Type','L','W','H','Weight'].includes(label);

                if (label === this.itemHeadersStart) {
                    return {
                        key: label,
                        label,
                        width: ['Description','Packing/shop notes'].includes(label) ? 200 : 40,
                        colspan: this.itemHeaders.length,
                        font: ['Pack','Check','Weight'].includes(label) ? 'narrow' : undefined
                    };
                } else {
                    return {
                        key: label,
                        label,
                        editable: isEditable,
                        details: null,
                        width: ['Description', 'Packing/shop notes'].includes(label) ? 200 : 40,
                        font: ['Pack','Check','Weight'].includes(label) ? 'narrow' : undefined
                    };
                };
            });
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
            return this.packlistTableStore ? (this.packlistTableStore.loadingMessage || 'Loading data...') : 'Loading data...';
        },
        // Check if data has been modified (uses reactive store's computed property)
        isDirty() {
            return this.packlistTableStore?.isModified || false;
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
        },
        hamburgerMenuComponent() {
            return {
                components: PacklistTableMenuComponent,
                props: {
                    clearAllAlertsCallback: () => this.clearAllAlerts(),
                    refreshCallback: () => this.handleRefresh()
                }
            };
        }
    },
    watch: {
        isDirty(newValue) {
            if (!this.lockCheckComplete) return;
            
            if (newValue && !this.editMode && this.tabName && !this.lockedByOther) {
                const editPath = NavigationRegistry.buildPathWithCurrentParams(
                    `packlist/${this.tabName}`,
                    this.appContext?.currentPath,
                    { edit: true }
                );
                this.$emit('navigate-to-path', editPath);
            }
            
            if (!this.lockedByOther) {
                this.handleLockState(newValue);
            }
        },
        
        'packlistTableStore.error'(newError) {
            if (!newError) return;
            
            const lockErrorPattern = /locked by (.+)$/i;
            const match = newError.match(lockErrorPattern);
            
            if (match) {
                this.setLockState(false, match[1]);
                
                if (this.editMode) {
                    const viewPath = NavigationRegistry.buildPathWithCurrentParams(
                        'packlistTable',
                        { tabName: this.tabName, mode: 'view' }
                    );
                    NavigationRegistry.navigateTo(viewPath, false);
                }
                
                this.$modal.alert(`Cannot save: this pack list is locked by ${match[1]}`, 'Locked');
            }
        }
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
                this.$emit('navigate-to-path', NavigationRegistry.buildPath(`packlist/${this.tabName}`, paramsWithoutEdit));
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
                    this.$emit('navigate-to-path', NavigationRegistry.buildPath(`packlist/${newTabName}`, paramsWithoutEdit));
                }
            }
        }, { immediate: true });
    },
    methods: {
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
                    'Extracted Item' // Target column name
                ),
                
                // Extract quantity from Description and store in 'Extracted Qty' column  
                createAnalysisConfig(
                    Requests.extractQuantity,
                    'extractedQty',
                    'Extracting quantities...',
                    ['Description', 'Packing/shop notes'], // Try Description first, then notes
                    [],
                    'Extracted Qty' // Target column name
                ),

                // Compare descriptions and store alert in AppData if mismatch
                createAnalysisConfig(
                    Requests.checkDescriptionMatch,
                    'descriptionAlert',
                    'Checking description match...',
                    ['Description', 'Packing/shop notes'], // Source columns for nested detection
                    [],
                    null, // No targetColumn - results go to AppData
                    true // passFullItem = true to get entire item object (API expects full item)
                ),

                // Check inventory levels and create alerts for low quantities
                createAnalysisConfig(
                    Requests.checkInventoryLevel,
                    'inventoryAlert',
                    'Checking inventory levels...',
                    ['Description', 'Packing/shop notes'], // Source columns for nested detection (use existing columns, not generated ones)
                    [this.tabName], // Additional parameter: current project ID
                    null, // No targetColumn - results go to AppData
                    true // passFullItem = true to get entire item object (API expects full item)
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
            this.$modal.confirm(
                'This removes undo history and clears unsaved changes.',
                () => {
                    // Clear undo/redo history for this route
                    const routeKey = this.$route?.path;
                    if (routeKey) {
                        undoRegistry.clearRouteHistory(routeKey);
                    }
                    
                    invalidateCache([
                        { namespace: 'database', methodName: 'getData', args: ['PACK_LISTS', this.tabName] }
                    ], true);
                },
                null,
                'Refresh Data',
                'Refresh Data',
                'Cancel'
            );
        },
        
        setLockState(isLocked, owner = null) {
            this.isLocked = isLocked;
            this.lockedByOther = owner && owner !== authState.user?.email;
            this.lockOwner = owner;
        },
        
        async checkLockStatus() {
            const user = authState.user?.email;
            if (!user || !this.tabName) return;
            
            try {
                const lockInfo = await Requests.getSheetLock('PACK_LISTS', this.tabName);
                
                if (lockInfo && lockInfo.user !== user) {
                    this.setLockState(false, lockInfo.user);
                    this.lockCheckComplete = true;
                    return;
                }
                
                if (lockInfo && lockInfo.user === user) {
                    this.setLockState(true, user);
                    
                    if (this.packlistTableStore && this.packlistTableStore.isLoading) {
                        await new Promise(resolve => {
                            const unwatch = this.$watch('packlistTableStore.isLoading', (newValue) => {
                                if (!newValue) {
                                    unwatch();
                                    resolve();
                                }
                            });
                        });
                    }
                    
                    if (!this.isDirty) {
                        const unlocked = await Requests.unlockSheet('PACK_LISTS', this.tabName, user);
                        if (!unlocked) {
                            console.warn('[PacklistTable] Failed to remove stale lock');
                        }
                        this.setLockState(false, null);
                    }
                } else {
                    this.setLockState(false, null);
                }
            } catch (error) {
                console.error('[PacklistTable] Failed to check lock status:', error);
            } finally {
                this.lockCheckComplete = true;
                
                this.$nextTick(() => {
                    if (this.isDirty && !this.editMode && this.tabName && !this.lockedByOther) {
                        const editPath = NavigationRegistry.buildPathWithCurrentParams(
                            `packlist/${this.tabName}`,
                            this.appContext?.currentPath,
                            { edit: true }
                        );
                        this.$emit('navigate-to-path', editPath);
                    }
                });
            }
        },
        
        async handleLockState(isDirty) {
            if (this.lockingInProgress || this.lockedByOther) return;
            
            const user = authState.user?.email;
            if (!user || !this.tabName) return;
            
            this.lockingInProgress = true;
            
            try {
                if (isDirty && !this.isLocked) {
                    const lockAcquired = await Requests.lockSheet('PACK_LISTS', this.tabName, user);
                    if (lockAcquired) {
                        this.setLockState(true, user);
                    } else {
                        const lockInfo = await Requests.getSheetLock('PACK_LISTS', this.tabName, user);
                        if (lockInfo && lockInfo.user !== user) {
                            this.setLockState(false, lockInfo.user);
                            console.warn(`[PacklistTable] Sheet locked by ${lockInfo.user}`);
                        }
                    }
                } else if (!isDirty && this.isLocked) {
                    const unlocked = await Requests.unlockSheet('PACK_LISTS', this.tabName, user);
                    if (unlocked) {
                        this.setLockState(false, null);
                    } else {
                        console.warn('[PacklistTable] Failed to release lock');
                    }
                }
            } catch (error) {
                console.error('[PacklistTable] Lock operation failed:', error);
                if (error.message && error.message.includes('Failed to acquire write lock')) {
                    this.$modal.alert(
                        `Unable to acquire lock for ${this.tabName}. The system is experiencing high concurrency. Please try again in a moment.`,
                        'Error'
                    );
                } else {
                    this.$modal.alert(
                        `Lock operation failed: ${error.message}`,
                        'Error'
                    );
                }
            } finally {
                this.lockingInProgress = false;
            }
        },
        
        async handleCellEdit(rowIdx, colIdx, value, type = 'main') {
            const user = authState.user?.email;
            if (user && this.tabName) {
                try {
                    const lockInfo = await Requests.getSheetLock('PACK_LISTS', this.tabName, user);
                    if (lockInfo) {
                        this.setLockState(false, lockInfo.user);
                        
                        if (this.editMode) {
                            const currentParams = NavigationRegistry.getParametersForContainer(
                                `packlist/${this.tabName}`,
                                this.appContext?.currentPath
                            );
                            const { edit, ...paramsWithoutEdit } = currentParams;
                            this.$emit('navigate-to-path', NavigationRegistry.buildPath(`packlist/${this.tabName}`, paramsWithoutEdit));
                        }
                        
                        this.$modal.alert(`Cannot edit: this pack list is locked by ${lockInfo.user}`, 'Locked');
                        return;
                    }
                    
                    if (!this.isLocked) {
                        const lockAcquired = await Requests.lockSheet('PACK_LISTS', this.tabName, user);
                        if (lockAcquired) {
                            this.setLockState(true, user);
                        } else {
                            const recheckLock = await Requests.getSheetLock('PACK_LISTS', this.tabName, user);
                            if (recheckLock) {
                                this.setLockState(false, recheckLock.user);
                                this.$modal.alert(`Cannot edit: this pack list is locked by ${recheckLock.user}`, 'Locked');
                                return;
                            }
                        }
                    }
                } catch (error) {
                    console.error('[PacklistTable] Error checking lock on edit:', error);
                }
            }
            
            if (type === 'main') {
                const colKey = this.mainColumns[colIdx]?.key;
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
        
        showInventorySelector(crateIdx, position = null) {
            // Create inventory selector modal component
            // position: { position: 'above'|'below', targetIndex: number } or null
            const InventorySelectorModal = {
                components: { TableComponent, ItemImageComponent },
                props: ['onAddEmpty', 'onItemSelected'],
                data() {
                    return {
                        inventoryStore: null,
                        categories: [],
                        selectedCategory: null,
                        isLoading: true,
                        error: null
                    };
                },
                computed: {
                    columns() {
                        return [
                            { key: 'image', label: 'IMG', width: 1, sortable: false },
                            { key: 'itemNumber', label: 'Item #', width: 120, sortable: true },
                            { key: 'description', label: 'Description', sortable: true },
                            { key: 'quantity', label: 'Available', width: 100, sortable: true },
                            { key: 'actions', label: '', width: 100, sortable: false }
                        ];
                    },
                    inventoryData() {
                        return this.inventoryStore ? this.inventoryStore.data : [];
                    },
                    originalData() {
                        return this.inventoryStore && Array.isArray(this.inventoryStore.originalData)
                            ? JSON.parse(JSON.stringify(this.inventoryStore.originalData))
                            : [];
                    }
                },
                async mounted() {
                    try {
                        this.isLoading = true;
                        // Load available inventory categories
                        const tabs = await Requests.getAvailableTabs('INVENTORY');
                        this.categories = tabs.filter(tab => tab.title !== 'INDEX');
                        
                        // Select first category by default
                        if (this.categories.length > 0) {
                            this.selectedCategory = this.categories[0].title;
                            await this.loadCategoryData();
                        }
                    } catch (error) {
                        console.error('Failed to load inventory categories:', error);
                        this.error = 'Failed to load inventory categories';
                    } finally {
                        this.isLoading = false;
                    }
                },
                watch: {
                    async selectedCategory(newCategory) {
                        if (newCategory) {
                            await this.loadCategoryData();
                        }
                    }
                },
                methods: {
                    async loadCategoryData() {
                        try {
                            this.isLoading = true;
                            this.error = null;
                            
                            // Create analysis config for image URLs
                            const analysisConfig = [
                                createAnalysisConfig(
                                    Requests.getItemImageUrl,
                                    'imageUrl',
                                    'Loading item images...',
                                    ['itemNumber'],
                                    [],
                                    null, // Store in AppData, not a column
                                    false,
                                    Priority.BACKGROUND // Images are visual enhancements, lowest priority
                                )
                            ];
                            
                            // Create or update reactive store for selected category
                            this.inventoryStore = getReactiveStore(
                                Requests.getInventoryTabData,
                                null, // No save function needed for read-only modal
                                [this.selectedCategory, undefined, undefined],
                                analysisConfig
                            );
                        } catch (error) {
                            console.error('Failed to load inventory data:', error);
                            this.error = 'Failed to load inventory data';
                        } finally {
                            this.isLoading = false;
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
                    },
                    handleReportsClick() {
                        const path = this.selectedCategory
                            ? NavigationRegistry.buildPath('inventory/reports', { itemCategoryFilter: this.selectedCategory })
                            : 'inventory/reports';
                        this.$emit('navigate-to-path', path);
                    }
                },
                template: html`
                    <div v-if="error" class="error-message">{{ error }}</div>
                    <TableComponent
                        v-else
                        theme="purple"
                        :data="inventoryData"
                        :originalData="originalData"
                        :columns="columns"
                        :isLoading="isLoading || (inventoryStore && inventoryStore.isAnalyzing)"
                        :showSearch="true"
                        :showRefresh="false"
                        :showFooter="true"
                        :sortable="true"
                        :emptyMessage="'No inventory items found'"
                        :loadingMessage="inventoryStore && inventoryStore.isAnalyzing ? 'Loading images...' : 'Loading inventory...'"
                    >
                        <template #header-area>
                            <div class="button-bar">
                                <button @click="addEmpty">Empty Row</button>
                                <select 
                                    id="category-select"
                                    v-model="selectedCategory"
                                >
                                    <option v-for="cat in categories" :key="cat.title" :value="cat.title">
                                        {{ cat.title }}
                                    </option>
                                </select>
                                <button @click="handleReportsClick" class="purple">Reports</button>
                            </div>
                        </template>
                        <template #default="{ row, column }">
                            <template v-if="column.key === 'image'">
                                <ItemImageComponent
                                    :imageUrl="row.AppData?.imageUrl"
                                    :itemNumber="row.itemNumber"
                                    :imageSize="48"
                                />
                            </template>
                            <template v-else-if="column.key === 'actions'">
                                <button @click="selectItem(row)" class="purple">Select</button>
                            </template>
                            <template v-else>
                                {{ row[column.key] }}
                            </template>
                        </template>
                    </TableComponent>
                `
            };

            // Show the inventory selector modal
            this.$modal.custom(InventorySelectorModal, {
                onItemSelected: (item) => this.addItemFromInventory(crateIdx, item, position),
                modalClass: 'page-menu',
                onAddEmpty: () => this.addEmptyItem(crateIdx, position)
            }, 'Add Item');
        },
        
        addItemFromInventory(crateIdx, inventoryItem, position = null) {
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
            const itemNumber = inventoryItem.itemNumber || '';
            const description = inventoryItem.description || '';
            const formattedDescription = `(1) ${itemNumber} ${description}`;
            
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
            // Only use the store's save method if this is called from the on-save event
            if (this.packlistTableStore) {
                await this.packlistTableStore.save('Saving packlist...');
            }
        },

        handleInnerTableDirty(isDirty, rowIndex) {
            if (this.$refs.mainTableComponent && this.$refs.mainTableComponent.checkDirtyCells) {
                this.$refs.mainTableComponent.checkDirtyCells();
            }
        },

        /**
         * Get card color for an alert
         * Prioritizes alert.color property, falls back to type-based mapping
         * @param {Object|string} alert - Alert object or type string
         * @returns {string} Color class name for the card
         */
        getAlertColor(alert) {
            // If alert is an object with a color property, use it
            if (typeof alert === 'object' && alert.color) {
                return alert.color;
            }
            
            // Otherwise, map type to color
            const type = typeof alert === 'object' ? alert.type : alert;
            const colorMap = {
                'error': 'red',
                'description mismatch': 'yellow',
                'warning': 'yellow',
                'info': 'blue',
                'success': 'green'
            };
            return colorMap[type] || 'red'; // Default to red if type is unknown
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
                        if (item.AppData) {
                            // Only delete alert keys (objects with message property, not ending in _error)
                            Object.keys(item.AppData).forEach(key => {
                                const value = item.AppData[key];
                                if (value && typeof value === 'object' && value.message && !key.endsWith('_error')) {
                                    delete item.AppData[key];
                                }
                            });
                        }
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
            if (alertKey === 'descriptionAlert' || alert.type === 'description mismatch') {
                this.showDescriptionMismatchModal(item, alert);
            } else if (alertKey === 'inventoryAlert' || ['item shortage', 'item warning', 'low-inventory'].includes(alert.type)) {
                this.navigateToInventoryDetails(item);
            } else {
                // Generic alert display
                this.$modal.alert(alert.message, alert.type || 'Info');
            }
        },

        /**
         * Show detailed modal for description mismatch alerts
         * @param {Object} item - The item with the mismatch
         * @param {Object} alert - The alert data
         */
        showDescriptionMismatchModal(item, alert) {
            const itemNumber = item['Extracted Item'] || 'Unknown';
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
                    // Update the description field with the formatted inventory description
                    const newDescription = `(${extractedQty}) ${itemNumber} ${inventoryDescription}`;
                    item.Description = newDescription;
                    
                    // Clear the alert from AppData
                    if (item.AppData) {
                        delete item.AppData['descriptionAlert'];
                    }
                },
                modalClass: 'reading-menu'
            }, `${itemNumber}`);
        },

        /**
         * Navigate to inventory details page for an item
         * @param {Object} item - The item to view details for
         */
        navigateToInventoryDetails(item) {
            const itemNumber = item['Extracted Item'];
            
            if (!itemNumber) {
                console.warn('Cannot navigate to details: no item number found');
                return;
            }
            
            // Navigate to the details endpoint with the item number as a search parameter
            const targetPath = `packlist/${this.tabName}/details?searchTerm=${encodeURIComponent(itemNumber)}`;
            this.$emit('navigate-to-path', targetPath);
        },

        async handlePrint() {
            //if not on the packlist page, navigate to the packlist page first
            this.$emit('navigate-to-path', this.containerPath);

            this.isPrinting = true;
            
            // Temporarily remove 'Pack' and 'Check' from hidden columns for printing
            const originalHidden = [...this.hiddenColumns];
            this.hiddenColumns = this.hiddenColumns.filter(col => col !== 'Pack' && col !== 'Check');

            // Wait for DOM update
            await this.$nextTick();
            
            // Print
            window.print();
            
            // Restore hidden columns after printing
            setTimeout(() => {
                this.hiddenColumns = originalHidden;
                this.isPrinting = false;
            }, 100);
        },
        handleDropOntoItem(event) {
            console.log('handleDropOntoItem called!', event);
            // event contains: { targetIndex, targetRow, selectedRows, targetArray }
            const targetItem = event.targetRow;
            const targetIndex = event.targetIndex;
            const droppedItems = event.selectedRows;
            const targetArray = event.targetArray;
            
            if (!targetItem || !droppedItems || droppedItems.length === 0) {
                console.warn('Invalid drop onto event data');
                return;
            }
            
            // Check if target is already a group master
            const targetMetadata = EditHistoryUtils.parseEditHistory(targetItem.EditHistory);
            const targetGrouping = targetMetadata?.s?.grouping;
            
            // Use existing groupId or generate new one
            const groupId = targetGrouping?.groupId || `G${Date.now()}`;
            
            // Update target item to be group master (if not already)
            if (!targetGrouping?.isGroupMaster) {
                const newTargetMetadata = EditHistoryUtils.setUserSetting(
                    targetItem.EditHistory || '',
                    'grouping',
                    {
                        groupId: groupId,
                        isGroupMaster: true,
                        masterItemIndex: targetIndex
                    }
                );
                targetItem.EditHistory = newTargetMetadata;
                console.log('Set target as group master:', groupId, 'index:', targetIndex);
            }
            
            // Update dropped items to be grouped with target
            droppedItems.forEach(droppedItem => {
                const newMetadata = EditHistoryUtils.setUserSetting(
                    droppedItem.EditHistory || '',
                    'grouping',
                    {
                        groupId: groupId,
                        isGroupMaster: false,
                        masterItemIndex: targetIndex
                    }
                );
                droppedItem.EditHistory = newMetadata;
                console.log('Grouped item with master:', groupId, 'item:', droppedItem.Description);
            });
            
            // Alert user of successful grouping
            this.$modal.alert(
                `Successfully grouped <strong>${droppedItems.length}</strong> item(s) under:<br><strong>${targetItem.Description || 'master item'}</strong><br><br>Group ID: ${groupId}`,
                'Items Grouped'
            );
            
            console.log('Grouping complete. Remember to save to persist changes.');
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
            // Toggle highlight class in MetaData for selected rows
            selectedRows.forEach(({ row }) => {
                if (row) {
                    // Parse MetaData (handle both string and object formats)
                    let metadata = {};
                    if (row.MetaData) {
                        try {
                            metadata = typeof row.MetaData === 'string' ? JSON.parse(row.MetaData) : row.MetaData;
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
                    row.MetaData = JSON.stringify(metadata);
                }
            });
        },

        clearRowAlerts(selectedRows) {
            // Clear alerts from AppData for selected rows
            let clearedCount = 0;
            
            selectedRows.forEach(({ row }) => {
                // AppData is stored as an object, not a JSON string
                if (row && row.AppData && typeof row.AppData === 'object') {
                    // Clear specific alert types
                    if (row.AppData.descriptionAlert || row.AppData.inventoryAlert) {
                        delete row.AppData.descriptionAlert;
                        delete row.AppData.inventoryAlert;
                        clearedCount++;
                    }
                }
            });
        }
    },
    template: html`
        <slot>
            <!-- Print-only Header -->
            <div class="print-header">
                <img src="images/logo.png" alt="Top Shelf Exhibits Logo" class="print-logo" />
                <h1>Pack List: <strong>{{ tabName }}</strong></h1>
                <span class="page-number"></span>
            </div>
            
            <div v-if="error" class="card red">
                <p>Error: {{ error }}</p>
            </div>
            
            <div v-if="!editMode && lockedByOther && !isPrinting" class="card white">
                Locked for edit by: {{ lockOwner.includes('@') ? lockOwner.split('@')[0] : lockOwner }}
            </div>


            <!-- Main Packlist View -->
            <TableComponent
                    ref="mainTableComponent"
                    :data="mainTableData"
                    :originalData="originalData"
                    :columns="mainColumns"
                    :title="tabName"
                    :theme="'packlist-table'"
                    :showRefresh="false"
                    :showSearch="true"
                    :sync-search-with-url="true"
                    :container-path="containerPath || 'packlist/' + tabName"
                    :navigate-to-path="(path) => $emit('navigate-to-path', path)"
                    :hideRowsOnSearch="true"
                    :emptyMessage="'No crates'"
                    :draggable="editMode"
                    :newRow="editMode"
                    :isLoading="isLoading"
                    :isAnalyzing="packlistTableStore ? packlistTableStore.isAnalyzing : false"
                    :loading-message="packlistTableStore && packlistTableStore.isLoading ? (packlistTableStore.loadingMessage || 'Loading data...') : (packlistTableStore && packlistTableStore.isAnalyzing ? (packlistTableStore.analysisMessage.loadingMessage || 'Analyzing data...') : loadingMessage)"
                    :loading-progress="packlistTableStore && packlistTableStore.isAnalyzing ? packlistTableStore.analysisProgress : -1"
                    :loading-message="loadingMessage"
                    :drag-id="'packlist-crates'"
                    :hamburgerMenuComponent="hamburgerMenuComponent"
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
                                >
                                    Edit Packlist
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
                                    :title="isDirty ? 'Save or discard changes before returning to view mode' : 'Return to view mode'">
                                    Back to View
                                </button>
                            </template>
                            <button @click="() => tabName ? $emit('navigate-to-path', 'packlist/' + tabName + '/details') : null">
                                Details
                            </button>

                            <button v-if="!editMode" @click="handlePrint" :disabled="isLoading || isAnalyzing" class="white">Print</button>
                            <!--this was moved span v-if="!editMode && lockedByOther" style="margin-left: 1rem; color: var(--color-text-secondary);">
                                Locked by {{ lockOwner.includes('@') ? lockOwner.split('@')[0] : lockOwner }}
                            </span-->
                        </div>
                    </template>
                    <template #default="{ row, rowIndex, column, cellRowIndex, cellColIndex, onInnerTableDirty }">
                        <template v-if="column && column.isIndex">
                            <!-- Only count visible (not marked-for-deletion) rows for Piece # -->
                            {{
                                mainTableData
                                    .filter(r => {
                                        if (!r || !r.MetaData) return true;
                                        try {
                                            const metadata = typeof r.MetaData === 'string' ? JSON.parse(r.MetaData) : r.MetaData;
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
                                :originalData="originalData && originalData[rowIndex] ? originalData[rowIndex].Items : []"
                                :columns="itemHeaders.map(label => ({ 
                                    key: label, 
                                    label, 
                                    editable: editMode && ['Description','Packing/shop notes'].includes(label),
                                    width: ['Description','Packing/shop notes'].includes(label) ? 200 : 40,
                                    font: ['Description','Packing/shop notes'].includes(label) ? '' : 'narrow'
                                }))"
                                :hide-columns="hiddenColumns"
                                :emptyMessage="'No items'"
                                :draggable="editMode"
                                :newRow="editMode"
                                :allowDropOnto="editMode"
                                :enableGrouping="editMode"
                                :hide-group-members="!editMode"
                                :showFooter="false"
                                :showHeader="false"
                                :isLoading="isLoading"
                                :drag-id="'packlist-items'"
                                :parent-search-value="$refs.mainTableComponent?.searchValue || ''"
                                :showSearch="true"
                                :hideRowsOnSearch="true"
                                :showSelectionBubble="editMode"
                                @cell-edit="(itemRowIdx, itemColIdx, value) => { row.Items[itemRowIdx][itemHeaders[itemColIdx]] = value; }"
                                @new-row="(positionData) => { handleAddItem(rowIndex, positionData); }"
                                @inner-table-dirty="(isDirty) => { 
                                    if (typeof onInnerTableDirty === 'function') {
                                        onInnerTableDirty(isDirty, rowIndex, column ? mainColumns.findIndex(c => c.key === column.key) : 0);
                                    }
                                    handleInnerTableDirty(isDirty, rowIndex);
                                }"
                                @drop-onto="handleDropOntoGrouping"
                                @row-options="handleRowOptions"
                                class="table-fixed"
                            >
                                <!-- Default slot for cell content -->
                                <template #default="{ row: itemRow, column: itemColumn }">
                                    <span>{{ itemRow[itemColumn.key] }}</span>
                                </template>
                                
                                <!-- Cell-extra slot for alerts (proper location for warnings/notifications) -->
                                <template #cell-extra="{ row: itemRow, column: itemColumn }">
                                    <!-- Display all AppData alerts as colored cards (visible in both view and edit modes) -->
                                    <template v-if="itemRow.AppData && itemColumn.key === 'Packing/shop notes'">
                                        <template v-for="(value, key) in itemRow.AppData" :key="key">
                                            <div 
                                                v-if="value && typeof value === 'object' && value.message && !key.endsWith('_error')"
                                                :class="['card', getAlertColor(value), { 'clickable': value.clickable }]"
                                                @click="value.clickable ? handleAlertClick(itemRow, key, value) : null"
                                            >
                                                {{ value.message }}
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

