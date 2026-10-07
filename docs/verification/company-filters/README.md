# Company filters verification

Verified on 2026-10-07 against an isolated local Supabase stack with synthetic accounts.

The company list now combines plan, status, expiration and capacity filters with text search. Expiration options cover expired accounts, the next 7 or 30 days, and accounts without an expiration date. Search ignores case and accents. Clear filters restores all companies. Existing dashboard links using `attention=expired` or `attention=expiring` remain supported. All expiration calculations use the same server snapshot.

## Evidence

- 11 unit tests passed across account filters and the existing overview logic.
- 12 browser checks passed; see `results.json` for the checked flows.
- Production build, TypeScript, changed-file ESLint, Prettier and diff whitespace checks passed.
- Independent code review approved the change without actionable findings.
- Light and dark accessibility audits reported no violations; browser errors and failed requests were absent.
- Combined filters and clearing were verified at desktop, tablet and mobile sizes.

New filter screenshots: `company-filters-1440.png`, `company-filters-375.png`, and `company-filters-light.png`. Other screenshots cover the existing platform flows exercised by the same browser harness. All displayed account data is synthetic.

This change adds no migrations or dependencies and leaves platform authorization checks in place. Authenticated browser checks ran locally; production verification is recorded separately after deployment.
