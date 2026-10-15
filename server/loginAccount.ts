/**
 * Plano 56 (A1): a procura ÚNICA da conta de quem entra — com a Google ou com
 * um código. Mesmo email = mesma pessoa:
 *
 *  - conta com este email (ativa ou não; nunca as fundidas `merged_into_…`;
 *    Gmail com pontos ou "+" conta como o mesmo);
 *  - senão, a ficha com este email (trabalho ou pessoal, ativa ou não) → a
 *    conta dela, mas só se for utilizador/extra/condutor (a estrutura entra
 *    com Google com o email da conta);
 *  - empate → a conta principal da ficha ativa; senão recusa (e os admins
 *    ficam a saber);
 *  - nunca as caixas partilhadas da Comunicação (reservas@, info@…);
 *  - nada encontrado → conta nova, mas só depois do código certo.
 */
import { canUsePassword, isPlaceholderAccount } from "../shared/loginCode";
import { normalizeEmail } from "../shared/email";
import type { LoginFichaRow, LoginStore, LoginUserRow } from "./loginStore";

export type LoginLookup =
  | { kind: "account"; user: LoginUserRow; ficha: LoginFichaRow | null; via: "email" | "ficha" }
  /** Sem conta: cria-se (utilizador) depois do código certo; `ficha` = a ficha com este email, se houver. */
  | { kind: "new"; ficha: LoginFichaRow | null }
  | { kind: "refused"; reason: "shared_mailbox" | "ambiguous" | "staff_ficha" | "invalid"; detail?: string };

const pickFicha = (fichas: LoginFichaRow[]): LoginFichaRow | null =>
  [...fichas].sort((a, b) => b.isActive - a.isActive || a.id - b.id)[0] ?? null;

async function fichaOf(store: LoginStore, userId: number): Promise<LoginFichaRow | null> {
  return pickFicha(await store.fichasOfUser(userId));
}

/** Entre várias contas: a principal de uma ficha ativa; senão a única ativa; senão nenhuma. */
async function breakTie(store: LoginStore, users: LoginUserRow[], fichas?: LoginFichaRow[]): Promise<LoginUserRow | null> {
  const ids = new Set(users.map((u) => u.id));
  const principals = new Set<number>();
  if (fichas) {
    for (const f of fichas) if (f.isActive === 1 && f.userId != null && ids.has(f.userId)) principals.add(f.userId);
  } else {
    for (const u of users) {
      const own = await store.fichasOfUser(u.id);
      if (own.some((f) => f.isActive === 1 && f.userId === u.id)) principals.add(u.id);
    }
  }
  if (principals.size === 1) return users.find((u) => principals.has(u.id)) ?? null;
  const active = users.filter((u) => u.isActive === 1);
  if (principals.size === 0 && active.length === 1) return active[0];
  return null;
}

export async function findLoginAccountByEmail(store: LoginStore, rawEmail: string): Promise<LoginLookup> {
  const email = normalizeEmail(rawEmail);
  if (!email || !email.includes("@")) return { kind: "refused", reason: "invalid" };
  if (await store.isSharedMailbox(email)) return { kind: "refused", reason: "shared_mailbox" };

  const direct = await store.usersByEmail(email);
  if (direct.length === 1) return { kind: "account", user: direct[0], ficha: await fichaOf(store, direct[0].id), via: "email" };
  if (direct.length > 1) {
    const one = await breakTie(store, direct);
    if (!one) return { kind: "refused", reason: "ambiguous", detail: `contas #${direct.map((u) => u.id).join(", #")}` };
    return { kind: "account", user: one, ficha: await fichaOf(store, one.id), via: "email" };
  }

  const fichas = await store.fichasByEmail(email);
  if (!fichas.length) return { kind: "new", ficha: null };
  const linkedIds = Array.from(new Set(fichas.flatMap((f) => [f.userId, ...f.aliasUserIds]).filter((x): x is number => typeof x === "number" && x > 0)));
  const linked = linkedIds.length ? await store.usersByIds(linkedIds) : [];
  if (!linked.length) return { kind: "new", ficha: pickFicha(fichas) };
  // Pela ficha só as contas de utilizador/extra/condutor (a estrutura entra com Google com o email da conta).
  const usable = linked.filter((u) => canUsePassword(u.role));
  if (!usable.length) return { kind: "refused", reason: "staff_ficha", detail: `ficha #${pickFicha(fichas)?.id}` };
  const user = usable.length === 1 ? usable[0] : await breakTie(store, usable, fichas);
  if (!user) return { kind: "refused", reason: "ambiguous", detail: `contas #${usable.map((u) => u.id).join(", #")} da ficha` };
  const ficha = fichas.find((f) => f.userId === user.id || f.aliasUserIds.includes(user.id)) ?? pickFicha(fichas);
  return { kind: "account", user, ficha, via: "ficha" };
}

export type GoogleResolution =
  /** O caminho de sempre (adotar a conta do backoffice / criar ou atualizar `google_<sub>`). */
  | { kind: "default"; existing: LoginUserRow | null }
  /** Conta já ligada a esta Google (googleSub) ou achada pelo email: entra nela sem mudar o openId. */
  | { kind: "linked"; user: LoginUserRow; how: "googleSub" | "email" | "ficha" }
  /** O email é de uma conta ligada a OUTRA Google: não junta sozinho. */
  | { kind: "conflict"; user: LoginUserRow; reason: string };

/**
 * Google → conta: googleSub → openId `google_<sub>` → (com ENTRAR_COM_CODIGO)
 * a procura por email. Desligado, ou sem nada achado, segue o caminho de
 * sempre — quem já entra com a Google entra exatamente como antes.
 */
export async function resolveGoogleAccount(store: LoginStore, input: { sub: string; email: string; codeLogin: boolean }): Promise<GoogleResolution> {
  const openId = `google_${input.sub}`;
  const bySub = await store.userByGoogleSub(input.sub);
  if (bySub) return bySub.openId === openId ? { kind: "default", existing: bySub } : { kind: "linked", user: bySub, how: "googleSub" };
  const byOpenId = await store.userByOpenId(openId);
  if (byOpenId) return { kind: "default", existing: byOpenId };
  if (!input.codeLogin || !input.email) return { kind: "default", existing: null };

  const found = await findLoginAccountByEmail(store, input.email);
  if (found.kind !== "account") return { kind: "default", existing: null };
  const u = found.user;
  // A conta do backoffice ainda por usar, com este email: o caminho de sempre
  // adota-a (fica `google_<sub>`). Achada pela ficha: entra-se nela (linked).
  if (isPlaceholderAccount(u) && found.via === "email") return { kind: "default", existing: null };
  if (u.googleSub && u.googleSub !== input.sub) return { kind: "conflict", user: u, reason: "já ligada a outra conta Google" };
  if (!u.googleSub && u.openId.startsWith("google_") && u.openId !== openId) return { kind: "conflict", user: u, reason: "já ligada a outra conta Google" };
  return { kind: "linked", user: u, how: found.via };
}
