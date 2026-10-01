import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const BASE = {
  WA_GATEWAY_SECRET: "0123456789abcdef0123",
  APP_URL: "http://app.local",
  SUPABASE_URL: "http://sb.local",
  SUPABASE_SERVICE_ROLE_KEY: "key",
};

describe("loadConfig — MEDIA_ALLOWED_ORIGINS", () => {
  it("padrão: só as origens do storage (SUPABASE_URL e SUPABASE_PUBLIC_URL absoluta)", () => {
    expect(loadConfig(BASE).mediaPolicy).toEqual({ storageOrigins: ["http://sb.local"], extraOrigins: [] });
    expect(loadConfig({ ...BASE, SUPABASE_PUBLIC_URL: "https://api.x.com/" }).mediaPolicy.storageOrigins).toEqual([
      "http://sb.local",
      "https://api.x.com",
    ]);
    expect(loadConfig({ ...BASE, SUPABASE_PUBLIC_URL: "/supabase" }).mediaPolicy.storageOrigins).toEqual([
      "http://sb.local",
    ]);
  });

  it("lista extra normalizada; entrada inválida falha na subida", () => {
    expect(
      loadConfig({ ...BASE, MEDIA_ALLOWED_ORIGINS: "https://cdn.x.com/path, https://b.y.com:8443" }).mediaPolicy
        .extraOrigins,
    ).toEqual(["https://cdn.x.com", "https://b.y.com:8443"]);
    expect(() => loadConfig({ ...BASE, MEDIA_ALLOWED_ORIGINS: "file:///etc" })).toThrow(/MEDIA_ALLOWED_ORIGINS/);
  });
});

describe("loadConfig — WA_MARK_ONLINE", () => {
  it("fica online por padrão", () => {
    expect(loadConfig(BASE).markOnline).toBe(true);
    expect(loadConfig({ ...BASE, WA_MARK_ONLINE: "true" }).markOnline).toBe(true);
  });

  it.each(["false", "0", "no", "off", "FALSE"])("desliga com %s", (v) => {
    expect(loadConfig({ ...BASE, WA_MARK_ONLINE: v }).markOnline).toBe(false);
  });
});

describe("loadConfig — GATEWAY_BIND", () => {
  it("escuta só em loopback por padrão", () => {
    expect(loadConfig(BASE).bind).toBe("127.0.0.1");
    expect(loadConfig({ ...BASE, GATEWAY_BIND: " " }).bind).toBe("127.0.0.1");
  });

  it("aceita outro endereço explícito (Docker)", () => {
    expect(loadConfig({ ...BASE, GATEWAY_BIND: "0.0.0.0" }).bind).toBe("0.0.0.0");
  });
});
