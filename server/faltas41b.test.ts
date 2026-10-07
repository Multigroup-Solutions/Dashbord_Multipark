/**
 * Lote 41b — possíveis faltas (marcar falta / libertar em massa, painel em
 * baixo e pequeno, o detetor sem falsas faltas) e o "Detalhe por colaborador"
 * com horas e movimentos da Multipark.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { noShowSkipReason } from "./rhService";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("41b: o que não é uma possível falta", () => {
  it("escala só proposta, mandado para casa, picou o ponto ou mexeu na Multipark", () => {
    expect(noShowSkipReason({ status: "proposed", sentHomeHour: null, hasCheckIn: false, multiparkMoves: 0 })).toBe("proposed");
    expect(noShowSkipReason({ status: "confirmed", sentHomeHour: 18, hasCheckIn: false, multiparkMoves: 0 })).toBe("sent_home");
    expect(noShowSkipReason({ status: "confirmed", sentHomeHour: null, hasCheckIn: true, multiparkMoves: 0 })).toBe("check_in");
    expect(noShowSkipReason({ status: "confirmed", sentHomeHour: null, hasCheckIn: false, multiparkMoves: 4 })).toBe("multipark");
    expect(noShowSkipReason({ status: "confirmed", sentHomeHour: null, hasCheckIn: false, multiparkMoves: 0 })).toBeNull();
    // linhas antigas sem estado contam como confirmadas
    expect(noShowSkipReason({ status: null, sentHomeHour: null, hasCheckIn: false, multiparkMoves: 0 })).toBeNull();
  });

  it("o detetor lê o estado, o mandado para casa e os movimentos dos agentes da ficha (só leitura)", () => {
    const s = read("server/rhService.ts");
    const i = s.indexOf("export async function detectExtraDiaNoShows");
    const fn = s.slice(i, s.indexOf("export async function listPendingPenalties", i));
    expect(fn).toContain("status: extrasDiaAssignments.status, sentHomeHour: extrasDiaAssignments.sentHomeHour");
    expect(fn).toContain("agentIdsOfEmployee(id)");
    expect(fn).toContain("getAgentMovementSummaries({ startDay: dateStr, endDay: dateStr, byDay: false, userIds: allIds })");
    expect(fn).toContain("(movimentos da Multipark não lidos)");
    expect(fn).not.toMatch(/\bdelete\(|DELETE FROM/);
  });
});

describe("41b: lista, total real e ações em massa", () => {
  it("pendentes só das cidades de quem vê e com o total real (não para nos 100)", () => {
    const s = read("server/rhService.ts");
    const i = s.indexOf("export async function listPendingPenalties");
    const fn = s.slice(i, i + 1200);
    expect(fn).toContain("projectScope(employees.projectId)");
    expect(fn).toContain("COUNT(*)");
    expect(fn).toContain("return { items, total: Number(agg?.n ?? 0) }");
  });

  it("reviewMany: a mesma regra de cada uma, no máximo 200, conta o que não deu e regista", () => {
    const r = read("server/rhRouter.ts");
    const i = r.indexOf("reviewMany: protectedProcedure");
    const block = r.slice(i, r.indexOf("// ── BLOQUEIO LOGIN", i));
    expect(block).toContain(".max(200)");
    expect(block).toContain('requireAccess(ctx.user, "rh", "edit")');
    expect(block).toContain("await reviewPenalty(id, input.decision, ctx.user, input.note ?? null)");
    expect(block).toContain("failed++");
    expect(block).toContain("Em massa:");
  });

  it("painel em baixo (depois dos separadores), fechado e pequeno, com marcar falta / libertar todos", () => {
    const c = read("client/src/pages/RhDashboardPage.tsx");
    expect(c.indexOf("<PendingNoShowsPanel />")).toBeGreaterThan(c.indexOf("</Tabs>"));
    expect(c).toContain('<details className="rounded-md border border-amber-200');
    expect(c).toContain("trpc.rh.penalties.reviewMany.useMutation");
    expect(c).toContain("Marcar falta a {scope}");
    expect(c).toContain("Libertar {scope}");
    expect(c).toContain("Possíveis faltas por validar ({total})");
    expect(c).toContain("max-h-72 overflow-y-auto");
  });
});

describe("41b: Detalhe por colaborador com horas e movimentos", () => {
  it("o servidor junta as métricas do mês da avaliação diária", () => {
    const d = read("server/db.ts");
    const i = d.indexOf("export async function monthWorkMetrics");
    const fn = d.slice(i, i + 1600);
    expect(fn).toContain("FROM employee_day_metrics WHERE day >= ${from} AND day <= ${to}");
    expect(fn).toContain("SUM(movements + parkingMoves) AS movements");
    expect(fn).toContain("SUM(CASE WHEN hoursWorked > 0 THEN 0 ELSE scheduledHours END) AS hoursEscala");
    expect(d).toContain("work: monthMetrics.get(empId) ?? null,");
  });

  it("a tabela mostra os movimentos (ordenáveis) e as horas da escala sem ponto; colSpan certo", () => {
    const c = read("client/src/pages/RhDashboardPage.tsx");
    expect(c).toContain('<Th k="work.actions" label="Movimentos (Multipark)"');
    expect(c).toContain("(escala)");
    expect(c).toContain("colSpan={11}");
    expect((c.match(/<Th k=/g) ?? []).length).toBe(11);
  });
});
