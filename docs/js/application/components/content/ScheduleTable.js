import { html, Requests, parseDate, toUSDateString, DataView, getReactiveStore, createAnalysisConfig, invalidateCache, Priority, runNonessentialAnalysisOnAllStores } from '../../index.js';
import { IndexResolutionComponent } from '../interface/IndexResolutionModal.js';
import { TransshipmentModal } from '../interface/ScheduleModals.js';
import { buildScheduleFields } from '../../../data_management/abstraction/scheduleFields.js';

/**
 * Schedule page view registry (views-and-renderers-plan §4.3). Presentation only: which fields
 * show where, widths, colours and the action trigger. Fields come from scheduleFields.js.
 * The table reproduces the original columns; narrow containers stack Client under Show (Phase 6).
 */
const SCHEDULE_VIEWS = {
    id: 'schedule',
    default: 'table',
    theme: '',
    views: [
        {
            id: 'table',
            name: 'Schedule',
            icon: 'table',
            layout: 'table',
            columns: ['Show', 'Client', 'City', 'Size', ['S. Start', 'S. End'], ['Ship', 'Recieved'], 'packlist'],
            style: {
                'Show': { width: 200 },
                'Client': { width: 150 },
                'City': { width: 150 },
                'Size': { width: 140 },
                'S. Start': { width: 120 },
                'Ship': { width: 120, color: 'auto' },
                'packlist': { width: 120 }
            },
            // Search highlights and navigates; it doesn't hide non-matching rows by default
            table: { hideRowsOnSearch: false },
            variants: {
                // Narrow containers (phone, 360px dashboard card): stack Client under Show; City and Size move to details
                narrow: {
                    columns: [['Show', 'Client'], ['Ship', 'Recieved'], ['S. Start', 'S. End'], 'packlist']
                }
            },
            action: 'button'
        },
        {
            id: 'calendar',
            name: 'Calendar',
            icon: 'calendar_month',
            layout: 'calendar',
            calendar: {
                start: 'S. Start',
                end: 'S. End',
                weekStart: 'sunday',
                yearColumn: 'Year',
                chip: [['Show', 'Client'], ['City', 'Size']]
            },
            action: 'button'
        }
    ]
};

// Keys the Schedule page decorates (packlist actions, index issues, transship badges)
const SCHEDULE_DECORATION_KEYS = ['packlist', 'Client', 'Show', 'Ship', 'Recieved'];

const PacklistSelectModal = {
    props: ['tabs', 'onNavigate'],
    template: html`
        <div style="display:flex;flex-direction:column;gap:8px;padding:8px 0">
            <button v-for="tab in tabs" :key="tab"
                class="card-button white"
                @click="() => { onNavigate(tab); $emit('close-modal') }">
                {{ tab }}
            </button>
        </div>
    `
};

export const ScheduleTableComponent = {
    components: {
        DataView
    },
    props: {
        filter: {
            type: [Object, String],
            default: null
        },
        searchParams: {
            type: Object,
            default: null
        },
        hideRowsOnSearch: {
            type: Boolean,
            default: true
        },
        templateName: {
            type: String,
            default: '_TEMPLATE'
        },
        containerPath: {
            type: String,
            default: ''
        },
        navigateToPath: {
            type: Function,
            default: null
        },
    },
    inject: ['$modal'],
    emits: ['navigate-to-path', 'packlist-created'],
    data() {
        return {
            scheduleTableStore: null,
            SCHEDULE_VIEWS,
            SCHEDULE_DECORATION_KEYS
        };
    },

    computed: {
        // FieldDefs built from the sheet headers (shared with other Schedule pages)
        fields() {
            return buildScheduleFields(this.scheduleTableStore ? this.scheduleTableStore.data : []);
        },
        tableData() {
            const rawData = this.scheduleTableStore ? this.scheduleTableStore.data : [];
            // Use source show's end date as the sort/display ship date for transship rows
            return rawData.map(row => {
                if (row.AppData?.transshipSource) {
                    return { ...row, Ship: row.AppData.transshipSourceEndDate ?? '' };
                }
                return row;
            });
        },
        originalData() {
            return this.scheduleTableStore && Array.isArray(this.scheduleTableStore.originalData)
                ? JSON.parse(JSON.stringify(this.scheduleTableStore.originalData))
                : [];
        },
        error() {
            return this.scheduleTableStore ? this.scheduleTableStore.error : null;
        },
        loadingMessage() {
            return this.scheduleTableStore ? (this.scheduleTableStore.loadingMessage || 'Loading schedule...') : 'Loading schedule...';
        },
        isLoading() {
            return this.scheduleTableStore ? this.scheduleTableStore.isLoading : false;
        },
        isAnalyzing() {
            return this.scheduleTableStore ? this.scheduleTableStore.isAnalyzing : false;
        },
        analysisProgress() {
            return this.scheduleTableStore ? this.scheduleTableStore.analysisProgress : -1;
        },
        tableTitle() {
            const fmtVal = (v) => {
                if (typeof v === 'number') return toUSDateString(new Date(Date.now() + v * 86400000)) ?? '';
                return toUSDateString(parseDate(v)) ?? String(v);
            };
            if (this.filter && this.filter.dateFilters && this.filter.dateFilters.length > 0) {
                const afterFilter = this.filter.dateFilters.find(f => f.type === 'after');
                const beforeFilter = this.filter.dateFilters.find(f => f.type === 'before');
                if (afterFilter && beforeFilter) {
                    const startVal = afterFilter.value;
                    const endVal = beforeFilter.value;
                    if (typeof startVal === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(startVal)) {
                        return `Shows during ${startVal}`;
                    }
                    return `Shows between ${fmtVal(startVal)} and ${fmtVal(endVal)}`;
                }
            }
            if (this.filter && typeof this.filter === 'object' && this.filter.startDate && this.filter.endDate) {
                return `Shows between ${fmtVal(this.filter.startDate)} and ${fmtVal(this.filter.endDate)}`;
            }
            if (this.filter && (typeof this.filter === 'string' || this.filter.identifier)) {
                const id = typeof this.filter === 'string' ? this.filter : this.filter.identifier;
                return `Shows during ${id}`;
            }
            return 'Production Schedule';
        },
        // Decorations (§4.14): decorations(row, key) → Card[]; renderers place them by key
        decorations() {
            return (row, key) => {
                switch (key) {
                    case 'packlist': return this.getPacklistCards(row, 'packlist').map(c => ({ ...c, button: true }));
                    case 'Client':
                    case 'Show':
                        return this.getIndexIssueCards(row, key).map(c => ({
                            ...c,
                            class: c.color || 'red',
                            title: 'Missing from index: ' + c.rawValue,
                            action: c.clickable ? c.action : null
                        }));
                    case 'Ship':
                    case 'Recieved':
                        return [...this.getShipDateCards(row, key), ...this.getTransshipCards(row, key)]
                            .map(c => ({ ...c, title: c.hoverMessage }));
                    default: return [];
                }
            };
        }
    },
    watch: {
        // Watch for filter or searchParams changes and recreate store with new parameters
        filter: {
            handler(newFilter, oldFilter) {
                if (JSON.stringify(newFilter) !== JSON.stringify(oldFilter)) {
                    this.recreateStore();
                }
            },
            deep: true,
            immediate: false
        },
        searchParams: {
            handler(newSearchParams, oldSearchParams) {
                if (JSON.stringify(newSearchParams) !== JSON.stringify(oldSearchParams)) {
                    this.recreateStore();
                }
            },
            deep: true,
            immediate: false
        }
    },
    async mounted() {
        this.recreateStore();
    },
    methods: {
        recreateStore() {
            // If no filter is provided, don't create a store (show empty table)
            if (this.filter === null) {
                this.scheduleTableStore = null;
                return;
            }
            
            // Create analysis configuration to check packlist existence for each row
            const analysisConfig = [
                createAnalysisConfig(
                    Requests.checkPacklistExists,
                    'packlist',
                    'Checking packlists...',
                    ['Show', 'Client', 'Year'],
                    [],
                    null,
                    false,
                    Priority.ANALYSIS,
                    true // extractColumnsAsObject
                ),
                // Normalize ship dates to always include year
                createAnalysisConfig(
                    Requests.guessShipDate,
                    'estimatedShipDate',
                    'Normalizing ship dates...',
                    ['Ship', 'S. Start', 'S. End', 'Year'],
                    [],
                    'Ship', // Store directly in Ship column to display with year
                    false,
                    Priority.ANALYSIS,
                    true // extractColumnsAsObject
                ),
                // Normalize show start dates to always include year
                createAnalysisConfig(
                    Requests.normalizeStartDate,
                    'normalizedStartDate',
                    'Normalizing start dates...',
                    ['S. Start', 'Year'],
                    [],
                    'S. Start', // Store directly in S. Start column
                    false,
                    Priority.ANALYSIS,
                    true // extractColumnsAsObject
                ),
                // Normalize show end dates to always include year
                createAnalysisConfig(
                    Requests.normalizeEndDate,
                    'normalizedEndDate',
                    'Normalizing end dates...',
                    ['S. End', 'Year'],
                    [],
                    'S. End', // Store directly in S. End column
                    false,
                    Priority.ANALYSIS,
                    true // extractColumnsAsObject
                ),
                // Detect transship rows before index checks so the ship cell annotation is visible first
                createAnalysisConfig(
                    Requests.getTransshipSourceEndDateForRow,
                    'transshipSourceEndDate',
                    'Checking transshipment dates...',
                    ['Show', 'Client', 'Year'],
                    [],
                    null,
                    false,
                    Priority.ANALYSIS,
                    true, // extractColumnsAsObject
                    false  // nonessential
                ),
                createAnalysisConfig(
                    Requests.getTransshipSourceForScheduleRow,
                    'transshipSource',
                    'Checking transshipments...',
                    ['Show', 'Client', 'Year'],
                    [],
                    null,
                    false,
                    Priority.ANALYSIS,
                    true, // extractColumnsAsObject
                    false  // nonessential
                ),
                createAnalysisConfig(
                    Requests.getTransshipDestinationsForScheduleRow,
                    'transshipDestination',
                    'Checking transshipment destinations...',
                    ['Show', 'Client', 'Year'],
                    [],
                    null,
                    false,
                    Priority.ANALYSIS,
                    true, // extractColumnsAsObject
                    false  // nonessential
                ),
                createAnalysisConfig(
                    Requests.checkScheduleReferenceState,
                    'clientIndexIssue',
                    'Checking client index health...',
                    ['Client', 'Show', 'Year'],
                    ['client'],
                    null,
                    false,
                    Priority.ANALYSIS,
                    true, // extractColumnsAsObject
                    false  // nonessential
                ),
                createAnalysisConfig(
                    Requests.checkScheduleReferenceState,
                    'showIndexIssue',
                    'Checking show index health...',
                    ['Show', 'Client', 'Year'],
                    ['show'],
                    null,
                    false,
                    Priority.ANALYSIS,
                    true, // extractColumnsAsObject
                    false  // nonessential
                )
            ];

            // Create a new reactive store with the updated filter, searchParams, and analysis
            this.scheduleTableStore = getReactiveStore(
                Requests.getProductionScheduleData,
                null,
                [this.filter, this.searchParams],
                analysisConfig
            );
        },
        async handleRefresh() {
            // Reload schedule data (cache will be automatically invalidated)
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['CACHE', 'Clients'] }, // invalidate all prod sched index to force refresh of client and show ref info as well
                { namespace: 'database', methodName: 'getData', args: ['CACHE', 'Shows'] },
                { namespace: 'database', methodName: 'getData', args: ['PROD_SCHED'] },
                { namespace: 'database', methodName: 'getTabs', args: ['PACK_LISTS'] }
            ], true);
        },
        async handlePacklistClick(packlistInfo) {
            if (!packlistInfo.exists || !packlistInfo.identifiers?.length) {
                this.$modal.alert('No packlist available for this show', 'Info');
                return;
            }
            
            if (packlistInfo.identifiers.length === 1) {
                this.$emit('navigate-to-path', `packlist/${packlistInfo.identifiers[0]}`);
                return;
            }

            this.$modal.custom(PacklistSelectModal, {
                tabs: packlistInfo.identifiers,
                onNavigate: (tab) => this.$emit('navigate-to-path', `packlist/${tab}`)
            }, 'Select Packlist');
        },
        async handleCreatePacklist(identifier, scheduleRow) {
            try {
                // Validate identifier exists
                if (!identifier) {
                    this.$modal.error('Cannot create packlist: Invalid identifier', 'Error');
                    return;
                }
                
                // Confirm with user (show client, show, year info)
                const client = scheduleRow.Client || '';
                const show = scheduleRow.Show || '';
                const year = scheduleRow.Year || '';
                const startDate = scheduleRow['S. Start'] || 'TBD';
                
                const isDuplicate = this.templateName !== '_TEMPLATE';
                const confirmMessage = isDuplicate 
                    ? `Duplicate "${this.templateName}" and attach to:\n\nClient: ${client}\nShow: ${show}\nYear: ${year}\nStart Date: ${startDate}\n\nNew packlist will be named: ${identifier}`
                    : `Create new empty packlist for:\n\nClient: ${client}\nShow: ${show}\nYear: ${year}\nStart Date: ${startDate}`;
                
                this.$modal.confirm(
                    confirmMessage,
                    async () => {
                        try {
                            // Create the tab from template
                            await Requests.createNewTab('PACK_LISTS', this.templateName, identifier);
                            
                            // Success message
                            //this.$modal.alert(`Packlist "${identifier}" created successfully!`, 'Success');
                            
                            // Emit event for parent to handle (e.g., close modal)
                            this.$emit('packlist-created', identifier);
                            
                        } catch (createError) {
                            console.error('Error in create confirmation:', createError);
                            this.$modal.error(`Failed to create packlist: ${createError.message}`, 'Error');
                        }
                    },
                    null,
                    'Create Packlist',
                    'Create'
                );
            } catch (error) {
                console.error('Error creating packlist:', error);
                this.$modal.error(`Failed to create packlist: ${error.message}`, 'Error');
            }
        },
        getShipDateCards(row, columnKey) {
            // Cards are no longer needed - ship dates are now normalized and displayed directly in the column
            // Keeping function for backwards compatibility but returning empty array
            return [];
        },
        getTransshipCards(row, columnKey) {
            const source = row.AppData?.transshipSource;
            const dest   = row.AppData?.transshipDestination;
            if (columnKey === 'Ship' && source) {
                return [{
                    message: 'TS',
                    class: 'gray',
                    hoverMessage: `transship from: ${source}`,
                    action: () => this.handleTransshipClick(row, source)
                }];
            }
            // Return date for source shows is extended to the destination's return date
            if (columnKey === 'Recieved' && dest) {
                return [{
                    message: 'return extended',
                    class: 'gray',
                    hoverMessage: `Items remain out until the later show ends: ${dest}`,
                    action: () => this.handleTransshipReturnClick(row, dest)
                }];
            }
            return [];
        },
        handleTransshipClick(row, sourceId) {
            const showId = [row.Client, row.Year, row.Show].filter(Boolean).join(' ');
            this.$modal.alert(
                `${showId}\ntransships directly from:\n${sourceId}`,
                'Transshipment'
            );
        },
        handleTransshipReturnClick(row, destId) {
            const showId = [row.Client, row.Year, row.Show].filter(Boolean).join(' ');
            this.$modal.alert(
                `${showId}\ntransships directly to:\n${destId}`,
                'Extended Return'
            );
        },
        getPacklistCards(row, columnKey) {
            // Only show packlist cards in the packlist column
            if (columnKey !== 'packlist') {
                return [];
            }
            
            const packlistInfo = row.AppData?.packlist;
            
            // If no packlist info yet or still analyzing, show loading state
            if (!packlistInfo || packlistInfo.exists === undefined) {
                return [{
                    message: 'Checking...',
                    disabled: true
                }];
            }
            
            if (packlistInfo.exists) {
                return [{
                    message: packlistInfo.identifiers.length > 1
                        ? `View Packlist (${packlistInfo.identifiers.length})`
                        : 'View Packlist',
                    disabled: false,
                    class: 'white',
                    action: () => this.handlePacklistClick(packlistInfo)
                }];
            } else {
                return [{
                    message: 'Create Packlist',
                    disabled: false,
                    action: () => this.handleCreatePacklist(packlistInfo.identifier, row)
                }];
            }
        },
        getIndexIssueCards(row, columnKey) {
            if (!row || !row.AppData) {
                return [];
            }

            if (columnKey === 'Client' && row.AppData.clientIndexIssue) {
                return [{
                    ...row.AppData.clientIndexIssue,
                    action: row.AppData.clientIndexIssue.clickable
                        ? () => this.handleIndexIssueClick(row, row.AppData.clientIndexIssue)
                        : null
                }];
            }

            if (columnKey === 'Show' && row.AppData.showIndexIssue) {
                return [{
                    ...row.AppData.showIndexIssue,
                    action: row.AppData.showIndexIssue.clickable
                        ? () => this.handleIndexIssueClick(row, row.AppData.showIndexIssue)
                        : null
                }];
            }

            return [];
        },
        async handleIndexIssueClick(row, issue) {
            if (!issue?.referenceType || !issue?.rawValue) {
                return;
            }

            await this.showIndexResolutionModal(row, issue, false);
        },
        async showIndexResolutionModal(row, issue, includeAllCandidates = false) {
            try {
                const resolutionData = await Requests.getScheduleReferenceResolutionOptions(
                    issue.referenceType,
                    issue.rawValue,
                    includeAllCandidates
                );

                const sourceIdentifier = [row?.Client, row?.Year, row?.Show].filter(Boolean).join(' ');

                const options = resolutionData?.options || [];
                if (options.length === 0) {
                    this.$modal.alert('No resolution options available for this value.', 'Missing');
                    return;
                }

                const modalTitle = includeAllCandidates
                    ? `Select ${issue.referenceType}`
                    : `${issue.referenceType === 'show' ? 'Show' : 'Client'} Missing`;

                this.$modal.custom(IndexResolutionComponent, {
                    issue,
                    options,
                    includeAllCandidates,
                    sources: sourceIdentifier ? [{ sourceType: 'schedule', identifier: sourceIdentifier }] : [],
                    onFetchOverrideTargets: (sourceType) => Requests.getOverrideTargets(sourceType),
                    onAddOverride: async (scheduleId, packlistId) => {
                        await Requests.addNameOverride(scheduleId, packlistId);
                        await this.handleRefresh();
                        return { applied: true };
                    },
                    onSelectOption: async (option) => {
                        return await this.applyIndexResolutionOption(option, row, issue);
                    },
                    modalClass: 'hamburger-menu'
                }, modalTitle);
            } catch (error) {
                console.error('[ScheduleTable] Failed to open index resolution modal:', error);
                this.$modal.error(`Failed to load resolution options: ${error.message}`, 'Index Resolution Error');
            }
        },
        openTransshipModal(row, direction = null) {
            // Use original store row so the Ship date is present (tableData clears it for transship rows)
            const originalRow = this.scheduleTableStore?.data?.find(r =>
                r.Client === row.Client && String(r.Year) === String(row.Year) && r.Show === row.Show
            ) || row;
            this.$modal.custom(TransshipmentModal, {
                preselectedRow: originalRow,
                preselectedDirection: direction,
                size: 'page',
                tall: true
            }, 'Set Transshipment');
        },
        async removeTransshipTo(row) {
            const destinationId = row.AppData?.transshipDestination;
            if (!destinationId) return;
            try {
                await Requests.removeTransshipLink(destinationId);
                runNonessentialAnalysisOnAllStores();
            } catch (e) {
                this.$modal.alert('Failed to remove transshipment: ' + e.message, 'Error');
            }
        },
        async removeTransship(row) {
            const identifier = await Requests.computeIdentifier(row.Show, row.Client, row.Year).catch(() => null);
            if (!identifier) return;
            try {
                await Requests.removeTransshipLink(identifier);
                runNonessentialAnalysisOnAllStores();
            } catch (e) {
                this.$modal.alert('Failed to remove transshipment: ' + e.message, 'Error');
            }
        },
        async applyIndexResolutionOption(option, row, issue) {
            try {
                if (!option || !issue) {
                    return { applied: false };
                }

                if (option.actionType === 'browse-all') {
                    await this.showIndexResolutionModal(row, issue, true);
                    return { applied: false, browsedAll: true };
                }

                if (option.actionType === 'add-new') {
                    await Requests.addScheduleReferenceName(issue.referenceType, option.canonicalName);
                    return { applied: true };
                } else if (option.actionType === 'add-abbreviation') {
                    await Requests.appendScheduleReferenceAbbreviation(
                        issue.referenceType,
                        option.canonicalName,
                        option.abbreviation
                    );
                    return { applied: true };
                } else if (option.actionType === 'add-custom') {
                    const result = await Requests.addCustomScheduleReferenceEntry(
                        issue.referenceType,
                        option.canonicalName,
                        option.abbreviation
                    );

                    if (!result?.applied) {
                        const conflictName = result?.conflict?.existingName || '';
                        const conflictValue = result?.conflict?.value || option.canonicalName;
                        const fieldLabel = result?.conflict?.field === 'abbreviation' ? 'abbreviation' : 'name';
                        return {
                            applied: false,
                            message: `The ${fieldLabel} "${conflictValue}" already exists${conflictName ? ` on ${conflictName}` : ''}.`
                        };
                    }

                    return { applied: true };
                } else {
                    return { applied: false };
                }
            } catch (error) {
                console.error('[ScheduleTable] Failed to apply index resolution:', error);
                this.$modal.error(`Failed to apply resolution: ${error.message}`, 'Index Resolution Error');
                return { applied: false, message: error.message };
            }
        }
    },
    template: html`
        <DataView
            :fields="fields"
            :rows="tableData"
            :original-data="originalData"
            :registry="SCHEDULE_VIEWS"
            :container-path="containerPath"
            :navigate-to-path="navigateToPath"
            :decorations="decorations"
            :decoration-keys="SCHEDULE_DECORATION_KEYS"
            :details-title="row => row.Show || row.Client || 'Show Details'"
            :is-loading="isLoading"
            :is-analyzing="isAnalyzing"
            :loading-progress="analysisProgress"
            :error="error"
            :show-refresh="true"
            :title="tableTitle"
            empty-message="No shows found."
            :loading-message="loadingMessage"
            :show-search="true"
            :sync-search-with-url="true"
            :hide-rows-on-search="hideRowsOnSearch"
            @refresh="handleRefresh"
        >
            <template #header-area>
                <slot name="header-area"></slot>
            </template>
            <template #row-details="{ row }">
                <div class="button-bar" style="margin-top: var(--padding-sm)">
                    <template v-if="row.AppData?.transshipSource">
                        <div class="card gray" style="white-space:nowrap">ships from: {{ row.AppData.transshipSource }}</div>
                        <button @click="removeTransship(row)" class="red button-symbol" title="Remove ships-from link"><span class="material-symbols-outlined">close</span></button>
                    </template>
                    <button @click="openTransshipModal(row, 'from')" class="white small">
                        {{ row.AppData?.transshipSource ? 'Change From' : 'Set Transship From' }}
                    </button>
                </div>
                <div class="button-bar" style="margin-top: var(--padding-sm)">
                    <template v-if="row.AppData?.transshipDestination">
                        <div class="card gray" style="white-space:nowrap">ships to: {{ row.AppData.transshipDestination }}</div>
                        <button @click="removeTransshipTo(row)" class="red button-symbol" title="Remove ships-to link"><span class="material-symbols-outlined">close</span></button>
                    </template>
                    <button @click="openTransshipModal(row, 'to')" class="white small">
                        {{ row.AppData?.transshipDestination ? 'Change To' : 'Set Transship To' }}
                    </button>
                </div>
            </template>
        </DataView>
    `
};
