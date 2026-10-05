// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { AI_HUB_GROUPS, AiHub } from './ai-hub';

afterEach(cleanup);

describe('AiHub', () => {
  it('lists every module in three groups', () => {
    render(<AiHub />);
    expect(AI_HUB_GROUPS).toHaveLength(3);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3);
    const total = AI_HUB_GROUPS.reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(14);
  });

  it('links built modules and marks the rest as coming soon', () => {
    render(<AiHub />);
    expect(screen.getByRole('link', { name: /^Agentes/ }).getAttribute('href')).toBe('/ai/agents');
    expect(screen.queryByRole('link', { name: /Execuções/ })).toBeNull();
    expect(screen.getAllByText('Em breve').length).toBe(
      AI_HUB_GROUPS.flatMap((g) => g.items).filter((i) => !i.href).length,
    );
  });
});
