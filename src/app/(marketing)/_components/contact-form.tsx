"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trackEvent } from "@/lib/analytics";
import { CONTACT_LIMITS } from "@/lib/marketing/contact";

export function ContactForm() {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    const name = String(formData.get("name") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const company = String(formData.get("company") ?? "").trim();
    const message = String(formData.get("message") ?? "").trim();
    const website = String(formData.get("website") ?? "").trim();

    if (!name || !email || !message) {
      toast.error("Preencha nome, e-mail e mensagem.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/marketing/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, company, message, website }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? "Não foi possível enviar sua mensagem. Tente novamente.");
        return;
      }

      trackEvent("contact_form_submit");
      setSent(true);
      form.reset();
    } catch {
      toast.error("Não foi possível enviar sua mensagem. Verifique sua conexão e tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center">
        <p className="font-medium text-foreground">Mensagem enviada!</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Recebemos sua mensagem e vamos responder pelo e-mail informado.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Honeypot: hidden from sighted users and screen readers alike
          (off-screen, not display:none, so a bot's DOM-based fill still
          catches it) — a real visitor never fills this. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Deixe este campo em branco</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="name">Nome</Label>
        <Input id="name" name="name" required maxLength={CONTACT_LIMITS.name} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" name="email" type="email" required maxLength={CONTACT_LIMITS.email} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="company">Empresa</Label>
        <Input id="company" name="company" maxLength={CONTACT_LIMITS.company} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="message">Mensagem</Label>
        <Textarea id="message" name="message" required maxLength={CONTACT_LIMITS.message} rows={5} />
      </div>
      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? "Enviando..." : "Enviar mensagem"}
      </Button>
    </form>
  );
}
