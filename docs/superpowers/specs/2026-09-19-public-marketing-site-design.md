# Site público/comercial do SempreCRM

Data: 2026-09-19. Aprovado em conversa ("sim").

## Objetivo

Hoje `/` só faz `redirect('/dashboard')` — não existe nenhuma página pública. Construir o site
comercial (home + preços + contato) que apresenta o produto real, gera confiança e leva o
visitante a `/signup` (teste grátis) ou `/login` (cliente existente), com o menor atrito possível.
Só descrever módulos/planos/fluxos que existem de fato no código — nada inventado.

Decisões já tomadas com o usuário (não reabrir):
- Hospedagem: mesma app, mesmo domínio — sem mudança de DNS/Nginx/certbot.
- Estrutura: híbrida — home rica em `/` + páginas dedicadas `/precos` e `/contato`.
- Preços: sem valores em R$, só recursos/limites reais + CTAs.
- Contato: formulário salvo no Supabase (sem serviço de e-mail externo).
- Logo: wordmark tipográfico "SempreCRM" (Inter, tema Violeta), sem símbolo novo.
- Analytics: Google Analytics 4, atrás de `NEXT_PUBLIC_GA_MEASUREMENT_ID` (placeholder até o
  usuário passar o Measurement ID real).

## Não-objetivos

Não mexer em `(auth)`, `(dashboard)`, `/platform`, `/api/*`, billing/checkout, onboarding pós-
signup, DNS/Nginx/Contabo. Não inventar segmento de mercado, preço ou telefone/WhatsApp de
suporte (nenhum existe hoje no repo).

## Rotas e layout

Novo route group `src/app/(marketing)/`, layout próprio (header público + footer), sem sidebar
do produto:

```
src/app/(marketing)/layout.tsx      — header (logo, nav, Entrar, Começar grátis) + footer
src/app/(marketing)/page.tsx        — home (substitui src/app/page.tsx atual)
src/app/(marketing)/precos/page.tsx
src/app/(marketing)/contato/page.tsx
src/app/(marketing)/_components/    — seções da home (hero, benefits, how-it-works,
                                       features, audience, demo, faq)
src/app/sitemap.ts                  — só rotas de marketing
src/app/robots.ts                   — Allow: /, /precos, /contato ; Disallow: /dashboard,
                                       /platform, /api, /join, /chat, /inbox... (mesmo efeito do
                                       robots:false atual, mas explícito e correto por rota)
```

`src/app/page.tsx` atual (`redirect('/dashboard')`) é removido — `(marketing)/page.tsx` assume o
slot de `/`. Nenhuma URL existente muda: `/login`, `/signup`, `/dashboard`, `/join/[token]`,
`/platform` continuam exatamente iguais.

### robots/indexação

`src/app/layout.tsx:28-31` define `robots: {index:false, follow:false}` no metadata raiz — hoje
isso bloqueia a indexação do site inteiro (correto, porque hoje o site inteiro é o produto
autenticado). Next.js faz merge de metadata por segmento: o filho sobrescreve as chaves que
define. `(marketing)/layout.tsx` define seu próprio `robots: {index:true, follow:true}`, que
sobrescreve o valor herdado só para as rotas de marketing. `(auth)`, `(dashboard)` e `/platform`
não são tocados — continuam herdando `index:false` do layout raiz sem nenhuma mudança de código
neles.

## Conteúdo (baseado só no produto real)

Fonte: `src/components/layout/sidebar.tsx` (nav real), `src/lib/plans.ts` (módulos e planos),
`src/lib/br/documents.ts` + `042_account_registration.sql` (cadastro PF/PJ).

**Hero**: "SempreCRM" + proposta de valor (inbox de WhatsApp compartilhado da equipe + funil de
vendas + tarefas + automação, num só lugar) + CTA primário "Começar grátis" → `/signup` + CTA
secundário "Entrar" → `/login`. Composição visual: mock da UI real (paleta/tipografia do produto,
não um mockup genérico) — ver seção Design.

**Benefícios** (linguagem de benefício, não nome técnico do módulo):
- Caixa de entrada → "Atenda o WhatsApp da empresa em equipe, sem perder conversa"
- Contatos → "Toda a informação do cliente num só lugar"
- Funis (pipelines) → "Acompanhe cada oportunidade até fechar"
- Tarefas → "Organize o que sua equipe precisa fazer"
- Disparos (broadcasts) → "Envie campanhas por WhatsApp com modelo aprovado pela Meta"
- Automações/Fluxos → "Automatize respostas e etapas repetitivas"
- Agenda → "Compromissos sincronizados com Google Calendar e Outlook"

**Como funciona** (fluxo real): 1) Crie sua conta (pessoa física ou jurídica) → 2) Configure seu
WhatsApp (API oficial da Meta ou QR code) → 3) Convide sua equipe (link de convite,
owner/admin/agente/visualizador) → 4) Atenda, venda e automatize.

**Funcionalidades**: cards agrupando os módulos reais acima + Chat interno, com 1 screenshot real
do produto rodando localmente (capturado durante a fase de testes, não gerado por IA) por
grupo quando isso ajudar a entender.

**Público-alvo**: pequenas e médias empresas brasileiras que vendem/atendem por WhatsApp e
precisam de uma caixa de entrada compartilhada com CRM leve — só isso, sem inventar vertical
(imobiliária, saúde etc. não têm nenhuma evidência no produto).

**Demonstração**: seção com screenshot real do dashboard/inbox em destaque.

**Planos** (`/precos`, dados exatos de `src/lib/plans.ts:99-116`):

| Plano | Módulos | Usuários | Canais WhatsApp |
|---|---|---|---|
| Trial | Todos | 2 | 1 |
| Básico | Dashboard, Funis, Tarefas, WhatsApp via QR | 3 | 1 |
| Pro | Todos exceto Fluxos | 10 | 2 |
| Empresa | Todos | Ilimitado | 5 |

Sem R$. CTA por card: Trial/Básico/Pro → "Começar grátis" (`/signup`); Empresa → "Falar com
nossa equipe" (`/contato`).

**FAQ**: dúvidas reais dado o produto (ex: "Preciso de WhatsApp Business API ou posso usar meu
número normal?" — resposta: os dois canais existem, `channel_official` e `channel_qr`; "Dá para
convidar minha equipe depois?" — sim, link de convite; "Meus dados ficam seguros?" — RLS +
LGPD, `src/lib/lgpd/`). Sem inventar perguntas sobre recursos que não existem (não mencionar
billing/cartão de crédito, já que não há checkout).

**Contato**: formulário (nome, e-mail, empresa, mensagem) — ver seção Formulário de contato.

## Design

Reaproveita 100% os tokens reais do produto (`src/app/globals.css`, `src/lib/themes.ts`) — sem
paleta nova:
- Tema Violeta (`oklch(0.526 0.247 293)`) como acento — default do produto, tagline do próprio
  código "confident, slightly playful".
- Modo claro por padrão no site público (site de marketing costuma converter melhor em claro;
  o app continua com dark como default próprio) — toggle de tema não é necessário aqui.
- Fonte Inter (`--font-sans`), mesma escala de radius (`--radius: 0.625rem` e derivados).
- Componentes shadcn/ui já existentes (`Button`, `Card`, `Accordion` p/ FAQ, `Input`,
  `Textarea`, `Label`) — sem biblioteca nova.
- Logo: wordmark `<span>` "Sempre<span class="text-primary">CRM</span>" em Inter semibold — sem
  arquivo de imagem, sem ícone inventado. Favicon já existe (`src/app/icon.tsx`, dinâmico).
- Uma seção por viewport, bastante espaço em branco, sem gradiente decorativo sem propósito, sem
  ícone aleatório (só `lucide-react`, já usado no produto), sem animação além de transições sutis
  de hover/entrada.

## Formulário de contato

Migration nova `043_marketing_contact.sql`:

```
contact_submissions
  id uuid pk default gen_random_uuid(), created_at timestamptz default now(),
  name text not null, email text not null, company text null, message text not null,
  source text null (ex: 'contato', 'planos-empresa').
RLS: insert liberado para anon/authenticated (é o formulário público) só via a função/rota
  server-side abaixo — sem select/update/delete por RLS padrão (só platform admin via service
  role, se decidirmos expor isso em /platform depois — fora de escopo agora).
```

`src/app/api/marketing/contact/route.ts` (POST, fora de `(dashboard)`/`(auth)`, sem exigir
sessão): valida payload com zod (mesmo padrão das outras rotas de API); anti-spam sem serviço
externo — campo honeypot oculto (bot preenche, humano não; se preenchido, responde sucesso
genérico sem gravar) + limite de tamanho por campo + throttle simples por IP (contagem de
submissões na própria tabela nos últimos 60s, rejeita acima de N). Grava em
`contact_submissions` com o client server-side do Supabase. Resposta genérica de sucesso/erro.
Sem envio de e-mail (decisão já tomada) — consulta futura via SQL direto ou painel `/platform`
fica para depois, fora de escopo.

## Analytics (GA4)

`NEXT_PUBLIC_GA_MEASUREMENT_ID` novo em `.env.local.example` (vazio/placeholder — o usuário
preenche depois). Script GA4 carregado via `next/script` **só dentro do layout de marketing**
(não em `(auth)`/`(dashboard)`/`/platform` — não rastrear o produto autenticado por engano) e só
se a env var estiver definida (no-op silencioso em dev sem a chave).

Eventos rastreados (`gtag('event', ...)`):
- `page_view` (automático)
- `cta_start_click` — clique em "Começar grátis" (home, planos, hero)
- `cta_login_click` — clique em "Entrar"
- `contact_form_submit` — envio do formulário de contato
- Início/conclusão de cadastro **não** é rastreável a partir do site de marketing (acontece em
  `/signup`, fora do escopo desta mudança) — anotar como item pendente para uma fase futura que
  adicionaria o mesmo `gtag` dentro de `(auth)/signup` se o usuário quiser depois.

### CSP

`next.config.ts` tem CSP restritiva (`script-src 'self' ...`, `connect-src 'self' https://*.supabase.co ...`).
GA4 precisa de `https://www.googletagmanager.com` em `script-src` e `https://www.google-analytics.com`
(+ `https://*.analytics.google.com`) em `connect-src` e `img-src`. Adicionar essas origens à CSP
existente (ainda `Report-Only`, então não quebra nada mesmo se algo faltar) — não remover nenhuma
diretiva atual.

## SEO

- `(marketing)/layout.tsx`: `robots: {index:true, follow:true}` (ver seção Rotas), metadata por
  página (`title`, `description`, `openGraph`, `alternates.canonical`) usando o padrão
  `template: '%s — SempreCRM'` já definido no layout raiz.
- `metadataBase` novo no layout de marketing a partir de `NEXT_PUBLIC_SITE_URL` (já existe a env
  var, hoje só usada para links de convite/OAuth callback).
- `src/app/sitemap.ts` (App Router convention) listando `/`, `/precos`, `/contato`.
- `src/app/robots.ts` — `Allow` nas rotas de marketing, `Disallow` no resto.
- OG image: uma imagem estática 1200×630 gerada a partir do mesmo wordmark/tema (via
  `next/og` `ImageResponse`, mesmo mecanismo do `icon.tsx` dinâmico atual — sem asset externo).
- Headings semânticos (h1 único por página, hierarquia h2/h3 nas seções), `lang="pt-BR"` já
  herdado do layout raiz.
- Dados estruturados: `SoftwareApplication` JSON-LD na home (nome, descrição, categoria) — só
  isso, nada inventado (sem rating/review agregado, que não existe).

## Performance e acessibilidade

- Server Components por padrão nas seções da home (estáticas); único client component é o
  formulário de contato e o script GA4.
- `next/image` para os screenshots reais (capturados na fase de testes).
- Navegação por teclado: header/footer com foco visível (já herdado dos componentes shadcn),
  formulário com `label` associado a cada campo, contraste checado no tema Violeta claro.
- `next/font` já usado no projeto todo (sem FOUT novo).

## Testes / auditoria antes da entrega

1. `npm run lint`, `npm run typecheck` (ou equivalente do CI), `npm run build` — build de
   produção precisa passar.
2. Vitest para a validação do formulário de contato (payload válido/inválido) — mesmo padrão de
   `src/lib/br/documents.test.ts`.
3. Navegador (via preview local): desktop + mobile (375px) + tablet, todos os links e CTAs
   (`Entrar`→`/login`, `Começar grátis`→`/signup`, `Falar com nossa equipe`→`/contato`),
   submissão do formulário de contato ponta a ponta, console sem erros, `read_network_requests`
   sem 4xx/5xx inesperado.
4. Screenshot desktop e mobile de cada página (home, preços, contato) para o relatório final.
5. Checagem rápida de SEO (sitemap.xml, robots.txt, meta tags, OG) e de acessibilidade (foco por
   teclado, contraste) documentada no relatório final.

## Entrega

Ao final: lista de arquivos criados/modificados, comandos rodados, screenshots desktop/mobile,
relatório de performance/SEO/acessibilidade, URLs testadas, e a lista de itens que dependem do
usuário (Measurement ID do GA4 real, e-mail de destino a definir depois se quiser trocar a
estratégia do formulário, eventuais preços quando definidos).
