import { Requests, getReactiveStore, getPreferencesStore, resolveShortageAlertDays, shortageAlertDateFilters, NavigationRegistry, Priority } from '../index.js';

/**
 * Inventory shortage alerts (Requests.getInventoryShortageAlerts): the app-wide store, the app
 * banner, and the warning cards on inventory items and categories.
 */

/**
 * The app-wide alerts store: loaded at background priority and never evicted.
 * @returns {Object} Reactive store
 */
export function getShortageAlertsStore() {
    return getReactiveStore(Requests.getInventoryShortageAlerts, null, [], null, true, { load: Priority.BACKGROUND }, true);
}

/**
 * Days ahead the alerts look (InventoryShortageAlertDays preference; 0 = off).
 * Reactive: computed properties that call it update when the preference changes.
 * @returns {number}
 */
export function getShortageAlertDays() {
    return resolveShortageAlertDays(getPreferencesStore().data);
}

/**
 * The item shortage report on the alerts' shows.
 * @param {number} days
 * @param {string|null} [category] - Inventory tab title to filter the report to
 * @returns {string} Path
 */
export function shortageReportPath(days, category = null) {
    return NavigationRegistry.buildPath('reports/item-shortages', { dateFilters: shortageAlertDateFilters(days), ctgFilter: category || undefined });
}

// "1 item runs short", "3 items run short"
function itemsRunShort(count, noun = 'item') {
    return count === 1 ? `1 ${noun} runs short` : `${count} ${noun}s run short`;
}

/**
 * The app banner, or null when nothing is short.
 * @param {Array} alerts - Alert rows
 * @param {number} days
 * @param {Function} navigateToPath
 * @returns {Object|null} Banner (bannerNotifications.js)
 */
export function shortageBanner(alerts, days, navigateToPath) {
    const count = new Set((alerts || []).map(alert => alert.itemId)).size;
    if (!count || !days) return null;
    return {
        key: 'inventory-shortages',
        color: 'orange',
        message: `${itemsRunShort(count, 'inventory item')} in the next ${days} days.`,
        visible: true,
        dismissible: true,
        action: { label: 'View Report', fn: () => navigateToPath(shortageReportPath(days)) }
    };
}

/**
 * Alert rows grouped by item number.
 * @param {Array} alerts
 * @returns {Map<string, Array>}
 */
export function shortagesByItem(alerts) {
    const byItem = new Map();
    for (const alert of alerts || []) {
        if (!byItem.has(alert.itemId)) byItem.set(alert.itemId, []);
        byItem.get(alert.itemId).push(alert);
    }
    return byItem;
}

/**
 * Decoration cards (views-and-renderers-plan §4.14) for one item's shortage periods.
 * @param {Array|undefined} periods - The item's alert rows
 * @param {number} days
 * @returns {Object[]}
 */
export function itemShortageCards(periods, days) {
    if (!periods?.length) return [];
    const lowest = Math.min(...periods.map(period => period.minQty));
    const lines = periods.map(period => {
        const range = period.endDate && period.endDate !== period.startDate ? `${period.startDate} to ${period.endDate}` : period.startDate;
        const shows = period.shows.length ? ` (${period.shows.join(', ')})` : '';
        return `${range}: ${period.minQty}${shows}`;
    });
    return [{
        message: `Short ${-lowest}`,
        class: 'red',
        title: `Runs short in the next ${days} days:\n${lines.join('\n')}`
    }];
}

/**
 * Decoration card for a category with items that run short; it opens the report on the category.
 * @param {Array} alerts
 * @param {string} tabName - Inventory tab title
 * @param {number} days
 * @param {Function} navigateToPath
 * @returns {Object[]}
 */
export function categoryShortageCards(alerts, tabName, days, navigateToPath) {
    const count = new Set((alerts || []).filter(alert => alert.tabName === tabName).map(alert => alert.itemId)).size;
    if (!count) return [];
    return [{
        message: `${count} short`,
        class: 'red',
        title: `${itemsRunShort(count)} in the next ${days} days`,
        action: () => navigateToPath(shortageReportPath(days, tabName))
    }];
}
