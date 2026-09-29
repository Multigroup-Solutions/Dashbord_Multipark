/**
 * Ficheiros exportados da Multipark (histórico lido só de leitura) que se
 * importam no dashboard. PURO — o browser lê o ficheiro e o servidor grava.
 *
 *  - Preços iniciais das reservas (`reservas.csv`): o preço com que cada
 *    reserva foi criada, tirado do History. A nossa cópia `multipark_bookings`
 *    foi escrita por cima durante meses; este passa a ser o "era" de origem
 *    na Correção de caixa.
 *  - Lista de agentes (`lista-agentes.csv`): nome, email e cidades de quem
 *    mexeu nos carros — para comparar com as fichas e ligar.
 */
import { matchKey } from "./textKey";

/** CSV com ";" e aspas (como o Excel português exporta). Tira o BOM. PURA. */
export function parseSemicolonCsv(text: string): string[][] {
  const s = String(text ?? "").replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ";") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** Linhas → objetos pelo cabeçalho (1.ª linha, em minúsculas). PURA. */
export function csvObjects(text: string): { header: string[]; rows: Record<string, string>[] } {
  const all = parseSemicolonCsv(text);
  if (!all.length) return { header: [], rows: [] };
  const header = all[0].map((h) => h.trim().toLowerCase());
  return { header, rows: all.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()]))) };
}

// ─── Preços iniciais ────────────────────────────────────────────────────────

export interface InitialPriceRow {
  bookingId: string;
  reference: string | null;
  parkId: string | null;
  parkName: string | null;
  city: string | null;
  createdAt: string | null;
  status: string | null;
  initialPrice: number | null;
  verification: string | null;
  source: string | null;
  historyId: string | null;
  priceAtExport: number | null;
  originalPriceField: number | null;
}

export const INITIAL_PRICE_REQUIRED = ["reserva_id", "booking_price_inicial", "verificacao"] as const;

const numOrNull = (v: string | undefined): number | null => {
  const t = String(v ?? "").trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) < 1e9 ? Math.round(n * 100) / 100 : null;
};
const strOrNull = (v: string | undefined, max = 255): string | null => {
  const t = String(v ?? "").trim();
  return t ? t.slice(0, max) : null;
};
/** "2026-04-30T23:03:59.815Z" → "2026-04-30 23:03:59" (UTC). PURA. */
export function isoToUtcStamp(v: string | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(String(v ?? "").trim());
  if (!m) return null;
  const y = Number(m[1].slice(0, 4));
  return y >= 1990 && y <= 2199 ? `${m[1]} ${m[2]}` : null;
}

/** `reservas.csv` → linhas válidas + erros (cabeçalho em falta, linhas sem id). PURA. */
export function parseInitialPricesCsv(text: string): { rows: InitialPriceRow[]; errors: string[] } {
  const { header, rows } = csvObjects(text);
  const missing = INITIAL_PRICE_REQUIRED.filter((h) => !header.includes(h));
  if (missing.length) return { rows: [], errors: [`Faltam colunas: ${missing.join(", ")}. É o ficheiro dos preços iniciais?`] };
  const out: InitialPriceRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const id = strOrNull(r.reserva_id, 64);
    if (!id) { errors.push(`Linha ${i + 2}: sem reserva_id.`); return; }
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      bookingId: id,
      reference: strOrNull(r.referencia, 32),
      parkId: strOrNull(r.parque_id, 64),
      parkName: strOrNull(r.parque, 128),
      city: strOrNull(r.cidade, 32),
      createdAt: isoToUtcStamp(r.criada_em_utc),
      status: strOrNull(r.estado_reserva, 32),
      initialPrice: numOrNull(r.booking_price_inicial),
      verification: strOrNull(r.verificacao, 32),
      source: strOrNull(r.fonte_preco_inicial, 64),
      historyId: strOrNull(r.historico_criacao_id, 64),
      priceAtExport: numOrNull(r.booking_price_atual),
      originalPriceField: numOrNull(r.original_booking_price_campo),
    });
  });
  return { rows: out, errors: errors.slice(0, 20) };
}

/**
 * Como a nossa cópia se compara com o preço inicial do histórico. PURA.
 *  - igual: a cópia tem o preço inicial;
 *  - reescrita: a cópia tem o preço de depois (o de agora), não o inicial;
 *  - diferente: nem um nem outro;
 *  - sem_copia: a reserva não está na nossa cópia;
 *  - sem_inicial: o histórico não tem o preço da criação.
 */
export type CopyVsInitial = "igual" | "reescrita" | "diferente" | "sem_copia" | "sem_inicial";

export function copyVsInitial(initial: number | null, atExport: number | null, copy: number | null | undefined): CopyVsInitial {
  if (initial == null) return "sem_inicial";
  if (copy == null) return "sem_copia";
  const same = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  if (same(copy, initial)) return "igual";
  if (atExport != null && same(copy, atExport)) return "reescrita";
  return "diferente";
}

// ─── Lista de agentes ───────────────────────────────────────────────────────

export interface AgentListRow {
  name: string;
  email: string | null;
  cities: string[];
  /** só na exportação xlsx ("Agentes"): */
  phone?: string | null;
  /** cargo principal na Multipark (Condutor, Supervisor, Parceiro…) */
  role?: string | null;
  /** Ativo / Inativo / Convite expirado… */
  state?: string | null;
  /** ID de utilizador da Multipark = id do agente */
  agentUserId?: string | null;
}

/** `lista-agentes.csv` (nome_agente;email;cidade) → linhas. PURA. */
export function parseAgentListCsv(text: string): { rows: AgentListRow[]; errors: string[] } {
  const { header, rows } = csvObjects(text);
  const nameCol = header.find((h) => h === "nome_agente" || h === "nome" || h === "agente");
  if (!nameCol) return { rows: [], errors: ["Falta a coluna nome_agente. É a lista de agentes?"] };
  const out: AgentListRow[] = [];
  for (const r of rows) {
    const name = String(r[nameCol] ?? "").replace(/\s+/g, " ").trim();
    if (!name) continue;
    const email = String(r.email ?? "").trim().toLowerCase();
    out.push({
      name: name.slice(0, 256),
      email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.slice(0, 320) : null,
      cities: String(r.cidade ?? r.cidades ?? "").split("|").map((c) => c.trim()).filter(Boolean),
    });
  }
  return { rows: out, errors: [] };
}

const CITY_OF: Record<string, string> = { lisboa: "Lisboa", lisbon: "Lisboa", porto: "Porto", faro: "Faro", algarve: "Faro" };

/**
 * Folha "Agentes" da exportação xlsx da Multipark (Nome, Email, Telefone,
 * Estado, Cargo principal, Parques ativos, ID utilizador…) → linhas. As
 * cidades saem dos parques ("Airpark - Faro, Skypark - Lisboa"). PURA.
 */
export function parseAgentSheetRows(rows: readonly Record<string, unknown>[]): { rows: AgentListRow[]; errors: string[] } {
  const first = rows[0] ?? {};
  const pick = (r: Record<string, unknown>, ...keys: string[]) => {
    for (const k of keys) { const v = r[k]; if (v != null && String(v).trim()) return String(v).replace(/\s+/g, " ").trim(); }
    return "";
  };
  if (!("Nome" in first) && !("ID utilizador" in first)) return { rows: [], errors: ["Não encontrei a folha \"Agentes\" (colunas Nome, Email, ID utilizador). É a exportação de agentes?"] };
  const out: AgentListRow[] = [];
  for (const r of rows) {
    const name = pick(r, "Nome");
    const id = pick(r, "ID utilizador");
    if (!name && !id) continue;
    const email = pick(r, "Email").toLowerCase();
    const parks = pick(r, "Parques ativos", "Parques inativos");
    const cities = [...new Set(parks.split(",").map((p) => CITY_OF[(p.split(/[-–]/).pop() ?? "").trim().toLowerCase()]).filter((c): c is string => !!c))];
    out.push({
      name: (name || id).slice(0, 256),
      email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.slice(0, 320) : null,
      cities,
      phone: pick(r, "Telefone").slice(0, 32) || null,
      role: pick(r, "Cargo principal", "Cargo").slice(0, 64) || null,
      state: pick(r, "Estado").slice(0, 32) || null,
      agentUserId: id.slice(0, 64) || null,
    });
  }
  return { rows: out, errors: [] };
}

/** Chave de telefone: os últimos 9 dígitos (ignora +351, espaços, 00…). PURA. */
export function phoneKey(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : "";
}

/** Estado na Multipark que não é ativo (inativo, convite expirado/pendente). PURA. */
export function isInactiveAgentState(state: string | null | undefined): boolean {
  const s = String(state ?? "").trim().toLowerCase();
  return !!s && s !== "ativo";
}

export type AgentListKind = "pessoa" | "agencia" | "teste" | "casa";

const AGENCY_RE = /\b(viage(m|ns)|travel|tour(s|ismo)?|ag[eê]ncia|bestravel|lealtours|discover|total fun|click|caravelatur|destiny|definir datas|\w*park(ing)?|parque|valet|lda|unipessoal|geral|reservas|admin)\b/i;
const TEST_RE = /\b(teste?|test|demo)\b/i;
const HOUSE_DOMAINS = ["multipark.pt", "airpark.pt", "multigroup.pt"];

/** Pessoa, agência/parceiro, conta de teste ou conta da casa. PURA. */
export function agentListKind(row: AgentListRow): AgentListKind {
  if (TEST_RE.test(row.name)) return "teste";
  if (row.role && /parceir|ag[eê]ncia/i.test(row.role)) return "agencia";
  const domain = row.email?.split("@")[1] ?? "";
  if (/^(geral|reservas|info|checkinpark|iziparkporto)@/.test(row.email ?? "") || AGENCY_RE.test(row.name)) return "agencia";
  if (HOUSE_DOMAINS.includes(domain)) return "casa";
  return "pessoa";
}

/** Chave de nome sem a cidade colada ("Bruno Meireles - PORTO" → "brunomeireles"). PURA. */
export function agentNameKey(name: string): string {
  return matchKey(String(name ?? "").replace(/\s*[-–(]\s*(porto|lisboa|faro)\)?\s*$/i, "").replace(/\d+$/, ""));
}
