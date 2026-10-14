/**
 * Formação por ÁREA (Jorge, 14 out 2026: "tem de ficar dividido por
 * Multipark, Operacional, Comunicação e Dashboard, e depois as subsecções").
 * Partilhado servidor ↔ cliente. Tudo PURO.
 *
 *  - As quatro áreas e as subsecções por omissão (quem gere a formação pode
 *    escrever outra subsecção; as que já estão em uso aparecem como sugestão).
 *  - Proposta automática de área/subsecção a partir do título, da categoria
 *    e do texto (regras, sem IA): os conteúdos antigos ficam arrumados logo e
 *    quem gere confirma ou corrige ("Área proposta").
 *  - Pesquisa por tema no catálogo (palavras, sem acentos, com raiz e
 *    sinónimos simples) — a mesma no servidor e nos testes.
 */
import { matchKey, matchWords, searchText } from "./textKey";

export const TRAINING_AREA_IDS = ["multipark", "dashboard", "operacional", "comunicacao"] as const;
export type TrainingAreaId = (typeof TRAINING_AREA_IDS)[number];

export interface TrainingAreaDef {
  id: TrainingAreaId;
  label: string;
  /** Uma linha para quem escolhe (o que cabe nesta área). */
  hint: string;
  /** Subsecções por omissão (podem existir outras, escritas por quem gere). */
  subareas: readonly string[];
}

export const TRAINING_AREAS: readonly TrainingAreaDef[] = [
  { id: "multipark", label: "Multipark", hint: "A app Multipark: reservas, receber e entregar carros", subareas: ["Próximas reservas", "Receber um carro", "Entregar um carro", "Alterações e cancelamentos"] },
  { id: "dashboard", label: "Dashboard", hint: "Este dashboard: caixa, passagem de turno, ponto e tarefas", subareas: ["Financeiro", "Passagem de turno", "Ponto e escala", "Tarefas"] },
  { id: "operacional", label: "Operacional", hint: "No parque e na estrada: condução, chaves, danos e segurança", subareas: ["Condução e manobras", "Chaves e viaturas", "Danos e ocorrências", "Segurança"] },
  { id: "comunicacao", label: "Comunicação", hint: "Clientes, WhatsApp, email, rádio e reclamações", subareas: ["Atendimento ao cliente", "WhatsApp e email", "Rádio (Zello)", "Reclamações e críticas"] },
];

export const TRAINING_AREA_LABELS: Record<TrainingAreaId, string> = Object.fromEntries(TRAINING_AREAS.map((a) => [a.id, a.label])) as Record<TrainingAreaId, string>;

/** Rótulo dos conteúdos sem área (nem marcada nem proposta). */
export const NO_AREA_LABEL = "Outros";
/**
 * Valor gravado quando quem gere diz "não tem área" (fica em Outros e a app
 * deixa de propor uma). NULL na BD = ainda não arrumado (a app propõe).
 */
export const NO_AREA_ID = "none" as const;
/** Rótulo dos conteúdos de uma área sem subsecção. */
export const NO_SUBAREA_LABEL = "Geral";
export const SUBAREA_MAX = 80;

export function isTrainingArea(v: unknown): v is TrainingAreaId {
  return typeof v === "string" && (TRAINING_AREA_IDS as readonly string[]).includes(v);
}

export function trainingAreaDef(id: string | null | undefined): TrainingAreaDef | null {
  return TRAINING_AREAS.find((a) => a.id === id) ?? null;
}

/** Subsecção limpa (espaços, tamanho); vazia → null. PURA. */
export function cleanSubarea(s: string | null | undefined): string | null {
  const t = String(s ?? "").replace(/\s+/g, " ").trim().slice(0, SUBAREA_MAX).trim();
  return t ? t : null;
}

/** Mesma subsecção? (sem acentos, maiúsculas nem pontuação). PURA. */
export function sameSubarea(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = matchKey(a);
  return ka === matchKey(b);
}

/**
 * Subsecções a sugerir numa área: as por omissão e as que já estão em uso
 * (sem repetir a mesma escrita de outra maneira). PURA.
 */
export function subareaOptions(area: string | null | undefined, inUse: ReadonlyArray<{ area: string | null; subarea: string | null }> = []): string[] {
  const def = trainingAreaDef(area);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string | null | undefined) => {
    const c = cleanSubarea(s);
    if (!c) return;
    const k = matchKey(c);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  for (const s of def?.subareas ?? []) add(s);
  for (const r of inUse) if (r.area === area) add(r.subarea);
  return out;
}

// ─── Proposta automática (regras) ───────────────────────────────────────────

interface AreaRule { area: TrainingAreaId; subarea: string | null; terms: readonly string[] }

/**
 * Termos já sem acentos e em minúsculas; "*" no fim de uma palavra = qualquer
 * continuação ("reserv*" → reserva, reservas, reservar). Uma regra conta uma
 * vez por campo (título 3, categoria 2, texto 1), por muitas vezes que apareça.
 */
const AREA_RULES: readonly AreaRule[] = [
  // Dashboard (esta aplicação)
  { area: "dashboard", subarea: null, terms: ["dashboard", "barni", "definicoes do dashboard", "menu do dashboard"] },
  { area: "dashboard", subarea: "Financeiro", terms: ["caixa*", "fecho de caixa", "fechar a caixa", "despes*", "fatur*", "multibanco", "dinheiro", "talao", "taloes", "financeir*"] },
  { area: "dashboard", subarea: "Passagem de turno", terms: ["passagem de turno", "passagens de turno", "turno*", "handover"] },
  { area: "dashboard", subarea: "Ponto e escala", terms: ["ponto", "picar", "escala*", "disponibilidade*", "folga*", "horario*"] },
  { area: "dashboard", subarea: "Tarefas", terms: ["tarefa*"] },
  // Multipark (a app de reservas)
  { area: "multipark", subarea: null, terms: ["app multipark", "aplicacao multipark", "multipark agente", "backoffice"] },
  { area: "multipark", subarea: "Próximas reservas", terms: ["proximas reservas", "reserv*", "chegada*", "partida*", "agenda"] },
  { area: "multipark", subarea: "Receber um carro", terms: ["receber", "rececao", "recolh*", "check in", "checkin", "entrada do carro"] },
  { area: "multipark", subarea: "Entregar um carro", terms: ["entreg*", "devolu*", "devolver", "check out", "checkout", "saida do carro"] },
  { area: "multipark", subarea: "Alterações e cancelamentos", terms: ["alterac*", "cancelament*", "cancelar"] },
  // Operacional (no parque e na estrada)
  { area: "operacional", subarea: null, terms: ["operac*", "operacional", "aeroporto", "terminal", "parque*"] },
  { area: "operacional", subarea: "Condução e manobras", terms: ["conduc*", "conduzir", "manobra*", "velocidade", "estacionar", "shuttle", "transfer*"] },
  { area: "operacional", subarea: "Chaves e viaturas", terms: ["chave*", "viatura*", "combustivel", "lavagem", "quilometr*"] },
  { area: "operacional", subarea: "Danos e ocorrências", terms: ["dano*", "risco*", "acidente*", "sinistro*", "vistoria*", "fotografi*", "ocorrenc*"] },
  { area: "operacional", subarea: "Segurança", terms: ["seguranca", "colete*", "emergenc*", "epi"] },
  // Comunicação
  { area: "comunicacao", subarea: null, terms: ["comunicac*"] },
  { area: "comunicacao", subarea: "Atendimento ao cliente", terms: ["atendimento", "clientes", "cliente", "simpatia", "telefone", "chamada*"] },
  { area: "comunicacao", subarea: "WhatsApp e email", terms: ["whatsapp", "email*", "e mail", "mensage*", "sms"] },
  { area: "comunicacao", subarea: "Rádio (Zello)", terms: ["zello", "radio"] },
  { area: "comunicacao", subarea: "Reclamações e críticas", terms: ["reclamac*", "critica*", "review*", "queixa*"] },
];

function termRegex(term: string): RegExp {
  const words = term.split(/\s+/).filter(Boolean).map((w) => (w.endsWith("*") ? `${w.slice(0, -1).replace(/[^a-z0-9]/g, "")}[a-z0-9]*` : w.replace(/[^a-z0-9]/g, "")));
  return new RegExp(`(?:^| )${words.join(" ")}(?= |$)`);
}

const COMPILED_RULES = AREA_RULES.map((r) => ({ ...r, res: r.terms.map(termRegex) }));

export interface AreaGuessInput {
  title: string | null | undefined;
  category?: string | null;
  /** Texto (só o início conta: 1500 caracteres). */
  content?: string | null;
}

export interface AreaGuess { area: TrainingAreaId | null; subarea: string | null; score: number }

/**
 * Área e subsecção propostas para um conteúdo. Título conta 3, categoria 2,
 * texto 1 (cada regra uma vez por campo). Abaixo de 2 pontos → sem área; só
 * com o texto (nada no título nem na categoria) são precisos 3. Empate entre
 * áreas: ganha a que tem mais no título/categoria. PURA.
 */
export function guessTrainingArea(input: AreaGuessInput): AreaGuess {
  const fields: Array<{ text: string; weight: number }> = [
    { text: searchText(input.title), weight: 3 },
    { text: searchText(input.category), weight: 2 },
    { text: searchText(String(input.content ?? "").slice(0, 1500)), weight: 1 },
  ];
  const areaScore = new Map<TrainingAreaId, number>();
  /** Pontos do título e da categoria (o texto sozinho só decide com 3+ regras). */
  const titleScore = new Map<TrainingAreaId, number>();
  const subScore = new Map<string, number>();
  for (const rule of COMPILED_RULES) {
    let s = 0;
    let t = 0;
    for (const f of fields) {
      if (!f.text) continue;
      if (rule.res.some((re) => re.test(f.text))) {
        s += f.weight;
        if (f.weight >= 2) t += f.weight;
      }
    }
    if (!s) continue;
    areaScore.set(rule.area, (areaScore.get(rule.area) ?? 0) + s);
    titleScore.set(rule.area, (titleScore.get(rule.area) ?? 0) + t);
    if (rule.subarea) subScore.set(`${rule.area}|${rule.subarea}`, (subScore.get(`${rule.area}|${rule.subarea}`) ?? 0) + s);
  }
  let best: TrainingAreaId | null = null;
  let bestScore = 0;
  for (const a of TRAINING_AREA_IDS) {
    const s = areaScore.get(a) ?? 0;
    if (s > bestScore || (s === bestScore && s > 0 && best && (titleScore.get(a) ?? 0) > (titleScore.get(best) ?? 0))) {
      best = a;
      bestScore = s;
    }
  }
  if (!best || bestScore < 2) return { area: null, subarea: null, score: bestScore };
  // Só com o texto (sem nada no título nem na categoria) é preciso mais certeza.
  if ((titleScore.get(best) ?? 0) === 0 && bestScore < 3) return { area: null, subarea: null, score: bestScore };
  let sub: string | null = null;
  let subBest = 0;
  for (const s of trainingAreaDef(best)!.subareas) {
    const v = subScore.get(`${best}|${s}`) ?? 0;
    if (v > subBest) { sub = s; subBest = v; }
  }
  return { area: best, subarea: sub, score: bestScore };
}

export interface EffectiveArea { area: TrainingAreaId | null; subarea: string | null; guessed: boolean }

/**
 * A área gravada ganha ("none" = sem área, de propósito); sem área gravada, a
 * proposta (marcada `guessed`). PURA.
 */
export function effectiveArea(row: { area?: string | null; subarea?: string | null; title: string; content?: string | null; description?: string | null }, categoryName?: string | null): EffectiveArea {
  if (isTrainingArea(row.area)) return { area: row.area, subarea: cleanSubarea(row.subarea), guessed: false };
  if (row.area === NO_AREA_ID) return { area: null, subarea: null, guessed: false };
  const g = guessTrainingArea({ title: row.title, category: categoryName ?? null, content: row.content ?? row.description ?? null });
  return { area: g.area, subarea: g.subarea, guessed: true };
}

// ─── Pesquisa por tema ──────────────────────────────────────────────────────

const STOP = new Set(
  (
    "a o as os um uma uns umas de do da dos das em no na nos nas num numa por pelo pela pelos pelas para pra com sem sob sobre " +
    "e ou mas que se ja nao mais menos muito eu tu ele ela me te lhe meu minha teu tua seu sua este esta isto isso esse essa " +
    "qual quais quando onde como porque quem ser sou es foi estar estou ter tenho tem fazer faco faz quero queres quer " +
    "aprender saber formacao formacoes curso cursos ver"
  ).split(/\s+/),
);

/** Sinónimos simples do dia a dia (procura "fechar a caixa" encontra "fecho de caixa"). */
const SYNONYMS: Record<string, readonly string[]> = {
  fechar: ["fecho"],
  fecho: ["fechar"],
  receber: ["rececao", "recolha", "recolher"],
  recolher: ["receber", "recolha"],
  entregar: ["entrega", "devolver", "devolucao"],
  devolver: ["entregar", "entrega"],
  zello: ["radio"],
  radio: ["zello"],
  queixa: ["reclamacao"],
  reclamacao: ["queixa", "reclamacoes"],
  dinheiro: ["caixa"],
  escala: ["horario", "turnos"],
  ponto: ["picar"],
};

/** Palavras de uma pergunta (sem acentos nem palavras vazias). PURA. */
export function searchTerms(q: string | null | undefined): string[] {
  const out: string[] = [];
  for (const w of matchWords(q)) {
    if (w.length < 3 && !/^\d+$/.test(w)) continue;
    if (STOP.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out.slice(0, 12);
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Duas palavras "são a mesma" para a pesquisa: iguais, com 5+ letras iniciais
 * em comum, ou 4 em comum sendo as duas curtas (≤ 6) — "fecho"/"fechar",
 * "caixa"/"caixas", mas não "entrada"/"entrega". PURA.
 */
export function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const p = commonPrefix(a, b);
  if (p >= 5) return true;
  return p >= 4 && a.length <= 6 && b.length <= 6;
}

export interface CatalogSearchItem {
  key: string;
  title: string;
  area?: string | null;
  subarea?: string | null;
  category?: string | null;
  typeLabel?: string | null;
  text?: string | null;
}

export interface CatalogHit<T> { item: T; score: number; coverage: number }

/**
 * Ordena o catálogo para uma pergunta. Cada palavra da pergunta vale pelo
 * melhor sítio onde aparece: título 3, área/subsecção 2,5, categoria 2,
 * tipo 1, texto 1. Fica o que tem pelo menos metade das palavras (ou uma, nas
 * perguntas de 1–2 palavras). PURA.
 */
export function searchCatalog<T extends CatalogSearchItem>(q: string, items: readonly T[], limit = 10): Array<CatalogHit<T>> {
  const terms = searchTerms(q);
  if (!terms.length) return [];
  const alts = terms.map((t) => [t, ...(SYNONYMS[t] ?? [])]);
  const hits: Array<CatalogHit<T>> = [];
  for (const item of items) {
    const areaLabel = isTrainingArea(item.area) ? TRAINING_AREA_LABELS[item.area] : "";
    const fields: Array<{ words: string[]; w: number }> = [
      { words: matchWords(item.title), w: 3 },
      { words: matchWords(`${areaLabel} ${item.subarea ?? ""}`), w: 2.5 },
      { words: matchWords(item.category), w: 2 },
      { words: matchWords(item.typeLabel), w: 1 },
      { words: matchWords(String(item.text ?? "").slice(0, 3000)), w: 1 },
    ];
    let score = 0;
    let matched = 0;
    for (const options of alts) {
      let best = 0;
      for (const f of fields) {
        if (f.w <= best) continue;
        if (f.words.some((w) => options.some((o) => wordsMatch(o, w)))) best = f.w;
      }
      if (best > 0) { matched++; score += best; }
    }
    if (!matched) continue;
    const coverage = matched / terms.length;
    const needed = terms.length <= 2 ? 1 / terms.length : 0.5;
    if (coverage + 1e-9 < needed) continue;
    hits.push({ item, score: Math.round((score / (3 * terms.length)) * 1000) / 1000, coverage: Math.round(coverage * 1000) / 1000 });
  }
  return hits.sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.item.title.localeCompare(b.item.title)).slice(0, Math.max(1, limit));
}
