/**
 * Contactos — pesquisa unificada (clientes, contactos do CRM, leads de
 * extras, parceiros, fornecedores, colaboradores, diretório da empresa e os
 * contactos Google da própria pessoa) e a ficha de um contacto (reservas,
 * reclamações, WhatsApp e emails ligados).
 *
 * Regras:
 *  - cada tipo só entra para quem vê o módulo de origem além do próprio
 *    (shared/contacts.ts → contactKindsFor); o âmbito de cidade vem do
 *    pedido (cityScope) e é aplicado em TODAS as queries;
 *  - nada é carregado de uma vez: "todos" = poucos resultados por tipo;
 *    um tipo = páginas (offset) de CONTACT_SEARCH_PAGE;
 *  - SQL sempre parametrizado (LIKE escapado em parseContactQuery).
 */
import { TRPCError } from "@trpc/server";
import { sql, type SQL } from "drizzle-orm";
import {
  CONTACT_SEARCH_PAGE, CONTACT_SEARCH_PREVIEW, contactKindsFor, contactRef, emailKey, parseContactQuery, phoneKey, uniqueStrings,
  type ContactKind, type ParsedContactQuery,
} from "../shared/contacts";
import { can, grantFor, rolesBelow, type Access, type AccessOverrides } from "../shared/access";
import { partnerScope, projectScope, scopedProjectIds } from "./cityScope";

type Db = { execute: (q: SQL) => Promise<any> };
export interface ContactViewer { id: number; role: string; accessOverrides?: AccessOverrides | null }

export interface ContactItem {
  ref: string;
  kind: ContactKind;
  id: string;
  name: string;
  subtitle: string | null;
  email: string | null;
  phone: string | null;
  photoUrl: string | null;
}

export interface KindPage { kind: ContactKind; items: ContactItem[]; hasMore: boolean; nextCursor: number | null }

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (xs: readonly (string | number)[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
const s = (v: unknown) => (v == null || v === "" ? null : String(v));

/** Condição de texto/telefone/email sobre as colunas dadas (vazia = tudo). */
function matchCond(q: ParsedContactQuery, text: SQL[], phones: SQL[], emails: SQL[] = []): SQL {
  if (!q.text && !q.digits) return sql`1 = 1`;
  const parts: SQL[] = [];
  for (const c of [...text, ...emails]) parts.push(sql`LOWER(${c}) LIKE ${q.like}`);
  if (q.phoneNeedle) for (const c of phones) parts.push(sql`REGEXP_REPLACE(COALESCE(${c}, ''), '[^0-9]', '') LIKE ${`%${q.phoneNeedle}%`}`);
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`1 = 0`;
}

// ─── Um tipo ────────────────────────────────────────────────────────────────

interface KindQuery { q: ParsedContactQuery; raw: string; offset: number; limit: number; access: Access; viewer: ContactViewer }

async function searchClients(d: Db, k: KindQuery): Promise<{ items: ContactItem[]; hasMore: boolean }> {
  const { listClients } = await import("./clientsCrm");
  const pageSize = Math.max(10, k.limit);
  const page = Math.floor(k.offset / pageSize) + 1;
  const r = await listClients(d, { search: k.raw || null, page, pageSize });
  const items = r.rows.slice(0, k.limit).map((c): ContactItem => ({
    ref: contactRef("client", c.email), kind: "client", id: c.email, name: c.name || c.email,
    subtitle: `${c.bookings} reserva(s)${c.lastCheckIn ? ` · última ${String(c.lastCheckIn).slice(0, 10)}` : ""}${c.upcoming ? ` · ${c.upcoming} futura(s)` : ""}`,
    email: c.email, phone: c.phone, photoUrl: null,
  }));
  return { items, hasMore: r.total > page * pageSize || r.rows.length > k.limit };
}

async function searchCrm(d: Db, k: KindQuery) {
  const rows = rowsOf(await d.execute(sql`SELECT c.id, c.kind, c.name, c.email, c.phone, c.phoneE164, c.company FROM crm_contacts c
    WHERE ${projectScope(sql`c.projectId`)} AND ${matchCond(k.q, [sql`c.name`, sql`c.company`], [sql`c.phoneE164`, sql`c.phone`], [sql`c.email`])}
    ORDER BY c.updatedAt DESC, c.id DESC LIMIT ${k.limit + 1} OFFSET ${k.offset}`));
  return rows.map((r): ContactItem => ({
    ref: contactRef("crm", r.id), kind: "crm", id: String(r.id), name: String(r.name),
    subtitle: [r.kind === "lead" ? "Lead comercial" : "Cliente (CRM)", s(r.company)].filter(Boolean).join(" · "),
    email: s(r.email), phone: s(r.phoneE164 ?? r.phone), photoUrl: null,
  }));
}

async function searchLeads(d: Db, k: KindQuery) {
  const ids = scopedProjectIds();
  const scope = ids === undefined ? sql`1 = 1` : ids.length ? sql`(l.projectId IS NULL OR l.projectId IN (${inList(ids)}))` : sql`l.projectId IS NULL`;
  const rows = rowsOf(await d.execute(sql`SELECT l.id, l.fullName, l.email, l.phone, l.phoneE164, l.status FROM extra_leads l
    WHERE ${scope} AND ${matchCond(k.q, [sql`l.fullName`], [sql`l.phoneE164`, sql`l.phone`], [sql`l.email`])}
    ORDER BY l.createdAt DESC, l.id DESC LIMIT ${k.limit + 1} OFFSET ${k.offset}`));
  return rows.map((r): ContactItem => ({
    ref: contactRef("lead", r.id), kind: "lead", id: String(r.id), name: String(r.fullName), subtitle: `Lead de extra · ${String(r.status)}`,
    email: s(r.email), phone: s(r.phoneE164 ?? r.phone), photoUrl: null,
  }));
}

async function searchPartners(d: Db, k: KindQuery) {
  const rows = rowsOf(await d.execute(sql`SELECT p.id, p.name, p.contactName, p.contactEmail, p.contactPhone, p.partnerType, p.partnerStatus FROM partnerships p
    WHERE ${partnerScope(sql`p.id`)} AND ${matchCond(k.q, [sql`p.name`, sql`p.contactName`], [sql`p.contactPhone`], [sql`p.contactEmail`])}
    ORDER BY (p.partnerStatus = 'active') DESC, p.name LIMIT ${k.limit + 1} OFFSET ${k.offset}`));
  return rows.map((r): ContactItem => ({
    ref: contactRef("partner", r.id), kind: "partner", id: String(r.id), name: String(r.name),
    subtitle: [s(r.contactName), String(r.partnerStatus) === "active" ? null : "inativo"].filter(Boolean).join(" · ") || null,
    email: s(r.contactEmail), phone: s(r.contactPhone), photoUrl: null,
  }));
}

async function searchSuppliers(d: Db, k: KindQuery) {
  // Só o nome/NIF do fornecedor (sem valores); agrupado pela coluna que se seleciona.
  const rows = rowsOf(await d.execute(sql`SELECT e.supplier AS name, MAX(e.supplierNif) AS nif, COUNT(*) AS n, MAX(e.expenseDate) AS lastAt FROM expenses e
    WHERE e.supplier IS NOT NULL AND e.supplier <> '' AND ${projectScope(sql`e.projectId`)}
      AND ${k.q.text || k.q.digits ? sql`(LOWER(e.supplier) LIKE ${k.q.like}${k.q.digits.length >= 3 ? sql` OR e.supplierNif LIKE ${`%${k.q.digits}%`}` : sql``})` : sql`1 = 1`}
    GROUP BY e.supplier ORDER BY lastAt DESC LIMIT ${k.limit + 1} OFFSET ${k.offset}`));
  return rows.map((r): ContactItem => ({
    ref: contactRef("supplier", String(r.name)), kind: "supplier", id: String(r.name), name: String(r.name),
    subtitle: `${r.nif ? `NIF ${r.nif} · ` : ""}${Number(r.n)} despesa(s)`, email: null, phone: null, photoUrl: null,
  }));
}

async function searchEmployees(d: Db, k: KindQuery) {
  // Alcance "equipa" (below_city): só quem está abaixo (ou sem conta) e o próprio.
  const below = rolesBelow(k.viewer.role);
  const team = k.access === "below_city"
    ? sql`(e.userId IS NULL OR e.userId = ${k.viewer.id}${below.length ? sql` OR u.role IN (${inList(below)})` : sql``})`
    : sql`1 = 1`;
  const rows = rowsOf(await d.execute(sql`SELECT e.id, e.fullName, e.email, e.phone, e.position, e.photoUrl, g.photoUrl AS dirPhoto, g.jobTitle
    FROM employees e LEFT JOIN users u ON u.id = e.userId
    LEFT JOIN google_directory_people g ON g.employeeId = e.id AND g.deletedAt IS NULL
    WHERE e.isActive = 1 AND ${projectScope(sql`e.projectId`)} AND ${team}
      AND ${matchCond(k.q, [sql`e.fullName`], [sql`e.phone`], [sql`e.email`])}
    ORDER BY e.fullName LIMIT ${k.limit + 1} OFFSET ${k.offset}`));
  return rows.map((r): ContactItem => ({
    ref: contactRef("employee", r.id), kind: "employee", id: String(r.id), name: String(r.fullName),
    subtitle: s(r.jobTitle) ?? s(r.position), email: s(r.email), phone: s(r.phone), photoUrl: s(r.dirPhoto) ?? s(r.photoUrl),
  }));
}

async function searchDirectory(d: Db, k: KindQuery) {
  const rows = rowsOf(await d.execute(sql`SELECT g.id, g.displayName, g.primaryEmail, g.phoneE164, g.phoneRaw, g.jobTitle, g.department, g.photoUrl FROM google_directory_people g
    WHERE g.deletedAt IS NULL AND ${matchCond(k.q, [sql`g.displayName`, sql`g.jobTitle`, sql`g.department`], [sql`g.phoneE164`, sql`g.phoneRaw`], [sql`g.primaryEmail`])}
    ORDER BY g.displayName LIMIT ${k.limit + 1} OFFSET ${k.offset}`));
  return rows.map((r): ContactItem => ({
    ref: contactRef("directory", r.id), kind: "directory", id: String(r.id), name: String(r.displayName),
    subtitle: [s(r.jobTitle), s(r.department)].filter(Boolean).join(" · ") || null, email: s(r.primaryEmail), phone: s(r.phoneE164 ?? r.phoneRaw), photoUrl: s(r.photoUrl),
  }));
}

async function searchGoogle(d: Db, k: KindQuery) {
  const rows = rowsOf(await d.execute(sql`SELECT c.id, c.displayName, c.primaryEmail, c.primaryPhone, c.source FROM google_user_contacts c
    WHERE c.userId = ${k.viewer.id} AND ${matchCond(k.q, [sql`c.displayName`, sql`c.emailsJson`], [sql`c.phonesJson`], [sql`c.primaryEmail`])}
    ORDER BY c.displayName LIMIT ${k.limit + 1} OFFSET ${k.offset}`));
  return rows.map((r): ContactItem => ({
    ref: contactRef("google", r.id), kind: "google", id: String(r.id), name: s(r.displayName) ?? s(r.primaryEmail) ?? s(r.primaryPhone) ?? "(sem nome)",
    subtitle: r.source === "other" ? "Outros contactos" : "Os meus contactos", email: s(r.primaryEmail), phone: s(r.primaryPhone), photoUrl: null,
  }));
}

const SEARCHERS: Record<ContactKind, (d: Db, k: KindQuery) => Promise<ContactItem[] | { items: ContactItem[]; hasMore: boolean }>> = {
  client: searchClients, crm: searchCrm, lead: searchLeads, partner: searchPartners, supplier: searchSuppliers,
  employee: searchEmployees, directory: searchDirectory, google: searchGoogle,
};

/** Tipos pesquisáveis no pedido atual (fornecedores: só alcance de cidade/nacional). */
export function searchableKinds(viewer: ContactViewer): Array<{ kind: ContactKind; access: Access }> {
  return contactKindsFor(viewer).filter((k) => k.kind !== "supplier" || k.access === "city" || k.access === "national");
}

export async function searchContacts(d: Db, viewer: ContactViewer, input: { q?: string | null; kind?: ContactKind | "all"; cursor?: number | null; limit?: number | null }): Promise<{ kinds: ContactKind[]; groups: KindPage[] }> {
  const allowed = searchableKinds(viewer);
  if (!allowed.length) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
  const raw = String(input.q ?? "").trim().slice(0, 120);
  const q = parseContactQuery(raw);
  const kinds = allowed.map((k) => k.kind);
  const want = input.kind && input.kind !== "all" ? allowed.filter((k) => k.kind === input.kind) : allowed;
  if (input.kind && input.kind !== "all" && !want.length) throw new TRPCError({ code: "FORBIDDEN", message: "Sem acesso a este tipo de contacto." });
  const all = !input.kind || input.kind === "all";
  // "Todos" exige pesquisa (nunca lista tudo de todos os tipos); um tipo pode ser percorrido às páginas.
  if (all && raw.length < 2) return { kinds, groups: [] };
  const limit = all ? CONTACT_SEARCH_PREVIEW : Math.min(CONTACT_SEARCH_PAGE, Math.max(5, input.limit ?? CONTACT_SEARCH_PAGE));
  const offset = all ? 0 : Math.max(0, Math.min(10_000, input.cursor ?? 0));
  const groups: KindPage[] = [];
  for (const k of want) {
    try {
      const r = await SEARCHERS[k.kind](d, { q, raw, offset, limit, access: k.access, viewer });
      const items = Array.isArray(r) ? r.slice(0, limit) : r.items;
      const hasMore = Array.isArray(r) ? r.length > limit : r.hasMore;
      groups.push({ kind: k.kind, items, hasMore, nextCursor: hasMore ? offset + limit : null });
    } catch (err: any) {
      if (err instanceof TRPCError) throw err;
      // Uma fonte em falta (ex.: tabela ainda por criar) não parte a pesquisa toda.
      groups.push({ kind: k.kind, items: [], hasMore: false, nextCursor: null });
    }
  }
  return { kinds, groups };
}

// ─── Ficha ──────────────────────────────────────────────────────────────────

export interface ContactDetail {
  ref: string; kind: ContactKind; id: string; name: string; subtitle: string | null;
  emails: string[]; phones: string[]; photoUrl: string | null;
  /** Email a usar na timeline de Comunicações (cliente com reservas). */
  clientEmail: string | null;
  openHref: string | null;
  bookings: Array<{ id: number; externalId: string; bookingNumber: string | null; status: string | null; parkName: string | null; checkIn: string | null; checkOut: string | null; licensePlate: string | null }> | null;
  complaints: Array<{ id: number; title: string; status: string; createdAt: string | null }> | null;
  whatsapp: Array<{ id: number; phone: string; lastMessageAt: string | null; unreadCount: number; status: string | null; name: string | null }> | null;
  mail: Array<{ id: number; subject: string | null; lastMessageAt: string | null; link: string; source: string }> | null;
}

const beyondOwn = (viewer: ContactViewer, m: Parameters<typeof grantFor>[1]) => {
  const g = grantFor(viewer as any, m);
  return g.access !== "none" && g.access !== "own" && g.actions.includes("view");
};

async function baseRecord(d: Db, viewer: ContactViewer, kind: ContactKind, id: string, access: Access) {
  const one = async (q: SQL) => rowsOf(await d.execute(q))[0] ?? null;
  switch (kind) {
    case "client": {
      const email = emailKey(id);
      if (!email) return null;
      const r = await one(sql`SELECT MAX(NULLIF(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)), '')) AS name, MAX(NULLIF(TRIM(b.clientPhone), '')) AS phone, COUNT(*) AS n
        FROM multipark_bookings b WHERE LOWER(TRIM(b.clientEmail)) = ${email} AND ${projectScope(sql`b.projectId`)}`);
      if (!r || !Number(r.n)) return null;
      return { name: s(r.name) ?? email, subtitle: `${Number(r.n)} reserva(s)`, emails: [email], phones: [s(r.phone)], photoUrl: null, clientEmail: email, openHref: `/clientes?email=${encodeURIComponent(email)}` };
    }
    case "crm": {
      const r = await one(sql`SELECT id, kind, name, email, phone, phoneE164, company FROM crm_contacts c WHERE c.id = ${Number(id)} AND ${projectScope(sql`c.projectId`)} LIMIT 1`);
      if (!r) return null;
      return { name: String(r.name), subtitle: [r.kind === "lead" ? "Lead comercial" : "Cliente (CRM)", s(r.company)].filter(Boolean).join(" · "), emails: [s(r.email)], phones: [s(r.phoneE164 ?? r.phone)], photoUrl: null, clientEmail: null, openHref: null };
    }
    case "lead": {
      const ids = scopedProjectIds();
      const scope = ids === undefined ? sql`1 = 1` : ids.length ? sql`(l.projectId IS NULL OR l.projectId IN (${inList(ids)}))` : sql`l.projectId IS NULL`;
      const r = await one(sql`SELECT id, fullName, email, phone, phoneE164, status FROM extra_leads l WHERE l.id = ${Number(id)} AND ${scope} LIMIT 1`);
      if (!r) return null;
      return { name: String(r.fullName), subtitle: `Lead de extra · ${String(r.status)}`, emails: [s(r.email)], phones: [s(r.phoneE164 ?? r.phone)], photoUrl: null, clientEmail: null, openHref: "/extras-leads" };
    }
    case "partner": {
      const r = await one(sql`SELECT id, name, contactName, contactEmail, contactPhone FROM partnerships p WHERE p.id = ${Number(id)} AND ${partnerScope(sql`p.id`)} LIMIT 1`);
      if (!r) return null;
      return { name: String(r.name), subtitle: s(r.contactName), emails: [s(r.contactEmail)], phones: [s(r.contactPhone)], photoUrl: null, clientEmail: null, openHref: "/parcerias" };
    }
    case "supplier": {
      const r = await one(sql`SELECT MAX(e.supplierNif) AS nif, COUNT(*) AS n FROM expenses e WHERE e.supplier = ${id} AND ${projectScope(sql`e.projectId`)}`);
      if (!r || !Number(r.n)) return null;
      return { name: id, subtitle: `${r.nif ? `NIF ${r.nif} · ` : ""}${Number(r.n)} despesa(s)`, emails: [], phones: [], photoUrl: null, clientEmail: null, openHref: "/despesas" };
    }
    case "employee": {
      const below = rolesBelow(viewer.role);
      const team = access === "below_city"
        ? sql`(e.userId IS NULL OR e.userId = ${viewer.id}${below.length ? sql` OR u.role IN (${inList(below)})` : sql``})` : sql`1 = 1`;
      const r = await one(sql`SELECT e.id, e.fullName, e.email, e.phone, e.position, e.photoUrl, g.photoUrl AS dirPhoto, g.jobTitle, g.phoneE164 AS dirPhone
        FROM employees e LEFT JOIN users u ON u.id = e.userId LEFT JOIN google_directory_people g ON g.employeeId = e.id AND g.deletedAt IS NULL
        WHERE e.id = ${Number(id)} AND ${projectScope(sql`e.projectId`)} AND ${team} LIMIT 1`);
      if (!r) return null;
      return { name: String(r.fullName), subtitle: s(r.jobTitle) ?? s(r.position), emails: [s(r.email)], phones: [s(r.phone), s(r.dirPhone)], photoUrl: s(r.dirPhoto) ?? s(r.photoUrl), clientEmail: null, openHref: null };
    }
    case "directory": {
      const r = await one(sql`SELECT id, displayName, primaryEmail, emailsJson, phoneE164, phoneRaw, jobTitle, department, photoUrl FROM google_directory_people g WHERE g.id = ${Number(id)} AND g.deletedAt IS NULL LIMIT 1`);
      if (!r) return null;
      let emails: string[] = [];
      try { emails = JSON.parse(String(r.emailsJson ?? "[]")); } catch { emails = []; }
      return { name: String(r.displayName), subtitle: [s(r.jobTitle), s(r.department)].filter(Boolean).join(" · ") || null, emails: [s(r.primaryEmail), ...emails], phones: [s(r.phoneE164 ?? r.phoneRaw)], photoUrl: s(r.photoUrl), clientEmail: null, openHref: null };
    }
    case "google": {
      const r = await one(sql`SELECT id, displayName, emailsJson, phonesJson, source FROM google_user_contacts c WHERE c.id = ${Number(id)} AND c.userId = ${viewer.id} LIMIT 1`);
      if (!r) return null;
      let emails: string[] = []; let phones: string[] = [];
      try { emails = JSON.parse(String(r.emailsJson ?? "[]")); } catch { emails = []; }
      try { phones = JSON.parse(String(r.phonesJson ?? "[]")); } catch { phones = []; }
      return { name: s(r.displayName) ?? emails[0] ?? phones[0] ?? "(sem nome)", subtitle: r.source === "other" ? "Outros contactos (Google)" : "Os meus contactos (Google)", emails, phones, photoUrl: null, clientEmail: null, openHref: null };
    }
  }
}

/** Condição "este cliente" numa tabela com email/telefone (telefone pelos últimos 9 dígitos). */
function personCond(emailCol: SQL, phoneCol: SQL, emails: string[], phones: string[]): SQL {
  const parts: SQL[] = [];
  if (emails.length) parts.push(sql`LOWER(TRIM(${emailCol})) IN (${inList(emails)})`);
  const needles = uniqueStrings(phones.map((p) => p.replace(/\D+/g, "").slice(-9)).filter((x) => x.length === 9));
  for (const n of needles) parts.push(sql`REGEXP_REPLACE(COALESCE(${phoneCol}, ''), '[^0-9]', '') LIKE ${`%${n}`}`);
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`1 = 0`;
}

export async function contactDetail(d: Db, viewer: ContactViewer, kind: ContactKind, id: string): Promise<ContactDetail> {
  const allowed = searchableKinds(viewer).find((k) => k.kind === kind);
  if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "Sem acesso a este tipo de contacto." });
  const base = await baseRecord(d, viewer, kind, id, allowed.access);
  if (!base) throw new TRPCError({ code: "NOT_FOUND", message: "Contacto não encontrado (ou fora das tuas cidades)." });
  const emails = uniqueStrings(base.emails.map((e) => emailKey(e))).slice(0, 10);
  const phones = uniqueStrings(base.phones.map((p) => phoneKey(p))).slice(0, 10);
  const out: ContactDetail = {
    ref: contactRef(kind, id), kind, id, name: base.name, subtitle: base.subtitle, emails, phones, photoUrl: base.photoUrl,
    clientEmail: base.clientEmail, openHref: base.openHref, bookings: null, complaints: null, whatsapp: null, mail: null,
  };
  // Cliente com reservas no âmbito também para os outros tipos (ex.: um parceiro que também reserva).
  if (!out.clientEmail && emails.length && beyondOwn(viewer, "clientes")) {
    const hit = rowsOf(await d.execute(sql`SELECT LOWER(TRIM(b.clientEmail)) AS email FROM multipark_bookings b
      WHERE LOWER(TRIM(b.clientEmail)) IN (${inList(emails)}) AND ${projectScope(sql`b.projectId`)} LIMIT 1`))[0];
    if (hit) out.clientEmail = String(hit.email);
  }
  if ((emails.length || phones.length) && (beyondOwn(viewer, "clientes") || beyondOwn(viewer, "reservas_operacoes"))) {
    out.bookings = rowsOf(await d.execute(sql`SELECT b.id, b.externalId, b.bookingNumber, b.status, b.parkName, b.checkIn, b.checkOut, b.licensePlate
      FROM multipark_bookings b WHERE ${personCond(sql`b.clientEmail`, sql`b.clientPhone`, emails, phones)} AND ${projectScope(sql`b.projectId`)}
      ORDER BY b.checkIn DESC LIMIT 10`)).map((r) => ({
      id: Number(r.id), externalId: String(r.externalId), bookingNumber: s(r.bookingNumber), status: s(r.status), parkName: s(r.parkName),
      checkIn: s(r.checkIn), checkOut: s(r.checkOut), licensePlate: s(r.licensePlate),
    }));
  }
  if ((emails.length || phones.length) && beyondOwn(viewer, "reclamacoes")) {
    out.complaints = rowsOf(await d.execute(sql`SELECT c.id, c.title, c.complaint_status AS status, c.createdAt FROM complaints c
      WHERE ${personCond(sql`c.clientEmail`, sql`c.clientPhone`, emails, phones)} AND ${projectScope(sql`c.projectId`)}
      ORDER BY c.createdAt DESC LIMIT 10`)).map((r) => ({ id: Number(r.id), title: String(r.title), status: String(r.status), createdAt: s(r.createdAt) }));
  }
  if ((emails.length || phones.length) && beyondOwn(viewer, "whatsapp")) {
    const { visibilitySql } = await import("./whatsappInbox");
    const cond: SQL[] = [];
    if (phones.length) cond.push(sql`whatsapp_conversations.phoneE164 IN (${inList(phones)})`);
    if (emails.length) cond.push(sql`LOWER(TRIM(whatsapp_conversations.linkedClientEmail)) IN (${inList(emails)})`);
    out.whatsapp = rowsOf(await d.execute(sql`SELECT whatsapp_conversations.id, whatsapp_conversations.phoneE164, whatsapp_conversations.lastMessageAt,
        whatsapp_conversations.unreadCount, whatsapp_conversations.status, whatsapp_conversations.profileName
      FROM whatsapp_conversations LEFT JOIN employees ON employees.id = whatsapp_conversations.employeeId
      WHERE (${sql.join(cond, sql` OR `)}) AND ${visibilitySql(scopedProjectIds())}
      ORDER BY whatsapp_conversations.lastMessageAt DESC LIMIT 5`)).map((r) => ({
      id: Number(r.id), phone: String(r.phoneE164), lastMessageAt: s(r.lastMessageAt), unreadCount: Number(r.unreadCount ?? 0), status: s(r.status), name: s(r.profileName),
    }));
  }
  if (emails.length) {
    // Emails: conversas com este contacto que a pessoa já pode ver (a sua caixa + caixas partilhadas visíveis).
    const { listMailboxes } = await import("./mail/store");
    const { canSeeMailbox, mailboxCityRestricted } = await import("../shared/mail");
    const boxes = (await listMailboxes().catch(() => [])).filter((m) => canSeeMailbox(viewer as any, m));
    const ids = scopedProjectIds();
    // Caixas com cidade: só as conversas ligadas às cidades de quem pede (a mesma regra da Comunicação).
    const boxConds = boxes.map((b) => (mailboxCityRestricted(viewer as any, b) && ids !== undefined
      ? (ids.length ? sql`(t.mailboxKey = ${b.key} AND t.projectId IN (${inList(ids)}))` : sql`1 = 0`)
      : sql`t.mailboxKey = ${b.key}`));
    const scope = sql`(t.ownerUserId = ${viewer.id}${boxConds.length ? sql` OR ${sql.join(boxConds, sql` OR `)}` : sql``})`;
    const labels = new Map(boxes.map((b) => [b.key, b.label]));
    out.mail = rowsOf(await d.execute(sql`SELECT t.id, t.subject, t.lastMessageAt, t.mailboxKey FROM mail_threads t
      WHERE ${scope} AND t.contactEmail IN (${inList(emails)}) ORDER BY t.lastMessageAt DESC LIMIT 10`).catch(() => [[]])).map((r) => ({
      id: Number(r.id), subject: s(r.subject), lastMessageAt: s(r.lastMessageAt),
      link: r.mailboxKey ? `/comunicacao?caixa=${encodeURIComponent(String(r.mailboxKey))}&t=${r.id}` : `/comunicacao/meu-email?t=${r.id}`,
      source: r.mailboxKey ? labels.get(String(r.mailboxKey)) ?? String(r.mailboxKey) : "O meu email",
    }));
  }
  return out;
}

export { can };
