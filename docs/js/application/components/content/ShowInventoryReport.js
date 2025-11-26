import { html, TableComponent, Requests, getReactiveStore, createAnalysisConfig, NavigationRegistry, ItemImageComponent, SavedSearchSelect, parseDateSearchParameter, findMatchingStores, Priority, invalidateCache } from '../../index.js';

/**
 * Component for displaying inventory report across multiple shows
 * Shows: Item ID, Inventory Qty, quantities for each show, Remaining
 */
export const ShowInventoryReport = {
    components: { TableComponent, ItemImageComponent, SavedSearchSelect },
    inject: ['$modal'],
    props: {
        containerPath: { type: String, default: '' },
        navigateToPath: Function
    },
    data() {
        return {
            reportStore: null,
            inventoryCategoriesStore: null,
            itemCategoryFilter: undefined, // Optional filter for item categories
            showIdentifiers: [], // List of show IDs from search
            error: null,
            isLoadingShows: false, // Loading state for fetching shows before store creation
            showLoadingMessage: '', // Message for show loading phase
            scheduleStore: null, // Shared store for production schedule data
            NavigationRegistry // Make NavigationRegistry available in template
        };
    },
    computed: {
        // Dynamic table columns based on loaded shows
        tableColumns() {
            const baseColumns = [
                { 
                    key: 'image', 
                    label: 'IMG',
                    width: 1,
                },
                { key: 'itemId', label: 'Item#' },
                { key: 'description', label: 'Item Description', details: true },
                { key: 'available', label: 'Inv Qty.' },
            ];
            
            // Add remaining column with custom cellClass function (before show columns)
            const remainingColumn = {
                key: 'remaining',
                label: 'Remaining',
                format: 'number',
                columnClass: 'green',
                cellClass: (value, row) => {
                    // Compute remaining on the fly
                    const remaining = this.calculateRemaining(row);
                    if (remaining === null || remaining === undefined) return '';
                    if (remaining < 0) return 'red';
                    if (remaining < 5) return 'orange';
                    return '';
                }
            };
            
            // Add dynamic show columns (narrow width and narrow font)
            const showColumns = this.showIdentifiers.map((showId, index) => {
                // Remove year from display label and abbreviate
                // Format is typically "CLIENT YEAR SHOW", we want abbreviated "CLI... SHO..."
                let displayLabel = showId;
                
                // Match pattern: word(s) followed by 4-digit year followed by word(s)
                // Example: "ALLEN ARMS 2025 SHOT" -> "ALL... SHO..."
                const yearPattern = /^(.+?)\s+(\d{4})\s+(.+)$/;
                const match = showId.match(yearPattern);
                if (match) {
                    const clientPart = match[1];
                    const showPart = match[3];
                    
                    // Abbreviate if longer than 4 characters
                    const abbreviate = (text) => {
                        return text.length > 5 ? text.substring(0, 3) + '...' : text;
                    };
                    
                    displayLabel = `${abbreviate(clientPart)} ${abbreviate(showPart)}`;
                }
                
                return {
                    key: `show_${showId}`,
                    label: displayLabel,
                    title: showId, // Full identifier as tooltip
                    width: 1,
                    format: 'number',
                    font: 'narrow',
                    columnClass: 'striped gray', // Every other column gets gray background
                    allowHide: true // Enable hide button for show columns
                };
            });
            
            return [...baseColumns, remainingColumn, ...showColumns];
        },
        
        isLoading() {
            return this.isLoadingShows || this.reportStore?.isLoading || false;
        },
        
        isAnalyzing() {
            return this.reportStore?.isAnalyzing || false;
        },
        
        tableData() {
            return this.reportStore?.data || [];
        },
        
        loadingMessage() {
            if (this.isLoadingShows) {
                return this.showLoadingMessage;
            }
            return this.reportStore?.loadingMessage || 'Loading...';
        },

        // Navigation-based parameters from NavigationRegistry
        navParams() {
            return NavigationRegistry.getNavigationParameters(this.containerPath || 'inventory/reports/show-inventory');
        },

        // Get search term from URL parameters
        initialSearchTerm() {
            return this.navParams?.searchTerm || '';
        },
        initialItemCategoryFilter() {
            // Get item category filter from URL parameters as a single string in an array
            const filterParam = this.navParams?.itemCategoryFilter || null;
            if (filterParam) {
                return [filterParam];
            }
            return undefined;
        }
    },
    watch: {
        // watch for isLoading state of inventoryCategoriesStore to apply url filter
        'inventoryCategoriesStore.isLoading': {
            handler(isLoading, wasLoading) {
                // When loading completes (isLoading goes from true to false)
                if (wasLoading && !isLoading && this.inventoryCategoriesStore.data && this.inventoryCategoriesStore.data.length > 0) {
                    this.$nextTick(() => {
                        // ensure the select box changes
                        this.itemCategoryFilter = this.initialItemCategoryFilter;
                        this.initializeReportStore();
                    });
                }
            }
        }
    },
    methods: {
        async loadShowsFromSearch(searchData) {
            // Handle empty/null search - clear the report
            if (!searchData) {
                this.showIdentifiers = [];
                this.reportStore = null;
                this.error = null;
                this.isLoadingShows = false;
                return;
            }
            
            // Set loading state immediately when search starts
            this.isLoadingShows = true;
            this.showLoadingMessage = 'Finding shows...';
            this.error = null;
            this.reportStore = null; // Clear previous store
            
            // Parse search to get date filter and search params
            const filter = {};
            const searchParams = {};
            
            if (searchData.dateSearch) {
                const dateFilter = parseDateSearchParameter(searchData.dateSearch);
                
                // Check if this is an overlap search (has overlapShowIdentifier)
                if (dateFilter.overlapShowIdentifier) {
                    // Convert overlapShowIdentifier to identifier for API
                    filter.identifier = dateFilter.overlapShowIdentifier;
                } else {
                    // Regular date filter
                    Object.assign(filter, dateFilter);
                }
            }
            
            // Apply text filters
            if (searchData.textFilters && searchData.textFilters.length > 0) {
                searchData.textFilters.forEach(textFilter => {
                    if (textFilter.column && textFilter.value) {
                        searchParams[textFilter.column] = textFilter.value;
                    }
                });
            }
            
            try {
                // Try to find existing schedule store from ScheduleAdvancedSearch
                const existingStores = findMatchingStores(
                    Requests.getProductionScheduleData,
                    []
                );
                
                let shows;
                if (existingStores.length > 0 && existingStores[0].data && existingStores[0].data.length > 0) {
                    // Use cached data from existing store
                    console.log('[ShowInventoryReport] Using cached schedule data from existing store');
                    this.scheduleStore = existingStores[0];
                    
                    // Filter the cached data
                    shows = this.scheduleStore.data.filter(show => {
                        // Apply filter logic (this is simplified, you may need more complex filtering)
                        if (filter.identifier) {
                            return show.Identifier === filter.identifier;
                        }
                        // Add more filter logic as needed
                        return true;
                    });
                } else {
                    // No cached store or empty data, fetch directly
                    console.log('[ShowInventoryReport] No cached store available, fetching fresh data');
                    shows = await Requests.getProductionScheduleData(filter, searchParams);
                }
                
                // Update loading message for identifier computation phase
                this.showLoadingMessage = `Computing identifiers for ${shows.length} show${shows.length !== 1 ? 's' : ''}...`;
                
                // Extract identifiers from shows
                this.showIdentifiers = shows
                    .map(s => s.Identifier || null)
                    .filter(id => id);
                
                // If some shows don't have identifiers, compute them
                if (this.showIdentifiers.length < shows.length) {
                    const computedIdentifiers = await Promise.all(
                        shows.map(async (s) => {
                            if (s.Identifier) return s.Identifier;
                            // Compute identifier via API if not present
                            if (s.Show && s.Client && s.Year) {
                                return await Requests.computeIdentifier(s.Show, s.Client, parseInt(s.Year));
                            }
                            return null;
                        })
                    );
                    this.showIdentifiers = computedIdentifiers.filter(id => id);
                }
                
                console.log('[ShowInventoryReport] Loaded shows:', this.showIdentifiers);
                
                // Clear the loading state now that we have identifiers
                this.isLoadingShows = false;
                
                // Initialize report store with these shows
                if (this.showIdentifiers.length > 0) {
                    this.initializeReportStore();
                } else {
                    this.error = 'No shows found for the selected search criteria';
                }
            } catch (err) {
                console.error('[ShowInventoryReport] Error loading shows:', err);
                this.error = 'Failed to load shows: ' + err.message;
                this.isLoadingShows = false;
                this.$modal.error('Failed to load shows for the inventory report. Please check your search criteria and try again.', 'Show Load Error');
            }
        },

        initializeReportStore() {
            if (this.showIdentifiers.length === 0) return;
            
            // Build analysis config (only for tab name and inventory quantity)
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
                // Get inventory quantity
                createAnalysisConfig(
                    Requests.getItemInventoryQuantity,
                    'available',
                    'Getting inventory quantities...',
                    ['itemId'],
                    [],
                    'available'
                ),
                // Get item image URL
                createAnalysisConfig(
                    Requests.getItemImageUrl,
                    'imageUrl',
                    'Loading item images...',
                    ['itemId'],
                    [],
                    null, // Store in AppData, not a column
                    false,
                    Priority.BACKGROUND // Images are visual enhancements, lowest priority
                ),
                // get item description
                createAnalysisConfig(
                    Requests.getItemDescription,
                    'description',
                    'Loading item descriptions...',
                    ['itemId'],
                    [],
                    'description', // Store in description column
                    false,
                    Priority.BACKGROUND // Descriptions are visual enhancements, lowest priority
                )
            ];
            
            this.reportStore = getReactiveStore(
                Requests.getMultipleShowsItemsSummary,
                null,
                [this.showIdentifiers, this.itemCategoryFilter],
                analysisConfig,
                true // Auto-load
            );
            
            this.error = null;
        },

        // Calculate remaining quantity for a row
        calculateRemaining(row) {
            if (!row || row.available === null || row.available === undefined) {
                return null;
            }
            
            const totalUsed = Object.values(row.shows || {}).reduce(
                (sum, qty) => sum + (qty || 0), 
                0
            );
            
            return row.available - totalUsed;
        },

        async handleSearchSelected(searchData) {
            // Called when SavedSearchSelect emits search-selected event
            await this.loadShowsFromSearch(searchData);
        },

        async handleRefresh() {
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['PROD_SCHED','ProductionSchedule'] }, // Ensure schedule data is fresh, but don't refresh client and show ref data
                { namespace: 'database', methodName: 'getData', args: ['INVENTORY'] },
                { namespace: 'database', methodName: 'getData', args: ['PACK_LISTS'] },
                { namespace: 'database', methodName: 'getTabs', args: ['PACK_LISTS'] }
            ], true);
        }
    },
    mounted() {
        
        this.inventoryCategoriesStore = getReactiveStore(
            Requests.getAvailableTabs,
            null, // No save function
            ['INVENTORY'], // Arguments
            null // No analysis config
        );
        
        this.itemCategoryFilter = this.initialItemCategoryFilter;
    },
    template: html`
        <div :class="(tableColumns && tableColumns.length > 10) ? 'wide-table' : ''">
            <div v-if="error" class="error-message">
                <p>{{ error }}</p>
            </div>

            <TableComponent
                :data="tableData"
                :columns="tableColumns"
                :hide-columns="['tabName']"
                :show-search="true"
                :search-term="initialSearchTerm"
                :hide-rows-on-search="false"
                :readonly="true"
                :allowDetails="true"
                :is-loading="isLoading"
                :is-analyzing="isAnalyzing"
                :loading-message="loadingMessage"
                :loading-progress="reportStore && isAnalyzing ? reportStore.analysisProgress : -1"
                empty-message="Select a saved search to load shows and generate report"
                @refresh="handleRefresh"
            >
                <template #header-area>
                    <div class="button-bar">
                        <SavedSearchSelect
                            :container-path="containerPath || 'inventory/reports/show-inventory'"
                            :navigate-to-path="navigateToPath"
                            @search-selected="handleSearchSelected"
                        />
                        <span v-if="showIdentifiers.length > 0 || isLoading" class="card gray">
                            {{ showIdentifiers.length }} show{{ showIdentifiers.length !== 1 ? 's' : '' }} {{isLoading ? 'loading...' : 'loaded'}}
                        </span>
                        <select 
                            :value="itemCategoryFilter ? itemCategoryFilter[0] : ''" 
                            :disabled="inventoryCategoriesStore && inventoryCategoriesStore.isLoading"
                            @change="itemCategoryFilter = $event.target.value ? [$event.target.value] : undefined; initializeReportStore();"
                            >
                            <option v-for="category in inventoryCategoriesStore?.data || []" 
                                    v-show= "category.title != 'INDEX'"
                                    :key="category.title"
                                    :value="category.title"
                                    @click="itemCategoryFilter = [category.title]; initializeReportStore();">
                                {{ category.title }}
                            </option>
                            <option value="" @click="itemCategoryFilter = undefined; initializeReportStore();">
                                All Items
                            </option>
                        </select>
                    </div>
                </template>

                <template #default="{ row, column }">
                    <slot v-if="column.key === 'image'">
                        <ItemImageComponent 
                            :imageSize="48"
                            :itemNumber="row.itemId"
                            :imageUrl="row.AppData && row.AppData.imageUrl"
                        />
                    </slot>
                    <slot v-else-if="column.key === 'itemId'">
                        <button v-if="row.tabName" 
                                @click="navigateToPath(NavigationRegistry.buildPath('inventory/categories/' + row.tabName.toLowerCase(), { searchTerm: row.itemId }))"
                                class="purple"
                                :title="'Search for ' + row.itemId + ' in ' + row.tabName">
                            {{ row.itemId }}
                        </button>
                        <span v-else>{{ row.itemId }}</span>
                    </slot>
                    <slot v-else-if="column.key === 'remaining'">
                        {{ calculateRemaining(row) !== null ? calculateRemaining(row) : '—' }}
                    </slot>
                    <slot v-else-if="column.key.startsWith('show_')">
                        <span v-if="row.shows && row.shows[column.key.replace('show_', '')]">
                            {{ row.shows[column.key.replace('show_', '')] }}
                        </span>
                        <span v-else>—</span>
                    </slot>
                    <div v-else>
                        {{ row[column.key] !== null && row[column.key] !== undefined ? row[column.key] : '—' }}
                    </div>
                </template>
            </TableComponent>
        </div>
    `
};
