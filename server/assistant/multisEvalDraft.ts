/**
 * Eval do Multis — RASCUNHO do conjunto A (plano MPV §8.2, F8). Até o Jorge e
 * 2 TL entregarem o conjunto A (21 out), as perguntas do "/multis/falhas" (as
 * marcadas sozinhas) e do 👎 servem de rascunho: anonimizadas, sem respostas,
 * para o Jorge rever e completar (secção, ferramenta, factos) antes de as
 * passar para conjuntoA/. NUNCA entram sozinhas no conjunto A.
 *
 * Anonimização (PURA, por regras simples — TEM de ser revista à mão):
 *  - emails, telefones, IBAN, NIF e matrículas pela redação de sempre
 *    (redactPii → [EMAIL_1], [TELEFONE_1], [MATRICULA_1]…);
 *  - nomes → [NOME]: os pedaços dos nomes da equipa (da lista dada; os curtos,
 *    como "Ana", "Rui" ou "Zé", só com maiúscula); uma lista FIXA de nomes e
 *    apelidos portugueses comuns, sem ligar a maiúsculas ("joaquim ligou",
 *    "JOAQUIM") — os que também são palavras ("Rosa", "Luz", "Cruz", "Paz",
 *    "Santos", "Leite", "Dias", "Costa"…) só com maiúscula; a palavra a seguir
 *    a um título ("Sr.", "Sra.", "D.", "Dr.", "Dra.", "Eng."); e, por
 *    heurística, palavras com maiúscula no meio da frase que não são
 *    vocabulário da aplicação (os títulos da ajuda, cidades, marcas, dias e
 *    meses) — apanha clientes ("o cliente Joaquim Ferreira ligou"); no início
 *    da frase, só quando vêm duas com maiúscula seguidas. Nunca as siglas
 *    (PDA, TL, B-INJ), as letras sozinhas nem as coladas a algarismos (P2, T1);
 *  - números compridos (≥ 5 algarismos: códigos, reservas) → [N];
 *  - a página: sem o "?…" nem os ids (/reservas/123 → /reservas/:id).
 * Sem quem perguntou (só o papel), sem a resposta.
 */
import { redactPii } from "../_core/ai/pii";
import { EVAL_CITIES, stripAccents, type EvalQuestion, type EvalRole } from "../../shared/multisEval";

export interface FailedFeedbackRow {
  id: number;
  role: string | null;
  /** errada | incompleta | nao_percebeu | sem_dados | outro (👎) ou o motivo automático. */
  reason: string | null;
  comment: string | null;
  question: string | null;
  path: string | null;
  tools: string | null;
  helpFiles: string | null;
  auto: number | boolean;
  resolved: boolean;
  createdAt: string | null;
}

/** Papel da conta → papel do eval. PURA. */
export function evalRoleOf(role: string | null | undefined): EvalRole {
  switch (role) {
    case "team_leader": return "team_leader";
    case "supervisor": case "frontoffice": case "backoffice": return "supervisor";
    case "admin": return "admin";
    case "super_admin": return "super_admin";
    default: return "extra";
  }
}

const fold = (w: string) => stripAccents(w).toLowerCase();

/** Palavras que nunca se tapam como nomes: cidades, marcas, termos da operação, dias e meses. */
const BASE_VOCAB = [
  ...EVAL_CITIES, "Multipark", "Redpark", "Skypark", "Airpark", "Multis", "Zello", "Google", "WhatsApp", "Gmail", "Drive", "Excel", "Gemini", "Argon",
  "Parque", "Terminal", "Extra", "Extras", "Caixa", "Dia", "Pressão", "Ficha", "Reserva", "Reservas", "Despesas", "Faturação", "Parcerias", "Formação",
  "Avaliação", "Críticas", "Reclamações", "Ocorrências", "Perdidos", "Definições", "Dashboards", "Operacional", "Supervisor", "Team", "Leader", "Admin",
  "Aeroporto", "Oriente", "Rossio", "Entrecampos", "Sete", "Rios", "Pro", "Pró", "Back", "Office", "Front", "Central",
  "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo",
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
/** Partículas dos nomes que nunca são nome sozinhas. */
const PARTICLES = new Set(["da", "de", "do", "das", "dos", "e", "d"]);

/** Títulos de tratamento: a palavra a seguir é um nome ("Sr. Manuel", "D. Rosa"). */
export const NAME_TITLES: ReadonlySet<string> = new Set(["sr", "sra", "srª", "d", "dr", "dra", "drª", "eng", "enga", "engª", "prof", "profª"]);

/**
 * Nomes e apelidos portugueses comuns (sem acentos, minúsculas): tapam-se
 * sem ligar a maiúsculas. Os de NAME_WORDS também são palavras e só se tapam
 * com maiúscula.
 */
export const COMMON_NAMES: ReadonlySet<string> = new Set([
  // nomes próprios
  "joao", "jose", "antonio", "manuel", "francisco", "joaquim", "pedro", "paulo", "carlos", "jorge", "rui", "miguel", "andre", "tiago", "diogo",
  "bruno", "ricardo", "fernando", "sergio", "hugo", "vitor", "nelson", "filipe", "fabio", "daniel", "david", "goncalo", "guilherme", "gabriel",
  "rafael", "samuel", "alexandre", "leonardo", "lucas", "mateus", "vicente", "artur", "alvaro", "armando", "abel", "adriano", "alberto", "americo",
  "anibal", "augusto", "bernardo", "caetano", "cesar", "custodio", "eduardo", "emanuel", "fausto", "fernao", "gil", "horacio", "helder", "ivo",
  "jaime", "julio", "leandro", "lino", "marcelo", "mauro", "norberto", "oscar", "orlando", "patricio", "raul", "renato", "rogerio", "ruben",
  "sandro", "silvestre", "valter", "walter", "xavier", "ze", "nuno", "rodrigo", "henrique", "afonso", "martim", "simao", "dinis", "gaspar",
  "luis", "lourenco", "duarte", "tomas", "marco", "domingos", "salvador",
  "maria", "ana", "joana", "ines", "beatriz", "mariana", "carolina", "sofia", "catarina", "margarida", "leonor", "matilde", "francisca", "rita",
  "sara", "marta", "teresa", "isabel", "helena", "claudia", "patricia", "sandra", "susana", "paula", "andreia", "vanessa", "filipa", "daniela",
  "raquel", "diana", "carla", "cristina", "sonia", "fernanda", "manuela", "lurdes", "fatima", "conceicao", "celia", "lucia", "luisa", "madalena",
  "marcia", "monica", "natalia", "olga", "silvia", "tania", "vera", "alice", "alexandra", "barbara", "bruna", "eva", "julia", "laura", "lara",
  "camila", "ema", "irene", "amelia", "adelaide", "benedita", "bianca", "carmo", "dulce", "estela", "elsa", "emilia", "gabriela", "joaquina",
  "ligia", "liliana", "mafalda", "noemia", "odete", "regina", "salome", "telma", "yara", "zelia",
  "clara", "rosa", "luz", "graca", "gloria", "dores", "vitoria", "aurora", "rosario", "piedade", "ceu", "flor", "branca",
  // apelidos
  "silva", "santos", "ferreira", "pereira", "oliveira", "costa", "rodrigues", "martins", "sousa", "fernandes", "goncalves", "gomes", "lopes",
  "marques", "alves", "almeida", "ribeiro", "pinto", "carvalho", "teixeira", "moreira", "correia", "mendes", "nunes", "soares", "vieira",
  "monteiro", "cardoso", "rocha", "neves", "coelho", "cruz", "cunha", "pires", "ramos", "reis", "simoes", "antunes", "matos", "fonseca",
  "machado", "araujo", "barbosa", "tavares", "castro", "figueiredo", "azevedo", "freitas", "silveira", "henriques", "leite", "paiva", "campos",
  "batista", "baptista", "brito", "magalhaes", "moura", "guerra", "miranda", "faria", "abreu", "valente", "domingues", "morais", "nogueira",
  "vaz", "pacheco", "sequeira", "branco", "garcia", "torres", "loureiro", "amaral", "esteves", "borges", "macedo", "pinheiro", "dias", "lima",
  "mota", "melo", "pinho", "andrade", "barros", "maia", "medeiros", "mourao", "pimentel", "rebelo", "resende", "salgado", "seixas", "serra",
  "vasconcelos", "veloso", "paz", "jesus",
]);

/** Nomes que também são palavras (ou cidades): só se tapam com maiúscula. */
export const NAME_WORDS: ReadonlySet<string> = new Set([
  "rosa", "luz", "cruz", "paz", "santos", "leite", "clara", "branca", "branco", "gloria", "graca", "dores", "vitoria", "aurora", "rosario",
  "piedade", "ceu", "flor", "neves", "lima", "dias", "costa", "ramos", "reis", "rocha", "matos", "campos", "coelho", "pinto", "carvalho",
  "machado", "cunha", "guerra", "pinheiro", "torres", "serra", "valente", "salgado", "barros", "maia", "faria", "miranda", "moura", "ribeiro",
  "tomas", "marco", "domingos", "salvador", "jesus", "mota", "castro",
]);

/** O vocabulário da aplicação (palavras dos títulos da ajuda + as fixas), sem acentos e em minúsculas. PURA. */
export function appVocabulary(titles: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  for (const t of [...BASE_VOCAB, ...titles]) for (const w of fold(t).split(/[^a-z0-9]+/)) if (w.length >= 2) out.add(w);
  return out;
}

let vocabMemo: Set<string> | null = null;
/** O vocabulário com os títulos da árvore da ajuda (lido uma vez). */
export async function defaultAppVocabulary(): Promise<Set<string>> {
  if (vocabMemo) return vocabMemo;
  const { knowledgeTree } = await import("./knowledgeTree");
  const titles = knowledgeTree().groups.flatMap((g) => [g.group, ...g.pages.flatMap((p) => [p.title, ...p.sections.map((s) => s.title)])]);
  vocabMemo = appVocabulary(titles);
  return vocabMemo;
}

/** Os pedaços dos nomes da equipa que se tapam (sem acentos, minúsculas; sem partículas nem cidades). PURA. */
export function nameTokens(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  const cities = new Set(EVAL_CITIES.map((c) => fold(c)));
  for (const n of names) for (const w of fold(String(n ?? "")).split(/[^a-z]+/)) if (w.length >= 2 && !PARTICLES.has(w) && !cities.has(w)) out.add(w);
  return out;
}

const isCap = (w: string) => /^\p{Lu}/u.test(w) && !/^\p{Lu}{2,}$/u.test(w);
/** Sigla: só maiúsculas (com hífenes), ≥ 2 letras — PDA, TL, B-INJ. */
const isAcronym = (w: string) => { const l = w.replace(/[-'’]/g, ""); return l.length >= 2 && /^\p{Lu}+$/u.test(l); };

/**
 * Anonimiza um texto escrito pela pessoa (ver o topo). `vocab` = palavras que
 * nunca são nome (omissão: só as fixas; o script passa as da ajuda). PURA.
 */
export function anonymizeText(text: string, names: ReadonlySet<string>, vocab: ReadonlySet<string> = appVocabulary()): string {
  let t = redactPii(String(text ?? "")).text;
  const words = [...t.matchAll(/[\p{L}][\p{L}'’-]*/gu)];
  const hide = new Set<number>();
  words.forEach((m, i) => {
    const w = m[0];
    const at = m.index ?? 0;
    // Os marcadores da redação ([EMAIL_1]…) ficam.
    if (t[at - 1] === "[" || /^\p{Lu}+$/u.test(w) && t[at + w.length] === "_") return;
    const f = fold(w);
    const upper = /^\p{Lu}/u.test(w);
    const next = words[i + 1];
    // Título de tratamento ("Sr. Manuel", "D. Rosa"): fica o título, tapa-se a palavra seguinte.
    if (upper && NAME_TITLES.has(f) && next && /^\.?\s+$/.test(t.slice(at + w.length, next.index))) {
      // "Sra. D. Rosa": o título seguinte fica e é ele que tapa o nome.
      if (!NAME_TITLES.has(fold(next[0]))) hide.add(i + 1);
      return;
    }
    if (hide.has(i)) return;
    // Equipa: os pedaços curtos e os que também são palavras ("Santos") só com maiúscula.
    if (names.has(f) && (upper || (f.length >= 4 && !NAME_WORDS.has(f)))) { hide.add(i); return; }
    // Nomes comuns: sem ligar a maiúsculas; os que também são palavras, só com maiúscula.
    if (COMMON_NAMES.has(f) && (!NAME_WORDS.has(f) || upper)) { hide.add(i); return; }
    // Nunca: letras sozinhas, siglas, palavras coladas a algarismos (P2, T1, 3A).
    if (w.length === 1 || isAcronym(w) || /\d/.test(t[at + w.length] ?? "") || /\d/.test(t[at - 1] ?? "")) return;
    if (!isCap(w) || vocab.has(f) || PARTICLES.has(f)) return;
    const sentenceStart = /(^|[.!?:;«"(\n])\s*$/.test(t.slice(0, at));
    const nextCap = !!next && isCap(next[0]) && !vocab.has(fold(next[0])) && /^\s+$/.test(t.slice(at + w.length, next.index));
    if (!sentenceStart || nextCap) hide.add(i);
  });
  // Da direita para a esquerda (os índices não mudam).
  for (const i of [...hide].sort((a, b) => b - a)) {
    const m = words[i];
    const at = m.index ?? 0;
    t = `${t.slice(0, at)}[NOME]${t.slice(at + m[0].length)}`;
  }
  t = t.replace(/\[NOME\]((\s+(da|de|do|das|dos|e))?\s+\[NOME\])+/g, "[NOME]");
  t = t.replace(/\b\d{5,}\b/g, "[N]");
  return t.replace(/\s+/g, " ").trim();
}

/** A página sem o "?…" nem os ids (números, códigos com algarismos, uuids) → ":id". PURA. */
export function anonymizePath(path: string | null | undefined): string {
  const p = String(path ?? "").split(/[?#]/)[0].trim();
  if (!p.startsWith("/")) return "/";
  const out = p.split("/").map((seg, i) => (i === 0 || !seg ? seg : /\d/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) ? ":id" : seg)).join("/");
  return out.slice(0, 200) || "/";
}

/** A pasta (relativa à raiz do repositório) onde o rascunho pode ser escrito — fora do git. */
export const DRAFT_DIR = ["server", "fixtures", "multisEval", "rascunhoA"] as const;

/**
 * O ficheiro do rascunho fica DIRETAMENTE em server/fixtures/multisEval/rascunhoA/
 * (fora do git) e é um .json? `resolved` e `root` já absolutos (path.resolve). PURA.
 */
export function draftOutPathOk(resolved: string, root: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const dir = norm([root, ...DRAFT_DIR].join("/"));
  const file = norm(resolved);
  if (!file.startsWith(`${dir}/`)) return false;
  const name = file.slice(dir.length + 1);
  return !!name && !name.includes("/") && name !== ".." && name.endsWith(".json");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const listOf = (v: string | null) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const normQ = (s: string) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * As linhas do /multis/falhas e do 👎 → perguntas de RASCUNHO (anonimizadas,
 * sem repetidas — a mesma pergunta conta uma vez, com o nº de vezes na nota).
 * Secção, ferramenta e factos ficam por preencher (null / vazios). PURA.
 */
export function buildSetADraft(
  rows: readonly FailedFeedbackRow[], names: readonly string[], o: { max?: number; vocab?: ReadonlySet<string> } = {},
): { questions: EvalQuestion[]; skipped: number } {
  const tokens = nameTokens(names);
  const vocab = o.vocab ?? appVocabulary();
  const anon = (s: string) => anonymizeText(s, tokens, vocab);
  const byKey = new Map<string, { row: FailedFeedbackRow; q: string; path: string; n: number; reasons: Set<string> }>();
  let skipped = 0;
  for (const r of rows) {
    const q = anon(r.question ?? "");
    if (q.length < 3) { skipped++; continue; }
    const path = anonymizePath(r.path);
    const k = `${normQ(q)}|${path}`;
    const cur = byKey.get(k);
    const why = r.auto ? `automática: ${clip(anon(r.comment ?? r.reason ?? ""), 120)}` : `👎 ${r.reason ?? "sem motivo"}${r.comment ? ` — «${clip(anon(r.comment), 160)}»` : ""}`;
    if (cur) { cur.n++; cur.reasons.add(why); continue; }
    byKey.set(k, { row: r, q, path, n: 1, reasons: new Set([why]) });
  }
  const max = Math.max(1, o.max ?? 200);
  const questions: EvalQuestion[] = [...byKey.values()].slice(0, max).map((x, i) => {
    const tools = listOf(x.row.tools);
    const help = listOf(x.row.helpFiles);
    return {
      id: `A-RASC-${String(i + 1).padStart(3, "0")}`,
      pergunta: clip(x.q, 1000),
      pagina: x.path,
      separador: null,
      papel: evalRoleOf(x.row.role),
      seccaoEsperada: null,
      ferramentaEsperada: null,
      factosObrigatorios: [],
      factosProibidos: [],
      gravacoes: [],
      nota: clip([
        "RASCUNHO — anonimizado por regras simples: rever à mão (nomes, contactos, códigos) e preencher seccaoEsperada, ferramentaEsperada, factos e gravações antes de passar para conjuntoA/.",
        `${x.n}× ${[...x.reasons].join(" | ")}`,
        tools.length ? `Ferramentas usadas: ${tools.join(", ")}.` : null,
        help.length ? `Ajuda usada: ${help.join(", ")}.` : null,
        x.row.resolved ? "Já marcada como tratada." : null,
      ].filter(Boolean).join(" "), 500),
    };
  });
  return { questions, skipped };
}
