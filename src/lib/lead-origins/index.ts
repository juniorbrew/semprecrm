// ============================================================
// Lead origins (migration 109) — public surface. `record.ts` is server-only (it takes the
// service-role client): import it from the route / ingest code, not from client components.
// ============================================================

export * from './types'
export * from './normalize'
export * from './parsers'
export * from './label'
