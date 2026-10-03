import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Small muted uppercase section title — same as the inbox contact panel. */
export const SECTION_TITLE = 'text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground';

/** Selectable option row (template, audience): soft brand tint + 3 px accent when chosen. */
export function optionRowClass(selected: boolean): string {
  return cn(
    'flex w-full items-start gap-3 px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none',
    selected ? 'bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]' : 'hover:bg-muted/50',
  );
}

/** Toggle pill (tags): `bg-primary/15 text-primary` when on, neutral otherwise. */
export function pillClass(on: boolean, tone: 'primary' | 'danger' = 'primary'): string {
  return cn(
    'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
    !on
      ? 'bg-muted text-muted-foreground hover:text-foreground'
      : tone === 'danger'
        ? 'bg-red-500/15 text-red-700 dark:text-red-300'
        : 'bg-primary/15 text-primary',
  );
}

/** Step title + one supporting line. */
export function StepHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

/** Footer on a hairline: secondary actions left/middle, the one filled action last. */
export function StepFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">{children}</div>;
}

export interface WizardStep {
  key: string;
  label: string;
}

/**
 * Hairline stepper: numbered steps on one line, the current one underlined
 * with a 2 px brand accent, finished ones with a check. Not clickable —
 * each step's own Back/Next moves (they validate).
 */
export function WizardStepper({ steps, current, label }: { steps: readonly WizardStep[]; current: number; label: string }) {
  return (
    <ol aria-label={label} className="flex border-b border-border">
      {steps.map((step, index) => {
        const active = index === current;
        const done = index < current;
        return (
          <li
            key={step.key}
            aria-current={active ? 'step' : undefined}
            className={cn(
              '-mb-px flex min-w-0 items-center gap-2 border-b-2 pb-2.5 pr-3 text-sm transition-colors duration-200 motion-reduce:transition-none sm:flex-1',
              active ? 'flex-1 border-primary font-medium text-foreground' : 'flex-none border-transparent text-muted-foreground',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums',
                active ? 'bg-primary text-primary-foreground' : done ? 'bg-primary/15 text-primary' : 'bg-muted',
              )}
            >
              {done ? <Check className="size-3" /> : index + 1}
            </span>
            <span className={cn('truncate', !active && 'hidden sm:inline')}>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
