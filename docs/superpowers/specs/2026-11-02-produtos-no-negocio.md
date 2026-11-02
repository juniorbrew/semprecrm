# Spec: produtos e serviços dentro do negócio

Status: aprovado pelo dono do produto (2026-11-02). Item 4.3 do roteiro (ideias do Pipedrive, feitas do nosso jeito: código, textos e marca próprios).

## Objetivo

Hoje o valor do negócio é digitado à mão. O vendedor quer montar o negócio com o que está vendendo (2× Plano Mensal, 1× Instalação com 10% de desconto) e ver o total calculado, sem conta de cabeça.

Sucesso = o admin cadastra produtos/serviços uma vez; no negócio, qualquer pessoa que pode editar o negócio adiciona itens (do catálogo ou avulsos), e o valor do negócio passa a ser a soma dos itens.

## Decisões

1. **Catálogo** (`products`): nome (1-80), código opcional (até 40), preço unitário (>= 0, mesmo limite de `deals.value`), descrição curta opcional (até 300), arquivado (`archived_at`). Preço na moeda padrão da conta. Nome único entre os ativos da conta (sem diferenciar maiúsculas). Admin/owner gerenciam em **Configurações → Produtos**; todos os membros leem. Arquivar em vez de apagar quando o produto já foi usado.
2. **Itens do negócio** (`deal_items`): negócio, produto (opcional, `ON DELETE SET NULL`), nome guardado no item (cópia, para o histórico não mudar se o catálogo mudar), preço unitário (cópia editável), quantidade (> 0, até 2 casas decimais, limite sensato), desconto em % (0-100), posição. Total da linha = quantidade × preço × (1 − desconto/100), arredondado a 2 casas.
3. **Valor do negócio = soma dos itens**, calculado no banco (gatilho em `deal_items`), nunca no navegador. Enquanto o negócio tem itens, `deals.value` não aceita valor digitado: o banco recalcula (uma alteração direta do valor é substituída pela soma). Se o último item for removido, o valor fica como estava e volta a ser editável à mão. Negócio sem itens funciona como hoje.
4. **Quem edita itens:** quem pode editar o negócio (mesma regra de RLS de `deals`). Item e produto precisam ser da mesma conta do negócio (gatilho de guarda, padrão da 073). Conta bloqueada por cobrança não grava (as duas tabelas entram no bloqueio da 094, padrão 096/103).
5. **Onde aparece:**
   - Gaveta/detalhes do negócio (`src/components/pipelines/deal-details.tsx`/`deal-drawer.tsx`): seção **Produtos e serviços** com lista, "Adicionar item" (busca no catálogo ou texto livre), quantidade, preço, desconto, remover, e o total. O campo Valor mostra "calculado pelos itens" e fica só leitura quando há itens.
   - Configurações → Produtos: lista, criar, editar, arquivar/reativar.
   - Painel do negócio na caixa de entrada: só mostra o valor (já mostra); a edição dos itens fica na gaveta do negócio.
6. **Resumo com IA (4.1):** quando o negócio tem itens, a IA não propõe mudança de valor e o "Aplicar" recusa valor (status já existente, ex. `invalid`), sem gravar.
7. **Metas (4.2):** nada a mudar; o valor calculado entra nas metas como qualquer valor.
8. **Módulo:** `pipelines` (sem módulo novo).
9. **Banco:** migration `104_products_deal_items.sql` (tabelas, índices, RLS, grants no padrão 076/096/103, guardas, gatilho de recálculo, bloqueio 094) + rollback + teste SQL.
10. **i18n:** frases específicas (o tradutor é global; nada de chave de uma palavra genérica), `npm run i18n:split`.

## Fora do escopo

Estoque, impostos, preço por moeda, variações de produto, importação de planilha, proposta/orçamento em PDF, relatórios por produto.

## Onde mexe

- `supabase/migrations/104_products_deal_items.sql` (+ rollback + `supabase/tests/products_deal_items.sql`).
- `src/lib/products/` (cálculo puro de linha/total + leitura/gravação), tipos.
- `src/components/pipelines/deal-items.tsx` (+ ligação em deal-details/deal-drawer/deal-form), `src/components/settings/products-*.tsx` e a entrada no menu de Configurações.
- `src/lib/ai/deal-summary*.ts` (sem proposta de valor quando há itens).
- Dicionários i18n.
