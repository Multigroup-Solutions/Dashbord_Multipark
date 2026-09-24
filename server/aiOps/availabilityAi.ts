/**
 * Respostas de disponibilidade que o classificador por regras
 * (server/availabilityReply.ts) marca como `unclear`: a IA (`availability_classify`,
 * lite) classifica em disponível (dias/horas), indisponível ou pergunta.
 *
 *  - confiança ≥ AUTO_APPLY_CONFIDENCE e dias dentro do pedido → aplica-se
 *    sozinho (como um "sim"/"não" claro);
 *  - resto (pergunta, confiança baixa, dias que não batem) → revisão humana
 *    (tarefa de disponibilidade com a leitura da IA anotada).
 * Interruptor desligado / orçamento → revisão humana, sem chamada.
 */
import { AVAILABILITY_SYSTEM, availabilityAiSchema } from "../_core/ai/prompts/ops";
import { replyOnly } from "../availabilityReply";
import { addDays } from "../../shared/lisbonDay";
import { tryAi, type AiCallCap } from "./aiCall";

export const AUTO_APPLY_CONFIDENCE = 0.85;

export interface AvailabilityRequestCtx {
  kind: string;
  targetDate: string | null;
  weekStart: string | null;
  shift: string | null;
}

export interface AiAvailability { intent: "available" | "unavailable" | "question" | "unclear"; days: string[]; fromHour: number | null; toHour: number | null; confidence: number }

export type AvailabilityDecision =
  | { action: "apply_yes"; days: string[]; fromHour: number | null; toHour: number | null; confidence: number }
  | { action: "apply_no"; confidence: number }
  | { action: "review"; reason: string; ai: AiAvailability | null };

/** Dias que o pedido cobre (o dia pedido, ou a semana seg–dom). PURA. */
export function requestDays(ctx: AvailabilityRequestCtx): string[] {
  if (ctx.targetDate) return [ctx.targetDate];
  if (ctx.weekStart) return Array.from({ length: 7 }, (_, i) => addDays(ctx.weekStart!, i));
  return [];
}

/** Decisão a partir da leitura da IA (limiares). PURA. */
export function decideAiAvailability(ai: AiAvailability | null, ctx: AvailabilityRequestCtx, threshold = AUTO_APPLY_CONFIDENCE): AvailabilityDecision {
  if (!ai) return { action: "review", reason: "IA indisponível", ai: null };
  const conf = Math.max(0, Math.min(1, ai.confidence));
  const pct = `${Math.round(conf * 100)}%`;
  if (ai.intent === "question") return { action: "review", reason: `pergunta do colaborador (confiança ${pct})`, ai };
  if (ai.intent === "unclear") return { action: "review", reason: `IA também não percebeu (confiança ${pct})`, ai };
  if (conf < threshold) return { action: "review", reason: `confiança baixa (${pct})`, ai };
  if (ai.intent === "unavailable") return { action: "apply_no", confidence: conf };
  const allowed = requestDays(ctx);
  let days = ai.days.filter((d) => allowed.includes(d));
  if (ai.days.length && days.length !== ai.days.length) return { action: "review", reason: "dias fora do pedido", ai };
  if (!days.length) {
    // Pedido de um dia: "posso" chega. Pedido da semana: sem dias não se adivinha.
    if (ctx.targetDate) days = [ctx.targetDate];
    else return { action: "review", reason: "disponível, mas sem dizer que dias", ai };
  }
  const validHours = ai.fromHour == null || ai.toHour == null || ai.fromHour < ai.toHour;
  if (!validHours) return { action: "review", reason: "horas incoerentes", ai };
  return { action: "apply_yes", days, fromHour: ai.fromHour, toHour: ai.toHour, confidence: conf };
}

export function describeRequest(ctx: AvailabilityRequestCtx): string {
  const shift = ctx.shift === "night" ? " (turno da noite)" : ctx.shift === "morning" ? " (turno da manhã)" : "";
  if (ctx.targetDate) return `Pedido: pode trabalhar no dia ${ctx.targetDate}${shift}?`;
  if (ctx.weekStart) return `Pedido: que dias pode trabalhar na semana de ${ctx.weekStart} a ${addDays(ctx.weekStart, 6)}${shift}? Dias possíveis: ${requestDays(ctx).join(", ")}.`;
  return "Pedido de disponibilidade.";
}

/** Chama a IA (se ligada) e decide. Nunca lança. */
export async function classifyUnclearAvailability(body: string, ctx: AvailabilityRequestCtx, opts: { cap?: AiCallCap | null; employeeId?: number | null } = {}): Promise<AvailabilityDecision> {
  const text = replyOnly(body ?? "").slice(0, 600);
  if (!text) return { action: "review", reason: "sem texto", ai: null };
  const res = await tryAi({
    feature: "availability_classify", system: AVAILABILITY_SYSTEM, schema: availabilityAiSchema,
    input: `${describeRequest(ctx)}\nResposta: "${text}"`, maxTokens: 200, timeoutMs: 15_000,
    cap: opts.cap ?? null, entity: "availability_reply", entityId: opts.employeeId ?? null,
  });
  if (!res.ok) return { action: "review", reason: res.skipped === "disabled" ? "IA desligada" : "IA indisponível", ai: null };
  return decideAiAvailability(res.output as AiAvailability, ctx);
}

/** Nota curta para a tarefa de revisão humana. PURA. */
export function reviewNote(d: Extract<AvailabilityDecision, { action: "review" }>): string {
  if (!d.ai) return `[IA: ${d.reason}]`;
  const intent = { available: "disponível", unavailable: "indisponível", question: "pergunta", unclear: "pouco clara" }[d.ai.intent];
  const extra = [d.ai.days.length ? `dias ${d.ai.days.join(", ")}` : "", d.ai.fromHour != null ? `das ${d.ai.fromHour}h` : "", d.ai.toHour != null ? `às ${d.ai.toHour}h` : ""].filter(Boolean).join(" ");
  return `[IA: ${intent}${extra ? ` — ${extra}` : ""}; ${d.reason}]`;
}
