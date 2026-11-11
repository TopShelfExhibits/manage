const { reactive } = Vue;

/**
 * notificationBus — reactive singleton for scoped banner notifications.
 *
 * Content components call setBanners(scope, banners) to push their banner
 * state up to the BannerNotifications rendered inside ContainerComponent.
 * Use containerPath as the scope key. Call clearBanners(scope) on beforeUnmount.
 *
 * App-level banners (auth, network) are handled via a computed in app.js and
 * passed directly to BannerNotifications — they do not go through this bus.
 * They can be drawn by more than one BannerNotifications (the top of the page, or the dashboard's
 * notices card), so dismissals are kept here per scope, not in the component.
 *
 * Scrolled-out reports feed the corner tray (NotificationBubbleOverlay). Each BannerNotifications
 * reports under its own key, so two instances of one scope never overwrite each other.
 */
const _store = reactive({});
const _scrolledOutState = reactive({});
const _dismissed = reactive({});

export const notificationBus = {
    setBanners(scope, banners) {
        _store[scope] = banners;
    },
    getBanners(scope) {
        return _store[scope] || [];
    },
    clearBanners(scope) {
        delete _store[scope];
        for (const key in _scrolledOutState) {
            if (_scrolledOutState[key].scope === scope) delete _scrolledOutState[key];
        }
    },
    /**
     * Report a BannerNotifications instance's banners as out of view (shown in the corner tray)
     * @param {string} reportKey - unique per instance
     * @param {string} scope - the banners' scope (used to dismiss them from the tray)
     */
    setScrolledOut(reportKey, scope, isScrolledOut, visibleBanners) {
        if (isScrolledOut && visibleBanners && visibleBanners.length > 0) {
            _scrolledOutState[reportKey] = { scope, banners: visibleBanners };
        } else {
            delete _scrolledOutState[reportKey];
        }
    },
    getAllScrolledOutBanners() {
        const allBanners = [];
        for (const key in _scrolledOutState) {
            const { scope, banners } = _scrolledOutState[key];
            if (Array.isArray(banners)) {
                allBanners.push(...banners.map(b => ({ ...b, _scope: scope })));
            }
        }
        return allBanners;
    },
    /** Hide a banner that isn't in the bus (a static one) until it stops being visible */
    dismiss(scope, key) {
        if (!_dismissed[scope]) _dismissed[scope] = {};
        _dismissed[scope][key] = true;
    },
    isDismissed(scope, key) {
        return !!_dismissed[scope]?.[key];
    },
    /** Forget a dismissal, so the banner shows again the next time it becomes visible */
    undismiss(scope, key) {
        if (_dismissed[scope]) delete _dismissed[scope][key];
    }
};
