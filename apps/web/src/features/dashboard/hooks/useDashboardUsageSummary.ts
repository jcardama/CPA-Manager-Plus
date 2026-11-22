import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRequestMonitoringAvailability } from '@/hooks/useRequestMonitoringAvailability';
import { dashboardApi, type DashboardSummaryResponse } from '@/services/api/usageService';
import { useAuthStore } from '@/stores';

const REFRESH_INTERVAL_MS = 60_000;

const getTodayStartMs = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.getTime();
};

export interface UseDashboardUsageSummaryReturn {
  loading: boolean;
  error: string;
  summary: DashboardSummaryResponse | null;
  refresh: () => Promise<void>;
}

export function useDashboardUsageSummary(): UseDashboardUsageSummaryReturn {
  const managementKey = useAuthStore((state) => state.managementKey);
  const availability = useRequestMonitoringAvailability();
  const [summary, setSummary] = useState<DashboardSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);

  const enabled = availability.available && Boolean(availability.serviceBase);
  const serviceBase = availability.serviceBase;

  useLayoutEffect(() => {
    requestIdRef.current += 1;
    setSummary(null);
    setError('');
    setLoading(enabled);
    return () => {
      requestIdRef.current += 1;
    };
  }, [enabled, managementKey, serviceBase]);

  const refresh = useCallback(async () => {
    if (!enabled || !serviceBase) {
      setSummary(null);
      setLoading(false);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError('');

    try {
      const response = await dashboardApi.getSummary(serviceBase, managementKey, {
        todayStartMs: getTodayStartMs(),
        nowMs: Date.now(),
      });
      if (requestIdRef.current !== requestId) return;
      setSummary(response);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [enabled, managementKey, serviceBase]);

  useEffect(() => {
    if (availability.checking) {
      return;
    }
    void refresh();
  }, [availability.checking, refresh]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  return useMemo(
    () => ({ loading: availability.checking || loading, error, summary, refresh }),
    [availability.checking, error, loading, refresh, summary]
  );
}
