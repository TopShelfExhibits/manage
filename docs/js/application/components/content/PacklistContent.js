import { Requests, html, hamburgerMenuRegistry, PacklistTable, DataView, NavigationRegistry, DashboardToggleComponent, getReactiveStore, findMatchingStores, createAnalysisConfig, generateStoreKey, authState, ScheduleFilterSelect, invalidateCache, Priority } from '../../index.js';
import { textFiltersToSearchParams } from '../../../data_management/utils/helpers.js';
import { PacklistItemsSummary } from './PacklistItemsSummary.js';
import { ScheduleTableComponent } from './ScheduleTable.js';
import { PacklistTableMenuComponent } from './PacklistTable.js';
import { packlistIndexResolutionMixin } from '../interface/IndexResolutionModal.js';

export const PacklistMenuComponent = {
    props: {
        containerPath: String,
        containerType: String,
        currentSegment: String,
        title: String,
        refreshCallback: Function,
        navigateToPath: Function
    },
    inject: ['$modal'],
    emits: ['close-modal'],
    computed: {
        currentPacklistName() {
            // Extract packlist name from containerPath
            // Format: packlist/{name} or packlist/{name}/details or packlist/{name}/edit
            if (!this.containerPath) return null;
            const cleanPath = this.containerPath.split('?')[0];
            const segments = cleanPath.split('/').filter(segment => segment.length > 0);
            // segments[0] = 'packlist', segments[1] = packlist name
            return segments[1] || null;
        },
        isViewingSpecificPacklist() {
            return !!this.currentPacklistName;
        },
        menuItems() {
            const items = [];
            
            switch (this.currentSegment) {
                default:
                    // Show duplicate option only when viewing a specific packlist (not on reserved pages like pins)
                    if (this.isViewingSpecificPacklist && this.currentPacklistName !== 'pins') {
                        items.push({ label: 'Duplicate This Packlist', action: 'duplicatePacklist' });
                    }
                    
                    items.push(
                        { label: 'Create Show Packlist', action: 'createNewPacklist' },
                        { label: 'Create Custom Packlist', action: 'createCustomPacklist' }
                        // { label: 'Help', action: 'help' } // Placeholder - not yet implemented
                    );
                    return items;
            }
        }
    },
    methods: {
        async handleAction(action) {
            switch (action) {
                case 'createNewPacklist':
                    this.openCreatePacklistModal();
                    break;
                case 'createCustomPacklist':
                    this.openCreateCustomPacklistModal();
                    break;
                case 'duplicatePacklist':
                    this.openDuplicatePacklistModal();
                    break;
                // case 'help': // Placeholder - not yet implemented
                //     this.$modal.alert('Packlist help functionality coming soon!', 'Info');
                //     break;
                default:
                    this.$modal.alert(`Action ${action} not implemented yet.`, 'Info');
            }
        },
        openCreatePacklistModal(templateName = '_TEMPLATE') {
            // Close the hamburger menu modal first
            this.$emit('close-modal');
            
            const parentNavigateToPath = this.navigateToPath;
            
            const CreatePacklistModalContent = {
                components: {
                    'schedule-table': ScheduleTableComponent,
                    'ScheduleFilterSelect': ScheduleFilterSelect
                },
                props: {
                    navigateToPath: Function,
                    templateName: {
                        type: String,
                        default: '_TEMPLATE'
                    }
                },
                emits: ['close-modal'],
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
                    },
                    
                    handleNavigateToPath(path) {
                        // Close modal first
                        this.$emit('close-modal');
                        // Then navigate
                        if (this.navigateToPath) {
                            this.navigateToPath(path);
                        }
                    },
                    
                    handlePacklistCreated() {
                        // Close modal after packlist is created
                        this.$emit('close-modal');
                    }
                },
                template: html`
                    <div>
                        <p style="margin-bottom: 1rem;">
                            Search for a show and click "Create Packlist" to create a new pack list.
                        </p>
                        <schedule-table
                            :filter="dateFilter"
                            :search-params="tableSearchParams"
                            :patches="[{ patch: { table: { hideRowsOnSearch: true } } }]"
                            :template-name="templateName"
                            @navigate-to-path="handleNavigateToPath"
                            @packlist-created="handlePacklistCreated"
                        >
                            <template #header-area>
                                <div class="button-bar">
                                    <ScheduleFilterSelect
                                        :include-years="true"
                                        :start-year="2023"
                                        :show-advanced-button="false"
                                        @search-selected="handleSearchSelected"
                                    />
                                </div>
                            </template>
                        </schedule-table>
                    </div>
                `
            };
            
            this.$modal.custom(
                CreatePacklistModalContent,
                { size: 'page', tall: true, navigateToPath: parentNavigateToPath, templateName: templateName },
                templateName === '_TEMPLATE' ? 'Create Show Packlist' : 'Duplicate Packlist Attached to Show'
            );
        },
        openCreateCustomPacklistModal(templateName = '_TEMPLATE') {
            // Close the hamburger menu modal first
            this.$emit('close-modal');
            
            const parentNavigateToPath = this.navigateToPath;
            
            const CustomPacklistModalContent = {
                inject: ['$modal'],
                props: {
                    navigateToPath: Function,
                    templateName: {
                        type: String,
                        default: '_TEMPLATE'
                    }
                },
                emits: ['close-modal'],
                data() {
                    return {
                        packlistName: '',
                        isCreating: false
                    };
                },
                methods: {
                    async handleCreate() {
                        const name = this.packlistName.trim();
                        
                        if (!name) {
                            this.$modal.alert('Please enter a packlist name.', 'Validation Error');
                            return;
                        }
                        
                        this.isCreating = true;
                        try {
                            // Create the tab from template
                            await Requests.createNewTab('PACK_LISTS', this.templateName, name);
                            
                            // Close modal
                            this.$emit('close-modal');
                            
                            // Navigate to the new packlist
                            if (this.navigateToPath) {
                                this.navigateToPath(`packlist/${name}`);
                            }
                        } catch (error) {
                            console.error('Error creating custom packlist:', error);
                            this.$modal.error(`Failed to create packlist: ${error.message}`, 'Error');
                        } finally {
                            this.isCreating = false;
                        }
                    },
                    handleCancel() {
                        this.$emit('close-modal');
                    }
                },
                template: html`
                    <slot>
                        <div v-if="templateName === '_TEMPLATE'" class="card yellow">
                            <p><strong>Note:</strong> To attach a new packlist to a show, cancel and use "Create Show Packlist". <br> <em>This packlist will not be visible when packlists are filtered by the production schedule.</em></p>
                        </div>
                        <div v-else class="card">
                            <p><strong>Duplicating:</strong> {{ templateName }}</p>
                        </div>
                        <div style="margin-bottom: 1rem;">
                            <label for="packlistNameInput" style="display: block; margin-bottom: 0.5rem; font-weight: bold;">
                                {{ templateName === '_TEMPLATE' ? 'Packlist Name:' : 'New Packlist Name:' }}
                            </label>
                            <input 
                                id="packlistNameInput"
                                v-model="packlistName" 
                                type="text" 
                                placeholder="Enter packlist name" 
                                style="width: 100%; padding: 0.5rem; font-size: 1rem;"
                                :disabled="isCreating"
                                @keyup.enter="handleCreate"
                            />
                        </div>
                        <div class="button-bar">
                            <button @click="handleCreate" :disabled="isCreating || !packlistName.trim()">
                                {{ isCreating ? 'Creating...' : 'Create' }}
                            </button>
                            <button @click="handleCancel" class="gray" :disabled="isCreating">
                                Cancel
                            </button>
                        </div>
                    </slot>
                `
            };
            
            this.$modal.custom(
                CustomPacklistModalContent,
                { modalClass: 'reading-menu', size: 'wide', navigateToPath: parentNavigateToPath, templateName: templateName },
                templateName === '_TEMPLATE' ? 'Create Custom Packlist' : 'Duplicate As Custom Packlist'
            );
        },
        openDuplicatePacklistModal() {
            // Close the hamburger menu modal first
            this.$emit('close-modal');
            
            const currentPacklist = this.currentPacklistName;
            if (!currentPacklist) {
                this.$modal.alert('No packlist selected to duplicate.', 'Error');
                return;
            }
            
            const DuplicateChoiceModalContent = {
                inject: ['$modal'],
                props: {
                    currentPacklist: String,
                    openShowPacklistModal: Function,
                    openCustomPacklistModal: Function
                },
                emits: ['close-modal'],
                methods: {
                    handleDuplicateAttachedToShow() {
                        this.$emit('close-modal');
                        if (this.openShowPacklistModal) {
                            this.openShowPacklistModal(this.currentPacklist);
                        }
                    },
                    handleDuplicateAsCustom() {
                        this.$emit('close-modal');
                        if (this.openCustomPacklistModal) {
                            this.openCustomPacklistModal(this.currentPacklist);
                        }
                    },
                    handleCancel() {
                        this.$emit('close-modal');
                    }
                },
                template: html`
                    <div>
                        <p style="margin-bottom: 1.5rem;">Choose how to duplicate "{{ currentPacklist }}":</p>
                        <div class="button-bar" style="flex-direction: column; gap: 0.5rem;">
                            <button @click="handleDuplicateAttachedToShow" style="width: 100%;">
                                Duplicate Attached to Show
                            </button>
                            <button @click="handleDuplicateAsCustom" style="width: 100%;">
                                Duplicate As Custom
                            </button>
                            <button @click="handleCancel" class="gray" style="width: 100%;">
                                Cancel
                            </button>
                        </div>
                    </div>
                `
            };
            
            this.$modal.custom(
                DuplicateChoiceModalContent,
                { 
                    modalClass: 'reading-menu',
                    size: 'wide',
                    currentPacklist: currentPacklist,
                    openShowPacklistModal: this.openCreatePacklistModal.bind(this),
                    openCustomPacklistModal: this.openCreateCustomPacklistModal.bind(this)
                },
                'Duplicate Packlist'
            );
        }
    },
    template: html`
        <ul>
            <li v-for="item in menuItems" :key="item.action">
                <button 
                    @click="handleAction(item.action)"
                    :disabled="item.disabled"
                    :class="item.class">
                    {{ item.label }}
                </button>
            </li>
        </ul>
    `
};





const PacklistPinToggleComponent = {
    props: {
        containerPath: String
    },
    computed: {
        currentPacklistName() {
            if (!this.containerPath) return null;
            const segments = this.containerPath.split('?')[0].split('/').filter(Boolean);
            return (segments[0] === 'packlist' && segments[1] && segments[1] !== 'pins')
                ? segments[1]
                : null;
        },
        pinnedStore() {
            if (!authState.user?.email) return null;
            return getReactiveStore(Requests.getUserData, Requests.storeUserData, [authState.user.email, 'pinned_packlists']);
        },
        isPinned() {
            return this.currentPacklistName ? this.pinnedStore?.data?.includes(this.currentPacklistName) : false;
        }
    },
    methods: {
        async handleToggle() {
            const store = this.pinnedStore;
            if (!store || !this.currentPacklistName) return;
            const idx = store.data.indexOf(this.currentPacklistName);
            if (idx !== -1) store.data.splice(idx, 1);
            else store.data.push(this.currentPacklistName);
            await store.save();
        }
    },
    template: html`
        <button
            v-if="currentPacklistName"
            @click="handleToggle"
            :class="{ 'red': isPinned, 'green': !isPinned }">
            {{ isPinned ? 'Unpin Packlist' : 'Pin Packlist' }}
        </button>
    `
};

// What each packlist card key is. _shipLine, _status and _cardColor are derived on a computed copy.
const PACKLIST_FIELDS = [
    { key: 'title', label: 'Title', type: 'string', sortable: true },
    { key: 'shipDate', label: 'Ship Date', type: 'date', sortable: true },
    { key: '_shipLine', label: 'Ship' },
    { key: 'description', label: 'Description', format: 'multiline' },
    { key: '_status', label: 'Status' },
    { key: '_cardColor', label: 'Card colour' }
];

// Packlists page view registry (views-and-renderers-plan §4.3, §5). Cards don't link /details (R4.1).
const PACKLIST_VIEWS = {
    id: 'packlists',
    default: 'cards',
    theme: 'gray',
    views: [
        {
            id: 'cards',
            name: 'Packlists',
            icon: 'grid_view',
            layout: 'cards',
            cards: { card: [['title'], ['_shipLine'], ['description']], footer: [['_status']] },
            hidden: ['shipDate', '_cardColor'],
            rowColor: { field: '_cardColor', rule: 'value' },
            sort: { key: 'title', dir: 'asc' },
            action: 'row'
        }
    ]
};

export const PacklistContent = {
    mixins: [packlistIndexResolutionMixin],
    components: {
        'packlist-table': PacklistTable,
        DataView,
        'PacklistItemsSummary': PacklistItemsSummary,
        'ScheduleFilterSelect': ScheduleFilterSelect
    },
    props: {
        containerPath: String,
        navigateToPath: Function
    },
    inject: ['$modal', 'appContext'],
    data() {
        return {
            packlistsStore: null, // Reactive store for packlists
            allPacklistsStore: null, // Always-loaded store for badge detection (unfiltered)
            autoSavedPacklists: new Set(), // Track which packlists have auto-saved data
            filter: null, // Filter for schedule overlaps (date range or identifier)
            resolvedTabName: null, // Verified actual tab name after resolution
            packlistNotFound: false, // True when route segment doesn't match any packlist
            isResolving: false, // True while resolving identifier
            PACKLIST_FIELDS,
            PACKLIST_VIEWS,
            packlistAction: { to: (row) => 'packlist/' + row.title }
        };
    },
    computed: {
        pinnedPacklistsStore() {
            if (!authState.user?.email) return null;
            return getReactiveStore(Requests.getUserData, Requests.storeUserData, [authState.user.email, 'pinned_packlists']);
        },
        pinnedPacklists() {
            return new Set(this.pinnedPacklistsStore?.data || []);
        },
        pathSegments() {
            // Strip query parameters before splitting
            const cleanPath = this.containerPath.split('?')[0];
            return cleanPath.split('/').filter(segment => segment.length > 0);
        },
        currentSegment() {
            // Last path segment for packlist paths is always the section (not a view; see views-and-renderers-plan)
            return 'packlist';
        },
        currentPacklist() {
            // Handle direct packlist access: packlist/{name} or packlist/{name}/details or packlist/{name}/edit
            // pathSegments[0] = 'packlist', pathSegments[1] = packlist identifier, pathSegments[2] = 'details' or 'edit' (optional)
            return this.pathSegments[1] || '';
        },
        isDetailsView() {
            // Check if we're viewing the details subview
            return this.pathSegments[2] === 'details';
        },
        // Determine if we're viewing a specific packlist
        isViewingPacklist() {
            return !!this.currentPacklist && this.currentPacklist !== 'packlist' && this.currentPacklist !== 'pins' && this.currentPacklist !== 'unlinked';
        },
        // Check if we're viewing pinned cards based on URL
        showPinnedOnly() {
            return this.pathSegments[1] === 'pins';
        },
        showUnlinkedOnly() {
            return this.pathSegments[1] === 'unlinked';
        },
        // Computed properties for cards grid
        availablePacklists() {
            if (!this.packlistsStore) return [];
            
            const tabs = this.packlistsStore.data || [];
            
            // Add explicit dependency on analysis state to trigger reactivity
            // when analysis completes (including lock info analysis)
            const isAnalyzing = this.packlistsStore.isAnalyzing;
            const analysisProgress = this.packlistsStore.analysisProgress;
            
            // Filter tabs based on the current subpage
            const filteredTabs = this.showPinnedOnly
                ? tabs.filter(tab => {
                    if (this.pinnedPacklists.has(tab.title)) return true;
                    const matchingStores = findMatchingStores(Requests.getPackList, [tab.title]);
                    const hasUnsavedChanges = matchingStores.length > 0
                        ? matchingStores.some(match => match.isModified)
                        : this.autoSavedPacklists.has(tab.title);
                    return hasUnsavedChanges;
                })
                : this.showUnlinkedOnly
                ? tabs.filter(tab => {
                    const attachment = tab.scheduleAttachment;
                    return attachment && !attachment.attached && attachment.hasIdentifierParts;
                })
                : tabs;
            
            // Rows with derived fields for the cards view
            return filteredTabs.map(tab => this.packlistRow(tab));
        },
        hasPinnedOrUnsaved() {
            if (this.pinnedPacklists.size > 0) return true;
            const allTabs = this.allPacklistsStore?.data;
            if (!allTabs) return false;
            return allTabs.some(tab => {
                const matchingStores = findMatchingStores(Requests.getPackList, [tab.title]);
                return matchingStores.length > 0
                    ? matchingStores.some(m => m.isModified)
                    : this.autoSavedPacklists.has(tab.title);
            });
        },
        hasUnlinkedPacklists() {
            const allTabs = this.allPacklistsStore?.data;
            if (!allTabs) return false;
            return allTabs.some(tab => {
                const attachment = tab.scheduleAttachment;
                return attachment && !attachment.attached && attachment.hasIdentifierParts;
            });
        },
        isLoading() {
            return this.packlistsStore ? (this.packlistsStore.isLoading || this.packlistsStore.isAnalyzing) : false;
        },
        isAnalyzing() {
            return this.packlistsStore ? this.packlistsStore.isAnalyzing : false;
        },
        loadingProgress() {
            return this.packlistsStore ? this.packlistsStore.analysisProgress : -1;
        },
        analysisMessage() {
            return this.packlistsStore ? this.packlistsStore.analysisMessage : 'Loading...';
        }
    },
    watch: {
        // Watch for route changes to resolve packlist identifier
        currentPacklist: {
            handler(newVal, oldVal) {
                if (newVal && newVal !== 'packlist' && newVal !== 'pins' && newVal !== 'unlinked' && newVal !== oldVal) {
                    this.resolvePacklistIdentifier(newVal);
                }
            },
            immediate: true
        },
        // Watch for when packlists data is loaded and check for auto-saved data
        'packlistsStore.data': {
            handler(newData) {
                if (newData && newData.length > 0 && !this.packlistsStore.isLoading) {
                    this.checkAutoSavedPacklists();
                }
            },
            deep: false
        },
        // Also watch for loading state change to catch initial load completion
        'packlistsStore.isLoading': {
            handler(isLoading, wasLoading) {
                // When loading completes (isLoading goes from true to false)
                if (wasLoading && !isLoading && this.packlistsStore.data && this.packlistsStore.data.length > 0) {
                    this.checkAutoSavedPacklists();
                }
            }
        },
        // Watch for showPinnedOnly changes to apply "Show All" filter
        showPinnedOnly: {
            handler(isPinnedView) {
                if (isPinnedView) {
                    this.filter = { type: 'show-all' };
                    this.recreateStore();
                }
            },
            immediate: true
        },
        showUnlinkedOnly: {
            handler(isUnlinkedView) {
                if (isUnlinkedView) {
                    this.filter = { type: 'show-all' };
                    this.recreateStore();
                }
            },
            immediate: true
        },
        'allPacklistsStore.data': {
            handler(newData) {
                if (newData && newData.length > 0 && !this.allPacklistsStore.isLoading) {
                    this.checkAutoSavedPacklists();
                }
            },
            deep: false
        },
        'allPacklistsStore.isLoading': {
            handler(isLoading, wasLoading) {
                if (wasLoading && !isLoading && this.allPacklistsStore?.data?.length > 0) {
                    this.checkAutoSavedPacklists();
                }
            }
        }
    },
    async mounted() {
        this.initAllPacklistsStore();

        // Register packlist navigation routes
        NavigationRegistry.registerNavigation('packlist', {
            routes: {
                active: {
                    displayName: 'Active Packlists',
                    dashboardTitle: 'Active Pack Lists',
                },
                archived: {
                    displayName: 'Archived Packlists',
                    dashboardTitle: 'Archived Pack Lists',
                },
                templates: {
                    displayName: 'Automation',
                    dashboardTitle: 'Pack List Automation',
                }
            }
        });

        // Register hamburger menu for packlist
        hamburgerMenuRegistry.registerMenu('packlist', {
            components: [PacklistMenuComponent, PacklistTableMenuComponent, PacklistPinToggleComponent, DashboardToggleComponent],
            props: {
                refreshCallback: this.handleRefresh,
                navigateToPath: this.navigateToPath,
                getTableRef: () => this.$refs.packlistTable,
                getLockInfo: async () => {
                    // Get lock info from the current packlist if we're viewing one
                    const packlistName = this.currentPacklist;
                    // console.log('[PacklistContent] getLockInfo called:', { 
                    //     packlistName, 
                    //     hasStore: !!this.packlistsStore,
                    //     storeData: this.packlistsStore?.data?.length
                    // });
                    
                    if (!packlistName) return null;
                    
                    // Always fetch directly from API to ensure fresh lock status
                    // (bypasses store which may have stale analysis data)
                    // console.log('[PacklistContent] Fetching lock info directly for:', packlistName);
                    const lockInfo = await Requests.getPacklistLock(packlistName);
                    // console.log('[PacklistContent] Lock info from API:', lockInfo);
                    return lockInfo;
                }
            }
        });
    },
    methods: {
        async handleSearchSelected(searchData) {
            if (!searchData) {
                // Empty selection - clear filter and recreate store
                this.filter = null;
                this.packlistsStore = null;
                return;
            }

            // Handle "show all" - set special filter type
            if (searchData.type === 'show-all') {
                this.filter = { type: 'show-all' };
                this.recreateStore();
                return;
            }

            // Build filter from search data
            const filter = {};
            
            if (searchData.type === 'year') {
                // Handle year selection - use dateFilters array
                filter.dateFilters = searchData.dateFilters || [
                    { column: 'Date', value: searchData.startDate, type: 'after' },
                    { column: 'Date', value: searchData.endDate, type: 'before' }
                ];
            } else {
                // Handle saved search - use dateFilters array
                if (searchData.dateFilters) {
                    filter.dateFilters = searchData.dateFilters;
                }
            }
            
            this.filter = filter;
            
            // Recreate the store with the new filter
            this.recreateStore();
        },
        recreateStore() {
            // Configure analysis for packlist descriptions
            const analysisConfig = [
                // Check lock status first - this determines card color
                createAnalysisConfig(
                    Requests.getPacklistLock,
                    'lockInfo',
                    'Checking lock status...',
                    ['title'], // Extract tab name from 'title' column
                    [authState.user?.email], // Pass current user to filter out their own locks
                    'lockInfo' // Store lock info in 'lockInfo' column
                ),
                // Skip description analysis in pinned view — it loads full content of every packlist
                ...(!this.showPinnedOnly && !this.showUnlinkedOnly ? [createAnalysisConfig(
                    Requests.getPacklistDescription,
                    'description',
                    'Loading packlist details...',
                    ['title'], // Use title as the source (project identifier)
                    [],
                    'description', // Store result in 'description' column
                    false,
                    Priority.ANALYSIS,
                    false,
                    false // nonessential
                )] : []),
                createAnalysisConfig(
                    Requests.getShowDetails,
                    'showDetails',
                    'Loading show details...',
                    ['title'], // Use title as the source (project identifier)
                    [],
                    'showDetails' // Store entire show row in 'showDetails' column
                ),
                createAnalysisConfig(
                    Requests.getPacklistScheduleAttachment,
                    'scheduleAttachment',
                    'Checking schedule...',
                    ['title'], // Use title as the source (project identifier)
                    [],
                    'scheduleAttachment' // Store attachment diagnosis in 'scheduleAttachment' column
                )
            ];
            
            // Create new reactive store with the current filter
            this.packlistsStore = getReactiveStore(
                Requests.getPacklists,
                null,
                [this.filter],
                analysisConfig
            );
        },
        hasUnsavedChanges(title) {
            const matchingStores = findMatchingStores(Requests.getPackList, [title]);
            return matchingStores.length > 0
                ? matchingStores.some(match => match.isModified)
                : this.autoSavedPacklists.has(title);
        },
        isUnattached(tab) {
            const attachment = tab.scheduleAttachment;
            return !!(attachment && !attachment.attached && attachment.hasIdentifierParts);
        },
        // Derived fields on a computed copy (colour rules that need logic live here, R3.5)
        packlistRow(tab) {
            const isLocked = !!tab.lockInfo;
            const unsaved = this.hasUnsavedChanges(tab.title);
            let status = '';
            if (isLocked) {
                const lockOwner = tab.lockInfo.user || 'Unknown';
                status = `Locked for edit by: ${lockOwner.includes('@') ? lockOwner.split('@')[0] : lockOwner}`;
            } else if (unsaved) {
                status = 'Unsaved changes';
            }
            let shipLine = '';
            if (tab.showDetails && tab.showDetails.Ship) shipLine = `Ship Date: ${tab.showDetails.Ship}`;
            else if (tab.description && !tab.showDetails) shipLine = 'Ship Date: ...';
            const description = tab.description || (this.packlistsStore ? (this.packlistsStore.isAnalyzing ? 'Loading...' : '') : '');
            return {
                ...tab,
                shipDate: tab.showDetails?.Ship || null,
                _shipLine: shipLine,
                description,
                _status: status,
                _cardColor: this.isUnattached(tab) ? 'red' : 'gray',
                _unsaved: unsaved
            };
        },
        // Row-level decorations → footer actions: Save, and schedule-link fixes for unattached packlists
        packlistDecorations(row, key) {
            if (key !== null) return [];
            const cards = [];
            if (row._unsaved) {
                cards.push({ message: 'Save', class: 'green', action: () => this.savePacklist(row.title) });
            }
            if (this.isUnattached(row)) {
                const attachment = row.scheduleAttachment;
                const suggestedMatch = attachment.suggestedMatch;
                const clientIssue = attachment.clientIssue;
                const showIssue = attachment.showIssue;
                if (suggestedMatch) {
                    cards.push({ message: 'Link to schedule', class: 'gray', action: () => this.openLinkToScheduleModal(row.title) });
                    cards.push({ message: `Link: ${suggestedMatch}`, class: 'red', action: () => this.openSuggestedMatchModal(row.title, suggestedMatch) });
                } else if (clientIssue || showIssue) {
                    if (clientIssue) cards.push({ message: '⚠ Client missing', class: 'red', action: () => this.openPacklistIndexResolutionModal(row.title, 'client', clientIssue.rawValue) });
                    if (showIssue) cards.push({ message: '⚠ Show missing', class: 'red', action: () => this.openPacklistIndexResolutionModal(row.title, 'show', showIssue.rawValue) });
                } else {
                    cards.push({ message: 'Link to schedule', class: 'red', action: () => this.openLinkToScheduleModal(row.title) });
                }
            }
            return cards;
        },
        async resolvePacklistIdentifier(identifier) {
            // Reset state
            this.packlistNotFound = false;
            this.resolvedTabName = null;
            this.isResolving = true;
            
            try {
                // Resolve the identifier to actual tab name
                const resolvedName = await Requests.resolvePacklistIdentifier(identifier);
                
                if (!resolvedName) {
                    // No matching packlist found
                    this.packlistNotFound = true;
                    console.warn(`[PacklistContent] Packlist not found: ${identifier}`);
                    return;
                }
                
                if (resolvedName !== identifier) {
                    // Route uses non-canonical name, redirect to actual tab name
                    //console.log(`[PacklistContent] Redirecting from "${identifier}" to canonical "${resolvedName}"`);
                    
                    // Build new path with resolved name
                    const segments = this.containerPath.split('/');
                    segments[1] = resolvedName;
                    const newPath = segments.join('/');
                    
                    // Call navigateToPath directly (not emit) with replaceHistory to avoid back-button confusion
                    this.navigateToPath({ targetPath: newPath, replaceHistory: true });
                    return;
                }
                
                // Identifier matches actual tab name, proceed
                this.resolvedTabName = resolvedName;
                //console.log(`[PacklistContent] Verified packlist: ${resolvedName}`);
                
            } catch (error) {
                console.error('[PacklistContent] Error resolving packlist identifier:', error);
                this.packlistNotFound = true;
            } finally {
                this.isResolving = false;
            }
        },
        initAllPacklistsStore() {
            this.allPacklistsStore = getReactiveStore(
                Requests.getPacklists,
                null,
                [{ type: 'show-all' }],
                [createAnalysisConfig(
                    Requests.getPacklistScheduleAttachment,
                    'scheduleAttachment',
                    'Checking schedule...',
                    ['title'],
                    [],
                    'scheduleAttachment'
                )]
            );
        },
        async checkAutoSavedPacklists() {
            const tabSource = this.allPacklistsStore?.data || this.packlistsStore?.data;
            if (!authState.isAuthenticated || !authState.user?.email || !tabSource) return;
            
            //console.log('[PacklistContent] Checking auto-saved packlists...');
            
            try {
                // Clear the set before checking to avoid stale entries
                this.autoSavedPacklists.clear();
                
                // Check each individual packlist for auto-saved data
                for (const tab of tabSource) {
                    if (tab.title === '_TEMPLATE') continue;
                    
                    // Generate the store key prefix (without analysis config)
                    const storeKeyPrefix = generateStoreKey(
                        Requests.getPackList,
                        Requests.savePackList,
                        [tab.title],
                        null
                    ).substring(0, generateStoreKey(Requests.getPackList, Requests.savePackList, [tab.title], null).lastIndexOf(':'));
                    
                    // Check if this specific key exists (prefix match since analysis config might vary)
                    const hasAutoSave = await Requests.hasUserDataKey(
                        authState.user.email,
                        storeKeyPrefix,
                        true // prefix match
                    );
                    
                    if (hasAutoSave) {
                        //console.log(`[PacklistContent] Found auto-save for: ${tab.title}`);
                        this.autoSavedPacklists.add(tab.title);
                    }
                }
                
                //console.log('[PacklistContent] Auto-saved packlists:', Array.from(this.autoSavedPacklists));
            } catch (error) {
                console.error('[PacklistContent] Error checking auto-saved packlists:', error);
            }
        },
        async handleRefresh() {
            //console.log('PacklistContent: Refresh requested');
            // Invalidate the getTabs cache to force reload
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['PROD_SCHED', 'Production Schedule'] }, // Ensure schedule data is fresh, but don't refresh client and show ref data
                { namespace: 'database', methodName: 'getTabs', args: ['PACK_LISTS'] },
                { namespace: 'database', methodName: 'getData', args: ['PACK_LISTS'] }
            ], true);
            
            // If viewing a packlist table, refresh its lock status
            if (this.$refs.packlistTable) {
                await this.$refs.packlistTable.checkLockStatus();
            }
        },
        handlePacklistSelect(packlistName) {
            this.navigateToPath('packlist/' + packlistName);
        },
        async togglePin(packlistName) {
            const store = this.pinnedPacklistsStore;
            if (!store) return;
            const idx = store.data.indexOf(packlistName);
            if (idx !== -1) store.data.splice(idx, 1);
            else store.data.push(packlistName);
            await store.save();
        },
        togglePinnedView() {
            if (this.showPinnedOnly) {
                this.navigateToPath('packlist');
            } else {
                this.navigateToPath('packlist/pins');
            }
        },
        toggleUnlinkedView() {
            if (this.showUnlinkedOnly) {
                this.navigateToPath('packlist');
            } else {
                this.navigateToPath('packlist/unlinked');
            }
        },
        async savePacklist(packlistName) {
            try {
                // Find the reactive store for this packlist
                const matchingStores = findMatchingStores(
                    Requests.getPackList,
                    [packlistName]
                );
                if (matchingStores.length === 0) {
                    this.$modal.alert('Packlist not found or no changes to save.', 'Save');
                    return;
                }
                const storeMatch = matchingStores[0];
                if (!storeMatch.isModified) {
                    this.$modal.alert('No unsaved changes to save.', 'Save');
                    return;
                }
                await storeMatch.store.save();
                this.$modal.alert('Packlist saved successfully.', 'Success');
            } catch (error) {
                console.error('[PacklistContent] Failed to save packlist:', error);
                this.$modal.error(`Failed to save packlist: ${error.message}`, 'Save Error');
            }
        },
        async openLinkToScheduleModal(packlistTitle) {
            let allTargets = [];
            try {
                allTargets = await Requests.getAllScheduleIdentifiers();
            } catch (e) {
                return;
            }

            // Filter to matching year if parseable from title
            const yearMatch = String(packlistTitle || '').match(/\b(\d{4})\b/);
            const year = yearMatch ? yearMatch[1] : null;
            const targets = year ? allTargets.filter(t => t.includes(year)) : allTargets;

            const LinkModal = {
                inject: ['$modal'],
                props: { packlistTitle: String, targets: Array, onConfirm: Function },
                data() { return { filterText: '', isSubmitting: false }; },
                computed: {
                    filteredTargets() {
                        const search = this.filterText.trim().toLowerCase();
                        if (!search) return this.targets;
                        return this.targets.filter(t => t.toLowerCase().includes(search));
                    }
                },
                methods: {
                    async selectTarget(scheduleId) {
                        if (this.isSubmitting) return;
                        this.isSubmitting = true;
                        try {
                            await this.onConfirm(scheduleId);
                            this.$emit('close-modal');
                        } catch (e) {
                            this.isSubmitting = false;
                        }
                    }
                },
                template: html`
                    <div :style="isSubmitting ? 'opacity: 0.7;' : ''">
                        <div class="input-container" style="margin-bottom: 0.5rem;">
                            <input type="text" v-model="filterText" :disabled="isSubmitting" placeholder="Search..." class="search-input" style="width: 100%;" />
                        </div>
                        <p v-if="!filteredTargets.length" style="color: var(--color-text-secondary);">No schedule entries found.</p>
                        <ul>
                            <li v-for="target in filteredTargets" :key="target">
                                <button @click="selectTarget(target)" :disabled="isSubmitting" class="white" style="text-align: left;">{{ target }}</button>
                            </li>
                        </ul>
                    </div>
                `
            };

            this.$modal.custom(LinkModal, {
                packlistTitle,
                targets,
                modalClass: 'hamburger-menu',
                onConfirm: async (scheduleId) => {
                    await Requests.addNameOverride(scheduleId, packlistTitle);
                    if (this.packlistsStore) {
                        await this.packlistsStore.load();
                    }
                }
            }, 'Link to Schedule Entry');
        },
        async _reloadAfterPacklistAttachmentChange(packlistTitle) {
            if (this.packlistsStore) await this.packlistsStore.load();
        }
    },
    template: html `
        <slot>
            <DataView
                v-if="!isViewingPacklist"
                :fields="PACKLIST_FIELDS"
                :rows="availablePacklists"
                :registry="PACKLIST_VIEWS"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
                :action="packlistAction"
                :decorations="packlistDecorations"
                :show-search="true"
                :show-sort="true"
                :sync-search-with-url="true"
                :show-refresh="true"
                :is-loading="isLoading"
                :is-analyzing="isAnalyzing"
                :loading-progress="loadingProgress"
                :loading-message="analysisMessage"
                :empty-message="packlistsStore ? (showPinnedOnly ? 'No pinned packlists' : showUnlinkedOnly ? 'No unlinked packlists' : 'No packlists available') : ''"
                :show-pin-buttons="true"
                :pinned-items="pinnedPacklists"
                :show-pinned-only="showPinnedOnly"
                @refresh="handleRefresh"
                @toggle-pin="togglePin"
            >
                <template #header-area>
                    <div class="button-bar">
                        <ScheduleFilterSelect
                            v-if="!showPinnedOnly && !showUnlinkedOnly"
                            :domain="'production_schedule'"
                            :include-years="true"
                            :start-year="2023"
                            :allow-show-all="true"
                            :container-path="containerPath"
                            :navigate-to-path="navigateToPath"
                            :show-advanced-button="true"
                            @search-selected="handleSearchSelected"
                        />
                        <button v-if="!showPinnedOnly && !showUnlinkedOnly && hasPinnedOrUnsaved" @click="togglePinnedView" class="button-symbol" title="show pinned and unsaved packlists"><span class="material-symbols-outlined">keep</span></button>
                        <button v-if="!showPinnedOnly && !showUnlinkedOnly && hasUnlinkedPacklists" @click="toggleUnlinkedView" class="button-symbol red" title="show unlinked packlists"><span class="material-symbols-outlined">warning</span></button>
                        <div v-if="showPinnedOnly" class='card' style="white-space: nowrap; padding: var(--padding-sm) var(--padding-md);">showing pinned & unsaved packlists</div>
                        <button v-if="showPinnedOnly" @click="togglePinnedView" class="small">Back</button>
                        <div v-if="showUnlinkedOnly" class='card red' style="white-space: nowrap; padding: var(--padding-sm) var(--padding-md);">showing unlinked packlists</div>
                        <button v-if="showUnlinkedOnly" @click="toggleUnlinkedView" class="small">Back</button>
                    </div>
                </template>
            </DataView>
            
            <!-- Loading state while resolving identifier -->
            <div v-else-if="isResolving" class="loading-message">
                <img src="assets/loading.gif" alt="..."/>
                <p>Finding packlist...</p>
            </div>
            
            <!-- 404 state when packlist not found -->
            <div v-else-if="packlistNotFound">
                <div class="card red">
                    <h3>Packlist Not Found</h3>
                    <p>"{{ currentPacklist }}" could not be found.</p>
                </div>
            </div>
            
            <!-- Individual Packlist View (Read-only or Edit mode) - only render after verification -->
            <packlist-table 
                ref="packlistTable"
                v-else-if="!isDetailsView && resolvedTabName"
                :tab-name="resolvedTabName"
                :container-path="containerPath"
                @navigate-to-path="navigateToPath"
            />
            
            <!-- Packlist Details View (Summary Table Only) - only after verification -->
            <PacklistItemsSummary 
                v-else-if="isDetailsView && resolvedTabName"
                :project-identifier="resolvedTabName"
                :container-path="containerPath"
                @navigate-to-path="navigateToPath"
            />
        </slot>
    `
};