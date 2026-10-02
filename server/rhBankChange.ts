/**
 * IBAN da ficha (P3 lote 19c — decisão do Jorge, 2 out 2026: "pedido aprovado
 * pelo RH").
 *
 *  - Quem NÃO é o RH da ficha (o próprio, o team leader, o supervisor) não
 *    muda o IBAN: fica um PEDIDO pendente e o IBAN antigo mantém-se até o RH
 *    (front/back office, admin+ — `isRhFor`) aprovar. Antes mudava logo, sem
 *    rasto: num PDA partilhado alguém trocava o NIB e o ordenado ia para outra
 *    conta.
 *  - O RH muda diretamente; um pedido pendente dessa ficha fica "superseded".
 *  - O IBAN novo valida-se (mod 97) e guarda-se CIFRADO até ser aprovado; nos
 *    registos aparece sempre mascarado ("PT50 •••• 1234").
 *  - Aviso ao RH no sino: tipo `rh_bank_change`, atrás do interruptor
 *    RH_BANK_CHANGE_NOTIFY (desligado por omissão — coisas novas que avisam
 *    gente entram desligadas). Sem aviso, os pedidos aparecem na lista do RH
 *    e na ficha.
 *  - Nada se apaga: recusado/substituído fica na tabela com quem e quando.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { employeeBankChangeRequests, employees } from "../drizzle/schema";
import { ibanError, maskIban, normalizeIban, sameIban } from "../shared/iban";
import { getDb, getEmployeeById, logActivity } from "./db";

const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  return db;
}

/** Valida e normaliza; lança BAD_REQUEST com a razão em português. */
export function validIbanOrThrow(raw: string): string {
  const err = ibanError(raw);
  if (err) throw new TRPCError({ code: "BAD_REQUEST", message: err });
  return normalizeIban(raw);
}

/**
 * O que fazer com um `nib` vindo do formulário da ficha. O formulário manda
 * a ficha inteira: o mesmo IBAN (com outra formatação) não é mudança.
 *  - "unchanged": não mexer;
 *  - "apply": o RH muda já (valor normalizado);
 *  - "request": fica pedido pendente.
 * PURA.
 */
export function nibChangeAction(current: string | null | undefined, sent: string | undefined, isRh: boolean):
  { kind: "unchanged" } | { kind: "apply"; value: string | null } | { kind: "request"; value: string } | { kind: "error"; message: string } {
  if (sent === undefined) return { kind: "unchanged" };
  const trimmed = sent.trim();
  if (!trimmed) {
    if (!String(current ?? "").trim()) return { kind: "unchanged" };
    // tirar o IBAN deixa o ordenado sem destino: só o RH
    return isRh ? { kind: "apply", value: null } : { kind: "error", message: "Para tirar o IBAN da ficha fala com o RH." };
  }
  if (sameIban(current, trimmed)) return { kind: "unchanged" };
  const err = ibanError(trimmed);
  if (err) return { kind: "error", message: err };
  return isRh ? { kind: "apply", value: normalizeIban(trimmed) } : { kind: "request", value: normalizeIban(trimmed) };
}

/** Cria o pedido (o anterior pendente fica "superseded"), regista e avisa o RH (se ligado). */
export async function createBankChangeRequest(employeeId: number, newIban: string, requestedById: number): Promise<{ id: number; masked: string }> {
  const db = await dbOrThrow();
  const value = validIbanOrThrow(newIban);
  const found = await getEmployeeById(employeeId);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
  const { encryptSecret } = await import("./integrations/googleAds/crypto");
  const masked = maskIban(value);
  const oldMasked = found.employee.nib ? maskIban(found.employee.nib) : null;
  await db.update(employeeBankChangeRequests)
    .set({ status: "superseded", decidedAt: nowMysql(), decidedById: requestedById, decisionNote: "substituído por um pedido mais recente" })
    .where(and(eq(employeeBankChangeRequests.employeeId, employeeId), eq(employeeBankChangeRequests.status, "pending")));
  const res: any = await db.insert(employeeBankChangeRequests).values({
    employeeId, newNibEnc: encryptSecret(value), newNibMasked: masked, oldNibMasked: oldMasked, status: "pending", requestedById,
  });
  const id = Number(res?.[0]?.insertId ?? res?.insertId ?? 0);
  await logActivity({ userId: requestedById, action: "bank_change_request", entity: "employee", entityId: employeeId,
    details: `Pedido de alteração do IBAN de ${found.employee.fullName}: ${oldMasked ?? "—"} → ${masked} (aguarda aprovação do RH)` });
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    if (isFeatureEnabled("RH_BANK_CHANGE_NOTIFY", { defaultEnabled: automationFlagDefault("RH_BANK_CHANGE_NOTIFY") })) {
      const { notify } = await import("./notify");
      await notify({
        kind: "rh_bank_change", title: `IBAN por aprovar: ${found.employee.fullName}`,
        body: `${oldMasked ?? "sem IBAN"} → ${masked}. Confirma com o comprovativo antes de aprovar.`,
        link: `/rh?employeeId=${employeeId}`, employeeId, entity: { type: "bank_change", id },
      });
    }
  } catch (err) { console.warn("[rhBankChange] aviso ao RH falhou:", String((err as any)?.message ?? err).slice(0, 160)); }
  return { id, masked };
}

/** O RH mudou o IBAN diretamente: pedidos pendentes dessa ficha ficam substituídos. */
export async function supersedePendingForEmployee(employeeId: number, byUserId: number): Promise<void> {
  const db = await dbOrThrow();
  await db.update(employeeBankChangeRequests)
    .set({ status: "superseded", decidedAt: nowMysql(), decidedById: byUserId, decisionNote: "o RH alterou o IBAN diretamente" })
    .where(and(eq(employeeBankChangeRequests.employeeId, employeeId), eq(employeeBankChangeRequests.status, "pending")));
}

export interface BankChangeView {
  id: number; employeeId: number; employeeName: string | null; status: string;
  newMasked: string; oldMasked: string | null; requestedById: number; requestedByName: string | null; requestedAt: string;
  decidedAt: string | null; decisionNote: string | null;
  /** IBAN novo por extenso — só para quem pode aprovar */
  newIban?: string;
}

async function hydrate(rows: Array<typeof employeeBankChangeRequests.$inferSelect>, reveal: (employeeId: number) => boolean): Promise<BankChangeView[]> {
  if (!rows.length) return [];
  const db = await dbOrThrow();
  const { users } = await import("../drizzle/schema");
  const empIds = Array.from(new Set(rows.map((r) => r.employeeId)));
  const userIds = Array.from(new Set(rows.map((r) => r.requestedById)));
  const emps = await db.select({ id: employees.id, fullName: employees.fullName }).from(employees).where(inArray(employees.id, empIds));
  const us = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds));
  const empName = new Map(emps.map((e) => [e.id, e.fullName]));
  const userName = new Map(us.map((u) => [u.id, u.name]));
  const { decryptSecret } = await import("./integrations/googleAds/crypto");
  return rows.map((r) => {
    const v: BankChangeView = {
      id: r.id, employeeId: r.employeeId, employeeName: empName.get(r.employeeId) ?? null, status: r.status,
      newMasked: r.newNibMasked, oldMasked: r.oldNibMasked ?? null, requestedById: r.requestedById, requestedByName: userName.get(r.requestedById) ?? null,
      requestedAt: r.requestedAt, decidedAt: r.decidedAt ?? null, decisionNote: r.decisionNote ?? null,
    };
    if (r.status === "pending" && reveal(r.employeeId)) {
      try { v.newIban = decryptSecret(r.newNibEnc); } catch { /* chave mudou: fica só mascarado */ }
    }
    return v;
  });
}

/** Último pedido da ficha (pendente ou o mais recente decidido). */
export async function bankChangeForEmployee(employeeId: number, canReveal: boolean): Promise<BankChangeView | null> {
  const db = await dbOrThrow();
  const rows = await db.select().from(employeeBankChangeRequests).where(eq(employeeBankChangeRequests.employeeId, employeeId))
    .orderBy(desc(employeeBankChangeRequests.id)).limit(1);
  const [v] = await hydrate(rows, () => canReveal);
  return v ?? null;
}

/** Pedidos pendentes (o router filtra pelas fichas que o RH pode tratar). */
export async function pendingBankChanges(limit = 200): Promise<Array<typeof employeeBankChangeRequests.$inferSelect>> {
  const db = await dbOrThrow();
  return db.select().from(employeeBankChangeRequests).where(eq(employeeBankChangeRequests.status, "pending"))
    .orderBy(desc(employeeBankChangeRequests.requestedAt)).limit(limit);
}
export { hydrate as hydrateBankChanges };

/** Aprova (aplica o IBAN novo na ficha) ou recusa. Só pedidos pendentes. */
export async function decideBankChange(requestId: number, approve: boolean, byUserId: number, note?: string | null): Promise<{ employeeId: number; masked: string }> {
  const db = await dbOrThrow();
  const [req] = await db.select().from(employeeBankChangeRequests).where(eq(employeeBankChangeRequests.id, requestId)).limit(1);
  if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
  if (req.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: "Este pedido já foi tratado (ou substituído por outro mais recente)." });
  const found = await getEmployeeById(req.employeeId);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
  const cleanNote = note?.trim().slice(0, 300) || null;
  if (approve) {
    const { decryptSecret } = await import("./integrations/googleAds/crypto");
    let value: string;
    try { value = validIbanOrThrow(decryptSecret(req.newNibEnc)); }
    catch (err: any) { throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Não foi possível ler o IBAN pedido (${String(err?.message ?? err).slice(0, 120)}). Pede à pessoa para o pedir de novo.` }); }
    const before = found.employee.nib ? maskIban(found.employee.nib) : "—";
    await db.update(employees).set({ nib: value }).where(eq(employees.id, req.employeeId));
    await db.update(employeeBankChangeRequests).set({ status: "approved", decidedById: byUserId, decidedAt: nowMysql(), decisionNote: cleanNote })
      .where(and(eq(employeeBankChangeRequests.id, requestId), eq(employeeBankChangeRequests.status, "pending")));
    await logActivity({ userId: byUserId, action: "bank_change_approve", entity: "employee", entityId: req.employeeId,
      details: `IBAN de ${found.employee.fullName} aprovado: ${before} → ${req.newNibMasked}${cleanNote ? ` — ${cleanNote}` : ""}` });
  } else {
    await db.update(employeeBankChangeRequests).set({ status: "rejected", decidedById: byUserId, decidedAt: nowMysql(), decisionNote: cleanNote })
      .where(and(eq(employeeBankChangeRequests.id, requestId), eq(employeeBankChangeRequests.status, "pending")));
    await logActivity({ userId: byUserId, action: "bank_change_reject", entity: "employee", entityId: req.employeeId,
      details: `Pedido de IBAN de ${found.employee.fullName} recusado (${req.newNibMasked})${cleanNote ? ` — ${cleanNote}` : ""}` });
  }
  return { employeeId: req.employeeId, masked: req.newNibMasked };
}
