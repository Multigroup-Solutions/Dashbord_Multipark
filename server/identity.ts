/**
 * Identidade por EMAIL — resolução única para toda a aplicação.
 *
 * REGRA DO SISTEMA: uma pessoa é identificada pelo EMAIL. O mesmo email nunca
 * pode dar origem a duas identidades (dois `users`, dois `employees`, ou um
 * "extra" duplicado criado por uma submissão do site).
 *
 * O problema que este módulo resolve: a identidade vive em DUAS tabelas —
 *   - `users`     → conta de login (Google OAuth ou criada à mão pelo admin)
 *   - `employees` → ficha de colaborador (pode existir sem conta, e vice-versa)
 * ligadas por `employees.userId`. Quem procurar só numa delas conclui
 * erradamente que a pessoa não existe e cria um duplicado. Todas as procuras
 * por email têm de passar por aqui.
 *
 * Comparação SEMPRE por `LOWER(TRIM(...))` dos dois lados: a collation da BD
 * não é garantia (varia por tabela/servidor) e os dados legados têm espaços.
 */
import { asc, desc, eq, sql } from "drizzle-orm";
import { normalizeEmail } from "../shared/email";
import { normalizePhoneForStorage } from "../shared/phone";
import { getDb, logActivity } from "./db";
import { driverApplications, employees, users } from "../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ResolvedUser {
  id: number;
  openId: string;
  email: string | null;
  name: string | null;
  role: string;
  isActive: number;
  loginMethod: string | null;
}

export interface ResolvedEmployee {
  id: number;
  fullName: string;
  email: string | null;
  phone: string | null;
  position: string;
  isActive: number;
  userId: number | null;
}

/** Uma conta de login criada à mão pelo admin ainda não usada para entrar. */
export function isPlaceholderLogin(user: Pick<ResolvedUser, "openId" | "loginMethod">): boolean {
  // Uma conta já fundida noutra mantém o openId `manual_...` (nunca é apagada,
  // os activity_logs referenciam-na), mas NÃO é placeholder: se voltasse a
  // sê-lo, cada login repetiria o merge e copiaria o seu isActive=0 para a
  // conta real, desativando-a a cada entrada.
  if ((user.loginMethod ?? "").startsWith("merged_into_")) return false;
  return user.openId.startsWith("manual_") || user.loginMethod === "manual";
}

/**
 * Conta de login com este email. Preferência: ativa > id mais baixo (a mais
 * antiga é a "verdadeira"; duplicados só podem ter nascido de bugs).
 */
export async function findUserByEmail(db: Db, rawEmail: string): Promise<ResolvedUser | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const rows = await db
    .select({
      id: users.id,
      openId: users.openId,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      loginMethod: users.loginMethod,
    })
    .from(users)
    .where(sql`LOWER(TRIM(${users.email})) = ${email}`)
    .orderBy(desc(users.isActive), asc(users.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Ficha de colaborador com este email — diretamente (`employees.email`) ou
 * através da conta de login ligada (`employees.userId` → `users.email`).
 *
 * O segundo caminho é essencial: extras importados por CSV entram muitas vezes
 * SEM email na ficha (a coluna é opcional no import), e a única cópia do email
 * está na conta de login. Sem ele, uma submissão do site cria um duplicado.
 *
 * Preferência: extra > ativo > id mais baixo.
 */
export async function findEmployeeByEmail(db: Db, rawEmail: string): Promise<ResolvedEmployee | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;

  const direct = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      email: employees.email,
      phone: employees.phone,
      position: employees.position,
      isActive: employees.isActive,
      userId: employees.userId,
    })
    .from(employees)
    .where(sql`LOWER(TRIM(${employees.email})) = ${email}`)
    // ATIVO manda mais que a função: uma ficha desativada (ex.: duplicado já
    // fundido) nunca pode ganhar a uma ficha ativa da mesma pessoa.
    .orderBy(desc(employees.isActive), desc(sql`(${employees.position} = 'extra')`), asc(employees.id))
    .limit(1);
  if (direct.length > 0) return direct[0];

  const user = await findUserByEmail(db, email);
  if (!user) return null;

  const linked = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      email: employees.email,
      phone: employees.phone,
      position: employees.position,
      isActive: employees.isActive,
      userId: employees.userId,
    })
    .from(employees)
    .where(eq(employees.userId, user.id))
    // ATIVO manda mais que a função: uma ficha desativada (ex.: duplicado já
    // fundido) nunca pode ganhar a uma ficha ativa da mesma pessoa.
    .orderBy(desc(employees.isActive), desc(sql`(${employees.position} = 'extra')`), asc(employees.id))
    .limit(1);
  return linked[0] ?? null;
}

export interface ExtraResolution {
  id: number;
  created: boolean;
  /** Como foi encontrado — para logs e para o relatório do endpoint do site. */
  matchedBy: "employee_email" | "linked_user" | "created";
  userId: number | null;
}

/**
 * Resolve (ou cria) a ficha de EXTRA para um email vindo do exterior.
 *
 * Ordem obrigatória:
 *   1. Ficha existente (por email da ficha OU pela conta de login ligada).
 *   2. Só se não existir NADA é que cria — e a nova ficha nasce já LIGADA à
 *      conta de login com o mesmo email (se existir), para não voltar a
 *      partir-se em duas identidades no futuro.
 *
 * Nunca desativa nem reposiciona uma ficha existente: se a pessoa é `driver`
 * ou `backoffice` e submete disponibilidade, a disponibilidade é dela — a
 * mudança de `position` é uma decisão de RH, não do site.
 */
export async function findOrCreateExtraByEmail(
  db: Db,
  rawEmail: string,
  hints?: { fullName?: string | null; phone?: string | null; nif?: string | null },
): Promise<ExtraResolution> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error("Email em falta");

  const existing = await findEmployeeByEmail(db, email);
  if (existing) {
    await backfillEmployeeContacts(db, existing, email, hints);
    return {
      id: existing.id,
      created: false,
      matchedBy: existing.email && normalizeEmail(existing.email) === email ? "employee_email" : "linked_user",
      userId: existing.userId,
    };
  }

  // Sem ficha → cria um extra pendente. Nome/contactos vêm da candidatura do
  // site, dos hints do pedido, ou (último recurso) do prefixo do email.
  const app = await db
    .select({
      fullName: driverApplications.fullName,
      phone: driverApplications.phone,
      nif: driverApplications.nif,
    })
    .from(driverApplications)
    .where(sql`LOWER(TRIM(${driverApplications.email})) = ${email}`)
    .limit(1);

  const user = await findUserByEmail(db, email);
  const fullName =
    (hints?.fullName || "").trim() ||
    (app[0]?.fullName || "").trim() ||
    (user?.name || "").trim() ||
    email.split("@")[0];

  const result = await db.insert(employees).values({
    fullName: fullName.slice(0, 256),
    email,
    phone: normalizePhoneForStorage(hints?.phone ?? app[0]?.phone ?? null),
    nif: (hints?.nif ?? app[0]?.nif ?? null)?.slice(0, 20) ?? null,
    position: "extra",
    contractType: "extra",
    userId: user?.id ?? null,
    isActive: 1,
  });
  const id = Number((result as any)[0]?.insertId ?? (result as any).insertId);

  await logActivity({
    userId: 0,
    action: "employee_autocreate",
    entity: "employees",
    entityId: id,
    details: `[Website] Extra pendente auto-criado: ${fullName} <${email}>${user ? ` (ligado ao utilizador ${user.id})` : " (sem conta de login)"}`,
  });

  return { id, created: true, matchedBy: "created", userId: user?.id ?? null };
}

/**
 * Preenche lacunas da ficha existente com o que o site trouxe — nunca
 * SUBSTITUI dados já preenchidos pelo backoffice (fonte de verdade interna).
 */
async function backfillEmployeeContacts(
  db: Db,
  employee: ResolvedEmployee,
  email: string,
  hints?: { phone?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (!employee.email) patch.email = email;
  if (!employee.phone && hints?.phone) {
    const phone = normalizePhoneForStorage(hints.phone);
    if (phone) patch.phone = phone;
  }
  if (!employee.userId) {
    const user = await findUserByEmail(db, email);
    if (user) patch.userId = user.id;
  }
  if (Object.keys(patch).length === 0) return;
  await db.update(employees).set(patch).where(eq(employees.id, employee.id));
}

/**
 * Liga um login Google a uma conta criada à mão pelo admin com o MESMO email.
 *
 * Sem isto, quem foi registado pelo backoffice e entra pela primeira vez fica
 * com uma SEGUNDA linha em `users` (role `user`, sem as permissões que o admin
 * lhe deu) e a conta original nunca chega a ser usada.
 *
 * Só adota contas ainda não usadas para entrar (`manual_...`) — nunca rouba um
 * openId Google já ativo.
 *
 * Devolve a conta adotada, ou `null` se não havia nada para adotar.
 */
export async function adoptPlaceholderAccountByEmail(
  db: Db,
  rawEmail: string,
  openId: string,
  name: string | null,
): Promise<ResolvedUser | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;

  // Todas as contas com este email — pode haver mais do que uma por causa do
  // bug histórico (login criava linha nova em vez de adotar a do backoffice).
  const rows = await db
    .select({
      id: users.id,
      openId: users.openId,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      loginMethod: users.loginMethod,
    })
    .from(users)
    .where(sql`LOWER(TRIM(${users.email})) = ${email}`)
    .orderBy(asc(users.id));
  if (rows.length === 0) return null;

  const oauthRow = rows.find((r) => r.openId === openId) ?? null;
  const placeholder = rows.find((r) => r.id !== oauthRow?.id && isPlaceholderLogin(r)) ?? null;

  // Caso normal: a conta do backoffice ainda não foi usada → assume o openId.
  if (!oauthRow && placeholder) {
    await db
      .update(users)
      .set({
        openId,
        loginMethod: "google",
        email,
        ...(name ? { name } : {}),
        lastSignedIn: new Date().toISOString().slice(0, 19).replace("T", " "),
      })
      .where(eq(users.id, placeholder.id));
    await logActivity({
      userId: placeholder.id,
      action: "account_link",
      entity: "user",
      entityId: placeholder.id,
      details: `Primeiro login Google ligado à conta registada pelo backoffice <${email}>`,
    });
    return { ...placeholder, openId, loginMethod: "google", email };
  }

  // Estado partido herdado: existem AS DUAS linhas (a do backoffice e a criada
  // pelo login). Não se pode duplicar o openId (índice UNIQUE) → transfere o
  // role/departamento/estado para a linha OAuth e desativa a do backoffice.
  // Nunca apagar: os `activity_logs` referenciam o userId.
  if (oauthRow && placeholder) {
    await db
      .update(users)
      .set({ role: placeholder.role as any, isActive: placeholder.isActive, email })
      .where(eq(users.id, oauthRow.id));
    await db
      .update(users)
      .set({ isActive: 0, loginMethod: `merged_into_${oauthRow.id}`.slice(0, 64) })
      .where(eq(users.id, placeholder.id));
    // A FICHA DE FUNCIONÁRIO tem de seguir a fusão — sem isto o ponto-no-
    // avatar (e tudo o que depende de employees.userId) desaparecia para a
    // conta Google ativa (caso Carlos/César/Márcia/Maxwell, ago-2026).
    try {
      await db
        .update(employees)
        .set({ userId: oauthRow.id })
        .where(eq(employees.userId, placeholder.id));
    } catch { /* best-effort — não pode partir o login */ }
    await logActivity({
      userId: oauthRow.id,
      action: "account_merge",
      entity: "user",
      entityId: oauthRow.id,
      details: `Conta duplicada <${email}>: role/estado de #${placeholder.id} (backoffice) transferidos para #${oauthRow.id} (login Google); #${placeholder.id} desativada`,
    });
    return { ...oauthRow, role: placeholder.role, isActive: placeholder.isActive, email };
  }

  return oauthRow;
}
