/**
 * Pesquisa global (Ctrl/Cmd+K) — uma caixa, várias fontes em PARALELO, cada
 * uma com o seu prazo (uma fonte lenta não atrasa as outras: sai marcada
 * "sem resposta a tempo").
 *
 * Regras (as mesmas da página de cada fonte):
 *  - cada fonte corre no seu próprio contexto de cidade (cópia do cityScope
 *    do pedido) e começa por `requireAccess(módulo, "view")` — um override
 *    por utilizador ajusta o âmbito dessa fonte, nunca o das outras; sem
 *    acesso → a fonte fica de fora (não é erro);
 *  - todas as queries são parametrizadas, com LIMIT (máx. ~5 por grupo) e
 *    pesquisas por prefixo nas colunas indexadas das tabelas grandes;
 *  - alcance "own" (ex.: reclamações de um extra) não entra na pesquisa
 *    global, salvo nas Tarefas (as próprias, como na página).
 *
 * Nunca regista a pesquisa (pode ter dados pessoais).
 */
import { TRPCError } from "@trpc/server";
import { sql, type SQL } from "drizzle-orm";
import {
  SEARCH_MAX_PER_GROUP, SEARCH_MIN_CHARS, SEARCH_GROUP_LABELS, dashedPlate, matchNavigation, matchScore, parseSearch, rankGroups, seeAllHref,
  type ParsedSearch, type SearchGroup, type SearchGroupResult, type SearchItem,
} from "../shared/globalSearch";
import { can, grantFor, rolesBelow, type AccessOverrides, type ModuleId } from "../shared/access";
import type { KbViewer } from "../shared/knowledge";
import { requireAccess } from "./_core/access";
import { cityScope, partnerScope, projectScope, scopedProjectIds, userScope } from "./cityScope";
import type { CityAccess } from "./cityAccess";

type Db = { execute: (q: SQL) => Promise<any> };
export interface SearchViewer { id: number; role: string; name?: string | null; accessOverrides?: AccessOverrides | null }

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (xs: readonly (string | number)[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const LIMIT = SEARCH_MAX_PER_GROUP + 1;
/** Prazo por fonte (a paleta pede a cada tecla, com atraso). */
export const SOURCE_BUDGET_MS = 2_500;

export interface SourceCtx { d: Db; q: ParsedSearch; viewer: SearchViewer }
export interface SearchSource {
  group: SearchGroup;
  /** Módulos que dão acesso à fonte (basta um, com "view" além do "own" — salvo `allowOwn`). */
  modules: ModuleId[];
  allowOwn?: boolean;
  run(ctx: SourceCtx): Promise<SearchItem[]>;
}

/** Acesso da fonte (o 1.º módulo com acesso; requireAccess ajusta o âmbito de cidade desse módulo). */
function sourceAccess(viewer: SearchViewer, src: Pick<SearchSource, "modules" | "allowOwn">): ModuleId | null {
  for (const m of src.modules) {
    try {
      requireAccess(viewer, m, "view", { allowOwn: !!src.allowOwn });
      return m;
    } catch { /* tenta o módulo seguinte */ }
  }
  return null;
}

// ─── Fontes ──────────────────────────────────────────────────────────────────

const reservations: SearchSource = {
  group: "reservas",
  modules: ["reservas_operacoes"],
  async run({ d, q }) {
    const conds: SQL[] = [];
    const up = q.raw.toUpperCase();
    if (q.isEmail) conds.push(sql`b.clientEmail LIKE ${q.prefix.toLowerCase()}`);
    if (q.plate) conds.push(sql`b.licensePlate IN (${q.plate}, ${dashedPlate(q.plate)})`, sql`b.licensePlate LIKE ${`${q.plate}%`}`);
    if (q.isCode || /^\d{3,}$/.test(q.raw)) conds.push(sql`b.bookingNumber LIKE ${q.prefix}`, sql`b.externalId = ${q.raw}`, sql`b.licensePlate LIKE ${`${up.replace(/[\\%_]/g, "")}%`}`);
    if (!q.isEmail && !q.isPhone && /[a-zà-ÿ]/i.test(q.raw)) {
      const words = q.raw.split(/\s+/).filter((w) => w.length >= 2);
      const last = (words[words.length - 1] ?? q.raw).replace(/[\\%_]/g, "");
      conds.push(sql`b.clientLastName LIKE ${`${last}%`}`);
      if (words.length === 1) conds.push(sql`b.clientFirstName LIKE ${`${last}%`}`);
    }
    if (q.isPhone && q.digits.length >= 6) {
      // Telefone: sem índice — só nos últimos 18 meses (checkIn indexado) e com LIMIT.
      conds.push(sql`(b.checkIn >= DATE_SUB(NOW(), INTERVAL 18 MONTH) AND REGEXP_REPLACE(COALESCE(b.clientPhone, ''), '[^0-9]', '') LIKE ${`%${q.digits.slice(-9)}%`})`);
    }
    if (!conds.length) return [];
    const rows = rowsOf(await d.execute(sql`SELECT /*+ MAX_EXECUTION_TIME(2000) */ b.id, b.externalId, b.bookingNumber, b.status, b.parkName, b.checkIn,
        b.clientFirstName, b.clientLastName, b.clientEmail, b.licensePlate, b.bookingCreatedAt
      FROM multipark_bookings b WHERE (${sql.join(conds, sql` OR `)}) AND ${projectScope(sql`b.projectId`)}
      ORDER BY b.checkIn DESC LIMIT ${LIMIT}`));
    return rows.map((r) => {
      const name = [str(r.clientFirstName), str(r.clientLastName)].filter(Boolean).join(" ");
      const code = str(r.bookingNumber) ?? String(r.externalId);
      return {
        key: `reservas:${r.id}`, group: "reservas" as const,
        title: `${code}${name ? ` · ${name}` : ""}`,
        subtitle: [str(r.licensePlate), str(r.parkName), str(r.checkIn)?.slice(0, 10), str(r.status)].filter(Boolean).join(" · ") || null,
        // `de` = dia em que a reserva foi feita (a lista das Reservas filtra por esse dia).
        href: `/operacoes?tab=reservas&q=${encodeURIComponent(code)}${str(r.bookingCreatedAt) ? `&de=${String(r.bookingCreatedAt).slice(0, 10)}` : ""}`,
        score: matchScore(q.raw, code, String(r.externalId), str(r.licensePlate)?.replace(/-/g, ""), str(r.clientEmail), name) || 20,
      };
    });
  },
};

const complaints: SearchSource = {
  group: "reclamacoes",
  modules: ["reclamacoes"],
  async run({ d, q }) {
    const phone = q.isPhone ? sql` OR REGEXP_REPLACE(COALESCE(c.clientPhone, ''), '[^0-9]', '') LIKE ${`%${q.digits.slice(-9)}%`}` : sql``;
    const byId = /^\d{1,9}$/.test(q.raw) ? sql` OR c.id = ${Number(q.raw)}` : sql``;
    const rows = rowsOf(await d.execute(sql`SELECT c.id, c.title, c.complaint_status AS status, c.clientName, c.reservationRef, c.vehiclePlate, c.createdAt
      FROM complaints c
      WHERE ${projectScope(sql`c.projectId`)} AND (LOWER(c.title) LIKE ${q.like} OR LOWER(COALESCE(c.clientName, '')) LIKE ${q.like}
        OR LOWER(COALESCE(c.clientEmail, '')) LIKE ${q.like} OR LOWER(COALESCE(c.reservationRef, '')) LIKE ${q.like}
        OR REPLACE(UPPER(COALESCE(c.vehiclePlate, '')), '-', '') LIKE ${`%${q.raw.toUpperCase().replace(/[\s-]+/g, "").replace(/[\\%_]/g, "")}%`}${phone}${byId})
      ORDER BY c.createdAt DESC LIMIT ${LIMIT}`));
    return rows.map((r) => ({
      key: `reclamacoes:${r.id}`, group: "reclamacoes" as const, title: `#${r.id} ${String(r.title)}`,
      subtitle: [str(r.clientName), str(r.reservationRef), str(r.status), str(r.createdAt)?.slice(0, 10)].filter(Boolean).join(" · ") || null,
      href: `/reclamacoes?id=${r.id}`,
      score: q.raw === String(r.id) ? 100 : matchScore(q.raw, str(r.title), str(r.clientName), str(r.reservationRef), str(r.vehiclePlate)) || 20,
    }));
  },
};

const tasks: SearchSource = {
  group: "tarefas",
  modules: ["tarefas"],
  allowOwn: true,
  async run({ d, q, viewer }) {
    const { canEditTasks } = await import("../shared/taskRules");
    let mine = sql`1 = 1`;
    // Como a página: quem não edita tarefas só vê as suas.
    if (!canEditTasks(viewer.role)) {
      const me = rowsOf(await d.execute(sql`SELECT id FROM employees WHERE userId = ${viewer.id} LIMIT 1`))[0];
      if (!me) return [];
      const eid = Number(me.id);
      mine = sql`(t.assigneeId = ${eid} OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.taskId = t.id AND ta.employeeId = ${eid}))`;
    }
    const rows = rowsOf(await d.execute(sql`SELECT t.id, t.title, t.taskStatus AS status, t.dueDate FROM tasks t
      WHERE (t.projectId IS NULL OR ${projectScope(sql`t.projectId`)}) AND ${mine}
        AND (LOWER(t.title) LIKE ${q.like} OR LOWER(COALESCE(t.description, '')) LIKE ${q.like})
      ORDER BY (t.taskStatus = 'done'), t.updatedAt DESC LIMIT ${LIMIT}`));
    return rows.map((r) => ({
      key: `tarefas:${r.id}`, group: "tarefas" as const, title: String(r.title),
      subtitle: [str(r.status), str(r.dueDate) ? `prazo ${String(r.dueDate).slice(0, 10)}` : null].filter(Boolean).join(" · ") || null,
      href: `/tarefas?focus=${r.id}`, score: matchScore(q.raw, str(r.title)) || 20,
    }));
  },
};

const whatsapp: SearchSource = {
  group: "whatsapp",
  modules: ["whatsapp"],
  async run({ d, q }) {
    const { visibilitySql } = await import("./whatsappInbox");
    const phone = q.digits.length >= 4 ? sql` OR whatsapp_conversations.phoneE164 LIKE ${`%${q.digits.slice(-9)}%`}` : sql``;
    const rows = rowsOf(await d.execute(sql`SELECT whatsapp_conversations.id, whatsapp_conversations.profileName, whatsapp_conversations.phoneE164,
        whatsapp_conversations.lastMessageAt, whatsapp_conversations.unreadCount, employees.fullName AS employeeName
      FROM whatsapp_conversations LEFT JOIN employees ON employees.id = whatsapp_conversations.employeeId
      WHERE ${visibilitySql(scopedProjectIds())} AND (LOWER(COALESCE(whatsapp_conversations.profileName, '')) LIKE ${q.like}
        OR LOWER(COALESCE(employees.fullName, '')) LIKE ${q.like} OR LOWER(COALESCE(whatsapp_conversations.linkedClientEmail, '')) LIKE ${q.like}${phone})
      ORDER BY whatsapp_conversations.lastMessageAt DESC LIMIT ${LIMIT}`));
    return rows.map((r) => ({
      key: `whatsapp:${r.id}`, group: "whatsapp" as const, title: str(r.employeeName) ?? str(r.profileName) ?? String(r.phoneE164),
      subtitle: [String(r.phoneE164), Number(r.unreadCount) ? `${Number(r.unreadCount)} por ler` : null, str(r.lastMessageAt)?.slice(0, 16)].filter(Boolean).join(" · "),
      href: `/whatsapp?c=${r.id}`, score: matchScore(q.raw, str(r.profileName), str(r.employeeName), String(r.phoneE164).replace(/\D+/g, "")) || 20,
    }));
  },
};

export interface MailDeps { mailboxes: () => Promise<Array<{ key: string; label: string; module: any; visibleRoles?: any; active: boolean; cityRule?: any }>> }
const defaultMailDeps: MailDeps = {
  mailboxes: async () => (await import("./mail/store")).listMailboxes().catch(() => []) as any,
};

/** Emails: a própria caixa ("O meu email") + as caixas partilhadas que a pessoa vê (com a regra de cidade). */
export function mailSource(deps: MailDeps = defaultMailDeps): SearchSource {
  return {
    group: "email",
    // "O meu email" não depende do módulo (é do próprio): a ficha chega.
    modules: ["comunicacao", "ficha"],
    allowOwn: true,
    async run({ d, q, viewer }) {
      const { canSeeMailbox, mailboxCityRestricted } = await import("../shared/mail");
      const boxes = (await deps.mailboxes()).filter((m) => canSeeMailbox(viewer as any, m as any));
      const ids = scopedProjectIds();
      const boxConds = boxes.map((b) => (mailboxCityRestricted(viewer as any, b as any) && ids !== undefined
        ? (ids.length ? sql`(t.mailboxKey = ${b.key} AND t.projectId IN (${inList(ids)}))` : sql`1 = 0`)
        : sql`t.mailboxKey = ${b.key}`));
      const scope = sql`(t.ownerUserId = ${viewer.id}${boxConds.length ? sql` OR ${sql.join(boxConds, sql` OR `)}` : sql``})`;
      const labels = new Map(boxes.map((b) => [b.key, b.label]));
      const rows = rowsOf(await d.execute(sql`SELECT /*+ MAX_EXECUTION_TIME(2000) */ t.id, t.subject, t.contactEmail, t.contactName, t.lastMessageAt, t.mailboxKey
        FROM mail_threads t WHERE ${scope} AND (LOWER(COALESCE(t.subject, '')) LIKE ${q.like} OR LOWER(COALESCE(t.contactEmail, '')) LIKE ${q.like}
          OR LOWER(COALESCE(t.contactName, '')) LIKE ${q.like})
        ORDER BY t.lastMessageAt DESC LIMIT ${LIMIT}`));
      return rows.map((r) => ({
        key: `email:${r.id}`, group: "email" as const, title: str(r.subject) ?? "(sem assunto)",
        subtitle: [str(r.contactName) ?? str(r.contactEmail), r.mailboxKey ? labels.get(String(r.mailboxKey)) ?? String(r.mailboxKey) : "O meu email", str(r.lastMessageAt)?.slice(0, 10)].filter(Boolean).join(" · "),
        href: r.mailboxKey ? `/comunicacao?caixa=${encodeURIComponent(String(r.mailboxKey))}&t=${r.id}` : `/comunicacao/meu-email?t=${r.id}`,
        score: matchScore(q.raw, str(r.subject), str(r.contactEmail), str(r.contactName)) || 20,
      }));
    },
  };
}

/**
 * Contactos: reutiliza a pesquisa unificada (clientes, CRM, leads, parceiros,
 * fornecedores, colaboradores, diretório, contactos Google da própria pessoa)
 * — cada tipo com o seu módulo e âmbito. Devolve três grupos.
 */
const CONTACT_GROUP: Record<string, SearchGroup> = {
  client: "contactos", crm: "contactos", lead: "contactos", supplier: "contactos", google: "contactos", directory: "contactos",
  partner: "parceiros", employee: "pessoas",
};
export async function contactGroups(d: Db, q: ParsedSearch, viewer: SearchViewer): Promise<SearchItem[]> {
  const { searchContacts } = await import("./contactsSearch");
  const r = await searchContacts(d, viewer, { q: q.raw, kind: "all" });
  const out: SearchItem[] = [];
  for (const g of r.groups) {
    for (const c of g.items) {
      const group = CONTACT_GROUP[c.kind] ?? "contactos";
      const href = c.kind === "client" && c.email ? `/clientes?email=${encodeURIComponent(c.email)}`
        : c.kind === "employee" && can(viewer as any, "rh", "view") ? `/rh?employeeId=${encodeURIComponent(c.id)}`
        : c.kind === "partner" ? "/parcerias"
        : `/contactos?q=${encodeURIComponent(c.name)}`;
      out.push({
        key: `${group}:${c.ref}`, group, title: c.name,
        subtitle: [c.subtitle, c.email, c.phone].filter(Boolean).join(" · ") || null, href,
        score: matchScore(q.raw, c.name, c.email, c.phone?.replace(/\D+/g, "")) || 20,
      });
    }
  }
  return out;
}

const contacts: SearchSource = {
  group: "contactos",
  modules: ["contactos"],
  run: ({ d, q, viewer }) => contactGroups(d, q, viewer),
};

/** Parceiros sem o módulo Contactos (só Parcerias). */
const partnersDirect: SearchSource = {
  group: "parceiros",
  modules: ["parcerias"],
  async run({ d, q, viewer }) {
    if (can(viewer as any, "contactos", "view") && grantFor(viewer as any, "contactos").access !== "own") return []; // já veio pelos Contactos
    const rows = rowsOf(await d.execute(sql`SELECT p.id, p.name, p.contactName, p.partnerStatus FROM partnerships p
      WHERE ${partnerScope(sql`p.id`)} AND (LOWER(p.name) LIKE ${q.like} OR LOWER(COALESCE(p.contactName, '')) LIKE ${q.like})
      ORDER BY (p.partnerStatus = 'active') DESC, p.name LIMIT ${LIMIT}`));
    return rows.map((r) => ({
      key: `parceiros:partner:${r.id}`, group: "parceiros" as const, title: String(r.name),
      subtitle: [str(r.contactName), String(r.partnerStatus) === "active" ? null : "inativo"].filter(Boolean).join(" · ") || null,
      href: "/parcerias", score: matchScore(q.raw, String(r.name), str(r.contactName)) || 20,
    }));
  },
};

/** Colaboradores sem o módulo Contactos (RH): mesma regra de equipa do RH. */
const employeesDirect: SearchSource = {
  group: "pessoas",
  modules: ["rh"],
  async run({ d, q, viewer }) {
    if (can(viewer as any, "contactos", "view") && grantFor(viewer as any, "contactos").access !== "own") return [];
    const access = grantFor(viewer as any, "rh").access;
    const below = rolesBelow(viewer.role);
    const team = access === "below_city"
      ? sql`(e.userId IS NULL OR e.userId = ${viewer.id}${below.length ? sql` OR u.role IN (${inList(below)})` : sql``})` : sql`1 = 1`;
    const rows = rowsOf(await d.execute(sql`SELECT e.id, e.fullName, e.position FROM employees e LEFT JOIN users u ON u.id = e.userId
      WHERE e.isActive = 1 AND ${projectScope(sql`e.projectId`)} AND ${team} AND LOWER(e.fullName) LIKE ${q.like}
      ORDER BY e.fullName LIMIT ${LIMIT}`));
    return rows.map((r) => ({
      key: `pessoas:employee:${r.id}`, group: "pessoas" as const, title: String(r.fullName), subtitle: str(r.position),
      href: `/rh?employeeId=${r.id}`, score: matchScore(q.raw, String(r.fullName)) || 20,
    }));
  },
};

const usersSource: SearchSource = {
  group: "utilizadores",
  modules: ["utilizadores"],
  async run({ d, q }) {
    const rows = rowsOf(await d.execute(sql`SELECT u.id, u.name, u.email, u.role, u.isActive FROM users u
      WHERE ${userScope(sql`u.id`)} AND (LOWER(COALESCE(u.name, '')) LIKE ${q.like} OR LOWER(COALESCE(u.email, '')) LIKE ${q.like})
      ORDER BY u.isActive DESC, u.name LIMIT ${LIMIT}`));
    const { ROLE_LABELS } = await import("../shared/access");
    return rows.map((r) => ({
      key: `utilizadores:${r.id}`, group: "utilizadores" as const, title: str(r.name) ?? String(r.email ?? ""),
      subtitle: [str(r.email), (ROLE_LABELS as Record<string, string>)[String(r.role)] ?? str(r.role), Number(r.isActive) === 0 ? "inativa" : null].filter(Boolean).join(" · ") || null,
      href: `/utilizadores?q=${encodeURIComponent(String(r.email ?? r.name ?? ""))}`, score: matchScore(q.raw, str(r.name), str(r.email)) || 20,
    }));
  },
};

/** Documentos da base de conhecimento pelo título (só os que a pessoa pode ver). */
export function knowledgeSource(viewerOf: (v: SearchViewer) => KbViewer): SearchSource {
  return {
    group: "conhecimento",
    modules: [],
    async run({ d, q, viewer }) {
      const { kbVisibilitySql } = await import("./knowledge/store");
      const { canSeeKbDoc, parseVisibility } = await import("../shared/knowledge");
      const kv = viewerOf(viewer);
      const rows = rowsOf(await d.execute(sql`SELECT d.id, d.title, d.folderPath, d.source, d.webViewLink, d.visibilityRoles, d.visibilityCities FROM kb_documents d
        WHERE d.deletedAt IS NULL AND d.status = 'synced' AND d.source <> 'help' AND ${kbVisibilitySql(kv)}
          AND (LOWER(d.title) LIKE ${q.like} OR LOWER(COALESCE(d.folderPath, '')) LIKE ${q.like})
        ORDER BY d.title LIMIT ${LIMIT}`));
      return rows
        .filter((r) => canSeeKbDoc(parseVisibility(r.visibilityRoles, r.visibilityCities), kv))
        .map((r) => ({
          key: `conhecimento:${r.id}`, group: "conhecimento" as const, title: String(r.title),
          subtitle: [str(r.folderPath), r.source === "drive" ? "Google Drive" : "Ficheiro"].filter(Boolean).join(" · "),
          href: null, kbDocId: Number(r.id), score: matchScore(q.raw, String(r.title)) || 20,
        }));
    },
  };
}

/** Ajuda da app (docs/ajuda, no bundle) — para qualquer sessão. */
async function helpItems(q: ParsedSearch): Promise<SearchItem[]> {
  const { staffHelpDocs } = await import("./assistant/service");
  const { scoreDocs } = await import("./_core/ai/chat/retrieval");
  return scoreDocs(staffHelpDocs(), q.raw)
    .filter((x) => x.score > 0 || matchScore(q.raw, x.doc.title) > 0)
    .slice(0, LIMIT)
    .map((x) => ({
      key: `ajuda:${x.doc.file}`, group: "ajuda" as const, title: x.doc.title, subtitle: x.doc.summary || null,
      href: x.doc.routes[0] ?? null, score: Math.min(90, 20 + x.score * 10, matchScore(q.raw, x.doc.title) || 90),
    }));
}

// ─── Orquestração ────────────────────────────────────────────────────────────

export const DEFAULT_SOURCES: SearchSource[] = [reservations, contacts, complaints, tasks, mailSource(), whatsapp, partnersDirect, employeesDirect, usersSource];

function withBudget<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    (t as any).unref?.();
    p.then((value) => { clearTimeout(t); resolve({ ok: true, value }); }, () => { clearTimeout(t); resolve({ ok: false, timedOut: false }); });
  });
}

export interface GlobalSearchResult { query: string; groups: SearchGroupResult[]; tookMs: number }

/**
 * Pesquisa em todas as fontes a que `viewer` tem acesso. O cityScope do
 * pedido é copiado para cada fonte (os ajustes de um módulo ficam nessa fonte).
 */
export async function globalSearch(
  d: Db,
  viewer: SearchViewer,
  input: { q: string },
  opts: { sources?: SearchSource[]; budgetMs?: number; kbViewer?: (v: SearchViewer) => KbViewer; includeHelp?: boolean } = {},
): Promise<GlobalSearchResult> {
  const started = Date.now();
  const q = parseSearch(input.q);
  if (q.raw.length < SEARCH_MIN_CHARS) return { query: q.raw, groups: [], tookMs: 0 };
  const base = cityScope.getStore();
  if (!base) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
  const kbViewer = opts.kbViewer ?? ((v: SearchViewer) => {
    const a: CityAccess | undefined = base;
    return { role: v.role, allCities: !!a?.all, cityNames: a?.cityNames ?? (a?.cityName ? [a.cityName] : []) };
  });
  const sources = [...(opts.sources ?? DEFAULT_SOURCES), knowledgeSource(kbViewer)];
  const budget = opts.budgetMs ?? SOURCE_BUDGET_MS;

  const byGroup = new Map<SearchGroup, SearchGroupResult>();
  const put = (group: SearchGroup, items: SearchItem[], timedOut = false) => {
    const g = byGroup.get(group) ?? { group, label: SEARCH_GROUP_LABELS[group], items: [], seeAllHref: seeAllHref(group, q.raw) };
    g.items.push(...items);
    if (timedOut) g.timedOut = true;
    byGroup.set(group, g);
  };

  await Promise.all(sources.map(async (src) => {
    // Cópia do âmbito: um requireAccess desta fonte não mexe nas outras.
    const r = await cityScope.run({ ...base }, () => {
      if (src.modules.length && !sourceAccess(viewer, src)) return Promise.resolve(null);
      return withBudget(src.run({ d, q, viewer }), budget);
    });
    if (!r) return;
    if (r.ok) {
      for (const it of r.value) put(it.group, [it]);
      if (!r.value.length && src.group !== "contactos") put(src.group, []);
    } else if (r.timedOut) put(src.group, [], true);
  }));

  put("navegacao", matchNavigation(q.raw, viewer));
  if (opts.includeHelp !== false) put("ajuda", await helpItems(q).catch(() => []));

  const ranked = rankGroups([...byGroup.values()]);
  // Fontes sem resposta a tempo continuam visíveis (a paleta diz "sem resposta").
  const timedOut = [...byGroup.values()].filter((g) => g.timedOut && !ranked.some((x) => x.group === g.group)).map((g) => ({ ...g, items: [] }));
  return { query: q.raw, groups: [...ranked, ...timedOut], tookMs: Date.now() - started };
}
