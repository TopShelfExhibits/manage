import { html, NavigationRegistry, TableComponent, CalendarComponent, CardsComponent } from '../../index.js';
import { resolveView, resolveAction, pickView, devWarn, searchTiers } from '../../utils/views/resolveView.js';
import { rowsToCards, bucketRowsToCards } from '../../utils/views/cardsAdapter.js';
import { useContainerSize } from '../../utils/useContainerSize.js';
import { RowDetailsModal } from './rowDetailsComponent.js';
import { useInstantEdits, INSTANT_WRITE_DELAY_MS } from '../../utils/cellEdits.js';

/**
 * Presentation props DataView no longer takes: presentation comes only from the view. A page
 * still passing one gets a dev warning (attrs are listed as written by the page).
 */
const REMOVED_PRESENTATION_PROPS = [
    'columns', 'hideColumns', 'hide-columns', 'viewModes', 'view-modes', 'chipColorClass', 'chip-color-class',
    'chipActions', 'chip-actions', 'onItemClick', 'on-item-click', 'items', 'defaultSortColumn', 'default-sort-column',
    'defaultSortDirection', 'default-sort-direction', 'theme', 'allowDetails', 'allow-details', 'onEventClick',
    'eventStartColumn', 'event-start-column', 'eventEndColumn', 'event-end-column', 'rowClass', 'row-class'
];

/**
 * DataView — the only producer of renderer presentation input (views-and-renderers-plan §3).
 *
 * The page supplies data and domain logic:
 *   fields     FieldDef[] (what each key is)
 *   rows       the rows to draw (a computed copy when derived fields exist)
 *   registry   { id, default, theme, views: ViewDef[] }
 *   action     ActionDef { to(row) | run(row), label, icon, disabled(row) }
 *   decorations(row, key) → Card[] with decorationKeys (the keys the page decorates)
 *   editMode   'none' | 'batch' | 'instant'
 *   patches    ViewPatch[] (customization input)
 *   printing   applies the view's print variant
 *
 * DataView picks the view (?view=, legacy ?layout=, registry default; a fixed `viewId` for modals),
 * resolves it, resolves the primary action, and renders the renderer for the view's layout.
 * Everything else ($attrs: loading state, search options, listeners) and every slot is forwarded.
 *
 * Size: the container tier of the nearest size container (useContainerSize, same thresholds as
 * the CSS @container rules), so view variants and CSS switch together.
 *
 * Instant edit mode: DataView holds the instant edits (useInstantEdits, utils/cellEdits.js) because
 * it has the page's write hooks (commitCells, rowId, derive) and feeds the rows, with edits
 * overlaid, to the renderer. The table reports each edit (cell-commit) and shows each cell's state.
 */
export const DataView = {
    name: 'DataView',
    inheritAttrs: false,
    components: { TableComponent, CalendarComponent, CardsComponent },
    inject: {
        $modal: { from: '$modal', default: null },
        appContext: { from: 'appContext', default: null }
    },
    props: {
        fields: { type: Array, required: true },
        rows: { type: Array, default: () => [] },
        originalData: { type: Array, default: null },
        registry: { type: Object, required: true },
        viewId: { type: String, default: null },
        containerPath: { type: String, default: '' },
        navigateToPath: { type: Function, default: null },
        action: { type: Object, default: null },
        decorations: { type: Function, default: null },
        decorationKeys: { type: Array, default: () => [] },
        editMode: { type: String, default: 'none' },
        printing: { type: Boolean, default: false },
        patches: { type: Array, default: () => [] },
        detailsTitle: { type: Function, default: null },
        // Instant edit mode
        commitCells: { type: Function, default: null },
        rowId: { type: Function, default: null },
        cellDisabled: { type: Function, default: null },
        // derive(row) → row: recompute the page's derived fields on locally edited rows
        derive: { type: Function, default: null },
        // Bucket cards (cards.bucketBy): bucketKeys seed empty buckets; bucketDecorations(key, rows) → Card[]
        bucketKeys: { type: Array, default: () => [] },
        bucketDecorations: { type: Function, default: null },
        bucketLabel: { type: Function, default: null },
        bucketAppData: { type: Function, default: null },
        writeDelay: { type: Number, default: INSTANT_WRITE_DELAY_MS }
    },
    setup() {
        const vm = Vue.getCurrentInstance().proxy;
        const instantEdits = useInstantEdits({
            enabled: () => vm.editMode === 'instant' && !!vm.rowId && !!vm.commitCells,
            rows: () => vm.rows,
            rowId: (row) => vm.rowId(row),
            commitCells: (entries) => vm.commitCells(entries),
            derive: (row) => (vm.derive ? vm.derive(row) : row),
            field: (key) => vm.resolved.fieldMap.get(key),
            delay: () => vm.writeDelay,
            modal: () => vm.$modal,
            // The page's @refresh listener (also forwarded to the renderer)
            refresh: () => vm.$emit('refresh')
        });
        return { instantEdits };
    },
    computed: {
        // Rows with instant edits overlaid (the cell shows the new value immediately)
        rowsView() {
            return this.instantEdits.overlay(this.rows);
        },
        urlParams() {
            if (!this.containerPath) return {};
            return NavigationRegistry.getNavigationParameters(this.containerPath) || {};
        },
        activeView() {
            const views = this.registry?.views || [];
            if (this.viewId) {
                const fixed = views.find(v => v.id === this.viewId);
                if (fixed) return fixed;
                devWarn(`registry "${this.registry?.id}": unknown fixed view id "${this.viewId}"`);
            }
            return pickView(this.registry, this.containerPath ? this.urlParams : {});
        },
        size() {
            return this._containerSize ? this._containerSize.tier.value : 'wide';
        },
        resolved() {
            const opts = { size: this.size, print: this.printing, patches: this.patches, editMode: this.editMode, theme: this.registry?.theme || '' };
            const r = resolveView(this.fields, this.activeView, opts);
            if (r.invalid) {
                // A view whose calendar fields are missing falls back to the default view
                const fallback = pickView(this.registry, {});
                if (fallback && fallback !== this.activeView) return resolveView(this.fields, fallback, opts);
            }
            return r;
        },
        layout() {
            return this.resolved.layout;
        },
        resolvedAction() {
            const base = resolveAction(this.action, this.resolved, this.editMode, { hasRowDetails: !!(this.$slots['row-details'] || this.$slots['row-detail-rows']) });
            return { ...base, perform: (row, ctx) => this.performAction(base, row, ctx) };
        },
        viewSelect() {
            const views = this.registry?.views || [];
            if (views.length < 2 || !this.containerPath || this.viewId) return null;
            return {
                views: views.map(v => ({ id: v.id, name: v.name, icon: v.icon })),
                currentId: this.resolved.viewId,
                defaultId: this.registry.default || views[0].id,
                containerPath: this.containerPath,
                navigateToPath: this.navigateToPath
            };
        },
        sortKey() {
            const sort = this.resolved.sort;
            if (Array.isArray(sort)) return sort.map(s => ({ key: s.key, direction: s.dir === 'desc' ? 'desc' : 'asc' }));
            return sort?.key || null;
        },
        // ── Cards layout ─────────────────────────────────────────────────────
        cardModels() {
            if (this.layout !== 'cards') return [];
            const r = this.resolved;
            if (r.cards?.bucketBy) {
                return bucketRowsToCards(this.rowsView, r, {
                    bucketKeys: this.bucketKeys,
                    bucketDecorations: this.bucketDecorations,
                    bucketLabel: this.bucketLabel,
                    bucketAppData: this.bucketAppData
                });
            }
            return rowsToCards(this.rowsView, r, { decorations: this.decorations, decorationKeys: this.decorationKeys });
        },
        cardSearchTiers() {
            return searchTiers(this.resolved);
        },
        fieldLabels() {
            const out = {};
            for (const f of this.resolved.fields) out[f.key] = f.label ?? f.key;
            return out;
        },
        cardSortColumns() {
            const r = this.resolved;
            if (r.cards?.bucketBy) return [{ key: 'title', label: r.fieldMap.get(r.cards.bucketBy)?.label || 'Title', type: 'string', sortable: true }];
            return r.fields
                .filter(f => f.sortable && !r.hidden.has(f.key))
                .map(f => ({ key: f.key, label: f.label ?? f.key, type: f.type || null, sortable: true }));
        },
        sortDir() {
            return this.resolved.sort?.dir === 'desc' ? 'desc' : 'asc';
        },
        // Structural class from the view, plus the full-width container mode (view.fullWidth)
        rendererClass() {
            return [this.resolved.className || '', this.resolved.fullWidth ? 'view-full-width' : ''].filter(Boolean).join(' ');
        }
    },
    watch: {
        // Drop saved overlays once the loaded rows carry the written value
        rows() {
            this.instantEdits.reconcile();
        }
    },
    created() {
        this._containerSize = useContainerSize();
        const removed = Object.keys(this.$attrs || {}).filter(k => REMOVED_PRESENTATION_PROPS.includes(k));
        if (removed.length) devWarn(`registry "${this.registry?.id}": removed presentation props passed to DataView (${removed.join(', ')}); presentation comes from the view`);
    },
    mounted() {
        this._containerSize.observe(this.$el instanceof Element ? this.$el : this.$el?.nextElementSibling);
        this.instantEdits.start();
    },
    beforeUnmount() {
        this._containerSize?.stop();
        // In-app navigation: write queued edits now
        this.instantEdits.stop();
    },
    methods: {
        performAction(action, row, ctx = {}) {
            if (!row) return;
            if (action.kind === 'navigate') {
                let path = null;
                try { path = action.to(row); } catch (e) { console.warn('[DataView] action.to failed', e); }
                if (!path) return;
                // Navigating actions pass the current search so the destination can reveal the match
                if (ctx.searchTerm) path = NavigationRegistry.buildPath(path, { searchTerm: ctx.searchTerm });
                const nav = this.navigateToPath || this.appContext?.navigateToPath;
                if (nav) nav(path);
                return;
            }
            if (action.kind === 'run') {
                action.run(row);
                return;
            }
            if (action.kind === 'details') {
                this.openDetails(row, ctx);
            }
        },
        // Details outside tables: RowDetailsModal with details fields plus the view's shown fields
        openDetails(row, ctx = {}) {
            if (!this.$modal) return;
            const r = this.resolved;
            const shownFields = r.shown.map(k => r.fieldMap.get(k)).filter(Boolean);
            const fields = [...shownFields, ...r.details];
            const rowDetailsSlot = this.$slots['row-details'];
            const title = this.detailsTitle
                ? this.detailsTitle(row)
                : (shownFields.map(f => row[f.key]).find(v => v != null && v !== '' && typeof v !== 'object') || 'Details');
            this.$modal.custom(RowDetailsModal, {
                row,
                fields,
                decorations: this.decorations,
                decorationKeys: this.decorationKeys,
                rowDetails: rowDetailsSlot ? (scope) => rowDetailsSlot(scope) : null,
                cellSlot: this.$slots.cell || null,
                searchTerm: ctx.searchTerm || '',
                theme: r.theme,
                size: 'page'
            }, String(title));
        }
    },
    template: html`
        <TableComponent
            v-if="layout === 'table'"
            key="dataview-table"
            v-bind="$attrs"
            :class="rendererClass"
            :resolved="resolved"
            :edit-mode="editMode"
            :data="rowsView"
            :original-data="originalData || []"
            :cell-state="editMode === 'instant' ? instantEdits.cellState : null"
            :cell-disabled="cellDisabled"
            @cell-commit="instantEdits.edit"
            :action="resolvedAction"
            :decorations="decorations"
            :decoration-keys="decorationKeys"
            :view-select="viewSelect"
            :hide-rows-on-search="resolved.table?.hideRowsOnSearch ?? $attrs.hideRowsOnSearch ?? $attrs['hide-rows-on-search'] ?? true"
            :container-path="containerPath"
            :navigate-to-path="navigateToPath"
        >
            <template v-for="(_, name) in $slots" #[name]="scope"><slot :name="name" v-bind="scope || {}"></slot></template>
        </TableComponent>
        <CalendarComponent
            v-else-if="layout === 'calendar'"
            key="dataview-calendar"
            v-bind="$attrs"
            :class="rendererClass"
            :resolved="resolved"
            :data="rowsView"
            :action="resolvedAction"
            :decorations="decorations"
            :decoration-keys="decorationKeys"
            :view-select="viewSelect"
            :container-path="containerPath"
            :navigate-to-path="navigateToPath"
        >
            <template v-for="(_, name) in $slots" #[name]="scope"><slot :name="name" v-bind="scope || {}"></slot></template>
        </CalendarComponent>
        <CardsComponent
            v-else-if="layout === 'cards'"
            key="dataview-cards"
            v-bind="$attrs"
            :class="rendererClass"
            :theme="resolved.theme"
            :cards="cardModels"
            :action="resolvedAction"
            :search-tiers="cardSearchTiers"
            :field-labels="fieldLabels"
            :view-select="viewSelect"
            :sort-columns="$attrs.sortColumns || $attrs['sort-columns'] || cardSortColumns"
            :default-sort-column="sortKey"
            :default-sort-direction="sortDir"
            :hide-cards-on-search="resolved.cards?.hideOnSearch !== false"
            :show-header="$attrs.showHeader ?? $attrs['show-header'] ?? true"
            :container-path="containerPath"
            :navigate-to-path="navigateToPath"
        >
            <template v-for="(_, name) in $slots" #[name]="scope"><slot :name="name" v-bind="scope || {}"></slot></template>
        </CardsComponent>
        <div v-else class="empty-message">This view's layout ({{ layout }}) is not available yet.</div>
    `
};
