import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  listPlatformAccounts: vi.fn(),
  getPlatformChannelAlerts: vi.fn(),
}));
vi.mock('@/lib/platform/server', () => mocks);
vi.mock('@/components/platform/overview', () => ({
  PlatformOverview: () => null,
}));
import PlatformPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({});
  mocks.listPlatformAccounts.mockResolvedValue([
    { id: 'company', name: 'Company' },
  ]);
  mocks.getPlatformChannelAlerts.mockResolvedValue({});
});

it('does not read accounts or channel indicators before the admin gate opens', async () => {
  mocks.requirePlatformAdmin.mockRejectedValue(new Error('Gate closed'));
  await expect(PlatformPage()).rejects.toThrow('Gate closed');
  expect(mocks.listPlatformAccounts).not.toHaveBeenCalled();
  expect(mocks.getPlatformChannelAlerts).not.toHaveBeenCalled();
});

it('propagates a failed channel read instead of displaying a healthy snapshot', async () => {
  mocks.getPlatformChannelAlerts.mockRejectedValue(
    new Error('Channel read unavailable')
  );
  await expect(PlatformPage()).rejects.toThrow('Channel read unavailable');
});

it('joins recorded indicators only to companies in the permitted account result', async () => {
  mocks.getPlatformChannelAlerts.mockResolvedValue({
    company: { official_disconnected: true, qr_disconnected: false },
    other: { official_disconnected: false, qr_disconnected: true },
  });
  const page = await PlatformPage();
  expect(page.props.rows).toEqual([
    {
      id: 'company',
      name: 'Company',
      official_disconnected: true,
      qr_disconnected: false,
    },
  ]);
});
