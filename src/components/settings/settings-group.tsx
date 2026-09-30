import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

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
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'space-y-4 border-t border-border pt-6 first:border-t-0 first:pt-0',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          {description ? (
            <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
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
