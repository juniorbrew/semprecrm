import {
  BarChart3,
  Bot,
  Building2,
  CalendarDays,
  CheckSquare,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Radio,
  Settings,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import type { InboxNavSummary } from "@/hooks/use-inbox-nav";
import { canViewReports, type AccountRole } from "@/lib/auth/roles";
import type { InboxCounts } from "@/lib/inbox/list-query";
import type { Language } from "@/lib/i18n";
import type { Module } from "@/lib/plans";

export type NavSectionId = "service" | "sales" | "automation" | "work";

export const NAV_SECTIONS: NavSectionId[] = ["service", "sales", "automation", "work"];

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Labelled group; absent = the unlabelled row on top (Painel). */
  section?: NavSectionId;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
  /**
   * Plan module this entry belongs to (see `src/lib/plans.ts`). The
   * row is hidden when the account's entitlements have the module
   * off. `inbox` / `contacts` are always on, so those rows never hide.
   * Absent = always shown (Configurações).
   */
  module?: Module;
  /** Owner / admin only (the row is hidden for agents and viewers). */
  adminOnly?: boolean;
}

/** Order inside a section is the order here. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Painel", icon: LayoutDashboard, module: "dashboard" },
  { href: "/inbox", label: "Caixa de entrada", icon: MessageSquare, module: "inbox", section: "service" },
  { href: "/contacts", label: "Contatos", icon: Users, module: "contacts", section: "service" },
  // Support reports (migration 075) — owner / admin, same plan module as the dashboard.
  { href: "/reports", label: "Relatórios", icon: BarChart3, module: "dashboard", adminOnly: true, section: "service" },
  { href: "/pipelines", label: "Funis", icon: GitBranch, module: "pipelines", section: "sales" },
  // Customer companies (migration 054) — part of the always-on CRM core.
  { href: "/companies", label: "Empresas", icon: Building2, module: "contacts", section: "sales" },
  { href: "/broadcasts", label: "Disparos", icon: Radio, module: "broadcasts", section: "sales" },
  { href: "/automations", label: "Automações", icon: Zap, module: "automations", section: "automation" },
  { href: "/flows", label: "Fluxos", icon: Workflow, beta: true, module: "flows", section: "automation" },
  // AI agents (migrations 064/065) — agent+ view, admin+ edit.
  { href: "/ai/agents", label: "Agentes de IA", icon: Bot, module: "ai", section: "automation" },
  { href: "/tasks", label: "Tarefas", icon: CheckSquare, module: "tasks", section: "work" },
  { href: "/agenda", label: "Agenda", icon: CalendarDays, module: "calendar", section: "work" },
  { href: "/chat", label: "Chat", icon: MessagesSquare, module: "internal_chat", section: "work" },
  { href: "/settings", label: "Configurações", icon: Settings, section: "work" },
];

interface GateContext {
  /** Until the entitlements settle every row shows (no reflow later). */
  entitlementsReady: boolean;
  modules: Partial<Record<Module, boolean>>;
  accountRole: AccountRole | null | undefined;
}

export function isNavItemVisible(item: NavItem, ctx: GateContext): boolean {
  if (item.module && ctx.entitlementsReady && !ctx.modules[item.module]) return false;
  if (item.adminOnly && !(ctx.accountRole && canViewReports(ctx.accountRole))) return false;
  return true;
}

export interface NavGroup {
  section: NavSectionId | null;
  items: NavItem[];
}

/** Visible rows grouped: the unlabelled top group, then each non-empty section. */
export function navGroups(items: NavItem[], ctx: GateContext): NavGroup[] {
  const visible = items.filter((item) => isNavItemVisible(item, ctx));
  const groups: NavGroup[] = [
    { section: null, items: visible.filter((item) => !item.section) },
    ...NAV_SECTIONS.map((section) => ({
      section,
      items: visible.filter((item) => item.section === section),
    })),
  ];
  return groups.filter((group) => group.items.length > 0);
}

export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
}

// ---- Inbox shortcuts (submenu under Caixa de entrada) ----
// Each one is an existing inbox view: a tab (?tab=, applied then dropped by
// the list) and/or a Radar bucket (?radar=). Counts come from the list's
// own `inbox_counts` answer (useInboxNav).

export type InboxShortcutId = "mine" | "team" | "unassigned" | "slaRisk";

export interface InboxShortcut {
  id: InboxShortcutId;
  href: string;
  count: (counts: InboxCounts) => number;
  /** Red count: needs attention. */
  alert?: boolean;
}

export const INBOX_SHORTCUTS: InboxShortcut[] = [
  { id: "mine", href: "/inbox?tab=mine", count: (c) => c.tabs.mine },
  { id: "team", href: "/inbox?tab=all", count: (c) => c.tabs.all },
  { id: "unassigned", href: "/inbox?tab=all&radar=unassigned", count: (c) => c.radar.unassigned },
  { id: "slaRisk", href: "/inbox?tab=all&radar=waiting", count: (c) => c.radar.waiting, alert: true },
];

export function activeInboxShortcut(summary: InboxNavSummary | null): InboxShortcutId | null {
  if (!summary) return null;
  if (summary.radar === "unassigned") return "unassigned";
  if (summary.radar === "waiting") return "slaRisk";
  if (summary.radar) return null;
  if (summary.tab === "mine") return "mine";
  if (summary.tab === "all") return "team";
  return null;
}

// Feminine plurals ("Minhas") would collide with the DOM catalogue's
// singular keys, so the shell's new copy lives here (rendered with
// data-no-translate), like the inbox strip copy.
export const NAV_COPY: Record<
  Language,
  { sections: Record<NavSectionId, string>; inboxViews: string; shortcuts: Record<InboxShortcutId, string> }
> = {
  "pt-BR": {
    sections: { service: "Atendimento", sales: "Vendas", automation: "Automação", work: "Trabalho" },
    inboxViews: "Atalhos da caixa de entrada",
    shortcuts: { mine: "Minhas", team: "Equipe", unassigned: "Sem dono", slaRisk: "SLA em risco" },
  },
  "en-US": {
    sections: { service: "Service", sales: "Sales", automation: "Automation", work: "Work" },
    inboxViews: "Inbox shortcuts",
    shortcuts: { mine: "Mine", team: "Team", unassigned: "Unassigned", slaRisk: "SLA at risk" },
  },
};
