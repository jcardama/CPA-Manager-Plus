import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsCoreOption } from 'echarts/core';
import { EChartsView } from '@/components/charts/EChartsView';
import type { HeatmapGrid } from '../usageDashboardModel';
import { formatCompact, formatShare, type UsageFormatters } from '../usageDashboardFormat';
import {
  CHART_MONO,
  TIMELINE_COLORS,
  TOOLTIP_BASE,
  tooltipHead,
  tooltipRow,
} from './timelineChart';
import styles from '../DashboardPage.module.scss';

const RAMP = ['#1B2545', '#2A3B80', '#4460C8', '#6C8CFF', '#A9BBFF', '#E3EAFF'];
const EMPTY = '#121727';
const GROUND = '#0B0E18';
const REPLACE_OPTION = { notMerge: true };

function rampAt(position: number) {
  const scaled = Math.min(0.99999, Math.max(0, position)) * (RAMP.length - 1);
  const index = Math.floor(scaled);
  const from = parseInt(RAMP[index].slice(1), 16);
  const to = parseInt(RAMP[index + 1].slice(1), 16);
  const mix = (shift: number) => {
    const start = (from >> shift) & 255;
    return Math.round(start + (((to >> shift) & 255) - start) * (scaled - index));
  };
  return `#${((1 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).slice(1)}`;
}

// Stop 0 is the empty slot; every used slot starts at stop 1 so "little" never reads as "none".
const STOPS = [EMPTY, ...Array.from({ length: 20 }, (_, index) => rampAt(index / 19))];
const twoDigits = (value: number) => String(value).padStart(2, '0');

interface UsageHeatmapProps {
  grid: HeatmapGrid;
  format: UsageFormatters;
}

export function UsageHeatmap({ grid, format }: UsageHeatmapProps) {
  const { t } = useTranslation();

  const option = useMemo<EChartsCoreOption>(() => {
    const data = grid.rows.flatMap((row, weekday) =>
      row.map((tokens, hour) => [
        hour,
        weekday,
        tokens > 0 ? 0.05 + 0.95 * Math.sqrt(tokens / grid.max) : 0,
        tokens,
      ])
    );
    const hidden = { show: false };
    return {
      animation: false,
      grid: { left: 0, right: 0, top: 22, bottom: 0, outerBoundsMode: 'none' },
      xAxis: {
        type: 'category',
        data: Array.from({ length: 24 }, (_, hour) => twoDigits(hour)),
        position: 'top',
        axisLine: hidden,
        axisTick: hidden,
        splitLine: hidden,
        splitArea: hidden,
        axisLabel: {
          color: TIMELINE_COLORS.muted,
          fontFamily: CHART_MONO,
          fontSize: 10.5,
          margin: 8,
          interval: (hour: number) => hour % 3 === 0,
        },
      },
      yAxis: {
        type: 'category',
        data: format.weekdays,
        inverse: true,
        axisLine: hidden,
        axisTick: hidden,
        axisLabel: hidden,
        splitLine: hidden,
        splitArea: hidden,
      },
      visualMap: {
        show: false,
        type: 'continuous',
        min: 0,
        max: 1,
        dimension: 2,
        inRange: { color: STOPS },
      },
      tooltip: {
        ...TOOLTIP_BASE,
        formatter: (params: { value: [number, number, number, number] }) => {
          const [hour, weekday, , tokens] = params.value;
          return (
            tooltipHead(
              `${format.weekdays[weekday]} ${twoDigits(hour)}:00–${twoDigits((hour + 1) % 24)}:00`
            ) +
            tooltipRow(t('dashboard.tip_tokens'), format.exact(tokens)) +
            tooltipRow(
              t('dashboard.tip_share_of_range'),
              formatShare(grid.total > 0 ? tokens / grid.total : 0)
            )
          );
        },
      },
      series: [
        {
          type: 'heatmap',
          data,
          progressive: 0,
          itemStyle: { borderColor: GROUND, borderWidth: 2, borderRadius: 4 },
          emphasis: { itemStyle: { borderColor: TIMELINE_COLORS.text, borderWidth: 1 } },
        },
      ],
    };
  }, [format, grid, t]);

  return (
    <section className={styles.heat} aria-labelledby="usage-heat-title">
      <div className={styles.heatCaption}>
        <h2 className={styles.sectionTitle} id="usage-heat-title">
          {t('dashboard.heat_title')}
        </h2>
        <span className={styles.hint}>{t('dashboard.heat_hint', { timeZone: format.timeZone })}</span>
        <span className={styles.legend}>
          0
          <i style={{ background: `linear-gradient(90deg,${RAMP.join(',')})` }} />
          <span title={t('dashboard.heat_legend_title', { value: format.exact(grid.max) })}>
            {t('dashboard.heat_legend', { value: formatCompact(grid.max) })}
          </span>
        </span>
      </div>
      <div className={styles.heatBody}>
        <div className={styles.heatDays} aria-hidden="true">
          {format.weekdays.map((weekday) => (
            <span key={weekday}>{weekday}</span>
          ))}
        </div>
        <EChartsView
          className={styles.heatChart}
          option={option}
          setOptionOpts={REPLACE_OPTION}
          ariaLabel={t('dashboard.heat_label')}
        />
      </div>
    </section>
  );
}
