'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LANGUAGE,
  EN_TO_PT,
  LANGUAGE_STORAGE_KEY,
  isLanguage,
  translateLiteral,
  type Language,
} from '@/lib/i18n';

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (english: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);
const originalText = new WeakMap<Text, string>();
const appliedText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
const appliedAttributes = new WeakMap<Element, Map<string, string>>();
const TRANSLATED_ATTRIBUTES = [
  'placeholder',
  'title',
  'aria-label',
  'aria-description',
  'alt',
];

function readInitialLanguage(): Language {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {}
  return DEFAULT_LANGUAGE;
}

function shouldSkip(node: Node): boolean {
  const parent = node instanceof Element ? node : node.parentElement;
  return !!parent?.closest(
    "script, style, pre, code, [contenteditable='true'], [data-no-translate]"
  );
}

function translateTextNode(node: Text, language: Language) {
  if (shouldSkip(node)) return;
  const lastApplied = appliedText.get(node);
  if (
    !originalText.has(node) ||
    (lastApplied !== undefined && node.data !== lastApplied)
  ) {
    originalText.set(node, node.data);
  }
  const source = originalText.get(node) ?? node.data;
  const target = translateLiteral(source, language);
  if (node.data !== target) node.data = target;
  appliedText.set(node, target);
}

function translateElement(element: Element, language: Language) {
  if (shouldSkip(element)) return;
  const originals =
    originalAttributes.get(element) ?? new Map<string, string>();
  const applied = appliedAttributes.get(element) ?? new Map<string, string>();
  for (const attribute of TRANSLATED_ATTRIBUTES) {
    const current = element.getAttribute(attribute);
    if (current === null) continue;
    if (
      !originals.has(attribute) ||
      (applied.has(attribute) && current !== applied.get(attribute))
    ) {
      originals.set(attribute, current);
    }
    const target = translateLiteral(
      originals.get(attribute) ?? current,
      language
    );
    if (current !== target) element.setAttribute(attribute, target);
    applied.set(attribute, target);
  }
  originalAttributes.set(element, originals);
  appliedAttributes.set(element, applied);
}

function translateTree(root: Node, language: Language) {
  if (root.nodeType === Node.TEXT_NODE)
    translateTextNode(root as Text, language);
  if (root instanceof Element) translateElement(root, language);
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
  );
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE)
      translateTextNode(node as Text, language);
    else translateElement(node as Element, language);
    node = walker.nextNode();
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readInitialLanguage);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    document.documentElement.lang = next;
    document.documentElement.dataset.language = next;
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {}
  }, []);

  const t = useCallback(
    (english: string) =>
      language === 'pt-BR' ? (EN_TO_PT[english] ?? english) : english,
    [language]
  );

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.language = language;
    translateTree(document.body, language);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData')
          translateTextNode(mutation.target as Text, language);
        else if (mutation.type === 'attributes')
          translateElement(mutation.target as Element, language);
        else
          mutation.addedNodes.forEach((node) => translateTree(node, language));
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATED_ATTRIBUTES,
    });
    return () => observer.disconnect();
  }, [language]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY && isLanguage(event.newValue)) {
        setLanguageState(event.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  return (
    useContext(LanguageContext) ?? {
      language: DEFAULT_LANGUAGE,
      setLanguage: () => {},
      t: (english) => EN_TO_PT[english] ?? english,
    }
  );
}
