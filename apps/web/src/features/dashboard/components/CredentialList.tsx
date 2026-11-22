import { useTranslation } from 'react-i18next';
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
  format: UsageFormatters;
  /** Selects a credential to filter the page to; the selected one clears the filter. */
  onToggle: (row: CredentialRow) => void;
}

export function CredentialList({ rows, selectedId, format, onToggle }: CredentialListProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="usage-credentials-title">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle} id="usage-credentials-title">
          {t('dashboard.credentials_title')}
        </h2>
        <span className={styles.hint}>{t('dashboard.credentials_hint')}</span>
      </div>
      <div className={styles.credentialsHead} aria-hidden="true">
        <span>{t('dashboard.credential')}</span>
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
            return (
              <li key={row.id}>
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
                  <span className={styles.bar}>
                    <i style={{ width: `${(row.share * 100).toFixed(2)}%` }} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
