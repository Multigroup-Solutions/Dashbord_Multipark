import { TRPCError } from "@trpc/server";
import { projectScope, bookingHistoryScope, scopedProjectIds, assertEmployeeAccess, assertProjectAccess, requireGlobalCityAccess, cityScope as cityScopeStore } from './cityScope';
import {
  INCIDENT_SEVERITIES, INCIDENT_STATUSES, INCIDENT_TYPES, LOST_ITEM_TYPES, LOST_PRIORITIES, LOST_STATUSES,
  caseDueToUtc, contentTypeForFilename, incidentStatusPatch, lostStatusPatch, safeExt, textToSafeHtml, utcNowStr,
} from "../shared/caseRules";
import { trainingRouter } from './trainingRouter';
import { tasksRouter } from './tasksRouter';
import { settingsRouter } from './settingsRouter';
import { evaluationRouter } from './evaluationRouter';
import { assistantRouter } from './assistant/router';
import { aiOpsRouter } from './aiOps/router';
import { z } from "zod";
import { ACCESS_DENIED_MSG, COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { requireAccess, canAccess, isOwnOnly, employeeBelowCondition, withOverrides } from "./_core/access";
import { MODULE_IDS, can, scopeFor, canManageUserRole, canGrantPermissionsTo, canTouchPermission, assignableRoles, isNationalRole, seesBeyondOwn, type ModuleId } from "../shared/access";
import { normalizeEmail } from "@shared/email";
import { USER_ROLES, superAdminGuard, inviteCompletionError, linkRoleGuard } from "./userAdminRules";
import { guardedAccountChange } from "./superAdminLock";
import {
  USER_DIRECTORY_CITY,
  USER_DIRECTORY_EMPLOYEE,
  USER_DIRECTORY_LAST_LOGIN,
  USER_DIRECTORY_MAX_LIMIT,
  USER_DIRECTORY_SORT,
  USER_DIRECTORY_STATUS,
  searchUserDirectory,
  userDirectorySummary,
} from "./usersDirectory";
import { storagePut } from "./storage";
import { CLOTHING_MAX_ITEMS, CLOTHING_MAX_QTY, CLOTHING_SIZES, CLOTHING_TYPES, normalizeClothingItems } from "../shared/clothing";
import { DEACTIVATION_NOTES_MAX, DEACTIVATION_REASON_CODES, DEACTIVATION_REASON_OTHER_MAX } from "../shared/deactivationReasons";
import { isIsoDay, lisbonToday } from "../shared/expensePeriods";
import { HANDOVER_CITIES, maxHandoverDate } from "../shared/shiftHandover";
import { MATERIAL_EXCEPTIONS, OPEN_ITEM_KINDS, OPEN_ITEMS_MAX } from "../shared/shiftHandoverAuto";

// Pendente da passagem de turno (carry-over) — validado antes de gravar.
const openItemSchema = z.object({
  key: z.string().min(1).max(160),
  kind: z.enum(OPEN_ITEM_KINDS),
  refId: z.union([z.number(), z.string().max(128)]).nullable().optional(),
  text: z.string().min(1).max(300),
  resolved: z.boolean(),
  resolvedAt: z.string().max(40).nullable().optional(),
  resolvedByName: z.string().max(255).nullable().optional(),
  since: z.string().max(40).nullable().optional(),
});
import { getBillingData, getAnnualBreakdown } from "./finance/compat";
import { canViewEmployee } from "./rhAccess";
import { getExtraDocsStatus } from "./rhService";
import { googleAdsRouter } from "./integrations/googleAds/router";
import { metaAdsRouter } from "./integrations/meta/router";
import { googleBusinessRouter } from "./integrations/googleBusiness/router";
import { integrationsHubRouter } from "./integrations/hubRouter";
import { mailRouter, googleAccountRouter } from "./mail/router";
import { googleCalendarRouter } from "./google/router";
import { googleDriveRouter } from "./google/driveRouter";
import { contactsRouter } from "./contactsRouter";
import { bookingFileRouter } from "./bookingFileRouter";
import { cashCheckRouter } from "./cashCheckRouter";
import { searchRouter } from "./globalSearchRouter";
import { knowledgeRouter } from "./knowledge/router";
import { webAnalyticsRouter } from "./webAnalytics/router";
import { matchKey } from "../shared/textKey";
import { gbpRouter } from "./integrations/googleBusiness/profileRouter";
import { whatsappCallsRouter } from "./whatsappCallsRouter";
import {
  getExtrasDiaForecast,
  listAssignments,
  upsertAssignment,
  listDriverCandidates,
  getBookingsInSlot,
} from "./extrasDia";
import {
  sendWeeklyAvailabilityRequest,
  getMyWeek,
  setMyAvailability,
  getWeekOverview,
  nextMonday,
  mondayOf,
  setEmployeeAvailability,
  isMondayIso,
  NOT_MONDAY_MESSAGE,
} from "./extrasAvailability";
import { sendBroadcast } from "./whatsappBroadcast";
import { describeLookupFailure, getTemplateMeta } from "./whatsappTemplateMeta";
import {
  listConversations,
  getConversationThread,
  markConversationRead,
  replyToConversation,
} from "./whatsappInbox";
import { upsertUser, getUserByOpenId, getAllUsers, updateUserRole, createManualUser, getUserByEmail, checkExtraDocsCompliance, processExtraDiaNoShows, updateUser, toggleUserActive, getUserById, getSuperAdmins, getProjects, getProjectById, createProject, updateProject, deleteProject, moveProject, getProjectEmployees, getEmployeeProjects, assignEmployeeToProject, removeEmployeeFromProject, getTaskById, createTask, updateTask, deleteTask, getTaskStats, getAllCategories, createCategory, seedDefaultCategories, logActivity, getActivityLogs, getEmployeeById, getEmployeeByUserId, createEmployeeDocumentsBatch, createTimeRecord, getVehicleDriverHistory, getApiKeys, createApiKey, toggleApiKey, deleteApiKey, getComplaints, getComplaintById, createComplaint, updateComplaint, archiveComplaint, getComplaintMessages, addComplaintMessage, getComplaintPhotos, addComplaintPhoto, removeComplaintPhoto, getComplaintStats, createGoogleReview, getGoogleReviews, getGoogleReviewById, updateGoogleReview, getGoogleReviewStats, searchClientHistory, createLostFoundItem, getLostFoundItems, getLostFoundItemById, updateLostFoundItem, archiveLostFoundItem, addLostFoundPhoto, getLostFoundPhotos, addLostFoundMessage, getLostFoundMessages, getBookingHistoryByBookingId, getBookingHistoryByPlate, searchBookingHistory, getBookingHistoryDriverStats, getBookingHistoryCrossReference, createIncident, getIncidents, getIncidentById, updateIncident, deleteIncident, getIncidentStats, createPerformanceEvaluation, getPerformanceEvaluations, getPartnershipAnalytics, createPartnership, getPartnerships, updatePartnership, setPartnershipMultiparkId, deletePartnership, partnershipNameExists, upsertMultiparkBooking, getMultiparkBookingStats, createInviteToken, getInviteByToken, acceptInviteToken, claimInviteToken, releaseInviteToken, countActiveSuperAdmins, getInvitesByUser, getInvitesByEmail, linkInviteToOAuthUser, getPayslipHistoryList, deletePayslipRecord, getTaskAssignees, setTaskAssignees, getOverdueTasks, getRecentlyCompletedTasks, markTaskNotified, getProjectHierarchyManagers, createDailyDriverHistory, searchBookingByRef } from "./db";
import { LEAD_STATUSES } from "../shared/extraLeadsFunnel";
import * as opsListsShared from "../shared/opsLists";
import { ROLE_HIERARCHY, requireRole, canSeeFinanceTotals, requireFinanceTotals, resolveDeactivationOrThrow } from "./routerGuards";
import { rhViewer } from "./rhGuards";
import { expensesRouter } from "./expensesRouter";
import { rhRouter } from "./rhRouter";
import { operationalRouter } from "./operationalRouter";

/** Estados dos leads de extras (inclui `replied` — "Respondeu"). */
const LEAD_STATUS_ENUM = LEAD_STATUSES;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Dia "YYYY-MM-DD" válido (mês/dia reais) — nunca colado em SQL, mas validado na mesma.
const handoverDaySchema = z.string().refine(isIsoDay, "Data inválida (AAAA-MM-DD)");

// ─── CRM: auxiliares do router `crm` ────────────────────────────────────────

const crmRule = z.object({ field: z.string().max(40), op: z.enum(["is", "is_not", "contains", "gte", "lte", "before", "after", "on", "within_days", "older_than_days", "yes", "no"]), value: z.union([z.string().max(200), z.number()]).nullable().optional() });
const crmList = (max = 60) => z.array(z.string().max(160)).max(max).optional();
const crmQueryInput = z.object({
  tab: z.enum(["clients", "pro"]).optional(),
  search: z.object({ text: z.string().max(200), field: z.enum(["all", "name", "email", "phone", "plate", "nif", "number", "booking", "carColor", "carModel", "tags"]) }).nullable().optional(),
  groups: z.object({
    segment: z.array(z.enum(["new", "recurring", "vip", "at_risk", "partner"])).optional(),
    city: crmList(), region: crmList(), country: crmList(), park: crmList(200), clientCountry: crmList(), channel: crmList(), partner: crmList(200),
    kind: z.array(z.enum(["pro", "private"])).optional(),
    alerts: z.array(z.enum(["noEmail", "genericEmail", "duplicate"])).optional(),
  }).optional(),
  rules: z.object({ match: z.enum(["all", "any"]), items: z.array(crmRule).max(20) }).nullable().optional(),
  sort: z.enum(["lastVisit", "firstVisit", "bookings", "totalSpent", "name", "number", "nextCheckIn"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

async function crmDb() {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
  return db;
}

/** Juntar/separar fichas (plano do CRM): backoffice, admin, super admin. */
function canMergeCrm(user: { role: string }): boolean {
  return ["backoffice", "admin", "super_admin"].includes(user.role);
}

/** Fichas fora da cidade do utilizador não se editam (nem se revela que existem). Regra: server/crm/scope.ts. */
async function crmAssertInScope(...clientIds: number[]): Promise<void> {
  const { visibleClientIds } = await import("./crm/scope");
  const ok = await visibleClientIds(await crmDb(), clientIds);
  if (clientIds.some((id) => !ok.has(id))) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente não encontrado" });
}

/** Linha única de um SELECT (ou undefined). */
async function crmRow(q: import("drizzle-orm").SQL): Promise<any> {
  const r: any = await (await crmDb()).execute(q);
  return (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r)?.[0];
}

/** Admins de cidade não mexem nos nós estruturais (Grupo/Cidade): só no que
 * está dentro das suas cidades. Global mantém tudo. */
function assertStructuralNodeEditable(node: { level: string }) {
  if (scopedProjectIds() !== undefined && (node.level === "group" || node.level === "city")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Só quem tem acesso a todas as cidades pode alterar grupos e cidades." });
  }
}

// ─── CASOS PRÓPRIOS (alcance "own" de extra/condutor) ─────────────────────────
type OwnCaseKind = "complaint" | "review" | "incident" | "lost_found";
/**
 * Ids dos casos em que o utilizador é o condutor envolvido: reclamações
 * (condutores ligados), críticas (via a reclamação em que foram convertidas),
 * ocorrências (condutor da ocorrência) e perdidos (condutores ligados).
 * Sem ficha → nenhum.
 */
async function ownCaseIds(userId: number, kind: OwnCaseKind): Promise<Set<number>> {
  const me = await getEmployeeByUserId(userId);
  const emp = me?.employee?.id;
  if (emp == null) return new Set();
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return new Set();
  const q = kind === "complaint"
    ? sql`SELECT DISTINCT complaintId AS id FROM complaint_drivers_on_duty WHERE employeeId = ${emp}`
    : kind === "review"
      ? sql`SELECT DISTINCT r.id AS id FROM google_reviews r JOIN complaint_drivers_on_duty d ON d.complaintId = r.complaintId WHERE d.employeeId = ${emp}`
      : kind === "incident"
        ? sql`SELECT id FROM incidents WHERE employeeId = ${emp}`
        : sql`SELECT DISTINCT itemId AS id FROM lost_found_attached_drivers WHERE employeeId = ${emp}`;
  const [rows] = await db.execute(q) as any;
  return new Set(((rows as any[]) ?? []).map(r => Number(r.id)));
}
/** Alcance "own": só passa se o caso é do próprio. */
async function assertOwnCase(user: { id: number; role: string }, module: ModuleId, kind: OwnCaseKind, id: number) {
  if (!isOwnOnly(user, module)) return;
  if (!(await ownCaseIds(user.id, kind)).has(id)) throw new TRPCError({ code: "FORBIDDEN", message: "Só podes ver os casos em que estás envolvido." });
}
/** Alcance "own": filtra a lista pelos casos do próprio. */
async function filterOwnCases<T extends { id: number }>(user: { id: number; role: string }, module: ModuleId, kind: OwnCaseKind, rows: T[]): Promise<T[]> {
  if (!isOwnOnly(user, module)) return rows;
  const ids = await ownCaseIds(user.id, kind);
  return rows.filter(r => ids.has(r.id));
}

// ─── EQUIPA: fichas abaixo de quem vê, na sua cidade (alcance "below_city") ──
/** Semana da disponibilidade: dia ISO e segunda-feira (senão as linhas ficavam numa "semana" que ninguém lê). */
const weekStartSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isMondayIso, NOT_MONDAY_MESSAGE);

/** Que euros do Extras Dia esta conta vê (shared/extrasCostView.ts). */
async function extrasCostViewFor(user: { id: number; role: string }) {
  const { extrasCostView } = await import("../shared/extrasCostView");
  const { withOverrides } = await import("./_core/access");
  return extrasCostView(withOverrides(user as any), { financeTotals: await canSeeFinanceTotals(user) });
}

async function belowEmployeeIds(user: { id: number; role: string }): Promise<Set<number>> {
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return new Set();
  const [rows] = await db.execute(sql`SELECT e.id FROM employees e
    WHERE ${projectScope(sql`e.projectId`)} AND ${await employeeBelowCondition(user, sql`e.id`)}`) as any;
  return new Set(((rows as any[]) ?? []).map(r => Number(r.id)));
}
/** Alcance "below_city": só as linhas de fichas da equipa (+ a própria). */
async function filterBelowEmployees<T extends { employeeId: number | null }>(user: { id: number; role: string }, module: ModuleId, rows: T[]): Promise<T[]> {
  if (scopeFor(user, module) !== "below_city") return rows;
  const ids = await belowEmployeeIds(user);
  const me = (await getEmployeeByUserId(user.id))?.employee?.id;
  if (me != null) ids.add(me);
  return rows.filter(r => r.employeeId != null && ids.has(r.employeeId));
}

// ─── UTILIZADORES: quem gere quem (shared/access.ts) ──────────────────────────
/** A conta está no âmbito de cidade do pedido (ficha numa cidade autorizada)? */
async function userInCityScope(userId: number): Promise<boolean> {
  if (scopedProjectIds() === undefined) return true;
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const { userScope } = await import("./cityScope");
  const db = await getDb();
  if (!db) return false;
  const [rows] = await db.execute(sql`SELECT 1 AS ok FROM users u WHERE u.id = ${userId} AND ${userScope(sql`u.id`)} LIMIT 1`) as any;
  return Array.isArray(rows) && rows.length > 0;
}
/**
 * Pode gerir esta conta (editar, ativar, convidar, mudar papel)? Papel da
 * conta dentro do que o ator pode atribuir e, para papéis de cidade, a conta
 * na sua cidade. `newRole` (se vier) também tem de ser atribuível.
 */
async function assertCanManageUser(actor: { id: number; role: string }, targetId: number, newRole?: string) {
  requireAccess(actor, "utilizadores", "manage");
  const target = await getUserById(targetId);
  if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Utilizador não encontrado" });
  if (!canManageUserRole(actor, target.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Não podes gerir contas com este papel." });
  }
  if (newRole !== undefined && !(assignableRoles(actor) as string[]).includes(newRole)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Não podes atribuir este papel." });
  }
  if (!(await userInCityScope(targetId))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Esta conta não pertence à tua cidade." });
  }
  return target;
}

// ─── APP ROUTER ───────────────────────────────────────────────────────────────

// Migration runner one-shot (importado dentro do mutation para não puxar
// drizzle/mysql2 no top-level se a função getDb não estiver disponível)
async function applyMigration0044(): Promise<{ ok: number; skipped: number; failed: number; errors: string[] }> {
  const { getDb } = await import("./db");
  const { MIGRATION_0044_STATEMENTS, IDEMPOTENT_ERROR_CODES } = await import("./migrations/migration_0044");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const stmt of MIGRATION_0044_STATEMENTS) {
    try {
      await db.execute(sql.raw(stmt));
      ok += 1;
    } catch (err: any) {
      if (err?.code && IDEMPOTENT_ERROR_CODES.has(err.code)) {
        skipped += 1;
      } else {
        failed += 1;
        errors.push(`${err?.code ?? "ERR"}: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
  }
  return { ok, skipped, failed, errors };
}

async function applyMigration0046(): Promise<{ ok: number; skipped: number; failed: number; errors: string[] }> {
  const { getDb } = await import("./db");
  const { MIGRATION_0046_STATEMENTS, IDEMPOTENT_ERROR_CODES_0046 } = await import("./migrations/migration_0046");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const stmt of MIGRATION_0046_STATEMENTS) {
    try {
      await db.execute(sql.raw(stmt));
      ok += 1;
    } catch (err: any) {
      if (err?.code && IDEMPOTENT_ERROR_CODES_0046.has(err.code)) {
        skipped += 1;
      } else {
        failed += 1;
        errors.push(`${err?.code ?? "ERR"}: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
  }
  return { ok, skipped, failed, errors };
}

async function applyMigration0049(): Promise<{ ok: number; skipped: number; failed: number; errors: string[] }> {
  const { getDb } = await import("./db");
  const { MIGRATION_0049_STATEMENTS, IDEMPOTENT_ERROR_CODES_0049 } = await import("./migrations/migration_0049");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const stmt of MIGRATION_0049_STATEMENTS) {
    try {
      await db.execute(sql.raw(stmt));
      ok += 1;
    } catch (err: any) {
      if (err?.code && IDEMPOTENT_ERROR_CODES_0049.has(err.code)) {
        skipped += 1;
      } else {
        failed += 1;
        errors.push(`${err?.code ?? "ERR"}: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
  }
  return { ok, skipped, failed, errors };
}

async function applyMigration0050(): Promise<{ ok: number; skipped: number; failed: number; errors: string[] }> {
  const { getDb } = await import("./db");
  const { MIGRATION_0050_STATEMENTS, IDEMPOTENT_ERROR_CODES_0050 } = await import("./migrations/migration_0050");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const stmt of MIGRATION_0050_STATEMENTS) {
    try {
      await db.execute(sql.raw(stmt));
      ok += 1;
    } catch (err: any) {
      if (err?.code && IDEMPOTENT_ERROR_CODES_0050.has(err.code)) {
        skipped += 1;
      } else {
        failed += 1;
        errors.push(`${err?.code ?? "ERR"}: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
  }
  return { ok, skipped, failed, errors };
}

async function applyMigration0051(): Promise<{ ok: number; skipped: number; failed: number; errors: string[] }> {
  const { getDb } = await import("./db");
  const { MIGRATION_0051_STATEMENTS, IDEMPOTENT_ERROR_CODES_0051 } = await import("./migrations/migration_0051");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const stmt of MIGRATION_0051_STATEMENTS) {
    try {
      await db.execute(sql.raw(stmt));
      ok += 1;
    } catch (err: any) {
      if (err?.code && IDEMPOTENT_ERROR_CODES_0051.has(err.code)) {
        skipped += 1;
      } else {
        failed += 1;
        errors.push(`${err?.code ?? "ERR"}: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
  }
  return { ok, skipped, failed, errors };
}

// ─── Ocorrências / Perdidos: âmbito de cidade ────────────────────────────────
function hasRole(userRole: string, minRole: string): boolean {
  return (ROLE_HIERARCHY[userRole] ?? -1) >= (ROLE_HIERARCHY[minRole] ?? 0);
}

/** Módulo de cada caixa de email que se pode anexar a um caso (16b). */
const INBOUND_ALIAS_MODULE = { reclamacoes: "reclamacoes", perdidos: "perdidos", criticas: "criticas", "recursos-humanos": "leads_extras" } as const;

/** Cidade por omissão de quem está limitado a cidades (para o registo não ficar invisível). */
function defaultScopedProjectId(): number | null {
  const a = cityScopeStore.getStore();
  return a && !a.all ? a.defaultCityId ?? null : null;
}

/**
 * Cidades a que o pedido está limitado (para filtrar "Park.city" nas leituras
 * da BD Multipark). undefined = todas; [] = nenhuma. Já inclui o filtro de
 * projeto/cidade do pedido (selectedCityAccess no middleware).
 */
function scopedCityNames(): string[] | undefined {
  const a = cityScopeStore.getStore();
  if (!a || a.all) return undefined;
  return a.cityNames ?? (a.cityName ? [a.cityName] : []);
}

async function loadLostInScope(id: number) {
  const item = await getLostFoundItemById(id);
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Caso não encontrado" });
  assertProjectAccess(item.projectId);
  return item;
}

async function loadIncidentInScope(id: number) {
  const inc = await getIncidentById(id);
  if (!inc) throw new TRPCError({ code: "NOT_FOUND", message: "Ocorrência não encontrada" });
  assertProjectAccess(inc.projectId);
  return inc;
}

async function getLostDriverLink(id: number) {
  const { getDb } = await import("./db");
  const { lostFoundAttachedDrivers } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const [link] = await db.select().from(lostFoundAttachedDrivers).where(eq(lostFoundAttachedDrivers.id, id)).limit(1);
  if (!link) throw new TRPCError({ code: "NOT_FOUND", message: "Condutor não encontrado" });
  return link;
}

/**
 * A reserva (id da Multipark ou nº) pertence às cidades do utilizador? Ao vivo
 * na Multipark. "unavailable" = a Multipark não respondeu (≠ fora do âmbito — 16c).
 */
async function bookingRefInScope(ref: string): Promise<boolean | "unavailable"> {
  const cities = scopedCityNames();
  if (cities === undefined) return true;
  const { liveBookingByRef } = await import("./multiparkDb/bookingSearch");
  try { return !!(await liveBookingByRef(ref, { cities })); } catch { return "unavailable"; }
}

const dayStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const crossRefInput = z.object({ from: dayStr, to: dayStr, projectId: z.number().optional(), noProject: z.boolean().optional() });

export const appRouter = router({
  system: systemRouter,

  // ── ADMIN (one-shot migrations) ───────────────────────────────────────────
  admin: router({
    runMigration0044: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "manutencao", "manage");
      const report = await applyMigration0044();
      await logActivity({
        userId: ctx.user.id,
        action: "migration",
        entity: "schema",
        details: `0044_rh_revamp: ok=${report.ok} skipped=${report.skipped} failed=${report.failed}`,
      });
      return report;
    }),

    runMigration0046: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "manutencao", "manage");
      const report = await applyMigration0046();
      await logActivity({
        userId: ctx.user.id,
        action: "migration",
        entity: "schema",
        details: `0046_multipark_report_extra_fields: ok=${report.ok} skipped=${report.skipped} failed=${report.failed}`,
      });
      return report;
    }),

    runMigration0049: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "manutencao", "manage");
      const report = await applyMigration0049();
      await logActivity({
        userId: ctx.user.id,
        action: "migration",
        entity: "schema",
        details: `0049_inbound_emails: ok=${report.ok} skipped=${report.skipped} failed=${report.failed}`,
      });
      return report;
    }),

    runMigration0050: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "manutencao", "manage");
      const report = await applyMigration0050();
      await logActivity({
        userId: ctx.user.id,
        action: "migration",
        entity: "schema",
        details: `0050_extras_availability: ok=${report.ok} skipped=${report.skipped} failed=${report.failed}`,
      });
      return report;
    }),

    runMigration0051: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "manutencao", "manage");
      const report = await applyMigration0051();
      await logActivity({
        userId: ctx.user.id,
        action: "migration",
        entity: "schema",
        details: `0051_inbound_email_threading: ok=${report.ok} skipped=${report.skipped} failed=${report.failed}`,
      });
      return report;
    }),

    // Sincroniza já o email (Gmail → reclamações/perdidos/críticas/RH…) on-demand.
    // backoffice+ (a equipa de suporte usa o botão nas Reclamações/Recrutamento).
    // É a mesma sincronização do agendador/push (API do Gmail — não há IMAP);
    // prazo 45s < maxDuration 60s do Vercel; partial:true → carregar outra vez continua.
    runEmailInbound: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "sincronizacao", "edit");
      const { runMailSync } = await import("./mail/service");
      const r = await runMailSync({ deadlineAt: Date.now() + 45_000 });
      const result = { configured: r.configured, created: r.pipelineCreated, stored: r.stored, skipped: 0, errors: r.errors, partial: !r.done, aiTriaged: r.aiTriaged ?? 0 };
      await logActivity({
        userId: ctx.user.id,
        action: "email_sync",
        entity: "inbound_emails",
        details: `gmail: guardados=${r.stored} registos=${r.pipelineCreated} erros=${r.errors.length}${r.done ? "" : " (parcial)"}`,
      });
      return result;
    }),
  }),

  // ── AUTH ────────────────────────────────────────────────────────────────────
  auth: router({
    me: publicProcedure.query(async (opts) => {
      const u = opts.ctx.user;
      // Sessão válida mas conta sem acesso: limpa a cookie morta (senão a
      // pessoa fica a bater no 403 em cada pedido) e devolve SEMPRE a mesma
      // mensagem — a UI mostra-a tal e qual (ver ACCESS_DENIED_MSG).
      if (!u && opts.ctx.accessDenied) {
        const cookieOptions = getSessionCookieOptions(opts.ctx.req);
        opts.ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
        throw new TRPCError({ code: "FORBIDDEN", message: ACCESS_DENIED_MSG });
      }
      if (!u) return u;
      // O grant extras_dia.team_leader NÃO eleva o papel (só marca
      // elegibilidade para TL na escala): o menu/UI seguem o papel da conta.
      // Acesso efetivo: o cliente resolve can()/menu com papel + overrides de
      // módulo ativos (shared/access.ts → grantFor).
      let accessOverrides: import("../shared/access").AccessOverrides = {};
      try {
        const { getUserModuleOverrides } = await import("./db");
        accessOverrides = await getUserModuleOverrides(u.id);
      } catch { /* sem overrides: fica o papel */ }
      const uElev = { ...u, accessOverrides };
      // Se houver ficha de colaborador, devolve também o estado dos docs
      // e bloqueio. Lazy check para extras: actualiza flags se passou tempo.
      try {
        const emp = await getEmployeeByUserId(uElev.id);
        if (!emp) return { ...uElev, employee: null, docsStatus: null };
        // LEITURA apenas (antes escrevia e desbloqueava quem estava bloqueado
        // por faltas em cada refresh). A regra aplica-se no cron diário.
        let docsStatus: { blocked: boolean; warning: boolean; missingDocs: string[]; daysSinceStart: number } | null = null;
        if (emp.employee.position === "extra") {
          docsStatus = await getExtraDocsStatus(emp.employee.id);
        }
        return {
          ...uElev,
          employee: {
            id: emp.employee.id,
            fullName: emp.employee.fullName,
            position: emp.employee.position,
            photoUrl: emp.employee.photoUrl,
            loginBlocked: Boolean(emp.employee.loginBlocked),
            loginBlockedReason: emp.employee.loginBlockedReason,
          },
          docsStatus,
        };
      } catch {
        return uElev;
      }
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ── USERS ───────────────────────────────────────────────────────────────────
  users: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "utilizadores", "view");
      return getAllUsers();
    }),
    // Página Utilizadores: lista PAGINADA no servidor + resumo (pedido Jorge,
    // set 2026 — a página já não abre com todas as contas). Mesma guarda e o
    // mesmo âmbito de cidades que `list` (userScope dentro do módulo).
    search: protectedProcedure
      .input(z.object({
        search: z.string().max(100).optional().nullable(),
        role: z.enum(USER_ROLES).optional().nullable(),
        city: z.enum(USER_DIRECTORY_CITY).optional().nullable(),
        status: z.enum(USER_DIRECTORY_STATUS).optional().nullable(),
        lastLogin: z.enum(USER_DIRECTORY_LAST_LOGIN).optional().nullable(),
        employee: z.enum(USER_DIRECTORY_EMPLOYEE).optional().nullable(),
        sort: z.enum(USER_DIRECTORY_SORT).optional().nullable(),
        limit: z.number().int().min(1).max(USER_DIRECTORY_MAX_LIMIT).optional(),
        offset: z.number().int().min(0).max(1_000_000).optional(),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "utilizadores", "view");
        return searchUserDirectory(input);
      }),
    summary: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "utilizadores", "view");
      return userDirectorySummary();
    }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "utilizadores", "view");
        if (!(await userInCityScope(input.id))) throw new TRPCError({ code: "FORBIDDEN", message: "Esta conta não pertence à tua cidade." });
        return getUserById(input.id);
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1, "Nome é obrigatório"),
        email: z.string().email("Email inválido"),
        role: z.enum(USER_ROLES).default("user"),
        department: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "utilizadores", "manage");
        if (!(assignableRoles(ctx.user) as string[]).includes(input.role)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Não podes atribuir este papel." });
        }
        // Um email = uma identidade: recusa cedo em vez de criar uma 2ª conta
        // que depois compete com a primeira no login (ver server/identity.ts).
        let newUser: Awaited<ReturnType<typeof createManualUser>>;
        try {
          newUser = await createManualUser(input);
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err?.message || "Não foi possível criar o utilizador" });
        }
        await logActivity({
          userId: ctx.user.id,
          action: "create",
          entity: "user",
          entityId: newUser?.id,
          details: `Utilizador criado: ${input.name} (${input.email}) - Role: ${input.role}`,
        });
        return newUser;
      }),
    update: protectedProcedure
      .input(z.object({
        userId: z.number(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        role: z.enum(USER_ROLES).optional(),
        department: z.string().nullable().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const isSelf = ctx.user.id === input.userId;
        const isSuper = ctx.user.role === "super_admin";
        // Editar OUTRA conta: quem gere utilizadores e pode gerir o papel dela
        // (e atribuir o novo). Na própria, quem não é super_admin só muda o
        // nome (o email é a identidade: liga fichas e contas — só o
        // super_admin o altera; o próprio papel nunca se muda a si mesmo).
        const canManageOther = !isSelf;
        if (canManageOther) await assertCanManageUser(ctx.user, input.userId, input.role);
        const { userId, ...data } = input;
        const target = await getUserById(userId);
        if (!target && (isSelf || data.email !== undefined || data.role !== undefined)) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Utilizador não encontrado" });
        }
        const emailChanged = data.email !== undefined && normalizeEmail(data.email) !== normalizeEmail(target?.email);
        if (emailChanged && !isSuper) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Só o super_admin pode alterar o email de uma conta." });
        }
        if (emailChanged) {
          const clash = await getUserByEmail(data.email!);
          if (clash && clash.id !== userId) {
            throw new TRPCError({ code: "CONFLICT", message: `Já existe outra conta com o email ${normalizeEmail(data.email)} (#${clash.id}).` });
          }
        }
        const safeData: { name?: string; email?: string; role?: string; department?: string | null } = isSuper
          ? { ...data, email: emailChanged ? data.email : undefined }
          : canManageOther ? { name: data.name, role: data.role, department: data.department } : { name: data.name };
        const roleChanged = safeData.role !== undefined && target != null && safeData.role !== target.role;
        if (roleChanged) {
          const guard = superAdminGuard(ctx.user.id, target!, safeData.role!, await countActiveSuperAdmins());
          if (guard) throw new TRPCError({ code: "FORBIDDEN", message: guard });
          // o papel muda dentro da tranca do último super_admin (atómico)
          const newRole = safeData.role!;
          const locked = await guardedAccountChange(userId, (t, n) => superAdminGuard(ctx.user.id, t, newRole, n), (tx) => updateUserRole(userId, newRole, tx));
          if (locked) throw new TRPCError({ code: "FORBIDDEN", message: locked });
        }
        const { role: _role, ...rest } = safeData;
        // Auto-edição nunca religa fichas por email.
        await updateUser(userId, rest, { relinkEmployees: !isSelf });
        await logActivity({
          userId: ctx.user.id,
          action: "update",
          entity: "user",
          entityId: userId,
          details: `Utilizador atualizado: ${JSON.stringify({ ...safeData, ...(roleChanged ? { role: `${target!.role} → ${safeData.role}` } : {}) })}`,
        });
        return { success: true };
      }),
    updateRole: protectedProcedure
      .input(z.object({ userId: z.number(), role: z.enum(USER_ROLES) }))
      .mutation(async ({ ctx, input }) => {
        if (input.userId === ctx.user.id && ctx.user.role !== "super_admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Não podes mudar o teu próprio papel." });
        }
        const target = await assertCanManageUser(ctx.user, input.userId, input.role);
        const previous = target.role;
        if (previous === input.role) return { success: true };
        const guard = superAdminGuard(ctx.user.id, target, input.role, await countActiveSuperAdmins());
        if (guard) throw new TRPCError({ code: "FORBIDDEN", message: guard });
        // a decisão que conta é a de dentro da tranca do último super_admin
        const locked = await guardedAccountChange(input.userId, (t, n) => superAdminGuard(ctx.user.id, t, input.role, n), (tx) => updateUserRole(input.userId, input.role, tx));
        if (locked) throw new TRPCError({ code: "FORBIDDEN", message: locked });
        await logActivity({
          userId: ctx.user.id,
          action: "update_role",
          entity: "user",
          entityId: input.userId,
          details: `Role alterado: ${previous} → ${input.role}`,
        });
        return { success: true };
      }),
    toggleActive: protectedProcedure
      .input(z.object({
        userId: z.number(),
        isActive: z.boolean(),
        // Motivo + notas: OPCIONAIS e só lidos na desativação (sem motivo =
        // `inatividade`). Vocabulário e regra em shared/deactivationReasons.ts.
        reason: z.enum(DEACTIVATION_REASON_CODES).optional(),
        reasonOther: z.string().max(DEACTIVATION_REASON_OTHER_MAX).optional(),
        notes: z.string().max(DEACTIVATION_NOTES_MAX).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (input.userId === ctx.user.id) {
          throw new Error("Não podes desativar a tua própria conta");
        }
        await assertCanManageUser(ctx.user, input.userId);
        if (!input.isActive) {
          // Nunca desativar o último super_admin ativo.
          const target = await getUserById(input.userId);
          const guard = target ? superAdminGuard(ctx.user.id, target, null, await countActiveSuperAdmins()) : null;
          if (guard) throw new TRPCError({ code: "FORBIDDEN", message: guard });
        }
        const deactivation = input.isActive ? null : resolveDeactivationOrThrow(input);
        const meta = deactivation ? { ...deactivation, byUserId: ctx.user.id } : null;
        if (input.isActive) {
          await toggleUserActive(input.userId, true, null);
        } else {
          // desativar corre dentro da tranca do último super_admin (atómico)
          const locked = await guardedAccountChange(input.userId, (t, n) => superAdminGuard(ctx.user.id, t, null, n), (tx) => toggleUserActive(input.userId, false, meta, tx));
          if (locked) throw new TRPCError({ code: "FORBIDDEN", message: locked });
        }
        await logActivity({
          userId: ctx.user.id,
          action: input.isActive ? "activate" : "deactivate",
          entity: "user",
          entityId: input.userId,
          details: deactivation
            ? `Utilizador desativado — ${deactivation.summary}`
            : "Utilizador ativado",
        });
         return { success: true };
      }),
    sendInvite: protectedProcedure
      .input(z.object({
        userId: z.number(),
        origin: z.string(), // frontend origin for building the invite link
      }))
      .mutation(async ({ ctx, input }) => {
        const targetUser = await assertCanManageUser(ctx.user, input.userId);
        if (!targetUser.email) throw new TRPCError({ code: "BAD_REQUEST", message: "Utilizador não tem email" });
        const invite = await createInviteToken({
          email: targetUser.email,
          userId: targetUser.id,
          invitedById: ctx.user.id,
        });
        const inviteLink = `${input.origin}/convite/${invite.token}`;
        await logActivity({
          userId: ctx.user.id,
          action: "create",
          entity: "invite",
          entityId: targetUser.id,
          details: `Convite enviado para ${targetUser.email}`,
        });
        return {
          success: true,
          email: targetUser.email,
          inviteLink,
          token: invite.token,
          expiresAt: invite.expiresAt,
        };
      }),
    getInvites: protectedProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "utilizadores", "view");
        if (!(await userInCityScope(input.userId))) throw new TRPCError({ code: "FORBIDDEN", message: "Esta conta não pertence à tua cidade." });
        return getInvitesByUser(input.userId);
      }),
    /** Contas cuja ficha tem posto driver/senior_driver e que ainda não são
     * condutor (nem estão acima) — para passar a Condutor de uma vez. admin+. */
    suggestCondutores: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "utilizadores", "manage");
      requireRole(ctx.user.role, "admin");
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const { userScope } = await import("./cityScope");
      const db = await getDb();
      if (!db) return [];
      const [rows] = await db.execute(sql`SELECT u.id, u.name, u.email, u.role,
          MIN(e.fullName) AS fullName, MIN(e.position) AS position, MIN(p.name) AS projectName
        FROM users u JOIN employees e ON e.userId = u.id LEFT JOIN projects p ON p.id = e.projectId
        WHERE u.isActive = 1 AND e.isActive = 1 AND e.position IN ('driver', 'senior_driver')
          AND u.role IN ('user', 'extra') AND ${userScope(sql`u.id`)}
        GROUP BY u.id, u.name, u.email, u.role
        ORDER BY MIN(e.fullName) LIMIT 500`) as any;
      return ((rows as any[]) ?? []).map(r => ({ id: Number(r.id), name: r.name ?? null, email: r.email ?? null, role: String(r.role),
        fullName: r.fullName ?? null, position: r.position ?? null, projectName: r.projectName ?? null }));
    }),
    promoteToCondutor: protectedProcedure
      .input(z.object({ userIds: z.array(z.number().int().positive()).min(1).max(500) }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "admin");
        let changed = 0;
        for (const id of [...new Set(input.userIds)]) {
          const target = await assertCanManageUser(ctx.user, id, "condutor");
          if (target.role === "condutor" || !["user", "extra"].includes(target.role)) continue;
          await updateUserRole(id, "condutor");
          await logActivity({ userId: ctx.user.id, action: "update_role", entity: "user", entityId: id, details: `Role alterado: ${target.role} → condutor (sugestão por posto)` });
          changed++;
        }
        return { changed };
      }),
    acceptInvite: publicProcedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        const invite = await getInviteByToken(input.token);
        if (!invite) return { valid: false, reason: "Token inválido" };
        if (invite.inviteStatus === "accepted") return { valid: false, reason: "Este convite já foi utilizado" };
        if (new Date() > new Date(invite.expiresAt)) return { valid: false, reason: "Este convite expirou" };
        return { valid: true, email: invite.email, userId: invite.userId };
      }),
    completeInvite: publicProcedure
      .input(z.object({ token: z.string() }))
      .mutation(async ({ ctx, input }) => {
        if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Tens de fazer login primeiro" });
        const invite = await getInviteByToken(input.token);
        // O convite só serve a quem entrou com o MESMO email (forma canónica);
        // uso único e validade respeitados.
        const inviteError = inviteCompletionError(invite, ctx.user.email);
        if (inviteError) throw new TRPCError(inviteError);
        // Reclama o convite de forma atómica ANTES de ligar (dois pedidos em
        // paralelo com o mesmo token: só um passa).
        if (!(await claimInviteToken(input.token))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Convite já utilizado" });
        }
        try {
          // Link the OAuth user to the manually-created user record
          await linkInviteToOAuthUser(
            invite!.userId,
            ctx.user.openId,
            ctx.user.name,
            ctx.user.email,
          );
        } catch (err) {
          await releaseInviteToken(input.token).catch(() => {});
          throw err;
        }
        return { success: true };
      }),
  }),
  // ── PROJECTS ────────────────────────────────────────────────────────────────
  projects: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireRole(ctx.user.role, "extra"); // extra precisa dos nomes (tarefas); user não acede
      const { loadCityAccess } = await import("./cityAccess");
      // Com o papel: um papel nacional (ex.: super_admin sem ficha) vê todos os
      // nós — igual ao permissions.myCityAccess e ao middleware.
      const access = await loadCityAccess(ctx.user.id, ctx.user.role);
      const rows = await getProjects();
      return access.all ? rows : rows.filter(p => access.projectIds.includes(p.id));
    }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "extra");
        assertProjectAccess(input.id); // só nós das cidades do utilizador
        return getProjectById(input.id);
      }),
    // Regras de nível/pai, nomes únicos por pai e soft delete: ver
    // shared/projectTree.ts (puras) e server/projectAdmin.ts (BD). Guardas de
    // cidade em server/cityScopeGuards.ts (projects.*).
    create: protectedProcedure
      .input(z.object({
        name: z.string().trim().min(1),
        description: z.string().optional(),
        parentId: z.number().optional(),
        level: z.enum(["group", "brand", "city", "project"]).default("project"),
        color: z.string().optional(),
        managerId: z.number().optional(),
        budget: z.string().optional(),
        partnerName: z.string().optional(),
        partnerPercent: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "projetos", "manage");
        const { validatePlacement, siblingNameConflict, isNodeActive } = await import("../shared/projectTree");
        const nodes = await getProjects();
        const parentId = input.parentId ?? null;
        const parent = parentId == null ? null : nodes.find(n => n.id === parentId);
        const placementError = validatePlacement(input.level, parent, parentId);
        if (placementError) throw new TRPCError({ code: "BAD_REQUEST", message: placementError });
        if (parent && !isNodeActive(parent)) throw new TRPCError({ code: "BAD_REQUEST", message: "O nó pai está inativo. Reativa-o primeiro." });
        if (siblingNameConflict(input.name, parentId, nodes)) {
          throw new TRPCError({ code: "CONFLICT", message: `Já existe um nó chamado «${input.name.trim()}» neste nível.` });
        }
        await createProject({
          name: input.name.trim(),
          description: input.description ?? null,
          parentId,
          level: input.level,
          color: input.color ?? "#6366f1",
          managerId: input.managerId ?? null,
          budget: input.budget ?? null,
          partnerName: input.partnerName ?? null,
          partnerPercent: input.partnerPercent ?? null,
        });
        await logActivity({ userId: ctx.user.id, action: "create", entity: "project", details: input.name });
        return { success: true };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().trim().min(1).optional(),
        description: z.string().optional(),
        level: z.enum(["group", "brand", "city", "project"]).optional(),
        color: z.string().optional(),
        managerId: z.number().nullable().optional(),
        budget: z.string().nullable().optional(),
        partnerName: z.string().nullable().optional(),
        partnerPercent: z.string().nullable().optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "projetos", "manage");
        const { id, level, isActive, ...data } = input;
        const { siblingNameConflict, isNodeActive, evaluateDelete } = await import("../shared/projectTree");
        const nodes = await getProjects();
        const node = nodes.find(n => n.id === id);
        if (!node) throw new TRPCError({ code: "NOT_FOUND", message: "Nó não encontrado." });
        assertStructuralNodeEditable(node);
        if (level !== undefined && level !== node.level) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "O nível não pode ser alterado depois de criado." });
        }
        if (data.name !== undefined && siblingNameConflict(data.name, node.parentId, nodes, id)) {
          throw new TRPCError({ code: "CONFLICT", message: `Já existe um nó chamado «${data.name.trim()}» neste nível.` });
        }
        const patch: Record<string, unknown> = { ...data };
        if (isActive !== undefined && isActive !== isNodeActive(node)) {
          if (isActive) {
            const parent = node.parentId == null ? null : nodes.find(n => n.id === node.parentId);
            if (node.parentId != null && (!parent || !isNodeActive(parent))) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "O nó pai está inativo ou não existe. Reativa-o ou move este nó primeiro." });
            }
          } else {
            const { countProjectReferences } = await import("./projectAdmin");
            const check = evaluateDelete({
              activeChildren: nodes.filter(n => n.parentId === id && isNodeActive(n)).length,
              totalChildren: nodes.filter(n => n.parentId === id).length,
              references: await countProjectReferences(id),
            });
            if (!check.canDeactivate) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Não é possível desativar: ${check.reasons.join("; ")}` });
          }
          patch.isActive = isActive ? 1 : 0;
        }
        await updateProject(id, patch as any);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "project", entityId: id });
        return { success: true };
      }),
    // Referências a um nó (pré-visualização antes de desativar/apagar).
    references: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "projetos", "manage");
        const { evaluateDelete, isNodeActive } = await import("../shared/projectTree");
        const { countProjectReferences } = await import("./projectAdmin");
        const nodes = await getProjects();
        const references = await countProjectReferences(input.id);
        const activeChildren = nodes.filter(n => n.parentId === input.id && isNodeActive(n)).length;
        const totalChildren = nodes.filter(n => n.parentId === input.id).length;
        return { references: references.filter(r => r.count > 0), activeChildren, totalChildren,
          ...evaluateDelete({ activeChildren, totalChildren, references }) };
      }),
    // "Eliminar" = DESATIVAR (isActive=0). O histórico continua a contar.
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "projetos", "manage");
        const { evaluateDelete, isNodeActive } = await import("../shared/projectTree");
        const { countProjectReferences } = await import("./projectAdmin");
        const nodes = await getProjects();
        const node = nodes.find(n => n.id === input.id);
        if (!node) throw new TRPCError({ code: "NOT_FOUND", message: "Nó não encontrado." });
        assertStructuralNodeEditable(node);
        const check = evaluateDelete({
          activeChildren: nodes.filter(n => n.parentId === input.id && isNodeActive(n)).length,
          totalChildren: nodes.filter(n => n.parentId === input.id).length,
          references: await countProjectReferences(input.id),
        });
        if (!check.canDeactivate) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Não é possível desativar: ${check.reasons.join("; ")}` });
        await updateProject(input.id, { isActive: 0 } as any);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "project", entityId: input.id, details: "desativado" });
        return { success: true };
      }),
    // Apagar definitivamente: só super_admin e só sem filhos e sem referências.
    hardDelete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "super_admin");
        const { evaluateDelete, isNodeActive } = await import("../shared/projectTree");
        const { countProjectReferences } = await import("./projectAdmin");
        const nodes = await getProjects();
        const node = nodes.find(n => n.id === input.id);
        if (!node) throw new TRPCError({ code: "NOT_FOUND", message: "Nó não encontrado." });
        assertStructuralNodeEditable(node);
        const references = await countProjectReferences(input.id);
        const totalChildren = nodes.filter(n => n.parentId === input.id).length;
        const check = evaluateDelete({
          activeChildren: nodes.filter(n => n.parentId === input.id && isNodeActive(n)).length,
          totalChildren,
          references,
        });
        if (!check.canHardDelete) {
          const used = references.filter(r => r.count > 0).map(r => `${r.label}: ${r.count}`);
          throw new TRPCError({ code: "PRECONDITION_FAILED",
            message: `Não é possível apagar definitivamente: ${[totalChildren ? `${totalChildren} sub-nó(s)` : null, ...used].filter(Boolean).join("; ")}. Usa "Desativar".` });
        }
        await deleteProject(input.id);
        await logActivity({ userId: ctx.user.id, action: "delete", entity: "project", entityId: input.id });
        return { success: true };
      }),
    // Move project to another parent
    move: protectedProcedure
      .input(z.object({ id: z.number(), newParentId: z.number().nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "projetos", "manage");
        const { validatePlacement, siblingNameConflict, wouldCreateCycle, isNodeActive } = await import("../shared/projectTree");
        const nodes = await getProjects();
        const node = nodes.find(n => n.id === input.id);
        if (!node) throw new TRPCError({ code: "NOT_FOUND", message: "Nó não encontrado." });
        assertStructuralNodeEditable(node);
        const parent = input.newParentId == null ? null : nodes.find(n => n.id === input.newParentId);
        const placementError = validatePlacement(node.level, parent, input.newParentId);
        if (placementError) throw new TRPCError({ code: "BAD_REQUEST", message: placementError });
        if (parent && !isNodeActive(parent)) throw new TRPCError({ code: "BAD_REQUEST", message: "O destino está inativo." });
        if (wouldCreateCycle(input.id, input.newParentId, new Map(nodes.map(n => [n.id, n])))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Não pode mover um nó para dentro de si próprio ou de um descendente." });
        }
        if (siblingNameConflict(node.name, input.newParentId, nodes, input.id)) {
          throw new TRPCError({ code: "CONFLICT", message: `Já existe um nó chamado «${node.name}» no destino.` });
        }
        await moveProject(input.id, input.newParentId);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "project", entityId: input.id, details: `moved to parent:${input.newParentId}` });
        return { success: true };
      }),
    // Cobertura PARK_CONFIGS ↔ nós de projeto + reservas sem projeto + diagnóstico
    // (órfãos, ciclos, nomes duplicados). Só admin com acesso a todas as cidades.
    parkCoverage: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "projetos", "manage");
      requireGlobalCityAccess();
      const { getParkCoverage } = await import("./projectAdmin");
      return getParkCoverage();
    }),
    createMissingParkNodes: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "projetos", "manage");
      requireGlobalCityAccess();
      const { createMissingParkNodes } = await import("./projectAdmin");
      const result = await createMissingParkNodes();
      await logActivity({ userId: ctx.user.id, action: "create", entity: "project",
        details: `nós de parque em falta: ${result.created.length} criados; reservas associadas: ${result.backfill.matched}` });
      return result;
    }),
    // Employee assignments
    getEmployees: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "projetos", "view");
        assertProjectAccess(input.projectId);
        return getProjectEmployees(input.projectId);
      }),
    assignEmployee: protectedProcedure
      .input(z.object({ projectId: z.number(), employeeId: z.number(), role: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "projetos", "manage");
        await assignEmployeeToProject({ projectId: input.projectId, employeeId: input.employeeId, role: input.role ?? "member" });
        await logActivity({ userId: ctx.user.id, action: "assign", entity: "project_employee", entityId: input.projectId, details: `emp:${input.employeeId}` });
        return { success: true };
      }),
    removeEmployee: protectedProcedure
      .input(z.object({ projectId: z.number(), employeeId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "projetos", "manage");
        await removeEmployeeFromProject(input.projectId, input.employeeId);
        return { success: true };
      }),
    // Custo realizado de cada nó vs. orçamento ANUAL — regras da Faturação
    // (server/finance/projectCosts.ts). Expõe salários: exige ver totais
    // financeiros; o alcance de cidade aplica-se no motor e na lista de nós.
    costs: protectedProcedure
      .input(z.object({ year: z.number().int().min(2000).max(2100).optional(), month: z.number().int().min(1).max(12).optional() }).optional())
      .query(async ({ ctx, input }) => {
        await requireFinanceTotals(ctx.user, "projetos", "view");
        const { projectCostsReport } = await import("./finance/projectCosts");
        return projectCostsReport({ year: input?.year, month: input?.month });
      }),
  }),

  // ── TASKS (KANBAN) ────────────────────────────────────────────────────────────
  tasks: tasksRouter,
  mail: mailRouter,
  googleAccount: googleAccountRouter,
  googleCalendar: googleCalendarRouter,
  googleDrive: googleDriveRouter,
  contacts: contactsRouter,
  // Ficha da reserva (/reserva/:id), lida ao vivo da BD Multipark.
  bookingFile: bookingFileRouter,
  cashCheck: cashCheckRouter,
  assistant: assistantRouter,
  search: searchRouter,
  knowledge: knowledgeRouter,
  settings: settingsRouter,

  // ── AVALIAÇÃO (motor único: individual + "A minha avaliação") ────────────────
  evaluation: evaluationRouter,
  aiOps: aiOpsRouter,

  // ── CATEGORIES ──────────────────────────────────────────────────────────────
  categories: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
      await seedDefaultCategories();
      return getAllCategories();
    }),
    create: protectedProcedure
      .input(z.object({ name: z.string().min(1), department: z.string().optional(), color: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "manage");
        // Flags financeiros por omissão pelo nome (como a migração 0110)
        const { defaultCategoryFlags } = await import("../shared/financeCategories");
        const f = defaultCategoryFlags(input.name);
        await createCategory({ ...input, department: input.department ?? null, color: input.color ?? "#6366f1", excludeFromMargin: f.excludeFromMargin ? 1 : 0, reverseCharge: f.reverseCharge ? 1 : 0 });
        return { success: true };
      }),
    // Flags das Finanças: "excluir da margem" (custo já contado pelo pessoal /
    // ponto — RH, TSU, extras) e autoliquidação de IVA (Google/Meta → 0%).
    setFinanceFlags: protectedProcedure
      .input(z.object({ id: z.number(), excludeFromMargin: z.boolean().optional(), reverseCharge: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "manage");
        const patch: { excludeFromMargin?: number; reverseCharge?: number } = {};
        if (input.excludeFromMargin !== undefined) patch.excludeFromMargin = input.excludeFromMargin ? 1 : 0;
        if (input.reverseCharge !== undefined) patch.reverseCharge = input.reverseCharge ? 1 : 0;
        if (Object.keys(patch).length === 0) return { success: true };
        const { getDb } = await import("./db");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível" });
        const { expenseCategories } = await import("../drizzle/schema");
        await db.update(expenseCategories).set(patch).where(eq(expenseCategories.id, input.id));
        const parts = [
          input.excludeFromMargin !== undefined ? `excluir da margem: ${input.excludeFromMargin ? "sim" : "não"}` : null,
          input.reverseCharge !== undefined ? `autoliquidação de IVA: ${input.reverseCharge ? "sim" : "não"}` : null,
        ].filter(Boolean).join(" · ");
        await logActivity({ userId: ctx.user.id, action: "update", entity: "expense_category", entityId: input.id, details: parts });
        return { success: true };
      }),
    // IVA da categoria (%): as Finanças tiram-no ao custo e ao IVA a deduzir.
    // null = taxa normal (23%).
    setVatRate: protectedProcedure
      .input(z.object({ id: z.number(), vatRate: z.number().min(0).max(100).nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "manage");
        const { getDb } = await import("./db");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível" });
        const { expenseCategories } = await import("../drizzle/schema");
        await db.update(expenseCategories)
          .set({ vatRate: input.vatRate == null ? null : input.vatRate.toFixed(2) })
          .where(eq(expenseCategories.id, input.id));
        await logActivity({ userId: ctx.user.id, action: "update", entity: "expense_category", entityId: input.id, details: `IVA da categoria: ${input.vatRate == null ? "normal (23%)" : input.vatRate + "%"}` });
        return { success: true };
      }),
  }),

  // ── EXPENSES ────────────────────────────────────────────────────────────────
  expenses: expensesRouter,

  // ── LOGSS ───────────────────────────────────────────────────────────────────────────────────
  logs: router({
    list: protectedProcedure
      .input(z.object({
        limit: z.number().int().min(1).max(2000).optional(),
        entity: z.string().optional(),
        action: z.string().optional(),
        userId: z.number().optional(),
        // Dias de Lisboa (YYYY-MM-DD), inclusivos; convertidos para UTC.
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        search: z.string().max(200).optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "logs", "view");
        const { lisbonDayRangeUtc } = await import("../shared/lisbonDay");
        return getActivityLogs(input?.limit ?? 500, {
          entity: input?.entity,
          action: input?.action,
          userId: input?.userId,
          from: input?.from ? lisbonDayRangeUtc(input.from).start : undefined,
          to: input?.to ? lisbonDayRangeUtc(input.to).end : undefined,
          search: input?.search,
        });
      }),
    entities: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "logs", "view");
      const { getActivityLogEntities } = await import("./db");
      return getActivityLogEntities();
    }),
  }),

  // ── RH ───────────────────────────────────────────────────────────────────────────────────────
  // ─── PERMISSÕES POR UTILIZADOR ─────────────────────────────────────────────
  permissions: router({
    // Catálogo (shared/permissions.ts) — qualquer utilizador autenticado
    catalog: protectedProcedure.query(async () => {
      const { PERMISSIONS } = await import("../shared/permissions");
      return PERMISSIONS;
    }),

    // Overrides do próprio (para a UI esconder o que não deve mostrar)
    mine: protectedProcedure.query(async ({ ctx }) => {
      const { getUserPermissionOverrides } = await import("./db");
      return getUserPermissionOverrides(ctx.user.id);
    }),

    // Todas as atribuições (página Sistema → Permissões)
    assignments: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "permissoes", "view");
      const { listPermissionAssignments } = await import("./db");
      const rows = await listPermissionAssignments();
      // Admin limitado a cidades: só vê as atribuições de quem é das suas
      // cidades, e só pode remover as de quem gere por completo (mesma regra
      // do guarda de permissions.setForUser em cityScopeGuards.ts).
      const allowed = scopedProjectIds();
      // Papel de cada conta: só gere quem o modelo deixa (canGrantPermissionsTo)
      // e só as permissões que ele próprio pode dar (canTouchPermission).
      const roleById = new Map<number, string>();
      for (const userId of new Set(rows.map((r) => r.userId))) roleById.set(userId, (await getUserById(userId))?.role ?? "user");
      const manageable = (r: { userId: number; permission: string }) =>
        canGrantPermissionsTo(ctx.user, roleById.get(r.userId)) && canTouchPermission(ctx.user, r.permission);
      if (allowed === undefined) return rows.map((r) => ({ ...r, canManage: manageable(r) }));
      const { loadCityAccess } = await import("./cityAccess");
      const verdict = new Map<number, { visible: boolean; canManage: boolean }>();
      for (const userId of new Set(rows.map((r) => r.userId))) {
        try {
          const target = await loadCityAccess(userId, roleById.get(userId));
          const visible = !target.all && target.projectIds.some((pid) => allowed.includes(pid));
          const canManage = visible && !target.missingCostCenter && target.projectIds.every((pid) => allowed.includes(pid));
          verdict.set(userId, { visible, canManage });
        } catch {
          verdict.set(userId, { visible: false, canManage: false });
        }
      }
      return rows
        .filter((r) => verdict.get(r.userId)?.visible)
        .map((r) => ({ ...r, canManage: (verdict.get(r.userId)?.canManage ?? false) && manageable(r) }));
    }),

    forUser: protectedProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "permissoes", "view");
        const target = await getUserById(input.userId);
        if (!target || !canGrantPermissionsTo(ctx.user, target.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes gerir as permissões desta conta." });
        if (!(await userInCityScope(input.userId))) throw new TRPCError({ code: "FORBIDDEN", message: "Esta conta não pertence à tua cidade." });
        const { getUserPermissionOverrides } = await import("./db");
        return getUserPermissionOverrides(input.userId);
      }),

    setForUser: protectedProcedure
      .input(z.object({
        userId: z.number(),
        permission: z.string().min(1).max(64),
        mode: z.enum(["grant", "deny"]).nullable(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "permissoes", "manage");
        const { PERMISSION_IDS } = await import("../shared/permissions");
        if (!PERMISSION_IDS.includes(input.permission as any)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Permissão desconhecida." });
        }
        if (input.userId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes alterar as tuas próprias permissões." });
        const target = await getUserById(input.userId);
        if (!target || !canGrantPermissionsTo(ctx.user, target.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes gerir as permissões desta conta." });
        if (!(await userInCityScope(input.userId))) throw new TRPCError({ code: "FORBIDDEN", message: "Esta conta não pertence à tua cidade." });
        if (!canTouchPermission(ctx.user, input.permission)) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes dar nem retirar esta permissão." });
        const { setUserPermission } = await import("./db");
        await setUserPermission(input.userId, input.permission, input.mode, ctx.user.id);
        await logActivity({ userId: ctx.user.id, action: "set_permission", entity: "user", entityId: input.userId, details: `${input.permission} = ${input.mode ?? "(limpo)"}` });
        return { success: true };
      }),

    // ── Overrides de MÓDULO por utilizador (pedido do dono, 24 set 2026) ──────
    // Contas a quem se pode dar acessos (no âmbito de cidade de quem pede).
    people: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "permissoes", "view");
      const { listActiveUsersInScope } = await import("./db");
      const { overrideTargetError } = await import("../shared/accessOverrides");
      const rows = await listActiveUsersInScope();
      // A lista já vem limitada à(s) cidade(s) de quem pede (userScope).
      return rows.map((u) => ({ ...u, editError: overrideTargetError(ctx.user, { id: u.id, role: u.role, inActorCity: true }) }));
    }),

    // Grelha de uma pessoa: padrão do papel, override e acesso efetivo por módulo.
    moduleAccessForUser: protectedProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "permissoes", "view");
        const target = await getUserById(input.userId);
        if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Utilizador não encontrado" });
        const inCity = await userInCityScope(input.userId);
        if (!inCity) throw new TRPCError({ code: "FORBIDDEN", message: "Esta conta não pertence à tua cidade." });
        const { listModuleOverridesForUser } = await import("./db");
        const { MODULES, grantFor, normalizeGrant, overrideActive, roleGrantFor } = await import("../shared/access");
        const { overrideChangeError, overrideTargetError } = await import("../shared/accessOverrides");
        const records = await listModuleOverridesForUser(input.userId);
        const byModule = new Map(records.map((r) => [r.module, r]));
        const today = lisbonToday();
        const targetRef = { id: target.id, role: target.role, inActorCity: inCity };
        return {
          user: { id: target.id, name: target.name, email: target.email, role: target.role },
          editError: overrideTargetError(ctx.user, targetRef),
          rows: MODULES.map((m) => {
            const rec = byModule.get(m.id) ?? null;
            const active = !!rec && overrideActive(rec.override, today);
            const roleDefault = roleGrantFor(target.role, m.id);
            return {
              module: m.id, label: m.label, group: m.group,
              roleDefault,
              override: rec ? { ...rec.override, note: rec.note, grantedByName: rec.grantedByName, updatedAt: rec.updatedAt ?? rec.createdAt, expired: !active } : null,
              effective: active ? normalizeGrant(rec!.override) : roleDefault,
              // O que quem pede pode dar neste módulo (teto dos selects).
              mine: grantFor(ctx.user, m.id),
              // Revogar cabe sempre no alcance: o erro que sobra é do módulo/conta/override atual.
              lockReason: overrideChangeError(ctx.user, targetRef, m.id, { access: "none", actions: [] }, rec?.override ?? null),
            };
          }),
        };
      }),

    setModuleAccess: protectedProcedure
      .input(z.object({
        userId: z.number(),
        module: z.enum(MODULE_IDS),
        // null = repor o padrão do papel
        grant: z.object({
          access: z.enum(["none", "own", "below_city", "city", "national"]),
          actions: z.array(z.enum(["view", "edit", "export", "manage"])).max(4),
          expiresOn: z.string().nullable().optional(),
        }).nullable(),
        note: z.string().max(255).nullable().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "permissoes", "manage");
        const target = await getUserById(input.userId);
        if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Utilizador não encontrado" });
        const inCity = await userInCityScope(input.userId);
        const { getUserPermissionRows, moduleOverrideFromRow, setModuleOverride } = await import("./db");
        const { MODULES, moduleOverrideKey, normalizeGrant } = await import("../shared/access");
        const { overrideChangeError, describeGrant } = await import("../shared/accessOverrides");
        const expiresOn = input.grant?.expiresOn || null;
        if (expiresOn && (!isIsoDay(expiresOn) || expiresOn < lisbonToday())) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Data de fim inválida (tem de ser hoje ou depois)." });
        }
        const next = input.grant ? { ...normalizeGrant(input.grant), expiresOn } : null;
        const key = moduleOverrideKey(input.module);
        const existingRow = (await getUserPermissionRows(input.userId)).find((r) => r.permission === key);
        const existing = existingRow ? moduleOverrideFromRow(existingRow)?.override ?? null : null;
        const err = overrideChangeError(ctx.user, { id: target.id, role: target.role, inActorCity: inCity }, input.module, next, existing);
        if (err) throw new TRPCError({ code: "FORBIDDEN", message: err });
        const prev = await setModuleOverride(input.userId, input.module, next, ctx.user.id, input.note ?? null);
        const label = MODULES.find((m) => m.id === input.module)?.label ?? input.module;
        const until = next?.expiresOn ? ` (até ${next.expiresOn})` : "";
        await logActivity({
          userId: ctx.user.id, action: "set_module_access", entity: "user", entityId: input.userId,
          details: `${label} [${input.module}]: ${describeGrant(prev)} → ${describeGrant(next)}${until}${input.note?.trim() ? ` — ${input.note.trim()}` : ""}`,
        });
        return { success: true };
      }),

    // "Quem tem acesso a X": acesso efetivo de cada conta (papel ou override).
    whoHasAccess: protectedProcedure
      .input(z.object({ module: z.enum(MODULE_IDS) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "permissoes", "view");
        const { listUsersWithModuleOverride } = await import("./db");
        const { normalizeGrant, roleGrantFor } = await import("../shared/access");
        const rows = await listUsersWithModuleOverride(input.module);
        return rows
          .map((r) => {
            const active = !!r.override && !r.overrideExpired;
            const grant = active ? normalizeGrant(r.override!) : roleGrantFor(r.role, input.module);
            return { id: r.id, name: r.name, email: r.email, role: r.role, grant, source: active ? "override" as const : "role" as const,
              override: r.override, overrideExpired: r.overrideExpired };
          })
          .filter((r) => r.grant.access !== "none" || r.override);
      }),

    // A cidade depende exclusivamente do centro de custos, incluindo administradores.
    myCityAccess: protectedProcedure.query(async ({ ctx }) => {
      const { loadCityAccess } = await import("./cityAccess");
      return loadCityAccess(ctx.user.id, ctx.user.role);
    }),
  }),

  rh: rhRouter,

  // ─── MARKETING ────────────────────────────────────────────────────────────
  marketing: router({
    // Web & SEO (GA4, Search Console, PageSpeed) — server/webAnalytics/router.ts.
    web: webAnalyticsRouter,
    // Google Business Profile (desempenho, pesquisas, horários, publicações) — server/integrations/googleBusiness/profileRouter.ts.
    gbp: gbpRouter,
    // Fonte única (server/integrations/googleAds/adMetrics + marketingStats):
    // gasto = custo importado Google + Meta (nunca orçamento×dias), reservas
    // reais por data de criação (dias de Lisboa, sem canceladas — a regra das
    // Reservas & Operações), ROAS s/ IVA, cobertura.
    dashboard: protectedProcedure
      .input(z.object({ from: z.string().optional(), to: z.string().optional(), projectId: z.number().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "marketing", "view");
        const { getMarketingStats } = await import("./integrations/googleAds/marketingStats");
        const { lisbonToday } = await import("../shared/expensePeriods");
        const today = lisbonToday();
        const from = input?.from || `${today.slice(0, 7)}-01`;
        const to = input?.to || today;
        try {
          return await getMarketingStats({ from, to, projectId: input?.projectId });
        } catch (e: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
        }
      }),

    // Alertas (regras em shared/marketingAlerts.ts; dados em server/marketingAlertsService.ts):
    // atribuição, campanhas sem resultados (sugestão: pausar), ritmo do mês e
    // dos orçamentos, recolhas Google/Meta falhadas/paradas (vermelho).
    alerts: protectedProcedure
      .input(z.object({ projectId: z.number().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "marketing", "view");
        const { computeAlertsFor } = await import("./marketingAlertsService");
        return computeAlertsFor(input?.projectId);
      }),
    // Canais e clientes (Jorge, 24 set 2026): reservas e custo por canal de
    // aquisição + ligação ao CRM (canal de entrada de cada cliente).
    channels: protectedProcedure
      .input(z.object({ from: z.string().optional(), to: z.string().optional(), projectId: z.number().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "marketing", "view");
        const { getDb } = await import("./db");
        const { getChannels } = await import("./marketingChannels");
        const { getAdMetrics } = await import("./integrations/googleAds/adMetrics");
        const { marketingProjectIds } = await import("./marketingSql");
        const { lisbonToday } = await import("../shared/expensePeriods");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const today = lisbonToday();
        const from = input?.from || `${today.slice(0, 7)}-01`;
        const to = input?.to || today;
        // Mesmo recorte do marketing.dashboard: projeto pedido ∩ cidades do utilizador.
        const projectIds = await marketingProjectIds(input?.projectId);
        try {
          const ads = await getAdMetrics({ from, to, projectIds });
          return await getChannels(db, { from, to, projectIds, adSpend: ads.totals.cost, adConversions: ads.totals.conversions });
        } catch (e: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
        }
      }),
    // Por marca: gasto (mesma fonte e âmbito do dashboard) e reservas da marca.
    byBrand: protectedProcedure
      .input(z.object({ from: z.string().optional(), to: z.string().optional(), projectId: z.number().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "marketing", "view");
        const { getSpendAndBookingsByBrand } = await import("./integrations/googleAds/marketingStats");
        const { lisbonToday } = await import("../shared/expensePeriods");
        const today = lisbonToday();
        const from = input?.from || `${today.slice(0, 7)}-01`;
        const to = input?.to || today;
        try {
          return await getSpendAndBookingsByBrand({ from, to, projectId: input?.projectId });
        } catch (e: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
        }
      }),

    // ROAS por campanha → reservas ligadas (ID no link, utm_campaign ou código
    // de desconto ligados pelo admin) + conversões por ação.
    campaignRoas: protectedProcedure
      .input(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), projectId: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "marketing", "view");
        const { getCampaignRoas } = await import("./marketingCampaignRoas");
        return getCampaignRoas(input);
      }),

    // Ligações campanha ↔ utm_campaign / código de desconto (admin; globais).
    campaignLinks: router({
      list: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "marketing", "view");
        const { listCampaignLinks } = await import("./marketingCampaignRoas");
        return listCampaignLinks();
      }),
      add: protectedProcedure
        .input(z.object({ adCampaignId: z.number().int().positive(), keyType: z.enum(["utm_campaign", "discount_code"]), keyValue: z.string().trim().min(1).max(256) }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "marketing", "manage");
          requireGlobalCityAccess();
          const { addCampaignLink } = await import("./marketingCampaignRoas");
          await addCampaignLink({ ...input, userId: ctx.user.id });
          await logActivity({ userId: ctx.user.id, action: "create", entity: "ad_campaign_links", entityId: input.adCampaignId, details: `Ligação ${input.keyType}=${input.keyValue}` });
          return { success: true };
        }),
      remove: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "marketing", "manage");
        requireGlobalCityAccess();
        const { removeCampaignLink } = await import("./marketingCampaignRoas");
        await removeCampaignLink(input.id);
        return { success: true };
      }),
    }),

    // Orçamentos mensais por cidade/marca e ritmo (0093). Ler: backoffice
    // (âmbito de cidade); definir: admin (a guarda de cidade valida o projectId).
    budgets: router({
      list: protectedProcedure
        .input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), projectId: z.number().optional() }))
        .query(async ({ ctx, input }) => {
          requireAccess(ctx.user, "marketing", "view");
          const { listBudgetsWithPacing } = await import("./marketingBudgets");
          return listBudgetsWithPacing(input);
        }),
      upsert: protectedProcedure
        .input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), projectId: z.number().int(), provider: z.enum(["all", "google_ads", "meta"]).default("all"), amount: z.number().min(0).max(10_000_000), notes: z.string().max(255).nullable().optional() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "marketing", "manage");
          const { upsertBudget } = await import("./marketingBudgets");
          await upsertBudget({ ...input, userId: ctx.user.id });
          await logActivity({ userId: ctx.user.id, action: "update", entity: "marketing_budgets", entityId: input.projectId, details: `Orçamento ${input.month} ${input.provider}: ${input.amount} €` });
          return { success: true };
        }),
      remove: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "marketing", "manage");
        const { removeBudget } = await import("./marketingBudgets");
        await removeBudget(input.id);
        return { success: true };
      }),
      copyFromPrevious: protectedProcedure.input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "marketing", "manage");
        const { copyBudgets } = await import("./marketingBudgets");
        const [y, m] = input.month.split("-").map(Number);
        const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
        return { copied: await copyBudgets(prev, input.month, ctx.user.id) };
      }),
    }),
  }),

  // ─── OPERACIONAL ──────────────────────────────────────────────────────────
  operational: operationalRouter,

  // ─── API KEYS MANAGEMENT ──────────────────────────────────────────────────
  // ─── INTEGRAÇÕES (Google Ads) ─────────────────────────────────────────────
  integrations: router({
    googleAds: googleAdsRouter,
    meta: metaAdsRouter,
    googleBusiness: googleBusinessRouter,
    hub: integrationsHubRouter,
  }),

  apiKeys: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "api_keys", "manage");
      return getApiKeys();
    }),
    // A chave completa só sai AQUI, uma vez; na BD fica só o hash + prefixo.
    create: protectedProcedure.input(z.object({
      name: z.string().trim().min(1).max(100),
      permissions: z.array(z.enum(["read", "write", "admin", "device"])).optional(),
      expiresInDays: z.number().int().min(1).max(3650).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "api_keys", "manage");
      const { generateApiKey, hashApiKey, apiKeyPrefix } = await import("./apiKeyAuth");
      const key = generateApiKey();
      const perms = input.permissions?.length ? input.permissions : ["device"];
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString().slice(0, 19).replace("T", " ")
        : null;
      const id = await createApiKey({
        name: input.name,
        apiKey: null,
        keyHash: hashApiKey(key),
        keyPrefix: apiKeyPrefix(key),
        expiresAt,
        permissions: JSON.stringify(perms),
        active: 1,
        createdById: ctx.user.id,
      });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "api_key", entityId: id,
        details: `API Key: ${input.name} (${apiKeyPrefix(key)}…, scopes ${perms.join(",")}${expiresAt ? `, expira ${expiresAt.slice(0, 10)}` : ""})` });
      return { id, key, keyPrefix: apiKeyPrefix(key) };
    }),
    toggle: protectedProcedure.input(z.object({
      id: z.number(),
      active: z.boolean(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "api_keys", "manage");
      await toggleApiKey(input.id, input.active);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "api_key", entityId: input.id, details: input.active ? "Ativada" : "Desativada" });
      return { success: true };
    }),
    delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "api_keys", "manage");
      await deleteApiKey(input.id);
      await logActivity({ userId: ctx.user.id, action: "delete", entity: "api_key", entityId: input.id, details: "API Key eliminada" });
      return { success: true };
    }),
  }),

  // ─── RECLAMAÇÕES ────────────────────────────────────────────────────────────
  complaints: router({
    searchBooking: protectedProcedure
      .input(z.object({ search: z.string().min(2) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reclamacoes", "edit");
        return searchBookingByRef(input.search);
      }),
    list: protectedProcedure.input(z.object({
      status: z.string().optional(),
      type: z.string().optional(),
      vehicleId: z.number().optional(),
      assignedToId: z.number().optional(),
      projectId: z.number().optional(),
      /** Só as arquivadas (quem gere). Sem isto, as arquivadas nunca vêm. */
      archived: z.boolean().optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view", { allowOwn: true });
      if (input?.archived) requireAccess(ctx.user, "reclamacoes", "manage");
      return filterOwnCases(ctx.user, "reclamacoes", "complaint", await getComplaints(input ?? {}));
    }),
    getById: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view", { allowOwn: true });
      await assertOwnCase(ctx.user, "reclamacoes", "complaint", input.id);
      const complaint = await getComplaintById(input.id);
      if (!complaint) throw new TRPCError({ code: "NOT_FOUND" });
      const messages = await getComplaintMessages(input.id);
      const photos = await getComplaintPhotos(input.id);
      // Anexos não-imagem dos emails do caso (as imagens já estão em photos).
      const { listComplaintEmailAttachments } = await import("./db");
      // Leitura falhada ≠ "sem anexos" (16b).
      let emailAttachments: Awaited<ReturnType<typeof listComplaintEmailAttachments>> = [];
      let emailAttachmentsFailed = false;
      try { emailAttachments = await listComplaintEmailAttachments(input.id); } catch { emailAttachmentsFailed = true; }
      return { complaint, messages, photos, emailAttachments, emailAttachmentsFailed };
    }),
    // ── IA: sugestões da triagem (separadas dos campos humanos) ──────────
    aiSuggestions: protectedProcedure.input(z.object({ complaintId: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view", { allowOwn: true });
      await assertOwnCase(ctx.user, "reclamacoes", "complaint", input.complaintId);
      const complaint = await getComplaintById(input.complaintId); // âmbito de cidade
      if (!complaint) throw new TRPCError({ code: "NOT_FOUND" });
      const { getComplaintSuggestions } = await import("./complaintTriage");
      const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
      return {
        suggestions: await getComplaintSuggestions(input.complaintId),
        triagedAt: (complaint as any).aiTriagedAt ?? null,
        available: await aiFeatureAvailableFresh("complaint_triage"),
      };
    }),
    aiDecide: protectedProcedure.input(z.object({
      complaintId: z.number(),
      field: z.enum(["type", "priority", "sla", "booking", "duplicate", "draft"]),
      decision: z.enum(["accept", "reject"]),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "edit");
      const complaint = await getComplaintById(input.complaintId); // âmbito de cidade
      if (!complaint) throw new TRPCError({ code: "NOT_FOUND" });
      const { decideComplaintSuggestion } = await import("./complaintTriage");
      const r = await decideComplaintSuggestion(input.complaintId, input.field, input.decision, { id: ctx.user.id, name: ctx.user.name });
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error || "Não foi possível guardar a decisão." });
      await logActivity({ userId: ctx.user.id, action: input.decision === "accept" ? "ai_accept" : "ai_reject", entity: "complaint", entityId: input.complaintId, details: `Sugestão IA: ${input.field}` });
      return { success: true };
    }),
    aiRetriage: protectedProcedure.input(z.object({ complaintId: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "edit");
      const complaint = await getComplaintById(input.complaintId); // âmbito de cidade
      if (!complaint) throw new TRPCError({ code: "NOT_FOUND" });
      const { triageComplaint } = await import("./complaintTriage");
      const { AI_USER_MESSAGES } = await import("./_core/ai/errors");
      const r = await triageComplaint(input.complaintId, { force: true, userId: ctx.user.id });
      // Sem erro na UI: desligada/orçamento → mensagem calma.
      if (r.skipped === "disabled") return { ok: false, message: AI_USER_MESSAGES.disabled };
      if (!r.ok) return { ok: false, message: (AI_USER_MESSAGES as any)[String(r.error ?? "").split("_")[0]] ?? AI_USER_MESSAGES.provider };
      return { ok: true, message: r.applied.length ? `Aplicado: ${r.applied.length}; por decidir: ${r.suggested.length}.` : `Sugestões por decidir: ${r.suggested.length}.` };
    }),
    create: protectedProcedure.input(z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      type: z.enum(["damage", "dirt", "delay", "overcharge", "staff", "other"]),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      clientName: z.string().optional(),
      clientEmail: z.string().optional(),
      clientPhone: z.string().optional(),
      reservationRef: z.string().optional(),
      reservationStart: z.string().optional(),
      reservationEnd: z.string().optional(),
      vehicleId: z.number().optional(),
      vehiclePlate: z.string().optional(),
      driversInvolved: z.string().optional(),
      slaHours: z.number().optional(),
      projectId: z.number().optional(),
      assignedToId: z.number().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "edit");
      const slaDeadline = input.slaHours ? new Date(Date.now() + input.slaHours * 3600000).toISOString().slice(0, 19).replace("T", " ") : null;
      // Quem só vê a sua cidade e não escolhe o projeto: fica na cidade dele
      // (sem projeto a reclamação desaparecia-lhe da lista — 16b).
      const projectId = input.projectId ?? defaultScopedProjectId();
      const id = await createComplaint({
        title: input.title,
        description: input.description ?? null,
        complaintType: input.type,
        complaintPriority: input.priority ?? "medium",
        complaintStatus: "new",
        clientName: input.clientName ?? null,
        clientEmail: input.clientEmail ?? null,
        clientPhone: input.clientPhone ?? null,
        reservationRef: input.reservationRef ?? null,
        reservationStart: input.reservationStart ? new Date(input.reservationStart).toISOString().slice(0, 19).replace("T", " ") : null,
        reservationEnd: input.reservationEnd ? new Date(input.reservationEnd).toISOString().slice(0, 19).replace("T", " ") : null,
        vehicleId: input.vehicleId ?? null,
        vehiclePlate: input.vehiclePlate ?? null,
        driversInvolved: input.driversInvolved ?? null,
        slaDeadline,
        projectId: projectId ?? null,
        assignedToId: input.assignedToId ?? null,
        createdById: ctx.user.id,
      });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "complaint", entityId: id, details: `Reclamação: ${input.title}` });
      // Auto-liga a reserva a partir dos sinais (matrícula/email/telefone/
      // nome) — deixa de ser preciso procurar o ID da reserva à mão.
      try {
        const { autoLinkComplaintBooking } = await import("./complaintDossier");
        await autoLinkComplaintBooking(id);
      } catch (err) {
        console.warn("[complaint create] autolink failed:", err);
      }
      // Notifica admins/supervisores/TL via app
      try {
        const { notifyComplaintCreated } = await import("./complaintsExtended");
        await notifyComplaintCreated(id);
      } catch (err) {
        console.warn("[complaint create] notify failed:", err);
      }
      return { id };
    }),

    // ── Drivers em serviço (cruza com extras-dia + history) ────────────────
    findDriversOnDuty: protectedProcedure
      .input(z.object({ complaintId: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reclamacoes", "edit");
        const { findDriversOnDuty } = await import("./complaintsExtended");
        return findDriversOnDuty(input.complaintId);
      }),
    attachDriver: protectedProcedure
      .input(z.object({
        complaintId: z.number(),
        employeeId: z.number().nullable().optional(),
        employeeName: z.string().min(1).max(256),
        roleAtTime: z.string().max(64).nullable().optional(),
        source: z.enum(["assignment", "history", "manual"]),
        notes: z.string().max(512).nullable().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reclamacoes", "edit");
        const { attachDriverToComplaint } = await import("./complaintsExtended");
        await attachDriverToComplaint(input);
        return { success: true };
      }),
    listAttachedDrivers: protectedProcedure
      .input(z.object({ complaintId: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reclamacoes", "view");
        const { listComplaintDrivers } = await import("./complaintsExtended");
        return listComplaintDrivers(input.complaintId);
      }),
    // Tirar um condutor: a linha (com os pontos) vai para removed_records e
    // deixa de contar na avaliação. Nada se apaga de vez (16b).
    detachDriver: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reclamacoes", "edit");
        const { detachComplaintDriver } = await import("./complaintsExtended");
        const r = await detachComplaintDriver(input.id, ctx.user.id);
        if (!r.removed) throw new TRPCError({ code: "NOT_FOUND", message: "Este condutor já não está associado." });
        const row = r.row as any;
        await logActivity({ userId: ctx.user.id, action: "update", entity: "complaint", entityId: Number(row.complaintId), details: `Condutor retirado: ${row.employeeName}${row.penaltyPointsApplied ? ` (${row.penaltyPointsApplied} pts)` : ""}` });
        return { success: true };
      }),

    // ── Penalty config ──────────────────────────────────────────────────────
    listPenaltyConfig: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "reclamacoes", "view");
      const { listPenaltyConfig } = await import("./complaintsExtended");
      return listPenaltyConfig();
    }),
    updatePenaltyConfig: protectedProcedure
      .input(z.object({ complaintType: z.string().max(32), basePoints: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reclamacoes", "manage");
        const { updatePenaltyConfig } = await import("./complaintsExtended");
        await updatePenaltyConfig(input.complaintType, input.basePoints);
        return { success: true };
      }),

    // ── Email ao cliente ───────────────────────────────────────────────────
    sendEmailToClient: protectedProcedure
      .input(z.object({
        complaintId: z.number(),
        subject: z.string().min(1).max(255),
        body: z.string().min(1),
      }))
      .mutation(async ({ ctx, input }) => {
        // Envia email em nome da empresa — só frontoffice+ pode disparar
        requireAccess(ctx.user, "reclamacoes", "edit");
        const { sendComplaintEmailToClient } = await import("./complaintsExtended");
        const before = await getComplaintById(input.complaintId);
        const r = await sendComplaintEmailToClient(input);
        if (r.ok) {
          // Responder ao cliente → "Aguarda Cliente", só se ainda estava a ser
          // tratada (uma resolvida/fechada/convertida não muda — 16b).
          const { complaintStatusAfterEmail } = await import("../shared/caseRules");
          const next = complaintStatusAfterEmail(before?.complaintStatus);
          if (next) await updateComplaint(input.complaintId, { complaintStatus: next } as any);
          // Transcreve o email enviado como mensagem do caso (histórico da conversa).
          await addComplaintMessage({
            complaintId: input.complaintId,
            message: `📤 Email enviado ao cliente — ${r.subject ?? input.subject}\n\n${input.body}`,
            isInternal: 0,
            authorId: ctx.user.id,
            authorName: ctx.user.name ?? "Multipark",
          } as any);
          await logActivity({
            userId: ctx.user.id, action: "email_sent", entity: "complaint",
            entityId: input.complaintId, details: `Email para cliente: ${input.subject}`,
          });
        }
        return r;
      }),

    update: protectedProcedure.input(z.object({
      id: z.number(),
      title: z.string().optional(),
      description: z.string().optional(),
      type: z.enum(["damage", "dirt", "delay", "overcharge", "staff", "other"]).optional(),
      status: z.enum(["new", "analyzing", "waiting_client", "resolved", "closed"]).optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      clientName: z.string().optional(),
      clientEmail: z.string().optional(),
      clientPhone: z.string().optional(),
      vehiclePlate: z.string().nullable().optional(),
      reservationRef: z.string().nullable().optional(),
      clientNotes: z.string().nullable().optional(),
      assignedToId: z.number().nullable().optional(),
      driversInvolved: z.string().optional(),
      slaHours: z.number().optional(),
      penaltyPoints: z.number().int().optional(),
      // Atribuição/prazo/auditoria
      projectId: z.number().nullable().optional(),
      dueDate: z.string().nullable().optional(),
      investigatedById: z.number().nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "edit");
      const { id, slaHours, type, status, priority, penaltyPoints, dueDate, ...rest } = input;
      const updateData: any = { ...rest };
      // Map to actual DB column names
      if (type) updateData.complaintType = type;
      if (status) updateData.complaintStatus = status;
      if (priority) updateData.complaintPriority = priority;
      if (penaltyPoints !== undefined) updateData.penaltyPoints = penaltyPoints;
      // Prazo = hora de parede de Lisboa (o fim do dia escolhido) → UTC (16b).
      if (dueDate !== undefined) {
        const due = dueDate ? caseDueToUtc(dueDate) : null;
        if (dueDate && !due) throw new TRPCError({ code: "BAD_REQUEST", message: "Prazo inválido." });
        updateData.dueDate = due;
      }
      // slaHours: 0 limpa o prazo, > 0 redefine. Antes 0 era ignorado.
      // Prazo novo (ou sem prazo) → pode voltar a avisar quando passar.
      if (slaHours !== undefined) {
        updateData.slaDeadline = slaHours > 0
          ? new Date(Date.now() + slaHours * 3600000)
          : null;
        updateData.slaAlertedAt = null;
      }
      const cur = await getComplaintById(id);
      if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "Reclamação não encontrada" });
      if (status) {
        if (cur.complaintStatus === "converted") throw new TRPCError({ code: "BAD_REQUEST", message: `Reclamação convertida (${cur.convertedToType} #${cur.convertedToId}) — trata-a no registo novo.` });
        if ((cur as any).archivedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Reclamação arquivada — tira-a do arquivo primeiro." });
        // Fechar regista quem/quando; reabrir limpa o fecho e o aviso de SLA (16b).
        const { complaintStatusPatch, utcNowStr } = await import("../shared/caseRules");
        Object.assign(updateData, complaintStatusPatch(cur.complaintStatus, status, ctx.user.id, utcNowStr()));
      }
      const prevAssignee = cur.assignedToId ?? null;
      await updateComplaint(id, updateData);
      // SLA no Google Calendar de quem tinha e de quem tem a reclamação, já.
      // O responsável é uma ficha → sincroniza a conta dessa pessoa (16b).
      if (rest.assignedToId !== undefined || slaHours !== undefined || status) {
        const { assigneeUserIds } = await import("./complaintsExtended");
        const ids = await assigneeUserIds([prevAssignee, rest.assignedToId ?? null]);
        if (ids.length) import("./google/pendingSync").then((m) => m.scheduleGoogleUsersSync(ids, "complaint_sla")).catch(() => undefined);
      }
      // Se a ref de reserva mudou, repopula os campos em falta a partir dela
      // (datas, matrícula, contactos, projeto).
      if (input.reservationRef) {
        try {
          const { autoLinkComplaintBooking } = await import("./complaintDossier");
          await autoLinkComplaintBooking(id);
        } catch (err) {
          console.warn("[complaint update] autolink failed:", err);
        }
      }
      await logActivity({ userId: ctx.user.id, action: "update", entity: "complaint", entityId: id, details: `Reclamação atualizada` });
      return { success: true };
    }),
    // "Eliminar" passou a ARQUIVAR (16b): nada se apaga. Sai das listas,
    // contadores, lembretes e avaliação; volta com "Tirar do arquivo".
    archive: protectedProcedure.input(z.object({ id: z.number(), reason: z.string().trim().min(3, "Diz porquê (mín. 3 letras).").max(255) })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "manage");
      const c = await getComplaintById(input.id);
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Reclamação não encontrada" });
      const done = await archiveComplaint(input.id, ctx.user.id, input.reason);
      if (!done) return { success: true, alreadyArchived: true };
      await addComplaintMessage({ complaintId: input.id, isInternal: 1, authorId: ctx.user.id, authorName: ctx.user.name ?? null, message: `🗄️ Arquivada por ${ctx.user.name ?? "—"}: ${input.reason}` });
      await logActivity({ userId: ctx.user.id, action: "archive", entity: "complaint", entityId: input.id, details: `Reclamação arquivada: ${input.reason}` });
      return { success: true, alreadyArchived: false };
    }),
    unarchive: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "manage");
      const c = await getComplaintById(input.id);
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Reclamação não encontrada" });
      if (!(c as any).archivedAt) return { success: true };
      await updateComplaint(input.id, { archivedAt: null, archivedById: null, archiveReason: null } as any);
      await addComplaintMessage({ complaintId: input.id, isInternal: 1, authorId: ctx.user.id, authorName: ctx.user.name ?? null, message: `📂 Tirada do arquivo por ${ctx.user.name ?? "—"}.` });
      await logActivity({ userId: ctx.user.id, action: "unarchive", entity: "complaint", entityId: input.id, details: "Reclamação tirada do arquivo" });
      return { success: true };
    }),
    // "Isto afinal é um Perdido" — cria o caso nos Perdidos (dados, mensagens,
    // fotos, condutores) e FECHA a reclamação como 'converted', ligada nos
    // dois sentidos. Nada é apagado. Admin+.
    convertToLostFound: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "manage");
      const c = await getComplaintById(input.id);
      if (!c) throw new TRPCError({ code: "NOT_FOUND" });
      assertProjectAccess(c.projectId);
      const { convertComplaintToLost } = await import("./caseOps");
      let r: { newId: number };
      try { r = await convertComplaintToLost(input.id, { id: ctx.user.id, name: ctx.user.name }); }
      catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "Erro ao converter" }); }
      await logActivity({ userId: ctx.user.id, action: "update", entity: "lost_found", entityId: r.newId, details: `Convertido da reclamação #${input.id}` });
      return r;
    }),
    addMessage: protectedProcedure.input(z.object({
      complaintId: z.number(),
      message: z.string().min(1),
      isInternal: z.boolean().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "edit");
      const id = await addComplaintMessage({
        complaintId: input.complaintId,
        message: input.message,
        isInternal: input.isInternal ? 1 : 0,
        authorId: ctx.user.id,
        authorName: ctx.user.name ?? "Desconhecido",
      });
      return { id };
    }),
    uploadPhoto: protectedProcedure.input(z.object({
      complaintId: z.number(),
      base64: z.string(),
      filename: z.string(),
      label: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "edit");
      // Só fotos, com o tipo certo (antes `image/<qualquer extensão>`) — 16b.
      const { complaintPhotoType, COMPLAINT_PHOTO_MAX_BYTES } = await import("../shared/caseRules");
      const type = complaintPhotoType(input.filename);
      if (!type) throw new TRPCError({ code: "BAD_REQUEST", message: "Só fotos (JPG, PNG, WebP, GIF ou HEIC)." });
      const buffer = Buffer.from(input.base64, "base64");
      if (buffer.length > COMPLAINT_PHOTO_MAX_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Foto demasiado grande (máx. 4 MB)." });
      const key = `complaints/${input.complaintId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${type.ext}`;
      const { url } = await storagePut(key, buffer, type.mime);
      const id = await addComplaintPhoto({
        complaintId: input.complaintId,
        url,
        fileKey: key,
        label: input.label ?? null,
        uploadedById: ctx.user.id,
      });
      return { id, url };
    }),
    // Tirar a foto do caso: a linha vai para removed_records e o ficheiro fica (16b).
    removePhoto: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "edit");
      const r = await removeComplaintPhoto(input.id, ctx.user.id);
      if (!r.removed) throw new TRPCError({ code: "NOT_FOUND", message: "Esta foto já não está no caso." });
      await logActivity({ userId: ctx.user.id, action: "update", entity: "complaint", entityId: Number((r.row as any).complaintId), details: `Foto retirada do caso (#${input.id})` });
      return { success: true };
    }),
    stats: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view");
      return getComplaintStats(input?.projectId);
    }),
    // Get vehicle driver history for a complaint
    vehicleHistory: protectedProcedure.input(z.object({ vehicleId: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view");
      return getVehicleDriverHistory(input.vehicleId);
    }),
    // Histórico da reserva — ao vivo da BD da Multipark; cópia antiga como recurso.
    bookingTimeline: protectedProcedure.input(z.object({
      bookingId: z.string(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view");
      const { getBookingTimeline } = await import("./complaintDossier");
      return getBookingTimeline(input.bookingId, scopedCityNames());
    }),

    // Dossier da reserva ligada: ficha + extras + histórico, ao vivo da
    // Multipark (nas cidades de quem pede). Alimenta o card "Reserva" do
    // detalhe da reclamação sem passos manuais.
    bookingDossier: protectedProcedure.input(z.object({
      reservationRef: z.string().min(1),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view");
      const { getComplaintBookingDossier } = await import("./complaintDossier");
      return getComplaintBookingDossier(input.reservationRef, scopedCityNames());
    }),

    // Liga automaticamente a reserva à reclamação (ref → matrícula → email →
    // telefone → nome, ancorado na data da reclamação) e completa campos.
    autoLink: protectedProcedure.input(z.object({
      id: z.number(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "edit");
      const { autoLinkComplaintBooking } = await import("./complaintDossier");
      return autoLinkComplaintBooking(input.id);
    }),


    // Agentes Multipark que mexeram na matrícula (mesma peça dos Perdidos).
    vehicleAgents: protectedProcedure.input(z.object({
      plate: z.string().min(2),
      currentBookingRef: z.string().optional(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view");
      const { getVehicleAgentsByPlate } = await import("./db");
      return getVehicleAgentsByPlate(input.plate, input.currentBookingRef);
    }),
  }),

  // ─── IN-APP NOTIFICATIONS ─────────────────────────────────────────────────
  notifications: router({
    list: protectedProcedure
      .input(z.object({
        unreadOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        kind: z.string().max(32).nullable().optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        const { listNotifications } = await import("./notify");
        return listNotifications(ctx.user.id, { unreadOnly: input?.unreadOnly ?? false, limit: input?.limit ?? 50, kind: input?.kind ?? null });
      }),
    unreadCount: protectedProcedure.query(async ({ ctx }) => {
      const { unreadCount } = await import("./notify");
      return { count: await unreadCount(ctx.user.id) };
    }),
    markRead: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const { markNotificationRead } = await import("./notify");
        await markNotificationRead(ctx.user.id, input.id);
        return { success: true };
      }),
    markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
      const { markAllNotificationsRead } = await import("./notify");
      await markAllNotificationsRead(ctx.user.id);
      return { success: true };
    }),
    // Preferências da própria pessoa (Perfil): tipos silenciados, email por
    // tipo e os tipos que PODE receber (pelas regras de roteamento).
    prefs: protectedProcedure.query(async ({ ctx }) => {
      const { getNotificationPrefsRaw, getSetting } = await import("./appSettings");
      const { parseNotificationPrefs, parseRouting } = await import("../shared/notificationRouting");
      const { receivableKinds } = await import("./notify");
      const [raw, kinds, routing] = await Promise.all([
        getNotificationPrefsRaw(ctx.user.id),
        receivableKinds(ctx.user.id).catch(() => [] as string[]),
        getSetting("notifications.routing").catch(() => null),
      ]);
      return { ...parseNotificationPrefs(raw), kinds, routing: parseRouting(routing) };
    }),
    savePrefs: protectedProcedure
      .input(z.object({
        muted: z.array(z.string().max(32)).max(80),
        email: z.record(z.string().max(32), z.boolean()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { saveNotificationPrefs } = await import("./appSettings");
        const { parseNotificationPrefs } = await import("../shared/notificationRouting");
        const { invalidateNotifyCache } = await import("./notify");
        const prefs = parseNotificationPrefs(input);
        await saveNotificationPrefs(ctx.user.id, prefs);
        invalidateNotifyCache();
        return prefs;
      }),
    // Regras das notificações (Definições): tabela tipo × papel. Ver: admin+;
    // alterar: só super_admin (validado por zod em shared/notificationRouting).
    routing: protectedProcedure.query(async ({ ctx }) => {
      requireRole(ctx.user.role, "admin");
      const { getSetting } = await import("./appSettings");
      const { parseRouting, routingTable } = await import("../shared/notificationRouting");
      const routing = parseRouting(await getSetting("notifications.routing"));
      return { routing, table: routingTable(routing), editable: ctx.user.role === "super_admin" };
    }),
    saveRouting: protectedProcedure
      .input(z.object({ value: z.unknown().nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "super_admin");
        const { setSetting } = await import("./appSettings");
        const { invalidateNotifyCache } = await import("./notify");
        try {
          const r = await setSetting("notifications.routing", input.value ?? null, ctx.user.id);
          invalidateNotifyCache();
          if (r.changed) await logActivity({ userId: ctx.user.id, action: "update", entity: "app_setting", details: `notifications.routing = ${JSON.stringify(r.value)}`.slice(0, 1000) });
          return r;
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) });
        }
      }),
  }),

  // ─── GOOGLE REVIEWS ───────────────────────────────────────────────────────
  reviews: router({
    list: protectedProcedure.input(z.object({
      rating: z.number().optional(),
      status: z.string().optional(),
      projectId: z.number().optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "criticas", "view", { allowOwn: true });
      return filterOwnCases(ctx.user, "criticas", "review", await getGoogleReviews(input ?? undefined));
    }),
    getById: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "criticas", "view", { allowOwn: true });
      await assertOwnCase(ctx.user, "criticas", "review", input.id);
      return getGoogleReviewById(input.id);
    }),
    stats: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "criticas", "view");
      return getGoogleReviewStats(input);
    }),
    // Transforma uma crítica (tipicamente 1-2★) numa Reclamação para ser
    // tratada com SLA/atribuição/dossier. A crítica fica marcada como
    // convertida e ligada à reclamação (o schema já previa isto).
    convertToComplaint: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "criticas", "edit");
      const review = await getGoogleReviewById(input.id);
      if (!review) throw new TRPCError({ code: "NOT_FOUND" });
      if (review.status === "converted_complaint" && review.complaintId) {
        return { complaintId: review.complaintId, alreadyConverted: true };
      }
      const complaintId = await createComplaint({
        title: `Crítica Google ${review.rating}★ — ${review.reviewerName}`.slice(0, 255),
        description: review.reviewText ?? null,
        complaintType: "other",
        complaintStatus: "new",
        complaintPriority: review.rating <= 1 ? "high" : "medium",
        clientName: review.reviewerName,
        clientEmail: review.reviewerEmail ?? null,
        vehiclePlate: review.vehiclePlate ?? null,
        projectId: review.projectId ?? null,
        createdById: ctx.user.id,
      });
      await addComplaintMessage({
        complaintId,
        message: `⭐ Convertida da crítica Google #${review.id} (${review.rating}★) por ${ctx.user.name ?? "—"}.${review.aiResponse ? `\n\nResposta preparada na crítica:\n${review.aiResponse}` : ""}`,
        isInternal: 1,
        authorId: ctx.user.id,
        authorName: ctx.user.name ?? null,
      });
      try {
        const { autoLinkComplaintBooking } = await import("./complaintDossier");
        await autoLinkComplaintBooking(complaintId);
      } catch { /* best-effort */ }
      await updateGoogleReview(review.id, { status: "converted_complaint", complaintId } as any);
      await logActivity({ userId: ctx.user.id, action: "create", entity: "complaint", entityId: complaintId, details: `Convertida da crítica Google #${review.id}` });
      return { complaintId, alreadyConverted: false };
    }),
    create: protectedProcedure.input(z.object({
      reviewerName: z.string().min(1),
      reviewerEmail: z.string().optional(),
      rating: z.number().min(1).max(5),
      reviewText: z.string().optional(),
      reviewDate: z.string().optional(),
      projectId: z.number().optional(),
      vehiclePlate: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      // create dispara a IA (rascunho de resposta) e/ou cria reclamação automaticamente.
      // Custo real + acções com efeito — restringir a frontoffice+.
      requireAccess(ctx.user, "criticas", "edit");
      const reviewDate = (input.reviewDate ? new Date(input.reviewDate) : new Date()).toISOString().slice(0, 19).replace("T", " ");
      const id = await createGoogleReview({
        ...input,
        reviewDate,
        createdById: ctx.user.id,
      });

      // Críticas 4–5★: rascunho de resposta por IA (best-effort; nunca publica sozinho).
      if (input.rating >= 4 && id) {
        try {
          const { draftReviewReply } = await import("./_core/ai/reviewReply");
          const aiText = await draftReviewReply(input, { userId: ctx.user.id, reviewId: id });
          if (aiText) await updateGoogleReview(id, { aiResponse: aiText, status: "ai_responded" });
        } catch (e: any) {
          console.warn("[Reviews] rascunho IA falhou:", String(e?.code ?? e?.name ?? "erro"));
        }
      }

      // If rating <= 3, auto-convert to complaint
      if (input.rating <= 3 && id) {
        try {
          const complaintId = await createComplaint({
            title: `Crítica Google ${input.rating}\u2605 — ${input.reviewerName}`,
            description: `Avaliação negativa no Google (${input.rating} estrelas):\n\n"${input.reviewText || 'Sem texto'}"\n\nCliente: ${input.reviewerName}${input.reviewerEmail ? '\nEmail: ' + input.reviewerEmail : ''}${input.vehiclePlate ? '\nMatrícula: ' + input.vehiclePlate : ''}`,
            complaintType: "other",
            complaintPriority: input.rating === 1 ? "urgent" : "high",
            clientName: input.reviewerName,
            clientEmail: input.reviewerEmail || undefined,
            vehiclePlate: input.vehiclePlate || undefined,
            projectId: input.projectId || undefined,
            slaDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " "), // 24h SLA
            createdById: ctx.user.id,
          });
          await updateGoogleReview(id, { complaintId, status: "converted_complaint" });
          await logActivity({ userId: ctx.user.id, action: "review_to_complaint", entity: "google_review", entityId: id, details: `Review ${input.rating}\u2605 convertida em reclamação #${complaintId}` });
        } catch (e) {
          console.error("[Reviews] Complaint conversion failed:", e);
        }
      }

      await logActivity({ userId: ctx.user.id, action: "create", entity: "google_review", entityId: id ?? 0, details: `Review ${input.rating}\u2605 de ${input.reviewerName}` });
      return { id };
    }),
    update: protectedProcedure.input(z.object({
      id: z.number(),
      aiResponse: z.string().optional(),
      status: z.enum(["pending_response", "ai_responded", "manually_responded", "converted_complaint", "dismissed"]).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "criticas", "edit");
      const { id, ...data } = input;
      if (data.status === "manually_responded" || data.aiResponse) {
        (data as any).respondedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
        (data as any).respondedBy = ctx.user.id;
      }
      await updateGoogleReview(id, data);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "google_review", entityId: id, details: `Review atualizada` });
      return { success: true };
    }),
    generateResponse: protectedProcedure.input(z.object({
      id: z.number(),
    })).mutation(async ({ ctx, input }) => {
      // Chama a IA por review (custo) — restringir a frontoffice+
      requireAccess(ctx.user, "criticas", "edit");
      const review = await getGoogleReviewById(input.id);
      if (!review) throw new TRPCError({ code: "NOT_FOUND" });
      const { draftReviewReply } = await import("./_core/ai/reviewReply");
      const { aiTrpcError } = await import("./_core/ai/trpcError");
      let aiText: string;
      try {
        aiText = await draftReviewReply(review, { userId: ctx.user.id, reviewId: review.id });
      } catch (err) {
        throw aiTrpcError(err);
      }
      await updateGoogleReview(input.id, { aiResponse: aiText, status: "ai_responded" });
      return { response: aiText };
    }),
    searchClient: protectedProcedure.input(z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      plate: z.string().optional(),
    })).query(async ({ ctx, input }) => {
      // PII de clientes — restringir
      requireAccess(ctx.user, "criticas", "edit");
      return searchClientHistory(input.name, input.email, input.plate);
    }),
    // Publica no Google a resposta escrita/gerada no dashboard (Jorge, 16 set
    // 2026: "receber a crítica e responder pela dashboard"). Só críticas
    // importadas pela API têm ligação ao Google; as de email ficam só locais.
    publishReply: protectedProcedure.input(z.object({ id: z.number(), comment: z.string().min(1).max(4096) })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "criticas", "edit");
      const review = await getGoogleReviewById(input.id); // já aplica o âmbito de cidade
      if (!review) throw new TRPCError({ code: "NOT_FOUND", message: "Crítica não encontrada" });
      const { publishReply } = await import("./integrations/googleBusiness/service");
      const { safeError } = await import("./integrations/googleBusiness/domain");
      try {
        const result = await publishReply(input.id, input.comment, ctx.user.id);
        await logActivity({ userId: ctx.user.id, action: "review_reply_published", entity: "google_review", entityId: input.id, details: "Resposta publicada no Google" });
        return result;
      } catch (error) {
        throw new TRPCError({ code: "BAD_REQUEST", message: safeError(error) });
      }
    }),
    approveResponse: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "criticas", "edit");
      await updateGoogleReview(input.id, { aiResponseApproved: 1, respondedAt: new Date().toISOString().slice(0, 19).replace("T", " "), respondedBy: ctx.user.id, status: "manually_responded" });
      await logActivity({ userId: ctx.user.id, action: "approve", entity: "google_review", entityId: input.id, details: "Resposta aprovada" });
      return { success: true };
    }),
    syncFromGmail: protectedProcedure.mutation(async ({ ctx }) => {
      if (ROLE_HIERARCHY[ctx.user.role] < ROLE_HIERARCHY["admin"]) throw new TRPCError({ code: "FORBIDDEN" });
      // Sincronização do Gmail (a mesma do agendador/push; o alias criticas@ cria as críticas).
      const { runMailSync } = await import("./mail/service");
      const r = await runMailSync({ deadlineAt: Date.now() + 45_000 });
      return {
        reviewsImported: r.pipelineCreated,
        reviewsSkipped: 0,
        incidentsImported: 0,
        incidentsSkipped: 0,
        message: r.configured
          ? `Sincronizado: ${r.stored} email(s) novos, ${r.pipelineCreated} registo(s) criados.${r.done ? "" : " Parcial — carregue outra vez para continuar."}`
          : "Nenhuma caixa Gmail ligada (Definições → Comunicação).",
      };
    }),
    // Checkout drivers ranking (DB local — alimentada pelo sync da API Multipark)
    checkoutDrivers: protectedProcedure.input(z.object({
      startDate: z.string(),
      endDate: z.string(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "criticas", "view");
      const { getCheckoutDriversFromDb } = await import("./db");
      return getCheckoutDriversFromDb(input.startDate, input.endDate);
    }),

    // Agent performance history (DB local — alimentada pelo sync da API Multipark)
    agentHistory: protectedProcedure.input(z.object({
      startDate: z.string(),
      endDate: z.string(),
      agentName: z.string().optional(),
      userId: z.string().optional(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "criticas", "view");
      const { getAgentHistoryFromDb } = await import("./db");
      return getAgentHistoryFromDb({
        startDate: input.startDate,
        endDate: input.endDate,
        agentName: input.agentName,
        userId: input.userId,
      });
    }),
  }),

  // ─── FORMAÇÃO E APOIO ──────────────────────────────────────────────────────
  // Router da Formação vive em server/trainingRouter.ts
  training: trainingRouter,

  // ─── PERDIDOS E ACHADOS ────────────────────────────────────────────────────
  lostFound: router({
    list: protectedProcedure.input(z.object({
      status: z.enum(LOST_STATUSES).optional(),
      itemType: z.enum(LOST_ITEM_TYPES).optional(),
      projectId: z.number().optional(),
      noProject: z.boolean().optional(),
      search: z.string().max(200).optional(),
      /** Só os arquivados (quem gere). Sem isto, os arquivados nunca vêm. */
      archived: z.boolean().optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view", { allowOwn: true });
      if (input?.archived) requireAccess(ctx.user, "perdidos", "manage");
      return filterOwnCases(ctx.user, "perdidos", "lost_found", await getLostFoundItems(input));
    }),

    getById: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view", { allowOwn: true });
      await assertOwnCase(ctx.user, "perdidos", "lost_found", input.id);
      const item = await loadLostInScope(input.id);
      const { signedFileUrl } = await import("./caseOps");
      return { ...item, returnPhotoUrl: item.returnPhotoUrl || item.returnPhotoKey ? await signedFileUrl(item.returnPhotoKey, item.returnPhotoUrl) : null };
    }),

    // ── IA: possíveis correspondências perdido ↔ achado (humano contacta) ──
    matches: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view", { allowOwn: true });
      await assertOwnCase(ctx.user, "perdidos", "lost_found", input.id);
      await loadLostInScope(input.id);
      const { listMatchesFor } = await import("./lostFoundMatch");
      return listMatchesFor(input.id);
    }),
    recomputeMatches: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      await loadLostInScope(input.id);
      const { computeMatchesFor } = await import("./lostFoundMatch");
      const r = await computeMatchesFor(input.id, { userId: ctx.user.id });
      return { candidates: r.candidates, ai: r.ai };
    }),
    decideMatch: protectedProcedure.input(z.object({ id: z.number(), matchId: z.number(), decision: z.enum(["confirmed", "dismissed"]) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "perdidos", "edit");
        await loadLostInScope(input.id);
        const { decideMatch } = await import("./lostFoundMatch");
        const r = await decideMatch(input.matchId, input.id, input.decision, { id: ctx.user.id, name: ctx.user.name });
        if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error || "Não foi possível guardar." });
        await logActivity({ userId: ctx.user.id, action: `match_${input.decision}`, entity: "lost_found", entityId: input.id, details: `Correspondência #${input.matchId}` });
        return { success: true };
      }),

    dashboard: protectedProcedure.input(z.object({ projectId: z.number().optional(), noProject: z.boolean().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "perdidos", "view");
        const { getLostDashboard } = await import("./caseOps");
        const d = await getLostDashboard(input ?? {});
        // Condutores repetidos é informação sensível → só team leader+.
        return hasRole(ctx.user.role, "team_leader") ? d : { ...d, repeatDrivers: [] };
      }),

    create: protectedProcedure.input(z.object({
      projectId: z.number().optional(),
      vehiclePlate: z.string().max(20).optional(),
      clientName: z.string().min(1).max(255),
      clientEmail: z.string().max(320).optional(),
      clientPhone: z.string().max(50).optional(),
      bookingRef: z.string().max(100).optional(),
      itemType: z.enum(LOST_ITEM_TYPES),
      description: z.string().min(1).max(5000),
      estimatedValue: z.number().int().min(0).optional(),
      priority: z.enum(LOST_PRIORITIES).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      if (input.projectId) assertProjectAccess(input.projectId);
      const id = await createLostFoundItem({ ...input, projectId: input.projectId ?? defaultScopedProjectId(), createdBy: ctx.user.id, status: "new", priority: input.priority || "medium" } as any);
      // Auto-liga a reserva a partir dos sinais (matrícula/email/telefone/nome).
      if (id) {
        try {
          const { autoLinkLostFoundBooking } = await import("./complaintDossier");
          await autoLinkLostFoundBooking(id);
        } catch (err) {
          console.warn("[lostfound create] autolink failed:", err);
        }
      }
      await logActivity({ userId: ctx.user.id, action: "create", entity: "lost_found", entityId: id || 0, details: `Perdido: ${input.description.slice(0, 200)}` });
      if (id) {
        const { notify } = await import("./notify");
        await notify({
          kind: "lost_found_new", projectId: input.projectId ?? defaultScopedProjectId(),
          title: "Novo Perdido",
          body: `${input.clientName}: ${input.description.slice(0, 300)} (Viatura: ${input.vehiclePlate || "N/A"})`,
          link: "/perdidos-achados", entity: { type: "lost_found", id },
        });
      }
      return { id };
    }),

    update: protectedProcedure.input(z.object({
      id: z.number(),
      // 'converted' só pelas conversões (nunca à mão).
      status: z.enum(["new", "investigating", "found", "returned", "closed"]).optional(),
      priority: z.enum(LOST_PRIORITIES).optional(),
      assignedTo: z.number().nullable().optional(),
      resolution: z.string().max(5000).optional(),
      clientName: z.string().max(255).optional(),
      clientEmail: z.string().max(320).optional(),
      clientPhone: z.string().max(50).optional(),
      bookingRef: z.string().max(100).optional(),
      vehiclePlate: z.string().max(20).optional(),
      itemType: z.enum(LOST_ITEM_TYPES).optional(),
      description: z.string().max(5000).optional(),
      estimatedValue: z.number().int().min(0).optional(),
      clientNotes: z.string().max(5000).nullable().optional(),
      // Devolução estruturada
      foundLocation: z.string().max(255).nullable().optional(),
      foundByName: z.string().max(255).nullable().optional(),
      returnMethod: z.string().max(100).nullable().optional(),
      returnedAt: z.string().max(30).nullable().optional(),
      // Atribuição / prazo / auditoria
      projectId: z.number().nullable().optional(),
      dueDate: z.string().max(30).nullable().optional(),
      investigatedById: z.number().nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      const existing = await loadLostInScope(input.id);
      const { id, dueDate, status, ...rest } = input;
      if (rest.projectId !== undefined && rest.projectId !== null) assertProjectAccess(rest.projectId);
      if (rest.projectId === null && scopedProjectIds() !== undefined) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Só quem vê todas as cidades pode deixar um caso sem cidade." });
      }
      const data: any = { ...rest };
      // Prazo = hora de parede de Lisboa (o fim do dia escolhido) → UTC (16b).
      if (dueDate !== undefined) {
        const due = dueDate ? caseDueToUtc(dueDate) : null;
        if (dueDate && !due) throw new TRPCError({ code: "BAD_REQUEST", message: "Prazo inválido." });
        data.dueDate = due;
      }
      if (status && existing.status === "converted") throw new TRPCError({ code: "BAD_REQUEST", message: `Caso convertido (${existing.convertedToType} #${existing.convertedToId}) — trata-o no registo novo.` });
      if ((existing as any).archivedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Caso arquivado — tira-o do arquivo primeiro." });
      if (status) Object.assign(data, lostStatusPatch(existing, status, utcNowStr(), ctx.user.id));
      await updateLostFoundItem(id, data as any);
      // Se a ref de reserva mudou, repopula os campos em falta a partir dela.
      if (input.bookingRef) {
        try {
          const { autoLinkLostFoundBooking } = await import("./complaintDossier");
          await autoLinkLostFoundBooking(id);
        } catch (err) {
          console.warn("[lostfound update] autolink failed:", err);
        }
      }
      await logActivity({ userId: ctx.user.id, action: "update", entity: "lost_found", entityId: id, details: `Atualizado: ${JSON.stringify(data).slice(0, 500)}` });
      return { success: true };
    }),

    // Foto/assinatura da entrega ao cliente.
    uploadReturnPhoto: protectedProcedure.input(z.object({
      itemId: z.number(),
      base64: z.string().max(22_000_000),
      filename: z.string().max(255),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      const item = await loadLostInScope(input.itemId);
      const buffer = Buffer.from(input.base64, "base64");
      const key = `lost-found/${input.itemId}/return-${Date.now()}.${safeExt(input.filename)}`;
      const { url } = await storagePut(key, buffer, contentTypeForFilename(input.filename));
      // A foto da entrega anterior não se perde: fica em removed_records (16c).
      if (item.returnPhotoKey || item.returnPhotoUrl) {
        const { getDb } = await import("./db");
        const { removedRecords } = await import("../drizzle/schema");
        const { removedRowJson } = await import("./removedRecords");
        const db = await getDb();
        await db?.insert(removedRecords).values({ entity: "lost_found_return_photo", recordId: input.itemId, parentId: input.itemId, rowJson: removedRowJson({ returnPhotoUrl: item.returnPhotoUrl, returnPhotoKey: item.returnPhotoKey }), reason: "Substituída por outra foto da entrega", removedById: ctx.user.id });
      }
      await updateLostFoundItem(input.itemId, { returnPhotoUrl: url, returnPhotoKey: key } as any);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "lost_found", entityId: input.itemId, details: "Foto da entrega carregada" });
      const { signedFileUrl } = await import("./caseOps");
      return { url: await signedFileUrl(key, url) };
    }),

    // Email ao cliente — SÓ manual (nunca automático). Sai de perdidos@.
    sendEmailToClient: protectedProcedure.input(z.object({
      itemId: z.number(),
      subject: z.string().min(1).max(255),
      body: z.string().min(1).max(10000),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      const item = await loadLostInScope(input.itemId);
      if (!item.clientEmail) throw new TRPCError({ code: "BAD_REQUEST", message: "Item sem email de cliente" });
      const { sendEmail } = await import("./mail/systemMail");
      const greeting = item.clientName ? `Olá ${item.clientName},\n\n` : "Olá,\n\n";
      const full = greeting + input.body;
      const ok = await sendEmail({
        to: item.clientEmail,
        subject: input.subject.replace(/[\r\n]+/g, " "),
        text: full,
        // Todo o texto do utilizador/cliente é escapado antes de virar HTML.
        html: textToSafeHtml(full),
        from: "perdidos@multipark.pt",
        fromName: "Multipark",
      });
      if (!ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Falha ao enviar email (Gmail)" });
      await updateLostFoundItem(input.itemId, { clientEmailSentAt: utcNowStr() } as any);
      await addLostFoundMessage({
        itemId: input.itemId,
        userId: ctx.user.id,
        userName: ctx.user.name ?? "Multipark",
        message: `📤 Email enviado ao cliente — ${input.subject}\n\n${input.body}`,
        isInternal: 0,
      } as any);
      await logActivity({ userId: ctx.user.id, action: "email_sent", entity: "lost_found", entityId: input.itemId, details: `Email para cliente: ${input.subject}` });
      return { ok: true };
    }),

    // "Eliminar" passou a ARQUIVAR (16c): nada se apaga — nem os ficheiros.
    // Sai das listas, contadores, lembretes e cruzamento; volta com "Tirar do arquivo".
    archive: protectedProcedure.input(z.object({ id: z.number(), reason: z.string().trim().min(3, "Diz porquê (mín. 3 letras).").max(255) })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "manage");
      await loadLostInScope(input.id);
      const done = await archiveLostFoundItem(input.id, ctx.user.id, input.reason);
      if (!done) return { success: true, alreadyArchived: true };
      await addLostFoundMessage({ itemId: input.id, userId: ctx.user.id, userName: ctx.user.name ?? "—", message: `🗄️ Arquivado por ${ctx.user.name ?? "—"}: ${input.reason}`, isInternal: 1 } as any);
      await logActivity({ userId: ctx.user.id, action: "archive", entity: "lost_found", entityId: input.id, details: `Perdido arquivado: ${input.reason}` });
      return { success: true, alreadyArchived: false };
    }),
    unarchive: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "manage");
      const item = await loadLostInScope(input.id);
      if (!(item as any).archivedAt) return { success: true };
      await updateLostFoundItem(input.id, { archivedAt: null, archivedById: null, archiveReason: null } as any);
      await addLostFoundMessage({ itemId: input.id, userId: ctx.user.id, userName: ctx.user.name ?? "—", message: `📂 Tirado do arquivo por ${ctx.user.name ?? "—"}.`, isInternal: 1 } as any);
      await logActivity({ userId: ctx.user.id, action: "unarchive", entity: "lost_found", entityId: input.id, details: "Perdido tirado do arquivo" });
      return { success: true };
    }),

    // Photos — URLs assinadas (temporárias), nunca a URL pública guardada.
    getPhotos: protectedProcedure.input(z.object({ itemId: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view", { allowOwn: true });
      await assertOwnCase(ctx.user, "perdidos", "lost_found", input.itemId);
      await loadLostInScope(input.itemId);
      const { signedFileUrl } = await import("./caseOps");
      const photos = await getLostFoundPhotos(input.itemId);
      return Promise.all(photos.map(async (p) => ({ ...p, url: (await signedFileUrl(p.fileKey, p.url)) ?? "", isPdf: /\.pdf$/i.test(p.fileKey || p.url || "") })));
    }),

    uploadPhoto: protectedProcedure.input(z.object({
      itemId: z.number(),
      base64: z.string().max(22_000_000),
      filename: z.string().max(255),
      caption: z.string().max(255).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      await loadLostInScope(input.itemId);
      const buffer = Buffer.from(input.base64, "base64");
      const key = `lost-found/${input.itemId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExt(input.filename)}`;
      const { url } = await storagePut(key, buffer, contentTypeForFilename(input.filename));
      await addLostFoundPhoto({ itemId: input.itemId, url, fileKey: key, caption: input.caption || null });
      const { signedFileUrl } = await import("./caseOps");
      return { url: await signedFileUrl(key, url) };
    }),

    // Messages
    getMessages: protectedProcedure.input(z.object({ itemId: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view", { allowOwn: true });
      await assertOwnCase(ctx.user, "perdidos", "lost_found", input.itemId);
      await loadLostInScope(input.itemId);
      return getLostFoundMessages(input.itemId);
    }),

    addMessage: protectedProcedure.input(z.object({
      itemId: z.number(),
      message: z.string().min(1).max(5000),
      isInternal: z.boolean().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      await loadLostInScope(input.itemId);
      await addLostFoundMessage({ itemId: input.itemId, userId: ctx.user.id, userName: ctx.user.name || "Utilizador", message: input.message, isInternal: input.isInternal === false ? 0 : 1 });
      return { success: true };
    }),

    // ── Condutores ligados ao caso ─────────────────────────────────────────
    attachedDrivers: protectedProcedure.input(z.object({ itemId: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view");
      await loadLostInScope(input.itemId);
      const { listLostFoundDrivers } = await import("./db");
      return listLostFoundDrivers(input.itemId);
    }),

    // Ligar um condutor SUSPEITO é sensível → team leader+.
    attachDriver: protectedProcedure.input(z.object({
      itemId: z.number(),
      employeeId: z.number().nullable().optional(),
      driverName: z.string().min(1).max(256),
      source: z.enum(["history", "manual"]).default("manual"),
      movementDate: z.string().max(10).nullable().optional(),
      movementsSummary: z.string().max(512).nullable().optional(),
      notes: z.string().max(512).nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      await loadLostInScope(input.itemId);
      // o colaborador anexado tem de ser das cidades de quem anexa (pode vir a levar pontos)
      if (input.employeeId) await assertEmployeeAccess(input.employeeId);
      // A mesma pessoa não fica anexada duas vezes ao mesmo caso (16c).
      const { attachLostFoundDriver, listLostFoundDrivers } = await import("./db");
      const already = (await listLostFoundDrivers(input.itemId)).find((d) => (input.employeeId != null && d.employeeId === input.employeeId) || (input.employeeId == null && d.employeeId == null && d.driverName === input.driverName));
      if (already) return { id: already.id, duplicate: true };
      const id = await attachLostFoundDriver({ ...input, attachedById: ctx.user.id });
      await logActivity({ userId: ctx.user.id, action: "attach_driver", entity: "lost_found", entityId: input.itemId, details: `Condutor anexado: ${input.driverName}` });
      return { id };
    }),

    detachDriver: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      const link = await getLostDriverLink(input.id);
      await loadLostInScope(link.itemId);
      if (link.penaltyId && link.pointsConfirmed) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Os pontos deste condutor já foram confirmados — anula-os primeiro (supervisor)." });
      }
      if (link.penaltyId) {
        const { setLostDriverAccountability } = await import("./caseOps");
        await setLostDriverAccountability(input.id, { points: 0 }, ctx.user.id);
      }
      // A ligação (com custo e notas) vai para removed_records — nada se apaga (16c).
      const { detachLostFoundDriver } = await import("./db");
      const r = await detachLostFoundDriver(input.id, ctx.user.id);
      if (!r.removed) throw new TRPCError({ code: "NOT_FOUND", message: "Este condutor já não está ligado ao caso." });
      await logActivity({ userId: ctx.user.id, action: "detach_driver", entity: "lost_found", entityId: link.itemId, details: `Condutor retirado: ${link.driverName}` });
      return { success: true };
    }),

    // Custo de recuperação + pontos propostos (penalização RH PENDENTE).
    setDriverAccountability: protectedProcedure.input(z.object({
      linkId: z.number(),
      costAmount: z.number().min(0).max(100000).nullable().optional(),
      points: z.number().int().min(0).max(20).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      const link = await getLostDriverLink(input.linkId);
      await loadLostInScope(link.itemId);
      const { setLostDriverAccountability } = await import("./caseOps");
      try {
        await setLostDriverAccountability(input.linkId, { costAmount: input.costAmount, points: input.points }, ctx.user.id);
      } catch (e: any) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "Erro" });
      }
      await logActivity({ userId: ctx.user.id, action: "update", entity: "lost_found", entityId: link.itemId, details: `Responsabilização ${link.driverName}: custo=${input.costAmount ?? "—"} pontos=${input.points ?? "—"}` });
      return { success: true };
    }),

    // Supervisor+: confirma ou anula os pontos propostos.
    reviewDriverPoints: protectedProcedure.input(z.object({ linkId: z.number(), decision: z.enum(["confirmed", "dismissed"]) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "perdidos", "edit");
        const link = await getLostDriverLink(input.linkId);
        await loadLostInScope(link.itemId);
        const { reviewLostDriverPoints } = await import("./caseOps");
        try {
          return await reviewLostDriverPoints(input.linkId, input.decision, ctx.user);
        } catch (e: any) {
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "Erro" });
        }
      }),

    // ── Cruzamento de condutores (team leader+, por cidade) ────────────────
    crossRef: protectedProcedure.input(crossRefInput).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      const { getDriverCrossRef } = await import("./caseOps");
      return getDriverCrossRef(input);
    }),

    crossRefDetail: protectedProcedure.input(crossRefInput.extend({ key: z.string().min(3).max(300) })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      const { getDriverCrossRefDetail } = await import("./caseOps");
      return getDriverCrossRefDetail(input);
    }),

    // "Aparece em N outros casos" no detalhe de um caso.
    caseRepeatDrivers: protectedProcedure.input(z.object({ itemId: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      await loadLostInScope(input.itemId);
      const { getCaseRepeatDrivers } = await import("./caseOps");
      return getCaseRepeatDrivers(input.itemId);
    }),

    // Agentes Multipark que mexeram na matrícula. Sinaliza os que tocaram
    // especificamente na reserva do caso aberto (currentBookingRef).
    vehicleAgents: protectedProcedure
      .input(z.object({ plate: z.string().max(20), currentBookingRef: z.string().max(128).optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "perdidos", "view");
        const { getVehicleAgentsByPlate } = await import("./db");
        return getVehicleAgentsByPlate(input.plate, input.currentBookingRef);
      }),

    // ── Histórico das reservas — AO VIVO da BD da Multipark ──
    bookingHistory: protectedProcedure
      .input(z.object({ bookingId: z.string().optional(), plate: z.string().optional(), search: z.string().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "perdidos", "view");
        // Diz quando a lista bateu no teto (antes cortava calada) — 16c.
        const { HISTORY_LIST_LIMIT, HISTORY_SEARCH_LIMIT } = await import("./db");
        const [rows, limit] = input.bookingId ? [await getBookingHistoryByBookingId(input.bookingId), HISTORY_LIST_LIMIT]
          : input.plate ? [await getBookingHistoryByPlate(input.plate), HISTORY_LIST_LIMIT]
          : input.search ? [await searchBookingHistory(input.search), HISTORY_SEARCH_LIMIT]
          : [[], HISTORY_LIST_LIMIT];
        return { rows, truncated: rows.length >= limit, limit };
      }),

    bookingHistoryDriverStats: protectedProcedure.query(({ ctx }) => {
      requireAccess(ctx.user, "perdidos", "view");
      return getBookingHistoryDriverStats();
    }),

    // Condutores com atividade no período (alimenta o dropdown da vista
    // "Movimentos por Condutor" do Cruzamento). Só reservas das cidades do utilizador.
    driversForPeriod: protectedProcedure
      .input(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "perdidos", "edit");
        const { lisbonDayRangeUtc } = await import("../shared/lisbonDay");
        const { start, end } = lisbonDayRangeUtc(input.from, input.to);
        // AO VIVO da BD da Multipark ("History"; a cópia local está congelada desde o #141).
        const { readLiveHistoryByAgent } = await import("./multiparkDb/historyLive");
        const { scopedCityNamesLive } = await import("./cityScope");
        const acts = await readLiveHistoryByAgent({ from: start, to: end, cities: scopedCityNamesLive(), limit: 2000 });
        return acts.filter((a) => a.agentName).map((a) => ({ agentName: a.agentName as string, total: a.total }));
      }),

    // Movimentos de UM condutor no período escolhido — que carros mexeu,
    // com matrícula/parque e sinalização dos que têm caso aberto.
    agentMovements: protectedProcedure
      .input(z.object({ agentName: z.string().min(1).max(256), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "perdidos", "edit");
        const { getAgentMovements } = await import("./db");
        return getAgentMovements(input);
      }),

    // Histórico da reserva — ao vivo da BD da Multipark; cópia antiga como
    // recurso. Só reservas das cidades do utilizador.
    bookingTimeline: protectedProcedure.input(z.object({
      bookingId: z.string().max(128),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view");
      const inScope = await bookingRefInScope(input.bookingId);
      // Multipark sem resposta ≠ "sem histórico" (16c).
      if (inScope === "unavailable") return { bookingId: input.bookingId, total: 0, history: [], error: "Histórico indisponível (BD da Multipark sem resposta)." };
      if (!inScope) return { bookingId: input.bookingId, total: 0, history: [] };
      const { getBookingTimeline } = await import("./complaintDossier");
      return getBookingTimeline(input.bookingId, scopedCityNames());
    }),

    // Dossier completo da reserva ligada (mesma peça das Reclamações).
    bookingDossier: protectedProcedure.input(z.object({
      reservationRef: z.string().min(1).max(128),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view");
      const { getComplaintBookingDossier } = await import("./complaintDossier");
      return getComplaintBookingDossier(input.reservationRef, scopedCityNames());
    }),

    // "Isto afinal é uma Reclamação" — cria a reclamação (dados, mensagens,
    // fotos, condutores, valor/tipo) e FECHA este caso como 'converted',
    // ligado nos dois sentidos. Nada é apagado. Admin+.
    convertToComplaint: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "manage");
      await loadLostInScope(input.id);
      const { convertLostToComplaint } = await import("./caseOps");
      let r: { newId: number };
      try { r = await convertLostToComplaint(input.id, { id: ctx.user.id, name: ctx.user.name }); }
      catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "Erro ao converter" }); }
      await logActivity({ userId: ctx.user.id, action: "update", entity: "complaint", entityId: r.newId, details: `Convertida do perdido #${input.id}` });
      return r;
    }),

    // Liga automaticamente a reserva ao caso e completa campos em falta.
    autoLink: protectedProcedure.input(z.object({
      id: z.number(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      await loadLostInScope(input.id);
      const { autoLinkLostFoundBooking } = await import("./complaintDossier");
      return autoLinkLostFoundBooking(input.id);
    }),

  }),

  // ─── OCORRÊNCIAS (INCIDENTS) ──────────────────────────────────────────────
  incidents: router({
    list: protectedProcedure.input(z.object({
      status: z.enum(INCIDENT_STATUSES).optional(),
      severity: z.enum(INCIDENT_SEVERITIES).optional(),
      employeeId: z.number().optional(),
      projectId: z.number().optional(),
      noProject: z.boolean().optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "view", { allowOwn: true });
      return filterOwnCases(ctx.user, "ocorrencias", "incident", await getIncidents(input));
    }),

    // Ocorrências da app Multipark, lidas AO VIVO da BD deles ("Occurrence").
    // Só leitura: resolvem-se na app Multipark. Nunca lança por falta de BD —
    // devolve { available:false, reason } e a página mostra um aviso.
    multipark: protectedProcedure.input(z.object({
      projectId: z.number().optional(),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      parkId: z.string().max(64).optional(),
      type: z.string().max(200).optional(),
      priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
      resolved: z.boolean().optional(),
      search: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).max(5000).optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "view");
      const { listMultiparkOccurrences, getMultiparkOccurrenceStats } = await import("./multiparkDb/read");
      const { projectId: _p, limit, offset, ...filters } = input ?? {};
      const f = { ...filters, cities: scopedCityNames() };
      const list = await listMultiparkOccurrences({ ...f, limit, offset });
      if (!list.available) return { available: false as const, reason: list.reason, code: list.code };
      const stats = await getMultiparkOccurrenceStats(f);
      return {
        available: true as const,
        ...list.data,
        stats: stats.available ? stats.data : null,
      };
    }),

    multiparkById: protectedProcedure.input(z.object({ id: z.string().min(1).max(64), projectId: z.number().optional() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "view");
      const { getMultiparkOccurrence } = await import("./multiparkDb/read");
      const r = await getMultiparkOccurrence(input.id, scopedCityNames());
      if (!r.available) return { available: false as const, reason: r.reason, code: r.code };
      return { available: true as const, occurrence: r.data };
    }),

    getById: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "view", { allowOwn: true });
      await assertOwnCase(ctx.user, "ocorrencias", "incident", input.id);
      return loadIncidentInScope(input.id);
    }),

    create: protectedProcedure.input(z.object({
      projectId: z.number().optional(),
      vehiclePlate: z.string().max(20).optional(),
      bookingRef: z.string().max(128).optional(),
      employeeId: z.number().optional(),
      incidentType: z.enum(INCIDENT_TYPES),
      severity: z.enum(INCIDENT_SEVERITIES),
      description: z.string().min(1).max(5000),
      costAmount: z.number().min(0).max(100000).optional(),
    })).mutation(async ({ ctx, input }) => {
      // Apontar um condutor afeta a avaliação dele → team leader+.
      requireAccess(ctx.user, "ocorrencias", "edit");
      if (input.employeeId) requireRole(ctx.user.role, "team_leader");
      if (input.projectId) assertProjectAccess(input.projectId);
      if (input.employeeId) await assertEmployeeAccess(input.employeeId);
      const { deriveBookingForCase } = await import("./caseOps");
      // A reserva do formulário é USADA: define a cidade e a ligação.
      const booking = await deriveBookingForCase({ bookingRef: input.bookingRef, plate: input.vehiclePlate, atUtc: utcNowStr() });
      if (booking?.projectId && !input.projectId) assertProjectAccess(booking.projectId);
      const { bookingRef, costAmount, ...rest } = input;
      const incidentProjectId = input.projectId ?? booking?.projectId ?? defaultScopedProjectId();
      const id = await createIncident({
        ...rest,
        projectId: incidentProjectId,
        reservationLink: booking?.externalId ?? (bookingRef?.trim() || undefined),
        costAmount: costAmount != null ? String(costAmount) : undefined,
        reportedBy: ctx.user.id,
        status: "open",
        // Quem cria com condutor já é team leader+ → envolvimento confirmado.
        ...(input.employeeId ? { driverConfirmed: 1, driverConfirmedById: ctx.user.id, driverConfirmedAt: utcNowStr() } : {}),
      });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "incident", entityId: id || 0, details: `Ocorrência: ${input.description.slice(0, 200)}` });
      if (input.severity === "critical") {
        // Aviso `incident_critical` (team leader/supervisor/backoffice da cidade; app + email).
        const { notify } = await import("./notify");
        await notify({
          kind: "incident_critical", projectId: incidentProjectId ?? null,
          title: "Ocorrência Crítica",
          body: `${input.incidentType}: ${input.description.slice(0, 300)} (Viatura: ${input.vehiclePlate || "N/A"})`,
          link: "/ocorrencias", entity: id ? { type: "incident", id } : null,
        });
      }
      return { id };
    }),

    update: protectedProcedure.input(z.object({
      id: z.number(),
      // 'converted' só pelas conversões.
      status: z.enum(["open", "investigating", "resolved", "dismissed"]).optional(),
      severity: z.enum(INCIDENT_SEVERITIES).optional(),
      resolution: z.string().max(10000).optional(),
      incidentType: z.enum(INCIDENT_TYPES).optional(),
      description: z.string().max(5000).optional(),
      vehiclePlate: z.string().max(20).optional(),
      employeeId: z.number().nullable().optional(),
      projectId: z.number().optional(),
      costAmount: z.number().min(0).max(100000).nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "edit");
      const existing = await loadIncidentInScope(input.id);
      const { id, status, employeeId, costAmount, ...rest } = input;
      const data: any = { ...rest };
      if (rest.projectId !== undefined) assertProjectAccess(rest.projectId);
      if (employeeId !== undefined && employeeId !== existing.employeeId) {
        requireRole(ctx.user.role, "team_leader");
        if (employeeId) await assertEmployeeAccess(employeeId);
        data.employeeId = employeeId;
        // Mudou o condutor → o novo envolvimento tem de ser (re)confirmado;
        // quem muda já é team leader+, por isso fica confirmado por ele.
        Object.assign(data, employeeId
          ? { driverConfirmed: 1, driverConfirmedById: ctx.user.id, driverConfirmedAt: utcNowStr() }
          : { driverConfirmed: 0, driverConfirmedById: null, driverConfirmedAt: null });
      }
      if (costAmount !== undefined) {
        requireRole(ctx.user.role, "team_leader");
        data.costAmount = costAmount == null ? null : String(costAmount);
      }
      if (status && existing.status === "converted") throw new TRPCError({ code: "BAD_REQUEST", message: `Ocorrência convertida (${existing.convertedToType} #${existing.convertedToId}) — trata-a no registo novo.` });
      if (status) Object.assign(data, incidentStatusPatch(existing, status, utcNowStr(), ctx.user.id));
      await updateIncident(id, data);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "incident", entityId: id, details: JSON.stringify(data).slice(0, 500) });
      return { success: true };
    }),

    // Confirmar/retirar o envolvimento do condutor (só então conta pontos).
    confirmDriver: protectedProcedure.input(z.object({ id: z.number(), confirmed: z.boolean() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "edit");
      const inc = await loadIncidentInScope(input.id);
      if (!inc.employeeId) throw new TRPCError({ code: "BAD_REQUEST", message: "Ocorrência sem condutor" });
      await updateIncident(input.id, input.confirmed
        ? { driverConfirmed: 1, driverConfirmedById: ctx.user.id, driverConfirmedAt: utcNowStr() }
        : { driverConfirmed: 0, driverConfirmedById: ctx.user.id, driverConfirmedAt: utcNowStr() });
      await logActivity({ userId: ctx.user.id, action: "update", entity: "incident", entityId: input.id, details: input.confirmed ? "Envolvimento do condutor confirmado" : "Envolvimento do condutor retirado" });
      return { success: true };
    }),

    delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "super_admin");
      await loadIncidentInScope(input.id);
      await deleteIncident(input.id);
      await logActivity({ userId: ctx.user.id, action: "delete", entity: "incident", entityId: input.id });
      return { success: true };
    }),

    stats: protectedProcedure.input(z.object({
      projectId: z.number().optional(),
      noProject: z.boolean().optional(),
    }).optional()).query(({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "view");
      return getIncidentStats(input);
    }),

    dashboard: protectedProcedure.input(z.object({ projectId: z.number().optional(), noProject: z.boolean().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "ocorrencias", "view");
        const { getIncidentDashboard } = await import("./caseOps");
        const d = await getIncidentDashboard(input ?? {});
        return hasRole(ctx.user.role, "team_leader") ? d : { ...d, repeatDrivers: [] };
      }),

    // Nota rápida no tratamento da ocorrência (as ocorrências não têm tabela
    // de mensagens — as notas empilham-se no campo resolution, datadas).
    addNote: protectedProcedure.input(z.object({
      id: z.number(),
      note: z.string().min(1).max(2000),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "edit");
      await loadIncidentInScope(input.id);
      const { appendIncidentNote } = await import("./caseOps");
      await appendIncidentNote(input.id, ctx.user.name ?? "—", input.note);
      return { success: true };
    }),

    // Conversões NÃO destrutivas: cria o registo novo e fecha esta ocorrência
    // como 'converted', ligada nos dois sentidos. Admin+.
    convertToComplaint: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "manage");
      await loadIncidentInScope(input.id);
      const { convertIncident } = await import("./caseOps");
      let r: { newId: number };
      try { r = await convertIncident(input.id, "complaint", { id: ctx.user.id, name: ctx.user.name }); }
      catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "Erro ao converter" }); }
      await logActivity({ userId: ctx.user.id, action: "update", entity: "complaint", entityId: r.newId, details: `Convertida da ocorrência #${input.id}` });
      return r;
    }),

    convertToLostFound: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "manage");
      await loadIncidentInScope(input.id);
      const { convertIncident } = await import("./caseOps");
      let r: { newId: number };
      try { r = await convertIncident(input.id, "lost", { id: ctx.user.id, name: ctx.user.name }); }
      catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "Erro ao converter" }); }
      await logActivity({ userId: ctx.user.id, action: "update", entity: "lost_found", entityId: r.newId, details: `Convertida da ocorrência #${input.id}` });
      return r;
    }),
  }),

  // ─── AVALIAÇÃO DE DESEMPENHO ─────────────────────────────────────────────
  performance: router({
    // Agregado por período (Dia/Semana/Mês/Ano — padrão de datas do Jorge):
    // soma as semanas ISO que intersectam [from,to] por colaborador.
    range: protectedProcedure.input(z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "avaliacao", "view");
      // semanas ISO que intersectam o período
      const weeks: Array<{ week: number; year: number }> = [];
      const d = new Date(`${input.from}T00:00:00`);
      const dow = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - dow); // segunda da 1ª semana
      const end = new Date(`${input.to}T00:00:00`);
      const isoWeek = (x: Date) => {
        const t = new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()));
        const dn = t.getUTCDay() || 7;
        t.setUTCDate(t.getUTCDate() + 4 - dn);
        const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
        return { week: Math.ceil((((t.getTime() - ys.getTime()) / 86400000) + 1) / 7), year: t.getUTCFullYear() };
      };
      while (d <= end && weeks.length < 60) {
        weeks.push(isoWeek(d));
        d.setDate(d.getDate() + 7);
      }
      let rows: any[] = [];
      for (const w of weeks) {
        rows.push(...await getPerformanceEvaluations({ weekNumber: w.week, yearNumber: w.year }));
      }
      // team_leader: só a equipa (condutores/extras abaixo dele na cidade)
      rows = await filterBelowEmployees(ctx.user, "avaliacao", rows);
      // agrega por colaborador
      const byEmp = new Map<number, any>();
      for (const r of rows) {
        const a = byEmp.get(r.employeeId) ?? {
          employeeId: r.employeeId, hoursWorked: 0, movementsCount: 0,
          incidentsPositive: 0, incidentsNegative: 0, positivePoints: 0,
          negativePoints: 0, totalPoints: 0, weeklyCost: 0, weeks: 0,
        };
        a.hoursWorked += Number(r.hoursWorked || 0);
        a.movementsCount += Number(r.movementsCount || 0);
        a.incidentsPositive += Number(r.incidentsPositive || 0);
        a.incidentsNegative += Number(r.incidentsNegative || 0);
        a.positivePoints += Number(r.positivePoints || 0);
        a.negativePoints += Number(r.negativePoints || 0);
        a.totalPoints += Number(r.totalPoints || 0);
        a.weeklyCost += Number(r.weeklyCost || 0);
        a.weeks += 1;
        byEmp.set(r.employeeId, a);
      }
      return Array.from(byEmp.values())
        .map((a) => ({ ...a, movementsPerHour: a.hoursWorked > 0 ? Math.round((a.movementsCount / a.hoursWorked) * 10) / 10 : 0 }))
        .sort((a, b) => b.totalPoints - a.totalPoints);
    }),

    list: protectedProcedure.input(z.object({
      weekNumber: z.number().optional(),
      yearNumber: z.number().optional(),
      employeeId: z.number().optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "avaliacao", "view", { allowOwn: true });
      // extra: só a própria avaliação, e apenas a semana mais recente
      if (isOwnOnly(ctx.user, "avaliacao")) {
        const me = await getEmployeeByUserId(ctx.user.id);
        if (!me) return [];
        const mine = await getPerformanceEvaluations({ employeeId: me.employee.id });
        if (mine.length === 0) return [];
        const latest = mine.reduce((a: any, b: any) =>
          b.yearNumber > a.yearNumber || (b.yearNumber === a.yearNumber && b.weekNumber > a.weekNumber) ? b : a);
        return mine.filter((r: any) => r.yearNumber === latest.yearNumber && r.weekNumber === latest.weekNumber);
      }
      return filterBelowEmployees(ctx.user, "avaliacao", await getPerformanceEvaluations(input) as any[]);
    }),

    // Gerar, editar e apagar a avaliação SEMANAL antiga saíram (P3 lote 15b):
    // nenhum ecrã os usava, o "apagar" era definitivo e o "editar" não olhava
    // à cidade nem dizia o que mudou. A tabela fica (o cron de segunda-feira
    // continua a gerá-la); os ajustes fazem-se na Avaliação (evaluation.adjust,
    // com motivo e histórico).
  }),

  // ─── SERVIÇOS ────────────────────────────────────────────────────────────
  services: router({
    // (O antigo CRUD de serviços internos — list/create/update/delete/stats
    //  sobre a tabela `services` — foi removido a 2026-08-06: nunca teve UI.
    //  Os serviços reais vêm das reservas Multipark, abaixo.)

    // Dá baixa / reabre um serviço na app. O detalhe (webhook) preserva o done local
    // (upsertBookingExtras faz OR com o que a API mandar).
    // "Feito" de um serviço extra: guardado cá (a BD da Multipark é só de leitura),
    // por linha de serviço; só serviços de reservas das cidades de quem marca.
    setExtraDone: protectedProcedure.input(z.object({
      bookingId: z.string().trim().min(1).max(128),
      lineId: z.string().trim().min(1).max(128),
      done: z.boolean(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "servicos", "edit");
      const { getDb } = await import("./db");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
      const mpDown = () => { throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD da Multipark sem resposta." }); };
      // A linha tem de ser DESTA reserva (antes podia mandar-se a reserva de cá com a linha de outra cidade).
      const { serviceLine } = await import("./multiparkDb/serviceExtras");
      const line = await serviceLine(input.lineId).catch(mpDown);
      if (!line || line.bookingId !== input.bookingId) throw new TRPCError({ code: "BAD_REQUEST", message: "Este serviço não é desta reserva." });
      // Feito na app Multipark conta sempre (feito = Multipark OU cá): reabrir
      // cá não o desfazia e a página mostrava-o "Pendente" com a tarefa fechada.
      if (!input.done && line.done) throw new TRPCError({ code: "BAD_REQUEST", message: "Este serviço está feito na app Multipark — reabre-se lá." });
      const cities = scopedCityNames();
      if (cities !== undefined) {
        const { liveBookingByRef } = await import("./multiparkDb/bookingSearch");
        const b = await liveBookingByRef(input.bookingId, { cities }).catch(mpDown);
        if (!b || b.id !== input.bookingId) throw new TRPCError({ code: "FORBIDDEN", message: "Este serviço pertence a outra cidade." });
      }
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`INSERT INTO service_extra_done (bookingExternalId, lineId, done, userId) VALUES (${input.bookingId}, ${input.lineId}, ${input.done ? 1 : 0}, ${ctx.user.id})
        ON DUPLICATE KEY UPDATE done = VALUES(done), userId = VALUES(userId), bookingExternalId = VALUES(bookingExternalId)`);
      await logActivity({ userId: ctx.user.id, action: input.done ? "complete" : "reopen", entity: "booking_extra", details: `${input.bookingId}:${input.lineId}` } as any);
      // "Feito" fecha já a tarefa gerada por este serviço (e no Google). Reabrir o
      // serviço não reabre a tarefa: reabre-se à mão em Tarefas, se for preciso.
      let tasksClosed = 0;
      if (input.done) {
        const { closeServiceTaskForLine } = await import("./serviceTasks");
        tasksClosed = await closeServiceTaskForLine(input.bookingId, input.lineId, ctx.user.id).catch((err) => {
          // o "feito" já ficou gravado; a volta das 18:00 fecha a tarefa
          console.warn("[services.setExtraDone] fechar tarefa:", (err as Error)?.message);
          return 0;
        });
      }
      return { success: true, tasksClosed };
    }),

    // Tarefas geradas pelos serviços (trabalho services-tasks): link na página /servicos.
    // Mesmo período da lista (prazo da tarefa = saída do carro, dias de Lisboa).
    generatedTasks: protectedProcedure.input(z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "servicos", "view");
      const { serviceTasksInRange } = await import("./serviceTasks");
      return serviceTasksInRange(input.startDate, input.endDate);
    }),

    // Serviços extra das reservas — AO VIVO da BD da Multipark (reservas ao
    // vivo, parte B): reservas não canceladas com saída no período (dias de
    // Lisboa), nos nossos parques do projeto pedido e das cidades de quem vê.
    // O "feito" é o da Multipark ou o marcado cá (service_extra_done).
    multiparkExtras: protectedProcedure.input(z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      projectId: z.number().optional(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "servicos", "view");
      const { lisbonDayRangeUtc } = await import("../shared/lisbonDay");
      const { liveParkScope } = await import("./opsStatsLive");
      const { readServiceExtras, SERVICE_EXTRAS_LIMIT } = await import("./multiparkDb/serviceExtras");
      const { serviceDoneState } = await import("../shared/serviceDone");
      const range = lisbonDayRangeUtc(input.startDate, input.endDate);
      const { parkIds, parkInfo } = await liveParkScope(input.projectId);
      let lines;
      try {
        lines = await readServiceExtras({ start: range.start, end: range.end, parkIds });
      } catch (err) {
        console.warn("[services.multiparkExtras] BD da Multipark:", (err as Error)?.message);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Serviços indisponíveis (BD da Multipark sem resposta)." });
      }
      // O "feito" marcado CÁ (por linha), com quem e quando.
      const doneLocal = new Map<string, { done: boolean; by: string | null; at: string | null }>();
      const ids = [...new Set(lines.map((l) => l.lineId))];
      if (ids.length) {
        const { getDb } = await import("./db");
        const db = await getDb();
        const { sql } = await import("drizzle-orm");
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível: não dá para saber o que já foi dado como feito." });
        for (let i = 0; i < ids.length; i += 1000) {
          const chunk = ids.slice(i, i + 1000);
          const [rows] = (await db.execute(sql`SELECT d.lineId, d.done, DATE_FORMAT(d.updatedAt, '%Y-%m-%d %H:%i:%s') AS updatedAt, u.name AS userName
              FROM service_extra_done d LEFT JOIN users u ON u.id = d.userId
             WHERE d.lineId IN (${sql.join(chunk.map((x) => sql`${x}`), sql`, `)})`)) as any;
          for (const r of rows as any[]) doneLocal.set(String(r.lineId), { done: Number(r.done) === 1, by: r.userName ? String(r.userName) : null, at: r.updatedAt ? String(r.updatedAt) : null });
        }
      }
      const services = lines.map((l) => {
        const info = parkInfo.get(l.parkId);
        const parkName = info?.name ?? "";
        return {
          id: l.lineId,
          bookingId: l.bookingId,
          extraId: l.lineId,
          bookingNumber: l.bookingNumber,
          licensePlate: l.plate ?? "",
          clientName: l.clientName ?? "",
          parkName: info?.city && parkName && !parkName.includes(info.city) ? `${parkName} ${info.city}` : parkName,
          checkOut: l.checkOut ?? "",
          serviceName: l.serviceName ?? "?",
          price: l.price,
          ...serviceDoneState(l.done, doneLocal.get(l.lineId)),
        };
      });
      // Teto da leitura: se o atingir, a lista está cortada — diz-se.
      return { total: services.length, services, truncated: lines.length >= SERVICE_EXTRAS_LIMIT, limit: SERVICE_EXTRAS_LIMIT };
    }),
  }),

  // ─── FATURAÇÃO ───────────────────────────────────────────────────────────
  invoices: router({
    // (CRUD de faturas manuais removido: nunca usado; a tabela `invoices` fica.)
    // Diagnóstico cru: várias somas e breakdowns para isolar discrepâncias
    diagnose: protectedProcedure
      .input(z.object({ from: z.string(), to: z.string(), projectId: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        // Somas de receita — mesma restrição de totais que a Faturação
        await requireFinanceTotals(ctx.user, "faturacao", "manage");
        const { diagnoseBilling } = await import("./db");
        return diagnoseBilling(input);
      }),

    billing: protectedProcedure.input(z.object({
      granularity: z.enum(["day", "week", "month", "year"]).optional(),
      from: z.string(),
      to: z.string(),
      projectId: z.number().optional(),
    })).query(async ({ ctx, input }) => {
      // Margens, salários (com detalhe por pessoa) e comissões — admin+, e
      // respeita o deny de finance.view_totals por utilizador
      await requireFinanceTotals(ctx.user, "faturacao", "view");
      return getBillingData(input);
    }),

    // Caixa: recebido / por cobrar / no-shows pré-pagos (ver server/finance/cash.ts)
    cash: protectedProcedure.input(z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      projectId: z.number().optional(),
    })).query(async ({ ctx, input }) => {
      await requireFinanceTotals(ctx.user, "faturacao", "view");
      const { computeCash } = await import("./finance/cash");
      return computeCash(input);
    }),

    // Financeiro (dashboard): MESMO motor e MESMA base da Faturação (entregues
    // CHECKED_OUT, tudo sem IVA, receita e custos no mesmo período) — sem o
    // detalhe por pessoa. Porta do módulo Financeiro.
    financeSummary: protectedProcedure.input(z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      projectId: z.number().optional(),
    })).query(async ({ ctx, input }) => {
      await requireFinanceTotals(ctx.user, "financeiro", "view");
      const { computeFinance } = await import("./finance/engine");
      const r = await computeFinance({ ...input, granularity: "month" });
      return {
        range: r.range, asOf: r.asOf, isCurrentPeriod: r.quality.isCurrentPeriod,
        revenue: r.revenue,
        costs: { expensesNet: r.costs.expensesNet, personnel: r.margin.personnel, extrasDia: r.costs.extrasDia, commissions: r.margin.commissions, totalNet: r.costs.totalNet },
        margin: { margin: r.margin.margin, marginPct: r.margin.marginPct },
        projection: r.projection,
        monthly: r.timeseries.map((p) => ({ month: p.bucket, revenueNet: p.producedNet, costsNet: p.totalCost, margin: p.margin, revenueForecastNet: p.revenueForecastNet, costForecast: p.costForecast })),
        expensesByCategory: r.details.expenses.reduce((acc, e) => { const k = e.categoryName ?? "Sem categoria"; acc[k] = (acc[k] ?? 0) + e.totalNet; return acc; }, {} as Record<string, number>),
        excludedExpenses: r.quality.excludedExpenses.total,
      };
    }),

    // Exportação CSV/XLSX (Faturação: cartões, série e detalhe; Anual: meses).
    // Porta: ação export da Faturação + totais financeiros.
    export: protectedProcedure.input(z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("billing"), format: z.enum(["xlsx", "csv"]),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        projectId: z.number().optional(), granularity: z.enum(["day", "week", "month", "year"]).optional(),
      }),
      z.object({ kind: z.literal("annual"), format: z.enum(["xlsx", "csv"]), year: z.number().int().min(2000).max(2100), projectId: z.number().optional() }),
    ])).mutation(async ({ ctx, input }) => {
      const { assertCanExportFinance, billingExportSheets, annualExportSheets, sheetsToFile } = await import("./finance/export");
      assertCanExportFinance(ctx.user);
      await requireFinanceTotals(ctx.user, "faturacao", "export");
      const projectLabel = input.projectId ? (await getProjects()).find((p: any) => p.id === Math.abs(input.projectId!))?.name ?? String(input.projectId) : null;
      let file;
      if (input.kind === "billing") {
        const data = await getBillingData(input);
        file = sheetsToFile(billingExportSheets(data, { from: input.from, to: input.to, projectLabel }), input.format, `faturacao-${input.from}-a-${input.to}`);
      } else {
        requireAccess(ctx.user, "anual", "view");
        const months = await getAnnualBreakdown(input.year, input.projectId);
        file = sheetsToFile(annualExportSheets(months, { year: input.year, projectLabel }), input.format, `anual-${input.year}`);
      }
      await logActivity({ userId: ctx.user.id, action: "export", entity: input.kind === "billing" ? "faturacao" : "anual", details: `${file.filename}` });
      return file;
    }),
  }),

  // ─── PASSAGEM DE TURNO ───────────────────────────────────────────────────
  shiftHandover: router({
    // Team leaders preenchem; supervisor+ consulta o histórico e o resumo do dia.
    // A cidade (`city`) passa pelo filtro de cidades do middleware
    // (hasForeignCityFilter → FORBIDDEN fora das cidades do utilizador).
    save: protectedProcedure.input(z.object({
      handoverDate: handoverDaySchema,
      shift: z.enum(["morning", "night"]),
      city: z.enum(HANDOVER_CITIES),
      // Lock otimista: versão carregada pelo formulário (null = registo novo).
      expectedVersion: z.number().int().min(1).nullable().optional(),
      carsForCovered: z.number().int().min(0).max(100_000).nullable().optional(),
      chargedUntilDate: z.string().refine(isIsoDay, "Data inválida").nullable().optional(),
      cashClosedInSafe: z.boolean().nullable().optional(),
      checkoutCashDone: z.boolean().nullable().optional(),
      frontPouchValue: z.number().finite().min(0).max(1_000_000).nullable().optional(),
      terminalPouchValue: z.number().finite().min(0).max(1_000_000).nullable().optional(),
      ticketsExpensesPaid: z.number().finite().min(0).max(1_000_000).nullable().optional(),
      mbRolls: z.number().int().min(0).max(100_000).nullable().optional(),
      mbRollsInPouch: z.number().int().min(0).max(100_000).nullable().optional(),
      pensInPouch: z.number().int().min(0).max(100_000).nullable().optional(),
      mbBattery: z.number().int().min(0).max(100).nullable().optional(),
      pdasCharged: z.boolean().nullable().optional(),
      // `uniformsCount` (legado) saiu da API: a coluna fica e o UPDATE já não
      // lhe toca, por isso os registos antigos mantêm o valor.
      // "Material OK?" + exceções (canetas/rolos/bateria agrupados).
      materialOk: z.boolean().nullable().optional(),
      materialExceptions: z.array(z.object({
        code: z.enum(MATERIAL_EXCEPTIONS),
        note: z.string().max(200).nullable().optional(),
      })).max(MATERIAL_EXCEPTIONS.length).nullable().optional(),
      // Pendentes que passam de turno (resolved por item).
      openItems: z.array(openItemSchema).max(OPEN_ITEMS_MAX).nullable().optional(),
      // Fardamento entregue: peças com quantidade e tamanho (shared/clothing.ts).
      clothingItems: z.array(z.object({
        type: z.enum(CLOTHING_TYPES),
        size: z.enum(CLOTHING_SIZES),
        qty: z.number().int().min(1).max(CLOTHING_MAX_QTY),
      })).max(CLOTHING_MAX_ITEMS).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "passagem_turno", "edit");
      if (input.handoverDate > maxHandoverDate()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Não é possível registar passagens de turno para depois de amanhã." });
      }
      const { saveShiftHandover } = await import("./db");
      const { handoverDate, shift, city, expectedVersion, ...values } = input;
      const { canEditOldHandover } = await import("../shared/shiftHandover");
      const result = await saveShiftHandover({ handoverDate, shift, city }, {
        ...values,
        // Linhas repetidas (mesmo tipo+tamanho) somam-se antes de gravar.
        clothingItems: values.clothingItems == null ? values.clothingItems : normalizeClothingItems(values.clothingItems),
        // Quem resolve e quando é carimbado na gravação (saveShiftHandover), a
        // partir da conta — nunca do que o formulário manda.
      }, {
        expectedVersion,
        userId: ctx.user.id,
        userName: ctx.user.name ?? null,
        // Passadas 24h desde a criação: a mesma regra do ecrã (com overrides).
        canEditOld: canEditOldHandover(withOverrides(ctx.user)),
      });
      await logActivity({
        userId: ctx.user.id,
        action: result.mode === "insert" ? "create" : "update",
        entity: "shift_handover",
        details: `${handoverDate} ${shift} ${city}` + (result.changed.length ? ` — alterado: ${result.changed.join(", ")}` : " — sem alterações"),
      });
      // Resumo automático, IA, pendentes, notificação e email — nunca falham a gravação.
      let automation: Awaited<ReturnType<typeof import("./shiftHandoverAutomation").afterHandoverSave>> | null = null;
      try {
        const { afterHandoverSave } = await import("./shiftHandoverAutomation");
        automation = await afterHandoverSave({ key: { handoverDate, shift, city }, mode: result.mode, userId: ctx.user.id, userName: ctx.user.name ?? null });
      } catch (err: any) {
        console.warn("[handover] automação:", String(err?.message ?? err).slice(0, 200));
      }
      return { success: true, mode: result.mode, automation };
    }),

    // Resumo automático do turno (rascunho) — só leitura, dentro da cidade.
    draft: protectedProcedure.input(z.object({
      date: handoverDaySchema,
      shift: z.enum(["morning", "night"]),
      city: z.enum(HANDOVER_CITIES),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "passagem_turno", "edit");
      const { buildHandoverDraft } = await import("./shiftHandoverDraft");
      return buildHandoverDraft({ date: input.date, shift: input.shift, city: input.city });
    }),

    // "Estado do parque (ao vivo)": carros no parque por garagem/lugar,
    // operações em curso, próximas recolhas/entregas, ocorrências por resolver,
    // caixa por fechar e bloqueios de amanhã — lidos AO VIVO da BD da
    // Multipark (só leitura), só dos parques da cidade escolhida. Nunca lança
    // por falta de BD — devolve { available:false, reason }.
    liveState: protectedProcedure.input(z.object({
      city: z.enum(HANDOVER_CITIES),
      windowHours: z.number().int().min(1).max(24).optional(),
    })).query(async ({ ctx, input }) => {
      // A cidade passa pelo filtro de cidades do middleware (como o `draft`).
      requireAccess(ctx.user, "passagem_turno", "view");
      const { getMultiparkShiftState } = await import("./multiparkDb/shiftState");
      const { shiftWindowUtc } = await import("../shared/shiftHandoverAuto");
      const { operationalShift } = await import("../shared/shiftHandover");
      const nowMs = Date.now();
      const opShift = operationalShift(nowMs);
      const win = shiftWindowUtc(opShift);
      const { getSetting } = await import("./appSettings");
      const { addDays } = await import("../shared/lisbonDay");
      const r = await getMultiparkShiftState({
        cities: [input.city], nowMs,
        // "Amanhã" = o dia a seguir ao dia OPERACIONAL: às 02:30 a noite ainda é de ontem.
        blocksDay: addDays(opShift.date, 1),
        excludedParkIds: (await getSetting("operations.excludedParks")) ?? [],
        upcoming: { startMs: nowMs, endMs: nowMs + (input.windowHours ?? 8) * 3_600_000 },
        cash: { startMs: win.startMs, endMs: Math.max(win.startMs, Math.min(nowMs, win.endMs)) },
      });
      if (!r.available) return { available: false as const, reason: r.reason, code: r.code };
      return { available: true as const, ...r.data };
    }),

    // Resumo por IA a pedido (5 pontos PT-PT); guarda-o se a passagem já existir.
    aiSummary: protectedProcedure.input(z.object({
      date: handoverDaySchema,
      shift: z.enum(["morning", "night"]),
      city: z.enum(HANDOVER_CITIES),
      notes: z.string().max(2000).nullable().optional(),
      openItems: z.array(openItemSchema).max(OPEN_ITEMS_MAX).nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "passagem_turno", "edit");
      const { generateAiSummary } = await import("./shiftHandoverAutomation");
      const { aiTrpcError } = await import("./_core/ai/trpcError");
      const { buildHandoverDraft } = await import("./shiftHandoverDraft");
      const draft = await buildHandoverDraft({ date: input.date, shift: input.shift, city: input.city }).catch(() => null);
      let text: string | null;
      try {
        text = await generateAiSummary(draft, { city: input.city, shift: { date: input.date, shift: input.shift }, notes: input.notes ?? null, openItems: (input.openItems ?? []) as any }, { throwOnError: true, userId: ctx.user.id });
      } catch (err) {
        throw aiTrpcError(err);
      }
      if (!text) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível gerar o resumo agora — tenta outra vez." });
      const { saveHandoverAiSummary } = await import("./shiftHandoverAutomation");
      const { canEditOldHandover } = await import("../shared/shiftHandover");
      // Mesma regra das 24h que a gravação; e fica registado quem o gerou.
      const savedId = await saveHandoverAiSummary({ handoverDate: input.date, shift: input.shift, city: input.city }, text, { canEditOld: canEditOldHandover(withOverrides(ctx.user)) });
      if (savedId != null) await logActivity({ userId: ctx.user.id, action: "update", entity: "shift_handover", entityId: savedId, details: `Resumo IA gerado — ${input.date} ${input.shift} ${input.city}` });
      return { aiSummary: text, saved: savedId != null };
    }),

    // "Recebi" — o team leader que entra confirma (nunca o autor).
    ack: protectedProcedure.input(z.object({
      id: z.number().int().positive(),
      city: z.enum(HANDOVER_CITIES),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "passagem_turno", "edit");
      const { ackHandover } = await import("./shiftHandoverAutomation");
      const r = await ackHandover(input.id, input.city, { id: ctx.user.id, name: ctx.user.name ?? null });
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.message });
      await logActivity({ userId: ctx.user.id, action: "update", entity: "shift_handover", entityId: input.id, details: `Recebi — passagem ${input.id} (${input.city})` });
      return { success: true };
    }),

    // Cumprimento por turno e cidade + % a 30 dias (Resumo do dia).
    compliance: protectedProcedure.input(z.object({
      date: handoverDaySchema,
      city: z.enum(HANDOVER_CITIES).optional(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "passagem_resumo_dia", "view");
      const { getHandoverCompliance } = await import("./shiftHandoverAutomation");
      return getHandoverCompliance(input.date, input.city ?? null);
    }),

    list: protectedProcedure.input(z.object({
      from: handoverDaySchema.optional(),
      to: handoverDaySchema.optional(),
      city: z.enum(HANDOVER_CITIES).optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "passagem_turno", "view");
      const { listShiftHandovers } = await import("./db");
      return listShiftHandovers(input ?? {});
    }),

    supervisorDashboard: protectedProcedure.input(z.object({
      date: handoverDaySchema,
      // Opcional: restringe o resumo a uma cidade (dentro das do utilizador).
      city: z.enum(HANDOVER_CITIES).optional(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "passagem_resumo_dia", "view");
      const { getSupervisorDayDashboard } = await import("./db");
      return getSupervisorDayDashboard(input.date);
    }),
  }),

  // ─── PARCERIAS ───────────────────────────────────────────────────────────
  partnerships: router({
    analytics: protectedProcedure.input(z.object({
      from: z.string(),
      to: z.string(),
      projectId: z.number().optional(),
    })).query(({ ctx, input }) => {
      requireAccess(ctx.user, "parcerias", "view");
      return getPartnershipAnalytics(input);
    }),

    list: protectedProcedure.input(z.object({
      projectId: z.number().optional(),
      partnerType: z.string().optional(),
      status: z.string().optional(),
    }).optional()).query(({ ctx, input }) => {
      requireAccess(ctx.user, "parcerias", "view");
      return getPartnerships(input);
    }),

    create: protectedProcedure.input(z.object({
      name: z.string().min(1),
      campaignKey: z.string().optional(),
      partnerType: z.string().min(1).max(64),
      contactName: z.string().optional(),
      contactEmail: z.string().optional(),
      contactPhone: z.string().optional(),
      commissionRate: z.number().optional(),
      // Base da comissão: 'net' (sem IVA — regra do dono) | 'gross' (exceção)
      commissionBase: z.enum(["net", "gross"]).optional(),
      monthlyFee: z.number().optional(),
      nif: z.string().optional(),
      billingAgreement: z.string().optional(),
      notes: z.string().optional(),
      // id do parceiro na BD da Multipark ("Partner".userId) — liga o registo à tab Parceiros
      multiparkPartnerId: z.string().trim().max(128).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "parcerias", "manage");
      const name = input.name.trim();
      if (await partnershipNameExists(name)) {
        throw new TRPCError({ code: "CONFLICT", message: `Já existe um parceiro com o nome "${name}". Usa "Associar a existente" ou escolhe outro nome.` });
      }
      const { nif, ...rest } = input;
      // Criado pelo formulário completo (envia comissão/avença) = configurado.
      // Criado só com nome e tipo (Associar métodos de pagamento) fica "Por configurar".
      const configured = input.commissionRate !== undefined || input.monthlyFee !== undefined;
      const id = await createPartnership({ ...rest, multiparkPartnerId: rest.multiparkPartnerId || null, name, partnerNif: nif, ...(configured ? { configuredAt: new Date().toISOString().slice(0, 19).replace("T", " ") } : {}) });
      // um id da Multipark só num registo (sai de outro que o tivesse)
      if (id && rest.multiparkPartnerId) await setPartnershipMultiparkId(id, rest.multiparkPartnerId);
      await logActivity({ userId: ctx.user.id, action: "create", entity: "partnership", entityId: id || 0, details: `Parceria: ${input.name}` });
      return { id };
    }),

    update: protectedProcedure.input(z.object({
      id: z.number(),
      name: z.string().optional(),
      campaignKey: z.string().optional(),
      partnerType: z.string().min(1).max(64).optional(),
      contactName: z.string().optional(),
      contactEmail: z.string().optional(),
      contactPhone: z.string().optional(),
      commissionRate: z.number().optional(),
      // Base da comissão: 'net' (sem IVA — regra do dono) | 'gross' (exceção)
      commissionBase: z.enum(["net", "gross"]).optional(),
      monthlyFee: z.number().optional(),
      nif: z.string().optional(),
      billingAgreement: z.string().optional(),
      partnerStatus: z.enum(["active", "inactive", "pending"]).optional(),
      notes: z.string().optional(),
      multiparkPartnerId: z.string().trim().max(128).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "parcerias", "manage");
      const { id, nif, ...rest } = input;
      if (rest.name !== undefined) {
        rest.name = rest.name.trim();
        if (await partnershipNameExists(rest.name, id)) {
          throw new TRPCError({ code: "CONFLICT", message: `Já existe outro parceiro com o nome "${rest.name}".` });
        }
      }
      // Gravar no ecrã tira o parceiro da fila "Por configurar" (0% passa a ser
      // uma taxa confirmada e não "em falta" nas finanças).
      if (rest.multiparkPartnerId !== undefined) (rest as { multiparkPartnerId?: string | null }).multiparkPartnerId = rest.multiparkPartnerId || null;
      // R29: o antes → depois dos campos que mexem nas contas fica no registo.
      const beforeRow = await (async () => {
        const { getDb } = await import("./db");
        const d = await getDb();
        if (!d) return null;
        const { partnerships } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        return (await d.select().from(partnerships).where(eq(partnerships.id, id)).limit(1))[0] as Record<string, unknown> | undefined ?? null;
      })().catch(() => null);
      // 0295: ligado à Multipark → tipo, comissão e avença vêm de lá (só leitura aqui)
      if (["partner", "pro", "plan"].includes(String(beforeRow?.multiparkKind ?? ""))) {
        delete (rest as Record<string, unknown>).partnerType;
        delete (rest as Record<string, unknown>).commissionRate;
        delete (rest as Record<string, unknown>).commissionBase;
        delete (rest as Record<string, unknown>).monthlyFee;
        delete (rest as Record<string, unknown>).multiparkPartnerId;
      }
      const patch = { ...rest, ...(nif !== undefined ? { partnerNif: nif } : {}) };
      await updatePartnership(id, { ...patch, configuredAt: new Date().toISOString().slice(0, 19).replace("T", " ") });
      if (rest.multiparkPartnerId) await setPartnershipMultiparkId(id, rest.multiparkPartnerId);
      const { partnerAuditDiff } = await import("./partnerAudit");
      const diff = partnerAuditDiff(beforeRow, patch);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "partnership", entityId: id, ...(diff.text ? { details: diff.text } : {}) });
      return { success: true };
    }),

    // ── Parceiros e parques AO VIVO da BD da Multipark (tabs Parceiros/Parques) ──
    // Cada parceiro liga-se ao nosso registo (contrato/notas) SÓ pelo id da
    // Multipark gravado em partnerships.multiparkPartnerId (sem aliases).
    live: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "parcerias", "view");
      const canSeeTotals = await canSeeFinanceTotals(ctx.user);
      const { readPartnershipsLive, hideLiveMoney, linkRecords } = await import("./multiparkDb/partnerships");
      const r = await readPartnershipsLive(scopedCityNames());
      if (!r.available) return { available: false as const, reason: r.reason };
      const records = (await getPartnerships()).map((p: any) => ({
        id: p.id, name: p.name, partnerType: p.partnerType ?? null, partnerStatus: p.partnerStatus ?? null, multiparkPartnerId: p.multiparkPartnerId ?? null,
      }));
      const d = hideLiveMoney(r.data, canSeeTotals);
      return { available: true as const, canSeeTotals, periods: d.periods, parks: d.parks, partners: linkRecords(d.partners, records) };
    }),

    // Tab "Pró e avenças": SÓ informativa (a conta corrente é do CRM Pro).
    proLive: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "parcerias", "view");
      const canSeeTotals = await canSeeFinanceTotals(ctx.user);
      const { readProLive, hideProMoney } = await import("./multiparkDb/partnershipsPro");
      const r = await readProLive(scopedCityNames());
      if (!r.available) return { available: false as const, reason: r.reason };
      // Ficha do CRM de cada conta Pro (crm_pro_accounts: "Client".id → ficha), só leitura.
      const crmByMp = new Map<string, number>();
      const mpIds = [...new Set(r.data.rows.map((x) => x.mpClientId).filter((x): x is string => !!x))];
      if (mpIds.length) {
        try {
          const { sql } = await import("drizzle-orm");
          const db = await crmDb();
          const res: any = await db.execute(sql`SELECT mpClientId, crmClientId FROM crm_pro_accounts WHERE crmClientId IS NOT NULL AND mpClientId IN (${sql.join(mpIds.map((id) => sql`${id}`), sql`, `)})`);
          const rows: any[] = Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : [];
          for (const x of rows) crmByMp.set(String(x.mpClientId), Number(x.crmClientId));
          // avenças (e Pros sem conta corrente): a ficha do cliente pelo id da Multipark
          const rest = mpIds.filter((id) => !crmByMp.has(id));
          if (rest.length) {
            const ext: any = await db.execute(sql`SELECT externalId, clientId FROM crm_client_external_ids WHERE \`system\` = 'multipark_client' AND externalId IN (${sql.join(rest.map((id) => sql`${id}`), sql`, `)})`);
            const extRows: any[] = Array.isArray(ext) ? (Array.isArray(ext[0]) ? ext[0] : ext) : [];
            for (const x of extRows) crmByMp.set(String(x.externalId), Number(x.clientId));
          }
        } catch { /* sem ligação ao CRM: as linhas ficam sem atalho */ }
      }
      return {
        available: true as const, canSeeTotals, periods: r.data.periods,
        rows: hideProMoney(r.data.rows, canSeeTotals).map((x) => ({ ...x, crmClientId: x.mpClientId ? crmByMp.get(x.mpClientId) ?? null : null })),
      };
    }),

    // ── Parcerias a partir da Multipark (0295): ver antes e aplicar ──
    mpSyncPreview: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "parcerias", "manage");
      const { previewPartnerSync } = await import("./partnerMultiparkSync");
      return previewPartnerSync();
    }),
    mpSyncApply: protectedProcedure
      .input(z.object({ keepIds: z.array(z.number().int().positive()).max(2000).default([]) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "parcerias", "manage");
        if (!["admin", "super_admin"].includes(String(ctx.user.role))) throw new TRPCError({ code: "FORBIDDEN", message: "Só administradores aplicam a ligação à Multipark." });
        const { applyPartnerSync } = await import("./partnerMultiparkSync");
        return applyPartnerSync({ userId: ctx.user.id, keepIds: input.keepIds });
      }),
    // ── Juntar registos (o mesmo parceiro em vários registos) ──
    mergePreview: protectedProcedure
      .input(z.object({ keepId: z.number().int().positive(), dropIds: z.array(z.number().int().positive()).min(1).max(50) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "parcerias", "manage");
        const { previewPartnershipMerge } = await import("./partnershipMerge");
        return previewPartnershipMerge(input.keepId, input.dropIds);
      }),
    merge: protectedProcedure
      .input(z.object({ keepId: z.number().int().positive(), dropIds: z.array(z.number().int().positive()).min(1).max(50) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "parcerias", "manage");
        const { mergePartnerships } = await import("./partnershipMerge");
        const r = await mergePartnerships({ ...input, userId: ctx.user.id });
        await logActivity({ userId: ctx.user.id, action: "merge", entity: "partnership", entityId: input.keepId, details: `Juntos a "${r.keep.name}": ${r.drops.map((x) => `#${x.id} ${x.name}`).join(", ")}`.slice(0, 1000) });
        return r;
      }),
    unmerge: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "parcerias", "manage");
      const { unmergePartnership } = await import("./partnershipMerge");
      const r = await unmergePartnership(input.id);
      await logActivity({ userId: ctx.user.id, action: "unmerge", entity: "partnership", entityId: input.id, details: `Separado de #${r.keepId}` });
      return r;
    }),

    /** Arquivados (sem par na Multipark): ver e repor. */
    archived: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "parcerias", "view");
      return (await getPartnerships({ includeArchived: true })).filter((p: any) => p.archivedAt);
    }),
    unarchive: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "parcerias", "manage");
      const { isMergedPartnership, unmergePartnership } = await import("./partnershipMerge");
      if (await isMergedPartnership(input.id)) await unmergePartnership(input.id);
      else await updatePartnership(input.id, { archivedAt: null, archivedReason: null, multiparkKind: "own" } as any);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "partnership", entityId: input.id, details: "Reposto (tirado do arquivo)" });
      return { success: true };
    }),

    // Liga (ou desliga, null) um registo das Parcerias a um parceiro da Multipark.
    linkMultipark: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), multiparkPartnerId: z.string().trim().min(1).max(128).nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "parcerias", "manage");
        await setPartnershipMultiparkId(input.id, input.multiparkPartnerId);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "partnership", entityId: input.id, details: `Parceiro Multipark: ${input.multiparkPartnerId ?? "(sem ligação)"}` });
        return { success: true };
      }),

    delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "parcerias", "manage");
      await deletePartnership(input.id);
      await logActivity({ userId: ctx.user.id, action: "delete", entity: "partnership", entityId: input.id });
      return { success: true };
    }),

    // Sumário de faturação por parceiro: reservas, receita e valor a faturar
    invoicingSummary: protectedProcedure
      .input(z.object({
        from: z.string(),
        to: z.string(),
        projectId: z.number().optional(),
        partnerType: z.string().optional(),
      }))
      .query(async ({ ctx, input }) => {
        // Receita/valor a faturar: respeita o deny de finance.view_totals.
        await requireFinanceTotals(ctx.user, "parcerias", "view");
        const { getPartnerInvoicingSummary } = await import("./db");
        return getPartnerInvoicingSummary(input);
      }),

    // ── Fecho do mês de parceiros (passo 3): Multipark vs a nossa memória do webhook ──
    closeMonthList: protectedProcedure.input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) })).query(async ({ ctx, input }) => {
      await requireFinanceTotals(ctx.user, "parcerias", "view");
      const { listPartnerClose } = await import("./partnerClose");
      return listPartnerClose(input.month);
    }),
    closeMonthRefresh: protectedProcedure.input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) })).mutation(async ({ ctx, input }) => {
      await requireFinanceTotals(ctx.user, "parcerias", "view");
      requireAccess(ctx.user, "parcerias", "manage");
      const { refreshPartnerClose } = await import("./partnerClose");
      return refreshPartnerClose(input.month);
    }),
    closeMonthClose: protectedProcedure
      .input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), partnerKey: z.string().min(1).max(128), note: z.string().max(2000).nullable() }))
      .mutation(async ({ ctx, input }) => {
        await requireFinanceTotals(ctx.user, "parcerias", "view");
        requireAccess(ctx.user, "parcerias", "manage");
        const { closePartnerMonth } = await import("./partnerClose");
        await closePartnerMonth({ ...input, userId: ctx.user.id });
        await logActivity({ userId: ctx.user.id, action: "close", entity: "partner_month", details: `Fecho ${input.month} · ${input.partnerKey}${input.note ? ` · ${input.note.slice(0, 200)}` : ""}` });
        return { success: true };
      }),
    closeMonthReopen: protectedProcedure
      .input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), partnerKey: z.string().min(1).max(128) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "parcerias", "manage");
        if (!["admin", "super_admin"].includes(String(ctx.user.role))) throw new TRPCError({ code: "FORBIDDEN", message: "Só administradores reabrem um mês fechado." });
        const { reopenPartnerMonth } = await import("./partnerClose");
        await reopenPartnerMonth(input);
        await logActivity({ userId: ctx.user.id, action: "reopen", entity: "partner_month", details: `Reaberto ${input.month} · ${input.partnerKey}` });
        return { success: true };
      }),

    // Marketplace (parques de terceiros em que vendemos): a comissão GRAVADA na
    // Multipark em cada reserva, por parque, das saídas do período (passo 2).
    invoicingMarketplace: protectedProcedure
      .input(z.object({ from: z.string(), to: z.string() }))
      .query(async ({ ctx, input }) => {
        await requireFinanceTotals(ctx.user, "parcerias", "view");
        const { readPartnerBillingLive } = await import("./multiparkDb/partnerBilling");
        const { lisbonDayRangeUtc } = await import("../shared/lisbonDay");
        const range = lisbonDayRangeUtc(input.from, input.to);
        const r = await readPartnerBillingLive({ start: range.start, end: range.end, cities: scopedCityNames() });
        if (!r.available) return { available: false as const, reason: r.reason, rows: [] };
        return { available: true as const, rows: r.data.marketplace };
      }),

    // Detalhe por tipo de parceiro — com colunas específicas do chargeModel
    invoicingDetailByType: protectedProcedure
      .input(z.object({
        from: z.string(),
        to: z.string(),
        projectId: z.number().optional(),
        partnerType: z.string(),
      }))
      .query(async ({ ctx, input }) => {
        await requireFinanceTotals(ctx.user, "parcerias", "view");
        const { getPartnerInvoicingDetailByType } = await import("./db");
        return getPartnerInvoicingDetailByType(input);
      }),

  }),

  // ─── ANUAL ───────────────────────────────────────────────────────────────
  // O relatório anual antigo (list/generate/update/delete sobre annual_reports,
  // divisão parceiro/empresa) saiu a 2 out 2026 — nenhum ecrã o usava e o Anual
  // é o motor das Finanças (breakdown). A tabela e os dados ficam.
  annual: router({

    breakdown: protectedProcedure.input(z.object({
      // Ano inteiro e plausível (um ano lixo era um erro interno do motor)
      year: z.number().int().min(2000).max(2100),
      projectId: z.number().optional(),
    })).query(async ({ ctx, input }) => {
      // Lucros, salários e IVA — reservado à administração e respeita o deny
      // individual de totais (antes o Anual contornava a restrição da Faturação)
      await requireFinanceTotals(ctx.user, "anual", "manage");
      return getAnnualBreakdown(input.year, input.projectId);
    }),

    // ── Histórico financeiro importado (Excel/CSV, 2016→) ──────────────────
    importHistory: protectedProcedure.input(z.object({
      rows: z.array(z.object({
        year: z.number().min(2000).max(2100),
        month: z.number().min(1).max(12),
        revenueWithVat: z.number(),
        expensesWithVat: z.number().optional(),
        salaries: z.number().optional(),
        notes: z.string().optional(),
      })).min(1).max(600),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "anual", "manage");
      const { importFinancialHistory } = await import("./db");
      const res = await importFinancialHistory(input.rows);
      await logActivity({ userId: ctx.user.id, action: "import", entity: "financial_history", details: `${res.imported} meses importados` });
      return res;
    }),

    historyList: protectedProcedure.input(z.object({
      year: z.number().optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "anual", "manage");
      const { getFinancialHistory } = await import("./db");
      return getFinancialHistory(input?.year);
    }),

    historyDeleteYear: protectedProcedure.input(z.object({
      year: z.number(),
    })).mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "super_admin");
      const { deleteFinancialHistoryYear } = await import("./db");
      await logActivity({ userId: ctx.user.id, action: "delete", entity: "financial_history", details: `Ano ${input.year}` });
      return deleteFinancialHistoryYear(input.year);
    }),
  }),

  // ── MULTIPARK INTEGRATION ──────────────────────────────────────────────────
  multipark: router({
    // Pesquisa partilhada de reservas — usada por reclamações, perdidos/achados,
    // ocorrências e críticas Google. Procura por nº reserva / externalId /
    // matrícula / email / nome do cliente. DB local.
    searchBooking: protectedProcedure
      .input(z.object({ search: z.string().min(2) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        return searchBookingByRef(input.search);
      }),

    // Avaliação operacional do dia: por extra (com métricas) + agregado
    // por turno + agregado total. TL recebe também score da equipa.
    dayEvaluation: protectedProcedure
      .input(z.object({ date: z.string(), projectId: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "avaliacao_operacional", "view");
        const { evaluateDay } = await import("./multiparkEvaluation");
        // Movimentos AO VIVO da BD da Multipark (cidades do utilizador); GPS,
        // ponto e escala da nossa BD. Sem BD deles: cópia local + aviso.
        return evaluateDay(input.date, { cities: scopedCityNames() });
      }),

    // Set multipark mapping para um empregado (nome curto + userId)
    setMultiparkAgentMapping: protectedProcedure
      .input(z.object({
        employeeId: z.number(),
        multiparkAgentName: z.string().max(256).nullable().optional(),
        multiparkAgentUserId: z.string().max(128).nullable().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        const { getDb } = await import("./db");
        const db = await getDb(); if (!db) return { success: false };
        const { employees } = await import("../drizzle/schema");
        const { eq: deq } = await import("drizzle-orm");
        const patch: any = {};
        if (input.multiparkAgentName !== undefined) patch.multiparkAgentName = input.multiparkAgentName;
        if (input.multiparkAgentUserId !== undefined) patch.multiparkAgentUserId = input.multiparkAgentUserId;
        await db.update(employees).set(patch).where(deq(employees.id, input.employeeId));
        return { success: true };
      }),

    // Movimentos de um agente num dia operacional, lidos AO VIVO da BD da
    // Multipark ("History": quem, quando, que fase, que reserva). Pelos ids do
    // agente (os da avaliação do dia); sem ids, procura-os pelo nome em "Agent".
    // Nunca lança por falta de BD — devolve { available:false, reason }.
    agentHistorySummary: protectedProcedure
      .input(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        agentUserIds: z.array(z.string().min(1).max(128)).max(20).optional(),
        agentName: z.string().max(256).optional(),
        projectId: z.number().optional(),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "avaliacao_operacional", "view");
        const { findAgentIdsByName, getAgentDayMovements } = await import("./multiparkDb/movements");
        let ids = input.agentUserIds ?? [];
        if (ids.length === 0 && input.agentName?.trim()) {
          const found = await findAgentIdsByName(input.agentName);
          if (!found.available) return { available: false as const, reason: found.reason, code: found.code };
          ids = found.data;
        }
        const r = await getAgentDayMovements({ day: input.date, userIds: ids, cities: scopedCityNames() });
        if (!r.available) return { available: false as const, reason: r.reason, code: r.code };
        const byType: Record<string, number> = {};
        for (const m of r.data.rows) byType[m.changeType] = (byType[m.changeType] ?? 0) + 1;
        return { available: true as const, agentUserIds: ids, total: r.data.rows.length, truncated: r.data.truncated, byType, items: r.data.rows };
      }),

    // Liga (ou desliga) um nome de agente Multipark a um colaborador. Único:
    // limpa o nome de qualquer outro colaborador que o tivesse.
    mapAgentToEmployee: protectedProcedure
      .input(z.object({ agentName: z.string().min(1), employeeId: z.number().nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        const { getDb } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
        // Fase 1: grava também o ID do agente (fiável) e não só o nome
        const { agentIdForName } = await import("./identityLink");
        const agentId = await agentIdForName(input.agentName);
        // limpa o agente de quem o tivesse (nome e id — principal ou agente extra)
        await db.execute(sql`UPDATE employees SET multiparkAgentName = NULL WHERE multiparkAgentName = ${input.agentName}`);
        if (agentId) await db.execute(sql`UPDATE employees SET multiparkAgentUserId = NULL WHERE multiparkAgentUserId = ${agentId}`);
        const { addAgentAlias, removeAgentAlias } = await import("./employeeAliases");
        if (agentId) await removeAgentAlias(agentId).catch(() => {});
        let asAlias = false;
        if (input.employeeId != null) {
          const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];
          const [cur] = rowsOf(await db.execute(sql`SELECT multiparkAgentUserId, multiparkAgentName FROM employees WHERE id = ${input.employeeId} LIMIT 1`));
          const hasOther = cur && ((cur.multiparkAgentUserId && cur.multiparkAgentUserId !== agentId) || (!cur.multiparkAgentUserId && cur.multiparkAgentName && cur.multiparkAgentName !== input.agentName));
          if (hasOther && agentId) {
            // A ficha já tem OUTRO agente principal: este entra como agente extra
            // (a mesma pessoa com várias contas Multipark) — não se sobrepõe.
            await addAgentAlias(input.employeeId, agentId, input.agentName);
            asAlias = true;
          } else {
            await db.execute(sql`UPDATE employees SET multiparkAgentName = ${input.agentName}, multiparkAgentUserId = COALESCE(${agentId}, multiparkAgentUserId) WHERE id = ${input.employeeId}`);
          }
        }
        await logActivity({ userId: ctx.user.id, action: "agent_attach", entity: "employee", entityId: input.employeeId ?? undefined, details: `Agente Multipark "${input.agentName}"${agentId ? ` (${agentId})` : ""} ${input.employeeId != null ? (asAlias ? "ligado como agente extra" : "ligado manualmente") : "desligado"}` });
        return { success: true, asAlias };
      }),

    // Lista leve de colaboradores ativos para o dropdown de mapeamento.
    employeesForMapping: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "view");
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb(); if (!db) return [];
      const r: any = await db.execute(sql`SELECT id, fullName, multiparkAgentName FROM employees WHERE isActive = 1 ORDER BY fullName`);
      return (Array.isArray(r[0]) ? r[0] : r) as any[];
    }),

    // List synced bookings with filters

    // Booking stats (with optional filters)
    bookingStats: protectedProcedure
      .input(z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        projectId: z.number().optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        // Receitas — respeita o deny de finance.view_totals por utilizador
        await requireFinanceTotals(ctx.user, "financeiro", "view");
        return getMultiparkBookingStats(input ?? undefined);
      }),

    // "Reservas do dia" (operacional): entradas e saídas de UM dia de Lisboa,
    // lidas AO VIVO da BD da Multipark (só leitura), de todos os parques das
    // cidades do utilizador MENOS os "Parques que a operação não faz"
    // (Definições → operations.excludedParks). Nunca lança por falta de BD —
    // devolve { available:false, reason }.
    reservasDoDia: protectedProcedure
      .input(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        const { getMultiparkDayBookings } = await import("./multiparkDb/dayBookings");
        const { getSetting } = await import("./appSettings");
        const excluded = (await getSetting("operations.excludedParks")) ?? [];
        const r = await getMultiparkDayBookings(input.day, scopedCityNames(), excluded);
        if (!r.available) return { available: false as const, reason: r.reason, code: r.code };
        return { available: true as const, ...r.data };
      }),

    // Listas por período (Reservas criadas, Recolhas, Entregas, Cancelados),
    // lidas AO VIVO da BD da Multipark: contadores agregados no SQL (com o
    // período anterior para comparar) + uma página da lista. Máx. 62 dias.
    // Só os parques das cidades do utilizador; nunca lança por falta de BD.
    opsList: protectedProcedure
      .input(z.object({
        kind: z.enum(["reservas", "entradas", "saidas", "cancelados"]),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        parkId: z.string().max(64).optional(),
        channel: z.enum(["", "direto", "parceiro", "marketplace"]).optional(),
        state: z.string().max(20).optional(),
        search: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).max(10_000).optional(),
      }).refine((v) => {
        const { rangeDays, OPS_LIST_MAX_DAYS } = opsListsShared;
        const n = rangeDays(v.from, v.to);
        return n >= 1 && n <= OPS_LIST_MAX_DAYS;
      }, { message: "Período inválido (máximo 62 dias)." }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        const { getMultiparkOpsList } = await import("./multiparkDb/opsLists");
        const state = opsListsShared.isOpsListState(input.kind, input.state) ? input.state : "all";
        const r = await getMultiparkOpsList({ ...input, state }, scopedCityNames());
        if (!r.available) return { available: false as const, reason: r.reason, code: r.code };
        return { available: true as const, ...r.data };
      }),

    // "Classificação dos parques": cada Park (marca, cidade, listingType,
    // estado) e a classificação calculada (nosso marca+cidade / Marketplace),
    // lida ao vivo. Mesma permissão e âmbito de cidade das Reservas do dia.
    parkClassification: protectedProcedure
      .query(async ({ ctx }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        const { getMultiparkParkClassification } = await import("./multiparkDb/dayBookings");
        const r = await getMultiparkParkClassification(scopedCityNames());
        if (!r.available) return { available: false as const, reason: r.reason, code: r.code };
        return { available: true as const, ...r.data };
      }),

    // Atividade consolidada de um dia: ações + km/GPS por pessoa (visão Jorge)
    // Dia ou intervalo (Hoje/Ontem/intervalo): ações, no horário/fora, custo
    // dos extras (só com o gate de totais), GPS e ponto por pessoa.
    dayActivity: protectedProcedure
      .input(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        projectId: z.number().optional(),
      }).refine((v) => !!(v.date || v.startDate), { message: "Indica o dia" }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        const start = (input.startDate ?? input.date)!;
        const end = input.endDate && input.endDate >= start ? input.endDate : start;
        const { daysInRange } = await import("../shared/lisbonDay");
        if (daysInRange(start, end).length > 93) throw new TRPCError({ code: "BAD_REQUEST", message: "Intervalo máximo: 93 dias." });
        const canSeeCost = await canSeeFinanceTotals(ctx.user);
        const { getDayActivity } = await import("./db");
        return getDayActivity(start, { endDate: end, canSeeCost });
      }),

    // Gaveta de uma pessoa num dia: ações, GPS (com trajeto), PDAs e ponto.
    personDay: protectedProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), key: z.string().min(3).max(300), projectId: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        const { getPersonDay } = await import("./dayActivity");
        return getPersonDay(input.date, input.key);
      }),

    // Liga um agente Multipark a um PARCEIRO (agências que marcam pelo portal)
    setAgentPartner: protectedProcedure
      .input(z.object({ agentName: z.string().min(1).max(256), partnershipId: z.number().nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "parcerias", "manage");
        const { setAgentPartner } = await import("./db");
        await setAgentPartner(input.agentName, input.partnershipId);
        await logActivity({ userId: ctx.user.id, action: "map", entity: "agent_partner", details: `${input.agentName} → partnership ${input.partnershipId ?? "—"}` });
        return { success: true };
      }),

    agentPartners: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "view");
      const { listAgentPartners } = await import("./db");
      return listAgentPartners();
    }),

    // "Não é funcionário": marca um agente como teste/integração — sai da
    // lista de agentes por ligar (reversível)
    ignoreAgent: protectedProcedure
      .input(z.object({ agentName: z.string().min(1).max(256), ignored: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        const { setAgentIgnored } = await import("./db");
        await setAgentIgnored(input.agentName, input.ignored);
        await logActivity({ userId: ctx.user.id, action: input.ignored ? "ignore" : "unignore", entity: "agent", details: input.agentName });
        return { success: true };
      }),

    ignoredAgents: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "view");
      const { listIgnoredAgents } = await import("./db");
      return listIgnoredAgents();
    }),

    // Agentes SEM funcionário nem parceiro (aba RH "Agentes"). AO VIVO da BD
    // da Multipark ("Agent" + "History" dos últimos 180 dias); a cópia local
    // (já não alimentada desde o PR #141) só se a BD deles não responder.
    unlinkedAgents: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "view");
      const { getDb, listAgentPartners } = await import("./db");
      const db = await getDb();
      const empty = { rows: [] as Array<{ agentName: string; agentUserId: string | null; total: number; checkins: number; checkouts: number; movements: number; firstSeen: string | null; lastSeen: string | null }>, source: "multipark" as "multipark" | "copia", notice: null as string | null };
      if (!db) return empty;
      const { sql } = await import("drizzle-orm");
      const { listLiveAgents } = await import("./multiparkDb/activityLive");
      const live = await listLiveAgents();
      let rows: any[];
      let source: "multipark" | "copia" = "multipark";
      let notice: string | null = null;
      if (live.available) {
        // Agentes só de parceiro (role PARTNER) ficam no grupo dos parceiros (ligam-se à parceria).
        rows = live.data.filter((a) => a.agentName).map((a) => ({
          agentName: a.agentName, agentUserId: a.agentUserId, email: a.email, partnerOnly: !!a.partnerOnly, total: a.total, checkins: a.checkins, checkouts: a.checkouts,
          movements: a.movements, firstSeen: a.firstSeen, lastSeen: a.lastSeen,
        }));
      } else {
        source = "copia";
        notice = `${live.reason} Lista da cópia local (deixou de ser atualizada — agentes novos não aparecem).`;
        [rows] = await db.execute(sql`
          SELECT agentName,
            MAX(agentUserId) AS agentUserId,
            COUNT(*) AS total,
            SUM(changeType IN ('CHECK_IN','CHECKIN')) AS checkins,
            SUM(changeType IN ('CHECK_OUT','CHECKOUT')) AS checkouts,
            SUM(changeType IN ('MOVEMENT','MOVE')) AS movements,
            MIN(actionTime) AS firstSeen,
            MAX(actionTime) AS lastSeen
          FROM multipark_booking_history
          WHERE agentName IS NOT NULL AND agentName != ''
          GROUP BY agentName`) as any;
      }
      const { employees } = await import("../drizzle/schema");
      const linkedEmps = await db.select({ n: employees.multiparkAgentName, id: employees.multiparkAgentUserId }).from(employees);
      const linked = new Set(linkedEmps.map((e) => matchKey(e.n)).filter(Boolean));
      // Fase 1: um agente ligado só pelo ID (outro nome na ficha) também está ligado
      const linkedIds = new Set(linkedEmps.map((e) => (e.id ?? "").trim()).filter(Boolean));
      // agentes EXTRA (pessoa com várias contas Multipark) também estão ligados
      const { listAgentAliases } = await import("./employeeAliases");
      for (const a of await listAgentAliases()) {
        linkedIds.add(a.agentUserId);
        if (a.agentName) linked.add(matchKey(a.agentName));
      }
      const partners = new Set((await listAgentPartners()).map((p) => matchKey(p.agentName)));
      const { listIgnoredAgents } = await import("./db");
      const { looksLikeTestAgent } = await import("./personIdentity");
      const { isSystemAgentId, isNonPersonAgentName, isScriptAgentName } = await import("../shared/agentIdentity");
      const ignored = new Set((await listIgnoredAgents()).map((n) => matchKey(n)));
      const list = (rows as any[])
        .filter((r) => {
          const key = matchKey(String(r.agentName));
          const id = String(r.agentUserId ?? "").trim();
          // agências e parceiros NÃO saem: vão para o grupo "parceiros" (ligar à parceria)
          return !linked.has(key) && !(id && linkedIds.has(id)) && !partners.has(key) && !ignored.has(key) && !looksLikeTestAgent(String(r.agentName))
            && !(id && isSystemAgentId(id)) && !isScriptAgentName(String(r.agentName)) && !/(nome do respons|gest[aã]o das reservas)/i.test(String(r.agentName));
        })
        .map((r) => ({
          agentName: String(r.agentName),
          agentUserId: r.agentUserId ? String(r.agentUserId) : null,
          total: Number(r.total),
          checkins: Number(r.checkins ?? 0),
          checkouts: Number(r.checkouts ?? 0),
          movements: Number(r.movements ?? 0),
          firstSeen: r.firstSeen == null ? null : String(r.firstSeen instanceof Date ? r.firstSeen.toISOString() : r.firstSeen),
          lastSeen: r.lastSeen == null ? null : String(r.lastSeen instanceof Date ? r.lastSeen.toISOString() : r.lastSeen),
          email: r.email ? String(r.email) : null,
          partnerOnly: !!r.partnerOnly,
        }))
        .sort((a, b) => b.total - a.total);
      // Sugestões: ficha (email/nome) para a equipa, parceria para agências e parceiros.
      const rowsOfRaw = (r: any): any[] => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      const empRows = rowsOfRaw(await db.execute(sql`
        SELECT e.id, e.fullName, e.multiparkAgentUserId AS agentId, LOWER(TRIM(e.email)) AS email, LOWER(TRIM(e.personalEmail)) AS personalEmail, LOWER(TRIM(u.email)) AS userEmail
          FROM employees e LEFT JOIN users u ON u.id = e.userId WHERE e.isActive = 1`));
      const partnershipRows = rowsOfRaw(await db.execute(sql`SELECT id, name, contactEmail FROM partnerships`).catch(() => [[]]));
      const { suggestForAgents } = await import("./agentSuggestions");
      const sugg = suggestForAgents(
        list.map((a) => ({ agentName: a.agentName, email: a.email, partnerOnly: a.partnerOnly })),
        empRows.map((e: any) => ({ id: Number(e.id), fullName: String(e.fullName ?? ""), emails: [e.email, e.personalEmail, e.userEmail].filter(Boolean), hasAgent: !!(e.agentId && String(e.agentId).trim()) })),
        partnershipRows.map((p: any) => ({ id: Number(p.id), name: String(p.name ?? ""), contactEmail: p.contactEmail ?? null })),
      );
      list.forEach((a: any, i) => { a.group = sugg[i].group; a.suggestion = sugg[i].suggestion; });
      // Parados: sem movimentos nos últimos UNLINKED_ACTIVE_DAYS dias (ou nunca). Não saem da
      // Multipark, só ficam fora da lista principal (a UI mostra-os se pedires).
      const { UNLINKED_ACTIVE_DAYS, isStaleAgent } = await import("../shared/agentIdentity");
      const active = list.filter((a) => !isStaleAgent(a.total, a.lastSeen));
      const stale = list.filter((a) => isStaleAgent(a.total, a.lastSeen));
      return { rows: active, stale, staleDays: UNLINKED_ACTIVE_DAYS, source, notice };
    }),

    // Cria um funcionário-extra a partir de um agente órfão (aba RH)
    createEmployeeFromAgent: protectedProcedure
      .input(z.object({ agentName: z.string().min(1).max(256), email: z.string().email().optional(), projectId: z.number().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        const { getDb } = await import("./db");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        const { employees, projects } = await import("../drizzle/schema");
        const { eq, and } = await import("drizzle-orm");
        // ── ANTI-DUPLICAÇÃO (regra do Jorge: uma pessoa é só uma pessoa) —
        // mesma verificação do rh.create: nome normalizado ou email já ativos
        {
          const norm = (s: string) => matchKey(s);
          const all = await db.select({ id: employees.id, fullName: employees.fullName, email: employees.email })
            .from(employees).where(eq(employees.isActive, 1));
          const dup = all.find((e) =>
            norm(e.fullName) === norm(input.agentName) ||
            (input.email && e.email && e.email.toLowerCase() === input.email.toLowerCase()),
          );
          if (dup) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `Já existe um colaborador ativo com estes dados: ${dup.fullName} (#${dup.id}). Liga o agente à ficha existente em vez de criar outra.` });
          }
        }
        // Centro de custos: o indicado, ou PENDENTE (null) — deixou de assumir
        // Lisboa por nome literal; a ficha aparece na fila "sem centro".
        void projects; void and;
        const { agentIdForName } = await import("./identityLink");
        const agentId = await agentIdForName(input.agentName);
        const [ins] = await db.insert(employees).values({
          fullName: input.agentName,
          email: input.email ?? null,
          multiparkAgentName: input.agentName,
          multiparkAgentUserId: agentId,
          position: "extra",
          contractType: "extra",
          projectId: input.projectId ?? null,
          isActive: 1,
        } as any).$returningId();
        await logActivity({ userId: ctx.user.id, action: "create", entity: "employee", entityId: (ins as any)?.id ?? 0, details: `Criado a partir do agente: ${input.agentName}` });
        // Fase 1: toda a ficha nova com email fica com utilizador
        if (input.email && (ins as any)?.id) {
          try {
            const { ensureUserForEmployee } = await import("./identity");
            await ensureUserForEmployee(db as any, { id: (ins as any).id, fullName: input.agentName, email: input.email, position: "extra", userId: null });
          } catch (err) { console.warn("[createEmployeeFromAgent] utilizador:", err); }
        }
        return { id: (ins as any)?.id };
      }),

    // Reserva completa por externalId (detalhe ao clicar num serviço)

    // Resumo agregado (dashboard Operações): contagens/somas no SQL em vez de
    // puxar milhares de reservas completas para o browser
    operationsSummary: protectedProcedure
      .input(z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        projectId: z.number().optional(),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        const { getOperationsSummary } = await import("./db");
        return getOperationsSummary(input);
      }),
  }),

  // ── EXTRAS DIA — Daily forecast & driver allocation (Lisboa) ────────────────
  extrasDia: router({
    // Que euros esta conta vê (o ecrã esconde as colunas; o servidor tira os valores).
    costAccess: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "extras_dia", "view");
      return extrasCostViewFor(ctx.user);
    }),

    forecast: protectedProcedure
      .input(z.object({ baseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), city: z.enum(["lisbon", "porto", "faro"]).optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        const f = await getExtrasDiaForecast(input?.baseDate, input?.city ?? "lisbon");
        const v = await extrasCostViewFor(ctx.user);
        const { maskForecastCosts } = await import("./extrasDia");
        return v.costs ? f : maskForecastCosts(f);
      }),

    candidates: protectedProcedure
      .input(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        // true = só elegíveis a Team Leader (chefias + permissão explícita)
        forTeamLeader: z.boolean().optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        const list = await listDriverCandidates(input?.date, { forTeamLeader: input?.forTeamLeader });
        // Badge "Formação em falta" no seletor da escala (server/trainingPaths.ts)
        const { employeesMissingTraining } = await import("./trainingPaths");
        const missing = await employeesMissingTraining(list.map(c => c.id));
        return list.map(c => ({ ...c, trainingMissing: missing.has(c.id) }));
      }),

    assignments: protectedProcedure
      .input(z.object({ date: z.string(), projectId: z.number().optional(), city: z.enum(["lisbon", "porto", "faro"]).optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        const v = await extrasCostViewFor(ctx.user);
        const { maskAssignmentCost } = await import("../shared/extrasCostView");
        return (await listAssignments(input.date, input.city)).map((a) => maskAssignmentCost(a, v));
      }),

    upsertAssignment: protectedProcedure
      .input(
        z.object({
          id: z.number().optional(),
          assignmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida"),
          employeeId: z.number().nullable().optional(),
          personName: z.string().min(1).max(128),
          level: z.enum(["junior", "senior", "terminal", "master"]).nullable().optional(),
          isTeamLeader: z.boolean().optional(),
          shift: z.enum(["morning", "night"]),
          city: z.enum(["lisbon", "porto", "faro"]).optional(),
          // O dia operacional começa às 03h (a noite vai até às 27 = 03h do dia seguinte):
          // um turno das 0h–2h é da noite ANTERIOR (antes era aceite e a previsão ignorava-o).
          startHour: z.number().int().min(3, "O dia operacional começa às 03h — da 0h às 3h é a noite do dia anterior (24h–27h)").max(26),
          endHour: z.number().int().min(4).max(27),
          sentHomeHour: z.number().int().min(3).max(27).nullable().optional(),
          notes: z.string().max(255).nullable().optional(),
          // Admin força a escala de quem ainda não concluiu a formação obrigatória
          override: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input: rawInput }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        const { override, ...input } = rawInput;
        if (input.endHour <= input.startHour) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Fim tem de ser depois do início" });
        }
        const span = input.endHour - input.startHour;
        if (span < 3) throw new TRPCError({ code: "BAD_REQUEST", message: "Mínimo 3h por turno" });
        if (span > 12) throw new TRPCError({ code: "BAD_REQUEST", message: "Máximo 12h por turno" });
        if (input.sentHomeHour != null) {
          if (input.sentHomeHour < input.startHour || input.sentHomeHour > input.endHour) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Hora 'mandar para casa' tem de estar dentro do turno",
            });
          }
        }
        if (input.isTeamLeader && !input.employeeId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Team Leader tem de ser um funcionário registado (salário usado no custo).",
          });
        }
        // Só verifica quando a pessoa entra na escala (nova linha ou troca de pessoa).
        const { checkEscalaEligibility, escalaAssignmentEmployeeId } = await import("./trainingPaths");
        if (input.employeeId && (!input.id || (await escalaAssignmentEmployeeId(input.id)) !== input.employeeId)) {
          const canOverride = (ROLE_HIERARCHY[ctx.user.role] ?? 0) >= ROLE_HIERARCHY.admin;
          const elig = await checkEscalaEligibility(input.employeeId, { override, canOverride });
          if (!elig.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: elig.message ?? "Formação obrigatória por concluir." });
          if (elig.overridden) {
            await logActivity({ userId: ctx.user.id, action: "training_escala_override", entity: "employees", entityId: input.employeeId, details: `Escalado sem formação concluída (${elig.missing.join(", ")}) · ${input.assignmentDate} ${input.shift}` });
          }
        }
        let saved: Awaited<ReturnType<typeof upsertAssignment>>;
        try {
          saved = await upsertAssignment({ ...input, createdById: ctx.user.id, updatedById: ctx.user.id, source: "manual" });
        } catch (err: any) {
          const { ScheduleConflictError } = await import("./extrasDia");
          throw new TRPCError({ code: err instanceof ScheduleConflictError ? "CONFLICT" : "BAD_REQUEST", message: err.message || "Erro ao guardar" });
        }
        // Quem fez o quê na escala (antes só a remoção ficava registada).
        if (!saved) return null;
        {
          await logActivity({
            userId: ctx.user.id, action: input.id ? "extras_dia_assignment_update" : "extras_dia_assignment_create",
            entity: "extras_dia_assignments", entityId: saved.id,
            details: `${input.id ? "Alterado" : "Escalado"}: ${input.personName}${input.isTeamLeader ? " (TL)" : ""} · ${input.assignmentDate} · ${input.city ?? "lisbon"} · ${input.startHour}h–${input.endHour}h`,
          });
        }
        const { maskAssignmentCost } = await import("../shared/extrasCostView");
        return maskAssignmentCost(saved, await extrasCostViewFor(ctx.user));
      }),

    deleteAssignment: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        // Remove e, se a pessoa já tinha sido avisada de uma escala confirmada,
        // avisa-a de que saiu (WhatsApp na janela de 24h + email).
        const { removeAssignment } = await import("./extrasSchedule");
        const r = await removeAssignment(input.id, ctx.user.id);
        return { success: true, notified: r.notified };
      }),

    // ── Escala automática: proposta, confirmação e avisos ────────────────────
    schedule: protectedProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), city: z.enum(["lisbon", "porto", "faro"]) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        const { assertCityInScope, getScheduleOverview } = await import("./extrasSchedule");
        await assertCityInScope(input.city);
        const o = await getScheduleOverview(input.date, input.city);
        const v = await extrasCostViewFor(ctx.user);
        if (v.costs || !o.state?.summary) return o;
        const { stripEuros } = await import("../shared/extrasCostView");
        return { ...o, state: { ...o.state, summary: stripEuros(o.state.summary) } };
      }),

    propose: protectedProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), city: z.enum(["lisbon", "porto", "faro"]) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        const { assertCityInScope, proposeSchedule } = await import("./extrasSchedule");
        await assertCityInScope(input.city);
        try {
          return await proposeSchedule({ ...input, by: "manual", userId: ctx.user.id });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao propor a escala" });
        }
      }),

    confirmSchedule: protectedProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), city: z.enum(["lisbon", "porto", "faro"]) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        const { assertCityInScope, confirmSchedule } = await import("./extrasSchedule");
        await assertCityInScope(input.city);
        try {
          return await confirmSchedule({ ...input, by: "manual", userId: ctx.user.id });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao confirmar a escala" });
        }
      }),

    setScheduleHold: protectedProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), city: z.enum(["lisbon", "porto", "faro"]), hold: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        const { assertCityInScope, setScheduleHold } = await import("./extrasSchedule");
        await assertCityInScope(input.city);
        return setScheduleHold(input.date, input.city, input.hold, ctx.user.id);
      }),

    requestMissingAvailability: protectedProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), city: z.enum(["lisbon", "porto", "faro"]) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        const { assertCityInScope, resendAvailabilityRequest } = await import("./extrasSchedule");
        await assertCityInScope(input.city);
        try {
          return await resendAvailabilityRequest(input.date, input.city, ctx.user.id);
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao pedir disponibilidade" });
        }
      }),

    // ── Automação (pontos 7 e 8): preencher com disponíveis, cobertura, avisos ──
    autofill: protectedProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), city: z.enum(["lisbon", "porto", "faro"]), shift: z.enum(["morning", "night"]) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        const { autofillShift } = await import("./extrasAutomation");
        try {
          return await autofillShift({ ...input, createdById: ctx.user.id });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao preencher a escala" });
        }
      }),

    coverage: protectedProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), city: z.enum(["lisbon", "porto", "faro"]) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        const { coverageFor } = await import("./extrasAutomation");
        return coverageFor(input.date, input.city);
      }),

    // ── Métricas (ponto 12) e extras parados (ponto 13) ─────────────────────
    metrics: protectedProcedure
      .input(z.object({ days: z.number().int().min(7).max(180).optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        const { getExtrasMetrics } = await import("./extrasMetrics");
        const m = await getExtrasMetrics(input?.days ?? 30);
        // Custos só para quem os vê (as horas ficam).
        return (await extrasCostViewFor(ctx.user)).costs ? m : { ...m, cost: { ...m.cost, planned: 0, paid: 0 }, costHidden: true as const };
      }),

    coverageOutlook: protectedProcedure
      .input(z.object({ city: z.enum(["lisbon", "porto", "faro"]), days: z.number().int().min(1).max(14).optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        const { getCoverageOutlook } = await import("./extrasMetrics");
        return getCoverageOutlook(input.city, input.days ?? 7);
      }),

    notices: protectedProcedure
      // Com a cidade: só os avisos dessa cidade (antes vinham os de todas).
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), city: z.enum(["lisbon", "porto", "faro"]).optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        const { listNotices } = await import("./extrasAutomation");
        return listNotices(input.date, input.city ?? null);
      }),

    notify: protectedProcedure
      .input(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        city: z.enum(["lisbon", "porto", "faro"]),
        // O botão é de um turno: só avisa esse turno (antes avisava o dia todo).
        shift: z.enum(["morning", "night"]).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        const { notifyAssignments } = await import("./extrasAutomation");
        const { PAST_DAY_MESSAGE } = await import("./extrasSchedule");
        const { lisbonNow } = await import("../shared/extrasSchedule");
        if (input.date < lisbonNow().date) throw new TRPCError({ code: "BAD_REQUEST", message: PAST_DAY_MESSAGE });
        try {
          return await notifyAssignments(input.date, { city: input.city, shift: input.shift ?? null, createdById: ctx.user.id });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao avisar" });
        }
      }),

    bookingsInSlot: protectedProcedure
      .input(
        z.object({
          city: z.enum(["lisbon", "porto", "faro"]).optional(),
          date: z.string(),
          hour: z.number().int().min(3).max(26),
          slot: z.number().int().min(0).max(2),
          type: z.enum(["checkin", "checkout"]),
        }),
      )
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        return getBookingsInSlot(input.date, input.hour, input.slot, input.type, input.city ?? "lisbon");
      }),

    // "Pressão": 60 dias da BD Multipark agregados pelo trabalho extras-pressure
    // (ops_pressure_stats). Só lê a nossa BD; âmbito de cidade do utilizador.
    pressure: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "extras_dia", "view");
      const { getPressureView } = await import("./extrasPressure");
      const { groupAllowedForCities } = await import("../shared/extrasPressure");
      const { matchCityKey } = await import("../shared/city");
      const names = scopedCityNames();
      const keys = names === undefined ? null : names.map((n) => matchCityKey(n)).filter((k): k is NonNullable<typeof k> => !!k);
      return getPressureView((key) => groupAllowedForCities(key, keys));
    }),
  }),

  // ── DISPONIBILIDADE SEMANAL DOS EXTRAS ────────────────────────────────────
  extrasAvailability: router({
    forEmployee: protectedProcedure
      .input(z.object({ employeeId: z.number(), weekStart: weekStartSchema }))
      .query(async ({ ctx, input }) => {
        const viewer = await rhViewer(ctx.user);
        const person = await getEmployeeById(input.employeeId);
        if (!person) throw new TRPCError({ code: 'NOT_FOUND' });
        await assertEmployeeAccess(input.employeeId);
        if (!canViewEmployee(viewer, person.employee)) throw new TRPCError({ code: 'FORBIDDEN' });
        return getMyWeek(input.employeeId, input.weekStart);
      }),
    // Sugestões de semanas (próxima e atual) para o picker.
    weekHints: protectedProcedure.query(() => {
      return { current: mondayOf(), next: nextMonday() };
    }),

    // O extra vê/edita a SUA disponibilidade da semana.
    myWeek: protectedProcedure
      .input(z.object({ weekStart: weekStartSchema }))
      .query(async ({ ctx, input }) => {
        const emp = await getEmployeeByUserId(ctx.user.id);
        if (!emp) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "A tua conta não está associada a um colaborador. Fala com o backoffice.",
          });
        }
        return getMyWeek(emp.employee.id, input.weekStart);
      }),

    setMyWeek: protectedProcedure
      .input(
        z.object({
          weekStart: weekStartSchema,
          days: z.array(
            z.object({
              day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              morning: z.boolean().optional(),
              night: z.boolean().optional(),
              fromHour: z.number().int().min(0).max(23).nullable().optional(),
              toHour: z.number().int().min(0).max(23).nullable().optional(),
              note: z.string().max(300).nullable().optional(),
            }),
          ).max(7),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const emp = await getEmployeeByUserId(ctx.user.id);
        if (!emp) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "A tua conta não está associada a um colaborador. Fala com o backoffice.",
          });
        }
        const r = await setMyAvailability(emp.employee.id, input.weekStart, input.days, ctx.user.id);
        // Fica registado quem mudou e o que estava antes (a semana é substituída).
        await logActivity({
          userId: ctx.user.id, action: "availability_set", entity: "extras_availability", entityId: emp.employee.id,
          details: `Semana ${input.weekStart}: ${r.saved} dia(s)${r.previous.length ? ` · antes: ${r.previous.join("; ")}` : " · sem nada antes"}`.slice(0, 1000),
        });
        return { saved: r.saved };
      }),

    // Backoffice: marca a disponibilidade POR um extra (a semana inteira, como
    // o próprio faria em setMyWeek). Fica no activity log com quem marcou.
    setForEmployee: protectedProcedure
      .input(
        z.object({
          employeeId: z.number().int().positive(),
          weekStart: weekStartSchema,
          days: z.array(
            z.object({
              day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              morning: z.boolean().optional(),
              night: z.boolean().optional(),
              fromHour: z.number().int().min(0).max(23).nullable().optional(),
              toHour: z.number().int().min(0).max(23).nullable().optional(),
              note: z.string().max(300).nullable().optional(),
            }),
          ).max(7),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "disponibilidade_extras", "edit");
        let result: { saved: number; employeeName: string; previous: string[] };
        await assertEmployeeAccess(input.employeeId);
        try {
          result = await setEmployeeAvailability(input.employeeId, input.weekStart, input.days, ctx.user.id);
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: (err as Error).message || "Falha ao guardar a disponibilidade" });
        }
        await logActivity({
          userId: ctx.user.id,
          action: "availability_manual",
          entity: "extras_availability",
          entityId: input.employeeId,
          details: `Disponibilidade marcada pelo backoffice para ${result.employeeName} (semana ${input.weekStart}): ${result.saved} dia(s)${result.previous.length ? ` · antes: ${result.previous.join("; ")}` : ""}`.slice(0, 1000),
        });
        return { saved: result.saved, employeeName: result.employeeName };
      }),

    // Backoffice: resumo da semana (quem respondeu, disponíveis por dia/turno).
    overview: protectedProcedure
      .input(z.object({ weekStart: weekStartSchema, projectId: z.number().nullable().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "disponibilidade_extras", "view");
        return getWeekOverview(input.weekStart, input.projectId ?? null);
      }),

    // Backoffice: envia o pedido por email a todos os extras ativos.
    sendRequest: protectedProcedure
      .input(
        z.object({
          weekStart: weekStartSchema,
          // Ignorado: o link do email é sempre o da app (APP_URL), nunca o do browser.
          origin: z.string().url().optional(),
          projectId: z.number().nullable().optional(),
          note: z.string().max(500).nullable().optional(),
          employeeIds: z.array(z.number().int().positive()).max(2000).nullable().optional(),
          testEmail: z.string().email().nullable().optional(),
          message: z.object({
            kind: z.enum(["week", "day_shift", "day_hours", "day_range"]),
            dateLabel: z.string().max(60).optional(),
            shift: z.enum(["morning", "afternoon", "night"]).optional(),
            fromHour: z.number().int().min(0).max(23).optional(),
            toHour: z.number().int().min(0).max(27).optional(),
            // dia ISO do pedido — permite ao "sim" automático marcar o dia certo
            targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          }).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "disponibilidade_extras", "edit");
        const { appOrigin } = await import("./google/workspace");
        const result = await sendWeeklyAvailabilityRequest({
          weekStart: input.weekStart,
          origin: appOrigin(),
          projectId: input.projectId ?? null,
          note: input.note ?? null,
          employeeIds: input.employeeIds ?? null,
          testEmail: input.testEmail ?? null,
          message: input.message ?? null,
        });
        await logActivity({
          userId: ctx.user.id,
          action: "email_sync",
          entity: "extras_availability",
          details: input.testEmail
            ? `Pedido disponibilidade TESTE → ${input.testEmail} (semana ${input.weekStart})`
            : `Pedido disponibilidade semana ${input.weekStart}: ${result.sent} enviados, ${result.failed} falhas, ${result.noEmail} sem email`,
        });
        return result;
      }),
  }),

  // ── CANDIDATURAS DE CONDUTORES (website multidriver → Extras Dia) ──────────
  driverApplications: router({
    list: protectedProcedure
      .input(z.object({ status: z.enum(["new", "reviewed", "approved", "rejected"]).nullable().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "view");
        const { listDriverApplications } = await import("./webIntake");
        return listDriverApplications(input?.status ?? null);
      }),

    setStatus: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          status: z.enum(["new", "reviewed", "rejected"]),
          notes: z.string().max(512).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        const { setApplicationStatus } = await import("./webIntake");
        await setApplicationStatus(input.id, input.status, ctx.user.id, input.notes);
        return { success: true };
      }),

    /**
     * Cura de duplicados: funde fichas de extra auto-criadas pelo site que
     * partilham o email com uma ficha já existente. DRY-RUN por defeito —
     * `apply: true` escreve. Ver server/mergeDuplicateExtras.ts.
     */
    mergeDuplicates: protectedProcedure
      .input(z.object({ apply: z.boolean().default(false) }).optional())
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "super_admin");
        const { mergeDuplicateExtras } = await import("./mergeDuplicateExtras");
        const report = await mergeDuplicateExtras({ apply: input?.apply === true });
        if (report.apply && report.merged > 0) {
          await logActivity({
            userId: ctx.user.id,
            action: "employee_merge",
            entity: "employees",
            details: `Fusão de extras duplicados: ${report.merged} fichas fundidas, ${report.blocked} bloqueadas, ${report.movedAvailabilityDays} dias de disponibilidade movidos`,
          });
        }
        return report;
      }),

    // Aprovar = criar (ou ligar a) um employee extra com o mesmo email e
    // alocá-lo ao centro de custos (cidade) escolhido por quem aprova. O
    // middleware já recusa um `projectId` fora das cidades do utilizador
    // (`hasForeignCityFilter`); o `assertProjectAccess` aqui é a segunda linha.
    approve: protectedProcedure
      .input(z.object({ id: z.number(), projectId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        assertProjectAccess(input.projectId);
        const { approveApplication } = await import("./webIntake");
        try {
          return await approveApplication(input.id, ctx.user.id, { projectId: input.projectId });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao aprovar" });
        }
      }),
  }),

  // ── LEADS DE EXTRAS (contactos em recrutamento, ainda sem ficha) ──────────
  // ── LIGAÇÕES funcionário ↔ utilizador ↔ agente Multipark (Fase 4) ────────
  identityLinks: router({
    overview: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "manage");
      const { getLinksOverview } = await import("./identityScreen");
      return getLinksOverview();
    }),
    reconcileNow: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "manage");
      const { runIdentitySweep } = await import("./identityLink");
      const r = await runIdentitySweep();
      await logActivity({ userId: ctx.user.id, action: "identity_sweep", entity: "employees", details: JSON.stringify(r).slice(0, 500) });
      return r;
    }),
    createUser: protectedProcedure
      .input(z.object({ employeeId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        await assertEmployeeAccess(input.employeeId);
        const { getDb } = await import("./db");
        const db = await getDb();
        const found = await getEmployeeById(input.employeeId);
        if (!db || !found) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha não encontrada" });
        const { ensureUserForEmployee } = await import("./identity");
        const r = await ensureUserForEmployee(db as any, { id: input.employeeId, fullName: found.employee.fullName, email: found.employee.email, position: String(found.employee.position ?? ""), userId: found.employee.userId ?? null });
        if (!r.userId) throw new TRPCError({ code: "BAD_REQUEST", message: "Não deu para ligar: sem email válido, ou o utilizador com esse email já está noutra ficha ativa." });
        return r;
      }),
    linkUser: protectedProcedure
      .input(z.object({ employeeId: z.number().int().positive(), userId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        await assertEmployeeAccess(input.employeeId);
        // A conta extra herda o papel da principal: não se pode subir ninguém acima de quem liga
        // (nem despromover um super_admin) por aqui.
        const linked = await getUserById(input.userId);
        if (!linked) throw new TRPCError({ code: "NOT_FOUND", message: "Utilizador não encontrado" });
        const fichaUserId = (await getEmployeeById(input.employeeId))?.employee.userId ?? null;
        const primary = fichaUserId && fichaUserId !== input.userId ? await getUserById(fichaUserId) : null;
        const guard = linkRoleGuard({ actor: ctx.user, linked, primaryRole: primary?.role ?? null, activeSuperAdminCount: await countActiveSuperAdmins() });
        if (guard) throw new TRPCError({ code: "FORBIDDEN", message: guard });
        // O papel herdado entra DENTRO da tranca do último super_admin (atómico);
        // a ligação a seguir grava o mesmo papel (sem mudança). O que impediria a
        // ligação verifica-se ANTES, para o papel nunca mudar sem a ligação feita.
        const { linkEmployeeConflict, linkEmployeeToUser } = await import("./identityScreen");
        const inherited = primary?.role ?? null;
        if (inherited && inherited !== linked.role) {
          const conflict = await linkEmployeeConflict(input.employeeId, input.userId);
          if (conflict) throw new TRPCError({ code: "BAD_REQUEST", message: conflict });
          const locked = await guardedAccountChange(
            input.userId,
            (t, n) => linkRoleGuard({ actor: ctx.user, linked: t, primaryRole: inherited, activeSuperAdminCount: n }),
            (tx) => updateUserRole(input.userId, inherited, tx),
          );
          if (locked) throw new TRPCError({ code: "FORBIDDEN", message: locked });
        }
        let mode: "principal" | "extra";
        try {
          mode = await linkEmployeeToUser(input.employeeId, input.userId);
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        await logActivity({ userId: ctx.user.id, action: "account_link", entity: "employee", entityId: input.employeeId, details: `Ficha ligada ao utilizador #${input.userId} como conta ${mode} (ecrã Ligações)` });
        return { success: true, mode };
      }),
    removeAccountAlias: protectedProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        const { removeAccountAlias } = await import("./employeeAliases");
        await removeAccountAlias(input.userId);
        await logActivity({ userId: ctx.user.id, action: "account_unlink", entity: "user", entityId: input.userId, details: "Conta extra separada da ficha (ecrã Ligações)" });
        return { success: true };
      }),
    removeAgentAlias: protectedProcedure
      .input(z.object({ agentUserId: z.string().min(1).max(128) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        const { removeAgentAlias } = await import("./employeeAliases");
        await removeAgentAlias(input.agentUserId);
        await logActivity({ userId: ctx.user.id, action: "agent_detach", entity: "employee", details: `Agente extra ${input.agentUserId} separado (ecrã Ligações)` });
        return { success: true };
      }),
    /** Uma pessoa: contas (principal + extra) e agentes da Multipark (principal + extra). */
    person: protectedProcedure
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        await assertEmployeeAccess(input.employeeId);
        const { getPersonIdentity } = await import("./personIdentity");
        const r = await getPersonIdentity(input.employeeId);
        if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha não encontrada" });
        return r;
      }),
    searchAgents: protectedProcedure
      .input(z.object({ q: z.string().trim().min(2).max(120) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        const { searchAgents } = await import("./personIdentity");
        return searchAgents(input.q);
      }),
    /** Retirar um agente da ficha (principal ou extra). */
    detachAgent: protectedProcedure
      .input(z.object({ employeeId: z.number().int().positive(), agentUserId: z.string().min(1).max(128) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        await assertEmployeeAccess(input.employeeId);
        const { detachAgent } = await import("./personIdentity");
        try { await detachAgent(input.employeeId, input.agentUserId); } catch (err: any) { throw new TRPCError({ code: "BAD_REQUEST", message: err.message }); }
        await logActivity({ userId: ctx.user.id, action: "agent_detach", entity: "employee", entityId: input.employeeId, details: `Agente Multipark ${input.agentUserId} retirado da ficha (ecrã Ligações)` });
        return { success: true };
      }),
    /** Juntar duas contas da mesma pessoa: o que vai acontecer (sem mexer). */
    previewMerge: protectedProcedure
      .input(z.object({ keepUserId: z.number().int().positive(), dropUserId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        if (!["admin", "super_admin"].includes(String(ctx.user.role))) throw new TRPCError({ code: "FORBIDDEN", message: "Só um administrador junta contas." });
        const { getDb } = await import("./db");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        const { previewUserMerge } = await import("./userMerge");
        try { return await previewUserMerge(db as any, input.keepUserId, input.dropUserId); }
        catch (err: any) { throw new TRPCError({ code: "BAD_REQUEST", message: err.message }); }
      }),
    /** Juntar duas FICHAS da mesma pessoa: pré-visualização (o que passa). Só administradores. */
    previewEmployeeMerge: protectedProcedure
      .input(z.object({ keepEmployeeId: z.number().int().positive(), dropEmployeeId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        if (!["admin", "super_admin"].includes(String(ctx.user.role))) throw new TRPCError({ code: "FORBIDDEN", message: "Só um administrador junta fichas." });
        await assertEmployeeAccess(input.keepEmployeeId);
        await assertEmployeeAccess(input.dropEmployeeId);
        const { getDb } = await import("./db");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        const { previewEmployeeMerge } = await import("./employeeMerge");
        try { return await previewEmployeeMerge(db as any, input.keepEmployeeId, input.dropEmployeeId); }
        catch (err: any) { throw new TRPCError({ code: "BAD_REQUEST", message: err.message }); }
      }),
    /** Juntar: fica a ficha escolhida; tudo o que era da outra passa para ela; a outra fica desativada (nunca apagada). */
    mergeEmployees: protectedProcedure
      .input(z.object({ keepEmployeeId: z.number().int().positive(), dropEmployeeId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        if (!["admin", "super_admin"].includes(String(ctx.user.role))) throw new TRPCError({ code: "FORBIDDEN", message: "Só um administrador junta fichas." });
        await assertEmployeeAccess(input.keepEmployeeId);
        await assertEmployeeAccess(input.dropEmployeeId);
        const { getDb } = await import("./db");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        const { mergeEmployees } = await import("./employeeMerge");
        let p;
        try { p = await mergeEmployees(db as any, { keepId: input.keepEmployeeId, dropId: input.dropEmployeeId }); }
        catch (err: any) { throw new TRPCError({ code: "BAD_REQUEST", message: err.message }); }
        await logActivity({ userId: ctx.user.id, action: "employees_merge", entity: "employee", entityId: input.keepEmployeeId,
          details: `Ficha ${p.drop.fullName} #${p.drop.id} junta a ${p.keep.fullName} #${p.keep.id} (${p.moves.map((m) => `${m.table}: ${m.rows}`).join(", ") || "sem registos"}); a #${p.drop.id} ficou desativada` });
        return { success: true, ...p };
      }),
    /**
     * Juntar: fica a conta que entra na app (principal da ficha); tudo o que é
     * da pessoa passa para ela; a outra fica desativada (nunca apagada).
     */
    mergeUsers: protectedProcedure
      .input(z.object({ keepUserId: z.number().int().positive(), dropUserId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        if (!["admin", "super_admin"].includes(String(ctx.user.role))) throw new TRPCError({ code: "FORBIDDEN", message: "Só um administrador junta contas." });
        if (input.dropUserId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Não podes juntar (desativar) a tua própria conta." });
        const { getDb } = await import("./db");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        const { mergeUserAccounts, previewUserMerge } = await import("./userMerge");
        let p;
        try {
          p = await previewUserMerge(db as any, input.keepUserId, input.dropUserId);
          if ((p.drop.role === "super_admin" || p.keep.role === "super_admin") && ctx.user.role !== "super_admin") throw new Error("Só um super admin junta contas de super admin.");
          if (p.employee) await assertEmployeeAccess(p.employee.id);
          p = await mergeUserAccounts(db as any, { keepId: input.keepUserId, dropId: input.dropUserId, byUserId: ctx.user.id, nowDb: new Date().toISOString().slice(0, 19).replace("T", " ") });
        } catch (err: any) {
          if (err instanceof TRPCError) throw err;
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        await logActivity({ userId: ctx.user.id, action: "users_merge", entity: "user", entityId: input.keepUserId,
          details: `Conta #${input.dropUserId} (${p.drop.email ?? "sem email"}) junta a #${input.keepUserId} (${p.keep.email ?? "sem email"})${p.employee ? ` · ficha ${p.employee.fullName} #${p.employee.id}` : ""}; a #${input.dropUserId} ficou desativada` });
        return { success: true, ...p };
      }),
    linkAgent: protectedProcedure
      .input(z.object({ employeeId: z.number().int().positive(), agentUserId: z.string().min(1).max(128), agentName: z.string().max(256).optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        await assertEmployeeAccess(input.employeeId);
        const { linkAgentToEmployee } = await import("./identityScreen");
        const agentName = await linkAgentToEmployee(input.agentUserId, input.employeeId, input.agentName ?? null);
        await logActivity({ userId: ctx.user.id, action: "agent_attach", entity: "employee", entityId: input.employeeId, details: `Agente Multipark ${input.agentUserId} "${agentName}" ligado (ecrã Ligações)` });
        return { success: true, agentName };
      }),
    /** Lista de agentes exportada da Multipark (CSV ou folha "Agentes" do xlsx) contra as fichas: quem está ligado e a quem ligar. Só leitura. */
    compareAgentList: protectedProcedure.input(z.union([
      z.object({ csv: z.string().min(5).max(500_000) }),
      // folha "Agentes" do xlsx, já lida no browser (linhas cabeçalho → valor)
      z.object({ sheet: z.array(z.record(z.string().max(64), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))).min(1).max(5000) }),
    ])).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh", "manage");
      const { parseAgentListCsv, parseAgentSheetRows } = await import("../shared/multiparkExports");
      const parsed = "csv" in input ? parseAgentListCsv(input.csv) : parseAgentSheetRows(input.sheet);
      if (parsed.errors.length) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.errors.join(" ") });
      const { compareAgentList } = await import("./multiparkExportsImport");
      return compareAgentList(parsed.rows.slice(0, 2000));
    }),
  }),

  extraLeads: router({
    list: protectedProcedure
      .input(
        z
          .object({
            status: z.enum(LEAD_STATUS_ENUM).nullable().optional(),
            search: z.string().max(120).nullable().optional(),
            source: z.string().max(64).nullable().optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "view");
        const { listExtraLeads } = await import("./extraLeads");
        return listExtraLeads({ status: input?.status ?? null, search: input?.search ?? null, source: input?.source ?? null });
      }),

    // Funil: origem × cidade × semana ISO (new→contacted→replied→converted) +
    // medianas de 1.º contacto e de conversão. No âmbito de cidades de quem pede.
    funnel: protectedProcedure
      .input(z.object({ weeks: z.number().int().min(1).max(52).optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "view");
        const { getLeadFunnel } = await import("./extraLeads");
        return getLeadFunnel({ weeks: input?.weeks });
      }),

    // Ações em lote: estado (nunca Convertido) e/ou cidade. Visibilidade e
    // transição verificadas lead a lead; a cidade com assertProjectAccess.
    bulkUpdate: protectedProcedure
      .input(
        z.object({
          leadIds: z.array(z.number().int().positive()).min(1).max(500),
          status: z.enum(LEAD_STATUS_ENUM).nullable().optional(),
          projectId: z.number().int().positive().nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        const { bulkUpdateExtraLeads } = await import("./extraLeads");
        try {
          return await bulkUpdateExtraLeads(input, ctx.user.id);
        } catch (err: any) {
          if (err instanceof TRPCError) throw err;
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao atualizar leads" });
        }
      }),

    create: protectedProcedure
      .input(
        z.object({
          fullName: z.string().min(1).max(256),
          phone: z.string().max(32).nullable().optional(),
          email: z.string().max(320).nullable().optional(),
          notes: z.string().max(512).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        const { createExtraLead } = await import("./extraLeads");
        try {
          return await createExtraLead(input, ctx.user.id);
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao criar lead" });
        }
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number().int().positive(),
          fullName: z.string().min(1).max(256).optional(),
          phone: z.string().max(32).nullable().optional(),
          email: z.string().max(320).nullable().optional(),
          notes: z.string().max(512).nullable().optional(),
          status: z.enum(LEAD_STATUS_ENUM).nullable().optional(),
          // Cidade (nó level='city'); null = sem cidade (só quem vê todas).
          projectId: z.number().int().positive().nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        const { updateExtraLead } = await import("./extraLeads");
        const { id, ...patch } = input;
        try {
          return await updateExtraLead(id, patch, ctx.user.id);
        } catch (err: any) {
          if (err instanceof TRPCError) throw err;
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao atualizar lead" });
        }
      }),

    // Converte o lead numa ficha de extra no centro de custos (cidade) escolhido.
    convert: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), projectId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        assertProjectAccess(input.projectId);
        const { convertLeadToExtra } = await import("./extrasAutomation");
        try {
          return await convertLeadToExtra(input.id, input.projectId, ctx.user.id);
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao converter" });
        }
      }),

    remove: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        const { deleteExtraLead } = await import("./extraLeads");
        await deleteExtraLead(input.id, ctx.user.id);
        return { success: true };
      }),

    // Envia um template SEM parâmetros (por defeito `seja_motorista`) aos leads
    // escolhidos. Mesmo caminho de envio dos extras; ver server/extraLeads.ts.
    contact: protectedProcedure
      .input(
        z.object({
          leadIds: z.array(z.number().int().positive()).min(1).max(200),
          templateId: z.string().min(1).max(64),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        const { contactExtraLeads } = await import("./extraLeads");
        try {
          return await contactExtraLeads({ leadIds: input.leadIds, templateId: input.templateId, createdById: ctx.user.id });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao enviar WhatsApp aos leads" });
        }
      }),
  }),

  // ── WHATSAPP (envio em massa de templates aos extras) ──────────────────────
  whatsapp: router({
    // Texto REAL do template aprovado na Meta, para a UI pré-visualizar a
    // mensagem antes de enviar. Devolve o corpo com os `{{...}}` por substituir
    // — quem os substitui é o cliente, com os MESMOS papéis que o envio usa
    // (shared/whatsappTemplate.ts), para o preview não poder divergir do envio.
    // Nunca lança por falta de metadados: `ok:false` + motivo legível.
    templatePreview: protectedProcedure
      .input(
        z.object({
          templateName: z.string().min(1).max(128),
          languageCode: z.string().min(2).max(12),
        }),
      )
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "view");
        const meta = await getTemplateMeta(input.templateName, input.languageCode);
        if (!meta.available) return { ok: false as const, reason: meta.reason };
        if (!meta.lookup.ok) {
          return {
            ok: false as const,
            reason: describeLookupFailure(meta.lookup, input.templateName, input.languageCode),
          };
        }
        const a = meta.lookup.analysis;
        return {
          ok: true as const,
          bodyText: a.bodyText,
          paramNames: a.paramNames,
          paramCount: a.paramCount,
          hasDynamicUrlButton: a.hasDynamicUrlButton,
        };
      }),

    // Envia um template WhatsApp em massa (ou a 1 número, em modo teste).
    // Espelha o padrão de extrasAvailability.sendRequest. A mutation devolve o
    // summary completo (incl. resultado por destinatário), por isso a UI não
    // precisa de uma query separada nesta fase.
    sendBroadcast: protectedProcedure
      .input(
        z.object({
          templateName: z.string().min(1).max(128),
          languageCode: z.string().min(2).max(12).optional(),
          // {{1}} é SEMPRE o nome do destinatário (resolvido no servidor, por
          // destinatário); só o {{2}} vem da UI e é igual para todos.
          bodyParam2: z.string().max(512).nullable().optional(),
          includeFormLink: z.boolean().optional(),
          employeeIds: z.array(z.number()).nullable().optional(),
          weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          note: z.string().max(500).nullable().optional(),
          testPhone: z.string().min(3).max(30).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "edit");
        let summary;
        try {
          summary = await sendBroadcast({
            templateName: input.templateName,
            languageCode: input.languageCode,
            bodyParam2: input.bodyParam2 ?? null,
            includeFormLink: input.includeFormLink === true,
            employeeIds: input.employeeIds ?? null,
            weekStart: input.weekStart ?? null,
            note: input.note ?? null,
            testPhone: input.testPhone ?? null,
            createdById: ctx.user.id,
          });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro no envio WhatsApp" });
        }
        await logActivity({
          userId: ctx.user.id,
          action: "whatsapp_broadcast",
          entity: "whatsapp_broadcast",
          entityId: summary.broadcastId ?? undefined,
          details: input.testPhone
            ? `WhatsApp TESTE → ${(await import("../shared/maskPhone")).maskPhone(input.testPhone)} (template ${input.templateName})`
            : `WhatsApp broadcast template ${input.templateName}: ${summary.sent} enviados, ${summary.failed} falhas, ${summary.invalidPhone} sem número`,
        });
        return summary;
      }),

    // ── CHAMADAS DE VOZ (WhatsApp Business Calling API) ────────────────────
    calls: whatsappCallsRouter,

    // ── INBOX ──────────────────────────────────────────────────────────────
    conversations: router({
      list: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "whatsapp", "view");
        return listConversations();
      }),
    }),

    messages: router({
      byConversation: protectedProcedure
        .input(z.object({ conversationId: z.number(), limit: z.number().min(1).max(300).optional() }))
        .query(async ({ ctx, input }) => {
          requireAccess(ctx.user, "whatsapp", "view");
          const { conversationVisible } = await import("./whatsappInbox");
          if (!(await conversationVisible(input.conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
          const thread = await getConversationThread(input.conversationId, input.limit ?? 100);
          if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
          return thread;
        }),
    }),

    // Ficheiro de uma mensagem recebida (imagem/áudio/vídeo/documento): URL
    // ASSINADO de curta duração — o storage deixou de servir links públicos.
    mediaUrl: protectedProcedure
      .input(z.object({ messageId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "view");
        const { getInboundMediaUrl } = await import("./whatsappInbox");
        const out = await getInboundMediaUrl(input.messageId);
        if (!out) throw new TRPCError({ code: "NOT_FOUND", message: "Ficheiro não encontrado" });
        return out;
      }),

    // Template a uma conversa do inbox (janela fechada / ainda sem resposta):
    // escolhido do catálogo, {{1}} = nome REAL do contacto, envio normal (não
    // é o modo teste). Recusa contactos que pediram STOP.
    sendTemplate: protectedProcedure
      .input(
        z.object({
          conversationId: z.number().int().positive(),
          templateId: z.string().min(1).max(64),
          bodyParam2: z.string().max(512).nullable().optional(),
          weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "edit");
        const { conversationVisible } = await import("./whatsappInbox");
        if (!(await conversationVisible(input.conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        const { sendTemplateToConversation } = await import("./whatsappBroadcast");
        let summary;
        try {
          summary = await sendTemplateToConversation({
            conversationId: input.conversationId,
            templateId: input.templateId,
            bodyParam2: input.bodyParam2 ?? null,
            weekStart: input.weekStart ?? null,
            createdById: ctx.user.id,
          });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro no envio do template" });
        }
        await logActivity({
          userId: ctx.user.id,
          action: "whatsapp_template",
          entity: "whatsapp_conversation",
          entityId: input.conversationId,
          details: `Template WhatsApp ${input.templateId} (conversa ${input.conversationId}): ${summary.sent ? "enviado" : "falhou"}`,
        });
        return summary;
      }),

    markRead: protectedProcedure
      .input(z.object({ conversationId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "edit");
        const { conversationVisible } = await import("./whatsappInbox");
        if (!(await conversationVisible(input.conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        await markConversationRead(input.conversationId);
        return { success: true };
      }),

    // Inverso do markRead: devolve a conversa ao filtro "Não lidas" (pelo menos
    // 1 por ler, sem baixar um contador real). Ver markConversationUnread.
    markUnread: protectedProcedure
      .input(z.object({ conversationId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "edit");
        const { markConversationUnread, conversationVisible } = await import("./whatsappInbox");
        if (!(await conversationVisible(input.conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        const ok = await markConversationUnread(input.conversationId);
        if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        return { success: true };
      }),

    // Resposta em texto livre — a validação da janela de 24h é feita no servidor.
    // Contacto em opt-out (STOP): só com `confirmOptedOut` (a UI pede confirmação).
    reply: protectedProcedure
      .input(z.object({ conversationId: z.number(), text: z.string().min(1).max(4000), confirmOptedOut: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "edit");
        const { conversationVisible } = await import("./whatsappInbox");
        if (!(await conversationVisible(input.conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        const result = await replyToConversation(input.conversationId, input.text, ctx.user.id, {
          allowOptedOut: input.confirmOptedOut === true,
        });
        if (!result.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: result.error || "Falha ao responder" });
        }
        await logActivity({
          userId: ctx.user.id,
          action: "whatsapp_reply",
          entity: "whatsapp_conversation",
          entityId: input.conversationId,
          details: `Resposta WhatsApp (conversa ${input.conversationId})`,
        });
        // Quem responde a uma conversa sem responsável fica com ela.
        try {
          const { claimIfUnassigned } = await import("./whatsappInboxOps");
          await claimIfUnassigned(input.conversationId, ctx.user.id);
        } catch { /* best-effort */ }
        return result;
      }),

    // ── Estado, atribuição, alertas, ligações, respostas rápidas, IA (0097) ──
    // Configuração que a UI precisa para calcular alertas (SLA) e mostrar a IA.
    inboxMeta: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "whatsapp", "view");
      const { slaMinutes } = await import("./whatsappInboxOps");
      const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
      return { slaMinutes: slaMinutes(), aiConfigured: await aiFeatureAvailableFresh("whatsapp_reply") };
    }),

    // Badge do menu: conversas visíveis que precisam de atenção.
    badge: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "whatsapp", "view");
      const { inboxBadge } = await import("./whatsappInboxOps");
      return inboxBadge();
    }),

    assignees: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "whatsapp", "view");
      const { listAssignees } = await import("./whatsappInboxOps");
      return listAssignees();
    }),

    setStatus: protectedProcedure
      .input(z.object({ conversationId: z.number().int().positive(), status: z.enum(["aberto", "pendente", "resolvido"]) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "edit");
        const { conversationVisible } = await import("./whatsappInbox");
        if (!(await conversationVisible(input.conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        const { setConversationStatus } = await import("./whatsappInboxOps");
        if (!(await setConversationStatus(input.conversationId, input.status))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        }
        await logActivity({
          userId: ctx.user.id,
          action: "whatsapp_status",
          entity: "whatsapp_conversation",
          entityId: input.conversationId,
          details: `Conversa WhatsApp ${input.conversationId} → ${input.status}`,
        });
        return { success: true };
      }),

    assign: protectedProcedure
      .input(z.object({ conversationId: z.number().int().positive(), userId: z.number().int().positive().nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "edit");
        const { conversationVisible } = await import("./whatsappInbox");
        if (!(await conversationVisible(input.conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        const { assignConversation } = await import("./whatsappInboxOps");
        if (!(await assignConversation(input.conversationId, input.userId))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Utilizador inválido para atribuição" });
        }
        await logActivity({
          userId: ctx.user.id,
          action: "whatsapp_assign",
          entity: "whatsapp_conversation",
          entityId: input.conversationId,
          details: input.userId ? `Conversa WhatsApp ${input.conversationId} atribuída ao utilizador ${input.userId}` : `Conversa WhatsApp ${input.conversationId} sem responsável`,
        });
        return { success: true };
      }),

    // Contexto do contacto: reserva ligada + sugestões pelo telefone/email.
    context: protectedProcedure
      .input(z.object({ conversationId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "view");
        const { conversationVisible } = await import("./whatsappInbox");
        if (!(await conversationVisible(input.conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        const { getConversationContext } = await import("./whatsappInboxOps");
        const out = await getConversationContext(input.conversationId);
        if (!out) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        return out;
      }),

    searchBookings: protectedProcedure
      .input(z.object({ q: z.string().min(2).max(120) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "view");
        const { searchLinkableBookings } = await import("./whatsappInboxOps");
        return searchLinkableBookings(input.q);
      }),

    link: protectedProcedure
      .input(
        z.object({
          conversationId: z.number().int().positive(),
          bookingId: z.string().trim().min(1).max(128).nullable().optional(),
          clientEmail: z.string().max(320).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "edit");
        const { conversationVisible } = await import("./whatsappInbox");
        if (!(await conversationVisible(input.conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        const { linkConversation } = await import("./whatsappInboxOps");
        const target = input.bookingId
          ? { bookingId: input.bookingId }
          : input.clientEmail?.trim()
            ? { clientEmail: input.clientEmail }
            : null;
        const r = await linkConversation(input.conversationId, target);
        if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error || "Não foi possível ligar" });
        await logActivity({
          userId: ctx.user.id,
          action: "whatsapp_link",
          entity: "whatsapp_conversation",
          entityId: input.conversationId,
          details: target
            ? "bookingId" in target
              ? `Conversa WhatsApp ${input.conversationId} ligada à reserva ${target.bookingId}`
              : `Conversa WhatsApp ${input.conversationId} ligada a um cliente`
            : `Conversa WhatsApp ${input.conversationId} desligada`,
        });
        return { success: true };
      }),

    quickReplies: router({
      list: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "whatsapp", "view");
        const { listQuickReplies } = await import("./whatsappInboxOps");
        return listQuickReplies();
      }),
      save: protectedProcedure
        .input(z.object({ id: z.number().int().positive().nullable().optional(), title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(4000) }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "whatsapp", "edit");
          const { saveQuickReply } = await import("./whatsappInboxOps");
          const id = await saveQuickReply(input, ctx.user.id);
          if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível guardar" });
          return { id };
        }),
      delete: protectedProcedure
        .input(z.object({ id: z.number().int().positive() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "whatsapp", "edit");
          const { deleteQuickReply } = await import("./whatsappInboxOps");
          await deleteQuickReply(input.id);
          return { success: true };
        }),
    }),

    // IA (só com LLM configurado): resumo da conversa ou sugestão de resposta
    // (a sugestão vai para o composer — nunca é enviada sozinha).
    aiAssist: protectedProcedure
      .input(z.object({ conversationId: z.number().int().positive(), mode: z.enum(["summary", "reply"]) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "whatsapp", "edit");
        const { conversationVisible } = await import("./whatsappInbox");
        if (!(await conversationVisible(input.conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
        const { aiAssist } = await import("./whatsappInboxOps");
        const r = await aiAssist(input.conversationId, input.mode, { userId: ctx.user.id });
        if (!r.ok || !r.text) throw new TRPCError({ code: "BAD_REQUEST", message: r.error || "A IA falhou" });
        return { text: r.text };
      }),
  }),

  // ── CRM DE CLIENTES (Jorge, 27 set 2026 — docs/crm/desenho-crm.md) ───────
  //    Fichas na nossa BD (server/crm/*): lista com filtros, ficha, editar,
  //    juntar/separar, sugestões, alertas, filtros guardados. Totais (gasto)
  //    e IBAN só com finance.view_totals; juntar/separar: backoffice+.
  crm: router({
    list: protectedProcedure
      .input(crmQueryInput)
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const db = await crmDb();
        const canSeeTotals = await canSeeFinanceTotals(ctx.user);
        const { listClients } = await import("./crm/queries");
        return { ...(await listClients(db, input, { canSeeTotals })), canSeeTotals };
      }),
    facets: protectedProcedure
      .input(crmQueryInput.extend({ text: z.string().min(1).max(200) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const db = await crmDb();
        const { searchFacets } = await import("./crm/queries");
        return searchFacets(db, input, input.text, { canSeeTotals: await canSeeFinanceTotals(ctx.user) });
      }),
    options: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "clientes", "view");
      const db = await crmDb();
      const { filterOptions, ruleFieldsFor } = await import("./crm/queries");
      const canSeeTotals = await canSeeFinanceTotals(ctx.user);
      return { ...(await filterOptions(db)), ruleFields: ruleFieldsFor(canSeeTotals), canSeeTotals, canMerge: canMergeCrm(ctx.user) };
    }),
    get: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const db = await crmDb();
        const canSeeTotals = await canSeeFinanceTotals(ctx.user);
        const { getClientFile } = await import("./crm/queries");
        const f = await getClientFile(db, input.id, { canSeeTotals, canSeeIban: canSeeTotals });
        if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente não encontrado" });
        return { ...f, canSeeTotals, canMerge: canMergeCrm(ctx.user), canEdit: canAccess(ctx.user, "clientes", "edit") };
      }),
    create: protectedProcedure
      .input(z.object({ displayName: z.string().min(2).max(255), kind: z.enum(["person", "company"]).optional(), email: z.string().max(320).nullable().optional(), phone: z.string().max(40).nullable().optional(), nif: z.string().max(20).nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "edit");
        const { createClient } = await import("./crm/edit");
        return createClient(await crmDb(), ctx.user.id, input);
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number().int().positive(),
        patch: z.object({
          displayName: z.string().max(255).nullable().optional(), firstName: z.string().max(128).nullable().optional(), lastName: z.string().max(128).nullable().optional(),
          kind: z.enum(["person", "company"]).optional(), nif: z.string().max(20).nullable().optional(), taxName: z.string().max(255).nullable().optional(),
          taxAddress: z.string().max(500).nullable().optional(), address: z.string().max(500).nullable().optional(), zone: z.string().max(128).nullable().optional(),
          gender: z.enum(["F", "M", "O"]).nullable().optional(), ageBand: z.enum(["<25", "25-34", "35-44", "45-54", "55-64", "65+"]).nullable().optional(),
          birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), language: z.string().max(8).nullable().optional(),
          isPro: z.boolean().optional(), proDiscount: z.number().min(0).max(100).nullable().optional(),
          consentEmail: z.boolean().nullable().optional(), consentWhatsapp: z.boolean().nullable().optional(), consentSms: z.boolean().nullable().optional(),
          notes: z.string().max(10_000).nullable().optional(), originChannel: z.string().max(64).nullable().optional(),
          tags: z.array(z.string().max(48)).max(40).optional(),
        }),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "edit");
        await crmAssertInScope(input.id);
        const { updateClient } = await import("./crm/edit");
        return updateClient(await crmDb(), ctx.user.id, input.id, input.patch as any);
      }),
    contact: protectedProcedure
      .input(z.discriminatedUnion("op", [
        z.object({ op: z.literal("addEmail"), clientId: z.number().int(), value: z.string().max(320), primary: z.boolean().optional() }),
        z.object({ op: z.literal("removeEmail"), clientId: z.number().int(), itemId: z.number().int(), reason: z.string().max(200).nullable().optional() }),
        z.object({ op: z.literal("primaryEmail"), clientId: z.number().int(), itemId: z.number().int() }),
        z.object({ op: z.literal("addPhone"), clientId: z.number().int(), value: z.string().max(40), primary: z.boolean().optional(), whatsapp: z.boolean().optional(), label: z.string().max(64).nullable().optional() }),
        z.object({ op: z.literal("removePhone"), clientId: z.number().int(), itemId: z.number().int() }),
        z.object({ op: z.literal("primaryPhone"), clientId: z.number().int(), itemId: z.number().int(), whatsapp: z.boolean().optional() }),
        z.object({ op: z.literal("saveVehicle"), clientId: z.number().int(), itemId: z.number().int().optional(), plate: z.string().max(32), brand: z.string().max(64).nullable().optional(), model: z.string().max(96).nullable().optional(), color: z.string().max(48).nullable().optional(), vehicleType: z.string().max(24).nullable().optional() }),
        z.object({ op: z.literal("removeVehicle"), clientId: z.number().int(), itemId: z.number().int() }),
      ]))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "edit");
        await crmAssertInScope(input.clientId);
        const db = await crmDb();
        const e = await import("./crm/edit");
        const u = ctx.user.id;
        try {
          switch (input.op) {
            case "addEmail": await e.addEmail(db, u, input.clientId, input.value, input.primary); break;
            case "removeEmail": await e.removeEmail(db, u, input.clientId, input.itemId, input.reason); break;
            case "primaryEmail": await e.setPrimaryEmail(db, u, input.clientId, input.itemId); break;
            case "addPhone": await e.addPhone(db, u, input.clientId, input.value, { primary: input.primary, whatsapp: input.whatsapp, label: input.label }); break;
            case "removePhone": await e.removePhone(db, u, input.clientId, input.itemId); break;
            case "primaryPhone": await e.setPrimaryPhone(db, u, input.clientId, input.itemId, input.whatsapp); break;
            case "saveVehicle": await e.upsertVehicle(db, u, input.clientId, { id: input.itemId, plate: input.plate, brand: input.brand, model: input.model, color: input.color, vehicleType: input.vehicleType }); break;
            case "removeVehicle": await e.removeVehicle(db, u, input.clientId, input.itemId); break;
          }
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) });
        }
        return { ok: true };
      }),
    uploadPhoto: protectedProcedure
      .input(z.object({ clientId: z.number().int(), vehicleId: z.number().int().nullable().optional(), fileBase64: z.string().max(12_000_000), mimeType: z.string().regex(/^image\/(jpeg|png|webp)$/) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "edit");
        await crmAssertInScope(input.clientId);
        const { storagePut } = await import("./storage");
        const buffer = Buffer.from(input.fileBase64, "base64");
        const ext = input.mimeType.split("/")[1] ?? "jpg";
        const key = `crm/${input.clientId}/${input.vehicleId ? `vehicle-${input.vehicleId}` : "photo"}-${Date.now()}.${ext}`;
        const { url } = await storagePut(key, buffer, input.mimeType);
        const { setPhoto } = await import("./crm/edit");
        await setPhoto(await crmDb(), ctx.user.id, { clientId: input.clientId, vehicleId: input.vehicleId ?? null, url });
        return { url };
      }),
    setIban: protectedProcedure
      .input(z.object({ clientId: z.number().int(), iban: z.string().max(40).nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "edit");
        if (!(await canSeeFinanceTotals(ctx.user))) throw new TRPCError({ code: "FORBIDDEN", message: "O IBAN é só para o backoffice financeiro." });
        await crmAssertInScope(input.clientId);
        const { setIban } = await import("./crm/edit");
        try { await setIban(await crmDb(), ctx.user.id, input.clientId, input.iban); }
        catch (err: any) { throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) }); }
        return { ok: true };
      }),
    relation: protectedProcedure
      .input(z.discriminatedUnion("op", [
        z.object({ op: z.literal("add"), clientId: z.number().int(), relatedClientId: z.number().int(), kind: z.enum(["employee", "manager", "family", "other"]), label: z.string().max(64).nullable().optional(), pays: z.boolean().optional() }),
        z.object({ op: z.literal("remove"), relationId: z.number().int() }),
      ]))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "edit");
        const db = await crmDb();
        const { sql } = await import("drizzle-orm");
        const { addRelation, removeRelation } = await import("./crm/edit");
        if (input.op === "add") {
          await crmAssertInScope(input.clientId, input.relatedClientId);
          const st = await crmRow(sql`SELECT SUM(status = 'active') AS n FROM crm_clients WHERE id IN (${input.clientId}, ${input.relatedClientId})`);
          if (Number(st?.n ?? 0) < 2) throw new TRPCError({ code: "BAD_REQUEST", message: "Só se ligam fichas ativas." });
        } else {
          // só quem vê pelo menos uma das fichas ligadas (a ligação aparece nessa ficha)
          const rel = await crmRow(sql`SELECT clientId, relatedClientId FROM crm_client_relations WHERE id = ${input.relationId}`);
          if (!rel) throw new TRPCError({ code: "NOT_FOUND", message: "Ligação não encontrada." });
          const { visibleClientIds } = await import("./crm/scope");
          if (!(await visibleClientIds(db, [Number(rel.clientId), Number(rel.relatedClientId)])).size) throw new TRPCError({ code: "NOT_FOUND", message: "Ligação não encontrada." });
        }
        try {
          if (input.op === "add") await addRelation(db, ctx.user.id, input);
          else await removeRelation(db, ctx.user.id, input.relationId);
        } catch (err: any) { throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) }); }
        return { ok: true };
      }),
    // ── Fase 2: clientes Pro e conta corrente (lida da BD Multipark por crm-pro-sync) ──
    proList: protectedProcedure
      .input(z.object({ search: z.string().max(120).nullable().optional(), onlyDue: z.boolean().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { listProAccounts } = await import("./crm/proQueries");
        return listProAccounts(await crmDb(), { cities: scopedCityNames(), canSeeTotals: await canSeeFinanceTotals(ctx.user), search: input?.search ?? null, onlyDue: input?.onlyDue });
      }),
    proAccount: protectedProcedure
      .input(z.object({ clientId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        await crmAssertInScope(input.clientId);
        const { getProAccountForClient } = await import("./crm/proQueries");
        return getProAccountForClient(await crmDb(), input.clientId, { cities: scopedCityNames(), canSeeTotals: await canSeeFinanceTotals(ctx.user) });
      }),
    // ── Fase 3: parceiros (agregadores/agências) e parques em que agregamos — ao vivo da BD Multipark ──
    partnersList: protectedProcedure
      .input(z.object({ search: z.string().max(120).nullable().optional(), type: z.enum(["AGGREGATOR", "AGENCY", "PARTNER"]).nullable().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { partnersList } = await import("./crm/partners");
        return partnersList(await crmDb(), { cities: scopedCityNames(), canSeeTotals: await canSeeFinanceTotals(ctx.user), canSeeParcerias: canAccess(ctx.user, "parcerias", "view"), search: input?.search ?? null, type: input?.type ?? null });
      }),
    partner: protectedProcedure
      .input(z.object({ userId: z.string().min(1).max(64) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { partnerDetail } = await import("./crm/partners");
        const r = await partnerDetail(await crmDb(), input.userId, { cities: scopedCityNames(), canSeeTotals: await canSeeFinanceTotals(ctx.user), canSeeParcerias: canAccess(ctx.user, "parcerias", "view") });
        if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Parceiro não encontrado" });
        return { ...r, canEdit: canAccess(ctx.user, "clientes", "edit") };
      }),
    parksList: protectedProcedure
      .input(z.object({ search: z.string().max(120).nullable().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { parksList } = await import("./crm/partners");
        return parksList(await crmDb(), { cities: scopedCityNames(), canSeeTotals: await canSeeFinanceTotals(ctx.user), search: input?.search ?? null });
      }),
    park: protectedProcedure
      .input(z.object({ parkId: z.string().min(1).max(64) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { parkDetail } = await import("./crm/partners");
        const r = await parkDetail(await crmDb(), input.parkId, { cities: scopedCityNames(), canSeeTotals: await canSeeFinanceTotals(ctx.user) });
        if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Parque não encontrado" });
        return { ...r, canEdit: canAccess(ctx.user, "clientes", "edit") };
      }),
    saveExternalLink: protectedProcedure
      .input(z.object({
        // partnershipId: null = ligar sozinho; 0 = sem ligação; > 0 = registo escolhido
        kind: z.enum(["partner", "park"]), mpId: z.string().min(1).max(64), partnershipId: z.number().int().min(0).nullable().optional(),
        notes: z.string().max(10_000).nullable().optional(), contactName: z.string().max(255).nullable().optional(),
        contactEmail: z.string().max(320).nullable().optional(), contactPhone: z.string().max(40).nullable().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "edit");
        const db = await crmDb();
        // só quem vê o parceiro/parque (âmbito de cidade) o anota
        const p = await import("./crm/partners");
        const live = await import("./multiparkDb/partners");
        // verificação leve (só parques e parceiros), no âmbito de cidade de quem pede
        const seen = input.kind === "partner" ? await live.readPartnerVisible(input.mpId, scopedCityNames()) : await live.readParkVisible(input.mpId, scopedCityNames());
        if (!seen.available) throw new TRPCError({ code: "PRECONDITION_FAILED", message: seen.reason });
        if (!seen.data) throw new TRPCError({ code: "NOT_FOUND", message: input.kind === "partner" ? "Parceiro não encontrado" : "Parque não encontrado" });
        // qualquer mudança da ligação (registo, automática ou "sem ligação") pede acesso às Parcerias
        if (input.partnershipId !== undefined && !canAccess(ctx.user, "parcerias", "view")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Ligar às Parcerias: é preciso acesso às Parcerias." });
        }
        if (input.partnershipId) {
          const { sql } = await import("drizzle-orm");
          if (!(await crmRow(sql`SELECT id FROM partnerships WHERE id = ${input.partnershipId}`))) throw new TRPCError({ code: "BAD_REQUEST", message: "Registo das Parcerias não encontrado." });
        }
        await p.saveLink(db, ctx.user.id, input);
        return { ok: true };
      }),
    /** Ligações antigas `/clientes?email=`: fichas com este email EXATO. */
    byEmail: protectedProcedure
      .input(z.object({ email: z.string().min(3).max(320) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { clientIdsByEmail } = await import("./crm/queries");
        return { ids: await clientIdsByEmail(await crmDb(), input.email) };
      }),
    pick: protectedProcedure
      .input(z.object({ text: z.string().min(2).max(120), excludeId: z.number().int().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { listClients } = await import("./crm/queries");
        const r = await listClients(await crmDb(), { search: { text: input.text, field: "all" }, limit: 8 }, { canSeeTotals: false });
        return r.rows.filter((x) => x.id !== input.excludeId).map((x) => ({ id: x.id, name: x.displayName, email: x.primaryEmail, isPro: x.isPro, kind: x.kind }));
      }),
    merge: protectedProcedure
      .input(z.object({ survivorId: z.number().int(), mergedId: z.number().int(), reason: z.string().max(255).nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "edit");
        if (!canMergeCrm(ctx.user)) throw new TRPCError({ code: "FORBIDDEN", message: "Juntar fichas: backoffice, administração." });
        await crmAssertInScope(input.survivorId);
        await crmAssertInScope(input.mergedId);
        const db = await crmDb();
        const { mergeClients } = await import("./crm/merge");
        const { logCrm } = await import("./crm/edit");
        try {
          const r = await mergeClients(db, { ...input, userId: ctx.user.id });
          await logCrm(ctx.user.id, input.survivorId, "crm_merge", { mergedId: input.mergedId, eventId: r.eventId, reason: input.reason ?? null });
          await logCrm(ctx.user.id, input.mergedId, "crm_merged_into", { survivorId: input.survivorId, eventId: r.eventId });
          return r;
        } catch (err: any) { throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) }); }
      }),
    split: protectedProcedure
      .input(z.object({ eventId: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "edit");
        if (!canMergeCrm(ctx.user)) throw new TRPCError({ code: "FORBIDDEN", message: "Separar fichas: backoffice, administração." });
        const { sql } = await import("drizzle-orm");
        const ev = await crmRow(sql`SELECT survivorId FROM crm_merge_events WHERE id = ${input.eventId}`);
        if (!ev) throw new TRPCError({ code: "NOT_FOUND", message: "Fusão não encontrada." });
        await crmAssertInScope(Number(ev.survivorId));
        const db = await crmDb();
        const { splitMerge } = await import("./crm/merge");
        const { logCrm } = await import("./crm/edit");
        try {
          const r = await splitMerge(db, { eventId: input.eventId, userId: ctx.user.id });
          await logCrm(ctx.user.id, r.survivorId, "crm_split", { mergedId: r.mergedId, eventId: input.eventId });
          await logCrm(ctx.user.id, r.mergedId, "crm_split", { survivorId: r.survivorId, eventId: input.eventId });
          return r;
        } catch (err: any) { throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) }); }
      }),
    dismissSuggestion: protectedProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "edit");
        const { sql } = await import("drizzle-orm");
        const s = await crmRow(sql`SELECT clientA, clientB FROM crm_merge_suggestions WHERE id = ${input.id}`);
        if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Sugestão não encontrada." });
        await crmAssertInScope(Number(s.clientA), Number(s.clientB));
        const { dismissSuggestion } = await import("./crm/edit");
        await dismissSuggestion(await crmDb(), ctx.user.id, input.id);
        return { ok: true };
      }),
    /** Juntar AGORA as sugestões óbvias (mesmo nome + telefone/email/NIF). Admin; o resto fica para a cron. */
    autoMergeNow: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "clientes", "edit");
      if (!["admin", "super_admin"].includes(String(ctx.user.role))) throw new TRPCError({ code: "FORBIDDEN", message: "Só um administrador corre a junção automática." });
      const db = await crmDb();
      const { autoMergeConfident } = await import("./crm/merge");
      const r = await autoMergeConfident(db, { deadlineAt: Date.now() + 40_000, userId: ctx.user.id });
      await logActivity({ userId: ctx.user.id, action: "crm_auto_merge", entity: "crm", entityId: 0, details: `Junção automática à mão: ${r.merged} fichas juntas (${r.checked} vistas, ${r.skipped} ficaram para rever)` });
      return r;
    }),
    review: protectedProcedure
      .input(z.object({ tab: z.enum(["suggestions", "generic", "noEmail", "merges"]), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(), minScore: z.number().int().min(0).max(100).optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const db = await crmDb();
        const r = await import("./crm/review");
        const counts = await r.reviewCounts(db);
        if (input.tab === "suggestions") return { tab: "suggestions" as const, counts, suggestions: await r.listSuggestions(db, input) };
        if (input.tab === "generic") return { tab: "generic" as const, counts, generic: await r.genericEmailClients(db, input) };
        if (input.tab === "noEmail") return { tab: "noEmail" as const, counts, upcoming: await r.upcomingWithoutEmail(db, { days: 3 }) };
        return { tab: "merges" as const, counts, merges: await r.recentMerges(db, input) };
      }),
    findEmail: protectedProcedure
      .input(z.object({ clientId: z.number().int() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        await crmAssertInScope(input.clientId);
        const { findEmailInMailbox } = await import("./crm/review");
        // super admin: todas as caixas; os outros: só as conversas que já podem ver na Comunicação
        const { visibleThreadsCondition } = await import("./mail/inbox");
        const { withOverrides } = await import("./_core/access");
        const w = withOverrides(ctx.user as any);
        const visible = await visibleThreadsCondition({ id: w.id, role: w.role, accessOverrides: w.accessOverrides ?? null });
        return findEmailInMailbox(await crmDb(), input.clientId, visible);
      }),
    savedFilters: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "clientes", "view");
      const { listSavedFilters } = await import("./crm/edit");
      return listSavedFilters(await crmDb(), ctx.user.id);
    }),
    saveFilter: protectedProcedure
      .input(z.object({ id: z.number().int().optional(), name: z.string().min(1).max(128), payload: z.any(), shared: z.boolean(), isDefault: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { saveFilter } = await import("./crm/edit");
        return saveFilter(await crmDb(), ctx.user.id, input);
      }),
    deleteFilter: protectedProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { deleteFilter } = await import("./crm/edit");
        await deleteFilter(await crmDb(), ctx.user.id, input.id);
        return { ok: true };
      }),
  }),

  // ── HISTÓRICO DE CLIENTE (reservas + reclamações + perdidos + críticas) ─────
  clients: router({
    // O "CRM leve" antigo (lista/estatísticas/ficha por email) saiu na fase 2
    // do CRM (29 set 2026): a lista e a ficha são o CRM (crm.*); aqui fica o
    // histórico do cliente para as outras páginas, também já pelas fichas.
    history: protectedProcedure
      .input(z.object({
        clientId: z.number().int().positive().nullable().optional(),
        email: z.string().max(320).nullable().optional(),
        phone: z.string().max(40).nullable().optional(),
        plate: z.string().max(32).nullable().optional(),
        name: z.string().max(200).nullable().optional(),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { getClientHistory } = await import("./db");
        const h = await getClientHistory(input);
        // Mesmo gate da ficha de Clientes: sem permissão de totais, sem valores
        if (await canSeeFinanceTotals(ctx.user)) return { ...h, canSeeTotals: true };
        return {
          ...h,
          canSeeTotals: false,
          bookingStats: { ...h.bookingStats, totalSpent: null, avgSpend: null },
          bookings: h.bookings.map((b: any) => ({ ...b, totalPrice: null })),
        };
      }),

    // Lista/pesquisa emails inbound de um alias, para anexar à mão a um caso.
    inboundEmails: protectedProcedure
      .input(z.object({ alias: z.enum(["reclamacoes", "perdidos", "criticas", "recursos-humanos"]), search: z.string().nullable().optional() }))
      .query(async ({ ctx, input }) => {
        // Cada caixa pede o módulo dela (16b): antes bastava "clientes" para ler
        // os emails de recursos-humanos@ (candidaturas) — agora a mesma regra
        // da aba Recrutamento (Leads de Extras).
        requireAccess(ctx.user, INBOUND_ALIAS_MODULE[input.alias], "view");
        const { searchInboundEmails } = await import("./db");
        return searchInboundEmails(input.alias, input.search);
      }),

    // Anexa um email inbound a um caso: transcreve o conteúdo como MENSAGEM do
    // caso e marca o email como pertencendo a esse caso. Para o cenário multi-
    // identidade (ex.: email do marido) que o match automático não apanha.
    linkInbound: protectedProcedure
      .input(z.object({
        inboundId: z.number(),
        module: z.enum(["complaint", "lostfound"]),
        caseId: z.number(),
      }))
      .mutation(async ({ ctx, input }) => {
        // Anexar mexe no caso: pede a edição do módulo do caso e confirma a
        // cidade dele (16b).
        requireAccess(ctx.user, input.module === "complaint" ? "reclamacoes" : "perdidos", "edit");
        if (input.module === "complaint") {
          if (!(await getComplaintById(input.caseId))) throw new TRPCError({ code: "NOT_FOUND", message: "Reclamação não encontrada" });
        } else await loadLostInScope(input.caseId);
        const { getInboundEmailById, setInboundEmailTarget } = await import("./db");
        const em = await getInboundEmailById(input.inboundId);
        if (!em) throw new TRPCError({ code: "NOT_FOUND", message: "Email não encontrado" });
        // Anexar outra vez ao mesmo caso não duplica a mensagem.
        if ((em as any).targetModule === input.module && Number((em as any).targetId) === input.caseId) return { ok: true, already: true };
        const who = em.clientName || em.fromName || em.fromEmail || "Cliente";
        const msg = `📥 Email do cliente (${who}) — ${em.subject || "(sem assunto)"}\n\n${em.bodyText || ""}`.slice(0, 5000);
        if (input.module === "complaint") {
          await addComplaintMessage({ complaintId: input.caseId, message: msg, isInternal: 0, authorName: who } as any);
          await setInboundEmailTarget(input.inboundId, "complaint", input.caseId);
        } else {
          await addLostFoundMessage({ itemId: input.caseId, userId: ctx.user.id, userName: who, message: msg, isInternal: 0 } as any);
          await setInboundEmailTarget(input.inboundId, "lostfound", input.caseId);
        }
        await logActivity({ userId: ctx.user.id, action: "link_email", entity: input.module, entityId: input.caseId, details: `Email anexado: ${em.subject ?? ""}` });
        return { ok: true };
      }),
  }),
});
export type AppRouter = typeof appRouter;
