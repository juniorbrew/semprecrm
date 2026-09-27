-- ============================================================
-- 051_broadcast_resume.sql — disparo abandonado pode ser retomado
--   pelo servidor SEM enviar duas vezes para ninguém (portado do wacrm,
--   #472/#495, upstream 3376991 — a 038_broadcast_resume dele,
--   renumerada: 038 já é o nosso internal_chat)
--
-- O problema: o laço de envio do disparo rodava na aba do navegador que
-- o criou. Fechou a aba no meio, os destinatários restantes ficavam
-- 'pending' e o disparo em 'sending' para sempre. Retomar pelo servidor
-- só é seguro se NENHUM caminho puder mandar a mesma linha duas vezes
-- (WhatsApp não se desfaz, e a Meta bane número que repete disparo).
--
-- O que muda no schema:
--
--   1. broadcast_recipients.status ganha dois valores:
--        'sending'   — a linha foi REIVINDICADA por uma passada de envio
--                      (UPDATE ... SET status='sending' WHERE status IN
--                      (...) RETURNING — atômico, só um vence). Quem não
--                      reivindicou não envia. Retomar nunca pega 'sending'.
--        'uncertain' — resultado incerto: a Meta pode ou não ter recebido
--                      (rede caiu, timeout, 5xx, resposta ilegível, ou a
--                      passada morreu com a linha em 'sending'). NUNCA é
--                      reenviado automaticamente — fica para o operador.
--      'failed' passa a significar só erro CONFIRMADO (a Meta recusou,
--      telefone inválido, opt-out) — é o único que "Reenviar falhas" pega.
--      O gatilho de contagem (003/005) ignora os dois novos valores
--      (_bcast_cols_for_status cai no ELSE), então nada muda nas contagens.
--
--   2. broadcast_recipients.claimed_at — quando a linha foi reivindicada.
--      Linha em 'sending' há mais que a janela de abandono (10 min) é de
--      uma passada morta: vira 'uncertain', nunca volta a 'pending'.
--
--   3. broadcast_recipients.template_params — os valores {{1}}, {{2}}…
--      de cada destinatário, congelados no planejamento. Sem isso a
--      retomada não sabe o que mandar; linhas antigas ficam NULL e a
--      retomada RECUSA disparo antigo cujo modelo tem variáveis.
--
--   4. broadcasts.delivery_locked_at — trava da passada (assistente ou
--      retomada). O valor é também o "token" do dono: renovar e liberar
--      são UPDATE ... WHERE delivery_locked_at = <o meu valor>, então uma
--      aba parada não renova nem libera a trava de outra passada.
--
--   5. broadcasts.header_media_url — (só SempreCRM) a URL da mídia do
--      cabeçalho escolhida no assistente (#298), lida pelo servidor em
--      toda passada.
--
--   6. broadcasts.delivery_protocol — NULL = disparo LEGADO (criado pelo
--      código anterior a esta versão, que carimbava linhas no navegador);
--      1 = criado com o protocolo de reivindicação por linha. Só nos
--      legados a regra "'sending' sem trava + updated_at recente = ainda
--      ativo" vale (a aba antiga não usava trava); nos novos, trava NULL
--      significa passada encerrada e a retomada é liberada na hora.
--      Linhas 'failed' com claimed_at NULL também são do código antigo
--      (que marcava lotes inteiros como failed mesmo quando o servidor
--      pode ter enviado) — "Reenviar falhas" NUNCA as pega; a tela mostra
--      como "falha antiga (não reenviável)". Nenhum dado é reescrito.
--
--   7. broadcasts.uncertain_count — contador de linhas 'uncertain',
--      mantido pelo mesmo gatilho incremental das outras contagens
--      (_bcast_cols_for_status ganha o caso 'uncertain'). Começa em 0,
--      correto para todo disparo existente (nenhum tem linha incerta).
--
-- Diferença do upstream: NÃO recria create_broadcast_with_recipients (é
-- da API pública v1, que o SempreCRM não tem).
--
-- Dados existentes: colunas novas anuláveis (ou DEFAULT 0 constante, sem
-- reescrita de tabela no PG 11+), uma CHECK mais larga e duas funções de
-- contagem recriadas — nenhuma linha é reescrita. Idempotente.
-- ============================================================

-- 1. Status 'sending' / 'uncertain'. A CHECK original (001) é inline, sem
--    nome explícito; derruba qualquer CHECK de status da tabela e recria
--    com nome fixo.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.broadcast_recipients'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.broadcast_recipients DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE broadcast_recipients
  ADD CONSTRAINT broadcast_recipients_status_check
  CHECK (status IN (
    'pending', 'sending', 'sent', 'delivered', 'read', 'replied', 'failed', 'uncertain'
  ));

-- 2. Momento da reivindicação.
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN broadcast_recipients.claimed_at IS
  'Quando uma passada de envio reivindicou a linha (status pending/failed -> sending). Linha em sending há mais de 10 min vira uncertain. Ver 051_broadcast_resume.sql.';

-- 3. Parâmetros congelados.
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS template_params JSONB;

COMMENT ON COLUMN broadcast_recipients.template_params IS
  'Valores posicionais do corpo do modelo ({{1}}, {{2}}, ...) deste destinatário, congelados quando o disparo foi planejado. NULL em linhas anteriores à 051; a retomada recusa esses disparos se o modelo tiver variáveis.';

-- 4. Trava / token da passada.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS delivery_locked_at TIMESTAMPTZ;

COMMENT ON COLUMN broadcasts.delivery_locked_at IS
  'Trava da passada de entrega (assistente ou retomada) e token do dono: renovar/liberar só com WHERE delivery_locked_at = valor próprio. NULL quando ociosa. Ver 051_broadcast_resume.sql.';

-- 5. Mídia do cabeçalho.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url TEXT;

COMMENT ON COLUMN broadcasts.header_media_url IS
  'URL da mídia do cabeçalho (imagem/vídeo/documento) escolhida no assistente; lida pelo servidor em todo envio. NULL = usa a URL guardada no modelo.';

-- 6. Protocolo de entrega (NULL = legado).
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS delivery_protocol SMALLINT;

COMMENT ON COLUMN broadcasts.delivery_protocol IS
  'NULL = disparo legado (código anterior à 051, carimbava no navegador); 1 = protocolo de reivindicação por linha. Ver 051_broadcast_resume.sql.';

-- 7. Contador de resultado incerto, mantido pelo gatilho de 005.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS uncertain_count INTEGER DEFAULT 0;

CREATE OR REPLACE FUNCTION public._bcast_cols_for_status(s TEXT)
RETURNS TEXT[] AS $$
BEGIN
  -- 'pending' and 'sending' contribute to nothing.
  IF s = 'pending' THEN RETURN ARRAY[]::TEXT[]; END IF;
  IF s = 'sent'      THEN RETURN ARRAY['sent_count']; END IF;
  IF s = 'delivered' THEN RETURN ARRAY['sent_count','delivered_count']; END IF;
  IF s = 'read'      THEN RETURN ARRAY['sent_count','delivered_count','read_count']; END IF;
  IF s = 'replied'   THEN RETURN ARRAY['sent_count','delivered_count','read_count','replied_count']; END IF;
  IF s = 'failed'    THEN RETURN ARRAY['failed_count']; END IF;
  IF s = 'uncertain' THEN RETURN ARRAY['uncertain_count']; END IF;
  RETURN ARRAY[]::TEXT[];
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.recompute_broadcast_counts(bid UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE broadcasts b SET
    sent_count      = agg.sent_count,
    delivered_count = agg.delivered_count,
    read_count      = agg.read_count,
    replied_count   = agg.replied_count,
    failed_count    = agg.failed_count,
    uncertain_count = agg.uncertain_count,
    updated_at      = NOW()
  FROM (
    SELECT
      COUNT(*) FILTER (WHERE status IN ('sent','delivered','read','replied')) AS sent_count,
      COUNT(*) FILTER (WHERE status IN ('delivered','read','replied'))        AS delivered_count,
      COUNT(*) FILTER (WHERE status IN ('read','replied'))                    AS read_count,
      COUNT(*) FILTER (WHERE status = 'replied')                              AS replied_count,
      COUNT(*) FILTER (WHERE status = 'failed')                               AS failed_count,
      COUNT(*) FILTER (WHERE status = 'uncertain')                            AS uncertain_count
    FROM broadcast_recipients
    WHERE broadcast_id = bid
  ) agg
  WHERE b.id = bid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- A reivindicação e as contagens filtram por (broadcast_id, status). O
-- índice já existe desde a 003; repetido só para a migração se sustentar
-- sozinha (IF NOT EXISTS = no-op).
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_status
  ON broadcast_recipients (broadcast_id, status);
