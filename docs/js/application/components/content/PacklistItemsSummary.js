import { html, TableComponent, Requests, getReactiveStore, createAnalysisConfig, NavigationRegistry, ItemImageComponent, InventoryCategoryFilter, Priority, invalidateCache } from '../../index.js';

/**
 * Component for displaying item quantities summary with progressive analysis
 * Shows: Item ID, Quantity, Available, Remaining, Overlapping Shows
 */
export const PacklistItemsSummary = {
    components: { TableComponent, ItemImageComponent, InventoryCategoryFilter },
    props: {
        projectIdentifier: { type: String, required: true },
        containerPath: { type: String, default: '' },
        showDetailsVisible: {
            type: Array,
            default: () => ['Ship', 'S. Start', 'S. End', 'Expected Return Date', 'City', 'Size', 'Booth#', 'S/U IN SHOP']
        }
    },
    inject: ['appContext'],
    data() {
        return {
            itemsSummaryStore: null,
            showDetails: null, // Production schedule show details
            error: null,
            selectedCategoryFilter: null, // Filter by inventory category
            NavigationRegistry // Make NavigationRegistry available in template
        };
    },
    computed: {
        tableColumns() {
            return [
                { 
                    key: 'image', 
                    label: 'IMG',
                    width: 1,
                    sortable: false
                },
                { key: 'itemId', label: 'Item#', sortable: true},
                { key: 'quantity', label: 'Quantity', sortable: true},
                { key: 'available', label: 'Inv. Qty.', sortable: true},
                { key: 'tabName', label: 'Tab', sortable: true},
                { 
                    key: 'remaining', 
                    label: 'Remaining', 
                    format: 'number',
                    autoColor: true,
                    sortable: true
                },
                { key: 'overlappingShows', label: 'Overlapping Shows', sortable: false}
            ];
        },
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
        initializeStore() {
            if (!this.projectIdentifier) return;

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
                    [],
                    'available'
                ),
                createAnalysisConfig(
                    (itemId, currentProjectId) => Requests.getItemOverlappingShows(currentProjectId, itemId),
                    'overlappingShows',
                    'Finding overlapping shows...',
                    ['itemId'],
                    [this.projectIdentifier],
                    'overlappingShows',
                    false,
                    Priority.USER_ACTION // Used for navigation buttons
                ),
                createAnalysisConfig(
                    (itemId, currentProjectId) => Requests.calculateRemainingQuantity(currentProjectId, itemId),
                    'remaining',
                    'Calculating remaining quantities...',
                    ['itemId'],
                    [this.projectIdentifier],
                    'remaining'
                ),
                createAnalysisConfig(
                    Requests.getItemImageUrl,
                    'imageUrl',
                    'Loading item images...',
                    ['itemId'], // Extract itemId from row
                    [],
                    null, // Store in AppData, not a column
                    false,
                    Priority.BACKGROUND // Images are visual enhancements, lowest priority
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

        handleCategorySelected(categoryName) {
            this.selectedCategoryFilter = categoryName;
        },

        navigateBackToPacklist() {
            if (!this.projectIdentifier || !this.appContext?.navigateToPath) return;
            
            // Guard: Only navigate if we're still on the details page
            const currentPath = this.appContext.currentPath?.split('?')[0] || '';
            const expectedPath = `packlist/${this.projectIdentifier}/details`;
            
            if (!currentPath.includes(expectedPath)) {
                console.log('[PacklistItemsSummary] Skipping navigation - user already navigated away');
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
        }
    },
    template: html`
        <slot class="packlist-items-summary">
            <button @click="navigateBackToPacklist">Back to View</button>
            <div class="details-grid">
                <div v-for="key in showDetailsVisible" :key="key" class="detail-item">
                    <label>{{ key }}:</label>
                    <span v-if="showDetails">{{ showDetails[key] || '—' }}</span>
                    <span v-else>...</span>
                </div>
            </div>
            
            <TableComponent
                :data="tableData"
                :columns="tableColumns"
                :hide-columns="['tabName']"
                :show-search="true"
                :showRefresh="false"
                :sync-search-with-url="true"
                :container-path="containerPath || 'packlist/' + projectIdentifier + '/details'"
                :navigate-to-path="appContext.navigateToPath"
                :hide-rows-on-search="false"
                :readonly="true"
                :is-loading="itemsSummaryStore ? itemsSummaryStore.isLoading : false"
                :is-analyzing="itemsSummaryStore ? itemsSummaryStore.isAnalyzing : false"
                :loading-message="itemsSummaryStore && itemsSummaryStore.isLoading ? itemsSummaryStore.analysisMessage.loadingMessage : itemsSummaryStore.analysisMessage"
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
                                @click="appContext.navigateToPath(NavigationRegistry.buildPath('inventory/categories/' + row.tabName, { searchTerm: row.itemId }))"
                                class="purple"
                                :title="'Search for ' + row.itemId + ' in ' + row.tabName">
                            {{ row.itemId }}
                        </button>
                        <span v-else>{{ row.itemId }}</span>
                    </slot>
                    <slot v-else-if="column.key === 'overlappingShows'">
                        <slot v-if="!Array.isArray(row.overlappingShows) || row.overlappingShows.length === 0">
                            —
                        </slot>
                        <slot v-else class="overlapping-shows-buttons">
                            <button v-for="packlistId in row.overlappingShows" 
                                    :key="packlistId"
                                    @click="appContext.navigateToPath('packlist/' + packlistId + '/details')"
                                    class="card white">
                                {{ packlistId }}
                            </button>
                        </slot>
                    </slot>
                    <!--div v-else-if="column.key === 'remaining'">
                        {{ row.remaining !== null ? row.remaining : '...' }}
                    </div>
                    <div v-else-if="column.key === 'available'">
                        {{ row.available !== null ? row.available : '...' }}
                    </div>
                    <div v-else-if="column.key === 'tabName'">
                        {{ row.tabName !== null ? row.tabName : '...' }}
                    </div-->
                    <div v-else>
                        {{ row[column.key] }}
                    </div>
                </template>
            </TableComponent>
        </slot>
        `
};
