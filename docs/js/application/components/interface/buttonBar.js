import { html } from '../../utils/template-helpers.js';

// A bar splits only with more children than this
const MIN_SPLIT_ITEMS = 3;

/**
 * Where to start a bar's second line: the split that makes the wider of the two lines narrowest
 * (children differ in width); between equal splits, the one nearest the middle, then the one with
 * the longer first line.
 * @param {number[]} widths - Each child's width, in order
 * @returns {number} Index of the first child on the second line (1 … widths.length - 1)
 */
export function balancedSplit(widths) {
    const total = widths.reduce((sum, width) => sum + width, 0);
    const middle = widths.length / 2;
    let best = Math.ceil(middle);
    let bestCost = Infinity;
    let first = 0;
    for (let index = 1; index < widths.length; index++) {
        first += widths[index - 1];
        const cost = Math.max(first, total - first);
        const asNear = Math.abs(index - middle) <= Math.abs(best - middle);
        if (cost < bestCost - 0.5 || (Math.abs(cost - bestCost) <= 0.5 && asNear)) {
            best = index;
            bestCost = cost;
        }
    }
    return best;
}

/**
 * ButtonBar — a .button-bar that takes a second line instead of overflowing. Use it in place of
 * <div class="button-bar"> where a bar can get long (CLAUDE.md "Styling"); children go in the
 * slot as before.
 *
 * With more than three children, when they don't fit on one line the bar moves the later ones
 * underneath (balancedSplit) and grows in height; when there is room again it goes back to one
 * line. A split bar is always two lines: each line shares its width in proportion to the
 * children's measured widths, shrinking rather than wrapping again. It measures with observers and
 * marks its state on the elements (data-split on the bar; data-bar-line, data-bar-corners and the
 * --bar-basis width on the children), which Vue leaves alone, so the parent's template and classes
 * stay as they are. styles.css draws the two lines and their corners.
 */
export const ButtonBar = {
    name: 'ButtonBar',
    template: html`<div class="button-bar"><slot></slot></div>`,
    mounted() {
        const schedule = () => this.scheduleMeasure();
        this._resizeObserver = new ResizeObserver(schedule);
        this._resizeObserver.observe(this.$el);
        if (this.$el.parentElement) this._resizeObserver.observe(this.$el.parentElement);
        // Children shown or hidden, and label changes, change the widths
        this._mutationObserver = new MutationObserver(schedule);
        this._mutationObserver.observe(this.$el, { childList: true, subtree: true, characterData: true });
        this.scheduleMeasure();
    },
    beforeUnmount() {
        this._resizeObserver?.disconnect();
        this._mutationObserver?.disconnect();
        if (this._frame) cancelAnimationFrame(this._frame);
    },
    methods: {
        scheduleMeasure() {
            if (this._frame) return;
            this._frame = requestAnimationFrame(() => {
                this._frame = null;
                this.measure();
            });
        },
        // Lay the children out on one line, unshrunk, to see whether they fit; all in one frame,
        // so the measuring layout is never drawn
        measure() {
            const bar = this.$el;
            if (!bar?.isConnected || bar.clientWidth === 0) return;
            const items = [...bar.children].filter(child => getComputedStyle(child).display !== 'none');
            let split = 0;
            let widths = [];
            if (items.length > MIN_SPLIT_ITEMS) {
                this.applySplit(bar, items, 0);
                bar.setAttribute('data-measuring', '');
                widths = items.map(child => child.getBoundingClientRect().width);
                if (bar.scrollWidth > bar.clientWidth + 1) split = balancedSplit(widths);
                bar.removeAttribute('data-measuring');
            }
            this.applySplit(bar, items, split, widths);
        },
        applySplit(bar, items, split, widths = []) {
            for (const child of bar.children) {
                child.removeAttribute('data-bar-line');
                child.removeAttribute('data-bar-corners');
                child.style.removeProperty('--bar-basis');
            }
            if (!split) {
                bar.removeAttribute('data-split');
                return;
            }
            bar.setAttribute('data-split', String(split));
            const last = items.length - 1;
            items.forEach((child, index) => {
                const corners = [];
                if (index === 0) corners.push('top-left');
                if (index === split - 1) corners.push('top-right');
                if (index === split) corners.push('bottom-left');
                if (index === last) corners.push('bottom-right');
                child.setAttribute('data-bar-corners', corners.join(' '));
                child.style.setProperty('--bar-basis', String(Math.round(widths[index])));
                if (index >= split) child.setAttribute('data-bar-line', '2');
            });
        }
    }
};
