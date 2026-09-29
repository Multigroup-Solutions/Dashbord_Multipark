import { projectScope, bookingHistoryScope, employeeScope, userScope, partnerScope, scopedProjectIds, requireGlobalCityAccess, gpsRowScope, pdaScope, cityNameScope } from './cityScope';
import { TRPCError } from '@trpc/server';
import { buildHandoverCurrent, buildHandoverInsert, buildHandoverList, buildHandoverUpdate, handoverBoundValues, type HandoverInput, type HandoverKey } from './shiftHandoverSql';
import { decideHandoverWrite, diffHandoverFields, HANDOVER_CONFLICT_MESSAGE, HANDOVER_EXISTS_MESSAGE, operationalDayWindowUtc } from '../shared/shiftHandover';
import { mergeStoredOpenItems, parseMaterialExceptions, parseOpenItems, type OpenItem } from '../shared/shiftHandoverAuto';
import { and, asc, desc, eq, gte, lte, lt, ne, like, or, sql, aliasedTable, isNotNull, isNull, inArray, notInArray, getTableColumns, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { normalizeEmail } from "../shared/email";
import { ACCESS_VALUES, actionsToLetters, isModuleId, lettersToActions, moduleOverrideKey, normalizeGrant, overrideActive, type Access, type AccessOverrides, type ModuleId, type ModuleOverride } from "../shared/access";
import { cachedPermissionRows, type PermissionRow } from "./_core/accessContext";
import { parseClothingItems } from "../shared/clothing";
import {
  users,
  expenses,
  expenseEvents,
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
  InsertMultiparkBooking,
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
import { lisbonToday } from "../shared/expensePeriods";
import { lisbonDayRangeUtc } from "../shared/lisbonDay";
import { isoWeekYearLisbon, incidentSlaHours, addHoursUtc, utcNowStr as caseUtcNowStr, incidentCountsAgainstDriver } from "../shared/caseRules";

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
      import("./migrations/migration_0062").then(m => ({ s: m.MIGRATION_0062_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0062 })),
      import("./migrations/migration_0063").then(m => ({ s: m.MIGRATION_0063_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0063 })),
      import("./migrations/migration_0064").then(m => ({ s: m.MIGRATION_0064_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0064 })),
      import("./migrations/migration_0065").then(m => ({ s: m.MIGRATION_0065_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0065 })),
      import("./migrations/migration_0066").then(m => ({ s: m.MIGRATION_0066_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0066 })),
      import("./migrations/migration_0067").then(m => ({ s: m.MIGRATION_0067_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0067 })),
      import("./migrations/migration_0068").then(m => ({ s: m.MIGRATION_0068_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0068 })),
      import("./migrations/migration_0069").then(m => ({ s: m.MIGRATION_0069_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0069 })),
      import("./migrations/migration_0070").then(m => ({ s: m.MIGRATION_0070_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0070 })),
      import("./migrations/migration_0071").then(m => ({ s: m.MIGRATION_0071_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0071 })),
      import("./migrations/migration_0072").then(m => ({ s: m.MIGRATION_0072_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0072 })),
      import("./migrations/migration_0073").then(m => ({ s: m.MIGRATION_0073_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0073 })),
      import("./migrations/migration_0074").then(m => ({ s: m.MIGRATION_0074_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0074 })),
      import("./migrations/migration_0075").then(m => ({ s: m.MIGRATION_0075_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0075 })),
      import("./migrations/migration_0076").then(m => ({ s: m.MIGRATION_0076_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0076 })),
      import("./migrations/migration_0077").then(m => ({ s: m.MIGRATION_0077_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0077 })),
      import("./migrations/migration_0078").then(m => ({ s: m.MIGRATION_0078_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0078 })),
      import("./migrations/migration_0079").then(m => ({ s: m.MIGRATION_0079_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0079 })),
      import("./migrations/migration_0080").then(m => ({ s: m.MIGRATION_0080_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0080 })),
      import("./migrations/migration_0081").then(m => ({ s: m.MIGRATION_0081_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0081 })),
      import("./migrations/migration_0082").then(m => ({ s: m.MIGRATION_0082_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0082 })),
      import("./migrations/migration_0083").then(m => ({ s: m.MIGRATION_0083_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0083 })),
      import("./migrations/migration_0084").then(m => ({ s: m.MIGRATION_0084_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0084 })),
      import("./migrations/migration_0085").then(m => ({ s: m.MIGRATION_0085_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0085 })),
      import("./migrations/migration_0086").then(m => ({ s: m.MIGRATION_0086_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0086 })),
      import("./migrations/migration_0087").then(m => ({ s: m.MIGRATION_0087_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0087 })),
      import("./migrations/migration_0088").then(m => ({ s: m.MIGRATION_0088_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0088 })),
      import("./migrations/migration_0090").then(m => ({ s: m.MIGRATION_0090_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0090 })),
      import("./migrations/migration_0091").then(m => ({ s: m.MIGRATION_0091_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0091 })),
      import("./migrations/migration_0092").then(m => ({ s: m.MIGRATION_0092_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0092 })),
      import("./migrations/migration_0093").then(m => ({ s: m.MIGRATION_0093_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0093 })),
      import("./migrations/migration_0094").then(m => ({ s: m.MIGRATION_0094_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0094 })),
      import("./migrations/migration_0095").then(m => ({ s: m.MIGRATION_0095_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0095 })),
      import("./migrations/migration_0096").then(m => ({ s: m.MIGRATION_0096_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0096 })),
      import("./migrations/migration_0097").then(m => ({ s: m.MIGRATION_0097_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0097 })),
      import("./migrations/migration_0098").then(m => ({ s: m.MIGRATION_0098_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0098 })),
      import("./migrations/migration_0099").then(m => ({ s: m.MIGRATION_0099_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0099 })),
      import("./migrations/migration_0100").then(m => ({ s: m.MIGRATION_0100_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0100 })),
      import("./migrations/migration_0101").then(m => ({ s: m.MIGRATION_0101_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0101 })),
      import("./migrations/migration_0105").then(m => ({ s: m.MIGRATION_0105_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0105 })),
      import("./migrations/migration_0110").then(m => ({ s: m.MIGRATION_0110_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0110 })),
      import("./migrations/migration_0111").then(m => ({ s: m.MIGRATION_0111_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0111 })),
      import("./migrations/migration_0115").then(m => ({ s: m.MIGRATION_0115_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0115 })),
      import("./migrations/migration_0123").then(m => ({ s: m.MIGRATION_0123_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0123 })),
      import("./migrations/migration_0125").then(m => ({ s: m.MIGRATION_0125_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0125 })),
      import("./migrations/migration_0130").then(m => ({ s: m.MIGRATION_0130_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0130 })),
      import("./migrations/migration_0138").then(m => ({ s: m.MIGRATION_0138_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0138 })),
      import("./migrations/migration_0140").then(m => ({ s: m.MIGRATION_0140_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0140 })),
      import("./migrations/migration_0145").then(m => ({ s: m.MIGRATION_0145_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0145 })),
      import("./migrations/migration_0150").then(m => ({ s: m.MIGRATION_0150_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0150 })),
      import("./migrations/migration_0155").then(m => ({ s: m.MIGRATION_0155_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0155 })),
      import("./migrations/migration_0160").then(m => ({ s: m.MIGRATION_0160_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0160 })),
      import("./migrations/migration_0165").then(m => ({ s: m.MIGRATION_0165_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0165 })),
      import("./migrations/migration_0170").then(m => ({ s: m.MIGRATION_0170_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0170 })),
      import("./migrations/migration_0175").then(m => ({ s: m.MIGRATION_0175_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0175 })),
      import("./migrations/migration_0180").then(m => ({ s: m.MIGRATION_0180_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0180 })),
      import("./migrations/migration_0185").then(m => ({ s: m.MIGRATION_0185_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0185 })),
      import("./migrations/migration_0190").then(m => ({ s: m.MIGRATION_0190_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0190 })),
      import("./migrations/migration_0195").then(m => ({ s: m.MIGRATION_0195_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0195 })),
      import("./migrations/migration_0200").then(m => ({ s: m.MIGRATION_0200_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0200 })),
      import("./migrations/migration_0205").then(m => ({ s: m.MIGRATION_0205_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0205 })),
      import("./migrations/migration_0210").then(m => ({ s: m.MIGRATION_0210_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0210 })),
      import("./migrations/migration_0215").then(m => ({ s: m.MIGRATION_0215_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0215 })),
      import("./migrations/migration_0220").then(m => ({ s: m.MIGRATION_0220_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0220 })),
      import("./migrations/migration_0225").then(m => ({ s: m.MIGRATION_0225_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0225 })),
      import("./migrations/migration_0230").then(m => ({ s: m.MIGRATION_0230_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0230 })),
      import("./migrations/migration_0235").then(m => ({ s: m.MIGRATION_0235_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0235 })),
      import("./migrations/migration_0240").then(m => ({ s: m.MIGRATION_0240_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0240 })),
      import("./migrations/migration_0245").then(m => ({ s: m.MIGRATION_0245_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0245 })),
      import("./migrations/migration_0250").then(m => ({ s: m.MIGRATION_0250_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0250 })),
      import("./migrations/migration_0255").then(m => ({ s: m.MIGRATION_0255_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0255 })),
      import("./migrations/migration_0260").then(m => ({ s: m.MIGRATION_0260_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0260 })),
      import("./migrations/migration_0265").then(m => ({ s: m.MIGRATION_0265_STATEMENTS, ok: m.IDEMPOTENT_ERROR_CODES_0265 })),
    ]);
    for (const { s, ok } of mods) {
      for (const stmt of s) {
        try {
          await db.execute(sql.raw(stmt));
        } catch (err: any) {
          // O drizzle embrulha o erro do mysql2 (DrizzleQueryError) — o código
          // MySQL vem em `cause.code`; sem isto TODAS as migrações já aplicadas
          // faziam warning em cada arranque.
          const code = err?.code ?? err?.cause?.code;
          if (!(code && ok.has(code))) {
            console.warn("[Schema ensure]", code ?? "ERR", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
          }
        }
      }
    }
  } catch (err: any) {
    console.warn("[Schema ensure] falhou:", String(err?.message ?? err).slice(0, 160));
  }
  // Passos de DADOS (código, uma vez, guardados por marca) — depois do SQL.
  try {
    const { runMigration0210Data } = await import("./migrations/migration_0210");
    const r = await runMigration0210Data(db as any);
    if (r.status === "applied" && r.patches.length) console.log("[Schema ensure] 0210 caixas de email:", r.patches.map((p) => `${p.mailboxKey} (${p.changes.join("; ")})`).join(" · ").slice(0, 500));
  } catch (err: any) {
    console.warn("[Schema ensure] 0210 (dados das caixas de email) falhou:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
  }
  try {
    const { runMigration0215Collation } = await import("./migrations/migration_0215");
    const converted = await runMigration0215Collation(db as any);
    if (converted.length) console.log("[Schema ensure] 0215 CRM: collation igual à de multipark_bookings em", converted.join(", "));
  } catch (err: any) {
    console.warn("[Schema ensure] 0215 (collation do CRM) falhou:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
  }
  try {
    // (Remetente de sistema lido pela própria migração — getSetting usaria
    // getDb(), que espera por ESTE ensureRecentSchema.)
    const { runMigration0230Data } = await import("./migrations/migration_0230");
    const r = await runMigration0230Data(db as any);
    if (r.status === "applied" && r.messages) console.log(`[Schema ensure] 0230 envios automáticos: ${r.messages} mensagem(ns), ${r.threads} conversa(s) escondida(s)/recalculada(s), ${r.sends} envio(s) na ficha dos extras`);
  } catch (err: any) {
    console.warn("[Schema ensure] 0230 (envios automáticos na Comunicação) falhou:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
  }
}

// MySQL timestamp(mode:string) helper — converte Date para "YYYY-MM-DD HH:MM:SS"
export function toMysqlDateTime(d: Date | string | null | undefined): string {
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
  const accounts = await db.select().from(users).where(userScope(users.id)).orderBy(desc(users.createdAt));
  if (!accounts.length) return [];
  // Return only navigation data, and only employee records in the viewer's cities.
  // Keep every linked record visible so duplicate links are never chosen silently.
  const links = await db.select({ id: employees.id, userId: employees.userId,
    fullName: employees.fullName, isActive: employees.isActive, projectName: projects.name })
    .from(employees).leftJoin(projects, eq(projects.id, employees.projectId))
    .where(and(inArray(employees.userId, accounts.map(u => u.id)), projectScope(employees.projectId)))
    .orderBy(desc(employees.isActive), asc(employees.id));
  const byUser = new Map<number, typeof links>();
  for (const person of links) {
    if (person.userId != null) byUser.set(person.userId, [...(byUser.get(person.userId) ?? []), person]);
  }
  return accounts.map(account => ({ ...account, employees: byUser.get(account.id) ?? [] }));
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
  // A ficha com o mesmo email é desta pessoa → fica ligada (regra do Jorge,
  // 2026-09-10). Import dinâmico: identity.ts importa este módulo.
  if (result[0]) {
    try {
      const { linkEmployeesToUserByEmail } = await import("./identity");
      await linkEmployeesToUserByEmail(db, result[0].id, email);
    } catch (err) {
      console.warn("[Users] Falha a ligar ficha por email:", String((err as Error)?.message ?? err).slice(0, 160));
    }
  }
  return result[0];
}

export async function updateUser(userId: number, data: { name?: string; email?: string; role?: string; department?: string | null; isActive?: boolean }, opts: { relinkEmployees?: boolean } = {}) {
  const db = await getDb();
  if (!db) return;
  const updates: Record<string, any> = {};
  if (data.name !== undefined) updates.name = data.name;
  // Email é a chave de identidade → gravado sempre na forma canónica.
  if (data.email !== undefined) updates.email = normalizeEmail(data.email);
  if (data.role !== undefined) updates.role = data.role;
  if (data.department !== undefined) updates.department = data.department;
  if (data.isActive !== undefined) {
    updates.isActive = data.isActive ? 1 : 0;
    // Quem muda o estado por aqui segue a mesma regra do botão: reativar limpa
    // o motivo, desativar sem motivo fica em branco (ver 0071).
    Object.assign(updates, deactivationColumns(data.isActive));
  }
  if (Object.keys(updates).length > 0) {
    await db.update(users).set(updates).where(eq(users.id, userId));
  }
  // Fase 1: email novo → liga fichas com esse email que ainda não têm conta
  // (nunca a partir de uma auto-edição — ver users.update).
  if (updates.email && opts.relinkEmployees !== false) {
    try {
      const { linkEmployeesToUserByEmail } = await import("./identity");
      await linkEmployeesToUserByEmail(db as any, userId, updates.email);
    } catch (err) { console.warn("[updateUser] religar fichas:", err); }
  }
}

/**
 * Motivo + notas da desativação, já validados por `resolveDeactivation`
 * (shared/deactivationReasons.ts). `byUserId` = quem carregou no botão.
 */
export type DeactivationRecord = {
  reason: string | null;
  reasonOther: string | null;
  notes: string | null;
  byUserId?: number | null;
};

/** Colunas de desativação (partilhadas por `users` e `employees`, 0071). */
export function deactivationColumns(isActive: boolean, meta?: DeactivationRecord | null) {
  // Reativar LIMPA o motivo: as colunas descrevem a desativação ACTUAL. O que
  // aconteceu antes continua em `activity_logs`.
  if (isActive) {
    return {
      deactivationReason: null,
      deactivationReasonOther: null,
      deactivationNotes: null,
      deactivatedAt: null,
      deactivatedById: null,
    };
  }
  return {
    deactivationReason: meta?.reason ?? null,
    deactivationReasonOther: meta?.reasonOther ?? null,
    deactivationNotes: meta?.notes ?? null,
    deactivatedAt: toMysqlDateTime(new Date()),
    deactivatedById: meta?.byUserId ?? null,
  };
}

export async function toggleUserActive(userId: number, isActive: boolean, meta?: DeactivationRecord | null) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(users)
    .set({ isActive: isActive ? 1 : 0, ...deactivationColumns(isActive, meta) })
    .where(eq(users.id, userId));
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

const buyerEmployees = aliasedTable(employees, "buyer");

/**
 * Lista de despesas com joins. O `where` vem SEMPRE de
 * `expenseConditions()` (server/expenseScope.ts) — filtros + visibilidade do
 * utilizador numa regra única partilhada por lista, Excel e comparação.
 */
export async function listExpenses(where?: SQL) {
  const db = await getDb();
  if (!db) return [];
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
    .orderBy(desc(expenses.expenseDate), desc(expenses.id));
  return where ? query.where(where) : query;
}

/** Agregados de um conjunto de despesas (mesmo `where` da lista). */
export async function summarizeExpenses(where?: SQL) {
  const db = await getDb();
  const empty = { total: 0, count: 0, cancelledTotal: 0, cancelledCount: 0, byCategory: [] as Array<{ categoryId: number | null; total: number; count: number }> };
  if (!db) return empty;
  const live = where ? and(where, sql`${expenses.status} <> 'cancelled'`) : sql`${expenses.status} <> 'cancelled'`;
  const cancelled = where ? and(where, eq(expenses.status, "cancelled")) : eq(expenses.status, "cancelled");
  const [tot] = await db
    .select({ total: sql<string>`COALESCE(SUM(${expenses.amount}), 0)`, count: sql<number>`COUNT(*)` })
    .from(expenses).where(live);
  const [canc] = await db
    .select({ total: sql<string>`COALESCE(SUM(${expenses.amount}), 0)`, count: sql<number>`COUNT(*)` })
    .from(expenses).where(cancelled);
  const byCat = await db
    .select({ categoryId: expenses.categoryId, total: sql<string>`COALESCE(SUM(${expenses.amount}), 0)`, count: sql<number>`COUNT(*)` })
    .from(expenses).where(live)
    .groupBy(expenses.categoryId)
    .orderBy(desc(sql`SUM(${expenses.amount})`));
  return {
    total: Number(tot?.total ?? 0), count: Number(tot?.count ?? 0),
    cancelledTotal: Number(canc?.total ?? 0), cancelledCount: Number(canc?.count ?? 0),
    byCategory: byCat.map((r) => ({ categoryId: r.categoryId ?? null, total: Number(r.total), count: Number(r.count) })),
  };
}

/** Histórico (autor, data, antes/depois) de cada alteração relevante. */
export async function recordExpenseEvent(ev: {
  expenseId: number; type: string; userId?: number | null;
  before?: unknown; after?: unknown; note?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(expenseEvents).values({
      expenseId: ev.expenseId, type: ev.type, userId: ev.userId ?? null,
      before: ev.before === undefined ? null : JSON.stringify(ev.before),
      after: ev.after === undefined ? null : JSON.stringify(ev.after),
      note: ev.note ?? null,
    });
  } catch (err: any) {
    console.warn("[expenses] evento não gravado:", String(err?.message ?? err).slice(0, 120));
  }
}

export async function getExpenseEvents(expenseId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ event: expenseEvents, user: { id: users.id, name: users.name } })
    .from(expenseEvents)
    .leftJoin(users, eq(expenseEvents.userId, users.id))
    .where(eq(expenseEvents.expenseId, expenseId))
    .orderBy(desc(expenseEvents.createdAt), desc(expenseEvents.id));
}

/**
 * Possível duplicado: mesmo nº de documento do mesmo fornecedor (NIF ou nome),
 * ou o MESMO ficheiro. Nunca por valor+data (compras legítimas repetem-se).
 */
export async function findPossibleDuplicateExpense(input: {
  excludeId?: number | null;
  supplierNif?: string | null; supplier?: string | null;
  documentNumber?: string | null; invoiceImageKey?: string | null;
}) {
  const db = await getDb();
  if (!db) return null;
  const conds: SQL[] = [];
  const doc = input.documentNumber?.trim();
  if (doc) {
    const bySupplier: SQL[] = [];
    if (input.supplierNif?.trim()) bySupplier.push(eq(expenses.supplierNif, input.supplierNif.trim()));
    if (input.supplier?.trim()) bySupplier.push(eq(expenses.supplier, input.supplier.trim()));
    if (bySupplier.length) conds.push(and(eq(expenses.documentNumber, doc), or(...bySupplier) as SQL) as SQL);
  }
  if (input.invoiceImageKey) conds.push(eq(expenses.invoiceImageKey, input.invoiceImageKey));
  if (!conds.length) return null;
  let where: SQL = and(or(...conds), projectScope(expenses.projectId)) as SQL;
  if (input.excludeId) where = and(where, sql`${expenses.id} <> ${input.excludeId}`) as SQL;
  const rows = await db
    .select({ id: expenses.id, supplier: expenses.supplier, amount: expenses.amount, expenseDate: expenses.expenseDate, documentNumber: expenses.documentNumber, status: expenses.status, insertedById: expenses.insertedById, projectId: expenses.projectId })
    .from(expenses).where(where).orderBy(desc(expenses.id)).limit(1);
  return rows[0] ?? null;
}

export async function projectExists(id: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return true;
  const r = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1);
  return r.length > 0;
}

export async function categoryExists(id: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return true;
  const r = await db.select({ id: expenseCategories.id }).from(expenseCategories).where(eq(expenseCategories.id, id)).limit(1);
  return r.length > 0;
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
    .where(and(eq(expenses.id, id), projectScope(expenses.projectId)))
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

  // Dias de calendário em Lisboa; semana começa à segunda. Canceladas fora,
  // como na lista, no Excel e nas Finanças (shared/expenseTotals).
  const today = lisbonToday();
  const [ty, tm, td] = today.split("-").map(Number);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const todayUtc = new Date(Date.UTC(ty, tm - 1, td));
  const monday = new Date(todayUtc);
  monday.setUTCDate(td - ((todayUtc.getUTCDay() + 6) % 7));
  const startOfDay = `${today} 00:00:00`;
  const startOfWeek = `${iso(monday)} 00:00:00`;
  const startOfMonth = `${today.slice(0, 7)}-01 00:00:00`;
  const startOfYear = `${ty}-01-01 00:00:00`;
  const trendStart = `${iso(new Date(Date.UTC(ty, tm - 1 - 5, 1)))} 00:00:00`;
  const live = ne(expenses.status, "cancelled");

  const [daily, weekly, monthly, yearly, byCategory, byProject, byUser, pending, overdue, paidYear] =
    await Promise.all([
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(and(projectScope(expenses.projectId), live, gte(expenses.expenseDate, startOfDay))),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(and(projectScope(expenses.projectId), live, gte(expenses.expenseDate, startOfWeek))),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(and(projectScope(expenses.projectId), live, gte(expenses.expenseDate, startOfMonth))),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(and(projectScope(expenses.projectId), live, gte(expenses.expenseDate, startOfYear))),
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
        .where(and(projectScope(expenses.projectId), live, gte(expenses.expenseDate, startOfMonth)))
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
        .where(and(projectScope(expenses.projectId), live, gte(expenses.expenseDate, startOfMonth)))
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
        .where(and(projectScope(expenses.projectId), live, gte(expenses.expenseDate, startOfMonth)))
        .groupBy(expenses.insertedById, users.name)
        .orderBy(desc(sql`SUM(expenses.amount)`))
        .limit(5),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(and(projectScope(expenses.projectId), eq(expenses.status, "pending"))),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(and(projectScope(expenses.projectId), eq(expenses.status, "overdue"))),
      db
        .select({ total: sql<string>`COALESCE(SUM(amount), 0)`, count: sql<number>`COUNT(*)` })
        .from(expenses)
        .where(and(projectScope(expenses.projectId), eq(expenses.status, "paid"), gte(expenses.expenseDate, startOfYear))),
    ]);

  // Monthly trend (last 6 months)
  const monthlyTrend = await db
    .select({
      month: sql<string>`DATE_FORMAT(expenseDate, '%Y-%m')`,
      total: sql<string>`COALESCE(SUM(amount), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(expenses)
    .where(and(projectScope(expenses.projectId), live, gte(expenses.expenseDate, trendStart)))
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
    paidYear: { total: parseFloat(paidYear[0]?.total || "0"), count: paidYear[0]?.count || 0 },
    monthlyTrend: monthlyTrend.map((m) => ({ ...m, total: parseFloat(m.total || "0") })),
  };
}

export async function getUpcomingPayments(daysAhead = 7) {
  const db = await getDb();
  if (!db) return [];
  const today = lisbonToday();
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + daysAhead);

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
        projectScope(expenses.projectId),
        gte(expenses.paymentDueDate, `${today} 00:00:00`),
        lte(expenses.paymentDueDate, `${end.toISOString().slice(0, 10)} 23:59:59`)
      )
    )
    .orderBy(expenses.paymentDueDate);
}

export async function getOverdueExpenses() {
  const db = await getDb();
  if (!db) return [];
  const today = lisbonToday();
  return db
    .select({ expense: expenses, insertedBy: users })
    .from(expenses)
    .leftJoin(users, eq(expenses.insertedById, users.id))
    .where(and(projectScope(expenses.projectId), eq(expenses.status, "pending"), lt(expenses.paymentDueDate, `${today} 00:00:00`)));
}

export async function markOverdueExpenses() {
  const db = await getDb();
  if (!db) return;
  // Vence hoje ≠ em atraso: só passa a atraso no dia seguinte (dia de Lisboa)
  const today = lisbonToday();
  await db
    .update(expenses)
    .set({ status: "overdue" })
    .where(and(projectScope(expenses.projectId), eq(expenses.status, "pending"), lt(expenses.paymentDueDate, `${today} 00:00:00`)));
}

// ─── ACTIVITY LOGS ────────────────────────────────────────────────────────────

export async function logActivity(data: InsertActivityLog) {
  const db = await getDb();
  if (!db) return;
  await db.insert(activityLogs).values(data);
}

export async function getActivityLogs(limit = 100, filters: {
  entity?: string; action?: string; userId?: number;
  /** "YYYY-MM-DD HH:MM:SS" (UTC), inclusivo. */
  from?: string;
  /** "YYYY-MM-DD HH:MM:SS" (UTC), exclusivo. */
  to?: string;
  /** Pesquisa no servidor (LIKE parametrizado) em detalhes/ação/entidade/nome. */
  search?: string;
} = {}) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [];
  if (filters.entity) conds.push(eq(activityLogs.entity, filters.entity));
  if (filters.action) conds.push(eq(activityLogs.action, filters.action));
  if (filters.userId) conds.push(eq(activityLogs.userId, filters.userId));
  if (filters.from) conds.push(gte(activityLogs.createdAt, filters.from));
  if (filters.to) conds.push(lt(activityLogs.createdAt, filters.to));
  const q = (filters.search ?? "").trim();
  if (q) {
    // Escapa os curingas do LIKE: a pesquisa é literal.
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(or(like(activityLogs.details, pattern), like(activityLogs.action, pattern), like(activityLogs.entity, pattern), like(users.name, pattern)));
  }
  // Só as colunas do utilizador que a página mostra (nunca o registo inteiro).
  return db
    .select({ log: activityLogs, user: { id: users.id, name: users.name, email: users.email } })
    .from(activityLogs)
    .leftJoin(users, eq(activityLogs.userId, users.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(activityLogs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 2000));
}

/** Entidades distintas presentes no registo (para o filtro da página de Logs). */
export async function getActivityLogEntities(): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.selectDistinct({ entity: activityLogs.entity }).from(activityLogs).orderBy(asc(activityLogs.entity));
  return rows.map((r) => r.entity).filter(Boolean);
}

/**
 * Retenção: apaga registos com mais de 12 meses em lotes de 5000
 * (`DELETE … WHERE createdAt < ? LIMIT n` — sem subquery sobre a própria
 * tabela). Chamado pelo daily-ops; o que não couber no prazo fica para o dia
 * seguinte.
 */
export async function purgeOldActivityLogs(opts: { deadlineAt?: number; now?: Date } = {}) {
  const db = await getDb();
  if (!db) return { deleted: 0, batches: 0, done: true, cutoff: null as string | null };
  const { activityLogCutoff, purgeInBatches } = await import("./opsRules");
  const { extractAffectedRows } = await import("./availabilityFormToken");
  const cutoff = activityLogCutoff(opts.now ?? new Date());
  const r = await purgeInBatches(async (limit) => {
    const res = await db.execute(sql`DELETE FROM activity_logs WHERE createdAt < ${cutoff} LIMIT ${sql.raw(String(Math.max(1, Math.floor(limit))))}`);
    return extractAffectedRows(res);
  }, { deadlineAt: opts.deadlineAt });
  return { ...r, cutoff };
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

/**
 * Descobre o utilizador Zello que um funcionário usou num turno.
 * Regra do Jorge: os "Extra NNN" do Zello vivem nos PDAs e CADA DIA o PDA anda
 * com uma pessoa diferente — a fonte da verdade é o check-in do PDA desse dia,
 * não uma ligação fixa na ficha. Fallback: employees.zelloUsername (telemóveis
 * pessoais, ex. team leaders).
 */
export async function resolveZelloUsernameForShift(employeeId: number, start: Date, end: Date): Promise<string | null> {
  const db = await getDb(); if (!db) return null;
  const startS = toMysqlDateTime(start);
  const endS = toMysqlDateTime(end);
  const [rows] = await db.execute(sql`
    SELECT COALESCE(p.zelloUsername, c.zelloUsername) AS zu
    FROM pda_checkins c
    LEFT JOIN pdas p ON p.id = c.pdaId
    WHERE c.employeeId = ${employeeId}
      AND c.checkinAt <= ${endS}
      AND (c.checkoutAt IS NULL OR c.checkoutAt >= ${startS})
      AND COALESCE(p.zelloUsername, c.zelloUsername) IS NOT NULL
    ORDER BY c.checkinAt DESC LIMIT 1`) as any;
  if (rows?.[0]?.zu) return String(rows[0].zu);
  const emp = await getEmployeeById(employeeId);
  return emp?.employee?.zelloUsername ?? null;
}

/**
 * Resolução Zello→pessoa para o mapa ao vivo: primeiro os check-ins de PDA
 * ATIVOS (dinâmico, muda todos os dias), depois as ligações fixas da ficha.
 */
export async function getZelloLiveMappings(): Promise<Array<{ zelloUsername: string; employeeId: number; fullName: string; source: "pda" | "fixed"; pdaName: string | null }>> {
  const db = await getDb(); if (!db) return [];
  const [fixed] = await db.execute(sql`
    SELECT zelloUsername, id AS employeeId, fullName FROM employees
    WHERE zelloUsername IS NOT NULL AND zelloUsername != ''`) as any;
  const [pda] = await db.execute(sql`
    SELECT COALESCE(p.zelloUsername, c.zelloUsername) AS zelloUsername,
           e.id AS employeeId, e.fullName, p.name AS pdaName
    FROM pda_checkins c
    JOIN employees e ON e.id = c.employeeId
    LEFT JOIN pdas p ON p.id = c.pdaId
    WHERE c.checkin_status = 'checked_in'
      AND COALESCE(p.zelloUsername, c.zelloUsername) IS NOT NULL`) as any;
  const out: Array<{ zelloUsername: string; employeeId: number; fullName: string; source: "pda" | "fixed"; pdaName: string | null }> = [];
  for (const r of (fixed as any[]) ?? []) {
    out.push({ zelloUsername: String(r.zelloUsername), employeeId: Number(r.employeeId), fullName: String(r.fullName), source: "fixed", pdaName: null });
  }
  for (const r of (pda as any[]) ?? []) {
    out.push({ zelloUsername: String(r.zelloUsername), employeeId: Number(r.employeeId), fullName: String(r.fullName), source: "pda", pdaName: r.pdaName ? String(r.pdaName) : null });
  }
  return out;
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
  if (result[0]) return result[0];
  // Conta EXTRA (ex.: email pessoal além do profissional) → a mesma ficha
  const { employeeIdForAliasUser } = await import("./employeeAliases");
  const empId = await employeeIdForAliasUser(userId);
  if (empId == null) return undefined;
  const alias = await db.select({ employee: employees, project: projects }).from(employees)
    .leftJoin(projects, eq(employees.projectId, projects.id))
    .where(eq(employees.id, empId)).limit(1);
  return alias[0];
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
    // pendentes (possíveis faltas por validar) NÃO contam pontos
    .where(and(isNull(employeePenalties.clearedAt), eq(employeePenalties.status, "confirmed")))
    .groupBy(employeePenalties.employeeId);
  return new Map(rows.map(r => [r.employeeId, Number(r.totalPoints)]));
}

export async function clearPenalty(id: number, clearedById: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [p] = await db.select({ employeeId: employeePenalties.employeeId }).from(employeePenalties).where(eq(employeePenalties.id, id)).limit(1);
  await db
    .update(employeePenalties)
    .set({ clearedAt: toMysqlDateTime(new Date()), clearedById })
    .where(eq(employeePenalties.id, id));
  // limpar pontos pode levantar o bloqueio por faltas (só esse motivo)
  if (p) {
    const { confirmedOpenPoints, recomputeLoginBlocked } = await import("./rhService");
    const points = await confirmedOpenPoints(p.employeeId);
    await db.update(employees).set({ blockedByPenalties: points >= 3 ? 1 : 0 }).where(eq(employees.id, p.employeeId));
    await recomputeLoginBlocked(p.employeeId);
  }
}

/** Levanta bloqueio de login de um colaborador (apaga loginBlocked + flag) */
export async function unblockEmployeeLogin(employeeId: number, clearedById: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // desbloqueio manual limpa os TRÊS motivos (docs / faltas / manual)
  await db
    .update(employees)
    .set({ loginBlocked: 0, loginBlockedReason: null, docsWarningAt: null, blockedByDocs: 0, blockedByPenalties: 0, blockedManually: 0 })
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
  // SUSPENSO (Jorge 6 ago 2026: "até estar tudo operacional, retira o bloqueio
  // dos documentos") — o AVISO mantém-se; o bloqueio de login não é aplicado.
  // Para reativar: repor este bloco (git log) e limpar loginBlocked=0 antes.
  if (daysSinceStart >= 21) {
    if (emp.loginBlocked) {
      await db.update(employees)
        .set({ loginBlocked: 0, loginBlockedReason: null })
        .where(eq(employees.id, employeeId));
    }
    return { blocked: false, warning: true, missingDocs, daysSinceStart };
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

  // Penalizações abertas CONFIRMADAS por empId + estado real de bloqueio
  const penaltiesByEmp = await getAllOpenPenaltiesByEmployee();
  const blockedRows = await db.select({ id: employees.id, loginBlocked: employees.loginBlocked, loginBlockedReason: employees.loginBlockedReason, blockedByDocs: employees.blockedByDocs, blockedByPenalties: employees.blockedByPenalties, blockedManually: employees.blockedManually }).from(employees);
  const blockedById = new Map(blockedRows.map((b) => [b.id, b]));
  // Pagamentos CONFIRMADOS (fechos aprovados/pagos) — o que "recebido" deve significar
  const { paidTotalsLookback } = await import("./rhService");
  const paidMap = await paidTotalsLookback(currentPayroll.map((r: any) => r.employeeId), lookback);

  // Agrega
  const out: any[] = [];
  for (const row of currentPayroll) {
    const empId = row.employeeId;
    const blk = blockedById.get(empId);
    const paid = paidMap.get(empId) ?? { paid: 0, approved: 0 };
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
      // "Recebido" = APURADO nos meses anteriores (estimativa); pago/aprovado vêm dos fechos
      totalReceivedLookback: Math.round(totalReceived * 100) / 100,
      totalPaidLookback: Math.round(paid.paid * 100) / 100,
      totalApprovedLookback: Math.round(paid.approved * 100) / 100,
      avgPerHourLookback: Math.round(avgPerHour * 100) / 100,
      openPenaltyPoints: openPoints,
      loginBlocked: Boolean(blk?.loginBlocked),
      blockedBy: { docs: Boolean(blk?.blockedByDocs), penalties: Boolean(blk?.blockedByPenalties), manual: Boolean(blk?.blockedManually) },
      loginBlockedReason: blk?.loginBlockedReason ?? null,
      warnings: (row as any).warnings ?? [],
      suspiciousHours: (row as any).suspiciousHours ?? 0,
      severity: blk?.loginBlocked ? "red" : openPoints >= 3 ? "red" : openPoints >= 1 || ((row as any).suspiciousShifts ?? 0) > 0 ? "yellow" : "ok",
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
  // Os 4 níveis canónicos (= migração 0044 e server/extraRates.ts). Antes
  // tinha 5 níveis com valores antigos e INVERTIDOS (nível 1 = 8,50 €).
  const defaults = [
    { level: 1, levelName: "junior", hourlyRate: "4.50", label: "Extra Junior" },
    { level: 2, levelName: "senior", hourlyRate: "5.00", label: "Extra Senior" },
    { level: 3, levelName: "terminal", hourlyRate: "5.50", label: "Extra Terminal" },
    { level: 4, levelName: "master", hourlyRate: "6.00", label: "Extra Master" },
  ];
  await db.insert(extraRates).values(defaults);
}

export async function updateExtraRate(level: number, hourlyRate: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(extraRates).set({ hourlyRate }).where(eq(extraRates.level, level));
  (await import("./extraRates")).invalidateExtraRates();
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

/** Apagar DEFINITIVAMENTE um único nó. Só é chamado depois de o router
 * confirmar zero filhos e zero referências (ver shared/projectTree.ts). */
export async function deleteProject(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
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
  // Não pode ir para si próprio nem para um descendente. Termina sempre,
  // mesmo que a árvore já tenha um ciclo (visitados em shared/projectTree).
  if (newParentId === id) throw new Error("Não pode mover para si próprio");
  const { wouldCreateCycle } = await import("../shared/projectTree");
  const all = await db.select({ id: projects.id, name: projects.name, level: projects.level, parentId: projects.parentId }).from(projects);
  if (wouldCreateCycle(id, newParentId, new Map(all.map(p => [p.id, p])))) {
    throw new Error("Não pode mover para um descendente");
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

/** Filtro por projeto HIERÁRQUICO (nó + descendentes; id negativo = marca em
 * todas as cidades) + âmbito de cidade do utilizador. `allowNull`: registos
 * sem projeto continuam visíveis (ex.: tarefas transversais). */
export async function projectFilterConds(column: any, projectId: number | undefined, opts: { allowNull?: boolean } = {}): Promise<any[]> {
  const conds: any[] = [opts.allowNull ? sql`(${column} IS NULL OR ${projectScope(column)})` : projectScope(column)];
  if (projectId) {
    const ids = await resolveProjectIds(projectId);
    conds.push(ids.length ? inArray(column, ids) : sql`1 = 0`);
  }
  return conds;
}

export async function getTasks(filters?: {
  projectId?: number;
  assigneeId?: number;
  status?: string;
}) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = await projectFilterConds(tasks.projectId, filters?.projectId, { allowNull: true });
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
  // Apaga também os responsáveis e os comentários (antes ficavam órfãos).
  const { deleteTaskCascade } = await import("./tasksService");
  await deleteTaskCascade(id);
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
  const conds: any[] = await projectFilterConds(tasks.projectId, filters?.projectId, { allowNull: true });
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
  // COUNT/GROUP BY em SQL (antes carregava a tabela inteira para memória).
  const { taskStats } = await import("./tasksService");
  return taskStats();
}

// ─── OPERACIONAL: VEHICLES ──────────────────────────────────────────────────

export async function getVehicles(filters?: { status?: string; projectId?: number }) {
  const db = await getDb();
  if (!db) return [];
  let query = db.select().from(vehicles).orderBy(desc(vehicles.createdAt));
  const conditions: any[] = await projectFilterConds(vehicles.projectId, filters?.projectId);
  if (filters?.status) conditions.push(eq(vehicles.vehicleStatus, filters.status as any));
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
  // Cidade: a do condutor; sem condutor, a de quem transcreveu.
  const conditions: any[] = [sql`((${radioTranscriptions.employeeId} IS NOT NULL AND ${employeeScope(radioTranscriptions.employeeId)})
    OR (${radioTranscriptions.employeeId} IS NULL AND ${userScope(radioTranscriptions.createdById)}))`];
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

/** Lista para a UI: NUNCA devolve a chave nem o hash — só o prefixo e metadados. */
export async function getApiKeys() {
  const db = await getDb();
  if (!db) return [];
  return db.select({
    id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix, permissions: apiKeys.permissions,
    active: apiKeys.active, lastUsedAt: apiKeys.lastUsedAt, expiresAt: apiKeys.expiresAt,
    createdById: apiKeys.createdById, createdAt: apiKeys.createdAt,
  }).from(apiKeys).orderBy(desc(apiKeys.createdAt));
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

/** Validade de uma API key ("YYYY-MM-DD HH:MM:SS" UTC) ou null = sem expiração. */
export async function setApiKeyExpiry(id: number, expiresAt: string | null) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(apiKeys).set({ expiresAt }).where(eq(apiKeys.id, id));
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
  const conditions: any[] = await projectFilterConds(complaints.projectId, filters?.projectId);
  if (filters?.status) conditions.push(eq(complaints.complaintStatus, filters.status as any));
  if (filters?.type) conditions.push(eq(complaints.complaintType, filters.type as any));
  if (filters?.vehicleId) conditions.push(eq(complaints.vehicleId, filters.vehicleId));
  if (filters?.assignedToId) conditions.push(eq(complaints.assignedToId, filters.assignedToId));
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
    .where(and(eq(complaints.id, id), projectScope(complaints.projectId)))
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
  await closeLinkedTasksIfResolved("complaint", id, (data as any).complaintStatus);
}

/** Origem resolvida → fecha as tarefas ligadas (sourceModule/sourceId). Nunca lança. */
async function closeLinkedTasksIfResolved(module: "complaint" | "incident" | "lost_found", id: number, status: unknown): Promise<void> {
  if (typeof status !== "string") return;
  const { SOURCE_RESOLVED_STATUSES } = await import("../shared/taskRules");
  if (!SOURCE_RESOLVED_STATUSES[module].includes(status)) return;
  const { closeTasksForSource } = await import("./tasksService");
  await closeTasksForSource(module, id);
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
  // Espelho no Shared Drive (se ligado) já, em segundo plano.
  import("./google/pendingSync").then((m) => m.scheduleGoogleDriveMirror()).catch(() => undefined);
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
    .where(and(...await projectFilterConds(complaints.projectId, projectId)));
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
  const conditions: any[] = [projectScope(googleReviews.projectId)];
  if (filters?.rating) conditions.push(eq(googleReviews.rating, filters.rating));
  if (filters?.status) conditions.push(eq(googleReviews.status, filters.status as any));
  if (filters?.projectId) conditions.push(inArray(googleReviews.projectId, await resolveProjectIds(filters.projectId)));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(googleReviews).where(where).orderBy(desc(googleReviews.createdAt));
}

export async function getGoogleReviewById(id: number) {
  const db = await getDb(); if (!db) return undefined;
  const result = await db.select().from(googleReviews).where(and(eq(googleReviews.id, id), projectScope(googleReviews.projectId))).limit(1);
  return result[0];
}

export async function updateGoogleReview(id: number, data: Partial<InsertGoogleReview>) {
  const db = await getDb(); if (!db) return;
  await db.update(googleReviews).set(data).where(and(eq(googleReviews.id, id), projectScope(googleReviews.projectId)));
}

export async function getGoogleReviewStats(filters?: { projectId?: number }) {
  const db = await getDb(); if (!db) return { total: 0, avg: 0, star1: 0, star2: 0, star3: 0, star4: 0, star5: 0, unrated: 0, pending: 0, responded: 0, complaints: 0 };
  const conditions = [projectScope(googleReviews.projectId)];
  if (filters?.projectId) conditions.push(inArray(googleReviews.projectId, await resolveProjectIds(filters.projectId)));
  const all = await db.select().from(googleReviews).where(and(...conditions));
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
    results.reviews = await db.select().from(googleReviews).where(and(or(...rConds), projectScope(googleReviews.projectId))).limit(20);
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

export async function createTrainingVideo(data: { categoryId: number; title: string; description?: string; videoUrl: string; thumbnailUrl?: string; durationMinutes?: number; sortOrder?: number; createdBy?: number; careerLevel?: string }) {
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

export async function getTrainingManuals(categoryId?: number, type?: string, includeUnpublished = false) {
  const db = await getDb();
  if (!db) return [];
  // Admins veem também os não publicados (com badge); os restantes não.
  const conditions: any[] = includeUnpublished ? [] : [eq(trainingManuals.published, 1)];
  if (categoryId) conditions.push(eq(trainingManuals.categoryId, categoryId));
  if (type) conditions.push(eq(trainingManuals.type, type as any));
  return db.select().from(trainingManuals).where(and(...conditions)).orderBy(desc(trainingManuals.createdAt));
}

export async function createTrainingManual(data: { categoryId?: number; title: string; content: string; type?: "manual" | "update" | "news" | "procedure" | "link"; createdBy?: number; fileUrl?: string; fileKey?: string; fileName?: string; fileMimeType?: string; careerLevel?: string }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(trainingManuals).values(data).$returningId();
  return result;
}

export async function updateTrainingManual(id: number, data: { title?: string; content?: string; type?: "manual" | "update" | "news" | "procedure" | "link"; published?: boolean; fileUrl?: string | null; fileKey?: string | null; fileName?: string | null; fileMimeType?: string | null; careerLevel?: string | null; categoryId?: number | null }) {
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
  return db.select().from(careerExams).where(isNull(careerExams.archivedAt)).orderBy(careerExams.level);
}

export async function createCareerExam(data: { level: string; title: string; description?: string; passingScore: number; timeLimitMinutes?: number }) {
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

export async function getCareerExamAttempts(employeeId?: number, examId?: number,
  scope?: { employeeId: number | null; projectIds: number[] }) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (employeeId) conditions.push(eq(careerExamAttempts.employeeId, employeeId));
  if (examId) conditions.push(eq(careerExamAttempts.examId, examId));
  if (scope) conditions.push(or(
    scope.employeeId != null ? eq(careerExamAttempts.employeeId, scope.employeeId) : sql`FALSE`,
    scope.projectIds.length ? inArray(employees.projectId, scope.projectIds) : sql`FALSE`,
  ));
  return db.select({ ...getTableColumns(careerExamAttempts), examTitle: careerExams.title })
    .from(careerExamAttempts)
    .leftJoin(employees, eq(employees.id, careerExamAttempts.employeeId))
    .leftJoin(careerExams, eq(careerExams.id, careerExamAttempts.examId))
    .where(conditions.length ? and(...conditions) : undefined).orderBy(desc(careerExamAttempts.createdAt));
}

export async function deleteCareerExam(id: number) {
  const db = await getDb();
  if (!db) return;
  // Compatibilidade do nome da operação; arquiva e preserva perguntas/resultados.
  await db.update(careerExams).set({ archivedAt: sql`COALESCE(archivedAt, UTC_TIMESTAMP())` })
    .where(eq(careerExams.id, id));
}

// ─── PERDIDOS E ACHADOS ───────────────────────────────────────────────────────
export async function createLostFoundItem(data: Omit<LostFoundItem, "id" | "createdAt" | "updatedAt">) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(lostFoundItems).values(data as any).$returningId();
  return result.id;
}

export async function getLostFoundItems(filters?: { status?: string; itemType?: string; projectId?: number; noProject?: boolean; search?: string }) {
  const db = await getDb(); if (!db) return [];
  // Quem vê todas as cidades vê também os casos "Sem cidade" (projectScope é
  // 1=1); `noProject` mostra SÓ esses (e nada a quem está limitado a cidades).
  const conditions: any[] = await projectFilterConds(lostFoundItems.projectId, filters?.noProject ? undefined : filters?.projectId);
  if (filters?.noProject) conditions.push(scopedProjectIds() === undefined ? isNull(lostFoundItems.projectId) : sql`1 = 0`);
  if (filters?.status) conditions.push(eq(lostFoundItems.status, filters.status as any));
  if (filters?.itemType) conditions.push(eq(lostFoundItems.itemType, filters.itemType as any));
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
  await closeLinkedTasksIfResolved("lost_found", id, (data as any).status);
}

/** Apaga o caso, os ficheiros no storage, mensagens e condutores ligados. */
export async function deleteLostFoundItem(id: number) {
  const { deleteLostCaseFully } = await import("./caseOps");
  await deleteLostCaseFully(id);
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
  const rows = await db.select({ d: lostFoundAttachedDrivers, penaltyStatus: employeePenalties.status })
    .from(lostFoundAttachedDrivers)
    .leftJoin(employeePenalties, eq(employeePenalties.id, lostFoundAttachedDrivers.penaltyId))
    .where(eq(lostFoundAttachedDrivers.itemId, itemId))
    .orderBy(desc(lostFoundAttachedDrivers.createdAt));
  // pointsConfirmed reflete a revisão do RH mesmo quando feita no ecrã do RH.
  return rows.map(r => ({ ...r.d, penaltyStatus: r.penaltyStatus ?? null, pointsConfirmed: r.penaltyStatus === "confirmed" ? 1 : 0 }));
}

export async function detachLostFoundDriver(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(lostFoundAttachedDrivers).where(eq(lostFoundAttachedDrivers.id, id));
}

export async function getLostFoundMessages(itemId: number) {
  const db = await getDb(); if (!db) return [];
  return db.select().from(lostFoundMessages).where(eq(lostFoundMessages.itemId, itemId)).orderBy(lostFoundMessages.createdAt);
}


// ─── OCORRÊNCIAS (INCIDENTS) ─────────────────────────────────────────────────
export async function createIncident(data: any) {
  const db = await getDb(); if (!db) return null;
  // Semana/ano ISO do DIA DE LISBOA da ocorrência (não do servidor/UTC).
  const at = data.sourceEmailDate ? String(data.sourceEmailDate) : caseUtcNowStr();
  const { week, year } = isoWeekYearLisbon(at.replace(" ", "T") + "Z");
  // Prazo: Definições (sla.incidentHours) → INCIDENT_SLA_HOURS → 48h.
  let slaHours = incidentSlaHours();
  if (data.dueAt == null) {
    try {
      const { getSetting } = await import("./appSettings");
      slaHours = (await getSetting("sla.incidentHours")) ?? slaHours;
    } catch { /* fica o valor da env/omissão */ }
  }
  const [result] = await db.insert(incidents).values({
    ...data,
    driverConfirmed: data.driverConfirmed ? 1 : 0,
    dueAt: data.dueAt ?? addHoursUtc(caseUtcNowStr(), slaHours),
    weekNumber: data.weekNumber || week,
    yearNumber: data.yearNumber || year,
  } as any).$returningId();
  return result?.id;
}

export async function getIncidents(filters?: { status?: string; severity?: string; employeeId?: number; projectId?: number; noProject?: boolean }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = await projectFilterConds(incidents.projectId, filters?.noProject ? undefined : filters?.projectId);
  if (filters?.noProject) conditions.push(scopedProjectIds() === undefined ? isNull(incidents.projectId) : sql`1 = 0`);
  if (filters?.status) conditions.push(eq(incidents.status, filters.status as any));
  if (filters?.severity) conditions.push(eq(incidents.severity, filters.severity as any));
  if (filters?.employeeId) conditions.push(eq(incidents.employeeId, filters.employeeId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(incidents).where(where).orderBy(desc(incidents.createdAt)).limit(2000);
}

export async function getIncidentById(id: number) {
  const db = await getDb(); if (!db) return null;
  const rows = await db.select().from(incidents).where(eq(incidents.id, id)).limit(1);
  return rows[0] || null;
}

export async function updateIncident(id: number, data: any) {
  const db = await getDb(); if (!db) return;
  await db.update(incidents).set(data).where(eq(incidents.id, id));
  await closeLinkedTasksIfResolved("incident", id, data?.status);
}

export async function deleteIncident(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(incidents).where(eq(incidents.id, id));
}

export async function getIncidentStats(filters?: { projectId?: number; noProject?: boolean }) {
  const db = await getDb(); if (!db) return { total: 0, open: 0, resolved: 0, critical: 0, byType: {} as Record<string, number> };
  const conditions: any[] = await projectFilterConds(incidents.projectId, filters?.noProject ? undefined : filters?.projectId);
  if (filters?.noProject) conditions.push(scopedProjectIds() === undefined ? isNull(incidents.projectId) : sql`1 = 0`);
  // Convertidas vivem noutro módulo — não contam aqui.
  conditions.push(sql`${incidents.status} <> 'converted'`);
  const rows = await db.select({
    incidentType: incidents.incidentType,
    total: sql<number>`COUNT(*)`,
    open: sql<number>`SUM(CASE WHEN ${incidents.status} IN ('open','investigating') THEN 1 ELSE 0 END)`,
    resolved: sql<number>`SUM(CASE WHEN ${incidents.status} = 'resolved' THEN 1 ELSE 0 END)`,
    critical: sql<number>`SUM(CASE WHEN ${incidents.severity} = 'critical' THEN 1 ELSE 0 END)`,
  }).from(incidents).where(and(...conditions)).groupBy(incidents.incidentType);
  const byType: Record<string, number> = {};
  let total = 0, open = 0, resolved = 0, critical = 0;
  for (const r of rows) {
    byType[r.incidentType] = Number(r.total);
    total += Number(r.total); open += Number(r.open); resolved += Number(r.resolved); critical += Number(r.critical);
  }
  return { total, open, resolved, critical, byType };
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
    .select({ id: employees.id, fullName: employees.fullName, position: employees.position, extraLevel: employees.extraLevel })
    .from(employees)
    .where(and(
      eq(employees.isActive, 1),
      inArray(employees.position, ["driver", "senior_driver", "extra"]),
    ));
  if (drivers.length === 0) return [];
  const driverIds = drivers.map(d => d.id);

  // ── 1. Horas trabalhadas: todos pelo PONTO (time_records) — os extras picam
  // ponto e recebem pelo ponto (Jorge, 24 set 2026). A escala do extras-dia só
  // entra como recurso para quem ainda não tem ponto na semana.
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
      // ponto [SUSPEITO] / por rever não conta horas (como no ordenado)
      inArray(timeRecords.reviewStatus, ["ok", "approved"]),
      sql`(${timeRecords.reviewStatus} = 'approved' OR COALESCE(${timeRecords.notes}, '') NOT LIKE '%[SUSPEITO]%')`,
    ))
    .groupBy(timeRecords.employeeId);
  const hoursMap = new Map(hoursRows.map(r => [r.employeeId, Number(r.hours)]));

  const weekStartDay = startStr.slice(0, 10);
  const weekEndDay = endStr.slice(0, 10);
  const scheduleRows = await db
    .select({
      employeeId: extrasDiaAssignments.employeeId,
      level: extrasDiaAssignments.level,
      hours: sql<string>`COALESCE(SUM(GREATEST(COALESCE(${extrasDiaAssignments.sentHomeHour}, ${extrasDiaAssignments.endHour}) - ${extrasDiaAssignments.startHour}, 0)), 0)`,
    })
    .from(extrasDiaAssignments)
    .where(and(
      isNotNull(extrasDiaAssignments.employeeId),
      gte(extrasDiaAssignments.assignmentDate, weekStartDay),
      lte(extrasDiaAssignments.assignmentDate, weekEndDay),
    ))
    .groupBy(extrasDiaAssignments.employeeId, extrasDiaAssignments.level);
  const scheduleHoursMap = new Map<number, number>();
  const scheduleCostMap = new Map<number, number>();
  const { loadExtraRates, rateFor } = await import("./extraRates");
  const liveRates = await loadExtraRates();
  for (const r of scheduleRows) {
    const empId = Number(r.employeeId);
    const hrs = Number(r.hours ?? 0);
    const rate = rateFor(liveRates, r.level ?? "junior");
    scheduleHoursMap.set(empId, (scheduleHoursMap.get(empId) ?? 0) + hrs);
    scheduleCostMap.set(empId, (scheduleCostMap.get(empId) ?? 0) + hrs * rate);
  }

  // reportedBy nos incidents é USER id — mapa user→employee para o Inc+
  // (fix 2026-08-06: comparava userId com employeeId, numerações diferentes)
  const userToEmployee = new Map<number, number>();
  for (const d of await db.select({ id: employees.id, userId: employees.userId }).from(employees).where(isNotNull(employees.userId))) {
    if (d.userId != null) userToEmployee.set(Number(d.userId), d.id);
  }

  // ── 2. Movimentações REAIS: ações no "History" da Multipark AO VIVO (a
  // cópia local está congelada desde o #141), ligadas ao colaborador pelo ID do
  // agente (fiável), pelo nome (legado) ou pelas contas extra (employee_agents).
  const movMap = new Map<number, number>();
  {
    const { readLiveHistoryByAgent } = await import("./multiparkDb/historyLive");
    let byAgent: Awaited<ReturnType<typeof readLiveHistoryByAgent>> = [];
    try { byAgent = await readLiveHistoryByAgent({ from: startStr, to: endStr, limit: 5000 }); }
    catch (err) { console.warn("[avaliação semanal] histórico Multipark indisponível:", String((err as any)?.message ?? err).slice(0, 160)); }
    const byId = new Map<string, number>(), byName = new Map<string, number>();
    for (const a of byAgent) {
      if (a.agentUserId) byId.set(a.agentUserId, (byId.get(a.agentUserId) ?? 0) + a.total);
      if (a.agentName) byName.set(a.agentName.trim().toLowerCase(), (byName.get(a.agentName.trim().toLowerCase()) ?? 0) + a.total);
    }
    const emps = await db.select({ id: employees.id, uid: employees.multiparkAgentUserId, name: employees.multiparkAgentName })
      .from(employees).where(inArray(employees.id, driverIds.length ? driverIds : [-1]));
    for (const e of emps) {
      const n = (e.uid ? byId.get(e.uid) : undefined) ?? (e.name ? byName.get(e.name.trim().toLowerCase()) : undefined) ?? 0;
      if (n) movMap.set(e.id, n);
    }
    try {
      const [aliasRows] = await db.execute(sql`SELECT employeeId, agentUserId FROM employee_agents`) as any;
      for (const r of (aliasRows as any[]) ?? []) {
        const id = Number(r.employeeId);
        const n = byId.get(String(r.agentUserId)) ?? 0;
        if (n && driverIds.includes(id)) movMap.set(id, (movMap.get(id) ?? 0) + n);
      }
    } catch { /* tabela ainda não criada */ }
  }

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
      status: incidents.status,
      driverConfirmed: incidents.driverConfirmed,
    })
    .from(incidents)
    .where(and(
      sql`COALESCE(${incidents.sourceEmailDate}, ${incidents.createdAt}) >= ${startStr}`,
      sql`COALESCE(${incidents.sourceEmailDate}, ${incidents.createdAt}) <= ${endStr}`,
    ));
  const posIncidents = new Map<number, number>();
  const negIncidents = new Map<number, { count: number; points: number }>();
  for (const i of incidentRows) {
    // reportedBy é USER id → resolve para employee (antes comparava numerações diferentes)
    const reporterEmpId = userToEmployee.get(Number(i.reportedBy ?? 0)) ?? 0;
    const targetId = Number(i.employeeId ?? 0);
    if (reporterEmpId && driverIds.includes(reporterEmpId)) {
      posIncidents.set(reporterEmpId, (posIncidents.get(reporterEmpId) ?? 0) + 1);
    }
    // Pontos JUSTOS: só com envolvimento confirmado e não descartada/convertida.
    if (targetId && driverIds.includes(targetId) && incidentCountsAgainstDriver(i)) {
      const sev = String(i.severity ?? "medium");
      const pts = INCIDENT_SEVERITY_POINTS[sev] ?? 5;
      const cur = negIncidents.get(targetId) ?? { count: 0, points: 0 };
      cur.count += 1;
      cur.points += pts;
      negIncidents.set(targetId, cur);
    }
  }

  // ── 5. Penalizações CONFIRMADAS criadas na semana (employee_penalties) —
  // pendentes (ex.: falta automática ainda por rever) e anuladas não contam.
  const penaltyRows = await db
    .select({
      employeeId: employeePenalties.employeeId,
      totalPoints: sql<number>`COALESCE(SUM(${employeePenalties.points}), 0)`,
    })
    .from(employeePenalties)
    .where(and(
      inArray(employeePenalties.employeeId, driverIds),
      eq(employeePenalties.status, "confirmed"),
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
    // Todos pelo ponto; extra sem ponto na semana → horas/custo da escala (estimativa)
    const pontoHours = hoursMap.get(emp.id) ?? 0;
    const isExtra = emp.position === "extra";
    const useSchedule = isExtra && pontoHours <= 0;
    const rawHours = useSchedule ? (scheduleHoursMap.get(emp.id) ?? 0) : pontoHours;
    const hoursWorked = Math.round(rawHours * 100) / 100;
    const rawCost = !isExtra ? 0
      : useSchedule ? (scheduleCostMap.get(emp.id) ?? 0)
      : pontoHours * rateFor(liveRates, emp.extraLevel ?? 1);
    const weeklyCost = Math.round(rawCost * 100) / 100;
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
      // Decimais (colunas convertidas para DECIMAL(8,2) a 2026-08-06)
      hoursWorked: String(hoursWorked),
      movementsCount,
      movementsPerHour: String(movementsPerHour),
      weeklyCost: String(weeklyCost),
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
  const conditions: any[] = await projectFilterConds(services.projectId, filters?.projectId);
  if (filters?.serviceType) conditions.push(eq(services.serviceType, filters.serviceType as any));
  if (filters?.employeeId) conditions.push(eq(services.employeeId, filters.employeeId));
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
// O CRUD da tabela `invoices` saiu (nunca foi usado pela interface); a tabela
// fica (o Anual antigo ainda a lê). A Faturação vem do motor financeiro.

// ─── BILLING / FATURAÇÃO ────────────────────────────────────────────────────
// Resolve um centro de custos para o conjunto de projetos (ele + descendentes).
// MARCA GLOBAL (pedido do Jorge 2026-08-04): um ID NEGATIVO significa "esta
// marca em TODAS as cidades" — ex.: -52 (Airpark Lisboa) expande para todos
// os nós level='brand' com o MESMO nome (Airpark Lisboa/Porto/Faro) e os seus
// descendentes. Funciona porque as marcas têm nome igual entre cidades e
// porque TODOS os endpoints filtram via esta função — nada mais muda.
//
// INATIVOS: inclui de propósito os descendentes com isActive=0 — um parque
// fechado continua a contar no histórico (relatórios, despesas, reservas).
// Os seletores e o matcher de reservas é que ignoram nós inativos para
// atribuições NOVAS. Seguro com ciclos na árvore (conjunto de visitados).
export async function resolveProjectIds(projectId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [Math.abs(projectId)];
  const allProjects = await db.select({ id: projects.id, parentId: projects.parentId, level: projects.level, name: projects.name }).from(projects);
  const ids = new Set<number>();
  const addChildren = (pid: number) => {
    if (ids.has(pid)) return;
    ids.add(pid);
    for (const p of allProjects) {
      if (p.parentId === pid) addChildren(p.id);
    }
  };
  if (projectId < 0) {
    const anchor = allProjects.find((p) => p.id === -projectId);
    if (!anchor) return [];
    const sameName = allProjects.filter(
      (p) => p.level === anchor.level && p.name.trim().toLowerCase() === anchor.name.trim().toLowerCase(),
    );
    for (const b of sameName) addChildren(b.id);
    return Array.from(ids);
  }
  addChildren(projectId);
  return Array.from(ids);
}

/**
 * Diagnóstico da receita realizada: as MESMAS regras do motor financeiro
 * (deliveredConditions — CHECKED_OUT com saída no período de LISBOA, filtro
 * de centro com a hierarquia), com os passos intermédios para isolar onde um
 * número diverge. O último passo é, por construção, a receita "Entregues" da
 * Faturação.
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
  let projectIds: number[] | null = null;
  if (filters.projectId) projectIds = await resolveProjectIds(filters.projectId);
  // AO VIVO da BD da Multipark (só os nossos parques) — as MESMAS leituras do
  // motor financeiro (server/finance/liveBookings.ts).
  const { loadLiveBookingAgg, loadLiveContext, parkIdsFor } = await import("./finance/liveBookings");
  const { readTopDelivered } = await import("./multiparkDb/financeAgg");
  const utc = lisbonDayRangeUtc(filters.from, filters.to);
  const ctx = await loadLiveContext();
  const filteredParks = parkIdsFor(ctx, projectIds);
  const [anyStatus, delivered, deliveredFiltered, top] = await Promise.all([
    loadLiveBookingAgg("checkout_any", utc),
    loadLiveBookingAgg("delivered", utc),
    loadLiveBookingAgg("delivered", utc, projectIds),
    filteredParks.length ? readTopDelivered({ start: utc.start, end: utc.end, parkIds: filteredParks }) : Promise.resolve([]),
  ]);
  type Agg = (typeof anyStatus)[number];
  const cs = (rows: Agg[]) => ({ count: rows.reduce((t, r) => t + r.count, 0), sum: rows.reduce((t, r) => t + r.total, 0) });
  const groupBy = <K,>(rows: Agg[], key: (r: Agg) => K) => {
    const m = new Map<K, { count: number; sum: number }>();
    for (const r of rows) { const e = m.get(key(r)) ?? { count: 0, sum: 0 }; e.count += r.count; e.sum += r.total; m.set(key(r), e); }
    return [...m.entries()].sort((a, b) => b[1].sum - a[1].sum);
  };
  const projNames = new Map<number, string>();
  const pdb = await getDb();
  if (pdb) for (const p of await pdb.select({ id: projects.id, name: projects.name }).from(projects)) projNames.set(p.id, p.name);
  const nameOf = (pid: number | null) => (pid == null ? null : projNames.get(pid) ?? null);
  const inFilter = (r: Agg) => !projectIds || (r.projectId != null && projectIds.includes(r.projectId));
  const cancelled = cs(anyStatus.filter((r) => r.status === "CANCELLED" && inFilter(r)));
  const periodAll = cs(anyStatus);
  const f = cs(deliveredFiltered);

  return {
    range: { from: filters.from, to: filters.to },
    projectIds,
    sumByCheckoutPeriod: periodAll,
    sumWithCheckoutNotNull: periodAll,   // na BD da Multipark a saída é obrigatória
    sumExcludingCancelled: cs(delivered),
    sumWithProjectFilter: f,
    rowsCount: f.count,
    distinctExternalIds: f.count,          // leitura direta: sem cópias duplicadas
    duplicatedExternalIds: [],
    byProject: groupBy(deliveredFiltered, (r) => r.projectId).map(([projectId, v]) => ({ projectId, projectName: nameOf(projectId), ...v })),
    byCampaign: groupBy(deliveredFiltered, (r) => r.campaign).map(([campaign, v]) => ({ campaign, ...v })),
    byStatus: groupBy(anyStatus.filter(inFilter), (r) => r.status).map(([status, v]) => ({ status, ...v })),
    cancelledCount: cancelled.count,
    cancelledSum: cancelled.sum,
    topBookings: top.map((t, i) => ({
      id: i + 1,
      externalId: t.id,
      bookingNumber: t.code,
      projectName: nameOf(ctx.ourParks.get(t.parkId) ?? null),
      campaign: null,
      status: t.status,
      totalPrice: t.total,
      checkOut: t.checkOut,
      cancelledAt: null,
    })),
  };
}

// Regras comuns às vistas de Parcerias (Análise, Resumo, detalhe por tipo):
//  - só reservas CONCLUÍDAS (CHECKED_OUT) pela data de saída — a mesma regra da
//    receita realizada no motor financeiro; canceladas e em curso ficam fora;
//  - "tem parceiro" = campanha não vazia (linhas e totais iguais).
/**
 * Reservas CONCLUÍDAS (CHECKED_OUT) com saída no período de Lisboa, AO VIVO da
 * BD da Multipark (server/finance/liveBookings.ts — só os nossos parques, com
 * centro e campanha), cortadas pelo âmbito de cidade do utilizador e pelo
 * filtro de centro. `net` = valor sem IVA à taxa do dia da saída (a base das
 * comissões), como o antigo netRevenueSumSql.
 */
async function livePartnerDelivered(from: string, to: string, projectIds?: number[]) {
  const { loadLiveBookingAgg, loadLiveContext } = await import("./finance/liveBookings");
  const { resolveFinanceRates } = await import("./finance/rates");
  const scoped = scopedProjectIds();
  let ids: number[] | undefined = projectIds;
  if (scoped !== undefined) ids = ids ? ids.filter((id) => scoped.includes(id)) : scoped;
  const [ctx, fr, rows] = await Promise.all([
    loadLiveContext(), resolveFinanceRates(from, to), loadLiveBookingAgg("delivered", lisbonDayRangeUtc(from, to), ids),
  ]);
  return { ctx, rows: rows.map((r) => ({ ...r, net: r.total / (1 + fr.rates.vatOn(r.day)) })) };
}
const hasCampaign = (c: string | null | undefined) => !!c && c.trim() !== "";

/** Comissão sobre a base do parceiro (SEM IVA por omissão; 'gross' = exceção). */
const partnerCommissionAmount = (p: { commissionBase?: string | null }, rev: { revenue: number; revenueNet: number }, rate: number) =>
  ((p.commissionBase === "gross" ? rev.revenue : rev.revenueNet) * rate) / 100;

export async function getPartnershipAnalytics(filters: { from: string; to: string; projectId?: number }) {
  const db = await getDb();
  if (!db) return { partners: [], proBookings: [], totals: { partnerBookings: 0, partnerRevenue: 0, directBookings: 0, directRevenue: 0, proBookings: 0, proRevenue: 0 } };

  let projectIds: number[] | undefined;
  if (filters.projectId) projectIds = await resolveProjectIds(filters.projectId);

  // Reservas concluídas no período, AO VIVO da BD da Multipark.
  const { ctx, rows } = await livePartnerDelivered(filters.from, filters.to, projectIds);
  const parkOf = (id: string) => ctx.parkInfo?.get(id) ?? { name: null as string | null, city: null as string | null };

  // 1. Reservas de parceiro (campanha preenchida = veio de parceiro/afiliado), por campanha × cidade × parque
  const byPartner = new Map<string, { campaign: string | null; city: string | null; parkName: string | null; count: number; totalRevenue: number; totalDiscount: number }>();
  for (const r of rows) {
    if (!hasCampaign(r.campaign)) continue;
    const pk = parkOf(r.parkId);
    const k = JSON.stringify([r.campaign, pk.city, pk.name]);
    const e = byPartner.get(k) ?? { campaign: r.campaign, city: pk.city, parkName: pk.name, count: 0, totalRevenue: 0, totalDiscount: 0 };
    e.count += r.count; e.totalRevenue += r.total; e.totalDiscount += r.discount;
    byPartner.set(k, e);
  }
  const partnerRows = [...byPartner.values()].map((e) => ({ ...e, avgPrice: e.count ? e.totalRevenue / e.count : 0 }));

  // 2. Totais (parceiro vs direto)
  const allTotals = {
    partnerCount: rows.filter((r) => hasCampaign(r.campaign)).reduce((t, r) => t + r.count, 0),
    partnerRevenue: rows.filter((r) => hasCampaign(r.campaign)).reduce((t, r) => t + r.total, 0),
    count: rows.reduce((t, r) => t + r.count, 0),
    totalRevenue: rows.reduce((t, r) => t + r.total, 0),
  };

  // 3. Reservas Pro (a reserva é Pro — "Booking".pro), por parque × cidade
  const byPro = new Map<string, { parkName: string | null; city: string | null; count: number; totalRevenue: number }>();
  for (const r of rows) {
    if (!r.pro) continue;
    const pk = parkOf(r.parkId);
    const k = JSON.stringify([pk.name, pk.city]);
    const e = byPro.get(k) ?? { parkName: pk.name, city: pk.city, count: 0, totalRevenue: 0 };
    e.count += r.count; e.totalRevenue += r.total;
    byPro.set(k, e);
  }
  const proRows = [...byPro.values()];

  // Calculate totals
  const partnerBookings = Number(allTotals?.partnerCount ?? 0), partnerRevenue = Number(allTotals?.partnerRevenue ?? 0);
  const directBookings = Number(allTotals?.count ?? 0) - partnerBookings, directRevenue = Number(allTotals?.totalRevenue ?? 0) - partnerRevenue;
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

// ─── PARCERIAS (PARTNERSHIPS) ────────────────────────────────────────────────
export async function createPartnership(data: any) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(partnerships).values(data as any).$returningId();
  return result?.id;
}

export async function getPartnerships(filters?: { partnerType?: string; status?: string }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = [partnerScope(partnerships.id)];
  if (filters?.partnerType) conditions.push(eq(partnerships.partnerType, filters.partnerType as any));
  if (filters?.status) conditions.push(eq(partnerships.partnerStatus, filters.status as any));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(partnerships).where(where).orderBy(desc(partnerships.createdAt));
}

/**
 * Sumário de faturação por parceiro. Para cada parceiro calcula aFaturar:
 * comissão das reservas concluídas no período (CHECKED_OUT pela data de
 * saída) ou avença mensal/anual rateada pelos meses cobertos.
 * (As colunas faturado/pendente/em atraso foram retiradas: nada na app cria
 * partnership_invoices, por isso eram sempre zero.)
 *
 * O cálculo de comissão usa os mesmos aliases que getBillingData para
 * fazer match com as reservas. `projectId` (filtro global de cidade/marca)
 * limita as reservas; as avenças não têm cidade e ficam indisponíveis.
 */
export async function getPartnerInvoicingSummary(filters: {
  from: string;
  to: string;
  projectId?: number;
  partnerType?: string;
}): Promise<Array<{
  partnershipId: number;
  partnerName: string;
  partnerType: string;
  commissionRate: number;
  commissionBase: "net" | "gross";
  monthlyFee: number;
  bookingsCount: number;
  revenueGross: number;
  revenueNet: number;
  aFaturar: number | null;
  billingAvailable: boolean;
}>> {
  const db = await getDb();
  if (!db) return [];

  // Avenças são globais (sem cidade): só se mostram sem filtro/limite de cidade.
  const billingAvailable = scopedProjectIds() === undefined && !filters.projectId;
  const projectIds = filters.projectId ? await resolveProjectIds(filters.projectId) : undefined;
  const { partnerFeeForPeriod } = await import("../shared/partnerRules");

  // 1) Parcerias (com filtro opcional de tipo). Inclui notes para extrair
  //    config JSON (operatesProjects, cashbackPercent, prizeBudget).
  const partnerRows = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      partnerType: partnerships.partnerType,
      commissionRate: partnerships.commissionRate,
      commissionBase: partnerships.commissionBase,
      monthlyFee: partnerships.monthlyFee,
      campaignKey: partnerships.campaignKey,
      notes: partnerships.notes,
    })
    .from(partnerships)
    .where(and(partnerScope(partnerships.id), filters.partnerType ? eq(partnerships.partnerType, filters.partnerType) : undefined));

  if (partnerRows.length === 0) return [];

  const { parsePartnerConfig } = await import("../shared/partnerTypes");

  // 2) Correspondência campanha → parceiro: a MESMA do motor financeiro
  //    (todos os parceiros + aliases; o mais recente ganha — ./finance/partners.ts)
  const { loadPartnerIndex, partnerForCampaign } = await import("./finance/partners");
  const { index: partnerIndex } = await loadPartnerIndex(db);

  // 3) Reservas concluídas (checkout no período), AO VIVO da BD da Multipark, por campanha
  const { rows: liveRows } = await livePartnerDelivered(filters.from, filters.to, projectIds);
  const byCampaign = new Map<string, { campaign: string; bookingsCount: number; revenue: number; revenueNet: number }>();
  for (const r of liveRows) {
    if (!hasCampaign(r.campaign)) continue;
    const e = byCampaign.get(r.campaign!) ?? { campaign: r.campaign!, bookingsCount: 0, revenue: 0, revenueNet: 0 };
    e.bookingsCount += r.count; e.revenue += r.total; e.revenueNet += r.net;
    byCampaign.set(r.campaign!, e);
  }
  const bookingRows = [...byCampaign.values()];

  // 4) Acumula bookings por parceiro
  const bookingsByPartner = new Map<number, { count: number; revenue: number; revenueNet: number }>();
  for (const b of bookingRows) {
    const pid = partnerForCampaign(partnerIndex, b.campaign)?.id;
    if (!pid) continue;
    const existing = bookingsByPartner.get(pid) ?? { count: 0, revenue: 0, revenueNet: 0 };
    existing.count += Number(b.bookingsCount ?? 0);
    existing.revenue += Number(b.revenue ?? 0);
    existing.revenueNet += Number(b.revenueNet ?? 0);
    bookingsByPartner.set(pid, existing);
  }

  // 6b) Para parceiros tipo "operacional" com operatesProjects definidos,
  //     a comissão é calculada sobre TODAS as reservas dos projetos operados
  //     (concluídas, com checkout no período), expandindo a hierarquia
  //     para cobrir filhos. Independente do campo `campaign`, o que permite
  //     que uma mesma reserva acumule comissão de venda (via campaign) e
  //     comissão operacional (via operatesProjects).
  const operationalPartners = partnerRows
    .filter((p) => (p.partnerType ?? "outro") === "operacional")
    .map((p) => ({ p, cfg: parsePartnerConfig(p.notes ?? null) }))
    .filter(({ cfg }) => Array.isArray(cfg.operatesProjects) && cfg.operatesProjects!.length > 0);

  const operationalRevenueByPartner = new Map<number, { count: number; revenue: number; revenueNet: number }>();

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
      const opBookings = [...liveRows.filter((r) => r.projectId != null && expanded.has(r.projectId)).reduce((m, r) => {
        const e = m.get(r.projectId!) ?? { projectId: r.projectId, count: 0, revenue: 0, revenueNet: 0 };
        e.count += r.count; e.revenue += r.total; e.revenueNet += r.net;
        return m.set(r.projectId!, e);
      }, new Map<number, { projectId: number | null; count: number; revenue: number; revenueNet: number }>()).values()];

      const revenueByProject = new Map<number, { count: number; revenue: number; revenueNet: number }>();
      for (const r of opBookings) {
        if (r.projectId == null) continue;
        revenueByProject.set(r.projectId, {
          count: Number(r.count ?? 0),
          revenue: Number(r.revenue ?? 0),
          revenueNet: Number(r.revenueNet ?? 0),
        });
      }

      // Atribui a cada parceiro operacional a soma das reservas dos projetos
      // que ele opera (expandidos).
      for (const { p, cfg } of operationalPartners) {
        let count = 0;
        let revenue = 0;
        let revenueNet = 0;
        const cover = new Set<number>();
        for (const root of cfg.operatesProjects ?? []) {
          const ids = await resolveProjectIds(root);
          for (const pid of ids) cover.add(pid);
        }
        for (const pid of cover) {
          const r = revenueByProject.get(pid);
          if (r) { count += r.count; revenue += r.revenue; revenueNet += r.revenueNet; }
        }
        operationalRevenueByPartner.set(p.id, { count, revenue, revenueNet });
      }
    }
  }

  // 7) Constrói resultado
  return partnerRows.map((p) => {
    const bk = bookingsByPartner.get(p.id) ?? { count: 0, revenue: 0, revenueNet: 0 };
    const opRev = operationalRevenueByPartner.get(p.id);

    const commissionRate = Number(p.commissionRate ?? 0);
    const monthlyFee = Number(p.monthlyFee ?? 0);
    const partnerType = p.partnerType ?? "outro";

    // Cálculo a faturar conforme tipo
    let aFaturar = 0;
    let displayBookingsCount = bk.count;
    let displayRevenue = bk.revenue;
    let displayRevenueNet = bk.revenueNet;

    if (partnerType === "avenca_mensal" || partnerType === "avenca_anual") {
      aFaturar = partnerFeeForPeriod(partnerType, monthlyFee, filters.from, filters.to);
    } else if (partnerType === "operacional") {
      // Usa o cálculo via operatesProjects se configurado; senão usa o
      // campaign match (fallback). É legítimo um operacional ter ambos.
      const rev = opRev ?? bk;
      displayRevenue = rev.revenue;
      displayRevenueNet = rev.revenueNet;
      displayBookingsCount = rev.count;
      aFaturar = partnerCommissionAmount(p, rev, commissionRate);
    } else if (
      partnerType === "agregador" ||
      partnerType === "agencia_viagem" ||
      partnerType === "hotel" ||
      partnerType === "companhia_aerea" ||
      partnerType === "afiliado"
    ) {
      aFaturar = partnerCommissionAmount(p, bk, commissionRate);
    } else if (partnerType === "cliente_pro") {
      // Cliente Pro: faturado no fim do mês com base nas reservas que ele
      // gerou. A receita já tem desconto aplicado.
      aFaturar = bk.revenue;
    }
    // enterprise / campanha_propria / outro → não há a faturar automático

    return {
      partnershipId: p.id,
      partnerName: p.name,
      partnerType,
      commissionRate,
      commissionBase: (p.commissionBase === "gross" ? "gross" : "net") as "net" | "gross",
      monthlyFee,
      bookingsCount: displayBookingsCount,
      revenueGross: displayRevenue,
      revenueNet: displayRevenueNet,
      aFaturar: !billingAvailable && ['avenca_mensal', 'avenca_anual'].includes(partnerType) ? null : aFaturar,
      billingAvailable,
    };
  })
    .sort((a, b) => (b.aFaturar ?? 0) - (a.aFaturar ?? 0));
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
  projectId?: number;
  partnerType: string;
}): Promise<{
  partnerType: string;
  partners: Array<{
    partnershipId: number;
    partnerName: string;
    commissionRate: number;
    commissionBase: "net" | "gross";
    monthlyFee: number;
    bookingsCount: number;
    revenueGross: number;
    revenueNet: number;
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
  if (scopedProjectIds() !== undefined && ['avenca_mensal', 'avenca_anual'].includes(filters.partnerType)) requireGlobalCityAccess();
  const db = await getDb();
  if (!db) return { partnerType: filters.partnerType, partners: [] };

  const projectIds = filters.projectId ? await resolveProjectIds(filters.projectId) : undefined;

  const { parsePartnerConfig } = await import("../shared/partnerTypes");
  const { partnerFeeForPeriod } = await import("../shared/partnerRules");

  const partnerRows = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      partnerType: partnerships.partnerType,
      commissionRate: partnerships.commissionRate,
      commissionBase: partnerships.commissionBase,
      monthlyFee: partnerships.monthlyFee,
      campaignKey: partnerships.campaignKey,
      notes: partnerships.notes,
    })
    .from(partnerships)
    .where(and(eq(partnerships.partnerType, filters.partnerType), partnerScope(partnerships.id)));

  if (partnerRows.length === 0) return { partnerType: filters.partnerType, partners: [] };

  // Correspondência campanha → parceiro: a MESMA do motor financeiro
  const { loadPartnerIndex, partnerForCampaign } = await import("./finance/partners");
  const { index: partnerIndex } = await loadPartnerIndex(db);

  // Reservas concluídas (CHECKED_OUT), AO VIVO da BD da Multipark, por campanha (campanha → parceiro).
  const { rows: liveRows } = await livePartnerDelivered(filters.from, filters.to, projectIds);
  const bookingRows = liveRows.filter((r) => hasCampaign(r.campaign))
    .map((r) => ({ campaign: r.campaign, count: r.count, revenue: r.total, revenueNet: r.net, discount: r.discount, extras: r.extras }));

  const byPartner = new Map<number, { count: number; revenue: number; revenueNet: number; discount: number; extras: number }>();
  for (const b of bookingRows) {
    const pid = partnerForCampaign(partnerIndex, b.campaign)?.id;
    if (!pid) continue;
    const ex = byPartner.get(pid) ?? { count: 0, revenue: 0, revenueNet: 0, discount: 0, extras: 0 };
    ex.count += Number(b.count ?? 0);
    ex.revenue += Number(b.revenue ?? 0);
    ex.revenueNet += Number(b.revenueNet ?? 0);
    ex.discount += Number(b.discount ?? 0);
    ex.extras += Number(b.extras ?? 0);
    byPartner.set(pid, ex);
  }

  // Para operacional: agregação via projetos operados
  const operationalRevenueByPartner = new Map<number, { count: number; revenue: number; revenueNet: number }>();
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
      const covered = liveRows.filter((r) => r.projectId != null && expanded.has(r.projectId));
      const rows = [{ count: covered.reduce((t, r) => t + r.count, 0), revenue: covered.reduce((t, r) => t + r.total, 0), revenueNet: covered.reduce((t, r) => t + r.net, 0) }];
      operationalRevenueByPartner.set(p.id, {
        count: Number(rows[0]?.count ?? 0),
        revenue: Number(rows[0]?.revenue ?? 0),
        revenueNet: Number(rows[0]?.revenueNet ?? 0),
      });
    }
  }

  const partners = partnerRows.map((p) => {
    const cfg = parsePartnerConfig(p.notes ?? null);
    const cashbackPercent = Number(cfg.cashbackPercent ?? 0);
    const prizeBudget = Number(cfg.prizeBudget ?? 0);
    const commissionRate = Number(p.commissionRate ?? 0);
    const monthlyFee = Number(p.monthlyFee ?? 0);
    const bk = byPartner.get(p.id) ?? { count: 0, revenue: 0, revenueNet: 0, discount: 0, extras: 0 };
    const opRev = operationalRevenueByPartner.get(p.id);

    let bookingsCount = bk.count;
    let revenueGross = bk.revenue;
    let revenueNet = bk.revenueNet;
    let aFaturar = 0;
    const cashbackAmount = (bk.revenue * cashbackPercent) / 100;

    if (filters.partnerType === "operacional" && opRev) {
      bookingsCount = opRev.count;
      revenueGross = opRev.revenue;
      revenueNet = opRev.revenueNet;
      aFaturar = partnerCommissionAmount(p, opRev, commissionRate);
    } else if (filters.partnerType === "avenca_mensal" || filters.partnerType === "avenca_anual") {
      aFaturar = partnerFeeForPeriod(filters.partnerType, monthlyFee, filters.from, filters.to);
    } else if (
      filters.partnerType === "agregador" ||
      filters.partnerType === "agencia_viagem" ||
      filters.partnerType === "hotel" ||
      filters.partnerType === "companhia_aerea" ||
      filters.partnerType === "afiliado"
    ) {
      aFaturar = partnerCommissionAmount(p, bk, commissionRate);
    } else if (filters.partnerType === "cliente_pro") {
      aFaturar = bk.revenue;
    }

    return {
      partnershipId: p.id,
      partnerName: p.name,
      commissionRate,
      commissionBase: (p.commissionBase === "gross" ? "gross" : "net") as "net" | "gross",
      monthlyFee,
      bookingsCount,
      revenueGross,
      revenueNet,
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

/**
 * Liga um registo das Parcerias a um parceiro da BD Multipark ("Partner".userId).
 * Um id só pode estar num registo: sai de qualquer outro que o tivesse.
 */
export async function setPartnershipMultiparkId(id: number, multiparkPartnerId: string | null): Promise<void> {
  const db = await getDb(); if (!db) return;
  const mp = multiparkPartnerId?.trim() || null;
  if (mp) await db.update(partnerships).set({ multiparkPartnerId: null }).where(and(eq(partnerships.multiparkPartnerId, mp), ne(partnerships.id, id)));
  await db.update(partnerships).set({ multiparkPartnerId: mp }).where(eq(partnerships.id, id));
}

export async function updatePartnership(id: number, data: any) {
  const db = await getDb(); if (!db) return;
  await db.update(partnerships).set(data).where(eq(partnerships.id, id));
}

/** Apaga a parceria e tudo o que a referencia — sobretudo os aliases: o
 * UNIQUE(aliasType, aliasValue) impedia voltar a ligar o partnerId/método de
 * pagamento a outro parceiro, e a sincronização considerava-o "já ligado". */
export async function deletePartnership(id: number) {
  const db = await getDb(); if (!db) return;
  await db.delete(partnerAliases).where(eq(partnerAliases.partnershipId, id));
  await db.delete(partnershipInvoices).where(eq(partnershipInvoices.partnershipId, id));
  await db.delete(partnershipTransactions).where(eq(partnershipTransactions.partnershipId, id));
  await db.delete(partnerships).where(eq(partnerships.id, id));
}

/** Já existe uma parceria com este nome (sem distinguir maiúsculas/espaços)? */
export async function partnershipNameExists(name: string, exceptId?: number): Promise<boolean> {
  const db = await getDb(); if (!db) return false;
  const rows = await db.select({ id: partnerships.id }).from(partnerships)
    .where(and(
      sql`LOWER(TRIM(${partnerships.name})) = ${name.trim().toLowerCase()}`,
      exceptId != null ? ne(partnerships.id, exceptId) : undefined,
    )).limit(1);
  return rows.length > 0;
}

// ─── ANUAL (ANNUAL REPORTS) ────────────────────────────────────────────────
export async function createAnnualReport(data: any) {
  const db = await getDb(); if (!db) return null;
  const [result] = await db.insert(annualReports).values(data as any).$returningId();
  return result?.id;
}

export async function getAnnualReports(filters?: { year?: number; projectId?: number }) {
  const db = await getDb(); if (!db) return [];
  const conditions: any[] = await projectFilterConds(annualReports.projectId, filters?.projectId);
  if (filters?.year) conditions.push(eq(annualReports.year, filters.year));
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

// ─── HISTÓRICO FINANCEIRO MENSAL (importado de Excel/CSV, 2016→) ─────────────
// Anos anteriores à app não têm reservas na BD; o Jorge importa os totais
// mensais (receita c/ IVA, despesas c/ IVA, ordenados) e o breakdown Anual
// usa estes valores quando não há dados reais no mês. Tabela criada on-demand.
let financialHistoryEnsured = false;
async function ensureFinancialHistoryTable() {
  if (financialHistoryEnsured) return;
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS \`financial_history_monthly\` (
    \`year\` INT NOT NULL,
    \`month\` INT NOT NULL,
    \`revenueWithVat\` DECIMAL(14,2) NOT NULL DEFAULT 0,
    \`expensesWithVat\` DECIMAL(14,2) NOT NULL DEFAULT 0,
    \`salaries\` DECIMAL(14,2) NOT NULL DEFAULT 0,
    \`notes\` VARCHAR(512) NULL,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`year\`, \`month\`)
  )`);
  financialHistoryEnsured = true;
}

export async function importFinancialHistory(rows: Array<{
  year: number; month: number; revenueWithVat: number; expensesWithVat?: number; salaries?: number; notes?: string | null;
}>) {
  const db = await getDb();
  if (!db) return { imported: 0 };
  await ensureFinancialHistoryTable();
  let imported = 0;
  for (const r of rows) {
    if (!r.year || r.year < 2000 || r.year > 2100 || !r.month || r.month < 1 || r.month > 12) continue;
    await db.execute(sql`INSERT INTO \`financial_history_monthly\`
      (\`year\`, \`month\`, \`revenueWithVat\`, \`expensesWithVat\`, \`salaries\`, \`notes\`)
      VALUES (${r.year}, ${r.month}, ${r.revenueWithVat ?? 0}, ${r.expensesWithVat ?? 0}, ${r.salaries ?? 0}, ${r.notes ?? null})
      ON DUPLICATE KEY UPDATE
        \`revenueWithVat\` = VALUES(\`revenueWithVat\`),
        \`expensesWithVat\` = VALUES(\`expensesWithVat\`),
        \`salaries\` = VALUES(\`salaries\`),
        \`notes\` = VALUES(\`notes\`)`);
    imported++;
  }
  return { imported };
}

export async function getFinancialHistory(year?: number) {
  const db = await getDb();
  if (!db) return [];
  await ensureFinancialHistoryTable();
  const [rows] = await db.execute(
    year != null
      ? sql`SELECT * FROM \`financial_history_monthly\` WHERE \`year\` = ${year} ORDER BY \`year\`, \`month\``
      : sql`SELECT * FROM \`financial_history_monthly\` ORDER BY \`year\`, \`month\``,
  ) as any;
  return (rows as any[]).map((r) => ({
    year: Number(r.year),
    month: Number(r.month),
    revenueWithVat: Number(r.revenueWithVat ?? 0),
    expensesWithVat: Number(r.expensesWithVat ?? 0),
    salaries: Number(r.salaries ?? 0),
    notes: r.notes ?? null,
  }));
}

export async function deleteFinancialHistoryYear(year: number) {
  const db = await getDb();
  if (!db) return { deleted: 0 };
  await ensureFinancialHistoryTable();
  await db.execute(sql`DELETE FROM \`financial_history_monthly\` WHERE \`year\` = ${year}`);
  return { deleted: 1 };
}

// ─── INFERÊNCIA DO CENTRO DE CUSTOS PELA MORADA (extras) ─────────────────────
// Regra do Jorge: se não indicarem centro de custos ao criar um extra, o
// sistema infere a CIDADE pela morada (Algarve→Faro, Grande Porto→Porto,
// Grande Lisboa/Setúbal→Lisboa) e aloca ao nó-cidade da árvore de projetos.
const CITY_ADDRESS_KEYWORDS: Record<string, string[]> = {
  Faro: ["faro", "algarve", "albufeira", "portimao", "olhao", "loule", "quarteira", "vilamoura", "tavira", "lagos", "silves", "almancil", "sao bras", "vila real de santo antonio", "monchique", "aljezur", "castro marim", "alcoutim", "vila do bispo", "montenegro", "quelfes", "armacao de pera", "ferreiras", "guia", "paderne", "boliqueime", "estoi", "moncarapacho"],
  Porto: ["porto", "vila nova de gaia", "gaia", "matosinhos", "maia", "gondomar", "valongo", "povoa de varzim", "vila do conde", "santo tirso", "trofa", "penafiel", "paredes", "ermesinde", "rio tinto", "espinho", "senhora da hora", "aguas santas", "sao mamede de infesta", "leca"],
  Lisboa: ["lisboa", "amadora", "sintra", "cascais", "oeiras", "loures", "odivelas", "almada", "seixal", "barreiro", "montijo", "setubal", "alcochete", "moita", "sesimbra", "palmela", "mafra", "torres vedras", "vila franca de xira", "alverca", "sacavem", "queluz", "agualva", "cacem", "rio de mouro", "massama", "corroios", "feijo", "laranjeiro", "camarate", "povoa de santa iria", "odivelas", "carnaxide", "algés", "alges", "damaia", "benfica", "chelas", "marvila", "monte abraao", "monte abraão"],
};

function normAddress(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Devolve a cidade inferida pela morada ("Faro"/"Porto"/"Lisboa") ou null. */
export function inferCityFromAddress(address?: string | null): string | null {
  if (!address) return null;
  const a = ` ${normAddress(address)} `;
  // Faro e Porto primeiro (mais específicos); Lisboa por fim (apanha resto da AML)
  for (const city of ["Faro", "Porto", "Lisboa"]) {
    for (const kw of CITY_ADDRESS_KEYWORDS[city]) {
      if (a.includes(` ${kw} `) || a.includes(` ${kw},`) || a.includes(`,${kw} `) || a.includes(` ${kw}\n`) || a.includes(`-${kw} `) || a.includes(` ${kw}-`)) return city;
    }
  }
  return null;
}

/** ID do nó-cidade na árvore de projetos para a morada dada, ou null. */
export async function inferCityProjectIdFromAddress(address?: string | null): Promise<number | null> {
  const city = inferCityFromAddress(address);
  if (!city) return null;
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.level, "city"), eq(projects.name, city))).limit(1);
  return rows[0]?.id ?? null;
}

/** Auto-checkout de esquecimentos (regra do Jorge): quem tem check-in aberto há
 *  mais de 16h leva check-out automático 12h depois da entrada (turno máx.),
 *  sem horas extraordinárias, marcado [SUSPEITO] a vermelho para revisão.
 *  Corre no cron daily-ops. */
export async function autoCloseStaleCheckIns(): Promise<{ closed: number }> {
  const db = await getDb();
  if (!db) return { closed: 0 };
  // Último registo de cada colaborador; se for check_in com >16h, fecha.
  const [rows] = await db.execute(sql`
    SELECT t.id, t.employeeId, t.recordedAt
    FROM time_records t
    JOIN (
      SELECT employeeId, MAX(recordedAt) AS lastAt
      FROM time_records GROUP BY employeeId
    ) last ON last.employeeId = t.employeeId AND last.lastAt = t.recordedAt
    WHERE t.type = 'check_in' AND t.recordedAt < DATE_SUB(NOW(), INTERVAL 16 HOUR)
  `) as any;
  let closed = 0;
  for (const r of rows as any[]) {
    const outAt = new Date(new Date(r.recordedAt).getTime() + 12 * 3600000);
    await db.insert(timeRecords).values({
      employeeId: Number(r.employeeId),
      type: "check_out",
      recordedAt: outAt.toISOString().slice(0, 19).replace("T", " "),
      hoursWorked: "12.00",
      notes: "[SUSPEITO] check-out automático — entrada aberta há mais de 16h, cortado a 12h",
    } as any);
    closed++;
  }
  return { closed };
}

// ─── PASSAGEM DE TURNO (formulário dos team leaders, 2026-08-06) ─────────────
// Checklist de fim de turno: carros p/ coberto, caixas, bolsas, rolos MB,
// canetas, bateria, PDAs, fardamento + notas. 1 registo por (dia, turno, cidade).
// `clothingItems` (JSON, ver shared/clothing.ts) substitui `uniformsCount`
// desde 2026-09-09; a coluna antiga fica para os registos anteriores.
// A tabela é criada pela migration 0087 (drizzle/schema.ts `shiftHandovers`);
// todo o SQL está em server/shiftHandoverSql.ts, sempre parametrizado.

export async function saveShiftHandover(
  key: HandoverKey,
  data: HandoverInput,
  opts: { expectedVersion: number | null | undefined; userId: number; userName: string | null; canEditOld: boolean },
): Promise<{ mode: "insert" | "update"; changed: string[] }> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const [curRows] = await db.execute(buildHandoverCurrent(key)) as any;
  const cur = (curRows as any[])[0] ?? null;
  const decision = decideHandoverWrite(
    cur ? { version: Number(cur.version ?? 1), ageMinutes: Number(cur.ageMinutes ?? 0) } : null,
    opts.expectedVersion,
    opts.canEditOld,
  );
  if (!decision.ok) throw new TRPCError({ code: decision.code, message: decision.message });
  // Pendentes: a resolução é monotónica (um item resolvido pela passagem
  // seguinte não reabre por causa de um formulário antigo).
  if (cur && Array.isArray(data.openItems)) {
    data = { ...data, openItems: mergeStoredOpenItems(parseOpenItems(cur.openItems), data.openItems as OpenItem[]) };
  }
  const bound = handoverBoundValues(data);
  const before = cur ? handoverBoundValues(cur) : null;
  const changed = diffHandoverFields(before, bound);
  const who = { id: opts.userId, name: opts.userName };
  if (decision.mode === "insert") {
    try {
      await db.execute(buildHandoverInsert(key, data, who));
    } catch (err: any) {
      // Outra pessoa criou o mesmo (dia, turno, cidade) entre a leitura e a escrita.
      if ((err?.code ?? err?.cause?.code) === "ER_DUP_ENTRY") throw new TRPCError({ code: "CONFLICT", message: HANDOVER_EXISTS_MESSAGE });
      throw err;
    }
    return { mode: "insert", changed };
  }
  const [res] = await db.execute(buildHandoverUpdate(Number(cur.id), Number(opts.expectedVersion), data, who)) as any;
  if (Number(res?.affectedRows ?? 0) === 0) throw new TRPCError({ code: "CONFLICT", message: HANDOVER_CONFLICT_MESSAGE });
  return { mode: "update", changed };
}

export async function listShiftHandovers(opts: { from?: string; to?: string; city?: string } = {}) {
  const db = await getDb();
  if (!db) return [];
  const [rows] = await db.execute(buildHandoverList(opts, cityNameScope(sql`\`city\``))) as any;
  // `clothingItems` sai como JSON parseado e validado — o cliente nunca vê texto cru.
  return (rows as any[]).map(({ autoSummary, ...r }) => ({
    ...r,
    version: Number(r.version ?? 1),
    clothingItems: parseClothingItems(r.clothingItems),
    openItems: parseOpenItems(r.openItems),
    materialExceptions: parseMaterialExceptions(r.materialExceptions),
    // A fotografia do resumo automático (JSON grande) não vai na lista.
    hasAutoSummary: !!autoSummary,
  }));
}

/**
 * Tempos do painel do supervisor a partir do histórico (ao vivo):
 *  - pendente→entrega: 1.º PENDING_CHECKOUT no dia → 1.º CHECK_OUT (até 10 h depois);
 *  - atraso na recolha: 1.º CHECK_IN no dia vs entrada PREVISTA da reserva (±10 h).
 * Instantes UTC "YYYY-MM-DD HH:MM:SS". PURA.
 */
export function supervisorTimings(
  rows: Array<{ bookingExternalId: string; changeType: string | null; actionTime: string | null; agentName: string | null; checkIn: string | null }>,
  w: { start: string; end: string; checkoutEnd: string },
): { deliveryTimes: Array<{ booking: string; mins: number; agent: string | null }>; pickupDelays: number[] } {
  const ms = (t: string) => Date.parse(`${t.replace(" ", "T")}Z`);
  const pend = new Map<string, string>(), out = new Map<string, { t: string; agent: string | null }>(), cin = new Map<string, { t: string; planned: string | null }>();
  for (const r of rows) {
    const t = r.actionTime; const b = r.bookingExternalId;
    if (!t || !b) continue;
    const ct = (r.changeType ?? "").toUpperCase();
    if (ct === "PENDING_CHECKOUT" && t >= w.start && t < w.end) { if (!pend.has(b) || t < pend.get(b)!) pend.set(b, t); }
    else if (ct === "CHECK_OUT" && t >= w.start && t < w.checkoutEnd) {
      const e = out.get(b);
      if (!e || t < e.t) out.set(b, { t, agent: r.agentName ?? e?.agent ?? null });
    } else if (ct === "CHECK_IN" && t >= w.start && t < w.end) { if (!cin.has(b) || t < cin.get(b)!.t) cin.set(b, { t, planned: r.checkIn }); }
  }
  const deliveryTimes: Array<{ booking: string; mins: number; agent: string | null }> = [];
  for (const [b, t1] of pend) {
    const o = out.get(b);
    if (!o || o.t < t1) continue;
    const mins = Math.floor((ms(o.t) - ms(t1)) / 60_000);
    if (mins < 600) deliveryTimes.push({ booking: b, mins, agent: o.agent });
  }
  const pickupDelays: number[] = [];
  for (const { t, planned } of cin.values()) {
    if (!planned) continue;
    const mins = Math.trunc((ms(t) - ms(planned)) / 60_000);
    if (Number.isFinite(mins) && Math.abs(mins) < 600) pickupDelays.push(mins);
  }
  return { deliveryTimes, pickupDelays };
}

/** Resumo do dia do supervisor: condutores por turno, carros
 *  recolhidos/entregues, TEMPOS pendente→entrega e atraso na recolha
 *  (previsto vs real), e reclamações do dia.
 *  O "dia" é o dia OPERACIONAL de Lisboa: 03:00 → 03:00 do dia seguinte
 *  (manhã + noite inteira), convertido para UTC (as colunas são UTC). Tudo
 *  dentro das cidades do utilizador (ou da cidade pedida). */
export async function getSupervisorDayDashboard(date: string) {
  const db = await getDb();
  if (!db) return null;
  const { start, end, endMs } = operationalDayWindowUtc(date);
  // Entregas: o CHECK_OUT pode acontecer até 10h depois do pendente (o mesmo
  // limite do TIMESTAMPDIFF < 600 abaixo) — limite superior explícito.
  const checkoutEnd = new Date(endMs + 600 * 60_000).toISOString().slice(0, 19).replace("T", " ");

  // Movimentos AO VIVO da BD da Multipark ("History"; a cópia local está congelada desde o #141).
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  const { scopedCityNamesLive } = await import("./cityScope");
  const hist = await readLiveHistory({ changeTypes: ["PENDING_CHECKOUT", "CHECK_OUT", "CHECK_IN"], from: start, to: checkoutEnd, cities: scopedCityNamesLive(), limit: 5000, order: "asc" });
  const { deliveryTimes, pickupDelays } = supervisorTimings(hist, { start, end, checkoutEnd });
  deliveryTimes.sort((a, b) => b.mins - a.mins);
  const dAvg = deliveryTimes.length ? Math.round(deliveryTimes.reduce((s, r) => s + r.mins, 0) / deliveryTimes.length) : 0;

  const late = pickupDelays.filter((m) => m > 15).length;
  const pAvg = pickupDelays.length ? Math.round(pickupDelays.reduce((s, m) => s + m, 0) / pickupDelays.length) : 0;

  // Reclamações criadas no mesmo dia operacional
  const [[compl]] = await db.execute(sql`SELECT COUNT(*) n FROM complaints
    WHERE createdAt >= ${start} AND createdAt < ${end} AND ${projectScope(sql`complaints.projectId`)}`) as any;

  // Condutores por turno (escala extras-dia do dia + ações)
  const dayActivity = await getDayActivity(date);
  const assignments = await db.select({
    personName: extrasDiaAssignments.personName,
    shift: extrasDiaAssignments.shift,
    city: extrasDiaAssignments.city,
    employeeId: extrasDiaAssignments.employeeId,
    startHour: extrasDiaAssignments.startHour,
    endHour: extrasDiaAssignments.endHour,
    isTeamLeader: extrasDiaAssignments.isTeamLeader,
  }).from(extrasDiaAssignments).where(and(eq(extrasDiaAssignments.assignmentDate, date), cityNameScope(extrasDiaAssignments.city)));

  return {
    date,
    window: { start, end },
    totals: dayActivity.totals,
    people: dayActivity.people,
    shifts: assignments,
    delivery: {
      count: deliveryTimes.length,
      avgMins: dAvg,
      maxMins: deliveryTimes[0]?.mins ?? 0,
      over15: deliveryTimes.filter((r) => r.mins > 15).length,
      over30: deliveryTimes.filter((r) => r.mins > 30).length,
      worst: deliveryTimes.slice(0, 8),
    },
    pickup: {
      count: pickupDelays.length,
      avgDelayMins: pAvg,
      over15: late,
    },
    complaintsToday: Number((compl as any)?.n ?? 0),
  };
}

// ─── LIGAÇÃO AGENTE→PARCEIRO (agências que marcam pelo portal de agentes) ────
// Alguns "agentes" Multipark são agências de viagens/parceiros, não
// colaboradores. Este mapa liga o agentName ao partnership. Tabela on-demand.
let agentPartnerEnsured = false;
async function ensureAgentPartnerTable() {
  if (agentPartnerEnsured) return;
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS \`agent_partner_map\` (
    \`agentName\` VARCHAR(256) NOT NULL,
    \`partnershipId\` INT NOT NULL,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`agentName\`)
  )`);
  agentPartnerEnsured = true;
}

export async function setAgentPartner(agentName: string, partnershipId: number | null) {
  const db = await getDb();
  if (!db) return;
  await ensureAgentPartnerTable();
  if (partnershipId == null) {
    await db.execute(sql`DELETE FROM \`agent_partner_map\` WHERE \`agentName\` = ${agentName}`);
  } else {
    await db.execute(sql`INSERT INTO \`agent_partner_map\` (\`agentName\`, \`partnershipId\`) VALUES (${agentName}, ${partnershipId})
      ON DUPLICATE KEY UPDATE \`partnershipId\` = VALUES(\`partnershipId\`)`);
  }
}

export async function listAgentPartners(): Promise<Array<{ agentName: string; partnershipId: number; partnerName: string | null }>> {
  const db = await getDb();
  if (!db) return [];
  await ensureAgentPartnerTable();
  const [rows] = await db.execute(sql`
    SELECT m.agentName, m.partnershipId, p.name AS partnerName
    FROM \`agent_partner_map\` m LEFT JOIN partnerships p ON p.id = m.partnershipId`) as any;
  return (rows as any[]).map((r) => ({ agentName: r.agentName, partnershipId: Number(r.partnershipId), partnerName: r.partnerName ?? null }));
}

// ─── PERMISSÕES POR UTILIZADOR (grant/deny além do role) ─────────────────────
// Pedido Jorge 2026-08-06: "mais permissões ou menos permissões por utilizador".
// O catálogo das permissões especiais vive em shared/permissions.ts; os
// overrides de MÓDULO (chave `module.<id>`, migração 0100) na mesma tabela.
// A tabela nasce pela migração 0100 (ensureRecentSchema); o CREATE aqui fica
// como rede de segurança para bases antigas.
let userPermsEnsured = false;
async function ensureUserPermissionsTable() {
  if (userPermsEnsured) return;
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS \`user_permissions\` (
    \`userId\` INT NOT NULL,
    \`permission\` VARCHAR(64) NOT NULL,
    \`mode\` ENUM('grant','deny') NOT NULL,
    \`grantedBy\` INT NULL,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    \`scope\` VARCHAR(16) NULL,
    \`actions\` VARCHAR(8) NULL,
    \`expiresOn\` DATE NULL,
    \`note\` VARCHAR(255) NULL,
    \`createdAt\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`userId\`, \`permission\`),
    KEY \`idx_user_permissions_permission\` (\`permission\`)
  )`);
  userPermsEnsured = true;
}

/** DATE do mysql2 (Date ou string) → "YYYY-MM-DD" (a data "de calendário", sem fuso). */
function dayString(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

export function toPermissionRow(r: any): PermissionRow {
  return {
    permission: String(r.permission),
    mode: r.mode === "deny" ? "deny" : "grant",
    scope: r.scope == null ? null : String(r.scope),
    actions: r.actions == null ? null : String(r.actions),
    expiresOn: dayString(r.expiresOn),
  };
}

/** Todas as linhas de user_permissions da pessoa (memorizadas por pedido). */
export async function getUserPermissionRows(userId: number): Promise<PermissionRow[]> {
  const load = async () => {
    const db = await getDb();
    if (!db) return [];
    await ensureUserPermissionsTable();
    const [rows] = await db.execute(sql`SELECT permission, mode, scope, actions, expiresOn
      FROM \`user_permissions\` WHERE userId = ${userId}`) as any;
    return ((rows as any[]) ?? []).map(toPermissionRow);
  };
  return cachedPermissionRows(userId, load) ?? load();
}

export async function setUserPermission(userId: number, permission: string, mode: "grant" | "deny" | null, grantedBy?: number) {
  const db = await getDb();
  if (!db) return;
  await ensureUserPermissionsTable();
  if (mode == null) {
    await db.execute(sql`DELETE FROM \`user_permissions\` WHERE userId = ${userId} AND permission = ${permission}`);
  } else {
    await db.execute(sql`INSERT INTO \`user_permissions\` (userId, permission, mode, grantedBy)
      VALUES (${userId}, ${permission}, ${mode}, ${grantedBy ?? null})
      ON DUPLICATE KEY UPDATE mode = VALUES(mode), grantedBy = VALUES(grantedBy)`);
  }
}

/** Permissões especiais (não os módulos) da pessoa, só as que ainda valem. */
export async function getUserPermissionOverrides(userId: number): Promise<Record<string, "grant" | "deny">> {
  const today = lisbonToday();
  const out: Record<string, "grant" | "deny"> = {};
  for (const r of await getUserPermissionRows(userId)) {
    if (r.permission.startsWith("module.")) continue;
    if (r.expiresOn && r.expiresOn < today) continue;
    out[r.permission] = r.mode;
  }
  return out;
}

/** Overrides de MÓDULO ativos da pessoa (os expirados não contam). */
export async function getUserModuleOverrides(userId: number): Promise<AccessOverrides> {
  return moduleOverridesFromRows(await getUserPermissionRows(userId), lisbonToday());
}

export function moduleOverridesFromRows(rows: PermissionRow[], today: string): AccessOverrides {
  const out: AccessOverrides = {};
  for (const r of rows) {
    const o = moduleOverrideFromRow(r);
    if (o && overrideActive(o.override, today)) out[o.module] = o.override;
  }
  return out;
}

export function moduleOverrideFromRow(r: Pick<PermissionRow, "permission" | "mode" | "scope" | "actions" | "expiresOn">): { module: ModuleId; override: ModuleOverride } | null {
  if (!r.permission.startsWith("module.")) return null;
  const module = r.permission.slice("module.".length);
  if (!isModuleId(module)) return null;
  const access = (ACCESS_VALUES as readonly string[]).includes(String(r.scope)) ? r.scope as Access : "none";
  const override: ModuleOverride = r.mode === "deny" || access === "none"
    ? { access: "none", actions: [], expiresOn: r.expiresOn }
    : { access, actions: normalizeGrant({ access, actions: lettersToActions(r.actions) }).actions, expiresOn: r.expiresOn };
  return { module, override };
}

export interface ModuleOverrideRecord {
  module: ModuleId;
  override: ModuleOverride;
  note: string | null;
  grantedBy: number | null;
  grantedByName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Overrides de módulo da pessoa (incluindo expirados), com quem deu e quando. */
export async function listModuleOverridesForUser(userId: number): Promise<ModuleOverrideRecord[]> {
  const db = await getDb();
  if (!db) return [];
  await ensureUserPermissionsTable();
  const [rows] = await db.execute(sql`
    SELECT p.permission, p.mode, p.scope, p.actions, p.expiresOn, p.note, p.grantedBy, p.createdAt, p.updatedAt,
      g.name AS grantedByName
    FROM \`user_permissions\` p LEFT JOIN users g ON g.id = p.grantedBy
    WHERE p.userId = ${userId} AND p.permission LIKE ${"module.%"}`) as any;
  const out: ModuleOverrideRecord[] = [];
  for (const r of (rows as any[]) ?? []) {
    const o = moduleOverrideFromRow(toPermissionRow(r));
    if (!o) continue;
    out.push({
      ...o,
      note: r.note == null ? null : String(r.note),
      grantedBy: r.grantedBy == null ? null : Number(r.grantedBy),
      grantedByName: r.grantedByName == null ? null : String(r.grantedByName),
      createdAt: r.createdAt == null ? null : toMysqlDateTime(r.createdAt),
      updatedAt: r.updatedAt == null ? null : toMysqlDateTime(r.updatedAt),
    });
  }
  return out;
}

/**
 * Grava (ou apaga, com `value` null = repor o padrão) o override de um módulo.
 * Devolve o que lá estava (para o registo de atividade).
 */
export async function setModuleOverride(userId: number, module: ModuleId, value: ModuleOverride | null, grantedBy: number, note?: string | null): Promise<ModuleOverride | null> {
  const db = await getDb();
  if (!db) return null;
  await ensureUserPermissionsTable();
  const key = moduleOverrideKey(module);
  const [prevRows] = await db.execute(sql`SELECT permission, mode, scope, actions, expiresOn
    FROM \`user_permissions\` WHERE userId = ${userId} AND permission = ${key}`) as any;
  const prevRow = ((prevRows as any[]) ?? [])[0];
  const prev = prevRow ? moduleOverrideFromRow(toPermissionRow(prevRow))?.override ?? null : null;
  if (!value) {
    await db.execute(sql`DELETE FROM \`user_permissions\` WHERE userId = ${userId} AND permission = ${key}`);
    return prev;
  }
  const g = normalizeGrant(value);
  const mode = g.access === "none" ? "deny" : "grant";
  const letters = g.access === "none" ? "" : actionsToLetters(g.actions);
  const expiresOn = value.expiresOn ? String(value.expiresOn).slice(0, 10) : null;
  const cleanNote = note?.trim() ? note.trim().slice(0, 255) : null;
  await db.execute(sql`INSERT INTO \`user_permissions\` (userId, permission, mode, grantedBy, scope, actions, expiresOn, note)
    VALUES (${userId}, ${key}, ${mode}, ${grantedBy}, ${g.access}, ${letters}, ${expiresOn}, ${cleanNote})
    ON DUPLICATE KEY UPDATE mode = VALUES(mode), grantedBy = VALUES(grantedBy), scope = VALUES(scope),
      actions = VALUES(actions), expiresOn = VALUES(expiresOn), note = VALUES(note), createdAt = CURRENT_TIMESTAMP`);
  return prev;
}

/**
 * "Quem tem acesso a X": contas ativas (no âmbito de cidade do pedido) com o
 * override desse módulo, se houver. O acesso efetivo calcula-se em JS
 * (papel + override) — uma só consulta, sem GROUP BY.
 */
export async function listUsersWithModuleOverride(module: ModuleId): Promise<Array<{
  id: number; name: string | null; email: string | null; role: string; override: ModuleOverride | null; overrideExpired: boolean;
}>> {
  const db = await getDb();
  if (!db) return [];
  await ensureUserPermissionsTable();
  const key = moduleOverrideKey(module);
  const today = lisbonToday();
  const [rows] = await db.execute(sql`
    SELECT u.id, u.name, u.email, u.role, p.permission, p.mode, p.scope, p.actions, p.expiresOn
    FROM users u LEFT JOIN \`user_permissions\` p ON p.userId = u.id AND p.permission = ${key}
    WHERE u.isActive = 1 AND ${userScope(sql`u.id`)}
    ORDER BY u.name, u.id`) as any;
  return ((rows as any[]) ?? []).map((r) => {
    const o = r.permission ? moduleOverrideFromRow(toPermissionRow(r))?.override ?? null : null;
    return {
      id: Number(r.id), name: r.name ?? null, email: r.email ?? null, role: String(r.role ?? "user"),
      override: o, overrideExpired: !!o && !overrideActive(o, today),
    };
  });
}

/** Contas ativas no âmbito de cidade do pedido (para escolher a quem dar acessos). */
export async function listActiveUsersInScope(): Promise<Array<{ id: number; name: string | null; email: string | null; role: string }>> {
  const db = await getDb();
  if (!db) return [];
  const [rows] = await db.execute(sql`SELECT u.id, u.name, u.email, u.role FROM users u
    WHERE u.isActive = 1 AND ${userScope(sql`u.id`)} ORDER BY u.name, u.id`) as any;
  return ((rows as any[]) ?? []).map((r) => ({ id: Number(r.id), name: r.name ?? null, email: r.email ?? null, role: String(r.role ?? "user") }));
}

export async function listPermissionAssignments(): Promise<Array<{ userId: number; permission: string; mode: "grant" | "deny"; userName: string | null; userEmail: string | null }>> {
  const db = await getDb();
  if (!db) return [];
  await ensureUserPermissionsTable();
  // Só as permissões especiais — os overrides de módulo têm a sua vista.
  const [rows] = await db.execute(sql`
    SELECT p.userId, p.permission, p.mode, u.name AS userName, u.email AS userEmail
    FROM \`user_permissions\` p LEFT JOIN users u ON u.id = p.userId
    WHERE p.permission NOT LIKE ${"module.%"}
    ORDER BY p.permission, u.name`) as any;
  return ((rows as any[]) ?? []).map((r) => ({
    userId: Number(r.userId),
    permission: String(r.permission),
    mode: r.mode === "deny" ? "deny" as const : "grant" as const,
    userName: r.userName ? String(r.userName) : null,
    userEmail: r.userEmail ? String(r.userEmail) : null,
  }));
}

/** userIds com grant de uma permissão (para filtros, ex.: TL elegíveis). */
export async function listUserIdsWithGrant(permission: string): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  await ensureUserPermissionsTable();
  const [rows] = await db.execute(sql`SELECT userId FROM \`user_permissions\` WHERE permission = ${permission} AND mode = 'grant'`) as any;
  return ((rows as any[]) ?? []).map((r) => Number(r.userId));
}

// ─── AGENTES IGNORADOS ("não é funcionário") ─────────────────────────────────
// Alguns "agentes" do histórico não são pessoas nem parceiros: testes,
// integrações, reservas de sistema. O Jorge marca-os como "não é funcionário"
// e saem da lista de agentes por ligar. Tabela on-demand.
let agentIgnoreEnsured = false;
async function ensureAgentIgnoreTable() {
  if (agentIgnoreEnsured) return;
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS \`agent_ignore_list\` (
    \`agentName\` VARCHAR(256) NOT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`agentName\`)
  )`);
  agentIgnoreEnsured = true;
}

export async function setAgentIgnored(agentName: string, ignored: boolean) {
  const db = await getDb();
  if (!db) return;
  await ensureAgentIgnoreTable();
  if (ignored) {
    await db.execute(sql`INSERT IGNORE INTO \`agent_ignore_list\` (\`agentName\`) VALUES (${agentName})`);
  } else {
    await db.execute(sql`DELETE FROM \`agent_ignore_list\` WHERE \`agentName\` = ${agentName}`);
  }
}

export async function listIgnoredAgents(): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  await ensureAgentIgnoreTable();
  const [rows] = await db.execute(sql`SELECT agentName FROM \`agent_ignore_list\``) as any;
  return (rows as any[]).map((r) => String(r.agentName));
}

/**
 * Última vez que cada colaborador trabalhou (pedido Jorge: mostrar nos cartões
 * dos extras). Máximo entre: ações reais no histórico Multipark (via agente
 * ligado), picagens de ponto e atribuições de extras-dia. Devolve
 * { employeeId: "YYYY-MM-DD" }.
 */
export async function getLastWorkedMap(): Promise<Record<number, string>> {
  const db = await getDb();
  if (!db) return {};
  const out: Record<number, string> = {};
  const day = (d: any): string | null => {
    if (!d) return null;
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    const s = String(d);
    return s.length >= 10 ? s.slice(0, 10) : null;
  };
  const take = (id: any, d: any) => {
    const k = Number(id);
    const s = day(d);
    if (!k || !s) return;
    if (!out[k] || s > out[k]) out[k] = s;
  };
  // Última ação de cada agente AO VIVO (BD da Multipark, últimos 180 dias).
  const { listLiveAgents } = await import("./multiparkDb/activityLive");
  const agents = await listLiveAgents();
  const lastById = new Map<string, string>(), lastByName = new Map<string, string>();
  if (agents.available) {
    for (const a of agents.data) {
      if (!a.lastSeen) continue;
      lastById.set(a.agentUserId, a.lastSeen);
      for (const n of a.agentNames) { const k = n.trim().toLowerCase(); if (!lastByName.has(k) || a.lastSeen > lastByName.get(k)!) lastByName.set(k, a.lastSeen); }
    }
  }
  const [emps] = await db.execute(sql`SELECT id, multiparkAgentUserId, multiparkAgentName FROM employees
    WHERE (multiparkAgentUserId IS NOT NULL AND multiparkAgentUserId != '') OR (multiparkAgentName IS NOT NULL AND multiparkAgentName != '')`) as any;
  for (const e of (emps as any[]) ?? []) {
    if (e.multiparkAgentUserId) take(e.id, lastById.get(String(e.multiparkAgentUserId)));
    if (e.multiparkAgentName) take(e.id, lastByName.get(String(e.multiparkAgentName).trim().toLowerCase()));
  }
  const [ponto] = await db.execute(sql`
    SELECT employeeId id, MAX(recordedAt) d FROM time_records GROUP BY employeeId`) as any;
  for (const r of (ponto as any[]) ?? []) take(r.id, r.d);
  const [extras] = await db.execute(sql`
    SELECT employeeId id, MAX(assignmentDate) d FROM extras_dia_assignments
    WHERE employeeId IS NOT NULL GROUP BY employeeId`) as any;
  for (const r of (extras as any[]) ?? []) take(r.id, r.d);
  try {
    const [aliasAgents] = await db.execute(sql`SELECT employeeId id, agentUserId FROM employee_agents`) as any;
    for (const r of (aliasAgents as any[]) ?? []) take(r.id, lastById.get(String(r.agentUserId)));
  } catch { /* tabela ainda não criada */ }
  return out;
}

/** Atividade consolidada de um dia (ou intervalo) — ver server/dayActivity.ts.
 *  Mantém-se aqui o nome (o painel do supervisor e os testes usam-no). */
export async function getDayActivity(date: string, opts: { endDate?: string; canSeeCost?: boolean } = {}) {
  const { getActivityRange } = await import("./dayActivity");
  return getActivityRange({ startDate: date, endDate: opts.endDate, canSeeCost: opts.canSeeCost });
}

// ─── GEOFENCE POR CENTRO DE CUSTOS (raio de check-in/out do ponto) ───────────
// O Jorge define, por centro de custos, o ponto e o raio onde o pessoal pode
// picar. Fora do raio o ponto é PERMITIDO mas fica marcado a vermelho.
let geofenceEnsured = false;
async function ensureGeofenceTable() {
  if (geofenceEnsured) return;
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS \`project_geofence\` (
    \`projectId\` INT NOT NULL,
    \`lat\` DECIMAL(10,7) NOT NULL,
    \`lng\` DECIMAL(10,7) NOT NULL,
    \`radiusM\` INT NOT NULL DEFAULT 500,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`projectId\`)
  )`);
  geofenceEnsured = true;
}

export async function setProjectGeofence(projectId: number, lat: number, lng: number, radiusM: number) {
  const db = await getDb();
  if (!db) return;
  await ensureGeofenceTable();
  await db.execute(sql`INSERT INTO \`project_geofence\` (\`projectId\`, \`lat\`, \`lng\`, \`radiusM\`)
    VALUES (${projectId}, ${lat}, ${lng}, ${radiusM})
    ON DUPLICATE KEY UPDATE \`lat\` = VALUES(\`lat\`), \`lng\` = VALUES(\`lng\`), \`radiusM\` = VALUES(\`radiusM\`)`);
}

export async function deleteProjectGeofence(projectId: number) {
  const db = await getDb();
  if (!db) return;
  await ensureGeofenceTable();
  await db.execute(sql`DELETE FROM \`project_geofence\` WHERE \`projectId\` = ${projectId}`);
}

export async function listProjectGeofences(): Promise<Array<{ projectId: number; lat: number; lng: number; radiusM: number }>> {
  const db = await getDb();
  if (!db) return [];
  await ensureGeofenceTable();
  const [rows] = await db.execute(sql`SELECT * FROM \`project_geofence\``) as any;
  return (rows as any[]).map((r) => ({ projectId: Number(r.projectId), lat: Number(r.lat), lng: Number(r.lng), radiusM: Number(r.radiusM) }));
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Se o centro de custos do colaborador (ou um ancestral) tem raio definido e as
 *  coordenadas vêm fora dele, devolve a nota "[FORA DO RAIO] a Xm" — senão null. */
export async function checkGeofenceNote(employeeId: number, latitude?: string | null, longitude?: string | null): Promise<string | null> {
  try {
    if (!latitude || !longitude) return null;
    const lat = parseFloat(latitude), lng = parseFloat(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const db = await getDb();
    if (!db) return null;
    const emp = await db.select({ projectId: employees.projectId }).from(employees).where(eq(employees.id, employeeId)).limit(1);
    let pid = emp[0]?.projectId ?? null;
    if (pid == null) return null;
    const fences = await listProjectGeofences();
    if (fences.length === 0) return null;
    const byProject = new Map(fences.map((f) => [f.projectId, f]));
    const allProjs = await db.select({ id: projects.id, parentId: projects.parentId }).from(projects);
    const parentOf = new Map(allProjs.map((p) => [p.id, p.parentId]));
    // Sobe na árvore até encontrar um geofence configurado
    let hops = 0;
    while (pid != null && hops < 10) {
      const fence = byProject.get(pid);
      if (fence) {
        const dist = haversineMeters(lat, lng, fence.lat, fence.lng);
        if (dist > fence.radiusM) return `[FORA DO RAIO] a ${Math.round(dist)}m do local (raio ${fence.radiusM}m)`;
        return null;
      }
      pid = parentOf.get(pid) ?? null;
      hops++;
    }
    return null;
  } catch {
    return null; // geofence nunca pode partir o ponto
  }
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

// Mapa central campanha→parceiro — a MESMA regra do motor financeiro
// (R.buildPartnerIndex via ./finance/partners.ts). Cacheado 60s para não pesar
// nas folhas operacionais.
type CampaignPartner = { id: number; name: string; commissionRate: number; commissionBase: "net" | "gross"; partnerType: string | null; updatedAt: string };
let partnerMapCache: { at: number; map: Map<string, CampaignPartner> } | null = null;
export async function buildPartnerByCampaignMap() {
  if (partnerMapCache && Date.now() - partnerMapCache.at < 60_000) return partnerMapCache.map;
  const map = new Map<string, CampaignPartner>();
  const db = await getDb();
  if (!db) return map;
  const { loadPartnerIndex } = await import("./finance/partners");
  const { commissionBaseOf } = await import("./finance/rules");
  const { index } = await loadPartnerIndex(db);
  for (const [key, p] of index.byKey) {
    map.set(key, { id: p.id, name: p.name, commissionRate: Number(p.commissionRate ?? 0), commissionBase: commissionBaseOf(p), partnerType: p.partnerType ?? null, updatedAt: p.updatedAt });
  }
  partnerMapCache = { at: Date.now(), map };
  return map;
}

/** Resumo agregado das operações (dashboard): contagens/somas por ação e
 *  distribuição por cidade/parque, calculado no SQL — substitui puxar até
 *  4×5.000 reservas completas só para contar. */
export async function getOperationsSummary(filters: { startDate: string; endDate: string; projectId?: number }) {
  // Ao vivo na BD da Multipark (reservas ao vivo, parte B): contagens por dia × parque.
  const { liveOperationsSummary } = await import("./opsStatsLive");
  return liveOperationsSummary(filters);
}

export async function searchBookingByRef(search: string) {
  // Ao vivo na BD da Multipark (29 set 2026), só nas cidades de quem pede.
  const { searchLiveBookings, requestCities } = await import("./multiparkDb/bookingSearch");
  try {
    return await searchLiveBookings({ text: search }, { cities: await requestCities(), limit: 10 });
  } catch (err) {
    console.warn("[searchBookingByRef] BD da Multipark:", (err as Error)?.message);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Pesquisa de reservas indisponível (BD da Multipark sem resposta)." });
  }
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
  const statusChanged = existed && data.status != null && (before[0].status ?? null) !== data.status;
  const setOnDup: any = statusChanged ? { ...rest, enrichedAt: null, detailRetryAt: null, historyFetchedAt: null, historyRetryAt: null } : rest;
  // NUNCA sobrepor um valor real com vazio nos campos que só vêm do
  // enrichment (/bookings/:id): o /report não traz cliente/veículo/voos/
  // parceiro-real, e cada re-varredura da janela apagava o que o enrichment
  // tinha preenchido (a perda ficava PERMANENTE quando não havia mudança de
  // estado para reabrir o enrichment). Era por isto que só ~20% das reservas
  // tinham dados de cliente/matrícula.
  // `campaign` também: depois de o enrichment/resolver de aliases atribuir a
  // reserva a um parceiro, um /report posterior (sem partnerName real nem
  // alias) devolvia null e a reserva "fugia" do parceiro (drift de atribuição).
  const ENRICH_PROTECTED = [
    "partnerName", "campaign",
    "clientFirstName", "clientLastName", "clientEmail", "clientPhone", "clientNif",
    "licensePlate", "vehicleBrand", "vehicleModel", "vehicleColor", "vehicleType",
    "arrivalFlight", "departureFlight",
    "deliveryAddress", "pickupAddress",
    "checkInTime", "checkOutTime", "parkingType", "notes",
  ] as const;
  for (const k of ENRICH_PROTECTED) {
    if (setOnDup[k] === null || setOnDup[k] === undefined) delete setOnDup[k];
  }
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
  // Preserva "feito" marcado NA APP: o delete+insert do re-sync não pode
  // desmarcar serviços dados como feitos localmente (a API pode vir done=0).
  const existing = await db
    .select({ extraId: multiparkBookingExtras.extraId, name: multiparkBookingExtras.name, done: multiparkBookingExtras.done })
    .from(multiparkBookingExtras)
    .where(eq(multiparkBookingExtras.bookingExternalId, bookingExternalId));
  const doneLocally = new Set(
    existing.filter((e) => e.done === 1).map((e) => `${e.extraId ?? ""}|${e.name ?? ""}`),
  );
  await db.delete(multiparkBookingExtras).where(eq(multiparkBookingExtras.bookingExternalId, bookingExternalId));
  await db.insert(multiparkBookingExtras).values(
    extras.map((e) => ({
      bookingExternalId,
      extraId: e.id ? String(e.id).slice(0, 128) : null,
      name: typeof e.name === "string" ? e.name.slice(0, 256) : null,
      description: typeof e.description === "string" ? e.description.slice(0, 512) : null,
      price: e.price != null ? String(e.price) : null,
      done: (e.done || doneLocally.has(`${e.id ? String(e.id).slice(0, 128) : ""}|${typeof e.name === "string" ? e.name.slice(0, 256) : ""}`)) ? 1 : 0,
    })),
  );
}

export async function getMultiparkBookingStats(filters?: { from?: string; to?: string; projectId?: number }) {
  // Ao vivo na BD da Multipark (reservas ao vivo, parte B), só dos parques das cidades de quem pede.
  const { liveBookingStats } = await import("./opsStatsLive");
  return liveBookingStats(filters);
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

/**
 * Reclama o convite de forma ATÓMICA (uso único): só passa de `pending` para
 * `accepted` uma vez. Devolve true se foi este pedido que o reclamou.
 */
export async function claimInviteToken(token: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [res] = await (db as any).execute(sql`
    UPDATE invite_tokens SET invite_status = 'accepted', acceptedAt = ${toMysqlDateTime(new Date())}
    WHERE token = ${token} AND invite_status = 'pending'`);
  return Number(res?.affectedRows ?? 0) === 1;
}

/** Devolve um convite reclamado a `pending` (a ligação da conta falhou). */
export async function releaseInviteToken(token: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(inviteTokens).set({ inviteStatus: "pending", acceptedAt: null }).where(eq(inviteTokens.token, token));
}

/** Nº de super_admin ATIVOS (guarda do último super_admin). */
export async function countActiveSuperAdmins(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [rows] = await (db as any).execute(sql`SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND isActive = 1`);
  return Number(rows?.[0]?.n ?? 0);
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
    // Fase 1: a ficha segue a conta que fica (antes ficava presa à desativada)
    await db.update(employees).set({ userId: oauthRow.id }).where(eq(employees.userId, manualUserId));
    return;
  }

  // Update the manual user's openId to the OAuth user's openId so they can log in
  const updates: Record<string, any> = { openId: oauthOpenId, loginMethod: "oauth" };
  if (oauthName) updates.name = oauthName;
  if (oauthEmail) updates.email = normalizeEmail(oauthEmail);
  await db.update(users).set(updates).where(eq(users.id, manualUserId));
}


// ─── PAYROLL ──────────────────────────────────────────────────────────────────
// O cálculo vive em server/payroll/ (shifts.ts + compute.ts puros e testados;
// payrollData.ts recolhe). Esta função mantém o nome/assinatura para os
// consumidores (folha, recibos, dashboard RH, motor financeiro).
export async function getPayrollData(year: number, month: number, opts: { projectId?: number | null } = {}) {
  const { computePayrollForMonth } = await import("./payroll/payrollData");
  return computePayrollForMonth(year, month, opts);
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

  const { loadExtraRates, rateFor } = await import("./extraRates");
  const liveExtraRates = await loadExtraRates();
  const rateForExtra = (level: number) => rateFor(liveExtraRates, level);

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
        // nível do extra = employees.extraLevel (antes lia `position`, que é texto → sempre 6 €)
        const hourlyRate = rateForExtra(emp.extraLevel ?? 1);
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

/**
 * Funcionário dono de cada utilizador Zello num dia (Lisboa): quem teve o PDA
 * desse Zello mais tempo nesse dia (check-ins de PDA, partilhados entre
 * turnos); sem check-in, o Zello fixo da ficha (`employees.zelloUsername`).
 */
/** Intervalos (ms) em que cada pessoa teve cada Zello/PDA num dia de LISBOA. */
export async function pdaIntervalsForDay(dateStr: string): Promise<Map<string, { employeeId: number; start: number; end: number }[]>> {
  const db = await getDb();
  const out = new Map<string, { employeeId: number; start: number; end: number }[]>();
  if (!db) return out;
  const { startMs: dayStart, endMs: dayEnd } = lisbonDayRangeUtc(dateStr);
  const [rows] = await db.execute(sql`
    SELECT zelloUsername AS zello, employeeId, checkinAt, checkoutAt FROM pda_checkins
     WHERE zelloUsername IS NOT NULL AND employeeId IS NOT NULL
       AND checkinAt < ${toMysqlDateTime(new Date(dayEnd))}
       AND (checkoutAt IS NULL OR checkoutAt >= ${toMysqlDateTime(new Date(dayStart))})`) as any;
  const toMs = (v: any) => (v instanceof Date ? v.getTime() : Date.parse(String(v).replace(" ", "T") + "Z"));
  for (const r of (rows as any[]) ?? []) {
    const start = Math.max(toMs(r.checkinAt), dayStart);
    const end = Math.min(r.checkoutAt ? toMs(r.checkoutAt) : Date.now(), dayEnd);
    if (end <= start) continue;
    const list = out.get(String(r.zello)) ?? [];
    list.push({ employeeId: Number(r.employeeId), start, end });
    out.set(String(r.zello), list);
  }
  return out;
}

/** Grava (substitui) as partes do GPS de uma linha do histórico diário. */
export async function saveDriverShares(historyId: number, zello: string, day: string, shares: { employeeId: number; minutes: number; movingMinutes?: number | null; km: number; maxSpeed: number; avgSpeed: number; violations: number; points: number }[]): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`DELETE FROM driver_day_shares WHERE historyId = ${historyId}`);
  for (const s of shares) {
    await db.execute(sql`INSERT INTO driver_day_shares (historyId, zelloUsername, day, employeeId, minutes, movingMinutes, km, maxSpeed, avgSpeed, violations, points)
      VALUES (${historyId}, ${zello}, ${day}, ${s.employeeId}, ${s.minutes}, ${s.movingMinutes ?? null}, ${String(s.km)}, ${String(s.maxSpeed)}, ${String(s.avgSpeed)}, ${s.violations}, ${s.points})`);
  }
}

export async function resolveZelloHoldersForDay(dateStr: string): Promise<Map<string, number>> {
  const db = await getDb();
  const out = new Map<string, number>();
  if (!db) return out;
  const { startMs: dayStart, endMs: dayEnd } = lisbonDayRangeUtc(dateStr);
  const fixed = await db.select({ id: employees.id, zello: employees.zelloUsername }).from(employees).where(isNotNull(employees.zelloUsername));
  for (const e of fixed) if (e.zello && !out.has(e.zello)) out.set(e.zello, e.id);
  const [rows] = await db.execute(sql`
    SELECT zelloUsername AS zello, employeeId, checkinAt, checkoutAt FROM pda_checkins
     WHERE zelloUsername IS NOT NULL AND employeeId IS NOT NULL
       AND checkinAt < ${toMysqlDateTime(new Date(dayEnd))}
       AND (checkoutAt IS NULL OR checkoutAt >= ${toMysqlDateTime(new Date(dayStart))})`) as any;
  const toMs = (v: any) => (v instanceof Date ? v.getTime() : Date.parse(String(v).replace(" ", "T") + "Z"));
  const { holdersForDay } = await import("./zelloGps");
  const byDay = holdersForDay(
    ((rows as any[]) ?? []).map((r) => ({ zello: r.zello, employeeId: Number(r.employeeId), start: toMs(r.checkinAt), end: r.checkoutAt ? toMs(r.checkoutAt) : null })),
    dayStart,
    dayEnd,
  );
  for (const [z, id] of byDay) out.set(z, id); // o PDA do dia ganha ao Zello fixo
  return out;
}

export async function createDailyDriverHistory(data: InsertDailyDriverHistory) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [result] = await db.insert(dailyDriverHistory).values(data);
  return result.insertId;
}

/**
 * Resolve a PESSOA de cada linha do histórico Zello (Histórico Diário).
 *
 * Mesma atribuição da Atividade do Dia — nada de "o último check-in ganha":
 *   1. partes do GPS (driver_day_shares): PDA partilhado → cada pessoa com os
 *      seus km/minutos; o nome da linha junta-as (a de mais km primeiro);
 *   2. o funcionário gravado na linha (quem teve o PDA mais tempo no dia);
 *   3. o Zello fixo da ficha (`employees.zelloUsername`, telemóveis pessoais).
 * Sem nenhum, `employeeName` fica null e a UI mostra o nome Zello.
 */
async function withEmployeeNames<T extends { id: number; zelloUsername: string; employeeId: number | null; totalKm?: string | null }>(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  rows: T[],
): Promise<(T & { employeeName: string | null; resolvedEmployeeId: number | null; shares: { employeeId: number; name: string; km: number; minutes: number; movingMinutes: number | null }[]; leftoverKm: number })[]> {
  if (rows.length === 0) return [];
  const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];
  const ids = rows.map((r) => Number(r.id));
  const shareRows = rowsOf(await db.execute(sql`
    SELECT historyId, employeeId, km, minutes, movingMinutes FROM driver_day_shares
     WHERE historyId IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`).catch(() => [[]] as any));
  const zellos = [...new Set(rows.map((r) => r.zelloUsername).filter(Boolean))];
  const persistent = zellos.length
    ? await db.select({ id: employees.id, zello: employees.zelloUsername }).from(employees).where(inArray(employees.zelloUsername, zellos))
    : [];
  const byZello = new Map(persistent.map((e) => [e.zello!, e.id]));
  const empIds = [...new Set([
    ...rows.map((r) => r.employeeId).filter((x): x is number => x != null),
    ...shareRows.map((s) => Number(s.employeeId)),
    ...persistent.map((p) => p.id),
  ])];
  const names = empIds.length
    ? await db.select({ id: employees.id, fullName: employees.fullName }).from(employees).where(inArray(employees.id, empIds))
    : [];
  const nameOf = new Map(names.map((e) => [e.id, e.fullName]));
  const sharesBy = new Map<number, { employeeId: number; name: string; km: number; minutes: number; movingMinutes: number | null }[]>();
  for (const s of shareRows) {
    const list = sharesBy.get(Number(s.historyId)) ?? [];
    const employeeId = Number(s.employeeId);
    list.push({ employeeId, name: nameOf.get(employeeId) ?? `#${employeeId}`, km: Number(s.km ?? 0), minutes: Number(s.minutes ?? 0), movingMinutes: s.movingMinutes == null ? null : Number(s.movingMinutes) });
    sharesBy.set(Number(s.historyId), list);
  }
  return rows.map((r) => {
    const shares = (sharesBy.get(Number(r.id)) ?? []).sort((a, b) => b.km - a.km);
    const id = shares[0]?.employeeId ?? r.employeeId ?? byZello.get(r.zelloUsername) ?? null;
    const employeeName = shares.length ? shares.map((s) => s.name).join(" + ") : (id != null ? nameOf.get(id) ?? null : null);
    const leftoverKm = shares.length ? Math.max(0, Math.round((Number(r.totalKm ?? 0) - shares.reduce((a, s) => a + s.km, 0)) * 100) / 100) : 0;
    return { ...r, resolvedEmployeeId: id, employeeName, shares, leftoverKm };
  });
}

/** Linhas do GPS de um dia de Lisboa (a coluna `date` guarda o dia a que os dados pertencem). */
const historyDayIs = (day: string) => sql`DATE(${dailyDriverHistory.date}) = ${day}`;
const historyScope = () => gpsRowScope(dailyDriverHistory.id, dailyDriverHistory.employeeId, dailyDriverHistory.zelloUsername);

export async function getDailyDriverHistoryByDate(dateStr: string) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(dailyDriverHistory)
    .where(and(historyScope(), historyDayIs(dateStr)))
    .orderBy(desc(dailyDriverHistory.totalKm));
  return withEmployeeNames(db, rows);
}

export async function getDailyDriverHistoryByUser(username: string, limit = 30) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(dailyDriverHistory)
    .where(and(historyScope(), eq(dailyDriverHistory.zelloUsername, username)))
    .orderBy(desc(dailyDriverHistory.date))
    .limit(limit);
  return withEmployeeNames(db, rows);
}

export async function getDailyDriverHistoryRange(startDate: string, endDate: string) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(dailyDriverHistory)
    .where(and(historyScope(),
      sql`DATE(${dailyDriverHistory.date}) >= ${startDate}`,
      sql`DATE(${dailyDriverHistory.date}) <= ${endDate}`,
    ))
    .orderBy(desc(dailyDriverHistory.date));
  return withEmployeeNames(db, rows);
}

export async function getDailyDriverStats(dateStr: string) {
  const db = await getDb();
  if (!db) return { totalDrivers: 0, totalKm: 0, totalHoursWorked: 0, totalHoursStopped: 0, maxSpeedOfDay: 0, avgBattery: 0, totalViolations: 0 };
  const rows = await db.select().from(dailyDriverHistory)
    .where(and(historyScope(), historyDayIs(dateStr)));

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

/** PDAs da(s) cidade(s) do utilizador — um PDA é da cidade de quem lá fez check-in (ver pdaScope). */
export async function listPdas() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(pdas).where(pdaScope(pdas.id)).orderBy(pdas.name);
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

/**
 * Ponto→PDA automático (pedido Jorge): o browser do PDA tem um deviceToken no
 * localStorage; quando alguém faz check-in do PONTO nesse aparelho, liga-se
 * logo a pessoa ao PDA (e ao Zello do PDA). Se estava lá outra pessoa com
 * check-in aberto, a app fecha-o e troca — "a própria aplicação mudava quem é
 * que estava".
 */
export async function attachPdaByDeviceToken(deviceToken: string, employeeId: number): Promise<{ pdaId: number; pdaName: string; zelloUsername: string | null; replacedName: string | null; changed: boolean } | null> {
  const db = await getDb(); if (!db) return null;
  const [pdaRows] = await db.execute(sql`SELECT id, name, zelloUsername FROM pdas WHERE deviceToken = ${deviceToken} AND status = 'active' LIMIT 1`) as any;
  const pda = (pdaRows as any[])?.[0];
  if (!pda) return null;
  const now = toMysqlDateTime(new Date());
  // Quem está agora com este PDA?
  const [activeRows] = await db.execute(sql`
    SELECT c.id, c.employeeId, e.fullName FROM pda_checkins c
    LEFT JOIN employees e ON e.id = c.employeeId
    WHERE c.pdaId = ${pda.id} AND c.checkin_status = 'checked_in'`) as any;
  let replacedName: string | null = null;
  let alreadyMine = false;
  for (const a of (activeRows as any[]) ?? []) {
    if (Number(a.employeeId) === employeeId) { alreadyMine = true; continue; }
    await db.execute(sql`UPDATE pda_checkins SET checkoutAt = ${now}, checkin_status = 'checked_out', notes = CONCAT(COALESCE(notes,''), ' · fechado automaticamente: outro colaborador fez check-in neste PDA') WHERE id = ${a.id}`);
    replacedName = a.fullName ? String(a.fullName) : replacedName;
  }
  // A pessoa só pode estar num PDA de cada vez — fecha check-ins dela noutros
  await db.execute(sql`UPDATE pda_checkins SET checkoutAt = ${now}, checkin_status = 'checked_out' WHERE employeeId = ${employeeId} AND checkin_status = 'checked_in' AND pdaId != ${pda.id}`);
  if (!alreadyMine) {
    await db.insert(pdaCheckins).values({
      pdaId: Number(pda.id),
      employeeId,
      zelloUsername: pda.zelloUsername ?? null,
      checkinAt: now,
    } as any);
  }
  return { pdaId: Number(pda.id), pdaName: String(pda.name), zelloUsername: pda.zelloUsername ? String(pda.zelloUsername) : null, replacedName, changed: !alreadyMine };
}

/** Logout num PDA registado: solta-o (fecha o check-in desta pessoa NESTE PDA). */
export async function releasePdaByDeviceToken(deviceToken: string, employeeId: number): Promise<number> {
  const db = await getDb(); if (!db) return 0;
  const [res] = await db.execute(sql`
    UPDATE pda_checkins c JOIN pdas p ON p.id = c.pdaId
       SET c.checkoutAt = ${toMysqlDateTime(new Date())}, c.checkin_status = 'checked_out',
           c.notes = CONCAT(COALESCE(c.notes,''), ' · fechado no logout')
     WHERE p.deviceToken = ${deviceToken} AND c.employeeId = ${employeeId} AND c.checkin_status = 'checked_in'`) as any;
  return Number((res as any)?.affectedRows ?? 0);
}

/** Código do QR de um PDA (criado na primeira vez). */
export async function ensurePdaQrCode(pdaId: number): Promise<string | null> {
  const db = await getDb(); if (!db) return null;
  const [rows] = await db.execute(sql`SELECT qrCode FROM pdas WHERE id = ${pdaId} LIMIT 1`) as any;
  const r = (rows as any[])?.[0];
  if (!r) return null;
  if (r.qrCode) return String(r.qrCode);
  const code = crypto.randomUUID().replace(/-/g, "");
  await db.execute(sql`UPDATE pdas SET qrCode = ${code} WHERE id = ${pdaId} AND qrCode IS NULL`);
  const [again] = await db.execute(sql`SELECT qrCode FROM pdas WHERE id = ${pdaId} LIMIT 1`) as any;
  return (again as any[])?.[0]?.qrCode ? String((again as any[])[0].qrCode) : code;
}

/** O código lido no QR é o deste PDA (e está ativo)? */
export async function verifyPdaQrCode(pdaId: number, code: string): Promise<{ name: string } | null> {
  const db = await getDb(); if (!db) return null;
  const [rows] = await db.execute(sql`SELECT name FROM pdas WHERE id = ${pdaId} AND qrCode = ${code} AND status = 'active' LIMIT 1`) as any;
  const r = (rows as any[])?.[0];
  return r ? { name: String(r.name) } : null;
}

/** Fecha os check-ins de PDA abertos de um funcionário (no check-out do ponto). */
export async function closePdaCheckinsForEmployee(employeeId: number, at: Date): Promise<number> {
  const db = await getDb(); if (!db) return 0;
  const [res] = await db.execute(sql`
    UPDATE pda_checkins SET checkoutAt = ${toMysqlDateTime(at)}, checkin_status = 'checked_out'
    WHERE employeeId = ${employeeId} AND checkin_status = 'checked_in'`) as any;
  return Number((res as any)?.affectedRows ?? 0);
}

/** Regista o browser atual como sendo um PDA (token novo, invalida o anterior). */
export async function setPdaDeviceToken(pdaId: number): Promise<string | null> {
  const db = await getDb(); if (!db) return null;
  const token = crypto.randomUUID().replace(/-/g, "");
  await db.execute(sql`UPDATE pdas SET deviceToken = ${token} WHERE id = ${pdaId}`);
  return token;
}

/** Info do aparelho a partir do deviceToken (para o cartão "Este aparelho"). */
export async function getPdaByDeviceToken(deviceToken: string) {
  const db = await getDb(); if (!db) return null;
  const [rows] = await db.execute(sql`
    SELECT p.id, p.name, p.zelloUsername,
           (SELECT e.fullName FROM pda_checkins c LEFT JOIN employees e ON e.id = c.employeeId
            WHERE c.pdaId = p.id AND c.checkin_status = 'checked_in' ORDER BY c.checkinAt DESC LIMIT 1) AS currentHolder
    FROM pdas p WHERE p.deviceToken = ${deviceToken} LIMIT 1`) as any;
  const r = (rows as any[])?.[0];
  return r ? { pdaId: Number(r.id), name: String(r.name), zelloUsername: r.zelloUsername ? String(r.zelloUsername) : null, currentHolder: r.currentHolder ? String(r.currentHolder) : null } : null;
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
    .where(and(eq(pdaCheckins.checkinStatus, "checked_in"), pdaScope(pdaCheckins.pdaId)))
    .orderBy(desc(pdaCheckins.checkinAt));
}

export async function getCheckinsByDate(dateStr: string) {
  const db = await getDb();
  if (!db) return [];
  const day = lisbonDayRangeUtc(dateStr);
  return db.select(checkinWithEmployee).from(pdaCheckins)
    .leftJoin(employees, eq(pdaCheckins.employeeId, employees.id))
    .where(and(gte(pdaCheckins.checkinAt, day.start), lt(pdaCheckins.checkinAt, day.end), pdaScope(pdaCheckins.pdaId)))
    .orderBy(desc(pdaCheckins.checkinAt));
}

export async function getCheckinsByPda(pdaId: number, limit = 30) {
  const db = await getDb();
  if (!db) return [];
  return db.select(checkinWithEmployee).from(pdaCheckins)
    .leftJoin(employees, eq(pdaCheckins.employeeId, employees.id))
    .where(and(eq(pdaCheckins.pdaId, pdaId), pdaScope(pdaCheckins.pdaId)))
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
// para a DB local (multipark_booking_history populado pelos crons de sincronização).
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
    id?: number;
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
  return rows.map((r, i) => {
    const { first, last } = splitAgentName(r.agentName);
    return {
      id: r.id ?? i + 1,
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
  // AO VIVO da BD da Multipark ("History") — a cópia local está congelada desde o #141.
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  const { scopedCityNamesLive } = await import("./cityScope");
  const rows = await readLiveHistory({ bookingIds: [bookingId], cities: scopedCityNamesLive(), limit: 500 });
  return mapMultiparkHistoryRows(rows);
}

export async function getBookingHistoryByPlate(plate: string): Promise<HistoryRow[]> {
  // AO VIVO da BD da Multipark (matrícula "contém", sem hífenes/espaços).
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  const { scopedCityNamesLive } = await import("./cityScope");
  const rows = await readLiveHistory({ plate: { contains: plate }, cities: scopedCityNamesLive(), limit: 500 });
  return mapMultiparkHistoryRows(rows);
}

export async function searchBookingHistory(search: string): Promise<HistoryRow[]> {
  // AO VIVO da BD da Multipark (reserva, matrícula, agente ou tipo).
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  const { scopedCityNamesLive } = await import("./cityScope");
  const rows = await readLiveHistory({ text: search, cities: scopedCityNamesLive(), limit: 200 });
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

  // AO VIVO da BD da Multipark ("History" das reservas com caso aberto).
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  const { scopedCityNamesLive } = await import("./cityScope");
  const rows = await readLiveHistory({ bookingIds: refs, cities: scopedCityNamesLive(), limit: 5000 });

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

  // AO VIVO da BD da Multipark: contagens por agente em todo o histórico (âmbito de cidade).
  const { readLiveHistoryByAgent } = await import("./multiparkDb/historyLive");
  const { scopedCityNamesLive } = await import("./cityScope");
  const rows = (await readLiveHistoryByAgent({ cities: scopedCityNamesLive(), limit: 2000 }))
    .map((r) => ({ userName: r.agentName, total: r.total, checkins: r.checkins, checkouts: r.checkouts, movements: r.movements }));

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

  // AO VIVO da BD da Multipark (matrícula exata, sem hífenes/espaços).
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  const { scopedCityNamesLive } = await import("./cityScope");
  const rows: Array<{ agentName: string | null; agentEmail: string | null; changeType: string | null; actionTime: string | null; bookingExternalId: string }> =
    await readLiveHistory({ plate: { exact: plate }, cities: scopedCityNamesLive(), limit: 2000 });

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

  // AO VIVO da BD da Multipark: dias de LISBOA → intervalo UTC; só as cidades do utilizador.
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  const { scopedCityNamesLive } = await import("./cityScope");
  const range = lisbonDayRangeUtc(opts.from, opts.to);
  const rows = await readLiveHistory({ agentName: { exact: opts.agentName }, from: range.start, to: range.end, cities: scopedCityNamesLive(), limit: 2000 });

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

  // AO VIVO da BD da Multipark: CHECK_OUT por agente nos dias de Lisboa; só as cidades do utilizador.
  const { readLiveHistoryByAgent } = await import("./multiparkDb/historyLive");
  const { scopedCityNamesLive } = await import("./cityScope");
  const range = lisbonDayRangeUtc(startDate, endDate);
  const rows = (await readLiveHistoryByAgent({ changeTypes: ["CHECK_OUT"], from: range.start, to: range.end, cities: scopedCityNamesLive(), limit: 2000 }))
    .map((r) => ({ agentName: r.agentName, agentUserId: r.agentUserId, count: r.total }));

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

  // AO VIVO da BD da Multipark ("History"): dias de Lisboa; só as cidades do utilizador.
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  const { scopedCityNamesLive } = await import("./cityScope");
  const range = lisbonDayRangeUtc(opts.startDate, opts.endDate);
  const live = await readLiveHistory({
    from: range.start, to: range.end, cities: scopedCityNamesLive(), limit: 500,
    ...(opts.userId ? { userIds: [opts.userId] } : { agentName: { contains: opts.agentName! } }),
  });
  const rows = live.map((r) => ({
    id: r.historyId, changeType: r.changeType, actionTime: r.actionTime, remarks: r.remarks, agentName: r.agentName,
    agentUserId: r.agentUserId, modifiedFields: r.modifiedFields, platform: r.platform, bookingExternalId: r.bookingExternalId,
    bookingStatus: r.bookingStatus, bookingCheckIn: r.checkIn, bookingCheckOut: r.checkOut, bookingParkName: r.parkName, bookingLicensePlate: r.licensePlate,
  }));

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

/** Reserva 'processing' mais antiga do que isto é considerada abandonada. */
const INBOUND_CLAIM_STALE_MS = 15 * 60 * 1000;
function inboundStaleCutoff(): string {
  return new Date(Date.now() - INBOUND_CLAIM_STALE_MS).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * RESERVA o Message-ID antes de criar o registo de destino (reclamação…):
 * insere a linha em inbound_emails com status 'processing' e deixa o índice
 * UNIQUE decidir. Duas corridas em paralelo (cron + botão manual) nunca criam
 * o mesmo caso duas vezes. Devolve o id da linha reservada, ou null se o email
 * já existe (duplicado → ignorar). Uma reserva 'processing' abandonada há mais
 * de 15 min (corrida morta a meio) é retomada atomicamente.
 */
export async function claimInboundEmail(data: InsertInboundEmail): Promise<number | null> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const nowStr = new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    return await createInboundEmail({ ...data, status: "processing", processedAt: nowStr } as any);
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code !== "ER_DUP_ENTRY") throw err;
  }
  const [res] = await db.update(inboundEmails)
    .set({ processedAt: nowStr })
    .where(and(
      eq(inboundEmails.messageId, data.messageId),
      eq(inboundEmails.status, "processing"),
      lt(inboundEmails.processedAt, inboundStaleCutoff()),
    )) as any;
  if (!res?.affectedRows) return null;
  const row = await getInboundEmailByMessageId(data.messageId);
  return row?.id ?? null;
}

export async function updateInboundEmail(id: number, data: Partial<InsertInboundEmail>) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const clamp = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : v);
  const safe: Partial<InsertInboundEmail> = { ...data };
  for (const [k, n] of [["fromName", 255], ["fromEmail", 320], ["clientName", 255], ["clientEmail", 320], ["clientPhone", 50], ["vehiclePlate", 20], ["bookingRef", 100], ["subject", 500], ["errorMsg", 500]] as const) {
    if (k in safe) (safe as any)[k] = clamp((safe as any)[k], n);
  }
  await db.update(inboundEmails).set(safe).where(eq(inboundEmails.id, id));
}

/** Liberta uma reserva (falha a criar o registo → a próxima corrida tenta de novo). */
export async function deleteInboundEmail(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(inboundEmails).where(eq(inboundEmails.id, id));
}

/** Message-ID do último email RECEBIDO de uma reclamação (threading das respostas). */
export async function getLastInboundMessageIdForComplaint(complaintId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ m: inboundEmails.messageId })
    .from(inboundEmails)
    .where(and(eq(inboundEmails.targetModule, "complaint"), eq(inboundEmails.targetId, complaintId)))
    .orderBy(desc(inboundEmails.id))
    .limit(1);
  const m = rows[0]?.m;
  return m && !m.startsWith("uid:") ? m : null;
}

/**
 * Anexos (não-imagem) dos emails ligados a uma reclamação — as imagens são
 * copiadas para complaint_photos na ingestão; o resto aparece como links.
 */
export async function listComplaintEmailAttachments(complaintId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: inboundEmails.id, subject: inboundEmails.subject, receivedAt: inboundEmails.receivedAt, attachmentsJson: inboundEmails.attachmentsJson })
    .from(inboundEmails)
    .where(and(
      eq(inboundEmails.targetModule, "complaint"),
      eq(inboundEmails.targetId, complaintId),
      isNotNull(inboundEmails.attachmentsJson),
    ))
    .orderBy(desc(inboundEmails.id))
    .limit(50);
  const out: Array<{ emailId: number; subject: string | null; receivedAt: string | null; filename: string; contentType: string | null; size: number | null; url: string | null; key: string | null }> = [];
  for (const r of rows) {
    let list: any[] = [];
    try { list = JSON.parse(r.attachmentsJson || "[]"); } catch { list = []; }
    for (const a of Array.isArray(list) ? list : []) {
      if (String(a?.contentType ?? "").toLowerCase().startsWith("image/")) continue;
      out.push({
        emailId: r.id, subject: r.subject, receivedAt: r.receivedAt,
        filename: String(a?.filename || "anexo"), contentType: a?.contentType ?? null,
        size: typeof a?.size === "number" ? a.size : null, url: a?.url ?? null, key: a?.key ?? null,
      });
    }
  }
  return out;
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
 * Agrupamento de reclamações por cliente: email OU matrícula (normalizada) OU
 * nome (exato, ≥6 chars). Só casos ABERTOS (não resolvidos/fechados) com
 * atividade nos últimos 60 dias — um cliente que volta meses depois com outro
 * problema abre um caso novo. Ignora remetentes internos e nomes genéricos.
 * Objetivo: 10 emails do mesmo cliente = 1 reclamação com 10 mensagens.
 */
export async function findComplaintByClientSignals(
  clientEmail?: string | null,
  vehiclePlate?: string | null,
  clientName?: string | null,
) {
  const db = await getDb();
  if (!db) return null;
  const { clientSignalEmail, clientSignalName, normalizePlate, COMPLAINT_SIGNALS_WINDOW_DAYS } = await import("./complaintEmail");
  const conds: any[] = [];
  // Endereços internos (multipark.pt, …) e nomes genéricos ("Multipark") são
  // do BACKOFFICE que reencaminha, não do cliente — nunca agrupam.
  const email = clientSignalEmail(clientEmail)?.toLowerCase();
  if (email) conds.push(sql`LOWER(${complaints.clientEmail}) = ${email}`);
  const plate = normalizePlate(vehiclePlate);
  if (plate.length >= 4) {
    conds.push(sql`UPPER(REPLACE(REPLACE(REPLACE(${complaints.vehiclePlate}, ' ', ''), '-', ''), '.', '')) = ${plate}`);
  }
  const name = clientSignalName(clientName);
  if (name) conds.push(eq(complaints.clientName, name));
  if (!conds.length) return null;
  const since = new Date(Date.now() - COMPLAINT_SIGNALS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  const rows = await db.select().from(complaints)
    .where(and(
      notInArray(complaints.complaintStatus, ["resolved", "closed", "converted"]),
      or(gte(complaints.updatedAt, since), gte(complaints.createdAt, since)),
      or(...conds),
    ))
    .orderBy(desc(complaints.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function findOpenComplaintByClient(clientEmail?: string | null, vehiclePlate?: string | null) {
  const db = await getDb();
  if (!db) return null;
  const conds: any[] = [];
  if (clientEmail) conds.push(eq(complaints.clientEmail, clientEmail));
  if (vehiclePlate) conds.push(eq(complaints.vehiclePlate, vehiclePlate));
  if (!conds.length) return null;
  const rows = await db.select().from(complaints)
    .where(and(notInArray(complaints.complaintStatus, ["resolved", "closed", "converted"]), or(...conds)))
    .orderBy(desc(complaints.createdAt))
    .limit(1);
  return rows[0] || null;
}

// ── Histórico completo de um cliente (cruza reservas + reclamações + perdidos +
//    críticas) por email / telefone / matrícula / nome. Usado nos detalhes de
//    Reclamações, Perdidos&Achados e Críticas para ver tudo o que se passou.
//    CRM fase 2 (29 set 2026): o cliente é a FICHA do CRM (server/crm/lookup.ts)
//    — as reservas vêm das ligações reserva → ficha, lidas AO VIVO da Multipark;
//    reclamações, perdidos e críticas cruzam também os outros emails, telefones
//    e matrículas da ficha. ──
export interface ClientHistoryQuery {
  /** Ficha do CRM (quando já se sabe qual é). */
  clientId?: number | null;
  email?: string | null;
  phone?: string | null;
  plate?: string | null;
  name?: string | null;
}

export interface ClientHistoryBooking {
  id: string; externalId: string; bookingNumber: string | null; status: string | null; parkName: string | null; city: string | null;
  checkIn: string | null; checkOut: string | null; licensePlate: string | null; totalPrice: number | null;
  clientFirstName: string | null; clientLastName: string | null;
}

/** Estatísticas das reservas de um cliente (todas, a lista mostra só 30). PURA. */
export function clientBookingStats(facts: ReadonlyArray<{ status: string | null; checkIn: string | null; total: number }>) {
  const VISITED = ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT", "CHECKED_OUT"];
  let firstCheckIn: string | null = null, lastCheckIn: string | null = null, totalSpent = 0, visited = 0, cancelled = 0;
  for (const f of facts) {
    const st = String(f.status ?? "").toUpperCase();
    if (f.checkIn) {
      if (!firstCheckIn || f.checkIn < firstCheckIn) firstCheckIn = f.checkIn;
      if (!lastCheckIn || f.checkIn > lastCheckIn) lastCheckIn = f.checkIn;
    }
    // Gasto só em estadias efetivas (= ficha do CRM): canceladas e futuras fora
    if (VISITED.includes(st)) { visited++; totalSpent += Number(f.total) || 0; }
    if (st.includes("CANCEL")) cancelled++;
  }
  totalSpent = Math.round(totalSpent * 100) / 100;
  return { total: facts.length, firstCheckIn, lastCheckIn, totalSpent, avgSpend: visited > 0 ? totalSpent / visited : 0, cancelled };
}

export async function getClientHistory(q: ClientHistoryQuery) {
  const db = await getDb();
  const empty = {
    clientIds: [] as number[], bookings: [] as ClientHistoryBooking[], bookingsError: null as string | null,
    complaints: [] as any[], lostFound: [] as any[], reviews: [] as any[],
    bookingStats: { total: 0, firstCheckIn: null as string | null, lastCheckIn: null as string | null, totalSpent: 0, avgSpend: 0, cancelled: 0 },
  };
  if (!db) return empty;

  // Email é a identidade: comparar sempre pela forma canónica (shared/email.ts).
  const email = q.email?.trim().toLowerCase() || null;
  const phone = q.phone?.trim() || null;
  const plate = q.plate?.trim() || null;
  const name = q.name?.trim() || null;
  const clientId = q.clientId && q.clientId > 0 ? q.clientId : null;
  if (!email && !phone && !plate && !name && !clientId) return empty;

  // 1) As fichas do CRM deste cliente (no âmbito de cidade de quem pede).
  const { findCrmClientIds, crmBookingIdsOf } = await import("./crm/lookup");
  const clientIds = await findCrmClientIds(db, { clientId, email, phone, plate, name });
  const ids = clientIds.length ? inArraySql(clientIds) : null;
  const rowsOf = (res: unknown): any[] => { const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res; return Array.isArray(r) ? r : []; };
  const [fichaEmails, fichaPhones, fichaPlates] = ids ? await Promise.all([
    db.execute(sql`SELECT DISTINCT email AS v FROM crm_client_emails WHERE clientId IN (${ids}) AND generic = 0 LIMIT 10`),
    db.execute(sql`SELECT DISTINCT phone AS v FROM crm_client_phones WHERE clientId IN (${ids}) LIMIT 10`),
    db.execute(sql`SELECT DISTINCT plate AS v FROM crm_client_vehicles WHERE clientId IN (${ids}) LIMIT 10`),
  ]).then((rs) => rs.map((r) => rowsOf(r).map((x) => String(x.v)))) : [[], [], []];

  // O nome é fraco (há muitas "Ana Silva"): só entra quando não há email,
  // telefone nem matrícula. % e _ escapados.
  const namePat = name && !email && !phone && !plate ? `%${name.replace(/[\\%_]/g, (c) => "\\" + c)}%` : null;
  // Telefone pelos últimos 9 dígitos (+351 912… = 912…); matrícula sem espaços/hífens
  const phones9 = [...new Set([phone, ...fichaPhones].map((p) => String(p ?? "").replace(/\D+/g, "").slice(-9)).filter((p) => p.length === 9))];
  const emails = [...new Set([email, ...fichaEmails].filter((e): e is string => !!e))];
  const plates = [...new Set([plate, ...fichaPlates].map((p) => String(p ?? "").replace(/[\s-]+/g, "").toUpperCase()).filter((p) => p.length >= 4))];
  const emailIn = (col: any) => sql`LOWER(TRIM(${col})) IN (${inArraySql(emails)})`;
  const phoneIn = (col: any) => sql`RIGHT(REGEXP_REPLACE(COALESCE(${col}, ''), '[^0-9]', ''), 9) IN (${inArraySql(phones9)})`;
  const plateIn = (col: any) => sql`UPPER(REPLACE(REPLACE(TRIM(${col}), ' ', ''), '-', '')) IN (${inArraySql(plates)})`;

  const complaintConds: any[] = [];
  if (emails.length) complaintConds.push(emailIn(complaints.clientEmail));
  if (phones9.length) complaintConds.push(phoneIn(complaints.clientPhone));
  if (plates.length) complaintConds.push(plateIn(complaints.vehiclePlate));
  if (namePat) complaintConds.push(like(complaints.clientName, namePat));

  const lfConds: any[] = [];
  if (emails.length) lfConds.push(emailIn(lostFoundItems.clientEmail));
  if (phones9.length) lfConds.push(phoneIn(lostFoundItems.clientPhone));
  if (plates.length) lfConds.push(plateIn(lostFoundItems.vehiclePlate));
  if (namePat) lfConds.push(like(lostFoundItems.clientName, namePat));

  const reviewConds: any[] = [];
  if (emails.length) reviewConds.push(emailIn(googleReviews.reviewerEmail));
  if (plates.length) reviewConds.push(plateIn(googleReviews.vehiclePlate));
  if (namePat) reviewConds.push(like(googleReviews.reviewerName, namePat));

  // 2) Reservas: ligações das fichas → factos lidos ao vivo, só das cidades de quem pede.
  const loadBookings = async () => {
    const bookingIds = await crmBookingIdsOf(db, clientIds);
    if (!bookingIds.length) return { facts: [] as import("./multiparkDb/crmLive").CrmBookingFact[], error: null as string | null };
    try {
      const [{ readCrmBookingFacts }, { scopedCityNamesLive }, { cityAliases }] = await Promise.all([
        import("./multiparkDb/crmLive"), import("./cityScope"), import("../shared/crmGeo"),
      ]);
      const facts = await readCrmBookingFacts(bookingIds);
      const scope = scopedCityNamesLive();
      const allowed = scope === undefined ? null : new Set(cityAliases(scope));
      return { facts: allowed ? facts.filter((f) => !!f.city && allowed.has(f.city.trim().toLowerCase())) : facts, error: null };
    } catch (err) {
      console.warn("[clientHistory] reservas ao vivo indisponíveis:", (err as Error)?.message);
      return { facts: [], error: "Reservas indisponíveis (BD da Multipark sem resposta)." };
    }
  };

  const [live, complaintRows, lostFound, reviews] = await Promise.all([
    loadBookings(),
    complaintConds.length
      ? db.select({
          id: complaints.id, title: complaints.title, status: complaints.complaintStatus,
          vehiclePlate: complaints.vehiclePlate, createdAt: complaints.createdAt,
        }).from(complaints).where(and(or(...complaintConds), projectScope(complaints.projectId))).orderBy(desc(complaints.createdAt)).limit(30)
      : Promise.resolve([]),
    lfConds.length
      ? db.select({
          id: lostFoundItems.id, itemType: lostFoundItems.itemType, description: lostFoundItems.description,
          status: lostFoundItems.status, vehiclePlate: lostFoundItems.vehiclePlate, createdAt: lostFoundItems.createdAt,
        }).from(lostFoundItems).where(and(or(...lfConds), projectScope(lostFoundItems.projectId))).orderBy(desc(lostFoundItems.createdAt)).limit(30)
      : Promise.resolve([]),
    reviewConds.length
      ? db.select({
          id: googleReviews.id, rating: googleReviews.rating, reviewText: googleReviews.reviewText,
          status: googleReviews.status, vehiclePlate: googleReviews.vehiclePlate, createdAt: googleReviews.createdAt,
        }).from(googleReviews).where(and(or(...reviewConds), projectScope(googleReviews.projectId))).orderBy(desc(googleReviews.createdAt)).limit(30)
      : Promise.resolve([]),
  ]);

  // Nome do cliente para as reservas: o da ficha (a reserva lida ao vivo não traz dados pessoais).
  let first: string | null = null, last: string | null = null;
  if (ids) {
    const r = rowsOf(await db.execute(sql`SELECT firstName, lastName, displayName FROM crm_clients WHERE id IN (${ids}) ORDER BY bookings DESC LIMIT 1`))[0];
    first = r?.firstName ?? r?.displayName ?? null;
    last = r?.firstName ? r?.lastName ?? null : null;
  }
  const bookings: ClientHistoryBooking[] = [...live.facts]
    .sort((a, b) => String(b.checkIn ?? "").localeCompare(String(a.checkIn ?? "")))
    .slice(0, 30)
    .map((f) => ({
      id: f.id, externalId: f.id, bookingNumber: f.code, status: f.status, parkName: f.parkName, city: f.city,
      checkIn: f.checkIn, checkOut: f.checkOut, licensePlate: f.plate, totalPrice: f.total,
      clientFirstName: first, clientLastName: last,
    }));

  return {
    clientIds, bookings, bookingsError: live.error, bookingStats: clientBookingStats(live.facts),
    complaints: complaintRows, lostFound, reviews,
  };
}

/** Lista parametrizada para IN (…). */
function inArraySql(vals: ReadonlyArray<string | number>): SQL {
  return sql.join(vals.map((v) => sql`${v}`), sql`, `);
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
    // Resposta direta a um email NOSSO (Message-ID guardado no envio).
    const outRows = await db.select({ id: complaints.id }).from(complaints)
      .where(inArray(complaints.lastOutboundMessageId, refs.slice(0, 100)))
      .orderBy(desc(complaints.id))
      .limit(1);
    if (outRows[0]) {
      const c = await getComplaintById(outRows[0].id);
      if (c) return c;
    }
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
      notInArray(complaints.complaintStatus, ["resolved", "closed", "converted"]),
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
    .where(and(notInArray(lostFoundItems.status, ["returned", "closed", "converted"]), or(...conds)))
    .orderBy(desc(lostFoundItems.createdAt))
    .limit(1);
  return rows[0] || null;
}
