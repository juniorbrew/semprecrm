import { describe, expect, it } from 'vitest';
import { templateStatusConfig } from './template-status';
import { EN_TO_PT, translateLiteral } from './i18n';

describe('templateStatusConfig', () => {
  it('covers every Meta review status with a label and badge classes', () => {
    for (const [key, v] of Object.entries(templateStatusConfig)) {
      expect(v.label, key).toBeTruthy();
      expect(v.classes, key).toMatch(/bg-/);
      expect(v.classes, key).toMatch(/text-/);
    }
  });

  it('every label is an English key with a pt-BR translation', () => {
    for (const [key, v] of Object.entries(templateStatusConfig)) {
      expect(EN_TO_PT[v.label], `template status "${key}"`).toBeTruthy();
      expect(translateLiteral(v.label, 'pt-BR')).not.toBe(v.label);
    }
  });

  it('localises the Meta enum the way the pt-BR UI expects', () => {
    expect(translateLiteral(templateStatusConfig.APPROVED.label, 'pt-BR')).toBe(
      'Aprovado',
    );
    expect(translateLiteral(templateStatusConfig.REJECTED.label, 'pt-BR')).toBe(
      'Rejeitado',
    );
    expect(
      translateLiteral(templateStatusConfig.PENDING_DELETION.label, 'pt-BR'),
    ).toBe('Exclusão pendente');
  });
});
