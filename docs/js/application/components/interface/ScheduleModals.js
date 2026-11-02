import { html, Requests, DataView, ScheduleFilterSelect, toISODateString, parseDate, getReactiveStore, runNonessentialAnalysisOnAllStores } from '../../index.js';
import { textFiltersToSearchParams } from '../../../data_management/utils/helpers.js';

// Converts ScheduleFilterSelect textFilters array to getProductionScheduleData searchParams format
function buildSearchParams(textFilters) {
    const result = textFiltersToSearchParams(textFilters);
    return Object.keys(result).length ? result : null;
}

/**
 * Two-stage modal for creating transshipment links between shows.
 * Stage 1: pick the show to manage.
 * Stage 2: pick the partner show (filtered to same client/size, within 90 days).
 */
export const TransshipmentModal = {
    components: { DataView, ScheduleFilterSelect },
    inject: ['$modal'],
    props: {
        preselectedRow: { type: Object, default: null },
        preselectedDirection: { type: String, default: null }
    },
    data() {
        return {
            stage: 1,
            direction: 'from', // 'from' = selected show is destination; 'to' = selected show is source

            // Stage 1
            stage1Store: null,
            stage1Filter: null,
            stage1Links: new Map(), // rowKey -> sourceIdentifier for rows with existing from-links
            stage1ToLinks: new Map(), // rowKey -> destinationIdentifier for rows with existing to-links

            // Stage 2
            selectedRow: null,
            selectedIdentifier: null,
            existingSourceId: null,
            stage2Data: [],
            stage2Loading: false,

            saving: false,
            error: null
        };
    },
    computed: {
        stage1Data() {
            const rows = this.stage1Store?.data || [];
            const seen = new Set();
            return rows.filter(row => {
                if (!row.Show || !row.Client) return false;
                const key = `${row.Client}|${row.Year}|${row.Show}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        },
        stage1Loading() {
            return this.stage1Store?.isLoading ?? false;
        },
        // Modal tables: single-view registries with no URL (views-and-renderers-plan §4.3).
        // The per-row buttons stay as cell content (two actions per row; no primary action).
        stage1Fields() {
            return [
                { key: 'Show', label: 'Show', sortable: true },
                { key: 'Client', label: 'Client', sortable: true },
                { key: 'Year', label: 'Year' },
                { key: 'Size', label: 'Size', sortable: true },
                { key: 'Ship', label: 'Ship', sortable: true },
                { key: '_actionFrom', label: 'Ships From', sortable: false },
                { key: '_actionTo', label: 'Ships To', sortable: false }
            ];
        },
        stage1Registry() {
            return {
                id: 'transship-stage1',
                default: 'table',
                theme: 'gray',
                views: [{
                    id: 'table', name: 'Shows', layout: 'table',
                    columns: ['Show', 'Client', 'Size', 'Ship', '_actionFrom', '_actionTo'],
                    hidden: ['Year'],
                    style: { _actionFrom: { width: 105 }, _actionTo: { width: 95 } },
                    sort: { key: 'Ship', dir: 'asc' }
                }]
            };
        },
        stage2Fields() {
            return [
                { key: 'Show', label: 'Show', sortable: true },
                { key: 'Client', label: 'Client', sortable: true },
                { key: 'Year', label: 'Year' },
                { key: 'Size', label: 'Size', sortable: true },
                { key: 'Ship', label: 'Ship', sortable: true },
                { key: '_action', label: '', sortable: false }
            ];
        },
        stage2Registry() {
            return {
                id: 'transship-stage2',
                default: 'table',
                theme: 'gray',
                views: [{
                    id: 'table', name: 'Partner shows', layout: 'table',
                    columns: ['Show', 'Client', 'Size', 'Ship', '_action'],
                    hidden: ['Year'],
                    style: { _action: { width: 90 } },
                    table: { sticky: { end: ['_action'] } },
                    sort: { key: 'Ship', dir: 'asc' }
                }]
            };
        },
        selectedShipISO() {
            if (!this.selectedRow?.Ship) return null;
            const d = parseDate(this.selectedRow.Ship);
            return d ? toISODateString(d) : null;
        }
    },
    async mounted() {
        if (this.preselectedRow) {
            if (this.preselectedDirection) this.direction = this.preselectedDirection;
            await this.selectStage1Show(this.preselectedRow);
        } else {
            this.reloadStage1();
        }
    },
    watch: {
        stage1Filter: {
            handler() { this.reloadStage1(); },
            deep: true
        },
        // After stage1Data resolves, check which rows already have from or to transship links
        stage1Data: {
            async handler(rows) {
                const fromMap = new Map();
                const toMap   = new Map();
                await Promise.all(rows.map(async row => {
                    const key = `${row.Client}|${row.Year}|${row.Show}`;
                    const src  = await Requests.getTransshipSourceForScheduleRow(
                        { Show: row.Show, Client: row.Client, Year: row.Year }
                    ).catch(() => null);
                    if (src)  fromMap.set(key, src);
                    const dest = await Requests.getTransshipDestinationsForScheduleRow(
                        { Show: row.Show, Client: row.Client, Year: row.Year }
                    ).catch(() => null);
                    if (dest) toMap.set(key, dest);
                }));
                this.stage1Links   = fromMap;
                this.stage1ToLinks = toMap;
            }
        },
        direction() {
            if (this.stage === 2) this.loadStage2Data();
        }
    },
    methods: {
        reloadStage1() {
            const currentYear = new Date().getFullYear();
            const params = this.stage1Filter?.dateFilters?.length
                ? { dateFilters: this.stage1Filter.dateFilters }
                : { dateFilters: [
                    { column: 'Ship', value: `${currentYear}-01-01`, type: 'after' },
                    { column: 'Ship', value: `${currentYear}-12-31`, type: 'before' }
                ]};
            const searchParams = buildSearchParams(this.stage1Filter?.textFilters);
            this.stage1Store = getReactiveStore(
                Requests.getProductionScheduleData,
                null,
                [params, searchParams],
                null
            );
            this.stage1Store.load('Loading shows...');
        },

        handleStage1Search(searchData) {
            this.stage1Filter = searchData;
        },

        async selectStage1Show(row) {
            this.stage2Loading = true;
            this.error = null;
            this.stage = 2;
            this.selectedRow = row;
            this.selectedIdentifier = await Requests.computeIdentifier(row.Show, row.Client, row.Year).catch(() => null);
            this.existingSourceId = this.selectedIdentifier
                ? await Requests.getTransshipSourceForShow(this.selectedIdentifier).catch(() => null)
                : null;
            await this.loadStage2Data();
        },

        async loadStage2Data() {
            if (!this.selectedShipISO) {
                this.stage2Data = [];
                this.stage2Loading = false;
                return;
            }
            this.stage2Loading = true;
            this.error = null;
            try {
                const shipMs = new Date(this.selectedShipISO + 'T12:00:00').getTime();
                const windowMs = 90 * 86400000;
                const before = toISODateString(new Date(shipMs - windowMs));
                const after  = toISODateString(new Date(shipMs + windowMs));

                const dateFilters = this.direction === 'from'
                    ? [
                        { column: 'Ship', value: before, type: 'after' },
                        { column: 'Ship', value: this.selectedShipISO, type: 'before' }
                    ]
                    : [
                        { column: 'Ship', value: this.selectedShipISO, type: 'after' },
                        { column: 'Ship', value: after, type: 'before' }
                    ];

                const searchParams = {};
                if (this.selectedRow.Client) {
                    searchParams['Client'] = { values: [this.selectedRow.Client], type: 'contains' };
                }

                const rows = await Requests.getProductionScheduleData(
                    { dateFilters },
                    Object.keys(searchParams).length ? searchParams : null
                );

                const seen = new Set();
                const sel = this.selectedRow;
                this.stage2Data = rows.filter(r => {
                    if (r.Client === sel.Client && String(r.Year) === String(sel.Year) && r.Show === sel.Show) return false;
                    const key = `${r.Client}|${r.Year}|${r.Show}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return r.Show && r.Client;
                });
            } catch (e) {
                this.error = 'Failed to load shows: ' + e.message;
                this.stage2Data = [];
            } finally {
                this.stage2Loading = false;
            }
        },

        async selectStage2Show(row) {
            this.saving = true;
            this.error = null;
            try {
                const partnerIdentifier = await Requests.computeIdentifier(row.Show, row.Client, row.Year);
                if (this.direction === 'from') {
                    await Requests.setTransshipLink(this.selectedIdentifier, partnerIdentifier);
                } else {
                    await Requests.setTransshipLink(partnerIdentifier, this.selectedIdentifier);
                }
                runNonessentialAnalysisOnAllStores();
                this.$emit('close-modal');
            } catch (e) {
                this.error = 'Failed to save link: ' + e.message;
            } finally {
                this.saving = false;
            }
        },

        async removeExistingLink() {
            this.saving = true;
            this.error = null;
            try {
                await Requests.removeTransshipLink(this.selectedIdentifier);
                this.existingSourceId = null;
            } catch (e) {
                this.error = 'Failed to remove link: ' + e.message;
            } finally {
                this.saving = false;
            }
        },

        async removeToFromStage1(row) {
            const key = `${row.Client}|${row.Year}|${row.Show}`;
            // The to-link is stored as Schedule=destination, Override=this row; remove by destination id
            const destinationId = this.stage1ToLinks.get(key);
            if (!destinationId) return;
            try {
                await Requests.removeTransshipLink(destinationId);
                this.stage1ToLinks.delete(key);
                this.stage1ToLinks = new Map(this.stage1ToLinks);
                runNonessentialAnalysisOnAllStores();
            } catch (e) {
                this.error = 'Failed to remove link: ' + e.message;
            }
        },

        async removeFromStage1(row) {
            const key = `${row.Client}|${row.Year}|${row.Show}`;
            const identifier = await Requests.computeIdentifier(row.Show, row.Client, row.Year).catch(() => null);
            if (!identifier) return;
            try {
                await Requests.removeTransshipLink(identifier);
                this.stage1Links.delete(key);
                this.stage1Links = new Map(this.stage1Links); // trigger reactivity
                runNonessentialAnalysisOnAllStores();
            } catch (e) {
                this.error = 'Failed to remove link: ' + e.message;
            }
        },

        goBack() {
            this.stage = 1;
            this.selectedRow = null;
            this.selectedIdentifier = null;
            this.existingSourceId = null;
            this.stage2Data = [];
            this.error = null;
        }
    },
    template: html`
        <div class="transshipment-modal">

            <!-- Stage 1: pick which show to manage -->
            <template v-if="stage === 1">
                <DataView
                    :fields="stage1Fields"
                    :rows="stage1Data"
                    :registry="stage1Registry"
                    :isLoading="stage1Loading"
                    :showSearch="true"
                    :showRefresh="false"
                    :syncSearchWithUrl="false"
                    emptyMessage="No shows found."
                    loadingMessage="Loading shows..."
                >
                    <template #header-area>
                        <ScheduleFilterSelect
                            :containerPath="null"
                            :includeYears="true"
                            :startYear="2023"
                            :default-search="String(new Date().getFullYear())"
                            :showAdvancedButton="false"
                            @search-selected="handleStage1Search"
                        />
                    </template>
                    <template #cell-extra="{ row, column }">
                        <template v-if="column.key === '_actionFrom'">
                            <button
                                v-if="stage1Links.has(row.Client + '|' + row.Year + '|' + row.Show)"
                                @click="removeFromStage1(row)"
                                class="red"
                            >&#x2715; From</button>
                            <button
                                v-else
                                @click="direction = 'from'; selectStage1Show(row)"
                                class="green"
                            >+ From</button>
                        </template>
                        <template v-if="column.key === '_actionTo'">
                            <button
                                v-if="stage1ToLinks.has(row.Client + '|' + row.Year + '|' + row.Show)"
                                @click="removeToFromStage1(row)"
                                class="red"
                            >&#x2715; To</button>
                            <button
                                v-else
                                @click="direction = 'to'; selectStage1Show(row)"
                                class="green"
                            >+ To</button>
                        </template>
                    </template>
                </DataView>
            </template>

            <!-- Stage 2: pick partner show -->
            <template v-else>

                <!-- <div v-if="existingSourceId" class="info-bar" style="display:flex; gap:var(--padding-sm); align-items:center; margin-bottom:var(--padding-sm);">
                    <span>Currently transships from: <strong>{{ existingSourceId }}</strong></span>
                    <button @click="removeExistingLink" :disabled="saving" class="red">Remove</button>
                </div> -->

                
<!-- 
                <p style="font-size:0.85em; color:var(--color-text-muted); margin:0 0 var(--padding-sm);">
                    <template v-if="direction === 'from'">
                        Items ship directly to this show from the selected source. Shows within 90 days before this show.
                    </template>
                    <template v-else>
                        Items from this show ship directly to the selected destination. Shows within 90 days after this show.
                    </template>
                </p> -->

                <div v-if="error" class="card red">{{ error }}</div>

                <div v-if="saving" class="card">Adding transshipment...</div>
                <DataView
                    v-else
                    :fields="stage2Fields"
                    :rows="stage2Data"
                    :registry="stage2Registry"
                    :isLoading="stage2Loading"
                    :showSearch="false"
                    :showRefresh="false"
                    :syncSearchWithUrl="false"
                    emptyMessage="No matching shows found within 90 days with the same client."
                    loadingMessage="Finding nearby shows..."
                >
                    <template #header-area>
                        <div class="button-bar">
                            <button @click="goBack" class="small">Back</button>
                            <div class="card" style="padding: var(--padding-sm) var(--padding-md);">{{ selectedRow.Client }} {{ selectedRow.Year }} {{ selectedRow.Show }}</div>
                            <button @click="direction = 'from'" :class="direction === 'from' ? 'green' : 'white'">ships from</button>
                            <button @click="direction = 'to'"   :class="direction === 'to'   ? 'green' : 'white'">ships to</button>
                        </div>
                    </template>
                    <template #cell-extra="{ row, column }">
                        <button
                            v-if="column.key === '_action'"
                            @click="selectStage2Show(row)"
                            :disabled="saving"
                            class="green"
                        >
                            Link
                        </button>
                    </template>
                </DataView>
            </template>

        </div>
    `
};
