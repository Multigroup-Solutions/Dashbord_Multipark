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
 * mais caracteres) + nome + até 48 h de diferença.
 *  - O texto do email tira-se PELA POSITIVA: só o que está entre a linha do
 *    nome/estrelas e o botão "Responder". Sem os dois limites = sem texto
 *    (um rodapé novo da Google nunca vira "texto" de todas as críticas).
 *  - Sem texto (só estrelas) nunca se junta sozinha.
 *  - Nomes: com 2 ou mais palavras dos dois lados, o nome completo tem de ser
 *    igual; o 1.º nome só chega quando um dos lados tem uma palavra.
 *  - Um texto que aparece em críticas de pessoas diferentes é "genérico" (=
 *    sem texto): "Excelente serviço, recomendo" de duas pessoas nunca junta.
 *
 * TODO (antes de ligar o REVIEWS_DEDUP): conferir os limites do texto com
 * amostras REAIS dos dois formatos de email da Google (o Jorge manda). Os
 * testes usam emails reconstruídos a partir do plano.
 */
import { isGoogleBusinessSender, isReviewNoticeSender } from "./mailTriage";
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

/**
 * Email-resumo de críticas: vem da Google (Business Profile), bate no padrão
 * de resumo, não é uma crítica isolada e não traz um avaliador com texto.
 * PURA.
 */
export function isReviewSummaryEmail(f: {
  fromEmail: string | null | undefined;
  subject: string | null | undefined;
  body: string | null | undefined;
  /** O leitor achou um avaliador e um texto de crítica → nunca é resumo. */
  reviewerWithText?: boolean;
}): boolean {
  if (!isGoogleBusinessSender(f.fromEmail) || f.reviewerWithText) return false;
  const text = `${f.subject ?? ""}\n${f.body ?? ""}`;
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
  reviewerWithText?: boolean;
}): EmailReviewVerdict {
  if ((f.strict || f.dedup) && !(f.rating > 0) && isReviewSummaryEmail(f)) return "summary";
  if (f.strict && !isReviewNoticeSender(f.fromEmail) && !(f.rating > 0)) return "not_review";
  return "review";
}

/** O que a limpeza das "não críticas" olha em cada crítica que entrou por email. */
export interface NotAReviewRow {
  id: number;
  /** Remetente do email que a trouxe (inbound_emails, senão mail_messages); null = não se sabe. */
  fromEmail: string | null;
  /** Estrelas (as guardadas ou relidas do texto). */
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
 * pessoa já mexeu, tem reclamação, remetente desconhecido, já foi desfeita à
 * mão…); null = não é candidata (é crítica, ou já está marcada). PURA.
 */
export function notAReviewDecision(r: NotAReviewRow): { action: "mark" } | { action: "keep"; why: string } | null {
  if (!r.sourceEmailId || r.googleReviewKey) return null;
  if (r.notAReview || r.duplicateOf != null) return null;
  if (r.rating > 0 || isReviewNoticeSender(r.fromEmail)) return null;
  if (!String(r.fromEmail ?? "").trim()) return { action: "keep", why: "Remetente desconhecido (o email já não está guardado)." };
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

const STARS_LINE_RE = /^[★☆✩✪⭐\s]+$/u;
/** O botão "Responder" (fim do texto da crítica); "Responder às críticas mostra…" é rodapé. */
const END_LINE_RE = /^(?:responder|reply)\b(?!\s+(?:às|as)\s+cr[íi]ticas)/i;

/** O nome do avaliador normalizado (palavras separadas por espaço); null se não é nome de pessoa. PURA. */
export function reviewerNameKey(name: string | null | undefined): string | null {
  const words = matchWords(name);
  if (!words.length || GENERIC_NAME_KEYS.has(words.join(""))) return null;
  return words.join(" ");
}

/** 1.º nome normalizado; null quando não é nome de pessoa. PURA. */
export function reviewerFirstNameKey(name: string | null | undefined): string | null {
  return reviewerNameKey(name)?.split(" ")[0] ?? null;
}

/**
 * Os dois nomes (já `reviewerNameKey`) são a mesma pessoa? Com 2 ou mais
 * palavras dos dois lados, o nome completo tem de ser igual; com uma palavra
 * num dos lados, chega o 1.º nome. Um nome desconhecido: `unknownOk`. PURA.
 */
export function namesCompatible(a: string | null, b: string | null, unknownOk = false): boolean {
  if (!a || !b) return unknownOk;
  const wa = a.split(" ");
  const wb = b.split(" ");
  if (wa.length >= 2 && wb.length >= 2) return a === b;
  return wa[0] === wb[0];
}

/** A linha é o nome do avaliador (completo, ou um nome curto que começa pelo 1.º nome)? */
function isNameLine(line: string, name: string | null | undefined): boolean {
  const key = matchKey(name);
  if (!key) return false;
  if (matchKey(line) === key) return true;
  const first = matchWords(name)[0];
  const words = matchWords(line);
  return !!first && words.length >= 1 && words.length <= 4 && words[0] === first && !/[.!?,;:]/.test(line);
}

/**
 * O texto da PRÓPRIA crítica num email da Google, tirado pela positiva: o que
 * está entre a última linha de cabeçalho (o nome do avaliador, as estrelas ou
 * "crítica de N estrela(s)") e o botão "Responder". Sem os dois limites, ou
 * "Este utilizador deixou apenas uma classificação" → "" (sem texto). PURA.
 */
export function reviewCommentFromEmail(rawBody: string | null | undefined, reviewerName?: string | null): string {
  const lines = String(rawBody ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim());
  if (lines.some((l) => /este utilizador deixou apenas/i.test(l))) return "";
  const isHead = (l: string) => SINGLE_RATING_RE.test(l) || (!!l && STARS_LINE_RE.test(l)) || isNameLine(l, reviewerName);
  const first = lines.findIndex(isHead);
  if (first < 0) return "";
  const end = lines.findIndex((l, i) => i > first && END_LINE_RE.test(l));
  if (end < 0) return "";
  let start = first;
  for (let i = first; i < end; i++) if (isHead(lines[i])) start = i;
  return lines.slice(start + 1, end)
    .filter((l) => l && !/https?:\/\//i.test(l) && !/^<[^>]*>$/.test(l) && !!matchKey(l))
    .join(" ");
}

/** Chave do texto de uma crítica de EMAIL (pela positiva). PURA. */
export function reviewTextKeyFromEmail(rawBody: string | null | undefined, reviewerName?: string | null): string {
  return searchText(reviewCommentFromEmail(rawBody, reviewerName));
}

/** Chave do texto de uma crítica da API/Windsor (o texto já é só a crítica). PURA. */
export function reviewTextKeyFromApi(text: string | null | undefined): string {
  return searchText(String(text ?? "").split("\n").filter((l) => !/https?:\/\//i.test(l)).join(" "));
}

/** Os factos de uma crítica que a chave de repetida usa. */
export interface ReviewDedupFacts {
  id: number;
  /** Parque (projectId); null = não se sabe (o email não disse) — não impede de juntar. */
  parkKey: string | null;
  rating: number;
  /** Chave do texto da crítica ("" = sem texto). */
  textKey: string;
  /** `reviewerNameKey`. */
  name: string | null;
  /** Quando foi escrita (data da crítica, senão a do email, senão a de entrada). */
  atMs: number | null;
  /** Veio da API/Windsor (tem `googleReviewKey`). Duas destas nunca são a mesma. */
  apiKey: boolean;
}

/**
 * Textos "genéricos": o mesmo texto em críticas de pessoas diferentes (nomes
 * incompatíveis). Contam como sem texto — nunca juntam sozinhos. PURA.
 */
export function genericTextKeys(rows: ReadonlyArray<Pick<ReviewDedupFacts, "textKey" | "name">>): Set<string> {
  const names = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.textKey.length < REVIEW_DEDUP_MIN_TEXT || !r.name) continue;
    const s = names.get(r.textKey) ?? new Set<string>();
    s.add(r.name);
    names.set(r.textKey, s);
  }
  const out = new Set<string>();
  for (const [key, set] of names) {
    const list = [...set];
    if (list.some((a, i) => list.slice(i + 1).some((b) => !namesCompatible(a, b)))) out.add(key);
  }
  return out;
}

/**
 * As duas são a mesma crítica? Mesmas estrelas (1–5), o mesmo texto com 20
 * ou mais caracteres, o mesmo parque (ou um deles sem parque), até 48 h e o
 * mesmo avaliador (`namesCompatible`). `requireName: false` (Windsor ↔ email,
 * que fica por conciliar — uma pessoa escolhe): um nome desconhecido não
 * impede; dois conhecidos têm de bater. PURA.
 */
export function sameReview(a: ReviewDedupFacts, b: ReviewDedupFacts, opts: { requireName?: boolean } = {}): boolean {
  if (a.id === b.id) return false;
  if (a.apiKey && b.apiKey) return false;
  if (!(a.rating >= 1 && a.rating <= 5) || a.rating !== b.rating) return false;
  if (a.textKey.length < REVIEW_DEDUP_MIN_TEXT || a.textKey !== b.textKey) return false;
  if (a.parkKey && b.parkKey && a.parkKey !== b.parkKey) return false;
  if (a.atMs == null || b.atMs == null || Math.abs(a.atMs - b.atMs) > REVIEW_DEDUP_WINDOW_HOURS * 3_600_000) return false;
  return namesCompatible(a.name, b.name, opts.requireName === false);
}

/**
 * A crítica que acabou de chegar é repetida de qual? A mais antiga das que
 * batem (a da API primeiro, se houver). `existing` = só as originais (sem
 * `duplicateOf`, não marcadas). Texto genérico (de pessoas diferentes entre
 * estas) → null. null = é nova. PURA.
 */
export function findDuplicateOf(n: ReviewDedupFacts, existing: readonly ReviewDedupFacts[]): number | null {
  if (genericTextKeys([n, ...existing]).has(n.textKey)) return null;
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
 * reclamação ou resposta (essas ficam, para uma pessoa ver). Só compara
 * dentro de (estrelas, texto) — não todas com todas. PURA.
 */
export function planDuplicateCleanup(rows: readonly DedupCleanupRow[]): DedupCleanupPlan {
  const live = rows.filter((r) => !r.notAReview && r.duplicateOf == null && r.textKey.length >= REVIEW_DEDUP_MIN_TEXT && r.rating >= 1);
  const generic = genericTextKeys(live);
  const groups = new Map<string, DedupCleanupRow[]>();
  for (const r of live) {
    if (generic.has(r.textKey)) continue;
    const k = `${r.rating}|${r.textKey}`;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  const plan: DedupCleanupPlan = { mark: [], keep: [] };
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort(originalFirst);
    const taken = new Set<number>();
    for (const original of g) {
      if (taken.has(original.id)) continue;
      taken.add(original.id);
      for (const other of g) {
        if (taken.has(other.id) || !sameReview(original, other)) continue;
        taken.add(other.id);
        if (other.markUndone) plan.keep.push({ id: other.id, duplicateOf: original.id, why: "Uma pessoa desfez a marca desta crítica." });
        else if (other.locked) plan.keep.push({ id: other.id, duplicateOf: original.id, why: "Tem reclamação ou resposta — fica para uma pessoa ver." });
        else plan.mark.push({ id: other.id, duplicateOf: original.id });
      }
    }
  }
  plan.mark.sort((a, b) => a.id - b.id);
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
