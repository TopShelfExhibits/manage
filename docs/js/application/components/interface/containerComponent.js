import { html, BreadcrumbComponent, NavigationRegistry, BannerNotifications, appSettings, SEVERITY } from '../../index.js';
import { PageNoteComponent } from './pageNoteComponent.js';
import { URLRouter } from '../../utils/urlRouter.js';

// Container component functionality
export const ContainerComponent = {
    components: {
        BreadcrumbComponent,
        PageNoteComponent,
        BannerNotifications
    },
    props: {
        containerId: {
            type: String,
            required: true
        },
        containerType: {
            type: String,
            default: 'default'
        },
        title: {
            type: String,
            default: ''
        },
        containerPath: {
            type: String,
            default: ''
        },
        cardStyle: {
            type: Boolean,
            default: false
        },
        cardClasses: {
            type: String,
            default: ''
        },
        // Show expand button to open in full page
        showExpandButton: {
            type: Boolean,
            default: false
        },
        pinnedToDashboard: {
            type: Boolean,
            default: false
        }
    },
    inject: ['hamburgerMenuRegistry', '$modal', '$notify', 'appContext'],
    provide() {
        return {
            // Provide navigation parameters to child components
            navigationParameters: () => this.navigationParameters
        };
    },
    data() {
        return {
            isLoading: false, // now managed reactively by this component
            isScrolling: false,
            _scrollTimeout: null
        };
    },
    mounted() {
        // Listen for wheel events on the container
        const container = this.$el;
        if (container) {
            container.addEventListener('wheel', this.handleWheel, { passive: true });
        }
    },

    beforeUnmount() {
        // Clean up event listener and timeout
        const container = this.$el;
        if (container) {
            container.removeEventListener('wheel', this.handleWheel);
        }
        if (this._scrollTimeout) {
            clearTimeout(this._scrollTimeout);
            this._scrollTimeout = null;
        }
    },
    computed: {
        // Get hamburger menu component from registry
        hamburgerMenuComponent() {
            return this.hamburgerMenuRegistry.getMenuComponent(this.containerType, this.containerPath);
        },
        // Get navigation parameters from NavigationRegistry
        navigationParameters() {
            return NavigationRegistry.getNavigationParameters(this.containerPath);
        },
        containerBanners() {
            return this.$notify.getBanners(this.containerPath);
        },
        isScrollingEnabled() {
            return appSettings.enableDashboardCardScrolling;
        },
        shouldShowHeader() {
            // Dashboard cards respect the header visibility setting
            // Non-dashboard containers always show headers
            if (this.cardStyle) {
                return appSettings.showDashboardHeaders;
            }
            // Always show headers on non-dashboard pages
            return this.containerPath || this.title || this.cardStyle;
        }
    },
    methods: {
        setLoading(val) {
            this.isLoading = val;
        },
        closeContainer() {
            this.$emit('navigate-to-path', 'dashboard');
        },
        openHamburgerMenu() {
            if (this.hamburgerMenuComponent) {
                this.$modal.custom(
                    this.hamburgerMenuComponent.components,
                    this.hamburgerMenuComponent.props || {},
                    this.title
                );
            }
        },
        toggleDashboardState() {
            this.$emit('toggle-dashboard-state', {
                containerPath: this.containerPath,
                pinned: !this.pinnedToDashboard
            });
        },
        expandContainer() {
            this.$emit('expand-container', {
                path: this.containerPath,
                containerPath: this.containerPath,
                title: this.title
            });
        },
        async shareContainer() {
            // Construct the full URL
            const fullUrl = `${window.location.origin}${window.location.pathname}#${this.containerPath}`;
            
            // Copy to clipboard
            navigator.clipboard.writeText(fullUrl).then(() => {
                // Show modal with the link
                this.$modal.confirm(
                    `Link copied to clipboard\n\nSend to anyone with a topshelfexhibits.com email\n\n${fullUrl}`,
                    () => {
                        // Ok button - just close the modal
                    },
                    async () => {
                        // Shorten Link button
                        try {
                            this.$modal.alert('Creating shortened link...', 'Please wait');
                            
                            const shortHash = await URLRouter.createShortHash(this.containerPath);
                            const shortUrl = `${window.location.origin}${window.location.pathname}#${shortHash}`;
                            
                            // Copy shortened URL to clipboard
                            await navigator.clipboard.writeText(shortUrl);
                            this.$modal.confirm(
                                `Shortened link copied to clipboard\n\nSend to anyone with a topshelfexhibits.com email\n\n${shortUrl}`,
                                () => {
                                    // Ok button - just close the modal
                                },
                                undefined,
                                'Share Link'
                            );
                        } catch (err) {
                            console.error('Failed to create or copy shortened link:', err);
                            this.$modal.alert('Failed to create shortened link', 'Error');
                        }
                    },
                    'Share Link',
                    'Ok',
                    'Shorten Link'
                );
            }).catch(err => {
                console.error('Failed to copy link:', err);
                this.$modal.alert('Failed to copy link to clipboard', 'Error');
            });
        },
        bookmarkContainer() {
            // Build breadcrumb path text from segment names
            const pathSegments = this.containerPath.split('/').filter(s => s.length > 0);
            const pathText = pathSegments.map(segment => {
                const name = NavigationRegistry.getDisplayName(segment);
                return name !== 'Unknown' ? name : segment.charAt(0).toUpperCase() + segment.slice(1);
            }).join(' / ');

            // Get current parameters and build full path for navigation
            const currentParams = NavigationRegistry.getParametersForContainer(this.containerPath, this.appContext.currentPath);
            const hasParams = Object.keys(currentParams).length > 0;
            const bookmarkPath = hasParams
                ? NavigationRegistry.buildPath(this.containerPath, currentParams)
                : this.containerPath;

            // Build human-readable shorthand from parameter values
            let paramSuffix = '';
            if (hasParams) {
                const parts = [];
                for (const [key, val] of Object.entries(currentParams)) {
                    if (key === 'dateFilters' && Array.isArray(val)) {
                        const after = val.find(f => f.type === 'after');
                        const before = val.find(f => f.type === 'before');
                        if (after && before) {
                            parts.push(`${after.value}–${before.value}`);
                        } else {
                            val.forEach(f => f.value && parts.push(String(f.value)));
                        }
                    } else if (key === 'textFilters' && Array.isArray(val)) {
                        val.forEach(f => Array.isArray(f.values) && parts.push(...f.values.map(String)));
                    } else if (typeof val !== 'object') {
                        parts.push(String(val));
                    }
                }
                if (parts.length > 0) paramSuffix = ` (${parts.join(', ')})`;
            }
            
            // Store reference to appContext for the action callback (stable across re-renders)
            const appCtx = this.appContext;
            
            // Create a blue notification with action to navigate back to this path
            const bannerKey = `bookmark-${Date.now()}`;
            const bookmarkBanner = {
                key: bannerKey,
                severity: SEVERITY.info,
                message: `Page bookmarked: ${pathText}${paramSuffix}`,
                visible: true,
                dismissible: true,
                bookmarkTarget: bookmarkPath,
                action: {
                    label: 'Return',
                    fn: () => {
                        appCtx.navigateToPath(bookmarkPath);
                    }
                }
            };
            
            // Push to app-level notification bus (scope: 'app')
            const currentBanners = this.$notify.getBanners('app') || [];
            this.$notify.setBanners('app', [...currentBanners, bookmarkBanner]);
        },
        handleWheel() {
            // Only set isScrolling if container is clipping content
            const container = this.$el;
            // Check for vertical or horizontal overflow
            const isClipping = (
                container.scrollHeight > container.clientHeight ||
                container.scrollWidth > container.clientWidth
            );
            if (isClipping) {
                this.isScrolling = true;
                if (this._scrollTimeout) {
                    clearTimeout(this._scrollTimeout);
                }
                // After 500ms of no wheel events, set isScrolling to false
                this._scrollTimeout = setTimeout(() => {
                    this.isScrolling = false;
                    this._scrollTimeout = null;
                }, 500);
            }
        }
    },
    template: html `
        <div class="container" :class="(cardStyle ? 'dashboard-card' + cardClasses + (isScrollingEnabled ? ' scrolling-enabled' : '') : '')">
            <div v-if="shouldShowHeader" class="container-header">
                <BreadcrumbComponent
                    :container-path="containerPath"
                    :title="title"
                    :card-style="cardStyle"
                    :container-id="containerId"
                    @navigate-to-path="(path) => $emit('navigate-to-path', path)" />
                <div style="flex-grow: 1;"></div>
                <div v-if="hamburgerMenuComponent || showExpandButton || !cardStyle" class="button-group">
                    <!-- <button v-if="!cardStyle"
                            class="button-symbol white"
                            @click="toggleDashboardState" 
                            title="Pin to dashboard">
                        <span class="material-symbols-outlined">{{ pinnedToDashboard ? 'keep_off' : 'keep' }}</span>
                    </button> -->
                    <button v-if="hamburgerMenuComponent"
                            class="button-symbol white" 
                            @click="openHamburgerMenu" 
                            title="Page Menu">☰</button>
                    <button v-if="showExpandButton" 
                            class="button-symbol white" 
                            @click="expandContainer" 
                            title="Expand to page">
                        <span class="material-symbols-outlined">expand_content</span>
                    </button>
                    <button v-if="containerPath && !cardStyle"
                            class="button-symbol white"
                            @click="bookmarkContainer"
                            title="Create bookmark">
                        <span class="material-symbols-outlined">bookmark</span>
                    </button>
                    <button v-if="containerPath && !cardStyle"
                            class="button-symbol white"
                            @click="shareContainer"
                            title="Share Page Link">
                        <span class="material-symbols-outlined">share</span>
                    </button>
                    <!-- <button v-if="!cardStyle" 
                            class="button-symbol white" 
                            @click="closeContainer" 
                            title="Close"><span class="material-symbols-outlined">close</span></button> -->
                </div>
            </div>
            
            <div class="content">
                <PageNoteComponent v-if="containerPath" :container-path="containerPath" />
                <BannerNotifications :banners="containerBanners" :scope="containerPath" />
                <div v-if="isLoading" class="loading-message" style="text-align:center; padding:2rem;">
                    <img src="assets/loading.gif" alt="..."/>
                    <p>Loading data...</p>
                </div>
                <slot v-else name="content">
                    <div class="content">
                        <div class="card red">
                            <p>nothing found at "{{ containerPath }}"</p>
                        </div>
                    </div>
                </slot>
            </div>
            <transition name="longfade">
                <div v-if="cardStyle && isScrolling && !isScrollingEnabled" class="container-expand-overlay" @click="expandContainer">
                    <span class="material-symbols-outlined">expand_content</span>
                </div>
            </transition>
        </div>
    `
};

