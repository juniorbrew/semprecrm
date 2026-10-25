# Agenda inteligente — entrega A (serviços, profissionais e agendamento)

Data: 2026-10-24 · Migration: `096_agenda_services.sql` · Módulo de plano: `calendar` (existente)

## Objetivo

Um agendamento que serve a qualquer negócio: consultório/escritório (consulta com um profissional), salão/barbearia (vários profissionais, serviços de durações diferentes), serviço externo/visita e genérico. Quem agenda hoje é o atendente no CRM; na entrega C será a IA no WhatsApp, pelo mesmo serviço de servidor.

## Decisões

1. **O agendamento é um `calendar_events`** (040), com `service_id`, `resource_id`, `booking_source` (`agent`/`ai`/`api`) e `idempotency_key`. Nenhuma tabela paralela: Google/Outlook, push, tempo real, "Agenda" do contato e da conversa continuam valendo. O vínculo com cliente e conversa usa `contact_id` e `conversation_id` que já existem (a entrega B usa para lembretes).
2. **Sem módulo novo.** Agendar por serviço faz parte do módulo `calendar`; a tela de configuração só aparece se o plano inclui `calendar`. Escritas usam `requireModule` (recusa conta somente-leitura com 402).
3. **Status**: `scheduled` (agendado, aguardando confirmação), `confirmed`, `cancelled`, `no_show`, `completed`. `confirmed` continua sendo o status do evento comum. Listas de "próximos" e conflitos tratam `scheduled` e `confirmed` como ocupando tempo (`ACTIVE_EVENT_STATUSES`). Lembretes (push 040) continuam só para `confirmed`; a entrega B decide o lembrete por WhatsApp.
4. **Dupla reserva é impedida no banco**: `EXCLUDE USING gist (resource_id WITH =, tstzrange(block_starts_at, block_ends_at) WITH &&)` nos status `scheduled/confirmed/completed`. O "bloco" é o horário mais a folga antes/depois do serviço, **recalculado por trigger em todo INSERT/UPDATE** (o que o cliente mandar em `block_*` é descartado; CHECK exige `block_*` quando há recurso). Vale para qualquer caminho de escrita.
5. **Quem pode o quê**:
   - Configurar (serviços, profissionais, horários, regras): admin+ (RLS + `requireRole('admin')`).
   - Agendar, remarcar, cancelar, mudar status: **qualquer agent+ da conta**, em qualquer agendamento de serviço (recepção agenda para vários profissionais). RLS: política `calendar_events_appointment_update` cobre só linhas com `service_id`; eventos comuns seguem a regra de 040 (dono/criador/admin). Viewer só lê.
   - `service_id`, `booking_source` e `idempotency_key` são reservados às RPCs (trigger `calendar_events_agenda_guard`): usuário não marca nem desmarca um evento como agendamento.
6. **RPCs só para o servidor.** `agenda_book_appointment`, `agenda_reschedule_appointment`, `agenda_set_appointment_status` são SECURITY DEFINER (`search_path = public, pg_temp`) e **executáveis apenas por `service_role`**. Motivo: horário de atendimento, exceções, antecedência mínima e janela máxima dependem do fuso da conta e ficam numa única implementação (TypeScript, `availability.ts`), que o servidor roda depois de autenticar sessão, papel, módulo e conta gravável; se o usuário pudesse chamar a RPC direto, pularia essas regras. O banco garante o que nunca pode falhar: não sobrepor, serviço oferecido pelo recurso, itens da mesma conta, conta gravável (`private.account_is_writable`, inclusive para `service_role`) e ator que seja agent+ da conta.
   - Consequência assumida: horário/antecedência são regras do serviço de agendamento, não do banco. Mover um evento pelo editor/arrastar da agenda continua possível (e pode ficar fora do expediente), mas nunca sobrepõe outro agendamento do mesmo profissional.
   - Evento comum do profissional (sem `resource_id`) conta como ocupado na checagem das RPCs, mas não há exclusão no banco entre um evento comum e um agendamento: a corrida "evento comum × agendamento" não é atômica (aceito).
7. **Idempotência**: mesma `idempotency_key` na conta devolve o mesmo agendamento (retry, clique duplo, replay de webhook).
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

- **B — Lembretes e confirmação por WhatsApp**: usa `status` (`scheduled` → `confirmed`), `contact_id` e `conversation_id`; cron de lembretes; resposta do cliente confirma/cancela via `setAppointmentStatus`.
- **C — IA agenda no WhatsApp**: ferramenta da IA chama `getAvailability` e `bookAppointment` (`source: 'ai'`, `idempotencyKey` derivada da mensagem) com service-role; escolhe entre os horários devolvidos, nunca inventa.
- Fora do escopo agora: agendamento público por link, pagamento/sinal, recorrência, override de antecedência por atendente, buffers recalculados em agendamentos antigos quando o serviço muda.
