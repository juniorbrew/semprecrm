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
};

export function agendaCopy(language: Language): AgendaCopy {
  return language === "en-US" ? EN : PT;
}
