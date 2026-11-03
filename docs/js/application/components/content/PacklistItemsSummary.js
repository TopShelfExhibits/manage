import { html, DataView, Requests, getReactiveStore, createAnalysisConfig, NavigationRegistry, ItemImageComponent, InventoryCategoryFilter, Priority, invalidateCache, todayISOString, OverlappingShowsModal } from '../../index.js';
import { itemImageStyle } from '../../utils/views/viewStyles.js';

// What each summary key is. image holds no data: the thumbnail column (see itemImageStyle).
const SUMMARY_FIELDS = [
    { key: 'image', label: 'IMG' },
    { key: 'itemId', label: 'Item#', type: 'item' },
    { key: 'quantity', label: 'Quantity' },
    { key: 'available', label: 'Inv. Qty.' },
    { key: 'tabName', label: 'Tab' },
    { key: 'remaining', label: 'Remaining', format: 'number', type: 'number' },
    { key: 'overlappingShows', label: 'Overlapping Shows' }
];

// Packlist items summary view (views-and-renderers-plan §5, Phase 4)
const SUMMARY_VIEWS = {
    id: 'packlist-items-summary',
    default: 'table',
    theme: '',
    views: [{
        id: 'table',
        name: 'Items',
        layout: 'table',
        columns: ['image', 'itemId', 'quantity', 'available', 'remaining', 'overlappingShows'],
        hidden: ['tabName'],
        sortable: ['itemId', 'quantity', 'available', 'tabName', 'remaining'],
        // The page draws Item# and Overlapping Shows (#cell)
        style: {
            image: itemImageStyle('itemId'),
            itemId: { cell: 'slot' },
            remaining: { color: 'auto' },
            overlappingShows: { cell: 'slot', columnColor: 'gray' }
        },
        table: { sticky: { start: ['image'] }, hideRowsOnSearch: false }
    }]
};

/**
 * Component for displaying item quantities summary with progressive analysis
 * Shows: Item ID, Quantity, Available, Remaining, Overlapping Shows
 */
export const PacklistItemsSummary = {
    components: { DataView, ItemImageComponent, InventoryCategoryFilter, OverlappingShowsModal },
    props: {
        projectIdentifier: { type: String, required: true },
        containerPath: { type: String, default: '' },
        showDetailsVisible: {
            type: Array,
            default: () => ['Ship', 'S. Start', 'S. End', 'Recieved', 'City', 'Size', 'Booth#', 'S/U IN SHOP']
        }
    },
    inject: ['appContext', '$modal'],
    data() {
        return {
            itemsSummaryStore: null,
            showDetails: null, // Production schedule show details
            projectShipDate: null,
            projectReturnDate: null,
            error: null,
            selectedCategoryFilter: null, // Filter by inventory category
            NavigationRegistry, // Make NavigationRegistry available in template
            SUMMARY_FIELDS,
            SUMMARY_VIEWS
        };
    },
    computed: {
        isLoading() {
            return this.itemsSummaryStore ? this.itemsSummaryStore.isLoading : false;
        },
        tableData() {
            const data = this.itemsSummaryStore ? this.itemsSummaryStore.data : [];

            // Apply category filter if selected
            if (this.selectedCategoryFilter) {
                return data.filter(item => item.tabName === this.selectedCategoryFilter);
            }

            return data;
        },

        currentSearchText() {
            const params = NavigationRegistry.getParametersForContainer(
                this.containerPath || ('packlist/' + this.projectIdentifier + '/details'),
                this.appContext?.currentPath
            );
            return params?.searchText || '';
        }
    },
    watch: {
        projectIdentifier: {
            immediate: true,
            handler(newProjectId) {
                if (newProjectId) {
                    this.initializeStore();
                    this.loadShowDetails();
                }
            }
        }
    },
    methods: {
        async initializeStore() {
            if (!this.projectIdentifier) return;

            // Fetch ship/return dates so inventory quantities reflect state at time of packing
            const [shipDate, returnDate] = await Promise.all([
                Requests.getProjectShipDate(this.projectIdentifier),
                Requests.getProjectReturnDate(this.projectIdentifier)
            ]);
            this.projectShipDate = shipDate || null;
            this.projectReturnDate = returnDate || null;
            const referenceDate = shipDate || todayISOString();

            const analysisConfig = [
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
                createAnalysisConfig(
                    Requests.getItemInventoryQuantity,
                    'available',
                    'Checking inventory quantities...',
                    ['itemId'],
                    [referenceDate],
                    'available'
                ),
                createAnalysisConfig(
                    (itemId, currentProjectId) => Requests.getItemOverlappingPacklists(currentProjectId, itemId),
                    'overlappingShows',
                    'Finding overlapping shows...',
                    ['itemId'],
                    [this.projectIdentifier],
                    'overlappingShows',
                    false,
                    Priority.USER_ACTION // Used for navigation buttons
                ),
                createAnalysisConfig(
                    Requests.getItemMinQuantityInRange,
                    'remaining',
                    'Calculating remaining quantities...',
                    ['itemId'],
                    [this.projectShipDate, this.projectReturnDate],
                    'remaining'
                )
            ];

            this.itemsSummaryStore = getReactiveStore(
                Requests.getItemQuantitiesSummary,
                null,
                [this.projectIdentifier],
                analysisConfig
            );

            this.error = this.itemsSummaryStore.error;
        },

        async handleRefresh() {
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['PACK_LISTS', this.projectIdentifier] }
            ], true);
        },

        navigateToItemPage(row) {
            if (!row.tabName || !row.itemId) return;
            const basePath = `inventory/${row.tabName.toLowerCase()}/${row.itemId}`;
            const dateFilters = (this.projectShipDate && this.projectReturnDate)
                ? [
                    { column: 'Date', value: this.projectShipDate,  type: 'after'  },
                    { column: 'Date', value: this.projectReturnDate, type: 'before' }
                  ]
                : null;
            const finalPath = dateFilters
                ? NavigationRegistry.buildPath(basePath, { dateFilters })
                : basePath;
            this.appContext.navigateToPath(finalPath);
        },

        handleCategorySelected(categoryName) {
            this.selectedCategoryFilter = categoryName;
        },

        navigateBackToPacklist() {
            if (!this.projectIdentifier || !this.appContext?.navigateToPath) return;

            // Guard: Only navigate if we're still on the details page
            const currentPath = this.appContext.currentPath?.split('?')[0] || '';
            const expectedPath = `packlist/${this.projectIdentifier}/details`;

            if (!currentPath.includes(expectedPath)) {
                //console.log('[PacklistItemsSummary] Skipping navigation - user already navigated away');
                return;
            }

            this.appContext.navigateToPath(`packlist/${this.projectIdentifier}`);
        },

        async loadShowDetails() {
            if (!this.projectIdentifier) return;

            try {
                this.showDetails = await Requests.getShowDetails(this.projectIdentifier);
            } catch (err) {
                console.error('Error loading show details:', err);
                this.showDetails = null;
            }
        },

        openOverlappingShowsModal(shows) {
            this.$modal.custom(OverlappingShowsModal, { shows, modalClass: 'hamburger-menu', size: 'card' }, `${shows.length} Overlapping Shows`);
        },

        showsMatchSearch(shows) {
            if (!this.currentSearchText || !this.currentSearchText.trim() || !Array.isArray(shows)) {
                return false;
            }
            const searchWords = this.currentSearchText.toLowerCase().trim().split(/\s+/).filter(word => word.length > 0);
            const showsText = shows.join(' ').toLowerCase();
            return searchWords.some(word => showsText.includes(word));
        }
    },
    template: html`
        <slot class="packlist-items-summary">
                <!--button @click="navigateBackToPacklist" class="small">Back</button-->

            <div class="details-grid">
                <div v-for="key in showDetailsVisible" :key="key" class="detail-item">
                    <label>{{ key }}:</label>
                    <span v-if="showDetails">{{ showDetails[key] || '—' }}</span>
                    <span v-else>...</span>
                </div>
            </div>

            <DataView
                :fields="SUMMARY_FIELDS"
                :rows="tableData"
                :registry="SUMMARY_VIEWS"
                :show-search="true"
                :showRefresh="false"
                :sync-search-with-url="true"
                :container-path="containerPath || 'packlist/' + projectIdentifier + '/details'"
                :navigate-to-path="appContext.navigateToPath"
                :is-loading="itemsSummaryStore ? itemsSummaryStore.isLoading : false"
                :is-analyzing="itemsSummaryStore ? itemsSummaryStore.isAnalyzing : false"
                :loading-message="itemsSummaryStore?.isLoading ? itemsSummaryStore.loadingMessage : itemsSummaryStore?.analysisMessage"
                :loading-progress="itemsSummaryStore && itemsSummaryStore.isAnalyzing ? itemsSummaryStore.analysisProgress : -1"
                empty-message="No item data available"
                class="items-summary-table"
                @refresh="handleRefresh"
            >
                <template #header-area>
                    <InventoryCategoryFilter
                        :container-path="containerPath || ('packlist/' + projectIdentifier + '/details')"
                        :navigate-to-path="appContext.navigateToPath"
                        @category-selected="handleCategorySelected"
                    />
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
                    <slot v-else-if="column.key === 'overlappingShows'">
                        <slot v-if="!Array.isArray(row.overlappingShows) || row.overlappingShows.length === 0">
                            —
                        </slot>
                        <slot v-else-if="row.overlappingShows.length <= 4" class="overlapping-shows-buttons">
                            <button v-for="packlistId in row.overlappingShows"
                                    :key="packlistId"
                                    @click="appContext.navigateToPath('packlist/' + packlistId + '/details')"
                                    class="card white">
                                {{ packlistId }}
                            </button>
                        </slot>
                        <slot v-else>
                            <button @click="openOverlappingShowsModal(row.overlappingShows)"
                                    :class="['card', 'white', 'font-black', showsMatchSearch(row.overlappingShows) ? 'search-highlight' : '']">
                                {{ row.overlappingShows.length }} shows
                            </button>
                        </slot>
                    </slot>
                </template>
            </DataView>
        </slot>
        `
};
