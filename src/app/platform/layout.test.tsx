import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  getPlatformAdmin: vi.fn(),
  from: vi.fn(),
  eq: vi.fn(),
}));
vi.mock('@/lib/platform/server', () => ({
  getPlatformAdmin: mocks.getPlatformAdmin,
}));
vi.mock('@/components/platform/platform-header', () => ({
  PlatformHeader: () => <header>Platform</header>,
}));
vi.mock('@/components/platform/platform-navigation', () => ({
  PlatformNavigation: ({
    initialNewCount,
    children,
  }: {
    initialNewCount: number | null;
    children: React.ReactNode;
  }) => <div data-platform-nav={initialNewCount}>{children}</div>,
}));
import PlatformLayout from './layout';

beforeEach(() => {
  mocks.getPlatformAdmin.mockResolvedValue(null);
  mocks.eq.mockResolvedValue({ count: 7, error: null });
  mocks.from.mockReturnValue({ select: () => ({ eq: mocks.eq }) });
});

describe('platform shell with the production access gate', () => {
  it.each([null, { gateOpen: false, supabase: { from: mocks.from } }])(
    'does not load counters or navigation before the gate opens (%j)',
    async (ctx) => {
      mocks.getPlatformAdmin.mockResolvedValue(ctx);
      const html = renderToStaticMarkup(
        await PlatformLayout({ children: <p>Login</p> })
      );
      expect(mocks.from).not.toHaveBeenCalled();
      expect(html).not.toContain('data-platform-nav');
      expect(html).toContain('<main');
      expect(html).toContain('Login');
    }
  );
  it('loads navigation after the gate opens without nesting main landmarks', async () => {
    mocks.getPlatformAdmin.mockResolvedValue({
      gateOpen: true,
      supabase: { from: mocks.from },
    });
    const html = renderToStaticMarkup(
      await PlatformLayout({ children: <p>Overview</p> })
    );
    expect(mocks.from).toHaveBeenCalledWith('leads');
    expect(html).toContain('data-platform-nav="7"');
    // The navigation component owns the unlocked main landmark.
    expect(html).not.toContain('<main');
  });
});
