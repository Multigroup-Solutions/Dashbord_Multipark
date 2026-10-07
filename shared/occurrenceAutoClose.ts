/**
 * Ocorrências que fecham sozinhas (44c, Jorge 7 out 2026: "uma ocorrência
 * média que não tenha a ver com valores nem com reclamações é fechada no final
 * de 3 dias automaticamente… para não ficar isto tudo aqui").
 *
 * A BD da Multipark é só de leitura: lá a ocorrência continua por resolver.
 * Cá é uma marca nossa, CALCULADA na leitura (nada se escreve): média (ou sem
 * prioridade, que a Multipark grava como média), por resolver, com 3 dias ou
 * mais e sem palavras de dinheiro, danos ou reclamação no tipo nem nas notas.
 * Se a resolverem na app, passa a "Resolvida" como sempre.
 *
 * As palavras são texto simples (sem caracteres especiais de expressão
 * regular): o mesmo padrão serve ao Postgres (`~*`) e ao JS (`/i`). Na dúvida,
 * fica aberta (uma palavra a mais só deixa a ocorrência aberta).
 */

export const OCCURRENCE_AUTO_CLOSE_DAYS = 3;

/** Dinheiro, danos/acidentes e reclamações — estas nunca fecham sozinhas. */
export const OCCURRENCE_KEEP_OPEN_WORDS: readonly string[] = [
  // dinheiro ("valores")
  "valor", "dinheiro", "pagament", "pagou", "pagar", "cobr", "reembols", "devolu", "fatur", "recibo",
  "multibanco", "mbway", "mb way", "troco", "€", "euro", "preço", "preco", "tarifa", "seguro",
  // danos e acidentes (custam dinheiro; o acidente ainda tem a confirmação do TL)
  "acidente", "sinistro", "colis", "colidiu", "embat", "bateu", "choque", "capot", "amolgad",
  "risco", "riscad", "dano", "danific", "partido", "partiu", "furt", "roub",
  // reclamações
  "reclama", "queixa", "livro amarelo",
];

/** Padrão único (alternativa simples) para `~*` no Postgres e RegExp no JS. */
export const OCCURRENCE_KEEP_OPEN_PATTERN = OCCURRENCE_KEEP_OPEN_WORDS.join("|");

const KEEP_OPEN_RE = new RegExp(OCCURRENCE_KEEP_OPEN_PATTERN, "i");

/** Tem a ver com dinheiro, danos ou reclamações (tipo ou notas)? PURA. */
export function occurrenceKeepsOpen(o: { title?: string | null; remarks?: string | null }): boolean {
  return KEEP_OPEN_RE.test(`${o.title ?? ""} ${o.remarks ?? ""}`);
}

/** Instante UTC "AAAA-MM-DD HH:MM:SS" antes do qual a ocorrência já tem 3 dias. PURA. */
export function occurrenceAutoCloseCutoff(nowMs: number): string {
  return new Date(nowMs - OCCURRENCE_AUTO_CLOSE_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

export interface AutoCloseLike {
  resolved: boolean;
  priority: string | null;
  /** ISO UTC (como vem de mapOccurrenceRow). */
  createdAt: string | null;
  title?: string | null;
  remarks?: string | null;
}

/** Fechada sozinha (cá)? Mesma regra do SQL (buildOccurrenceWhere). PURA. */
export function isOccurrenceAutoClosed(o: AutoCloseLike, nowMs: number): boolean {
  if (o.resolved) return false;
  if ((o.priority ?? "MEDIUM").toUpperCase() !== "MEDIUM") return false;
  const t = o.createdAt ? Date.parse(o.createdAt) : NaN;
  if (!Number.isFinite(t) || t >= nowMs - OCCURRENCE_AUTO_CLOSE_DAYS * 86_400_000) return false;
  return !occurrenceKeepsOpen(o);
}

/** Quando fechou (cá): criada + 3 dias. ISO UTC ou null. PURA. */
export function occurrenceAutoClosedAt(createdAt: string | null): string | null {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) ? new Date(t + OCCURRENCE_AUTO_CLOSE_DAYS * 86_400_000).toISOString() : null;
}
