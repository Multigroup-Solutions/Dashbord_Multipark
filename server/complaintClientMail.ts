/**
 * Lote 57 (Jorge, 12 out 2026): na ficha da reclamação, TODO o histórico de
 * emails com o cliente — todas as conversas, em todas as caixas partilhadas
 * que a pessoa vê (info@, reservas@, reclamações@, cancelamentos…), da mais
 * recente para a mais antiga — e não só os emails da própria reclamação.
 *
 * Quem é o cliente (shared/complaintClientMail.ts):
 *  - os emails da reclamação: o do cliente, os das conversas ligadas ao caso
 *    e os dos emails que entraram para o caso (inbound_emails);
 *  - o email do cliente da reserva ligada (ficha do CRM ligada à reserva; sem
 *    ela, a reserva lida AO VIVO da Multipark);
 *  - os emails da ficha do cliente no CRM (pelo email ou pelo telefone — só
 *    quando esse email/telefone é de até 2 fichas, regra MAX_AUTO_SHARED, e
 *    pelo telefone, ou num email partilhado, só a ficha com o MESMO nome;
 *    nunca empresas — shared/complaintClientMail.ts crmIdentityAccepted).
 * Só emails pessoais (nem da empresa nem de balcão) e nunca de um PARCEIRO
 * (agência que reserva para vários clientes: as conversas dela são de outros).
 *
 * Que conversas: as das caixas partilhadas visíveis (regra da Comunicação +
 * cidade), nunca "O meu email" nem caixas sem acesso, nem arquivadas pela
 * retenção, nem só automáticas. Limite por página + "Ver mais"; a consulta é
 * uma união de dois ramos indexados (contacto / ligação), nunca um varrimento.
 *
 * Erro ≠ vazio: a leitura das conversas falhada → erro; uma fonte da
 * identidade falhada (CRM, Multipark) → aviso "podem faltar conversas".
 */
import { sql, type SQL } from "drizzle-orm";
import {
  clientMailLimit, clientThreadAllowed, clientThreadLink, crmIdentityAccepted, identityEmails, lastMessageDirection, visibleSharedBoxes,
  type BoxAccess, type IdentitySource,
} from "../shared/complaintClientMail";
import { isPartnerSender } from "../shared/complaintIntake";
import { emailKey, isPersonalEmail, phoneKey, MAX_AUTO_SHARED } from "../shared/crmIdentity";
import { isCompanyAddress, type MailViewer, type MailboxConfig } from "../shared/mail";

const rowsOf = (r: any): any[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : Array.isArray(r) ? r : []);
const inList = (vals: readonly (string | number)[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);

async function database() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}

export interface ClientMailComplaint {
  id: number;
  /** Nome do cliente (o telefone só junta uma ficha do CRM com o MESMO nome). */
  clientName?: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  reservationRef: string | null;
}

export interface ClientThreadOut {
  id: number;
  mailboxKey: string;
  mailboxLabel: string;
  subject: string;
  snippet: string;
  contactEmail: string | null;
  contactName: string | null;
  lastMessageAt: string | null;
  lastDirection: "in" | "out" | null;
  messageCount: number;
  unread: boolean;
  status: string;
  /** É a conversa desta reclamação (ligada ao caso). */
  thisComplaint: boolean;
  /** Outras reclamações a que a conversa está ligada. */
  otherComplaintIds: number[];
  link: string;
}

export interface ClientMailResult {
  /** A pessoa não vê nenhuma caixa partilhada da Comunicação (≠ "sem emails"). */
  noMailAccess: boolean;
  emails: Array<{ email: string; sources: IdentitySource[] }>;
  threads: ClientThreadOut[];
  total: number;
  hasMore: boolean;
  limit: number;
  /** Fontes da identidade que falharam: "podem faltar conversas" (nunca se esconde). */
  warnings: string[];
}

export interface ThreadQuery { emails: string[]; complaintId: number; access: BoxAccess[]; limit: number }

export interface ClientMailDeps {
  boxes(): Promise<Array<Pick<MailboxConfig, "key" | "label" | "module" | "visibleRoles" | "active" | "cityRule">>>;
  brandDomains(): Promise<Record<string, string[]>>;
  /** Emails dos contactos dos parceiros (agências…): nunca identificam um cliente. Lança se a BD falhar. */
  partnerEmails(): Promise<string[]>;
  /** Emails dos emails/conversas ligados ao caso. */
  complaintEmails(complaintId: number): Promise<string[]>;
  /** Email(s) do cliente da reserva ligada + fichas do CRM ligadas à reserva. */
  booking(ref: string): Promise<{ emails: string[]; clientIds: number[] }>;
  /** Fichas do CRM destes emails/telefone (regra de identidade: mesmo nome, nunca empresas) e os emails delas. */
  crm(q: { emails: string[]; phone: string | null; name: string | null; clientIds: number[] }): Promise<{ emails: string[] }>;
  threads(q: ThreadQuery): Promise<{ rows: any[]; total: number }>;
  /** Reclamações ligadas a cada conversa. */
  complaintLinks(threadIds: number[]): Promise<Map<number, number[]>>;
}

/** Resposta "não usas as caixas partilhadas da Comunicação" (≠ erro, ≠ "sem emails"). */
export const NO_MAIL_ACCESS = (limit?: number | null): ClientMailResult => ({
  noMailAccess: true, emails: [], threads: [], total: 0, hasMore: false, limit: clientMailLimit(limit), warnings: [],
});

/**
 * O histórico de emails do cliente de uma reclamação. Quem chama já confirmou
 * o acesso à reclamação (e a cidade dela). Lança se as conversas não se lerem.
 */
export async function clientMailHistory(
  viewer: MailViewer,
  complaint: ClientMailComplaint,
  opts: { limit?: number | null; scopeIds: number[] | undefined },
  deps: ClientMailDeps = dbClientMailDeps,
): Promise<ClientMailResult> {
  const limit = clientMailLimit(opts.limit);
  const boxes = await deps.boxes();
  const access = visibleSharedBoxes(viewer, boxes, opts.scopeIds);
  if (!access.length) return NO_MAIL_ACCESS(limit);

  const warnings: string[] = [];
  const brandDomains = await deps.brandDomains().catch(() => undefined);
  // Parceiros (agências que reservam para vários clientes): o email deles nunca
  // identifica ESTE cliente — as conversas com a agência são de outros clientes.
  let partners: string[] | null = null;
  try { partners = await deps.partnerEmails(); } catch { partners = null; }
  const isCompany = (e: string) => isCompanyAddress(e, brandDomains) || (partners != null && isPartnerSender(e, partners));
  const found: Array<{ email: string | null | undefined; source: IdentitySource }> = [{ email: complaint.clientEmail, source: "reclamacao" }];
  try {
    for (const e of await deps.complaintEmails(complaint.id)) found.push({ email: e, source: "reclamacao" });
  } catch {
    warnings.push("Não foi possível ler os emails ligados a esta reclamação — podem faltar conversas.");
  }
  let bookingClientIds: number[] = [];
  if (complaint.reservationRef) {
    try {
      const b = await deps.booking(complaint.reservationRef);
      for (const e of b.emails) found.push({ email: e, source: "reserva" });
      bookingClientIds = b.clientIds;
    } catch {
      warnings.push("Não foi possível ler a reserva ligada (Multipark) — podem faltar conversas do email da reserva.");
    }
  }
  const seeds = identityEmails(found, isCompany).map((x) => x.email);
  try {
    const crm = await deps.crm({ emails: seeds, phone: complaint.clientPhone, name: complaint.clientName ?? null, clientIds: bookingClientIds });
    for (const e of crm.emails) found.push({ email: e, source: "crm" });
  } catch {
    warnings.push("Não foi possível ler a ficha do cliente no CRM — podem faltar conversas de outros emails do cliente.");
  }
  let emails = identityEmails(found, isCompany);
  if (partners == null) {
    // Sem a lista dos parceiros não se sabe se um email da reserva/CRM é de uma
    // agência: fica só o que é da própria reclamação (nunca conversas de outros).
    emails = emails.filter((x) => x.sources.includes("reclamacao"));
    warnings.push("Não foi possível confirmar os parceiros — só se procura pelos emails da própria reclamação (podem faltar conversas).");
  }

  // As conversas: falha aqui = erro (a ficha diz "Não foi possível carregar").
  const { rows, total } = await deps.threads({ emails: emails.map((x) => x.email), complaintId: complaint.id, access, limit: limit + 1 });
  const allowed = rows.filter((r) => clientThreadAllowed({
    id: Number(r.id), mailboxKey: r.mailboxKey ?? null, projectId: r.projectId != null ? Number(r.projectId) : null,
    ownerUserId: r.ownerUserId != null ? Number(r.ownerUserId) : null, archivedAt: r.archivedAt ?? null, automated: r.automated,
  }, access));
  const page = allowed.slice(0, limit);
  const links = page.length ? await deps.complaintLinks(page.map((r) => Number(r.id))) : new Map<number, number[]>();
  const labelOf = new Map(access.map((b) => [b.key, b.label]));
  const threads: ClientThreadOut[] = page.map((r) => {
    const ids = links.get(Number(r.id)) ?? [];
    return {
      id: Number(r.id), mailboxKey: String(r.mailboxKey), mailboxLabel: labelOf.get(String(r.mailboxKey)) ?? String(r.mailboxKey),
      subject: String(r.subject ?? "") || "(sem assunto)", snippet: String(r.snippet ?? ""),
      contactEmail: r.contactEmail ?? null, contactName: r.contactName ?? null,
      lastMessageAt: r.lastMessageAt ? String(r.lastMessageAt) : null,
      lastDirection: lastMessageDirection({ lastInboundAt: r.lastInboundAt ?? null, lastOutboundAt: r.lastOutboundAt ?? null }),
      messageCount: Number(r.messageCount ?? 0), unread: Number(r.unreadCount ?? 0) > 0, status: String(r.status ?? "aberto"),
      thisComplaint: ids.includes(complaint.id), otherComplaintIds: ids.filter((x) => x !== complaint.id),
      link: clientThreadLink({ id: Number(r.id), mailboxKey: String(r.mailboxKey) }),
    };
  });
  return { noMailAccess: false, emails, threads, total: Math.max(total, threads.length), hasMore: allowed.length > limit, limit, warnings };
}

// ─── SQL (exportado para os testes) ─────────────────────────────────────────

/** Condição "das caixas partilhadas visíveis (com a cidade de cada uma)" sobre `t` (mail_threads). */
export function sharedBoxesSql(access: readonly BoxAccess[]): SQL {
  if (!access.length) return sql`1 = 0`;
  const parts = access.map((b) => {
    if (b.cityIds == null) return sql`t.mailboxKey = ${b.key}`;
    return b.cityIds.length ? sql`(t.mailboxKey = ${b.key} AND t.projectId IN (${inList(b.cityIds)}))` : sql`1 = 0`;
  });
  return sql`(${sql.join(parts, sql` OR `)})`;
}

const THREAD_COLS = sql`t.id, t.mailboxKey, t.ownerUserId, t.projectId, t.archivedAt, t.automated, t.subject, t.snippet, t.contactEmail, t.contactName,
  t.lastMessageAt AS sortAt,
  DATE_FORMAT(t.lastMessageAt, '%Y-%m-%d %H:%i:%s') AS lastMessageAt,
  DATE_FORMAT(t.lastInboundAt, '%Y-%m-%d %H:%i:%s') AS lastInboundAt,
  DATE_FORMAT(t.lastOutboundAt, '%Y-%m-%d %H:%i:%s') AS lastOutboundAt,
  t.messageCount, t.unreadCount, t.status`;

/** Base comum: caixa partilhada visível (com a cidade), não arquivada, não só automática. */
export function clientThreadsBase(access: readonly BoxAccess[]): SQL {
  return sql`t.mailboxKey IS NOT NULL AND t.archivedAt IS NULL AND COALESCE(t.automated, 0) = 0 AND ${sharedBoxesSql(access)}`;
}

/**
 * As conversas do cliente: UNIÃO de dois ramos, cada um pelo seu índice (nunca
 * um OR que varre a tabela toda) — (1) o contacto é um dos emails do cliente
 * (idx_mail_threads_contact); (2) a conversa está ligada a esta reclamação ou
 * a um destes clientes (idx_mail_links_entity). O UNION tira as repetidas.
 */
export function clientThreadsUnion(q: Pick<ThreadQuery, "emails" | "complaintId" | "access">, cols: SQL = THREAD_COLS): SQL {
  const base = clientThreadsBase(q.access);
  const linkConds: SQL[] = [sql`(l.entityType = 'complaint' AND l.entityId = ${String(q.complaintId)})`];
  if (q.emails.length) linkConds.push(sql`(l.entityType = 'client' AND l.entityId IN (${inList(q.emails)}))`);
  // Sem parênteses à volta dos ramos: o ORDER BY/LIMIT de quem chama vale para a união toda
  // e o SQL serve em qualquer MySQL (sem tabelas derivadas com parênteses dobrados).
  const linked = sql`SELECT ${cols} FROM mail_links l JOIN mail_threads t ON t.id = l.threadId
    WHERE l.removedAt IS NULL AND (${sql.join(linkConds, sql` OR `)}) AND ${base}`;
  if (!q.emails.length) return linked;
  const byContact = sql`SELECT ${cols} FROM mail_threads t WHERE t.contactEmail IN (${inList(q.emails)}) AND ${base}`;
  return sql`${byContact} UNION ${linked}`;
}

export const dbClientMailDeps: ClientMailDeps = {
  async boxes() {
    const { listMailboxes } = await import("./mail/store");
    return listMailboxes();
  },
  async brandDomains() {
    const { loadBrandDomains } = await import("./mail/store");
    return loadBrandDomains();
  },
  async partnerEmails() {
    const { partnerEmails } = await import("./complaintMailIntake");
    return partnerEmails(await database());
  },
  async complaintEmails(complaintId) {
    const d = await database();
    const a = rowsOf(await d.execute(sql`SELECT clientEmail AS e1, fromEmail AS e2 FROM inbound_emails
      WHERE targetModule = 'complaint' AND targetId = ${complaintId} ORDER BY id DESC LIMIT 20`));
    const b = rowsOf(await d.execute(sql`SELECT t.contactEmail AS e1 FROM mail_links l JOIN mail_threads t ON t.id = l.threadId
      WHERE l.entityType = 'complaint' AND l.entityId = ${String(complaintId)} AND l.removedAt IS NULL AND t.contactEmail IS NOT NULL LIMIT 20`));
    return [...a, ...b].flatMap((r) => [r.e1, r.e2]).filter((x): x is string => typeof x === "string" && !!x);
  },
  async booking(ref) {
    const d = await database();
    const clientIds = rowsOf(await d.execute(sql`SELECT DISTINCT clientId FROM crm_booking_links WHERE bookingExternalId = ${ref} LIMIT 5`))
      .map((r) => Number(r.clientId)).filter((x) => Number.isInteger(x) && x > 0);
    if (clientIds.length) return { emails: [], clientIds };
    // Sem ficha ligada (reserva muito recente): a reserva AO VIVO, nas cidades de quem pede.
    const { liveBookingByRef } = await import("./multiparkDb/bookingSearch");
    const b = await liveBookingByRef(ref, { cities: "request" });
    return { emails: b?.clientEmail ? [b.clientEmail] : [], clientIds: [] };
  },
  async crm(q) {
    const d = await database();
    const { clientVisibleSql } = await import("./crm/scope");
    const ids = new Set<number>(q.clientIds);
    const cand = (rows: any[]) => rows.map((r) => ({
      clientId: Number(r.clientId), kind: r.kind != null ? String(r.kind) : null,
      name: String(r.displayName ?? "").trim() || `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || null,
    }));
    // Pelo email: até MAX_AUTO_SHARED fichas; partilhado (família) → só a do mesmo nome; nunca empresas.
    for (const raw of q.emails.slice(0, 6)) {
      const e = emailKey(raw);
      if (!e || !isPersonalEmail(e)) continue;
      const rows = rowsOf(await d.execute(sql`SELECT DISTINCT ce.clientId, c.kind, c.displayName, c.firstName, c.lastName FROM crm_client_emails ce JOIN crm_clients c ON c.id = ce.clientId
        WHERE ce.email = ${e} AND ce.generic = 0 AND c.status = 'active' AND ${clientVisibleSql(sql`c.id`)} LIMIT ${MAX_AUTO_SHARED + 1}`));
      for (const id of crmIdentityAccepted("email", cand(rows), q.name)) ids.add(id);
    }
    // Pelo telefone: só a ficha com o MESMO nome (um telefone sozinho junta pessoas diferentes).
    const phone = phoneKey(q.phone);
    if (phone && q.name) {
      const rows = rowsOf(await d.execute(sql`SELECT DISTINCT cp.clientId, c.kind, c.displayName, c.firstName, c.lastName FROM crm_client_phones cp JOIN crm_clients c ON c.id = cp.clientId
        WHERE cp.phone = ${phone} AND c.status = 'active' AND ${clientVisibleSql(sql`c.id`)} LIMIT ${MAX_AUTO_SHARED + 1}`));
      for (const id of crmIdentityAccepted("phone", cand(rows), q.name)) ids.add(id);
    }
    const list = [...ids].filter((x) => Number.isInteger(x) && x > 0).slice(0, 5);
    if (!list.length) return { emails: [] };
    const rows = rowsOf(await d.execute(sql`SELECT ce.email FROM crm_client_emails ce JOIN crm_clients c ON c.id = ce.clientId
      WHERE ce.clientId IN (${inList(list)}) AND ce.generic = 0 AND c.status = 'active'
      ORDER BY ce.isPrimary DESC, ce.lastSeenAt DESC LIMIT 20`));
    return { emails: rows.map((r) => String(r.email)) };
  },
  async threads(q) {
    const d = await database();
    const [rows, total] = await Promise.all([
      d.execute(sql`${clientThreadsUnion(q)} ORDER BY sortAt DESC, id DESC LIMIT ${Math.max(1, Math.min(101, q.limit))}`),
      d.execute(sql`SELECT COUNT(*) AS n FROM (${clientThreadsUnion(q, sql`t.id`)}) x`),
    ]);
    return { rows: rowsOf(rows), total: Number(rowsOf(total)[0]?.n ?? 0) };
  },
  async complaintLinks(threadIds) {
    const d = await database();
    const rows = rowsOf(await d.execute(sql`SELECT threadId, entityId FROM mail_links
      WHERE entityType = 'complaint' AND removedAt IS NULL AND threadId IN (${inList(threadIds)})`));
    const out = new Map<number, number[]>();
    for (const r of rows) {
      const id = Number(r.entityId);
      if (!Number.isInteger(id) || id <= 0) continue;
      const k = Number(r.threadId);
      out.set(k, [...(out.get(k) ?? []), id]);
    }
    return out;
  },
};
