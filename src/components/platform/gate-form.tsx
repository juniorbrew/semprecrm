"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";

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

const FIELD_CLASS =
  "border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20";

/**
 * /platform/login. Two modes:
 *  - "login": username + password → POST /api/platform/gate
 *  - "setup": first visit, no credentials yet → PUT (username,
 *    password, confirmation). Only a platform admin ever reaches
 *    this page, so setup needs no extra proof.
 */
export function PlatformGateForm({ mode }: { mode: "login" | "setup" }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // English dictionary key — rendered through `t()`.
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setup = mode === "setup";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setup && password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    const res = await fetch("/api/platform/gate", {
      method: setup ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(
        res.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : (data?.error ?? "Something went wrong"),
      );
      setLoading(false);
      return;
    }
    router.replace("/platform");
    router.refresh();
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="justify-items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" aria-hidden="true" />
          </div>
          <CardTitle className="text-xl text-foreground">
            {setup ? t("Set up panel access") : t("Master panel")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {setup
              ? t("Choose the username and password that will unlock the platform panel.")
              : t("Enter the panel username and password to continue.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
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
              <Label htmlFor="gate-username" className="text-muted-foreground">
                {t("Username")}
              </Label>
              <Input
                id="gate-username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                minLength={3}
                maxLength={40}
                className={FIELD_CLASS}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="gate-password" className="text-muted-foreground">
                {t("Password")}
              </Label>
              <Input
                id="gate-password"
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={setup ? 8 : 1}
                className={FIELD_CLASS}
              />
            </div>

            {setup && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="gate-confirm" className="text-muted-foreground">
                  {t("Confirm password")}
                </Label>
                <Input
                  id="gate-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  className={FIELD_CLASS}
                />
                <p className="text-xs text-muted-foreground">
                  {t("At least 8 characters. You can change it later in the panel.")}
                </p>
              </div>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t("Checking...") : setup ? t("Save and open panel") : t("Open panel")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
