import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import type { Contact, ContactNote, Conversation, Message } from "@/types";
import { MessageBubble, bubbleFrameClass, FRESH_ITEM_CLASS } from "./message-bubble";
import { InternalNoteBubble } from "./internal-note-bubble";
import { SystemEventPill } from "./system-event-pill";
import { PendingSuggestionStrip } from "./suggest-reply-button";
import { PanelSituation } from "./panel-situation";
import { PanelHistory, PanelPreviousConversations } from "./panel-history";
import { ContactSidebar } from "./contact-sidebar";

// Inbox redesign stage 3: bubble variants, event separators, the pending
// suggestion strip and the new contact-panel sections.

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    throw new Error("createClient must only be called from effects/handlers");
  },
}));

const msg = (extra: Partial<Message>): Message =>
  ({
    id: "m-1",
    conversation_id: "conv-1",
    sender_type: "customer",
    content_type: "text",
    content_text: "Olá!",
    status: "read",
    created_at: "2026-09-28T12:00:00.000Z",
    ...extra,
  }) as Message;

const conversation: Conversation = {
  id: "conv-1",
  user_id: "u-1",
  contact_id: "c-1",
  status: "open",
  unread_count: 0,
  priority: "high",
  created_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-27T00:00:00Z",
};

describe("bubble variants", () => {
  it("outgoing: primary fill, small corner bottom-right; incoming: card + border, small corner bottom-left", () => {
    expect(bubbleFrameClass("out")).toMatch(/bg-primary .*text-primary-foreground/);
    expect(bubbleFrameClass("out")).toContain("rounded-br-[4px]");
    expect(bubbleFrameClass("out")).toContain("rounded-[calc(var(--radius)+2px)]");
    expect(bubbleFrameClass("in")).toContain("bg-card");
    expect(bubbleFrameClass("in")).toContain("border border-border");
    expect(bubbleFrameClass("in")).toContain("rounded-bl-[4px]");
  });

  it("renders the direction and only animates fresh messages (reduced motion off)", () => {
    const incoming = renderToString(<MessageBubble message={msg({})} />);
    expect(incoming).toContain('data-bubble="in"');
    expect(incoming).not.toContain("data-fresh");
    const outgoing = renderToString(<MessageBubble message={msg({ sender_type: "agent" })} fresh />);
    expect(outgoing).toContain('data-bubble="out"');
    expect(outgoing).toContain("data-fresh");
    expect(FRESH_ITEM_CLASS).toContain("motion-reduce:animate-none");
    expect(FRESH_ITEM_CLASS).toContain("duration-250");
  });

  it("delivery ticks inherit the bubble colour (no colour class of their own)", () => {
    const html = renderToString(<MessageBubble message={msg({ sender_type: "agent", status: "delivered" })} />);
    const tick = html.slice(html.indexOf('aria-label="Delivered"'));
    expect(tick.slice(0, tick.indexOf("</span>"))).not.toMatch(/text-(primary|muted|foreground)/);
  });

  it("internal note: centred, amber tint with a thin border, no dashed line", () => {
    const note = { id: "n1", contact_id: "c-1", user_id: "u", note_text: "Conferir boleto", created_at: "2026-09-28T12:00:00Z" } as ContactNote;
    const html = renderToString(<InternalNoteBubble note={note} authorName="Ana" label="Nota interna" hint="Só a equipe" />);
    expect(html).toContain('data-bubble="note"');
    expect(html).toContain("justify-center");
    expect(html).toContain("border-amber-500/40");
    expect(html).not.toContain("border-dashed");
  });
});

describe("system event separator", () => {
  it("is a centred line with a hairline rule on each side", () => {
    const html = renderToString(
      <SystemEventPill
        language="pt-BR"
        now={Date.parse("2026-09-28T12:00:00Z")}
        event={{
          id: "e1",
          conversation_id: "conv-1",
          type: "assigned",
          created_at: "2026-09-28T11:00:00Z",
          actor_name: "Júnior",
          assignee_name: "Bia",
        }}
      />,
    );
    expect(html).toContain('data-testid="system-event"');
    expect(html.match(/h-px w-7 shrink-0 bg-border/g)).toHaveLength(2);
    expect(html).toContain("Bia");
  });
});

describe("PendingSuggestionStrip", () => {
  it("is one dashed line with Usar, Adicionar ao final and a labelled discard — no AI icon", () => {
    const html = renderToString(
      <PendingSuggestionStrip
        text={"Claro!\nSegue o link."}
        labels={{ prefix: "Sugestão:", hint: "Sugestão pronta", use: "Usar", append: "Adicionar ao final", discard: "Descartar" }}
        onUse={() => {}}
        onAppend={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(html).toContain("border-dashed");
    expect(html).toContain("Claro! Segue o link.");
    expect(html).toContain(">Usar<");
    expect(html).toContain('aria-label="Descartar"');
    expect(html).not.toContain("lucide-sparkles");
  });
});

describe("contact panel sections", () => {
  it("Situação lists state, priority, owner and team, status as dot + text", () => {
    const html = renderToString(
      <PanelSituation conversation={{ ...conversation, assigned_agent_id: "u-2" }} ownerName="Bia" teamName="Financeiro" />,
    );
    for (const text of ["Situação", "Aberta", "Alta", "Bia", "Financeiro"]) expect(html).toContain(text);
    expect(html).not.toContain('data-testid="panel-sla"');
  });

  it("Situação shows the SLA with a progress bar when a target is running", () => {
    const due = new Date(Date.now() + 30 * 60_000).toISOString();
    const warn = new Date(Date.now() + 18 * 60_000).toISOString();
    const html = renderToString(
      <PanelSituation conversation={{ ...conversation, first_response_due_at: due, first_response_warn_at: warn }} />,
    );
    expect(html).toContain('data-testid="panel-sla"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("Prazo de resposta");
    expect(html).toContain("Sem responsável");
  });

  it("Conversas anteriores: title, date · state · CSAT, each a labelled button", () => {
    const html = renderToString(
      <PanelPreviousConversations
        loaded
        onOpen={() => {}}
        rows={[
          { id: "p1", at: "2026-08-28T10:00:00Z", title: "Boleto de agosto", status: "closed", csat: 5, conversation },
        ]}
      />,
    );
    expect(html).toContain("Boleto de agosto");
    expect(html).toContain("Resolvida · nota 5");
    expect(html).toContain('aria-label="Abrir conversa: Boleto de agosto"');
    expect(renderToString(<PanelPreviousConversations loaded rows={[]} />)).toContain("Primeira conversa com este contato");
  });

  it("Histórico shows count, average CSAT (pt-BR decimal) and customer since", () => {
    const html = renderToString(
      <PanelHistory loaded summary={{ count: 7, csatAverage: 4.8, since: "2025-03-10T12:00:00Z" }} />,
    );
    expect(html).toContain("Conversas");
    expect(html).toContain(">7<");
    expect(html).toContain("4,8");
    expect(html).toContain("2025");
  });

  it("the sidebar renders Situação only for the contact's own open thread, and uppercase section headings", () => {
    const contact: Contact = {
      id: "c-1",
      user_id: "u-1",
      account_id: "a-1",
      phone: "5511988887777",
      name: "Maria Souza",
      created_at: "2026-09-27T00:00:00Z",
      updated_at: "2026-09-27T00:00:00Z",
    };
    const html = renderToString(<ContactSidebar contact={contact} conversationId="conv-1" conversation={conversation} />);
    expect(html).toContain('data-testid="panel-situation"');
    expect(html).toContain('data-testid="panel-previous"');
    expect(html).toContain('data-testid="panel-history"');
    expect(html).toContain("uppercase");
    const other = renderToString(
      <ContactSidebar contact={contact} conversationId="x" conversation={{ ...conversation, contact_id: "someone-else" }} />,
    );
    expect(other).not.toContain('data-testid="panel-situation"');
  });
});
