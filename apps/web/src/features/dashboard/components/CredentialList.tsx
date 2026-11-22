import { useTranslation } from 'react-i18next';
import {
  hasQuotaWindows,
  quotaAge,
  type CredentialQuotaWindow,
} from '../credentialQuotaModel';
import type { CredentialQuotaView } from '../hooks/useCredentialQuota';
import { credentialName, type CredentialRow } from '../usageDashboardModel';
import {
  formatCompact,
  formatMoney,
  formatShare,
  type UsageFormatters,
} from '../usageDashboardFormat';
import styles from '../DashboardPage.module.scss';

interface CredentialListProps {
  rows: CredentialRow[];
  selectedId: string | null;
  /** Quota per credential id; a credential without quota windows has no entry or an empty one. */
  quota: ReadonlyMap<string, CredentialQuotaView>;
  nowMs: number;
  format: UsageFormatters;
  /** Selects a credential to filter the page to; the selected one clears the filter. */
  onToggle: (row: CredentialRow) => void;
}

const percent = (window: CredentialQuotaWindow | null) =>
  window ? `${Math.round(window.usedPercent)}%` : '—';

export function CredentialList({
  rows,
  selectedId,
  quota,
  nowMs,
  format,
  onToggle,
}: CredentialListProps) {
  const { t } = useTranslation();

  const ageText = (observedAtMs: number) => {
    const age = quotaAge(observedAtMs, nowMs);
    return t(`dashboard.quota_age_${age.unit}`, { count: age.count });
  };
  const windowLabel = (window: CredentialQuotaWindow) =>
    window.kind === 'scoped_weekly'
      ? t('dashboard.quota_scoped_weekly', { name: window.scope })
      : t(`dashboard.quota_${window.kind}`);

  // The list's age is that of its freshest quota; a credential that fell behind is marked on its own row.
  const freshest = rows.reduce((latest, row) => {
    const view = quota.get(row.id);
    const observedAtMs = view && !view.stale ? view.quota.observedAtMs : null;
    return observedAtMs !== null && observedAtMs > latest ? observedAtMs : latest;
  }, 0);

  return (
    <section aria-labelledby="usage-credentials-title">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle} id="usage-credentials-title">
          {t('dashboard.credentials_title')}
        </h2>
        <span className={styles.hint}>{t('dashboard.credentials_hint')}</span>
        {freshest > 0 ? (
          <span className={`${styles.hint} ${styles.quotaAge}`}>
            {t('dashboard.quota_list_age', { age: ageText(freshest) })}
          </span>
        ) : null}
      </div>
      <div className={styles.credentialsHead} aria-hidden="true">
        <span>{t('dashboard.credential')}</span>
        <span>{t('dashboard.quota_column')}</span>
        <span>{t('dashboard.kpi_in')}</span>
        <span>{t('dashboard.kpi_out')}</span>
        <span>{t('dashboard.cost')}</span>
        <span>{t('dashboard.share')}</span>
        <span />
      </div>
      {rows.length === 0 ? (
        <p className={styles.note}>{t('dashboard.credentials_empty')}</p>
      ) : (
        <ul className={styles.credentials}>
          {rows.map((row) => {
            const selected = row.id === selectedId;
            const label = credentialName(row);
            const view = quota.get(row.id);
            const windows = hasQuotaWindows(view?.quota)
              ? [view.quota.fiveHour, view.quota.weekly, view.quota.extra].filter(
                  (window) => window !== null
                )
              : [];
            const standard = hasQuotaWindows(view?.quota)
              ? [view.quota.fiveHour, view.quota.weekly]
              : [null, null];
            const freshness = [
              view?.stale ? t('dashboard.quota_stale') : '',
              view?.quota.observedAtMs ? ageText(view.quota.observedAtMs) : '',
            ].filter(Boolean);
            return (
              <li
                key={row.id}
                className={`${styles.credentialItem} ${selected ? styles.selected : ''}`}
              >
                <button
                  type="button"
                  className={styles.credential}
                  aria-pressed={selected}
                  title={t(selected ? 'dashboard.filter_clear_title' : 'dashboard.filter_to', {
                    label,
                  })}
                  onClick={() => onToggle(row)}
                >
                  <span className={styles.credentialName}>
                    <span>{row.label}</span>
                    {row.provider ? <span className={styles.provider}>{row.provider}</span> : null}
                  </span>
                  <span className={styles.credentialNumbers}>
                    <span
                      className={view?.stale ? styles.quotaStaleText : undefined}
                      data-label={t('dashboard.quota_column')}
                      title={[t('dashboard.quota_column_title'), ...freshness].join(' · ')}
                    >
                      {standard[0] || standard[1]
                        ? `${percent(standard[0])} · ${percent(standard[1])}`
                        : '—'}
                    </span>
                    <span
                      data-label={t('dashboard.kpi_in')}
                      title={t('dashboard.exact_input', { value: format.exact(row.inputTokens) })}
                    >
                      {formatCompact(row.inputTokens)}
                    </span>
                    <span
                      data-label={t('dashboard.kpi_out')}
                      title={t('dashboard.exact_output', { value: format.exact(row.outputTokens) })}
                    >
                      {formatCompact(row.outputTokens)}
                    </span>
                    <span
                      data-label={t('dashboard.cost')}
                      title={
                        row.cost > 0
                          ? t('dashboard.cost_title', { value: format.exactMoney(row.cost) })
                          : t('dashboard.no_priced_usage')
                      }
                    >
                      {row.cost > 0 ? formatMoney(row.cost) : '–'}
                    </span>
                  </span>
                  <span className={styles.share} title={t('dashboard.credential_share_title')}>
                    {formatShare(row.share)}
                  </span>
                  <svg className={styles.filterIcon} viewBox="0 0 12 12" aria-hidden="true">
                    <path d={selected ? 'M2.5 2.5l7 7M9.5 2.5l-7 7' : 'M1.5 2.5h9L7 6.6v3L5 8.6v-2z'} />
                  </svg>
                </button>
                {windows.length > 0 ? (
                  <div className={`${styles.quotaBars} ${view?.stale ? styles.quotaStale : ''}`}>
                    {windows.map((window) => {
                      const detail = [
                        t('dashboard.quota_used', { value: percent(window) }),
                        window.resetAtMs
                          ? t('dashboard.quota_resets', {
                              time: `${format.weekday(window.resetAtMs)} ${format.dayMonth(window.resetAtMs)} ${format.time(window.resetAtMs)}`,
                            })
                          : '',
                        ...freshness,
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <span
                          key={window.kind}
                          className={`${styles.quotaCell} ${styles[window.level]}`}
                          tabIndex={0}
                          aria-label={`${windowLabel(window)}: ${detail}`}
                        >
                          <span className={styles.quotaLabel}>{windowLabel(window)}</span>
                          <span className={styles.quotaTrack}>
                            <i style={{ width: `${window.usedPercent.toFixed(1)}%` }} />
                          </span>
                          <span className={styles.quotaTip} role="tooltip">
                            {detail}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
