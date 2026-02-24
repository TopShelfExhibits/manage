import { html, getReactiveStore, Requests, authState, NavigationRegistry, buildTextFilterParameters, parseTextFilterParameters, LoadingBarComponent, createAnalysisConfig, parseDateFilterParameters, buildDateFilterParameters } from '../../index.js';

// Date preset offset constants
const START_DATE_OFFSETS = { today: 0, monthAgo: -30, yearAgo: -365 };
const END_DATE_OFFSETS = { today: 0, inMonth: 30, inYear: 365 };
const OFFSET_TO_START_PRESET = { 0: 'today', '-30': 'monthAgo', '-365': 'yearAgo' };
const OFFSET_TO_END_PRESET = { 0: 'today', 30: 'inMonth', 365: 'inYear' };

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

// Shared utility: Validate and clean text filters
function getValidTextFilters(textFilters) {
    return textFilters
        .filter(f => f.column && f.values && f.values.some(v => v.trim()))
        .map(f => ({ 
            column: f.column, 
            values: f.values.filter(v => v.trim()),
            type: f.type || 'contains' 
        }));
}

// Shared utility: Clean filter objects by removing AppData and other metadata
function cleanFilters(filters) {
    if (!filters || !Array.isArray(filters)) return filters;
    
    return filters.map(filter => {
        const { AppData, ...cleanFilter } = filter;
        return cleanFilter;
    });
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
        onSearchSelected: Function // Callback for when used in modal
    },
    data() {
        return {
            // Date range filters
            startDate: '',
            endDate: '',
            startDatePreset: '', // Selected preset for start date (e.g., 'today', 'monthAgo')
            endDatePreset: '', // Selected preset for end date (e.g., 'today', 'inMonth')
            overlapShowIdentifier: '', // Identifier of the show to find overlaps with
            overlapShowYearFilter: new Date().getFullYear().toString(), // 'upcoming' or specific year (defaults to current year)
            dateFilterMode: 'dateRange', // 'dateRange' or 'overlap' - tracks which filter is active
            
            // Dynamic text search filters
            textFilters: [
                { id: 1, column: '', values: [''], type: 'contains' }
            ],
            nextFilterId: 2,
            
            // Reactive store for saved searches
            savedSearchesStore: null,
            
            // Reactive store for production schedule data (for dropdowns)
            scheduleStore: null,
            
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
        // Computed shows from store data
        allShows() {
            if (!this.scheduleData || this.scheduleData.length === 0) {
                return [];
            }
            
            // Extract shows with identifiers and display info from store
            const shows = this.scheduleData
                .filter(show => show.Identifier) // Only shows with computed identifiers
                .map(show => ({
                    identifier: show.Identifier,
                    display: `${show.Show} - ${show.Client} (${show.Year})`,
                    year: show.Year
                }))
                .sort((a, b) => {
                    // Sort by year desc, then by display name
                    if (a.year !== b.year) {
                        return parseInt(b.year) - parseInt(a.year);
                    }
                    return a.display.localeCompare(b.display);
                });
            
            return shows;
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
        // Loading states from store
        isLoadingShows() {
            return this.scheduleStore?.isLoading || this.scheduleStore?.isAnalyzing || false;
        },
        isLoadingColumns() {
            return this.isLoadingShows;
        },
        availableYears() {
            const currentYear = new Date().getFullYear();
            return Array.from({ length: currentYear - 2021 }, (_, i) => currentYear + 2 - i);
        },
        
        filteredShows() {
            if (!this.allShows?.length) return [];
            
            const isUpcoming = this.overlapShowYearFilter === 'upcoming';
            const currentYear = new Date().getFullYear();
            const targetYear = isUpcoming ? currentYear : parseInt(this.overlapShowYearFilter);
            
            return this.allShows.filter(show => {
                const year = parseInt(show.year);
                return isUpcoming ? year >= targetYear : year === targetYear;
            });
        }
    },
    async mounted() {
        // Initialize schedule store with analysis config
        await this.initializeScheduleStore();
        
        // Initialize saved searches store
        this.savedSearchesStore = initializeSavedSearchesStore();
        
        // Sync filters with URL parameters
        this.syncWithURL();
    },
    watch: {
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
            // Create analysis config to compute identifiers
            const analysisConfig = [
                createAnalysisConfig(
                    (show) => Requests.computeIdentifier(show.Show, show.Client, show.Year),
                    'Identifier',
                    'Computing show identifiers...',
                    null, // Pass full item
                    [],
                    'Identifier', // Store in Identifier column
                    true // passFullItem
                )
            ];
            
            // Initialize reactive store for production schedule
            this.scheduleStore = getReactiveStore(
                Requests.getProductionScheduleData,
                null, // No save function
                [], // No arguments - load all shows
                analysisConfig
            );
            
            // Load the data
            await this.scheduleStore.load('Loading production schedule...');
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
                view: params.view || null
            };
            
            // Try to match URL to a saved search
            const matchedSearchIndex = matchUrlToSavedSearch(this.savedSearchesStore?.data || [], filter);
            if (matchedSearchIndex >= 0) {
                this.selectedSavedSearchIndex = matchedSearchIndex;
            }
            
            // Load URL parameters into filter fields
            // Parse dateFilters array - for now, UI only supports one date filter
            if (filter.dateFilters && filter.dateFilters.length > 0) {
                // Take the first date filter (UI limitation)
                const firstDateFilter = filter.dateFilters[0];
                
                // Check if it's a show identifier (for overlap mode)
                if (typeof firstDateFilter.value === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(firstDateFilter.value) && isNaN(Number(firstDateFilter.value))) {
                    // This is a show identifier for overlap mode
                    const parts = firstDateFilter.value.split(' ');
                    const yearMatch = parts.find(part => /^\d{4}$/.test(part));
                    
                    if (yearMatch) {
                        this.overlapShowYearFilter = yearMatch;
                    }
                    
                    this.overlapShowIdentifier = firstDateFilter.value;
                    this.dateFilterMode = 'overlap';
                } else {
                    // This is a date range filter
                    // Look for both "after" and "before" filters on the same column
                    const sameColumnFilters = filter.dateFilters.filter(f => f.column === firstDateFilter.column);
                    const afterFilter = sameColumnFilters.find(f => f.type === 'after');
                    const beforeFilter = sameColumnFilters.find(f => f.type === 'before');
                    
                    // Handle "after" filter as start date
                    if (afterFilter) {
                        const value = afterFilter.value;
                        if (typeof value === 'number') {
                            // It's an offset
                            this.startDatePreset = OFFSET_TO_START_PRESET[value] || '';
                            if (this.startDatePreset) {
                                this.setStartDatePreset(this.startDatePreset);
                            }
                        } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
                            // It's an explicit date
                            this.startDate = value;
                        }
                    }
                    
                    // Handle "before" filter as end date
                    if (beforeFilter) {
                        const value = beforeFilter.value;
                        if (typeof value === 'number') {
                            // It's an offset
                            this.endDatePreset = OFFSET_TO_END_PRESET[value] || '';
                            if (this.endDatePreset) {
                                this.setEndDatePreset(this.endDatePreset);
                            }
                        } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
                            // It's an explicit date
                            this.endDate = value;
                        }
                    }
                    
                    this.dateFilterMode = 'dateRange';
                }
            }
            
            // Load text filters
            if (filter.textFilters && filter.textFilters.length > 0) {
                // Add IDs for Vue reactivity
                this.textFilters = filter.textFilters.map((filter, index) => ({
                    id: index + 1,
                    column: filter.column,
                    values: normalizeValues(filter),
                    type: filter.type || 'contains'
                }));
                this.nextFilterId = filter.textFilters.length + 1;
            }
        },
        saveFiltersToURL() {
            // Build dateFilters array from UI state
            const dateFilters = [];
            
            if (this.dateFilterMode === 'overlap' && this.overlapShowIdentifier) {
                // For overlap mode, create two filters to find shows active during identifier's period:
                // 1. Return date after identifier ships (show still out when identifier starts)
                // 2. Ship date before identifier returns (show goes out before identifier ends)
                dateFilters.push({
                    column: 'Return',
                    value: this.overlapShowIdentifier,
                    type: 'after'
                });
                dateFilters.push({
                    column: 'Ship',
                    value: this.overlapShowIdentifier,
                    type: 'before'
                });
            } else if (this.dateFilterMode === 'dateRange') {
                // For date range mode, build filters from start/end dates
                let startValue = null;
                let endValue = null;
                
                // Get start date value (offset or explicit date)
                const startOffset = START_DATE_OFFSETS[this.startDatePreset] ?? null;
                if (startOffset !== null) {
                    startValue = startOffset;
                } else if (this.startDate) {
                    startValue = this.startDate;
                }
                
                // Get end date value (offset or explicit date)
                const endOffset = END_DATE_OFFSETS[this.endDatePreset] ?? null;
                if (endOffset !== null) {
                    endValue = endOffset;
                } else if (this.endDate) {
                    endValue = this.endDate;
                }
                
                // Add "after" filter for start date
                if (startValue !== null && startValue !== '') {
                    dateFilters.push({
                        column: 'Show Date',
                        value: startValue,
                        type: 'after'
                    });
                }
                
                // Add "before" filter for end date
                if (endValue !== null && endValue !== '') {
                    dateFilters.push({
                        column: 'Show Date',
                        value: endValue,
                        type: 'before'
                    });
                }
            }
            
            // Build parameters object directly
            const params = {};
            
            if (dateFilters.length > 0) {
                params.dateFilters = dateFilters;
            }
            
            // Add text filters (strip id property)
            const validTextFilters = getValidTextFilters(this.textFilters);
            
            if (validTextFilters.length > 0) {
                params.textFilters = validTextFilters;
            }
            
            // Use containerPath prop instead of hardcoded path
            const targetPath = this.containerPath || 'schedule/advanced-search';
            
            if (this.navigateToPath) {
                const path = NavigationRegistry.buildPath(targetPath, params);
                
                const isOnDashboard = this.appContext?.currentPath?.split('?')[0].split('/')[0] === 'dashboard';
                if (isOnDashboard) {
                    // Update dashboard registry with new path including params
                    NavigationRegistry.dashboardRegistry.updatePath(
                        targetPath.split('?')[0],
                        path
                    );
                } else {
                    this.navigateToPath(path);
                }
            }
            
            // Emit search-selected event with filter data for table display
            this.emitSearchSelected();
        },
        clearAllFilters() {
            // Clear date filters
            this.startDate = '';
            this.endDate = '';
            this.startDatePreset = '';
            this.endDatePreset = '';
            this.overlapShowIdentifier = '';
            this.dateFilterMode = 'dateRange';
            
            // Clear text filters
            this.textFilters = [{ id: 1, column: '', values: [''], type: 'contains' }];
            this.nextFilterId = 2;
        },
        addTextFilter() {
            this.textFilters.push({
                id: this.nextFilterId++,
                column: '',
                values: [''],
                type: 'contains'
            });
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
        removeValue(filter, valueIndex) {
            if (filter.values.length > 1) {
                filter.values.splice(valueIndex, 1);
            } else {
                filter.values[0] = '';
            }
        },
        removeTextFilter(filterId) {
            // Keep at least one filter
            if (this.textFilters.length > 1) {
                this.textFilters = this.textFilters.filter(f => f.id !== filterId);
            }
        },
        setStartDatePreset(preset) {
            if (preset === 'clear') {
                this.startDate = '';
                this.startDatePreset = '';
            } else {
                this.startDatePreset = preset;
                const offset = this.getStartDateOffset();
                if (offset !== null) {
                    const date = new Date();
                    date.setDate(date.getDate() + offset);
                    this.startDate = date.toISOString().slice(0, 10);
                }
            }
            this.dateFilterMode = 'dateRange';
        },
        setEndDatePreset(preset) {
            if (preset === 'clear') {
                this.endDate = '';
                this.endDatePreset = '';
            } else {
                this.endDatePreset = preset;
                const offset = this.getEndDateOffset();
                if (offset !== null) {
                    const date = new Date();
                    date.setDate(date.getDate() + offset);
                    this.endDate = date.toISOString().slice(0, 10);
                }
            }
            this.dateFilterMode = 'dateRange';
        },
        getStartDateOffset() {
            return START_DATE_OFFSETS[this.startDatePreset] ?? null;
        },
        getEndDateOffset() {
            return END_DATE_OFFSETS[this.endDatePreset] ?? null;
        },
        getDatePickerCardClasses(cardDateFilterMode) {
            const isActive = cardDateFilterMode === this.dateFilterMode;
            const hasValues = (this.dateFilterMode === 'overlap' && this.overlapShowIdentifier) || 
                            (this.dateFilterMode === 'dateRange' && this.startDate && this.endDate);
            
            return {
                card: true,
                green: isActive && hasValues,
                white: !isActive || (isActive && !hasValues),
                clickable: !isActive
            };
        },
        handleScheduleFilterSelection() {
            // When a saved search is selected, load it
            if (this.selectedSavedSearchIndex === null) {
                // "New Search" selected - don't load anything
                return;
            }
            
            const search = this.selectedSavedSearch;
            if (!search) return;
            
            // Parse and load the saved search dateFilters
            if (search.dateFilters && search.dateFilters.length > 0) {
                const firstFilter = search.dateFilters[0];
                
                // Check if it's an overlap identifier
                if (typeof firstFilter.value === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(firstFilter.value) && isNaN(Number(firstFilter.value))) {
                    // Overlap mode
                    this.overlapShowIdentifier = firstFilter.value;
                    this.dateFilterMode = 'overlap';
                    
                    // Extract year from identifier
                    const parts = firstFilter.value.split(' ');
                    const yearMatch = parts.find(part => /^\d{4}$/.test(part));
                    if (yearMatch) {
                        this.overlapShowYearFilter = yearMatch;
                    }
                } else {
                    // Date range mode
                    const sameColumnFilters = search.dateFilters.filter(f => f.column === firstFilter.column);
                    const afterFilter = sameColumnFilters.find(f => f.type === 'after');
                    const beforeFilter = sameColumnFilters.find(f => f.type === 'before');
                    
                    // Handle "after" filter as start date
                    if (afterFilter) {
                        const value = afterFilter.value;
                        if (typeof value === 'number') {
                            // It's an offset
                            this.startDatePreset = OFFSET_TO_START_PRESET[value] || '';
                            if (this.startDatePreset) {
                                this.setStartDatePreset(this.startDatePreset);
                            }
                        } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
                            // It's an explicit date
                            this.startDate = value;
                            this.startDatePreset = '';
                        }
                    }
                    
                    // Handle "before" filter as end date
                    if (beforeFilter) {
                        const value = beforeFilter.value;
                        if (typeof value === 'number') {
                            // It's an offset
                            this.endDatePreset = OFFSET_TO_END_PRESET[value] || '';
                            if (this.endDatePreset) {
                                this.setEndDatePreset(this.endDatePreset);
                            }
                        } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
                            // It's an explicit date
                            this.endDate = value;
                            this.endDatePreset = '';
                        }
                    }
                    
                    this.dateFilterMode = 'dateRange';
                }
            }
            
            // Load text filters
            if (search.textFilters && search.textFilters.length > 0) {
                this.textFilters = search.textFilters.map((filter, index) => ({
                    id: index + 1,
                    column: filter.column,
                    values: normalizeValues(filter),
                    type: filter.type || 'contains'
                }));
                this.nextFilterId = search.textFilters.length + 1;
            } else {
                this.textFilters = [{ id: 1, column: '', values: [''], type: 'contains' }];
                this.nextFilterId = 2;
            }
            
            // Note: Don't call saveFiltersToURL here - let user click Apply Filters to update URL
        },
        async updateSavedSearch() {
            if (this.selectedSavedSearchIndex === null || !this.selectedSavedSearch) {
                return;
            }
            
            if (!authState.isAuthenticated || !authState.user?.email) {
                this.$modal.error('You must be logged in to update searches.', 'Error');
                return;
            }
            
            try {
                // Build dateFilters array from UI state (reuse logic from saveFiltersToURL)
                const dateFilters = [];
                
                if (this.dateFilterMode === 'overlap' && this.overlapShowIdentifier) {
                    // For overlap mode, create two filters
                    dateFilters.push({
                        column: 'Return',
                        value: this.overlapShowIdentifier,
                        type: 'after'
                    });
                    dateFilters.push({
                        column: 'Ship',
                        value: this.overlapShowIdentifier,
                        type: 'before'
                    });
                } else if (this.dateFilterMode === 'dateRange') {
                    let startValue = null;
                    let endValue = null;
                    
                    const startOffset = START_DATE_OFFSETS[this.startDatePreset] ?? null;
                    if (startOffset !== null) {
                        startValue = startOffset;
                    } else if (this.startDate) {
                        startValue = this.startDate;
                    }
                    
                    const endOffset = END_DATE_OFFSETS[this.endDatePreset] ?? null;
                    if (endOffset !== null) {
                        endValue = endOffset;
                    } else if (this.endDate) {
                        endValue = this.endDate;
                    }
                    
                    if (startValue !== null && startValue !== '') {
                        dateFilters.push({
                            column: 'Show Date',
                            value: startValue,
                            type: 'after'
                        });
                    }
                    
                    if (endValue !== null && endValue !== '') {
                        dateFilters.push({
                            column: 'Show Date',
                            value: endValue,
                            type: 'before'
                        });
                    }
                }
                
                const searchData = {
                    name: this.selectedSavedSearch.name,
                    dateFilters: dateFilters,
                    textFilters: []
                };
                
                // Add text filters
                if (this.textFilters && this.textFilters.length > 0) {
                    searchData.textFilters = getValidTextFilters(this.textFilters);
                }
                
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
                    startDate: String,
                    endDate: String,
                    startDateOffset: Number,
                    endDateOffset: Number,
                    overlapShowIdentifier: String,
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
                            
                            // Build dateFilters array
                            const dateFilters = [];
                            
                            if (this.overlapShowIdentifier) {
                                // Overlap mode - create two filters to find overlapping shows
                                dateFilters.push({
                                    column: 'Return',
                                    value: this.overlapShowIdentifier,
                                    type: 'after'
                                });
                                dateFilters.push({
                                    column: 'Ship',
                                    value: this.overlapShowIdentifier,
                                    type: 'before'
                                });
                            } else {
                                // Date range mode
                                let startValue = null;
                                let endValue = null;
                                
                                if (this.startDateOffset !== null) {
                                    startValue = this.startDateOffset;
                                } else if (this.startDate) {
                                    startValue = this.startDate;
                                }
                                
                                if (this.endDateOffset !== null) {
                                    endValue = this.endDateOffset;
                                } else if (this.endDate) {
                                    endValue = this.endDate;
                                }
                                
                                if (startValue !== null && startValue !== '') {
                                    dateFilters.push({
                                        column: 'Show Date',
                                        value: startValue,
                                        type: 'after'
                                    });
                                }
                                
                                if (endValue !== null && endValue !== '') {
                                    dateFilters.push({
                                        column: 'Show Date',
                                        value: endValue,
                                        type: 'before'
                                    });
                                }
                            }
                            
                            const searchData = {
                                name: this.searchName.trim(),
                                dateFilters: dateFilters,
                                textFilters: []
                            };
                            
                            // Add text filters (strip IDs)
                            if (this.textFilters && this.textFilters.length > 0) {
                                searchData.textFilters = getValidTextFilters(this.textFilters);
                            }
                            
                            // Save using reactive store (passed as prop)
                            if (this.savedSearchesStore && this.savedSearchesStore.data) {
                                this.savedSearchesStore.data.push(searchData);
                                await this.savedSearchesStore.save();
                                
                                // Select the newly saved search in the parent component
                                if (this.ScheduleAdvancedFilter) {
                                    this.ScheduleAdvancedFilter.selectedSavedSearchIndex = this.savedSearchesStore.data.length - 1;
                                }
                                
                                this.$modal.alert('Filter saved successfully!', 'Success');
                                this.$emit('close-modal');
                            } else {
                                throw new Error('Saved filterss store not initialized');
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
                // Pass current filter state as props
                startDate: this.startDate,
                endDate: this.endDate,
                startDateOffset: this.getStartDateOffset(),
                endDateOffset: this.getEndDateOffset(),
                overlapShowIdentifier: this.overlapShowIdentifier,
                textFilters: this.textFilters,
                savedSearchesStore: this.savedSearchesStore,
                ScheduleAdvancedFilter: this
            }, 'Save Filter');
        },
        emitSearchSelected() {
            // Build dateFilters array from UI state
            const dateFilters = [];
            
            if (this.dateFilterMode === 'overlap' && this.overlapShowIdentifier) {
                // For overlap mode, create two filters to find overlapping shows
                dateFilters.push({
                    column: 'Return',
                    value: this.overlapShowIdentifier,
                    type: 'after'
                });
                dateFilters.push({
                    column: 'Ship',
                    value: this.overlapShowIdentifier,
                    type: 'before'
                });
            } else if (this.dateFilterMode === 'dateRange') {
                let startValue = null;
                let endValue = null;
                
                const startOffset = START_DATE_OFFSETS[this.startDatePreset] ?? null;
                if (startOffset !== null) {
                    startValue = startOffset;
                } else if (this.startDate) {
                    startValue = this.startDate;
                }
                
                const endOffset = END_DATE_OFFSETS[this.endDatePreset] ?? null;
                if (endOffset !== null) {
                    endValue = endOffset;
                } else if (this.endDate) {
                    endValue = this.endDate;
                }
                
                if (startValue !== null && startValue !== '') {
                    dateFilters.push({
                        column: 'Show Date',
                        value: startValue,
                        type: 'after'
                    });
                }
                
                if (endValue !== null && endValue !== '') {
                    dateFilters.push({
                        column: 'Show Date',
                        value: endValue,
                        type: 'before'
                    });
                }
            }
            
            // Build search data in the same format as ScheduleFilterSelect
            const searchData = {
                dateFilters: dateFilters,
                textFilters: getValidTextFilters(this.textFilters)
            };
            
            // Call callback if in modal mode, otherwise emit to parent
            if (this.onSearchSelected) {
                this.onSearchSelected(searchData);
                // Close the modal after applying filters
                this.$emit('close-modal');
            } else {
                this.$emit('search-selected', searchData);
            }
        }
    },
    template: html`
        <!-- Date Range Filters -->
        <div class="cards-grid two">
            <!-- Date Range Card -->
            <div 
                :class="getDatePickerCardClasses('dateRange')"
                @click="dateFilterMode = 'dateRange'"
            >
                <div class="content-header">
                    <h5>Filter By Date Range</h5>
                    <small v-if="dateFilterMode === 'dateRange'" style="display: block; color: var(--color-green);">
                        Active filter
                    </small>
                </div>
                <div :class="dateFilterMode === 'dateRange' ? 'content' : 'content hide-when-narrow'">
                    <label style="display: flex; flex-direction: column; gap: 0.25rem;">
                        <span>Start Date:</span>
                        <div class="button-bar">
                            <select 
                                v-model="startDatePreset"
                                @change="setStartDatePreset(startDatePreset)"
                                @focus="dateFilterMode = 'dateRange'"
                            >
                                <option value="">Manual Entry</option>
                                <option value="today">Today</option>
                                <option value="monthAgo">A Month Ago</option>
                                <option value="yearAgo">A Year Ago</option>
                            </select>
                            <input 
                                type="date" 
                                v-model="startDate" 
                                placeholder="YYYY-MM-DD"
                                @focus="dateFilterMode = 'dateRange'; startDatePreset = ''"
                                :disabled="!!startDatePreset"
                                style="flex: 1;"
                            />
                        </div>
                    </label>
                    
                    <label style="display: flex; flex-direction: column; gap: 0.25rem;">
                        <span>End Date:</span>
                        <div class="button-bar">
                            <select 
                                v-model="endDatePreset"
                                @change="setEndDatePreset(endDatePreset)"
                                @focus="dateFilterMode = 'dateRange'"
                            >
                                <option value="">Manual Entry</option>
                                <option value="today">Today</option>
                                <option value="inMonth">In a Month</option>
                                <option value="inYear">In a Year</option>
                            </select>
                            <input 
                                type="date" 
                                v-model="endDate"
                                placeholder="YYYY-MM-DD"
                                @focus="dateFilterMode = 'dateRange'; endDatePreset = ''"
                                :disabled="!!endDatePreset"
                                style="flex: 1;"
                            />
                        </div>
                    </label>
                </div>
            </div>
            
            <!-- Overlap Show Card -->
            <div 
                :class="getDatePickerCardClasses('overlap')"
                @click="dateFilterMode = 'overlap'"
            >
                <div class="content-header">
                    <h5>Filter By Show Overlap</h5>
                    <small v-if="isLoadingShows" style="display: block; color: var(--color-text-light);">
                        Loading shows...
                    </small>
                    <small v-else-if="dateFilterMode === 'overlap'" style="display: block; color: var(--color-green);">
                        Active filter
                    </small>
                </div>
                <LoadingBarComponent
                    key="date-range"
                    :is-loading="isLoadingShows"
                />
                <div :class="dateFilterMode === 'overlap' ? 'content' : 'content hide-when-narrow'">
                    <label style="display: flex; flex-direction: column; gap: 0.25rem;">
                        <span>Filter Shows by Year:</span>
                        <select 
                            v-model="overlapShowYearFilter" 
                            style="width: 100%;"
                            @focus="dateFilterMode = 'overlap'"
                            @change="overlapShowIdentifier = ''"
                        >
                            <option value="upcoming">Upcoming Shows</option>
                            <option 
                                v-for="year in availableYears" 
                                :key="year" 
                                :value="year"
                            >
                                {{ year }}
                            </option>
                        </select>
                    </label>
                    
                    <label style="display: flex; flex-direction: column; gap: 0.25rem;">
                        <span>Overlaps with Show: ({{ filteredShows.length }} available)</span>
                        <select 
                            v-model="overlapShowIdentifier" 
                            style="width: 100%;"
                            :disabled="isLoadingShows || filteredShows.length === 0"
                            @focus="dateFilterMode = 'overlap'"
                        >
                            <option value="">
                                {{ isLoadingShows ? 'Loading...' : (filteredShows.length === 0 ? 'No shows available' : 'Select a show...') }}
                            </option>
                            <option 
                                v-for="show in filteredShows" 
                                :key="show.identifier" 
                                :value="show.identifier"
                            >
                                {{ show.display }}
                            </option>
                        </select>
                    </label>
                </div>
            </div>
        </div>

        <!-- Text Search Filters -->
        <div v-if="isLoadingColumns" class="card white">
            Loading columns...
        </div>
        
        <slot v-else>
            <div 
                v-for="filter in textFilters" 
                :key="filter.id"
                :class="'card' + (filter.values.some(v => v.trim()) ? ' green' : ' white')"
                style="display: flex; flex-direction: column; gap: var(--padding-md);"
            >
                <div style="display: flex; flex-wrap: wrap; gap: var(--padding-md); align-items: center;">
                    <span>Column Filter:</span>
                    <select 
                        v-model="filter.column"
                    >
                        <option value="">Select column...</option>
                        <option 
                            v-for="col in availableColumns" 
                            :key="col" 
                            :value="col"
                        >
                            {{ col }}
                        </option>
                    </select>
                
                    <select 
                        v-model="filter.type"
                        :disabled="!filter.column"
                        :class="{ 'hide-when-narrow': !filter.column }"
                        style="min-width: 120px; width: unset;"
                    >
                        <option value="contains">Contains</option>
                        <option value="excludes">Excludes</option>
                    </select>
                    <!-- Multiple value inputs -->
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
                            :placeholder="filter.column ? (valueIndex === 0 ? 'Search text...' : 'Additional value...') : 'Select column first'"
                            :disabled="!filter.column"
                        />
                        <button 
                            v-if="filter.values.length > 1 && value.trim()"
                            @click="removeValue(filter, valueIndex)"
                            class="column-button"
                            title="Remove this value"
                        >
                            ✕
                        </button>
                    </div>
                    <div class="spacer"></div>
                    <button 
                        @click="removeTextFilter(filter.id)"
                        class="button-symbol red"
                        :disabled="textFilters.length === 1"
                        :title="textFilters.length === 1 ? 'At least one filter required' : 'Remove this filter'"
                    >
                        🗙
                    </button>
                </div>
                
                
            </div>
            <transition name="expand">
                <button 
                    v-if="textFilters.length > 0 && textFilters.every(filter => filter.column && filter.values.some(v => v.trim()))"
                    @click="addTextFilter" 
                    class="card white"
                    style="width: 100%;"
                    :disabled="isLoadingColumns"
                >
                    Add Another Text Filter
                </button>
            </transition>
        </slot>

        <!-- Action Buttons -->
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
            >
                Save This Filter
            </button>
            <button 
                v-else
                @click="updateSavedSearch" 
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
        <div class="button-bar">
            <button @click="saveFiltersToURL" class="green">Apply Filters</button>
            <button @click="clearAllFilters" class="white">Clear Filters</button>
        </div>
    `
};

/**
 * Reusable component for saved search selection with optional year options
 * Handles saved searches, URL parameters, and emits search data to parent
 */
export const ScheduleFilterSelect = {
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
            default: null
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
        }
    },
    watch: {
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
            this.syncWithURL();
        } else if (this.defaultSearch) {
            // In standalone mode, apply default search if provided
            this.applyDefaultSearch();
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
            this.selectedValue = value;
            
            if (!value) {
                this.$emit('search-selected', null);
                // Clear all schedule filter parameters by setting them to undefined
                this.updateURL({ 
                    dateFilters: undefined, 
                    textFilters: undefined, 
                    view: undefined 
                });
                return;
            }
            
            const option = this.availableOptions.find(opt => opt.value === value);
            if (!option || option.disabled) return;
            
            this.applyOption(option);
        },
        
        applyOption(option) {
            if (option.type === 'show-all') {
                this.$emit('search-selected', { type: 'show-all' });
                this.updateURL({ view: 'all' });
            } else if (option.type === 'year') {
                const year = parseInt(option.value);
                const searchData = {
                    type: 'year',
                    year: year,
                    startDate: `${year}-01-01`,
                    endDate: `${year}-12-31`,
                    dateFilters: [
                        { column: 'Show Date', value: `${year}-01-01`, type: 'after' },
                        { column: 'Show Date', value: `${year}-12-31`, type: 'before' }
                    ]
                };
                this.$emit('search-selected', searchData);
                this.updateURL({
                    view: undefined, // Clear show-all view parameter
                    dateFilters: searchData.dateFilters
                });
            } else if (option.type === 'search') {
                const searchData = {
                    type: 'search',
                    name: option.searchData.name,
                    dateFilters: cleanFilters(option.searchData.dateFilters) || [],
                    textFilters: cleanFilters(option.searchData.textFilters) || []
                };
                this.$emit('search-selected', searchData);
                this.updateURLFromSearch(option.searchData);
            }
        },
        
        updateURL(params) {
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
                this.navigateToPath(newPath);
            }
        },
        
        updateURLFromSearch(searchData) {
            if (!searchData) return;
            
            const params = {
                view: undefined // Clear show-all view parameter
            };
            // Clean filters to remove AppData before passing to URL
            if (searchData.dateFilters?.length) params.dateFilters = cleanFilters(searchData.dateFilters);
            if (searchData.textFilters?.length) params.textFilters = cleanFilters(searchData.textFilters);
            
            this.updateURL(params);
        },
        
        applyDefaultSearch() {
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
            this.applyOption(option);
        },
        
        syncWithURL() {
            // Skip URL sync if no containerPath (standalone mode in modal)
            if (!this.containerPath) {
                this.defaultSearch && this.applyDefaultSearch();
                return;
            }
            
            const params = NavigationRegistry.getParametersForContainer(
                this.containerPath,
                this.appContext?.currentPath
            );
            
            if (Object.keys(params).length === 0) {
                this.defaultSearch && this.applyDefaultSearch();
                return;
            }
            
            const filter = {
                dateFilters: params.dateFilters || [],
                textFilters: params.textFilters || [],
                view: params.view || null
            };
            
            // Check for view=all (show-all)
            if (filter.view === 'all' && this.allowShowAll) {
                this.selectedValue = 'show-all';
                this.$emit('search-selected', { type: 'show-all' });
                return;
            }
            
            // Try to match year selection (2 date filters on Show Date column with year start/end)
            if (this.includeYears && filter.dateFilters.length === 2 && !filter.textFilters.length) {
                const afterFilter = filter.dateFilters.find(f => f.type === 'after' && f.column === 'Show Date');
                const beforeFilter = filter.dateFilters.find(f => f.type === 'before' && f.column === 'Show Date');
                
                if (afterFilter && beforeFilter) {
                    const afterMatch = String(afterFilter.value).match(/^(\d{4})-01-01$/);
                    const beforeMatch = String(beforeFilter.value).match(/^(\d{4})-12-31$/);
                    
                    if (afterMatch && beforeMatch && afterMatch[1] === beforeMatch[1]) {
                        const year = afterMatch[1];
                        const yearOption = this.availableOptions.find(opt => opt.value === year && opt.type === 'year');
                        
                        if (yearOption) {
                            this.selectedValue = year;
                            this.$emit('search-selected', {
                                type: 'year',
                                year: parseInt(year),
                                startDate: `${year}-01-01`,
                                endDate: `${year}-12-31`,
                                dateFilters: filter.dateFilters
                            });
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
                const matchedSearch = savedSearches[matchedSearchIndex];
                this.$emit('search-selected', {
                    type: 'search',
                    name: matchedSearch.name,
                    dateFilters: cleanFilters(matchedSearch.dateFilters) || [],
                    textFilters: cleanFilters(matchedSearch.textFilters) || []
                });
                return;
            }
            
            // URL params don't match any saved search - show as custom search
            this.selectedValue = 'custom';
            this.$emit('search-selected', {
                type: 'url',
                name: 'Custom',
                dateFilters: filter.dateFilters,
                textFilters: filter.textFilters
            });
        },
        
        openAdvancedSearchModal() {
            // Open the advanced search component in a modal
            this.$modal.custom(ScheduleAdvancedFilter, {
                containerPath: this.containerPath,
                navigateToPath: this.navigateToPath,
                onSearchSelected: (searchData) => {
                    this.$emit('search-selected', searchData);
                }
            }, 'Advanced Schedule Filtering', { size: 'large' });
        }
    },
    template: html`
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
            <option value="custom" disabled>Custom</option>
        </select>
        <button 
            v-if="showAdvancedButton" 
            class="button-symbol"
            title="Open advanced search options"
            @click="openAdvancedSearchModal"
        >
            ☰
        </button>
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
        }
    },
    watch: {
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
                
                console.log('[InventoryCategoryFilter] URL parameters changed, syncing dropdown');
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
        console.log('[InventoryCategoryFilter] Mounting component', {
            containerPath: this.containerPath,
            currentPath: this.appContext?.currentPath
        });
        
        // Initialize categories store
        this.categoriesStore = getReactiveStore(
            Requests.getAvailableTabs,
            null, // No save function
            ['INVENTORY'], // Arguments
            null // No analysis config
        );
        
        console.log('[InventoryCategoryFilter] Categories store initialized, isLoading:', this.categoriesStore.isLoading);
        
        // Wait for initial load to complete
        if (this.categoriesStore.isLoading) {
            console.log('[InventoryCategoryFilter] Waiting for categories to load...');
            await new Promise(resolve => {
                const unwatch = this.$watch('categoriesStore.isLoading', (newValue) => {
                    if (!newValue) {
                        console.log('[InventoryCategoryFilter] Categories loaded, count:', this.categories.length);
                        unwatch();
                        resolve();
                    }
                });
            });
        }
        
        // Perform initial sync after data is loaded
        console.log('[InventoryCategoryFilter] Performing initial sync with URL');
        this.hasPerformedInitialSync = true;
        this.syncWithURL();
    },
    methods: {
        handleChange(event) {
            const value = event.target.value;
            console.log('[InventoryCategoryFilter] User changed category selection:', value);
            this.selectedCategory = value;
            
            // Emit event with category name or null for "All Items"
            const categoryName = value || null;
            
            console.log('[InventoryCategoryFilter] Emitting category-selected and updating URL with:', categoryName);
            this.$emit('category-selected', categoryName);
            this.updateURL(categoryName);
        },
        
        updateURL(categoryName) {
            console.log('[InventoryCategoryFilter] updateURL called with:', categoryName);
            const cleanPath = this.containerPath.split('?')[0];
            const isOnDashboard = this.appContext?.currentPath?.split('?')[0].split('/')[0] === 'dashboard';
            
            console.log('[InventoryCategoryFilter] Update context:', {
                cleanPath,
                isOnDashboard,
                currentPath: this.appContext?.currentPath
            });
            
            // Build new path with itemCategoryFilter parameter
            const newPath = NavigationRegistry.buildPathWithCurrentParams(
                cleanPath,
                this.appContext?.currentPath,
                {
                    itemCategoryFilter: categoryName || undefined // undefined removes the parameter
                }
            );
            
            console.log('[InventoryCategoryFilter] Built new path:', newPath);
            
            if (isOnDashboard) {
                // Update dashboard registry with new path
                console.log('[InventoryCategoryFilter] Updating dashboard registry');
                NavigationRegistry.dashboardRegistry.updatePath(
                    cleanPath,
                    newPath
                );
            } else if (this.navigateToPath) {
                console.log('[InventoryCategoryFilter] Calling navigateToPath with:', newPath);
                this.navigateToPath(newPath);
            } else {
                console.log('[InventoryCategoryFilter] No navigation method available');
            }
        },
        
        syncWithURL() {
            console.log('[InventoryCategoryFilter] syncWithURL called');
            const params = NavigationRegistry.getParametersForContainer(
                this.containerPath,
                this.appContext?.currentPath
            );
            
            console.log('[InventoryCategoryFilter] URL parameters:', params);
            
            // Get itemCategoryFilter from URL params
            const categoryFromUrl = params?.itemCategoryFilter || '';
            
            console.log('[InventoryCategoryFilter] Category from URL:', categoryFromUrl, 'hasPerformedInitialSync:', this.hasPerformedInitialSync);
            
            // Update selected category
            this.selectedCategory = categoryFromUrl;
            
            // Emit the category if component is being used
            if (this.hasPerformedInitialSync) {
                console.log('[InventoryCategoryFilter] Emitting category-selected event:', categoryFromUrl || null);
                this.$emit('category-selected', categoryFromUrl || null);
            } else {
                console.log('[InventoryCategoryFilter] Skipping event emit - not initialized yet');
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
