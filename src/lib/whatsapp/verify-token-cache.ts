import { createHash, timingSafeEqual } from 'node:crypto'

// ------------------------------------------------------------
// Verify-token lookup for Meta's public webhook GET handshake.
//
// Decrypting every tenant's verify_token on each unauthenticated
// request was an amplification vector, so the decrypted values are
// kept as SHA-256 digests for CACHE_MS and compared in constant time.
// A miss refetches at most once per MISS_REFETCH_MS, so a token saved
// seconds ago still verifies while a flood of wrong tokens costs no
// extra decrypts.
// ------------------------------------------------------------

export const VERIFY_CACHE_MS = 60_000
export const VERIFY_MISS_REFETCH_MS = 5_000

export interface VerifyConfigRow {
  id: string
  verify_token: string | null
}

export interface VerifyMatch {
  id: string
  /** Stored (encrypted) value, for the legacy-format upgrade. */
  raw: string
}

interface Entry extends VerifyMatch {
  digest: Buffer
}

const sha256 = (v: string) => createHash('sha256').update(v).digest()

export function createVerifyTokenMatcher(
  load: () => Promise<VerifyConfigRow[] | null>,
  decrypt: (v: string) => string,
  now: () => number = Date.now,
) {
  let cache: { at: number; rows: Entry[] } | null = null

  async function refresh(): Promise<Entry[] | null> {
    const configs = await load()
    if (!configs) return null
    const rows: Entry[] = []
    for (const c of configs) {
      if (!c.verify_token) continue
      try {
        rows.push({ id: c.id, raw: c.verify_token, digest: sha256(decrypt(c.verify_token)) })
      } catch {
        // Malformed / wrong-key token row — skip it.
      }
    }
    cache = { at: now(), rows }
    return rows
  }

  function match(rows: Entry[], supplied: Buffer): VerifyMatch | null {
    let hit: Entry | null = null
    // Constant time per row and no early exit.
    for (const row of rows) {
      if (timingSafeEqual(row.digest, supplied) && !hit) hit = row
    }
    return hit ? { id: hit.id, raw: hit.raw } : null
  }

  return {
    /** Match, null on mismatch, undefined when the configs can't be loaded. */
    async find(verifyToken: string): Promise<VerifyMatch | null | undefined> {
      const supplied = sha256(verifyToken)
      const t = now()
      if (cache && t - cache.at < VERIFY_CACHE_MS) {
        const hit = match(cache.rows, supplied)
        if (hit || t - cache.at < VERIFY_MISS_REFETCH_MS) return hit
      }
      const rows = await refresh()
      return rows ? match(rows, supplied) : undefined
    },
  }
}
