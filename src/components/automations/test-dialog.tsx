"use client"

// "Test with a contact" — dry run of a saved automation (migration 048).
// Pick a contact, optionally type the message that would arrive, and see
// the path the rule takes: which branch each condition picks and what
// each action would do. Nothing is sent, tagged or logged.

import { useEffect, useState } from "react"
import { Check, FlaskConical, Loader2, Minus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { createClient } from "@/lib/supabase/client"
import { useLanguage } from "@/hooks/use-language"
import { cn } from "@/lib/utils"
import type { AutomationLogStepResult, AutomationTriggerType } from "@/types"

interface ContactOption {
  id: string
  name: string | null
  phone: string | null
}

interface SimulationResponse {
  gate: { wouldRun: boolean; reason?: string }
  steps: AutomationLogStepResult[]
  status: string
}

const MESSAGE_TRIGGERS = new Set<AutomationTriggerType>([
  "new_message_received",
  "first_inbound_message",
  "keyword_match",
])

export function AutomationTestDialog({
  open,
  onOpenChange,
  automationId,
  triggerType,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  automationId: string
  triggerType: AutomationTriggerType
}) {
  const { language } = useLanguage()
  const pt = language === "pt-BR"
  const [query, setQuery] = useState("")
  const [contacts, setContacts] = useState<ContactOption[]>([])
  const [contact, setContact] = useState<ContactOption | null>(null)
  const [message, setMessage] = useState("")
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SimulationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Contact search: name or phone, newest first. Debounced lightly.
  useEffect(() => {
    if (!open) return
    const handle = setTimeout(async () => {
      const supabase = createClient()
      let q = supabase
        .from("contacts")
        .select("id, name, phone")
        .order("updated_at", { ascending: false })
        .limit(20)
      const term = query.trim()
      if (term) q = q.or(`name.ilike.%${term.replace(/[%,()]/g, "")}%,phone.ilike.%${term.replace(/\D/g, "") || "_"}%`)
      const { data } = await q
      setContacts((data ?? []) as ContactOption[])
    }, 250)
    return () => clearTimeout(handle)
  }, [open, query])

  async function run() {
    if (!contact) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(`/api/automations/${automationId}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact_id: contact.id, message_text: message || undefined }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body?.error ?? (pt ? "Falha ao testar" : "Test failed"))
        return
      }
      setResult(body as SimulationResponse)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) {
          setResult(null)
          setError(null)
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4" />
            {pt ? "Testar com um contato" : "Test with a contact"}
          </DialogTitle>
          <DialogDescription>
            {pt
              ? "Simula a versão salva desta automação. Nada é enviado, marcado ou registrado."
              : "Simulates the saved version of this automation. Nothing is sent, tagged or logged."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="test-contact">
              {pt ? "Contato" : "Contact"}
            </label>
            <Input
              id="test-contact"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setContact(null)
              }}
              placeholder={pt ? "Buscar por nome ou telefone" : "Search by name or phone"}
              className="bg-muted text-foreground"
            />
            {!contact && contacts.length > 0 && (
              <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border">
                {contacts.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setContact(c)
                        setQuery(c.name || c.phone || "")
                      }}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <span className="truncate text-foreground">{c.name || c.phone}</span>
                      {c.name && <span className="ml-2 text-xs text-muted-foreground">{c.phone}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {MESSAGE_TRIGGERS.has(triggerType) && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="test-message">
                {pt ? "Mensagem recebida (exemplo)" : "Incoming message (example)"}
              </label>
              <Textarea
                id="test-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={2}
                placeholder={pt ? "ex.: qual o preço?" : "e.g. what is the price?"}
                className="bg-muted text-foreground"
              />
            </div>
          )}

          <Button onClick={run} disabled={!contact || running} className="w-full">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            {pt ? "Simular" : "Simulate"}
          </Button>

          {error && (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          {result && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <p
                className={cn(
                  "text-xs font-medium",
                  result.gate.wouldRun ? "text-primary" : "text-amber-500",
                )}
              >
                {result.gate.wouldRun
                  ? pt
                    ? "Um evento real executaria esta automação agora."
                    : "A real event would run this automation now."
                  : `${pt ? "Um evento real NÃO executaria agora" : "A real event would NOT run it now"}: ${result.gate.reason ?? ""}`}
              </p>
              {result.steps.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {pt ? "Nenhuma etapa no caminho." : "No steps on the path."}
                </p>
              ) : (
                <ol className="space-y-1.5">
                  {result.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <StepIcon status={s.status} />
                      <span className="text-foreground">{describe(s, pt)}</span>
                    </li>
                  ))}
                </ol>
              )}
              {result.status === "no_action" && (
                <p className="text-xs text-muted-foreground">
                  {pt
                    ? "Resultado: sem ação — o caminho escolhido pelas condições não tem nenhuma ação."
                    : "Result: no action — the path the conditions chose has no action."}
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StepIcon({ status }: { status: string }) {
  const ok = status === "success"
  const skipped = status === "skipped"
  return (
    <span
      className={cn(
        "mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full",
        ok ? "bg-primary/20 text-primary" : skipped ? "bg-muted text-muted-foreground" : "bg-red-500/20 text-red-400",
      )}
      aria-hidden
    >
      {ok ? <Check className="h-3 w-3" /> : skipped ? <Minus className="h-3 w-3" /> : <X className="h-3 w-3" />}
    </span>
  )
}

function describe(step: AutomationLogStepResult, pt: boolean): string {
  const d = step.detail ?? ""
  const branch = d.match(/^branch=(yes|no)$/)
  if (branch) {
    const yes = branch[1] === "yes"
    return pt ? `Condição → ramo "${yes ? "Sim" : "Não"}"` : `Condition → "${yes ? "Yes" : "No"}" branch`
  }
  if (d === "contato descadastrado") return pt ? "pularia: contato descadastrado" : "would skip: contact opted out"
  return d
}
