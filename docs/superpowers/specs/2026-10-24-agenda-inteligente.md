# Agenda inteligente — entrega A (serviços, profissionais e agendamento)

Data: 2026-10-24 · Migration: `096_agenda_services.sql` · Módulo de plano: `calendar` (existente)

## Objetivo

Um agendamento que serve a qualquer negócio: consultório/escritório (consulta com um profissional), salão/barbearia (vários profissionais, serviços de durações diferentes), serviço externo/visita e genérico. Quem agenda hoje é o atendente no CRM; na entrega C será a IA no WhatsApp, pelo mesmo serviço de servidor.

## Decisões

1. **O agendamento é um `calendar_events`** (040), com `service_id`, `resource_id`, `booking_source` (`agent`/`ai`/`api`) e `idempotency_key`. Nenhuma tabela paralela: Google/Outlook, push, tempo real, "Agenda" do contato e da conversa continuam valendo. O vínculo com cliente e conversa usa `contact_id` e `conversation_id` que já existem (a entrega B usa para lembretes).
2. **Sem módulo novo.** Agendar por serviço faz parte do módulo `calendar`; a tela de configuração só aparece se o plano inclui `calendar`. Escritas usam `requireModule` (recusa conta somente-leitura com 402).
3. **Status**: `scheduled` (agendado, aguardando confirmação), `confirmed`, `cancelled`, `no_show`, `completed`. `confirmed` continua sendo o status do evento comum. Listas de "próximos" e conflitos tratam `scheduled` e `confirmed` como ocupando tempo (`ACTIVE_EVENT_STATUSES`). Lembretes (push 040) continuam só para `confirmed`; o lembrete por WhatsApp (entrega B) vale para `scheduled` e `confirmed`.
4. **Dupla reserva é impedida no banco**: `EXCLUDE USING gist (resource_id WITH =, tstzrange(block_starts_at, block_ends_at) WITH &&)` nos status `scheduled/confirmed/completed`. O "bloco" é o horário mais a folga antes/depois do serviço, **recalculado por trigger em todo INSERT/UPDATE** (o que o cliente mandar em `block_*` é descartado; CHECK exige `block_*` quando há recurso). Vale para qualquer caminho de escrita.
5. **Regras de acesso** (quem pode o quê):
   - Configurar (serviços, profissionais, horários, regras): admin+ (RLS + `requireRole('admin')`).
   - Agendar, remarcar, cancelar, mudar status: **qualquer agent+ da conta**, em qualquer agendamento (recepção agenda para vários profissionais), **somente pela API** `/api/agenda/appointments*`, que valida sessão, papel, módulo, conta gravável e todas as regras e então chama a RPC com service-role. Viewer só lê.
   - **Nenhum usuário escreve direto num agendamento**, nem dono, criador ou admin. Não existe política RLS extra para agendamentos; vale a de 040 (dono/criador/admin) para o resto do evento, e o trigger `calendar_events_agenda_guard` recusa (42501) para usuário: criar evento com `service_id`, `resource_id`, `booking_source` ou `idempotency_key`; mudar essas colunas; e, em linha que já é agendamento, mudar horário, fim, `status`, dono, contato, conversa ou `block_*`. O `CHECK (resource_id IS NULL OR service_id IS NOT NULL)` garante que só agendamento criado pela RPC ocupa tempo de recurso.
   - O que dono/admin ainda editam direto num agendamento: título, descrição, local, cor, lembrete e vínculos de negócio/tarefa. Excluir a linha continua permitido pela política de 040 (libera o horário; não burla regra).
   - UI: o editor genérico abre agendamento de serviço somente leitura com o botão **Gerenciar agendamento**; arrastar um agendamento na grade chama a API de remarcação (e redimensionar é recusado, pois a duração vem do serviço). Eventos comuns não mudam.
6. **RPCs só para o servidor.** `agenda_book_appointment`, `agenda_reschedule_appointment`, `agenda_set_appointment_status` são SECURITY DEFINER (`search_path = public, pg_temp`) e **executáveis apenas por `service_role`**. Motivo: horário de atendimento, exceções, antecedência mínima e janela máxima dependem do fuso da conta e ficam numa única implementação (TypeScript, `availability.ts`), que o servidor roda depois de autenticar sessão, papel, módulo e conta gravável; se o usuário pudesse chamar a RPC direto, pularia essas regras. O banco garante o que nunca pode falhar: não sobrepor, serviço oferecido pelo recurso, itens da mesma conta, conta gravável (`private.account_is_writable`, inclusive para `service_role`) e ator que seja agent+ da conta.
   - **Encaixe (097, decisão do dono 2026-10-25)**: agent+ e admin podem agendar e remarcar ignorando a antecedência mínima e o limite de dias (horário de atendimento, exceções e não-sobreposição continuam valendo). Opção explícita "Encaixe" nos diálogos, enviada como `encaixe: true`. Imposição: (1) o serviço de servidor só aceita `encaixe` com `source: 'agent'` explícito (`allowEncaixe`), senão `forbidden`: a IA (entrega C) e a API pública nunca fazem encaixe, nem por engano; (2) a RPC repete a regra (`AG011` se `p_override` com origem diferente de `agent`, ou sem ator na reserva); (3) `calendar_events.booking_override` guarda que foi encaixe (auditoria; o guard recusa escrita de usuário nessa coluna); (4) o horário de um encaixe pode começar até 60 min no passado (cliente que chegou agora); (5) `GET /api/agenda/availability?encaixe=1` exige agent+ (viewer recebe 403).
   - Consequência: horário/antecedência são regras do serviço de agendamento, não do banco; como nenhum caminho de usuário altera o tempo de um agendamento, elas não podem ser burladas.
   - Evento comum do profissional (sem `resource_id`) conta como ocupado na checagem das RPCs, mas não há exclusão no banco entre um evento comum e um agendamento: a corrida "evento comum × agendamento" não é atômica (aceito).
7. **Idempotência**: mesma `idempotency_key` na conta e mesmo serviço, cliente e horário devolve o mesmo agendamento (retry, clique duplo, replay de webhook); a mesma chave com outro conteúdo dá 409 (`idempotency_conflict`). A tela troca a chave sempre que serviço, profissional, horário ou cliente mudam.
7a. **Google/Outlook são só de saída para agendamentos**: o sync envia (agendado e confirmado), mas ignora qualquer alteração vinda do provedor (mover, apagar, reabrir): atualiza só o selo, zera o hash e o próximo envio restaura a nossa versão (um apagar remoto desvincula e recria). Uma linha com erro na entrada não aborta o lote nem o cursor. O trigger de guarda também recusa UPDATE direto de horário/status/recurso de agendamento para qualquer role que não seja `postgres` (dono das RPCs).
7b. **Bloco estável**: o bloco (horário ± folgas) só é recalculado quando horário, recurso ou serviço mudam; aumentar a folga de um serviço depois não quebra agendamentos antigos (editar título, anonimização LGPD, concluir).
7c. **Dono do agendamento**: o membro ligado ao recurso, se ainda for agent+ da conta; senão, quem agendou. Reabrir um agendamento cancelado/faltou refaz as checagens de horário, antecedência e conflito.
8. **Fuso**: horários semanais são minutos desde 00:00 no fuso da conta (`accounts.preferences.business_hours.timezone`, padrão `America/Sao_Paulo`); tudo armazenado e devolvido em UTC. A conversão usa `fromZonedParts` (trata DST).

## Modelo de dados

| Tabela | Conteúdo |
|---|---|
| `agenda_services` | nome, duração (5–1440), preço opcional (centavos), folga antes/depois, cor, ativo |
| `agenda_resources` | profissional/sala/outro, `user_id` opcional (membro da mesma conta, validado por trigger), cor, ativo |
| `agenda_resource_services` | quais recursos fazem quais serviços (FKs compostas garantem a mesma conta) |
| `agenda_working_hours` | `weekday` 0=domingo…6, `start_minute`, `end_minute`; vários intervalos por dia, sem sobreposição (EXCLUDE) |
| `agenda_exceptions` | `day_off` (dia todo) ou `extra_hours` numa data |
| `agenda_settings` | antecedência mínima (padrão 120 min), dias à frente (60), passo dos horários (30 min) |
| `calendar_events` (+colunas) | `service_id`, `resource_id`, `booking_source`, `idempotency_key`, `block_starts_at`, `block_ends_at` |

RLS em todas: leitura por membro (`is_account_member`), escrita admin+; políticas RESTRICTIVE de 094 para conta somente-leitura. O profissional ligado a um membro recebe o agendamento na agenda dele (`owner_user_id`).

## Regras de disponibilidade (`src/lib/agenda/availability.ts`, núcleo puro)

Um horário é livre quando: respeita a antecedência mínima; não passa de hoje + `max_days_ahead` (dia local); o serviço inteiro cabe em **um** intervalo do dia (horário semanal + extras, a menos que haja folga no dia); e o bloco (horário ± folgas) não encosta em nenhum ocupado (agendamentos ativos do recurso e eventos comuns do membro ligado; sobreposição semiaberta, então "colado" pode). Grade ancorada na meia-noite local com o passo da conta. "Qualquer profissional" lista todos os recursos livres em cada horário; a reserva vai para o primeiro livre e, se perder a corrida, tenta o próximo.

## Superfície

- Rotas (`/api/agenda/*`, conta sempre da sessão): `GET config`, `PUT settings`, `POST/PATCH/DELETE services[/id]`, `POST/PATCH/DELETE resources[/id]`, `GET availability`, `POST appointments`, `PATCH appointments/[id]` (remarcar e/ou status).
- Serviço de servidor (`src/lib/agenda/service.ts`): `getAvailability`, `bookAppointment`, `rescheduleAppointment`, `setAppointmentStatus`; a IA chama com cliente service-role e `source: 'ai'`.
- UI: Configurações → **Serviços e horários**; Agenda → **Agendar serviço** (serviço → profissional ou qualquer → dia/horário → cliente) e clique no agendamento para remarcar/confirmar/cancelar; conversa/contato → seção Agenda com **Agendar serviço** já com o cliente e a conversa.

## Verificação

`supabase/tests/agenda_booking.sql` (termina em ROLLBACK): segunda reserva falha (RPC e INSERT cru, com folgas), cancelar libera, idempotência, evento pessoal ocupa, isolamento entre contas, agent gerencia e viewer não, `block_*` forjado não burla, campos reservados, conta somente-leitura, `service_role` (IA), grants. A corrida real em paralelo precisa de duas sessões: em duas conexões, `BEGIN` + a mesma chamada de `agenda_book_appointment`; a segunda espera o `FOR UPDATE` do recurso e falha com `agenda_slot_taken` após o commit da primeira.

## Entregas seguintes

- **B — Lembretes e confirmação por WhatsApp** (migration 097): abaixo.
- **C — IA agenda no WhatsApp**: ferramenta da IA chama `getAvailability` e `bookAppointment` (`source: 'ai'`, `idempotencyKey` derivada da mensagem) com service-role; escolhe entre os horários devolvidos, nunca inventa.
- Fora do escopo agora: agendamento público por link, pagamento/sinal, recorrência, buffers recalculados em agendamentos antigos quando o serviço muda.

## Entrega B — lembretes e confirmação por WhatsApp (migration 097)

Decisões do dono (2026-10-25): lembrete 1 dia e 2 horas antes, cada um com opção de **confirmar** ou **pedir para remarcar**; por conta: ligar/desligar, ajustar as duas antecedências (padrão 24 h e 2 h) e o texto (variáveis `{cliente}` `{servico}` `{profissional}` `{data}` `{hora}`); só para agendamentos `scheduled`/`confirmed`, com contato com telefone, não anonimizado e sem opt-out. Mais o **encaixe** (ver "Regras de acesso").

### Modelo de dados

| Objeto | Conteúdo |
|---|---|
| `agenda_reminder_settings` | por conta: `enabled` (padrão desligado), `first_offset_minutes` (1440) e `second_offset_minutes` (120), cada um `NULL` = desligado (5 min a 14 dias, diferentes entre si), `message_text` (NULL = texto padrão, até 1000), `template_name` + `template_language` (modelo aprovado do canal oficial). RLS: membro lê, admin+ escreve, 094 bloqueia escrita em conta somente-leitura |
| `agenda_reminders` | a fila/caixa de saída: uma linha por **(agendamento, posição 1\|2, horário do agendamento)** — `UNIQUE (event_id, slot, for_starts_at)`. `state`: `pending` → `sending` → `sent` \| `skipped` \| `failed` (ou `cancelled`); `reason` (código curto), `error_text`, `attempts`, `next_try_at`, `wa_message_id`, `channel`, `response`/`responded_at`. Membro lê; ninguém escreve por PostgREST (só trigger, RPC e cron) |
| `calendar_events` (+colunas) | `booking_override` (encaixe), `customer_response` (`confirmed` \| `reschedule_requested`) e `customer_responded_at`. O guard recusa escrita de usuário nas três |
| `conversation_events` | novo tipo `agenda_reply` (payload: `action`, `starts_at`, `service_name`) — a pílula "Cliente confirmou / pediu para remarcar o agendamento" na conversa |

### Planejamento (trigger, vale para qualquer caminho de escrita)

`private.agenda_reminders_plan(event_id)` é idempotente e roda em AFTER INSERT/UPDATE OF `starts_at, status, contact_id` de `calendar_events` (só agendamentos) e quando a configuração muda (`enabled`, antecedências): replaneja os agendamentos futuros da conta.
- Cria um lembrete por antecedência ligada, `due_at = início − antecedência`. Antecedência que **já passou** nasce `skipped`/`past` (agendamento feito a menos de 24 h só recebe o de 2 h; a menos de 2 h, nenhum) e aparece no diálogo do agendamento.
- **Remarcar**: os pendentes do horário antigo viram `cancelled`/`rescheduled` e nascem novos para o novo horário (voltar ao horário antigo reaproveita as linhas canceladas, sem duplicar). **Cancelar / faltou / concluído / contato apagado (LGPD)**: pendentes viram `cancelled`/`appointment_closed`; reabrir replaneja. Desligar ou mudar antecedências cancela/atualiza os pendentes (`settings_changed`).
- Remarcar zera `customer_response` (trigger BEFORE): a resposta valia para o horário antigo.

### Envio (cron `GET /api/agenda/reminders/cron`, `x-cron-secret`, no `cron-tick.mjs` a cada tick e no bloco de cron do nginx)

- **Sem envio duplo**: `agenda_reminders_claim()` troca `pending` → `sending` num único comando com `FOR UPDATE SKIP LOCKED` (como as mensagens agendadas, 092); ticks sobrepostos dividem as linhas e uma linha reivindicada nunca é reivindicada de novo; a unicidade acima impede o lembrete de existir duas vezes. Linha presa em `sending` há 10 min (worker caiu) vira `failed`/`maybe_sent` — **não reenvia** (pode ter saído). Falha depois de o provedor aceitar conta como enviado.
- Antes de enviar, cada linha é revalidada com o mundo de agora (nada aqui é confiado ao planejamento): configuração ligada e antecedência ainda ativa, agendamento ainda `scheduled`/`confirmed`, no mesmo horário e no futuro, conta gravável (`read_only`), contato existente, não anonimizado, sem opt-out, com telefone, e com conversa. Cada recusa é um `skipped` com código visível (traduzido no diálogo do agendamento).
- **Conversa usada**: a aberta/pendente mais recente do contato; senão a do agendamento; senão a mais recente. Sem nenhuma, `skipped`/`no_conversation`.
- **Canais** (`planSend`): **QR** → texto livre + "Responda 1 para confirmar ou 2 para remarcar.", prioridade `bulk` (fila do gateway); `throttled` volta a `pending` com `next_try_at` (2 min × tentativa, até 8 tentativas, depois `failed`/`throttled` + push à equipe) — nunca se perde. **Oficial** dentro da janela de 24 h → o mesmo texto livre. **Oficial fora da janela** → modelo aprovado configurado (corpo com 5 parâmetros `{{1}}..{{5}}` = cliente, serviço, profissional, data, hora), senão `skipped`/`window_closed`. Modelo não sincronizado → `skipped`/`template_unavailable`.
- Data e hora no **fuso da conta** (`formatWhen`). Erro de envio → `failed` com texto + push ao responsável/dono/quem agendou.

### Resposta do cliente (`ingestInboundMessage` → `tryHandleReminderReply`)

- Casa só com o **lembrete enviado mais recente** (até 48 h) do contato cujo agendamento ainda está aberto, no mesmo horário e no futuro; não age se há fluxo de bot ativo (o "1" pode ser opção dele), se o contato está bloqueado (opt-out/anonimizado) ou se já foi respondido.
- Interpretação (`parseReminderReply`): "1", "sim", "confirmo", "confirmado", "ok", 👍… → confirmar; "2", "remarcar", "reagendar", "outro horário"… → remarcar. **Ambíguo não age** ("cancelar", "não posso", "1 e 2", "sim, mas remarcar", frase longa) e fica como mensagem normal para o humano. No canal oficial, o toque num botão de resposta rápida do modelo chega como texto do botão ("Confirmar"/"Remarcar") e cai nas mesmas regras.
- `agenda_reminder_respond` (RPC service-role, atômica): marca o lembrete e os irmãos enviados para o mesmo horário, grava `customer_response`; se confirmou e estava `scheduled`, passa a `confirmed` pela RPC de status. Pedido de remarcar **não muda o status**: marca "pediu para remarcar" e avisa por push a equipe (responsável da conversa, dono e quem agendou) para um humano remarcar (a IA remarcando vem na entrega C). Conta somente-leitura recusa e a mensagem segue normal.
- Registra a pílula `agenda_reply` na conversa, responde ao cliente uma confirmação curta (prioridade `interactive`) e a mensagem não vai para fluxos, automações, IA nem aviso fora do horário.

### Interface

- Configurações → Serviços e horários → **Lembretes por WhatsApp** (admin+): ligar/desligar, as duas antecedências (valor + unidade, cada uma pode ser desligada), mensagem com **prévia** ao vivo, modelo aprovado do canal oficial.
- Diálogo do agendamento: situação, selos **Encaixe** / **Confirmado pelo cliente** / **Pediu para remarcar**, e o bloco **Lembretes por WhatsApp** com cada antecedência (agendado / enviado / pulado + motivo / falhou) e a resposta do cliente. Agenda: ícone de "confirmado pelo cliente" / "pediu para remarcar" nos itens.
- Diálogos de agendar e de remarcar: caixa **Encaixe (ignorar antecedência e limite de dias)** para agent+; os horários passam a vir de `availability?encaixe=1`.

### Verificação

`supabase/tests/agenda_reminders.sql` (termina em ROLLBACK): contas das antecedências (24 h/2 h exatas), horário feito dentro da antecedência (`past`), remarcar/voltar/cancelar/reabrir/faltou, mudança de configuração, claim atômico e idempotente (segunda chamada não pega nada; `next_try_at`; preso vira `maybe_sent`), unicidade, resposta do cliente (confirma, pede remarcar, irmãos, segunda resposta recusada, conta somente-leitura, remarcar zera a resposta), encaixe (só `agent` com ator; IA/API recusadas; registrado; sobreposição ainda barrada), usuário não escreve as colunas/tabelas novas, RLS entre contas, LGPD cancela, grants. Testes TypeScript: `reminders-core`, `reminders` (cron com banco de mentira: QR, janela, modelo, repetição por `throttled`, pulos), `reminder-reply`, encaixe em `service.test.ts`, rotas. A corrida real de dois ticks precisa de duas sessões (ver o cabeçalho do SQL).

### Limitações conhecidas

- A mensagem de agradecimento ao cliente (confirmado / vamos remarcar) é fixa em pt-BR; só o lembrete tem texto configurável.
- A janela de 24 h do canal oficial usa `conversations.last_customer_message_at` da conversa escolhida.
- Botões de resposta rápida de modelos só são lidos pelo texto do botão (o envio de modelo não define `payload` de botão).
- Entre a revalidação e o envio há uma janela de milissegundos em que um cancelamento ainda deixa o lembrete sair (o trigger só cancela `pending`).
