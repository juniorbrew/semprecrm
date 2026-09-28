// ============================================================
// Per-area pt-BR dictionaries, merged into EN_TO_PT (src/lib/i18n.ts).
//
// One file per area so parallel work never collides in one giant
// object literal. Keys are the exact English string rendered by the
// component (or returned by the API); values are pt-BR. Later files win
// on duplicate keys, so keep each key in one place.
// ============================================================

import { DICT_AI } from './ai';
import { DICT_API } from './api';
import { DICT_AUTH } from './auth';
import { DICT_COMPANIES } from './companies';
import { DICT_CONTACTS } from './contacts';
import { DICT_DASHBOARD } from './dashboard';
import { DICT_FLOWS } from './flows';
import { DICT_INBOX } from './inbox';
import { DICT_MISC } from './misc';
import { DICT_SETTINGS } from './settings';

export const EN_TO_PT_AREAS: Record<string, string> = {
  ...DICT_AI,
  ...DICT_API,
  ...DICT_AUTH,
  ...DICT_COMPANIES,
  ...DICT_CONTACTS,
  ...DICT_DASHBOARD,
  ...DICT_FLOWS,
  ...DICT_INBOX,
  ...DICT_MISC,
  ...DICT_SETTINGS,
};
