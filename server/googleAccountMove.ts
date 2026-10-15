/**
 * Passar uma conta Google de uma conta desativada para a conta de outra pessoa
 * (Jorge, 15 out 2026 — o caso do Thiago Camargo).
 *
 * Caso típico: a Google Workspace RENOMEIA a conta de quem saiu
 * (carlosjesus@multipark.pt → thiagocamargo@multipark.pt). Para a Google é a
 * mesma conta (o mesmo `sub`), por isso o dashboard continua a reconhecê-la
 * como a conta antiga — desativada, ligada à ficha de quem saiu — e a pessoa
 * nova fica à porta.
 *
 * Passar a conta Google:
 *  - a conta ANTIGA (`from`, tem de estar desativada) larga a Google: o
 *    googleSub fica vazio e o openId passa a `released_<id>_<hora>`; volta a ter
 *    o nome e o email da sua ficha principal (o histórico — ponto, tarefas,
 *    registos — está preso ao número da conta e fica todo com ela);
 *  - a conta NOVA (`to`, ativa) passa a entrar com essa Google (googleSub) e,
 *    com `setEmail`, fica com o email dela como principal. O openId da conta
 *    nova não muda: quem já entrava com outra Google continua a entrar.
 *  - nada se apaga; fica no registo de atividade das duas contas.
 */
import { sql } from "drizzle-orm";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

export interface MoveAccountRow {
  id: number; name: string | null; email: string | null; openId: string; googleSub: string | null;
  isActive: number | boolean; role: string | null;
}
export interface MoveGooglePlan {
  from: MoveAccountRow; to: MoveAccountRow;
  /** o nome e o email que a conta antiga volta a ter (da ficha principal); null = fica como está */
  restore: { name: string | null; email: string | null; employeeId: number | null };
  googleEmail: string | null;
  releasedOpenId: string;
}

/** Regras puras: quando se pode passar e o que fica em cada conta. PURA. */
export function planGoogleMove(o: {
  from: MoveAccountRow | null; to: MoveAccountRow | null;
  fromEmployee: { id: number; fullName: string | null; email: string | null } | null;
  nowMs: number;
}): MoveGooglePlan {
  const { from, to } = o;
  if (!from) throw new Error("A conta de onde sai a Google não existe.");
  if (!to) throw new Error("A conta para onde vai a Google não existe.");
  if (from.id === to.id) throw new Error("Escolhe duas contas diferentes.");
  if (Number(from.isActive) === 1 || from.isActive === true) throw new Error("Só se tira a Google de uma conta DESATIVADA (a de quem saiu).");
  if (!(Number(to.isActive) === 1 || to.isActive === true)) throw new Error("A conta que recebe a Google tem de estar ativa.");
  const sub = from.googleSub ?? (from.openId.startsWith("google_") ? from.openId.slice("google_".length) : null);
  if (!sub) throw new Error("Essa conta não tem nenhuma conta Google ligada.");
  const fe = o.fromEmployee;
  return {
    from, to,
    restore: { name: fe?.fullName?.trim() || null, email: fe?.email?.trim().toLowerCase() || null, employeeId: fe?.id ?? null },
    googleEmail: from.email,
    releasedOpenId: `released_${from.id}_${Math.floor(o.nowMs / 1000)}`.slice(0, 64),
  };
}

export function googleSubOf(a: Pick<MoveAccountRow, "googleSub" | "openId">): string | null {
  return a.googleSub ?? (a.openId.startsWith("google_") ? a.openId.slice("google_".length) : null);
}

const ACCOUNT_COLS = sql`id, name, email, openId, googleSub, isActive, role`;

async function accountById(d: Db, id: number): Promise<MoveAccountRow | null> {
  return (rowsOf(await d.execute(sql`SELECT ${ACCOUNT_COLS} FROM users WHERE id = ${id} LIMIT 1`))[0] as MoveAccountRow | undefined) ?? null;
}

/** A ficha principal da conta (a que a conta antiga volta a mostrar). */
async function principalEmployeeOf(d: Db, userId: number): Promise<{ id: number; fullName: string | null; email: string | null } | null> {
  const r = rowsOf(await d.execute(sql`SELECT id, fullName, email FROM employees WHERE userId = ${userId} ORDER BY isActive DESC, id ASC LIMIT 1`));
  return (r[0] as any) ?? null;
}

export async function previewGoogleMove(d: Db, fromUserId: number, toUserId: number, nowMs = Date.now()): Promise<MoveGooglePlan> {
  const [from, to, fe] = await Promise.all([accountById(d, fromUserId), accountById(d, toUserId), principalEmployeeOf(d, fromUserId)]);
  return planGoogleMove({ from, to, fromEmployee: fe, nowMs });
}

/**
 * Faz a passagem. Os UPDATE são condicionais ao estado lido (a conta antiga
 * ainda com aquela Google; a nova ativa), por isso dois cliques seguidos não
 * fazem nada a dobrar.
 */
export async function moveGoogleAccount(d: Db, o: { fromUserId: number; toUserId: number; setEmail: boolean; nowMs?: number }): Promise<MoveGooglePlan & { emailSet: boolean }> {
  const plan = await previewGoogleMove(d, o.fromUserId, o.toUserId, o.nowMs ?? Date.now());
  const sub = googleSubOf(plan.from)!;
  // 1. a conta antiga larga a Google (e volta ao nome/email da ficha)
  const freed = await d.execute(sql`UPDATE users SET googleSub = NULL, openId = ${plan.releasedOpenId},
      name = COALESCE(${plan.restore.name}, name), email = COALESCE(${plan.restore.email}, email)
    WHERE id = ${plan.from.id} AND isActive = 0 AND openId = ${plan.from.openId}`);
  const freedRows = Number((Array.isArray(freed) ? freed[0] : freed)?.affectedRows ?? 0);
  if (freedRows !== 1) throw new Error("A conta antiga mudou entretanto — recarrega e tenta outra vez.");
  // 2. a conta nova passa a entrar com esta Google (o openId dela fica: a outra Google continua a entrar)
  const emailSet = o.setEmail && !!plan.googleEmail;
  await d.execute(emailSet
    ? sql`UPDATE users SET googleSub = ${sub}, email = ${plan.googleEmail} WHERE id = ${plan.to.id} AND isActive = 1`
    : sql`UPDATE users SET googleSub = ${sub} WHERE id = ${plan.to.id} AND isActive = 1`);
  return { ...plan, emailSet };
}
