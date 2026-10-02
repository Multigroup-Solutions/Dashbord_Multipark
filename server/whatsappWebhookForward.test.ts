import { describe, expect, it, vi } from "vitest";
import {
  classifyForwardPayload,
  FORWARD_SECRET_HEADER,
  forwardWhatsappWebhook,
  readWebhookForwardConfig,
  shouldForwardWebhook,
} from "./whatsappWebhookForward";

const config = { url: "https://api.example.com/api/v1/webhooks/whatsapp", sharedSecret: "fwd-secret" };
const raw = Buffer.from('{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[]}]}');

describe("readWebhookForwardConfig", () => {
  it("fica desligado sem URL ou sem segredo", () => {
    expect(readWebhookForwardConfig({})).toBeNull();
    expect(readWebhookForwardConfig({ BE_MULTIPARK_WEBHOOK_URL: config.url })).toBeNull();
    expect(readWebhookForwardConfig({ FORWARD_SHARED_SECRET: "x" })).toBeNull();
  });

  it("exige https (http só em localhost) e URL válido", () => {
    expect(readWebhookForwardConfig({ BE_MULTIPARK_WEBHOOK_URL: "http://api.example.com/x", FORWARD_SHARED_SECRET: "x" })).toBeNull();
    expect(readWebhookForwardConfig({ BE_MULTIPARK_WEBHOOK_URL: "not a url", FORWARD_SHARED_SECRET: "x" })).toBeNull();
    expect(readWebhookForwardConfig({ BE_MULTIPARK_WEBHOOK_URL: "http://localhost:3000/x", FORWARD_SHARED_SECRET: "x" })).not.toBeNull();
    expect(readWebhookForwardConfig({ BE_MULTIPARK_WEBHOOK_URL: ` ${config.url} `, FORWARD_SHARED_SECRET: " s " })).toEqual({
      url: config.url,
      sharedSecret: "s",
    });
  });
});

const inbound = (...froms: string[]) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "1", changes: [{ field: "messages", value: { messages: froms.map((from, i) => ({ from, id: `wamid.${i}`, type: "text" })) } }] }],
});
const STAFF = "+351912000111";
const lookup = (internal: string[]) => vi.fn(async (e164: string) => internal.includes(e164));

describe("classifyForwardPayload", () => {
  it("statuses, eventos de template e payloads estranhos seguem sempre", () => {
    expect(classifyForwardPayload({}).kind).toBe("forward");
    expect(
      classifyForwardPayload({ entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "w", status: "read" }] } }] }] }),
    ).toEqual({ kind: "forward", reason: "statuses" });
    expect(classifyForwardPayload({ entry: [{ changes: [{ field: "message_template_status_update", value: {} }] }] })).toEqual({
      kind: "forward",
      reason: "non_message_event",
    });
    expect(classifyForwardPayload({ entry: [{ changes: [{ field: "messages", value: {} }] }] })).toEqual({ kind: "forward", reason: "no_inbound" });
  });

  it("só mensagens recebidas → lista de remetentes (sem duplicados)", () => {
    expect(classifyForwardPayload(inbound("351912000111", "351912000111"))).toEqual({ kind: "inbound_only", senders: ["351912000111"] });
  });
});

describe("shouldForwardWebhook", () => {
  it("NÃO segue quando todos os remetentes são números internos", async () => {
    expect(await shouldForwardWebhook(inbound("351912000111"), lookup([STAFF]))).toBe(false);
  });

  it("segue quando algum remetente é cliente / desconhecido (payload misto vai inteiro)", async () => {
    expect(await shouldForwardWebhook(inbound("351912000111", "351934000222"), lookup([STAFF]))).toBe(true);
    expect(await shouldForwardWebhook(inbound("351934000222"), lookup([STAFF]))).toBe(true);
  });

  it("estados de mensagens seguem mesmo com remetente interno no mesmo evento", async () => {
    const payload = {
      entry: [{ changes: [{ field: "messages", value: { messages: [{ from: "351912000111", id: "w1" }], statuses: [{ id: "w2", status: "delivered" }] } }] }],
    };
    const l = lookup([STAFF]);
    expect(await shouldForwardWebhook(payload, l)).toBe(true);
    expect(l).not.toHaveBeenCalled();
  });

  it("normaliza o 'from' da Meta para E.164 antes de comparar", async () => {
    const l = lookup([STAFF]);
    await shouldForwardWebhook(inbound("351912000111"), l);
    expect(l).toHaveBeenCalledWith(STAFF);
  });

  it("falha na consulta → segue (fail-open), sem atirar", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn(async () => {
      throw new Error("db down");
    });
    expect(await shouldForwardWebhook(inbound("351912000111"), failing)).toBe(true);
    spy.mockRestore();
  });
});

describe("forwardWhatsappWebhook", () => {
  it("sem config não chama a rede", async () => {
    const fetchImpl = vi.fn();
    expect(await forwardWhatsappWebhook(raw, "sha256=ab", null, fetchImpl as any)).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("envia os bytes originais, a assinatura da Meta e o segredo do forward", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    expect(await forwardWhatsappWebhook(raw, "sha256=abc", config, fetchImpl as any)).toBe("ok");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(config.url);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers["x-hub-signature-256"]).toBe("sha256=abc");
    expect(init.headers[FORWARD_SECRET_HEADER]).toBe("fwd-secret");
    expect(Buffer.from(init.body).equals(raw)).toBe(true);
  });

  it("resposta não-2xx do be → 'failed', sem atirar", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await forwardWhatsappWebhook(raw, "sha256=abc", config, fetchImpl as any)).toBe("failed");
    spy.mockRestore();
  });

  it("be em baixo (erro de rede / timeout) → 'failed', sem atirar", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(forwardWhatsappWebhook(raw, "sha256=abc", config, fetchImpl as any)).resolves.toBe("failed");
    expect(spy.mock.calls.flat().join(" ")).not.toContain("fwd-secret");
    spy.mockRestore();
  });
});
