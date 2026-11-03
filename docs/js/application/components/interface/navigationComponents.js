import { html, NavigationRegistry, appSettings, runNonessentialAnalysisOnAllStores } from '../../index.js';
import { PriorityQueue } from '../../utils/priorityQueue.js';
import { viewportTier } from '../../utils/useContainerSize.js';

// Settings Menu Component
const SettingsMenuComponent = {
    inject: ['$modal', '$notify'],
    props: {
        darkMode: { type: Boolean, required: true },
        onlyEssentialAnalysis: { type: Boolean, required: true },
        showDashboardHeaders: { type: Boolean, required: true },
        toggleDarkMode: { type: Function, required: true },
        toggleEssentialAnalysis: { type: Function, required: true },
        toggleDashboardHeaders: { type: Function, required: true }
    },
    emits: ['close-modal'],
    methods: {
        handleToggleAnalysis() {
            this.toggleEssentialAnalysis();
            this.$emit('close-modal');
        },
        handleToggleDarkMode() {
            this.toggleDarkMode();
            this.$emit('close-modal');
        },
        handleToggleDashboardHeaders() {
            this.toggleDashboardHeaders();
            this.$emit('close-modal');
        }
    },
    template: html`
        <div class="page-menu-items">
            <button @click="handleToggleAnalysis" 
                    :class="['page-menu-item', { 'red': onlyEssentialAnalysis }]">
                {{ onlyEssentialAnalysis ? 'Enable' : 'Disable' }} Advanced Analysis
            </button>
            <button @click="handleToggleDarkMode" 
                    class="page-menu-item">
                {{ darkMode ? 'Light' : 'Dark' }} Mode
            </button>
            <button @click="handleToggleDashboardHeaders" 
                    :class="['page-menu-item', { 'red': !showDashboardHeaders }]">
                {{ showDashboardHeaders ? 'Hide' : 'Show' }} Dashboard Headers
            </button>
        </div>
    `
};

export const PrimaryNavComponent = {
    inject: ['$modal', '$notify'],
    props: {
        isMenuOpen: {
            type: Boolean,
            default: false
        },
        navigationItems: {
            type: Array,
            default: () => []
        },
        currentPath: {
            type: String,
            default: 'dashboard'
        },
        isAuthenticated: {
            type: Boolean,
            default: false
        },
        isAuthLoading: {
            type: Boolean,
            default: false
        },
        currentUser: {
            type: Object,
            default: () => null
        }
    },
    emits: [
        'toggle-menu',
        'navigate-to-path',
        'login',
        'logout'
    ],
    data() {
        const saved = localStorage.getItem('theme');
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        return {
            isMenuVisible: true,
            lastScrollTop: 0,
            darkMode: saved === 'dark' ? true : saved === 'light' ? false : prefersDark
        };
    },
    computed: {
        currentPage() {
            const cleanPath = this.currentPath.split('?')[0];
            return cleanPath.split('/')[0];
        },
        isDarkMode() {
            return this.darkMode;
        },
        logoSrc() {
            return this.isDarkMode ? 'assets/logoW.png' : 'assets/logo.png';
        },
        isMobileView() {
            // Compact chrome: viewport medium and narrow tiers (size model §4.10, R4.4)
            return viewportTier(window.innerWidth) !== 'wide';
        },
        onlyEssentialAnalysis() {
            return appSettings.onlyRunEssentialAnalysis;
        },
        showDashboardHeaders() {
            return appSettings.showDashboardHeaders;
        }
    },
    watch: {
        currentPath(newPath, oldPath) {
            // Extract base paths (without query params)
            const getBasePath = (path) => path.split('?')[0];
            const newBase = getBasePath(newPath);
            const oldBase = getBasePath(oldPath);
            
            // If actual path changed (not just params), show the navbar
            if (newBase !== oldBase) {
                this.isMenuVisible = true;
            }
        }
    },
    methods: {
        openSettingsMenu() {
            this.$modal.custom(SettingsMenuComponent, {
                modalClass: 'hamburger-menu',
                size: 'card',
                darkMode: this.darkMode,
                onlyEssentialAnalysis: this.onlyEssentialAnalysis,
                showDashboardHeaders: this.showDashboardHeaders,
                toggleDarkMode: this.toggleDarkMode,
                toggleEssentialAnalysis: this.toggleEssentialAnalysis,
                toggleDashboardHeaders: this.toggleDashboardHeaders
            }, 'Application Settings');
        },
        updateAnalysisBanner() {
            const banners = this.$notify.getBanners('app') || [];
            const existingIndex = banners.findIndex(b => b.key === 'analysis-disabled');
            
            if (this.onlyEssentialAnalysis) {
                const banner = {
                    key: 'analysis-disabled',
                    color: 'orange',
                    message: 'Advanced analysis is disabled. Some features may not be available.',
                    visible: true,
                    dismissible: false,
                    action: {
                        label: 'Enable',
                        fn: () => {
                            this.toggleEssentialAnalysis();
                        }
                    }
                };
                
                if (existingIndex >= 0) {
                    banners[existingIndex] = banner;
                } else {
                    banners.push(banner);
                }
            } else {
                if (existingIndex >= 0) {
                    banners.splice(existingIndex, 1);
                }
            }
            
            this.$notify.setBanners('app', banners);
        },
        toggleEssentialAnalysis() {
            const wasEssentialOnly = appSettings.onlyRunEssentialAnalysis;
            appSettings.onlyRunEssentialAnalysis = !appSettings.onlyRunEssentialAnalysis;
            
            // Save to localStorage
            localStorage.setItem('essentialAnalysisOnly', appSettings.onlyRunEssentialAnalysis);
            
            if (wasEssentialOnly) {
                // Switching from essential-only to full analysis
                // Trigger nonessential analysis on all stores that have data
                //console.log('[Navigation] Enabling full analysis mode - triggering nonessential analysis');
                runNonessentialAnalysisOnAllStores();
            } else {
                // Switching from full to essential-only
                // Clear pending nonessential analysis tasks from queue
                //console.log('[Navigation] Enabling essential-only mode - clearing nonessential tasks');
                PriorityQueue.clearNonessentialAnalysis();
            }
            
            // Update banner after toggle
            this.updateAnalysisBanner();
        },
        toggleDarkMode() {
            this.darkMode = !this.darkMode;
            const theme = this.darkMode ? 'dark' : 'light';
            document.documentElement.dataset.theme = theme;
            localStorage.setItem('theme', theme);
        },
        toggleDashboardHeaders() {
            appSettings.showDashboardHeaders = !appSettings.showDashboardHeaders;
            localStorage.setItem('showDashboardHeaders', appSettings.showDashboardHeaders);
        },
        handleNavClick(item) {
            // In mobile view: if menu is closed, open it first; if open, then navigate
            // In desktop view: always navigate
            if (this.isMobileView && !this.isMenuOpen) {
                this.$emit('toggle-menu');
            } else {
                this.$emit('navigate-to-path', item.path);
            }
        },
        handleClickOutside(event) {
            if (!this.isMenuOpen) return;
            const nav = this.$el.querySelector('nav');
            if (nav && !nav.contains(event.target)) {
                this.$emit('toggle-menu');
            }
        }
    },
    mounted() {
        const saved = localStorage.getItem('theme');
        if (saved) document.documentElement.dataset.theme = saved;
        document.addEventListener('mouseup', this.handleClickOutside);
        
        // Add a listener for scroll up or down in #app-content to hide or show the navbar.
        // Avoid hiding if there's insufficient scrollable content (less than navbar height * 2).
        this._scrollHandler = () => {
            const appContent = document.querySelector('#app-content');
            if (!appContent) return;
            
            // Calculate available scrollable height
            const scrollableHeight = appContent.scrollHeight - appContent.clientHeight;
            const navbarHeight = parseFloat(
                getComputedStyle(document.documentElement).getPropertyValue('--navbar-height')
            );
            const minScrollThreshold = navbarHeight * 2;
            
            // Don't allow hiding if there's not enough scrollable content
            if (scrollableHeight < minScrollThreshold) {
                this.isMenuVisible = true;
                return;
            }
            
            const currentScroll = appContent.scrollTop;
            if (currentScroll > this.lastScrollTop + 12) {
                this.isMenuVisible = false;
                this.lastScrollTop = currentScroll;
            } else if (currentScroll < this.lastScrollTop - 64 || currentScroll <= 0) {
                this.isMenuVisible = true;
                this.lastScrollTop = currentScroll;
            }
        };
        
        document.querySelector('#app-content')?.addEventListener('scroll', this._scrollHandler, { passive: true });
        
        // Initialize banner state
        this.updateAnalysisBanner();
    },
    beforeUnmount() {
        document.removeEventListener('mouseup', this.handleClickOutside);
        document.querySelector('#app-content')?.removeEventListener('scroll', this._scrollHandler);
        this._scrollHandler = null;
    },
    template: html`
        <header>
            <nav 
                :class="{ 'open': isMenuOpen, 'hidden': !isMenuVisible && !isMenuOpen }"
                >
                <a @click.prevent="$emit('navigate-to-path', 'dashboard');">
                    <img :src="logoSrc" alt="Top Shelf Exhibits" />
                </a>

                <span id="navbar">
                    <template v-if="isAuthenticated">
                        <a v-for="item in navigationItems" 
                           :key="item.path"
                           :class="{ 'active': currentPage === item.path }"
                           @click.prevent="handleNavClick(item)">
                            {{ item.title }}
                        </a>
                    </template>
                    
                    <div class="button-bar">
                        <button v-if="!isAuthenticated" 
                                @click="$emit('login')" 
                                :disabled="isAuthLoading"
                                class="login-out-button active">
                            {{ isAuthLoading ? 'Loading...' : 'Login' }}
                        </button>
                        <button v-else 
                                @click="$emit('logout')" 
                                :disabled="isAuthLoading"
                                class="login-out-button">
                            {{ isAuthLoading ? 'Logging out...' : 'Logout (' + (currentUser?.name || '') + ')' }}
                        </button>
                        <button class="button-symbol" 
                                @click="openSettingsMenu" 
                                title="Settings">
                            <span class="material-symbols-outlined">more_vert</span>
                        </button>
                    </div>
                </span>
                
                <button class="nav-toggle button-symbol white" @click="$emit('toggle-menu')">
                    <span v-if="isMenuOpen" class="material-symbols-outlined">close</span>    
                    <slot v-else>☰</slot>
                </button>
            </nav>
        </header>
    `
};


export const BreadcrumbComponent = {
    props: {
        containerPath: {
            type: String,
            default: ''
        },
        title: {
            type: String,
            default: ''
        },
        cardStyle: {
            type: Boolean,
            default: false
        },
        containerId: {
            type: String,
            required: false
        }
    },
    data() {
        return {
            showHoverPath: false
        };
    },
    mounted() {
        // Watch the NavigationRegistry version ref for changes
        // When routes are registered, routeRegistrationVersion increments and triggers re-render
        this.$watch(
            () => NavigationRegistry.routeRegistrationVersion.value,
            () => {
                // Vue automatically re-evaluates pathSegmentsWithNames computed property
                // because it accesses routeRegistrationVersion
            }
        );
    },
    computed: {
        // Extract clean path without query parameters for breadcrumb display
        cleanPath() {
            if (!this.containerPath) return '';
            return this.containerPath.split('?')[0];
        },
        pathSegments() {
            if (!this.cleanPath) return [];
            return this.cleanPath.split('/').filter(segment => segment.length > 0);
        },
        pathSegmentsWithNames() {
            // Dependency on routeRegistrationVersion.value ensures re-evaluation when routes register
            const _versionDependency = NavigationRegistry.routeRegistrationVersion.value;
            
            if (!this.pathSegments.length) return [];
            
            return this.pathSegments.map((segment, index) => {
                const cumulativePath = this.pathSegments.slice(0, index + 1).join('/');
                return {
                    id: segment,
                    name: this.getSegmentName(cumulativePath),
                    index: index,
                    path: cumulativePath
                };
            });
        },
        displayTitle() {
            if (this.containerPath) {
                // For dashboard cards, use dashboard title; for regular breadcrumbs, use display name
                if (this.cardStyle) {
                    return NavigationRegistry.getDisplayName(this.containerPath,true);
                } else {
                    if (this.pathSegmentsWithNames.length === 0) return this.title;
                    return this.pathSegmentsWithNames[this.pathSegmentsWithNames.length - 1].name;
                }
            }
            return this.title;
        },
        canGoBack() {
            if (this.pathSegments.length <= 1) return false;
            
            // Don't allow going back if the parent path would be 'dashboard'
            const parentSegments = this.pathSegments.slice(0, -1);
            if (parentSegments.length === 1 && parentSegments[0] === 'dashboard') {
                return false;
            }
            
            return true;
        },
        parentPath() {
            if (this.pathSegments.length <= 1) return '';
            return this.pathSegments.slice(0, -1).join('/');
        }
    },
    methods: {
        /**
         * Get human-readable name for a segment, building it if not found
         * @param {string} segmentId - The segment identifier
         */
        getSegmentName(segmentId) {
            // Try to get from NavigationRegistry
            let registryName = NavigationRegistry.getDisplayName(segmentId);
            if (registryName !== 'Unknown') {
                return registryName;
            }
            
            // Auto-generate name if not found
            return segmentId.charAt(0).toUpperCase() + segmentId.slice(1);
        },
        navigateToBreadcrumb(index) {
            if (index < this.pathSegments.length - 1) {
                const targetPath = this.pathSegments.slice(0, index + 1).join('/');
                
                // Emit string path for navigation
                this.$emit('navigate-to-path', targetPath);
            }
        },
        showHoverBreadcrumb() {
            this.showHoverPath = true;
        },
        hideHoverBreadcrumb() {
            this.showHoverPath = false;
        }
    },
    template: html`
        <div v-if="containerPath" class="breadcrumb-nav">
            <!-- Full breadcrumb path for non-card containers -->
            <div v-if="!cardStyle" class="breadcrumb-path">
                <template v-for="(segment, index) in pathSegmentsWithNames" :key="segment.id">
                    <span 
                        class="breadcrumb-segment"
                        :class="{ 
                            'active': index === pathSegmentsWithNames.length - 1,
                            'page-highlight': index === 0 
                        }"
                        @click="navigateToBreadcrumb(index)">
                        {{ segment.name }}
                    </span>
                    <span v-if="index < pathSegmentsWithNames.length - 1" class="breadcrumb-separator">/</span>
                </template>
            </div>
            <!-- Current location with hover overlay for dashboard cards -->
            <div v-else class="breadcrumb-card-container">
                <span v-if="!showHoverPath" class="breadcrumb-current" 
                    @mouseenter="showHoverBreadcrumb" 
                    @mouseleave="hideHoverBreadcrumb">
                    {{ displayTitle }}
                </span>

                <!-- Hover overlay with full breadcrumb path -->
                <div v-else-if="showHoverPath" class="breadcrumb-hover-overlay"
                     @mouseenter="showHoverBreadcrumb" 
                     @mouseleave="hideHoverBreadcrumb">
                    <div class="breadcrumb-path">
                        <template v-for="(segment, index) in pathSegmentsWithNames" :key="segment.id">
                            <span 
                                class="breadcrumb-segment"
                                :class="{ 
                                    'active': index === pathSegmentsWithNames.length - 1,
                                    'page-highlight': index === 0 
                                }"
                                @click="navigateToBreadcrumb(index)">
                                {{ segment.name }}
                            </span>
                            <span v-if="index < pathSegmentsWithNames.length - 1" class="breadcrumb-separator">/</span>
                        </template>
                    </div>
                </div>
            </div>
        </div>
        <!-- Traditional Title (fallback) -->
        <h2 v-else-if="title">{{ displayTitle }}</h2>
    `
};


/**
 * Standard Vue component for dashboard toggle functionality
 */
export const DashboardToggleComponent = {
    props: {
        containerPath: String,
        containerType: String,
        currentSegment: String,
        title: String
    },
    inject: ['appContext'],
    computed: {
        isOnDashboard() {
            return NavigationRegistry.dashboardRegistry.has(this.containerPath);
        },
        isLoading() {
            return NavigationRegistry.dashboardRegistry.isLoading;
        },
        loadingMessage() {
            return NavigationRegistry.dashboardRegistry.loadingMessage;
        },
        containerClasses() {
            const classes = NavigationRegistry.dashboardRegistry.getClasses(this.containerPath);
            return new Set(classes ? classes.split(' ').filter(c => c.length > 0) : []);
        },
        canMoveLeft() {
            if (!this.isOnDashboard) return false;
            const containers = NavigationRegistry.dashboardRegistry.containers;
            const index = containers.findIndex(container => 
                (typeof container === 'string' ? container : container.path) === this.containerPath
            );
            return index > 0;
        },
        canMoveRight() {
            if (!this.isOnDashboard) return false;
            const containers = NavigationRegistry.dashboardRegistry.containers;
            const index = containers.findIndex(container => 
                (typeof container === 'string' ? container : container.path) === this.containerPath
            );
            return index > -1 && index < containers.length - 1;
        }
    },
    methods: {
        async toggleDashboardPresence() {
            if (this.isOnDashboard) {
                await NavigationRegistry.dashboardRegistry.remove(this.containerPath);
            } else {
                await NavigationRegistry.dashboardRegistry.add(this.containerPath);
            }
        },
        async toggleDashboardClass(className) {
            if (this.isOnDashboard) {
                await NavigationRegistry.dashboardRegistry.toggleClass(this.containerPath, className);
            }
        },
        async moveLeft() {
            if (this.canMoveLeft) {
                await NavigationRegistry.dashboardRegistry.moveLeft(this.containerPath);
            }
        },
        async moveRight() {
            if (this.canMoveRight) {
                await NavigationRegistry.dashboardRegistry.moveRight(this.containerPath);
            }
        }
    },
    template: html`
        <div>
            <!-- Dashboard card styling controls (only show on dashboard page) -->
            <div v-if="(this.appContext.currentPath?.split('/')[0] === 'dashboard') && isOnDashboard" class="button-bar">
                <button @click="toggleDashboardClass('wide');" 
                        :class="{ 'green': containerClasses.has('wide'), 'blue': !containerClasses.has('wide') }">
                    Wide
                </button>
                <button @click="toggleDashboardClass('tall');" 
                        :class="{ 'green': containerClasses.has('tall'), 'blue': !containerClasses.has('tall') }">
                    Tall
                </button>
            </div>
            
            <!-- Dashboard ordering controls (only show on dashboard page) -->
            <div v-if="(this.appContext.currentPath?.split('/')[0] === 'dashboard') && isOnDashboard" class="button-bar">
                <button @click="moveLeft" :disabled="!canMoveLeft" 
                        :class="{ 'blue': canMoveLeft, 'disabled': !canMoveLeft }">
                    ← Move Left
                </button>
                <button @click="moveRight" :disabled="!canMoveRight" 
                        :class="{ 'blue': canMoveRight, 'disabled': !canMoveRight }">
                    Move Right →
                </button>
            </div>
            
            <!-- Add/Remove from dashboard -->
            <button 
                @click="toggleDashboardPresence"
                :class="{ 'red': isOnDashboard, 'green': !isOnDashboard }">
                {{ isOnDashboard ? 'Remove from Dashboard' : 'Add to Dashboard' }}
            </button>
        </div>
    `
};
