"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";

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

/**
 * /platform/acesso — edit the username and password that unlock the
 * panel. The current password is always required; the new password
 * is optional (leave blank to keep it).
 */
export function PlatformGateSettings({ username: initialUsername }: { username: string }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [username, setUsername] = useState(initialUsername);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const changedUsername = username.trim().toLowerCase() !== initialUsername;
  const canSave = current.length > 0 && (changedUsername || next.length > 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next && next !== confirm) {
      toast.error(t("Passwords do not match"));
      return;
    }
    setSaving(true);
    const res = await fetch("/api/platform/gate", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: current,
        ...(changedUsername ? { username } : {}),
        ...(next ? { newPassword: next } : {}),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(
        res.status === 429
          ? t("Too many attempts. Wait a minute and try again.")
          : t(data?.error ?? "Failed to save"),
      );
      return;
    }
    toast.success(t("Panel access updated"));
    setCurrent("");
    setNext("");
    setConfirm("");
    router.refresh();
  };

  return (
    <Card className="mx-auto w-full max-w-lg border-border bg-card">
      <CardHeader>
        <div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-primary/10">
          <KeyRound className="size-5 text-primary" aria-hidden="true" />
        </div>
        <CardTitle className="text-foreground">{t("Panel access")}</CardTitle>
        <CardDescription>
          {t("Username and password asked on the master panel. They are separate from your CRM login.")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="acc-username">{t("Username")}</Label>
            <Input
              id="acc-username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              maxLength={40}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="acc-current">{t("Current password")}</Label>
            <Input
              id="acc-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="acc-next">{t("New password")}</Label>
              <Input
                id="acc-next"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                minLength={8}
                placeholder={t("Leave blank to keep")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="acc-confirm">{t("Confirm new password")}</Label>
              <Input
                id="acc-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={8}
                disabled={!next}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("At least 8 characters. Changing the password signs the panel out on other devices.")}
          </p>

          <div className="flex justify-end">
            <Button type="submit" disabled={!canSave || saving}>
              {saving ? t("Saving...") : t("Save changes")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
