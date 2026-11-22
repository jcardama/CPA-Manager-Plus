import { describe, expect, it } from 'vitest';
import type {
  MonitoringAnalyticsCredentialStatRow,
  MonitoringAnalyticsModelStat,
  MonitoringAnalyticsTimelinePoint,
} from '@/services/api/usageService';
import {
  FOOTPRINT_GAP,
  averageTpm,
  buildCredentialRows,
  buildHeatmapGrid,
  buildModelRanks,
  buildPreviousWindow,
  buildRangeWindow,
  buildUsageBuckets,
  buildUsageKpis,
  findPeakTpm,
  isCoreDisconnected,
  resolveTimelineScale,
} from './usageDashboardModel';

// Saturday 21 November 2026, 18:19 local time.
const NOW = new Date(2026, 10, 21, 18, 19).getTime();
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();

const point = (
  bucketMs: number,
  input: number,
  output: number,
  extra: Partial<MonitoringAnalyticsTimelinePoint> = {}
): MonitoringAnalyticsTimelinePoint => ({
  bucket_ms: bucketMs,
  label: '',
  calls: 1,
  tokens: input + output,
  success: 1,
  failure: 0,
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
  ...extra,
});

const model = (name: string, tokens: number, cost: number) =>
  ({ model: name, total_tokens: tokens, input_tokens: tokens, output_tokens: 0, calls: 1, cost }) as
    MonitoringAnalyticsModelStat;

describe('range windows', () => {
  it('draws 24 hourly bars that end with the hour still in progress', () => {
    const window = buildRangeWindow('24h', NOW);
    const buckets = buildUsageBuckets([], window, NOW);

    expect(buckets).toHaveLength(24);
    expect(buckets[0].startMs).toBe(at(20, 19));
    expect(buckets[23]).toMatchObject({ startMs: at(21, 18), inProgress: true });
    expect(buckets[22].inProgress).toBe(false);
  });

  it.each([
    ['7d', 7, at(15, 0)],
    ['30d', 30, at(-8, 0)],
  ] as const)('draws one bar per local day on the %s tab, today included', (range, days, first) => {
    const window = buildRangeWindow(range, NOW);
    const buckets = buildUsageBuckets([], window, NOW);

    expect(buckets).toHaveLength(days);
    expect(buckets[0].startMs).toBe(first);
    expect(buckets[days - 1]).toMatchObject({ startMs: at(21, 0), inProgress: true });
  });

  it('compares a range with the equally long stretch right before it', () => {
    const window = buildRangeWindow('24h', NOW);
    const previous = buildPreviousWindow(window);

    expect(previous?.toMs).toBe(window.fromMs);
    expect(previous && previous.toMs - previous.fromMs).toBe(window.toMs - window.fromMs);
  });

  it('has no previous period for all time and starts the bars at the first day with data', () => {
    const window = buildRangeWindow('all', NOW);
    const buckets = buildUsageBuckets([point(at(18, 14), 10, 1)], window, NOW);

    expect(buildPreviousWindow(window)).toBeNull();
    expect(buckets.map((bucket) => bucket.startMs)).toEqual([
      at(18, 0),
      at(19, 0),
      at(20, 0),
      at(21, 0),
    ]);
  });

  it("lines a credential's all-time bars up with the bars of all traffic", () => {
    const window = buildRangeWindow('all', NOW);
    const allTraffic = [point(at(18, 14), 10, 1), point(at(20, 9), 30, 3)];
    const buckets = buildUsageBuckets([point(at(20, 9), 5, 1)], window, NOW, allTraffic);

    expect(buckets.map((bucket) => bucket.inputTokens)).toEqual([0, 0, 5, 0]);
  });
});

describe('usage buckets', () => {
  it('sums hours into their local day and keeps days without usage as empty bars', () => {
    const window = buildRangeWindow('7d', NOW);
    const buckets = buildUsageBuckets(
      [point(at(19, 9), 100, 10), point(at(19, 23), 50, 5), point(at(21, 0), 7, 1)],
      window,
      NOW
    );

    expect(buckets.map((bucket) => bucket.inputTokens)).toEqual([0, 0, 0, 0, 150, 0, 7]);
    expect(buckets[4]).toMatchObject({ outputTokens: 15, totalTokens: 165, calls: 2 });
  });

  it('weights the cache-hit rate of a day by the input of each hour', () => {
    const window = buildRangeWindow('7d', NOW);
    const buckets = buildUsageBuckets(
      [
        point(at(19, 9), 900, 0, { cache_hit_rate: 1 }),
        point(at(19, 10), 100, 0, { cache_hit_rate: 0 }),
      ],
      window,
      NOW
    );

    expect(buckets[4].cacheHitRate).toBeCloseTo(0.9);
    expect(buckets[0].cacheHitRate).toBeNull();
  });

  it('averages the rate over the time that has actually passed', () => {
    const window = buildRangeWindow('24h', NOW);
    const buckets = buildUsageBuckets([point(at(21, 18), 1900, 0)], window, NOW);

    // The current hour is 19 minutes old, and 23 full hours precede it.
    expect(buckets[23].elapsedMinutes).toBe(19);
    expect(averageTpm(buckets)).toBeCloseTo(1900 / (23 * 60 + 19));
  });
});

describe('peak rate', () => {
  it('is the busiest hour over its 60 minutes, pinned to the day bar that holds it', () => {
    const window = buildRangeWindow('7d', NOW);
    // The 19th has the busiest hour; the 20th has more tokens in total.
    const timeline = [
      point(at(19, 9), 6000, 0),
      point(at(20, 9), 4000, 0),
      point(at(20, 10), 4000, 0),
    ];
    const peak = findPeakTpm(timeline, buildUsageBuckets(timeline, window, NOW));

    expect(peak).toEqual({ tpm: 100, hourStartMs: at(19, 9), bucketIndex: 4 });
  });

  it('is absent when the range has no usage', () => {
    const window = buildRangeWindow('24h', NOW);

    expect(findPeakTpm([], buildUsageBuckets([], window, NOW))).toBeNull();
  });
});

describe('connection state', () => {
  it('calls a lost or failed connection disconnected, and a pending one still live', () => {
    expect(
      (['connected', 'connecting', 'disconnected', 'error'] as const).map(isCoreDisconnected)
    ).toEqual([false, false, true, true]);
  });
});

describe('headline numbers', () => {
  const summary = {
    total_tokens: 1200,
    input_tokens: 1000,
    output_tokens: 200,
    cache_hit_rate: 0.9,
    total_cost: 30,
  };

  it('reports each change against the previous period, the cache hit in points', () => {
    const kpis = buildUsageKpis(summary, {
      total_tokens: 1000,
      input_tokens: 800,
      output_tokens: 400,
      cache_hit_rate: 0.85,
      total_cost: 40,
    });

    expect(kpis.change.totalTokens).toBeCloseTo(0.2);
    expect(kpis.change.inputTokens).toBeCloseTo(0.25);
    expect(kpis.change.outputTokens).toBeCloseTo(-0.5);
    expect(kpis.change.cost).toBeCloseTo(-0.25);
    expect(kpis.change.cacheHitPoints).toBeCloseTo(5);
  });

  it('shows no change when there is no previous period or it was empty', () => {
    const empty = { ...summary, total_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost: 0 };

    expect(buildUsageKpis(summary, null).change).toEqual({
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      cost: null,
      cacheHitPoints: null,
    });
    expect(buildUsageKpis(summary, empty).change).toMatchObject({
      totalTokens: null,
      cost: null,
      cacheHitPoints: null,
    });
  });

  it("gives a selected credential's part of all traffic", () => {
    const all = { ...summary, total_tokens: 4800, total_cost: 120 };

    expect(buildUsageKpis(summary, null, all).shareOfAll).toEqual({ tokens: 0.25, cost: 0.25 });
    expect(buildUsageKpis(summary, null).shareOfAll).toBeNull();
  });
});

describe('model ranks', () => {
  const ranks = buildModelRanks([
    model('cheap', 600, 10),
    model('free-a', 300, 0),
    model('dear', 100, 30),
    model('free-b', 500, 0),
  ]);

  it('ranks by tokens with every model counted in the share', () => {
    expect(ranks.byTokens.map((row) => [row.model, row.share])).toEqual([
      ['cheap', 0.4],
      ['free-b', 500 / 1500],
      ['free-a', 0.2],
      ['dear', 100 / 1500],
    ]);
  });

  it('keeps unpriced models out of the cost shares and lists them last without one', () => {
    expect(ranks.byCost.map((row) => [row.model, row.share])).toEqual([
      ['dear', 0.75],
      ['cheap', 0.25],
      ['free-b', null],
      ['free-a', null],
    ]);
    expect(ranks.pricedCount).toBe(2);
  });

  it('totals the tokens the cost excludes', () => {
    expect(ranks.unpriced.map((row) => row.model)).toEqual(['free-b', 'free-a']);
    expect(ranks.unpricedTokens).toBe(800);
  });
});

describe('credential rows', () => {
  it('masks the account, orders by tokens and shares the tokens across credentials', () => {
    const stat = (id: string, account: string, tokens: number) =>
      ({
        id,
        account_snapshot: account,
        auth_provider_snapshot: 'claude',
        total_tokens: tokens,
        input_tokens: tokens,
        output_tokens: 0,
        cost: tokens / 1000,
      }) as MonitoringAnalyticsCredentialStatRow;
    const rows = buildCredentialRows([
      stat('a', 'small@example.com', 250),
      stat('b', 'bigger@example.com', 750),
      stat('idle', 'idle@example.com', 0),
    ]);

    expect(rows.map((row) => [row.id, row.label, row.share])).toEqual([
      ['b', 'big***@example.com', 0.75],
      ['a', 'sma***@example.com', 0.25],
    ]);
  });
});

describe('heatmap grid', () => {
  it("puts the API's Sunday-first weekdays into Monday-first rows", () => {
    const cell = (weekday: number, hour: number, tokens: number) => ({
      weekday,
      hour,
      tokens,
      calls: 1,
      success: 1,
      failure: 0,
      cost: 0,
      failure_rate: 0,
    });
    const grid = buildHeatmapGrid([cell(0, 3, 40), cell(1, 0, 10), cell(6, 23, 50)]);

    expect(grid.rows[6][3]).toBe(40);
    expect(grid.rows[0][0]).toBe(10);
    expect(grid.rows[5][23]).toBe(50);
    expect(grid).toMatchObject({ max: 50, total: 100 });
  });
});

describe('timeline headroom', () => {
  // A plot 300px tall above the horizon, with numbers over its left half down to y=180.
  const plot = { top: 10, horizonY: 310 };
  const numbers = { left: 0, right: 400, bottom: 180 };
  const bar = (left: number, value: number) => ({ left, right: left + 20, value });
  const topOf = (value: number, axisMax: number) =>
    plot.horizonY - (value / axisMax) * (plot.horizonY - plot.top);

  it('stops a bar under the numbers short of them', () => {
    const scale = resolveTimelineScale([bar(100, 500), bar(600, 100)], [numbers], plot);

    expect(topOf(500, scale.axisMax)).toBeCloseTo(numbers.bottom + FOOTPRINT_GAP);
  });

  it('lets bars clear of the numbers use the whole sky', () => {
    const scale = resolveTimelineScale([bar(100, 100), bar(600, 500)], [numbers], plot);

    expect(topOf(500, scale.axisMax)).toBeCloseTo(plot.top);
    expect(topOf(100, scale.axisMax)).toBeGreaterThan(numbers.bottom + FOOTPRINT_GAP);
  });

  it('holds every column to its own limit at once', () => {
    // The free bar alone would fill the sky, but that scale would push the other into the numbers.
    const scale = resolveTimelineScale([bar(100, 400), bar(600, 500)], [numbers], plot);

    expect(topOf(400, scale.axisMax)).toBeCloseTo(numbers.bottom + FOOTPRINT_GAP);
    expect(topOf(500, scale.axisMax)).toBeGreaterThan(plot.top);
  });

  it('counts a bar beside the numbers as under them until it clears their margin', () => {
    const beside = resolveTimelineScale([bar(400 + FOOTPRINT_GAP - 1, 500)], [numbers], plot);
    const clear = resolveTimelineScale([bar(400 + FOOTPRINT_GAP, 500)], [numbers], plot);

    expect(topOf(500, beside.axisMax)).toBeCloseTo(numbers.bottom + FOOTPRINT_GAP);
    expect(topOf(500, clear.axisMax)).toBeCloseTo(plot.top);
  });

  const flag = (left: number, right: number) => ({ left, right, height: 30 });

  it('puts the peak flag on the side that lifts the scale least', () => {
    // The flag rides the 500 bar. To its left it would have to clear the 800 bar; to its right it clears nothing taller.
    const bars = [bar(500, 800), bar(540, 500), bar(580, 100)];
    const scale = resolveTimelineScale(bars, [], plot, [flag(480, 546), flag(534, 700)]);

    expect(scale).toMatchObject({ flagIndex: 1, flagBase: 500 });
    expect(topOf(800, scale.axisMax)).toBeCloseTo(plot.top);
  });

  it('keeps room for the flag above the bars, preferring the first choice when none is better', () => {
    const scale = resolveTimelineScale([bar(540, 500)], [], plot, [flag(534, 700), flag(380, 546)]);

    expect(scale.flagIndex).toBe(0);
    expect(topOf(500, scale.axisMax)).toBeCloseTo(plot.top + 30);
  });

  it('draws nothing against a zero scale when the range is empty', () => {
    expect(resolveTimelineScale([bar(100, 0)], [numbers], plot)).toMatchObject({
      axisMax: 1,
      flagIndex: -1,
    });
  });
});
