import { html, ScheduleTableComponent, hamburgerMenuRegistry, DashboardToggleComponent, NavigationRegistry, Requests, ScheduleFilterSelect } from '../../index.js';
import { TransshipmentModal } from '../interface/ScheduleModals.js';
import { DesignQueueContent } from './DesignQueueContent.js';
import { textFiltersToSearchParams } from '../../../data_management/utils/helpers.js';

// Schedule Hamburger Menu Component
export const ScheduleMenuComponent = {
    props: {
        containerPath: String,
        containerType: String,
        currentSegment: String,
        title: String,
        navigateToPath: Function
    },
    inject: ['$modal'],
    computed: {
        menuItems() {
            return [
                { label: 'Design Queue', action: 'designQueue' },
                { label: 'Manage Transshipments', action: 'manageTransshipments' }
            ];
        }
    },
    methods: {
        handleAction(action) {
            this.$emit('close-modal');
            switch (action) {
                case 'designQueue':
                    if (this.navigateToPath) {
                        this.navigateToPath('schedule/design-queue');
                    }
                    break;
                case 'manageTransshipments':
                    this.$modal.custom(TransshipmentModal, { size: 'page', tall: true }, 'Manage Transshipments');
                    break;
                case 'advancedSearch':
                    if (this.navigateToPath) {
                        this.navigateToPath('schedule/advanced-search');
                    }
                    break;
                default:
                    this.$modal.alert(`Action ${action} not implemented yet.`, 'Info');
            }
        }
    },
    template: html`
        <ul>
            <li v-for="item in menuItems" :key="item.action">
                <button 
                    @click="handleAction(item.action)"
                    :disabled="item.disabled"
                    >
                    {{ item.label }}
                </button>
            </li>
        </ul>
    `
};

export const ScheduleContent = {
    components: {
        ScheduleTableComponent,
        ScheduleFilterSelect,
        DesignQueueContent
    },
    inject: ['$modal'],
    props: {
        navigateToPath: Function,
        containerPath: {
            type: String,
            default: 'schedule'
        }
    },
    computed: {
        cleanContainerPath() {
            return (this.containerPath || 'schedule').split('?')[0].replace(/\/calendar$/, '');
        },
        // The effective base path for ScheduleFilterSelect URL sync
        scheduleBasePath() {
            return this.cleanContainerPath;
        },
        // Split filter into dateFilters and searchParams for table
        dateFilter() {
            if (!this.filter) return null;
            const { searchParams, ...dateFilter } = this.filter;
            return Object.keys(dateFilter).length > 0 ? dateFilter : null;
        },
        tableSearchParams() {
            return this.filter?.searchParams || null;
        }
    },
    data() {
        return {
            filter: null
        };
    },

    mounted() {
        // Register schedule navigation routes
        NavigationRegistry.registerNavigation('schedule', {
            routes: {
                // Design queue: its own page under Schedule (R2.9, R6.1)
                'design-queue': {
                    displayName: 'Design Queue',
                    dashboardTitle: 'Design Queue'
                }
            }
        });

        // Register hamburger menu for schedule
        hamburgerMenuRegistry.registerMenu('schedule', {
            components: [ScheduleMenuComponent, DashboardToggleComponent],
            props: {
                navigateToPath: this.navigateToPath
            }
        });
    },
    methods: {
        handleSearchSelected(searchData) {
            // Handle empty/null search - clear the filter
            if (!searchData) {
                this.filter = null;
                return;
            }
            
            if (searchData.type === 'year') {
                // Handle year selection - use dateFilters array
                this.filter = { 
                    dateFilters: searchData.dateFilters || [
                        { column: 'Date', value: searchData.startDate, type: 'after' },
                        { column: 'Date', value: searchData.endDate, type: 'before' }
                    ]
                };
            } else {
                // Handle saved search or URL params
                this.applySavedSearch(searchData);
            }
        },
        
        applySavedSearch(searchData) {
            const filter = {
                searchParams: {}
            };
            
            // Use dateFilters array from saved search
            if (searchData.dateFilters && searchData.dateFilters.length > 0) {
                filter.dateFilters = searchData.dateFilters;
            }
            
            // Apply text filters (filters on the same column are kept together and OR'd)
            Object.assign(filter.searchParams, textFiltersToSearchParams(searchData.textFilters));
            
            this.filter = filter;
        }
    },
    template: html`
        <slot>
            <DesignQueueContent
                v-if="cleanContainerPath === 'schedule/design-queue'"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
            />
            <div v-else class="schedule-page">
                <ScheduleTableComponent
                    :filter="dateFilter"
                    :search-params="tableSearchParams"
                    :container-path="containerPath"
                    :navigate-to-path="navigateToPath"
                    @navigate-to-path="navigateToPath"
                >
                    <template #header-area>
                        <div class="button-bar">
                            <ScheduleFilterSelect
                                :container-path="scheduleBasePath"
                                :include-years="true"
                                :start-year="2023"
                                :navigate-to-path="navigateToPath"
                                :show-advanced-button="true"
                                @search-selected="handleSearchSelected"
                            />
                        </div>
                    </template>
                </ScheduleTableComponent>
            </div>
        </slot>
    `
};
