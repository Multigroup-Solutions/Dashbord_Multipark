import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_TEMPLATE_NAME,
  SHIFT_NOTICE_TEMPLATE_NAME,
  TEAM_TEMPLATE_LANGUAGE,
  findWhatsAppTemplate,
  shiftNoticeButtonAction,
} from "../shared/whatsappTemplate";
import { analyzeTemplateEntry, templateFreeText, toWhatsAppBold } from "./whatsappTemplateMeta";
import { parseWebhookPayload } from "./whatsappInbound";

describe("templates de equipa (Fase 2)", () => {
  it("driver_shift_notice e driver_availability, UTILITY em pt_PT, com os parâmetros nomeados", () => {
    const aviso = findWhatsAppTemplate("aviso_trabalho")!;
    const disp = findWhatsAppTemplate("disponibilidade")!;
    expect([aviso.name, aviso.language]).toEqual([SHIFT_NOTICE_TEMPLATE_NAME, "pt_PT"]);
    expect([disp.name, disp.language]).toEqual([AVAILABILITY_TEMPLATE_NAME, "pt_PT"]);
    expect(TEAM_TEMPLATE_LANGUAGE).toBe("pt_PT");
    expect(aviso.roles).toEqual({ recipient: "customer_name", shared: "day" });
    expect(disp.roles).toEqual({ recipient: "customer_name", shared: "week_date" });
  });

  it("morada_e_regras e seja_motorista continuam no catálogo (recurso / sem mudança)", () => {
    expect(findWhatsAppTemplate("morada_regras")?.name).toBe("morada_e_regras");
    expect(findWhatsAppTemplate("seja_motorista")?.name).toBe("seja_motorista");
  });
});

describe("shiftNoticeButtonAction", () => {
  it("lê os dois botões, sem ligar a maiúsculas, acentos ou espaços", () => {
    expect(shiftNoticeButtonAction("Confirmo")).toBe("confirmed");
    expect(shiftNoticeButtonAction("  confirmo ")).toBe("confirmed");
    expect(shiftNoticeButtonAction("Não posso")).toBe("declined");
    expect(shiftNoticeButtonAction("NAO  POSSO")).toBe("declined");
  });
  it("tudo o resto não é um botão do aviso", () => {
    expect(shiftNoticeButtonAction("Sim")).toBeNull();
    expect(shiftNoticeButtonAction("Confirmo, mas chego tarde")).toBeNull();
    expect(shiftNoticeButtonAction(null)).toBeNull();
    expect(shiftNoticeButtonAction("")).toBeNull();
  });
});

describe("parseWebhookPayload — botão de resposta rápida", () => {
  it("guarda o context.id (wamid do aviso) e o payload do botão", () => {
    const out = parseWebhookPayload({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { messages: [{
        from: "351912345678", id: "wamid.IN", timestamp: "1700000000", type: "button",
        context: { from: "351210000000", id: "wamid.AVISO" },
        button: { text: "Não posso", payload: "Não posso" },
      }] } }] }],
    });
    expect(out.messages[0]).toMatchObject({ type: "button", body: "Não posso", contextId: "wamid.AVISO", buttonPayload: "Não posso" });
  });
  it("mensagem normal: sem contexto nem payload", () => {
    const out = parseWebhookPayload({ entry: [{ changes: [{ value: { messages: [{ from: "351912345678", id: "w", type: "text", text: { body: "Olá" } }] } }] }] });
    expect(out.messages[0]).toMatchObject({ contextId: null, buttonPayload: null });
  });
});

describe("morada e regras em texto livre", () => {
  const RULES_ENTRY = {
    name: "morada_e_regras",
    language: "pt_BR",
    status: "APPROVED",
    category: "UTILITY",
    components: [
      { type: "HEADER", format: "TEXT", text: "Bem-vindo à Multipark" },
      { type: "BODY", text: "A morada é **Rua X, 10**.\nRegras: chega *10 min* antes." },
      { type: "FOOTER", text: "Multipark" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "Ver no mapa", url: "https://maps.app/abc" },
        { type: "QUICK_REPLY", text: "Ok" },
      ] },
    ],
  };

  it("negrito de UM asterisco", () => {
    expect(toWhatsAppBold("**Rua X**, *já* bem")).toBe("*Rua X*, *já* bem");
  });

  it("o mesmo conteúdo do template: cabeçalho, corpo, links e rodapé (sem respostas rápidas)", () => {
    const text = templateFreeText(RULES_ENTRY.components);
    expect(text).toBe(
      "*Bem-vindo à Multipark*\n\nA morada é *Rua X, 10*.\nRegras: chega *10 min* antes.\n\nVer no mapa: https://maps.app/abc\n\n_Multipark_",
    );
    expect(text).not.toContain("**");
    expect(text).not.toContain("Ok");
    expect(analyzeTemplateEntry(RULES_ENTRY).freeText).toBe(text);
  });
});
