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
 *   With more than one past year, that month is averaged over them as a share of each year's square
 *   feet, at the last year's total, so one unusual month weighs less (projectVolume).
 * - Trend: a straight line through the square feet of each of the past `historyYears` years (the
 *   12 months before this one, the 12 before those, …); the multiplier k years ahead is the line's
 *   value k years past its last year over its last year (growthMultiplier). Years before the first
 *   show (0 square feet) are left out, and one year makes no line: the multiplier is 1.
 * - Use: learned per item from the shows of the last `usageMonths` full months that have a pack
 *   list and a size (itemUse). A show of S square feet takes the share of them that packed the item,
 *   times its typical quantity at S: coefficient × S^scale. The scale says how the item grows with
 *   size: 1 in step with square feet, 0 the same at any size. It is the median slope of quantity
 *   against size (both as logarithms) over the pairs of shows that packed it whose sizes differ by
 *   at least a fifth, kept within 0–2 and pulled toward 1 when few shows packed it (n shows: n / (n
 *   + 3) of the way); with fewer than 3 such pairs it is 1. The coefficient is the median of
 *   quantity / S^scale over those shows. Medians throughout, so one show packing far more than
 *   usual moves neither much.
 * - Shows out in the projected months:
 *   - booked, with a pack list: its quantities;
 *   - booked, without one: each item's use at its square feet;
 *   - expected but not booked yet: the shows of that same past month (or, without any, of the
 *     latest earlier year's), moved forward the years between, at their own sizes, each counted
 *     as many times as fills the gap between projected and booked (fillShows), at its use at its
 *     square feet.
 * - Booth mix: the volume above is square feet, right for an item in step with them (scale 1).
 *   Each item is projected on its own volume, the sum of size^scale over the shows (square feet
 *   at scale 1, the number of booths at 0), through the same steps: its own trend, seasonal
 *   average and gap. More small booths then raise an item that goes with booths more than one
 *   that goes with square feet, and bigger booths the other way. The month rows show the square
 *   feet (scale 1).
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

// The scale fit (itemUse): pairs of sizes closer than this ratio are left out; fewer pairs than
// the minimum keep the scale at 1; the fitted scale is kept within the range and pulled toward 1
// as if this many more shows had packed the item in step with square feet
const SCALE_PAIR_RATIO = 1.2;
const SCALE_MIN_PAIRS = 3;
const SCALE_RANGE = [0, 2];
const SCALE_PRIOR_SHOWS = 3;

/** The median of numbers (of an even count, the mean of the middle two) */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * An item's use, learned from the shows that packed it (see the model above): how often it is
 * packed, and its typical quantity at a size, coefficient × sqft^scale. itemQuantity applies it.
 * @param {Array<{qty: number, sqft: number}>} used - The learned shows that packed the item
 * @param {number} learned - How many shows were learned from
 * @returns {{ usedIn: number, share: number, coefficient: number, scale: number }} usedIn: the
 *          shows that packed it; share: usedIn of learned
 */
export function itemUse(used, learned) {
    const shows = used.filter(use => use.qty > 0 && use.sqft > 0);
    if (!shows.length || !(learned > 0)) return { usedIn: 0, share: 0, coefficient: 0, scale: 1 };
    const slopes = [];
    for (let i = 0; i < shows.length; i++) {
        for (let j = i + 1; j < shows.length; j++) {
            const sizes = Math.log(shows[j].sqft / shows[i].sqft);
            if (Math.abs(sizes) >= Math.log(SCALE_PAIR_RATIO)) slopes.push(Math.log(shows[j].qty / shows[i].qty) / sizes);
        }
    }
    let scale = 1;
    if (slopes.length >= SCALE_MIN_PAIRS) {
        const fitted = Math.min(SCALE_RANGE[1], Math.max(SCALE_RANGE[0], median(slopes)));
        scale = 1 + (fitted - 1) * shows.length / (shows.length + SCALE_PRIOR_SHOWS);
    }
    return {
        usedIn: shows.length,
        share: shows.length / learned,
        coefficient: median(shows.map(show => show.qty / show.sqft ** scale)),
        scale
    };
}

/**
 * The quantity of an item a show of `sqft` square feet is expected to take (itemUse).
 * @param {{share: number, coefficient: number, scale: number}} use
 * @param {number} sqft
 * @returns {number}
 */
export function itemQuantity(use, sqft) {
    return use.share * use.coefficient * sqft ** use.scale;
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
 * @param {{exact?: boolean}} [options] - exact: leave the volumes unrounded (a volume that isn't
 *        square feet, such as a count of booths, is small)
 * @returns {{ rows: Array<{month, shows, scheduledSqft, pastMonth, pastSqft, seasonalSqft, seasonalYears,
 *            multiplier, projectedSqft}>, trend: {years: number[], multipliers: number[]} }}
 *          pastMonth: the past month it carries forward; seasonalSqft: that month averaged over the
 *          past years with square feet (seasonalYears of them), at the last year's total; multiplier:
 *          the trend and growth factor it is carried forward by; trend.years: each past year's square
 *          feet, oldest first; trend.multipliers: 1, 2, … years ahead
 */
export function projectVolume({ months, scheduled, pastSqft }, settings, { exact = false } = {}) {
    const round = exact ? (n => n) : Math.round;
    // Year k back: the 12 months starting 12k months before the first future month
    const years = Array.from({ length: settings.historyYears }, (_, i) => settings.historyYears - i)
        .map(k => monthRange(addMonths(months[0], -12 * k), 12).reduce((sum, month) => sum + (pastSqft[month] || 0), 0));
    const yearsAheadOf = (month) => {
        let k = 1;
        while (addMonths(month, -12 * k) >= months[0]) k++;
        return k;
    };
    const multipliers = Array.from({ length: yearsAheadOf(months[months.length - 1]) }, (_, i) => growthMultiplier(years, i + 1));
    // The carried month lies in the last year; the same month of year i is (last − i) years earlier
    const last = years[years.length - 1];
    const seasonal = (pastMonth) => {
        const shares = years
            .map((total, i) => total > 0 ? (pastSqft[addMonths(pastMonth, -12 * (years.length - 1 - i))] || 0) / total : null)
            .filter(share => share !== null);
        if (shares.length < 2 || !(last > 0)) return { sqft: pastSqft[pastMonth] || 0, years: 1 };
        return { sqft: last * shares.reduce((sum, share) => sum + share, 0) / shares.length, years: shares.length };
    };
    const rows = months.map(month => {
        const booked = scheduled[month] || { sqft: 0, shows: 0 };
        const k = yearsAheadOf(month);
        const pastMonth = addMonths(month, -12 * k);
        const average = seasonal(pastMonth);
        const multiplier = multipliers[k - 1] * settings.growthFactor ** k;
        return {
            month,
            shows: booked.shows,
            scheduledSqft: booked.sqft,
            pastMonth,
            pastSqft: pastSqft[pastMonth] || 0,
            seasonalSqft: round(average.sqft),
            seasonalYears: average.years,
            multiplier: round3(multiplier),
            projectedSqft: round(Math.max(booked.sqft, average.sqft * multiplier))
        };
    });
    return { rows, trend: { years, multipliers: multipliers.map(round3) } };
}

/**
 * The shows expected but not booked yet: for each month projected above its booked volume, the
 * shows of the past month it carries forward (or, if it had none, of the same month in the latest
 * earlier year that had some), moved forward the years between, at their own sizes, each counted
 * `weight` times so their volume (the sum of sqft^scale) fills the gap.
 * @param {Array<{month, pastMonth, scheduledSqft, projectedSqft}>} rows - projectVolume rows, in the
 *        same volume
 * @param {Array<{ship: string, end: string, month: string, sqft: number}>} pastShows
 * @param {number} [scale] - The volume's scale: 1 square feet, 0 booths
 * @returns {Array<{month: string, from: string, start: string, end: string, sqft: number, weight: number}>}
 *          month: the month it fills; from: the past month it was moved from
 */
export function fillShows(rows, pastShows, scale = 1) {
    const sized = pastShows.filter(show => show.sqft > 0);
    const earliest = sized.reduce((min, show) => (show.month < min ? show.month : min), '9999-99');
    const filled = [];
    for (const { month, pastMonth, scheduledSqft, projectedSqft } of rows) {
        const gap = projectedSqft - scheduledSqft;
        if (!(gap > 0)) continue;
        let from = pastMonth;
        let models = sized.filter(show => show.month === from);
        while (!models.length && from > earliest) {
            from = addMonths(from, -12);
            models = sized.filter(show => show.month === from);
        }
        if (!models.length) continue;
        const weight = gap / models.reduce((sum, show) => sum + show.sqft ** scale, 0);
        const years = Number(month.slice(0, 4)) - Number(from.slice(0, 4));
        for (const show of models) {
            filled.push({ month, from, start: shiftYears(show.ship, years), end: shiftYears(show.end, years), sqft: show.sqft, weight });
        }
    }
    return filled;
}

/**
 * The projection, month by month.
 * @param {Object} input
 * @param {string[]} input.months - The future months, in order
 * @param {string} input.from - Today: the first month starts here
 * @param {Array<{month, sqft}>} input.scheduledShows - Booked shows shipping in the projected months
 * @param {Array<{ship, end, month, sqft}>} input.pastShows - Past shows, by the month they shipped
 * @param {Array<{start, end, sqft}>} input.packedShows - Booked shows out in the projected months
 *        with a pack list
 * @param {Array<{start, end, sqft}>} input.unpackedShows - The same without a pack list
 * @param {number} input.learned - How many shows the rates are learned from
 * @param {Array<{itemId: string, used: Array<{qty, sqft}>, packed: Array<{start, end, qty}>,
 *        stock: Object<string, number|null>}>} input.items - The learned shows that packed it, the
 *        booked pack list quantities out in the projected months, stock at each month's start
 * @param {Object} settings - resolveProjectionSettings
 * @returns {{ months: Array<Object>, items: Array<{itemId, usedIn, scale, at1000, multipliers}>, trend: Object, filled: number }}
 *          Each month: projectVolume's row in square feet, the shows filled in (filledShows,
 *          filledSqft, filledFrom: the past month they came from), the most square feet out on one
 *          day (sqftOut) and the items short ({ itemId, peak, stock, short, usedIn, learned, scale,
 *          at1000: its typical quantity at 1000 sq ft when packed, multiplier: its own trend that
 *          month }). Each item's multipliers: its own trend 1, 2, … years ahead.
 */
export function projectInventory({ months, from, scheduledShows, pastShows, packedShows = [], unpackedShows, learned, items }, settings) {
    const bookedCount = {};
    for (const show of scheduledShows) bookedCount[show.month] = (bookedCount[show.month] || 0) + 1;
    // A volume by month: the sum of sqft^scale over the shows with a size
    const volume = (shows, scale) => {
        const byMonth = {};
        for (const show of shows) if (show.sqft > 0) byMonth[show.month] = (byMonth[show.month] || 0) + show.sqft ** scale;
        return byMonth;
    };
    // The volume steps at one scale, once per scale; square feet (1) as before, rounded
    const byScale = new Map();
    const projectAt = (scale) => {
        if (!byScale.has(scale)) {
            const booked = volume(scheduledShows, scale);
            const scheduled = Object.fromEntries(months.map(month => [month, { sqft: booked[month] || 0, shows: bookedCount[month] || 0 }]));
            const { rows, trend } = projectVolume({ months, scheduled, pastSqft: volume(pastShows, scale) }, settings, { exact: scale !== 1 });
            byScale.set(scale, { rows, trend, filled: fillShows(rows, pastShows, scale) });
        }
        return byScale.get(scale);
    };
    const { rows, trend, filled } = projectAt(1);
    const window = (show, qty) => ({ start: show.start, end: show.end, qty });
    const sqftOut = peakByMonth([...packedShows, ...unpackedShows].map(show => window(show, show.sqft))
        .concat(filled.map(show => window(show, show.sqft * show.weight))), months, from);
    const rated = items.map(item => {
        const use = itemUse(item.used, learned);
        const own = projectAt(use.scale);
        const uses = [...item.packed, ...(use.share > 0 ? [
            ...unpackedShows.map(show => window(show, itemQuantity(use, show.sqft))),
            ...own.filled.map(show => window(show, show.weight * itemQuantity(use, show.sqft)))
        ] : [])];
        return {
            ...item,
            usedIn: use.usedIn,
            scale: use.scale,
            at1000: use.coefficient * 1000 ** use.scale,
            monthMultiplier: Object.fromEntries(own.rows.map(row => [row.month, row.multiplier])),
            multipliers: own.trend.multipliers,
            peaks: peakByMonth(uses, months, from)
        };
    });
    return {
        months: rows.map(row => {
            const filledHere = filled.filter(show => show.month === row.month);
            const shortages = [];
            for (const item of rated) {
                const stock = item.stock[row.month];
                if (stock === null || stock === undefined) continue;
                const peak = item.peaks[row.month];
                if (peak > 0 && peak - stock >= settings.minShortfall) {
                    shortages.push({ itemId: item.itemId, peak: round1(peak), stock, short: round3(stock - peak), usedIn: item.usedIn, learned, scale: round3(item.scale), at1000: round1(item.at1000), multiplier: item.monthMultiplier[row.month] });
                }
            }
            shortages.sort((a, b) => (a.short - b.short) || (a.itemId < b.itemId ? -1 : 1));
            return {
                ...row,
                filledShows: filledHere.length,
                filledSqft: Math.round(filledHere.reduce((sum, show) => sum + show.sqft * show.weight, 0)),
                filledFrom: filledHere[0]?.from || null,
                sqftOut: Math.round(sqftOut[row.month]),
                shortages
            };
        }),
        items: rated.map(({ itemId, usedIn, scale, at1000, multipliers }) => ({ itemId, usedIn, scale: round3(scale), at1000: round3(at1000), multipliers })),
        trend,
        filled: filled.length
    };
}

/**
 * One row per item that runs short (projectInventory months): the first month it does, and its
 * shortage, the most it falls short by in that month or a later one, so adding that many covers
 * the whole projection. Rounded down (short by 27.3 is -28). With quantity changes (a proposal's),
 * `proposed` is the shortage after them; null without. `months` lists every month it runs short,
 * each with its own shortage and proposed. Soonest month first, then the largest shortage.
 * @param {Array<{month: string, shortages: Array<{itemId: string, short: number}>}>} months
 * @param {Object<string, number>|null} [deltas] - Quantity change by item number
 * @returns {Array<{itemId: string, month: string, shortage: number, proposed: number|null,
 *          months: Array<{month: string, shortage: number, proposed: number|null}>}>}
 */
export function itemShortages(months, deltas = null) {
    const byItem = new Map();
    for (const { month, shortages } of months) {
        for (const { itemId, short } of shortages) {
            const row = byItem.get(itemId);
            if (row) {
                row.short = Math.min(row.short, short);
                row.months.push({ month, short });
            } else {
                byItem.set(itemId, { itemId, month, short, months: [{ month, short }] });
            }
        }
    }
    const down = (n) => Math.floor(n + 1e-9);
    const amounts = (itemId, short) => ({ shortage: down(short), proposed: deltas ? down(short + (deltas[itemId] || 0)) : null });
    return [...byItem.values()]
        .map(({ itemId, month, short, months: shortMonths }) => ({
            itemId,
            month,
            ...amounts(itemId, short),
            months: shortMonths.map(entry => ({ month: entry.month, ...amounts(itemId, entry.short) }))
        }))
        .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : (a.shortage - b.shortage) || (a.itemId < b.itemId ? -1 : 1)));
}
