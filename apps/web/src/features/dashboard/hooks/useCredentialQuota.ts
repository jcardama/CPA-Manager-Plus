import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_SUMMARY_CONFIG,
  DEVIN_CONFIG,
  KIMI_CONFIG,
  META_CONFIG,
  XAI_CONFIG,
  refreshQuotaWithConfig,
  type QuotaConfig,
  type QuotaSetter,
} from '@/components/quota';
import { getScopedQuotaState } from '@/components/quota/quotaConfigs';
import { buildAccountQuotaDisplayWindows } from '@/features/accounts/model/accountQuotaDisplayWindows';
import {
  buildAccountQuotaSnapshotQueryAccounts,
  mergeAccountQuotaSnapshotWindows,
} from '@/features/accounts/model/accountQuotaSnapshots';
import type { AccountQuotaStores } from '@/features/accounts/model/accountQuotaSummary';
import { buildAccountQuotaWindowDefinitions } from '@/features/accounts/model/accountQuotaWindowDefinitions';
import { buildAccountRows, type AccountRow } from '@/features/accounts/model/accountRows';
import { isQuotaRefreshSupportedProvider } from '@/features/authFiles/constants';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import { authFilesApi } from '@/services/api';
import {
  accountQuotaSnapshotApi,
  type AccountQuotaSnapshotWindow,
} from '@/services/api/usageService';
import { useAuthStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { getCredentialScopedQuotaState, getQuotaCredentialStoreKey } from '@/utils/quota/credentialScope';
import {
  buildProviderCredentialTaskPlan,
  createKeyedSerialTaskQueue,
  runProviderCredentialTaskPlan,
} from '@/utils/quota/providerRefreshScheduler';
import {
  isQuotaRefreshDue,
  matchCredentialFiles,
  selectCredentialQuota,
  type CredentialIdentityKeys,
  type CredentialQuota,
} from '../credentialQuotaModel';

// The limits Credential Manager refreshes with: one request per provider at a time.
const MAX_CONCURRENT_REFRESHES_PER_PROVIDER = 1;
const MAX_CONCURRENT_REFRESH_PROVIDERS = 3;
const CLOCK_TICK_MS = 60_000;

export interface CredentialQuotaView {
  quota: CredentialQuota;
  /** The last refresh failed, or a window's cycle has ended since: the numbers may be out of date. */
  stale: boolean;
}

export interface UseCredentialQuotaReturn {
  byCredentialId: ReadonlyMap<string, CredentialQuotaView>;
  nowMs: number;
}

const refreshKey = (row: AccountRow) => `${row.provider}:${getQuotaCredentialStoreKey(row.raw)}`;

const quotaStateOf = (row: AccountRow, stores: AccountQuotaStores) => {
  switch (row.provider) {
    case 'codex':
      return getCredentialScopedQuotaState(stores.codexQuota, row.raw);
    case 'claude':
      return getCredentialScopedQuotaState(stores.claudeQuota, row.raw);
    case 'antigravity':
      return getCredentialScopedQuotaState(stores.antigravityQuota, row.raw);
    case 'kimi':
      return getCredentialScopedQuotaState(stores.kimiQuota, row.raw);
    case 'xai':
      return getCredentialScopedQuotaState(stores.xaiQuota, row.raw);
    case 'devin':
      return getCredentialScopedQuotaState(stores.devinQuota, row.raw);
    case 'meta':
      return getCredentialScopedQuotaState(stores.metaQuota, row.raw);
    default:
      return undefined;
  }
};

/**
 * Quota for the dashboard's credentials, kept the way Credential Manager keeps
 * it: its provider configs refresh the shared quota store, and the stored
 * snapshots fill in until a refresh lands or when one fails.
 */
export function useCredentialQuota(
  credentials: readonly CredentialIdentityKeys[]
): UseCredentialQuotaReturn {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const availability = usePanelFeatureAvailability();
  const managerBase = availability.checking ? '' : availability.managerServiceBase;

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);
  const stores = useMemo<AccountQuotaStores>(
    () => ({ antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota }),
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota]
  );

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, AccountQuotaSnapshotWindow[]>>(
    () => new Map()
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [refreshQueue] = useState(() => createKeyedSerialTaskQueue());
  const requestScope = useMemo(() => ({ apiBase, managementKey }), [apiBase, managementKey]);
  const activeRef = useRef(true);
  const lastRefreshStartedRef = useRef(new Map<string, number>());

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let current = true;
    authFilesApi
      .list(requestScope)
      .then((response) => {
        if (current) setFiles(response.files ?? []);
      })
      .catch(() => {
        // Without the auth files there is no quota to show; the rest of the page is unaffected.
      });
    return () => {
      current = false;
    };
  }, [requestScope]);

  const matches = useMemo(() => matchCredentialFiles(credentials, files), [credentials, files]);
  const rowsByCredentialId = useMemo(() => {
    const matched = Array.from(matches.entries());
    const rows = buildAccountRows(
      matched.map(([, file]) => file),
      stores
    );
    return new Map(matched.map(([credentialId], index) => [credentialId, rows[index]]));
  }, [matches, stores]);
  const rows = useMemo(() => Array.from(rowsByCredentialId.values()), [rowsByCredentialId]);
  const targetsKey = useMemo(() => rows.map((row) => row.selectionKey).join('\u0000'), [rows]);
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const loadSnapshots = useCallback(async () => {
    const accounts = buildAccountQuotaSnapshotQueryAccounts(rowsRef.current);
    if (!managerBase || accounts.length === 0) return;
    try {
      const response = await accountQuotaSnapshotApi.query(managerBase, managementKey, accounts);
      if (!activeRef.current) return;
      setSnapshots(new Map(response.items.map((item) => [item.row_key, item.windows])));
    } catch {
      // Stored snapshots only fill in for a refresh; without them the refreshed quota still shows.
    }
  }, [managementKey, managerBase]);

  const refreshRow = useCallback(
    async (row: AccountRow) => {
      const store = useQuotaStore.getState();
      const run = <TState, TData>(
        config: QuotaConfig<TState, TData>,
        setQuota: QuotaSetter<TState>,
        states: Record<string, TState>
      ) =>
        refreshQuotaWithConfig({
          config,
          file: row.raw,
          setQuota,
          t,
          isCurrent: () => activeRef.current,
          requestScope,
          currentState: getScopedQuotaState(config, states, row.raw),
        });
      try {
        switch (row.provider) {
          case 'codex':
            return await run(CODEX_SUMMARY_CONFIG, store.setCodexQuota, store.codexQuota);
          case 'claude':
            return await run(CLAUDE_CONFIG, store.setClaudeQuota, store.claudeQuota);
          case 'antigravity':
            return await run(ANTIGRAVITY_CONFIG, store.setAntigravityQuota, store.antigravityQuota);
          case 'kimi':
            return await run(KIMI_CONFIG, store.setKimiQuota, store.kimiQuota);
          case 'xai':
            return await run(XAI_CONFIG, store.setXaiQuota, store.xaiQuota);
          case 'devin':
            return await run(DEVIN_CONFIG, store.setDevinQuota, store.devinQuota);
          case 'meta':
            return await run(META_CONFIG, store.setMetaQuota, store.metaQuota);
          default:
            return null;
        }
      } catch {
        // A failed refresh is recorded on the quota state; it must never break the page.
        return null;
      }
    },
    [requestScope, t]
  );

  useEffect(() => {
    if (targetsKey) void loadSnapshots();
  }, [loadSnapshots, targetsKey]);

  // Opens with one refresh per credential, then repeats once each is due again.
  useEffect(() => {
    if (!targetsKey) return;
    const startedAtMs = Date.now();
    const due = rowsRef.current.filter(
      (row) =>
        !row.runtimeOnly &&
        isQuotaRefreshSupportedProvider(row.provider) &&
        isQuotaRefreshDue(lastRefreshStartedRef.current.get(refreshKey(row)), startedAtMs)
    );
    if (due.length === 0) return;
    due.forEach((row) => lastRefreshStartedRef.current.set(refreshKey(row), startedAtMs));
    const plan = buildProviderCredentialTaskPlan(due, {
      getProviderKey: (row) => row.provider,
      getCredentialKey: (row) => getQuotaCredentialStoreKey(row.raw),
    });
    // The queue runs one batch at a time and folds a repeated batch into the pending one.
    void refreshQueue.run(
      plan
        .map((task) => `${task.providerKey}:${task.credentialKey}`)
        .sort()
        .join('|'),
      async () => {
        await runProviderCredentialTaskPlan(
          plan,
          {
            perProviderConcurrency: MAX_CONCURRENT_REFRESHES_PER_PROVIDER,
            maxConcurrentProviders: MAX_CONCURRENT_REFRESH_PROVIDERS,
          },
          ({ item }) => refreshRow(item)
        );
        // Quota the server observed meanwhile, such as Codex response headers, comes along.
        await loadSnapshots();
      }
    );
  }, [loadSnapshots, nowMs, refreshQueue, refreshRow, targetsKey]);

  const byCredentialId = useMemo(() => {
    const result = new Map<string, CredentialQuotaView>();
    rowsByCredentialId.forEach((row, credentialId) => {
      const definitions = mergeAccountQuotaSnapshotWindows(
        buildAccountQuotaWindowDefinitions(
          buildAccountQuotaDisplayWindows(row, {
            stores,
            translateQuotaWindowLabel: (label) => label ?? '',
            t,
            nowMs,
          }),
          nowMs
        ),
        snapshots.get(row.selectionKey) ?? [],
        { provider: row.provider }
      );
      const quota = selectCredentialQuota(definitions, nowMs);
      result.set(credentialId, {
        quota,
        stale: quota.expired || quotaStateOf(row, stores)?.status === 'error',
      });
    });
    return result;
  }, [nowMs, rowsByCredentialId, snapshots, stores, t]);

  return { byCredentialId, nowMs };
}
