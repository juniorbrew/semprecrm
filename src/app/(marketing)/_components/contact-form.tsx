"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trackEvent } from "@/lib/analytics";
import { formatPhone } from "@/lib/br/lookup";
import { CONTACT_LIMITS } from "@/lib/marketing/contact";

type FieldName = "name" | "email" | "phone" | "company" | "message";
type FieldErrors = Partial<Record<FieldName, string>>;

const FIELD_ORDER: FieldName[] = ["name", "email", "phone", "company", "message"];

// Move focus to the first invalid field (in visual order) so keyboard and
// screen-reader users land on the error instead of staying on the submit button.
function focusFirstError(form: HTMLFormElement, errors: FieldErrors) {
  const first = FIELD_ORDER.find((field) => errors[field]);
  if (!first) return;
  const control = form.elements.namedItem(first);
  if (control instanceof HTMLElement) control.focus();
}

// The API already returns a specific pt-BR message per field (see
// src/lib/marketing/contact.ts); this maps that text back to the field it
// describes so the error can render under the right input instead of only
// as a toast that doesn't say which field to fix.
function fieldFromServerError(message: string): keyof FieldErrors | null {
  if (/^nome/i.test(message)) return "name";
  if (/e-mail/i.test(message)) return "email";
  if (/whatsapp|telefone/i.test(message)) return "phone";
  if (/^empresa/i.test(message)) return "company";
  if (/^mensagem/i.test(message)) return "message";
  return null;
}

export function ContactForm() {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [phone, setPhone] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const sentRef = useRef<HTMLDivElement>(null);

  // The form is replaced by the confirmation; focusing it makes the success
  // message the next thing assistive tech reads instead of silently losing focus.
  useEffect(() => {
    if (sent) sentRef.current?.focus();
  }, [sent]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    const name = String(formData.get("name") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const phone = String(formData.get("phone") ?? "").trim();
    const company = String(formData.get("company") ?? "").trim();
    const message = String(formData.get("message") ?? "").trim();
    const website = String(formData.get("website") ?? "").trim();

    const errors: FieldErrors = {};
    if (!name) errors.name = "Digite seu nome.";
    if (!email) errors.email = "Digite seu e-mail.";
    if (!phone) errors.phone = "Informe seu WhatsApp ou telefone com DDD.";
    if (!message) errors.message = "Escreva sua mensagem.";
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusFirstError(form, errors);
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    try {
      const response = await fetch("/api/marketing/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, company, message, website }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        const serverMessage = body?.error ?? "Não foi possível enviar sua mensagem. Tente novamente.";
        const field = fieldFromServerError(serverMessage);
        if (field) {
          setFieldErrors({ [field]: serverMessage });
          focusFirstError(form, { [field]: serverMessage });
        } else {
          toast.error(serverMessage);
        }
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
      <div
        ref={sentRef}
        tabIndex={-1}
        role="status"
        className="rounded-xl border border-border bg-card p-6 text-center outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
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
        <Input
          id="name"
          name="name"
          autoComplete="name"
          required
          maxLength={CONTACT_LIMITS.name}
          aria-invalid={Boolean(fieldErrors.name)}
          aria-describedby={fieldErrors.name ? "name-error" : undefined}
          onChange={() => fieldErrors.name && setFieldErrors((prev) => ({ ...prev, name: undefined }))}
        />
        {fieldErrors.name && (
          <p id="name-error" role="alert" className="text-xs text-destructive">
            {fieldErrors.name}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">E-mail</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          spellCheck={false}
          required
          maxLength={CONTACT_LIMITS.email}
          aria-invalid={Boolean(fieldErrors.email)}
          aria-describedby={fieldErrors.email ? "email-error" : undefined}
          onChange={() => fieldErrors.email && setFieldErrors((prev) => ({ ...prev, email: undefined }))}
        />
        {fieldErrors.email && (
          <p id="email-error" role="alert" className="text-xs text-destructive">
            {fieldErrors.email}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="phone">WhatsApp / telefone</Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="(11) 91234-5678"
          required
          maxLength={CONTACT_LIMITS.phone}
          value={phone}
          aria-invalid={Boolean(fieldErrors.phone)}
          aria-describedby={fieldErrors.phone ? "phone-error" : undefined}
          onChange={(e) => {
            setPhone(formatPhone(e.target.value));
            if (fieldErrors.phone) setFieldErrors((prev) => ({ ...prev, phone: undefined }));
          }}
        />
        {fieldErrors.phone && (
          <p id="phone-error" role="alert" className="text-xs text-destructive">
            {fieldErrors.phone}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="company">Empresa</Label>
        <Input
          id="company"
          name="company"
          autoComplete="organization"
          maxLength={CONTACT_LIMITS.company}
          aria-invalid={Boolean(fieldErrors.company)}
          aria-describedby={fieldErrors.company ? "company-error" : undefined}
          onChange={() => fieldErrors.company && setFieldErrors((prev) => ({ ...prev, company: undefined }))}
        />
        {fieldErrors.company && (
          <p id="company-error" role="alert" className="text-xs text-destructive">
            {fieldErrors.company}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="message">Mensagem</Label>
        <Textarea
          id="message"
          name="message"
          autoComplete="off"
          required
          maxLength={CONTACT_LIMITS.message}
          rows={5}
          aria-invalid={Boolean(fieldErrors.message)}
          aria-describedby={fieldErrors.message ? "message-error" : undefined}
          onChange={() => fieldErrors.message && setFieldErrors((prev) => ({ ...prev, message: undefined }))}
        />
        {fieldErrors.message && (
          <p id="message-error" role="alert" className="text-xs text-destructive">
            {fieldErrors.message}
          </p>
        )}
      </div>
      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? (
          <>
            <Loader2 aria-hidden="true" className="animate-spin" />
            Enviando…
          </>
        ) : (
          "Enviar mensagem"
        )}
      </Button>
    </form>
  );
}
