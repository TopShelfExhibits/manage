import { html, BreadcrumbComponent, NavigationRegistry, BannerNotifications, SEVERITY } from '../../index.js';
import { PageNoteComponent } from './pageNoteComponent.js';
import { URLRouter } from '../../utils/urlRouter.js';
import { viewportChrome } from '../../utils/useContainerSize.js';

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
        // A dashboard card: fills its cell, and its header has an expand button instead of the
        // page actions (bookmark, share)
        cardStyle: {
            type: Boolean,
            default: false
        },
        // Off for a dashboard card without a header (DashboardCell decides)
        showHeader: {
            type: Boolean,
            default: true
        },
        // No box of its own: the content sits straight in its place (the notices card)
        bare: {
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
    computed: {
        // A page in compact chrome: its header has an X back to the dashboard instead of its actions,
        // which move to the top of its page menu
        compactPage() {
            return !this.cardStyle && viewportChrome.compact;
        },
        // A page's own actions, in its header or its page menu
        pageActions() {
            if (this.cardStyle || !this.containerPath) return [];
            return [
                { key: 'bookmark', icon: 'bookmark', label: 'Bookmark', fn: this.bookmarkContainer },
                { key: 'share', icon: 'share', label: 'Share Link', fn: this.shareContainer }
            ];
        },
        headerActions() {
            return this.compactPage ? [] : this.pageActions;
        },
        hamburgerMenuComponent() {
            const menuActions = this.compactPage ? this.pageActions : null;
            return this.hamburgerMenuRegistry.getMenuComponent(this.containerType, this.containerPath, menuActions);
        },
        // Get navigation parameters from NavigationRegistry
        navigationParameters() {
            return NavigationRegistry.getNavigationParameters(this.containerPath);
        },
        containerBanners() {
            return this.$notify.getBanners(this.containerPath);
        }
    },
    methods: {
        openHamburgerMenu() {
            if (this.hamburgerMenuComponent) {
                this.$modal.custom(
                    this.hamburgerMenuComponent.components,
                    this.hamburgerMenuComponent.props || {},
                    this.title
                );
            }
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
        }
    },
    template: html `
        <div class="container" :class="{ 'dashboard-card': cardStyle, bare }">
            <div v-if="showHeader" class="container-header">
                <BreadcrumbComponent
                    :container-path="containerPath"
                    :title="title"
                    :card-style="cardStyle"
                    :container-id="containerId"
                    @navigate-to-path="(path) => $emit('navigate-to-path', path)" />
                <div style="flex-grow: 1;"></div>
                <div class="button-group">
                    <button v-if="hamburgerMenuComponent"
                            class="button-symbol white"
                            @click="openHamburgerMenu"
                            title="Page Menu">☰</button>
                    <button v-if="cardStyle"
                            class="button-symbol white" 
                            @click="expandContainer" 
                            title="Expand to page">
                        <span class="material-symbols-outlined">expand_content</span>
                    </button>
                    <button v-for="action in headerActions"
                            :key="action.key"
                            class="button-symbol white"
                            @click="action.fn"
                            :title="action.label">
                        <span class="material-symbols-outlined">{{ action.icon }}</span>
                    </button>
                    <button v-if="compactPage"
                            class="button-symbol white"
                            @click="$emit('navigate-to-path', 'dashboard')"
                            title="Close (back to the dashboard)">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
            </div>
            
            <div class="content">
                <PageNoteComponent v-if="containerPath" :container-path="containerPath" />
                <BannerNotifications :banners="containerBanners" :scope="containerPath" />
                <slot name="content">
                    <div class="content">
                        <div class="card red">
                            <p>nothing found at "{{ containerPath }}"</p>
                        </div>
                    </div>
                </slot>
            </div>
        </div>
    `
};

