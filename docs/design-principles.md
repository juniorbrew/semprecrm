# Princípios de design

Regras aplicadas às telas de IA (configurações, agentes, sugestão de resposta) e que as próximas telas devem seguir. Objetivo: minimalista, moderno, sem o "visual de IA".

## O que evitar

- Ícones decorativos de IA (brilhos, varinha, robô) em títulos, botões e cartões. Use um ícone neutro ou nenhum.
- Gradientes, brilhos, fundos coloridos em avisos e sombras pesadas.
- Cartão dentro de cartão e bordas em todo bloco.
- Selos "IA" e "beta" espalhados, rótulos em caixa alta, emoji.
- Texto de marketing ("turbine", "mágica"), exclamações e ajuda embaixo de todo campo.

## O que fazer

- **Superfícies calmas.** Mesmos tokens do app (`background`, `muted`, `border`). Sem tema novo.
- **Um único acento** (`primary`), só na ação principal e no estado ativo. Um botão primário por tela.
- **Hierarquia por tipo e espaço.** Título `text-base font-semibold`, corpo `text-sm`, apoio `text-muted-foreground`. Grade de 4/8 px; `space-y-8` entre grupos, `space-y-4` dentro.
- **Seções são grupos com título**, separados por espaço e uma linha fina (`border-t`), nunca por caixa. Use `SettingsGroup` (`src/components/settings/settings-group.tsx`).
- **Formulários em uma coluna**, com `max-w-2xl`. Campos lado a lado só para valores curtos (orçamento, horário).
- **Listas e tabelas** com separadores leves (`divide-y divide-border`), sem caixa ao redor de cada linha. Metadados numa linha só, separados por " · ".
- **Situação como ponto + texto** (`size-1.5 rounded-full`), não como pílula colorida. Âmbar e vermelho só para o que exige atenção.
- **Controles com altura consistente** (`h-8`; `h-7` em barras densas) e ícones `size-3.5` ou `size-4`.
- **Ação simples no compositor:** texto + ícone neutro, sem aparência de botão mágico.
- **Movimento curto e sutil:** `transition-colors`, fade de 200 ms. Nada de animação decorativa.

## Texto

- Português, frase com inicial maiúscula só na primeira palavra, curto e direto.
- Dizer o que aconteceu ou o que fazer; uma frase de apoio no máximo. Se o título basta, não explique.
- Estado vazio: uma frase e uma ação. Carregando: indicador discreto, sem caixa.

## Acessibilidade (não regride)

- Todo campo tem `Label` associado; erros com `role="alert"` e `aria-describedby`.
- Foco visível (`focus-visible:ring-3`) em todo controle, inclusive os feitos com `<button>`.
- Status nunca só por cor: o ponto sempre acompanha o texto.
- Contraste de `text-muted-foreground` sobre `background` validado nos dois temas; não use opacidade menor que isso em texto.
- Regiões que mudam de conteúdo (resultado de teste) usam `aria-live="polite"`.

## Checklist para uma tela nova

1. Dá para remover uma borda, uma caixa ou um ícone sem perder informação? Remova.
2. Só existe um botão primário?
3. Cada bloco tem título e a separação vem de espaço ou de uma linha fina?
4. A cópia cabe em uma linha? Há exclamação, caixa alta ou jargão de IA?
5. Funciona em tema claro e escuro, em 360 px e com teclado?
