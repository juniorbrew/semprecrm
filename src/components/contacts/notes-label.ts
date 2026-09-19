// "Notas" — the glossary word for a contact's / deal's notes. The
// catalogue's `Notes` key is "Observações", so the drawers that show
// notes read this table instead of `t("Notes")`.

import type { Language } from '@/lib/i18n';

export const NOTES_LABEL: Record<Language, string> = {
  'pt-BR': 'Notas',
  'en-US': 'Notes',
};
