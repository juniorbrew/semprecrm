"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/hooks/use-language";
import type { CalendarContactRef } from "@/lib/calendar";
import { Input } from "@/components/ui/input";

/**
 * Search a contact by name / phone and show the pick as a chip. Same
 * behaviour as the tasks drawer's picker, kept local so the calendar
 * does not depend on the tasks module being on.
 */
export function ContactPicker({
  contact,
  disabled,
  onChange,
  compact,
}: {
  contact: CalendarContactRef | null;
  disabled?: boolean;
  onChange: (contact: CalendarContactRef | null) => void;
  compact?: boolean;
}) {
  const { t } = useLanguage();
  const supabase = useMemo(() => createClient(), []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CalendarContactRef[]>([]);
  const [openList, setOpenList] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    timer.current = setTimeout(async () => {
      if (!q) {
        setResults([]);
        return;
      }
      const like = `%${q.replace(/[%_,]/g, " ")}%`;
      const { data } = await supabase
        .from("contacts")
        .select("id, name, phone, avatar_url")
        .or(`name.ilike.${like},phone.ilike.${like}`)
        .order("name")
        .limit(8);
      setResults((data ?? []) as CalendarContactRef[]);
    }, 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, supabase]);

  const h = compact ? "h-7 text-xs" : "h-8 text-sm";

  if (contact) {
    return (
      <div className={`flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 text-foreground ${h}`}>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
          {(contact.name || contact.phone).charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate">{contact.name || contact.phone}</span>
        {contact.name && !compact && (
          <span className="hidden text-xs text-muted-foreground sm:inline">{contact.phone}</span>
        )}
        {!disabled && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={t("Unlink")}
            title={t("Unlink")}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        disabled={disabled}
        placeholder={t("Search contact by name or phone")}
        aria-label={t("Contact")}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpenList(true);
        }}
        onFocus={() => setOpenList(true)}
        onBlur={() => setTimeout(() => setOpenList(false), 120)}
        className={`border-border bg-muted pl-8 text-foreground ${compact ? "h-7 text-xs md:text-xs" : ""}`}
      />
      {openList && results.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(c);
                  setQuery("");
                  setResults([]);
                  setOpenList(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
                  {(c.name || c.phone).charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.name || c.phone}</span>
                {c.name && <span className="text-xs text-muted-foreground">{c.phone}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
