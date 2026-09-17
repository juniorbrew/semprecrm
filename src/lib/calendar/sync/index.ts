// ============================================================
// Calendar sync (phase 2) — public surface.
//
//   config     which providers are configured (env), redirect URLs
//   state      signed OAuth `state`
//   mapping    row <-> Google / Graph payloads, sync hash
//   engine     syncConnection / syncDueConnections / syncUserConnections
//   store      Supabase glue + connection reads / upsert / delete
//   google, microsoft   provider adapters (ADAPTERS in engine)
//
// Server-only: the engine decrypts tokens. Client code needs only
// `config` (labels / provider ids) — import that sub-module directly.
// ============================================================

export * from './config'
export * from './state'
export * from './mapping'
export * from './provider'
export * from './http'
export * from './engine'
export * from './store'
export { googleAdapter } from './google'
export { microsoftAdapter } from './microsoft'
