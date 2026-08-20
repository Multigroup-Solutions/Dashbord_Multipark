import { describe, expect, it } from "vitest";
import { buildBodyParams, renderOutboundBody, resolveRecipients } from "./whatsappBroadcast";
import { analyzeTemplateEntry } from "./whatsappTemplateMeta";
import { findWhatsAppTemplate } from "../shared/whatsappTemplate";
import type { ActiveExtra } from "./extrasAvailability";

function extra(id: number, fullName: string, phone: string | null): ActiveExtra {
  return { id, fullName, email: null, phone, projectId: null };
}

const EXTRAS: ActiveExtra[] = [
  extra(1, "Ana Válida", "912345678"), // PT 9 díg → +351912345678
  extra(2, "Bruno E164", "+351911111111"), // já E.164
  extra(3, "Carlos Sem Número", null), // sem número
  extra(4, "Diana Inválida", "12"), // lixo → inválido
  extra(5, "Eva 00", "00351933333333"), // 00 → +351933333333
];

describe("resolveRecipients", () => {
  it("normaliza cada telefone e marca inválidos/ausentes com phoneE164 null", () => {
    const out = resolveRecipients(EXTRAS);
    expect(out).toHaveLength(5);
    const byId = new Map(out.map(r => [r.employeeId, r]));
    expect(byId.get(1)!.phoneE164).toBe("+351912345678");
    expect(byId.get(2)!.phoneE164).toBe("+351911111111");
    expect(byId.get(3)!.phoneE164).toBeNull(); // sem número
    expect(byId.get(3)!.phone).toBe(""); // raw normalizado para string vazia
    expect(byId.get(4)!.phoneE164).toBeNull(); // lixo
    expect(byId.get(5)!.phoneE164).toBe("+351933333333");
  });

  it("filtra pelo subset employeeIds quando fornecido", () => {
    const out = resolveRecipients(EXTRAS, [1, 5]);
    expect(out.map(r => r.employeeId)).toEqual([1, 5]);
    expect(out.every(r => r.phoneE164 !== null)).toBe(true);
  });

  it("devolve todos quando employeeIds é null ou vazio", () => {
    expect(resolveRecipients(EXTRAS, null)).toHaveLength(5);
    expect(resolveRecipients(EXTRAS, [])).toHaveLength(5);
  });

  it("preserva nome e id de cada extra", () => {
    const out = resolveRecipients(EXTRAS, [2]);
    expect(out[0]).toMatchObject({ employeeId: 2, name: "Bruno E164" });
  });

  it("um subset sem números válidos resolve para 0 válidos", () => {
    const out = resolveRecipients(EXTRAS, [3, 4]);
    expect(out.filter(r => r.phoneE164 !== null)).toHaveLength(0);
  });
});

describe("buildBodyParams", () => {
  it("{{1}} é o PRIMEIRO nome do destinatário e {{2}} o texto partilhado", () => {
    expect(buildBodyParams("Ana Maria Silva", "semana de 11/08")).toEqual(["Ana", "semana de 11/08"]);
  });

  it("sem {{2}} envia só um parâmetro (template de 1 param não pode receber 2)", () => {
    expect(buildBodyParams("Bruno Costa", null)).toEqual(["Bruno"]);
    expect(buildBodyParams("Bruno Costa", "   ")).toEqual(["Bruno"]);
  });

  it("cai em 'Teste' quando não há nome utilizável", () => {
    expect(buildBodyParams(null, "sexta à noite")).toEqual(["Teste", "sexta à noite"]);
    expect(buildBodyParams("   ", null)).toEqual(["Teste"]);
  });

  it("limpa quebras de linha, tabs e espaços a mais (a Meta rejeita-os)", () => {
    expect(buildBodyParams("  João\tPedro ", "semana\nde 11 a   17")).toEqual([
      "João",
      "semana de 11 a 17",
    ]);
  });

  it("nunca devolve mais do que 2 parâmetros", () => {
    expect(buildBodyParams("Ana", "x")).toHaveLength(2);
  });
});

describe("renderOutboundBody (conteúdo gravado na whatsapp_messages.body)", () => {
  const workNoticeRoles = findWhatsAppTemplate("aviso_trabalho")!.roles;
  const analysis = analyzeTemplateEntry({
    name: "aviso_de_trabalho",
    language: "pt_BR",
    status: "APPROVED",
    parameter_format: "NAMED",
    components: [
      { type: "BODY", text: "Olá {{customer_name}}, tens trabalho no dia {{day}}." },
    ],
  });

  it("com metadados grava o texto REAL da Meta, já substituído", () => {
    expect(
      renderOutboundBody({
        templateName: "aviso_de_trabalho",
        analysis,
        roles: workNoticeRoles,
        values: ["Ana", "Sexta 22/08"],
      }),
    ).toBe("Olá Ana, tens trabalho no dia Sexta 22/08.");
  });

  it("respeita os papéis quando o template declara o dia primeiro", () => {
    const reversed = analyzeTemplateEntry({
      name: "aviso_de_trabalho",
      language: "pt_BR",
      status: "APPROVED",
      parameter_format: "NAMED",
      components: [{ type: "BODY", text: "No dia {{day}}: {{customer_name}}, contamos contigo." }],
    });
    expect(
      renderOutboundBody({
        templateName: "aviso_de_trabalho",
        analysis: reversed,
        roles: workNoticeRoles,
        values: ["Ana", "Sexta 22/08"],
      }),
    ).toBe("No dia Sexta 22/08: Ana, contamos contigo.");
  });

  it("sem metadados grava template + valores (nunca bolha vazia)", () => {
    expect(
      renderOutboundBody({
        templateName: "aviso_de_trabalho",
        analysis: null,
        roles: workNoticeRoles,
        values: ["Ana", "Sexta 22/08"],
      }),
    ).toBe("Template aviso_de_trabalho · Ana · Sexta 22/08");
  });

  it("sem metadados e com um só parâmetro não deixa separadores pendurados", () => {
    expect(
      renderOutboundBody({
        templateName: "disponibilidade_extras",
        analysis: null,
        roles: null,
        values: ["Ana", "  "],
      }),
    ).toBe("Template disponibilidade_extras · Ana");
  });

  it("devolve sempre texto não vazio, mesmo sem valores nenhuns", () => {
    expect(
      renderOutboundBody({ templateName: "x", analysis: null, roles: null, values: [] }),
    ).toBe("Template x");
  });
});
