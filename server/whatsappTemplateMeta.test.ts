import { describe, expect, it } from "vitest";
import {
  analyzeTemplateEntry,
  buildBodyComponent,
  countPositionalParams,
  describeLookupFailure,
  extractBodyParamNames,
  selectTemplate,
  validateTemplateUsage,
  wabaIdsFromDebugToken,
  type TemplateAnalysis,
} from "./whatsappTemplateMeta";
import { buildComponents } from "./whatsappBroadcast";

/** Entrada como a Graph API a devolve para o template real do Jorge (pt_BR, NAMED). */
const NAMED_ENTRY = {
  name: "disponibilidade_extras",
  language: "pt_BR",
  status: "APPROVED",
  parameter_format: "NAMED",
  components: [
    {
      type: "BODY",
      text: "Olá {{nome}}, indica a tua disponibilidade para {{semana}}.",
      example: { body_text_named_params: [{ param_name: "nome", example: "João" }] },
    },
  ],
};

const POSITIONAL_ENTRY = {
  name: "disponibilidade_extras",
  language: "pt_PT",
  status: "APPROVED",
  parameter_format: "POSITIONAL",
  components: [{ type: "BODY", text: "Olá {{1}}, disponibilidade para {{2}}?" }],
};

const WITH_BUTTON_ENTRY = {
  name: "disp_link",
  language: "pt_PT",
  status: "APPROVED",
  parameter_format: "POSITIONAL",
  components: [
    { type: "BODY", text: "Olá {{1}}!" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "PHONE_NUMBER", text: "Ligar", phone_number: "+351210000000" },
        { type: "URL", text: "Preencher", url: "https://form.multipark.pt/?token={{1}}" },
      ],
    },
  ],
};

describe("extractBodyParamNames", () => {
  it("devolve os nomes por ordem de aparição", () => {
    expect(extractBodyParamNames("Olá {{nome}}, para {{semana}} tudo bem?")).toEqual(["nome", "semana"]);
  });

  it("não repete um nome usado duas vezes", () => {
    expect(extractBodyParamNames("{{nome}}, sim {{nome}}, para {{semana}}")).toEqual(["nome", "semana"]);
  });

  it("tolera espaços dentro das chavetas", () => {
    expect(extractBodyParamNames("Olá {{ nome }} e {{  semana  }}")).toEqual(["nome", "semana"]);
  });

  it("ignora parâmetros posicionais e texto sem parâmetros", () => {
    expect(extractBodyParamNames("Olá {{1}} e {{2}}")).toEqual([]);
    expect(extractBodyParamNames("Sem parâmetros nenhuns")).toEqual([]);
    expect(extractBodyParamNames(null)).toEqual([]);
  });
});

describe("countPositionalParams", () => {
  it("conta posicionais distintos", () => {
    expect(countPositionalParams("Olá {{1}}, {{2}} e outra vez {{1}}")).toBe(2);
    expect(countPositionalParams("Nada")).toBe(0);
    expect(countPositionalParams(undefined)).toBe(0);
  });
});

describe("analyzeTemplateEntry", () => {
  it("lê um template NOMEADO (o caso real que dava erro 100)", () => {
    const a = analyzeTemplateEntry(NAMED_ENTRY);
    expect(a.parameterFormat).toBe("NAMED");
    expect(a.paramNames).toEqual(["nome", "semana"]);
    expect(a.paramCount).toBe(2);
    expect(a.hasDynamicUrlButton).toBe(false);
    expect(a.language).toBe("pt_BR");
  });

  it("lê um template POSICIONAL", () => {
    const a = analyzeTemplateEntry(POSITIONAL_ENTRY);
    expect(a.parameterFormat).toBe("POSITIONAL");
    expect(a.paramNames).toEqual([]);
    expect(a.paramCount).toBe(2);
  });

  it("infere NAMED quando a Meta não declara parameter_format", () => {
    const a = analyzeTemplateEntry({
      name: "x",
      language: "pt_PT",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Olá {{nome}}" }],
    });
    expect(a.parameterFormat).toBe("NAMED");
    expect(a.paramNames).toEqual(["nome"]);
  });

  it("deteta o botão URL DINÂMICO e o seu índice; ignora botões estáticos", () => {
    const a = analyzeTemplateEntry(WITH_BUTTON_ENTRY);
    expect(a.hasDynamicUrlButton).toBe(true);
    expect(a.dynamicUrlButtonIndex).toBe(1); // o botão de telefone é o índice 0
    const staticBtn = analyzeTemplateEntry({
      ...WITH_BUTTON_ENTRY,
      components: [
        { type: "BODY", text: "Olá {{1}}!" },
        { type: "BUTTONS", buttons: [{ type: "URL", text: "Site", url: "https://multipark.pt" }] },
      ],
    });
    expect(staticBtn.hasDynamicUrlButton).toBe(false);
  });

  it("aguenta um template sem componentes e sem parâmetros", () => {
    const a = analyzeTemplateEntry({ name: "x", language: "pt_PT", status: "APPROVED" });
    expect(a.paramCount).toBe(0);
    expect(a.hasDynamicUrlButton).toBe(false);
  });
});

describe("selectTemplate", () => {
  it("encontra a tradução pedida", () => {
    const r = selectTemplate([NAMED_ENTRY, POSITIONAL_ENTRY], "disponibilidade_extras", "pt_BR");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.analysis.language).toBe("pt_BR");
  });

  it("compara a língua sem distinguir maiúsculas", () => {
    expect(selectTemplate([NAMED_ENTRY], "disponibilidade_extras", "PT_br").ok).toBe(true);
  });

  it("nome inexistente → not_found", () => {
    const r = selectTemplate([NAMED_ENTRY], "outro_nome", "pt_BR");
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("língua inexistente → lista as que EXISTEM (transforma o 132001 em instrução)", () => {
    const r = selectTemplate([NAMED_ENTRY], "disponibilidade_extras", "pt_PT");
    expect(r).toEqual({ ok: false, reason: "language_mismatch", availableLanguages: ["pt_BR"] });
    const msg = describeLookupFailure(r as any, "disponibilidade_extras", "pt_PT");
    expect(msg).toContain("pt_BR");
    expect(msg).toContain('NÃO na língua "pt_PT"');
  });

  it("template por aprovar → diz o estado atual", () => {
    const r = selectTemplate([{ ...NAMED_ENTRY, status: "PENDING" }], "disponibilidade_extras", "pt_BR");
    expect(r).toMatchObject({ ok: false, reason: "not_approved", status: "PENDING" });
    expect(describeLookupFailure(r as any, "disponibilidade_extras", "pt_BR")).toContain("PENDING");
  });
});

describe("buildBodyComponent", () => {
  const named = analyzeTemplateEntry(NAMED_ENTRY);
  const positional = analyzeTemplateEntry(POSITIONAL_ENTRY);

  it("NAMED: cada parâmetro leva parameter_name (a correção do erro 100)", () => {
    expect(buildBodyComponent(named, ["Rafael", "semana de 11/08"])).toEqual({
      type: "body",
      parameters: [
        { type: "text", parameter_name: "nome", text: "Rafael" },
        { type: "text", parameter_name: "semana", text: "semana de 11/08" },
      ],
    });
  });

  it("POSITIONAL: parâmetros simples, pela ordem", () => {
    expect(buildBodyComponent(positional, ["Rafael", "semana de 11/08"])).toEqual({
      type: "body",
      parameters: [
        { type: "text", text: "Rafael" },
        { type: "text", text: "semana de 11/08" },
      ],
    });
  });

  it("template de 1 parâmetro só recebe o nome, mesmo que haja {{2}} escrito", () => {
    const one = analyzeTemplateEntry({
      name: "x",
      language: "pt_PT",
      status: "APPROVED",
      parameter_format: "NAMED",
      components: [{ type: "BODY", text: "Olá {{nome}}" }],
    });
    expect(buildBodyComponent(one, ["Rafael", "ignorado"])).toEqual({
      type: "body",
      parameters: [{ type: "text", parameter_name: "nome", text: "Rafael" }],
    });
  });

  it("template sem parâmetros não leva componente de body", () => {
    const zero = analyzeTemplateEntry({ name: "x", language: "pt_PT", status: "APPROVED" });
    expect(buildBodyComponent(zero, ["Rafael"])).toBeNull();
  });
});

describe("validateTemplateUsage", () => {
  const named = analyzeTemplateEntry(NAMED_ENTRY);

  it("2 parâmetros sem 'Semana/dia' preenchido → erro que nomeia os parâmetros", () => {
    const msg = validateTemplateUsage(named, { hasBodyParam2: false, hasWeekStart: true });
    expect(msg).toContain("{{nome}}");
    expect(msg).toContain("{{semana}}");
    expect(msg).toContain("Semana/dia");
  });

  it("2 parâmetros com tudo preenchido → sem erro", () => {
    expect(validateTemplateUsage(named, { hasBodyParam2: true, hasWeekStart: true })).toBeNull();
  });

  it("1 parâmetro não exige o campo 'Semana/dia'", () => {
    const one = analyzeTemplateEntry({
      name: "x",
      language: "pt_PT",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Olá {{nome}}" }],
    });
    expect(validateTemplateUsage(one, { hasBodyParam2: false, hasWeekStart: false })).toBeNull();
  });

  it("mais de 2 parâmetros → recusa e lista-os", () => {
    const three = analyzeTemplateEntry({
      name: "x",
      language: "pt_PT",
      status: "APPROVED",
      components: [{ type: "BODY", text: "{{a}} {{b}} {{c}}" }],
    });
    const msg = validateTemplateUsage(three, { hasBodyParam2: true, hasWeekStart: true });
    expect(msg).toContain("3 parâmetros");
    expect(msg).toContain("{{c}}");
  });

  it("botão com link dinâmico sem semana escolhida → recusa", () => {
    const btn = analyzeTemplateEntry(WITH_BUTTON_ENTRY);
    expect(validateTemplateUsage(btn, { hasBodyParam2: true, hasWeekStart: false })).toContain("semana");
    expect(validateTemplateUsage(btn, { hasBodyParam2: true, hasWeekStart: true })).toBeNull();
  });
});

describe("buildComponents (integração das duas pontas)", () => {
  it("usa o formato NOMEADO quando há metadados", () => {
    const comps = buildComponents({
      analysis: analyzeTemplateEntry(NAMED_ENTRY),
      values: ["Rafael", "semana de 11/08"],
    }) as any[];
    expect(comps).toHaveLength(1);
    expect(comps[0].parameters[0]).toHaveProperty("parameter_name", "nome");
  });

  it("sem metadados mantém o comportamento antigo (posicional)", () => {
    const comps = buildComponents({ analysis: null, values: ["Rafael", "semana"] }) as any[];
    expect(comps[0]).toEqual({
      type: "body",
      parameters: [
        { type: "text", text: "Rafael" },
        { type: "text", text: "semana" },
      ],
    });
  });

  it("o botão usa o índice REAL do botão dinâmico do template", () => {
    const comps = buildComponents({
      analysis: analyzeTemplateEntry(WITH_BUTTON_ENTRY),
      values: ["Rafael"],
      buttonToken: "tok123",
    }) as any[];
    const button = comps.find((c: any) => c.type === "button");
    expect(button).toMatchObject({ sub_type: "url", index: "1" });
    expect(button.parameters[0].text).toBe("tok123");
  });

  it("template sem parâmetros e sem token não gera componentes", () => {
    const zero = analyzeTemplateEntry({ name: "x", language: "pt_PT", status: "APPROVED" });
    expect(buildComponents({ analysis: zero, values: ["Rafael"] })).toBeUndefined();
  });
});

describe("wabaIdsFromDebugToken", () => {
  const payload = (scopes: any[]) => ({ data: { granular_scopes: scopes } });

  it("prefere o scope de management", () => {
    expect(
      wabaIdsFromDebugToken(
        payload([
          { scope: "whatsapp_business_messaging", target_ids: ["999"] },
          { scope: "whatsapp_business_management", target_ids: ["123"] },
        ]),
      ),
    ).toEqual(["123"]);
  });

  it("usa messaging quando não há management", () => {
    expect(wabaIdsFromDebugToken(payload([{ scope: "whatsapp_business_messaging", target_ids: ["999"] }]))).toEqual(["999"]);
  });

  it("devolve vazio quando o token não revela contas", () => {
    expect(wabaIdsFromDebugToken(payload([{ scope: "pages_show_list", target_ids: ["1"] }]))).toEqual([]);
    expect(wabaIdsFromDebugToken({})).toEqual([]);
  });

  it("devolve todos quando são vários (o chamador trata como ambíguo)", () => {
    expect(
      wabaIdsFromDebugToken(payload([{ scope: "whatsapp_business_management", target_ids: ["1", "2", "1"] }])),
    ).toEqual(["1", "2"]);
  });
});
