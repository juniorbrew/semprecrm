import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Small status / role marker used across settings (Overview, WhatsApp,
 * calendar, plan, members).
 *
 * Status (`ok`, `warn`, `bad`) reads as a dot + text, never a coloured
 * pill: the dot carries the colour, the text stays readable. Roles keep a
 * soft pill (`admin` brand-tinted, `owner` amber) and `muted` is the
 * neutral count pill. Emerald/amber/red are semantic accents, so they are
 * intentionally not tokenized; neutrals stay on design tokens.
 */
export type ChipVariant = 'owner' | 'admin' | 'ok' | 'warn' | 'bad' | 'muted';

const PILLS: Partial<Record<ChipVariant, string>> = {
  owner: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
  admin: 'bg-primary/10 text-primary',
  muted: 'bg-muted text-muted-foreground',
};

const DOT_TONE: Partial<Record<ChipVariant, StatusTone>> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
};

export function SettingsChip({
  variant = 'muted',
  className,
  children,
}: {
  variant?: ChipVariant;
  className?: string;
  children: ReactNode;
}) {
  const tone = DOT_TONE[variant];
  if (tone) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap text-foreground [&_svg]:size-3.5',
          className,
        )}
      >
        <StatusDot tone={tone} />
        {children}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap [&_svg]:size-3',
        PILLS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

type StatusTone = 'ok' | 'warn' | 'bad' | 'muted';

const DOT: Record<StatusTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  muted: 'bg-muted-foreground',
};

/** A small status dot; always next to text (status is never colour only). */
export function StatusDot({
  tone = 'ok',
  className,
}: {
  tone?: StatusTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-1.5 shrink-0 rounded-full', DOT[tone], className)}
    />
  );
}
