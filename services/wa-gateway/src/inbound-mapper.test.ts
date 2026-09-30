import { describe, expect, it } from "vitest";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  capVCards,
  extFromMime,
  jidToPhone,
  mapInboundMessage,
  resolveSenderPhone,
  revokedMessageId,
  unwrapContent,
} from "./inbound-mapper.js";

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
      mapInboundMessage(ACCOUNT, fixture({ ...base, key: { remoteJid: "1-2@g.us", fromMe: true, id: "d" } })),
    ).toEqual({ kind: "skip", reason: "group" });
    // REVOKE sem key (malformado) e outros protocolMessage continuam ignorados
    expect(mapInboundMessage(ACCOUNT, fixture({ message: { protocolMessage: { type: 0 } } }))).toEqual({
      kind: "skip",
      reason: "protocol",
    });
    expect(mapInboundMessage(ACCOUNT, fixture({ message: { protocolMessage: { type: 14 } } }))).toEqual({
      kind: "skip",
      reason: "protocol",
    });
    expect(mapInboundMessage(ACCOUNT, fixture({ message: { contactMessage: { displayName: "x" } } }))).toEqual({
      kind: "skip",
      reason: "unsupported-type",
    });
    // With a vCard the card is forwarded as text (the inbox renders it).
    expect(
      mapInboundMessage(
        ACCOUNT,
        fixture({ message: { contactMessage: { displayName: "x", vcard: "BEGIN:VCARD\nFN:Ana\nEND:VCARD" } } }),
      ),
    ).toMatchObject({ kind: "message", payload: { type: "text", text: "BEGIN:VCARD\nFN:Ana\nEND:VCARD" } });
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

describe("mapInboundMessage — eco do celular (fromMe)", () => {
  const phoneKey = { remoteJid: "5511988887777@s.whatsapp.net", fromMe: true, id: "3A0PHONE1" };

  it("fromMe que não saiu do gateway vira echo, com o telefone do cliente e sem pushName", () => {
    const out = mapInboundMessage(ACCOUNT, fixture({ key: phoneKey, pushName: "Minha Loja", message: { conversation: "já te mando" } }));
    expect(out).toEqual({
      kind: "echo",
      payload: {
        account_id: ACCOUNT,
        message_id: "3A0PHONE1",
        from: "5511988887777",
        push_name: "",
        timestamp: 1_757_700_000,
        type: "text",
        text: "já te mando",
      },
    });
  });

  it("eco de mídia descreve a mídia pendente igual a uma recebida", () => {
    const out = mapInboundMessage(ACCOUNT, fixture({ key: phoneKey, message: { imageMessage: { mimetype: "image/png", caption: "catálogo" } } }));
    expect(out.kind).toBe("echo");
    if (out.kind !== "echo") return;
    expect(out.media).toEqual({ mimetype: "image/png", filename: "image.png" });
    expect(out.payload.text).toBe("catálogo");
  });

  it("eco de um envio do próprio gateway é descartado (own-send)", () => {
    const own = new Set(["3EBGATEWAY1"]);
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({ key: { ...phoneKey, id: "3EBGATEWAY1" }, message: { conversation: "oi" } }),
      { ownSendIds: own },
    );
    expect(out).toEqual({ kind: "skip", reason: "own-send" });
  });

  it("mensagem para mim mesmo (self-chat) não vira conversa", () => {
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({ key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: true, id: "N1" }, message: { conversation: "nota" } }),
      { selfPhone: "5511999999999" },
    );
    expect(out).toEqual({ kind: "skip", reason: "self-chat" });
  });

  it("eco em LID: PN resolvido do LID vem antes do alt, e o alt com o NOSSO número é ignorado", () => {
    const key = { remoteJid: "42@lid", remoteJidAlt: "5511999999999@s.whatsapp.net", fromMe: true, id: "E3" };
    const self = { selfPhone: "5511999999999" };
    const resolved = mapInboundMessage(ACCOUNT, fixture({ key, message: { conversation: "x" } }), {
      ...self,
      resolvedPn: "5511977776666@s.whatsapp.net",
    });
    expect(resolved.kind === "echo" && resolved.payload.from).toBe("5511977776666");
    // sem resolução: o alt é o nosso número → não há telefone do cliente
    expect(mapInboundMessage(ACCOUNT, fixture({ key, message: { conversation: "x" } }), self)).toEqual({
      kind: "skip",
      reason: "no-phone",
    });
  });

  it("eco em LID usa remoteJidAlt", () => {
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({ key: { remoteJid: "42@lid", remoteJidAlt: "5511977776666@s.whatsapp.net", fromMe: true, id: "E2" }, message: { conversation: "x" } }),
    );
    expect(out.kind).toBe("echo");
    if (out.kind === "echo") expect(out.payload.from).toBe("5511977776666");
  });
});

describe("mapInboundMessage — apagar para todos (REVOKE)", () => {
  const revoke = (fromMe: boolean, id = "R1") =>
    fixture({
      key: { remoteJid: "5511988887777@s.whatsapp.net", fromMe, id },
      message: { protocolMessage: { type: 0, key: { remoteJid: "5511988887777@s.whatsapp.net", fromMe, id: "ORIG1" } } },
    });

  it("cliente apagou: revoke com o id da mensagem ORIGINAL", () => {
    expect(mapInboundMessage(ACCOUNT, revoke(false))).toEqual({
      kind: "revoke",
      payload: {
        account_id: ACCOUNT,
        message_id: "ORIG1",
        from: "5511988887777",
        revoked_by: "customer",
        timestamp: 1_757_700_000,
      },
    });
  });

  it("apagado pelo nosso celular: revoked_by phone", () => {
    const out = mapInboundMessage(ACCOUNT, revoke(true));
    expect(out.kind).toBe("revoke");
    if (out.kind === "revoke") expect(out.payload.revoked_by).toBe("phone");
  });

  it("revoke em grupo é ignorado como o resto do grupo", () => {
    const out = mapInboundMessage(
      ACCOUNT,
      fixture({ key: { remoteJid: "1-2@g.us", fromMe: false, id: "G" }, message: { protocolMessage: { type: 0, key: { id: "X" } } } }),
    );
    expect(out).toEqual({ kind: "skip", reason: "group" });
  });

  it("revokedMessageId só reconhece o tipo REVOKE", () => {
    expect(revokedMessageId({ protocolMessage: { type: 0, key: { id: "A" } } })).toBe("A");
    expect(revokedMessageId({ protocolMessage: { type: 14, key: { id: "A" } } })).toBeUndefined();
    expect(revokedMessageId({ conversation: "x" })).toBeUndefined();
  });
});

describe("capVCards", () => {
  it("drops PHOTO lines with their folded continuation, caps cards and size", () => {
    const nl = String.fromCharCode(10);
    const card = ["BEGIN:VCARD", "FN:Ana", "PHOTO;ENCODING=b:AAAA", " BBBB", "TEL:1", "END:VCARD"].join(nl);
    expect(capVCards([card])).toBe(["BEGIN:VCARD", "FN:Ana", "TEL:1", "END:VCARD"].join(nl));
    expect(capVCards(Array(20).fill("BEGIN:VCARD")).split("BEGIN:VCARD")).toHaveLength(11);
    expect(capVCards(["BEGIN:VCARD" + nl + "NOTE:" + "x".repeat(20000)]).length).toBe(8192);
  });
});
