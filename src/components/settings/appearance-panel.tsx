'use client';

import type { ReactNode } from 'react';
import { Check, Moon, Sun } from 'lucide-react';

import { useTheme } from '@/hooks/use-theme';
import { useLanguage } from '@/hooks/use-language';
import { MODES, THEMES } from '@/lib/themes';
import { cn } from '@/lib/utils';
import { SettingsGroup } from './settings-group';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * Appearance panel — language, light/dark mode and the accent (brand)
 * colour.
 *
 * Each control applies + persists immediately (no save button): every
 * change is a single attribute swap on <html>, nothing to roll back.
 * Persistence: localStorage only (device-scoped). The boot script in
 * layout.tsx replays the choices before first paint on later loads.
 */
export function AppearancePanel() {
  const { theme, setTheme, mode, setMode } = useTheme();
  const { language, setLanguage, t } = useLanguage();
  return (
    <section className="max-w-2xl">
      <SettingsPanelHead
        title="Aparência"
        description={t(
          'Set the language, mode and accent color used across the system. Preferences are saved on this device.'
        )}
      />

      <div className="space-y-8">
        <SettingsGroup title={t('Language')}>
          <Segmented label={t('Language')}>
            <SegmentedOption
              isActive={language === 'pt-BR'}
              onPick={() => setLanguage('pt-BR')}
              label="Português (Brasil)"
            >
              Português (Brasil)
            </SegmentedOption>
            <SegmentedOption
              isActive={language === 'en-US'}
              onPick={() => setLanguage('en-US')}
              label="English"
            >
              English
            </SegmentedOption>
          </Segmented>
        </SettingsGroup>

        <SettingsGroup title={t('Mode')}>
          <Segmented label={t('Color mode')}>
            {MODES.map((m) => {
              const isLight = m === 'light';
              const Icon = isLight ? Sun : Moon;
              return (
                <SegmentedOption
                  key={m}
                  isActive={m === mode}
                  onPick={() => setMode(m)}
                  label={isLight ? t('Use light mode') : t('Use dark mode')}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {isLight ? t('Light') : t('Dark')}
                </SegmentedOption>
              );
            })}
          </Segmented>
        </SettingsGroup>

        <SettingsGroup title={t('Accent color')}>
          <ul className="divide-y divide-border border-y border-border">
            {THEMES.map((th) => {
              const isActive = th.id === theme;
              return (
                <li key={th.id}>
                  <button
                    type="button"
                    onClick={() => setTheme(th.id)}
                    aria-pressed={isActive}
                    aria-label={`${t('Use theme')} ${t(th.name)}`}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2.5 text-left',
                      'transition-colors duration-150 motion-reduce:transition-none',
                      'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      isActive
                        ? 'bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]'
                        : 'hover:bg-muted/50'
                    )}
                  >
                    <span
                      aria-hidden
                      className="size-4 shrink-0 rounded-full"
                      style={{
                        background: th.swatch,
                        boxShadow: 'inset 0 0 0 1px oklch(1 0 0 / 0.15)',
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block text-sm text-foreground',
                          isActive && 'font-semibold'
                        )}
                      >
                        {t(th.name)}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t(th.tagline)}
                      </span>
                    </span>
                    {isActive ? (
                      <Check className="size-4 shrink-0 text-primary" aria-hidden />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </SettingsGroup>
      </div>
    </section>
  );
}

/** Inline segmented control: a radiogroup of two or three short choices. */
function Segmented({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1"
    >
      {children}
    </div>
  );
}

function SegmentedOption({
  isActive,
  onPick,
  label,
  children,
}: {
  isActive: boolean;
  onPick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={isActive}
      aria-label={label}
      onClick={onPick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm',
        'transition-colors duration-150 motion-reduce:transition-none',
        'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        isActive
          ? 'bg-background font-medium text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
