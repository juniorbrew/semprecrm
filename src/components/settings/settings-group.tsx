import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Small muted uppercase heading — the same one the inbox contact panel
 * and the contact page tabs use. Exported so a panel can title a block
 * that is not a full group (e.g. a list header).
 */
export const SETTINGS_HEADING =
  'text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground';

/**
 * Quiet destructive text button (pair with `<Button variant="ghost">`):
 * no fill, red text, a faint red wash on hover. For the actions that live
 * below the hairline at the bottom of a section.
 */
export const DANGER_TEXT_BUTTON =
  'text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/15';

/**
 * A headed group inside a settings panel: heading, optional one-line
 * description, content. Groups are separated by whitespace and a single
 * hairline, never boxed (no card-in-card).
 */
export function SettingsGroup({
  title,
  description,
  action,
  children,
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        'space-y-4 border-t border-border pt-6 first:border-t-0 first:pt-0',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className={cn(SETTINGS_HEADING, 'flex items-center gap-1.5')}>
            {title}
          </h3>
          {description ? (
            <p className="mt-1.5 max-w-[62ch] text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Destructive actions of a section, kept apart at the bottom below a
 * hairline. Children are quiet text buttons (`DANGER_TEXT_BUTTON`), each
 * optionally with one line of muted explanation beside it.
 */
export function SettingsDangerZone({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('mt-8 space-y-3 border-t border-border pt-6', className)}
    >
      <h3 className={SETTINGS_HEADING}>{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
