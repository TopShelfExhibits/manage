import { Requests, html, hamburgerMenuRegistry, PacklistTable, CardsComponent, NavigationRegistry, DashboardToggleComponent, getReactiveStore, findMatchingStores, createAnalysisConfig, generateStoreKey, authState, ScheduleFilterSelect, parsedateFilterParameter, invalidateCache } from '../../index.js';
import { PacklistItemsSummary } from './PacklistItemsSummary.js';
import { ScheduleTableComponent } from './ScheduleTable.js';

export const PacklistMenuComponent = {
    props: {
        containerPath: String,
        containerType: String,
        currentView: String,
        title: String,
        refreshCallback: Function,
        getLockInfo: Function,
        navigateToPath: Function
    },
    inject: ['$modal'],
    emits: ['close-modal'],
    data() {
        return {
            lockInfo: null,
            isLoadingLockInfo: true,
            isRemovingLock: false
        };
    },
    async mounted() {
        await this.fetchLockInfo();
    },
    computed: {
        lockOwnerUsername() {
            if (!this.lockInfo || !this.lockInfo.user) return null;
            const email = this.lockInfo.user;
            return email.includes('@') ? email.split('@')[0] : email;
        },
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
            
            // Add lock removal option if lock exists and fully loaded
            if (!this.isLoadingLockInfo && this.lockInfo) {
                items.push({ 
                    label: this.isRemovingLock ? 'Removing lock...' : `Remove lock: ${this.lockOwnerUsername}`, 
                    action: 'removeLock',
                    class: this.isRemovingLock ? 'analyzing' : '',
                    disabled: this.isRemovingLock
                });
            }
            
            switch (this.currentView) {
                default:
                    // Show duplicate option only when viewing a specific packlist
                    if (this.isViewingSpecificPacklist) {
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
        async fetchLockInfo() {
            this.isLoadingLockInfo = true;
            try {
                if (this.getLockInfo) {
                    this.lockInfo = await this.getLockInfo();
                    //console.log('[PacklistMenu] Fetched lock info:', this.lockInfo);
                }
            } catch (error) {
                console.error('[PacklistMenu] Error fetching lock info:', error);
            } finally {
                this.isLoadingLockInfo = false;
            }
        },
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
                case 'removeLock':
                    await this.handleRemoveLock();
                    break;
                // case 'help': // Placeholder - not yet implemented
                //     this.$modal.alert('Packlist help functionality coming soon!', 'Info');
                //     break;
                default:
                    this.$modal.alert(`Action ${action} not implemented yet.`, 'Info');
            }
        },
        async handleRemoveLock() {
            if (!this.lockInfo) {
                this.$modal.alert('No lock to remove.', 'Info');
                return;
            }
            
            const username = this.lockOwnerUsername;
            const tabName = this.lockInfo.tab; // Use the actual tab name from lock info
            
            this.$modal.confirm(
                `Are you sure you want to force unlock ${tabName}?\n${username} may have unsaved changes.`,
                async () => {
                    this.isRemovingLock = true;
                    try {
                        console.log(`[PacklistContent.removeLock] About to call forceUnlockSheet for ${tabName}`);
                        const result = await Requests.forceUnlockSheet('PACK_LISTS', tabName, 'User requested via hamburger menu');
                        console.log(`[PacklistContent.removeLock] forceUnlockSheet returned:`, result);
                        
                        if (result.success) {
                            // Cache is automatically invalidated by the mutation method
                            // Just refresh the UI to fetch fresh data
                            
                            this.$modal.alert(
                                `Lock removed successfully.\n\nPreviously locked by: ${username}\nAutosave entries backed up: ${result.backupCount}\nAutosave entries deleted: ${result.deletedCount}`,
                                'Success'
                            );
                            
                            // Refresh lock info in the menu
                            await this.fetchLockInfo();
                            
                            // Refresh page data and lock state via callback
                            if (this.refreshCallback) {
                                await this.refreshCallback();
                            }
                        } else {
                            this.$modal.error(`Failed to remove lock: ${result.message}`, 'Error');
                        }
                    } catch (error) {
                        console.error('[PacklistMenu] Error removing lock:', error);
                        this.$modal.error(`Error removing lock: ${error.message}`, 'Error');
                    } finally {
                        this.isRemovingLock = false;
                    }
                },
                () => {},
                'Confirm Force Unlock',
                'Force Unlock'
            );
        },
        openCreatePacklistModal(templateName = 'TEMPLATE') {
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
                        default: 'TEMPLATE'
                    }
                },
                emits: ['close-modal'],
                data() {
                    return {
                        filter: null
                    };
                },
                computed: {
                    // Split filter into dateFilter and searchParams for table
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
                            // Handle year selection
                            this.filter = { 
                                startDate: searchData.startDate, 
                                endDate: searchData.endDate,
                                year: searchData.year
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
                        
                        // Parse dateFilter from saved search
                        if (searchData.dateFilter) {
                            const dateFilter = parsedateFilterParameter(searchData.dateFilter);
                            
                            // Check if this is an overlap search (has overlapShowIdentifier)
                            if (dateFilter.overlapShowIdentifier) {
                                // Convert overlapShowIdentifier to identifier for API
                                filter.identifier = dateFilter.overlapShowIdentifier;
                            } else {
                                // Regular date filter
                                Object.assign(filter, dateFilter);
                            }
                        }
                        
                        // Add byShowDate flag if present
                        if (searchData.byShowDate) {
                            filter.byShowDate = true;
                        }
                        
                        // Apply text filters
                        if (searchData.textFilters && searchData.textFilters.length > 0) {
                            searchData.textFilters.forEach(textFilter => {
                                if (textFilter.column && textFilter.value) {
                                    filter.searchParams[textFilter.column] = textFilter.value;
                                }
                            });
                        }
                        
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
                            :hide-rows-on-search="true"
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
                                        default-search="Upcoming"
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
                { modalClass: 'page-menu', navigateToPath: parentNavigateToPath, templateName: templateName },
                templateName === 'TEMPLATE' ? 'Create Show Packlist' : 'Duplicate Packlist Attached to Show'
            );
        },
        openCreateCustomPacklistModal(templateName = 'TEMPLATE') {
            // Close the hamburger menu modal first
            this.$emit('close-modal');
            
            const parentNavigateToPath = this.navigateToPath;
            
            const CustomPacklistModalContent = {
                inject: ['$modal'],
                props: {
                    navigateToPath: Function,
                    templateName: {
                        type: String,
                        default: 'TEMPLATE'
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
                        <div v-if="templateName === 'TEMPLATE'" class="card yellow">
                            <p><strong>Note:</strong> To attach a new packlist to a show, cancel and use "Create Show Packlist". <br> <em>This packlist will not be visible when packlists are filtered by the production schedule.</em></p>
                        </div>
                        <div v-else class="card">
                            <p><strong>Duplicating:</strong> {{ templateName }}</p>
                        </div>
                        <div style="margin-bottom: 1rem;">
                            <label for="packlistNameInput" style="display: block; margin-bottom: 0.5rem; font-weight: bold;">
                                {{ templateName === 'TEMPLATE' ? 'Packlist Name:' : 'New Packlist Name:' }}
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
                { modalClass: 'reading-menu', navigateToPath: parentNavigateToPath, templateName: templateName },
                templateName === 'TEMPLATE' ? 'Create Custom Packlist' : 'Duplicate As Custom Packlist'
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





export const PacklistContent = {
    components: {
        'packlist-table': PacklistTable,
        'cards-grid': CardsComponent,
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
            autoSavedPacklists: new Set(), // Track which packlists have auto-saved data
            filter: null, // Filter for schedule overlaps (date range or identifier)
            pinnedPacklists: new Set() // Track which packlists are pinned
        };
    },
    computed: {
        pathSegments() {
            // Strip query parameters before splitting
            const cleanPath = this.containerPath.split('?')[0];
            return cleanPath.split('/').filter(segment => segment.length > 0);
        },
        currentView() {
            // For packlist paths, the view is always 'packlist'
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
            return !!this.currentPacklist && this.currentPacklist !== 'packlist' && this.currentPacklist !== 'pins';
        },
        // Check if we're viewing pinned cards based on URL
        showPinnedOnly() {
            return this.pathSegments[1] === 'pins';
        },
        // Computed properties for cards grid
        availablePacklists() {
            if (!this.packlistsStore) return [];
            
            const tabs = this.packlistsStore.data || [];
            
            // Add explicit dependency on analysis state to trigger reactivity
            // when analysis completes (including lock info analysis)
            const isAnalyzing = this.packlistsStore.isAnalyzing;
            const analysisProgress = this.packlistsStore.analysisProgress;
            
            // Filter for pinned cards if showPinnedOnly is true
            const filteredTabs = this.showPinnedOnly
                ? tabs.filter(tab => this.pinnedPacklists.has(tab.title))
                : tabs;
            
            // Format tabs for CardsComponent
            return filteredTabs.map(tab => this.formatPacklistCard(tab));
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
                    // Apply "Show All" filter when viewing pinned cards
                    this.filter = { type: 'show-all' };
                    this.recreateStore();
                }
            },
            immediate: true
        }
    },
    async mounted() {
        // Load pinned packlists from user data
        await this.loadPinnedPacklists();

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
            components: [PacklistMenuComponent, DashboardToggleComponent],
            props: {
                refreshCallback: this.handleRefresh,
                navigateToPath: this.navigateToPath,
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
                // Handle year selection
                filter.startDate = searchData.startDate;
                filter.endDate = searchData.endDate;
                filter.byShowDate = true;
            } else {
                // Handle saved search - parse dateFilter parameter
                if (searchData.dateFilter) {
                    const dateFilter = parsedateFilterParameter(searchData.dateFilter);
                    Object.assign(filter, dateFilter);
                }
                
                // Add byShowDate flag if present
                if (searchData.byShowDate) {
                    filter.byShowDate = true;
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
                createAnalysisConfig(
                    Requests.getPacklistDescription,
                    'description',
                    'Loading packlist details...',
                    ['title'], // Use title as the source (project identifier)
                    [],
                    'description' // Store result in 'description' column
                ),
                createAnalysisConfig(
                    Requests.getShowDetails,
                    'showDetails',
                    'Loading show details...',
                    ['title'], // Use title as the source (project identifier)
                    [],
                    'showDetails' // Store entire show row in 'showDetails' column
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
        formatPacklistCard(tab) {
            console.log(`[PacklistContent.formatPacklistCard] Formatting card for "${tab.title}", lockInfo:`, tab.lockInfo);
            // Find any reactive stores for this packlist (regardless of analysis config)
            const matchingStores = findMatchingStores(
                Requests.getPackList,
                [tab.title]
            );
            
            // If a reactive store exists, use its state. Otherwise check userData for auto-save
            const hasUnsavedChanges = matchingStores.length > 0
                ? matchingStores.some(match => match.isModified)
                : this.autoSavedPacklists.has(tab.title);
            
            // Check if the packlist is locked
            const isLocked = tab.lockInfo && tab.lockInfo !== null;
            console.log(`[PacklistContent.formatPacklistCard] "${tab.title}" - isLocked: ${isLocked}, hasUnsavedChanges: ${hasUnsavedChanges}`);
            
            // Determine card styling based on lock state and unsaved changes
            // Priority: locked (white) > unsaved changes (red) > normal (gray)
            const cardClass = isLocked ? 'white' : (hasUnsavedChanges ? 'red' : 'gray');
            console.log(`[PacklistContent.formatPacklistCard] "${tab.title}" - cardClass: ${cardClass}`);
            
            // Build content footer
            let contentFooter = undefined;
            if (isLocked) {
                const lockOwner = tab.lockInfo.user || 'Unknown';
                const username = lockOwner.includes('@') ? lockOwner.split('@')[0] : lockOwner;
                contentFooter = `Locked for edit by: ${username}`;
            } else if (hasUnsavedChanges) {
                contentFooter = 'Unsaved changes';
            }
            
            // Build content with ship date first, then description
            let content = '';
            
            // Add ship date first if available (use <br> to match description format)
            if (tab.showDetails && tab.showDetails.Ship) {
                content = `Ship Date: ${tab.showDetails.Ship}`;
            } else if (tab.description && !tab.showDetails) {
                // Show details analysis not complete yet
                content = 'Ship Date: ...';
            }
            
            // Add description after ship date
            const description = tab.description || '...';
            if (content) {
                content += `<br>${description}`;
            } else {
                content = description;
            }

            if (!tab.description && !(this.packlistsStore.isAnalyzing || this.packlistsStore.isLoading)) {
                this.packlistsStore.runConfiguredAnalysis();
            }

            return {
                id: tab.sheetId,
                title: tab.title,
                content: content,
                cardClass: cardClass,
                contentFooter: contentFooter
            };
        },
        async checkAutoSavedPacklists() {
            if (!authState.isAuthenticated || !authState.user?.email || !this.packlistsStore?.data) return;
            
            console.log('[PacklistContent] Checking auto-saved packlists...');
            
            try {
                // Clear the set before checking to avoid stale entries
                this.autoSavedPacklists.clear();
                
                // Check each individual packlist for auto-saved data
                for (const tab of this.packlistsStore.data) {
                    if (tab.title === 'TEMPLATE') continue;
                    
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
                        console.log(`[PacklistContent] Found auto-save for: ${tab.title}`);
                        this.autoSavedPacklists.add(tab.title);
                    }
                }
                
                console.log('[PacklistContent] Auto-saved packlists:', Array.from(this.autoSavedPacklists));
            } catch (error) {
                console.error('[PacklistContent] Error checking auto-saved packlists:', error);
            }
        },
        async handleRefresh() {
            console.log('PacklistContent: Refresh requested');
            // Invalidate the getTabs cache to force reload
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['PROD_SCHED', 'ProductionSchedule'] }, // Ensure schedule data is fresh, but don't refresh client and show ref data
                { namespace: 'database', methodName: 'getTabs', args: ['PACK_LISTS'] }
            ], true);
            
            // If viewing a packlist table, refresh its lock status
            if (this.$refs.packlistTable) {
                await this.$refs.packlistTable.checkLockStatus();
            }
        },
        handlePacklistSelect(packlistName) {
            this.navigateToPath('packlist/' + packlistName);
        },
        async loadPinnedPacklists() {
            if (!authState.isAuthenticated || !authState.user?.email) return;
            
            try {
                const pinnedData = await Requests.getUserData(authState.user.email, 'pinned_packlists');
                if (pinnedData && Array.isArray(pinnedData)) {
                    this.pinnedPacklists = new Set(pinnedData);
                    console.log('[PacklistContent] Loaded pinned packlists:', Array.from(this.pinnedPacklists));
                }
            } catch (error) {
                console.error('[PacklistContent] Error loading pinned packlists:', error);
            }
        },
        async savePinnedPacklists() {
            if (!authState.isAuthenticated || !authState.user?.email) return;
            
            try {
                const pinnedArray = Array.from(this.pinnedPacklists);
                await Requests.storeUserData(pinnedArray, authState.user.email, 'pinned_packlists');
                console.log('[PacklistContent] Saved pinned packlists:', pinnedArray);
            } catch (error) {
                console.error('[PacklistContent] Error saving pinned packlists:', error);
            }
        },
        async togglePin(packlistName) {
            if (this.pinnedPacklists.has(packlistName)) {
                this.pinnedPacklists.delete(packlistName);
            } else {
                this.pinnedPacklists.add(packlistName);
            }
            await this.savePinnedPacklists();
        },
        togglePinnedView() {
            // Navigate between packlist and packlist/pins
            if (this.showPinnedOnly) {
                this.navigateToPath('packlist');
            } else {
                this.navigateToPath('packlist/pins');
            }
        }
    },
    template: html `
        <slot>
            <cards-grid
                v-if="!isViewingPacklist"
                :show-header="true"
                :show-search="true"
                :sync-search-with-url="true"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
                :show-refresh="true"
                :items="availablePacklists"
                :on-item-click="handlePacklistSelect"
                :is-loading="isLoading"
                :is-analyzing="isAnalyzing"
                :loading-progress="loadingProgress"
                :loading-message="analysisMessage"
                :empty-message="packlistsStore ? (showPinnedOnly ? 'No pinned packlists' : 'No packlists available') : ''"
                :show-pin-buttons="true"
                :pinned-items="pinnedPacklists"
                :show-pinned-only="showPinnedOnly"
                @refresh="handleRefresh"
                @toggle-pin="togglePin"
            >
                <template #header-area>
                    <div class="button-bar">
                        <ScheduleFilterSelect
                            v-if="!showPinnedOnly"
                            :domain="'production_schedule'"
                            :include-years="true"
                            :start-year="2023"
                            :default-search="String(new Date().getFullYear())"
                            :allow-show-all="true"
                            :container-path="containerPath"
                            :navigate-to-path="navigateToPath"
                            :show-advanced-button="true"
                            @search-selected="handleSearchSelected"
                        />
                        <button @click="togglePinnedView" :class="{ 'active': showPinnedOnly }">
                            {{ showPinnedOnly ? 'All Packlists' : 'Pins' }}
                            <span v-if="!showPinnedOnly" class="material-symbols-outlined">keep</span>
                        </button>
                    </div>
                </template>
            </cards-grid>
            
            <!-- Individual Packlist View (Read-only or Edit mode) -->
            <packlist-table 
                ref="packlistTable"
                v-else-if="!isDetailsView"
                :tab-name="currentPacklist"
                :container-path="containerPath"
                @navigate-to-path="navigateToPath"
            />
            
            <!-- Packlist Details View (Summary Table Only) -->
            <PacklistItemsSummary 
                v-else-if="isDetailsView"
                :project-identifier="currentPacklist"
                :container-path="containerPath"
                @navigate-to-path="navigateToPath"
            />
        </slot>
    `
};