/**
 * Assistente (chat da equipa), com a IA simulada:
 *  - function calling no runAi (SDK @google/genai simulado);
 *  - permissões das ferramentas (cidade e financeiro);
 *  - limite de pedidos, interruptor desligado;
 *  - escolha do ficheiro de ajuda, corte do histórico;
 *  - ajuda gerada em dia com docs/ajuda.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  gen: vi.fn(),
  db: null as any,
  logActivity: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: (...a: any[]) => h.gen(...a) };
    caches = { create: vi.fn(async () => { throw Object.assign(new Error("curto"), { status: 400 }); }) };
  },
}));
vi.mock("../db", () => ({
  getDb: async () => h.db,
  logActivity: h.logActivity,
  getUserPermissionOverrides: async () => ({}),
}));

import type { CityAccess } from "../cityAccess";
import { setAiProvidersForTests } from "../_core/ai/client";
import { resetContextCacheForTests } from "../_core/ai/contextCache";
import { runAi } from "../_core/ai/run";
import { resetRateLimitMemoryForTests } from "../_core/ai/rateLimit";
import { resetAiUsageCachesForTests } from "../_core/ai/usage";
import { createFakeProvider, okResponse } from "../_core/ai/testUtils";
import { runChatTurn } from "../_core/ai/chat/engine";
import { trimHistory } from "../_core/ai/chat/history";
import { pickHelpDocs } from "../_core/ai/chat/retrieval";
import { availableTools, makeToolExecutor } from "../_core/ai/chat/tools";
import { invalidateSettingsCache } from "../appSettings";
import { assistantSuggestions } from "../../shared/assistant";
import { readAjudaFiles, renderGenerated } from "../../scripts/gen-ajuda";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { askAssistant, staffHelpDocs, staffSystemPrompt } from "./service";
import { STAFF_TOOLS, resolveCityArg, type StaffToolCtx } from "./tools";

const KEYS = ["GEMINI_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "AI_ENABLED", "AI_ASSISTANT", "AI_MONTHLY_BUDGET_EUR", "AI_PROVIDER"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  h.gen.mockReset();
  h.logActivity.mockReset();
  h.db = null;
  setAiProvidersForTests(null);
  resetAiUsageCachesForTests();
  resetRateLimitMemoryForTests();
  resetContextCacheForTests();
  invalidateSettingsCache();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setAiProvidersForTests(null);
});

const LISBOA: CityAccess = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10, 11, 12], missingCostCenter: false };
const ALL: CityAccess = { all: true, defaultCityId: null, cityNames: ["Lisboa", "Porto", "Faro"], cityIds: [10, 20, 30], projectIds: [10, 11, 12, 20, 30], missingCostCenter: false };

function ctxFor(role: string, access: CityAccess | undefined, call = vi.fn(async () => ({})), financeAllowed = false): StaffToolCtx & { call: ReturnType<typeof vi.fn> } {
  return { user: { id: 7, role }, access, call, today: "2026-09-24", financeAllowed, helpDocs: staffHelpDocs() } as any;
}

// ─── runAi: function calling (SDK simulado) ─────────────────────────────────

describe("runAi com ferramentas (Gemini function calling)", () => {
  it("declara as ferramentas, executa a chamada e devolve o resultado com o conteúdo do modelo tal e qual", async () => {
    const modelContent = { role: "model", parts: [{ functionCall: { id: "c1", name: "contar", args: { cidade: "Lisboa" } }, thoughtSignature: "sig==" }] };
    h.gen
      .mockResolvedValueOnce({ candidates: [{ content: modelContent, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 10 } })
      .mockResolvedValueOnce({ text: "Há **5** reservas.", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 350, candidatesTokenCount: 12 } });
    const execute = vi.fn(async () => ({ total: 5 }));
    const r = await runAi({
      feature: "assistant",
      system: "Regras",
      history: [{ role: "user", text: "Olá" }, { role: "model", text: "Olá!" }],
      input: "Quantas reservas?",
      tools: { declarations: [{ name: "contar", description: "Conta", parameters: { type: "object", properties: { cidade: { type: "string" } } } }], execute },
    });
    expect(r.output).toBe("Há **5** reservas.");
    expect(r.toolCalls).toEqual([{ id: "c1", name: "contar", args: { cidade: "Lisboa" } }]);
    expect(execute).toHaveBeenCalledWith({ id: "c1", name: "contar", args: { cidade: "Lisboa" } });
    const first = h.gen.mock.calls[0][0];
    expect(first.config.tools[0].functionDeclarations[0]).toMatchObject({ name: "contar", parametersJsonSchema: { type: "object" } });
    expect(first.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
    const second = h.gen.mock.calls[1][0];
    expect(second.contents[3]).toEqual(modelContent); // thoughtSignature devolvida
    expect(second.contents[4]).toEqual({ role: "user", parts: [{ functionResponse: { id: "c1", name: "contar", response: { total: 5 } } }] });
    expect(r.usage.inputTokens).toBe(650);
  });

  it("uma ferramenta que rebenta não parte o pedido (o modelo recebe um erro genérico)", async () => {
    const provider = createFakeProvider("gemini", [
      { ...okResponse(""), toolCalls: [{ name: "x", args: {} }], raw: { role: "model", parts: [] } },
      okResponse("Não consegui obter os dados."),
    ]);
    setAiProvidersForTests({ gemini: provider });
    const r = await runAi({ feature: "assistant", input: "?", tools: { declarations: [{ name: "x", description: "x" }], execute: async () => { throw new Error("SQL secreto"); } } });
    expect(r.output).toBe("Não consegui obter os dados.");
    expect(provider.calls[1].toolRounds?.[0].results[0].response).toEqual({ error: "Não foi possível obter estes dados." });
  });

  it("para ao fim do máximo de voltas", async () => {
    const provider = createFakeProvider("gemini", [{ ...okResponse(""), toolCalls: [{ name: "x", args: {} }] }]);
    setAiProvidersForTests({ gemini: provider });
    await expect(runAi({ feature: "assistant", input: "?", tools: { declarations: [{ name: "x", description: "x" }], execute: async () => ({}), maxRounds: 2 } }))
      .rejects.toMatchObject({ code: "invalid_output" });
    expect(provider.calls).toHaveLength(3);
  });
});

// ─── Permissões das ferramentas ─────────────────────────────────────────────

describe("ferramentas: permissões e cidades", () => {
  it("sem acesso ao financeiro, a ferramenta financeira nem é declarada", () => {
    const names = (c: StaffToolCtx) => availableTools(STAFF_TOOLS, c).map((t) => t.name);
    expect(names(ctxFor("supervisor", LISBOA))).not.toContain("financeiro_totais");
    expect(names(ctxFor("supervisor", LISBOA))).toContain("reservas_resumo");
    expect(names(ctxFor("super_admin", ALL, undefined, true))).toContain("financeiro_totais");
    // extra: sem reservas, com as suas tarefas e avaliação
    expect(names(ctxFor("extra", LISBOA))).toEqual(expect.arrayContaining(["abrir_ajuda", "minhas_tarefas", "minha_avaliacao"]));
    expect(names(ctxFor("extra", LISBOA))).not.toContain("reservas_resumo");
  });

  it("executar a ferramenta financeira sem acesso → erro, sem consultar nada", async () => {
    const c = ctxFor("supervisor", LISBOA);
    const exec = makeToolExecutor(STAFF_TOOLS, c);
    const r = await exec({ name: "financeiro_totais", args: { de: "2026-09-01", ate: "2026-09-24" } });
    expect(r).toHaveProperty("error");
    expect(c.call).not.toHaveBeenCalled();
  });

  it("utilizador de Lisboa não consegue dados do Porto (nem ferramentas inventadas)", async () => {
    const c = ctxFor("supervisor", LISBOA);
    const exec = makeToolExecutor(STAFF_TOOLS, c);
    for (const name of ["reservas_resumo", "casos_abertos", "extras_escala"]) {
      const r = await exec({ name, args: { cidade: "Porto" } });
      expect(r.error).toMatch(/Não tens acesso aos dados de Porto/);
    }
    expect(await exec({ name: "apagar_tudo", args: {} })).toHaveProperty("error");
    expect(c.call).not.toHaveBeenCalled();
  });

  it("a cidade da pessoa passa como projectId; sem cidade não se alarga nada", async () => {
    const call = vi.fn(async () => ({ actions: { checkin: { count: 3, revenue: 999, byCity: [{ name: "Lisboa", count: 3, revenue: 999 }], byPark: [] } } }));
    const c = ctxFor("supervisor", LISBOA, call);
    const exec = makeToolExecutor(STAFF_TOOLS, c);
    const r = await exec({ name: "reservas_resumo", args: { cidade: "lisboa", de: "2026-09-24" } });
    expect(call).toHaveBeenCalledWith("multipark.operationsSummary", { startDate: "2026-09-24", endDate: "2026-09-24", projectId: 10 });
    expect(JSON.stringify(r)).not.toContain("999"); // sem valores em euros
    await exec({ name: "reservas_resumo", args: {} });
    expect(call).toHaveBeenLastCalledWith("multipark.operationsSummary", { startDate: "2026-09-24", endDate: "2026-09-24" });
  });

  it("recusa do servidor (FORBIDDEN) vira mensagem para o modelo", async () => {
    const call = vi.fn(async () => { throw Object.assign(new Error("Acesso não autorizado."), { code: "FORBIDDEN" }); });
    const exec = makeToolExecutor(STAFF_TOOLS, ctxFor("supervisor", LISBOA, call));
    expect(await exec({ name: "whatsapp_pendentes", args: {} })).toEqual({ error: "Sem permissão para ver estes dados." });
  });

  it("sem centro de custos: nenhuma consulta", () => {
    expect(() => resolveCityArg(undefined, "Lisboa")).toThrow(/centro de custos/);
    expect(() => resolveCityArg({ ...LISBOA, missingCostCenter: true }, null)).toThrow();
    expect(resolveCityArg(ALL, "Faro")).toEqual({ projectId: 30, name: "Faro" });
  });

  it("listas curtas: no máximo 20 tarefas, sem descrição", async () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `T${i}`, description: "segredo", taskStatus: "todo", taskPriority: "medium", dueDate: null }));
    const call = vi.fn(async (path: string) => (path === "tasks.list" ? tasks : { overdue: 2 }));
    const r: any = await makeToolExecutor(STAFF_TOOLS, ctxFor("extra", LISBOA, call as any))({ name: "minhas_tarefas", args: {} });
    expect(r.tarefas).toHaveLength(20);
    expect(r).toMatchObject({ porFazer: 30, emAtraso: 2, total: 30 });
    expect(JSON.stringify(r)).not.toContain("segredo");
  });

  it("regista cada chamada de ferramenta (nome + parâmetros) em activity_logs, sem resultados", async () => {
    const provider = createFakeProvider("gemini", [
      { ...okResponse(""), toolCalls: [{ name: "whatsapp_pendentes", args: {} }] },
      okResponse("Tens 4 conversas por responder."),
    ]);
    setAiProvidersForTests({ gemini: provider });
    const call = vi.fn(async () => ({ attention: 4, overdue: 1, slaMinutes: 30 }));
    const logs: any[] = [];
    const r = await askAssistant({ question: "Quantas conversas de WhatsApp tenho?" }, ctxFor("supervisor", LISBOA, call), {
      logToolCall: async (name, args) => { logs.push({ name, args }); },
    });
    expect(r).toMatchObject({ ok: true, answer: "Tens 4 conversas por responder.", toolsUsed: ["whatsapp_pendentes"] });
    expect(logs).toEqual([{ name: "whatsapp_pendentes", args: {} }]);
    expect(JSON.stringify(logs)).not.toContain("attention");
  });
});

// ─── Limites, interruptor, entrada ──────────────────────────────────────────

describe("custo e segurança", () => {
  const base = {
    feature: "assistant" as const, channel: "staff" as const, ownerKey: "user:7", userId: 7, system: "S",
    rateKey: "assistant:user:7", limits: { perMinute: 2, perDay: 100, maxInputChars: 50 },
  };

  it("limite por minuto: a 3.ª pergunta é recusada sem chamar a IA", async () => {
    const provider = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: provider });
    expect(await runChatTurn({ ...base, question: "a" })).toMatchObject({ ok: true });
    expect(await runChatTurn({ ...base, question: "b" })).toMatchObject({ ok: true });
    const third = await runChatTurn({ ...base, question: "c" });
    expect(third).toMatchObject({ ok: false, reason: "rate_limited" });
    expect((third as any).message).toMatch(/Muitas perguntas/);
    expect(provider.calls).toHaveLength(2);
  });

  it("pergunta demasiado longa ou vazia → recusada antes de tudo", async () => {
    const provider = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: provider });
    expect(await runChatTurn({ ...base, question: "x".repeat(51) })).toMatchObject({ ok: false, reason: "too_long" });
    expect(await runChatTurn({ ...base, question: "   " })).toMatchObject({ ok: false, reason: "empty" });
    expect(provider.calls).toHaveLength(0);
  });

  it("interruptor AI_ASSISTANT desligado → mensagem amigável, sem pedidos", async () => {
    process.env.AI_ASSISTANT = "off";
    const provider = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: provider });
    const r = await runChatTurn({ ...base, question: "Olá" });
    expect(r).toMatchObject({ ok: false, reason: "disabled" });
    expect((r as any).message).toMatch(/desligado/);
    expect(provider.calls).toHaveLength(0);
  });

  it("sem IA configurada → mensagem amigável", async () => {
    delete process.env.GEMINI_API_KEY;
    expect(await runChatTurn({ ...base, question: "Olá" })).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("dados pessoais escritos à mão não vão para a IA e voltam na resposta", async () => {
    const provider = createFakeProvider("gemini", [async (req) => okResponse(`Recebido: ${JSON.stringify(req.parts)}`.includes("[EMAIL_1]") ? "Escreve a [EMAIL_1]." : "falhou")]);
    setAiProvidersForTests({ gemini: provider });
    const r = await runChatTurn({ ...base, limits: { ...base.limits, maxInputChars: 500 }, question: "Posso escrever a ana@exemplo.pt?" });
    expect(r).toMatchObject({ ok: true, answer: "Escreve a ana@exemplo.pt." });
    expect(JSON.stringify(provider.calls[0].parts)).not.toContain("ana@exemplo.pt");
  });

  it("usa a cache de contexto para o prompt estável (e segue sem ela se falhar)", async () => {
    const create = vi.fn(async () => ({ name: "cachedContents/a", expiresAt: Date.now() + 3_600_000 }));
    const p = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: { ...p, generate: p.generate, createCache: create } as any });
    await askAssistant({ question: "Como pico o ponto?" }, ctxFor("extra", LISBOA));
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as any)[0]).toMatchObject({ system: staffSystemPrompt() });
    expect((create.mock.calls[0] as any)[0].tools.map((t: any) => t.name)).toContain("minhas_tarefas");
    expect(p.calls[0].cachedContent).toBe("cachedContents/a");
  });
});

// ─── Ajuda e histórico ──────────────────────────────────────────────────────

describe("ajuda: escolha do ficheiro", () => {
  const docs = staffHelpDocs();
  const pick = (q: string, path?: string) => pickHelpDocs(docs, q, { path }).map((d) => d.file);

  it("tem um ficheiro por módulo pedido", () => {
    expect(docs.map((d) => d.file).sort()).toEqual([
      "comunicacao.md", "contactos.md", "definicoes.md", "despesas.md", "disponibilidade.md", "drive.md", "extras-dia.md", "faturacao.md", "formacao.md", "marketing.md",
      "ocorrencias.md", "passagem-turno.md", "perdidos.md", "permissoes.md", "reclamacoes.md", "rh-ponto.md", "tarefas.md", "whatsapp.md",
    ]);
  });

  it.each([
    ["Como pico o ponto?", "rh-ponto.md"],
    ["Como ponho os clientes do serviço no meu telemóvel para saber quem liga?", "contactos.md"],
    ["Como exporto a faturação para o Google Sheets?", "drive.md"],
    ["Como gero um contrato a partir de um modelo do Google Docs?", "drive.md"],
    ["Como marco a minha disponibilidade para a semana?", "disponibilidade.md"],
    ["O que é a janela de 24h no WhatsApp?", "whatsapp.md"],
    ["Como preencho a passagem de turno?", "passagem-turno.md"],
    ["Como registo uma despesa com a fatura?", "despesas.md"],
    ["Como crio uma reclamação?", "reclamacoes.md"],
    ["Como devolvo um objeto perdido ao cliente?", "perdidos.md"],
    ["O que é o fecho previsto?", "faturacao.md"],
    ["Como dou acesso a um módulo a uma pessoa?", "permissoes.md"],
    ["Como faço o exame de carreira?", "formacao.md"],
    ["Como escalo o team leader no extras dia?", "extras-dia.md"],
  ])("%s → %s", (q, file) => {
    expect(pick(q)[0]).toBe(file);
  });

  it("pergunta vaga de 'como se usa' → o ficheiro da página aberta", () => {
    expect(pick("Como funciona isto?", "/tarefas")).toEqual(["tarefas.md"]);
    expect(pick("Quantas reservas há hoje?", "/tarefas")).toEqual([]);
    expect(pick("Quanto é 2 mais 2?")).toEqual([]);
  });

  it("a ajuda escolhida vai no pedido (e só essa)", async () => {
    const p = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: p });
    const r = await askAssistant({ question: "Como pico o ponto?", path: "/rh" }, ctxFor("extra", LISBOA));
    expect(r).toMatchObject({ ok: true, helpFiles: ["rh-ponto.md"] });
    const text = (p.calls[0].parts[0] as any).text as string;
    expect(text).toContain('<ajuda ficheiro="rh-ponto.md">');
    expect(text).not.toContain("extras-dia.md");
    expect(text).toContain("Hoje: 2026-09-24");
  });

  it("docs/ajuda e o ficheiro gerado estão em dia (pnpm tsx scripts/gen-ajuda.ts)", () => {
    const gen = readFileSync(resolve(__dirname, "helpDocs.generated.ts"), "utf8");
    expect(gen).toBe(renderGenerated(readAjudaFiles()));
  });

  it("sugestões por página, filtradas pelo acesso", () => {
    expect(assistantSuggestions("/extras-dia", "supervisor")[0]).toMatch(/escalados/);
    expect(assistantSuggestions("/extras-dia", "extra").join(" ")).not.toMatch(/escalados/);
    expect(assistantSuggestions("/qualquer", "extra").length).toBeGreaterThan(0);
  });
});

describe("histórico: últimos N turnos + resumo", () => {
  const conv = Array.from({ length: 10 }, (_, i) => [
    { role: "user" as const, content: `pergunta ${i}` },
    { role: "assistant" as const, content: `resposta ${i}` },
  ]).flat();

  it("mantém os últimos N turnos e resume as perguntas antigas", () => {
    const r = trimHistory(conv, { maxTurns: 3 });
    expect(r.turns.map((t) => t.text)).toEqual(["pergunta 7", "resposta 7", "pergunta 8", "resposta 8", "pergunta 9", "resposta 9"]);
    expect(r.turns[1].role).toBe("model");
    expect(r.dropped).toBe(14);
    expect(r.summary).toContain("pergunta 0");
    expect(r.summary).not.toContain("pergunta 7");
  });

  it("começa sempre numa pergunta, corta mensagens longas e limita o resumo", () => {
    const r = trimHistory([{ role: "assistant", content: "órfã" }, { role: "user", content: "x".repeat(5000) }], { maxTurns: 5, maxCharsPerMessage: 100 });
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0].text.length).toBeLessThanOrEqual(100);
    const many = Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, content: `q${i} ${"y".repeat(100)}` }));
    expect(trimHistory(many, { maxTurns: 1, summaryChars: 300 }).summary!.length).toBeLessThanOrEqual(300);
  });

  it("sem turnos anteriores → sem resumo", () => {
    expect(trimHistory([], {})).toEqual({ turns: [], summary: null, dropped: 0 });
  });
});

describe("conversas na BD", () => {
  it("todas as leituras filtram pelo dono e pelos 30 dias (parâmetros, sem concatenar)", async () => {
    const { createFakeDb } = await import("../_core/ai/testUtils");
    const { loadMessages, listConversations, resolveConversation, deleteConversation } = await import("../_core/ai/chat/store");
    h.db = createFakeDb(() => [[]]);
    await loadMessages("staff", "user:7", 5);
    await listConversations("staff", "user:7");
    await resolveConversation("staff", "user:7", { conversationId: 99 });
    await deleteConversation("staff", "user:7", 5);
    for (const q of h.db.queries) {
      expect(q.params).toContain("user:7");
      expect(q.sql).not.toContain("user:7");
    }
    expect(h.db.queries[0].sql).toMatch(/c\.ownerKey = \? AND m\.createdAt >= \?/);
    // conversa pedida que não é da pessoa → não cria nem devolve
    expect(await resolveConversation("staff", "user:7", { conversationId: 99 })).toBeNull();
    expect(h.db.queries.some((q: any) => q.sql.startsWith("INSERT"))).toBe(false);
  });
});
