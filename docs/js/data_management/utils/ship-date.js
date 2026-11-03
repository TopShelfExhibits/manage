import { parseDate } from './helpers.js';

/**
 * Ship date for a Production Schedule row, with fallbacks (pure: no data access).
 *   1. the Ship column (with its year; a ship date over nine months after the show start is
 *      moved to the previous year)
 *   2. S. Install minus 7 days
 *   3. S. Start minus 14 days
 *   4. S. End minus 21 days
 * Shared by ProductionUtils (overlaps, date inference) and the pages that show Schedule rows.
 * @param {Object} row - Schedule row with date fields (Ship, S. Install, S. Start, S. End, Year)
 * @returns {Date|null}
 */
export function estimateShipDate(row) {
    const year = row.Year;
    
    // Try explicit Ship date first
    let ship = parseDate(row.Ship, true, year);
    if (ship) {
        // Validate: ship date should be before show start
        // If ship is after show start and both are in the same year,
        // check if moving ship to previous year makes more sense
        const sStart = parseDate(row['S. Start'], true, year);
        const NINE_MONTHS_MS = 9 * 30 * 24 * 60 * 60 * 1000;
        if (sStart && ship >= sStart && (ship - sStart) > NINE_MONTHS_MS) {
            // Ship is more than 9 months after show start — likely a year boundary issue
            // Move ship to previous year
            const shipPrevYear = new Date(ship);
            shipPrevYear.setFullYear(ship.getFullYear() - 1);
            ship = shipPrevYear;
        }
        return ship;
    }
    
    // Fallback 1: S. Install - 7 days
    const sInstall = parseDate(row['S. Install'], true, year);
    if (sInstall) {
        return new Date(sInstall.getTime() - 7 * 86400000);
    }

    // Fallback 2: S. Start - 14 days
    const sStart = parseDate(row['S. Start'], true, year);
    if (sStart) {
        ship = new Date(sStart.getTime() - 14 * 86400000);
        
        // Ensure ship date is before show start date
        // If forcing the year makes ship date >= show start, keep it in the previous year
        if (ship.getFullYear() !== year) {
            const shipWithYearAdjusted = new Date(ship);
            shipWithYearAdjusted.setFullYear(Number(year));
            
            // Only adjust year if it keeps ship date before show start
            if (shipWithYearAdjusted < sStart) {
                ship = shipWithYearAdjusted;
            }
        }
        
        return ship;
    }
    
    // Fallback 3: S. End - 21 days
    const sEnd = parseDate(row['S. End'], true, year);
    if (sEnd) {
        ship = new Date(sEnd.getTime() - 21 * 86400000);
        
        // Ensure ship date is before show end date
        // If forcing the year makes ship date >= show end, keep it in the previous year
        if (ship.getFullYear() !== year) {
            const shipWithYearAdjusted = new Date(ship);
            shipWithYearAdjusted.setFullYear(Number(year));
            
            // Only adjust year if it keeps ship date before show end
            if (shipWithYearAdjusted < sEnd) {
                ship = shipWithYearAdjusted;
            }
        }
        
        return ship;
    }
    
    return null;
}
