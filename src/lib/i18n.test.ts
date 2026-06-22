import { describe, expect, it } from 'vitest';
import { translateLiteral } from './i18n';

describe('translateLiteral', () => {
  it('translates English to Brazilian Portuguese', () => {
    expect(translateLiteral('Settings', 'pt-BR')).toBe('Configurações');
  });

  it('translates Brazilian Portuguese back to English', () => {
    expect(translateLiteral('Configurações', 'en-US')).toBe('Settings');
  });

  it('preserves surrounding whitespace', () => {
    expect(translateLiteral('  Save\n', 'pt-BR')).toBe('  Salvar\n');
  });

  it('normalizes wrapped JSX text before lookup', () => {
    expect(
      translateLiteral(
        '  Everything in one place — your account and your\nworkspace. Pick a section to manage it.  ',
        'pt-BR'
      )
    ).toContain('Tudo em um só lugar');
  });

  it('leaves user content and unknown strings untouched', () => {
    expect(translateLiteral('Empresa Exemplo', 'pt-BR')).toBe(
      'Empresa Exemplo'
    );
  });

  it('covers long setup copy from the WhatsApp settings screen', () => {
    expect(translateLiteral('Setup Instructions', 'pt-BR')).toBe(
      'Instruções de configuração'
    );
    expect(
      translateLiteral(
        'Connect your Meta WhatsApp Business API. Credentials, webhook, and setup steps all live here.',
        'pt-BR'
      )
    ).toContain('Conecte sua API');
  });

  it('covers module-specific empty states', () => {
    expect(translateLiteral('No automations yet', 'pt-BR')).toBe(
      'Ainda não há automações'
    );
    expect(translateLiteral('No open deals yet', 'pt-BR')).toBe(
      'Ainda não há negócios abertos'
    );
  });
});
