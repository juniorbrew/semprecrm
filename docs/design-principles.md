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

## Caixa de entrada

Mesmas regras aplicadas à lista, ao histórico e ao painel do contato.

- **Lista:** uma linha de metadados (categoria · empresa), etiquetas como ponto + texto, canal "Oficial/QR" como texto discreto, situação (pendente, resolvida) e SLA como ponto + texto. O único preenchido é o contador de não lidas.
- **Cabeçalho da conversa:** avatar, nome e **uma** linha de situação, sem quebra (SLA · estado · canal · empresa · janela de 24 h · telefone). Ações à direita: Pausar IA, Assumir, Transferir e utilitários são ghost; Resolver/Reabrir é o único preenchido e fica por último. Categoria, prioridade, equipe e assunto ficam numa segunda linha de chips. O botão de painel mostra/oculta o painel do contato (lembrado por usuário) e, oculto, a conversa ocupa a largura.
- **Fundo do chat liso** (sem desenho repetido). Separador de data é uma pílula pequena (`bg-muted`, texto muted). Evento do sistema é uma linha centralizada com um traço fino de cada lado ("— Atribuída a Bia —").
- **Balões:** raio `calc(var(--radius) + 2px)` com o canto pequeno (4 px) do lado de quem enviou; enviado em `bg-primary text-primary-foreground`, recebido em `bg-card` com borda fina. Remetente e hora em 10 px; os ticks herdam a cor do balão (`opacity-70`), o lido fica em tom cheio. Nota interna centralizada, borda e fundo âmbar leves, sem tracejado nem sombra. Só mensagem que chega com a conversa aberta entra com fade/subida de 250 ms (nada com `prefers-reduced-motion`).
- **Compositor:** um único campo com borda sobre o fundo do chat (sem barra superior nem divisória); a barra de ferramentas fica embaixo (anexo, voz, Nota interna como alternância, modelo, respostas rápidas, emoji, sugestão). "/" abre as respostas rápidas; Enter envia, Shift+Enter quebra linha. Enviar é o único botão preenchido.
- **Painel:** seções separadas por linha fina de ponta a ponta, sem caixas. Títulos de seção pequenos em caixa alta e muted (`text-[10.5px] uppercase tracking-[0.07em]`), contagem em texto simples — exceção deliberada à regra geral de não usar caixa alta. Ordem: identidade (avatar ao lado do nome; sem ponto de presença, contato não tem disponibilidade), Situação (estado, prioridade, responsável, equipe, SLA com barra de progresso), Tarefas, Conversas anteriores (até 5: assunto ou categoria, data · estado · nota CSAT), Histórico (nº de conversas, satisfação média, cliente desde), depois Etiquetas, Campos, Empresas, Negócios, Agenda, Atividade, Memória, Notas e Privacidade. Ações rápidas são uma linha de texto com ícone (`size-3.5`). Notas do painel com filete âmbar à esquerda; etiquetas, notas e memória sem borda tracejada.
- **Sugestão pendente** (chegou com texto já na caixa): uma linha com borda tracejada em tom de `primary` acima do compositor, "Sugestão: “…”" truncado, Usar (contorno), Adicionar ao final e descartar. Sem ícone decorativo de IA.
