// Browser side of the suppression list (migration 077): after creating
// contacts, ask the server to mark the ones whose number had opted out
// before being anonymised. The list itself is service-role only.

/** Returns how many of `ids` were marked opted out. Throws on failure. */
export async function applySuppressions(ids: string[]): Promise<number> {
  let marked = 0
  for (let i = 0; i < ids.length; i += 500) {
    const res = await fetch('/api/contacts/suppressions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids.slice(i, i + 500) }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json().catch(() => null)) as { opted_out?: number } | null
    marked += body?.opted_out ?? 0
  }
  return marked
}
