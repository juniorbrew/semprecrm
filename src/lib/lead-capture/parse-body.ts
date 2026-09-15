// ============================================================
// Lead webhook body parsing.
//
// The inbound endpoint is called by landing-page builders, Zapier,
// n8n and plain HTML forms, so it has to accept whatever they send:
//
//   application/json                  → the object as-is
//   application/x-www-form-urlencoded → flat key/value map
//   multipart/form-data               → flat key/value map (files dropped)
//   anything else / missing           → best effort: JSON, then urlencoded
//
// Pure — takes a `Request`, returns a plain object or `null` when the
// body can't be read as a lead (an array, a scalar, unparsable text).
// ============================================================

export type LeadPayload = Record<string, unknown>

/** Soft ceiling on the raw body; a lead is never megabytes. */
export const MAX_LEAD_BODY_BYTES = 256 * 1024

function isPlainObject(v: unknown): v is LeadPayload {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Turn form entries into an object. A key that repeats becomes an
 * array (`interesse=a&interesse=b`), and PHP-style `campo[]` keys have
 * the brackets stripped so they collapse onto the same array.
 */
export function entriesToPayload(entries: Iterable<[string, string]>): LeadPayload {
  const out: LeadPayload = {}
  for (const [rawKey, value] of entries) {
    const key = rawKey.endsWith('[]') ? rawKey.slice(0, -2) : rawKey
    if (!key) continue
    const prev = out[key]
    if (prev === undefined) {
      out[key] = rawKey.endsWith('[]') ? [value] : value
    } else if (Array.isArray(prev)) {
      prev.push(value)
    } else {
      out[key] = [prev, value]
    }
  }
  return out
}

export function parseJsonPayload(text: string): LeadPayload | null {
  if (!text.trim()) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parseUrlEncodedPayload(text: string): LeadPayload | null {
  if (!text.trim()) return null
  // A JSON body posted with the wrong content-type would otherwise be
  // read as a single weird key; it never contains `=` at the top level
  // of a form, so `{` up front is a reliable tell.
  if (text.trimStart().startsWith('{')) return null
  const params = new URLSearchParams(text)
  const payload = entriesToPayload(params.entries())
  return Object.keys(payload).length > 0 ? payload : null
}

/**
 * Read the request body as a lead payload. Never throws — a body we
 * can't understand resolves to `null` and the route answers 400.
 */
export async function parseLeadBody(request: Request): Promise<LeadPayload | null> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase()

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData()
      const entries: [string, string][] = []
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') entries.push([k, v])
      }
      const payload = entriesToPayload(entries)
      return Object.keys(payload).length > 0 ? payload : null
    }

    const text = await request.text()
    if (text.length > MAX_LEAD_BODY_BYTES) return null

    if (contentType.includes('application/json') || contentType.includes('+json')) {
      return parseJsonPayload(text)
    }
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return parseUrlEncodedPayload(text)
    }
    // Unknown / missing content-type (curl -d sends urlencoded, but a
    // hand-written client may send JSON with text/plain).
    return parseJsonPayload(text) ?? parseUrlEncodedPayload(text)
  } catch {
    return null
  }
}
