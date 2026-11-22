import { describe, expect, it } from 'vitest';
import type { AuthFileItem } from '@/types';
import { CODEX_MAIN_QUOTA_SCOPE_KEY } from '@/utils/quota/codexQuota';
import {
  QUOTA_REFRESH_INTERVAL_MS,
  hasQuotaWindows,
  isQuotaRefreshDue,
  matchCredentialFiles,
  quotaAge,
  quotaLevel,
  selectCredentialQuota,
  type QuotaWindowSource,
} from './credentialQuotaModel';

const NOW = Date.UTC(2026, 10, 21, 18, 0);
const MINUTE = 60_000;

const window = (
  providerWindowId: string,
  kind: QuotaWindowSource['kind'],
  usedPercent: number | null,
  extra: Partial<QuotaWindowSource> = {}
): QuotaWindowSource => ({
  providerWindowId,
  provider: 'claude',
  label: providerWindowId,
  kind,
  modelScope: { kind: 'all', complete: true },
  usedPercent,
  remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  cycleEndMs: NOW + 60 * MINUTE,
  observedAtMs: NOW - 3 * MINUTE,
  stale: false,
  ...extra,
});

describe('quota window selection', () => {
  it('finds the 5-hour and weekly windows by kind, whatever the provider calls them', () => {
    const quota = selectCredentialQuota(
      [
        window('secondary', 'weekly', 28, { provider: 'codex' }),
        window('primary', 'five_hour', 12, { provider: 'codex' }),
      ],
      NOW
    );

    expect(quota.fiveHour).toMatchObject({ kind: 'five_hour', usedPercent: 12 });
    expect(quota.weekly).toMatchObject({ kind: 'weekly', usedPercent: 28 });
    expect(quota.extra).toBeNull();
  });

  it("treats Codex's main limits as the account's own, not as a scoped extra", () => {
    const main = { kind: 'family' as const, key: CODEX_MAIN_QUOTA_SCOPE_KEY, complete: true };
    const quota = selectCredentialQuota(
      [
        window('five-hour', 'five_hour', 84, { provider: 'codex', modelScope: main }),
        window('weekly', 'weekly', 96, { provider: 'codex', modelScope: main }),
      ],
      NOW
    );

    expect(quota.fiveHour).toMatchObject({ usedPercent: 84, level: 'warning' });
    expect(quota.weekly).toMatchObject({ usedPercent: 96, level: 'critical' });
    expect(quota.extra).toBeNull();
  });

  it("shows xAI's weekly credits as the extra window, not as the 7-day limit", () => {
    const quota = selectCredentialQuota(
      [
        window('billing', 'billing', 40, { provider: 'xai' }),
        window('credits-period', 'weekly', 61, { provider: 'xai' }),
        window('product-0-grokbuild', 'product', 9, { provider: 'xai' }),
      ],
      NOW
    );

    expect(quota.weekly).toBeNull();
    expect(quota.extra).toMatchObject({ kind: 'credits', usedPercent: 61 });
  });

  it("adds Claude's scoped weekly window as the extra one, named by its label", () => {
    const quota = selectCredentialQuota(
      [
        window('five-hour', 'five_hour', 44),
        window('seven-day', 'weekly', 31),
        window('weekly-scoped-fable', 'weekly', 78, {
          label: 'Fable',
          modelScope: { kind: 'models', models: [], complete: false },
        }),
      ],
      NOW
    );

    expect(quota.weekly?.usedPercent).toBe(31);
    expect(quota.extra).toMatchObject({ kind: 'scoped_weekly', scope: 'Fable', usedPercent: 78 });
  });

  it('names a scoped window from its id when the stored snapshot carries no label', () => {
    const quota = selectCredentialQuota(
      [window('weekly-scoped-fable', 'weekly', 78, { modelScope: { kind: 'feature' } })],
      NOW
    );

    expect(quota.extra?.scope).toBe('Fable');
  });

  it('leaves billing, product and summary windows out, so such a credential has no quota', () => {
    const quota = selectCredentialQuota(
      [
        window('extra-usage', 'billing', 50),
        window('summary', 'summary', 20, { provider: 'kimi' }),
        window('product-0', 'product', 5, { provider: 'xai' }),
      ],
      NOW
    );

    expect(hasQuotaWindows(quota)).toBe(false);
    expect(quota.observedAtMs).toBeNull();
  });

  it('drops a window the provider stopped reporting, such as an absent Codex 5-hour limit', () => {
    const quota = selectCredentialQuota(
      [
        window('five-hour', 'five_hour', 90, { provider: 'codex', availability: 'pending_absent' }),
        window('weekly', 'weekly', 35, { provider: 'codex' }),
      ],
      NOW
    );

    expect(quota.fiveHour).toBeNull();
    expect(quota.weekly?.usedPercent).toBe(35);
  });

  it('derives the used share from what remains and keeps it within 0 to 100', () => {
    const quota = selectCredentialQuota(
      [
        window('five-hour', 'five_hour', null, { remainingPercent: 30 }),
        window('seven-day', 'weekly', 140),
      ],
      NOW
    );

    expect(quota.fiveHour?.usedPercent).toBe(70);
    expect(quota.weekly?.usedPercent).toBe(100);
  });

  it('flags a window whose cycle has ended and stops quoting its reset time', () => {
    const quota = selectCredentialQuota(
      [
        window('five-hour', 'five_hour', 90, { cycleEndMs: NOW - MINUTE }),
        window('seven-day', 'weekly', 31),
      ],
      NOW
    );

    expect(quota.expired).toBe(true);
    expect(quota.fiveHour?.resetAtMs).toBeNull();
    expect(quota.weekly?.resetAtMs).toBe(NOW + 60 * MINUTE);
  });

  it('dates the quota by the oldest number on screen, ignoring windows it does not show', () => {
    const quota = selectCredentialQuota(
      [
        window('five-hour', 'five_hour', 10, { observedAtMs: NOW - 40 * MINUTE }),
        window('seven-day', 'weekly', 31, { observedAtMs: NOW - 2 * MINUTE }),
        window('extra-usage', 'billing', 50, { observedAtMs: NOW - 900 * MINUTE }),
      ],
      NOW
    );

    expect(quota.observedAtMs).toBe(NOW - 40 * MINUTE);
    expect(quota.expired).toBe(false);
  });
});

describe('quota thresholds', () => {
  it('turns amber at 80% and red at 95%', () => {
    expect([79.9, 80, 94.9, 95, 100].map(quotaLevel)).toEqual([
      'normal',
      'warning',
      'warning',
      'critical',
      'critical',
    ]);
  });
});

describe('quota freshness', () => {
  it('states the age in the largest whole unit', () => {
    const age = (minutes: number) => quotaAge(NOW - minutes * MINUTE, NOW);

    expect(age(0.5)).toEqual({ unit: 'now', count: 0 });
    expect(age(59)).toEqual({ unit: 'minutes', count: 59 });
    expect(age(60)).toEqual({ unit: 'hours', count: 1 });
    expect(age(23 * 60 + 59)).toEqual({ unit: 'hours', count: 23 });
    expect(age(49 * 60)).toEqual({ unit: 'days', count: 2 });
  });

  it('refreshes a credential on first sight, then not again until five minutes have passed', () => {
    expect(isQuotaRefreshDue(undefined, NOW)).toBe(true);
    expect(isQuotaRefreshDue(NOW - QUOTA_REFRESH_INTERVAL_MS + 1, NOW)).toBe(false);
    expect(isQuotaRefreshDue(NOW - QUOTA_REFRESH_INTERVAL_MS, NOW)).toBe(true);
  });
});

describe('credential identity', () => {
  const file = (name: string, authIndex: string) => ({ name, authIndex }) as AuthFileItem;
  const files = [file('claude-a.json', 'idx-a'), file('codex-b.json', 'idx-b')];

  it('pairs a usage credential with its auth file by file name, then by auth index', () => {
    const matches = matchCredentialFiles(
      [
        { id: 'by-name', authFile: 'claude-a.json', authIndex: '' },
        { id: 'by-index', authFile: '', authIndex: 'idx-b' },
      ],
      files
    );

    expect(matches.get('by-name')?.name).toBe('claude-a.json');
    expect(matches.get('by-index')?.name).toBe('codex-b.json');
  });

  it('trusts the file name over an auth index that now belongs to another file', () => {
    const matches = matchCredentialFiles(
      [{ id: 'renumbered', authFile: 'claude-a.json', authIndex: 'idx-b' }],
      files
    );

    expect(matches.get('renumbered')?.name).toBe('claude-a.json');
  });

  it('leaves a credential without an auth file, such as an API key, unmatched', () => {
    const matches = matchCredentialFiles(
      [{ id: 'openrouter-key', authFile: '', authIndex: 'hash-123' }],
      files
    );

    expect(matches.has('openrouter-key')).toBe(false);
  });
});
