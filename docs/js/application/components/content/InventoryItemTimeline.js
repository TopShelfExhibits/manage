import { html, Requests, NavigationRegistry, DataView, ScheduleFilterSelect, getReactiveStore, toISODateString, todayISOString, offsetToISO, ItemImageComponent } from '../../index.js';
import { useSearch } from '../../utils/useSearch.js';
import { valueMatchesAny } from '../../utils/views/searchMatch.js';

// What each timeline key is (calendarStart/End are derived on a computed copy of the rows)
const TIMELINE_FIELDS = [
    { key: 'date', label: 'Date', sortable: true, format: 'date', type: 'date' },
    { key: 'quantity', label: 'Quantity', sortable: false, format: 'number', type: 'number' },
    { key: 'event', label: 'Event', sortable: false },
    { key: 'note', label: 'Note', sortable: false },
    { key: 'change', label: 'Change', sortable: false },
    { key: 'calendarStart', label: 'Start', format: 'date', type: 'date' },
    { key: 'calendarEnd', label: 'End', format: 'date', type: 'date' }
];

// Timeline view registry (views-and-renderers-plan §4.3, §5)
const TIMELINE_VIEWS = {
    id: 'item-timeline',
    default: 'table',
    theme: 'purple',
    views: [
        {
            id: 'table',
            name: 'Timeline',
            icon: 'table',
            layout: 'table',
            columns: ['date', 'quantity', 'event', 'note', 'change'],
            hidden: ['calendarStart', 'calendarEnd'],
            table: { hideRowsOnSearch: false },
            style: {
                date: { width: 120 },
                quantity: { width: 90, color: 'auto' },
                event: { width: 120 },
                change: { width: 160 }
            }
        },
        {
            id: 'calendar',
            name: 'Calendar',
            icon: 'calendar_month',
            layout: 'calendar',
            calendar: {
                start: 'calendarStart',
                end: 'calendarEnd',
                chip: [['quantity', 'event', 'note'], ['change']]
            },
            hidden: ['calendarStart', 'calendarEnd'],
            rowColor: { field: 'quantity', rule: 'auto', fallback: 'green' },
            action: 'row'
        }
    ]
};

/**
 * Lightweight item timeline component.
 * Mountable as a subpage at inventory/<category>/<item#>
 * or in a modal. Accepts date range via URL path params.
 *
 * URL path params used (on the container path):
 *   startDate  YYYY-MM-DD
 *   endDate    YYYY-MM-DD
 */
export const InventoryItemTimeline = {
    components: { DataView, ScheduleFilterSelect, ItemImageComponent },
    inject: ['$modal', 'appContext'],
    props: {
        containerPath: { type: String, default: '' },
        navigateToPath: Function,
        // When used directly (not as a route), these can be passed as props
        itemId: { type: String, default: null },
        startDate: { type: String, default: null },
        endDate: { type: String, default: null }
    },
    setup(props) {
        // Initialize search composable
        const search = useSearch({
            syncWithUrl: true,
            navigationRegistry: NavigationRegistry,
            containerPath: props.containerPath,
            appContext: Vue.inject('appContext')
        });

        // Return search properties and methods to be available in component
        return {
            search
        };
    },
    data() {
        return {
            filterStartDate: null,
            filterEndDate: null,
            resolvedItemId: null,
            TIMELINE_FIELDS,
            TIMELINE_VIEWS
        };
    },
    computed: {
        timelineStore() {
            if (!this.resolvedItemId) return null;
            const effectiveStart = this.startDate || this.filterStartDate;
            const effectiveEnd   = this.endDate   || this.filterEndDate;
            return getReactiveStore(
                Requests.getItemTimeline,
                null,
                [this.resolvedItemId, effectiveStart, effectiveEnd]
            );
        },
        itemInfoStore() {
            if (!this.resolvedItemId) return null;
            return getReactiveStore(
                Requests.getInventoryInfo,
                null,
                [this.resolvedItemId, ['description', 'notes', 'quantity']]
            );
        },
        itemInfo() {
            const data = this.itemInfoStore?.data;
            if (!data || !data.length) return null;
            return data[0];
        },
        itemInfoEntries() {
            if (!this.itemInfo) return null;
            return Object.entries(this.itemInfo)
                .filter(([key, value]) => key !== 'itemName' && !(value !== null && typeof value === 'object'));
        },
        calendarData() {
            const raw = this.timelineStore?.data ?? [];
            if (!raw.length) return [];
            const effectiveEnd = this.endDate || this.filterEndDate || todayISOString();
            return raw.map((row, i) => {
                const nextRow = raw[i + 1];
                let calendarEnd;
                if (nextRow && nextRow.date > row.date) {
                    const d = new Date(nextRow.date + 'T00:00:00');
                    d.setDate(d.getDate() - 1);
                    calendarEnd = toISODateString(d);
                } else {
                    calendarEnd = nextRow ? row.date : effectiveEnd;
                }
                return { ...row, calendarStart: row.date, calendarEnd };
            });
        }
    },
    watch: {
        'appContext.currentPath': {
            handler(newPath, oldPath) {
                if (!this.containerPath || !oldPath) return;
                const newParams = NavigationRegistry.getParametersForContainer(this.containerPath, newPath);
                const oldParams = NavigationRegistry.getParametersForContainer(this.containerPath, oldPath);
                if (JSON.stringify(newParams) === JSON.stringify(oldParams)) return;
                this.resolveItemIdFromPath();
            }
        },
        resolvedItemId: {
            immediate: true,
            handler() {
                this.resolveItemIdFromPath();
            }
        }
    },
    methods: {
        resolveItemIdFromPath() {
            // Path shape: inventory/<category>/<item>
            if (this.itemId) {
                this.resolvedItemId = this.itemId;
                return;
            }
            const path = (this.containerPath || '').split('?')[0];
            const segments = path.split('/');
            // segments[0]=inventory, [1]=category, [2]=item
            if (segments.length >= 3) {
                this.resolvedItemId = segments[2] ? decodeURIComponent(segments[2]) : null;
            } else {
                this.resolvedItemId = null;
            }
        },
        handleScheduleSearch(searchData) {
            // searchData.startDate/endDate are ISO strings when available (ISO date picker,
            // year preset, or async-resolved overlap mode). They are null when the filter
            // uses a numeric day-offset preset (e.g. "month ago" = -30, "in a year" = 365).
            // Resolve offsets to real dates here so the timeline store always gets ISO strings.
            let startDate = searchData?.startDate ?? null;
            let endDate   = searchData?.endDate   ?? null;

            if ((!startDate || !endDate) && searchData?.dateFilters?.length) {
                // Find any 'after' and 'before' filters regardless of column (inventory timeline doesn't care about columns)
                const afterFilter  = searchData.dateFilters.find(f => f.type === 'after');
                const beforeFilter = searchData.dateFilters.find(f => f.type === 'before');
                if (!startDate && afterFilter)  startDate = offsetToISO(afterFilter.value);
                if (!endDate   && beforeFilter) endDate   = offsetToISO(beforeFilter.value);
            }

            this.filterStartDate = startDate;
            this.filterEndDate   = endDate;
            // timelineStore computed reacts automatically to the filter change
        },
        hasSearchMatch(value) {
            return valueMatchesAny(value, this.search.searchWords.value);
        }
    },
    mounted() {
        this.resolveItemIdFromPath();
        // Initialize search from URL and setup watcher
        this.search.initializeFromUrl();
        this.search.setupUrlWatcher();
    },
    template: html`
        <!-- Loading state while resolving identifier -->
        <div v-if="!itemInfoStore || itemInfoStore.isLoading" class="loading-message">
            <img src="assets/loading.gif" alt="..."/>
            <p>Finding item...</p>
        </div>
        <!-- 404 state when item not found (aka when the store returns null) -->
        <div v-else-if="itemInfoStore && itemInfoStore.data && itemInfoStore.data.length === 0">
            <div class="card red">
                <h3>Item Not Found</h3>
                <p>"{{ resolvedItemId }}" could not be found.</p>
            </div>
        </div>
        <div v-else>
            <div v-if="resolvedItemId" style="margin-bottom: var(--padding-md);">
                <div style="display: flex; gap: var(--padding-md); align-items: flex-start;">
                    <ItemImageComponent
                        :itemNumber="resolvedItemId"
                        :imageSize="96"
                        :editable="true"
                    />
                    <div class="details-grid" style="--details-grid-min-column-width: 300px;">
                        <div class="detail-item">
                            <label>Item#:</label>
                            <span :class="{ 'search-match': hasSearchMatch(resolvedItemId) }">{{ resolvedItemId }}</span>
                        </div>
                        <template v-if="itemInfoEntries">
                            <div v-for="[key, value] in itemInfoEntries" :key="key" class="detail-item">
                                <label>{{ key.charAt(0).toUpperCase() + key.slice(1) }}:</label>
                                <span :class="{ 'search-match': hasSearchMatch(value) }">{{ value != null && value !== '' ? value : '—' }}</span>
                            </div>
                        </template>
                        <template v-else>
                            <div class="detail-item"><span>...</span></div>
                        </template>
                    </div>
                </div>
            </div>
            <DataView
                :fields="TIMELINE_FIELDS"
                :rows="calendarData"
                :registry="TIMELINE_VIEWS"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
                :details-title="row => [row.event, row.note].filter(Boolean).join(' — ') || 'Event Details'"
                :show-search="false"
                :show-refresh="false"
                :is-loading="timelineStore?.isLoading ?? false"
                :loading-message="timelineStore?.loadingMessage || 'Loading timeline...'"
                :error="timelineStore?.error ?? null"
                :empty-message="(filterStartDate || filterEndDate) ? 'No inventory usage found in this date range. Try expanding the date filters.' : 'This item has no inventory changes. Set a date filter to see usage data.'"
            >
                <template #header-area>
                    <div class="button-bar">
                        <ScheduleFilterSelect
                            :container-path="containerPath"
                            :navigate-to-path="navigateToPath"
                            :show-advanced-button="true"
                            @search-selected="handleScheduleSearch"
                        />
                    </div>
                </template>
            </DataView>
        </div>
    `
};
