# Spec: previsão de vendas

Status: rascunho para aprovação (2026-11-04). Item 4.4 do roteiro (ideias do Pipedrive, feitas do nosso jeito: código, textos e marca próprios).

## Objetivo

O gestor quer saber, antes do fim do mês, quanto a equipe deve vender. Hoje o Funil mostra só o "Valor ponderado" do funil aberto na tela: soma tudo, sem separar por mês, e a chance de cada etapa é fixa (calculada pela posição).

Sucesso:
- o admin define a chance de fechar de cada etapa;
- o painel mostra, no cartão "Metas do mês", a previsão do mês ao lado da meta;
- o Funil ganha uma visão "Previsão" com o mês atual e os 2 seguintes, por vendedor;
- negócios sem data prevista aparecem num grupo "Sem data", com convite para preencher.

## Decisões (escolhas do dono do produto em 2026-11-04)

1. **Chance por etapa, definida pelo admin.**
   - Coluna nova `pipeline_stages.win_probability` (inteiro 0–100, pode ser vazia).
   - Vazia = automática, igual a hoje (`stageProbability` em `src/lib/pipelines/board.ts`: 1ª etapa 10%, sobe até 90%, última etapa 100%).
   - Assim nada muda para quem não mexer, e reordenar etapas continua dando valores coerentes.
   - Em Configurações do funil, cada etapa ganha o campo "% de chance de fechar". O campo vem com o valor automático como dica e tem um "voltar ao automático".
   - Quem pode editar: quem já edita etapas hoje (mesma RLS).
   - Não há ajuste por negócio (fora do escopo).
2. **Valor ponderado do Funil** passa a usar a chance da etapa (definida ou automática). Também passa a explicar isso no texto de ajuda.
3. **Cálculo da previsão de um mês** (no fuso da conta, igual às metas da 103):
   - **Ganho**: negócios ganhos com `closed_at` no mês. Mesma regra e mesma moeda da meta 4.2.
   - **Previsto**: negócios abertos com `expected_close_date` no mês × chance da etapa.
   - **Data vencida**: negócios abertos com data prevista antes do mês atual entram no **mês atual**, marcados "data vencida" (contagem e valor), para o vendedor atualizar.
   - **Previsão do mês** = Ganho + Previsto.
   - Também mostra o **melhor caso** (Ganho + valor cheio dos abertos do mês).
   - **Sem data**: abertos sem `expected_close_date` ficam num grupo separado, com contagem e valor. Não entram em nenhum mês.
   - Negócios perdidos não entram.
   - Moeda: só negócios na moeda padrão da conta, como na 4.2. Os de outra moeda são contados à parte, com o aviso "N em outra moeda".
4. **Onde aparece:**
   - **Cartão "Metas do mês"** (painel): uma linha "Previsão do mês: R$ X (Y% da meta)" na meta da empresa e na de cada vendedor que tem meta. Só aparece quando a meta é de valor.
   - **Funil → visão "Previsão"**:
     - Fica num botão ao lado do quadro, usa o funil escolhido e tem a opção "todos os funis".
     - Tem 3 colunas (mês atual, próximo, seguinte) e mais "Sem data".
     - Em cada coluna: Ganho, Previsto, Melhor caso, nº de negócios e "data vencida".
     - Filtro por vendedor: todos, sem responsável ou um vendedor.
     - Ao clicar no mês, aparece a lista dos negócios que compõem o número (título, etapa, chance, valor, valor ponderado, data). Cada um abre a gaveta do negócio.
5. **Banco** (migration `106_sales_forecast.sql`):
   - Coluna nova com CHECK 0–100.
   - Função `private.stage_win_probability(stage_id)`, que espelha a regra automática quando a coluna está vazia. A regra existe em SQL e em TS, com testes nos dois iguais.
   - RPC `sales_forecast(p_account_id, p_pipeline_id, p_month, p_months)`, SECURITY INVOKER, `SET search_path`, devolvendo uma linha por mês × vendedor, mais a linha "sem data".
   - GRANTs no padrão 076/096/103.
   - Rollback e teste SQL.
   - A coluna nova fica em `pipeline_stages`, que já tem o bloqueio de cobrança da 094. Nada a acrescentar.
6. **Módulo:** `pipelines`, igual às metas.
7. **i18n:** frases específicas (o tradutor é global, sem chave de uma palavra só) e `npm run i18n:split`.

## Fora do escopo

- Chance por negócio.
- Previsão por produto.
- Gráfico histórico (previsto x realizado de meses passados).
- Exportar.
- Previsão com IA.
- Converter moedas.

## Onde mexe

- `supabase/migrations/106_sales_forecast.sql`, mais o rollback e `supabase/tests/sales_forecast.sql`.
- `src/lib/pipelines/board.ts` (chance definida ou automática).
- `src/lib/sales-forecast/` (tipos, leitura da RPC, montagem das colunas), com testes.
- `src/components/pipelines/pipeline-settings.tsx` (campo % por etapa), `pipeline-analytics.tsx` (texto de ajuda), a visão nova `src/components/pipelines/sales-forecast.tsx` e o botão na página do Funil.
- `src/components/dashboard/sales-goals-card.tsx` (linha da previsão).
- Dicionários i18n.

## Testes

- **Vitest:**
  - regra da chance (definida, vazia, uma etapa só, última etapa);
  - montagem das colunas (data vencida no mês atual, sem data, outra moeda);
  - campo da etapa (0–100, voltar ao automático);
  - visão Previsão (filtros, lista do mês, estados de carregando, vazio e erro);
  - linha no cartão de metas.
- **SQL**, no banco local:
  - mesma chance que a regra TS para 1, 2, 3 e 5 etapas;
  - ganho por `closed_at` no fuso da conta;
  - data vencida indo para o mês atual;
  - sem data separado;
  - outra moeda à parte;
  - perdidos fora;
  - membro de outra conta não lê nada;
  - anon sem acesso;
  - CHECK 0–100.
- **Portões:** tsc, lint (base de 14 avisos), i18n:split, vitest completo, teste SQL e revisão de código e de segurança.

## Perguntas em aberto

- Nenhuma de produto. Detalhes visuais seguem o padrão do Funil e do cartão de metas.
