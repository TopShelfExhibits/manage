import { html, DataView, Requests, getReactiveStore, createAnalysisConfig, NavigationRegistry, ItemImageComponent, ScheduleFilterSelect, InventoryCategoryFilter, Priority, invalidateCache, toISODateString, todayISOString, offsetToISO, getAutoColorClass } from '../../index.js';
import { textFiltersToSearchParams } from '../../../data_management/utils/helpers.js';

/**
 * Component for displaying inventory report across multiple shows
 * Shows: Item ID, Inventory Qty, quantities for each show, Remaining
 */
export const ShowInventoryReport = {
    components: { DataView, ItemImageComponent, ScheduleFilterSelect, InventoryCategoryFilter },
    inject: ['$modal', 'appContext'],
    props: {
        containerPath: { type: String, default: 'reports/show-usage' },
        navigateToPath: Function
    },
    data() {
        return {
            reportStore: null,
            referenceDate: null, // ISO date derived from the active schedule filter (start)
            endDate: null, // ISO date derived from the active schedule filter (end)
            ctgFilter: null, // Optional filter for item categories (string or null)
            searchFilter: null, // Schedule filter parameters
            searchParams: null, // Text search parameters
            includeEmptyShows: true, // Include shows with no packlist or no matching items
            error: null,
            NavigationRegistry // Make NavigationRegistry available in template
        };
    },
    computed: {
        // Extract show identifiers from the report data
        showIdentifiers() {
            if (!this.reportStore?.data || this.reportStore.data.length === 0) {
                return [];
            }
            // Collect show IDs from all rows - each item may appear in different shows
            const showSet = new Set();
            for (const row of this.reportStore.data) {
                if (row.shows) {
                    Object.keys(row.shows).forEach(id => showSet.add(id));
                }
            }
            return Array.from(showSet).sort();
        },

        // What each report key is; show columns are dynamic (show_<identifier>)
        reportFields() {
            const fields = [
                { key: 'image', labelHtml: '<span class="material-symbols-outlined">imagesmode</span>', label: 'IMG', sortable: false, cell: 'image', cellOptions: { itemKey: 'itemId', size: 48 } },
                { key: 'itemId', label: 'Item#', type: 'item', sortable: true, cell: 'slot' },
                { key: 'description', label: 'Item Description', type: 'item', sortable: true },
                { key: 'available', label: 'Inv Qty.', sortable: true },
                { key: 'minQty', label: 'Min Qty', format: 'number', type: 'number', sortable: true },
                { key: 'tabName', label: 'Category' }
            ];
            // Show columns: abbreviated "CLI... SHO..." label, full identifier as the tooltip
            const abbreviate = (text) => text.length > 5 ? text.substring(0, 3) + '...' : text;
            for (const showId of this.showIdentifiers) {
                const match = showId.match(/^(.+?)\s+(\d{4})\s+(.+)$/);
                const label = match ? `${abbreviate(match[1])} ${abbreviate(match[3])}` : showId;
                fields.push({ key: `show_${showId}`, label, title: showId, format: 'number', type: 'number', sortable: true, cell: 'slot' });
            }
            return fields;
        },
        // Show usage report view (views-and-renderers-plan §5, Phase 4). The per-column hide
        // button (allowHide) is removed: show columns can't be hidden per run until customization exists.
        reportRegistry() {
            return {
                id: 'show-usage',
                default: 'table',
                theme: 'blue',
                views: [{
                    id: 'table',
                    name: 'Show Usage',
                    layout: 'table',
                    columns: ['image', 'itemId', 'available', 'minQty', 'show_*'],
                    details: ['description'],
                    hidden: ['tabName'],
                    style: {
                        image: { width: 1 },
                        minQty: { color: 'auto' },
                        'show_*': { width: 1, font: 'narrow', columnColor: 'striped gray' }
                    },
                    table: { sticky: { start: ['image'] }, hideRowsOnSearch: false }
                }]
            };
        },
        // Kept for the wide-table layout class
        tableColumns() {
            return this.reportFields;
        },

        isLoading() {
            return this.reportStore?.isLoading || false;
        },

        isAnalyzing() {
            return this.reportStore?.isAnalyzing || false;
        },

        tableData() {
            const data = this.reportStore?.data || [];
            // Enhance each row with computed remaining value and flattened show data for sorting
            return data.map(row => {
                const enhancedRow = {
                    ...row,
                    minQty: row.minQty ?? null
                };

                // Flatten show data for sorting - add show quantities as direct properties
                if (row.shows) {
                    this.showIdentifiers.forEach(showId => {
                        const showValue = row.shows[showId];
                        // Only set the value if it exists and is not null/undefined
                        // This allows proper sorting while maintaining dashes for display
                        enhancedRow[`show_${showId}`] = (showValue !== null && showValue !== undefined) ? showValue : null;
                    });
                }

                return enhancedRow;
            });
        },

        loadingMessage() {
            return this.reportStore?.loadingMessage || 'Loading...';
        },

        emptyMessage() {
            // Check if a search has been performed by looking at URL parameters
            const params = NavigationRegistry.getParametersForContainer(
                this.containerPath || 'reports/show-usage',
                this.appContext?.currentPath
            );
            const hasSearchParams = params && (params.dateFilters || params.textFilters || params.dateFilter);

            // If we have search params but no report store yet, it means no shows were found
            if (hasSearchParams && !this.reportStore && !this.isLoading) {
                return 'No packlists found for the selected search criteria';
            }

            // If the store loaded but found no data and no category filter is active, the schedule filter yielded no results
            if (this.reportStore && !this.isLoading && !this.isAnalyzing && this.showIdentifiers.length === 0 && !this.ctgFilter) {
                return 'No packlists found for the selected search criteria';
            }

            // If the store loaded but found no items and a category filter is active, the category has no items
            if (this.reportStore && !this.isLoading && !this.isAnalyzing && this.tableData.length === 0 && this.ctgFilter) {
                return 'No items were found in this category.';
            }

            // If we have shows selected but no items in the data, it means the category has no items
            if (this.showIdentifiers.length > 0 && this.tableData.length === 0 && !this.isLoading && !this.isAnalyzing) {
                return 'No items were found in this category.';
            }

            return 'Select a schedule filter to load shows and generate report';
        }
    },
    watch: {
    },
    methods: {
        async loadShowsFromSearch(searchData) {
            // Handle empty/null search - clear the report
            if (!searchData) {
                this.searchFilter = null;
                this.searchParams = null;
                this.reportStore = null;
                this.error = null;
                return;
            }

            // Build filter and search params from search data (let API handle show finding)
            const filter = {};
            const searchParams = {};

            if (searchData.dateFilters && searchData.dateFilters.length > 0) {
                filter.dateFilters = searchData.dateFilters;
            }

            // Mirror InventoryItemTimeline: read top-level resolved dates first, then fall back
            // to dateFilters. ScheduleFilterSelect resolves 'Date' column filters into
            // top-level startDate/endDate; Ship-column filters must be resolved here manually.
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

            // Store search params and initialize report store
            this.searchFilter = filter;
            this.searchParams = searchParams;

            try {
                this.initializeReportStore();
            } catch (err) {
                console.error('[ShowInventoryReport] Error initializing report:', err);
                this.error = 'Failed to load report: ' + err.message;
                this.$modal.error('Failed to load the inventory report. Please check your search criteria and try again.', 'Report Load Error');
            }
        },

        initializeReportStore() {
            //console.log('[ShowInventoryReport] initializeReportStore called', {
            //    searchFilter: this.searchFilter,
            //    searchParams: this.searchParams,
            //    ctgFilter: this.ctgFilter
            //});

            if (!this.searchFilter && !this.searchParams) {
                //console.log('[ShowInventoryReport] Skipping store initialization - no search parameters');
                return;
            }

            // Build analysis config
            const analysisConfig = [
                // Get inventory tab name for each item
                createAnalysisConfig(
                    Requests.getTabNameForItem,
                    'tabName',
                    'Getting inventory tab names...',
                    ['itemId'],
                    [],
                    'tabName',
                    false,
                    Priority.USER_ACTION // Used for navigation buttons
                ),
                // Get inventory quantity as of the report's start date
                createAnalysisConfig(
                    Requests.getItemInventoryQuantity,
                    'available',
                    'Getting inventory quantities...',
                    ['itemId'],
                    [this.referenceDate],
                    'available'
                ),
                // get item description as of the report's start date
                createAnalysisConfig(
                    Requests.getItemDescription,
                    'description',
                    'Loading item descriptions...',
                    ['itemId'],
                    [this.referenceDate],
                    'description', // Store in description column
                    false,
                    Priority.BACKGROUND // Descriptions are visual enhancements, lowest priority
                )
            ];

            this.reportStore = getReactiveStore(
                Requests.getMultipleShowsItemsSummary,
                null,
                [this.searchFilter, this.searchParams, this.ctgFilter, this.includeEmptyShows],
                analysisConfig,
                true // Auto-load
            );

            this.error = null;
        },

        async handleSearchSelected(searchData) {
            // Called when ScheduleFilterSelect emits search-selected event
            //console.log('[ShowInventoryReport] handleSearchSelected called with:', searchData);
            await this.loadShowsFromSearch(searchData);
        },

        async handleRefresh() {
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['PROD_SCHED','Production Schedule'] }, // Ensure schedule data is fresh, but don't refresh client and show ref data
                { namespace: 'database', methodName: 'getData', args: ['INVENTORY'] },
                { namespace: 'database', methodName: 'getData', args: ['PACK_LISTS'] },
                { namespace: 'database', methodName: 'getTabs', args: ['PACK_LISTS'] }
            ], true);
        },

        navigateToItemPage(row) {
            if (!row.tabName || !row.itemId) return;
            const basePath = `inventory/${row.tabName.toLowerCase()}/${row.itemId}`;
            const dateFilters = this.referenceDate
                ? [
                    { column: 'Date', value: this.referenceDate, type: 'after' },
                    ...(this.endDate ? [{ column: 'Date', value: this.endDate, type: 'before' }] : [])
                  ]
                : null;
            const finalPath = dateFilters
                ? NavigationRegistry.buildPath(basePath, { dateFilters })
                : basePath;
            this.navigateToPath(finalPath);
        },

        handleCategorySelected(categoryName) {
            //console.log('[ShowInventoryReport] handleCategorySelected called with:', categoryName);
            //console.log('[ShowInventoryReport] Current state:', {
            //     searchFilter: this.searchFilter,
            //     searchParams: this.searchParams,
            //     ctgFilter: this.ctgFilter,
            //     hasReportStore: !!this.reportStore
            // });

            // Update filter and reinitialize store
            this.ctgFilter = categoryName;
            //console.log('[ShowInventoryReport] Calling initializeReportStore()');
            this.initializeReportStore();
        }
    },
    mounted() {
        //console.log('[ShowInventoryReport] Component mounted', {
        //    containerPath: this.containerPath,
        //    currentPath: this.appContext?.currentPath
        //});

        // Get URL parameters to check what should be initialized
        const params = NavigationRegistry.getParametersForContainer(
            this.containerPath || 'reports/show-usage',
            this.appContext?.currentPath
        );

        //console.log('[ShowInventoryReport] Initial URL parameters:', params);
        //console.log('[ShowInventoryReport] Waiting for child components (ScheduleFilterSelect and InventoryCategoryFilter) to sync with URL and emit events...');
    },
    template: html`
        <div :class="(tableColumns && tableColumns.length > 10) ? 'wide-table' : ''">
            <div v-if="error" class="card red">
                <p>{{ error }}</p>
            </div>

            <DataView
                :fields="reportFields"
                :rows="tableData"
                :registry="reportRegistry"
                :show-search="true"
                :sync-search-with-url="true"
                :container-path="containerPath || 'reports/show-usage'"
                :navigate-to-path="navigateToPath"
                :is-loading="isLoading"
                :is-analyzing="isAnalyzing"
                :loading-message="loadingMessage"
                :loading-progress="reportStore && isAnalyzing ? reportStore.analysisProgress : -1"
                :empty-message="emptyMessage"
                @refresh="handleRefresh"
            >
                <template #header-area>
                    <div class="button-bar">
                        <ScheduleFilterSelect
                            :container-path="containerPath || 'reports/show-usage'"
                            :navigate-to-path="navigateToPath"
                            :show-advanced-button="true"
                            :default-search="null"
                            @search-selected="handleSearchSelected"
                        />
                        <InventoryCategoryFilter
                            :container-path="containerPath || 'reports/show-usage'"
                            :navigate-to-path="navigateToPath"
                            @category-selected="handleCategorySelected"
                        />
                    </div>
                </template>

                <!-- Page cells (field.cell = 'slot'); every other field uses the formatted fallback -->
                <template #cell="{ row, field: column }">
                    <slot v-if="column.key === 'itemId'">
                        <button v-if="row.tabName"
                                @click="navigateToItemPage(row)"
                                class="purple card"
                                :title="'View timeline for ' + row.itemId">
                            {{ row.itemId }}
                        </button>
                        <span v-else>{{ row.itemId }}</span>
                    </slot>
                    <slot v-else-if="column.key.startsWith('show_')">
                        <span v-if="row[column.key] !== undefined && row[column.key] !== null && row[column.key] !== 0">
                            {{ row[column.key] }}
                        </span>
                        <span v-else>—</span>
                    </slot>
                </template>
            </DataView>
        </div>
    `
};
