import { html, DataView, Requests, getReactiveStore, createAnalysisConfig, NavigationRegistry, ItemImageComponent, ScheduleFilterSelect, InventoryCategoryFilter, Priority, invalidateCache, toISODateString, todayISOString, offsetToISO } from '../../index.js';
import { textFiltersToSearchParams } from '../../../data_management/utils/helpers.js';
import { itemImageStyle } from '../../utils/views/viewStyles.js';

// What each report key is (calendarStart/End are derived ranges on a computed copy of the rows).
// image holds no data: the thumbnail column (see itemImageStyle).
const ITEM_REPORT_FIELDS = [
    { key: 'image', label: 'IMG' },
    { key: 'itemId', label: 'Item#', type: 'item' },
    { key: 'description', label: 'Description' },
    { key: 'startDate', label: 'Start', format: 'date', type: 'date' },
    { key: 'endDate', label: 'End', format: 'date', type: 'date' },
    { key: 'inventoryQty', label: 'Inv Qty', format: 'number', type: 'number' },
    { key: 'minQty', label: 'Min Qty', format: 'number', type: 'number' },
    { key: 'overlappingShows', label: 'Overlapping Shows' },
    { key: 'tabName', label: 'Category' },
    { key: 'calendarStart', label: 'Start', format: 'date', type: 'date' },
    { key: 'calendarEnd', label: 'End', format: 'date', type: 'date' }
];

// Rows show when their minimum quantity is below this; 0 shows only actual shortages
const DEFAULT_QTY_FILTER = 0;

// Item shortage report view registry (views-and-renderers-plan §4.3, §5)
const ITEM_REPORT_VIEWS = {
    id: 'item-shortages',
    default: 'table',
    theme: 'blue',
    // Shared by both views: the thumbnail; Item# is the primary action's button (the item page,
    // purple); Overlapping Shows is a list of show buttons (two inline, more in a modal)
    sortable: ['itemId', 'description', 'startDate', 'endDate', 'inventoryQty', 'minQty'],
    style: {
        image: itemImageStyle('itemId'),
        itemId: { cell: 'action', cellOptions: { class: 'purple' } },
        overlappingShows: { cell: 'showList', cellOptions: { max: 2, to: 'packlist/{value}' } }
    },
    views: [
        {
            id: 'table',
            name: 'Report',
            icon: 'table',
            layout: 'table',
            columns: ['image', 'itemId', 'startDate', 'endDate', 'inventoryQty', 'minQty', 'overlappingShows'],
            hidden: ['tabName', 'calendarStart', 'calendarEnd'],
            style: {
                minQty: { color: 'auto' },
                overlappingShows: { columnColor: 'gray' }
            },
            table: { sticky: { start: ['image'] }, hideRowsOnSearch: false },
            // Printing lists every show (never the "N shows" button)
            variants: { print: { style: { overlappingShows: { cellOptions: { max: null } } } } }
        },
        {
            id: 'calendar',
            name: 'Calendar',
            icon: 'calendar_month',
            layout: 'calendar',
            // Item# and the shows summary ("N shows", always the modal) in the chip's end button bar
            calendar: { start: 'calendarStart', end: 'calendarEnd', chip: [['minQty', 'description']], actions: ['itemId', 'overlappingShows'] },
            hidden: ['tabName', 'calendarStart', 'calendarEnd', 'image'],
            style: { overlappingShows: { cellOptions: { max: 0 } } },
            rowColor: { field: 'minQty', rule: 'auto', fallback: 'green' }
        }
    ]
};

/**
 * Item-centric inventory report.
 * For a filtered date range, shows each item once with:
 *   item# | description | startDate | endDate | Inv Qty | Min Qty | Overlapping Shows
 */
export const InventoryItemReport = {
    components: { DataView, ItemImageComponent, ScheduleFilterSelect, InventoryCategoryFilter },
    inject: ['$modal', 'appContext'],
    props: {
        containerPath: { type: String, default: '' },
        navigateToPath: Function
    },
    data() {
        return {
            reportStore: null,
            referenceDate: null,
            ctgFilter: null,
            searchFilter: null,
            searchParams: null,
            error: null,
            endDate: null,
            qtyFilter: DEFAULT_QTY_FILTER,
            hasPerformedInitialSync: false,
            isPrinting: false,
            ITEM_REPORT_FIELDS,
            ITEM_REPORT_VIEWS,
            NavigationRegistry
        };
    },
    computed: {
        isLoading() {
            return this.reportStore?.isLoading || false;
        },

        isAnalyzing() {
            return this.reportStore?.isAnalyzing || false;
        },

        tableData() {
            const rawData = (this.reportStore?.data || [])
                .map(row => ({
                    ...row,
                    overlappingShows: row.shows ? Object.keys(row.shows).filter(k => (row.shows[k] || 0) > 0) : []
                }))
                .filter(row => {
                    if (row.minQty === null || row.minQty === undefined) return true;
                    return row.minQty < this.qtyFilter;
                });

            // Group items by itemId to find items with multiple shortage periods
            // Only group items that have actual shortage periods (startDate is not null)
            const itemGroups = new Map();
            for (const row of rawData) {
                // Skip grouping for rows without shortage periods (no startDate)
                if (!row.startDate) {
                    continue; // These rows won't appear in calendar view anyway
                }
                
                if (!itemGroups.has(row.itemId)) {
                    itemGroups.set(row.itemId, []);
                }
                itemGroups.get(row.itemId).push(row);
            }

            const result = [];
            
            // Add ungrouped rows (those without startDate)
            for (const row of rawData) {
                if (!row.startDate) {
                    result.push(row);
                }
            }
            
            // Add grouped rows
            for (const [itemId, rows] of itemGroups) {
                if (rows.length === 1) {
                    // Single shortage period - no grouping needed
                    result.push(rows[0]);
                } else {
                    // Multiple shortage periods - create group master and members
                    const groupId = `shortage-${itemId}-${Date.now()}`;
                    
                    // Calculate summary values for the group master
                    const allDates = rows
                        .flatMap(r => [r.startDate, r.endDate].filter(d => d))
                        .sort();
                    const overallStart = allDates[0] || null;
                    const overallEnd = allDates[allDates.length - 1] || null;
                    const lowestMinQty = Math.min(...rows.map(r => r.minQty ?? Infinity));
                    
                    // Combine all shows from all periods (union of all show keys)
                    const combinedShows = {};
                    rows.forEach(r => {
                        if (r.shows) {
                            Object.entries(r.shows).forEach(([showId, qty]) => {
                                if (qty > 0) {
                                    combinedShows[showId] = qty;
                                }
                            });
                        }
                    });
                    
                    // Calculate overlapping shows from combined shows
                    const allOverlappingShows = Object.keys(combinedShows);

                    // Create group master row
                    const masterRow = {
                        ...rows[0], // Use first row as template
                        startDate: overallStart,
                        endDate: overallEnd,
                        minQty: lowestMinQty === Infinity ? null : lowestMinQty,
                        shows: combinedShows,
                        overlappingShows: allOverlappingShows,
                        metadata: JSON.stringify({ grouping: { groupId, isGroupMaster: true } })
                    };
                    result.push(masterRow);

                    // Add original rows as group members, preserving any existing metadata
                    rows.forEach(row => {
                        let existingMeta = {};
                        try {
                            existingMeta = JSON.parse(row.metadata || '{}');
                        } catch (e) {}
                        
                        result.push({
                            ...row,
                            metadata: JSON.stringify({
                                ...existingMeta,
                                grouping: { groupId, isGroupMaster: false }
                            })
                        });
                    });
                }
            }

            // Derived calendar range on a computed copy: rows without dates span the report range
            let reportStart = null;
            let reportEnd = null;
            for (const row of result) {
                if (row.startDate) {
                    if (!reportStart || row.startDate < reportStart) reportStart = row.startDate;
                    if (!reportEnd || (row.endDate && row.endDate > reportEnd)) reportEnd = row.endDate || row.startDate;
                }
            }
            if (reportStart && !reportEnd) reportEnd = reportStart;
            return result.map(row => ({
                ...row,
                calendarStart: row.startDate || reportStart,
                calendarEnd: row.endDate || row.startDate || reportEnd
            }));
        },

        // Primary action: the item page, drawn as the Item# button (action cell) in both views
        reportAction() {
            return {
                to: (row) => this.itemPagePath(row),
                disabled: (row) => !row.tabName || !row.itemId,
                title: 'View item timeline'
            };
        },

        loadingMessage() {
            if (this.reportStore?.isAnalyzing) return this.reportStore.analysisMessage || 'Analyzing...';
            return this.reportStore?.loadingMessage || 'Loading...';
        },

        loadingProgress() {
            if (!this.reportStore) return -1;
            if (this.isLoading) return this.reportStore.loadingProgress ?? -1;
            if (this.isAnalyzing) return this.reportStore.analysisProgress;
            return -1;
        },

        emptyMessage() {
            const params = NavigationRegistry.getParametersForContainer(
                this.containerPath || 'reports/item-shortages',
                this.appContext?.currentPath
            );
            const hasSearchParams = params && (params.dateFilters || params.textFilters || params.dateFilter);

            if (hasSearchParams && !this.reportStore && !this.isLoading) {
                return 'No packlists found for the selected search criteria';
            }
            if (this.reportStore && !this.isLoading && !this.isAnalyzing && this.tableData.length === 0 && this.ctgFilter) {
                return 'No items were found in this category.';
            }
            if (this.reportStore && !this.isLoading && !this.isAnalyzing && this.tableData.length === 0) {
                return 'No items found for the selected search criteria.';
            }
            return 'Select a schedule filter to load shows and generate report';
        }
    },
    watch: {
        // Watch for URL parameter changes
        'appContext.currentPath': {
            handler(newPath, oldPath) {
                // Skip initial load (handled by mounted)
                if (!oldPath) return;
                
                // Get params for both paths
                const newParams = NavigationRegistry.getParametersForContainer(
                    this.containerPath || 'reports/item-shortages',
                    newPath
                );
                const oldParams = NavigationRegistry.getParametersForContainer(
                    this.containerPath || 'reports/item-shortages',
                    oldPath
                );
                
                // Skip if params haven't actually changed
                if (JSON.stringify(newParams) === JSON.stringify(oldParams)) return;
                
                this.syncWithURL();
            },
            deep: true
        }
    },
    methods: {
        async loadShowsFromSearch(searchData) {
            if (!searchData) {
                this.searchFilter = null;
                this.searchParams = null;
                this.reportStore = null;
                this.error = null;
                return;
            }

            const filter = {};
            const searchParams = {};

            if (searchData.dateFilters && searchData.dateFilters.length > 0) {
                filter.dateFilters = searchData.dateFilters;
            }

            let resolvedStart = searchData?.startDate ?? null;
            let resolvedEnd   = searchData?.endDate   ?? null;
            if (!resolvedStart || !resolvedEnd) {
                const shipAfterFilter  = searchData.dateFilters?.find(f => f.column === 'Ship' && f.type === 'after');
                const shipBeforeFilter = searchData.dateFilters?.find(f => f.column === 'Ship' && f.type === 'before');
                if (!resolvedStart) resolvedStart = offsetToISO(shipAfterFilter?.value);
                if (!resolvedEnd)   resolvedEnd   = offsetToISO(shipBeforeFilter?.value);
            }
            this.referenceDate = resolvedStart ?? todayISOString();
            this.endDate = resolvedEnd ?? null;

            // Apply text filters (filters on the same column are kept together and OR'd)
            Object.assign(searchParams, textFiltersToSearchParams(searchData.textFilters));

            this.searchFilter = filter;
            this.searchParams = searchParams;

            try {
                this.initializeReportStore();
            } catch (err) {
                console.error('[InventoryItemReport] Error initializing report:', err);
                this.error = 'Failed to load report: ' + err.message;
            }
        },

        initializeReportStore() {
            if (!this.searchFilter && !this.searchParams) return;

            const analysisConfig = [
                createAnalysisConfig(
                    Requests.getItemInventoryQuantity,
                    'inventoryQty',
                    'Loading inventory quantities...',
                    ['itemId'],
                    [this.referenceDate],
                    'inventoryQty',
                    false,
                    Priority.USER_ACTION
                ),
                createAnalysisConfig(
                    Requests.getTabNameForItem,
                    'tabName',
                    'Getting inventory tab names...',
                    ['itemId'],
                    [],
                    'tabName',
                    false,
                    Priority.USER_ACTION
                ),
                createAnalysisConfig(
                    Requests.getItemDescription,
                    'description',
                    'Loading item descriptions...',
                    ['itemId'],
                    [this.referenceDate],
                    'description',
                    false,
                    Priority.BACKGROUND,
                    undefined,
                    false
                )
            ];

            this.reportStore = getReactiveStore(
                Requests.getMultipleShowsItemsSummary,
                null,
                [this.searchFilter, this.searchParams, this.ctgFilter, false],
                analysisConfig,
                true
            );

            this.error = null;
        },

        async handleSearchSelected(searchData) {
            await this.loadShowsFromSearch(searchData);
        },

        async handleRefresh() {
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['PROD_SCHED', 'Production Schedule'] },
                { namespace: 'database', methodName: 'getData', args: ['INVENTORY'] },
                { namespace: 'database', methodName: 'getData', args: ['PACK_LISTS'] },
                { namespace: 'database', methodName: 'getTabs', args: ['PACK_LISTS'] }
            ]);
            this.reportStore = null;
            this.initializeReportStore();
        },

        itemPagePath(row) {
            if (!row.tabName || !row.itemId) return null;
            const basePath = `inventory/${row.tabName.toLowerCase()}/${row.itemId}`;
            const dateFilters = (row.startDate || row.endDate)
                ? [
                    ...(row.startDate ? [{ column: 'Date', value: row.startDate, type: 'after'  }] : []),
                    ...(row.endDate   ? [{ column: 'Date', value: row.endDate,   type: 'before' }] : [])
                  ]
                : null;
            return dateFilters
                ? NavigationRegistry.buildPath(basePath, { dateFilters })
                : basePath;
        },

        navigateToItemPage(row) {
            const path = this.itemPagePath(row);
            if (path) this.navigateToPath(path);
        },

        handleCategorySelected(categoryName) {
            this.ctgFilter = categoryName || null;
            if (this.searchFilter || this.searchParams) {
                this.initializeReportStore();
            }
        },

        handleMinThresholdChange(event) {
            const value = parseInt(event.target.value, 10);
            if (!isNaN(value)) {
                this.qtyFilter = value;
                this.updateURL(value);
            }
        },

        updateURL(threshold) {
            const cleanPath = (this.containerPath || 'reports/item-shortages').split('?')[0];
            const isOnDashboard = this.appContext?.currentPath?.split('?')[0].split('/')[0] === 'dashboard';
            
            // Build new path with qtyFilter parameter
            const newPath = NavigationRegistry.buildPathWithCurrentParams(
                cleanPath,
                this.appContext?.currentPath,
                {
                    qtyFilter: threshold !== DEFAULT_QTY_FILTER ? threshold : undefined // undefined removes the parameter when it's the default
                }
            );
            
            if (isOnDashboard) {
                // Update dashboard registry with new path
                NavigationRegistry.dashboardRegistry.updatePath(
                    cleanPath,
                    newPath
                );
            } else if (this.navigateToPath) {
                this.navigateToPath(newPath);
            }
        },

        syncWithURL() {
            const params = NavigationRegistry.getParametersForContainer(
                this.containerPath || 'reports/item-shortages',
                this.appContext?.currentPath
            );
            
            // Get qtyFilter from URL params (default if not present)
            const thresholdFromUrl = params?.qtyFilter !== undefined ? parseInt(params.qtyFilter, 10) : DEFAULT_QTY_FILTER;
            
            // Update threshold value
            if (!isNaN(thresholdFromUrl)) {
                this.qtyFilter = thresholdFromUrl;
            }
        },

        async handlePrint() {
            // If not on the item shortage report page, navigate to it first
            if (this.navigateToPath) {
                this.navigateToPath(this.containerPath || 'reports/item-shortages');
            }

            this.isPrinting = true;

            // Wait for DOM update
            await this.$nextTick();
            
            // Print
            window.print();
            
            // Restore state after printing
            setTimeout(() => {
                this.isPrinting = false;
            }, 100);
        },

    },
    mounted() {
        const params = NavigationRegistry.getParametersForContainer(
            this.containerPath || 'reports/item-shortages',
            this.appContext?.currentPath
        );
        //console.log('[InventoryItemReport] Initial URL parameters:', params);
        //console.log('[InventoryItemReport] Waiting for child components to sync with URL...');
        
        // Perform initial sync with URL
        this.hasPerformedInitialSync = true;
        this.syncWithURL();
    },
    template: html`
        <div>
            <!-- Print-only Header -->
            <div class="print-header">
                <img src="assets/logo.png" alt="Top Shelf Exhibits Logo" class="print-logo" />
                <h1>Item Shortage Report</h1>
                <span class="page-number"></span>
            </div>

            <div v-if="error" class="card red">
                <p>{{ error }}</p>
            </div>

            <DataView
                :fields="ITEM_REPORT_FIELDS"
                :rows="tableData"
                :registry="ITEM_REPORT_VIEWS"
                :container-path="containerPath || 'reports/item-shortages'"
                :navigate-to-path="navigateToPath"
                :action="reportAction"
                :printing="isPrinting"
                :hide-group-members="false"
                :show-search="true"
                :sync-search-with-url="true"
                :show-refresh="true"
                :is-loading="isLoading"
                :is-analyzing="isAnalyzing"
                :loading-message="loadingMessage"
                :loading-progress="loadingProgress"
                :empty-message="emptyMessage"
                @refresh="handleRefresh"
            >
                <template #header-area>
                    <div class="button-bar">
                        <ScheduleFilterSelect
                            :container-path="containerPath || 'reports/item-shortages'"
                            :navigate-to-path="navigateToPath"
                            :show-advanced-button="true"
                            :default-search="null"
                            @search-selected="handleSearchSelected"
                        />
                        <InventoryCategoryFilter
                            :container-path="containerPath || 'reports/item-shortages'"
                            :navigate-to-path="navigateToPath"
                            @category-selected="handleCategorySelected"
                        />
                        <input type="number" :title="'Show items with less than ' + qtyFilter + ' remaining'" :value="qtyFilter" @change="handleMinThresholdChange" style="width:60px" />
                        <button @click="handlePrint" :disabled="isLoading || isAnalyzing" class="button-symbol white" title="Print Item Shortage Report">
                            <span class="material-symbols-outlined">print</span>
                        </button>
                    </div>
                </template>
            </DataView>
        </div>
    `
};
