import { html, Requests, DataView, getReactiveStore, invalidateCache, ScheduleFilterSelect, createAnalysisConfig, Priority } from '../../index.js';
import { buildScheduleFields } from '../../../data_management/abstraction/scheduleFields.js';
import { isInstantColumn, identityKey, columnText } from '../../../data_management/utils/instant-write-config.js';
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
 *  - Setup (Requests.getDesignQueueSetup, one store): the InstantWriteTables preference names the
 *    row identity and the columns written immediately; the ColumnTypes preference says what each
 *    column holds, and the table draws an editable column's cell from that type (checkbox,
 *    select, else text). A select names its option list; this page supplies its lists by name
 *    (optionLists: DesignQueueAssignees from preferences). The DesignQueueFields preference
 *    chooses which columns show; the view orders them. Until setup loads, instant cells render
 *    read-only.
 *  - Note is not a Schedule column: a per-row analysis on the schedule store reads it from
 *    CACHE/ShowNotes by computeIdentifier (Requests.getShowNoteForRow). It keeps the last note
 *    while refreshing, and re-runs when the notes tab changes.
 *  - Rows whose Setups is checked (X) stay in place and turn gray: a view colour rule
 *    (rowColor 'checked:gray') on the shown row, so the row grays as soon as the box is clicked.
 *  - Ship shows the estimated ship date (sorted ascending); the initial filter is the
 *    "Upcoming" schedule search.
 * The Schedule page itself stays read-only.
 */

const DQ_DATABASE = 'PROD_SCHED';
const DQ_TAB = 'Production Schedule';

// The shown columns, in order. The DesignQueueFields preference may choose a subset (or add
// columns, which follow these); it never reorders them.
export const DESIGN_QUEUE_DEFAULT_FIELDS = Object.freeze(['Client', 'Show', 'Size', 'Note', 'Elev', 'Panels', 'Setups', 'Assignee', 'Account Manager', 'Ship', 'Booth#']);
// Instant columns assumed when the InstantWriteTables preference is missing (they render read-only).
const DEFAULT_INSTANT_COLUMNS = Object.freeze(['Elev', 'Panels', 'Setups', 'Assignee']);
// Row identity when the preference is missing (the Schedule's show identity)
const DEFAULT_IDENTITY = Object.freeze(['Client', 'Year', 'Show']);

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
            hidden: ['_identifier'],
            sort: { key: 'Ship', dir: 'asc' },
            sortable: ['Client', 'Show', 'Size', 'Ship', 'Assignee'],
            // A row whose Setups is checked turns gray (and stays in place)
            rowColor: { field: 'Setups', rule: 'checked:gray' },
            fullWidth: true,
            table: { hideRowsOnSearch: false },
            // Every column but Note has a width, so Note takes the rest of the row (and wraps)
            style: {
                Note: { cellOptions: { placeholder: 'Add a note' } },
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

// Each row's show note ({ identifier, note } in AppData.showNote). Notes belong to a show
// (computeIdentifier inputs), whatever the row identity is. A function: index.js exports are
// not ready at module evaluation.
function showNoteAnalysis() {
    return {
        ...createAnalysisConfig(
            Requests.getShowNoteForRow,
            'showNote',
            'Loading show notes...',
            ['Show', 'Client', 'Year'],
            [],
            null,
            false,
            Priority.ANALYSIS,
            true // extractColumnsAsObject
        ),
        keepWhileRefreshing: true
    };
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
            setupStore: null,
            DESIGN_QUEUE_VIEWS,
            SHIP_RETURN_DECORATION_KEYS
        };
    },
    computed: {
        basePath() {
            return (this.containerPath || 'schedule/design-queue').split('?')[0];
        },
        // Preferences and column kinds (Requests.getDesignQueueSetup); null until loaded
        setup() {
            return this.setupStore?.data?.[0] || null;
        },
        // { identity, columns } from InstantWriteTables, or null (cells then render read-only)
        instantConfig() {
            return this.setup?.instant || null;
        },
        instantColumns() {
            return this.instantConfig?.columns || DEFAULT_INSTANT_COLUMNS;
        },
        identity() {
            return this.instantConfig?.identity || DEFAULT_IDENTITY;
        },
        // Option lists for select columns, by the name ColumnTypes gives them ({ "options": "<list name>" }).
        // options are the allowed values (data); colors (option → colour word) are presentation.
        optionLists() {
            return {
                DesignQueueAssignees: { options: this.setup?.assignees || [], colors: this.setup?.assigneeColors || {} }
            };
        },
        // View patches from preferences (this page only):
        //  - DesignQueueFields chooses the shown columns. The view orders them; chosen columns the
        //    view doesn't list follow, in the preference's order.
        //  - Each select column's option colours (from its option list) style its cell.
        patches() {
            const patches = [];
            const chosen = this.setup?.fields;
            if (chosen) {
                const wanted = new Set(chosen.map(columnText));
                const inView = new Set(DESIGN_QUEUE_DEFAULT_FIELDS.map(columnText));
                const columns = [
                    ...DESIGN_QUEUE_DEFAULT_FIELDS.filter(k => wanted.has(columnText(k))),
                    ...chosen.filter(k => !inView.has(columnText(k)))
                ];
                patches.push({ patch: { columns } });
            }
            const style = {};
            for (const f of this.fields) {
                const colors = f.type === 'select' ? this.optionLists[f.optionList]?.colors : null;
                if (colors && Object.keys(colors).length) style[f.key] = { cellOptions: { colors } };
            }
            if (Object.keys(style).length) patches.push({ patch: { style } });
            return patches;
        },
        rawRows() {
            return this.scheduleStore?.data || [];
        },
        // FieldDefs: Schedule fields typed by ColumnTypes (a select gets its list's values),
        // instant columns editable, the Note, derived fields
        fields() {
            const base = buildScheduleFields(this.rawRows, { packlist: false, types: this.setup?.types });
            if (!this.rawRows.length) {
                // Before data loads, keep the default columns so the header renders without warnings
                const have = new Set(base.map(f => f.key));
                for (const key of DESIGN_QUEUE_DEFAULT_FIELDS) if (!have.has(key) && key !== 'Note') base.push({ key, label: key });
            }
            const keys = new Set(base.map(f => columnText(f.key)));
            const fields = base.map(f => {
                const field = isInstantColumn({ columns: this.instantColumns }, f.key) ? { ...f, editable: true } : f;
                if (f.type !== 'select') return field;
                const list = this.optionLists[f.optionList];
                if (!list) console.warn(`[DesignQueue] no option list "${f.optionList}" for select column "${f.key}"`);
                return { ...field, options: list?.options || [] };
            });
            for (const col of this.instantColumns) {
                if (!keys.has(columnText(col)) && this.rawRows.length) console.warn(`[DesignQueue] instant-write column "${col}" is not in the sheet; skipped`);
            }
            if (!keys.has('note')) fields.push({ key: 'Note', label: 'Note', editable: true });
            fields.push({ key: '_identifier', label: 'Identifier' });
            return fields;
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
                // null until the row's note analysis has run
                const showNote = row.AppData?.showNote || null;
                // Ship shows (and sorts by) the estimated ship date; transship rows the source show's end
                const out = { ...withShipDate(row), _identifier: showNote?.identifier || '' };
                if (!sheetHasNote) out.Note = showNote ? showNote.note : null;
                return out;
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
        }
    },
    mounted() {
        this.setupStore = getReactiveStore(Requests.getDesignQueueSetup, null, [DQ_DATABASE, DQ_TAB]);
    },
    methods: {
        // Row identity: the preference's identity columns (Client + Year + Show by default)
        rowId(row) {
            return identityKey(this.identity, k => row?.[k]);
        },
        cellDisabled(row, key) {
            if (key === 'Note') {
                if (row._identifier) return '';
                return row.Note === null ? 'write disabled: loading the note' : 'write disabled: no show identifier';
            }
            if (!isInstantColumn({ columns: this.instantColumns }, key)) return '';
            // Until setup loads, a column's type (and so its cell) isn't known: shown read-only
            if (!this.setup) return 'write disabled: loading setup';
            if (!this.instantConfig) return 'write disabled: no row identity';
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
        createScheduleStore() {
            if (this.filter === null) {
                this.scheduleStore = null;
                return;
            }
            const { searchParams, ...dateFilter } = this.filter || {};
            // Show notes first, then ship and return info shared with the Schedule page (same cached analysis calls)
            const analysisConfig = [showNoteAnalysis(), ...shipReturnAnalysis()];
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
