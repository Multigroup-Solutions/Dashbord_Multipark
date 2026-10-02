import { describe, expect, it } from "vitest";
import {
  WHATSAPP_TEMPLATES,
  findWhatsAppTemplate,
  findWhatsAppTemplateByName,
  messageDisplayBody,
  orderBodyValues,
  previewTemplateBody,
  resolveBodyParamRoles,
} from "../shared/whatsappTemplate";
import { analyzeTemplateEntry } from "./whatsappTemplateMeta";
import { buildComponents } from "./whatsappBroadcast";

/** Como a Graph API devolve o `driver_shift_notice` (NAMED, pt_PT, Fase 2). */
const WORK_NOTICE_ENTRY = {
  name: "driver_shift_notice",
  language: "pt_PT",
  status: "APPROVED",
  parameter_format: "NAMED",
  components: [
    {
      type: "BODY",
      text: "Olá {{customer_name}}, tens trabalho no dia {{day}}. Confirma, por favor.",
    },
  ],
};

/** O MESMO template, mas com o dia escrito ANTES do nome — o caso que a
 *  resolução por posição enviava trocado. */
const WORK_NOTICE_REVERSED = {
  ...WORK_NOTICE_ENTRY,
  components: [{ type: "BODY", text: "No dia {{day}}: {{customer_name}}, contamos contigo." }],
};

/** `driver_availability` (UTILITY, pt_PT, Fase 2): nome + semana + botão URL com o token. */
const AVAILABILITY_ENTRY = {
  name: "driver_availability",
  language: "pt_PT",
  status: "APPROVED",
  category: "UTILITY",
  parameter_format: "NAMED",
  components: [
    { type: "BODY", text: "Olá {{customer_name}}, indica a tua disponibilidade para {{week_date}}." },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Indicar disponibilidade", url: "https://dashboard.multipark.pt/f/{{1}}" }] },
  ],
};

const workNoticeDef = findWhatsAppTemplate("aviso_trabalho")!;
const availabilityDef = findWhatsAppTemplate("disponibilidade")!;

describe("catálogo de templates", () => {
  it("tem ids únicos e nomes/línguas preenchidos", () => {
    const ids = WHATSAPP_TEMPLATES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of WHATSAPP_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.language.length).toBeGreaterThan(0);
      // Templates SEM parâmetros (seja_motorista, morada_e_regras) têm roles e
      // sharedParam a null — os dois juntos, nunca só um.
      if (t.roles === null) {
        expect(t.sharedParam).toBeNull();
      } else {
        expect(t.sharedParam).not.toBeNull();
        expect(t.roles.recipient).not.toBe(t.roles.shared);
      }
    }
  });

  it("encontra a definição pelo nome (é assim que o servidor descobre os papéis)", () => {
    expect(findWhatsAppTemplateByName("driver_shift_notice", "pt_PT")?.id).toBe("aviso_trabalho");
    expect(findWhatsAppTemplateByName("driver_availability", "pt_PT")?.id).toBe("disponibilidade");
    // Língua diferente da aprovada: continua a ser o mesmo template (mesmos parâmetros).
    expect(findWhatsAppTemplateByName("driver_shift_notice", "pt_BR")?.id).toBe("aviso_trabalho");
    // Os nomes antigos (pt_BR) saíram do catálogo (Fase 2, 2 out 2026).
    expect(findWhatsAppTemplateByName("aviso_de_trabalho", "pt_BR")).toBeUndefined();
    expect(findWhatsAppTemplateByName("disponibilidade_extras", "pt_BR")).toBeUndefined();
    // Template fora do catálogo (nome escrito à mão no inbox) → sem papéis.
    expect(findWhatsAppTemplateByName("qualquer_outro", "pt_BR")).toBeUndefined();
  });
});

describe("resolveBodyParamRoles", () => {
  it("mapeia pelos NOMES declarados no catálogo", () => {
    expect(resolveBodyParamRoles(["customer_name", "day"], 2, workNoticeDef.roles)).toEqual([
      "recipient",
      "shared",
    ]);
  });

  it("respeita a ordem REAL do template quando o dia vem primeiro", () => {
    expect(resolveBodyParamRoles(["day", "customer_name"], 2, workNoticeDef.roles)).toEqual([
      "shared",
      "recipient",
    ]);
  });

  it("nome desconhecido → recurso posicional (o template mudou; a ordem é mais fiável)", () => {
    expect(resolveBodyParamRoles(["customer_name", "outro"], 2, workNoticeDef.roles)).toEqual([
      "recipient",
      "shared",
    ]);
  });

  it("posicional (sem nomes) → 1º nome, 2º valor partilhado", () => {
    expect(resolveBodyParamRoles([], 2, workNoticeDef.roles)).toEqual(["recipient", "shared"]);
    expect(resolveBodyParamRoles(null, 1, null)).toEqual(["recipient"]);
    expect(resolveBodyParamRoles([], 0, null)).toEqual([]);
  });

  it("template de 1 parâmetro que só usa o valor partilhado", () => {
    expect(resolveBodyParamRoles(["day"], 1, workNoticeDef.roles)).toEqual(["shared"]);
  });
});

describe("orderBodyValues", () => {
  it("põe cada valor no slot do seu papel", () => {
    expect(orderBodyValues(["shared", "recipient"], { recipient: "Ana", shared: "Sexta 22/08" })).toEqual([
      "Sexta 22/08",
      "Ana",
    ]);
  });

  it("corta os vazios do FIM (2 parâmetros com o campo por preencher → só o nome)", () => {
    expect(orderBodyValues(["recipient", "shared"], { recipient: "Ana", shared: "" })).toEqual(["Ana"]);
    expect(orderBodyValues(["recipient", "shared"], { recipient: "Ana", shared: null })).toEqual(["Ana"]);
  });
});

describe("previewTemplateBody", () => {
  const slots = resolveBodyParamRoles(["customer_name", "day"], 2, workNoticeDef.roles);

  it("substitui nome e dia no texto aprovado", () => {
    expect(
      previewTemplateBody(WORK_NOTICE_ENTRY.components[0].text, slots, {
        recipient: "Ana",
        shared: "Sexta 22/08",
      }),
    ).toBe("Olá Ana, tens trabalho no dia Sexta 22/08. Confirma, por favor.");
  });

  it("campo por preencher mantém o placeholder à vista", () => {
    const out = previewTemplateBody(WORK_NOTICE_ENTRY.components[0].text, slots, {
      recipient: "Ana",
      shared: "  ",
    });
    expect(out).toContain("{{day}}");
    expect(out).toContain("Ana");
  });

  it("nome repetido no texto leva o mesmo valor (a Meta só aceita um por nome)", () => {
    const out = previewTemplateBody("{{customer_name}}, olá {{customer_name}} — dia {{day}}", slots, {
      recipient: "Ana",
      shared: "Sábado",
    });
    expect(out).toBe("Ana, olá Ana — dia Sábado");
  });
});

describe("messageDisplayBody (bolha do inbox)", () => {
  it("mostra o body gravado quando existe", () => {
    expect(messageDisplayBody({ body: "Olá Ana, tens trabalho no dia Sexta 22/08.", type: "template" })).toBe(
      "Olá Ana, tens trabalho no dia Sexta 22/08.",
    );
  });

  it("linha ANTIGA de template sem body → diz que o conteúdo não foi registado, com o nome", () => {
    expect(messageDisplayBody({ body: null, type: "template", templateName: "disponibilidade_extras" })).toBe(
      "Mensagem de template “disponibilidade_extras” (conteúdo não registado)",
    );
  });

  it("linha antiga sem body nem nome de template", () => {
    expect(messageDisplayBody({ body: "   ", type: "template", templateName: null })).toBe(
      "Mensagem de template (conteúdo não registado)",
    );
  });

  it("mensagem de texto sem body devolve vazio (a UI decide o placeholder)", () => {
    expect(messageDisplayBody({ body: null, type: "text" })).toBe("");
  });
});

describe("buildComponents com o template aviso_de_trabalho", () => {
  it("envia customer_name = nome e day = campo do diálogo", () => {
    const comps = buildComponents({
      analysis: analyzeTemplateEntry(WORK_NOTICE_ENTRY),
      values: ["Ana", "Sexta 22/08"],
      roles: workNoticeDef.roles,
    }) as any[];
    expect(comps[0]).toEqual({
      type: "body",
      parameters: [
        { type: "text", parameter_name: "customer_name", text: "Ana" },
        { type: "text", parameter_name: "day", text: "Sexta 22/08" },
      ],
    });
  });

  it("com o dia declarado primeiro, cada valor continua no seu parâmetro", () => {
    const comps = buildComponents({
      analysis: analyzeTemplateEntry(WORK_NOTICE_REVERSED),
      values: ["Ana", "Sexta 22/08"],
      roles: workNoticeDef.roles,
    }) as any[];
    expect(comps[0].parameters).toEqual([
      { type: "text", parameter_name: "day", text: "Sexta 22/08" },
      { type: "text", parameter_name: "customer_name", text: "Ana" },
    ]);
  });

  it("driver_availability: customer_name = nome, week_date = semana e o token no botão URL", () => {
    const analysis = analyzeTemplateEntry(AVAILABILITY_ENTRY);
    expect(analysis.category).toBe("UTILITY");
    const comps = buildComponents({
      analysis,
      values: ["Rafael", "semana de 11/08"],
      roles: availabilityDef.roles,
      buttonToken: "tok123",
    }) as any[];
    expect(comps[0].parameters).toEqual([
      { type: "text", parameter_name: "customer_name", text: "Rafael" },
      { type: "text", parameter_name: "week_date", text: "semana de 11/08" },
    ]);
    expect(comps[1]).toMatchObject({ type: "button", sub_type: "url", parameters: [{ type: "text", text: "tok123" }] });
  });
});
