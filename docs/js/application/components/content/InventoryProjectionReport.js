import { html, DataView, Requests, getReactiveStore, InventoryCategoryFilter, invalidateCache } from '../../index.js';

// What each projection month key is (Requests.getInventoryProjection). monthLabel is derived on a
// computed copy; shortages is a list of { itemId, projected, stock, capacity, reuse, learned }.
const PROJECTION_FIELDS = [
    { key: 'monthLabel', label: 'Month' },
    { key: 'shows', label: 'Shows booked', format: 'number', type: 'number' },
    { key: 'scheduledSqft', label: 'Booked sq ft', format: 'number', type: 'number' },
    { key: 'pastSqft', label: 'Past sq ft', format: 'number', type: 'number' },
    { key: 'projectedSqft', label: 'Projected sq ft', format: 'number', type: 'number' },
    { key: 'shortages', label: 'Likely shortages' }
];

// Inventory projection view (views-and-renderers-plan §5): one row per month; the page draws the
// shortage list (#cell)
const PROJECTION_VIEWS = {
    id: 'inventory-projection',
    default: 'table',
    theme: 'blue',
    views: [{
        id: 'table',
        name: 'Projection',
        layout: 'table',
        columns: ['monthLabel', 'shows', 'scheduledSqft', 'pastSqft', 'projectedSqft', 'shortages'],
        style: { monthLabel: { width: 90 }, shortages: { cell: 'slot' } }
    }]
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (month) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/**
 * Inventory projection report (reports/inventory-projection): for one inventory category, the
 * items likely to run short in each of the next 12 months, from the shows expected (booked, or the
 * same month in past years) and each item's recent use per square foot. The model and its
 * settings: data_management/utils/inventory-projection.js; the settings are preference rows,
 * shown in the page menu (View Parameters).
 */
export const InventoryProjectionReport = {
    components: { DataView, InventoryCategoryFilter },
    props: {
        containerPath: { type: String, default: 'reports/inventory-projection' },
        navigateToPath: Function
    },
    data() {
        return {
            category: null,
            projectionStore: null,
            basisStore: null,
            PROJECTION_FIELDS,
            PROJECTION_VIEWS
        };
    },
    computed: {
        rows() {
            return (this.projectionStore?.data || []).map(row => ({ ...row, monthLabel: monthLabel(row.month) }));
        },
        basis() {
            return this.basisStore?.data?.[0] || null;
        },
        // What the numbers rest on, so thin data is visible
        basisItems() {
            const basis = this.basis;
            if (!basis) return [];
            const { settings } = basis;
            const window = `${monthLabel(basis.usageMonths[0])} – ${monthLabel(basis.usageMonths[basis.usageMonths.length - 1])}`;
            return [
                { label: 'Learned from', value: `${basis.learnedFrom} of ${basis.usageShows} shows shipping ${window} (those with a pack list and a size): ${basis.usageSqft.toLocaleString()} sq ft` },
                { label: 'Items', value: `${basis.learnedItems} with reuse learned from their use, ${basis.fallbackItems} at ${settings.reuseFallback}× a month` },
                { label: 'Shows without a size', value: `${basis.unsized} of ${basis.shows}${settings.defaultSquareFeet ? `, counted as ${settings.defaultSquareFeet} sq ft` : ', left out'}` },
                { label: 'Expected shows', value: `the larger of booked and the same month over the past ${settings.historyYears === 1 ? 'year' : `${settings.historyYears} years`} × ${settings.growthFactor}` }
            ];
        },
        isLoading() {
            return !!(this.projectionStore?.isLoading || this.basisStore?.isLoading);
        },
        emptyMessage() {
            return this.category ? 'No months to show.' : 'Choose an inventory category to project.';
        }
    },
    methods: {
        handleCategorySelected(category) {
            this.category = category || null;
            this.projectionStore = this.category ? getReactiveStore(Requests.getInventoryProjection, null, [this.category]) : null;
            this.basisStore = this.category ? getReactiveStore(Requests.getInventoryProjectionBasis, null, [this.category]) : null;
        },
        handleRefresh() {
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['PROD_SCHED', 'Production Schedule'] },
                { namespace: 'database', methodName: 'getData', args: ['INVENTORY'] },
                { namespace: 'database', methodName: 'getData', args: ['PACK_LISTS'] },
                { namespace: 'database', methodName: 'getTabs', args: ['PACK_LISTS'] }
            ]);
        },
        shortageTitle(shortage) {
            return shortage.learned
                ? `Reuse ${shortage.reuse}× a month, learned from recent use`
                : `Reuse ${shortage.reuse}× a month (fallback: too little recent use or stock to learn it)`;
        }
    },
    template: html`
        <div v-if="basis" class="card details-grid">
            <div v-for="item in basisItems" :key="item.label" class="detail-item">
                <label>{{ item.label }}</label>
                <span>{{ item.value }}</span>
            </div>
        </div>
        <DataView
            :fields="PROJECTION_FIELDS"
            :rows="rows"
            :registry="PROJECTION_VIEWS"
            :container-path="containerPath"
            :navigate-to-path="navigateToPath"
            title="Inventory Projection"
            :is-loading="isLoading"
            loading-message="Projecting inventory..."
            :show-refresh="!!category"
            :empty-message="emptyMessage"
            @refresh="handleRefresh"
        >
            <template #header-area>
                <div class="button-bar">
                    <InventoryCategoryFilter
                        :container-path="containerPath"
                        :navigate-to-path="navigateToPath"
                        @category-selected="handleCategorySelected"
                    />
                </div>
            </template>
            <template #cell="{ row, field }">
                <span v-if="field.key === 'shortages' && !row.shortages.length">—</span>
                <ul v-else-if="field.key === 'shortages'">
                    <li v-for="shortage in row.shortages" :key="shortage.itemId" :title="shortageTitle(shortage)">
                        <strong>{{ shortage.itemId }}</strong>: about {{ shortage.projected }} needed, {{ shortage.stock }} in stock
                    </li>
                </ul>
            </template>
        </DataView>
    `,
    inheritAttrs: false
};
