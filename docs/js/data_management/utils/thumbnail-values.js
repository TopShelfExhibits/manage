/**
 * Thumbnail cell values: an item's image gallery. Pure, no imports, so UI modules can use it
 * without pulling in the data layer (which has top-level await).
 *
 * A thumbnail cell holds a JSON array of images. The first image is the primary one: the item's
 * icon in tables. Each image is a Google Drive file ID, or an object when it carries more:
 *   ["1AbC…", { "id": "2DeF…", "note": "Front view", "crop": { "x": 0.1, "y": 0, "w": 0.8, "h": 1 } }]
 *   note  free text shown with the image
 *   crop  the visible part of the file, as fractions of its width and height (non-destructive:
 *         the file itself is never changed)
 *
 * Reading is forgiving: blank is no images, and a bare file ID (not JSON) is read as one image.
 * Writing produces the JSON array form (an image with no note or crop as its bare ID), or blank
 * when there are no images.
 */

/**
 * The thumbnail field (what the data is) for pages that show item thumbnails: the inventory row key
 * `thumbnail` (sheet header Thumbnail). Pages showing other rows join it (itemThumbnails.js).
 */
export const THUMBNAIL_FIELD = Object.freeze({ key: 'thumbnail', label: 'Thumbnail', type: 'thumbnail', format: 'thumbnail' });

/** @typedef {{ x: number, y: number, w: number, h: number }} ThumbnailCrop  fractions of the file */
/** @typedef {{ id: string, note?: string, crop?: ThumbnailCrop }} ThumbnailEntry */

/** A crop that is valid and not the whole image, rounded to 4 decimals; else null. */
export function normalizeCrop(crop) {
    if (!crop || typeof crop !== 'object') return null;
    const round = (n) => Math.round(n * 10000) / 10000;
    const clamp = (n) => Math.min(1, Math.max(0, Number(n)));
    const x = clamp(crop.x), y = clamp(crop.y);
    const w = Math.min(clamp(crop.w), 1 - x), h = Math.min(clamp(crop.h), 1 - y);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0.01 || h <= 0.01) return null;
    if (x === 0 && y === 0 && w >= 0.9999 && h >= 0.9999) return null;
    return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

function toEntry(item) {
    if (typeof item === 'string' || typeof item === 'number') {
        const id = String(item).trim();
        return id ? { id } : null;
    }
    if (!item || typeof item !== 'object') return null;
    const id = String(item.id ?? '').trim();
    if (!id) return null;
    const entry = { id };
    const note = String(item.note ?? '').trim();
    if (note) entry.note = note;
    const crop = normalizeCrop(item.crop);
    if (crop) entry.crop = crop;
    return entry;
}

/** @param {*} value @returns {ThumbnailEntry[]} images, primary first */
export function parseThumbnailEntries(value) {
    const text = String(value ?? '').trim();
    if (!text) return [];
    if (!text.startsWith('[')) return [{ id: text }];
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.map(toEntry).filter(Boolean) : [];
    } catch {
        return [];
    }
}

/** @param {ThumbnailEntry[]} entries @returns {string} the cell value: a JSON array, or blank */
export function serializeThumbnailEntries(entries) {
    const list = (Array.isArray(entries) ? entries : []).map(toEntry).filter(Boolean)
        .map(entry => (entry.note || entry.crop) ? entry : entry.id);
    return list.length ? JSON.stringify(list) : '';
}

/** @param {*} value @returns {string[]} file IDs, primary first */
export function parseThumbnails(value) {
    return parseThumbnailEntries(value).map(entry => entry.id);
}

/** @param {string[]} ids @returns {string} the cell value for plain images */
export function serializeThumbnails(ids) {
    return serializeThumbnailEntries((Array.isArray(ids) ? ids : []).map(id => ({ id })));
}

/** @param {*} value @returns {ThumbnailEntry|null} the primary image */
export function primaryThumbnail(value) {
    return parseThumbnailEntries(value)[0] || null;
}

/** @param {*} value @returns {string|null} the primary image's file ID */
export function firstThumbnail(value) {
    return primaryThumbnail(value)?.id || null;
}

/** The primary image alone as a cell value, without its note (an icon: file and crop). */
export function primaryThumbnailValue(value) {
    const primary = primaryThumbnail(value);
    return primary ? serializeThumbnailEntries([{ id: primary.id, crop: primary.crop }]) : '';
}

// ── Gallery edits: each takes a cell value and returns the new one ──────────

/** Add images at the end (the first image added to an empty gallery becomes the primary). */
export function addThumbnails(value, ids) {
    const entries = parseThumbnailEntries(value);
    for (const id of ids) {
        if (id && !entries.some(entry => entry.id === id)) entries.push({ id });
    }
    return serializeThumbnailEntries(entries);
}

/** Remove the image at an index. */
export function removeThumbnailAt(value, index) {
    return serializeThumbnailEntries(parseThumbnailEntries(value).filter((_, i) => i !== index));
}

/** Make the image at an index the primary one (moved to the front; the others keep their order). */
export function setPrimaryThumbnail(value, index) {
    const entries = parseThumbnailEntries(value);
    if (index <= 0 || index >= entries.length) return serializeThumbnailEntries(entries);
    const [entry] = entries.splice(index, 1);
    return serializeThumbnailEntries([entry, ...entries]);
}

/** Set (or clear, with blank) the note of the image at an index. */
export function setThumbnailNote(value, index, note) {
    return serializeThumbnailEntries(parseThumbnailEntries(value).map((entry, i) => i === index ? { ...entry, note } : entry));
}

/** Set (or clear, with null) the crop of the image at an index. */
export function setThumbnailCrop(value, index, crop) {
    return serializeThumbnailEntries(parseThumbnailEntries(value).map((entry, i) => i === index ? { ...entry, crop } : entry));
}

/** A stable key for a file shown with a crop (image caches). */
export function thumbnailKey(fileId, crop = null) {
    const c = normalizeCrop(crop);
    return c ? `${fileId}#${c.x},${c.y},${c.w},${c.h}` : fileId;
}
