\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('cc110000-0000-4000-8000-000000000001','critic-perf@example.test','{}');
INSERT INTO public.platform_admins(user_id) VALUES ('cc110000-0000-4000-8000-000000000001');
INSERT INTO public.leads(kind,status,name,email,company,notification_next_attempt_at,created_at)
SELECT CASE WHEN i%2=0 THEN 'contato' ELSE 'cadastro' END,
 (ARRAY['novo','em_contato','convertido','descartado'])[1+i%4],
 'Critic performance '||i, 'critic-perf-'||i||'@example.test', 'Company '||i,
 '2099-01-01', now()-i*interval '1 minute'
FROM generate_series(1,10000) i;
ANALYZE public.leads;
EXPLAIN (ANALYZE,BUFFERS) SELECT id FROM public.leads ORDER BY created_at DESC,id DESC LIMIT 25;
EXPLAIN (ANALYZE,BUFFERS) SELECT id FROM public.leads WHERE status='novo' ORDER BY created_at DESC,id DESC LIMIT 25;
EXPLAIN (ANALYZE,BUFFERS) SELECT id FROM public.leads WHERE lower(name||' '||email||' '||coalesce(company,'')) LIKE '%performance 9876%';
CREATE TEMP TABLE timings(scenario text,ms numeric,payload_bytes integer,rows integer);
GRANT ALL ON timings TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','cc110000-0000-4000-8000-000000000001',true);
DO $$
DECLARE t timestamptz; v jsonb; i integer; scenario text;
BEGIN
FOREACH scenario IN ARRAY ARRAY['first_page','filtered','deep_offset','search'] LOOP
 FOR i IN 1..40 LOOP
  t:=clock_timestamp();
  v:=public.platform_list_leads(25,CASE WHEN scenario='deep_offset' THEN 9000 ELSE 0 END,
   CASE WHEN scenario='filtered' THEN 'novo' ELSE NULL END,NULL,
   CASE WHEN scenario='search' THEN 'performance 9876' ELSE '' END);
  INSERT INTO timings VALUES(scenario,extract(epoch FROM clock_timestamp()-t)*1000,octet_length(v::text),jsonb_array_length(v->'leads'));
 END LOOP;
END LOOP;
END $$;
SELECT scenario,count(*) runs,round(avg(ms),3) avg_ms,percentile_cont(0.95) WITHIN GROUP(ORDER BY ms) p95_ms,max(ms) max_ms,max(payload_bytes) max_payload_bytes,max(rows) max_rows FROM timings GROUP BY scenario ORDER BY scenario;
RESET ROLE;
ROLLBACK;
