import { and, asc, desc, eq, gte, lte, like, or, sql, aliasedTable, isNotNull, isNull, inArray, notInArray, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { normalizeEmail } from "../shared/email";
import {
  users,
  expenses,
  expenseCategories,
  projects,
  projectEmployees,
  tasks,
  taskAssignees,
  inboundEmails,
  InsertInboundEmail,
  activityLogs,
  InsertUser,
  InsertExpense,
  InsertExpenseCategory,
  InsertProject,
  InsertProjectEmployee,
  InsertTask,
  InsertActivityLog,
  campaigns,
  campaignDailyStats,
  marketingExpenses,
  InsertCampaign,
  InsertCampaignDailyStat,
  InsertMarketingExpense,
  vehicles,
  vehicleMovements,
  speedAlerts,
  radioTranscriptions,
  InsertVehicle,
  InsertVehicleMovement,
  InsertSpeedAlert,
  InsertRadioTranscription,
  apiKeys,
  InsertApiKey,
  complaints,
  complaintMessages,
  complaintPhotos,
  InsertComplaint,
  InsertComplaintMessage,
  InsertComplaintPhoto,
  googleReviews,
  InsertGoogleReview,
  trainingCategories,
  trainingVideos,
  trainingManuals,
  faqs,
  quizQuestions,
  quizAttempts,
  careerExams,
  careerExamQuestions,
  careerExamAttempts,
  lostFoundItems,
  lostFoundPhotos,
  lostFoundMessages,
  lostFoundAttachedDrivers,
  incidents,
  performanceEvaluations,
  services,
  invoices,
  partnerships,
  partnerAliases,
  partnershipTransactions,
  partnershipInvoices,
  annualReports,
  multiparkBookings,
  multiparkBookingExtras,
  multiparkSyncLogs,
  InsertMultiparkBooking,
  multiparkDailySnapshots,
  InsertMultiparkDailySnapshot,
  inviteTokens,
  InsertInviteToken,
  payslipHistory,
  InsertPayslipHistory,
  speedLimits,
  speedViolations,
  InsertSpeedLimit,
  InsertSpeedViolation,
  dailyDriverHistory,
  InsertDailyDriverHistory,
  pdas,
  InsertPda,
  pdaCheckins,
  InsertPdaCheckin,
  gpsAlerts,
  InsertGpsAlert,
  bookingHistory,
  multiparkBookingHistory,
  extrasDiaAssignments,
} from "../drizzle/schema";
import type { LostFoundItem, LostFoundPhoto, LostFoundMessage } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;
let _schemaEnsure: Promise<void> | null = null;

/**
 * Aplica (idempotente, uma vez por processo) as migrations cujo SCHEMA drizzle
 * já referencia colunas/tabelas novas — senão `select()` parte com "Unknown
 * column" antes de alguém carregar no botão DB:NNNN. Limitado às migrations que
 * introduzem schema lido no arranque (0050 extras_availability, 0051 threading).
 * Os botões manuais continuam a existir; isto é só uma rede de segurança.
 */
async function ensureRecentSchema(db: NonNullable<typeof _db>): Promise<void> {
  try {
    const mods = await Promise.all([
      import("./migrations/migration_0050").then(m => ({ s: m.MIGRATION_0050_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0050 })),
      import("./migrations/migration_0051").then(m => ({ s: m.MIGRATION_0051_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0051 })),
      import("./migrations/migration_0052").then(m => ({ s: m.MIGRATION_0052_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0052 })),
      import("./migrations/migration_0053").then(m => ({ s: m.MIGRATION_0053_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0053 })),
      import("./migrations/migration_0054").then(m => ({ s: m.MIGRATION_0054_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0054 })),
      import("./migrations/migration_0055").then(m => ({ s: m.MIGRATION_0055_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0055 })),
      import("./migrations/migration_0056").then(m => ({ s: m.MIGRATION_0056_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0056 })),
      import("./migrations/migration_0058").then(m => ({ s: m.MIGRATION_0058_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0058 })),
      import("./migrations/migration_0059").then(m => ({ s: m.MIGRATION_0059_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0059 })),
      import("./migrations/migration_0060").then(m => ({ s: m.MIGRATION_0060_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0060 })),
      import("./migrations/migration_0061").then(m => ({ s: m.MIGRATION_0061_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0061 })),
    ]);
    for (const { s, ok } of mods) {
      for (const stmt of s) {
        try {
          await db.execute(sql.raw(stmt));
        } catch (err: any) {
          if (!(err?.code && ok.has(err.code))) {
            console.warn("[Schema ensure]", err?.code ?? "ERR", String(err?.message ?? err).slice(0, 160));
          }
        }
      }
    }
  } catch (err: any) {
    console.warn("[Schema ensure] falhou:", String(err?.message ?? err).slice(0, 160));
  }
}

// MySQL timestamp(mode:string) helper — converte Date para "YYYY-MM-DD HH:MM:SS"
function toMysqlDateTime(d: Date | string | null | undefined): string {
  if (d == null) return "";
  if (typeof d === "string") return d;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  if (_db && !_schemaEnsure) _schemaEnsure = ensureRecentSchema(_db);
  if (_schemaEnsure) await _schemaEnsure;
  return _db;
}

// ─── USERS ────────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};

  const textFields = ["name", "email", "loginMethod"] as const;
  for (const field of textFields) {
    const value = user[field];
    if (value !== undefined) {
      // Email normalizado à entrada: é a chave de identidade do sistema.
      const stored = field === "email" && typeof value === "string" ? normalizeEmail(value) || null : value ?? null;
      values[field] = stored;
      updateSet[field] = stored;
    }
  }

  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }

  if (user.openId === ENV.ownerOpenId) {
    values.role = "super_admin";
    updateSet.role = "super_admin";
  } else if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  }

  const nowMysql = new Date().toISOString().slice(0, 19).replace("T", " ");
  if (!values.lastSignedIn) values.lastSignedIn = nowMysql;
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = nowMysql;

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function getAllUsers() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).orderBy(desc(users.createdAt));
}

export async function updateUserRole(userId: number, role: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ role: role as any }).where(eq(users.id, userId));
}

/**
 * Procura por EMAIL — sempre case/space-insensitive dos DOIS lados: a
 * identidade do sistema é o email e a collation da coluna não é garantia.
 */
export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const needle = normalizeEmail(email);
  if (!needle) return undefined;
  const result = await db
    .select()
    .from(users)
    .where(sql`LOWER(TRIM(${users.email})) = ${needle}`)
    .orderBy(desc(users.isActive), asc(users.id))
    .limit(1);
  return result[0];
}

/**
 * Conta criada à mão pelo backoffice. Fica com um `openId` placeholder
 * (`manual_...`) até a pessoa entrar pela primeira vez com a Google — nessa
 * altura o callback OAuth ADOTA esta linha pelo email (ver server/identity.ts),
 * preservando role/departamento. Por isso o email é gravado normalizado.
 */
export async function createManualUser(data: { name: string; email: string; role: string; department?: string }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const email = normalizeEmail(data.email);
  const existing = await getUserByEmail(email);
  if (existing) {
    throw new Error(`Já existe um utilizador com o email ${email}`);
  }
  const openId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await db.insert(users).values({
    openId,
    name: data.name,
    email,
    role: data.role as any,
    department: data.department ?? null,
    loginMethod: "manual",
    isActive: 1,
  });
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function updateUser(userId: number, data: { name?: string; email?: string; role?: string; department?: string | null; isActive?: boolean }) {
  const db = await getDb();
  if (!db) return;
  const updates: Record<string, any> = {};
  if (data.name !== undefined) updates.name = data.name;
  // Email é a chave de identidade → gravado sempre na forma canónica.
  if (data.email !== undefined) updates.email = normalizeEmail(data.email);
  if (data.role !== undefined) updates.role = data.role;
  if (data.department !== undefined) updates.department = data.department;
  if (data.isActive !== undefined) updates.isActive = data.isActive ? 1 : 0;
  if (Object.keys(updates).length > 0) {
    await db.update(users).set(updates).where(eq(users.id, userId));
  }
}

export async function toggleUserActive(userId: number, isActive: boolean) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ isActive: isActive ? 1 : 0 }).where(eq(users.id, userId));
}

export async function getUserById(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return result[0];
}

export async function getSuperAdmins() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).where(eq(users.role, "super_admin"));
}

// ─── PROJECTS — see bottom of file for full tree helpers ─────────────────────

// ─── EXPENSE CATEGORIES ───────────────────────────────────────────────────────

export async function getAllCategories() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(expenseCategories).orderBy(expenseCategories.name);
}

export async function createCategory(data: InsertExpenseCategory) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(expenseCategories).values(data);
}

export async function seedDefaultCategories() {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select().from(expenseCategories).limit(1);
  if (existing.length > 0) {
    // Rename "Terminal de Pagamento" → "Terminal" and add missing categories
    await db.update(expenseCategories).set({ name: "Terminal" }).where(eq(expenseCategories.name, "Terminal de Pagamento"));
    for (const cat of [
      { name: "Bancos", department: "Financeiro", color: "#1d4ed8" },
      { name: "Impostos", department: "Financeiro", color: "#dc2626" },
      { name: "TI", department: "RH", color: "#0284c7" },
    ]) {
      const found = await db.select().from(expenseCategories).where(eq(expenseCategories.name, cat.name)).limit(1);
      if (found.length === 0) await db.insert(expenseCategories).values(cat);
    }
    return;
  }

  const defaults: InsertExpenseCategory[] = [
    { name: "Combustível", department: "Operacional", color: "#f59e0b" },
    { name: "Manutenção", department: "Operacional", color: "#10b981" },
    { name: "Marketing", department: "Marketing", color: "#8b5cf6" },
    { name: "Recursos Humanos", department: "RH", color: "#3b82f6" },
    { name: "Material de Escritório", department: "Administrativo", color: "#6366f1" },
    { name: "Alimentação", department: "Geral", color: "#ec4899" },
    { name: "Transportes", department: "Operacional", color: "#14b8a6" },
    { name: "Tecnologia", department: "IT", color: "#0ea5e9" },
    { name: "Seguros", department: "Financeiro", color: "#f97316" },
    { name: "Rendas", department: "Financeiro", color: "#e11d48" },
    { name: "Água", department: "Instalações", color: "#06b6d4" },
    { name: "Eletricidade", department: "Instalações", color: "#eab308" },
    { name: "Telecomunicações", department: "Instalações", color: "#7c3aed" },
    { name: "Terminal", department: "Financeiro", color: "#059669" },
    { name: "Bancos", department: "Financeiro", color: "#1d4ed8" },
    { name: "Impostos", department: "Financeiro", color: "#dc2626" },
    { name: "TI", department: "RH", color: "#0284c7" },
    { name: "Despesas Operacionais", department: "Operacional", color: "#d97706" },
    { name: "Outros", department: "Geral", color: "#94a3b8" },
  ];

  await db.insert(expenseCategories).values(defaults);
}

// ─── EXPENSES ─────────────────────────────────────────────────────────────────

export interface ExpenseFilters {
  startDate?: Date;
  endDate?: Date;
  projectId?: number;
  categoryId?: number;
  userId?: number;
  status?: string;
  search?: string;
}

const buyerEmployees = aliasedTable(employees, "buyer");

export async function getExpenses(filters: ExpenseFilters = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  if (filters.startDate) conditions.push(gte(expenses.expenseDate, toMysqlDateTime(filters.startDate)));
  if (filters.endDate) conditions.push(lte(expenses.expenseDate, toMysqlDateTime(filters.endDate)));
  if (filters.projectId) conditions.push(eq(expenses.projectId, filters.projectId));
  if (filters.categoryId) conditions.push(eq(expenses.categoryId, filters.categoryId));
  if (filters.userId) conditions.push(eq(expenses.insertedById, filters.userId));
  if (filters.status) conditions.push(eq(expenses.status, filters.status as any));
  if (filters.search) {
    conditions.push(
      or(
        like(expenses.supplier, `%${filters.search}%`),
        like(expenses.description, `%${filters.search}%`)
      )
    );
  }
  const query = db
    .select({
      expense: expenses,
      category: expenseCategories,
      project: projects,
      insertedBy: users,
      buyer: buyerEmployees,
    })
    .from(expenses)
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .leftJoin(users, eq(expenses.insertedById, users.id))
    .leftJoin(buyerEmployees, eq(expenses.buyerId, buyerEmployees.id))
    .orderBy(desc(expenses.expenseDate));
  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}

export async function getExpenseById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select({
      expense: expenses,
      category: expenseCategories,
      project: projects,
      insertedBy: users,
      buyer: buyerEmployees,
    })
    .from(expenses)
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .leftJoin(users, eq(expenses.insertedById, users.id))
    .leftJoin(buyerEmployees, eq(expenses.buyerId, buyerEmployees.id))
    .where(eq(expenses.id, id))
    .limit(1);
  return result[0];
}

export async function createExpense(data: InsertExpense) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(expenses).values(data);
  return result;
}

export async function updateExpense(id: number, data: Partial<InsertExpense>) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(expenses).set(data).where(eq(expenses.id, id));
}

export async function deleteExpense(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(expenses).where(eq(expenses.id, id));
}

// ─── DASHBOARD STATS ──────────────────────────────────────────────────────────

export async function getExpenseStats() {
  const db = await getDb();
  if (!db) return null;

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const [daily, weekly, monthly, yearly, byCategory, byProject, byUser, pending, overdue] =
    await Promise.all([
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(gte(expenses.expenseDate, toMysqlDateTime(startOfDay))),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(gte(expenses.expenseDate, toMysqlDateTime(startOfWeek))),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(gte(expenses.expenseDate, toMysqlDateTime(startOfMonth))),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(gte(expenses.expenseDate, toMysqlDateTime(startOfYear))),
      db
        .select({
          categoryId: expenses.categoryId,
          categoryName: expenseCategories.name,
          color: expenseCategories.color,
          total: sql<string>`COALESCE(SUM(expenses.amount), 0)`,
          count: sql<number>`COUNT(*)`,
        })
        .from(expenses)
        .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
        .where(gte(expenses.expenseDate, toMysqlDateTime(startOfMonth)))
        .groupBy(expenses.categoryId, expenseCategories.name, expenseCategories.color)
        .orderBy(desc(sql`SUM(expenses.amount)`))
        .limit(8),
      db
        .select({
          projectId: expenses.projectId,
          projectName: projects.name,
          total: sql<string>`COALESCE(SUM(expenses.amount), 0)`,
          count: sql<number>`COUNT(*)`,
        })
        .from(expenses)
        .leftJoin(projects, eq(expenses.projectId, projects.id))
        .where(gte(expenses.expenseDate, toMysqlDateTime(startOfMonth)))
        .groupBy(expenses.projectId, projects.name)
        .orderBy(desc(sql`SUM(expenses.amount)`))
        .limit(5),
      db
        .select({
          userId: expenses.insertedById,
          userName: users.name,
          total: sql<string>`COALESCE(SUM(expenses.amount), 0)`,
          count: sql<number>`COUNT(*)`,
        })
        .from(expenses)
        .leftJoin(users, eq(expenses.insertedById, users.id))
        .where(gte(expenses.expenseDate, toMysqlDateTime(startOfMonth)))
        .groupBy(expenses.insertedById, users.name)
        .orderBy(desc(sql`SUM(expenses.amount)`))
        .limit(5),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(eq(expenses.status, "pending")),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(eq(expenses.status, "overdue")),
    ]);

  // Monthly trend (last 6 months)
  const monthlyTrend = await db
    .select({
      month: sql<string>`DATE_FORMAT(expenseDate, '%Y-%m')`,
      total: sql<string>`COALESCE(SUM(amount), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(expenses)
    .where(gte(expenses.expenseDate, toMysqlDateTime(new Date(now.getFullYear(), now.getMonth() - 5, 1))))
    .groupBy(sql`DATE_FORMAT(expenseDate, '%Y-%m')`)
    .orderBy(sql`DATE_FORMAT(expenseDate, '%Y-%m')`);

  return {
    daily: { total: parseFloat(daily[0]?.total || "0"), count: daily[0]?.count || 0 },
    weekly: { total: parseFloat(weekly[0]?.total || "0"), count: weekly[0]?.count || 0 },
    monthly: { total: parseFloat(monthly[0]?.total || "0"), count: monthly[0]?.count || 0 },
    yearly: { total: parseFloat(yearly[0]?.total || "0"), count: yearly[0]?.count || 0 },
    byCategory: byCategory.map((c) => ({ ...c, total: parseFloat(c.total || "0") })),
    byProject: byProject.map((p) => ({ ...p, total: parseFloat(p.total || "0") })),
    byUser: byUser.map((u) => ({ ...u, total: parseFloat(u.total || "0") })),
    pending: { total: parseFloat(pending[0]?.total || "0"), count: pending[0]?.count || 0 },
    overdue: { total: parseFloat(overdue[0]?.total || "0"), count: overdue[0]?.count || 0 },
    monthlyTrend: monthlyTrend.map((m) => ({ ...m, total: parseFloat(m.total || "0") })),
  };
}

export async function getUpcomingPayments(daysAhead = 7) {
  const db = await getDb();
  if (!db) return [];
  const now = new Date();
  const future = new Date();
  future.setDate(future.getDate() + daysAhead);

  return db
    .select({
      expense: expenses,
      insertedBy: users,
      project: projects,
    })
    .from(expenses)
    .leftJoin(users, eq(expenses.insertedById, users.id))
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .where(
      and(
        eq(expenses.status, "pending"),
        gte(expenses.paymentDueDate, toMysqlDateTime(now)),
        lte(expenses.paymentDueDate, toMysqlDateTime(future))
      )
    )
    .orderBy(expenses.paymentDueDate);
}

export async function getOverdueExpenses() {
  const db = await getDb();
  if (!db) return [];
  const now = new Date();
  return db
    .select({ expense: expenses, insertedBy: users })
    .from(expenses)
    .leftJoin(users, eq(expenses.insertedById, users.id))
    .where(and(eq(expenses.status, "pending"), lte(expenses.paymentDueDate, toMysqlDateTime(now))));
}

export async function markOverdueExpenses() {
  const db = await getDb();
  if (!db) return;
  const now = new Date();
  await db
    .update(expenses)
    .set({ status: "overdue" })
    .where(and(eq(expenses.status, "pending"), lte(expenses.paymentDueDate, toMysqlDateTime(now))));
}

// ─── ACTIVITY LOGS ────────────────────────────────────────────────────────────

export async function logActivity(data: InsertActivityLog) {
  const db = await getDb();
  if (!db) return;
  await db.insert(activityLogs).values(data);
}

export async function getActivityLogs(limit = 100, filters: { entity?: string; action?: string; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [];
  if (filters.entity) conds.push(eq(activityLogs.entity, filters.entity));
  if (filters.action) conds.push(eq(activityLogs.action, filters.action));
  if (filters.userId) conds.push(eq(activityLogs.userId, filters.userId));
  return db
    .select({ log: activityLogs, user: users })
    .from(activityLogs)
    .leftJoin(users, eq(activityLogs.userId, users.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(activityLogs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 2000));
}

// ─── RH: EMPLOYEES ────────────────────────────────────────────────────────────
import {
  employees,
  employeeDocuments,
  employeeLeaves,
  employeeSalaryHistory,
  employeePenalties,
  schedules,
  timeRecords,
  extraRates,
  InsertEmployee,
  InsertEmployeeDocument,
  InsertSchedule,
  InsertTimeRecord,
  InsertExtraRate,
} from "../drizzle/schema";

export async function getAllEmployees(filters: { isActive?: boolean; position?: string } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  if (filters.isActive !== undefined) conditions.push(eq(employees.isActive, filters.isActive ? 1 : 0));
  if (filters.position) conditions.push(eq(employees.position, filters.position as any));
  const q = db.select({ employee: employees, project: projects }).from(employees)
    .leftJoin(projects, eq(employees.projectId, projects.id))
    .orderBy(employees.fullName);
  return conditions.length > 0 ? q.where(and(...conditions)) : q;
}

export async function getEmployeeById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select({ employee: employees, project: projects }).from(employees)
    .leftJoin(projects, eq(employees.projectId, projects.id))
    .where(eq(employees.id, id)).limit(1);
  return result[0];
}

export async function getEmployeeByUserId(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select({ employee: employees, project: projects }).from(employees)
    .leftJoin(projects, eq(employees.projectId, projects.id))
    .where(eq(employees.userId, userId)).limit(1);
  return result[0];
}

export async function createEmployee(data: InsertEmployee) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.insert(employees).values(data);
}

export async function updateEmployee(id: number, data: Partial<InsertEmployee>, changedById?: number | null) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Se o salário ou subsídio mudaram, fecha o registo activo e cria um novo
  if (data.monthlySalary !== undefined || data.mealAllowancePerDay !== undefined) {
    const [current] = await db
      .select({ monthlySalary: employees.monthlySalary, mealAllowancePerDay: employees.mealAllowancePerDay })
      .from(employees)
      .where(eq(employees.id, id))
      .limit(1);
    const newSalary = data.monthlySalary !== undefined ? data.monthlySalary : current?.monthlySalary;
    const newMeal = data.mealAllowancePerDay !== undefined ? data.mealAllowancePerDay : current?.mealAllowancePerDay;
    const changed =
      String(current?.monthlySalary ?? "") !== String(newSalary ?? "") ||
      String(current?.mealAllowancePerDay ?? "") !== String(newMeal ?? "");
    if (changed) {
      const today = new Date().toISOString().slice(0, 10);
      // Fecha o registo activo (effectiveUntil = ontem)
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await db
        .update(employeeSalaryHistory)
        .set({ effectiveUntil: yesterday })
        .where(and(eq(employeeSalaryHistory.employeeId, id), isNull(employeeSalaryHistory.effectiveUntil)));
      // Cria o novo
      await db.insert(employeeSalaryHistory).values({
        employeeId: id,
        monthlySalary: (newSalary as any) ?? null,
        mealAllowancePerDay: (newMeal as any) ?? null,
        effectiveFrom: today,
        changedById: changedById ?? null,
      });
    }
  }
  await db.update(employees).set(data).where(eq(employees.id, id));
}

// ─── RH: SALARY HISTORY ────────────────────────────────────────────────────
/** Procura o salário vigente para um funcionário num dia específico
 * (formato 'YYYY-MM-DD'). Volta para o registo activo ou — se ainda
 * não há histórico — para os campos directos em employees. */
export async function getEmployeeSalaryAt(employeeId: number, dateStr: string) {
  const db = await getDb();
  if (!db) return null;
  const [hist] = await db
    .select()
    .from(employeeSalaryHistory)
    .where(and(
      eq(employeeSalaryHistory.employeeId, employeeId),
      lte(employeeSalaryHistory.effectiveFrom, dateStr),
      or(
        isNull(employeeSalaryHistory.effectiveUntil),
        gte(employeeSalaryHistory.effectiveUntil, dateStr),
      )!,
    ))
    .orderBy(desc(employeeSalaryHistory.effectiveFrom))
    .limit(1);
  if (hist) return { monthlySalary: hist.monthlySalary, mealAllowancePerDay: hist.mealAllowancePerDay };
  const [emp] = await db
    .select({ monthlySalary: employees.monthlySalary, mealAllowancePerDay: employees.mealAllowancePerDay })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  return emp ?? null;
}

export async function getEmployeeSalaryHistory(employeeId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(employeeSalaryHistory)
    .where(eq(employeeSalaryHistory.employeeId, employeeId))
    .orderBy(desc(employeeSalaryHistory.effectiveFrom));
}

// ─── RH: LEAVES (férias / baixas) ──────────────────────────────────────────
export async function createEmployeeLeave(data: {
  employeeId: number;
  leaveType: "vacation" | "sick" | "unpaid" | "other";
  fromDate: string;
  toDate: string;
  notes?: string | null;
  createdById?: number | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(employeeLeaves).values({
    employeeId: data.employeeId,
    leaveType: data.leaveType,
    fromDate: data.fromDate,
    toDate: data.toDate,
    notes: data.notes ?? null,
    createdById: data.createdById ?? null,
  });
}

export async function getEmployeeLeaves(employeeId: number, year?: number) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [eq(employeeLeaves.employeeId, employeeId)];
  if (year) {
    conds.push(gte(employeeLeaves.toDate, `${year}-01-01`));
    conds.push(lte(employeeLeaves.fromDate, `${year}-12-31`));
  }
  return db.select().from(employeeLeaves).where(and(...conds)).orderBy(desc(employeeLeaves.fromDate));
}

export async function deleteEmployeeLeave(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(employeeLeaves).where(eq(employeeLeaves.id, id));
}

/** Devolve um Set de dias (YYYY-MM-DD) em férias/baixa no intervalo do mês. */
export async function getLeaveDaysForMonth(employeeId: number, year: number, month: number): Promise<Set<string>> {
  const db = await getDb();
  const out = new Set<string>();
  if (!db) return out;
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const rows = await db
    .select({ fromDate: employeeLeaves.fromDate, toDate: employeeLeaves.toDate })
    .from(employeeLeaves)
    .where(and(
      eq(employeeLeaves.employeeId, employeeId),
      lte(employeeLeaves.fromDate, end),
      gte(employeeLeaves.toDate, start),
    ));
  for (const r of rows) {
    const from = r.fromDate < start ? start : r.fromDate;
    const to = r.toDate > end ? end : r.toDate;
    const d = new Date(from + "T00:00:00");
    const limit = new Date(to + "T00:00:00");
    while (d <= limit) {
      out.add(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
  }
  return out;
}

// ─── RH: PENALIZAÇÕES ──────────────────────────────────────────────────────
export async function createEmployeePenalty(data: {
  employeeId: number;
  reason: "no_show_extra_dia" | "speeding" | "lost_found_investigation" | "complaint_investigation" | "other";
  severity?: "warning" | "penalty" | "serious";
  points?: number;
  relatedId?: number | null;
  notes?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(employeePenalties).values({
    employeeId: data.employeeId,
    reason: data.reason,
    severity: data.severity ?? "penalty",
    points: data.points ?? 1,
    relatedId: data.relatedId ?? null,
    notes: data.notes ?? null,
  });
}

export async function getOpenPenalties(employeeId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(employeePenalties)
    .where(and(eq(employeePenalties.employeeId, employeeId), isNull(employeePenalties.clearedAt)))
    .orderBy(desc(employeePenalties.createdAt));
}

export async function getAllOpenPenaltiesByEmployee() {
  const db = await getDb();
  if (!db) return new Map<number, number>();
  const rows = await db
    .select({
      employeeId: employeePenalties.employeeId,
      totalPoints: sql<number>`COALESCE(SUM(${employeePenalties.points}), 0)`,
    })
    .from(employeePenalties)
    .where(isNull(employeePenalties.clearedAt))
    .groupBy(employeePenalties.employeeId);
  return new Map(rows.map(r => [r.employeeId, Number(r.totalPoints)]));
}

export async function clearPenalty(id: number, clearedById: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db
    .update(employeePenalties)
    .set({ clearedAt: toMysqlDateTime(new Date()), clearedById })
    .where(eq(employeePenalties.id, id));
}

/** Levanta bloqueio de login de um colaborador (apaga loginBlocked + flag) */
export async function unblockEmployeeLogin(employeeId: number, clearedById: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db
    .update(employees)
    .set({ loginBlocked: 0, loginBlockedReason: null, docsWarningAt: null })
    .where(eq(employees.id, employeeId));
  await logActivity({
    userId: clearedById,
    action: "unblock",
    entity: "employee",
    entityId: employeeId,
    details: "Login desbloqueado",
  });
}

/** Verifica conformidade de documentos para um colaborador.
 *
 * Regras (apenas para position=extra):
 *  - 14 dias após contractStart (ou createdAt) com docs obrigatórios em falta:
 *    grava docsWarningAt (aviso na primeira vez)
 *  - 21 dias após contractStart: bloqueia login (loginBlocked = 1)
 *
 * Retorna o estado actual: {blocked, warning, missingDocs, daysSinceStart}.
 */
export async function checkExtraDocsCompliance(employeeId: number): Promise<{
  blocked: boolean;
  warning: boolean;
  missingDocs: string[];
  daysSinceStart: number;
} | null> {
  const db = await getDb();
  if (!db) return null;
  const [emp] = await db
    .select({
      id: employees.id,
      position: employees.position,
      contractStart: employees.contractStart,
      createdAt: employees.createdAt,
      loginBlocked: employees.loginBlocked,
      docsWarningAt: employees.docsWarningAt,
    })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  if (!emp || emp.position !== "extra") return null;

  const startDate = new Date(emp.contractStart ?? emp.createdAt ?? new Date());
  const daysSinceStart = Math.floor((Date.now() - startDate.getTime()) / 86_400_000);

  const checklist = await getDocumentChecklistForEmployee(employeeId);
  const missingDocs = checklist.filter(c => !c.present).map(c => c.docType);

  // Sem nada em falta? Levanta tudo (caso já estivesse marcado).
  if (missingDocs.length === 0) {
    if (emp.loginBlocked || emp.docsWarningAt) {
      await db.update(employees)
        .set({ loginBlocked: 0, loginBlockedReason: null, docsWarningAt: null })
        .where(eq(employees.id, employeeId));
    }
    return { blocked: false, warning: false, missingDocs: [], daysSinceStart };
  }

  // +21 dias → bloqueia
  if (daysSinceStart >= 21) {
    if (!emp.loginBlocked) {
      await db.update(employees)
        .set({
          loginBlocked: 1,
          loginBlockedReason: `Documentos obrigatórios em falta há ${daysSinceStart} dias: ${missingDocs.join(", ")}`,
        })
        .where(eq(employees.id, employeeId));
    }
    return { blocked: true, warning: true, missingDocs, daysSinceStart };
  }

  // +14 dias → avisa (apenas se ainda não foi avisado)
  if (daysSinceStart >= 14 && !emp.docsWarningAt) {
    await db.update(employees)
      .set({ docsWarningAt: toMysqlDateTime(new Date()) })
      .where(eq(employees.id, employeeId));
    return { blocked: false, warning: true, missingDocs, daysSinceStart };
  }

  return {
    blocked: Boolean(emp.loginBlocked),
    warning: Boolean(emp.docsWarningAt),
    missingDocs,
    daysSinceStart,
  };
}

/** Resumo agregado por colaborador para o dashboard RH:
 *  - A receber este mês (bruto + estimativa líquida)
 *  - Pago nos últimos N meses
 *  - Total de horas no período
 *  - Penalizações abertas
 *
 *  Devolve uma linha por colaborador activo. Não filtra por projecto
 *  (filtragem em client se necessário).
 */
export async function getRhDashboardSummary(year: number, month: number, monthsLookback: number = 3) {
  const db = await getDb();
  if (!db) return [];

  // Payroll do mês actual
  const currentPayroll = await getPayrollData(year, month);

  // Payroll dos N meses anteriores em paralelo
  const lookback: Array<{ year: number; month: number }> = [];
  for (let i = 1; i <= monthsLookback; i++) {
    let m = month - i;
    let y = year;
    while (m < 1) { m += 12; y -= 1; }
    lookback.push({ year: y, month: m });
  }
  const previousMonths = await Promise.all(
    lookback.map(({ year: y, month: m }) => getPayrollData(y, m).then(rows => ({ y, m, rows }))),
  );

  // Penalizações abertas por empId
  const penaltiesByEmp = await getAllOpenPenaltiesByEmployee();

  // Agrega
  const out: any[] = [];
  for (const row of currentPayroll) {
    const empId = row.employeeId;
    const history = previousMonths.map(({ y, m, rows }) => {
      const r = rows.find((x: any) => x.employeeId === empId);
      return {
        year: y,
        month: m,
        totalHours: r?.totalHours ?? 0,
        totalPayment: r?.totalPayment ?? 0,
        netEstimate: r?.netEstimate ?? 0,
      };
    });
    const totalReceived = history.reduce((s, h) => s + h.totalPayment, 0);
    const totalHoursLookback = history.reduce((s, h) => s + h.totalHours, 0);
    const avgPerHour = totalHoursLookback > 0 ? totalReceived / totalHoursLookback : 0;
    const openPoints = penaltiesByEmp.get(empId) ?? 0;
    out.push({
      employeeId: empId,
      fullName: row.fullName,
      position: row.position,
      isExtra: row.isExtra,
      department: row.department,
      projectName: row.projectName,
      currentMonth: {
        totalHours: row.totalHours,
        daysWorked: row.daysWorked,
        totalPayment: row.totalPayment,
        netEstimate: row.netEstimate,
      },
      history,
      totalReceivedLookback: Math.round(totalReceived * 100) / 100,
      avgPerHourLookback: Math.round(avgPerHour * 100) / 100,
      openPenaltyPoints: openPoints,
      severity: openPoints >= 3 ? "red" : openPoints >= 1 ? "yellow" : "ok",
    });
  }
  return out;
}

/** Cria penalizações para extras que estavam escalados num dia e não picaram
 *  o ponto. Idempotente: usa relatedId = extras_dia_assignment.id e ignora
 *  se já existe penalty para o mesmo assignment. Bloqueia ao 3º ponto aberto.
 *
 *  Devolve um report {scanned, created, blocked[]}.
 */
export async function processExtraDiaNoShows(dateStr: string): Promise<{
  scanned: number;
  created: number;
  blocked: number[];
}> {
  const db = await getDb();
  if (!db) return { scanned: 0, created: 0, blocked: [] };

  const rows = await db
    .select({
      id: extrasDiaAssignments.id,
      employeeId: extrasDiaAssignments.employeeId,
      personName: extrasDiaAssignments.personName,
    })
    .from(extrasDiaAssignments)
    .where(
      and(
        eq(extrasDiaAssignments.assignmentDate, dateStr),
        eq(extrasDiaAssignments.isTeamLeader, 0),
        isNotNull(extrasDiaAssignments.employeeId),
      ),
    );

  let created = 0;
  const affected = new Set<number>();
  for (const r of rows) {
    if (r.employeeId == null) continue;
    // Já tem penalty para este assignment?
    const [existing] = await db
      .select({ id: employeePenalties.id })
      .from(employeePenalties)
      .where(and(
        eq(employeePenalties.employeeId, r.employeeId),
        eq(employeePenalties.reason, "no_show_extra_dia"),
        eq(employeePenalties.relatedId, r.id),
      ))
      .limit(1);
    if (existing) continue;

    // Picou ponto algum momento desse dia?
    const start = new Date(`${dateStr}T00:00:00`);
    const end = new Date(`${dateStr}T23:59:59`);
    const checkIns = await db
      .select({ id: timeRecords.id })
      .from(timeRecords)
      .where(and(
        eq(timeRecords.employeeId, r.employeeId),
        eq(timeRecords.type, "check_in"),
        gte(timeRecords.recordedAt, toMysqlDateTime(start)),
        lte(timeRecords.recordedAt, toMysqlDateTime(end)),
      ))
      .limit(1);
    if (checkIns.length > 0) continue;

    await db.insert(employeePenalties).values({
      employeeId: r.employeeId,
      reason: "no_show_extra_dia",
      severity: "penalty",
      points: 1,
      relatedId: r.id,
      notes: `Faltou ao extras-dia em ${dateStr} (${r.personName})`,
    });
    created += 1;
    affected.add(r.employeeId);
  }

  // Verifica quem chegou a 3+ pontos abertos e bloqueia
  const blocked: number[] = [];
  for (const empId of affected) {
    const [agg] = await db
      .select({ total: sql<number>`COALESCE(SUM(${employeePenalties.points}), 0)` })
      .from(employeePenalties)
      .where(and(eq(employeePenalties.employeeId, empId), isNull(employeePenalties.clearedAt)));
    const points = Number(agg?.total ?? 0);
    if (points >= 3) {
      await db.update(employees)
        .set({
          loginBlocked: 1,
          loginBlockedReason: `${points} faltas em extras-dia sem aviso. Contacta o supervisor.`,
        })
        .where(eq(employees.id, empId));
      blocked.push(empId);
    }
  }

  return { scanned: rows.length, created, blocked };
}

export async function deleteEmployee(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(employees).set({ isActive: 0 }).where(eq(employees.id, id));
}

// ─── RH: DOCUMENTS ────────────────────────────────────────────────────────────
export async function getEmployeeDocuments(employeeId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(employeeDocuments).where(eq(employeeDocuments.employeeId, employeeId))
    .orderBy(desc(employeeDocuments.createdAt));
}

export async function createEmployeeDocument(data: InsertEmployeeDocument) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.insert(employeeDocuments).values(data);
}

export async function createEmployeeDocumentsBatch(docs: InsertEmployeeDocument[]) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  if (docs.length === 0) return;
  return db.insert(employeeDocuments).values(docs);
}

export async function deleteEmployeeDocument(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(employeeDocuments).where(eq(employeeDocuments.id, id));
}

export async function getDocumentChecklistForEmployee(employeeId: number) {
  const docs = await getEmployeeDocuments(employeeId);
  const MANDATORY_TYPES = [
    "photo", "id_card", "driving_license", "nib_proof",
    "address_proof", "contract", "responsibility_term",
  ] as const;
  const existing = new Set(docs.map(d => d.docType));
  return MANDATORY_TYPES.map(t => ({ docType: t, present: existing.has(t) }));
}

export async function getAllEmployeesDocumentStatus() {
  const db = await getDb();
  if (!db) return [];
  const docs = await db.select({
    employeeId: employeeDocuments.employeeId,
    docType: employeeDocuments.docType,
  }).from(employeeDocuments);
  const map = new Map<number, Set<string>>();
  for (const d of docs) {
    if (!map.has(d.employeeId)) map.set(d.employeeId, new Set());
    map.get(d.employeeId)!.add(d.docType);
  }
  return map;
}

// ─── RH: SCHEDULES ────────────────────────────────────────────────────────────
export async function getEmployeeSchedules(employeeId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(schedules).where(eq(schedules.employeeId, employeeId)).orderBy(schedules.weekday);
}

export async function deleteSchedule(employeeId: number, weekday: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db
    .delete(schedules)
    .where(and(eq(schedules.employeeId, employeeId), eq(schedules.weekday, weekday)));
}

export async function upsertSchedule(data: InsertSchedule) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // A tabela schedules não tem UNIQUE(employeeId, weekday) — fazer
  // SELECT + UPDATE/INSERT manualmente em vez de onDuplicateKeyUpdate.
  const [existing] = await db
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(eq(schedules.employeeId, data.employeeId), eq(schedules.weekday, data.weekday)))
    .limit(1);
  if (existing) {
    await db
      .update(schedules)
      .set({ startTime: data.startTime, endTime: data.endTime, isWorkDay: data.isWorkDay })
      .where(eq(schedules.id, existing.id));
    return;
  }
  await db.insert(schedules).values(data);
}

// ─── RH: TIME RECORDS ─────────────────────────────────────────────────────────
export async function getTimeRecords(employeeId: number, startDate?: Date, endDate?: Date) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(timeRecords.employeeId, employeeId)];
  if (startDate) conditions.push(gte(timeRecords.recordedAt, toMysqlDateTime(startDate)));
  if (endDate) conditions.push(lte(timeRecords.recordedAt, toMysqlDateTime(endDate)));
  return db.select().from(timeRecords).where(and(...conditions)).orderBy(desc(timeRecords.recordedAt));
}

export async function createTimeRecord(data: InsertTimeRecord) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.insert(timeRecords).values(data);
}

export async function getMonthlyHours(employeeId: number, year: number, month: number) {
  const db = await getDb();
  if (!db) return { totalHours: 0, records: [] };
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59);
  const records = await db.select().from(timeRecords)
    .where(and(eq(timeRecords.employeeId, employeeId), gte(timeRecords.recordedAt, toMysqlDateTime(start)), lte(timeRecords.recordedAt, toMysqlDateTime(end))))
    .orderBy(timeRecords.recordedAt);
  const totalHours = records.reduce((sum, r) => sum + parseFloat(String(r.hoursWorked ?? 0)), 0);
  return { totalHours, records };
}

// ─── RH: EXTRA RATES ──────────────────────────────────────────────────────────
export async function getExtraRates() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(extraRates).orderBy(extraRates.level);
}

export async function seedExtraRates() {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select().from(extraRates).limit(1);
  if (existing.length > 0) return;
  const defaults = [
    { level: 1, hourlyRate: "8.50", label: "Extra Nível 1" },
    { level: 2, hourlyRate: "7.00", label: "Extra Nível 2" },
    { level: 3, hourlyRate: "6.00", label: "Extra Nível 3" },
    { level: 4, hourlyRate: "5.00", label: "Extra Nível 4" },
    { level: 5, hourlyRate: "4.00", label: "Extra Nível 5" },
  ];
  await db.insert(extraRates).values(defaults);
}

export async function updateExtraRate(level: number, hourlyRate: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(extraRates).set({ hourlyRate }).where(eq(extraRates.level, level));
}

// ─── RH: STATS ────────────────────────────────────────────────────────────────
export async function getHRStats() {
  const db = await getDb();
  if (!db) return null;
  const [total] = await db.select({ count: sql<number>`count(*)` }).from(employees).where(eq(employees.isActive, 1));
  const [extras] = await db.select({ count: sql<number>`count(*)` }).from(employees).where(and(eq(employees.isActive, 1), eq(employees.position, "extra")));
  const [permanent] = await db.select({ count: sql<number>`count(*)` }).from(employees).where(and(eq(employees.isActive, 1), eq(employees.contractType, "permanent")));

  // Total hours this month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [hoursRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(${timeRecords.hoursWorked}), 0)` })
    .from(timeRecords)
    .where(gte(timeRecords.recordedAt, toMysqlDateTime(monthStart)));

  return {
    totalActive: total?.count ?? 0,
    totalExtras: extras?.count ?? 0,
    totalPermanent: permanent?.count ?? 0,
    monthlyHours: parseFloat(String(hoursRow?.total ?? 0)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECTS — TREE STRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════

export async function getProjects() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(projects).orderBy(projects.name);
}

export async function getProjectById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0];
}

export async function createProject(data: InsertProject) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(projects).values(data);
}

export async function updateProject(id: number, data: Partial<InsertProject>) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(projects).set(data).where(eq(projects.id, id));
}

export async function deleteProject(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Delete children first
  await db.delete(projects).where(eq(projects.parentId, id));
  await db.delete(projects).where(eq(projects.id, id));
}

// ─── SEED PROJECT HIERARCHY (Multipark) ──────────────────────────────────────
// Grupo → Cidade → Marca → Projeto
// Excepções: Top-Parking e Lispark ficam directamente na cidade (sem marca)

export async function seedProjectHierarchy() {
  const db = await getDb();
  if (!db) return;

  // Check if group already exists
  const existing = await db.select().from(projects)
    .where(and(eq(projects.name, "Multipark"), eq(projects.level, "group")))
    .limit(1);
  if (existing.length > 0) return;

  // 1. Grupo
  const [group] = await db.insert(projects).values({
    name: "Multipark",
    level: "group",
    color: "#6366f1",
  } as any).$returningId();

  // 2. Cidades
  const cityCfg = [
    { name: "Lisboa", color: "#3b82f6" },
    { name: "Porto", color: "#10b981" },
    { name: "Faro", color: "#f59e0b" },
  ];
  const cityIds: Record<string, number> = {};
  for (const c of cityCfg) {
    const [row] = await db.insert(projects).values({
      name: c.name, level: "city", parentId: group.id, color: c.color,
    } as any).$returningId();
    cityIds[c.name] = row.id;
  }

  // 3. Marcas (Airpark, Redpark, Skypark) — só nas cidades onde existem
  const brandCfg: { name: string; cities: string[]; color: string }[] = [
    { name: "Airpark", cities: ["Lisboa", "Porto", "Faro"], color: "#ef4444" },
    { name: "Redpark", cities: ["Lisboa", "Porto", "Faro"], color: "#e11d48" },
    { name: "Skypark", cities: ["Lisboa", "Porto", "Faro"], color: "#8b5cf6" },
  ];
  // brandIds["Airpark:Lisboa"] = id
  const brandIds: Record<string, number> = {};
  for (const b of brandCfg) {
    for (const city of b.cities) {
      const [row] = await db.insert(projects).values({
        name: b.name, level: "brand", parentId: cityIds[city], color: b.color,
      } as any).$returningId();
      brandIds[`${b.name}:${city}`] = row.id;
    }
  }

  // 4. Projetos (parques) — dentro da marca, ou directamente na cidade
  const parkCfg: { name: string; city: string; brand?: string; color: string }[] = [
    { name: "Airpark Lisboa", city: "Lisboa", brand: "Airpark", color: "#ef4444" },
    { name: "Redpark Lisboa", city: "Lisboa", brand: "Redpark", color: "#e11d48" },
    { name: "Skypark Lisboa", city: "Lisboa", brand: "Skypark", color: "#8b5cf6" },
    { name: "Lispark Lisboa", city: "Lisboa", color: "#ec4899" },           // sem marca
    { name: "Top-Parking Lisboa", city: "Lisboa", color: "#14b8a6" },       // sem marca
    { name: "Airpark Porto", city: "Porto", brand: "Airpark", color: "#ef4444" },
    { name: "Redpark Porto", city: "Porto", brand: "Redpark", color: "#e11d48" },
    { name: "Skypark Porto", city: "Porto", brand: "Skypark", color: "#8b5cf6" },
    { name: "Airpark Faro", city: "Faro", brand: "Airpark", color: "#ef4444" },
    { name: "Redpark Faro", city: "Faro", brand: "Redpark", color: "#e11d48" },
    { name: "Skypark Faro", city: "Faro", brand: "Skypark", color: "#8b5cf6" },
  ];

  for (const p of parkCfg) {
    const parentId = p.brand
      ? brandIds[`${p.brand}:${p.city}`]
      : cityIds[p.city];
    await db.insert(projects).values({
      name: p.name, level: "project", parentId, color: p.color,
    } as any);
  }

  console.log("[Seed] Hierarchy created: Multipark → 3 cities → brands → 10 parks");
}

// ─── MOVE PROJECT (change parentId) ──────────────────────────────────────────

export async function moveProject(id: number, newParentId: number | null) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Prevent moving to self or to a descendant
  if (newParentId === id) throw new Error("Não pode mover para si próprio");
  if (newParentId !== null) {
    let current = newParentId;
    while (current) {
      const [parent] = await db.select({ id: projects.id, parentId: projects.parentId })
        .from(projects).where(eq(projects.id, current)).limit(1);
      if (!parent) break;
      if (parent.parentId === id) throw new Error("Não pode mover para um descendente");
      current = parent.parentId!;
    }
  }
  await db.update(projects).set({ parentId: newParentId } as any).where(eq(projects.id, id));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT ↔ EMPLOYEE ASSIGNMENTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getProjectEmployees(projectId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(projectEmployees).where(eq(projectEmployees.projectId, projectId));
}

export async function getEmployeeProjects(employeeId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(projectEmployees).where(eq(projectEmployees.employeeId, employeeId));
}

export async function assignEmployeeToProject(data: InsertProjectEmployee) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(projectEmployees).values(data);
}

export async function removeEmployeeFromProject(projectId: number, employeeId: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(projectEmployees).where(
    and(eq(projectEmployees.projectId, projectId), eq(projectEmployees.employeeId, employeeId))
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS — KANBAN
// ═══════════════════════════════════════════════════════════════════════════════

export async function getTasks(filters?: {
  projectId?: number;
  assigneeId?: number;
  status?: string;
}) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [];
  if (filters?.projectId) conds.push(eq(tasks.projectId, filters.projectId));
  if (filters?.assigneeId) conds.push(eq(tasks.assigneeId, filters.assigneeId));
  if (filters?.status) conds.push(eq(tasks.taskStatus, filters.status as any));
  return db.select().from(tasks)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(tasks.updatedAt));
}

export async function getTaskById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return rows[0];
}

export async function createTask(data: InsertTask): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(tasks).values(data);
  return (result as any).insertId as number;
}

export async function updateTask(id: number, data: Partial<InsertTask>) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(tasks).set(data).where(eq(tasks.id, id));
}

export async function deleteTask(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(tasks).where(eq(tasks.id, id));
}

/**
 * Devolve tasks com a lista de assignees (employees) e nome do projeto
 * em uma só query — evita N+1 no frontend.
 */
export async function getTasksWithAssignees(filters?: {
  projectId?: number;
  assigneeId?: number;
  status?: string;
}): Promise<Array<any & { assignees: Array<{ id: number; fullName: string }>; projectName: string | null }>> {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [];
  if (filters?.projectId) conds.push(eq(tasks.projectId, filters.projectId));
  if (filters?.status) conds.push(eq(tasks.taskStatus, filters.status as any));

  const taskRows = await db
    .select({ task: tasks, projectName: projects.name })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(tasks.updatedAt));

  if (taskRows.length === 0) return [];
  const taskIds = taskRows.map(r => r.task.id);

  const assigneeRows = await db
    .select({
      taskId: taskAssignees.taskId,
      employeeId: taskAssignees.employeeId,
      fullName: employees.fullName,
    })
    .from(taskAssignees)
    .innerJoin(employees, eq(employees.id, taskAssignees.employeeId))
    .where(inArray(taskAssignees.taskId, taskIds));

  const assigneesByTask = new Map<number, Array<{ id: number; fullName: string }>>();
  for (const r of assigneeRows) {
    if (!assigneesByTask.has(r.taskId)) assigneesByTask.set(r.taskId, []);
    assigneesByTask.get(r.taskId)!.push({ id: r.employeeId, fullName: r.fullName });
  }

  let result = taskRows.map(r => ({
    ...r.task,
    projectName: r.projectName,
    assignees: assigneesByTask.get(r.task.id) ?? [],
  }));

  // assigneeId filter — apply after join because pode estar em assignees
  if (filters?.assigneeId) {
    const want = filters.assigneeId;
    result = result.filter(t => t.assigneeId === want || t.assignees.some(a => a.id === want));
  }

  return result;
}

export async function getTaskStats() {
  const db = await getDb();
  if (!db) return { total: 0, backlog: 0, todo: 0, inProgress: 0, review: 0, done: 0, overdue: 0 };
  const all = await db.select().from(tasks);
  const now = new Date();
  return {
    total: all.length,
    backlog: all.filter(t => t.taskStatus === "backlog").length,
    todo: all.filter(t => t.taskStatus === "todo").length,
    inProgress: all.filter(t => t.taskStatus === "in_progress").length,
    review: all.filter(t => t.taskStatus === "review").length,
    done: all.filter(t => t.taskStatus === "done").length,
    overdue: all.filter(t => t.dueDate && new Date(t.dueDate) < now && t.taskStatus !== "done").length,
  };
}

// ─── MARKETING: CAMPAIGNS ────────────────────────────────────────────────────

export async function getCampaigns(filters: { platform?: string; projectId?: number; status?: string } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters.platform) conditions.push(eq(campaigns.platform, filters.platform as any));
  if (filters.projectId) {
    // Include campaigns from child projects
    const allProjects = await db.select().from(projects);
    const ids = new Set<number>();
    const addChildren = (parentId: number) => {
      ids.add(parentId);
      for (const p of allProjects) {
        if (p.parentId === parentId) addChildren(p.id);
      }
    };
    addChildren(filters.projectId);
    conditions.push(sql`${campaigns.projectId} IN (${sql.raw(Array.from(ids).join(",") || "0")})`);
  }
  if (filters.status) conditions.push(eq(campaigns.campaignStatus, filters.status as any));
  const q = db.select({ campaign: campaigns, project: projects }).from(campaigns)
    .leftJoin(projects, eq(campaigns.projectId, projects.id))
    .orderBy(desc(campaigns.createdAt));
  return conditions.length > 0 ? q.where(and(...conditions)) : q;
}

export async function getCampaignById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  return result[0];
}

export async function createCampaign(data: InsertCampaign) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(campaigns).values(data);
  return result[0].insertId;
}

export async function updateCampaign(id: number, data: Partial<InsertCampaign>) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(campaigns).set(data).where(eq(campaigns.id, id));
}

export async function deleteCampaign(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.delete(campaignDailyStats).where(eq(campaignDailyStats.campaignId, id));
  await db.delete(campaigns).where(eq(campaigns.id, id));
}

// ─── MARKETING: DAILY STATS ─────────────────────────────────────────────────

export async function getCampaignStats(campaignId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(campaignDailyStats)
    .where(eq(campaignDailyStats.campaignId, campaignId))
    .orderBy(desc(campaignDailyStats.date));
}

export async function getAllDailyStats(filters: { from?: Date; to?: Date; projectId?: number } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters.from) conditions.push(gte(campaignDailyStats.date, toMysqlDateTime(filters.from)));
  if (filters.to) conditions.push(lte(campaignDailyStats.date, toMysqlDateTime(filters.to)));
  if (filters.projectId) {
    const allProjects = await db.select().from(projects);
    const ids = new Set<number>();
    const addChildren = (parentId: number) => { ids.add(parentId); for (const p of allProjects) { if (p.parentId === parentId) addChildren(p.id); } };
    addChildren(filters.projectId);
    conditions.push(sql`${campaigns.projectId} IN (${sql.raw(Array.from(ids).join(","))})`);
  }
  const q = db.select({ stat: campaignDailyStats, campaign: campaigns, project: projects })
    .from(campaignDailyStats)
    .leftJoin(campaigns, eq(campaignDailyStats.campaignId, campaigns.id))
    .leftJoin(projects, eq(campaigns.projectId, projects.id))
    .orderBy(desc(campaignDailyStats.date));
  return conditions.length > 0 ? q.where(and(...conditions)) : q;
}

export async function importDailyStats(rows: InsertCampaignDailyStat[]) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  if (rows.length === 0) return;
  await db.insert(campaignDailyStats).values(rows);
}

export async function deleteDailyStat(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.delete(campaignDailyStats).where(eq(campaignDailyStats.id, id));
}

// ─── MARKETING: EXPENSES ─────────────────────────────────────────────────────

export async function getMarketingExpenses(filters: { category?: string; projectId?: number; from?: Date; to?: Date } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters.category) conditions.push(eq(marketingExpenses.mktCategory, filters.category as any));
  if (filters.projectId) conditions.push(eq(marketingExpenses.projectId, filters.projectId));
  if (filters.from) conditions.push(gte(marketingExpenses.date, toMysqlDateTime(filters.from)));
  if (filters.to) conditions.push(lte(marketingExpenses.date, toMysqlDateTime(filters.to)));
  const q = db.select({ expense: marketingExpenses, project: projects }).from(marketingExpenses)
    .leftJoin(projects, eq(marketingExpenses.projectId, projects.id))
    .orderBy(desc(marketingExpenses.date));
  return conditions.length > 0 ? q.where(and(...conditions)) : q;
}

export async function createMarketingExpense(data: InsertMarketingExpense) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(marketingExpenses).values(data);
  return result[0].insertId;
}

export async function updateMarketingExpense(id: number, data: Partial<InsertMarketingExpense>) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(marketingExpenses).set(data).where(eq(marketingExpenses.id, id));
}

export async function deleteMarketingExpense(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.delete(marketingExpenses).where(eq(marketingExpenses.id, id));
}

// ─── MARKETING: DASHBOARD STATS ──────────────────────────────────────────────

export async function getMarketingDashboardStats(filters: { from?: Date; to?: Date; projectId?: number } = {}) {
  const db = await getDb();
  if (!db) return { totalSpend: 0, totalReservations: 0, costPerReservation: 0, avgConversionValue: 0, totalMktExpenses: 0, campaignCount: 0 };

  // Resolve project hierarchy if filtering
  let projectIds: Set<number> | null = null;
  if (filters.projectId) {
    const allProjects = await db.select().from(projects);
    projectIds = new Set<number>();
    const addChildren = (parentId: number) => { projectIds!.add(parentId); for (const p of allProjects) { if (p.parentId === parentId) addChildren(p.id); } };
    addChildren(filters.projectId);
  }

  // Stats from campaign daily stats (join campaigns to filter by projectId)
  const conditions: any[] = [];
  if (filters.from) conditions.push(gte(campaignDailyStats.date, toMysqlDateTime(filters.from)));
  if (filters.to) conditions.push(lte(campaignDailyStats.date, toMysqlDateTime(filters.to)));
  if (projectIds) conditions.push(sql`${campaigns.projectId} IN (${sql.raw(Array.from(projectIds).join(","))})`);

  const statsQ = db.select({
    totalSpend: sql<string>`COALESCE(SUM(${campaignDailyStats.spend}), 0)`,
    totalReservations: sql<number>`COALESCE(SUM(${campaignDailyStats.conversions}), 0)`,
    totalConversionValue: sql<string>`COALESCE(SUM(${campaignDailyStats.conversionValue}), 0)`,
    totalImpressions: sql<number>`COALESCE(SUM(${campaignDailyStats.impressions}), 0)`,
    totalClicks: sql<number>`COALESCE(SUM(${campaignDailyStats.clicks}), 0)`,
  }).from(campaignDailyStats)
    .innerJoin(campaigns, eq(campaignDailyStats.campaignId, campaigns.id));
  const statsResult = conditions.length > 0 ? await statsQ.where(and(...conditions)) : await statsQ;
  const s = statsResult[0];

  // Marketing expenses
  const mktConditions: any[] = [];
  if (filters.from) mktConditions.push(gte(marketingExpenses.date, toMysqlDateTime(filters.from)));
  if (filters.to) mktConditions.push(lte(marketingExpenses.date, toMysqlDateTime(filters.to)));
  if (projectIds) mktConditions.push(sql`${marketingExpenses.projectId} IN (${sql.raw(Array.from(projectIds).join(","))})`);
  const mktQ = db.select({
    total: sql<string>`COALESCE(SUM(${marketingExpenses.amount}), 0)`,
  }).from(marketingExpenses);
  const mktResult = mktConditions.length > 0 ? await mktQ.where(and(...mktConditions)) : await mktQ;

  // Campaign count
  const campConditions: any[] = [];
  if (projectIds) campConditions.push(sql`${campaigns.projectId} IN (${sql.raw(Array.from(projectIds).join(","))})`);
  const campQ = db.select({ count: sql<number>`COUNT(*)` }).from(campaigns);
  const campCount = campConditions.length > 0 ? await campQ.where(and(...campConditions)) : await campQ;

  // ── Gasto estimado (orçamento diário × dias) + reservas REAIS por link ──
  // O Dashboard deixa de depender só de campaign_daily_stats (que pode estar
  // vazio): usa o orçamento das campanhas e atribui reservas reais via os links
  // (internal_campaign_keys campaignType='ad').
  const periodDays = filters.from && filters.to
    ? Math.max(1, Math.floor((filters.to.getTime() - filters.from.getTime()) / 86400000) + 1)
    : 30;
  const campRowsQ = db.select({ id: campaigns.id, budget: campaigns.budget }).from(campaigns);
  const campRows = campConditions.length > 0 ? await campRowsQ.where(and(...campConditions)) : await campRowsQ;
  const campIdSet = new Set(campRows.map((c) => c.id));
  const budgetSpend = campRows.reduce((acc, c) => acc + parseFloat((c.budget as any) || "0"), 0) * periodDays;

  const keysRaw: any = await db.execute(sql`SELECT campaignId, keyType, keyValue FROM internal_campaign_keys WHERE campaignType = 'ad'`);
  const keys = ((Array.isArray(keysRaw[0]) ? keysRaw[0] : keysRaw) as any[]).filter((k) => campIdSet.has(k.campaignId));
  let linkReservations = 0, linkRevenue = 0;
  if (keys.length) {
    const conds: any[] = [];
    const names = keys.filter((k) => k.keyType === "campaign_name").map((k) => k.keyValue);
    if (names.length) conds.push(sql`campaignName IN (${sql.join(names.map((v: string) => sql`${v}`), sql`, `)})`);
    for (const k of keys.filter((k) => k.keyType === "campaign_id")) conds.push(sql`originUrl LIKE ${"%campaignId=" + k.keyValue + "%"}`);
    for (const k of keys.filter((k) => k.keyType === "url_pattern")) conds.push(sql`originUrl LIKE ${k.keyValue}`);
    if (conds.length) {
      const dateC = filters.from && filters.to ? sql` AND checkIn >= ${toMysqlDateTime(filters.from)} AND checkIn <= ${toMysqlDateTime(filters.to)}` : sql``;
      const r: any = await db.execute(sql`SELECT COUNT(*) AS c, COALESCE(SUM(totalPrice),0) AS rev FROM multipark_bookings WHERE (${sql.join(conds, sql` OR `)})${dateC}`);
      const row = (Array.isArray(r[0]) ? r[0] : r)[0];
      linkReservations = Number(row?.c ?? 0); linkRevenue = Number(row?.rev ?? 0);
    }
  }

  const realSpend = parseFloat(s.totalSpend || "0"); // de campaign_daily_stats (real, quando importado do Google Ads)
  const totalSpend = realSpend > 0 ? realSpend : budgetSpend; // senão estima por orçamento
  const totalReservations = linkReservations > 0 ? linkReservations : (s.totalReservations || 0);
  const conversionValue = linkRevenue > 0 ? linkRevenue : parseFloat(s.totalConversionValue || "0");
  const totalMktExpenses = parseFloat(mktResult[0].total || "0");

  return {
    totalSpend,
    spendEstimated: realSpend === 0 && budgetSpend > 0,
    totalReservations,
    totalRevenue: conversionValue,
    costPerReservation: totalReservations > 0 ? (totalSpend + totalMktExpenses) / totalReservations : 0,
    avgConversionValue: totalReservations > 0 ? conversionValue / totalReservations : 0,
    totalMktExpenses,
    campaignCount: campCount[0].count,
    totalImpressions: s.totalImpressions || 0,
    totalClicks: s.totalClicks || 0,
  };
}

export async function getBookingRevenueByProject(filters: { from?: string; to?: string; projectId?: number } = {}) {
  const db = await getDb();
  if (!db) return { total: 0, revenue: 0, byProject: [] as { projectId: number | null; parkName: string; count: number; revenue: number }[] };

  const conditions: any[] = [
    sql`${multiparkBookings.status} != 'CANCELLED'`,
  ];
  if (filters.from) conditions.push(gte(multiparkBookings.bookingCreatedAt, filters.from));
  if (filters.to) conditions.push(lte(multiparkBookings.bookingCreatedAt, filters.to + " 23:59:59"));
  if (filters.projectId) {
    // Also match children: get all project IDs under this parent
    const allProjects = await db.select().from(projects);
    const ids = new Set<number>();
    const addChildren = (parentId: number) => {
      ids.add(parentId);
      for (const p of allProjects) {
        if (p.parentId === parentId) addChildren(p.id);
      }
    };
    addChildren(filters.projectId);
    conditions.push(sql`${multiparkBookings.projectId} IN (${sql.raw(Array.from(ids).join(","))})`);
  }

  const rows = await db.select({
    parkName: multiparkBookings.parkName,
    city: multiparkBookings.city,
    count: sql<number>`COUNT(*)`,
    revenue: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
  })
    .from(multiparkBookings)
    .where(and(...conditions))
    .groupBy(multiparkBookings.parkName, multiparkBookings.city);

  const byProject = rows.map(r => {
    const name = r.parkName || "Desconhecido";
    const city = r.city || "";
    // If park name doesn't include city, append it
    const displayName = city && !name.includes(city) ? `${name} ${city}` : name;
    return {
      projectId: null,
      parkName: displayName,
      count: r.count,
      revenue: parseFloat(r.revenue || "0"),
    };
  });

  return {
    total: byProject.reduce((s, r) => s + r.count, 0),
    revenue: byProject.reduce((s, r) => s + r.revenue, 0),
    byProject,
  };
}

// ─── OPERACIONAL: VEHICLES ──────────────────────────────────────────────────

export async function getVehicles(filters?: { status?: string; projectId?: number }) {
  const db = await getDb();
  if (!db) return [];
  let query = db.select().from(vehicles).orderBy(desc(vehicles.createdAt));
  const conditions: any[] = [];
  if (filters?.status) conditions.push(eq(vehicles.vehicleStatus, filters.status as any));
  if (filters?.projectId) conditions.push(eq(vehicles.projectId, filters.projectId));
  if (conditions.length > 0) query = query.where(and(...conditions) as any) as any;
  return query;
}

export async function getVehicleById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
  return result[0];
}

export async function createVehicle(data: InsertVehicle) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(vehicles).values(data);
  return result[0].insertId;
}

export async function updateVehicle(id: number, data: Partial<InsertVehicle>) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(vehicles).set(data).where(eq(vehicles.id, id));
}

export async function deleteVehicle(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(vehicles).where(eq(vehicles.id, id));
}

// ─── OPERACIONAL: VEHICLE MOVEMENTS ─────────────────────────────────────────

export async function getVehicleMovements(filters?: { vehicleId?: number; employeeId?: number; limit?: number }) {
  const db = await getDb();
  if (!db) return [];
  let query = db.select().from(vehicleMovements).orderBy(desc(vehicleMovements.createdAt));
  const conditions: any[] = [];
  if (filters?.vehicleId) conditions.push(eq(vehicleMovements.vehicleId, filters.vehicleId));
  if (filters?.employeeId) conditions.push(eq(vehicleMovements.employeeId, filters.employeeId));
  if (conditions.length > 0) query = query.where(and(...conditions) as any) as any;
  if (filters?.limit) query = query.limit(filters.limit) as any;
  return query;
}

export async function createVehicleMovement(data: InsertVehicleMovement) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(vehicleMovements).values(data);
  return result[0].insertId;
}

// ─── OPERACIONAL: SPEED ALERTS ──────────────────────────────────────────────

export async function getSpeedAlerts(filters?: { vehicleId?: number; acknowledged?: boolean; limit?: number }) {
  const db = await getDb();
  if (!db) return [];
  let query = db.select().from(speedAlerts).orderBy(desc(speedAlerts.createdAt));
  const conditions: any[] = [];
  if (filters?.vehicleId) conditions.push(eq(speedAlerts.vehicleId, filters.vehicleId));
  if (filters?.acknowledged !== undefined) conditions.push(eq(speedAlerts.acknowledged, filters.acknowledged ? 1 : 0));
  if (conditions.length > 0) query = query.where(and(...conditions) as any) as any;
  if (filters?.limit) query = query.limit(filters.limit) as any;
  return query;
}

export async function createSpeedAlert(data: InsertSpeedAlert) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(speedAlerts).values(data);
  return result[0].insertId;
}

export async function acknowledgeSpeedAlert(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(speedAlerts).set({ acknowledged: 1, acknowledgedById: userId, acknowledgedAt: toMysqlDateTime(new Date()) }).where(eq(speedAlerts.id, id));
}

// ─── OPERACIONAL: RADIO TRANSCRIPTIONS ──────────────────────────────────────

export async function getRadioTranscriptions(filters?: { employeeId?: number; vehicleId?: number; limit?: number }) {
  const db = await getDb();
  if (!db) return [];
  let query = db.select().from(radioTranscriptions).orderBy(desc(radioTranscriptions.createdAt));
  const conditions: any[] = [];
  if (filters?.employeeId) conditions.push(eq(radioTranscriptions.employeeId, filters.employeeId));
  if (filters?.vehicleId) conditions.push(eq(radioTranscriptions.vehicleId, filters.vehicleId));
  if (conditions.length > 0) query = query.where(and(...conditions) as any) as any;
  if (filters?.limit) query = query.limit(filters.limit) as any;
  return query;
}

export async function createRadioTranscription(data: InsertRadioTranscription) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(radioTranscriptions).values(data);
  return result[0].insertId;
}

// ─── OPERACIONAL: DASHBOARD STATS ───────────────────────────────────────────

export async function getOperationalStats() {
  const db = await getDb();
  if (!db) return { totalVehicles: 0, activeVehicles: 0, todayAlerts: 0, unacknowledgedAlerts: 0, todayMovements: 0 };
  const allVehicles = await db.select().from(vehicles);
  const totalVehicles = allVehicles.length;
  const activeVehicles = allVehicles.filter(v => v.vehicleStatus === "active").length;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = toMysqlDateTime(today);
  const allAlerts = await db.select().from(speedAlerts).where(gte(speedAlerts.createdAt, todayStr));
  const todayAlerts = allAlerts.length;
  const allUnack = await db.select().from(speedAlerts).where(eq(speedAlerts.acknowledged, 0));
  const unacknowledgedAlerts = allUnack.length;

  const allMovements = await db.select().from(vehicleMovements).where(gte(vehicleMovements.createdAt, todayStr));
  const todayMovements = allMovements.length;

  return { totalVehicles, activeVehicles, todayAlerts, unacknowledgedAlerts, todayMovements };
}

export async function getVehicleDriverHistory(vehicleId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(vehicleMovements).where(eq(vehicleMovements.vehicleId, vehicleId)).orderBy(desc(vehicleMovements.createdAt));
}

// ─── API KEYS ────────────────────────────────────────────────────────────────

export async function getApiKeys() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
}

export async function createApiKey(data: Omit<InsertApiKey, "id" | "createdAt">) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(apiKeys).values(data);
  return Number(result[0].insertId);
}

export async function toggleApiKey(id: number, active: boolean) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(apiKeys).set({ active: active ? 1 : 0 }).where(eq(apiKeys.id, id));
}

export async function deleteApiKey(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
}

// ─── RECLAMAÇÕES ─────────────────────────────────────────────────────────────

export async function getComplaints(filters?: { status?: string; type?: string; vehicleId?: number; assignedToId?: number; projectId?: number }) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters?.status) conditions.push(eq(complaints.complaintStatus, filters.status as any));
  if (filters?.type) conditions.push(eq(complaints.complaintType, filters.type as any));
  if (filters?.vehicleId) conditions.push(eq(complaints.vehicleId, filters.vehicleId));
  if (filters?.assignedToId) conditions.push(eq(complaints.assignedToId, filters.assignedToId));
  if (filters?.projectId) conditions.push(eq(complaints.projectId, filters.projectId));
  return db
    .select({ ...getTableColumns(complaints), assignedToName: employees.fullName })
    .from(complaints)
    .leftJoin(employees, eq(complaints.assignedToId, employees.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(complaints.createdAt));
}

export async function getComplaintById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select({ ...getTableColumns(complaints), assignedToName: employees.fullName })
    .from(complaints)
    .leftJoin(employees, eq(complaints.assignedToId, employees.id))
    .where(eq(complaints.id, id))
    .limit(1);
  return result[0];
}

export async function createComplaint(data: Omit<InsertComplaint, "id" | "createdAt" | "updatedAt">) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(complaints).values(data);
  return Number(result[0].insertId);
}

export async function updateComplaint(id: number, data: Partial<InsertComplaint>) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(complaints).set(data).where(eq(complaints.id, id));
}

export async function deleteComplaint(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.delete(complaintPhotos).where(eq(complaintPhotos.complaintId, id));
  await db.delete(complaintMessages).where(eq(complaintMessages.complaintId, id));
  await db.delete(complaints).where(eq(complaints.id, id));
}

export async function getComplaintMessages(complaintId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(complaintMessages).where(eq(complaintMessages.complaintId, complaintId)).orderBy(complaintMessages.createdAt);
}

export async function addComplaintMessage(data: Omit<InsertComplaintMessage, "id" | "createdAt">) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(complaintMessages).values(data);
  return Number(result[0].insertId);
}

export async function getComplaintPhotos(complaintId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(complaintPhotos).where(eq(complaintPhotos.complaintId, complaintId)).orderBy(complaintPhotos.createdAt);
}

export async function addComplaintPhoto(data: Omit<InsertComplaintPhoto, "id" | "createdAt">) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(complaintPhotos).values(data);
  return Number(result[0].insertId);
}

export async function deleteComplaintPhoto(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.delete(complaintPhotos).where(eq(complaintPhotos.id, id));
}

export async function getComplaintStats(projectId?: number) {
  const db = await getDb();
  if (!db) return { total: 0, new: 0, analyzing: 0, waitingClient: 0, resolved: 0, closed: 0, overdue: 0 };
  const all = await db
    .select()
    .from(complaints)
    .where(projectId !== undefined ? eq(complaints.projectId, projectId) : undefined);
  const now = new Date();
  return {
    total: all.length,
    new: all.filter(c => c.complaintStatus === "new").length,
    analyzing: all.filter(c => c.complaintStatus === "analyzing").length,
    waitingClient: all.filter(c => c.complaintStatus === "waiting_client").length,
    resolved: all.filter(c => c.complaintStatus === "resolved").length,
    closed: all.filter(c => c.complaintStatus === "closed").length,
    overdue: all.filter(c => c.slaDeadline && new Date(c.slaDeadline) < now && c.complaintStatus !== "resolved" && c.complaintStatus !== "closed").length,
  };
}

// ─── GOOGLE REVIEWS ───────────────────────────────────────────────────────────

export async function createGoogleReview(data: InsertGoogleReview) {
  const db = await getDb(); if (!db) return;
  const result = await db.insert(googleReviews).values(data);
  return result[0].insertId;
}

export async function getGoogleReviews(filters?: { rating?: number; status?: string; projectId?: number }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = [];
  if (filters?.rating) conditions.push(eq(googleReviews.rating, filters.rating));
  if (filters?.status) conditions.push(eq(googleReviews.status, filters.status as any));
  if (filters?.projectId) conditions.push(eq(googleReviews.projectId, filters.projectId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(googleReviews).where(where).orderBy(desc(googleReviews.createdAt));
}

export async function getGoogleReviewById(id: number) {
  const db = await getDb(); if (!db) return undefined;
  const result = await db.select().from(googleReviews).where(eq(googleReviews.id, id)).limit(1);
  return result[0];
}

export async function updateGoogleReview(id: number, data: Partial<InsertGoogleReview>) {
  const db = await getDb(); if (!db) return;
  await db.update(googleReviews).set(data).where(eq(googleReviews.id, id));
}

export async function getGoogleReviewStats() {
  const db = await getDb(); if (!db) return { total: 0, avg: 0, star1: 0, star2: 0, star3: 0, star4: 0, star5: 0, unrated: 0, pending: 0, responded: 0, complaints: 0 };
  const all = await db.select().from(googleReviews);
  const total = all.length;
  // Média só sobre críticas COM estrelas (rating 0 = classificação desconhecida,
  // ex. importadas por email antes do parser — não pode puxar a média para baixo).
  const rated = all.filter(r => r.rating >= 1);
  const avg = rated.length > 0 ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : 0;
  const star1 = all.filter(r => r.rating === 1).length;
  const star2 = all.filter(r => r.rating === 2).length;
  const star3 = all.filter(r => r.rating === 3).length;
  const star4 = all.filter(r => r.rating === 4).length;
  const star5 = all.filter(r => r.rating === 5).length;
  const unrated = total - rated.length;
  // Respondida DE FACTO = resposta enviada (respondedAt) ou marcada como
  // respondida manualmente. Rascunho da IA (ai_responded) NÃO conta — era isso
  // que fazia o painel dizer que estava tudo respondido.
  const isAnswered = (r: typeof all[number]) => r.respondedAt != null || r.status === "manually_responded";
  const isClosed = (r: typeof all[number]) => r.status === "dismissed" || r.status === "converted_complaint";
  const responded = all.filter(isAnswered).length;
  const pending = all.filter(r => !isAnswered(r) && !isClosed(r)).length;
  const complaints = all.filter(r => r.status === "converted_complaint").length;
  return { total, avg: Math.round(avg * 10) / 10, star1, star2, star3, star4, star5, unrated, pending, responded, complaints };
}

export async function searchClientHistory(name?: string, email?: string, plate?: string) {
  const db = await getDb(); if (!db) return { complaints: [], movements: [], reviews: [] };
  const results: any = { complaints: [], movements: [], reviews: [] };

  // Search complaints by client name/email/plate
  if (name || email || plate) {
    const conds: any[] = [];
    if (name) conds.push(sql`${complaints.clientName} LIKE ${'%' + name + '%'}`);
    if (email) conds.push(sql`${complaints.clientEmail} LIKE ${'%' + email + '%'}`);
    if (plate) conds.push(sql`${complaints.vehiclePlate} LIKE ${'%' + plate + '%'}`);
    results.complaints = await db.select().from(complaints).where(or(...conds)).limit(20);
  }

  // Search vehicle movements by plate
  if (plate) {
    const vehs = await db.select().from(vehicles).where(sql`${vehicles.plate} LIKE ${'%' + plate + '%'}`).limit(5);
    if (vehs.length > 0) {
      results.movements = await db.select().from(vehicleMovements).where(eq(vehicleMovements.vehicleId, vehs[0].id)).orderBy(desc(vehicleMovements.createdAt)).limit(20);
    }
  }

  // Search previous reviews by name/email
  if (name || email) {
    const rConds: any[] = [];
    if (name) rConds.push(sql`${googleReviews.reviewerName} LIKE ${'%' + name + '%'}`);
    if (email) rConds.push(sql`${googleReviews.reviewerEmail} LIKE ${'%' + email + '%'}`);
    results.reviews = await db.select().from(googleReviews).where(or(...rConds)).limit(20);
  }

  return results;
}


// ─── FORMAÇÃO E APOIO ─────────────────────────────────────────────────────────

export async function getTrainingCategories() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(trainingCategories).orderBy(trainingCategories.sortOrder);
}

export async function createTrainingCategory(data: { name: string; description?: string; icon?: string; sortOrder?: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(trainingCategories).values(data).$returningId();
  return result;
}

export async function deleteTrainingCategory(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(trainingCategories).where(eq(trainingCategories.id, id));
}

export async function getTrainingVideos(categoryId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions = categoryId ? [eq(trainingVideos.categoryId, categoryId)] : [];
  return db.select().from(trainingVideos).where(conditions.length ? and(...conditions) : undefined).orderBy(trainingVideos.sortOrder);
}

export async function createTrainingVideo(data: { categoryId: number; title: string; description?: string; videoUrl: string; thumbnailUrl?: string; durationMinutes?: number; sortOrder?: number; createdBy?: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(trainingVideos).values(data).$returningId();
  return result;
}

export async function deleteTrainingVideo(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(trainingVideos).where(eq(trainingVideos.id, id));
}

export async function getTrainingManuals(categoryId?: number, type?: string) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(trainingManuals.published, 1)];
  if (categoryId) conditions.push(eq(trainingManuals.categoryId, categoryId));
  if (type) conditions.push(eq(trainingManuals.type, type as any));
  return db.select().from(trainingManuals).where(and(...conditions)).orderBy(desc(trainingManuals.createdAt));
}

export async function createTrainingManual(data: { categoryId?: number; title: string; content: string; type?: "manual" | "update" | "news" | "procedure"; createdBy?: number; fileUrl?: string; fileKey?: string; fileName?: string; fileMimeType?: string }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(trainingManuals).values(data).$returningId();
  return result;
}

export async function updateTrainingManual(id: number, data: { title?: string; content?: string; type?: "manual" | "update" | "news" | "procedure"; published?: boolean; fileUrl?: string; fileKey?: string; fileName?: string; fileMimeType?: string }) {
  const db = await getDb();
  if (!db) return;
  const { published, ...rest } = data;
  const updates: Record<string, unknown> = { ...rest };
  if (published !== undefined) updates.published = published ? 1 : 0;
  await db.update(trainingManuals).set(updates).where(eq(trainingManuals.id, id));
}

export async function deleteTrainingManual(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(trainingManuals).where(eq(trainingManuals.id, id));
}

export async function getFAQs(categoryId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions = categoryId ? [eq(faqs.categoryId, categoryId)] : [];
  return db.select().from(faqs).where(conditions.length ? and(...conditions) : undefined).orderBy(faqs.sortOrder);
}

export async function createFAQ(data: { categoryId?: number; question: string; answer: string; sortOrder?: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(faqs).values(data).$returningId();
  return result;
}

export async function updateFAQ(id: number, data: { question?: string; answer?: string; sortOrder?: number }) {
  const db = await getDb();
  if (!db) return;
  await db.update(faqs).set(data).where(eq(faqs.id, id));
}

export async function deleteFAQ(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(faqs).where(eq(faqs.id, id));
}

export async function getQuizQuestions(categoryId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions = categoryId ? [eq(quizQuestions.categoryId, categoryId)] : [];
  return db.select().from(quizQuestions).where(conditions.length ? and(...conditions) : undefined);
}

/** Versão pública: nunca devolve a resposta correcta nem a explicação.
 *  Usar nos players (jogadores) para evitar que possam fazer fetch direto
 *  à API e ver a opção correcta. */
export async function getQuizQuestionsForPlayer(categoryId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions = categoryId ? [eq(quizQuestions.categoryId, categoryId)] : [];
  return db
    .select({
      id: quizQuestions.id,
      categoryId: quizQuestions.categoryId,
      question: quizQuestions.question,
      optionA: quizQuestions.optionA,
      optionB: quizQuestions.optionB,
      optionC: quizQuestions.optionC,
      optionD: quizQuestions.optionD,
      difficulty: quizQuestions.difficulty,
      points: quizQuestions.points,
    })
    .from(quizQuestions)
    .where(conditions.length ? and(...conditions) : undefined);
}

export async function createQuizQuestion(data: { categoryId?: number; question: string; optionA: string; optionB: string; optionC: string; optionD: string; correctOption: "A" | "B" | "C" | "D"; explanation?: string; difficulty?: "easy" | "medium" | "hard"; points?: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(quizQuestions).values(data).$returningId();
  return result;
}

export async function deleteQuizQuestion(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(quizQuestions).where(eq(quizQuestions.id, id));
}

export async function saveQuizAttempt(data: { employeeId: number; totalQuestions: number; correctAnswers: number; score: number; timeSpentSeconds?: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(quizAttempts).values(data).$returningId();
  return result;
}

export async function getQuizRanking() {
  const db = await getDb();
  if (!db) return [];
  return db.select({
    employeeId: quizAttempts.employeeId,
    totalScore: sql<number>`SUM(${quizAttempts.score})`,
    totalAttempts: sql<number>`COUNT(*)`,
    bestScore: sql<number>`MAX(${quizAttempts.score})`,
  }).from(quizAttempts).groupBy(quizAttempts.employeeId).orderBy(desc(sql`SUM(${quizAttempts.score})`));
}

export async function getCareerExams() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(careerExams).orderBy(careerExams.level);
}

export async function createCareerExam(data: { level: "extra" | "condutor" | "senior" | "team_leader" | "supervisor"; title: string; description?: string; passingScore: number; timeLimitMinutes?: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(careerExams).values(data).$returningId();
  return result;
}

export async function getCareerExamQuestions(examId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(careerExamQuestions).where(eq(careerExamQuestions.examId, examId));
}

/** Versão para o jogador — sem correctOption e sem explicação. */
export async function getCareerExamQuestionsForPlayer(examId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: careerExamQuestions.id,
      examId: careerExamQuestions.examId,
      question: careerExamQuestions.question,
      optionA: careerExamQuestions.optionA,
      optionB: careerExamQuestions.optionB,
      optionC: careerExamQuestions.optionC,
      optionD: careerExamQuestions.optionD,
      points: careerExamQuestions.points,
    })
    .from(careerExamQuestions)
    .where(eq(careerExamQuestions.examId, examId));
}

export async function createCareerExamQuestion(data: { examId: number; question: string; optionA: string; optionB: string; optionC: string; optionD: string; correctOption: "A" | "B" | "C" | "D"; explanation?: string; points?: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(careerExamQuestions).values(data).$returningId();
  return result;
}

export async function saveCareerExamAttempt(data: { examId: number; employeeId: number; totalQuestions: number; correctAnswers: number; score: number; passed: boolean; timeSpentSeconds?: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const { passed, ...rest } = data;
  const [result] = await db.insert(careerExamAttempts).values({ ...rest, passed: passed ? 1 : 0 }).$returningId();
  return result;
}

export async function getCareerExamAttempts(employeeId?: number, examId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (employeeId) conditions.push(eq(careerExamAttempts.employeeId, employeeId));
  if (examId) conditions.push(eq(careerExamAttempts.examId, examId));
  return db.select().from(careerExamAttempts).where(conditions.length ? and(...conditions) : undefined).orderBy(desc(careerExamAttempts.createdAt));
}

export async function deleteCareerExam(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(careerExamQuestions).where(eq(careerExamQuestions.examId, id));
  await db.delete(careerExamAttempts).where(eq(careerExamAttempts.examId, id));
  await db.delete(careerExams).where(eq(careerExams.id, id));
}

// ─── PERDIDOS E ACHADOS ───────────────────────────────────────────────────────
export async function createLostFoundItem(data: Omit<LostFoundItem, "id" | "createdAt" | "updatedAt">) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(lostFoundItems).values(data as any).$returningId();
  return result.id;
}

export async function getLostFoundItems(filters?: { status?: string; itemType?: string; projectId?: number; search?: string }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = [];
  if (filters?.status) conditions.push(eq(lostFoundItems.status, filters.status as any));
  if (filters?.itemType) conditions.push(eq(lostFoundItems.itemType, filters.itemType as any));
  if (filters?.projectId) conditions.push(eq(lostFoundItems.projectId, filters.projectId));
  if (filters?.search) conditions.push(or(
    like(lostFoundItems.clientName, `%${filters.search}%`),
    like(lostFoundItems.description, `%${filters.search}%`),
    like(lostFoundItems.vehiclePlate, `%${filters.search}%`),
  ));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(lostFoundItems).where(where).orderBy(desc(lostFoundItems.createdAt));
}

export async function getLostFoundItemById(id: number) {
  const db = await getDb(); if (!db) return null;
  const rows = await db.select().from(lostFoundItems).where(eq(lostFoundItems.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateLostFoundItem(id: number, data: Partial<LostFoundItem>) {
  const db = await getDb(); if (!db) return;
  await db.update(lostFoundItems).set(data as any).where(eq(lostFoundItems.id, id));
}

export async function deleteLostFoundItem(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(lostFoundPhotos).where(eq(lostFoundPhotos.itemId, id));
  await db.delete(lostFoundMessages).where(eq(lostFoundMessages.itemId, id));
  await db.delete(lostFoundItems).where(eq(lostFoundItems.id, id));
}

export async function addLostFoundPhoto(data: Omit<LostFoundPhoto, "id" | "createdAt">) {
  const db = await getDb(); if (!db) return;
  await db.insert(lostFoundPhotos).values(data as any);
}

export async function getLostFoundPhotos(itemId: number) {
  const db = await getDb(); if (!db) return [];
  return db.select().from(lostFoundPhotos).where(eq(lostFoundPhotos.itemId, itemId)).orderBy(desc(lostFoundPhotos.createdAt));
}

export async function addLostFoundMessage(data: Omit<LostFoundMessage, "id" | "createdAt">) {
  const db = await getDb(); if (!db) return;
  await db.insert(lostFoundMessages).values(data as any);
}

// ── Condutores anexados a um caso (roubos) ────────────────────────────────────
export async function attachLostFoundDriver(data: {
  itemId: number; employeeId?: number | null; driverName: string;
  source: string; movementDate?: string | null; movementsSummary?: string | null;
  notes?: string | null; attachedById?: number | null;
}) {
  const db = await getDb(); if (!db) throw new Error("DB unavailable");
  const r = await db.insert(lostFoundAttachedDrivers).values({
    itemId: data.itemId,
    employeeId: data.employeeId ?? null,
    driverName: data.driverName,
    source: data.source,
    movementDate: data.movementDate ?? null,
    movementsSummary: data.movementsSummary ?? null,
    notes: data.notes ?? null,
    attachedById: data.attachedById ?? null,
  });
  return Number((r[0] as any).insertId);
}

export async function listLostFoundDrivers(itemId: number) {
  const db = await getDb(); if (!db) return [];
  return db.select().from(lostFoundAttachedDrivers)
    .where(eq(lostFoundAttachedDrivers.itemId, itemId))
    .orderBy(desc(lostFoundAttachedDrivers.createdAt));
}

export async function detachLostFoundDriver(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(lostFoundAttachedDrivers).where(eq(lostFoundAttachedDrivers.id, id));
}

export async function getLostFoundMessages(itemId: number) {
  const db = await getDb(); if (!db) return [];
  return db.select().from(lostFoundMessages).where(eq(lostFoundMessages.itemId, itemId)).orderBy(lostFoundMessages.createdAt);
}

// Cruzamento de dados: ranking de condutores envolvidos em carros com desaparecimentos
export async function getLostFoundDriverRanking() {
  const db = await getDb(); if (!db) return [];
  // Get all lost_found items with vehicle plates
  const items = await db.select().from(lostFoundItems).where(sql`${lostFoundItems.vehiclePlate} IS NOT NULL AND ${lostFoundItems.vehiclePlate} != ''`);
  if (items.length === 0) return [];

  const plates = items.map(i => i.vehiclePlate!);
  // Get all movements for those plates
  const allMovements = await db.select().from(vehicleMovements);
  const relevantMovements = allMovements.filter(m => {
    // Find vehicle plate for this movement
    return true; // We'll join with vehicles below
  });

  // Get vehicles to map vehicleId -> plate
  const allVehicles = await db.select().from(vehicles);
  const vehiclePlateMap = new Map(allVehicles.map(v => [v.id, v.plate]));
  const plateVehicleMap = new Map(allVehicles.map(v => [v.plate, v.id]));

  // Get movements for affected vehicles
  const affectedVehicleIds = plates.map(p => plateVehicleMap.get(p)).filter(Boolean) as number[];
  const movements = allMovements.filter(m => affectedVehicleIds.includes(m.vehicleId));

  // Get employees
  const { employees } = await import("../drizzle/schema");
  const allEmployees = await db.select().from(employees);
  const employeeMap = new Map(allEmployees.map(e => [e.id, e.fullName]));

  // Count how many incident vehicles each driver touched
  const driverIncidents = new Map<number, { name: string; vehiclePlates: Set<string>; totalIncidents: number }>();
  for (const mov of movements) {
    const plate = vehiclePlateMap.get(mov.vehicleId);
    if (!plate || !plates.includes(plate)) continue;
    const incidentsForPlate = items.filter(i => i.vehiclePlate === plate).length;
    const existing = driverIncidents.get(mov.employeeId) || { name: employeeMap.get(mov.employeeId) || "Desconhecido", vehiclePlates: new Set(), totalIncidents: 0 };
    existing.vehiclePlates.add(plate);
    existing.totalIncidents += incidentsForPlate;
    driverIncidents.set(mov.employeeId, existing);
  }

  return Array.from(driverIncidents.entries())
    .map(([employeeId, data]) => ({
      employeeId,
      employeeName: data.name,
      vehicleCount: data.vehiclePlates.size,
      incidentCount: data.totalIncidents,
      plates: Array.from(data.vehiclePlates),
    }))
    .sort((a, b) => b.incidentCount - a.incidentCount);
}


// ─── OCORRÊNCIAS (INCIDENTS) ─────────────────────────────────────────────────
export async function createIncident(data: any) {
  const db = await getDb(); if (!db) return null;
  const now = new Date();
  const weekNum = getWeekNumber(now);
  const [result] = await db.insert(incidents).values({ ...data, weekNumber: data.weekNumber || weekNum, yearNumber: data.yearNumber || now.getFullYear() } as any).$returningId();
  return result?.id;
}

export async function getIncidents(filters?: { status?: string; severity?: string; employeeId?: number; weekNumber?: number; yearNumber?: number }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = [];
  if (filters?.status) conditions.push(eq(incidents.status, filters.status as any));
  if (filters?.severity) conditions.push(eq(incidents.severity, filters.severity as any));
  if (filters?.employeeId) conditions.push(eq(incidents.employeeId, filters.employeeId));
  if (filters?.weekNumber) conditions.push(eq(incidents.weekNumber, filters.weekNumber));
  if (filters?.yearNumber) conditions.push(eq(incidents.yearNumber, filters.yearNumber));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(incidents).where(where).orderBy(desc(incidents.createdAt));
}

export async function getIncidentById(id: number) {
  const db = await getDb(); if (!db) return null;
  const rows = await db.select().from(incidents).where(eq(incidents.id, id)).limit(1);
  return rows[0] || null;
}

export async function updateIncident(id: number, data: any) {
  const db = await getDb(); if (!db) return;
  await db.update(incidents).set(data).where(eq(incidents.id, id));
}

export async function deleteIncident(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(incidents).where(eq(incidents.id, id));
}

export async function getIncidentStats(weekNumber?: number, yearNumber?: number) {
  const db = await getDb(); if (!db) return { total: 0, open: 0, resolved: 0, critical: 0, byType: {} };
  const conditions: any[] = [];
  if (weekNumber) conditions.push(eq(incidents.weekNumber, weekNumber));
  if (yearNumber) conditions.push(eq(incidents.yearNumber, yearNumber));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const all = await db.select().from(incidents).where(where);
  const byType: Record<string, number> = {};
  let open = 0, resolved = 0, critical = 0;
  for (const i of all) {
    byType[i.incidentType] = (byType[i.incidentType] || 0) + 1;
    if (i.status === "open" || i.status === "investigating") open++;
    if (i.status === "resolved") resolved++;
    if (i.severity === "critical") critical++;
  }
  return { total: all.length, open, resolved, critical, byType };
}

export async function getIncidentsByEmployee(employeeId: number) {
  const db = await getDb(); if (!db) return [];
  return db.select().from(incidents).where(eq(incidents.employeeId, employeeId)).orderBy(desc(incidents.createdAt));
}

function getWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/** Devolve [Mon 00:00:00, Sun 23:59:59] da semana ISO indicada. */
function isoWeekRange(year: number, week: number): { start: Date; end: Date } {
  // ISO: semana 1 contém 4 de Janeiro
  const simple = new Date(Date.UTC(year, 0, 4));
  const dow = simple.getUTCDay() || 7;
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() - (dow - 1) + (week - 1) * 7);
  monday.setUTCHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}

/** Peso de um alerta de velocidade pelo % de excesso sobre o limite. */
function speedAlertPoints(speed: number, limit: number): number {
  if (limit <= 0) return 5;
  const excess = (speed - limit) / limit;
  if (excess <= 0.1) return 2;   // até +10%
  if (excess <= 0.25) return 5;  // +10-25%
  if (excess <= 0.5) return 10;  // +25-50%
  return 15;                     // > +50%
}

/** Peso de uma ocorrência pela severidade. */
const INCIDENT_SEVERITY_POINTS: Record<string, number> = {
  low: 2,
  medium: 5,
  high: 10,
  critical: 20,
};

// ─── AVALIAÇÃO DE DESEMPENHO ─────────────────────────────────────────────────
export async function createPerformanceEvaluation(data: any) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(performanceEvaluations).values(data as any).$returningId();
  return result?.id;
}

export async function getPerformanceEvaluations(filters?: { weekNumber?: number; yearNumber?: number; employeeId?: number }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = [];
  if (filters?.weekNumber) conditions.push(eq(performanceEvaluations.weekNumber, filters.weekNumber));
  if (filters?.yearNumber) conditions.push(eq(performanceEvaluations.yearNumber, filters.yearNumber));
  if (filters?.employeeId) conditions.push(eq(performanceEvaluations.employeeId, filters.employeeId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(performanceEvaluations).where(where).orderBy(desc(performanceEvaluations.totalPoints));
}

export async function updatePerformanceEvaluation(id: number, data: any) {
  const db = await getDb(); if (!db) return;
  await db.update(performanceEvaluations).set(data).where(eq(performanceEvaluations.id, id));
}

export async function deletePerformanceEvaluation(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(performanceEvaluations).where(eq(performanceEvaluations.id, id));
}

export async function generateWeeklyEvaluation(weekNumber: number, yearNumber: number) {
  const db = await getDb(); if (!db) return [];

  const { start, end } = isoWeekRange(yearNumber, weekNumber);
  const startStr = toMysqlDateTime(start);
  const endStr = toMysqlDateTime(end);

  // Só posições que conduzem (driver, senior_driver, extra)
  const drivers = await db
    .select({ id: employees.id, fullName: employees.fullName, position: employees.position })
    .from(employees)
    .where(and(
      eq(employees.isActive, 1),
      inArray(employees.position, ["driver", "senior_driver", "extra"]),
    ));
  if (drivers.length === 0) return [];
  const driverIds = drivers.map(d => d.id);

  // ── 1. Horas trabalhadas: soma de time_records.hoursWorked (decimal)
  const hoursRows = await db
    .select({
      employeeId: timeRecords.employeeId,
      hours: sql<string>`COALESCE(SUM(${timeRecords.hoursWorked}), 0)`,
    })
    .from(timeRecords)
    .where(and(
      inArray(timeRecords.employeeId, driverIds),
      eq(timeRecords.type, "check_out"),
      gte(timeRecords.recordedAt, startStr),
      lte(timeRecords.recordedAt, endStr),
    ))
    .groupBy(timeRecords.employeeId);
  const hoursMap = new Map(hoursRows.map(r => [r.employeeId, Number(r.hours)]));

  // ── 2. Movimentações REAIS: ações no multipark_booking_history, ligadas ao
  // colaborador via employees.multiparkAgentName. (A tabela vehicle_movements
  // está vazia — a atividade real vem do sync Multipark.)
  const movRows = await db
    .select({
      employeeId: employees.id,
      count: sql<number>`COUNT(*)`,
    })
    .from(multiparkBookingHistory)
    .innerJoin(employees, eq(employees.multiparkAgentName, multiparkBookingHistory.agentName))
    .where(and(
      inArray(employees.id, driverIds),
      gte(multiparkBookingHistory.actionTime, startStr),
      lte(multiparkBookingHistory.actionTime, endStr),
    ))
    .groupBy(employees.id);
  const movMap = new Map(movRows.map(r => [Number(r.employeeId), Number(r.count)]));

  // ── 3. Speed alerts não reconhecidos com excesso (single query)
  const alertRows = await db
    .select({
      employeeId: speedAlerts.employeeId,
      speed: speedAlerts.speed,
      speedLimit: speedAlerts.speedLimit,
    })
    .from(speedAlerts)
    .where(and(
      inArray(speedAlerts.employeeId, driverIds),
      eq(speedAlerts.acknowledged, 0),
      gte(speedAlerts.createdAt, startStr),
      lte(speedAlerts.createdAt, endStr),
    ));
  const alertStats = new Map<number, { count: number; points: number }>();
  for (const a of alertRows) {
    const empId = Number(a.employeeId ?? 0);
    if (!empId) continue;
    const stats = alertStats.get(empId) ?? { count: 0, points: 0 };
    stats.count += 1;
    stats.points += speedAlertPoints(Number(a.speed), Number(a.speedLimit));
    alertStats.set(empId, stats);
  }

  // ── 4. Incidents (positivos = reportedBy, negativos = employeeId)
  const incidentRows = await db
    .select({
      reportedBy: incidents.reportedBy,
      employeeId: incidents.employeeId,
      severity: incidents.severity,
    })
    .from(incidents)
    .where(and(
      gte(incidents.createdAt, startStr),
      lte(incidents.createdAt, endStr),
    ));
  const posIncidents = new Map<number, number>();
  const negIncidents = new Map<number, { count: number; points: number }>();
  for (const i of incidentRows) {
    const reporterId = Number(i.reportedBy ?? 0);
    const targetId = Number(i.employeeId ?? 0);
    if (reporterId && driverIds.includes(reporterId)) {
      posIncidents.set(reporterId, (posIncidents.get(reporterId) ?? 0) + 1);
    }
    if (targetId && driverIds.includes(targetId)) {
      const sev = String(i.severity ?? "medium");
      const pts = INCIDENT_SEVERITY_POINTS[sev] ?? 5;
      const cur = negIncidents.get(targetId) ?? { count: 0, points: 0 };
      cur.count += 1;
      cur.points += pts;
      negIncidents.set(targetId, cur);
    }
  }

  // ── 5. Penalizações abertas criadas na semana (employee_penalties)
  const penaltyRows = await db
    .select({
      employeeId: employeePenalties.employeeId,
      totalPoints: sql<number>`COALESCE(SUM(${employeePenalties.points}), 0)`,
    })
    .from(employeePenalties)
    .where(and(
      inArray(employeePenalties.employeeId, driverIds),
      gte(employeePenalties.createdAt, startStr),
      lte(employeePenalties.createdAt, endStr),
    ))
    .groupBy(employeePenalties.employeeId);
  // Cada ponto de penalty = −5 pts no ranking
  const PENALTY_WEIGHT = 5;
  const penaltyMap = new Map(penaltyRows.map(r => [r.employeeId, Number(r.totalPoints) * PENALTY_WEIGHT]));

  // ── 6. Avaliações existentes para esta semana (decidir UPDATE vs INSERT)
  const existingEvals = await db
    .select()
    .from(performanceEvaluations)
    .where(and(
      eq(performanceEvaluations.weekNumber, weekNumber),
      eq(performanceEvaluations.yearNumber, yearNumber),
      inArray(performanceEvaluations.employeeId, driverIds),
    ));
  const existingMap = new Map(existingEvals.map(e => [e.employeeId, e]));

  // ── 7. Construir e gravar
  const MOV_POINTS = 2;
  const INCIDENT_REPORT_POINTS = 5;
  const results: any[] = [];

  for (const emp of drivers) {
    const hoursWorked = Math.round((hoursMap.get(emp.id) ?? 0) * 100) / 100;
    const movementsCount = movMap.get(emp.id) ?? 0;
    const movementsPerHour = hoursWorked > 0
      ? Math.round((movementsCount / hoursWorked) * 100) / 100
      : 0;
    const alertCount = alertStats.get(emp.id)?.count ?? 0;
    const alertPoints = alertStats.get(emp.id)?.points ?? 0;
    const positiveIncidentsCount = posIncidents.get(emp.id) ?? 0;
    const negStats = negIncidents.get(emp.id) ?? { count: 0, points: 0 };
    const penaltyPts = penaltyMap.get(emp.id) ?? 0;

    const positivePoints = (movementsCount * MOV_POINTS) + (positiveIncidentsCount * INCIDENT_REPORT_POINTS);
    const negativePoints = alertPoints + negStats.points + penaltyPts;
    const totalPoints = positivePoints - negativePoints;

    const evalData = {
      employeeId: emp.id,
      weekNumber,
      yearNumber,
      hoursWorked: Math.round(hoursWorked),
      movementsCount,
      movementsPerHour: Math.round(movementsPerHour),
      speedAlerts: alertCount,
      incidentsPositive: positiveIncidentsCount,
      incidentsNegative: negStats.count,
      positivePoints,
      negativePoints,
      totalPoints,
    };

    const existing = existingMap.get(emp.id);
    if (existing) {
      // Preserva ajustes manuais (notes) feitos pelo supervisor
      await db.update(performanceEvaluations).set(evalData).where(eq(performanceEvaluations.id, existing.id));
      results.push({ ...evalData, id: existing.id, employeeName: emp.fullName, notes: existing.notes });
    } else {
      const [result] = await db.insert(performanceEvaluations).values(evalData as any).$returningId();
      results.push({ ...evalData, id: result?.id, employeeName: emp.fullName, notes: null });
    }
  }

  return results.sort((a, b) => b.totalPoints - a.totalPoints);
}

// ─── SERVIÇOS ────────────────────────────────────────────────────────────────
export async function createService(data: any) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(services).values(data as any).$returningId();
  return result?.id;
}

export async function getServices(filters?: { serviceType?: string; employeeId?: number; projectId?: number; month?: number; year?: number }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = [];
  if (filters?.serviceType) conditions.push(eq(services.serviceType, filters.serviceType as any));
  if (filters?.employeeId) conditions.push(eq(services.employeeId, filters.employeeId));
  if (filters?.projectId) conditions.push(eq(services.projectId, filters.projectId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const all = await db.select().from(services).where(where).orderBy(desc(services.serviceDate));
  if (filters?.month && filters?.year) {
    return all.filter(s => {
      const d = new Date(s.serviceDate);
      return d.getMonth() + 1 === filters.month && d.getFullYear() === filters.year;
    });
  }
  return all;
}

export async function updateService(id: number, data: any) {
  const db = await getDb(); if (!db) return;
  await db.update(services).set(data).where(eq(services.id, id));
}

export async function deleteService(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(services).where(eq(services.id, id));
}

export async function getServiceStats(month?: number, year?: number) {
  const db = await getDb(); if (!db) return { total: 0, revenue: 0, cost: 0, profit: 0, byType: {}, byEmployee: [] as any[] };
  let all = await db.select().from(services).orderBy(desc(services.serviceDate));
  if (month && year) {
    all = all.filter(s => {
      const d = new Date(s.serviceDate);
      return d.getMonth() + 1 === month && d.getFullYear() === year;
    });
  }
  const byType: Record<string, { count: number; revenue: number; cost: number }> = {};
  const byEmp: Record<number, { count: number; revenue: number }> = {};
  let totalRevenue = 0, totalCost = 0;
  for (const s of all) {
    const t = s.serviceType;
    if (!byType[t]) byType[t] = { count: 0, revenue: 0, cost: 0 };
    byType[t].count++;
    byType[t].revenue += s.revenue || 0;
    byType[t].cost += (s.cost || 0) + (s.commission || 0);
    totalRevenue += s.revenue || 0;
    totalCost += (s.cost || 0) + (s.commission || 0);
    if (s.employeeId) {
      if (!byEmp[s.employeeId]) byEmp[s.employeeId] = { count: 0, revenue: 0 };
      byEmp[s.employeeId].count++;
      byEmp[s.employeeId].revenue += s.revenue || 0;
    }
  }
  // Get employee names
  const { employees: empTable } = await import("../drizzle/schema");
  const allEmps = await db.select().from(empTable);
  const empMap = new Map(allEmps.map(e => [e.id, e.fullName]));
  const byEmployee = Object.entries(byEmp).map(([id, data]) => ({
    employeeId: Number(id),
    employeeName: empMap.get(Number(id)) || "Desconhecido",
    ...data,
  })).sort((a, b) => b.count - a.count);
  
  return { total: all.length, revenue: totalRevenue, cost: totalCost, profit: totalRevenue - totalCost, byType, byEmployee };
}

// ─── FATURAÇÃO (BILLING) ─────────────────────────────────────────────────────
export async function createInvoice(data: any) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(invoices).values(data as any).$returningId();
  return result?.id;
}

export async function getInvoices(filters?: { status?: string; projectId?: number; search?: string; month?: number; year?: number }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = [];
  if (filters?.status) conditions.push(eq(invoices.status, filters.status as any));
  if (filters?.projectId) conditions.push(eq(invoices.projectId, filters.projectId));
  if (filters?.search) {
    conditions.push(or(
      like(invoices.invoiceNumber, `%${filters.search}%`),
      like(invoices.clientName, `%${filters.search}%`),
      like(invoices.clientNif, `%${filters.search}%`)
    ));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const all = await db.select().from(invoices).where(where).orderBy(desc(invoices.issueDate));
  if (filters?.month && filters?.year) {
    return all.filter(i => {
      const d = new Date(i.issueDate);
      return d.getMonth() + 1 === filters.month && d.getFullYear() === filters.year;
    });
  }
  return all;
}

export async function getInvoiceById(id: number) {
  const db = await getDb(); if (!db) return null;
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return rows[0] || null;
}

export async function updateInvoice(id: number, data: any) {
  const db = await getDb(); if (!db) return;
  await db.update(invoices).set(data).where(eq(invoices.id, id));
}

export async function deleteInvoice(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(invoices).where(eq(invoices.id, id));
}

export async function getInvoiceStats(month?: number, year?: number) {
  const db = await getDb(); if (!db) return { total: 0, totalAmount: 0, paid: 0, overdue: 0, draft: 0 };
  let all = await db.select().from(invoices).orderBy(desc(invoices.issueDate));
  if (month && year) {
    all = all.filter(i => {
      const d = new Date(i.issueDate);
      return d.getMonth() + 1 === month && d.getFullYear() === year;
    });
  }
  let totalAmount = 0, paid = 0, overdue = 0, draft = 0;
  for (const i of all) {
    totalAmount += i.totalAmount || 0;
    if (i.status === "paid") paid++;
    if (i.status === "overdue") overdue++;
    if (i.status === "draft") draft++;
  }
  return { total: all.length, totalAmount, paid, overdue, draft };
}

// ─── BILLING / FATURAÇÃO ────────────────────────────────────────────────────
async function resolveProjectIds(projectId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [projectId];
  const allProjects = await db.select().from(projects);
  const ids = new Set<number>();
  const addChildren = (pid: number) => {
    ids.add(pid);
    for (const p of allProjects) {
      if (p.parentId === pid) addChildren(p.id);
    }
  };
  addChildren(projectId);
  return Array.from(ids);
}

// Taxas €/hora para extras-dia (sincronizadas com server/extrasDia.ts)
const EXTRAS_DIA_RATES: Record<string, number> = {
  junior: 4.5, senior: 5, terminal: 5.5, master: 6,
};

// SQL para formatar uma coluna timestamp para o bucket pretendido
function bucketSqlExpr(col: any, granularity: "day" | "week" | "month" | "year") {
  switch (granularity) {
    case "week":  return sql<string>`DATE_FORMAT(${col}, '%x-W%v')`;
    case "month": return sql<string>`DATE_FORMAT(${col}, '%Y-%m')`;
    case "year":  return sql<string>`DATE_FORMAT(${col}, '%Y')`;
    default:      return sql<string>`DATE_FORMAT(${col}, '%Y-%m-%d')`;
  }
}

/**
 * Diagnóstico cru de receita: para isolar onde está a discrepância entre
 * "Entregas" e outras vistas. Devolve o mesmo SUM(totalPrice) calculado de
 * várias formas diferentes para o mesmo período + filtro de projeto, de
 * forma a ser possível detectar se o bug está numa query específica ou na
 * fonte dos dados.
 */
export async function diagnoseBilling(filters: {
  from: string;
  to: string;
  projectId?: number;
}): Promise<{
  range: { from: string; to: string };
  projectIds: number[] | null;
  // Várias somas com filtros progressivos
  sumByCheckoutPeriod: { count: number; sum: number };
  sumWithCheckoutNotNull: { count: number; sum: number };
  sumExcludingCancelled: { count: number; sum: number };
  sumWithProjectFilter: { count: number; sum: number };
  // Contagem distinta para confirmar não-duplicados
  rowsCount: number;
  distinctExternalIds: number;
  duplicatedExternalIds: Array<{ externalId: string; count: number }>;
  // Breakdowns
  byProject: Array<{ projectId: number | null; projectName: string | null; count: number; sum: number }>;
  byCampaign: Array<{ campaign: string | null; count: number; sum: number }>;
  byStatus: Array<{ status: string | null; count: number; sum: number }>;
  // Cancelled vs not
  cancelledCount: number;
  cancelledSum: number;
  // Top bookings para o utilizador olhar
  topBookings: Array<{ id: number; externalId: string; bookingNumber: string | null; projectName: string | null; campaign: string | null; status: string | null; totalPrice: number; checkOut: string | null; cancelledAt: string | null }>;
}> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const fromStr = toMysqlDateTime(new Date(filters.from));
  const toStr = toMysqlDateTime(new Date(filters.to + "T23:59:59"));

  let projectIds: number[] | null = null;
  if (filters.projectId) projectIds = await resolveProjectIds(filters.projectId);

  // ── 1. Sum 1: tudo com checkOut no período (sem mais filtros) ──
  const [a1] = await db
    .select({
      count: sql<number>`COUNT(*)`,
      sum: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(gte(multiparkBookings.checkOut, fromStr), lte(multiparkBookings.checkOut, toStr)));

  // ── 2. + isNotNull(checkOut) ──
  const [a2] = await db
    .select({
      count: sql<number>`COUNT(*)`,
      sum: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(gte(multiparkBookings.checkOut, fromStr), lte(multiparkBookings.checkOut, toStr), isNotNull(multiparkBookings.checkOut)));

  // ── 3. + status = 'CHECKED_OUT' (sem o filtro de projeto ainda) ──
  const [a3] = await db
    .select({
      count: sql<number>`COUNT(*)`,
      sum: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(
      gte(multiparkBookings.checkOut, fromStr),
      lte(multiparkBookings.checkOut, toStr),
      sql`${multiparkBookings.status} != 'CANCELLED'`,
    ));

  // ── 4. + inArray(projectId) se filtro ──
  const filteredConds: any[] = [
    gte(multiparkBookings.checkOut, fromStr),
    lte(multiparkBookings.checkOut, toStr),
    sql`${multiparkBookings.status} != 'CANCELLED'`,
  ];
  if (projectIds) filteredConds.push(inArray(multiparkBookings.projectId, projectIds));
  const [a4] = await db
    .select({
      count: sql<number>`COUNT(*)`,
      sum: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(...filteredConds));

  // ── Duplicados ──
  const distinctRow = await db
    .select({
      total: sql<number>`COUNT(*)`,
      distinct: sql<number>`COUNT(DISTINCT ${multiparkBookings.externalId})`,
    })
    .from(multiparkBookings)
    .where(and(...filteredConds));
  const dup = distinctRow[0];

  // Top duplicados (se houver)
  const duplicates = await db
    .select({
      externalId: multiparkBookings.externalId,
      count: sql<number>`COUNT(*)`,
    })
    .from(multiparkBookings)
    .where(and(...filteredConds))
    .groupBy(multiparkBookings.externalId)
    .having(sql`COUNT(*) > 1`)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(20);

  // ── By project ──
  const byProj = await db
    .select({
      projectId: multiparkBookings.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(*)`,
      sum: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(projects.id, multiparkBookings.projectId))
    .where(and(...filteredConds))
    .groupBy(multiparkBookings.projectId, projects.name)
    .orderBy(desc(sql`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`));

  // ── By campaign ──
  const byCamp = await db
    .select({
      campaign: multiparkBookings.campaign,
      count: sql<number>`COUNT(*)`,
      sum: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(...filteredConds))
    .groupBy(multiparkBookings.campaign)
    .orderBy(desc(sql`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`));

  // ── By status ──
  const byStatus = await db
    .select({
      status: multiparkBookings.status,
      count: sql<number>`COUNT(*)`,
      sum: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(...filteredConds))
    .groupBy(multiparkBookings.status);

  // ── Cancelled (sem filtro de cancelledAt mas com resto igual) ──
  const cancelConds: any[] = [
    gte(multiparkBookings.checkOut, fromStr),
    lte(multiparkBookings.checkOut, toStr),
    isNotNull(multiparkBookings.checkOut),
    isNotNull(multiparkBookings.cancelledAt),
  ];
  if (projectIds) cancelConds.push(inArray(multiparkBookings.projectId, projectIds));
  const [cancelled] = await db
    .select({
      count: sql<number>`COUNT(*)`,
      sum: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(...cancelConds));

  // ── Top bookings por valor ──
  const top = await db
    .select({
      id: multiparkBookings.id,
      externalId: multiparkBookings.externalId,
      bookingNumber: multiparkBookings.bookingNumber,
      projectName: projects.name,
      campaign: multiparkBookings.campaign,
      status: multiparkBookings.status,
      totalPrice: multiparkBookings.totalPrice,
      checkOut: multiparkBookings.checkOut,
      cancelledAt: multiparkBookings.cancelledAt,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(projects.id, multiparkBookings.projectId))
    .where(and(...filteredConds))
    .orderBy(desc(multiparkBookings.totalPrice))
    .limit(20);

  return {
    range: { from: filters.from, to: filters.to },
    projectIds,
    sumByCheckoutPeriod: { count: Number(a1?.count ?? 0), sum: Number(a1?.sum ?? 0) },
    sumWithCheckoutNotNull: { count: Number(a2?.count ?? 0), sum: Number(a2?.sum ?? 0) },
    sumExcludingCancelled: { count: Number(a3?.count ?? 0), sum: Number(a3?.sum ?? 0) },
    sumWithProjectFilter: { count: Number(a4?.count ?? 0), sum: Number(a4?.sum ?? 0) },
    rowsCount: Number(dup?.total ?? 0),
    distinctExternalIds: Number(dup?.distinct ?? 0),
    duplicatedExternalIds: duplicates.map((d) => ({ externalId: d.externalId, count: Number(d.count ?? 0) })),
    byProject: byProj.map((p) => ({ projectId: p.projectId, projectName: p.projectName, count: Number(p.count ?? 0), sum: Number(p.sum ?? 0) })),
    byCampaign: byCamp.map((c) => ({ campaign: c.campaign, count: Number(c.count ?? 0), sum: Number(c.sum ?? 0) })),
    byStatus: byStatus.map((s) => ({ status: s.status, count: Number(s.count ?? 0), sum: Number(s.sum ?? 0) })),
    cancelledCount: Number(cancelled?.count ?? 0),
    cancelledSum: Number(cancelled?.sum ?? 0),
    topBookings: top.map((t) => ({
      id: t.id,
      externalId: t.externalId,
      bookingNumber: t.bookingNumber,
      projectName: t.projectName,
      campaign: t.campaign,
      status: t.status,
      totalPrice: Number(t.totalPrice ?? 0),
      checkOut: t.checkOut,
      cancelledAt: t.cancelledAt,
    })),
  };
}

export async function getBillingData(filters: {
  from: string;
  to: string;
  projectId?: number;
  granularity?: "day" | "week" | "month" | "year";
}) {
  const db = await getDb();
  const granularity = filters.granularity ?? "day";
  if (!db) {
    return {
      summary: {
        produced: 0, invoiced: 0,
        expensesPaid: 0, expensesPending: 0,
        extrasDiaCost: 0, marketingCost: 0, partnerCommissionsPaid: 0, partnerCommissionsPending: 0,
        totalCostsPaid: 0, totalCostsAll: 0,
        marginRealized: 0, marginAll: 0,
      },
      timeseries: [],
      deliveries: [], expensesPaid: [], expensesPending: [], forecast: [],
      invoices: [], extrasDia: [], marketing: [], partnerCommissions: [],
      forecastBookings: [], forecastExpenses: [], forecastExtrasDia: [],
    };
  }

  const fromStr = toMysqlDateTime(new Date(filters.from));
  const toStr = toMysqlDateTime(new Date(filters.to + "T23:59:59"));
  const fromDateOnly = filters.from;
  const toDateOnly = filters.to;

  // Hierarquia de projetos
  let projectIds: number[] | undefined;
  if (filters.projectId) projectIds = await resolveProjectIds(filters.projectId);

  // ─── 1. PRODUZIDO (reservas com checkout EFECTIVO no período) ────────────
  // Filtra por status != 'CANCELLED'. Inclui BOOKED, CHECKING_IN,
  // CHECKED_IN, CHECKED_OUT — todas as reservas vivas com checkout
  // previsto no período. Bate com o número da Multipark. O cancelledAt
  // não é fiável (o sync nem sempre o popula), por isso o filtro é
  // pelo status que é a fonte de verdade.
  const deliveryConds: any[] = [
    gte(multiparkBookings.checkOut, fromStr),
    lte(multiparkBookings.checkOut, toStr),
    sql`${multiparkBookings.status} != 'CANCELLED'`,
  ];
  if (projectIds) deliveryConds.push(inArray(multiparkBookings.projectId, projectIds));

  const deliveryRows = await db
    .select({
      projectId: multiparkBookings.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(*)`,
      totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
      parkingRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.parkingPrice}), 0)`,
      deliveryCharges: sql<number>`COALESCE(SUM(${multiparkBookings.deliveryCharges}), 0)`,
      extrasRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.extrasTotal}), 0)`,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...deliveryConds))
    .groupBy(multiparkBookings.projectId, projects.name);

  // Receita produzida por projeto (folha) no período — usada para calcular
  // a comissão dos parceiros operacionais (secção 7b).
  const revenueByProjectId = new Map<number, number>();
  for (const r of deliveryRows) {
    if (r.projectId != null) revenueByProjectId.set(r.projectId, Number(r.totalRevenue ?? 0));
  }

  // ─── 2. FATURADO (invoices emitidas no período) ──────────────────────────
  const invConds: any[] = [
    gte(invoices.issueDate, fromStr),
    lte(invoices.issueDate, toStr),
    sql`${invoices.status} != 'cancelled'`,
  ];
  if (projectIds) invConds.push(inArray(invoices.projectId, projectIds));

  const invoicedRows = await db
    .select({
      projectId: invoices.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(*)`,
      totalAmount: sql<number>`COALESCE(SUM(${invoices.totalAmount}), 0)`,
      paidAmount: sql<number>`COALESCE(SUM(CASE WHEN ${invoices.status} = 'paid' THEN ${invoices.totalAmount} ELSE 0 END), 0)`,
    })
    .from(invoices)
    .leftJoin(projects, eq(invoices.projectId, projects.id))
    .where(and(...invConds))
    .groupBy(invoices.projectId, projects.name);

  // ─── 3. DESPESAS INSERIDAS (expenseDate no período) ──────────────────────
  // Contabiliza as despesas LANÇADAS no período (data da despesa),
  // independentemente de já estarem pagas. Exclui apenas as canceladas.
  const insertedConds: any[] = [
    sql`${expenses.status} != 'cancelled'`,
    gte(expenses.expenseDate, fromStr),
    lte(expenses.expenseDate, toStr),
  ];
  if (projectIds) insertedConds.push(inArray(expenses.projectId, projectIds));

  const expPaidRows = await db
    .select({
      projectId: expenses.projectId,
      projectName: projects.name,
      categoryName: expenseCategories.name,
      count: sql<number>`COUNT(*)`,
      totalAmount: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(and(...insertedConds))
    .groupBy(expenses.projectId, projects.name, expenseCategories.name);

  // ─── 4. DESPESAS PENDENTES (vencimento no período) ───────────────────────
  const pendConds: any[] = [
    inArray(expenses.status, ["pending", "overdue"]),
    isNotNull(expenses.paymentDueDate),
    gte(expenses.paymentDueDate, fromStr),
    lte(expenses.paymentDueDate, toStr),
  ];
  if (projectIds) pendConds.push(inArray(expenses.projectId, projectIds));

  const expPendRows = await db
    .select({
      projectId: expenses.projectId,
      projectName: projects.name,
      categoryName: expenseCategories.name,
      supplier: expenses.supplier,
      count: sql<number>`COUNT(*)`,
      totalAmount: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(and(...pendConds))
    .groupBy(expenses.projectId, projects.name, expenseCategories.name, expenses.supplier);

  // ─── 5. EXTRAS-DIA (custo da equipa diária) ──────────────────────────────
  const extrasRows = await db
    .select({
      level: extrasDiaAssignments.level,
      hours: sql<number>`COALESCE(SUM(GREATEST(${extrasDiaAssignments.endHour} - ${extrasDiaAssignments.startHour}, 0)), 0)`,
      headcount: sql<number>`COUNT(*)`,
    })
    .from(extrasDiaAssignments)
    .where(
      and(
        gte(extrasDiaAssignments.assignmentDate, fromDateOnly),
        lte(extrasDiaAssignments.assignmentDate, toDateOnly),
      ),
    )
    .groupBy(extrasDiaAssignments.level);

  const extrasDiaSummary = extrasRows.map((r) => {
    const rate = EXTRAS_DIA_RATES[String(r.level ?? "junior")] ?? 4;
    const hours = Number(r.hours ?? 0);
    return {
      level: r.level ?? "junior",
      hours,
      headcount: Number(r.headcount ?? 0),
      cost: hours * rate,
    };
  });

  // ─── 6. MARKETING (despesas marketing + spend de campanhas) ──────────────
  const mktExpConds: any[] = [
    gte(marketingExpenses.date, fromStr),
    lte(marketingExpenses.date, toStr),
  ];
  if (projectIds) mktExpConds.push(inArray(marketingExpenses.projectId, projectIds));

  const mktExpRows = await db
    .select({
      projectId: marketingExpenses.projectId,
      projectName: projects.name,
      category: marketingExpenses.mktCategory,
      totalAmount: sql<number>`COALESCE(SUM(${marketingExpenses.amount}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(marketingExpenses)
    .leftJoin(projects, eq(marketingExpenses.projectId, projects.id))
    .where(and(...mktExpConds))
    .groupBy(marketingExpenses.projectId, projects.name, marketingExpenses.mktCategory);

  const mktAdsConds: any[] = [
    gte(campaignDailyStats.date, fromStr),
    lte(campaignDailyStats.date, toStr),
  ];
  if (projectIds) {
    mktAdsConds.push(inArray(campaigns.projectId, projectIds));
  }
  const mktAdsRows = await db
    .select({
      projectId: campaigns.projectId,
      projectName: projects.name,
      totalSpend: sql<number>`COALESCE(SUM(${campaignDailyStats.spend}), 0)`,
      conversions: sql<number>`COALESCE(SUM(${campaignDailyStats.conversions}), 0)`,
    })
    .from(campaignDailyStats)
    .innerJoin(campaigns, eq(campaignDailyStats.campaignId, campaigns.id))
    .leftJoin(projects, eq(campaigns.projectId, projects.id))
    .where(and(...mktAdsConds))
    .groupBy(campaigns.projectId, projects.name);

  // ─── 7a. PARCEIROS DE VENDA (comissões calculadas via campaign matching) ──
  // IMPORTANTE: NÃO fazemos INNER JOIN entre bookings e partnerships porque,
  // se existirem várias partnerships com o mesmo campaignKey, cada reserva
  // seria contada N vezes (Cartesian product). Em vez disso:
  //   1) agrupamos as reservas no SQL por (campaign, projectId);
  //   2) carregamos as partnerships com campaignKey à parte;
  //   3) fazemos o match e o cálculo de comissão em memória.
  const bookingsByCampaignRows = await db
    .select({
      campaign: multiparkBookings.campaign,
      projectId: multiparkBookings.projectId,
      projectName: projects.name,
      bookingsCount: sql<number>`COUNT(*)`,
      revenueGross: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...deliveryConds, isNotNull(multiparkBookings.campaign)))
    .groupBy(multiparkBookings.campaign, multiparkBookings.projectId, projects.name);

  // Carrega TODAS as partnerships e os aliases associados. Cada parceiro
  // tem geralmente vários códigos — um por (cidade × marca) — e tudo está em
  // partner_aliases. Construímos um único map que aponta de qualquer chave
  // possível (campaignKey, nome do parceiro, partnerId/paymentMethod alias)
  // para a partnership, para que o match seja robusto independentemente
  // do que ficou gravado em multipark_bookings.campaign.
  const allPartners = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      campaignKey: partnerships.campaignKey,
      commissionRate: partnerships.commissionRate,
      updatedAt: partnerships.updatedAt,
    })
    .from(partnerships);

  const allAliases = await db
    .select({
      partnershipId: partnerAliases.partnershipId,
      aliasValue: partnerAliases.aliasValue,
    })
    .from(partnerAliases);

  type PartnerSummary = { id: number; name: string; commissionRate: number; updatedAt: string };
  const partnersById = new Map<number, PartnerSummary>();
  for (const p of allPartners) {
    partnersById.set(p.id, {
      id: p.id,
      name: p.name,
      commissionRate: Number(p.commissionRate ?? 0),
      updatedAt: p.updatedAt ?? "",
    });
  }

  const partnerByCampaign = new Map<string, PartnerSummary>();
  function registerKey(rawKey: string | null, partnerId: number) {
    if (!rawKey) return;
    const key = rawKey.trim().toLowerCase();
    if (!key) return;
    const partner = partnersById.get(partnerId);
    if (!partner) return;
    const existing = partnerByCampaign.get(key);
    if (!existing || partner.updatedAt > existing.updatedAt) {
      partnerByCampaign.set(key, partner);
    }
  }
  // Regista campaignKey e nome
  for (const p of allPartners) {
    registerKey(p.campaignKey, p.id);
    registerKey(p.name, p.id);
  }
  // Regista cada alias (partnerId ou paymentMethod)
  for (const a of allAliases) {
    registerKey(a.aliasValue, a.partnershipId);
  }

  // Consolida por (parceiro, projecto): se duas campaigns diferentes
  // apontarem ao mesmo parceiro, somam-se receitas/contagens em vez de
  // aparecerem 2 linhas separadas.
  const salesAgg = new Map<string, {
    partnerId: number;
    partnerName: string;
    projectId: number | null;
    projectName: string | null;
    bookingsCount: number;
    revenueGross: number;
    commissionRate: number;
    commission: number;
  }>();
  for (const r of bookingsByCampaignRows) {
    const cmpKey = (r.campaign ?? "").trim().toLowerCase();
    const partner = partnerByCampaign.get(cmpKey);
    if (!partner) continue; // sem partnership associada → ignorar
    const revenueGross = Number(r.revenueGross ?? 0);
    const rate = partner.commissionRate / 100;
    const key = `${partner.id}|${r.projectId ?? "null"}`;
    const ex = salesAgg.get(key);
    if (ex) {
      ex.bookingsCount += Number(r.bookingsCount ?? 0);
      ex.revenueGross += revenueGross;
      ex.commission += revenueGross * rate;
    } else {
      salesAgg.set(key, {
        partnerId: partner.id,
        partnerName: partner.name,
        projectId: r.projectId,
        projectName: r.projectName,
        bookingsCount: Number(r.bookingsCount ?? 0),
        revenueGross,
        commissionRate: partner.commissionRate,
        commission: revenueGross * rate,
      });
    }
  }
  const salesCommissions = Array.from(salesAgg.values()).sort((a, b) => b.commission - a.commission);

  // ─── 7b. PARCEIROS OPERACIONAIS (config operatesProjects) ────────────────
  // O parceiro operacional (ex.: Top Parking nas marcas do Porto) está
  // alocado, na sua ficha, aos projetos que opera (cfg.operatesProjects).
  // A comissão é um CUSTO calculado sobre TODAS as reservas produzidas
  // nesses projetos no período × commissionRate%. Já não depende das
  // partnership_invoices nem de inferir o projeto pelo nome.
  const { parsePartnerConfig: parseOpPartnerConfig } = await import("../shared/partnerTypes");
  const opPartnerRows = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      partnerType: partnerships.partnerType,
      commissionRate: partnerships.commissionRate,
      notes: partnerships.notes,
    })
    .from(partnerships)
    .where(eq(partnerships.partnerType, "operacional"));

  const operationalPartners: Array<{
    partnershipId: number;
    partnerName: string | null;
    partnerType: string | null;
    projectNames: string[];
    bookingsCount: number;
    revenueGross: number;
    commissionRate: number;
    commission: number;
  }> = [];
  for (const p of opPartnerRows) {
    const cfg = parseOpPartnerConfig(p.notes ?? null);
    const roots = cfg.operatesProjects ?? [];
    if (roots.length === 0) continue;
    // Expande cada raiz (Grupo/Cidade/Marca) para as folhas e respeita o
    // filtro de projeto activo (projectIds).
    const leaves = new Set<number>();
    for (const root of roots) {
      const ids = await resolveProjectIds(root);
      for (const pid of ids) {
        if (!projectIds || projectIds.includes(pid)) leaves.add(pid);
      }
    }
    if (leaves.size === 0) continue;
    let revenue = 0, bookingsCount = 0;
    const projNames: string[] = [];
    for (const dr of deliveryRows) {
      if (dr.projectId != null && leaves.has(dr.projectId)) {
        revenue += Number(dr.totalRevenue ?? 0);
        bookingsCount += Number(dr.count ?? 0);
        if (dr.projectName) projNames.push(dr.projectName);
      }
    }
    const rate = Number(p.commissionRate ?? 0);
    operationalPartners.push({
      partnershipId: p.id,
      partnerName: p.name,
      partnerType: p.partnerType,
      projectNames: projNames,
      bookingsCount,
      revenueGross: revenue,
      commissionRate: rate,
      commission: revenue * (rate / 100),
    });
  }
  operationalPartners.sort((a, b) => b.commission - a.commission);
  const operationalPartnersTotal = operationalPartners.reduce((s, p) => s + p.commission, 0);

  // ─── 7c. SALÁRIOS rateados ao dia, atribuídos ao projecto do colaborador ──
  // Empregados com salário fixo (não-extra). O salário mensal é proporcional
  // ao nº de dias do período. Se o empregado está num nível hierárquico
  // (Grupo / Cidade / Marca), o custo é distribuído equitativamente pelos
  // descendentes que sejam folha (level='project').
  const allEmps = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      projectId: employees.projectId,
      contractType: employees.contractType,
      monthlySalary: employees.monthlySalary,
      isActive: employees.isActive,
    })
    .from(employees)
    .where(eq(employees.isActive, 1));

  const allProjectsForHierarchy = await db
    .select({ id: projects.id, name: projects.name, parentId: projects.parentId, level: projects.level })
    .from(projects);
  const childrenMap = new Map<number, number[]>();
  for (const p of allProjectsForHierarchy) {
    if (p.parentId != null) {
      if (!childrenMap.has(p.parentId)) childrenMap.set(p.parentId, []);
      childrenMap.get(p.parentId)!.push(p.id);
    }
  }
  function leafDescendants(projectId: number): number[] {
    const self = allProjectsForHierarchy.find(p => p.id === projectId);
    if (!self) return [];
    if (self.level === "project") return [projectId];
    const kids = childrenMap.get(projectId) ?? [];
    if (kids.length === 0) return [projectId]; // sem filhos: fica no próprio
    const out: number[] = [];
    for (const kid of kids) out.push(...leafDescendants(kid));
    return out.length > 0 ? out : [projectId];
  }

  // Dias do período (inclusive)
  const msPerDay = 1000 * 60 * 60 * 24;
  const periodDays = Math.max(
    1,
    Math.floor((new Date(filters.to).getTime() - new Date(filters.from).getTime()) / msPerDay) + 1,
  );

  // Atribui salários por projecto (com rateio)
  const salaryPerProject = new Map<number, number>();
  const salaryDetailRows: Array<{ employeeId: number; fullName: string; projectId: number | null; cost: number; ratedTo: number[] }> = [];
  for (const e of allEmps) {
    const monthlySalary = parseFloat(String(e.monthlySalary ?? "0"));
    if (e.contractType === "extra" || monthlySalary <= 0) continue;
    const periodCost = (monthlySalary / 30) * periodDays;
    const directProjectId = e.projectId ?? null;

    let targets: number[];
    if (directProjectId == null) {
      targets = []; // sem projeto — não soma a nenhum (entra no custo "Geral" abaixo)
    } else {
      targets = leafDescendants(directProjectId);
    }

    if (targets.length === 0) {
      // Sem destino: regista como "sem alocação"
      salaryDetailRows.push({ employeeId: e.id, fullName: e.fullName, projectId: directProjectId, cost: periodCost, ratedTo: [] });
    } else if (targets.length === 1 && targets[0] === directProjectId) {
      const cur = salaryPerProject.get(targets[0]) ?? 0;
      salaryPerProject.set(targets[0], cur + periodCost);
      salaryDetailRows.push({ employeeId: e.id, fullName: e.fullName, projectId: directProjectId, cost: periodCost, ratedTo: targets });
    } else {
      // Empregado em nível superior → rateia equitativamente pelos folhas
      const share = periodCost / targets.length;
      for (const t of targets) {
        const cur = salaryPerProject.get(t) ?? 0;
        salaryPerProject.set(t, cur + share);
      }
      salaryDetailRows.push({ employeeId: e.id, fullName: e.fullName, projectId: directProjectId, cost: periodCost, ratedTo: targets });
    }
  }

  // Filtra salaryPerProject pelo projectId de input (hierarquia já resolvida)
  const salariesByProject = Array.from(salaryPerProject.entries())
    .filter(([pid]) => !projectIds || projectIds.includes(pid))
    .map(([pid, cost]) => {
      const p = allProjectsForHierarchy.find(x => x.id === pid);
      return { projectId: pid, projectName: p?.name ?? null, cost };
    })
    .sort((a, b) => b.cost - a.cost);

  // ─── 8. FORECAST: reservas futuras (checkin no futuro) ───────────────────
  // A previsão é sempre prospectiva: reservas com check-in a partir de agora,
  // ainda sem check-out e sem cancelamento. Se o período selecionado terminar
  // no passado/hoje, estende-se a janela 30 dias para a frente — caso
  // contrário a previsão daria sempre zero (não há check-ins futuros dentro
  // de um período já decorrido).
  const now = new Date();
  const forecastFromDate = now > new Date(filters.from) ? now : new Date(filters.from);
  let forecastToDate = new Date(filters.to + "T23:59:59");
  if (forecastToDate.getTime() <= now.getTime()) {
    forecastToDate = new Date(now.getTime() + 30 * msPerDay);
  }
  const forecastFrom = toMysqlDateTime(forecastFromDate);
  const forecastToStr = toMysqlDateTime(forecastToDate);
  const forecastConds: any[] = [
    gte(multiparkBookings.checkIn, forecastFrom),
    lte(multiparkBookings.checkIn, forecastToStr),
    isNull(multiparkBookings.checkOut),
    isNull(multiparkBookings.cancelledAt),
  ];
  if (projectIds) forecastConds.push(inArray(multiparkBookings.projectId, projectIds));

  const forecastRows = await db
    .select({
      projectId: multiparkBookings.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(*)`,
      totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...forecastConds))
    .groupBy(multiparkBookings.projectId, projects.name);

  // ─── 9. TIMESERIES (granularity: day/week/month/year) ────────────────────
  const checkOutBucket = bucketSqlExpr(multiparkBookings.checkOut, granularity);
  const issueBucket = bucketSqlExpr(invoices.issueDate, granularity);
  const expenseDateBucket = bucketSqlExpr(expenses.expenseDate, granularity);
  const checkInBucket = bucketSqlExpr(multiparkBookings.checkIn, granularity);
  const mktDateBucket = bucketSqlExpr(marketingExpenses.date, granularity);
  const adsDateBucket = bucketSqlExpr(campaignDailyStats.date, granularity);

  const tsProduced = await db
    .select({ bucket: checkOutBucket, total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`, count: sql<number>`COUNT(*)` })
    .from(multiparkBookings)
    .where(and(...deliveryConds))
    .groupBy(checkOutBucket);

  const tsInvoiced = await db
    .select({ bucket: issueBucket, total: sql<number>`COALESCE(SUM(${invoices.totalAmount}), 0)` })
    .from(invoices)
    .where(and(...invConds))
    .groupBy(issueBucket);

  const tsExpensesPaid = await db
    .select({ bucket: expenseDateBucket, total: sql<number>`COALESCE(SUM(${expenses.amount}), 0)` })
    .from(expenses)
    .where(and(...insertedConds))
    .groupBy(expenseDateBucket);

  const tsForecast = await db
    .select({ bucket: checkInBucket, total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`, count: sql<number>`COUNT(*)` })
    .from(multiparkBookings)
    .where(and(...forecastConds))
    .groupBy(checkInBucket);

  const tsMktExpenses = await db
    .select({ bucket: mktDateBucket, total: sql<number>`COALESCE(SUM(${marketingExpenses.amount}), 0)` })
    .from(marketingExpenses)
    .where(and(...mktExpConds))
    .groupBy(mktDateBucket);

  const tsMktAds = await db
    .select({ bucket: adsDateBucket, total: sql<number>`COALESCE(SUM(${campaignDailyStats.spend}), 0)` })
    .from(campaignDailyStats)
    .innerJoin(campaigns, eq(campaignDailyStats.campaignId, campaigns.id))
    .where(and(...mktAdsConds))
    .groupBy(adsDateBucket);

  // Totais de custos que não estão naturalmente distribuídos no tempo
  // (salários mensais, comissões de parceiros, equipa-dia). Distribuem-se
  // pelos buckets proporcionalmente ao produzido (ou em partes iguais se
  // não houver produção) para que o gráfico mostre TUDO como despesa e o
  // total bata certo com os KPIs.
  const tsSalariesTotal = Array.from(salaryPerProject.values()).reduce((s, v) => s + v, 0);
  const tsSalesTotal = salesCommissions.reduce((s, c) => s + c.commission, 0);
  const tsPartnersTotal = operationalPartnersTotal + tsSalesTotal;
  const tsExtrasTotal = extrasDiaSummary.reduce((s, r) => s + r.cost, 0);

  // Merge timeseries em um único array (chave = bucket)
  type TimeseriesPoint = {
    bucket: string;
    produced: number;
    invoiced: number;
    expenses: number;        // despesas inseridas no período
    marketingCost: number;
    salaries: number;        // ordenados (rateados)
    partners: number;        // parceiros operacionais + de venda
    extrasCost: number;      // equipa do dia (extras-dia)
    revenueForecast: number;
    totalCost: number;
    margin: number;
    // back-compat
    expensesPaid: number;
  };
  function emptyPoint(bk: string): TimeseriesPoint {
    return { bucket: bk, produced: 0, invoiced: 0, expenses: 0, marketingCost: 0, salaries: 0, partners: 0, extrasCost: 0, revenueForecast: 0, totalCost: 0, margin: 0, expensesPaid: 0 };
  }
  const tsMap = new Map<string, TimeseriesPoint>();
  function bump(arr: any[], key: keyof Omit<TimeseriesPoint, "bucket">) {
    for (const r of arr) {
      const bk = r.bucket;
      if (!bk) continue;
      const ex = tsMap.get(bk) ?? emptyPoint(bk);
      (ex[key] as number) += Number(r.total ?? 0);
      tsMap.set(bk, ex);
    }
  }
  bump(tsProduced, "produced");
  bump(tsInvoiced, "invoiced");
  bump(tsExpensesPaid, "expenses");
  bump(tsForecast, "revenueForecast");
  bump(tsMktExpenses, "marketingCost");
  bump(tsMktAds, "marketingCost");

  // Distribui os custos não-temporais pelos buckets do produzido.
  const producedBuckets = tsProduced
    .filter((r: any) => r.bucket)
    .map((r: any) => ({ bucket: r.bucket as string, weight: Number(r.total ?? 0) }));
  const producedWeightSum = producedBuckets.reduce((s, b) => s + b.weight, 0);
  function distribute(total: number, key: keyof Omit<TimeseriesPoint, "bucket">) {
    if (!total) return;
    const useWeight = producedBuckets.length > 0 && producedWeightSum > 0;
    const targets = producedBuckets.length > 0
      ? producedBuckets
      : Array.from(tsMap.keys()).map((bk) => ({ bucket: bk, weight: 1 }));
    if (targets.length === 0) return;
    const weightSum = useWeight ? producedWeightSum : targets.length;
    for (const t of targets) {
      const share = total * ((useWeight ? t.weight : 1) / weightSum);
      const ex = tsMap.get(t.bucket) ?? emptyPoint(t.bucket);
      (ex[key] as number) += share;
      tsMap.set(t.bucket, ex);
    }
  }
  distribute(tsSalariesTotal, "salaries");
  distribute(tsPartnersTotal, "partners");
  distribute(tsExtrasTotal, "extrasCost");

  // Custo total e margem por bucket (back-compat: expensesPaid = expenses)
  for (const p of tsMap.values()) {
    p.totalCost = p.expenses + p.marketingCost + p.salaries + p.partners + p.extrasCost;
    p.margin = p.produced - p.totalCost;
    p.expensesPaid = p.expenses;
  }

  const timeseries = Array.from(tsMap.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));

  // ─── 10. SUMMARY ─────────────────────────────────────────────────────────
  const produced = deliveryRows.reduce((s, r) => s + Number(r.totalRevenue ?? 0), 0);
  const invoiced = invoicedRows.reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);
  const expensesPaidTotal = expPaidRows.reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);
  const expensesPendingTotal = expPendRows.reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);
  const extrasDiaCost = extrasDiaSummary.reduce((s, r) => s + r.cost, 0);
  const mktExpensesTotal = mktExpRows.reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);
  const mktAdsSpend = mktAdsRows.reduce((s, r) => s + Number(r.totalSpend ?? 0), 0);
  const marketingCost = mktExpensesTotal + mktAdsSpend;
  // Parceiros operacionais: comissão calculada sobre as reservas dos
  // projetos que operam (secção 7b). É um custo "sempre devido".
  const operationalPartnersPaid = operationalPartnersTotal;
  const operationalPartnersPending = 0;
  // Comissões a parceiros de venda — calculadas a partir das reservas.
  // Custo "sempre devido" assim que o checkout aconteceu.
  const salesCommissionsTotal = salesCommissions.reduce((s, r) => s + r.commission, 0);
  const totalSalaries = Array.from(salaryPerProject.values()).reduce((s, v) => s + v, 0);

  const totalCostsPaid = expensesPaidTotal + extrasDiaCost + marketingCost + operationalPartnersPaid + salesCommissionsTotal + totalSalaries;
  const totalCostsAll = totalCostsPaid + expensesPendingTotal + operationalPartnersPending;

  const summary = {
    produced, invoiced,
    expensesPaid: expensesPaidTotal,
    expensesPending: expensesPendingTotal,
    extrasDiaCost,
    marketingCost,
    salariesCost: totalSalaries,
    salesCommissions: salesCommissionsTotal,
    // back-compat
    partnerCommissionsPaid: operationalPartnersPaid,
    partnerCommissionsPending: operationalPartnersPending,
    operationalPartnersPaid,
    operationalPartnersPending,
    totalCostsPaid,
    totalCostsAll,
    marginRealized: produced - totalCostsPaid,
    marginAll: produced - totalCostsAll,
    periodDays,
  };

  return {
    summary,
    timeseries,
    granularity,
    range: { from: filters.from, to: filters.to },
    // Mantém os blocos antigos para back-compat / drilldown
    deliveries: deliveryRows,
    expensesPaid: expPaidRows,
    expensesPending: expPendRows,
    forecast: forecastRows,
    // Novos blocos para drilldown
    invoices: invoicedRows,
    extrasDia: extrasDiaSummary,
    marketing: { expenses: mktExpRows, ads: mktAdsRows },
    partnerCommissions: [], // back-compat (deixou de vir de partnership_invoices)
    salesCommissions, // comissões parceiros de venda por projeto
    operationalPartners, // parceiros operacionais: comissão s/ reservas dos projetos operados
    salaries: {
      byProject: salariesByProject,
      details: salaryDetailRows,
      total: totalSalaries,
    },
  };
}

// ─── PARTNERSHIP ANALYTICS (from bookings campaign field) ────────────────────
export async function getPartnershipAnalytics(filters: { from: string; to: string; projectId?: number }) {
  const db = await getDb();
  if (!db) return { partners: [], proBookings: [], totals: { partnerBookings: 0, partnerRevenue: 0, directBookings: 0, directRevenue: 0, proBookings: 0, proRevenue: 0 } };

  let projectIds: number[] | undefined;
  if (filters.projectId) projectIds = await resolveProjectIds(filters.projectId);

  // Base conditions: checkouts in period
  const baseConds: any[] = [
    isNotNull(multiparkBookings.checkOut),
    gte(multiparkBookings.checkOut, toMysqlDateTime(new Date(filters.from))),
    lte(multiparkBookings.checkOut, toMysqlDateTime(new Date(filters.to + "T23:59:59"))),
  ];
  if (projectIds) baseConds.push(inArray(multiparkBookings.projectId, projectIds));

  // 1. Partner bookings (campaign is not null = came from partner/affiliate)
  const partnerRows = await db
    .select({
      campaign: multiparkBookings.campaign,
      city: multiparkBookings.city,
      parkName: multiparkBookings.parkName,
      count: sql<number>`COUNT(*)`,
      totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
      avgPrice: sql<number>`COALESCE(AVG(${multiparkBookings.totalPrice}), 0)`,
      totalDiscount: sql<number>`COALESCE(SUM(${multiparkBookings.discount}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(...baseConds, isNotNull(multiparkBookings.campaign)))
    .groupBy(multiparkBookings.campaign, multiparkBookings.city, multiparkBookings.parkName);

  // 2. All bookings for totals (partner vs direct)
  const allRows = await db
    .select({
      hasPartner: sql<number>`CASE WHEN ${multiparkBookings.campaign} IS NOT NULL AND ${multiparkBookings.campaign} != '' THEN 1 ELSE 0 END`,
      count: sql<number>`COUNT(*)`,
      totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(...baseConds))
    .groupBy(sql`CASE WHEN ${multiparkBookings.campaign} IS NOT NULL AND ${multiparkBookings.campaign} != '' THEN 1 ELSE 0 END`);

  // 3. Pro bookings (extract from rawJson where park.isPro = true)
  const proRows = await db
    .select({
      parkName: multiparkBookings.parkName,
      city: multiparkBookings.city,
      count: sql<number>`COUNT(*)`,
      totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(
      ...baseConds,
      sql`JSON_EXTRACT(${multiparkBookings.rawJson}, '$.park.isPro') = true`,
    ))
    .groupBy(multiparkBookings.parkName, multiparkBookings.city);

  // Calculate totals
  let partnerBookings = 0, partnerRevenue = 0, directBookings = 0, directRevenue = 0;
  for (const r of allRows) {
    if (Number(r.hasPartner) === 1) {
      partnerBookings = Number(r.count);
      partnerRevenue = Number(r.totalRevenue);
    } else {
      directBookings = Number(r.count);
      directRevenue = Number(r.totalRevenue);
    }
  }
  const proBookingsTotal = proRows.reduce((s, r) => s + Number(r.count), 0);
  const proRevenueTotal = proRows.reduce((s, r) => s + Number(r.totalRevenue), 0);

  return {
    partners: partnerRows.map(r => ({
      campaign: r.campaign,
      city: r.city,
      parkName: r.parkName,
      count: Number(r.count),
      totalRevenue: Number(r.totalRevenue),
      avgPrice: Number(r.avgPrice),
      totalDiscount: Number(r.totalDiscount),
    })),
    proBookings: proRows.map(r => ({
      parkName: r.parkName,
      city: r.city,
      count: Number(r.count),
      totalRevenue: Number(r.totalRevenue),
    })),
    totals: {
      partnerBookings,
      partnerRevenue,
      directBookings,
      directRevenue,
      proBookings: proBookingsTotal,
      proRevenue: proRevenueTotal,
    },
  };
}

export async function getBookingsByCampaign(filters: { campaignKey: string; from: string; to: string; projectId?: number }) {
  const db = await getDb();
  if (!db) return [];

  let projectIds: number[] | undefined;
  if (filters.projectId) projectIds = await resolveProjectIds(filters.projectId);

  const conds: any[] = [
    eq(multiparkBookings.campaign, filters.campaignKey),
    isNotNull(multiparkBookings.checkOut),
    gte(multiparkBookings.checkOut, toMysqlDateTime(new Date(filters.from))),
    lte(multiparkBookings.checkOut, toMysqlDateTime(new Date(filters.to + "T23:59:59"))),
  ];
  if (projectIds) conds.push(inArray(multiparkBookings.projectId, projectIds));

  const rows = await db
    .select({
      id: multiparkBookings.id,
      bookingNumber: multiparkBookings.bookingNumber,
      clientFirstName: multiparkBookings.clientFirstName,
      clientLastName: multiparkBookings.clientLastName,
      licensePlate: multiparkBookings.licensePlate,
      checkIn: multiparkBookings.checkIn,
      checkOut: multiparkBookings.checkOut,
      parkName: multiparkBookings.parkName,
      city: multiparkBookings.city,
      totalPrice: multiparkBookings.totalPrice,
      discount: multiparkBookings.discount,
      parkingPrice: multiparkBookings.parkingPrice,
      deliveryCharges: multiparkBookings.deliveryCharges,
      extrasTotal: multiparkBookings.extrasTotal,
    })
    .from(multiparkBookings)
    .where(and(...conds))
    .orderBy(desc(multiparkBookings.checkOut));

  return rows.map(r => ({
    ...r,
    totalPrice: Number(r.totalPrice ?? 0),
    discount: Number(r.discount ?? 0),
    parkingPrice: Number(r.parkingPrice ?? 0),
    deliveryCharges: Number(r.deliveryCharges ?? 0),
    extrasTotal: Number(r.extrasTotal ?? 0),
  }));
}

// ─── PARCERIAS (PARTNERSHIPS) ────────────────────────────────────────────────
export async function createPartnership(data: any) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(partnerships).values(data as any).$returningId();
  return result?.id;
}

export async function getPartnerships(filters?: { partnerType?: string; status?: string }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = [];
  if (filters?.partnerType) conditions.push(eq(partnerships.partnerType, filters.partnerType as any));
  if (filters?.status) conditions.push(eq(partnerships.partnerStatus, filters.status as any));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(partnerships).where(where).orderBy(desc(partnerships.createdAt));
}

/**
 * Inferência de parceiros. Devolve dois tipos de grupos:
 *   • aliasType="multipark_partner_id" → reservas com partnerId real
 *   • aliasType="payment_method" → reservas SEM partnerId mas com
 *     paymentMethod identificador (Parkos, Looking4parking, etc.)
 * Um parceiro nosso pode ter vários aliases (vários partnerIds + vários
 * paymentMethods).
 */
export async function inferPartnersFromBookings(): Promise<Array<{
  aliasType: "multipark_partner_id" | "payment_method";
  aliasValue: string;
  suggestedName: string;
  paymentMethod: string | null;
  remarksSample: string | null;
  bookings: number;
  totalValue: number;
  linkedPartnershipId: number | null;
  linkedPartnershipName: string | null;
}>> {
  const db = await getDb(); if (!db) return [];

  // Buscar TODAS as reservas (com ou sem partnerId) que tenham paymentMethod
  // ou partnerId — para agrupar de duas formas:
  //   (A) com partnerId → grupo "multipark_partner_id"
  //   (B) sem partnerId mas paymentMethod identificador → grupo "payment_method"
  const [rawRows] = await (db as any).execute(sql`
    SELECT
      JSON_UNQUOTE(JSON_EXTRACT(rawJson, '$.partnerId')) AS partnerId,
      paymentMethod,
      remarks,
      totalPrice
    FROM multipark_bookings
    WHERE (rawJson LIKE '%partnerId%' AND JSON_EXTRACT(rawJson, '$.partnerId') IS NOT NULL)
       OR paymentMethod IS NOT NULL
  `);

  type Agg = {
    bookings: number;
    totalValue: number;
    paymentMethods: Map<string, number>;
    remarksSample: string | null;
  };
  const byPartner = new Map<string, Agg>(); // key = partnerId
  const byPaymentNoPartner = new Map<string, Agg>(); // key = paymentMethod (só quando partnerId é null)

  for (const r of (rawRows as any[])) {
    const pid: string | null = r.partnerId;
    const tp = r.totalPrice ? parseFloat(String(r.totalPrice)) : 0;
    const tpVal = Number.isFinite(tp) ? tp : 0;

    if (pid) {
      let agg = byPartner.get(pid);
      if (!agg) {
        agg = { bookings: 0, totalValue: 0, paymentMethods: new Map(), remarksSample: null };
        byPartner.set(pid, agg);
      }
      agg.bookings++;
      agg.totalValue += tpVal;
      if (r.paymentMethod) {
        agg.paymentMethods.set(r.paymentMethod, (agg.paymentMethods.get(r.paymentMethod) ?? 0) + 1);
      }
      if (!agg.remarksSample && r.remarks) agg.remarksSample = r.remarks;
    } else if (r.paymentMethod) {
      const key = r.paymentMethod;
      let agg = byPaymentNoPartner.get(key);
      if (!agg) {
        agg = { bookings: 0, totalValue: 0, paymentMethods: new Map(), remarksSample: null };
        byPaymentNoPartner.set(key, agg);
      }
      agg.bookings++;
      agg.totalValue += tpVal;
      if (!agg.remarksSample && r.remarks) agg.remarksSample = r.remarks;
    }
  }

  // Aliases já associados (lista actual em partner_aliases)
  const aliasIndex = new Map<string, { id: number; name: string }>();
  const aliases = await db.select({
    partnershipId: partnerAliases.partnershipId,
    aliasType: partnerAliases.aliasType,
    aliasValue: partnerAliases.aliasValue,
  }).from(partnerAliases);
  const partnersById = new Map<number, string>();
  const partnersAll = await db.select({ id: partnerships.id, name: partnerships.name }).from(partnerships);
  for (const p of partnersAll) partnersById.set(p.id, p.name);
  for (const a of aliases) {
    const key = `${a.aliasType}:${a.aliasValue}`;
    const name = partnersById.get(a.partnershipId);
    if (name) aliasIndex.set(key, { id: a.partnershipId, name });
  }

  function firstAlphaToken(s: string | null): string | null {
    if (!s) return null;
    const m = s.match(/^\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_-]+)/);
    return m ? m[1] : null;
  }
  function topPayment(m: Map<string, number>): string | null {
    let best: [string, number] | null = null;
    for (const [k, v] of m) if (!best || v > best[1]) best = [k, v];
    return best ? best[0] : null;
  }
  const GENERIC = /^(online|multibanco|numerário|numerario|dinheiro|no pay|stripe|wallet|allowance|pro_plan|cash|multbanco|sibs|transferencia)/i;

  type Row = {
    aliasType: "multipark_partner_id" | "payment_method";
    aliasValue: string;
    suggestedName: string;
    paymentMethod: string | null;
    remarksSample: string | null;
    bookings: number;
    totalValue: number;
    linkedPartnershipId: number | null;
    linkedPartnershipName: string | null;
  };

  const result: Row[] = [];

  // Grupos com partnerId
  for (const [pid, agg] of byPartner) {
    const top = topPayment(agg.paymentMethods);
    const fromPayment = top && !GENERIC.test(top.trim()) ? top : null;
    const fromRemarks = firstAlphaToken(agg.remarksSample);
    const suggestedName = fromPayment ?? fromRemarks ?? "Desconhecido";
    const linked = aliasIndex.get(`multipark_partner_id:${pid}`);
    result.push({
      aliasType: "multipark_partner_id",
      aliasValue: pid,
      suggestedName,
      paymentMethod: top,
      remarksSample: agg.remarksSample,
      bookings: agg.bookings,
      totalValue: Math.round(agg.totalValue * 100) / 100,
      linkedPartnershipId: linked?.id ?? null,
      linkedPartnershipName: linked?.name ?? null,
    });
  }

  // Grupos só por paymentMethod (sem partnerId), apenas se o paymentMethod
  // não for genérico (Online, Multibanco, etc.)
  for (const [pm, agg] of byPaymentNoPartner) {
    if (GENERIC.test(pm.trim())) continue;
    const linked = aliasIndex.get(`payment_method:${pm}`);
    result.push({
      aliasType: "payment_method",
      aliasValue: pm,
      suggestedName: pm,
      paymentMethod: pm,
      remarksSample: agg.remarksSample,
      bookings: agg.bookings,
      totalValue: Math.round(agg.totalValue * 100) / 100,
      linkedPartnershipId: linked?.id ?? null,
      linkedPartnershipName: linked?.name ?? null,
    });
  }

  result.sort((a, b) => b.bookings - a.bookings);
  return result;
}

/**
 * Adiciona um alias (partnerId ou paymentMethod) a uma parceria.
 * Se applyToBookings, actualiza a coluna campaign das reservas que correspondem:
 *  - alias_type=multipark_partner_id: reservas com partnerId no rawJson
 *  - alias_type=payment_method: reservas com paymentMethod = alias_value E
 *    sem partnerId (para não duplicar com o caso anterior)
 */
export async function addPartnerAlias(
  partnershipId: number,
  aliasType: "multipark_partner_id" | "payment_method",
  aliasValue: string,
  applyToBookings: boolean,
): Promise<number> {
  const db = await getDb(); if (!db) return 0;

  // Insert (ignora se já existe — UNIQUE)
  try {
    await db.insert(partnerAliases).values({ partnershipId, aliasType, aliasValue });
  } catch (err: any) {
    if (!String(err.message).includes("Duplicate")) throw err;
  }

  if (!applyToBookings) return 0;

  const [p] = await db.select({ name: partnerships.name })
    .from(partnerships).where(eq(partnerships.id, partnershipId)).limit(1);
  if (!p) return 0;

  if (aliasType === "multipark_partner_id") {
    const [r] = await (db as any).execute(sql`
      UPDATE multipark_bookings
      SET campaign = ${p.name}
      WHERE JSON_UNQUOTE(JSON_EXTRACT(rawJson, '$.partnerId')) = ${aliasValue}
    `);
    return (r as any).affectedRows ?? 0;
  } else {
    const [r] = await (db as any).execute(sql`
      UPDATE multipark_bookings
      SET campaign = ${p.name}
      WHERE paymentMethod = ${aliasValue}
        AND (rawJson NOT LIKE '%partnerId%' OR JSON_EXTRACT(rawJson, '$.partnerId') IS NULL)
    `);
    return (r as any).affectedRows ?? 0;
  }
}

/**
 * Sumário de faturação por parceiro. Para cada parceiro calcula:
 *  - aFaturar: comissão gerada no período (de bookings com checkout) +
 *              avença mensal/anual proporcional ao período se o
 *              chargeModel for monthly_fee / yearly_fee
 *  - faturado: somatório das partnership_invoices no período (excepto canceladas)
 *  - emAtraso: partnership_invoices com status='overdue'
 *  - pendente: max(0, aFaturar - faturado)
 *
 * O cálculo de comissão usa os mesmos aliases que getBillingData para
 * fazer match com as reservas.
 */
export async function getPartnerInvoicingSummary(filters: {
  from: string;
  to: string;
  partnerType?: string;
}): Promise<Array<{
  partnershipId: number;
  partnerName: string;
  partnerType: string;
  commissionRate: number;
  monthlyFee: number;
  bookingsCount: number;
  revenueGross: number;
  aFaturar: number;
  faturado: number;
  emAtraso: number;
  pendente: number;
  faturasEmAtrasoCount: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  const fromStr = toMysqlDateTime(new Date(filters.from));
  const toStr = toMysqlDateTime(new Date(filters.to + "T23:59:59"));

  // Período em dias / fracção de mês — para avenças
  const msPerDay = 1000 * 60 * 60 * 24;
  const periodDays = Math.max(
    1,
    Math.floor((new Date(filters.to).getTime() - new Date(filters.from).getTime()) / msPerDay) + 1,
  );
  const monthFraction = periodDays / 30;
  const yearFraction = periodDays / 365;

  // 1) Parcerias (com filtro opcional de tipo). Inclui notes para extrair
  //    config JSON (operatesProjects, cashbackPercent, prizeBudget).
  const partnerRows = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      partnerType: partnerships.partnerType,
      commissionRate: partnerships.commissionRate,
      monthlyFee: partnerships.monthlyFee,
      notes: partnerships.notes,
    })
    .from(partnerships)
    .where(filters.partnerType ? eq(partnerships.partnerType, filters.partnerType) : undefined);

  if (partnerRows.length === 0) return [];

  const { parsePartnerConfig } = await import("../shared/partnerTypes");

  // 2) Aliases para fazer match — mesmo padrão de getBillingData
  const aliasRows = await db.select({
    partnershipId: partnerAliases.partnershipId,
    aliasValue: partnerAliases.aliasValue,
  }).from(partnerAliases);

  // 3) Bookings com checkout efectivo no período, agrupados por campaign
  const bookingRows = await db
    .select({
      campaign: multiparkBookings.campaign,
      bookingsCount: sql<number>`COUNT(*)`,
      revenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(
      and(
        isNotNull(multiparkBookings.campaign),
        sql`${multiparkBookings.status} != 'CANCELLED'`,
        gte(multiparkBookings.checkOut, fromStr),
        lte(multiparkBookings.checkOut, toStr),
      ),
    )
    .groupBy(multiparkBookings.campaign);

  // 4) Map campaign-key (lowercased) → partnershipId
  const keyToPartner = new Map<string, number>();
  function reg(rawKey: string | null | undefined, partnerId: number) {
    if (!rawKey) return;
    const k = rawKey.trim().toLowerCase();
    if (k && !keyToPartner.has(k)) keyToPartner.set(k, partnerId);
  }
  for (const p of partnerRows) {
    reg(p.name, p.id);
  }
  for (const a of aliasRows) {
    reg(a.aliasValue, a.partnershipId);
  }

  // 5) Acumula bookings por parceiro
  const bookingsByPartner = new Map<number, { count: number; revenue: number }>();
  for (const b of bookingRows) {
    const k = (b.campaign ?? "").trim().toLowerCase();
    const pid = keyToPartner.get(k);
    if (!pid) continue;
    const existing = bookingsByPartner.get(pid) ?? { count: 0, revenue: 0 };
    existing.count += Number(b.bookingsCount ?? 0);
    existing.revenue += Number(b.revenue ?? 0);
    bookingsByPartner.set(pid, existing);
  }

  // 6) Partnership invoices no período — agrupadas por parceiro e estado
  const invRows = await db
    .select({
      partnershipId: partnershipInvoices.partnershipId,
      status: partnershipInvoices.invoiceStatus,
      total: sql<number>`COALESCE(SUM(${partnershipInvoices.amount}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(partnershipInvoices)
    .where(
      and(
        gte(partnershipInvoices.sentAt, fromStr),
        lte(partnershipInvoices.sentAt, toStr),
        sql`${partnershipInvoices.invoiceStatus} != 'cancelled'`,
      ),
    )
    .groupBy(partnershipInvoices.partnershipId, partnershipInvoices.invoiceStatus);

  const invByPartner = new Map<number, { faturado: number; emAtraso: number; emAtrasoCount: number }>();
  for (const r of invRows) {
    const ex = invByPartner.get(r.partnershipId) ?? { faturado: 0, emAtraso: 0, emAtrasoCount: 0 };
    const amount = Number(r.total ?? 0);
    ex.faturado += amount;
    if (r.status === "overdue") {
      ex.emAtraso += amount;
      ex.emAtrasoCount += Number(r.count ?? 0);
    }
    invByPartner.set(r.partnershipId, ex);
  }

  // 6b) Para parceiros tipo "operacional" com operatesProjects definidos,
  //     a comissão é calculada sobre TODAS as reservas dos projetos operados
  //     (com checkout no período, não canceladas), expandindo a hierarquia
  //     para cobrir filhos. Independente do campo `campaign`, o que permite
  //     que uma mesma reserva acumule comissão de venda (via campaign) e
  //     comissão operacional (via operatesProjects).
  const operationalPartners = partnerRows
    .filter((p) => (p.partnerType ?? "outro") === "operacional")
    .map((p) => ({ p, cfg: parsePartnerConfig(p.notes ?? null) }))
    .filter(({ cfg }) => Array.isArray(cfg.operatesProjects) && cfg.operatesProjects!.length > 0);

  const operationalRevenueByPartner = new Map<number, { count: number; revenue: number }>();

  if (operationalPartners.length > 0) {
    // Reúne todos os projectIds (com hierarquia) que algum parceiro operacional cobre.
    const allOperatedRaw = new Set<number>();
    for (const { cfg } of operationalPartners) {
      for (const pid of cfg.operatesProjects ?? []) allOperatedRaw.add(pid);
    }
    // Expande a hierarquia: o utilizador pode ter posto a Cidade Porto e
    // espera que apanhe as marcas e parques abaixo.
    const expanded = new Set<number>();
    for (const root of allOperatedRaw) {
      const ids = await resolveProjectIds(root);
      for (const pid of ids) expanded.add(pid);
    }

    if (expanded.size > 0) {
      const opBookings = await db
        .select({
          projectId: multiparkBookings.projectId,
          count: sql<number>`COUNT(*)`,
          revenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
        })
        .from(multiparkBookings)
        .where(
          and(
            sql`${multiparkBookings.status} != 'CANCELLED'`,
            gte(multiparkBookings.checkOut, fromStr),
            lte(multiparkBookings.checkOut, toStr),
            inArray(multiparkBookings.projectId, Array.from(expanded)),
          ),
        )
        .groupBy(multiparkBookings.projectId);

      const revenueByProject = new Map<number, { count: number; revenue: number }>();
      for (const r of opBookings) {
        if (r.projectId == null) continue;
        revenueByProject.set(r.projectId, {
          count: Number(r.count ?? 0),
          revenue: Number(r.revenue ?? 0),
        });
      }

      // Atribui a cada parceiro operacional a soma das reservas dos projetos
      // que ele opera (expandidos).
      for (const { p, cfg } of operationalPartners) {
        let count = 0;
        let revenue = 0;
        const cover = new Set<number>();
        for (const root of cfg.operatesProjects ?? []) {
          const ids = await resolveProjectIds(root);
          for (const pid of ids) cover.add(pid);
        }
        for (const pid of cover) {
          const r = revenueByProject.get(pid);
          if (r) { count += r.count; revenue += r.revenue; }
        }
        operationalRevenueByPartner.set(p.id, { count, revenue });
      }
    }
  }

  // 7) Constrói resultado
  return partnerRows.map((p) => {
    const bk = bookingsByPartner.get(p.id) ?? { count: 0, revenue: 0 };
    const inv = invByPartner.get(p.id) ?? { faturado: 0, emAtraso: 0, emAtrasoCount: 0 };
    const opRev = operationalRevenueByPartner.get(p.id);

    const commissionRate = Number(p.commissionRate ?? 0);
    const monthlyFee = Number(p.monthlyFee ?? 0);
    const partnerType = p.partnerType ?? "outro";

    // Cálculo a faturar conforme tipo
    let aFaturar = 0;
    let displayBookingsCount = bk.count;
    let displayRevenue = bk.revenue;

    if (partnerType === "avenca_mensal") {
      aFaturar = monthlyFee * monthFraction;
    } else if (partnerType === "avenca_anual") {
      aFaturar = monthlyFee * yearFraction;
    } else if (partnerType === "operacional") {
      // Usa o cálculo via operatesProjects se configurado; senão usa o
      // campaign match (fallback). É legítimo um operacional ter ambos.
      const revenue = opRev?.revenue ?? bk.revenue;
      displayRevenue = revenue;
      displayBookingsCount = opRev?.count ?? bk.count;
      aFaturar = (revenue * commissionRate) / 100;
    } else if (
      partnerType === "agregador" ||
      partnerType === "agencia_viagem" ||
      partnerType === "hotel" ||
      partnerType === "companhia_aerea" ||
      partnerType === "afiliado"
    ) {
      aFaturar = (bk.revenue * commissionRate) / 100;
    } else if (partnerType === "cliente_pro") {
      // Cliente Pro: faturado no fim do mês com base nas reservas que ele
      // gerou. A receita já tem desconto aplicado.
      aFaturar = bk.revenue;
    }
    // enterprise / campanha_propria / outro → não há a faturar automático

    const pendente = Math.max(0, aFaturar - inv.faturado);

    return {
      partnershipId: p.id,
      partnerName: p.name,
      partnerType,
      commissionRate,
      monthlyFee,
      bookingsCount: displayBookingsCount,
      revenueGross: displayRevenue,
      aFaturar,
      faturado: inv.faturado,
      emAtraso: inv.emAtraso,
      pendente,
      faturasEmAtrasoCount: inv.emAtrasoCount,
    };
  })
    .sort((a, b) => b.aFaturar - a.aFaturar);
}

/**
 * Detalhe de faturação por tipo de parceiro. Para cada parceiro desse tipo
 * devolve campos próprios do chargeModel:
 *  - commission_on_revenue / small_commission: revenue + commission
 *  - monthly_fee / yearly_fee: monthlyFee (escalar)
 *  - prepaid_with_discount: revenue + desconto agregado
 *  - monthly_invoice_discount (Pro): revenue (a faturar no fim do mês)
 *  - own_campaign: desconto + cashback + prémios (custo)
 *  - operational: revenue via operatesProjects + commission
 */
export async function getPartnerInvoicingDetailByType(filters: {
  from: string;
  to: string;
  partnerType: string;
}): Promise<{
  partnerType: string;
  partners: Array<{
    partnershipId: number;
    partnerName: string;
    commissionRate: number;
    monthlyFee: number;
    bookingsCount: number;
    revenueGross: number;
    discountTotal: number;
    extrasTotal: number;
    cashbackPercent: number;
    cashbackAmount: number;
    prizeBudget: number;
    operatesProjectsCount: number;
    aFaturar: number;
    notes: string | null;
  }>;
}> {
  const db = await getDb();
  if (!db) return { partnerType: filters.partnerType, partners: [] };

  const fromStr = toMysqlDateTime(new Date(filters.from));
  const toStr = toMysqlDateTime(new Date(filters.to + "T23:59:59"));
  const msPerDay = 1000 * 60 * 60 * 24;
  const periodDays = Math.max(
    1,
    Math.floor((new Date(filters.to).getTime() - new Date(filters.from).getTime()) / msPerDay) + 1,
  );
  const monthFraction = periodDays / 30;
  const yearFraction = periodDays / 365;

  const { parsePartnerConfig } = await import("../shared/partnerTypes");

  const partnerRows = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      partnerType: partnerships.partnerType,
      commissionRate: partnerships.commissionRate,
      monthlyFee: partnerships.monthlyFee,
      notes: partnerships.notes,
    })
    .from(partnerships)
    .where(eq(partnerships.partnerType, filters.partnerType));

  if (partnerRows.length === 0) return { partnerType: filters.partnerType, partners: [] };

  // Aliases para o match de campaign
  const aliasRows = await db.select({
    partnershipId: partnerAliases.partnershipId,
    aliasValue: partnerAliases.aliasValue,
  }).from(partnerAliases);

  const keyToPartner = new Map<string, number>();
  function reg(k: string | null | undefined, pid: number) {
    if (!k) return; const x = k.trim().toLowerCase();
    if (x && !keyToPartner.has(x)) keyToPartner.set(x, pid);
  }
  for (const p of partnerRows) reg(p.name, p.id);
  for (const a of aliasRows) reg(a.aliasValue, a.partnershipId);

  // Bookings agrupados por campaign (campanha → parceiro). Só CHECKED_OUT.
  const bookingRows = await db
    .select({
      campaign: multiparkBookings.campaign,
      projectId: multiparkBookings.projectId,
      count: sql<number>`COUNT(*)`,
      revenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
      discount: sql<number>`COALESCE(SUM(${multiparkBookings.discount}), 0)`,
      extras: sql<number>`COALESCE(SUM(${multiparkBookings.extrasTotal}), 0)`,
    })
    .from(multiparkBookings)
    .where(
      and(
        isNotNull(multiparkBookings.campaign),
        sql`${multiparkBookings.status} != 'CANCELLED'`,
        gte(multiparkBookings.checkOut, fromStr),
        lte(multiparkBookings.checkOut, toStr),
      ),
    )
    .groupBy(multiparkBookings.campaign, multiparkBookings.projectId);

  const byPartner = new Map<number, { count: number; revenue: number; discount: number; extras: number }>();
  for (const b of bookingRows) {
    const k = (b.campaign ?? "").trim().toLowerCase();
    const pid = keyToPartner.get(k);
    if (!pid) continue;
    const ex = byPartner.get(pid) ?? { count: 0, revenue: 0, discount: 0, extras: 0 };
    ex.count += Number(b.count ?? 0);
    ex.revenue += Number(b.revenue ?? 0);
    ex.discount += Number(b.discount ?? 0);
    ex.extras += Number(b.extras ?? 0);
    byPartner.set(pid, ex);
  }

  // Para operacional: agregação via projetos operados
  const operationalRevenueByPartner = new Map<number, { count: number; revenue: number }>();
  if (filters.partnerType === "operacional") {
    for (const p of partnerRows) {
      const cfg = parsePartnerConfig(p.notes ?? null);
      const operatedRoots = cfg.operatesProjects ?? [];
      if (operatedRoots.length === 0) continue;
      const expanded = new Set<number>();
      for (const root of operatedRoots) {
        const ids = await resolveProjectIds(root);
        for (const pid of ids) expanded.add(pid);
      }
      if (expanded.size === 0) continue;
      const rows = await db
        .select({
          count: sql<number>`COUNT(*)`,
          revenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
        })
        .from(multiparkBookings)
        .where(
          and(
            sql`${multiparkBookings.status} != 'CANCELLED'`,
            gte(multiparkBookings.checkOut, fromStr),
            lte(multiparkBookings.checkOut, toStr),
            inArray(multiparkBookings.projectId, Array.from(expanded)),
          ),
        );
      operationalRevenueByPartner.set(p.id, {
        count: Number(rows[0]?.count ?? 0),
        revenue: Number(rows[0]?.revenue ?? 0),
      });
    }
  }

  const partners = partnerRows.map((p) => {
    const cfg = parsePartnerConfig(p.notes ?? null);
    const cashbackPercent = Number(cfg.cashbackPercent ?? 0);
    const prizeBudget = Number(cfg.prizeBudget ?? 0);
    const commissionRate = Number(p.commissionRate ?? 0);
    const monthlyFee = Number(p.monthlyFee ?? 0);
    const bk = byPartner.get(p.id) ?? { count: 0, revenue: 0, discount: 0, extras: 0 };
    const opRev = operationalRevenueByPartner.get(p.id);

    let bookingsCount = bk.count;
    let revenueGross = bk.revenue;
    let aFaturar = 0;
    const cashbackAmount = (bk.revenue * cashbackPercent) / 100;

    if (filters.partnerType === "operacional" && opRev) {
      bookingsCount = opRev.count;
      revenueGross = opRev.revenue;
      aFaturar = (opRev.revenue * commissionRate) / 100;
    } else if (filters.partnerType === "avenca_mensal") {
      aFaturar = monthlyFee * monthFraction;
    } else if (filters.partnerType === "avenca_anual") {
      aFaturar = monthlyFee * yearFraction;
    } else if (
      filters.partnerType === "agregador" ||
      filters.partnerType === "agencia_viagem" ||
      filters.partnerType === "hotel" ||
      filters.partnerType === "companhia_aerea" ||
      filters.partnerType === "afiliado"
    ) {
      aFaturar = (bk.revenue * commissionRate) / 100;
    } else if (filters.partnerType === "cliente_pro") {
      aFaturar = bk.revenue;
    }

    return {
      partnershipId: p.id,
      partnerName: p.name,
      commissionRate,
      monthlyFee,
      bookingsCount,
      revenueGross,
      discountTotal: bk.discount,
      extrasTotal: bk.extras,
      cashbackPercent,
      cashbackAmount,
      prizeBudget,
      operatesProjectsCount: (cfg.operatesProjects ?? []).length,
      aFaturar,
      notes: p.notes ?? null,
    };
  }).sort((a, b) => b.aFaturar - a.aFaturar);

  return { partnerType: filters.partnerType, partners };
}

export async function listPartnerAliases(partnershipId: number) {
  const db = await getDb(); if (!db) return [];
  return db.select().from(partnerAliases).where(eq(partnerAliases.partnershipId, partnershipId));
}

/**
 * Para cada partnership, devolve o nº de aliases associados e a lista.
 * Útil para mostrar na UI quantos códigos cada parceiro tem (cada
 * parceiro normalmente tem vários — um por cidade × marca).
 */
export async function aliasCountsByPartner(): Promise<Array<{
  partnershipId: number;
  partnershipName: string | null;
  partnerIds: string[];
  paymentMethods: string[];
  total: number;
}>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      partnershipId: partnerAliases.partnershipId,
      aliasType: partnerAliases.aliasType,
      aliasValue: partnerAliases.aliasValue,
      partnershipName: partnerships.name,
    })
    .from(partnerAliases)
    .leftJoin(partnerships, eq(partnerships.id, partnerAliases.partnershipId));

  const map = new Map<number, { partnershipName: string | null; partnerIds: string[]; paymentMethods: string[] }>();
  for (const r of rows) {
    const entry = map.get(r.partnershipId) ?? { partnershipName: r.partnershipName, partnerIds: [], paymentMethods: [] };
    if (r.aliasType === "multipark_partner_id") entry.partnerIds.push(r.aliasValue);
    else entry.paymentMethods.push(r.aliasValue);
    map.set(r.partnershipId, entry);
  }
  return Array.from(map.entries())
    .map(([id, v]) => ({
      partnershipId: id,
      partnershipName: v.partnershipName,
      partnerIds: v.partnerIds,
      paymentMethods: v.paymentMethods,
      total: v.partnerIds.length + v.paymentMethods.length,
    }))
    .sort((a, b) => b.total - a.total);
}

export async function deletePartnerAlias(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(partnerAliases).where(eq(partnerAliases.id, id));
}

/**
 * Associa um partnerId da Multipark a uma parceria existente.
 * Opcionalmente actualiza a coluna `campaign` de todas as reservas com esse
 * partnerId para o nome do parceiro (substitui "Unknown User").
 */
export async function linkMultiparkPartnerId(
  partnershipId: number,
  multiparkPartnerId: string,
  applyToBookings: boolean,
): Promise<number> {
  const db = await getDb(); if (!db) return 0;

  await db.update(partnerships)
    .set({ multiparkPartnerId })
    .where(eq(partnerships.id, partnershipId));

  if (!applyToBookings) return 0;

  const [p] = await db.select({ name: partnerships.name })
    .from(partnerships).where(eq(partnerships.id, partnershipId)).limit(1);
  if (!p) return 0;

  const [result] = await (db as any).execute(sql`
    UPDATE multipark_bookings
    SET campaign = ${p.name}
    WHERE JSON_UNQUOTE(JSON_EXTRACT(rawJson, '$.partnerId')) = ${multiparkPartnerId}
  `);
  return (result as any).affectedRows ?? 0;
}

export async function getPartnershipById(id: number) {
  const db = await getDb(); if (!db) return null;
  const rows = await db.select().from(partnerships).where(eq(partnerships.id, id)).limit(1);
  return rows[0] || null;
}

export async function updatePartnership(id: number, data: any) {
  const db = await getDb(); if (!db) return;
  await db.update(partnerships).set(data).where(eq(partnerships.id, id));
}

export async function deletePartnership(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(partnershipTransactions).where(eq(partnershipTransactions.partnershipId, id));
  await db.delete(partnerships).where(eq(partnerships.id, id));
}

export async function createPartnershipTransaction(data: any) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(partnershipTransactions).values(data as any).$returningId();
  return result?.id;
}

export async function getPartnershipTransactions(partnershipId: number) {
  const db = await getDb(); if (!db) return [];
  return db.select().from(partnershipTransactions).where(eq(partnershipTransactions.partnershipId, partnershipId)).orderBy(desc(partnershipTransactions.transactionDate));
}

// ─── PARTNERSHIP INVOICES ────────────────────────────────────────────────
export async function createPartnershipInvoice(data: any) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(partnershipInvoices).values(data as any).$returningId();
  return result?.id;
}

export async function getPartnershipInvoices(filters?: { partnershipId?: number; status?: string; year?: number; month?: number }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = [];
  if (filters?.partnershipId) conditions.push(eq(partnershipInvoices.partnershipId, filters.partnershipId));
  if (filters?.status) conditions.push(eq(partnershipInvoices.invoiceStatus, filters.status as any));
  if (filters?.year) conditions.push(eq(partnershipInvoices.referenceYear, filters.year));
  if (filters?.month) conditions.push(eq(partnershipInvoices.referenceMonth, filters.month));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(partnershipInvoices).where(where).orderBy(desc(partnershipInvoices.createdAt));
}

export async function updatePartnershipInvoice(id: number, data: any) {
  const db = await getDb(); if (!db) return;
  await db.update(partnershipInvoices).set(data).where(eq(partnershipInvoices.id, id));
}

export async function deletePartnershipInvoice(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(partnershipInvoices).where(eq(partnershipInvoices.id, id));
}

export async function markOverduePartnershipInvoices() {
  const db = await getDb(); if (!db) return 0;
  const now = new Date();
  const result = await db.update(partnershipInvoices)
    .set({ invoiceStatus: "overdue" as any })
    .where(
      and(
        eq(partnershipInvoices.invoiceStatus, "sent" as any),
        sql`${partnershipInvoices.dueDate} < ${toMysqlDateTime(now)}`
      )
    );
  return (result as any)[0]?.affectedRows || 0;
}

export async function getPartnershipDashboardStats() {
  const db = await getDb(); if (!db) return null;
  const allPartners = await db.select().from(partnerships);
  const allInvoices = await db.select().from(partnershipInvoices);
  const allTx = await db.select().from(partnershipTransactions);

  const totalPartners = allPartners.length;
  const activePartners = allPartners.filter(p => p.partnerStatus === "active").length;
  const byType: Record<string, number> = {};
  allPartners.forEach(p => { byType[p.partnerType] = (byType[p.partnerType] || 0) + 1; });

  const pendingInvoices = allInvoices.filter(i => i.invoiceStatus === "sent");
  const overdueInvoices = allInvoices.filter(i => i.invoiceStatus === "overdue");
  const paidInvoices = allInvoices.filter(i => i.invoiceStatus === "paid");

  const totalPending = pendingInvoices.reduce((s, i) => s + (i.amount || 0), 0);
  const totalOverdue = overdueInvoices.reduce((s, i) => s + (i.amount || 0), 0);
  const totalPaid = paidInvoices.reduce((s, i) => s + (i.amount || 0), 0);
  const totalBookings = allTx.filter(t => t.transactionType === "booking").reduce((s, t) => s + (t.amount || 0), 0);

  // Per-partner summary
  const partnerSummaries = allPartners.map(p => {
    const pInvoices = allInvoices.filter(i => i.partnershipId === p.id);
    const pTx = allTx.filter(t => t.partnershipId === p.id);
    const pending = pInvoices.filter(i => i.invoiceStatus === "sent").reduce((s, i) => s + (i.amount || 0), 0);
    const overdue = pInvoices.filter(i => i.invoiceStatus === "overdue").reduce((s, i) => s + (i.amount || 0), 0);
    const paid = pInvoices.filter(i => i.invoiceStatus === "paid").reduce((s, i) => s + (i.amount || 0), 0);
    const bookings = pTx.filter(t => t.transactionType === "booking").reduce((s, t) => s + (t.amount || 0), 0);
    return {
      ...p,
      invoicesPending: pending,
      invoicesOverdue: overdue,
      invoicesPaid: paid,
      totalBookings: bookings,
      invoiceCount: pInvoices.length,
      hasOverdue: overdue > 0,
    };
  });

  return {
    totalPartners,
    activePartners,
    byType,
    totalPending,
    totalOverdue,
    totalPaid,
    totalBookings,
    pendingCount: pendingInvoices.length,
    overdueCount: overdueInvoices.length,
    partnerSummaries,
  };
}

// ─── ANUAL (ANNUAL REPORTS) ────────────────────────────────────────────────
export async function createAnnualReport(data: any) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(annualReports).values(data as any).$returningId();
  return result?.id;
}

export async function getAnnualReports(filters?: { year?: number; projectId?: number }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = [];
  if (filters?.year) conditions.push(eq(annualReports.year, filters.year));
  if (filters?.projectId) conditions.push(eq(annualReports.projectId, filters.projectId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(annualReports).where(where).orderBy(annualReports.month);
}

export async function updateAnnualReport(id: number, data: any) {
  const db = await getDb(); if (!db) return;
  await db.update(annualReports).set(data).where(eq(annualReports.id, id));
}

export async function deleteAnnualReport(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(annualReports).where(eq(annualReports.id, id));
}

export async function getAnnualBreakdown(year: number, projectId?: number) {
  const db = await getDb();
  if (!db) return [];

  const VAT_RATE = 0.23;

  // Resolve project hierarchy
  let projectIds: number[] | undefined;
  if (projectId) projectIds = await resolveProjectIds(projectId);

  // 1. Revenue: bookings with checkout no ano, excluindo canceladas.
  // Igual ao filtro da Faturação (status != 'CANCELLED' apanha também as
  // canceladas com cancelledAt vazio que o sync não populou).
  const revConds: any[] = [
    gte(multiparkBookings.checkOut, toMysqlDateTime(new Date(`${year}-01-01`))),
    lte(multiparkBookings.checkOut, toMysqlDateTime(new Date(`${year}-12-31T23:59:59`))),
    sql`${multiparkBookings.status} != 'CANCELLED'`,
  ];
  if (projectIds) revConds.push(inArray(multiparkBookings.projectId, projectIds));

  const revenueRows = await db
    .select({
      month: sql<number>`MONTH(${multiparkBookings.checkOut})`,
      total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(...revConds))
    .groupBy(sql`MONTH(${multiparkBookings.checkOut})`);

  // 2. Despesas TODAS (pagas + pendentes + atraso, excepto canceladas) por
  // data da despesa (expenseDate, quando aconteceu), não por paidAt.
  // Visão de P&L de gestão, não fluxo de caixa.
  const expConds: any[] = [
    sql`${expenses.status} != 'cancelled'`,
    gte(expenses.expenseDate, toMysqlDateTime(new Date(`${year}-01-01`))),
    lte(expenses.expenseDate, toMysqlDateTime(new Date(`${year}-12-31T23:59:59`))),
  ];
  if (projectIds) expConds.push(inArray(expenses.projectId, projectIds));

  const expenseRows = await db
    .select({
      month: sql<number>`MONTH(${expenses.expenseDate})`,
      total: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .where(and(...expConds))
    .groupBy(sql`MONTH(${expenses.expenseDate})`);

  // ─── 3. Marketing despesas (marketing_expenses) por mês ──────────────────
  const mktExpConds: any[] = [
    gte(marketingExpenses.date, toMysqlDateTime(new Date(`${year}-01-01`))),
    lte(marketingExpenses.date, toMysqlDateTime(new Date(`${year}-12-31T23:59:59`))),
  ];
  if (projectIds) mktExpConds.push(inArray(marketingExpenses.projectId, projectIds));
  const mktExpRows = await db
    .select({
      month: sql<number>`MONTH(${marketingExpenses.date})`,
      total: sql<number>`COALESCE(SUM(${marketingExpenses.amount}), 0)`,
    })
    .from(marketingExpenses)
    .where(and(...mktExpConds))
    .groupBy(sql`MONTH(${marketingExpenses.date})`);

  // ─── 4. Ad spend (Google/Meta) por mês ──────────────────────────────────
  const adsConds: any[] = [
    gte(campaignDailyStats.date, toMysqlDateTime(new Date(`${year}-01-01`))),
    lte(campaignDailyStats.date, toMysqlDateTime(new Date(`${year}-12-31T23:59:59`))),
  ];
  if (projectIds) adsConds.push(inArray(campaigns.projectId, projectIds));
  const adsRows = await db
    .select({
      month: sql<number>`MONTH(${campaignDailyStats.date})`,
      total: sql<number>`COALESCE(SUM(${campaignDailyStats.spend}), 0)`,
    })
    .from(campaignDailyStats)
    .innerJoin(campaigns, eq(campaigns.id, campaignDailyStats.campaignId))
    .where(and(...adsConds))
    .groupBy(sql`MONTH(${campaignDailyStats.date})`);

  // ─── 5. Extras-dia (custo da equipa diária) por mês ─────────────────────
  // assignmentDate é varchar("YYYY-MM-DD"). Agrupamos pelo dia e fazemos
  // o bucket por mês em JS, evitando problemas com strict mode do MySQL.
  // CRÍTICO: filtra isTeamLeader=0 — os team leaders são adicionados ao
  // extras-dia só para repartir o gasto diário do salário deles, mas o
  // pagamento real é o salário mensal (entra em "salaries"). Sem isto
  // estaríamos a contar o team leader duas vezes.
  const extrasRows = await db
    .select({
      date: extrasDiaAssignments.assignmentDate,
      level: extrasDiaAssignments.level,
      hours: sql<number>`COALESCE(SUM(GREATEST(${extrasDiaAssignments.endHour} - ${extrasDiaAssignments.startHour}, 0)), 0)`,
    })
    .from(extrasDiaAssignments)
    .where(
      and(
        gte(extrasDiaAssignments.assignmentDate, `${year}-01-01`),
        lte(extrasDiaAssignments.assignmentDate, `${year}-12-31`),
        eq(extrasDiaAssignments.isTeamLeader, 0),
      ),
    )
    .groupBy(extrasDiaAssignments.assignmentDate, extrasDiaAssignments.level);

  const extrasDiaByMonth: Record<number, number> = {};
  for (const r of extrasRows) {
    const rate = EXTRAS_DIA_RATES[String(r.level ?? "junior")] ?? 4;
    const m = Number((r.date ?? "").slice(5, 7));
    if (!m) continue;
    extrasDiaByMonth[m] = (extrasDiaByMonth[m] ?? 0) + Number(r.hours) * rate;
  }

  // ─── 6. Comissões parceiros (venda + operacional) descontadas da receita ─
  // Carrega aliases + parceiros para fazer match com bookings.campaign e
  // calcular comissão por mês. Para operacional, aplica % das reservas dos
  // projetos operados (mesmo padrão de getBillingData).
  const allPartners = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      campaignKey: partnerships.campaignKey,
      commissionRate: partnerships.commissionRate,
      partnerType: partnerships.partnerType,
      notes: partnerships.notes,
      updatedAt: partnerships.updatedAt,
    })
    .from(partnerships);
  const allAliases = await db
    .select({ partnershipId: partnerAliases.partnershipId, aliasValue: partnerAliases.aliasValue })
    .from(partnerAliases);
  const partnerByCampaign = new Map<string, { id: number; name: string; rate: number; updatedAt: string }>();
  const registerKey = (k: string | null, id: number, name: string, rate: number, updatedAt: string) => {
    if (!k) return;
    const key = k.trim().toLowerCase();
    if (!key) return;
    const ex = partnerByCampaign.get(key);
    if (!ex || updatedAt > ex.updatedAt) {
      partnerByCampaign.set(key, { id, name, rate, updatedAt });
    }
  };
  for (const p of allPartners) {
    const rate = Number(p.commissionRate ?? 0);
    const updatedAt = p.updatedAt ?? "";
    registerKey(p.campaignKey, p.id, p.name, rate, updatedAt);
    registerKey(p.name, p.id, p.name, rate, updatedAt);
  }
  const partnerById = new Map(allPartners.map(p => [p.id, p]));
  for (const a of allAliases) {
    const p = partnerById.get(a.partnershipId);
    if (!p) continue;
    registerKey(a.aliasValue, p.id, p.name, Number(p.commissionRate ?? 0), p.updatedAt ?? "");
  }

  const bookingsByMonthCampaign = await db
    .select({
      month: sql<number>`MONTH(${multiparkBookings.checkOut})`,
      campaign: multiparkBookings.campaign,
      revenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(...revConds, isNotNull(multiparkBookings.campaign)))
    .groupBy(sql`MONTH(${multiparkBookings.checkOut})`, multiparkBookings.campaign);

  const salesCommissionByMonth: Record<number, number> = {};
  for (const r of bookingsByMonthCampaign) {
    const key = (r.campaign ?? "").trim().toLowerCase();
    const partner = partnerByCampaign.get(key);
    if (!partner) continue;
    const m = Number(r.month);
    salesCommissionByMonth[m] = (salesCommissionByMonth[m] ?? 0) + Number(r.revenue) * (partner.rate / 100);
  }

  // Operacional: para parceiros tipo "operacional" com operatesProjects
  const { parsePartnerConfig } = await import("../shared/partnerTypes");
  const operationalPartnersList = allPartners
    .filter(p => (p.partnerType ?? "outro") === "operacional")
    .map(p => ({ p, cfg: parsePartnerConfig(p.notes ?? null) }))
    .filter(({ cfg }) => Array.isArray(cfg.operatesProjects) && cfg.operatesProjects!.length > 0);

  const operationalCommissionByMonth: Record<number, number> = {};
  for (const { p, cfg } of operationalPartnersList) {
    const expanded = new Set<number>();
    for (const root of cfg.operatesProjects ?? []) {
      const ids = await resolveProjectIds(root);
      for (const pid of ids) expanded.add(pid);
    }
    if (expanded.size === 0) continue;
    const rows = await db
      .select({
        month: sql<number>`MONTH(${multiparkBookings.checkOut})`,
        revenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
      })
      .from(multiparkBookings)
      .where(
        and(
          gte(multiparkBookings.checkOut, toMysqlDateTime(new Date(`${year}-01-01`))),
          lte(multiparkBookings.checkOut, toMysqlDateTime(new Date(`${year}-12-31T23:59:59`))),
          sql`${multiparkBookings.status} != 'CANCELLED'`,
          inArray(multiparkBookings.projectId, Array.from(expanded)),
        ),
      )
      .groupBy(sql`MONTH(${multiparkBookings.checkOut})`);
    const rate = Number(p.commissionRate ?? 0) / 100;
    for (const r of rows) {
      const m = Number(r.month);
      operationalCommissionByMonth[m] = (operationalCommissionByMonth[m] ?? 0) + Number(r.revenue) * rate;
    }
  }

  // ─── 7. Payroll por mês COM RATEIO hierárquico — em paralelo ────────────
  // Resolver descendentes folha para rateio do salário de quem está no
  // topo (igual ao que se faz em getPartnerInvoicingSummary).
  const allProjsForRateio = await db
    .select({ id: projects.id, name: projects.name, parentId: projects.parentId, level: projects.level })
    .from(projects);
  const childrenMap = new Map<number, number[]>();
  for (const p of allProjsForRateio) {
    if (p.parentId != null) {
      if (!childrenMap.has(p.parentId)) childrenMap.set(p.parentId, []);
      childrenMap.get(p.parentId)!.push(p.id);
    }
  }
  function leafDescendants(pid: number): number[] {
    const self = allProjsForRateio.find(x => x.id === pid);
    if (!self) return [pid];
    if (self.level === "project") return [pid];
    const kids = childrenMap.get(pid) ?? [];
    if (kids.length === 0) return [pid];
    const out: number[] = [];
    for (const k of kids) out.push(...leafDescendants(k));
    return out.length > 0 ? out : [pid];
  }

  // TSU employer rate in Portugal: 23.75%
  const TSU_EMPLOYER = 0.2375;

  // PARALELIZA as 12 chamadas em vez de loop sequencial — 12x mais rápido
  const monthIds = Array.from({ length: 12 }, (_, i) => i + 1);
  const payrollResults = await Promise.all(monthIds.map(async (m) => {
    try {
      const payroll = await getPayrollData(year, m);
      // Rateio: para cada entrada, expande para descendentes folha
      let totalSalaries = 0;
      let totalEmployerTax = 0;
      for (const p of payroll) {
        const taxableBase = p.isExtra
          ? p.extraPayment
          : (p.baseSalary + p.overtimePayment + p.nightPayment + p.weekendPayment);
        const employerTaxForEmp = taxableBase * TSU_EMPLOYER;
        const empProjectId = p.projectId ?? null;
        if (empProjectId == null) {
          // Sem projeto: só conta se não há filtro
          if (!projectIds) {
            totalSalaries += p.totalPayment;
            totalEmployerTax += employerTaxForEmp;
          }
          continue;
        }
        const targets = leafDescendants(empProjectId);
        // Se há filtro de projeto, vê quantos targets caem no filtro
        const matching = projectIds ? targets.filter(t => projectIds!.includes(t)) : targets;
        if (matching.length === 0) continue;
        const share = matching.length / targets.length; // fracção que cai no filtro
        totalSalaries += p.totalPayment * share;
        totalEmployerTax += employerTaxForEmp * share;
      }
      return [m, { salaries: Math.round(totalSalaries * 100) / 100, employerTax: Math.round(totalEmployerTax * 100) / 100 }] as const;
    } catch {
      return [m, { salaries: 0, employerTax: 0 }] as const;
    }
  }));
  const payrollByMonth: Record<number, { salaries: number; employerTax: number }> = {};
  for (const [m, v] of payrollResults) payrollByMonth[m] = v;

  // ─── 8. Build monthly breakdown ──────────────────────────────────────────
  const revMap = new Map(revenueRows.map(r => [Number(r.month), Number(r.total)]));
  const expMap = new Map(expenseRows.map(e => [Number(e.month), Number(e.total)]));
  const mktExpMap = new Map(mktExpRows.map(r => [Number(r.month), Number(r.total)]));
  const adsMap = new Map(adsRows.map(r => [Number(r.month), Number(r.total)]));

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const revenueGrossWithVat = revMap.get(m) ?? 0;
    const salesCommissions = Math.round((salesCommissionByMonth[m] ?? 0) * 100) / 100;
    const operationalCommissions = Math.round((operationalCommissionByMonth[m] ?? 0) * 100) / 100;
    // Receita líquida: comissões saem ANTES dos impostos
    const revenueWithVat = revenueGrossWithVat - salesCommissions - operationalCommissions;

    const expensesWithVat = expMap.get(m) ?? 0;
    const marketingCost = (mktExpMap.get(m) ?? 0) + (adsMap.get(m) ?? 0);
    const extrasDiaCost = extrasDiaByMonth[m] ?? 0;
    const salaries = payrollByMonth[m]?.salaries ?? 0;
    const employerTax = payrollByMonth[m]?.employerTax ?? 0;

    const vatRevenue = Math.round(revenueWithVat * VAT_RATE / (1 + VAT_RATE) * 100) / 100;
    const vatExpenses = Math.round(expensesWithVat * VAT_RATE / (1 + VAT_RATE) * 100) / 100;
    const vatToPay = Math.round((vatRevenue - vatExpenses) * 100) / 100;

    const revenueNoVat = Math.round((revenueWithVat - vatRevenue) * 100) / 100;
    const expensesNoVat = Math.round((expensesWithVat - vatExpenses) * 100) / 100;

    const totalCosts = expensesNoVat + marketingCost + extrasDiaCost + salaries + employerTax;
    const profit = Math.round((revenueNoVat - totalCosts) * 100) / 100;

    months.push({
      month: m,
      revenueGrossWithVat: Math.round(revenueGrossWithVat * 100) / 100,
      salesCommissions,
      operationalCommissions,
      revenueWithVat: Math.round(revenueWithVat * 100) / 100,
      revenueNoVat,
      vatRevenue,
      expensesWithVat,
      expensesNoVat,
      vatExpenses,
      vatToPay,
      marketingCost: Math.round(marketingCost * 100) / 100,
      extrasDiaCost: Math.round(extrasDiaCost * 100) / 100,
      salaries,
      employerTax,
      totalCosts: Math.round(totalCosts * 100) / 100,
      profit,
    });
  }

  return months;
}

export async function generateAnnualSummary(year: number, projectId?: number, splitPartner: number = 60) {
  const db = await getDb(); if (!db) return [];
  // Get all invoices for the year (Faturação)
  const allInvoices = await db.select().from(invoices);
  const yearInvoices = allInvoices.filter(i => {
    const d = new Date(i.issueDate);
    return d.getFullYear() === year && (!projectId || i.projectId === projectId);
  });
  
  // Get all services for the year (Serviços extra: lavagens, carregamentos, valet)
  const allServices = await db.select().from(services);
  const yearServices = allServices.filter(s => {
    const d = new Date(s.serviceDate);
    return d.getFullYear() === year;
  });
  
  // Get all expenses for the year (Despesas)
  const allExpenses = await db.select().from(expenses);
  const yearExpenses = allExpenses.filter(e => {
    const d = new Date(e.createdAt);
    return d.getFullYear() === year && (!projectId || e.projectId === projectId);
  });
  
  // Group by month
  const monthly: Record<number, { invoiceRevenue: number; serviceRevenue: number; serviceCost: number; expenses: number }> = {};
  for (let m = 1; m <= 12; m++) monthly[m] = { invoiceRevenue: 0, serviceRevenue: 0, serviceCost: 0, expenses: 0 };
  
  for (const inv of yearInvoices) {
    const m = new Date(inv.issueDate).getMonth() + 1;
    monthly[m].invoiceRevenue += inv.totalAmount || 0;
  }
  for (const svc of yearServices) {
    const m = new Date(svc.serviceDate).getMonth() + 1;
    monthly[m].serviceRevenue += svc.revenue || 0;
    monthly[m].serviceCost += svc.cost || 0;
  }
  for (const exp of yearExpenses) {
    const m = new Date(exp.createdAt).getMonth() + 1;
    monthly[m].expenses += parseFloat(exp.amount) || 0;
  }
  
  const partnerPct = splitPartner / 100;
  const companyPct = 1 - partnerPct;
  const splitLabel = `${splitPartner}/${100 - splitPartner}`;
  
  const results: any[] = [];
  for (let m = 1; m <= 12; m++) {
    const revenue = monthly[m].invoiceRevenue + monthly[m].serviceRevenue;
    const expenseTotal = monthly[m].expenses + monthly[m].serviceCost;
    const profit = revenue - expenseTotal;
    const partnerShare = Math.round(profit * partnerPct);
    const companyShare = Math.round(profit * companyPct);
    
    // Check if report exists
    const existing = await db.select().from(annualReports).where(
      and(
        eq(annualReports.month, m),
        eq(annualReports.year, year),
        projectId ? eq(annualReports.projectId, projectId) : sql`1=1`
      )
    );
    
    const reportData = {
      projectId: projectId || null,
      month: m,
      year,
      totalRevenue: revenue,
      totalExpenses: expenseTotal,
      partnerShare,
      companyShare,
      splitRatio: splitLabel,
    };
    
    if (existing.length > 0) {
      await db.update(annualReports).set(reportData as any).where(eq(annualReports.id, existing[0].id));
      results.push({ ...reportData, id: existing[0].id });
    } else {
      const [result] = await db.insert(annualReports).values(reportData as any).$returningId();
      results.push({ ...reportData, id: result?.id });
    }
  }
  
  return results;
}


// ─── MULTIPARK BOOKINGS ──────────────────────────────────────────────────────

export async function getMultiparkBookings(filters?: {
  status?: string;
  parkingType?: string;
  city?: string;
  parkId?: string;
  from?: Date;
  to?: Date;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters?.status) conditions.push(eq(multiparkBookings.status, filters.status));
  if (filters?.parkingType) conditions.push(eq(multiparkBookings.parkingType, filters.parkingType));
  if (filters?.city) conditions.push(eq(multiparkBookings.city, filters.city));
  if (filters?.parkId) conditions.push(eq(multiparkBookings.parkId, filters.parkId));
  if (filters?.from) conditions.push(gte(multiparkBookings.checkIn, toMysqlDateTime(filters.from)));
  if (filters?.to) conditions.push(lte(multiparkBookings.checkIn, toMysqlDateTime(filters.to)));
  if (filters?.search) {
    const s = `%${filters.search}%`;
    conditions.push(
      or(
        like(multiparkBookings.clientFirstName, s),
        like(multiparkBookings.clientLastName, s),
        like(multiparkBookings.licensePlate, s),
        like(multiparkBookings.bookingNumber, s),
        like(multiparkBookings.clientEmail, s),
      )
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db
    .select()
    .from(multiparkBookings)
    .where(where)
    .orderBy(desc(multiparkBookings.checkIn))
    .limit(filters?.limit ?? 100)
    .offset(filters?.offset ?? 0);
}

export async function getLocalBookingsByAction(filters: {
  startDate: string;
  endDate: string;
  actionType: "creation" | "checkin" | "checkout" | "cancelation";
  projectId?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const conditions: any[] = [];

  // Filter by date range based on actionType
  const endWithTime = filters.endDate + " 23:59:59";
  switch (filters.actionType) {
    case "creation":
      conditions.push(gte(multiparkBookings.bookingCreatedAt, filters.startDate));
      conditions.push(lte(multiparkBookings.bookingCreatedAt, endWithTime));
      conditions.push(sql`${multiparkBookings.status} != 'CANCELLED'`);
      break;
    case "checkin":
      conditions.push(gte(multiparkBookings.checkIn, filters.startDate));
      conditions.push(lte(multiparkBookings.checkIn, endWithTime));
      conditions.push(sql`${multiparkBookings.status} != 'CANCELLED'`);
      break;
    case "checkout":
      conditions.push(gte(multiparkBookings.checkOut, filters.startDate));
      conditions.push(lte(multiparkBookings.checkOut, endWithTime));
      conditions.push(sql`${multiparkBookings.status} != 'CANCELLED'`);
      break;
    case "cancelation":
      conditions.push(gte(multiparkBookings.cancelledAt, filters.startDate));
      conditions.push(lte(multiparkBookings.cancelledAt, endWithTime));
      break;
  }

  // Filter by project hierarchy (include all children)
  if (filters.projectId) {
    const allProjects = await db.select().from(projects);
    const ids = new Set<number>();
    const addChildren = (parentId: number) => {
      ids.add(parentId);
      for (const p of allProjects) {
        if (p.parentId === parentId) addChildren(p.id);
      }
    };
    addChildren(filters.projectId);
    conditions.push(sql`${multiparkBookings.projectId} IN (${sql.raw(Array.from(ids).join(","))})`);
  }

  return db
    .select()
    .from(multiparkBookings)
    .where(and(...conditions))
    .orderBy(desc(multiparkBookings.bookingCreatedAt))
    .limit(5000);
}

export async function searchBookingByRef(search: string) {
  const db = await getDb();
  if (!db) return [];
  const s = `%${search.trim()}%`;
  return db.select({
    id: multiparkBookings.id,
    externalId: multiparkBookings.externalId,
    bookingNumber: multiparkBookings.bookingNumber,
    status: multiparkBookings.status,
    parkName: multiparkBookings.parkName,
    city: multiparkBookings.city,
    projectId: multiparkBookings.projectId,
    checkIn: multiparkBookings.checkIn,
    checkOut: multiparkBookings.checkOut,
    totalPrice: multiparkBookings.totalPrice,
    clientFirstName: multiparkBookings.clientFirstName,
    clientLastName: multiparkBookings.clientLastName,
    clientEmail: multiparkBookings.clientEmail,
    clientPhone: multiparkBookings.clientPhone,
    licensePlate: multiparkBookings.licensePlate,
  })
    .from(multiparkBookings)
    .where(or(
      like(multiparkBookings.bookingNumber, s),
      like(multiparkBookings.externalId, s),
      like(multiparkBookings.clientEmail, s),
      like(multiparkBookings.licensePlate, s),
      like(multiparkBookings.clientFirstName, s),
      like(multiparkBookings.clientLastName, s),
      like(multiparkBookings.clientPhone, s),
    ))
    .orderBy(desc(multiparkBookings.bookingCreatedAt))
    .limit(10);
}

export async function getMultiparkBookingByExternalId(externalId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(multiparkBookings).where(eq(multiparkBookings.externalId, externalId)).limit(1);
  return rows[0];
}

export async function upsertMultiparkBooking(data: InsertMultiparkBooking) {
  const db = await getDb();
  if (!db) return;
  // Upsert atómico — INSERT ... ON DUPLICATE KEY UPDATE. Requer o unique
  // index criado pela migration 0043 para proteger contra race condition
  // (vários Promise concorrentes do sync a tentar inserir o mesmo
  // externalId em action types diferentes). O SELECT extra antes serve
  // só para distinguir created/updated para os contadores do sync.
  const { externalId, ...rest } = data;
  const before = await db
    .select({ id: multiparkBookings.id, status: multiparkBookings.status })
    .from(multiparkBookings)
    .where(eq(multiparkBookings.externalId, externalId))
    .limit(1);
  const existed = before.length > 0;
  // Se o estado mudou (ex: BOOKED→CHECKED_IN→CHECKED_OUT), reabre o enrichment
  // (enrichedAt=null) para o /bookings/:id ser re-buscado e refrescar os campos
  // que só vêm do detalhe (parceiro real, origem, pagamento, etc.) — e reabre
  // também a história (historyFetchedAt=null): sem isto os CHECK_IN/CHECK_OUT/
  // MOVEMENT dos condutores feitos DEPOIS da primeira busca nunca entravam em
  // multipark_booking_history automaticamente (só via botões manuais).
  const statusChanged = existed && (before[0].status ?? null) !== (data.status ?? null);
  const setOnDup: any = statusChanged ? { ...rest, enrichedAt: null, historyFetchedAt: null } : rest;
  await db
    .insert(multiparkBookings)
    .values(data as any)
    .onDuplicateKeyUpdate({ set: setOnDup });
  if (existed) {
    return { id: before[0].id, action: "updated" as const, statusChanged };
  }
  const [row] = await db
    .select({ id: multiparkBookings.id })
    .from(multiparkBookings)
    .where(eq(multiparkBookings.externalId, externalId))
    .limit(1);
  return { id: row?.id, action: "created" as const, statusChanged: false };
}

/**
 * Persiste os extraServices itemizados de uma reserva na tabela-filha.
 * Substitui o conjunto (delete + insert) para manter o estado `done` actual
 * em re-syncs. Não faz nada se a reserva não trouxer extras.
 */
export async function upsertBookingExtras(
  bookingExternalId: string,
  extras: Array<{ id?: string; name?: string; description?: string; price?: number; done?: boolean }> | null | undefined,
) {
  const db = await getDb();
  if (!db) return;
  if (!Array.isArray(extras) || extras.length === 0) return;
  await db.delete(multiparkBookingExtras).where(eq(multiparkBookingExtras.bookingExternalId, bookingExternalId));
  await db.insert(multiparkBookingExtras).values(
    extras.map((e) => ({
      bookingExternalId,
      extraId: e.id ? String(e.id).slice(0, 128) : null,
      name: typeof e.name === "string" ? e.name.slice(0, 256) : null,
      description: typeof e.description === "string" ? e.description.slice(0, 512) : null,
      price: e.price != null ? String(e.price) : null,
      done: e.done ? 1 : 0,
    })),
  );
}

export async function getMultiparkBookingStats(filters?: { from?: string; to?: string; projectId?: number }) {
  const db = await getDb();
  const empty = { total: 0, reservasHoje: 0, checkinHoje: 0, checkoutHoje: 0, canceladosHoje: 0, reservasMes: 0, checkinMes: 0, checkoutMes: 0, canceladosMes: 0, receitaHoje: 0, receitaMes: 0, receitaPeriodo: 0, byCity: [] as { name: string; bookings: number; revenue: number }[], byDay: [] as { date: string; reservas: number; checkins: number; checkouts: number; cancelados: number; revenue: number }[], byBrand: [] as { name: string; bookings: number; revenue: number }[] };
  if (!db) return empty;

  // Resolve project hierarchy for filtering
  let projectFilter: any = undefined;
  if (filters?.projectId) {
    const allProjects = await db.select().from(projects);
    const ids = new Set<number>();
    const addChildren = (parentId: number) => {
      ids.add(parentId);
      for (const p of allProjects) {
        if (p.parentId === parentId) addChildren(p.id);
      }
    };
    addChildren(filters.projectId);
    projectFilter = sql`${multiparkBookings.projectId} IN (${sql.raw(Array.from(ids).join(",") || "0")})`;
  }

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const todayEnd = todayStr + " 23:59:59";
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const countQuery = (dateCol: any, start: string, end: string, excludeCancelled = true) => {
    const conds: any[] = [gte(dateCol, start), lte(dateCol, end)];
    if (excludeCancelled) conds.push(sql`${multiparkBookings.status} != 'CANCELLED'`);
    if (projectFilter) conds.push(projectFilter);
    return db.select({
      count: sql<number>`COUNT(*)`,
      revenue: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    }).from(multiparkBookings).where(and(...conds));
  };

  // Period for byDay/byCity breakdown
  const periodFrom = filters?.from || monthStart;
  const periodTo = (filters?.to || todayStr) + " 23:59:59";

  const [
    [totalRow],
    [resHoje], [resMonth],
    [ciHoje], [ciMonth],
    [coHoje], [coMonth],
    [canHoje], [canMonth],
    [periodRevRow],
    byCityRows,
    byDayRows,
    byBrandRows,
  ] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)` }).from(multiparkBookings).where(projectFilter ? and(projectFilter) : undefined),
    countQuery(multiparkBookings.bookingCreatedAt, todayStr, todayEnd),
    countQuery(multiparkBookings.bookingCreatedAt, monthStart, todayEnd),
    countQuery(multiparkBookings.checkIn, todayStr, todayEnd),
    countQuery(multiparkBookings.checkIn, monthStart, todayEnd),
    countQuery(multiparkBookings.checkOut, todayStr, todayEnd),
    countQuery(multiparkBookings.checkOut, monthStart, todayEnd),
    countQuery(multiparkBookings.cancelledAt, todayStr, todayEnd, false),
    countQuery(multiparkBookings.cancelledAt, monthStart, todayEnd, false),
    // Revenue for the full filter period
    (() => {
      const conds: any[] = [gte(multiparkBookings.checkIn, periodFrom), lte(multiparkBookings.checkIn, periodTo), sql`${multiparkBookings.status} != 'CANCELLED'`];
      if (projectFilter) conds.push(projectFilter);
      return db.select({ revenue: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)` }).from(multiparkBookings).where(and(...conds));
    })(),
    // By city
    (() => {
      const conds: any[] = [gte(multiparkBookings.bookingCreatedAt, periodFrom), lte(multiparkBookings.bookingCreatedAt, periodTo), sql`${multiparkBookings.status} != 'CANCELLED'`];
      if (projectFilter) conds.push(projectFilter);
      return db.select({
        name: multiparkBookings.city,
        bookings: sql<number>`COUNT(*)`,
        revenue: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
      }).from(multiparkBookings).where(and(...conds)).groupBy(multiparkBookings.city);
    })(),
    // By day
    (() => {
      const conds: any[] = [gte(multiparkBookings.bookingCreatedAt, periodFrom), lte(multiparkBookings.bookingCreatedAt, periodTo), sql`${multiparkBookings.status} != 'CANCELLED'`];
      if (projectFilter) conds.push(projectFilter);
      return db.select({
        date: sql<string>`DATE(${multiparkBookings.bookingCreatedAt})`,
        reservas: sql<number>`COUNT(*)`,
        revenue: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
      }).from(multiparkBookings).where(and(...conds)).groupBy(sql`DATE(${multiparkBookings.bookingCreatedAt})`).orderBy(sql`DATE(${multiparkBookings.bookingCreatedAt})`);
    })(),
    // By brand (parkName)
    (() => {
      const conds: any[] = [gte(multiparkBookings.bookingCreatedAt, periodFrom), lte(multiparkBookings.bookingCreatedAt, periodTo), sql`${multiparkBookings.status} != 'CANCELLED'`];
      if (projectFilter) conds.push(projectFilter);
      return db.select({
        name: multiparkBookings.parkName,
        bookings: sql<number>`COUNT(*)`,
        revenue: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
      }).from(multiparkBookings).where(and(...conds)).groupBy(multiparkBookings.parkName);
    })(),
  ]);

  // We need checkin/checkout/cancelation counts per day too for charts
  const [ciByDay, coByDay, canByDay] = await Promise.all([
    (() => {
      const conds: any[] = [gte(multiparkBookings.checkIn, periodFrom), lte(multiparkBookings.checkIn, periodTo), sql`${multiparkBookings.status} != 'CANCELLED'`];
      if (projectFilter) conds.push(projectFilter);
      return db.select({ date: sql<string>`DATE(${multiparkBookings.checkIn})`, count: sql<number>`COUNT(*)` }).from(multiparkBookings).where(and(...conds)).groupBy(sql`DATE(${multiparkBookings.checkIn})`);
    })(),
    (() => {
      const conds: any[] = [gte(multiparkBookings.checkOut, periodFrom), lte(multiparkBookings.checkOut, periodTo), sql`${multiparkBookings.status} != 'CANCELLED'`];
      if (projectFilter) conds.push(projectFilter);
      return db.select({ date: sql<string>`DATE(${multiparkBookings.checkOut})`, count: sql<number>`COUNT(*)` }).from(multiparkBookings).where(and(...conds)).groupBy(sql`DATE(${multiparkBookings.checkOut})`);
    })(),
    (() => {
      const conds: any[] = [gte(multiparkBookings.cancelledAt, periodFrom), lte(multiparkBookings.cancelledAt, periodTo)];
      if (projectFilter) conds.push(projectFilter);
      return db.select({ date: sql<string>`DATE(${multiparkBookings.cancelledAt})`, count: sql<number>`COUNT(*)` }).from(multiparkBookings).where(and(...conds)).groupBy(sql`DATE(${multiparkBookings.cancelledAt})`);
    })(),
  ]);

  // Merge daily data
  const ciMap = new Map(ciByDay.map(r => [r.date, r.count]));
  const coMap = new Map(coByDay.map(r => [r.date, r.count]));
  const canMap = new Map(canByDay.map(r => [r.date, r.count]));
  const byDay = byDayRows.map(r => ({
    date: r.date,
    reservas: r.reservas,
    checkins: ciMap.get(r.date) ?? 0,
    checkouts: coMap.get(r.date) ?? 0,
    cancelados: canMap.get(r.date) ?? 0,
    revenue: parseFloat(String(r.revenue ?? 0)),
  }));

  return {
    total: totalRow?.count ?? 0,
    reservasHoje: resHoje?.count ?? 0,
    checkinHoje: ciHoje?.count ?? 0,
    checkoutHoje: coHoje?.count ?? 0,
    canceladosHoje: canHoje?.count ?? 0,
    reservasMes: resMonth?.count ?? 0,
    checkinMes: ciMonth?.count ?? 0,
    checkoutMes: coMonth?.count ?? 0,
    canceladosMes: canMonth?.count ?? 0,
    receitaHoje: parseFloat(String(ciHoje?.revenue ?? 0)),
    receitaMes: parseFloat(String(ciMonth?.revenue ?? 0)),
    receitaPeriodo: parseFloat(String(periodRevRow?.revenue ?? 0)),
    byCity: byCityRows.map(r => ({ name: r.name ?? "Desconhecido", bookings: r.bookings, revenue: parseFloat(String(r.revenue ?? 0)) })),
    byDay,
    byBrand: byBrandRows.map(r => ({ name: r.name ?? "Desconhecido", bookings: r.bookings, revenue: parseFloat(String(r.revenue ?? 0)) })),
  };
}

// ─── MULTIPARK SYNC LOGS ─────────────────────────────────────────────────────

export async function createSyncLog(data: {
  syncType: string;
  status: string;
  recordsProcessed?: number;
  recordsCreated?: number;
  recordsUpdated?: number;
  errorMessage?: string;
  triggeredById?: number;
  completedAt?: Date;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(multiparkSyncLogs).values(data as any);
}

export async function getSyncLogs(limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(multiparkSyncLogs).orderBy(desc(multiparkSyncLogs.startedAt)).limit(limit);
}

/** Quando começou o último sync que chegou ao fim (success ou partial).
 *  Usado pelo cron para auto-alargar a janela quando o GitHub Actions
 *  atrasa ou falha runs — sem isto, gaps > windowMinutes perdem reservas. */
export async function getLastSyncSuccessAt(syncType = "api_sync"): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ startedAt: multiparkSyncLogs.startedAt })
    .from(multiparkSyncLogs)
    .where(and(
      eq(multiparkSyncLogs.syncType, syncType),
      inArray(multiparkSyncLogs.status, ["success", "partial"]),
    ))
    .orderBy(desc(multiparkSyncLogs.startedAt))
    .limit(1);
  return rows[0]?.startedAt ?? null;
}


// ─── MULTIPARK DAILY SNAPSHOTS (KPIs) ────────────────────────────────────────

export async function upsertDailySnapshot(data: InsertMultiparkDailySnapshot) {
  const db = await getDb();
  if (!db) return;
  // Check if snapshot already exists for this date+park
  const existing = await db
    .select({ id: multiparkDailySnapshots.id })
    .from(multiparkDailySnapshots)
    .where(
      and(
        eq(multiparkDailySnapshots.snapshotDate, data.snapshotDate!),
        eq(multiparkDailySnapshots.parkName, data.parkName),
        eq(multiparkDailySnapshots.city, data.city),
      )
    )
    .limit(1);

  if (existing.length > 0) {
    const { id, ...updateData } = data as any;
    await db.update(multiparkDailySnapshots).set(updateData).where(eq(multiparkDailySnapshots.id, existing[0].id));
    return { id: existing[0].id, action: "updated" as const };
  } else {
    const [result] = await db.insert(multiparkDailySnapshots).values(data as any).$returningId();
    return { id: result?.id, action: "created" as const };
  }
}

export async function getDailySnapshots(filters?: {
  from?: Date;
  to?: Date;
  parkName?: string;
  city?: string;
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters?.from) conditions.push(gte(multiparkDailySnapshots.snapshotDate, toMysqlDateTime(filters.from)));
  if (filters?.to) conditions.push(lte(multiparkDailySnapshots.snapshotDate, toMysqlDateTime(filters.to)));
  if (filters?.parkName) conditions.push(eq(multiparkDailySnapshots.parkName, filters.parkName));
  if (filters?.city) conditions.push(eq(multiparkDailySnapshots.city, filters.city));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db
    .select()
    .from(multiparkDailySnapshots)
    .where(where)
    .orderBy(desc(multiparkDailySnapshots.snapshotDate))
    .limit(filters?.limit ?? 500);
}

export async function getSnapshotKPIs(filters?: { from?: Date; to?: Date; city?: string }) {
  const db = await getDb();
  if (!db) return { totalBookings: 0, totalRevenue: 0, checkins: 0, checkouts: 0, cancelled: 0, reserved: 0, byPark: [], byCity: [], byDay: [], campaigns: {} };

  const conditions: any[] = [];
  if (filters?.from) conditions.push(gte(multiparkDailySnapshots.snapshotDate, toMysqlDateTime(filters.from)));
  if (filters?.to) conditions.push(lte(multiparkDailySnapshots.snapshotDate, toMysqlDateTime(filters.to)));
  if (filters?.city) conditions.push(eq(multiparkDailySnapshots.city, filters.city));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db.select().from(multiparkDailySnapshots).where(where).orderBy(multiparkDailySnapshots.snapshotDate);

  let totalBookings = 0, totalRevenue = 0, checkins = 0, checkouts = 0, cancelled = 0, reserved = 0;
  const parkMap: Record<string, { bookings: number; revenue: number; checkins: number; checkouts: number }> = {};
  const cityMap: Record<string, { bookings: number; revenue: number }> = {};
  const dayMap: Record<string, { bookings: number; revenue: number; checkins: number; checkouts: number }> = {};
  const campaignMap: Record<string, number> = {};

  for (const r of rows) {
    totalBookings += r.totalBookings;
    totalRevenue += r.totalRevenue ?? 0;
    checkins += r.checkinCount ?? 0;
    checkouts += r.checkoutCount ?? 0;
    cancelled += r.cancelledCount ?? 0;
    reserved += r.reservedCount ?? 0;

    // By park
    if (!parkMap[r.parkName]) parkMap[r.parkName] = { bookings: 0, revenue: 0, checkins: 0, checkouts: 0 };
    parkMap[r.parkName].bookings += r.totalBookings;
    parkMap[r.parkName].revenue += r.totalRevenue ?? 0;
    parkMap[r.parkName].checkins += r.checkinCount ?? 0;
    parkMap[r.parkName].checkouts += r.checkoutCount ?? 0;

    // By city
    if (!cityMap[r.city]) cityMap[r.city] = { bookings: 0, revenue: 0 };
    cityMap[r.city].bookings += r.totalBookings;
    cityMap[r.city].revenue += r.totalRevenue ?? 0;

    // By day
    const dayKey = r.snapshotDate ? new Date(r.snapshotDate).toISOString().slice(0, 10) : "unknown";
    if (!dayMap[dayKey]) dayMap[dayKey] = { bookings: 0, revenue: 0, checkins: 0, checkouts: 0 };
    dayMap[dayKey].bookings += r.totalBookings;
    dayMap[dayKey].revenue += r.totalRevenue ?? 0;
    dayMap[dayKey].checkins += r.checkinCount ?? 0;
    dayMap[dayKey].checkouts += r.checkoutCount ?? 0;

    // Campaigns
    if (r.externalCampaigns) {
      try {
        const camps = JSON.parse(r.externalCampaigns);
        for (const [name, count] of Object.entries(camps)) {
          campaignMap[name] = (campaignMap[name] || 0) + (count as number);
        }
      } catch {}
    }
  }

  return {
    totalBookings,
    totalRevenue,
    checkins,
    checkouts,
    cancelled,
    reserved,
    byPark: Object.entries(parkMap).map(([name, data]) => ({ name, ...data })).sort((a, b) => b.revenue - a.revenue),
    byCity: Object.entries(cityMap).map(([name, data]) => ({ name, ...data })).sort((a, b) => b.revenue - a.revenue),
    byDay: Object.entries(dayMap).map(([date, data]) => ({ date, ...data })).sort((a, b) => a.date.localeCompare(b.date)),
    campaigns: campaignMap,
  };
}

export async function deleteSnapshotsByDateRange(from: Date, to: Date) {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.delete(multiparkDailySnapshots).where(
    and(
      gte(multiparkDailySnapshots.snapshotDate, toMysqlDateTime(from)),
      lte(multiparkDailySnapshots.snapshotDate, toMysqlDateTime(to)),
    )
  );
  return (result as any)?.[0]?.affectedRows ?? 0;
}

// ─── INVITE TOKENS ──────────────────────────────────────────────────────────
import crypto from "crypto";

export async function createInviteToken(data: { email: string; userId: number; invitedById: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const token = crypto.randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await db.insert(inviteTokens).values({
    token,
    email: data.email,
    userId: data.userId,
    invitedById: data.invitedById,
    inviteStatus: "pending",
    expiresAt: toMysqlDateTime(expiresAt),
  });
  return { token, expiresAt };
}

export async function getInviteByToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(inviteTokens).where(eq(inviteTokens.token, token)).limit(1);
  return result[0];
}

export async function acceptInviteToken(token: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(inviteTokens).set({ inviteStatus: "accepted", acceptedAt: toMysqlDateTime(new Date()) }).where(eq(inviteTokens.token, token));
}

export async function getInvitesByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(inviteTokens).where(eq(inviteTokens.userId, userId)).orderBy(desc(inviteTokens.createdAt));
}

export async function getInvitesByEmail(email: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(inviteTokens).where(eq(inviteTokens.email, email)).orderBy(desc(inviteTokens.createdAt));
}

/**
 * Liga o convite à conta OAuth de quem o abriu.
 *
 * Dois cenários:
 *   a) A conta manual ainda tem o `openId` placeholder → assume o openId do
 *      Google (caminho normal).
 *   b) O login Google JÁ tem linha própria em `users` (o convite é aberto
 *      depois de entrar, e o callback cria/adota a linha) → não podemos
 *      duplicar o `openId` (índice UNIQUE). Nesse caso transferimos o
 *      role/departamento da conta manual para a conta OAuth e desativamos a
 *      manual (nunca apagada: os `activity_logs` referenciam-na por id).
 */
export async function linkInviteToOAuthUser(manualUserId: number, oauthOpenId: string, oauthName?: string | null, oauthEmail?: string | null) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const [manual] = await db.select().from(users).where(eq(users.id, manualUserId)).limit(1);
  if (!manual) throw new Error("Conta do convite não encontrada");

  const [oauthRow] = await db.select().from(users).where(eq(users.openId, oauthOpenId)).limit(1);

  if (oauthRow && oauthRow.id !== manualUserId) {
    await db
      .update(users)
      .set({
        role: manual.role,
        department: manual.department ?? oauthRow.department,
        isActive: manual.isActive,
        ...(oauthEmail ? { email: normalizeEmail(oauthEmail) } : {}),
      })
      .where(eq(users.id, oauthRow.id));
    await db
      .update(users)
      .set({ isActive: 0, loginMethod: `merged_into_${oauthRow.id}`.slice(0, 64) })
      .where(eq(users.id, manualUserId));
    return;
  }

  // Update the manual user's openId to the OAuth user's openId so they can log in
  const updates: Record<string, any> = { openId: oauthOpenId, loginMethod: "oauth" };
  if (oauthName) updates.name = oauthName;
  if (oauthEmail) updates.email = normalizeEmail(oauthEmail);
  await db.update(users).set(updates).where(eq(users.id, manualUserId));
}


// ─── PAYROLL ──────────────────────────────────────────────────────────────────
export async function getPayrollData(year: number, month: number) {
  const db = await getDb();
  if (!db) return [];

  // Get all active employees with project info
  const emps = await db.select({ employee: employees, project: projects })
    .from(employees)
    .leftJoin(projects, eq(employees.projectId, projects.id))
    .where(eq(employees.isActive, 1))
    .orderBy(employees.fullName);

  // Get extra rates
  const rates = await db.select().from(extraRates).orderBy(extraRates.level);
  // Mapa por level numérico (compat) e por nome (sincronizado com extras-dia)
  const rateMap = new Map(rates.map(r => [r.level, parseFloat(String(r.hourlyRate))]));
  const rateByName = new Map(rates.map(r => [String(r.levelName ?? ""), parseFloat(String(r.hourlyRate))]));

  // Dia 1 do mês para snapshot de salário histórico
  const monthFirstDay = `${year}-${String(month).padStart(2, "0")}-01`;

  // Get time records for the month
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59);
  const records = await db.select().from(timeRecords)
    .where(and(gte(timeRecords.recordedAt, toMysqlDateTime(start)), lte(timeRecords.recordedAt, toMysqlDateTime(end))));

  // Group hours by employee
  const hoursByEmployee = new Map<number, { totalHours: number; days: Set<string>; records: typeof records }>();
  for (const r of records) {
    if (!hoursByEmployee.has(r.employeeId)) {
      hoursByEmployee.set(r.employeeId, { totalHours: 0, days: new Set(), records: [] });
    }
    const entry = hoursByEmployee.get(r.employeeId)!;
    entry.totalHours += parseFloat(String(r.hoursWorked ?? 0));
    entry.days.add(new Date(r.recordedAt).toISOString().split("T")[0]);
    entry.records.push(r);
  }

  // Standard working hours per month (22 days * 8h)
  const STANDARD_MONTHLY_HOURS = 176;
  const STANDARD_DAILY_HOURS = 8;

  // Portuguese labor law rates
  const OVERTIME_RATE_FIRST_HOUR = 1.25;  // 25% extra for first hour
  const OVERTIME_RATE_SUBSEQUENT = 1.375; // 37.5% extra for subsequent hours
  const NIGHT_RATE_MULTIPLIER = 1.25;     // 25% extra for night work (22h-7h)
  const WEEKEND_RATE_MULTIPLIER = 1.50;   // 50% extra for weekends/holidays

  // Pré-carrega salário histórico + faltas de TODOS os colaboradores em BULK
  // (2 queries no total, em vez de 2 × nº colaboradores — corrige N+1 que fazia
  // a página Anual estourar os 60s do Vercel com ~8.5k queries para 12 meses).
  const empIds = emps.map(({ employee }) => employee.id);
  const histAll = empIds.length ? await db
    .select()
    .from(employeeSalaryHistory)
    .where(and(
      inArray(employeeSalaryHistory.employeeId, empIds),
      lte(employeeSalaryHistory.effectiveFrom, monthFirstDay),
      or(isNull(employeeSalaryHistory.effectiveUntil), gte(employeeSalaryHistory.effectiveUntil, monthFirstDay))!,
    ))
    .orderBy(desc(employeeSalaryHistory.effectiveFrom)) : [];
  const snapshotByEmp = new Map<number, { monthlySalary: any; mealAllowancePerDay: any }>();
  for (const h of histAll) {
    if (!snapshotByEmp.has(h.employeeId)) snapshotByEmp.set(h.employeeId, { monthlySalary: h.monthlySalary, mealAllowancePerDay: h.mealAllowancePerDay });
  }
  const lastDayNum = new Date(year, month, 0).getDate();
  const monthEndStr = `${year}-${String(month).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;
  const leavesAll = empIds.length ? await db
    .select({ employeeId: employeeLeaves.employeeId, fromDate: employeeLeaves.fromDate, toDate: employeeLeaves.toDate })
    .from(employeeLeaves)
    .where(and(
      inArray(employeeLeaves.employeeId, empIds),
      lte(employeeLeaves.fromDate, monthEndStr),
      gte(employeeLeaves.toDate, monthFirstDay),
    )) : [];
  const leavesByEmp = new Map<number, Set<string>>();
  for (const r of leavesAll) {
    let set = leavesByEmp.get(r.employeeId);
    if (!set) { set = new Set<string>(); leavesByEmp.set(r.employeeId, set); }
    const from = r.fromDate < monthFirstDay ? monthFirstDay : r.fromDate;
    const to = r.toDate > monthEndStr ? monthEndStr : r.toDate;
    const d = new Date(from + "T00:00:00");
    const limit = new Date(to + "T00:00:00");
    while (d <= limit) { set.add(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  }
  const empMeta = emps.map(({ employee: emp }) => ({
    empId: emp.id,
    snapshot: snapshotByEmp.get(emp.id) ?? { monthlySalary: emp.monthlySalary, mealAllowancePerDay: emp.mealAllowancePerDay },
    leaveDays: leavesByEmp.get(emp.id) ?? new Set<string>(),
  }));
  const metaById = new Map(empMeta.map(m => [m.empId, m]));

  return emps.map(({ employee: emp, project }) => {
    const empHours = hoursByEmployee.get(emp.id) ?? { totalHours: 0, days: new Set(), records: [] };
    const totalHours = Math.round(empHours.totalHours * 100) / 100;
    const daysWorked = empHours.days.size;
    const isExtra = emp.position === "extra";
    const meta = metaById.get(emp.id);
    const snapshot = meta?.snapshot;
    const leaveDays = meta?.leaveDays ?? new Set<string>();

    let baseSalary = 0;
    let extraPayment = 0;
    let overtimeHours = 0;
    let overtimePayment = 0;
    let thirteenthProvision = 0;  // Provisão 13º mês (subsídio de Natal) — duodécimos
    let fourteenthProvision = 0;  // Provisão 14º mês (subsídio de férias) — duodécimos
    let nightHours = 0;
    let nightPayment = 0;
    let weekendHours = 0;
    let weekendPayment = 0;
    let mealAllowance = 0;
    const mealAllowancePerDay = parseFloat(String(snapshot?.mealAllowancePerDay ?? emp.mealAllowancePerDay ?? 0));

    if (isExtra) {
      // Extras: taxa horária por nível. Tenta primeiro pelo nome (sincronizado
      // com extras-dia: junior/senior/terminal/master) e depois pelo nº legacy.
      const levelNum = emp.extraLevel ?? 1;
      const NAME_BY_LEVEL: Record<number, string> = { 1: "junior", 2: "senior", 3: "terminal", 4: "master" };
      const fromName = rateByName.get(NAME_BY_LEVEL[levelNum] ?? "junior");
      const hourlyRate = fromName ?? rateMap.get(levelNum) ?? 4.5;
      extraPayment = Math.round(totalHours * hourlyRate * 100) / 100;
    } else {
      // Regular employees: base salary + overtime + provisions + night/weekend
      // Usa snapshot histórico (salário vigente no mês), não o salário actual.
      baseSalary = parseFloat(String(snapshot?.monthlySalary ?? emp.monthlySalary ?? 0));
      const hourlyBase = baseSalary > 0 ? baseSalary / STANDARD_MONTHLY_HOURS : 0;

      // Classifica cada record em buckets MUTUAMENTE EXCLUSIVOS para evitar
      // contar a mesma hora duas vezes (uma hora noturna num sábado contava
      // como "noite" E "FDS"). Hierarquia: FDS > Noite > Normal.
      let normalHours = 0;
      for (const rec of empHours.records) {
        const recDate = new Date(rec.recordedAt);
        const hours = parseFloat(String(rec.hoursWorked ?? 0));
        if (hours <= 0) continue;
        const dayOfWeek = recDate.getDay(); // 0=Sun, 6=Sat
        const hour = recDate.getHours();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isNight = hour >= 22 || hour < 7;
        if (isWeekend) weekendHours += hours;
        else if (isNight) nightHours += hours;
        else normalHours += hours;
      }
      nightHours = Math.round(nightHours * 100) / 100;
      weekendHours = Math.round(weekendHours * 100) / 100;
      normalHours = Math.round(normalHours * 100) / 100;

      // Acréscimos sobre a base horária (NIGHT 25%, WEEKEND 50%)
      nightPayment = Math.round(nightHours * hourlyBase * (NIGHT_RATE_MULTIPLIER - 1) * 100) / 100;
      weekendPayment = Math.round(weekendHours * hourlyBase * (WEEKEND_RATE_MULTIPLIER - 1) * 100) / 100;

      // Overtime: só horas normais acima do limiar mensal.
      if (normalHours > STANDARD_MONTHLY_HOURS) {
        overtimeHours = Math.round((normalHours - STANDARD_MONTHLY_HOURS) * 100) / 100;
        // Primeira hora/dia a 25%, restantes a 37,5% (aproximação)
        const firstHourPortion = Math.min(overtimeHours, daysWorked);
        const subsequentPortion = Math.max(0, overtimeHours - firstHourPortion);
        overtimePayment = Math.round(
          (firstHourPortion * hourlyBase * OVERTIME_RATE_FIRST_HOUR +
           subsequentPortion * hourlyBase * OVERTIME_RATE_SUBSEQUENT) * 100
        ) / 100;
      }

      // 13th month provision (subsídio de Natal): 1/12 of base salary per month
      thirteenthProvision = Math.round(baseSalary / 12 * 100) / 100;

      // 14th month provision (subsídio de férias): 1/12 of base salary per month
      fourteenthProvision = Math.round(baseSalary / 12 * 100) / 100;

      // Subsídio alimentação: só dias trabalhados que NÃO caiam em férias/baixa.
      let workedDaysExcludingLeave = 0;
      for (const day of empHours.days) {
        if (!leaveDays.has(day)) workedDaysExcludingLeave += 1;
      }
      mealAllowance = Math.round(mealAllowancePerDay * workedDaysExcludingLeave * 100) / 100;
    }

    // Total bruto
    const totalPayment = isExtra
      ? extraPayment
      : baseSalary + overtimePayment + nightPayment + weekendPayment +
        thirteenthProvision + fourteenthProvision + mealAllowance;

    // Estimativa de líquido após impostos (NÃO é contabilidade fiscal real)
    // - TSU empregado: 11% sobre vencimento + extras + acréscimos (NÃO sobre
    //   subsídio de alimentação nem provisões 13º/14º)
    // - IRS: 15% simplificado sobre a mesma base
    const TSU_EMPLOYEE = 0.11;
    const IRS_RATE = 0.15;
    const taxableBase = isExtra
      ? extraPayment
      : baseSalary + overtimePayment + nightPayment + weekendPayment;
    const tsuEmployee = Math.round(taxableBase * TSU_EMPLOYEE * 100) / 100;
    const irsEstimate = Math.round(taxableBase * IRS_RATE * 100) / 100;
    const netEstimate = Math.round((totalPayment - tsuEmployee - irsEstimate) * 100) / 100;

    return {
      employeeId: emp.id,
      fullName: emp.fullName,
      position: emp.position,
      extraLevel: emp.extraLevel,
      department: emp.department,
      projectName: project?.name ?? null,
      projectId: emp.projectId,
      nif: emp.nif,
      nib: emp.nib,
      isExtra,
      totalHours,
      daysWorked,
      baseSalary,
      extraPayment,
      overtimeHours,
      overtimePayment,
      nightHours,
      nightPayment,
      weekendHours,
      weekendPayment,
      thirteenthProvision,
      fourteenthProvision,
      mealAllowance,
      mealAllowancePerDay,
      totalPayment,
      // Estimativa líquido (não fiscal)
      tsuEmployee,
      irsEstimate,
      netEstimate,
      hourlyRate: isExtra
        ? (() => {
            const NAME_BY_LEVEL: Record<number, string> = { 1: "junior", 2: "senior", 3: "terminal", 4: "master" };
            return rateByName.get(NAME_BY_LEVEL[emp.extraLevel ?? 1] ?? "junior") ?? rateMap.get(emp.extraLevel ?? 1) ?? 4.5;
          })()
        : (baseSalary > 0 ? Math.round(baseSalary / STANDARD_MONTHLY_HOURS * 100) / 100 : 0),
    };
  });
}

// ─── PAYSLIP HISTORY ─────────────────────────────────────────────────────────

export async function savePayslipRecord(data: InsertPayslipHistory) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(payslipHistory).values(data);
}

export async function getPayslipHistoryList(filters: { year?: number; month?: number; employeeId?: number; type?: string } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  if (filters.year) conditions.push(eq(payslipHistory.year, filters.year));
  if (filters.month) conditions.push(eq(payslipHistory.month, filters.month));
  if (filters.employeeId) conditions.push(eq(payslipHistory.employeeId, filters.employeeId));
  if (filters.type) conditions.push(eq(payslipHistory.payslipType, filters.type as any));
  const query = db.select().from(payslipHistory).orderBy(desc(payslipHistory.createdAt));
  if (conditions.length > 0) return query.where(and(...conditions));
  return query;
}

export async function deletePayslipRecord(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(payslipHistory).where(eq(payslipHistory.id, id));
}


// ─── TASK ASSIGNEES (multi-assignee) ─────────────────────────────────────────
export async function getTaskAssignees(taskId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select({ assignee: taskAssignees, employee: employees })
    .from(taskAssignees)
    .leftJoin(employees, eq(taskAssignees.employeeId, employees.id))
    .where(eq(taskAssignees.taskId, taskId));
}

export async function setTaskAssignees(taskId: number, employeeIds: number[]) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Remove all existing assignees
  await db.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));
  // Insert new ones
  if (employeeIds.length > 0) {
    await db.insert(taskAssignees).values(
      employeeIds.map(employeeId => ({ taskId, employeeId }))
    );
  }
}

export async function getOverdueTasks() {
  const db = await getDb();
  if (!db) return [];
  const now = new Date();
  return db.select().from(tasks)
    .where(and(
      lte(tasks.dueDate, toMysqlDateTime(now)),
      eq(tasks.notifiedOverdue, 0),
      sql`${tasks.taskStatus} != 'done'`
    ));
}

export async function getRecentlyCompletedTasks() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tasks)
    .where(and(
      eq(tasks.taskStatus, "done"),
      eq(tasks.notifiedComplete, 0)
    ));
}

export async function markTaskNotified(taskId: number, field: "notifiedOverdue" | "notifiedComplete") {
  const db = await getDb();
  if (!db) return;
  await db.update(tasks).set({ [field]: 1 }).where(eq(tasks.id, taskId));
}

// Get project hierarchy chain (project → city → brand → group) with managers
export async function getProjectHierarchyManagers(projectId: number) {
  const db = await getDb();
  if (!db) return [];
  const allProjects = await db.select().from(projects);
  const managers: { projectId: number; projectName: string; level: string; managerId: number | null }[] = [];
  
  let current = allProjects.find(p => p.id === projectId);
  while (current) {
    managers.push({
      projectId: current.id,
      projectName: current.name,
      level: current.level,
      managerId: current.managerId,
    });
    current = current.parentId ? allProjects.find(p => p.id === current!.parentId) : undefined;
  }
  return managers;
}


// ─── PROJECT COSTS DASHBOARD ─────────────────────────────────────────────────
export async function getProjectCosts(year?: number, month?: number) {
  const db = await getDb();
  if (!db) return [];

  const allProjects = await db.select().from(projects).orderBy(projects.name);
  const allAssignments = await db.select().from(projectEmployees);
  const allEmployees = await db.select().from(employees);

  // Expense filters
  const conditions: any[] = [];
  if (year && month) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    conditions.push(gte(expenses.expenseDate, toMysqlDateTime(startDate)));
    conditions.push(lte(expenses.expenseDate, toMysqlDateTime(endDate)));
  } else if (year) {
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59);
    conditions.push(gte(expenses.expenseDate, toMysqlDateTime(startDate)));
    conditions.push(lte(expenses.expenseDate, toMysqlDateTime(endDate)));
  }
  conditions.push(sql`${expenses.status} != 'cancelled'`);

  const expenseRows = await db
    .select({
      projectId: expenses.projectId,
      totalExpenses: sql<string>`COALESCE(SUM(${expenses.amount}), 0)`,
      expenseCount: sql<number>`COUNT(*)`,
      pendingExpenses: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'pending' THEN ${expenses.amount} ELSE 0 END), 0)`,
      paidExpenses: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'paid' THEN ${expenses.amount} ELSE 0 END), 0)`,
    })
    .from(expenses)
    .where(and(...conditions))
    .groupBy(expenses.projectId);

  const expenseMap = new Map<number | null, { total: number; count: number; pending: number; paid: number }>();
  for (const row of expenseRows) {
    expenseMap.set(row.projectId, {
      total: parseFloat(row.totalExpenses) || 0,
      count: row.expenseCount,
      pending: parseFloat(row.pendingExpenses) || 0,
      paid: parseFloat(row.paidExpenses) || 0,
    });
  }

  // Time records for salary calculation
  const timeConditions: any[] = [];
  if (year && month) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    timeConditions.push(gte(timeRecords.recordedAt, toMysqlDateTime(startDate)));
    timeConditions.push(lte(timeRecords.recordedAt, toMysqlDateTime(endDate)));
  } else if (year) {
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59);
    timeConditions.push(gte(timeRecords.recordedAt, toMysqlDateTime(startDate)));
    timeConditions.push(lte(timeRecords.recordedAt, toMysqlDateTime(endDate)));
  }

  const timeRows = await db
    .select({
      employeeId: timeRecords.employeeId,
      totalHours: sql<number>`COALESCE(SUM(${timeRecords.hoursWorked}), 0)`,
    })
    .from(timeRecords)
    .where(timeConditions.length > 0 ? and(...timeConditions) : undefined)
    .groupBy(timeRecords.employeeId);

  const hoursMap = new Map<number, number>();
  for (const row of timeRows) {
    hoursMap.set(row.employeeId, row.totalHours || 0);
  }

  const rates = await db.select().from(extraRates).orderBy(extraRates.level);

  // Calculate salary costs per project
  const salaryCostMap = new Map<number, { totalSalary: number; employeeCount: number }>();

  for (const proj of allProjects) {
    const assignedEmployeeIds = allAssignments
      .filter(a => a.projectId === proj.id)
      .map(a => a.employeeId);
    const directEmployeeIds = allEmployees
      .filter(e => e.projectId === proj.id)
      .map(e => e.id);
    const uniqueIds = Array.from(new Set([...assignedEmployeeIds, ...directEmployeeIds]));
    let totalSalary = 0;

    for (const empId of uniqueIds) {
      const emp = allEmployees.find(e => e.id === empId);
      if (!emp) continue;
      if (emp.contractType === "extra") {
        const hours = hoursMap.get(empId) || 0;
        const rate = rates.find(r => r.level === Number(emp.position || 1));
        const hourlyRate = rate ? parseFloat(String(rate.hourlyRate)) : 6;
        totalSalary += hours * hourlyRate;
      } else {
        totalSalary += parseFloat(String(emp.monthlySalary || 0));
      }
    }
    salaryCostMap.set(proj.id, { totalSalary, employeeCount: uniqueIds.length });
  }

  // Get manager names
  const allUsers = await db.select().from(users);
  const userMap = new Map<number, string>();
  for (const u of allUsers) userMap.set(u.id, u.name || u.email || "—");

  return allProjects.map(proj => {
    const expData = expenseMap.get(proj.id) || { total: 0, count: 0, pending: 0, paid: 0 };
    const salData = salaryCostMap.get(proj.id) || { totalSalary: 0, employeeCount: 0 };
    const budget = parseFloat(String(proj.budget || 0));
    const totalCost = expData.total + salData.totalSalary;
    const remaining = budget - totalCost;
    const percentUsed = budget > 0 ? (totalCost / budget) * 100 : 0;

    return {
      id: proj.id,
      name: proj.name,
      level: proj.level,
      parentId: proj.parentId,
      color: proj.color,
      managerId: proj.managerId,
      managerName: proj.managerId ? userMap.get(proj.managerId) || "—" : "—",
      budget,
      expenses: expData.total,
      expenseCount: expData.count,
      pendingExpenses: expData.pending,
      paidExpenses: expData.paid,
      salaryCost: salData.totalSalary,
      employeeCount: salData.employeeCount,
      totalCost,
      remaining,
      percentUsed,
    };
  });
}


// ─── SPEED LIMITS & VIOLATIONS ──────────────────────────────────────────────

export async function getSpeedLimits() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(speedLimits).where(eq(speedLimits.isActive, 1));
}

export async function getDefaultSpeedLimit() {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(speedLimits).where(eq(speedLimits.isDefault, 1)).limit(1);
  return rows[0] || null;
}

export async function createSpeedLimit(data: InsertSpeedLimit) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(speedLimits).values(data);
  return result.insertId;
}

export async function updateSpeedLimit(id: number, data: Partial<InsertSpeedLimit>) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(speedLimits).set({ ...data, updatedAt: toMysqlDateTime(new Date()) }).where(eq(speedLimits.id, id));
}

export async function deleteSpeedLimit(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(speedLimits).where(eq(speedLimits.id, id));
}

export async function recordSpeedViolation(data: InsertSpeedViolation) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(speedViolations).values(data);
  return result.insertId;
}

export async function getSpeedViolations(filters?: {
  startDate?: Date;
  endDate?: Date;
  username?: string;
  acknowledged?: boolean;
}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters?.startDate) conditions.push(gte(speedViolations.occurredAt, toMysqlDateTime(filters.startDate)));
  if (filters?.endDate) conditions.push(lte(speedViolations.occurredAt, toMysqlDateTime(filters.endDate)));
  if (filters?.username) conditions.push(eq(speedViolations.zelloUsername, filters.username));
  if (filters?.acknowledged !== undefined) conditions.push(eq(speedViolations.acknowledged, filters.acknowledged ? 1 : 0));

  return db
    .select()
    .from(speedViolations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(speedViolations.occurredAt));
}

export async function acknowledgeSpeedViolation(id: number, userId: number, notes?: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db
    .update(speedViolations)
    .set({
      acknowledged: 1,
      acknowledgedById: userId,
      acknowledgedAt: toMysqlDateTime(new Date()),
      notes: notes || null,
    })
    .where(eq(speedViolations.id, id));
}

export async function getSpeedViolationStats(startDate?: Date, endDate?: Date) {
  const db = await getDb();
  if (!db) return { total: 0, unacknowledged: 0, topOffenders: [] };

  const conditions: any[] = [];
  if (startDate) conditions.push(gte(speedViolations.occurredAt, toMysqlDateTime(startDate)));
  if (endDate) conditions.push(lte(speedViolations.occurredAt, toMysqlDateTime(endDate)));

  const allViolations = await db
    .select()
    .from(speedViolations)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const total = allViolations.length;
  const unacknowledged = allViolations.filter((v) => !v.acknowledged).length;

  // Top offenders
  const byUser: Record<string, { count: number; displayName: string; avgExcess: number }> = {};
  for (const v of allViolations) {
    if (!byUser[v.zelloUsername]) {
      byUser[v.zelloUsername] = { count: 0, displayName: v.displayName || v.zelloUsername, avgExcess: 0 };
    }
    byUser[v.zelloUsername].count++;
    byUser[v.zelloUsername].avgExcess += parseFloat(String(v.excessPercent));
  }
  const topOffenders = Object.entries(byUser)
    .map(([username, data]) => ({
      username,
      displayName: data.displayName,
      count: data.count,
      avgExcess: Math.round((data.avgExcess / data.count) * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return { total, unacknowledged, topOffenders };
}


// ─── DAILY DRIVER HISTORY ────────────────────────────────────────────────────

export async function createDailyDriverHistory(data: InsertDailyDriverHistory) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(dailyDriverHistory).values(data);
  return result.insertId;
}

/**
 * Resolve o NOME do funcionário para cada linha de histórico Zello.
 *
 * O histórico diário é recolhido do Zello e só traz o utilizador Zello
 * ("Faro 411"). Quem interessa à operação é a PESSOA. Prioridade:
 *   1. check-in de PDA do PRÓPRIO dia com esse Zello (dimensão temporal —
 *      quem levou o aparelho naquele dia manda, mesmo que o anexo persistente
 *      aponte para outra pessoa);
 *   2. anexo persistente `employees.zelloUsername`.
 * Sem match, `employeeName` fica null e a UI cai no nome Zello.
 */
async function withEmployeeNames<T extends { zelloUsername: string; date: string | Date }>(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  rows: T[],
): Promise<(T & { employeeName: string | null; resolvedEmployeeId: number | null })[]> {
  if (rows.length === 0) return [];
  const zellos = [...new Set(rows.map(r => r.zelloUsername).filter(Boolean))];
  if (zellos.length === 0) return rows.map(r => ({ ...r, employeeName: null, resolvedEmployeeId: null }));

  const persistent = await db
    .select({ id: employees.id, fullName: employees.fullName, zello: employees.zelloUsername })
    .from(employees)
    .where(inArray(employees.zelloUsername, zellos));
  const byZello = new Map(persistent.map(e => [e.zello!, e]));

  // Check-ins com esses Zellos dentro do intervalo de datas das linhas (+1 dia
  // de margem) — chave `${zello}|${YYYY-MM-DD}` para o match ser por DIA.
  const dayOf = (d: string | Date) => toMysqlDateTime(typeof d === "string" ? d : d).slice(0, 10);
  const dates = rows.map(r => dayOf(r.date)).sort();
  const from = `${dates[0]} 00:00:00`;
  const to = `${dates[dates.length - 1]} 23:59:59`;
  const checkins = await db
    .select({ zello: pdaCheckins.zelloUsername, employeeId: pdaCheckins.employeeId, at: pdaCheckins.checkinAt })
    .from(pdaCheckins)
    .where(and(inArray(pdaCheckins.zelloUsername, zellos), isNotNull(pdaCheckins.employeeId), gte(pdaCheckins.checkinAt, from), lte(pdaCheckins.checkinAt, to)));
  const empIds = [...new Set(checkins.map(c => c.employeeId!).filter(id => !persistent.some(p => p.id === id)))];
  const extraEmps = empIds.length
    ? await db.select({ id: employees.id, fullName: employees.fullName }).from(employees).where(inArray(employees.id, empIds))
    : [];
  const empById = new Map([...persistent, ...extraEmps].map(e => [e.id, e.fullName]));
  const byZelloDay = new Map(checkins.map(c => [`${c.zello}|${dayOf(c.at as any)}`, c.employeeId!]));

  return rows.map(r => {
    const dayHit = byZelloDay.get(`${r.zelloUsername}|${dayOf(r.date)}`);
    const persistentHit = byZello.get(r.zelloUsername);
    const id = dayHit ?? persistentHit?.id ?? null;
    return { ...r, resolvedEmployeeId: id, employeeName: (id != null ? empById.get(id) : null) ?? null };
  });
}

export async function getDailyDriverHistoryByDate(dateStr: string) {
  const db = await getDb();
  if (!db) return [];
  const startOfDay = new Date(dateStr);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateStr);
  endOfDay.setHours(23, 59, 59, 999);
  const rows = await db.select().from(dailyDriverHistory)
    .where(and(gte(dailyDriverHistory.date, toMysqlDateTime(startOfDay)), lte(dailyDriverHistory.date, toMysqlDateTime(endOfDay))))
    .orderBy(desc(dailyDriverHistory.totalKm));
  return withEmployeeNames(db, rows);
}

export async function getDailyDriverHistoryByUser(username: string, limit = 30) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(dailyDriverHistory)
    .where(eq(dailyDriverHistory.zelloUsername, username))
    .orderBy(desc(dailyDriverHistory.date))
    .limit(limit);
  return withEmployeeNames(db, rows);
}

export async function getDailyDriverHistoryRange(startDate: string, endDate: string) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(dailyDriverHistory)
    .where(and(
      gte(dailyDriverHistory.date, toMysqlDateTime(new Date(startDate))),
      lte(dailyDriverHistory.date, toMysqlDateTime(new Date(endDate)))
    ))
    .orderBy(desc(dailyDriverHistory.date));
  return withEmployeeNames(db, rows);
}

export async function getDailyDriverStats(dateStr: string) {
  const db = await getDb();
  if (!db) return { totalDrivers: 0, totalKm: 0, totalHoursWorked: 0, totalHoursStopped: 0, maxSpeedOfDay: 0, avgBattery: 0, totalViolations: 0 };
  const startOfDay = new Date(dateStr);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateStr);
  endOfDay.setHours(23, 59, 59, 999);
  const rows = await db.select().from(dailyDriverHistory)
    .where(and(gte(dailyDriverHistory.date, toMysqlDateTime(startOfDay)), lte(dailyDriverHistory.date, toMysqlDateTime(endOfDay))));
  
  const totalDrivers = rows.length;
  const totalKm = rows.reduce((s, r) => s + parseFloat(String(r.totalKm || "0")), 0);
  const totalHoursWorked = rows.reduce((s, r) => s + parseFloat(String(r.hoursWorked || "0")), 0);
  const totalHoursStopped = rows.reduce((s, r) => s + parseFloat(String(r.hoursStopped || "0")), 0);
  const maxSpeedOfDay = Math.max(...rows.map(r => parseFloat(String(r.maxSpeed || "0"))), 0);
  const avgBattery = totalDrivers > 0 ? Math.round(rows.reduce((s, r) => s + (r.avgBattery || 0), 0) / totalDrivers) : 0;
  const totalViolations = rows.reduce((s, r) => s + (r.speedViolations || 0), 0);
  
  return { totalDrivers, totalKm, totalHoursWorked, totalHoursStopped, maxSpeedOfDay, avgBattery, totalViolations };
}

// ─── PDAs ────────────────────────────────────────────────────────────────────

export async function createPda(data: InsertPda) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(pdas).values(data);
  return result.insertId;
}

export async function updatePda(id: number, data: Partial<InsertPda>) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(pdas).set(data).where(eq(pdas.id, id));
}

export async function deletePda(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(pdas).where(eq(pdas.id, id));
}

export async function listPdas() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(pdas).orderBy(pdas.name);
}

export async function getPdaById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const [pda] = await db.select().from(pdas).where(eq(pdas.id, id));
  return pda;
}

// ─── PDA CHECK-INS ───────────────────────────────────────────────────────────

export async function createPdaCheckin(data: InsertPdaCheckin) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(pdaCheckins).values(data);
  return result.insertId;
}

/**
 * Anexa o utilizador Zello ao funcionário no ato do check-in — mas só a
 * PREENCHER lacuna: nunca substitui um anexo existente do próprio nem rouba
 * um Zello já anexado a outro colaborador (para esses casos existe o
 * `mapUserToEmployee` explícito). O check-in em si guarda sempre o par
 * temporal (quem levou que Zello naquele dia), que tem prioridade na exibição.
 */
export async function attachZelloToEmployeeIfUnset(employeeId: number, zelloUsername: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [emp] = await db.select({ zello: employees.zelloUsername }).from(employees).where(eq(employees.id, employeeId)).limit(1);
  if (!emp || emp.zello) return false;
  const holder = await db.select({ id: employees.id }).from(employees).where(eq(employees.zelloUsername, zelloUsername)).limit(1);
  if (holder.length > 0) return false;
  await db.update(employees).set({ zelloUsername }).where(eq(employees.id, employeeId));
  return true;
}

export async function checkoutPda(id: number, data: { photoExitUrl?: string; mobileDataMbEnd?: number; notes?: string }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(pdaCheckins).set({
    ...data,
    checkoutAt: toMysqlDateTime(new Date()),
    checkinStatus: "checked_out",
  }).where(eq(pdaCheckins.id, id));
}

// Check-ins sempre com o NOME do funcionário (left join): a operação fala de
// pessoas, não de ids nem de nomes Zello.
const checkinWithEmployee = { ...getTableColumns(pdaCheckins), employeeName: employees.fullName };

export async function getActiveCheckins() {
  const db = await getDb();
  if (!db) return [];
  return db.select(checkinWithEmployee).from(pdaCheckins)
    .leftJoin(employees, eq(pdaCheckins.employeeId, employees.id))
    .where(eq(pdaCheckins.checkinStatus, "checked_in"))
    .orderBy(desc(pdaCheckins.checkinAt));
}

export async function getCheckinsByDate(dateStr: string) {
  const db = await getDb();
  if (!db) return [];
  const startOfDay = new Date(dateStr);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateStr);
  endOfDay.setHours(23, 59, 59, 999);
  return db.select(checkinWithEmployee).from(pdaCheckins)
    .leftJoin(employees, eq(pdaCheckins.employeeId, employees.id))
    .where(and(gte(pdaCheckins.checkinAt, toMysqlDateTime(startOfDay)), lte(pdaCheckins.checkinAt, toMysqlDateTime(endOfDay))))
    .orderBy(desc(pdaCheckins.checkinAt));
}

export async function getCheckinsByPda(pdaId: number, limit = 30) {
  const db = await getDb();
  if (!db) return [];
  return db.select(checkinWithEmployee).from(pdaCheckins)
    .leftJoin(employees, eq(pdaCheckins.employeeId, employees.id))
    .where(eq(pdaCheckins.pdaId, pdaId))
    .orderBy(desc(pdaCheckins.checkinAt))
    .limit(limit);
}

// ─── GPS ALERTS ──────────────────────────────────────────────────────────────

export async function createGpsAlert(data: InsertGpsAlert) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(gpsAlerts).values(data);
  return result.insertId;
}

export async function getGpsAlerts(opts: { limit?: number; unacknowledgedOnly?: boolean } = {}) {
  const db = await getDb();
  if (!db) return [];
  let query = db.select().from(gpsAlerts).orderBy(desc(gpsAlerts.occurredAt)).limit(opts.limit || 50);
  if (opts.unacknowledgedOnly) {
    return db.select().from(gpsAlerts)
      .where(eq(gpsAlerts.acknowledged, 0))
      .orderBy(desc(gpsAlerts.occurredAt))
      .limit(opts.limit || 50);
  }
  return query;
}

export async function acknowledgeGpsAlert(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(gpsAlerts).set({
    acknowledged: 1,
    acknowledgedById: userId,
    acknowledgedAt: toMysqlDateTime(new Date()),
  }).where(eq(gpsAlerts.id, id));
}

export async function getGpsAlertStats() {
  const db = await getDb();
  if (!db) return { total: 0, unacknowledged: 0, todayAlerts: 0, byType: {} };
  const all = await db.select().from(gpsAlerts).orderBy(desc(gpsAlerts.occurredAt)).limit(200);
  const total = all.length;
  const unacknowledged = all.filter(a => !a.acknowledged).length;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayAlerts = all.filter(a => new Date(a.occurredAt) >= today).length;
  const byType: Record<string, number> = {};
  all.forEach(a => { byType[a.alertType] = (byType[a.alertType] || 0) + 1; });
  return { total, unacknowledged, todayAlerts, byType };
}

// ─── MARKETING: GOOGLE ADS IMPORT WITH DEDUP ────────────────────────────────

export async function getCampaignByNameAndPlatform(name: string, platform: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(campaigns)
    .where(and(eq(campaigns.name, name), eq(campaigns.platform, platform as any)))
    .limit(1);
  return result[0];
}

export async function getExistingStatsForCampaignAndDateRange(campaignId: number, startDate: Date, endDate: Date) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(campaignDailyStats)
    .where(and(
      eq(campaignDailyStats.campaignId, campaignId),
      gte(campaignDailyStats.date, toMysqlDateTime(startDate)),
      lte(campaignDailyStats.date, toMysqlDateTime(endDate)),
    ));
}

// ─── GMAIL SYNC DEDUP HELPERS ──────────────────────────────────────────────
export async function getReviewBySourceEmailId(sourceEmailId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(googleReviews).where(eq(googleReviews.sourceEmailId, sourceEmailId)).limit(1);
  return rows[0] || null;
}

export async function getIncidentBySourceEmailId(sourceEmailId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(incidents).where(eq(incidents.sourceEmailId, sourceEmailId)).limit(1);
  return rows[0] || null;
}

// ─── BOOKING HISTORY (imported from Excel) ──────────────────────────────────

export async function importBookingHistory(rows: {
  historyId: string;
  bookingId: string;
  changeType: string;
  userName?: string | null;
  userLastName?: string | null;
  userEmail?: string | null;
  remarks?: string | null;
  actionDate?: string | null;
  parkName?: string | null;
  licensePlate?: string | null;
  bookingStatus?: string | null;
}[]): Promise<{ imported: number; skipped: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      await db.insert(bookingHistory).values({
        historyId: row.historyId,
        bookingId: row.bookingId,
        changeType: row.changeType,
        userName: row.userName ?? null,
        userLastName: row.userLastName ?? null,
        userEmail: row.userEmail ?? null,
        remarks: row.remarks ?? null,
        actionDate: row.actionDate ?? null,
        parkName: row.parkName ?? null,
        licensePlate: row.licensePlate ?? null,
        bookingStatus: row.bookingStatus ?? null,
      } as any);
      imported++;
    } catch (err: any) {
      if (err.code === "ER_DUP_ENTRY" || err.message?.includes("Duplicate")) {
        skipped++;
      } else {
        throw err;
      }
    }
  }
  return { imported, skipped };
}

// ─── Booking history (Multipark API, via DB local) ──────────────────────────
// As funções a seguir devolvem o histórico de reservas Multipark já sincronizado
// para a DB local (multipark_booking_history populado pelo cron job de 15 min).
// Shape mantido compatível com a UI antiga (que esperava colunas do Excel
// import). Adicionado o campo `flagged: 1` nas linhas/condutores que tocaram
// numa reserva que está ligada a um caso de Perdidos/Achados.

function splitAgentName(full: string | null | undefined): { first: string | null; last: string | null } {
  if (!full) return { first: null, last: null };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

async function getLostFoundBookingRefSet(): Promise<Set<string>> {
  const db = await getDb();
  if (!db) return new Set();
  const items = await db
    .select({ bookingRef: lostFoundItems.bookingRef })
    .from(lostFoundItems);
  const refs = new Set<string>();
  for (const it of items) {
    const r = it.bookingRef?.trim();
    if (r) refs.add(r);
  }
  return refs;
}

type HistoryRow = {
  id: number;
  historyId: string;
  bookingId: string;
  changeType: string;
  userName: string | null;
  userLastName: string | null;
  userEmail: string | null;
  remarks: string | null;
  actionDate: string | null;
  parkName: string | null;
  licensePlate: string | null;
  bookingStatus: string | null;
  flagged: 0 | 1;
};

async function mapMultiparkHistoryRows(
  rows: Array<{
    id: number;
    historyId: string;
    bookingExternalId: string;
    changeType: string | null;
    actionTime: string | null;
    remarks: string | null;
    agentName: string | null;
    agentEmail: string | null;
    parkName: string | null;
    licensePlate: string | null;
    bookingStatus: string | null;
  }>,
): Promise<HistoryRow[]> {
  const flaggedRefs = await getLostFoundBookingRefSet();
  return rows.map((r) => {
    const { first, last } = splitAgentName(r.agentName);
    return {
      id: r.id,
      historyId: r.historyId,
      bookingId: r.bookingExternalId,
      changeType: r.changeType ?? "",
      userName: first,
      userLastName: last,
      userEmail: r.agentEmail,
      remarks: r.remarks,
      actionDate: r.actionTime,
      parkName: r.parkName,
      licensePlate: r.licensePlate,
      bookingStatus: r.bookingStatus,
      flagged: flaggedRefs.has(r.bookingExternalId) ? 1 : 0,
    };
  });
}

export async function getBookingHistoryByBookingId(bookingId: string): Promise<HistoryRow[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: multiparkBookingHistory.id,
      historyId: multiparkBookingHistory.historyId,
      bookingExternalId: multiparkBookingHistory.bookingExternalId,
      changeType: multiparkBookingHistory.changeType,
      actionTime: multiparkBookingHistory.actionTime,
      remarks: multiparkBookingHistory.remarks,
      agentName: multiparkBookingHistory.agentName,
      agentEmail: multiparkBookingHistory.agentEmail,
      parkName: multiparkBookings.parkName,
      licensePlate: multiparkBookings.licensePlate,
      bookingStatus: multiparkBookings.status,
    })
    .from(multiparkBookingHistory)
    .leftJoin(multiparkBookings, eq(multiparkBookings.externalId, multiparkBookingHistory.bookingExternalId))
    .where(eq(multiparkBookingHistory.bookingExternalId, bookingId))
    .orderBy(desc(multiparkBookingHistory.actionTime))
    .limit(500);
  return mapMultiparkHistoryRows(rows);
}

export async function getBookingHistoryByPlate(plate: string): Promise<HistoryRow[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: multiparkBookingHistory.id,
      historyId: multiparkBookingHistory.historyId,
      bookingExternalId: multiparkBookingHistory.bookingExternalId,
      changeType: multiparkBookingHistory.changeType,
      actionTime: multiparkBookingHistory.actionTime,
      remarks: multiparkBookingHistory.remarks,
      agentName: multiparkBookingHistory.agentName,
      agentEmail: multiparkBookingHistory.agentEmail,
      parkName: multiparkBookings.parkName,
      licensePlate: multiparkBookings.licensePlate,
      bookingStatus: multiparkBookings.status,
    })
    .from(multiparkBookingHistory)
    .innerJoin(multiparkBookings, eq(multiparkBookings.externalId, multiparkBookingHistory.bookingExternalId))
    .where(like(multiparkBookings.licensePlate, `%${plate}%`))
    .orderBy(desc(multiparkBookingHistory.actionTime))
    .limit(500);
  return mapMultiparkHistoryRows(rows);
}

export async function searchBookingHistory(search: string): Promise<HistoryRow[]> {
  const db = await getDb();
  if (!db) return [];
  const s = `%${search}%`;
  const rows = await db
    .select({
      id: multiparkBookingHistory.id,
      historyId: multiparkBookingHistory.historyId,
      bookingExternalId: multiparkBookingHistory.bookingExternalId,
      changeType: multiparkBookingHistory.changeType,
      actionTime: multiparkBookingHistory.actionTime,
      remarks: multiparkBookingHistory.remarks,
      agentName: multiparkBookingHistory.agentName,
      agentEmail: multiparkBookingHistory.agentEmail,
      parkName: multiparkBookings.parkName,
      licensePlate: multiparkBookings.licensePlate,
      bookingStatus: multiparkBookings.status,
    })
    .from(multiparkBookingHistory)
    .leftJoin(multiparkBookings, eq(multiparkBookings.externalId, multiparkBookingHistory.bookingExternalId))
    .where(or(
      like(multiparkBookingHistory.bookingExternalId, s),
      like(multiparkBookings.licensePlate, s),
      like(multiparkBookingHistory.agentName, s),
      like(multiparkBookingHistory.changeType, s),
    ))
    .orderBy(desc(multiparkBookingHistory.actionTime))
    .limit(200);
  return mapMultiparkHistoryRows(rows);
}

/**
 * Cruzamento de dados: para cada agente Multipark, conta quantos casos
 * distintos de Perdidos/Achados ele tocou. Devolve só os agentes com
 * pelo menos um caso associado, ordenados por nº de casos (decrescente).
 */
export async function getBookingHistoryCrossReference(): Promise<
  Array<{
    userName: string;
    caseCount: number;
    plates: string[];
    totalActions: number;
    checkins: number;
    checkouts: number;
    movements: number;
    flagged: 1;
  }>
> {
  const db = await getDb();
  if (!db) return [];

  const flaggedRefs = await getLostFoundBookingRefSet();
  if (flaggedRefs.size === 0) return [];
  const refs = Array.from(flaggedRefs);

  const rows = await db
    .select({
      agentName: multiparkBookingHistory.agentName,
      changeType: multiparkBookingHistory.changeType,
      bookingExternalId: multiparkBookingHistory.bookingExternalId,
      licensePlate: multiparkBookings.licensePlate,
    })
    .from(multiparkBookingHistory)
    .leftJoin(multiparkBookings, eq(multiparkBookings.externalId, multiparkBookingHistory.bookingExternalId))
    .where(inArray(multiparkBookingHistory.bookingExternalId, refs));

  const driverMap = new Map<string, { cases: Set<string>; plates: Set<string>; total: number; checkins: number; checkouts: number; movements: number }>();
  for (const r of rows) {
    if (!r.agentName) continue;
    const entry = driverMap.get(r.agentName) ?? { cases: new Set(), plates: new Set(), total: 0, checkins: 0, checkouts: 0, movements: 0 };
    entry.cases.add(r.bookingExternalId);
    if (r.licensePlate) entry.plates.add(r.licensePlate);
    entry.total++;
    const ct = (r.changeType ?? "").toUpperCase();
    if (ct === "CHECK_IN") entry.checkins++;
    else if (ct === "CHECK_OUT") entry.checkouts++;
    else if (ct === "MOVEMENT") entry.movements++;
    driverMap.set(r.agentName, entry);
  }

  return Array.from(driverMap.entries())
    .map(([userName, data]) => ({
      userName,
      caseCount: data.cases.size,
      plates: Array.from(data.plates),
      totalActions: data.total,
      checkins: data.checkins,
      checkouts: data.checkouts,
      movements: data.movements,
      flagged: 1 as const,
    }))
    .sort((a, b) => b.caseCount - a.caseCount);
}

/**
 * Stats globais de todos os agentes que apareceram no histórico Multipark.
 * Marca `flagged = 1` quem está envolvido em casos de Perdidos/Achados.
 */
export async function getBookingHistoryDriverStats(): Promise<
  Array<{
    userName: string | null;
    total: number;
    checkins: number;
    checkouts: number;
    movements: number;
    flagged: 0 | 1;
    caseCount: number;
  }>
> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      userName: multiparkBookingHistory.agentName,
      total: sql<number>`COUNT(*)`,
      checkins: sql<number>`SUM(CASE WHEN UPPER(${multiparkBookingHistory.changeType}) = 'CHECK_IN' THEN 1 ELSE 0 END)`,
      checkouts: sql<number>`SUM(CASE WHEN UPPER(${multiparkBookingHistory.changeType}) = 'CHECK_OUT' THEN 1 ELSE 0 END)`,
      movements: sql<number>`SUM(CASE WHEN UPPER(${multiparkBookingHistory.changeType}) = 'MOVEMENT' THEN 1 ELSE 0 END)`,
    })
    .from(multiparkBookingHistory)
    .groupBy(multiparkBookingHistory.agentName)
    .orderBy(desc(sql`COUNT(*)`));

  // Anota com caseCount (nº de casos distintos de Perdidos/Achados associados)
  const cross = await getBookingHistoryCrossReference();
  const caseMap = new Map(cross.map((c) => [c.userName, c.caseCount]));

  return rows.map((r) => {
    const caseCount = caseMap.get(r.userName ?? "") ?? 0;
    return {
      userName: r.userName,
      total: Number(r.total),
      checkins: Number(r.checkins),
      checkouts: Number(r.checkouts),
      movements: Number(r.movements),
      caseCount,
      flagged: (caseCount > 0 ? 1 : 0) as 0 | 1,
    };
  });
}

/**
 * Para uma matrícula, devolve todos os agentes Multipark que mexeram em
 * reservas dessa matrícula. Marca `flagged = 1` para agentes que tocaram
 * especificamente no `currentBookingRef` (a reserva do caso aberto).
 */
export async function getVehicleAgentsByPlate(
  plate: string,
  currentBookingRef?: string | null,
): Promise<
  Array<{
    agentName: string;
    agentEmail: string | null;
    actions: number;
    checkins: number;
    checkouts: number;
    movements: number;
    lastActionAt: string | null;
    bookings: string[];
    flagged: 0 | 1;
  }>
> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      agentName: multiparkBookingHistory.agentName,
      agentEmail: multiparkBookingHistory.agentEmail,
      changeType: multiparkBookingHistory.changeType,
      actionTime: multiparkBookingHistory.actionTime,
      bookingExternalId: multiparkBookingHistory.bookingExternalId,
    })
    .from(multiparkBookingHistory)
    .innerJoin(multiparkBookings, eq(multiparkBookings.externalId, multiparkBookingHistory.bookingExternalId))
    .where(eq(multiparkBookings.licensePlate, plate))
    .orderBy(desc(multiparkBookingHistory.actionTime))
    .limit(2000);

  const map = new Map<
    string,
    { agentName: string; agentEmail: string | null; actions: number; checkins: number; checkouts: number; movements: number; lastActionAt: string | null; bookings: Set<string>; touchedRef: boolean }
  >();

  for (const r of rows) {
    if (!r.agentName) continue;
    const e = map.get(r.agentName) ?? {
      agentName: r.agentName,
      agentEmail: r.agentEmail ?? null,
      actions: 0,
      checkins: 0,
      checkouts: 0,
      movements: 0,
      lastActionAt: null as string | null,
      bookings: new Set<string>(),
      touchedRef: false,
    };
    if (!e.agentEmail && r.agentEmail) e.agentEmail = r.agentEmail;
    e.actions++;
    const ct = (r.changeType ?? "").toUpperCase();
    if (ct === "CHECK_IN") e.checkins++;
    else if (ct === "CHECK_OUT") e.checkouts++;
    else if (ct === "MOVEMENT") e.movements++;
    if (r.actionTime && (!e.lastActionAt || r.actionTime > e.lastActionAt)) e.lastActionAt = r.actionTime;
    e.bookings.add(r.bookingExternalId);
    if (currentBookingRef && r.bookingExternalId === currentBookingRef) e.touchedRef = true;
    map.set(r.agentName, e);
  }

  return Array.from(map.values())
    .map((e) => ({
      agentName: e.agentName,
      agentEmail: e.agentEmail,
      actions: e.actions,
      checkins: e.checkins,
      checkouts: e.checkouts,
      movements: e.movements,
      lastActionAt: e.lastActionAt,
      bookings: Array.from(e.bookings),
      flagged: (e.touchedRef ? 1 : 0) as 0 | 1,
    }))
    .sort((a, b) => (b.flagged - a.flagged) || (b.actions - a.actions));
}

/**
 * Movimentos de UM condutor num período (investigação de roubos): tudo o que
 * o agente fez em multipark_booking_history, com matrícula/parque via JOIN às
 * reservas. `flagged` marca movimentos em reservas/matrículas com caso aberto
 * nos Perdidos & Achados.
 */
export async function getAgentMovements(opts: {
  agentName: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}): Promise<{
  movements: Array<{
    actionTime: string | null;
    changeType: string | null;
    bookingExternalId: string;
    licensePlate: string | null;
    parkName: string | null;
    city: string | null;
    remarks: string | null;
    flagged: 0 | 1;
  }>;
  plates: Array<{ plate: string; actions: number; first: string | null; last: string | null; isCaseVehicle: 0 | 1 }>;
  totals: { actions: number; checkins: number; checkouts: number; movements: number; plates: number; flaggedPlates: number };
}> {
  const db = await getDb();
  const empty = { movements: [], plates: [], totals: { actions: 0, checkins: 0, checkouts: 0, movements: 0, plates: 0, flaggedPlates: 0 } };
  if (!db) return empty;

  const rows = await db
    .select({
      actionTime: multiparkBookingHistory.actionTime,
      changeType: multiparkBookingHistory.changeType,
      bookingExternalId: multiparkBookingHistory.bookingExternalId,
      remarks: multiparkBookingHistory.remarks,
      licensePlate: multiparkBookings.licensePlate,
      parkName: multiparkBookings.parkName,
      city: multiparkBookings.city,
    })
    .from(multiparkBookingHistory)
    .leftJoin(multiparkBookings, eq(multiparkBookings.externalId, multiparkBookingHistory.bookingExternalId))
    .where(
      and(
        eq(multiparkBookingHistory.agentName, opts.agentName),
        gte(multiparkBookingHistory.actionTime, `${opts.from} 00:00:00`),
        lte(multiparkBookingHistory.actionTime, `${opts.to} 23:59:59`),
      ),
    )
    .orderBy(desc(multiparkBookingHistory.actionTime))
    .limit(2000);

  const caseRefs = await getLostFoundBookingRefSet();
  const normPlate = (p: string) => p.replace(/[\s-]/g, "").toUpperCase();
  const caseItems = await db.select({ vehiclePlate: lostFoundItems.vehiclePlate }).from(lostFoundItems);
  const casePlates = new Set(caseItems.map((i) => i.vehiclePlate?.trim()).filter(Boolean).map((p) => normPlate(p as string)));

  const totals = { actions: 0, checkins: 0, checkouts: 0, movements: 0, plates: 0, flaggedPlates: 0 };
  const plateMap = new Map<string, { plate: string; actions: number; first: string | null; last: string | null; isCaseVehicle: 0 | 1 }>();

  const movements = rows.map((r) => {
    totals.actions++;
    const ct = (r.changeType ?? "").toUpperCase();
    if (ct === "CHECK_IN") totals.checkins++;
    else if (ct === "CHECK_OUT") totals.checkouts++;
    else if (ct === "MOVEMENT") totals.movements++;
    const plateFlag = r.licensePlate ? casePlates.has(normPlate(r.licensePlate)) : false;
    const flagged: 0 | 1 = caseRefs.has(r.bookingExternalId) || plateFlag ? 1 : 0;
    if (r.licensePlate) {
      const key = normPlate(r.licensePlate);
      const p = plateMap.get(key) ?? { plate: r.licensePlate, actions: 0, first: null as string | null, last: null as string | null, isCaseVehicle: (plateFlag ? 1 : 0) as 0 | 1 };
      p.actions++;
      if (r.actionTime && (!p.first || r.actionTime < p.first)) p.first = r.actionTime;
      if (r.actionTime && (!p.last || r.actionTime > p.last)) p.last = r.actionTime;
      if (plateFlag) p.isCaseVehicle = 1;
      plateMap.set(key, p);
    }
    return {
      actionTime: r.actionTime,
      changeType: r.changeType,
      bookingExternalId: r.bookingExternalId,
      licensePlate: r.licensePlate,
      parkName: r.parkName,
      city: r.city,
      remarks: r.remarks,
      flagged,
    };
  });

  const plates = Array.from(plateMap.values()).sort((a, b) => (b.isCaseVehicle - a.isCaseVehicle) || (b.actions - a.actions));
  totals.plates = plates.length;
  totals.flaggedPlates = plates.filter((p) => p.isCaseVehicle).length;

  return { movements, plates, totals };
}

// ─── MULTIPARK BOOKING HISTORY (local DB instead of remote API) ─────────────

/**
 * Ranking de condutores por número de CHECK_OUT no período (DB local).
 * Substitui a chamada `/bookings/checkoutDrivers` da API Multipark.
 */
export async function getCheckoutDriversFromDb(
  startDate: string,
  endDate: string,
): Promise<{ total: number; period: { startDate: string; endDate: string }; drivers: Array<{ name: string; userId?: string; count: number }> }> {
  const db = await getDb();
  if (!db) return { total: 0, period: { startDate, endDate }, drivers: [] };

  const startStr = toMysqlDateTime(new Date(startDate));
  const endStr = toMysqlDateTime(new Date(endDate + "T23:59:59"));

  const rows = await db
    .select({
      agentName: multiparkBookingHistory.agentName,
      agentUserId: multiparkBookingHistory.agentUserId,
      count: sql<number>`COUNT(*)`,
    })
    .from(multiparkBookingHistory)
    .where(
      and(
        sql`UPPER(${multiparkBookingHistory.changeType}) = 'CHECK_OUT'`,
        gte(multiparkBookingHistory.actionTime, startStr),
        lte(multiparkBookingHistory.actionTime, endStr),
        isNotNull(multiparkBookingHistory.agentName),
      ),
    )
    .groupBy(multiparkBookingHistory.agentName, multiparkBookingHistory.agentUserId)
    .orderBy(desc(sql`COUNT(*)`));

  const drivers = rows
    .filter((r) => r.agentName)
    .map((r) => ({
      name: r.agentName as string,
      userId: r.agentUserId ?? undefined,
      count: Number(r.count),
    }));
  const total = drivers.reduce((s, d) => s + d.count, 0);
  return { total, period: { startDate, endDate }, drivers };
}

/**
 * Histórico de um agente (todas as ações no período, com a reserva associada).
 * Substitui `/agent/history` da API Multipark.
 */
export async function getAgentHistoryFromDb(opts: {
  startDate: string;
  endDate: string;
  agentName?: string;
  userId?: string;
}): Promise<{
  total: number;
  period: { startDate: string; endDate: string };
  agentName: string;
  agentUserId: string;
  history: Array<{
    id: string;
    changeType: string;
    actionTime: string;
    remarks?: string;
    agentName: string;
    userId: string;
    modifiedFields?: string;
    platform?: string;
    booking?: {
      id: string;
      status: string;
      checkIn: string;
      checkOut?: string;
      parkName: string;
      licensePlate: string;
    };
  }>;
}> {
  const db = await getDb();
  const empty = {
    total: 0,
    period: { startDate: opts.startDate, endDate: opts.endDate },
    agentName: opts.agentName ?? "",
    agentUserId: opts.userId ?? "",
    history: [],
  };
  if (!db) return empty;
  if (!opts.agentName && !opts.userId) return empty;

  const startStr = toMysqlDateTime(new Date(opts.startDate));
  const endStr = toMysqlDateTime(new Date(opts.endDate + "T23:59:59"));

  const conds: any[] = [
    gte(multiparkBookingHistory.actionTime, startStr),
    lte(multiparkBookingHistory.actionTime, endStr),
  ];
  if (opts.userId) {
    conds.push(eq(multiparkBookingHistory.agentUserId, opts.userId));
  } else if (opts.agentName) {
    conds.push(sql`LOWER(${multiparkBookingHistory.agentName}) LIKE LOWER(${"%" + opts.agentName + "%"})`);
  }

  const rows = await db
    .select({
      id: multiparkBookingHistory.historyId,
      changeType: multiparkBookingHistory.changeType,
      actionTime: multiparkBookingHistory.actionTime,
      remarks: multiparkBookingHistory.remarks,
      agentName: multiparkBookingHistory.agentName,
      agentUserId: multiparkBookingHistory.agentUserId,
      modifiedFields: multiparkBookingHistory.modifiedFields,
      platform: multiparkBookingHistory.platform,
      bookingExternalId: multiparkBookingHistory.bookingExternalId,
      bookingStatus: multiparkBookings.status,
      bookingCheckIn: multiparkBookings.checkIn,
      bookingCheckOut: multiparkBookings.checkOut,
      bookingParkName: multiparkBookings.parkName,
      bookingLicensePlate: multiparkBookings.licensePlate,
    })
    .from(multiparkBookingHistory)
    .leftJoin(multiparkBookings, eq(multiparkBookings.externalId, multiparkBookingHistory.bookingExternalId))
    .where(and(...conds))
    .orderBy(desc(multiparkBookingHistory.actionTime))
    .limit(500);

  const history = rows.map((r) => ({
    id: r.id,
    changeType: r.changeType ?? "",
    actionTime: r.actionTime ?? "",
    remarks: r.remarks ?? undefined,
    agentName: r.agentName ?? "",
    userId: r.agentUserId ?? "",
    modifiedFields: r.modifiedFields ?? undefined,
    platform: r.platform ?? undefined,
    booking: r.bookingExternalId
      ? {
          id: r.bookingExternalId,
          status: r.bookingStatus ?? "",
          checkIn: r.bookingCheckIn ?? "",
          checkOut: r.bookingCheckOut ?? undefined,
          parkName: r.bookingParkName ?? "",
          licensePlate: r.bookingLicensePlate ?? "",
        }
      : undefined,
  }));

  const first = rows[0];
  return {
    total: history.length,
    period: { startDate: opts.startDate, endDate: opts.endDate },
    agentName: first?.agentName ?? opts.agentName ?? "",
    agentUserId: first?.agentUserId ?? opts.userId ?? "",
    history,
  };
}

// ─── INCIDENTS sync from Multipark booking history ──────────────────────────

type IncidentClassification = {
  incidentType: "vidro_aberto" | "mal_estacionado" | "dano" | "chave_errada" | "combustivel" | "limpeza" | "documentos" | "outro";
  severity: "low" | "medium" | "high" | "critical";
};

function classifyRemarks(remarks: string): IncidentClassification {
  const r = remarks.toLowerCase();
  // dano cobre embates, batidas, riscos, amassadelas — high
  if (/\bdano|amassad|risc|batid|embat|colis|raspad|partid|partiu|partir/.test(r)) {
    return { incidentType: "dano", severity: "high" };
  }
  if (/\bvidro|janela\b/.test(r)) {
    return { incidentType: "vidro_aberto", severity: "medium" };
  }
  if (/\bmal\s*estacion|fora\s*do\s*lugar|posi[cç][aã]o\s*errad/.test(r)) {
    return { incidentType: "mal_estacionado", severity: "medium" };
  }
  if (/\bchav/.test(r)) {
    return { incidentType: "chave_errada", severity: "medium" };
  }
  if (/\bcombust[ií]vel|gasolina|diesel|gas[oó]leo|tanque\s*vazio|sem\s*combust|reserva\s*combust/.test(r)) {
    return { incidentType: "combustivel", severity: "medium" };
  }
  if (/\bsuj|limpez|limpar|nodoa|n[oó]doa|mancha/.test(r)) {
    return { incidentType: "limpeza", severity: "low" };
  }
  if (/\bdocument|carta\s*de\s*condu|livrete|seguro/.test(r)) {
    return { incidentType: "documentos", severity: "low" };
  }
  return { incidentType: "outro", severity: "low" };
}

/**
 * Varre multipark_booking_history nos últimos `lookbackDays` dias e cria
 * incidents para cada `remarks` significativo que ainda não tenha sido
 * importado. Dedup via incidents.sourceEmailId = "mp:" + historyId.
 */
export async function syncIncidentsFromMultiparkHistory(opts: {
  lookbackDays?: number;
  reportedById?: number | null;
} = {}): Promise<{
  scanned: number;
  imported: number;
  skipped: number;
  errors: string[];
  details: string[];
}> {
  const db = await getDb();
  const empty = { scanned: 0, imported: 0, skipped: 0, errors: [] as string[], details: [] as string[] };
  if (!db) return empty;

  const lookbackDays = opts.lookbackDays ?? 30;
  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);
  const sinceStr = toMysqlDateTime(since);

  // Pega entradas com remarks não-triviais
  const rows = await db
    .select({
      historyId: multiparkBookingHistory.historyId,
      bookingExternalId: multiparkBookingHistory.bookingExternalId,
      remarks: multiparkBookingHistory.remarks,
      actionTime: multiparkBookingHistory.actionTime,
      agentName: multiparkBookingHistory.agentName,
      changeType: multiparkBookingHistory.changeType,
    })
    .from(multiparkBookingHistory)
    .where(
      and(
        isNotNull(multiparkBookingHistory.remarks),
        gte(multiparkBookingHistory.actionTime, sinceStr),
      ),
    )
    .orderBy(desc(multiparkBookingHistory.actionTime))
    .limit(500);

  const result = { ...empty };
  for (const row of rows) {
    const remarks = (row.remarks ?? "").trim();
    if (!remarks || remarks.length < 3) continue; // ignora ruído
    result.scanned++;

    const sourceKey = `mp:${row.historyId}`;
    try {
      const existing = await db
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.sourceEmailId, sourceKey))
        .limit(1);
      if (existing.length > 0) { result.skipped++; continue; }
    } catch (e: any) {
      result.errors.push(`Lookup ${row.historyId}: ${e.message}`);
      continue;
    }

    const cls = classifyRemarks(remarks);

    // Procura matrícula via booking
    let vehiclePlate: string | undefined;
    try {
      const [booking] = await db
        .select({ plate: multiparkBookings.licensePlate })
        .from(multiparkBookings)
        .where(eq(multiparkBookings.externalId, row.bookingExternalId))
        .limit(1);
      vehiclePlate = booking?.plate ?? undefined;
    } catch {}

    const importedAtStr = new Date().toISOString().slice(0, 19).replace("T", " ");
    try {
      const id = await createIncident({
        incidentType: cls.incidentType,
        severity: cls.severity,
        status: "open",
        description: remarks.slice(0, 1000),
        vehiclePlate,
        reportedBy: opts.reportedById ?? null,
        sourceEmailId: sourceKey, // reaproveita para dedup (Multipark history id)
        reservationLink: row.bookingExternalId,
        aiClassification: `Multipark · ${row.changeType ?? ""} · ${row.agentName ?? ""}`.trim(),
        importedAt: importedAtStr,
      });
      result.imported++;
      result.details.push(`${cls.incidentType} (${cls.severity}) — ${remarks.slice(0, 60)}${remarks.length > 60 ? "…" : ""}`);
    } catch (e: any) {
      result.errors.push(`Create ${row.historyId}: ${e.message}`);
    }
  }
  return result;
}

// ─── INBOUND EMAILS (leitor IMAP → roteamento) ──────────────────────────────
export async function createInboundEmail(data: InsertInboundEmail): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Campos extraídos de emails são texto livre e podem exceder as colunas
  // (ex.: parseInboundBody a apanhar um "nome" gigante → "Data too long for
  // column 'clientName'" e o email fica preso em erro para sempre). Clamp aos
  // tamanhos reais do schema.
  const clamp = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : v);
  const safe: InsertInboundEmail = {
    ...data,
    messageId: clamp(data.messageId, 255) as string,
    alias: clamp(data.alias, 40) as string,
    fromName: clamp(data.fromName, 255) as any,
    fromEmail: clamp(data.fromEmail, 320) as any,
    clientName: clamp(data.clientName, 255) as any,
    clientEmail: clamp(data.clientEmail, 320) as any,
    clientPhone: clamp(data.clientPhone, 50) as any,
    vehiclePlate: clamp(data.vehiclePlate, 20) as any,
    bookingRef: clamp(data.bookingRef, 100) as any,
    subject: clamp(data.subject, 500) as any,
    errorMsg: clamp((data as any).errorMsg, 500) as any,
  };
  const [result] = await db.insert(inboundEmails).values(safe);
  return (result as any).insertId as number;
}

/** Batch do dedup do email-inbound: quais destes messageIds já existem. */
export async function listExistingInboundMessageIds(messageIds: string[]): Promise<Set<string>> {
  const db = await getDb();
  if (!db || messageIds.length === 0) return new Set();
  const rows = await db
    .select({ m: inboundEmails.messageId })
    .from(inboundEmails)
    .where(inArray(inboundEmails.messageId, messageIds));
  return new Set(rows.map(r => r.m));
}

export async function getInboundEmailByMessageId(messageId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(inboundEmails).where(eq(inboundEmails.messageId, messageId)).limit(1);
  return rows[0] || null;
}

export async function listInboundEmailsByAlias(alias: string, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(inboundEmails)
    .where(eq(inboundEmails.alias, alias))
    .orderBy(desc(inboundEmails.receivedAt), desc(inboundEmails.id))
    .limit(limit);
}

// Pesquisa emails inbound de um alias (from/subject/cliente) para anexar à mão.
export async function searchInboundEmails(alias: string, search?: string | null, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [eq(inboundEmails.alias, alias)];
  const q = (search ?? "").trim();
  if (q) {
    const pat = `%${q}%`;
    conds.push(or(
      like(inboundEmails.fromEmail, pat),
      like(inboundEmails.fromName, pat),
      like(inboundEmails.clientEmail, pat),
      like(inboundEmails.clientName, pat),
      like(inboundEmails.subject, pat),
    ));
  }
  return db.select({
    id: inboundEmails.id, fromName: inboundEmails.fromName, fromEmail: inboundEmails.fromEmail,
    clientName: inboundEmails.clientName, clientEmail: inboundEmails.clientEmail,
    subject: inboundEmails.subject, bodyText: inboundEmails.bodyText,
    targetModule: inboundEmails.targetModule, targetId: inboundEmails.targetId,
    receivedAt: inboundEmails.receivedAt,
  }).from(inboundEmails).where(and(...conds))
    .orderBy(desc(inboundEmails.receivedAt), desc(inboundEmails.id)).limit(limit);
}

export async function getInboundEmailById(id: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(inboundEmails).where(eq(inboundEmails.id, id)).limit(1);
  return rows[0] || null;
}

export async function setInboundEmailTarget(id: number, targetModule: string, targetId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(inboundEmails).set({ targetModule, targetId }).where(eq(inboundEmails.id, id));
}

// Procura um colaborador por email exato, por nome (parcial) ou via o user
// associado (employees.userId = users.id com esse email).
export async function findEmployeeByEmailOrName(needle: string) {
  const db = await getDb();
  if (!db) return null;
  // 1) email ou nome do próprio employee
  let rows = await db.select().from(employees)
    .where(or(eq(employees.email, needle), like(employees.fullName, `%${needle}%`)))
    .limit(1);
  if (rows[0]) return rows[0];
  // 2) via user (quando o email pertence à conta de utilizador, não à ficha)
  if (needle.includes("@")) {
    const u = await db.select({ id: users.id }).from(users).where(eq(users.email, needle)).limit(1);
    if (u[0]) {
      rows = await db.select().from(employees).where(eq(employees.userId, u[0].id)).limit(1);
      if (rows[0]) return rows[0];
    }
  }
  return null;
}

// Id de um utilizador de "sistema" (1º super_admin) para createdBy/createdById.
export async function getSystemUserId(): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select({ id: users.id }).from(users)
    .where(eq(users.role, "super_admin")).orderBy(users.id).limit(1);
  if (rows[0]?.id) return rows[0].id;
  const any = await db.select({ id: users.id }).from(users).orderBy(users.id).limit(1);
  if (!any[0]?.id) throw new Error("Sem utilizadores na BD");
  return any[0].id;
}

export async function assignTaskToEmployee(taskId: number, employeeId: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(taskAssignees).values({ taskId, employeeId });
}

// Procura uma reclamação ABERTA do mesmo cliente (email ou matrícula), para
// agrupar emails repetidos/respostas em vez de criar reclamações novas.
/**
 * Agrupamento AGRESSIVO de reclamações por cliente: email OU matrícula OU nome
 * (nome exato, ≥6 chars, para evitar falsos positivos). Ao contrário do
 * findOpenComplaintByClient, também devolve reclamações resolvidas/fechadas —
 * o caller reabre-as. Preferência: aberta > mais recente. Objetivo: 10 emails
 * do mesmo cliente = 1 reclamação com 10 mensagens, nunca 10 reclamações.
 */
export async function findComplaintByClientSignals(
  clientEmail?: string | null,
  vehiclePlate?: string | null,
  clientName?: string | null,
) {
  const db = await getDb();
  if (!db) return null;
  const conds: any[] = [];
  if (clientEmail) conds.push(eq(complaints.clientEmail, clientEmail));
  if (vehiclePlate) conds.push(eq(complaints.vehiclePlate, vehiclePlate));
  const name = clientName?.trim();
  if (name && name.length >= 6 && name.toLowerCase() !== "desconhecido") {
    conds.push(eq(complaints.clientName, name));
  }
  if (!conds.length) return null;
  const rows = await db.select().from(complaints)
    .where(or(...conds))
    .orderBy(desc(complaints.createdAt))
    .limit(5);
  if (!rows.length) return null;
  const open = rows.find(r => r.complaintStatus !== "resolved" && r.complaintStatus !== "closed");
  return open ?? rows[0];
}

/**
 * Reserva mais recente do cliente em multipark_bookings, por matrícula OU
 * email OU nome completo. Para auto-anexar a reserva a uma reclamação criada
 * por email (reservationRef = externalId → liga logo o histórico/condutores).
 */
export async function findRecentBookingByClientSignals(
  clientEmail?: string | null,
  vehiclePlate?: string | null,
  clientName?: string | null,
) {
  const db = await getDb();
  if (!db) return null;
  const conds: any[] = [];
  const plate = vehiclePlate?.replace(/[\s-]/g, "").toUpperCase();
  if (plate) conds.push(eq(multiparkBookings.licensePlate, plate));
  if (clientEmail) conds.push(eq(multiparkBookings.clientEmail, clientEmail));
  const name = clientName?.trim();
  if (name && name.length >= 6) {
    conds.push(sql`CONCAT_WS(' ', ${multiparkBookings.clientFirstName}, ${multiparkBookings.clientLastName}) = ${name}`);
  }
  if (!conds.length) return null;
  const rows = await db.select().from(multiparkBookings)
    .where(or(...conds))
    .orderBy(desc(multiparkBookings.checkIn))
    .limit(1);
  return rows[0] || null;
}

export async function findOpenComplaintByClient(clientEmail?: string | null, vehiclePlate?: string | null) {
  const db = await getDb();
  if (!db) return null;
  const conds: any[] = [];
  if (clientEmail) conds.push(eq(complaints.clientEmail, clientEmail));
  if (vehiclePlate) conds.push(eq(complaints.vehiclePlate, vehiclePlate));
  if (!conds.length) return null;
  const rows = await db.select().from(complaints)
    .where(and(notInArray(complaints.complaintStatus, ["resolved", "closed"]), or(...conds)))
    .orderBy(desc(complaints.createdAt))
    .limit(1);
  return rows[0] || null;
}

// ── Histórico completo de um cliente (cruza reservas + reclamações + perdidos +
//    críticas) por email / telefone / matrícula / nome. Usado nos detalhes de
//    Reclamações, Perdidos&Achados e Críticas para ver tudo o que se passou. ──
export interface ClientHistoryQuery {
  email?: string | null;
  phone?: string | null;
  plate?: string | null;
  name?: string | null;
}

export async function getClientHistory(q: ClientHistoryQuery) {
  const db = await getDb();
  const empty = { bookings: [] as any[], complaints: [] as any[], lostFound: [] as any[], reviews: [] as any[] };
  if (!db) return empty;

  const email = q.email?.trim() || null;
  const phone = q.phone?.trim() || null;
  const plate = q.plate?.trim() || null;
  const name = q.name?.trim() || null;
  if (!email && !phone && !plate && !name) return empty;

  const namePat = name ? `%${name}%` : null;

  // Reservas (multipark_bookings)
  const bookingConds: any[] = [];
  if (email) bookingConds.push(eq(multiparkBookings.clientEmail, email));
  if (phone) bookingConds.push(eq(multiparkBookings.clientPhone, phone));
  if (plate) bookingConds.push(eq(multiparkBookings.licensePlate, plate));
  if (namePat) bookingConds.push(sql`CONCAT_WS(' ', ${multiparkBookings.clientFirstName}, ${multiparkBookings.clientLastName}) LIKE ${namePat}`);

  const complaintConds: any[] = [];
  if (email) complaintConds.push(eq(complaints.clientEmail, email));
  if (phone) complaintConds.push(eq(complaints.clientPhone, phone));
  if (plate) complaintConds.push(eq(complaints.vehiclePlate, plate));
  if (namePat) complaintConds.push(like(complaints.clientName, namePat));

  const lfConds: any[] = [];
  if (email) lfConds.push(eq(lostFoundItems.clientEmail, email));
  if (phone) lfConds.push(eq(lostFoundItems.clientPhone, phone));
  if (plate) lfConds.push(eq(lostFoundItems.vehiclePlate, plate));
  if (namePat) lfConds.push(like(lostFoundItems.clientName, namePat));

  const reviewConds: any[] = [];
  if (email) reviewConds.push(eq(googleReviews.reviewerEmail, email));
  if (plate) reviewConds.push(eq(googleReviews.vehiclePlate, plate));
  if (namePat) reviewConds.push(like(googleReviews.reviewerName, namePat));

  const [bookings, complaintRows, lostFound, reviews] = await Promise.all([
    bookingConds.length
      ? db.select({
          id: multiparkBookings.id, externalId: multiparkBookings.externalId,
          bookingNumber: multiparkBookings.bookingNumber, status: multiparkBookings.status,
          parkName: multiparkBookings.parkName, city: multiparkBookings.city,
          checkIn: multiparkBookings.checkIn, checkOut: multiparkBookings.checkOut,
          licensePlate: multiparkBookings.licensePlate, totalPrice: multiparkBookings.totalPrice,
          clientFirstName: multiparkBookings.clientFirstName, clientLastName: multiparkBookings.clientLastName,
        }).from(multiparkBookings).where(or(...bookingConds)).orderBy(desc(multiparkBookings.checkIn)).limit(30)
      : Promise.resolve([]),
    complaintConds.length
      ? db.select({
          id: complaints.id, title: complaints.title, status: complaints.complaintStatus,
          vehiclePlate: complaints.vehiclePlate, createdAt: complaints.createdAt,
        }).from(complaints).where(or(...complaintConds)).orderBy(desc(complaints.createdAt)).limit(30)
      : Promise.resolve([]),
    lfConds.length
      ? db.select({
          id: lostFoundItems.id, itemType: lostFoundItems.itemType, description: lostFoundItems.description,
          status: lostFoundItems.status, vehiclePlate: lostFoundItems.vehiclePlate, createdAt: lostFoundItems.createdAt,
        }).from(lostFoundItems).where(or(...lfConds)).orderBy(desc(lostFoundItems.createdAt)).limit(30)
      : Promise.resolve([]),
    reviewConds.length
      ? db.select({
          id: googleReviews.id, rating: googleReviews.rating, reviewText: googleReviews.reviewText,
          status: googleReviews.status, vehiclePlate: googleReviews.vehiclePlate, createdAt: googleReviews.createdAt,
        }).from(googleReviews).where(or(...reviewConds)).orderBy(desc(googleReviews.createdAt)).limit(30)
      : Promise.resolve([]),
  ]);

  return { bookings, complaints: complaintRows, lostFound, reviews };
}

// ── Threading: agrupar RESPOSTAS na mesma reclamação/perdido ──────────────────
// Normaliza um assunto removendo prefixos Re:/Fwd:/Enc: e espaços, p/ comparar
// "Re: Fwd: Reclamação X" com o título original "Reclamação X".
export function normalizeSubject(subject?: string | null): string {
  return (subject || "")
    .replace(/^(\s*(re|fw|fwd|enc|res|tr|aw)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Procura a reclamação a que um email inbound pertence pelo THREAD:
 *  1) gmThreadId (X-GM-THRID) igual a um email já roteado para uma reclamação;
 *  2) interseção das referências (In-Reply-To/References) com o messageId OU as
 *     headerRefs de emails já roteados para uma reclamação.
 * Devolve a reclamação mesmo que esteja resolvida/fechada (uma resposta reabre).
 */
export async function findComplaintByThread(opts: { gmThreadId?: string | null; refs?: string[] }) {
  const db = await getDb();
  if (!db) return null;

  if (opts.gmThreadId) {
    const rows = await db.select().from(inboundEmails)
      .where(and(
        eq(inboundEmails.gmThreadId, opts.gmThreadId),
        eq(inboundEmails.targetModule, "complaint"),
        isNotNull(inboundEmails.targetId),
      ))
      .orderBy(desc(inboundEmails.id))
      .limit(1);
    if (rows[0]?.targetId) {
      const c = await getComplaintById(rows[0].targetId);
      if (c) return c;
    }
  }

  const refs = (opts.refs || []).map(r => r.trim()).filter(Boolean);
  if (refs.length) {
    const refSet = new Set(refs);
    const recent = await db.select().from(inboundEmails)
      .where(and(eq(inboundEmails.targetModule, "complaint"), isNotNull(inboundEmails.targetId)))
      .orderBy(desc(inboundEmails.id))
      .limit(500);
    for (const r of recent) {
      const known = new Set<string>();
      if (r.messageId) known.add(r.messageId.trim());
      if (r.headerRefs) for (const x of r.headerRefs.split(/\s+/)) if (x) known.add(x.trim());
      let hit = false;
      for (const ref of refSet) if (known.has(ref)) { hit = true; break; }
      if (hit && r.targetId) {
        const c = await getComplaintById(r.targetId);
        if (c) return c;
      }
    }
  }
  return null;
}

// Fallback: reclamação ABERTA com o mesmo assunto normalizado (cobre respostas
// reencaminhadas que perderam thread/referências mas mantêm "Re: <assunto>").
export async function findOpenComplaintBySubject(subject?: string | null) {
  const db = await getDb();
  if (!db) return null;
  const key = normalizeSubject(subject);
  if (key.length < 6) return null; // evita agrupar por assuntos demasiado genéricos
  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  const rows = await db.select().from(complaints)
    .where(and(
      notInArray(complaints.complaintStatus, ["resolved", "closed"]),
      gte(complaints.createdAt, since),
    ))
    .orderBy(desc(complaints.createdAt))
    .limit(200);
  return rows.find(r => normalizeSubject(r.title) === key) || null;
}

// Idem para Perdidos & Achados (aberto = não devolvido/fechado).
export async function findOpenLostFoundByClient(clientEmail?: string | null, vehiclePlate?: string | null) {
  const db = await getDb();
  if (!db) return null;
  const conds: any[] = [];
  if (clientEmail) conds.push(eq(lostFoundItems.clientEmail, clientEmail));
  if (vehiclePlate) conds.push(eq(lostFoundItems.vehiclePlate, vehiclePlate));
  if (!conds.length) return null;
  const rows = await db.select().from(lostFoundItems)
    .where(and(notInArray(lostFoundItems.status, ["returned", "closed"]), or(...conds)))
    .orderBy(desc(lostFoundItems.createdAt))
    .limit(1);
  return rows[0] || null;
}
