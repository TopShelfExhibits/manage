import { html, Requests } from '../../index.js';
import { ThumbnailCache } from '../../utils/thumbnailCache.js';

/**
 * Thumbnail editing modals, opened by the thumbnail cell (thumbnails.js). They upload and choose
 * images; the cell commits the new value, so the table's Save keeps it.
 */

/**
 * A full-size image with Replace and Remove. Shows the thumbnail right away and swaps in the
 * full-size file once it downloads. The full-size image is held only while the modal is open — it
 * is freed on close, never cached.
 */
export const ThumbnailViewModal = {
    props: {
        fileId: { type: String, required: true },
        onReplace: { type: Function, default: null },
        onRemove: { type: Function, default: null }
    },
    data() {
        return { fullImageUrl: null };
    },
    computed: {
        displayUrl() {
            return this.fullImageUrl || ThumbnailCache.peek(this.fileId) || 'assets/placeholder.png';
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
    methods: {
        replace() {
            this.onReplace();
            this.$emit('close-modal');
        },
        remove() {
            this.onRemove();
            this.$emit('close-modal');
        }
    },
    template: html`
        <img :src="displayUrl" alt="Image" style="max-width: 90vw; max-height: 70vh; object-fit: contain; align-self: center;" />
        <div v-if="onReplace || onRemove" class="button-bar" style="align-self: center;">
            <button v-if="onReplace" @click="replace">Replace</button>
            <button v-if="onRemove" class="red" @click="remove" title="Remove this image from the item (save the table to keep the change)">Remove</button>
        </div>
    `
};

/** Upload (or replace) an item's thumbnail from a file or the clipboard. */
export const ThumbnailUploadModal = {
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
                    await this.onUploadSuccess?.(uploaded);
                    this.$emit('close-modal');
                } else {
                    this.uploadError = 'Upload failed. Please try again.';
                }
            } catch (e) {
                console.error('[ThumbnailUploadModal] Upload error:', e);
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
        <p class="red">Save the table to keep this thumbnail on {{ itemNumber }}.</p>
        <div v-if="uploadError" class="red card">{{ uploadError }}</div>
        <div class="button-bar">
            <button @click="handleUpload" :disabled="!selectedFile || uploading">
                {{ uploading ? 'Uploading...' : (mode === 'replace' ? 'Replace' : 'Upload') }}
            </button>
            <button class="gray" @click="$emit('close-modal')" :disabled="uploading">Cancel</button>
        </div>
    `
};
