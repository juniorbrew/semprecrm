"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { History, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelative } from "@/lib/automations/trigger-meta";

export interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row density of the flows list, per user on this device. */
export type FlowsDensity = "comfortable" | "compact";
const DENSITY_KEY_PREFIX = "sempre:flows:density:";

export function readFlowsDensity(userId: string): FlowsDensity {
  try {
    return localStorage.getItem(DENSITY_KEY_PREFIX + userId) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function writeFlowsDensity(userId: string, density: FlowsDensity): void {
  try {
    localStorage.setItem(DENSITY_KEY_PREFIX + userId, density);
  } catch {
    // Persistence is best-effort.
  }
}

export const FLOWS_COPY = {
  "pt-BR": {
    title: "Fluxos",
    newFlow: "Novo fluxo",
    compact: "Lista compacta",
    empty: "Nenhum fluxo ainda.",
    emptyHint: "Um menu de boas-vindas, uma consulta de pedido ou perguntas frequentes: o cliente toca nos botões e o fluxo leva à resposta certa.",
    firstFlow: "Criar o primeiro fluxo",
    status: { draft: "Rascunho", active: "Ativo", archived: "Arquivado" },
    keywordNone: "Palavra-chave (nenhuma definida)",
    keywords: (list: string) => `Palavras-chave: ${list}`,
    firstMessage: "Primeira mensagem do contato",
    manual: "Início manual",
    runs: (n: number) => (n === 1 ? "1 execução" : `${n} execuções`),
    lastRun: (when: string) => `última ${when}`,
    more: (name: string) => `Mais ações para ${name}`,
    edit: "Editar",
    runsLink: "Execuções",
    delete: "Excluir",
  },
  "en-US": {
    title: "Flows",
    newFlow: "New flow",
    compact: "Compact list",
    empty: "No flows yet.",
    emptyHint: "A welcome menu, an order lookup or an FAQ: customers tap buttons and the flow routes them to the right answer.",
    firstFlow: "Create your first flow",
    status: { draft: "Draft", active: "Active", archived: "Archived" },
    keywordNone: "Keyword (none set)",
    keywords: (list: string) => `Keywords: ${list}`,
    firstMessage: "Contact's first message",
    manual: "Manual start",
    runs: (n: number) => (n === 1 ? "1 run" : `${n} runs`),
    lastRun: (when: string) => `last ${when}`,
    more: (name: string) => `More actions for ${name}`,
    edit: "Edit",
    runsLink: "Runs",
    delete: "Delete",
  },
} satisfies Record<Language, Record<string, unknown>>;

export type FlowsCopy = (typeof FLOWS_COPY)["pt-BR"];

export function flowTriggerSummary(flow: Pick<FlowRow, "trigger_type" | "trigger_config">, copy: FlowsCopy): string {
  if (flow.trigger_type === "keyword") {
    const keywords = Array.isArray(flow.trigger_config.keywords) ? (flow.trigger_config.keywords as string[]) : [];
    return keywords.length === 0 ? copy.keywordNone : copy.keywords(keywords.join(", "));
  }
  if (flow.trigger_type === "first_inbound_message") return copy.firstMessage;
  return copy.manual;
}

/** "Trigger · N runs · last X" — the one meta line under the name. */
export function flowMetaLine(
  flow: Pick<FlowRow, "trigger_type" | "trigger_config" | "execution_count" | "last_executed_at">,
  language: Language,
  copy: FlowsCopy,
): string {
  return [
    flowTriggerSummary(flow, copy),
    copy.runs(flow.execution_count ?? 0),
    copy.lastRun(formatRelative(flow.last_executed_at, language)),
  ].join(" · ");
}

const STATUS_DOT: Record<FlowRow["status"], string> = {
  active: "bg-emerald-500",
  draft: "bg-muted-foreground/50",
  archived: "bg-muted-foreground/30",
};

const quickBtn =
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

/**
 * One flow: name, one quiet meta line, status dot + text. Quick actions
 * (edit, runs) on hover / focus-within, hidden from the a11y tree — the
 * "…" menu has the same actions with labels.
 */
export function FlowListRow({
  flow,
  language,
  copy,
  compact,
  onDelete,
}: {
  flow: FlowRow;
  language: Language;
  copy: FlowsCopy;
  compact: boolean;
  onDelete: () => void;
}) {
  const router = useRouter();
  const href = `/flows/${flow.id}`;
  const runsHref = `/flows/${flow.id}/runs`;
  return (
    <li
      className={cn(
        "group/row flex items-center gap-3 px-3 transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none",
        compact ? "py-1.5" : "py-3",
      )}
    >
      {/* A real anchor so the editor opens on any click strategy. */}
      <Link
        href={href}
        className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("flex min-w-0", compact ? "items-baseline gap-2" : "flex-col")}>
          <span className="truncate text-sm font-medium text-foreground" data-no-translate>
            {flow.name}
          </span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {flowMetaLine(flow, language, copy)}
          </span>
        </span>
        {!compact && flow.description && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground" data-no-translate>
            {flow.description}
          </span>
        )}
      </Link>

      <span className="inline-flex shrink-0 items-center sm:w-24 gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[flow.status])} />
        {copy.status[flow.status]}
      </span>

      <div className="flex shrink-0 items-center gap-0.5">
        <div
          aria-hidden
          className="hidden items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none md:flex"
        >
          <Link href={href} tabIndex={-1} title={copy.edit} className={quickBtn}>
            <Pencil className="size-3.5" />
          </Link>
          <Link href={runsHref} tabIndex={-1} title={copy.runsLink} className={quickBtn}>
            <History className="size-3.5" />
          </Link>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={copy.more(flow.name)}
                className="text-muted-foreground hover:text-foreground"
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => router.push(href)}>
              <Pencil className="size-4" />
              {copy.edit}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push(runsHref)}>
              <History className="size-4" />
              {copy.runsLink}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="size-4" />
              {copy.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
