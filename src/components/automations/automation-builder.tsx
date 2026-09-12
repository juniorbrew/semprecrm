"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeft,
  ChevronRight,
  Plus,
  Trash2,
  MessageSquare,
  FileText,
  Tag,
  TagIcon,
  UserCheck,
  PencilLine,
  Briefcase,
  Hourglass,
  GitBranch,
  Webhook,
  CircleSlash,
  Zap,
  Loader2,
  ArrowDown,
  ArrowUp,
  X,
  Filter,
  MousePointerClick,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import type {
  AccountMember,
  AutomationStepType,
  AutomationTriggerType,
  CustomField,
  KeywordMatchTriggerConfig,
  MessageTemplate,
  Tag as TagRecord,
} from "@/types"
import { createClient } from "@/lib/supabase/client"
import { useLanguage } from "@/hooks/use-language"
import type { Language } from "@/lib/i18n"
import { cn } from "@/lib/utils"

// ------------------------------------------------------------
// Types (builder-local — mirror the flattened rows we POST)
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client id; the API assigns real UUIDs server-side. */
  cid: string
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branches?: { yes: BuilderStep[]; no: BuilderStep[] }
}

export interface BuilderInitial {
  id?: string
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  is_active: boolean
  steps: BuilderStep[]
}

// ------------------------------------------------------------
// Step metadata — one source of truth for icon + label (English key,
// translated through t()) + accent colour.
// ------------------------------------------------------------

interface StepMeta {
  label: string
  icon: typeof Zap
  /** Tinted 1px card border per step family (the icon tile carries
   *  the colour; the border only whispers it). */
  border: string
  /** Icon tile colours. */
  tile: string
}

const ACTION_TILE = "bg-primary/10 text-primary"

const STEP_META: Record<AutomationStepType, StepMeta> = {
  send_message: { label: "Send message", icon: MessageSquare, border: "border-border", tile: ACTION_TILE },
  send_template: { label: "Send Template", icon: FileText, border: "border-border", tile: ACTION_TILE },
  add_tag: { label: "Add tag", icon: Tag, border: "border-border", tile: ACTION_TILE },
  remove_tag: { label: "Remove Tag", icon: TagIcon, border: "border-border", tile: ACTION_TILE },
  assign_conversation: { label: "Assign conversation", icon: UserCheck, border: "border-border", tile: ACTION_TILE },
  update_contact_field: { label: "Update Contact Field", icon: PencilLine, border: "border-border", tile: ACTION_TILE },
  create_deal: { label: "Create deal", icon: Briefcase, border: "border-border", tile: ACTION_TILE },
  wait: { label: "Wait", icon: Hourglass, border: "border-border", tile: "bg-muted text-muted-foreground" },
  condition: { label: "Condition (If/Else)", icon: GitBranch, border: "border-amber-500/40", tile: "bg-amber-500/10 text-amber-500" },
  send_webhook: { label: "Send Webhook", icon: Webhook, border: "border-border", tile: ACTION_TILE },
  close_conversation: { label: "Close conversation", icon: CircleSlash, border: "border-border", tile: ACTION_TILE },
}

/** Grouped menu for the "add action" pickers. */
const STEP_GROUPS: { label: string; types: AutomationStepType[] }[] = [
  { label: "Messages", types: ["send_message", "send_template"] },
  { label: "Contact", types: ["add_tag", "remove_tag", "update_contact_field", "create_deal"] },
  { label: "Conversation", types: ["assign_conversation", "close_conversation"] },
  { label: "Flow control", types: ["wait", "condition", "send_webhook"] },
]

const TRIGGER_OPTIONS: { value: AutomationTriggerType; label: string; hint: string }[] = [
  { value: "new_message_received", label: "New Message Received", hint: "Any incoming message" },
  {
    value: "first_inbound_message",
    label: "First Message from Contact",
    hint: "First time this contact ever messages you (works for manually-added contacts too)",
  },
  { value: "keyword_match", label: "Keyword Match", hint: "Message contains specific keyword(s)" },
  { value: "new_contact_created", label: "New Contact Created", hint: "When a contact is auto-created from an incoming message" },
  { value: "conversation_assigned", label: "Conversation Assigned", hint: "When assigned to an agent" },
  { value: "tag_added", label: "Tag Added", hint: "When a tag is added to a contact" },
  { value: "time_based", label: "Time-Based", hint: "On a recurring schedule" },
]

function cid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { text: "" }
    case "send_template":
      return { template_name: "", language: "pt_BR" }
    case "add_tag":
    case "remove_tag":
      return { tag_id: "" }
    case "assign_conversation":
      return { mode: "round_robin" }
    case "update_contact_field":
      return { field: "name", value: "" }
    case "create_deal":
      return { pipeline_id: "", stage_id: "", title: "", value: 0 }
    case "wait":
      return { amount: 1, unit: "hours" }
    case "condition":
      return { subject: "tag_presence", operand: "", value: "" }
    case "send_webhook":
      return { url: "", headers: {}, body_template: "" }
    case "close_conversation":
      return {}
    default:
      return {}
  }
}

function newStep(type: AutomationStepType): BuilderStep {
  return {
    cid: cid(),
    step_type: type,
    step_config: blankConfig(type),
    branches: type === "condition" ? { yes: [], no: [] } : undefined,
  }
}

// ------------------------------------------------------------
// Account resources (tags, members, approved templates)
//
// Loaded once at the builder root and shared via context so the
// tag / agent / template pickers below can offer existing resources
// by name instead of asking the user to paste raw UUIDs. Every picker
// falls back to a raw input when its list is empty (fresh account or
// an older deployment), so an automation is always authorable.
// ------------------------------------------------------------

interface AutomationResources {
  tags: TagRecord[]
  members: AccountMember[]
  templates: MessageTemplate[]
  customFields: CustomField[]
}

const EMPTY_RESOURCES: AutomationResources = {
  tags: [],
  members: [],
  templates: [],
  customFields: [],
}

const ResourcesContext = createContext<AutomationResources>(EMPTY_RESOURCES)

function useResources(): AutomationResources {
  return useContext(ResourcesContext)
}

function ResourcesProvider({ children }: { children: ReactNode }) {
  const [tags, setTags] = useState<TagRecord[]>([])
  const [members, setMembers] = useState<AccountMember[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [customFields, setCustomFields] = useState<CustomField[]>([])

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    // Tags, templates and custom fields come straight from the DB — RLS
    // scopes them to the caller's account. Only APPROVED templates can
    // actually be sent (anything else 400s at send time), matching the
    // broadcast picker.
    void (async () => {
      const [tagsRes, templatesRes, customFieldsRes] = await Promise.all([
        supabase.from("tags").select("*").order("name"),
        supabase
          .from("message_templates")
          .select("*")
          .eq("status", "APPROVED")
          .order("name"),
        supabase.from("custom_fields").select("*").order("field_name"),
      ])
      if (cancelled) return
      setTags((tagsRes.data as TagRecord[] | null) ?? [])
      setTemplates((templatesRes.data as MessageTemplate[] | null) ?? [])
      setCustomFields((customFieldsRes.data as CustomField[] | null) ?? [])
    })()

    // Members go through the API so we inherit its email-visibility
    // rules (agents/viewers don't see emails). Unreachable on older
    // deployments → pickers fall back to a raw agent-id input.
    void (async () => {
      try {
        const res = await fetch("/api/account/members", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { members?: AccountMember[] }
        if (!cancelled) setMembers(json.members ?? [])
      } catch {
        // Members endpoint absent — caller falls back to raw input.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo(
    () => ({ tags, members, templates, customFields }),
    [tags, members, templates, customFields],
  )

  return <ResourcesContext.Provider value={value}>{children}</ResourcesContext.Provider>
}

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

/** Tag dropdown by name + color, storing the tag's id. Falls back to a
 *  raw id input when no tags exist yet. */
function TagSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { tags } = useResources()
  if (tags.length === 0) {
    return (
      <Input
        placeholder="Tag id"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = tags.find((t) => t.id === value)
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: selected?.color ?? "transparent" }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">Select a tag…</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
        {/* Preserve a saved tag that's since been deleted so editing an
            existing automation doesn't silently drop it. */}
        {value && !selected && (
          <option value={value}>{value} (unknown tag)</option>
        )}
      </select>
    </div>
  )
}

/** Contact-field dropdown for "Update Contact Field": built-in columns plus
 *  any account custom fields (stored as `custom:<id>`). A saved custom field
 *  that's since been deleted is preserved as a labelled option so editing an
 *  existing automation doesn't silently drop it. */
function ContactFieldSelect({
  value,
  onChange,
  builtInOnly = false,
}: {
  value: string
  onChange: (v: string) => void
  /** Conditions read raw contact columns, so custom fields are hidden. */
  builtInOnly?: boolean
}) {
  const { customFields } = useResources()
  const customValue = value.startsWith("custom:") ? value : ""
  const knownCustom =
    customValue && customFields.some((f) => `custom:${f.id}` === customValue)
  return (
    <select
      value={value || "name"}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="name">Nome</option>
      <option value="email">E-mail</option>
      <option value="company">Empresa</option>
      {!builtInOnly && customFields.length > 0 && (
        <optgroup label="Campos personalizados">
          {customFields.map((f) => (
            <option key={f.id} value={`custom:${f.id}`}>
              {f.field_name}
            </option>
          ))}
        </optgroup>
      )}
      {customValue && !knownCustom && (
        <option value={customValue}>{customValue} (unknown field)</option>
      )}
    </select>
  )
}

/** Agent dropdown by name, storing the member's user_id. Falls back to
 *  a raw id input when the member list is unavailable. */
function AgentSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { members } = useResources()
  if (members.length === 0) {
    return (
      <Input
        placeholder="Agent id"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = members.find((m) => m.user_id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">Select an agent…</option>
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
      {value && !selected && (
        <option value={value}>{value} (unknown agent)</option>
      )}
    </select>
  )
}

/** Template dropdown showing approved templates by name + language,
 *  storing both template_name and language. Falls back to manual name +
 *  language inputs when no approved templates are synced yet. */
function SendTemplateFields({
  templateName,
  language,
  onChange,
}: {
  templateName: string
  language: string
  onChange: (patch: { template_name: string; language: string }) => void
}) {
  const { templates } = useResources()
  const { t } = useLanguage()

  if (templates.length === 0) {
    return (
      <>
        <FieldBlock label={t("Template name")}>
          <Input
            value={templateName}
            onChange={(e) =>
              onChange({ template_name: e.target.value, language })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("Language")}>
          <Input
            value={language}
            onChange={(e) =>
              onChange({ template_name: templateName, language: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  // Encode name + language in the option value so two templates that
  // share a name across languages stay distinct.
  const toValue = (name: string, lang: string) => `${name}::${lang}`
  const current = templateName ? toValue(templateName, language) : ""
  const hasMatch = templates.some(
    (t) => toValue(t.name, t.language ?? "en_US") === current,
  )

  return (
    <FieldBlock label={t("Template")}>
      <select
        value={current}
        onChange={(e) => {
          const [name, lang] = e.target.value.split("::")
          onChange({ template_name: name ?? "", language: lang ?? "" })
        }}
        className={SELECT_CLASS}
      >
        <option value="">Select a template…</option>
        {templates.map((t) => {
          const lang = t.language ?? "en_US"
          return (
            <option key={t.id} value={toValue(t.name, lang)}>
              {t.name} ({lang})
            </option>
          )
        })}
        {current && !hasMatch && (
          <option value={current}>
            {templateName} ({language || "unknown"}) — not in approved list
          </option>
        )}
      </select>
    </FieldBlock>
  )
}

// ------------------------------------------------------------
// Tree addressing
//
// A ListLoc names one list of steps: the root list, or the yes/no
// branch of a condition step (itself addressed by a StepPath). A
// StepPath is a list plus an index. Every mutation below is expressed
// as "replace the list at loc", which keeps the recursion tiny and
// makes nested branches behave exactly like the root.
// ------------------------------------------------------------

type Branch = "yes" | "no"

type ListLoc =
  | { kind: "root" }
  | { kind: "branch"; condPath: StepPath; branch: Branch }

interface StepPath {
  loc: ListLoc
  index: number
}

const ROOT: ListLoc = { kind: "root" }

function getList(steps: BuilderStep[], loc: ListLoc): BuilderStep[] {
  if (loc.kind === "root") return steps
  const cond = getStep(steps, loc.condPath)
  return cond?.branches?.[loc.branch] ?? []
}

function getStep(steps: BuilderStep[], path: StepPath): BuilderStep | undefined {
  return getList(steps, path.loc)[path.index]
}

function setList(steps: BuilderStep[], loc: ListLoc, next: BuilderStep[]): BuilderStep[] {
  if (loc.kind === "root") return next
  return mapStep(steps, loc.condPath, (cond) => ({
    ...cond,
    branches: {
      yes: cond.branches?.yes ?? [],
      no: cond.branches?.no ?? [],
      [loc.branch]: next,
    },
  }))
}

function mapStep(
  steps: BuilderStep[],
  path: StepPath,
  fn: (s: BuilderStep) => BuilderStep,
): BuilderStep[] {
  const list = getList(steps, path.loc)
  return setList(
    steps,
    path.loc,
    list.map((s, i) => (i === path.index ? fn(s) : s)),
  )
}

function insertStep(steps: BuilderStep[], loc: ListLoc, index: number, node: BuilderStep): BuilderStep[] {
  const list = [...getList(steps, loc)]
  list.splice(index, 0, node)
  return setList(steps, loc, list)
}

function removeStep(steps: BuilderStep[], path: StepPath): BuilderStep[] {
  const list = getList(steps, path.loc).filter((_, i) => i !== path.index)
  return setList(steps, path.loc, list)
}

function moveStep(steps: BuilderStep[], path: StepPath, direction: -1 | 1): BuilderStep[] {
  const list = [...getList(steps, path.loc)]
  const j = path.index + direction
  if (j < 0 || j >= list.length) return steps
  ;[list[path.index], list[j]] = [list[j], list[path.index]]
  return setList(steps, path.loc, list)
}

interface Located {
  step: BuilderStep
  path: StepPath
}

/** Depth-first search by client id. */
function findByCid(steps: BuilderStep[], cid: string, loc: ListLoc = ROOT): Located | null {
  const list = getList(steps, loc)
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    const path: StepPath = { loc, index: i }
    if (s.cid === cid) return { step: s, path }
    if (s.branches) {
      const inYes = findByCid(steps, cid, { kind: "branch", condPath: path, branch: "yes" })
      if (inYes) return inYes
      const inNo = findByCid(steps, cid, { kind: "branch", condPath: path, branch: "no" })
      if (inNo) return inNo
    }
  }
  return null
}

// ------------------------------------------------------------
// Gate chain
//
// Chatwoot-style "Conditions" (all must be true, then run the actions)
// map onto the existing tree without any new persistence: a gate is a
// condition step that is the ONLY step of its list and whose "no"
// branch is empty. A chain of gates nests through the "yes" branches;
// the innermost list holds the actions. Anything else (a condition
// with an "else" branch, or siblings) stays a regular branching step
// inside the actions group.
// ------------------------------------------------------------

interface GateChain {
  gates: Located[]
  actionsLoc: ListLoc
  actions: BuilderStep[]
}

function gateChain(steps: BuilderStep[]): GateChain {
  const gates: Located[] = []
  let loc: ListLoc = ROOT
  let list = steps
  while (
    list.length === 1 &&
    list[0].step_type === "condition" &&
    (list[0].branches?.no.length ?? 0) === 0
  ) {
    const path: StepPath = { loc, index: 0 }
    gates.push({ step: list[0], path })
    loc = { kind: "branch", condPath: path, branch: "yes" }
    list = list[0].branches?.yes ?? []
  }
  return { gates, actionsLoc: loc, actions: list }
}

// ------------------------------------------------------------
// Human-readable summaries (one line per card)
// ------------------------------------------------------------

function excerpt(text: string, max = 90): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine
}

function conditionSummary(
  cfg: Record<string, unknown>,
  res: AutomationResources,
  lang: Language,
): string {
  const pt = lang === "pt-BR"
  const operand = String(cfg.operand ?? "")
  const value = String(cfg.value ?? "")
  switch (cfg.subject) {
    case "tag_presence": {
      const tag = res.tags.find((t) => t.id === operand)
      const name = tag?.name || operand
      if (!name) return pt ? "Contato tem a etiqueta … (escolha uma)" : "Contact has tag … (pick one)"
      return pt ? `Contato tem a etiqueta "${name}"` : `Contact has tag "${name}"`
    }
    case "contact_field": {
      const fieldLabel =
        operand === "email" ? "E-mail" : operand === "company" ? (pt ? "Empresa" : "Company") : pt ? "Nome" : "Name"
      return pt
        ? `${fieldLabel} do contato é igual a "${value}"`
        : `Contact ${fieldLabel.toLowerCase()} equals "${value}"`
    }
    case "message_content":
      return pt ? `Mensagem contém "${value || "…"}"` : `Message contains "${value || "…"}"`
    case "time_of_day": {
      const [from, to] = operand.split("-")
      if (!from || !to) return pt ? "Horário entre … e …" : "Time between … and …"
      return pt ? `Horário entre ${from} e ${to}` : `Time between ${from} and ${to}`
    }
    default:
      return pt ? "Condição não configurada" : "Condition not configured"
  }
}

function waitUnitLabel(unit: string, amount: number, lang: Language): string {
  const pt = lang === "pt-BR"
  const one = amount === 1
  switch (unit) {
    case "minutes":
      return pt ? (one ? "minuto" : "minutos") : one ? "minute" : "minutes"
    case "days":
      return pt ? (one ? "dia" : "dias") : one ? "day" : "days"
    default:
      return pt ? (one ? "hora" : "horas") : one ? "hour" : "hours"
  }
}

function stepSummary(step: BuilderStep, res: AutomationResources, lang: Language): string {
  const pt = lang === "pt-BR"
  const c = step.step_config
  switch (step.step_type) {
    case "send_message": {
      const text = String(c.text ?? "")
      return text.trim() ? `“${excerpt(text)}”` : pt ? "Sem texto ainda" : "No text yet"
    }
    case "send_template": {
      const name = String(c.template_name ?? "")
      return name ? `${pt ? "Modelo" : "Template"}: ${name}${c.language ? ` (${c.language})` : ""}` : pt ? "Escolha um modelo" : "Pick a template"
    }
    case "add_tag":
    case "remove_tag": {
      const tag = res.tags.find((t) => t.id === c.tag_id)
      const name = tag?.name || (c.tag_id ? String(c.tag_id) : "")
      return name ? `${pt ? "Etiqueta" : "Tag"}: ${name}` : pt ? "Escolha uma etiqueta" : "Pick a tag"
    }
    case "assign_conversation": {
      if (c.mode === "specific") {
        const m = res.members.find((x) => x.user_id === c.agent_id)
        const who = m?.full_name || m?.email || (c.agent_id ? String(c.agent_id) : "")
        return who ? `${pt ? "Para" : "To"}: ${who}` : pt ? "Escolha um agente" : "Pick an agent"
      }
      return pt ? "Distribuição circular entre os agentes" : "Round-robin across agents"
    }
    case "update_contact_field": {
      const field = String(c.field ?? "name")
      const label =
        field === "email" ? "E-mail" : field === "company" ? (pt ? "Empresa" : "Company") : field.startsWith("custom:") ? res.customFields.find((f) => `custom:${f.id}` === field)?.field_name ?? field : pt ? "Nome" : "Name"
      return `${label} → ${String(c.value ?? "") || "…"}`
    }
    case "create_deal": {
      const title = String(c.title ?? "")
      const value = Number(c.value ?? 0)
      const money = value
        ? new Intl.NumberFormat(pt ? "pt-BR" : "en-US", { style: "currency", currency: "BRL" }).format(value)
        : ""
      return [title || (pt ? "Sem título" : "Untitled"), money].filter(Boolean).join(" · ")
    }
    case "wait": {
      const amount = Number(c.amount ?? 1)
      return `${pt ? "Aguardar" : "Wait"} ${amount} ${waitUnitLabel(String(c.unit ?? "hours"), amount, lang)}`
    }
    case "condition":
      return `${pt ? "Se" : "If"}: ${conditionSummary(c, res, lang)}`
    case "send_webhook":
      return String(c.url ?? "") || (pt ? "Sem URL" : "No URL")
    case "close_conversation":
      return pt ? "Marca a conversa como encerrada" : "Marks the conversation as closed"
    default:
      return ""
  }
}

/** Card eyebrow: "Condição N" for branches, "Ação N" for everything
 *  else — a wait is still a step in the actions list, and "Aguardar 2 /
 *  Aguardar / Aguardar 2 horas" read as a stutter. */
function stepKindLabel(type: AutomationStepType, t: (english: string) => string): string {
  return type === "condition" ? t("Condition") : t("Action")
}

function triggerSummary(
  type: AutomationTriggerType,
  cfg: Record<string, unknown>,
  res: AutomationResources,
  lang: Language,
): string {
  const pt = lang === "pt-BR"
  switch (type) {
    case "keyword_match": {
      const kws = Array.isArray(cfg.keywords) ? (cfg.keywords as string[]) : []
      if (kws.length === 0) return pt ? "Nenhuma palavra-chave definida" : "No keywords set"
      const mode = cfg.match_type === "exact" ? (pt ? "exata" : "exact") : pt ? "contém" : "contains"
      return `${kws.map((k) => `"${k}"`).join(", ")} · ${mode}`
    }
    case "tag_added": {
      const tag = res.tags.find((t) => t.id === cfg.tag_id)
      const name = tag?.name || (cfg.tag_id ? String(cfg.tag_id) : "")
      return name ? `${pt ? "Etiqueta" : "Tag"}: ${name}` : pt ? "Escolha uma etiqueta" : "Pick a tag"
    }
    case "time_based":
      return cfg.schedule ? `${pt ? "Agenda" : "Schedule"}: ${String(cfg.schedule)}` : pt ? "Defina o horário" : "Set a schedule"
    default:
      return ""
  }
}

// ------------------------------------------------------------
// Selection + media query helpers
// ------------------------------------------------------------

type Selection = { kind: "trigger" } | { kind: "step"; cid: string } | null

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // Server snapshot: assume the docked layout; the client corrects
    // it on hydration (this subtree only mounts client-side anyway).
    () => true,
  )
}

// ------------------------------------------------------------
// Main builder component
// ------------------------------------------------------------

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter()
  const { t } = useLanguage()
  const isEditing = !!initial.id
  const [state, setState] = useState<BuilderInitial>(initial)
  const [baseline, setBaseline] = useState<BuilderInitial>(initial)
  const [saving, setSaving] = useState(false)
  // The trigger opens in the inspector by default so the right-hand
  // panel is never blank on first paint (docked layout only — see the
  // effect below for the narrow/sheet case).
  const [selection, setSelection] = useState<Selection>({ kind: "trigger" })
  const isWide = useMediaQuery("(min-width: 1024px)")

  // Below lg the inspector is a slide-over sheet; never auto-open it
  // (on mount, or when the viewport shrinks) — wait for a tap.
  useEffect(() => {
    if (!isWide) setSelection(null)
  }, [isWide])

  const dirty = useMemo(
    () => JSON.stringify(state) !== JSON.stringify(baseline),
    [state, baseline],
  )

  function patchTop<K extends keyof BuilderInitial>(key: K, value: BuilderInitial[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  // --- Step tree mutations (immutable) ---

  const updateStep = useCallback((path: StepPath, updater: (s: BuilderStep) => BuilderStep) => {
    setState((s) => ({ ...s, steps: mapStep(s.steps, path, updater) }))
  }, [])

  function addStepAt(loc: ListLoc, index: number, type: AutomationStepType) {
    const node = newStep(type)
    setState((s) => ({ ...s, steps: insertStep(s.steps, loc, index, node) }))
    setSelection({ kind: "step", cid: node.cid })
  }

  function deleteStepAt(path: StepPath) {
    setState((s) => ({ ...s, steps: removeStep(s.steps, path) }))
    setSelection(null)
  }

  function moveStepAt(path: StepPath, direction: -1 | 1) {
    setState((s) => ({ ...s, steps: moveStep(s.steps, path, direction) }))
  }

  /** Wrap the current actions list in a new gate condition. */
  function addGateCondition() {
    const node = newStep("condition")
    setState((s) => {
      const chain = gateChain(s.steps)
      const wrapped: BuilderStep = {
        ...node,
        branches: { yes: chain.actions, no: [] },
      }
      return { ...s, steps: setList(s.steps, chain.actionsLoc, [wrapped]) }
    })
    setSelection({ kind: "step", cid: node.cid })
  }

  /** Unwrap a gate: its "yes" contents take its place. */
  function removeGate(path: StepPath) {
    setState((s) => {
      const gate = getStep(s.steps, path)
      if (!gate) return s
      return { ...s, steps: setList(s.steps, path.loc, gate.branches?.yes ?? []) }
    })
    setSelection(null)
  }

  async function save() {
    setSaving(true)
    try {
      const payload = {
        name: state.name || t("Untitled automation"),
        description: state.description || null,
        trigger_type: state.trigger_type,
        trigger_config: state.trigger_config,
        is_active: state.is_active,
        steps: toApiSteps(state.steps),
      }

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // If the server blocked activation with validation issues,
        // surface the first concrete problem so the user can fix it
        // without opening DevTools for the full array.
        const firstIssue: { path?: string; message?: string } | undefined =
          body?.issues?.[0]
        if (firstIssue?.message) {
          toast.error(firstIssue.message, {
            description: firstIssue.path ? `at ${firstIssue.path}` : undefined,
          })
        } else {
          toast.error(body?.error ?? t("Save failed"))
        }
        return
      }
      toast.success(isEditing ? "Automação salva" : "Automação criada")
      setBaseline(state)
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`)
      }
    } finally {
      setSaving(false)
    }
  }

  // Escape clears the selection (the mobile sheet handles its own).
  useEffect(() => {
    if (!isWide || !selection) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelection(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isWide, selection])

  const chain = useMemo(() => gateChain(state.steps), [state.steps])
  const selectedStep =
    selection?.kind === "step" ? findByCid(state.steps, selection.cid) : null
  const selectedIsGate =
    !!selectedStep && chain.gates.some((g) => g.step.cid === selectedStep.step.cid)

  // A stale selection (step deleted elsewhere) is simply nothing.
  const effectiveSelection: Selection =
    selection?.kind === "step" && !selectedStep ? null : selection

  const inspector = (
    <Inspector
      selection={effectiveSelection}
      state={state}
      located={selectedStep}
      isGate={selectedIsGate}
      onClose={() => setSelection(null)}
      onTriggerTypeChange={(v) => patchTop("trigger_type", v)}
      onTriggerConfigChange={(c) => patchTop("trigger_config", c)}
      updateStep={updateStep}
      deleteStepAt={deleteStepAt}
      moveStepAt={moveStepAt}
      removeGate={removeGate}
      listLength={(loc) => getList(state.steps, loc).length}
    />
  )

  return (
    <ResourcesProvider>
      <div className="fixed inset-0 flex flex-col bg-background">
        {/* Top bar. At sub-sm widths the "Ativo" label is hidden so the
            name input gets maximum width. */}
        <header className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 py-2.5 sm:gap-3 sm:px-4">
          <button
            type="button"
            onClick={() => router.push("/automations")}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t("Back to automations")}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="hidden text-[11px] uppercase tracking-wide text-muted-foreground sm:block">
              {t("Automations")}
              <span className="mx-1 text-border">/</span>
              {isEditing ? t("Edit rule") : t("New rule")}
            </div>
            <input
              value={state.name}
              onChange={(e) => patchTop("name", e.target.value)}
              placeholder={t("Untitled automation")}
              aria-label={t("Rule name")}
              className="w-full min-w-0 rounded-md bg-transparent px-1 py-0.5 text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:bg-muted focus:outline-none sm:text-base"
            />
          </div>
          {dirty && (
            <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground md:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
              {t("Unsaved changes")}
            </span>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="hidden sm:inline">Ativo</span>
            <Switch
              checked={state.is_active}
              onCheckedChange={(v) => patchTop("is_active", !!v)}
              aria-label="Ativo"
            />
          </div>
          <Button
            onClick={save}
            disabled={saving}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isEditing ? "Salvar" : t("Save Draft")}
          </Button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Rule document */}
          <main className="min-w-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
              {/* Details */}
              <section className="rounded-xl border border-border bg-card p-4">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("Description")}
                </label>
                <Textarea
                  value={state.description}
                  onChange={(e) => patchTop("description", e.target.value)}
                  placeholder={t("Describe what this rule does (optional)")}
                  className="min-h-[56px] bg-muted text-foreground"
                  rows={2}
                />
              </section>

              {/* 1 · Trigger */}
              <SectionHeader
                n={1}
                title={t("Trigger")}
                hint={t("When should this rule run?")}
              />
              <TriggerCard
                type={state.trigger_type}
                config={state.trigger_config}
                selected={effectiveSelection?.kind === "trigger"}
                onSelect={() => setSelection({ kind: "trigger" })}
              />

              {/* 2 · Conditions */}
              <SectionHeader
                n={2}
                title={t("Conditions")}
                hint={t("Only continue when all conditions are true")}
                action={
                  <Button variant="outline" size="sm" onClick={addGateCondition}>
                    <Plus className="h-3.5 w-3.5" />
                    {t("Add condition")}
                  </Button>
                }
              />
              <ConditionsGroup
                gates={chain.gates}
                selectedCid={effectiveSelection?.kind === "step" ? effectiveSelection.cid : null}
                onSelect={(cidValue) => setSelection({ kind: "step", cid: cidValue })}
                onRemove={removeGate}
                onAdd={addGateCondition}
              />

              {/* 3 · Actions */}
              <SectionHeader
                n={3}
                title={t("Actions")}
                hint={t("What to do, in order")}
                action={
                  <AddStepMenu
                    onPick={(type) => addStepAt(chain.actionsLoc, chain.actions.length, type)}
                  >
                    <Button variant="outline" size="sm">
                      <Plus className="h-3.5 w-3.5" />
                      {t("Add action")}
                    </Button>
                  </AddStepMenu>
                }
              />
              <StepList
                steps={chain.actions}
                loc={chain.actionsLoc}
                selectedCid={effectiveSelection?.kind === "step" ? effectiveSelection.cid : null}
                onSelect={(cidValue) => setSelection({ kind: "step", cid: cidValue })}
                addStepAt={addStepAt}
                nested={false}
              />
            </div>
          </main>

          {/* Inspector — docked at lg+, a sheet below that */}
          {isWide && (
            <aside className="flex w-[380px] flex-shrink-0 flex-col overflow-y-auto border-l border-border bg-card [scrollbar-width:thin]">
              {inspector}
            </aside>
          )}
        </div>

        {!isWide && (
          <Sheet
            open={!!effectiveSelection}
            onOpenChange={(open) => {
              if (!open) setSelection(null)
            }}
          >
            <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-md">
              <div className="flex h-full flex-col overflow-y-auto">
                {inspector}
              </div>
            </SheetContent>
          </Sheet>
        )}
      </div>
    </ResourcesProvider>
  )
}

// ------------------------------------------------------------
// Document pieces
// ------------------------------------------------------------

function SectionHeader({
  n,
  title,
  hint,
  action,
}: {
  n: number
  title: string
  hint: string
  action?: ReactNode
}) {
  return (
    <div className="-mb-3 flex items-end justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {n}
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </div>
      {action}
    </div>
  )
}

function TriggerCard({
  type,
  config,
  selected,
  onSelect,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  selected: boolean
  onSelect: () => void
}) {
  const { t, language } = useLanguage()
  const res = useResources()
  const option = TRIGGER_OPTIONS.find((o) => o.value === type)
  const summary = triggerSummary(type, config, res, language) || (option ? t(option.hint) : "")
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border border-blue-500/40 bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted/40",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
    >
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
        <Zap className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wide text-blue-500">{t("Trigger")}</div>
        <div className="truncate text-sm font-medium text-foreground">
          {option ? t(option.label) : type}
        </div>
        <div className="truncate text-xs text-muted-foreground">{summary}</div>
      </div>
      <span className="hidden text-xs text-muted-foreground sm:inline">{t("Edit")}</span>
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    </button>
  )
}

function ConditionsGroup({
  gates,
  selectedCid,
  onSelect,
  onRemove,
  onAdd,
}: {
  gates: Located[]
  selectedCid: string | null
  onSelect: (cid: string) => void
  onRemove: (path: StepPath) => void
  onAdd: () => void
}) {
  const { t, language } = useLanguage()
  const res = useResources()

  if (gates.length === 0) {
    return (
      <button
        type="button"
        onClick={onAdd}
        className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-4 py-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
      >
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Filter className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-foreground">
            {t("No conditions — actions run for every trigger event.")}
          </div>
          <div className="text-xs text-primary">{t("Add condition")}</div>
        </div>
      </button>
    )
  }

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <ol className="flex flex-col">
        {gates.map((g, i) => {
          const selected = g.step.cid === selectedCid
          return (
            <li key={g.step.cid} className="flex flex-col">
              {i > 0 && (
                <div className="flex items-center gap-2 py-1 pl-4">
                  <span className="h-3 w-px bg-amber-500/40" aria-hidden />
                  <span className="rounded-full border border-amber-500/40 bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600">
                    {t("AND")}
                  </span>
                </div>
              )}
              <div
                className={cn(
                  "flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm",
                  selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(g.step.cid)}
                  aria-pressed={selected}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-500">
                    <GitBranch className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] uppercase tracking-wide text-amber-600">
                      {t("Condition")} {i + 1}
                    </div>
                    <div className="truncate text-sm text-foreground">
                      {conditionSummary(g.step.step_config, res, language)}
                    </div>
                  </div>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("Remove condition")}
                  onClick={() => onRemove(g.path)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function StepList({
  steps,
  loc,
  selectedCid,
  onSelect,
  addStepAt,
  nested,
}: {
  steps: BuilderStep[]
  loc: ListLoc
  selectedCid: string | null
  onSelect: (cid: string) => void
  addStepAt: (loc: ListLoc, index: number, type: AutomationStepType) => void
  nested: boolean
}) {
  const { t } = useLanguage()

  if (steps.length === 0) {
    return (
      <AddStepMenu onPick={(type) => addStepAt(loc, 0, type)}>
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary",
            nested ? "px-3 py-3 text-xs" : "px-4 py-5",
          )}
        >
          <Plus className="h-4 w-4" />
          {nested ? t("Add action") : t("No actions yet. Add the first one.")}
        </button>
      </AddStepMenu>
    )
  }

  return (
    <div className="flex flex-col">
      {steps.map((step, idx) => (
        <div key={step.cid} className="flex flex-col">
          {idx > 0 && (
            <InsertConnector onPick={(type) => addStepAt(loc, idx, type)} />
          )}
          <StepCard
            step={step}
            index={idx}
            selected={step.cid === selectedCid}
            onSelect={() => onSelect(step.cid)}
            nested={nested}
          />
          {step.step_type === "condition" && (
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <BranchColumn label={t("Yes")} tone="text-primary border-primary/30">
                <StepList
                  steps={step.branches?.yes ?? []}
                  loc={{ kind: "branch", condPath: { loc, index: idx }, branch: "yes" }}
                  selectedCid={selectedCid}
                  onSelect={onSelect}
                  addStepAt={addStepAt}
                  nested
                />
              </BranchColumn>
              <BranchColumn label={t("No")} tone="text-rose-500 border-rose-500/30">
                <StepList
                  steps={step.branches?.no ?? []}
                  loc={{ kind: "branch", condPath: { loc, index: idx }, branch: "no" }}
                  selectedCid={selectedCid}
                  onSelect={onSelect}
                  addStepAt={addStepAt}
                  nested
                />
              </BranchColumn>
            </div>
          )}
        </div>
      ))}
      <InsertConnector onPick={(type) => addStepAt(loc, steps.length, type)} />
      <AddStepMenu onPick={(type) => addStepAt(loc, steps.length, type)}>
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary",
            nested ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm",
          )}
        >
          <Plus className="h-4 w-4" />
          {t("Add action")}
        </button>
      </AddStepMenu>
    </div>
  )
}

function BranchColumn({
  label,
  tone,
  children,
}: {
  label: string
  tone: string
  children: ReactNode
}) {
  return (
    <div className={cn("flex flex-col rounded-xl border border-dashed p-2", tone)}>
      <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide">{label}</div>
      {children}
    </div>
  )
}

/** Thin connector with a small "+" for inserting between two steps. */
function InsertConnector({ onPick }: { onPick: (t: AutomationStepType) => void }) {
  const { t } = useLanguage()
  return (
    <div className="group relative flex h-8 items-center justify-center">
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" aria-hidden />
      <AddStepMenu onPick={onPick}>
        <button
          type="button"
          aria-label={t("Add step")}
          title={t("Add step")}
          className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-60 transition-all hover:border-primary hover:bg-primary/10 hover:text-primary hover:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </AddStepMenu>
    </div>
  )
}

function StepCard({
  step,
  index,
  selected,
  onSelect,
  nested,
}: {
  step: BuilderStep
  index: number
  selected: boolean
  onSelect: () => void
  nested: boolean
}) {
  const { t, language } = useLanguage()
  const res = useResources()
  const meta = STEP_META[step.step_type]
  const Icon = meta.icon
  const kind =
    stepKindLabel(step.step_type, t)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-step-cid={step.cid}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border bg-card text-left shadow-sm transition-colors hover:bg-muted/40",
        meta.border,
        nested ? "px-3 py-2" : "px-4 py-3",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
    >
      <div
        className={cn(
          "flex flex-shrink-0 items-center justify-center rounded-lg",
          meta.tile,
          nested ? "h-8 w-8" : "h-9 w-9",
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          <span>
            {kind} {index + 1}
          </span>
        </div>
        <div className="truncate text-sm font-medium text-foreground">{t(meta.label)}</div>
        <div className="truncate text-xs text-muted-foreground">
          {stepSummary(step, res, language)}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    </button>
  )
}

function AddStepMenu({
  onPick,
  children,
}: {
  onPick: (t: AutomationStepType) => void
  children: ReactNode
}) {
  const { t } = useLanguage()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={children as ReactElement} />
      <DropdownMenuContent
        align="start"
        className="max-h-96 min-w-60 overflow-y-auto border-border bg-popover"
      >
        {STEP_GROUPS.map((group, gi) => (
          <DropdownMenuGroup key={group.label}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t(group.label)}
            </DropdownMenuLabel>
            {group.types.map((type) => {
              const Icon = STEP_META[type].icon
              return (
                <DropdownMenuItem key={type} onClick={() => onPick(type)}>
                  <Icon className="h-4 w-4" />
                  {t(STEP_META[type].label)}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ------------------------------------------------------------
// Inspector (right-hand panel)
// ------------------------------------------------------------

function Inspector({
  selection,
  state,
  located,
  isGate,
  onClose,
  onTriggerTypeChange,
  onTriggerConfigChange,
  updateStep,
  deleteStepAt,
  moveStepAt,
  removeGate,
  listLength,
}: {
  selection: Selection
  state: BuilderInitial
  located: Located | null
  isGate: boolean
  onClose: () => void
  onTriggerTypeChange: (t: AutomationTriggerType) => void
  onTriggerConfigChange: (c: Record<string, unknown>) => void
  updateStep: (path: StepPath, updater: (s: BuilderStep) => BuilderStep) => void
  deleteStepAt: (path: StepPath) => void
  moveStepAt: (path: StepPath, direction: -1 | 1) => void
  removeGate: (path: StepPath) => void
  listLength: (loc: ListLoc) => number
}) {
  const { t } = useLanguage()

  if (!selection) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <MousePointerClick className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium text-foreground">{t("Nothing selected")}</p>
        <p className="text-xs text-muted-foreground">
          {t("Select the trigger, a condition or an action to edit it here.")}
        </p>
      </div>
    )
  }

  if (selection.kind === "trigger") {
    const option = TRIGGER_OPTIONS.find((o) => o.value === state.trigger_type)
    return (
      <div className="flex flex-col">
        <InspectorHeader
          eyebrow={t("Trigger")}
          title={option ? t(option.label) : state.trigger_type}
          icon={<Zap className="h-4 w-4" />}
          tile="bg-blue-500/10 text-blue-500"
          onClose={onClose}
        />
        <div className="flex flex-col gap-3 px-4 py-4">
          <TriggerEditor
            type={state.trigger_type}
            config={state.trigger_config}
            onTypeChange={onTriggerTypeChange}
            onConfigChange={onTriggerConfigChange}
          />
        </div>
      </div>
    )
  }

  if (!located) return null
  const { step, path } = located
  const meta = STEP_META[step.step_type]
  const Icon = meta.icon
  const total = listLength(path.loc)
  const kind =
    stepKindLabel(step.step_type, t)

  return (
    <div className="flex flex-col">
      <InspectorHeader
        eyebrow={isGate ? t("Condition") : `${kind} ${path.index + 1}`}
        title={t(meta.label)}
        icon={<Icon className="h-4 w-4" />}
        tile={meta.tile}
        onClose={onClose}
      />
      <div className="flex flex-col gap-3 px-4 py-4">
        <StepEditor
          step={step}
          isGate={isGate}
          onChange={(next) => updateStep(path, () => next)}
        />
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-3">
        {isGate ? (
          <span className="text-xs text-muted-foreground">
            {t("Removing keeps the actions below it.")}
          </span>
        ) : (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              disabled={path.index === 0}
              aria-label={t("Move up")}
              title={t("Move up")}
              onClick={() => moveStepAt(path, -1)}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={path.index >= total - 1}
              aria-label={t("Move down")}
              title={t("Move down")}
              onClick={() => moveStepAt(path, 1)}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </div>
        )}
        <Button
          variant="destructive"
          size="sm"
          onClick={() => (isGate ? removeGate(path) : deleteStepAt(path))}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {isGate ? t("Remove condition") : t("Delete")}
        </Button>
      </div>
    </div>
  )
}

function InspectorHeader({
  eyebrow,
  title,
  icon,
  tile,
  onClose,
}: {
  eyebrow: string
  title: string
  icon: ReactNode
  tile: string
  onClose: () => void
}) {
  const { t } = useLanguage()
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3">
      <div className={cn("flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg", tile)}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{eyebrow}</div>
        <div className="truncate text-sm font-semibold text-foreground">{title}</div>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={t("Close")} onClick={onClose}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}

// ------------------------------------------------------------
// Trigger editor
// ------------------------------------------------------------

function TriggerEditor({
  type,
  config,
  onTypeChange,
  onConfigChange,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  onTypeChange: (t: AutomationTriggerType) => void
  onConfigChange: (c: Record<string, unknown>) => void
}) {
  const { t } = useLanguage()
  const option = TRIGGER_OPTIONS.find((o) => o.value === type)
  return (
    <>
      <FieldBlock label={t("Trigger type")}>
        <select
          value={type}
          onChange={(e) => onTypeChange(e.target.value as AutomationTriggerType)}
          className={SELECT_CLASS}
        >
          {TRIGGER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.label)}
            </option>
          ))}
        </select>
        {option && <p className="mt-1 text-[11px] text-muted-foreground">{t(option.hint)}</p>}
      </FieldBlock>
      {type === "keyword_match" && (
        <KeywordMatchConfig
          key={type}
          config={config as unknown as KeywordMatchTriggerConfig}
          onChange={onConfigChange}
        />
      )}
      {type === "tag_added" && (
        <FieldBlock label={t("Tag")}>
          <TagSelect
            value={(config.tag_id as string) ?? ""}
            onChange={(v) => onConfigChange({ ...config, tag_id: v })}
          />
        </FieldBlock>
      )}
      {type === "time_based" && (
        <FieldBlock label={t("Schedule")}>
          <Input
            placeholder="Cron expression or HH:mm"
            value={(config.schedule as string) ?? ""}
            onChange={(e) => onConfigChange({ ...config, schedule: e.target.value })}
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      )}
    </>
  )
}

function KeywordMatchConfig({
  config,
  onChange,
}: {
  config: KeywordMatchTriggerConfig
  onChange: (c: Record<string, unknown>) => void
}) {
  const { t } = useLanguage()
  const keywords = config?.keywords ?? []
  // Keep a local draft string so the comma and trailing space aren't
  // stripped on every keystroke (which made multi-word, comma-separated
  // entry like "SEO, search engine optimization" impossible to type).
  // We only parse into the keywords array on blur, then re-display the
  // cleaned, rejoined form. Seeded once on mount; this component remounts
  // when the trigger type changes, so the seed stays in sync.
  const [draft, setDraft] = useState(keywords.join(", "))

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, match_type: config?.match_type ?? "contains", keywords: parsed })
  }

  return (
    <>
      <FieldBlock label={t("Keywords (comma-separated)")}>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          placeholder="e.g. pricing, demo request, talk to sales"
          className="bg-muted text-foreground"
        />
      </FieldBlock>
      <FieldBlock label={t("Match type")}>
        <select
          value={config?.match_type ?? "contains"}
          onChange={(e) =>
            onChange({ ...config, keywords, match_type: e.target.value as "exact" | "contains" })
          }
          className={SELECT_CLASS}
        >
          <option value="contains">{t("Contains")}</option>
          <option value="exact">{t("Exact")}</option>
        </select>
      </FieldBlock>
    </>
  )
}

// ------------------------------------------------------------
// Per-step config editor
// ------------------------------------------------------------

function StepEditor({
  step,
  isGate,
  onChange,
}: {
  step: BuilderStep
  isGate: boolean
  onChange: (s: BuilderStep) => void
}) {
  const { t } = useLanguage()
  const cfg = step.step_config
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...step, step_config: { ...cfg, ...patch } })

  switch (step.step_type) {
    case "send_message":
      return (
        <FieldBlock label={t("Message text")}>
          <Textarea
            value={(cfg.text as string) ?? ""}
            onChange={(e) => set({ text: e.target.value })}
            placeholder="Hi! Thanks for reaching out…"
            className="min-h-32 bg-muted text-foreground"
            autoFocus
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("Sent to the contact on WhatsApp as a plain text message.")}
          </p>
        </FieldBlock>
      )
    case "send_template":
      return (
        <SendTemplateFields
          templateName={(cfg.template_name as string) ?? ""}
          language={(cfg.language as string) ?? ""}
          onChange={(patch) => set(patch)}
        />
      )
    case "add_tag":
    case "remove_tag":
      return (
        <FieldBlock label={t("Tag")}>
          <TagSelect
            value={(cfg.tag_id as string) ?? ""}
            onChange={(v) => set({ tag_id: v })}
          />
        </FieldBlock>
      )
    case "assign_conversation":
      return (
        <>
          <FieldBlock label={t("Mode")}>
            <select
              value={(cfg.mode as string) ?? "round_robin"}
              onChange={(e) => set({ mode: e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="round_robin">{t("Round-robin")}</option>
              <option value="specific">{t("Specific agent")}</option>
            </select>
          </FieldBlock>
          {cfg.mode === "specific" && (
            <FieldBlock label={t("Agent")}>
              <AgentSelect
                value={(cfg.agent_id as string) ?? ""}
                onChange={(v) => set({ agent_id: v })}
              />
            </FieldBlock>
          )}
        </>
      )
    case "update_contact_field":
      return (
        <>
          <FieldBlock label={t("Field")}>
            <ContactFieldSelect
              value={(cfg.field as string) ?? "name"}
              onChange={(v) => set({ field: v })}
            />
          </FieldBlock>
          <FieldBlock label={t("Value")}>
            <Input
              value={(cfg.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
              placeholder="Text or {{ vars.x }} / {{ message.text }}"
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "create_deal":
      return (
        <>
          <FieldBlock label={t("Title")}>
            <Input
              value={(cfg.title as string) ?? ""}
              onChange={(e) => set({ title: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("Value")}>
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("Pipeline id")}>
            <Input
              value={(cfg.pipeline_id as string) ?? ""}
              onChange={(e) => set({ pipeline_id: e.target.value })}
              className="bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("Stage id")}>
            <Input
              value={(cfg.stage_id as string) ?? ""}
              onChange={(e) => set({ stage_id: e.target.value })}
              className="bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "wait":
      return (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label={t("Amount")}>
            <Input
              type="number"
              min={1}
              value={(cfg.amount as number) ?? 1}
              onChange={(e) => set({ amount: Math.max(1, Number(e.target.value)) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("Unit")}>
            <select
              value={(cfg.unit as string) ?? "hours"}
              onChange={(e) => set({ unit: e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="minutes">{t("Minutes")}</option>
              <option value="hours">{t("Hours")}</option>
              <option value="days">{t("Days")}</option>
            </select>
          </FieldBlock>
        </div>
      )
    case "condition":
      return <ConditionEditor cfg={cfg} set={set} isGate={isGate} />
    case "send_webhook":
      return (
        <>
          <FieldBlock label="URL">
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://"
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("Body template (JSON)")}>
            <Textarea
              value={(cfg.body_template as string) ?? ""}
              onChange={(e) => set({ body_template: e.target.value })}
              className="min-h-24 bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "close_conversation":
      return (
        <p className="text-xs text-muted-foreground">
          {t('Sets the conversation status to "closed". No configuration needed.')}
        </p>
      )
    default:
      return null
  }
}

function ConditionEditor({
  cfg,
  set,
  isGate,
}: {
  cfg: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
  isGate: boolean
}) {
  const { t } = useLanguage()
  const subject = (cfg.subject as string) ?? "tag_presence"
  const operand = (cfg.operand as string) ?? ""
  const value = (cfg.value as string) ?? ""
  const [from = "", to = ""] = operand.split("-")

  return (
    <>
      <FieldBlock label={t("Check")}>
        <select
          value={subject}
          onChange={(e) => {
            const next = e.target.value
            // Reset the operand when the subject changes — the old one
            // (a tag id, a column, a time window) never carries over.
            set({ subject: next, operand: next === "contact_field" ? "name" : "", value: "" })
          }}
          className={SELECT_CLASS}
        >
          <option value="tag_presence">{t("Contact has tag")}</option>
          <option value="contact_field">{t("Contact field equals")}</option>
          <option value="message_content">{t("Message contains")}</option>
          <option value="time_of_day">{t("Time of day is between")}</option>
        </select>
      </FieldBlock>

      {subject === "tag_presence" && (
        <FieldBlock label={t("Tag")}>
          <TagSelect value={operand} onChange={(v) => set({ operand: v })} />
        </FieldBlock>
      )}

      {subject === "contact_field" && (
        <>
          <FieldBlock label={t("Field")}>
            <ContactFieldSelect
              value={operand || "name"}
              onChange={(v) => set({ operand: v })}
              builtInOnly
            />
          </FieldBlock>
          <FieldBlock label={t("Value")}>
            <Input
              value={value}
              onChange={(e) => set({ value: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )}

      {subject === "message_content" && (
        <FieldBlock label={t("Text to look for")}>
          {/* The engine compares `value`; `operand` is mirrored so the
              activation validator (which requires an operand) passes. */}
          <Input
            value={value}
            onChange={(e) => set({ value: e.target.value, operand: e.target.value })}
            placeholder="e.g. price"
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      )}

      {subject === "time_of_day" && (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label={t("Start time")}>
            <Input
              type="time"
              value={from}
              onChange={(e) => set({ operand: `${e.target.value}-${to}` })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("End time")}>
            <Input
              type="time"
              value={to}
              onChange={(e) => set({ operand: `${from}-${e.target.value}` })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <p className="col-span-2 text-[11px] text-muted-foreground">
            {t("Overnight windows like 18:00–09:00 are supported.")}
          </p>
        </div>
      )}

      <p className="rounded-md bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {isGate
          ? t("The actions only run when this condition is true.")
          : t('Steps under "Yes" run when true; steps under "No" run otherwise.')}
      </p>
    </>
  )
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

// ------------------------------------------------------------
// Serialize builder tree → API payload (flattened shape)
// ------------------------------------------------------------

interface ApiStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: ApiStep[]; no?: ApiStep[] }
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }))
}

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string
  step_type: string
  step_config: Record<string, unknown>
  branches: { yes: ServerStepNode[]; no: ServerStepNode[] }
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => ({
    cid: cid(),
    step_type: n.step_type as AutomationStepType,
    step_config: n.step_config ?? {},
    branches:
      n.step_type === "condition"
        ? {
            yes: fromServerSteps(n.branches?.yes ?? []),
            no: fromServerSteps(n.branches?.no ?? []),
          }
        : undefined,
  }))
}
