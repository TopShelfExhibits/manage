import { html, DataView, ButtonBar, Requests, getReactiveStore, InventoryCategoryFilter, invalidateCache, NavigationRegistry, ProposalUtils, THUMBNAIL_FIELD, getItemThumbnailsStore, itemThumbnailMap, withItemThumbnails } from '../../index.js';
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

// What each month row key is (Requests.getInventoryProjectionMonths), as readable text; derived on
// a computed copy. short is drawn by the modal (#cell).
const MONTH_FIELDS = [
    { key: 'monthLabel', label: 'Month' },
    { key: 'bookedText', label: 'Booked' },
    { key: 'pastText', label: 'Same month before' },
    { key: 'multiplierText', label: 'Carried forward' },
    { key: 'expectedText', label: 'Expected' },
    { key: 'filledText', label: 'Not booked yet' },
    { key: 'sqftOutText', label: 'Most out in one day' },
    { key: 'short', label: 'Items short' }
];

const MONTH_VIEWS = {
    id: 'inventory-projection-months',
    default: 'table',
    theme: 'blue',
    views: [{
        id: 'table',
        name: 'Months',
        layout: 'table',
        columns: MONTH_FIELDS.map(field => field.key),
        style: { monthLabel: { width: 90 }, short: { cell: 'slot', width: 320 } }
    }]
};

const sqftText = (n) => `${Math.round(n || 0).toLocaleString()} sq ft`;
const showsText = (n) => `${n} show${n === 1 ? '' : 's'}`;

/**
 * The inventory projection month by month, in words (Requests.getInventoryProjectionMonths): how
 * each month's expected square feet are reached and what is out at once. A modal component: open
 * it with $modal.custom(InventoryProjectionMonths, { category }).
 */
const InventoryProjectionMonths = {
    components: { DataView },
    props: {
        category: { type: String, required: true }
    },
    data() {
        return {
            monthsStore: getReactiveStore(Requests.getInventoryProjectionMonths, null, [this.category]),
            MONTH_FIELDS,
            MONTH_VIEWS
        };
    },
    computed: {
        rows() {
            return (this.monthsStore.data || []).map(month => {
                const past = monthLabel(month.pastMonth);
                const fromPast = month.projectedSqft > month.scheduledSqft;
                const averaged = month.seasonalYears > 1;
                return {
                    ...month,
                    monthLabel: monthLabel(month.month),
                    bookedText: month.shows ? `${showsText(month.shows)}, ${sqftText(month.scheduledSqft)}` : 'none',
                    pastText: `${past}: ${sqftText(month.pastSqft)}${averaged ? `; ${month.seasonalYears} years averaged: ${sqftText(month.seasonalSqft)}` : ''}`,
                    multiplierText: `× ${month.multiplier}`,
                    expectedText: !month.projectedSqft ? sqftText(0) : `${sqftText(month.projectedSqft)}, ${fromPast ? `${averaged ? 'average' : past} × ${month.multiplier}` : 'booked'}`,
                    filledText: month.filledShows ? `${showsText(month.filledShows)} from ${monthLabel(month.filledFrom)}, ${sqftText(month.filledSqft)}` : '—',
                    sqftOutText: sqftText(month.sqftOut)
                };
            });
        }
    },
    template: html`
        <p>
            Expected is the larger of booked and the same month before (with more than one History
            Year, averaged over them as a share of each year), carried forward by the trend and Growth
            Factor. The shows not booked yet are that month's past shows, moved forward and sized to
            fill the gap. Out in one day counts every show from ship to return, so shows still out from
            earlier months count too; an item is short when the most of it out in one day passes its
            stock. A show without a pack list takes each item at its share of the learned shows that
            packed it, times its typical quantity at the show's size. Each item learns its own scale
            with size: 1 grows in step with square feet, 0 is the same at any size, learned from shows
            of differing sizes and kept near 1 when few shows packed it.
        </p>
        <DataView
            :fields="MONTH_FIELDS"
            :rows="rows"
            :registry="MONTH_VIEWS"
            :is-loading="monthsStore.isLoading"
            loading-message="Projecting inventory..."
            :show-refresh="false"
            empty-message="No months to show."
        >
            <template #cell="{ row, field }">
                <span v-if="field.key === 'short' && !row.shortCount">—</span>
                <ul v-else-if="field.key === 'short'">
                    <li v-for="shortage in row.shortages" :key="shortage.itemId">
                        <strong>{{ shortage.itemId }}</strong>: {{ shortage.peak }} out, {{ shortage.stock }} in stock
                        <span v-if="shortage.usedIn">(in {{ shortage.usedIn }} of {{ shortage.learned }} shows, {{ shortage.at1000 }} at 1,000 sq ft<template v-if="shortage.scale !== 1">, scale {{ shortage.scale }}</template>)</span>
                        <span v-else>(pack lists only)</span>
                    </li>
                    <li v-if="row.shortCount > row.shortages.length">and {{ row.shortCount - row.shortages.length }} more</li>
                </ul>
            </template>
        </DataView>
    `,
    inheritAttrs: false
};

/**
 * Inventory projection report (reports/inventory-projection): for one inventory category, the
 * items likely to have more out at once than in stock over the coming years (ProjectionFutureYears),
 * from the booked shows' windows and pack lists, the shows expected but not booked yet, and each
 * item's recent use per square foot. A proposal (URL parameter `proposal`) adds a column with each
 * shortage after its quantity changes. The model and its settings:
 * data_management/utils/inventory-projection.js; the settings are preference rows, shown in the
 * page menu (View Parameters).
 */
export const InventoryProjectionReport = {
    components: { DataView, ButtonBar, InventoryCategoryFilter },
    inject: ['appContext', '$modal'],
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
                { label: 'Projected', value: `the next ${12 * settings.futureYears} months: the most of each item out at once, ship to return, against stock` },
                { label: 'Use per sq ft', value: `learned from ${basis.learnedFrom} of ${basis.usageShows} shows shipping ${window} (those with a pack list and a size, ${basis.usageSqft.toLocaleString()} sq ft): each item's share of them that packed it × its typical quantity at a show's size, with a scale learned per item (1: in step with sq ft, 0: the same at any size)` },
                { label: 'Booked', value: `${basis.outShows} shows out from today, ${basis.packedShows} at their pack lists, the rest at use per sq ft` },
                { label: 'Not booked yet', value: `${basis.filledShows} past shows a year on, sized to fill each month's expected sq ft` },
                { label: 'Expected sq ft', value: `the larger of booked and the same month last year${this.basis.trend.years.length > 1 ? ' (averaged over the past years as a share of each, at last year\'s total)' : ''} × ${this.trendText} × ${settings.growthFactor} (Growth Factor${settings.futureYears > 1 ? ', once per year ahead' : ''})` },
                { label: 'Shows without a size', value: `${basis.unsized} of ${basis.shows}${settings.defaultSquareFeet ? `, counted as ${settings.defaultSquareFeet} sq ft` : ', left out'}` }
            ];
        },
        // The trend multipliers and the yearly square feet they are drawn through
        trendText() {
            const { years, multipliers } = this.basis.trend;
            if (years.length < 2) return '1 (no trend: History Years is 1)';
            const ahead = multipliers.length > 1 ? `${multipliers.join(', ')} for 1–${multipliers.length} years ahead` : `${multipliers[0]}`;
            return `${ahead} (the trend through the past ${years.length} years: ${years.map(sqft => sqft.toLocaleString()).join(', ')} sq ft)`;
        },
        isLoading() {
            return !!(this.projectionStore?.isLoading || this.basisStore?.isLoading);
        },
        emptyMessage() {
            if (!this.category) return 'Choose an inventory category to project.';
            const months = 12 * (this.basis?.settings.futureYears || 1);
            return `No likely shortages in the next ${months} months.`;
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
        openMonths() {
            this.$modal.custom(InventoryProjectionMonths, { category: this.category, size: 'page' }, `${this.category}: projection by month`);
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
                <ButtonBar>
                    <InventoryCategoryFilter
                        :container-path="containerPath"
                        :navigate-to-path="navigateToPath"
                        @category-selected="handleCategorySelected"
                    />
                    <select :value="proposal" title="Apply a proposal's quantity changes" @change="selectProposal($event.target.value)">
                        <option value="">Select Proposal</option>
                        <option v-for="name in proposalNames" :key="name" :value="name">{{ name }}</option>
                    </select>
                    <button :disabled="!category" title="How the projection reaches each month" @click="openMonths">View Months</button>
                </ButtonBar>
            </template>
        </DataView>
    `,
    inheritAttrs: false
};
