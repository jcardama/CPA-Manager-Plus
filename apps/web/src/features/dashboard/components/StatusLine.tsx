import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores';
import { useVersionStatus, type VersionUpdate } from '../hooks/useVersionStatus';
import styles from '../DashboardPage.module.scss';

interface StatusLineProps {
  refreshSignal: number;
  /** When the data on the page was read; absent until the first load. */
  dataAsOf: string | null;
}

const UpArrow = () => (
  <svg viewBox="0 0 8 8" aria-hidden="true">
    <path d="M4 1 7.4 7H.6z" />
  </svg>
);

const displayVersion = (version: string) => `v${version.trim().replace(/^[vV]+/, '')}`;

export function StatusLine({ refreshSignal, dataAsOf }: StatusLineProps) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const versions = useVersionStatus(refreshSignal);

  const version = (value: string, releaseUrl: string) => {
    const text = value || t('dashboard.version_unknown');
    return releaseUrl ? (
      <a href={releaseUrl} target="_blank" rel="noopener noreferrer">
        <b>{text}</b>
      </a>
    ) : (
      <b>{text}</b>
    );
  };

  const updateNotice = (name: string, update: VersionUpdate | null) => {
    if (!update) return null;
    const label = t('dashboard.status_update_title', {
      name,
      version: displayVersion(update.version),
    });
    const content: ReactNode = (
      <>
        <UpArrow />
        {t('dashboard.status_update')}
        <span className={styles.wideOnly}>
          {t('dashboard.status_update_detail', { name, version: displayVersion(update.version) })}
        </span>
      </>
    );
    if (update.installable) {
      return (
        <Link to="/system/updates" className={styles.update} title={label} aria-label={label}>
          {content}
        </Link>
      );
    }
    return update.releaseUrl ? (
      <a
        href={update.releaseUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.update}
        title={label}
        aria-label={label}
      >
        {content}
      </a>
    ) : (
      <span className={styles.update} title={label}>
        {content}
      </span>
    );
  };

  return (
    <div className={styles.status} role="status" aria-label={t('dashboard.status_label')}>
      <span className={`${styles.connection} ${styles[connectionStatus] ?? ''}`}>
        <i />
        {t(
          connectionStatus === 'connected'
            ? 'common.connected'
            : connectionStatus === 'connecting'
              ? 'common.connecting'
              : 'common.disconnected'
        )}
      </span>
      <span>
        {t('title.abbr')} {version(versions.managerVersion, versions.managerReleaseUrl)}
      </span>
      <span>
        <span className={styles.wideOnly}>{t('dashboard.status_core')}</span>
        <span className={styles.narrowOnly}>{t('dashboard.status_core_short')}</span>{' '}
        {version(versions.coreVersion, versions.coreReleaseUrl)}
      </span>
      {updateNotice(t('title.abbr'), versions.managerUpdate)}
      {updateNotice(t('dashboard.status_core'), versions.coreUpdate)}
      {dataAsOf ? (
        <span className={styles.asOf}>{t('dashboard.status_data_as_of', { time: dataAsOf })}</span>
      ) : null}
    </div>
  );
}
