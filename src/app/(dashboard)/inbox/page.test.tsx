import { describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"

// Wiring guard for the inbox page: the thread must be able to switch
// conversations (continuity line / "Abrir conversa atual") and the page
// must subscribe to live contact updates (photo filled by the gateway).
// Children are stubbed; only the props / hook calls are inspected.

const h = vi.hoisted(() => ({
  threadProps: null as Record<string, unknown> | null,
  sidebarProps: null as Record<string, unknown> | null,
  contactUpdates: [] as unknown[][],
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ accountId: "acct-1", user: { id: "u-1" } }),
}))
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({ isConnected: true, unsubscribe: vi.fn() }),
}))
vi.mock("@/hooks/use-contact-updates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-contact-updates")>()
  return {
    ...actual,
    useContactUpdates: (...args: unknown[]) => {
      h.contactUpdates.push(args)
    },
  }
})
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/push/client", () => ({ reportConversationFocus: vi.fn() }))
vi.mock("@/components/inbox/conversation-list", () => ({ ConversationList: () => null }))
vi.mock("@/components/inbox/message-thread", () => ({
  MessageThread: (props: Record<string, unknown>) => {
    h.threadProps = props
    return null
  },
}))
vi.mock("@/components/inbox/contact-sidebar", () => ({
  ContactSidebar: (props: Record<string, unknown>) => {
    h.sidebarProps = props
    return null
  },
}))

import InboxPage from "./page"

describe("InboxPage wiring", () => {
  it("passes onOpenConversation to the thread (same handler as the panel)", () => {
    renderToString(<InboxPage />)
    expect(typeof h.threadProps?.onOpenConversation).toBe("function")
    expect(h.threadProps?.onOpenConversation).toBe(h.sidebarProps?.onOpenConversation)
  })

  it("subscribes to live contact updates for the account", () => {
    h.contactUpdates = []
    renderToString(<InboxPage />)
    expect(h.contactUpdates.length).toBeGreaterThan(0)
    const [accountId, handler] = h.contactUpdates[0]
    expect(accountId).toBe("acct-1")
    expect(typeof handler).toBe("function")
  })
})
