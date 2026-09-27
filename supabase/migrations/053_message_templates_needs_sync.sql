-- ============================================================
-- 053_message_templates_needs_sync
--
-- Follow-up to the template webhook stub (wacrm #534). A status /
-- quality event for a template created directly in Meta Business
-- Manager now inserts a stub `message_templates` row — identity and
-- status only, `body_text = ''`, no header / buttons. Such a row must
-- not be offered by the inbox template picker, the automation builder
-- or the broadcast wizard, and senders must refuse it: Meta rejects a
-- send built without the template's components.
--
-- `needs_sync` marks those stubs. The webhook sets it on insert; "Sync
-- from Meta" writes the real components and clears it. Existing rows
-- are real templates, so the default is false.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE public.message_templates
  ADD COLUMN IF NOT EXISTS needs_sync BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.message_templates.needs_sync IS
  'True for a stub created by the template webhook for a template that '
  'exists on Meta but was never synced (no body/components). Hidden from '
  'pickers and refused by senders until "Sync from Meta" clears it.';
