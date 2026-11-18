import { html, statusColor } from '../../index.js';

/**
 * Dismiss a banner: a banner in the bus is removed from it (which triggers its watchers, such as
 * the bookmark save); a static one is hidden in the bus's per-scope dismissals, so every
 * BannerNotifications drawing that scope hides it.
 */
function dismissBanner(notify, scope, key) {
    const current = notify.getBanners(scope) || [];
    if (current.some(b => b.key === key)) {
        notify.setBanners(scope, current.filter(b => b.key !== key));
    } else {
        notify.dismiss(scope, key);
    }
}


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
            // Only show dismiss option if the banner is dismissible
            const onCancel = banner.dismissible !== false ? () => dismissBanner(this.$notify, banner._scope, banner.key) : null;
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
                `reading-menu alert-modal ${statusColor(banner)}`
            );
        },

        getAlertSymbol(banner) {
            // Check if this is a bookmark banner by key pattern
            if (banner.key && banner.key.startsWith('bookmark-')) {
                return { type: 'material', symbol: 'bookmark' };
            }
            
            // A warning sign for the critical, warning and attention colours
            const symbols = {
                red: { type: 'emoji', symbol: '⚠' },
                orange: { type: 'emoji', symbol: '⚠' },
                yellow: { type: 'emoji', symbol: '⚠' }
            };
            return symbols[statusColor(banner)] || { type: 'emoji', symbol: 'ℹ' };
        },
        statusColor
    },
    template: html`
        <transition name="fade">
            <div v-if="showOverlay" class="banner-notifications-bubble selection-action-bubble">
                <button
                    v-for="banner in scrolledOutBanners"
                    :key="banner._scope + '-' + banner.key"
                    @click="showAlertDetails(banner)"
                    :class="['button-symbol', statusColor(banner) || 'white']"
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
 *     severity:  String   — SEVERITY ('critical', 'warning', 'info', ...); its colour comes from
 *                            application/utils/severity.js. Omit it for a plain banner.
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
 *
 * Corner tray: banners scrolled above their scrolling parent's top are reported to the
 * notification bus, and NotificationBubbleOverlay shows them as bubbles. `collapsed` draws
 * nothing and reports every visible banner, so they go straight to the tray (the dashboard
 * without a notices card).
 *
 * Slot `empty`: drawn instead when no banner is visible (the notices page's "No notices").
 */
let _instanceCount = 0;

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
        },
        collapsed: {
            type: Boolean,
            default: false
        }
    },
    data() {
        return {
            bannersScrolledOut: false
        };
    },
    created() {
        this._reportKey = `${this.scope}#${++_instanceCount}`;
        // Store interval IDs outside Vue reactivity — they are implementation detail, not state.
        this._pollIntervals = {};
        // The element whose scrolling last moved these banners (#app-content, or a dashboard
        // card's content). A page's banners move between the two when a card is expanded, so
        // it is taken from the scroll event rather than found once.
        this._scrollParentEl = null;
        this._boundScrollHandler = (event) => {
            const target = event.target;
            if (target instanceof Element && this.$el && target.contains(this.$el)) {
                this._scrollParentEl = target;
                this.checkBannersVisibility();
            }
        };
    },
    mounted() {
        // Scroll events don't bubble: listen in the capture phase for every scrolling element
        document.addEventListener('scroll', this._boundScrollHandler, { capture: true, passive: true });
        this.$nextTick(() => this.checkBannersVisibility());
    },
    beforeUnmount() {
        document.removeEventListener('scroll', this._boundScrollHandler, { capture: true });
        Object.values(this._pollIntervals).forEach(id => clearInterval(id));
        this._pollIntervals = {};
        this.$notify.setScrolledOut(this._reportKey, this.scope, false);
    },
    computed: {
        visibleBanners() {
            return this.banners.filter(b => b.visible && !this.$notify.isDismissed(this.scope, b.key));
        },
        // What this instance reports to the corner tray
        trayReport() {
            const out = this.collapsed || this.bannersScrolledOut;
            return { out, banners: out ? this.visibleBanners : [] };
        }
    },
    watch: {
        banners: {
            handler(newBanners) {
                // Clear dismissed state for any banner that is no longer visible,
                // so it will re-show if its condition becomes true again.
                for (const banner of newBanners) {
                    if (!banner.visible) this.$notify.undismiss(this.scope, banner.key);
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
        collapsed() {
            this.$nextTick(() => this.checkBannersVisibility());
        },
        trayReport: {
            handler({ out, banners }) {
                // Report scroll state to the global notification bus
                this.$notify.setScrolledOut(this._reportKey, this.scope, out, banners);
            },
            immediate: true
        }
    },
    methods: {
        checkBannersVisibility() {
            // Only check if we have visible banners and a valid DOM element
            if (this.collapsed || !this.$el || !this.visibleBanners.length) {
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
            
            // Scrolled out once the bottom is above the scrolling parent's top: the viewport top
            // for #app-content (fixed at the top of the window), the card's top in a dashboard card
            const parentTop = this._scrollParentEl?.isConnected
                ? Math.max(0, this._scrollParentEl.getBoundingClientRect().top)
                : 0;
            this.bannersScrolledOut = rect.bottom < parentTop;
        },

        dismiss(key) {
            dismissBanner(this.$notify, this.scope, key);
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
        },
        statusColor
    },
    template: html`
        <div v-if="visibleBanners.length && !collapsed" class="banner-notifications-container">
            <transition-group name="expand">
                <template v-for="banner in visibleBanners" :key="banner.key">
                    <div :class="['banner-notification', 'card', statusColor(banner)]" style="display: flex; align-items: center; justify-content: space-between; gap: var(--padding-sm);">
                        <span style="white-space: pre-wrap; overflow-wrap: break-word;">{{ banner.message }}</span>
                        <div v-if="banner.action && banner.dismissible !== false" class="button-bar">
                            <button
                                @click="banner.action.fn()"
                                :class="[statusColor(banner)]"
                            >{{ banner.action.label }}</button>
                            <button
                                @click="dismiss(banner.key)"
                                title="Dismiss"
                                :class="['button-symbol', statusColor(banner)]"
                            ><span class="material-symbols-outlined">close</span></button>
                        </div>
                        <slot v-else>
                            <button
                                v-if="banner.action"
                                @click="banner.action.fn()"
                                :class="[statusColor(banner)]"
                            >{{ banner.action.label }}</button>
                            <button
                                v-if="banner.dismissible !== false"
                                @click="dismiss(banner.key)"
                                title="Dismiss"
                                :class="['button-symbol', statusColor(banner)]"
                            ><span class="material-symbols-outlined">close</span></button>
                        </slot>
                    </div>
                </template>
            </transition-group>
        </div>
        <slot v-else-if="!collapsed" name="empty"></slot>
    `
};
