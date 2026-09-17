// ============================================================
// Company / address lookup — server side.
//
// Talks to the public sources on behalf of the browser so the
// signup page (unauthenticated) never hits them directly: one
// place to rate-limit, to keep an in-memory cache (CNPJ data
// changes rarely; CEPs never) and to fall back between CEP
// providers. Mapping lives in ./lookup (pure, tested).
//
// `fetchImpl` is injectable for tests; production uses the global.
// ============================================================

import {
  isValidCep,
  mapBrasilApiCep,
  mapBrasilApiCnpj,
  mapViaCep,
  normalizeCep,
  type AddressLookup,
  type CompanyLookup,
} from './lookup'
import { isValidCnpj, normalizeTaxId } from './documents'

export type LookupFailure = 'invalid' | 'not_found' | 'upstream_error'

export type CnpjLookupResult = { ok: true; company: CompanyLookup } | { ok: false; reason: LookupFailure }
export type CepLookupResult = { ok: true; address: AddressLookup } | { ok: false; reason: LookupFailure }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const UPSTREAM_TIMEOUT_MS = 6_000
const CNPJ_TTL_MS = 24 * 60 * 60 * 1000
const CEP_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 5_000

const cache = new Map<string, { expires: number; value: unknown }>()

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (hit.expires < Date.now()) {
    cache.delete(key)
    return undefined
  }
  return hit.value as T
}

function cacheSet(key: string, value: unknown, ttl: number) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Drop the oldest insertion — Map iterates in insertion order.
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, { expires: Date.now() + ttl, value })
}

/** Test-only: clear the shared cache between cases. */
export function __resetLookupCacheForTests() {
  cache.clear()
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'SempreCRM/1.0 (+lookup)' },
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { status: res.status, json }
  } catch {
    return { status: 0, json: null }
  } finally {
    clearTimeout(timer)
  }
}

export async function lookupCnpj(
  raw: string,
  fetchImpl: FetchLike = fetch,
): Promise<CnpjLookupResult> {
  const cnpj = normalizeTaxId(raw)
  if (!isValidCnpj(cnpj)) return { ok: false, reason: 'invalid' }

  const key = `cnpj:${cnpj}`
  const cached = cacheGet<CnpjLookupResult>(key)
  if (cached) return cached

  const r = await getJson(fetchImpl, `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`)
  if (r.status === 0 || r.status >= 500) return { ok: false, reason: 'upstream_error' }
  if (r.status === 404 || r.status === 400 || !r.json) {
    const miss: CnpjLookupResult = { ok: false, reason: 'not_found' }
    cacheSet(key, miss, CNPJ_TTL_MS)
    return miss
  }
  if (r.status !== 200) return { ok: false, reason: 'upstream_error' }

  const hit: CnpjLookupResult = { ok: true, company: mapBrasilApiCnpj(r.json) }
  cacheSet(key, hit, CNPJ_TTL_MS)
  return hit
}

export async function lookupCep(
  raw: string,
  fetchImpl: FetchLike = fetch,
): Promise<CepLookupResult> {
  const cep = normalizeCep(raw)
  if (!isValidCep(cep)) return { ok: false, reason: 'invalid' }

  const key = `cep:${cep}`
  const cached = cacheGet<CepLookupResult>(key)
  if (cached) return cached

  // Race both providers and take the first usable answer — BrasilAPI is
  // usually ~100 ms but occasionally stalls for seconds, and ViaCEP is
  // steady; the user is waiting with a half-filled form.
  const brasilApi = getJson(fetchImpl, `https://brasilapi.com.br/api/cep/v2/${cep}`).then((r) => ({
    address: r.status === 200 && r.json ? mapBrasilApiCep(r.json) : null,
    missing: r.status === 404,
    failed: r.status === 0 || r.status >= 500,
  }))
  const viaCep = getJson(fetchImpl, `https://viacep.com.br/ws/${cep}/json/`).then((r) => {
    const mapped = r.status === 200 && r.json ? mapViaCep(r.json) : null
    return {
      address: mapped,
      missing: (r.status === 200 && r.json !== null && mapped === null) || r.status === 400,
      failed: r.status === 0 || r.status >= 500,
    }
  })

  const settled = await new Promise<{ address: AddressLookup | null; missing: boolean; failed: boolean }[]>((resolve) => {
    const results: { address: AddressLookup | null; missing: boolean; failed: boolean }[] = []
    let pending = 2
    const onDone = (r: { address: AddressLookup | null; missing: boolean; failed: boolean }) => {
      results.push(r)
      pending -= 1
      if ((r.address && r.address.city) || pending === 0) resolve(results)
    }
    void brasilApi.then(onDone)
    void viaCep.then(onDone)
  })

  const address = settled.find((r) => r.address && r.address.city)?.address ?? null
  const definitelyMissing = settled.some((r) => r.missing)
  const sawUpstreamError = settled.some((r) => r.failed)

  if (address && address.city) {
    const hit: CepLookupResult = { ok: true, address: { ...address, cep } }
    cacheSet(key, hit, CEP_TTL_MS)
    return hit
  }
  if (definitelyMissing || !sawUpstreamError) {
    const miss: CepLookupResult = { ok: false, reason: 'not_found' }
    cacheSet(key, miss, CEP_TTL_MS)
    return miss
  }
  return { ok: false, reason: 'upstream_error' }
}
