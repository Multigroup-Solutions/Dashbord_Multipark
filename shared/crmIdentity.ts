/**
 * CRM — regras de identidade do cliente (Jorge, 27 set 2026; docs/crm/desenho-crm.md).
 *
 * PURO (sem BD): usado pela carga (server/crm/sync.ts), pelas sugestões de
 * fusão (server/crm/suggestions.ts) e pelo "quem é?".
 *
 * Regras do dono (Jorge, 3 out 2026 — lote 21c; substituem as de 27 set):
 *   - 1.ª vez → ficha nova, não se liga a ninguém.
 *   - MESMO NOME (o 1.º e o último nome iguais, sem contar acentos, pontos,
 *     traços, apóstrofos, asteriscos, números…: "António Gonçalves",
 *     "antonio_goncalves", "Antonio Gonçalves1") + UM dado igual — email,
 *     telefone ou matrícula (ou o NIF pessoal) → é a mesma pessoa.
 *   - NOME DIFERENTE: só com o mesmo email E o mesmo telefone ("se me atende
 *     o António quando ligo ou escrevo, é o António, mesmo que se chame Alice").
 *   - NUNCA sozinho: empresas, clientes Pro, emails genéricos de empresa
 *     (info@, admin@, geral@, reservas@…), email/telefone/matrícula que já
 *     está em mais de 2 fichas, e contribuintes pessoais diferentes (o NIF
 *     de empresa — faturação à empresa — não impede).
 *   - O resto são DÚVIDAS: vão à IA (interruptor próprio, desligado por
 *     omissão); se a IA não tiver a certeza, ficam em Rever fichas.
 *   - Nunca se junta só pelo nome; o email sozinho também não chega.
 */
import { normalizeEmail, isPlausibleEmail } from "./email";
import { normalizePhoneE164 } from "./phone";
import { DEFAULT_BRAND_DOMAINS, DEFAULT_MAIL_ALIAS_DOMAINS, MAIL_WORKSPACE_PRIMARY_DOMAIN } from "./mail";
import { matchWords } from "./textKey";

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
/**
 * Um email, telefone ou matrícula que está em MAIS fichas do que isto não
 * serve para ligar/juntar sozinho (família, empresa, balcão) — Jorge, 21c.
 */
export const MAX_AUTO_SHARED = 2;

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

/**
 * Tokens do nome: sem acentos, minúsculas, sem partículas, sem números
 * ("Gonçalves1" → "goncalves"); pontos, traços, "_", "*" e apóstrofos separam
 * ou desaparecem (shared/textKey.ts matchWords).
 */
export function nameTokens(raw: string | null | undefined): string[] {
  return matchWords(raw).map((t) => t.replace(/\d+/g, "")).filter((t) => t && !NAME_STOP.has(t));
}

/**
 * O MESMO NOME pela regra do dono: o 1.º e o último nome iguais (depois de
 * normalizar). Os nomes do meio não contam; nomes de uma palavra só e
 * iniciais ("M. Silva") NÃO chegam — são dúvida. PURA.
 */
export function sameFirstLast(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (ta.length < 2 || tb.length < 2) return false;
  if (ta[0].length < 2 || tb[0].length < 2) return false;
  return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
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

/**
 * Início de email de empresa/balcão (info@, admin@, geral@, reservas@…; também
 * "info.lisboa@", "reservas2@"). Não serve para ligar nem juntar pessoas —
 * mas continua a ser o email da empresa (não fica marcado como genérico). PURA.
 */
export const GENERIC_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "info", "informacao", "informacoes", "geral", "admin", "administracao", "administrativo", "adm",
  "reservas", "reserva", "booking", "bookings", "reservations", "reservation",
  "contact", "contacts", "contacto", "contactos", "contato", "contatos",
  "mail", "email", "office", "escritorio", "secretaria", "secretariado", "recepcao", "rececao", "reception", "frontdesk",
  "comercial", "sales", "vendas", "marketing", "financeiro", "finance", "faturacao", "facturacao", "billing", "invoices", "faturas",
  "contabilidade", "accounts", "accounting", "tesouraria", "compras", "purchasing", "encomendas", "orders", "pedidos",
  "rh", "hr", "recursos", "support", "suporte", "apoio", "help", "ajuda", "atendimento", "clientes", "customer", "customers", "service",
  "noreply", "donotreply", "postmaster", "webmaster", "hello", "ola", "team", "equipa", "staff",
  "operations", "operacoes", "logistica", "transportes", "travel", "viagens", "agencia", "agency",
  "direcao", "direccao", "gerencia", "management", "central", "main", "empresa", "company",
]);

export function isGenericLocalPart(email: string | null | undefined): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return false;
  const local = e.slice(0, at).split("+")[0];
  const first = local.split(/[._-]/)[0].replace(/\d+$/, "");
  return GENERIC_LOCAL_PARTS.has(first) || GENERIC_LOCAL_PARTS.has(local.replace(/[._-]/g, ""));
}

/** O email serve para ligar/juntar pessoas? (não é da casa, nem de balcão, nem de empresa). PURA. */
export function isPersonalEmail(email: string | null | undefined): boolean {
  const e = String(email ?? "");
  return !!e && !isHouseEmail(e) && !isGenericLocalPart(e);
}

// ─── Empresas e NIF ─────────────────────────────────────────────────────────

/** Nome de empresa? (para criar a ficha como empresa ou pessoa, e para nunca juntar sozinho). PURA. */
export function looksLikeCompany(name: string | null | undefined, taxName?: string | null): boolean {
  const s = `${name ?? ""} ${taxName ?? ""}`;
  return /\b(lda|l\.da|s\.\s?a\.?|sa|unipessoal|sociedade|ltd|limited|gmbh|sarl|s\.?l\.?|inc|corp|grupo|group|hotel|rent|car)\b/i.test(s);
}

/**
 * Nome de empresa para a identidade: como looksLikeCompany, mas sem "sa" e
 * "car" soltos ("Maria Sa" é a Maria Sá, não uma S.A.). PURA.
 */
function companyName(name: string | null | undefined): boolean {
  return /\b(lda|l\.da|s\.\s?a\.?|unipessoal|sociedade|ltd|limited|gmbh|sarl|s\.l\.?|inc|corp|grupo|group|hotel|rent)\b/i.test(String(name ?? ""));
}

/**
 * NIF de pessoa singular (começa por 1, 2 ou 3; 45 = não residente). Os outros
 * (5 sociedades, 6 Estado, 7x, 8, 9x) são de empresas/entidades: um NIF de
 * empresa diferente não impede juntar (é a faturação à empresa). PURA.
 */
export function isPersonalNif(raw: string | null | undefined): boolean {
  const n = nifKey(raw);
  return !!n && (/^[123]/.test(n) || n.startsWith("45"));
}

// ─── Decisão: ligar a uma ficha existente? ─────────────────────────────────

/** O que uma reserva diz sobre o cliente. */
export interface Observation {
  email: string;         // emailKey ("" se não houver)
  emailGeneric: boolean; // email não serve para ligar (genérico, da casa ou de empresa)
  phone: string;         // phoneKey
  plate: string;         // plateKey
  name: string;          // nome completo tal como veio
  nif?: string;          // nifKey ("" se não houver)
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
  isPro?: boolean;
  nif?: string | null;
}

/** "email+plate" e "phone+plate" ficam só nas ligações antigas (regras de 27 set). */
export type LinkRule = "email+phone" | "email+name" | "phone+name" | "plate+name" | "email+plate" | "phone+plate";

export interface LinkDecision {
  clientId: number | null;
  rule: LinkRule | null;
}

/** Identificadores demasiado partilhados (em mais de MAX_AUTO_SHARED fichas) — não ligam sozinhos. */
export interface SharedCounts {
  email?: number;
  phone?: number;
  plate?: number;
}

function matches(o: Observation, c: Candidate, shared: SharedCounts) {
  const ok = (n: number | undefined) => (n ?? 0) <= MAX_AUTO_SHARED;
  return {
    email: !!o.email && !o.emailGeneric && isPersonalEmail(o.email) && ok(shared.email) && c.emails.includes(o.email),
    phone: !!o.phone && ok(shared.phone) && c.phones.includes(o.phone),
    plate: !!o.plate && ok(shared.plate) && c.plates.includes(o.plate),
    name: !!o.name && c.names.some((n) => sameFirstLast(n, o.name)),
  };
}

/**
 * Escolhe a ficha a que a reserva liga sozinha, ou nenhuma (→ ficha nova; se
 * for a mesma pessoa, a sugestão aparece em Rever fichas e a junção resolve).
 * Mesmo nome + email/telefone/matrícula; nome diferente só com email E
 * telefone (e nunca a uma ficha Pro). NIFs pessoais diferentes nunca ligam.
 * Havendo várias, fica a que tem mais sinais iguais e, depois, a mais recente.
 */
export function decideLink(o: Observation, candidates: Candidate[], shared: SharedCounts = {}): LinkDecision {
  let best: { c: Candidate; rule: LinkRule; score: number } | null = null;
  for (const c of candidates) {
    if (o.nif && c.nif && o.nif !== nifKey(c.nif) && isPersonalNif(o.nif) && isPersonalNif(c.nif)) continue;
    const m = matches(o, c, shared);
    let rule: LinkRule | null = null;
    if (m.name && m.email) rule = "email+name";
    else if (m.name && m.phone) rule = "phone+name";
    else if (m.name && m.plate) rule = "plate+name";
    else if (m.email && m.phone && !c.isPro) rule = "email+phone";
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

// ─── Juntar sozinho (regras do dono, 3 out 2026 — lote 21c) ────────────────

/** Avisos que se mostram em Rever fichas (e que impedem ou baixam a confiança). */
export type IdentitySignal =
  | "nif_diff"       // contribuintes pessoais diferentes → nunca sozinho
  | "company"        // ficha de empresa ou nome de empresa → nunca sozinho
  | "pro"            // cliente Pro → nunca sozinho
  | "generic_email"  // o email em comum é genérico (info@, reservas@…) → não conta
  | "shared_email"   // o email em comum está em mais de 2 fichas → não conta
  | "shared_phone"   // o telefone em comum está em mais de 2 fichas → não conta
  | "shared_plate"   // a matrícula em comum está em mais de 2 fichas → não conta
  | "one_word_name"  // um dos nomes tem uma palavra só (ou só a inicial)
  | "name_diff";     // o 1.º e o último nome não batem certo

export const SIGNAL_LABELS: Record<IdentitySignal, string> = {
  nif_diff: "NIF diferente",
  company: "empresa",
  pro: "cliente Pro",
  generic_email: "email genérico",
  shared_email: "email em várias fichas",
  shared_phone: "telefone em várias fichas",
  shared_plate: "matrícula em várias fichas",
  one_word_name: "nome de uma palavra",
  name_diff: "nome diferente",
};

/** Sinais que impedem juntar sozinho (nem a regra, nem a IA): fica para uma pessoa. */
export const BLOCKING_SIGNALS: ReadonlySet<IdentitySignal> = new Set(["nif_diff", "company", "pro"]);

export interface IdentitySide extends SuggestionSide {
  kind?: string | null;
  isPro?: boolean;
}

export type IdentityRule = "nome+email" | "nome+telefone" | "nome+matrícula" | "nome+NIF" | "email+telefone";

export const IDENTITY_RULE_LABELS: Record<IdentityRule, string> = {
  "nome+email": "mesmo nome e mesmo email",
  "nome+telefone": "mesmo nome e mesmo telefone",
  "nome+matrícula": "mesmo nome e mesma matrícula",
  "nome+NIF": "mesmo nome e mesmo NIF",
  "email+telefone": "mesmo email e mesmo telefone",
};

export interface IdentityVerdict {
  /** same = junta sozinho · doubt = vai à IA (se ligada) e fica em Rever · block = só uma pessoa decide */
  verdict: "same" | "doubt" | "block";
  rule: IdentityRule | null;
  signals: IdentitySignal[];
  /** o que as duas fichas têm em comum e conta (sem valores — para a IA e para o registo) */
  facts: { sameName: boolean; email: boolean; phone: boolean; plate: boolean; nif: boolean };
}

/**
 * As duas fichas são a mesma pessoa pelas regras do dono? `fichasWith(tipo,
 * valor)` diz em quantas fichas ativas está cada email/telefone/matrícula
 * (sem a contagem, assume 2 — só estas duas). PURA.
 */
export function identityVerdict(a: IdentitySide, b: IdentitySide, fichasWith?: (kind: "email" | "phone" | "plate", value: string) => number): IdentityVerdict {
  const signals = new Set<IdentitySignal>();
  const count = (k: "email" | "phone" | "plate", v: string) => fichasWith?.(k, v) ?? 2;
  const common = (x: string[], y: string[]) => [...new Set(x.filter((v) => v && y.includes(v)))];

  if (a.kind === "company" || b.kind === "company" || companyName(a.name) || companyName(b.name)) signals.add("company");
  if (a.isPro || b.isPro) signals.add("pro");
  const na = nifKey(a.nif), nb = nifKey(b.nif);
  if (na && nb && na !== nb && isPersonalNif(na) && isPersonalNif(nb)) signals.add("nif_diff");
  const nif = !!na && na === nb && isPersonalNif(na);

  let email = false, phone = false, plate = false;
  for (const e of common(a.emails, b.emails)) {
    if (!isPersonalEmail(e)) signals.add("generic_email");
    else if (count("email", e) > MAX_AUTO_SHARED) signals.add("shared_email");
    else email = true;
  }
  for (const p of common(a.phones, b.phones)) {
    if (count("phone", p) > MAX_AUTO_SHARED) signals.add("shared_phone");
    else phone = true;
  }
  for (const p of common(a.plates, b.plates)) {
    if (count("plate", p) > MAX_AUTO_SHARED) signals.add("shared_plate");
    else plate = true;
  }

  const ta = nameTokens(a.name), tb = nameTokens(b.name);
  if ((ta.length && (ta.length < 2 || ta[0].length < 2)) || (tb.length && (tb.length < 2 || tb[0].length < 2))) signals.add("one_word_name");
  const sameName = sameFirstLast(a.name, b.name);
  if (!sameName) signals.add("name_diff");

  const facts = { sameName, email, phone, plate, nif };
  const list = [...signals];
  if (list.some((s) => BLOCKING_SIGNALS.has(s))) return { verdict: "block", rule: null, signals: list, facts };
  let rule: IdentityRule | null = null;
  if (sameName && email) rule = "nome+email";
  else if (sameName && phone) rule = "nome+telefone";
  else if (sameName && plate) rule = "nome+matrícula";
  else if (sameName && nif) rule = "nome+NIF";
  else if (!sameName && email && phone) rule = "email+telefone";
  return { verdict: rule ? "same" : "doubt", rule, signals: list, facts };
}

/** Compatibilidade: o par junta-se sozinho pelas regras do dono (identityVerdict). PURA. */
export function autoMergeOk(a: IdentitySide, b: IdentitySide, o: { kindA?: string | null; kindB?: string | null } = {}): boolean {
  return identityVerdict({ ...a, kind: a.kind ?? o.kindA }, { ...b, kind: b.kind ?? o.kindB }).verdict === "same";
}

// ─── Factos para a IA (21c) — sem contactos: só o 1.º nome e comparações ─────

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Erro de escrita provável ("goncalves" ~ "goncalvez"). PURA. */
export function typoClose(a: string, b: string): boolean {
  if (!a || !b || a === b) return a === b && !!a;
  const len = Math.min(a.length, b.length);
  return len >= 4 && lev(a, b) <= (len >= 7 ? 2 : 1);
}

export interface IdentityAiFacts {
  a: { firstName: string; words: number };
  b: { firstName: string; words: number };
  facts: string[];
}

/**
 * O que se diz à IA sobre um par: comparações (igual/parecido/diferente, em
 * quantas fichas), NUNCA os valores — nem emails, nem telefones, nem
 * matrículas, nem NIF, nem apelidos (docs/ia.md §5). PURA.
 */
export function identityFactsForAi(a: IdentitySide, b: IdentitySide, fichasWith?: (kind: "email" | "phone" | "plate", value: string) => number): IdentityAiFacts {
  const count = (k: "email" | "phone" | "plate", v: string) => fichasWith?.(k, v) ?? 2;
  const ta = nameTokens(a.name), tb = nameTokens(b.name);
  const facts: string[] = [];
  if (ta.length && tb.length) {
    const fa = ta[0], fb = tb[0];
    facts.push(fa === fb ? "1.º nome igual"
      : (fa.length === 1 && fb.startsWith(fa)) || (fb.length === 1 && fa.startsWith(fb)) ? "1.º nome: um é a inicial do outro"
      : typoClose(fa, fb) ? "1.º nome parecido (erro de escrita?)" : "1.º nome diferente");
    if (ta.length >= 2 && tb.length >= 2) {
      const la = ta[ta.length - 1], lb = tb[tb.length - 1];
      facts.push(la === lb ? "último nome igual" : typoClose(la, lb) ? "último nome parecido (erro de escrita?)" : "último nome diferente");
      if (la !== lb && (tb.slice(0, -1).includes(la) || ta.slice(0, -1).includes(lb))) facts.push("o último nome de uma ficha aparece no meio do nome da outra");
      const middle = ta.slice(1, -1).filter((t) => tb.includes(t)).length;
      if (middle) facts.push(`${middle} ${middle === 1 ? "nome do meio" : "nomes do meio"} em comum`);
    } else facts.push("uma das fichas tem só uma palavra no nome");
  } else facts.push("uma das fichas não tem nome");

  const common = (x: string[], y: string[]) => [...new Set(x.filter((v) => v && y.includes(v)))];
  const localHas = (email: string, t: string[]) => {
    const local = email.slice(0, email.lastIndexOf("@")).toLowerCase().replace(/[^a-z]/g, "");
    return t.filter((w) => w.length >= 3).some((w) => local.includes(w));
  };
  const ce = common(a.emails, b.emails);
  for (const e of ce) {
    const n = count("email", e);
    const kind = !isPersonalEmail(e) ? "genérico (de empresa/balcão)" : n > MAX_AUTO_SHARED ? `em ${n} fichas` : `só nestas ${n} fichas`;
    const whose = [localHas(e, ta) && "A", localHas(e, tb) && "B"].filter(Boolean);
    facts.push(`email igual, ${kind}${whose.length ? `; o email tem o nome da ficha ${whose.join(" e da ")}` : "; o email não tem o nome de nenhuma"}`);
  }
  if (!ce.length) facts.push(a.emails.length && b.emails.length ? "emails diferentes" : "uma das fichas não tem email");
  const cp = common(a.phones, b.phones);
  for (const p of cp) { const n = count("phone", p); facts.push(n > MAX_AUTO_SHARED ? `telefone igual, mas em ${n} fichas` : `telefone igual, só nestas ${n} fichas`); }
  if (!cp.length) facts.push(a.phones.length && b.phones.length ? "telefones diferentes" : "uma das fichas não tem telefone");
  const cv = common(a.plates, b.plates);
  for (const p of cv) { const n = count("plate", p); facts.push(n > MAX_AUTO_SHARED ? `matrícula igual, mas em ${n} fichas` : `matrícula igual, só nestas ${n} fichas`); }
  if (!cv.length && a.plates.length && b.plates.length) facts.push("matrículas diferentes");
  const na = nifKey(a.nif), nb = nifKey(b.nif);
  if (na && nb) facts.push(na === nb ? "NIF igual" : isPersonalNif(na) && isPersonalNif(nb) ? "NIF pessoais diferentes" : "NIF diferentes (um é de empresa)");
  return { a: { firstName: ta[0] ?? "", words: ta.length }, b: { firstName: tb[0] ?? "", words: tb.length }, facts };
}
