import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import { useVersionStatus, type VersionStatus } from './useVersionStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Far enough from any real build that the comparison never depends on this checkout's version.
const NEWER = 'v999.1.0';
const OLDER = 'v0.0.1';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    checkManagerUpdateIndex: vi.fn(),
    checkLatest: vi.fn(),
    auth: { connectionStatus: 'connected', serverVersion: '7.2.143' },
    availability: {} as PanelFeatureAvailability,
    updates: {
      status: null as Record<string, unknown> | null,
      available: true,
      error: false,
    },
  },
}));

vi.mock('@/features/system/ManagerUpdates', () => ({ useManagerUpdates: () => mocks.updates }));
vi.mock('@/hooks/usePanelFeatureAvailability', () => ({
  usePanelFeatureAvailability: () => mocks.availability,
}));
vi.mock('@/stores', () => ({
  useAuthStore: (selector: (state: typeof mocks.auth) => unknown) => selector(mocks.auth),
}));
vi.mock('@/services/api', () => ({
  versionApi: {
    checkManagerUpdateIndex: mocks.checkManagerUpdateIndex,
    checkLatest: mocks.checkLatest,
  },
}));

const stableIndex = (version: string | null) => ({
  schema_version: 1,
  channels: { stable: version === null ? null : { version } },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

let renderer: ReactTestRenderer | null = null;
let status: VersionStatus;

function Harness({ refreshSignal }: { refreshSignal: number }) {
  const result = useVersionStatus(refreshSignal);
  useEffect(() => {
    status = result;
  }, [result]);
  return null;
}

const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const mount = async ({
  externalPanel = false,
  panelHostConfirmed = true,
  managerStatus = null as Record<string, unknown> | null,
  managerError = false,
  latestCore = '7.2.143',
} = {}) => {
  mocks.availability = {
    panelHostConfirmed,
    panelHostMode: externalPanel ? 'external_panel' : 'manager_embedded',
    managerServiceAvailable: !externalPanel,
  } as PanelFeatureAvailability;
  mocks.updates = { status: managerStatus, available: !externalPanel, error: managerError };
  mocks.checkLatest.mockResolvedValue({ 'latest-version': latestCore });
  await act(async () => {
    renderer = create(<Harness refreshSignal={0} />);
  });
  await settle();
};

const recheck = async (refreshSignal: number) => {
  await act(async () => {
    renderer?.update(<Harness refreshSignal={refreshSignal} />);
  });
};

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  mocks.checkManagerUpdateIndex.mockReset();
  mocks.checkLatest.mockReset();
  mocks.auth = { connectionStatus: 'connected', serverVersion: '7.2.143' };
});

describe('installed versions', () => {
  it('reports the running Manager Server version over the panel build, each linked to its release', async () => {
    await mount({ managerStatus: { current_version: '1.12.8', state: 'up_to_date' } });

    expect(status.managerVersion).toBe('1.12.8');
    expect(status.managerReleaseUrl).toBe(
      'https://github.com/seakee/CPA-Manager-Plus/releases/tag/v1.12.8'
    );
    expect(status.coreReleaseUrl).toBe(
      'https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.143'
    );
    expect(status.managerUpdate).toBeNull();
    expect(status.coreUpdate).toBeNull();
  });
});

describe('core update', () => {
  it('reports a newer core release with its release page', async () => {
    await mount({ latestCore: '7.2.144' });

    expect(status.coreUpdate).toEqual({
      version: '7.2.144',
      releaseUrl: 'https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.144',
      installable: false,
    });
  });

  it('reports a newer build that is not a release tag without a link', async () => {
    await mount({ latestCore: '7.2.144-3-gabcdef' });

    expect(status.coreUpdate).toMatchObject({ version: '7.2.144-3-gabcdef', releaseUrl: '' });
  });

  it('does not ask for the latest release while disconnected', async () => {
    mocks.auth.connectionStatus = 'disconnected';
    await mount({ latestCore: '7.2.144' });

    expect(mocks.checkLatest).not.toHaveBeenCalled();
    expect(status.coreUpdate).toBeNull();
  });
});

describe('Manager update from the Manager Server', () => {
  const available = {
    current_version: '1.12.6',
    state: 'update_available',
    target: { release: { version: '1.12.7' } },
  };

  it('offers the update it can install, without consulting the public index', async () => {
    await mount({ managerStatus: available });

    expect(status.managerUpdate).toEqual({ version: '1.12.7', releaseUrl: '', installable: true });
    expect(mocks.checkManagerUpdateIndex).not.toHaveBeenCalled();
  });

  it.each([
    ['the status request failed', { managerError: true, managerStatus: available }],
    ['the status is stale', { managerStatus: { ...available, stale: true } }],
    ['the last check errored', { managerStatus: { ...available, last_error: 'offline' } }],
  ])('offers nothing when %s', async (_reason, options) => {
    await mount(options);

    expect(status.managerUpdate).toBeNull();
  });
});

describe('Manager update for an external panel', () => {
  it('reads the public index and links the newer stable release', async () => {
    mocks.checkManagerUpdateIndex.mockResolvedValue(stableIndex(NEWER));
    await mount({ externalPanel: true });

    expect(mocks.checkManagerUpdateIndex).toHaveBeenCalledTimes(1);
    expect(status.managerUpdate).toEqual({
      version: NEWER,
      releaseUrl: `https://github.com/seakee/CPA-Manager-Plus/releases/tag/${NEWER}`,
      installable: false,
    });
  });

  it.each([
    ['there is no stable release', stableIndex(null)],
    ['the stable release is not newer', stableIndex(OLDER)],
  ])('offers nothing when %s', async (_reason, index) => {
    mocks.checkManagerUpdateIndex.mockResolvedValue(index);
    await mount({ externalPanel: true });

    expect(status.managerUpdate).toBeNull();
  });

  it('does not read the public index until the panel host is confirmed', async () => {
    await mount({ externalPanel: true, panelHostConfirmed: false });

    expect(mocks.checkManagerUpdateIndex).not.toHaveBeenCalled();
  });

  it('withdraws the notice when a later check fails', async () => {
    mocks.checkManagerUpdateIndex.mockResolvedValue(stableIndex(NEWER));
    await mount({ externalPanel: true });
    expect(status.managerUpdate).not.toBeNull();

    mocks.checkManagerUpdateIndex.mockRejectedValueOnce(new Error('offline'));
    await recheck(1);
    await settle();

    expect(status.managerUpdate).toBeNull();
  });

  it('ignores an earlier check that answers after a later one', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.checkManagerUpdateIndex
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mount({ externalPanel: true });
    await recheck(1);

    second.resolve(stableIndex(null));
    await settle();
    first.resolve(stableIndex(NEWER));
    await settle();

    expect(status.managerUpdate).toBeNull();
  });
});
