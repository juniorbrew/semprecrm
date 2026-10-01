import { afterEach, describe, expect, it, vi } from "vitest";
import { contactPanelKey, readContactPanelOpen, writeContactPanelOpen } from "./use-contact-panel-open";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("contact panel visibility", () => {
  it("defaults to shown and remembers the choice per user", () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    expect(readContactPanelOpen("ana")).toBe(true);
    writeContactPanelOpen("ana", false);
    expect(storage.map.get(contactPanelKey("ana"))).toBe("false");
    expect(readContactPanelOpen("ana")).toBe(false);
    expect(readContactPanelOpen("bia")).toBe(true);
  });

  it("falls back to the pre-redesign browser-wide value", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage({ "wacrm:inbox:contact-panel-open": "false" }) });
    expect(readContactPanelOpen("ana")).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("window", { localStorage: { getItem: blocked, setItem: blocked } });
    expect(readContactPanelOpen("ana")).toBe(true);
    expect(() => writeContactPanelOpen("ana", false)).not.toThrow();
  });
});
