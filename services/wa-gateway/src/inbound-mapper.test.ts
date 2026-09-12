import { describe, expect, it } from "vitest";
import type { WAMessage } from "@whiskeysockets/baileys";
import { extFromMime, jidToPhone, mapInboundMessage, resolveSenderPhone, unwrapContent } from "./inbound-mapper.js";

const ACCOUNT = "acc-1";

function fixture(overrides: Partial<WAMessage> & { message?: WAMessage["message"] }): WAMessage {
  return {
    key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "ABCDEF123" },
    pushName: "Maria",
    messageTimestamp: 1_757_700_000,
    ...overrides,
  } as WAMessage;
}

describe("jidToPhone", () => {
  it("extrai só os dígitos de um JID de telefone", () => {
    expect(jidToPhone("5511999999999@s.whatsapp.net")).toBe("5511999999999");
    expect(jidToPhone("5511999999999:12@s.whatsapp.net")).toBe("5511999999999");
  });
  it("ignora JIDs que não são telefone", () => {
    expect(jidToPhone("123456@lid")).toBeUndefined();
    expect(jidToPhone("123-456@g.us")).toBeUndefined();
    expect(jidToPhone(undefined)).toBeUndefined();
  });
});

describe("resolveSenderPhone", () => {
  it("usa remoteJidAlt quando o remoteJid é LID", () => {
    expect(resolveSenderPhone({ remoteJid: "999@lid", remoteJidAlt: "5511988887777@s.whatsapp.net" })).toBe(
      "5511988887777",
    );
  });
  it("usa o JID resolvido pelo chamador como último recurso", () => {
    expect(resolveSenderPhone({ remoteJid: "999@lid" }, "5511900000000@s.whatsapp.net")).toBe("5511900000000");
  });
});

describe("unwrapContent", () => {
  it("desembrulha efêmera + view once aninhados", () => {
    const content = unwrapContent({
      ephemeralMessage: { message: { viewOnceMessageV2: { message: { conversation: "oi" } } } },
    });
    expect(content?.conversation).toBe("oi");
  });
});

describe("mapInboundMessage", () => {
  it("texto simples (conversation)", () => {
    const out = mapInboundMessage(ACCOUNT, fixture({ message: { conversation: "Olá!" } }));
    expect(out).toEqual({
      kind: "message",
      payload: {
        account_id: ACCOUNT,
        message_id: "ABCDEF123",
        from: "5511999999999",
        push_name: "Maria",
        timestamp: 1_757_700_000,
        type: "text",
        text: "Olá!",
      },
    });
  });

  it("extendedTextMessage com citação", () => {
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({
        message: { extendedTextMessage: { text: "respondendo", contextInfo: { stanzaId: "QUOTED1" } } },
      }),
    );
    expect(out.kind).toBe("message");
    if (out.kind !== "message") return;
    expect(out.payload.type).toBe("text");
    expect(out.payload.text).toBe("respondendo");
    expect(out.payload.quoted_message_id).toBe("QUOTED1");
    expect(out.media).toBeUndefined();
  });

  it("imagem com legenda vira type image + media pendente", () => {
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({ message: { imageMessage: { mimetype: "image/jpeg", caption: "olha isso" } } }),
    );
    expect(out).toMatchObject({
      kind: "message",
      payload: { type: "image", text: "olha isso" },
      media: { mimetype: "image/jpeg", filename: "image.jpg" },
    });
  });

  it("vídeo, áudio (ptt), sticker e documento", () => {
    const video = mapInboundMessage(ACCOUNT, fixture({ message: { videoMessage: { mimetype: "video/mp4" } } }));
    expect(video).toMatchObject({ kind: "message", payload: { type: "video" }, media: { filename: "video.mp4" } });

    const audio = mapInboundMessage(
      ACCOUNT,
      fixture({ message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } } }),
    );
    expect(audio).toMatchObject({
      kind: "message",
      payload: { type: "audio" },
      media: { mimetype: "audio/ogg; codecs=opus", filename: "audio.ogg" },
    });
    if (audio.kind === "message") expect(audio.payload.text).toBeUndefined();

    const sticker = mapInboundMessage(ACCOUNT, fixture({ message: { stickerMessage: { mimetype: "image/webp" } } }));
    expect(sticker).toMatchObject({ kind: "message", payload: { type: "sticker" }, media: { filename: "sticker.webp" } });

    const doc = mapInboundMessage(
      ACCOUNT,
      fixture({
        message: {
          documentMessage: { mimetype: "application/pdf", fileName: "contrato.pdf", caption: "segue" },
        },
      }),
    );
    expect(doc).toMatchObject({
      kind: "message",
      payload: { type: "document", text: "segue" },
      media: { mimetype: "application/pdf", filename: "contrato.pdf" },
    });
  });

  it("documento com legenda embrulhado (documentWithCaptionMessage)", () => {
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({
        message: {
          documentWithCaptionMessage: {
            message: { documentMessage: { mimetype: "application/pdf", fileName: "a.pdf", caption: "leg" } },
          },
        },
      }),
    );
    expect(out).toMatchObject({ kind: "message", payload: { type: "document", text: "leg" } });
  });

  it("localização vira texto com coordenadas", () => {
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({
        message: { locationMessage: { degreesLatitude: -23.55, degreesLongitude: -46.63, name: "Sé" } },
      }),
    );
    expect(out).toMatchObject({ kind: "message", payload: { type: "location", text: "Sé (-23.55,-46.63)" } });
  });

  it("remoteJid em LID usa remoteJidAlt como número", () => {
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({
        key: { remoteJid: "123456789@lid", remoteJidAlt: "5511977776666@s.whatsapp.net", fromMe: false, id: "X1" },
        message: { conversation: "oi" },
      }),
    );
    expect(out).toMatchObject({ kind: "message", payload: { from: "5511977776666", message_id: "X1" } });
  });

  it("LID sem alternativa e sem resolução é ignorado (no-phone)", () => {
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({ key: { remoteJid: "123456789@lid", fromMe: false, id: "X2" }, message: { conversation: "oi" } }),
    );
    expect(out).toEqual({ kind: "skip", reason: "no-phone" });
  });

  it("ignora grupos, status, newsletters, fromMe e protocolo", () => {
    const base = { message: { conversation: "x" } };
    expect(mapInboundMessage(ACCOUNT, fixture({ ...base, key: { remoteJid: "1-2@g.us", fromMe: false, id: "a" } }))).toEqual({
      kind: "skip",
      reason: "group",
    });
    expect(
      mapInboundMessage(ACCOUNT, fixture({ ...base, key: { remoteJid: "status@broadcast", fromMe: false, id: "b" } })),
    ).toEqual({ kind: "skip", reason: "status-broadcast" });
    expect(
      mapInboundMessage(ACCOUNT, fixture({ ...base, key: { remoteJid: "1@newsletter", fromMe: false, id: "c" } })),
    ).toEqual({ kind: "skip", reason: "newsletter" });
    expect(
      mapInboundMessage(ACCOUNT, fixture({ ...base, key: { remoteJid: "5511@s.whatsapp.net", fromMe: true, id: "d" } })),
    ).toEqual({ kind: "skip", reason: "from-me" });
    expect(mapInboundMessage(ACCOUNT, fixture({ message: { protocolMessage: { type: 0 } } }))).toEqual({
      kind: "skip",
      reason: "protocol",
    });
    expect(mapInboundMessage(ACCOUNT, fixture({ message: { contactMessage: { displayName: "x" } } }))).toEqual({
      kind: "skip",
      reason: "unsupported-type",
    });
    expect(mapInboundMessage(ACCOUNT, fixture({ message: undefined }))).toEqual({ kind: "skip", reason: "no-message" });
  });

  it("converte messageTimestamp Long para segundos", () => {
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({
        message: { conversation: "x" },
        messageTimestamp: { low: 1_700_000_000, high: 0, unsigned: false, toNumber: () => 1_700_000_000 } as never,
      }),
    );
    expect(out).toMatchObject({ kind: "message", payload: { timestamp: 1_700_000_000 } });
  });
});

describe("extFromMime", () => {
  it("mapeia mimetypes comuns e cai em bin", () => {
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extFromMime("application/vnd.ms-excel")).toBe("vndmsexcel");
    expect(extFromMime("weird")).toBe("bin");
  });
});
