// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { isIosDevice, isStandalone } from '@/hooks/use-install-prompt';
import { InstallAppBanner } from './install-app-banner';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36';

function device(ua: string, { standalone = false } = {}) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: standalone && q.includes('standalone'),
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('device detection', () => {
  it('knows iPhone and iPadOS (which says Macintosh, but has touch), not a Mac or Android', () => {
    expect(isIosDevice({ userAgent: IPHONE })).toBe(true);
    expect(isIosDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(false);
    expect(isIosDevice({ userAgent: ANDROID })).toBe(false);
  });

  it('treats the home-screen app as installed (display-mode or the iOS flag)', () => {
    const mm = (matches: boolean) => ({ matchMedia: () => ({ matches }) as MediaQueryList });
    expect(isStandalone(mm(true), { userAgent: ANDROID })).toBe(true);
    expect(isStandalone(mm(false), { userAgent: IPHONE, standalone: true })).toBe(true);
    expect(isStandalone(mm(false), { userAgent: IPHONE })).toBe(false);
  });
});

describe('InstallAppBanner', () => {
  it('on iPhone, explains Share → Add to Home Screen (iOS has no install button)', () => {
    device(IPHONE);
    render(<InstallAppBanner />);
    expect(screen.getByText('Instale o SempreCRM no celular.')).toBeTruthy();
    expect(screen.getByText(/Adicionar à Tela de Início/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Instalar' })).toBeNull();
  });

  it('is hidden once installed, and on a browser that cannot install', () => {
    device(IPHONE, { standalone: true });
    const { container, unmount } = render(<InstallAppBanner />);
    expect(container.innerHTML).toBe('');
    unmount();
    device(ANDROID); // no beforeinstallprompt yet
    expect(render(<InstallAppBanner />).container.innerHTML).toBe('');
  });

  it('on Android, replays the browser install dialog from our button', async () => {
    device(ANDROID);
    render(<InstallAppBanner />);
    const prompt = vi.fn(async () => {});
    const evt = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    act(() => {
      window.dispatchEvent(evt);
    });
    expect(evt.defaultPrevented).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Instalar' }));
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Instalar' })).toBeNull(); // the event works only once
  });

  it('dismissing hides it and remembers', () => {
    device(IPHONE);
    const { unmount } = render(<InstallAppBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }));
    expect(screen.queryByText('Instale o SempreCRM no celular.')).toBeNull();
    unmount();
    render(<InstallAppBanner />);
    expect(screen.queryByText('Instale o SempreCRM no celular.')).toBeNull();
  });
});
