/**
 * Plano 56 (A2): a sessão de PDA.
 *
 * Quem entra num PDA registado (o `deviceToken` do aparelho validado em
 * `pdas.deviceToken`) fica com uma sessão PRESA a esse PDA: um nonce novo em
 * `pdas.sessionNonce` e no cookie (JWT `pda` + `pn`, 16 h). O servidor recusa
 * o cookie quando o nonce já não é o de `pdas` (server/_core/sdk.ts). O nonce
 * limpa-se — só se ainda for o mesmo — quando:
 *   1. outra pessoa entra no PDA (nonce novo);
 *   2. logout (o deste cookie);
 *   3. a pessoa dá saída do ponto, em qualquer aparelho (as sessões das contas
 *      da ficha, incluindo as de employee_accounts);
 *   4. o fecho automático do ponto esquecido (autoCloseStaleCheckIns).
 * Os avisos no telemóvel do PDA mudam de dono em cada entrada e desligam-se
 * quando a sessão acaba. Funciona também sem ficha (contas "utilizador",
 * candidatos): a sessão é da CONTA, a ficha só serve para ligar o PDA/Zello.
 *
 * Tudo só com ENTRAR_COM_CODIGO ligado: desligado, nenhuma sessão de PDA nasce
 * e as que existem hoje (Google) continuam iguais.
 */
import crypto from "node:crypto";
import { COOKIE_NAME } from "@shared/const";
import { GOOGLE_ON_PDAS_FLAG, PDA_SESSION_MS, pdaSessionOk } from "@shared/pdaSession";
import { getSessionCookieOptions } from "./_core/cookies";
import { pdaSessionStore } from "./pdaSessionStore";

type Req = any;
type Res = any;

/** Nonce novo da sessão (32 caracteres base64url). */
export const newPdaNonce = (): string => crypto.randomBytes(24).toString("base64url");

/** Identificador curto da sessão para o ecrã (nunca o nonce). */
export const pdaSessionTag = (nonce: string): string => crypto.createHash("sha256").update(`pda-tag:${nonce}`).digest("hex").slice(0, 16);

/** Sessões de PDA ligadas? (= ENTRAR_COM_CODIGO; falha = desligado). */
export async function pdaSessionsEnabled(): Promise<boolean> {
  const { codeLoginEnabled } = await import("./loginCode");
  return codeLoginEnabled();
}

/** GOOGLE_NOS_PDAS (ligado por omissão; falha = ligado, como hoje). */
export async function googleOnPdasFlag(): Promise<boolean> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled(GOOGLE_ON_PDAS_FLAG, { defaultEnabled: automationFlagDefault(GOOGLE_ON_PDAS_FLAG) });
  } catch {
    return true;
  }
}

/** Os dados do cookie deste pedido (assinatura verificada, sem BD). */
export async function sessionClaimsOf(req: Req): Promise<import("./_core/sdk").VerifiedSession | null> {
  try {
    const { sdk } = await import("./_core/sdk");
    return await sdk.sessionOf(req);
  } catch {
    return null;
  }
}

async function log(userId: number, action: string, pdaId: number | null, details: string): Promise<void> {
  try {
    const { logActivity } = await import("./db");
    await logActivity({ userId, action, entity: "pda", entityId: pdaId, details: details.slice(0, 1000), source: "ui" } as any);
  } catch { /* o registo nunca parte nada */ }
}

/** O cookie com este PDA + nonce ainda vale? (lido fresco; falha = não vale). */
export async function pdaSessionStillValid(claims: { pdaId: number; nonce: string | null; userId: number }, now = Date.now()): Promise<boolean> {
  try {
    const row = await pdaSessionStore().read(claims.pdaId);
    return pdaSessionOk(row, { userId: claims.userId, nonce: claims.nonce }, now);
  } catch {
    return false;
  }
}

export interface PdaRef { id: number; token: string; name?: string | null }

/**
 * Abre a sessão de PDA desta conta neste PDA: nonce novo em `pdas` (a sessão
 * de quem lá estava acaba), os avisos do PDA passam para esta conta, o PDA (e
 * o Zello) ficam com a ficha (se houver) e o cookie leva o PDA + nonce (16 h).
 * `false` = o PDA já não está ativo (nada mudou).
 */
export async function openPdaSession(input: {
  req: Req; res: Res;
  account: { id: number; openId: string; sessionVersion?: number | null };
  sessionName: string;
  pda: PdaRef;
  /** Para o registo: "código", "palavra-passe", "Google", "QR". */
  how: string;
  now?: number;
}): Promise<boolean> {
  const store = pdaSessionStore();
  const now = input.now ?? Date.now();
  const nonce = newPdaNonce();
  if (!(await store.start(input.pda.id, input.account.id, nonce, now))) return false;
  await store.movePush(input.pda.id, input.account.id, nonce).catch(() => undefined);
  const name = input.pda.name ?? (await store.pdaName(input.pda.id).catch(() => null)) ?? `PDA #${input.pda.id}`;
  // O PDA e o Zello ficam com a ficha desta conta (se tiver) — como o "login→PDA" de sempre.
  // Duas entradas quase ao mesmo tempo no mesmo PDA: só quem ficou com a sessão
  // (o nonce em `pdas`) fica com o PDA e o Zello — nunca quem já foi posto fora.
  try {
    const current = await store.read(input.pda.id).catch(() => null);
    const stillMine = !!current && current.nonce === nonce && current.userId === input.account.id;
    const { getEmployeeByUserId, attachPdaByDeviceToken } = await import("./db");
    const emp = stillMine ? await getEmployeeByUserId(input.account.id) : null;
    if (emp) {
      const att = await attachPdaByDeviceToken(input.pda.token, emp.employee.id);
      if (att?.changed) {
        await log(input.account.id, "create", att.pdaId, `Auto: entrada no PDA ${att.pdaName}${att.replacedName ? ` (substituiu ${att.replacedName})` : ""}`);
        const { syncPdaZelloName } = await import("./pdaZelloName");
        void syncPdaZelloName(att.pdaId);
      }
    }
  } catch (err) {
    console.warn("[pda] sessão aberta mas o PDA não ficou ligado à ficha:", String((err as Error)?.message ?? err).slice(0, 160));
  }
  const { sdk } = await import("./_core/sdk");
  const token = await sdk.createSessionToken(input.account.openId, {
    name: input.sessionName || "Utilizador",
    expiresInMs: PDA_SESSION_MS,
    sessionVersion: input.account.sessionVersion ?? 0,
    pda: { id: input.pda.id, nonce },
  });
  try {
    input.res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(input.req), maxAge: PDA_SESSION_MS });
  } catch { /* sem resposta (testes) */ }
  await log(input.account.id, "pda_session_start", input.pda.id, `Sessão no ${name} (${input.how}); termina na saída do ponto, no logout, quando outra pessoa entrar ou ao fim de 16 h`);
  return true;
}

export type PdaSessionEndReason = "logout" | "checkout" | "stale_checkout" | "rebind";
const END_LABEL: Record<PdaSessionEndReason, string> = {
  logout: "saiu (logout)",
  checkout: "saída do ponto",
  stale_checkout: "fecho automático do ponto esquecido",
  rebind: "a sessão passou para outro PDA",
};

/** Acaba a sessão SÓ se o nonce ainda for este; desliga os avisos do PDA. */
export async function endPdaSession(pdaId: number, nonce: string, reason: PdaSessionEndReason, actorUserId = 0, now = Date.now()): Promise<boolean> {
  const store = pdaSessionStore();
  let cleared = false;
  try { cleared = await store.clearIf(pdaId, nonce); } catch { cleared = false; }
  if (!cleared) return false;
  await store.disablePush(pdaId, now).catch(() => undefined);
  await log(actorUserId, "pda_session_end", pdaId, `Sessão do PDA terminou: ${END_LABEL[reason]}`);
  return true;
}

/**
 * A pessoa deu saída do ponto (ou o ponto fechou sozinho): acabam as sessões
 * de PDA das contas da ficha (principal + employee_accounts), em qualquer PDA.
 * Cada uma só se o nonce ainda for o lido (outra pessoa pode ter entrado entretanto).
 */
export async function endPdaSessionsOfEmployee(employeeId: number, reason: "checkout" | "stale_checkout", actorUserId = 0, now = Date.now()): Promise<Array<{ pdaId: number; nonce: string }>> {
  const store = pdaSessionStore();
  const ended: Array<{ pdaId: number; nonce: string }> = [];
  try {
    const accounts = await store.accountsOfEmployee(employeeId);
    if (!accounts.length) return ended;
    for (const s of await store.openSessionsOf(accounts)) {
      if (await endPdaSession(s.pdaId, s.nonce, reason, actorUserId, now)) ended.push({ pdaId: s.pdaId, nonce: s.nonce });
    }
  } catch (err) {
    console.warn("[pda] sessões de PDA não terminadas:", String((err as Error)?.message ?? err).slice(0, 160));
  }
  return ended;
}

/** A sessão deste pedido é uma das que acabaram? (o ecrã mostra "A sessão termina em 10 s"). */
export async function requestSessionEnded(req: Req, ended: ReadonlyArray<{ pdaId: number; nonce: string }>): Promise<boolean> {
  if (!ended.length) return false;
  const c = await sessionClaimsOf(req);
  return !!c?.pda && ended.some((e) => e.pdaId === c.pda && e.nonce === c.pn);
}

export type LogoutExpect = { userId: number; tag: string | null } | null | undefined;

/**
 * Logout. Com `expect` (o que o separador pensa que tem): se o cookie atual já
 * é de outra pessoa ou de outra sessão (outro separador entrou entretanto),
 * NÃO mexe em nada ("stale"). Sessão de PDA: acaba-a (só se o nonce ainda for
 * este), desliga os avisos e solta o PDA desta pessoa.
 */
export async function pdaLogout(req: Req, currentUserId: number | null, expect: LogoutExpect): Promise<"ok" | "stale"> {
  const c = await sessionClaimsOf(req);
  if (expect && currentUserId != null) {
    if (expect.userId !== currentUserId) return "stale";
    const tag = c?.pda && c.pn ? pdaSessionTag(c.pn) : null;
    if ((expect.tag ?? null) !== tag) return "stale";
  }
  if (c?.pda && c.pn) {
    const ended = await endPdaSession(c.pda, c.pn, "logout", currentUserId ?? 0);
    if (ended && currentUserId != null) {
      try {
        const { getEmployeeByUserId } = await import("./db");
        const emp = await getEmployeeByUserId(currentUserId);
        if (emp && (await pdaSessionStore().releaseCheckin(c.pda, emp.employee.id, Date.now(), "fechado no logout"))) {
          const { syncPdaZelloName } = await import("./pdaZelloName");
          void syncPdaZelloName(c.pda);
        }
      } catch (err) {
        console.warn("[pda] logout: o PDA não foi soltado:", String((err as Error)?.message ?? err).slice(0, 160));
      }
    }
  }
  return "ok";
}

/** Para o `auth.me`: a sessão de PDA deste pedido (nome do PDA, etiqueta, fim). */
export async function pdaSessionInfo(req: Req): Promise<{ pdaId: number; name: string; tag: string; endsAt: number | null } | null> {
  const c = await sessionClaimsOf(req);
  if (!c?.pda || !c.pn) return null;
  const name = (await pdaSessionStore().pdaName(c.pda).catch(() => null)) ?? `PDA #${c.pda}`;
  return { pdaId: c.pda, name, tag: pdaSessionTag(c.pn), endsAt: c.exp != null ? c.exp * 1000 : null };
}

/**
 * Login Google num PDA (enquanto houver) e sessões de antes de ligar o
 * interruptor: no regresso, o cliente manda o `deviceToken` e a sessão passa a
 * sessão de PDA (nunca logout). Sem o interruptor, nada muda.
 */
export async function bindPdaSession(req: Req, res: Res, user: { id: number; openId: string; name?: string | null; sessionVersion?: number | null }, deviceToken: string): Promise<
  { bound: true; already?: boolean; pdaName: string } | { bound: false; reason: "off" | "unknown_device" | "error" }
> {
  if (!(await pdaSessionsEnabled())) return { bound: false, reason: "off" };
  const { loginStore } = await import("./loginStore");
  const pda = await loginStore().pdaByToken(deviceToken).catch(() => null);
  if (!pda) return { bound: false, reason: "unknown_device" };
  const c = await sessionClaimsOf(req);
  if (c?.pda === pda.id && c.pn && (await pdaSessionStillValid({ pdaId: pda.id, nonce: c.pn, userId: user.id }))) {
    return { bound: true, already: true, pdaName: pda.name };
  }
  // Estava presa a outro PDA (aparelho registado de novo): essa acaba.
  if (c?.pda && c.pn && c.pda !== pda.id) await endPdaSession(c.pda, c.pn, "rebind", user.id);
  const ok = await openPdaSession({ req, res, account: user, sessionName: user.name || "Utilizador", pda: { id: pda.id, token: deviceToken, name: pda.name }, how: "Google, convertida em sessão de PDA" });
  return ok ? { bound: true, pdaName: pda.name } : { bound: false, reason: "error" };
}

/**
 * Novo cookie para ESTE aparelho com a versão atual (mudar a palavra-passe,
 * "Terminar sessões noutros aparelhos"). Numa sessão de PDA mantém o PDA, o
 * nonce e o fim (16 h desde a entrada) — senão o PDA ficava com uma sessão de
 * 30 dias, fora das regras do PDA.
 */
export async function reissueSessionCookie(req: Req, res: Res, user: { openId: string; name: string | null }, sessionVersion: number): Promise<void> {
  const { sdk } = await import("./_core/sdk");
  const { SESSION_MAX_MS } = await import("./_core/oauth");
  const c = await sessionClaimsOf(req);
  const pda = c?.pda && c.pn ? { id: c.pda, nonce: c.pn } : null;
  const left = pda && c?.exp ? Math.max(60_000, c.exp * 1000 - Date.now()) : null;
  const expiresInMs = pda ? Math.min(PDA_SESSION_MS, left ?? PDA_SESSION_MS) : SESSION_MAX_MS;
  const token = await sdk.createSessionToken(user.openId, { name: user.name || "Utilizador", expiresInMs, sessionVersion, pda });
  res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(req), maxAge: expiresInMs });
}
