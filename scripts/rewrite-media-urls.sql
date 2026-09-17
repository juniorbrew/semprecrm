-- ============================================================
-- One-off local data fix: rewrite absolute Supabase Storage URLs that
-- were stored while the browser talked to Supabase directly
-- (http://127.0.0.1:56021, http://localhost:56021, http://192.168.1.10:56021)
-- into origin-relative paths under the same-origin proxy prefix
-- (`/supabase/storage/...`), so rows work from localhost, LAN IP or VPN.
--
-- Idempotent: only rows whose value still starts with one of the old
-- absolute bases are touched; already-relative rows and foreign URLs
-- (Meta CDN, external logos) are left alone. Re-running is a no-op.
--
-- Run:
--   docker exec -i supabase_db_semprecrm psql -U postgres -d postgres \
--     < scripts/rewrite-media-urls.sql
--
-- Columns covered (grep migrations for `_url` / storage-bearing jsonb):
--   messages.media_url                 (001)
--   contacts.avatar_url                (001)
--   profiles.avatar_url                (001 / 008 avatars bucket)
--   message_templates.header_media_url (014, chat-media bucket)
--   flow_nodes.config ->> 'media_url'  (010 / 016 flow-media bucket, send_media nodes)
--   accounts.branding ->> 'logo_url'   (037 branding jsonb)
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

-- Old absolute bases → new relative prefix. Add more hosts here if needed.
CREATE TEMP TABLE _media_url_bases (old_base text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _media_url_bases (old_base) VALUES
  ('http://127.0.0.1:56021/storage/'),
  ('http://localhost:56021/storage/'),
  ('http://192.168.1.10:56021/storage/');

-- Rewrites the first matching base; returns the input unchanged otherwise.
CREATE OR REPLACE FUNCTION pg_temp.rewrite_media_url(v text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT '/supabase/storage/' || substr(v, length(b.old_base) + 1)
       FROM _media_url_bases b
      WHERE v LIKE b.old_base || '%'
      LIMIT 1),
    v
  );
$$;

CREATE TEMP TABLE _media_url_counts (target text, rows_updated bigint) ON COMMIT DROP;

-- messages.media_url ------------------------------------------------
WITH upd AS (
  UPDATE messages m
     SET media_url = pg_temp.rewrite_media_url(m.media_url)
   WHERE m.media_url IS NOT NULL
     AND EXISTS (SELECT 1 FROM _media_url_bases b WHERE m.media_url LIKE b.old_base || '%')
  RETURNING 1
)
INSERT INTO _media_url_counts SELECT 'messages.media_url', count(*) FROM upd;

-- contacts.avatar_url -----------------------------------------------
WITH upd AS (
  UPDATE contacts c
     SET avatar_url = pg_temp.rewrite_media_url(c.avatar_url)
   WHERE c.avatar_url IS NOT NULL
     AND EXISTS (SELECT 1 FROM _media_url_bases b WHERE c.avatar_url LIKE b.old_base || '%')
  RETURNING 1
)
INSERT INTO _media_url_counts SELECT 'contacts.avatar_url', count(*) FROM upd;

-- profiles.avatar_url -----------------------------------------------
WITH upd AS (
  UPDATE profiles p
     SET avatar_url = pg_temp.rewrite_media_url(p.avatar_url)
   WHERE p.avatar_url IS NOT NULL
     AND EXISTS (SELECT 1 FROM _media_url_bases b WHERE p.avatar_url LIKE b.old_base || '%')
  RETURNING 1
)
INSERT INTO _media_url_counts SELECT 'profiles.avatar_url', count(*) FROM upd;

-- message_templates.header_media_url --------------------------------
WITH upd AS (
  UPDATE message_templates t
     SET header_media_url = pg_temp.rewrite_media_url(t.header_media_url)
   WHERE t.header_media_url IS NOT NULL
     AND EXISTS (SELECT 1 FROM _media_url_bases b WHERE t.header_media_url LIKE b.old_base || '%')
  RETURNING 1
)
INSERT INTO _media_url_counts SELECT 'message_templates.header_media_url', count(*) FROM upd;

-- flow_nodes.config->>'media_url' (send_media nodes) ----------------
WITH upd AS (
  UPDATE flow_nodes n
     SET config = jsonb_set(
           n.config,
           '{media_url}',
           to_jsonb(pg_temp.rewrite_media_url(n.config ->> 'media_url'))
         )
   WHERE jsonb_typeof(n.config -> 'media_url') = 'string'
     AND EXISTS (SELECT 1 FROM _media_url_bases b WHERE (n.config ->> 'media_url') LIKE b.old_base || '%')
  RETURNING 1
)
INSERT INTO _media_url_counts SELECT 'flow_nodes.config.media_url', count(*) FROM upd;

-- accounts.branding->>'logo_url' ------------------------------------
WITH upd AS (
  UPDATE accounts a
     SET branding = jsonb_set(
           a.branding,
           '{logo_url}',
           to_jsonb(pg_temp.rewrite_media_url(a.branding ->> 'logo_url'))
         )
   WHERE jsonb_typeof(a.branding -> 'logo_url') = 'string'
     AND EXISTS (SELECT 1 FROM _media_url_bases b WHERE (a.branding ->> 'logo_url') LIKE b.old_base || '%')
  RETURNING 1
)
INSERT INTO _media_url_counts SELECT 'accounts.branding.logo_url', count(*) FROM upd;

-- Report ------------------------------------------------------------
SELECT target, rows_updated FROM _media_url_counts ORDER BY target;

-- Anything left that still points at an absolute local storage URL?
SELECT 'messages.media_url' AS target, count(*) AS remaining_absolute_local
  FROM messages WHERE media_url ~ '^https?://(127\.0\.0\.1|localhost|192\.168\.1\.10):56021/storage/'
UNION ALL
SELECT 'contacts.avatar_url', count(*)
  FROM contacts WHERE avatar_url ~ '^https?://(127\.0\.0\.1|localhost|192\.168\.1\.10):56021/storage/'
UNION ALL
SELECT 'profiles.avatar_url', count(*)
  FROM profiles WHERE avatar_url ~ '^https?://(127\.0\.0\.1|localhost|192\.168\.1\.10):56021/storage/'
UNION ALL
SELECT 'message_templates.header_media_url', count(*)
  FROM message_templates WHERE header_media_url ~ '^https?://(127\.0\.0\.1|localhost|192\.168\.1\.10):56021/storage/'
UNION ALL
SELECT 'flow_nodes.config.media_url', count(*)
  FROM flow_nodes WHERE (config ->> 'media_url') ~ '^https?://(127\.0\.0\.1|localhost|192\.168\.1\.10):56021/storage/'
UNION ALL
SELECT 'accounts.branding.logo_url', count(*)
  FROM accounts WHERE (branding ->> 'logo_url') ~ '^https?://(127\.0\.0\.1|localhost|192\.168\.1\.10):56021/storage/';

COMMIT;
