/**
 * Juntar dois utilizadores da mesma pessoa (decisão do dono, 29 set 2026).
 *
 * Caso típico: a ficha foi criada à mão com um email (ex.: Outlook) → conta A;
 * a pessoa entrou com outra conta Google → conta B "perdida". Juntar:
 *   - fica B (a que entra na app) como conta PRINCIPAL da ficha;
 *   - tudo o que é da pessoa passa de A para B: ficha, contas extra,
 *     permissões e cidades extra, notificações, Google, email, WhatsApp,
 *     casos atribuídos, filtros e conversas do assistente;
 *   - o registo (quem fez o quê) fica como está;
 *   - A fica DESATIVADA ("conta duplicada", `merged_into_<B>`), nunca apagada;
 *   - o email de A fica na ficha como email pessoal, se esse estiver vazio.
 *
 * Diferente de identity.reassignUserReferences (login com o mesmo email), que
 * apaga a conta duplicada: aqui nunca se apaga nada.
 */
import { sql } from "drizzle-orm";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

/**
 * Colunas de DONO (passam de A para B). `unique` = a coluna faz parte de uma
 * chave única: primeiro UPDATE IGNORE, depois o que sobrou em A (repetido em B)
 * é apagado — ganha o que B já tinha.
 */
export const USER_OWNERSHIP_COLUMNS: ReadonlyArray<{ table: string; column: string; unique?: boolean }> = [
  { table: "employee_accounts", column: "userId", unique: true },
  { table: "user_permissions", column: "userId", unique: true },
  { table: "app_notifications", column: "userId" },
  { table: "task_comments", column: "userId" },
  { table: "google_user_accounts", column: "userId", unique: true },
  { table: "google_sync_state", column: "userId", unique: true },
  { table: "google_contacts_state", column: "userId", unique: true },
  { table: "google_task_links", column: "userId", unique: true },
  { table: "google_meetings", column: "userId" },
  { table: "google_watch_channels", column: "userId" },
  { table: "google_directory_people", column: "userId" },
  { table: "google_user_contacts", column: "userId", unique: true },
  { table: "google_pushed_contacts", column: "userId", unique: true },
  { table: "mail_mailboxes", column: "sourceUserId" },
  { table: "mail_threads", column: "ownerUserId" },
  { table: "mail_threads", column: "assignedUserId" },
  { table: "whatsapp_conversations", column: "assignedUserId" },
  { table: "complaints", column: "assignedToId" },
  { table: "lost_found_items", column: "assignedTo" },
  { table: "crm_saved_filters", column: "userId" },
  { table: "ai_chat_conversations", column: "userId" },
  { table: "training_tutor_messages", column: "userId" },
  { table: "invite_tokens", column: "userId" },
];

/** SQL de re-apontar uma coluna (PURA — ids validados como inteiros). */
export function reassignStatements(fromId: number, toId: number): string[] {
  const a = Math.trunc(Number(fromId)), b = Math.trunc(Number(toId));
  if (!(a > 0) || !(b > 0) || a === b) throw new Error("Contas inválidas.");
  const out: string[] = [];
  for (const c of USER_OWNERSHIP_COLUMNS) {
    if (c.unique) {
      out.push(`UPDATE IGNORE \`${c.table}\` SET \`${c.column}\` = ${b} WHERE \`${c.column}\` = ${a}`);
      out.push(`DELETE FROM \`${c.table}\` WHERE \`${c.column}\` = ${a}`);
    } else {
      out.push(`UPDATE \`${c.table}\` SET \`${c.column}\` = ${b} WHERE \`${c.column}\` = ${a}`);
    }
  }
  // Conversas do assistente: a chave de dono também tem o id.
  out.push(`UPDATE \`ai_chat_conversations\` SET \`ownerKey\` = 'user:${b}' WHERE \`ownerKey\` = 'user:${a}'`);
  return out;
}

export const ROLE_RANK: Record<string, number> = { user: 0, extra: 0, condutor: 0, frontoffice: 1, backoffice: 1, team_leader: 2, supervisor: 3, admin: 4, super_admin: 5 };

export interface MergePreview {
  keep: { id: number; name: string | null; email: string | null; role: string; loginMethod: string | null; isActive: boolean };
  drop: { id: number; name: string | null; email: string | null; role: string; loginMethod: string | null; isActive: boolean };
  employee: { id: number; fullName: string } | null;
  warnings: string[];
}

async function loadUser(d: Db, id: number) {
  const r = rowsOf(await d.execute(sql`SELECT id, name, email, role, loginMethod, isActive, department, notificationPrefs FROM users WHERE id = ${id} LIMIT 1`))[0];
  return r ?? null;
}

/** O que vai acontecer (sem mexer em nada). */
export async function previewUserMerge(d: Db, keepId: number, dropId: number): Promise<MergePreview> {
  if (keepId === dropId) throw new Error("Escolhe duas contas diferentes.");
  const [k, x] = await Promise.all([loadUser(d, keepId), loadUser(d, dropId)]);
  if (!k || !x) throw new Error("Conta não encontrada.");
  const warnings: string[] = [];
  const empOf = async (uid: number) => rowsOf(await d.execute(sql`SELECT e.id, e.fullName FROM employees e WHERE e.userId = ${uid} AND e.isActive = 1
    UNION SELECT e.id, e.fullName FROM employee_accounts a JOIN employees e ON e.id = a.employeeId WHERE a.userId = ${uid} AND e.isActive = 1`));
  const [ek, ex] = await Promise.all([empOf(keepId), empOf(dropId)]);
  const ids = new Set([...ek, ...ex].map((e) => Number(e.id)));
  if (ids.size > 1) throw new Error(`As duas contas estão em fichas diferentes (${[...ek, ...ex].map((e) => `${e.fullName} #${e.id}`).join(", ")}). Junta primeiro as fichas.`);
  const emp = [...ek, ...ex][0];
  if (!emp) warnings.push("Nenhuma das contas tem ficha: junta-se só a conta.");
  if (String(x.loginMethod ?? "").startsWith("merged_into_")) throw new Error("A conta a juntar já foi junta a outra.");
  if ((ROLE_RANK[String(x.role)] ?? 0) > (ROLE_RANK[String(k.role)] ?? 0)) warnings.push(`A conta que fica passa a ter o papel "${x.role}" (o mais alto das duas).`);
  const out = (u: any) => ({ id: Number(u.id), name: u.name ?? null, email: u.email ?? null, role: String(u.role), loginMethod: u.loginMethod ?? null, isActive: Number(u.isActive) === 1 });
  return { keep: out(k), drop: out(x), employee: emp ? { id: Number(emp.id), fullName: String(emp.fullName) } : null, warnings };
}

/** Junta `dropId` em `keepId`. Nunca apaga a conta: desativa-a. */
export async function mergeUserAccounts(d: Db, o: { keepId: number; dropId: number; byUserId: number; nowDb: string }): Promise<MergePreview> {
  const p = await previewUserMerge(d, o.keepId, o.dropId);
  const [k, x] = await Promise.all([loadUser(d, o.keepId), loadUser(d, o.dropId)]);
  // 1. Ficha: a conta que fica passa a principal; a outra sai das contas extra.
  if (p.employee) {
    await d.execute(sql`DELETE FROM employee_accounts WHERE userId = ${o.keepId} AND employeeId = ${p.employee.id}`);
    await d.execute(sql`UPDATE employees SET userId = ${o.keepId} WHERE id = ${p.employee.id}`);
    // Email antigo → email pessoal da ficha (se vazio e diferente do de trabalho).
    if (x.email) await d.execute(sql`UPDATE employees SET personalEmail = ${String(x.email).trim().toLowerCase()}
      WHERE id = ${p.employee.id} AND (personalEmail IS NULL OR personalEmail = '') AND LOWER(TRIM(COALESCE(email, ''))) <> ${String(x.email).trim().toLowerCase()}`);
  }
  // 2. Tudo o que é da pessoa passa para a conta que fica.
  for (const st of reassignStatements(o.dropId, o.keepId)) {
    try { await d.execute(sql.raw(st)); } catch { /* tabela/coluna em falta nesta BD — segue */ }
  }
  // 3. Papel (o mais alto), departamento e preferências.
  const role = (ROLE_RANK[String(x.role)] ?? 0) > (ROLE_RANK[String(k.role)] ?? 0) ? String(x.role) : String(k.role);
  await d.execute(sql`UPDATE users SET role = ${role}, department = COALESCE(department, ${x.department ?? null}),
    notificationPrefs = COALESCE(notificationPrefs, ${x.notificationPrefs ?? null}) WHERE id = ${o.keepId}`);
  // 4. A conta antiga fica desativada (nunca apagada) e a sessão dela termina.
  await d.execute(sql`UPDATE users SET isActive = 0, loginMethod = ${`merged_into_${o.keepId}`}, deactivationReason = 'conta_duplicada',
    deactivatedAt = ${o.nowDb}, deactivatedById = ${o.byUserId}, sessionVersion = COALESCE(sessionVersion, 0) + 1 WHERE id = ${o.dropId}`)
    .catch(async () => d.execute(sql`UPDATE users SET isActive = 0, loginMethod = ${`merged_into_${o.keepId}`} WHERE id = ${o.dropId}`));
  return p;
}
