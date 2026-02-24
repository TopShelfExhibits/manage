import { html, ScheduleTableComponent, hamburgerMenuRegistry, DashboardToggleComponent, NavigationRegistry, Requests, ScheduleFilterSelect } from '../../index.js';
import { normalizeFilterValues } from '../../../data_management/utils/helpers.js';

// Schedule Hamburger Menu Component
export const ScheduleMenuComponent = {
    props: {
        containerPath: String,
        containerType: String,
        currentView: String,
        title: String,
        navigateToPath: Function
    },
    inject: ['$modal'],
    computed: {
        menuItems() {
            const items = [];
            
            // Placeholder items - not yet implemented
            // items.push(
            //     { label: 'Calendar View', action: 'showCalendarView', disabled: true },
            //     { label: 'Chart View', action: 'showChartView', disabled: true },
            //     { label: 'Set Current As Default', action: 'setAsDefault', disabled: true }
            // );
            
            return items;
        }
    },
    methods: {
        handleAction(action) {
            // Close the menu before action
            this.$emit('close-modal');

            switch (action) {
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
        ScheduleFilterSelect
    },
    inject: ['$modal'],
    props: {
        navigateToPath: Function,
        containerPath: {
            type: String,
            default: 'schedule'
        }
    },
    data() {
        return {
            filter: null
        };
    },
    computed: {
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
    mounted() {
        // Register schedule navigation routes
        NavigationRegistry.registerNavigation('schedule', {
            routes: {
                //advanced-search': {
                //    displayName: 'Advanced Search',
                //    dashboardTitle: 'Schedule Advanced Search',
                //    icon: 'search'
                //}
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
                        { column: 'Show Date', value: searchData.startDate, type: 'after' },
                        { column: 'Show Date', value: searchData.endDate, type: 'before' }
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
            
            // Apply text filters
            if (searchData.textFilters && searchData.textFilters.length > 0) {
                searchData.textFilters.forEach(textFilter => {
                    if (textFilter.column && (textFilter.values || textFilter.value)) {
                        filter.searchParams[textFilter.column] = {
                            values: normalizeFilterValues(textFilter),
                            type: textFilter.type || 'contains'
                        };
                    }
                });
            }
            
            this.filter = filter;
        }
    },
    template: html`
        <slot>
            <!-- Main Schedule View (Year Selector & Results Table) -->
            <div class="schedule-page">
                <ScheduleTableComponent 
                    :filter="dateFilter"
                    :search-params="tableSearchParams"
                    @navigate-to-path="navigateToPath"
                >
                    <template #header-area>
                        <div class="button-bar">
                            <ScheduleFilterSelect
                                container-path="schedule"
                                :include-years="true"
                                :start-year="2023"
                                :navigate-to-path="navigateToPath"
                                :show-advanced-button="true"
                                default-search="Upcoming"
                                @search-selected="handleSearchSelected"
                            />
                        </div>
                    </template>
                </ScheduleTableComponent>
            </div>
        </slot>
    `
};
