import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  listPlatformAccounts: vi.fn(),
  getPlatformUsage: vi.fn(),
}));
vi.mock('@/lib/platform/server', () => mocks);
vi.mock('@/components/platform/usage-table', () => ({
  PlatformUsageTable: () => null,
}));
import PlatformUsagePage from './page';

const search = (month?: string) => Promise.resolve(month ? { month } : {});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({});
  mocks.listPlatformAccounts.mockResolvedValue([]);
  mocks.getPlatformUsage.mockResolvedValue([]);
});

it.each(['Not found', 'Gate closed'])(
  'reads nothing (and never touches the service role) when the gate refuses: %s',
  async (reason) => {
    mocks.requirePlatformAdmin.mockRejectedValue(new Error(reason));
    await expect(PlatformUsagePage({ searchParams: search() })).rejects.toThrow(
      reason
    );
    expect(mocks.getPlatformUsage).not.toHaveBeenCalled();
    expect(mocks.listPlatformAccounts).not.toHaveBeenCalled();
  }
);

it('asks the database for the requested month', async () => {
  await PlatformUsagePage({ searchParams: search('2026-06') });
  expect(mocks.getPlatformUsage).toHaveBeenCalledWith('2026-06');
});

it.each(['2026-13', '1999-01', 'abc', '2999-01'])(
  'falls back to the current month for an invalid month (%s)',
  async (month) => {
    const page = await PlatformUsagePage({ searchParams: search(month) });
    const used = mocks.getPlatformUsage.mock.calls[0]![0] as string;
    expect(used).toMatch(/^\d{4}-\d{2}$/);
    expect(used).toBe(page.props.maxMonth);
  }
);
