import { describe, expect, it, vi } from "vitest";
import {
  FORWARD_SECRET_HEADER,
  forwardWhatsappWebhook,
  readWebhookForwardConfig,
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
