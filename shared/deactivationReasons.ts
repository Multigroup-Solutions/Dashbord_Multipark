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
  "ficha_duplicada",
  "seguranca",
  "outro",
  // 49c (Jorge, 8 out 2026): ficha de quem se candidatou pela app e ainda não
  // foi aprovado. Só do sistema — nunca aparece no diálogo de desativar.
  "candidato",
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
  ficha_duplicada: "Ficha duplicada (junta a outra)",
  seguranca: "Segurança (acesso comprometido)",
  outro: "Outro",
  candidato: "Candidato — por aprovar",
};

/** Todos os códigos com etiqueta (inclui `candidato`, que é só do sistema). */
export const DEACTIVATION_REASONS: ReadonlyArray<{ code: DeactivationReasonCode; label: string }> =
  DEACTIVATION_REASON_CODES.map((code) => ({ code, label: DEACTIVATION_REASON_LABELS[code] }));

// ─── 49c: DESATIVADO (fica bloqueado) vs INATIVO (pode voltar) ──────────────
//
// Jorge (8 out 2026): "os desativados que tirámos são mesmo para tirar → a
// conta fica bloqueada. Os inativos são pessoas que deixaram de vir/de
// responder mas que a qualquer momento podem querer voltar → a conta passa a
// utilizador e entra para dizer 'voltei, tenho estes dias livres'."

/** Ficha de candidato (antes de aprovado) — só o sistema a cria. */
export const CANDIDATE_REASON = "candidato" as const;

/** Motivos que BLOQUEIAM o login ("desativado — fica bloqueado"). */
export const BLOCKING_DEACTIVATION_REASONS = [
  "roubou", "despedido", "trabalha_mal", "comportamento", "faltas", "seguranca", "outro", "conta_duplicada", "ficha_duplicada",
] as const satisfies readonly DeactivationReasonCode[];

/** Motivos que NÃO bloqueiam ("inativo — pode voltar"); `candidato` incluído. */
export const COMEBACK_DEACTIVATION_REASONS = [
  "inatividade", "fora_do_pais", "pedido_proprio", "ausencia_prolongada", "fim_contrato", "mudanca_funcao", "documentos", "candidato",
] as const satisfies readonly DeactivationReasonCode[];

/** Os motivos que se escolhem à mão (todos menos `candidato`). */
export type DialogDeactivationReasonCode = Exclude<DeactivationReasonCode, "candidato">;

/** Os códigos que se podem escolher no diálogo e mandar pela API (sem `candidato`). */
export const DIALOG_DEACTIVATION_REASON_CODES = DEACTIVATION_REASON_CODES.filter(
  (c): c is DialogDeactivationReasonCode => c !== CANDIDATE_REASON,
) as [DialogDeactivationReasonCode, ...DialogDeactivationReasonCode[]];

export type DeactivationKind = "inativo" | "desativado" | "candidato";

/**
 * O que um motivo faz ao login. PURA. Sem motivo (fichas antigas) ou com um
 * código desconhecido conta como DESATIVADO — na dúvida, bloqueia.
 */
export function deactivationKind(reason: string | null | undefined): DeactivationKind {
  const r = String(reason ?? "").trim();
  if (r === CANDIDATE_REASON) return "candidato";
  if ((COMEBACK_DEACTIVATION_REASONS as readonly string[]).includes(r)) return "inativo";
  return "desativado";
}

/** O motivo bloqueia o login? (sem motivo / desconhecido = sim). PURA. */
export function deactivationBlocksLogin(reason: string | null | undefined): boolean {
  return deactivationKind(reason) === "desativado";
}

/** Os dois grupos do diálogo de desativar (RH e Utilizadores), com o efeito de cada um. */
export const DEACTIVATION_REASON_GROUPS: ReadonlyArray<{
  kind: Exclude<DeactivationKind, "candidato">;
  title: string;
  effect: string;
  reasons: ReadonlyArray<{ code: DialogDeactivationReasonCode; label: string }>;
}> = [
  {
    kind: "inativo",
    title: "Inativo — pode voltar",
    effect: "Sai das listas, da escala e dos avisos, mas pode voltar a entrar como utilizador: vê a ficha, atualiza os dados e os dias livres e diz \"Voltei\". O RH decide se reativa.",
    reasons: COMEBACK_DEACTIVATION_REASONS.filter((c): c is Exclude<typeof c, "candidato"> => c !== CANDIDATE_REASON).map((code) => ({ code, label: DEACTIVATION_REASON_LABELS[code] })),
  },
  {
    kind: "desativado",
    title: "Desativado — fica bloqueado",
    effect: "A conta fica bloqueada: a pessoa não volta a entrar na app.",
    reasons: BLOCKING_DEACTIVATION_REASONS.map((code) => ({ code, label: DEACTIVATION_REASON_LABELS[code] })),
  },
];

/** O efeito de um motivo, numa frase (para o diálogo). PURA. */
export function deactivationEffect(reason: string | null | undefined): string {
  const kind = deactivationKind(reason);
  return DEACTIVATION_REASON_GROUPS.find((g) => g.kind === kind)?.effect ?? DEACTIVATION_REASON_GROUPS[1].effect;
}

export const DEFAULT_DEACTIVATION_REASON = "inatividade" satisfies DeactivationReasonCode;
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
  // 49c: "Candidato" é só do sistema (a ficha de quem se candidatou pela app).
  if (reason === CANDIDATE_REASON) {
    throw new Error("\"Candidato\" não se escolhe à mão: é a ficha de quem se candidatou pela app.");
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
