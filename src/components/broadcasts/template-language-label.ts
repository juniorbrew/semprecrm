// Meta template language code (`pt_BR`, `en_US`, `es`) → a readable name
// in the reader's language ("Português (Brasil)", "Brazilian Portuguese"),
// so the wizard never shows the raw enum. Falls back to the BCP 47 form
// ("pt-BR") when the runtime cannot name the tag.

import type { Language } from '@/lib/i18n';

export function templateLanguageLabel(
  code: string | null | undefined,
  language: Language,
): string {
  const tag = (code || 'en_US').replace(/_/g, '-');
  try {
    const name = new Intl.DisplayNames([language], { type: 'language' }).of(tag);
    if (name && name !== tag) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    // Unknown/invalid tag — show the BCP 47 form below.
  }
  return tag;
}
