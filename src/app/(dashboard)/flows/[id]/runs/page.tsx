"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Loader2,
  CircleCheck,
  CircleAlert,
  Clock,
  UserPlus,
  PlayCircle,
  PauseCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceStrict } from "date-fns";
import { ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";

/**
 * Run history viewer.
 *
 * Lists the 50 most recent runs for a flow, newest first. Each row
 * collapses to a one-liner (contact + status + time); expanding shows
 * the full `flow_run_events` timeline for that run — useful for
 * debugging "why didn't my flow advance?" by surfacing the engine's
 * own log.
 */

interface RunRow {
  id: string;
  status:
    | "active"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "paused_by_agent"
    | "failed";
  current_node_key: string | null;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  contact: { id: string; name: string | null; phone: string } | null;
}

interface EventRow {
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

/** Run status labels — "execução" is feminine, so pt-BR can't reuse
 *  the generic masculine Active/Completed entries. */
const STATUS_LABEL: Record<Language, Record<RunRow["status"], string>> = {
  "pt-BR": {
    active: "Ativa",
    completed: "Concluída",
    handed_off: "Transferida",
    timed_out: "Expirada",
    paused_by_agent: "Pausada pelo responsável",
    failed: "Falhou",
  },
  "en-US": {
    active: "Active",
    completed: "Completed",
    handed_off: "Handed off",
    timed_out: "Timed out",
    paused_by_agent: "Paused by assignee",
    failed: "Failed",
  },
};

const STATUS_META: Record<
  RunRow["status"],
  { classes: string; icon: typeof Clock }
> = {
  active: {
    classes: "border-emerald-600/40 bg-emerald-500/10 text-emerald-300",
    icon: PlayCircle,
  },
  completed: {
    classes: "border-border bg-muted text-muted-foreground",
    icon: CircleCheck,
  },
  handed_off: {
    classes: "border-amber-600/40 bg-amber-500/10 text-amber-300",
    icon: UserPlus,
  },
  timed_out: {
    classes: "border-border bg-muted/60 text-muted-foreground",
    icon: Clock,
  },
  paused_by_agent: {
    classes: "border-border bg-muted text-muted-foreground",
    icon: PauseCircle,
  },
  failed: {
    classes: "border-red-600/40 bg-red-500/10 text-red-300",
    icon: CircleAlert,
  },
};

export default function FlowRunsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { t } = useLanguage();

  const [flow, setFlow] = useState<{ id: string; name: string } | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/flows/${params.id}/runs`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const json = (await res.json()) as {
          flow: { id: string; name: string };
          runs: RunRow[];
          events: EventRow[];
        };
        if (!cancelled) {
          setFlow(json.flow);
          setRuns(json.runs ?? []);
          setEvents(json.events ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          toast.error("Couldn't load runs.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  function toggle(runId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (notFound || !flow) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">{t("Flow not found.")}</p>
        <button
          type="button"
          onClick={() => router.push("/flows")}
          className="text-sm text-primary hover:opacity-80"
        >
          {t("← Back to flows")}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <button
        type="button"
        onClick={() => router.push(`/flows/${flow.id}`)}
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        {flow.name}
      </button>
      <h1 className="text-xl font-semibold text-foreground">{t("Runs")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("The 50 most recent times this flow ran. Expand a row to see the engine's per-step log.")}
      </p>

      {runs.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-border bg-card/50 px-6 py-12 text-center text-sm text-muted-foreground">
          {t("No runs yet. Trigger the flow from a personal WhatsApp number to see it appear here.")}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-2">
          {runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              events={events.filter((e) => e.flow_run_id === run.id)}
              expanded={expanded.has(run.id)}
              onToggle={() => toggle(run.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({
  run,
  events,
  expanded,
  onToggle,
}: {
  run: RunRow;
  events: EventRow[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, language } = useLanguage();
  const dateLocale = language === "pt-BR" ? ptBR : undefined;
  const meta = STATUS_META[run.status];
  const StatusIcon = meta.icon;
  const contactLabel =
    run.contact?.name?.trim() || run.contact?.phone || t("Unknown contact");
  // How long the run took (start → end), not how long ago it ended.
  const duration = run.ended_at
    ? formatDistanceStrict(new Date(run.ended_at), new Date(run.started_at), {
        locale: dateLocale,
      })
    : null;
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {contactLabel}
            </span>
            <Badge variant="outline" className={cn("gap-1", meta.classes)}>
              <StatusIcon className="h-3 w-3" />
              {STATUS_LABEL[language][run.status]}
            </Badge>
            {run.status === "active" && run.current_node_key && (
              <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t("at node")} {run.current_node_key}
              </code>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {t("Started")}{" "}
              {new Date(run.started_at).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" })}
            </span>
            {run.reprompt_count > 0 && (
              <span>
                · {run.reprompt_count}{" "}
                {t(run.reprompt_count === 1 ? "re-prompt" : "re-prompts")}
              </span>
            )}
            {duration && (
              <span>
                · {t("ran for")} {duration}
              </span>
            )}
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          {Object.keys(run.vars).length > 0 && (
            <details className="mb-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("Captured variables")} ({Object.keys(run.vars).length})
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-background p-2 text-[11px] text-muted-foreground">
                {JSON.stringify(run.vars, null, 2)}
              </pre>
            </details>
          )}
          <div className="flex flex-col gap-1">
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("No events recorded for this run.")}
              </p>
            ) : (
              events.map((ev, ix) => (
                <EventLine key={ix} ev={ev} language={language} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const EVENT_COLOR: Record<string, string> = {
  started: "text-emerald-300",
  node_entered: "text-muted-foreground",
  message_sent: "text-sky-300",
  reply_received: "text-primary",
  fallback_fired: "text-amber-300",
  handoff: "text-amber-300",
  timeout: "text-muted-foreground",
  error: "text-red-300",
  completed: "text-emerald-300",
};

/** Engine event codes as they read in each language. */
const EVENT_LABEL: Record<Language, Record<string, string>> = {
  "pt-BR": {
    started: "iniciada",
    node_entered: "entrou no nó",
    message_sent: "mensagem enviada",
    reply_received: "resposta recebida",
    fallback_fired: "resposta não compreendida",
    handoff: "transferida",
    timeout: "tempo esgotado",
    error: "erro",
    completed: "concluída",
  },
  "en-US": {
    started: "started",
    node_entered: "entered node",
    message_sent: "message sent",
    reply_received: "reply received",
    fallback_fired: "fallback fired",
    handoff: "handed off",
    timeout: "timed out",
    error: "error",
    completed: "completed",
  },
};

/** Payload keys worth surfacing inline, in priority order. */
const PAYLOAD_LABEL: Record<Language, Record<string, string>> = {
  "pt-BR": {
    reply_id: "resposta",
    captured_key: "variável",
    reason: "motivo",
    action: "ação",
    advancing_to: "avançando para",
  },
  "en-US": {
    reply_id: "reply",
    captured_key: "variable",
    reason: "reason",
    action: "action",
    advancing_to: "advancing to",
  },
};

/** Engine reason / fallback-action codes as plain copy. Unknown codes
 *  degrade to "words with spaces" rather than a raw snake_case token. */
const PAYLOAD_VALUE_LABEL: Record<Language, Record<string, string>> = {
  "pt-BR": {
    unknown_reply: "resposta não reconhecida",
    timeout: "tempo esgotado",
    fallback_exhausted: "limite de novas tentativas atingido",
    node_not_found: "nó não encontrado",
    send_text_failed: "falha ao enviar a mensagem",
    send_media_failed: "falha ao enviar a mídia",
    collect_input_prompt_failed: "falha ao enviar a pergunta",
    condition_evaluation_failed: "falha ao avaliar a condição",
    set_tag_failed: "falha ao etiquetar o contato",
    reprompt_send_failed: "falha ao reenviar a pergunta",
    lost_race_during_advance: "outra execução avançou primeiro",
    advance_loop_safety_break: "limite de avanços por mensagem atingido",
    reprompt: "nova tentativa",
    handoff: "transferir para um responsável",
    end: "encerrar a execução",
    ignore: "ignorar",
  },
  "en-US": {
    unknown_reply: "unrecognised reply",
    timeout: "timed out",
    fallback_exhausted: "re-prompt limit reached",
    node_not_found: "node not found",
    send_text_failed: "message could not be sent",
    send_media_failed: "media could not be sent",
    collect_input_prompt_failed: "prompt could not be sent",
    condition_evaluation_failed: "condition could not be evaluated",
    set_tag_failed: "contact could not be tagged",
    reprompt_send_failed: "re-prompt could not be sent",
    lost_race_during_advance: "another run advanced first",
    advance_loop_safety_break: "advance limit per message reached",
    reprompt: "re-prompt",
    handoff: "hand off to an assignee",
    end: "end the run",
    ignore: "ignore",
  },
};

function payloadValue(key: string, value: unknown, language: Language): string {
  const raw = String(value).slice(0, 80);
  if (key !== "reason" && key !== "action") return raw;
  const known = PAYLOAD_VALUE_LABEL[language][raw];
  if (known) return known;
  if (raw.startsWith("unknown_node_type:")) {
    return language === "pt-BR" ? "tipo de nó desconhecido" : "unknown node type";
  }
  return raw.replace(/_/g, " ");
}

function EventLine({ ev, language }: { ev: EventRow; language: Language }) {
  const cls = EVENT_COLOR[ev.event_type] ?? "text-muted-foreground";
  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1 text-xs">
      <span className="w-32 shrink-0 text-[10px] text-muted-foreground">
        {format(new Date(ev.created_at), "HH:mm:ss")}
      </span>
      <span className={cn("w-32 shrink-0 text-[10px]", cls)}>
        {EVENT_LABEL[language][ev.event_type] ?? ev.event_type}
      </span>
      {ev.node_key && (
        <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
          {ev.node_key}
        </code>
      )}
      {Object.keys(ev.payload).length > 0 && (
        <span className="min-w-0 truncate text-[10px] text-muted-foreground">
          {summarizePayload(ev.payload, language)}
        </span>
      )}
    </div>
  );
}

function summarizePayload(
  payload: Record<string, unknown>,
  language: Language,
): string {
  // Show the key that matters most to a human debugger; full JSON is
  // available via the "Captured variables" details panel for the run.
  const labels = PAYLOAD_LABEL[language];
  for (const k of Object.keys(labels)) {
    if (k in payload && payload[k] !== null && payload[k] !== undefined) {
      return `${labels[k]}: ${payloadValue(k, payload[k], language)}`;
    }
  }
  return "";
}
