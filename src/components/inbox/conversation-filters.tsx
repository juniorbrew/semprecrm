"use client";

import { useEffect, useState } from "react";
import { ListFilter, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import type { WhatsAppChannel } from "@/types";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface FacetTag {
  id: string;
  name: string;
  color: string;
}

/**
 * Tags of the account + whether both WhatsApp transports are set up (the
 * channel filter only makes sense then). One light fetch per account; a
 * failure just hides the corresponding control.
 */
export function useInboxFacets(accountId: string | null) {
  const [tags, setTags] = useState<FacetTag[]>([]);
  const [hasBothChannels, setHasBothChannels] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const [tagRes, official, qr] = await Promise.all([
        supabase.from("tags").select("id, name, color").eq("account_id", accountId).order("name"),
        supabase.from("whatsapp_config").select("account_id").eq("account_id", accountId).maybeSingle(),
        supabase.from("wa_qr_sessions").select("account_id").eq("account_id", accountId).maybeSingle(),
      ]);
      if (cancelled) return;
      if (!tagRes.error) setTags((tagRes.data ?? []) as FacetTag[]);
      setHasBothChannels(!!official.data && !!qr.data);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return { tags, hasBothChannels, loaded };
}

const CHANNELS: WhatsAppChannel[] = ["official", "qr"];

export function channelLabel(channel: WhatsAppChannel, t: (s: string) => string): string {
  return channel === "qr" ? t("QR") : t("Official");
}

interface FilterPopoverProps {
  tags: FacetTag[];
  hasBothChannels: boolean;
  tagIds: string[];
  channel: WhatsAppChannel | null;
  onTagsChange: (ids: string[]) => void;
  onChannelChange: (channel: WhatsAppChannel | null) => void;
}

/** Header button + popover: multi-select tags and (when both exist) the channel. */
export function FilterPopover({
  tags,
  hasBothChannels,
  tagIds,
  channel,
  onTagsChange,
  onChannelChange,
}: FilterPopoverProps) {
  const { t } = useLanguage();
  const active = tagIds.length + (channel ? 1 : 0);
  if (tags.length === 0 && !hasBothChannels) return null;

  const toggle = (id: string) =>
    onTagsChange(tagIds.includes(id) ? tagIds.filter((x) => x !== id) : [...tagIds, id]);

  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("Filters")}
        title={t("Filters")}
        data-testid="inbox-filter-button"
        className={cn(
          "relative inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors",
          active > 0
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <ListFilter className="h-3.5 w-3.5" />
        {active > 0 && (
          <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold text-primary-foreground">
            {active}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        {tags.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("Tags")}
            </p>
            <div className="max-h-48 overflow-y-auto">
              {tags.map((tag) => (
                <label
                  key={tag.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted"
                >
                  <Checkbox
                    checked={tagIds.includes(tag.id)}
                    onCheckedChange={() => toggle(tag.id)}
                    aria-label={tag.name}
                  />
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="truncate">{tag.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {hasBothChannels && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              WhatsApp
            </p>
            <div className="flex gap-1" role="group" aria-label="WhatsApp">
              {[null, ...CHANNELS].map((value) => (
                <button
                  key={value ?? "all"}
                  type="button"
                  aria-pressed={channel === value}
                  onClick={() => onChannelChange(value)}
                  className={cn(
                    "h-7 flex-1 rounded-md border text-xs font-medium transition-colors",
                    channel === value
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border text-foreground hover:bg-muted",
                  )}
                >
                  {value ? channelLabel(value, t) : t("Both")}
                </button>
              ))}
            </div>
          </div>
        )}
        {active > 0 && (
          <button
            type="button"
            onClick={() => {
              onTagsChange([]);
              onChannelChange(null);
            }}
            className="self-start text-xs font-medium text-primary hover:underline"
          >
            {t("Clear filters")}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Removable chips for the active tag / channel filters. */
export function FilterChips({
  tags,
  tagIds,
  channel,
  onTagsChange,
  onChannelChange,
}: Pick<FilterPopoverProps, "tags" | "tagIds" | "channel" | "onTagsChange" | "onChannelChange">) {
  const { t } = useLanguage();
  if (tagIds.length === 0 && !channel) return null;
  const chip =
    "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 pl-2 pr-1 text-[11px] font-medium text-primary";
  return (
    <div
      className="mt-2 flex items-center gap-1.5 overflow-x-auto px-3 [scrollbar-width:none]"
      data-testid="inbox-filter-chips"
      data-no-translate
    >
      {tagIds.map((id) => {
        const tag = tags.find((x) => x.id === id);
        const name = tag?.name ?? t("Tag");
        return (
          <span key={id} className={chip}>
            <span className="max-w-24 truncate">{name}</span>
            <button
              type="button"
              aria-label={`${t("Remove filter")}: ${name}`}
              onClick={() => onTagsChange(tagIds.filter((x) => x !== id))}
              className="rounded-full p-0.5 hover:bg-primary/20"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      {channel && (
        <span className={chip}>
          <span>{channelLabel(channel, t)}</span>
          <button
            type="button"
            aria-label={`${t("Remove filter")}: ${channelLabel(channel, t)}`}
            onClick={() => onChannelChange(null)}
            className="rounded-full p-0.5 hover:bg-primary/20"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  );
}
