/**
 * CRM — regras de identidade do cliente (Jorge, 27 set 2026; docs/crm/desenho-crm.md).
 *
 * PURO (sem BD): usado pela carga (server/crm/sync.ts), pelas sugestões de
 * fusão (server/crm/suggestions.ts) e pelo "quem é?".
 *
 * Regras acordadas:
 *   - 1.ª vez → ficha nova, não se liga a ninguém.
 *   - Liga SOZINHO a uma ficha que já existe quando coincidem:
 *       email + telefone, email + nome, ou email + matrícula.
 *     O email sozinho NÃO chega. Nunca se junta só pelo nome.
 *   - Sem email utilizável (reserva sem email, ou email genérico/de
 *     agregador): liga sozinho com telefone + nome ou telefone + matrícula
 *     (PRESSUPOSTO a confirmar pelo Jorge — `NO_EMAIL_AUTO_LINK`).
 *   - Tudo o resto é SUGESTÃO que alguém confirma (telefone, NIF, matrícula,
 *     nome parecido…), com pontuação e motivos à vista.
 *   - Emails genéricos (balcão, agregadores, domínios da casa) ficam marcados
 *     e não servem para ligar pessoas.
 */
import { normalizeEmail, isPlausibleEmail } from "./email";
import { normalizePhoneE164 } from "./phone";
import { DEFAULT_BRAND_DOMAINS, DEFAULT_MAIL_ALIAS_DOMAINS, MAIL_WORKSPACE_PRIMARY_DOMAIN } from "./mail";

/**
 * Domínios da casa: staff e contas de teste, nunca são clientes. LISTA ÚNICA
 * (CRM, Marketing, Reclamações…): os domínios das marcas e do Workspace da
 * Comunicação (shared/mail.ts) + o do grupo. Um domínio novo das marcas
 * entra lá e vale para todos.
 */
export const INTERNAL_EMAIL_DOMAINS: readonly string[] = Array.from(new Set(
  [MAIL_WORKSPACE_PRIMARY_DOMAIN, ...Object.values(DEFAULT_BRAND_DOMAINS).flat(), ...DEFAULT_MAIL_ALIAS_DOMAINS, "multigroup.pt"]
    .map((d) => d.trim().toLowerCase()).filter(Boolean),
));

/** Email de um domínio da casa (ou subdomínio dele, ex.: x@lisboa.multipark.pt). PURA. */
export function isHouseEmail(email: string | null | undefined): boolean {
  const d = emailDomain(String(email ?? "").trim().toLowerCase());
  return !!d && INTERNAL_EMAIL_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`));
}
/** Um email usado por tantos nomes diferentes é de balcão/agregador, não de uma pessoa. */
export const GENERIC_EMAIL_MIN_NAMES = 5;
/** Sem email: telefone + (nome | matrícula) liga sozinho. Desligar = só sugestões. */
export const NO_EMAIL_AUTO_LINK = true;

// ─── Normalização ───────────────────────────────────────────────────────────

/** Email na forma canónica, ou "" se não parecer um email. */
export function emailKey(raw: string | null | undefined): string {
  const e = normalizeEmail(raw);
  return isPlausibleEmail(e) ? e : "";
}

export function emailDomain(e: string): string {
  const i = e.lastIndexOf("@");
  return i >= 0 ? e.slice(i + 1) : "";
}

/** Telefone em E.164 ("" se não se conseguir). */
export function phoneKey(raw: string | null | undefined): string {
  return typeof raw === "string" ? normalizePhoneE164(raw) ?? "" : "";
}

/** Matrícula sem espaços/pontos/traços, em maiúsculas ("" se curta demais). */
export function plateKey(raw: string | null | undefined): string {
  const p = String(raw ?? "").replace(/[\s.\-_/]/g, "").toUpperCase();
  return p.length >= 4 ? p : "";
}

/** NIF só com dígitos (9), ou "". */
export function nifKey(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length === 9 && !/^0+$/.test(d) ? d : "";
}

/** Palavras de ligação que não contam para comparar nomes. */
const NAME_STOP = new Set(["de", "da", "do", "das", "dos", "e", "del", "la", "van", "von", "di"]);

/** Tokens do nome: sem acentos, minúsculas, sem partículas. */
export function nameTokens(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z\s'-]/g, " ")
    .split(/[\s'-]+/).filter((t) => t.length > 0 && !NAME_STOP.has(t));
}

/** Chave do nome para comparações rápidas: 1.º e último token. */
export function nameKey(raw: string | null | undefined): string {
  const t = nameTokens(raw);
  if (!t.length) return "";
  return t.length === 1 ? t[0] : `${t[0]} ${t[t.length - 1]}`;
}

/**
 * Nomes compatíveis (a mesma pessoa escrita de outra forma):
 * mesmo 1.º nome e mesmo apelido final, ou um contém todos os tokens do outro
 * (≥ 2 tokens), ou iniciais compatíveis ("M. Silva" ~ "Marta Silva").
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.length === 1 || tb.length === 1) return ta.length === tb.length && ta[0] === tb[0];
  const firstA = ta[0], firstB = tb[0], lastA = ta[ta.length - 1], lastB = tb[tb.length - 1];
  if (lastA !== lastB) return false;
  if (firstA === firstB) return true;
  // inicial: "m" ~ "marta"
  if ((firstA.length === 1 && firstB.startsWith(firstA)) || (firstB.length === 1 && firstA.startsWith(firstB))) return true;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.length >= 2 && small.every((t) => big.includes(t));
}

/** 0–1: quão parecidos são dois nomes (para a pontuação das sugestões). */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  if (namesMatch(a, b)) return 1;
  const setB = new Set(tb);
  const common = ta.filter((t) => setB.has(t)).length;
  return common / Math.max(ta.length, tb.length);
}

// ─── Emails genéricos ───────────────────────────────────────────────────────

export interface EmailUsage {
  /** nomes diferentes (nameKey) vistos com este email */
  distinctNames: number;
}

/** Email que não identifica uma pessoa (domínio da casa ou usado por muitos nomes). */
export function isGenericEmail(email: string, usage?: EmailUsage | null): boolean {
  if (!email) return true;
  if (isHouseEmail(email)) return true;
  return (usage?.distinctNames ?? 0) >= GENERIC_EMAIL_MIN_NAMES;
}

// ─── Decisão: ligar a uma ficha existente? ─────────────────────────────────

/** O que uma reserva diz sobre o cliente. */
export interface Observation {
  email: string;         // emailKey ("" se não houver)
  emailGeneric: boolean; // email não serve para ligar
  phone: string;         // phoneKey
  plate: string;         // plateKey
  name: string;          // nome completo tal como veio
}

/** Uma ficha candidata, com os identificadores que já tem. */
export interface Candidate {
  id: number;
  names: string[];
  emails: string[];
  phones: string[];
  plates: string[];
  /** última vez que apareceu (para desempatar) */
  lastSeen?: string | null;
}

export type LinkRule = "email+phone" | "email+name" | "email+plate" | "phone+name" | "phone+plate";

export interface LinkDecision {
  clientId: number | null;
  rule: LinkRule | null;
}

function matches(o: Observation, c: Candidate) {
  return {
    email: !!o.email && !o.emailGeneric && c.emails.includes(o.email),
    phone: !!o.phone && c.phones.includes(o.phone),
    plate: !!o.plate && c.plates.includes(o.plate),
    name: !!o.name && c.names.some((n) => namesMatch(n, o.name)),
  };
}

/**
 * Escolhe a ficha a que a reserva liga sozinha, ou nenhuma (→ ficha nova).
 * Havendo várias, fica a que tem mais sinais iguais e, depois, a mais recente.
 */
export function decideLink(o: Observation, candidates: Candidate[]): LinkDecision {
  let best: { c: Candidate; rule: LinkRule; score: number } | null = null;
  for (const c of candidates) {
    const m = matches(o, c);
    let rule: LinkRule | null = null;
    if (m.email && m.phone) rule = "email+phone";
    else if (m.email && m.name) rule = "email+name";
    else if (m.email && m.plate) rule = "email+plate";
    else if (NO_EMAIL_AUTO_LINK && (!o.email || o.emailGeneric) && m.phone && m.name) rule = "phone+name";
    else if (NO_EMAIL_AUTO_LINK && (!o.email || o.emailGeneric) && m.phone && m.plate) rule = "phone+plate";
    if (!rule) continue;
    const score = [m.email, m.phone, m.plate, m.name].filter(Boolean).length;
    if (!best || score > best.score || (score === best.score && String(c.lastSeen ?? "") > String(best.c.lastSeen ?? ""))) {
      best = { c, rule, score };
    }
  }
  return best ? { clientId: best.c.id, rule: best.rule } : { clientId: null, rule: null };
}

// ─── Sugestões de fusão ────────────────────────────────────────────────────

export type SuggestionReason = "same_email" | "same_phone" | "same_plate" | "same_nif" | "similar_name";

export interface SuggestionSide {
  id: number;
  name: string | null;
  emails: string[];
  phones: string[];
  plates: string[];
  nif: string | null;
}

export const REASON_POINTS: Record<SuggestionReason, number> = {
  same_nif: 45,
  same_phone: 40,
  same_plate: 35,
  same_email: 30,
  similar_name: 25,
};

/**
 * Pontuação 0–100 e motivos para "estas duas fichas são a mesma pessoa?".
 * Só o nome parecido nunca chega a sugestão (devolve null).
 */
export function scoreSuggestion(a: SuggestionSide, b: SuggestionSide): { score: number; reasons: SuggestionReason[] } | null {
  const reasons: SuggestionReason[] = [];
  const inter = (x: string[], y: string[]) => x.some((v) => v && y.includes(v));
  if (a.nif && b.nif && a.nif === b.nif) reasons.push("same_nif");
  if (inter(a.phones, b.phones)) reasons.push("same_phone");
  if (inter(a.plates, b.plates)) reasons.push("same_plate");
  if (inter(a.emails, b.emails)) reasons.push("same_email");
  const sim = nameSimilarity(a.name, b.name);
  if (sim >= 0.66) reasons.push("similar_name");
  if (!reasons.length || (reasons.length === 1 && reasons[0] === "similar_name")) return null;
  const raw = reasons.reduce((s, r) => s + REASON_POINTS[r], 0);
  // nome diferente (sem nada em comum) baixa a confiança: pode ser família/empresa
  const penalty = a.name && b.name && sim === 0 ? 20 : 0;
  return { score: Math.max(1, Math.min(99, raw - penalty)), reasons };
}

export const REASON_LABELS: Record<SuggestionReason, string> = {
  same_email: "mesmo email",
  same_phone: "mesmo telefone",
  same_plate: "mesma matrícula",
  same_nif: "mesmo NIF",
  similar_name: "nome parecido",
};
