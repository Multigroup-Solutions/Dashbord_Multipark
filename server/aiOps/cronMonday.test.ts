/**
 * MPV A1 (seguimento, auditoria A2): à segunda-feira o teto de chamadas à IA
 * do cron (12) é apertado — anomalias + 3 briefings + 4 semanais + 3
 * passagens semanais. As REPETIÇÕES das explicações das anomalias têm
 * trabalho próprio (ops-anomaly-retries) e nunca tiram a IA a um semanal ou a
 * uma passagem.
 * Tudo simulado: cada narrativa "gasta" uma chamada do teto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({
  order: [] as string[],
  rows: new Map<string, any>(),
  inserts: [] as { table: string; kind: string; ai: number }[],
  retriesCalls: 0,
}));

const take = (cap: any, label: string) => {
  const ok = cap.take();
  h.order.push(`${label}:${ok ? "ia" : "sem"}`);
  return ok;
};

vi.mock("../_core/featureFlags", async (orig) => ({ ...(await orig<any>()), isFeatureEnabled: () => true }));
vi.mock("../db", async (orig) => {
  const dialect = new MySqlDialect();
  let seq = 0;
  const db = {
    execute: async (q: any) => {
      const c = dialect.sqlToQuery(q);
      const s = c.sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("INSERT IGNORE INTO ops_briefings")) {
        const key = `b|${c.params[0]}|${c.params[1]}`;
        if (!h.rows.has(key)) h.rows.set(key, { id: ++seq, data: "{}", summary: String(c.params[3]), emailedAt: null });
        h.inserts.push({ table: "ops_briefings", kind: String(c.params[0]), ai: Number(c.params[4]) });
        return [{ affectedRows: 1 }];
      }
      if (s.startsWith("SELECT id, data, summary, emailedAt FROM ops_briefings")) {
        const r = h.rows.get(`b|${c.params[0]}|${c.params[1]}`);
        return [r ? [r] : []];
      }
      if (s.startsWith("INSERT IGNORE INTO ai_weekly_reports")) {
        const key = `w|${c.params[0]}|${c.params[1]}`;
        if (!h.rows.has(key)) h.rows.set(key, { id: ++seq, data: "{}", narrative: String(c.params[3]), emailedAt: null });
        h.inserts.push({ table: "ai_weekly_reports", kind: String(c.params[0]), ai: Number(c.params[4]) });
        return [{ affectedRows: 1 }];
      }
      if (s.startsWith("SELECT id, emailedAt, narrative, data FROM ai_weekly_reports")) {
        const r = h.rows.get(`w|${c.params[0]}|${c.params[1]}`);
        return [r ? [r] : []];
      }
      return [[]];
    },
  };
  return { ...(await orig<any>()), getDb: async () => db };
});
vi.mock("./cities", async (orig) => {
  const o = await orig<any>();
  return { ...o, loadCityTrees: async () => o.OPS_CITIES.map((city: string, i: number) => ({ city, rootId: i + 1, ids: [i + 1] })) };
});
vi.mock("./anomalies", async (orig) => ({
  ...(await orig<any>()),
  // Só as novas (1 chamada) no passo 1.
  runAnomalyDetection: async (_day: string, cap: any) => {
    const ok = take(cap, "anomalias-novas");
    return { found: 3, inserted: 3, explained: ok ? 1 : 0 };
  },
  // Repetições pendentes: tenta gastar até 3 chamadas com o que sobrar.
  explainPendingAnomalies: async (_day: string, cap: any, _max: number, opts: any) => {
    h.retriesCalls++;
    expect(opts.phase).toBe("retries");
    expect(typeof opts.deadlineAt).toBe("number");
    let explained = 0;
    for (let i = 0; i < 3; i++) {
      if (cap.remaining <= 0) return { explained, skipped: "cap" };
      if (take(cap, "anomalias-repeticao")) explained++;
    }
    return { explained };
  },
}));
vi.mock("./briefing", async (orig) => ({
  ...(await orig<any>()),
  collectBriefing: async () => ({}),
  briefingSummary: async (_d: unknown, cap: any) => ({ ai: take(cap, "briefing"), text: "resumo" }),
}));
vi.mock("./weeklyReports", async (orig) => ({
  ...(await orig<any>()),
  buildWeeklyReportData: async () => ({}),
  weeklyNarrative: async (_d: unknown, cap: any) => ({ ai: take(cap, "semanal"), text: "narrativa" }),
}));
vi.mock("./handoverRepeats", async (orig) => ({
  ...(await orig<any>()),
  buildHandoverWeek: async () => ({}),
  handoverWeekNarrative: async (_d: unknown, cap: any) => ({ ai: take(cap, "passagem"), text: "semana" }),
}));
vi.mock("../mail/systemMail", () => ({ isEmailSendConfigured: () => false, sendEmail: async () => false }));

import { MAX_AI_CALLS_PER_RUN, runOpsBriefingCron } from "./cron";
import { OPS_CITIES } from "./cities";
import { WEEKLY_KINDS } from "./weeklyReports";

beforeEach(() => {
  h.order = [];
  h.rows = new Map();
  h.inserts = [];
  h.retriesCalls = 0;
});

describe("cron de segunda-feira com repetições de anomalias pendentes", () => {
  it("todos os semanais e passagens com IA; as repetições não correm aqui (trabalho próprio, ops-anomaly-retries)", async () => {
    // Segunda, 12 out 2026, 08h de Lisboa.
    const r = await runOpsBriefingCron({ now: new Date("2026-10-12T07:00:00Z"), deadlineAt: Date.now() + 60_000 });
    expect(r.clock.dow).toBe(1);
    expect(r.stepErrors).toEqual([]);
    const weekly = h.inserts.filter((x) => x.table === "ai_weekly_reports");
    expect(weekly).toHaveLength(WEEKLY_KINDS.length + OPS_CITIES.length);
    expect(weekly.every((x) => x.ai === 1)).toBe(true);
    expect(h.inserts.filter((x) => x.table === "ops_briefings").every((x) => x.ai === 1)).toBe(true);
    // As repetições não gastam teto nem tempo do briefing.
    expect(h.retriesCalls).toBe(0);
    expect(h.order.some((x) => x.startsWith("anomalias-repeticao"))).toBe(false);
    expect(r.aiCalls).toBeLessThanOrEqual(MAX_AI_CALLS_PER_RUN);
    expect(h.order.filter((x) => x.endsWith(":sem"))).toEqual([]);
  });
});
