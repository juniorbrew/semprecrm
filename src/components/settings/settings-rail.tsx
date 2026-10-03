'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';
import {
  RAIL_GROUPS,
  SECTION_META,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from './settings-sections';

// Width at/above which the rail is a vertical column (already in view, so
// no auto-scroll needed). Mirrors the Tailwind `lg:` breakpoint that
// drives the rowâ†’column switch in the markup below â€” keep the two in sync.
const RAIL_DESKTOP_MIN_PX = 1024;

/**
 * The settings left rail â€” grouped, vertical on desktop and a
 * horizontal scroller on narrow screens (mirrors the mockup's â‰¤920px
 * behaviour). The active item auto-scrolls into view when the rail is
 * horizontal so a deep-linked section is never off-screen.
 */
export function SettingsRail({
  active,
  onSelect,
  hints,
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  hints?: Partial<Record<SettingsSection, ReactNode>>;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const { canManageMembers } = useAuth();
  const entitlements = useEntitlements();
  const { language } = useLanguage();

  // When horizontal (mobile), keep the active chip in view. On desktop
  // the rail is a static column, so skip.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia(`(min-width: ${RAIL_DESKTOP_MIN_PX}px)`).matches) return;
    activeRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [active]);

  return (
    <nav
      aria-label={language === 'en-US' ? 'Settings sections' : 'Seções das configurações'}
      className={cn(
        'flex gap-1 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'border-b border-border',
        'lg:sticky lg:top-0 lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0',
      )}
    >
      {RAIL_GROUPS.map(({ label, group }) => {
        const items = SETTINGS_SECTIONS.filter((s) => {
          const meta = SECTION_META[s];
          if (meta.group !== group) return false;
          if (meta.adminOnly && !canManageMembers) return false;
          if (meta.module && entitlements.ready && !entitlements.modules[meta.module]) return false;
          return true;
        });
        return (
          <div
            key={group}
            className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5"
          >
            {label ? (
              <div className="hidden px-2.5 pt-3.5 pb-[5px] text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase lg:block">
                {label}
              </div>
            ) : null}
            {items.map((s) => {
              const meta = SECTION_META[s];
              const Icon = meta.icon;
              const isActive = s === active;
              return (
                <button
                  key={s}
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  onClick={() => onSelect(s)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'group/item flex shrink-0 items-center gap-2.5 rounded-[calc(var(--radius)-2px)] px-2.5 py-2 text-left text-sm whitespace-nowrap',
                    'transition-colors duration-150 motion-reduce:transition-none',
                    'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                    'lg:w-full',
                    isActive
                      ? 'bg-primary/10 font-semibold text-foreground shadow-[inset_0_-2px_0_var(--primary)] lg:shadow-[inset_2px_0_0_var(--primary)]'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon
                    className={cn(
                      'size-4 shrink-0',
                      isActive ? 'text-primary' : 'opacity-70',
                    )}
                  />
                  <span className="flex-1">{meta.label}</span>
                  {hints?.[s] != null ? (
                    <span className="hidden items-center gap-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground lg:inline-flex">
                      {hints[s]}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
