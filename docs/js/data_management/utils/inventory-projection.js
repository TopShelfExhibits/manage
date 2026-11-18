/**
 * Inventory projection: pure helpers for the inventory projection report (no data access, no
 * cached calls). Requests.getInventoryProjectionModel gathers the schedule, pack list and inventory
 * figures and passes them to projectInventory.
 *
 * Items are rented to shows for windows: a show has its items out from its ship date to its return
 * date (both days included). A transship chain counts once, at its root, out from the root's ship
 * date to the chain's last return; its pack list items are the chain's (the peak across its shows),
 * and its square feet are the root's. An item runs short when more are out at once than are in
 * stock.
 *
 * The model (months are 'YYYY-MM'; a show counts in the month it ships):
 * - Months: the next `futureYears` × 12, from this one (the first from today).
 * - Volume: a future month's projected square feet is the larger of what is already booked and the
 *   same month in the last past year, times the trend multiplier and `growthFactor` for each year it
 *   lies ahead of that month (a month 18 months out: the same month last year, two years ahead).
 * - Trend: a straight line through the square feet of each of the past `historyYears` years (the
 *   12 months before this one, the 12 before those, …); the multiplier k years ahead is the line's
 *   value k years past its last year over its last year (growthMultiplier). Years before the first
 *   show (0 square feet) are left out, and one year makes no line: the multiplier is 1.
 * - Rate: each item's pack list quantity over the last `usageMonths` full months, per square foot
 *   of the shows in those months that have a pack list and a size.
 * - Shows out in the projected months:
 *   - booked, with a pack list: its quantities;
 *   - booked, without one: rate × its square feet;
 *   - expected but not booked yet (a month's projected square feet above its booked square feet):
 *     the shows of that same past month, moved forward the years between, their square feet scaled
 *     to fill the gap (fillShows), each at rate × its square feet.
 * - Out at once: per item, the most out on any day of each month (peakByMonth).
 * - Shortage: that peak above the month's stock (at its start, scheduled changes applied) by at
 *   least `minShortfall` items. Its size in items is stock less the peak.
 * The report lists each item that runs short once (itemShortages): the first month it does, and the
 * most it falls short by from then on.
 */

/** Preference rows (CACHE/Preferences, page reports/inventory-projection) and their defaults */
export const PROJECTION_SETTINGS = Object.freeze({
    usageMonths: { id: 'ProjectionUsageMonths', type: 'integer', default: 3, min: 1 },
    futureYears: { id: 'ProjectionFutureYears', type: 'integer', default: 1, min: 1 },
    historyYears: { id: 'ProjectionHistoryYears', type: 'integer', default: 1, min: 1 },
    growthFactor: { id: 'ProjectionGrowthFactor', type: 'double', default: 1, min: 0 },
    defaultSquareFeet: { id: 'ProjectionDefaultSquareFeet', type: 'integer', default: 0, min: 0 },
    minShortfall: { id: 'ProjectionMinShortfall', type: 'double', default: 1, min: 0 }
});

/** The page whose menu shows the projection's preference rows */
export const PROJECTION_PAGE = 'reports/inventory-projection';

/**
 * The projection settings from preference rows ({ id, value }); a missing or invalid row takes
 * its default, and a value below its minimum takes the minimum.
 * @param {Array<{id: string, value: string}>} preferences
 * @returns {Object<string, number>}
 */
export function resolveProjectionSettings(preferences) {
    const rows = Array.isArray(preferences) ? preferences : [];
    const settings = {};
    for (const [key, spec] of Object.entries(PROJECTION_SETTINGS)) {
        const raw = rows.find(row => row?.id === spec.id)?.value;
        const value = spec.type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
        settings[key] = Number.isFinite(value) ? Math.max(spec.min, value) : spec.default;
    }
    return settings;
}

/**
 * Square feet of a schedule Size: every "W x D" in it, summed ("10x40 & 10x10" is 500). Feet
 * marks and spaces are allowed ("20' x 20'"). Null when it holds none ("TBD", "x18'").
 * @param {*} size
 * @returns {number|null}
 */
export function parseBoothSquareFeet(size) {
    const pattern = /(\d+(?:\.\d+)?)\s*'?\s*[x×]\s*(\d+(?:\.\d+)?)/gi;
    let total = 0;
    let found = false;
    for (const [, width, depth] of String(size ?? '').matchAll(pattern)) {
        total += Number(width) * Number(depth);
        found = true;
    }
    return found ? total : null;
}

/** 'YYYY-MM' of an ISO date */
export function monthOf(isoDate) {
    return typeof isoDate === 'string' && /^\d{4}-\d{2}/.test(isoDate) ? isoDate.slice(0, 7) : null;
}

/** The month `count` months after (or before, negative) a 'YYYY-MM' month */
export function addMonths(month, count) {
    const [year, mon] = month.split('-').map(Number);
    const index = year * 12 + (mon - 1) + count;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** `count` consecutive months from `first` */
export function monthRange(first, count) {
    return Array.from({ length: count }, (_, i) => addMonths(first, i));
}

/** An ISO date `years` years later; Feb 29 becomes Feb 28 in a year without one */
export function shiftYears(isoDate, years) {
    const year = Number(isoDate.slice(0, 4)) + years;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const rest = isoDate.slice(4, 10) === '-02-29' && !leap ? '-02-28' : isoDate.slice(4, 10);
    return `${year}${rest}`;
}

/** The ISO date after an ISO date */
function nextDay(isoDate) {
    const date = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}

const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * The most out at once on any day of each month: uses whose date ranges hold the day add up
 * (ranges include both ends, so ranges meeting on a day overlap). The first month starts at `from`
 * when that falls in it. A use without a start date is left out; one without an end is out its
 * start day.
 * @param {Array<{start: string|null, end: string|null, qty: number}>} uses
 * @param {string[]} months - In order
 * @param {string} [from] - ISO date the first month starts at
 * @returns {Object<string, number>} By month
 */
export function peakByMonth(uses, months, from = null) {
    const events = [];
    for (const { start, end, qty } of uses || []) {
        if (!(qty > 0) || !start) continue;
        events.push([start, qty], [nextDay(end && end >= start ? end : start), -qty]);
    }
    events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const peaks = {};
    let out = 0;
    let i = 0;
    months.forEach((month, index) => {
        const begin = index === 0 && monthOf(from) === month ? from : `${month}-01`;
        const end = `${addMonths(month, 1)}-01`;
        while (i < events.length && events[i][0] <= begin) out += events[i++][1];
        let peak = out;
        while (i < events.length && events[i][0] < end) {
            const day = events[i][0];
            while (i < events.length && events[i][0] === day) out += events[i++][1];
            peak = Math.max(peak, out);
        }
        peaks[month] = round3(peak);
    });
    return peaks;
}

/**
 * The growth multiplier of yearly totals: the least-squares line through them, its value
 * `yearsAhead` years past the last total over its value at the last total. Leading zero years
 * (before records began) are left out. 1 with fewer than two years or a line at or below 0 at the
 * last year; never below 0.
 * @param {number[]} yearTotals - Square feet by year, oldest first
 * @param {number} [yearsAhead]
 * @returns {number}
 */
export function growthMultiplier(yearTotals, yearsAhead = 1) {
    const first = yearTotals.findIndex(total => total > 0);
    const totals = first < 0 ? [] : yearTotals.slice(first);
    const n = totals.length;
    if (n < 2) return 1;
    const meanX = (n - 1) / 2;
    const meanY = totals.reduce((sum, y) => sum + y, 0) / n;
    let sxy = 0;
    let sxx = 0;
    totals.forEach((y, x) => { sxy += (x - meanX) * (y - meanY); sxx += (x - meanX) ** 2; });
    const slope = sxy / sxx;
    const last = meanY + slope * (n - 1 - meanX);
    if (!(last > 0)) return 1;
    return Math.max(0, (last + slope * yearsAhead) / last);
}

/**
 * Each future month's volume (see the model above).
 * @param {Object} input
 * @param {string[]} input.months - The future months, in order
 * @param {Object<string, {sqft: number, shows: number}>} input.scheduled - Booked, by month
 * @param {Object<string, number>} input.pastSqft - Square feet by past month
 * @param {Object} settings - resolveProjectionSettings
 * @returns {{ rows: Array<{month, shows, scheduledSqft, pastMonth, pastSqft, projectedSqft}>,
 *            trend: {years: number[], multipliers: number[]} }} pastMonth: the past month it carries
 *          forward; trend.years: each past year's square feet, oldest first; trend.multipliers: 1, 2,
 *          … years ahead
 */
export function projectVolume({ months, scheduled, pastSqft }, settings) {
    // Year k back: the 12 months starting 12k months before the first future month
    const years = Array.from({ length: settings.historyYears }, (_, i) => settings.historyYears - i)
        .map(k => monthRange(addMonths(months[0], -12 * k), 12).reduce((sum, month) => sum + (pastSqft[month] || 0), 0));
    const yearsAheadOf = (month) => {
        let k = 1;
        while (addMonths(month, -12 * k) >= months[0]) k++;
        return k;
    };
    const multipliers = Array.from({ length: yearsAheadOf(months[months.length - 1]) }, (_, i) => growthMultiplier(years, i + 1));
    const rows = months.map(month => {
        const booked = scheduled[month] || { sqft: 0, shows: 0 };
        const k = yearsAheadOf(month);
        const pastMonth = addMonths(month, -12 * k);
        const past = pastSqft[pastMonth] || 0;
        return {
            month,
            shows: booked.shows,
            scheduledSqft: booked.sqft,
            pastMonth,
            pastSqft: past,
            projectedSqft: Math.round(Math.max(booked.sqft, past * multipliers[k - 1] * settings.growthFactor ** k))
        };
    });
    return { rows, trend: { years, multipliers: multipliers.map(round3) } };
}

/**
 * The shows expected but not booked yet: for each month projected above its booked square feet,
 * the shows of the past month it carries forward, moved forward the years between, their square
 * feet scaled so they add up to the gap.
 * @param {Array<{month, pastMonth, scheduledSqft, projectedSqft}>} rows - projectVolume rows
 * @param {Array<{ship: string, end: string, month: string, sqft: number}>} pastShows
 * @returns {Array<{start: string, end: string, sqft: number}>}
 */
export function fillShows(rows, pastShows) {
    const filled = [];
    for (const { month, pastMonth, scheduledSqft, projectedSqft } of rows) {
        const gap = projectedSqft - scheduledSqft;
        const models = pastShows.filter(show => show.month === pastMonth && show.sqft > 0);
        const modelSqft = models.reduce((sum, show) => sum + show.sqft, 0);
        if (!(gap > 0) || !(modelSqft > 0)) continue;
        const years = Number(month.slice(0, 4)) - Number(pastMonth.slice(0, 4));
        for (const show of models) {
            filled.push({ start: shiftYears(show.ship, years), end: shiftYears(show.end, years), sqft: show.sqft * gap / modelSqft });
        }
    }
    return filled;
}

/**
 * The projection, month by month.
 * @param {Object} input
 * @param {string[]} input.months - The future months, in order
 * @param {string} input.from - Today: the first month starts here
 * @param {Object<string, {sqft: number, shows: number}>} input.scheduled - Booked, by month
 * @param {Object<string, number>} input.pastSqft - Square feet by past month
 * @param {Array<{ship, end, month, sqft}>} input.pastShows - Past shows, for fillShows
 * @param {Array<{start, end, sqft}>} input.unpackedShows - Booked shows out in the projected months
 *        without a pack list
 * @param {number} input.usageSqft - Square feet of the usage window's shows learned from
 * @param {Array<{itemId: string, usage: number, packed: Array<{start, end, qty}>,
 *        stock: Object<string, number|null>}>} input.items - Window use, the booked pack list
 *        quantities out in the projected months, stock at each month's start
 * @param {Object} settings - resolveProjectionSettings
 * @returns {{ months: Array<Object>, items: Array<{itemId, usage, rate}>, trend: Object, filled: number }}
 */
export function projectInventory({ months, from, scheduled, pastSqft, pastShows, unpackedShows, usageSqft, items }, settings) {
    const { rows, trend } = projectVolume({ months, scheduled, pastSqft }, settings);
    const filled = fillShows(rows, pastShows);
    const modelled = [...unpackedShows, ...filled];
    const rated = items.map(item => {
        const rate = usageSqft > 0 ? item.usage / usageSqft : 0;
        const uses = [...item.packed, ...(rate > 0 ? modelled.map(show => ({ start: show.start, end: show.end, qty: rate * show.sqft })) : [])];
        return { ...item, rate, peaks: peakByMonth(uses, months, from) };
    });
    return {
        months: rows.map(({ pastMonth, ...row }) => {
            const shortages = [];
            for (const item of rated) {
                const stock = item.stock[row.month];
                if (stock === null || stock === undefined) continue;
                const peak = item.peaks[row.month];
                if (peak > 0 && peak - stock >= settings.minShortfall) {
                    shortages.push({ itemId: item.itemId, peak: round1(peak), stock, short: round3(stock - peak) });
                }
            }
            shortages.sort((a, b) => (a.short - b.short) || (a.itemId < b.itemId ? -1 : 1));
            return { ...row, shortages };
        }),
        items: rated.map(({ itemId, usage, rate }) => ({ itemId, usage, rate })),
        trend,
        filled: filled.length
    };
}

/**
 * One row per item that runs short (projectInventory months): the first month it does, and its
 * shortage, the most it falls short by in that month or a later one, so adding that many covers
 * the whole projection. Rounded down (short by 27.3 is -28). With quantity changes (a proposal's),
 * `proposed` is the shortage after them; null without. Soonest month first, then the largest
 * shortage.
 * @param {Array<{month: string, shortages: Array<{itemId: string, short: number}>}>} months
 * @param {Object<string, number>|null} [deltas] - Quantity change by item number
 * @returns {Array<{itemId: string, month: string, shortage: number, proposed: number|null}>}
 */
export function itemShortages(months, deltas = null) {
    const byItem = new Map();
    for (const { month, shortages } of months) {
        for (const { itemId, short } of shortages) {
            const row = byItem.get(itemId);
            if (row) row.short = Math.min(row.short, short);
            else byItem.set(itemId, { itemId, month, short });
        }
    }
    const down = (n) => Math.floor(n + 1e-9);
    return [...byItem.values()]
        .map(({ itemId, month, short }) => ({ itemId, month, shortage: down(short), proposed: deltas ? down(short + (deltas[itemId] || 0)) : null }))
        .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : (a.shortage - b.shortage) || (a.itemId < b.itemId ? -1 : 1)));
}
