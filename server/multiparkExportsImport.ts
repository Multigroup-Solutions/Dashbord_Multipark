/**
 * Importar os ficheiros exportados da Multipark (regras em
 * shared/multiparkExports.ts):
 *  - preços iniciais das reservas → `booking_initial_prices` (o "era" de
 *    origem da Correção de caixa) + relatório contra a nossa cópia;
 *  - lista de agentes → comparação com as fichas (quem está ligado, a quem
 *    ligar pelo email ou pelo nome). Não grava nada: ligar é um clique.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { agentListKind, agentNameKey, copyVsInitial, isInactiveAgentState, phoneKey, type AgentListKind, type AgentListRow, type CopyVsInitial, type InitialPriceRow } from "../shared/multiparkExports";
import { matchKey } from "../shared/textKey";
import { isSystemAgentId } from "../shared/agentIdentity";
import { suggestForAgents, type PartnershipForSuggest } from "./agentSuggestions";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// ─── Preços iniciais ────────────────────────────────────────────────────────

export const INITIAL_PRICES_BATCH = 1000;

/** Grava um lote (≤ 1000). Uma nova importação atualiza; nunca apaga. */
export async function importInitialPrices(rows: readonly InitialPriceRow[], userId: number): Promise<{ saved: number }> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível.");
  const list = rows.slice(0, INITIAL_PRICES_BATCH);
  if (!list.length) return { saved: 0 };
  await db.execute(sql`
    INSERT INTO booking_initial_prices (bookingExternalId, reference, parkId, parkName, city, bookingCreatedAt, statusAtExport,
      initialPrice, verification, source, historyId, priceAtExport, originalPriceField, importedAt, importedById)
    VALUES ${sql.join(list.map((r) => sql`(${r.bookingId}, ${r.reference}, ${r.parkId}, ${r.parkName}, ${r.city}, ${r.createdAt}, ${r.status},
      ${r.initialPrice}, ${r.verification}, ${r.source}, ${r.historyId}, ${r.priceAtExport}, ${r.originalPriceField}, UTC_TIMESTAMP(), ${userId})`), sql`, `)}
    ON DUPLICATE KEY UPDATE
      reference = VALUES(reference), parkId = VALUES(parkId), parkName = VALUES(parkName), city = VALUES(city),
      bookingCreatedAt = VALUES(bookingCreatedAt), statusAtExport = VALUES(statusAtExport),
      initialPrice = COALESCE(VALUES(initialPrice), initialPrice), verification = VALUES(verification), source = VALUES(source),
      historyId = VALUES(historyId), priceAtExport = VALUES(priceAtExport), originalPriceField = VALUES(originalPriceField),
      importedAt = VALUES(importedAt), importedById = VALUES(importedById)`);
  return { saved: list.length };
}

export interface InitialPricesReport {
  total: number;
  counts: Record<CopyVsInitial, number>;
  changedSinceCreation: number;
  firstCreated: string | null;
  lastCreated: string | null;
  lastImportAt: string | null;
  /** as maiores diferenças entre a cópia e o preço inicial (não "reescrita") */
  samples: { bookingId: string; reference: string | null; parkName: string | null; createdAt: string | null; initial: number | null; atExport: number | null; copy: number | null; kind: CopyVsInitial }[];
}

/** Compara o que foi importado com a nossa cópia (`multipark_bookings`). Só leitura. */
export async function initialPricesReport(): Promise<InitialPricesReport> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível.");
  const rows = rowsOf(await db.execute(sql`
    SELECT ip.bookingExternalId AS id, ip.reference, ip.parkName, DATE_FORMAT(ip.bookingCreatedAt, '%Y-%m-%d %H:%i') AS createdAt,
           ip.initialPrice, ip.priceAtExport, DATE_FORMAT(ip.importedAt, '%Y-%m-%d %H:%i') AS importedAt,
           mb.externalId AS inCopy,
           COALESCE(CASE WHEN JSON_VALID(mb.rawJson) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(mb.rawJson, '$.bookingPrice')) AS DECIMAL(12,2)) END, mb.totalPrice) AS copyPrice
      FROM booking_initial_prices ip
      LEFT JOIN multipark_bookings mb ON mb.externalId = ip.bookingExternalId`));
  const counts: Record<CopyVsInitial, number> = { igual: 0, reescrita: 0, diferente: 0, sem_copia: 0, sem_inicial: 0 };
  const samples: InitialPricesReport["samples"] = [];
  let changed = 0, first: string | null = null, last: string | null = null, lastImport: string | null = null;
  for (const r of rows) {
    const initial = num(r.initialPrice), atExport = num(r.priceAtExport);
    const copy = r.inCopy == null ? null : num(r.copyPrice);
    const kind = copyVsInitial(initial, atExport, copy);
    counts[kind]++;
    if (initial != null && atExport != null && Math.abs(initial - atExport) > 0.01) changed++;
    if (r.createdAt && (!first || r.createdAt < first)) first = r.createdAt;
    if (r.createdAt && (!last || r.createdAt > last)) last = r.createdAt;
    if (r.importedAt && (!lastImport || r.importedAt > lastImport)) lastImport = r.importedAt;
    if (kind === "diferente") samples.push({ bookingId: String(r.id), reference: r.reference ?? null, parkName: r.parkName ?? null, createdAt: r.createdAt ?? null, initial, atExport, copy, kind });
  }
  samples.sort((a, b) => Math.abs((b.copy ?? 0) - (b.initial ?? 0)) - Math.abs((a.copy ?? 0) - (a.initial ?? 0)));
  return { total: rows.length, counts, changedSinceCreation: changed, firstCreated: first, lastCreated: last, lastImportAt: lastImport, samples: samples.slice(0, 100) };
}

export interface InitialPriceEra { bookingId: string; initialPrice: number; createdAt: string | null }

/** Preços iniciais importados destas reservas (para o "era" da Correção de caixa). */
export async function listInitialPricesForBookings(bookingIds: readonly string[]): Promise<Map<string, InitialPriceEra>> {
  const out = new Map<string, InitialPriceEra>();
  const ids = [...new Set(bookingIds.filter(Boolean))].slice(0, 1000);
  if (!ids.length) return out;
  const db = await getDb();
  if (!db) return out;
  const rows = rowsOf(await db.execute(sql`
    SELECT bookingExternalId AS id, initialPrice, DATE_FORMAT(bookingCreatedAt, '%Y-%m-%dT%H:%i:%s.000Z') AS createdAt
      FROM booking_initial_prices WHERE initialPrice IS NOT NULL AND bookingExternalId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
  for (const r of rows) out.set(String(r.id), { bookingId: String(r.id), initialPrice: Number(r.initialPrice), createdAt: r.createdAt ?? null });
  return out;
}

// ─── Lista de agentes ───────────────────────────────────────────────────────

export type AgentListStatus = "ligado" | "sugestao_email" | "sugestao_telefone" | "sugestao_nome" | "sem_ficha" | "nao_encontrado" | "parceiro" | "fora";

export interface AgentListResult {
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  cities: string[];
  kind: AgentListKind;
  /** inativo / convite expirado na Multipark */
  inactive: boolean;
  agentUserId: string | null;
  /** nome com que o agente aparece nas reservas (a chave das parcerias) */
  agentName: string | null;
  /** como se encontrou o agente na Multipark */
  agentMatch: "id" | "email" | "nome" | null;
  linkedTo: { employeeId: number; fullName: string } | null;
  suggestion: { employeeId: number; fullName: string; by: "email" | "telefone" | "nome" } | null;
  /** agentes de parceiros/agências: a parceria onde já está ou a sugerida */
  partnerLinked: { partnershipId: number; name: string } | null;
  partnerSuggestion: { partnershipId: number; name: string; by: "email" | "nome" } | null;
  status: AgentListStatus;
}

export interface EmpForAgents { id: number; fullName: string; emails: string[]; agentIds: string[]; phones?: string[] }
export interface LiveAgentLite { agentUserId: string; names: string[]; email: string | null }
export interface PartnerCtx {
  partnerships: readonly PartnershipForSuggest[];
  /** agent_partner_map: nome do agente → parceria */
  mapped: ReadonlyMap<string, { partnershipId: number; name: string }>;
}

/** Decisão por linha. PURA. */
export function compareAgentRows(rows: readonly AgentListRow[], live: readonly LiveAgentLite[], emps: readonly EmpForAgents[], partners: PartnerCtx = { partnerships: [], mapped: new Map() }): AgentListResult[] {
  const byEmail = new Map<string, string[]>();
  const byName = new Map<string, Set<string>>();
  const liveById = new Map<string, LiveAgentLite>();
  for (const a of live) {
    liveById.set(a.agentUserId, a);
    if (a.email) byEmail.set(a.email.toLowerCase(), [...(byEmail.get(a.email.toLowerCase()) ?? []), a.agentUserId]);
    for (const n of a.names) {
      const k = agentNameKey(n);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k)!.add(a.agentUserId);
    }
  }
  const empByAgent = new Map<string, EmpForAgents>();
  const empsByEmail = new Map<string, EmpForAgents[]>();
  const empsByPhone = new Map<string, EmpForAgents[]>();
  const empsByName = new Map<string, EmpForAgents[]>();
  const add = <K>(m: Map<K, EmpForAgents[]>, k: K, e: EmpForAgents) => { const l = m.get(k) ?? []; if (!l.some((x) => x.id === e.id)) m.set(k, [...l, e]); };
  for (const e of emps) {
    for (const id of e.agentIds) empByAgent.set(id, e);
    for (const m of e.emails) add(empsByEmail, m, e);
    for (const p of e.phones ?? []) { const k = phoneKey(p); if (k) add(empsByPhone, k, e); }
    const k = matchKey(e.fullName);
    if (k) add(empsByName, k, e);
  }
  const mappedByKey = new Map<string, { partnershipId: number; name: string }>();
  for (const [n, v] of partners.mapped) mappedByKey.set(agentNameKey(n), v);

  return rows.map((row) => {
    const kind = agentListKind(row);
    let agentUserId: string | null = null;
    let agentMatch: AgentListResult["agentMatch"] = null;
    const fileId = String(row.agentUserId ?? "").trim();
    const systemId = !!fileId && isSystemAgentId(fileId);
    if (fileId && !systemId) { agentUserId = fileId; agentMatch = "id"; }
    else if (!fileId) {
      const viaEmail = row.email ? byEmail.get(row.email) ?? [] : [];
      if (viaEmail.length === 1) { agentUserId = viaEmail[0]; agentMatch = "email"; }
      else {
        const viaName = byName.get(agentNameKey(row.name));
        if (viaName && viaName.size === 1) { agentUserId = [...viaName][0]; agentMatch = "nome"; }
      }
    }
    const liveNames = agentUserId ? liveById.get(agentUserId)?.names ?? [] : [];
    const agentName = liveNames[0] ?? (agentUserId ? row.name : null);
    const partnerish = kind === "agencia";
    const linked = agentUserId && !partnerish ? empByAgent.get(agentUserId) ?? null : null;

    let suggestion: AgentListResult["suggestion"] = null;
    if (!linked && !partnerish) {
      const one = (l: EmpForAgents[] | undefined) => (l && l.length === 1 ? l[0] : null);
      const e1 = one(row.email ? empsByEmail.get(row.email) : undefined);
      const pk = phoneKey(row.phone);
      const e2 = e1 ? null : one(pk ? empsByPhone.get(pk) : undefined);
      const e3 = e1 || e2 ? null : one(empsByName.get(agentNameKey(row.name)));
      if (e1) suggestion = { employeeId: e1.id, fullName: e1.fullName, by: "email" };
      else if (e2) suggestion = { employeeId: e2.id, fullName: e2.fullName, by: "telefone" };
      else if (e3) suggestion = { employeeId: e3.id, fullName: e3.fullName, by: "nome" };
    }

    let partnerLinked: AgentListResult["partnerLinked"] = null;
    let partnerSuggestion: AgentListResult["partnerSuggestion"] = null;
    if (partnerish) {
      for (const n of [...liveNames, row.name]) { const hit = mappedByKey.get(agentNameKey(n)); if (hit) { partnerLinked = hit; break; } }
      if (!partnerLinked) {
        const s = suggestForAgents([{ agentName: row.name, email: row.email, partnerOnly: true }], [], partners.partnerships)[0]?.suggestion;
        if (s && s.type === "parceiro") partnerSuggestion = { partnershipId: s.partnershipId, name: s.name, by: s.by };
      }
    }

    const status: AgentListStatus = systemId || kind === "teste" ? "fora"
      : partnerish ? (partnerLinked ? "ligado" : agentUserId || fileId ? "parceiro" : "nao_encontrado")
      : !agentUserId ? "nao_encontrado"
      : linked ? "ligado"
      : suggestion ? (suggestion.by === "email" ? "sugestao_email" : suggestion.by === "telefone" ? "sugestao_telefone" : "sugestao_nome")
      : "sem_ficha";
    return {
      name: row.name, email: row.email, phone: row.phone ?? null, role: row.role ?? null, cities: row.cities, kind,
      inactive: isInactiveAgentState(row.state), agentUserId, agentName, agentMatch,
      linkedTo: linked ? { employeeId: linked.id, fullName: linked.fullName } : null,
      suggestion, partnerLinked, partnerSuggestion, status,
    };
  });
}

/** Lista de agentes (CSV ou xlsx) contra os agentes ao vivo e as fichas. Só leitura. */
export async function compareAgentList(rows: readonly AgentListRow[]): Promise<{ results: AgentListResult[]; liveAvailable: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível.");
  const { listLiveAgents } = await import("./multiparkDb/activityLive");
  const liveRes = await listLiveAgents({ days: 400 });
  const live: LiveAgentLite[] = liveRes.available
    ? liveRes.data.filter((a) => !isSystemAgentId(a.agentUserId)).map((a) => ({ agentUserId: a.agentUserId, names: [...new Set([a.agentName, ...a.agentNames].filter((n): n is string => !!n))], email: a.email }))
    : [];
  const empRows = rowsOf(await db.execute(sql`
    SELECT e.id, e.fullName, e.multiparkAgentUserId AS agentId, e.phone,
           LOWER(TRIM(e.email)) AS email, LOWER(TRIM(e.personalEmail)) AS personalEmail, LOWER(TRIM(u.email)) AS userEmail
      FROM employees e LEFT JOIN users u ON u.id = e.userId WHERE e.isActive = 1`));
  const extraAccounts = rowsOf(await db.execute(sql`
    SELECT a.employeeId, LOWER(TRIM(u.email)) AS email FROM employee_accounts a JOIN users u ON u.id = a.userId`).catch(() => [[]]));
  const aliases = rowsOf(await db.execute(sql`SELECT employeeId, agentUserId FROM employee_agents`).catch(() => [[]]));
  const emps = new Map<number, EmpForAgents>();
  for (const r of empRows) {
    emps.set(Number(r.id), {
      id: Number(r.id), fullName: String(r.fullName ?? ""),
      emails: [r.email, r.personalEmail, r.userEmail].filter((x): x is string => !!x),
      agentIds: r.agentId ? [String(r.agentId).trim()] : [],
      phones: r.phone ? [String(r.phone)] : [],
    });
  }
  for (const a of extraAccounts) if (a.email) emps.get(Number(a.employeeId))?.emails.push(String(a.email));
  for (const a of aliases) emps.get(Number(a.employeeId))?.agentIds.push(String(a.agentUserId));
  const partnerships = rowsOf(await db.execute(sql`SELECT id, name, contactEmail FROM partnerships`).catch(() => [[]]))
    .map((r) => ({ id: Number(r.id), name: String(r.name ?? ""), contactEmail: r.contactEmail ?? null }));
  const { listAgentPartners } = await import("./db");
  const mapped = new Map((await listAgentPartners().catch(() => [])).map((m) => [m.agentName, { partnershipId: m.partnershipId, name: m.partnerName ?? `#${m.partnershipId}` }]));
  return { results: compareAgentRows(rows, live, [...emps.values()], { partnerships, mapped }), liveAvailable: liveRes.available };
}
