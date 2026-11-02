// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { isInAppBrowser, isIosDevice, isStandalone, resetInstallPromptForTests } from '@/hooks/use-install-prompt';
import { INSTALL_PROMPT_BOOT_SCRIPT, INSTALL_PROMPT_KEY } from '@/lib/pwa/install-prompt';
import { InstallAppBanner } from './install-app-banner';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const IPHONE_INSTAGRAM = `${IPHONE} Instagram 350.0.0.0`;
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36';

function device(ua: string, { standalone = false, touch = 0 } = {}) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  // jsdom has no maxTouchPoints at all
  Object.defineProperty(navigator, 'maxTouchPoints', { value: touch, configurable: true });
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: standalone && q.includes('standalone'),
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function chromeOffersInstall(prompt = vi.fn(async () => {})) {
  const evt = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  });
  act(() => {
    window.dispatchEvent(evt);
  });
  return { evt, prompt };
}

// The root layout's boot script (a constant, no outside input), run as the
// browser runs it before hydration.
new Function(INSTALL_PROMPT_BOOT_SCRIPT)();

beforeEach(() => {
  localStorage.clear();
  resetInstallPromptForTests();
  window[INSTALL_PROMPT_KEY] = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('device detection', () => {
  it('knows iPhone and iPadOS (which says Macintosh, but has touch), not a Mac or Android', () => {
    expect(isIosDevice({ userAgent: IPHONE })).toBe(true);
    expect(isIosDevice({ userAgent: IPAD, maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: IPAD, maxTouchPoints: 0 })).toBe(false);
    expect(isIosDevice({ userAgent: ANDROID })).toBe(false);
  });

  it('spots in-app browsers', () => {
    expect(isInAppBrowser({ userAgent: IPHONE_INSTAGRAM })).toBe(true);
    expect(isInAppBrowser({ userAgent: IPHONE })).toBe(false);
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

  it('on iPad it is not limited to phone widths', () => {
    device(IPAD, { touch: 5 });
    const { container } = render(<InstallAppBanner />);
    expect((container.firstChild as HTMLElement).className).not.toContain('md:hidden');
  });

  it('is hidden once installed, inside Instagram, and on a browser that cannot install', () => {
    device(IPHONE, { standalone: true });
    expect(render(<InstallAppBanner />).container.innerHTML).toBe('');
    cleanup();
    device(IPHONE_INSTAGRAM);
    expect(render(<InstallAppBanner />).container.innerHTML).toBe('');
    cleanup();
    device(ANDROID); // no beforeinstallprompt
    expect(render(<InstallAppBanner />).container.innerHTML).toBe('');
  });

  it('on Android, offers Install even when Chrome fired the event before the banner existed (e.g. on /login)', async () => {
    device(ANDROID);
    const { evt, prompt } = chromeOffersInstall(); // nothing mounted yet
    expect(evt.defaultPrevented).toBe(true);
    render(<InstallAppBanner />);
    const btn = screen.getByRole('button', { name: 'Instalar' });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn); // double tap
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Instalar' })).toBeNull(); // the event works only once
  });

  it('a failing install dialog is logged, not thrown, and the button goes away', async () => {
    device(ANDROID);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<InstallAppBanner />);
    chromeOffersInstall(vi.fn(async () => Promise.reject(new Error('already shown'))));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Instalar' }));
    });
    expect(spy).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Instalar' })).toBeNull();
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

  it('dismissing still works when localStorage is blocked (private mode)', () => {
    device(IPHONE);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<InstallAppBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }));
    expect(screen.queryByText('Instale o SempreCRM no celular.')).toBeNull();
  });
});
