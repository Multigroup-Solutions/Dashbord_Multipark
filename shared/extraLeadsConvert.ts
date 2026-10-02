/**
 * Converter um lead em extra quando a pessoa JÁ TEVE ficha (P3 lote 18b —
 * Jorge, 2 out 2026: "Bloqueia, reativa com confirmação"). Antes o Converter
 * reativava qualquer ficha com o mesmo telefone, em silêncio — até a de quem
 * saiu por roubo ou a ficha duplicada que já tinha sido junta a outra. PURAS.
 *
 *  - ficha ATIVA → liga-se a ela (como sempre);
 *  - "ficha_duplicada" (junta a outra) → segue para a ficha que ficou;
 *  - saiu por roubo / despedimento / duplicado sem destino → nunca se reativa
 *    a partir de um lead (fala-se com o RH);
 *  - outro motivo → mostra-se o motivo e só se reativa com confirmação.
 */
import { DEACTIVATION_REASON_LABELS, deactivationReasonLabel } from "./deactivationReasons";

/** Motivos de saída que um lead nunca reativa. */
export const NEVER_REACTIVATE_FROM_LEAD = ["roubou", "despedido", "ficha_duplicada", "conta_duplicada"] as const;

export interface FichaLike {
  id: number;
  fullName?: string | null;
  isActive: number | boolean | null;
  deactivationReason?: string | null;
  deactivationReasonOther?: string | null;
  deactivatedAt?: string | null;
}

/** Ficha que ficou quando esta foi junta a outra ("Junta à ficha #123"), ou null. */
export function mergedTargetId(f: FichaLike): number | null {
  if (f.isActive || f.deactivationReason !== "ficha_duplicada") return null;
  const m = /#(\d+)/.exec(String(f.deactivationReasonOther ?? ""));
  const id = m ? Number(m[1]) : NaN;
  return Number.isInteger(id) && id > 0 && id !== f.id ? id : null;
}

export type LeadFichaDecision =
  | { kind: "use"; reactivate: boolean }
  | { kind: "confirm"; reason: string }
  | { kind: "blocked"; reason: string };

/** O que fazer com a ficha encontrada (já depois de seguir as juntas). */
export function leadFichaDecision(f: FichaLike, confirmReactivate: boolean): LeadFichaDecision {
  if (f.isActive) return { kind: "use", reactivate: false };
  const reason = deactivationReasonLabel(f.deactivationReason, f.deactivationReasonOther) || DEACTIVATION_REASON_LABELS.inatividade;
  if ((NEVER_REACTIVATE_FROM_LEAD as readonly string[]).includes(String(f.deactivationReason ?? ""))) return { kind: "blocked", reason };
  return confirmReactivate ? { kind: "use", reactivate: true } : { kind: "confirm", reason };
}

/** Mensagem quando a ficha nunca se reativa a partir de um lead. */
export function blockedFichaMessage(f: FichaLike, reason: string): string {
  return `Esta pessoa já teve ficha (#${f.id}${f.fullName ? `, ${f.fullName}` : ""}) e saiu por «${reason}»: não se reativa a partir de um lead. Fala com o RH.`;
}

/**
 * Das fichas com o mesmo contacto, a que conta: ativa primeiro, depois extra,
 * depois a mais antiga (como o `findEmployeeByEmail`).
 */
export function pickFicha<T extends FichaLike & { position?: string | null }>(rows: readonly T[]): T | null {
  if (!rows.length) return null;
  return [...rows].sort((a, b) =>
    Number(!!b.isActive) - Number(!!a.isActive)
    || Number(b.position === "extra") - Number(a.position === "extra")
    || a.id - b.id)[0];
}
