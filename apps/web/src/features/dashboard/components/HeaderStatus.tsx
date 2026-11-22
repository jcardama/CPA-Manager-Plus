import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeaderSlot } from '@/components/layout/HeaderSlot';
import { useVersionStatus, type VersionUpdate } from '../hooks/useVersionStatus';
import styles from '../DashboardPage.module.scss';

interface HeaderStatusProps {
  refreshSignal: number;
  /** The panel has lost the CPA core. */
  disconnected: boolean;
  /** When the data on the page was read; absent until the first load. */
  dataAsOf: string | null;
}

const UpArrow = () => (
  <svg viewBox="0 0 8 8" aria-hidden="true">
    <path d="M4 1 7.4 7H.6z" />
  </svg>
);

const displayVersion = (version: string) => `v${version.trim().replace(/^[vV]+/, '')}`;

/** The dashboard's status, shown in the shell header: versions, update notices and the data's age. */
export function HeaderStatus({ refreshSignal, disconnected, dataAsOf }: HeaderStatusProps) {
  const { t } = useTranslation();
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
        <span className={styles.chipText}>
          {t('dashboard.status_update')}
          <span className={styles.headerDetail}>
            {t('dashboard.status_update_detail', { name, version: displayVersion(update.version) })}
          </span>
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
    <>
      <HeaderSlot name="start">
        <div className={styles.headerStatus} role="status" aria-label={t('dashboard.status_label')}>
          {disconnected ? (
            <span className={styles.disconnected} title={t('common.disconnected')}>
              <span className={styles.chipText}>{t('common.disconnected')}</span>
            </span>
          ) : null}
          <span className={styles.headerVersion}>
            {t('title.abbr')} {version(versions.managerVersion, versions.managerReleaseUrl)}
          </span>
          <span className={styles.headerVersion}>
            {t('dashboard.status_core')} {version(versions.coreVersion, versions.coreReleaseUrl)}
          </span>
          {updateNotice(t('title.abbr'), versions.managerUpdate)}
          {updateNotice(t('dashboard.status_core'), versions.coreUpdate)}
        </div>
      </HeaderSlot>
      {dataAsOf ? (
        <HeaderSlot name="end">
          <span className={`${styles.headerStatus} ${styles.headerAsOf} ${styles.headerDetail}`}>
            {t('dashboard.status_data_as_of', { time: dataAsOf })}
          </span>
        </HeaderSlot>
      ) : null}
    </>
  );
}
