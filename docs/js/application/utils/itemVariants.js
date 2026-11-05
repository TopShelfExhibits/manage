import { parseItemVariants } from '../index.js';
import { escapeHtml } from './views/fieldFormat.js';

/**
 * Decoration cards (views-and-renderers-plan §4.14) for the variants declared in an inventory
 * row's description (parseItemVariants): one card per letter, with its count. The card's hover
 * text is the variant's description; a click opens it.
 * @param {Object} row - Inventory row ({ itemNumber, quantity, description })
 * @param {Function} openModal - (message: HTML, title) shows the variant
 * @returns {Object[]}
 */
export function itemVariantCards(row, openModal) {
    if (!row?.itemNumber) return [];
    return parseItemVariants(row.itemNumber, row.description).variants.map(variant => {
        const counted = variant.quantity !== null;
        const title = counted ? `${variant.itemNumber} (${variant.quantity} of ${row.quantity})` : variant.itemNumber;
        return {
            message: counted ? `${variant.letter} · ${variant.quantity}` : variant.letter,
            class: 'gray',
            title: `${title}: ${variant.description}`,
            action: () => openModal(escapeHtml(variant.description), title)
        };
    });
}
