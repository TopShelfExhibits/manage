import { Requests, getReactiveStore, Priority } from '../index.js';

/**
 * Item thumbnails on pages whose rows aren't inventory rows (reports, proposals, the item
 * timeline). The page joins each row's item thumbnail as its `thumbnail` field, a derived field the
 * thumbnail cell then draws (Requests.getItemThumbnails). Inventory rows carry the field already.
 */

/**
 * The app-wide item thumbnails store: loaded at background priority and never evicted.
 * @returns {Object} Reactive store of [{ item, file }]
 */
export function getItemThumbnailsStore() {
    return getReactiveStore(Requests.getItemThumbnails, null, [], null, true, { load: Priority.BACKGROUND }, true);
}

/**
 * Item number → displayed file ID ('' when the item has none). Items in tabs without a Thumbnail
 * column are absent.
 * @param {Array<{item: string, file: string}>} entries - The store's data
 * @returns {Map<string, string>}
 */
export function itemThumbnailMap(entries) {
    return new Map((entries || []).map(entry => [entry.item, entry.file]));
}

/**
 * Copies of the rows with the item's thumbnail as `thumbnail`. Rows whose item has no thumbnail
 * column get no field, so their cell stays blank (not even the category image).
 * @param {Object[]} rows
 * @param {string} itemKey - The row key holding the item number
 * @param {Map<string, string>} map - itemThumbnailMap
 * @returns {Object[]}
 */
export function withItemThumbnails(rows, itemKey, map) {
    return (rows || []).map(row => map.has(row?.[itemKey]) ? { ...row, thumbnail: map.get(row[itemKey]) } : row);
}
