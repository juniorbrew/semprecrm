import { describe, expect, it } from 'vitest';

import { getPageTitle } from './header';

describe('getPageTitle', () => {
  it('uses the longest matching route and translates it', () => {
    expect(getPageTitle('/ai')).toBe('Agente de IA');
    expect(getPageTitle('/ai/agents')).toBe('Agentes de IA');
    expect(getPageTitle('/ai/agents/0f0e1d2c-3b4a-4596-8778-695a4b3c2d1e')).toBe('Agentes de IA');
    expect(getPageTitle('/ai/uso')).toBe('Uso e orçamento');
    expect(getPageTitle('/settings')).toBe('Configurações');
  });

  it('matches whole path segments only and falls back to the dashboard', () => {
    expect(getPageTitle('/aisomething')).toBe(getPageTitle('/dashboard'));
    expect(getPageTitle('/nowhere')).toBe(getPageTitle('/dashboard'));
  });

  it('keeps English when the language is English', () => {
    expect(getPageTitle('/ai/agents/x', 'en-US')).toBe('AI agents');
  });
});
