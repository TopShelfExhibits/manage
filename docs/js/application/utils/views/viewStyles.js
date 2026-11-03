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
 * The item thumbnail column: an icon header and the image cell, which finds the picture by the
 * item number in `itemKey`. editable lets the cell change the picture.
 *
 * Custom for now (views-and-renderers-plan §4.14): the column holds no data and the cell looks
 * the image up itself. The ideal is an image-URL column in the inventory data that a view styles
 * as a thumbnail, with editing following that column's data controls.
 */
export function itemImageStyle(itemKey, { size = 48, editable = false } = {}) {
    return {
        width: 1,
        labelHtml: iconLabel('imagesmode'),
        cell: 'image',
        cellOptions: { itemKey, size, ...(editable ? { editable: true } : {}) }
    };
}
