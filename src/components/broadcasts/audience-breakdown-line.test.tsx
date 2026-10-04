// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { translateLiteral } from '@/lib/i18n';
import type { AudienceBreakdown } from '@/lib/broadcasts/audience';
import { AudienceBreakdownLine } from './wizard-ui';

const t = (key: string) => translateLiteral(key, 'pt-BR');
const b = (over: Partial<AudienceBreakdown>): AudienceBreakdown => ({
  selected: 0,
  duplicate: 0,
  excludedByTag: 0,
  optedOut: 0,
  noPhone: 0,
  suppressed: 0,
  eligible: 0,
  ...over,
});

function line(breakdown: AudienceBreakdown, suppressionChecked = true) {
  const { container } = render(
    <AudienceBreakdownLine estimate={{ breakdown, suppressionChecked }} t={t} language="pt-BR" />,
  );
  return container.textContent;
}

afterEach(cleanup);

describe('AudienceBreakdownLine', () => {
  it('explains the gap in pt-BR, skipping empty buckets', () => {
    expect(line(b({ selected: 9, excludedByTag: 2, optedOut: 1, eligible: 6 }))).toBe(
      '9 selecionados · 2 excluídos por etiqueta · 1 descadastrados',
    );
    expect(line(b({ selected: 5, noPhone: 1, duplicate: 1, suppressed: 1, eligible: 2 }))).toBe(
      '5 selecionados · 1 sem telefone válido · 1 números repetidos · 1 na lista de supressão',
    );
  });

  it('renders nothing when everyone selected is reached', () => {
    expect(line(b({ selected: 4, eligible: 4 }))).toBe('');
  });

  it('says so when the suppression list could not be checked', () => {
    expect(line(b({ selected: 4, eligible: 4 }), false)).toBe('4 selecionados · lista de supressão não verificada');
  });
});
