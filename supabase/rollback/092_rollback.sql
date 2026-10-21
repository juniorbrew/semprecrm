-- Forward rollback of 092_scheduled_messages.sql. NOT a migration: run by hand.
-- Roll the APP back first (the composer / cron call this table).
-- Destroys every queued message. Afterwards delete 092 from
-- supabase_migrations.schema_migrations so a later `db push` re-applies it.
BEGIN;
DROP FUNCTION IF EXISTS public.scheduled_messages_claim(timestamptz, integer, uuid);
DROP TABLE IF EXISTS public.scheduled_messages;   -- drops the cap trigger with it
DROP FUNCTION IF EXISTS public.scheduled_messages_cap();
COMMIT;
