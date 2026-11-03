/**
 * Size model (§4.10): three tiers in two scopes.
 *
 *   tier     container width      viewport width (gutter-adjusted)
 *   wide     >= 1000px            >= 1000 + 2*12 = 1024px
 *   medium   600 – 999px          616 – 1023px
 *   narrow   < 600px              < 600 + 2*8   = 616px
 *
 * Container scope (useContainerSize, CSS @container) covers content and views; it measures the
 * content box of the nearest `container-type: inline-size` ancestor (.container, .modal > .content),
 * with the same thresholds as the CSS, so JS and CSS agree and there is no hysteresis.
 * Viewport scope (useViewportSize, CSS @media) covers app chrome and dashboard layout.
 *
 * CSS cannot read these constants: every @media / @container rule repeats the literals as
 * calc(600px + 2 * 8px) etc. with a comment pointing here. Keep them in sync with theme.css.
 */

export const BREAKPOINTS = Object.freeze({ narrow: 600, wide: 1000, gutterCompact: 8, gutterFull: 12 });

/** Tier for a container content-box width. */
export function containerTier(width) {
    if (!(width >= 0)) return 'wide';
    if (width < BREAKPOINTS.narrow) return 'narrow';
    if (width < BREAKPOINTS.wide) return 'medium';
    return 'wide';
}

/**
 * Tier for a viewport width. Thresholds include the #app-content gutter in effect on the larger
 * side of each boundary, so a viewport tier matches the tier of a full-width page container.
 */
export function viewportTier(width) {
    if (!(width >= 0)) return 'wide';
    if (width < BREAKPOINTS.narrow + 2 * BREAKPOINTS.gutterCompact) return 'narrow';
    if (width < BREAKPOINTS.wide + 2 * BREAKPOINTS.gutterFull) return 'medium';
    return 'wide';
}

/** Find the nearest ancestor (or self) that is a CSS inline-size container. */
export function findSizeContainer(el) {
    let node = el instanceof Element ? el : null;
    while (node && node !== document.documentElement) {
        const style = getComputedStyle(node);
        if (style.containerType === 'inline-size' || style.containerType === 'size') return node;
        node = node.parentElement;
    }
    return null;
}

/**
 * Observe the container tier of an element's nearest size container.
 * Usage (options API):
 *   created() { this._size = useContainerSize(); }
 *   mounted() { this._size.observe(this.$el); }  // reactive: this._size.tier.value
 *   beforeUnmount() { this._size.stop(); }
 * @returns {{ tier: import('vue').Ref<string>, width: import('vue').Ref<number>, observe(el: Element): void, stop(): void }}
 */
export function useContainerSize() {
    const tier = Vue.ref('wide');
    const width = Vue.ref(0);
    let observer = null;

    function measure(target) {
        const cs = getComputedStyle(target);
        const w = target.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
        width.value = w;
        tier.value = containerTier(w);
    }

    function observe(el) {
        stop();
        const target = findSizeContainer(el);
        if (!target) { tier.value = 'wide'; return; }
        measure(target);
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(entries => {
                const entry = entries[0];
                const w = entry?.contentRect?.width;
                if (typeof w === 'number') {
                    width.value = w;
                    tier.value = containerTier(w);
                } else {
                    measure(target);
                }
            });
            observer.observe(target);
        }
    }

    function stop() {
        if (observer) { observer.disconnect(); observer = null; }
    }

    return { tier, width, observe, stop };
}

/**
 * Observe the viewport tier.
 * @returns {{ tier: import('vue').Ref<string>, width: import('vue').Ref<number>, stop(): void }}
 */
export function useViewportSize() {
    const width = Vue.ref(typeof window !== 'undefined' ? window.innerWidth : 0);
    const tier = Vue.ref(viewportTier(width.value));
    const onResize = () => {
        width.value = window.innerWidth;
        tier.value = viewportTier(width.value);
    };
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize, { passive: true });
    return {
        tier,
        width,
        stop() { if (typeof window !== 'undefined') window.removeEventListener('resize', onResize); }
    };
}
