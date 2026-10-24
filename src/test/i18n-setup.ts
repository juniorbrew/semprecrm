// Component tests render with the whole catalogue registered, as if every
// route chunk had loaded. What each route actually ships is covered by
// src/lib/i18n-chunks.test.ts.
import { EN_TO_PT } from '@/lib/i18n';
import { registerDict } from '@/lib/i18n-runtime';

registerDict(EN_TO_PT);
