'use client';

import { Check, Languages, Moon, Palette, SunMoon, Sun } from 'lucide-react';

import { useTheme } from '@/hooks/use-theme';
import { useLanguage } from '@/hooks/use-language';
import type { Language } from '@/lib/i18n';
import { MODES, THEMES, type Mode, type ThemeId } from '@/lib/themes';
import { cn } from '@/lib/utils';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * Appearance panel — light/dark mode + accent-color picker.
 *
 * Two independent controls: a mode toggle (light / dark) and the
 * accent grid. Either applies + persists immediately. No save button:
 * each change is a single attribute swap on <html>, there's nothing
 * to roll back.
 *
 * Persistence: localStorage only (device-scoped). The boot script in
 * layout.tsx replays both choices before first paint on subsequent
 * loads.
 */
export function AppearancePanel() {
  const { theme, setTheme, mode, setMode } = useTheme();
  const { language, setLanguage, t } = useLanguage();
  return (
    <section className="animate-in fade-in-50 max-w-3xl duration-200">
      <SettingsPanelHead
        title="Aparência"
        description={t(
          'Set the language, mode and accent color used across the system. Preferences are saved on this device.'
        )}
      />

      <div className="mb-8 space-y-4">
        <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <Languages className="text-muted-foreground size-4" />
          {t('Language')}
        </h3>
        <div
          role="radiogroup"
          aria-label={t('Language')}
          className="grid max-w-md grid-cols-2 gap-3"
        >
          <LanguageCard
            language="pt-BR"
            label="Português (Brasil)"
            isActive={language === 'pt-BR'}
            onPick={() => setLanguage('pt-BR')}
          />
          <LanguageCard
            language="en-US"
            label="English"
            isActive={language === 'en-US'}
            onPick={() => setLanguage('en-US')}
          />
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <SunMoon className="text-muted-foreground size-4" />
          {t('Mode')}
        </h3>

        <div
          role="radiogroup"
          aria-label={t('Color mode')}
          className="grid max-w-md grid-cols-2 gap-3"
        >
          {MODES.map((m) => (
            <ModeCard
              key={m}
              mode={m}
              isActive={m === mode}
              onPick={() => setMode(m)}
            />
          ))}
        </div>
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <Palette className="text-muted-foreground size-4" />
          {t('Accent color')}
        </h3>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEMES.map((th) => (
            <ThemeCard
              key={th.id}
              id={th.id}
              name={th.name}
              tagline={th.tagline}
              swatch={th.swatch}
              isActive={th.id === theme}
              onPick={() => setTheme(th.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function LanguageCard({
  language,
  label,
  isActive,
  onPick,
}: {
  language: Language;
  label: string;
  isActive: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      aria-checked={isActive}
      aria-label={label}
      className={cn(
        'bg-card flex items-center gap-3 rounded-lg border p-4 text-left transition-colors',
        isActive
          ? 'border-primary/60 ring-primary/40 ring-2'
          : 'border-border hover:bg-muted/40'
      )}
    >
      <span className="text-foreground flex-1 text-sm font-semibold">
        {label}
      </span>
      {isActive ? <Check className="text-primary size-4" /> : null}
      <span className="sr-only">{language}</span>
    </button>
  );
}

function ModeCard({
  mode,
  isActive,
  onPick,
}: {
  mode: Mode;
  isActive: boolean;
  onPick: () => void;
}) {
  const { t } = useLanguage();
  const isLight = mode === 'light';
  const Icon = isLight ? Sun : Moon;
  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      aria-checked={isActive}
      aria-label={isLight ? t('Use light mode') : t('Use dark mode')}
      className={cn(
        'bg-card flex items-center gap-3 rounded-lg border p-4 text-left transition-colors',
        isActive
          ? 'border-primary/60 ring-primary/40 ring-2'
          : 'border-border hover:border-border hover:bg-muted/40'
      )}
    >
      <span
        aria-hidden
        className="bg-muted text-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="text-foreground flex-1 text-sm font-semibold">
        {isLight ? t('Light') : t('Dark')}
      </span>
      {isActive && (
        <span className="bg-primary/15 text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
          <Check className="h-3 w-3" />
          {t('Active')}
        </span>
      )}
    </button>
  );
}

function ThemeCard({
  id,
  name,
  tagline,
  swatch,
  isActive,
  onPick,
}: {
  id: ThemeId;
  name: string;
  tagline: string;
  swatch: string;
  isActive: boolean;
  onPick: () => void;
}) {
  const { t } = useLanguage();
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={isActive}
      aria-label={`${t('Use theme')} ${name}`}
      className={cn(
        'bg-card flex flex-col gap-3 rounded-lg border p-4 text-left transition-colors',
        isActive
          ? 'border-primary/60 ring-primary/40 ring-2'
          : 'border-border hover:border-border hover:bg-muted/40'
      )}
    >
      <div className="flex items-center justify-between">
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 rounded-full"
          style={{
            background: swatch,
            boxShadow: 'inset 0 0 0 1px oklch(1 0 0 / 0.15)',
          }}
        />
        {isActive && (
          <span className="bg-primary/15 text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
            <Check className="h-3 w-3" />
            {t('Active')}
          </span>
        )}
      </div>
      <div>
        <div className="text-foreground text-sm font-semibold">{name}</div>
        <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
          {tagline}
        </div>
      </div>
      <div className="mt-1 flex h-2 overflow-hidden rounded-full" aria-hidden>
        <span className="flex-1" style={{ background: swatch }} />
        <span className="bg-muted-foreground/60 w-3" />
        <span className="bg-muted w-3" />
        <span className="bg-card w-3" />
      </div>
      <span className="sr-only">
        {t('Theme ID')}: {id}
      </span>
    </button>
  );
}
