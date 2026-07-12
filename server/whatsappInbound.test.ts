import { describe, expect, it } from "vitest";
import {
  parseWebhookPayload,
  parseMetaTimestamp,
  messageBody,
  metaFromToE164,
} from "./whatsappInbound";

function inboundPayload(messages: any[], statuses: any[] = []) {
  return { object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages, statuses } }] }] };
}

describe("parseMetaTimestamp", () => {
  it("converte epoch (segundos) em 'YYYY-MM-DD HH:MM:SS' UTC", () => {
    expect(parseMetaTimestamp("1700000000")).toBe("2023-11-14 22:13:20");
    expect(parseMetaTimestamp(1700000000)).toBe("2023-11-14 22:13:20");
  });
  it("devolve null para valores inválidos", () => {
    expect(parseMetaTimestamp(null)).toBeNull();
    expect(parseMetaTimestamp("abc")).toBeNull();
    expect(parseMetaTimestamp(0)).toBeNull();
  });
});

describe("messageBody", () => {
  it("texto → body", () => {
    expect(messageBody({ type: "text", text: { body: "Olá" } })).toBe("Olá");
  });
  it("imagem com caption → caption; sem caption → [imagem]", () => {
    expect(messageBody({ type: "image", image: { caption: "foto" } })).toBe("foto");
    expect(messageBody({ type: "image", image: { id: "x" } })).toBe("[imagem]");
  });
  it("áudio/localização/tipo desconhecido → marcador", () => {
    expect(messageBody({ type: "audio", audio: {} })).toBe("[áudio]");
    expect(messageBody({ type: "location" })).toBe("[localização]");
    expect(messageBody({ type: "reaction" })).toBe("[reaction]");
  });
  it("interactive → título da resposta", () => {
    expect(messageBody({ type: "interactive", interactive: { button_reply: { title: "Sim" } } })).toBe("Sim");
  });
});

describe("parseWebhookPayload — mensagens inbound", () => {
  it("extrai uma mensagem de texto", () => {
    const p = inboundPayload([
      { id: "wamid.A", from: "351912345678", timestamp: "1700000000", type: "text", text: { body: "Disponível sábado" } },
    ]);
    const out = parseWebhookPayload(p);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({
      waMessageId: "wamid.A",
      from: "351912345678",
      type: "text",
      body: "Disponível sábado",
    });
    expect(out.statuses).toHaveLength(0);
  });

  it("media não-texto guarda representação mínima", () => {
    const p = inboundPayload([
      { id: "wamid.IMG", from: "351911111111", timestamp: "1700000000", type: "image", image: { id: "m1" } },
    ]);
    const out = parseWebhookPayload(p);
    expect(out.messages[0].body).toBe("[imagem]");
    expect(out.messages[0].type).toBe("image");
  });

  it("ignora mensagens sem id ou sem from", () => {
    const p = inboundPayload([
      { from: "351911111111", type: "text", text: { body: "x" } },
      { id: "wamid.NoFrom", type: "text", text: { body: "y" } },
      { id: "wamid.OK", from: "351911111111", type: "text", text: { body: "z" } },
    ]);
    const out = parseWebhookPayload(p);
    expect(out.messages.map(m => m.waMessageId)).toEqual(["wamid.OK"]);
  });
});

describe("parseWebhookPayload — statuses", () => {
  it("extrai delivered/read", () => {
    const p = inboundPayload([], [
      { id: "wamid.OUT1", status: "delivered", timestamp: "1700000000", recipient_id: "351911111111" },
      { id: "wamid.OUT2", status: "read", timestamp: "1700000100", recipient_id: "351911111111" },
    ]);
    const out = parseWebhookPayload(p);
    expect(out.statuses.map(s => [s.waMessageId, s.status])).toEqual([
      ["wamid.OUT1", "delivered"],
      ["wamid.OUT2", "read"],
    ]);
  });

  it("failed inclui errorDetail dos errors[]", () => {
    const p = inboundPayload([], [
      { id: "wamid.F", status: "failed", timestamp: "1700000000", errors: [{ code: 131047, title: "Re-engagement message" }] },
    ]);
    const out = parseWebhookPayload(p);
    expect(out.statuses[0].status).toBe("failed");
    expect(out.statuses[0].errorDetail).toContain("131047");
    expect(out.statuses[0].errorDetail).toContain("Re-engagement");
  });

  it("ignora status desconhecido", () => {
    const p = inboundPayload([], [{ id: "wamid.Z", status: "deleted" }]);
    expect(parseWebhookPayload(p).statuses).toHaveLength(0);
  });
});

describe("parseWebhookPayload — payloads malformados/vazios", () => {
  it("objeto vazio / null / estrutura errada → sem mensagens nem statuses", () => {
    expect(parseWebhookPayload({})).toEqual({ messages: [], statuses: [] });
    expect(parseWebhookPayload(null)).toEqual({ messages: [], statuses: [] });
    expect(parseWebhookPayload({ entry: "nope" })).toEqual({ messages: [], statuses: [] });
    expect(parseWebhookPayload({ entry: [{ changes: [{}] }] })).toEqual({ messages: [], statuses: [] });
  });
});

describe("metaFromToE164", () => {
  it("número PT (com indicativo, sem +) normaliza para +351…", () => {
    expect(metaFromToE164("351912345678")).toBe("+351912345678");
  });
  it("número não-PT cai para + dígitos", () => {
    expect(metaFromToE164("447911123456")).toBe("+447911123456");
  });
});
