import { isModelScopedAccountQuotaWindow } from '@/features/accounts/model/accountQuotaDisplayWindows';
import type { AccountQuotaWindowDefinition } from '@/features/accounts/model/accountQuotaWindowDefinitions';
import type { AuthFileItem } from '@/types';
import { resolveCredentialIdentity } from '@/utils/authFileCredentialIdentity';
import { normalizeAuthIndex } from '@/utils/authIndex';

/** Quota is refreshed when the page opens, then no more often than this. */
export const QUOTA_REFRESH_INTERVAL_MS = 5 * 60_000;

const WARNING_PERCENT = 80;
const CRITICAL_PERCENT = 95;
// xAI's credits allowance. Its period can be weekly, yet it is not the plan's 7-day window.
const XAI_CREDITS_WINDOW_ID = 'credits-period';

/** The fields of a Credential Manager quota window that the dashboard reads. */
export type QuotaWindowSource = Pick<
  AccountQuotaWindowDefinition,
  | 'providerWindowId'
  | 'provider'
  | 'label'
  | 'kind'
  | 'modelScope'
  | 'usedPercent'
  | 'remainingPercent'
  | 'cycleEndMs'
  | 'observedAtMs'
  | 'stale'
  | 'availability'
>;

export type QuotaLevel = 'normal' | 'warning' | 'critical';

export interface CredentialQuotaWindow {
  kind: 'five_hour' | 'weekly' | 'scoped_weekly' | 'credits';
  /** What a scoped weekly window is scoped to, e.g. "Fable"; empty for the other kinds. */
  scope: string;
  usedPercent: number;
  level: QuotaLevel;
  /** Null when the provider gives no reset time, or it has already passed. */
  resetAtMs: number | null;
}

export interface CredentialQuota {
  fiveHour: CredentialQuotaWindow | null;
  weekly: CredentialQuotaWindow | null;
  /** A third window some credentials have: a scoped weekly limit, or xAI credits. */
  extra: CredentialQuotaWindow | null;
  /** When the oldest number shown was observed. */
  observedAtMs: number | null;
  /** A window's cycle has ended since it was observed, so its number is out of date. */
  expired: boolean;
}

export const quotaLevel = (usedPercent: number): QuotaLevel =>
  usedPercent >= CRITICAL_PERCENT ? 'critical' : usedPercent >= WARNING_PERCENT ? 'warning' : 'normal';

const isFinitePercent = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const usedPercentOf = (window: QuotaWindowSource) => {
  const used = isFinitePercent(window.usedPercent)
    ? window.usedPercent
    : isFinitePercent(window.remainingPercent)
      ? 100 - window.remainingPercent
      : null;
  return used === null ? null : Math.max(0, Math.min(100, used));
};

// A window the provider stopped reporting, such as a Codex plan without a 5-hour limit.
const isAbsent = (window: QuotaWindowSource) =>
  window.availability === 'pending_absent' || window.availability === 'inactive';

const isCredits = (window: QuotaWindowSource) =>
  window.provider === 'xai' && window.providerWindowId === XAI_CREDITS_WINDOW_ID;

// Credential Manager's own test, which also counts Codex's main limits as account-wide.
const isAccountWide = (window: QuotaWindowSource) =>
  !isModelScopedAccountQuotaWindow({ modelScope: window.modelScope, source: window.provider });

/** A scoped window's name: its label, or its id without the words that only say it is weekly. */
const scopeName = (window: QuotaWindowSource) => {
  const label = window.label.trim();
  if (label && label !== window.providerWindowId) return label;
  return window.providerWindowId
    .replace(/^(weekly|seven[-_]day)[-_](scoped[-_])?(id[-_])?/i, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * Picks the windows the dashboard shows from a credential's quota windows: the
 * account-wide 5-hour and weekly limits by kind, plus one extra when present.
 */
export function selectCredentialQuota(
  windows: readonly QuotaWindowSource[],
  nowMs: number
): CredentialQuota {
  const usable = windows.filter((window) => !isAbsent(window) && usedPercentOf(window) !== null);
  const standard = (kind: 'five_hour' | 'weekly') =>
    usable.find((window) => window.kind === kind && isAccountWide(window) && !isCredits(window));
  const sources = {
    five_hour: standard('five_hour'),
    weekly: standard('weekly'),
    credits: usable.find(isCredits),
    scoped_weekly: usable.find((window) => window.kind === 'weekly' && !isAccountWide(window)),
  };
  const shown = Object.values(sources).filter((window) => window !== undefined);

  const build = (kind: CredentialQuotaWindow['kind']): CredentialQuotaWindow | null => {
    const window = sources[kind];
    if (!window) return null;
    const usedPercent = usedPercentOf(window) ?? 0;
    return {
      kind,
      scope: kind === 'scoped_weekly' ? scopeName(window) : '',
      usedPercent,
      level: quotaLevel(usedPercent),
      resetAtMs: window.cycleEndMs !== null && window.cycleEndMs > nowMs ? window.cycleEndMs : null,
    };
  };
  const observed = shown
    .map((window) => window.observedAtMs)
    .filter((value): value is number => typeof value === 'number' && value > 0);

  return {
    fiveHour: build('five_hour'),
    weekly: build('weekly'),
    extra: build('credits') ?? build('scoped_weekly'),
    observedAtMs: observed.length > 0 ? Math.min(...observed) : null,
    expired: shown.some(
      (window) => window.stale || (window.cycleEndMs !== null && window.cycleEndMs <= nowMs)
    ),
  };
}

export const hasQuotaWindows = (quota: CredentialQuota | null | undefined): quota is CredentialQuota =>
  Boolean(quota && (quota.fiveHour || quota.weekly || quota.extra));

export interface QuotaAge {
  unit: 'now' | 'minutes' | 'hours' | 'days';
  count: number;
}

/** How long ago quota was observed, in the largest whole unit. */
export function quotaAge(observedAtMs: number, nowMs: number): QuotaAge {
  const minutes = Math.max(0, Math.floor((nowMs - observedAtMs) / 60_000));
  if (minutes < 1) return { unit: 'now', count: 0 };
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  if (minutes < 24 * 60) return { unit: 'hours', count: Math.floor(minutes / 60) };
  return { unit: 'days', count: Math.floor(minutes / (24 * 60)) };
}

/** Whether a credential last refreshed at `lastStartedAtMs` may be refreshed again. */
export const isQuotaRefreshDue = (lastStartedAtMs: number | undefined, nowMs: number) =>
  lastStartedAtMs === undefined || nowMs - lastStartedAtMs >= QUOTA_REFRESH_INTERVAL_MS;

export interface CredentialIdentityKeys {
  id: string;
  /** The auth file the usage was recorded under. */
  authFile: string;
  authIndex: string;
}

/**
 * Pairs each usage credential with its auth file by the keys Credential
 * Manager identifies a credential with: the file's physical name, then its
 * auth index. A credential without a match has no auth file to ask for quota.
 */
export function matchCredentialFiles<TFile extends AuthFileItem>(
  credentials: readonly CredentialIdentityKeys[],
  files: readonly TFile[]
): Map<string, TFile> {
  const byName = new Map<string, TFile>();
  const byAuthIndex = new Map<string, TFile>();
  for (const file of files) {
    const identity = resolveCredentialIdentity(file);
    if (identity.physicalName && !byName.has(identity.physicalName)) {
      byName.set(identity.physicalName, file);
    }
    if (identity.authIndex && !byAuthIndex.has(identity.authIndex)) {
      byAuthIndex.set(identity.authIndex, file);
    }
  }
  const matches = new Map<string, TFile>();
  for (const credential of credentials) {
    const authIndex = normalizeAuthIndex(credential.authIndex);
    const file =
      byName.get(credential.authFile.trim()) ?? (authIndex ? byAuthIndex.get(authIndex) : undefined);
    if (file) matches.set(credential.id, file);
  }
  return matches;
}
