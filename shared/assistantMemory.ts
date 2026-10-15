/**
 * Memória do Multis (Jorge, 8 out 2026 — "Multis 2") — regras PARTILHADAS
 * servidor ↔ cliente. PURAS.
 *
 *  - Notas pessoais: a pessoa escreve no chat uma mensagem que COMEÇA por
 *    "Lembra-te", "Memoriza" ou "Não te esqueças" e o servidor guarda o resto
 *    tal e qual (não é a IA que decide; nem é chamada). Máx. 30 ativas.
 *  - Notas da empresa: só admin/super_admin acrescentam ou arquivam; toda a
 *    gente as vê (só leitura). Máx. 100 ativas.
 *  - Nada se apaga: arquivar = marcar `archivedAt`; repor = tirar a marca.
 *  - No turno vão num bloco <memoria> no CONTEXTO (nunca no prompt estável,
 *    para não partir a cache de contexto).
 */
import { ROLE_RANK, roleRank } from "./access";
import { matchKey } from "./textKey";

export type MemoryScope = "user" | "company";

export const MEMORY_MAX_CHARS = 300;
export const MEMORY_MAX_PERSONAL = 30;
export const MEMORY_MAX_COMPANY = 100;
/** Teto (aprox.) do bloco <memoria>; acima disto as notas da empresa são escolhidas pela pergunta. */
export const MEMORY_BLOCK_MAX_CHARS = 3000;
/** Espaço mínimo para as notas da empresa quando as pessoais já enchem o teto. */
export const MEMORY_COMPANY_MIN_CHARS = 1200;

/** Admin ou super_admin: gere a memória da empresa e vê as perguntas que falharam. PURA. */
export function isMultisAdmin(role: string | null | undefined): boolean {
  return roleRank(role) >= ROLE_RANK.admin;
}

export type RememberCommand =
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "too_long"; length: number }
  | { kind: "note"; text: string };

// "Multis, " e "por favor" à frente ainda contam; o verbo tem de vir logo a seguir.
const REMEMBER_RE = /^(?:multis\s*[,:;!.\-–—]?\s*)?(?:por\s+favor\s*[,:;]?\s*)?(?:lembra[\s\-‐‑–—]*te|memoriza|n[ãa]o\s+te\s+esque[çc]as)(?=$|[\s,:;.!\-–—])/iu;
// "que", "de que", "disto", "isto", "o seguinte"… a seguir ao verbo não fazem parte da nota.
const CONNECTOR_RE = /^[\s,:;.!\-–—]*(?:(?:(?:de\s+)?que|disto|disso|isto|isso|(?:d?o\s+)?seguinte)(?=$|[\s,:;.!\-–—]))?[\s,:;.!\-–—]*/iu;

/**
 * A mensagem é um pedido para guardar uma nota? Só quando COMEÇA pelo verbo
 * ("Lembra-te…", "Lembra te…", "Memoriza…", "Não te esqueças…", sem contar
 * maiúsculas e acentos) e não é uma pergunta (acaba em "?"). PURA.
 */
export function parseRememberCommand(raw: string | null | undefined): RememberCommand {
  const s = String(raw ?? "").normalize("NFC").trim();
  const m = REMEMBER_RE.exec(s);
  if (!m) return { kind: "none" };
  if (s.endsWith("?")) return { kind: "none" };
  const rest = s.slice(m[0].length).replace(CONNECTOR_RE, "").replace(/\s+/g, " ").trim();
  if (!rest) return { kind: "empty" };
  if (rest.length > MEMORY_MAX_CHARS) return { kind: "too_long", length: rest.length };
  return { kind: "note", text: rest.charAt(0).toLocaleUpperCase("pt-PT") + rest.slice(1) };
}

/** Texto de uma nota escrita à mão (limpo). null = vazio ou longo demais. PURA. */
export function cleanMemoryText(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > MEMORY_MAX_CHARS) return null;
  return t;
}

/** Já existe uma nota ativa igual (sem contar maiúsculas, acentos e pontuação)? PURA. */
export function isDuplicateMemory(text: string, existing: readonly { text: string }[]): boolean {
  const k = matchKey(text);
  return !!k && existing.some((e) => matchKey(e.text) === k);
}

/** Respostas do Multis ao "Lembra-te" (sem IA). PURAS. */
export const REMEMBER_MESSAGES = {
  saved: (text: string) => `Fica guardado: «${text}».\n\nVês e arquivas as tuas notas em **Memória** (no topo deste painel).`,
  exists: (text: string) => `Isso já estava guardado: «${text}».`,
  empty: "Diz-me o que queres que guarde, por exemplo: «Lembra-te: sou do Porto, dá-me sempre os números por parque.»",
  tooLong: (length: number) => `A nota é demasiado longa (${length} caracteres; o máximo é ${MEMORY_MAX_CHARS}). Encurta-a e volta a escrever «Lembra-te: …».`,
  full: `Já tens ${MEMORY_MAX_PERSONAL} notas guardadas. Arquiva alguma em **Memória** (no topo deste painel) e volta a pedir.`,
  failed: "Não consegui guardar a nota agora. Tenta outra vez daqui a pouco.",
} as const;

const STEM = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);
const STOP = new Set("que para com sem uma uns umas dos das nos nas por como mais menos muito isto isso esta este essa esse sao ser tem ter sempre nunca".split(" "));
function stems(s: string): Set<string> {
  return new Set(
    String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map(STEM),
  );
}

export interface MemoryNote { text: string }

/**
 * Bloco <memoria> do turno. As notas pessoais vão todas (são poucas e são
 * preferências da própria pessoa); as da empresa também, se tudo couber em
 * ~3000 caracteres — senão escolhem-se as mais relevantes para a pergunta
 * (palavras em comum; empate → a mais recente, que vem primeiro). Sem notas →
 * "". PURA.
 */
export function memoryBlock(personal: readonly MemoryNote[], company: readonly MemoryNote[], question: string, maxChars = MEMORY_BLOCK_MAX_CHARS): string {
  if (!personal.length && !company.length) return "";
  const len = (n: MemoryNote) => n.text.length + 3;
  const personalChars = personal.reduce((s, n) => s + len(n), 0);
  const companyChars = company.reduce((s, n) => s + len(n), 0);
  let chosen: MemoryNote[] = [...company];
  if (personalChars + companyChars > maxChars) {
    const budget = Math.max(MEMORY_COMPANY_MIN_CHARS, maxChars - personalChars);
    const q = stems(question);
    const ranked = company
      .map((n, i) => {
        const s = stems(n.text);
        let hits = 0;
        for (const w of q) if (s.has(w)) hits++;
        return { n, i, hits };
      })
      .sort((a, b) => b.hits - a.hits || a.i - b.i);
    chosen = [];
    let used = 0;
    for (const r of ranked) {
      if (used + len(r.n) > budget) continue;
      chosen.push(r.n);
      used += len(r.n);
    }
  }
  const lines: string[] = [];
  if (personal.length) {
    lines.push("Notas que esta pessoa pediu para lembrar:");
    for (const n of personal) lines.push(`- ${n.text}`);
  }
  if (chosen.length) {
    lines.push("Notas da empresa:");
    for (const n of chosen) lines.push(`- ${n.text}`);
  }
  return lines.length ? `<memoria>\n${lines.join("\n")}\n</memoria>` : "";
}
