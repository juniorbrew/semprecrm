# Princípios de design

Regras aplicadas às telas de IA (configurações, agentes, sugestão de resposta) e que as próximas telas devem seguir. Objetivo: minimalista, moderno, sem o "visual de IA".

## O que evitar

- Ícones decorativos de IA (brilhos, varinha, robô) em títulos, botões e cartões. Use um ícone neutro ou nenhum.
- Gradientes, brilhos, fundos coloridos em avisos e sombras pesadas.
- Cartão dentro de cartão e bordas em todo bloco.
- Selos "IA" e "beta" espalhados, rótulos em caixa alta (exceto os títulos de seção da navegação, ver "Navegação"), emoji.
- Texto de marketing ("turbine", "mágica"), exclamações e ajuda embaixo de todo campo.

## O que fazer

- **Superfícies calmas.** Mesmos tokens do app (`background`, `muted`, `border`). Sem tema novo.
- **Um único acento** (`primary`): ação principal, estado ativo e títulos de seção da navegação. Um botão primário por tela.
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

## Navegação

Barra lateral e cabeçalho (`src/components/layout/`, itens em `nav-config.ts`).

- **Logo no topo**, sem divisória: quadrado de 30 px (`rounded-[10px] bg-primary`) com brilho suave (`shadow-[0_0_22px_-3px_var(--primary)]`) e o nome em `text-base font-extrabold tracking-[-0.01em]`.
- **Painel** primeiro, sem título. Depois as **seções com título** (Atendimento, Vendas, Automação, Trabalho): `text-[10.5px] font-bold uppercase tracking-[0.08em] text-primary`, com `pt-3.5` de respiro. É o único lugar com caixa alta.
- **Itens:** `py-2 px-2.5`, ícone a 11 px do texto (`gap-[11px]`), raio `calc(var(--radius) - 2px)`; ícone inativo em `opacity-70`.
- **Item ativo:** fundo tingido da marca (`bg-primary/13`) com filete de 2 px à esquerda (`shadow-[inset_2px_0_0_var(--primary)]`), texto `font-semibold text-foreground` e ícone `text-primary` opaco. Sempre com `aria-current` e foco visível.
- **Contadores** são pílulas pequenas (`text-[11px] font-bold`, `rounded-full`): neutras (`bg-muted text-muted-foreground`) para contagens simples (Tarefas, Agenda); `bg-primary` para não lidas (Caixa de entrada, Chat); `bg-destructive` só para SLA em risco.
- **Submenu da caixa de entrada** (Minhas, Equipe, Sem dono, SLA em risco): aparece só dentro de /inbox, recuado 19 px com linha guia (`border-l border-border`), itens em 13 px; o atalho ativo ganha fundo neutro (`bg-muted`), sem filete. Só visões que já existem na lista; os contadores vêm da própria lista, sem consulta extra.
- **Cartão do usuário no pé:** borda fina e `rounded-[14px]`, avatar com iniciais em `bg-primary` e ponto de disponibilidade, nome em negrito e o status (Disponível / Ausente) embaixo. Abre o menu com a alternância de disponibilidade, Perfil, Configurações, Plataforma (admin da plataforma) e Sair. A faixa da conta com o selo de papel continua acima quando o nome da conta difere do usuário.
- **Só tokens** (`--primary`, `--muted`, `--border`…): a cor escolhida em Configurações vale em todo o app. Nada de cor fixa nem seletor de cor no cabeçalho.
- Cabeçalho na mesma superfície da barra lateral (`bg-card`), título `text-[15px] font-semibold`.

## Caixa de entrada

Mesmas regras aplicadas à lista, ao histórico e ao painel do contato.

- **Lista:** ver "Lista de conversas" abaixo.
- **Cabeçalho da conversa:** avatar, nome e **uma** linha de situação, sem quebra (SLA · estado · canal · empresa · janela de 24 h · telefone). Ações à direita: Pausar IA, Assumir, Transferir e utilitários são ghost; Resolver/Reabrir é o único preenchido e fica por último. Categoria, prioridade, equipe e assunto ficam numa segunda linha de chips. O botão de painel mostra/oculta o painel do contato (lembrado por usuário) e, oculto, a conversa ocupa a largura.
- **Fundo do chat liso** (sem desenho repetido). Separador de data é uma pílula pequena (`bg-muted`, texto muted). Evento do sistema é uma linha centralizada com um traço fino de cada lado ("— Atribuída a Bia —").
- **Balões:** raio `calc(var(--radius) + 2px)` com o canto pequeno (4 px) do lado de quem enviou; enviado em `bg-primary text-primary-foreground`, recebido em `bg-card` com borda fina. Remetente e hora em 10 px; os ticks herdam a cor do balão (`opacity-70`), o lido fica em tom cheio. Nota interna centralizada, borda e fundo âmbar leves, sem tracejado nem sombra. Só mensagem que chega com a conversa aberta entra com fade/subida de 250 ms (nada com `prefers-reduced-motion`).
- **Compositor:** um único campo com borda sobre o fundo do chat (sem barra superior nem divisória); a barra de ferramentas fica embaixo (anexo, voz, Nota interna como alternância, modelo, respostas rápidas, emoji, sugestão). "/" abre as respostas rápidas; Enter envia, Shift+Enter quebra linha. Enviar é o único botão preenchido.
- **Painel:** seções separadas por linha fina de ponta a ponta, sem caixas. Títulos de seção pequenos em caixa alta e muted (`text-[10.5px] uppercase tracking-[0.07em]`), contagem em texto simples — exceção deliberada à regra geral de não usar caixa alta. Ordem: identidade (avatar ao lado do nome; sem ponto de presença, contato não tem disponibilidade), Situação (estado, prioridade, responsável, equipe, SLA com barra de progresso), Tarefas, Conversas anteriores (até 5: assunto ou categoria, data · estado · nota CSAT), Histórico (nº de conversas, satisfação média, cliente desde), depois Etiquetas, Campos, Empresas, Negócios, Agenda, Atividade, Memória, Notas e Privacidade. Ações rápidas são uma linha de texto com ícone (`size-3.5`). Notas do painel com filete âmbar à esquerda; etiquetas, notas e memória sem borda tracejada.
- **Sugestão pendente** (chegou com texto já na caixa): uma linha com borda tracejada em tom de `primary` acima do compositor, "Sugestão: “…”" truncado, Usar (contorno), Adicionar ao final e descartar. Sem ícone decorativo de IA.

### Lista de conversas

Substitui, para a lista, as regras de "situação como pílula" e "sem caixa alta" acima (protótipo Atendimento aprovado).

- **Faixas:** Minhas e Todas agrupam as linhas em faixas fixas no topo ao rolar, cada uma com ponto + rótulo curto em caixa alta (`text-[10.5px] tracking-wider`) e a contagem: Agora (SLA estourado ou vencendo em até 15 min), Esperando por você (pendente, sem responsável ou nunca respondida), Em andamento, Aguardando cliente (nossa mensagem foi a última). Dentro da faixa, o prazo mais próximo primeiro, depois a mais recente. Fila mantém a ordem de espera; Encerradas e Arquivadas não têm faixas. A regra fica em `src/lib/inbox/bands.ts`.
- **Linha:** avatar, nome, prévia e hora; uma única linha de metadados (pílula de SLA, situação, categoria em pílula neutra, empresa, etiquetas). O contador de não lidas continua sendo o único elemento preenchido. Selecionada: `bg-primary/10` com acento de 3 px em `bg-primary` à esquerda.
- **SLA:** pílula com o tempo restante em palavras ("SLA 12min", "estourado há 5min") e uma linha fina na base da linha com a fração restante: verde, âmbar abaixo de 40%, vermelho abaixo de 15% ou vencido. O tempo anda num relógio único da lista (1 s, pausado com a aba oculta); só a pílula e a linha re-renderizam.
- **Ações rápidas:** ao passar o mouse ou com o foco dentro da linha, uma barra pequena com Resolver (Reabrir nas encerradas) e Assumir, só ícones `size-3.5` com `aria-label`. Só ações que já existem no cabeçalho; sem Adiar. Leitores não veem a barra.
- **Densidade:** confortável ou compacta (sem a linha de metadados, padding menor), salva por usuário neste aparelho. Abas e filtros ativos em pílula `bg-primary/15 text-primary`.

## Contatos

Lista (`src/app/(dashboard)/contacts/page.tsx`, linha em `src/components/contacts/contact-list-row.tsx`) e ficha do contato (`contact-detail-view.tsx`).

- **Cabeçalho:** título + contagem em pílula neutra; Campos personalizados e Importar são ghost, Novo contato é o único preenchido. Abaixo, busca compacta (`h-8`), o filtro Descadastrados em pílula (`bg-primary/15 text-primary` quando ativo) e a alternância de densidade.
- **Tabela sem caixa:** cabeçalho fixo ao rolar, rótulos de coluna em 12 px muted, linhas separadas por `border-border`. Coluna Contato com avatar (iniciais), nome e **uma** linha de metadados (empresa · telefone); E-mail, Etiquetas (ponto + texto, até 3 e "+N") e Criado em somem em telas menores. Descadastrado e anonimizado são texto discreto ao lado do nome, não pílula.
- **Seleção:** linha selecionada em `bg-primary/10` com acento de 3 px; a barra de ações em massa (Limpar, Excluir selecionados — a exclusão segue só para admin no servidor) aparece acima da tabela em `bg-primary/10`.
- **Ações rápidas:** com o mouse sobre a linha ou foco dentro dela, Abrir conversa e Editar (não em anonimizados), ícones `size-3.5`; escondidas de leitores e do Tab, porque o menu "…" tem as mesmas ações com rótulo.
- **Densidade:** confortável ou compacta (avatar menor e metadados na mesma linha do nome), salva por usuário neste aparelho. No celular a tabela vira lista: só seleção, contato e "…", sem rolagem lateral.
- **Ficha:** identidade (avatar, nome, empresa, chips de situação — Descadastrado em pílula `bg-red-500/18`), Abrir/Iniciar conversa como único botão preenchido, abas sublinhadas com acento `primary` na ordem de sempre (Conversas, Etiquetas, Notas, Campos, Negócios, Empresas, Agenda, Privacidade). Cada aba abre com o título pequeno em caixa alta do painel da caixa de entrada; conversas e negócios em linhas com divisória fina (etapa como ponto + texto), notas com filete âmbar, etiquetas como ponto + texto com `aria-pressed`. `?contact=<id>` continua abrindo a ficha.

## Atalhos e paleta

- **Paleta de comandos** (`src/components/layout/command-palette.tsx`): Ctrl K / ⌘K em qualquer tela (também dentro de um campo) ou o campo "Buscar ou executar…" do cabeçalho (só ícone no celular). Diálogo com combobox: setas movem, Enter abre, Esc fecha e devolve o foco. Grupos: Recentes (consulta vazia; últimas 5 páginas/conversas/contatos, por usuário neste aparelho), Ações (Resolver conversa atual só na caixa de entrada com uma aberta e permitida, Nova tarefa para quem escreve, Alternar tema), Ir para (a mesma lista e as mesmas regras de perfil/plano da barra lateral, `nav-config.ts`) e, ao digitar 2+ letras, Conversas e Contatos (até 6 cada, busca com 200 ms de espera, pelo cliente do usuário/RLS, pedido antigo cancelado). No celular vira uma folha de largura total no topo.
- **Atalhos da caixa de entrada** (`src/lib/inbox/shortcuts.ts`, lista no diálogo "?"): J/K próxima/anterior (ordem das faixas), Enter/O abre, R responde, "/" abre as respostas rápidas (sem conversa aberta, foca a busca), Shift+A assume, E resolve e abre a próxima (sem próxima, limpa a seleção; com Desfazer), ? ajuda, Esc sai do campo.
- **Nunca disparam** enquanto se digita (campo, área de texto, contenteditable), com diálogo/menu aberto, com tecla repetida ou com Ctrl/Alt/⌘ (exceto Ctrl K). Assumir e Resolver seguem as regras do cabeçalho da conversa: leitor não muda nada pelo teclado. O agente pode desligar os atalhos de uma tecla no diálogo de ajuda (WCAG 2.1.4).
- Atalho novo: regra pura em `shortcuts.ts` com teste, linha em `SHORTCUT_HELP` e nada que exija Shift além de "?" e Shift+A.
