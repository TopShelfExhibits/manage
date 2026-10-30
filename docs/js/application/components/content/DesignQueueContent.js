import { html, Requests, DataView, getReactiveStore, createAnalysisConfig, invalidateCache, Priority, ScheduleFilterSelect } from '../../index.js';
import { buildScheduleFields } from '../../../data_management/abstraction/scheduleFields.js';
import { isCheckedValue } from '../../../data_management/utils/checkbox-values.js';
import { normalizeFilterValues } from '../../../data_management/utils/helpers.js';

/**
 * Design queue — views-and-renderers-plan Phase 2 (R6.1, R7.1, R8.1, R8.2).
 *
 * A page under Schedule (route schedule/design-queue) that shares the Schedule data and fields
 * (scheduleFields.js) but has its own purpose: track design work per show.
 *
 *  - editMode 'instant': each checkbox / select / note edit is one verified single-cell write
 *    after a short delay (DataView queue → commitCell → Requests.writeCellVerified / saveShowNote).
 *  - Writable columns and row identity come from the InstantWriteTables preference; the shown
 *    columns from DesignQueueFields (a view patch); Assignee options from DesignQueueAssignees.
 *  - Note is not a Schedule column: it is joined from CACHE/ShowNotes by computeIdentifier.
 *  - Completed rows (Elev, Panels and Setups each X, - or N/a) stay in place and turn gray via
 *    a derived colour field (_rowColor) recomputed from the local row.
 *  - Sorted by Ship ascending; the initial filter is the "Upcoming" schedule search.
 * The Schedule page itself stays read-only.
 */

const DQ_DATABASE = 'PROD_SCHED';
const DQ_TAB = 'Production Schedule';

// Code default for the shown columns; the DesignQueueFields preference patches it.
export const DESIGN_QUEUE_DEFAULT_FIELDS = Object.freeze(['Client', 'Show', 'Size', 'Elev', 'Panels', 'Setups', 'Assignee', 'Account Manager', 'Ship', 'Note', 'Booth#']);
// Instant cells assumed when the InstantWriteTables preference is missing (they render read-only).
const DEFAULT_INSTANT_COLUMNS = Object.freeze({ Elev: 'checkbox', Panels: 'checkbox', Setups: 'checkbox', Assignee: 'select' });
const TASK_COLUMNS = Object.freeze(['Elev', 'Panels', 'Setups']);
// For the gray "completed" rule only: '-' and 'N/a' count as done (the cell still shows unchecked)
const DONE_VALUES = Object.freeze(['x', 'true', '-', 'n/a']);

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
            style: {
                Client: { width: 150 },
                Show: { width: 200 },
                Elev: { width: 60, font: 'narrow' },
                Panels: { width: 60, font: 'narrow' },
                Setups: { width: 60, font: 'narrow' },
                Assignee: { width: 140 },
                'Account Manager': { width: 150 },
                Ship: { width: 120, color: 'auto' },
                Note: { width: 250 }
            }
        }
    ]
};

function identityKey(row) {
    return ['Client', 'Year', 'Show'].map(k => String(row?.[k] ?? '').trim().toLowerCase()).join('|');
}

function isTaskDone(value) {
    return DONE_VALUES.includes(String(value ?? '').trim().toLowerCase());
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
            identifiers: {},            // identityKey → computeIdentifier result
            DESIGN_QUEUE_VIEWS
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
        instantConfig() {
            const all = this.jsonPref('InstantWriteTables', {});
            const entry = all && all[`${DQ_DATABASE}/${DQ_TAB}`];
            if (!entry || !Array.isArray(entry.identity) || !entry.identity.length || !entry.columns) return null;
            return entry;
        },
        instantColumns() {
            return this.instantConfig?.columns || DEFAULT_INSTANT_COLUMNS;
        },
        assignees() {
            const list = this.jsonPref('DesignQueueAssignees', []);
            return Array.isArray(list) ? list.map(String) : [];
        },
        // DesignQueueFields preference → one view patch (affects only this page, R7.2)
        patches() {
            const cols = this.jsonPref('DesignQueueFields', null);
            return Array.isArray(cols) && cols.length ? [{ patch: { columns: cols } }] : [];
        },
        rawRows() {
            return this.scheduleStore?.data || [];
        },
        // FieldDefs: Schedule fields, instant cells from the preference, the joined Note, derived fields
        fields() {
            const base = buildScheduleFields(this.rawRows, { packlist: false });
            if (!this.rawRows.length) {
                // Before data loads, keep the default columns so the header renders without warnings
                const have = new Set(base.map(f => f.key));
                for (const key of DESIGN_QUEUE_DEFAULT_FIELDS) if (!have.has(key) && key !== 'Note') base.push({ key, label: key });
            }
            const keys = new Set(base.map(f => f.key));
            const fields = base.map(f => {
                const type = Object.entries(this.instantColumns).find(([c]) => c.trim().toLowerCase() === f.key.trim().toLowerCase())?.[1];
                if (!type) return f;
                const field = { ...f, type, cell: type, editable: true, sortable: f.sortable || type === 'select' };
                if (type === 'select') field.cellOptions = { options: this.assignees };
                return field;
            });
            for (const col of Object.keys(this.instantColumns)) {
                if (!keys.has(col) && this.rawRows.length) console.warn(`[DesignQueue] instant-write column "${col}" is not in the sheet; skipped`);
            }
            if (!keys.has('Note')) fields.push({ key: 'Note', label: 'Note', cell: 'text', editable: true, cellOptions: { placeholder: 'Add a note' } });
            fields.push({ key: '_rowColor', label: 'Row colour' }, { key: '_identifier', label: 'Identifier' });
            return fields;
        },
        rowIdentityList() {
            return this.rawRows.map(identityKey).join(';;');
        },
        notesByIdentifier() {
            const map = new Map();
            for (const n of this.notesStore?.data || []) {
                if (n?.Identifier) map.set(String(n.Identifier).trim().toUpperCase(), n.Note ?? '');
            }
            return map;
        },
        duplicateIdentities() {
            const seen = new Map();
            for (const r of this.rawRows) {
                const k = identityKey(r);
                seen.set(k, (seen.get(k) || 0) + 1);
            }
            return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
        },
        rows() {
            const sheetHasNote = this.rawRows.length && Object.prototype.hasOwnProperty.call(this.rawRows[0], 'Note');
            if (sheetHasNote) console.warn('[DesignQueue] the Schedule sheet has its own Note column; the sheet value wins over CACHE/ShowNotes');
            return this.rawRows.map(row => {
                const identifier = this.identifiers[identityKey(row)] || '';
                const out = { ...row, _identifier: identifier };
                if (!sheetHasNote) out.Note = identifier ? (this.notesByIdentifier.get(identifier.trim().toUpperCase()) ?? '') : '';
                return this.deriveRow(out);
            });
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
        rowIdentityList: {
            handler() { this.resolveIdentifiers(); },
            immediate: true
        }
    },
    mounted() {
        this.prefsStore = getReactiveStore(Requests.getPreferences, null, []);
        this.notesStore = getReactiveStore(Requests.getShowNotes, null, []);
    },
    methods: {
        // Derived fields recomputed from the (local) row: the row turns gray when every task is done
        deriveRow(row) {
            const complete = TASK_COLUMNS.every(col => isTaskDone(row[col]));
            return { ...row, _rowColor: complete ? 'gray' : '' };
        },
        rowId(row) {
            return identityKey(row);
        },
        cellDisabled(row, key) {
            const isInstantCell = Object.keys(this.instantColumns).some(c => c.trim().toLowerCase() === String(key).trim().toLowerCase());
            if (key === 'Note') return row._identifier ? '' : 'write disabled: no show identifier yet';
            if (!isInstantCell) return '';
            if (!this.instantConfig) return 'write disabled: no row identity';
            if (this.duplicateIdentities.has(identityKey(row))) return 'write disabled: duplicate row identity';
            return '';
        },
        // Routing writes (§4.16): Note → saveShowNote; every other column → writeCellVerified
        async commitCell(row, key, value) {
            if (key === 'Note') {
                if (!row._identifier) return { ok: false, reason: 'no show identifier' };
                return await Requests.saveShowNote(row._identifier, value);
            }
            return await Requests.writeCellVerified(DQ_DATABASE, DQ_TAB, row, key, value);
        },
        async resolveIdentifiers() {
            for (const row of this.rawRows) {
                const k = identityKey(row);
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
            const analysisConfig = [
                // Normalize ship dates to include the year (sorting by Ship)
                createAnalysisConfig(
                    Requests.guessShipDate,
                    'estimatedShipDate',
                    'Normalizing ship dates...',
                    ['Ship', 'S. Start', 'S. End', 'Year'],
                    [],
                    'Ship',
                    false,
                    Priority.ANALYSIS,
                    true
                )
            ];
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
            const filter = { searchParams: {} };
            if (searchData.dateFilters && searchData.dateFilters.length > 0) {
                filter.dateFilters = searchData.dateFilters;
            }
            (searchData.textFilters || []).forEach(textFilter => {
                if (textFilter.column && (textFilter.values || textFilter.value)) {
                    filter.searchParams[textFilter.column] = {
                        values: normalizeFilterValues(textFilter),
                        type: textFilter.type || 'contains'
                    };
                }
            });
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
                :commit-cell="commitCell"
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
