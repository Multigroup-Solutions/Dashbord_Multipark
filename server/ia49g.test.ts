/**
 * 49g (Jorge, 8 out 2026 — "avança com o 7, a IA a agir sozinha"):
 *  - passagem de turno: o resumo IA só ao ENTREGAR (1.ª gravação) e no
 *    "Resumir agora"; editar depois não chama a IA (fica "desatualizado");
 *  - quem vê a mais, garantido no SERVIDOR: a linha da IA dos Alertas não vai
 *    para condutores/extras; "Criar tarefas a partir de texto" só TL para
 *    cima; "Resumo IA" das leads só com Leads → editar.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({
  currentRow: null as any,
  updates: [] as Array<{ sql: string; params: unknown[] }>,
  anomalies: [] as any[],
  overrides: {} as Record<string, unknown>,
  runAi: vi.fn(),
  scoreLeads: vi.fn(async () => [] as any[]),
}));

const dialect = new MySqlDialect();
const fakeDb = {
  select: () => ({ from: async () => [{ id: 49, parentId: null, name: "Lisboa", level: "city" }] }),
  execute: async (q: any) => {
    const c = dialect.sqlToQuery(q);
    const text = c.sql;
    if (/^\s*UPDATE/.test(text)) { h.updates.push({ sql: text.replace(/\s+/g, " "), params: c.params }); return [{ affectedRows: 1 }]; }
    if (/FROM ops_anomalies/.test(text)) return [h.anomalies];
    if (/FROM `shift_handovers`/.test(text) && /`handoverDate` </.test(text)) return [[]];
    if (/FROM `shift_handovers`/.test(text)) return [h.currentRow ? [h.currentRow] : []];
    if (/FROM extra_leads/.test(text)) return [[{ id: 3, projectId: null }]];
    return [[]];
  },
};

vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => fakeDb,
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => h.overrides,
  logActivity: async () => {},
}));
const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./shiftHandoverDraft", async (original) => ({ ...(await original<object>()), buildHandoverDraft: async () => null }));
vi.mock("./notify", () => ({ notify: async () => ({ recipients: [], emailed: 0, duplicates: 0, city: null }) }));
vi.mock("./_core/ai/run", () => ({ runAi: (...a: any[]) => h.runAi(...a) }));
vi.mock("./_core/ai/status", async (original) => ({
  ...(await original<object>()),
  aiFeatureAvailable: () => true,
  aiFeatureAvailableFresh: async () => true,
}));
vi.mock("./aiOps/leadScoring", async (original) => ({ ...(await original<object>()), scoreLeads: (...a: any[]) => (h.scoreLeads as any)(...a) }));

import { appRouter } from "./routers";
import { afterHandoverSave, summarizeSavedHandover } from "./shiftHandoverAutomation";
import { currentAiSummary, handoverAiOnSave, handoverAiSummaryStale, legacyAiSummaryVersion } from "../shared/shiftHandoverAuto";
import { AI_TASKS_FROM_TEXT_FORBIDDEN, canUseAiTasksFromText, seesAiAlertExplanations } from "../shared/aiLimits";
import { filterBriefingFor, viewerPerms } from "./aiOps/briefing";
import { MIGRATION_0600_STATEMENTS, IDEMPOTENT_ERROR_CODES_0600 } from "./migrations/migration_0600";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (user: Record<string, unknown>) => appRouter.createCaller({ user: { id: 77, name: "Rita", ...user }, req: { headers: {} }, res: {} } as any);
const key = { handoverDate: "2026-10-08", shift: "morning" as const, city: "lisbon" as const };
const aiUpdates = () => h.updates.filter((u) => /`aiSummary` =|`aiSummaryVersion` =/.test(u.sql));

beforeEach(() => {
  h.currentRow = null;
  h.updates = [];
  h.anomalies = [];
  h.overrides = {};
  h.runAi.mockReset();
  h.runAi.mockResolvedValue({ output: "• Pico às 06h\n• 2 PDAs por entregar" });
  h.scoreLeads.mockClear();
});

// ─── 4. Passagem de turno ────────────────────────────────────────────────────
describe("4 — resumo da passagem: só ao entregar", () => {
  it("regras puras: entrega vs edição, desatualizado, resumos antigos", () => {
    expect(handoverAiOnSave("insert")).toBe(true);
    expect(handoverAiOnSave("update")).toBe(false);
    expect(handoverAiSummaryStale({ aiSummary: "• ok", aiSummaryVersion: 1, version: 2 })).toBe(true);
    expect(handoverAiSummaryStale({ aiSummary: "• ok", aiSummaryVersion: 2, version: 2 })).toBe(false);
    expect(handoverAiSummaryStale({ aiSummary: "• ok", aiSummaryVersion: null, version: 5 })).toBe(false); // antigo: em dia até à 1.ª edição
    expect(handoverAiSummaryStale({ aiSummary: "", aiSummaryVersion: 1, version: 3 })).toBe(false);
    expect(legacyAiSummaryVersion({ aiSummary: "• ok", aiSummaryVersion: null, version: 3 })).toBe(2);
    expect(legacyAiSummaryVersion({ aiSummary: "• ok", aiSummaryVersion: 2, version: 3 })).toBeNull();
    expect(legacyAiSummaryVersion({ aiSummary: null, aiSummaryVersion: null, version: 3 })).toBeNull();
    expect(currentAiSummary({ aiSummary: " • ok ", aiSummaryVersion: 3, version: 3 })).toBe("• ok");
    expect(currentAiSummary({ aiSummary: "• ok", aiSummaryVersion: 2, version: 3 })).toBeNull();
  });

  it("entregar (1.ª gravação) chama a IA uma vez e guarda o resumo com a versão", async () => {
    h.currentRow = { id: 5, version: 1, notes: "Tudo calmo", openItems: "[]", aiSummary: null, aiSummaryVersion: null, createdByName: "Rita" };
    const r = await afterHandoverSave({ key, mode: "insert", userId: 77, userName: "Rita" });
    expect(r.aiSummary).toBe(true);
    expect(h.runAi).toHaveBeenCalledTimes(1);
    expect(h.runAi.mock.calls[0][0]).toMatchObject({ feature: "handover_summary" });
    const u = aiUpdates();
    expect(u).toHaveLength(1);
    expect(u[0].sql).toContain("`aiSummary` = ?, `aiSummaryVersion` = ?");
    expect(u[0].params).toEqual(["• Pico às 06h\n• 2 PDAs por entregar", 1, 5]);
  });

  it("editar depois NÃO chama a IA (nem mexe no resumo)", async () => {
    h.currentRow = { id: 5, version: 3, notes: "Mudou", openItems: "[]", aiSummary: "• velho", aiSummaryVersion: 2 };
    const r = await afterHandoverSave({ key, mode: "update", userId: 77, userName: "Rita" });
    expect(r.aiSummary).toBe(false);
    expect(h.runAi).not.toHaveBeenCalled();
    expect(aiUpdates()).toHaveLength(0);
  });

  it("um resumo de antes da 0600 (sem versão) fica marcado como da versão anterior na 1.ª edição", async () => {
    h.currentRow = { id: 5, version: 3, notes: null, openItems: "[]", aiSummary: "• antigo", aiSummaryVersion: null };
    await afterHandoverSave({ key, mode: "update", userId: 77, userName: "Rita" });
    expect(h.runAi).not.toHaveBeenCalled();
    const u = aiUpdates();
    expect(u).toHaveLength(1);
    expect(u[0].sql).not.toContain("`aiSummary` =");
    expect(u[0].params).toEqual([2, 5]);
  });

  it("'Resumir agora': passagem por gravar ou fechada (24h) → recusa SEM chamar a IA", async () => {
    expect(await summarizeSavedHandover(key, { canEditOld: true, userId: 77 })).toEqual({ ok: false, reason: "not_saved" });
    h.currentRow = { id: 8, version: 2, ageMinutes: 3000, notes: "x", openItems: "[]" };
    expect(await summarizeSavedHandover(key, { canEditOld: false, userId: 77 })).toEqual({ ok: false, reason: "locked" });
    expect(h.runAi).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
  });

  it("'Resumir agora': resume o que está GRAVADO e guarda com a versão atual", async () => {
    h.currentRow = { id: 9, version: 4, ageMinutes: 30, notes: "Portão 2 avariado", openItems: "[]", aiSummary: "• velho", aiSummaryVersion: 2 };
    const r = await summarizeSavedHandover(key, { canEditOld: false, userId: 77 });
    expect(r).toMatchObject({ ok: true, id: 9, version: 4 });
    expect(h.runAi).toHaveBeenCalledTimes(1);
    expect(String(h.runAi.mock.calls[0][0].input)).toContain("Notas do team leader: Portão 2 avariado");
    expect(aiUpdates()[0].params).toEqual(["• Pico às 06h\n• 2 PDAs por entregar", 4, 9]);
  });

  it("a rota recusa antes de gravar a passagem e já não aceita notas do ecrã", async () => {
    await expect(caller({ role: "team_leader" }).shiftHandover.aiSummary({ date: "2026-10-08", shift: "morning", city: "lisbon" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Guarda primeiro a passagem") });
    expect(h.runAi).not.toHaveBeenCalled();
    await expect(caller({ role: "condutor" }).shiftHandover.aiSummary({ date: "2026-10-08", shift: "morning", city: "lisbon" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("migração 0600, lista e ecrã", () => {
    expect(MIGRATION_0600_STATEMENTS).toEqual(["ALTER TABLE `shift_handovers` ADD COLUMN `aiSummaryVersion` INT NULL AFTER `aiSummary`"]);
    expect(IDEMPOTENT_ERROR_CODES_0600.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(src("server/db.ts")).toContain("aiSummaryStale: handoverAiSummaryStale(r)");
    const page = src("client/src/pages/ShiftHandoverPage.tsx");
    expect(page).toContain("onGenerate={() => ai.mutate({ date, shift, city })}");
    expect(src("client/src/components/ShiftHandoverDraftPanel.tsx")).toContain("Resumir agora");
    expect(src("client/src/components/ShiftHandoverDraftPanel.tsx")).toContain("Resumo desatualizado");
  });
});

// ─── 5. Quem vê a mais (servidor) ────────────────────────────────────────────
describe("5 — quem vê a mais, garantido no servidor", () => {
  const anomaly = { id: 1, day: "2026-10-07", domain: "bookings", kind: "park_drop", cityKey: "lisbon", subject: "P1", value: 3, expected: 20, zScore: -3, severity: "critical", detail: "P1: 3 reservas (normal 20)", explanation: "Provavelmente o parque esteve fechado.", refIds: null, dismissedAt: null };

  it("regras puras: TL para cima", () => {
    for (const r of ["user", "extra", "condutor"]) { expect(seesAiAlertExplanations(r), r).toBe(false); expect(canUseAiTasksFromText(r), r).toBe(false); }
    for (const r of ["team_leader", "supervisor", "frontoffice", "backoffice", "admin", "super_admin"]) { expect(seesAiAlertExplanations(r), r).toBe(true); expect(canUseAiTasksFromText(r), r).toBe(true); }
    expect(seesAiAlertExplanations(null)).toBe(false);
  });

  it("Alertas: o condutor vê o alerta mas não a linha da IA; o team leader vê as duas", async () => {
    h.anomalies = [anomaly];
    const mine = await caller({ role: "condutor" }).aiOps.anomalies({ domain: "bookings" });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ detail: anomaly.detail, explanation: null });
    const tl = await caller({ role: "team_leader" }).aiOps.anomalies({ domain: "bookings" });
    expect(tl[0].explanation).toBe(anomaly.explanation);
  });

  it("briefing: a linha da IA das anomalias também sai para condutor/extra (com acesso dado à parte)", () => {
    const data: any = { sla: { complaintsDueToday: 0, complaintsOverdue: 0, incidentsDueToday: 0, incidentsOverdue: 0, items: [] }, anomalies: [{ domain: "bookings", severity: "warning", detail: "d", explanation: "IA" }], marketingAlerts: [] };
    const condutor = viewerPerms({ role: "condutor" } as any);
    expect(condutor.aiExplanations).toBe(false);
    expect(filterBriefingFor(data, condutor).anomalies).toEqual([{ domain: "bookings", severity: "warning", detail: "d", explanation: null }]);
    expect(filterBriefingFor(data, viewerPerms({ role: "supervisor" } as any)).anomalies[0].explanation).toBe("IA");
  });

  it("'Criar tarefas a partir de texto': o servidor recusa a extras e condutores (sem chamar a IA)", async () => {
    for (const role of ["extra", "condutor"]) {
      await expect(caller({ role }).tasks.proposeFromText({ text: "Repor os rolos do MB amanhã de manhã." }))
        .rejects.toMatchObject({ code: "FORBIDDEN", message: AI_TASKS_FROM_TEXT_FORBIDDEN });
    }
    expect(h.runAi).not.toHaveBeenCalled();
    const tasksRouter = src("server/tasksRouter.ts");
    expect(tasksRouter).toContain("if (!canUseAiTasksFromText(u.role)) throw new TRPCError({ code: \"FORBIDDEN\", message: AI_TASKS_FROM_TEXT_FORBIDDEN });");
    expect(src("client/src/pages/TasksPage.tsx")).toContain("canEdit && canUseAiTasksFromText(user?.role)");
  });

  it("'Resumo IA' das leads: só quem edita as leads (com custo); quem só lê é recusado", async () => {
    h.overrides = { leads_extras: { access: "city", actions: ["view"] } };
    await expect(caller({ role: "team_leader" }).aiOps.leads.summarize({ leadIds: [3] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.scoreLeads).not.toHaveBeenCalled();
    h.overrides = {};
    await caller({ role: "team_leader" }).aiOps.leads.summarize({ leadIds: [3] });
    expect(h.scoreLeads).toHaveBeenCalledTimes(1);
    expect((h.scoreLeads.mock.calls[0] as any[])[1]).toMatchObject({ withSummary: true });
    // a pontuação (sem IA) continua para quem só lê
    h.overrides = { leads_extras: { access: "city", actions: ["view"] } };
    await caller({ role: "team_leader" }).aiOps.leads.scores({ leadIds: [3] });
    expect(src("client/src/components/aiOps/LeadScoreCell.tsx")).toContain(") : canEdit && (");
  });
});

// ─── 7. Definições: ao lado dos interruptores do RH ──────────────────────────
describe("7 — Definições dizem onde está a IA", () => {
  it("os dois interruptores do RH trazem a nota; os outros não", async () => {
    const list = await caller({ role: "admin" }).settings.flags.list();
    const hr = list.filter((f) => f.euVertex);
    expect(hr.map((f) => f.name).sort()).toEqual(["AI_HR_AUTOFILL", "AI_HR_EMAIL_ATTACHMENTS"]);
    for (const f of hr) expect(f.euVertex!.text).toMatch(/^Só corre com a IA em Vertex AI na UE \(hoje: /);
    expect(list.find((f) => f.name === "AI_RADIO")?.euVertex).toBeNull();
    expect(src("client/src/pages/DefinicoesPage.tsx")).toContain("{f.euVertex.text}");
  });
});

// ─── 6. Base de conhecimento: textos ─────────────────────────────────────────
describe("6 — a base de conhecimento diz que sincroniza sozinha", () => {
  it("ecrã, integrações e lista dos crons", () => {
    expect(src("client/src/pages/KnowledgeBasePage.tsx")).toContain("Sincroniza sozinha quando há alterações nas pastas do Drive");
    expect(src("client/src/pages/KnowledgeBasePage.tsx")).not.toContain("sem agenda automática");
    expect(src("server/integrationsStatus.ts")).toContain("sincronizam sozinhas quando há alterações nas pastas do Drive");
    expect(src("shared/appSettings.ts")).toContain("(sozinha quando há alterações nas pastas do Drive)");
  });
});

// ─── 8. Documentação ─────────────────────────────────────────────────────────
describe("8 — inventário e ajuda", () => {
  it("o inventário tem as decisões de 8 out 2026", () => {
    const inv = src("docs/ia-inventario.md");
    expect(inv).toContain("## Decidido a 8 out 2026");
    expect(inv).toContain("as conversas com histórico ficam onde estão");
    expect(inv).toContain("**só ao entregar**");
    expect(inv).toContain("Vertex AI numa região da UE");
    const help = src("docs/ajuda/ia-no-dashboard.md");
    expect(help).toContain("Resumir agora");
    expect(help).toContain("só correm com a IA em Vertex AI na UE");
  });
});
