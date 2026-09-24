import { TRPCError } from "@trpc/server";
import { projectScope, bookingHistoryScope, scopedProjectIds, assertEmployeeAccess, assertProjectAccess, requireGlobalCityAccess, cityScope as cityScopeStore } from './cityScope';
import {
  INCIDENT_SEVERITIES, INCIDENT_STATUSES, INCIDENT_TYPES, LOST_ITEM_TYPES, LOST_PRIORITIES, LOST_STATUSES,
  contentTypeForFilename, incidentStatusPatch, lostStatusPatch, safeExt, textToSafeHtml, utcNowStr,
} from "../shared/caseRules";
import { trainingRouter } from './trainingRouter';
import { tasksRouter } from './tasksRouter';
import { settingsRouter } from './settingsRouter';
import { evaluationRouter } from './evaluationRouter';
import { assistantRouter } from './assistant/router';
import { z } from "zod";
import * as XLSX from "xlsx";
import { ACCESS_DENIED_MSG, COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { requireAccess, isOwnOnly, userIdsAtOrBelowInCity, employeeBelowCondition } from "./_core/access";
import { ROLE_RANK as ACCESS_ROLE_RANK, MODULE_IDS, can, scopeFor, canSeeFinanceTotalsFor, canManageUserRole, canGrantPermissionsTo, canTouchPermission, assignableRoles, isNationalRole, seesBeyondOwn, type ModuleId, type Action as AccessAction } from "../shared/access";
import { normalizeEmail } from "@shared/email";
import { USER_ROLES, superAdminGuard, inviteCompletionError } from "./userAdminRules";
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
import { notifyOwner } from "./_core/notification";
import { storagePut } from "./storage";
import { resolveExpenseVisibility, expenseConditions, whereAll, canSeeExpense, canSeeAggregates, type ExpenseListFilters, type ExpenseVisibility } from "./expenseScope";
import { parseExpenseAmount } from "../shared/expenseAmount";
import { CLOTHING_MAX_ITEMS, CLOTHING_MAX_QTY, CLOTHING_SIZES, CLOTHING_TYPES, normalizeClothingItems } from "../shared/clothing";
import {
  DEACTIVATION_NOTES_MAX,
  DEACTIVATION_REASON_CODES,
  DEACTIVATION_REASON_OTHER_MAX,
  resolveDeactivation,
  type DeactivationInput,
  type ResolvedDeactivation,
} from "../shared/deactivationReasons";
import { dayToMysql, isIsoDay, lisbonToday } from "../shared/expensePeriods";
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
import { expenseTotals } from "../shared/expenseTotals";
import { getBillingData, getAnnualBreakdown } from "./finance/compat";
import { canViewDocuments, canViewEmployee, canViewTimeAndSchedule, canEditPersonal, canEditContract, canDeleteDocument, employeeAccess, sanitizeEmployee, sanitizeEmployeeRows, isOwn, CENTER_SCOPED_ROLES, PERSONAL_FIELDS, CONTRACT_FIELDS, type RhViewer, type EmployeeRef, isRhAdmin, canEditIdentity, canReadEmployeeRecord } from "./rhAccess";
import {
  applyDocsCompliance, getExtraDocsStatus, detectExtraDiaNoShows, listPendingPenalties, reviewPenalty,
  listSuspiciousTimeRecords, reviewTimeRecord, insertTimeRecordAtomic,
  createPayrollRun, listPayrollRuns, getPayrollRun, transitionPayrollRun,
} from "./rhService";
import { googleAdsRouter } from "./integrations/googleAds/router";
import { metaAdsRouter } from "./integrations/meta/router";
import { googleBusinessRouter } from "./integrations/googleBusiness/router";
import { integrationsHubRouter } from "./integrations/hubRouter";
import { getBookingHistory, getBookingsReport, getBookingTryAllParks } from "./multipark";
import { deliveryErrorCode } from "./bookingDeliveryQueue";
import {
  getExtrasDiaForecast,
  listAssignments,
  upsertAssignment,
  deleteAssignment,
  listDriverCandidates,
  getBookingsInSlot,
  getExtrasDiaCostForRange,
} from "./extrasDia";
import { importExtrasFromCsv } from "./extrasImport";
import {
  sendWeeklyAvailabilityRequest,
  getMyWeek,
  setMyAvailability,
  getWeekOverview,
  nextMonday,
  mondayOf,
  setEmployeeAvailability,
} from "./extrasAvailability";
import { sendBroadcast } from "./whatsappBroadcast";
import { describeLookupFailure, getTemplateMeta } from "./whatsappTemplateMeta";
import {
  listConversations,
  getConversationThread,
  markConversationRead,
  replyToConversation,
} from "./whatsappInbox";
import {
  upsertUser,
  getUserByOpenId,
  getAllUsers,
  updateUserRole,
  createManualUser,
  getUserByEmail,
  checkExtraDocsCompliance,
  processExtraDiaNoShows,
  getOpenPenalties,
  clearPenalty,
  unblockEmployeeLogin,
  getEmployeeLeaves,
  createEmployeeLeave,
  deleteEmployeeLeave,
  getEmployeeSalaryHistory,
  getRhDashboardSummary,
  updateUser,
  toggleUserActive,
  deactivationColumns,
  getUserById,
  getSuperAdmins,
  getProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
  moveProject,
  getProjectEmployees,
  getEmployeeProjects,
  assignEmployeeToProject,
  removeEmployeeFromProject,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  getTaskStats,
  getAllCategories,
  createCategory,
  seedDefaultCategories,
  listExpenses,
  summarizeExpenses,
  recordExpenseEvent,
  getExpenseEvents,
  findPossibleDuplicateExpense,
  projectExists,
  categoryExists,
  resolveProjectIds,
  getExpenseById,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseStats,
  getUpcomingPayments,
  getOverdueExpenses,
  markOverdueExpenses,
  logActivity,
  getActivityLogs,
  // RH
  getAllEmployees,
  getEmployeeById,
  getEmployeeByUserId,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getEmployeeDocuments,
  createEmployeeDocument,
  createEmployeeDocumentsBatch,
  deleteEmployeeDocument,
  getDocumentChecklistForEmployee,
  getAllEmployeesDocumentStatus,
  getEmployeeSchedules,
  upsertSchedule,
  deleteSchedule,
  getTimeRecords,
  createTimeRecord,
  checkGeofenceNote,
  setProjectGeofence,
  deleteProjectGeofence,
  listProjectGeofences,
  getMonthlyHours,
  getExtraRates,
  seedExtraRates,
  updateExtraRate,
  getHRStats,
  // Operacional
  getVehicles,
  getVehicleById,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  getVehicleMovements,
  createVehicleMovement,
  getSpeedAlerts,
  createSpeedAlert,
  acknowledgeSpeedAlert,
  getRadioTranscriptions,
  createRadioTranscription,
  getOperationalStats,
  getVehicleDriverHistory,
  // API Keys
  getApiKeys,
  createApiKey,
  toggleApiKey,
  deleteApiKey,
  // Reclamações
  getComplaints,
  getComplaintById,
  createComplaint,
  updateComplaint,
  deleteComplaint,
  getComplaintMessages,
  addComplaintMessage,
  getComplaintPhotos,
  addComplaintPhoto,
  deleteComplaintPhoto,
  getComplaintStats,
  // Google Reviews
  createGoogleReview,
  getGoogleReviews,
  getGoogleReviewById,
  updateGoogleReview,
  getGoogleReviewStats,
  searchClientHistory,
  // Perdidos e Achados
  createLostFoundItem,
  getLostFoundItems,
  getLostFoundItemById,
  updateLostFoundItem,
  deleteLostFoundItem,
  addLostFoundPhoto,
  getLostFoundPhotos,
  addLostFoundMessage,
  getLostFoundMessages,
  getBookingHistoryByBookingId,
  getBookingHistoryByPlate,
  searchBookingHistory,
  getBookingHistoryDriverStats,
  getBookingHistoryCrossReference,
  // Incidents
  createIncident,
  getIncidents,
  getIncidentById,
  updateIncident,
  deleteIncident,
  getIncidentStats,
  // Performance Evaluations
  createPerformanceEvaluation,
  getPerformanceEvaluations,
  updatePerformanceEvaluation,
  deletePerformanceEvaluation,
  generateWeeklyEvaluation,
  // Services
  // Invoices
  getPartnershipAnalytics,
  // Partnerships
  createPartnership,
  getPartnerships,
  inferPartnersFromBookings,
  addPartnerAlias,
  updatePartnership,
  deletePartnership,
  partnershipNameExists,
  // Annual Reports
  createAnnualReport,
  getAnnualReports,
  updateAnnualReport,
  deleteAnnualReport,
  generateAnnualSummary,
  // MultiPark
  getMultiparkBookings,
  getMultiparkBookingByExternalId,
  upsertMultiparkBooking,
  getMultiparkBookingStats,
  createSyncLog,
  getSyncLogs,
  // MultiPark KPIs
  // Invites
  createInviteToken,
  getInviteByToken,
  acceptInviteToken,
  claimInviteToken,
  releaseInviteToken,
  countActiveSuperAdmins,
  getInvitesByUser,
  getInvitesByEmail,
  linkInviteToOAuthUser,
  getPayrollData,
  getProjectCosts,
  savePayslipRecord,
  getPayslipHistoryList,
  deletePayslipRecord,
  getTaskAssignees,
  setTaskAssignees,
  getOverdueTasks,
  getRecentlyCompletedTasks,
  markTaskNotified,
  getProjectHierarchyManagers,
  // Speed monitoring
  getSpeedLimits,
  getDefaultSpeedLimit,
  createSpeedLimit,
  updateSpeedLimit,
  deleteSpeedLimit,
  recordSpeedViolation,
  getSpeedViolations,
  acknowledgeSpeedViolation,
  getSpeedViolationStats,
  // Daily driver history
  createDailyDriverHistory,
  getDailyDriverHistoryByDate,
  getDailyDriverHistoryByUser,
  getDailyDriverHistoryRange,
  getDailyDriverStats,
  // PDAs
  createPda,
  updatePda,
  deletePda,
  listPdas,
  getPdaById,
  // PDA Check-ins
  createPdaCheckin,
  checkoutPda,
  getActiveCheckins,
  getCheckinsByDate,
  getCheckinsByPda,
  // GPS Alerts
  createGpsAlert,
  getGpsAlerts,
  acknowledgeGpsAlert,
  getGpsAlertStats,
  searchBookingByRef,
} from "./db";
import { generatePayrollPdf } from "./payrollPdf";
import { generatePayslipPdf, generateAllPayslipsPdf } from "./payslipPdf";

import {
  healthCheck as mpHealthCheck,
  checkAvailability as mpCheckAvailability,
  listParks as mpListParks,
  testConnection as mpTestConnection,
  getBookingsReportAllParks,
  type ParkingType,
  type VehicleType,
  type BookingActionType,
} from "./multipark";

import {
  getZelloUsers,
  getZelloChannels,
  getZelloLocations,
  getZelloUserHistory,
  getZelloUserLocation,
} from "./zello";
import { collectDailyDriverData } from "./jobs/dailyDriverCollection";
import { LEAD_STATUSES } from "../shared/extraLeadsFunnel";

/** Estados dos leads de extras (inclui `replied` — "Respondeu"). */
const LEAD_STATUS_ENUM = LEAD_STATUSES;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Dia "YYYY-MM-DD" válido (mês/dia reais) — nunca colado em SQL, mas validado na mesma.
const handoverDaySchema = z.string().refine(isIsoDay, "Data inválida (AAAA-MM-DD)");

// Hierarquia (modelo de acessos, shared/access.ts): user < extra < condutor <
// team_leader < supervisor < frontoffice = backoffice < admin < super_admin.
// A porta de cada módulo é `requireAccess(user, módulo, ação)`; `requireRole`
// fica só para limiares FINOS dentro de um módulo (ex.: só super_admin apaga).
const ROLE_HIERARCHY: Record<string, number> = { ...ACCESS_ROLE_RANK };

function requireRole(userRole: string, minRole: string) {
  if ((ROLE_HIERARCHY[userRole] ?? -1) < (ROLE_HIERARCHY[minRole] ?? 0)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
  }
}

/** Deny explícito de uma permissão por utilizador (regra Jorge: "menos
 * permissões por utilizador" — ex.: backoffice de despesas sem ver totais). */
async function isPermissionDenied(userId: number, permission: string): Promise<boolean> {
  const { getUserPermissionOverrides } = await import("./db");
  const ov = await getUserPermissionOverrides(userId);
  return ov[permission] === "deny";
}

/** Totais financeiros: módulo Financeiro (admin+) sem deny de
 * finance.view_totals; um grant explícito abre-os a supervisor/front/backoffice. */
async function canSeeFinanceTotals(user: { id: number; role: string }): Promise<boolean> {
  const { getUserPermissionOverrides } = await import("./db");
  return canSeeFinanceTotalsFor(user, await getUserPermissionOverrides(user.id));
}

/** Porta do módulo + totais financeiros (respeita o deny de finance.view_totals). */
async function requireFinanceTotals(user: { id: number; role: string }, module: ModuleId, action: AccessAction = "view") {
  requireAccess(user, module, action);
  if (!(await canSeeFinanceTotals(user))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para ver totais financeiros." });
  }
}

/** Admins de cidade não mexem nos nós estruturais (Grupo/Cidade): só no que
 * está dentro das suas cidades. Global mantém tudo. */
function assertStructuralNodeEditable(node: { level: string }) {
  if (scopedProjectIds() !== undefined && (node.level === "group" || node.level === "city")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Só quem tem acesso a todas as cidades pode alterar grupos e cidades." });
  }
}

// ─── DESPESAS: âmbito único (ver server/expenseScope.ts) ─────────────────────
async function expenseVisibilityFor(user: { id: number; role: string }): Promise<ExpenseVisibility> {
  return resolveExpenseVisibility(user, {
    denied: isPermissionDenied,
    employeeProjectId: async (uid) => {
      const emp = await getEmployeeByUserId(uid);
      return emp?.employee?.projectId ?? null;
    },
    resolveProjectIds,
    teamUserIds: userIdsAtOrBelowInCity,
  });
}

interface ExpenseListInput {
  startDate?: string; endDate?: string; projectId?: number; categoryId?: number;
  userId?: number; status?: string; search?: string;
}

/** Filtros do pedido + visibilidade do utilizador → WHERE (lista, Excel, totais). */
async function expenseWhereFor(user: { id: number; role: string }, input?: ExpenseListInput) {
  const vis = await expenseVisibilityFor(user);
  const filters: ExpenseListFilters = {
    startDate: input?.startDate || undefined,
    endDate: input?.endDate || undefined,
    categoryId: input?.categoryId || undefined,
    userId: input?.userId || undefined,
    status: input?.status || undefined,
    search: input?.search?.trim() || undefined,
  };
  // Cidade inclui marcas e projetos descendentes; marca global (id negativo)
  // inclui essa marca em todas as cidades. Nunca "igualdade ao id".
  if (input?.projectId) filters.projectIds = await resolveProjectIds(input.projectId);
  try {
    return { vis, where: whereAll(expenseConditions(filters, vis)) };
  } catch (e: any) {
    throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
  }
}

const EXPENSE_LIST_INPUT = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  projectId: z.number().optional(),
  categoryId: z.number().optional(),
  userId: z.number().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
}).optional();

/** Campos cuja alteração muda o valor financeiro (invalidam uma aprovação). */
const EXPENSE_FINANCIAL_FIELDS = ["amount", "currency", "expenseDate", "projectId", "categoryId", "supplier", "supplierNif", "documentNumber", "paidBy", "buyerId"] as const;

function cleanText(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === "" || t === "null" || t === "undefined" ? null : t;
}

/**
 * O comprovativo de uma despesa tem de ser um ficheiro carregado pelo próprio
 * (uploadInvoice grava em invoices/<userId>/…). Sem isto, quem conhecesse a
 * key de outro ficheiro obtinha uma URL assinada dele via documentUrl.
 */
function assertOwnInvoiceKey(userId: number, key: string | null | undefined, url: string | null | undefined) {
  if (!key && !url) return;
  if (!key || !key.startsWith(`invoices/${userId}/`) || key.includes("..")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Comprovativo inválido — volta a carregar o ficheiro" });
  }
}

function dayOrBadRequest(day: string, label: string): string {
  try { return dayToMysql(day); } catch { throw new TRPCError({ code: "BAD_REQUEST", message: `${label} inválida (usa AAAA-MM-DD)` }); }
}

/**
 * Motivo/notas da desativação pela regra ÚNICA de shared/deactivationReasons.ts
 * (usada pelos DOIS caminhos: `users.toggleActive` e `rh.setActive`). A mensagem
 * em PT do validador é a que chega ao utilizador.
 */
function resolveDeactivationOrThrow(input: DeactivationInput): ResolvedDeactivation {
  try {
    return resolveDeactivation(input);
  } catch (err: any) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err?.message || "Motivo de desativação inválido" });
  }
}

// ─── RH: quem está a ver (permissões por finalidade — server/rhAccess.ts) ────
async function rhViewer(user: { id: number; role: string }): Promise<RhViewer> {
  const me = await getEmployeeByUserId(user.id);
  let scope: number[] | null = null;
  // supervisor, team_leader e frontoffice mexem nas fichas do SEU centro de
  // custos (com descendentes) — o centro da ficha, não a cidade inteira.
  if ((CENTER_SCOPED_ROLES as readonly string[]).includes(user.role)) {
    const pid = me?.employee?.projectId ?? null;
    scope = pid != null ? await resolveProjectIds(pid) : [];
  }
  return { id: user.id, role: user.role, employeeId: me?.employee?.id ?? null, scopeProjectIds: scope };
}
/** Referência da ficha COM o role da conta associada (para proteger fichas de admin/super_admin). */
async function rhEmployeeRef(employeeId: number): Promise<EmployeeRef | null> {
  const e = await getEmployeeById(employeeId);
  if (!e) return null;
  return { id: e.employee.id, projectId: e.employee.projectId ?? null, role: await employeeAccountRole(e.employee.userId ?? null) };
}
async function employeeAccountRole(userId: number | null): Promise<string | null> {
  if (userId == null) return null;
  const u = await getUserById(userId);
  return u?.role ?? null;
}
/** Ficha + o que o utilizador pode fazer nela; lança FORBIDDEN se não a pode ver. */
async function rhEmployeeRefOrThrow(employeeId: number): Promise<EmployeeRef> {
  const ref = await rhEmployeeRef(employeeId);
  if (!ref) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
  return ref;
}
/** Âmbito de cidade nas escritas — a própria ficha passa sempre (pode nem ter centro). */
async function assertEmployeeWriteScope(viewer: RhViewer, ref: EmployeeRef): Promise<void> {
  if (isOwn(viewer, ref.id)) return;
  await assertEmployeeAccess(ref.id);
}
/**
 * Leitura de registos de uma ficha (horas, férias, salário, penalizações):
 * a própria passa sempre; senão exige `minRole` e a ficha no âmbito de cidade
 * do pedido — também para admin (um admin limitado a uma cidade não lê
 * outra). Regra pura em rhAccess.canReadEmployeeRecord.
 */
async function assertOwnOrScopedEmployee(user: { id: number; role: string }, employeeId: number, minRole: string): Promise<void> {
  const me = await getEmployeeByUserId(user.id);
  const viewer = { role: user.role, employeeId: me?.employee?.id ?? null };
  if (viewer.employeeId === employeeId) return;
  const target = await getEmployeeById(employeeId);
  const ok = canReadEmployeeRecord(viewer, { id: employeeId, projectId: target?.employee.projectId ?? null }, minRole, scopedProjectIds());
  if (!ok) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
}
/** Documentos: quem mexe nos dados pessoais da ficha; sem ficha, só admin+ (checklists vazias). */
async function assertCanViewDocuments(user: { id: number; role: string }, employeeId: number, message: string): Promise<void> {
  const viewer = await rhViewer(user);
  const ref = await rhEmployeeRef(employeeId);
  const allowed = ref ? canViewDocuments(viewer, ref) : isRhAdmin(viewer);
  if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message });
}
async function assertCanUploadDocuments(user: { id: number; role: string }, employeeId: number): Promise<void> {
  const viewer = await rhViewer(user);
  const ref = await rhEmployeeRefOrThrow(employeeId);
  if (!canEditPersonal(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para carregar documentos nesta ficha" });
  await assertEmployeeWriteScope(viewer, ref);
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

/** Cidade por omissão de quem está limitado a cidades (para o registo não ficar invisível). */
function defaultScopedProjectId(): number | null {
  const a = cityScopeStore.getStore();
  return a && !a.all ? a.defaultCityId ?? null : null;
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

/** Ações da sincronização (reparar, etc.): só quem tem alcance NACIONAL no
 *  módulo — um supervisor de cidade vê a página mas não lança syncs. */
function requireNationalSync(user: { id?: number; role: string }) {
  if (requireAccess(user, "sincronizacao", "edit") !== "national") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Só quem tem âmbito nacional pode lançar a sincronização." });
  }
}

/** A reserva (externalId ou nº) pertence às cidades do utilizador? */
async function bookingRefInScope(ref: string): Promise<boolean> {
  const ids = scopedProjectIds();
  if (ids === undefined) return true;
  const { getDb } = await import("./db");
  const { multiparkBookings } = await import("../drizzle/schema");
  const { eq, or } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return false;
  const [b] = await db.select({ projectId: multiparkBookings.projectId }).from(multiparkBookings)
    .where(or(eq(multiparkBookings.externalId, ref), eq(multiparkBookings.bookingNumber, ref))).limit(1);
  return !!b?.projectId && ids.includes(b.projectId);
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

    // Sincroniza os emails inbound (reclamações/perdidos/críticas/RH) on-demand.
    // backoffice+ (a equipa de suporte usa o botão nas Reclamações/Recrutamento).
    // Mesmo prazo do cron (45s < maxDuration 60s do Vercel): sem ele o botão
    // morria com 504 a meio; partial:true → carregar outra vez continua
    // (dedup por messageId torna cada corrida incremental).
    runEmailInbound: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "sincronizacao", "edit");
      const { runEmailInboundSync } = await import("./jobs/emailInboundSync");
      const result = await runEmailInboundSync({ deadlineAt: Date.now() + 45_000 });
      await logActivity({
        userId: ctx.user.id,
        action: "email_sync",
        entity: "inbound_emails",
        details: `criados=${result.created} ignorados=${result.skipped} erros=${result.errors.length}${result.partial ? " (parcial)" : ""}`,
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
        } else if (safeData.role !== undefined) {
          delete safeData.role;
        }
        // Auto-edição nunca religa fichas por email.
        await updateUser(userId, safeData, { relinkEmployees: !isSelf });
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
        await updateUserRole(input.userId, input.role);
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
        await toggleUserActive(
          input.userId,
          input.isActive,
          deactivation ? { ...deactivation, byUserId: ctx.user.id } : null,
        );
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
      const access = await loadCityAccess(ctx.user.id);
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
    costs: protectedProcedure
      .input(z.object({ year: z.number().optional(), month: z.number().optional() }).optional())
      .query(async ({ ctx, input }) => {
        // Expõe salários: exige ver totais financeiros + âmbito de cidade.
        await requireFinanceTotals(ctx.user, "projetos", "view");
        const rows = await getProjectCosts(input?.year, input?.month);
        const scoped = scopedProjectIds();
        return scoped === undefined ? rows : rows.filter(r => scoped.includes(r.id));
      }),
  }),

  // ── TASKS (KANBAN) ────────────────────────────────────────────────────────────
  tasks: tasksRouter,
  assistant: assistantRouter,
  settings: settingsRouter,

  // ── AVALIAÇÃO (motor único: individual + "A minha avaliação") ────────────────
  evaluation: evaluationRouter,

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
  expenses: router({
    // Matriz do Jorge (2026-08-04) + plano de controlo financeiro (set 2026):
    // backoffice/team_leader inserem e acompanham as PRÓPRIAS; supervisor vê
    // as suas + o seu centro de custos (com descendentes); admin+ vê tudo,
    // salvo deny individual de totais. A MESMA regra vale para detalhe,
    // totais, comparação, Excel e documentos (expenseWhereFor/canSeeExpense).
    // O que o utilizador pode ver: o ecrã mostra totais/comparar/exportar só
    // quando o servidor os devolve (antes o cliente adivinhava pelo role).
    access: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
      const vis = await expenseVisibilityFor(ctx.user);
      return { scope: vis.kind, canSeeTotals: canSeeAggregates(vis) };
    }),

    list: protectedProcedure
      .input(EXPENSE_LIST_INPUT)
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
        const { vis, where } = await expenseWhereFor(ctx.user, input);
        if (vis.kind === "none") return [];
        return listExpenses(where);
      }),

    byId: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
        const row = await getExpenseById(input.id);
        if (!row) return row;
        const vis = await expenseVisibilityFor(ctx.user);
        if (!canSeeExpense(vis, { insertedById: row.expense.insertedById, projectId: row.expense.projectId ?? null })) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        return row;
      }),

    // URL de leitura do comprovativo (assinada no S3, 10 min). O cliente já
    // não abre a URL pública gravada: pede aqui, e a permissão é a do detalhe.
    documentUrl: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
        const row = await getExpenseById(input.id);
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        const vis = await expenseVisibilityFor(ctx.user);
        if (!canSeeExpense(vis, { insertedById: row.expense.insertedById, projectId: row.expense.projectId ?? null })) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        const key = row.expense.invoiceImageKey;
        const url = row.expense.invoiceImageUrl;
        if (!key && !url) return { url: null as string | null, isPdf: false, signed: false, expiresIn: 0 };
        const { storagePresignGet } = await import("./storage");
        // A key é preferida (assinável no S3), mas as despesas anteriores ao S3
        // guardam a key crua da era Blob — que no S3 não existe. A URL vai como
        // fallback para esses ficheiros continuarem a abrir.
        const r = await storagePresignGet((key || url) as string, { fallbackUrl: url });
        const isPdf = /\.pdf(\?|$)/i.test(key || url || "");
        return { url: r.url || null, isPdf, signed: r.signed, expiresIn: r.expiresIn };
      }),

    // Histórico de alterações (quem, quando, antes/depois).
    events: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
        const row = await getExpenseById(input.id);
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        const vis = await expenseVisibilityFor(ctx.user);
        if (!canSeeExpense(vis, { insertedById: row.expense.insertedById, projectId: row.expense.projectId ?? null })) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        const evs = await getExpenseEvents(input.id);
        const parse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s); } catch { return s; } };
        return evs.map((e) => ({
          id: e.event.id, type: e.event.type, at: e.event.createdAt, note: e.event.note,
          user: e.user?.id ? { id: e.user.id, name: e.user.name } : null,
          before: parse(e.event.before), after: parse(e.event.after),
        }));
      }),

    // Possível duplicado ANTES de gravar: mesmo nº de documento do mesmo
    // fornecedor, ou o mesmo ficheiro. Não bloqueia — avisa.
    checkDuplicate: protectedProcedure
      .input(z.object({
        excludeId: z.number().optional(),
        supplier: z.string().optional(), supplierNif: z.string().optional(),
        documentNumber: z.string().optional(), invoiceImageKey: z.string().optional(),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "edit", { allowOwn: true });
        const dup = await findPossibleDuplicateExpense(input);
        if (!dup) return null;
        const vis = await expenseVisibilityFor(ctx.user);
        // Quem não pode ver a despesa só fica a saber que já existe
        if (!canSeeExpense(vis, { insertedById: (dup as any).insertedById, projectId: (dup as any).projectId ?? null })) {
          return { id: 0, supplier: null, amount: null, expenseDate: null, documentNumber: dup.documentNumber, status: null };
        }
        return { id: dup.id, supplier: dup.supplier, amount: dup.amount, expenseDate: dup.expenseDate, documentNumber: dup.documentNumber, status: dup.status };
      }),

    create: protectedProcedure
      .input(
        z.object({
          supplier: z.string().optional(),
          description: z.string().optional(),
          amount: z.string(),
          currency: z.string().default("EUR"),
          paymentMethod: z.enum(["cash", "card", "transfer", "check", "other"]).optional(),
          expenseDate: z.string(),
          paymentDueDate: z.string().nullable().optional(),
          categoryId: z.number().optional(),
          // projectId obrigatório: cada despesa tem de ir para um centro
          // de custos (grupo / cidade / marca / projeto). O rollup
          // hierárquico do ProjectCostsDashboard agrega para cima.
          projectId: z.number(),
          buyerId: z.number().optional(),
          invoiceImageUrl: z.string().optional(),
          invoiceImageKey: z.string().optional(),
          extractedByAi: z.boolean().default(false),
          notes: z.string().optional(),
          supplierNif: z.string().optional(),
          documentNumber: z.string().optional(),
          paidBy: z.enum(["company", "employee"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // Matriz do Jorge: input de despesas a partir de backoffice.
        requireAccess(ctx.user, "despesas", "edit", { allowOwn: true });
        assertOwnInvoiceKey(ctx.user.id, input.invoiceImageKey, input.invoiceImageUrl);
        const amountNorm = parseExpenseAmount(input.amount);
        if (!amountNorm) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Valor inválido — usa um número positivo com até 2 casas (ex.: 45,90)" });
        }
        const expenseDate = dayOrBadRequest(input.expenseDate, "Data da despesa");
        const due = cleanText(input.paymentDueDate);
        const paymentDueDate = due ? dayOrBadRequest(due, "Data de vencimento") : null;
        if (!(await projectExists(input.projectId))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Centro de custos inexistente" });
        }
        if (input.categoryId && !(await categoryExists(input.categoryId))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Categoria inexistente" });
        }
        // Quem suportou: se há comprador (colaborador) e não foi dito, assume-se
        // que foi ele (dá origem a reembolso na fase de pagamentos).
        const paidBy = input.paidBy ?? (input.buyerId ? "employee" : "company");
        const created = await createExpense({
          supplier: cleanText(input.supplier) ?? null,
          description: cleanText(input.description) ?? null,
          amount: amountNorm,
          // Os totais somam tudo como EUR: não se aceita outra moeda
          currency: "EUR",
          paymentMethod: input.paymentMethod ?? null,
          expenseDate,
          paymentDueDate,
          categoryId: input.categoryId ?? null,
          projectId: input.projectId,
          buyerId: input.buyerId ?? null,
          insertedById: ctx.user.id,
          invoiceImageUrl: input.invoiceImageUrl ?? null,
          invoiceImageKey: input.invoiceImageKey ?? null,
          extractedByAi: input.extractedByAi ? 1 : 0,
          notes: cleanText(input.notes) ?? null,
          supplierNif: cleanText(input.supplierNif) ?? null,
          documentNumber: cleanText(input.documentNumber) ?? null,
          paidBy,
          status: "pending",
          approvalStatus: "legacy",
        });
        const newId = Number((created as any)?.[0]?.insertId ?? 0) || null;
        if (newId) {
          await recordExpenseEvent({
            expenseId: newId, type: "created", userId: ctx.user.id,
            after: { amount: amountNorm, expenseDate: input.expenseDate, projectId: input.projectId, categoryId: input.categoryId ?? null, supplier: cleanText(input.supplier) ?? null, documentNumber: cleanText(input.documentNumber) ?? null, extractedByAi: input.extractedByAi },
          });
        }

        await logActivity({
          userId: ctx.user.id,
          action: "create",
          entity: "expense",
          entityId: newId ?? undefined,
          details: `Despesa criada: ${input.supplier ?? "Sem fornecedor"} - ${amountNorm}€`,
        });

        // Notifica UMA vez (o notifyOwner envia sempre p/ OWNER_EMAIL — o
        // loop antigo mandava N emails idênticos).
        if (input.paymentDueDate && input.paymentDueDate !== 'null') {
          await notifyOwner({
            title: "Nova despesa com data de pagamento",
            content: `Despesa de ${input.amount}€ (${input.supplier ?? "Sem fornecedor"}) com vencimento em ${new Date(input.paymentDueDate).toLocaleDateString("pt-PT")}.`,
          });
        }

        return { success: true, id: newId };
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          // Campos opcionais aceitam null = "limpar" (antes não dava para
          // apagar um vencimento ou uma categoria ao editar).
          supplier: z.string().nullable().optional(),
          description: z.string().nullable().optional(),
          amount: z.string().optional(),
          paymentMethod: z.enum(["cash", "card", "transfer", "check", "other"]).optional(),
          expenseDate: z.string().optional(),
          paymentDueDate: z.string().nullable().optional(),
          categoryId: z.number().nullable().optional(),
          projectId: z.number().optional(),
          buyerId: z.number().nullable().optional(),
          status: z.enum(["pending", "paid", "overdue", "cancelled"]).optional(),
          paidAt: z.string().nullable().optional(),        // AAAA-MM-DD
          notes: z.string().nullable().optional(),
          invoiceImageUrl: z.string().nullable().optional(),
          invoiceImageKey: z.string().nullable().optional(),
          supplierNif: z.string().nullable().optional(),
          documentNumber: z.string().nullable().optional(),
          paidBy: z.enum(["company", "employee"]).nullable().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // Matriz do Jorge: editar despesas (valores, datas, estados) é
        // admin+; DESMARCAR um pagamento (paid → outro estado) é só
        // super_admin.
        requireAccess(ctx.user, "despesas", "manage");
        const current = await getExpenseById(input.id);
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Despesa não encontrada" });
        const cur = current.expense;
        const { id } = input;

        if (input.status && input.status !== "paid" && cur.status === "paid" && ctx.user.role !== "super_admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin pode retirar um pagamento já registado" });
        }

        const patch: Record<string, any> = {};
        for (const k of ["supplier", "description", "notes", "supplierNif", "documentNumber"] as const) {
          const v = cleanText(input[k]);
          if (v !== undefined) patch[k] = v;
        }
        if (input.paymentMethod !== undefined) patch.paymentMethod = input.paymentMethod;
        if (input.buyerId !== undefined) patch.buyerId = input.buyerId;
        if (input.paidBy !== undefined) patch.paidBy = input.paidBy;
        if (input.categoryId !== undefined) {
          if (input.categoryId != null && !(await categoryExists(input.categoryId))) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Categoria inexistente" });
          }
          patch.categoryId = input.categoryId;
        }
        if (input.projectId !== undefined) {
          if (!(await projectExists(input.projectId))) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Centro de custos inexistente" });
          }
          patch.projectId = input.projectId;
        }
        if (input.expenseDate !== undefined) patch.expenseDate = dayOrBadRequest(input.expenseDate, "Data da despesa");
        if (input.paymentDueDate !== undefined) {
          const due = cleanText(input.paymentDueDate);
          patch.paymentDueDate = due ? dayOrBadRequest(due, "Data de vencimento") : null;
        }
        if (input.amount !== undefined) {
          const a = parseExpenseAmount(input.amount);
          if (!a) throw new TRPCError({ code: "BAD_REQUEST", message: "Valor inválido — usa um número positivo com até 2 casas (ex.: 45,90)" });
          patch.amount = a;
        }

        // Data de pagamento: PRESERVADA. Só se define quando a despesa PASSA a
        // paga (ou quando é indicada explicitamente); editar a descrição de
        // uma despesa já paga não mexe em paidAt (bug anterior: "agora" sempre).
        const explicitPaidAt = input.paidAt === undefined ? undefined : (cleanText(input.paidAt) ? dayOrBadRequest(cleanText(input.paidAt)!, "Data de pagamento") : null);
        if (input.status !== undefined) {
          patch.status = input.status;
          if (input.status === "paid") {
            if (cur.status !== "paid") patch.paidAt = explicitPaidAt ?? dayToMysql(lisbonToday());
            else if (explicitPaidAt) patch.paidAt = explicitPaidAt;
          } else {
            patch.paidAt = null;
          }
        } else if (explicitPaidAt && cur.status === "paid") {
          patch.paidAt = explicitPaidAt;
        }
        // Em atraso com o vencimento adiado para hoje ou depois → volta a pendente
        if (input.status === undefined && cur.status === "overdue" && typeof patch.paymentDueDate === "string" && patch.paymentDueDate >= dayToMysql(lisbonToday())) {
          patch.status = "pending";
        }

        // Documento: grava primeiro, apaga o antigo DEPOIS (se o UPDATE falhar
        // o original continua acessível).
        let oldDocToDelete: string | null = null;
        if (input.invoiceImageKey !== undefined || input.invoiceImageUrl !== undefined) {
          const sameDoc = (input.invoiceImageKey ?? null) === (cur.invoiceImageKey ?? null) && (input.invoiceImageUrl ?? null) === (cur.invoiceImageUrl ?? null);
          if (!sameDoc) assertOwnInvoiceKey(ctx.user.id, input.invoiceImageKey, input.invoiceImageUrl);
          const newKey = input.invoiceImageKey ?? null;
          const newUrl = input.invoiceImageUrl ?? null;
          patch.invoiceImageKey = newKey;
          patch.invoiceImageUrl = newUrl;
          const oldRef = cur.invoiceImageKey || cur.invoiceImageUrl || null;
          const newRef = newKey || newUrl || null;
          if (oldRef && oldRef !== newRef) oldDocToDelete = oldRef;
        }

        // Alteração financeira depois de aprovada → volta a "submetida"
        // (regra do circuito; hoje tudo é 'legacy' e isto não dispara).
        const changed: Record<string, { before: unknown; after: unknown }> = {};
        for (const [k, v] of Object.entries(patch)) {
          const before = (cur as any)[k] ?? null;
          const after = v ?? null;
          if (String(before) !== String(after)) changed[k] = { before, after };
        }
        const financialChange = EXPENSE_FINANCIAL_FIELDS.some((f) => f in changed);
        if (financialChange && cur.approvalStatus === "approved") {
          patch.approvalStatus = "submitted";
          patch.approvedAt = null;
          patch.approvedById = null;
        }

        if (Object.keys(changed).length === 0) return { success: true, changed: 0 };

        await updateExpense(id, patch);

        if (oldDocToDelete) {
          try {
            const { storageDelete } = await import("./storage");
            await storageDelete(oldDocToDelete);
          } catch { /* best-effort: órfão no storage é preferível a link morto */ }
        }

        const type = "status" in changed ? (patch.status === "paid" ? "paid" : "status") : oldDocToDelete || "invoiceImageKey" in changed ? "document" : "updated";
        await recordExpenseEvent({
          expenseId: id, type, userId: ctx.user.id,
          before: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.before])),
          after: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.after])),
          note: financialChange && cur.approvalStatus === "approved" ? "Alteração financeira: aprovação anulada" : null,
        });
        await logActivity({
          userId: ctx.user.id,
          action: "update",
          entity: "expense",
          entityId: id,
          details: `Despesa #${id} atualizada (${Object.keys(changed).join(", ")})`,
        });
        return { success: true, changed: Object.keys(changed).length };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // Matriz do Jorge: apagar faturas é SÓ super_admin.
        requireRole(ctx.user.role, "super_admin");
        // Apaga a linha PRIMEIRO e só depois a fatura do storage (se o DELETE
        // falhar, a despesa não fica com um link morto).
        const current = await getExpenseById(input.id);
        if (current) {
          try {
            await recordExpenseEvent({
              expenseId: input.id, type: "deleted", userId: ctx.user.id,
              before: { amount: current.expense.amount, supplier: current.expense.supplier, expenseDate: current.expense.expenseDate, status: current.expense.status },
            });
          } catch { /* best-effort */ }
        }
        await deleteExpense(input.id);
        const k = current?.expense?.invoiceImageKey || current?.expense?.invoiceImageUrl;
        if (k) {
          try {
            const { storageDelete } = await import("./storage");
            await storageDelete(k);
          } catch { /* best-effort: órfão no storage é preferível a link morto */ }
        }
        await logActivity({
          userId: ctx.user.id,
          action: "delete",
          entity: "expense",
          entityId: input.id,
          details: `Despesa #${input.id} eliminada`,
        });
        return { success: true };
      }),

    // ── UPLOAD INVOICE ───────────────────────────────────────────────────────
    uploadInvoice: protectedProcedure
      .input(
        z.object({
          fileName: z.string(),
          fileBase64: z.string(),
          mimeType: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "edit", { allowOwn: true });
        const buffer = Buffer.from(input.fileBase64, "base64");
        const suffix = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        const safeName = input.fileName.replace(/[^\w.\-]+/g, "_").slice(0, 120);
        const key = `invoices/${ctx.user.id}/${suffix}-${safeName}`;
        const { url } = await storagePut(key, buffer, input.mimeType);
        return { url, key };
      }),

    // ── EXTRACT WITH LLM ─────────────────────────────────────────────────────
    extractFromImage: protectedProcedure
      .input(z.object({ imageBase64: z.string(), mimeType: z.string().default("image/jpeg") }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "edit", { allowOwn: true });
        // Lista de categorias para a IA sugerir uma (mapeada por nome no cliente).
        let categoryNames: string[] = [];
        try {
          const cats = await getAllCategories();
          categoryNames = (cats as any[]).map((c) => c.name).filter(Boolean);
        } catch { /* opcional */ }

        const { extractInvoice } = await import("./expenseOcr");
        const { aiTrpcError } = await import("./_core/ai/trpcError");
        try {
          return await extractInvoice({ base64: input.imageBase64, mimeType: input.mimeType, categoryNames, userId: ctx.user.id });
        } catch (err) {
          throw aiTrpcError(err);
        }
      }),

    // ── DASHBOARD STATS ──────────────────────────────────────────────────────
    stats: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx }) => {
      // Totais da empresa inteira — só admin+ (matriz do Jorge), e respeita o
      // deny de finance.view_totals por utilizador.
      await requireFinanceTotals(ctx.user, "financeiro", "view");
      return getExpenseStats();
    }),

    // ── UPCOMING PAYMENTS ────────────────────────────────────────────────────
    upcomingPayments: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx }) => {
      // Pagamentos de TODOS: respeita a restrição finance.view_totals
      await requireFinanceTotals(ctx.user, "financeiro", "view");
      return getUpcomingPayments(7);
    }),

    // ── EXPORT EXCEL ─────────────────────────────────────────────────────────
    exportExcel: protectedProcedure
      .input(EXPENSE_LIST_INPUT)
      .mutation(async ({ ctx, input }) => {
        // MESMOS filtros e MESMA visibilidade da lista (antes: sem requireRole,
        // fim do intervalo às 00:00 — perdia o último dia — e supervisor
        // exportava a empresa toda).
        requireAccess(ctx.user, "despesas", "export");
        const { vis, where } = await expenseWhereFor(ctx.user, input);
        if (!canSeeAggregates(vis)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para exportar totais financeiros." });
        }
        const rows = await listExpenses(where);
        const totals = expenseTotals(rows.map((r) => ({ amount: r.expense.amount, status: r.expense.status })));

        const STATUS_MAP: Record<string, string> = {
          pending: "Pendente",
          paid: "Pago",
          overdue: "Em Atraso",
          cancelled: "Cancelado",
        };
        const METHOD_MAP: Record<string, string> = {
          cash: "Numerário",
          card: "Cartão",
          transfer: "Transferência",
          check: "Cheque",
          other: "Outro",
        };

        const day = (s: string | null | undefined) => (s ? String(s).slice(0, 10).split("-").reverse().join("/") : "");
        const data = rows.map((r) => ({
          "ID": r.expense.id,
          "Data": day(r.expense.expenseDate),
          "Fornecedor": r.expense.supplier ?? "",
          "NIF": r.expense.supplierNif ?? "",
          "Nº Documento": r.expense.documentNumber ?? "",
          "Descrição": r.expense.description ?? "",
          "Valor (€)": parseFloat(String(r.expense.amount ?? 0)),
          "Moeda": r.expense.currency ?? "EUR",
          "Método Pagamento": METHOD_MAP[r.expense.paymentMethod ?? ""] ?? r.expense.paymentMethod ?? "",
          "Pago por": r.expense.paidBy === "employee" ? "Colaborador" : r.expense.paidBy === "company" ? "Empresa" : "",
          "Estado": STATUS_MAP[r.expense.status ?? ""] ?? r.expense.status ?? "",
          "Categoria": r.category?.name ?? "",
          "Departamento": r.category?.department ?? "",
          "Centro de custos": r.project?.name ?? "",
          "Comprador": r.buyer?.fullName ?? "",
          "Registado por": r.insertedBy?.name ?? "",
          "Data Vencimento": day(r.expense.paymentDueDate),
          "Data Pagamento": day(r.expense.paidAt),
          "Comprovativo": r.expense.invoiceImageKey || r.expense.invoiceImageUrl ? "Sim" : "Não",
          "Extraído por IA": r.expense.extractedByAi ? "Sim" : "Não",
          "Notas": r.expense.notes ?? "",
        }));

        const ws = XLSX.utils.json_to_sheet(data);

        // Auto-width columns
        const colWidths = Object.keys(data[0] ?? {}).map((key) => ({
          wch: Math.max(key.length, ...data.map((r) => String((r as any)[key] ?? "").length)) + 2,
        }));
        ws["!cols"] = colWidths;

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Despesas");

        // Resumo: mesma regra dos KPIs (canceladas fora do total, listadas à parte)
        const summaryData = [
          { "Resumo": "Total de Registos (sem canceladas)", "Valor": totals.count },
          { "Resumo": "Total (€) sem canceladas", "Valor": totals.total },
          { "Resumo": "Pendente (€)", "Valor": totals.pending },
          { "Resumo": "Pago (€)", "Valor": totals.paid },
          { "Resumo": "Em atraso (€)", "Valor": totals.overdue },
          { "Resumo": "Canceladas", "Valor": `${totals.cancelledCount} (${totals.cancelled.toFixed(2)} €)` },
          { "Resumo": "Período", "Valor": `${input?.startDate ?? "início"} a ${input?.endDate ?? "hoje"}` },
          { "Resumo": "Exportado em", "Valor": new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" }) },
          { "Resumo": "Exportado por", "Valor": ctx.user.name ?? ctx.user.email ?? "" },
        ];
        const wsSummary = XLSX.utils.json_to_sheet(summaryData);
        wsSummary["!cols"] = [{ wch: 20 }, { wch: 30 }];
        XLSX.utils.book_append_sheet(wb, wsSummary, "Resumo");

        const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
        const base64 = Buffer.from(buffer).toString("base64");

        return { base64, filename: `despesas-${new Date().toISOString().slice(0, 10)}.xlsx`, count: data.length };
      }),

    // ── CHECK OVERDUE ────────────────────────────────────────────────────────
    checkOverdue: protectedProcedure.mutation(async ({ ctx }) => {
      requireRole(ctx.user.role, "super_admin");
      // A lista tem de ser lida ANTES do mark (getOverdueExpenses procura
      // status='pending' — depois do mark já estão 'overdue' e devolvia
      // sempre 0, pelo que o alerta nunca era enviado).
      const overdue = await getOverdueExpenses();
      await markOverdueExpenses();

      if (overdue.length > 0) {
        await notifyOwner({
          title: `⚠️ ${overdue.length} despesa(s) em atraso`,
          content: overdue
            .map(
              (o) =>
                `• ${o.expense.supplier ?? "Sem fornecedor"}: ${o.expense.amount}€ (venceu em ${o.expense.paymentDueDate ? new Date(o.expense.paymentDueDate).toLocaleDateString("pt-PT") : "—"})`
            )
            .join("\n"),
        });
      }

      return { updated: overdue.length };
    }),

    // Resumo de despesas de um período (comparar períodos). Mesmos filtros e
    // visibilidade da lista (antes: qualquer frontoffice via os totais da
    // empresa e o centro de custos não incluía descendentes).
    summary: protectedProcedure
      .input(z.object({ from: z.string(), to: z.string(), projectId: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
        const { vis, where } = await expenseWhereFor(ctx.user, { startDate: input.from, endDate: input.to, projectId: input.projectId });
        if (!canSeeAggregates(vis)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para ver totais financeiros." });
        }
        return summarizeExpenses(where);
      }),

    // ── Despesas recorrentes (modelos) ──
    recurring: router({
      list: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx }) => {
        // Fornecedores e valores fixos: só quem gere as despesas
        requireAccess(ctx.user, "despesas", "manage");
        const { getDb } = await import("./db");
        const { recurringExpenses } = await import("../drizzle/schema");
        const { desc } = await import("drizzle-orm");
        const db = await getDb(); if (!db) return [];
        return db.select().from(recurringExpenses).where(projectScope(recurringExpenses.projectId)).orderBy(desc(recurringExpenses.active));
      }),
      create: protectedProcedure
        .input(z.object({ description: z.string().optional(), supplier: z.string().optional(), amount: z.number(), paymentMethod: z.enum(["cash", "card", "transfer", "check", "other"]).optional(), categoryId: z.number().optional(), projectId: z.number(), dayOfMonth: z.number().min(1).max(28).optional(), notes: z.string().optional() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "despesas", "manage");
          // Mesmas regras de uma despesa normal: valor positivo com 2 casas e centro de custos existente
          const amountNorm = parseExpenseAmount(String(input.amount));
          if (!amountNorm) throw new TRPCError({ code: "BAD_REQUEST", message: "Valor inválido — usa um número positivo com até 2 casas" });
          if (!(await projectExists(input.projectId))) throw new TRPCError({ code: "BAD_REQUEST", message: "Centro de custos inexistente" });
          const { getDb } = await import("./db");
          const { recurringExpenses } = await import("../drizzle/schema");
          const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
          await db.insert(recurringExpenses).values({ description: input.description ?? null, supplier: input.supplier ?? null, amount: amountNorm, paymentMethod: input.paymentMethod ?? "transfer", categoryId: input.categoryId ?? null, projectId: input.projectId, dayOfMonth: input.dayOfMonth ?? 1, notes: input.notes ?? null, createdById: ctx.user.id } as any);
          return { success: true };
        }),
      update: protectedProcedure
        .input(z.object({ id: z.number(), description: z.string().optional(), supplier: z.string().optional(), amount: z.number().optional(), paymentMethod: z.enum(["cash", "card", "transfer", "check", "other"]).optional(), categoryId: z.number().nullable().optional(), projectId: z.number().optional(), dayOfMonth: z.number().min(1).max(28).optional(), active: z.boolean().optional(), notes: z.string().optional() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "despesas", "manage");
          const { getDb } = await import("./db");
          const { recurringExpenses } = await import("../drizzle/schema");
          const { eq } = await import("drizzle-orm");
          const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
          const { id, amount, active, ...rest } = input;
          const patch: any = { ...rest };
          if (amount !== undefined) {
            const a = parseExpenseAmount(String(amount));
            if (!a) throw new TRPCError({ code: "BAD_REQUEST", message: "Valor inválido — usa um número positivo com até 2 casas" });
            patch.amount = a;
          }
          if (rest.projectId !== undefined && !(await projectExists(rest.projectId))) throw new TRPCError({ code: "BAD_REQUEST", message: "Centro de custos inexistente" });
          if (active !== undefined) patch.active = active ? 1 : 0;
          await db.update(recurringExpenses).set(patch).where(eq(recurringExpenses.id, id));
          return { success: true };
        }),
      remove: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "manage");
        const { getDb } = await import("./db");
        const { recurringExpenses } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
        await db.delete(recurringExpenses).where(eq(recurringExpenses.id, input.id));
        return { success: true };
      }),
      // Lança as despesas dos modelos ativos para o mês. Idempotente e seguro
      // em concorrência (lock + UNIQUE modelo/mês — server/expenseRecurring.ts).
      // Corre no cron diário; aqui é só o disparo manual pelo admin.
      generateMonth: protectedProcedure
        .input(z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), projectId: z.number().optional() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "despesas", "manage");
          const { generateRecurringExpensesForMonth } = await import("./expenseRecurring");
          const r = await generateRecurringExpensesForMonth(input.year, input.month, ctx.user.id);
          return { created: r.created, skipped: r.skipped, period: r.period };
        }),
    }),
  }),

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

  rh: router({
    accountSummary: protectedProcedure
      .input(z.object({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        const viewer = await rhViewer(ctx.user);
        const person = await getEmployeeById(input.employeeId);
        if (!person) throw new TRPCError({ code: 'NOT_FOUND' });
        await assertEmployeeAccess(input.employeeId);
        if (!canViewEmployee(viewer, person.employee)) throw new TRPCError({ code: 'FORBIDDEN' });
        if (!person.employee.userId) return null;
        const account = await getUserById(person.employee.userId);
        if (!account) return null;
        const { getUserPermissionOverrides } = await import('./db');
        const { loadCityAccess } = await import('./cityAccess');
        const { userAccessSummary } = await import('../shared/userAccessSummary');
        const [overrides, cities] = await Promise.all([getUserPermissionOverrides(account.id), loadCityAccess(account.id)]);
        const allowedIds = scopedProjectIds();
        const canManage = ['admin', 'super_admin'].includes(ctx.user.role)
          && (!allowedIds || (!cities.all && !cities.missingCostCenter && cities.projectIds.every(id => allowedIds.includes(id))));
        return { id: account.id, name: account.name, email: account.email, isActive: account.isActive,
          ...userAccessSummary(account.role, overrides, cities), cities, canManage };
      }),
    // ── MY PROFILE (for extra/low-role users) ──────────────────────────────────────────────────
    me: protectedProcedure.query(async ({ ctx }) => {
      return getEmployeeByUserId(ctx.user.id);
    }),

    // ── RECRUTAMENTO (emails recebidos em recursos-humanos@) ───────────────────
    recruitmentEmails: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "leads_extras", "view");
      const { listInboundEmailsByAlias } = await import("./db");
      return listInboundEmailsByAlias("recursos-humanos", 200);
    }),

    // Notas internas do backoffice sobre um email/candidato de recrutamento.
    setRecruitmentNotes: protectedProcedure
      .input(z.object({ id: z.number(), notes: z.string().max(10000) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        const { getDb } = await import("./db");
        const { eq } = await import("drizzle-orm");
        const database = await getDb();
        if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        const { inboundEmails } = await import("../drizzle/schema");
        await database.update(inboundEmails).set({ notes: input.notes.trim() || null }).where(eq(inboundEmails.id, input.id));
        return { ok: true };
      }),

    replyRecruitment: protectedProcedure
      .input(z.object({
        to: z.string().email(),
        subject: z.string().min(1),
        body: z.string().min(1),
        fromAlias: z.enum(["criticas", "reclamacoes", "perdidos", "recursos-humanos"]).optional(),
        // Inclui link de registo: cria conta para o candidato e gera /convite/:token.
        includeRegisterLink: z.boolean().optional(),
        candidateName: z.string().optional(),
        origin: z.string().url().optional(),
        // Ficheiros já enviados para /api/upload (Vercel Blob público) —
        // o servidor descarrega-os e envia como anexos do email.
        attachments: z.array(z.object({
          filename: z.string().min(1).max(255),
          url: z.string().url().startsWith("https://"),
        })).max(5).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        const { sendEmail } = await import("./_core/notification");

        const emailAttachments: Array<{ filename: string; content: Buffer }> = [];
        for (const a of input.attachments ?? []) {
          const resp = await fetch(a.url);
          if (!resp.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `Anexo "${a.filename}" inacessível (HTTP ${resp.status})` });
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length > 10 * 1024 * 1024) throw new TRPCError({ code: "BAD_REQUEST", message: `Anexo "${a.filename}" excede 10 MB` });
          emailAttachments.push({ filename: a.filename, content: buf });
        }
        const from = input.fromAlias ? `${input.fromAlias}@multipark.pt` : undefined;
        const fromName = input.fromAlias === "recursos-humanos" ? "Multipark Recrutamento" : "Multipark";

        let body = input.body;
        let inviteLink: string | null = null;
        if (input.includeRegisterLink) {
          if (!input.origin) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Falta o origin para gerar o link de registo." });
          }
          // Cria (ou reutiliza) a conta do candidato e gera o token de convite.
          let user = await getUserByEmail(input.to);
          if (!user) {
            user = await createManualUser({ name: input.candidateName || input.to, email: input.to, role: "extra" });
          }
          if (!user) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a conta do candidato." });
          const invite = await createInviteToken({ email: input.to, userId: user.id, invitedById: ctx.user.id });
          inviteLink = `${input.origin.replace(/\/+$/, "")}/convite/${invite.token}`;
          body = `${input.body}\n\n— — —\nPara te registares na plataforma Multipark, abre este link e entra com a tua conta Google:\n${inviteLink}`;
        }

        const ok = await sendEmail({
          to: input.to, subject: input.subject, text: body, from, fromName,
          ...(emailAttachments.length ? { attachments: emailAttachments } : {}),
        });
        await logActivity({
          userId: ctx.user.id,
          action: "email_reply",
          entity: "recruitment",
          details: `Resposta a ${input.to}: ${input.subject.slice(0, 80)}${inviteLink ? " (+link registo)" : ""}${emailAttachments.length ? ` (+${emailAttachments.length} anexo${emailAttachments.length > 1 ? "s" : ""})` : ""}`,
        });
        if (!ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "SMTP não configurado ou falhou o envio" });
        return { ok, inviteLink };
      }),

    // Resumo do mês actual para o próprio colaborador: horas + valor a receber.
    // Admin pode ver de outros passando employeeId; o próprio só vê o seu.
    myMonthSummary: protectedProcedure
      .input(z.object({ employeeId: z.number().optional(), year: z.number().optional(), month: z.number().optional() }).optional())
      .query(async ({ ctx, input }) => {
        let employeeId = input?.employeeId;
        if (!employeeId) {
          const me = await getEmployeeByUserId(ctx.user.id);
          if (!me) throw new TRPCError({ code: "NOT_FOUND", message: "Sem ficha de colaborador" });
          employeeId = me.employee.id;
        }
        // Restringe: salários de outros são só para admin+ DA MESMA cidade;
        // abaixo disso cada um só vê o seu próprio resumo
        await assertOwnOrScopedEmployee(ctx.user, employeeId, "admin");
        const now = new Date();
        const year = input?.year ?? now.getFullYear();
        const month = input?.month ?? (now.getMonth() + 1);
        const payroll = await getPayrollData(year, month);
        const row = payroll.find((r: any) => r.employeeId === employeeId);
        if (!row) return null;
        return {
          year,
          month,
          fullName: row.fullName,
          isExtra: row.isExtra,
          totalHours: row.totalHours,
          daysWorked: row.daysWorked,
          hourlyRate: row.hourlyRate,
          baseSalary: row.baseSalary,
          extraPayment: row.extraPayment,
          overtimePayment: row.overtimePayment,
          nightPayment: row.nightPayment,
          weekendPayment: row.weekendPayment,
          mealAllowance: row.mealAllowance,
          totalPayment: row.totalPayment,
          tsuEmployee: row.tsuEmployee,
          irsEstimate: row.irsEstimate,
          netEstimate: row.netEstimate,
        };
      }),

    // ── ROSTER MÍNIMO ──────────────────────────────────────────────────────────────────────────
    // Lista pública (id + fullName) para selectors em qualquer página
    // (atribuir responsáveis, condutores envolvidos, etc.). Sem requireRole
    // para que frontoffice/team_leader/extra possam usar dropdowns também.
    roster: protectedProcedure
      .input(z.object({ activeOnly: z.boolean().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "extra"); // lista mínima (id+nome) p/ dropdowns; user não acede
        let rows = await getAllEmployees({ isActive: input?.activeOnly ?? true });
        // Âmbito de cidade (inclui extras): só colaboradores das cidades
        // autorizadas — e nunca mais do que id + nome.
        const allowedIds = scopedProjectIds();
        if (allowedIds) rows = rows.filter((r: any) => r.employee.projectId != null && allowedIds.includes(r.employee.projectId));
        return rows.map((row: any) => ({
          id: row.employee.id,
          fullName: row.employee.fullName,
        }));
      }),

    // ── STATS ──────────────────────────────────────────────────────────────────────────────────
    stats: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "view");
      await seedExtraRates();
      return getHRStats();
    }),

    // Última vez que cada colaborador trabalhou (cartões dos extras:
    // disponibilidade, extras-dia, avaliações)
    lastWorkedMap: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "view");
      const { getLastWorkedMap } = await import("./db");
      return getLastWorkedMap();
    }),

    // ── EMPLOYEES ─────────────────────────────────────────────────────────────────────────────────
    // Permissões por FINALIDADE (server/rhAccess.ts): frontoffice/team_leader
    // veem a lista operacional sem NIF/NIB/morada/nascimento/salário de
    // terceiros; supervisor só o seu centro; extra só a própria ficha.
    list: protectedProcedure
      .input(z.object({ isActive: z.boolean().optional(), position: z.string().optional(), projectId: z.number().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "view");
        const viewer = await rhViewer(ctx.user);
        let rows = await getAllEmployees({ isActive: input?.isActive, position: input?.position });
        const allowedIds = scopedProjectIds();
        if (allowedIds) rows = rows.filter(r => r.employee.projectId != null && allowedIds.includes(r.employee.projectId));
        // filtro global de cidade/centro (com descendentes)
        if (input?.projectId) {
          const ids = new Set(await resolveProjectIds(input.projectId));
          rows = rows.filter((r: any) => r.employee.projectId != null && ids.has(r.employee.projectId));
        }
        // role da conta de cada ficha: fichas de admin/super_admin ficam
        // protegidas de quem está abaixo (dados pessoais escondidos).
        const roleByUserId = new Map<number, string>();
        if (!isRhAdmin(viewer)) for (const u of await getAllUsers()) roleByUserId.set(u.id, u.role);
        return sanitizeEmployeeRows(viewer, rows as any[], (emp) => (emp.userId != null ? roleByUserId.get(emp.userId) : null));
      }),

    byId: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        const viewer = await rhViewer(ctx.user);
        const result = await getEmployeeById(input.id);
        if (!result) return result;
        const ref: EmployeeRef = { id: result.employee.id, projectId: result.employee.projectId ?? null, role: await employeeAccountRole(result.employee.userId ?? null) };
        if (!isOwn(viewer, ref.id)) await assertEmployeeAccess(input.id);
        if (!canViewEmployee(viewer, ref)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
        }
        // `access` diz ao cliente o que este utilizador pode fazer na ficha
        return { ...result, employee: sanitizeEmployee(viewer, result.employee as any, ref.role), access: employeeAccess(viewer, ref) };
      }),

    create: protectedProcedure
      .input(z.object({
        fullName: z.string().min(1),
        email: z.string().email(),
        // Opcional: a ligação automática (identity sweep) encontra o agente sozinha
        multiparkAgentName: z.string().trim().max(256).optional(),
        phone: z.string().optional(),
        // Contactos pessoais — só internos (extras usam o pessoal como principal)
        personalEmail: z.string().email().optional(),
        personalPhone: z.string().optional(),
        nif: z.string().optional(),
        nib: z.string().optional(),
        address: z.string().optional(),
        birthDate: z.string().optional(),
        nationality: z.string().optional(),
        position: z.enum(["director","supervisor","team_leader","backoffice","frontoffice","senior_driver","driver","extra"]),
        extraLevel: z.number().min(1).max(5).optional(),
        department: z.string().optional(),
        projectId: z.number().optional(),
        contractType: z.enum(["permanent","fixed_term","extra"]).optional(),
        contractStart: z.string().optional(),
        contractEnd: z.string().optional(),
        monthlySalary: z.string().optional(),
        mealAllowancePerDay: z.string().optional(),
        userId: z.number().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");

        // ── ANTI-DUPLICAÇÃO (regra do Jorge): mesmo nome/email/NIF ativo = 1 só ficha
        const { getDb: getDbDup } = await import("./db");
        const { employees } = await import("../drizzle/schema");
        const { eq, and } = await import("drizzle-orm");
        const dbDup = await getDbDup();
        if (dbDup) {
          const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
          const all = await dbDup.select({ id: employees.id, fullName: employees.fullName, email: employees.email, nif: employees.nif })
            .from(employees).where(eq(employees.isActive, 1));
          const dup = all.find((e) =>
            norm(e.fullName) === norm(input.fullName) ||
            (input.email && e.email && e.email.toLowerCase() === input.email.toLowerCase()) ||
            (input.nif && e.nif && e.nif.trim() === input.nif.trim()),
          );
          if (dup) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `Já existe um colaborador ativo com estes dados: ${dup.fullName} (#${dup.id}). Usa a ficha existente em vez de criar outra.` });
          }
        }

        // ── LIGAÇÃO ÚNICA: um utilizador/agente não pode pertencer a 2 fichas
        if (input.userId != null && dbDup) {
          const taken = await dbDup.select({ id: employees.id, fullName: employees.fullName })
            .from(employees).where(and(eq(employees.userId, input.userId), eq(employees.isActive, 1))).limit(1);
          if (taken[0]) throw new TRPCError({ code: "BAD_REQUEST", message: `Esse utilizador já está ligado a ${taken[0].fullName} (#${taken[0].id}).` });
        }
        if (dbDup && input.multiparkAgentName) {
          const agentTaken = await dbDup.select({ id: employees.id, fullName: employees.fullName })
            .from(employees).where(and(eq(employees.multiparkAgentName, input.multiparkAgentName), eq(employees.isActive, 1))).limit(1);
          if (agentTaken[0]) throw new TRPCError({ code: "BAD_REQUEST", message: `Esse agente Multipark já está ligado a ${agentTaken[0].fullName} (#${agentTaken[0].id}).` });
        }

        // ── Centro de custos: se não indicado, infere pela morada (Algarve→Faro…)
        let projectId = input.projectId ?? null;
        if (projectId == null) {
          const { inferCityProjectIdFromAddress } = await import("./db");
          projectId = await inferCityProjectIdFromAddress(input.address);
        }
        if (projectId == null) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Centro de custos obrigatório — escolhe um, ou preenche a morada para o sistema inferir a cidade." });
        }

        // Regra do Jorge (2026-09-10): quem tem email válido tem utilizador com
        // ESSE email. Se o userId não vier explícito, depois de criar a ficha
        // liga-se ao utilizador que já exista com o email, ou cria-se um
        // (`manual_...`, adotado no 1º login Google) — ver ensureUserForEmployee.
        let userId = input.userId ?? null;

        const inserted = await createEmployee({
          fullName: input.fullName,
          email: input.email,
          multiparkAgentName: input.multiparkAgentName || null,
          phone: input.phone ?? null,
          personalEmail: input.position === "extra" ? null : (input.personalEmail?.trim().toLowerCase() || null),
          personalPhone: input.position === "extra" ? null : (input.personalPhone?.trim() || null),
          nif: input.nif ?? null,
          nib: input.nib ?? null,
          address: input.address ?? null,
          birthDate: input.birthDate ? new Date(input.birthDate).toISOString().slice(0, 19).replace("T", " ") : null,
          nationality: input.nationality ?? null,
          position: input.position,
          extraLevel: input.extraLevel ?? null,
          department: input.department ?? null,
          projectId,
          contractType: input.contractType ?? "permanent",
          contractStart: input.contractStart ? new Date(input.contractStart).toISOString().slice(0, 19).replace("T", " ") : null,
          contractEnd: input.contractEnd ? new Date(input.contractEnd).toISOString().slice(0, 19).replace("T", " ") : null,
          monthlySalary: input.monthlySalary ?? null,
          mealAllowancePerDay: input.mealAllowancePerDay ?? null,
          userId,
          isActive: 1,
        });
        const employeeId = Number((inserted as any)?.[0]?.insertId ?? (inserted as any)?.insertId) || null;
        let userCreated = false;
        if (userId == null && employeeId && dbDup) {
          const { ensureUserForEmployee } = await import("./identity");
          const r = await ensureUserForEmployee(dbDup, {
            id: employeeId,
            fullName: input.fullName,
            email: input.email,
            position: input.position,
            userId: null,
          });
          userId = r.userId;
          userCreated = r.created;
        }
        await logActivity({
          userId: ctx.user.id,
          action: "create",
          entity: "employee",
          entityId: employeeId ?? undefined,
          details: `Colaborador criado: ${input.fullName}${userId ? ` (utilizador #${userId}${userCreated ? " criado" : " ligado"})` : ""}`,
        });
        return { success: true, userId, userCreated };
      }),

    importExtras: protectedProcedure
      .input(z.object({ csv: z.string().min(1), projectId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        assertProjectAccess(input.projectId);
        const report = await importExtrasFromCsv(input.csv, ctx.user.id, { projectId: input.projectId });
        await logActivity({
          userId: ctx.user.id,
          action: "import",
          entity: "employee",
          details: `Import extras CSV: ${report.created} criados, ${report.duplicates.length} duplicados saltados, ${report.errors.length} erros (de ${report.parsed} linhas)`,
        });
        return report;
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        fullName: z.string().min(1).optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        // Contactos pessoais (null limpa). Só internos — ver abaixo.
        personalEmail: z.string().email().nullable().optional(),
        personalPhone: z.string().nullable().optional(),
        nif: z.string().optional(),
        nib: z.string().optional(),
        address: z.string().optional(),
        birthDate: z.string().optional(),
        nationality: z.string().optional(),
        photoUrl: z.string().optional(),
        photoKey: z.string().optional(),
        position: z.enum(["director","supervisor","team_leader","backoffice","frontoffice","senior_driver","driver","extra"]).optional(),
        extraLevel: z.number().min(1).max(5).optional(),
        department: z.string().optional(),
        projectId: z.number().optional(),
        contractType: z.enum(["permanent","fixed_term","extra"]).optional(),
        contractStart: z.string().optional(),
        contractEnd: z.string().optional(),
        monthlySalary: z.string().optional(),
        mealAllowancePerDay: z.string().optional(),
        userId: z.number().nullable().optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        // Dois níveis (pedido Jorge 17 set): dados PESSOAIS (o próprio, ou
        // quem gere o centro — ver rhAccess) e CONTRATUAIS (só admin+). Um
        // pedido que traga campos dos dois exige as duas permissões.
        const viewer = await rhViewer(ctx.user);
        const ref = await rhEmployeeRefOrThrow(input.id);
        const sent = (keys: readonly string[]) => keys.some((k) => (input as any)[k] !== undefined);
        if (sent(CONTRACT_FIELDS) && !canEditContract(viewer, ref)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Só admin pode alterar dados contratuais (posto, centro, contrato, salário, conta)." });
        }
        if (sent(PERSONAL_FIELDS) && !canEditPersonal(viewer, ref)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para alterar os dados desta ficha." });
        }
        // Email pessoal liga a ficha a contas (identidade): só admin+ o muda.
        // Reenviar o mesmo valor (formulário completo) não conta como mudança.
        if (input.personalEmail !== undefined && !canEditIdentity(viewer, ref)) {
          const current = await getEmployeeById(input.id);
          const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
          if (norm(input.personalEmail) !== norm(current?.employee.personalEmail)) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Só um administrador pode alterar o email pessoal (é usado para ligar a ficha à conta)." });
          }
        }
        // Âmbito de cidade também nas ESCRITAS (revisão 16 set): sem isto um
        // admin do Porto editava salário/NIF de uma ficha de Lisboa.
        await assertEmployeeWriteScope(viewer, ref);
        const { id, birthDate, contractStart, contractEnd, ...rest } = input;
        const data: any = { ...rest };
        if (typeof data.personalEmail === "string") data.personalEmail = data.personalEmail.trim().toLowerCase() || null;
        if (typeof data.personalPhone === "string") data.personalPhone = data.personalPhone.trim() || null;
        // Extras não têm contactos pessoais à parte (o pessoal é o principal).
        if (input.position === "extra") { data.personalEmail = null; data.personalPhone = null; }
        if (birthDate) data.birthDate = new Date(birthDate);
        if (contractStart) data.contractStart = new Date(contractStart);
        if (contractEnd) data.contractEnd = new Date(contractEnd);
        // Fase 1: um utilizador só pode estar numa ficha ativa (o rh.create já
        // verificava; a edição não)
        if (input.userId != null) {
          const { getDb } = await import("./db");
          const { sql } = await import("drizzle-orm");
          const db = await getDb();
          if (db) {
            const [taken] = ((await db.execute(sql`SELECT id, fullName FROM employees WHERE userId = ${input.userId} AND isActive = 1 AND id <> ${id} LIMIT 1`)) as any)[0] ?? [];
            if (taken) throw new TRPCError({ code: "BAD_REQUEST", message: `Esse utilizador já está ligado à ficha ${taken.fullName} (#${taken.id}).` });
          }
        }
        await updateEmployee(id, data);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "employee", entityId: id, details: `Colaborador atualizado: ${id}` });
        // Fase 1: mudou o email → volta a tentar ligar ao utilizador com esse email
        if (input.email !== undefined || input.personalEmail !== undefined) {
          try {
            const { getDb } = await import("./db");
            const db = await getDb();
            const fresh = await getEmployeeById(id);
            if (db && fresh && !fresh.employee.userId) {
              const { ensureUserForEmployee } = await import("./identity");
              await ensureUserForEmployee(db as any, { id, fullName: fresh.employee.fullName, email: fresh.employee.email, position: String(fresh.employee.position ?? ""), userId: null });
            }
          } catch (err) { console.warn("[rh.update] religar utilizador:", err); }
        }
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "super_admin");
        await assertEmployeeAccess(input.id);
        await deleteEmployee(input.id);
        await logActivity({ userId: ctx.user.id, action: "delete", entity: "employee", entityId: input.id, details: `Colaborador desativado: ${input.id}` });
        return { success: true };
      }),

    // Ativa/desativa o colaborador E, em cascata, o utilizador associado
    // (login + notificações por email param imediatamente). Útil p/ extras.
    setActive: protectedProcedure
      .input(z.object({
        id: z.number(),
        isActive: z.boolean(),
        // Mesmo contrato de `users.toggleActive`: motivo + notas opcionais, só
        // lidos na desativação (ver shared/deactivationReasons.ts).
        reason: z.enum(DEACTIVATION_REASON_CODES).optional(),
        reasonOther: z.string().max(DEACTIVATION_REASON_OTHER_MAX).optional(),
        notes: z.string().max(DEACTIVATION_NOTES_MAX).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        // Âmbito de cidade: desativar cascateia para a conta e grava o motivo —
        // nunca sobre uma pessoa de outra cidade. E um admin nunca desativa
        // um super_admin (ficha protegida).
        await assertEmployeeAccess(input.id);
        const found = await getEmployeeById(input.id);
        if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
        if (!canEditContract(await rhViewer(ctx.user), await rhEmployeeRefOrThrow(input.id))) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para alterar o estado desta ficha." });
        }
        const deactivation = input.isActive ? null : resolveDeactivationOrThrow(input);
        const meta = deactivation ? { ...deactivation, byUserId: ctx.user.id } : null;
        await updateEmployee(input.id, {
          isActive: input.isActive ? 1 : 0,
          ...deactivationColumns(input.isActive, meta),
        });
        const userId = found.employee.userId;
        // O motivo segue para a conta: a ficha e o login contam a MESMA história.
        if (userId) await toggleUserActive(userId, input.isActive, meta);
        await logActivity({
          userId: ctx.user.id,
          action: input.isActive ? "activate" : "deactivate",
          entity: "employee",
          entityId: input.id,
          details: `${input.isActive ? "Ativado" : "Desativado"} colaborador ${found.employee.fullName}${userId ? " + utilizador" : ""}${deactivation ? ` — ${deactivation.summary}` : ""}`,
        });
        return { success: true, cascadedUser: !!userId, reasonLabel: deactivation?.label ?? null };
      }),

    uploadPhoto: protectedProcedure
      .input(z.object({ employeeId: z.number(), fileBase64: z.string(), mimeType: z.string() }))
      .mutation(async ({ ctx, input }) => {
        // A foto é dado pessoal: o próprio, ou quem gere o centro (rhAccess).
        const viewer = await rhViewer(ctx.user);
        const ref = await rhEmployeeRefOrThrow(input.employeeId);
        if (!canEditPersonal(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para alterar a foto desta ficha." });
        await assertEmployeeWriteScope(viewer, ref);
        const { storagePut } = await import("./storage");
        const buffer = Buffer.from(input.fileBase64, "base64");
        const ext = input.mimeType.split("/")[1] ?? "jpg";
        const key = `employees/${input.employeeId}/photo-${Date.now()}.${ext}`;
        const { url } = await storagePut(key, buffer, input.mimeType);
        await updateEmployee(input.employeeId, { photoUrl: url, photoKey: key });
        return { url, key };
      }),

    // O PRÓPRIO utilizador define/troca a sua foto de perfil (obrigatória p/ ponto).
    uploadMyPhoto: protectedProcedure
      .input(z.object({ fileBase64: z.string(), mimeType: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const me = await getEmployeeByUserId(ctx.user.id);
        if (!me) throw new TRPCError({ code: "FORBIDDEN", message: "A tua conta não está associada a um colaborador." });
        const { storagePut } = await import("./storage");
        const buffer = Buffer.from(input.fileBase64, "base64");
        const ext = input.mimeType.split("/")[1] ?? "jpg";
        const key = `employees/${me.employee.id}/photo-${Date.now()}.${ext}`;
        const { url } = await storagePut(key, buffer, input.mimeType);
        await updateEmployee(me.employee.id, { photoUrl: url, photoKey: key });
        return { url, key };
      }),

    // ── DOCUMENTS ─────────────────────────────────────────────────────────────────────────────────
    documents: router({
      // Documentos pessoais: admin+, o PRÓPRIO, ou supervisor do centro.
      list: protectedProcedure
        .input(z.object({ employeeId: z.number() }))
        .query(async ({ ctx, input }) => {
          await assertCanViewDocuments(ctx.user, input.employeeId, "Sem permissão para ver estes documentos");
          const docs = await getEmployeeDocuments(input.employeeId);
          // a URL pública gravada deixa de ser exposta — abre-se pela rota `url` (assinada)
          return docs.map((d: any) => ({ ...d, fileUrl: null }));
        }),
      // URL de leitura temporária (assinada no S3) com a MESMA permissão da lista.
      url: protectedProcedure
        .input(z.object({ id: z.number() }))
        .query(async ({ ctx, input }) => {
          const { getDb } = await import("./db");
          const { employeeDocuments } = await import("../drizzle/schema");
          const { eq } = await import("drizzle-orm");
          const db = await getDb();
          if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
          const [doc] = await db.select().from(employeeDocuments).where(eq(employeeDocuments.id, input.id)).limit(1);
          if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
          await assertCanViewDocuments(ctx.user, doc.employeeId, "Sem permissão para abrir este documento");
          const { storagePresignGet } = await import("./storage");
          const r = await storagePresignGet(doc.fileKey || doc.fileUrl, { fallbackUrl: doc.fileUrl });
          await logActivity({ userId: ctx.user.id, action: "view", entity: "employee_document", entityId: doc.id, details: `${doc.docType} de #${doc.employeeId}` });
          return { url: r.url, signed: r.signed, expiresIn: r.expiresIn, mimeType: doc.mimeType };
        }),

      upload: protectedProcedure
        .input(z.object({
          employeeId: z.number(),
          docType: z.enum(["id_card","residence_permit","driving_license","nib_proof","address_proof","contract","extra_contract","contract_annex","responsibility_term","work_accident_insurance","photo","other"]),
          label: z.string().optional(),
          fileBase64: z.string(),
          mimeType: z.string(),
          fileName: z.string(),
        }))
        .mutation(async ({ ctx, input }) => {
          await assertCanUploadDocuments(ctx.user, input.employeeId);
          const { storagePut } = await import("./storage");
          const buffer = Buffer.from(input.fileBase64, "base64");
          const key = `employees/${input.employeeId}/docs/${input.docType}-${Date.now()}-${input.fileName}`;
          const { url } = await storagePut(key, buffer, input.mimeType);
          await createEmployeeDocument({
            employeeId: input.employeeId,
            docType: input.docType,
            label: input.label ?? input.fileName,
            fileUrl: url,
            fileKey: key,
            mimeType: input.mimeType,
            uploadedById: ctx.user.id,
          });
          await logActivity({ userId: ctx.user.id, action: "upload", entity: "employee_document", entityId: input.employeeId, details: `Documento carregado: ${input.docType}` });
          // IA lê o documento e preenche os campos VAZIOS da ficha (best-effort)
          let autofill: { filled: string[] } = { filled: [] };
          try {
            const { autofillFromDocument } = await import("./documentAutofill");
            const r = await autofillFromDocument({ employeeId: input.employeeId, docType: input.docType, mimeType: input.mimeType, base64: input.fileBase64, userId: ctx.user.id });
            autofill = { filled: r.filled };
          } catch (err) { console.warn("[documents.upload] leitura por IA falhou:", String((err as any)?.message ?? err).slice(0, 200)); }
          return { url, key, autofill };
        }),

      uploadBatch: protectedProcedure
        .input(z.object({
          employeeId: z.number(),
          docType: z.enum(["id_card","residence_permit","driving_license","nib_proof","address_proof","contract","extra_contract","contract_annex","responsibility_term","work_accident_insurance","photo","other"]),
          files: z.array(z.object({
            fileBase64: z.string(),
            mimeType: z.string(),
            fileName: z.string(),
            label: z.string().optional(),
          })),
        }))
        .mutation(async ({ ctx, input }) => {
          await assertCanUploadDocuments(ctx.user, input.employeeId);
          const { storagePut } = await import("./storage");
          const results: { url: string; key: string }[] = [];
          for (const file of input.files) {
            const buffer = Buffer.from(file.fileBase64, "base64");
            const key = `employees/${input.employeeId}/docs/${input.docType}-${Date.now()}-${Math.random().toString(36).slice(2)}-${file.fileName}`;
            const { url } = await storagePut(key, buffer, file.mimeType);
            await createEmployeeDocument({
              employeeId: input.employeeId,
              docType: input.docType,
              label: file.label ?? file.fileName,
              fileUrl: url,
              fileKey: key,
              mimeType: file.mimeType,
              uploadedById: ctx.user.id,
            });
            results.push({ url, key });
          }
          await logActivity({ userId: ctx.user.id, action: "upload", entity: "employee_document", entityId: input.employeeId, details: `${input.files.length} documentos carregados: ${input.docType}` });
          // IA: lê as páginas (ex.: frente e verso do CC) até preencher o que falta
          const filled: string[] = [];
          try {
            const { autofillFromDocument } = await import("./documentAutofill");
            for (const f of input.files.slice(0, 3)) {
              const r = await autofillFromDocument({ employeeId: input.employeeId, docType: input.docType, mimeType: f.mimeType, base64: f.fileBase64, userId: ctx.user.id });
              filled.push(...r.filled);
              if (r.skipped) break;
            }
          } catch (err) { console.warn("[documents.uploadBatch] leitura por IA falhou:", String((err as any)?.message ?? err).slice(0, 200)); }
          return Object.assign(results, { autofill: { filled } });
        }),
      checklist: protectedProcedure
        .input(z.object({ employeeId: z.number() }))
        .query(async ({ ctx, input }) => {
          await assertCanViewDocuments(ctx.user, input.employeeId, "Sem permissão");
          return getDocumentChecklistForEmployee(input.employeeId);
        }),
      allStatus: protectedProcedure
        .query(async ({ ctx }) => {
          requireAccess(ctx.user, "rh", "view");
          const map = await getAllEmployeesDocumentStatus();
          const MANDATORY = ["photo","id_card","driving_license","nib_proof","address_proof","contract","responsibility_term"];
          const result: Record<number, { total: number; present: number; missing: string[] }> = {};
          if (map instanceof Map) {
            map.forEach((types, empId) => {
              const missing = MANDATORY.filter(t => !types.has(t));
              result[empId] = { total: MANDATORY.length, present: MANDATORY.length - missing.length, missing };
            });
          }
          return result;
        }),
      delete: protectedProcedure
        .input(z.object({ id: z.number() }))
        .mutation(async ({ ctx, input }) => {
          // admin+ (ficha não protegida), ou quem carregou o documento e ainda
          // pode mexer na ficha (o próprio, gestor do centro, backoffice).
          const { getDb } = await import("./db");
          const { employeeDocuments } = await import("../drizzle/schema");
          const { eq } = await import("drizzle-orm");
          const db = await getDb();
          if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
          const [doc] = await db.select().from(employeeDocuments).where(eq(employeeDocuments.id, input.id)).limit(1);
          if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
          const viewer = await rhViewer(ctx.user);
          const ref = await rhEmployeeRef(doc.employeeId);
          const allowed = ref ? canDeleteDocument(viewer, ref, doc.uploadedById) : isRhAdmin(viewer);
          if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para eliminar este documento" });
          await deleteEmployeeDocument(input.id);
          await logActivity({ userId: ctx.user.id, action: "delete", entity: "employee_document", entityId: doc.id, details: `${doc.docType} de #${doc.employeeId}` });
          return { success: true };
        }),
    }),

    // ── SCHEDULES ─────────────────────────────────────────────────────────────────────────────────
    schedules: router({
      list: protectedProcedure
        .input(z.object({ employeeId: z.number() }))
        .query(async ({ ctx, input }) => {
          const viewer = await rhViewer(ctx.user);
          const ref = await rhEmployeeRef(input.employeeId);
          if (!isRhAdmin(viewer) && (!ref || !canViewTimeAndSchedule(viewer, ref))) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
          if (!isOwn(viewer, input.employeeId)) await assertEmployeeAccess(input.employeeId);
          return getEmployeeSchedules(input.employeeId);
        }),

      upsert: protectedProcedure
        .input(z.object({
          employeeId: z.number(),
          weekday: z.number().min(0).max(6),
          startTime: z.string(),
          endTime: z.string(),
          isWorkDay: z.boolean(),
        }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "manage");
          await upsertSchedule({ ...input, isWorkDay: input.isWorkDay ? 1 : 0 });
          return { success: true };
        }),

      delete: protectedProcedure
        .input(z.object({ employeeId: z.number(), weekday: z.number().min(0).max(6) }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "manage");
          await deleteSchedule(input.employeeId, input.weekday);
          return { success: true };
        }),
    }),

    // ── TIME RECORDS ────────────────────────────────────────────────────────────────────────────────
    timeRecords: router({
      // Estado do ponto do PRÓPRIO utilizador (para o atalho no menu do avatar):
      // qualquer role pode consultar o seu — não expõe registos de terceiros.
      myStatus: protectedProcedure.query(async ({ ctx }) => {
        const me = await getEmployeeByUserId(ctx.user.id);
        if (!me) return { employeeId: null as number | null, status: null as "in" | "out" | null, since: null as string | null };
        const records = await getTimeRecords(me.employee.id);
        const last = records[0];
        return {
          employeeId: me.employee.id as number | null,
          status: (last?.type === "check_in" ? "in" : "out") as "in" | "out" | null,
          since: (last?.recordedAt ?? null) as string | null,
        };
      }),

      list: protectedProcedure
        .input(z.object({ employeeId: z.number(), startDate: z.string().optional(), endDate: z.string().optional() }))
        .query(async ({ ctx, input }) => {
          const viewer = await rhViewer(ctx.user);
          const ref = await rhEmployeeRef(input.employeeId);
          if (!isRhAdmin(viewer) && (!ref || !canViewTimeAndSchedule(viewer, ref))) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
          if (!isOwn(viewer, input.employeeId)) await assertEmployeeAccess(input.employeeId);
          return getTimeRecords(
            input.employeeId,
            input.startDate ? new Date(input.startDate) : undefined,
            input.endDate ? new Date(input.endDate) : undefined,
          );
        }),

      // Registos suspeitos (check-out esquecido/cortado, fora do raio): não pagam até revisão.
      suspicious: protectedProcedure
        .input(z.object({ employeeId: z.number().optional(), limit: z.number().max(500).optional() }).optional())
        .query(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "edit");
          return listSuspiciousTimeRecords({ employeeId: input?.employeeId, limit: input?.limit });
        }),
      review: protectedProcedure
        .input(z.object({ id: z.number(), decision: z.enum(["approved", "rejected"]), note: z.string().max(255).optional(), correctedHours: z.number().min(0).max(24).optional() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "manage");
          await reviewTimeRecord(input.id, input.decision, ctx.user.id, input.note ?? null, input.correctedHours ?? null);
          await logActivity({ userId: ctx.user.id, action: "review", entity: "time_record", entityId: input.id, details: `${input.decision}${input.correctedHours != null ? ` (${input.correctedHours}h)` : ""}${input.note ? ` — ${input.note}` : ""}` });
          return { success: true };
        }),

      checkIn: protectedProcedure
        .input(z.object({
          employeeId: z.number(),
          photoBase64: z.string().optional(),
          mimeType: z.string().optional(),
          latitude: z.string().optional(),
          longitude: z.string().optional(),
          locationName: z.string().optional(),
          notes: z.string().optional(),
          // Token do aparelho (localStorage do browser do PDA) — liga a pessoa
          // ao PDA/Zello automaticamente no check-in do ponto
          pdaDeviceToken: z.string().optional(),
        }))
        .mutation(async ({ ctx, input }) => {
          // admin pode picar a qualquer um; outros só ao próprio
          if (ROLE_HIERARCHY[ctx.user.role] < ROLE_HIERARCHY["admin"]) {
            const me = await getEmployeeByUserId(ctx.user.id);
            if (!me || me.employee.id !== input.employeeId) {
              throw new TRPCError({ code: "FORBIDDEN", message: "Só podes picar o teu próprio ponto" });
            }
          }
          // Pré-requisitos para dar entrada: utilizador associado + foto de perfil.
          const empForPonto = await getEmployeeById(input.employeeId);
          if (!empForPonto) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
          if (!empForPonto.employee.userId) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Este colaborador ainda não tem utilizador associado. Associa um utilizador na ficha do colaborador antes de picar o ponto." });
          }
          if (!empForPonto.employee.photoUrl) {
            throw new TRPCError({ code: "FORBIDDEN", message: "É preciso uma foto de perfil para picar o ponto. Adiciona a foto na ficha do colaborador." });
          }
          // Bloqueia dois check-ins seguidos sem check-out
          const recent = await getTimeRecords(input.employeeId);
          const last = recent[0];
          if (last && last.type === "check_in") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Já tens uma entrada em aberto. Faz check-out primeiro.",
            });
          }
          // Aviso da ligação tripla (funcionário↔utilizador↔agente Multipark):
          // sem agente ligado o check-in passa, mas devolve o aviso para a UI.
          const missingAgentWarning = !empForPonto.employee.multiparkAgentName
            ? "Falta ligar o agente Multipark a este colaborador — pede à administração para o associar na ficha."
            : null;
          // Geofence do centro de custos (se configurado): fora do raio fica marcado.
          const geoNoteIn = await checkGeofenceNote(input.employeeId, input.latitude, input.longitude);
          let photoUrl: string | null = null;
          let photoKey: string | null = null;
          if (input.photoBase64 && input.mimeType) {
            const { storagePut } = await import("./storage");
            const buffer = Buffer.from(input.photoBase64, "base64");
            const ext = input.mimeType.split("/")[1] ?? "jpg";
            const key = `employees/${input.employeeId}/ponto/${Date.now()}.${ext}`;
            const result = await storagePut(key, buffer, input.mimeType);
            photoUrl = result.url;
            photoKey = key;
          }
          // Inserção ATÓMICA (linha do colaborador bloqueada): dois toques
          // simultâneos já não criam duas entradas.
          try {
            await insertTimeRecordAtomic(input.employeeId, "check_in", {
              recordedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
              photoUrl,
              photoKey,
              latitude: input.latitude ?? null,
              longitude: input.longitude ?? null,
              locationName: input.locationName ?? null,
              notes: [geoNoteIn, input.notes].filter(Boolean).join(" · ") || null,
            });
          } catch (e: any) {
            throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
          }
          await logActivity({ userId: ctx.user.id, action: "check_in", entity: "time_record", entityId: input.employeeId, details: `Check-in: ${input.locationName ?? ""}` });
          // Ponto→PDA automático: se o check-in veio do browser de um PDA
          // registado, liga já a pessoa ao PDA/Zello (e troca quem lá estava).
          let pdaAttached: { pdaName: string; zelloUsername: string | null; replacedName: string | null } | null = null;
          if (input.pdaDeviceToken) {
            try {
              const { attachPdaByDeviceToken } = await import("./db");
              const att = await attachPdaByDeviceToken(input.pdaDeviceToken, input.employeeId);
              if (att) {
                pdaAttached = { pdaName: att.pdaName, zelloUsername: att.zelloUsername, replacedName: att.replacedName };
                await logActivity({ userId: ctx.user.id, action: "create", entity: "pda_checkin", entityId: att.pdaId, details: `Auto: ponto→PDA ${att.pdaName}${att.replacedName ? ` (substituiu ${att.replacedName})` : ""}` });
              }
            } catch (err) {
              console.warn("[checkIn] ponto→PDA automático falhou:", err);
            }
          }
          return { success: true, warning: missingAgentWarning, outsideGeofence: !!geoNoteIn, pdaAttached };
        }),

      checkOut: protectedProcedure
        .input(z.object({
          employeeId: z.number(),
          photoBase64: z.string().optional(),
          mimeType: z.string().optional(),
          latitude: z.string().optional(),
          longitude: z.string().optional(),
          locationName: z.string().optional(),
          notes: z.string().optional(),
        }))
        .mutation(async ({ ctx, input }) => {
          if (ROLE_HIERARCHY[ctx.user.role] < ROLE_HIERARCHY["admin"]) {
            const me = await getEmployeeByUserId(ctx.user.id);
            if (!me || me.employee.id !== input.employeeId) {
              throw new TRPCError({ code: "FORBIDDEN", message: "Só podes picar o teu próprio ponto" });
            }
          }
          // Exige check-in aberto
          const records = await getTimeRecords(input.employeeId);
          const last = records[0];
          if (!last || last.type !== "check_in") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Não tens entrada em aberto. Faz check-in primeiro.",
            });
          }
          let photoUrl: string | null = null;
          let photoKey: string | null = null;
          if (input.photoBase64 && input.mimeType) {
            const { storagePut } = await import("./storage");
            const buffer = Buffer.from(input.photoBase64, "base64");
            const ext = input.mimeType.split("/")[1] ?? "jpg";
            const key = `employees/${input.employeeId}/ponto/${Date.now()}-out.${ext}`;
            const result = await storagePut(key, buffer, input.mimeType);
            photoUrl = result.url;
            photoKey = key;
          }
          const diff = (new Date().getTime() - new Date(last.recordedAt).getTime()) / 3600000;
          // Regra do Jorge (turnos máx. 12h): entrada aberta há >16h = esquecimento
          // de check-out. Corta às 12h (sem extraordinárias) e marca a VERMELHO
          // para revisão — não paga dias inteiros de horas fantasma.
          let hoursWorked: string;
          let autoNote: string | null = null;
          let outAt = new Date();
          if (diff > 16) {
            hoursWorked = "12.00";
            outAt = new Date(new Date(last.recordedAt).getTime() + 12 * 3600000);
            autoNote = "[SUSPEITO] check-out esquecido — cortado a 12h";
          } else {
            hoursWorked = diff.toFixed(2);
          }
          // Geofence: se o centro de custos do colaborador tem raio definido e o
          // check-out veio com GPS fora dele, fica marcado (permitido, mas visível).
          const geoNote = await checkGeofenceNote(input.employeeId, input.latitude, input.longitude);
          const finalNotes = [autoNote, geoNote, input.notes].filter(Boolean).join(" · ") || null;
          // Snapshot Zello do turno (pedido Jorge): no check-out, vai buscar ao
          // Zello o que o condutor fez entre a entrada e a saída — km,
          // velocidades e tempo com o Zello desligado. Melhor esforço: nunca
          // pode impedir o registo do ponto.
          let zello: import("./zello").ZelloShiftSummary | null = null;
          // Descobre o utilizador Zello DESTE turno: primeiro o PDA em que a
          // pessoa fez check-in nesse dia (cada dia é um PDA diferente),
          // depois a ligação fixa da ficha (telemóveis pessoais).
          const { resolveZelloUsernameForShift } = await import("./db");
          const empZello = await resolveZelloUsernameForShift(input.employeeId, new Date(last.recordedAt), outAt);
          if (empZello) {
            try {
              const { summarizeZelloShift } = await import("./zello");
              zello = await summarizeZelloShift(empZello, new Date(last.recordedAt), outAt);
            } catch (err) {
              console.warn("[checkOut] snapshot Zello falhou:", err);
            }
          }
          // Inserção ATÓMICA (linha do colaborador bloqueada) + estado de
          // revisão: um check-out cortado a 12h nasce "suspicious" e não paga
          // até ser aprovado.
          try {
            await insertTimeRecordAtomic(input.employeeId, "check_out", {
              recordedAt: outAt.toISOString().slice(0, 19).replace("T", " "),
              photoUrl,
              photoKey,
              latitude: input.latitude ?? null,
              longitude: input.longitude ?? null,
              locationName: input.locationName ?? null,
              hoursWorked,
              notes: finalNotes,
              reviewStatus: autoNote ? "suspicious" : "ok",
              ...(zello ? {
                zelloKm: String(zello.km),
                zelloAvgSpeed: String(zello.avgSpeed),
                zelloMaxSpeed: String(zello.maxSpeed),
                zelloOfflineMinutes: zello.offlineMinutes,
                zelloOnlineMinutes: zello.onlineMinutes,
              } : {}),
            });
          } catch (e: any) {
            throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
          }
          // Fecha o check-in de PDA da pessoa (o aparelho fica livre para o
          // próximo turno — quando outro picar o ponto, a app troca sozinha)
          try {
            const { closePdaCheckinsForEmployee } = await import("./db");
            await closePdaCheckinsForEmployee(input.employeeId, outAt);
          } catch (err) {
            console.warn("[checkOut] fecho de PDA falhou:", err);
          }
          await logActivity({ userId: ctx.user.id, action: "check_out", entity: "time_record", entityId: input.employeeId, details: `Check-out: ${hoursWorked}h${zello ? ` · ${zello.km}km GPS · ${zello.offlineMinutes}min offline` : ""}` });
          return { success: true, hoursWorked, zello };
        }),

      // ── Geofence por centro de custos (raio de picagem) ───────────────────
      geofences: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "rh", "manage");
        return listProjectGeofences();
      }),
      setGeofence: protectedProcedure
        .input(z.object({ projectId: z.number(), lat: z.number(), lng: z.number(), radiusM: z.number().min(50).max(50000) }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "manage");
          await setProjectGeofence(input.projectId, input.lat, input.lng, input.radiusM);
          await logActivity({ userId: ctx.user.id, action: "update", entity: "project_geofence", entityId: input.projectId });
          return { success: true };
        }),
      deleteGeofence: protectedProcedure
        .input(z.object({ projectId: z.number() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "manage");
          await deleteProjectGeofence(input.projectId);
          return { success: true };
        }),

      monthlyHours: protectedProcedure
        .input(z.object({ employeeId: z.number(), year: z.number(), month: z.number() }))
        .query(async ({ ctx, input }) => {
          await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "admin");
          return getMonthlyHours(input.employeeId, input.year, input.month);
        }),
    }),

    // ── PAYROLL ──────────────────────────────────────────────────────────────────────────────────
    // Apuramento PROVISÓRIO do mês (cálculo ao vivo). O que foi aprovado/pago
    // vive nos fechos (payrollRuns). Filtro por centro de custos opcional.
    payroll: protectedProcedure
      .input(z.object({ year: z.number(), month: z.number().min(1).max(12), projectId: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh_salarios", "view");
        return getPayrollData(input.year, input.month, { projectId: input.projectId ?? null });
      }),

    // ── FECHO MENSAL: apuramento → aprovado → pago (versões imutáveis) ──────
    payrollRuns: router({
      list: protectedProcedure
        .input(z.object({ year: z.number().optional(), month: z.number().min(1).max(12).optional() }).optional())
        .query(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh_salarios", "view");
          return listPayrollRuns(input?.year, input?.month);
        }),
      get: protectedProcedure
        .input(z.object({ id: z.number() }))
        .query(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh_salarios", "view");
          return getPayrollRun(input.id);
        }),
      create: protectedProcedure
        .input(z.object({ year: z.number(), month: z.number().min(1).max(12), notes: z.string().max(1000).optional() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh_salarios", "manage");
          const r = await createPayrollRun(input.year, input.month, ctx.user.id, input.notes ?? null);
          await logActivity({ userId: ctx.user.id, action: "payroll_close", entity: "payroll_run", entityId: r.runId, details: `${input.year}-${String(input.month).padStart(2, "0")} v${r.version}: ${r.employeesCount} pessoas, ${r.totalGross.toFixed(2)}€ bruto, ${r.warningsCount} com avisos` });
          return r;
        }),
      approve: protectedProcedure
        .input(z.object({ id: z.number() }))
        .mutation(async ({ ctx, input }) => {
          requireRole(ctx.user.role, "super_admin");
          try { await transitionPayrollRun(input.id, "approved", ctx.user.id); } catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) }); }
          await logActivity({ userId: ctx.user.id, action: "payroll_approve", entity: "payroll_run", entityId: input.id });
          return { success: true };
        }),
      markPaid: protectedProcedure
        .input(z.object({ id: z.number(), paymentRef: z.string().max(128).optional() }))
        .mutation(async ({ ctx, input }) => {
          requireRole(ctx.user.role, "super_admin");
          try { await transitionPayrollRun(input.id, "paid", ctx.user.id, input.paymentRef ?? null); } catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) }); }
          await logActivity({ userId: ctx.user.id, action: "payroll_paid", entity: "payroll_run", entityId: input.id, details: input.paymentRef ?? "" });
          return { success: true };
        }),
      void: protectedProcedure
        .input(z.object({ id: z.number() }))
        .mutation(async ({ ctx, input }) => {
          requireRole(ctx.user.role, "super_admin");
          try { await transitionPayrollRun(input.id, "void", ctx.user.id); } catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) }); }
          return { success: true };
        }),
    }),

    payrollPdf: protectedProcedure
      .input(z.object({ year: z.number(), month: z.number().min(1).max(12) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh_salarios", "export");
        const pdfBuffer = await generatePayrollPdf(input.year, input.month);
        const { storagePut } = await import("./storage");
        const fileName = `folha_ordenados_${input.year}_${String(input.month).padStart(2, "0")}.pdf`;
        const key = `payroll/${fileName}_${Date.now()}.pdf`;
        const { url } = await storagePut(key, pdfBuffer, "application/pdf");
        await savePayslipRecord({ year: input.year, month: input.month, payslipType: "payroll", url, fileName, generatedById: ctx.user.id, generatedByName: ctx.user.name ?? "Admin" });
        return { url, fileName };
      }),

    payslipPdf: protectedProcedure
      .input(z.object({ year: z.number(), month: z.number().min(1).max(12), employeeId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh_salarios", "export");
        // O recibo de vencimento é da cidade da ficha, não de quem o pede.
        await assertEmployeeAccess(input.employeeId);
        const pdfBuffer = await generatePayslipPdf(input.year, input.month, input.employeeId);
        const { storagePut } = await import("./storage");
        // Get employee name for history
        const payrollData = await getPayrollData(input.year, input.month);
        const emp = payrollData.find((e: any) => e.employeeId === input.employeeId);
        const empName = emp?.fullName ?? `Funcionário #${input.employeeId}`;
        const fileName = `recibo_${empName.replace(/[^a-zA-Z0-9]/g, "_")}_${input.year}_${String(input.month).padStart(2, "0")}.pdf`;
        const key = `payslips/${fileName}_${Date.now()}.pdf`;
        const { url } = await storagePut(key, pdfBuffer, "application/pdf");
        await savePayslipRecord({ employeeId: input.employeeId, employeeName: empName, year: input.year, month: input.month, payslipType: "individual", url, fileName, generatedById: ctx.user.id, generatedByName: ctx.user.name ?? "Admin" });
        return { url };
      }),

    allPayslipsPdf: protectedProcedure
      .input(z.object({ year: z.number(), month: z.number().min(1).max(12) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh_salarios", "export");
        const payslips = await generateAllPayslipsPdf(input.year, input.month);
        const { storagePut } = await import("./storage");
        const results: Array<{ employeeId: number; fullName: string; url: string }> = [];
        for (const ps of payslips) {
          const safeName = ps.fullName.replace(/[^a-zA-Z0-9]/g, "_");
          const fileName = `recibo_${safeName}_${input.year}_${String(input.month).padStart(2, "0")}.pdf`;
          const key = `payslips/${fileName}_${Date.now()}.pdf`;
          const { url } = await storagePut(key, ps.buffer, "application/pdf");
          results.push({ employeeId: ps.employeeId, fullName: ps.fullName, url });
          await savePayslipRecord({ employeeId: ps.employeeId, employeeName: ps.fullName, year: input.year, month: input.month, payslipType: "individual", url, fileName, generatedById: ctx.user.id, generatedByName: ctx.user.name ?? "Admin" });
        }
        return { payslips: results, count: results.length };
      }),

    sendPayrollEmail: protectedProcedure
      .input(z.object({ year: z.number(), month: z.number().min(1).max(12), email: z.string().email() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh_salarios", "manage");
        // Generate PDF and upload to S3
        const pdfBuffer = await generatePayrollPdf(input.year, input.month);
        const { storagePut } = await import("./storage");
        const monthNames = ["Janeiro","Fevereiro","Mar\u00e7o","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
        const monthName = monthNames[input.month - 1];
        const key = `payroll/folha_ordenados_${input.year}_${String(input.month).padStart(2, "0")}_${Date.now()}.pdf`;
        const { url } = await storagePut(key, pdfBuffer, "application/pdf");
        // Notify the owner with the PDF link so they can forward it
        const { notifyOwner } = await import("./_core/notification");
        await notifyOwner({
          title: `Folha de Ordenados - ${monthName} ${input.year}`,
          content: `A folha de ordenados de ${monthName} ${input.year} foi gerada e est\u00e1 pronta para enviar ao contabilista (${input.email}).\n\nLink do PDF: ${url}`,
        });
        return { url, email: input.email, monthName, year: input.year };
      }),

    // ── FÉRIAS / BAIXAS ────────────────────────────────────────────────────
    leaves: router({
      list: protectedProcedure
        .input(z.object({ employeeId: z.number(), year: z.number().optional() }))
        .query(async ({ ctx, input }) => {
          await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "admin");
          return getEmployeeLeaves(input.employeeId, input.year);
        }),
      create: protectedProcedure
        .input(z.object({
          employeeId: z.number(),
          leaveType: z.enum(["vacation", "sick", "unpaid", "other"]),
          fromDate: z.string(),
          toDate: z.string(),
          notes: z.string().optional(),
        }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "manage");
          await createEmployeeLeave({ ...input, createdById: ctx.user.id });
          await logActivity({ userId: ctx.user.id, action: "create", entity: "employee_leave", entityId: input.employeeId, details: `${input.leaveType} ${input.fromDate}→${input.toDate}` });
          return { success: true };
        }),
      delete: protectedProcedure
        .input(z.object({ id: z.number() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "manage");
          await deleteEmployeeLeave(input.id);
          return { success: true };
        }),
    }),

    // ── HISTÓRICO SALARIAL ─────────────────────────────────────────────────
    salaryHistory: protectedProcedure
      .input(z.object({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "admin");
        return getEmployeeSalaryHistory(input.employeeId);
      }),

    // ── PENALIZAÇÕES ───────────────────────────────────────────────────────
    penalties: router({
      list: protectedProcedure
        .input(z.object({ employeeId: z.number() }))
        .query(async ({ ctx, input }) => {
          await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "team_leader");
          return getOpenPenalties(input.employeeId);
        }),
      clear: protectedProcedure
        .input(z.object({ id: z.number() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "edit");
          await clearPenalty(input.id, ctx.user.id);
          await logActivity({ userId: ctx.user.id, action: "clear", entity: "employee_penalty", entityId: input.id });
          return { success: true };
        }),
      // Gera "POSSÍVEIS faltas" (pendentes) — só contam pontos depois de confirmadas.
      processNoShows: protectedProcedure
        .input(z.object({ date: z.string() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "manage");
          const report = await detectExtraDiaNoShows(input.date);
          await logActivity({ userId: ctx.user.id, action: "process_noshows", entity: "extras_dia", details: `${input.date}: ${report.created} possíveis faltas` });
          return report;
        }),
      pending: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "rh", "edit");
        return listPendingPenalties();
      }),
      review: protectedProcedure
        .input(z.object({ id: z.number(), decision: z.enum(["confirmed", "dismissed"]), note: z.string().max(200).optional() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "rh", "edit");
          const r = await reviewPenalty(input.id, input.decision, ctx.user.id, input.note ?? null);
          await logActivity({ userId: ctx.user.id, action: input.decision === "confirmed" ? "confirm_penalty" : "dismiss_penalty", entity: "employee_penalty", entityId: input.id, details: `${input.decision}${input.note ? ` — ${input.note}` : ""} · pontos ${r.points}${r.blocked ? " · BLOQUEADO" : ""}` });
          return r;
        }),
    }),

    // ── BLOQUEIO LOGIN ─────────────────────────────────────────────────────
    unblock: protectedProcedure
      .input(z.object({ employeeId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "edit");
        await unblockEmployeeLogin(input.employeeId, ctx.user.id);
        return { success: true };
      }),

    checkDocs: protectedProcedure
      .input(z.object({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        if (ROLE_HIERARCHY[ctx.user.role] < ROLE_HIERARCHY["admin"]) {
          const me = await getEmployeeByUserId(ctx.user.id);
          if (!me || me.employee.id !== input.employeeId) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
        }
        // ação explícita: aplica a regra documental (escreve só blockedByDocs/aviso)
        return applyDocsCompliance(input.employeeId);
      }),

    // ── DASHBOARD RH (super_admin) ─────────────────────────────────────────
    dashboard: protectedProcedure
      .input(z.object({
        year: z.number().optional(),
        month: z.number().min(1).max(12).optional(),
        monthsLookback: z.number().min(1).max(12).optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "super_admin");
        const now = new Date();
        return getRhDashboardSummary(
          input?.year ?? now.getFullYear(),
          input?.month ?? (now.getMonth() + 1),
          input?.monthsLookback ?? 3,
        );
      }),

    // ── EXTRA RATES ─────────────────────────────────────────────────────────────────────────────────
    extraRates: router({
      // Leitura para quem compõe a escala (backoffice+): sem isto o Extras Dia
      // caía em silêncio nas taxas por defeito. Editar continua super_admin.
      list: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "rh_salarios", "view");
        await seedExtraRates();
        return getExtraRates();
      }),

      update: protectedProcedure
        .input(z.object({ level: z.number(), hourlyRate: z.string() }))
        .mutation(async ({ ctx, input }) => {
          requireRole(ctx.user.role, "super_admin");
          const { normalizeHourlyRate, MAX_EXTRA_HOURLY_RATE } = await import("./extraRates");
          const rate = normalizeHourlyRate(input.hourlyRate);
          if (!rate) throw new TRPCError({ code: "BAD_REQUEST", message: `Taxa inválida: indica um valor numérico maior que 0 e até ${MAX_EXTRA_HOURLY_RATE} €/h.` });
          const before = (await getExtraRates()).find((r: any) => Number(r.level) === input.level);
          if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Nível de taxa inexistente" });
          await updateExtraRate(input.level, rate);
          await logActivity({ userId: ctx.user.id, action: "update", entity: "extra_rate", entityId: input.level,
            details: `Taxa ${before.levelName ?? `nível ${input.level}`}: ${before.hourlyRate} → ${rate} €/h` });
          return { success: true };
        }),
    }),
  }),

  // ─── MARKETING ────────────────────────────────────────────────────────────
  marketing: router({
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
  operational: router({
    dashboard: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getOperationalStats();
    }),

    vehicles: router({
      // frontoffice: usado nas Reclamações (associar viatura)
      list: protectedProcedure.input(z.object({ status: z.string().optional(), projectId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getVehicles(input ?? undefined);
      }),
      get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getVehicleById(input.id);
      }),
      create: protectedProcedure.input(z.object({
        plate: z.string().min(1),
        brand: z.string().optional(),
        model: z.string().optional(),
        year: z.number().optional(),
        color: z.string().optional(),
        status: z.enum(["active", "maintenance", "inactive"]).optional(),
        projectId: z.number().optional(),
        notes: z.string().optional(),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "manage");
        const id = await createVehicle({
          plate: input.plate,
          brand: input.brand ?? null,
          model: input.model ?? null,
          year: input.year ?? null,
          color: input.color ?? null,
          vehicleStatus: input.status ?? "active",
          projectId: input.projectId ?? null,
          notes: input.notes ?? null,
        });
        await logActivity({ userId: ctx.user.id, action: "create", entity: "vehicle", entityId: id, details: `Viatura ${input.plate}` });
        return { id };
      }),
      update: protectedProcedure.input(z.object({
        id: z.number(),
        data: z.object({
          plate: z.string().optional(),
          brand: z.string().optional(),
          model: z.string().optional(),
          year: z.number().optional(),
          color: z.string().optional(),
          status: z.enum(["active", "maintenance", "inactive"]).optional(),
          projectId: z.number().nullable().optional(),
          notes: z.string().optional(),
        }),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "manage");
        const { status, ...rest } = input.data;
        await updateVehicle(input.id, { ...rest, ...(status !== undefined && { vehicleStatus: status }) });
        await logActivity({ userId: ctx.user.id, action: "update", entity: "vehicle", entityId: input.id, details: "Viatura atualizada" });
        return { success: true };
      }),
      delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "super_admin");
        await deleteVehicle(input.id);
        await logActivity({ userId: ctx.user.id, action: "delete", entity: "vehicle", entityId: input.id, details: "Viatura eliminada" });
        return { success: true };
      }),
      driverHistory: protectedProcedure.input(z.object({ vehicleId: z.number() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getVehicleDriverHistory(input.vehicleId);
      }),
    }),

    movements: router({
      list: protectedProcedure.input(z.object({ vehicleId: z.number().optional(), employeeId: z.number().optional(), limit: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getVehicleMovements(input ?? undefined);
      }),
      create: protectedProcedure.input(z.object({
        vehicleId: z.number(),
        employeeId: z.number(),
        type: z.enum(["pickup", "return"]),
        kmReading: z.number().optional(),
        latitude: z.string().optional(),
        longitude: z.string().optional(),
        notes: z.string().optional(),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "edit");
        const id = await createVehicleMovement({
          vehicleId: input.vehicleId,
          employeeId: input.employeeId,
          movementType: input.type,
          kmReading: input.kmReading ?? null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          notes: input.notes ?? null,
        });
        await logActivity({ userId: ctx.user.id, action: "create", entity: "vehicle_movement", entityId: id, details: `${input.type === "pickup" ? "Recolha" : "Devolução"} viatura #${input.vehicleId}` });
        return { id };
      }),
    }),

    speedAlerts: router({
      list: protectedProcedure.input(z.object({ vehicleId: z.number().optional(), acknowledged: z.boolean().optional(), limit: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getSpeedAlerts(input ?? undefined);
      }),
      create: protectedProcedure.input(z.object({
        vehicleId: z.number(),
        employeeId: z.number().optional(),
        speed: z.number(),
        speedLimit: z.number(),
        latitude: z.string().optional(),
        longitude: z.string().optional(),
        roadName: z.string().optional(),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "edit");
        const id = await createSpeedAlert({
          vehicleId: input.vehicleId,
          employeeId: input.employeeId ?? null,
          speed: input.speed,
          speedLimit: input.speedLimit,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          roadName: input.roadName ?? null,
        });
        // Notify super admin
        const admins = await getSuperAdmins();
        if (admins.length > 0) {
          await notifyOwner({ title: "Alerta de Velocidade", content: `Viatura #${input.vehicleId} a ${input.speed} km/h (limite: ${input.speedLimit} km/h)${input.roadName ? " em " + input.roadName : ""}` });
        }
        await logActivity({ userId: ctx.user.id, action: "create", entity: "speed_alert", entityId: id, details: `${input.speed}km/h (limite ${input.speedLimit}km/h)` });
        return { id };
      }),
      acknowledge: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "manage");
        await acknowledgeSpeedAlert(input.id, ctx.user.id);
        return { success: true };
      }),
    }),

    radio: router({
      list: protectedProcedure.input(z.object({ employeeId: z.number().optional(), vehicleId: z.number().optional(), limit: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "radio", "view");
        return getRadioTranscriptions(input ?? undefined);
      }),
      transcribe: protectedProcedure.input(z.object({
        audioUrl: z.string(),
        employeeId: z.number().optional(),
        vehicleId: z.number().optional(),
        duration: z.number().optional(),
      })).mutation(async ({ ctx, input }) => {
        // Transcrição com custo real (IA). Restringir a team_leader+.
        requireAccess(ctx.user, "radio", "edit");
        const { transcribeAndSummarizeRadio } = await import("./radioAi");
        const { aiTrpcError } = await import("./_core/ai/trpcError");
        let transcriptionText: string;
        let summaryText: string;
        try {
          ({ transcription: transcriptionText, summary: summaryText } = await transcribeAndSummarizeRadio(input.audioUrl, { userId: ctx.user.id }));
        } catch (err) {
          throw aiTrpcError(err);
        }
        const id = await createRadioTranscription({
          audioUrl: input.audioUrl,
          transcription: transcriptionText,
          summary: summaryText,
          employeeId: input.employeeId ?? null,
          vehicleId: input.vehicleId ?? null,
          duration: input.duration ?? null,
          transcribedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
          createdById: ctx.user.id,
        });
        await logActivity({ userId: ctx.user.id, action: "create", entity: "radio_transcription", entityId: id, details: "Transcrição de rádio" });
        return { id, transcription: transcriptionText, summary: summaryText };
      }),
    }),

    // ─── ZELLO INTEGRATION ──────────────────────────────────────────────
    zello: router({
      users: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getZelloUsers();
      }),
      // Resolução Zello→pessoa para o mapa ao vivo: check-ins de PDA ativos
      // primeiro (os "Extra NNN" vivem nos PDAs e cada dia é uma pessoa
      // diferente), ligações fixas da ficha como fallback.
      mappings: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        const { getZelloLiveMappings } = await import("./db");
        return getZelloLiveMappings();
      }),
      // Anexa (ou desanexa) um utilizador Zello a um colaborador — PERSISTENTE,
      // como o mapping de agentes Multipark. Único: limpa o username de quem o
      // tivesse. O GPS passa a mostrar o colaborador em vez de "extra600".
      mapUserToEmployee: protectedProcedure
        .input(z.object({ zelloUsername: z.string().min(1), employeeId: z.number().nullable() }))
        .mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "atividade_diaria", "edit");
          const { getDb } = await import("./db");
          const { sql } = await import("drizzle-orm");
          const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
          await db.execute(sql`UPDATE employees SET zelloUsername = NULL WHERE zelloUsername = ${input.zelloUsername}`);
          if (input.employeeId != null) {
            await db.execute(sql`UPDATE employees SET zelloUsername = ${input.zelloUsername} WHERE id = ${input.employeeId}`);
          }
          await logActivity({ userId: ctx.user.id, action: "map_zello", entity: "employees", entityId: input.employeeId ?? undefined, details: `zello=${input.zelloUsername}` });
          return { success: true };
        }),
      channels: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getZelloChannels();
      }),
      locations: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getZelloLocations();
      }),
      userLocation: protectedProcedure.input(z.object({ username: z.string() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getZelloUserLocation(input.username);
      }),
      userHistory: protectedProcedure.input(z.object({
        username: z.string(),
        startTs: z.number(),
        endTs: z.number(),
      })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getZelloUserHistory(input.username, input.startTs, input.endTs);
      }),
    }),

    // ─── SPEED MONITORING ──────────────────────────────────────────────
    speedMonitoring: router({
      limits: router({
        list: protectedProcedure.query(async ({ ctx }) => {
          requireAccess(ctx.user, "atividade_diaria", "view");
          return getSpeedLimits();
        }),
        create: protectedProcedure.input(z.object({
          name: z.string().min(1),
          maxSpeed: z.number().min(1),
          tolerancePercent: z.number().min(0).max(100).default(10),
          isDefault: z.boolean().default(false),
        })).mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "atividade_diaria", "manage");
          const id = await createSpeedLimit({
            name: input.name,
            maxSpeed: input.maxSpeed,
            tolerancePercent: input.tolerancePercent,
            isDefault: input.isDefault ? 1 : 0,
          });
          await logActivity({ userId: ctx.user.id, action: "create", entity: "speed_limit", entityId: id, details: `Limite ${input.name}: ${input.maxSpeed}km/h` });
          return { id };
        }),
        update: protectedProcedure.input(z.object({
          id: z.number(),
          data: z.object({
            name: z.string().optional(),
            maxSpeed: z.number().optional(),
            tolerancePercent: z.number().optional(),
            isDefault: z.boolean().optional(),
            isActive: z.boolean().optional(),
          }),
        })).mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "atividade_diaria", "manage");
          const { isDefault, isActive, ...rest } = input.data;
          const patch: Record<string, unknown> = { ...rest };
          if (isDefault !== undefined) patch.isDefault = isDefault ? 1 : 0;
          if (isActive !== undefined) patch.isActive = isActive ? 1 : 0;
          await updateSpeedLimit(input.id, patch);
          return { success: true };
        }),
        delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "atividade_diaria", "manage");
          await deleteSpeedLimit(input.id);
          return { success: true };
        }),
      }),

      violations: router({
        list: protectedProcedure.input(z.object({
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          username: z.string().optional(),
          acknowledged: z.boolean().optional(),
        }).optional()).query(async ({ ctx, input }) => {
          requireAccess(ctx.user, "atividade_diaria", "view");
          return getSpeedViolations({
            startDate: input?.startDate ? new Date(input.startDate) : undefined,
            endDate: input?.endDate ? new Date(input.endDate) : undefined,
            username: input?.username,
            acknowledged: input?.acknowledged,
          });
        }),
        acknowledge: protectedProcedure.input(z.object({
          id: z.number(),
          notes: z.string().optional(),
        })).mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "atividade_diaria", "manage");
          await acknowledgeSpeedViolation(input.id, ctx.user.id, input.notes);
          await logActivity({ userId: ctx.user.id, action: "update", entity: "speed_violation", entityId: input.id, details: "Infração reconhecida" });
          return { success: true };
        }),
        stats: protectedProcedure.input(z.object({
          startDate: z.string().optional(),
          endDate: z.string().optional(),
        }).optional()).query(async ({ ctx, input }) => {
          requireAccess(ctx.user, "atividade_diaria", "view");
          return getSpeedViolationStats(
            input?.startDate ? new Date(input.startDate) : undefined,
            input?.endDate ? new Date(input.endDate) : undefined,
          );
        }),
      }),

      /** Check all Zello locations and record violations */
      checkNow: protectedProcedure.mutation(async ({ ctx }) => {
        requireAccess(ctx.user, "atividade_diaria", "manage");
        const locations = await getZelloLocations();
        const defaultLimit = await getDefaultSpeedLimit();
        if (!defaultLimit) return { checked: 0, violations: 0, message: "Nenhum limite de velocidade configurado" };

        const threshold = defaultLimit.maxSpeed * (1 + defaultLimit.tolerancePercent / 100);
        let violationCount = 0;

        for (const loc of locations) {
          if (loc.speed > threshold) {
            const excessPercent = ((loc.speed - defaultLimit.maxSpeed) / defaultLimit.maxSpeed) * 100;
            await recordSpeedViolation({
              zelloUsername: loc.username,
              displayName: loc.displayName || loc.username,
              speed: String(loc.speed),
              speedLimit: defaultLimit.maxSpeed,
              excessPercent: String(Math.round(excessPercent * 100) / 100),
              latitude: loc.latitude ? String(loc.latitude) : null,
              longitude: loc.longitude ? String(loc.longitude) : null,
              heading: loc.heading ? String(loc.heading) : null,
              notificationSent: 1,
              occurredAt: new Date().toISOString().slice(0, 19).replace("T", " "),
            });
            violationCount++;
            // Send notification
            await notifyOwner({
              title: "\u26a0\ufe0f Excesso de Velocidade",
              content: `${loc.displayName || loc.username} a ${loc.speed.toFixed(1)} km/h (limite: ${defaultLimit.maxSpeed} km/h, +${excessPercent.toFixed(0)}%) - Lat: ${loc.latitude}, Lon: ${loc.longitude}`,
            });
          }
        }

        return { checked: locations.length, violations: violationCount, threshold };
      }),
    }),

    // ─── DAILY DRIVER HISTORY ──────────────────────────────────────────
    driverHistory: router({
      byDate: protectedProcedure.input(z.object({ date: z.string(), projectId: z.number().optional() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "historico_diario", "view");
        return getDailyDriverHistoryByDate(input.date);
      }),
      byUser: protectedProcedure.input(z.object({ username: z.string(), projectId: z.number().optional(), limit: z.number().optional() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "historico_diario", "view");
        return getDailyDriverHistoryByUser(input.username, input.limit);
      }),
      range: protectedProcedure.input(z.object({ startDate: z.string(), endDate: z.string() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "historico_diario", "view");
        return getDailyDriverHistoryRange(input.startDate, input.endDate);
      }),
      stats: protectedProcedure.input(z.object({ date: z.string(), projectId: z.number().optional() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "historico_diario", "view");
        return getDailyDriverStats(input.date);
      }),
      /**
       * Recolha manual de um dia (só admin — abrange todas as cidades). Prazo de
       * 45 s (a função morre aos 60 s): devolve `done:false` e a UI volta a
       * chamar — a recolha é retomável. `resplit`: volta a partir o GPS já
       * recolhido por quem tinha cada PDA (depois de corrigir check-ins) — não
       * mexe nas velocidades (já em km/h).
       */
      collectDay: protectedProcedure.input(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        projectId: z.number().optional(),
        resplit: z.boolean().optional(),
        afterId: z.number().optional(),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "historico_diario", "manage");
        requireGlobalCityAccess();
        const deadlineAt = Date.now() + 45_000;
        if (input.resplit) {
          const { resplitDriverDay } = await import("./jobs/dailyDriverCollection");
          const r = await resplitDriverDay(input.date, { deadlineAt, afterId: input.afterId });
          if (r.done) await logActivity({ userId: ctx.user.id, action: "update", entity: "daily_driver_history", entityId: 0, details: `Re-divisão do GPS de ${input.date} por PDA` });
          return { success: true, done: r.done, driversProcessed: r.processed, errors: r.errors, nextAfterId: r.nextAfterId, mode: "resplit" as const };
        }
        // Meio-dia UTC → o dia de Lisboa é sempre `input.date`
        const result = await collectDailyDriverData(new Date(`${input.date}T12:00:00Z`), { deadlineAt });
        await logActivity({ userId: ctx.user.id, action: "create", entity: "daily_driver_history", entityId: 0, details: `Recolha manual para ${input.date}: ${result.driversProcessed} motoristas${result.done ? "" : " (parcial)"}` });
        return { ...result, nextAfterId: null as number | null, mode: "collect" as const };
      }),
      /** Histórico de velocidade de UMA pessoa (ou Zello sem login): por dia. */
      personHistory: protectedProcedure.input(z.object({
        employeeId: z.number().optional(), zelloUsername: z.string().max(255).optional(),
        days: z.number().int().min(1).max(366).default(30), projectId: z.number().optional(),
      })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "historico_diario", "view", { allowOwn: true });
        const { getPersonSpeedHistory } = await import("./dayActivity");
        // extra/condutor: só o PRÓPRIO histórico (a ficha da conta), nunca outro.
        if (isOwnOnly(ctx.user, "historico_diario")) {
          const me = await getEmployeeByUserId(ctx.user.id);
          if (!me) throw new TRPCError({ code: "FORBIDDEN", message: "Sem ficha associada." });
          return getPersonSpeedHistory({ ...input, employeeId: me.employee.id, zelloUsername: undefined });
        }
        return getPersonSpeedHistory(input);
      }),
      people: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx }) => {
        requireAccess(ctx.user, "historico_diario", "view");
        const { listSpeedHistoryPeople, speedThreshold } = await import("./dayActivity");
        return { ...(await listSpeedHistoryPeople(90)), threshold: await speedThreshold() };
      }),
    }),

    // ─── PDAs (DISPOSITIVOS) ──────────────────────────────────────────
    pdas: router({
      list: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "pdas", "view");
        return listPdas();
      }),
      // PDA ligado AGORA ao próprio utilizador (check-in aberto) — para o Perfil.
      mine: protectedProcedure.query(async ({ ctx }) => {
        const me = await getEmployeeByUserId(ctx.user.id);
        if (!me) return null;
        const { getDb } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) return null;
        const res: any = await db.execute(sql`
          SELECT p.id, p.name, p.zelloUsername, c.checkinAt
          FROM pda_checkins c INNER JOIN pdas p ON p.id = c.pdaId
          WHERE c.employeeId = ${me.employee.id} AND c.checkin_status = 'checked_in'
          ORDER BY c.checkinAt DESC LIMIT 1`);
        const row = (Array.isArray(res?.[0]) ? res[0] : res)?.[0];
        return row ? { id: Number(row.id), name: String(row.name), zelloUsername: row.zelloUsername ?? null, since: row.checkinAt ? String(row.checkinAt) : null } : null;
      }),
      // "Este browser É o PDA X" — regista o aparelho e devolve o token que o
      // cliente guarda no localStorage. A partir daí, qualquer check-in do
      // PONTO feito neste aparelho liga a pessoa ao PDA/Zello automaticamente.
      registerDevice: protectedProcedure.input(z.object({ pdaId: z.number() })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "edit", { allowOwn: true });
        const { setPdaDeviceToken } = await import("./db");
        const token = await setPdaDeviceToken(input.pdaId);
        if (!token) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        await logActivity({ userId: ctx.user.id, action: "register_device", entity: "pda", entityId: input.pdaId, details: "Browser registado como este PDA" });
        return { token };
      }),
      // ── Fase 2: QR code, ligação no login e libertação no logout ─────────
      // Link do QR a imprimir e colar no PDA.
      qrLink: protectedProcedure.input(z.object({ pdaId: z.number() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "view");
        const { ensurePdaQrCode } = await import("./db");
        const code = await ensurePdaQrCode(input.pdaId);
        if (!code) throw new TRPCError({ code: "NOT_FOUND", message: "PDA não encontrado" });
        return { path: `/pda/registar?pda=${input.pdaId}&c=${code}` };
      }),
      // Ler o QR no próprio aparelho regista-o como este PDA (substitui a
      // escolha na lista). Só chefias — é uma vez por aparelho.
      registerByQr: protectedProcedure.input(z.object({ pdaId: z.number(), code: z.string().min(8).max(64) })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "edit", { allowOwn: true });
        const { verifyPdaQrCode, setPdaDeviceToken } = await import("./db");
        const pda = await verifyPdaQrCode(input.pdaId, input.code);
        if (!pda) throw new TRPCError({ code: "BAD_REQUEST", message: "QR inválido ou PDA inativo." });
        const token = await setPdaDeviceToken(input.pdaId);
        if (!token) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        await logActivity({ userId: ctx.user.id, action: "register_device", entity: "pda", entityId: input.pdaId, details: `Aparelho registado por QR como ${pda.name}` });
        return { token, name: pda.name };
      }),
      // Login num PDA registado → o PDA (e o Zello) fica com esta pessoa até
      // sair ou entrar outra (PDAs partilhados entre turnos).
      claimOnLogin: protectedProcedure.input(z.object({ token: z.string().min(8) })).mutation(async ({ ctx, input }) => {
        const me = await getEmployeeByUserId(ctx.user.id);
        if (!me) return { attached: false as const, reason: "sem ficha" };
        const { attachPdaByDeviceToken } = await import("./db");
        const att = await attachPdaByDeviceToken(input.token, me.employee.id);
        if (!att) return { attached: false as const, reason: "aparelho não registado" };
        if (att.changed) {
          await logActivity({ userId: ctx.user.id, action: "create", entity: "pda_checkin", entityId: att.pdaId, details: `Auto: login→PDA ${att.pdaName}${att.replacedName ? ` (substituiu ${att.replacedName})` : ""}` });
        }
        return { attached: true as const, changed: att.changed, pdaName: att.pdaName, zelloUsername: att.zelloUsername, replacedName: att.replacedName };
      }),
      releaseOnLogout: protectedProcedure.input(z.object({ token: z.string().min(8) })).mutation(async ({ ctx, input }) => {
        const me = await getEmployeeByUserId(ctx.user.id);
        if (!me) return { released: 0 };
        const { releasePdaByDeviceToken } = await import("./db");
        const released = await releasePdaByDeviceToken(input.token, me.employee.id);
        if (released) await logActivity({ userId: ctx.user.id, action: "update", entity: "pda_checkin", details: "Auto: logout soltou o PDA" });
        return { released };
      }),
      // Info do aparelho atual (cartão "Este aparelho" na aba PDAs) — qualquer
      // role autenticada pode consultar: os condutores precisam de ver em que
      // PDA estão a picar o ponto.
      deviceInfo: protectedProcedure.input(z.object({ token: z.string().min(8) })).query(async ({ ctx, input }) => {
        const { getPdaByDeviceToken } = await import("./db");
        return getPdaByDeviceToken(input.token);
      }),
      get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "view");
        return getPdaById(input.id);
      }),
      create: protectedProcedure.input(z.object({
        name: z.string().min(1),
        phoneNumber: z.string().optional(),
        imei: z.string().optional(),
        model: z.string().optional(),
        zelloUsername: z.string().optional(),
        status: z.enum(["active", "inactive", "maintenance", "lost"]).optional(),
        photoUrl: z.string().optional(),
        simDataPlan: z.string().optional(),
        notes: z.string().optional(),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "edit");
        const id = await createPda({
          name: input.name,
          phoneNumber: input.phoneNumber ?? null,
          imei: input.imei ?? null,
          model: input.model ?? null,
          zelloUsername: input.zelloUsername ?? null,
          status: input.status ?? "active",
          photoUrl: input.photoUrl ?? null,
          simDataPlan: input.simDataPlan ?? null,
          notes: input.notes ?? null,
        });
        await logActivity({ userId: ctx.user.id, action: "create", entity: "pda", entityId: id, details: `PDA ${input.name}` });
        return { id };
      }),
      update: protectedProcedure.input(z.object({
        id: z.number(),
        data: z.object({
          name: z.string().optional(),
          phoneNumber: z.string().nullable().optional(),
          imei: z.string().nullable().optional(),
          model: z.string().nullable().optional(),
          zelloUsername: z.string().nullable().optional(),
          status: z.enum(["active", "inactive", "maintenance", "lost"]).optional(),
          photoUrl: z.string().nullable().optional(),
          simDataPlan: z.string().nullable().optional(),
          notes: z.string().nullable().optional(),
        }),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "edit");
        await updatePda(input.id, input.data);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "pda", entityId: input.id, details: "PDA atualizado" });
        return { success: true };
      }),
      delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "manage");
        await deletePda(input.id);
        await logActivity({ userId: ctx.user.id, action: "delete", entity: "pda", entityId: input.id, details: "PDA eliminado" });
        return { success: true };
      }),
      // Check-ins
      checkins: router({
        active: protectedProcedure.query(async ({ ctx }) => {
          requireAccess(ctx.user, "pdas", "view");
          return getActiveCheckins();
        }),
        byDate: protectedProcedure.input(z.object({ date: z.string() })).query(async ({ ctx, input }) => {
          requireAccess(ctx.user, "pdas", "view");
          return getCheckinsByDate(input.date);
        }),
        byPda: protectedProcedure.input(z.object({ pdaId: z.number(), limit: z.number().optional() })).query(async ({ ctx, input }) => {
          requireAccess(ctx.user, "pdas", "view");
          return getCheckinsByPda(input.pdaId, input.limit);
        }),
        checkin: protectedProcedure.input(z.object({
          pdaId: z.number(),
          // Funcionário OBRIGATÓRIO: sem pessoa não há check-in — é o que
          // permite ao histórico de atividade mostrar QUEM usou o Zello/PDA
          // naquele dia em vez do nome cru do Zello ("Faro 411").
          employeeId: z.number({ error: "Escolhe o funcionário — o check-in tem de ficar associado a uma pessoa" }),
          zelloUsername: z.string().optional(),
          // Foto do PDA OBRIGATÓRIA (Jorge, 2026-09-09): é a prova do estado do
          // aparelho à entrada. A UI só ativa o botão com foto carregada; isto é
          // a garantia do lado do servidor.
          photoEntryUrl: z.string().trim().min(1, { error: "Tira a foto do PDA — o check-in precisa da foto de entrada" }),
          mobileDataMbStart: z.number().optional(),
          notes: z.string().optional(),
        })).mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "pdas", "edit");
          const id = await createPdaCheckin({
            pdaId: input.pdaId,
            employeeId: input.employeeId,
            zelloUsername: input.zelloUsername ?? null,
            teamLeaderId: ctx.user.id,
            photoEntryUrl: input.photoEntryUrl,
            mobileDataMbStart: input.mobileDataMbStart ?? null,
            notes: input.notes ?? null,
          });
          // NOTA (regra do Jorge 2026-08-06): já NÃO se anexa o Zello à ficha
          // aqui — os utilizadores Zello dos PDAs mudam de mãos todos os dias,
          // e a resolução Zello→pessoa passou a ser dinâmica pelo check-in do
          // PDA (getZelloLiveMappings / resolveZelloUsernameForShift). A
          // ligação fixa na ficha fica só para telemóveis pessoais.
          await logActivity({ userId: ctx.user.id, action: "create", entity: "pda_checkin", entityId: id, details: `Check-in PDA #${input.pdaId}` });
          return { id };
        }),
        checkout: protectedProcedure.input(z.object({
          id: z.number(),
          photoExitUrl: z.string().optional(),
          mobileDataMbEnd: z.number().optional(),
          notes: z.string().optional(),
        })).mutation(async ({ ctx, input }) => {
          requireAccess(ctx.user, "pdas", "edit");
          await checkoutPda(input.id, {
            photoExitUrl: input.photoExitUrl,
            mobileDataMbEnd: input.mobileDataMbEnd,
            notes: input.notes,
          });
          await logActivity({ userId: ctx.user.id, action: "update", entity: "pda_checkin", entityId: input.id, details: "Check-out PDA" });
          return { success: true };
        }),
      }),
    }),

    // ─── GPS ALERTS ──────────────────────────────────────────────────────
    gpsAlerts: router({
      list: protectedProcedure.input(z.object({
        limit: z.number().optional(),
        unacknowledgedOnly: z.boolean().optional(),
      }).optional()).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getGpsAlerts(input ?? {});
      }),
      stats: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getGpsAlertStats();
      }),
      acknowledge: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "edit");
        await acknowledgeGpsAlert(input.id, ctx.user.id);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "gps_alert", entityId: input.id, details: "Alerta GPS reconhecido" });
        return { success: true };
      }),
      /** Check all users and create alerts for disabled GPS/Zello */
      checkNow: protectedProcedure.mutation(async ({ ctx }) => {
        requireAccess(ctx.user, "atividade_diaria", "edit");
        const users = await getZelloUsers();
        let alertsCreated = 0;
        for (const user of users) {
          if (user.admin) continue; // skip admins
          if (user.geotrackingOff) {
            await createGpsAlert({
              zelloUsername: user.name,
              displayName: user.fullName || user.name,
              alertType: "gps_off",
              message: `${user.fullName || user.name} tem o GPS desligado no Zello`,
              notificationSent: 1,
              occurredAt: new Date().toISOString().slice(0, 19).replace("T", " "),
            });
            alertsCreated++;
            await notifyOwner({
              title: "\u26a0\ufe0f GPS Desligado",
              content: `${user.fullName || user.name} (${user.name}) tem o GPS desligado no Zello`,
            });
          }
        }
        // Also check for users with very low battery
        try {
          const locations = await getZelloLocations();
          for (const loc of locations) {
            if (loc.batteryLevel > 0 && loc.batteryLevel < 15) {
              await createGpsAlert({
                zelloUsername: loc.username,
                displayName: loc.displayName || loc.username,
                alertType: "battery_low",
                message: `${loc.displayName || loc.username} com bateria a ${loc.batteryLevel}%`,
                latitude: String(loc.latitude),
                longitude: String(loc.longitude),
                batteryLevel: loc.batteryLevel,
                notificationSent: 1,
                occurredAt: new Date().toISOString().slice(0, 19).replace("T", " "),
              });
              alertsCreated++;
            }
          }
        } catch (e) {
          // Locations may fail if no users are online
        }
        return { success: true, alertsCreated };
      }),
    }),
  }),

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
    fetchBookingDetails: protectedProcedure
      .input(z.object({ externalId: z.string() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reclamacoes", "edit");
        const { getBooking } = await import("./multipark");
        try {
          return await getBooking(input.externalId);
        } catch {
          return null;
        }
      }),
    list: protectedProcedure.input(z.object({
      status: z.string().optional(),
      type: z.string().optional(),
      vehicleId: z.number().optional(),
      assignedToId: z.number().optional(),
      projectId: z.number().optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view", { allowOwn: true });
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
      const emailAttachments = await listComplaintEmailAttachments(input.id).catch(() => []);
      return { complaint, messages, photos, emailAttachments };
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
        projectId: input.projectId ?? null,
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
    detachDriver: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reclamacoes", "edit");
        const { detachComplaintDriver } = await import("./complaintsExtended");
        await detachComplaintDriver(input.id);
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
        const r = await sendComplaintEmailToClient(input);
        if (r.ok) {
          // Responder ao cliente → reclamação passa a "aguarda cliente".
          await updateComplaint(input.complaintId, { complaintStatus: "waiting_client" } as any);
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
      if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate) : null;
      // slaHours: 0 limpa o prazo, > 0 redefine. Antes 0 era ignorado.
      if (slaHours !== undefined) {
        updateData.slaDeadline = slaHours > 0
          ? new Date(Date.now() + slaHours * 3600000)
          : null;
      }
      if (status) {
        const cur = await getComplaintById(id);
        if (cur?.complaintStatus === "converted") throw new TRPCError({ code: "BAD_REQUEST", message: `Reclamação convertida (${cur.convertedToType} #${cur.convertedToId}) — trata-a no registo novo.` });
      }
      if (status === "resolved") updateData.resolvedAt = new Date();
      // Auditoria de fecho: quem fechou e quando (em resolved/closed).
      if (status === "resolved" || status === "closed") {
        const existing = await getComplaintById(id);
        if (existing && existing.complaintStatus !== "resolved" && existing.complaintStatus !== "closed") {
          updateData.closedById = ctx.user.id;
          updateData.closedAt = new Date();
        }
      }
      await updateComplaint(id, updateData);
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
    delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "manage");
      await deleteComplaint(input.id);
      await logActivity({ userId: ctx.user.id, action: "delete", entity: "complaint", entityId: input.id, details: "Reclamação eliminada" });
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
      const buffer = Buffer.from(input.base64, "base64");
      const ext = input.filename.split(".").pop() || "jpg";
      const key = `complaints/${input.complaintId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { url } = await storagePut(key, buffer, `image/${ext}`);
      const id = await addComplaintPhoto({
        complaintId: input.complaintId,
        url,
        fileKey: key,
        label: input.label ?? null,
        uploadedById: ctx.user.id,
      });
      return { id, url };
    }),
    deletePhoto: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "edit");
      await deleteComplaintPhoto(input.id);
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
    // Booking timeline — BD local primeiro (o fetch live usava a chave GLOBAL
    // e falhava em parques com chave própria); on-demand fetch na 1ª abertura.
    bookingTimeline: protectedProcedure.input(z.object({
      bookingId: z.string(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view");
      const { getComplaintBookingDossier } = await import("./complaintDossier");
      const d = await getComplaintBookingDossier(input.bookingId);
      if (d.history.length) {
        return {
          bookingId: input.bookingId,
          total: d.history.length,
          history: d.history.map((h) => ({
            id: h.historyId,
            changeType: h.changeType,
            actionTime: h.actionTime,
            remarks: h.remarks,
            agentName: h.agentName,
            userId: h.agentUserId,
            modifiedFields: h.modifiedFields,
            platform: h.platform,
          })),
        };
      }
      // Fallback: API live (reserva ainda não sincronizada localmente)
      try {
        return await getBookingHistory(input.bookingId);
      } catch {
        return { bookingId: input.bookingId, total: 0, history: [] };
      }
    }),

    // Dossier completo da reserva ligada: detalhe + extras + histórico de
    // condutores (BD local, fetch on-demand). Alimenta o card "Reserva" do
    // detalhe da reclamação sem passos manuais.
    bookingDossier: protectedProcedure.input(z.object({
      reservationRef: z.string().min(1),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "view");
      const { getComplaintBookingDossier } = await import("./complaintDossier");
      return getComplaintBookingDossier(input.reservationRef);
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

    // Botão "Atualizar da API": puxa a reserva completa + histórico direto da
    // API Multipark e grava na BD local (para reservas antigas/histórico só
    // com a criação).
    refreshBookingData: protectedProcedure.input(z.object({
      reservationRef: z.string().min(1),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reclamacoes", "edit");
      const { refreshBookingFromApi } = await import("./complaintDossier");
      return refreshBookingFromApi(input.reservationRef);
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
      .input(z.object({ unreadOnly: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { listNotifications } = await import("./complaintsExtended");
        return listNotifications(ctx.user.id, input?.unreadOnly ?? false, input?.limit ?? 50);
      }),
    unreadCount: protectedProcedure.query(async ({ ctx }) => {
      const { unreadCount } = await import("./complaintsExtended");
      return { count: await unreadCount(ctx.user.id) };
    }),
    markRead: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const { markNotificationRead } = await import("./complaintsExtended");
        await markNotificationRead(ctx.user.id, input.id);
        return { success: true };
      }),
    markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
      const { markAllNotificationsRead } = await import("./complaintsExtended");
      await markAllNotificationsRead(ctx.user.id);
      return { success: true };
    }),
    // Preferências da própria pessoa (Perfil): tipos silenciados.
    prefs: protectedProcedure.query(async ({ ctx }) => {
      const { getNotificationPrefsRaw } = await import("./appSettings");
      const { parseNotificationPrefs } = await import("../shared/appSettings");
      return parseNotificationPrefs(await getNotificationPrefsRaw(ctx.user.id));
    }),
    savePrefs: protectedProcedure
      .input(z.object({ muted: z.array(z.string().max(32)).max(50) }))
      .mutation(async ({ ctx, input }) => {
        const { saveNotificationPrefs } = await import("./appSettings");
        const { parseNotificationPrefs } = await import("../shared/appSettings");
        const prefs = parseNotificationPrefs(input);
        await saveNotificationPrefs(ctx.user.id, prefs);
        return prefs;
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
      // Leitor IMAP nativo (substitui o antigo fluxo Make.com 2x/dia).
      const { runEmailInboundSync } = await import("./jobs/emailInboundSync");
      const r = await runEmailInboundSync({ deadlineAt: Date.now() + 45_000 });
      return {
        reviewsImported: r.byAlias["criticas"] || 0,
        reviewsSkipped: r.skipped,
        incidentsImported: 0,
        incidentsSkipped: 0,
        message: r.configured
          ? `Sincronizado: ${r.created} novos registos, ${r.skipped} ignorados.${r.partial ? " Parcial — carregue outra vez para continuar." : ""}`
          : "IMAP n\u00e3o configurado no servidor.",
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
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view", { allowOwn: true });
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
      const admins = await getSuperAdmins();
      if (admins.length > 0) {
        await notifyOwner({ title: "Novo Perdido", content: `${input.clientName}: ${input.description.slice(0, 300)} (Viatura: ${input.vehiclePlate || "N/A"})` });
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
      if (dueDate !== undefined) data.dueDate = dueDate ? dueDate.slice(0, 19).replace("T", " ") : null;
      if (status && existing.status === "converted") throw new TRPCError({ code: "BAD_REQUEST", message: `Caso convertido (${existing.convertedToType} #${existing.convertedToId}) — trata-o no registo novo.` });
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
      await loadLostInScope(input.itemId);
      const buffer = Buffer.from(input.base64, "base64");
      const key = `lost-found/${input.itemId}/return-${Date.now()}.${safeExt(input.filename)}`;
      const { url } = await storagePut(key, buffer, contentTypeForFilename(input.filename));
      await updateLostFoundItem(input.itemId, { returnPhotoUrl: url, returnPhotoKey: key } as any);
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
      const { sendEmail } = await import("./_core/notification");
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
      if (!ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Falha ao enviar email (SMTP)" });
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

    delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "super_admin");
      await loadLostInScope(input.id);
      await deleteLostFoundItem(input.id);
      await logActivity({ userId: ctx.user.id, action: "delete", entity: "lost_found", entityId: input.id, details: "Eliminado (com ficheiros e condutores)" });
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
      const { attachLostFoundDriver } = await import("./db");
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
      const { detachLostFoundDriver } = await import("./db");
      await detachLostFoundDriver(input.id);
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
          return await reviewLostDriverPoints(input.linkId, input.decision, ctx.user.id);
        } catch (e: any) {
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

    // ── Booking History (Multipark DB local, sincronizado pelo cron job) ──
    bookingHistory: protectedProcedure
      .input(z.object({ bookingId: z.string().optional(), plate: z.string().optional(), search: z.string().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "perdidos", "view");
        if (input.bookingId) return getBookingHistoryByBookingId(input.bookingId);
        if (input.plate) return getBookingHistoryByPlate(input.plate);
        if (input.search) return searchBookingHistory(input.search);
        return [];
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
        const { getDb } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const { lisbonDayRangeUtc } = await import("../shared/lisbonDay");
        const db = await getDb();
        if (!db) return [];
        const { start, end } = lisbonDayRangeUtc(input.from, input.to);
        const rows = (r: any) => (Array.isArray(r[0]) ? r[0] : r) as any[];
        const acts = rows(await db.execute(sql`
          SELECT h.agentName, COUNT(*) AS total
          FROM multipark_booking_history h
          WHERE h.agentName IS NOT NULL AND h.agentName <> ''
            AND h.actionTime >= ${start} AND h.actionTime < ${end}
            AND ${bookingHistoryScope(sql`h.bookingExternalId`)}
          GROUP BY h.agentName ORDER BY total DESC`));
        return acts.map((a: any) => ({ agentName: a.agentName as string, total: Number(a.total) }));
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

    // Booking timeline — BD local primeiro; on-demand fetch na 1ª abertura.
    // Só reservas das cidades do utilizador.
    bookingTimeline: protectedProcedure.input(z.object({
      bookingId: z.string().max(128),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view");
      if (!(await bookingRefInScope(input.bookingId))) return { bookingId: input.bookingId, total: 0, history: [] };
      const { getComplaintBookingDossier } = await import("./complaintDossier");
      const d = await getComplaintBookingDossier(input.bookingId);
      if (d.history.length) {
        return {
          bookingId: input.bookingId,
          total: d.history.length,
          history: d.history.map((h) => ({
            id: h.historyId,
            changeType: h.changeType,
            actionTime: h.actionTime,
            remarks: h.remarks,
            agentName: h.agentName,
            userId: h.agentUserId,
            modifiedFields: h.modifiedFields,
            platform: h.platform,
          })),
        };
      }
      try {
        return await getBookingHistory(input.bookingId);
      } catch {
        return { bookingId: input.bookingId, total: 0, history: [] };
      }
    }),

    // Dossier completo da reserva ligada (mesma peça das Reclamações).
    bookingDossier: protectedProcedure.input(z.object({
      reservationRef: z.string().min(1).max(128),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "view");
      if (!(await bookingRefInScope(input.reservationRef))) throw new TRPCError({ code: "FORBIDDEN", message: "Reserva fora das tuas cidades." });
      const { getComplaintBookingDossier } = await import("./complaintDossier");
      return getComplaintBookingDossier(input.reservationRef);
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

    // Botão "Atualizar da API": puxa a reserva completa + histórico direto da
    // API Multipark e grava na BD local.
    refreshBookingData: protectedProcedure.input(z.object({
      reservationRef: z.string().min(1).max(128),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "perdidos", "edit");
      if (!(await bookingRefInScope(input.reservationRef))) throw new TRPCError({ code: "FORBIDDEN", message: "Reserva fora das tuas cidades." });
      const { refreshBookingFromApi } = await import("./complaintDossier");
      return refreshBookingFromApi(input.reservationRef);
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
      const id = await createIncident({
        ...rest,
        projectId: input.projectId ?? booking?.projectId ?? defaultScopedProjectId(),
        reservationLink: booking?.externalId ?? (bookingRef?.trim() || undefined),
        costAmount: costAmount != null ? String(costAmount) : undefined,
        reportedBy: ctx.user.id,
        status: "open",
        // Quem cria com condutor já é team leader+ → envolvimento confirmado.
        ...(input.employeeId ? { driverConfirmed: 1, driverConfirmedById: ctx.user.id, driverConfirmedAt: utcNowStr() } : {}),
      });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "incident", entityId: id || 0, details: `Ocorrência: ${input.description.slice(0, 200)}` });
      if (input.severity === "critical") {
        await notifyOwner({ title: "Ocorrência Crítica", content: `${input.incidentType}: ${input.description.slice(0, 300)} (Viatura: ${input.vehiclePlate || "N/A"})` });
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

    // Reserva relacionada com a ocorrência (pela ref ligada ou pela matrícula,
    // ancorada na data da ocorrência).
    bookingPeek: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "ocorrencias", "view");
      const inc = await loadIncidentInScope(input.id);
      if (!inc.vehiclePlate && !inc.reservationLink) return null;
      const { matchBookingForComplaint } = await import("./complaintDossier");
      const match = await matchBookingForComplaint({
        reservationRef: inc.reservationLink && /^[A-Za-z0-9_-]{4,128}$/.test(inc.reservationLink) ? inc.reservationLink : undefined,
        vehiclePlate: inc.vehiclePlate ?? undefined,
        anchorDate: inc.sourceEmailDate ?? inc.createdAt,
      });
      if (!match) return null;
      const b = match.booking;
      if (!(await bookingRefInScope(b.externalId))) return null;
      return {
        matchedBy: match.matchedBy,
        externalId: b.externalId,
        bookingNumber: b.bookingNumber,
        status: b.status,
        parkName: b.parkName,
        city: b.city,
        projectId: b.projectId,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        clientName: `${b.clientFirstName ?? ""} ${b.clientLastName ?? ""}`.trim() || null,
        clientEmail: b.clientEmail,
        clientPhone: b.clientPhone,
        totalPrice: b.totalPrice,
      };
    }),

    // Sincroniza ocorrências a partir do multipark_booking_history (remarks
    // dos agentes nos check-in/out/movements). Dedup por sourceEmailId e por
    // matrícula+reserva±2h (vira nota na ocorrência existente).
    syncFromMultipark: protectedProcedure
      .input(z.object({ lookbackDays: z.number().int().min(1).max(180).optional() }).optional())
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "ocorrencias", "edit");
        const { syncIncidentsFromMultiparkHistory } = await import("./db");
        const r = await syncIncidentsFromMultiparkHistory({
          lookbackDays: input?.lookbackDays ?? 30,
          reportedById: ctx.user.id,
        });
        await logActivity({
          userId: ctx.user.id, action: "sync", entity: "incident", entityId: 0,
          details: `Multipark sync: ${r.imported} importadas, ${r.skipped} já existiam/duplicadas, ${r.scanned} analisadas`,
        });
        return r;
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

    generate: protectedProcedure.input(z.object({
      weekNumber: z.number(),
      yearNumber: z.number(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "avaliacao", "edit");
      const results = await generateWeeklyEvaluation(input.weekNumber, input.yearNumber);
      await logActivity({ userId: ctx.user.id, action: "generate", entity: "performance_evaluation", details: `Semana ${input.weekNumber}/${input.yearNumber}: ${results.length} linhas` });
      return results;
    }),

    update: protectedProcedure.input(z.object({
      id: z.number(),
      positivePoints: z.number().optional(),
      negativePoints: z.number().optional(),
      notes: z.string().nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "avaliacao", "edit");
      const { id, ...data } = input;
      // Lê o valor actual para preservar campos não enviados ao calcular totalPoints
      const current = await getPerformanceEvaluations({});
      const row = current.find((r: any) => r.id === id);
      const pos = data.positivePoints ?? row?.positivePoints ?? 0;
      const neg = data.negativePoints ?? row?.negativePoints ?? 0;
      (data as any).totalPoints = pos - neg;
      await updatePerformanceEvaluation(id, data);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "performance_evaluation", entityId: id });
      return { success: true };
    }),

    delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "avaliacao", "edit");
      await deletePerformanceEvaluation(input.id);
      return { success: true };
    }),
  }),

  // ─── SERVIÇOS ────────────────────────────────────────────────────────────
  services: router({
    // (O antigo CRUD de serviços internos — list/create/update/delete/stats
    //  sobre a tabela `services` — foi removido a 2026-08-06: nunca teve UI.
    //  Os serviços reais vêm das reservas Multipark, abaixo.)

    // Dá baixa / reabre um serviço na app. O sync preserva o done local
    // (upsertBookingExtras faz OR com o que a API mandar).
    setExtraDone: protectedProcedure.input(z.object({
      id: z.number(),
      done: z.boolean(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "servicos", "edit");
      const { getDb } = await import("./db");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
      const { multiparkBookingExtras, multiparkBookings } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const { projectScope, scopedProjectIds } = await import("./cityScope");
      if (scopedProjectIds() !== undefined) {
        // Só serviços de reservas da(s) cidade(s) do utilizador
        const own = await db.select({ id: multiparkBookingExtras.id }).from(multiparkBookingExtras)
          .innerJoin(multiparkBookings, eq(multiparkBookings.externalId, multiparkBookingExtras.bookingExternalId))
          .where(and(eq(multiparkBookingExtras.id, input.id), projectScope(multiparkBookings.projectId))).limit(1);
        if (!own.length) throw new TRPCError({ code: "FORBIDDEN", message: "Este serviço pertence a outra cidade." });
      }
      await db.update(multiparkBookingExtras).set({ done: input.done ? 1 : 0 }).where(eq(multiparkBookingExtras.id, input.id));
      await logActivity({ userId: ctx.user.id, action: input.done ? "complete" : "reopen", entity: "booking_extra", entityId: input.id });
      return { success: true };
    }),

    // Serviços extra das reservas — FONTE: BD local (multipark_booking_extras,
    // sincronizada do /report a cada 15min). FIX 2026-08-06: antes chamava a
    // API ao vivo com UMA chave (= só um parque, lento, incompleto) e mostrava
    // a ALOCAÇÃO como matrícula. Agora: todos os parques, instantâneo,
    // matrícula/cliente reais via join à reserva.
    multiparkExtras: protectedProcedure.input(z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      // Âmbito de cidade como as outras consultas de reservas (scopeCityQuery
      // preenche a cidade do utilizador; projectScope garante-a no SQL)
      projectId: z.number().optional(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "servicos", "view");
      const { getDb } = await import("./db");
      const db = await getDb();
      if (!db) return { total: 0, services: [] };
      const { multiparkBookingExtras, multiparkBookings } = await import("../drizzle/schema");
      const { and, gte, lt, eq, sql, inArray } = await import("drizzle-orm");
      const { projectScope } = await import("./cityScope");
      const { lisbonDayRangeUtc } = await import("../shared/lisbonDay");
      const { resolveProjectIds } = await import("./db");
      const range = lisbonDayRangeUtc(input.startDate, input.endDate);
      const projectIds = input.projectId ? await resolveProjectIds(input.projectId) : null;
      const rows = await db
        .select({
          id: multiparkBookingExtras.id,
          bookingId: multiparkBookingExtras.bookingExternalId,
          bookingNumber: multiparkBookings.bookingNumber,
          licensePlate: multiparkBookings.licensePlate,
          clientFirstName: multiparkBookings.clientFirstName,
          clientLastName: multiparkBookings.clientLastName,
          parkName: multiparkBookings.parkName,
          city: multiparkBookings.city,
          checkOut: multiparkBookings.checkOut,
          bookingStatus: multiparkBookings.status,
          serviceName: multiparkBookingExtras.name,
          price: multiparkBookingExtras.price,
          done: multiparkBookingExtras.done,
        })
        .from(multiparkBookingExtras)
        .innerJoin(multiparkBookings, eq(multiparkBookings.externalId, multiparkBookingExtras.bookingExternalId))
        .where(and(
          // Dias de Lisboa → intervalo UTC [início, fim)
          gte(multiparkBookings.checkOut, range.start),
          lt(multiparkBookings.checkOut, range.end),
          sql`${multiparkBookings.status} != 'CANCELLED'`,
          projectScope(multiparkBookings.projectId),
          projectIds ? (projectIds.length ? inArray(multiparkBookings.projectId, projectIds) : sql`1 = 0`) : sql`1 = 1`,
        ))
        .limit(5000);
      const services = rows.map((r) => ({
        id: r.id,
        bookingId: r.bookingId,
        bookingNumber: r.bookingNumber,
        licensePlate: r.licensePlate ?? "",
        clientName: `${r.clientFirstName ?? ""} ${r.clientLastName ?? ""}`.trim(),
        parkName: r.city && r.parkName && !r.parkName.includes(r.city) ? `${r.parkName} ${r.city}` : (r.parkName ?? ""),
        checkOut: r.checkOut ?? "",
        serviceName: r.serviceName ?? "?",
        price: Number(r.price ?? 0),
        done: Boolean(r.done),
      }));
      return { total: services.length, services };
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
      const result = await saveShiftHandover({ handoverDate, shift, city }, {
        ...values,
        // Linhas repetidas (mesmo tipo+tamanho) somam-se antes de gravar.
        clothingItems: values.clothingItems == null ? values.clothingItems : normalizeClothingItems(values.clothingItems),
        // Quem resolve e quando (o formulário só manda o visto).
        openItems: values.openItems == null ? values.openItems : values.openItems.map((i) => (i.resolved && !i.resolvedAt
          ? { ...i, resolvedAt: new Date().toISOString(), resolvedByName: i.resolvedByName ?? ctx.user.name ?? null }
          : i)),
      }, {
        expectedVersion,
        userId: ctx.user.id,
        userName: ctx.user.name ?? null,
        // Passadas 24h desde a criação só supervisor+ edita.
        canEditOld: (ROLE_HIERARCHY[ctx.user.role] ?? -1) >= ROLE_HIERARCHY["supervisor"],
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
      await saveHandoverAiSummary({ handoverDate: input.date, shift: input.shift, city: input.city }, text);
      return { aiSummary: text };
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
      const id = await createPartnership({ ...rest, name, partnerNif: nif, ...(configured ? { configuredAt: new Date().toISOString().slice(0, 19).replace("T", " ") } : {}) });
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
      await updatePartnership(id, { ...rest, ...(nif !== undefined ? { partnerNif: nif } : {}), configuredAt: new Date().toISOString().slice(0, 19).replace("T", " ") });
      await logActivity({ userId: ctx.user.id, action: "update", entity: "partnership", entityId: id });
      return { success: true };
    }),

    delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "parcerias", "manage");
      await deletePartnership(input.id);
      await logActivity({ userId: ctx.user.id, action: "delete", entity: "partnership", entityId: input.id });
      return { success: true };
    }),

    // ── Inferência de parceiros a partir das reservas Multipark ──────────────
    inferList: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "parcerias", "manage");
      return inferPartnersFromBookings();
    }),

    addAlias: protectedProcedure
      .input(z.object({
        partnershipId: z.number(),
        aliasType: z.enum(["multipark_partner_id", "payment_method"]),
        aliasValue: z.string().min(1).max(128),
        applyToBookings: z.boolean().default(true),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "parcerias", "manage");
        const updated = await addPartnerAlias(
          input.partnershipId,
          input.aliasType,
          input.aliasValue,
          input.applyToBookings,
        );
        await logActivity({
          userId: ctx.user.id,
          action: "alias_add",
          entity: "partnership",
          entityId: input.partnershipId,
          details: `${input.aliasType}=${input.aliasValue} (${updated} reservas actualizadas)`,
        });
        return { updated };
      }),

    // Aliases agregados por parceiro — mostra quantos códigos cada parceiro
    // já tem associados (cada parceiro tem normalmente 1 código por
    // cidade × marca, logo vários).
    aliasCounts: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "parcerias", "view");
      const { aliasCountsByPartner } = await import("./db");
      return aliasCountsByPartner();
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

    // Sincroniza parceiros a partir dos dados EXPLÍCITOS da API: resolve os
    // partnerIds mascarados (nome real via detalhe), cria empresas Pro das
    // campanhas "Pro <empresa>" e normaliza tipos legados. Substitui a
    // inferência por heurísticas. Idempotente.
    syncFromApi: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "parcerias", "manage");
      const { syncPartnersFromApi } = await import("./partnerSync");
      const r = await syncPartnersFromApi();
      await logActivity({
        userId: ctx.user.id, action: "sync", entity: "partnership", entityId: 0,
        details: `Parceiros da API: ${r.created} criados, ${r.linkedToExisting} ligados, ${r.proCreated} Pro criados, ${r.unresolved.length} por resolver`,
      });
      return r;
    }),
  }),

  // ─── ANUAL ───────────────────────────────────────────────────────────────
  annual: router({
    list: protectedProcedure.input(z.object({
      year: z.number().optional(),
      projectId: z.number().optional(),
    }).optional()).query(async ({ ctx, input }) => {
      await requireFinanceTotals(ctx.user, "anual", "view");
      return getAnnualReports(input);
    }),

    breakdown: protectedProcedure.input(z.object({
      year: z.number(),
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

    generate: protectedProcedure.input(z.object({
      year: z.number(),
      projectId: z.number().optional(),
      splitPartner: z.number().min(0).max(100).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "anual", "manage");
      const results = await generateAnnualSummary(input.year, input.projectId, input.splitPartner ?? 60);
      await logActivity({ userId: ctx.user.id, action: "generate", entity: "annual_report", details: `Relatório anual ${input.year}` });
      return results;
    }),

    update: protectedProcedure.input(z.object({
      id: z.number(),
      totalRevenue: z.number().optional(),
      totalExpenses: z.number().optional(),
      partnerShare: z.number().optional(),
      companyShare: z.number().optional(),
      splitRatio: z.string().optional(),
      notes: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "anual", "manage");
      const { id, ...data } = input;
      await updateAnnualReport(id, data);
      return { success: true };
    }),

    delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "anual", "manage");
      await deleteAnnualReport(input.id);
      return { success: true };
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
    // Detalhe de uma reserva específica via API Multipark
    fetchBookingDetails: protectedProcedure
      .input(z.object({ externalId: z.string() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        const { getBooking } = await import("./multipark");
        try {
          return await getBooking(input.externalId);
        } catch {
          return null;
        }
      }),

    // Teste por parque: report mínimo (1 dia, 1 ação) com cada chave. Pedido
    // à API por parque — a UI só o chama quando alguém carrega no botão.
    testConnection: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "sincronizacao", "manage");
      return mpTestConnection();
    }),

    // Inspect raw booking JSON from API (tries all parks). Admin-only debug tool.
    inspectBooking: protectedProcedure
      .input(z.object({ externalId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "sincronizacao", "manage");
        const found = await getBookingTryAllParks(input.externalId);
        if (!found) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Reserva não encontrada em nenhum parque (ou chaves de API em falta).",
          });
        }
        return {
          park: `${found.parkConfig.name} (${found.parkConfig.city})`,
          parkId: found.parkConfig.id,
          booking: found.booking,
        };
      }),

    // Check availability
    checkAvailability: protectedProcedure
      .input(z.object({
        checkIn: z.string(),
        checkOut: z.string(),
        vehicleType: z.enum(["MOTORCYCLE", "CAR", "VAN", "TRUCK"]).default("CAR"),
        parkingType: z.enum(["COVERED", "UNCOVERED", "INDOOR", "VIP"]).default("COVERED"),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        return mpCheckAvailability(
          input.checkIn,
          input.checkOut,
          input.vehicleType as VehicleType,
          input.parkingType as ParkingType,
        );
      }),

    // List parks
    listParks: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "reservas_operacoes", "view");
      return mpListParks();
    }),

    // Cobertura (chaves por parque) + totais da fila
    syncCoverage: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "sincronizacao", "view");
      const { parkCoverage } = await import("./multipark");
      const { getDeliveryHealth } = await import("./bookingDeliveryQueue");
      return { parks: parkCoverage(), queue: await getDeliveryHealth() };
    }),

    // Saúde dos dados (Sincronização + Definições → Estado do sistema). Só
    // totais e códigos, sem dados de clientes.
    dataHealth: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "sincronizacao", "view");
      const { getSyncHealth } = await import("./syncHealth");
      return getSyncHealth();
    }),

    // Logs da sincronização, filtráveis por tipo. As linhas antigas "api_sync"
    // (antes da 0101 o recente e o futuro gravavam os dois isso) aparecem nos
    // filtros "recente" e "futuro".
    syncLogs: protectedProcedure
      .input(z.object({
        type: z.enum(["all", "recent", "future", "manual"]).default("all"),
        limit: z.number().int().min(1).max(200).default(50),
      }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "sincronizacao", "view");
        const types = {
          all: undefined,
          recent: ["api_sync_recent", "api_sync"],
          future: ["api_sync_future", "api_sync"],
          manual: ["manual", "api_sync_recovery", "excel_import"],
        }[input?.type ?? "all"];
        return getSyncLogs(input?.limit ?? 50, types);
      }),

    // "Reparar período": report de até 3 dias, com prazo (45s) e trinco
    // partilhado com o cron e o MCP. Só âmbito nacional (um supervisor de
    // cidade não lança um sync de todos os parques).
    triggerSync: protectedProcedure
      .input(z.object({
        startDate: z.string(),
        endDate: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireNationalSync(ctx.user);
        const { runRepairSync, REPAIR_MAX_DAYS } = await import("./jobs/multiparkBookingSync");
        {
          const { syncRangeError } = await import("./opsRules");
          const err = syncRangeError(input.startDate, input.endDate, REPAIR_MAX_DAYS);
          if (err) throw new TRPCError({ code: "BAD_REQUEST", message: err });
        }
        try {
          const r = await runRepairSync({ startDate: input.startDate, endDate: input.endDate, triggeredById: ctx.user.id, owner: "manual" });
          if (r.busy) {
            const { SYNC_BUSY_MESSAGE } = await import("./syncLock");
            throw new TRPCError({ code: "CONFLICT", message: SYNC_BUSY_MESSAGE });
          }
          const { enrichTargets: _targets, parkStatus: _status, ...result } = r.result;
          await logActivity({
            userId: ctx.user.id,
            action: "sync",
            entity: "multipark",
            details: `Reparar período ${input.startDate}→${input.endDate}: ${result.processed} processadas, ${result.created} novas, ${result.updated} atualizadas${result.partial ? ` (parcial: ${result.skippedJobs} por fazer)` : ""}`,
          });
          return result;
        } catch (error: any) {
          if (error instanceof TRPCError) throw error;
          console.error("[triggerSync]", deliveryErrorCode(error));
          await createSyncLog({
            syncType: "manual",
            status: "error",
            errorMessage: deliveryErrorCode(error),
            triggeredById: ctx.user.id,
            completedAt: new Date(),
          });
          return { success: false, processed: 0, created: 0, updated: 0, errors: [deliveryErrorCode(error)], partial: false, skippedJobs: 0, parkErrors: [], totalMismatches: [] };
        }
      }),

    // Buscar history de um agente (por nome) num dia (chama /agent/history
    // por cada parque configurado e agrega resultados na DB).
    fetchAgentHistory: protectedProcedure
      .input(z.object({
        agentName: z.string().min(1).max(256),
        date: z.string(), // YYYY-MM-DD
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "sincronizacao", "edit");
        const { fetchAgentHistoryByName } = await import("./jobs/multiparkBookingSync");
        return fetchAgentHistoryByName(input.agentName, input.date);
      }),

    // Avaliação operacional do dia: por extra (com métricas) + agregado
    // por turno + agregado total. TL recebe também score da equipa.
    dayEvaluation: protectedProcedure
      .input(z.object({ date: z.string(), projectId: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "avaliacao_operacional", "view");
        const { evaluateDay } = await import("./multiparkEvaluation");
        return evaluateDay(input.date);
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

    // Lista summary do que está guardado em multipark_booking_history para
    // um agente num dia (após fetchAgentHistory).
    agentHistorySummary: protectedProcedure
      .input(z.object({
        agentName: z.string().min(1).max(256),
        date: z.string(), projectId: z.number().optional(),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "view");
        const { getDb } = await import("./db");
        const db = await getDb(); if (!db) return null;
        const { multiparkBookingHistory } = await import("../drizzle/schema");
        const { sql: dsql, and: dand, eq: deq, gte: dgte, lt: dlt } = await import("drizzle-orm");
        const start = `${input.date} 00:00:00`;
        const end = new Date(input.date + "T00:00:00");
        end.setDate(end.getDate() + 1);
        const endStr = end.toISOString().slice(0, 19).replace("T", " ");
        const rows = await db
          .select()
          .from(multiparkBookingHistory)
          .where(
            dand(
              deq(multiparkBookingHistory.agentName, input.agentName),
              bookingHistoryScope(multiparkBookingHistory.bookingExternalId),
              dgte(multiparkBookingHistory.actionTime, start),
              dlt(multiparkBookingHistory.actionTime, endStr),
            ),
          )
          .orderBy(multiparkBookingHistory.actionTime);
        const byType: Record<string, number> = {};
        for (const r of rows) {
          const k = r.changeType ?? "?";
          byType[k] = (byType[k] ?? 0) + 1;
        }
        return { total: rows.length, byType, items: rows };
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
    bookings: protectedProcedure
      .input(z.object({
        status: z.string().optional(),
        parkingType: z.string().optional(),
        city: z.string().optional(),
        parkName: z.string().optional(),
        projectId: z.number().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        return getMultiparkBookings({
          city: input?.city,
          status: input?.status,
          parkingType: input?.parkingType,
          from: input?.from ? new Date(input.from) : undefined,
          to: input?.to ? new Date(input.to) : undefined,
          search: input?.search,
          limit: input?.limit,
        });
      }),

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

    // Query LOCAL DB by actionType + date range
    localBookingsByAction: protectedProcedure
      .input(z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        actionType: z.enum(["creation", "checkin", "checkout", "cancelation"]),
        projectId: z.number().optional(),
        // Filtros no SERVIDOR (grupo Lisboa/Porto/Faro/Marketplace, canal, estado, pesquisa)
        group: z.enum(["all", "lisboa", "porto", "faro", "marketplace", "sem_cidade"]).optional(),
        channel: z.string().max(32).optional(),
        state: z.enum(["all", "active", "cancelled", "done", "pending"]).optional(),
        search: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(20000).optional(),
        offset: z.number().int().min(0).optional(),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        const { getOperationsBookings, rangeTooLong } = await import("./operationsBookings");
        if (input.endDate < input.startDate || rangeTooLong(input.startDate, input.endDate)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Intervalo inválido (máx. 366 dias)." });
        }
        const r = await getOperationsBookings(input);
        return { ...r, actionType: input.actionType, period: { startDate: input.startDate, endDate: input.endDate } };
      }),

    // Custo dos extras por dia (de Lisboa) × cidade — real (ponto), previsto
    // (escala) e o que conta. Mesma regra do motor financeiro. Só com o gate
    // de totais financeiros; sem ele devolve allowed=false (a UI esconde).
    extrasCostDaily: protectedProcedure
      .input(z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        projectId: z.number().optional(),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "dashboards", "view");
        if (!(await canSeeFinanceTotals(ctx.user))) return { allowed: false as const, today: "", rows: [] };
        const { getExtrasCostDaily, rangeTooLong } = await import("./operationsBookings");
        if (input.endDate < input.startDate || rangeTooLong(input.startDate, input.endDate)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Intervalo inválido (máx. 366 dias)." });
        }
        return { allowed: true as const, ...(await getExtrasCostDaily(input)) };
      }),

    // Gasto em publicidade por dia × cidade (Lisboa/Porto/Faro) + "por atribuir"
    // (sem cidade / nacional), numa só chamada à fonte única do Marketing.
    // Mesmo gate dos totais financeiros.
    adSpendDaily: protectedProcedure
      .input(z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        projectId: z.number().optional(),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "dashboards", "view");
        if (!(await canSeeFinanceTotals(ctx.user))) return { allowed: false as const, cities: [], rows: [], unassigned: [], total: 0 };
        const { getAdSpendDaily, rangeTooLong } = await import("./operationsBookings");
        if (input.endDate < input.startDate || rangeTooLong(input.startDate, input.endDate)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Intervalo inválido (máx. 366 dias)." });
        }
        return { allowed: true as const, ...(await getAdSpendDaily(input)) };
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

    // Agentes do histórico SEM funcionário nem parceiro (aba RH "Agentes")
    unlinkedAgents: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "view");
      const { getDb, listAgentPartners } = await import("./db");
      const db = await getDb();
      if (!db) return [];
      const { sql } = await import("drizzle-orm");
      const [rows] = await db.execute(sql`
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
      const { employees } = await import("../drizzle/schema");
      const { isNotNull } = await import("drizzle-orm");
      const linkedEmps = await db.select({ n: employees.multiparkAgentName, id: employees.multiparkAgentUserId }).from(employees);
      const linked = new Set(linkedEmps.map((e) => (e.n ?? "").trim().toLowerCase()).filter(Boolean));
      // Fase 1: um agente ligado só pelo ID (outro nome na ficha) também está ligado
      const linkedIds = new Set(linkedEmps.map((e) => (e.id ?? "").trim()).filter(Boolean));
      // agentes EXTRA (pessoa com várias contas Multipark) também estão ligados
      const { listAgentAliases } = await import("./employeeAliases");
      for (const a of await listAgentAliases()) {
        linkedIds.add(a.agentUserId);
        if (a.agentName) linked.add(a.agentName.trim().toLowerCase());
      }
      const partners = new Set((await listAgentPartners()).map((p) => p.agentName.trim().toLowerCase()));
      const { listIgnoredAgents } = await import("./db");
      const ignored = new Set((await listIgnoredAgents()).map((n) => n.trim().toLowerCase()));
      return (rows as any[])
        .filter((r) => {
          const key = String(r.agentName).trim().toLowerCase();
          const id = String(r.agentUserId ?? "").trim();
          return !linked.has(key) && !(id && linkedIds.has(id)) && !partners.has(key) && !ignored.has(key);
        })
        .map((r) => ({
          agentName: r.agentName,
          total: Number(r.total),
          checkins: Number(r.checkins ?? 0),
          checkouts: Number(r.checkouts ?? 0),
          movements: Number(r.movements ?? 0),
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen,
        }))
        .sort((a, b) => b.total - a.total);
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
          const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
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
    bookingByExternalId: protectedProcedure
      .input(z.object({ externalId: z.string().min(1).max(128) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        const { getDb } = await import("./db");
        const db = await getDb();
        if (!db) return null;
        const { multiparkBookings } = await import("../drizzle/schema");
        const { and, eq } = await import("drizzle-orm");
        const { projectScope } = await import("./cityScope");
        const rows = await db.select().from(multiparkBookings).where(and(eq(multiparkBookings.externalId, input.externalId), projectScope(multiparkBookings.projectId))).limit(1);
        return rows[0] ?? null;
      }),

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

    // Query API directly by actionType + date range (all parks)
    reportByAction: protectedProcedure
      .input(z.object({
        startDate: z.string(),
        endDate: z.string(),
        actionType: z.enum(["creation", "checkin", "checkout", "cancelation"]),
      }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "reservas_operacoes", "view");
        const results = await getBookingsReportAllParks(
          input.startDate,
          input.endDate,
          input.actionType as BookingActionType,
        );
        // Flatten all bookings from all parks, tag each with park info
        let bookings = results.flatMap(r =>
          r.report.bookings.map(b => ({
            ...b,
            _parkName: r.park.name,
            _parkCity: r.park.city,
            _parkId: r.park.id,
          }))
        );
        // For checkin/checkout, exclude cancelled bookings
        if (input.actionType === "checkin" || input.actionType === "checkout") {
          bookings = bookings.filter((b: any) => b.status !== "CANCELLED");
        }
        return {
          total: bookings.length,
          actionType: input.actionType,
          period: { startDate: input.startDate, endDate: input.endDate },
          bookings,
        };
      }),
  }),

  // ── EXTRAS DIA — Daily forecast & driver allocation (Lisboa) ────────────────
  extrasDia: router({
    forecast: protectedProcedure
      .input(z.object({ baseDate: z.string().optional(), city: z.enum(["lisbon", "porto", "faro"]).optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        return getExtrasDiaForecast(input?.baseDate, input?.city ?? "lisbon");
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
        return listAssignments(input.date, input.city);
      }),

    upsertAssignment: protectedProcedure
      .input(
        z.object({
          id: z.number().optional(),
          assignmentDate: z.string(),
          employeeId: z.number().nullable().optional(),
          personName: z.string().min(1).max(128),
          level: z.enum(["junior", "senior", "terminal", "master"]).nullable().optional(),
          isTeamLeader: z.boolean().optional(),
          shift: z.enum(["morning", "night"]),
          city: z.enum(["lisbon", "porto", "faro"]).optional(),
          startHour: z.number().int().min(0).max(27),
          endHour: z.number().int().min(1).max(27),
          sentHomeHour: z.number().int().min(0).max(27).nullable().optional(),
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
        try {
          return await upsertAssignment({ ...input, createdById: ctx.user.id });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao guardar" });
        }
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
        return getScheduleOverview(input.date, input.city);
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
        return getExtrasMetrics(input?.days ?? 30);
      }),

    coverageOutlook: protectedProcedure
      .input(z.object({ city: z.enum(["lisbon", "porto", "faro"]), days: z.number().int().min(1).max(14).optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        const { getCoverageOutlook } = await import("./extrasMetrics");
        return getCoverageOutlook(input.city, input.days ?? 7);
      }),

    notices: protectedProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        const { listNotices } = await import("./extrasAutomation");
        return listNotices(input.date);
      }),

    notify: protectedProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), city: z.enum(["lisbon", "porto", "faro"]) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        const { notifyAssignments } = await import("./extrasAutomation");
        try {
          return await notifyAssignments(input.date, { city: input.city, createdById: ctx.user.id });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message || "Erro ao avisar" });
        }
      }),

    costForRange: protectedProcedure
      .input(z.object({ startDate: z.string(), endDate: z.string() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        return getExtrasDiaCostForRange(input.startDate, input.endDate);
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
  }),

  // ── DISPONIBILIDADE SEMANAL DOS EXTRAS ────────────────────────────────────
  extrasAvailability: router({
    forEmployee: protectedProcedure
      .input(z.object({ employeeId: z.number(), weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
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
      .input(z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
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
          weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          days: z.array(
            z.object({
              day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              morning: z.boolean().optional(),
              night: z.boolean().optional(),
              fromHour: z.number().int().min(0).max(23).nullable().optional(),
              toHour: z.number().int().min(0).max(23).nullable().optional(),
              note: z.string().max(300).nullable().optional(),
            }),
          ),
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
        return setMyAvailability(emp.employee.id, input.weekStart, input.days, ctx.user.id);
      }),

    // Backoffice: marca a disponibilidade POR um extra (a semana inteira, como
    // o próprio faria em setMyWeek). Fica no activity log com quem marcou.
    setForEmployee: protectedProcedure
      .input(
        z.object({
          employeeId: z.number().int().positive(),
          weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
        let result: { saved: number; employeeName: string };
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
          details: `Disponibilidade marcada pelo backoffice para ${result.employeeName} (semana ${input.weekStart}): ${result.saved} dia(s)`,
        });
        return result;
      }),

    // Backoffice: resumo da semana (quem respondeu, disponíveis por dia/turno).
    overview: protectedProcedure
      .input(z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), projectId: z.number().nullable().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "disponibilidade_extras", "view");
        return getWeekOverview(input.weekStart, input.projectId ?? null);
      }),

    // Backoffice: envia o pedido por email a todos os extras ativos.
    sendRequest: protectedProcedure
      .input(
        z.object({
          weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          origin: z.string().url(),
          projectId: z.number().nullable().optional(),
          note: z.string().max(500).nullable().optional(),
          employeeIds: z.array(z.number()).nullable().optional(),
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
        const result = await sendWeeklyAvailabilityRequest({
          weekStart: input.weekStart,
          origin: input.origin,
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
        const { linkEmployeeToUser } = await import("./identityScreen");
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
    linkAgent: protectedProcedure
      .input(z.object({ employeeId: z.number().int().positive(), agentUserId: z.string().min(1).max(128) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        await assertEmployeeAccess(input.employeeId);
        const { linkAgentToEmployee } = await import("./identityScreen");
        const agentName = await linkAgentToEmployee(input.agentUserId, input.employeeId);
        await logActivity({ userId: ctx.user.id, action: "agent_attach", entity: "employee", entityId: input.employeeId, details: `Agente Multipark ${input.agentUserId} "${agentName}" ligado (ecrã Ligações)` });
        return { success: true, agentName };
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
          bookingId: z.number().int().positive().nullable().optional(),
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

  // ── HISTÓRICO DE CLIENTE (reservas + reclamações + perdidos + críticas) ─────
  clients: router({
    // ── CRM leve (Jorge, 24 set 2026): email = cliente; lista, stats e ficha
    //    agregadas das reservas. Totais (gasto/média) só backoffice+ sem deny
    //    de finance.view_totals — os outros veem reservas e datas.
    list: protectedProcedure
      .input(z.object({
        search: z.string().max(200).nullable().optional(),
        segment: z.enum(["all", "new", "recurring", "vip", "at_risk", "partner", "shared"]).nullable().optional(),
        sort: z.enum(["lastCheckIn", "totalSpent", "bookings", "firstCheckIn"]).optional(),
        dir: z.enum(["asc", "desc"]).optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(10).max(200).optional(),
        projectId: z.number().optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { getDb } = await import("./db");
        const { listClients, stripTotals } = await import("./clientsCrm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const projectIds = input?.projectId ? await resolveProjectIds(input.projectId) : null;
        const totals = await canSeeFinanceTotals(ctx.user);
        // Ordenar por gasto ou filtrar VIP revela quem gasta mais — é informação financeira.
        if (!totals && (input?.sort === "totalSpent" || input?.segment === "vip")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Sem acesso aos totais financeiros" });
        }
        const res = await listClients(db, { ...(input ?? {}), projectIds });
        return { ...res, canSeeTotals: totals, rows: totals ? res.rows : res.rows.map(stripTotals), vipThreshold: totals ? res.vipThreshold : null };
      }),
    stats: protectedProcedure
      .input(z.object({ projectId: z.number().optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { getDb } = await import("./db");
        const { clientsStats, countBookingsWithoutEmail } = await import("./clientsCrm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const projectIds = input?.projectId ? await resolveProjectIds(input.projectId) : null;
        const [s, withoutEmail] = await Promise.all([clientsStats(db, projectIds), countBookingsWithoutEmail(db, projectIds)]);
        const out = { ...s, bookingsWithoutEmail: withoutEmail };
        return (await canSeeFinanceTotals(ctx.user)) ? { ...out, canSeeTotals: true } : { ...out, canSeeTotals: false, vip: null, vipThreshold: null };
      }),
    profile: protectedProcedure
      .input(z.object({ email: z.string().min(3).max(320), projectId: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "clientes", "view");
        const { getDb } = await import("./db");
        const { getClientProfile, stripTotals } = await import("./clientsCrm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const projectIds = input.projectId ? await resolveProjectIds(input.projectId) : null;
        const p = await getClientProfile(db, input.email, projectIds);
        if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente sem reservas" });
        const totals = await canSeeFinanceTotals(ctx.user);
        if (totals) return { ...p, canSeeTotals: true };
        return { ...stripTotals(p), canSeeTotals: false, parks: p.parks.map((k) => ({ ...k, spent: 0 })), bookings_list: p.bookings_list.map((b) => ({ ...b, totalPrice: null })) };
      }),

    history: protectedProcedure
      .input(z.object({
        email: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        plate: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
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
        requireAccess(ctx.user, "clientes", "view");
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
        requireAccess(ctx.user, "clientes", "edit");
        const { getInboundEmailById, setInboundEmailTarget } = await import("./db");
        const em = await getInboundEmailById(input.inboundId);
        if (!em) throw new TRPCError({ code: "NOT_FOUND", message: "Email não encontrado" });
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
