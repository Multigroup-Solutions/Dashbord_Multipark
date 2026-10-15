/**
 * Críticas por email (plano MPV, F6b): o que vira crítica (R2) e a mesma
 * crítica que chega duas vezes (R3). Tudo PURO — a BD está em
 * server/reviewCleanup.ts.
 *
 * R2 (`REVIEWS_EMAIL_STRICT`): a caixa Críticas lê também o «apanha tudo» da
 * reservas@, por isso lá chegam candidaturas, respostas de clientes e alertas.
 * Com o interruptor, só vira crítica o aviso de avaliação (remetente da
 * Google/Trustpilot/Tripadvisor, `isReviewNoticeSender`) ou um email com as
 * estrelas (`rating > 0`, ex.: um colega reencaminhou o aviso). O resto segue
 * para a triagem normal — nunca fica ignorado.
 *
 * R3 (`REVIEWS_DEDUP`): a Google manda às vezes 2 emails da mesma crítica (só
 * o Message-ID os separava) e a Windsor traz a mesma outra vez. A chave de
 * repetida é: perfil/parque + estrelas + texto da crítica normalizado (20 ou
 * mais caracteres) + 1.º nome + até 48 h de diferença. Sem texto (só
 * estrelas) nunca se junta sozinha: duas pessoas dão 5★ sem texto todos os
 * dias. "Excelente serviço" (17 caracteres) também não.
 */
import { isReviewNoticeSender } from "./mailTriage";
import { matchKey, matchWords, searchText } from "./textKey";

// ─── R2: o que vira crítica ─────────────────────────────────────────────────

/** Uma crítica isolada ("recebeu uma nova crítica de 5 estrela(s)"). */
const SINGLE_RATING_RE = /cr[íi]tica de\s+[1-5]\s+estrela/i;
/** Resumos ("recebeu 3 novas críticas", "tem novas críticas", "5 new reviews"). */
const SUMMARY_RES: readonly RegExp[] = [
  /\b(?:\d+|duas|tr[êe]s|quatro|cinco|seis|sete|oito|nove|dez|v[áa]rias|algumas)\s+(?:novas\s+)?cr[íi]ticas\b/i,
  /\b(?:tem|recebeu)\s+novas\s+cr[íi]ticas\b/i,
  /\b\d+\s+new\s+reviews\b/i,
];

/** Email-resumo de críticas (nunca é uma crítica: não tem estrelas nem texto de uma pessoa). PURA. */
export function isReviewSummaryEmail(subject: string | null | undefined, body: string | null | undefined): boolean {
  const text = `${subject ?? ""}\n${body ?? ""}`;
  if (SINGLE_RATING_RE.test(text)) return false;
  return SUMMARY_RES.some((re) => re.test(text));
}

export type EmailReviewVerdict = "review" | "summary" | "not_review";

/**
 * O email que entrou pelas Críticas vira crítica? `summary` = resumo (com o
 * REVIEWS_DEDUP ou o REVIEWS_EMAIL_STRICT ligados); `not_review` = não é um
 * aviso de avaliação nem traz estrelas (só com o REVIEWS_EMAIL_STRICT). Os
 * dois desligados → `review` (como até aqui). PURA.
 */
export function emailReviewVerdict(f: {
  fromEmail: string | null | undefined;
  rating: number;
  subject: string | null | undefined;
  body: string | null | undefined;
  strict: boolean;
  dedup: boolean;
}): EmailReviewVerdict {
  if ((f.strict || f.dedup) && !(f.rating > 0) && isReviewSummaryEmail(f.subject, f.body)) return "summary";
  if (f.strict && !isReviewNoticeSender(f.fromEmail) && !(f.rating > 0)) return "not_review";
  return "review";
}

/** O que a limpeza das "não críticas" olha em cada crítica que entrou por email. */
export interface NotAReviewRow {
  id: number;
  /** Remetente do email que a trouxe (inbound_emails.fromEmail). */
  fromEmail: string | null;
  rating: number;
  sourceEmailId: string | null;
  complaintId: number | null;
  googleReviewKey: string | null;
  googleReply: string | null;
  respondedAt: string | null;
  status: string;
  notAReview: boolean;
  duplicateOf: number | null;
  markUndone: boolean;
}

/**
 * Esta crítica de email não é crítica? `mark` = marca-se (não é aviso de
 * avaliação e não tem estrelas); `keep` com o porquê = fica como está (uma
 * pessoa já mexeu, tem reclamação, veio da API, já foi desfeita à mão…);
 * null = não é candidata (é crítica, ou já está marcada). PURA.
 */
export function notAReviewDecision(r: NotAReviewRow): { action: "mark" } | { action: "keep"; why: string } | null {
  if (!r.sourceEmailId || r.googleReviewKey) return null;
  if (r.notAReview || r.duplicateOf != null) return null;
  if (r.rating > 0 || isReviewNoticeSender(r.fromEmail)) return null;
  if (r.markUndone) return { action: "keep", why: "Uma pessoa desfez a marca desta crítica." };
  if (r.complaintId) return { action: "keep", why: "Tem uma reclamação ligada." };
  if (r.googleReply || r.respondedAt || r.status === "manually_responded") return { action: "keep", why: "Já foi marcada como respondida." };
  return { action: "mark" };
}

// ─── R3: a mesma crítica ────────────────────────────────────────────────────

/** Texto mínimo (normalizado) para juntar sozinho. */
export const REVIEW_DEDUP_MIN_TEXT = 20;
/** Diferença máxima entre as duas (horas). */
export const REVIEW_DEDUP_WINDOW_HOURS = 48;

/** Nomes que não são de pessoa (o remetente ou o rodapé ficaram no lugar do nome). */
const GENERIC_NAME_KEYS: ReadonlySet<string> = new Set([
  "google", "googlebusinessprofile", "googlebusiness", "perfildaempresanogoogle", "desconhecido", "multipark", "skypark",
  "anonimo", "utilizadordogoogle", "umutilizadordogoogle", "googleuser", "cliente",
]);

/** Linhas que a Google põe à volta do texto da crítica (nunca são a crítica). */
const WRAPPER_LINE_RES: readonly RegExp[] = [
  /deixou uma cr[íi]tica/i,
  /cr[íi]tica de\s+[1-5]\s+estrela/i,
  /^bom trabalho\b/i,
  /^(?:tem\s+)?uma?\s+nova\s+cr[íi]tica\b/i,
  /^nova cr[íi]tica\b/i,
  /^google( business profile| business| ireland)?\b/i,
  /^perfil da empresa no google/i,
  /^[★☆✩✪⭐\s]+$/u,
  /^\(?[1-5](?:[.,]0)?\)?\s*(?:\/\s*5|estrelas?)?$/i,
  /https?:\/\//i,
  /este utilizador deixou apenas/i,
  /ler cr[íi]tica/i,
  /responder (?:à|a) cr[íi]tica/i,
  /responder às cr[íi]ticas/i,
  /ver todas as cr[íi]ticas/i,
  /vamos informar/i,
  /recebeu este email/i,
  /visite o centro de ajuda/i,
  /anule a subscri[çc][ãa]o/i,
  /^\(c\)\s*20\d\d/i,
];

/**
 * O texto da PRÓPRIA crítica, sem o que a Google põe à volta (o "X deixou
 * uma crítica sobre Y", as estrelas, o nome do avaliador numa linha, os
 * botões e o rodapé). Serve tanto o texto guardado de uma crítica de email
 * (assunto + corpo limpo) como o de uma da API/Windsor (já é só a crítica). PURA.
 */
export function reviewCommentText(text: string | null | undefined, reviewerName?: string | null): string {
  const nameKey = matchKey(reviewerName);
  const firstKey = matchWords(reviewerName)[0] ?? "";
  const lines = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const kept = lines.filter((l) => {
    if (WRAPPER_LINE_RES.some((re) => re.test(l))) return false;
    const k = matchKey(l);
    if (!k) return false;
    // Linha só com o nome do avaliador (completo ou o 1.º nome), ou um nome
    // curto que começa por ele ("Marta Silva" quando só se sabia "Marta").
    if (nameKey && (k === nameKey || k === firstKey)) return false;
    const words = matchWords(l);
    if (firstKey && words.length <= 4 && words[0] === firstKey && !/[.!?,;:]/.test(l)) return false;
    return true;
  });
  return kept.join(" ");
}

/** Chave do texto da crítica (letras e números, palavras separadas por um espaço). PURA. */
export function reviewTextKey(text: string | null | undefined, reviewerName?: string | null): string {
  return searchText(reviewCommentText(text, reviewerName));
}

/** 1.º nome normalizado; null quando não é nome de pessoa (Google, "Desconhecido"…). PURA. */
export function reviewerFirstNameKey(name: string | null | undefined): string | null {
  const words = matchWords(name);
  if (!words.length) return null;
  if (GENERIC_NAME_KEYS.has(words.join(""))) return null;
  return words[0];
}

/** Os factos de uma crítica que a chave de repetida usa. */
export interface ReviewDedupFacts {
  id: number;
  /** Parque (projectId); null = não se sabe (o email não disse) — não impede de juntar. */
  parkKey: string | null;
  rating: number;
  /** `reviewTextKey` do texto da crítica. */
  textKey: string;
  /** `reviewerFirstNameKey`. */
  firstName: string | null;
  /** Quando foi escrita (data da crítica, senão a do email, senão a de entrada). */
  atMs: number | null;
  /** Veio da API/Windsor (tem `googleReviewKey`). Duas destas nunca são a mesma. */
  apiKey: boolean;
}

/**
 * As duas são a mesma crítica? Mesmas estrelas (1–5), o mesmo texto com 20
 * ou mais caracteres, o mesmo parque (ou um deles sem parque), até 48 h e o
 * mesmo 1.º nome. `requireFirstName: false` (Windsor ↔ email, que fica por
 * conciliar — uma pessoa escolhe): os nomes só impedem se forem os dois
 * conhecidos e diferentes. PURA.
 */
export function sameReview(a: ReviewDedupFacts, b: ReviewDedupFacts, opts: { requireFirstName?: boolean } = {}): boolean {
  if (a.id === b.id) return false;
  if (a.apiKey && b.apiKey) return false;
  if (!(a.rating >= 1 && a.rating <= 5) || a.rating !== b.rating) return false;
  if (a.textKey.length < REVIEW_DEDUP_MIN_TEXT || a.textKey !== b.textKey) return false;
  if (a.parkKey && b.parkKey && a.parkKey !== b.parkKey) return false;
  if (a.atMs == null || b.atMs == null || Math.abs(a.atMs - b.atMs) > REVIEW_DEDUP_WINDOW_HOURS * 3_600_000) return false;
  if (opts.requireFirstName === false) {
    if (a.firstName && b.firstName && a.firstName !== b.firstName) return false;
  } else if (!a.firstName || a.firstName !== b.firstName) {
    return false;
  }
  return true;
}

/**
 * A crítica que acabou de chegar é repetida de qual? A mais antiga das que
 * batem (a da API primeiro, se houver). `existing` = só as originais (sem
 * `duplicateOf`, não marcadas). null = é nova. PURA.
 */
export function findDuplicateOf(n: ReviewDedupFacts, existing: readonly ReviewDedupFacts[]): number | null {
  const hits = existing.filter((e) => sameReview(n, e)).sort(originalFirst);
  return hits[0]?.id ?? null;
}

/** Ordem de "qual fica como original": a da API (pode-se responder), depois a mais antiga. */
function originalFirst(a: ReviewDedupFacts, b: ReviewDedupFacts): number {
  if (a.apiKey !== b.apiKey) return a.apiKey ? -1 : 1;
  const ta = a.atMs ?? Number.MAX_SAFE_INTEGER;
  const tb = b.atMs ?? Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  return a.id - b.id;
}

/** Uma crítica para a limpeza dos repetidos. */
export interface DedupCleanupRow extends ReviewDedupFacts {
  notAReview: boolean;
  duplicateOf: number | null;
  /** Uma pessoa desfez a marca (nunca volta a ser proposta). */
  markUndone: boolean;
  /** Tem reclamação ou resposta publicada (uma pessoa mexeu — fica). */
  locked: boolean;
}

export interface DedupCleanupPlan {
  /** Marcar `id` como repetida de `duplicateOf`. */
  mark: Array<{ id: number; duplicateOf: number }>;
  /** Batem com outra mas ficam (porquê). */
  keep: Array<{ id: number; duplicateOf: number; why: string }>;
}

/**
 * Limpeza dos repetidos que já existem: em cada grupo de críticas iguais fica
 * a original (a da API, senão a mais antiga) e as outras marcam-se como
 * repetidas dela — salvo as que uma pessoa já desfez à mão e as que têm
 * reclamação ou resposta (essas ficam, para uma pessoa ver). PURA.
 */
export function planDuplicateCleanup(rows: readonly DedupCleanupRow[]): DedupCleanupPlan {
  const live = rows.filter((r) => !r.notAReview && r.duplicateOf == null).slice().sort(originalFirst);
  const taken = new Set<number>();
  const plan: DedupCleanupPlan = { mark: [], keep: [] };
  for (const original of live) {
    if (taken.has(original.id)) continue;
    taken.add(original.id);
    for (const other of live) {
      if (taken.has(other.id) || !sameReview(original, other)) continue;
      taken.add(other.id);
      if (other.markUndone) plan.keep.push({ id: other.id, duplicateOf: original.id, why: "Uma pessoa desfez a marca desta crítica." });
      else if (other.locked) plan.keep.push({ id: other.id, duplicateOf: original.id, why: "Tem reclamação ou resposta — fica para uma pessoa ver." });
      else plan.mark.push({ id: other.id, duplicateOf: original.id });
    }
  }
  return plan;
}

/** Data (texto da BD, UTC) → ms; null se não der. PURA. */
export function reviewDateMs(...dates: Array<string | Date | null | undefined>): number | null {
  for (const d of dates) {
    if (!d) continue;
    const ms = d instanceof Date ? d.getTime() : Date.parse(String(d).includes("T") ? String(d) : String(d).replace(" ", "T") + "Z");
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}
