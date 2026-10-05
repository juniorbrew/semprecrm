// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let admin = true;
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ canManageMembers: admin, profileLoading: false }),
}));

import { barPct, UsageView } from './usage-view';

const bucket = (key: string, costCents: number, errors = 0) => ({ key, calls: 4, errors, tokens: 900, costCents });

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('/usage')
        ? {
            month: '2026-10',
            truncated: false,
            byDay: [bucket('2026-10-03', 20), bucket('2026-10-04', 80)],
            byFeature: [bucket('auto_reply', 90, 1), bucket('suggest_reply', 10)],
            byModel: [bucket('mistral-nemo', 100)],
          }
        : {
            settings: { monthly_budget_cents: 1000 },
            usage: { calls: 8, errors: 1, inputTokens: 1000, outputTokens: 500, costCents: 100 },
          };
      return { ok: true, json: async () => body } as Response;
    }),
  );
}

beforeEach(() => {
  admin = true;
  mockFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('barPct', () => {
  it('scales to the max, keeps non-zero values visible and zero empty', () => {
    expect(barPct(50, 100)).toBe(50);
    expect(barPct(0.1, 100)).toBe(2);
    expect(barPct(0, 100)).toBe(0);
    expect(barPct(5, 0)).toBe(0);
  });
});

describe('UsageView', () => {
  it('shows spend against the budget and the breakdowns', async () => {
    render(<UsageView />);
    expect(await screen.findByText('Resposta automática')).toBeTruthy();
    expect(screen.getByText('mistral-nemo')).toBeTruthy();
    expect(screen.getByText('04/10')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('10');
  });

  it('does not fetch or show data for non-admins', () => {
    admin = false;
    render(<UsageView />);
    expect(screen.getByText('Só administradores veem o consumo da IA.')).toBeTruthy();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
