import { html, Requests, DataView, getReactiveStore, invalidateCache, ScheduleFilterSelect } from '../../index.js';
import { buildScheduleFields } from '../../../data_management/abstraction/scheduleFields.js';
import { isCheckedValue } from '../../../data_management/utils/checkbox-values.js';
import { instantWriteEntry, isInstantColumn, identityKey, identityText, columnText } from '../../../data_management/utils/instant-write-config.js';
import { textFiltersToSearchParams } from '../../../data_management/utils/helpers.js';
import { shipReturnAnalysis, withShipDate, shipReturnCards, SHIP_RETURN_DECORATION_KEYS } from '../../utils/scheduleShipping.js';

/**
 * Design queue (views-and-renderers-plan §4.16).
 *
 * A page under Schedule (route schedule/design-queue) that shares the Schedule data and fields
 * (scheduleFields.js) but has its own purpose: track design work per show.
 *
 *  - editMode 'instant': edits to the instant-write columns are verified writes after a short
 *    delay. Edits made close together go as one batch (DataView queue → commitCells →
 *    Requests.writeCellsVerified for Schedule columns, saveShowNote for each note).
 *  - The InstantWriteTables preference names the row identity and the columns written
 *    immediately. Each column's cell comes from the data: a select when the page has options for
 *    it (Assignee, from DesignQueueAssignees), a checkbox when the sheet's values are checkbox
 *    values, text otherwise. The shown columns come from DesignQueueFields (a view patch).
 *  - Note is not a Schedule column: it is joined from CACHE/ShowNotes by computeIdentifier.
 *  - Rows whose Setups is checked (X) stay in place and turn gray via a derived colour field
 *    (_rowColor) recomputed from the local row, so the row grays as soon as the box is clicked.
 *  - Ship shows the estimated ship date (sorted ascending); the initial filter is the
 *    "Upcoming" schedule search.
 * The Schedule page itself stays read-only.
 */

const DQ_DATABASE = 'PROD_SCHED';
const DQ_TAB = 'Production Schedule';

// Code default for the shown columns; the DesignQueueFields preference patches it.
export const DESIGN_QUEUE_DEFAULT_FIELDS = Object.freeze(['Client', 'Show', 'Size', 'Note', 'Elev', 'Panels', 'Setups', 'Assignee', 'Account Manager', 'Ship', 'Booth#']);
// Instant columns assumed when the InstantWriteTables preference is missing (they render read-only).
const DEFAULT_INSTANT_COLUMNS = Object.freeze(['Elev', 'Panels', 'Setups', 'Assignee']);
// Row identity when the preference is missing (the Schedule's show identity)
const DEFAULT_IDENTITY = Object.freeze(['Client', 'Year', 'Show']);
// The row turns gray when this column is checked
const DONE_COLUMN = 'Setups';

const DESIGN_QUEUE_VIEWS = {
    id: 'design-queue',
    default: 'table',
    theme: 'gray',
    views: [
        {
            id: 'table',
            name: 'Design Queue',
            icon: 'table',
            layout: 'table',
            columns: [...DESIGN_QUEUE_DEFAULT_FIELDS],
            hidden: ['_rowColor', '_identifier'],
            sort: { key: 'Ship', dir: 'asc' },
            rowColor: { field: '_rowColor', rule: 'value' },
            fullWidth: true,
            table: { hideRowsOnSearch: false },
            // Every column but Note has a width, so Note takes the rest of the row (and wraps)
            style: {
                Client: { width: 110 },
                Show: { width: 140 },
                Size: { width: 70, font: 'narrow' },
                Elev: { width: 56, font: 'narrow' },
                Panels: { width: 56, font: 'narrow' },
                Setups: { width: 56, font: 'narrow' },
                Assignee: { width: 120 },
                'Account Manager': { width: 120 },
                Ship: { width: 110, color: 'auto' },
                'Booth#': { width: 80 }
            }
        }
    ]
};

// Notes belong to a show (computeIdentifier inputs), whatever the row identity is
const SHOW_IDENTITY = Object.freeze(['Client', 'Year', 'Show']);
function showKey(row) {
    return identityKey(SHOW_IDENTITY, k => row?.[k]);
}


export const DesignQueueContent = {
    name: 'DesignQueueContent',
    components: { DataView, ScheduleFilterSelect },
    inject: ['$modal'],
    props: {
        containerPath: { type: String, default: 'schedule/design-queue' },
        navigateToPath: { type: Function, default: null }
    },
    data() {
        return {
            filter: null,
            scheduleStore: null,
            prefsStore: null,
            notesStore: null,
            kindsStore: null,
            identifiers: {},            // showKey → computeIdentifier result
            DESIGN_QUEUE_VIEWS,
            SHIP_RETURN_DECORATION_KEYS
        };
    },
    computed: {
        basePath() {
            return (this.containerPath || 'schedule/design-queue').split('?')[0];
        },
        prefs() {
            return this.prefsStore?.data || [];
        },
        jsonPref() {
            return (id, fallback) => {
                const p = this.prefs.find(x => x.id === id);
                if (!p || p.value === undefined || p.value === '') return fallback;
                try { return JSON.parse(p.value); } catch { return fallback; }
            };
        },
        // { identity, columns } from InstantWriteTables, or null (cells then render read-only)
        instantConfig() {
            return instantWriteEntry(this.jsonPref('InstantWriteTables', {}), DQ_DATABASE, DQ_TAB);
        },
        instantColumns() {
            return this.instantConfig?.columns || DEFAULT_INSTANT_COLUMNS;
        },
        identity() {
            return this.instantConfig?.identity || DEFAULT_IDENTITY;
        },
        assignees() {
            const list = this.jsonPref('DesignQueueAssignees', []);
            return Array.isArray(list) ? list.map(String) : [];
        },
        // Options lists the page has for select cells, by column
        selectOptions() {
            return { assignee: this.assignees };
        },
        // DesignQueueFields preference → one view patch (affects only this page)
        patches() {
            const cols = this.jsonPref('DesignQueueFields', null);
            return Array.isArray(cols) && cols.length ? [{ patch: { columns: cols } }] : [];
        },
        rawRows() {
            return this.scheduleStore?.data || [];
        },
        // What each column holds, from the whole sheet (cached); null until it loads
        columnKinds() {
            const sheet = this.kindsStore?.data;
            if (!Array.isArray(sheet) || !sheet.length) return null;
            return Object.fromEntries(sheet.map(k => [columnText(k.column), k.kind]));
        },
        // FieldDefs: Schedule fields, instant cells typed by their data, the joined Note, derived fields
        fields() {
            const base = buildScheduleFields(this.rawRows, { packlist: false });
            if (!this.rawRows.length) {
                // Before data loads, keep the default columns so the header renders without warnings
                const have = new Set(base.map(f => f.key));
                for (const key of DESIGN_QUEUE_DEFAULT_FIELDS) if (!have.has(key) && key !== 'Note') base.push({ key, label: key });
            }
            const keys = new Set(base.map(f => columnText(f.key)));
            const fields = base.map(f => {
                if (!isInstantColumn({ columns: this.instantColumns }, f.key)) return f;
                const type = this.cellTypeFor(f.key);
                const field = { ...f, cell: type, editable: true, sortable: f.sortable || type === 'select' };
                if (type === 'select') field.cellOptions = { options: this.selectOptions[columnText(f.key)] || [] };
                return field;
            });
            for (const col of this.instantColumns) {
                if (!keys.has(columnText(col)) && this.rawRows.length) console.warn(`[DesignQueue] instant-write column "${col}" is not in the sheet; skipped`);
            }
            if (!keys.has('note')) fields.push({ key: 'Note', label: 'Note', cell: 'text', editable: true, cellOptions: { placeholder: 'Add a note' } });
            fields.push({ key: '_rowColor', label: 'Row colour' }, { key: '_identifier', label: 'Identifier' });
            return fields;
        },
        showKeyList() {
            return this.rawRows.map(showKey).join(';;');
        },
        notesByIdentifier() {
            const map = new Map();
            for (const n of this.notesStore?.data || []) {
                if (n?.Identifier) map.set(identityText(n.Identifier), n.Note ?? '');
            }
            return map;
        },
        // Identities shared by more than one loaded row (writes to those rows are refused)
        duplicateIdentities() {
            const seen = new Map();
            for (const r of this.rawRows) {
                const k = this.rowId(r);
                seen.set(k, (seen.get(k) || 0) + 1);
            }
            return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
        },
        rows() {
            const sheetHasNote = this.rawRows.length && Object.prototype.hasOwnProperty.call(this.rawRows[0], 'Note');
            if (sheetHasNote) console.warn('[DesignQueue] the Schedule sheet has its own Note column; the sheet value wins over CACHE/ShowNotes');
            return this.rawRows.map(row => {
                const identifier = this.identifiers[showKey(row)] || '';
                // Ship shows (and sorts by) the estimated ship date; transship rows the source show's end
                const out = { ...withShipDate(row), _identifier: identifier };
                if (!sheetHasNote) out.Note = identifier ? (this.notesByIdentifier.get(identityText(identifier)) ?? '') : '';
                return this.deriveRow(out);
            });
        },
        // Decorations: the shared transship cards on Ship (and Recieved, when shown)
        decorations() {
            return (row, key) => shipReturnCards(row, key, this.$modal);
        },
        isLoading() {
            return !!this.scheduleStore?.isLoading;
        },
        isAnalyzing() {
            return !!this.scheduleStore?.isAnalyzing;
        },
    },
    watch: {
        filter: {
            handler(newFilter, oldFilter) {
                if (JSON.stringify(newFilter) !== JSON.stringify(oldFilter)) this.createScheduleStore();
            },
            deep: true
        },
        // Resolve show identifiers (for notes) whenever the set of rows changes; the store may fill its array in place
        showKeyList: {
            handler() { this.resolveIdentifiers(); },
            immediate: true
        }
    },
    mounted() {
        this.prefsStore = getReactiveStore(Requests.getPreferences, null, []);
        this.notesStore = getReactiveStore(Requests.getShowNotes, null, []);
        this.kindsStore = getReactiveStore(Requests.getColumnKinds, null, [DQ_DATABASE, DQ_TAB]);
    },
    methods: {
        // Cell for an instant-write column: select (page options), checkbox (the data), else text
        cellTypeFor(key) {
            const k = columnText(key);
            if (this.selectOptions[k]) return 'select';
            return this.columnKinds?.[k] === 'checkbox' ? 'checkbox' : 'text';
        },
        // Derived fields recomputed from the (local) row: the row turns gray when Setups is checked
        deriveRow(row) {
            return { ...row, _rowColor: isCheckedValue(row[DONE_COLUMN]) ? 'gray' : '' };
        },
        // Row identity: the preference's identity columns (Client + Year + Show by default)
        rowId(row) {
            return identityKey(this.identity, k => row?.[k]);
        },
        cellDisabled(row, key) {
            if (key === 'Note') return row._identifier ? '' : 'write disabled: no show identifier yet';
            if (!isInstantColumn({ columns: this.instantColumns }, key)) return '';
            if (!this.instantConfig) return 'write disabled: no row identity';
            // Until the column kinds load, a column's cell type isn't known (shown read-only)
            if (!this.columnKinds && !this.selectOptions[columnText(key)]) return 'write disabled: loading column types';
            if (this.duplicateIdentities.has(this.rowId(row))) return 'write disabled: duplicate row identity';
            return '';
        },
        // The sheet row behind a shown row (identity values as the sheet has them)
        sheetRow(row) {
            const id = row?.AppData?._rowId;
            return (id && this.rawRows.find(r => r?.AppData?._rowId === id)) || row;
        },
        // Routing writes: Note → saveShowNote (one upsert per note); every other column
        // → one verified batch (writeCellsVerified). Results come back in entry order.
        async commitCells(entries) {
            const results = new Array(entries.length);
            const batch = [];
            entries.forEach((e, n) => { if (e.key !== 'Note') batch.push(n); });
            const scheduleWrite = batch.length
                ? Requests.writeCellsVerified(DQ_DATABASE, DQ_TAB, batch.map(n => ({ row: this.sheetRow(entries[n].row), column: entries[n].key, value: entries[n].value })))
                    .catch(err => batch.map(() => ({ ok: false, reason: err?.message || 'error' })))
                : Promise.resolve([]);
            for (let n = 0; n < entries.length; n++) {
                const e = entries[n];
                if (e.key !== 'Note') continue;
                results[n] = e.row._identifier
                    ? await Requests.saveShowNote(e.row._identifier, e.value)
                    : { ok: false, reason: 'no-identifier' };
            }
            const written = await scheduleWrite;
            batch.forEach((n, k) => { results[n] = written[k] || { ok: false, reason: 'no-result' }; });
            return results;
        },
        async resolveIdentifiers() {
            for (const row of this.rawRows) {
                const k = showKey(row);
                if (this.identifiers[k] !== undefined) continue;
                this.identifiers[k] = '';
                try {
                    const id = await Requests.computeIdentifier(row.Show, row.Client, row.Year);
                    this.identifiers[k] = id || '';
                } catch {
                    this.identifiers[k] = '';
                }
            }
        },
        createScheduleStore() {
            if (this.filter === null) {
                this.scheduleStore = null;
                return;
            }
            const { searchParams, ...dateFilter } = this.filter || {};
            // Ship and return info, shared with the Schedule page (same cached analysis calls)
            const analysisConfig = shipReturnAnalysis();
            this.scheduleStore = getReactiveStore(
                Requests.getProductionScheduleData,
                null,
                [Object.keys(dateFilter).length ? dateFilter : null, searchParams && Object.keys(searchParams).length ? searchParams : null],
                analysisConfig
            );
        },
        handleSearchSelected(searchData) {
            if (!searchData) {
                this.filter = null;
                return;
            }
            const filter = { searchParams: textFiltersToSearchParams(searchData.textFilters) };
            if (searchData.dateFilters && searchData.dateFilters.length > 0) {
                filter.dateFilters = searchData.dateFilters;
            }
            this.filter = filter;
        },
        handleRefresh() {
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['PROD_SCHED'] },
                { namespace: 'database', methodName: 'getData', args: ['CACHE', 'ShowNotes'] },
                { namespace: 'database', methodName: 'getData', args: ['CACHE', 'Preferences'] }
            ], true);
        }
    },
    template: html`
        <div class="design-queue-page">
            <DataView
                :fields="fields"
                :rows="rows"
                :registry="DESIGN_QUEUE_VIEWS"
                :patches="patches"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
                edit-mode="instant"
                :commit-cells="commitCells"
                :decorations="decorations"
                :decoration-keys="SHIP_RETURN_DECORATION_KEYS"
                :row-id="rowId"
                :cell-disabled="cellDisabled"
                :derive="deriveRow"
                :is-loading="isLoading"
                :is-analyzing="isAnalyzing"
                :loading-progress="scheduleStore ? scheduleStore.analysisProgress : -1"
                :error="scheduleStore ? scheduleStore.error : null"
                :show-refresh="true"
                title="Design Queue"
                :empty-message="filter === null ? 'Select a schedule filter to load shows.' : 'No shows found.'"
                loading-message="Loading schedule..."
                :show-search="true"
                :sync-search-with-url="true"
                @refresh="handleRefresh"
            >
                <template #header-area>
                    <div class="button-bar">
                        <ScheduleFilterSelect
                            :container-path="basePath"
                            :navigate-to-path="navigateToPath"
                            :show-advanced-button="true"
                            @search-selected="handleSearchSelected"
                        />
                    </div>
                </template>
            </DataView>
        </div>
    `
};
