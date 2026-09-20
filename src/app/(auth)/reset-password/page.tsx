"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, CheckCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/hooks/use-language";
import { createClient } from "@/lib/supabase/client";
import { friendlyAuthError } from "../_lib/auth-errors";

const FIELD_CLASS =
  "border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20";
const MIN_PASSWORD = 8;

/**
 * /reset-password — reached from the recovery e-mail via
 * /auth/callback, which already turned the link into a session.
 * Without a session (link expired, opened twice) we say so and
 * offer a new link instead of a silent failure.
 */
export default function ResetPasswordPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const supabase = createClient();
  const [ready, setReady] = useState<"checking" | "ok" | "no-session">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // English dictionary key — rendered through `t()`.
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setReady(data.session ? "ok" : "no-session");
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD) {
      setError("Password must have at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      console.error("[reset-password] update failed:", error.message);
      setError(friendlyAuthError(error));
      setLoading(false);
      return;
    }
    setDone(true);
    setTimeout(() => router.replace("/dashboard"), 1500);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="justify-items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {done ? (
              <CheckCircle className="h-6 w-6 text-primary" aria-hidden="true" />
            ) : (
              <KeyRound className="h-6 w-6 text-primary" aria-hidden="true" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {done
              ? t("Password updated")
              : ready === "no-session"
                ? t("Link expired")
                : t("Choose a new password")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {done
              ? t("Taking you to the app…")
              : ready === "no-session"
                ? t("This link is invalid or has expired. Request a new one.")
                : t("It will replace your current password right away.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ready === "no-session" && !done ? (
            <Link
              href="/forgot-password"
              className="flex h-10 w-full items-center justify-center rounded-lg bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("Send reset link")}
            </Link>
          ) : ready === "ok" && !done ? (
            <form onSubmit={submit} className="flex flex-col gap-4">
              {error && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
                >
                  {t(error)}
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-password" className="text-muted-foreground">
                  {t("New password")}
                </Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={MIN_PASSWORD}
                  className={FIELD_CLASS}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="confirm-password" className="text-muted-foreground">
                  {t("Confirm new password")}
                </Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={MIN_PASSWORD}
                  className={FIELD_CLASS}
                />
                <p className="text-xs text-muted-foreground">{t("At least 8 characters.")}</p>
              </div>
              <Button
                type="submit"
                disabled={loading}
                className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {loading ? t("Saving...") : t("Save new password")}
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
