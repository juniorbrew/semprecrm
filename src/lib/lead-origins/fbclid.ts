/** A real Facebook click id is a long url-safe token. Anything shorter is noise or a probe: not kept as an fbclid. */
export const FBCLID_RE = /^[A-Za-z0-9_-]{20,}$/

export const isPlausibleFbclid = (v: string | null | undefined): v is string => typeof v === 'string' && FBCLID_RE.test(v)
