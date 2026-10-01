import { describe, expect, it, vi } from "vitest";

import {
  MediaUrlRejected,
  checkMediaUrl,
  downloadOutboundMedia,
  isPrivateOrReservedIp,
  type MediaPolicy,
} from "./outbound-media.js";

const POLICY: MediaPolicy = {
  storageOrigins: ["http://host.docker.internal:56021", "https://api.semprecrm.com.br"],
  extraOrigins: ["https://cdn.exemplo.com"],
};
const STORAGE = "http://host.docker.internal:56021/storage/v1/object/public/chat-media/account-a/x.jpg";
const publicLookup = vi.fn(async () => ["93.184.216.34"]);

function res(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
}

describe("checkMediaUrl", () => {
  it.each([
    "./.env",
    "//etc/passwd",
    "/etc/passwd",
    "data/session/creds.json",
    "file:///etc/passwd",
    "data:text/plain;base64,QUJD",
    "ftp://host.docker.internal:56021/x",
    "https://evil.example/x.jpg",
    "http://127.0.0.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "https://api.semprecrm.com.br:8443/x",
    "http://api.semprecrm.com.br/x", // http numa origem https
    "https://api.semprecrm.com.br@evil.example/x",
    "https://user:pw@api.semprecrm.com.br/x",
    "http://host.docker.internal:56021\\..\\x",
    "http://host.docker.internal:56021/x\r\nHost: evil",
  ])("recusa %s", async (url) => {
    await expect(checkMediaUrl(url, POLICY, publicLookup)).rejects.toBeInstanceOf(MediaUrlRejected);
  });

  it("aceita a origem do storage mesmo sendo interna", async () => {
    await expect(checkMediaUrl(STORAGE, POLICY, publicLookup)).resolves.toBeInstanceOf(URL);
  });

  it("origem extra: aceita se resolve público, recusa se resolve interno", async () => {
    await expect(checkMediaUrl("https://cdn.exemplo.com/a.jpg", POLICY, publicLookup)).resolves.toBeInstanceOf(URL);
    await expect(
      checkMediaUrl("https://cdn.exemplo.com/a.jpg", POLICY, async () => ["10.0.0.5"]),
    ).rejects.toBeInstanceOf(MediaUrlRejected);
    await expect(
      checkMediaUrl("https://cdn.exemplo.com/a.jpg", POLICY, async () => ["93.184.216.34", "::1"]),
    ).rejects.toBeInstanceOf(MediaUrlRejected);
  });

  it("IPs reservados nas formas IPv4/IPv6", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "::1", "::ffff:7f00:1", "fe80::1", "fd00::1"]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
  });
});

describe("downloadOutboundMedia", () => {
  it("baixa do storage e devolve Buffer", async () => {
    const fetchImpl = vi.fn(async () => res(200, "IMG", { "content-type": "image/jpeg" }));
    const buf = await downloadOutboundMedia(STORAGE, "image/jpeg", POLICY, { fetchImpl });
    expect(buf.toString()).toBe("IMG");
    expect(fetchImpl).toHaveBeenCalledWith(STORAGE, expect.objectContaining({ redirect: "manual" }));
  });

  it("redirect para origem não permitida → recusa sem segui-lo", async () => {
    const fetchImpl = vi.fn(async () => res(302, "", { location: "http://169.254.169.254/" }));
    await expect(
      downloadOutboundMedia(STORAGE, "image/jpeg", POLICY, { fetchImpl }),
    ).rejects.toBeInstanceOf(MediaUrlRejected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("redirect dentro da lista permitida é seguido; laço infinito para", async () => {
    const ok = vi
      .fn()
      .mockResolvedValueOnce(res(302, "", { location: "https://cdn.exemplo.com/a.jpg" }))
      .mockResolvedValueOnce(res(200, "IMG", { "content-type": "image/jpeg" }));
    await expect(
      downloadOutboundMedia(STORAGE, "image/jpeg", POLICY, { fetchImpl: ok, lookup: publicLookup }),
    ).resolves.toEqual(Buffer.from("IMG"));
    const loop = vi.fn(async () => res(302, "", { location: STORAGE }));
    await expect(downloadOutboundMedia(STORAGE, "image/jpeg", POLICY, { fetchImpl: loop })).rejects.toThrow(
      /redirecionamento/,
    );
  });

  it("teto de tamanho: pelo content-length e durante a leitura", async () => {
    const declared = vi.fn(async () => res(200, "x", { "content-type": "image/jpeg", "content-length": "999" }));
    await expect(
      downloadOutboundMedia(STORAGE, "image/jpeg", POLICY, { fetchImpl: declared, maxBytes: 10 }),
    ).rejects.toThrow(/limite/);
    const big = vi.fn(async () => res(200, "x".repeat(50), { "content-type": "image/jpeg" }));
    await expect(
      downloadOutboundMedia(STORAGE, "image/jpeg", POLICY, { fetchImpl: big, maxBytes: 10 }),
    ).rejects.toThrow(/limite/);
  });

  it("tipo da resposta incompatível, HTTP de erro e corpo vazio → erro", async () => {
    const html = vi.fn(async () => res(200, "<html>", { "content-type": "text/html" }));
    await expect(downloadOutboundMedia(STORAGE, "image/jpeg", POLICY, { fetchImpl: html })).rejects.toThrow(/tipo/);
    const notFound = vi.fn(async () => res(404, "{}"));
    await expect(downloadOutboundMedia(STORAGE, "image/jpeg", POLICY, { fetchImpl: notFound })).rejects.toThrow(/404/);
    const empty = vi.fn(async () => res(200, "", { "content-type": "image/jpeg" }));
    await expect(downloadOutboundMedia(STORAGE, "image/jpeg", POLICY, { fetchImpl: empty })).rejects.toThrow(/vazia/);
  });
});
