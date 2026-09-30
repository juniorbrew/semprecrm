"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { useConversationCategories } from "@/hooks/use-conversation-categories";
import { notifyTeamsChanged, useTeams } from "@/hooks/use-teams";
import { createClient } from "@/lib/supabase/client";
import { CATEGORY_DOT, PRIORITIES, supportCopy } from "@/lib/support/model";
import {
  TEAM_LIMITS,
  TeamNameTakenError,
  createTeam,
  listRoutingRules,
  listTeamMembers,
  setRoutingRule,
  setTeamMembers,
  teamCopy,
  updateTeam,
  type RoutingRule,
  type Team,
} from "@/lib/support/teams";
import type { ConversationPriority } from "@/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./settings-group";

interface Person {
  user_id: string;
  full_name: string | null;
}

/** Members an account can put on a team: everyone who can answer conversations. */
function useAssignablePeople(accountId: string | null): Person[] {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("user_id, full_name, account_role")
      .eq("account_id", accountId)
      .in("account_role", ["owner", "admin", "agent"])
      .order("full_name")
      .then(({ data }) => {
        if (!cancelled) setPeople(((data ?? []) as Person[]).map((p) => ({ user_id: p.user_id, full_name: p.full_name })));
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  return people;
}

const nameOf = (p: Person) => p.full_name?.trim() || "—";

/** Settings → Suporte → Equipes: a plain list; each row edits its name and its people. */
export function TeamsSettings({ readOnly }: { readOnly: boolean }) {
  const { language } = useLanguage();
  const copy = teamCopy(language);
  const shared = supportCopy(language);
  const { accountId } = useAuth();
  const { active, all, refresh } = useTeams();
  const people = useAssignablePeople(accountId);
  const [members, setMembers] = useState<Map<string, string[]>>(new Map());
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const archived = useMemo(() => all.filter((t) => t.archived_at), [all]);
  const [showArchived, setShowArchived] = useState(false);

  const reloadMembers = useCallback(async () => {
    if (!accountId) return;
    try {
      setMembers(await listTeamMembers(createClient(), accountId));
    } catch (err) {
      console.error(err);
    }
  }, [accountId]);

  useEffect(() => {
    void reloadMembers();
  }, [reloadMembers]);

  async function patch(id: string, changes: { name?: string; archived?: boolean }) {
    try {
      await updateTeam(createClient(), id, changes);
      notifyTeamsChanged();
    } catch (err) {
      toast.error(err instanceof TeamNameTakenError ? copy.taken : shared.saveFailed);
    }
    refresh();
  }

  async function handleAdd() {
    if (!accountId || !newName.trim()) return;
    setAdding(true);
    try {
      await createTeam(createClient(), accountId, newName);
      setNewName("");
      notifyTeamsChanged();
      refresh();
    } catch (err) {
      toast.error(err instanceof TeamNameTakenError ? copy.taken : shared.saveFailed);
    } finally {
      setAdding(false);
    }
  }

  async function saveMembers(team: Team, next: string[]) {
    if (!accountId) return;
    try {
      await setTeamMembers(createClient(), accountId, team.id, members.get(team.id) ?? [], next);
    } catch (err) {
      console.error(err);
      toast.error(shared.saveFailed);
    }
    await reloadMembers();
  }

  return (
    <SettingsGroup title={copy.teams} description={copy.teamsHint}>
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.teamsEmpty}</p>
      ) : (
        <ul className="max-w-2xl divide-y divide-border border-y border-border">
          {active.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              people={people}
              memberIds={members.get(team.id) ?? []}
              readOnly={readOnly}
              onRename={(name) => void patch(team.id, { name })}
              onArchive={() => void patch(team.id, { archived: true })}
              onMembers={(next) => void saveMembers(team, next)}
            />
          ))}
        </ul>
      )}

      {!readOnly && (
        <form
          className="flex max-w-2xl items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleAdd();
          }}
        >
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={copy.teamName}
            aria-label={copy.teamName}
            maxLength={TEAM_LIMITS.name}
            className="h-8 max-w-64 text-sm"
          />
          <Button type="submit" size="sm" variant="outline" disabled={adding || !newName.trim()}>
            {copy.addTeam}
          </Button>
        </form>
      )}
      {readOnly && <p className="text-xs text-muted-foreground">{copy.readOnly}</p>}

      {archived.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {copy.archive} ({archived.length})
          </button>
          {showArchived && (
            <ul className="mt-2 max-w-2xl">
              {archived.map((team) => (
                <li key={team.id} className="flex items-center gap-2 py-1.5 text-sm text-muted-foreground">
                  <span className="flex-1 truncate">{team.name}</span>
                  {!readOnly && (
                    <Button type="button" variant="ghost" size="xs" onClick={() => void patch(team.id, { archived: false })}>
                      {copy.restore}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}

function TeamRow({
  team,
  people,
  memberIds,
  readOnly,
  onRename,
  onArchive,
  onMembers,
}: {
  team: Team;
  people: Person[];
  memberIds: string[];
  readOnly: boolean;
  onRename: (name: string) => void;
  onArchive: () => void;
  onMembers: (next: string[]) => void;
}) {
  const { language } = useLanguage();
  const copy = teamCopy(language);
  const [name, setName] = useState(team.name);
  useEffect(() => {
    // Mirror the server value after a reload (e.g. a rejected rename).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(team.name);
  }, [team.name]);

  return (
    <li className="flex items-center gap-3 py-2">
      <Input
        value={name}
        disabled={readOnly}
        maxLength={TEAM_LIMITS.name}
        aria-label={copy.teamName}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const next = name.trim();
          if (!next) setName(team.name);
          else if (next !== team.name) onRename(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 text-sm font-medium shadow-none hover:border-border focus:border-border"
      />
      <Popover>
        <PopoverTrigger
          disabled={readOnly}
          aria-label={`${copy.chooseMembers}: ${team.name}`}
          className="h-8 shrink-0 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none"
        >
          {copy.members(memberIds.length)}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 gap-0.5 p-1.5">
          {people.map((p) => (
            <label
              key={p.user_id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            >
              <Checkbox
                checked={memberIds.includes(p.user_id)}
                onCheckedChange={(on) =>
                  onMembers(on ? [...memberIds, p.user_id] : memberIds.filter((id) => id !== p.user_id))
                }
                aria-label={nameOf(p)}
              />
              <span className="truncate">{nameOf(p)}</span>
            </label>
          ))}
        </PopoverContent>
      </Popover>
      {!readOnly && (
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={onArchive}>
          {copy.archive}
        </Button>
      )}
    </li>
  );
}

/** Settings → Suporte → Encaminhamento: one line per category, a team select and an optional minimum priority. */
export function RoutingSettings({ readOnly }: { readOnly: boolean }) {
  const { language } = useLanguage();
  const copy = teamCopy(language);
  const shared = supportCopy(language);
  const { accountId } = useAuth();
  const { active: categories } = useConversationCategories();
  const { active: teams } = useTeams();
  const [rules, setRules] = useState<RoutingRule[]>([]);

  const reload = useCallback(async () => {
    if (!accountId) return;
    try {
      setRules(await listRoutingRules(createClient(), accountId));
    } catch (err) {
      console.error(err);
    }
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  async function save(categoryId: string, teamId: string | null, priorityMin: ConversationPriority | null) {
    if (!accountId) return;
    try {
      await setRoutingRule(createClient(), accountId, categoryId, teamId, priorityMin);
    } catch (err) {
      console.error(err);
      toast.error(shared.saveFailed);
    }
    await reload();
  }

  return (
    <SettingsGroup title={copy.routing} description={copy.routingHint}>
      {categories.length === 0 || teams.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.routingEmpty}</p>
      ) : (
        <ul className="max-w-2xl divide-y divide-border border-y border-border">
          {categories.map((cat) => {
            const rule = rules.find((r) => r.category_id === cat.id);
            return (
              <li key={cat.id} data-testid={`routing-row-${cat.id}`} className="flex items-center gap-3 py-2">
                <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground">
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", CATEGORY_DOT[cat.color])} aria-hidden />
                  <span className="truncate">{cat.name}</span>
                </span>
                {rule && (
                  <select
                    value={rule.priority_min ?? ""}
                    disabled={readOnly}
                    aria-label={`${copy.routingMin}: ${cat.name}`}
                    onChange={(e) => void save(cat.id, rule.team_id, (e.target.value || null) as ConversationPriority | null)}
                    className="h-8 rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground disabled:opacity-60"
                  >
                    <option value="">{copy.routingAnyPriority}</option>
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {`${copy.routingMin} ${shared.priorities[p].toLowerCase()}`}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  value={rule?.team_id ?? ""}
                  disabled={readOnly}
                  aria-label={`${copy.team}: ${cat.name}`}
                  onChange={(e) => void save(cat.id, e.target.value || null, rule?.priority_min ?? null)}
                  className="h-8 w-40 rounded-md border border-border bg-transparent px-2 text-sm text-foreground disabled:opacity-60"
                >
                  <option value="">{copy.routingNone}</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}
      {readOnly && <p className="text-xs text-muted-foreground">{copy.readOnly}</p>}
    </SettingsGroup>
  );
}
