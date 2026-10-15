/**
 * Eval do Multis — RASCUNHO do conjunto A (plano MPV §8.2, F8). Até o Jorge e
 * 2 TL entregarem o conjunto A (21 out), as perguntas do "/multis/falhas" (as
 * marcadas sozinhas) e do 👎 servem de rascunho: anonimizadas, sem respostas,
 * para o Jorge rever e completar (secção, ferramenta, factos) antes de as
 * passar para conjuntoA/. NUNCA entram sozinhas no conjunto A.
 *
 * Anonimização (PURA): emails, telefones, IBAN, NIF e matrículas pela redação
 * de sempre (redactPii → [EMAIL_1]…); nomes de colegas (da lista de nomes
 * dada) → [NOME]; números compridos (≥ 5 algarismos: códigos, reservas) →
 * [N]. Sem quem perguntou (só o papel), sem a resposta.
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

/** Palavras que nunca se tapam como nomes (cidades e termos da operação). */
const NOT_NAMES = new Set(["lisboa", "porto", "faro", "multipark", "redpark", "skypark", "airpark", "parque", "terminal", "extra", "extras", "caixa"]);

/** Os pedaços dos nomes (≥ 4 letras, sem acentos, minúsculas) que se tapam. PURA. */
export function nameTokens(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) for (const w of stripAccents(String(n ?? "")).toLowerCase().split(/[^a-z]+/)) if (w.length >= 4 && !NOT_NAMES.has(w)) out.add(w);
  for (const c of EVAL_CITIES) out.delete(stripAccents(c).toLowerCase());
  return out;
}

/** Anonimiza um texto escrito pela pessoa. PURA. */
export function anonymizeText(text: string, names: ReadonlySet<string>): string {
  let t = redactPii(String(text ?? "")).text;
  t = t.replace(/\p{L}+/gu, (w) => (names.has(stripAccents(w).toLowerCase()) ? "[NOME]" : w));
  t = t.replace(/\[NOME\](\s+\[NOME\])+/g, "[NOME]");
  t = t.replace(/\b\d{5,}\b/g, "[N]");
  return t.replace(/\s+/g, " ").trim();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const listOf = (v: string | null) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const normQ = (s: string) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * As linhas do /multis/falhas e do 👎 → perguntas de RASCUNHO (anonimizadas,
 * sem repetidas — a mesma pergunta conta uma vez, com o nº de vezes na nota).
 * Secção, ferramenta e factos ficam por preencher (null / vazios). PURA.
 */
export function buildSetADraft(rows: readonly FailedFeedbackRow[], names: readonly string[], o: { max?: number } = {}): { questions: EvalQuestion[]; skipped: number } {
  const tokens = nameTokens(names);
  const byKey = new Map<string, { row: FailedFeedbackRow; q: string; n: number; reasons: Set<string> }>();
  let skipped = 0;
  for (const r of rows) {
    const q = anonymizeText(r.question ?? "", tokens);
    if (q.length < 3) { skipped++; continue; }
    const k = `${normQ(q)}|${r.path ?? ""}`;
    const cur = byKey.get(k);
    const why = r.auto ? `automática: ${clip(anonymizeText(r.comment ?? r.reason ?? "", tokens), 120)}` : `👎 ${r.reason ?? "sem motivo"}${r.comment ? ` — «${clip(anonymizeText(r.comment, tokens), 160)}»` : ""}`;
    if (cur) { cur.n++; cur.reasons.add(why); continue; }
    byKey.set(k, { row: r, q, n: 1, reasons: new Set([why]) });
  }
  const max = Math.max(1, o.max ?? 200);
  const questions: EvalQuestion[] = [...byKey.values()].slice(0, max).map((x, i) => {
    const tools = listOf(x.row.tools);
    const help = listOf(x.row.helpFiles);
    const path = x.row.path && x.row.path.startsWith("/") ? x.row.path.split("?")[0].slice(0, 200) : "/";
    return {
      id: `A-RASC-${String(i + 1).padStart(3, "0")}`,
      pergunta: clip(x.q, 1000),
      pagina: path,
      separador: null,
      papel: evalRoleOf(x.row.role),
      seccaoEsperada: null,
      ferramentaEsperada: null,
      factosObrigatorios: [],
      factosProibidos: [],
      gravacoes: [],
      nota: clip([
        "RASCUNHO — rever e preencher seccaoEsperada, ferramentaEsperada, factos (e gravações) antes de passar para conjuntoA/.",
        `${x.n}× ${[...x.reasons].join(" | ")}`,
        tools.length ? `Ferramentas usadas: ${tools.join(", ")}.` : null,
        help.length ? `Ajuda usada: ${help.join(", ")}.` : null,
        x.row.resolved ? "Já marcada como tratada." : null,
      ].filter(Boolean).join(" "), 500),
    };
  });
  return { questions, skipped };
}
