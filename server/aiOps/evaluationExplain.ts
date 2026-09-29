/**
 * Explicação da avaliação (PT-PT, curta) a partir das LINHAS das regras já
 * calculadas pelo motor (shared/evaluationRules.ts → scoreOf). A IA
 * (`evaluation_explain`, lite) nunca recalcula: recebe as linhas e o total.
 * Guardada por (pessoa, período) com o hash das linhas → só se pede de novo
 * quando a pontuação muda. O team leader pode esconder a explicação.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import type { RuleLine } from "../../shared/evaluationRules";
import { EVALUATION_EXPLAIN_SYSTEM } from "../_core/ai/prompts/ops";
import { tryAi } from "./aiCall";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];
const fmt = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("pt-PT", { maximumFractionDigits: 2 })}`;

export function explanationHash(lines: RuleLine[], total: number): string {
  return crypto.createHash("sha1").update(JSON.stringify([total, lines.map((l) => [l.key, l.count, l.subtotal])])).digest("hex");
}

/** Linhas para a IA (só as que têm pontos). PURA. */
export function explanationFacts(lines: RuleLine[], total: number): string {
  const used = lines.filter((l) => l.subtotal !== 0);
  return [
    `Total do período: ${fmt(total)} pontos.`,
    ...(used.length ? used.map((l) => `${l.label}: ${l.count.toLocaleString("pt-PT")} × ${fmt(l.points)} = ${fmt(l.subtotal)}`) : ["Sem pontos neste período."]),
  ].join("\n");
}

/** Texto sem IA: o que mais somou e o que mais tirou. PURA. */
export function explanationFallback(lines: RuleLine[], total: number): string {
  const used = lines.filter((l) => l.subtotal !== 0);
  if (!used.length) return "Ainda não há pontos neste período.";
  const best = [...used].sort((a, b) => b.subtotal - a.subtotal)[0];
  const worst = [...used].sort((a, b) => a.subtotal - b.subtotal)[0];
  const parts = [`Tens ${fmt(total)} pontos neste período.`];
  if (best.subtotal > 0) parts.push(`O que mais somou foi "${best.label}" (${fmt(best.subtotal)}).`);
  if (worst.subtotal < 0) parts.push(`O que mais tirou foi "${worst.label}" (${fmt(worst.subtotal)}).`);
  return parts.join(" ");
}

export interface ExplanationView { text: string | null; ai: boolean; hidden: boolean; hiddenByName: string | null }

/**
 * Explicação (da cache ou nova). `generate=false` → só lê. Escondida → o
 * próprio não a vê (`text` null); os gestores veem-na marcada como escondida.
 */
export async function getExplanation(input: {
  employeeId: number; from: string; to: string; lines: RuleLine[]; total: number;
  viewerIsSelf: boolean; userId?: number | null;
}): Promise<ExplanationView> {
  const db = await getDb();
  const hash = explanationHash(input.lines, input.total);
  if (!db) return { text: explanationFallback(input.lines, input.total), ai: false, hidden: false, hiddenByName: null };
  const row = rowsOf(await db.execute(sql`
    SELECT linesHash, text, hiddenAt, hiddenByName FROM evaluation_explanations
     WHERE employeeId = ${input.employeeId} AND fromDay = ${input.from} AND toDay = ${input.to} LIMIT 1`))[0];
  const hidden = !!row?.hiddenAt;
  if (hidden && input.viewerIsSelf) return { text: null, ai: false, hidden: true, hiddenByName: null };
  if (row && row.linesHash === hash && row.text) return { text: String(row.text), ai: true, hidden, hiddenByName: row.hiddenByName ?? null };

  const res = await tryAi({
    feature: "evaluation_explain", system: EVALUATION_EXPLAIN_SYSTEM, input: explanationFacts(input.lines, input.total),
    maxTokens: 250, entity: "evaluation", entityId: input.employeeId, userId: input.userId ?? null, redact: false,
  });
  if (!res.ok || !res.output.trim()) return { text: explanationFallback(input.lines, input.total), ai: false, hidden, hiddenByName: row?.hiddenByName ?? null };
  const text = res.output.trim().replace(/\s+/g, " ").slice(0, 700);
  await db.execute(sql`
    INSERT INTO evaluation_explanations (employeeId, fromDay, toDay, linesHash, text)
    VALUES (${input.employeeId}, ${input.from}, ${input.to}, ${hash}, ${text})
    ON DUPLICATE KEY UPDATE linesHash = VALUES(linesHash), text = VALUES(text)`);
  return { text, ai: true, hidden, hiddenByName: row?.hiddenByName ?? null };
}

export async function setExplanationHidden(input: { employeeId: number; from: string; to: string; hidden: boolean; user: { id: number; name: string | null } }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  if (input.hidden) {
    await db.execute(sql`
      INSERT INTO evaluation_explanations (employeeId, fromDay, toDay, linesHash, hiddenAt, hiddenById, hiddenByName)
      VALUES (${input.employeeId}, ${input.from}, ${input.to}, ${"0".repeat(40)}, ${now}, ${input.user.id}, ${input.user.name})
      ON DUPLICATE KEY UPDATE hiddenAt = VALUES(hiddenAt), hiddenById = VALUES(hiddenById), hiddenByName = VALUES(hiddenByName)`);
  } else {
    await db.execute(sql`
      UPDATE evaluation_explanations SET hiddenAt = NULL, hiddenById = NULL, hiddenByName = NULL
       WHERE employeeId = ${input.employeeId} AND fromDay = ${input.from} AND toDay = ${input.to}`);
  }
}
