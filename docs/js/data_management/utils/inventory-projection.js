/**
 * Inventory projection: pure helpers for the inventory projection report (no data access, no
 * cached calls). Requests.getInventoryProjection gathers the schedule, pack list and inventory
 * figures and passes them to projectInventory.
 *
 * The model, month by month (months are 'YYYY-MM', a show counts in the month it ships):
 * - Volume: a future month's projected square feet is the larger of what is already scheduled and
 *   the same month in past years (averaged over `historyYears`) times `growthFactor`.
 * - Rate: each item's pack list quantity over the last `usageMonths` full months, per square foot
 *   of the shows in those months that have a pack list.
 * - Use: a month's projected use is what its shows' pack lists already hold, plus the rate times
 *   the projected square feet no pack list covers yet.
 * - Reuse: how many times a month the stock can go out. Learned per item as its monthly use over
 *   its peak concurrent use (at least 1, at most `maxReuse`); `reuseFallback` instead when the item
 *   was used less than `learnMinUsage` times in the window or has less than `learnMinStock` in stock.
 * - Shortage: projected use above stock times reuse by at least `minShortfall`.
 * A transship chain counts once, at its root: its pack list items are the chain's (the peak across
 * its shows), so its square feet are the root's.
 */

/** Preference rows (CACHE/Preferences, page reports/inventory-projection) and their defaults */
export const PROJECTION_SETTINGS = Object.freeze({
    usageMonths: { id: 'ProjectionUsageMonths', type: 'integer', default: 3, min: 1 },
    historyYears: { id: 'ProjectionHistoryYears', type: 'integer', default: 1, min: 1 },
    growthFactor: { id: 'ProjectionGrowthFactor', type: 'double', default: 1, min: 0 },
    reuseFallback: { id: 'ProjectionReuseFallback', type: 'double', default: 1, min: 0.1 },
    maxReuse: { id: 'ProjectionMaxReuse', type: 'double', default: 4, min: 1 },
    learnMinUsage: { id: 'ProjectionLearnMinUsage', type: 'integer', default: 10, min: 0 },
    learnMinStock: { id: 'ProjectionLearnMinStock', type: 'integer', default: 5, min: 0 },
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

/**
 * The most an item had out at once: the largest sum of quantities whose date ranges overlap
 * (ranges include both ends). A use with no dates counts alone.
 * @param {Array<{start: string|null, end: string|null, qty: number}>} uses
 * @returns {number}
 */
export function peakConcurrentUse(uses) {
    const events = [];
    let peak = 0;
    for (const { start, end, qty } of uses || []) {
        if (!(qty > 0)) continue;
        if (!start) { peak = Math.max(peak, qty); continue; }
        events.push([start, 0, qty], [end && end >= start ? end : start, 1, qty]);
    }
    // Same day: starts before ends, so ranges that meet on a day overlap
    events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    let out = 0;
    for (const [, kind, qty] of events) {
        out += kind === 0 ? qty : -qty;
        peak = Math.max(peak, out);
    }
    return peak;
}

/**
 * How many times a month an item's stock can go out (see the model above).
 * @param {{ usage: number, peak: number, stock: number|null }} item - usage over the window
 * @param {Object} settings - resolveProjectionSettings
 * @returns {{ reuse: number, learned: boolean }}
 */
export function itemReuse({ usage, peak, stock }, settings) {
    const thin = !(peak > 0) || usage < settings.learnMinUsage || !(stock >= settings.learnMinStock);
    if (thin) return { reuse: settings.reuseFallback, learned: false };
    const monthly = usage / settings.usageMonths;
    return { reuse: Math.min(settings.maxReuse, Math.max(1, monthly / peak)), learned: true };
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * The projection, month by month.
 * @param {Object} input
 * @param {string[]} input.months - The future months, in order
 * @param {Object<string, {sqft: number, shows: number, coveredSqft: number}>} input.scheduled -
 *        Each future month's shows: square feet, count, and square feet with a pack list
 * @param {Object<string, number>} input.pastSqft - Square feet by past month
 * @param {number} input.usageSqft - Square feet of the usage window's shows with a pack list
 * @param {Array<{itemId: string, usage: number, peak: number, stockNow: number|null,
 *        known: Object<string, number>, stock: Object<string, number|null>}>} input.items -
 *        Window use and peak, stock today and at each month's start, pack list use by month
 * @param {Object} settings - resolveProjectionSettings
 * @returns {{ months: Array<Object>, items: Array<Object> }}
 */
export function projectInventory({ months, scheduled, pastSqft, usageSqft, items }, settings) {
    const rated = items.map(item => ({
        ...item,
        rate: usageSqft > 0 ? item.usage / usageSqft : 0,
        ...itemReuse({ usage: item.usage, peak: item.peak, stock: item.stockNow }, settings)
    }));
    const rows = months.map(month => {
        const booked = scheduled[month] || { sqft: 0, shows: 0, coveredSqft: 0 };
        const years = Array.from({ length: settings.historyYears }, (_, i) => pastSqft[addMonths(month, -12 * (i + 1))] || 0);
        const pastAverage = years.reduce((sum, sqft) => sum + sqft, 0) / years.length;
        const projectedSqft = Math.max(booked.sqft, pastAverage * settings.growthFactor);
        const uncoveredSqft = Math.max(0, projectedSqft - booked.coveredSqft);
        const shortages = [];
        for (const item of rated) {
            const stock = item.stock[month];
            if (stock === null || stock === undefined) continue;
            const projected = (item.known[month] || 0) + item.rate * uncoveredSqft;
            const capacity = stock * item.reuse;
            if (projected - capacity >= settings.minShortfall && projected > 0) {
                shortages.push({ itemId: item.itemId, projected: round1(projected), stock, capacity: round1(capacity), reuse: round1(item.reuse), learned: item.learned });
            }
        }
        shortages.sort((a, b) => (b.projected - b.capacity) - (a.projected - a.capacity) || (a.itemId < b.itemId ? -1 : 1));
        return {
            month,
            shows: booked.shows,
            scheduledSqft: booked.sqft,
            pastSqft: Math.round(pastAverage),
            projectedSqft: Math.round(projectedSqft),
            shortages
        };
    });
    return {
        months: rows,
        items: rated.map(({ itemId, usage, peak, rate, reuse, learned }) => ({ itemId, usage, peak, rate, reuse, learned }))
    };
}
