/**
 * Caminho feliz de cada funcionalidade migrada para o runAi, com o SDK
 * @google/genai simulado: faturas, críticas (4 pontos de chamada partilham
 * draftReviewReply), rádio (transcrição + resumo), passagem de turno,
 * WhatsApp, documentos do RH e perguntas da formação.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  gen: vi.fn(),
  db: null as any,
  thread: null as any,
  updateEmployee: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: (...a: any[]) => h.gen(...a) };
    caches = { create: vi.fn() };
  },
}));
vi.mock("./db", () => ({
  getDb: async () => h.db,
  logActivity: h.logActivity,
  updateEmployee: h.updateEmployee,
  saveCareerExamAttempt: vi.fn(),
  saveQuizAttempt: vi.fn(),
}));
vi.mock("./whatsappInbox", async (orig) => ({ ...(await orig<any>()), getConversationThread: vi.fn(async () => h.thread) }));

import { setAiProvidersForTests } from "./_core/ai/client";
import { DEFAULT_GEMINI_MODELS } from "./_core/ai/models";
import { draftReviewReply } from "./_core/ai/reviewReply";
import { createFakeDb } from "./_core/ai/testUtils";
import { resetAiUsageCachesForTests } from "./_core/ai/usage";
import { invalidateSettingsCache } from "./appSettings";
import { autofillFromDocument, extractDocument } from "./documentAutofill";
import { extractInvoice } from "./expenseOcr";
import { transcribeAndSummarizeRadio } from "./radioAi";
import { generateAiSummary } from "./shiftHandoverAutomation";
import { generateQuizDrafts } from "./trainingAttempts";
import { aiAssist } from "./whatsappInboxOps";

const KEYS = ["GEMINI_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "AI_HR_AUTOFILL", "AI_ENABLED", "AI_MONTHLY_BUDGET_EUR"];
let saved: Record<string, string | undefined> = {};

function sdk(text: string) {
  return { text, candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80 } };
}
const call = (i = 0) => h.gen.mock.calls[i][0];
const partsText = (i = 0) => call(i).contents[0].parts.map((p: any) => p.text ?? "").join("\n");

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  h.gen.mockReset();
  h.updateEmployee.mockReset();
  h.logActivity.mockReset();
  h.db = createFakeDb();
  h.thread = null;
  setAiProvidersForTests(null);
  resetAiUsageCachesForTests();
  invalidateSettingsCache();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

const usageRows = () => h.db.queries.filter((q: any) => q.sql.includes("INSERT INTO ai_usage_log"));

describe("faturas (Despesas)", () => {
  const invoice = {
    supplier: "Galp Energia", customerName: "Multipark", selfInvoice: false, description: "Gasóleo", amount: "1.234,56 €",
    currency: "EUR", paymentMethod: "card", expenseDate: "2026-09-20", paymentDueDate: null, nif: "500697370", invoiceNumber: "FT 2026/123",
    suggestedCategory: "Combustível",
  };

  it("imagem → lite, JSON estruturado validado e valor normalizado", async () => {
    h.gen.mockResolvedValueOnce(sdk(JSON.stringify(invoice)));
    const r = await extractInvoice({ base64: "aW1n", mimeType: "image/jpeg", categoryNames: ["Combustível", "Portagens"], userId: 3 });
    expect(r).toMatchObject({ supplier: "Galp Energia", amount: "1234.56", paymentMethod: "card", nif: "500697370", suggestedCategory: "Combustível" });
    expect(call().model).toBe(DEFAULT_GEMINI_MODELS.lite);
    expect(call().config.responseMimeType).toBe("application/json");
    expect(call().contents[0].parts[0].inlineData).toEqual({ mimeType: "image/jpeg", data: "aW1n" });
    expect(partsText()).toContain("Combustível, Portagens");
    expect(usageRows()[0].params).toContain("expense_ocr");
  });

  it("PDF → fast (várias páginas) e inlineData application/pdf", async () => {
    h.gen.mockResolvedValueOnce(sdk(JSON.stringify(invoice)));
    await extractInvoice({ base64: "cGRm", mimeType: "application/pdf", categoryNames: [] });
    expect(call().model).toBe(DEFAULT_GEMINI_MODELS.fast);
    expect(call().contents[0].parts[0].inlineData.mimeType).toBe("application/pdf");
  });

  it("formato não suportado → erro com mensagem genérica, sem chamada", async () => {
    await expect(extractInvoice({ base64: "x", mimeType: "text/html", categoryNames: [] })).rejects.toMatchObject({ code: "unsupported" });
    expect(h.gen).not.toHaveBeenCalled();
  });
});

describe("críticas Google (um só prompt PT-PT)", () => {
  it("positiva: variante positiva, só o primeiro nome, sem dados pessoais", async () => {
    h.gen.mockResolvedValueOnce(sdk("\"Obrigado, Maria! Esperamos vê-la em breve.\""));
    const r = await draftReviewReply({ rating: 5, reviewerName: "Maria Silva Santos", reviewText: "Ótimo serviço, liguem-me 912345678" }, { reviewId: 9 });
    expect(r).toBe("Obrigado, Maria! Esperamos vê-la em breve.");
    expect(call().config.systemInstruction).toMatch(/positiva/);
    expect(call().config.systemInstruction).toMatch(/português de Portugal/);
    expect(partsText()).toContain("Maria");
    expect(partsText()).not.toMatch(/Silva|912345678/);
    expect(call().model).toBe(DEFAULT_GEMINI_MODELS.lite);
  });

  it("negativa: variante negativa (também lite) e a resposta pública nunca leva marcadores", async () => {
    h.gen.mockResolvedValueOnce(sdk("Lamentamos, João. Contacte-nos por [EMAIL_1] para resolvermos."));
    const r = await draftReviewReply({ rating: 1, reviewerName: "João", reviewText: "Riscaram o carro AA-12-BC! joao@mail.pt" });
    expect(call().config.systemInstruction).toMatch(/negativa/);
    expect(call().model).toBe(DEFAULT_GEMINI_MODELS.lite);
    expect(partsText()).not.toMatch(/AA-12-BC|joao@mail\.pt/);
    expect(r).not.toMatch(/\[EMAIL_1\]|joao@mail\.pt/);
  });
});

describe("rádio", () => {
  it("transcrição (áudio) + resumo lite com matrícula reposta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "audio/mpeg" } })));
    h.gen
      .mockResolvedValueOnce(sdk("O carro AA-12-BC está no piso 2."))
      .mockResolvedValueOnce(sdk("Carro [MATRICULA_1] no piso 2."));
    const r = await transcribeAndSummarizeRadio("https://zello.test/a.mp3", { userId: 5 });
    expect(r).toEqual({ transcription: "O carro AA-12-BC está no piso 2.", summary: "Carro AA-12-BC no piso 2." });
    expect(call(0).contents[0].parts[0].inlineData.mimeType).toBe("audio/mpeg");
    expect(partsText(1)).toContain("[MATRICULA_1]");
    expect(partsText(1)).not.toContain("AA-12-BC");
    expect(usageRows().map((q: any) => q.params[1])).toEqual(["radio_transcription", "radio_summary"]);
  });
});

describe("passagem de turno", () => {
  it("5 pontos; telefone das notas vai tapado e volta na resposta", async () => {
    h.gen.mockResolvedValueOnce(sdk("- Ligar ao cliente [TELEFONE_1]\n- Pico às 6h\n- Rever chaves\n- Caixa ok\n- Sem riscos"));
    const out = await generateAiSummary(null, {
      city: "lisbon",
      shift: { date: "2026-09-24", shift: "morning" },
      notes: "Cliente pede para ligar para 912 345 678",
      openItems: [],
    }, { throwOnError: true, userId: 1 });
    expect(out).toContain("• Ligar ao cliente 912 345 678");
    expect(out!.split("\n")).toHaveLength(5);
    expect(partsText()).not.toContain("912 345 678");
    expect(call().config.systemInstruction).toMatch(/team leader/);
  });
});

describe("WhatsApp", () => {
  it("sugestão de resposta: primeiro nome, email tapado e reposto (mensagem privada)", async () => {
    h.thread = {
      recipientFirstName: "Ana Costa",
      messages: [{ direction: "in", body: "Enviem a fatura para ana.costa@gmail.com por favor" }],
    };
    h.gen.mockResolvedValueOnce(sdk("Olá Ana! Enviamos já para [EMAIL_1]."));
    const r = await aiAssist(12, "reply", { userId: 2 });
    expect(r).toEqual({ ok: true, text: "Olá Ana! Enviamos já para ana.costa@gmail.com." });
    expect(partsText()).not.toContain("ana.costa@gmail.com");
    expect(partsText()).not.toContain("Costa");
  });

  it("erro do fornecedor → mensagem genérica", async () => {
    h.thread = { recipientFirstName: "Ana", messages: [{ direction: "in", body: "Olá" }] };
    h.gen.mockRejectedValue(Object.assign(new Error("quota do projeto xyz"), { status: 400 }));
    const r = await aiAssist(12, "summary");
    expect(r).toEqual({ ok: false, error: "A IA não respondeu. Tenta outra vez." });
  });
});

describe("documentos do RH", () => {
  const doc = { fullName: "Rui Almeida", nif: "123456789", birthDate: "1990-05-17", nationality: "Portuguesa", address: null, iban: null, documentNumber: "12345678", expiryDate: "2030-01-01" };

  it("desligado por omissão (RGPD): não chama a IA", async () => {
    const r = await autofillFromDocument({ employeeId: 1, docType: "id_card", mimeType: "image/png", base64: "eA==", userId: 1 });
    expect(r.skipped).toMatch(/desligada/);
    expect(h.gen).not.toHaveBeenCalled();
  });

  it("ligado: saída estruturada e preenche só campos vazios", async () => {
    process.env.AI_HR_AUTOFILL = "on";
    h.gen.mockResolvedValueOnce(sdk(JSON.stringify(doc)));
    h.db = createFakeDb((q) => (q.sql.includes("FROM employees") ? [[{ nif: null, birthDate: null, nationality: "Brasileira", address: null, nib: null }]] : [[]]));
    const r = await autofillFromDocument({ employeeId: 4, docType: "id_card", mimeType: "image/png", base64: "eA==", userId: 1 });
    expect(r.filled).toEqual(["NIF", "data de nascimento"]);
    expect(h.updateEmployee).toHaveBeenCalledWith(4, expect.objectContaining({ nif: "123456789", birthDate: "1990-05-17 00:00:00" }));
    expect(call().config.responseJsonSchema.properties.nif.type).toEqual(["string", "null"]);
  });

  it("extractDocument devolve null (sem lançar) se a resposta for inválida", async () => {
    process.env.AI_HR_AUTOFILL = "on";
    h.gen.mockResolvedValue(sdk("isto não é JSON"));
    expect(await extractDocument("image/png", "eA==")).toBeNull();
  });
});

describe("perguntas da formação", () => {
  it("fast, saída estruturada, filtra inválidas e grava rascunhos", async () => {
    const manual = { id: 7, title: "Segurança no parque", content: "A velocidade máxima no parque é 20 km/h. ".repeat(5), categoryId: 2, fileMimeType: null, fileKey: null, fileUrl: null };
    const fake = createFakeDb();
    let inserted: any[] = [];
    h.db = {
      queries: fake.queries,
      execute: fake.execute,
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [manual] }) }) }),
      insert: () => ({ values: async (v: any[]) => { inserted = v; } }),
    };
    h.gen.mockResolvedValueOnce(sdk(JSON.stringify({ questions: [
      { question: "Qual é a velocidade máxima no parque?", optionA: "10", optionB: "20 km/h", optionC: "30", optionD: "50", correctOption: "B", explanation: "Manual.", difficulty: "easy" },
      { question: "x", optionA: "", optionB: "", optionC: "", optionD: "", correctOption: "A", explanation: null, difficulty: null },
    ] })));
    const r = await generateQuizDrafts(7, 2, 1);
    expect(r).toMatchObject({ skipped: false, created: 1 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ correctOption: "B", published: 0, sourceManualId: 7 });
    expect(call().model).toBe(DEFAULT_GEMINI_MODELS.fast);
    expect(call().config.responseJsonSchema.properties.questions.type).toBe("array");
  });
});
