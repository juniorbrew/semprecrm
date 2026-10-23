# Cobrança de assinaturas com o Asaas

Data: 12/10/2026. Decisões do responsável pelo produto, registradas na conversa de 12/10:

| Decisão | Escolha |
|---|---|
| Provedor | Asaas |
| Formas de pagamento | Pix, boleto e cartão — o cliente escolhe na página do Asaas (`billingType: UNDEFINED`) |
| Ciclos | Mensal e anual |
| Preço anual | Mensal × 10 (dois meses grátis), calculado do catálogo |
| Teste vencido sem pagamento | Somente leitura. Fase 1 no app (telas + rotas caras no servidor); fase 2 no banco |

## Escopo por entrega

1. **Servidor e banco (este PR):** tabelas, cliente da API, rota de assinatura e rota de webhooks. Fica inerte sem `ASAAS_API_KEY`.
2. **Telas e somente leitura:** Configurações → Plano (escolher plano/ciclo, assinar, situação, cobranças), botão "Assinar" na tela de bloqueio, modo somente leitura no app e no servidor para envios, disparos, automações e IA.
3. **Banco (fase 2 do bloqueio):** regras de gravação passam a checar a situação da conta.

## Planos vendidos

Só planos com preço no catálogo (`platform_plan_versions.price_monthly_cents`): hoje Básico (R$ 59,90) e Pro (R$ 89,90). Empresa (sem preço) continua "fale conosco". O preço e a versão do plano são gravados no momento da assinatura; mudar o catálogo depois não altera assinaturas existentes.

## Fluxo

1. O proprietário escolhe plano e ciclo → `POST /api/billing/checkout`.
2. O servidor garante o cliente no Asaas (`POST /v3/customers`, CPF/CNPJ do cadastro, `externalReference` = id da conta) e cria a assinatura (`POST /v3/subscriptions`, `billingType: UNDEFINED`, `cycle: MONTHLY|YEARLY`, primeiro vencimento hoje, `externalReference` = id da conta).
3. Devolve o link da primeira cobrança (`invoiceUrl`); o cliente paga no Asaas.
   - Mesmo plano e ciclo ainda pendentes → devolve a mesma cobrança. Outra escolha → cria a assinatura nova, troca a linha com *compare-and-swap* e só então cancela a antiga. Quem perde uma corrida, ou falha depois de criar, cancela a própria assinatura.
   - Cobrança pendente já paga (webhook ainda não chegou) → 409; nunca se cancela uma assinatura paga.
   - Conta suspensa pela plataforma não assina (403).
4. O Asaas avisa por webhook (`POST /api/billing/asaas/webhook`, token no cabeçalho `asaas-access-token`).

## Webhooks

- Token comparado em tempo constante com `ASAAS_WEBHOOK_TOKEN`; sem token válido → 401.
- Cada evento é gravado pelo `id` antes de qualquer efeito; repetido → 200 sem reprocessar (entrega "pelo menos uma vez").
- Antes de liberar, a cobrança é **consultada de volta na API** (`GET /v3/payments/{id}`), para não confiar só no corpo recebido.
- Efeitos sobre a conta (só para cobranças de uma assinatura nossa):

| Evento | Efeito |
|---|---|
| `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` | `plan` e versão da assinatura, `plan_status = active`, vencimento = vencimento da cobrança + 1 mês ou 1 ano + 5 dias de tolerância |
| `PAYMENT_OVERDUE` | `plan_status = past_due` |
| `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_RECEIVED_IN_CASH_UNDONE` | `plan_status = past_due` |
| demais | só registro (sem consultar a API) |

- Os efeitos valem só para a assinatura **atual** da conta (`billing_activate` / `billing_mark_past_due` recebem o id da assinatura).
- Pagamento atrasado de uma cobrança antiga não tira a conta de `past_due`: só um pagamento que estende o período.
- Suspensão pela plataforma nunca é desfeita por pagamento; `past_due` só sai de `active`.
- Erro transitório (timeout, 5xx) → 500 para o Asaas tentar de novo. Erro que se repetiria sempre (cobrança inexistente, de outra assinatura) → registrado e 200, porque o Asaas pausa a fila inteira depois de falhas seguidas.
- O corpo gravado não guarda dados de cartão (`payment.creditCard`).

## Rede de segurança (cron)

`GET /api/billing/cron` (de hora em hora, `scripts/cron-tick.mjs`) chama `billing_expire_lapsed()`: assinatura `active` cujo período (com tolerância) acabou sem pagamento novo vira `past_due`. Cobre assinatura apagada no Asaas e fila de webhook pausada. Contas sem assinatura no Asaas (ativadas à mão pela plataforma) não são afetadas.

## Segurança

- Rota de assinatura: só o proprietário da conta; conta da sessão, nunca do corpo.
- Chave da API e token do webhook só em variáveis de ambiente do servidor; nunca no navegador, em logs ou no banco.
- Tabelas de cobrança: leitura só para proprietário/administradores da conta; escrita só pelo servidor (service role).
- Colunas de plano da conta continuam protegidas pela trava da 076; só o servidor as altera.

## Variáveis de ambiente

`ASAAS_API_KEY`, `ASAAS_API_URL` (`https://api-sandbox.asaas.com/v3` em testes), `ASAAS_WEBHOOK_TOKEN`.

## Somente leitura (fase 1, entrega 2)

- Uma só regra: `readOnlyReason()` (`src/lib/billing/read-only.ts`) sobre `resolveEntitlements().blocked`. Teste vencido e `past_due` são somente leitura; suspensão da plataforma, cancelamento e plano ilegível continuam bloqueio total (tela de bloqueio, 403).
- Servidor: `requireWritable` e `requireModule` respondem 402 `read_only` em pt-BR nas rotas que começam envio (WhatsApp enviar/reagir/digitando, disparos, mensagens agendadas, IA). Os remetentes dos motores (`engineSend*`, automações e fluxos) recusam contas bloqueadas; os crons de agendadas e CSAT pulam a conta (a agendada falha com motivo visível). Entrada (mensagens de clientes, webhooks da Meta e do gateway, captura de leads, reconexão do QR) continua funcionando.
- A API pública v1 continua inteiramente bloqueada para contas somente leitura (decisão do responsável).
- Troca de plano/ciclo de assinatura **ativa** fica com a equipe (decisão do responsável).

### Lacuna conhecida da fase 1

As gravações de dados do CRM (contatos, tarefas, negócios etc.) feitas com o JWT do próprio usuário só são bloqueadas **na interface**; uma chamada direta ao Supabase de uma conta somente leitura ainda grava. O bloqueio no banco (RLS/gatilhos checando a situação da conta) é a **fase 2 do bloqueio** (entrega 3). As rotas de envio e custo (WhatsApp, IA, disparos, automações) já recusam no servidor.

