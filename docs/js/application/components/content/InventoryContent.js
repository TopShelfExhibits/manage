import { html, InventoryTableComponent, hamburgerMenuRegistry, NavigationRegistry, Requests, DataView, DashboardToggleComponent, getReactiveStore, findMatchingStores, createAnalysisConfig, generateStoreKey, authState, invalidateCache, todayISOString, getInventoryTabList, INVENTORY_TAB_PREFERENCES, getShortageAlertsStore, getShortageAlertDays, shortagesByItem, itemShortageCards, categoryShortageCards, itemVariantCards, itemVariantFamilies, THUMBNAIL_FIELD, isMarkedForDeletion, ParamToggles, ProposalUtils, getInventoryNoteMaxLength } from '../../index.js';
import { ShowInventoryReport } from './ShowInventoryReport.js';
import { InventoryItemReport } from './InventoryItemReport.js';
import { InventoryItemTimeline } from './InventoryItemTimeline.js';
import { getProposalsStore, PROPOSALS_PATH, proposalPath, proposalItemsFromStore, saveToProposal } from '../../utils/inventoryProposals.js';
import { InventorySaveModal, INVENTORY_DETAIL_TOGGLES } from './InventoryTable.js';

/** Route key of the per-category history page: inventory/<category>/edit-history */
export const EDIT_HISTORY_ROUTE = 'edit-history';

/**
 * Split an inventory path into its category slug and sub-route.
 * @param {string} path - Container path (query parameters allowed)
 * @returns {{ category: string|null, subRoute: string|null }}
 */
function parseInventoryPath(path) {
    const segments = String(path || '').split('?')[0].split('/').filter(Boolean);
    if (segments[0] !== 'inventory') return { category: null, subRoute: null };
    return { category: segments[1] || null, subRoute: segments[2] || null };
}
import { thumbnailStyle } from '../../utils/views/viewStyles.js';

// What each inventory overview key is (rows from Requests.getAllInventoryData). Rows of a tab
// without a Thumbnail column have no thumbnail, so their cell is blank.
const INVENTORY_FIELDS = [
    { key: 'tab', label: 'Category' },
    THUMBNAIL_FIELD,
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
    style: { tab: { cell: 'slot' }, thumbnail: thumbnailStyle('itemNumber', 32) },
    views: [
        {
            id: 'items',
            name: 'All items',
            icon: 'table',
            layout: 'table',
            columns: ['tab', 'thumbnail', 'itemNumber', 'quantity'],
            details: ['description', 'notes'],
            style: { tab: { width: 120 } },
            table: { sticky: { start: ['thumbnail'] } },
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

// Inventory Hamburger Menu Component (content only). On a category table or its history page it
// also holds the sub-row toggles (INVENTORY_DETAIL_TOGGLES), kept in the URL.
export const InventoryMenuComponent = {
    components: { ParamToggles },
    props: {
        containerPath: String,
        containerType: String, 
        currentSegment: String,
        title: String,
        refreshCallback: Function,
        navigateToPath: Function
    },
    inject: ['$modal', 'appContext'],
    data() {
        return { proposalsStore: getProposalsStore(), INVENTORY_DETAIL_TOGGLES };
    },
    computed: {
        hasActiveProposals() {
            return (this.proposalsStore?.data || []).some(entry => !entry.committed);
        },
        // Derived from the menu's current containerPath (supplied fresh each time the menu opens)
        inventoryLocation() {
            const { category, subRoute } = parseInventoryPath(this.containerPath);
            const isRegisteredCategory = !!category && !!NavigationRegistry.getRoute(`inventory/${category}`);
            return {
                category,
                isCategoryTable: isRegisteredCategory && !subRoute,
                isEditHistory: isRegisteredCategory && subRoute === EDIT_HISTORY_ROUTE
            };
        },
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

            if (this.inventoryLocation.isCategoryTable) {
                items.push({ label: 'See Edit History', action: 'openEditHistory' });
            } else if (this.inventoryLocation.isEditHistory) {
                items.push({ label: 'Back to Table', action: 'closeEditHistory' });
            }

            if (this.hasActiveProposals) {
                items.push({ label: 'View Proposals', action: 'viewProposals' });
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
                case 'openEditHistory':
                case 'closeEditHistory': {
                    const base = `inventory/${this.inventoryLocation.category}`;
                    const target = action === 'openEditHistory' ? `${base}/${EDIT_HISTORY_ROUTE}` : base;
                    // Keep the search term so the same items stay highlighted
                    const { searchTerm } = NavigationRegistry.getParametersForContainer(this.containerPath, this.appContext?.currentPath);
                    this.navigateToPath?.(NavigationRegistry.buildPath(target, { searchTerm }));
                    this.$emit('close-modal');
                    break;
                }
                case 'viewProposals':
                    this.navigateToPath?.(PROPOSALS_PATH);
                    this.$emit('close-modal');
                    break;
                default:
                    this.$modal.alert(`Action ${action} not implemented yet.`, 'Info');
            }
        }
    },
    template: html`
        <ul>
            <li v-if="inventoryLocation.isCategoryTable || inventoryLocation.isEditHistory">
                <ParamToggles :toggles="INVENTORY_DETAIL_TOGGLES" :container-path="containerPath" :navigate-to-path="navigateToPath" />
            </li>
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
    data() {
        return {
            categoriesStore: null, // Reactive store for inventory categories (lock analysis)
            inventoryStore: null, // All inventory item rows (overview table and category card members)
            autoSavedCategories: new Set(), // Track which categories have auto-saved data
            shortageAlertsStore: getShortageAlertsStore(),
            itemDecorationKeys: ['itemNumber', 'description'],
            INVENTORY_FIELDS,
            INVENTORY_VIEWS,
            // Primary action: category cards → the category; overview rows → the item timeline (R3.8),
            // the standard action button under a calendar header icon
            inventoryAction: {
                to: (row) => {
                    if (!row?.tab) return null;
                    if (row._bucket !== undefined) return 'inventory/' + String(row.tab).toLowerCase();
                    return row.itemNumber ? `inventory/${String(row.tab).toLowerCase()}/${row.itemNumber}` : null;
                },
                headerIcon: 'calendar_month',
                title: 'View item timeline'
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
        shortagesByItem() {
            return shortagesByItem(this.shortageAlertsStore?.data);
        },
        allItemRows() {
            return this.inventoryStore?.data || [];
        },
        // Bases with a real letter variant item: their declared variants don't count
        variantFamilies() {
            return itemVariantFamilies(this.allItemRows.map(row => row.itemNumber));
        },
        // Description-only tabs (InventoryDescriptionOnly preference), hidden from the overview table
        descriptionOnlyTabs() {
            return getInventoryTabList(INVENTORY_TAB_PREFERENCES.descriptionOnly);
        },
        overviewRows() {
            if (!this.descriptionOnlyTabs.length) return this.allItemRows;
            return this.allItemRows.filter(item => !this.descriptionOnlyTabs.includes(item.tab));
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
        },
        // Registered sub-route of a category (e.g. edit-history), checked before item numbers
        registeredSubRoute() {
            NavigationRegistry.routeRegistrationVersion.value; // re-evaluate when routes register
            const { category, subRoute } = parseInventoryPath(this.cleanContainerPath);
            if (!category || !subRoute) return null;
            return NavigationRegistry.getRoute(`inventory/${category}/${subRoute}`) ? subRoute : null;
        },
        isEditHistoryView() {
            return this.registeredSubRoute === EDIT_HISTORY_ROUTE;
        },
        isInventorySubPath() {
            return !!parseInventoryPath(this.cleanContainerPath).subRoute;
        },
        // Category titles; reading every element tracks in-place updates to the store's array
        categoryTitles() {
            return (this.categoriesStore?.data || []).map(cat => cat?.title).filter(Boolean);
        },
        // Sub-routes are registered from the category list, so wait for it before treating
        // an unknown third segment as an item number
        categoryRoutesReady() {
            NavigationRegistry.routeRegistrationVersion.value; // re-evaluate when routes register
            const { category } = parseInventoryPath(this.cleanContainerPath);
            if (category && NavigationRegistry.getRoute(`inventory/${category}`)) return true;
            // Unknown category: resolve once the category list has finished loading (or failed)
            const store = this.categoriesStore;
            return !!store && !store.isLoading && !store.initialLoad && (this.categoryTitles.length > 0 || !!store.error);
        }
    },
    watch: {
        // Reinitialize categories store when auth is restored after logout or reauth
        authIsAuthenticated(isAuth, wasAuth) {
            if (isAuth && !wasAuth) {
                this.initializeCategoriesStore();
            }
        },
        // Register category routes (and their history pages) whenever the category list changes
        categoryTitles: {
            handler(titles) {
                this.registerCategoryRoutes(titles);
            },
            immediate: true
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
        registerCategoryRoutes(titles) {
            for (const title of titles || []) {
                if (title === 'INDEX' || title.startsWith('_')) continue;
                const slug = title.toLowerCase();
                const displayName = title.charAt(0).toUpperCase() + title.slice(1).toLowerCase();
                NavigationRegistry.addDynamicRoute('inventory', slug, { displayName });
                NavigationRegistry.addDynamicRoute(`inventory/${slug}`, EDIT_HISTORY_ROUTE, { displayName: 'Edit History' });
            }
        },
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
            cards.push(...categoryShortageCards(this.shortageAlertsStore?.data, key, getShortageAlertDays(), this.navigateToPath));
            return cards;
        },
        // Decorations (§4.14): a shortage warning on the item number of overview items that run
        // short, and the variants declared in the description
        itemDecorations(row, key) {
            if (key === 'description') return itemVariantCards(row, (message, title) => this.$modal.alert(message, title), this.variantFamilies);
            if (key !== 'itemNumber') return [];
            return itemShortageCards(this.shortagesByItem.get(row.itemNumber), getShortageAlertDays(), this.navigateToPath);
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
            const matchingStores = findMatchingStores(
                Requests.getInventoryTabData,
                [categoryTitle, undefined, undefined, undefined]
            );
            if (matchingStores.length === 0 || !matchingStores[0].isModified) {
                this.$modal.alert('No unsaved changes to save.', 'Save');
                return;
            }
            const storeMatch = matchingStores[0];
            const data = storeMatch.store.data || [];
            const original = storeMatch.store.originalData || [];
            const hasQtyChanges = data.some(row => {
                const orig = original.find(o => o.itemNumber === row.itemNumber);
                return orig && String(row.quantity) !== String(orig.quantity);
            });
            const proposals = ProposalUtils.groupProposals(this.proposalsStore?.data || []);
            this.$modal.custom(InventorySaveModal, {
                hasQtyChanges,
                onProposal: (name, isNew) => this.handleCategoryProposal(categoryTitle, storeMatch.store, name, isNew),
                proposalNames: proposals.filter(p => !p.committed).map(p => p.name),
                allProposalNames: proposals.map(p => p.name),
                deletionCount: data.filter(isMarkedForDeletion).length,
                onConfirm: async (scheduledDate, note) => {
                    await storeMatch.store.save('Saving inventory...', { scheduledDate, note });
                    if (scheduledDate > todayISOString()) {
                        await storeMatch.store.load('Loading...');
                    }
                }
            }, 'Save Changes');
        },
        // Send a category's edits to a proposal (saveToProposal: the proposal's store, under its lock)
        async handleCategoryProposal(categoryTitle, store, name, isNew) {
            const items = proposalItemsFromStore(store);
            try {
                if (items.length > 0) await saveToProposal(name, categoryTitle, items);
            } catch (error) {
                this.$modal.alert(`Could not update the proposal: ${error.message}`, 'Error');
                return;
            }
            await store.load('Loading...');
            if (isNew && this.appContext?.navigateToPath) {
                this.appContext.navigateToPath(proposalPath(name));
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
                }
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
                :decorations="itemDecorations"
                :decoration-keys="itemDecorationKeys"
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

            <!-- inventory/<cat>/<segment>: wait for registered sub-routes before resolving -->
            <div v-else-if="isInventorySubPath && !categoryRoutesReady" class="loading-message">
                <img src="assets/loading.gif" alt="..."/>
                <p>Loading...</p>
            </div>

            <!-- Edit History Subpage: inventory/<cat>/edit-history -->
            <inventory-table
                ref="inventoryTable"
                v-else-if="isEditHistoryView && currentCategoryName"
                :key="'history:' + currentCategoryName"
                :container-path="containerPath"
                :inventory-name="'Edit History: ' + currentCategoryName.toLowerCase()"
                :tab-title="currentCategoryName"
                :history-mode="true"
            ></inventory-table>

            <!-- Item Timeline Subpage: inventory/<cat>/<item#> -->
            <inventory-item-timeline
                v-else-if="isInventorySubPath"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
            />

            <!-- Specific Category View -->
            <inventory-table
                ref="inventoryTable"
                v-else-if="containerPath.startsWith('inventory/') && currentCategoryName"
                :key="'table:' + currentCategoryName"
                :container-path="containerPath"
                :inventory-name="'Inventory: ' + currentCategoryName.toLowerCase()"
                :tab-title="currentCategoryName"
            ></inventory-table>
        </slot>
    `
};
