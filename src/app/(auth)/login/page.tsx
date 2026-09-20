"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { MFA_PATH, needsMfaChallenge } from "@/lib/auth/mfa";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { friendlyAuthError } from "../_lib/auth-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MessageSquare, UsersRound } from "lucide-react";

/**
 * Greeting copy, language-keyed rather than `t()`: the catalogue's
 * "Welcome back" is the gendered "Bem-vindo de volta", and the login
 * page must read gender-neutral in pt-BR.
 */
const GREETING_COPY: Record<Language, { title: string; noAccount: string }> = {
  "pt-BR": {
    title: "Que bom ter você de volta",
    noAccount: "Ainda não tem conta?",
  },
  "en-US": {
    title: "Welcome back",
    noAccount: "Don't have an account?",
  },
};

// `useSearchParams` opts the component out of static prerendering
// unless it sits under a Suspense boundary. We split the form into
// a child component so the outer page can prerender the chrome
// (background, card frame) while the form hydrates with the query
// string on the client.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get("invite");
  // Set by /auth/callback after an e-mail link: expired/used link, or
  // e-mail confirmed (when the confirmation did not open a session).
  const notice = searchParams.get("notice");
  const { t, language } = useLanguage();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // English dictionary key — rendered through `t()`.
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      console.error("[login] sign-in failed:", error.message);
      setError(friendlyAuthError(error));
      setLoading(false);
      return;
    }

    const destination = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/dashboard";

    // MFA (round 2 spec, section 7): the password only buys an `aal1`
    // session. When the user owns a verified TOTP factor, Supabase
    // reports `nextLevel === 'aal2'` and the code is asked on /mfa
    // before the destination. The middleware enforces the same rule
    // for direct navigation; this just skips the extra bounce.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (needsMfaChallenge(aal)) {
      router.push(`${MFA_PATH}?next=${encodeURIComponent(destination)}`);
      return;
    }

    router.push(destination);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {inviteToken ? (
              <UsersRound className="h-6 w-6 text-primary" />
            ) : (
              <MessageSquare className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {inviteToken ? (
              t("Sign in to accept")
            ) : (
              <span data-no-translate>{GREETING_COPY[language].title}</span>
            )}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken
              ? t("Sign in and we'll take you to the invitation.")
              : t("Sign in to your account")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {!error && notice === "link_invalid" && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-500">
                {t("This link is invalid or has expired. Request a new one.")}
              </div>
            )}
            {!error && notice === "email_confirmed" && (
              <div className="rounded-lg border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-primary">
                {t("E-mail confirmed. Sign in to continue.")}
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {t(error)}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t("Email")}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t("you@example.com")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-muted-foreground">
                  {t("Password")}
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-sm text-primary hover:text-primary/80"
                >
                  {t("Forgot password?")}
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                placeholder={t("Enter your password")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t("Signing in...") : t("Sign in")}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            <span data-no-translate>{GREETING_COPY[language].noAccount}</span>{" "}
            <Link
              href={
                inviteToken
                  ? `/signup?invite=${encodeURIComponent(inviteToken)}`
                  : "/signup"
              }
              className="text-primary hover:text-primary/80"
            >
              {t("Create account")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
