/**
 * Thumbnail cell values. Pure, no imports, so UI modules can use it without pulling in the data
 * layer (which has top-level await).
 *
 * A thumbnail cell holds a JSON array of Google Drive file IDs: '["1AbC…"]'. The first entry is
 * the one displayed; the array leaves room for several images per item later.
 *
 * Reading is forgiving: blank is no images, and a bare file ID (not JSON) is read as one image.
 * Writing always produces the JSON array form, or blank when there are no images.
 */

/**
 * The thumbnail field (what the data is) for pages that show item thumbnails: the inventory row key
 * `thumbnail` (sheet header Thumbnail). Pages showing other rows join it (itemThumbnails.js).
 */
export const THUMBNAIL_FIELD = Object.freeze({ key: 'thumbnail', label: 'Thumbnail', type: 'thumbnail', format: 'thumbnail' });

/** @param {*} value @returns {string[]} file IDs, first one displayed */
export function parseThumbnails(value) {
    const text = String(value ?? '').trim();
    if (!text) return [];
    if (text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            return Array.isArray(parsed) ? parsed.map(id => String(id ?? '').trim()).filter(Boolean) : [];
        } catch {
            return [];
        }
    }
    return [text];
}

/** @param {string[]} ids @returns {string} the cell value: a JSON array, or blank */
export function serializeThumbnails(ids) {
    const list = (Array.isArray(ids) ? ids : []).map(id => String(id ?? '').trim()).filter(Boolean);
    return list.length ? JSON.stringify(list) : '';
}

/** @param {*} value @returns {string|null} the displayed (first) file ID */
export function firstThumbnail(value) {
    return parseThumbnails(value)[0] || null;
}

/** Replace the displayed (first) image, keeping any others. @returns {string} the new cell value */
export function replaceFirstThumbnail(value, fileId) {
    const ids = parseThumbnails(value);
    return serializeThumbnails([fileId, ...ids.slice(1)]);
}

/** Remove the displayed (first) image, keeping any others. @returns {string} the new cell value */
export function removeFirstThumbnail(value) {
    return serializeThumbnails(parseThumbnails(value).slice(1));
}
