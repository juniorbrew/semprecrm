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
