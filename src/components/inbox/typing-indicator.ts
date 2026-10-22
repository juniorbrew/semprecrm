"use client";

import { useEffect, useRef } from "react";

export type TypingState = "composing" | "paused";

/** Re-send "composing" at most this often while the agent keeps typing. */
export const TYPING_REFRESH_MS = 8_000;
/** No keystroke for this long → "paused". */
export const TYPING_IDLE_MS = 5_000;

/**
 * Turns keystrokes into a sparse stream of composing/paused pings:
 * one "composing" per refresh window, one "paused" after the agent
 * stops (idle, cleared box, thread switch). Framework-free so it can
 * be tested with fake timers.
 */
export class TypingPinger {
  private lastComposingAt = -Infinity;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (state: TypingState) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Call on every change of the reply text. */
  input(text: string): void {
    if (!text.trim()) {
      this.stop();
      return;
    }
    const t = this.now();
    if (t - this.lastComposingAt >= TYPING_REFRESH_MS) {
      this.lastComposingAt = t;
      this.send("composing");
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), TYPING_IDLE_MS);
  }

  /** Sends "paused" only when a "composing" is still showing. */
  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.lastComposingAt === -Infinity) return;
    this.lastComposingAt = -Infinity;
    this.send("paused");
  }
}

/**
 * "digitando..." on the customer's phone while the agent types a reply
 * (QR channel — `/api/whatsapp/typing` skips official threads anyway).
 * Fire-and-forget: a failed ping never bothers the agent.
 */
export function useTypingIndicator(conversationId: string, text: string, enabled: boolean): void {
  const pingerRef = useRef<TypingPinger | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const pinger = new TypingPinger((state) => {
      void fetch("/api/whatsapp/typing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, state }),
        keepalive: true,
      }).catch(() => {});
    });
    pingerRef.current = pinger;
    return () => {
      pinger.stop();
      pingerRef.current = null;
    };
  }, [conversationId, enabled]);

  useEffect(() => {
    pingerRef.current?.input(text);
  }, [text]);
}
