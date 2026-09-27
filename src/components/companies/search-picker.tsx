'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';

/**
 * Type-to-search list, rendered inline (no portal) so it works inside
 * sheets and dialogs without fighting their focus traps. Debounced;
 * the newest query wins. Arrow keys move, Enter picks, Esc cancels.
 */
export function SearchPicker<T>({
  search,
  getKey,
  renderItem,
  onPick,
  onCancel,
  placeholder,
  emptyLabel,
  excludeKeys,
  autoFocus = true,
  footer,
  ariaLabel,
}: {
  search: (term: string) => Promise<T[]>;
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  onPick: (item: T) => void;
  onCancel?: () => void;
  placeholder: string;
  emptyLabel: string;
  /** Items already chosen (e.g. companies the contact is linked to). */
  excludeKeys?: ReadonlySet<string>;
  autoFocus?: boolean;
  /** Extra row under the results (e.g. "Create company"). */
  footer?: React.ReactNode;
  ariaLabel: string;
}) {
  const { t } = useLanguage();
  const listId = useId();
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });

  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      setLoading(true);
      searchRef
        .current(term)
        .then((rows) => {
          if (mine !== seq.current) return;
          setItems(rows);
          setFailed(false);
          setActive(0);
        })
        .catch(() => {
          if (mine !== seq.current) return;
          setItems([]);
          setFailed(true);
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [term]);

  const visible = excludeKeys ? items.filter((i) => !excludeKeys.has(getKey(i))) : items;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(visible.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = visible[active];
      if (item) onPick(item);
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="relative border-b border-border/60 p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          autoFocus={autoFocus}
          className="h-8 border-border bg-muted pl-7 text-sm text-foreground"
        />
      </div>
      <ul id={listId} role="listbox" aria-label={ariaLabel} className="max-h-56 overflow-y-auto p-1">
        {loading && visible.length === 0 ? (
          <li className="flex items-center justify-center py-4 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-label={t('Loading...')} />
          </li>
        ) : visible.length === 0 ? (
          <li className="px-2 py-3 text-center text-xs text-muted-foreground">
            {failed ? t('Something went wrong. Please try again.') : emptyLabel}
          </li>
        ) : (
          visible.map((item, i) => (
            <li
              key={getKey(item)}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(item)}
              className={cn(
                'cursor-pointer rounded-md px-2 py-1.5 text-sm',
                i === active ? 'bg-muted text-foreground' : 'text-foreground/90',
              )}
            >
              {renderItem(item)}
            </li>
          ))
        )}
      </ul>
      {footer ? <div className="border-t border-border/60 p-1">{footer}</div> : null}
    </div>
  );
}
