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
-- Diferença do upstream: NÃO recria create_broadcast_with_recipients (é
-- da API pública v1, que o SempreCRM não tem).
--
-- Dados existentes: só colunas anuláveis e uma CHECK mais larga — nenhuma
-- linha é reescrita. Idempotente.
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

-- A reivindicação e as contagens filtram por (broadcast_id, status). O
-- índice já existe desde a 003; repetido só para a migração se sustentar
-- sozinha (IF NOT EXISTS = no-op).
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_status
  ON broadcast_recipients (broadcast_id, status);
