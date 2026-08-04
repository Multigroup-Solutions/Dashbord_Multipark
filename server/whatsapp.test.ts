import { describe, expect, it } from "vitest";
import crypto from "crypto";
import { normalizePhoneE164 } from "../shared/phone";
import { verifyMetaSignature, isValidWebhookVerification } from "./whatsappWebhook";
import { describeMetaError } from "./whatsapp";

describe("normalizePhoneE164", () => {
  it("mantém números já em +E.164", () => {
    expect(normalizePhoneE164("+351912345678")).toBe("+351912345678");
    expect(normalizePhoneE164("+447911123456")).toBe("+447911123456");
  });

  it("converte prefixo internacional 00 em +", () => {
    expect(normalizePhoneE164("00351912345678")).toBe("+351912345678");
    expect(normalizePhoneE164("0044 7911 123456")).toBe("+447911123456");
  });

  it("assume +351 para números nacionais PT de 9 dígitos", () => {
    expect(normalizePhoneE164("912345678")).toBe("+351912345678");
    expect(normalizePhoneE164("211234567")).toBe("+351211234567");
  });

  it("aceita 351 + 9 dígitos sem o +", () => {
    expect(normalizePhoneE164("351912345678")).toBe("+351912345678");
  });

  it("remove espaços, hífens, parêntesis e pontos", () => {
    expect(normalizePhoneE164("912 345 678")).toBe("+351912345678");
    expect(normalizePhoneE164("912-345-678")).toBe("+351912345678");
    expect(normalizePhoneE164("(912) 345.678")).toBe("+351912345678");
    expect(normalizePhoneE164("+351 912 345 678")).toBe("+351912345678");
  });

  it("devolve null para lixo / formatos não inferíveis", () => {
    expect(normalizePhoneE164("")).toBeNull();
    expect(normalizePhoneE164("   ")).toBeNull();
    expect(normalizePhoneE164("abc")).toBeNull();
    expect(normalizePhoneE164("12345")).toBeNull(); // 5 dígitos, sem indicativo
    expect(normalizePhoneE164("+351abc")).toBeNull();
    expect(normalizePhoneE164("91234567")).toBeNull(); // 8 dígitos: não é PT válido nem tem indicativo
    // @ts-expect-error — garante robustez a input não-string
    expect(normalizePhoneE164(null)).toBeNull();
  });
});

// Helper: assina um corpo como a Meta faria.
function sign(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

describe("verifyMetaSignature", () => {
  const secret = "test-app-secret";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  it("aceita uma assinatura válida", () => {
    const sig = sign(body, secret);
    expect(verifyMetaSignature(Buffer.from(body), sig, secret)).toBe(true);
  });

  it("rejeita assinatura com secret errado", () => {
    const sig = sign(body, "outro-secret");
    expect(verifyMetaSignature(Buffer.from(body), sig, secret)).toBe(false);
  });

  it("rejeita assinatura de um corpo diferente (tamper)", () => {
    const sig = sign(body, secret);
    const tampered = body.replace("entry", "ENTRY");
    expect(verifyMetaSignature(Buffer.from(tampered), sig, secret)).toBe(false);
  });

  it("rejeita assinatura ausente", () => {
    expect(verifyMetaSignature(Buffer.from(body), undefined, secret)).toBe(false);
  });

  it("rejeita quando não há app secret configurado", () => {
    const sig = sign(body, secret);
    expect(verifyMetaSignature(Buffer.from(body), sig, undefined)).toBe(false);
  });

  it("rejeita esquema/formato de header inválido", () => {
    expect(verifyMetaSignature(Buffer.from(body), "sha1=abcd", secret)).toBe(false);
    expect(verifyMetaSignature(Buffer.from(body), "semequals", secret)).toBe(false);
    expect(verifyMetaSignature(Buffer.from(body), "sha256=", secret)).toBe(false);
    expect(verifyMetaSignature(Buffer.from(body), "sha256=nothex!!", secret)).toBe(false);
  });
});

describe("isValidWebhookVerification", () => {
  const verifyToken = "my-verify-token";

  it("aceita mode=subscribe com o token certo", () => {
    expect(isValidWebhookVerification("subscribe", "my-verify-token", verifyToken)).toBe(true);
  });

  it("rejeita token errado", () => {
    expect(isValidWebhookVerification("subscribe", "wrong-token", verifyToken)).toBe(false);
  });

  it("rejeita mode diferente de subscribe", () => {
    expect(isValidWebhookVerification("unsubscribe", "my-verify-token", verifyToken)).toBe(false);
  });

  it("rejeita quando não há verify token configurado", () => {
    expect(isValidWebhookVerification("subscribe", "my-verify-token", undefined)).toBe(false);
  });
});

// Os dois erros reais do broadcast 8 (envio de 2 destinatários) — a mensagem
// tem de dizer o que fazer E qual template/língua foi tentado, senão o
// utilizador não consegue diagnosticar sozinho.
describe("describeMetaError", () => {
  const ctx = {
    to: "+351935625800",
    templateName: "disponibilidade_extras",
    languageCode: "pt_PT",
    paramCount: 2,
  };

  it("131030: explica a lista de destinatários permitidos e como resolver", () => {
    const msg = describeMetaError(131030, { code: 131030, message: "Recipient phone number not in allowed list" }, ctx);
    expect(msg).toContain("+351935625800");
    expect(msg).toContain("destinatários permitidos");
    expect(msg).toContain("API Setup");
    expect(msg).toContain("(código 131030)");
  });

  it("132001: nomeia o template E a língua tentados", () => {
    const msg = describeMetaError(132001, { code: 132001, message: "Template name does not exist" }, ctx);
    expect(msg).toContain('"disponibilidade_extras"');
    expect(msg).toContain('"pt_PT"');
    expect(msg).toContain("pt_BR");
    expect(msg).toContain("(código 132001)");
  });

  it("132000: diz quantos parâmetros foram enviados", () => {
    const msg = describeMetaError(132000, { code: 132000 }, ctx);
    expect(msg).toContain("(2)");
    expect(msg).toContain('"disponibilidade_extras"');
  });

  it("acrescenta o error_data.details da Meta quando existe", () => {
    const msg = describeMetaError(132001, {
      code: 132001,
      message: "Template name does not exist",
      error_data: { details: "template name (disponibilidade_extras) does not exist in pt_PT" },
    }, ctx);
    expect(msg).toContain("Detalhe Meta: template name (disponibilidade_extras) does not exist in pt_PT");
  });

  it("códigos desconhecidos caem na mensagem da própria Meta", () => {
    const msg = describeMetaError(999999, { code: 999999, message: "Something odd" }, ctx);
    expect(msg).toBe("Something odd (código 999999)");
  });

  it("sem código nem mensagem devolve um fallback legível e sem sufixo", () => {
    expect(describeMetaError(undefined, {})).toBe("Falha no envio.");
  });

  // Erro real do 2º teste do Jorge: template pt_BR criado com parâmetros
  // NOMEADOS ({{nome}}/{{semana}}) e envio a mandar posicionais.
  it("100 com detalhe 'Parameter name is missing' explica os parâmetros nomeados", () => {
    const msg = describeMetaError(100, {
      code: 100,
      message: "Invalid parameter",
      error_data: { details: "Parameter name is missing or empty" },
    }, { ...ctx, languageCode: "pt_BR" });
    expect(msg).toContain("parâmetros NOMEADOS");
    expect(msg).toContain('"disponibilidade_extras"');
    expect(msg).toContain("WHATSAPP_WABA_ID");
    expect(msg).toContain("(código 100)");
  });

  it("100 sem esse detalhe mantém a mensagem genérica da Meta", () => {
    const msg = describeMetaError(100, { code: 100, message: "Invalid parameter" }, ctx);
    expect(msg).toBe("Invalid parameter (código 100)");
  });
});
