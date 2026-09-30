"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { useLanguage } from "@/hooks/use-language";
import { createClient } from "@/lib/supabase/client";

interface JobRow {
  id: string;
  conversation_id: string;
  status: string;
  outcome: string | null;
  skip_reason: string | null;
  created_at: string;
}

/** English key per job result (pt-BR in the AI dictionary). */
export const JOB_RESULT_LABEL: Record<string, string> = {
  replied: "Replied",
  handoff: "Handed to the team",
  opted_out: "Customer opted out",
  queued: "Waiting",
  running: "Answering…",
  failed: "Failed",
  skipped: "Skipped",
};

/** Why a job was skipped (skip_reason) — English keys. */
export const SKIP_REASON_LABEL: Record<string, string> = {
  ai_paused: "AI paused in the conversation",
  nothing_to_answer: "Nothing to answer",
  outside_hours: "Outside business hours",
  meta_window_closed: "24 h window closed",
  contact_opted_out: "Contact opted out",
  contact_anonymized: "Contact anonymized",
  conversation_closed: "Conversation resolved",
  conversation_archived: "Conversation archived",
  agent_paused: "Agent paused",
  agent_disabled: "Agent turned off",
  agent_not_auto: "Agent in suggestion mode",
  no_agent: "No agent applies",
  module_off: "AI not in the plan",
  merged: "Merged into a newer reply",
  automation_answered: "An automation already answered",
  flow_active: "Customer inside a flow",
  ai_disabled: "AI turned off",
  failed_attempts: "Failed attempts",
  contact_mismatch: "Contact mismatch",
};

function resultLabel(j: JobRow): string {
  if (j.status === "done") return JOB_RESULT_LABEL[j.outcome ?? "replied"] ?? "Replied";
  if (j.status === "skipped") return SKIP_REASON_LABEL[j.skip_reason ?? ""] ?? "Skipped";
  return JOB_RESULT_LABEL[j.status] ?? j.status;
}

/** "Últimas respostas automáticas": the agent's last 20 jobs (RLS: agent+ of the account). */
export function AgentRecentReplies({ agentId }: { agentId: string }) {
  const { t, language } = useLanguage();
  const [rows, setRows] = useState<JobRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void createClient()
      .from("ai_reply_jobs")
      .select("id, conversation_id, status, outcome, skip_reason, created_at")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (!cancelled) setRows((data ?? []) as JobRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{t("Latest automatic replies")}</h2>
      {rows === null ? null : rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t("No automatic reply yet.")}</p>
      ) : (
        <ul className="mt-2 divide-y divide-border text-sm">
          {rows.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
              <time data-no-translate className="w-32 shrink-0 tabular-nums text-muted-foreground">
                {new Date(j.created_at).toLocaleString(language, { dateStyle: "short", timeStyle: "short" })}
              </time>
              <span className="flex-1 text-foreground">{t(resultLabel(j))}</span>
              <Link href={`/inbox?c=${j.conversation_id}`} className="text-primary hover:underline">
                {t("Open conversation")}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
