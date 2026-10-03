// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Automation } from '@/types';
import {
  AUTOMATIONS_COPY,
  AutomationListRow,
  automationMetaLine,
  readAutomationsDensity,
  writeAutomationsDensity,
} from './automation-list-row';

const automation = (over: Partial<Automation> = {}): Automation =>
  ({
    id: 'a1',
    name: 'Boas-vindas',
    description: 'Responde a primeira mensagem',
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    is_active: true,
    run_frequency: 'once_per_contact',
    cooldown_hours: null,
    execution_count: 3,
    last_executed_at: null,
    ...over,
  }) as Automation;

const copy = AUTOMATIONS_COPY['pt-BR'];

function renderRow(a: Automation, extra: Partial<Parameters<typeof AutomationListRow>[0]> = {}) {
  const onToggle = vi.fn();
  render(
    <ul>
      <AutomationListRow
        automation={a}
        language="pt-BR"
        copy={copy}
        compact={false}
        duplicateOf={[]}
        onToggle={onToggle}
        onEdit={() => {}}
        onDuplicate={() => {}}
        onLogs={() => {}}
        onDelete={() => {}}
        {...extra}
      />
    </ul>,
  );
  return { onToggle };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('automationMetaLine', () => {
  it('joins trigger, frequency, runs and last run with " · "', () => {
    const line = automationMetaLine(automation(), 'pt-BR', copy);
    const parts = line.split(' · ');
    expect(parts).toHaveLength(4);
    expect(parts[2]).toBe('3 execuções');
    expect(parts[3]).toBe('última nunca');
  });

  it('uses the singular for one run', () => {
    expect(automationMetaLine(automation({ execution_count: 1 }), 'en-US', AUTOMATIONS_COPY['en-US'])).toContain(
      '1 run ·',
    );
  });
});

describe('AutomationListRow', () => {
  it('shows status as dot + text and toggles through the switch', () => {
    const { onToggle } = renderRow(automation());
    expect(screen.getByText('Ativa')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Pausar Boas-vindas' }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('labels a paused automation and offers to activate it', () => {
    renderRow(automation({ is_active: false }));
    expect(screen.getByText('Pausada')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Ativar Boas-vindas' })).toBeTruthy();
  });

  it('hides the description in compact mode', () => {
    renderRow(automation(), { compact: true });
    expect(screen.queryByText('Responde a primeira mensagem')).toBeNull();
  });

  it('warns about another automation on the same trigger', () => {
    renderRow(automation(), { duplicateOf: ['Olá'] });
    expect(screen.getByText(/Mesmo gatilho que "Olá"/)).toBeTruthy();
  });
});

describe('density persistence', () => {
  it('round-trips per user and defaults to comfortable', () => {
    expect(readAutomationsDensity('u1')).toBe('comfortable');
    writeAutomationsDensity('u1', 'compact');
    expect(readAutomationsDensity('u1')).toBe('compact');
    expect(readAutomationsDensity('u2')).toBe('comfortable');
    expect(localStorage.getItem('sempre:automations:density:u1')).toBe('compact');
  });

  it('survives a throwing localStorage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readAutomationsDensity('u1')).toBe('comfortable');
    spy.mockRestore();
  });
});
