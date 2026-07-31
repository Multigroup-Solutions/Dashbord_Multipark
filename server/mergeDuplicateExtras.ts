/**
 * Cura de EXTRAS DUPLICADOS por email.
 *
 * Contexto: até à correção de 2026-07-31, uma submissão de disponibilidade do
 * site multidriver só procurava a pessoa em `employees.email`. Quem existia
 * apenas como conta de login (`users`) — ou tinha a ficha sem email (import CSV
 * de extras, onde a coluna é opcional) — ficava com uma SEGUNDA ficha "extra
 * pendente" auto-criada. Este módulo encontra e funde esses duplicados.
 *
 * Garantias:
 *   - DRY-RUN por defeito. Só escreve com `apply: true`.
 *   - Só considera perdedores fichas marcadas como AUTO-CRIADAS pelo site
 *     (existe um `activity_logs` com `action='employee_autocreate'` para elas).
 *     Nunca funde duas fichas criadas por pessoas do backoffice.
 *   - RECUSA fundir (bloqueia e reporta) se o duplicado já tiver vida
 *     operacional: escalas, picagens, faltas ou penalizações. Nesses casos a
 *     decisão é humana.
 *   - NUNCA apaga uma ficha — desativa (`isActive = 0`). Há tabelas que
 *     referenciam `employeeId` sem FK.
 */
import { sql } from "drizzle-orm";
import { normalizeEmail } from "../shared/email";
import { normalizePhoneForStorage } from "../shared/phone";
import { getDb, logActivity } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** drizzle `execute` devolve [rows, fields] no mysql2 — normaliza. */
function rowsOf<T = any>(result: unknown): T[] {
  return (Array.isArray((result as any)[0]) ? (result as any)[0] : result) as T[];
}

export interface DuplicateCandidate {
  id: number;
  fullName: string;
  email: string | null;
  phone: string | null;
  nif: string | null;
  position: string;
  isActive: number;
  userId: number | null;
  autoCreated: boolean;
  /** Rastos operacionais que impedem uma fusão automática. */
  assignments: number;
  timeRecords: number;
  leaves: number;
  penalties: number;
  availabilityDays: number;
}

export interface MergePlanGroup {
  email: string;
  survivorId: number;
  loserIds: number[];
  blocked: { id: number; reason: string }[];
  candidates: DuplicateCandidate[];
}

export interface MergeReport {
  apply: boolean;
  groups: MergePlanGroup[];
  merged: number;
  blocked: number;
  movedAvailabilityDays: number;
}

/**
 * Escolhe o sobrevivente de um grupo (PURA — testável sem BD).
 *
 * Regras, por ordem: ficha NÃO auto-criada > ficha com vida operacional >
 * ficha ativa > id mais baixo (a mais antiga é a verdadeira).
 * Devolve `null` quando não há nada a fundir (0 ou 1 ficha, ou nenhuma
 * auto-criada — não inventamos fusões de fichas humanas).
 */
export function planMerge(email: string, candidates: DuplicateCandidate[]): MergePlanGroup | null {
  if (candidates.length < 2) return null;
  if (!candidates.some((c) => c.autoCreated)) return null;

  const operationalWeight = (c: DuplicateCandidate) =>
    c.assignments + c.timeRecords + c.leaves + c.penalties;

  const ranked = [...candidates].sort((a, b) => {
    if (a.autoCreated !== b.autoCreated) return a.autoCreated ? 1 : -1;
    const w = operationalWeight(b) - operationalWeight(a);
    if (w !== 0) return w;
    if (a.isActive !== b.isActive) return b.isActive - a.isActive;
    return a.id - b.id;
  });

  const survivor = ranked[0];
  const losers = ranked.slice(1);
  const blocked: { id: number; reason: string }[] = [];
  const loserIds: number[] = [];

  for (const loser of losers) {
    if (!loser.autoCreated) {
      blocked.push({ id: loser.id, reason: "ficha criada por uma pessoa (não pelo site) — fusão tem de ser manual" });
      continue;
    }
    const marks: string[] = [];
    if (loser.assignments > 0) marks.push(`${loser.assignments} escala(s)`);
    if (loser.timeRecords > 0) marks.push(`${loser.timeRecords} picagem(ns)`);
    if (loser.leaves > 0) marks.push(`${loser.leaves} falta(s)`);
    if (loser.penalties > 0) marks.push(`${loser.penalties} penalização(ões)`);
    if (marks.length > 0) {
      blocked.push({ id: loser.id, reason: `já tem vida operacional (${marks.join(", ")})` });
      continue;
    }
    loserIds.push(loser.id);
  }

  if (loserIds.length === 0 && blocked.length === 0) return null;
  return { email, survivorId: survivor.id, loserIds, blocked, candidates: ranked };
}

/** Lê todos os grupos de fichas que partilham o mesmo email normalizado. */
async function loadDuplicateGroups(db: Db): Promise<Map<string, DuplicateCandidate[]>> {
  const rows = rowsOf<{
    id: number;
    fullName: string;
    email: string | null;
    phone: string | null;
    nif: string | null;
    position: string;
    isActive: number;
    userId: number | null;
    normEmail: string;
    autoCreated: number;
    assignments: number;
    timeRecords: number;
    leaves: number;
    penalties: number;
    availabilityDays: number;
  }>(
    await db.execute(sql`
      SELECT e.id, e.fullName, e.email, e.phone, e.nif, e.position, e.isActive, e.userId,
             LOWER(TRIM(COALESCE(e.email, u.email))) AS normEmail,
             EXISTS (SELECT 1 FROM activity_logs al
                      WHERE al.entity = 'employees' AND al.action = 'employee_autocreate' AND al.entityId = e.id) AS autoCreated,
             (SELECT COUNT(*) FROM extras_dia_assignments a WHERE a.employeeId = e.id) AS assignments,
             (SELECT COUNT(*) FROM time_records t WHERE t.employeeId = e.id) AS timeRecords,
             (SELECT COUNT(*) FROM employee_leaves l WHERE l.employeeId = e.id) AS leaves,
             (SELECT COUNT(*) FROM employee_penalties p WHERE p.employeeId = e.id) AS penalties,
             (SELECT COUNT(*) FROM extras_availability av WHERE av.employeeId = e.id) AS availabilityDays
        FROM employees e
        LEFT JOIN users u ON u.id = e.userId
       WHERE COALESCE(e.email, u.email) IS NOT NULL AND TRIM(COALESCE(e.email, u.email)) <> ''`),
  );

  const groups = new Map<string, DuplicateCandidate[]>();
  for (const r of rows) {
    const email = normalizeEmail(r.normEmail);
    if (!email) continue;
    const list = groups.get(email) ?? [];
    list.push({
      id: Number(r.id),
      fullName: r.fullName,
      email: r.email,
      phone: r.phone,
      nif: r.nif,
      position: r.position,
      isActive: Number(r.isActive),
      userId: r.userId != null ? Number(r.userId) : null,
      autoCreated: Number(r.autoCreated) === 1,
      assignments: Number(r.assignments),
      timeRecords: Number(r.timeRecords),
      leaves: Number(r.leaves),
      penalties: Number(r.penalties),
      availabilityDays: Number(r.availabilityDays),
    });
    groups.set(email, list);
  }
  return groups;
}

/**
 * Executa um UPDATE ignorando "tabela não existe" (ER_NO_SUCH_TABLE 1146):
 * nem todos os ambientes têm as migrações mais recentes aplicadas.
 */
async function updateIfTableExists(db: Db, statement: ReturnType<typeof sql>): Promise<void> {
  try {
    await db.execute(statement);
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code === "ER_NO_SUCH_TABLE" || err?.cause?.errno === 1146) return;
    throw err;
  }
}

/** Aplica a fusão de UM grupo. Devolve quantos dias de disponibilidade moveu. */
async function applyGroup(db: Db, group: MergePlanGroup): Promise<number> {
  const survivor = group.candidates.find((c) => c.id === group.survivorId)!;
  let moved = 0;

  for (const loserId of group.loserIds) {
    const loser = group.candidates.find((c) => c.id === loserId)!;

    // 1. Disponibilidade: o duplicado é a ficha que o SITE alimentou, logo os
    //    dias dele são a submissão mais recente e ganham. `extras_availability`
    //    tem UNIQUE(employeeId, day), por isso os dias em colisão têm de sair
    //    do sobrevivente antes de mover os do duplicado.
    await db.execute(sql`
      DELETE FROM extras_availability
       WHERE employeeId = ${survivor.id}
         AND day IN (SELECT day FROM (SELECT day FROM extras_availability WHERE employeeId = ${loserId}) AS d)`);
    const res = await db.execute(sql`
      UPDATE extras_availability SET employeeId = ${survivor.id} WHERE employeeId = ${loserId}`);
    moved += Number((rowsOf(res)[0] as any)?.affectedRows ?? (res as any)?.affectedRows ?? 0);

    // 2. Tokens do formulário externo e conversas WhatsApp seguem a pessoa.
    //    Tolerante a tabela inexistente: as migrações 0045/0047 podem ainda
    //    não estar aplicadas neste ambiente (ver memory/whatsapp-integration.md).
    await updateIfTableExists(db, sql`UPDATE availability_form_tokens SET employeeId = ${survivor.id} WHERE employeeId = ${loserId}`);
    await updateIfTableExists(db, sql`UPDATE whatsapp_conversations SET employeeId = ${survivor.id} WHERE employeeId = ${loserId}`);

    // 3. Contactos em falta no sobrevivente vêm do duplicado (COALESCE nunca
    //    substitui o que o backoffice já preencheu).
    const phoneFromLoser = normalizePhoneForStorage(loser.phone);
    await db.execute(sql`
      UPDATE employees SET
        email = COALESCE(email, ${loser.email}),
        phone = COALESCE(phone, ${phoneFromLoser}),
        nif   = COALESCE(nif, ${loser.nif})
      WHERE id = ${survivor.id}`);

    // 4. Desativa o duplicado (nunca apagar — há tabelas sem FK a apontar-lhe).
    await db.execute(sql`UPDATE employees SET isActive = 0 WHERE id = ${loserId}`);

    await logActivity({
      userId: 0,
      action: "employee_merge",
      entity: "employees",
      entityId: survivor.id,
      details: `Duplicado #${loserId} (${loser.fullName} <${loser.email ?? "sem email"}>) fundido em #${survivor.id} por email ${group.email}; disponibilidade transferida, ficha #${loserId} desativada`,
    });
  }

  // 5. Garante a ligação à conta de login (identidade única daqui para a frente).
  if (!survivor.userId) {
    await db.execute(sql`
      UPDATE employees SET userId = (
        SELECT id FROM users WHERE LOWER(TRIM(email)) = ${group.email} ORDER BY isActive DESC, id ASC LIMIT 1
      ) WHERE id = ${survivor.id} AND userId IS NULL`);
  }

  return moved;
}

/**
 * Encontra (e opcionalmente funde) extras duplicados por email.
 * `apply: false` (default) devolve o plano sem escrever nada.
 */
export async function mergeDuplicateExtras(opts: { apply?: boolean } = {}): Promise<MergeReport> {
  const apply = opts.apply === true;
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");

  let groups: Map<string, DuplicateCandidate[]>;
  try {
    groups = await loadDuplicateGroups(db);
  } catch (err: any) {
    // Tipicamente uma tabela em falta (migração por aplicar neste ambiente).
    throw new Error(`Não foi possível analisar duplicados: ${err?.cause?.message ?? err?.message ?? err}`);
  }
  const plans: MergePlanGroup[] = [];
  for (const [email, candidates] of groups) {
    const plan = planMerge(email, candidates);
    if (plan) plans.push(plan);
  }

  let movedAvailabilityDays = 0;
  if (apply) {
    for (const plan of plans) {
      if (plan.loserIds.length > 0) movedAvailabilityDays += await applyGroup(db, plan);
    }
  }

  return {
    apply,
    groups: plans,
    merged: plans.reduce((n, p) => n + p.loserIds.length, 0),
    blocked: plans.reduce((n, p) => n + p.blocked.length, 0),
    movedAvailabilityDays,
  };
}
