import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import type { AiStatus } from "@/hooks/use-ai-status";
import { SuggestReplyButton, suggestReplyBlock } from "./suggest-reply-button";

const ON: AiStatus = { available: true, reason: null };

describe("suggestReplyBlock", () => {
  const base = { status: ON, contactAnonymized: false, sessionExpired: false, readOnly: false };

  it("is usable when AI is on and the thread is open", () => {
    expect(suggestReplyBlock(base)).toBeNull();
  });

  it("blocks anonymized contacts first, then read-only, then the closed 24h window", () => {
    expect(suggestReplyBlock({ ...base, contactAnonymized: true, readOnly: true, sessionExpired: true })).toBe("anonymized");
    expect(suggestReplyBlock({ ...base, readOnly: true, sessionExpired: true })).toBe("read_only");
    expect(suggestReplyBlock({ ...base, sessionExpired: true })).toBe("expired");
  });

  it("reflects the account status", () => {
    expect(suggestReplyBlock({ ...base, status: null })).toBe("checking");
    expect(suggestReplyBlock({ ...base, status: { available: false, reason: "module" } })).toBe("module");
    expect(suggestReplyBlock({ ...base, status: { available: false, reason: "disabled" } })).toBe("disabled");
    expect(suggestReplyBlock({ ...base, status: { available: false, reason: "no_key" } })).toBe("no_key");
    expect(suggestReplyBlock({ ...base, status: { available: false, reason: null } })).toBe("disabled");
  });
});

const labels = {
  suggest: "Sugerir resposta",
  cancel: "Cancelar sugestão",
  blocked: {
    anonymized: "anon",
    read_only: "ro",
    expired: "Janela de 24 h encerrada",
    checking: "checking",
    module: "module",
    disabled: "Ative em Configurações → Inteligência Artificial",
    no_key: "no key",
  },
};

function tag(html: string) {
  const start = html.indexOf("<button");
  return html.slice(start, html.indexOf(">", start) + 1);
}

describe("SuggestReplyButton", () => {
  it("enabled state", () => {
    const html = tag(renderToString(<SuggestReplyButton loading={false} block={null} labels={labels} onSuggest={() => {}} onCancel={() => {}} />));
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('title="Sugerir resposta"');
  });

  it("is a plain action, not a sparkle button", () => {
    const html = renderToString(<SuggestReplyButton loading={false} block={null} labels={labels} onSuggest={() => {}} onCancel={() => {}} />);
    expect(html).not.toContain("lucide-sparkles");
  });

  it("disabled with the reason as tooltip", () => {
    const html = tag(renderToString(<SuggestReplyButton loading={false} block="disabled" labels={labels} onSuggest={() => {}} onCancel={() => {}} />));
    expect(html).toContain('disabled=""');
    expect(html).toContain("Configurações → Inteligência Artificial");
  });

  it("loading turns into a cancel control (never disabled)", () => {
    const html = tag(renderToString(<SuggestReplyButton loading block={null} labels={labels} onSuggest={() => {}} onCancel={() => {}} />));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('title="Cancelar sugestão"');
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });
});

// ---- inside the real composer --------------------------------------
const ai = vi.hoisted(() => ({ status: null as AiStatus | null }));
vi.mock("@/hooks/use-ai-status", () => ({
  useAiStatus: () => ai.status,
  invalidateAiStatus: () => {},
}));
vi.mock("@/hooks/use-can", () => ({ useCan: () => true }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () =>
    new Proxy(
      {},
      {
        get: (_t, key) => () => {
          throw new Error(`supabase.${String(key)} called during render`);
        },
      },
    ),
}));

import { MessageComposer } from "./message-composer";

function composer(props: { sessionExpired?: boolean; contactAnonymized?: boolean }) {
  const html = renderToString(
    <MessageComposer
      conversationId="conv-1"
      sessionExpired={props.sessionExpired ?? false}
      contactAnonymized={props.contactAnonymized ?? false}
      onSend={() => {}}
      onSendMedia={() => {}}
      onOpenTemplates={() => {}}
    />,
  );
  const at = html.indexOf('data-testid="suggest-reply"');
  if (at < 0) return "";
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

describe("MessageComposer — Sugerir resposta", () => {
  it("is enabled when the account has AI on", () => {
    ai.status = ON;
    const btn = composer({});
    expect(btn).toContain("Sugerir resposta");
    expect(btn).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("is disabled with a hint when AI is off for the account", () => {
    ai.status = { available: false, reason: "disabled" };
    const btn = composer({});
    expect(btn).toMatch(/\sdisabled(=|\s|>)/);
    expect(btn).toContain("Configurações → Inteligência Artificial");
  });

  it("is disabled when the 24h window is closed (templates only)", () => {
    ai.status = ON;
    const btn = composer({ sessionExpired: true });
    expect(btn).toMatch(/\sdisabled(=|\s|>)/);
    expect(btn).toContain("Janela de 24 h encerrada");
  });

  it("is disabled for anonymized contacts", () => {
    ai.status = ON;
    const btn = composer({ contactAnonymized: true });
    expect(btn).toMatch(/\sdisabled(=|\s|>)/);
    expect(btn).toContain("anonimizado");
  });
});
