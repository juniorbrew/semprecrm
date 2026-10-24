// Client-side dictionary registry. Route chunks (./i18n-chunks/*, generated)
// call registerDict() when their module loads, so a page only ships and
// holds the entries its own code can render. The full catalogue lives in
// i18n.ts and is never imported from client code.
import { translateWith, type Language } from './i18n-core';

const enToPt: Record<string, string> = {};
let ptToEn: Record<string, string> | null = null;
const listeners = new Set<() => void>();

export function registerDict(entries: Record<string, string>): void {
  Object.assign(enToPt, entries);
  ptToEn = null;
  listeners.forEach((fn) => fn());
}

/** Called after new entries arrive (a lazily loaded route chunk). */
export function onDictChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function lookupPt(english: string): string | undefined {
  return enToPt[english];
}

export function translateLiteral(value: string, language: Language): string {
  if (language === 'en-US' && !ptToEn) {
    ptToEn = Object.fromEntries(
      Object.entries(enToPt).map(([en, pt]) => [pt, en])
    );
  }
  return translateWith(enToPt, ptToEn ?? {}, value, language);
}
