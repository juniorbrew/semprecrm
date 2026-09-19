"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";

interface NavLink {
  href: string;
  label: string;
}

export function MobileNav({
  links,
  isAuthenticated,
}: {
  links: NavLink[];
  isAuthenticated: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative md:hidden">
      <Button
        variant="ghost"
        size="icon"
        aria-label={open ? "Fechar menu" : "Abrir menu"}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X /> : <Menu />}
      </Button>
      {open && (
        <div className="absolute inset-x-0 top-full z-50 border-b border-border bg-background px-4 py-4 shadow-lg">
          <nav className="flex flex-col gap-3">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="mt-4 flex flex-col gap-2">
            {isAuthenticated ? (
              <Link
                href="/dashboard"
                className={buttonVariants({ variant: "default" })}
                onClick={() => setOpen(false)}
              >
                Ir para o painel
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  data-analytics="cta_login_click"
                  className={buttonVariants({ variant: "outline" })}
                  onClick={() => setOpen(false)}
                >
                  Entrar
                </Link>
                <Link
                  href="/signup"
                  data-analytics="cta_start_click"
                  className={buttonVariants({ variant: "default" })}
                  onClick={() => setOpen(false)}
                >
                  Começar grátis
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
