import { html } from './index.js';
import { ContainerComponent } from './index.js';
import { ModalComponent, modalManager } from './index.js';
import { PrimaryNavComponent } from './index.js';
import { Auth, authState } from './index.js';
import { NavigationRegistry } from './index.js';
import { PacklistContent, InventoryContent, ScheduleContent, ReportsContent } from './index.js';
import { hamburgerMenuRegistry } from './index.js';
import { undoRegistry } from './index.js';
import { Requests, getReactiveStore, appSettings, saveDirtyStoresToUserData } from './index.js';
import { BannerNotifications, NotificationBubbleOverlay, notificationBus } from './index.js';
import { isLocalhost } from '../data_management/utils/helpers.js';

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
        'reports-content': ReportsContent,
        BannerNotifications,
        NotificationBubbleOverlay,
    },
    provide() {
        return {
            appContext: this,
            appSettings: appSettings,
            hamburgerMenuRegistry: hamburgerMenuRegistry,
            $modal: modalManager,
            $notify: notificationBus
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
            globalLocksStore: null, // Global reactive store for ALL locks
            notificationBus: notificationBus, // Reference for reactivity
            updateAvailable: false // A newer version is deployed: editing is off until a refresh (assertAppCurrent)
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
        permissionsWarning() {
            return authState.permissionsWarning;
        },
        isOffline() {
            return authState.isOffline;
        },
        appBanners() {
            const staticBanners = [
                {
                    key: 'offline',
                    color: 'orange',
                    message: 'No network connection. Your data is preserved. Changes cannot be saved until connectivity is restored.',
                    visible: this.isOffline,
                    dismissible: false
                },
                {
                    key: 'permissions',
                    color: 'red',
                    message: `Login Issue: ${this.permissionsWarning}`,
                    visible: !!this.permissionsWarning,
                    dismissible: false,
                    action: {
                        label: 'Log Out',
                        fn: () => this.logout()
                    }
                },
                {
                    key: 'auth-error',
                    color: 'red',
                    message: `Error: ${this.authError}`,
                    visible: !!this.authError && !this.isAuthenticated,
                    dismissible: false
                },
                {
                    key: 'update-available',
                    color: 'orange',
                    message: 'A new version of the app is available. Editing is turned off until you refresh.',
                    visible: this.updateAvailable,
                    dismissible: false,
                    action: {
                        label: 'Refresh Now',
                        fn: () => this.refreshToLatest()
                    }
                }
            ];
            
            // Combine static banners with dynamic ones from the notification bus
            const dynamicBanners = this.notificationBus.getBanners('app') || [];
            return [...staticBanners, ...dynamicBanners];
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
                    // Key on the clean path: URL parameters (search, view, filters) update the page in
                    // place instead of rebuilding it. Shared links still carry the parameters.
                    return {
                        key: `${type}-${containerId.split('?')[0].replace(/[^a-zA-Z0-9]/g, '_')}`,
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
                // Key on the clean path (see above): parameter-only changes don't remount the page
                return [{
                    key: `${type}-${this.currentPath.split('?')[0].replace(/[^a-zA-Z0-9]/g, '_')}`,
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
        
        // A newer deploy turns editing off (data writes refuse: assertAppCurrent) until a refresh
        window.addEventListener('versionCheckResult', (event) => {
            this.updateAvailable = event.detail.outdated;
        });

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
            // Use resolvePathFromURL to expand short hashes since we're authenticated
            const currentUrl = await NavigationRegistry.urlRouter.resolvePathFromURL();
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

                // Restore saved bookmarks for this user
                const savedRaw = localStorage.getItem(`bookmarks_${authState.user?.email}`);
                if (savedRaw) {
                    try {
                        const saved = JSON.parse(savedRaw);
                        const restored = saved.map(b => ({
                            ...b,
                            visible: true,
                            action: { label: 'Return', fn: () => this.navigateToPath(b.bookmarkTarget) }
                        }));
                        this.notificationBus.setBanners('app', restored);
                    } catch (e) {
                        console.warn('[App] Failed to restore bookmarks:', e);
                    }
                }
                
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
                
                // Apply current URL when user logs in — resolve short hashes now that we are authenticated
                const currentUrl = await NavigationRegistry.urlRouter.resolvePathFromURL();
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

        // Watch for notification bus app-level changes to force computed to recalculate
        this.$watch(() => this.notificationBus.getBanners('app'), (newBanners) => {
            // Save bookmark banners to localStorage on every change
            if (authState.user?.email) {
                const bookmarks = (newBanners || [])
                    .filter(b => b.key?.startsWith('bookmark-') && b.bookmarkTarget)
                    .map(({ key, color, message, dismissible, bookmarkTarget }) => ({ key, color, message, dismissible, bookmarkTarget }));
                localStorage.setItem(`bookmarks_${authState.user.email}`, JSON.stringify(bookmarks));
            }
        }, { deep: true });

        this.appLoading = false;

        if (isLocalhost()) {
            import('../tests/fakeGoogleDevTools.js').then(devTools => {
                devTools.installFakeGoogleDevTools();
                if (devTools.autoTestsEnabled()) {
                    import('../tests/tests.js').then(m => m.runTests());
                }
            });
        }
    },
    beforeUnmount() {
        // Clean up event listener
        document.removeEventListener('keydown', this.handleGlobalKeyDown);
        
        // Save any pending dashboard changes before unmounting
        NavigationRegistry.dashboardRegistry.saveNow();
    },
    methods: {
        /**
         * Refresh onto the deployed version. Backs up unsaved edits (restored after the reload),
         * then re-downloads every file this page loaded, bypassing the browser cache: a plain
         * reload reuses cached modules for up to 10 minutes after a deploy (GitHub Pages max-age).
         */
        async refreshToLatest() {
            try {
                await saveDirtyStoresToUserData();
            } catch (error) {
                console.warn('[App] Backing up unsaved edits before the refresh failed:', error);
            }
            const files = performance.getEntriesByType('resource')
                .map(entry => entry.name)
                .filter(url => url.startsWith(location.origin) && /\.(js|css|html)(\?|$)/.test(url));
            const refetch = Promise.allSettled([location.href.split('#')[0], ...new Set(files)]
                .map(url => fetch(url, { cache: 'reload' })));
            await Promise.race([refetch, new Promise(resolve => setTimeout(resolve, 10000))]);
            window.location.reload();
        },
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
        navigateToPath(pathOrNavigationData, params = null) {
            let navigationData;

            if (typeof pathOrNavigationData === 'string') {
                const targetPath = params ? NavigationRegistry.buildPath(pathOrNavigationData, params) : pathOrNavigationData;
                navigationData = { targetPath };
            } else if (pathOrNavigationData && typeof pathOrNavigationData === 'object') {
                navigationData = { ...pathOrNavigationData };
            } else {
                return;
            }

            if (!navigationData.targetPath || typeof navigationData.targetPath !== 'string') {
                return;
            }

            // Don't await - let navigation happen asynchronously
            NavigationRegistry.handleNavigateToPath(navigationData, this);
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
                const alert = undoRegistry.undo();
                if (alert) modalManager.confirm(alert, () => {}, null, 'Note', 'OK', null, '');
            }
            // Ctrl+Y or Ctrl+Shift+Z or Cmd+Shift+Z for redo
            else if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.shiftKey && event.key === 'z'))) {
                event.preventDefault();
                const alert = undoRegistry.redo();
                if (alert) modalManager.confirm(alert, () => {}, null, 'Note', 'OK', null, '');
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
                <BannerNotifications :banners="appBanners" scope="app" />

                <div v-if="!isAuthenticated" class="empty-message">
                    please log in to view content
                </div>
                
                
                <!-- App loading indicator -->
                <div v-else-if="appLoading || (isDashboardInitialLoad && currentPage === 'dashboard')" :class="'container' + (currentPage === 'dashboard' ? ' dashboard-card' : '')" style="display:flex; align-items: center; justify-content: center;">
                    <div class="loading-message">
                        <img src="assets/loading.gif" alt="..."/>
                        <p>{{ isDashboardInitialLoad ? 'Loading dashboard...' : appLoadingMessage }}</p>
                    </div>
                </div>


                <!-- Dashboard loading indicators >
                <div v-else-if="dashboardLoading && currentPage === 'dashboard'" class="container dashboard-card" style="display:flex; align-items: center; justify-content: center;">
                    <div class="loading-message">
                        <img src="assets/loading.gif" alt="..."/>
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
                                :navigate-to-path="(path, params) => navigateToPath(path, params)"
                            >
                            </inventory-content>
                            <!-- Packlist Content -->
                            <packlist-content 
                                v-else-if="container.type === 'packlist' || container.containerPath?.startsWith('packlist')"
                                :container-path="container.containerPath"
                                :navigate-to-path="(path, params) => navigateToPath(path, params)"
                            >
                            </packlist-content>
                            
                            <!-- Schedule Content -->
                            <schedule-content 
                                v-else-if="container.type === 'schedule' || container.containerPath?.startsWith('schedule')"
                                :container-path="container.containerPath"
                                :navigate-to-path="(path, params) => navigateToPath(path, params)">
                            </schedule-content>
                            
                            <!-- Reports Content -->
                            <reports-content 
                                v-else-if="container.type === 'reports' || container.containerPath?.startsWith('reports')"
                                :container-path="container.containerPath"
                                :navigate-to-path="(path, params) => navigateToPath(path, params)">
                            </reports-content>
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
                        :size="modal.size"
                        :tall="modal.tall"
                        :message="modal.message"
                        :content-class="modal.contentClass"
                        :component-props="modal.componentProps"
                        @close-modal="modalManager.removeModal(modal.id)"
                    ></app-modal>
                </transition-group>
            </div>
            <!-- Global notification bubble overlay -->
            <NotificationBubbleOverlay />
        </div>
    `
};

// Initialize the app
const app = createApp(App);
app.mount('body');