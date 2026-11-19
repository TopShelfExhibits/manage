import { html, DataView, ButtonBar, readRowMetadata, Requests, getReactiveStore, InventoryCategoryFilter, invalidateCache, NavigationRegistry, ProposalUtils, THUMBNAIL_FIELD, getItemThumbnailsStore, itemThumbnailMap, withItemThumbnails } from '../../index.js';
import { thumbnailStyle } from '../../utils/views/viewStyles.js';
import { getProposalsStore } from '../../utils/inventoryProposals.js';

// What each projection row key is (Requests.getInventoryProjection): one item that runs short.
// monthLabel is derived on a computed copy; thumbnail is the item's, joined by item number. An item
// short in more than one month gets a collapsed group under its row: one row per short month.
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
 * The inventory projection's details: what it rests on (Requests.getInventoryProjectionBasis), then
 * month by month in words (Requests.getInventoryProjectionMonths): how each month's expected square
 * feet are reached and what is out at once. A modal component: open it with
 * $modal.custom(InventoryProjectionDetails, { category }).
 */
const InventoryProjectionDetails = {
    components: { DataView },
    props: {
        category: { type: String, required: true }
    },
    data() {
        return {
            basisStore: getReactiveStore(Requests.getInventoryProjectionBasis, null, [this.category]),
            monthsStore: getReactiveStore(Requests.getInventoryProjectionMonths, null, [this.category]),
            MONTH_FIELDS,
            MONTH_VIEWS
        };
    },
    computed: {
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
                { label: 'Booth mix', value: 'each item is carried forward on its own measure of the shows, the sum of booth size^scale: square feet at scale 1, the number of booths at 0. More small booths raise an item that goes with booths more than one that goes with square feet; the months below show square feet' },
                { label: 'Months below', value: 'most out in one day counts every show from ship to return, so shows still out from earlier months count too; an item is short when the most of it out in one day passes its stock' },
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
        <div v-if="basis" class="card details-grid">
            <div v-for="item in basisItems" :key="item.label" class="detail-item">
                <label>{{ item.label }}</label>
                <span>{{ item.value }}</span>
            </div>
        </div>
        <DataView
            :fields="MONTH_FIELDS"
            :rows="rows"
            :registry="MONTH_VIEWS"
            :is-loading="monthsStore.isLoading"
            :loading-message="monthsStore.loadingMessage || 'Projecting inventory...'"
            :loading-progress="monthsStore.loadingProgress ?? -1"
            :show-refresh="false"
            empty-message="No months to show."
        >
            <template #cell="{ row, field }">
                <span v-if="field.key === 'short' && !row.shortCount">—</span>
                <ul v-else-if="field.key === 'short'">
                    <li v-for="shortage in row.shortages" :key="shortage.itemId">
                        <strong>{{ shortage.itemId }}</strong>: {{ shortage.peak }} out, {{ shortage.stock }} in stock
                        <span v-if="shortage.usedIn">(in {{ shortage.usedIn }} of {{ shortage.learned }} shows, {{ shortage.at1000 }} at 1,000 sq ft<template v-if="shortage.scale !== 1">, scale {{ shortage.scale }}</template><template v-if="shortage.multiplier !== row.multiplier">, carried forward × {{ shortage.multiplier }}</template>)</span>
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
        // Each item's row; short in more than one month, it heads a group (MetaData grouping, as
        // the item shortage report draws its periods) of one row per short month, collapsed
        rows() {
            const thumbnails = itemThumbnailMap(this.itemThumbnailsStore?.data);
            const rows = [];
            for (const { months, ...item } of this.projectionStore?.data || []) {
                const [head] = withItemThumbnails([{ ...item, monthLabel: monthLabel(item.month) }], 'itemId', thumbnails);
                if (!months || months.length < 2) {
                    rows.push(head);
                    continue;
                }
                const groupId = `projection-${item.itemId}`;
                rows.push({ ...head, metadata: JSON.stringify({ ...readRowMetadata(head), grouping: { groupId, isGroupMaster: true } }) });
                for (const entry of months) {
                    rows.push({
                        itemId: item.itemId,
                        ...entry,
                        monthLabel: monthLabel(entry.month),
                        metadata: JSON.stringify({ grouping: { groupId, isGroupMaster: false } })
                    });
                }
            }
            return rows;
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
        isLoading() {
            return !!this.projectionStore?.isLoading;
        },
        // The model's steps (Requests.getInventoryProjectionModel)
        loadingMessage() {
            return this.projectionStore?.loadingMessage || 'Projecting inventory...';
        },
        loadingProgress() {
            return this.projectionStore?.loadingProgress ?? -1;
        },
        emptyMessage() {
            return this.category ? 'No likely shortages in the projected months.' : 'Choose an inventory category to project.';
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
        },
        openDetails() {
            this.$modal.custom(InventoryProjectionDetails, { category: this.category, size: 'page' }, `${this.category}: projection details`);
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
        <DataView
            :fields="PROJECTION_FIELDS"
            :rows="rows"
            :registry="PROJECTION_VIEWS"
            :patches="viewPatches"
            :action="itemAction"
            :container-path="containerPath"
            :navigate-to-path="navigateToPath"
            title="Inventory Projection"
            :hide-group-members="true"
            :is-loading="isLoading"
            :loading-message="loadingMessage"
            :loading-progress="loadingProgress"
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
                    <button class="button-symbol" :disabled="!category" title="Projection details" @click="openDetails">☷</button>
                </ButtonBar>
            </template>
        </DataView>
    `,
    inheritAttrs: false
};
