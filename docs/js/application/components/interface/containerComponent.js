import { html, BreadcrumbComponent, NavigationRegistry } from '../../index.js';

// Container component functionality
export const ContainerComponent = {
    components: {
        BreadcrumbComponent
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
    inject: ['hamburgerMenuRegistry', '$modal'],
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
        <div class="container" :class="(cardStyle ? 'dashboard-card' + cardClasses : '')">
            <div v-if="containerPath || title || cardStyle" class="container-header">
                <BreadcrumbComponent
                    :container-path="containerPath"
                    :title="title"
                    :card-style="cardStyle"
                    :container-id="containerId"
                    @navigate-to-path="(path) => $emit('navigate-to-path', path)" />
                <div style="flex-grow: 1;"></div>
                <div v-if="hamburgerMenuComponent || showExpandButton || !cardStyle" class="button-group">
                    <button v-if="!cardStyle"
                            class="button-symbol white"
                            @click="toggleDashboardState" 
                            title="Pin to dashboard">
                        <span class="material-symbols-outlined">{{ pinnedToDashboard ? 'keep_off' : 'keep' }}</span>
                    </button>
                    <button v-if="hamburgerMenuComponent"
                            class="button-symbol white" 
                            @click="openHamburgerMenu" 
                            title="Menu">☰</button>
                    <button v-if="showExpandButton" 
                            class="button-symbol white" 
                            @click="expandContainer" 
                            title="Expand to page">
                        <span class="material-symbols-outlined">expand_content</span>
                    </button>
                    <button v-if="!cardStyle" 
                            class="button-symbol white" 
                            @click="closeContainer" 
                            title="Close">🗙</button>
                </div>
            </div>
            
            <div class="content">
                <div v-if="isLoading" class="loading-message" style="text-align:center; padding:2rem;">
                    <img src="images/loading.gif" alt="..."/>
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
                <div v-if="cardStyle && isScrolling" class="container-expand-overlay" @click="expandContainer">
                    <span class="material-symbols-outlined">expand_content</span>
                </div>
            </transition>
        </div>
    `
};

