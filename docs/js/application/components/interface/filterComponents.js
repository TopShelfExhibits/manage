import { html, getReactiveStore, Requests, authState, NavigationRegistry, buildTextFilterParameters, parseTextFilterParameters, LoadingBarComponent, createAnalysisConfig, parseDateFilterParameters, buildDateFilterParameters, toISODateString, parseDate, toUSDateString, offsetToISO, Priority, DataView } from '../../index.js';
import { columnTypeMap, columnTypeOf } from '../../../data_management/utils/column-types.js';

// Filter types that take no values: "is empty" (text filters), "checked" / "unchecked" (checkbox filters)
const VALUELESS_TYPES = ['empty', 'checked', 'unchecked'];
const CHECKBOX_TYPES = ['checked', 'unchecked'];
function isCheckboxFilter(filter) {
    return CHECKBOX_TYPES.includes(filter?.type);
}

// Shared utility: Match URL search data to a saved search
function matchUrlToSavedSearch(savedSearches, urlSearchData) {
    if (!savedSearches || savedSearches.length === 0) return -1;
    
    return savedSearches.findIndex(search => {
        // Compare date filters arrays
        const searchDateFilters = search.dateFilters || [];
        const urlDateFilters = urlSearchData.dateFilters || [];
        if (searchDateFilters.length !== urlDateFilters.length) return false;
        
        // Check if all date filters match
        const dateFiltersMatch = searchDateFilters.every(sf => 
            urlDateFilters.some(uf => 
                uf.column === sf.column && 
                uf.value === sf.value &&
                (uf.type || 'after') === (sf.type || 'after')
            )
        ) && urlDateFilters.every(uf => 
            searchDateFilters.some(sf => 
                sf.column === uf.column && 
                sf.value === uf.value &&
                (sf.type || 'after') === (uf.type || 'after')
            )
        );
        
        if (!dateFiltersMatch) return false;
        
        // Compare text filters arrays
        const searchFilters = search.textFilters || [];
        const urlFilters = urlSearchData.textFilters || [];
        if (searchFilters.length !== urlFilters.length) return false;
        
        return searchFilters.every(sf => 
            urlFilters.some(uf => {
                const sfValues = normalizeValues(sf);
                const ufValues = normalizeValues(uf);
                return uf.column === sf.column && 
                    JSON.stringify(sfValues.sort()) === JSON.stringify(ufValues.sort()) &&
                    (uf.type || 'contains') === (sf.type || 'contains');
            })
        ) && urlFilters.every(uf => 
            searchFilters.some(sf => {
                const sfValues = normalizeValues(sf);
                const ufValues = normalizeValues(uf);
                return sf.column === uf.column && 
                    JSON.stringify(sfValues.sort()) === JSON.stringify(ufValues.sort()) &&
                    (sf.type || 'contains') === (uf.type || 'contains');
            })
        );
    });
}

// Shared utility: Normalize filter values for backward compatibility
function normalizeValues(filter) {
    return filter.values || (filter.value ? [filter.value] : []);
}

// Values for the editor: at least one input, so switching a value-less filter back to
// "Contains" shows a box to type in
function editableValues(filter) {
    const values = normalizeValues(filter);
    return values.length ? values : [''];
}

// Shared utility: Validate and clean text filters (value-less types need only a column)
function getValidTextFilters(textFilters) {
    return textFilters
        .filter(f => f.column && (VALUELESS_TYPES.includes(f.type) || (f.values && f.values.some(v => v.trim()))))
        .map(f => ({
            column: f.column,
            values: VALUELESS_TYPES.includes(f.type) ? [] : f.values.filter(v => v.trim()),
            type: f.type || 'contains'
        }));
}

// A filter card is complete (green) when it has a column and, for value types, a value
function isFilterComplete(filter) {
    return !!filter.column && (VALUELESS_TYPES.includes(filter.type) || (filter.values || []).some(v => String(v).trim()));
}

// Shared utility: Clean filter objects by removing AppData and other metadata
function cleanFilters(filters) {
    if (!filters || !Array.isArray(filters)) return filters;
    
    return filters.map(filter => {
        const { AppData, ...cleanFilter } = filter;
        return cleanFilter;
    });
}

// Shared utility: Resolve a window start/end from a dateFilters array.
// Finds the first after/before filter regardless of column and extracts their values as ISO strings.
// Returns { startDate, endDate } — either may be null if not present or not resolvable.
function resolveWindowDates(dateFilters) {
    if (!dateFilters?.length) return { startDate: null, endDate: null };
    const afterFilter  = dateFilters.find(f => f.type === 'after');
    const beforeFilter = dateFilters.find(f => f.type === 'before');
    // Values can be ISO strings or numeric offsets; only include real date strings
    const toDateStr = (v) => (v != null && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;
    return {
        startDate: toDateStr(afterFilter?.value)  ?? null,
        endDate:   toDateStr(beforeFilter?.value) ?? null
    };
}

// Shared utility: Initialize saved searches store
function initializeSavedSearchesStore() {
    if (!authState.isAuthenticated || !authState.user?.email) {
        return null;
    }
    return getReactiveStore(
        Requests.getUserData,
        Requests.storeUserData,
        [authState.user.email, 'saved_searches'],
        null,
        true
    );
}

// Advanced Search Component for Schedule - Filter Creation UI Only
export const ScheduleAdvancedFilter = {
    components: {
        LoadingBarComponent
    },
    inject: ['$modal', 'appContext'],
    props: {
        containerPath: String,
        navigateToPath: Function,
        onSearchSelected: Function, // Callback for when used in modal
        registerSubmitAction: Function // Callback to register submit action for keyboard Enter
    },
    data() {
        return {
            // Date filters array - each item: { id, type('after'|'before'), column, mode('date'|'offset'), value }
            dateFilters: [],
            nextDateFilterId: 1,
            
            // Dynamic text search filters - start empty
            textFilters: [],
            nextFilterId: 1,
            
            // Reactive store for saved searches
            savedSearchesStore: null,
            
            // Reactive store for production schedule data (for column loading)
            scheduleStore: null,
            // Declared column types of the Production Schedule (ColumnTypes preference)
            columnTypesStore: null,
            
            // Selected saved search for update/delete
            selectedSavedSearchIndex: null // null = "New Search"
        };
    },
    computed: {
        // Get saved searches from store
        savedSearches() {
            return this.savedSearchesStore?.data || [];
        },
        // Get currently selected saved search
        selectedSavedSearch() {
            if (this.selectedSavedSearchIndex === null || !this.savedSearches.length) {
                return null;
            }
            return this.savedSearches[this.selectedSavedSearchIndex];
        },
        // Get schedule data from store
        scheduleData() {
            return this.scheduleStore?.data || [];
        },
        // Computed columns from store data
        availableColumns() {
            if (!this.scheduleData || this.scheduleData.length === 0) {
                return [];
            }
            
            // Extract column headers from first row
            const firstRow = this.scheduleData[0];
            return Object.keys(firstRow)
                .filter(key => key !== 'AppData')
                .sort();
        },
        // Each column's type: declared in ColumnTypes, else the shared name guess (utils/column-types.js)
        columnTypes() {
            return columnTypeMap(this.columnTypesStore?.data);
        },
        // Date columns ('Date' is always offered: the default date filter column)
        dateColumns() {
            const dateColumns = this.availableColumns.filter(col => columnTypeOf(this.columnTypes, col).type === 'date');
            if (!dateColumns.includes('Date')) dateColumns.unshift('Date');
            return dateColumns;
        },
        // Checkbox columns (declared only: an undeclared column is never a checkbox)
        checkboxColumns() {
            return this.availableColumns.filter(col => columnTypeOf(this.columnTypes, col).type === 'checkbox');
        },
        // Text filter columns (all columns except date and checkbox columns)
        textFilterColumns() {
            return this.availableColumns.filter(col => !this.dateColumns.includes(col) && !this.checkboxColumns.includes(col));
        },
        // The filter list holds both kinds; checkbox filters are the checked / unchecked types
        textOnlyFilters() {
            return this.textFilters.filter(f => !isCheckboxFilter(f));
        },
        checkboxFilters() {
            return this.textFilters.filter(f => isCheckboxFilter(f));
        },
        // Loading states from store
        isLoadingColumns() {
            return this.scheduleStore?.isLoading || this.scheduleStore?.isAnalyzing || false;
        },
        // Check if all filters are valid (every date filter must have column + value)
        isFormValid() {
            return this.dateFilters.every(f => f.column && f.value !== '' && f.value != null);
        },
        authIsAuthenticated() {
            return authState.isAuthenticated;
        }
    },
    async mounted() {
        // Initialize schedule store for column loading
        await this.initializeScheduleStore();
        
        // Initialize saved searches store
        this.savedSearchesStore = initializeSavedSearchesStore();
        
        // Sync filters with URL parameters
        this.syncWithURL();

        // Register the saveFiltersToURL method as the modal submit action for Enter key handling
        if (this.registerSubmitAction) {
            this.registerSubmitAction(this.saveFiltersToURL);
        }
    },
    watch: {
        // Reinitialize stores when auth is restored after logout or reauth
        authIsAuthenticated(isAuth, wasAuth) {
            if (isAuth && !wasAuth) {
                this.savedSearchesStore = initializeSavedSearchesStore();
                this.initializeScheduleStore();
            }
        },
        // Watch for URL parameter changes
        'appContext.currentPath': {
            handler(newPath, oldPath) {
                // Skip initial load (handled by mounted)
                if (!oldPath) return;
                
                // Get params for both paths
                const newParams = NavigationRegistry.getParametersForContainer(
                    this.containerPath || 'schedule/advanced-search',
                    newPath
                );
                const oldParams = NavigationRegistry.getParametersForContainer(
                    this.containerPath || 'schedule/advanced-search',
                    oldPath
                );
                
                // Skip if params haven't actually changed
                if (JSON.stringify(newParams) === JSON.stringify(oldParams)) return;
                
                console.log('[AdvancedSearch] URL parameters changed, syncing filters');
                this.syncWithURL();
            }
        }
    },
    methods: {
        async initializeScheduleStore() {
            this.columnTypesStore = getReactiveStore(Requests.getColumnTypes, null, ['PROD_SCHED', 'Production Schedule']);
            // Initialize reactive store for production schedule (for column loading only)
            this.scheduleStore = getReactiveStore(
                Requests.getProductionScheduleData,
                null, // No save function
                [], // No arguments - load all shows
                null // No analysis needed
            );
            
            // Load the data
            await this.scheduleStore.load('Loading schedule columns...');
        },
        syncWithURL() {
            const params = NavigationRegistry.getParametersForContainer(
                this.containerPath || 'schedule/advanced-search',
                this.appContext?.currentPath
            );
            
            // No URL parameters - clear filters
            if (Object.keys(params).length === 0) {
                this.clearAllFilters();
                return;
            }
            
            const filter = {
                dateFilters: params.dateFilters || [],
                textFilters: params.textFilters || [],
                dateFilter: params.dateFilter || null
            };

            // Try to match URL to a saved search
            const matchedSearchIndex = matchUrlToSavedSearch(this.savedSearchesStore?.data || [], filter);
            if (matchedSearchIndex >= 0) {
                this.selectedSavedSearchIndex = matchedSearchIndex;
            }
            
            // Load URL date filters
            this.loadDateFilters(filter.dateFilters);
            
            // Load text filters
            if (filter.textFilters && filter.textFilters.length > 0) {
                // Add IDs for Vue reactivity
                this.textFilters = filter.textFilters.map((filter, index) => ({
                    id: index + 1,
                    column: filter.column,
                    values: editableValues(filter),
                    type: filter.type || 'contains'
                }));
                this.nextFilterId = filter.textFilters.length + 1;
            } else {
                // Start with no text filters
                this.textFilters = [];
                this.nextFilterId = 1;
            }
        },
        updateURL(params) {
            const targetPath = this.containerPath || 'schedule/advanced-search';
            const cleanPath = targetPath.split('?')[0];
            const isOnDashboard = this.appContext?.currentPath?.split('?')[0].split('/')[0] === 'dashboard';

            const newPath = NavigationRegistry.buildPathWithCurrentParams(
                cleanPath,
                this.appContext?.currentPath,
                params
            );

            if (isOnDashboard) {
                NavigationRegistry.dashboardRegistry.updatePath(
                    cleanPath,
                    newPath
                );
            } else if (this.navigateToPath) {
                this.navigateToPath(newPath);
            }
        },
        saveFiltersToURL() {
            const dateFilters = this.buildDateFiltersFromState();
            const validTextFilters = getValidTextFilters(this.textFilters);
            const params = {
                dateFilters: dateFilters.length > 0 ? dateFilters : undefined,
                textFilters: validTextFilters.length > 0 ? validTextFilters : undefined
            };
            this.updateURL(params);
            this.emitSearchSelected();
        },
        clearAllFilters() {
            this.dateFilters = [];
            this.nextDateFilterId = 1;
            this.textFilters = [];
            this.nextFilterId = 1;
            this.addDateFilter(); // Start with one date filter
        },
        addTextFilter() {
            this.textFilters.push({
                id: this.nextFilterId++,
                column: '',
                values: [''],
                type: 'contains'
            });
        },
        addCheckboxFilter() {
            this.textFilters.push({
                id: this.nextFilterId++,
                column: '',
                values: [],
                type: 'checked'
            });
        },
        isFilterComplete(filter) {
            return isFilterComplete(filter);
        },
        handleValueInput(filter, valueIndex, event) {
            const value = event.target.value;
            
            // Check if comma was typed
            if (value.includes(',')) {
                // Split by comma and trim
                const parts = value.split(',').map(v => v.trim()).filter(v => v);
                
                // Replace current value with parts and add an empty field for next input
                filter.values.splice(valueIndex, 1, ...parts, '');
                
                // Focus the new empty field after DOM updates
                this.$nextTick(() => {
                    // Find all inputs for this filter and focus the last one (newly created)
                    const filterElement = event.target.closest('.card');
                    if (filterElement) {
                        const inputs = filterElement.querySelectorAll('input[type="text"]');
                        if (inputs.length > 0) {
                            inputs[inputs.length - 1].focus();
                        }
                    }
                });
            } else {
                // Just update the current value, don't add new fields
                filter.values[valueIndex] = value;
            }
        },
        addValue(filter) {
            // Add a new empty value field
            filter.values.push('');
        },
        removeValue(filter, valueIndex) {
            if (filter.values.length > 1) {
                filter.values.splice(valueIndex, 1);
            } else {
                filter.values[0] = '';
            }
        },
        removeTextFilter(filterId) {
            this.textFilters = this.textFilters.filter(f => f.id !== filterId);
        },
        // --- Date filter array methods ---
        addDateFilter() {
            this.dateFilters.push({
                id: this.nextDateFilterId++,
                type: 'after',
                column: 'Date',
                mode: 'date',
                value: ''
            });
        },
        removeDateFilter(filterId) {
            this.dateFilters = this.dateFilters.filter(f => f.id !== filterId);
        },
        toggleDateFilterMode(filter) {
            const oldMode = filter.mode;
            const oldValue = filter.value;
            filter.mode = oldMode === 'date' ? 'offset' : 'date';
            if (oldValue !== '' && oldValue != null) {
                if (oldMode === 'offset' && !isNaN(Number(oldValue))) {
                    const date = new Date();
                    date.setDate(date.getDate() + Number(oldValue));
                    filter.value = toISODateString(date);
                } else if (oldMode === 'date' && typeof oldValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(oldValue)) {
                    const targetDate = parseDate(oldValue);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    targetDate.setHours(0, 0, 0, 0);
                    filter.value = Math.round((targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                } else {
                    filter.value = '';
                }
            } else {
                filter.value = '';
            }
        },
        getCalculatedDate(filter) {
            if (filter.mode === 'date') {
                return 'Offset Mode';
            }
            if (filter.mode === 'offset' && filter.value !== '' && !isNaN(Number(filter.value))) {
                const date = new Date();
                date.setDate(date.getDate() + Number(filter.value));
                return toUSDateString(date) || toISODateString(date);
            }
            return null;
        },
        // Build serializable dateFilters from the UI array
        buildDateFiltersFromState() {
            return this.dateFilters
                .filter(f => f.column && f.value !== '' && f.value != null)
                .map(f => ({
                    column: f.column,
                    value: f.mode === 'offset' ? Number(f.value) : f.value,
                    type: f.type
                }));
        },
        // Load raw dateFilters (from URL/saved search) into the UI array
        loadDateFilters(rawDateFilters) {
            this.nextDateFilterId = 1;
            this.dateFilters = (rawDateFilters || []).map(f => ({
                id: this.nextDateFilterId++,
                type: f.type || 'after',
                column: f.column || 'Date',
                mode: typeof f.value === 'number' ? 'offset' : 'date',
                value: f.value ?? ''
            }));
        },

        handleScheduleFilterSelection() {
            // When a saved search is selected, load it
            if (this.selectedSavedSearchIndex === null) {
                // "New Search" selected - don't load anything
                return;
            }
            
            const search = this.selectedSavedSearch;
            if (!search) return;
            
            // Load date filters from saved search
            this.loadDateFilters(search.dateFilters);
            
            // Load text filters
            if (search.textFilters && search.textFilters.length > 0) {
                this.textFilters = search.textFilters.map((filter, index) => ({
                    id: index + 1,
                    column: filter.column,
                    values: editableValues(filter),
                    type: filter.type || 'contains'
                }));
                this.nextFilterId = search.textFilters.length + 1;
            } else {
                this.textFilters = [];
                this.nextFilterId = 1;
            }
            
            // Note: Don't call saveFiltersToURL here - let user click Apply Filters to update URL
        },
        async updateSavedSearch() {
            if (this.selectedSavedSearchIndex === null || !this.selectedSavedSearch) {
                return;
            }
            
            try {
                const searchData = {
                    name: this.selectedSavedSearch.name,
                    dateFilters: this.buildDateFiltersFromState(),
                    textFilters: this.textFilters && this.textFilters.length > 0
                        ? getValidTextFilters(this.textFilters)
                        : []
                };
                
                // Update in store
                if (this.savedSearchesStore && this.savedSearchesStore.data) {
                    this.savedSearchesStore.data[this.selectedSavedSearchIndex] = searchData;
                    await this.savedSearchesStore.save();
                    
                    this.$modal.alert('Filter updated successfully!', 'Success');
                } else {
                    throw new Error('Saved filters store not initialized');
                }
            } catch (error) {
                console.error('Failed to update filter:', error);
                this.$modal.error('Failed to update the saved filter. Please try again or contact support if the problem persists.', 'Update Filter Error');
            }
        },
        deleteSavedSearch() {
            if (this.selectedSavedSearchIndex === null || !this.selectedSavedSearch) {
                return;
            }
            
            if (!authState.isAuthenticated || !authState.user?.email) {
                this.$modal.error('You must be logged in to delete filters.', 'Error');
                return;
            }
            
            const searchName = this.selectedSavedSearch.name;
            
            // Confirm deletion - correct API: confirm(message, onConfirm, onCancel, title)
            this.$modal.confirm(
                `Are you sure you want to delete "${searchName}"?`,
                async () => {
                    // onConfirm callback
                    try {
                        // Remove from store
                        if (this.savedSearchesStore && this.savedSearchesStore.data) {
                            this.savedSearchesStore.data.splice(this.selectedSavedSearchIndex, 1);
                            await this.savedSearchesStore.save();
                            
                            // Reset to "New Search"
                            this.selectedSavedSearchIndex = null;
                            
                            this.$modal.alert('Filter deleted successfully!', 'Success');
                        } else {
                            throw new Error('Saved filters store not initialized');
                        }
                    } catch (error) {
                        console.error('Failed to delete search:', error);
                        this.$modal.error('Failed to delete the saved filter. Please try again or contact support if the problem persists.', 'Delete Filter Error');
                    }
                },
                null, // onCancel callback (optional)
                'Confirm Deletion' // title
            );
        },
        async saveSearch() {
            // Create a modal component for saving the search
            const SaveSearchComponent = {
                props: {
                    dateFilters: Array,
                    textFilters: Array,
                    savedSearchesStore: Object,
                    ScheduleAdvancedFilter: Object
                },
                data() {
                    return {
                        searchName: '',
                        isSaving: false
                    };
                },
                inject: ['$modal'],
                methods: {
                    async handleSave() {
                        if (!this.searchName.trim()) {
                            this.$modal.alert('Please enter a name.', 'Warning');
                            return;
                        }
                        
                        if (!authState.isAuthenticated || !authState.user?.email) {
                            this.$modal.error('You must be logged in to save filters.', 'Error');
                            return;
                        }
                        
                        try {
                            this.isSaving = true;
                            
                            const searchData = {
                                name: this.searchName.trim(),
                                dateFilters: this.dateFilters || [],
                                textFilters: getValidTextFilters(this.textFilters || [])
                            };
                            
                            // Save using reactive store (passed as prop)
                            if (this.savedSearchesStore && this.savedSearchesStore.data) {
                                this.savedSearchesStore.data.push(searchData);
                                await this.savedSearchesStore.save();
                                
                                // Select the newly saved search in the parent component
                                if (this.ScheduleAdvancedFilter) {
                                    this.ScheduleAdvancedFilter.selectedSavedSearchIndex = this.savedSearchesStore.data.length - 1;
                                }
                                
                                this.$emit('close-modal');
                            } else {
                                throw new Error('Saved filters store not initialized');
                            }
                        } catch (error) {
                            console.error('Failed to save filter:', error);
                            this.$modal.error('Failed to save the filter. Please try again or contact support if the problem persists.', 'Save Filter Error');
                        } finally {
                            this.isSaving = false;
                        }
                    },
                    handleCancel() {
                        this.$emit('close-modal');
                    }
                },
                template: html`
                    <div>
                        <label style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem;">
                            <span style="font-weight: 500;">Search Name:</span>
                            <input 
                                type="text" 
                                v-model="searchName"
                                placeholder="Enter text"
                                style="padding: 0.5rem; font-size: 1rem;"
                                :disabled="isSaving"
                                @keyup.enter="handleSave"
                            />
                        </label>
                        <div class="button-bar">
                            <button @click="handleSave" class="green" :disabled="isSaving">{{ isSaving ? 'Saving...' : 'Save' }}</button>
                            <button @click="handleCancel" class="white">Cancel</button>
                        </div>
                    </div>
                `
            };
            
            // Open the modal
            this.$modal.custom(SaveSearchComponent, {
                dateFilters: this.buildDateFiltersFromState(),
                textFilters: this.textFilters,
                savedSearchesStore: this.savedSearchesStore,
                ScheduleAdvancedFilter: this
            }, 'Save Filter');
        },
        async emitSearchSelected() {
            const dateFilters = this.buildDateFiltersFromState();
            const windowDates = resolveWindowDates(dateFilters);
            const searchData = {
                dateFilters: dateFilters,
                textFilters: getValidTextFilters(this.textFilters),
                startDate: windowDates.startDate,
                endDate:   windowDates.endDate
            };
            
            // Call callback if in modal mode, otherwise emit to parent
            if (this.onSearchSelected) {
                this.onSearchSelected(searchData);
                // Close the modal after applying filters
                this.$emit('close-modal');
            } else {
                this.$emit('search-selected', searchData);
            }
        },

        // --- Preset methods ---
        applyUpcomingPreset() {
            // Find a saved search named "Upcoming" and apply it
            const upcomingSearch = (this.savedSearchesStore?.data || []).find(
                s => s.name && s.name.toLowerCase() === 'upcoming'
            );
            if (upcomingSearch) {
                this.loadDateFilters(upcomingSearch.dateFilters);
                if (upcomingSearch.textFilters && upcomingSearch.textFilters.length > 0) {
                    this.textFilters = upcomingSearch.textFilters.map((f, i) => ({
                        id: i + 1,
                        column: f.column,
                        values: editableValues(f),
                        type: f.type || 'contains'
                    }));
                    this.nextFilterId = upcomingSearch.textFilters.length + 1;
                } else {
                    this.textFilters = [];
                    this.nextFilterId = 1;
                }
            } else {
                // Fallback: no saved "Upcoming" — apply a sensible default (today onward)
                const today = toISODateString(new Date());
                this.loadDateFilters([{ column: 'Date', value: today, type: 'after' }]);
                this.textFilters = [];
                this.nextFilterId = 1;
            }
            this.saveFiltersToURL();
        },

        applyThisYearPreset() {
            const year = new Date().getFullYear();
            this.loadDateFilters([
                { column: 'Date', value: `${year}-01-01`, type: 'after' },
                { column: 'Date', value: `${year}-12-31`, type: 'before' }
            ]);
            this.textFilters = [];
            this.nextFilterId = 1;
            this.saveFiltersToURL();
        },

        openShowOverlapModal() {
            const self = this;

            const ShowOverlapModalComponent = {
                components: { DataView, ScheduleFilterSelect },
                inject: ['$modal', 'appContext'],
                data() {
                    return {
                        showsStore: null,
                        searchFilter: null
                    };
                },
                computed: {
                    allShows() {
                        return this.showsStore?.data || [];
                    },
                    isLoading() {
                        return this.showsStore?.isLoading || false;
                    },
                    tableData() {
                        // Data is already filtered at the store level via searchFilter watcher
                        return this.allShows;
                    },
                    fields() {
                        return [
                            { key: 'show', label: 'Show' },
                            { key: 'shipDate', label: 'Ship Date', format: 'date', type: 'date' },
                            { key: 'returnDate', label: 'Return', format: 'date', type: 'date' }
                        ];
                    },
                    // Single-view registry, no URL; Select is the primary action (button in the action cell)
                    registry() {
                        return {
                            id: 'show-overlap-picker',
                            default: 'table',
                            theme: 'gray',
                            views: [{ id: 'table', name: 'Shows', layout: 'table', columns: ['show', 'shipDate', 'returnDate'], sortable: ['show', 'shipDate', 'returnDate'], sort: { key: 'show', dir: 'asc' } }]
                        };
                    },
                    selectAction() {
                        return {
                            run: (row) => this.selectShow(row),
                            label: 'Select',
                            disabled: (row) => !row.shipDate && !row.returnDate
                        };
                    }
                },
                async mounted() {
                    this.showsStore = getReactiveStore(
                        Requests.getDeduplicatedShowDates,
                        null,
                        [null], // Initial filter is null (all shows)
                        null
                    );
                    await this.showsStore.load('Loading shows...');
                },
                watch: {
                    searchFilter: {
                        async handler(newFilter) {
                            // Reload the store with new filter parameters
                            const filterParam = newFilter ? {
                                dateFilters: newFilter.dateFilters,
                                textFilters: newFilter.textFilters
                            } : null;
                            
                            this.showsStore = getReactiveStore(
                                Requests.getDeduplicatedShowDates,
                                null,
                                [filterParam],
                                null
                            );
                            await this.showsStore.load('Loading shows...');
                        },
                        deep: true
                    }
                },
                methods: {
                    handleSearchSelected(searchData) {
                        this.searchFilter = searchData;
                    },
                    selectShow(show) {
                        if (!show.shipDate && !show.returnDate) return;
                        const filters = [];
                        if (show.shipDate) {
                            filters.push({ column: 'Recieved', value: show.shipDate, type: 'after' });
                        }
                        if (show.returnDate) {
                            filters.push({ column: 'Ship', value: show.returnDate, type: 'before' });
                        }
                        self.loadDateFilters(filters);
                        self.textFilters = [];
                        self.nextFilterId = 1;
                        self.saveFiltersToURL();
                        this.$emit('close-modal');
                    }
                },
                template: html`
                    <DataView
                        :fields="fields"
                        :rows="tableData"
                        :registry="registry"
                        :action="selectAction"
                        :isLoading="isLoading"
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
                                @search-selected="handleSearchSelected"
                            />
                        </template>
                    </DataView>
                `
            };

            this.$modal.custom(ShowOverlapModalComponent, { size: 'page', tall: true }, 'Select Show for Overlap');
        }
    },
    template: html`

            <!-- Loading state while columns are loading -->
            <div v-if="isLoadingColumns" :key="SearchColumnsLoading" class="card white loading-message" style="display: flex; flex-wrap: wrap; gap: var(--padding-md); align-items: center;">
                <img style="margin-bottom: 0;" src="assets/loading.gif" alt="..."/>
                <p style="color: var(--color-text-light);">Loading schedule data...</p>
            </div>
            <transition-group name="expand">
                
                <!-- Date Filters -->
                <div 
                    v-for="filter in dateFilters"
                    :key="filter.id"
                    :class="'card' + ((filter.value !== '' && filter.value != null) ? ' green' : ' gray')"
                    style="display: flex; flex-wrap: wrap; gap: var(--padding-md); align-items: center;"
                >
                    <h5 style="width: 80px; align-self: flex-start;">Date Filter:</h5>

                    <div class="form-group">
                        <label>Column</label>
                        <select v-model="filter.column">
                            <option v-for="col in dateColumns" :key="col" :value="col">{{ col }}</option>
                        </select>
                    </div>
                
                    <div class="form-group">
                        <label>Operation</label>
                        <select v-model="filter.type">
                            <option value="after">is After</option>
                            <option value="before">is Before</option>
                        </select>
                    </div>

                    <div class="form-group" style="flex-grow: 1;">
                        <label>{{ filter.mode === 'offset' ? 'Days offset from today' : 'Chosen date' }}</label>
                        <div class="button-bar">
                            <input 
                                v-if="filter.mode === 'offset'"
                                type="number"
                                v-model.number="filter.value"
                                placeholder="Days offset..."
                                style="flex-grow: 1;"
                            />
                            <input 
                                v-if="filter.mode === 'date'"
                                type="date"
                                v-model="filter.value"
                                style="flex-grow: 1;"
                            />
                            <button 
                                @click="toggleDateFilterMode(filter)"
                                class="white"
                                style="flex-grow: 1; text-align: center; white-space: nowrap;"
                            >
                                {{ getCalculatedDate(filter) || 'enter offset' }}
                            </button>
                        </div>
                    </div>

                    <div class="spacer"></div>
                    <button 
                        v-if="dateFilters.length > 1"
                        @click="removeDateFilter(filter.id)"
                        class="button-symbol white"
                        title="Remove this filter"
                    >
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>

                <!-- Text Filters (filters on the same column match rows meeting either) -->
                <div
                    v-for="filter in textOnlyFilters"
                    :key="filter.id"
                    :class="'card' + (isFilterComplete(filter) ? ' green' : ' gray')"
                    style="display: flex; flex-wrap: wrap; gap: var(--padding-md); align-items: center;"
                >
                    <h5 style="width: 80px; align-self: flex-start;">Text Filter:</h5>
                    
                    <div class="form-group">
                        <label>Column</label>
                        <select 
                            v-model="filter.column"
                        >
                            <option value="">Select...</option>
                            <option 
                                v-for="col in textFilterColumns" 
                                :key="col" 
                                :value="col"
                            >
                                {{ col }}
                            </option>
                        </select>
                    </div>

                    <div :class="['form-group', { 'hide-when-narrow': !filter.column }]">
                        <label>Operation</label>
                        <select 
                            v-model="filter.type"
                            :disabled="!filter.column"
                        >
                            <option value="contains">Contains</option>
                            <option value="excludes">Excludes</option>
                            <option value="empty">Is empty</option>
                        </select>
                    </div>
                    <!-- Multiple value inputs (none for "Is empty") -->

                    <div v-if="filter.type !== 'empty'" :class="['form-group', { 'hide-when-narrow': !filter.column }]">
                        <label>Value{{ filter.values.length > 1 ? (filter.type === 'contains' ? ' or additional values' : ' and additional values') : '' }}</label>
                        <div class="button-bar">
                            <div 
                                v-for="(value, valueIndex) in filter.values" 
                                :key="valueIndex"
                                class="input-container"
                                style="min-width: 120px;"
                            >
                                <input 
                                    type="text" 
                                    :value="value"
                                    @input="handleValueInput(filter, valueIndex, $event)"
                                    :placeholder="(valueIndex === 0 ? 'Text...' : filter.type === 'contains' ? 'Or...' : 'And...')"
                                    :disabled="!filter.column"
                                />
                                <button 
                                    v-if="filter.values.length > 1"
                                    @click="removeValue(filter, valueIndex)"
                                    class="column-button"
                                    title="Remove this value"
                                >
                                    ✕
                                </button>
                                <button 
                                    v-if="valueIndex === filter.values.length - 1 && value.trim()"
                                    @click="addValue(filter)"
                                    class="column-button"
                                    title="Add another value"
                                >
                                    +
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="spacer"></div>
                    <button
                        @click="removeTextFilter(filter.id)"
                        class="button-symbol white"
                        title="Remove this filter"
                    >
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>

                <!-- Checkbox Filters -->
                <div
                    v-for="filter in checkboxFilters"
                    :key="filter.id"
                    :class="'card' + (isFilterComplete(filter) ? ' green' : ' gray')"
                    style="display: flex; flex-wrap: wrap; gap: var(--padding-md); align-items: center;"
                >
                    <h5 style="width: 80px; align-self: flex-start;">Checkbox Filter:</h5>

                    <div class="form-group">
                        <label>Column</label>
                        <select v-model="filter.column">
                            <option value="">Select...</option>
                            <option v-for="col in checkboxColumns" :key="col" :value="col">{{ col }}</option>
                        </select>
                    </div>

                    <div :class="['form-group', { 'hide-when-narrow': !filter.column }]">
                        <label>Is</label>
                        <select v-model="filter.type" :disabled="!filter.column">
                            <option value="checked">Checked</option>
                            <option value="unchecked">Unchecked</option>
                        </select>
                    </div>

                    <div class="spacer"></div>
                    <button
                        @click="removeTextFilter(filter.id)"
                        class="button-symbol white"
                        title="Remove this filter"
                    >
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
            </transition-group>

            <!-- Add Filter Button Bar (always visible) -->
            <div class="button-bar">
                <button @click="saveFiltersToURL" class="green" :disabled="!isFormValid || isLoadingColumns">
                    Apply Filters
                </button>
                <button @click="clearAllFilters" class="white" :disabled="isLoadingColumns">
                    Clear Filters
                </button>
                <button @click="addDateFilter" class="white" :disabled="isLoadingColumns">
                    + Date Filter
                </button>
                <button @click="addTextFilter" class="white" :disabled="isLoadingColumns">
                    + Text Filter
                </button>
                <button @click="addCheckboxFilter" class="white" :disabled="isLoadingColumns || !checkboxColumns.length">
                    + Checkbox Filter
                </button>
                <!-- <button @click="" class="button-symbol white" :disabled="isLoadingColumns">
                    +
                </button> -->
            </div>

            <div class="spacer"></div>

            <!-- Saved Filter Options -->

            <h3>Saved Filter Options:</h3>
            <div class="button-bar">
                <!-- Saved Search Dropdown -->
                <select 
                    v-model="selectedSavedSearchIndex"
                    @change="handleScheduleFilterSelection"
                    style="flex: auto;"
                >
                    <option :value="null">{{ selectedSavedSearchIndex === null ? 'Unsaved Filter' : 'New Filter' }}</option>
                    <option 
                        v-for="(search, index) in savedSearches" 
                        :key="index" 
                        :value="index"
                    >
                        {{ search.name }}
                    </option>
                </select>
                
                <!-- Conditional buttons based on whether a saved search is selected -->
                <button 
                    v-if="selectedSavedSearchIndex === null"
                    @click="saveSearch"
                    :disabled="!isFormValid"
                >
                    Save This Filter
                </button>
                <button 
                    v-else
                    @click="updateSavedSearch"
                    :disabled="!isFormValid"
                >
                    Update Saved Filter
                </button>
                <button 
                    :disabled="selectedSavedSearchIndex == null"
                    @click="deleteSavedSearch"
                >
                    Delete Saved Filter
                </button>
            </div>

            <!-- Simple Presets -->
            <h3>Presets:</h3>
            <div class="button-bar">
                <button @click="applyUpcomingPreset" :disabled="isLoadingColumns">Upcoming</button>
                <button @click="applyThisYearPreset" :disabled="isLoadingColumns">This Year</button>
                <button @click="openShowOverlapModal" :disabled="isLoadingColumns">Show Overlap</button>
            </div>

    `
};

// Resolves ISO strings and numeric day-offsets from dateFilters to displayable dates synchronously.
// Finds the first after/before filter regardless of column.
function computeDisplayDates(dateFilters) {
    if (!dateFilters?.length) return { startDate: null, endDate: null };
    const afterFilter  = dateFilters.find(f => f.type === 'after');
    const beforeFilter = dateFilters.find(f => f.type === 'before');
    return {
        startDate: offsetToISO(afterFilter?.value) ?? null,
        endDate:   offsetToISO(beforeFilter?.value) ?? null
    };
}

// Async-resolves overlap-mode saved searches (Return/Ship column with identifier value).
async function resolveOverlapDisplayDates(dateFilters) {
    const returnFilter = dateFilters?.find(f => f.column === 'Return' && f.type === 'after');
    if (!returnFilter) return { startDate: null, endDate: null };
    const val = returnFilter.value;
    if (!val || typeof val !== 'string' || /^\d{4}-\d{2}-\d{2}$/.test(val) || !isNaN(Number(val))) {
        return { startDate: null, endDate: null };
    }
    try {
        const [startDate, endDate] = await Promise.all([
            Requests.getProjectShipDate(val),
            Requests.getProjectReturnDate(val)
        ]);
        return { startDate: startDate || null, endDate: endDate || null };
    } catch (_) {
        return { startDate: null, endDate: null };
    }
}

/**
 * Displays the active date range derived directly from URL path params for a given containerPath.
 * Only renders when a date range can be resolved.
 */
export const ScheduleDateRangeCard = {
    inject: ['appContext', '$modal'],
    props: {
        containerPath: {
            type: String,
            required: true
        }
    },
    data() {
        return {
            displayStart: null,
            displayEnd: null
        };
    },
    computed: {
        dateRangeDisplay() {
            if (!this.displayStart && !this.displayEnd) return null;
            const fmt = (iso) => toUSDateString(parseDate(iso)) ?? '?';
            return `${fmt(this.displayStart)} → ${fmt(this.displayEnd)}`;
        }
    },
    watch: {
        'appContext.currentPath': {
            handler(newPath, oldPath) {
                const newParams = NavigationRegistry.getParametersForContainer(this.containerPath, newPath);
                const oldParams = NavigationRegistry.getParametersForContainer(this.containerPath, oldPath || '');
                if (JSON.stringify(newParams) === JSON.stringify(oldParams)) return;
                this.resolveFromParams();
            }
        }
    },
    mounted() {
        this.resolveFromParams();
    },
    methods: {
        resolveFromParams() {
            const params = NavigationRegistry.getParametersForContainer(
                this.containerPath,
                this.appContext?.currentPath
            );
            const dateFilters = params.dateFilters || [];
            const { startDate, endDate } = computeDisplayDates(dateFilters);
            this.displayStart = startDate ?? params.startDate ?? null;
            this.displayEnd   = endDate   ?? params.endDate   ?? null;
            // Async-resolve overlap identifier dates if sync returned nothing
            if (!this.displayStart && !this.displayEnd && dateFilters.length) {
                resolveOverlapDisplayDates(dateFilters).then(({ startDate: s, endDate: e }) => {
                    if (s || e) { this.displayStart = s; this.displayEnd = e; }
                });
            }
        },
        // showDateRangeModal() {
        //     this.$modal.alert(this.dateRangeDisplay, 'Date Range');
        // }
    },
    template: html`
        <template v-if="dateRangeDisplay">
            <div class="card gray hide-when-narrow" style="white-space: nowrap; padding: var(--padding-sm) var(--padding-md);">
                <span>{{ dateRangeDisplay }}</span>
                <!-- <span class="show-when-narrow">↔</span> -->
            </div>
        </template>
    `
};

/**
 * Reusable component for saved search selection with optional year options
 * Handles saved searches, URL parameters, and emits search data to parent
 */
export const ScheduleFilterSelect = {
    components: { ScheduleDateRangeCard },
    inject: ['appContext', '$modal'],
    props: {
        containerPath: {
            type: String,
            default: null
        },
        includeYears: {
            type: Boolean,
            default: false
        },
        startYear: {
            type: Number,
            default: 2023
        },
        navigateToPath: {
            type: Function,
            default: null
        },
        defaultSearch: {
            type: String,
            default: 'Upcoming'
        },
        allowShowAll: {
            type: Boolean,
            default: false
        },
        showAdvancedButton: {
            type: Boolean,
            default: false
        }
    },
    data() {
        return {
            savedSearchesStore: null,
            selectedValue: '',
            lastNonCustomValue: '',
            isLoadingOptions: false,
            availableOptions: [],
            hasPerformedInitialSync: false
        };
    },
    computed: {
        savedSearches() {
            return this.savedSearchesStore?.data || [];
        },
        
        isLoading() {
            return this.savedSearchesStore?.isLoading || this.isLoadingOptions;
        },
        authIsAuthenticated() {
            return authState.isAuthenticated;
        }
    },
    watch: {
        // Reinitialize saved searches store when auth is restored after logout or reauth
        async authIsAuthenticated(isAuth, wasAuth) {
            if (isAuth && !wasAuth) {
                this.savedSearchesStore = initializeSavedSearchesStore();
                await this.buildOptions();
                if (this.containerPath) {
                    this.syncWithURL();
                }
            }
        },
        savedSearches: {
            async handler() {
                // Rebuild options when saved searches change
                await this.buildOptions();
            },
            deep: true
        },
        // Watch for URL parameter changes
        'appContext.currentPath': {
            handler(newPath, oldPath) {
                // Skip if no containerPath (standalone mode in modal)
                if (!this.containerPath) return;
                // Skip initial load (handled by mounted)
                if (!oldPath) return;
                
                // Get params for both paths
                const newParams = NavigationRegistry.getParametersForContainer(
                    this.containerPath,
                    newPath
                );
                const oldParams = NavigationRegistry.getParametersForContainer(
                    this.containerPath,
                    oldPath
                );
                
                // Skip if params haven't actually changed
                if (JSON.stringify(newParams) === JSON.stringify(oldParams)) return;

                // Skip if only non-filter params changed (e.g. a view switch).
                // `view` is the views system's view id; show-all lives in `dateFilter`.
                const filterKeys = ['dateFilters', 'textFilters', 'dateFilter'];
                const newFilter = JSON.stringify(filterKeys.map(k => newParams[k]));
                const oldFilter = JSON.stringify(filterKeys.map(k => oldParams[k]));
                if (newFilter === oldFilter) return;
                
                console.log('[ScheduleFilterSelect] URL parameters changed, syncing dropdown');
                this.syncWithURL();
            },
            deep: true
        }
    },
    async mounted() {
        this.savedSearchesStore = initializeSavedSearchesStore();
        
        // If store exists, wait for it to finish loading before building options
        if (this.savedSearchesStore && this.savedSearchesStore.isLoading) {
            await new Promise(resolve => {
                const unwatch = this.$watch('savedSearchesStore.isLoading', (newValue) => {
                    if (!newValue) {
                        unwatch();
                        resolve();
                    }
                });
            });
        }
        
        // Now build options with fully loaded saved searches
        await this.buildOptions();
        
        // Perform initial sync after reactive data is fully initialized (only if containerPath exists)
        this.hasPerformedInitialSync = true;
        if (this.containerPath) {
            // On initial mount, use replaceHistory to avoid creating history entries for default filters
            this.syncWithURL(true);
        } else if (this.defaultSearch) {
            // In standalone mode, apply default search if provided (replaceHistory=true for initial)
            this.applyDefaultSearch(true);
        }
    },
    methods: {
        async buildOptions() {
            this.isLoadingOptions = true;
            try {
                const options = [];
                
                // Add "Show All" option if allowed
                if (this.allowShowAll) {
                    options.push({
                        value: 'show-all',
                        label: 'Show All',
                        type: 'show-all'
                    });
                }
                
                // Add years if requested
                if (this.includeYears) {
                    const currentYear = new Date().getFullYear();
                    const yearCount = currentYear + 1 - this.startYear + 1;
                    const years = Array.from({ length: yearCount }, (_, i) => currentYear + 1 - i);
                    years.forEach(year => {
                        options.push({ 
                            value: year.toString(), 
                            label: year.toString(), 
                            type: 'year' 
                        });
                    });
                }
                
                // Add saved searches
                if (this.savedSearches && this.savedSearches.length > 0) {
                    this.savedSearches.forEach((search, index) => {
                        options.push({
                            value: `search-${index}`,
                            label: search.name,
                            type: 'search',
                            searchData: search
                        });
                    });
                }
                
                this.availableOptions = options;
            } catch (error) {
                console.error('[ScheduleFilterSelect] Failed to build options:', error);
            } finally {
                this.isLoadingOptions = false;
            }
        },
        
        handleChange(event) {
            const value = event.target.value;
            if (value === 'custom') {
                const revertTo = this.lastNonCustomValue || '';
                this.selectedValue = revertTo;
                // Force DOM to revert even when selectedValue didn't change reactively
                this.$nextTick(() => { event.target.value = revertTo; });
                if (this.showAdvancedButton) {
                    this.openAdvancedSearchModal();
                }
                return;
            }

            this.selectedValue = value;
            this.lastNonCustomValue = value;
            
            if (!value) {
                this.$emit('search-selected', null);
                // Clear all schedule filter parameters by setting them to undefined
                this.updateURL({
                    dateFilters: undefined,
                    textFilters: undefined,
                    dateFilter: undefined
                });
                return;
            }
            
            const option = this.availableOptions.find(opt => opt.value === value);
            if (!option || option.disabled) return;
            
            this.applyOption(option);
        },
        
        applyOption(option, replaceHistory = false) {
            this.lastNonCustomValue = option.value;

            if (option.type === 'show-all') {
                this.$emit('search-selected', { type: 'show-all', startDate: null, endDate: null });
                this.updateURL({
                    dateFilter: 'all',
                    dateFilters: undefined, // Clear date filters for show-all
                    textFilters: undefined  // Clear text filters for show-all
                }, replaceHistory);
            } else if (option.type === 'year') {
                const year = parseInt(option.value);
                const searchData = {
                    type: 'year',
                    year: year,
                    startDate: `${year}-01-01`,
                    endDate: `${year}-12-31`,
                    dateFilters: [
                        { column: 'Date', value: `${year}-01-01`, type: 'after' },
                        { column: 'Date', value: `${year}-12-31`, type: 'before' }
                    ]
                };
                this.$emit('search-selected', searchData);
                this.updateURL({
                    dateFilter: undefined, // Clear show-all parameter
                    dateFilters: searchData.dateFilters,
                    textFilters: undefined // Explicitly clear text filters for year selection
                }, replaceHistory);
            } else if (option.type === 'search') {
                const cleanDateFilters = cleanFilters(option.searchData.dateFilters) || [];
                const { startDate, endDate } = computeDisplayDates(cleanDateFilters);
                const searchData = {
                    type: 'search',
                    name: option.searchData.name,
                    dateFilters: cleanDateFilters,
                    textFilters: cleanFilters(option.searchData.textFilters) || [],
                    startDate,
                    endDate
                };
                this.$emit('search-selected', searchData);
                this.updateURLFromSearch(option.searchData, replaceHistory);
            }
        },
        
        updateURL(params, replaceHistory = false) {
            // Skip URL updates if no containerPath (standalone mode in modal)
            if (!this.containerPath) return;
            
            const cleanPath = this.containerPath.split('?')[0];
            const isOnDashboard = this.appContext?.currentPath?.split('?')[0].split('/')[0] === 'dashboard';
            
            // Merge with current parameters to preserve other URL params
            const newPath = NavigationRegistry.buildPathWithCurrentParams(
                cleanPath,
                this.appContext?.currentPath,
                params
            );
            
            if (isOnDashboard) {
                // Update dashboard registry with new path including params
                NavigationRegistry.dashboardRegistry.updatePath(
                    cleanPath,
                    newPath
                );
            } else if (this.navigateToPath) {
                // Pass replaceHistory flag through to navigation system
                // to control history behavior (true = replace current entry, false = push new entry)
                this.navigateToPath({ targetPath: newPath, replaceHistory });
            }
        },
        
        updateURLFromSearch(searchData, replaceHistory = false) {
            if (!searchData) return;
            
            const params = {
                dateFilter: undefined // Clear show-all parameter
            };
            // Clean filters to remove AppData before passing to URL
            if (searchData.dateFilters?.length) params.dateFilters = cleanFilters(searchData.dateFilters);
            // Always set textFilters - either with values or undefined to clear from URL
            if (searchData.textFilters?.length) {
                params.textFilters = cleanFilters(searchData.textFilters);
            } else {
                params.textFilters = undefined; // Explicitly clear text filters if search has none
            }
            
            this.updateURL(params, replaceHistory);
        },
        
        applyDefaultSearch(replaceHistory = false) {
            if (!this.defaultSearch) return;
            
            // Convert defaultSearch to string for comparison since year values are stored as strings
            const defaultStr = String(this.defaultSearch);
            const option = this.availableOptions.find(
                opt => opt.value === defaultStr || opt.label === defaultStr
            );
            
            if (!option) {
                console.warn('[ScheduleFilterSelect] Default search not found:', this.defaultSearch, 'in', this.availableOptions.map(o => o.value));
                return;
            }
            
            this.selectedValue = option.value;
            this.applyOption(option, replaceHistory);
        },
        
        syncWithURL(replaceHistory = false) {
            // Skip URL sync if no containerPath (standalone mode in modal)
            if (!this.containerPath) {
                this.defaultSearch && this.applyDefaultSearch(replaceHistory);
                return;
            }
            
            const params = NavigationRegistry.getParametersForContainer(
                this.containerPath,
                this.appContext?.currentPath
            );
            
            if (Object.keys(params).length === 0) {
                this.defaultSearch && this.applyDefaultSearch(replaceHistory);
                return;
            }
            
            const filter = {
                dateFilters: params.dateFilters || [],
                textFilters: params.textFilters || [],
                dateFilter: params.dateFilter || null
            };

            // Only non-filter params present (e.g. just a view id) — don't change filter state
            if (!filter.dateFilters.length && !filter.textFilters.length && !filter.dateFilter) {
                this.defaultSearch && this.applyDefaultSearch(replaceHistory);
                return;
            }

            // Check for dateFilter=all (show-all)
            if (filter.dateFilter === 'all' && this.allowShowAll) {
                this.selectedValue = 'show-all';
                this.lastNonCustomValue = 'show-all';
                this.$emit('search-selected', { type: 'show-all' });
                return;
            }
            
            // Try to match year selection (2 date filters on Date column with year start/end)
            if (this.includeYears && filter.dateFilters.length === 2 && !filter.textFilters.length) {
                const afterFilter = filter.dateFilters.find(f => f.type === 'after' && f.column === 'Date');
                const beforeFilter = filter.dateFilters.find(f => f.type === 'before' && f.column === 'Date');
                
                if (afterFilter && beforeFilter) {
                    const afterMatch = String(afterFilter.value).match(/^(\d{4})-01-01$/);
                    const beforeMatch = String(beforeFilter.value).match(/^(\d{4})-12-31$/);
                    
                    if (afterMatch && beforeMatch && afterMatch[1] === beforeMatch[1]) {
                        const year = afterMatch[1];
                        const yearOption = this.availableOptions.find(opt => opt.value === year && opt.type === 'year');
                        
                        if (yearOption) {
                            this.selectedValue = year;
                            this.lastNonCustomValue = year;
                            this.$emit('search-selected', {
                                type: 'year',
                                year: parseInt(year),
                                startDate: `${year}-01-01`,
                                endDate: `${year}-12-31`,
                                dateFilters: filter.dateFilters
                            });
                            // Don't replace history on year-from-URL sync
                            return;
                        }
                    }
                }
            }
            
            // Try to match URL to a saved search
            const savedSearches = this.savedSearchesStore?.data || [];
            const matchedSearchIndex = matchUrlToSavedSearch(savedSearches, filter);
            
            if (matchedSearchIndex >= 0) {
                this.selectedValue = `search-${matchedSearchIndex}`;
                this.lastNonCustomValue = `search-${matchedSearchIndex}`;
                const matchedSearch = savedSearches[matchedSearchIndex];
                const cleanDateFilters = cleanFilters(matchedSearch.dateFilters) || [];
                const { startDate, endDate } = computeDisplayDates(cleanDateFilters);
                this.$emit('search-selected', {
                    type: 'search',
                    name: matchedSearch.name,
                    dateFilters: cleanDateFilters,
                    textFilters: cleanFilters(matchedSearch.textFilters) || [],
                    startDate,
                    endDate
                });
                return;
            }
            
            // URL params don't match any saved search - show as custom search
            const { startDate: customStart, endDate: customEnd } = computeDisplayDates(filter.dateFilters);
            this.selectedValue = 'custom';
            this.$emit('search-selected', {
                type: 'url',
                name: 'Custom',
                dateFilters: filter.dateFilters,
                textFilters: filter.textFilters,
                startDate: customStart ?? params.startDate ?? null,
                endDate:   customEnd   ?? params.endDate   ?? null
            });
        },
        
        openAdvancedSearchModal() {
            // Open the advanced search component in a modal
            const modal = this.$modal.custom(ScheduleAdvancedFilter, {
                containerPath: this.containerPath,
                size: 'page',
                tall: true,
                navigateToPath: this.navigateToPath,
                onSearchSelected: (searchData) => {
                    this.$emit('search-selected', searchData);
                },
                registerSubmitAction: (submitFn) => {
                    // Allow the component to register its submit action for Enter key handling
                    if (modal) {
                        modal.submitAction = submitFn;
                    }
                }
            }, 'Advanced Schedule Filtering', { size: 'large'});
        }
    },
    template: html`
        <button 
            v-if="showAdvancedButton" 
            class="button-symbol"
            title="Schedule filtering options"
            @click="openAdvancedSearchModal"
        >
            <span class="material-symbols-outlined">filter_list</span>
        </button>
        <select 
            :value="selectedValue"
            @change="handleChange"
            :disabled="isLoading"
            :title="isLoading ? 'Loading schedule filters...' : 'Select a schedule filter'"
        >
            <option value="" v-if="isLoading">Loading...</option>
            <option value="" v-else-if="availableOptions.length === 0">No options available</option>
            <option value="" v-else-if="!defaultSearch">Select...</option>
            <option 
                v-for="option in availableOptions" 
                :key="option.value" 
                :value="option.value"
                :disabled="option.disabled"
            >
                {{ option.label }}
            </option>
            <option value="custom" :disabled="!showAdvancedButton">Custom</option>
        </select>
        <ScheduleDateRangeCard v-if="containerPath" :container-path="containerPath" />
    `
};

/**
 * Reusable component for inventory category filtering
 * Handles category selection with URL parameter synchronization
 */
export const InventoryCategoryFilter = {
    inject: ['appContext'],
    props: {
        containerPath: {
            type: String,
            required: true
        },
        navigateToPath: {
            type: Function,
            default: null
        }
    },
    data() {
        return {
            categoriesStore: null,
            selectedCategory: '',
            hasPerformedInitialSync: false
        };
    },
    computed: {
        categories() {
            return this.categoriesStore?.data || [];
        },
        
        isLoading() {
            return this.categoriesStore?.isLoading || false;
        },
        
        // Filter out INDEX category
        visibleCategories() {
            return this.categories.filter(cat => cat.title !== 'INDEX');
        },
        authIsAuthenticated() {
            return authState.isAuthenticated;
        }
    },
    watch: {
        // Reinitialize categories store when auth is restored after logout or reauth
        authIsAuthenticated(isAuth, wasAuth) {
            if (isAuth && !wasAuth && !this.categories.length) {
                this.hasPerformedInitialSync = false;
                this.categoriesStore = getReactiveStore(
                    Requests.getAvailableTabs,
                    null,
                    ['INVENTORY'],
                    null
                );
            }
        },
        // Watch for URL parameter changes
        'appContext.currentPath': {
            handler(newPath, oldPath) {
                // Skip initial load (handled by mounted)
                if (!oldPath) return;
                
                // Get params for both paths
                const newParams = NavigationRegistry.getParametersForContainer(
                    this.containerPath,
                    newPath
                );
                const oldParams = NavigationRegistry.getParametersForContainer(
                    this.containerPath,
                    oldPath
                );
                
                // Skip if params haven't actually changed
                if (JSON.stringify(newParams) === JSON.stringify(oldParams)) return;
                
                //console.log('[InventoryCategoryFilter] URL parameters changed, syncing dropdown');
                this.syncWithURL();
            },
            deep: true
        },
        
        // Watch for categories data loading completion
        'categoriesStore.isLoading': {
            handler(isLoading, wasLoading) {
                // When loading completes, perform initial sync if needed
                if (wasLoading && !isLoading && this.categories.length > 0 && !this.hasPerformedInitialSync) {
                    this.hasPerformedInitialSync = true;
                    this.syncWithURL();
                }
            }
        }
    },
    async mounted() {
        //console.log('[InventoryCategoryFilter] Mounting component', {
        //     containerPath: this.containerPath,
        //     currentPath: this.appContext?.currentPath
        // });
        
        // Initialize categories store
        this.categoriesStore = getReactiveStore(
            Requests.getAvailableTabs,
            null, // No save function
            ['INVENTORY'], // Arguments
            null // No analysis config
        );
        
        //console.log('[InventoryCategoryFilter] Categories store initialized, isLoading:', this.categoriesStore.isLoading);
        
        // Wait for initial load to complete
        if (this.categoriesStore.isLoading) {
            //console.log('[InventoryCategoryFilter] Waiting for categories to load...');
            await new Promise(resolve => {
                const unwatch = this.$watch('categoriesStore.isLoading', (newValue) => {
                    if (!newValue) {
                        //console.log('[InventoryCategoryFilter] Categories loaded, count:', this.categories.length);
                        unwatch();
                        resolve();
                    }
                });
            });
        }
        
        // Perform initial sync after data is loaded
        //console.log('[InventoryCategoryFilter] Performing initial sync with URL');
        this.hasPerformedInitialSync = true;
        this.syncWithURL();
    },
    methods: {
        handleChange(event) {
            const value = event.target.value;
            //console.log('[InventoryCategoryFilter] User changed category selection:', value);
            this.selectedCategory = value;
            
            // Emit event with category name or null for "All Items"
            const categoryName = value || null;
            
            //console.log('[InventoryCategoryFilter] Emitting category-selected and updating URL with:', categoryName);
            this.$emit('category-selected', categoryName);
            this.updateURL(categoryName);
        },
        
        updateURL(categoryName) {
            //console.log('[InventoryCategoryFilter] updateURL called with:', categoryName);
            const cleanPath = this.containerPath.split('?')[0];
            const isOnDashboard = this.appContext?.currentPath?.split('?')[0].split('/')[0] === 'dashboard';
            
            //console.log('[InventoryCategoryFilter] Update context:', {
            //     cleanPath,
            //     isOnDashboard,
            //     currentPath: this.appContext?.currentPath
            // });
            
            // Build new path with ctgFilter parameter
            const newPath = NavigationRegistry.buildPathWithCurrentParams(
                cleanPath,
                this.appContext?.currentPath,
                {
                    ctgFilter: categoryName || undefined // undefined removes the parameter
                }
            );
            
            //console.log('[InventoryCategoryFilter] Built new path:', newPath);
            
            if (isOnDashboard) {
                // Update dashboard registry with new path
                //console.log('[InventoryCategoryFilter] Updating dashboard registry');
                NavigationRegistry.dashboardRegistry.updatePath(
                    cleanPath,
                    newPath
                );
            } else if (this.navigateToPath) {
                //console.log('[InventoryCategoryFilter] Calling navigateToPath with:', newPath);
                this.navigateToPath(newPath);
            } else {
                //console.log('[InventoryCategoryFilter] No navigation method available');
            }
        },
        
        syncWithURL() {
            //console.log('[InventoryCategoryFilter] syncWithURL called');
            const params = NavigationRegistry.getParametersForContainer(
                this.containerPath,
                this.appContext?.currentPath
            );
            
            //console.log('[InventoryCategoryFilter] URL parameters:', params);
            
            // Get ctgFilter from URL params
            const categoryFromUrl = params?.ctgFilter || '';
            
            //console.log('[InventoryCategoryFilter] Category from URL:', categoryFromUrl, 'hasPerformedInitialSync:', this.hasPerformedInitialSync);
            
            // Update selected category
            this.selectedCategory = categoryFromUrl;
            
            // Emit the category if component is being used
            if (this.hasPerformedInitialSync) {
                //console.log('[InventoryCategoryFilter] Emitting category-selected event:', categoryFromUrl || null);
                this.$emit('category-selected', categoryFromUrl || null);
            } else {
                //console.log('[InventoryCategoryFilter] Skipping event emit - not initialized yet');
            }
        }
    },
    template: html`
        <select 
            :value="selectedCategory"
            :title="isLoading ? 'Loading inventory filters...' : 'Select an inventory filter'"
            @change="handleChange"
            :disabled="isLoading"
        >
            <option value="">
                {{ isLoading ? 'Loading...' : 'All Items' }}
            </option>
            <option 
                v-for="category in visibleCategories" 
                :key="category.title"
                :value="category.title"
            >
                {{ category.title }}
            </option>
        </select>
    `
};
