import { html } from '../../index.js';


/**
 * NotificationBubbleOverlay — global fixed overlay showing alert bubbles for all
 * scrolled-out notifications from all BannerNotifications instances.
 *
 * Rendered once at the app level. Reads from notificationBus.getAllScrolledOutBanners().
 */
export const NotificationBubbleOverlay = {
    inject: ['$modal', '$notify'],
    computed: {
        scrolledOutBanners() {
            return this.$notify.getAllScrolledOutBanners();
        },
        showOverlay() {
            return this.scrolledOutBanners.length > 0;
        }
    },
    methods: {
        showAlertDetails(banner) {
            const dismissBanner = () => {
                // Remove the banner from the notification bus
                const scope = banner._scope;
                const currentBanners = this.$notify.getBanners(scope) || [];
                const filtered = currentBanners.filter(b => b.key !== banner.key);
                this.$notify.setBanners(scope, filtered);
            };

            // Only show dismiss option if the banner is dismissible
            const onCancel = banner.dismissible !== false ? dismissBanner : null;
            const cancelText = banner.dismissible !== false ? 'Dismiss' : null;

            this.$modal.confirm(
                String(banner.message || ''),
                () => {
                    if (banner.action) {
                        banner.action.fn();
                    }
                },
                onCancel,
                'Notification',
                banner.action ? banner.action.label : 'OK',
                cancelText,
                `reading-menu alert-modal ${banner.color}`
            );
        },

        getAlertSymbol(banner) {
            // Check if this is a bookmark banner by key pattern
            if (banner.key && banner.key.startsWith('bookmark-')) {
                return { type: 'material', symbol: 'bookmark' };
            }
            
            // Return a symbol based on the banner color
            const symbols = {
                red: { type: 'emoji', symbol: '⚠' },
                orange: { type: 'emoji', symbol: '⚠' },
                yellow: { type: 'emoji', symbol: '⚠' }
            };
            return symbols[banner.color] || { type: 'emoji', symbol: 'ℹ' };
        }
    },
    template: html`
        <transition name="fade">
            <div v-if="showOverlay" class="banner-notifications-bubble selection-action-bubble">
                <button
                    v-for="banner in scrolledOutBanners"
                    :key="banner._scope + '-' + banner.key"
                    @click="showAlertDetails(banner)"
                    :class="['button-symbol', banner.color || 'white']"
                    :title="banner.message"
                >
                    <span v-if="getAlertSymbol(banner).type === 'material'" class="material-symbols-outlined">{{ getAlertSymbol(banner).symbol }}</span>
                    <span v-else>{{ getAlertSymbol(banner).symbol }}</span>
                </button>
            </div>
        </transition>
    `
};



/**
 * BannerNotifications — renders a stack of status banners above table content.
 *
 * Each banner is an object with the shape:
 *   {
 *     key:       String   — unique key used for v-for and interval tracking
 *     color:     String   — card color class ('red', 'white', 'orange', 'purple', ...)
 *     message:   String   — text to display
 *     visible:   Boolean  — whether to render this banner
 *     dismissible?: Boolean — whether the dismiss button is enabled (default true)
 *     poll?: {            — optional: while visible, call fn on a recurring interval
 *       fn:          Function  — async function to call
 *       intervalMs:  Number   — interval in milliseconds
 *     }
 *   }
 *
 * Polling lifecycle:
 *   - An interval is started the first time a banner with `poll` becomes visible.
 *   - The interval is stopped when the banner is no longer visible or the component unmounts.
 *   - Intervals are never duplicated — reconciliation runs on every banners change.
 */
export const BannerNotifications = {
    inject: ['$modal', '$notify'],
    props: {
        banners: {
            type: Array,
            default: () => []
        },
        scope: {
            type: String,
            default: 'default'
        }
    },
    data() {
        return {
            dismissedKeys: {},
            bannersScrolledOut: false,
            scrollableParent: null
        };
    },
    created() {
        // Store interval IDs outside Vue reactivity — they are implementation detail, not state.
        this._pollIntervals = {};
        // Bind the scroll handler to preserve 'this' context
        this._boundScrollHandler = this.checkBannersVisibility.bind(this);
    },
    mounted() {
        // Find the scrollable parent container (typically #app-content)
        let scrollable = this.$el.parentElement;
        while (scrollable && scrollable !== document.body) {
            const style = window.getComputedStyle(scrollable);
            const overflowY = style.overflowY;
            if (overflowY === 'auto' || overflowY === 'scroll') {
                this.scrollableParent = scrollable;
                break;
            }
            scrollable = scrollable.parentElement;
        }
        
        if (!this.scrollableParent) {
            this.scrollableParent = window;
        }
        
        // Add scroll listener to the actual scrollable container
        this.scrollableParent.addEventListener('scroll', this._boundScrollHandler);
        this.$nextTick(() => this.checkBannersVisibility());
    },
    beforeUnmount() {
        if (this.scrollableParent) {
            this.scrollableParent.removeEventListener('scroll', this._boundScrollHandler);
        }
        Object.values(this._pollIntervals).forEach(id => clearInterval(id));
        this._pollIntervals = {};
    },
    computed: {
        visibleBanners() {
            return this.banners.filter(b => b.visible && !this.dismissedKeys[b.key]);
        }
    },
    watch: {
        banners: {
            handler(newBanners) {
                // Clear dismissed state for any banner that is no longer visible,
                // so it will re-show if its condition becomes true again.
                for (const banner of newBanners) {
                    if (!banner.visible && this.dismissedKeys[banner.key]) {
                        delete this.dismissedKeys[banner.key];
                    }
                }
                this._reconcilePolling(newBanners);
            },
            deep: true,
            immediate: true
        },
        visibleBanners() {
            // Re-check visibility when visible banners change
            this.$nextTick(() => this.checkBannersVisibility());
        },
        bannersScrolledOut(newValue) {
            // Report scroll state to the global notification bus
            this.$notify.setScrolledOut(this.scope, newValue, this.visibleBanners);
        }
    },
    methods: {
        checkBannersVisibility() {
            // Only check if we have visible banners and a valid DOM element
            if (!this.$el || !this.visibleBanners.length) {
                this.bannersScrolledOut = false;
                return;
            }
            
            // Find banner elements within this component's wrapper
            let bannerElements = [];
            try {
                bannerElements = Array.from(this.$el.querySelectorAll('.banner-notification'));
            } catch (e) {
                // If querySelectorAll fails, reset scroll state and return
                this.bannersScrolledOut = false;
                return;
            }
            
            if (bannerElements.length === 0) {
                this.bannersScrolledOut = false;
                return;
            }
            
            // Check the last banner's position (if all banners are scrolled out, the last one will be)
            const lastBanner = bannerElements[bannerElements.length - 1];
            const rect = lastBanner.getBoundingClientRect();
            
            // Consider banners scrolled out if the bottom is above the viewport top
            this.bannersScrolledOut = rect.bottom < 0;
        },

        dismiss(key) {
            const current = this.$notify.getBanners(this.scope) || [];
            const inBus = current.some(b => b.key === key);
            if (inBus) {
                // Remove from bus — triggers any watchers (e.g. localStorage save)
                this.$notify.setBanners(this.scope, current.filter(b => b.key !== key));
            } else {
                // Static banner not in bus — hide locally
                this.dismissedKeys = { ...this.dismissedKeys, [key]: true };
            }
        },

        _reconcilePolling(banners) {
            if (!this._pollIntervals) this._pollIntervals = {};
            const activeKeys = new Set();

            for (const banner of banners) {
                if (banner.visible && banner.poll) {
                    activeKeys.add(banner.key);
                    if (!this._pollIntervals[banner.key]) {
                        this._pollIntervals[banner.key] = setInterval(
                            () => banner.poll.fn(),
                            banner.poll.intervalMs
                        );
                    }
                }
            }

            // Clear intervals for banners that are no longer visible or no longer have poll config.
            for (const key of Object.keys(this._pollIntervals)) {
                if (!activeKeys.has(key)) {
                    clearInterval(this._pollIntervals[key]);
                    delete this._pollIntervals[key];
                }
            }
        }
    },
    template: html`
        <div v-if="visibleBanners.length" class="banner-notifications-container">
            <transition-group name="expand">
                <template v-for="banner in visibleBanners" :key="banner.key">
                    <div :class="['banner-notification', 'card', banner.color]" style="display: flex; align-items: center; justify-content: space-between; gap: var(--padding-sm);">
                        <span style="white-space: pre-wrap; overflow-wrap: break-word;">{{ banner.message }}</span>
                        <div v-if="banner.action && banner.dismissible !== false" class="button-bar">
                            <button
                                @click="banner.action.fn()"
                                :class="[banner.color]"
                            >{{ banner.action.label }}</button>
                            <button
                                @click="dismiss(banner.key)"
                                title="Dismiss"
                                :class="['button-symbol', banner.color]"
                            ><span class="material-symbols-outlined">close</span></button>
                        </div>
                        <slot v-else>
                            <button
                                v-if="banner.action"
                                @click="banner.action.fn()"
                                :class="[banner.color]"
                            >{{ banner.action.label }}</button>
                            <button
                                v-if="banner.dismissible !== false"
                                @click="dismiss(banner.key)"
                                title="Dismiss"
                                :class="['button-symbol', banner.color]"
                            ><span class="material-symbols-outlined">close</span></button>
                        </slot>
                    </div>
                </template>
            </transition-group>
        </div>
    `
};
