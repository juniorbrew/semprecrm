-- ============================================================
-- 089: new accounts and deals default to BRL.
--
-- 021 (accounts.default_currency) and 001 (deals.currency) defaulted to
-- USD, so every new Brazilian account showed "US$" on the dashboard,
-- pipelines and deals until someone changed Settings → Negócios e moeda.
-- Only the column DEFAULTs change: existing accounts and deals keep the
-- currency they have (an account that chose USD stays USD).
--
-- Rollback: ALTER ... SET DEFAULT 'USD' on both columns.
-- ============================================================

ALTER TABLE public.accounts ALTER COLUMN default_currency SET DEFAULT 'BRL';
ALTER TABLE public.deals ALTER COLUMN currency SET DEFAULT 'BRL';
