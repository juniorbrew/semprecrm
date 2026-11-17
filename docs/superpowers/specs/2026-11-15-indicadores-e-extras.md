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

### Para o dono da empresa (Configurações → Plano)

- **Quem muda:** só o **dono da conta** contrata ou remove extras (igual à assinatura). O admin vê o painel só para leitura, com "Peça ao dono da conta".
- **Mostra:** o que o plano inclui, os extras contratados, o que está em uso e o total da próxima cobrança.
- **Botões:** "+ usuário extra" e "+ número extra", com quantidade, pedindo confirmação com o novo valor (no anual, mostra o preço por extra por ano, 12 meses pelo preço de 10).
- **Adicionar:** o limite sobe na hora e o extra entra na **próxima cobrança, mesmo que ela já tenha sido gerada** (sem cobrança proporcional).
- **Remover:** só se a empresa estiver usando menos que o novo limite (usuários = membros + convites pendentes; números conectados). A remoção **não derruba o limite na hora**: o extra continua ativo até o fim do período já pago, e **todo extra é cobrado por pelo menos um período completo**. O painel mostra "remoção agendada para DD/MM" e permite **cancelar** a remoção. A cobrança seguinte à remoção não inclui o extra. Enquanto há remoção agendada, não dá para adicionar nem remover outro extra: cancele primeiro.
- **Ao bater no limite:** convidar usuário ou conectar número mostra "Contratar 1 extra por R$ X/mês" (para o dono) em vez de só bloquear, quando o plano oferece o extra. Para quem não é dono, diz para pedir ao dono.

### Como a cobrança funciona

- **Limite real** = limite do plano + extras contratados (só onde o limite do plano não é ilimitado). As verificações que já existem passam a usar o limite real, no servidor; as páginas da plataforma também.
- **Valor da assinatura** = preço do plano + extras × preço travado de cada extra, no ciclo da assinatura. No anual, o extra é 10 × o preço mensal (12 meses pelo preço de 10, igual ao plano).
- **Adicionar:** 1) o sistema atualiza o valor da assinatura no Asaas, com `updatePendingPayments: true` (a próxima cobrança, mesmo já gerada, acompanha); 2) só grava os extras depois que o Asaas confirma.
- **Remover (linha do tempo):** o pedido só agenda. O dia da remoção `D` é o vencimento da primeira cobrança que não inclui o extra: o fim do período já pago, mas nunca antes de um período completo cobrado do extra mais novo. Quando a cobrança anterior a `D` está paga, o cron (de hora em hora) baixa o valor no Asaas (as cobranças geradas a partir de `D` seguem o valor novo). No dia `D` o limite cai. Se nesse momento o uso não couber mais, os extras ficam, o Asaas volta ao valor cheio e a auditoria registra `billing.extras_removal_blocked`; ninguém é removido.
  - Exemplo (mensal, pago em 01/12): em 05/12 adiciona 1 usuário (limite +1 na hora; a cobrança de 01/01 sai com o extra); em 10/12 pede para remover (agendado para 01/02); 01/01 cobrança com o extra, paga; depois disso o valor cai no Asaas; a cobrança de 01/02 sai sem o extra; em 01/02 o limite volta ao do plano.
- **Trocar de plano ou assinar de novo:** os extras vão junto, com o preço travado, só nos tipos que o plano novo aproveita; um tipo cujo limite é ilimitado ou que o plano novo não vende some (e deixa de ser cobrado). A remoção agendada é desfeita.
- **Situação da conta:** com a conta em teste grátis, só leitura ou bloqueada, contratar extra fica indisponível, com uma explicação.
- **Proteções:**
  - **Um pedido por vez, por conta:** a conta é reservada no banco (trava + ficha) antes de falar com o Asaas; dois cliques simultâneos não somam duas vezes. A gravação compara tudo o que foi lido.
  - **Limite de alterações:** no máximo 10 por dia, contado das linhas de auditoria sob a trava (sem falha aberta).
  - **Auditoria:** a mudança e a linha de auditoria (valor anterior e novo) entram na mesma transação.
  - **Asaas e banco concordam:** depois de qualquer falha, o sistema consulta o valor no Asaas (nunca restaura às cegas), corrige para o valor do banco e confere de novo; se ainda divergir, grava `billing.extras_mismatch` na auditoria.
  - **Falha do Asaas:** nada muda e o dono vê "Não foi possível alterar agora, tente de novo".

### Banco (migration `114_plan_extras.sql`)

- **Preços dos extras:** o JSON das versões de plano ganha `extra_user_price_cents` e `extra_channel_price_cents` (opcionais, de 1 centavo a R$ 100.000,00), com a validação no mesmo lugar das outras chaves.
- **`account_billing`:** ganha `extra_users`, `extra_channels`, os preços travados, `extras_first_due`, a remoção agendada (`pending_extra_*`, `extras_reduce_due`, `extras_asaas_lowered`) e a ficha da conta (`extras_claim_*`).
- **Gravação:** só o servidor grava, por três funções fechadas ao service_role (reservar, gravar e liberar). O dono/admin lê os próprios dados.
- **Limite real:** o banco não tem gatilho de limite de usuários/canais; o limite real vale no servidor. `platform_list_accounts()` devolve os extras para as páginas da plataforma.
- Idempotente, com rollback (que explica quando não é seguro voltar) e teste SQL.

### Testes da parte C

- **Vitest:** o cálculo do valor e das datas (mensal, anual, preço travado, remoção agendada); a rota (só o dono, conta ativa, Asaas fora do ar, conferência do Asaas, dois pedidos simultâneos, remover abaixo do uso, limite diário, auditoria); o sweep da remoção; o convite e a conexão de número com o limite real; assinar de novo com extras.
- **SQL:** preços do plano, restrições, reserva/gravação/liberação, teto diário, auditoria na mesma transação, o agente não altera extras.
- **Asaas:** só falso/simulado; nenhuma chamada real.
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
