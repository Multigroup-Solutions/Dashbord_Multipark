/**
 * Lógica dos endpoints da app externa de disponibilidades (Fase 4).
 *
 * Reutiliza a lógica EXISTENTE de `extrasAvailability` — `getMyWeek` e
 * `setMyAvailability` já são keyed por `employeeId` (não dependem do ctx de
 * sessão), por isso não foi preciso extrair nenhum core: usam-se diretamente.
 *
 * A app externa é NÃO-confiável mesmo com API key → validação zod do input e
 * respostas mínimas (sem email/telefone/id interno para além do necessário).
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { employees } from "../drizzle/schema";
import { getMyWeek, setMyAvailability, type MyWeek } from "./extrasAvailability";
import {
  verifyAvailabilityFormToken,
  consumeAvailabilityFormToken,
  type FormTokenError,
} from "./availabilityFormToken";
import { logActivity } from "./db";

// ─── Validação do submit (zod) ──────────────────────────────────────────────
// Espelha o input de extrasAvailability.setMyWeek; weekStart NÃO vem do body —
// é autoritativo a partir do token.
export const submitDaysSchema = z
  .array(
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      morning: z.boolean().optional(),
      night: z.boolean().optional(),
      fromHour: z.number().int().min(0).max(23).nullable().optional(),
      toHour: z.number().int().min(0).max(23).nullable().optional(),
      note: z.string().max(300).nullable().optional(),
    }),
  )
  .max(7);

export type SubmitDays = z.infer<typeof submitDaysSchema>;

// ─── Context builder (puro, shape mínimo) ───────────────────────────────────
export interface FormContext {
  firstName: string;
  weekStart: string;
  weekEnd: string;
  days: MyWeek["days"];
  submitted: boolean;
}

/** Constrói a resposta do /context. Só primeiro nome + a semana; sem email,
 *  telefone nem id interno. */
export function buildFormContext(fullName: string | null, myWeek: MyWeek): FormContext {
  const firstName = (fullName ?? "").trim().split(/\s+/)[0] || "";
  return {
    firstName,
    weekStart: myWeek.weekStart,
    weekEnd: myWeek.weekEnd,
    days: myWeek.days,
    submitted: myWeek.submitted,
  };
}

// ─── Mapeamento de erros de token → HTTP + código distinguível ──────────────
export interface FormErrorResponse {
  status: number;
  code: string;
  message: string;
}

export function tokenErrorResponse(error: FormTokenError): FormErrorResponse {
  switch (error) {
    case "expired":
      return { status: 410, code: "token_expired", message: "O link expirou." };
    case "used":
      return { status: 410, code: "token_already_used", message: "Este link já foi utilizado." };
    default:
      return { status: 401, code: "token_invalid", message: "Link inválido." };
  }
}

export type FormResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string };

// ─── Orquestração ───────────────────────────────────────────────────────────

/** GET /context — valida o token SEM consumir e devolve o contexto mínimo. */
export async function getFormContext(token: string): Promise<FormResult<FormContext>> {
  const db = await getDb();
  if (!db) return { ok: false, status: 500, code: "server_error", message: "Base de dados indisponível." };

  const v = await verifyAvailabilityFormToken(db, token);
  if (!v.ok) {
    const e = tokenErrorResponse(v.error);
    return { ok: false, status: e.status, code: e.code, message: e.message };
  }

  const myWeek = await getMyWeek(v.employeeId, v.weekStart);
  const empRows = await db
    .select({ fullName: employees.fullName })
    .from(employees)
    .where(eq(employees.id, v.employeeId))
    .limit(1);

  return { ok: true, data: buildFormContext(empRows[0]?.fullName ?? null, myWeek) };
}

/** POST /submit — valida o token, CONSOME (single-use) e escreve via
 *  setMyAvailability. A ordem consome→escreve é à prova de duplo-submit. */
export async function submitForm(token: string, days: SubmitDays): Promise<FormResult<{ saved: number }>> {
  const db = await getDb();
  if (!db) return { ok: false, status: 500, code: "server_error", message: "Base de dados indisponível." };

  const v = await verifyAvailabilityFormToken(db, token);
  if (!v.ok) {
    const e = tokenErrorResponse(v.error);
    return { ok: false, status: e.status, code: e.code, message: e.message };
  }

  // Consome ANTES de escrever: UPDATE ... WHERE usedAt IS NULL. Se outra
  // submissão ganhou a corrida, affectedRows=0 → já usado.
  const consumed = await consumeAvailabilityFormToken(db, v.jti);
  if (!consumed) {
    const e = tokenErrorResponse("used");
    return { ok: false, status: e.status, code: e.code, message: e.message };
  }

  const result = await setMyAvailability(v.employeeId, v.weekStart, days, null);

  await logActivity({
    userId: 0, // veio da app externa (sem sessão) — padrão dos logs de API
    action: "availability_form_submit",
    entity: "extras_availability",
    entityId: v.employeeId,
    details: `Disponibilidade via formulário externo (extra ${v.employeeId}, semana ${v.weekStart}): ${result.saved} dias`,
  });

  return { ok: true, data: { saved: result.saved } };
}
