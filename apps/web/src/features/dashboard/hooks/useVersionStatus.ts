import { useEffect, useMemo, useRef, useState } from 'react';
import { versionApi } from '@/services/api';
import { useAuthStore } from '@/stores';
import { compareVersions } from '@/utils/version';
import { readApiLatestVersion, readManagerStableVersion } from '@/features/system/versionChecks';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import { useManagerUpdates } from '@/features/system/ManagerUpdates';
import { buildDashboardVersionReleaseURL } from '@/features/dashboard/versionReleaseLinks';

export interface VersionUpdate {
  version: string;
  /** Empty when the version is not a release tag that can be linked. */
  releaseUrl: string;
  /** The Manager Server can install this one from its own updates page. */
  installable: boolean;
}

export interface VersionStatus {
  managerVersion: string;
  managerReleaseUrl: string;
  coreVersion: string;
  coreReleaseUrl: string;
  managerUpdate: VersionUpdate | null;
  coreUpdate: VersionUpdate | null;
}

/** Installed versions and any newer release; `refreshSignal` re-runs the update checks. */
export function useVersionStatus(refreshSignal: number): VersionStatus {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const coreVersion = useAuthStore((state) => state.serverVersion) || '';
  const appVersion = __APP_VERSION__ || '';
  const updates = useManagerUpdates();
  const managerVersion = updates.status?.current_version || appVersion;
  const featureAvailability = usePanelFeatureAvailability();
  const externalManagerUpdateFallback =
    featureAvailability.panelHostConfirmed &&
    featureAvailability.panelHostMode === 'external_panel' &&
    !featureAvailability.managerServiceAvailable;

  const [externalStableVersion, setExternalStableVersion] = useState<string | null>(null);
  const externalRequestSequenceRef = useRef(0);
  const [latestCoreVersion, setLatestCoreVersion] = useState('');

  useEffect(() => {
    if (!externalManagerUpdateFallback) return;

    const requestId = ++externalRequestSequenceRef.current;
    versionApi
      .checkManagerUpdateIndex()
      .then((data) => {
        const version = readManagerStableVersion(data);
        if (requestId === externalRequestSequenceRef.current) setExternalStableVersion(version);
      })
      .catch(() => {
        // A failed automatic check stays silent and withdraws the notice it can no longer confirm.
        if (requestId === externalRequestSequenceRef.current) setExternalStableVersion(null);
      });

    return () => {
      externalRequestSequenceRef.current += 1;
    };
  }, [externalManagerUpdateFallback, refreshSignal]);

  useEffect(() => {
    let cancelled = false;
    const check =
      connectionStatus === 'connected'
        ? versionApi
            .checkLatest()
            .then(readApiLatestVersion)
            .catch(() => '')
        : Promise.resolve('');
    void check.then((version) => {
      if (!cancelled) setLatestCoreVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, [connectionStatus, refreshSignal]);

  const installableTarget =
    featureAvailability.managerServiceAvailable &&
    updates.available &&
    !updates.error &&
    !updates.status?.last_error &&
    !updates.status?.stale &&
    updates.status?.state === 'update_available'
      ? updates.status.target?.release.version
      : undefined;

  return useMemo(() => {
    const newer = (latest: string | null, current: string, target: 'manager' | 'core') =>
      latest && compareVersions(latest, current) === 1
        ? {
            version: latest,
            releaseUrl: buildDashboardVersionReleaseURL(target, latest),
            installable: false,
          }
        : null;
    return {
      managerVersion,
      managerReleaseUrl: buildDashboardVersionReleaseURL('manager', managerVersion),
      coreVersion,
      coreReleaseUrl: buildDashboardVersionReleaseURL('core', coreVersion),
      managerUpdate: installableTarget
        ? { version: installableTarget, releaseUrl: '', installable: true }
        : externalManagerUpdateFallback
          ? newer(externalStableVersion, appVersion, 'manager')
          : null,
      coreUpdate: newer(latestCoreVersion, coreVersion, 'core'),
    };
  }, [
    appVersion,
    coreVersion,
    externalManagerUpdateFallback,
    externalStableVersion,
    installableTarget,
    latestCoreVersion,
    managerVersion,
  ]);
}
