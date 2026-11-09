'use client';

import { useEffect, useRef } from 'react';

import { useLanguage } from '@/hooks/use-language';
import { publicBotConfig, whatsappLink, type BotConfig } from '@/lib/site-bot';

interface RoboHandle {
  destroy: () => void;
}
type RoboMount = (o: Record<string, unknown>) => RoboHandle;

let loading: Promise<RoboMount> | null = null;

/** Loads the same /robo.js a customer's site loads (once per page view). */
function loadRobo(): Promise<RoboMount> {
  const w = window as unknown as { SempreRobo?: { mount: RoboMount } };
  if (w.SempreRobo) return Promise.resolve(w.SempreRobo.mount);
  loading ??= new Promise<RoboMount>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/robo.js';
    s.async = true;
    s.onload = () => (w.SempreRobo ? resolve(w.SempreRobo.mount) : reject(new Error('robo.js did not start')));
    s.onerror = () => {
      loading = null;
      reject(new Error('robo.js failed to load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Live preview: the real widget, drawn from the UNSAVED draft. It never
 * calls the public API (a fake `submit` replaces the POST), never reads or
 * writes the visitor storage, and creates no lead.
 */
export function SiteBotPreview({ config }: { config: BotConfig }) {
  const { language } = useLanguage();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let handle: RoboHandle | null = null;
    let cancelled = false;
    // Debounce: typing in the editor should not rebuild the widget per key.
    const timer = setTimeout(() => {
      loadRobo()
        .then((mount) => {
          if (cancelled || !box.current) return;
          handle = mount({
            config: publicBotConfig(config),
            preview: true,
            open: true,
            container: box.current,
            lang: language === 'en-US' ? 'en' : 'pt',
            submit: async (answers: Record<string, string>) => ({
              ok: true,
              whatsapp_url: config.end.whatsappEnabled
                ? whatsappLink(config.end.whatsappNumber, config.end.messageTemplate, answers[config.questions.find((q) => q.type === 'name')?.id ?? ''] ?? '')
                : null,
            }),
          });
        })
        .catch((err) => console.error(err));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      handle?.destroy();
    };
  }, [config, language]);

  // The widget's own text and the admin's wording are shown as written.
  return <div ref={box} data-no-translate className="relative h-[560px] overflow-hidden rounded-lg border border-border bg-muted/40" />;
}
