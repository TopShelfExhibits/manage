import { html, InventoryTableComponent, hamburgerMenuRegistry, NavigationRegistry, Requests, DataView, DashboardToggleComponent, getReactiveStore, findMatchingStores, createAnalysisConfig, generateStoreKey, authState, invalidateCache, todayISOString } from '../../index.js';
import { createVisibilityManager } from './InventoryTable.js';
import { ShowInventoryReport } from './ShowInventoryReport.js';
import { InventoryItemReport } from './InventoryItemReport.js';
import { InventoryItemTimeline } from './InventoryItemTimeline.js';
import { itemImageStyle } from '../../utils/views/viewStyles.js';

// What each inventory overview key is (rows from Requests.getAllInventoryData).
// image holds no data: the thumbnail column (see itemImageStyle).
const INVENTORY_FIELDS = [
    { key: 'tab', label: 'Category' },
    { key: 'image', label: 'I' },
    { key: 'itemNumber', label: 'Item#', type: 'item' },
    { key: 'quantity', label: 'Qty', format: 'number', type: 'number' },
    { key: 'description', label: 'Description' },
    { key: 'notes', label: 'Notes' }
];

/**
 * Inventory page view registry (views-and-renderers-plan §4.3, §5): the all-items overview table
 * and the category cards are two views of the same item rows. Category cards are buckets of the
 * rows by `tab` (unrelated to packlist row groups) and search every non-hidden item field (R2.12).
 */
const INVENTORY_VIEWS = {
    id: 'inventory',
    default: 'items',
    theme: 'purple',
    // Shared by both views: the page draws Category (#cell); the item thumbnail
    sortable: ['tab', 'itemNumber', 'quantity', 'description'],
    style: { tab: { cell: 'slot' }, image: itemImageStyle('itemNumber', { size: 32 }) },
    views: [
        {
            id: 'items',
            name: 'All items',
            icon: 'table',
            layout: 'table',
            columns: ['tab', 'image', 'itemNumber', 'quantity'],
            details: ['description', 'notes'],
            style: { tab: { width: 120 } },
            table: { sticky: { start: ['image'] } },
            sort: [{ key: 'tab', dir: 'asc' }, { key: 'itemNumber', dir: 'asc' }],
            action: 'button'
        },
        {
            id: 'categories',
            name: 'Categories',
            icon: 'grid_view',
            layout: 'cards',
            cards: { bucketBy: 'tab' },
            sort: { key: 'title', dir: 'asc' },
            action: 'row'
        }
    ]
};

// Inventory Hamburger Menu Component (content only)
export const InventoryMenuComponent = {
    props: {
        containerPath: String,
        containerType: String, 
        currentSegment: String,
        title: String,
        refreshCallback: Function,
        navigateToPath: Function,
        tabTitle: String
    },
    inject: ['$modal', 'appContext'],
    computed: {
        hasSearchTerm() {
            // Get current path and check for searchTerm
            const currentCleanPath = (this.appContext?.currentPath || '').split('?')[0];
            const params = NavigationRegistry.getParametersForContainer(
                currentCleanPath,
                this.appContext?.currentPath
            );
            return params.searchTerm && params.searchTerm.trim().length > 0;
        },
        menuItems() {
            const items = [];
            
            // Add clear filter if searchTerm is present
            if (this.hasSearchTerm) {
                items.push({ 
                    label: 'Clear Filter', 
                    action: 'clearFilter',
                    class: 'yellow'
                });
            }
            
            return items;
        }
    },
    methods: {
        async handleAction(action) {
            switch (action) {
                case 'clearFilter':
                    if (this.navigateToPath) {
                        // Get the current clean path from appContext
                        const currentCleanPath = (this.appContext?.currentPath || '').split('?')[0];
                        // Remove searchTerm but keep other params
                        const newParams = { searchTerm: undefined };
                        const newPath = NavigationRegistry.buildPathWithCurrentParams(
                            currentCleanPath,
                            this.appContext?.currentPath,
                            newParams
                        );
                        this.navigateToPath(newPath);
                        this.$emit('close-modal');
                    }
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

export const InventoryContent = {
    components: {
        'inventory-table': InventoryTableComponent,
        DataView,
        'show-inventory-report': ShowInventoryReport,
        'inventory-item-report': InventoryItemReport,
        'inventory-item-timeline': InventoryItemTimeline
    },
    props: {
        containerPath: {
            type: String,
            default: 'inventory'
        },
        navigateToPath: Function,
    },
    inject: ['$modal'],
    provide() {
        return {
            _tableVisibility: this.visibilityManager
        };
    },
    data() {
        return {
            categoriesStore: null, // Reactive store for inventory categories (lock analysis)
            inventoryStore: null, // All inventory item rows (overview table and category card members)
            suppressedTabs: new Set(), // Description-only tabs hidden from the overview table
            autoSavedCategories: new Set(), // Track which categories have auto-saved data
            visibilityManager: Vue.markRaw(createVisibilityManager()),
            INVENTORY_FIELDS,
            INVENTORY_VIEWS,
            // Primary action: category cards → the category; overview rows → the item timeline (R3.8)
            inventoryAction: {
                to: (row) => {
                    if (!row?.tab) return null;
                    if (row._bucket !== undefined) return 'inventory/' + String(row.tab).toLowerCase();
                    return row.itemNumber ? `inventory/${String(row.tab).toLowerCase()}/${row.itemNumber}` : null;
                }
            }
        };
    },
    computed: {
        // Centralized clean path without parameters
        cleanContainerPath() {
            return this.containerPath.split('?')[0];
        },
        // Category names (bucketKeys) and per-category state from the categories store
        categoryList() {
            const categories = this.categoriesStore?.data || [];
            // Explicit dependency on analysis state so lock info updates re-render
            const isAnalyzing = this.categoriesStore?.isAnalyzing;
            const analysisProgress = this.categoriesStore?.analysisProgress;
            return categories
                .filter(cat => cat.title !== 'INDEX')
                .map(cat => ({
                    id: cat.sheetId,
                    title: this.formatCategoryLabel(cat.title),
                    originalTitle: cat.title,
                    lockInfo: cat.lockInfo || null,
                    AppData: cat.AppData
                }));
        },
        bucketKeys() {
            return this.categoryList.map(c => c.originalTitle);
        },
        allItemRows() {
            return this.inventoryStore?.data || [];
        },
        overviewRows() {
            if (!this.suppressedTabs.size) return this.allItemRows;
            return this.allItemRows.filter(item => !this.suppressedTabs.has(item.tab));
        },
        // The page owns its data: category cards bucket every item; the overview hides description-only tabs
        inventoryRows() {
            return this.isCategoriesView ? this.allItemRows : this.overviewRows;
        },
        inventoryLoading() {
            return this.isCategoriesView ? this.isLoadingCategories : !!this.inventoryStore?.isLoading;
        },
        inventoryAnalyzing() {
            return this.isCategoriesView ? !!this.categoriesStore?.isAnalyzing : !!this.inventoryStore?.isAnalyzing;
        },
        inventoryProgress() {
            const store = this.isCategoriesView ? this.categoriesStore : this.inventoryStore;
            if (!store) return -1;
            if (store.isLoading) return store.loadingProgress ?? -1;
            if (store.isAnalyzing) return store.analysisProgress ?? -1;
            return -1;
        },
        inventoryLoadingMessage() {
            if (this.isCategoriesView) return 'Loading...';
            const s = this.inventoryStore;
            return s?.isAnalyzing ? s.analysisMessage : (s?.loadingMessage || 'Loading all inventory data...');
        },
        // Get current category name from path for specific category views
        currentCategoryName() {
            if (this.cleanContainerPath.startsWith('inventory/')) {
                const parts = this.cleanContainerPath.split('/');
                if (parts.length >= 2) {
                    const categorySlug = parts[1];
                    const match = this.categoryList.find(c => {
                        return c.originalTitle.toLowerCase() === categorySlug.toLowerCase();
                    });
                    return match ? match.originalTitle : categorySlug.toUpperCase();
                }
            }
            return '';
        },
        isLoadingCategories() {
            return this.categoriesStore?.isLoading || false;
        },
        isCategoriesView() {
            // New path shape for category landing is inventory?{"view":"categories"}
            if (this.cleanContainerPath === 'inventory') {
                const params = NavigationRegistry.getNavigationParameters(this.containerPath);
                return params.view === 'categories';
            }

            // Backward compatibility for previously saved paths
            return this.cleanContainerPath === 'inventory/categories';
        },
        authIsAuthenticated() {
            return authState.isAuthenticated;
        }
    },
    watch: {
        // Reinitialize categories store when auth is restored after logout or reauth
        authIsAuthenticated(isAuth, wasAuth) {
            if (isAuth && !wasAuth) {
                this.initializeCategoriesStore();
            }
        },
        // Watch for when categories data is loaded and check for auto-saved data
        'categoriesStore.data': {
            handler(newData) {
                if (newData && newData.length > 0 && !this.categoriesStore.isLoading) {
                    this.checkAutoSavedCategories();
                }
            },
            deep: false
        }
    },
    methods: {
        async checkAutoSavedCategories() {
            if (!authState.isAuthenticated || !authState.user?.email || !this.categoriesStore?.data) return;

            try {
                // Check each individual category for auto-saved data
                for (const cat of this.categoriesStore.data) {
                    if (cat.title === 'INDEX') continue;
                    
                    // Generate the store key prefix (without analysis config)
                    const storeKeyPrefix = generateStoreKey(
                        Requests.getInventoryTabData,
                        Requests.saveInventoryTabData,
                        [cat.title, undefined, undefined, undefined],
                        null
                    ).substring(0, generateStoreKey(Requests.getInventoryTabData, Requests.saveInventoryTabData, [cat.title, undefined, undefined, undefined], null).lastIndexOf(':'));
                    
                    // Check if this specific key exists (prefix match since analysis config might vary)
                    const hasAutoSave = await Requests.hasUserDataKey(
                        authState.user.email,
                        storeKeyPrefix,
                        true // prefix match
                    );
                    
                    if (hasAutoSave) {
                        this.autoSavedCategories.add(cat.title);
                    }
                }
            } catch (error) {
                console.error('[InventoryContent] Error checking auto-saved categories:', error);
            }
        },
        formatCategoryLabel(tabName) {
            if (!tabName) return '';
            const lower = String(tabName).toLowerCase();
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        },
        hasUnsavedCategory(title) {
            const matchingStores = findMatchingStores(Requests.getInventoryTabData, [title, undefined, undefined, undefined]);
            return matchingStores.length > 0
                ? matchingStores.some(match => match.isModified)
                : this.autoSavedCategories.has(title);
        },
        // Bucket decorations (§4.6): lock / unsaved status text and the Save action per category
        categoryDecorations(key) {
            const cat = this.categoryList.find(c => c.originalTitle === key);
            const cards = [];
            const unsaved = this.hasUnsavedCategory(key);
            if (cat?.lockInfo) {
                const lockOwner = cat.lockInfo.user || 'Unknown';
                cards.push({ status: true, message: `Locked for edit by: ${lockOwner.includes('@') ? lockOwner.split('@')[0] : lockOwner}` });
            } else if (unsaved) {
                cards.push({ status: true, message: 'Unsaved changes' });
            }
            if (unsaved) cards.push({ message: 'Save', class: 'green', action: () => this.saveCategory(key) });
            return cards;
        },
        categoryAppData(key) {
            return this.categoryList.find(c => c.originalTitle === key)?.AppData;
        },
        handleCategoryClick(row) {
            if (!row?.tab) return;
            const currentParams = NavigationRegistry.getParametersForContainer(this.containerPath, this.containerPath);
            this.navigateToPath(NavigationRegistry.buildPath(`inventory/${String(row.tab).toLowerCase()}`, { searchTerm: currentParams.searchTerm }));
        },
        initializeInventoryStore() {
            // Hide tabs whose prefixes are all description-only from the overview table
            Requests.getPreferences().then(prefs => {
                const descPref = prefs?.find(p => p.id === 'InventoryDescriptionOnly');
                let descOnlyTabs = [];
                try { descOnlyTabs = JSON.parse(descPref?.value || '[]'); } catch {}
                this.suppressedTabs = new Set(descOnlyTabs);
            }).catch(() => {});
            // All inventory rows (pending changes applied as of today); autoLoad
            this.inventoryStore = getReactiveStore(Requests.getAllInventoryData, null, [todayISOString()]);
        },
        initializeCategoriesStore() {
            // Category search reads the item rows directly (R1.5/R2.12), so no hidden-search indexing (D7)
            const analysisConfig = [
                createAnalysisConfig(
                    Requests.getInventoryLock,
                    'lockInfo',
                    'Checking lock status...',
                    ['title'],
                    [authState.user?.email],
                    'lockInfo'
                )
            ];
            this.categoriesStore = getReactiveStore(
                Requests.getAvailableTabs,
                null,
                ['INVENTORY'],
                analysisConfig
            );
        },
        handleCategorySelect(categoryTitle) {
            // Preserve searchTerm when navigating to category
            const currentParams = NavigationRegistry.getParametersForContainer(
                this.containerPath,
                this.containerPath
            );
            const newPath = NavigationRegistry.buildPath(
                'inventory/' + categoryTitle.toLowerCase(),
                { searchTerm: currentParams.searchTerm }
            );
            this.navigateToPath(newPath);
        },
        async saveCategory(categoryTitle) {
            try {
                // Find the reactive store for this inventory category
                const matchingStores = findMatchingStores(
                    Requests.getInventoryTabData,
                    [categoryTitle, undefined, undefined, undefined]
                );
                if (matchingStores.length === 0) {
                    this.$modal.alert('Category not found or no changes to save.', 'Save');
                    return;
                }
                const storeMatch = matchingStores[0];
                if (!storeMatch.isModified) {
                    this.$modal.alert('No unsaved changes to save.', 'Save');
                    return;
                }
                await storeMatch.store.save();
                this.$modal.alert('Category saved successfully.', 'Success');
            } catch (error) {
                console.error('[InventoryContent] Failed to save category:', error);
                this.$modal.error(`Failed to save category: ${error.message}`, 'Save Error');
            }
        },
        navigateToCategoriesView() {
            this.navigateToPath(NavigationRegistry.buildPath('inventory', { view: 'categories' }));
        },
        async handleRefresh() {
            // Invalidate the categories (lock status) and the item rows
            invalidateCache([
                { namespace: 'database', methodName: 'getTabs', args: ['INVENTORY'] },
                { namespace: 'database', methodName: 'getData', args: ['INVENTORY'] }
            ], true);
            
            // If viewing an inventory table, refresh its lock status
            if (this.$refs.inventoryTable) {
                await this.$refs.inventoryTable.checkLockStatus();
            }
        }
    },
    beforeUnmount() {
        this.visibilityManager?.destroy?.();
    },
    async mounted() {
        // Initialize categories store with lock analysis, and the item rows
        this.initializeCategoriesStore();
        this.initializeInventoryStore();
        
        // Note: checkAutoSavedCategories will be called by the watcher when data loads


        // Register inventory navigation routes
        NavigationRegistry.registerNavigation('inventory', {
            routes: {}
        });

        // Register hamburger menu for inventory
        hamburgerMenuRegistry.registerMenu('inventory', {
            components: [InventoryMenuComponent, DashboardToggleComponent],
            props: {
                refreshCallback: this.handleRefresh,
                navigateToPath: this.navigateToPath,
                getLockInfo: async () => {
                    // Get lock info from the current category if we're viewing one
                    const categoryName = this.currentCategoryName;
                    //console.log('[InventoryContent] getLockInfo called:', { 
                    //    categoryName,
                    //    cleanPath: this.cleanContainerPath,
                    //    hasStore: !!this.categoriesStore,
                    //    storeData: this.categoriesStore?.data?.length
                    //});
                    
                    if (!categoryName) return null;
                    
                    // Always fetch directly from API to ensure fresh lock status
                    // (bypasses store which may have stale analysis data)
                    //console.log('[InventoryContent] Fetching lock info directly for:', categoryName);
                    const lockInfo = await Requests.getInventoryLock(categoryName.toUpperCase());
                    //console.log('[InventoryContent] Lock info from API:', lockInfo);
                    return lockInfo;
                },
                tabTitle: this.currentCategoryName
            }
        });
    },
    template: html `
        <slot>
            <!-- Inventory overview and category cards: two views of the item rows -->
            <DataView
                v-if="cleanContainerPath === 'inventory' || cleanContainerPath === 'inventory/categories'"
                :fields="INVENTORY_FIELDS"
                :rows="inventoryRows"
                :registry="INVENTORY_VIEWS"
                :view-id="cleanContainerPath === 'inventory/categories' ? 'categories' : null"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
                :action="inventoryAction"
                :bucket-keys="bucketKeys"
                :bucket-decorations="categoryDecorations"
                :bucket-label="formatCategoryLabel"
                :bucket-app-data="categoryAppData"
                title="All Inventory Overview"
                :is-loading="inventoryLoading"
                :is-analyzing="inventoryAnalyzing"
                :loading-progress="inventoryProgress"
                :loading-message="inventoryLoadingMessage"
                :error="inventoryStore?.error || null"
                :show-refresh="isCategoriesView"
                :show-search="true"
                :sync-search-with-url="true"
                :show-footer="true"
                :empty-message="isCategoriesView ? 'No categories available' : 'No inventory items found across all categories'"
                @refresh="handleRefresh"
            >
                <template #header-area>
                    <div class="button-bar" style="display: none;"></div>
                </template>
                <template #cell="{ row, field }">
                    <button
                        v-if="field.key === 'tab'"
                        @click.stop="handleCategoryClick(row)"
                        class="card purple"
                    >{{ formatCategoryLabel(row.tab) }}</button>
                </template>
            </DataView>

            <!-- Item Timeline Subpage: inventory/<cat>/<item#> -->
            <inventory-item-timeline
                v-else-if="containerPath.startsWith('inventory/') && cleanContainerPath.split('/').length >= 3"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
            />

            <!-- Specific Category View -->
            <inventory-table
                ref="inventoryTable"
                v-else-if="containerPath.startsWith('inventory/') && currentCategoryName"
                :container-path="containerPath"
                :inventory-name="'Inventory: ' + currentCategoryName.toLowerCase()"
                :tab-title="currentCategoryName"
            ></inventory-table>
        </slot>
    `
};
