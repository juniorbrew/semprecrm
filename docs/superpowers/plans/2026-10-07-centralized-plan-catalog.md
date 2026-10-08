# Centralized Plan Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit advertised prices, modules and limits from the platform panel while preserving each existing company's granted conditions.

**Architecture:** Immutable plan versions with one current pointer per plan and one assigned version per company. A shared validated definition feeds the pure entitlement resolver; privileged transactional RPCs change versions and write audit records. Current public commercial terms are separate from previously granted company entitlements and contracted prices.

**Tech Stack:** Existing Next.js 16.3.6, React, TypeScript, Supabase/PostgreSQL, npm, Vitest and agent-browser; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-centralized-plan-catalog-design.md` (approved 2026-10-07).

## Global Constraints

- Preserve existing account status, expiry, overrides and granted modules/limits.
- Fixed plan identifiers: `trial`, `basico`, `pro`, `empresa`. Trial remains free for 14 days.
- Inbox and Contacts always included. Overrides have priority over the assigned definition.
- BRL monthly advertised price in integer cents or null for personalized pricing; never infer contracted prices or introduce payment processing.
- Both platform authorization locks required; no direct client mutation of definitions or assigned versions.
- Read the applicable guides in `node_modules/next/dist/docs/` before product code; follow existing UI and package tooling.
- Never modify `.env` or expose credentials. Use isolated local Supabase for migration/integration tests. Publishing requires user authorization.

## Review Focus

- A stale form must not silently overwrite a newer catalog version (Task 3 conflict test).
- Renamed/deleted administrators must not erase the actor snapshot in version history (Tasks 1 and 3).
- Existing accounts above a newly adopted capacity retain their users/channels while new additions are refused (Tasks 2 and 6).
- Missing, mismatched or corrupt granted definitions must not enable Trial permissions (Task 2).
- Saving the same plan's status/notes or a stale preview must not unexpectedly adopt a new version (Tasks 3 and 5).

## Files and interfaces

- `src/lib/plan-catalog.ts`: isomorphic validation/types only. `PlanVersion` contains `id: string`, `plan: Plan`, `revision: number`, `definition: PlanDefinition`, `price_monthly_cents: number|null`. `PlanVersionHistory` adds `created_at: string` and `actor_name: string|null` for administrator-only views.
- `parsePlanDefinition(raw: unknown): PlanDefinition|null`: accept exactly optional module IDs (unique) and both known limits as safe nonnegative integers or null; reject extra fields and invalid types.
- `parsePlanVersion(raw: unknown): PlanVersion|null`: validate UUID, known plan, positive revision, definition and price; Trial must have price zero.
- `src/lib/plan-catalog-server.ts`: server-only reads for current public catalog and administrative current/history pages; never return raw database rows. `loadCurrentPlanCatalog(db: SupabaseClient): Promise<PlanVersion[]>` throws on missing/corrupt entries; `loadPlanVersionHistory(db: SupabaseClient, plan: Plan, cursor: string|null): Promise<ActivityPage<PlanVersionHistory>>` pages by revision descending.
- `PlanAccountFields` gains `plan_version_id?: string|null` and `plan_definition?: PlanDefinition|null`; `resolveEntitlements(account, now)` retains its signature. Joined account reads normalize the assigned definition through `parsePlanDefinition` before resolving.
- Catalog save body: `{expected_version_id: string, definition: PlanDefinition, price_monthly_cents: number|null}`. Account PATCH adds optional `adopt_current_plan: boolean` and `expected_plan_version_id: string` for the explicit adoption/tier-change path.
- SQL `platform_save_plan_version(p_plan text, p_expected_version_id uuid, p_definition jsonb, p_price_monthly_cents bigint, p_actor_user_id uuid)` and `platform_update_account_v2(p_account_id uuid, p_patch jsonb, p_actor_user_id uuid, p_expected_version_id uuid DEFAULT NULL, p_adopt_current boolean DEFAULT false)` execute only as `service_role`; both verify the supplied actor is a platform administrator. Routes derive actor identity from authenticated context, never request JSON.

### Task 1: Immutable versions, assignments and database access

**Files:** create `supabase/migrations/079_versioned_plan_catalog.sql`, `supabase/tests/plan_catalog.sql`; reference migrations 043 (signup), 058 (account RPC), 026 (list RPC) and 076 (grants/guard).

- [ ] Write failing SQL tests: initial Pro definition has `max_users=10`, `max_channels=2`, all optional modules except flows; seed prices are `0`, `5990`, `8990`, `null`. Seed other definitions from current `PLAN_CATALOG`, not older design docs. Existing account fields/overrides remain byte-for-byte unchanged after assignment. Public reads omit authors/history; tenants cannot read another company's non-current granted version or change pointers/versions.
- [ ] Run the SQL tests against the isolated stack; verify failures concern missing catalog/assignments, not connection errors.
- [ ] Create `platform_plan_versions` with UUID ID, fixed plan key, integer revision, validated `definition` JSON, integer-cent price, BRL currency, creation time and actor name/ID snapshot. Add unique `(plan, revision)` and `(plan, id)`; prevent UPDATE/DELETE. Create `platform_plan_catalog(plan PRIMARY KEY, current_version_id)` with a composite FK ensuring matching plan.
- [ ] Add `accounts.plan_version_id`, backfill using initial versions and require composite `(plan, plan_version_id)` FK. Protect this column through the 076 account guard and add explicit SELECT privilege. Add an account INSERT trigger to assign the current matching version, preserving the existing signup function and its 14-day trial.
- [ ] Give authenticated tenants SELECT only safe assigned-definition columns through RLS; platform administrators can read their needed versions, while public RPC `public_plan_catalog()` returns only current safe commercial fields. Revoke broad inherited grants and new-function execution explicitly; no client INSERT/UPDATE/DELETE policies. Keep legacy account-RPC revocation in a separate final cutover migration.
- [ ] Implement service-only version-save RPC from Interfaces: row lock/current-pointer comparison, actor check, validated definition, monotonically increasing revision, insertion/current-pointer update and administrator audit snapshot in one transaction. Identical valid inputs return the current version without duplicate history; stale expected ID returns conflict.
- [ ] Run SQL constraints/RLS/immutability/backfill/idempotent-save tests and commit this independently tested database layer.

### Task 2: Consistent assigned entitlements for browser and server

**Files:** create `src/lib/plan-catalog.ts`, `src/lib/plan-catalog.test.ts`, `src/lib/plan-catalog-server.ts`; modify `src/lib/plans.ts`, `plans.test.ts`, `plans-server.ts`, `src/hooks/use-auth.tsx`, `src/types/index.ts`, `src/lib/auth/account.ts`, `src/components/plans/blocked-screen.tsx` and related translation entries.

- [ ] Write failing Vitest cases named `preservesAssignedVersionAfterCatalogEdit`, `rejectsMissingOrMismatchedDefinition`, and `appliesOverridesToAssignedDefinition`. Assert old Pro max_users stays 10 while a new Pro version with max_users 20 grants 20; individual max_users 3 stays 3 in both. Missing definition produces `blocked.reason === 'plan_unavailable'`, never optional Trial modules; null/unlimited and zero limits preserve their meanings.
- [ ] Run focused tests and observe correct failures; implement the parsers and types from Interfaces. Keep the static catalog only as initial migration/reference fixture, not the runtime fallback for loaded accounts.
- [ ] Update resolver to use `plan_definition`; add `plan_unavailable` block reason and a recoverable unavailable screen. Preserve existing suspension, paid-status and trial expiry rules, mandatory modules and limit helper behavior. Update meaningful existing fixtures to include granted definitions.
- [ ] Update `PLAN_COLUMNS` and `ACCOUNT_SELECT` to join safe version columns through the account FK; centralize normalization, including all `use-auth` initial/refresh mappings. Preserve failed-read denial in APIs/automation engines and prevent ready UI from treating missing definitions as valid defaults.
- [ ] Extend `platform_list_accounts()` to return `plan_version_id` and normalized `plan_definition`, preserving authorization, ownership and capacity counts; update `PlatformAccountRow` and RPC grants (return-type changes require replacing the function explicitly).
- [ ] Run parser/resolver tests plus existing auth, plan, automation, overview and account-filter suites; commit the shared assigned-definition integration.

### Task 3: Authorized, atomic mutations and safe history

**Files:** create `src/app/api/platform/plans/[plan]/route.ts`, `route.test.ts`, `src/app/api/platform/plans/[plan]/history/route.ts`, `route.test.ts`, `supabase/migrations/080_plan_catalog_write_cutover.sql`; modify account PATCH route and create its `route.test.ts`, migration 079, `src/lib/platform/history.ts`, `history.test.ts`, `src/lib/platform/activity-types.ts`, `src/lib/audit.ts`.

- [ ] Write failing route/SQL tests: anonymous, ordinary tenant and gate-locked requests perform no privileged writes; stale expected ID returns 409; invalid module, price/fraction, unknown plan and actor impersonation are rejected. Expected version A plus current B fails without inserting version/audit rows. A historical actor label survives profile changes.
- [ ] Implement GET current plan and PATCH save using `authorizePlatformApi`, parsers and service-only version RPC. Return only validated safe DTOs; map conflict/validation/unavailability to 409/400/500. Revalidate `/precos` only after successful committed change using this Next version's documented API.
- [ ] Implement protected history GET using `loadPlanVersionHistory`, validated plan and cursor, page size 25, no-store and safe projection. Show only this plan's versions; audit author IDs/internal fields are excluded from payloads.
- [ ] Implement `platform_update_account_v2` by carrying forward all current patch validation from migration 058, locking account state, checking actor and expected current catalog ID for a tier change or explicit adoption. Retaining same plan without adoption keeps the granted version even if catalog changed. Switching tier chooses its current version. An adoption with stale preview ID fails rather than granting unseen conditions.
- [ ] Update account PATCH to call v2 with the service client only after both authorization locks. Revoke direct client execution of legacy `platform_update_account` in the final migration; no other production caller should remain. Move relevant account-change audit into the transaction and remove the route's duplicate post-write audit.
- [ ] Extend `PlatformHistory` with `plan_version_change: {from_revision: number, to_revision: number}|null` (positive validated revisions only) and the existing allowlisted module/limit differences when adopting a version. Extend the UI renderer/projection/tests accordingly. Do not expose arbitrary new metadata; explicit adoption history must be meaningful even when the plan key stays the same.
- [ ] Run route, SQL and projection tests; assert changing notes/status preserves version and overrides, adoption records one event, and transaction failure leaves account/catalog/history unchanged. Commit.

### Task 4: Platform plan editor and revision history

**Files:** create `src/app/platform/plans/page.tsx`, `loading.tsx`, `error.tsx`, `src/app/platform/plans/[plan]/page.tsx`, `src/components/platform/plan-catalog-list.tsx`, `plan-catalog-editor.tsx`, `plan-version-history.tsx`; modify `platform-navigation.tsx`, `platform-header.tsx`, `src/lib/i18n-dict/platform.ts`.

- [ ] Extend the browser harness with failing checks for gated navigation and editing Pro modules/limits/price, preview, save, stale-editor conflict and history. Assertions: invalid fractional capacity cannot save, existing company usage does not change after save, updated advertised values appear in current catalog, prior version remains in history.
- [ ] Read Next page/data-fetching docs and Impeccable craft floor; use existing layout/components, Impeccable and React guidance. Add Planos navigation, fix Companies active-route matching and ensure mobile navigation accommodates four entries.
- [ ] Implement current catalog and selected-plan editor using safe DTOs. Price entry converts Brazilian decimal input to integer cents without floating rounding; personalized price uses null. Trial price is fixed zero. Module checkboxes list known optional modules; limits explicitly support unlimited and zero.
- [ ] Show a derived draft preview and preservation notice before save. Preserve draft on errors/conflicts; reload is explicit. Version history loads/paginates lazily and uses translated labels, author/time and safe prior/new details. Success refreshes current version/history without remounting unrelated company forms.
- [ ] Run UI/browser checks for invalid input, empty/error/retry, keyboard labels, desktop/mobile and dark/light accessibility; commit the editor.

### Task 5: Company version choice and public pricing

**Files:** modify `src/components/platform/account-form.tsx`, `account-summary.tsx`, `accounts-table.tsx`, `src/lib/platform/overview.ts`, `src/components/settings/plan-panel.tsx`, `src/app/platform/[accountId]/page.tsx`, `src/app/(marketing)/precos/page.tsx`, translations and related tests.

- [ ] Write failing integration tests: an old Pro company and a newly assigned Pro company show distinct limits after a catalog edit; updating only old-company status keeps its version. Explicit same-tier adoption shows old/new differences and keeps company overrides. Re-saving a stale preview returns conflict without applying unseen terms.
- [ ] Pass current catalog to the account editor separately from assigned definition. Selected tier change previews current terms; unchanged tier uses assigned terms. Add **Atualizar condições do plano** as a draft action with differences visible before saving; include expected current version ID in PATCH.
- [ ] Ensure saved summary, company list, usage alerts and customer plan panel use assigned definition. On save consume the complete refreshed account DTO instead of raw version-less database rows.
- [ ] Remove marketing `PLAN_PRICES` and runtime hardcoded module/limit references; load current public catalog through the server loader, format BRL cents and retain existing copy/order. Price is advertised only. Missing catalog renders a recoverable unavailable state, never misleading hardcoded commercial terms.
- [ ] Run account/overview/marketing tests and browser integration checks, including stale preview and no account-data loss at reduced capacity; commit.

### Task 6: Complete verification, review and release preparation

**Files:** extend `scripts/verify-platform-overview.mjs`; create `docs/verification/plan-catalog/README.md` and synthetic evidence captures/results.

- [ ] Exercise catalog v1/v2, existing/new companies, same-tier adoption, unchanged overrides and trial signup end-to-end against the isolated stack. Verify actual user-invite and channel capacity enforcement plus automation module denial, not just resolver output. Check both gates and direct DB/RPC permission attempts.
- [ ] Verify concurrent saves, lost responses/retry, assigned-definition outage, filtered/paginated safe history, Brazilian prices, personalized price, UI drafts, and public pricing refresh. Capture desktop/mobile and light/dark together; inspect in bounded passes.
- [ ] Run SQL tests, relevant Vitest suites, changed-file ESLint, TypeScript, Prettier, whitespace check and `node scripts/platform-leads-runtime.mjs build` with existing isolated-runtime variables. Then start that runtime and run the expanded agent-browser harness. Record commands/results and limitations; do not claim passing unexecuted checks.
- [ ] Obtain an independent security/architecture/code review, address actionable findings and rerun affected checks. All requirements must have evidence before claiming completion.
- [ ] Prepare deployment instructions with database backup, applied-migration inventory and a verified rollback strategy. Because new privileges/RPC calls and app code are coupled, test the deployment sequence locally: migration 079/schema/backfill first, app cutover, migration 080/legacy-write revocation last. Pause administrative account edits during cutover since the old tier-change RPC does not supply the new assignment; public/tenant reads retain their initial conditions. Preserve assigned data on rollback; do not blindly restore permissive grants or delete versions.
- [ ] Present tested deliverable and ask publication authorization. After approval: create/attach PR, await CI, merge actual tested head, apply reviewed migration sequence and deploy. Verify public pricing, protected access, exact release and server health; document authenticated checks if access is available, otherwise state their local-only coverage.

## Self-review and execution recommendation

Coverage: Tasks 1–3 establish preservation, isolation, shared entitlements and atomic auditing; Tasks 4–5 deliver the approved admin/company/public flows; Task 6 proves behavior and controls deployment. All Review Focus cases have owning tests. No billing, arbitrary plan creation or batch contract updates are introduced.

Recommended execution: **Native**, with implementation in this worktree and independent security/architecture review at the end. The six tasks share database and TypeScript interfaces closely; one implementer keeps those changes consistent, while the independent reviewer checks the complete result. User plan review and execution-method confirmation remain pending.
