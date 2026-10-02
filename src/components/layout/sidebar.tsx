"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { useAuth, useEntitlements } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { useBranding } from "@/hooks/use-branding";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useOverdueTasks } from "@/hooks/use-overdue-tasks";
import { useChatUnread } from "@/hooks/use-chat-unread";
import { useUpcomingEvents } from "@/hooks/use-upcoming-events";
import { useInboxNav } from "@/hooks/use-inbox-nav";
import {
  Crown,
  LogOut,
  MessageSquare,
  Settings,
  Shield,
  ShieldCheck,
  User,
  UserCog,
  UsersRound,
  X,
} from "lucide-react";
import type { AccountRole } from "@/lib/auth/roles";
import {
  activeInboxShortcut,
  INBOX_SHORTCUTS,
  isNavActive,
  NAV_COPY,
  NAV_ITEMS,
  navGroups,
} from "@/components/layout/nav-config";

// Per-role chip metadata used in the sidebar's account strip + the
// Members tab roster. Keeping this near both consumers in a single
// place avoids drift between the two surfaces — when a designer
// wants to recolour "agent" rows, this is the one diff.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; label: string; className: string }
> = {
  owner: {
    icon: Crown,
    label: "Proprietário",
    // Amber: scarce, immutable, "the boss" — gets visual emphasis.
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  admin: {
    icon: Shield,
    label: "Administrador",
    // Primary-tinted: significant but not as scarce as owner.
    className:
      "border-primary/40 bg-primary/10 text-primary",
  },
  agent: {
    icon: UserCog,
    label: "Agente",
    // Neutral slate: the operational default.
    className:
      "border-border bg-muted text-foreground",
  },
  viewer: {
    icon: User,
    label: "Visualizador",
    // Muted slate: read-only role; visually quieter than agent.
    className:
      "border-border bg-card text-muted-foreground",
  },
};
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  AvailabilityDot,
  AvailabilityToggle,
} from "@/components/layout/availability-toggle";

/** Count pill shared by the nav rows and the inbox shortcuts. */
const PILL =
  "inline-flex min-w-5 shrink-0 items-center justify-center rounded-full px-[7px] text-[11px] font-bold leading-[18px] tabular-nums";

/** "Ana Ribeiro" → "AR"; falls back to the email's first letter. */
function initials(name: string | null | undefined, email: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  return (words[0]?.[0] ?? email?.[0] ?? "U").toUpperCase();
}
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { t, language } = useLanguage();
  const navCopy = NAV_COPY[language] ?? NAV_COPY["pt-BR"];
  const { profile, profileLoading, account, accountRole, signOut, isPlatformAdmin } =
    useAuth();
  const { ready: entitlementsReady, modules } = useEntitlements();
  // White-label (spec round 2 §6): app name + logo when the module is on.
  const branding = useBranding();
  const totalUnread = useTotalUnread();
  // Red count on Tarefas: my open tasks past their due date (realtime).
  const overdueTasks = useOverdueTasks(!entitlementsReady || modules.tasks);
  // Unread internal-chat messages (realtime on chat_messages).
  const chatUnread = useChatUnread(!entitlementsReady || modules.internal_chat);
  // Count on Agenda: my appointments starting in the next two hours (realtime).
  const upcomingEvents = useUpcomingEvents(!entitlementsReady || modules.calendar);
  // Hide rows for modules the plan (or a platform override) turned
  // off. Until the entitlements settle we show everything — a row
  // that appears late is less jarring than the whole menu reflowing
  // after a disabled module briefly showed up and vanished.
  const groups = navGroups(NAV_ITEMS, { entitlementsReady, modules, accountRole });
  // Inbox shortcuts: only while the inbox is open (its list publishes the
  // tab / Radar / counts they mirror).
  const inboxNav = useInboxNav();
  const activeShortcut = activeInboxShortcut(inboxNav);
  // The logo link should never point at a hidden module.
  const homeHref =
    entitlementsReady && !modules.dashboard ? "/inbox" : "/dashboard";
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  const showAccountStrip =
    !profileLoading &&
    !!account?.name &&
    account.name !== profile?.full_name;

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label="Fechar menu"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-border bg-card",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: static, always visible — reset all the mobile framing.
          "lg:static lg:z-0 lg:w-60 lg:translate-x-0 lg:transition-none",
        )}
        aria-label={t("Main navigation")}
      >
        {/* Logo row. On mobile we put a close button here; on desktop the
            close button is hidden since the sidebar is always-visible. */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-5 pt-2">
          <Link
            href={homeHref}
            className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {branding.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- remote, user-uploaded; no fixed dimensions
              <img
                src={branding.logo_url}
                alt={branding.app_name}
                className="size-[30px] shrink-0 rounded-[10px] object-contain"
              />
            ) : (
              <div className="flex size-[30px] shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground shadow-[0_0_22px_-3px_var(--primary)]">
                <MessageSquare className="size-4" />
              </div>
            )}
            <span
              className="truncate text-base font-extrabold tracking-[-0.01em] text-foreground"
              title={branding.app_name}
            >
              {branding.app_name}
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar menu"
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation: an unlabelled top row (Painel), then labelled
            sections. Section titles use the brand colour; the active row
            gets a brand tint + a 2px inset accent (docs/design-principles). */}
        <nav className="flex-1 overflow-y-auto px-3 pb-3 pt-1">
          {groups.map((group) => {
            const headingId = group.section ? `nav-section-${group.section}` : undefined;
            return (
              <div
                key={group.section ?? "top"}
                role={group.section ? "group" : undefined}
                aria-labelledby={headingId}
              >
                {group.section ? (
                  <p
                    id={headingId}
                    data-no-translate
                    className="px-2.5 pb-[5px] pt-3.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-primary"
                  >
                    {navCopy.sections[group.section]}
                  </p>
                ) : null}
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const isActive = isNavActive(pathname, item.href);
                    const isInbox = item.href === "/inbox";

                    const showUnreadBadge = isInbox && totalUnread > 0;
                    const showOverdueBadge = item.href === "/tasks" && overdueTasks > 0;
                    const showChatBadge = item.href === "/chat" && chatUnread > 0;
                    const showAgendaBadge = item.href === "/agenda" && upcomingEvents > 0;

                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={isActive ? "page" : undefined}
                          className={cn(
                            // Taller on mobile so fingers can hit the row reliably (≥44px).
                            "flex items-center gap-[11px] rounded-[calc(var(--radius)-2px)] px-2.5 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 lg:py-2",
                            isActive
                              ? "bg-primary/13 font-semibold text-foreground shadow-[inset_2px_0_0_var(--primary)]"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          <item.icon
                            className={cn("size-4 shrink-0", isActive ? "text-primary" : "opacity-70")}
                          />
                          <span className="flex-1">{item.label}</span>
                          {item.beta && (
                            <span
                              aria-label="Recurso beta"
                              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                            >
                              Beta
                            </span>
                          )}
                          {showOverdueBadge && (
                            <span
                              aria-label={`${overdueTasks} ${t(overdueTasks === 1 ? "task past due" : "tasks past due")}`}
                              title={`${overdueTasks} ${t(overdueTasks === 1 ? "task past due" : "tasks past due")}`}
                              className={cn(PILL, "bg-muted text-muted-foreground")}
                            >
                              {overdueTasks > 99 ? "99+" : overdueTasks}
                            </span>
                          )}
                          {showChatBadge && (
                            <span
                              aria-label={`${chatUnread} ${t(chatUnread === 1 ? "unread message" : "unread messages")}`}
                              title={`${chatUnread} ${t(chatUnread === 1 ? "unread message" : "unread messages")}`}
                              className={cn(PILL, "bg-primary text-primary-foreground")}
                            >
                              {chatUnread > 99 ? "99+" : chatUnread}
                            </span>
                          )}
                          {showAgendaBadge && (
                            <span
                              aria-label={`${upcomingEvents} ${t(upcomingEvents === 1 ? "appointment in the next 2 h" : "appointments in the next 2 h")}`}
                              title={`${upcomingEvents} ${t(upcomingEvents === 1 ? "appointment in the next 2 h" : "appointments in the next 2 h")}`}
                              className={cn(PILL, "bg-muted text-muted-foreground")}
                            >
                              {upcomingEvents > 99 ? "99+" : upcomingEvents}
                            </span>
                          )}
                          {showUnreadBadge && (
                            <span
                              data-testid="nav-inbox-unread"
                              aria-label={`${totalUnread} ${t(totalUnread === 1 ? "unread conversation" : "unread conversations")}`}
                              title={`${totalUnread} ${t(totalUnread === 1 ? "unread conversation" : "unread conversations")}`}
                              className={cn(PILL, "bg-primary text-primary-foreground")}
                            >
                              {totalUnread > 99 ? "99+" : totalUnread}
                            </span>
                          )}
                        </Link>
                        {isInbox && isActive ? (
                          <ul
                            aria-label={navCopy.inboxViews}
                            data-no-translate
                            className="mb-1 ml-[19px] mt-0.5 flex flex-col gap-px border-l border-border pl-2.5"
                          >
                            {INBOX_SHORTCUTS.map((shortcut) => {
                              const current = activeShortcut === shortcut.id;
                              const count = inboxNav?.counts ? shortcut.count(inboxNav.counts) : 0;
                              return (
                                <li key={shortcut.id}>
                                  <Link
                                    href={shortcut.href}
                                    scroll={false}
                                    // Same pathname: the route-change effect won't close the drawer.
                                    onClick={onClose}
                                    aria-current={current ? "true" : undefined}
                                    className={cn(
                                      "flex items-center gap-2 rounded-[calc(var(--radius)-2px)] px-2.5 py-2 text-[13px] outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 lg:py-[5px]",
                                      current
                                        ? "bg-muted font-medium text-foreground"
                                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                    )}
                                  >
                                    <span className="flex-1">{navCopy.shortcuts[shortcut.id]}</span>
                                    {count > 0 ? (
                                      <span
                                        data-testid={`inbox-shortcut-count-${shortcut.id}`}
                                        className={cn(
                                          PILL,
                                          shortcut.alert
                                            ? "bg-destructive text-white"
                                            : current
                                              ? "bg-background text-muted-foreground"
                                              : "bg-muted text-muted-foreground",
                                        )}
                                      >
                                        {count > 99 ? "99+" : count}
                                      </span>
                                    ) : null}
                                  </Link>
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        {/* User section */}
        <div className="shrink-0 p-3 pt-1">
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. */}
          {showAccountStrip && account?.name ? (
            <div className="mb-2 flex items-center gap-2 px-3 text-xs text-muted-foreground">
              <UsersRound className="size-3.5 shrink-0" />
              {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole ? (
                // Always render the chip — owners used to be
                // invisible here, which made them indistinguishable
                // from admins at a glance. Now everyone sees their
                // role (with a colour cue) regardless of tier.
                (() => {
                  const meta = ROLE_CHIP[accountRole];
                  const Icon = meta.icon;
                  return (
                    <span
                      className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.className}`}
                    >
                      <Icon className="size-3" />
                      {meta.label}
                    </span>
                  );
                })()
              ) : null}
            </div>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              title={profile?.email ?? undefined}
              className="flex w-full items-center gap-2.5 rounded-[14px] border border-border p-2.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-muted/60"
            >
              <span className="relative shrink-0">
                <Avatar className="size-8">
                  {profile?.avatar_url ? (
                    <AvatarImage
                      src={profile.avatar_url}
                      alt={profile.full_name ?? "Avatar"}
                    />
                  ) : null}
                  <AvatarFallback className="bg-primary text-[11px] font-bold text-primary-foreground">
                    {initials(profile?.full_name, profile?.email)}
                  </AvatarFallback>
                </Avatar>
                <AvailabilityDot
                  availability={profile?.availability}
                  className="absolute -bottom-0.5 -right-0.5 ring-card"
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-foreground">
                  {profile?.full_name ?? "Usuário"}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {profile?.availability === "away" ? t("Away") : t("Available")}
                </span>
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              <div className="p-1">
                <AvailabilityToggle />
              </div>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                Profile
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                Settings
              </DropdownMenuItem>
              {isPlatformAdmin ? (
                <DropdownMenuItem
                  render={
                    <Link
                      href="/platform"
                      prefetch={false}
                      onClick={onClose}
                      className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                    />
                  }
                >
                  <ShieldCheck className="size-4" />
                  Platform
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
