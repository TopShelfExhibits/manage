import { parseItemVariants, SEVERITY } from '../index.js';
import { escapeHtml } from './views/fieldFormat.js';

/**
 * Decoration cards (views-and-renderers-plan §4.14) for the variants declared in an inventory
 * row's description (parseItemVariants): one card per letter, at the end of the cell. The
 * card's hover text has the count and the variant's description; a click opens it.
 * A family with a real letter variant item (itemVariantFamilies) doesn't use variants, so its
 * declared variants get one red card that says so instead.
 * @param {Object} row - Inventory row ({ itemNumber, quantity, description })
 * @param {Function} openModal - (message: HTML, title) shows the variant
 * @param {Set<string>} [families] - itemVariantFamilies of the row's tab
 * @returns {Object[]}
 */
export function itemVariantCards(row, openModal, families = new Set()) {
    if (!row?.itemNumber) return [];
    const { variants } = parseItemVariants(row.itemNumber, row.description);
    if (!variants.length) return [];
    if (families.has(row.itemNumber)) {
        const message = `Another item's number is ${row.itemNumber} plus a letter, so ${row.itemNumber}'s letters are item numbers, not variants. Its variant lines don't count. Rename that item, or remove the variant lines.`;
        return [{
            message: 'Variants off',
            severity: SEVERITY.critical,
            end: true,
            title: message,
            action: () => openModal(escapeHtml(message), `${row.itemNumber} variants`)
        }];
    }
    // float: right stacks cards right-to-left in DOM order, so reverse to keep declaration order
    return [...variants].reverse().map(variant => {
        const counted = variant.quantity !== null;
        const title = counted ? `${variant.itemNumber} (${variant.quantity} of ${row.quantity})` : variant.itemNumber;
        return {
            message: variant.letter,
            class: 'purple',
            end: true,
            title: `${title}: ${variant.description}`,
            action: () => openModal(escapeHtml(variant.description), title)
        };
    });
}
