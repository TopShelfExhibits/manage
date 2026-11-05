import { html, appSettings } from '../../index.js';
import { ThumbnailCache } from '../../utils/thumbnailCache.js';
import { parseThumbnailEntries, primaryThumbnail, addThumbnails, thumbnailKey } from '../../../data_management/utils/thumbnail-values.js';
import { cellProps } from './cells.js';

/**
 * Thumbnail display (the gallery's editing lives in thumbnailModals.js, loaded when a gallery opens).
 *
 * ThumbnailImage: one Drive file, with its crop, as a small image, fetched through the shared
 * ThumbnailCache only once it is on or near the screen. Without a file it shows the placeholder.
 * Props: fileId, crop, size (px), dimmed (a category image standing in for the item's own).
 * Default slot: overlays inside the image box (e.g. the cell's image count).
 */
export const ThumbnailImage = {
    name: 'ThumbnailImage',
    props: {
        fileId: { type: String, default: null },
        crop: { type: Object, default: null },
        size: { type: Number, default: 64 },
        dimmed: { type: Boolean, default: false }
    },
    data() {
        return {
            imageUrl: null,         // URL currently shown (owned by ThumbnailCache — never revoke)
            displayedKey: null,     // Image (file and crop) that imageUrl belongs to
            pendingKey: null,       // Image currently requested from ThumbnailCache
            fadeIn: false,          // True when the image arrived after mount, so it fades in
            isVisible: false,
            observing: false,
            retriedKey: null        // Image already re-downloaded once after a decode error
        };
    },
    computed: {
        imageKey() {
            return this.fileId ? thumbnailKey(this.fileId, this.crop) : null;
        },
        downloadsEnabled() {
            return !appSettings.onlyRunEssentialAnalysis;
        }
    },
    mounted() {
        this.refresh();
    },
    watch: {
        imageKey() {
            // A new image (an upload, a crop, a removal, a row reused for another item). The current
            // image stays up until the new one is ready, so changes never flash the placeholder.
            this.retriedKey = null;
            this.refresh();
        },
        downloadsEnabled(enabled) {
            if (enabled) this.refresh();
        }
    },
    methods: {
        refresh() {
            const key = this.imageKey;
            if (!key) {
                this.cancelPending();
                this.stopObserving();
                this.imageUrl = null;
                this.displayedKey = null;
                return;
            }
            if (key === this.displayedKey) return;

            const cached = ThumbnailCache.peek(this.fileId, this.crop);
            if (cached) {
                this.cancelPending();
                this.showImage(key, cached, false);
                return;
            }
            if (!this.isVisible) {
                // observe() reports the current state right away, which calls back into refresh()
                this.startObserving();
                return;
            }
            if (this.pendingKey === key) return;

            this.cancelPending();
            this.pendingKey = key;
            this.pending = { fileId: this.fileId, crop: this.crop };
            ThumbnailCache.load(this.fileId, this.crop).then(url => {
                if (this.pendingKey !== key) return; // superseded, cancelled, or unmounted
                this.pendingKey = null;
                if (url) this.showImage(key, url, true);
            });
        },
        showImage(key, url, fadeIn) {
            this.imageUrl = url;
            this.displayedKey = key;
            this.fadeIn = fadeIn;
            this.stopObserving();
        },
        cancelPending() {
            if (this.pendingKey) {
                ThumbnailCache.cancel(this.pending.fileId, this.pending.crop);
                this.pendingKey = null;
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
            const key = this.displayedKey;
            this.imageUrl = null;
            this.displayedKey = null;
            if (!key || this.retriedKey === key) return;
            this.retriedKey = key;
            ThumbnailCache.discard(this.fileId, this.crop);
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
            <slot></slot>
        </div>
    `
};

/**
 * The thumbnail cell (type 'thumbnail'): an item's image gallery (thumbnail-values.js). Only the
 * primary image is loaded here, as the item's icon (with its crop); the gallery loads the rest
 * when it opens. An item without images shows its category image (the INDEX Thumbnail of its
 * prefix). A row without the field (its tab has no Thumbnail column) is blank.
 *
 * Clicking opens the gallery (editable: add, remove, set as thumbnail, crop, note); an empty
 * editable cell opens the upload. Every change is committed like any edit, so the table's Save
 * keeps it (batch mode) and edit history records it.
 * Cell options (view): itemKey (the key holding the item number, for the category image and the
 * upload's file name), size (px, default 64), savedKey (the key holding the value the row's edit
 * history ends at, when it isn't the saved cell value; e.g. a proposal's current thumbnail).
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
        entries() { return parseThumbnailEntries(this.value); },
        primary() { return this.entries[0] || null; },
        category() {
            return !this.primary && this.hasColumn ? primaryThumbnail(ThumbnailCache.categoryFallback(this.itemNumber)) : null;
        },
        shown() { return this.primary || this.category; },
        canEdit() { return this.editable && !!this.commit && !!this.itemNumber; },
        clickable() { return !!this.primary || this.canEdit; },
        title() {
            if (this.primary) return this.entries.length > 1 ? `${this.entries.length} images` : 'Open image';
            if (this.canEdit) return 'Add images';
            return this.disabled || '';
        },
        // The value the row's edit history ends at: the saved cell value in a batch table (blank for
        // a row not saved yet), else the value shown (read-only rows are saved data)
        savedValue() {
            if (this.opts.savedKey) return this.row[this.opts.savedKey] ?? '';
            if (this.original !== undefined) return this.original;
            return this.editMode === 'batch' && this.canEdit ? '' : this.value;
        }
    },
    created() {
        ThumbnailCache.connect();
    },
    methods: {
        async open() {
            if (!this.clickable) return;
            const { ThumbnailGalleryModal, ThumbnailUploadModal } = await import('./thumbnailModals.js');
            if (!this.primary) {
                this.modal?.custom(ThumbnailUploadModal, {
                    itemNumber: this.itemNumber,
                    onUploadSuccess: (uploads) => this.commit(addThumbnails(this.value, uploads.map(u => u.fileId)))
                }, 'Add Images');
                return;
            }
            // Rows that aren't inventory rows (reports, the timeline) carry only the icon: the gallery
            // loads the item's full cell and history
            const isItemRow = 'edithistory' in this.row;
            this.modal?.custom(ThumbnailGalleryModal, {
                itemNumber: this.itemNumber,
                value: this.value,
                savedValue: this.savedValue,
                edithistory: isItemRow ? this.row.edithistory : null,
                loadItem: !isItemRow,
                onChange: this.canEdit ? (value) => this.commit(value) : null,
                size: 'page',
                tall: true
            }, `Images: ${this.itemNumber}`);
        }
    },
    template: html`
        <div v-if="!hasColumn" class="item-image-container" :style="{ width: size + 'px', height: size + 'px' }"></div>
        <ThumbnailImage
            v-else
            :fileId="shown ? shown.id : null"
            :crop="shown ? shown.crop || null : null"
            :size="size"
            :dimmed="!primary"
            :class="{ 'image-missing': canEdit && !shown }"
            :style="{ cursor: clickable ? 'pointer' : 'default' }"
            :title="title"
            @click.stop="open"
        >
            <span v-if="entries.length > 1" class="item-image-count">{{ entries.length }}</span>
        </ThumbnailImage>
    `
};
