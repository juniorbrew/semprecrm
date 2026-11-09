# Spec: origem dos clientes (parte A)

Status: aprovado pelo dono do produto (2026-11-09). Entrega 9 do roteiro vocero (`docs/verification/vocero-evolution/ROADMAP.md`), parte A. A parte B (avisar a Meta pela Conversions API) vem num PR separado, depois desta.

## Objetivo

A empresa investe em anúncios no Facebook e no Instagram e em campanhas no site, mas não sabe quais delas trazem clientes e vendas. Hoje o SempreCRM não guarda de onde o cliente veio. A auditoria registrou isso como "AUSENTE — webhook atual não modela referral".

Sucesso:
- cada contato novo e cada negócio novo guardam a origem que realmente chegou junto: anúncio, campanha do site ou link;
- a origem aparece no painel do atendimento e na gaveta do negócio;
- um relatório mostra, por origem, quantos clientes, negócios, vendas ganhas e valor vieram de cada uma.

## Decisões (escolhas do dono do produto em 2026-11-09)

1. **Uma parte de cada vez.**
   - A (esta): guardar e mostrar a origem, mais o relatório. Não precisa de nada da Meta.
   - B (depois): avisar a Meta quando houver um lead e quando houver uma venda ganha, com o valor.
   - O que a parte A guarda já serve à parte B, inclusive o `ctwa_clid`.
2. **Canais:** WhatsApp oficial (Meta), WhatsApp por QR Code, Instagram, Messenger e site (robô e formulários).
3. **Nada inventado.** Só se guarda o que chegou. Sem dado de origem, o cliente fica como "Direto ou não identificado". Gasto, CPA e ROAS ficam fora, porque dependem da Marketing API (a auditoria pede não prometer isso).

## O que cada canal traz

- **WhatsApp oficial:** o objeto `referral` da mensagem que inicia a conversa a partir de um anúncio Click-to-WhatsApp. Ele traz:
  - `source_type` (ad ou post), `source_id` (id do anúncio ou da publicação), `source_url`;
  - `headline`, `body`, tipo de mídia e `ctwa_clid`.
- **WhatsApp por QR Code:** `contextInfo.externalAdReply` e o campo de origem de conversão da mensagem (Baileys). Traz título, texto, `sourceUrl`, `sourceId`, `sourceType` e, quando existir, `ctwaClid`.
  - O gateway (`services/wa-gateway`) passa esses campos adiante. Hoje ele já repassa `contextInfo`.
  - É "melhor esforço": o app guarda o que vier.
- **Instagram e Messenger:** o `referral` dos eventos de mensagem, que traz `source` (ADS ou SHORTLINK), `type`, `ref`, `ad_id` e `ads_context_data` (título do anúncio, id da publicação).
- **Site:**
  - o `robo.js` envia a URL da página e o `document.referrer`. O servidor extrai `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `gclid` e `fbclid`, e o domínio de onde a pessoa veio;
  - os formulários por webhook aceitam os mesmos campos `utm_*` no corpo, sem mudar o mapeamento atual;
  - só se guarda o domínio do referrer, nunca a URL inteira. A URL da página fica sem os parâmetros que não forem de campanha.
- Os campos exatos de cada canal são conferidos na documentação oficial da Meta e do Baileys na hora de implementar, e testados com exemplos reais anonimizados.

## Regras

- **Toques:** cada vez que chega uma origem nova, grava-se um "toque" (`lead_origins`).
  - O contato aponta para o primeiro toque (`first_origin_id`) e para o último (`last_origin_id`).
  - Toques repetidos (mesmo anúncio, mesma conversa, menos de 24 h) não duplicam.
- **Negócio:** ao ser criado, guarda o último toque do contato nos 30 dias anteriores (`deals.origin_id`). Isso vale para o negócio criado à mão, pelo robô, pelo formulário ou pela IA. O admin ou o gestor pode trocar a origem do negócio à mão (com histórico simples: quem trocou e quando).
- **Nome da origem no relatório**, em ordem de prioridade:
  1. anúncio (título do anúncio + canal);
  2. campanha (`utm_campaign`, com `utm_source`);
  3. site de origem (domínio);
  4. "Direto ou não identificado".
- **Privacidade:**
  - se o contato é anonimizado pela LGPD, os toques dele também são apagados;
  - o `ctwa_clid` e os ids de clique (`gclid`, `fbclid`) só são lidos pelo servidor e por quem é admin. Na tela aparece só "anúncio do Instagram", por exemplo;
  - nenhum IP é guardado.

## Onde aparece

- **Painel do contato no atendimento e ficha do contato:** linha "Veio de: Anúncio 'Promoção sofás' · Instagram · 3 nov.", com um link para o anúncio quando houver `source_url`. Se houver mais de um toque, mostra também "primeiro contato" e "último".
- **Gaveta do negócio:** linha "Origem" no topo do corpo, junto do resumo "Antes de falar".
- **Relatórios → nova seção "Origem dos clientes":**
  - filtros: período, canal e funil;
  - tabela por origem: clientes novos, negócios criados, negócios ganhos, valor ganho, taxa de conversão (ganhos ÷ criados) e ticket médio;
  - um gráfico de barras com as 10 origens que mais venderam;
  - exportar em CSV, como os relatórios atuais;
  - os números vêm de uma função no banco (`origin_report`, SECURITY INVOKER, no padrão das agregações 083–086). Nada é somado no navegador.
- **Contatos:** filtro por origem na lista (canal e campanha).

## Banco (migration `109_lead_origins.sql`)

- **`lead_origins`:**
  - colunas: `id`, `account_id`, `contact_id`, `conversation_id` (opcional), `channel` (whatsapp, whatsapp_qr, instagram, messenger, site_bot, webhook), `kind` (ad, post, link, campaign, referrer), `ad_id`, `source_id`, `source_url`, `headline`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `referrer_host`, `click_id_type` e `click_id` (ctwa_clid, gclid ou fbclid), `occurred_at` e `created_at`;
  - CHECKs de tamanho em todos os textos;
  - índices por `(account_id, occurred_at)` e por `(contact_id, occurred_at desc)`.
- **Contatos:** `contacts.first_origin_id` e `last_origin_id`.
- **Negócios:** `deals.origin_id`, `origin_set_by` e `origin_set_at`.
- **Quem pode o quê:**
  - membro da conta lê, mas a coluna `click_id` não é lida pelo navegador: uma view ou GRANT de colunas esconde dela;
  - só o servidor (service role) grava toques.
  - **Troca da origem do negócio:** admin ou gestor, pela tela.
- **Padrões já usados:** isolamento por conta (trigger `enforce_same_account`), bloqueio de cobrança 094, GRANTs 076, rollback e teste SQL.

## Fora do escopo

- **Parte B:** avisar a Meta (Conversions API, outbox, `event_id`, novas tentativas).
- Gasto, CPA e ROAS dos anúncios (Marketing API).
- Origem de contatos antigos: não dá para recuperar o que não foi guardado.
- Google Ads offline conversions.
- Modelos de atribuição além de primeiro e último toque.

## Testes

- **Vitest:**
  - os leitores de origem de cada canal: exemplos reais anonimizados de `referral` do WhatsApp, do Instagram e do Messenger, `externalAdReply` do Baileys e URLs com UTM; campos ausentes, tipos errados e textos gigantes;
  - a regra de deduplicação dos toques;
  - a escolha da origem do negócio (30 dias);
  - o nome da origem no relatório;
  - as telas: painel, gaveta, relatório (vazio, carregando, erro, filtros) e CSV.
- **SQL:** isolamento entre contas, anon sem acesso, `click_id` invisível para o navegador, `origin_report` com números conferidos à mão, anonimização da LGPD apagando os toques, bloqueio de cobrança.
- **Navegador:**
  - simular uma mensagem com `referral` em cada canal no banco local;
  - abrir o painel, a gaveta e o relatório no computador e no iPhone;
  - testar o robô do site numa página com `?utm_campaign=...`.
- **Portões:** tsc, lint (base de 14 avisos), i18n:split, vitest completo, teste SQL, revisão de código e revisão de segurança (Opus). Há dado pessoal e webhooks públicos envolvidos.
