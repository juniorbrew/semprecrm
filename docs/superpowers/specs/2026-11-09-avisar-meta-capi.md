# Spec: avisar a Meta dos leads e vendas (origem dos clientes, parte B)

Status: aprovado pelo dono do produto (2026-11-09). Entrega 9 do roteiro vocero (`docs/verification/vocero-evolution/ROADMAP.md`), parte B. Depende da parte A (PR #135: `lead_origins`, `deals.origin_id`).

## Objetivo

A empresa anuncia no Facebook e no Instagram, mas a Meta só sabe que alguém clicou ou mandou mensagem. Ela não sabe quem virou negócio nem quem comprou. Sem essa informação, a Meta otimiza o anúncio para conversas, e não para vendas.

Com esta parte, o SempreCRM avisa a Meta (Conversions API) em dois momentos:
- **Lead:** quando um negócio é criado para um cliente que veio de anúncio da Meta;
- **Venda:** quando esse negócio é marcado como ganho, com o valor e a moeda.

Sucesso:
- no Gerenciador de Eventos da Meta da empresa aparecem os eventos de lead e de compra;
- o admin vê no SempreCRM o que foi enviado, o que falhou e por quê;
- um cliente que não veio de anúncio da Meta nunca é enviado.

## Decisões (escolhas do dono do produto em 2026-11-09)

1. **Ligação:** o admin cola o **ID do conjunto de dados** (dataset/pixel) e a **chave de acesso** (token) gerados no Gerenciador de Eventos da Meta. Não há "Entrar com o Facebook", porque isso exigiria uma nova permissão aprovada pela Meta.
2. **Lead = negócio criado.** Vale para o negócio criado à mão, pelo robô, pelo formulário, por automação ou pela IA.
3. **Só quem veio de anúncio da Meta.** O cliente só é enviado se a origem do negócio (`deals.origin_id`) for um toque com identificação da Meta:
   - WhatsApp oficial com `ctwa_clid`;
   - Instagram ou Messenger vindo de anúncio (o id do usuário na página);
   - site com `fbclid`.

   Clientes orgânicos, do Google, do WhatsApp por QR Code ou sem origem nunca são enviados.

## Como funciona para o admin

Fica em **Configurações → Integrações → "Avisar a Meta (anúncios)"**. Só o admin vê e mexe nesta tela.
- **Campos:** ID do conjunto de dados e chave de acesso.
  - A chave é guardada criptografada, como as chaves de IA. A tela mostra só os 4 últimos caracteres.
  - Trocar a chave pede para colar uma nova; ela nunca volta para o navegador.
- **Eventos:** uma chave liga ou desliga "Lead" e outra liga ou desliga "Venda". As duas começam ligadas.
- **Teste:**
  - um campo opcional "código de teste" (`test_event_code` da Meta);
  - um botão "Enviar evento de teste", que manda um evento falso e mostra a resposta da Meta em português simples.
- **Ligar ou desligar a integração** sem apagar.
- **"Últimos envios":** os 50 últimos eventos, com data, tipo (lead ou venda), negócio, valor e situação (enviado, aguardando, falhou e o motivo), e um botão "Tentar de novo" para os que falharam.
- **Instruções curtas:** onde achar o ID e como gerar a chave no Gerenciador de Eventos.

## O que é enviado

`POST https://graph.facebook.com/<versão>/<dataset_id>/events`. A versão da API fica numa constante. Os campos exatos de cada canal são conferidos na documentação oficial na hora de implementar.

| Origem do negócio | `action_source` | Identificação enviada |
|---|---|---|
| WhatsApp oficial (anúncio) | `business_messaging`, `messaging_channel=whatsapp` | `ctwa_clid` + `whatsapp_business_account_id` |
| Messenger (anúncio) | `business_messaging`, `messaging_channel=messenger` | `page_id` + `page_scoped_user_id` |
| Instagram (anúncio) | `business_messaging`, `messaging_channel=instagram` | conta do Instagram + `ig_sid` |
| Site com `fbclid` | `system_generated` (lead do CRM) | `fbc` montado do `fbclid` + telefone e e-mail com hash SHA-256 |

- **Nomes dos eventos:**
  - nas mensagens, `LeadSubmitted` e `Purchase`;
  - no site, `Lead` e `Purchase`.
- **Venda:** `custom_data.value` (valor do negócio) e `currency`.
- **Identificador do evento:** cada evento leva um `event_id` estável, montado a partir do negócio e do tipo, para a Meta reconhecer repetições.
- **Nunca é enviado:**
  - nome;
  - texto das conversas;
  - notas, campos personalizados ou endereço IP.
- **Telefone e e-mail:** vão com hash, e só no caso do site, porque lá a Meta exige.

## Fila de envio (outbox)

- **Gravação na fila:** um trigger no banco grava o evento na tabela `meta_capi_events` quando o negócio é criado (lead) e quando o status muda para ganho (venda), se a regra 3 permitir e se a empresa tiver a integração ligada.
  - Se a integração estiver desligada, nada é gravado.
  - A fila não perde o evento se a Meta estiver fora do ar.
- **Evento único:** só um evento por negócio e por tipo (chave única). Reabrir o negócio e ganhar de novo não manda outra venda.
- **Envio:** um cron (no padrão do `/api/webhooks/cron`) manda os pendentes em lotes.
  - Faz novas tentativas com espera crescente, até 5 vezes em 24 horas, e depois marca "falhou".
  - Um erro de chave inválida (código 190) pausa os envios da empresa e mostra um aviso na tela de configuração.
- **Limpeza:** os eventos enviados são apagados depois de 90 dias.
- **Cobrança:** uma conta bloqueada pela cobrança (094) não envia.

## Banco (migration `110_meta_capi.sql`)

- **`meta_capi_settings`:**
  - uma linha por conta: `account_id` (PK), `dataset_id`, `token_enc`, `token_last4`, `test_event_code`, `send_lead`, `send_purchase`, `enabled`, `paused_reason`, `updated_by`, `updated_at`;
  - RLS: só o admin lê e grava, e a coluna `token_enc` não é lida pelo navegador. A gravação da chave passa por uma rota do servidor, que criptografa.
- **`meta_capi_events`:** `id`, `account_id`, `deal_id`, `event_name`, `event_id`, `status` (pending, sent, failed), `attempts`, `next_attempt_at`, `last_error`, `sent_at`, `created_at`, com unique `(deal_id, event_name)`.
  - O admin lê; só o servidor grava.
  - A mensagem de erro guardada é curta e sem dados pessoais.
- Padrões de sempre: REVOKE, depois GRANT estreito, trigger de isolamento por conta, bloqueio 094, rollback e teste SQL.

## Privacidade (LGPD)

- Só clientes vindos de anúncio da Meta são enviados. A Meta já conhece o clique, e o envio diz apenas que virou lead ou venda.
- **Anonimização:** quando o contato é anonimizado, os eventos pendentes dele são cancelados.
- **Responsabilidade da empresa:** a tela de configuração avisa em uma frase que a empresa é responsável por informar isso na política de privacidade dela.
- **Dados guardados:** a chave fica criptografada. Os registros de envio não guardam telefone, e-mail nem o corpo enviado.

## Fora do escopo

- "Entrar com o Facebook" e a criação automática do conjunto de dados.
- Gasto, CPA e ROAS dos anúncios (Marketing API).
- Etapas personalizadas como evento (ex.: `QualifiedLead` numa etapa escolhida).
- Google Ads (conversões offline).
- Clientes vindos do WhatsApp por QR Code: não há código de clique confiável.
- Reenvio de negócios antigos, criados antes da integração ser ligada.

## Testes

- **Vitest:**
  - montagem do evento de cada canal: campos certos, hash certo, nada além do permitido;
  - a regra "só anúncio Meta";
  - o `event_id` estável;
  - o cron: lotes, novas tentativas, espera, pausa no erro 190, 094;
  - a tela: salvar, máscara da chave, evento de teste, últimos envios, tentar de novo, estados vazio, carregando e erro;
  - a rota de configuração: só admin, chave criptografada, nunca devolvida.
- **SQL:**
  - o trigger grava na criação e na vitória só quando deve;
  - o par negócio e tipo é único;
  - a integração desligada não grava;
  - isolamento entre contas, anon sem acesso, agente sem acesso, `token_enc` invisível;
  - a anonimização cancela os pendentes;
  - o bloqueio 094.
- **Navegador:** a tela de configuração no computador e no iPhone, e o evento de teste contra um servidor falso local (sem chamar a Meta de verdade).
- **Portões:** tsc, lint (base de 14 avisos), i18n:split, vitest completo, teste SQL, revisão de código e revisão de segurança (Opus). Há chave secreta, dados pessoais e envio para fora.
