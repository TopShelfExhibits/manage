import { html } from '../../utils/template-helpers.js';
import { isCheckedValue, checkboxWriteValue } from '../../../data_management/utils/checkbox-values.js';
import { escapeHtml, formatText } from '../../utils/views/fieldFormat.js';

/**
 * Cell registry (views-and-renderers-plan §4.14). A resolved field with `cell: '<name>'` renders
 * through the registry in every renderer: table cells, calendar chip lines, card lines and the
 * details grid. The cell comes from the field's type (checkbox, select, thumbnail) or the view's
 * style[key].cell; pages never put it on fields.
 *
 * Every cell receives the same props:
 *   row, field, value, renderer ('table'|'calendar'|'cards'|'details'), density ('full'|'compact'),
 *   searchTerm (raw term, for navigation), highlight (fn(value, field) → safe HTML), theme,
 *   editable (the cell may be edited now: edit mode on, a commit wired, nothing blocking it),
 *   editMode ('batch'|'instant'; when a text cell reports: batch on every change, instant when
 *   editing ends), commit(value) (report an edit: batch → cell-edit and dirty tracking;
 *   instant → the delayed write queue), disabled (why editing is blocked; shown as the tooltip),
 *   rowAction ({ run(), disabled, title }: the row's primary action, for the action cell)
 * Cell options come from `field.cellOptions`, which the view sets (style[key].cellOptions; e.g. which
 * key holds the item number). An entry without a compact form falls back to formatted text when compact.
 *
 * `field.cell = 'slot'` is not a registry entry: the renderer calls the page's #cell slot instead.
 */

export const cellProps = {
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
    disabled: { type: String, default: '' },
    rowAction: { type: Object, default: null }
};

// Clean pasted text before it enters a cell: normalize line endings, turn non-breaking spaces into
// plain spaces, and strip invisible characters (zero-width space, BOM, soft hyphen, control chars)
// that ride along from PDFs, web pages and Office documents. Tabs and newlines are kept.
export function sanitizeCellText(text) {
    return String(text ?? '')
        .replace(/\r\n?|[\u2028\u2029]/g, '\n')
        .replace(/[\u00A0\u2007\u202F]/g, ' ')
        .replace(/[\u200B\u2060\uFEFF\u00AD]/g, '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

// The thumbnail cell (thumbnails.js) reaches the data layer through the image cache; load it lazily
// so this module never forms an evaluation-time import cycle with it.
const ThumbnailCell = Vue.defineAsyncComponent(() =>
    import('./thumbnails.js').then(m => m.ThumbnailCell)
);

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
 * The row's primary action as the value's button (style[key].cell = 'action'). The renderer draws
 * no separate action button while a shown column uses this cell. cellOptions.class: the button's
 * colour class (default: the theme). Without an action (rowAction) the value shows as text.
 */
const ActionCell = {
    name: 'ActionCell',
    props: cellProps,
    computed: {
        html() { return readOnlyHtml(this); },
        colorClass() { return this.field.cellOptions?.class || this.theme || 'white'; }
    },
    template: html`
        <button
            v-if="rowAction"
            :class="['card', colorClass]"
            :disabled="rowAction.disabled"
            :title="rowAction.title || null"
            @click.stop="rowAction.run()"
            v-html="html"
        ></button>
        <span v-else v-html="html"></span>
    `
};

/**
 * A list of show identifiers (the value is an array) as full-width buttons that open each show
 * (style[key].cell = 'showList'). Past cellOptions.max shows, one "N shows" button opens the list
 * in a modal instead; a view sets max per layout (0: always the button; null or absent: never).
 * cellOptions.to: the path for one show, '{value}' replaced by its identifier (default
 * 'packlist/{value}/details').
 */
const ShowListCell = {
    name: 'ShowListCell',
    props: cellProps,
    inject: {
        appContext: { from: 'appContext', default: null },
        modal: { from: '$modal', default: null }
    },
    computed: {
        opts() { return this.field.cellOptions || {}; },
        shows() { return Array.isArray(this.value) ? this.value.filter(v => v != null && v !== '').map(String) : []; },
        inline() { return this.opts.max == null || this.shows.length <= this.opts.max; },
        summary() { return `${this.shows.length} ${this.shows.length === 1 ? 'show' : 'shows'}`; },
        anyMatch() { return !!this.highlight && this.shows.some(id => String(this.highlight(id, this.field)).includes('search-match')); }
    },
    methods: {
        label(id) { return this.highlight ? this.highlight(id, this.field) : escapeHtml(id); },
        path(id) { return String(this.opts.to || 'packlist/{value}/details').replace('{value}', id); },
        open(id) { this.appContext?.navigateToPath?.(this.path(id)); },
        async openAll() {
            const { OverlappingShowsModal } = await import('./OverlappingShowsModal.js');
            this.modal?.custom?.(OverlappingShowsModal, { shows: this.shows, to: this.opts.to, modalClass: 'hamburger-menu', size: 'card' }, `${this.shows.length} Overlapping Shows`);
        }
    },
    template: html`
        <span v-if="!shows.length">—</span>
        <div v-else-if="inline" class="cell-button-list">
            <button v-for="id in shows" :key="id" class="card white" @click.stop="open(id)" v-html="label(id)"></button>
        </div>
        <button v-else :class="['card', 'white', 'font-black', { 'search-highlight': anyMatch }]" @click.stop="openAll">{{ summary }}</button>
    `
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
 * Pasting inserts cleaned plain text, line breaks included. In batch mode, pasted text with tabs is
 * left to the table, which pastes it as rows. Read-only renders highlighted text.
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
            // Safety net: if markup got into the editor anyway (e.g. from a browser extension),
            // flatten it to its text so the cell shows exactly the value that is saved.
            const el = this.$refs.editor;
            if (el && Array.from(el.children).some(child => child.tagName !== 'BR')) {
                el.textContent = el.textContent;
            }
            if (this.draft !== null && this.draft !== this.current) this.commit(this.draft);
            this.draft = null;
            this.syncEditor();
        },
        // Always take over the paste so the browser never inserts images or rich content,
        // even when the clipboard has no plain text at all.
        onPaste(event) {
            event.preventDefault();
            let text = sanitizeCellText(event.clipboardData?.getData('text/plain'));
            if (this.editMode === 'batch' && text.includes('\t')) {
                // Spreadsheet rows: the table's paste handler runs on the same event and inserts
                // them as rows; leave the cell so it isn't edited too
                event.target.blur();
                return;
            }
            // Spreadsheet apps end a copied cell with a line break, and wrap it in quotes when the
            // cell itself contains line breaks. Undo both so a copied multi-line note pastes cleanly.
            text = text.replace(/\n$/, '');
            const quoted = text.match(/^"([\s\S]*)"$/);
            if (quoted && quoted[1].includes('\n')) text = quoted[1].replace(/""/g, '"');
            if (text) this.insertText(text);
        },
        // Enter (or a mobile keyboard's return): insert a plain "\n" ourselves. Browsers otherwise
        // wrap the new line in a <div>, which textContent drops, so the line break would show on
        // screen but never be saved.
        onBeforeInput(event) {
            if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
                event.preventDefault();
                this.insertText('\n');
            }
        },
        // Insert plain text at the caret; newlines render as line breaks (white-space: pre-wrap).
        // Reports through onInput, since a cancelled event fires no input event.
        insertText(text) {
            const el = this.$refs.editor;
            const selection = window.getSelection();
            if (!el || !selection || !selection.rangeCount) return;
            selection.deleteFromDocument();
            const range = selection.getRangeAt(0);
            const textNode = document.createTextNode(text);
            range.insertNode(textNode);
            // A trailing "\n" doesn't render a new line by itself; a placeholder <br> (ignored by
            // textContent, so never saved) gives the caret an empty line to sit on.
            if (el.textContent.endsWith('\n') && el.lastChild?.nodeName !== 'BR') {
                el.appendChild(document.createElement('br'));
            }
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            this.onInput();
        }
    },
    template: html`
        <span v-if="!editable" :title="disabled || ''"><span v-html="readOnly"></span></span>
        <div
            v-else
            ref="editor"
            contenteditable="plaintext-only"
            class="table-edit-textarea"
            :data-placeholder="field.cellOptions?.placeholder || ''"
            @input="onInput"
            @blur="onBlur"
            @paste="onPaste"
            @beforeinput="onBeforeInput"
        ></div>
    `
};

const CELL_REGISTRY = {
    thumbnail: { full: ThumbnailCell, compact: null },
    itemId: { full: TextCell, compact: TextCell },
    action: { full: ActionCell, compact: ActionCell },
    showList: { full: ShowListCell, compact: ShowListCell },
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
 *        editable, editMode, commit, disabled (a cell is editable only with a commit and no reason blocking it),
 *        rowAction (the row's primary action { run(), disabled, title }, for the action cell)
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
        rowAction: { type: Object, default: null },
        // Extra scope for the page's #cell slot (e.g. rowIndex, onInnerTableDirty in PacklistTable)
        cellScope: { type: Object, default: null }
    },
    render() {
        const h = Vue.h;
        const { row, field, renderer, density, searchTerm, highlight, theme, editMode, commit, disabled, rowAction } = this;
        const value = row ? row[field.key] : undefined;
        const comp = cellComponentFor(field, density);
        if (comp) {
            const editable = this.editable && !!commit && !disabled;
            return h(comp, { row, field, value, renderer, density, searchTerm, highlight, theme, editable, editMode, commit, disabled, rowAction });
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
