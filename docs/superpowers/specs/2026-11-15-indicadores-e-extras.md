# Spec: indicadores e extras além do plano (Entrega 10)

Status: aguardando aprovação do dono do produto. Entrega 10 do roteiro vocero (`docs/verification/vocero-evolution/ROADMAP.md`), a última.

## Decisões do dono do produto (2026-11-15)

1. **Cobrança:** extras além do plano. Em vez de bloquear quem passa do limite, a empresa pode contratar **usuário extra** e **número de WhatsApp extra**, cada um com preço mensal fixo, somado à assinatura do Asaas.
   - Não há cobrança pelo uso da IA, porque cada empresa usa a própria chave e já paga a IA direto (migration 058).
2. **Indicadores para as empresas:** resultado dos anúncios, resultado da IA e desempenho da equipe.
3. **Tela da plataforma** (para o dono do SempreCRM): o uso de cada empresa cliente.

## Mapa das partes

São três partes. Cada uma é publicada sozinha e tem o próprio PR.

| Parte | O que entrega | Depende de | Risco |
|---|---|---|---|
| A — `indicadores` | Relatórios da empresa: anúncios (com o gasto digitado), IA e equipe | — | baixo (só leitura, mais uma tabela de gasto) |
| B — `uso-plataforma` | Tela da plataforma com o uso de cada empresa | — | baixo (só leitura, só o dono da plataforma) |
| C — `extras` | Contratar usuário e número extra, com o valor somado na cobrança | — | alto (dinheiro e Asaas) |

**Ordem proposta:** A → B → C. A cobrança fica por último porque é a de maior risco e porque a tela B mostra quem está perto do limite (quem compraria extras).

---

## Parte A — Indicadores da empresa

Ficam em **Relatórios**, com o mesmo filtro de período que já existe. São três seções novas ou ampliadas.

### A1. Resultado dos anúncios

A seção "Origem dos clientes" (parte A da Entrega 9, `origin_report`) já mostra, por anúncio e campanha: novos clientes, negócios, ganhos, valor vendido, conversão e ticket médio. Esta parte acrescenta o **gasto**.

- **Gasto do anúncio:** o admin digita quanto gastou em cada anúncio ou campanha, por mês, num botão "Informar gasto" na própria linha.
  - O gasto não vem da Meta automaticamente, porque isso exigiria a Marketing API e uma nova permissão aprovada pela Meta.
- **Colunas novas:** gasto, custo por cliente, custo por venda e retorno (valor vendido ÷ gasto, por exemplo "4,2×").
  - Sem gasto informado, as colunas mostram "—".
- **Regra do período:** o gasto conta pelos meses inteiros que o período escolhido toca.
  - Exemplo: o período de 10/11 a 20/11 usa o gasto de novembro inteiro.
  - Há um aviso curto embaixo da tabela.
- **Exportar CSV:** o arquivo inclui as colunas novas.

**Banco:** a tabela `ad_spend` guarda o gasto por anúncio e por mês.
- **Colunas:**
  - `account_id`;
  - `origin_type`, `channel` e `name`: a mesma chave que o relatório já usa para agrupar;
  - `month` (primeiro dia do mês);
  - `amount_cents` (o valor, de 0 até um teto);
  - `currency` (a moeda da conta);
  - `updated_by`, `updated_at`.
- **Chave única:** um gasto por anúncio e por mês.
- **Acesso (RLS):** os membros leem; só o admin grava.
- `origin_report` passa a devolver `spend_cents`.

### A2. Resultado da IA

A seção nova "IA" usa o que já é registrado: `ai_usage`, os eventos `ai_handoff` e as mensagens com origem `ai`.

- **Conversas atendidas pela IA:** conversas com pelo menos uma resposta automática no período.
- **Passadas para uma pessoa:** dessas, quantas tiveram um evento `ai_handoff`, com o motivo mais comum.
- **Resolvidas sem uma pessoa:** conversas encerradas no período sem nenhuma mensagem de atendente.
- **Mensagens enviadas pela IA.**
- **Custo no período:** em dólar, como a tela de IA já mostra, separado por recurso (resposta automática, sugestão, resumo, triagem).
  - Esse custo é pago à OpenAI ou à Anthropic pela chave da própria empresa.
- **Sem IA ligada:** aparece um estado vazio com um link para Configurações → IA.

### A3. Desempenho da equipe

O painel inicial já tem o bloco "Equipe" (`dashboard_team_metrics`): conversas atendidas, resolvidas, primeira resposta, tarefas concluídas e conversas abertas. Em Relatórios, a seção "Equipe" mostra uma tabela por atendente com esses números e mais:

- **Negócios ganhos** e **valor vendido** no período, pelo responsável do negócio (`deals.assigned_to`);
- **Taxa de ganho:** ganhos ÷ (ganhos + perdidos) do responsável no período.

Quem tem papel de leitor ou atendente vê a tabela inteira, como já acontece no painel. Quem já saiu da equipe não aparece.

### Banco (migration `111_indicadores.sql`)

- `ad_spend`, como descrito acima, com RLS, REVOKE, depois GRANT estreito, o bloqueio 094 na gravação e o rollback.
- `origin_report` é recriada com a coluna `spend_cents`.
- **`ai_report(account, since, until)`:** SECURITY INVOKER, só para membros da conta, com o mesmo teto de 400 dias.
- **`team_report(account, since, until)`:** reaproveita a lógica de `dashboard_team_metrics` e acrescenta os negócios. SECURITY INVOKER.

### Testes da parte A

- **SQL:**
  - o gasto é isolado por conta;
  - o agente não grava gasto;
  - anon não tem acesso;
  - os números de IA e de equipe são conferidos à mão com dados de exemplo;
  - o teto de período;
  - o bloqueio 094.
- **Vitest:**
  - os cálculos (custo por venda, retorno, divisão por zero);
  - as três seções nos estados vazio, carregando e erro;
  - o diálogo de gasto (só admin).
- **Navegador:** Relatórios no computador e no iPhone, sem rolagem lateral da página.

---

## Parte B — Uso de cada empresa (área da plataforma)

Página nova em **Plataforma → Uso**, visível só para o dono da plataforma (mesma porta que as telas atuais de `/platform`).

- **Uma linha por empresa:**
  - plano e situação da cobrança;
  - usuários (em uso / limite) e números de WhatsApp (em uso / limite);
  - conversas no mês;
  - mensagens recebidas e enviadas no mês;
  - chamadas e custo da IA no mês;
  - pessoas que entraram nos últimos 7 dias;
  - data da última atividade.
- **Sinais:**
  - "perto do limite" (80% ou mais de usuários ou números);
  - "sem uso há 14 dias" (risco de cancelar).
- **Filtros e ordem:** filtrar por plano e por sinal, e ordenar por qualquer coluna.
- **Exportar CSV.**
- **Privacidade:** só contagens. Nenhum texto de conversa nem dado de cliente final aparece.

**Banco:** a função `platform_usage(month)` é SECURITY DEFINER e executável só pelo service_role. A rota do servidor verifica antes que quem pede é o dono da plataforma. Não há tabela nova.

**Testes:**
- o agente e o admin de uma empresa recebem 403;
- os números são conferidos com duas empresas de exemplo;
- a tela é conferida no computador e no iPhone.

---

## Parte C — Extras além do plano

### Para o dono do SempreCRM (Plataforma → Planos)

- Cada versão de plano ganha dois preços opcionais: **usuário extra (R$/mês)** e **número extra (R$/mês)**.
- Sem preço, o plano não oferece aquele extra e o limite continua bloqueando, como hoje.
- Um preço só vale para quem contrata depois da mudança. Quem já tem extras mantém o preço que contratou, como já acontece com as versões de plano.

### Para o admin da empresa (Configurações → Plano)

- **Mostra:** o que o plano inclui, os extras contratados e o total da próxima cobrança.
- **Botões:** "+ usuário extra" e "+ número extra", com quantidade, pedindo confirmação com o novo valor mensal.
- **Remover um extra:** só é possível se a empresa estiver usando menos que o novo limite. Por exemplo, com 4 usuários ativos e limite de 3 + 1 extra, ela precisa tirar alguém antes.
- **Ao bater no limite:** convidar usuário ou conectar número mostra "Contratar 1 extra por R$ X/mês" em vez de só bloquear, quando o plano oferece o extra.

### Como a cobrança funciona

- **Limite real** = limite do plano + extras contratados. As verificações que já existem passam a usar o limite real (`canAddUser` e `canAddChannel`, em `plans.ts`), no servidor.
- **Valor da assinatura** = preço do plano + extras × preço de cada extra, no ciclo da assinatura. No anual, o extra é 12 × o preço mensal, com o mesmo desconto anual do plano.
- **Ao mudar os extras:**
  1. o sistema atualiza o valor da assinatura no Asaas;
  2. só grava os extras depois que o Asaas confirma.
- **Quando passa a valer:** o novo valor entra a partir da **próxima cobrança**, sem cobrança proporcional no meio do mês. O limite novo vale na hora.
- **Situação da conta:** com a conta em teste grátis, só leitura ou bloqueada, contratar extra fica indisponível, com uma explicação.
- **Proteções:**
  - **Um pedido por vez:** dois cliques simultâneos não somam duas vezes. A gravação compara o valor que foi lido antes de trocar.
  - **Limite de alterações:** há um número máximo de mudanças por dia.
  - **Auditoria:** cada alteração fica registrada, com o valor anterior e o novo.
  - **Falha do Asaas:** se o Asaas falhar, nada muda e o admin vê "Não foi possível alterar agora, tente de novo".

### Banco (migration `114_plan_extras.sql`)

- **Preços dos extras:** o JSON das versões de plano ganha `extra_user_price_cents` e `extra_channel_price_cents`, com a validação no mesmo lugar das outras chaves.
- **`account_billing`:** ganha as colunas `extra_users`, `extra_channels`, `extra_user_price_cents` e `extra_channel_price_cents`.
  - As duas últimas guardam o preço travado no momento da contratação.
- **Gravação:** só o servidor grava, pelo service_role. O admin lê os próprios dados.
- **Limite real:** a regra de entitlements no banco (094/099) soma os extras, e a contagem de usuários e canais no banco usa o limite real.
- Rollback e teste SQL.

### Testes da parte C

- **Vitest:**
  - o cálculo do valor (mensal, anual, sem extras, preço travado);
  - a rota de alterar extras: só admin, conta ativa, Asaas fora do ar não muda nada, dois pedidos simultâneos, remover abaixo do uso, limite diário, auditoria;
  - o convite e a conexão de número usando o limite real.
- **SQL:** o limite real no banco, e o agente não altera extras.
- **Asaas:** contra um servidor falso local; nenhuma chamada real.
- **Navegador:** Configurações → Plano e o aviso ao bater no limite, no computador e no iPhone.
- **Revisão de segurança (Opus):** é obrigatória, porque esta parte envolve dinheiro.

---

## Fora do escopo

- Gasto dos anúncios vindo da Meta automaticamente (exige a Marketing API).
- Cobrança pelo uso da IA, por conversa ou por mensagem.
- Cobrança proporcional no meio do mês.
- Extras de outros limites (por exemplo, armazenamento) e módulos avulsos.
- Metas por atendente (já existem em metas de vendas, item 4.2).

## Portões (todas as partes)

- `tsc`, lint (base de 14 avisos), `i18n:split --check`, vitest completo e teste SQL no banco local.
- Revisão de código (Sonnet) em todas as partes; revisão de segurança (Opus) nas partes B e C.
- Navegador no computador e no iPhone.

## Perguntas em aberto

1. A ordem A → B → C está boa, ou você quer a cobrança (C) primeiro?
2. O valor novo dos extras vale a partir da próxima cobrança, sem cobrança proporcional. Pode ser assim?
3. Quem vê os indicadores da equipe? A proposta é que todos da equipe vejam a tabela inteira, como no painel inicial. Se preferir, só admin.
