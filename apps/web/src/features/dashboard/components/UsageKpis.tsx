import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelRanks, UsageKpis as Kpis, UsagePeak } from '../usageDashboardModel';
import {
  compactParts,
  formatChange,
  formatCompact,
  formatShare,
  moneyParts,
  type UsageFormatters,
} from '../usageDashboardFormat';
import { FOOTPRINT } from './timelineChart';
import styles from '../DashboardPage.module.scss';

interface UsageKpisProps {
  /** Null until the range has loaded. */
  kpis: Kpis | null;
  models: ModelRanks | null;
  live: { tpm: number; rpm: number } | null;
  peak: UsagePeak | null;
  averageTpm: number;
  format: UsageFormatters;
  /** How a moment inside this range reads, e.g. "Sat 17:00". */
  formatMoment: (ms: number) => string;
}

const Arrow = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 8 8" aria-hidden="true">
    <path d={up ? 'M4 1 7.4 7H.6z' : 'M4 7 .6 1h6.8z'} />
  </svg>
);

function BigNumber({ parts, money, title }: { parts: [string, string] | null; money?: boolean; title?: string }) {
  return (
    <span className={styles.number} title={title}>
      {money ? <span className={styles.currency}>$</span> : null}
      {parts ? parts[0] : '–'}
      {parts?.[1] ? <span className={styles.unit}>{parts[1]}</span> : null}
    </span>
  );
}

function Change({ ratio, title, small }: { ratio: number | null; title?: string; small?: boolean }) {
  if (ratio === null) return null;
  return (
    <span className={small ? styles.smallDelta : styles.delta} title={title}>
      <Arrow up={ratio >= 0} />
      {formatChange(ratio)}
    </span>
  );
}

export function UsageKpis({
  kpis,
  models,
  live,
  peak,
  averageTpm,
  format,
  formatMoment,
}: UsageKpisProps) {
  const { t } = useTranslation();
  const [unpricedOpen, setUnpricedOpen] = useState(false);
  const unpricedRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!unpricedOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!unpricedRef.current?.contains(event.target as Node)) setUnpricedOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setUnpricedOpen(false);
    };
    document.addEventListener('click', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('click', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [unpricedOpen]);

  const versus = t('dashboard.delta_title');
  const share = kpis?.shareOfAll ?? null;
  const unpriced = models?.unpriced ?? [];
  const peakTitle = peak
    ? t('dashboard.peak_title', {
        value: format.exact(peak.tpm),
        time: `${format.weekday(peak.hourStartMs)} ${format.dayMonth(peak.hourStartMs)} ${format.time(peak.hourStartMs)}`,
      })
    : undefined;

  return (
    <div className={styles.kpis} {...FOOTPRINT}>
      <section className={`${styles.kpi} ${styles.hero}`} aria-label={t('dashboard.kpi_tokens')}>
        <h2 className={styles.kpiLabel}>{t('dashboard.kpi_tokens')}</h2>
        <div className={styles.kpiValue}>
          <BigNumber
            parts={kpis ? compactParts(kpis.totalTokens) : null}
            title={kpis ? t('dashboard.exact_tokens', { value: format.exact(kpis.totalTokens) }) : undefined}
          />
          <Change ratio={kpis?.change.totalTokens ?? null} title={versus} />
        </div>
        <div className={styles.kpiLine}>
          <span
            className={styles.pair}
            title={kpis ? t('dashboard.exact_input', { value: format.exact(kpis.inputTokens) }) : undefined}
          >
            <i className={`${styles.swatch} ${styles.swatchIn}`} />
            {t('dashboard.kpi_in')}
            <b>{kpis ? formatCompact(kpis.inputTokens) : '–'}</b>
            <Change ratio={kpis?.change.inputTokens ?? null} title={versus} small />
          </span>
          <span
            className={styles.pair}
            title={kpis ? t('dashboard.exact_output', { value: format.exact(kpis.outputTokens) }) : undefined}
          >
            <i className={`${styles.swatch} ${styles.swatchOut}`} />
            {t('dashboard.kpi_out')}
            <b>{kpis ? formatCompact(kpis.outputTokens) : '–'}</b>
            <Change ratio={kpis?.change.outputTokens ?? null} title={versus} small />
          </span>
        </div>
        <div className={styles.kpiLine}>
          <span className={styles.pair} title={t('dashboard.kpi_cache_hit_title')}>
            {t('dashboard.kpi_cache_hit')}
            <b>{kpis?.cacheHitRate == null ? '–' : `${(kpis.cacheHitRate * 100).toFixed(1)}%`}</b>
            {kpis?.change.cacheHitPoints == null ? null : (
              <span className={styles.smallDelta} title={versus}>
                <Arrow up={kpis.change.cacheHitPoints >= 0} />
                {t('dashboard.points', { value: Math.abs(kpis.change.cacheHitPoints).toFixed(1) })}
              </span>
            )}
          </span>
          {share ? (
            <span title={t('dashboard.share_of_all_tokens_title')}>
              {t('dashboard.share_of_all', { value: formatShare(share.tokens) })}
            </span>
          ) : null}
        </div>
      </section>

      <section className={styles.kpi} aria-label={t('dashboard.kpi_cost')}>
        <h2 className={styles.kpiLabel}>{t('dashboard.kpi_cost')}</h2>
        <div className={styles.kpiValue}>
          <BigNumber
            money
            parts={kpis ? moneyParts(kpis.cost) : null}
            title={kpis ? t('dashboard.cost_title', { value: format.exactMoney(kpis.cost) }) : undefined}
          />
          <Change ratio={kpis?.change.cost ?? null} title={versus} />
        </div>
        <div className={styles.kpiLine}>
          {share ? (
            <span title={t('dashboard.share_of_all_cost_title')}>
              {t('dashboard.share_of_all', { value: formatShare(share.cost) })}
            </span>
          ) : (
            t('dashboard.cost_basis')
          )}
        </div>
        <div className={styles.kpiLine}>
          {!models ? null : unpriced.length === 0 ? (
            t('dashboard.all_priced')
          ) : (
            <span className={styles.unpriced} ref={unpricedRef}>
              <button
                type="button"
                className={styles.unpricedToggle}
                aria-expanded={unpricedOpen}
                aria-controls="usage-unpriced-models"
                onClick={() => setUnpricedOpen((open) => !open)}
              >
                {t('dashboard.unpriced_note', { value: formatCompact(models.unpricedTokens) })}
              </button>
              <div
                className={`${styles.popover} ${unpricedOpen ? styles.popoverOpen : ''}`}
                id="usage-unpriced-models"
                role="tooltip"
              >
                <div className={styles.popoverBody}>
                  <h3>{t('dashboard.unpriced_models', { count: unpriced.length })}</h3>
                  <p>
                    {t('dashboard.unpriced_body', { value: format.exact(models.unpricedTokens) })}
                  </p>
                  <ul>
                    {unpriced.map((row) => (
                      <li key={row.model} title={row.model}>
                        <span>{row.model}</span>
                        <span title={t('dashboard.exact_tokens', { value: format.exact(row.totalTokens) })}>
                          {formatCompact(row.totalTokens)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </span>
          )}
        </div>
      </section>

      <section className={styles.kpi} aria-label={t('dashboard.kpi_tpm_label')}>
        <h2 className={styles.kpiLabel}>
          {t('dashboard.kpi_tpm')}
          <i className={styles.pulse} aria-hidden="true" />
        </h2>
        <div className={styles.kpiValue}>
          <BigNumber
            parts={live ? compactParts(live.tpm) : null}
            title={live ? t('dashboard.tpm_title', { value: format.exact(live.tpm) }) : undefined}
          />
          {peak ? (
            <span className={styles.delta} title={peakTitle}>
              <i className={styles.diamond} />
              <span className={styles.wideOnly}>{t('dashboard.peak')} </span>
              {formatCompact(peak.tpm)}
            </span>
          ) : null}
        </div>
        <div className={styles.kpiLine}>
          <span>
            {t('dashboard.tpm_window')}
            {live ? (
              <span className={styles.wideOnly}>
                {' · '}
                {t('dashboard.tpm_requests', { value: live.rpm.toFixed(1) })}
              </span>
            ) : null}
          </span>
        </div>
        <div className={`${styles.kpiLine} ${styles.tight}`}>
          {peak ? (
            <span title={peakTitle}>
              {t('dashboard.peak_at', { time: formatMoment(peak.hourStartMs) })}
            </span>
          ) : null}
          {live && averageTpm > 0 ? (
            <span title={t('dashboard.tpm_vs_average_title', { value: format.exact(averageTpm) })}>
              <span className={styles.wideOnly}>· </span>
              {t('dashboard.tpm_vs_average', { value: (live.tpm / averageTpm).toFixed(1) })}
            </span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
