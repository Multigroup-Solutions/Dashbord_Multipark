/**
 * Recrutamento por email (recursos-humanos@) — 41d (Jorge, 7 out 2026: "ver o
 * que não é recrutamento e mandares para o lixo… fazer isto de outra maneira,
 * não conseguimos tirar nada daí, damos ok e nada, fica aí para sempre").
 *
 * Cada email está num de três sítios: POR TRATAR, PRONTAS ou LIXO. O que a
 * pessoa escolhe (recruitmentState) manda sempre. Sem escolha, os que
 * claramente não são candidaturas (avisos de entrega, respostas automáticas,
 * remetentes "no-reply", respostas à disponibilidade, newsletters) vão
 * sozinhos para o lixo — calculado na leitura, nada se escreve nem se apaga.
 * Na dúvida, fica por tratar.
 */

export type RecruitmentState = "open" | "done" | "trash";
export const RECRUITMENT_STATES: readonly RecruitmentState[] = ["open", "done", "trash"];
export const RECRUITMENT_STATE_LABELS: Record<RecruitmentState, string> = { open: "Por tratar", done: "Prontas", trash: "Lixo" };

export interface RecruitmentEmailLike {
  fromEmail?: string | null;
  fromName?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  status?: string | null;
  recruitmentState?: string | null;
}

/** Remetentes de sistema (nunca são candidatos). */
const SYSTEM_SENDER_RE = /(^|[._-])(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|notifications?)@|@(mailer|bounce)s?\./i;
/** Assuntos que não são candidaturas: entregas falhadas, respostas automáticas, faturas, newsletters. */
const NOT_RECRUITMENT_SUBJECT_RE = /delivery status notification|undeliver|mail delivery|returned mail|delivery (has )?failed|falha na entrega|não entregue|out of office|automatic reply|auto-?reply|resposta autom[áa]tica|ausente do escrit[óo]rio|newsletter|webinar|fatura|invoice|recibo|receipt|password|verifica(r|ção) (o )?(teu|seu)? ?e-?mail|security alert|alerta de segurança/i;
/** Respostas ao pedido semanal de disponibilidade (vão para a Disponibilidade, não são candidaturas). */
const AVAILABILITY_REPLY_RE = /^(re|res|fw|fwd|enc)\s*:\s*.*disponibilidade/i;
/** Sinais de candidatura (ganham sempre ao lixo automático). */
const RECRUITMENT_RE = /candidatura|candidat[oa]|curr[íi]culo|curriculum|\bcv\b|emprego|vaga|recrutamento|motorista|condutor|trabalhar convosco|be a driver|multidriver/i;

export type RecruitmentClass = "recruitment" | "not_recruitment" | "unsure";

/** É candidatura, não é, ou não se sabe? PURA. */
export function classifyRecruitmentEmail(e: RecruitmentEmailLike): RecruitmentClass {
  const subject = e.subject ?? "";
  const from = `${e.fromEmail ?? ""}`;
  if (RECRUITMENT_RE.test(subject)) return "recruitment";
  if (SYSTEM_SENDER_RE.test(from)) return "not_recruitment";
  if (NOT_RECRUITMENT_SUBJECT_RE.test(subject)) return "not_recruitment";
  if (AVAILABILITY_REPLY_RE.test(subject)) return "not_recruitment";
  if (RECRUITMENT_RE.test(`${e.fromName ?? ""} ${(e.bodyText ?? "").slice(0, 2000)}`)) return "recruitment";
  return "unsure";
}

/** Onde está o email: a escolha da pessoa manda; sem ela, o que não é candidatura vai para o lixo. PURA. */
export function recruitmentStateOf(e: RecruitmentEmailLike): { state: RecruitmentState; auto: boolean } {
  const s = e.recruitmentState;
  if (s === "open" || s === "done" || s === "trash") return { state: s, auto: false };
  return classifyRecruitmentEmail(e) === "not_recruitment" ? { state: "trash", auto: true } : { state: "open", auto: false };
}

/** Contagens por sítio. PURA. */
export function countRecruitmentStates(list: readonly RecruitmentEmailLike[]): Record<RecruitmentState, number> {
  const out: Record<RecruitmentState, number> = { open: 0, done: 0, trash: 0 };
  for (const e of list) out[recruitmentStateOf(e).state]++;
  return out;
}
