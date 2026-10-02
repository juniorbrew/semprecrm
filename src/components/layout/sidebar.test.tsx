import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import type { InboxNavSummary } from "@/hooks/use-inbox-nav";
import { EMPTY_COUNTS } from "@/lib/inbox/list-query";
import { MODULES, type Module } from "@/lib/plans";
import type { AccountRole } from "@/lib/auth/roles";
import {
  activeInboxShortcut,
  INBOX_SHORTCUTS,
  isNavActive,
  NAV_ITEMS,
  navGroups,
} from "./nav-config";
import { Sidebar } from "./sidebar";

const allOn = Object.fromEntries(MODULES.map((m) => [m, true])) as Record<Module, boolean>;

const state = vi.hoisted(() => ({
  pathname: "/dashboard",
  role: "owner" as string | null,
  modules: {} as Record<string, boolean>,
  inboxNav: null as unknown,
  unread: 0,
}));

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/hooks/use-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-auth")>();
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), accountRole: state.role }),
    useEntitlements: () => ({ ready: true, modules: state.modules }),
  };
});
vi.mock("@/hooks/use-total-unread", () => ({ useTotalUnread: () => state.unread }));
vi.mock("@/hooks/use-overdue-tasks", () => ({ useOverdueTasks: () => 0 }));
vi.mock("@/hooks/use-chat-unread", () => ({ useChatUnread: () => 0 }));
vi.mock("@/hooks/use-upcoming-events", () => ({ useUpcomingEvents: () => 0 }));
vi.mock("@/hooks/use-inbox-nav", () => ({ useInboxNav: () => state.inboxNav }));

function summary(over: Partial<InboxNavSummary> = {}): InboxNavSummary {
  return {
    tab: "all",
    radar: null,
    counts: {
      ...EMPTY_COUNTS,
      tabs: { ...EMPTY_COUNTS.tabs, mine: 4, all: 12 },
      radar: { waiting: 2, unassigned: 3, cooling: 1 },
    },
    ...over,
  };
}

/** The opening <a …> tag of the link pointing at `href`. */
function linkTag(html: string, href: string): string {
  const at = html.indexOf(`href="${href.replace(/&/g, "&amp;")}"`);
  if (at < 0) return "";
  return html.slice(html.lastIndexOf("<a", at), html.indexOf(">", at) + 1);
}

beforeEach(() => {
  state.pathname = "/dashboard";
  state.role = "owner";
  state.modules = { ...allOn };
  state.inboxNav = null;
  state.unread = 0;
});

describe("navGroups", () => {
  const ctx = (over: Partial<Parameters<typeof navGroups>[1]> = {}) => ({
    entitlementsReady: true,
    modules: allOn,
    accountRole: "owner" as AccountRole,
    ...over,
  });

  it("keeps Painel on top, then the four sections in order", () => {
    const groups = navGroups(NAV_ITEMS, ctx());
    expect(groups.map((g) => g.section)).toEqual([null, "service", "sales", "automation", "work"]);
    expect(groups[0].items.map((i) => i.href)).toEqual(["/dashboard"]);
    expect(groups[1].items.map((i) => i.href)).toEqual(["/inbox", "/contacts", "/reports"]);
    expect(groups[4].items.map((i) => i.href)).toContain("/settings");
  });

  it("hides Relatórios for agents and viewers", () => {
    for (const role of ["agent", "viewer"] as AccountRole[]) {
      const hrefs = navGroups(NAV_ITEMS, ctx({ accountRole: role })).flatMap((g) => g.items.map((i) => i.href));
      expect(hrefs).not.toContain("/reports");
    }
  });

  it("drops rows (and empty sections) for modules turned off", () => {
    const modules = { ...allOn, automations: false, flows: false, ai: false, broadcasts: false };
    const groups = navGroups(NAV_ITEMS, ctx({ modules }));
    expect(groups.map((g) => g.section)).not.toContain("automation");
    expect(groups.flatMap((g) => g.items.map((i) => i.href))).not.toContain("/broadcasts");
  });

  it("shows everything until the entitlements settle", () => {
    const groups = navGroups(NAV_ITEMS, ctx({ entitlementsReady: false, modules: {} }));
    expect(groups.flatMap((g) => g.items)).toHaveLength(NAV_ITEMS.length);
  });
});

describe("isNavActive / activeInboxShortcut", () => {
  it("matches nested routes but not the dashboard prefix", () => {
    expect(isNavActive("/inbox", "/inbox")).toBe(true);
    expect(isNavActive("/ai/agents/123", "/ai/agents")).toBe(true);
    expect(isNavActive("/settings", "/dashboard")).toBe(false);
  });

  it("follows the Radar bucket first, then the tab", () => {
    expect(activeInboxShortcut(null)).toBeNull();
    expect(activeInboxShortcut(summary({ tab: "mine" }))).toBe("mine");
    expect(activeInboxShortcut(summary({ tab: "all" }))).toBe("team");
    expect(activeInboxShortcut(summary({ radar: "unassigned" }))).toBe("unassigned");
    expect(activeInboxShortcut(summary({ radar: "waiting" }))).toBe("slaRisk");
    expect(activeInboxShortcut(summary({ radar: "cooling" }))).toBeNull();
    expect(activeInboxShortcut(summary({ tab: "closed" }))).toBeNull();
  });

  it("links every shortcut to an existing inbox view", () => {
    expect(INBOX_SHORTCUTS.map((s) => s.href)).toEqual([
      "/inbox?tab=mine",
      "/inbox?tab=all",
      "/inbox?tab=all&radar=unassigned",
      "/inbox?tab=all&radar=waiting",
    ]);
  });
});

describe("Sidebar", () => {
  it("renders brand-coloured section labels", () => {
    const html = renderToString(<Sidebar />);
    for (const label of ["Atendimento", "Vendas", "Automação", "Trabalho"]) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/id="nav-section-service"[^>]*text-primary/);
  });

  it("marks the active row with aria-current and the tinted accent", () => {
    state.pathname = "/contacts";
    const html = renderToString(<Sidebar />);
    const active = linkTag(html, "/contacts");
    expect(active).toContain('aria-current="page"');
    expect(active).toContain("bg-primary/13");
    expect(active).toContain("shadow-[inset_2px_0_0_var(--primary)]");
    expect(active).toContain("focus-visible:ring-3");
    expect(linkTag(html, "/inbox")).not.toContain("aria-current");
  });

  it("hides Relatórios for an agent", () => {
    state.role = "agent";
    expect(linkTag(renderToString(<Sidebar />), "/reports")).toBe("");
  });

  it("shows the inbox shortcuts only inside the inbox", () => {
    expect(linkTag(renderToString(<Sidebar />), "/inbox?tab=mine")).toBe("");
    state.pathname = "/inbox";
    const html = renderToString(<Sidebar />);
    for (const s of INBOX_SHORTCUTS) expect(linkTag(html, s.href)).not.toBe("");
    // No counts until the list answers.
    expect(html).not.toContain("inbox-shortcut-count-");
  });

  it("mirrors the list's counts and active view", () => {
    state.pathname = "/inbox";
    state.inboxNav = summary({ radar: "unassigned" });
    const html = renderToString(<Sidebar />);
    expect(html).toMatch(/inbox-shortcut-count-mine"[^>]*>4</);
    expect(html).toMatch(/inbox-shortcut-count-team"[^>]*>12</);
    expect(html).toMatch(/inbox-shortcut-count-unassigned"[^>]*>3</);
    expect(html).toMatch(/inbox-shortcut-count-slaRisk"[^>]*bg-destructive[^>]*>2</);
    expect(linkTag(html, "/inbox?tab=all&radar=unassigned")).toContain('aria-current="true"');
    expect(linkTag(html, "/inbox?tab=mine")).not.toContain("aria-current");
  });

  it("shows the inbox unread total as a primary pill", () => {
    expect(renderToString(<Sidebar />)).not.toContain("nav-inbox-unread");
    state.unread = 5;
    expect(renderToString(<Sidebar />)).toMatch(/nav-inbox-unread"[^>]*bg-primary text-primary-foreground[^>]*>5</);
  });
});
