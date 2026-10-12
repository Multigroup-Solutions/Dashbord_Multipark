/**
 * Plano 56 (A1): entrar com email + código + palavra-passe — a lógica, com as
 * dependências injetáveis (os testes usam uma BD em memória). As rotas tRPC
 * estão em server/loginRouter.ts; as portas comuns (desativado, "voltei",
 * fichas, sessão) são as do Google: `completeLogin` em server/_core/oauth.ts.
 *
 *  - Pedir código: a resposta é SEMPRE a mesma, exista ou não a conta. O
 *    código (6 algarismos) vai para o TL de serviço e os supervisores da
 *    cidade (sem cidade → RH/admins) pelo sino + push; fica só em HMAC e
 *    preso ao aparelho (hash do cookie `app_login_nonce`).
 *  - Escrever o código: só no mesmo aparelho; valem os 3 últimos pedidos;
 *    10 min; 5 tentativas; uma vez só. Email desconhecido: só aqui se cria a
 *    conta (utilizador).
 *  - Palavra-passe: scrypt (node:crypto), scrypt falso quando não há conta;
 *    erradas por conta e por dia → à 5.ª fica bloqueada até ao fim do dia
 *    (só com código) e o dono é avisado. Só utilizador/extra/condutor.
 *  - A2: num PDA registado (token validado) os funcionários também recebem
 *    código — só para quem está ACIMA da pessoa (nunca um colega do mesmo
 *    nível: podia entrar como ele). Com a definição
 *    `login.codeDelivery` = "email" o código vai para o email da pessoa pela
 *    acesso@ (server/loginMail.ts); se não sair, vai ao TL/supervisor.
 */
import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { isPlausibleEmail, normalizeEmail } from "../shared/email";
import {
  CODE_EMAILED_MSG, CODE_EMAIL_FAILED_MSG, CODE_REQUESTED_MSG,
  CODE_EXPIRED_MSG, CODE_LOGIN_OFF_MSG, CODE_WRONG_MSG, EMAIL_INVALID_MSG, LOGIN_CODE, LOGIN_CODE_FLAG, LOGIN_LIMITS,
  PASSWORD_LOCKED_MSG, PASSWORD_WRONG_MSG, ROLE_GOOGLE_MSG, TOO_MANY_MSG,
  canUsePassword, cleanCode, codeFromLoginCodeTitle, codeRecipientsForRole, codeUsedNotice, deviceLabelFromUserAgent, formatCode, gmailCanonical,
  lisbonEndOfDayMs, loginCodeTitle, maskLoginEmail, methodAllowedForRole, passwordProblem, pickCodeRecipients, recipientLabel,
  usableDeviceCodes,
} from "../shared/loginCode";
import { lisbonDayOf } from "../shared/lisbonDay";
import { hhmmLisbon } from "../shared/opsPresence";
import { operationalShift } from "../shared/shiftHandover";
import type { NotifyCity } from "../shared/notificationRouting";
import { findLoginAccountByEmail } from "./loginAccount";
import type { LoginStore, LoginUserRow, StoredLoginCode } from "./loginStore";

export interface LoginNotify {
  kind: "login_code" | "login_security" | "login_conflict";
  city?: string | null;
  targetUserIds?: number[];
  title: string;
  body?: string | null;
  link?: string | null;
  entity?: { type: string; id: string | number } | null;
}

export interface LoginPush { type: string; title: string; body: string; url: string; tag: string }

export interface LoginDeps {
  store: LoginStore;
  now(): number;
  flagOn(): Promise<boolean>;
  /** Conta este pedido; `false` = passou o limite. */
  allow(key: string, rule: { perMinute?: number; perHour?: number; perDay?: number }): Promise<boolean>;
  randomCode(): string;
  /** Segredo do HMAC (JWT_SECRET). */
  secret: string;
  /** "duty" (TL/supervisor de serviço) ou "email" (A2: o email da pessoa, pela acesso@; falha → duty). */
  deliveryMode(): Promise<"duty" | "email">;
  /** A2: envia o código para o email da pessoa pela acesso@ (server/loginMail.ts). */
  sendCodeEmail(input: { to: string; code: string }): Promise<{ ok: boolean; error?: string }>;
  notify(input: LoginNotify): Promise<{ recipients: number[] }>;
  push(userIds: number[], payload: LoginPush): Promise<void>;
  /** RESTRICT_LOGIN_TO_REGISTERED: email desconhecido sem ficha não cria conta. */
  restrictedToRegistered: boolean;
}

// ─── Segredos ───────────────────────────────────────────────────────────────

export const hashNonce = (nonce: string): string => crypto.createHash("sha256").update(`login-nonce:${nonce}`).digest("hex");
/** Hash curto (IP, email) para os contadores e o registo — nunca em claro. */
export const hashIp = (ip: string | null | undefined): string => crypto.createHash("sha256").update(String(ip ?? "").trim().toLowerCase()).digest("hex").slice(0, 24);

/** HMAC do código, preso ao email e ao aparelho: o código nunca se guarda. */
export function hashLoginCode(secret: string, emailNorm: string, nonceHash: string, code: string): string {
  return crypto.createHmac("sha256", secret).update(`login-code:${emailNorm}:${nonceHash}:${code}`).digest("hex");
}

/** Novo cookie de aparelho (32 bytes aleatórios). */
export const newDeviceNonce = (): string => crypto.randomBytes(32).toString("base64url");
export const isDeviceNonce = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(v);

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ─── Palavra-passe (scrypt do node:crypto) ──────────────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
const scryptAsync = (pw: string, salt: Buffer, keylen: number, o: { N: number; r: number; p: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => crypto.scrypt(pw, salt, keylen, { ...o, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored ?? ""));
  if (!m) { await fakePasswordCheck(password); return false; }
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (N > 1 << 20 || r > 32 || p > 16) return false;
  const expected = Buffer.from(m[5], "base64");
  const key = await scryptAsync(String(password ?? "").normalize("NFKC"), Buffer.from(m[4], "base64"), expected.length, { N, r, p });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** O mesmo tempo de uma verificação verdadeira (quando não há conta/palavra-passe). */
export async function fakePasswordCheck(password: string): Promise<void> {
  await scryptAsync(String(password ?? "").normalize("NFKC"), crypto.randomBytes(16), SCRYPT.keylen, SCRYPT);
}

// ─── Pedir código ───────────────────────────────────────────────────────────

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

async function requireOn(deps: LoginDeps): Promise<void> {
  if (!(await deps.flagOn())) throw new TRPCError({ code: "PRECONDITION_FAILED", message: CODE_LOGIN_OFF_MSG });
}

export interface CodeRequestInput {
  email: string;
  nonceHash: string;
  ip: string | null;
  userAgent: string | null;
  pdaToken?: string | null;
}

/**
 * O ecrã recebe só `message` — a mesma exista ou não a conta: em "duty" sempre
 * CODE_REQUESTED_MSG; em "email" CODE_EMAILED_MSG, ou CODE_EMAIL_FAILED_MSG se
 * o email não saiu (e o código foi para o TL/supervisor). O resto é para os
 * testes e o registo.
 */
export interface CodeRequestOutcome {
  delivered: boolean;
  reason: "sent" | "resend_wait" | "refused" | "staff" | "unknown_cap" | "nobody";
  message: string;
  via?: "duty" | "email";
  codeId?: number;
  recipients?: number[];
}

export async function requestLoginCode(deps: LoginDeps, input: CodeRequestInput): Promise<CodeRequestOutcome> {
  await requireOn(deps);
  const mode = await deps.deliveryMode().catch(() => "duty" as const);
  const msg = mode === "email" ? CODE_EMAILED_MSG : CODE_REQUESTED_MSG;
  const out = (o: Omit<CodeRequestOutcome, "message">, message = msg): CodeRequestOutcome => ({ ...o, message });
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email)) throw bad(EMAIL_INVALID_MSG);
  if (!deps.secret) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "A entrada com código não está configurada no servidor." });
  // Nos contadores o email vai em hash (nada de emails em claro na tabela dos limites).
  const key = hashIp(gmailCanonical(email));
  const ipKey = hashIp(input.ip);
  // Os limites contam igual haja ou não conta (não revelam nada).
  const allowed = (await deps.allow(`login_code:net:${ipKey}`, { perHour: LOGIN_LIMITS.networkPerHour }))
    && (await deps.allow(`login_code:email:${key}`, { perHour: LOGIN_LIMITS.emailPerHour }))
    && (await deps.allow(`login_code:dev:${key}:${input.nonceHash.slice(0, 24)}`, { perHour: LOGIN_LIMITS.emailDevicePerHour }));
  if (!allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: TOO_MANY_MSG });

  const store = deps.store;
  const now = deps.now();
  const masked = maskLoginEmail(email);
  const [last] = await store.deviceCodes(email, input.nonceHash, 1);
  if (last && now - last.createdAt < LOGIN_CODE.resendSeconds * 1000) return out({ delivered: false, reason: "resend_wait" });

  const lookup = await findLoginAccountByEmail(store, email);
  if (lookup.kind === "refused") {
    await store.log({ userId: 0, action: "login_code_request", entityId: null, details: `Código de entrada pedido para <${masked}> — não enviado (${lookup.reason === "shared_mailbox" ? "caixa partilhada da Comunicação" : lookup.reason === "staff_ficha" ? "ficha de funcionário: entra com Google" : `várias contas com este email: ${lookup.detail ?? ""}`})` });
    if (lookup.reason === "ambiguous") {
      await deps.notify({ kind: "login_conflict", title: `Pedido de código para um email com várias contas (${masked})`, body: `Não se enviou o código: o email ${email} está em várias contas (${lookup.detail ?? ""}). Junta-as em Utilizadores → Ligações.`, link: "/utilizadores", entity: { type: "login_email", id: key } }).catch(() => undefined);
    }
    return out({ delivered: false, reason: "refused" });
  }
  const user = lookup.kind === "account" ? lookup.user : null;
  // A2: o PDA registado (o `deviceToken` validado aqui) — os funcionários só
  // entram com código num PDA registado; fora disso entram com Google.
  const pda = input.pdaToken ? await store.pdaByToken(input.pdaToken).catch(() => null) : null;
  if (user && !methodAllowedForRole("code", user.role, { registeredPda: !!pda })) {
    await store.log({ userId: 0, action: "login_code_request", entityId: user.id, details: `Código de entrada pedido para <${masked}> — não enviado (o papel ${user.role} entra com Google${pda ? "" : "; com código só num PDA registado"})` });
    return out({ delivered: false, reason: "staff" });
  }
  const ficha = lookup.ficha;
  if (!user && !ficha && !(await deps.allow("login_code:unknown", { perDay: LOGIN_LIMITS.unknownPerDay }))) {
    await store.log({ userId: 0, action: "login_code_request", entityId: null, details: `Código de entrada pedido para <${masked}> (email novo) — não enviado: limite diário de emails novos` });
    return out({ delivered: false, reason: "unknown_cap" });
  }

  let city: NotifyCity | null = ficha ? await store.cityOfFicha(ficha.id).catch(() => null) : null;
  if (!city && pda) city = pda.city;
  const device = pda ? pda.name : deviceLabelFromUserAgent(input.userAgent);
  const code = deps.randomCode();
  const ipHash = crypto.createHmac("sha256", deps.secret).update(`login-ip:${String(input.ip ?? "")}`).digest("hex").slice(0, 32);
  const accountLabel = user ? `conta #${user.id}` : ficha ? `ficha #${ficha.id}, sem conta` : "email novo";

  // A2, modo "email": o código vai para o email escrito, pela acesso@. Se não
  // sair, cai no TL/supervisor de serviço ("pede o código ao TL").
  let emailFailed = false;
  if (mode === "email") {
    const sentMail = await deps.sendCodeEmail({ to: email, code }).catch((err) => ({ ok: false, error: String((err as Error)?.message ?? err) }));
    if (sentMail.ok) {
      const codeId = await store.insertCode({
        emailNorm: email, userId: user?.id ?? null, employeeId: ficha?.id ?? null,
        codeHash: hashLoginCode(deps.secret, email, input.nonceHash, code), deviceNonceHash: input.nonceHash,
        deviceLabel: device, pdaId: pda?.id ?? null, cityKey: city, deliveryMode: "email",
        expiresAt: now + LOGIN_CODE.minutes * 60_000, ipHash, createdAt: now,
      });
      await store.log({ userId: 0, action: "login_code_request", entityId: user?.id ?? null, details: `Código de entrada pedido para <${masked}> (${accountLabel}) em ${device}${city ? ` · ${city}` : ""} — enviado para o email (pela acesso@) · pedido #${codeId}` });
      return out({ delivered: true, reason: "sent", via: "email", codeId, recipients: [] });
    }
    emailFailed = true;
    await store.log({ userId: 0, action: "login_code_request", entityId: user?.id ?? null, details: `Código de entrada para <${masked}>: o email não saiu (${String(sentMail.error ?? "erro").slice(0, 200)}) — vai para o TL/supervisor de serviço` });
  }
  const dutyMsg = emailFailed ? CODE_EMAIL_FAILED_MSG : msg;

  const pools = await store.dutyPools(city, operationalShift(now), now);
  let { userIds, via } = pickCodeRecipients(city, pools, user ? [user.id] : []);
  // A2: o código de um funcionário (num PDA) só a quem está acima dele (nunca um colega do mesmo nível).
  if (user && !canUsePassword(user.role)) {
    const roles = new Map(Array.from(await store.peopleOf([...userIds, ...pools.rhAdmins])).map(([id, p]) => [id, p.role]));
    const same = codeRecipientsForRole(user.role, userIds, roles);
    if (same.length) userIds = same;
    else { userIds = codeRecipientsForRole(user.role, pools.rhAdmins.filter((id) => id !== user.id), roles); via = "rh"; }
  }
  if (!userIds.length) {
    await store.log({ userId: 0, action: "login_code_request", entityId: user?.id ?? null, details: `Código de entrada pedido para <${masked}> — não enviado: ninguém de serviço para o receber` });
    return out({ delivered: false, reason: "nobody" }, dutyMsg);
  }

  const codeId = await store.insertCode({
    emailNorm: email, userId: user?.id ?? null, employeeId: ficha?.id ?? null,
    codeHash: hashLoginCode(deps.secret, email, input.nonceHash, code), deviceNonceHash: input.nonceHash,
    deviceLabel: device, pdaId: pda?.id ?? null, cityKey: city, deliveryMode: "duty",
    // A rede fica no pedido só em HMAC (com o segredo: não se descobre o IP a partir dele).
    expiresAt: now + LOGIN_CODE.minutes * 60_000, ipHash, createdAt: now,
  });
  const who = ficha?.fullName || user?.name || email;
  const sent = await deps.notify({
    kind: "login_code", city, targetUserIds: userIds,
    title: loginCodeTitle({ who, device, code }),
    body: `Dá o código só à própria pessoa, quando ta pedir (confirma quem é). Vale ${LOGIN_CODE.minutes} minutos e só funciona no aparelho onde foi pedido.`,
    link: "/operacional?tab=live",
    entity: { type: "login_code", id: codeId },
  }).catch(() => ({ recipients: [] as number[] }));
  await store.setCodeDelivery(codeId, sent.recipients);
  if (sent.recipients.length) {
    await deps.push(sent.recipients, { type: "login_code", title: "Código de entrada", body: `${who} (${device}): ${formatCode(code)}`, url: "/operacional?tab=live", tag: `login-code-${codeId}` }).catch(() => undefined);
  }
  const people = await store.peopleOf(sent.recipients);
  const to = sent.recipients.map((id) => recipientLabel(people.get(id)?.role, people.get(id)?.name)).join(", ") || "ninguém (sem notificações)";
  await store.log({
    userId: 0, action: "login_code_request", entityId: user?.id ?? null,
    details: `Código de entrada pedido para <${masked}> (${accountLabel}) em ${device}${city ? ` · ${city}` : ""} — enviado a ${to}${via === "rh" ? " (RH/admins)" : ""}${emailFailed ? " · o email não saiu" : ""} · pedido #${codeId}`,
  });
  return out({ delivered: true, reason: "sent", via: "duty", codeId, recipients: sent.recipients }, dutyMsg);
}

// ─── Escrever o código ──────────────────────────────────────────────────────

/**
 * Confere o código neste aparelho e gasta-o (uma vez só, antes de criar a
 * conta: dois pedidos ao mesmo tempo não criam duas). Errado → conta a tentativa.
 */
export async function verifyLoginCode(deps: LoginDeps, input: { email: string; nonceHash: string | null; code: string; ip: string | null }): Promise<StoredLoginCode> {
  await requireOn(deps);
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email) || !input.nonceHash) throw bad(CODE_EXPIRED_MSG);
  if (!(await deps.allow(`login_verify:net:${hashIp(input.ip)}`, { perHour: LOGIN_LIMITS.verifyNetworkPerHour }))) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: TOO_MANY_MSG });
  }
  const now = deps.now();
  const usable = usableDeviceCodes(await deps.store.deviceCodes(email, input.nonceHash, LOGIN_CODE.perDevice), now);
  if (!usable.length) throw bad(CODE_EXPIRED_MSG);
  const clean = cleanCode(input.code);
  const match = clean.length === LOGIN_CODE.length
    ? usable.find((r) => safeEqualHex(r.codeHash, hashLoginCode(deps.secret, email, input.nonceHash!, clean)))
    : undefined;
  if (!match) {
    await deps.store.bumpCodeAttempts(usable.map((r) => r.id));
    throw bad(usable.some((r) => r.attempts + 1 < LOGIN_CODE.maxAttempts) ? CODE_WRONG_MSG : CODE_EXPIRED_MSG);
  }
  if (!(await deps.store.useCode(match.id, match.userId, now))) throw bad(CODE_EXPIRED_MSG);
  return match;
}

export type CodeLoginAccount =
  | { ok: true; user: LoginUserRow; created: boolean; email: string }
  | { ok: false; reason: "refused" | "restricted" };

/**
 * A conta de quem acertou no código: a que existe (mesma procura do Google),
 * ou uma conta nova "utilizador" — só agora, depois do código certo.
 */
export async function accountForCodeLogin(deps: LoginDeps, rawEmail: string): Promise<CodeLoginAccount> {
  const email = normalizeEmail(rawEmail);
  const lookup = await findLoginAccountByEmail(deps.store, email);
  if (lookup.kind === "account") return { ok: true, user: lookup.user, created: false, email };
  if (lookup.kind === "refused") return { ok: false, reason: "refused" };
  // Modo fechado: só entra quem o backoffice registou (ficha com este email conta).
  if (deps.restrictedToRegistered && !lookup.ficha) return { ok: false, reason: "restricted" };
  const id = await deps.store.createEmailAccount({ email, name: lookup.ficha?.fullName ?? null, now: deps.now() });
  const user = await deps.store.userById(id);
  if (!user) return { ok: false, reason: "refused" };
  await deps.store.log({ userId: 0, action: "user_autocreate", entityId: id, details: `Conta criada ao entrar com um código <${maskLoginEmail(email)}>${lookup.ficha ? ` (ficha #${lookup.ficha.id} ${lookup.ficha.fullName})` : " (email novo: aparece \"Liga a tua conta\")"}` });
  return { ok: true, user, created: true, email };
}

/** Aviso à pessoa: "Entraste com um código enviado a TL X / supervisor Y às HH:MM." */
export async function noticeCodeUsed(deps: LoginDeps, userId: number, code: StoredLoginCode): Promise<void> {
  const people = await deps.store.peopleOf(code.deliveredTo);
  const labels = code.deliveredTo.map((id) => recipientLabel(people.get(id)?.role, people.get(id)?.name));
  const text = codeUsedNotice(labels, hhmmLisbon(deps.now()), code.deliveryMode === "email" ? "email" : "duty");
  await deps.notify({ kind: "login_security", targetUserIds: [userId], title: text, body: "Se não foste tu, avisa já o RH.", link: "/perfil", entity: { type: "login_code_used", id: code.id } }).catch(() => undefined);
}

// ─── Palavra-passe ──────────────────────────────────────────────────────────

/** Entrar com email + palavra-passe. Devolve a conta (as portas comuns vêm a seguir). */
export async function passwordLogin(deps: LoginDeps, input: { email: string; password: string; ip: string | null; device: string | null }): Promise<LoginUserRow> {
  await requireOn(deps);
  const email = normalizeEmail(input.email);
  const password = String(input.password ?? "");
  const allowed = (await deps.allow(`login_pw:net:${hashIp(input.ip)}`, { perHour: LOGIN_LIMITS.verifyNetworkPerHour }))
    && (!isPlausibleEmail(email) || (await deps.allow(`login_pw:email:${hashIp(gmailCanonical(email))}`, { perHour: LOGIN_LIMITS.passwordEmailPerHour })));
  if (!allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: TOO_MANY_MSG });
  const lookup = isPlausibleEmail(email) ? await findLoginAccountByEmail(deps.store, email) : null;
  const user = lookup?.kind === "account" ? lookup.user : null;
  const state = user ? await deps.store.passwordState(user.id) : null;
  if (!user || !state?.hash) {
    await fakePasswordCheck(password);
    throw bad(PASSWORD_WRONG_MSG);
  }
  const now = deps.now();
  const today = lisbonDayOf(now);
  const locked = state.lockedUntil != null && state.lockedUntil > now;
  const right = await verifyPassword(password, state.hash);
  if (!right) {
    const count = (state.failedDay === today ? state.failedCount : 0) + 1;
    const lockNow = !locked && count >= LOGIN_CODE.passwordMaxFailsPerDay;
    await deps.store.recordPasswordFailure(user.id, today, count, lockNow ? lisbonEndOfDayMs(now) : locked ? state.lockedUntil : null);
    if (lockNow) {
      const on = input.device ? ` (${input.device})` : "";
      await deps.notify({
        kind: "login_security", targetUserIds: [user.id],
        title: `Tentaram entrar na tua conta${on} às ${hhmmLisbon(now)}`,
        body: `A palavra-passe foi errada ${count} vezes hoje. Até ao fim do dia só entras com um código. Se não foste tu, avisa o RH.`,
        link: "/perfil", entity: { type: "login_pw_lock", id: `${user.id}:${today}` },
      }).catch(() => undefined);
      await deps.store.log({ userId: 0, action: "login_password_locked", entityId: user.id, details: `Palavra-passe errada ${count} vezes hoje${on}: bloqueada até ao fim do dia (só entra com código)` });
    } else {
      await deps.store.log({ userId: 0, action: "login_denied", entityId: user.id, details: `Palavra-passe errada${input.device ? ` em ${input.device}` : ""} (${count}.ª hoje)` });
    }
    throw bad(PASSWORD_WRONG_MSG);
  }
  if (locked) throw bad(PASSWORD_LOCKED_MSG);
  if (!canUsePassword(user.role)) throw new TRPCError({ code: "FORBIDDEN", message: ROLE_GOOGLE_MSG });
  if (state.failedCount) await deps.store.clearPasswordFailures(user.id);
  return user;
}

/**
 * Criar/mudar a palavra-passe. Sem `current`: só a primeira vez, ou nos 15
 * minutos depois de entrar com um código (esqueceu-se). Com `current`: muda.
 * `endOthers` = as sessões noutros aparelhos devem terminar.
 */
export async function setPassword(deps: LoginDeps, user: { id: number; role: string; name: string | null; email: string | null }, input: { password: string; current?: string | null }): Promise<{ mode: "first" | "after_code" | "change"; endOthers: boolean }> {
  await requireOn(deps);
  if (!canUsePassword(user.role)) throw new TRPCError({ code: "FORBIDDEN", message: ROLE_GOOGLE_MSG });
  const problem = passwordProblem(input.password, { name: user.name, email: user.email });
  if (problem) throw bad(problem);
  const state = await deps.store.passwordState(user.id);
  const now = deps.now();
  let mode: "first" | "after_code" | "change";
  if (input.current) {
    if (!state?.hash || !(await verifyPassword(input.current, state.hash))) throw bad("A palavra-passe atual está errada.");
    if (input.current === input.password) throw bad("A palavra-passe nova tem de ser diferente da atual.");
    mode = "change";
  } else if (!state?.hash) {
    mode = "first";
  } else if (await deps.store.codeLoginSince(user.id, now - LOGIN_CODE.setWithoutCurrentMinutes * 60_000)) {
    mode = "after_code";
  } else {
    throw bad("Escreve a palavra-passe atual. Se te esqueceste, sai e entra com um código.");
  }
  await deps.store.savePassword(user.id, await hashPassword(input.password), now);
  await deps.store.log({ userId: user.id, action: mode === "first" ? "password_set" : "password_change", entityId: user.id,
    details: mode === "first" ? "Criou a palavra-passe" : mode === "after_code" ? "Criou uma palavra-passe nova depois de entrar com um código (sessões noutros aparelhos terminadas)" : "Mudou a palavra-passe (sessões noutros aparelhos terminadas)" });
  return { mode, endOthers: mode !== "first" };
}

/** Estado para o cartão do Perfil. */
export async function passwordStatus(deps: LoginDeps, user: { id: number; role: string }): Promise<{ enabled: boolean; allowed: boolean; hasPassword: boolean; setAt: number | null; lockedUntil: number | null; canSetWithoutCurrent: boolean }> {
  const enabled = await deps.flagOn();
  const allowed = canUsePassword(user.role);
  if (!enabled || !allowed) return { enabled, allowed, hasPassword: false, setAt: null, lockedUntil: null, canSetWithoutCurrent: false };
  const now = deps.now();
  const state = await deps.store.passwordState(user.id);
  const hasPassword = !!state?.hash;
  const lockedUntil = state?.lockedUntil != null && state.lockedUntil > now ? state.lockedUntil : null;
  const canSetWithoutCurrent = !hasPassword || !!(await deps.store.codeLoginSince(user.id, now - LOGIN_CODE.setWithoutCurrentMinutes * 60_000));
  return { enabled, allowed, hasPassword, setAt: state?.setAt ?? null, lockedUntil, canSetWithoutCurrent };
}

/** Repor acesso (RH/admin): tira a palavra-passe e o bloqueio; a pessoa é avisada. As sessões terminam em quem chama. */
export async function resetAccess(deps: LoginDeps, actor: { id: number; name: string | null }, target: { id: number; name: string | null; email: string | null }): Promise<void> {
  await deps.store.clearPassword(target.id);
  await deps.notify({
    kind: "login_security", targetUserIds: [target.id],
    title: "O teu acesso foi reposto",
    body: "A palavra-passe foi apagada e as sessões terminaram. Para entrares, escreve o teu email, carrega em \"Pedir código\" e pede o código ao TL. Depois cria uma palavra-passe nova.",
    link: "/perfil", entity: { type: "login_reset", id: `${target.id}:${deps.now()}` },
  }).catch(() => undefined);
  await deps.store.log({ userId: actor.id, action: "access_reset", entityId: target.id, details: `Repôs o acesso de ${target.name ?? `#${target.id}`} <${maskLoginEmail(target.email)}>: palavra-passe tirada, sessões terminadas, pessoa avisada` });
}

// ─── Cartão "Códigos de entrada" ────────────────────────────────────────────

export interface CodeCardRow {
  id: number;
  name: string;
  /** Email escrito (só quando não há ficha). */
  email: string | null;
  photoUrl: string | null;
  device: string | null;
  /** O código (só enquanto está por usar). */
  code: string | null;
  status: "pending" | "used" | "expired";
  createdAt: number;
  expiresAt: number;
}

/** Pedidos dos últimos 15 minutos cujo código foi para esta pessoa. */
export async function codesForMe(deps: LoginDeps, userId: number): Promise<CodeCardRow[]> {
  if (!(await deps.flagOn())) return [];
  const now = deps.now();
  const rows = await deps.store.codesDeliveredTo(userId, now - 15 * 60_000);
  // Dos pedidos do mesmo aparelho só valem os 3 mais recentes.
  const rank = new Map<string, number>();
  const sorted = [...rows].sort((a, b) => b.id - a.id);
  const out: CodeCardRow[] = [];
  for (const r of sorted) {
    const k = `${r.emailNorm}|${r.deviceNonceHash}`;
    const n = (rank.get(k) ?? 0) + 1;
    rank.set(k, n);
    const pending = r.usedAt == null && r.expiresAt > now && r.attempts < LOGIN_CODE.maxAttempts && n <= LOGIN_CODE.perDevice;
    out.push({
      id: r.id, name: r.fullName || r.emailNorm, email: r.fullName ? null : r.emailNorm, photoUrl: r.photoUrl, device: r.deviceLabel,
      code: pending ? codeFromLoginCodeTitle(r.title) : null,
      status: pending ? "pending" : r.usedAt != null ? "used" : "expired",
      createdAt: r.createdAt, expiresAt: r.expiresAt,
    });
  }
  return out;
}

// ─── Dependências reais ─────────────────────────────────────────────────────

/** ENTRAR_COM_CODIGO ligado? (lido fresco; falha = desligado). */
export async function codeLoginEnabled(): Promise<boolean> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled(LOGIN_CODE_FLAG, { defaultEnabled: automationFlagDefault(LOGIN_CODE_FLAG) });
  } catch {
    return false;
  }
}

export async function realLoginDeps(): Promise<LoginDeps> {
  const { loginStore } = await import("./loginStore");
  return {
    store: loginStore(),
    now: () => Date.now(),
    flagOn: codeLoginEnabled,
    async allow(key, rule) {
      const { checkRateLimit } = await import("./_core/ai/rateLimit");
      return (await checkRateLimit(key, rule)).allowed;
    },
    randomCode: () => String(crypto.randomInt(0, 10 ** LOGIN_CODE.length)).padStart(LOGIN_CODE.length, "0"),
    secret: process.env.JWT_SECRET || "",
    async deliveryMode() {
      const { getSetting } = await import("./appSettings");
      return (await getSetting("login.codeDelivery")) === "email" ? "email" : "duty";
    },
    async sendCodeEmail(input) {
      const { sendLoginCodeEmail } = await import("./loginMail");
      return sendLoginCodeEmail(input);
    },
    async notify(input) {
      const { notify } = await import("./notify");
      return notify(input);
    },
    async push(userIds, payload) {
      const { pushToUsers } = await import("./webPush");
      await pushToUsers(userIds, payload, { ttlSec: LOGIN_CODE.minutes * 60 });
    },
    restrictedToRegistered: /^(1|true|yes|on)$/i.test(process.env.RESTRICT_LOGIN_TO_REGISTERED ?? ""),
  };
}
