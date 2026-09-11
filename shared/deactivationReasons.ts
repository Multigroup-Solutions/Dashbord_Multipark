/**
 * Motivo da DESATIVAÇÃO de um utilizador/colaborador (pedido do Jorge,
 * 2026-09-11): "desativar tem de pedir um motivo opcional + notas, por defeito
 * Inatividade".
 *
 * O vocabulário vive aqui (cliente + servidor) para o diálogo, a validação zod,
 * o texto do `activity_logs` e a etiqueta que a tabela mostra dizerem
 * exactamente o mesmo. `resolveDeactivation` é a ÚNICA regra de validação —
 * chamada pelos dois caminhos de desativação (utilizador e ficha de RH).
 *
 * Persistência (migração 0071, em `users` E `employees`):
 *   deactivationReason      — CÓDIGO desta lista (nunca a etiqueta)
 *   deactivationReasonOther — texto livre, só quando o código é `outro`
 *   deactivationNotes       — a textarea (opcional, livre)
 *   deactivatedAt           — quando
 *   deactivatedById         — quem
 *
 * REGRA: reativar LIMPA estas colunas (o estado descreve a desativação ACTUAL);
 * o histórico completo fica em `activity_logs`.
 */

/** Ordenados como aparecem no diálogo — o primeiro é o valor por defeito. */
export const DEACTIVATION_REASON_CODES = [
  "inatividade",
  "fora_do_pais",
  "trabalha_mal",
  "roubou",
  "faltas",
  "comportamento",
  "pedido_proprio",
  "despedido",
  "fim_contrato",
  "ausencia_prolongada",
  "documentos",
  "mudanca_funcao",
  "conta_duplicada",
  "seguranca",
  "outro",
] as const;

export type DeactivationReasonCode = (typeof DEACTIVATION_REASON_CODES)[number];

/** Record (e não um array de objectos) para o TypeScript exigir etiqueta a cada código. */
export const DEACTIVATION_REASON_LABELS: Record<DeactivationReasonCode, string> = {
  inatividade: "Inatividade",
  fora_do_pais: "Está fora do país",
  trabalha_mal: "Trabalha mal",
  roubou: "Roubou",
  faltas: "Faltas repetidas / não comparece",
  comportamento: "Comportamento indevido",
  pedido_proprio: "Saiu a pedido do próprio",
  despedido: "Despedido",
  fim_contrato: "Fim de contrato",
  ausencia_prolongada: "Baixa médica / ausência prolongada",
  documentos: "Documentação em falta ou expirada",
  mudanca_funcao: "Mudança de função / equipa",
  conta_duplicada: "Conta duplicada",
  seguranca: "Segurança (acesso comprometido)",
  outro: "Outro",
};

/** Lista pronta a percorrer no `<Select>`. */
export const DEACTIVATION_REASONS: ReadonlyArray<{ code: DeactivationReasonCode; label: string }> =
  DEACTIVATION_REASON_CODES.map((code) => ({ code, label: DEACTIVATION_REASON_LABELS[code] }));

export const DEFAULT_DEACTIVATION_REASON: DeactivationReasonCode = "inatividade";
export const OTHER_DEACTIVATION_REASON: DeactivationReasonCode = "outro";

/** Limites partilhados pelas colunas, pela validação zod e pelos `maxLength` do formulário. */
export const DEACTIVATION_REASON_OTHER_MAX = 200;
export const DEACTIVATION_NOTES_MAX = 2000;

export function isDeactivationReason(value: unknown): value is DeactivationReasonCode {
  return typeof value === "string" && (DEACTIVATION_REASON_CODES as readonly string[]).includes(value);
}

/**
 * Etiqueta para apresentar. Tolerante de propósito: um código desconhecido
 * (linha antiga, valor escrito à mão na BD) devolve-se tal e qual em vez de
 * deixar a UI em branco.
 */
export function deactivationReasonLabel(
  reason: string | null | undefined,
  reasonOther?: string | null,
): string {
  if (!reason) return "";
  if (reason === OTHER_DEACTIVATION_REASON) {
    const other = (reasonOther ?? "").trim();
    return other || DEACTIVATION_REASON_LABELS.outro;
  }
  if (isDeactivationReason(reason)) return DEACTIVATION_REASON_LABELS[reason];
  return reason;
}

export interface DeactivationInput {
  reason?: string | null;
  reasonOther?: string | null;
  notes?: string | null;
}

export interface ResolvedDeactivation {
  /** Código normalizado — nunca vazio (sem motivo = `inatividade`). */
  reason: DeactivationReasonCode;
  /** Texto livre só existe quando o motivo é `outro`; caso contrário é descartado. */
  reasonOther: string | null;
  notes: string | null;
  /** Para apresentar (toast, tabela, ficha). */
  label: string;
  /** Uma linha para o `activity_logs`. */
  summary: string;
}

/**
 * Regra ÚNICA de validação/normalização. PURA — lança `Error` com mensagem em
 * PT (o router converte em BAD_REQUEST) para o cliente e o servidor recusarem
 * pelos mesmos motivos.
 *
 * Motivo e notas são OPCIONAIS: sem motivo assume-se `inatividade`. A única
 * exigência é escrever o texto quando se escolhe "Outro" — senão ficava um
 * motivo que não diz nada.
 */
export function resolveDeactivation(input: DeactivationInput = {}): ResolvedDeactivation {
  const rawReason = (input.reason ?? "").trim();
  const reason: DeactivationReasonCode = rawReason ? (rawReason as DeactivationReasonCode) : DEFAULT_DEACTIVATION_REASON;
  if (!isDeactivationReason(reason)) {
    throw new Error(`Motivo de desativação inválido: ${rawReason.slice(0, 48)}`);
  }

  const otherText = (input.reasonOther ?? "").trim();
  if (reason === OTHER_DEACTIVATION_REASON && !otherText) {
    throw new Error('Escreve o motivo quando escolhes "Outro"');
  }
  if (otherText.length > DEACTIVATION_REASON_OTHER_MAX) {
    throw new Error(`O motivo tem no máximo ${DEACTIVATION_REASON_OTHER_MAX} caracteres`);
  }

  const notesText = (input.notes ?? "").trim();
  if (notesText.length > DEACTIVATION_NOTES_MAX) {
    throw new Error(`As notas têm no máximo ${DEACTIVATION_NOTES_MAX} caracteres`);
  }

  const reasonOther = reason === OTHER_DEACTIVATION_REASON ? otherText : null;
  const notes = notesText || null;
  const label = deactivationReasonLabel(reason, reasonOther);
  return {
    reason,
    reasonOther,
    notes,
    label,
    summary: notes ? `${label} · Notas: ${notes}` : label,
  };
}
