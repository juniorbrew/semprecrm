"use client";

import { useEffect, useState } from "react";
import { ListFilter, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import type { ConversationPriority, WhatsAppChannel } from "@/types";
import { CATEGORY_DOT, PRIORITIES, PRIORITY_DOT, supportCopy, type ConversationCategory } from "@/lib/support/model";
import { slaCopy } from "@/lib/support/sla";
import { teamCopy, type Team } from "@/lib/support/teams";
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
  /** Support filters (migration 071); the sections show once the account has categories. */
  categories?: ConversationCategory[];
  categoryId?: string | null;
  priority?: ConversationPriority | null;
  onCategoryChange?: (id: string | null) => void;
  onPriorityChange?: (priority: ConversationPriority | null) => void;
  /** Teams (migration 073): the section shows once the account has any. */
  teams?: Team[];
  teamId?: string | null;
  onTeamChange?: (id: string | null) => void;
  /** SLA (migration 072): offered only when the account has deadlines. */
  slaEnabled?: boolean;
  slaBreached?: boolean;
  onSlaBreachedChange?: (on: boolean) => void;
}

/** Header button + popover: multi-select tags and (when both exist) the channel. */
export function FilterPopover({
  tags,
  hasBothChannels,
  tagIds,
  channel,
  onTagsChange,
  onChannelChange,
  categories = [],
  categoryId = null,
  priority = null,
  onCategoryChange,
  onPriorityChange,
  teams = [],
  teamId = null,
  onTeamChange,
  slaEnabled = false,
  slaBreached = false,
  onSlaBreachedChange,
}: FilterPopoverProps) {
  const { t, language } = useLanguage();
  const support = supportCopy(language);
  const teamText = teamCopy(language);
  const slaText = slaCopy(language);
  const showSupport = categories.length > 0 && !!onCategoryChange && !!onPriorityChange;
  const showTeams = teams.length > 0 && !!onTeamChange;
  const showSla = slaEnabled && !!onSlaBreachedChange;
  const active =
    tagIds.length + (channel ? 1 : 0) + (categoryId ? 1 : 0) + (priority ? 1 : 0) + (teamId ? 1 : 0) + (slaBreached ? 1 : 0);
  if (tags.length === 0 && !hasBothChannels && !showSupport && !showTeams && !showSla) return null;

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
        {showSupport && (
          <div data-no-translate className="space-y-3">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">{support.category}</p>
              <div className="max-h-40 overflow-y-auto">
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    aria-pressed={categoryId === cat.id}
                    onClick={() => onCategoryChange?.(categoryId === cat.id ? null : cat.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-muted",
                      categoryId === cat.id && "text-primary",
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", CATEGORY_DOT[cat.color])} aria-hidden />
                    <span className="truncate">{cat.name}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">{support.priority}</p>
              <div className="flex flex-wrap gap-1" role="group" aria-label={support.priority}>
                {PRIORITIES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={priority === value}
                    onClick={() => onPriorityChange?.(priority === value ? null : value)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
                      priority === value
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border text-foreground hover:bg-muted",
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", PRIORITY_DOT[value])} aria-hidden />
                    {support.priorities[value]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {(showTeams || showSla) && (
          <div data-no-translate className="space-y-3">
            {showTeams && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{teamText.filterTeam}</p>
                <div className="max-h-40 overflow-y-auto">
                  {teams.map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      aria-pressed={teamId === team.id}
                      onClick={() => onTeamChange?.(teamId === team.id ? null : team.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-muted",
                        teamId === team.id && "text-primary",
                      )}
                    >
                      <span className="truncate">{team.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {showSla && (
              <button
                type="button"
                aria-pressed={slaBreached}
                onClick={() => onSlaBreachedChange?.(!slaBreached)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
                  slaBreached ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-foreground hover:bg-muted",
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
                {slaText.breachedFilter}
              </button>
            )}
          </div>
        )}
        {active > 0 && (
          <button
            type="button"
            onClick={() => {
              onTagsChange([]);
              onChannelChange(null);
              onCategoryChange?.(null);
              onPriorityChange?.(null);
              onTeamChange?.(null);
              onSlaBreachedChange?.(false);
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
  categories = [],
  categoryId = null,
  priority = null,
  onCategoryChange,
  onPriorityChange,
  teams = [],
  teamId = null,
  onTeamChange,
  slaBreached = false,
  onSlaBreachedChange,
}: Pick<
  FilterPopoverProps,
  | "tags"
  | "tagIds"
  | "channel"
  | "onTagsChange"
  | "onChannelChange"
  | "categories"
  | "categoryId"
  | "priority"
  | "onCategoryChange"
  | "onPriorityChange"
  | "teams"
  | "teamId"
  | "onTeamChange"
  | "slaBreached"
  | "onSlaBreachedChange"
>) {
  const { t, language } = useLanguage();
  const support = supportCopy(language);
  const slaText = slaCopy(language);
  const category = categoryId ? categories.find((c) => c.id === categoryId) : null;
  const team = teamId ? teams.find((x) => x.id === teamId) : null;
  if (tagIds.length === 0 && !channel && !category && !priority && !team && !slaBreached) return null;
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
      {category && (
        <span className={chip}>
          <span className="max-w-24 truncate">{category.name}</span>
          <button
            type="button"
            aria-label={`${t("Remove filter")}: ${category.name}`}
            onClick={() => onCategoryChange?.(null)}
            className="rounded-full p-0.5 hover:bg-primary/20"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
      {team && (
        <span className={chip}>
          <span className="max-w-24 truncate">{team.name}</span>
          <button
            type="button"
            aria-label={`${t("Remove filter")}: ${team.name}`}
            onClick={() => onTeamChange?.(null)}
            className="rounded-full p-0.5 hover:bg-primary/20"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
      {slaBreached && (
        <span className={chip}>
          <span>{slaText.breachedFilter}</span>
          <button
            type="button"
            aria-label={`${t("Remove filter")}: ${slaText.breachedFilter}`}
            onClick={() => onSlaBreachedChange?.(false)}
            className="rounded-full p-0.5 hover:bg-primary/20"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
      {priority && (
        <span className={chip}>
          <span>{support.priorities[priority]}</span>
          <button
            type="button"
            aria-label={`${t("Remove filter")}: ${support.priorities[priority]}`}
            onClick={() => onPriorityChange?.(null)}
            className="rounded-full p-0.5 hover:bg-primary/20"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
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
