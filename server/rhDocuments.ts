/**
 * RH (Frente A, Jorge, 7 out 2026): estado dos documentos da ficha
 * (pendente → validado/recusado) e a carta de condução ("Carta validada" /
 * "Carta pendente de validação" / "Carta < 3 anos" / "Sem carta").
 * Só acesso à BD — as regras estão em shared/employeeDocuments.ts,
 * shared/drivingLicence.ts e server/rhAccess.ts (quem pode).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { employeeDocuments, employees } from "../drizzle/schema";
import { getDb } from "./db";
import { licenceStatus, type LicenceStatus } from "../shared/drivingLicence";
import { lisbonDayOf } from "../shared/lisbonDay";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  return db;
}

const affected = (r: any) => Number(r?.[0]?.affectedRows ?? r?.affectedRows ?? 0);
const nowUtc = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export type EmployeeDocumentRow = typeof employeeDocuments.$inferSelect;

/** Um documento (ativo ou arquivado) pelo id. */
export async function getEmployeeDocumentById(id: number): Promise<EmployeeDocumentRow | null> {
  const db = await dbOrThrow();
  const [doc] = await db.select().from(employeeDocuments).where(eq(employeeDocuments.id, id)).limit(1);
  return doc ?? null;
}

/** Estados dos ficheiros ATIVOS de um tipo numa ficha (para a regra "já validado"). */
export async function activeDocStatuses(employeeId: number, docType: string): Promise<string[]> {
  const db = await dbOrThrow();
  const rows = await db.select({ status: employeeDocuments.status }).from(employeeDocuments)
    .where(and(eq(employeeDocuments.employeeId, employeeId), eq(employeeDocuments.docType, docType as any), isNull(employeeDocuments.archivedAt)));
  return rows.map((r) => r.status);
}

/** Validar um ficheiro ativo (pendente ou recusado). Devolve se mudou. */
export async function markDocumentValidated(id: number, byUserId: number): Promise<boolean> {
  const db = await dbOrThrow();
  return affected(await db.update(employeeDocuments)
    .set({ status: "validated", validatedById: byUserId, validatedAt: nowUtc(), rejectedReason: null })
    .where(and(eq(employeeDocuments.id, id), isNull(employeeDocuments.archivedAt), sql`${employeeDocuments.status} <> 'validated'`))) > 0;
}

/** Recusar um ficheiro ativo (com motivo). Devolve se mudou. */
export async function markDocumentRejected(id: number, byUserId: number, reason: string): Promise<boolean> {
  const db = await dbOrThrow();
  return affected(await db.update(employeeDocuments)
    .set({ status: "rejected", validatedById: byUserId, validatedAt: nowUtc(), rejectedReason: reason })
    .where(and(eq(employeeDocuments.id, id), isNull(employeeDocuments.archivedAt)))) > 0;
}

/**
 * O RH valida a carta: grava a data de emissão e quem/quando validou, e os
 * ficheiros da carta que estavam pendentes ficam validados (o RH viu-os).
 * Devolve quantos ficheiros passaram a validados.
 */
export async function validateDrivingLicenceRecord(employeeId: number, issuedAt: string, byUserId: number): Promise<{ documentsValidated: number }> {
  const db = await dbOrThrow();
  const at = nowUtc();
  await db.update(employees)
    .set({ drivingLicenseIssuedAt: issuedAt, drivingLicenseValidatedAt: at, drivingLicenseValidatedById: byUserId })
    .where(eq(employees.id, employeeId));
  const r = await db.update(employeeDocuments)
    .set({ status: "validated", validatedById: byUserId, validatedAt: at, rejectedReason: null })
    .where(and(eq(employeeDocuments.employeeId, employeeId), eq(employeeDocuments.docType, "driving_license"), eq(employeeDocuments.status, "pending"), isNull(employeeDocuments.archivedAt)));
  return { documentsValidated: affected(r) };
}

/** Fichas com um ficheiro da carta ENTREGUE (pendente ou validado; recusados não contam). */
async function employeesWithLicenceDoc(employeeIds: number[] | null): Promise<Set<number>> {
  const db = await dbOrThrow();
  const conds = [eq(employeeDocuments.docType, "driving_license"), inArray(employeeDocuments.status, ["pending", "validated"]), isNull(employeeDocuments.archivedAt)];
  if (employeeIds) conds.push(inArray(employeeDocuments.employeeId, employeeIds));
  const rows = await db.select({ employeeId: employeeDocuments.employeeId }).from(employeeDocuments).where(and(...conds));
  return new Set(rows.map((r) => r.employeeId));
}

export interface LicenceFields {
  id: number;
  drivingLicenseIssuedAt?: string | null;
  drivingLicenseValidatedAt?: string | null;
  drivingLicenseNumber?: string | null;
}

/** Estado da carta (hoje, em Lisboa) de cada ficha das linhas dadas. */
export async function licenceStatusesFor(rows: readonly LicenceFields[], today = lisbonDayOf(new Date())): Promise<Map<number, LicenceStatus>> {
  const out = new Map<number, LicenceStatus>();
  if (!rows.length) return out;
  // Muitas fichas → uma leitura de todas (evita um IN gigante).
  const withDoc = await employeesWithLicenceDoc(rows.length > 500 ? null : rows.map((r) => r.id));
  for (const r of rows) {
    out.set(r.id, licenceStatus({
      issuedAt: r.drivingLicenseIssuedAt ?? null,
      validatedAt: r.drivingLicenseValidatedAt ?? null,
      hasDocument: withDoc.has(r.id),
      hasNumber: !!r.drivingLicenseNumber?.trim(),
    }, today));
  }
  return out;
}

/** Como licenceStatusesFor, mas uma leitura falhada → null: a ficha/lista abre na mesma, sem a etiqueta. */
export async function licenceStatusesOrNull(rows: readonly LicenceFields[]): Promise<Map<number, LicenceStatus> | null> {
  try {
    return await licenceStatusesFor(rows);
  } catch (err) {
    console.warn("[carta] estado da carta falhou:", String((err as any)?.message ?? err).slice(0, 160));
    return null;
  }
}

/**
 * Estado da carta de fichas por id (lê os campos da ficha). Para o Extras-dia:
 * leitura falhada → mapa vazio (sem etiqueta nem aviso; nunca "Sem carta" a todos).
 */
export async function licenceStatusMap(employeeIds: number[]): Promise<Map<number, LicenceStatus>> {
  const ids = [...new Set(employeeIds)].filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) return new Map();
  try {
    const db = await getDb();
    if (!db) return new Map();
    const rows = await db.select({
      id: employees.id,
      drivingLicenseIssuedAt: employees.drivingLicenseIssuedAt,
      drivingLicenseValidatedAt: employees.drivingLicenseValidatedAt,
      drivingLicenseNumber: employees.drivingLicenseNumber,
    }).from(employees).where(inArray(employees.id, ids));
    return await licenceStatusesFor(rows);
  } catch (err) {
    console.warn("[carta] estado da carta falhou:", String((err as any)?.message ?? err).slice(0, 160));
    return new Map();
  }
}
