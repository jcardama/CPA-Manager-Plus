import { maskEmailLike } from '@/features/monitoring/model/base';
import type {
  MonitoringAnalyticsCredentialStatRow,
  MonitoringAnalyticsHeatmapPoint,
  MonitoringAnalyticsModelStat,
  MonitoringAnalyticsSummary,
  MonitoringAnalyticsTimelinePoint,
} from '@/services/api/usageService';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// The API needs a lower bound, and walks it hour by hour, so "all" reaches back a bounded ten years.
const ALL_TIME_LOOKBACK_DAYS = 10 * 366;

export const USAGE_RANGES = ['24h', '7d', '30d', 'all'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export type UsageBucketUnit = 'hour' | 'day';

export interface UsageRangeWindow {
  fromMs: number;
  toMs: number;
  unit: UsageBucketUnit;
  /**
   * All time: the bars start at the first day with traffic rather than at
   * `fromMs`, and no earlier period exists to compare against.
   */
  openStart: boolean;
}

const startOfLocalHour = (ms: number) => {
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  return date.getTime();
};

const startOfLocalDay = (ms: number) => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

// Calendar stepping keeps buckets on local midnights across daylight-saving changes.
const addLocalDays = (dayStartMs: number, days: number) => {
  const date = new Date(dayStartMs);
  date.setDate(date.getDate() + days);
  return date.getTime();
};

/**
 * The window ends at `nowMs` and starts on a bucket boundary, so every bar but
 * the last is whole and the previous period covers the same elapsed length.
 */
export function buildRangeWindow(range: UsageRange, nowMs: number): UsageRangeWindow {
  if (range === '24h') {
    return {
      fromMs: startOfLocalHour(nowMs) - 23 * HOUR_MS,
      toMs: nowMs,
      unit: 'hour',
      openStart: false,
    };
  }
  const today = startOfLocalDay(nowMs);
  if (range === 'all') {
    return {
      fromMs: addLocalDays(today, -ALL_TIME_LOOKBACK_DAYS),
      toMs: nowMs,
      unit: 'day',
      openStart: true,
    };
  }
  return {
    fromMs: addLocalDays(today, range === '7d' ? -6 : -29),
    toMs: nowMs,
    unit: 'day',
    openStart: false,
  };
}

/** The equal-length window just before this one, which every delta compares against. */
export function buildPreviousWindow(window: UsageRangeWindow) {
  if (window.openStart) return null;
  return { fromMs: window.fromMs - (window.toMs - window.fromMs), toMs: window.fromMs };
}

export interface UsageBucket {
  startMs: number;
  endMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  calls: number;
  /** Null when the bucket has no input to hit the cache with. */
  cacheHitRate: number | null;
  /** Minutes of the bucket that have already passed, for an average rate. */
  elapsedMinutes: number;
  inProgress: boolean;
}

const pointTotalTokens = (point: MonitoringAnalyticsTimelinePoint) =>
  point.total_tokens ?? point.tokens ?? 0;

const findBucketIndex = (buckets: UsageBucket[], ms: number) => {
  let low = 0;
  let high = buckets.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const bucket = buckets[middle];
    if (ms < bucket.startMs) high = middle - 1;
    else if (ms >= bucket.endMs) low = middle + 1;
    else return middle;
  }
  return -1;
};

/**
 * Turns the API's sparse hourly timeline into the gap-free bars of a window:
 * one per hour, or one per local day summed from its hours. An all-time range
 * opens on the first day of `allTraffic`, so a credential's bars line up with
 * the bars of all traffic.
 */
export function buildUsageBuckets(
  hourlyPoints: MonitoringAnalyticsTimelinePoint[],
  window: UsageRangeWindow,
  nowMs: number,
  allTraffic: MonitoringAnalyticsTimelinePoint[] = hourlyPoints
): UsageBucket[] {
  let cursor = window.fromMs;
  if (window.openStart) {
    const first = allTraffic.reduce((min, point) => Math.min(min, point.bucket_ms), nowMs);
    cursor = Math.max(window.fromMs, startOfLocalDay(first));
  }

  const buckets: UsageBucket[] = [];
  while (cursor <= nowMs) {
    const endMs = window.unit === 'hour' ? cursor + HOUR_MS : addLocalDays(cursor, 1);
    const elapsedMs = Math.min(endMs, nowMs) - Math.max(cursor, window.fromMs);
    buckets.push({
      startMs: cursor,
      endMs,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
      calls: 0,
      cacheHitRate: null,
      elapsedMinutes: Math.max(1, elapsedMs / MINUTE_MS),
      inProgress: nowMs < endMs,
    });
    cursor = endMs;
  }

  const cacheHitTokens = new Array<number>(buckets.length).fill(0);
  for (const point of hourlyPoints) {
    const index = findBucketIndex(buckets, point.bucket_ms);
    if (index < 0) continue;
    const bucket = buckets[index];
    const input = point.input_tokens ?? 0;
    bucket.inputTokens += input;
    bucket.outputTokens += point.output_tokens ?? 0;
    bucket.totalTokens += pointTotalTokens(point);
    bucket.cost += point.cost ?? 0;
    bucket.calls += point.calls;
    cacheHitTokens[index] += (point.cache_hit_rate ?? 0) * input;
  }
  buckets.forEach((bucket, index) => {
    if (bucket.inputTokens > 0) bucket.cacheHitRate = cacheHitTokens[index] / bucket.inputTokens;
  });
  return buckets;
}

export interface UsagePeak {
  /** Tokens per minute across the busiest hour. */
  tpm: number;
  hourStartMs: number;
  /** The bar that contains the busiest hour. */
  bucketIndex: number;
}

/**
 * The API reports no peak rate, so it is the busiest hour of the hourly
 * timeline averaged over its 60 minutes.
 */
export function findPeakTpm(
  hourlyPoints: MonitoringAnalyticsTimelinePoint[],
  buckets: UsageBucket[]
): UsagePeak | null {
  let peak: UsagePeak | null = null;
  for (const point of hourlyPoints) {
    const tpm = pointTotalTokens(point) / 60;
    const bucketIndex = findBucketIndex(buckets, point.bucket_ms);
    if (bucketIndex >= 0 && tpm > (peak?.tpm ?? 0)) {
      peak = { tpm, hourStartMs: point.bucket_ms, bucketIndex };
    }
  }
  return peak;
}

/** Mean tokens per minute over the time the bars have covered so far. */
export function averageTpm(buckets: UsageBucket[]) {
  const minutes = buckets.reduce((sum, bucket) => sum + bucket.elapsedMinutes, 0);
  const tokens = buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
  return minutes > 0 ? tokens / minutes : 0;
}

/** Change against the previous period as a ratio; null when there is nothing to compare with. */
export function changeFromPrevious(current: number, previous: number | null | undefined) {
  if (previous == null || !(previous > 0)) return null;
  return (current - previous) / previous;
}

export interface UsageKpis {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when there was no input to hit the cache with. */
  cacheHitRate: number | null;
  cost: number;
  /** Changes against the previous period; each is null when it cannot be compared. */
  change: {
    totalTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
    /** Percentage points, because the rate is already a percentage. */
    cacheHitPoints: number | null;
  };
  /** A selected credential's part of all traffic; null when the page is unfiltered. */
  shareOfAll: { tokens: number; cost: number } | null;
}

type KpiSummary = Pick<
  MonitoringAnalyticsSummary,
  'total_tokens' | 'input_tokens' | 'output_tokens' | 'cache_hit_rate' | 'total_cost'
>;

const cacheHitRateOf = (summary: KpiSummary | null | undefined) =>
  summary && summary.input_tokens > 0 ? (summary.cache_hit_rate ?? null) : null;

export function buildUsageKpis(
  summary: KpiSummary | null | undefined,
  previous: KpiSummary | null | undefined,
  allTraffic?: KpiSummary | null
): UsageKpis {
  const cacheHitRate = cacheHitRateOf(summary);
  const previousCacheHitRate = cacheHitRateOf(previous);
  const totalTokens = summary?.total_tokens ?? 0;
  const cost = summary?.total_cost ?? 0;
  return {
    totalTokens,
    inputTokens: summary?.input_tokens ?? 0,
    outputTokens: summary?.output_tokens ?? 0,
    cacheHitRate,
    cost,
    change: {
      totalTokens: changeFromPrevious(totalTokens, previous?.total_tokens),
      inputTokens: changeFromPrevious(summary?.input_tokens ?? 0, previous?.input_tokens),
      outputTokens: changeFromPrevious(summary?.output_tokens ?? 0, previous?.output_tokens),
      cost: changeFromPrevious(cost, previous?.total_cost),
      cacheHitPoints:
        cacheHitRate !== null && previousCacheHitRate !== null
          ? (cacheHitRate - previousCacheHitRate) * 100
          : null,
    },
    shareOfAll: allTraffic
      ? {
          tokens: allTraffic.total_tokens > 0 ? totalTokens / allTraffic.total_tokens : 0,
          cost: allTraffic.total_cost > 0 ? cost / allTraffic.total_cost : 0,
        }
      : null,
  };
}

export interface ModelRankRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: number;
  cost: number;
  /** Share of the list's total; null where the list cannot rank the row (an unpriced model by cost). */
  share: number | null;
}

export interface ModelRanks {
  byTokens: ModelRankRow[];
  /** Priced models by cost, then the unpriced ones by tokens. */
  byCost: ModelRankRow[];
  pricedCount: number;
  unpriced: ModelRankRow[];
  unpricedTokens: number;
}

/** CPAMP prices a model at $0 when it has no price entry, so tokens without cost mark it unpriced. */
export function buildModelRanks(stats: MonitoringAnalyticsModelStat[]): ModelRanks {
  const rows = stats
    .map((stat) => ({
      model: stat.model,
      inputTokens: stat.input_tokens,
      outputTokens: stat.output_tokens,
      totalTokens: stat.total_tokens,
      calls: stat.calls,
      cost: stat.cost,
    }))
    .filter((row) => row.totalTokens > 0 || row.cost > 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const byTokensOrder = (a: { totalTokens: number }, b: { totalTokens: number }) =>
    b.totalTokens - a.totalTokens;

  const priced = rows
    .filter((row) => row.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .map((row) => ({ ...row, share: row.cost / totalCost }));
  const unpriced = rows
    .filter((row) => !(row.cost > 0))
    .sort(byTokensOrder)
    .map((row) => ({ ...row, share: null }));

  return {
    byTokens: [...rows]
      .sort(byTokensOrder)
      .map((row) => ({ ...row, share: totalTokens > 0 ? row.totalTokens / totalTokens : 0 })),
    byCost: [...priced, ...unpriced],
    pricedCount: priced.length,
    unpriced,
    unpricedTokens: unpriced.reduce((sum, row) => sum + row.totalTokens, 0),
  };
}

export interface CredentialRow {
  id: string;
  label: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  /** Share of tokens across all credentials. */
  share: number;
}

/** A credential as one line, e.g. "jca***@hey.com · claude". */
export const credentialName = (row: Pick<CredentialRow, 'label' | 'provider'>) =>
  row.provider ? `${row.label} · ${row.provider}` : row.label;

export function buildCredentialRows(stats: MonitoringAnalyticsCredentialStatRow[]): CredentialRow[] {
  const used = stats.filter((stat) => stat.total_tokens > 0 || stat.cost > 0);
  const totalTokens = used.reduce((sum, stat) => sum + stat.total_tokens, 0);
  return used
    .map((stat) => ({
      id: stat.id,
      label: maskEmailLike(
        [
          stat.account_snapshot,
          stat.auth_label_snapshot,
          stat.auth_file_snapshot,
          stat.source,
          stat.auth_index,
        ].find((value) => value?.trim()) ?? stat.id
      ),
      provider: stat.auth_provider_snapshot?.trim() ?? '',
      inputTokens: stat.input_tokens,
      outputTokens: stat.output_tokens,
      totalTokens: stat.total_tokens,
      cost: stat.cost,
      share: totalTokens > 0 ? stat.total_tokens / totalTokens : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export interface HeatmapGrid {
  /** Token totals as [weekday][hour], Monday first. */
  rows: number[][];
  max: number;
  total: number;
}

export function buildHeatmapGrid(points: MonitoringAnalyticsHeatmapPoint[]): HeatmapGrid {
  const rows = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let max = 0;
  let total = 0;
  for (const point of points) {
    // The API numbers weekdays from Sunday = 0.
    const row = rows[(point.weekday + 6) % 7];
    if (!row || point.hour < 0 || point.hour > 23) continue;
    row[point.hour] += point.tokens;
    max = Math.max(max, row[point.hour]);
    total += point.tokens;
  }
  return { rows, max, total };
}

/** A horizontal span of the plot, in pixels from its left edge. */
interface PlotSpan {
  left: number;
  right: number;
}

/** Something drawn over the plot (title, tabs, numbers) that a bar must stay below. */
export interface PlotFootprint extends PlotSpan {
  bottom: number;
}

export interface TimelineBar extends PlotSpan {
  value: number;
}

export interface TimelinePlot {
  /** Y of the highest pixel a bar may reach when nothing is above it. */
  top: number;
  /** Y of the baseline the input bars rise from. */
  horizonY: number;
}

export interface PeakFlagOption extends PlotSpan {
  /** Vertical room the flag needs above the bars beneath it. */
  height: number;
}

/** Clear space kept around a footprint, on every side. */
export const FOOTPRINT_GAP = 12;
// Keeps the scale finite in a band too short to clear a footprint; the layout never gets that tight.
const MIN_COLUMN_HEIGHT = 24;

const overlaps = (a: PlotSpan, b: PlotSpan, gap = 0) =>
  a.right > b.left - gap && a.left < b.right + gap;

const ceilingOver = (span: PlotSpan, footprints: PlotFootprint[], top: number) =>
  footprints.reduce(
    (ceiling, footprint) =>
      overlaps(span, footprint, FOOTPRINT_GAP)
        ? Math.max(ceiling, footprint.bottom + FOOTPRINT_GAP)
        : ceiling,
    top
  );

const tallestUnder = (span: PlotSpan, bars: TimelineBar[]) =>
  bars.reduce((tallest, bar) => (overlaps(span, bar) ? Math.max(tallest, bar.value) : tallest), 0);

export interface TimelineScale {
  /** Value at `plot.top`; bars are drawn against it. */
  axisMax: number;
  /** Index into the flag options, or -1 when no flag fits. */
  flagIndex: number;
  /** Value whose height the flag's stem must clear. */
  flagBase: number;
}

/**
 * Headroom rule: a bar may rise only to the lowest footprint above its own
 * column, so the scale is the tightest of those per-column limits. Bars clear
 * of the numbers use the whole sky; bars under them stop short. The peak flag
 * takes the first option that lifts the scale least and clears the footprints too.
 */
export function resolveTimelineScale(
  bars: TimelineBar[],
  footprints: PlotFootprint[],
  plot: TimelinePlot,
  flagOptions: PeakFlagOption[] = []
): TimelineScale {
  const room = (ceiling: number) => Math.max(MIN_COLUMN_HEIGHT, plot.horizonY - ceiling);
  // Value per pixel the scale must allow.
  let need = 0;
  for (const bar of bars) {
    need = Math.max(need, bar.value / room(ceilingOver(bar, footprints, plot.top)));
  }

  let flagIndex = -1;
  let flagBase = 0;
  let needWithFlag = Infinity;
  flagOptions.forEach((option, index) => {
    const base = tallestUnder(option, bars);
    const optionNeed = Math.max(
      need,
      base / room(ceilingOver(option, footprints, plot.top) + option.height)
    );
    // Earlier options are preferred, so a later one must lift the scale strictly less.
    if (optionNeed < needWithFlag) {
      flagIndex = index;
      flagBase = base;
      needWithFlag = optionNeed;
    }
  });
  if (flagIndex >= 0) need = needWithFlag;

  return {
    axisMax: need > 0 ? need * (plot.horizonY - plot.top) : 1,
    flagIndex,
    flagBase,
  };
}
