import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useRequestMonitoringAvailability,
  type RequestMonitoringUnavailableReason,
} from '@/hooks/useRequestMonitoringAvailability';
import {
  dashboardApi,
  type MonitoringAnalyticsRequest,
  type MonitoringAnalyticsResponse,
  type MonitoringAnalyticsSummary,
} from '@/services/api/usageService';
import { useAuthStore } from '@/stores';
import {
  buildPreviousWindow,
  buildRangeWindow,
  type UsageRange,
  type UsageRangeWindow,
} from '../usageDashboardModel';
import { useDashboardUsageSummary } from './useDashboardUsageSummary';

export interface UsageCredentialSelection {
  id: string;
  label: string;
}

/** One scope of the page: all traffic, or one credential. */
export interface UsageScopeData {
  current: MonitoringAnalyticsResponse;
  /** The same scope over the preceding equal window; null when the range has none. */
  previous: MonitoringAnalyticsSummary | null;
}

/** Everything the page shows, loaded for one window so its parts always agree. */
export interface UsageDashboardData {
  range: UsageRange;
  window: UsageRangeWindow;
  nowMs: number;
  all: UsageScopeData;
  credential: (UsageCredentialSelection & UsageScopeData) | null;
}

export interface UseUsageDashboardReturn {
  range: UsageRange;
  credential: UsageCredentialSelection | null;
  /** The last view that loaded in full; it stays on screen while the next one loads. */
  data: UsageDashboardData | null;
  /** Live 30-minute rate of all traffic; a selected credential's rate comes with its own scope. */
  live: { tpm: number; rpm: number } | null;
  loading: boolean;
  error: string;
  /** Request monitoring cannot serve this connection, for the given reason. */
  unavailable: boolean;
  unavailableReason: RequestMonitoringUnavailableReason | '';
  setRange: (range: UsageRange) => void;
  setCredential: (credential: UsageCredentialSelection | null) => void;
  refresh: () => Promise<void>;
}

const getBrowserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;

const selectionKey = (range: UsageRange, credential: UsageCredentialSelection | null) =>
  JSON.stringify([range, credential?.id ?? null]);

export function useUsageDashboard(): UseUsageDashboardReturn {
  const managementKey = useAuthStore((state) => state.managementKey);
  const availability = useRequestMonitoringAvailability();
  const serviceBase = availability.serviceBase;
  const enabled = availability.available && Boolean(serviceBase);
  const liveSummary = useDashboardUsageSummary();
  const refreshLive = liveSummary.refresh;

  const [range, setRange] = useState<UsageRange>('24h');
  const [credential, setCredential] = useState<UsageCredentialSelection | null>(null);
  const [loaded, setLoaded] = useState<UsageDashboardData | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const loadedRef = useRef<UsageDashboardData | null>(null);

  const load = useCallback(
    async (
      nextRange: UsageRange,
      nextCredential: UsageCredentialSelection | null,
      fresh: boolean
    ) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      abortRef.current?.abort();
      abortRef.current = null;

      // A credential is a second scope over the window already loaded, so all traffic is not refetched for it.
      const base = !fresh && loadedRef.current?.range === nextRange ? loadedRef.current : null;
      if (base && (!nextCredential || base.credential?.id === nextCredential.id)) return;

      const controller = new AbortController();
      abortRef.current = controller;
      const nowMs = base?.nowMs ?? Date.now();
      const window = base?.window ?? buildRangeWindow(nextRange, nowMs);
      const previousWindow = buildPreviousWindow(window);
      const timeZone = getBrowserTimeZone();
      const getUsage = (request: MonitoringAnalyticsRequest) =>
        dashboardApi.getUsage(
          serviceBase,
          managementKey,
          { ...request, ...(timeZone ? { time_zone: timeZone } : {}) },
          controller.signal
        );
      const loadScope = async (credentialId: string | null): Promise<UsageScopeData> => {
        const filters = credentialId ? { filters: { credential_ids: [credentialId] } } : {};
        const [current, previous] = await Promise.all([
          getUsage({
            from_ms: window.fromMs,
            to_ms: window.toMs,
            now_ms: nowMs,
            ...filters,
            include: {
              summary: true,
              // Only a credential needs the summary's own rolling 30-minute rate.
              ...(credentialId ? {} : { summary_profile: 'compact' as const }),
              // Hourly on every range: the busiest hour sets the peak rate, and days are summed from hours.
              timeline: true,
              granularity: 'hour',
              heatmap: true,
              model_stats: true,
              credential_stats: !credentialId,
            },
          }),
          previousWindow
            ? getUsage({
                from_ms: previousWindow.fromMs,
                to_ms: previousWindow.toMs,
                ...filters,
                include: { summary: true, summary_profile: 'compact' },
              })
            : null,
        ]);
        return { current, previous: previous?.summary ?? null };
      };

      try {
        const [all, scoped] = await Promise.all([
          base?.all ?? loadScope(null),
          nextCredential ? loadScope(nextCredential.id) : null,
        ]);
        if (requestIdRef.current !== requestId) return;
        const next: UsageDashboardData = {
          range: nextRange,
          window,
          nowMs,
          all,
          credential: nextCredential && scoped ? { ...nextCredential, ...scoped } : null,
        };
        loadedRef.current = next;
        setLoaded(next);
        setFailure(null);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setFailure({
          key: selectionKey(nextRange, nextCredential),
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [managementKey, serviceBase]
  );

  useEffect(() => {
    if (availability.checking || !enabled) return;
    void load(range, credential, false);
  }, [availability.checking, credential, enabled, load, range]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      abortRef.current?.abort();
    },
    []
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setRefreshing(true);
    try {
      await Promise.all([load(range, credential, true), refreshLive()]);
    } finally {
      setRefreshing(false);
    }
  }, [credential, enabled, load, range, refreshLive]);

  // A credential scope that is no longer selected stays loaded for reuse, but out of view.
  const data = useMemo(() => {
    if (!enabled || !loaded) return null;
    return loaded.credential && loaded.credential.id !== credential?.id
      ? { ...loaded, credential: null }
      : loaded;
  }, [credential, enabled, loaded]);

  const failed = failure?.key === selectionKey(range, credential);
  const settled =
    failed ||
    Boolean(
      loaded &&
        loaded.range === range &&
        (!credential || loaded.credential?.id === credential.id)
    );
  const rolling = liveSummary.summary?.rolling_30m;
  const live = useMemo(() => (rolling ? { tpm: rolling.tpm, rpm: rolling.rpm } : null), [rolling]);

  return {
    range,
    credential,
    data,
    live,
    loading: availability.checking || refreshing || (enabled && !settled),
    error: (failed && failure ? failure.message : '') || liveSummary.error,
    unavailable: !availability.checking && !enabled,
    unavailableReason: availability.reason,
    setRange,
    setCredential,
    refresh,
  };
}
