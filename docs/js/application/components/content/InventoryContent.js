import { html, InventoryTableComponent, hamburgerMenuRegistry, NavigationRegistry, Requests, CardsComponent, DashboardToggleComponent, getReactiveStore, findMatchingStores, createAnalysisConfig, generateStoreKey, authState, invalidateCache } from '../../index.js';
import { InventoryOverviewTableComponent } from './InventoryOverviewTable.js';
import { ShowInventoryReport } from './ShowInventoryReport.js';

// Inventory Hamburger Menu Component (content only)
export const InventoryMenuComponent = {
    props: {
        containerPath: String,
        containerType: String, 
        currentView: String,
        title: String,
        refreshCallback: Function,
        getLockInfo: Function,
        navigateToPath: Function,
        tabTitle: String
    },
    inject: ['$modal'],
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
        menuItems() {
            const items = [];
            
            // Add lock removal option if lock exists and fully loaded
            if (!this.isLoadingLockInfo && this.lockInfo) {
                items.push({ 
                    label: this.isRemovingLock ? 'Removing lock...' : `Remove lock: ${this.lockOwnerUsername}`, 
                    action: 'removeLock',
                    class: this.isRemovingLock ? 'analyzing' : 'warning',
                    disabled: this.isRemovingLock
                });
            }
            
            // Navigation items
            items.push(
                { label: 'Inventory Overview', action: 'navigateHome' },
                { label: 'Categories', action: 'navigateCategories' },
                { label: 'Reports', action: 'navigateReports' }
            );
            
            return items;
        }
    },
    methods: {
        async fetchLockInfo() {
            this.isLoadingLockInfo = true;
            try {
                if (this.getLockInfo) {
                    this.lockInfo = await this.getLockInfo();
                    //console.log('[InventoryMenu] Fetched lock info:', this.lockInfo);
                }
            } catch (error) {
                console.error('[InventoryMenu] Error fetching lock info:', error);
            } finally {
                this.isLoadingLockInfo = false;
            }
        },
        async handleAction(action) {
            switch (action) {
                case 'navigateHome':
                    if (this.navigateToPath) {
                        this.navigateToPath('inventory');
                        this.$emit('close-modal');
                    }
                    break;
                case 'removeLock':
                    await this.handleRemoveLock();
                    break;
                case 'navigateCategories':
                    if (this.navigateToPath) {
                        this.navigateToPath('inventory/categories');
                        this.$emit('close-modal');
                    }
                    break;
                case 'navigateReports':
                    if (this.navigateToPath) {
                        // If on a specific category, pass it as a filter
                        if (this.tabTitle) {
                            const reportsPath = NavigationRegistry.buildPath(
                                'inventory/reports',
                                { itemCategoryFilter: this.tabTitle }
                            );
                            this.navigateToPath(reportsPath);
                        } else {
                            this.navigateToPath('inventory/reports');
                        }
                        this.$emit('close-modal');
                    }
                    break;
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
                        //console.log(`[InventoryContent.removeLock] About to call forceUnlockSheet for ${tabName}`);
                        const result = await Requests.forceUnlockSheet('INVENTORY', tabName, 'User requested via hamburger menu');
                        //console.log(`[InventoryContent.removeLock] forceUnlockSheet returned:`, result);
                        
                        if (result.success) {
                            // Cache is automatically invalidated by the mutation method
                            // Just refresh the UI to fetch fresh data
    
                            this.$modal.alert(
                                `Lock removed successfully.\n\nPreviously locked by: ${username}\nAutosave entries backed up: ${result.backupCount}\nAutosave entries deleted: ${result.deletedCount}`,
                                'Success',
                                false
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
                        console.error('[InventoryMenu] Error removing lock:', error);
                        this.$modal.error(`Error removing lock: ${error.message}`, 'Error');
                    } finally {
                        this.isRemovingLock = false;
                    }
                },
                () => {},
                'Confirm Force Unlock',
                'Force Unlock'
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

export const InventoryContent = {
    components: {
        'inventory-table': InventoryTableComponent,
        'inventory-overview-table': InventoryOverviewTableComponent,
        'cards-grid': CardsComponent,
        'show-inventory-report': ShowInventoryReport
    },
    props: {
        containerPath: {
            type: String,
            default: 'inventory'
        },
        navigateToPath: Function,
    },
    inject: ['$modal'],
    data() {
        return {
            categoriesStore: null, // Reactive store for inventory categories
            autoSavedCategories: new Set() // Track which categories have auto-saved data
        };
    },
    computed: {
        // Centralized clean path without parameters
        cleanContainerPath() {
            return this.containerPath.split('?')[0];
        },
        categoryList() {
            // Return loaded categories from store with formatted title
            const categories = this.categoriesStore?.data || [];
            
            // Add explicit dependency on analysis state to trigger reactivity
            // when analysis completes (including lock info analysis)
            const isAnalyzing = this.categoriesStore?.isAnalyzing;
            const analysisProgress = this.categoriesStore?.analysisProgress;
            
            return categories
                .filter(cat => cat.title !== 'INDEX')
                .map(cat => {
                    const categoryTitle = cat.title ? cat.title.charAt(0).toUpperCase() + cat.title.slice(1).toLowerCase() : '';
                    
                    // Find any reactive stores for this inventory category (regardless of analysis config)
                    // Note: Stores are created with [tabTitle, undefined, undefined] where tabTitle is uppercase
                    const matchingStores = findMatchingStores(
                        Requests.getInventoryTabData,
                        [cat.title, undefined, undefined]
                    );
                    
                    // If a reactive store exists, use its state. Otherwise check userData for auto-save
                    const hasUnsavedChanges = matchingStores.length > 0
                        ? matchingStores.some(match => match.isModified)
                        : this.autoSavedCategories.has(cat.title);
                    
                    // Check if the category is locked
                    const isLocked = cat.lockInfo && cat.lockInfo !== null;
                    
                    // Determine card styling based on lock state and unsaved changes
                    // Priority: locked (white) > unsaved changes (red) > normal (purple)
                    const cardClass = isLocked ? 'button white' : (hasUnsavedChanges ? 'button red' : 'button purple');
                    
                    // Build content footer
                    let contentFooter = undefined;
                    if (isLocked) {
                        const lockOwner = cat.lockInfo.user || 'Unknown';
                        const username = lockOwner.includes('@') ? lockOwner.split('@')[0] : lockOwner;
                        contentFooter = `Locked for edit by: ${username}`;
                    } else if (hasUnsavedChanges) {
                        contentFooter = 'Unsaved changes';
                    }
                    
                    return {
                        id: cat.sheetId,
                        title: categoryTitle,
                        originalTitle: cat.title, // Keep original uppercase tab name
                        cardClass: cardClass,
                        contentFooter: contentFooter,
                        AppData: cat.AppData // Pass through AppData for analyzing state
                    };
                });
        },
        // Get current category name from path for specific category views
        currentCategoryName() {
            if (this.cleanContainerPath.startsWith('inventory/categories/')) {
                const categorySlug = this.cleanContainerPath.replace('inventory/categories/', '');
                const match = this.categoryList.find(c => {
                    return c.title.toLowerCase() === categorySlug.toLowerCase();
                });
                return match ? match.originalTitle : categorySlug.toUpperCase();
            }
            return '';
        },
        isLoadingCategories() {
            return this.categoriesStore?.isLoading || false;
        }
    },
    watch: {
        // Watch for when categories data is loaded and check for auto-saved data
        'categoriesStore.data': {
            handler(newData) {
                if (newData && newData.length > 0 && !this.categoriesStore.isLoading) {
                    this.checkAutoSavedCategories();
                }
            },
            deep: false
        }
    },
    methods: {
        async checkAutoSavedCategories() {
            if (!authState.isAuthenticated || !authState.user?.email || !this.categoriesStore?.data) return;
            
            try {
                // Check each individual category for auto-saved data
                for (const cat of this.categoriesStore.data) {
                    if (cat.title === 'INDEX') continue;
                    
                    // Generate the store key prefix (without analysis config)
                    const storeKeyPrefix = generateStoreKey(
                        Requests.getInventoryTabData,
                        Requests.saveInventoryTabData,
                        [cat.title, undefined, undefined],
                        null
                    ).substring(0, generateStoreKey(Requests.getInventoryTabData, Requests.saveInventoryTabData, [cat.title, undefined, undefined], null).lastIndexOf(':'));
                    
                    // Check if this specific key exists (prefix match since analysis config might vary)
                    const hasAutoSave = await Requests.hasUserDataKey(
                        authState.user.email,
                        storeKeyPrefix,
                        true // prefix match
                    );
                    
                    if (hasAutoSave) {
                        this.autoSavedCategories.add(cat.title);
                    }
                }
            } catch (error) {
                console.error('[InventoryContent] Error checking auto-saved categories:', error);
            }
        },
        handleCategorySelect(categoryTitle) {
            this.navigateToPath('inventory/categories/' + categoryTitle.toLowerCase());
        },
        async handleRefresh() {
            console.log('InventoryContent: Refresh requested');
            // Invalidate the categories store cache to force reload with fresh lock status
            invalidateCache([
                { namespace: 'database', methodName: 'getTabs', args: ['INVENTORY'] }
            ], true);
            
            // If viewing an inventory table, refresh its lock status
            if (this.$refs.inventoryTable) {
                await this.$refs.inventoryTable.checkLockStatus();
            }
        }
    },
    async mounted() {
        // Initialize categories store with lock analysis
        const analysisConfig = [
            createAnalysisConfig(
                Requests.getInventoryLock,
                'lockInfo',
                'Checking lock status...',
                ['title'], // Extract tab name from 'title' column
                [authState.user?.email], // Pass current user to filter out their own locks
                'lockInfo' // Store lock info in 'lockInfo' column
            )
        ];
        
        this.categoriesStore = getReactiveStore(
            Requests.getAvailableTabs,
            null, // No save function
            ['INVENTORY'], // Arguments
            analysisConfig
        );
        
        // Note: checkAutoSavedCategories will be called by the watcher when data loads


        // Register inventory navigation routes
        NavigationRegistry.registerNavigation('inventory', {
            routes: {
                categories: {
                    displayName: 'Categories',
                    dashboardTitle: 'Inventory Categories',
                    icon: 'category',
                    children: {}
                },
                reports: {
                    displayName: 'Reports',
                    dashboardTitle: 'Inventory Reports',
                    icon: 'assessment',
                    children: {}
                }
            }
        });

        // Register hamburger menu for inventory
        hamburgerMenuRegistry.registerMenu('inventory', {
            components: [InventoryMenuComponent, DashboardToggleComponent],
            props: {
                refreshCallback: this.handleRefresh,
                navigateToPath: this.navigateToPath,
                getLockInfo: async () => {
                    // Get lock info from the current category if we're viewing one
                    const categoryName = this.currentCategoryName;
                    //console.log('[InventoryContent] getLockInfo called:', { 
                    //    categoryName,
                    //    cleanPath: this.cleanContainerPath,
                    //    hasStore: !!this.categoriesStore,
                    //    storeData: this.categoriesStore?.data?.length
                    //});
                    
                    if (!categoryName) return null;
                    
                    // Always fetch directly from API to ensure fresh lock status
                    // (bypasses store which may have stale analysis data)
                    //console.log('[InventoryContent] Fetching lock info directly for:', categoryName);
                    const lockInfo = await Requests.getInventoryLock(categoryName.toUpperCase());
                    //console.log('[InventoryContent] Lock info from API:', lockInfo);
                    return lockInfo;
                },
                tabTitle: this.currentCategoryName
            }
        });
    },
    template: html `
        <slot>
            <!-- Main Inventory View -->
            <slot v-if="cleanContainerPath === 'inventory'">
                <inventory-overview-table
                    :container-path="containerPath"
                    @navigate-to-path="navigateToPath"
                />
            </slot>
            
            <!-- Categories View -->
            <cards-grid
                v-else-if="cleanContainerPath === 'inventory/categories'"
                :items="categoryList"
                :on-item-click="handleCategorySelect"
                :is-loading="isLoadingCategories"
                loading-message="Loading..."
                empty-message="No categories available"
            />
            
            <!-- Specific Category View -->
            <inventory-table
                ref="inventoryTable"
                v-else-if="containerPath.startsWith('inventory/categories/') && currentCategoryName"
                :container-path="containerPath"
                :inventory-name="'Inventory: ' + currentCategoryName.toLowerCase()"
                :tab-title="currentCategoryName"
            ></inventory-table>

            <!-- Show Inventory Report View -->
            <show-inventory-report
                v-else-if="cleanContainerPath === 'inventory/reports'"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
            />
        </slot>
    `
};
