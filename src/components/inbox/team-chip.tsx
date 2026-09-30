"use client";

import { Check } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { cn } from "@/lib/utils";
import { teamCopy, type Team } from "@/lib/support/teams";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const CHIP =
  "inline-flex h-5 max-w-36 shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 text-[11px] leading-4 text-muted-foreground";

interface TeamChipProps {
  teamId: string | null | undefined;
  /** Pickable (non-archived) teams. */
  teams: Team[];
  /** Every team, archived included, so an old choice still shows its name. */
  byId: ReadonlyMap<string, Team>;
  /** Agent+ changes the team; viewers read. */
  canEdit: boolean;
  onChange: (teamId: string | null) => void;
}

/** The conversation's team: a small text chip, an editable popover for agents. */
export function TeamChip({ teamId, teams, byId, canEdit, onChange }: TeamChipProps) {
  const { language } = useLanguage();
  const copy = teamCopy(language);
  const team = teamId ? byId.get(teamId) : undefined;
  const label = <span className="truncate">{team?.name ?? copy.team}</span>;

  if (!canEdit) return team ? <span data-no-translate data-testid="team-chip" className={CHIP}>{label}</span> : null;
  return (
    <Popover>
      <PopoverTrigger
        data-no-translate
        data-testid="team-chip"
        aria-label={copy.team}
        title={copy.team}
        className={cn(CHIP, "transition-colors hover:bg-muted/70 hover:text-foreground", !team && "opacity-70")}
      >
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 gap-0.5 p-1.5">
        {teams.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={t.id === teamId}
            onClick={() => onChange(t.id)}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-popover-foreground hover:bg-muted"
          >
            <span className="flex-1 truncate">{t.name}</span>
            {t.id === teamId && <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          </button>
        ))}
        {teamId && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex h-8 w-full items-center rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-muted"
          >
            {copy.noTeam}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
