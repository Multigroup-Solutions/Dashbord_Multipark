/**
 * P3 lote 14 — Atividade diária → Rádio → Serviços (páginas de terreno):
 * abas pelas permissões, identidade explícita (quem transcreveu, quem deu o
 * "feito", tipo de pessoa), limites e histórico (Rádio paginado, PDA retirado
 * em vez de apagado) e erro ≠ vazio.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  logs: [] as any[],
  pdaUpdates: [] as Array<[number, any]>,
  radioCreated: [] as any[],
  transcribed: [] as string[],
  lines: [] as any[],
  doneRows: [] as any[],
}));

const national = { all: true, defaultCityId: null, cityName: null, cityIds: [], projectIds: [], missingCostCenter: false };
vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: async () => national }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  logActivity: async (x: any) => { state.logs.push(x); },
  getPdaById: async (id: number) => (id === 7 ? { id: 7, name: "PDA 7", status: "active" } : undefined),
  updatePda: async (id: number, data: any) => { state.pdaUpdates.push([id, data]); },
  createRadioTranscription: async (x: any) => { state.radioCreated.push(x); return 99; },
  getDb: async () => ({ execute: async () => [state.doneRows] }),
}));
vi.mock("./radioAi", () => ({
  transcribeAndSummarizeRadio: async (url: string) => { state.transcribed.push(url); return { transcription: "olá", summary: "ok" }; },
}));
vi.mock("./opsStatsLive", async (original) => ({
  ...(await original<object>()),
  liveParkScope: async () => ({ parkIds: ["p1"], parkInfo: new Map([["p1", { name: "Airpark", city: "Lisboa" }]]) }),
}));
vi.mock("./multiparkDb/serviceExtras", async (original) => ({
  ...(await original<object>()),
  readServiceExtras: async () => state.lines,
}));

import { appRouter } from "./routers";
import { operationalAccess } from "../shared/operationalTabs";
import { serviceDoneState } from "../shared/serviceDone";
import { SERVICE_EXTRAS_LIMIT } from "./multiparkDb/serviceExtras";
import { scoreDocs, parseHelpDoc } from "./_core/ai/chat/retrieval";

const caller = (role = "admin") => appRouter.createCaller({ user: { id: 77, role }, req: { headers: {} }, res: {} } as any);
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const S3 = { AWS_S3_REGION: "eu-west-1", AWS_S3_BUCKET_NAME: "mp-bucket", AWS_S3_ACCESS_KEY: "k", AWS_S3_SECRET_ACCESS_KEY: "s" };
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  state.logs = []; state.pdaUpdates = []; state.radioCreated = []; state.transcribed = []; state.lines = []; state.doneRows = [];
  for (const [k, v] of Object.entries(S3)) { saved[k] = process.env[k]; process.env[k] = v; }
  saved.S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL;
  delete process.env.S3_PUBLIC_BASE_URL;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("Actividade Diária: abas pelas permissões (as do servidor)", () => {
  it("team leader e supervisor veem as quatro", () => {
    for (const role of ["team_leader", "supervisor", "admin"]) {
      expect(operationalAccess({ role } as any)).toEqual({ tabs: ["dia", "live", "history", "pdas"], ownSpeedOnly: false });
    }
  });
  it("condutor e extra: nenhuma aba, só o próprio histórico de velocidade", () => {
    for (const role of ["condutor", "extra"]) expect(operationalAccess({ role } as any)).toEqual({ tabs: [], ownSpeedOnly: true });
  });
  it("conta sem nada: nem abas nem histórico", () => {
    expect(operationalAccess({ role: "user" } as any)).toEqual({ tabs: [], ownSpeedOnly: false });
    expect(operationalAccess(null)).toEqual({ tabs: [], ownSpeedOnly: false });
  });
  it("a página usa a regra partilhada e não mostra abas que dariam 'sem dados'", () => {
    const page = src("client/src/pages/OperationalPage.tsx");
    expect(page).toContain("operationalAccess(user as any)");
    expect(page).toContain(`{has("dia") && <TabsTrigger value="dia">`);
    expect(page).toContain("O meu histórico de velocidade");
    expect(page).not.toContain("useRoleAtLeast");
  });
});

describe("PDAs: retirar = passar a Inativo, nunca apagar", () => {
  it("retira (status inativo) e regista quem e qual", async () => {
    const r = await caller().operational.pdas.delete({ id: 7 });
    expect(r).toEqual({ success: true, retired: true });
    expect(state.pdaUpdates).toEqual([[7, { status: "inactive" }]]);
    expect(state.logs[0]).toMatchObject({ action: "update", entity: "pda", entityId: 7, details: expect.stringContaining("PDA 7") });
  });
  it("PDA que não existe → NOT_FOUND, sem mexer", async () => {
    await expect(caller().operational.pdas.delete({ id: 8 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.pdaUpdates).toHaveLength(0);
  });
  it("só quem gere PDAs (team leader não)", async () => {
    await expect(caller("team_leader").operational.pdas.delete({ id: 7 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("o db.ts deixou de ter o DELETE dos PDAs; o histórico tem teto", async () => {
    expect(src("server/db.ts")).not.toContain("db.delete(pdas)");
    await expect(caller().operational.pdas.checkins.byPda({ pdaId: 7, limit: 5000 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("Rádio: só áudio do nosso storage; lista paginada", () => {
  it("endereço de fora → recusa ANTES de descarregar/gastar IA", async () => {
    await expect(caller().operational.radio.transcribe({ audioUrl: "http://169.254.169.254/latest/meta-data" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().operational.radio.transcribe({ audioUrl: "https://evil.example.com/a.mp3" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.transcribed).toHaveLength(0);
    expect(state.radioCreated).toHaveLength(0);
  });
  it("ficheiro do nosso bucket → transcreve e grava quem pediu e a duração", async () => {
    const url = "https://mp-bucket.s3.eu-west-1.amazonaws.com/uploads/1-a.mp3";
    const r = await caller().operational.radio.transcribe({ audioUrl: url, duration: 65 });
    expect(r.id).toBe(99);
    expect(state.transcribed).toEqual([url]);
    expect(state.radioCreated[0]).toMatchObject({ audioUrl: url, createdById: 77, duration: 65 });
  });
  it("lista: no máximo 200 por pedido", async () => {
    await expect(caller().operational.radio.list({ limit: 500 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("lista devolve quem é quem (condutor, quem transcreveu, viatura) e o cursor", () => {
    const db = src("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getRadioTranscriptions"), db.indexOf("export async function createRadioTranscription"));
    for (const k of ["employeeName: employees.fullName", "createdByName: users.name", "vehiclePlate: vehicles.plate", "lt(radioTranscriptions.id, filters.beforeId)", "nextCursor", ".limit(limit + 1)"]) {
      expect(fn).toContain(k);
    }
    const page = src("client/src/pages/RadioPage.tsx");
    expect(page).toContain("useInfiniteQuery");
    expect(page).toContain("Transcrição automática (API)");
    expect(page).toContain(`can(user as any, "radio", "edit")`);
  });
});

describe("Serviços: feito = Multipark OU cá, com quem e quando", () => {
  it("regra pura", () => {
    expect(serviceDoneState(true, null)).toMatchObject({ done: true, doneSource: "multipark", canReopen: false });
    // reaberto cá não desfaz o feito da Multipark (antes mostrava "Pendente")
    expect(serviceDoneState(true, { done: false, by: "Rui", at: "2026-10-02 10:00:00" })).toMatchObject({ done: true, doneSource: "multipark", canReopen: false });
    expect(serviceDoneState(false, { done: true, by: "Ana", at: "2026-10-02 13:32:00" })).toMatchObject({ done: true, doneSource: "local", localBy: "Ana", canReopen: true });
    expect(serviceDoneState(false, { done: false, by: "Ana", at: null })).toMatchObject({ done: false, doneSource: null, localBy: "Ana", canReopen: false });
    expect(serviceDoneState(false, undefined)).toMatchObject({ done: false, doneSource: null, localBy: null });
  });

  const line = (id: string, done = false) => ({
    lineId: id, bookingId: `b-${id}`, bookingNumber: "1", status: "BOOKED", checkOut: "2026-10-02 22:30:00", parkId: "p1",
    plate: "AA-00-BB", clientName: "Ana", serviceName: "Lavagem", price: 10, done,
  });

  it("a lista traz a fonte e quem marcou; feito na Multipark ganha ao reaberto cá", async () => {
    state.lines = [line("l1", true), line("l2"), line("l3")];
    state.doneRows = [
      { lineId: "l1", done: 0, updatedAt: "2026-10-02 09:00:00", userName: "Rui" },
      { lineId: "l2", done: 1, updatedAt: "2026-10-02 13:32:00", userName: "Ana" },
    ];
    const r = await caller().services.multiparkExtras({ startDate: "2026-10-02", endDate: "2026-10-02" });
    const by = Object.fromEntries(r.services.map((s: any) => [s.id, s]));
    expect(by.l1).toMatchObject({ done: true, doneSource: "multipark", canReopen: false });
    expect(by.l2).toMatchObject({ done: true, doneSource: "local", localBy: "Ana", localAt: "2026-10-02 13:32:00", canReopen: true });
    expect(by.l3).toMatchObject({ done: false, doneSource: null });
    expect(r.truncated).toBe(false);
  });

  it("no teto da leitura diz que a lista está cortada", async () => {
    state.lines = Array.from({ length: SERVICE_EXTRAS_LIMIT }, (_, i) => line(`x${i}`));
    const r = await caller().services.multiparkExtras({ startDate: "2026-10-01", endDate: "2026-10-31" });
    expect(r).toMatchObject({ truncated: true, limit: SERVICE_EXTRAS_LIMIT });
  });

  it("a página: só quem edita marca; o feito da Multipark não se reabre cá; CSV no dia de Lisboa", () => {
    const page = src("client/src/pages/ServicesPage.tsx");
    expect(page).toContain(`can(user as any, "servicos", "edit")`);
    expect(page).toContain("const clickable = canMark && (!s.done || s.canReopen);");
    expect(page).toContain("Feito na app Multipark");
    expect(page).toContain("lisbonDayOf(utcMs(s.checkOut))");
    expect(page).not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
    expect(page).toContain("setDoneMut.variables?.lineId === s.id");
  });
});

describe("erro ≠ vazio nas páginas de terreno", () => {
  it("Actividade Diária: atividade, dia da pessoa, GPS, velocidade, PDAs e histórico do PDA", () => {
    const page = src("client/src/pages/OperationalPage.tsx");
    for (const what of [`what="a atividade"`, `what="o dia desta pessoa"`, "what={`o GPS de ${selectedDate}`}", `what="o histórico de velocidade"`, `what="os PDAs"`, `what="o histórico deste PDA"`]) {
      expect(page).toContain(what);
    }
    // o dia da pessoa já não fica "A carregar…" para sempre
    expect(page).toContain("{dayQ.error && !d ? (");
    // cartões sem números: "—", nunca 0
    expect(page).not.toMatch(/\{stats\?\.totalDrivers \?\? 0\}/);
    expect(page).not.toMatch(/\{pdaList\?\.length \?\? 0\}/);
  });
  it("alertas de presença e mapa ao vivo", () => {
    const panel = src("client/src/components/OpsPresencePanel.tsx");
    expect(panel).toContain("{!isLoading && !failed && open.length === 0");
    const live = src("client/src/components/ZelloLiveTab.tsx");
    expect(live).toContain("<ZelloGoogleMap drivers={mapDrivers} />");
    const map = src("client/src/components/maps/ZelloGoogleMap.tsx");
    expect(map).toContain("label.textContent = driver.name");
    expect(map).toContain("title.textContent = driver.name");
    expect(map).toContain("row.textContent = line");
    expect(map).not.toMatch(/\.innerHTML\s*=/);
    expect(live).toContain(`what={locQ.data ?`);
  });
  it("Rádio e Serviços", () => {
    expect(src("client/src/pages/RadioPage.tsx")).toContain(`what="as transcrições"`);
    expect(src("client/src/pages/ServicesPage.tsx")).toContain(`what="os serviços"`);
  });
});

describe("ajuda: palavra-chave só de palavras vazias não acerta em tudo", () => {
  it("'ver mais' não apanha 'Como funciona isto?'", () => {
    const doc = parseHelpDoc("x.md", "---\nmodulo: x\ntitulo: X\npalavras: ver mais\n---\n# X\n\nTexto.");
    expect(scoreDocs([doc], "Como funciona isto?")[0].score).toBe(0);
  });
});
