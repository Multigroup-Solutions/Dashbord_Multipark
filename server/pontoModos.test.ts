/**
 * Plano 63, passo 1 — modo do ponto na ficha (sem regras novas).
 *  - histórico com "a partir de" (datas, substituições);
 *  - guardas: só o super admin, mês fechado, extras fora dos modos 1/2, modos
 *    2/3 só a partir de hoje, "sempre em serviço" sem entrada aberta, motivo;
 *  - NULL = igual a hoje; o rasto das picagens não muda nada nas contas;
 *  - avisos lidos ("Li" e papel), alertas (quem vê), juntar fichas com modos;
 *  - interruptor PONTO_MODOS desligado por omissão (só o super admin), migração 0720.
 */
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PONTO_ALERT_KINDS, PONTO_MODOS_FLAG, PONTO_NOTICES, isPontoNoticeKey, latestAck, noticeForMode, pontoAlertDedupeKey,
  pontoAlertVisible, pontoModeChangeCheck, pontoModeChangeError, pontoModeEarliestFrom, pontoModeLabel, pontoModeMergeWarning,
  pontoModeOn, pontoModeStateWarnings, pontoModeTimeline, pontoTrailColumns, pontoTrailInputSchema, type PontoModeChangeInput, type PontoModeEntry,
} from "../shared/pontoMode";
import { AUTOMATION_FLAGS, automationFlagDefault, automationFlagSuperAdminOnly } from "../shared/appSettings";
import { operationalDayOf } from "../shared/lisbonDay";
import { pairShifts, countableShifts, type TimeRecordLike } from "./payroll/shifts";
import { pairPonto, type PontoRecord } from "./evaluationCore";
import {
  PontoModeError, pontoModeView, pontoTrailForRecord, recordPontoNoticeAck, reviewPontoAlert, setPontoMode,
  type PontoAlertRow, type PontoModeStore,
} from "./pontoModes";
import { MIGRATION_0720_STATEMENTS, IDEMPOTENT_ERROR_CODES_0720 } from "./migrations/migration_0720";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { ownRecordEmployeeId } from "./cityAccess";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");

const TODAY = "2026-10-15";
const entry = (id: number, mode: PontoModeEntry["mode"], effectiveFrom: string): PontoModeEntry => ({ id, mode, effectiveFrom });
const base = (o: Partial<PontoModeChangeInput> = {}): PontoModeChangeInput => ({
  actorRole: "super_admin",
  employee: { position: "backoffice", contractType: "permanent", zelloUsername: "rui.z", hasMultiparkAgent: true, isActive: 1 },
  history: [],
  mode: "fixed",
  effectiveFrom: TODAY,
  today: TODAY,
  closedMonths: new Set(["2026-08"]),
  hasOpenCheckIn: false,
  note: "passa a back office",
  ...o,
});

describe("histórico: o modo de cada dia", () => {
  it("sem linhas = sem modo (as regras de hoje)", () => {
    expect(pontoModeOn(TODAY, [])).toBeNull();
    expect(pontoModeLabel(null)).toBe("Sem modo — regras de hoje");
  });

  it("cada linha vale a partir do seu dia, até à seguinte", () => {
    const h = [entry(1, "fixed", "2026-09-01"), entry(2, "exempt", "2026-10-10")];
    expect(pontoModeOn("2026-08-31", h)).toBeNull();
    expect(pontoModeOn("2026-09-01", h)).toBe("fixed");
    expect(pontoModeOn("2026-10-09", h)).toBe("fixed");
    expect(pontoModeOn("2026-10-10", h)).toBe("exempt");
    expect(pontoModeOn("2026-12-01", h)).toBe("exempt");
  });

  it("voltar a sem modo é uma linha com o modo vazio", () => {
    const h = [entry(1, "fixed", "2026-09-01"), entry(2, null, "2026-10-01")];
    expect(pontoModeOn("2026-09-30", h)).toBe("fixed");
    expect(pontoModeOn("2026-10-01", h)).toBeNull();
  });

  it("uma mudança gravada depois com data anterior substitui as seguintes (ficam no histórico, marcadas)", () => {
    const h = [entry(1, "fixed", "2026-09-01"), entry(2, null, "2026-10-10"), entry(3, "fixed", "2026-10-05")];
    expect(pontoModeOn("2026-10-12", h)).toBe("fixed");
    expect(pontoModeTimeline(h).map((e) => e.superseded)).toEqual([false, true, false]);
  });

  it("no mesmo dia ganha a última gravada", () => {
    const h = [entry(1, "fixed", TODAY), entry(2, "always_on", TODAY)];
    expect(pontoModeOn(TODAY, h)).toBe("always_on");
  });

  it("um valor estranho na BD conta como sem modo", () => {
    expect(pontoModeOn(TODAY, [entry(1, "turbo", "2026-01-01")])).toBeNull();
  });
});

describe("guardas da mudança", () => {
  it("só o super admin", () => {
    for (const role of ["admin", "backoffice", "supervisor", "team_leader", "user"]) {
      expect(pontoModeChangeError(base({ actorRole: role }))).toMatch(/Só o super admin/);
    }
    expect(pontoModeChangeError(base())).toBeNull();
  });

  it("datas: dia válido, nunca no futuro, no máximo um ano para trás", () => {
    expect(pontoModeChangeError(base({ effectiveFrom: "2026-10-16" }))).toMatch(/futuro/);
    expect(pontoModeChangeError(base({ effectiveFrom: "2026-02-30" }))).toMatch(/AAAA-MM-DD/);
    expect(pontoModeChangeError(base({ effectiveFrom: "15/10/2026" }))).toMatch(/AAAA-MM-DD/);
    expect(pontoModeChangeError(base({ effectiveFrom: "2025-10-01", closedMonths: new Set() }))).toMatch(/demasiado antigo/);
    // o horário fixo pode ir para trás dentro de um mês aberto
    expect(pontoModeChangeError(base({ effectiveFrom: "2026-09-20" }))).toBeNull();
  });

  it("mês fechado não muda", () => {
    const closed = new Set(["2026-09"]);
    expect(pontoModeChangeError(base({ effectiveFrom: "2026-09-20", closedMonths: closed }))).toMatch(/setembro de 2026 já está fechado/);
    expect(pontoModeChangeError(base({ effectiveFrom: "2026-10-01", closedMonths: closed }))).toBeNull();
    // um mês fechado no meio também trava (agosto aberto, setembro fechado)
    expect(pontoModeChangeError(base({ effectiveFrom: "2026-08-20", closedMonths: closed }))).toMatch(/setembro/);
  });

  it("extras recusados nos modos 1 e 2; o 3 aceita-os com o aviso de que não paga", () => {
    for (const employee of [{ position: "extra", contractType: "extra" }, { position: "driver", contractType: "extra" }, { position: "extra", contractType: "permanent" }]) {
      const emp = { ...employee, zelloUsername: "z", hasMultiparkAgent: true };
      expect(pontoModeChangeError(base({ employee: emp, mode: "fixed" }))).toMatch(/extras não têm horário fixo nem isenção/);
      expect(pontoModeChangeError(base({ employee: emp, mode: "exempt" }))).toMatch(/extras/);
      const c = pontoModeChangeCheck(base({ employee: emp, mode: "always_on" }));
      expect(c.error).toBeNull();
      expect(c.warnings.join(" ")).toMatch(/não pagam/);
    }
  });

  it("modos 2 e 3 só a partir de hoje — pôr e tirar", () => {
    expect(pontoModeChangeError(base({ mode: "exempt", effectiveFrom: "2026-10-14" }))).toMatch(/só valem a partir de hoje/);
    expect(pontoModeChangeError(base({ mode: "always_on", effectiveFrom: "2026-10-01" }))).toMatch(/só valem a partir de hoje/);
    expect(pontoModeChangeError(base({ mode: "exempt" }))).toBeNull();
    // tirar a isenção para trás também não
    const h = [entry(1, "exempt", "2026-10-01")];
    expect(pontoModeChangeError(base({ history: h, mode: null, effectiveFrom: "2026-10-10" }))).toMatch(/só valem a partir de hoje/);
    expect(pontoModeChangeError(base({ history: h, mode: "fixed", effectiveFrom: "2026-10-05" }))).toMatch(/só valem a partir de hoje/);
    expect(pontoModeChangeError(base({ history: h, mode: null }))).toBeNull();
    // o horário fixo para trás só por cima de dias sem modo ou com horário fixo
    expect(pontoModeChangeError(base({ history: [entry(1, "exempt", "2026-09-01"), entry(2, null, "2026-10-01")], mode: "fixed", effectiveFrom: "2026-10-02" }))).toBeNull();
  });

  it("nada muda → recusa", () => {
    expect(pontoModeChangeError(base({ mode: null }))).toMatch(/Nada muda/);
    expect(pontoModeChangeError(base({ history: [entry(1, "fixed", "2026-10-01")], mode: "fixed" }))).toMatch(/Nada muda/);
  });

  it("sempre em serviço: sem entrada aberta; sem Zello ou agente só avisa", () => {
    expect(pontoModeChangeError(base({ mode: "always_on", hasOpenCheckIn: true }))).toMatch(/entrada do ponto aberta/);
    const c = pontoModeChangeCheck(base({ mode: "always_on", employee: { position: "driver", contractType: "permanent", zelloUsername: null, hasMultiparkAgent: false } }));
    expect(c.error).toBeNull();
    expect(c.warnings.join(" ")).toMatch(/Sem conta Zello/);
    expect(c.warnings.join(" ")).toMatch(/Sem agente da Multipark/);
    // o horário fixo com a entrada aberta passa
    expect(pontoModeChangeError(base({ mode: "fixed", hasOpenCheckIn: true }))).toBeNull();
  });

  it("o motivo é obrigatório", () => {
    expect(pontoModeChangeError(base({ note: "  " }))).toMatch(/motivo/);
    expect(pontoModeChangeError(base({ note: "ok" }))).toMatch(/motivo/);
  });

  it("o dia mais antigo que o cartão deixa escolher", () => {
    const closed = new Set(["2026-08"]);
    expect(pontoModeEarliestFrom({ mode: "fixed", currentMode: null, today: TODAY, closedMonths: closed })).toBe("2026-09-01");
    expect(pontoModeEarliestFrom({ mode: "fixed", currentMode: null, today: TODAY, closedMonths: new Set(["2026-09"]) })).toBe("2026-10-01");
    expect(pontoModeEarliestFrom({ mode: "fixed", currentMode: null, today: TODAY, closedMonths: new Set(["2026-10"]) })).toBe(TODAY);
    expect(pontoModeEarliestFrom({ mode: "exempt", currentMode: null, today: TODAY, closedMonths: closed })).toBe(TODAY);
    expect(pontoModeEarliestFrom({ mode: null, currentMode: "always_on", today: TODAY, closedMonths: closed })).toBe(TODAY);
    // sem nenhum fecho, no máximo um ano para trás
    const far = pontoModeEarliestFrom({ mode: "fixed", currentMode: null, today: TODAY, closedMonths: new Set() });
    expect(far >= "2025-10-14").toBe(true);
    expect(pontoModeChangeError(base({ effectiveFrom: far, closedMonths: new Set() }))).toBeNull();
  });

  it("o dia mais antigo nunca passa por cima de dias em isenção ou \"sempre em serviço\" (o servidor recusava)", () => {
    const history = [entry(1, "exempt", "2026-09-10"), entry(2, null, "2026-10-08")];
    const e = pontoModeEarliestFrom({ mode: "fixed", currentMode: null, today: TODAY, closedMonths: new Set(["2026-08"]), history });
    expect(e).toBe("2026-10-08");
    expect(pontoModeChangeError(base({ history, effectiveFrom: e }))).toBeNull();
    expect(pontoModeChangeError(base({ history, effectiveFrom: "2026-10-07" }))).toMatch(/só valem a partir de hoje/);
    // só horário fixo para trás → o limite é o do mês aberto
    expect(pontoModeEarliestFrom({ mode: "fixed", currentMode: null, today: TODAY, closedMonths: new Set(["2026-08"]), history: [entry(1, "fixed", "2026-09-10"), entry(2, null, "2026-10-08")] })).toBe("2026-09-01");
  });

  it("avisos do modo de hoje: extra em horário fixo ou isenção (o posto mudou depois); extra em \"sempre em serviço\" não paga", () => {
    expect(pontoModeStateWarnings("fixed", { position: "extra", contractType: "extra" }).join(" ")).toMatch(/É extra e está em "1 · Horário fixo"/);
    expect(pontoModeStateWarnings("exempt", { position: "driver", contractType: "extra" }).join(" ")).toMatch(/É extra e está em "2 · Isenção"/);
    expect(pontoModeStateWarnings("always_on", { position: "extra", contractType: "extra" }).join(" ")).toMatch(/não pagam/);
    expect(pontoModeStateWarnings("fixed", { position: "backoffice", contractType: "permanent" })).toEqual([]);
    expect(pontoModeStateWarnings(null, { position: "extra", contractType: "extra" })).toEqual([]);
  });
});

describe("fuso e dia operacional (03:00; mudança da hora a 25 out 2026)", () => {
  it("na noite da mudança da hora, até às 03:00 de Lisboa ainda é o dia 24; às 03:00 passa a 25", () => {
    // 25 out 2026: às 02:00 de verão (01:00 UTC) o relógio volta à 01:00 — a hora 01:xx acontece duas vezes
    expect(operationalDayOf(Date.parse("2026-10-25T00:30:00Z"))).toBe("2026-10-24"); // 01:30 de verão
    expect(operationalDayOf(Date.parse("2026-10-25T01:30:00Z"))).toBe("2026-10-24"); // 01:30 de inverno (a 2.ª)
    expect(operationalDayOf(Date.parse("2026-10-25T02:59:00Z"))).toBe("2026-10-24"); // 02:59 de inverno
    expect(operationalDayOf(Date.parse("2026-10-25T03:00:00Z"))).toBe("2026-10-25"); // 03:00 de inverno
    // antes da mudança, as 03:00 de Lisboa são as 02:00 UTC
    expect(operationalDayOf(Date.parse("2026-10-24T01:59:00Z"))).toBe("2026-10-23");
    expect(operationalDayOf(Date.parse("2026-10-24T02:00:00Z"))).toBe("2026-10-24");
  });

  it("às 02:30 do dia 25 (inverno) ainda não se pode pôr um modo a partir de 25; às 03:00 já", async () => {
    const { store } = memStore();
    const at0230 = Date.parse("2026-10-25T02:30:00Z");
    await expect(setPontoMode(store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "exempt", effectiveFrom: "2026-10-25", note: "abc", nowMs: at0230 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ok = await setPontoMode(store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "exempt", effectiveFrom: "2026-10-25", note: "abc", nowMs: Date.parse("2026-10-25T03:00:00Z") });
    expect(ok.current).toBe("exempt");
  });

  it("a cópia em employees.pontoMode é sempre o modo de HOJE: sem datas no futuro, não há nada que mude sozinho à meia-noite", async () => {
    const { store, st } = memStore();
    // pôr "a partir de amanhã" é recusado — não fica nenhuma linha à espera
    await expect(setPontoMode(store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "fixed", effectiveFrom: "2026-10-16", note: "abc", nowMs: NOW })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(st.history).toHaveLength(0);
    // para trás: a cópia é o modo de hoje (não o da data escolhida)
    await setPontoMode(store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "fixed", effectiveFrom: "2026-10-01", note: "abc", nowMs: NOW });
    expect(st.cache).toBe("fixed");
    for (const day of ["2026-10-16", "2026-11-01", "2027-01-01"]) expect(pontoModeOn(day, st.history as PontoModeEntry[])).toBe("fixed");
  });
});

describe("o rasto das picagens não muda nada nas contas", () => {
  const recs: TimeRecordLike[] = [
    { id: 1, type: "check_in", recordedAt: "2026-10-12 07:00:00", reviewStatus: "ok" },
    { id: 2, type: "check_out", recordedAt: "2026-10-12 16:30:00", hoursWorked: "9.50", reviewStatus: "ok" },
    { id: 3, type: "check_in", recordedAt: "2026-10-17 21:00:00", reviewStatus: "ok" },
    { id: 4, type: "check_out", recordedAt: "2026-10-18 07:00:00", hoursWorked: "10.00", reviewStatus: "suspicious", notes: "[SUSPEITO] x" },
    { id: 5, type: "check_in", recordedAt: "2026-10-19 08:00:00", reviewStatus: "ok" },
  ];
  const withTrail = (mode: string | null) => recs.map((r, i) => ({
    ...r, pontoMode: mode, photoSource: i % 2 ? "file" : "camera", photoFileAgeS: i * 999, gpsAccuracyM: 1500, createdByUserId: 77,
  }));

  it("ordenado: os turnos e as horas que contam são iguais com e sem rasto, em qualquer modo", () => {
    const plain = pairShifts(recs);
    for (const mode of [null, "fixed", "exempt", "always_on"]) {
      const t = pairShifts(withTrail(mode) as TimeRecordLike[]);
      expect(t).toEqual(plain);
      expect(countableShifts(t.shifts)).toEqual(countableShifts(plain.shifts));
    }
  });

  it("Avaliação: igual com e sem rasto", () => {
    const ev = recs.map((r) => ({ ...r, employeeId: 9 })) as PontoRecord[];
    const plain = pairPonto(ev);
    for (const mode of [null, "fixed", "exempt", "always_on"]) {
      expect(pairPonto(withTrail(mode).map((r) => ({ ...r, employeeId: 9 })) as PontoRecord[])).toEqual(plain);
    }
  });

  it("nenhuma conta de horas, ordenado, Avaliação ou custo dos extras lê as colunas do rasto", () => {
    for (const f of ["server/payroll/compute.ts", "server/payroll/shifts.ts", "server/payroll/payrollData.ts", "shared/pontoHours.ts", "server/evaluationCore.ts", "server/finance/extrasCost.ts"]) {
      expect(src(f), f).not.toMatch(/photoSource|photoFileAgeS|gpsAccuracyM|createdByUserId/);
    }
  });

  it("as colunas do rasto: a selfie só com foto, a idade só num ficheiro, valores limpos", () => {
    expect(pontoTrailColumns({ input: { photoSource: "camera", photoFileAgeS: 50, gpsAccuracyM: 12.6 }, hasPhoto: true, actorUserId: 5, mode: "fixed" }))
      .toEqual({ pontoMode: "fixed", photoSource: "camera", photoFileAgeS: null, gpsAccuracyM: 13, createdByUserId: 5 });
    expect(pontoTrailColumns({ input: { photoSource: "file", photoFileAgeS: -30, gpsAccuracyM: -1 }, hasPhoto: true, actorUserId: 5, mode: null }))
      .toEqual({ pontoMode: null, photoSource: "file", photoFileAgeS: 0, gpsAccuracyM: 0, createdByUserId: 5 });
    expect(pontoTrailColumns({ input: { photoSource: "file", photoFileAgeS: 99 }, hasPhoto: false, actorUserId: 5, mode: null }))
      .toMatchObject({ photoSource: null, photoFileAgeS: null });
    expect(pontoTrailColumns({ input: { photoSource: "hack" as any, gpsAccuracyM: Number.NaN }, hasPhoto: true, actorUserId: 0, mode: null }))
      .toMatchObject({ photoSource: null, gpsAccuracyM: null, createdByUserId: null });
    expect(pontoTrailColumns({ input: null, hasPhoto: true, actorUserId: 3, mode: "always_on" }))
      .toEqual({ pontoMode: "always_on", photoSource: null, photoFileAgeS: null, gpsAccuracyM: null, createdByUserId: 3 });
  });

  it("interruptor desligado → a picagem fica como até aqui (sem colunas novas); ligado → com o modo do dia", async () => {
    const off = await pontoTrailForRecord({ employeeId: 1, actorUserId: 2, input: { photoSource: "camera", gpsAccuracyM: 20 }, hasPhoto: true, enabled: async () => false });
    expect(off).toEqual({});
    const now = Date.parse("2026-10-15T10:00:00Z");
    const store = async () => ({ history: async () => [entry(1, "fixed", "2026-10-01")] as any });
    const on = await pontoTrailForRecord({ employeeId: 1, actorUserId: 2, input: { photoSource: "camera", gpsAccuracyM: 20 }, hasPhoto: true, nowMs: now, enabled: async () => true, store });
    expect(on).toEqual({ pontoMode: "fixed", photoSource: "camera", photoFileAgeS: null, gpsAccuracyM: 20, createdByUserId: 2 });
    // o histórico a falhar nunca impede o ponto
    const broken = await pontoTrailForRecord({ employeeId: 1, actorUserId: 2, hasPhoto: false, enabled: async () => true, store: async () => { throw new Error("BD"); } });
    expect(broken).toMatchObject({ pontoMode: null, createdByUserId: 2 });
  });

  it("nenhum ficheiro do servidor lê as colunas do rasto, fora do modo do ponto (lista fechada)", () => {
    const root = resolve(import.meta.dirname, "..");
    const allowed = new Set([
      "shared/pontoMode.ts", "server/pontoModes.ts", "server/pontoModesRouter.ts", "server/employeeMerge.ts",
      "server/migrations/migration_0720.ts", "drizzle/schema.ts",
    ]);
    const files = globSync("{server,shared,drizzle}/**/*.ts", { cwd: root }).map((f) => f.replaceAll("\\", "/"))
      .filter((f) => !f.endsWith(".test.ts") && !allowed.has(f));
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      const text = src(f);
      if (/\b(photoSource|photoFileAgeS|gpsAccuracyM)\b/.test(text)) offenders.push(f);
      // o modo e a conta que picou, lidos de uma picagem (timeRecords.x / time_records … x)
      if (/timeRecords\.(pontoMode|createdByUserId)\b|time_records[^;]{0,400}\b(pontoMode|createdByUserId)\b/.test(text)) offenders.push(f);
    }
    // o rhRouter só recebe o rasto (o esquema tolerante) e passa-o ao pontoTrailForRecord
    const r = src("server/rhRouter.ts");
    expect(r.match(/\b(photoSource|photoFileAgeS|gpsAccuracyM)\b/g) ?? []).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it("o rasto que chega é tolerante: um valor estranho fica vazio em vez de recusar a picagem", () => {
    expect(pontoTrailInputSchema.parse(undefined)).toBeUndefined();
    expect(pontoTrailInputSchema.parse({ photoSource: "camera", photoFileAgeS: null, gpsAccuracyM: 12 })).toEqual({ photoSource: "camera", photoFileAgeS: null, gpsAccuracyM: 12 });
    for (const bad of [{ photoSource: 5 }, { gpsAccuracyM: "doze" }, { photoFileAgeS: Number.NaN }, { gpsAccuracyM: Number.POSITIVE_INFINITY }, { photoSource: "x".repeat(40) }, "lixo", 42, null]) {
      expect(() => pontoTrailInputSchema.parse(bad)).not.toThrow();
      expect(pontoTrailInputSchema.parse(bad)).toBeUndefined();
    }
  });

  it("a entrada e a saída do ponto gravam o rasto (só pelo pontoTrailForRecord) e aceitam-no sem nunca recusar", () => {
    const r = src("server/rhRouter.ts");
    const checkIn = r.slice(r.indexOf("    checkIn: protectedProcedure"), r.indexOf("    checkOut: protectedProcedure"));
    const checkOut = r.slice(r.indexOf("    checkOut: protectedProcedure"), r.indexOf("    monthlyHours:"));
    for (const block of [checkIn, checkOut]) {
      expect(block).toContain("trail: pontoTrailInputSchema,");
      expect(block).toContain("await pontoTrailForRecord({ employeeId: input.employeeId, actorUserId: ctx.user.id, input: input.trail,");
      expect(block).toContain("...trail,");
    }
    // os dois ecrãs do ponto mandam o rasto
    expect(src("client/src/components/DashboardLayout.tsx")).toContain("trail: { photoSource: meta?.source ?? null");
    expect(src("client/src/pages/HRPage.tsx")).toContain("trail: { photoSource: meta?.source ?? null");
    expect(src("client/src/components/CameraCapture.tsx")).toContain('setPreviewMeta({ source: "file", fileAgeS: ageS })');
  });
});

// ─── Serviço com a BD em memória ─────────────────────────────────────────────

function memStore(o: { history?: any[]; acks?: any[]; alerts?: PontoAlertRow[]; closed?: Set<string> | "fail"; openCheckIn?: boolean; employee?: any } = {}) {
  const st = {
    history: [...(o.history ?? [])],
    acks: [...(o.acks ?? [])],
    alerts: [...(o.alerts ?? [])],
    cache: undefined as string | null | undefined,
    logs: [] as any[],
    reviewed: [] as any[],
  };
  const store: PontoModeStore = {
    employee: async (id) => (id === 404 ? null : { id, fullName: "Ana", position: "backoffice", contractType: "permanent", zelloUsername: "ana.z", isActive: true, hasMultiparkAgent: true, ...(o.employee ?? {}) }),
    history: async () => st.history.map((h) => ({ ...h })),
    insertHistory: async (row) => { const id = st.history.length + 1; st.history.push({ id, ...row }); return id; },
    setCachedMode: async (_id, mode) => { st.cache = mode; },
    hasOpenCheckIn: async () => !!o.openCheckIn,
    closedMonths: async () => { if (o.closed === "fail") throw new Error("BD"); return o.closed ?? new Set<string>(); },
    acks: async () => st.acks.map((a) => ({ ...a })),
    insertAck: async (row) => { st.acks.push({ id: st.acks.length + 1, ...row }); },
    alerts: async () => st.alerts,
    alertById: async (id) => st.alerts.find((a) => a.id === id) ?? null,
    reviewAlert: async (id, patch) => { st.reviewed.push({ id, ...patch }); },
    userNames: async (ids) => new Map(ids.map((i) => [i, `Pessoa ${i}`])),
    log: async (e) => { st.logs.push(e); },
  };
  return { store, st };
}
const NOW = Date.parse("2026-10-15T10:00:00Z");
const alert = (id: number, kind: string, o: Partial<PontoAlertRow> = {}): PontoAlertRow => ({
  id, employeeId: 7, kind, day: "2026-10-14", timeRecordId: null, detail: null, severity: "amber", status: "open",
  reviewedById: null, reviewedAt: null, reviewNote: null, createdAt: null, ...o,
});

describe("mudar o modo (servidor)", () => {
  it("grava uma linha no histórico, a cópia do modo de hoje e o registo de atividade", async () => {
    const { store, st } = memStore();
    const r = await setPontoMode(store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "fixed", effectiveFrom: "2026-10-01", note: " passa a back office ", nowMs: NOW });
    expect(r).toMatchObject({ mode: "fixed", current: "fixed" });
    expect(st.history).toEqual([expect.objectContaining({ employeeId: 7, mode: "fixed", effectiveFrom: "2026-10-01", note: "passa a back office", setById: 1, setAt: "2026-10-15 10:00:00" })]);
    expect(st.cache).toBe("fixed");
    expect(st.logs[0]).toMatchObject({ entity: "employee_ponto_mode", entityId: 7, action: "update" });
    expect(st.logs[0].details).toContain("Sem modo — regras de hoje → 1 · Horário fixo a partir de 2026-10-01");
  });

  it("recusa quem não é super admin, a ficha que não existe, as guardas e meses fechados por ler", async () => {
    const { store, st } = memStore();
    await expect(setPontoMode(store, { actor: { id: 1, role: "admin" }, employeeId: 7, mode: "fixed", effectiveFrom: TODAY, note: "abc", nowMs: NOW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setPontoMode(store, { actor: { id: 1, role: "super_admin" }, employeeId: 404, mode: "fixed", effectiveFrom: TODAY, note: "abc", nowMs: NOW })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(setPontoMode(store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "exempt", effectiveFrom: "2026-10-01", note: "abc", nowMs: NOW })).rejects.toBeInstanceOf(PontoModeError);
    const fail = memStore({ closed: "fail" });
    await expect(setPontoMode(fail.store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "fixed", effectiveFrom: TODAY, note: "abc", nowMs: NOW })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const ext = memStore({ employee: { position: "extra", contractType: "extra" } });
    await expect(setPontoMode(ext.store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "fixed", effectiveFrom: TODAY, note: "abc", nowMs: NOW })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(st.history).toHaveLength(0);
  });

  it("extra em \"sempre em serviço\": grava e avisa que as horas automáticas não pagam", async () => {
    const { store, st } = memStore({ employee: { position: "extra", contractType: "extra" } });
    const r = await setPontoMode(store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "always_on", effectiveFrom: TODAY, note: "reformado", nowMs: NOW });
    expect(r.warnings.join(" ")).toMatch(/não pagam/);
    expect(st.cache).toBe("always_on");
  });

  it("o dia de hoje é o dia operacional (a madrugada até às 03:00 ainda é ontem)", async () => {
    const at = Date.parse("2026-10-16T01:30:00Z"); // 02:30 em Lisboa
    expect(operationalDayOf(at)).toBe("2026-10-15");
    const { store } = memStore();
    await expect(setPontoMode(store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "exempt", effectiveFrom: "2026-10-16", note: "abc", nowMs: at })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(setPontoMode(store, { actor: { id: 1, role: "super_admin" }, employeeId: 7, mode: "exempt", effectiveFrom: "2026-10-15", note: "abc", nowMs: at })).resolves.toMatchObject({ current: "exempt" });
  });
});

describe("avisos lidos (\"Li\")", () => {
  it("cada modo tem o seu aviso; sem modo não há aviso", () => {
    expect(noticeForMode("fixed")).toBe("fixed_v1");
    expect(noticeForMode("exempt")).toBe("exempt_v1");
    expect(noticeForMode("always_on")).toBe("always_on_v1");
    expect(noticeForMode(null)).toBeNull();
    for (const k of ["fixed_v1", "exempt_v1", "always_on_v1", "extra_zone_v1", "hours_model_v1"]) expect(isPontoNoticeKey(k)).toBe(true);
    expect(PONTO_NOTICES.fixed_v1.text).toMatch(/apagam-se 6 meses depois de o mês do ordenado fechar/);
  });

  it("\"Li\" grava uma vez (a segunda não duplica); só o aviso do modo de hoje", async () => {
    const { store, st } = memStore({ history: [{ id: 1, employeeId: 7, mode: "fixed", effectiveFrom: "2026-10-01", note: "x", setById: 1, setAt: null }] });
    await expect(recordPontoNoticeAck(store, { employeeId: 7, notice: "exempt_v1", channel: "app", actorUserId: 9, nowMs: NOW })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const a = await recordPontoNoticeAck(store, { employeeId: 7, notice: "fixed_v1", channel: "app", actorUserId: 9, nowMs: NOW });
    expect(a).toEqual({ already: false, ackAt: "2026-10-15 10:00:00" });
    const b = await recordPontoNoticeAck(store, { employeeId: 7, notice: "fixed_v1", channel: "paper", actorUserId: 3, note: "Papel", nowMs: NOW + 1000 });
    expect(b.already).toBe(true);
    expect(st.acks).toEqual([expect.objectContaining({ employeeId: 7, mode: "fixed", notice: "fixed_v1", channel: "app", ackByUserId: 9, note: null })]);
    expect(st.logs.map((l) => l.entity)).toEqual(["ponto_mode_ack"]);
  });

  it("em papel fica com o canal e a nota", async () => {
    const { store, st } = memStore({ history: [{ id: 1, employeeId: 7, mode: "always_on", effectiveFrom: TODAY, note: "x", setById: 1, setAt: null }] });
    await recordPontoNoticeAck(store, { employeeId: 7, notice: "always_on_v1", channel: "paper", actorUserId: 3, note: "Papel assinado", nowMs: NOW });
    expect(st.acks[0]).toMatchObject({ channel: "paper", note: "Papel assinado", ackByUserId: 3 });
    expect(latestAck(st.acks, "always_on_v1")?.channel).toBe("paper");
  });

  it("só a própria pessoa carrega em \"Li\"; o papel é do RH e nunca na própria ficha", () => {
    const r = src("server/pontoModesRouter.ts");
    const ack = r.slice(r.indexOf("  ack: protectedProcedure"), r.indexOf("  ackPaper: protectedProcedure"));
    expect(ack).toContain("isLoginOfEmployee(ctx.user.id, input.employeeId)");
    expect(ack).toContain('channel: "app"');
    const paper = r.slice(r.indexOf("  ackPaper: protectedProcedure"), r.indexOf("  reviewAlert: protectedProcedure"));
    expect(paper).toContain("if (viewer.isOwn) throw");
    expect(paper).toContain('channel: "paper"');
  });
});

describe("alertas do ponto", () => {
  it("quem vê: nunca na própria ficha; a zona, as caras e o fim de semana da isenção só o super admin", () => {
    const sa = { role: "super_admin", isOwn: false, canManage: true };
    const rh = { role: "backoffice", isOwn: false, canManage: true };
    const other = { role: "frontoffice", isOwn: false, canManage: false };
    for (const k of ["outside_zone", "no_gps", "imprecise", "face_no_match", "face_uncertain", "face_no_face", "exempt_weekend"]) {
      expect(pontoAlertVisible(k, sa), k).toBe(true);
      expect(pontoAlertVisible(k, rh), k).toBe(false);
      expect(pontoAlertVisible(k, { ...sa, role: "admin" }), k).toBe(false);
    }
    for (const k of ["profile_photo_unvalidated", "long_shift", "auto_day_warning"]) {
      expect(pontoAlertVisible(k, rh), k).toBe(true);
      expect(pontoAlertVisible(k, other), k).toBe(false);
    }
    for (const k of PONTO_ALERT_KINDS) expect(pontoAlertVisible(k, { ...sa, isOwn: true }), k).toBe(false);
  });

  it("a chave do alerta não leva o id da ficha (juntar fichas)", () => {
    expect(pontoAlertDedupeKey({ kind: "outside_zone", day: "2026-10-14", timeRecordId: 55 })).toBe("outside_zone:2026-10-14:r55");
    expect(pontoAlertDedupeKey({ kind: "auto_day_warning", day: "2026-10-14", autoDayId: 3 })).toBe("auto_day_warning:2026-10-14:a3");
    expect(pontoAlertDedupeKey({ kind: "long_shift", day: "2026-10-14" })).toBe("long_shift:2026-10-14:-");
  });

  it("o cartão só mostra os alertas que a pessoa pode ver; rever respeita a mesma regra", async () => {
    const { store, st } = memStore({ alerts: [alert(1, "outside_zone", { severity: "red" }), alert(2, "long_shift")] });
    const rhView = await pontoModeView(store, { employeeId: 7, viewer: { id: 3, role: "backoffice", isOwn: false, canManage: true }, nowMs: NOW });
    expect(rhView.alerts.map((a) => a.kind)).toEqual(["long_shift"]);
    expect(rhView.guard).toBeNull();
    const saView = await pontoModeView(store, { employeeId: 7, viewer: { id: 1, role: "super_admin", isOwn: false, canManage: true }, nowMs: NOW });
    expect(saView.alerts.map((a) => a.kind)).toEqual(["outside_zone", "long_shift"]);
    const own = await pontoModeView(store, { employeeId: 7, viewer: { id: 7, role: "super_admin", isOwn: true, canManage: false }, nowMs: NOW });
    expect(own.alerts).toEqual([]);
    await expect(reviewPontoAlert(store, { alertId: 1, status: "justified", viewer: { id: 3, role: "backoffice", isOwn: false, canManage: true }, nowMs: NOW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reviewPontoAlert(store, { alertId: 2, status: "seen", viewer: { id: 7, role: "super_admin", isOwn: true, canManage: false }, nowMs: NOW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await reviewPontoAlert(store, { alertId: 1, status: "justified", note: "Em casa", viewer: { id: 1, role: "super_admin", isOwn: false, canManage: true }, nowMs: NOW });
    expect(st.reviewed).toEqual([{ id: 1, status: "justified", reviewedById: 1, reviewedAt: "2026-10-15 10:00:00", reviewNote: "Em casa" }]);
  });
});

describe("o cartão da ficha", () => {
  it("modo de hoje, aviso por ler, histórico com quem mudou; só o super admin recebe as guardas", async () => {
    const { store } = memStore({
      history: [
        { id: 1, employeeId: 7, mode: "fixed", effectiveFrom: "2026-09-01", note: "back office", setById: 1, setAt: "2026-09-01 09:00:00" },
        { id: 2, employeeId: 7, mode: null, effectiveFrom: "2026-10-10", note: "engano", setById: 1, setAt: "2026-10-10 09:00:00" },
        { id: 3, employeeId: 7, mode: "fixed", effectiveFrom: "2026-10-05", note: "afinal sim", setById: 1, setAt: "2026-10-12 09:00:00" },
      ],
      closed: new Set(["2026-09"]),
    });
    const v = await pontoModeView(store, { employeeId: 7, viewer: { id: 1, role: "super_admin", isOwn: false, canManage: true }, nowMs: NOW });
    expect(v.current).toBe("fixed");
    expect(v.notice).toMatchObject({ key: "fixed_v1", ack: null });
    expect(v.history.map((h) => [h.id, h.superseded])).toEqual([[3, false], [2, true], [1, false]]);
    expect(v.history[0].setByName).toBe("Pessoa 1");
    expect(v.viewer).toEqual({ isOwn: false, isSuperAdmin: true, canEdit: true, canRecordPaper: true });
    expect(v.guard?.closedMonths).toEqual(["2026-09"]);
    expect(v.guard?.earliestFrom).toEqual({ none: "2026-10-01", fixed: "2026-10-01", exempt: TODAY, always_on: TODAY });
    expect(v.history.map((h) => h.note)).toEqual(["afinal sim", "engano", "back office"]);
    const own = await pontoModeView(store, { employeeId: 7, viewer: { id: 7, role: "backoffice", isOwn: true, canManage: false }, nowMs: NOW });
    expect(own.viewer).toEqual({ isOwn: true, isSuperAdmin: false, canEdit: false, canRecordPaper: false });
    expect(own.guard).toBeNull();
    // o motivo é interno: a própria pessoa vê o modo e o histórico, sem o motivo
    expect(own.history.map((h) => [h.mode, h.effectiveFrom, h.note])).toEqual([["fixed", "2026-10-05", null], [null, "2026-10-10", null], ["fixed", "2026-09-01", null]]);
    const ownSuper = await pontoModeView(store, { employeeId: 7, viewer: { id: 7, role: "super_admin", isOwn: true, canManage: false }, nowMs: NOW });
    expect(ownSuper.history[0].note).toBe("afinal sim");
  });

  it("extra em horário fixo (o posto mudou depois) → aviso ao RH e ao super admin, nunca na própria ficha", async () => {
    const { store } = memStore({ history: [{ id: 1, employeeId: 7, mode: "fixed", effectiveFrom: "2026-10-01", note: "x", setById: 1, setAt: null }], employee: { position: "extra", contractType: "extra" } });
    const rh = await pontoModeView(store, { employeeId: 7, viewer: { id: 3, role: "backoffice", isOwn: false, canManage: true }, nowMs: NOW });
    expect(rh.stateWarnings.join(" ")).toMatch(/É extra e está em "1 · Horário fixo"/);
    const own = await pontoModeView(store, { employeeId: 7, viewer: { id: 7, role: "extra", isOwn: true, canManage: false }, nowMs: NOW });
    expect(own.stateWarnings).toEqual([]);
  });

  it("sem modo: nada para ler", async () => {
    const { store } = memStore();
    const v = await pontoModeView(store, { employeeId: 7, viewer: { id: 3, role: "backoffice", isOwn: false, canManage: true }, nowMs: NOW });
    expect(v.current).toBeNull();
    expect(v.notice).toBeNull();
  });

  it("o cartão está na ficha → Horário e só aparece com o interruptor ligado", () => {
    const hr = src("client/src/pages/HRPage.tsx");
    const schedulesTab = hr.slice(hr.indexOf('<TabsContent value="schedules"'), hr.indexOf("</TabsContent>", hr.indexOf('<TabsContent value="schedules"')));
    expect(schedulesTab).toContain("<PontoModeCard employeeId={employeeId} />");
    const card = src("client/src/components/rh/PontoModeCard.tsx");
    expect(card).toContain("if (!d || !d.enabled) return null;");
    const r = src("server/pontoModesRouter.ts");
    const get = r.slice(r.indexOf("  get: protectedProcedure"), r.indexOf("  set: protectedProcedure"));
    expect(get).toContain("if (!(await pontoModesEnabled())) return { enabled: false as const };");
    expect(get).toContain("await assertCanViewTimeRecords(ctx.user, input.employeeId);");
    const set = r.slice(r.indexOf("  set: protectedProcedure"), r.indexOf("  ack: protectedProcedure"));
    expect(set).toContain("await requireEnabled();");
    expect(set).toContain('if (ctx.user.role !== "super_admin") throw');
    expect(src("server/routers.ts")).toContain("pontoModes: pontoModesRouter,");
  });

  it("a própria ficha (mesmo sem centro de custos) lê o seu modo e carrega em \"Li\"", () => {
    expect(ownRecordEmployeeId("pontoModes.get", { employeeId: 7 })).toBe(7);
    expect(ownRecordEmployeeId("pontoModes.ack", { employeeId: 7, notice: "fixed_v1" })).toBe(7);
    expect(ownRecordEmployeeId("pontoModes.set", { employeeId: 7 })).toBeNull();
    expect(ownRecordEmployeeId("pontoModes.ackPaper", { employeeId: 7 })).toBeNull();
  });
});

describe("juntar fichas com modos", () => {
  it("modos diferentes → aviso com o modo que fica; o mesmo modo nas duas → aviso mais curto; sem histórico → nada", () => {
    const keep = [entry(1, "fixed", "2026-09-01")];
    const drop = [entry(2, "exempt", "2026-10-01")];
    expect(pontoModeMergeWarning({ keepHistory: keep, dropHistory: drop, today: TODAY })).toMatch(/Modo do ponto diferente: a ficha que fica tem "1 · Horário fixo" e a que sai tinha "2 · Isenção"\. O histórico das duas passa para a que fica, que fica em "2 · Isenção"/);
    // a que fica sem modo apanha o modo da que sai: é aqui que o aviso mais importa
    expect(pontoModeMergeWarning({ keepHistory: [], dropHistory: drop, today: TODAY })).toMatch(/"Sem modo — regras de hoje" e a que sai tinha "2 · Isenção".*que fica em "2 · Isenção"/);
    expect(pontoModeMergeWarning({ keepHistory: keep, dropHistory: [], today: TODAY })).toMatch(/que fica em "1 · Horário fixo"/);
    expect(pontoModeMergeWarning({ keepHistory: keep, dropHistory: [entry(3, "fixed", "2026-10-01")], today: TODAY })).toMatch(/As duas fichas têm histórico/);
    expect(pontoModeMergeWarning({ keepHistory: [], dropHistory: [], today: TODAY })).toBeNull();
  });

  it("a pré-visualização da junção usa o aviso e a junção atualiza a cópia do modo (melhor esforço)", () => {
    const m = src("server/employeeMerge.ts");
    expect(m).toContain("const modeWarning = await pontoModeMergeWarningFor(d, keepId, dropId);");
    expect(m).toContain("await refreshPontoModeCache(d, o.keepId);");
    // a que sai fica sem histórico → a cópia dela também se limpa (só escreve se mudar; sem leitura, não mexe)
    expect(m).toContain("await refreshPontoModeCache(d, o.dropId);");
    expect(m).toContain("if (history == null) return;");
    expect(m).toContain("AND NOT (pontoMode <=> ${mode})");
    expect(m).not.toMatch(/DELETE\s+FROM/i);
  });
});

describe("interruptor e migração", () => {
  it("PONTO_MODOS no catálogo, desligado por omissão, só o super admin o muda", () => {
    expect(PONTO_MODOS_FLAG).toBe("PONTO_MODOS");
    expect(AUTOMATION_FLAGS.some((f) => f.name === PONTO_MODOS_FLAG)).toBe(true);
    expect(automationFlagDefault(PONTO_MODOS_FLAG)).toBe(false);
    expect(automationFlagSuperAdminOnly(PONTO_MODOS_FLAG)).toBe(true);
  });

  it("0720 só acrescenta, é idempotente e está registada por ordem", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0720");
    expect(SCHEMA_MIGRATION_IDS[SCHEMA_MIGRATION_IDS.indexOf("0720") - 1] < "0720").toBe(true);
    for (const s of MIGRATION_0720_STATEMENTS) {
      expect(s).not.toMatch(/\b(DELETE|DROP|UPDATE|TRUNCATE|MODIFY)\b/i);
      if (/^CREATE TABLE/.test(s)) expect(s).toMatch(/IF NOT EXISTS/);
      else expect(s).toMatch(/^ALTER TABLE `[a-z_]+` ADD COLUMN `\w+` [A-Z]+(\(\d+\))? NULL$/);
    }
    for (const c of ["ER_DUP_FIELDNAME", "ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]) expect(IDEMPOTENT_ERROR_CODES_0720.has(c)).toBe(true);
    const all = MIGRATION_0720_STATEMENTS.join("\n");
    for (const t of ["employee_ponto_modes", "ponto_alerts", "ponto_mode_acks"]) expect(all).toContain(`CREATE TABLE IF NOT EXISTS \`${t}\``);
    for (const c of ["pontoMode", "photoSource", "photoFileAgeS", "gpsAccuracyM", "createdByUserId"]) expect(all).toContain(`ALTER TABLE \`time_records\` ADD COLUMN \`${c}\``);
    expect(all).toContain("ALTER TABLE `employees` ADD COLUMN `pontoMode` VARCHAR(12) NULL");
    expect(all).toContain("UNIQUE KEY `uq_ponto_alerts_dedupe` (`employeeId`, `dedupeKey`)");
  });

  it("o esquema drizzle tem as mesmas colunas", () => {
    const s = src("drizzle/schema.ts");
    for (const t of ["employee_ponto_modes", "ponto_alerts", "ponto_mode_acks"]) expect(s).toContain(`mysqlTable("${t}"`);
    const tr = s.slice(s.indexOf('export const timeRecords = mysqlTable("time_records"'), s.indexOf("// ─── Terminal pelo perfil (0625"));
    for (const c of ["pontoMode", "photoSource", "photoFileAgeS", "gpsAccuracyM", "createdByUserId"]) expect(tr).toContain(`${c}: `);
  });
});
