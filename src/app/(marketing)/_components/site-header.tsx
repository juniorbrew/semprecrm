import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { Logo } from "./logo";
import { MobileNav } from "./mobile-nav";

const NAV_LINKS = [
  { href: "/#funcionalidades", label: "Funcionalidades" },
  { href: "/#como-funciona", label: "Como funciona" },
  { href: "/precos", label: "Preços" },
  { href: "/contato", label: "Contato" },
];

// Async Server Component — checks auth once per request so a
// visitor who's already logged in sees "Ir para o painel" instead
// of "Entrar" / "Começar grátis" on the marketing site.
export async function SiteHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isAuthenticated = Boolean(user);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <Logo />
        <nav className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          {isAuthenticated ? (
            <Link href="/dashboard" className={buttonVariants({ variant: "default" })}>
              Ir para o painel
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                data-analytics="cta_login_click"
                className={buttonVariants({ variant: "ghost" })}
              >
                Entrar
              </Link>
              <Link
                href="/signup"
                data-analytics="cta_start_click"
                className={buttonVariants({ variant: "default" })}
              >
                Começar grátis
              </Link>
            </>
          )}
        </div>
        <MobileNav links={NAV_LINKS} isAuthenticated={isAuthenticated} />
      </div>
    </header>
  );
}
