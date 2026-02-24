import { html } from './index.js';
import { ContainerComponent } from './index.js';
import { ModalComponent, modalManager } from './index.js';
import { PrimaryNavComponent } from './index.js';
import { Auth, authState } from './index.js';
import { NavigationRegistry } from './index.js';
import { PacklistContent, InventoryContent, ScheduleContent} from './index.js';
import { hamburgerMenuRegistry } from './index.js';
import { undoRegistry } from './index.js';
import { Requests, getReactiveStore } from './index.js';

const { createApp } = Vue;

// Vue app with inline template
const App = {
    components: {
        'app-container': ContainerComponent,
        'app-modal': ModalComponent,
        'primary-nav': PrimaryNavComponent,
        'packlist-content': PacklistContent,
        'inventory-content': InventoryContent,
        'schedule-content': ScheduleContent,
    },
    provide() {
        return {
            appContext: this,
            hamburgerMenuRegistry: hamburgerMenuRegistry,
            $modal: modalManager
        };
    },
    data() {
        return {
            appLoading: true,
            appLoadingMessage: 'Loading application...',
            isMenuOpen: false,
            navigationItems: NavigationRegistry.primaryNavigation,
            currentPath: 'dashboard',
            modals: [],
            currentYear: new Date().getFullYear(),
            globalLocksStore: null // Global reactive store for ALL locks
        };
    },
    computed: {
        // Derive current page from currentPath (strip query params first)
        currentPage() {
            const cleanPath = this.currentPath.split('?')[0];
            return cleanPath.split('/')[0];
        },
        // Make auth state reactive in the component
        isAuthenticated() {
            return authState.isAuthenticated;
        },
        currentUser() {
            return authState.user;
        },
        isAuthLoading() {
            return authState.isLoading;
        },
        authError() {
            return authState.error;
        },
        dashboardLoading() {
            return NavigationRegistry.dashboardRegistry.isLoading;
        },
        // Check if dashboard is doing initial load (triggers app loading indicator)
        isDashboardInitialLoad() {
            return NavigationRegistry.dashboardRegistry.isInitialLoad;
        },
        // Reactive containers based on current page and authentication state
        containers() {
            if (!authState.isAuthenticated) {
                return [];
            }
            
            if (this.currentPage === 'dashboard') {
                const containers = NavigationRegistry.dashboardRegistry.containers || [];
                return containers.map(container => {
                    const containerId = typeof container === 'string' ? container : container.path;
                    const containerClasses = typeof container === 'string' ? '' : (container.classes || '');
                    const type = NavigationRegistry.getTypeFromPath(containerId);
                    return {
                        key: `${type}-${containerId.replace(/[^a-zA-Z0-9]/g, '_')}`,
                        path: containerId,
                        type,
                        title: NavigationRegistry.getDisplayName(containerId),
                        containerPath: containerId,
                        cardStyle: true,
                        cardClasses: ` ${containerClasses}`,
                        showExpandButton: true,
                        isOnDashboard: true
                    };
                });
            } else {
                const type = NavigationRegistry.getTypeFromPath(this.currentPath);
                return [{
                    key: `${type}-${this.currentPath.replace(/[^a-zA-Z0-9]/g, '_')}`,
                    path: this.currentPath,
                    type,
                    title: NavigationRegistry.getDisplayName(this.currentPath),
                    containerPath: this.currentPath,
                    cardStyle: false,
                    cardClasses: '',
                    showExpandButton: false,
                    isOnDashboard: NavigationRegistry.dashboardRegistry.has(this.currentPath)
                }];
            }
        }
    },
    async mounted() {
        // Initialize authentication on app mount
        await Auth.initialize();

        // Initialize URL routing system
        NavigationRegistry.initializeURLRouting(this);
        
        // Add keyboard shortcuts for undo/redo
        document.addEventListener('keydown', this.handleGlobalKeyDown);

        // Pass the reactive modals array to modalManager for all modal operations
        modalManager.setReactiveModals(this.modals);

        if (this.isAuthenticated) {
            // Initialize dashboard registry if authenticated
            NavigationRegistry.initializeDashboard();
            
            // Initialize global locks store
            this.globalLocksStore = getReactiveStore(
                Requests.getAllLocks,
                null,
                []
            );
            //console.log('[App] Initialized global locks store');
            
            // Watch for locks data changes
            this.$watch(() => this.globalLocksStore?.data, (locks) => {
                //console.log('[App] Global locks data:', locks);
            }, { immediate: true, deep: true });
            
            // Apply current URL state if user is already authenticated
            const currentUrl = NavigationRegistry.urlRouter.getCurrentURLPath();
            if (currentUrl && currentUrl !== 'dashboard') {
                await NavigationRegistry.handleNavigateToPath({ 
                    targetPath: currentUrl, 
                    isBrowserNavigation: true 
                }, this);
            }
        }
        
        // Watch for auth state changes
        this.$watch('isAuthenticated', async (newVal) => {
            if (newVal) {
                NavigationRegistry.initializeDashboard();
                
                // Initialize global locks store on login
                if (!this.globalLocksStore) {
                    this.globalLocksStore = getReactiveStore(
                        Requests.getAllLocks,
                        null,
                        []
                    );
                    //console.log('[App] Initialized global locks store on login');
                    
                    // Watch for locks data changes
                    this.$watch(() => this.globalLocksStore?.data, (locks) => {
                        //console.log('[App] Global locks data:', locks);
                    }, { immediate: true, deep: true });
                }
                
                // Apply current URL when user logs in
                const currentUrl = NavigationRegistry.urlRouter.getCurrentURLPath();
                if (currentUrl && currentUrl !== 'dashboard') {
                    await NavigationRegistry.handleNavigateToPath({ 
                        targetPath: currentUrl, 
                        isBrowserNavigation: true 
                    }, this);
                }
            }
        });

        // Watch for path changes to reset scroll position
        this.$watch(() => this.currentPath, (newPath, oldPath) => {
            this.$nextTick(() => {
                const appContent = document.querySelector('#app-content');
                if (!appContent) return;
                
                // Strip query parameters for page comparison
                const newCleanPath = newPath.split('?')[0];
                const oldCleanPath = oldPath.split('?')[0];
                const newPage = newCleanPath.split('/')[0];
                const oldPage = oldCleanPath.split('/')[0];
                
                // Check if navigating TO dashboard FROM a page that's ON the dashboard
                if (newPage === 'dashboard' && oldPage !== 'dashboard' && oldCleanPath && oldCleanPath !== 'dashboard') {
                    const isOnDashboard = NavigationRegistry.dashboardRegistry.has(oldCleanPath);
                    
                    if (isOnDashboard) {
                        const containerType = NavigationRegistry.getTypeFromPath(oldPath);
                        const containerId = `${containerType}-${oldPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
                        const containerElement = appContent.querySelector(`[data-container-id="${containerId}"]`);
                        
                        if (containerElement) {
                            // Get element position relative to the scrollable container
                            const elementTop = containerElement.offsetTop;
                            // Calculate offset from CSS variables (navbar height + padding)
                            const computedStyle = getComputedStyle(document.documentElement);
                            const navbarHeight = parseInt(computedStyle.getPropertyValue('--navbar-height')) || 0;
                            const paddingLg = parseInt(computedStyle.getPropertyValue('--padding-lg')) || 0;
                            const scrollOffset = navbarHeight + paddingLg;
                            // Scroll to position with dynamic offset
                            appContent.scrollTo({ top: elementTop - scrollOffset, behavior: 'smooth' });
                        } else {
                            appContent.scrollTop = 0;
                        }
                    } else {
                        appContent.scrollTop = 0;
                    }
                } else {
                    // For all other navigation, scroll to top
                    appContent.scrollTop = 0;
                }
            });
        });

        this.appLoading = false;
    },
    beforeUnmount() {
        // Clean up event listener
        document.removeEventListener('keydown', this.handleGlobalKeyDown);
        
        // Save any pending dashboard changes before unmounting
        NavigationRegistry.dashboardRegistry.saveNow();
    },
    methods: {
        toggleMenu() {
            this.isMenuOpen = !this.isMenuOpen;
        },
        async login() {
            try {
                Auth.login();
            } catch (error) {
                console.error('Login error:', error);
                modalManager.error('Failed to log in. Please check your credentials and try again.', 'Login Error');
            }
        },
        async logout() {
            try {
                await Auth.logout();
                console.log('Logout successful');
                // Containers will update automatically via watcher
            } catch (error) {
                console.error('Logout error:', error);
                modalManager.error('Failed to log out. Please try again or refresh the page.', 'Logout Error');
            }
        },
        navigateToPath(targetPath) {
            // Only accept string paths for simplicity
            // Don't await - let navigation happen asynchronously
            NavigationRegistry.handleNavigateToPath({ targetPath }, this);
        },
        
        // Handle container expansion by navigating to its path
        expandContainer(containerData) {
            // containerPath already contains the full path with parameters
            const targetPath = containerData.containerPath || containerData.path;
            this.navigateToPath(targetPath);
        },

        async toggleDashboardPresence(containerData) {
            if (NavigationRegistry.dashboardRegistry.has(containerData.containerPath)) {
                await NavigationRegistry.dashboardRegistry.remove(containerData.containerPath);
            } else {
                await NavigationRegistry.dashboardRegistry.add(containerData.containerPath);
            }
        },
        
        handleGlobalKeyDown(event) {
            // Ctrl+Z or Cmd+Z for undo
            if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
                event.preventDefault();
                undoRegistry.undo();
            }
            // Ctrl+Y or Ctrl+Shift+Z or Cmd+Shift+Z for redo
            else if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.shiftKey && event.key === 'z'))) {
                event.preventDefault();
                undoRegistry.redo();
            }
        },
    },
    setup() {
        return { modalManager };
    },
    template: html `
        <div id="app">
            <!-- Primary Navigation Component -->
            <primary-nav
                :is-menu-open="isMenuOpen"
                :navigation-items="navigationItems"
                :current-path="currentPath"
                :is-authenticated="isAuthenticated"
                :is-auth-loading="isAuthLoading"
                :current-user="currentUser"
                @toggle-menu="toggleMenu"
                @navigate-to-path="navigateToPath"
                @login="login"
                @logout="logout">
            </primary-nav>

            <div id="app-content" :class="{ 'dashboard': currentPage === 'dashboard' }">

                <div v-if="authError" class="empty-message" style="color: var(--color-text);">
                    <div class="card red"><strong>Error: </strong>{{ authError }} </div>
                </div>
                <div v-else-if="!isAuthenticated" class="empty-message">
                    please log in to view content
                </div>
                
                <!-- App loading indicator -->
                <div v-else-if="appLoading || (isDashboardInitialLoad && currentPage === 'dashboard')" :class="'container' + (currentPage === 'dashboard' ? ' dashboard-card' : '')" style="display:flex; align-items: center; justify-content: center;">
                    <div class="loading-message">
                        <img src="images/loading.gif" alt="..."/>
                        <p>{{ isDashboardInitialLoad ? 'Loading dashboard...' : appLoadingMessage }}</p>
                    </div>
                </div>


                <!-- Dashboard loading indicators >
                <div v-else-if="dashboardLoading && currentPage === 'dashboard'" class="container dashboard-card" style="display:flex; align-items: center; justify-content: center;">
                    <div class="loading-message">
                        <img src="images/loading.gif" alt="..."/>
                        <p>loading dashboard...</p>
                    </div>
                </div-->

                <!-- No containers message -->
                <div v-else-if="containers.length === 0" class="empty-message">
                    open a page to see content
                </div>
                
                <!-- Reactive containers -->
                <template v-else>
                    <app-container 
                        v-for="container in containers" 
                        :key="container.key"
                        :data-container-id="container.key"
                        :container-id="container.key"
                        :container-type="container.type"
                        :title="container.title"
                        :container-path="container.containerPath"
                        :card-style="container.cardStyle"
                        :card-classes="container.cardClasses"
                        :show-expand-button="container.showExpandButton"
                        :pinned-to-dashboard="container.isOnDashboard"
                        @navigate-to-path="navigateToPath"
                        @expand-container="expandContainer"
                        @toggle-dashboard-state="toggleDashboardPresence"
                    >
                        <template #content>
                            <!-- Inventory Content -->
                            <inventory-content 
                                v-if="container.type === 'inventory' || container.containerPath?.startsWith('inventory')"
                                :container-path="container.containerPath"
                                :navigate-to-path="(path, params) => navigateToPath(params ? NavigationRegistry.buildPath(path, params) : path)"
                            >
                            </inventory-content>
                            <!-- Packlist Content -->
                            <packlist-content 
                                v-else-if="container.type === 'packlist' || container.containerPath?.startsWith('packlist')"
                                :container-path="container.containerPath"
                                :navigate-to-path="(path, params) => navigateToPath(params ? NavigationRegistry.buildPath(path, params) : path)"
                            >
                            </packlist-content>
                            
                            <!-- Schedule Content -->
                            <schedule-content 
                                v-else-if="container.type === 'schedule' || container.containerPath?.startsWith('schedule')"
                                :container-path="container.containerPath"
                                :navigate-to-path="(path, params) => navigateToPath(params ? NavigationRegistry.buildPath(path, params) : path)">
                            </schedule-content>
                        </template>
                    </app-container>
                </template>

                <footer>
                    <p>
                        &copy; {{ currentYear }} Top Shelf Exhibits
                        <br>
                        <a href="https://topshelfexhibits.com">www.topshelfexhibits.com</a>
                    </p>
                </footer>
            </div>
            <!-- Modal Space -->
            <div id="modal-space">
                <transition-group name="fade">
                    <app-modal 
                        v-for="modal in modals" 
                        :key="modal.id"
                        :modal-id="modal.id"
                        :title="modal.title"
                        :is-visible="modal.isVisible"
                        :components="modal.components"
                        :modal-class="modal.modalClass"
                        :message="modal.message"
                        :content-class="modal.contentClass"
                        :component-props="modal.componentProps"
                        @close-modal="modalManager.removeModal(modal.id)"
                    ></app-modal>
                </transition-group>
            </div>
        </div>
    `
};

// Initialize the app
const app = createApp(App);
app.mount('body');

// Expose rate limit testing utility to console
// Import GoogleSheetsService dynamically to access the rate limit flag
import('../google_sheets_services/GoogleSheetsData.js').then(module => {
    const GoogleSheetsService = module.GoogleSheetsService;
    
    /**
     * Toggle rate limit simulation for testing
     * @param {boolean} [enabled] - If provided, sets the state. If omitted, toggles current state.
     * @returns {boolean} - Current state after toggle
     * 
     * Usage:
     *   window.toggleRateLimitTest()      // Toggle on/off
     *   window.toggleRateLimitTest(true)  // Force enable
     *   window.toggleRateLimitTest(false) // Force disable
     */
    window.toggleRateLimitTest = function(enabled) {
        if (enabled === undefined) {
            GoogleSheetsService._simulateRateLimit = !GoogleSheetsService._simulateRateLimit;
        } else {
            GoogleSheetsService._simulateRateLimit = !!enabled;
        }
        
        const state = GoogleSheetsService._simulateRateLimit;
        console.log(
            `%c🚨 Rate Limit Simulation: ${state ? 'ENABLED' : 'DISABLED'}`,
            `font-size: 14px; font-weight: bold; color: ${state ? '#ff4444' : '#44ff44'}`
        );
        
        if (state) {
            console.warn(
                '%cAll Google Sheets API calls will now throw 429 errors!\n' +
                'To disable: toggleRateLimitTest(false)',
                'font-size: 12px; color: #ff8800'
            );
        }
        
        return state;
    };
    
    console.log(
        '%c💡 Rate Limit Testing Available',
        'font-size: 12px; color: #4488ff; font-weight: bold'
    );
    console.log(
        'Use window.toggleRateLimitTest() to simulate 429 rate limit errors\n' +
        'Usage:\n' +
        '  toggleRateLimitTest()       - Toggle on/off\n' +
        '  toggleRateLimitTest(true)   - Enable simulation\n' +
        '  toggleRateLimitTest(false)  - Disable simulation'
    );
});