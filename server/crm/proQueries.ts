/**
 * CRM fase 2 — leitura da CONTA CORRENTE dos clientes Pro (nossa BD, tabelas
 * da migração 0220, alimentadas por server/crm/proSync.ts). Os valores vêm
 * das regras de shared/crmPro.ts (summarizeLedger).
 *
 * Âmbito de cidade: quem só vê algumas cidades vê as contas com parque nelas
 * e, dentro de cada conta, só os movimentos desses parques (ou sem parque).
 * Valores em euros só para quem vê totais financeiros.
 */
import { sql } from "drizzle-orm";
import { cityAliases } from "../multiparkDb/read";
import { multiparkBookingUrl, multiparkProUrl, summarizeLedger, type AccountSummary, type LedgerRowIn } from "../../shared/crmPro";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const DT = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);
const n = (v: unknown) => (v == null ? 0 : Number(v));
const nn = (v: unknown) => (v == null ? null : Number(v));

type Opts = { cities: string[] | undefined; canSeeTotals: boolean };

/**
 * Cidade do parque dentro do âmbito? (undefined = todas). Sem cidade (ex.:
 * cobrança online da conta inteira) só para quem vê todas as cidades. PURA.
 */
export function cityInScope(city: string | null | undefined, cities: string[] | undefined): boolean {
  if (cities === undefined) return true;
  if (!city) return false;
  return new Set(cityAliases(cities)).has(city.trim().toLowerCase());
}

/** Resumo sem euros (quem não vê totais financeiros). PURA. */
export function hideMoney(s: AccountSummary) {
  return {
    ...s, balance: null, due: null, currentMonthDebit: null, paidThisYear: null,
    months: s.months.map((m) => ({ ...m, debit: null, credit: null, pending: null, settledGap: null })),
  };
}

async function loadLedger(db: any, accountIds: number[]) {
  if (!accountIds.length) return [];
  return rowsOf(await db.execute(sql`SELECT id, accountId, kind, sourceId, ${DT("entryAt")} AS entryAt, periodKey, mpPeriodKey, parkId, parkName, city,
      bookingExternalId, bookingCode, ${DT("checkIn")} AS checkIn, ${DT("checkOut")} AS checkOut, plate, travelerName, description,
      debit, credit, paidAmount, listPrice, discountAmount, infoAmount, status, method, ${DT("goneAt")} AS goneAt
    FROM crm_pro_ledger WHERE accountId IN (${sql.join(accountIds.map((x) => sql`${x}`), sql`, `)}) AND goneAt IS NULL
    ORDER BY entryAt DESC, id DESC`));
}

const toIn = (r: any): LedgerRowIn => ({
  kind: String(r.kind), entryAt: String(r.entryAt), periodKey: String(r.periodKey ?? ""), debit: n(r.debit), credit: n(r.credit),
  infoAmount: nn(r.infoAmount), status: r.status ?? null, method: r.method ?? null, mpPeriodKey: r.mpPeriodKey ?? null, goneAt: r.goneAt ?? null,
});

/** Contas Pro (separador Pro), com o resumo da conta corrente. */
export async function listProAccounts(db: any, o: Opts & { search?: string | null; onlyDue?: boolean }) {
  const accounts = rowsOf(await db.execute(sql`SELECT a.id, a.mpClientId, a.crmClientId, a.name, a.email, a.phone, a.nif, a.active, a.autoBilling,
      ${DT("a.syncedAt")} AS syncedAt, c.displayName AS fichaName, c.photoUrl
    FROM crm_pro_accounts a LEFT JOIN crm_clients c ON c.id = a.crmClientId ORDER BY a.name`));
  const parks = rowsOf(await db.execute(sql`SELECT accountId, proClientId, parkName, city, discount, active FROM crm_pro_parks WHERE goneAt IS NULL`));
  const parksOf = new Map<number, any[]>();
  for (const p of parks) parksOf.set(Number(p.accountId), [...(parksOf.get(Number(p.accountId)) ?? []), p]);
  // Pro antigos (sem ProClient): guardados só para comparar — FORA da lista e dos
  // totais (Jorge, 27 set). Para os ver, escrever "antigo" na procura.
  const raw = (o.search ?? "").trim().toLowerCase();
  const legacyMode = isLegacySearch(raw);
  const t = legacyMode ? stripLegacyWord(raw) : raw;
  const isLegacy = (a: any) => (parksOf.get(Number(a.id)) ?? []).length === 0;
  const legacyCount = accounts.filter(isLegacy).length;
  const searched = accounts
    .filter((a) => isLegacy(a) === legacyMode)
    .filter((a) => !t || [a.name, a.fichaName, a.email, a.nif].some((x) => String(x ?? "").toLowerCase().includes(t)));
  const ledger = await loadLedger(db, searched.map((a) => Number(a.id)));
  const byAccount = new Map<number, LedgerRowIn[]>();
  for (const r of ledger) {
    if (!cityInScope(r.city, o.cities)) continue;
    byAccount.set(Number(r.accountId), [...(byAccount.get(Number(r.accountId)) ?? []), toIn(r)]);
  }
  // âmbito: parque Pro na cidade OU movimentos na cidade (os Pro antigos não têm parques Pro)
  const visible = searched.filter((a) => o.cities === undefined
    || (parksOf.get(Number(a.id)) ?? []).some((p) => cityInScope(p.city, o.cities))
    || (byAccount.get(Number(a.id)) ?? []).length > 0);
  const rows = visible.map((a) => {
    const s = summarizeLedger(byAccount.get(Number(a.id)) ?? []);
    const summary = o.canSeeTotals ? { ...s, months: undefined } : { ...hideMoney(s), months: undefined };
    return {
      id: Number(a.id), mpClientId: String(a.mpClientId), crmClientId: a.crmClientId == null ? null : Number(a.crmClientId),
      name: a.name ?? a.fichaName ?? null, email: a.email ?? null, nif: a.nif ?? null, photoUrl: a.photoUrl ?? null,
      active: Number(a.active) === 1, autoBilling: Number(a.autoBilling) === 1, syncedAt: a.syncedAt ?? null,
      parks: (parksOf.get(Number(a.id)) ?? []).filter((p) => cityInScope(p.city, o.cities)).map((p) => ({ name: p.parkName ?? null, city: p.city ?? null, discount: nn(p.discount), active: Number(p.active) === 1 })),
      summary, multiparkUrl: multiparkProUrl(String(a.mpClientId)),
      /** sem ProClient na Multipark: Pro do modelo antigo (reservas/cobranças soltas) */
      legacy: (parksOf.get(Number(a.id)) ?? []).length === 0,
      // para ordenar/filtrar mesmo sem euros visíveis
      hasDue: s.due > 0.005,
    };
  });
  const out = o.onlyDue ? rows.filter((r) => r.hasDue) : rows;
  // em dívida primeiro (mais antigo primeiro), depois por nome
  out.sort((x, y) => Number(y.hasDue) - Number(x.hasDue) || String(x.summary.oldestDue ?? "9999").localeCompare(String(y.summary.oldestDue ?? "9999")) || String(x.name ?? "").localeCompare(String(y.name ?? ""), "pt"));
  const lastSync = rowsOf(await db.execute(sql`SELECT ${DT("MAX(syncedAt)")} AS at FROM crm_pro_accounts`))[0]?.at ?? null;
  return { rows: out, lastSync, canSeeTotals: o.canSeeTotals, legacyMode, legacyCount };
}

/** A procura pede os Pro antigos? ("antigo", "antigos", "pro antigo", "legacy"). PURA. */
export function isLegacySearch(s: string): boolean {
  return /(^|\s)(antigos?|legacy)(\s|$)/i.test(s.trim());
}
/** Tira a palavra dos Pro antigos da procura (o resto filtra por nome/email/NIF). PURA. */
export function stripLegacyWord(s: string): string {
  return s.replace(/(^|\s)(pro\s+)?(antigos?|legacy)(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
}

/** Conta Pro de uma ficha (ou de uma ficha junta a esta), com os movimentos. null = a ficha não é Pro. */
export async function getProAccountForClient(db: any, crmClientId: number, o: Opts) {
  const [a] = rowsOf(await db.execute(sql`SELECT a.* , ${DT("a.syncedAt")} AS syncedAtS FROM crm_pro_accounts a
    WHERE a.crmClientId = ${crmClientId}
       OR a.crmClientId IN (SELECT e.mergedId FROM crm_merge_events e WHERE e.survivorId = ${crmClientId} AND e.undoneAt IS NULL)
    ORDER BY a.crmClientId = ${crmClientId} DESC LIMIT 1`));
  if (!a) return null;
  const accountId = Number(a.id);
  const allParks = rowsOf(await db.execute(sql`SELECT proClientId, parkName, city, name, discount, active, ${DT("deactivatedAt")} AS deactivatedAt
    FROM crm_pro_parks WHERE accountId = ${accountId} AND goneAt IS NULL ORDER BY parkName`));
  const parks = allParks.filter((p) => cityInScope(p.city, o.cities));
  const ledger = (await loadLedger(db, [accountId])).filter((r) => cityInScope(r.city, o.cities));
  // âmbito: parque Pro na cidade OU movimentos na cidade (os Pro antigos não têm parques Pro)
  if (o.cities !== undefined && !parks.length && !ledger.length) return null;
  const summary = summarizeLedger(ledger.map(toIn));
  const money = (v: unknown) => (o.canSeeTotals ? nn(v) : null);
  // pessoas: fichas ligadas à empresa (trabalha em / gere) + quem viajou nas reservas
  const people = rowsOf(await db.execute(sql`
    SELECT c.id, c.displayName, c.primaryEmail, r.kind
    FROM crm_client_relations r JOIN crm_clients c ON c.id = r.clientId AND c.status = 'active'
    WHERE r.relatedClientId = ${Number(a.crmClientId ?? 0)} AND r.kind IN ('employee', 'manager')`));
  const travelers = new Map<string, number>();
  for (const r of ledger) if (r.kind === "booking" && r.travelerName) travelers.set(String(r.travelerName), (travelers.get(String(r.travelerName)) ?? 0) + 1);
  return {
    id: accountId, mpClientId: String(a.mpClientId), crmClientId: a.crmClientId == null ? null : Number(a.crmClientId),
    name: a.name ?? null, email: a.email ?? null, phone: a.phone ?? null, nif: a.nif ?? null, taxName: a.taxName ?? null,
    active: Number(a.active) === 1, autoBilling: Number(a.autoBilling) === 1, billingEmail: a.billingEmail ?? null, syncedAt: a.syncedAtS ?? null,
    legacy: allParks.length === 0,
    parks: parks.map((p) => ({ proClientId: String(p.proClientId), name: p.parkName ?? null, city: p.city ?? null, discount: nn(p.discount), active: Number(p.active) === 1, deactivatedAt: p.deactivatedAt ?? null })),
    summary: o.canSeeTotals ? summary : hideMoney(summary),
    ledger: ledger.slice(0, 3000).map((r) => ({
      id: Number(r.id), kind: String(r.kind), entryAt: String(r.entryAt), periodKey: String(r.periodKey ?? ""), mpPeriodKey: r.mpPeriodKey ?? null,
      parkName: r.parkName ?? null, city: r.city ?? null, bookingCode: r.bookingCode ?? null, bookingExternalId: r.bookingExternalId ?? null,
      checkIn: r.checkIn ?? null, checkOut: r.checkOut ?? null, plate: r.plate ?? null, travelerName: r.travelerName ?? null, description: r.description ?? null,
      debit: money(r.debit), credit: money(r.credit), paidAmount: money(r.paidAmount), listPrice: money(r.listPrice), discountAmount: money(r.discountAmount),
      infoAmount: money(r.infoAmount), status: r.status ?? null, method: r.method ?? null,
      multiparkUrl: r.bookingExternalId ? multiparkBookingUrl(String(r.bookingExternalId)) : null,
    })),
    people: people.map((p) => ({ id: Number(p.id), name: p.displayName ?? null, email: p.primaryEmail ?? null, kind: String(p.kind) })),
    travelers: [...travelers.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([name, trips]) => ({ name, trips })),
    multiparkUrl: multiparkProUrl(String(a.mpClientId)),
    canSeeTotals: o.canSeeTotals,
  };
}
