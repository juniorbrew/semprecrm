import { Boom } from "@hapi/boom";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AvatarThrottle,
  ThrottledError,
  downloadAvatar,
  fetchProfilePictureUrl,
  isAllowedAvatarUrl,
  isNoPictureError,
} from "./avatar.js";
import { MediaStore, buildAvatarPath } from "./media.js";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const CONTACT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("AvatarThrottle", () => {
  it("runs tasks of one account in order, spaced by the minimum interval", async () => {
    let clock = 1_000;
    const sleeps: number[] = [];
    const throttle = new AvatarThrottle({
      minIntervalMs: 4_000,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const started: [string, number][] = [];
    const task = (name: string) => async () => {
      started.push([name, clock]);
      clock += 500; // the lookup itself takes a while
      return name;
    };
    const results = await Promise.all([
      throttle.run(ACCOUNT, task("a")),
      throttle.run(ACCOUNT, task("b")),
      throttle.run(ACCOUNT, task("c")),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(started).toEqual([
      ["a", 1_000],
      ["b", 5_000],
      ["c", 9_000],
    ]);
    // Waits only the remainder of the interval (the task already took 500 ms).
    expect(sleeps).toEqual([3_500, 3_500]);
    expect(throttle.pending(ACCOUNT)).toBe(0);
  });

  it("spaces sequential, non-overlapping lookups of one account (regression)", async () => {
    let clock = 10_000;
    const sleeps: number[] = [];
    const throttle = new AvatarThrottle({
      minIntervalMs: 4_000,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const starts: number[] = [];
    const lookup = async () => {
      starts.push(clock);
      clock += 100;
    };
    // Each request waits for the previous one to finish (the queue drains
    // in between) — the spacing must still hold.
    await throttle.run(ACCOUNT, lookup);
    expect(throttle.pending(ACCOUNT)).toBe(0);
    clock += 500;
    await throttle.run(ACCOUNT, lookup);
    clock += 10_000;
    await throttle.run(ACCOUNT, lookup);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(4_000);
    // After a long pause no extra wait is added.
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(4_000);
    expect(sleeps).toEqual([3_400]);
  });

  it("gives up (ThrottledError) when the turn would come after maxWaitMs", async () => {
    let clock = 0;
    const throttle = new AvatarThrottle({
      minIntervalMs: 10_000,
      maxWaitMs: 15_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const task = vi.fn(async () => "ok");
    const results = await Promise.allSettled([
      throttle.run(ACCOUNT, task), // t=0
      throttle.run(ACCOUNT, task), // t=10s  (waited 10s ≤ 15s)
      throttle.run(ACCOUNT, task), // t=20s  (would wait 20s > 15s) → throttled
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((results[2] as PromiseRejectedResult).reason).toBeInstanceOf(ThrottledError);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("keeps accounts independent", async () => {
    const sleep = vi.fn(async () => undefined);
    const throttle = new AvatarThrottle({ minIntervalMs: 4_000, now: () => 0, sleep });
    await Promise.all([throttle.run("acc-a", async () => 1), throttle.run("acc-b", async () => 2)]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects with ThrottledError when the account's queue is full", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const throttle = new AvatarThrottle({ minIntervalMs: 0, maxPending: 2 });
    const first = throttle.run(ACCOUNT, () => gate.then(() => "first"));
    const second = throttle.run(ACCOUNT, async () => "second");
    await expect(throttle.run(ACCOUNT, async () => "third")).rejects.toBeInstanceOf(ThrottledError);
    release();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    // Room again once the queue drained.
    await expect(throttle.run(ACCOUNT, async () => "later")).resolves.toBe("later");
  });

  it("a failing task does not block the next one", async () => {
    const throttle = new AvatarThrottle({ minIntervalMs: 0 });
    const failing = throttle.run(ACCOUNT, async () => {
      throw new Error("boom");
    });
    const next = throttle.run(ACCOUNT, async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});

describe("fetchProfilePictureUrl", () => {
  it("asks for the full-size image", async () => {
    const sock = { profilePictureUrl: vi.fn(async () => "https://pps.whatsapp.net/v/x.jpg?oe=1") };
    await expect(fetchProfilePictureUrl(sock, "5511@s.whatsapp.net", 5_000)).resolves.toBe(
      "https://pps.whatsapp.net/v/x.jpg?oe=1",
    );
    expect(sock.profilePictureUrl).toHaveBeenCalledWith("5511@s.whatsapp.net", "image", 5_000);
  });

  it("maps privacy / no-photo errors to null", async () => {
    for (const err of [
      new Boom("not-authorized", { statusCode: 401 }),
      new Boom("item-not-found", { statusCode: 404 }),
      new Error("item-not-found"),
    ]) {
      const sock = { profilePictureUrl: vi.fn(async () => Promise.reject(err)) };
      await expect(fetchProfilePictureUrl(sock, "j")).resolves.toBeNull();
    }
    const empty = { profilePictureUrl: vi.fn(async () => undefined) };
    await expect(fetchProfilePictureUrl(empty, "j")).resolves.toBeNull();
  });

  it("rethrows everything else (timeouts, dropped socket)", async () => {
    const sock = { profilePictureUrl: vi.fn(async () => Promise.reject(new Boom("Timed Out", { statusCode: 408 }))) };
    await expect(fetchProfilePictureUrl(sock, "j")).rejects.toThrow("Timed Out");
    expect(isNoPictureError(new Error("connection closed"))).toBe(false);
  });
});

describe("downloadAvatar", () => {
  const CDN = "https://pps.whatsapp.net/v/t61/x.jpg?oh=1&oe=2";
  const response = (body: BodyInit | null, headers: Record<string, string>, status = 200) =>
    new Response(body, { status, headers });

  it("returns the bytes and content type, without following redirects", async () => {
    const fetchImpl = vi.fn(async (_u: string, _i?: RequestInit) =>
      response(new Uint8Array([1, 2, 3]), { "content-type": "image/jpeg" }),
    );
    const out = await downloadAvatar(CDN, { fetchImpl: fetchImpl as never });
    expect(out.contentType).toBe("image/jpeg");
    expect([...out.buffer]).toEqual([1, 2, 3]);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("only allows https on WhatsApp / Facebook CDN hosts", () => {
    expect(isAllowedAvatarUrl(CDN)).toBe(true);
    expect(isAllowedAvatarUrl("https://scontent.xx.fbcdn.net/v/p.jpg")).toBe(true);
    expect(isAllowedAvatarUrl("http://pps.whatsapp.net/x.jpg")).toBe(false);
    expect(isAllowedAvatarUrl("https://evil.example/x.jpg")).toBe(false);
    expect(isAllowedAvatarUrl("https://whatsapp.net.evil.example/x.jpg")).toBe(false);
    expect(isAllowedAvatarUrl("https://evilwhatsapp.net/x.jpg")).toBe(false);
    expect(isAllowedAvatarUrl("https://169.254.169.254/latest")).toBe(false);
    expect(isAllowedAvatarUrl("https://u:p@pps.whatsapp.net/x.jpg")).toBe(false);
    expect(isAllowedAvatarUrl("https://pps.whatsapp.net:8443/x.jpg")).toBe(false);
    expect(isAllowedAvatarUrl("not a url")).toBe(false);
  });

  it("refuses other hosts before fetching, redirects, non-images, oversize and HTTP errors", async () => {
    const ok = vi.fn(async () => response(new Uint8Array([1]), { "content-type": "image/jpeg" }));
    await expect(downloadAvatar("https://evil.example/x.jpg", { fetchImpl: ok as never })).rejects.toThrow(/inesperada/);
    expect(ok).not.toHaveBeenCalled();
    const redirect = vi.fn(async () => response(null, { location: "http://127.0.0.1/" }, 302));
    await expect(downloadAvatar(CDN, { fetchImpl: redirect as never })).rejects.toThrow(/redirecionamento/);
    const html = vi.fn(async () => response(new Uint8Array([1]), { "content-type": "text/html" }));
    await expect(downloadAvatar(CDN, { fetchImpl: html as never })).rejects.toThrow(/tipo/);
    const big = vi.fn(async () => response(new Uint8Array(20), { "content-type": "image/png" }));
    await expect(downloadAvatar(CDN, { fetchImpl: big as never, maxBytes: 10 })).rejects.toThrow(/limite/);
    const gone = vi.fn(async () => response(new Uint8Array(), { "content-type": "image/jpeg" }, 403));
    await expect(downloadAvatar(CDN, { fetchImpl: gone as never })).rejects.toThrow(/403/);
  });

  it("caps the size while streaming, even without content-length", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) return controller.close();
        controller.enqueue(new Uint8Array(4));
      },
    });
    const fetchImpl = vi.fn(async () => response(stream, { "content-type": "image/jpeg" }));
    await expect(downloadAvatar(CDN, { fetchImpl: fetchImpl as never, maxBytes: 10 })).rejects.toThrow(/limite/);
    // Stopped right after crossing the cap instead of reading everything.
    expect(pulled).toBeLessThan(10);
  });
});

describe("MediaStore avatars", () => {
  function store(publicUrl?: string) {
    const upload = vi.fn(async () => ({ error: null }));
    const remove = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({
      upload,
      remove,
      getPublicUrl: (path: string) => ({
        data: { publicUrl: `http://kong:8000/storage/v1/object/public/contact-avatars/${path}` },
      }),
    }));
    const media = new MediaStore({
      supabaseUrl: "http://kong:8000",
      supabasePublicUrl: publicUrl,
      serviceRoleKey: "k",
      logger: pino({ level: "silent" }),
      client: { storage: { from } } as unknown as SupabaseClient,
    });
    return { media, upload, remove, from };
  }

  it("names the file by account and contact id (never the phone)", () => {
    expect(buildAvatarPath(ACCOUNT, CONTACT.toUpperCase())).toBe(`account-${ACCOUNT}/${CONTACT}`);
    expect(() => buildAvatarPath(ACCOUNT, "5511999999999")).toThrow();
    expect(() => buildAvatarPath("../x", CONTACT)).toThrow();
  });

  it("overwrites the contact's file in contact-avatars and cache-busts the URL", async () => {
    const { media, upload, from } = store("/supabase");
    const out = await media.storeAvatar(ACCOUNT, CONTACT, Buffer.from("img"), "image/jpeg", 1_700_000_000_000);
    expect(from).toHaveBeenCalledWith("contact-avatars");
    expect(upload).toHaveBeenCalledWith(
      `account-${ACCOUNT}/${CONTACT}`,
      expect.any(Buffer),
      expect.objectContaining({ upsert: true, contentType: "image/jpeg" }),
    );
    expect(out.url).toBe(
      `/supabase/storage/v1/object/public/contact-avatars/account-${ACCOUNT}/${CONTACT}?v=1700000000000`,
    );
  });

  it("removes the stored photo", async () => {
    const { media, remove } = store();
    await media.removeAvatar(ACCOUNT, CONTACT);
    expect(remove).toHaveBeenCalledWith([`account-${ACCOUNT}/${CONTACT}`]);
  });
});
