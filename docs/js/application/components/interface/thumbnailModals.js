import { html, Requests, EditHistoryUtils } from '../../index.js';
import { ThumbnailCache, renderImage } from '../../utils/thumbnailCache.js';
import {
    parseThumbnailEntries, serializeThumbnailEntries, parseThumbnails, addThumbnails, removeThumbnailAt, setPrimaryThumbnail,
    setThumbnailNote, setThumbnailCrop, normalizeCrop, thumbnailKey
} from '../../../data_management/utils/thumbnail-values.js';
import { ThumbnailImage } from './thumbnails.js';

/**
 * Thumbnail gallery editing, opened by the thumbnail cell (thumbnails.js) and loaded only then.
 * Every change is handed back to the cell (onChange), which commits it like any edit, so the
 * table's Save keeps it.
 */

// Largest side of a full-size image in the gallery (uploads are at most 1000px)
const GALLERY_MAX_DIM = 1600;

/** "Oct 6, 2026, 1:52 PM" from a decisecond timestamp */
function formatTime(deciseconds) {
    return new Date(deciseconds * 100).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });
}

/**
 * Crop editor: the whole image with a movable, resizable crop rectangle, filling the gallery's
 * stage. Non-destructive: it only produces a crop (fractions of the image, thumbnail-values.js);
 * the file is never changed. The gallery's button bar drives it: crop() reads the rectangle
 * (null for the whole image), reset() selects the whole image.
 */
export const ThumbnailCropEditor = {
    name: 'ThumbnailCropEditor',
    props: {
        src: { type: String, required: true },
        crop: { type: Object, default: null }
    },
    data() {
        const c = normalizeCrop(this.crop) || { x: 0, y: 0, w: 1, h: 1 };
        return { rect: { ...c }, drag: null, ratio: null };
    },
    computed: {
        rectStyle() {
            const { x, y, w, h } = this.rect;
            return { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` };
        }
    },
    methods: {
        // The box takes the image's proportions, so the rectangle's fractions are the image's
        onLoad(event) {
            const { naturalWidth, naturalHeight } = event.target;
            if (naturalWidth && naturalHeight) this.ratio = naturalWidth / naturalHeight;
        },
        crop() {
            return normalizeCrop(this.rect);
        },
        reset() {
            this.rect = { x: 0, y: 0, w: 1, h: 1 };
        },
        start(mode, event) {
            event.preventDefault();
            const box = this.$refs.box.getBoundingClientRect();
            this.drag = { mode, startX: event.clientX, startY: event.clientY, box, rect: { ...this.rect } };
            window.addEventListener('pointermove', this.move);
            window.addEventListener('pointerup', this.end, { once: true });
        },
        move(event) {
            const d = this.drag;
            if (!d) return;
            const dx = (event.clientX - d.startX) / d.box.width;
            const dy = (event.clientY - d.startY) / d.box.height;
            const min = 0.05;
            const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
            let { x, y, w, h } = d.rect;
            if (d.mode === 'move') {
                x = clamp(x + dx, 0, 1 - w);
                y = clamp(y + dy, 0, 1 - h);
            } else {
                // Corner handles: n/s move the top or bottom edge, w/e the left or right edge
                if (d.mode.includes('w')) { const nx = clamp(x + dx, 0, x + w - min); w += x - nx; x = nx; }
                if (d.mode.includes('e')) { w = clamp(w + dx, min, 1 - x); }
                if (d.mode.includes('n')) { const ny = clamp(y + dy, 0, y + h - min); h += y - ny; y = ny; }
                if (d.mode.includes('s')) { h = clamp(h + dy, min, 1 - y); }
            }
            this.rect = { x, y, w, h };
        },
        end() {
            this.drag = null;
            window.removeEventListener('pointermove', this.move);
        }
    },
    beforeUnmount() {
        this.end();
    },
    template: html`
        <div class="thumbnail-crop-stage" :style="ratio ? { '--crop-ratio': ratio } : null">
            <div ref="box" class="thumbnail-crop-box" :style="{ visibility: ratio ? 'visible' : 'hidden' }">
                <img :src="src" alt="Image to crop" draggable="false" @load="onLoad" />
                <div class="thumbnail-crop-rect" :style="rectStyle" @pointerdown="start('move', $event)">
                    <span v-for="corner in ['nw', 'ne', 'sw', 'se']" :key="corner" :class="['thumbnail-crop-handle', corner]" @pointerdown.stop="start(corner, $event)"></span>
                </div>
            </div>
        </div>
    `
};

/**
 * An item's image gallery (a tall page modal): the primary image first, filling the space between
 * the left and right arrows, the strip of all images centered under it, then the image's details
 * and note, the save reminder (only while there are unsaved changes) and the button bar at the
 * bottom, which also drives the note and crop editors. Each image shows its note and when it entered the item's
 * edit history, and by whom (EditHistoryUtils.listItemOrigins). Only the image on screen is
 * downloaded at full size; the strip uses the cached thumbnails.
 * Editable (onChange given): Add image, Set as thumbnail, Crop image, Add note, Remove image.
 * Props: itemNumber, value (the cell value), savedValue (the value the row's history ends at),
 * edithistory (the row's), loadItem (rows that carry only the icon: load the item's full cell and
 * history first), onChange(value).
 */
export const ThumbnailGalleryModal = {
    name: 'ThumbnailGalleryModal',
    inheritAttrs: false,
    components: { ThumbnailImage, ThumbnailCropEditor },
    inject: { modal: { from: '$modal', default: null } },
    props: {
        itemNumber: { type: String, required: true },
        value: { type: String, default: '' },
        savedValue: { default: undefined },
        edithistory: { default: null },
        loadItem: { type: Boolean, default: false },
        onChange: { type: Function, default: null }
    },
    data() {
        return {
            current: this.value || '',
            saved: this.savedValue ?? this.value ?? '',
            history: this.edithistory,
            index: 0,
            mode: 'view',          // 'view' | 'note' | 'crop'
            noteDraft: '',
            fullUrls: {},          // image key → object URL of the full-size image (owned here)
            loading: false
        };
    },
    computed: {
        entries() { return parseThumbnailEntries(this.current); },
        entry() { return this.entries[this.index] || null; },
        editable() { return !!this.onChange; },
        // The gallery differs from the saved value (the table's Save keeps the changes)
        unsaved() {
            return serializeThumbnailEntries(this.entries) !== serializeThumbnailEntries(parseThumbnailEntries(this.saved));
        },
        imageKey() { return this.entry ? thumbnailKey(this.entry.id, this.entry.crop) : null; },
        displayUrl() {
            const e = this.entry;
            if (!e) return 'assets/placeholder.png';
            return this.fullUrls[this.imageKey] || ThumbnailCache.peek(e.id, e.crop) || 'assets/placeholder.png';
        },
        uncroppedUrl() {
            return this.entry ? this.fullUrls[this.entry.id] || null : null;
        },
        origins() {
            return EditHistoryUtils.listItemOrigins(this.history, 'thumbnail', this.saved, parseThumbnails);
        },
        originText() {
            const id = this.entry?.id;
            if (!id) return '';
            if (!this.origins.has(id)) return 'Not saved yet';
            const origin = this.origins.get(id);
            if (!origin) return 'Before its history was kept';
            const who = origin.u ? ` by ${origin.u}` : '';
            return `${formatTime(origin.t)}${who}${origin.created ? ' (with the item)' : ''}`;
        }
    },
    watch: {
        imageKey() {
            this.loadCurrent();
        }
    },
    async mounted() {
        window.addEventListener('keydown', this.onKey);
        if (this.loadItem) {
            // A row that carries only the icon: the gallery needs the item's full cell and history
            this.loading = true;
            try {
                const info = await Requests.getInventoryInfo(this.itemNumber, ['thumbnail', 'edithistory']);
                const item = Array.isArray(info) ? info[0] : null;
                if (item && item.thumbnail != null) {
                    this.current = item.thumbnail;
                    this.saved = item.thumbnail;
                    this.history = item.edithistory;
                }
            } catch (err) {
                console.warn('[ThumbnailGalleryModal] Could not load the item images:', err);
            } finally {
                this.loading = false;
            }
        }
        this.loadCurrent();
    },
    beforeUnmount() {
        this._closed = true;
        window.removeEventListener('keydown', this.onKey);
        Object.values(this.fullUrls).forEach(url => URL.revokeObjectURL(url));
    },
    methods: {
        // The whole file, downloaded once per gallery (not cached across galleries)
        async fileBlob(fileId) {
            this._blobs = this._blobs || new Map();
            if (!this._blobs.has(fileId)) this._blobs.set(fileId, Requests.getDriveFileBlob(fileId));
            return await this._blobs.get(fileId);
        },
        async loadCurrent() {
            const e = this.entry;
            if (!e || this.fullUrls[this.imageKey]) return;
            const key = this.imageKey;
            const blob = await this.fileBlob(e.id);
            if (!blob || this._closed || this.fullUrls[key]) return;
            const rendered = await renderImage(blob, { crop: e.crop || null, maxDim: GALLERY_MAX_DIM });
            if (this._closed) return;
            this.fullUrls = { ...this.fullUrls, [key]: URL.createObjectURL(rendered) };
        },
        async loadUncropped() {
            const e = this.entry;
            if (!e || this.fullUrls[e.id]) return;
            const blob = await this.fileBlob(e.id);
            if (!blob || this._closed) return;
            const rendered = await renderImage(blob, { maxDim: GALLERY_MAX_DIM });
            if (!this._closed) this.fullUrls = { ...this.fullUrls, [e.id]: URL.createObjectURL(rendered) };
        },
        go(step) {
            if (this.mode !== 'view' || this.entries.length < 2) return;
            this.index = (this.index + step + this.entries.length) % this.entries.length;
        },
        onKey(event) {
            if (this.mode !== 'view' || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)) return;
            if (event.key === 'ArrowLeft') this.go(-1);
            else if (event.key === 'ArrowRight') this.go(1);
        },
        // Every edit: keep the gallery's own copy and commit it through the cell
        change(value) {
            this.current = value;
            this.onChange(value);
            this.index = Math.min(this.index, Math.max(0, this.entries.length - 1));
        },
        addImages() {
            this.modal?.custom(ThumbnailUploadModal, {
                itemNumber: this.itemNumber,
                onUploadSuccess: (uploads) => {
                    const before = this.entries.length;
                    this.change(addThumbnails(this.current, uploads.map(u => u.fileId)));
                    if (this.entries.length > before) this.index = before;
                }
            }, 'Add Images');
        },
        setAsThumbnail() {
            this.change(setPrimaryThumbnail(this.current, this.index));
            this.index = 0;
        },
        removeImage() {
            this.change(removeThumbnailAt(this.current, this.index));
            if (!this.entries.length) this.$emit('close-modal');
        },
        editNote() {
            this.noteDraft = this.entry?.note || '';
            this.mode = 'note';
        },
        saveNote() {
            this.change(setThumbnailNote(this.current, this.index, this.noteDraft));
            this.mode = 'view';
        },
        async editCrop() {
            this.mode = 'crop';
            await this.loadUncropped();
        },
        async applyCrop() {
            await this.$nextTick();
            let crop = null;
            try {
                if (this.$refs.cropEditor && typeof this.$refs.cropEditor.crop === 'function') {
                    crop = this.$refs.cropEditor.crop();
                    console.log('[ThumbnailGalleryModal.applyCrop] crop() returned:', crop);
                } else {
                    console.log('[ThumbnailGalleryModal.applyCrop] ref or method not found');
                    console.log('  ref exists:', !!this.$refs.cropEditor);
                    if (this.$refs.cropEditor) {
                        console.log('  crop is:', typeof this.$refs.cropEditor.crop);
                        console.log('  all methods:', Object.keys(this.$refs.cropEditor.$options?.methods || {}));
                    }
                }
            } catch (e) {
                console.error('[ThumbnailGalleryModal.applyCrop] Error calling crop():', e);
            }
            const e = this.entry;
            this.mode = 'view';
            this.change(setThumbnailCrop(this.current, this.index, crop));
            // Show the cropped icon in the table right away, from the file already downloaded
            const blob = await this.fileBlob(e.id);
            if (blob) ThumbnailCache.seed(e.id, blob, crop);
        },
        resetCrop() {
            if (this.$refs.cropEditor && typeof this.$refs.cropEditor.reset === 'function') {
                this.$refs.cropEditor.reset();
            }
        }
    },
    template: html`
        <div class="thumbnail-gallery-stage">
            <button class="button-symbol" :disabled="entries.length < 2 || mode !== 'view'" title="Previous image (←)" @click="go(-1)"><span class="material-symbols-outlined">chevron_left</span></button>
            <template v-if="mode === 'crop'">
                <ThumbnailCropEditor v-if="uncroppedUrl" ref="cropEditor" :src="uncroppedUrl" :crop="entry && entry.crop" />
                <div v-else class="card gray">Loading the full image…</div>
            </template>
            <img v-else :src="displayUrl" :alt="'Image ' + (index + 1) + ' of ' + itemNumber" />
            <button class="button-symbol" :disabled="entries.length < 2 || mode !== 'view'" title="Next image (→)" @click="go(1)"><span class="material-symbols-outlined">chevron_right</span></button>
        </div>

        <div v-if="entries.length > 1" class="thumbnail-gallery-strip">
            <ThumbnailImage
                v-for="(e, i) in entries"
                :key="e.id"
                :fileId="e.id"
                :crop="e.crop || null"
                :size="64"
                :class="{ selected: i === index }"
                :title="i === 0 ? 'Thumbnail' : 'Image ' + (i + 1)"
                @click="mode === 'view' && (index = i)"
            />
        </div>

        <div v-if="entry" class="details-grid">
            <div class="detail-item">
                <label>Image</label>
                <span>{{ index + 1 }} of {{ entries.length }}{{ index === 0 ? ' (thumbnail)' : '' }}</span>
            </div>
            <div class="detail-item">
                <label>Added</label>
                <span>{{ loading ? 'Loading…' : originText }}</span>
            </div>
            <div v-if="mode === 'note' || entry.note" class="detail-item">
                <label>Note</label>
                <textarea v-if="mode === 'note'" v-model="noteDraft" rows="3" placeholder="A note about this image" @keydown.esc.stop="mode = 'view'"></textarea>
                <span v-else>{{ entry.note }}</span>
            </div>
        </div>

        <template v-if="editable">
            <p v-if="unsaved" class="red">Save the table to keep image changes on {{ itemNumber }}.</p>
            <div v-if="mode === 'note'" class="button-bar">
                <button class="purple" @click="saveNote">Save note</button>
                <button class="gray" @click="mode = 'view'">Cancel</button>
            </div>
            <div v-else-if="mode === 'crop'" class="button-bar">
                <button class="purple" :disabled="!uncroppedUrl" @click="applyCrop">Apply crop</button>
                <button :disabled="!uncroppedUrl" @click="resetCrop">Whole image</button>
                <button class="gray" @click="mode = 'view'">Cancel</button>
            </div>
            <div v-else class="button-bar">
                <button @click="addImages"><span class="material-symbols-outlined">add_photo_alternate</span> Add image</button>
                <button :disabled="index === 0" @click="setAsThumbnail"><span class="material-symbols-outlined">star</span> Set as thumbnail</button>
                <button :disabled="!entry" @click="editCrop"><span class="material-symbols-outlined">crop</span> Crop image</button>
                <button :disabled="!entry" @click="editNote"><span class="material-symbols-outlined">edit_note</span> {{ entry && entry.note ? 'Edit note' : 'Add note' }}</button>
                <button class="red" :disabled="!entry" @click="removeImage"><span class="material-symbols-outlined">delete</span> Remove image</button>
            </div>
        </template>
    `
};

/** Upload images for an item from files or the clipboard (several at once). */
export const ThumbnailUploadModal = {
    name: 'ThumbnailUploadModal',
    inheritAttrs: false,
    props: {
        itemNumber: { type: String, required: true },
        onUploadSuccess: { type: Function, default: null }
    },
    data() {
        return {
            selected: [],          // [{ file, url }]
            uploading: false,
            progress: '',
            uploadError: null,
            canReadClipboard: !!navigator.clipboard?.read
        };
    },
    methods: {
        addFiles(files) {
            const images = Array.from(files || []).filter(file => file?.type?.startsWith('image/'));
            if (!images.length) {
                this.uploadError = 'Please select image files.';
                return;
            }
            this.uploadError = null;
            this.selected = [...this.selected, ...images.map(file => ({ file, url: URL.createObjectURL(file) }))];
        },
        removeSelected(i) {
            URL.revokeObjectURL(this.selected[i].url);
            this.selected = this.selected.filter((_, j) => j !== i);
        },
        handleFileSelect(event) {
            this.addFiles(event.target.files);
            this._clearFileInput();
        },
        // Wrap a clipboard blob in a named File — the resize and the Drive upload both expect one.
        // The name is irrelevant: uploadItemImage names the file after the item.
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
                const files = [];
                for (const item of items) {
                    const type = item.types.find(t => t.startsWith('image/'));
                    if (type) files.push(this._fileFromClipboardBlob(await item.getType(type), type));
                }
                if (files.length) this.addFiles(files);
                else this.uploadError = 'No image found on the clipboard.';
            } catch (e) {
                console.warn('[ThumbnailUploadModal] Clipboard read failed:', e);
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
            let files = Array.from(data.files || []).filter(f => f.type.startsWith('image/'));
            if (!files.length) {
                files = Array.from(data.items || []).filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
            }
            if (!files.length) {
                this.uploadError = 'No image found on the clipboard.';
                return;
            }
            this.addFiles(files.map(file => file.name ? file : this._fileFromClipboardBlob(file, file.type)));
        },
        async handleUpload() {
            if (!this.selected.length || this.uploading) return;
            this.uploading = true;
            this.uploadError = null;
            const uploads = [];
            try {
                for (let i = 0; i < this.selected.length; i++) {
                    this.progress = this.selected.length > 1 ? `Uploading ${i + 1} of ${this.selected.length}…` : 'Uploading…';
                    const uploaded = await Requests.uploadItemImage(this.selected[i].file, this.itemNumber);
                    if (!uploaded?.fileId) throw new Error('upload failed');
                    // Show the image straight from the file that was sent to Drive
                    await ThumbnailCache.seed(uploaded.fileId, uploaded.file);
                    uploads.push(uploaded);
                }
                await this.onUploadSuccess?.(uploads);
                this.$emit('close-modal');
            } catch (e) {
                console.error('[ThumbnailUploadModal] Upload error:', e);
                // Images uploaded before the failure are still added
                if (uploads.length) await this.onUploadSuccess?.(uploads);
                this.selected = this.selected.slice(uploads.length);
                this.uploadError = 'Upload failed. Please try again.';
            } finally {
                this.uploading = false;
                this.progress = '';
            }
        }
    },
    mounted() {
        window.addEventListener('paste', this.handleWindowPaste, true);
    },
    beforeUnmount() {
        window.removeEventListener('paste', this.handleWindowPaste, true);
        this.selected.forEach(s => URL.revokeObjectURL(s.url));
    },
    template: html`
        <div v-if="selected.length" class="thumbnail-gallery-strip">
            <div v-for="(s, i) in selected" :key="s.url" class="item-image-container thumbnail-upload-preview" :title="uploading ? '' : 'Click to leave this image out'" @click="!uploading && removeSelected(i)">
                <img class="image-layer" :src="s.url" alt="Preview" />
            </div>
        </div>
        <div v-if="canReadClipboard" class="card clickable white" @click="pasteFromClipboard" :disabled="uploading" title="Or press Ctrl+V">
            Paste from clipboard (ctrl + V)
        </div>
        <input ref="fileInput" class="card" style="width:100%" type="file" accept="image/*" multiple @change="handleFileSelect" :disabled="uploading" />
        <p class="gray">Images are resized to fit within 1000 × 1000 before upload.</p>
        <p class="red">Save the table to keep these images on {{ itemNumber }}.</p>
        <div v-if="uploadError" class="red card">{{ uploadError }}</div>
        <div class="button-bar">
            <button @click="handleUpload" :disabled="!selected.length || uploading">
                {{ uploading ? progress : (selected.length > 1 ? 'Upload ' + selected.length + ' images' : 'Upload') }}
            </button>
            <button class="gray" @click="$emit('close-modal')" :disabled="uploading">Cancel</button>
        </div>
    `
};
