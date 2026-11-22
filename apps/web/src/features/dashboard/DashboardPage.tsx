import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import { CredentialList } from './components/CredentialList';
import { ModelRankLists } from './components/ModelRankLists';
import { StatusLine } from './components/StatusLine';
import { UsageHeatmap } from './components/UsageHeatmap';
import { UsageKpis } from './components/UsageKpis';
import { UsageTimeline } from './components/UsageTimeline';
import { FOOTPRINT, type TimelineText } from './components/timelineChart';
import { useCredentialQuota } from './hooks/useCredentialQuota';
import { useUsageDashboard, type UsageDashboardData } from './hooks/useUsageDashboard';
import {
  USAGE_RANGES,
  averageTpm,
  buildCredentialRows,
  buildHeatmapGrid,
  buildModelRanks,
  buildUsageBuckets,
  buildUsageKpis,
  credentialName,
  findPeakTpm,
  type CredentialRow,
  type UsageRange,
} from './usageDashboardModel';
import { createUsageFormatters, formatCompact } from './usageDashboardFormat';
import styles from './DashboardPage.module.scss';

const NO_BUCKETS: never[] = [];
const NO_CREDENTIALS: never[] = [];

export function DashboardPage() {
  const connectionScope = useAuthStore((state) =>
    JSON.stringify([state.apiBase, state.managementKey])
  );
  const { managerServiceBase } = usePanelFeatureAvailability();

  // A new connection starts from a clean page instead of showing the previous one's numbers.
  return <DashboardPageContent key={`${connectionScope}:${managerServiceBase}`} />;
}

function buildView(data: UsageDashboardData) {
  const scope = data.credential ?? data.all;
  const timeline = scope.current.timeline ?? [];
  const allTimeline = data.all.current.timeline ?? [];
  const buckets = buildUsageBuckets(timeline, data.window, data.nowMs, allTimeline);
  return {
    range: data.range,
    window: data.window,
    nowMs: data.nowMs,
    filtered: Boolean(data.credential),
    buckets,
    // All traffic stays behind a credential's bars as a reference.
    reference: data.credential ? buildUsageBuckets(allTimeline, data.window, data.nowMs) : null,
    peak: findPeakTpm(timeline, buckets),
    averageTpm: averageTpm(buckets),
    kpis: buildUsageKpis(
      scope.current.summary,
      scope.previous,
      data.credential ? data.all.current.summary : null
    ),
    models: buildModelRanks(scope.current.model_stats ?? []),
    heatmap: buildHeatmapGrid(scope.current.heatmap ?? []),
    credentials: buildCredentialRows(data.all.current.credential_stats ?? []),
    scopedLive: data.credential?.current.summary
      ? {
          tpm: data.credential.current.summary.tpm_30m,
          rpm: data.credential.current.summary.rpm_30m,
        }
      : null,
  };
}

function DashboardPageContent() {
  const { t, i18n } = useTranslation();
  const usage = useUsageDashboard();
  const { data, range, credential, setRange, setCredential } = usage;
  const refreshUsage = usage.refresh;
  const [refreshSignal, setRefreshSignal] = useState(0);
  const bandRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Partial<Record<UsageRange, HTMLButtonElement | null>>>({});

  const refresh = useCallback(async () => {
    setRefreshSignal((value) => value + 1);
    await refreshUsage();
  }, [refreshUsage]);
  useHeaderRefresh(refresh);

  const format = useMemo(() => createUsageFormatters(i18n.language), [i18n.language]);
  const view = useMemo(() => (data ? buildView(data) : null), [data]);
  const quota = useCredentialQuota(view?.credentials ?? NO_CREDENTIALS);

  const timelineText = useMemo<TimelineText>(
    () => ({
      input: t('dashboard.tip_input'),
      output: t('dashboard.tip_output'),
      allCredentials: t('dashboard.tip_all_credentials'),
      cacheHit: t('dashboard.kpi_cache_hit'),
      cost: t('dashboard.cost'),
      calls: t('dashboard.tip_calls'),
      averageTpm: t('dashboard.tip_average_tpm'),
      now: t('dashboard.axis_now'),
      today: t('dashboard.axis_today'),
      soFarToday: t('dashboard.bucket_so_far_today'),
      fillingHour: t('dashboard.tip_filling_hour'),
      fillingDay: t('dashboard.tip_filling_day'),
      peak: t('dashboard.peak_flag'),
      peakRate: (tpm) => t('dashboard.peak_flag_rate', { value: formatCompact(tpm) }),
      peakTime: (ms) =>
        `${view?.range === '24h' ? format.weekday(ms) : format.dayMonth(ms)} ${format.time(ms)}`,
    }),
    [format, t, view?.range]
  );

  const scopeText = (() => {
    if (!view) return '';
    const { window, nowMs } = view;
    const name = t(`dashboard.range_name_${view.range}`);
    if (view.range === '24h') {
      return `${name} · ${format.weekday(window.fromMs)} ${format.time(window.fromMs)} → ${format.weekday(nowMs)} ${format.time(nowMs)} ${format.timeZone}`;
    }
    if (view.range === 'all') {
      const first = view.buckets[0];
      return first
        ? `${name} · ${t('dashboard.scope_since', { date: format.dayMonth(first.startMs), count: view.buckets.length })} · ${format.timeZone}`
        : name;
    }
    return `${name} · ${format.dayMonth(window.fromMs)} → ${format.dayMonth(nowMs)} · ${format.timeZone}`;
  })();

  const toggleCredential = useCallback(
    (row: CredentialRow) => {
      setCredential(
        credential?.id === row.id ? null : { id: row.id, label: credentialName(row) }
      );
    },
    [credential, setCredential]
  );

  const moveRange = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = USAGE_RANGES.length - 1;
    const target =
      event.key === 'ArrowRight'
        ? (index + 1) % USAGE_RANGES.length
        : event.key === 'ArrowLeft'
          ? (index + last) % USAGE_RANGES.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    if (target < 0) return;
    event.preventDefault();
    setRange(USAGE_RANGES[target]);
    tabRefs.current[USAGE_RANGES[target]]?.focus();
  };

  const dataAsOf = view
    ? `${format.weekday(view.nowMs)} ${format.dayMonth(view.nowMs)} ${format.time(view.nowMs)}`
    : null;
  const filtered = Boolean(view?.filtered);
  const live = view?.filtered ? view.scopedLive : usage.live;

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <StatusLine refreshSignal={refreshSignal} dataAsOf={dataAsOf} />

        <section
          className={`${styles.band} ${filtered ? styles.filtered : ''} ${usage.loading ? styles.loading : ''}`}
          ref={bandRef}
          aria-label={t('dashboard.timeline_label')}
          aria-busy={usage.loading}
        >
          <div className={styles.sky}>
            <div className={styles.head}>
              <h1 {...FOOTPRINT}>{t('dashboard.usage_title')}</h1>
              <p className={styles.scope} {...FOOTPRINT}>
                {scopeText}
              </p>
              {credential ? (
                <div className={styles.chip} {...FOOTPRINT}>
                  <span>{t('dashboard.filter_chip')}</span>
                  <b title={credential.label}>{credential.label}</b>
                  <button
                    type="button"
                    aria-label={t('dashboard.filter_clear')}
                    title={t('dashboard.filter_clear')}
                    onClick={() => setCredential(null)}
                  >
                    <svg viewBox="0 0 8 8" aria-hidden="true">
                      <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" />
                    </svg>
                  </button>
                </div>
              ) : null}
              {usage.unavailable ? null : (
                <div
                  className={styles.tabs}
                  role="tablist"
                  aria-label={t('dashboard.range_label')}
                  {...FOOTPRINT}
                >
                  {USAGE_RANGES.map((item, index) => (
                    <button
                      key={item}
                      type="button"
                      role="tab"
                      aria-selected={item === range}
                      tabIndex={item === range ? 0 : -1}
                      ref={(element) => {
                        tabRefs.current[item] = element;
                      }}
                      onClick={() => setRange(item)}
                      onKeyDown={(event) => moveRange(event, index)}
                    >
                      {t(`dashboard.range_${item}`)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {usage.error ? (
              <p className={styles.alert} role="alert" {...FOOTPRINT}>
                {usage.error}
              </p>
            ) : null}
            {usage.unavailable ? (
              <div className={styles.unavailable}>
                <strong>
                  {t(
                    usage.unavailableReason === 'monitoring_disabled'
                      ? 'monitoring.request_monitoring_disabled_title'
                      : 'monitoring.request_monitoring_unavailable_title'
                  )}
                </strong>
                <span>
                  {t(
                    usage.unavailableReason === 'monitoring_disabled'
                      ? 'monitoring.request_monitoring_disabled_body'
                      : usage.unavailableReason === 'service_unavailable'
                        ? 'monitoring.request_monitoring_service_unavailable_body'
                        : 'monitoring.request_monitoring_not_configured_body'
                  )}
                </span>
              </div>
            ) : (
              <UsageKpis
                kpis={view?.kpis ?? null}
                models={view?.models ?? null}
                live={live}
                peak={view?.peak ?? null}
                averageTpm={view?.averageTpm ?? 0}
                format={format}
                formatMoment={timelineText.peakTime}
              />
            )}
          </div>
          {usage.unavailable ? null : (
            <>
              <UsageTimeline
                bandRef={bandRef}
                unit={view?.window.unit ?? 'hour'}
                buckets={view?.buckets ?? NO_BUCKETS}
                reference={view?.reference ?? null}
                peak={view?.peak ?? null}
                format={format}
                text={timelineText}
                ariaLabel={t(
                  view?.window.unit === 'day'
                    ? 'dashboard.timeline_chart_day'
                    : 'dashboard.timeline_chart_hour'
                )}
                emptyLabel={view ? t('dashboard.no_usage') : ''}
              />
              <div className={styles.horizon} aria-hidden="true" />
              <span className={`${styles.cap} ${styles.capIn}`} aria-hidden="true">
                <i />
                {t('dashboard.series_in')}
              </span>
              <span className={`${styles.cap} ${styles.capOut}`} aria-hidden="true">
                <i />
                {t('dashboard.series_out')}
              </span>
              {filtered ? (
                <span className={`${styles.cap} ${styles.capReference}`}>
                  <i />
                  {t('dashboard.series_reference')}
                </span>
              ) : null}
            </>
          )}
        </section>

        {view ? (
          <>
            <UsageHeatmap grid={view.heatmap} format={format} />
            <div className={styles.below}>
              <ModelRankLists key={view.range} ranks={view.models} format={format} />
              <CredentialList
                rows={view.credentials}
                selectedId={credential?.id ?? null}
                quota={quota.byCredentialId}
                nowMs={quota.nowMs}
                format={format}
                onToggle={toggleCredential}
              />
            </div>
            <p className={styles.foot}>
              {t('dashboard.footnote', { timeZone: format.timeZone })}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
