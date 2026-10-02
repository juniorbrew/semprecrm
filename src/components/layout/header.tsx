"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useBranding } from "@/hooks/use-branding";
import { useLanguage } from "@/hooks/use-language";
import { translateLiteral, type Language } from "@/lib/i18n";
import {
  LogOut,
  Menu,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  User,
} from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModeToggle } from "@/components/layout/mode-toggle";
import { PALETTE_COPY } from "@/components/layout/command-palette";
import {
  AvailabilityDot,
  AvailabilityToggle,
} from "@/components/layout/availability-toggle";

// English keys; rendered through the dictionary so `document.title`
// (set from JS, out of the DOM translator's reach) follows the language.
const pageTitles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/reports": "Reports",
  "/inbox": "Inbox",
  "/contacts": "Contacts",
  "/companies": "Companies",
  "/pipelines": "Pipelines",
  "/tasks": "Tasks",
  "/chat": "Chat",
  "/agenda": "Calendar",
  "/broadcasts": "Broadcasts",
  "/automations": "Automations",
  "/flows": "Flows",
  "/ai/agents": "AI agents",
  "/settings": "Settings",
};

export function getPageTitle(pathname: string, language: Language = "pt-BR"): string {
  const key =
    pageTitles[pathname] ??
    Object.entries(pageTitles).find(([path]) => pathname.startsWith(path))?.[1] ??
    "Dashboard";
  return translateLiteral(key, language);
}

interface HeaderProps {
  /** Wired to the shell's drawer state. Used only on mobile — the
   *  hamburger button is hidden on lg+. */
  onOpenSidebar?: () => void;
  /** Opens the command palette (also Ctrl/Cmd+K). */
  onOpenPalette?: () => void;
}

export function Header({ onOpenSidebar, onOpenPalette }: HeaderProps) {
  const pathname = usePathname();
  const { profile, signOut, isPlatformAdmin } = useAuth();
  const branding = useBranding();
  const { language } = useLanguage();
  const title = getPageTitle(pathname, language);
  const paletteCopy = PALETTE_COPY[language] ?? PALETTE_COPY["pt-BR"];

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    "U";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 lg:px-5">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — mobile only. 44×44 hit target per Apple HIG. */}
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Abrir menu"
          className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {/* White-label: the account's app name sits next to the page title
            on wide screens (the sidebar carries it on desktop, but the
            header is all a phone shows). */}
        {branding.enabled ? (
          <span className="hidden truncate text-sm text-muted-foreground md:inline lg:hidden">
            · {branding.app_name}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        {/* Command palette trigger: a field-like button on sm+, an icon on phones. */}
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label={paletteCopy.triggerAria}
          aria-keyshortcuts="Control+K Meta+K"
          aria-haspopup="dialog"
          data-no-translate
          className="flex h-10 w-10 items-center justify-center gap-2 rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:h-8 sm:w-56 sm:justify-start sm:border sm:border-border sm:bg-background sm:px-2.5 sm:text-sm md:w-64"
        >
          <Search className="size-4 shrink-0 sm:size-3.5" aria-hidden="true" />
          <span className="hidden flex-1 truncate text-left sm:inline">{paletteCopy.trigger}</span>
          <kbd className="hidden h-5 items-center rounded border border-border bg-muted px-1.5 font-sans text-[11px] font-medium text-foreground sm:inline-flex">
            Ctrl K
          </kbd>
        </button>
        <ModeToggle />

        <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted/70 focus:bg-muted/70 focus:outline-none data-popup-open:bg-muted/70 sm:gap-3 sm:pl-1 sm:pr-3"
          aria-label="Abrir menu da conta"
        >
          <span className="relative">
            <Avatar className="size-8">
              {profile?.avatar_url ? (
                <AvatarImage
                  src={profile.avatar_url}
                  alt={profile.full_name ?? "Avatar"}
                />
              ) : null}
              <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                {initial}
              </AvatarFallback>
            </Avatar>
            <AvailabilityDot
              availability={profile?.availability}
              className="absolute -bottom-0.5 -right-0.5"
            />
          </span>
          <span className="hidden text-sm font-medium text-foreground sm:inline">
            {profile?.full_name ?? "Usuário"}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-56 bg-popover text-popover-foreground ring-border"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">
              {profile?.full_name ?? "Usuário"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {profile?.email ?? ""}
            </p>
          </div>
          <div className="px-2 pb-2 pt-1">
            <AvailabilityToggle />
          </div>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=profile"
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
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <SettingsIcon className="size-4" />
            Settings
          </DropdownMenuItem>
          {isPlatformAdmin ? (
            <DropdownMenuItem
              render={
                <Link
                  href="/platform"
                  prefetch={false}
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
    </header>
  );
}
