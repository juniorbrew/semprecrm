"use client"

import { useEffect, useMemo, useState } from "react"

import { useLanguage } from "@/hooks/use-language"
import { createClient } from "@/lib/supabase/client"

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

interface SourceOption {
  id: string
  name: string
  is_active: boolean
}

/**
 * Inspector control for the `lead_captured` trigger: the account's lead
 * sources (Configurações → Integrações) or "any source". Reads only
 * id/name/is_active — never the token — so it is safe for every role
 * that can open the builder.
 */
export function LeadSourceSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (sourceId: string) => void
}) {
  const { t } = useLanguage()
  const supabase = useMemo(() => createClient(), [])
  const [sources, setSources] = useState<SourceOption[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data } = await supabase
        .from("lead_sources")
        .select("id, name, is_active")
        .order("name")
      if (cancelled) return
      setSources((data as SourceOption[] | null) ?? [])
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [supabase])

  const known = sources.some((s) => s.id === value)

  return (
    <div className="space-y-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
        aria-label={t("Lead source")}
      >
        <option value="">{t("Any source")}</option>
        {value && !known ? (
          <option value={value}>{t("Deleted source")}</option>
        ) : null}
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.is_active ? "" : ` · ${t("paused")}`}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-muted-foreground">
        {loaded && sources.length === 0
          ? t("No lead sources yet — create one in Settings → Integrations.")
          : t("Fires for every webhook lead, or only for the chosen source.")}
      </p>
    </div>
  )
}
