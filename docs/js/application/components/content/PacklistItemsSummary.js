import { html, DataView, Requests, getReactiveStore, createAnalysisConfig, NavigationRegistry, THUMBNAIL_FIELD, getItemThumbnailsStore, itemThumbnailMap, withItemThumbnails, InventoryCategoryFilter, Priority, invalidateCache, todayISOString } from '../../index.js';
import { thumbnailStyle } from '../../utils/views/viewStyles.js';

// What each summary key is. thumbnail is the item's, joined by item number (itemThumbnails.js).
const SUMMARY_FIELDS = [
    THUMBNAIL_FIELD,
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
        columns: ['thumbnail', 'itemId', 'quantity', 'available', 'remaining', 'overlappingShows'],
        hidden: ['tabName'],
        sortable: ['itemId', 'quantity', 'available', 'tabName', 'remaining'],
        // Item# is the primary action's button (the item page, purple); Overlapping Shows is a list
        // of show buttons (four inline, more in a modal)
        style: {
            thumbnail: thumbnailStyle('itemId'),
            itemId: { cell: 'action', cellOptions: { class: 'purple' } },
            remaining: { color: 'auto' },
            overlappingShows: { cell: 'showList', cellOptions: { max: 4 }, columnColor: 'gray' }
        },
        table: { sticky: { start: ['thumbnail'] }, hideRowsOnSearch: false }
    }]
};

/**
 * Component for displaying item quantities summary with progressive analysis
 * Shows: Item ID, Quantity, Available, Remaining, Overlapping Shows
 */
export const PacklistItemsSummary = {
    components: { DataView, InventoryCategoryFilter },
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
            itemThumbnailsStore: getItemThumbnailsStore(),
            NavigationRegistry, // Make NavigationRegistry available in template
            SUMMARY_FIELDS,
            SUMMARY_VIEWS
        };
    },
    computed: {
        isLoading() {
            return this.itemsSummaryStore ? this.itemsSummaryStore.isLoading : false;
        },
        itemThumbnails() {
            return itemThumbnailMap(this.itemThumbnailsStore?.data);
        },
        tableData() {
            const data = withItemThumbnails(this.itemsSummaryStore ? this.itemsSummaryStore.data : [], 'itemId', this.itemThumbnails);

            // Apply category filter if selected
            if (this.selectedCategoryFilter) {
                return data.filter(item => item.tabName === this.selectedCategoryFilter);
            }

            return data;
        },

        // Primary action: the item page, drawn as the Item# button (action cell)
        itemAction() {
            return {
                to: (row) => this.itemPagePath(row),
                disabled: (row) => !row.tabName || !row.itemId,
                title: 'View item timeline'
            };
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

        // The item's page, filtered to this show's ship-to-return dates when known
        itemPagePath(row) {
            if (!row.tabName || !row.itemId) return null;
            const basePath = `inventory/${row.tabName.toLowerCase()}/${row.itemId}`;
            const dateFilters = (this.projectShipDate && this.projectReturnDate)
                ? [
                    { column: 'Date', value: this.projectShipDate,  type: 'after'  },
                    { column: 'Date', value: this.projectReturnDate, type: 'before' }
                  ]
                : null;
            return dateFilters ? NavigationRegistry.buildPath(basePath, { dateFilters }) : basePath;
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
                :action="itemAction"
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
            </DataView>
        </slot>
        `
};
