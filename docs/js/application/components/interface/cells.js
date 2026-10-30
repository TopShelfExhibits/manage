import { html } from '../../utils/template-helpers.js';
import { NavigationRegistry } from '../../index.js';
import { isCheckedValue, checkboxWriteValue } from '../../../data_management/utils/checkbox-values.js';

/**
 * Cell registry (§4.14). A field with `cell: '<name>'` renders through the registry in every
 * renderer: table cells, calendar chip lines, card lines and the details grid.
 *
 * Every cell receives the same props:
 *   row, field, value, renderer ('table'|'calendar'|'cards'|'details'), density ('full'|'compact'),
 *   searchTerm (raw term, for navigation), highlight (fn(value, field) → safe HTML), theme,
 *   editable (the page's edit mode allows editing this field), commit(value) (report an edit:
 *   batch → cell-edit and dirty tracking; instant → the delayed cell-commit queue),
 *   disabled (a reason string when editing is blocked, e.g. "write disabled: no row identity")
 * Field-specific options come from `field.cellOptions` (what the data is, e.g. which key holds
 * the item number). An entry without a compact form falls back to formatted text when compact.
 *
 * `field.cell = 'slot'` is not a registry entry: the renderer calls the page's #cell slot instead.
 */

const cellProps = {
    row: { type: Object, required: true },
    field: { type: Object, required: true },
    value: { default: undefined },
    renderer: { type: String, default: 'table' },
    density: { type: String, default: 'full' },
    searchTerm: { type: String, default: '' },
    highlight: { type: Function, default: null },
    theme: { type: String, default: '' },
    editable: { type: Boolean, default: false },
    commit: { type: Function, default: null },
    disabled: { type: String, default: '' }
};

// ItemImageComponent lives in InventoryTable.js; load it lazily so this module never forms an
// evaluation-time import cycle with the content components.
const LazyItemImage = Vue.defineAsyncComponent(() =>
    import('../content/InventoryTable.js').then(m => m.ItemImageComponent)
);

const ImageCell = {
    name: 'ImageCell',
    props: cellProps,
    components: { LazyItemImage },
    computed: {
        opts() { return this.field.cellOptions || {}; },
        itemNumber() {
            const key = this.opts.itemKey || this.field.key;
            const v = this.row[key];
            return v == null ? '' : String(v);
        }
    },
    template: html`
        <LazyItemImage
            :itemNumber="itemNumber"
            :imageSize="opts.size || 64"
            :editable="!!opts.editable"
        />
    `
};

const TextCell = {
    name: 'TextCell',
    props: cellProps,
    computed: {
        html() {
            if (this.highlight) return this.highlight(this.value, this.field);
            return this.value == null ? '' : String(this.value)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
    },
    template: html`<span :class="field.cellOptions?.class || ''" v-html="html"></span>`
};

const NavigateCell = {
    name: 'NavigateCell',
    props: cellProps,
    inject: { appContext: { from: 'appContext', default: null } },
    computed: {
        opts() { return this.field.cellOptions || {}; },
        target() {
            try { return typeof this.opts.to === 'function' ? this.opts.to(this.row) : null; }
            catch { return null; }
        }
    },
    methods: {
        go() {
            if (!this.target) return;
            const path = this.searchTerm
                ? NavigationRegistry.buildPath(this.target, { searchTerm: this.searchTerm })
                : this.target;
            this.appContext?.navigateToPath?.(path);
        }
    },
    template: html`
        <button
            v-if="target"
            :class="['button-symbol', opts.class || theme || 'purple']"
            :title="opts.title || 'Open'"
            @click.stop="go"
        >{{ opts.icon || '☷' }}</button>
    `
};

/**
 * Checkbox (Phase 2). Reads `X`/TRUE as checked and anything else as unchecked (R7.3);
 * checking commits `X`, unchecking commits blank.
 */
const CheckboxCell = {
    name: 'CheckboxCell',
    props: cellProps,
    computed: {
        checked() { return isCheckedValue(this.value); },
        canEdit() { return this.editable && !!this.commit && !this.disabled; }
    },
    methods: {
        toggle(event) {
            if (!this.canEdit) { event.target.checked = this.checked; return; }
            this.commit(checkboxWriteValue(event.target.checked));
        }
    },
    template: html`
        <label :class="['cell-checkbox', { 'cell-readonly': !canEdit }]" :title="disabled || (canEdit ? '' : (checked ? 'Done' : 'Not done'))" @click.stop>
            <input type="checkbox" :checked="checked" :disabled="!canEdit" @change="toggle" />
        </label>
    `
};

/**
 * Select (Phase 2). Options come from field.cellOptions.options (page-supplied list). A current
 * value that isn't in the list still shows as an extra option, so nothing is hidden or overwritten.
 */
const SelectCell = {
    name: 'SelectCell',
    props: cellProps,
    computed: {
        current() { return this.value == null ? '' : String(this.value); },
        options() {
            const list = (this.field.cellOptions?.options || []).map(String);
            if (this.current && !list.some(o => o.trim().toLowerCase() === this.current.trim().toLowerCase())) list.push(this.current);
            return list;
        },
        canEdit() { return this.editable && !!this.commit && !this.disabled; }
    },
    methods: {
        change(event) {
            if (!this.canEdit) return;
            this.commit(event.target.value);
        }
    },
    template: html`
        <span v-if="!canEdit" class="cell-select-text" :title="disabled || ''">
            <span v-html="highlight ? highlight(value, field) : current"></span>
        </span>
        <select v-else class="cell-select" :value="current" @change="change" @click.stop>
            <option value=""></option>
            <option v-for="o in options" :key="o" :value="o">{{ o }}</option>
        </select>
    `
};

/**
 * Editable text that commits on blur (design queue Note). Uses the same contenteditable editor as
 * the table's editable text cells; read-only renders highlighted text. The commit goes through the
 * page's edit mode (instant: the delayed verified-write queue), so typing never writes per key.
 */
const EditTextCell = {
    name: 'EditTextCell',
    props: cellProps,
    data() { return { draft: null }; },
    computed: {
        current() { return this.value == null ? '' : String(this.value); },
        canEdit() { return this.editable && !!this.commit && !this.disabled; }
    },
    watch: {
        current() { this.syncEditor(); }
    },
    mounted() { this.syncEditor(); },
    updated() { this.syncEditor(); },
    methods: {
        // Keep the editor's text in step with the value, except while the user is typing in it
        syncEditor() {
            const el = this.$refs.editor;
            if (el && document.activeElement !== el && this.draft === null && el.textContent !== this.current) {
                el.textContent = this.current;
            }
        },
        onInput(e) { this.draft = e.target.textContent; },
        onBlur() {
            if (this.draft !== null && this.draft !== this.current) this.commit(this.draft);
            this.draft = null;
        }
    },
    template: html`
        <span v-if="!canEdit" :title="disabled || ''"><span v-html="highlight ? highlight(value, field) : current"></span></span>
        <div
            v-else
            ref="editor"
            contenteditable="true"
            class="table-edit-textarea"
            :data-placeholder="field.cellOptions?.placeholder || ''"
            @input="onInput"
            @blur="onBlur"
            @click.stop
        ></div>
    `
};

export const CELL_REGISTRY = {
    image: { full: ImageCell, compact: null },
    itemId: { full: TextCell, compact: TextCell },
    navigate: { full: NavigateCell, compact: null },
    checkbox: { full: CheckboxCell, compact: CheckboxCell },
    select: { full: SelectCell, compact: null },
    text: { full: EditTextCell, compact: null }
};

/**
 * Register (or replace) a cell type. Phase 2 adds checkbox and select through this.
 * @param {string} name
 * @param {{ full: Object, compact?: Object|null }} entry
 */
export function registerCell(name, entry) {
    CELL_REGISTRY[name] = entry;
}

/**
 * Resolve the component for a field at a density. Returns null when the field has no registry
 * cell (or no compact form), meaning the renderer should draw formatted text.
 * @param {{ cell?: string }} field
 * @param {'full'|'compact'} [density]
 * @returns {Object|null}
 */
export function cellComponentFor(field, density = 'full') {
    if (!field || !field.cell || field.cell === 'slot') return null;
    const entry = CELL_REGISTRY[field.cell];
    if (!entry) return null;
    return density === 'compact' ? (entry.compact || null) : (entry.full || null);
}

// ── Shared field-value renderer ──────────────────────────────────────────────

function escapeText(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * Renders one field value through the cell pipeline:
 *   registry cell → page #cell slot (field.cell === 'slot') → formatted, highlighted text.
 * Props: row, field, renderer, density, searchTerm, highlight(value, field) → HTML, theme,
 *        cellSlot (the page's #cell slot function, if any), format(value, field) → text
 */
export const CellRenderer = {
    name: 'CellRenderer',
    props: {
        row: { type: Object, required: true },
        field: { type: Object, required: true },
        renderer: { type: String, default: 'table' },
        density: { type: String, default: 'full' },
        searchTerm: { type: String, default: '' },
        highlight: { type: Function, default: null },
        format: { type: Function, default: null },
        theme: { type: String, default: '' },
        cellSlot: { type: Function, default: null },
        editable: { type: Boolean, default: false },
        commit: { type: Function, default: null },
        disabled: { type: String, default: '' },
        // Extra scope for the page's #cell slot (e.g. rowIndex, onInnerTableDirty in PacklistTable)
        cellScope: { type: Object, default: null }
    },
    render() {
        const h = Vue.h;
        const { row, field, renderer, density, searchTerm, highlight, theme, editable, commit, disabled } = this;
        const value = row ? row[field.key] : undefined;
        const comp = cellComponentFor(field, density);
        if (comp) {
            return h(comp, { row, field, value, renderer, density, searchTerm, highlight, theme, editable, commit, disabled });
        }
        if (field.cell === 'slot' && this.cellSlot) {
            return this.cellSlot({ ...(this.cellScope || {}), row, field, value, renderer, density });
        }
        let text;
        if (highlight) {
            text = highlight(value, field);
        } else {
            const formatted = this.format ? this.format(value, field) : value;
            text = escapeText(formatted);
        }
        return h('span', { innerHTML: text == null ? '' : String(text) });
    }
};

/**
 * Decoration cards (§4.14): { message (HTML), class|color, title|hoverMessage, action, disabled, button }.
 * `button: true` renders a <button> (e.g. "View Packlist"); otherwise a div/span card.
 */
export const DecorationCards = {
    name: 'DecorationCards',
    props: {
        cards: { type: Array, default: () => [] },
        inline: { type: Boolean, default: false }
    },
    methods: {
        cardClass(card) {
            return ['card', card.class || card.color || '', { clickable: !!card.action && !card.disabled }];
        },
        activate(card) {
            if (card.action && !card.disabled) card.action();
        }
    },
    template: html`
        <template v-for="(card, i) in cards" :key="(card.key || card.message) + '-' + i">
            <button
                v-if="card.button"
                :class="cardClass(card)"
                :disabled="card.disabled"
                :title="card.title || card.hoverMessage || null"
                @click.stop="activate(card)"
                v-html="card.message"
            ></button>
            <div
                v-else
                :class="[cardClass(card), inline ? 'card-inline' : '']"
                :title="card.title || card.hoverMessage || null"
                @click.stop="activate(card)"
                v-html="card.message"
            ></div>
        </template>
    `
};

/**
 * Split a row's decorations into those placed inline on displayed keys and the rest
 * (row-level cards plus cards for decorated keys the renderer doesn't display).
 * @param {Function|null} decorations  (row, key) → Card[]
 * @param {string[]} decorationKeys    keys the page decorates
 * @param {Object} row
 * @param {Set<string>|string[]} displayedKeys
 * @returns {{ byKey: Map<string, Object[]>, rowLevel: Object[] }}
 */
export function placeDecorations(decorations, decorationKeys, row, displayedKeys) {
    const byKey = new Map();
    const rowLevel = [];
    if (typeof decorations !== 'function' || !row) return { byKey, rowLevel };
    const shown = displayedKeys instanceof Set ? displayedKeys : new Set(displayedKeys || []);
    const safe = (key) => {
        try { return decorations(row, key) || []; } catch (e) { console.warn('[views] decorations failed', e); return []; }
    };
    for (const key of decorationKeys || []) {
        const cards = safe(key);
        if (!cards.length) continue;
        if (shown.has(key)) byKey.set(key, cards);
        else rowLevel.push(...cards);
    }
    rowLevel.push(...safe(null));
    return { byKey, rowLevel };
}
