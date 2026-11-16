import { viewportChrome } from './useContainerSize.js';
import { createScrollHider } from './scrollHider.js';

/**
 * useStickyHeader — shared sticky header scroll/resize logic
 *
 * Handles scroll and resize listener lifecycle and the activation check shared
 * by TableComponent (.sticky-header-wrapper) and CalendarComponent (.sticky-header-wrapper).
 *
 * CONSUMERS: tableComponent, calendarComponent, cardsComponent
 *
 * DOM PATTERN (tableComponent / cardsComponent):
 *   .sticky-header-spacer  — always in flow; height:0 inactive, wrapper.offsetHeight active.
 *                            Used as getAnchorEl for a position-stable activation trigger.
 *                            If padding-bottom is needed below the header, add it to the
 *                            wrapper's inactive style so offsetHeight includes it, preserving
 *                            the gap when the spacer takes over.
 *   .sticky-header-wrapper — position:fixed when active, normal flow otherwise.
 *   [data container]       — always in flow below the wrapper.
 *
 * FRAGMENT-ROOT COMPONENTS (cardsComponent uses <slot> as template root):
 *   this.$el is a text/comment node — querySelector fails. Use $refs on each element instead.
 *   Also, fragment children become direct flex items of the parent (#app-content has gap),
 *   so the 0-height spacer generates an extra gap. Wrap template content in a real <div>.
 *
 * DEACTIVATION BOUNDARIES — pass getContainerEl as an array to check multiple limits:
 *   tableComponent:   [tableWrapper, .container ancestor]
 *   calendarComponent:[this.$el, .container ancestor]
 *   cardsComponent:   [$refs.cardsGridEl, stickySpacerEl.closest('.container')]
 *
 * OSCILLATION GUARD — _peakStickyHeight caches the max wrapper height seen so the
 *   container-bottom threshold doesn't shrink when a clone/child is removed, which
 *   would otherwise cause rapid activate/deactivate cycling at the data boundary.
 *
 * CSS OFFSET — navbar offset is determined by reading the actual navbar element's bottom position
 *   from the DOM (getBoundingClientRect). When nav.hidden, max-height:0 collapses the navbar so
 *   bottom≈0, allowing sticky headers to activate at viewport top. When visible, bottom equals
 *   navbar-height (80px/50px), so sticky headers appear below it. This real-time DOM reading
 *   prevents timing issues with CSS variable updates during scroll events. On a short screen
 *   (viewportChrome.short) the nav is on the left edge and the offset is 0.
 *
 * SHORT SCREENS — a sticky header starts collapsed where it would stick and scrolls away in its
 *   place. It slides in only when the user scrolls back up below its place, and out again on the
 *   way down, with the primary nav's steps and timing (scrollHider.js, .sticky-hidden).
 *
 * DASHBOARD CARDS — a dashboard card's content scrolls by itself. Inside one, the top edge is the
 *   card content's top instead of the navbar, written to --navbar-sticky-offset on the card content
 *   so the fixed wrapper's CSS top follows. The context is checked on every update: a page keeps
 *   its component when a card is expanded to the full page and back.
 *
 * @param {Object}   options
 * @param {Function} options.getStickyEl    () => the element to make sticky (used for height/top measurement)
 * @param {Function} [options.getAnchorEl]  () => stable reference element whose top is used for the activation
 *                                               check. Its position must not change when sticky activates/deactivates.
 *                                               When provided, avoids oscillation from spacer/wrapper height feedback.
 * @param {Function} [options.getSpacerEl]  () => spacer element that stays in document flow (used when no anchor)
 * @param {Function} options.getContainerEl () => element or array of elements for the container-bottom deactivation
 *                                               check. Sticky deactivates when ANY element's bottom is too close
 *                                               to the navbar (e.g. pass [tableWrapper, containerCard] to respect
 *                                               both the data boundary and the dashboard card boundary).
 * @param {Function} options.getIsActive    () => boolean — is the sticky currently active?
 * @param {Function} [options.canActivate]  () => boolean — optional extra prerequisite (e.g. horizontal scroll check)
 * @param {Function} options.onActivate     () => void — called every scroll tick while sticky
 * @param {Function} options.onDeactivate   () => void — called every scroll tick while not sticky
 */
export function useStickyHeader({
    getStickyEl,
    getAnchorEl,
    getSpacerEl,
    getContainerEl,
    getIsActive,
    canActivate,
    onActivate,
    onDeactivate,
}) {
    let _scrollEl = null;
    let _fn = null;
    let _navEl = null;
    let _navTransitionFn = null;
    // Peak height cache: the sticky wrapper grows when the thead clone is added (showStickyHeader=true)
    // and shrinks when it is removed. Using the raw height for the container-bottom check causes
    // oscillation at the table bottom (deactivate → shrink → check passes → re-activate → grow →
    // check fails → deactivate again…). Caching the maximum seen height keeps the threshold stable.
    let _peakStickyHeight = 0;
    // The dashboard card content the sticky element was last measured in (holds the offset property)
    let _cardEl = null;
    // Short screens: the slide-in steps, and whether they're counting (the header would stick)
    const _hider = createScrollHider();
    let _counting = false;

    function _getTopOffsetPx(stickyEl) {
        const cardEl = stickyEl.closest('.dashboard-card > .content');
        if (_cardEl && _cardEl !== cardEl) _cardEl.style.removeProperty('--navbar-sticky-offset');
        _cardEl = cardEl;
        if (!cardEl) return _getNavbarOffsetPx();
        const top = Math.max(0, cardEl.getBoundingClientRect().top);
        cardEl.style.setProperty('--navbar-sticky-offset', `${top}px`);
        return top;
    }

    function _getNavbarOffsetPx() {
        // On a short screen the nav is on the left edge: nothing covers the top
        if (viewportChrome.short) return 0;
        // Get actual navbar bottom position from the DOM to handle nav.hidden state correctly.
        // When navbar is hidden (max-height:0), bottom will be at/near 0.
        // When navbar is visible, bottom will be at navbar-height (80px desktop, 50px mobile).
        // This ensures sticky headers activate at the correct scroll position in real-time.
        const navbar = document.querySelector('header nav');
        if (!navbar) {
            // Fallback to CSS variable if navbar element not found
            const root = document.documentElement;
            const computed = getComputedStyle(root);
            const heightStr = computed.getPropertyValue('--navbar-sticky-offset').trim();
            const heightPx = parseFloat(heightStr);
            return isNaN(heightPx) ? 0 : heightPx;
        }
        
        const rect = navbar.getBoundingClientRect();
        // Use bottom position, which will be 0 when hidden, navbar-height when visible
        return Math.max(0, rect.bottom);
    }

    function _update() {
        const stickyEl = getStickyEl?.();
        if (!stickyEl) return;

        // Get navbar offset from actual DOM position — accounts for nav.hidden state in real-time
        // (in a dashboard card, the card content's top)
        const navHeightPx = _getTopOffsetPx(stickyEl);

        // Determine "flow top" for the activation check.
        // Prefer a stable anchor element whose position is invariant with respect to sticky state
        // (avoids the oscillation caused by spacer/wrapper height changes at the activation boundary).
        let flowTop;
        const anchorEl = getAnchorEl?.();
        if (anchorEl) {
            flowTop = anchorEl.getBoundingClientRect().top;
        } else {
            // Fallback: measure from spacer when active, from sticky element itself when not
            const isActive = getIsActive?.() ?? false;
            const spacerEl = getSpacerEl?.();
            const flowEl = (isActive && spacerEl) ? spacerEl : stickyEl;
            flowTop = flowEl.getBoundingClientRect().top;
        }

        // Cache the peak height so the container-bottom threshold stays consistent regardless of
        // whether the thead clone is currently rendered inside the wrapper.
        const rawStickyHeight = stickyEl.offsetHeight;
        if (rawStickyHeight > _peakStickyHeight) _peakStickyHeight = rawStickyHeight;
        const stickyHeight = _peakStickyHeight || rawStickyHeight;

        // Container-bottom check: deactivate when the sticky header would overlap any container's bottom.
        // getContainerEl may return a single element or an array (e.g. [tableWrapper, dashboardCard]).
        const containerResult = getContainerEl?.();
        const containerEls = Array.isArray(containerResult)
            ? containerResult
            : (containerResult ? [containerResult] : []);

        let shouldActivate = flowTop <= navHeightPx;

        if (shouldActivate) {
            for (const el of containerEls) {
                const rect = el?.getBoundingClientRect();
                if (rect && rect.bottom - navHeightPx < stickyHeight) {
                    shouldActivate = false;
                    break;
                }
            }
        }

        // Component-provided prerequisite (e.g. disable when table is horizontally scrollable)
        if (shouldActivate && canActivate && !canActivate()) {
            shouldActivate = false;
        }

        // The header's place in the flow (from flowTop, its full height) reaches below the top edge
        const placeInView = flowTop + stickyHeight > navHeightPx;
        const collapsed = _collapsedOnShortScreen(shouldActivate, placeInView);
        // Collapsed over its own place, it stays in that place instead of sticking (no gap shows)
        const stick = shouldActivate && !(collapsed && placeInView);
        if (stick) {
            onActivate();
        } else {
            onDeactivate();
        }
        // Stuck and collapsed, it retracts in CSS without moving anything (clip-path)
        stickyEl.classList.toggle('sticky-hidden', stick && collapsed);
    }

    // Short screens: the header doesn't follow on the way down. It starts collapsed where it would
    // stick, so it scrolls away in its place. Scrolling back up below its place slides it in, and
    // scrolling down slides it out again (the primary nav's steps, scrollHider).
    function _collapsedOnShortScreen(wouldStick, placeInView) {
        const scroller = _cardEl || document.getElementById('app-content');
        const wasCounting = _counting;
        _counting = wouldStick && viewportChrome.short && !!scroller;
        if (!_counting) return false;
        if (!wasCounting || (placeInView && _hider.hidden)) {
            _hider.reset(scroller.scrollTop, true); // it can't slide in over its own place
        } else {
            _hider.update(scroller.scrollTop);
        }
        return _hider.hidden;
    }

    function setup() {
        _peakStickyHeight = 0;
        // Scrolls of #app-content or of the dashboard card holding the sticky element. Scroll events
        // don't bubble, so listen in the capture phase.
        _scrollEl = document;
        _fn = (event) => {
            const target = event?.target;
            if (target instanceof Element && !target.contains(getStickyEl?.() || null)) return;
            _update();
        };
        _scrollEl.addEventListener('scroll', _fn, { capture: true, passive: true });
        window.addEventListener('resize', _fn, { passive: true });

        // Re-evaluate sticky position after navbar height animation completes
        _navEl = document.querySelector('header nav');
        if (_navEl) {
            _navTransitionFn = () => _update();
            _navEl.addEventListener('transitionend', _navTransitionFn, { passive: true });
        }
        
        // Initial update in current tick
        _update();
        
        // Always schedule a second update after layout settles: getBoundingClientRect() can be
        // stale before the browser finishes layout (replaces the old 768px heuristic, size model §4.10).
        setTimeout(() => _update(), 100);
    }

    function teardown() {
        if (_scrollEl && _fn) {
            _scrollEl.removeEventListener('scroll', _fn, { capture: true });
            window.removeEventListener('resize', _fn);
        }
        if (_cardEl) _cardEl.style.removeProperty('--navbar-sticky-offset');
        _cardEl = null;
        if (_navEl && _navTransitionFn) {
            _navEl.removeEventListener('transitionend', _navTransitionFn);
        }
        _fn = null;
        _scrollEl = null;
        _navEl = null;
        _navTransitionFn = null;
    }

    function reset() {
        // Reset peak height cache when navigation occurs (allows sticky header dimensions to adjust)
        _peakStickyHeight = 0;
    }

    return { setup, teardown, update: _update, reset };
}
