/**
 * Política de dados pessoais para a IA: antes de mandar texto livre ao
 * fornecedor, troca emails, telefones, IBAN, NIF e matrículas por marcadores
 * ([EMAIL_1], [TELEFONE_1], [IBAN_1], [NIF_1], [MATRICULA_1]). Quando a
 * resposta precisa dos valores (ex.: resumo da passagem de turno com a
 * matrícula de um carro), `restore()` repõe-nos DEPOIS de a resposta chegar —
 * o fornecedor nunca os vê. Nomes: só o primeiro nome (`firstName`); no chat,
 * os nomes de colaboradores dos resultados das ferramentas vão como [NOME_n]
 * e são repostos no fim (`createRedactionContext`).
 *
 * Tudo PURO (sem I/O).
 */

export type PiiKind = "email" | "iban" | "phone" | "nif" | "plate";

const LABEL: Record<PiiKind, string> = { email: "EMAIL", iban: "IBAN", phone: "TELEFONE", nif: "NIF", plate: "MATRICULA" };

export interface Redaction {
  /** Texto seguro para enviar. */
  text: string;
  /** Repõe os valores originais nos marcadores de uma resposta. */
  restore(output: string): string;
  /** Tira os marcadores (para textos públicos, ex.: resposta a uma crítica). */
  strip(output: string): string;
  counts: Record<PiiKind, number>;
}

/** NIF português: 9 dígitos com dígito de controlo válido. */
export function isValidNif(d: string): boolean {
  if (!/^\d{9}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(d[i]) * (9 - i);
  const check = 11 - (sum % 11);
  return (check >= 10 ? 0 : check) === Number(d[8]);
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// IBAN: 2 letras + 2 dígitos + 11 a 30 alfanuméricos, com ou sem espaços em grupos de 4.
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
// NIF com a palavra à frente ("NIF 123456789", "contribuinte: 123 456 789").
const NIF_LABELLED = /\b(NIF|NIPC|contribuinte)(\s*(?:n\.?º|n\.?o|nº)?\s*[:.]?\s*)(\d{3}\s?\d{3}\s?\d{3})\b/gi;
// Telefones internacionais (+351 912 345 678 / 00351…) e nacionais (9 dígitos começados por 2 ou 9).
const PHONE_INTL = /(?:\+|\b00)\d{1,3}[\s.-]?(?:\d[\s.-]?){6,12}\d\b/g;
const NINE_DIGITS = /\b\d{3}[\s.-]?\d{3}[\s.-]?\d{3}\b/g;
// Matrículas PT (AA-00-00, 00-AA-00, 00-00-AA, AA-00-AA): com hífen ou juntas; com espaços só em maiúsculas.
const PLATE_DASH = /\b(?:[A-Z]{2}-?\d{2}-?\d{2}|\d{2}-?[A-Z]{2}-?\d{2}|\d{2}-?\d{2}-?[A-Z]{2}|[A-Z]{2}-?\d{2}-?[A-Z]{2})\b/gi;
const PLATE_SPACE = /\b(?:[A-Z]{2} \d{2} \d{2}|\d{2} [A-Z]{2} \d{2}|\d{2} \d{2} [A-Z]{2}|[A-Z]{2} \d{2} [A-Z]{2})\b/g;

interface RedactState {
  counts: Record<PiiKind, number>;
  names: number;
  byValue: Map<string, string>;
  byToken: Map<string, string>;
}

const newState = (): RedactState => ({ counts: { email: 0, iban: 0, phone: 0, nif: 0, plate: 0 }, names: 0, byValue: new Map(), byToken: new Map() });

/** Troca os dados pessoais de um texto por marcadores, com a numeração de `st`. PURA (muda só `st`). */
function redactInto(st: RedactState, input: string | null | undefined, kinds: Set<PiiKind>): string {
  const token = (kind: PiiKind, value: string): string => {
    const key = `${kind}:${value.replace(/[\s.-]/g, "").toUpperCase()}`;
    const existing = st.byValue.get(key);
    if (existing) return existing;
    st.counts[kind] += 1;
    const t = `[${LABEL[kind]}_${st.counts[kind]}]`;
    st.byValue.set(key, t);
    st.byToken.set(t, value);
    return t;
  };

  let text = String(input ?? "");
  // Ordem importa: emails (têm dígitos), IBAN (longo), NIF com etiqueta, telefones, 9 dígitos soltos, matrículas.
  if (kinds.has("email")) text = text.replace(EMAIL, (m) => token("email", m));
  if (kinds.has("iban")) {
    text = text.replace(IBAN, (m) => {
      const compact = m.replace(/\s/g, "");
      return compact.length >= 15 && compact.length <= 34 ? token("iban", m) : m;
    });
  }
  if (kinds.has("nif")) text = text.replace(NIF_LABELLED, (_m, label, sep, num) => `${label}${sep}${token("nif", num)}`);
  if (kinds.has("phone")) text = text.replace(PHONE_INTL, (m) => token("phone", m));
  if (kinds.has("phone") || kinds.has("nif")) {
    text = text.replace(NINE_DIGITS, (m) => {
      const d = m.replace(/[\s.-]/g, "");
      // 9xx/2xx = telemóvel/fixo; senão, NIF válido = NIF; senão fica.
      if (/^[29]/.test(d) && kinds.has("phone")) return token("phone", m);
      if (isValidNif(d) && kinds.has("nif")) return token("nif", m);
      return m;
    });
  }
  if (kinds.has("plate")) {
    const plate = (m: string) => (/\d/.test(m) && /[A-Z]/i.test(m) ? token("plate", m) : m);
    text = text.replace(PLATE_DASH, plate).replace(PLATE_SPACE, plate);
  }
  return text;
}

const MARK = /\[(EMAIL|IBAN|TELEFONE|NIF|MATRICULA|NOME)_\d+\]/g;
const restoreWith = (st: RedactState) => (out: string) => String(out ?? "").replace(MARK, (t) => st.byToken.get(t) ?? t);
const stripMarks = (out: string) => String(out ?? "").replace(MARK, "").replace(/[ \t]{2,}/g, " ").replace(/ +([,.;:!?])/g, "$1").trim();
const ALL_KINDS: readonly PiiKind[] = ["email", "iban", "phone", "nif", "plate"];

export function redactPii(input: string | null | undefined, opts: { kinds?: readonly PiiKind[] } = {}): Redaction {
  const st = newState();
  const text = redactInto(st, input, new Set<PiiKind>(opts.kinds ?? ALL_KINDS));
  return { text, counts: st.counts, restore: restoreWith(st), strip: stripMarks };
}

/**
 * UM contexto de redação por turno do chat (plano MPV §3.7, F0b): a pergunta,
 * o histórico, o conhecimento e os RESULTADOS DAS FERRAMENTAS passam todos por
 * aqui, com numeração CONTÍNUA dos marcadores (o email da pergunta é o
 * [EMAIL_1], o de uma ferramenta o [EMAIL_2]) e o restauro faz-se UMA vez, no
 * fim, com tudo.
 *  - `text()`: texto livre → emails, telefones, IBAN, NIF, matrículas;
 *  - `person()`: nome COMPLETO de um colaborador → [NOME_n], reposto no fim
 *    (a pessoa vê o nome completo; o fornecedor não) — dois "João" diferentes
 *    têm marcadores diferentes;
 *  - clientes/avaliadores: `firstName` (não se repõe).
 * PURO.
 */
export interface RedactionContext {
  text(input: string | null | undefined): string;
  person(fullName: string | null | undefined): string | null;
  restore(output: string): string;
  strip(output: string): string;
  readonly counts: Readonly<Record<PiiKind, number>>;
  /** Quantos nomes de colaboradores foram tapados. */
  readonly names: number;
  /**
   * Para GUARDAR a resposta (auditoria A1): repõe tudo MENOS os nomes dos
   * colegas, e devolve o mapa dos [NOME_n] que lá ficaram — assim o histórico
   * do turno seguinte não leva os nomes completos ao fornecedor.
   */
  maskForStorage(output: string): { content: string; names: Record<string, string> };
  /**
   * Histórico: um texto guardado com marcadores de OUTRO turno → os nomes
   * passam a marcadores DESTE contexto (repostos no fim, como os outros).
   * Marcador sem nome no mapa → tirado.
   */
  adoptNames(text: string, names: Record<string, string> | null | undefined): string;
}

export function createRedactionContext(opts: { kinds?: readonly PiiKind[] } = {}): RedactionContext {
  const st = newState();
  const kinds = new Set<PiiKind>(opts.kinds ?? ALL_KINDS);
  const self: RedactionContext = {
    text: (input) => redactInto(st, input, kinds),
    person: (fullName) => {
      const name = String(fullName ?? "").replace(/\s+/g, " ").trim();
      if (!name) return null;
      const key = `name:${name.toLowerCase()}`;
      const existing = st.byValue.get(key);
      if (existing) return existing;
      st.names += 1;
      const t = `[NOME_${st.names}]`;
      st.byValue.set(key, t);
      st.byToken.set(t, name);
      return t;
    },
    restore: restoreWith(st),
    strip: stripMarks,
    get counts() { return st.counts; },
    get names() { return st.names; },
    maskForStorage(output) {
      const names: Record<string, string> = {};
      const content = String(output ?? "").replace(MARK, (t) => {
        if (t.startsWith("[NOME_")) {
          const v = st.byToken.get(t);
          if (v) names[t] = v;
          return t;
        }
        return st.byToken.get(t) ?? t;
      });
      return { content, names };
    },
    adoptNames(text, names) {
      return String(text ?? "").replace(/\[NOME_\d+\]/g, (t) => {
        const full = names?.[t];
        return full ? (self.person(full) ?? "") : "";
      });
    },
  };
  return self;
}

/** Só o primeiro nome ("Maria João Silva" → "Maria"); vazio → fallback. PURA. */
export function firstName(full: string | null | undefined, fallback = "Cliente"): string {
  const t = String(full ?? "").trim().split(/\s+/)[0] ?? "";
  // Nomes com email/telefone (acontece em importações) não passam.
  const clean = t.replace(/[^\p{L}'-]/gu, "");
  if (!clean || clean.length < 2) return fallback;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}
