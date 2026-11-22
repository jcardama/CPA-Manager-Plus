import type { EChartsCoreOption } from 'echarts/core';
import {
  FOOTPRINT_GAP,
  resolveTimelineScale,
  type PeakFlagOption,
  type PlotFootprint,
  type TimelineBar,
  type UsageBucket,
  type UsageBucketUnit,
  type UsagePeak,
} from '../usageDashboardModel';
import { formatTick, type UsageFormatters } from '../usageDashboardFormat';

export const TIMELINE_COLORS = {
  grid: '#232A3A',
  text: '#E8ECF5',
  muted: '#7F8AA3',
  input: '#6C8CFF',
  output: '#B57BFF',
  reference: '#9AA8D6',
};
export const CHART_MONO = "'DM Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Marks an element drawn over the plot, which the bars beneath it must stay clear of. */
export const FOOTPRINT = { 'data-usage-footprint': '' };
export const FOOTPRINT_SELECTOR = '[data-usage-footprint]';

export const TOOLTIP_BASE = {
  confine: true,
  appendToBody: true,
  className: 'usageDashboardTip',
  transitionDuration: 0,
  backgroundColor: 'rgba(8,10,18,.95)',
  borderColor: '#2B3348',
  borderWidth: 1,
  padding: [10, 12],
  extraCssText: 'border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,.55);z-index:20;',
};

export const tooltipRow = (name: string, value: string, swatch = '') =>
  `<div class="usageDashboardTipRow">${
    swatch ? `<i style="background:${swatch}"></i>` : ''
  }<span>${name}</span><b>${value}</b></div>`;
export const tooltipHead = (text: string) => `<div class="usageDashboardTipHead">${text}</div>`;
const tooltipNote = (text: string) => `<div class="usageDashboardTipNote">${text}</div>`;

/** Everything the plot shares its band with, measured from the plot's own top-left corner. */
export interface MeasuredFootprint extends PlotFootprint {
  top: number;
}

export interface TimelineLayout {
  width: number;
  height: number;
  /** Phone layout: the numbers sit above the plot instead of over it. */
  compact: boolean;
  /** Page gutter, shared by the plot so text and bars start on one line. */
  gutter: number;
  /** Height of the output grid and its axis labels below the horizon. */
  horizon: number;
  footprints: MeasuredFootprint[];
}

export interface TimelineText {
  input: string;
  output: string;
  allCredentials: string;
  cacheHit: string;
  cost: string;
  calls: string;
  averageTpm: string;
  now: string;
  today: string;
  soFarToday: string;
  fillingHour: string;
  fillingDay: string;
  peak: string;
  peakRate: (tpm: number) => string;
  peakTime: (hourStartMs: number) => string;
}

export interface TimelineFlag {
  x: number;
  /** Y of the top of the peak bar, where the stem starts. */
  barTop: number;
  /** Y of the diamond at the top of the stem. */
  y: number;
  side: 'left' | 'right';
  lead: string;
  rate: string;
  /** Left out where the plot has no room for it. */
  time: string;
}

interface TimelineChartInput {
  layout: TimelineLayout;
  unit: UsageBucketUnit;
  buckets: UsageBucket[];
  /** All traffic, drawn as a faint outline on its own scale while a credential is selected. */
  reference: UsageBucket[] | null;
  peak: UsagePeak | null;
  format: UsageFormatters;
  text: TimelineText;
  animate: boolean;
}

const TOP = 10;
const BOTTOM_PAD = 14;
const FLAG_LIFT = 16;
// Stem lift plus the label's own height and a little air above it.
const FLAG_HEIGHT = 30;

const niceStep = (raw: number) => {
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const fraction = raw / power;
  return (fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10) * power;
};

const ticksFor = (max: number, target: number) => {
  if (!(max > 0)) return [];
  const step = niceStep(max / target);
  const ticks: number[] = [];
  for (let value = step; value <= max * 1.0001; value += step) ticks.push(value);
  return ticks;
};

// DM Mono advances 0.6em; glyphs it lacks fall back to roughly square ones.
const labelWidth = (label: string) =>
  Array.from(label).reduce((width, char) => width + (char.charCodeAt(0) < 0x2e80 ? 6.65 : 11), 0);

/** A vertical shade from the bar's free end to the axis, opaque so each series keeps its colour up to the line. */
const shade = (from: string, to: string, fromTop: boolean) => ({
  type: 'linear',
  x: 0,
  y: fromTop ? 0 : 1,
  x2: 0,
  y2: fromTop ? 1 : 0,
  colorStops: [
    { offset: 0, color: from },
    { offset: 1, color: to },
  ],
});

export function bucketLabel(
  bucket: UsageBucket,
  unit: UsageBucketUnit,
  format: UsageFormatters,
  text: Pick<TimelineText, 'soFarToday'>
) {
  const day = `${format.weekday(bucket.startMs)} ${format.dayMonth(bucket.startMs)}`;
  if (unit === 'hour') {
    return `${day} · ${format.time(bucket.startMs)}–${format.time(bucket.endMs)}`;
  }
  return bucket.inProgress ? `${day} · ${text.soFarToday}` : day;
}

function axisLabels(
  buckets: UsageBucket[],
  unit: UsageBucketUnit,
  bandWidth: number,
  compact: boolean,
  format: UsageFormatters,
  text: TimelineText
) {
  const count = buckets.length;
  const show = new Array<boolean>(count).fill(false);
  const labels = new Array<string>(count).fill('');
  buckets.forEach((bucket, index) => {
    const date = new Date(bucket.startMs);
    if (unit === 'hour') {
      show[index] = date.getHours() % (compact ? 6 : 3) === 0;
      labels[index] =
        date.getHours() === 0
          ? `${format.weekday(bucket.startMs)} ${format.dayOfMonth(bucket.startMs)}`
          : format.time(bucket.startMs);
    } else if (count <= 10) {
      show[index] = !compact || index % 2 === 0;
      labels[index] = `${format.weekday(bucket.startMs)} ${format.dayOfMonth(bucket.startMs)}`;
    } else if (count <= 40) {
      show[index] = date.getDay() === 1;
      labels[index] = format.dayMonth(bucket.startMs);
    } else {
      show[index] = date.getDate() === 1 || (!compact && date.getDate() === 15);
      labels[index] = format.dayMonth(bucket.startMs);
    }
  });
  // The last bucket is still filling: name it, and keep its neighbours from crowding the label.
  const last = count - 1;
  const hideBefore = (labelWidth: number) => {
    const from = Math.max(0, last - (Math.ceil(labelWidth / bandWidth) - 1));
    for (let index = from; index < last; index += 1) show[index] = false;
    return from;
  };
  const hiddenFrom = hideBefore(52);
  show[last] = true;
  if (buckets[last].inProgress) {
    const name = unit === 'hour' ? text.now : text.today;
    // A day change the label would cover is named in it, so the new day always shows on the hour axis.
    const dayChange =
      unit === 'hour'
        ? buckets.findIndex(
            (bucket, index) => index >= hiddenFrom && new Date(bucket.startMs).getHours() === 0
          )
        : -1;
    labels[last] = dayChange >= 0 ? `${labels[dayChange]} · ${name}` : name;
    if (dayChange >= 0) hideBefore(84);
  }
  return { show, labels };
}

export function buildTimelineChart({
  layout,
  unit,
  buckets,
  reference,
  peak,
  format,
  text,
  animate,
}: TimelineChartInput): { option: EChartsCoreOption; flag: TimelineFlag | null } {
  const { width, height, compact, footprints } = layout;
  const count = buckets.length;
  const left = layout.gutter;
  const right = compact ? 40 : layout.gutter;
  const labelHeight = compact ? 24 : 26;
  const outputHeight = layout.horizon - BOTTOM_PAD - labelHeight;
  const horizonY = height - layout.horizon;
  const inputHeight = horizonY - TOP;
  const bandWidth = (width - left - right) / count;
  const barWidth = Math.max(2, Math.min(24, bandWidth * (count > 40 ? 0.66 : 0.6)));
  const centre = (index: number) => left + (index + 0.5) * bandWidth;
  const plot = { top: TOP, horizonY };

  const bars: TimelineBar[] = buckets.map((bucket, index) => ({
    left: centre(index) - barWidth / 2,
    right: centre(index) + barWidth / 2,
    value: bucket.inputTokens,
  }));
  const maxInput = Math.max(0, ...buckets.map((bucket) => bucket.inputTokens));
  const maxOutput = Math.max(0, ...buckets.map((bucket) => bucket.outputTokens));

  /* Peak flag: a stem off the bar holding the busiest hour, with the label on whichever side lifts the scale least. */
  const peakBar = peak ? bars[peak.bucketIndex] : null;
  const flagChoices: Array<PeakFlagOption & { time: string; side: 'left' | 'right' }> = [];
  const peakRate = peak ? text.peakRate(peak.tpm) : '';
  if (peak && peakBar && peakBar.value > 0) {
    const x = centre(peak.bucketIndex);
    for (const time of compact ? [''] : [text.peakTime(peak.hourStartMs), '']) {
      const label = `${text.peak} ${peakRate}${time ? ` · ${time}` : ''}`;
      const span = labelWidth(label) + 14;
      const height = FLAG_HEIGHT;
      if (x + 10 + span <= width - 6) {
        flagChoices.push({ time, side: 'right', left: x - 6, right: x + 10 + span, height });
      }
      if (x - 10 - span >= 6) {
        flagChoices.push({ time, side: 'left', left: x - 10 - span, right: x + 6, height });
      }
    }
  }
  const scale = resolveTimelineScale(bars, footprints, plot, flagChoices);
  const inputMax = scale.axisMax;
  const outputMax = maxOutput > 0 ? maxOutput * 1.14 : 1;
  const yOf = (value: number) => horizonY - (value / inputMax) * inputHeight;

  const chosen = flagChoices[scale.flagIndex];
  const flag: TimelineFlag | null =
    chosen && peak && peakBar
      ? {
          x: centre(peak.bucketIndex),
          barTop: yOf(peakBar.value),
          y: yOf(scale.flagBase) - FLAG_LIFT,
          side: chosen.side,
          lead: text.peak,
          rate: peakRate,
          time: chosen.time,
        }
      : null;

  // The outline keeps the headroom rule too, on a scale of its own, then rides the plotted axes.
  const referenceSeries = (() => {
    if (!reference || reference.length !== count) return [];
    const referenceBars = reference.map((bucket, index) => ({
      left: left + index * bandWidth,
      right: left + (index + 1) * bandWidth,
      value: bucket.inputTokens,
    }));
    // The peak flag belongs to the plotted bars, so the outline passes beneath its label as well.
    const above = flag && chosen ? [...footprints, { ...chosen, bottom: flag.y + 7 }] : footprints;
    const inputRatio = inputMax / resolveTimelineScale(referenceBars, above, plot).axisMax;
    const referenceMaxOutput = Math.max(0, ...reference.map((bucket) => bucket.outputTokens));
    const outputRatio = referenceMaxOutput > 0 ? maxOutput / referenceMaxOutput : 0;
    const outline = (axisIndex: number, data: number[]) => ({
      type: 'line',
      step: 'middle',
      xAxisIndex: axisIndex,
      yAxisIndex: axisIndex,
      silent: true,
      animation: false,
      symbol: 'none',
      z: 1,
      lineStyle: { width: 1.5, color: TIMELINE_COLORS.reference, type: [4, 3] },
      areaStyle: { color: 'rgba(154,168,214,.07)', opacity: 1 },
      data,
    });
    return [
      outline(0, reference.map((bucket) => bucket.inputTokens * inputRatio)),
      outline(1, reference.map((bucket) => bucket.outputTokens * outputRatio)),
    ];
  })();

  const inputTicks = ticksFor(maxInput, compact ? 2.4 : 4);
  const outputTicks = ticksFor(maxOutput, compact ? 1.2 : 2);
  const rule = { color: TIMELINE_COLORS.grid, width: 1, type: 'solid' };
  // Input gridlines are drawn as segments that stop short of anything in the sky.
  const inputRules = inputTicks.flatMap((value) => {
    const y = yOf(value);
    let x0 = left;
    let x1 = width - right;
    for (const footprint of footprints) {
      if (y < footprint.top - 10 || y > footprint.bottom + 10) continue;
      if ((footprint.left + footprint.right) / 2 < width / 2) {
        x0 = Math.max(x0, footprint.right + FOOTPRINT_GAP + 8);
      } else {
        x1 = Math.min(x1, footprint.left - FOOTPRINT_GAP - 8);
      }
    }
    if (x1 - x0 <= 48) return [];
    const cutLeft = x0 > left;
    const cutRight = x1 < width - right;
    const feather = Math.min(0.45, 64 / (x1 - x0));
    const clear = 'rgba(35,42,58,0)';
    return [
      [
        {
          x: x0,
          yAxis: value,
          lineStyle:
            cutLeft || cutRight
              ? {
                  color: {
                    type: 'linear',
                    x: 0,
                    y: 0,
                    x2: 1,
                    y2: 0,
                    colorStops: [
                      { offset: 0, color: cutLeft ? clear : TIMELINE_COLORS.grid },
                      { offset: feather, color: TIMELINE_COLORS.grid },
                      { offset: 1 - feather, color: TIMELINE_COLORS.grid },
                      { offset: 1, color: cutRight ? clear : TIMELINE_COLORS.grid },
                    ],
                  },
                }
              : undefined,
        },
        { x: x1, yAxis: value },
      ],
    ];
  });

  const corner = Math.min(4, barWidth / 2);
  const bar = (value: number, bucket: UsageBucket, downward: boolean) => ({
    value,
    itemStyle: {
      opacity: bucket.inProgress ? 0.5 : 1,
      borderRadius: downward ? [0, 0, corner, corner] : [corner, corner, 0, 0],
    },
  });
  const categories = buckets.map((bucket) => String(bucket.startMs));
  const axis = axisLabels(buckets, unit, bandWidth, compact, format, text);
  const axisText = { color: TIMELINE_COLORS.muted, fontFamily: CHART_MONO, fontSize: 10.5 };
  const pointer = {
    type: 'shadow',
    shadowStyle: { color: 'rgba(232,236,245,.07)' },
    label: { show: false },
  };
  const valueAxis = { type: 'value', position: 'right', min: 0, axisLine: { show: false } };
  const categoryAxis = {
    type: 'category',
    data: categories,
    axisTick: { show: false },
    splitLine: { show: false },
    axisPointer: pointer,
  };

  const option: EChartsCoreOption = {
    animation: animate,
    animationDuration: 650,
    animationEasing: 'cubicOut',
    animationDurationUpdate: 420,
    grid: [
      { left, right, top: TOP, height: inputHeight, outerBoundsMode: 'none' },
      { left, right, top: horizonY, height: outputHeight, outerBoundsMode: 'none' },
    ],
    xAxis: [
      { ...categoryAxis, gridIndex: 0, axisLine: { show: false }, axisLabel: { show: false } },
      {
        ...categoryAxis,
        gridIndex: 1,
        position: 'bottom',
        axisLine: { show: false, onZero: false },
        axisLabel: {
          ...axisText,
          margin: 9,
          hideOverlap: false,
          interval: (index: number) => axis.show[index],
          formatter: (_value: string, index: number) =>
            index === count - 1 && buckets[index].inProgress
              ? `{now|${axis.labels[index]}}`
              : axis.labels[index],
          rich: { now: { ...axisText, color: TIMELINE_COLORS.text } },
        },
      },
    ],
    yAxis: [
      {
        ...valueAxis,
        gridIndex: 0,
        max: inputMax,
        splitLine: { show: false },
        axisTick: { show: false, customValues: inputTicks },
        axisLabel: { ...axisText, margin: 8, customValues: inputTicks, formatter: formatTick },
      },
      {
        ...valueAxis,
        gridIndex: 1,
        max: outputMax,
        inverse: true,
        splitLine: { show: true, lineStyle: rule },
        axisTick: { show: false, customValues: outputTicks },
        axisLabel: { ...axisText, margin: 8, customValues: outputTicks, formatter: formatTick },
      },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      formatter: (params: Array<{ dataIndex: number }>) => {
        const index = params[0]?.dataIndex ?? -1;
        const bucket = buckets[index];
        if (!bucket) return '';
        const all = reference?.[index];
        return (
          tooltipHead(bucketLabel(bucket, unit, format, text)) +
          tooltipRow(text.input, format.exact(bucket.inputTokens), TIMELINE_COLORS.input) +
          tooltipRow(text.output, format.exact(bucket.outputTokens), TIMELINE_COLORS.output) +
          (all
            ? tooltipRow(
                text.allCredentials,
                format.exact(all.inputTokens + all.outputTokens),
                TIMELINE_COLORS.reference
              )
            : '') +
          tooltipRow(
            text.cacheHit,
            bucket.cacheHitRate === null ? '–' : `${(bucket.cacheHitRate * 100).toFixed(1)}%`
          ) +
          tooltipRow(text.cost, format.exactMoney(bucket.cost)) +
          tooltipRow(text.calls, format.exact(bucket.calls)) +
          tooltipRow(text.averageTpm, format.exact(bucket.totalTokens / bucket.elapsedMinutes)) +
          (bucket.inProgress
            ? tooltipNote(unit === 'hour' ? text.fillingHour : text.fillingDay)
            : '')
        );
      },
    },
    series: [
      {
        type: 'bar',
        xAxisIndex: 0,
        yAxisIndex: 0,
        barWidth,
        z: 2,
        itemStyle: { color: shade('#7C99FF', '#5E7FEE', true) },
        emphasis: { itemStyle: { color: '#94ACFF' } },
        data: buckets.map((bucket) => bar(bucket.inputTokens, bucket, false)),
        markLine: {
          silent: true,
          animation: false,
          z: 0,
          symbol: 'none',
          label: { show: false },
          lineStyle: rule,
          emphasis: { disabled: true },
          data: inputRules,
        },
      },
      {
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barWidth,
        z: 2,
        itemStyle: { color: shade('#BD88FF', '#A56CF0', false) },
        emphasis: { itemStyle: { color: '#CDA4FF' } },
        data: buckets.map((bucket) => bar(bucket.outputTokens, bucket, true)),
      },
      ...referenceSeries,
    ],
  };

  return { option, flag };
}
