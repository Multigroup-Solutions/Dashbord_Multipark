/**
 * Camada ÚNICA de notificações (sino da app + email). Todos os avisos passam
 * por `notify({ kind, projectId|city, targetUserId?, title, body, link, entity })`:
 * as regras de quem recebe estão em shared/notificationRouting.ts (tipo →
 * módulo da matriz, papéis, cidade, pessoal/obrigatório, canais) e as
 * sobreposições do super_admin em app_settings (`notifications.routing`).
 *
 * Mais ninguém escreve em app_notifications (um teste garante-o):
 *  - destinatários = ativos + papel do tipo (ou override do módulo) + cidade
 *    da notificação no âmbito + tipo não silenciado;
 *  - deduplicação: 1 notificação por pessoa × tipo × registo dentro da janela
 *    do tipo (30 min por omissão);
 *  - email só nos tipos com email, a quem o tem ligado (Perfil).
 * Nunca lança: uma falha a notificar não parte a ação que a originou.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { appNotifications } from "../drizzle/schema";
import {
  dedupeMinutesFor, entityKeyOf, kindDef, kindFilterValues, notifyCityOf, parseNotificationPrefs, parseRouting,
  resolveRecipients, canReceiveKind,
  type NotificationKindId, type NotificationRouting, type NotifyCity, type RoutedRecipient, type RoutingCandidate,
} from "../shared/notificationRouting";

export interface NotifyInput {
  kind: NotificationKindId;
  /** Projeto/parque/cidade (qualquer nó da árvore) — dá a cidade da notificação. */
  projectId?: number | null;
  /** Cidade em texto ("lisbon", "Lisboa", "Porto") — alternativa ao projectId. */
  city?: string | null;
  /** Ficha da pessoa em causa — a cidade vem do centro de custos dela. */
  employeeId?: number | null;
  /** Tipos pessoais: a quem se destina. */
  targetUserId?: number | null;
  targetUserIds?: readonly (number | null | undefined)[];
  /** Tipos não pessoais: juntar estas pessoas (ex.: responsável do caso). */
  alsoUserIds?: readonly (number | null | undefined)[];
  title: string;
  body?: string | null;
  link?: string | null;
  /** Registo a que se refere (deduplicação). */
  entity?: { type: string; id: string | number } | null;
  /** Restrição extra de destinatários (ex.: só quem vê a caixa de email). */
  recipientFilter?: (c: RoutingCandidate) => boolean;
}

export interface NotifyResult { recipients: number[]; emailed: number; duplicates: number; city: NotifyCity | null }

export interface NotifyRow { userId: number; kind: string; title: string; body: string | null; link: string | null; cityKey: string | null; entityKey: string }

export interface NotifyDeps {
  loadCandidates(): Promise<RoutingCandidate[]>;
  loadRouting(): Promise<NotificationRouting>;
  cityOfProject(projectId: number): Promise<NotifyCity | null>;
  projectOfEmployee(employeeId: number): Promise<number | null>;
  /** Quem já recebeu este tipo × registo dentro da janela. */
  recentRecipients(kind: string, entityKey: string, userIds: number[], minutes: number): Promise<Set<number>>;
  insert(rows: NotifyRow[]): Promise<void>;
  emailOf(userId: number): string | null;
  sendEmail(to: string, subject: string, text: string, html: string): Promise<boolean>;
}

const ids = (list: readonly (number | null | undefined)[] | undefined): number[] =>
  Array.from(new Set((list ?? []).filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0)));

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Núcleo (dependências injetáveis para os testes). Nunca lança. */
export async function notifyWith(deps: NotifyDeps, input: NotifyInput): Promise<NotifyResult> {
  const out: NotifyResult = { recipients: [], emailed: 0, duplicates: 0, city: null };
  try {
    const def = kindDef(input.kind);
    if (!def) { console.warn("[notify] tipo desconhecido:", input.kind); return out; }
    let city = notifyCityOf(input.city);
    let projectId = input.projectId ?? null;
    if (!city && projectId == null && input.employeeId != null) projectId = await deps.projectOfEmployee(input.employeeId).catch(() => null);
    if (!city && projectId != null) city = await deps.cityOfProject(projectId).catch(() => null);
    out.city = city;
    const [candidates, routing] = await Promise.all([deps.loadCandidates(), deps.loadRouting()]);
    const routed: RoutedRecipient[] = resolveRecipients({
      kind: def.kind,
      city,
      targetUserIds: ids([input.targetUserId, ...(input.targetUserIds ?? [])]),
      alsoUserIds: ids(input.alsoUserIds),
      filter: input.recipientFilter,
    }, candidates, routing);
    if (!routed.length) return out;

    const title = String(input.title ?? "").slice(0, 255) || def.label;
    const body = input.body == null ? null : String(input.body).slice(0, 5000);
    const entityKey = entityKeyOf({ entity: input.entity ?? null, city, title, body });
    const already = await deps.recentRecipients(def.kind, entityKey, routed.map((r) => r.userId), dedupeMinutesFor(def.kind)).catch(() => new Set<number>());
    const fresh = routed.filter((r) => !already.has(r.userId));
    out.duplicates = routed.length - fresh.length;
    if (!fresh.length) return out;

    const link = input.link ? String(input.link).slice(0, 512) : null;
    await deps.insert(fresh.map((r) => ({ userId: r.userId, kind: def.kind, title, body, link, cityKey: city, entityKey })));
    out.recipients = fresh.map((r) => r.userId);

    const mail = fresh.filter((r) => r.email);
    if (mail.length) {
      let origin = "";
      try { origin = (await import("./shiftHandoverAutomation")).appOrigin(); } catch { /* sem origem → link relativo */ }
      const url = link ? `${origin}${link}` : null;
      const text = `${body ?? ""}${url ? `\n\nAbrir: ${url}` : ""}\n\n(Podes desligar este email no Perfil → Notificações.)`;
      const html = `<h2>${escapeHtml(title)}</h2>${body ? `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>` : ""}${url ? `<p><a href="${escapeHtml(url)}">Abrir na aplicação</a></p>` : ""}<p style="color:#888;font-size:12px">Podes desligar este email no Perfil → Notificações.</p>`;
      for (const r of mail) {
        const to = deps.emailOf(r.userId);
        if (!to) continue;
        try { if (await deps.sendEmail(to, `[Dashboard Multipark] ${title.replace(/[\r\n]+/g, " ")}`, text, html)) out.emailed++; } catch { /* segue */ }
      }
    }
  } catch (err: any) {
    console.warn("[notify] falhou:", input.kind, String(err?.message ?? err).slice(0, 200));
  }
  return out;
}

// ─── Dependências reais (BD) ────────────────────────────────────────────────

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

const CACHE_MS = 30_000;
let candCache: { at: number; list: RoutingCandidate[]; emails: Map<number, string> } | null = null;

/** Esquece a cache (preferências/regras/papéis mudaram). */
export function invalidateNotifyCache(): void {
  candCache = null;
}

async function loadCandidatesCached(): Promise<{ list: RoutingCandidate[]; emails: Map<number, string> }> {
  if (candCache && Date.now() - candCache.at < CACHE_MS) return candCache;
  const list = await loadCandidatesFromDb();
  const emails = new Map(list.filter((c) => c.email).map((c) => [c.id, String(c.email)]));
  candCache = { at: Date.now(), list, emails };
  return candCache;
}

/**
 * Pessoas ativas com papel, overrides e cidades (centro de custos + cidades
 * dadas — as mesmas regras de server/cityAccess.ts, em lote). Quem não tem
 * centro de custos válido não abre a app por cidade → só recebe as pessoais
 * (exceto o super_admin, que vê sempre tudo).
 */
export async function loadCandidatesFromDb(): Promise<RoutingCandidate[]> {
  const { getDb, moduleOverridesFromRows, toPermissionRow } = await import("./db");
  const db = await getDb();
  if (!db) return [];
  const { applyCityPermissions, resolveCityAccess } = await import("./cityAccess");
  const { lisbonToday } = await import("../shared/expensePeriods");
  const today = lisbonToday();
  const users = rowsOf(await db.execute(sql`SELECT id, role, email, notificationPrefs FROM users WHERE isActive = 1`));
  if (!users.length) return [];
  let perms: any[] = [];
  try {
    perms = rowsOf(await db.execute(sql`SELECT userId, permission, mode, scope, actions, expiresOn FROM user_permissions`));
  } catch { /* tabela ainda não existe → sem overrides */ }
  const people = rowsOf(await db.execute(sql`
    SELECT e.userId AS userId, e.id AS employeeId, e.projectId AS projectId FROM employees e WHERE e.userId IS NOT NULL
    UNION
    SELECT ea.userId AS userId, e.id AS employeeId, e.projectId AS projectId FROM employee_accounts ea JOIN employees e ON e.id = ea.employeeId`));
  const nodes = rowsOf(await db.execute(sql`SELECT id, name, level, parentId FROM projects`))
    .map((p) => ({ id: Number(p.id), name: String(p.name ?? ""), level: String(p.level ?? ""), parentId: p.parentId == null ? null : Number(p.parentId) }));

  const permsBy = new Map<number, any[]>();
  for (const p of perms) { const k = Number(p.userId); if (!permsBy.has(k)) permsBy.set(k, []); permsBy.get(k)!.push(p); }
  const peopleBy = new Map<number, Map<number, number | null>>();
  for (const p of people) {
    const k = Number(p.userId);
    if (!peopleBy.has(k)) peopleBy.set(k, new Map());
    peopleBy.get(k)!.set(Number(p.employeeId), p.projectId == null ? null : Number(p.projectId));
  }
  const { parseJsonValue } = await import("./appSettings");

  const out: RoutingCandidate[] = [];
  for (const u of users) {
    const id = Number(u.id);
    const role = String(u.role ?? "user");
    const rows = (permsBy.get(id) ?? []).map(toPermissionRow);
    const accessOverrides = moduleOverridesFromRows(rows, today);
    const permOverrides: Record<string, string> = {};
    for (const r of rows) {
      if (r.permission.startsWith("module.")) continue;
      if (r.expiresOn && r.expiresOn < today) continue;
      permOverrides[r.permission] = r.mode;
    }
    const mine = peopleBy.get(id);
    const projectId = mine && mine.size === 1 ? Array.from(mine.values())[0] : null;
    const base = applyCityPermissions(resolveCityAccess(projectId, nodes as any), nodes as any, permOverrides);
    // Sem centro de custos (e não super_admin): não abre a app por cidade →
    // só recebe o que é dela (tarefas, documentos, formação…).
    const personalOnly = base.missingCostCenter && role !== "super_admin";
    const cities: RoutingCandidate["cities"] = personalOnly ? [] : base.all || role === "super_admin"
      ? "all"
      : Array.from(new Set((base.cityNames ?? (base.cityName ? [base.cityName] : [])).map(notifyCityOf).filter((c): c is NotifyCity => !!c)));
    out.push({
      id, role, isActive: true,
      email: u.email ? String(u.email).trim().toLowerCase() : null,
      accessOverrides,
      cities,
      prefs: parseNotificationPrefs(parseJsonValue(u.notificationPrefs ?? null)),
      ...(personalOnly ? { personalOnly: true } : {}),
    });
  }
  return out;
}

async function loadRoutingFromSettings(): Promise<NotificationRouting> {
  try {
    const { getSetting } = await import("./appSettings");
    return parseRouting(await getSetting("notifications.routing"));
  } catch {
    return parseRouting(null);
  }
}

let treesCache: { at: number; trees: Awaited<ReturnType<typeof import("./aiOps/cities").loadCityTrees>> } | null = null;
async function cityOfProjectDb(projectId: number): Promise<NotifyCity | null> {
  const { loadCityTrees, cityOfProject } = await import("./aiOps/cities");
  if (!treesCache || Date.now() - treesCache.at > 5 * 60_000) treesCache = { at: Date.now(), trees: await loadCityTrees() };
  const t = cityOfProject(projectId, treesCache.trees);
  return t ? (t.city as NotifyCity) : null;
}

const dbDeps: NotifyDeps = {
  loadCandidates: async () => (await loadCandidatesCached()).list,
  loadRouting: loadRoutingFromSettings,
  cityOfProject: cityOfProjectDb,
  async projectOfEmployee(employeeId) {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return null;
    const rows = rowsOf(await db.execute(sql`SELECT projectId FROM employees WHERE id = ${employeeId} LIMIT 1`));
    return rows[0]?.projectId == null ? null : Number(rows[0].projectId);
  },
  async recentRecipients(kind, entityKey, userIds, minutes) {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db || !userIds.length) return new Set();
    const rows = rowsOf(await db.execute(sql`
      SELECT DISTINCT userId FROM app_notifications
       WHERE kind = ${kind} AND entityKey = ${entityKey}
         AND createdAt >= DATE_SUB(NOW(), INTERVAL ${Math.max(1, Math.floor(minutes))} MINUTE)
         AND userId IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`));
    return new Set(rows.map((r) => Number(r.userId)));
  },
  async insert(rows) {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db || !rows.length) return;
    await db.insert(appNotifications).values(rows.map((r) => ({
      userId: r.userId, title: r.title, body: r.body, kind: r.kind.slice(0, 32), link: r.link, cityKey: r.cityKey, entityKey: r.entityKey,
    })));
  },
  emailOf: (userId) => candCache?.emails.get(userId) ?? null,
  async sendEmail(to, subject, text, html) {
    const { sendEmail } = await import("./_core/notification");
    return sendEmail({ to, subject, text, html, fromName: "Dashboard Multipark" });
  },
};

/** Envia uma notificação pelas regras de roteamento. Nunca lança. */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  return notifyWith(dbDeps, input);
}

// ─── Sino: leitura e "lidas" (a pessoa só mexe nas SUAS) ────────────────────

export async function listNotifications(userId: number, opts: { unreadOnly?: boolean; limit?: number; kind?: string | null } = {}) {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return [];
  const conds = [eq(appNotifications.userId, userId)];
  if (opts.unreadOnly) conds.push(eq(appNotifications.isRead, 0));
  if (opts.kind) conds.push(inArray(appNotifications.kind, kindFilterValues(opts.kind)));
  return db.select().from(appNotifications).where(and(...conds))
    .orderBy(desc(appNotifications.createdAt), desc(appNotifications.id)).limit(Math.max(1, Math.min(200, opts.limit ?? 50)));
}

export async function unreadCount(userId: number): Promise<number> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db.select({ n: sql<number>`COUNT(*)` }).from(appNotifications)
    .where(and(eq(appNotifications.userId, userId), eq(appNotifications.isRead, 0)));
  return Number(row?.n ?? 0);
}

export async function markNotificationRead(userId: number, id: number): Promise<void> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return;
  await db.update(appNotifications).set({ isRead: 1 }).where(and(eq(appNotifications.id, id), eq(appNotifications.userId, userId)));
}

export async function markAllNotificationsRead(userId: number): Promise<void> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return;
  await db.update(appNotifications).set({ isRead: 1 }).where(and(eq(appNotifications.userId, userId), eq(appNotifications.isRead, 0)));
}

/** Tipos que a pessoa pode receber (para o Perfil e para o filtro do sino). */
export async function receivableKinds(userId: number): Promise<string[]> {
  const [{ list }, routing] = await Promise.all([loadCandidatesCached(), loadRoutingFromSettings()]);
  const me = list.find((c) => c.id === userId);
  if (!me) return [];
  const { NOTIFICATION_KIND_IDS } = await import("../shared/notificationRouting");
  return NOTIFICATION_KIND_IDS.filter((k) => canReceiveKind(me, k, routing));
}

