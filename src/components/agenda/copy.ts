import type { Language } from "@/lib/i18n";

/**
 * All strings of the scheduling UI (appointment dialog + Settings → Serviços e
 * horários), pt-BR / en-US side by side. Errors from the API already arrive
 * in pt-BR (src/lib/agenda/errors.ts).
 */
export interface AgendaCopy {
  schedule: string;
  scheduleService: string;
  appointment: string;
  service: string;
  chooseService: string;
  professional: string;
  anyProfessional: string;
  date: string;
  time: string;
  noSlots: string;
  noServices: string;
  noServicesHint: string;
  loadingSlots: string;
  contact: string;
  notes: string;
  notesPlaceholder: string;
  confirmNow: string;
  book: string;
  booking: string;
  booked: string;
  moved: string;
  close: string;
  reschedule: string;
  rescheduleConfirm: string;
  status: string;
  statusChanged: string;
  markAs: Record<string, string>;
  upcoming: string;
  failed: string;
  pickContact: string;
  with: string;
  // settings
  settingsTitle: string;
  settingsDescription: string;
  rules: string;
  rulesHint: string;
  minNotice: string;
  maxDaysAhead: string;
  slotStep: string;
  minutes: string;
  days: string;
  save: string;
  saved: string;
  services: string;
  servicesHint: string;
  newService: string;
  editService: string;
  name: string;
  duration: string;
  price: string;
  bufferBefore: string;
  bufferAfter: string;
  active: string;
  inactive: string;
  professionals: string;
  professionalsHint: string;
  newProfessional: string;
  editProfessional: string;
  kind: string;
  kinds: Record<string, string>;
  linkedMember: string;
  noMember: string;
  offeredServices: string;
  weeklyHours: string;
  closed: string;
  addInterval: string;
  removeInterval: string;
  start: string;
  end: string;
  exceptions: string;
  exceptionsHint: string;
  dayOff: string;
  extraHours: string;
  addException: string;
  note: string;
  remove: string;
  deleteConfirm: string;
  cancel: string;
  empty: string;
  weekErrors: Record<string, string>;
  readOnly: string;
  resizeBlocked: string;
  loadFailed: string;
  retry: string;
  prevDay: string;
  nextDay: string;
  nextFreeDay: string;
  noFreeDay: string;
  managedElsewhere: string;
  manage: string;
  // encaixe (walk-in) + customer answer + reminders (migration 097)
  encaixe: string;
  encaixeHint: string;
  encaixeBadge: string;
  customerConfirmed: string;
  customerReschedule: string;
  remindersSection: string;
  remindersNone: string;
  reminderStates: Record<string, string>;
  reminderReasons: Record<string, string>;
  reminderSentAt: string;
  reminderAnswered: Record<string, string>;
  remindersTitle: string;
  remindersHint: string;
  remindersEnabled: string;
  reminderFirst: string;
  reminderSecond: string;
  reminderOff: string;
  reminderUnits: Record<string, string>;
  reminderText: string;
  reminderTextHint: string;
  reminderTextDefault: string;
  reminderPreview: string;
  reminderOptionsNote: string;
  reminderTemplate: string;
  reminderTemplateNone: string;
  reminderTemplateHint: string;
  reminderOffsetsDiffer: string;
}

const PT: AgendaCopy = {
  schedule: "Agendar",
  scheduleService: "Agendar serviço",
  appointment: "Agendamento",
  service: "Serviço",
  chooseService: "Escolha o serviço",
  professional: "Profissional",
  anyProfessional: "Qualquer profissional",
  date: "Dia",
  time: "Horário",
  noSlots: "Nenhum horário livre neste período. Tente outro dia ou outro profissional.",
  noServices: "Nenhum serviço cadastrado",
  noServicesHint: "Peça a um administrador para cadastrar serviços e profissionais em Configurações → Serviços e horários.",
  loadingSlots: "Buscando horários…",
  contact: "Cliente",
  notes: "Observações",
  notesPlaceholder: "Opcional",
  confirmNow: "Já confirmado com o cliente",
  book: "Agendar",
  booking: "Agendando…",
  booked: "Agendamento criado",
  moved: "Agendamento remarcado",
  close: "Fechar",
  reschedule: "Remarcar",
  rescheduleConfirm: "Remarcar para este horário",
  status: "Situação",
  statusChanged: "Situação atualizada",
  markAs: { scheduled: "Voltar para agendado", confirmed: "Confirmar", completed: "Marcar como concluído", no_show: "Marcar como faltou", cancelled: "Cancelar agendamento" },
  upcoming: "Próximos agendamentos",
  failed: "Não foi possível concluir",
  pickContact: "Escolha o cliente",
  with: "com",
  settingsTitle: "Serviços e horários",
  settingsDescription: "O que a empresa oferece, quem atende e quando. É a base para agendar pelo CRM e, depois, pela IA no WhatsApp.",
  rules: "Regras de agendamento",
  rulesHint: "Valem para todos os profissionais.",
  minNotice: "Antecedência mínima",
  maxDaysAhead: "Agendar até",
  slotStep: "Intervalo entre horários",
  minutes: "minutos",
  days: "dias à frente",
  save: "Salvar",
  saved: "Salvo",
  services: "Serviços",
  servicesHint: "Consulta, corte, visita técnica… cada um com sua duração.",
  newService: "Novo serviço",
  editService: "Editar serviço",
  name: "Nome",
  duration: "Duração (min)",
  price: "Preço (opcional)",
  bufferBefore: "Folga antes (min)",
  bufferAfter: "Folga depois (min)",
  active: "Ativo",
  inactive: "Inativo",
  professionals: "Profissionais e salas",
  professionalsHint: "Quem atende, quais serviços faz e em quais horários.",
  newProfessional: "Novo profissional",
  editProfessional: "Editar profissional",
  kind: "Tipo",
  kinds: { professional: "Profissional", room: "Sala", other: "Outro" },
  linkedMember: "Membro da equipe (opcional)",
  noMember: "Nenhum",
  offeredServices: "Serviços que realiza",
  weeklyHours: "Horário semanal",
  closed: "Fechado",
  addInterval: "Adicionar intervalo",
  removeInterval: "Remover intervalo",
  start: "Início",
  end: "Fim",
  exceptions: "Exceções",
  exceptionsHint: "Folgas e horários extras em datas específicas.",
  dayOff: "Folga o dia todo",
  extraHours: "Horário extra",
  addException: "Adicionar exceção",
  note: "Observação",
  remove: "Remover",
  deleteConfirm: "Excluir? Quem já tem agendamentos deve ser desativado em vez de excluído.",
  cancel: "Cancelar",
  empty: "Nada cadastrado ainda",
  weekErrors: { invalid_time: "Horário inválido", end_before_start: "O fim precisa ser depois do início", overlap: "Intervalos se sobrepõem" },
  readOnly: "Conta somente leitura: não é possível alterar.",
  resizeBlocked: "A duração vem do serviço. Para mudar o horário, use Remarcar.",
  managedElsewhere: "Este é um agendamento de serviço: horário e situação são alterados pelo painel de agendamento.",
  manage: "Gerenciar agendamento",
  loadFailed: "Não foi possível carregar os serviços e horários.",
  retry: "Tentar de novo",
  prevDay: "Dia anterior",
  nextDay: "Próximo dia",
  nextFreeDay: "Próximo dia com horário",
  noFreeDay: "Sem horários livres nos próximos 30 dias.",
  encaixe: "Encaixe (ignorar antecedência e limite de dias)",
  encaixeHint: "O horário de atendimento e os conflitos continuam valendo.",
  encaixeBadge: "Encaixe",
  customerConfirmed: "Confirmado pelo cliente",
  customerReschedule: "Pediu para remarcar",
  remindersSection: "Lembretes por WhatsApp",
  remindersNone: "Nenhum lembrete para este agendamento.",
  reminderStates: { pending: "Agendado", sending: "Enviando", sent: "Enviado", skipped: "Pulado", failed: "Falhou", cancelled: "Cancelado" },
  reminderReasons: {
    past: "O horário do lembrete já tinha passado quando o agendamento foi feito",
    disabled: "Lembretes desligados",
    appointment_closed: "Agendamento encerrado, cancelado ou já começou",
    no_phone: "Cliente sem telefone",
    opted_out: "Cliente pediu para não receber mensagens",
    anonymized: "Cliente anonimizado (LGPD)",
    no_conversation: "Cliente sem conversa no WhatsApp",
    read_only: "Conta somente leitura",
    window_closed: "Fora da janela de 24 h do WhatsApp e sem modelo aprovado configurado",
    template_unavailable: "Modelo aprovado indisponível ou não sincronizado",
    throttled: "Fila do WhatsApp cheia",
    send_failed: "Falha no envio",
    maybe_sent: "Pode ter sido enviado; confira a conversa",
    rescheduled: "Agendamento remarcado",
    settings_changed: "Configuração dos lembretes alterada",
    whatsapp_disconnected: "WhatsApp desconectado até o horário do lembrete",
    channel_not_configured: "Canal oficial do WhatsApp não configurado",
    daily_limit: "Limite diário de lembretes da conta atingido",
    late: "O lembrete atrasou demais para ainda ser útil",
    reschedule_requested: "Cliente pediu para remarcar",
    customer_confirmed: "Cliente já confirmou",
  },
  reminderSentAt: "enviado",
  reminderAnswered: { confirmed: "Cliente confirmou", reschedule_requested: "Cliente pediu para remarcar" },
  remindersTitle: "Lembretes por WhatsApp",
  remindersHint: "Avisa o cliente antes do horário e deixa ele confirmar ou pedir para remarcar respondendo 1 ou 2. Só vale para agendamentos agendados ou confirmados, de clientes com telefone que não pediram para parar.",
  remindersEnabled: "Enviar lembretes por WhatsApp",
  reminderFirst: "Primeiro lembrete",
  reminderSecond: "Segundo lembrete",
  reminderOff: "Desligado",
  reminderUnits: { minutes: "minutos antes", hours: "horas antes", days: "dias antes" },
  reminderText: "Mensagem",
  reminderTextHint: "Variáveis: {cliente} {servico} {profissional} {data} {hora}",
  reminderTextDefault: "Usar o texto padrão",
  reminderPreview: "Prévia",
  reminderOptionsNote: "A linha com as opções é sempre adicionada ao final.",
  reminderTemplate: "Modelo aprovado (canal oficial)",
  reminderTemplateNone: "Nenhum: pular o lembrete fora da janela de 24 h",
  reminderTemplateHint: "Fora da janela de 24 h, o WhatsApp oficial só aceita modelos aprovados. O corpo do modelo recebe, nesta ordem: {{1}} cliente, {{2}} serviço, {{3}} profissional, {{4}} data, {{5}} hora. O texto do modelo deve avisar o cliente para responder 1 (confirmar) ou 2 (remarcar), ou ter botões de resposta rápida \"Confirmar\" e \"Remarcar\".",
  reminderOffsetsDiffer: "Os dois lembretes precisam ter antecedências diferentes.",
};

const EN: AgendaCopy = {
  schedule: "Schedule",
  scheduleService: "Book a service",
  appointment: "Appointment",
  service: "Service",
  chooseService: "Choose a service",
  professional: "Professional",
  anyProfessional: "Any professional",
  date: "Day",
  time: "Time",
  noSlots: "No free time in this period. Try another day or professional.",
  noServices: "No services yet",
  noServicesHint: "Ask an admin to add services and professionals in Settings → Services and hours.",
  loadingSlots: "Looking for free times…",
  contact: "Customer",
  notes: "Notes",
  notesPlaceholder: "Optional",
  confirmNow: "Already confirmed with the customer",
  book: "Book",
  booking: "Booking…",
  booked: "Appointment booked",
  moved: "Appointment rescheduled",
  close: "Close",
  reschedule: "Reschedule",
  rescheduleConfirm: "Move to this time",
  status: "Status",
  statusChanged: "Status updated",
  markAs: { scheduled: "Back to scheduled", confirmed: "Confirm", completed: "Mark as completed", no_show: "Mark as no-show", cancelled: "Cancel appointment" },
  upcoming: "Upcoming appointments",
  failed: "Could not complete",
  pickContact: "Choose the customer",
  with: "with",
  settingsTitle: "Services and hours",
  settingsDescription: "What the business offers, who serves and when. The base for booking from the CRM and, later, from the AI on WhatsApp.",
  rules: "Booking rules",
  rulesHint: "Apply to every professional.",
  minNotice: "Minimum notice",
  maxDaysAhead: "Book up to",
  slotStep: "Time between slots",
  minutes: "minutes",
  days: "days ahead",
  save: "Save",
  saved: "Saved",
  services: "Services",
  servicesHint: "Consultation, haircut, field visit… each with its own length.",
  newService: "New service",
  editService: "Edit service",
  name: "Name",
  duration: "Duration (min)",
  price: "Price (optional)",
  bufferBefore: "Buffer before (min)",
  bufferAfter: "Buffer after (min)",
  active: "Active",
  inactive: "Inactive",
  professionals: "Professionals and rooms",
  professionalsHint: "Who serves, which services they do and when.",
  newProfessional: "New professional",
  editProfessional: "Edit professional",
  kind: "Type",
  kinds: { professional: "Professional", room: "Room", other: "Other" },
  linkedMember: "Team member (optional)",
  noMember: "None",
  offeredServices: "Services performed",
  weeklyHours: "Weekly hours",
  closed: "Closed",
  addInterval: "Add interval",
  removeInterval: "Remove interval",
  start: "Start",
  end: "End",
  exceptions: "Exceptions",
  exceptionsHint: "Days off and extra hours on specific dates.",
  dayOff: "Day off",
  extraHours: "Extra hours",
  addException: "Add exception",
  note: "Note",
  remove: "Remove",
  deleteConfirm: "Delete? Anything with appointments should be deactivated instead.",
  cancel: "Cancel",
  empty: "Nothing here yet",
  weekErrors: { invalid_time: "Invalid time", end_before_start: "End must be after start", overlap: "Intervals overlap" },
  readOnly: "Read-only account: changes are not possible.",
  resizeBlocked: "The length comes from the service. To change the time, use Reschedule.",
  managedElsewhere: "This is a service appointment: time and status are changed from the booking panel.",
  manage: "Manage appointment",
  loadFailed: "Could not load services and hours.",
  retry: "Try again",
  prevDay: "Previous day",
  nextDay: "Next day",
  nextFreeDay: "Next day with a free time",
  noFreeDay: "No free times in the next 30 days.",
  encaixe: "Walk-in (ignore minimum notice and day limit)",
  encaixeHint: "Working hours and conflicts still apply.",
  encaixeBadge: "Walk-in",
  customerConfirmed: "Confirmed by the customer",
  customerReschedule: "Asked to reschedule",
  remindersSection: "WhatsApp reminders",
  remindersNone: "No reminders for this appointment.",
  reminderStates: { pending: "Scheduled", sending: "Sending", sent: "Sent", skipped: "Skipped", failed: "Failed", cancelled: "Cancelled" },
  reminderReasons: {
    past: "The reminder time had already passed when the appointment was made",
    disabled: "Reminders are off",
    appointment_closed: "Appointment closed, cancelled or already started",
    no_phone: "Customer has no phone number",
    opted_out: "Customer asked not to receive messages",
    anonymized: "Customer anonymized (LGPD)",
    no_conversation: "Customer has no WhatsApp conversation",
    read_only: "Account is read-only",
    window_closed: "Outside the 24 h WhatsApp window and no approved template configured",
    template_unavailable: "Approved template unavailable or not synced",
    throttled: "WhatsApp queue is full",
    send_failed: "Sending failed",
    maybe_sent: "May have been sent; check the conversation",
    rescheduled: "Appointment rescheduled",
    settings_changed: "Reminder settings changed",
    whatsapp_disconnected: "WhatsApp was disconnected until the reminder time",
    channel_not_configured: "Official WhatsApp channel is not configured",
    daily_limit: "The account's daily reminder limit was reached",
    late: "The reminder was too late to still be useful",
    reschedule_requested: "Customer asked to reschedule",
    customer_confirmed: "Customer already confirmed",
  },
  reminderSentAt: "sent",
  reminderAnswered: { confirmed: "Customer confirmed", reschedule_requested: "Customer asked to reschedule" },
  remindersTitle: "WhatsApp reminders",
  remindersHint: "Warns the customer before the appointment and lets them confirm or ask to reschedule by replying 1 or 2. Only for scheduled or confirmed appointments, for customers with a phone who have not opted out.",
  remindersEnabled: "Send WhatsApp reminders",
  reminderFirst: "First reminder",
  reminderSecond: "Second reminder",
  reminderOff: "Off",
  reminderUnits: { minutes: "minutes before", hours: "hours before", days: "days before" },
  reminderText: "Message",
  reminderTextHint: "Variables: {cliente} {servico} {profissional} {data} {hora}",
  reminderTextDefault: "Use the default text",
  reminderPreview: "Preview",
  reminderOptionsNote: "The line with the reply options is always added at the end.",
  reminderTemplate: "Approved template (official channel)",
  reminderTemplateNone: "None: skip the reminder outside the 24 h window",
  reminderTemplateHint: "Outside the 24 h window the official WhatsApp only accepts approved templates. The template body receives, in this order: {{1}} customer, {{2}} service, {{3}} professional, {{4}} date, {{5}} time. The template text must tell the customer to reply 1 (confirm) or 2 (reschedule), or have quick-reply buttons \"Confirmar\" and \"Remarcar\".",
  reminderOffsetsDiffer: "The two reminders need different lead times.",
};

export function agendaCopy(language: Language): AgendaCopy {
  return language === "en-US" ? EN : PT;
}
