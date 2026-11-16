import { html } from './index.js';
import { ContainerComponent } from './index.js';
import { ModalComponent, modalManager } from './index.js';
import { PrimaryNavComponent } from './index.js';
import { Auth, authState } from './index.js';
import { NavigationRegistry } from './index.js';
import { PacklistContent, InventoryContent, ScheduleContent, ReportsContent, NoticesContent } from './index.js';
import { DashboardCell, DashboardArrangeLayer, observeDashboardGrid, stopObservingDashboardGrid, measureDashboardGrid, noticesOnDashboard, NOTICES_PATH, gridAreaStyle, DASHBOARD_CELLS } from './index.js';
import { hamburgerMenuRegistry } from './index.js';
import { undoRegistry } from './index.js';
import { Requests, getReactiveStore, appSettings, saveDirtyStoresToUserData, getShortageAlertsStore, getShortageAlertDays, shortageBanner } from './index.js';
import { BannerNotifications, NotificationBubbleOverlay, notificationBus } from './index.js';
import { SEVERITY } from './index.js';
import { isLocalhost } from '../data_management/utils/helpers.js';

const { createApp } = Vue;

// Whether the address the app opened with names a page rather than the dashboard (a short link
// counts as a page until it resolves)
function addressNamesPage() {
    const page = window.location.hash.slice(1).split(/[?/]/)[0];
    return !!page && page !== 'dashboard';
}

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
        'notices-content': NoticesContent,
        BannerNotifications,
        NotificationBubbleOverlay,
        DashboardCell,
        DashboardArrangeLayer,
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
            // Opened on a page's address: true until the app has signed in and opened that page
            startingOnPage: addressNamesPage(),
            isMenuOpen: false,
            navigationItems: NavigationRegistry.primaryNavigation,
            currentPath: 'dashboard',
            modals: [],
            currentYear: new Date().getFullYear(),
            globalLocksStore: null, // Global reactive store for ALL locks
            shortageAlertsStore: null, // Inventory shortage alerts (app banner)
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
                    severity: SEVERITY.warning,
                    message: 'No network connection. Your data is preserved. Changes cannot be saved until connectivity is restored.',
                    visible: this.isOffline,
                    dismissible: false
                },
                {
                    key: 'permissions',
                    severity: SEVERITY.critical,
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
                    severity: SEVERITY.critical,
                    message: `Error: ${this.authError}`,
                    visible: !!this.authError && !this.isAuthenticated,
                    dismissible: false
                },
                {
                    key: 'update-available',
                    severity: SEVERITY.warning,
                    message: 'A new version of the app is available. Editing is turned off until you refresh.',
                    visible: this.updateAvailable,
                    dismissible: false,
                    action: {
                        label: 'Refresh Now',
                        fn: () => this.refreshToLatest()
                    }
                }
            ];
            
            // Created after authentication, like the preferences store getShortageAlertDays reads
            const shortage = this.shortageAlertsStore && shortageBanner(this.shortageAlertsStore.data, getShortageAlertDays(), this.navigateToPath);
            if (shortage) staticBanners.push(shortage);

            // Combine static banners with dynamic ones from the notification bus
            const dynamicBanners = this.notificationBus.getBanners('app') || [];
            return [...staticBanners, ...dynamicBanners];
        },
        // Check if dashboard is doing initial load (triggers app loading indicator)
        isDashboardInitialLoad() {
            return NavigationRegistry.dashboardRegistry.isInitialLoad;
        },
        // (Opened on a page's address, the dashboard is never drawn on the way there)
        isDashboard() {
            return this.currentPage === 'dashboard' && !this.startingOnPage;
        },
        // The dashboard's first load, once signed in: reading the user's cards
        dashboardLoading() {
            if (!this.isDashboard || !this.isAuthenticated) return false;
            return this.appLoading || !NavigationRegistry.dashboardRegistry.store || this.isDashboardInitialLoad;
        },
        // A loading card over each dashboard cell while it loads. They fade in, sit above the
        // cards arriving underneath, and fade out when it's ready. (Pages open at once: their
        // content shows its own loading.)
        loadingCards() {
            if (!this.dashboardLoading) return [];
            return DASHBOARD_CELLS.map(cell => ({ key: `${cell.x}-${cell.y}`, style: gridAreaStyle(cell) }));
        },
        // Arrange mode: dashboard cards drawn as miniatures that can be moved and resized
        arranging() {
            return this.isDashboard && NavigationRegistry.dashboardRegistry.arranging;
        },
        // The app banners at the top of the page. The notices page draws them itself, and so does
        // the dashboard's notices card while it's on the grid.
        showTopBanners() {
            if (this.currentPage === NOTICES_PATH) return false;
            return !(this.isDashboard && this.isAuthenticated && !this.isDashboardInitialLoad && noticesOnDashboard());
        },
        // A dashboard without a notices card keeps the screen for cards: banners go to the corner tray
        collapseTopBanners() {
            return this.isDashboard && this.isAuthenticated;
        },
        // Reactive containers based on current page and authentication state
        containers() {
            if (!authState.isAuthenticated || this.startingOnPage) {
                return [];
            }

            // Key on the clean path: URL parameters (search, view, filters) update the page in
            // place instead of rebuilding it, and a card expanded to its page keeps its component.
            // Shared links still carry the parameters.
            const containerFor = (path, card) => {
                const type = NavigationRegistry.getTypeFromPath(path);
                return {
                    key: `${type}-${path.split('?')[0].replace(/[^a-zA-Z0-9]/g, '_')}`,
                    type,
                    title: NavigationRegistry.getDisplayName(path, !!card),
                    containerPath: path,
                    card // the placed card on the dashboard grid ({ path, x, y, w, h }), null on a page
                };
            };
            if (this.isDashboard) {
                // The grid's cards and the cards in groups (groups themselves draw only while arranging)
                const { placed, grouped } = NavigationRegistry.dashboardRegistry.layout;
                return [...placed.filter(card => !card.group), ...grouped].map(card => containerFor(card.path, card));
            }
            return [containerFor(this.currentPath, null)];
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
            
            this.initializeGlobalStores();
            
            await this.openStartingPath();
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
                        // Bookmarks are info banners. Ones saved before the severity was kept have
                        // neither severity nor color: they get info back (an old color still wins).
                        const restored = saved.map(b => ({
                            ...b,
                            severity: b.severity || SEVERITY.info,
                            visible: true,
                            action: { label: 'Return', fn: () => this.navigateToPath(b.bookmarkTarget) }
                        }));
                        this.notificationBus.setBanners('app', restored);
                    } catch (e) {
                        console.warn('[App] Failed to restore bookmarks:', e);
                    }
                }
                
                this.initializeGlobalStores();
                
                await this.openStartingPath();
            }
        });

        // Path changes: scroll the new page to the top (the dashboard is one screen and doesn't
        // scroll). Entering the dashboard re-measures the grid.
        this.$watch(() => this.currentPage, () => {
            this.$nextTick(() => measureDashboardGrid());
        });
        this.$watch(() => this.currentPath, () => {
            this.startingOnPage = false;
            this.$nextTick(() => {
                const appContent = document.querySelector('#app-content');
                if (appContent) appContent.scrollTop = 0;
            });
        });
        // Each page has its own undo history, arrange mode included (its own address): undo on the
        // dashboard never changes the layout. Leaving arrange mode drops its history.
        this.$watch(() => this.currentPath.split('?')[0], (path) => {
            const registry = NavigationRegistry.dashboardRegistry;
            if (registry.arranging && path !== registry.arrangePath) undoRegistry.clearRouteHistory(registry.arrangePath);
            registry.arranging = path === registry.arrangePath;
            undoRegistry.setActiveRoute(path);
        }, { immediate: true });
        observeDashboardGrid(this.$el.querySelector('#app-content'));

        // Watch for notification bus app-level changes to force computed to recalculate
        this.$watch(() => this.notificationBus.getBanners('app'), (newBanners) => {
            // Save bookmark banners to localStorage on every change
            if (authState.user?.email) {
                const bookmarks = (newBanners || [])
                    .filter(b => b.key?.startsWith('bookmark-') && b.bookmarkTarget)
                    .map(({ key, severity, color, message, dismissible, bookmarkTarget }) => ({ key, severity, color, message, dismissible, bookmarkTarget }));
                localStorage.setItem(`bookmarks_${authState.user.email}`, JSON.stringify(bookmarks));
            }
        }, { deep: true });

        this.appLoading = false;

        // Local dev tools (window.fakeGoogle). The test suite runs only on command:
        // fakeGoogle.runTests() in the console.
        if (isLocalhost()) {
            import('../tests/fakeGoogleDevTools.js').then(devTools => devTools.installFakeGoogleDevTools());
        }
    },
    beforeUnmount() {
        // Clean up event listener
        document.removeEventListener('keydown', this.handleGlobalKeyDown);
        stopObservingDashboardGrid();
        
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
        // App-wide stores, created once after authentication: all locks, and the shortage alerts
        initializeGlobalStores() {
            if (!this.globalLocksStore) this.globalLocksStore = getReactiveStore(Requests.getAllLocks, null, []);
            if (!this.shortageAlertsStore) this.shortageAlertsStore = getShortageAlertsStore();
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

        arrangeDashboard() {
            this.navigateToPath(NavigationRegistry.dashboardRegistry.arrangePath);
        },

        // Open the page the address names, once signed in (a short link resolves now). Until then
        // an address naming a page draws nothing (startingOnPage), rather than the dashboard.
        async openStartingPath() {
            try {
                const currentUrl = await NavigationRegistry.urlRouter.resolvePathFromURL();
                if (currentUrl && currentUrl !== 'dashboard') {
                    await NavigationRegistry.handleNavigateToPath({
                        targetPath: currentUrl,
                        isBrowserNavigation: true
                    }, this);
                }
            } finally {
                this.startingOnPage = false;
            }
        },

        handleGlobalKeyDown(event) {
            // Escape ends arrange mode (when no modal is open to take it)
            if (event.key === 'Escape' && this.arranging && !this.modals.length) {
                this.navigateToPath('dashboard');
                return;
            }
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

            <div id="app-content" :class="{ 'dashboard': isDashboard, 'arranging': arranging }">
                <BannerNotifications v-if="showTopBanners" :banners="appBanners" scope="app" :collapsed="collapseTopBanners" />

                <!-- Dashboard first load: loading cards over the grid's cells -->
                <transition-group name="longfade" appear>
                    <div v-for="card in loadingCards" :key="card.key" class="loading-card" :style="card.style"></div>
                </transition-group>

                <div v-if="!isAuthenticated" class="empty-message">
                    please log in to view content
                </div>

                <!-- No containers message -->
                <div v-else-if="containers.length === 0 && !arranging && !loadingCards.length && !startingOnPage" class="empty-message">
                    <template v-if="isDashboard">
                        <p>add pages to the dashboard from their page menus</p>
                        <button class="white" @click="arrangeDashboard">Arrange Dashboard</button>
                    </template>
                    <template v-else>open a page to see content</template>
                </div>

                <!-- Reactive containers: each in a DashboardCell (the card's grid cell on the dashboard) -->
                <template v-else>
                    <DashboardCell
                        v-for="container in containers"
                        :key="container.key"
                        :card="container.card"
                        :title="container.title"
                        @expand="expandContainer(container)"
                        v-slot="{ miniature, header, bare }">
                    <app-container
                        :data-container-id="container.key"
                        :container-id="container.key"
                        :container-type="container.type"
                        :title="container.title"
                        :container-path="container.containerPath"
                        :card-style="!!container.card"
                        :show-header="header"
                        :bare="bare"
                        :inert="miniature"
                        @navigate-to-path="navigateToPath"
                        @expand-container="expandContainer"
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

                            <!-- Notices (the app banners as a page; the dashboard's notices card) -->
                            <notices-content v-else-if="container.type === 'notices'"></notices-content>
                        </template>
                    </app-container>
                    </DashboardCell>
                    <DashboardArrangeLayer v-if="arranging" />
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