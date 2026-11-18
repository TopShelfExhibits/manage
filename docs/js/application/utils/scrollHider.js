/**
 * Hide-on-scroll steps, shared so every bar that hides feels the same: the primary nav on narrow
 * screens (PrimaryNavComponent) and sticky headers on short screens (useStickyHeader).
 *
 * Scrolling down more than HIDE_AFTER_PX past the last turn hides; scrolling up more than
 * SHOW_AFTER_PX past it, or reaching the top, shows. Each hide or show is a new turn. Both bars
 * animate over the same 0.2s ease in CSS.
 *
 * A plain state object: held in a component's data, its `hidden` is reactive.
 */
const HIDE_AFTER_PX = 12;
const SHOW_AFTER_PX = 64;

export function createScrollHider() {
    return {
        hidden: false,
        lastTurn: 0,
        /** Start counting from here, shown or (a sticky header on a short screen) hidden */
        reset(scrollTop, hidden = false) {
            this.lastTurn = scrollTop;
            this.hidden = hidden;
        },
        /** Show without a new turn (too little to scroll, or a new page) */
        show() {
            this.hidden = false;
        },
        update(scrollTop) {
            if (scrollTop > this.lastTurn + HIDE_AFTER_PX) {
                this.reset(scrollTop, true);
            } else if (scrollTop < this.lastTurn - SHOW_AFTER_PX || scrollTop <= 0) {
                this.reset(scrollTop, false);
            }
            return this.hidden;
        }
    };
}
