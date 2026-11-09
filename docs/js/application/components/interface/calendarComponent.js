import { html, parseDate, LoadingBarComponent, NavigationRegistry, readRowMetadata } from '../../index.js';
import { useSearch, SearchBoxComponent, scrollToSearchResult, scrollToActiveResult } from '../../utils/useSearch.js';
import { useStickyHeader } from '../../utils/useStickyHeader.js';
import { formatText, escapeHtml } from '../../utils/views/fieldFormat.js';
import { matchRows } from '../../utils/views/searchMatch.js';
import { searchTiers } from '../../utils/views/resolveView.js';
import { ContentHeaderComponent } from './contentHeaderComponent.js';
import { CellRenderer, DecorationCards } from './cells.js';
import { placeDecorations } from '../../utils/views/decorations.js';
import { colorFor, rowColorFor } from '../../utils/views/viewColor.js';
import { statusColor } from '../../utils/severity.js';

export const CalendarComponent = {
    name: 'CalendarComponent',
    components: { LoadingBarComponent, SearchBoxComponent, ContentHeaderComponent, CellRenderer, DecorationCards },
    props: {
        // Renderer contract (views-and-renderers-plan §4.4): calendar fields, chip lines (N lines),
        // chip colour (rowColor), value colours and theme all come from the resolved view.
        resolved: { type: Object, required: true },
        // Primary action (ResolvedAction + perform(row, ctx) from DataView)
        action: { type: Object, default: null },
        decorations: { type: Function, default: null },
        decorationKeys: { type: Array, default: () => [] },
        viewSelect: { type: Object, default: null },
        data: { type: Array, default: () => [] },
        isLoading: { type: Boolean, default: false },
        isAnalyzing: { type: Boolean, default: false },
        loadingProgress: { type: Number, default: 0 },
        loadingMessage: { type: String, default: '' },
        error: { type: String, default: null },
        title: { type: String, default: '' },
        emptyMessage: { type: String, default: 'No events to display.' },
        showSearch: { type: Boolean, default: false },
        syncSearchWithUrl: { type: Boolean, default: false },
        showRefresh: { type: Boolean, default: false },
        containerPath: { type: String, default: '' },
        navigateToPath: { type: Function, default: null }
    },
    emits: ['refresh', 'row-action'],
    setup(props) {
        const search = useSearch({
            syncWithUrl: props.syncSearchWithUrl,
            navigationRegistry: NavigationRegistry,
            containerPath: props.containerPath,
            appContext: Vue.inject('appContext')
        });
        return { search };
    },
    data() {
        return {
            stickyActive: false,
            stickyLeft: 0,
            stickyWidth: 0,
            stickyHeight: 0,
            hoveredKey: null
        };
    },
    computed: {
        theme() {
            return this.resolved?.theme || '';
        },
        eventStartColumn() {
            return this.resolved?.calendar?.start;
        },
        eventEndColumn() {
            return this.resolved?.calendar?.end;
        },
        weekStart() {
            return this.resolved?.calendar?.weekStart || 'sunday';
        },
        yearColumn() {
            return this.resolved?.calendar?.yearColumn || null;
        },
        // Chip lines: N lines, each a list of fields shown inline
        chipLines() {
            const r = this.resolved;
            if (!r?.calendar) return [];
            return r.calendar.chip.map(line => line.map(key => {
                const f = r.fieldMap.get(key) || { key };
                return { ...f, label: f.label ?? key, colorRule: r.style[key]?.color || null };
            }));
        },
        // Cells in the chip's end button bar (view calendar.actions), before the decoration cards
        chipActionFields() {
            const r = this.resolved;
            return (r?.calendar?.actions || []).map(key => r.fieldMap.get(key) || { key });
        },
        // A shown action cell (style cell 'action') is the primary action's button
        actionInCell() {
            return [...this.chipLines.flat(), ...this.chipActionFields].some(f => f.cell === 'action');
        },
        chipFields() {
            return this.chipLines.flat();
        },
        dayNames() {
            const base = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            if (this.weekStart === 'saturday') {
                return [...base.slice(6), ...base.slice(0, 6)];
            }
            return base;
        },
        weekStartDayIndex() {
            // 0=Sunday, 6=Saturday
            return this.weekStart === 'saturday' ? 6 : 0;
        },
        // Searched tiers: chip lines are shown; details fields (opened in the modal) are searched too
        searchTierKeys() {
            return searchTiers(this.resolved);
        },
        searchResult() {
            return matchRows(this.data || [], this.searchTierKeys, this.search.searchWords.value);
        },
        searchActive() {
            return this.searchResult.active && !this.searchResult.aborted;
        },
        searchResultByRow() {
            const map = new Map();
            if (!this.searchActive) return map;
            this.searchResult.results.forEach((r, i) => { if (r) map.set(this.data[i], r); });
            return map;
        },
        searchMatchCount() {
            return this.searchResult.aborted ? Infinity : this.searchMatchedChips.length;
        },
        chipKeySet() {
            return new Set(this.searchTierKeys.shown);
        },
        // Decorations placed per row: inline on chip keys, the rest at the chip end
        rowDecorMap() {
            const map = new Map();
            if (!this.decorations) return map;
            for (const ev of this.parsedEvents) {
                map.set(ev.row, placeDecorations(this.decorations, this.decorationKeys, ev.row, this.chipKeySet));
            }
            return map;
        },
        effectiveAction() {
            return this.action || { kind: 'none', trigger: 'button' };
        },
        hasActionButton() {
            const a = this.effectiveAction;
            return a.kind !== 'none' && a.trigger === 'button' && !this.actionInCell;
        },
        chipIsTrigger() {
            const a = this.effectiveAction;
            return a.kind !== 'none' && a.trigger === 'row';
        },
        hasEndCards() {
            return !!this.decorations;
        },
        parsedEvents() {
            if (!this.data || this.data.length === 0) return [];
            return this.data
                .map((row, idx) => {
                    // Row groups are a table concept: a group master summarizes its members, which
                    // are the real events, so the calendar draws the members only.
                    if (this._isGroupMaster(row)) return null;
                    const defaultYear = this.yearColumn ? (row[this.yearColumn] || null) : null;
                    const start = parseDate(row[this.eventStartColumn], true, defaultYear);
                    const end = parseDate(row[this.eventEndColumn], true, defaultYear) || start;
                    if (!start) return null;
                    const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
                    const e = end
                        ? new Date(end.getFullYear(), end.getMonth(), end.getDate())
                        : new Date(s);
                    return { row, chipKey: idx, start: s, end: e < s ? s : e };
                })
                .filter(Boolean);
        },
        calendarWeeks() {
            if (this.parsedEvents.length === 0) return [];

            const wsd = this.weekStartDayIndex;

            let minDate = this.parsedEvents[0].start;
            let maxDate = this.parsedEvents[0].end;
            this.parsedEvents.forEach(e => {
                if (e.start < minDate) minDate = e.start;
                if (e.end > maxDate) maxDate = e.end;
            });

            const firstDay = this._getWeekStart(minDate, wsd);
            const lastDay = this._getWeekEnd(maxDate, wsd);

            const weeks = [];
            let current = new Date(firstDay);

            while (current <= lastDay) {
                const weekDays = [];
                for (let d = 0; d < 7; d++) {
                    weekDays.push(new Date(current));
                    current = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
                }

                const weekStart = weekDays[0];
                const weekEnd = weekDays[6];

                // Build segments for events that overlap this week
                const segments = [];
                for (const event of this.parsedEvents) {
                    if (event.end < weekStart || event.start > weekEnd) continue;

                    const segStartDate = event.start < weekStart ? weekStart : event.start;
                    const segEndDate = event.end > weekEnd ? weekEnd : event.end;

                    const startIdx = weekDays.findIndex(d => this._sameDay(d, segStartDate));
                    const endIdx = weekDays.findIndex(d => this._sameDay(d, segEndDate));

                    segments.push({
                        row: event.row,
                        chipKey: event.chipKey,
                        startIdx: startIdx >= 0 ? startIdx : 0,
                        endIdx: endIdx >= 0 ? endIdx : 6,
                        isStart: this._sameDay(event.start, segStartDate),
                        isEnd: this._sameDay(event.end, segEndDate)
                    });
                }

                // Sort by start day, longest first within same start
                segments.sort((a, b) => {
                    if (a.startIdx !== b.startIdx) return a.startIdx - b.startIdx;
                    return (b.endIdx - b.startIdx) - (a.endIdx - a.startIdx);
                });

                // Greedy lane assignment (first-fit interval scheduling)
                const lanes = [];
                for (const seg of segments) {
                    let placed = false;
                    for (const lane of lanes) {
                        const overlaps = lane.some(
                            s => !(s.endIdx < seg.startIdx || s.startIdx > seg.endIdx)
                        );
                        if (!overlaps) {
                            lane.push(seg);
                            placed = true;
                            break;
                        }
                    }
                    if (!placed) {
                        lanes.push([seg]);
                    }
                }

                let monthBoundaryIdx = -1;
                if (weeks.length > 0) {
                    const prevLastDay = weeks[weeks.length - 1].weekDays[6];
                    if (weekDays[0].getMonth() !== prevLastDay.getMonth()) {
                        monthBoundaryIdx = 0;
                    } else {
                        for (let i = 1; i < 7; i++) {
                            if (weekDays[i].getMonth() !== weekDays[i - 1].getMonth()) {
                                monthBoundaryIdx = i;
                                break;
                            }
                        }
                    }
                }
                weeks.push({ weekDays, lanes, isMonthBoundary: monthBoundaryIdx >= 0, monthBoundaryIdx });
            }

            weeks.forEach((week, i) => {
                const prev = weeks[i - 1];
                week.monthAfterBoundaryIdx = (prev && prev.isMonthBoundary && prev.monthBoundaryIdx > 0) ? prev.monthBoundaryIdx : -1;
            });
            const maxLanes = weeks.length > 0 ? Math.max(1, ...weeks.map(w => w.lanes.length)) : 0;
            return weeks.map(w => ({ ...w, paddingLanes: maxLanes - w.lanes.length }));
        },
        isEmpty() {
            return !this.isLoading && !this.isAnalyzing && (!this.data || this.data.length === 0);
        },
        searchMatchedChips() {
            if (!this.searchActive) return [];
            const byRow = this.searchResultByRow;
            return this.parsedEvents.filter(event => byRow.has(event.row));
        },
        searchMatchChipKeyMap() {
            const map = new Map();
            this.searchMatchedChips.forEach((event, idx) => map.set(event.chipKey, idx));
            return map;
        },
        activeSearchIndex() { return this.search.searchIndex.value; }
    },
    watch: {
        activeSearchIndex(newIndex) {
            if (newIndex == null) return;
            scrollToActiveResult(this, this.activeSearchIndex, this.searchMatchedChips.length);
        },
        searchMatchedChips(newChips) {
            if (this.activeSearchIndex != null && newChips.length > 0) {
                scrollToActiveResult(this, this.activeSearchIndex, this.searchMatchedChips.length);
            }
        },
        // Trigger sticky header recalculation when parameters change on the same route
        // (parameter-only changes don't cause component remount, unlike full route changes)
        'appContext.currentPath'(newPath, oldPath) {
            if (!newPath || !oldPath || newPath === oldPath) return;
            
            // Extract base path (without query params) for both old and new
            const oldBasePath = oldPath.split('?')[0];
            const newBasePath = newPath.split('?')[0];
            
            // Only update if it's a parameter-only change on the same base route
            // Full route changes cause component remount, so skip those
            if (oldBasePath === newBasePath && this._stickyHeader) {
                this._stickyHeader.reset();
                this.$nextTick(() => {
                    this._stickyHeader.update();
                });
            }
        }
    },
    inject: ['appContext'],
    mounted() {
        this.search.initializeFromUrl();
        this.search.setupUrlWatcher();
        this._stickyHeader = useStickyHeader({
            getStickyEl: () => this.$el?.querySelector('.sticky-header-wrapper'),
            getSpacerEl: () => this.$el?.querySelector('.calendar-sticky-spacer'),
            getContainerEl: () => [
                this.$el,
                this.$el?.closest('.container'),
            ].filter(Boolean),
            getIsActive: () => this.stickyActive,
            onActivate: () => {
                const stickyEl = this.$el?.querySelector('.sticky-header-wrapper');
                const rect = this.$el?.getBoundingClientRect();
                this.stickyHeight = stickyEl ? stickyEl.offsetHeight : 0;
                this.stickyActive = true;
                this.stickyLeft = rect ? rect.left : 0;
                this.stickyWidth = rect ? rect.width : 0;
            },
            onDeactivate: () => {
                this.stickyActive = false;
            },
        });
        // Use requestAnimationFrame to ensure layout measurements are accurate after all DOM updates
        this.$nextTick(() => {
            requestAnimationFrame(() => {
                if (this._stickyHeader) this._stickyHeader.setup();
            });
        });
    },
    beforeUnmount() {
        this._stickyHeader?.teardown();
    },
    methods: {
        statusColor,
        _isGroupMaster(row) {
            return !!readRowMetadata(row).grouping?.isGroupMaster;
        },
        _getWeekStart(date, weekStartDay) {
            const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            let diff = d.getDay() - weekStartDay;
            if (diff < 0) diff += 7;
            d.setDate(d.getDate() - diff);
            return d;
        },
        _getWeekEnd(date, weekStartDay) {
            const start = this._getWeekStart(date, weekStartDay);
            return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
        },
        _sameDay(a, b) {
            return (
                a.getFullYear() === b.getFullYear() &&
                a.getMonth() === b.getMonth() &&
                a.getDate() === b.getDate()
            );
        },
        isToday(date) {
            return this._sameDay(date, new Date());
        },
        isFirstOfMonth(date) {
            return date.getDate() === 1;
        },
        showYear(day, wIdx, dayIdx) {
            return (wIdx === 0 && dayIdx === 0) || (day.getDate() === 1 && day.getMonth() === 0);
        },
        monthAbbr(date) {
            return date.toLocaleDateString('en-US', { month: 'short' });
        },
        chipGridColumn(seg) {
            return `${seg.startIdx + 1} / ${seg.endIdx + 2}`;
        },
        chipClasses(seg) {
            // Only chips that run the primary action are clickable (and change colour on hover)
            const cls = this.chipIsTrigger ? ['clickable'] : [];
            if (!seg.isStart) cls.push('chip-continuation');
            if (!seg.isEnd) cls.push('chip-continues');
            if (seg.row && seg.row.AppData && seg.row.AppData._analyzing) cls.push('analyzing');
            const colorCls = this.resolved?.rowColor ? rowColorFor(seg.row, this.resolved) : '';
            cls.push(colorCls || 'blue');
            if (!this.chipIsTrigger) cls.push('chip-no-trigger');
            if (this.chipIsTrigger && this.hoveredKey !== null && this.hoveredKey === seg.chipKey) cls.push('hovered');
            if (this.searchActive && this.searchMatchChipKeyMap.get(seg.chipKey) === this.search.searchIndex.value - 1) {
                cls.push('search-active-result');
            }
            if (this.chipIsTrigger && this.isDetailsOnlyMatch(seg.row)) cls.push('details-match');
            return cls;
        },
        chipTitle(row) {
            return this.chipFields
                .map(col => formatText(row[col.key], col))
                .filter(Boolean)
                .join(' — ');
        },
        // Escaped, formatted, highlighted chip text (no highlight while the search is inactive or aborted)
        highlightValue(value, field) {
            const text = formatText(value, field);
            return this.searchActive ? this.search.highlightRawText(text) : escapeHtml(text);
        },
        isDetailsOnlyMatch(row) {
            const r = this.searchResultByRow.get(row);
            return !!(r && !r.shownMatch);
        },
        isActionDisabled(row) {
            const fn = this.effectiveAction.disabled;
            try { return typeof fn === 'function' ? !!fn(row) : false; } catch { return false; }
        },
        inlineCards(row, colKey) {
            return this.rowDecorMap.get(row)?.byKey.get(colKey) || [];
        },
        endCards(row) {
            return this.rowDecorMap.get(row)?.rowLevel || [];
        },
        valueColorClass(row, col) {
            return col.colorRule ? colorFor(row, col, this.resolved) : '';
        },
        selectSearchResultFor(row) {
            if (!this.searchActive) return;
            const chipKey = this.parsedEvents.findIndex(e => e.row === row);
            if (chipKey >= 0) {
                const matchIdx = this.searchMatchChipKeyMap.get(chipKey);
                if (matchIdx !== undefined) this.search.setSearchIndex(matchIdx + 1);
            }
        },
        // Primary action (§4.8): perform via DataView (row-action if no perform is supplied)
        performAction(row) {
            const a = this.effectiveAction;
            if (a.kind === 'none' || this.isActionDisabled(row)) return;
            const ctx = { searchTerm: (this.search.searchValue.value || '').trim() };
            if (typeof a.perform === 'function') a.perform(row, ctx);
            else this.$emit('row-action', row, ctx);
        },
        handleEventClick(row, event) {
            if (event?.target?.closest?.('button, a, input, select, textarea, .card.clickable')) return;
            this.selectSearchResultFor(row);
            if (this.chipIsTrigger) this.performAction(row);
        },
        handleActionButton(row) {
            this.selectSearchResultFor(row);
            this.performAction(row);
        },
        // The row's primary action for an action cell
        rowActionFor(row) {
            if (this.effectiveAction.kind === 'none') return null;
            return {
                run: () => this.handleActionButton(row),
                disabled: this.isActionDisabled(row),
                title: this.effectiveAction.title || this.effectiveAction.label || ''
            };
        },
        // A material symbol name ('calendar_month') rather than a glyph ('☷')
        isSymbolName(text) {
            return typeof text === 'string' && /^[a-z][a-z0-9_]*$/.test(text);
        },
        handleKeyDown(event, row) {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.selectSearchResultFor(row);
                this.performAction(row);
            }
        },
        handleRefresh() {
            this.$emit('refresh');
        }

    },
    template: html`
        <div class="calendar-container">

            <!-- Error Banner -->
            <div v-if="error" class="content-header red">
                <span>Error: {{ error }}</span>
            </div>

            <!-- Spacer: prevents layout jump when header becomes fixed -->
            <div class="calendar-sticky-spacer" :style="{ height: stickyActive ? stickyHeight + 'px' : '0' }" aria-hidden="true"></div>

            <!-- Sticky: filter header + day-of-week row -->
            <div class="sticky-header-wrapper" :style="stickyActive ? { position: 'fixed', left: stickyLeft + 'px', width: stickyWidth + 'px', zIndex: '500' } : {}">
                <ContentHeaderComponent
                    :theme="theme"
                    :search="search"
                    :show-search="showSearch"
                    :match-count="searchMatchCount"
                    :show-refresh="showRefresh"
                    :is-loading="isLoading"
                    :view-select="viewSelect"
                    :embedded-loading="true"
                    :is-analyzing="isAnalyzing"
                    :loading-progress="loadingProgress"
                    :always-show-buttons="true"
                    @refresh="handleRefresh"
                >
                    <template #header-area><slot name="header-area"></slot></template>
                </ContentHeaderComponent>
                <div v-if="!isEmpty && calendarWeeks.length > 0" class="calendar-dow-header">
                    <div v-for="name in dayNames" :key="name" class="calendar-dow-cell">{{ name }}</div>
                </div>
            </div>

            <!-- Weeks -->
            <div v-if="!isEmpty && calendarWeeks.length > 0" class="calendar-weeks-container">
                <div
                    v-for="(week, wIdx) in calendarWeeks"
                    :key="week.weekDays[0].toISOString()"
                    :class="['calendar-week', { 'month-boundary': week.isMonthBoundary, 'month-after-boundary': week.monthAfterBoundaryIdx > 0 }]"
                >
                    <!-- Date number row -->
                    <div class="calendar-date-row">
                        <div
                            v-for="(day, dayIdx) in week.weekDays"
                            :key="day.toISOString()"
                            :class="{ 'calendar-date-cell': true, 'month-old': (week.isMonthBoundary && dayIdx < week.monthBoundaryIdx) || (week.monthAfterBoundaryIdx > 0 && dayIdx >= week.monthAfterBoundaryIdx), 'month-new': (week.isMonthBoundary && dayIdx >= week.monthBoundaryIdx) || (week.monthAfterBoundaryIdx > 0 && dayIdx < week.monthAfterBoundaryIdx), 'month-last-old': week.isMonthBoundary && week.monthBoundaryIdx > 0 && dayIdx === week.monthBoundaryIdx - 1 }"
                        >
                            <span v-if="isFirstOfMonth(day) || (wIdx === 0 && dayIdx === 0)" class="calendar-month-label">{{ monthAbbr(day) }}</span>
                            <span :class="['calendar-date-number', { today: isToday(day) }]">{{ day.getDate() }}</span>
                            <span v-if="showYear(day, wIdx, dayIdx)" class="calendar-year-label">{{ day.getFullYear() }}</span>
                        </div>
                    </div>

                    <!-- Event lanes -->
                    <div
                        v-for="(lane, laneIdx) in week.lanes"
                        :key="laneIdx"
                        class="calendar-lane-row"
                    >
                        <div v-for="n in 7" :key="'bg' + n" :class="{ 'calendar-grid-bg-cell': true, 'month-last-old': week.isMonthBoundary && week.monthBoundaryIdx > 0 && (n - 1) === week.monthBoundaryIdx - 1, 'cal-bg-last': n === 7, 'today': isToday(week.weekDays[n - 1]) }" :style="{ gridColumn: n, gridRow: '1' }" aria-hidden="true"></div>
                        <div
                            v-for="seg in lane"
                            :key="seg.row[eventStartColumn] + '-' + seg.row[eventEndColumn] + '-' + seg.startIdx"
                            :class="['calendar-chip', ...chipClasses(seg)]"
                            :data-search-match-idx="searchMatchChipKeyMap.get(seg.chipKey)"
                            :style="{ gridColumn: chipGridColumn(seg), gridRow: '1' }"
                            :title="chipTitle(seg.row)"
                            :tabindex="chipIsTrigger ? 0 : -1"
                            @mouseenter="hoveredKey = seg.chipKey"
                            @mouseleave="hoveredKey = null"
                            @click="handleEventClick(seg.row, $event)"
                            @keydown="handleKeyDown($event, seg.row)"
                        >
                            <!-- Chip end: one button bar with the view's action cells (calendar.actions), the
                                 decoration cards (hidden when narrow) and the primary action button, last.
                                 Placed first in DOM so flex-direction:row-reverse anchors it to the right;
                                 overflow clips left-ward so the action button is always visible. -->
                            <div v-if="seg.isEnd && (chipActionFields.length || hasActionButton || (hasEndCards && endCards(seg.row).length))" class="chip-actions button-bar">
                                <template v-for="f in chipActionFields" :key="f.key">
                                    <CellRenderer :row="seg.row" :field="f" renderer="calendar" density="compact" :highlight="highlightValue" :theme="theme" :search-term="search.searchKey.value" :cell-slot="$slots.cell" :row-action="f.cell === 'action' ? rowActionFor(seg.row) : null" />
                                    <DecorationCards :cards="inlineCards(seg.row, f.key)" :inline="true" />
                                </template>
                                <template v-if="hasEndCards">
                                    <button
                                        v-for="(card, ci) in endCards(seg.row)"
                                        :key="ci + '-' + card.message"
                                        :class="['card', 'hide-when-narrow', statusColor(card), { 'clickable': card.action && !card.disabled }]"
                                        :title="card.title || card.hoverMessage || null"
                                        :disabled="card.disabled"
                                        @click.stop="card.action && !card.disabled ? card.action() : null"
                                        v-html="card.message"
                                    ></button>
                                </template>
                                <button
                                    v-if="hasActionButton"
                                    :class="['button-symbol', 'chip-action-button', theme || 'white', isDetailsOnlyMatch(seg.row) ? 'search-match' : '']"
                                    :disabled="isActionDisabled(seg.row)"
                                    :title="effectiveAction.title || effectiveAction.label || 'Details'"
                                    @click.stop="handleActionButton(seg.row)"
                                ><template v-if="effectiveAction.label">{{ effectiveAction.label }}</template><span v-else-if="isSymbolName(effectiveAction.icon)" class="material-symbols-outlined">{{ effectiveAction.icon }}</span><template v-else>{{ effectiveAction.icon || '☷' }}</template></button>
                            </div>
                            <div class="chip-text">
                                <!-- N chip lines (resolved.calendar.chip); the first line is the title line -->
                                <span v-for="(line, li) in chipLines" :key="li" :class="li === 0 ? 'chip-first-row' : 'chip-second-row'">
                                    <template v-for="(col, colIdx) in line" :key="col.key">
                                        <span v-if="colIdx > 0" class="chip-sep"> | </span>
                                        <span :class="['chip-val', valueColorClass(seg.row, col)]"><CellRenderer :row="seg.row" :field="col" renderer="calendar" density="compact" :highlight="highlightValue" :theme="theme" :search-term="search.searchKey.value" :cell-slot="$slots.cell" :row-action="col.cell === 'action' ? rowActionFor(seg.row) : null" /></span>
                                        <DecorationCards :cards="inlineCards(seg.row, col.key)" :inline="true" />
                                    </template>
                                </span>
                            </div>
                        </div>
                    </div>

                    <!-- Padding lanes to equalize week heights -->
                    <div
                        v-for="p in week.paddingLanes"
                        :key="'pad-' + p"
                        class="calendar-lane-row calendar-lane-padding"
                        aria-hidden="true"
                    >
                        <div v-for="n in 7" :key="'bgp' + n" :class="{ 'calendar-grid-bg-cell': true, 'month-last-old': week.isMonthBoundary && week.monthBoundaryIdx > 0 && (n - 1) === week.monthBoundaryIdx - 1, 'cal-bg-last': n === 7, 'today': isToday(week.weekDays[n - 1]) }" :style="{ gridColumn: n, gridRow: '1' }" aria-hidden="true"></div>
                    </div>
                </div>
            </div>

            <!-- Loading/empty states -->
            <div v-if="isLoading && (!data || data.length === 0)" class="content-footer loading-message">
                <p>{{ loadingMessage || 'Loading...' }}</p>
            </div>
            <div v-else-if="isEmpty" class="content-footer">
                <p class="empty-message">{{ emptyMessage }}</p>
            </div>
        </div>
    `
};
