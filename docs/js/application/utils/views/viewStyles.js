/**
 * Shared view presentation: style entries (a view's `style[key]`) that several pages use.
 * Presentation only; what the data is stays on the page's fields.
 *
 * Pure: no Vue, no DOM.
 */

/** Header HTML for a material symbol ('imagesmode' → the icon). */
export function iconLabel(symbol) {
    return `<span class="material-symbols-outlined">${symbol}</span>`;
}

/**
 * A thumbnail column's look: an icon header, a narrow column and the image size. The cell itself
 * follows the field's data type ('thumbnail'), and editing follows the page's edit mode and the
 * field's `editable`. `itemKey` names the row key holding the item number (for the category image
 * and the upload's file name); `options` adds cell options (e.g. savedKey, see ThumbnailCell).
 */
export function thumbnailStyle(itemKey, size = 48, options = {}) {
    return {
        width: 1,
        labelHtml: iconLabel('imagesmode'),
        cellOptions: { itemKey, size, ...options }
    };
}
