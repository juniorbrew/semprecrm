import Link from "next/link";

import { Logo } from "./logo";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between lg:px-8">
        <div className="max-w-sm space-y-2">
          <Logo />
          <p className="text-sm text-muted-foreground">
            CRM para equipes que vendem e atendem pelo WhatsApp.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Produto</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link href="/#funcionalidades" className="hover:text-foreground">
                  Funcionalidades
                </Link>
              </li>
              <li>
                <Link href="/precos" className="hover:text-foreground">
                  Preços
                </Link>
              </li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Conta</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link href="/login" data-analytics="cta_login_click" className="hover:text-foreground">
                  Entrar
                </Link>
              </li>
              <li>
                <Link href="/signup" data-analytics="cta_start_click" className="hover:text-foreground">
                  Começar grátis
                </Link>
              </li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Empresa</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link href="/contato" className="hover:text-foreground">
                  Contato
                </Link>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div className="border-t border-border px-4 py-4 text-center text-xs text-muted-foreground sm:px-6 lg:px-8">
        © {new Date().getFullYear()} SempreCRM. Todos os direitos reservados.
      </div>
    </footer>
  );
}
