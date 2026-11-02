import { html, NavigationRegistry, TableComponent, CalendarComponent, CardsComponent } from '../../index.js';
import { resolveView, resolveAction, pickView, devWarn, searchTiers } from '../../utils/views/resolveView.js';
import { rowsToCards, bucketRowsToCards } from '../../utils/views/cardsAdapter.js';
import { useContainerSize } from '../../utils/useContainerSize.js';
import { RowDetailsModal } from './rowDetailsComponent.js';
import { isCheckedValue } from '../../../data_management/utils/checkbox-values.js';

/** Delay before an instant edit is written; another edit to the same cell restarts it (§4.16). */
export const INSTANT_WRITE_DELAY_MS = 1200;

// Modal messages render as HTML: escape text that can carry sheet values
function escapeHtml(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Presentation props removed in Phase 5 (views-and-renderers-plan): presentation comes only from
 * the view. A page still passing one gets a dev warning (attrs are listed as written by the page).
 */
const REMOVED_PRESENTATION_PROPS = [
    'columns', 'hideColumns', 'hide-columns', 'viewModes', 'view-modes', 'chipColorClass', 'chip-color-class',
    'chipActions', 'chip-actions', 'onItemClick', 'on-item-click', 'items', 'defaultSortColumn', 'default-sort-column',
    'defaultSortDirection', 'default-sort-direction', 'theme', 'allowDetails', 'allow-details', 'onEventClick',
    'eventStartColumn', 'event-start-column', 'eventEndColumn', 'event-end-column', 'rowClass', 'row-class'
];

/**
 * DataView — the only producer of renderer presentation input (§3).
 *
 * The page supplies data and domain logic:
 *   fields     FieldDef[] (what each key is)
 *   rows       the rows to draw (a computed copy when derived fields exist)
 *   registry   { id, default, theme, views: ViewDef[] }
 *   action     ActionDef { to(row) | run(row), label, icon, disabled(row) }
 *   decorations(row, key) → Card[] with decorationKeys (the keys the page decorates)
 *   editMode   'none' | 'batch' | 'instant'
 *   patches    ViewPatch[] (customization input, §4.15)
 *   printing   applies the view's print variant
 *
 * DataView picks the view (?view=, legacy ?layout=, registry default; a fixed `viewId` for modals),
 * resolves it, resolves the primary action, and renders the renderer for the view's layout.
 * Everything else ($attrs: loading state, search options, listeners) and every slot is forwarded.
 *
 * Size: the container tier of the nearest size container (useContainerSize, same thresholds as
 * the CSS @container rules), so view variants and CSS switch together (R6.4).
 *
 * Instant edit mode (§4.16): registry cells emit cell-commit(row, key, value). DataView shows the
 * value at once on a local overlay and holds the write: one timer for the whole table restarts on
 * every edit, so edits made within INSTANT_WRITE_DELAY_MS of each other are written together. A
 * cell whose value returns to the loaded one is dropped. The batch goes to the page's
 * commitCells([{ row, key, value }]) → Promise<Array<{ ok, reason, warning }>> (or commitCell(row,
 * key, value) per cell when the page has no batch hook). One batch is in flight at a time.
 * Pending and failed cells get state classes; failures revert, show one error and ask the page to
 * refresh; warnings (another row may have changed) are shown too. Queued writes flush on unmount,
 * and a leave prompt guards closing the tab while writes are queued.
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
        commitCell: { type: Function, default: null },
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
    data() {
        return {
            // key "<rowId>::<field>" → { id, key, value, original, status: 'queued'|'writing'|'saved' }
            pendingCells: {},
            failedCells: {}
        };
    },
    computed: {
        // Rows with instant edits overlaid (the cell shows the new value immediately)
        rowsView() {
            const pending = Object.values(this.pendingCells);
            if (this.editMode !== 'instant' || !pending.length || !this.rowId) return this.rows;
            const byRow = new Map();
            for (const p of pending) {
                if (!byRow.has(p.id)) byRow.set(p.id, {});
                byRow.get(p.id)[p.key] = p.value;
            }
            return this.rows.map(r => {
                const over = byRow.get(this.rowId(r));
                if (!over) return r;
                const merged = { ...r, ...over };
                return this.derive ? this.derive(merged) : merged;
            });
        },
        hasQueuedWrites() {
            return Object.values(this.pendingCells).some(p => p.status === 'queued' || p.status === 'writing');
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
            if (!this.rowId) return;
            for (const [k, p] of Object.entries(this.pendingCells)) {
                if (p.status !== 'saved') continue;
                const row = this.rows.find(r => this.rowId(r) === p.id);
                if (!row || this.sameCellValue(p.key, row[p.key], p.value)) delete this.pendingCells[k];
            }
        }
    },
    created() {
        this._containerSize = useContainerSize();
        const removed = Object.keys(this.$attrs || {}).filter(k => REMOVED_PRESENTATION_PROPS.includes(k));
        if (removed.length) devWarn(`registry "${this.registry?.id}": removed presentation props passed to DataView (${removed.join(', ')}); presentation comes from the view`);
    },
    mounted() {
        this._containerSize.observe(this.$el instanceof Element ? this.$el : this.$el?.nextElementSibling);
        this._onBeforeUnload = (e) => {
            if (!this.hasQueuedWrites) return;
            this.flushAll();
            e.preventDefault();
            e.returnValue = '';
            return '';
        };
        window.addEventListener('beforeunload', this._onBeforeUnload);
    },
    beforeUnmount() {
        this._containerSize?.stop();
        window.removeEventListener('beforeunload', this._onBeforeUnload);
        // In-app navigation: write queued edits now
        this.flushAll();
    },
    methods: {
        // ── Instant edit queue ───────────────────────────────────────────────
        sameCellValue(key, a, b) {
            const field = this.resolved.fieldMap.get(key);
            if (field && (field.type === 'checkbox' || field.cell === 'checkbox')) return isCheckedValue(a) === isCheckedValue(b);
            return String(a ?? '').trim() === String(b ?? '').trim();
        },
        loadedRow(id) {
            return this.rows.find(r => this.rowId(r) === id) || null;
        },
        onCellCommit(row, key, value) {
            if (this.editMode !== 'instant' || !this.rowId || !(this.commitCells || this.commitCell)) return;
            const id = this.rowId(row);
            const k = id + '::' + key;
            const existing = this.pendingCells[k];
            if (existing && existing.status === 'writing') {
                // A write is in flight: queue the newer value behind it
                existing.next = value;
                existing.value = value;
                return;
            }
            const loaded = this.loadedRow(id);
            // What the sheet holds now: a saved entry's value (the reload may not have arrived yet),
            // a queued entry's original, or the loaded value
            const original = existing
                ? (existing.status === 'saved' ? existing.value : existing.original)
                : (loaded ? loaded[key] : undefined);
            delete this.failedCells[k];
            if (this.sameCellValue(key, value, original)) {
                // Back to the loaded value within the delay: nothing is written
                delete this.pendingCells[k];
            } else {
                this.pendingCells[k] = { id, key, value, original, status: 'queued', row: loaded || row };
            }
            this.scheduleFlush();
        },
        // One timer for the table: every edit restarts it, so nearby edits share a batch
        scheduleFlush() {
            clearTimeout(this._flushTimer);
            this._flushTimer = setTimeout(() => this.flushAll(), this.writeDelay);
        },
        // Write every queued cell as one batch (after the batch in flight, if any)
        async flushAll() {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
            if (this._flushing) { this._flushAgain = true; return this._flushing; }
            const keys = Object.keys(this.pendingCells).filter(k => this.pendingCells[k].status === 'queued');
            if (!keys.length) return;
            this._flushing = this.writeBatch(keys);
            try { await this._flushing; } finally { this._flushing = null; }
            if (this._flushAgain) { this._flushAgain = false; await this.flushAll(); }
        },
        async writeBatch(keys) {
            const entries = keys.map(k => this.pendingCells[k]);
            const values = entries.map(e => e.value);
            entries.forEach(e => { e.status = 'writing'; });
            let results;
            try {
                if (this.commitCells) {
                    results = await this.commitCells(entries.map((e, n) => ({ row: e.row, key: e.key, value: values[n] })));
                } else {
                    results = await Promise.all(entries.map((e, n) => Promise.resolve(this.commitCell(e.row, e.key, values[n]))
                        .catch(err => ({ ok: false, reason: err?.message || 'error' }))));
                }
            } catch (e) {
                results = entries.map(() => ({ ok: false, reason: e?.message || 'error' }));
            }
            const failures = [];
            const warnings = [];
            let requeued = false;
            keys.forEach((k, n) => {
                const result = Array.isArray(results) ? results[n] : null;
                if (result?.warning) warnings.push(escapeHtml(result.warning));
                const current = this.pendingCells[k];
                if (!current) return;
                if (result && result.ok) {
                    if (current.next !== undefined && !this.sameCellValue(current.key, current.next, values[n])) {
                        // A newer edit arrived during the write: write it next
                        const next = current.next;
                        delete current.next;
                        current.original = values[n];
                        current.value = next;
                        current.status = 'queued';
                        requeued = true;
                    } else {
                        current.status = 'saved';
                        // Safety: drop the overlay even if the reload never arrives
                        setTimeout(() => { if (this.pendingCells[k]?.status === 'saved') delete this.pendingCells[k]; }, 20000);
                    }
                    return;
                }
                // Failure: revert and mark failed
                delete this.pendingCells[k];
                this.failedCells[k] = true;
                setTimeout(() => { delete this.failedCells[k]; }, 6000);
                const field = this.resolved.fieldMap.get(current.key);
                failures.push(escapeHtml(`${field?.label || current.key}: ${this.describeFailure(result?.reason)}`));
            });
            if (requeued) this.scheduleFlush();
            if (failures.length) {
                // The modal renders its message as HTML (newlines become line breaks); parts are escaped
                const list = failures.length === 1 ? failures[0] : failures.map(f => `• ${f}`).join('\n');
                const head = failures.length === 1 ? 'Could not save ' : `Could not save ${failures.length} changes:\n`;
                const extra = warnings.length ? `\n\n${warnings.join('\n')}` : '';
                this.$modal?.error?.(`${head}${list}.\nThe values were reverted and the data refreshed.${extra}`, 'Save failed');
                // Ask the page to refresh (its @refresh listener is forwarded to the renderer via $attrs)
                const onRefresh = this.$attrs.onRefresh;
                if (typeof onRefresh === 'function') onRefresh(); else if (Array.isArray(onRefresh)) onRefresh.forEach(fn => fn());
            } else if (warnings.length) {
                this.$modal?.alert?.(warnings.join('\n'), 'Check the sheet', false);
            }
        },
        describeFailure(reason) {
            const map = {
                'no-config': 'this table has no instant-write setup (InstantWriteTables preference)',
                'column-not-writable': 'this column is not listed as writable',
                'column-missing': 'the column was not found in the sheet',
                'not-found': 'the row was not found in the sheet',
                'duplicate': 'more than one row has this identity',
                'no-identity-columns': 'the identity columns were not found in the sheet',
                'moved': 'the row kept moving while saving',
                'verify-failed': 'the saved value did not read back correctly',
                'superseded': 'a later edit to the same cell replaced it'
            };
            return map[reason] || reason || 'unknown error';
        },
        cellStateFor(row, key) {
            if (!this.rowId) return '';
            const k = this.rowId(row) + '::' + key;
            if (this.failedCells[k]) return 'failed';
            const p = this.pendingCells[k];
            if (p && (p.status === 'queued' || p.status === 'writing')) return 'pending';
            return '';
        },
        performAction(action, row, ctx = {}) {
            if (!row) return;
            if (action.kind === 'navigate') {
                let path = null;
                try { path = action.to(row); } catch (e) { console.warn('[DataView] action.to failed', e); }
                if (!path) return;
                // Navigating actions pass the current search so the destination can reveal the match (R3.8)
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
            :cell-state="editMode === 'instant' ? cellStateFor : null"
            :cell-disabled="cellDisabled"
            @cell-commit="onCellCommit"
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
