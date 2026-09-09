import { and, desc, eq, gte, lte, like, or, sql, aliasedTable, isNotNull, isNull, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

/**
 * Escapa wildcards SQL LIKE (%, _, \) para evitar que um utilizador
 * possa alargar resultados injectando wildcards no input de pesquisa.
 *
 * Uso: `like(col, `%${sanitizeLike(input)}%`)`
 */
function sanitizeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}
import {
  users,
  expenses,
  expenseCategories,
  projects,
  projectEmployees,
  tasks,
  taskAssignees,
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
  incidents,
  performanceEvaluations,
  services,
  invoices,
  partnerships,
  partnershipTransactions,
  partnershipInvoices,
  annualReports,
  multiparkBookings,
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
} from "../drizzle/schema";
import type { LostFoundItem, LostFoundPhoto, LostFoundMessage } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
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
      values[field] = value ?? null;
      updateSet[field] = value ?? null;
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

  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

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

export async function createManualUser(data: { name: string; email: string; role: string; department?: string }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const openId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await db.insert(users).values({
    openId,
    name: data.name,
    email: data.email,
    role: data.role as any,
    department: data.department ?? null,
    loginMethod: "manual",
    isActive: true,
  });
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function updateUser(userId: number, data: { name?: string; email?: string; role?: string; department?: string | null; isActive?: boolean }) {
  const db = await getDb();
  if (!db) return;
  const updates: Record<string, any> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.email !== undefined) updates.email = data.email;
  if (data.role !== undefined) updates.role = data.role;
  if (data.department !== undefined) updates.department = data.department;
  if (data.isActive !== undefined) updates.isActive = data.isActive;
  if (Object.keys(updates).length > 0) {
    await db.update(users).set(updates).where(eq(users.id, userId));
  }
}

export async function toggleUserActive(userId: number, isActive: boolean) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ isActive }).where(eq(users.id, userId));
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
  if (filters.startDate) conditions.push(gte(expenses.expenseDate, filters.startDate));
  if (filters.endDate) conditions.push(lte(expenses.expenseDate, filters.endDate));
  if (filters.projectId) conditions.push(eq(expenses.projectId, filters.projectId));
  if (filters.categoryId) conditions.push(eq(expenses.categoryId, filters.categoryId));
  if (filters.userId) conditions.push(eq(expenses.insertedById, filters.userId));
  if (filters.status) conditions.push(eq(expenses.status, filters.status as any));
  if (filters.search) {
    const q = `%${sanitizeLike(filters.search)}%`;
    conditions.push(
      or(
        like(expenses.supplier, q),
        like(expenses.description, q)
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
        .where(gte(expenses.expenseDate, startOfDay)),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(gte(expenses.expenseDate, startOfWeek)),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(gte(expenses.expenseDate, startOfMonth)),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(gte(expenses.expenseDate, startOfYear)),
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
        .where(gte(expenses.expenseDate, startOfMonth))
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
        .where(gte(expenses.expenseDate, startOfMonth))
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
        .where(gte(expenses.expenseDate, startOfMonth))
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
    .where(gte(expenses.expenseDate, new Date(now.getFullYear(), now.getMonth() - 5, 1)))
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
        gte(expenses.paymentDueDate, now),
        lte(expenses.paymentDueDate, future)
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
    .where(and(eq(expenses.status, "pending"), lte(expenses.paymentDueDate, now)));
}

export async function markOverdueExpenses() {
  const db = await getDb();
  if (!db) return;
  const now = new Date();
  await db
    .update(expenses)
    .set({ status: "overdue" })
    .where(and(eq(expenses.status, "pending"), lte(expenses.paymentDueDate, now)));
}

// ─── ACTIVITY LOGS ────────────────────────────────────────────────────────────

export async function logActivity(data: InsertActivityLog) {
  const db = await getDb();
  if (!db) return;
  await db.insert(activityLogs).values(data);
}

export async function getActivityLogs(limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ log: activityLogs, user: users })
    .from(activityLogs)
    .leftJoin(users, eq(activityLogs.userId, users.id))
    .orderBy(desc(activityLogs.createdAt))
    .limit(limit);
}

// ─── RH: EMPLOYEES ────────────────────────────────────────────────────────────
import {
  employees,
  employeeDocuments,
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
  if (filters.isActive !== undefined) conditions.push(eq(employees.isActive, filters.isActive));
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

export async function updateEmployee(id: number, data: Partial<InsertEmployee>) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(employees).set(data).where(eq(employees.id, id));
}

export async function deleteEmployee(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(employees).set({ isActive: false }).where(eq(employees.id, id));
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

export async function upsertSchedule(data: InsertSchedule) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.insert(schedules).values(data).onDuplicateKeyUpdate({ set: { startTime: data.startTime, endTime: data.endTime, isWorkDay: data.isWorkDay } });
}

// ─── RH: TIME RECORDS ─────────────────────────────────────────────────────────
export async function getTimeRecords(employeeId: number, startDate?: Date, endDate?: Date) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(timeRecords.employeeId, employeeId)];
  if (startDate) conditions.push(gte(timeRecords.recordedAt, startDate));
  if (endDate) conditions.push(lte(timeRecords.recordedAt, endDate));
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
    .where(and(eq(timeRecords.employeeId, employeeId), gte(timeRecords.recordedAt, start), lte(timeRecords.recordedAt, end)))
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
  const [total] = await db.select({ count: sql<number>`count(*)` }).from(employees).where(eq(employees.isActive, true));
  const [extras] = await db.select({ count: sql<number>`count(*)` }).from(employees).where(and(eq(employees.isActive, true), eq(employees.position, "extra")));
  const [permanent] = await db.select({ count: sql<number>`count(*)` }).from(employees).where(and(eq(employees.isActive, true), eq(employees.contractType, "permanent")));

  // Total hours this month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [hoursRow] = await db.select({ total: sql<string>`COALESCE(SUM(hoursWorked), 0)` }).from(timeRecords).where(gte(timeRecords.recordedAt, monthStart));

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

export async function createTask(data: InsertTask) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(tasks).values(data);
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
    const idArr = Array.from(ids);
    conditions.push(idArr.length > 0 ? inArray(campaigns.projectId, idArr) : sql`1 = 0`);
  }
  if (filters.status) conditions.push(eq(campaigns.status, filters.status as any));
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
  if (filters.from) conditions.push(gte(campaignDailyStats.date, filters.from));
  if (filters.to) conditions.push(lte(campaignDailyStats.date, filters.to));
  if (filters.projectId) {
    const allProjects = await db.select().from(projects);
    const ids = new Set<number>();
    const addChildren = (parentId: number) => { ids.add(parentId); for (const p of allProjects) { if (p.parentId === parentId) addChildren(p.id); } };
    addChildren(filters.projectId);
    const idArr = Array.from(ids);
    conditions.push(idArr.length > 0 ? inArray(campaigns.projectId, idArr) : sql`1 = 0`);
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
  if (filters.category) conditions.push(eq(marketingExpenses.category, filters.category as any));
  if (filters.projectId) conditions.push(eq(marketingExpenses.projectId, filters.projectId));
  if (filters.from) conditions.push(gte(marketingExpenses.date, filters.from));
  if (filters.to) conditions.push(lte(marketingExpenses.date, filters.to));
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
  if (filters.from) conditions.push(gte(campaignDailyStats.date, filters.from));
  if (filters.to) conditions.push(lte(campaignDailyStats.date, filters.to));
  if (projectIds) {
    const idArr = Array.from(projectIds);
    conditions.push(idArr.length > 0 ? inArray(campaigns.projectId, idArr) : sql`1 = 0`);
  }

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
  if (filters.from) mktConditions.push(gte(marketingExpenses.date, filters.from));
  if (filters.to) mktConditions.push(lte(marketingExpenses.date, filters.to));
  if (projectIds) {
    const idArr = Array.from(projectIds);
    mktConditions.push(idArr.length > 0 ? inArray(marketingExpenses.projectId, idArr) : sql`1 = 0`);
  }
  const mktQ = db.select({
    total: sql<string>`COALESCE(SUM(${marketingExpenses.amount}), 0)`,
  }).from(marketingExpenses);
  const mktResult = mktConditions.length > 0 ? await mktQ.where(and(...mktConditions)) : await mktQ;

  // Campaign count
  const campConditions: any[] = [];
  if (projectIds) {
    const idArr = Array.from(projectIds);
    campConditions.push(idArr.length > 0 ? inArray(campaigns.projectId, idArr) : sql`1 = 0`);
  }
  const campQ = db.select({ count: sql<number>`COUNT(*)` }).from(campaigns);
  const campCount = campConditions.length > 0 ? await campQ.where(and(...campConditions)) : await campQ;

  const totalSpend = parseFloat(s.totalSpend || "0");
  const totalReservations = s.totalReservations || 0;
  const totalMktExpenses = parseFloat(mktResult[0].total || "0");

  return {
    totalSpend,
    totalReservations,
    costPerReservation: totalReservations > 0 ? (totalSpend + totalMktExpenses) / totalReservations : 0,
    avgConversionValue: totalReservations > 0 ? parseFloat(s.totalConversionValue || "0") / totalReservations : 0,
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
    const idArr = Array.from(ids);
    conditions.push(idArr.length > 0 ? inArray(multiparkBookings.projectId, idArr) : sql`1 = 0`);
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
  if (filters?.status) conditions.push(eq(vehicles.status, filters.status as any));
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
  if (filters?.acknowledged !== undefined) conditions.push(eq(speedAlerts.acknowledged, filters.acknowledged));
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
  await db.update(speedAlerts).set({ acknowledged: true, acknowledgedById: userId, acknowledgedAt: new Date() }).where(eq(speedAlerts.id, id));
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
  const activeVehicles = allVehicles.filter(v => v.status === "active").length;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const allAlerts = await db.select().from(speedAlerts).where(gte(speedAlerts.createdAt, today));
  const todayAlerts = allAlerts.length;
  const allUnack = await db.select().from(speedAlerts).where(eq(speedAlerts.acknowledged, false));
  const unacknowledgedAlerts = allUnack.length;

  const allMovements = await db.select().from(vehicleMovements).where(gte(vehicleMovements.createdAt, today));
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
  await db.update(apiKeys).set({ active }).where(eq(apiKeys.id, id));
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
  if (filters?.status) conditions.push(eq(complaints.status, filters.status as any));
  if (filters?.type) conditions.push(eq(complaints.type, filters.type as any));
  if (filters?.vehicleId) conditions.push(eq(complaints.vehicleId, filters.vehicleId));
  if (filters?.assignedToId) conditions.push(eq(complaints.assignedToId, filters.assignedToId));
  if (filters?.projectId) conditions.push(eq(complaints.projectId, filters.projectId));
  return db.select().from(complaints).where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(desc(complaints.createdAt));
}

export async function getComplaintById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(complaints).where(eq(complaints.id, id)).limit(1);
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

export async function getComplaintStats() {
  const db = await getDb();
  if (!db) return { total: 0, new: 0, analyzing: 0, waitingClient: 0, resolved: 0, closed: 0, overdue: 0 };
  const all = await db.select().from(complaints);
  const now = new Date();
  return {
    total: all.length,
    new: all.filter(c => c.status === "new").length,
    analyzing: all.filter(c => c.status === "analyzing").length,
    waitingClient: all.filter(c => c.status === "waiting_client").length,
    resolved: all.filter(c => c.status === "resolved").length,
    closed: all.filter(c => c.status === "closed").length,
    overdue: all.filter(c => c.slaDeadline && new Date(c.slaDeadline) < now && c.status !== "resolved" && c.status !== "closed").length,
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
  const db = await getDb(); if (!db) return { total: 0, avg: 0, star1: 0, star2: 0, star3: 0, star4: 0, star5: 0, pending: 0, responded: 0, complaints: 0 };
  const all = await db.select().from(googleReviews);
  const total = all.length;
  const avg = total > 0 ? all.reduce((s, r) => s + r.rating, 0) / total : 0;
  const star1 = all.filter(r => r.rating === 1).length;
  const star2 = all.filter(r => r.rating === 2).length;
  const star3 = all.filter(r => r.rating === 3).length;
  const star4 = all.filter(r => r.rating === 4).length;
  const star5 = all.filter(r => r.rating === 5).length;
  const pending = all.filter(r => r.status === "pending_response").length;
  const responded = all.filter(r => r.status === "ai_responded" || r.status === "manually_responded").length;
  const complaints = all.filter(r => r.status === "converted_complaint").length;
  return { total, avg: Math.round(avg * 10) / 10, star1, star2, star3, star4, star5, pending, responded, complaints };
}

export async function searchClientHistory(name?: string, email?: string, plate?: string) {
  const db = await getDb(); if (!db) return { complaints: [], movements: [], reviews: [] };
  const results: any = { complaints: [], movements: [], reviews: [] };

  // Search complaints by client name/email/plate
  if (name || email || plate) {
    const conds: any[] = [];
    if (name) conds.push(like(complaints.clientName, `%${sanitizeLike(name)}%`));
    if (email) conds.push(like(complaints.clientEmail, `%${sanitizeLike(email)}%`));
    if (plate) conds.push(like(complaints.vehiclePlate, `%${sanitizeLike(plate)}%`));
    results.complaints = await db.select().from(complaints).where(or(...conds)).limit(20);
  }

  // Search vehicle movements by plate
  if (plate) {
    const vehs = await db.select().from(vehicles).where(like(vehicles.plate, `%${sanitizeLike(plate)}%`)).limit(5);
    if (vehs.length > 0) {
      results.movements = await db.select().from(vehicleMovements).where(eq(vehicleMovements.vehicleId, vehs[0].id)).orderBy(desc(vehicleMovements.createdAt)).limit(20);
    }
  }

  // Search previous reviews by name/email
  if (name || email) {
    const rConds: any[] = [];
    if (name) rConds.push(like(googleReviews.reviewerName, `%${sanitizeLike(name)}%`));
    if (email) rConds.push(like(googleReviews.reviewerEmail, `%${sanitizeLike(email)}%`));
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
  const conditions: any[] = [eq(trainingManuals.published, true)];
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
  await db.update(trainingManuals).set(data).where(eq(trainingManuals.id, id));
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

export async function createCareerExamQuestion(data: { examId: number; question: string; optionA: string; optionB: string; optionC: string; optionD: string; correctOption: "A" | "B" | "C" | "D"; explanation?: string; points?: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(careerExamQuestions).values(data).$returningId();
  return result;
}

export async function saveCareerExamAttempt(data: { examId: number; employeeId: number; totalQuestions: number; correctAnswers: number; score: number; passed: boolean; timeSpentSeconds?: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(careerExamAttempts).values(data).$returningId();
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
  if (filters?.search) {
    const q = `%${sanitizeLike(filters.search)}%`;
    conditions.push(or(
      like(lostFoundItems.clientName, q),
      like(lostFoundItems.description, q),
      like(lostFoundItems.vehiclePlate, q),
    ));
  }
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
  // Get all employees
  const { employees: empTable } = await import("../drizzle/schema");
  const allEmployees = await db.select().from(empTable);
  
  const results: any[] = [];
  for (const emp of allEmployees) {
    // Hours worked from time records
    const timeRecs = await db.select().from(timeRecords).where(eq(timeRecords.employeeId, emp.id));
    const weekRecs = timeRecs.filter(r => {
      const d = new Date(r.recordedAt);
      return getWeekNumber(d) === weekNumber && d.getFullYear() === yearNumber;
    });
    // Calculate hours from check_in/check_out pairs
    let hoursWorked = 0;
    const checkIns = weekRecs.filter(r => r.type === "check_in").sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());
    const checkOuts = weekRecs.filter(r => r.type === "check_out").sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());
    for (let i = 0; i < Math.min(checkIns.length, checkOuts.length); i++) {
      hoursWorked += Math.round((new Date(checkOuts[i].recordedAt).getTime() - new Date(checkIns[i].recordedAt).getTime()) / 3600000);
    }
    
    // Movements count
    const allMovements = await db.select().from(vehicleMovements).where(eq(vehicleMovements.employeeId, emp.id));
    const weekMovements = allMovements.filter(m => {
      const d = new Date(m.createdAt);
      return getWeekNumber(d) === weekNumber && d.getFullYear() === yearNumber;
    });
    
    // Speed alerts
    const allAlerts = await db.select().from(speedAlerts).where(eq(speedAlerts.employeeId, emp.id));
    const weekAlerts = allAlerts.filter(a => {
      const d = new Date(a.createdAt);
      return getWeekNumber(d) === weekNumber && d.getFullYear() === yearNumber;
    });
    
    // Incidents
    const empIncidents = await db.select().from(incidents).where(
      and(eq(incidents.weekNumber, weekNumber), eq(incidents.yearNumber, yearNumber))
    );
    const positiveIncidents = empIncidents.filter(i => i.reportedBy === emp.id).length;
    const negativeIncidents = empIncidents.filter(i => i.employeeId === emp.id).length;
    
    // Calculate points
    const movPerHour = hoursWorked > 0 ? Math.round(weekMovements.length / hoursWorked) : 0;
    const positivePoints = (weekMovements.length * 2) + (positiveIncidents * 5);
    const negativePoints = (weekAlerts.length * 10) + (negativeIncidents * 5);
    const totalPoints = positivePoints - negativePoints;
    
    // Check if evaluation already exists
    const existing = await db.select().from(performanceEvaluations).where(
      and(
        eq(performanceEvaluations.employeeId, emp.id),
        eq(performanceEvaluations.weekNumber, weekNumber),
        eq(performanceEvaluations.yearNumber, yearNumber)
      )
    );
    
    const evalData = {
      employeeId: emp.id,
      weekNumber,
      yearNumber,
      hoursWorked,
      movementsCount: weekMovements.length,
      movementsPerHour: movPerHour,
      speedAlerts: weekAlerts.length,
      incidentsPositive: positiveIncidents,
      incidentsNegative: negativeIncidents,
      positivePoints,
      negativePoints,
      totalPoints,
    };
    
    if (existing.length > 0) {
      await db.update(performanceEvaluations).set(evalData).where(eq(performanceEvaluations.id, existing[0].id));
      results.push({ ...evalData, id: existing[0].id, employeeName: emp.fullName });
    } else {
      const [result] = await db.insert(performanceEvaluations).values(evalData as any).$returningId();
      results.push({ ...evalData, id: result?.id, employeeName: emp.fullName });
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
    const q = `%${sanitizeLike(filters.search)}%`;
    conditions.push(or(
      like(invoices.invoiceNumber, q),
      like(invoices.clientName, q),
      like(invoices.clientNif, q)
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

export async function getBillingData(filters: { from: string; to: string; projectId?: number }) {
  const db = await getDb();
  if (!db) return { deliveries: [], expensesPaid: [], expensesPending: [], forecast: [] };

  // Resolve project hierarchy
  let projectIds: number[] | undefined;
  if (filters.projectId) {
    projectIds = await resolveProjectIds(filters.projectId);
  }

  // 1. Entregas (revenue from bookings) by project - checkout within period
  const deliveryConds: any[] = [
    gte(multiparkBookings.checkOut, new Date(filters.from)),
    lte(multiparkBookings.checkOut, new Date(filters.to + "T23:59:59")),
    isNotNull(multiparkBookings.checkOut),
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

  // 2. Despesas pagas no período
  const paidConds: any[] = [
    eq(expenses.status, "paid"),
    isNotNull(expenses.paidAt),
    gte(expenses.paidAt, new Date(filters.from)),
    lte(expenses.paidAt, new Date(filters.to + "T23:59:59")),
  ];
  if (projectIds) paidConds.push(inArray(expenses.projectId, projectIds));

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
    .where(and(...paidConds))
    .groupBy(expenses.projectId, projects.name, expenseCategories.name);

  // 3. Despesas pendentes (a pagar) no período
  const pendConds: any[] = [
    inArray(expenses.status, ["pending", "overdue"]),
    isNotNull(expenses.paymentDueDate),
    gte(expenses.paymentDueDate, new Date(filters.from)),
    lte(expenses.paymentDueDate, new Date(filters.to + "T23:59:59")),
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

  // 4. Forecast: reservas futuras (checkin no futuro mas dentro do período)
  const now = new Date();
  const forecastFrom = now > new Date(filters.from) ? now.toISOString().slice(0, 10) : filters.from;
  const forecastConds: any[] = [
    gte(multiparkBookings.checkIn, new Date(forecastFrom)),
    lte(multiparkBookings.checkIn, new Date(filters.to + "T23:59:59")),
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

  return {
    deliveries: deliveryRows,
    expensesPaid: expPaidRows,
    expensesPending: expPendRows,
    forecast: forecastRows,
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
    gte(multiparkBookings.checkOut, new Date(filters.from)),
    lte(multiparkBookings.checkOut, new Date(filters.to + "T23:59:59")),
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
    gte(multiparkBookings.checkOut, new Date(filters.from)),
    lte(multiparkBookings.checkOut, new Date(filters.to + "T23:59:59")),
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
  if (filters?.status) conditions.push(eq(partnershipInvoices.status, filters.status as any));
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
    .set({ status: "overdue" as any })
    .where(
      and(
        eq(partnershipInvoices.status, "sent" as any),
        sql`${partnershipInvoices.dueDate} < ${now}`
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
  const activePartners = allPartners.filter(p => p.status === "active").length;
  const byType: Record<string, number> = {};
  allPartners.forEach(p => { byType[p.partnerType] = (byType[p.partnerType] || 0) + 1; });

  const pendingInvoices = allInvoices.filter(i => i.status === "sent");
  const overdueInvoices = allInvoices.filter(i => i.status === "overdue");
  const paidInvoices = allInvoices.filter(i => i.status === "paid");

  const totalPending = pendingInvoices.reduce((s, i) => s + (i.amount || 0), 0);
  const totalOverdue = overdueInvoices.reduce((s, i) => s + (i.amount || 0), 0);
  const totalPaid = paidInvoices.reduce((s, i) => s + (i.amount || 0), 0);
  const totalBookings = allTx.filter(t => t.transactionType === "booking").reduce((s, t) => s + (t.amount || 0), 0);

  // Per-partner summary
  const partnerSummaries = allPartners.map(p => {
    const pInvoices = allInvoices.filter(i => i.partnershipId === p.id);
    const pTx = allTx.filter(t => t.partnershipId === p.id);
    const pending = pInvoices.filter(i => i.status === "sent").reduce((s, i) => s + (i.amount || 0), 0);
    const overdue = pInvoices.filter(i => i.status === "overdue").reduce((s, i) => s + (i.amount || 0), 0);
    const paid = pInvoices.filter(i => i.status === "paid").reduce((s, i) => s + (i.amount || 0), 0);
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

  // 1. Revenue: bookings with checkout in the year
  const revConds: any[] = [
    gte(multiparkBookings.checkOut, new Date(`${year}-01-01`)),
    lte(multiparkBookings.checkOut, new Date(`${year}-12-31T23:59:59`)),
    isNotNull(multiparkBookings.checkOut),
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

  // 2. Expenses (paid) in the year
  const expConds: any[] = [
    eq(expenses.status, "paid"),
    isNotNull(expenses.paidAt),
    gte(expenses.paidAt, new Date(`${year}-01-01`)),
    lte(expenses.paidAt, new Date(`${year}-12-31T23:59:59`)),
  ];
  if (projectIds) expConds.push(inArray(expenses.projectId, projectIds));

  const expenseRows = await db
    .select({
      month: sql<number>`MONTH(${expenses.paidAt})`,
      total: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .where(and(...expConds))
    .groupBy(sql`MONTH(${expenses.paidAt})`);

  // 3. Payroll per month (salaries + taxes)
  // TSU employer rate in Portugal: 23.75%
  const TSU_EMPLOYER = 0.2375;
  const payrollByMonth: Record<number, { salaries: number; employerTax: number }> = {};
  for (let m = 1; m <= 12; m++) {
    try {
      const payroll = await getPayrollData(year, m);
      // Filter by project if needed
      const filtered = projectIds
        ? payroll.filter(p => p.projectId && projectIds!.includes(p.projectId))
        : payroll;
      const totalSalaries = filtered.reduce((s, p) => s + p.totalPayment, 0);
      const totalEmployerTax = filtered.reduce((s, p) => {
        // TSU only on base salary + overtime, not meal allowance
        const taxableBase = p.isExtra ? p.extraPayment : (p.baseSalary + p.overtimePayment + p.nightPayment + p.weekendPayment);
        return s + taxableBase * TSU_EMPLOYER;
      }, 0);
      payrollByMonth[m] = { salaries: Math.round(totalSalaries * 100) / 100, employerTax: Math.round(totalEmployerTax * 100) / 100 };
    } catch {
      payrollByMonth[m] = { salaries: 0, employerTax: 0 };
    }
  }

  // Build monthly breakdown
  const revMap = new Map(revenueRows.map(r => [Number(r.month), Number(r.total)]));
  const expMap = new Map(expenseRows.map(e => [Number(e.month), Number(e.total)]));

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const revenueWithVat = revMap.get(m) ?? 0;
    const expensesWithVat = expMap.get(m) ?? 0;
    const salaries = payrollByMonth[m]?.salaries ?? 0;
    const employerTax = payrollByMonth[m]?.employerTax ?? 0;

    const vatRevenue = Math.round(revenueWithVat * VAT_RATE / (1 + VAT_RATE) * 100) / 100;
    const vatExpenses = Math.round(expensesWithVat * VAT_RATE / (1 + VAT_RATE) * 100) / 100;
    const vatToPay = Math.round((vatRevenue - vatExpenses) * 100) / 100;

    const revenueNoVat = Math.round((revenueWithVat - vatRevenue) * 100) / 100;
    const expensesNoVat = Math.round((expensesWithVat - vatExpenses) * 100) / 100;

    const totalCosts = expensesNoVat + salaries + employerTax;
    const profit = Math.round((revenueNoVat - totalCosts) * 100) / 100;

    months.push({
      month: m,
      revenueWithVat,
      revenueNoVat,
      vatRevenue,
      expensesWithVat,
      expensesNoVat,
      vatExpenses,
      vatToPay,
      salaries,
      employerTax,
      totalCosts,
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
  if (filters?.from) conditions.push(gte(multiparkBookings.checkIn, filters.from));
  if (filters?.to) conditions.push(lte(multiparkBookings.checkIn, filters.to));
  if (filters?.search) {
    const s = `%${sanitizeLike(filters.search)}%`;
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
    const idArr = Array.from(ids);
    conditions.push(idArr.length > 0 ? inArray(multiparkBookings.projectId, idArr) : sql`1 = 0`);
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
  const s = `%${sanitizeLike(search.trim())}%`;
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
  const existing = await db.select({ id: multiparkBookings.id }).from(multiparkBookings).where(eq(multiparkBookings.externalId, data.externalId)).limit(1);
  if (existing.length > 0) {
    const { externalId, ...updateData } = data;
    await db.update(multiparkBookings).set(updateData as any).where(eq(multiparkBookings.id, existing[0].id));
    return { id: existing[0].id, action: "updated" as const };
  } else {
    const [result] = await db.insert(multiparkBookings).values(data as any).$returningId();
    return { id: result?.id, action: "created" as const };
  }
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
    const idArr = Array.from(ids);
    projectFilter = idArr.length > 0 ? inArray(multiparkBookings.projectId, idArr) : sql`1 = 0`;
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
  if (filters?.from) conditions.push(gte(multiparkDailySnapshots.snapshotDate, filters.from));
  if (filters?.to) conditions.push(lte(multiparkDailySnapshots.snapshotDate, filters.to));
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
  if (filters?.from) conditions.push(gte(multiparkDailySnapshots.snapshotDate, filters.from));
  if (filters?.to) conditions.push(lte(multiparkDailySnapshots.snapshotDate, filters.to));
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
      gte(multiparkDailySnapshots.snapshotDate, from),
      lte(multiparkDailySnapshots.snapshotDate, to),
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
    status: "pending",
    expiresAt,
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
  await db.update(inviteTokens).set({ status: "accepted", acceptedAt: new Date() }).where(eq(inviteTokens.token, token));
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

export async function linkInviteToOAuthUser(manualUserId: number, oauthOpenId: string, oauthName?: string | null, oauthEmail?: string | null) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Update the manual user's openId to the OAuth user's openId so they can log in
  const updates: Record<string, any> = { openId: oauthOpenId, loginMethod: "oauth" };
  if (oauthName) updates.name = oauthName;
  if (oauthEmail) updates.email = oauthEmail;
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
    .where(eq(employees.isActive, true))
    .orderBy(employees.fullName);

  // Get extra rates
  const rates = await db.select().from(extraRates).orderBy(extraRates.level);
  const rateMap = new Map(rates.map(r => [r.level, parseFloat(String(r.hourlyRate))]));

  // Get time records for the month
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59);
  const records = await db.select().from(timeRecords)
    .where(and(gte(timeRecords.recordedAt, start), lte(timeRecords.recordedAt, end)));

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

  return emps.map(({ employee: emp, project }) => {
    const empHours = hoursByEmployee.get(emp.id) ?? { totalHours: 0, days: new Set(), records: [] };
    const totalHours = Math.round(empHours.totalHours * 100) / 100;
    const daysWorked = empHours.days.size;
    const isExtra = emp.position === "extra";

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
    const mealAllowancePerDay = parseFloat(String(emp.mealAllowancePerDay ?? 0));

    if (isExtra) {
      // Extras: paid by hourly rate based on their level
      const hourlyRate = rateMap.get(emp.extraLevel ?? 1) ?? 5.0;
      extraPayment = Math.round(totalHours * hourlyRate * 100) / 100;
    } else {
      // Regular employees: base salary + overtime + provisions + night/weekend
      baseSalary = parseFloat(String(emp.monthlySalary ?? 0));
      const hourlyBase = baseSalary > 0 ? baseSalary / STANDARD_MONTHLY_HOURS : 0;

      // Analyze time records for night/weekend hours
      for (const rec of empHours.records) {
        const recDate = new Date(rec.recordedAt);
        const hours = parseFloat(String(rec.hoursWorked ?? 0));
        const dayOfWeek = recDate.getDay(); // 0=Sun, 6=Sat
        const hour = recDate.getHours();

        // Weekend detection (Saturday or Sunday)
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          weekendHours += hours;
        }
        // Night work detection (22h-7h)
        if (hour >= 22 || hour < 7) {
          nightHours += hours;
        }
      }
      nightHours = Math.round(nightHours * 100) / 100;
      weekendHours = Math.round(weekendHours * 100) / 100;

      // Night payment: 25% extra on hourly base
      nightPayment = Math.round(nightHours * hourlyBase * (NIGHT_RATE_MULTIPLIER - 1) * 100) / 100;

      // Weekend payment: 50% extra on hourly base
      weekendPayment = Math.round(weekendHours * hourlyBase * (WEEKEND_RATE_MULTIPLIER - 1) * 100) / 100;

      // Overtime: hours above standard (excluding night/weekend already counted)
      const normalHours = totalHours - nightHours - weekendHours;
      if (normalHours > STANDARD_MONTHLY_HOURS) {
        overtimeHours = Math.round((normalHours - STANDARD_MONTHLY_HOURS) * 100) / 100;
        // First hour per day at 25%, subsequent at 37.5% (simplified average)
        const firstHourPortion = Math.min(overtimeHours, daysWorked); // ~1h per day worked
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

      // Meal allowance: value per day × days worked
      mealAllowance = Math.round(mealAllowancePerDay * daysWorked * 100) / 100;
    }

    // Total payment includes everything
    // Note: overtime goes as "real seguros" in the payslip but is still part of total cost
    const totalPayment = isExtra
      ? extraPayment
      : baseSalary + overtimePayment + nightPayment + weekendPayment +
        thirteenthProvision + fourteenthProvision + mealAllowance;

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
      hourlyRate: isExtra ? (rateMap.get(emp.extraLevel ?? 1) ?? 5.0) : (baseSalary > 0 ? Math.round(baseSalary / STANDARD_MONTHLY_HOURS * 100) / 100 : 0),
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
  if (filters.type) conditions.push(eq(payslipHistory.type, filters.type as any));
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
      lte(tasks.dueDate, now),
      eq(tasks.notifiedOverdue, false),
      sql`${tasks.status} != 'done'`
    ));
}

export async function getRecentlyCompletedTasks() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tasks)
    .where(and(
      eq(tasks.status, "done"),
      eq(tasks.notifiedComplete, false)
    ));
}

export async function markTaskNotified(taskId: number, field: "notifiedOverdue" | "notifiedComplete") {
  const db = await getDb();
  if (!db) return;
  await db.update(tasks).set({ [field]: true }).where(eq(tasks.id, taskId));
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
    conditions.push(gte(expenses.expenseDate, startDate));
    conditions.push(lte(expenses.expenseDate, endDate));
  } else if (year) {
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59);
    conditions.push(gte(expenses.expenseDate, startDate));
    conditions.push(lte(expenses.expenseDate, endDate));
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
    timeConditions.push(gte(timeRecords.recordedAt, startDate));
    timeConditions.push(lte(timeRecords.recordedAt, endDate));
  } else if (year) {
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59);
    timeConditions.push(gte(timeRecords.recordedAt, startDate));
    timeConditions.push(lte(timeRecords.recordedAt, endDate));
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
  return db.select().from(speedLimits).where(eq(speedLimits.isActive, true));
}

export async function getDefaultSpeedLimit() {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(speedLimits).where(eq(speedLimits.isDefault, true)).limit(1);
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
  await db.update(speedLimits).set({ ...data, updatedAt: new Date() }).where(eq(speedLimits.id, id));
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
  if (filters?.startDate) conditions.push(gte(speedViolations.occurredAt, filters.startDate));
  if (filters?.endDate) conditions.push(lte(speedViolations.occurredAt, filters.endDate));
  if (filters?.username) conditions.push(eq(speedViolations.zelloUsername, filters.username));
  if (filters?.acknowledged !== undefined) conditions.push(eq(speedViolations.acknowledged, filters.acknowledged));

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
      acknowledged: true,
      acknowledgedById: userId,
      acknowledgedAt: new Date(),
      notes: notes || null,
    })
    .where(eq(speedViolations.id, id));
}

export async function getSpeedViolationStats(startDate?: Date, endDate?: Date) {
  const db = await getDb();
  if (!db) return { total: 0, unacknowledged: 0, topOffenders: [] };

  const conditions: any[] = [];
  if (startDate) conditions.push(gte(speedViolations.occurredAt, startDate));
  if (endDate) conditions.push(lte(speedViolations.occurredAt, endDate));

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

export async function getDailyDriverHistoryByDate(dateStr: string) {
  const db = await getDb();
  if (!db) return [];
  const startOfDay = new Date(dateStr);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateStr);
  endOfDay.setHours(23, 59, 59, 999);
  return db.select().from(dailyDriverHistory)
    .where(and(gte(dailyDriverHistory.date, startOfDay), lte(dailyDriverHistory.date, endOfDay)))
    .orderBy(desc(dailyDriverHistory.totalKm));
}

export async function getDailyDriverHistoryByUser(username: string, limit = 30) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(dailyDriverHistory)
    .where(eq(dailyDriverHistory.zelloUsername, username))
    .orderBy(desc(dailyDriverHistory.date))
    .limit(limit);
}

export async function getDailyDriverHistoryRange(startDate: string, endDate: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(dailyDriverHistory)
    .where(and(
      gte(dailyDriverHistory.date, new Date(startDate)),
      lte(dailyDriverHistory.date, new Date(endDate))
    ))
    .orderBy(desc(dailyDriverHistory.date));
}

export async function getDailyDriverStats(dateStr: string) {
  const db = await getDb();
  if (!db) return { totalDrivers: 0, totalKm: 0, totalHoursWorked: 0, totalHoursStopped: 0, maxSpeedOfDay: 0, avgBattery: 0, totalViolations: 0 };
  const startOfDay = new Date(dateStr);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateStr);
  endOfDay.setHours(23, 59, 59, 999);
  const rows = await db.select().from(dailyDriverHistory)
    .where(and(gte(dailyDriverHistory.date, startOfDay), lte(dailyDriverHistory.date, endOfDay)));
  
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

export async function checkoutPda(id: number, data: { photoExitUrl?: string; mobileDataMbEnd?: number; notes?: string }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(pdaCheckins).set({
    ...data,
    checkoutAt: new Date(),
    status: "checked_out",
  }).where(eq(pdaCheckins.id, id));
}

export async function getActiveCheckins() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(pdaCheckins)
    .where(eq(pdaCheckins.status, "checked_in"))
    .orderBy(desc(pdaCheckins.checkinAt));
}

export async function getCheckinsByDate(dateStr: string) {
  const db = await getDb();
  if (!db) return [];
  const startOfDay = new Date(dateStr);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateStr);
  endOfDay.setHours(23, 59, 59, 999);
  return db.select().from(pdaCheckins)
    .where(and(gte(pdaCheckins.checkinAt, startOfDay), lte(pdaCheckins.checkinAt, endOfDay)))
    .orderBy(desc(pdaCheckins.checkinAt));
}

export async function getCheckinsByPda(pdaId: number, limit = 30) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(pdaCheckins)
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
      .where(eq(gpsAlerts.acknowledged, false))
      .orderBy(desc(gpsAlerts.occurredAt))
      .limit(opts.limit || 50);
  }
  return query;
}

export async function acknowledgeGpsAlert(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(gpsAlerts).set({
    acknowledged: true,
    acknowledgedById: userId,
    acknowledgedAt: new Date(),
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
      gte(campaignDailyStats.date, startDate),
      lte(campaignDailyStats.date, endDate),
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

export async function getBookingHistoryByBookingId(bookingId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(bookingHistory)
    .where(eq(bookingHistory.bookingId, bookingId))
    .orderBy(desc(bookingHistory.actionDate));
}

export async function getBookingHistoryByPlate(plate: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(bookingHistory)
    .where(like(bookingHistory.licensePlate, `%${sanitizeLike(plate)}%`))
    .orderBy(desc(bookingHistory.actionDate));
}

export async function searchBookingHistory(search: string) {
  const db = await getDb();
  if (!db) return [];
  const s = `%${sanitizeLike(search)}%`;
  return db.select().from(bookingHistory)
    .where(or(
      like(bookingHistory.bookingId, s),
      like(bookingHistory.licensePlate, s),
      like(bookingHistory.userName, s),
      like(bookingHistory.changeType, s),
    ))
    .orderBy(desc(bookingHistory.actionDate))
    .limit(200);
}

/** Cross-reference: for each driver in booking_history, count how many lost/found cases they touched */
export async function getBookingHistoryCrossReference() {
  const db = await getDb();
  if (!db) return [];

  // Get all lost/found items with bookingRef
  const items = await db.select().from(lostFoundItems);
  const itemsWithRef = items.filter(i => i.bookingRef && i.bookingRef.trim());
  if (itemsWithRef.length === 0) return [];

  // Get booking IDs from items
  const bookingRefs = itemsWithRef.map(i => i.bookingRef!.trim());

  // Get all history for those bookings
  const allHistory = await db.select().from(bookingHistory);
  const relevantHistory = allHistory.filter(h => bookingRefs.some(ref => h.bookingId.includes(ref) || ref.includes(h.bookingId)));

  // Count per driver: how many distinct cases they appear in
  const driverMap = new Map<string, { cases: Set<string>; plates: Set<string>; total: number; checkins: number; checkouts: number; movements: number }>();

  for (const h of relevantHistory) {
    if (!h.userName) continue;
    const driver = h.userName;
    const existing = driverMap.get(driver) || { cases: new Set(), plates: new Set(), total: 0, checkins: 0, checkouts: 0, movements: 0 };
    existing.cases.add(h.bookingId);
    if (h.licensePlate) existing.plates.add(h.licensePlate);
    existing.total++;
    if (h.changeType === "CHECK_IN") existing.checkins++;
    else if (h.changeType === "CHECK_OUT") existing.checkouts++;
    else if (h.changeType === "MOVEMENT") existing.movements++;
    driverMap.set(driver, existing);
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
    }))
    .sort((a, b) => b.caseCount - a.caseCount);
}

export async function getBookingHistoryDriverStats() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    userName: bookingHistory.userName,
    total: sql<number>`COUNT(*)`,
    checkins: sql<number>`SUM(CASE WHEN ${bookingHistory.changeType} = 'CHECK_IN' THEN 1 ELSE 0 END)`,
    checkouts: sql<number>`SUM(CASE WHEN ${bookingHistory.changeType} = 'CHECK_OUT' THEN 1 ELSE 0 END)`,
    movements: sql<number>`SUM(CASE WHEN ${bookingHistory.changeType} = 'MOVEMENT' THEN 1 ELSE 0 END)`,
  }).from(bookingHistory)
    .groupBy(bookingHistory.userName)
    .orderBy(desc(sql`COUNT(*)`));
  return rows;
}
