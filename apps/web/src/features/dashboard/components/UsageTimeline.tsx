import { useEffect, useMemo, useState, type RefObject } from 'react';
import { EChartsView } from '@/components/charts/EChartsView';
import type { UsageBucket, UsageBucketUnit, UsagePeak } from '../usageDashboardModel';
import type { UsageFormatters } from '../usageDashboardFormat';
import {
  FOOTPRINT_SELECTOR,
  buildTimelineChart,
  type MeasuredFootprint,
  type TimelineLayout,
  type TimelineText,
} from './timelineChart';
import styles from '../DashboardPage.module.scss';

interface UsageTimelineProps {
  /** The band the plot fills; its footprint elements set the headroom of the columns under them. */
  bandRef: RefObject<HTMLElement | null>;
  unit: UsageBucketUnit;
  buckets: UsageBucket[];
  reference: UsageBucket[] | null;
  peak: UsagePeak | null;
  format: UsageFormatters;
  text: TimelineText;
  ariaLabel: string;
  /** Shown over the plot when the range holds no usage. */
  emptyLabel: string;
}

const REPLACE_OPTION = { notMerge: true };

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function measureLayout(band: HTMLElement, plot: HTMLElement): TimelineLayout {
  const box = plot.getBoundingClientRect();
  const style = getComputedStyle(plot);
  const footprints: MeasuredFootprint[] = [];
  band.querySelectorAll(FOOTPRINT_SELECTOR).forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.bottom > box.top + 1 && rect.top < box.bottom) {
      footprints.push({
        left: rect.left - box.left,
        right: rect.right - box.left,
        top: rect.top - box.top,
        bottom: rect.bottom - box.top,
      });
    }
  });
  return {
    width: box.width,
    height: box.height,
    compact: style.getPropertyValue('--compact').trim() === '1',
    gutter: parseFloat(style.getPropertyValue('--gut')) || 0,
    horizon: parseFloat(style.getPropertyValue('--hz')) || 0,
    footprints,
  };
}

export function UsageTimeline({
  bandRef,
  unit,
  buckets,
  reference,
  peak,
  format,
  text,
  ariaLabel,
  emptyLabel,
}: UsageTimelineProps) {
  const [plot, setPlot] = useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<TimelineLayout | null>(null);

  // The numbers over the plot change size with the data, the fonts and the width, and each change moves the headroom.
  useEffect(() => {
    const band = bandRef.current;
    if (!band || !plot || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const measure = () => {
      const next = measureLayout(band, plot);
      setLayout((current) =>
        current && JSON.stringify(current) === JSON.stringify(next) ? current : next
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(band);
    band.querySelectorAll(FOOTPRINT_SELECTOR).forEach((element) => observer.observe(element));
    void document.fonts?.ready.then(schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [bandRef, buckets, plot]);

  const hasUsage = buckets.some((bucket) => bucket.totalTokens > 0);
  const chart = useMemo(
    () =>
      layout && layout.width > 0 && layout.height > 0 && buckets.length > 0
        ? buildTimelineChart({
            layout,
            unit,
            buckets,
            reference,
            peak,
            format,
            text,
            animate: !prefersReducedMotion(),
          })
        : null,
    [buckets, format, layout, peak, reference, text, unit]
  );

  const flag = chart?.flag;

  return (
    <div className={styles.timeline} ref={setPlot}>
      {chart ? (
        <EChartsView
          className={styles.timelineChart}
          option={chart.option}
          setOptionOpts={REPLACE_OPTION}
          ariaLabel={ariaLabel}
        />
      ) : null}
      {flag ? (
        <div
          className={`${styles.flag} ${flag.side === 'left' ? styles.flagLeft : ''}`}
          style={{ left: flag.x, top: flag.y, height: flag.barTop - flag.y }}
          aria-hidden="true"
        >
          <i />
          <span>
            {flag.lead} <b>{flag.rate}</b>
            {flag.time ? ` · ${flag.time}` : ''}
          </span>
        </div>
      ) : null}
      {!hasUsage && emptyLabel ? <p className={styles.timelineEmpty}>{emptyLabel}</p> : null}
    </div>
  );
}
