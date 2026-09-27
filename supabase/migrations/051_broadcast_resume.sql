-- ============================================================
-- 051_broadcast_resume.sql — disparo abandonado pode ser retomado
--   pelo servidor (portado do wacrm, #472/#495, upstream 3376991,
--   migration 038_broadcast_resume dele — renumerada: 038 já é o nosso
--   internal_chat)
--
-- O problema: o laço de envio do disparo roda na aba do navegador que o
-- criou. Fechou a aba no meio, os destinatários restantes ficam
-- 'pending' e o disparo fica em 'sending' para sempre. Retomar do
-- servidor (e reenviar os que falharam) precisa de três coisas que o
-- schema não guardava:
--
--   1. broadcast_recipients.template_params — os valores {{1}}, {{2}}…
--      de cada destinatário. O assistente resolvia no navegador na hora
--      do envio e nunca gravava; sem isso a retomada não sabe o que
--      mandar. Congelar no planejamento também garante que a retomada
--      manda exatamente o que a primeira passada mandaria.
--
--   2. broadcasts.delivery_locked_at — trava de entrega. "Retomar" é um
--      botão: dois cliques, ou um clique enquanto outra passada ainda
--      envia, mandariam mensagem duas vezes (e WhatsApp não se desfaz).
--      Tomada com UM UPDATE condicional; uma trava velha demais é lida
--      como abandonada. No SempreCRM o próprio assistente também segura
--      e renova essa trava enquanto envia, então "Retomar" não atropela
--      um envio que ainda está vivo em outra aba.
--
--   3. broadcasts.header_media_url — (só SempreCRM) a URL da mídia do
--      cabeçalho escolhida no assistente (#298). Sem ela, a retomada de
--      um modelo com imagem/vídeo/documento cairia na URL de amostra do
--      modelo, diferente do que a primeira passada enviou.
--
-- Diferença do upstream: a parte 3 dele (recriar
-- create_broadcast_with_recipients com p_template_params) NÃO vem — essa
-- função pertence à API pública v1 de disparos, que o SempreCRM não tem.
--
-- Só adiciona colunas anuláveis (sem reescrever dados). Linhas antigas
-- ficam com template_params NULL, lido pela retomada como "sem
-- parâmetros". Idempotente.
-- ============================================================

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS template_params JSONB;

COMMENT ON COLUMN broadcast_recipients.template_params IS
  'Valores posicionais do corpo do modelo ({{1}}, {{2}}, ...) deste destinatário, congelados quando o disparo foi planejado. NULL em linhas anteriores à 051; a retomada trata como sem parâmetros.';

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS delivery_locked_at TIMESTAMPTZ;

COMMENT ON COLUMN broadcasts.delivery_locked_at IS
  'Preenchido enquanto uma passada de entrega (assistente ou retomada no servidor) está enviando; NULL quando ociosa. Ver 051_broadcast_resume.sql.';

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url TEXT;

COMMENT ON COLUMN broadcasts.header_media_url IS
  'URL da mídia do cabeçalho (imagem/vídeo/documento) escolhida no assistente; usada também pela retomada. NULL = usa a URL guardada no modelo.';

-- A retomada seleciona os pending/failed de um disparo. O índice já
-- existe desde a 003; repetido aqui só para a migração se sustentar
-- sozinha (IF NOT EXISTS = no-op).
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_status
  ON broadcast_recipients (broadcast_id, status);
