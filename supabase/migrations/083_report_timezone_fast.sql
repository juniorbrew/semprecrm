-- ============================================================
-- 083: report_timezone without pg_timezone_names.
--
-- 075 validated the account's time zone by joining
-- pg_catalog.pg_timezone_names, which reads the whole tz database from
-- disk on every call (~1 200 zones). Every support_report /
-- support_report_backlog call paid it: ~620 ms mean in production,
-- almost all of it here.
--
-- Same contract: an IANA name the server knows is returned as is; a
-- missing, malformed or unknown value falls back to America/Sao_Paulo.
-- The name is checked by asking the server to use it (AT TIME ZONE
-- raises invalid_parameter_value for an unknown zone). The shape check
-- keeps out POSIX offsets ("UTC+3", "-03") that AT TIME ZONE accepts
-- but pg_timezone_names never listed. Still accepted and harmless:
-- other letter case ("america/sao_paulo") and abbreviations ("BRT"),
-- which the server resolves to the same offset.
--
-- CREATE OR REPLACE keeps the grants from 075 (authenticated,
-- service_role; nothing for PUBLIC/anon).
-- ============================================================

CREATE OR REPLACE FUNCTION public.report_timezone(p_account_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_tz text;
BEGIN
  SELECT a.preferences->'business_hours'->>'timezone' INTO v_tz
    FROM public.accounts a
   WHERE a.id = p_account_id;

  IF v_tz IS NULL
     OR v_tz !~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'
     -- a signed offset is POSIX ("UTC+3" = 3 h WEST), except the real
     -- zone files Etc/GMT±N and GMT±0
     OR (v_tz ~ '[+-][0-9]' AND v_tz !~* '^(posix/)?(Etc/GMT[+-][0-9]{1,2}|GMT[+-]0)$') THEN
    RETURN 'America/Sao_Paulo';
  END IF;

  PERFORM now() AT TIME ZONE v_tz;
  RETURN v_tz;
EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN 'America/Sao_Paulo';
END;
$$;
