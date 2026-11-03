import { html } from '../../utils/template-helpers.js';
import { isCheckedValue, checkboxWriteValue } from '../../../data_management/utils/checkbox-values.js';
import { escapeHtml, formatText } from '../../utils/views/fieldFormat.js';

/**
 * Cell registry (views-and-renderers-plan §4.14). A resolved field with `cell: '<name>'` renders
 * through the registry in every renderer: table cells, calendar chip lines, card lines and the
 * details grid. The cell comes from the field's type (checkbox, select) or the view's
 * style[key].cell; pages never put it on fields.
 *
 * Every cell receives the same props:
 *   row, field, value, renderer ('table'|'calendar'|'cards'|'details'), density ('full'|'compact'),
 *   searchTerm (raw term, for navigation), highlight (fn(value, field) → safe HTML), theme,
 *   editable (the cell may be edited now: edit mode on, a commit wired, nothing blocking it),
 *   editMode ('batch'|'instant'; when a text cell reports: batch on every change, instant when
 *   editing ends), commit(value) (report an edit: batch → cell-edit and dirty tracking;
 *   instant → the delayed write queue), disabled (why editing is blocked; shown as the tooltip)
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
    editMode: { type: String, default: '' },
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

// Read-only value as HTML: the renderer's highlighter (which formats and escapes), else escaped text
function readOnlyHtml(cell) {
    return cell.highlight ? cell.highlight(cell.value, cell.field) : escapeHtml(cell.value);
}

const TextCell = {
    name: 'TextCell',
    props: cellProps,
    computed: {
        html() { return readOnlyHtml(this); }
    },
    template: html`<span :class="field.cellOptions?.class || ''" v-html="html"></span>`
};

/**
 * Checkbox. Reads `X`/TRUE as checked and anything else as unchecked; checking commits `X`,
 * unchecking commits blank.
 */
const CheckboxCell = {
    name: 'CheckboxCell',
    props: cellProps,
    computed: {
        checked() { return isCheckedValue(this.value); }
    },
    methods: {
        toggle(event) {
            if (!this.editable) { event.target.checked = this.checked; return; }
            this.commit(checkboxWriteValue(event.target.checked));
        }
    },
    template: html`
        <label :class="['cell-checkbox', { 'cell-readonly': !editable }]" :title="disabled || null" @click.stop>
            <input type="checkbox" :checked="checked" :disabled="!editable" @change="toggle" />
        </label>
    `
};

/**
 * Select. The allowed values are data: field.options (the page supplies the list ColumnTypes
 * names). cellOptions.colors (view presentation) maps an option to a colour word, which styles
 * the select with that colour class. A current value that isn't in the list still shows as an
 * extra option, so nothing is hidden or overwritten.
 */
const SelectCell = {
    name: 'SelectCell',
    props: cellProps,
    computed: {
        current() { return this.value == null ? '' : String(this.value); },
        readOnly() { return readOnlyHtml(this); },
        options() {
            const list = (Array.isArray(this.field.options) ? this.field.options : []).map(String);
            if (this.current && !list.some(o => o.trim().toLowerCase() === this.current.trim().toLowerCase())) list.push(this.current);
            return list;
        },
        // Colour class of the chosen option (field.cellOptions.colors: { option: colour word })
        colorClass() {
            const colors = this.field.cellOptions?.colors || {};
            const key = Object.keys(colors).find(o => o.trim().toLowerCase() === this.current.trim().toLowerCase());
            return key ? colors[key] : '';
        }
    },
    methods: {
        change(event) {
            if (!this.editable) return;
            this.commit(event.target.value);
        }
    },
    template: html`
        <span v-if="!editable" class="cell-select-text" :title="disabled || ''">
            <span v-html="readOnly"></span>
        </span>
        <select v-else :class="['cell-select', colorClass]" :value="current" @change="change" @click.stop>
            <option value=""></option>
            <option v-for="o in options" :key="o" :value="o">{{ o }}</option>
        </select>
    `
};

/**
 * Editable text: the one text editor for every edit mode (contenteditable, plain text only).
 *   batch    every change is reported, so the page's rows and dirty tracking follow the typing
 *   instant  the finished edit is reported when the editor loses focus, so typing never writes
 * Pasting inserts plain text. In batch mode, pasted text with tabs or line breaks is left to the
 * table, which pastes it as rows. Read-only renders highlighted text.
 */
const EditTextCell = {
    name: 'EditTextCell',
    props: cellProps,
    data() { return { draft: null }; },
    computed: {
        current() { return this.value == null ? '' : String(this.value); },
        readOnly() { return readOnlyHtml(this); }
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
        // Batch reports each change (the value follows the typing); instant keeps a draft until blur
        onInput() {
            const text = this.$refs.editor.textContent;
            if (this.editMode === 'batch') this.commit(text);
            else this.draft = text;
        },
        onBlur() {
            if (this.draft !== null && this.draft !== this.current) this.commit(this.draft);
            this.draft = null;
            this.syncEditor();
        },
        onPaste(event) {
            const text = event.clipboardData?.getData('text/plain') || '';
            event.preventDefault();
            if (!text) return;
            if (this.editMode === 'batch' && /[\t\n]/.test(text)) {
                // The table's paste handler runs on the same event; leave the cell so it isn't edited too
                event.target.blur();
                return;
            }
            const selection = window.getSelection();
            if (!selection || !selection.rangeCount) return;
            selection.deleteFromDocument();
            selection.getRangeAt(0).insertNode(document.createTextNode(text));
            selection.collapseToEnd();
            this.onInput();
        }
    },
    template: html`
        <span v-if="!editable" :title="disabled || ''"><span v-html="readOnly"></span></span>
        <div
            v-else
            ref="editor"
            contenteditable="true"
            class="table-edit-textarea"
            :data-placeholder="field.cellOptions?.placeholder || ''"
            @input="onInput"
            @blur="onBlur"
            @paste="onPaste"
        ></div>
    `
};

const CELL_REGISTRY = {
    image: { full: ImageCell, compact: null },
    itemId: { full: TextCell, compact: TextCell },
    checkbox: { full: CheckboxCell, compact: CheckboxCell },
    select: { full: SelectCell, compact: null },
    text: { full: EditTextCell, compact: null }
};

/**
 * Resolve the component for a field at a density. Returns null when the field has no registry
 * cell (or no compact form), meaning the renderer should draw formatted text.
 * @param {{ cell?: string }} field
 * @param {'full'|'compact'} [density]
 * @returns {Object|null}
 */
function cellComponentFor(field, density = 'full') {
    if (!field || !field.cell || field.cell === 'slot' || field.cell === 'external-edit') return null;
    const entry = CELL_REGISTRY[field.cell];
    if (!entry) return null;
    return density === 'compact' ? (entry.compact || null) : (entry.full || null);
}

// ── Shared field-value renderer ──────────────────────────────────────────────

/**
 * Renders one field value through the cell pipeline:
 *   registry cell → page #cell slot (field.cell 'slot', or 'external-edit': the page draws a value
 *   edited outside the cell, e.g. in a modal) → formatted, highlighted text.
 * Props: row, field, renderer, density, searchTerm, highlight(value, field) → HTML (else the value
 *        is formatted and escaped), theme, cellSlot (the page's #cell slot function, if any),
 *        editable, editMode, commit, disabled (a cell is editable only with a commit and no reason blocking it)
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
        theme: { type: String, default: '' },
        cellSlot: { type: Function, default: null },
        editable: { type: Boolean, default: false },
        editMode: { type: String, default: '' },
        commit: { type: Function, default: null },
        disabled: { type: String, default: '' },
        // Extra scope for the page's #cell slot (e.g. rowIndex, onInnerTableDirty in PacklistTable)
        cellScope: { type: Object, default: null }
    },
    render() {
        const h = Vue.h;
        const { row, field, renderer, density, searchTerm, highlight, theme, editMode, commit, disabled } = this;
        const value = row ? row[field.key] : undefined;
        const comp = cellComponentFor(field, density);
        if (comp) {
            const editable = this.editable && !!commit && !disabled;
            return h(comp, { row, field, value, renderer, density, searchTerm, highlight, theme, editable, editMode, commit, disabled });
        }
        if ((field.cell === 'slot' || field.cell === 'external-edit') && this.cellSlot) {
            return this.cellSlot({ ...(this.cellScope || {}), row, field, value, renderer, density });
        }
        const text = highlight ? highlight(value, field) : escapeHtml(formatText(value, field));
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
