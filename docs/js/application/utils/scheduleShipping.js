import { Requests, createAnalysisConfig, Priority } from '../index.js';
import { estimateShipDate } from '../../data_management/utils/ship-date.js';
import { toUSDateString } from '../../data_management/utils/helpers.js';

/**
 * Ship and return info for Production Schedule rows, shared by every page that shows Schedule
 * rows (Schedule, Design Queue).
 *
 * The analysis entries call the same cached API methods with the same arguments on every page,
 * so a page reuses what another page already resolved instead of resolving it again.
 *   - Ship is shown with its year, and estimated from the show dates when missing (withShipDate,
 *     computed per row, so sorting by Ship is right before any analysis finishes).
 *   - A transship row ships when its source show ends: AppData.transshipSource names the source
 *     and AppData.transshipSourceEndDate is shown as its Ship date (also withShipDate).
 *   - A source show's return is extended to its destination's: AppData.transshipDestination.
 * shipReturnCards gives the matching decorations: "TS" on Ship and on Recieved (the column tells them apart).
 */

/** Decoration keys used by shipReturnCards (add them to a page's decorationKeys). */
export const SHIP_RETURN_DECORATION_KEYS = Object.freeze(['Ship', 'Recieved']);

/** Analysis entries for ship and return info (append to a schedule store's analysis config). */
export function shipReturnAnalysis() {
    return [
        // Detect transship rows early so the ship cell annotation is visible first
        createAnalysisConfig(
            Requests.getTransshipSourceEndDateForRow,
            'transshipSourceEndDate',
            'Checking transshipment dates...',
            ['Show', 'Client', 'Year'],
            [],
            null,
            false,
            Priority.ANALYSIS,
            true, // extractColumnsAsObject
            false // nonessential
        ),
        createAnalysisConfig(
            Requests.getTransshipSourceForScheduleRow,
            'transshipSource',
            'Checking transshipments...',
            ['Show', 'Client', 'Year'],
            [],
            null,
            false,
            Priority.ANALYSIS,
            true, // extractColumnsAsObject
            false // nonessential
        ),
        createAnalysisConfig(
            Requests.getTransshipDestinationsForScheduleRow,
            'transshipDestination',
            'Checking transshipment destinations...',
            ['Show', 'Client', 'Year'],
            [],
            null,
            false,
            Priority.ANALYSIS,
            true, // extractColumnsAsObject
            false // nonessential
        )
    ];
}

/**
 * The row as shown. Ship is the estimated ship date with its year (the sheet value, or a guess
 * from the show dates when it is missing); a transship row ships when its source show ends.
 * Sorting by Ship uses this value.
 */
export function withShipDate(row) {
    if (!row) return row;
    if (row.AppData?.transshipSource) {
        return { ...row, Ship: row.AppData.transshipSourceEndDate ?? '' };
    }
    const estimate = estimatedShipText(row);
    return estimate && estimate !== row.Ship ? { ...row, Ship: estimate } : row;
}

/** The estimated ship date as MM/DD/YYYY (sheet value or guess from the show dates), or null. */
export function estimatedShipText(row) {
    try { return toUSDateString(estimateShipDate(row)) || null; } catch { return null; }
}

function showLabel(row) {
    return [row.Client, row.Year, row.Show].filter(Boolean).join(' ');
}

/**
 * Decorations for the Ship and Recieved columns.
 * @param {Object} row
 * @param {string} key - column key
 * @param {Object} modal - the page's $modal (the cards open an explanation)
 * @returns {Array<Object>} cards
 */
export function shipReturnCards(row, key, modal) {
    const source = row?.AppData?.transshipSource;
    const dest = row?.AppData?.transshipDestination;
    if (key === 'Ship' && source) {
        return [{
            message: 'TS',
            class: 'gray',
            title: `transship from: ${source}`,
            action: () => modal?.alert(`${showLabel(row)}\ntransships directly from:\n${source}`, 'Transshipment')
        }];
    }
    // Return date for source shows is extended to the destination's return date
    if (key === 'Recieved' && dest) {
        return [{
            message: 'TS',
            class: 'gray',
            title: `Items remain out until the later show ends: ${dest}`,
            action: () => modal?.alert(`${showLabel(row)}\ntransships directly to:\n${dest}`, 'Extended Return')
        }];
    }
    return [];
}
