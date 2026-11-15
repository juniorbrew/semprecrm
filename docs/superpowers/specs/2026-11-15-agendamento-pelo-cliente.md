# Módulo hora marcada — parte 1: o cliente agenda sozinho

Data: 2026-11-15 · Branch `feat/agendamento-cliente` · Worktree `C:\SempreCRM-hora-marcada` · Migration **114** (112 = uso da plataforma, 113 reservada para extras da Entrega 10; conferir antes do PR).

## Decisões do dono (2026-11-15)
- Serve qualquer negócio de hora marcada (salão, barbearia, clínica, estética).
- Dinheiro do cliente final vai direto para a empresa (parte 2, Asaas da própria empresa). Esta parte não cobra nada.
- Ordem: **1) página/app de agendamento do cliente** → 2) sinal Pix + fechar a conta → 3) comissão + caixa → 4) pacotes.

## O que o cliente vê
1. Abre `semprecrm.com.br/agendar/<endereco-da-empresa>` (link enviado por WhatsApp, Instagram, bio).
2. Página com nome, logo e cores da empresa (`accounts.branding`), sem marca SempreCRM.
3. Escolhe **serviço** (nome, duração, preço se a empresa quiser mostrar) → **profissional** (ou "qualquer um") → **dia e horário livre**.
4. Informa nome e celular, aceita o aviso de privacidade (LGPD) e confirma o celular (ver "Confirmação do celular").
5. Vê a confirmação; recebe os lembretes que já existem (1 dia e 2 h antes).
6. "Meus horários": lista os próximos, cancela ou remarca até X horas antes (a empresa define).
7. Pode instalar como app: manifesto próprio da empresa (nome, ícone, cor) e, no iPhone, um passo a passo "Compartilhar → Adicionar à Tela de Início".

## Confirmação do celular — decisão pendente
- **A (recomendada) — o cliente manda o código para a empresa.** Botão "Confirmar pelo WhatsApp" abre o WhatsApp com a mensagem pronta `Código de agendamento: 4821`. A entrada de mensagens reconhece o código (mesmo ponto onde já tratamos a resposta do lembrete, `tryHandleReminderReply`) e libera. Funciona no WhatsApp oficial e no QR, não precisa de modelo aprovado pela Meta, não custa nada e **não permite que alguém use a página para disparar mensagens** a números de terceiros (risco de banir o número da empresa).
- B — a empresa manda o código para o cliente. Mais familiar, mas no WhatsApp oficial exige modelo de autenticação aprovado e cobra por envio; no QR, envio para número desconhecido aumenta o risco de bloqueio.

Depois de confirmado, o aparelho fica lembrado por 30 dias (cookie assinado, só servidor), então o cliente não confirma toda vez.

## O que reaproveita (nada de agenda paralela)
- `src/lib/agenda/service.ts`: `getAvailability`, `bookAppointment`, `rescheduleAppointment`, `setAppointmentStatus`, `listUpcomingForContact` — mesmas regras de expediente, antecedência mínima, limite de dias e conflito; a trava do banco (RPC + exclusão) continua sendo a garantia contra dois clientes no mesmo horário.
- Mesmo padrão do robô do site (`/api/v1/robo/[key]`): rota pública, service role, tudo escopado pela linha da página, limites por endereço/IP/celular, nada vindo do pedido aponta para dados do CRM.
- `ingestLead`/contatos: o cliente vira (ou casa com) contato da empresa; supressão LGPD respeitada.
- Lembretes (097) já pegam o agendamento novo sem mudança.
- Módulos por empresa: novo módulo `booking_page` (exige `calendar`).
- Modo só leitura da cobrança: empresa bloqueada → página mostra "agendamento indisponível no momento".

## Banco — migration 114_booking_pages
- `booking_pages`: `account_id` (único), `slug` (único, minúsculo, `^[a-z0-9](-?[a-z0-9])+$`, 3–40, lista de reservados), `enabled`, `title`, `intro`, `show_prices`, `client_change_hours` (padrão 2), `created_at/updated_at`. RLS: membros leem, admin escreve; anon sem acesso.
- `calendar_events.booking_source` aceita `'client'`.
- `booking_phone_checks` (confirmação A): `account_id`, `code` (4–6 dígitos, único por conta enquanto válido), `phone_hash`, `expires_at` (10 min), `confirmed_at`, `attempts`. Só service role.
- Módulo `booking_page` nas listas de plano (plans.ts + as duas listas SQL, nova revisão de plano, como na 099), ligado em trial/pro/empresa.

## Rotas
- Página: `src/app/agendar/[slug]/page.tsx` (pública, fora do `(dashboard)`), `manifest.webmanifest` por empresa, service worker com escopo `/agendar/<slug>/`.
- API `src/app/api/agendar/[slug]/…`: `config` (GET), `horarios` (GET), `confirmar` (POST, cria código), `confirmar/status` (GET), `agendar` (POST), `meus` (GET), `[id]/cancelar` e `[id]/remarcar` (POST, só o próprio contato).
- Configurações → Agenda → **Página de agendamento**: ligar, endereço, textos, mostrar preços, prazo para o cliente mudar, copiar link, prévia.

## Segurança (não cortar)
- Limites: por endereço, por IP+endereço, por celular; no máximo N agendamentos futuros por contato (reusar `SKILL_LIMITS.agendaFutureMaxPerContact`).
- Cliente nunca pede encaixe (`allowEncaixe` já recusa fora de `'agent'`).
- Horários livres não revelam quem está ocupando; "Meus horários" só mostra agendamentos do contato da sessão.
- Cookie assinado (HMAC, segredo do servidor), `HttpOnly`, `Secure`, `SameSite=Lax`, escopo do endereço.
- Nenhum dado pessoal em log; nenhum IP guardado.
- Revisão de segurança Opus antes do PR.

## Fora desta parte
Pagamento/sinal (parte 2), comissão e caixa (3), pacotes (4), foto do profissional (por ora inicial + cor), QR code do link, notificação push para o cliente.

## Verificação
- Testes unitários: slug, cookie, limites, regra de prazo para mudar, código de confirmação na entrada.
- Teste SQL em `BEGIN … ROLLBACK` (RLS, anon, `'client'`, módulo).
- Suite completa + i18n antes do PR.
- Navegador em tamanho de celular: agendar, confirmar, ver na agenda do CRM, cancelar, remarcar, instalar (Android) e checar passo a passo iPhone.
