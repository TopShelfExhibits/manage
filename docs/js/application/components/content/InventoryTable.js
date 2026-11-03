import { html, Requests, TableComponent, DataView, getReactiveStore, createAnalysisConfig, NavigationRegistry, Priority, invalidateCache, authState, undoRegistry, EditHistoryUtils, todayISOString, appSettings } from '../../index.js';
import { sheetLockMixin } from '../../utils/sheetLockMixin.js';
import { ThumbnailCache } from '../../utils/thumbnailCache.js';
import { itemImageStyle } from '../../utils/views/viewStyles.js';

/**
 * Modal displayed before any inventory save.
 * Asks for an effective date (today = apply immediately; future = schedule) and a required note.
 *
 * Props:
 *   onConfirm(scheduledDate: string, note: string) — called with ISO date and trimmed note on confirm.
 *
 * Emits 'close-modal' to close itself.
 */
const InventorySaveModal = {
    props: {
        onConfirm: {
            type: Function,
            required: true
        },
        hasQtyChanges: {
            type: Boolean,
            default: true
        }
    },
    data() {
        return {
            scheduledDate: todayISOString(),
            note: '',
            error: null
        };
    },
    computed: {
        todayISO() {
            return todayISOString();
        },
        isFutureDate() {
            return this.scheduledDate > this.todayISO;
        },
        charCount() {
            return this.note.length;
        }
    },
    methods: {
        validate() {
            if (this.hasQtyChanges && !this.note.trim()) {
                this.error = 'A note is required for quantity changes';
                return false;
            }
            if (!this.scheduledDate || this.scheduledDate < this.todayISO) {
                this.error = 'Date cannot be in the past';
                return false;
            }
            this.error = null;
            return true;
        },
        handleApplyNow() {
            if (!this.validate()) return;
            this.onConfirm(this.todayISO, this.note.trim());
            this.$emit('close-modal');
        },
        handleSchedule() {
            if (!this.validate()) return;
            if (!this.isFutureDate) {
                this.error = 'Select a future date to schedule';
                return;
            }
            this.onConfirm(this.scheduledDate, this.note.trim());
            this.$emit('close-modal');
        }
    },
    template: html`
        <div class="content">
            <div class="form-group">
                <label>Note <span v-if="hasQtyChanges" class="red">*</span></label>
                <input
                    type="text"
                    v-model="note"
                    maxlength="25"
                    :placeholder="hasQtyChanges ? 'What changed and why?' : 'Optional note'"
                    :class="{ red: !!error && !note.trim() }"
                    autofocus
                    @keyup.enter="handleApplyNow"
                />
                <span v-if="error && !note.trim()" class="red font-small">{{ error }}</span>
                <span v-else class="font-small gray">{{ charCount }}/25</span>
            </div>
            <div class="form-group">
                <label>Effective Date</label>
                <input type="date" v-model="scheduledDate" :min="todayISO" :class="{ red: !!error && scheduledDate < todayISO }" />
                <span v-if="error && scheduledDate < todayISO" class="red font-small">{{ error }}</span>
                <span v-else-if="!isFutureDate" class="font-small gray">Changes will be immediate</span>
                <span v-else class="font-small gray">Changes will be scheduled</span>
            </div>
            <div class="button-bar">
                <button v-if="!isFutureDate" @click="handleApplyNow" class="purple">Apply Now</button>
                <button v-else @click="handleSchedule" class="purple" :title="'Schedule for ' + scheduledDate">Schedule</button>
                <button @click="$emit('close-modal')">Cancel</button>
            </div>
        </div>
    `
};



// Simple modal component for entering new item number
const NewItemNumberPrompt = {
    props: ['initialItemNumber', 'existingItems', 'onConfirm'],
    data() {
        return {
            itemNumber: this.initialItemNumber,
            error: null,
            suggestion: null,
            isNewPrefix: false
        };
    },
    computed: {
        helperText() {
            if (this.error) {
                return null; // Error takes precedence
            }            if (this.isNewPrefix && this.itemNumber) {
                return `"${this.itemNumber}" is a new prefix`;
            }            if (this.suggestion) {
                return `Next available: ${this.suggestion}`;
            }
            return 'Creating a new item';
        },
        ghostText() {
            // Show the remainder of the suggestion that hasn't been typed yet
            if (!this.suggestion || !this.itemNumber) {
                return '';
            }
            
            if (this.suggestion.startsWith(this.itemNumber)) {
                return this.suggestion.substring(this.itemNumber.length);
            }
            
            return '';
        }
    },
    methods: {
        validate() {
            if (!this.itemNumber) {
                this.error = 'Item number is required';
                this.suggestion = null;
                return false;
            }
            
            const duplicate = this.existingItems.find(
                item => item.itemNumber === this.itemNumber
            );
            
            if (duplicate) {
                this.error = 'Item number already exists';
                this.suggestion = null;
                return false;
            }
            
            this.error = null;
            return true;
        },
        updateSuggestion() {
            // Detect if user is typing a prefix that matches existing items
            if (!this.itemNumber || this.itemNumber.length < 2) {
                this.isNewPrefix = false;
                return;
            }
            
            // Find items that start with the current input
            const matchingItems = this.existingItems
                .map(item => item.itemNumber)
                .filter(num => num && num.startsWith(this.itemNumber));
            
            if (matchingItems.length > 0) {
                // Try to extract pattern and suggest next number
                const pattern = this.detectPatternFromPrefix(this.itemNumber, matchingItems);
                if (pattern) {
                    this.suggestion = this.incrementPattern(pattern);
                    this.isNewPrefix = false;
                } else {
                    this.suggestion = null;
                    this.isNewPrefix = false;
                }
            } else {
                // No direct matches - check if user typed a complete item following an existing pattern
                // Extract the prefix part from user's input (e.g., "CHAIR-" from "CHAIR-005")
                const prefixMatch = this.itemNumber.match(/^([A-Za-z\-_]+)(\d+)$/);
                
                if (prefixMatch) {
                    const extractedPrefix = prefixMatch[1];
                    // Check if any items start with this extracted prefix
                    const prefixItems = this.existingItems
                        .map(item => item.itemNumber)
                        .filter(num => num && num.startsWith(extractedPrefix));
                    
                    if (prefixItems.length > 0) {
                        // This prefix exists, so not a new prefix - just show default text
                        this.suggestion = null;
                        this.isNewPrefix = false;
                    } else {
                        // Truly a new prefix
                        this.suggestion = null;
                        this.isNewPrefix = true;
                    }
                } else {
                    // User is typing a prefix (e.g., "BLAH-")
                    this.suggestion = null;
                    this.isNewPrefix = true;
                }
            }
        },
        detectPatternFromPrefix(prefix, matchingItems) {
            // Try to detect the full prefix pattern from matching items
            // even if user has only typed a partial prefix
            const patterns = {};
            
            matchingItems.forEach(item => {
                // Try to extract the full prefix including separators
                // Match patterns like "PROP-123", "PROPS001", "LT-05", etc.
                const match = item.match(/^([A-Za-z\-_]+)(\d+)$/);
                if (match) {
                    const fullPrefix = match[1];
                    const number = parseInt(match[2], 10);
                    const padding = match[2].length;
                    
                    // Only consider this pattern if the full prefix starts with user's input
                    if (fullPrefix.startsWith(prefix)) {
                        if (!patterns[fullPrefix]) {
                            patterns[fullPrefix] = {
                                numbers: [],
                                padding: padding
                            };
                        }
                        patterns[fullPrefix].numbers.push(number);
                    }
                }
            });
            
            // Find the most common prefix pattern
            let bestPrefix = null;
            let maxNumber = 0;
            let maxCount = 0;
            let bestPadding = 3;
            
            for (const [fullPrefix, data] of Object.entries(patterns)) {
                if (data.numbers.length > maxCount) {
                    maxCount = data.numbers.length;
                    bestPrefix = fullPrefix;
                    maxNumber = Math.max(...data.numbers);
                    bestPadding = data.padding;
                } else if (data.numbers.length === maxCount) {
                    // If tied, prefer shorter prefix (more specific)
                    if (!bestPrefix || fullPrefix.length < bestPrefix.length) {
                        bestPrefix = fullPrefix;
                        maxNumber = Math.max(...data.numbers);
                        bestPadding = data.padding;
                    }
                }
            }
            
            if (bestPrefix) {
                return {
                    prefix: bestPrefix,
                    nextNumber: maxNumber + 1,
                    padding: bestPadding
                };
            }
            
            return null;
        },
        incrementPattern(pattern) {
            const { prefix, nextNumber, padding } = pattern;
            return `${prefix}${String(nextNumber).padStart(padding, '0')}`;
        },
        handleKeydown(event) {
            // Accept suggestion on Tab key
            if (event.key === 'Tab' && this.suggestion) {
                event.preventDefault();
                this.itemNumber = this.suggestion;
            }
        },
        handleSubmit() {
            if (this.validate()) {
                this.onConfirm(this.itemNumber);
                this.$emit('close-modal');
            }
        }
    },
    watch: {
        itemNumber() {
            this.validate();
            this.updateSuggestion();
        }
    },
    template: html`
        <div class="content">
            <div class="form-group">
                <div class="autocomplete-wrapper">
                    <input 
                        id="item-number-input"
                        type="text"
                        v-model="itemNumber"
                        @keyup.enter="handleSubmit"
                        @keydown="handleKeydown"
                        :class="{ 'red': error }"
                        autofocus
                    />
                    <div class="ghost-text" v-if="ghostText">{{ itemNumber }}<span class="ghost">{{ ghostText }}</span></div>
                </div>
                <span v-if="error" class="font-small red">{{ error }}</span>
                <span v-else-if="helperText" class="font-small gray">{{ helperText }}</span>
            </div>
            <div class="button-bar">
                <button @click="handleSubmit" :disabled="!!error" class="purple">Add Item</button>
                <button @click="$emit('close-modal')">Cancel</button>
            </div>
        </div>
    `
};


// Modal component for viewing a full-size thumbnail with a replace option
// Shows the thumbnail right away and swaps in the full-size file once it downloads. The full-size
// image is held only while the modal is open — it is freed on close, never cached.
const ImageViewWithReplaceComponent = {
    props: {
        thumbnailUrl: { type: String, required: true },
        fileId: { type: String, required: true },
        onReplace: { type: Function, default: null }
    },
    data() {
        return { fullImageUrl: null };
    },
    computed: {
        displayUrl() {
            return this.fullImageUrl || this.thumbnailUrl;
        }
    },
    async mounted() {
        const blob = await Requests.getDriveFileBlob(this.fileId);
        if (blob && !this._closed) this.fullImageUrl = URL.createObjectURL(blob);
    },
    beforeUnmount() {
        this._closed = true;
        if (this.fullImageUrl) URL.revokeObjectURL(this.fullImageUrl);
    },
    template: html`
        <img :src="displayUrl" alt="Image" style="max-width: 90vw; max-height: 70vh; object-fit: contain;" />
        <button v-if="onReplace" style="align-self: center;" @click="() => { onReplace(); $emit('close-modal'); }">Replace</button>
    `
};

// Modal component for uploading or replacing an item thumbnail
const ImageUploadComponent = {
    props: {
        itemNumber: { type: String, required: true },
        mode: { type: String, default: 'add' }, // 'add' | 'replace'
        onUploadSuccess: { type: Function, default: null }
    },
    data() {
        return {
            selectedFile: null,
            previewUrl: null,
            uploading: false,
            uploadError: null,
            canReadClipboard: !!navigator.clipboard?.read
        };
    },
    methods: {
        setSelectedFile(file) {
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                this.uploadError = 'Please select an image file.';
                return;
            }
            this.uploadError = null;
            this.selectedFile = file;
            if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
            this.previewUrl = URL.createObjectURL(file);
        },
        handleFileSelect(event) {
            this.setSelectedFile(event.target.files[0]);
        },
        // Wrap a clipboard blob in a named File — _resizeImageFile and the Drive upload both expect one.
        // The name is irrelevant: uploadItemImage renames the file to <itemNumber>.<ext>.
        _fileFromClipboardBlob(blob, type) {
            const ext = type === 'image/png' ? 'png' : 'jpg';
            return new File([blob], `pasted.${ext}`, { type });
        },
        // Clear the file input so it doesn't keep showing a previously chosen file name
        _clearFileInput() {
            if (this.$refs.fileInput) this.$refs.fileInput.value = '';
        },
        async pasteFromClipboard() {
            if (this.uploading) return;
            try {
                const items = await navigator.clipboard.read();
                for (const item of items) {
                    const type = item.types.find(t => t.startsWith('image/'));
                    if (!type) continue;
                    const blob = await item.getType(type);
                    this.setSelectedFile(this._fileFromClipboardBlob(blob, type));
                    this._clearFileInput();
                    return;
                }
                this.uploadError = 'No image found on the clipboard.';
            } catch (e) {
                console.warn('[ImageUploadComponent] Clipboard read failed:', e);
                this.uploadError = e.name === 'NotAllowedError'
                    ? 'Clipboard access was blocked. Allow clipboard access in your browser\'s site settings, or press Ctrl+V.'
                    : 'Could not read the clipboard.';
            }
        },
        // Ctrl+V while the modal is open. Registered on window in the capture phase so it runs before
        // tableComponent's document-level paste listener, and stops propagation so a paste made here
        // never inserts spreadsheet rows into a table behind the modal.
        handleWindowPaste(event) {
            event.preventDefault();
            event.stopPropagation();
            if (this.uploading) return;
            const data = event.clipboardData;
            if (!data) return;
            // clipboardData.files covers image data and, in some browsers, files copied in the OS file manager
            let file = Array.from(data.files || []).find(f => f.type.startsWith('image/'));
            if (!file) {
                const item = Array.from(data.items || []).find(i => i.kind === 'file' && i.type.startsWith('image/'));
                file = item?.getAsFile() || null;
            }
            if (!file) {
                this.uploadError = 'No image found on the clipboard.';
                return;
            }
            if (!file.name) file = this._fileFromClipboardBlob(file, file.type);
            this.setSelectedFile(file);
            this._clearFileInput();
        },
        async handleUpload() {
            if (!this.selectedFile || this.uploading) return;
            this.uploading = true;
            this.uploadError = null;
            try {
                const uploaded = await Requests.uploadItemImage(this.selectedFile, this.itemNumber);
                if (uploaded?.fileId) {
                    this.onUploadSuccess?.(uploaded);
                    this.$emit('close-modal');
                } else {
                    this.uploadError = 'Upload failed. Please try again.';
                }
            } catch (e) {
                console.error('[ImageUploadComponent] Upload error:', e);
                this.uploadError = 'Upload failed. Please try again.';
            } finally {
                this.uploading = false;
            }
        }
    },
    mounted() {
        window.addEventListener('paste', this.handleWindowPaste, true);
    },
    beforeUnmount() {
        window.removeEventListener('paste', this.handleWindowPaste, true);
        if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    },
    template: html`
        <div v-if="previewUrl" style="text-align: center;">
            <img :src="previewUrl" alt="Preview" style="max-width: 100%; max-height: 200px; object-fit: contain; border-radius: 4px;" />
        </div>
        <div v-if="canReadClipboard" class="card clickable white" @click="pasteFromClipboard" :disabled="uploading" title="Or press Ctrl+V">
            Paste from clipboard (ctrl + V)
        </div>
        <input ref="fileInput" class="card" style="width:100%" type="file" accept="image/*" @change="handleFileSelect" :disabled="uploading" />
        <div v-if="uploadError" class="red card">{{ uploadError }}</div>
        <div class="button-bar">
            <button @click="handleUpload" :disabled="!selectedFile || uploading">
                {{ uploading ? 'Uploading...' : (mode === 'replace' ? 'Replace' : 'Upload') }}
            </button>
            <button class="gray" @click="$emit('close-modal')" :disabled="uploading">Cancel</button>
        </div>
    `
};

// Item thumbnail. Resolves its Drive file through the shared ThumbnailCache (own record, else the
// category prefix record) and only fetches once it is on or near the screen. See thumbnailCache.js.
export const ItemImageComponent = {
    props: {
        itemNumber: {
            type: String,
            default: ''
        },
        imageSize: {
            type: Number,
            default: 64
        },
        editable: {
            type: Boolean,
            default: false
        }
    },
    inject: {
        $modal: '$modal'
    },
    data() {
        return {
            imageUrl: null,         // Thumbnail URL currently shown (owned by ThumbnailCache — never revoke)
            displayedFileId: null,  // File that imageUrl belongs to
            pendingFileId: null,    // File currently requested from ThumbnailCache
            uploadedFileId: null,   // File just uploaded here — shown until the records table catches up
            fadeIn: false,          // True when the image arrived after mount, so it fades in
            isVisible: false,
            observing: false,
            retriedFileId: null     // File already re-downloaded once after a decode error
        };
    },
    computed: {
        source() {
            return ThumbnailCache.resolve(this.itemNumber);
        },
        recordFileId() {
            return this.source?.fileId || null;
        },
        fileId() {
            return this.uploadedFileId || this.recordFileId;
        },
        isResolved() {
            return ThumbnailCache.isReady() && !this.pendingFileId;
        },
        realImageFound() {
            return !!this.imageUrl && (!!this.uploadedFileId || !!this.source?.isOwn);
        },
        imageFound() {
            return !!this.imageUrl;
        },
        downloadsEnabled() {
            return !appSettings.onlyRunEssentialAnalysis;
        }
    },
    created() {
        ThumbnailCache.connect();
    },
    mounted() {
        this.refresh();
    },
    watch: {
        itemNumber() {
            // Row reused for a different item — never show the previous item's image
            this.cancelPending();
            this.imageUrl = null;
            this.displayedFileId = null;
            this.uploadedFileId = null;
            this.retriedFileId = null;
            this.refresh();
        },
        recordFileId(id) {
            // The records table now has the upload; follow it again from here on
            if (this.uploadedFileId && id === this.uploadedFileId) this.uploadedFileId = null;
        },
        fileId() {
            // Records reloaded (new upload, prefix record added/removed). The current image stays
            // up until the new one is ready, so reloads never flash the placeholder.
            this.refresh();
        },
        downloadsEnabled(enabled) {
            if (enabled) this.refresh();
        }
    },
    methods: {
        refresh() {
            const fileId = this.fileId;
            if (!fileId) {
                this.cancelPending();
                this.stopObserving();
                // Only clear once records have loaded — an unresolved table is not "no image"
                if (ThumbnailCache.isReady()) {
                    this.imageUrl = null;
                    this.displayedFileId = null;
                }
                return;
            }
            if (fileId === this.displayedFileId) return;

            const cached = ThumbnailCache.peek(fileId);
            if (cached) {
                this.cancelPending();
                this.showImage(fileId, cached, false);
                return;
            }
            if (!this.isVisible) {
                // observe() reports the current state right away, which calls back into refresh()
                this.startObserving();
                return;
            }
            if (this.pendingFileId === fileId) return;

            this.cancelPending();
            this.pendingFileId = fileId;
            ThumbnailCache.load(fileId).then(url => {
                if (this.pendingFileId !== fileId) return; // superseded, cancelled, or unmounted
                this.pendingFileId = null;
                if (url) this.showImage(fileId, url, true);
            });
        },
        showImage(fileId, url, fadeIn) {
            this.imageUrl = url;
            this.displayedFileId = fileId;
            this.fadeIn = fadeIn;
            this.stopObserving();
        },
        cancelPending() {
            if (this.pendingFileId) {
                ThumbnailCache.cancel(this.pendingFileId);
                this.pendingFileId = null;
            }
        },
        startObserving() {
            if (this.observing || !this.$el) return;
            this.observing = true;
            ThumbnailCache.observeVisibility(this.$el, this.onVisibilityChange);
        },
        stopObserving() {
            if (!this.observing) return;
            this.observing = false;
            this.isVisible = false;
            ThumbnailCache.unobserveVisibility(this.$el);
        },
        onVisibilityChange(visible) {
            this.isVisible = visible;
            if (visible) {
                this.refresh();
            } else {
                // Scrolled away before the download started — free the slot for images still on screen
                this.cancelPending();
            }
        },
        showImageModal() {
            if (this.realImageFound) {
                this.$modal.custom(ImageViewWithReplaceComponent, {
                    thumbnailUrl: this.imageUrl,
                    fileId: this.displayedFileId,
                    size: 'page',
                    tall: true,
                    onReplace: (this.editable && this.itemNumber) ? () => this.showUploadModal() : null
                }, `Image: ${this.itemNumber}`);
            }
        },
        showUploadModal() {
            if (!this.editable) return;
            const mode = this.realImageFound ? 'replace' : 'add';
            const title = this.realImageFound ? 'Replace Thumbnail' : 'Add Thumbnail';
            this.$modal.custom(ImageUploadComponent, {
                itemNumber: this.itemNumber,
                mode,
                onUploadSuccess: async ({ fileId, file }) => {
                    // Show the uploaded image straight from the file that was sent to Drive
                    const url = await ThumbnailCache.seed(fileId, file);
                    this.cancelPending();
                    this.retriedFileId = null;
                    this.uploadedFileId = fileId;
                    if (url) this.showImage(fileId, url, true);
                }
            }, title);
        },
        handleError() {
            // The stored thumbnail didn't decode. Drop it and download once more; give up after that.
            const fileId = this.displayedFileId;
            this.imageUrl = null;
            this.displayedFileId = null;
            if (!fileId || this.retriedFileId === fileId) return;
            this.retriedFileId = fileId;
            ThumbnailCache.discard(fileId);
            this.refresh();
        }
    },
    beforeUnmount() {
        this.cancelPending();
        this.stopObserving();
    },
    template: html`
        <div
            :class="['item-image-container', { 'image-missing': editable && !imageFound && isResolved }]"
            :style="{ width: imageSize + 'px', height: imageSize + 'px', cursor: (realImageFound || (editable && isResolved)) ? 'pointer' : 'default', position: 'relative' }"
            @click="realImageFound ? showImageModal() : (editable && isResolved ? showUploadModal() : null)"
            :title="realImageFound ? 'Expand image' : (editable && isResolved ? 'Upload thumbnail' : '')"
        >
            <img
                v-if="imageUrl"
                :key="imageUrl"
                :class="['image-layer', { 'image-fade-in': fadeIn }]"
                :src="imageUrl"
                :alt="realImageFound ? 'Item Image' : 'Category Image'"
                decoding="async"
                @error="handleError"
            />
            <img
                v-else
                class="image-layer"
                src="assets/placeholder.png"
                alt="Placeholder"
                decoding="async"
            />
        </div>
    `
};



// Inventory category table view (views-and-renderers-plan §5, Phase 4). Batch edit mode.
const INVENTORY_TABLE_VIEWS = {
    id: 'inventory-category',
    default: 'table',
    theme: 'purple',
    views: [{
        id: 'table',
        name: 'Items',
        layout: 'table',
        columns: ['image', 'itemNumber', 'quantity', 'description', 'notes'],
        sortable: ['itemNumber', 'quantity', 'description'],
        style: {
            image: itemImageStyle('itemNumber', { size: 64, editable: true }),
            itemNumber: { width: 120 },
            quantity: { width: 120 }
        },
        table: { sticky: { start: ['image'] } },
        sort: { key: 'itemNumber', dir: 'asc' }
    }]
};

export const InventoryTableComponent = {
    mixins: [sheetLockMixin],
    components: {
        DataView,
        ItemImageComponent
    },
    inject: ['appContext', '$modal', '$notify'],
    props: {
        containerPath: {
            type: String,
            default: 'inventory'
        },
        inventoryName: {
            type: String,
            default: 'Inventory'
        },
        tabTitle: {
            type: String,
            default: undefined
        }
    },
    data() {
        return {
            inventoryTableStore: null,
            INVENTORY_TABLE_VIEWS,
            lockNamespace: 'INVENTORY',
            tabMetaFlags: { hideQuantity: false, hideItemNumber: false }
        };
    },
    computed: {
        // What each inventory key is; edits apply only while the page's edit mode is 'batch' (§4.16).
        // image holds no data: the thumbnail column (see itemImageStyle).
        fields() {
            return [
                { key: 'image', label: 'IMG' },
                { key: 'itemNumber', label: 'Item#', type: 'item' },
                { key: 'quantity', label: 'Qty', format: 'number', type: 'number', editable: true },
                { key: 'description', label: 'Description (visible in pack lists)', editable: true },
                { key: 'notes', label: 'Notes (internal only)', editable: true }
            ];
        },
        // Row action: the item's timeline (the standard action button under a calendar header icon)
        timelineAction() {
            return {
                to: (row) => (row.itemNumber && this.tabTitle) ? `inventory/${this.tabTitle.toLowerCase()}/${row.itemNumber}` : null,
                disabled: (row) => !row.itemNumber,
                headerIcon: 'calendar_month',
                title: 'View item timeline'
            };
        },
        // Tab metadata flags hide columns for this tab (data configuration → a view patch)
        viewPatches() {
            const hide = [];
            if (this.tabMetaFlags.hideQuantity) hide.push('quantity');
            if (this.tabMetaFlags.hideItemNumber) hide.push('itemNumber');
            if (!hide.length) return [];
            return [{ patch: { columns: INVENTORY_TABLE_VIEWS.views[0].columns.filter(k => !hide.includes(k)), hidden: hide } }];
        },
        editModeName() {
            return this.allowEdit ? 'batch' : 'none';
        },
        tableData() {
            return this.inventoryTableStore ? this.inventoryTableStore.data : [];
        },
        originalData() {
            // Use the originalData from the store, not a copy of the reactive data
            return this.inventoryTableStore && Array.isArray(this.inventoryTableStore.originalData)
                ? JSON.parse(JSON.stringify(this.inventoryTableStore.originalData))
                : [];
        },
        error() {
            return this.inventoryTableStore ? this.inventoryTableStore.error : null;
        },
        loadingMessage() {
            return this.inventoryTableStore ? (this.inventoryTableStore.loadingMessage || 'Loading data...') : 'Loading data...';
        },
        isLoading() {
            return this.inventoryTableStore ? this.inventoryTableStore.isLoading : false;
        },
        isDirty() {
            const result = this.inventoryTableStore?.isModified || false;
            //console.log('[InventoryTable] isDirty computed:', result, '| store exists:', !!this.inventoryTableStore, '| isModified:', this.inventoryTableStore?.isModified);
            return result;
        },
        lockKey() {
            return this.tabTitle;
        },
        activeStore() {
            return this.inventoryTableStore;
        },
        hasExternalConflict() {
            return this.inventoryTableStore?.externalConflict ?? false;
        },
        banners() {
            return [
                {
                    key: 'lock',
                    color: '',
                    message: this.lockedBySelf
                        ? 'You have this table open for editing on another device.'
                        : `Locked for edit by: ${this.lockOwnerDisplay}`,
                    visible: this.lockedByOther,
                    dismissible: false,
                    action: this.lockedBySelf
                        ? { label: 'Claim this device', fn: () => this.claimLock() }
                        : null
                },
                {
                    key: 'conflict',
                    color: 'red',
                    message: 'Another session changed this data while you have unsaved edits. Save to keep your changes or discard them.',
                    visible: this.hasExternalConflict,
                    action: {
                        label: 'Discard', fn: () =>
                            this.$modal.confirm(
                                'Are you sure you want to discard your changes?',
                                () => {
                                    this.inventoryTableStore?.load('Reloading...');
                                },
                                null,
                                'Discard Changes',
                                'Discard',
                                'Cancel'
                            )
                    }
                }
            ];
        },
        allowEdit() {
            // Inventory is always in edit mode, unless another user or device holds the lock
            return !this.lockedByOther && this.lockCheckComplete;
        },
        allowSave() {
            const result = this.isDirty && !this.lockedByOther && this.lockCheckComplete;
            //console.log('[InventoryTable] allowSave computed:', result, '| isDirty:', this.isDirty, '| lockedByOther:', this.lockedByOther, '| lockCheckComplete:', this.lockCheckComplete);
            return result;
        }
    },
    async mounted() {
        // Load index metadata to derive column visibility flags for this tab
        if (this.tabTitle) {
            const tabTitle = this.tabTitle;
            Requests.getPreferences().then(prefs => {
                const descPref = prefs?.find(p => p.id === 'InventoryDescriptionOnly');
                let descOnlyTabs = [];
                try { descOnlyTabs = JSON.parse(descPref?.value || '[]'); } catch {}
                if (descOnlyTabs.includes(tabTitle)) {
                    this.tabMetaFlags = { hideQuantity: true, hideItemNumber: true };
                }
            }).catch(() => {});
        }

        // Defensive: always set up the store before using it
        this.inventoryTableStore = getReactiveStore(
            Requests.getInventoryTabData,
            Requests.saveInventoryTabData,
            [this.tabTitle, undefined, undefined, undefined] // No filters needed - search is handled in UI
        );
        
        // Apply any pending changes that are due today or earlier
        if (this.tabTitle) {
            Requests.checkAndApplyPendingChanges(this.tabTitle).catch(err => {
                console.warn('[InventoryTable] Pending changes check failed:', err);
            });
        }
        
        // Check lock status when component mounts
        await this.checkLockStatus();
    },
    watch: {
        banners: {
            handler(newBanners) {
                this.$notify.setBanners(this.containerPath, newBanners);
            },
            immediate: true
        },
        isDirty(newValue) {
            this.handleLockState(newValue);
        }
    },
    beforeUnmount() {
        this.$notify.clearBanners(this.containerPath);
    },
    methods: {
        onLockAcquireFailed() {
            if (this.inventoryTableStore) {
                this.inventoryTableStore.setData(this.inventoryTableStore.originalData);
            }
        },

        async handleRefresh() {
            this.$modal.confirm(
                'This removes undo history and clears unsaved changes.',
                () => {
                    // Clear undo/redo history for this route
                    const routeKey = this.$route?.path;
                    if (routeKey) {
                        undoRegistry.clearRouteHistory(routeKey);
                    }
                    
                    invalidateCache([
                        { namespace: 'database', methodName: 'getData', args: ['INVENTORY', this.tabTitle] }
                    ], true);
                    this.inventoryTableStore?.load('Refreshing data...');
                },
                null,
                'Refresh Data',
                'Refresh Data',
                'Cancel'
            );
        },
        
        // cell-edit contract: (rowIndex, columnKey, value) — keyed by column, not position (fixes D4)
        async handleCellEdit(rowIdx, colKey, value) {
            const user = authState.user?.email;
            if (!user || !this.tabTitle) return;

            const originalValue = colKey && this.inventoryTableStore ? this.inventoryTableStore.data[rowIdx]?.[colKey] : undefined;

            // Apply the value immediately to prevent flicker during async lock operations.
            // If the lock check fails, revert below.
            if (colKey && this.inventoryTableStore) {
                this.inventoryTableStore.data[rowIdx][colKey] = value;
            }

            if (!await this.acquireLockForEdit()) {
                if (colKey && this.inventoryTableStore && originalValue !== undefined) {
                    this.inventoryTableStore.data[rowIdx][colKey] = originalValue;
                }
                return;
            }
        },
        async handleNewRow(positionData) {
            // positionData: { position: 'above'|'below', targetIndex: number }
            
            // Generate next item number
            const nextItemNumber = await this.generateNextItemNumber();
            
            // Show prompt modal
            this.$modal.custom(NewItemNumberPrompt, {
                initialItemNumber: nextItemNumber,
                existingItems: this.inventoryTableStore?.data || [],
                onConfirm: (itemNumber) => {
                    this.addNewRow(itemNumber, positionData);
                },
                size: 'card'
            }, 'New Item');
        },
        
        async generateNextItemNumber() {
            const items = this.inventoryTableStore?.data || [];
            
            if (items.length === 0) {
                return `${this.tabTitle}-001`;
            }
            
            const itemNumbers = items.map(item => item.itemNumber).filter(Boolean);
            
            // Try to detect pattern
            const pattern = this.detectNumberingPattern(itemNumbers);
            
            if (pattern) {
                return this.incrementPattern(pattern);
            }
            
            // Fallback: category prefix + next number
            return `${this.tabTitle}-${String(items.length + 1).padStart(3, '0')}`;
        },
        
        detectNumberingPattern(itemNumbers) {
            // Look for common patterns like "PREFIX-###" or "PREFIX###"
            const patterns = {};
            
            itemNumbers.forEach(num => {
                // Match patterns like "ABC-123", "ABC123", etc.
                const match = num.match(/^([A-Za-z\-_]+)(\d+)$/);
                if (match) {
                    const prefix = match[1];
                    const number = parseInt(match[2], 10);
                    
                    if (!patterns[prefix]) {
                        patterns[prefix] = [];
                    }
                    patterns[prefix].push(number);
                }
            });
            
            // Find the most common prefix and its max number
            let bestPrefix = null;
            let maxNumber = 0;
            let maxCount = 0;
            
            for (const [prefix, numbers] of Object.entries(patterns)) {
                if (numbers.length > maxCount) {
                    maxCount = numbers.length;
                    bestPrefix = prefix;
                    maxNumber = Math.max(...numbers);
                }
            }
            
            if (bestPrefix) {
                return {
                    prefix: bestPrefix,
                    nextNumber: maxNumber + 1,
                    padding: 3 // Default to 3-digit padding
                };
            }
            
            return null;
        },
        
        incrementPattern(pattern) {
            const { prefix, nextNumber, padding } = pattern;
            return `${prefix}${String(nextNumber).padStart(padding, '0')}`;
        },
        
        addNewRow(itemNumber, positionData) {
            // Capture state for undo
            const routeKey = this.appContext?.currentPath?.split('?')[0];
            if (routeKey) {
                undoRegistry.capture(this.inventoryTableStore.data, routeKey, { type: 'add-row' });
            }
            
            // Create new item object
            const newItem = {
                itemNumber: itemNumber,
                quantity: 0,
                description: '',
                notes: ''
            };
            
            const data = this.inventoryTableStore.data;
            
            if (positionData) {
                // Insert at specific position
                const insertIndex = positionData.position === 'above' 
                    ? positionData.targetIndex 
                    : positionData.targetIndex + 1;
                
                data.splice(insertIndex, 0, newItem);
            } else {
                // Add to end
                data.push(newItem);
            }
            
            // Navigate with searchTerm to highlight the new item
            const newPath = NavigationRegistry.buildPath(
                this.containerPath,
                { searchTerm: itemNumber }
            );
            
            if (this.appContext?.navigateToPath) {
                this.appContext.navigateToPath(newPath);
            }
            
            // Store is now dirty, save button will appear
        },
        
        async handleSave() {
            if (!this.inventoryTableStore) return;
            const data = this.inventoryTableStore.data || [];
            const original = this.inventoryTableStore.originalData || [];
            const hasQtyChanges = data.some(row => {
                const orig = original.find(o => o.itemNumber === row.itemNumber);
                return orig && String(row.quantity) !== String(orig.quantity);
            });
            this.$modal.custom(InventorySaveModal, {
                hasQtyChanges,
                onConfirm: async (scheduledDate, note) => {
                    await this.inventoryTableStore.save('Saving inventory...', { scheduledDate, note });
                    // After a scheduled (future) save the server keeps the original quantity and
                    // stores the change as a pending entry. The store's optimistic data still
                    // shows the user-edited quantity, so force a reload to display the actual state.
                    if (scheduledDate > todayISOString()) {
                        await this.inventoryTableStore.load('Loading...');
                    }
                }
            }, 'Save Changes');
        },

        getPendingEntries(item) {
            const eh = item?.edithistory || item?.EditHistory;
            return EditHistoryUtils.getPendingEntries(eh);
        },

        // Returns pending entries sorted ascending by t, each annotated with cumulative
        // field values so quantity deltas stack correctly across multiple scheduled entries.
        getPendingEntriesForDisplay(item) {
            const entries = this.getPendingEntries(item);
            if (!entries.length) return [];
            const sorted = [...entries].sort((a, b) => a.t - b.t);
            const running = {};
            return sorted.map(entry => {
                const fields = {};
                for (const ch of entry.c) {
                    const base = running[ch.n] !== undefined ? running[ch.n] : (item[ch.n] ?? '');
                    const computed = EditHistoryUtils.applyNeValue(base, ch.ne);
                    fields[ch.n] = computed;
                    running[ch.n] = computed;
                }
                return { ...entry, fields };
            });
        },

        formatPendingDate(deciseconds) {
            return new Date(deciseconds * 100).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        },

        handleReportsClick() {
            // Navigation to reports has been moved to primary navigation
            const path = this.tabTitle
                    ? NavigationRegistry.buildPath('reports/show-usage', { ctgFilter: this.tabTitle })
                    : 'reports/show-usage';
            this.appContext.navigateToPath(path);
        },
        navigateToItemPage(row) {
            if (!row.itemNumber || !this.tabTitle) return;
            const basePath = `inventory/${this.tabTitle.toLowerCase()}/${row.itemNumber}`;
            // Preserve searchTerm from current path
            const currentParams = NavigationRegistry.getParametersForContainer(
                this.containerPath,
                this.appContext?.currentPath
            );
            const newPath = NavigationRegistry.buildPath(basePath, { searchTerm: currentParams.searchTerm });
            if (this.appContext?.navigateToPath) {
                this.appContext.navigateToPath(newPath);
            }
        }
    },
    template: html `
        <slot>
            <DataView
                ref="tableComponent"
                :fields="fields"
                :rows="tableData"
                :registry="INVENTORY_TABLE_VIEWS"
                :action="timelineAction"
                :patches="viewPatches"
                :edit-mode="editModeName"
                :title="inventoryName || tabTitle"
                :original-data="originalData"
                :isLoading="isLoading"
                :error="error"
                :showRefresh="true"
                :showSearch="true"
                :showNewRowButton="allowEdit"
                :sync-search-with-url="true"
                :container-path="containerPath"
                :navigate-to-path="appContext.navigateToPath"
                :newRow="allowEdit"
                :forceDetails="true"
                :rowDetailsVisible="row => getPendingEntries(row).length > 0"
                emptyMessage="No inventory items found"
                :loading-message="loadingMessage"
                class="inventory-table-component"
                @refresh="handleRefresh"
                @cell-edit="handleCellEdit"
                @new-row="handleNewRow"
                @on-save="handleSave"
            >
                <template #header-area>
                    <div class="button-bar" style="display: none;"></div>
                </template>
                <template #row-detail-rows="{ row }">
                    <tr
                        v-for="(entry, i) in getPendingEntriesForDisplay(row)"
                        :key="i"
                        class="detail-row-pending in-group"
                    >
                        <td colspan="2" class="detail-meta-cell">
                            <strong>{{ formatPendingDate(entry.t) }}→ </strong>
                        </td>
                        <td class="detail-value-cell">{{ entry.fields.quantity !== undefined ? entry.fields.quantity : '' }}</td>
                        <td class="detail-value-cell">{{ entry.fields.description !== undefined ? entry.fields.description : '' }}</td>
                        <td class="detail-value-cell">{{ entry.fields.notes !== undefined ? entry.fields.notes : '' }}</td>
                    </tr>
                </template>
            </DataView>
        </slot>
    `
};