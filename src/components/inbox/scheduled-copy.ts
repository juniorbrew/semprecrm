import type { Language } from "@/lib/i18n";
import type { PresetKey, ScheduleErrorCode } from "@/lib/scheduled-messages/schedule";

/** Language-keyed copy for "Agendar mensagem" (same approach as COMPOSER_COPY). */
export interface ScheduledCopy {
  schedule: string;
  scheduleTitle: string;
  scheduleNeedsText: string;
  menuTitle: string;
  presets: Record<PresetKey, string>;
  custom: string;
  customHint: string;
  confirm: string;
  scheduling: string;
  scheduled: (when: string) => string;
  errors: Record<ScheduleErrorCode, string>;
  outsideWindow: string;
  panelTitle: (n: number) => string;
  sendsAt: (when: string) => string;
  by: (name: string) => string;
  sending: string;
  failed: string;
  windowRisk: string;
  edit: string;
  save: string;
  cancelEdit: string;
  sendNow: string;
  retry: string;
  cancel: string;
  cancelled: string;
  cancelledRestored: string;
  sentNow: string;
  genericError: string;
  timezoneNote: (tz: string) => string;
  maybeSent: string;
  confirmMaybeSent: string;
  notAuthor: string;
  overviewButton: string;
  overviewTitle: string;
  overviewBadge: (open: number, failed: number) => string;
  overviewEmpty: string;
  filterAll: string;
  filterMine: string;
  openConversation: string;
  unknownContact: string;
  openFailed: string;
}

export const SCHEDULED_COPY: Record<Language, ScheduledCopy> = {
  "pt-BR": {
    schedule: "Agendar",
    scheduleTitle: "Agendar mensagem",
    scheduleNeedsText: "Escreva a mensagem para agendar",
    menuTitle: "Enviar mais tarde",
    presets: {
      today_18: "Hoje às 18h",
      tomorrow_8: "Amanhã às 8h",
      tomorrow_14: "Amanhã às 14h",
      monday_9: "Segunda às 9h",
    },
    custom: "Escolher data e hora",
    customHint: "No seu fuso horário",
    confirm: "Agendar envio",
    scheduling: "Agendando…",
    scheduled: (when) => `Mensagem agendada para ${when}`,
    errors: {
      invalid: "Informe uma data e hora válidas.",
      too_soon: "Escolha um horário pelo menos 1 minuto no futuro.",
      too_far: "Escolha uma data em até 90 dias.",
    },
    outsideWindow:
      "Atenção: nesse horário a janela de 24 h do canal (WhatsApp, Instagram ou Messenger) estará encerrada. Se o cliente não responder antes, o envio falha e você é avisado.",
    panelTitle: (n) => (n === 1 ? "1 mensagem agendada" : `${n} mensagens agendadas`),
    sendsAt: (when) => `Envia ${when}`,
    by: (name) => `por ${name}`,
    sending: "Enviando…",
    failed: "Não enviada",
    windowRisk: "Fora da janela de 24 h nesse horário",
    edit: "Editar",
    save: "Salvar",
    cancelEdit: "Descartar edição",
    sendNow: "Enviar agora",
    retry: "Tentar de novo",
    cancel: "Cancelar envio",
    cancelled: "Agendamento cancelado",
    cancelledRestored: "Agendamento cancelado — o texto voltou para a caixa de mensagem",
    sentNow: "Mensagem enviada",
    genericError: "Não foi possível concluir. Tente de novo.",
    timezoneNote: (tz) => `Horário de ${tz}`,
    maybeSent: "Pode ter sido enviada",
    confirmMaybeSent:
      "Esta mensagem pode já ter sido enviada ao cliente. Confira a conversa antes de continuar. Tentar de novo mesmo assim?",
    notAuthor: "Só quem agendou (ou um administrador) pode alterar",
    overviewButton: "Agendadas",
    overviewTitle: "Mensagens agendadas",
    overviewBadge: (open, failed) =>
      failed > 0 ? `${open} agendadas, ${failed} não enviadas` : `${open} agendadas`,
    overviewEmpty: "Nenhuma mensagem agendada. Use Agendar ao lado do botão Enviar.",
    filterAll: "Todas",
    filterMine: "Minhas",
    openConversation: "Abrir conversa",
    unknownContact: "Contato",
    openFailed: "Não foi possível abrir a conversa. Tente de novo.",
  },
  "en-US": {
    schedule: "Schedule",
    scheduleTitle: "Schedule message",
    scheduleNeedsText: "Write the message to schedule it",
    menuTitle: "Send later",
    presets: {
      today_18: "Today at 6 PM",
      tomorrow_8: "Tomorrow at 8 AM",
      tomorrow_14: "Tomorrow at 2 PM",
      monday_9: "Monday at 9 AM",
    },
    custom: "Pick date and time",
    customHint: "In your time zone",
    confirm: "Schedule send",
    scheduling: "Scheduling…",
    scheduled: (when) => `Message scheduled for ${when}`,
    errors: {
      invalid: "Enter a valid date and time.",
      too_soon: "Pick a time at least 1 minute from now.",
      too_far: "Pick a date within 90 days.",
    },
    outsideWindow:
      "Heads up: at that time the channel's 24-hour window (WhatsApp, Instagram or Messenger) will be closed. If the customer does not reply before then, the send fails and you are notified.",
    panelTitle: (n) => (n === 1 ? "1 scheduled message" : `${n} scheduled messages`),
    sendsAt: (when) => `Sends ${when}`,
    by: (name) => `by ${name}`,
    sending: "Sending…",
    failed: "Not sent",
    windowRisk: "Outside the 24-hour window at that time",
    edit: "Edit",
    save: "Save",
    cancelEdit: "Discard edit",
    sendNow: "Send now",
    retry: "Try again",
    cancel: "Cancel send",
    cancelled: "Schedule cancelled",
    cancelledRestored: "Schedule cancelled — the text is back in the message box",
    sentNow: "Message sent",
    genericError: "Could not finish. Try again.",
    timezoneNote: (tz) => `${tz} time`,
    maybeSent: "May have been sent",
    confirmMaybeSent:
      "This message may already have been sent to the customer. Check the conversation first. Try again anyway?",
    notAuthor: "Only the author (or an admin) can change this",
    overviewButton: "Scheduled",
    overviewTitle: "Scheduled messages",
    overviewBadge: (open, failed) =>
      failed > 0 ? `${open} scheduled, ${failed} not sent` : `${open} scheduled`,
    overviewEmpty: "No scheduled messages. Use Schedule next to the Send button.",
    filterAll: "All",
    filterMine: "Mine",
    openConversation: "Open conversation",
    unknownContact: "Contact",
    openFailed: "Could not open the conversation. Try again.",
  },
};
