// ============================================================
// Event links — label and URL of each record an event points at.
// Pure; the drawer, the chips and the push payload all read from
// here so a deep link never drifts between surfaces.
// ============================================================

import type { CalendarEvent } from '@/types';

import { EVENT_LINK_KINDS, type EventLinkKind } from './types';

export interface EventLink {
  kind: EventLinkKind;
  id: string;
  /** Display label (contact name, deal title, …) or the kind's English label. */
  label: string;
  /** Route the app understands (each target page reads the query). */
  href: string;
}

/** English labels per kind — go through `t()`. */
export const EVENT_LINK_LABELS: Record<EventLinkKind, string> = {
  contact: 'Contact',
  conversation: 'Conversation',
  deal: 'Deal',
  task: 'Task',
  chat_thread: 'Internal chat',
};

export function linkHref(kind: EventLinkKind, id: string): string {
  const q = encodeURIComponent(id);
  switch (kind) {
    case 'contact':
      return `/contacts?contact=${q}`;
    case 'conversation':
      return `/inbox?c=${q}`;
    case 'deal':
      return `/pipelines?deal=${q}`;
    case 'task':
      return `/tasks?task=${q}`;
    case 'chat_thread':
      return `/chat?t=${q}`;
  }
}

/** Deep link to the event itself on /agenda. */
export function eventHref(eventId: string): string {
  return `/agenda?event=${encodeURIComponent(eventId)}`;
}

type Linkable = Pick<
  CalendarEvent,
  'contact_id' | 'conversation_id' | 'deal_id' | 'task_id' | 'chat_thread_id'
> &
  Partial<Pick<CalendarEvent, 'contact' | 'deal' | 'task' | 'chat_thread'>>;

/** Label of one link, given the embeds the event carries. */
export function linkLabel(event: Linkable, kind: EventLinkKind): string {
  switch (kind) {
    case 'contact':
      return event.contact?.name?.trim() || event.contact?.phone || EVENT_LINK_LABELS.contact;
    case 'conversation':
      return event.contact?.name?.trim()
        ? `${EVENT_LINK_LABELS.conversation} · ${event.contact.name.trim()}`
        : EVENT_LINK_LABELS.conversation;
    case 'deal':
      return event.deal?.title?.trim() || EVENT_LINK_LABELS.deal;
    case 'task':
      return event.task?.title?.trim() || EVENT_LINK_LABELS.task;
    case 'chat_thread': {
      const t = event.chat_thread;
      if (t?.kind === 'group' && t.title?.trim()) return t.title.trim();
      return EVENT_LINK_LABELS.chat_thread;
    }
  }
}

/** Every link the event carries, in display order. */
export function eventLinks(event: Linkable): EventLink[] {
  const out: EventLink[] = [];
  for (const kind of EVENT_LINK_KINDS) {
    const id = linkId(event, kind);
    if (!id) continue;
    out.push({ kind, id, label: linkLabel(event, kind), href: linkHref(kind, id) });
  }
  return out;
}

export function linkId(event: Linkable, kind: EventLinkKind): string | null {
  switch (kind) {
    case 'contact':
      return event.contact_id;
    case 'conversation':
      return event.conversation_id;
    case 'deal':
      return event.deal_id;
    case 'task':
      return event.task_id;
    case 'chat_thread':
      return event.chat_thread_id;
  }
}

/** First non-empty line of a chat message, capped, as an event title seed. */
export function titleFromMessage(body: string, max = 80): string {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
