-- Rollback of 114_plan_extras.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first. This DROPS the contracted extras (they would stop being billed and
-- the limit would fall back to the plan): list them first with
--   SELECT account_id, extra_users, extra_channels FROM account_billing WHERE extra_users > 0 OR extra_channels > 0;
-- and fix the Asaas subscription values by hand for those accounts.
-- Plan versions that carry extra_*_price_cents must be gone before valid_plan_definition goes back
-- (the old function rejects the keys); versions are immutable, so a version with them stays and the
-- old CHECK would fail on re-validation only when rewritten. Leave valid_plan_definition as is if any exist.
BEGIN;
ALTER TABLE public.account_billing
  DROP CONSTRAINT IF EXISTS account_billing_extra_users_priced,
  DROP CONSTRAINT IF EXISTS account_billing_extra_channels_priced,
  DROP COLUMN IF EXISTS extra_users,
  DROP COLUMN IF EXISTS extra_channels,
  DROP COLUMN IF EXISTS extra_user_price_cents,
  DROP COLUMN IF EXISTS extra_channel_price_cents;
COMMIT;
