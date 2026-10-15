/**
 * Plano MPV (F8, §8.3) — o cartão "Multis piloto": as contas por versão,
 * nível e pessoa (perguntas, €/pergunta, p95, % erros, % MAX_TOKENS, % finais
 * forçadas, % 👎, % "não sei", % recusadas, caches) e a leitura só de
 * leitura, sem o eval (assistant_eval) e com os índices da F0a.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../db", () => ({ getDb: async () => h.db }));

import { createFakeDb } from "../_core/ai/testUtils";
import { buildPilotStats, getPilotStats, type PilotUsageRow } from "./pilotStats";

const u = (over: Partial<PilotUsageRow> = {}): PilotUsageRow => ({
  userId: 7, variant: "mpv", tier: "smart", status: "ok", errorCode: null, finishReason: "STOP", forcedFinal: 0, rounds: 1,
  costEur: 0.02, latencyMs: 4000, inputTokens: 1000, cachedTokens: 500, entity: "ai_chat_conversation", ...over,
});

describe("F8 — cartão Multis piloto: as contas", () => {
  it("por versão × nível (todas as pessoas) e por pessoa; armazenamento só na versão; bloqueadas à parte", () => {
    const s = buildPilotStats({
      days: 7, since: "2026-10-14 00:00:00",
      usage: [
        u(), u({ status: "error", errorCode: "final_fallback", finishReason: "STOP", latencyMs: 30_000, forcedFinal: 1 }),
        u({ finishReason: "MAX_TOKENS", userId: 8 }), u({ status: "blocked", costEur: 0 }),
        u({ entity: "context_cache_storage", userId: null, costEur: 0.06 }),
        u({ variant: "v1", tier: "lite", userId: 9, costEur: 0.001 }),
      ],
      answers: [
        { id: 1, conversationId: 10, userId: 7, variant: "mpv", tier: "smart" },
        { id: 2, conversationId: 10, userId: 7, variant: "mpv", tier: "smart" },
        { id: 3, conversationId: 11, userId: 8, variant: "mpv", tier: "smart" },
        { id: 4, conversationId: 12, userId: 9, variant: "v1", tier: "lite" },
      ],
      feedback: [{ messageId: 1, rating: -1, auto: 0 }, { messageId: 2, rating: -1, auto: 1 }, { messageId: 4, rating: 1, auto: 0 }, { messageId: 99, rating: -1, auto: 0 }],
      toolCalls: [{ userId: 7, conversationId: 10, refused: true }, { userId: 7, conversationId: 10, refused: false }, { userId: 9, conversationId: 12, refused: false }],
      caches: [{ model: "gemini-3.1-flash-lite", live: 1 }],
      names: new Map([[7, "Jorge"], [8, "Ana"], [9, "Rui"]]),
      pilotUserIds: [7, 8],
    });
    const mpv = s.rows.find((r) => r.variant === "mpv" && r.tier === "smart" && r.userId == null)!;
    expect(s.rows[0]).toBe(mpv);
    expect(mpv).toMatchObject({ questions: 3, blocked: 1, errorPct: 0.3333, maxTokensPct: 0.3333, forcedFinalPct: 0.3333, answers: 3, downPct: 0.3333, unansweredPct: 0.3333, toolCalls: 2, refusedPct: 0.5, cachedPct: 0.5 });
    expect(mpv.storageEur).toBeCloseTo(0.06);
    expect(mpv.eurPerQuestion).toBeCloseTo((0.06 + 0.06) / 3);
    expect(mpv.p95Ms).toBeGreaterThan(20_000);
    const jorge = s.rows.find((r) => r.userId === 7)!;
    expect(jorge).toMatchObject({ name: "Jorge", inPilot: true, questions: 2, blocked: 1, storageEur: 0, answers: 2, downPct: 0.5, unansweredPct: 0.5 });
    const rui = s.rows.find((r) => r.userId === 9)!;
    expect(rui).toMatchObject({ variant: "v1", tier: "lite", inPilot: false, downPct: 0, refusedPct: 0 });
    expect(s.caches).toEqual([{ model: "gemini-3.1-flash-lite", live: 1 }]);
  });

  it("sem perguntas: nulls (nunca 0 % a fingir medição)", () => {
    const s = buildPilotStats({ days: 1, since: "x", usage: [u({ status: "blocked" })], answers: [], feedback: [], toolCalls: [], caches: [], names: new Map(), pilotUserIds: [] });
    expect(s.rows[0]).toMatchObject({ questions: 0, blocked: 1, eurPerQuestion: null, p95Ms: null, errorPct: null, downPct: null });
  });
});

describe("F8 — cartão Multis piloto: a leitura", () => {
  it("só SELECTs, só o assistant e o assistant_smart (não o eval), pelos índices de data; sem BD → vazio", async () => {
    h.db = null;
    expect((await getPilotStats(7)).rows).toEqual([]);
    h.db = createFakeDb(() => [[]]);
    await getPilotStats(99);
    const qs = h.db.queries.map((q: any) => q.sql);
    expect(qs.length).toBeGreaterThanOrEqual(5);
    for (const q of qs) expect(q).toMatch(/^SELECT /);
    const usage = h.db.queries.find((q: any) => q.sql.includes("FROM ai_usage_log"));
    expect(usage.params).toEqual(expect.arrayContaining(["assistant", "assistant_smart"]));
    expect(usage.params).not.toContain("assistant_eval");
    expect(qs.join("\n")).toMatch(/activity_logs WHERE entity = 'assistant' AND action = 'assistant_tool'/);
    const src = readFileSync(resolve(__dirname, "../settingsRouter.ts"), "utf8");
    const proc = src.slice(src.indexOf("aiPilotStats: adminOnly"), src.indexOf("aiPilotStats: adminOnly") + 600);
    expect(proc).toContain("requireAdminRole(ctx.user.role)");
    expect(proc).toContain(".max(31)");
  });
});
