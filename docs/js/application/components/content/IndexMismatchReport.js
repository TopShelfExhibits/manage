import { html, DataView, Requests, getReactiveStore, NavigationRegistry } from '../../index.js';
import { IndexResolutionComponent } from '../interface/IndexResolutionModal.js';

/**
 * Keyword used in NameOverrides table to indicate "ignore forever" (permanently suppress alerts).
 * This must match the IGNORE_KEYWORD constant in production-utils.js.
 */
const IGNORE_KEYWORD = '__IGNORE__';

// What each mismatch key is. Resolution is edited (in the resolution modal) and saved in batch.
const MISMATCH_FIELDS = [
    { key: 'rawValue', label: 'Name' },
    { key: 'typeLabel', label: 'Type' },
    { key: 'sourcesSummary', label: 'Sources' },
    { key: 'resolution', label: 'Resolution', editable: true }
];

// Index mismatch report view (views-and-renderers-plan §5, Phase 4)
const MISMATCH_VIEWS = {
    id: 'index-mismatches',
    default: 'table',
    theme: 'blue',
    views: [{
        id: 'table',
        name: 'Index Mismatches',
        layout: 'table',
        columns: ['rawValue', 'typeLabel', 'sourcesSummary', 'resolution'],
        sortable: ['rawValue', 'typeLabel'],
        // The page draws Sources and Resolution (#cell); Resolution is edited outside the cell
        style: { typeLabel: { width: 80 }, sourcesSummary: { cell: 'slot' }, resolution: { cell: 'external-edit' } }
    }]
};

export const IndexMismatchReport = {
    components: { DataView },
    inject: ['$modal', 'appContext'],
    props: {
        containerPath: { type: String, default: 'reports/index-mismatches' },
        navigateToPath: Function
    },
    data() {
        return {
            reportStore: null,
            MISMATCH_FIELDS,
            MISMATCH_VIEWS
        };
    },
    computed: {
        isLoading() {
            return this.reportStore?.isLoading || false;
        },
        isAnalyzing() {
            return this.reportStore?.isAnalyzing || false;
        },
        loadingMessage() {
            return this.reportStore?.loadingMessage || 'Scanning index references...';
        },
        // Primary action: Resolve (in-place, labelled; the trailing action cell)
        resolveAction() {
            return { run: (row) => this.openResolutionModal(row), label: 'Resolve' };
        },
        tableData() {
            if (!this.reportStore?.data) return [];
            return this.reportStore.data.map(row => ({
                ...row,
                typeLabel: row.referenceType === 'client' ? 'Client' : 'Show'
            }));
        },
        emptyMessage() {
            if (!this.isLoading && !this.isAnalyzing) {
                return 'No index mismatches found. All client and show names resolve correctly.';
            }
            return '';
        }
    },
    methods: {
        handleRefresh() {
            if (this.reportStore) {
                this.reportStore.load();
            }
        },
        clearResolution(row) {
            const originalRow = this.reportStore.data.find(
                r => r.rawValue === row.rawValue && r.referenceType === row.referenceType
            );
            if (originalRow) {
                originalRow.resolution = '';
                if (originalRow.AppData) {
                    delete originalRow.AppData.pendingResolutions;
                }
            }
        },
        async saveResolutions() {
            const rowsWithResolutions = this.reportStore.data.filter(row => row.AppData?.pendingResolutions?.length > 0);
            if (!rowsWithResolutions.length) return true;

            for (const row of rowsWithResolutions) {
                const options = row.AppData.pendingResolutions || [];
                for (const option of options) {
                    try {
                        if (option.actionType === 'add-new') {
                            await Requests.addScheduleReferenceName(row.referenceType, option.canonicalName);
                        } else if (option.actionType === 'add-abbreviation') {
                            await Requests.appendScheduleReferenceAbbreviation(row.referenceType, option.canonicalName, option.abbreviation);
                        } else if (option.actionType === 'add-custom') {
                            const result = await Requests.addCustomScheduleReferenceEntry(row.referenceType, option.canonicalName, option.abbreviation);
                            if (!result?.applied) {
                                // If name conflicts, add as abbreviation to the existing entry instead
                                if (result?.conflict?.field === 'name' && result?.conflict?.existingName) {
                                    await Requests.appendScheduleReferenceAbbreviation(
                                        row.referenceType,
                                        result.conflict.existingName,
                                        option.abbreviation
                                    );
                                } else {
                                    const conflictValue = result?.conflict?.value || option.canonicalName;
                                    const fieldLabel = result?.conflict?.field === 'abbreviation' ? 'abbreviation' : 'name';
                                    throw new Error(`The ${fieldLabel} "${conflictValue}" already exists in the index.`);
                                }
                            }
                        } else if (option.actionType === 'add-override-link' || option.actionType === 'add-override-ignore') {
                            await Requests.addNameOverride(option.scheduleId || '', option.packlistId || '');
                        }
                    } catch (error) {
                        throw new Error(`Failed to apply resolution for "${row.rawValue}": ${error.message}`);
                    }
                }
            }

            // Immediately reload the report to clear resolved rows
            await this.reportStore.load();

            return true;
        },
        initializeStore() {
            const self = this;
            this.reportStore = getReactiveStore(
                Requests.getIndexMismatches,
                async () => await self.saveResolutions(),
                [],
                [],
                true
            );
        },
        async openResolutionModal(row, includeAllCandidates = false) {
            try {
                const resolutionData = await Requests.getScheduleReferenceResolutionOptions(
                    row.referenceType,
                    row.rawValue,
                    includeAllCandidates
                );
                const options = resolutionData?.options || [];
                if (options.length === 0) {
                    this.$modal.alert('No resolution options available for this value.', 'Missing');
                    return;
                }
                const modalTitle = includeAllCandidates
                    ? `Select ${row.referenceType}`
                    : `${row.referenceType === 'show' ? 'Show' : 'Client'} Missing`;
                const issue = { referenceType: row.referenceType, rawValue: row.rawValue };
                const self = this;
                this.$modal.custom(IndexResolutionComponent, {
                    issue,
                    options,
                    includeAllCandidates,
                    showDescription: false,
                    sources: row.sources || [],
                    onFetchOverrideTargets: (sourceType) => Requests.getOverrideTargets(sourceType),
                    onAddOverride: async (scheduleId, packlistId) => {
                        const originalRow = self.reportStore.data.find(
                            r => r.rawValue === row.rawValue && r.referenceType === row.referenceType
                        );
                        if (!originalRow) return { applied: false };

                        const isIgnore = scheduleId === IGNORE_KEYWORD || packlistId === IGNORE_KEYWORD;
                        const ignoredIdentifier = isIgnore ? (scheduleId === IGNORE_KEYWORD ? packlistId : scheduleId) : '';
                        const label = isIgnore
                            ? `ignore failure to resolve "${ignoredIdentifier}"`
                            : `link "${scheduleId}" to "${packlistId}"`;

                        if (!originalRow.AppData) originalRow.AppData = {};
                        if (!originalRow.AppData.pendingResolutions) originalRow.AppData.pendingResolutions = [];

                        originalRow.AppData.pendingResolutions.push({
                            actionType: isIgnore ? 'add-override-ignore' : 'add-override-link',
                            scheduleId: scheduleId || '',
                            packlistId: packlistId || '',
                            label
                        });

                        // Update resolution display as joined string
                        originalRow.resolution = originalRow.AppData.pendingResolutions.map(r => r.label).join('\n');
                        return { applied: true };
                    },
                    onSelectOption: async (option) => {
                        if (option.actionType === 'browse-all') {
                            await self.openResolutionModal(row, true);
                            return { applied: false, browsedAll: true };
                        }
                        // Find the original row in reportStore.data and write resolution directly
                        const originalRow = self.reportStore.data.find(
                            r => r.rawValue === row.rawValue && r.referenceType === row.referenceType
                        );
                        if (originalRow) {
                            if (!originalRow.AppData) originalRow.AppData = {};
                            if (!originalRow.AppData.pendingResolutions) originalRow.AppData.pendingResolutions = [];

                            originalRow.AppData.pendingResolutions.push({
                                ...option,
                                label: option.label
                            });

                            // Update resolution display as joined string
                            originalRow.resolution = originalRow.AppData.pendingResolutions.map(r => r.label).join('\n');
                        }
                        return { applied: true };
                    },
                    modalClass: 'hamburger-menu'
                }, modalTitle);
            } catch (error) {
                console.error('[IndexMismatchReport] Failed to open resolution modal:', error);
                this.$modal.error(`Failed to load resolution options: ${error.message}`, 'Resolution Error');
            }
        },
    },
    mounted() {
        this.initializeStore();
    },
    template: html`
        <DataView
            :fields="MISMATCH_FIELDS"
            :rows="tableData"
            :registry="MISMATCH_VIEWS"
            edit-mode="batch"
            :action="resolveAction"
            :original-data="reportStore?.originalData || []"
            :is-loading="isLoading"
            :is-analyzing="isAnalyzing"
            :loading-message="loadingMessage"
            :empty-message="emptyMessage"
            :show-search="true"
            :show-refresh="false"
            :show-undo-redo="false"
            :sync-search-with-url="true"
            :container-path="containerPath || 'reports/index-mismatches'"
            :navigate-to-path="navigateToPath"
            @refresh="handleRefresh"
            @on-save="() => reportStore.save()"
        >
            <!-- Page cells (field.cell = 'slot') -->
            <template #cell="{ row, field: column }">
                <div v-if="column.key === 'resolution'" style="line-height: 1.6;">
                    <template v-if="row.resolution">
                        <div v-for="(line, idx) in row.resolution.split('\n')" :key="idx">
                            {{ line }}
                        </div>
                        <button
                            @click="clearResolution(row)"
                            class="red column-button"
                            title="Clear all resolutions"
                        >
                            ✕
                        </button>
                    </template>
                    <span v-else>—</span>
                </div>
                <div v-else-if="column.key === 'sourcesSummary'" style="line-height: 1.6;">
                    <div v-for="(source, idx) in row.sources" :key="idx">
                        [{{ source.sourceType }}] {{ source.identifier }}
                    </div>
                </div>
            </template>
        </DataView>
    `
};
