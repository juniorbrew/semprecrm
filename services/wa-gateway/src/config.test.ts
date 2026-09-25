import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const BASE = {
  WA_GATEWAY_SECRET: "0123456789abcdef0123",
  APP_URL: "http://app.local",
  SUPABASE_URL: "http://sb.local",
  SUPABASE_SERVICE_ROLE_KEY: "key",
};

describe("loadConfig — WA_MARK_ONLINE", () => {
  it("fica online por padrão", () => {
    expect(loadConfig(BASE).markOnline).toBe(true);
    expect(loadConfig({ ...BASE, WA_MARK_ONLINE: "true" }).markOnline).toBe(true);
  });

  it.each(["false", "0", "no", "off", "FALSE"])("desliga com %s", (v) => {
    expect(loadConfig({ ...BASE, WA_MARK_ONLINE: v }).markOnline).toBe(false);
  });
});
