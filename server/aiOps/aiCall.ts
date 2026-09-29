/**
 * Porta única das automações internas para o `runAi` (server/_core/ai).
 *
 *  - interruptor/configuração verificados ANTES do pedido: desligado → nenhuma
 *    chamada (e o chamador usa o texto fixo, feito no código);
 *  - teto de chamadas por corrida (`AiCallCap`) → controlo de custos no cron;
 *  - dados pessoais em texto livre → marcadores (redactPii) e repostos na
 *    resposta (todas estas saídas são internas/privadas);
 *  - orçamento excedido / erro → `{ ok:false, skipped }`, nunca lança: a
 *    automação segue sem IA.
 */
import type { z } from "zod";
import type { AiFeature } from "../../shared/aiFeatures";
import { runAi } from "../_core/ai/run";
import { aiFeatureAvailableFresh } from "../_core/ai/status";
import { redactPii } from "../_core/ai/pii";
import { aiErrorCode } from "../_core/ai/errors";

export type AiSkipReason = "disabled" | "budget" | "cap" | "error";
export type AiAttempt<T> = { ok: true; output: T } | { ok: false; skipped: AiSkipReason };

/** Teto de chamadas à IA numa corrida (cron) ou num pedido. */
export class AiCallCap {
  used = 0;
  constructor(readonly max: number) {}
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
}

export interface TryAiOptions<S extends z.ZodType | undefined> {
  feature: AiFeature;
  system: string;
  input: string;
  schema?: S;
  maxTokens?: number;
  timeoutMs?: number;
  cap?: AiCallCap | null;
  userId?: number | null;
  entity?: string | null;
  entityId?: number | null;
  /** omissão true: troca emails/telefones/IBAN/NIF/matrículas por marcadores. */
  redact?: boolean;
}

function restoreDeep(v: unknown, restore: (s: string) => string): unknown {
  if (typeof v === "string") return restore(v);
  if (Array.isArray(v)) return v.map((x) => restoreDeep(x, restore));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreDeep(x, restore)]));
  return v;
}

export function skipReasonOf(err: unknown): AiSkipReason {
  const code = aiErrorCode(err);
  if (code === "budget") return "budget";
  if (code === "disabled" || code === "not_configured") return "disabled";
  return "error";
}

export async function tryAi<S extends z.ZodType>(opts: TryAiOptions<S> & { schema: S }): Promise<AiAttempt<z.output<S>>>;
export async function tryAi(opts: TryAiOptions<undefined>): Promise<AiAttempt<string>>;
export async function tryAi(opts: TryAiOptions<any>): Promise<AiAttempt<unknown>> {
  if (!(await aiFeatureAvailableFresh(opts.feature))) return { ok: false, skipped: "disabled" };
  if (opts.cap && !opts.cap.take()) return { ok: false, skipped: "cap" };
  const red = opts.redact === false ? null : redactPii(opts.input);
  try {
    const r = await runAi({
      feature: opts.feature,
      system: opts.system,
      input: red ? red.text : opts.input,
      maxTokens: opts.maxTokens ?? 400,
      timeoutMs: opts.timeoutMs ?? 20_000,
      retries: 1,
      userId: opts.userId ?? null,
      entity: opts.entity ?? null,
      entityId: opts.entityId ?? null,
      ...(opts.schema ? { schema: opts.schema } : {}),
    } as any);
    const out = red ? restoreDeep(r.output, red.restore) : r.output;
    return { ok: true, output: out };
  } catch (err) {
    const skipped = skipReasonOf(err);
    if (skipped === "error") console.warn(`[ai-ops] ${opts.feature}: ${aiErrorCode(err)}`);
    return { ok: false, skipped };
  }
}

/** Texto de uma linha: sem quebras, sem marcadores de lista, cortado. PURA. */
export function oneLine(s: string, max = 300): string {
  return String(s ?? "").replace(/^[\s\-*•]+/, "").replace(/\s+/g, " ").trim().slice(0, max);
}
