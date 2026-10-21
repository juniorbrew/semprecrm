import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TYPING_IDLE_MS, TYPING_REFRESH_MS, TypingPinger, type TypingState } from "./typing-indicator";

describe("TypingPinger", () => {
  let sent: TypingState[];
  let pinger: TypingPinger;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    pinger = new TypingPinger((s) => sent.push(s));
  });
  afterEach(() => vi.useRealTimers());

  it("sends one composing per refresh window while typing", () => {
    // a keystroke every 4 s: never idle, so no "paused" in between
    pinger.input("o");
    vi.advanceTimersByTime(4000);
    pinger.input("ol");
    vi.advanceTimersByTime(TYPING_REFRESH_MS - 4000 - 1);
    pinger.input("olá");
    expect(sent).toEqual(["composing"]);
    vi.advanceTimersByTime(1);
    pinger.input("olá!");
    expect(sent).toEqual(["composing", "composing"]);
  });

  it("sends paused after the agent stops typing", () => {
    pinger.input("oi");
    vi.advanceTimersByTime(TYPING_IDLE_MS);
    expect(sent).toEqual(["composing", "paused"]);
    // next keystroke starts a fresh composing right away
    pinger.input("oi!");
    expect(sent).toEqual(["composing", "paused", "composing"]);
  });

  it("sends paused when the box is cleared (message sent), once", () => {
    pinger.input("oi");
    pinger.input("");
    vi.advanceTimersByTime(TYPING_IDLE_MS * 2);
    expect(sent).toEqual(["composing", "paused"]);
  });

  it("never sends paused without a composing showing", () => {
    pinger.input("");
    pinger.stop();
    expect(sent).toEqual([]);
  });
});
