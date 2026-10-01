import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { MediaStore, buildQrMediaPath } from "./media.js";

const logger = pino({ level: "silent" });
const ACCOUNT = "11111111-2222-3333-4444-555555555555";

function fakeClient(baseUrl: string) {
  const upload = vi.fn(async () => ({ error: null }));
  const client = {
    storage: {
      from: () => ({
        upload,
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `${baseUrl}/storage/v1/object/public/chat-media/${path}` },
        }),
      }),
    },
  } as unknown as SupabaseClient;
  return { client, upload };
}

async function store(opts: { supabaseUrl: string; supabasePublicUrl?: string }) {
  const { client, upload } = fakeClient(opts.supabaseUrl);
  const media = new MediaStore({
    supabaseUrl: opts.supabaseUrl,
    supabasePublicUrl: opts.supabasePublicUrl,
    serviceRoleKey: "service-role",
    logger,
    client,
    download: async () => Buffer.from("bytes"),
  });
  const res = await media.storeInbound(ACCOUNT, {} as WAMessage, {} as WASocket, {
    mimetype: "image/jpeg",
    filename: "foto.jpg",
  } as never);
  return { res, upload };
}

describe("buildQrMediaPath", () => {
  it("namespaces under account-<id>/qr", () => {
    expect(buildQrMediaPath(ACCOUNT, "foto.jpg", 1700000000000)).toBe(
      `account-${ACCOUNT}/qr/1700000000000-foto.jpg`,
    );
  });
});

describe("MediaStore.storeInbound", () => {
  it("returns the client's public URL when no public base is configured", async () => {
    const { res, upload } = await store({ supabaseUrl: "http://host.docker.internal:56021" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(res.url).toMatch(
      /^http:\/\/host\.docker\.internal:56021\/storage\/v1\/object\/public\/chat-media\/account-/,
    );
  });

  it("swaps the base for an absolute SUPABASE_PUBLIC_URL", async () => {
    const { res } = await store({
      supabaseUrl: "http://host.docker.internal:56021",
      supabasePublicUrl: "http://192.168.1.10:56021/",
    });
    expect(res.url.startsWith("http://192.168.1.10:56021/storage/v1/object/public/chat-media/")).toBe(true);
  });

  it("accepts a PATH as SUPABASE_PUBLIC_URL and yields an origin-relative URL", async () => {
    const { res } = await store({
      supabaseUrl: "http://host.docker.internal:56021",
      supabasePublicUrl: "/supabase",
    });
    expect(res.url.startsWith("/supabase/storage/v1/object/public/chat-media/account-")).toBe(true);
    expect(res.url).toBe(`/supabase/storage/v1/object/public/chat-media/${res.path}`);
  });
});

describe("storageMimeType", () => {
  it("remove os parâmetros do tipo (áudio de voz do WhatsApp)", async () => {
    const { storageMimeType } = await import("./media.js");
    expect(storageMimeType("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(storageMimeType("image/jpeg")).toBe("image/jpeg");
    expect(storageMimeType("")).toBe("application/octet-stream");
  });
});

describe("limites de mídia recebida (DoS de memória)", () => {
  const msgWith = (fileLength: unknown, wrap = false) => {
    const inner = { videoMessage: { fileLength } };
    return { message: wrap ? { viewOnceMessageV2: { message: inner } } : inner } as unknown as WAMessage;
  };

  it("declaredMediaBytes lê fileLength (número, Long, embrulhado)", async () => {
    const { declaredMediaBytes } = await import("./media.js");
    expect(declaredMediaBytes(msgWith(1234))).toBe(1234);
    expect(declaredMediaBytes(msgWith({ toNumber: () => 99 }))).toBe(99);
    expect(declaredMediaBytes(msgWith(500, true))).toBe(500);
    expect(declaredMediaBytes({} as WAMessage)).toBeUndefined();
  });

  it("acima de 16 MB declarados não baixa nem sobe nada", async () => {
    const { MAX_INBOUND_MEDIA_BYTES, MediaTooLargeError } = await import("./media.js");
    const { client, upload } = fakeClient("http://x");
    const download = vi.fn(async () => Buffer.from("x"));
    const media = new MediaStore({ supabaseUrl: "http://x", serviceRoleKey: "k", logger, client, download });
    await expect(
      media.storeInbound(ACCOUNT, msgWith(MAX_INBOUND_MEDIA_BYTES + 1), {} as WASocket, { mimetype: "video/mp4" } as never),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(download).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("readCapped corta o stream que passa do teto (fileLength mentiroso)", async () => {
    const { readCapped, MediaTooLargeError } = await import("./media.js");
    const { Readable } = await import("node:stream");
    let produced = 0;
    const stream = Readable.from(
      (function* () {
        for (let i = 0; i < 1000; i++) {
          produced++;
          yield Buffer.alloc(1024);
        }
      })(),
    );
    await expect(readCapped(stream, 10 * 1024)).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(produced).toBeLessThan(20);
    expect(stream.destroyed).toBe(true);
    expect((await readCapped(Readable.from([Buffer.from("ab"), Buffer.from("c")]), 10)).toString()).toBe("abc");
  });

  it("no máximo N downloads simultâneos; os demais esperam", async () => {
    const { client } = fakeClient("http://x");
    let active = 0;
    let peak = 0;
    const download = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return Buffer.from("x");
    });
    const media = new MediaStore({
      supabaseUrl: "http://x",
      serviceRoleKey: "k",
      logger,
      client,
      download,
      maxConcurrentDownloads: 2,
    });
    await Promise.all(
      Array.from({ length: 7 }, () =>
        media.storeInbound(ACCOUNT, {} as WAMessage, {} as WASocket, { mimetype: "image/jpeg" } as never),
      ),
    );
    expect(download).toHaveBeenCalledTimes(7);
    expect(peak).toBe(2);
  });
});

describe("prazo por download", () => {
  it("download pendurado é abortado e libera a vaga", async () => {
    const { client, upload } = fakeClient("http://x");
    let aborted = false;
    const download = vi.fn(
      (_m: WAMessage, _s: WASocket, signal: AbortSignal) =>
        new Promise<Buffer>(() => {
          signal.addEventListener("abort", () => (aborted = true));
        }),
    );
    const media = new MediaStore({
      supabaseUrl: "http://x",
      serviceRoleKey: "k",
      logger,
      client,
      download,
      maxConcurrentDownloads: 1,
      downloadTimeoutMs: 20,
    });
    const args = [ACCOUNT, {} as WAMessage, {} as WASocket, { mimetype: "image/jpeg" } as never] as const;
    await expect(media.storeInbound(...args)).rejects.toThrow(/prazo/);
    expect(aborted).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    // a vaga foi devolvida: o próximo download entra
    download.mockImplementationOnce(async () => Buffer.from("ok"));
    await expect(media.storeInbound(...args)).resolves.toMatchObject({ path: expect.any(String) });
  });
});
