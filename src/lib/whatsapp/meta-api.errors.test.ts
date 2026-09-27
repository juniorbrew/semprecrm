import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaApiError,
  listWabaPhoneNumbers,
  registerPhoneNumber,
  verifyPhoneNumber,
} from "./meta-api";

// wacrm #505 — Graph failures keep Meta's envelope (code, subcode,
// fbtrace_id, error_data.details) so the config route can explain them.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("MetaApiError", () => {
  it("carries the envelope and keeps Meta's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            error: {
              message: "Unsupported get request.",
              code: 100,
              error_subcode: 33,
              type: "GraphMethodException",
              fbtrace_id: "TRACE",
              error_data: { details: "Object does not exist" },
            },
          },
          400,
        ),
      ),
    );
    const err = await verifyPhoneNumber({ phoneNumberId: "1", accessToken: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Unsupported get request.");
    expect(err).toMatchObject({
      code: 100,
      subcode: 33,
      type: "GraphMethodException",
      fbtraceId: "TRACE",
      httpStatus: 400,
      details: "Object does not exist",
    });
  });

  it("falls back to the status text for a non-JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 503 })));
    const err = await verifyPhoneNumber({ phoneNumberId: "1", accessToken: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.message).toBe("Meta API error: 503");
    expect(err.code).toBeNull();
    expect(err.httpStatus).toBe(503);
  });

  it("registerPhoneNumber throws the structured error but still treats 'already registered' as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { message: "PIN mismatch", code: 133005 } }, 400)),
    );
    const err = await registerPhoneNumber({ phoneNumberId: "1", accessToken: "t", pin: "123456" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.code).toBe(133005);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { message: "Phone number already registered", code: 133005 } }, 400)),
    );
    await expect(
      registerPhoneNumber({ phoneNumberId: "1", accessToken: "t", pin: "123456" }),
    ).resolves.toEqual({ success: true, alreadyRegistered: true });
  });
});

describe("listWabaPhoneNumbers", () => {
  it("follows paging.next and concatenates the pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: "1" }], paging: { next: "https://graph/next" } }))
      .mockResolvedValueOnce(json({ data: [{ id: "2", display_phone_number: "+55" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const numbers = await listWabaPhoneNumbers({ wabaId: "999", accessToken: "t" });
    expect(numbers.map((n) => n.id)).toEqual(["1", "2"]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/999/phone_numbers");
    expect(fetchMock.mock.calls[1][0]).toBe("https://graph/next");
  });

  it("throws a MetaApiError on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "nope", code: 10 } }, 403)));
    await expect(listWabaPhoneNumbers({ wabaId: "999", accessToken: "t" })).rejects.toBeInstanceOf(
      MetaApiError,
    );
  });
});
