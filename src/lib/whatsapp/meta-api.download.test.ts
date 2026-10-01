import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadMedia,
  isAllowedMetaMediaUrl,
  MAX_MEDIA_DOWNLOAD_BYTES,
  mediaProxyHeaders,
  MediaTooLargeError,
} from "./meta-api";

afterEach(() => vi.unstubAllGlobals());

describe("mediaProxyHeaders", () => {
  it.each(["image/jpeg", "image/png", "audio/ogg; codecs=opus", "video/mp4", "audio/amr"])(
    "serves %s inline",
    (ct) => {
      const h = mediaProxyHeaders(ct, "media-1");
      expect(h["Content-Type"]).toBe(ct.split(";")[0]);
      expect(h["Content-Disposition"]).toBeUndefined();
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Content-Security-Policy"]).toBe("sandbox");
    },
  );

  it.each(["text/html", "image/svg+xml", "application/xhtml+xml", "application/pdf", "", null])(
    "forces %s to an attachment",
    (ct) => {
      const h = mediaProxyHeaders(ct, 'media-"><script>');
      expect(h["Content-Type"]).toBe("application/octet-stream");
      expect(h["Content-Disposition"]).toMatch(/^attachment; filename="media-__/);
      expect(h["Content-Disposition"]).not.toMatch(/[<>]/);
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Content-Security-Policy"]).toBe("sandbox");
    },
  );
});

describe("isAllowedMetaMediaUrl", () => {
  it.each([
    "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
    "https://mmg.whatsapp.net/x",
    "https://scontent.xx.fbcdn.net/y",
  ])("accepts %s", (u) => expect(isAllowedMetaMediaUrl(u)).toBe(true));

  it.each([
    "http://lookaside.fbsbx.com/x",
    "https://evil.com/x",
    "https://fbsbx.com.evil.com/x",
    "https://evilfbsbx.com/x",
    "https://user:pw@lookaside.fbsbx.com/x",
    "not a url",
  ])("rejects %s", (u) => expect(isAllowedMetaMediaUrl(u)).toBe(false));
});

describe("downloadMedia", () => {
  it("never sends the token to a non-Meta host", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(
      downloadMedia({ downloadUrl: "https://attacker.example/x", accessToken: "tok" }),
    ).rejects.toThrow(/allowed Meta host/);
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared content-length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("x", {
          headers: { "content-length": String(MAX_MEDIA_DOWNLOAD_BYTES + 1) },
        }),
      ),
    );
    await expect(
      downloadMedia({ downloadUrl: "https://lookaside.fbsbx.com/x", accessToken: "t" }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
  });

  it("aborts a stream that exceeds the cap without a content-length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += chunk.byteLength;
        c.enqueue(chunk);
        if (sent > MAX_MEDIA_DOWNLOAD_BYTES * 2) c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(
      downloadMedia({ downloadUrl: "https://lookaside.fbsbx.com/x", accessToken: "t" }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(sent).toBeLessThan(MAX_MEDIA_DOWNLOAD_BYTES + 5 * chunk.byteLength);
  });

  it("returns the bytes for a normal download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("abc", { headers: { "content-type": "image/png" } })),
    );
    const r = await downloadMedia({ downloadUrl: "https://lookaside.fbsbx.com/x", accessToken: "t" });
    expect(r.buffer.toString()).toBe("abc");
    expect(r.contentType).toBe("image/png");
  });
});
