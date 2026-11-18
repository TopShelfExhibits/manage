import { html, DataView, Requests, getReactiveStore, InventoryCategoryFilter, invalidateCache, NavigationRegistry, ProposalUtils, THUMBNAIL_FIELD, getItemThumbnailsStore, itemThumbnailMap, withItemThumbnails } from '../../index.js';
import { thumbnailStyle } from '../../utils/views/viewStyles.js';
import { getProposalsStore } from '../../utils/inventoryProposals.js';

// What each projection row key is (Requests.getInventoryProjection): one item that runs short.
// monthLabel is derived on a computed copy; thumbnail is the item's, joined by item number.
const PROJECTION_FIELDS = [
    { key: 'monthLabel', label: 'Month' },
    THUMBNAIL_FIELD,
    { key: 'itemId', label: 'Item#', type: 'item' },
    { key: 'shortage', label: 'Shortage', format: 'number', type: 'number' },
    { key: 'proposed', label: 'Proposed', format: 'number', type: 'number' }
];

// Inventory projection view (views-and-renderers-plan §5): one row per item that runs short, the
// soonest month first. Item# opens the item page; Proposed shows only with a proposal selected.
const PROJECTION_VIEWS = {
    id: 'inventory-projection',
    default: 'table',
    theme: 'blue',
    views: [{
        id: 'table',
        name: 'Projection',
        layout: 'table',
        columns: ['monthLabel', 'thumbnail', 'itemId', 'shortage', 'proposed'],
        style: {
            monthLabel: { width: 90 },
            thumbnail: thumbnailStyle('itemId'),
            itemId: { cell: 'action', cellOptions: { class: 'purple' } },
            shortage: { color: 'sign:green:red' },
            proposed: { color: 'sign:green:red' }
        }
    }]
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (month) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/**
 * Inventory projection report (reports/inventory-projection): for one inventory category, the
 * items likely to run short over the next 12 months, from the shows expected (booked, or the same
 * month in past years) and each item's recent use per square foot. A proposal (URL parameter
 * `proposal`) adds a column with each shortage after its quantity changes. The model and its
 * settings: data_management/utils/inventory-projection.js; the settings are preference rows,
 * shown in the page menu (View Parameters).
 */
export const InventoryProjectionReport = {
    components: { DataView, InventoryCategoryFilter },
    inject: ['appContext'],
    props: {
        containerPath: { type: String, default: 'reports/inventory-projection' },
        navigateToPath: Function
    },
    data() {
        return {
            category: null,
            projectionStore: null,
            basisStore: null,
            proposalsStore: getProposalsStore(),
            itemThumbnailsStore: getItemThumbnailsStore(),
            PROJECTION_FIELDS,
            PROJECTION_VIEWS
        };
    },
    computed: {
        proposal() {
            return NavigationRegistry.getParametersForContainer(this.containerPath, this.appContext?.currentPath)?.proposal || '';
        },
        // Active proposals, most recently updated first
        proposalNames() {
            return ProposalUtils.groupProposals(this.proposalsStore?.data || []).filter(p => !p.committed).map(p => p.name);
        },
        projectionKey() {
            return this.category ? JSON.stringify([this.category, this.proposal]) : '';
        },
        rows() {
            const rows = (this.projectionStore?.data || []).map(row => ({ ...row, monthLabel: monthLabel(row.month) }));
            return withItemThumbnails(rows, 'itemId', itemThumbnailMap(this.itemThumbnailsStore?.data));
        },
        // Proposed shows only with a proposal selected
        viewPatches() {
            if (this.proposal) return [];
            return [{ patch: { columns: PROJECTION_VIEWS.views[0].columns.filter(k => k !== 'proposed'), hidden: ['proposed'] } }];
        },
        // Item# opens the item page
        itemAction() {
            return {
                to: (row) => (this.category && row.itemId ? `inventory/${this.category.toLowerCase()}/${row.itemId}` : null),
                title: 'View item'
            };
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
            return this.category ? 'No likely shortages in the next 12 months.' : 'Choose an inventory category to project.';
        }
    },
    watch: {
        projectionKey: {
            immediate: true,
            handler() {
                this.projectionStore = this.category ? getReactiveStore(Requests.getInventoryProjection, null, [this.category, this.proposal]) : null;
            }
        }
    },
    methods: {
        handleCategorySelected(category) {
            this.category = category || null;
            this.basisStore = this.category ? getReactiveStore(Requests.getInventoryProjectionBasis, null, [this.category]) : null;
        },
        selectProposal(name) {
            NavigationRegistry.updateContainerParams(this.containerPath, this.appContext?.currentPath, { proposal: name || undefined }, this.navigateToPath);
        },
        handleRefresh() {
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['PROD_SCHED', 'Production Schedule'] },
                { namespace: 'database', methodName: 'getData', args: ['INVENTORY'] },
                { namespace: 'database', methodName: 'getData', args: ['PACK_LISTS'] },
                { namespace: 'database', methodName: 'getTabs', args: ['PACK_LISTS'] }
            ]);
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
            :patches="viewPatches"
            :action="itemAction"
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
                    <select :value="proposal" title="Apply a proposal's quantity changes" @change="selectProposal($event.target.value)">
                        <option value="">Select Proposal</option>
                        <option v-for="name in proposalNames" :key="name" :value="name">{{ name }}</option>
                    </select>
                </div>
            </template>
        </DataView>
    `,
    inheritAttrs: false
};
