# Spec: metas de vendas (empresa, equipe, vendedor)

Status: aprovado pelo dono do produto (2026-11-01). Item 4.2 do roteiro (ideias do Pipedrive, feitas do nosso jeito: código, textos e marca próprios).

## Objetivo

O dono quer saber, ao abrir o sistema, quanto a empresa, cada equipe e cada vendedor já venderam no mês e quanto falta para bater a meta. Hoje isso não existe: só há "valor dos negócios abertos" no painel.

Sucesso = no painel inicial aparece o card **Metas do mês** com uma barra de progresso por meta (vendido / meta, % e quanto falta) e um aviso de ritmo. O admin define as metas por ali mesmo.

## Decisões

1. **Onde:** card novo no painel inicial (`src/app/(dashboard)/dashboard/page.tsx`), logo abaixo dos quatro cartões de números. Só aparece se a conta tem o módulo `pipelines`. Sem página nova e sem módulo novo de plano.
2. **O que conta como venda:** negócio com `status = 'won'` e `closed_at` dentro do mês, no fuso da conta (`preferences.business_hours.timezone`, padrão do app). Duas medidas, escolhidas por meta:
   - `won_value`: soma de `deals.value` (só negócios na moeda padrão da conta; outras moedas ficam de fora).
   - `won_count`: quantidade de negócios ganhos.
3. **Para quem é a meta:**
   - `account`: a empresa toda (todo negócio ganho conta).
   - `team`: soma dos negócios ganhos cujo `assigned_to` está HOJE em `team_members` dessa equipe (tabela de 073). Equipe arquivada some do card.
   - `member`: negócios ganhos com `assigned_to` = essa pessoa (precisa ser membro da conta).
   - Negócio ganho sem responsável conta só para a empresa.
4. **Período mensal que "vale até mudar":** tabela `sales_goals` com uma linha por (conta, alvo, medida, mês). A meta de um mês é a linha desse mês ou, se não houver, a do mês anterior mais recente. Assim o admin define uma vez e ela segue valendo, e o histórico não muda quando a meta muda. Remover uma meta = linha com `target` NULL a partir daquele mês.
5. **Edição:** só owner/admin, e só do mês atual em diante (meses passados ficam como estavam). Conta bloqueada por cobrança não grava (mesma regra do bloqueio de 094; a tabela nova entra nessa lista).
6. **Quem vê o quê:** owner/admin veem todas as metas. Atendente vê a meta da empresa, a das equipes em que está e a sua. O atendente nunca recebe números individuais de outro vendedor. Isso é garantido no banco (RLS e/ou função de progresso), não só na tela.
7. **Ritmo:** esperado até hoje = meta × (dias passados ÷ dias do mês). Mostra "no ritmo" ou "abaixo do ritmo" no mês atual. Meses passados mostram só "batida"/"não batida".
8. **Navegação:** setas para ver meses anteriores (somente leitura).
9. **Números exatos:** o progresso vem de agregação no banco (função SQL), não de listar negócios no navegador (sem limite de linhas, mesmo padrão de 075/083-086).
10. **Banco:** migration `103_sales_goals.sql` (tabela, RLS, grants no padrão da 076, guarda de conta/equipe/membro, inclusão no bloqueio de escrita de 094, função de progresso) + rollback + teste SQL.
11. **i18n:** textos novos no dicionário do painel (chave em inglês, valor pt-BR) e `npm run i18n:split`.

## Fora do escopo

Metas semanais/trimestrais, metas por funil ou produto, comissão, notificações de meta batida, previsão de vendas (item 4.4).

## Onde mexe

- `supabase/migrations/103_sales_goals.sql` (+ rollback + teste SQL em `supabase/tests/`).
- `src/lib/sales-goals/` (cálculo puro de ritmo/resolução de meta + leitura/gravação).
- `src/components/dashboard/sales-goals-card.tsx` (+ janela "Definir metas").
- `src/app/(dashboard)/dashboard/page.tsx`, dicionário i18n do painel, tipos.
