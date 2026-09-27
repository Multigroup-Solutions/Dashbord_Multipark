/**
 * CRM fase 2 — sincroniza a CONTA CORRENTE dos clientes Pro a partir da BD da
 * Multipark (trabalho `crm-pro-sync` do agendador). Os Pro são poucos, por
 * isso cada corrida relê tudo (server/multiparkDb/pro.ts) e grava de forma
 * idempotente na nossa BD (migração 0220):
 *   - contas (uma por cliente da Multipark) e parques (ProClient);
 *   - movimentos por (kind, sourceId); o que deixou de vir marca-se `goneAt`
 *     (nunca se apaga) — só quando a leitura veio completa;
 *   - cada conta liga-se à ficha do CRM: pelo id da Multipark já registado
 *     (crm_client_external_ids), senão pelo email EXATO da conta (é o email
 *     com que o cliente entra na Multipark — o mesmo cliente, não uma
 *     suposição), senão cria-se a ficha (empresa ou pessoa);
 *   - a ficha da conta fica como QUEM PAGA as reservas Pro
 *     (crm_booking_links role "payer").
 */
import { sql } from "drizzle-orm";
import { readMultiparkPro, type ProAccountOut, type ProDiagnostics, type ProLedgerOut } from "../multiparkDb/pro";
import { multiparkProUrl } from "../../shared/crmPro";
import { emailKey, namesMatch, nifKey, phoneKey } from "../../shared/crmIdentity";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (vals: (string | number)[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const insertId = (res: any) => Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);

/** Nome de empresa? (para criar a ficha como empresa ou pessoa). PURA. */
export function looksLikeCompany(name: string | null | undefined, taxName?: string | null): boolean {
  const s = `${name ?? ""} ${taxName ?? ""}`;
  return /\b(lda|l\.da|s\.\s?a\.?|sa|unipessoal|sociedade|ltd|limited|gmbh|sarl|s\.?l\.?|inc|corp|grupo|group|hotel|rent|car)\b/i.test(s);
}

export interface ProSyncResult {
  ok: boolean;
  reason?: string;
  accounts: number;
  parks: number;
  ledgerRows: number;
  goneRows: number;
  linked: number;
  created: number;
  payerLinks: number;
  diagnostics?: ProDiagnostics;
  ms: number;
}

export async function runProSync(o: { deadlineAt: number }): Promise<ProSyncResult> {
  const t0 = Date.now();
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) throw new Error("BD do dashboard indisponível.");
  const res: ProSyncResult = { ok: true, accounts: 0, parks: 0, ledgerRows: 0, goneRows: 0, linked: 0, created: 0, payerLinks: 0, ms: 0 };

  const read = await readMultiparkPro();
  if (!read.available) return { ...res, ok: false, reason: read.reason, ms: Date.now() - t0 };
  const snap = read.data;
  res.diagnostics = snap.diagnostics;
  const runAt = utcNow();
  // só se marca o que "desapareceu" quando a leitura veio completa e com contas
  const complete = !snap.diagnostics.truncated && snap.accounts.length > 0;

  // 1) contas
  for (const part of chunks(snap.accounts, 200)) {
    await db.execute(sql`INSERT INTO crm_pro_accounts (mpClientId, name, email, phone, nif, taxName, autoBilling, active, syncedAt)
      VALUES ${sql.join(part.map((a) => sql`(${a.mpClientId}, ${a.name}, ${a.email}, ${a.phone}, ${a.nif}, ${a.taxName}, ${a.autoBilling ? 1 : 0}, ${a.active ? 1 : 0}, ${runAt})`), sql`, `)}
      ON DUPLICATE KEY UPDATE name = VALUES(name), email = VALUES(email), phone = VALUES(phone), nif = VALUES(nif), taxName = VALUES(taxName),
        autoBilling = VALUES(autoBilling), active = VALUES(active), syncedAt = VALUES(syncedAt)`);
  }
  // contas que deixaram de ser Pro na Multipark: pela diferença de chaves (não pela
  // hora — duas corridas ao mesmo tempo não se estragam uma à outra)
  const accountRows = rowsOf(await db.execute(sql`SELECT id, mpClientId, crmClientId, active FROM crm_pro_accounts`));
  if (complete) {
    const now = new Set(snap.accounts.map((a) => a.mpClientId));
    const off = accountRows.filter((r) => Number(r.active) === 1 && !now.has(String(r.mpClientId))).map((r) => Number(r.id));
    for (const part of chunks(off, 500)) await db.execute(sql`UPDATE crm_pro_accounts SET active = 0 WHERE id IN (${inList(part)})`);
  }
  const accountId = new Map<string, number>(accountRows.map((r) => [String(r.mpClientId), Number(r.id)]));
  res.accounts = snap.accounts.length;

  // 2) parques (ProClient)
  const parks = snap.accounts.flatMap((a) => a.parks.map((p) => ({ ...p, accountId: accountId.get(a.mpClientId) ?? 0 }))).filter((p) => p.accountId);
  for (const part of chunks(parks, 200)) {
    await db.execute(sql`INSERT INTO crm_pro_parks (proClientId, accountId, parkId, parkName, city, name, discount, active, deactivatedAt, mpCreatedAt, goneAt)
      VALUES ${sql.join(part.map((p) => sql`(${p.proClientId}, ${p.accountId}, ${p.parkId}, ${p.parkName}, ${p.city}, ${p.name}, ${p.discount}, ${p.active ? 1 : 0}, ${p.deactivatedAt}, ${p.mpCreatedAt}, NULL)`), sql`, `)}
      ON DUPLICATE KEY UPDATE accountId = VALUES(accountId), parkId = VALUES(parkId), parkName = VALUES(parkName), city = VALUES(city), name = VALUES(name),
        discount = VALUES(discount), active = VALUES(active), deactivatedAt = VALUES(deactivatedAt), mpCreatedAt = VALUES(mpCreatedAt), goneAt = NULL`);
  }
  if (complete && parks.length) {
    await db.execute(sql`UPDATE crm_pro_parks SET goneAt = UTC_TIMESTAMP(), active = 0 WHERE goneAt IS NULL AND proClientId NOT IN (${inList(parks.map((p) => p.proClientId))})`);
  }
  res.parks = parks.length;

  // 3) movimentos
  const ledger = snap.ledger.map((l) => ({ ...l, accountId: accountId.get(l.mpClientId) ?? 0 })).filter((l) => l.accountId);
  for (const part of chunks(ledger, 300)) {
    await db.execute(sql`INSERT INTO crm_pro_ledger (accountId, kind, sourceId, entryAt, periodKey, mpPeriodKey, parkId, parkName, city,
        bookingExternalId, bookingCode, checkIn, checkOut, plate, travelerName, description, debit, credit, paidAmount, listPrice, discountAmount,
        infoAmount, status, method, goneAt, syncedAt)
      VALUES ${sql.join(part.map((l) => sql`(${l.accountId}, ${l.kind}, ${l.sourceId}, ${l.entryAt}, ${l.periodKey}, ${cut(l.mpPeriodKey, 64)}, ${l.parkId}, ${l.parkName}, ${l.city},
        ${l.bookingExternalId}, ${l.bookingCode}, ${l.checkIn}, ${l.checkOut}, ${cut(l.plate, 32)}, ${cut(l.travelerName, 255)}, ${cut(l.description, 255)},
        ${l.debit}, ${l.credit}, ${l.paidAmount}, ${l.listPrice}, ${l.discountAmount}, ${l.infoAmount}, ${cut(l.status, 24)}, ${cut(l.method, 64)}, NULL, ${runAt})`), sql`, `)}
      ON DUPLICATE KEY UPDATE accountId = VALUES(accountId), entryAt = VALUES(entryAt), periodKey = VALUES(periodKey), mpPeriodKey = VALUES(mpPeriodKey),
        parkId = VALUES(parkId), parkName = VALUES(parkName), city = VALUES(city), bookingExternalId = VALUES(bookingExternalId), bookingCode = VALUES(bookingCode),
        checkIn = VALUES(checkIn), checkOut = VALUES(checkOut), plate = VALUES(plate), travelerName = VALUES(travelerName), description = VALUES(description),
        debit = VALUES(debit), credit = VALUES(credit), paidAmount = VALUES(paidAmount), listPrice = VALUES(listPrice), discountAmount = VALUES(discountAmount),
        infoAmount = VALUES(infoAmount), status = VALUES(status), method = VALUES(method), goneAt = NULL, syncedAt = VALUES(syncedAt)`);
  }
  res.ledgerRows = ledger.length;
  if (complete) {
    // o que deixou de vir da Multipark (pela diferença de chaves): goneAt, nunca apagar
    const keep = new Set(ledger.map((l) => `${l.kind}|${l.sourceId}`));
    const live = rowsOf(await db.execute(sql`SELECT id, kind, sourceId, bookingExternalId FROM crm_pro_ledger WHERE goneAt IS NULL`));
    const gone = live.filter((r) => !keep.has(`${r.kind}|${r.sourceId}`));
    for (const part of chunks(gone.map((r) => Number(r.id)), 500)) await db.execute(sql`UPDATE crm_pro_ledger SET goneAt = UTC_TIMESTAMP() WHERE id IN (${inList(part)})`);
    res.goneRows = gone.length;
    // reservas que deixaram de ser Pro: a ficha da conta deixa de ser quem paga
    const goneBookings = gone.filter((r) => r.kind === "booking" && r.bookingExternalId).map((r) => String(r.bookingExternalId));
    for (const part of chunks(goneBookings, 500)) {
      await db.execute(sql`DELETE FROM crm_booking_links WHERE role = 'payer' AND rule = 'pro' AND bookingExternalId IN (${inList(part)})`);
    }
  }

  // 4) ficha do CRM de cada conta + quem paga
  {
    const byMp = new Map(snap.accounts.map((a) => [a.mpClientId, a]));
    const current = rowsOf(await db.execute(sql`SELECT id, mpClientId, crmClientId FROM crm_pro_accounts`));
    for (const r of current) {
      // o que ficar por fazer faz-se na próxima corrida (de 30 em 30 min)
      if (Date.now() > o.deadlineAt - 5_000) break;
      const a = byMp.get(String(r.mpClientId));
      if (!a) continue;
      const { clientId, created } = await resolveFicha(db, a, r.crmClientId == null ? null : Number(r.crmClientId));
      if (!clientId) continue;
      if (created) res.created++;
      if (Number(r.crmClientId) !== clientId) {
        await db.execute(sql`UPDATE crm_pro_accounts SET crmClientId = ${clientId} WHERE id = ${Number(r.id)}`);
        res.linked++;
      }
      await db.execute(sql`INSERT IGNORE INTO crm_client_external_ids (clientId, \`system\`, externalId, url)
        VALUES (${clientId}, 'multipark_client', ${a.mpClientId}, ${multiparkProUrl(a.mpClientId)})`);
      if (a.active) await db.execute(sql`UPDATE crm_clients SET isPro = IF(proManual = 1, isPro, 1) WHERE id = ${clientId}`);
      const bookingIds = ledger.filter((l) => l.mpClientId === a.mpClientId && l.kind === "booking").map((l) => l.sourceId);
      for (const part of chunks(bookingIds, 500)) {
        await db.execute(sql`INSERT INTO crm_booking_links (bookingExternalId, clientId, role, rule)
          VALUES ${sql.join(part.map((b) => sql`(${b}, ${clientId}, 'payer', 'pro')`), sql`, `)}
          ON DUPLICATE KEY UPDATE clientId = VALUES(clientId), rule = VALUES(rule)`);
        res.payerLinks += part.length;
      }
    }
  }
  res.ms = Date.now() - t0;
  return res;
}

const cut = (s: string | null, n: number) => (s == null ? null : s.slice(0, n));

/** Ficha ativa ao fim de fusões em cadeia (ou null). */
async function activeFicha(db: any, id: number | null): Promise<number | null> {
  let x = id;
  for (let i = 0; x && i < 20; i++) {
    const [c] = rowsOf(await db.execute(sql`SELECT status, mergedInto FROM crm_clients WHERE id = ${x}`));
    if (!c) return null;
    if (c.status === "active") return x;
    x = c.mergedInto ? Number(c.mergedInto) : null;
  }
  return null;
}

async function resolveFicha(db: any, a: ProAccountOut, current: number | null): Promise<{ clientId: number | null; created: boolean }> {
  // já ligada (segue fusões)
  const cur = await activeFicha(db, current);
  if (cur) return { clientId: cur, created: false };
  // id da Multipark já registado numa ficha
  const [ext] = rowsOf(await db.execute(sql`SELECT clientId FROM crm_client_external_ids WHERE \`system\` = 'multipark_client' AND externalId = ${a.mpClientId} LIMIT 1`));
  const byExt = await activeFicha(db, ext ? Number(ext.clientId) : null);
  if (byExt) return { clientId: byExt, created: false };
  // email EXATO da conta Multipark — mas, como nas regras de identidade, o
  // email sozinho não liga: tem de bater também o telefone, o NIF ou o nome
  // (senão cria-se a ficha e as sugestões diárias propõem juntar)
  const email = a.email ? emailKey(a.email) : "";
  const phone = a.phone ? phoneKey(a.phone) : "";
  const nif = a.nif ? nifKey(a.nif) : "";
  if (email) {
    const hits = rowsOf(await db.execute(sql`SELECT DISTINCT c.id, c.displayName, c.nif FROM crm_client_emails e JOIN crm_clients c ON c.id = e.clientId
      WHERE e.email = ${email} AND e.generic = 0 AND c.status = 'active' LIMIT 2`));
    if (hits.length === 1) {
      const h = hits[0];
      const phones = phone ? rowsOf(await db.execute(sql`SELECT 1 AS ok FROM crm_client_phones WHERE clientId = ${Number(h.id)} AND phone = ${phone} LIMIT 1`)) : [];
      const agrees = phones.length > 0 || (!!nif && nifKey(h.nif) === nif) || (!!a.name && namesMatch(String(h.displayName ?? ""), a.name));
      if (agrees) return { clientId: Number(h.id), created: false };
    }
  }
  // cria a ficha (idempotente pela syncKey)
  const kind = looksLikeCompany(a.name, a.taxName) ? "company" : "person";
  const syncKey = `pro:${a.mpClientId}`;
  const ins: any = await db.execute(sql`INSERT INTO crm_clients (syncKey, kind, source, displayName, primaryEmail, primaryPhone, nif, taxName, isPro, noEmail, lastSeenAt)
    VALUES (${syncKey}, ${kind}, 'multipark_pro', ${a.name ?? "Cliente Pro"}, ${email || null}, ${phone || null}, ${nif || null}, ${a.taxName}, ${a.active ? 1 : 0}, ${email ? 0 : 1}, UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`);
  const raw = insertId(ins);
  // 1 = nova; 2 = já existia (ON DUPLICATE) — nesse caso pode ter sido junta a outra
  const created = Number((Array.isArray(ins) ? ins[0] : ins)?.affectedRows ?? 0) === 1;
  const id = await activeFicha(db, raw || null);
  if (!id) return { clientId: null, created: false };
  if (created) {
    if (email) await db.execute(sql`INSERT IGNORE INTO crm_client_emails (clientId, email, isPrimary, source, firstSeenAt, lastSeenAt) VALUES (${id}, ${email}, 1, 'multipark_pro', UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
    if (phone) await db.execute(sql`INSERT IGNORE INTO crm_client_phones (clientId, phone, isPrimary, source, firstSeenAt, lastSeenAt) VALUES (${id}, ${phone}, 1, 'multipark_pro', UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
  }
  return { clientId: id, created };
}

export type { ProLedgerOut };
