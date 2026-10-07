# Company administrative history

Verified on 2026-10-07 using synthetic companies in the isolated local Supabase stack.

## Delivered behavior

- Initial and final date filters include full Bahia calendar days (UTC-03), with an exclusive next-day boundary that retains database microseconds.
- Date, audit action and literal partial actor-name filters combine before server pagination. Open date boundaries are supported.
- Apply filters starts a new result set; clear restores the complete history. Invalid/inverted ranges are rejected. Empty and unavailable results remain distinct.
- After first opening, the history remains mounted so filters, drafts and pagination survive switching tabs. Company form drafts remain untouched.
- Plan-change events display safe before/after values for plan, status, expiration, optional modules and user/channel limits. Missing overrides mean inheritance; explicit null limits mean unlimited.
- Existing events without valid change details still show their action, actor and timestamp. Raw audit metadata, unknown fields and credential values are never serialized.
- Platform authentication, second gate, company existence checks, account scoping and no-store responses remain enforced.

## Verification

- 44 focused tests passed (history helper, activity route, company filters and overview).
- 13 full browser verification groups passed; see `results.json`.
- Tests cover exact date boundaries, leap days, inverted/invalid inputs, literal SQL pattern escaping, safe projection, filtered pagination, clearing, empty states and switching tabs.
- Independent security/functional review approved the implementation after the tab-state regression was corrected.
- Production build and TypeScript passed, with 86 pages generated. Existing Next.js middleware/Edge warnings remain.
- Changed-file ESLint, Prettier and whitespace checks passed.
- Desktop, tablet and mobile layout checked; light/dark accessibility audits show zero violations and no browser errors or failed requests.

Screenshots: `company-history-1440.png`, `company-history-375.png`, `company-history-light.png`. Other evidence captures existing platform flows exercised by the same harness. The CLI's plain text fill does not retain Chromium date input values, so the harness sets the native date value and dispatches input/change events, then asserts retained values and result behavior.

No migrations, new dependencies or environment file changes. Authenticated checks ran locally. This stage has not been deployed.

The local Docker runtime had stale zero-byte IPC socket files. Recovery preserved the affected runtime directories as backups and restarted Docker; database volumes and configuration files were not changed.
