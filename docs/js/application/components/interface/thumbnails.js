import { html, appSettings } from '../../index.js';
import { ThumbnailCache } from '../../utils/thumbnailCache.js';
import { parseThumbnails, replaceFirstThumbnail, removeFirstThumbnail } from '../../../data_management/utils/thumbnail-values.js';
import { cellProps } from './cells.js';
import { ThumbnailViewModal, ThumbnailUploadModal } from './thumbnailModals.js';

/**
 * Thumbnail display: one Drive file as a small image, fetched through the shared ThumbnailCache only
 * once it is on or near the screen. Without a file it shows the placeholder.
 * Props: fileId, size (px), dimmed (a category image standing in for the item's own).
 */
export const ThumbnailImage = {
    name: 'ThumbnailImage',
    props: {
        fileId: { type: String, default: null },
        size: { type: Number, default: 64 },
        dimmed: { type: Boolean, default: false }
    },
    data() {
        return {
            imageUrl: null,         // URL currently shown (owned by ThumbnailCache — never revoke)
            displayedFileId: null,  // File that imageUrl belongs to
            pendingFileId: null,    // File currently requested from ThumbnailCache
            fadeIn: false,          // True when the image arrived after mount, so it fades in
            isVisible: false,
            observing: false,
            retriedFileId: null     // File already re-downloaded once after a decode error
        };
    },
    computed: {
        downloadsEnabled() {
            return !appSettings.onlyRunEssentialAnalysis;
        }
    },
    mounted() {
        this.refresh();
    },
    watch: {
        fileId() {
            // A new file (an upload, a removal, a row reused for another item). The current image
            // stays up until the new one is ready, so changes never flash the placeholder.
            this.retriedFileId = null;
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
                this.imageUrl = null;
                this.displayedFileId = null;
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
        <div class="item-image-container" :style="{ width: size + 'px', height: size + 'px', position: 'relative' }">
            <img
                v-if="imageUrl"
                :key="imageUrl"
                :class="['image-layer', { 'image-fade-in': fadeIn }]"
                :src="imageUrl"
                :alt="dimmed ? 'Category Image' : 'Item Image'"
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

/**
 * The thumbnail cell (type 'thumbnail'): the value is a JSON array of Drive file IDs and the first
 * one is shown (thumbnail-values.js). An item without an image shows its category image (the INDEX
 * Thumbnail of its prefix). A row without the field (its tab has no Thumbnail column) is blank.
 *
 * Editable: clicking an empty cell uploads an image; clicking an image opens it with Replace and
 * Remove. Uploads happen right away; the new value is committed like any edit, so the table's
 * Save keeps it (batch mode) and edit history records it.
 * Cell options (view): itemKey (the key holding the item number, for the category image and the
 * upload's file name), size (px, default 64).
 */
export const ThumbnailCell = {
    name: 'ThumbnailCell',
    props: cellProps,
    components: { ThumbnailImage },
    inject: { modal: { from: '$modal', default: null } },
    computed: {
        opts() { return this.field.cellOptions || {}; },
        size() { return this.opts.size || 64; },
        hasColumn() { return this.value !== undefined; },
        itemNumber() {
            const v = this.row[this.opts.itemKey || 'itemNumber'];
            return v == null ? '' : String(v).trim();
        },
        ownFileId() { return parseThumbnails(this.value)[0] || null; },
        categoryFileId() {
            return !this.ownFileId && this.hasColumn ? ThumbnailCache.categoryFallback(this.itemNumber) : null;
        },
        canUpload() { return this.editable && !!this.commit && !!this.itemNumber; },
        clickable() { return !!this.ownFileId || this.canUpload; },
        title() {
            if (this.ownFileId) return 'Expand image';
            if (this.canUpload) return 'Upload thumbnail';
            return this.disabled || '';
        }
    },
    created() {
        ThumbnailCache.connect();
    },
    methods: {
        open() {
            if (this.ownFileId) this.showImage();
            else if (this.canUpload) this.showUpload();
        },
        showImage() {
            const editable = this.canUpload;
            this.modal?.custom(ThumbnailViewModal, {
                fileId: this.ownFileId,
                size: 'page',
                tall: true,
                onReplace: editable ? () => this.showUpload() : null,
                onRemove: editable ? () => this.commit(removeFirstThumbnail(this.value)) : null
            }, `Image: ${this.itemNumber}`);
        },
        showUpload() {
            if (!this.canUpload) return;
            const replacing = !!this.ownFileId;
            this.modal?.custom(ThumbnailUploadModal, {
                itemNumber: this.itemNumber,
                mode: replacing ? 'replace' : 'add',
                onUploadSuccess: async ({ fileId, file }) => {
                    // Show the uploaded image straight from the file that was sent to Drive
                    await ThumbnailCache.seed(fileId, file);
                    this.commit(replaceFirstThumbnail(this.value, fileId));
                }
            }, replacing ? 'Replace Thumbnail' : 'Add Thumbnail');
        }
    },
    template: html`
        <div v-if="!hasColumn" class="item-image-container" :style="{ width: size + 'px', height: size + 'px' }"></div>
        <ThumbnailImage
            v-else
            :fileId="ownFileId || categoryFileId"
            :size="size"
            :dimmed="!ownFileId"
            :class="{ 'image-missing': canUpload && !ownFileId && !categoryFileId }"
            :style="{ cursor: clickable ? 'pointer' : 'default' }"
            :title="title"
            @click.stop="open"
        />
    `
};
