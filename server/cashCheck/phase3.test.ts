import { SCHEMA_MIGRATION_IDS } from "../migrations/index";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextCaseState, traceFlags, MIN_EXPLANATION } from "./caseQueries";
import { ALERT_CODES, countFinding } from "./sweepRules";
import { buildCashReceivedSql } from "../multiparkDb/cashSweep";
import { assertReadOnlySql } from "../multiparkDb/client";
import { partnerAuditDiff } from "../partnerAudit";
import { MIGRATION_0270_STATEMENTS } from "../migrations/migration_0270";
import { kindDef } from "../../shared/notificationRouting";

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("caixa fase 3: fechar casos", () => {
  it("fechar exige motivo e explicação; perda → perda aceite; o resto → justificado", () => {
    expect(nextCaseState("aberto", "fechar", null, "explicação longa")).toMatchObject({ ok: false });
    expect(nextCaseState("aberto", "fechar", "cortesia", "curta")).toMatchObject({ ok: false, message: expect.stringContaining(String(MIN_EXPLANATION)) });
    expect(nextCaseState("em_analise", "fechar", "cortesia", "Cliente habitual, autorizado pelo Jorge")).toEqual({ ok: true, state: "justificado" });
    expect(nextCaseState("aberto", "fechar", "perda", "Dinheiro não apareceu, perda aceite")).toEqual({ ok: true, state: "perda_aceite" });
    expect(nextCaseState("justificado", "fechar", "cortesia", "xxxxxxxxxxxx")).toMatchObject({ ok: false });
  });
  it("em análise só a partir de aberto; reabrir só fechados; nota em qualquer estado", () => {
    expect(nextCaseState("aberto", "analise", null, null)).toEqual({ ok: true, state: "em_analise" });
    expect(nextCaseState("justificado", "analise", null, null)).toMatchObject({ ok: false });
    expect(nextCaseState("resolvido_sozinho", "reabrir", null, null)).toEqual({ ok: true, state: "aberto" });
    expect(nextCaseState("aberto", "reabrir", null, null)).toMatchObject({ ok: false });
    expect(nextCaseState("justificado", "nota", null, "ok")).toEqual({ ok: true, state: "justificado" });
  });
  it("R25 mesma pessoa e R9 sem rasto (a partir da História)", () => {
    const h = [{ at: "2026-09-25T14:02:00Z", who: "Ana", kindLabel: "Alteração", platform: "PDA", changes: [{ field: "bookingPrice", from: 45, to: 0 }] }];
    expect(traceFlags({ code: "price_zeroed", history: h, closedBy: "ana", validatedBy: null })).toEqual({ noTrace: false, samePerson: "Ana" });
    expect(traceFlags({ code: "price_zeroed", history: [], closedBy: "Rui", validatedBy: null })).toEqual({ noTrace: true, samePerson: null });
    expect(traceFlags({ code: "credit_used", history: [], closedBy: null, validatedBy: null }).noTrace).toBe(false);
  });
});

describe("caixa fase 3: contagem (R24)", () => {
  it("recebido − gastos = esperado; diferença abre caso crítico", () => {
    expect(countFinding({ parkName: "Airpark", day: "2026-09-28", shift: "dia", received: 300, expenses: 20, counted: 280 })).toBeNull();
    const f = countFinding({ parkName: "Airpark", day: "2026-09-28", shift: "dia", received: 300, expenses: 20, counted: 250 })!;
    expect(f).toMatchObject({ code: "count_mismatch", severity: "critical", rule: "R24" });
    expect(f.detail).toContain("falta 30,00 €");
    expect(ALERT_CODES.has("count_mismatch")).toBe(true);
  });
  it("recebido em dinheiro ao vivo: só leitura, por parque e dia", () => {
    const q = buildCashReceivedSql({ parkIds: ["pA"], start: "2026-09-27 23:00:00", end: "2026-09-28 23:00:00" });
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toContain(`z."recordedAt" >=`);
    expect(q.params).toEqual(["pA", "2026-09-27 23:00:00", "2026-09-28 23:00:00", 1]);
  });
  it("migração 0270: contagem, gastos e registo (só cria tabelas)", () => {
    const all = MIGRATION_0270_STATEMENTS.join("\n");
    for (const t of ["cash_counts", "cash_count_expenses", "cash_count_log"]) expect(all).toContain(`CREATE TABLE IF NOT EXISTS \`${t}\``);
    expect(all).toContain("UNIQUE KEY `uq_cash_count` (`parkId`, `day`, `shift`)");
    expect(SCHEMA_MIGRATION_IDS).toContain("0270");
  });
});

describe("caixa fase 3: alertas e auditoria nossa", () => {
  it("dois tipos de notificação na Faturação, por cidade; o grave vai por email", () => {
    // 29c: a Caixa tem módulo próprio
    expect(kindDef("cash_case_alert")).toMatchObject({ module: "caixa", cityScoped: true, emailDefault: true });
    expect(kindDef("cash_daily_digest")).toMatchObject({ module: "caixa", cityScoped: true });
    expect(read("docs/notificacoes.md")).toContain("cash_case_alert");
    const sweep = read("server/cashSweep.ts");
    expect(sweep).toContain("flushCaseAlerts");
    expect(sweep).toContain("sendDailyDigest");
  });
  it("R29: o antes → depois da parceria, marcado quando mexe nas comissões", () => {
    const d = partnerAuditDiff({ name: "Parkos", commissionRate: "15.00", contactName: "Ana", partnerStatus: "active" }, { commissionRate: 12, contactName: "Rui", partnerStatus: "active" });
    expect(d).toEqual({ text: "[mexe nas comissões] commissionRate: 15.00 → 12", money: true });
    expect(partnerAuditDiff({ commissionRate: "15.00" }, { commissionRate: 15 }).text).toBeNull();
    expect(partnerAuditDiff(null, { commissionRate: 1 }).text).toBeNull();
    expect(read("server/routers.ts")).toMatch(/partnerAuditDiff\(beforeRow, patch\)/);
  });
  it("só quem gere a Faturação muda os casos; a contagem pede editar", () => {
    const r = read("server/cashCheckRouter.ts");
    // 29c: Caixa → gerir/editar (ou, como antes, Faturação → gerir/editar)
    expect(r).toContain(`return canCash(user as any, "manage");`);
    expect(r).toContain(`requireAccess(ctx.user, cashModuleFor(ctx.user, "edit"), "edit");`);
  });
});

