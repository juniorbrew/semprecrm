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

function line(breakdown: AudienceBreakdown, suppressionChecked = true, capped = false) {
  const { container } = render(
    <AudienceBreakdownLine estimate={{ breakdown, suppressionChecked, capped }} t={t} language="pt-BR" />,
  );
  return container.textContent;
}

afterEach(cleanup);

describe('AudienceBreakdownLine', () => {
  it('explains the gap in pt-BR, skipping empty buckets, singular and plural', () => {
    expect(line(b({ selected: 9, excludedByTag: 2, optedOut: 3, eligible: 4 }))).toBe(
      '9 selecionados · 2 excluídos por etiqueta · 3 descadastrados',
    );
    expect(line(b({ selected: 1, excludedByTag: 1 }))).toBe('1 selecionado · 1 excluído por etiqueta');
    expect(line(b({ selected: 5, optedOut: 1, noPhone: 1, duplicate: 1, suppressed: 1, eligible: 1 }))).toBe(
      '5 selecionados · 1 descadastrado · 1 sem telefone válido · 1 número repetido · 1 na lista de supressão',
    );
    expect(line(b({ selected: 6, duplicate: 2, eligible: 4 }))).toBe('6 selecionados · 2 números repetidos');
  });

  it('warns when the audience hit the 1 000-row cap', () => {
    expect(line(b({ selected: 1000, eligible: 1000 }), true, true)).toBe(
      'Só os primeiros 1.000 contatos deste público serão incluídos.',
    );
  });

  it('renders nothing when everyone selected is reached', () => {
    expect(line(b({ selected: 4, eligible: 4 }))).toBe('');
  });

  it('says so when the suppression list could not be checked', () => {
    expect(line(b({ selected: 4, eligible: 4 }), false)).toBe('4 selecionados · lista de supressão não verificada');
  });
});
