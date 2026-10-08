/**
 * 49c (Jorge, 8 out 2026) — entrada de candidatos e de quem volta:
 *
 *  1. "Sou novo — quero candidatar-me" (`startCandidate`): cria a ficha de
 *     CANDIDATO (extra, inativa, motivo "candidato") ligada à conta Google e,
 *     se não houver, a candidatura (aparece no Recrutamento, com o lead e a
 *     tarefa de sempre). Se já houver ficha/candidatura com esse email, liga a
 *     essa — nunca duplica.
 *  2. "Já me candidatei / já trabalhei convosco com outro email"
 *     (`createLinkRequest` + `confirmLinkCode`): a pessoa escreve o email OU o
 *     telefone. Resposta igual haja ou não correspondência; 5 pedidos/dia;
 *     com o interruptor ACCOUNT_LINK_EMAIL_CODE, código de 6 algarismos (10
 *     min, 5 tentativas, só em hash) para o email encontrado; sem ele, o
 *     pedido vai para o RH (sino + Leads de Extras + ficha).
 *  3. "Voltei, quero trabalhar" (`requestComeback`): quem está inativo avisa
 *     o RH (sino), sem WhatsApp nem email.
 *  4. Possíveis duplicados: o candidato grava telefone/NIF que já está noutra
 *     ficha/candidatura → pedido para o RH decidir (nunca bloqueia).
 *
 * Nunca liga só por nome. Nada se apaga (os pedidos ficam com o estado).
 */
import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import {
  ACCOUNT_LINK_FLAG, ACCOUNT_LINK_LIMITS, LINK_CODE_EXHAUSTED, LINK_CODE_WRONG, LINK_LIMIT_MESSAGE,
  codeUsable, linkRequestReply, linkRequestSummary, parseLinkClaim, pickAutoTarget, selfLinkableEmployee,
  type LinkClaim, type LinkMatch, type LinkTarget,
} from "../shared/accountLink";
import { canSayComeback, isCandidateFicha, isComebackPosition, isComebackRole, roleAfterActivation } from "../shared/comeback";
import { CANDIDATE_REASON, deactivationBlocksLogin, deactivationReasonLabel } from "../shared/deactivationReasons";
import { isPlausibleEmail, normalizeEmail } from "../shared/email";
import { normalizePhoneE164, normalizePhoneForStorage } from "../shared/phone";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];
const nowSql = (d = new Date()) => d.toISOString().slice(0, 19).replace("T", " ");
const on = (v: unknown) => v === true || Number(v) === 1;

type Db = { execute: (q: any) => Promise<any> };
async function database(): Promise<Db> {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  return d as unknown as Db;
}

export interface LinkUser { id: number; email: string | null; name?: string | null }

export interface LinkRequestRow {
  id: number;
  kind: string;
  userId: number;
  googleEmail: string | null;
  claimedEmail: string | null;
  claimedPhone: string | null;
  employeeId: number | null;
  matchedEmployeeId: number | null;
  matchedApplicationId: number | null;
  status: string;
  codeHash: string | null;
  codeExpiresAt: string | null;
  attempts: number;
  note?: string | null;
  createdAt?: string | null;
}

// ─── Pedido "já me candidatei com outro email" (dependências injetáveis) ────

export interface LinkDeps {
  now(): Date;
  flagOn(): Promise<boolean>;
  /** Pedidos ("link") desta conta nas últimas 24 h. */
  countRecent(userId: number): Promise<number>;
  /** Os pedidos pendentes anteriores desta conta passam a "expired". */
  expirePending(userId: number): Promise<void>;
  insert(row: Omit<LinkRequestRow, "id">): Promise<number>;
  update(id: number, patch: Partial<LinkRequestRow> & { resolvedAt?: string | null; resolvedById?: number | null }): Promise<void>;
  get(id: number): Promise<LinkRequestRow | null>;
  findMatches(claim: LinkClaim): Promise<LinkMatch[]>;
  sendCode(to: string, code: string): Promise<boolean>;
  notifyRh(req: { id: number; summary: string; employeeId: number | null; applicationId: number | null }): Promise<void>;
  /** Liga a conta ao alvo confirmado (ficha, ou candidatura → ficha de candidato). Devolve a ficha. */
  linkTarget(target: LinkTarget, user: LinkUser): Promise<number>;
  log(userId: number, action: string, entityId: number | null, details: string): Promise<void>;
  randomCode(): string;
  hash(requestId: number, code: string): string;
}

export interface LinkRequestReply { requestId: number; codeExpected: boolean; message: string }

/**
 * Cria o pedido. A RESPOSTA é sempre a mesma forma e o mesmo texto, haja ou
 * não correspondência (só depende do interruptor) — não se revela quem existe.
 */
export async function createLinkRequest(deps: LinkDeps, user: LinkUser, claimText: string): Promise<LinkRequestReply> {
  const claim = parseLinkClaim(claimText);
  if (!claim) throw new TRPCError({ code: "BAD_REQUEST", message: "Escreve o email ou o telefone com que te candidataste (ou com que trabalhaste connosco)." });
  if ((await deps.countRecent(user.id)) >= ACCOUNT_LINK_LIMITS.perDay) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: LINK_LIMIT_MESSAGE });
  const flag = await deps.flagOn();
  await deps.expirePending(user.id);
  const matches = await deps.findMatches(claim);
  const emp = matches.find((m) => m.kind === "employee");
  const app = matches.find((m) => m.kind === "application");
  const target = pickAutoTarget(matches);
  const googleEmail = normalizeEmail(user.email) || null;
  const id = await deps.insert({
    kind: "link", userId: user.id, googleEmail,
    claimedEmail: claim.kind === "email" ? claim.email : null,
    claimedPhone: claim.kind === "phone" ? claim.phone : null,
    employeeId: null,
    matchedEmployeeId: target?.kind === "employee" ? target.employeeId : emp?.id ?? null,
    matchedApplicationId: target?.kind === "application" ? target.applicationId : app?.id ?? null,
    status: "pending", codeHash: null, codeExpiresAt: null, attempts: 0, note: null,
  });
  let codeSent = false;
  if (flag && target) {
    const code = deps.randomCode();
    const expires = new Date(deps.now().getTime() + ACCOUNT_LINK_LIMITS.codeMinutes * 60_000);
    await deps.update(id, { codeHash: deps.hash(id, code), codeExpiresAt: nowSql(expires) });
    // Pelo email escrito (é um dos emails do registo encontrado); pelo telefone, o email do registo.
    codeSent = await deps.sendCode(claim.kind === "email" ? claim.email : target.sendTo, code).catch(() => false);
    if (!codeSent) await deps.update(id, { codeHash: null, codeExpiresAt: null, note: "o email com o código não saiu" });
  }
  const summary = linkRequestSummary({ googleEmail, claimedEmail: claim.kind === "email" ? claim.email : null, claimedPhone: claim.kind === "phone" ? claim.phone : null });
  if (!codeSent) {
    await deps.notifyRh({ id, summary, employeeId: target?.kind === "employee" ? target.employeeId : emp?.id ?? null, applicationId: target?.kind === "application" ? target.applicationId : app?.id ?? null });
  }
  await deps.log(user.id, "account_link_request", id, `${summary} — ${codeSent ? "código enviado por email" : matches.length ? "para o RH decidir" : "sem correspondência (para o RH)"}`);
  return { requestId: id, codeExpected: flag, message: linkRequestReply(flag) };
}

/** A pessoa escreve o código. Certo → liga; errado → conta a tentativa (as 5 esgotadas → RH). */
export async function confirmLinkCode(deps: LinkDeps, user: LinkUser, requestId: number, code: string): Promise<{ employeeId: number }> {
  const req = await deps.get(requestId);
  if (!req || req.userId !== user.id || req.kind !== "link") throw new TRPCError({ code: "BAD_REQUEST", message: LINK_CODE_WRONG });
  const clean = String(code ?? "").replace(/\D/g, "");
  const usable = codeUsable({ codeHash: req.codeHash, codeExpiresAt: req.codeExpiresAt, attempts: req.attempts, status: req.status }, deps.now());
  const right = usable && clean.length === ACCOUNT_LINK_LIMITS.codeLength && safeEqual(deps.hash(req.id, clean), String(req.codeHash));
  if (!right) {
    if (req.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: LINK_CODE_WRONG });
    // Conta sempre a tentativa (com ou sem código enviado) — o comportamento é igual.
    const attempts = req.attempts + 1;
    const exhausted = attempts >= ACCOUNT_LINK_LIMITS.maxAttempts;
    await deps.update(req.id, { attempts, ...(exhausted && req.codeHash ? { codeHash: null, codeExpiresAt: null, note: "tentativas do código esgotadas" } : {}) });
    if (exhausted && req.codeHash) {
      await deps.notifyRh({ id: req.id, summary: linkRequestSummary(req), employeeId: req.matchedEmployeeId, applicationId: req.matchedApplicationId });
      throw new TRPCError({ code: "BAD_REQUEST", message: LINK_CODE_EXHAUSTED });
    }
    throw new TRPCError({ code: "BAD_REQUEST", message: LINK_CODE_WRONG });
  }
  const target: LinkTarget = req.matchedEmployeeId != null
    ? { kind: "employee", employeeId: req.matchedEmployeeId, sendTo: "" }
    : { kind: "application", applicationId: Number(req.matchedApplicationId), sendTo: "" };
  let employeeId: number;
  try {
    employeeId = await deps.linkTarget(target, user);
  } catch (err) {
    if (!(err instanceof TRPCError) || !["FORBIDDEN", "BAD_REQUEST"].includes(err.code)) throw err;
    // O código estava certo, mas esta ficha só o RH a liga → vai para o RH.
    await deps.update(req.id, { codeHash: null, codeExpiresAt: null, note: `código certo, mas: ${err.message}`.slice(0, 255) });
    await deps.notifyRh({ id: req.id, summary: linkRequestSummary(req), employeeId: req.matchedEmployeeId, applicationId: req.matchedApplicationId });
    throw new TRPCError({ code: "BAD_REQUEST", message: "Confirmámos o teu email, mas esta ligação tem de ser o RH a fazer. Já lhe enviámos o pedido." });
  }
  await deps.update(req.id, { status: "confirmed", codeHash: null, codeExpiresAt: null, matchedEmployeeId: employeeId, resolvedById: user.id, resolvedAt: nowSql(deps.now()) });
  await deps.log(user.id, "account_link", employeeId, `Conta #${user.id} <${normalizeEmail(user.email)}> ligada à ficha #${employeeId} com o código enviado por email (pedido #${req.id})`);
  return { employeeId };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Código de 6 algarismos (com zeros à esquerda). */
export function randomLinkCode(): string {
  return String(crypto.randomInt(0, 10 ** ACCOUNT_LINK_LIMITS.codeLength)).padStart(ACCOUNT_LINK_LIMITS.codeLength, "0");
}

/** Hash do código (HMAC com o segredo do servidor + o id do pedido): o código nunca se guarda. */
export function hashLinkCode(requestId: number, code: string, secret = process.env.JWT_SECRET || "account-link"): string {
  return crypto.createHmac("sha256", secret).update(`account-link:${requestId}:${code}`).digest("hex");
}

// ─── Ligações (BD) ───────────────────────────────────────────────────────────

/**
 * Liga a conta `user` à ficha. Regras (49c):
 *  - a ficha sem conta, ou com a conta principal DESATIVADA → esta passa a
 *    principal (a antiga fica como conta extra, sem mexer nela);
 *  - com a principal ativa → entra como conta extra (mecanismo de sempre);
 *  - ficha inativa → a conta fica como utilizador; ficha ativa de extra/
 *    condutor → a conta "utilizador" passa ao papel do posto;
 *  - o email Google vai para o email pessoal da ficha se este estiver vazio.
 * `actor` = quem decide no RH (aplica a guarda de papéis das Ligações);
 * sem actor = a própria pessoa (só fichas que ela pode ligar sozinha).
 */
export async function linkClaimedAccount(employeeId: number, user: LinkUser, by: { actor?: { id: number; role: string } | null; how: string }): Promise<{ employeeId: number; mode: "principal" | "extra"; role: string | null }> {
  const d = await database();
  const [e] = rowsOf(await d.execute(sql`SELECT id, fullName, email, personalEmail, position, isActive, userId, deactivationReason FROM employees WHERE id = ${employeeId} LIMIT 1`));
  if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha não encontrada." });
  if (!on(e.isActive) && deactivationBlocksLogin(e.deactivationReason)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Esta ficha está desativada («${deactivationReasonLabel(e.deactivationReason) || "sem motivo"}»): não se liga. Se for para voltar, reativa-a primeiro no RH.` });
  }
  if (!by.actor && !selfLinkableEmployee({ position: e.position, isActive: e.isActive, deactivationReason: e.deactivationReason })) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Esta ficha só o RH a liga." });
  }
  const [taken] = rowsOf(await d.execute(sql`SELECT id, fullName FROM employees WHERE userId = ${user.id} AND isActive = 1 AND id <> ${employeeId} LIMIT 1`));
  if (taken) throw new TRPCError({ code: "BAD_REQUEST", message: `Essa conta já está na ficha ${taken.fullName} (#${taken.id}).` });
  const [acct] = rowsOf(await d.execute(sql`SELECT id, role, isActive FROM users WHERE id = ${user.id} LIMIT 1`));
  if (!acct) throw new TRPCError({ code: "NOT_FOUND", message: "Conta não encontrada." });
  const oldId = e.userId == null ? null : Number(e.userId);
  const [old] = oldId && oldId !== user.id ? rowsOf(await d.execute(sql`SELECT id, role, isActive FROM users WHERE id = ${oldId} LIMIT 1`)) : [];
  const asExtra = !!old && on(old.isActive);
  // Sozinha, a pessoa nunca herda um papel de estrutura (conta extra copia o papel da principal).
  if (!by.actor && asExtra && !isComebackRole(String(old.role))) throw new TRPCError({ code: "FORBIDDEN", message: "Esta ficha só o RH a liga." });
  const fichaActive = on(e.isActive);
  // Papel com que a conta fica (para a guarda do RH e para gravar).
  const { roleForPosition } = await import("./identityReconcile");
  const becomes: string = !fichaActive ? "user"
    : asExtra ? String(old.role)
    : isComebackPosition(e.position) ? (roleAfterActivation(String(acct.role), roleForPosition(String(e.position))) ?? String(acct.role))
    : String(acct.role);
  if (by.actor) {
    const { linkRoleGuard } = await import("./userAdminRules");
    const { countActiveSuperAdmins } = await import("./db");
    const guard = linkRoleGuard({ actor: by.actor, linked: { id: Number(acct.id), role: String(acct.role), isActive: Number(acct.isActive) } as any, primaryRole: becomes, activeSuperAdminCount: await countActiveSuperAdmins() });
    if (guard) throw new TRPCError({ code: "FORBIDDEN", message: guard });
  }
  let mode: "principal" | "extra" = "principal";
  if (oldId == null) {
    await d.execute(sql`UPDATE employees SET userId = ${user.id} WHERE id = ${employeeId} AND userId IS NULL`);
  } else if (oldId !== user.id) {
    if (asExtra) {
      const { addAccountAlias } = await import("./employeeAliases");
      await addAccountAlias(employeeId, user.id);
      mode = "extra";
    } else {
      // a principal estava desativada: a nova passa a principal e a antiga fica como conta extra (sem mexer nela)
      await d.execute(sql`UPDATE employees SET userId = ${user.id} WHERE id = ${employeeId} AND userId = ${oldId}`);
      await d.execute(sql`INSERT INTO employee_accounts (userId, employeeId) VALUES (${oldId}, ${employeeId}) ON DUPLICATE KEY UPDATE employeeId = VALUES(employeeId)`).catch(() => undefined);
    }
  }
  let role: string | null = null;
  if (becomes !== String(acct.role) && ["user", "extra", "condutor"].includes(String(acct.role))) {
    await d.execute(sql`UPDATE users SET role = ${becomes} WHERE id = ${user.id}`);
    role = becomes;
  }
  const google = normalizeEmail(user.email);
  if (isPlausibleEmail(google) && google !== normalizeEmail(e.email) && !String(e.personalEmail ?? "").trim()) {
    await d.execute(sql`UPDATE employees SET personalEmail = ${google} WHERE id = ${employeeId} AND (personalEmail IS NULL OR personalEmail = '')`);
  }
  const { logActivity } = await import("./db");
  await logActivity({ userId: by.actor?.id ?? user.id, action: "account_link", entity: "employee", entityId: employeeId,
    details: `Conta #${user.id} <${google || "sem email"}> ligada à ficha #${employeeId} ${e.fullName} como conta ${mode} (${by.how})${role ? ` · papel: ${role}` : ""}` } as any);
  const { invalidateLoginBlock } = await import("./loginBlock");
  invalidateLoginBlock(user.id);
  return { employeeId, mode, role };
}

/** Cria a ficha de CANDIDATO (extra, inativa, motivo "candidato") ligada à conta. */
export async function createCandidateFicha(c: { fullName: string; email: string; phone?: string | null; nif?: string | null; userId: number; personalEmail?: string | null; projectId?: number | null; how: string }): Promise<number> {
  const d = await database();
  // Corrida (duplo clique): se a conta já tem ficha, é essa.
  const [mine] = rowsOf(await d.execute(sql`SELECT id FROM employees WHERE userId = ${c.userId} ORDER BY isActive DESC, id DESC LIMIT 1`));
  if (mine) return Number(mine.id);
  const now = nowSql();
  const personal = normalizeEmail(c.personalEmail);
  const res: any = await d.execute(sql`INSERT INTO employees (fullName, email, personalEmail, phone, nif, position, contractType, userId, projectId, isActive,
      deactivationReason, deactivatedAt, autoCreatedAt)
    VALUES (${c.fullName.trim().slice(0, 256) || c.email.split("@")[0]}, ${normalizeEmail(c.email)}, ${personal && personal !== normalizeEmail(c.email) ? personal : null},
      ${normalizePhoneForStorage(c.phone ?? null)}, ${(c.nif ?? null)?.slice(0, 20) ?? null}, 'extra', 'extra', ${c.userId}, ${c.projectId ?? null}, 0, ${CANDIDATE_REASON}, ${now}, ${now})`);
  const id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
  const { logActivity } = await import("./db");
  await logActivity({ userId: c.userId, action: "employee_candidate_create", entity: "employee", entityId: id,
    details: `Ficha de candidato criada (${c.how}): ${c.fullName} <${normalizeEmail(c.email)}> — inativa até o RH aprovar` } as any);
  return id;
}

/** Candidatura → ficha de candidato (ou a ficha que já existe com esse email). Nunca duplica. */
export async function linkFromApplication(applicationId: number, user: LinkUser, by: { actor?: { id: number; role: string } | null; how: string }): Promise<number> {
  const d = await database();
  const [app] = rowsOf(await d.execute(sql`SELECT id, email, fullName, phone, nif, city, employeeId FROM driver_applications WHERE id = ${applicationId} LIMIT 1`));
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Candidatura não encontrada." });
  if (app.employeeId != null) return (await linkClaimedAccount(Number(app.employeeId), user, by)).employeeId;
  const { getDb } = await import("./db");
  const { findEmployeeByEmail } = await import("./identity");
  const existing = await findEmployeeByEmail((await getDb()) as any, String(app.email));
  if (existing) return (await linkClaimedAccount(existing.id, user, by)).employeeId;
  // A cidade escrita na candidatura dá já o centro de custos (o supervisor da cidade vê a ficha e os documentos).
  const projectId = await cityProjectId(app.city ?? null);
  return createCandidateFicha({ fullName: String(app.fullName ?? ""), email: String(app.email), phone: app.phone ?? null, nif: app.nif ?? null, userId: user.id, personalEmail: user.email, projectId, how: by.how });
}

/** O nó "cidade" (Lisboa/Porto/Faro) de um texto livre, ou null. */
async function cityProjectId(text: string | null): Promise<number | null> {
  const { cityKeyFromText, matchCityKey } = await import("../shared/city");
  const key = cityKeyFromText(text ?? "");
  if (!key) return null;
  try {
    const { getProjects } = await import("./db");
    const node = ((await getProjects()) as Array<{ id: number; name: string; level: string }>).find((p) => p.level === "city" && matchCityKey(p.name) === key);
    return node ? Number(node.id) : null;
  } catch {
    return null;
  }
}

/** Fichas e candidaturas com este email/telefone (ficha junta a outra → a que ficou). Nunca por nome. */
export async function findLinkMatches(claim: LinkClaim): Promise<LinkMatch[]> {
  const d = await database();
  const cols = sql`e.id, e.email, e.position, e.isActive, e.deactivationReason, e.deactivationReasonOther, e.phone, e.personalPhone`;
  let emps: any[] = [];
  let apps: any[] = [];
  if (claim.kind === "email") {
    emps = rowsOf(await d.execute(sql`SELECT ${cols} FROM employees e
       WHERE LOWER(TRIM(e.email)) = ${claim.email} OR LOWER(TRIM(e.personalEmail)) = ${claim.email}
          OR e.userId IN (SELECT u.id FROM users u WHERE LOWER(TRIM(u.email)) = ${claim.email})
          OR e.id IN (SELECT a.employeeId FROM employee_accounts a JOIN users u ON u.id = a.userId WHERE LOWER(TRIM(u.email)) = ${claim.email})`));
    apps = rowsOf(await d.execute(sql`SELECT id, email, employeeId FROM driver_applications WHERE LOWER(TRIM(email)) = ${claim.email}`));
  } else {
    emps = rowsOf(await d.execute(sql`SELECT ${cols} FROM employees e WHERE e.phone IS NOT NULL OR e.personalPhone IS NOT NULL`))
      .filter((r) => [r.phone, r.personalPhone].some((p) => p && normalizePhoneE164(String(p)) === claim.phone));
    apps = rowsOf(await d.execute(sql`SELECT id, email, employeeId, phone FROM driver_applications WHERE phone IS NOT NULL`))
      .filter((r) => normalizePhoneE164(String(r.phone)) === claim.phone);
  }
  // Ficha junta a outra ("ficha_duplicada", "Junta à ficha #N") → a que ficou.
  const { mergedTargetId } = await import("../shared/extraLeadsConvert");
  const out = new Map<number, LinkMatch>();
  for (let r of emps) {
    for (let i = 0; i < 5; i++) {
      const next = mergedTargetId({ id: Number(r.id), isActive: Number(r.isActive), deactivationReason: r.deactivationReason, deactivationReasonOther: r.deactivationReasonOther });
      if (next == null) break;
      const [t] = rowsOf(await d.execute(sql`SELECT ${cols} FROM employees e WHERE e.id = ${next} LIMIT 1`));
      if (!t) break;
      r = t;
    }
    out.set(Number(r.id), { kind: "employee", id: Number(r.id), email: r.email ?? null, position: r.position ?? null, isActive: Number(r.isActive), deactivationReason: r.deactivationReason ?? null });
  }
  const list: LinkMatch[] = [...out.values()];
  for (const a of apps) list.push({ kind: "application", id: Number(a.id), email: String(a.email), employeeId: a.employeeId == null ? null : Number(a.employeeId) });
  return list;
}

/** Utilizador da pessoa do recrutamento (Definições → rh.missingCityAssignee), ou null. */
export async function recruiterUserId(): Promise<number | null> {
  try {
    const [{ findEmployeeByEmailOrName }, { getSetting }, { MISSING_CITY_ASSIGNEE_DEFAULT }] = await Promise.all([
      import("./db"), import("./appSettings"), import("./employeeCityFix"),
    ]);
    let who = MISSING_CITY_ASSIGNEE_DEFAULT;
    try { who = (await getSetting("rh.missingCityAssignee")) || who; } catch { /* omissão */ }
    const e: any = await findEmployeeByEmailOrName(String(who));
    return e && Number(e.isActive) === 1 && e.userId ? Number(e.userId) : null;
  } catch {
    return null;
  }
}

async function notifyRecruitment(kind: "account_link_request" | "employee_comeback", n: { title: string; body: string; employeeId: number | null; city?: string | null; entity: { type: string; id: string | number } }): Promise<void> {
  try {
    const { notify } = await import("./notify");
    const marcia = await recruiterUserId();
    await notify({
      kind, title: n.title, body: n.body,
      ...(n.employeeId ? { employeeId: n.employeeId } : { city: n.city ?? null }),
      link: "/extras-leads?tab=candidaturas", entity: n.entity, alsoUserIds: marcia ? [marcia] : [],
    });
  } catch (err) {
    console.warn(`[accountLink] aviso ${kind} falhou:`, String((err as any)?.message ?? err).slice(0, 160));
  }
}

/** As dependências reais (BD, email, sino, interruptor). */
export function realLinkDeps(): LinkDeps {
  return {
    now: () => new Date(),
    async flagOn() {
      const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
      await ensureFeatureFlagOverrides();
      return isFeatureEnabled(ACCOUNT_LINK_FLAG, { defaultEnabled: automationFlagDefault(ACCOUNT_LINK_FLAG) });
    },
    async countRecent(userId) {
      const d = await database();
      const [r] = rowsOf(await d.execute(sql`SELECT COUNT(*) AS n FROM account_link_requests WHERE userId = ${userId} AND kind = 'link' AND createdAt >= NOW() - INTERVAL 1 DAY`));
      return Number(r?.n ?? 0);
    },
    async expirePending(userId) {
      const d = await database();
      await d.execute(sql`UPDATE account_link_requests SET status = 'expired', codeHash = NULL, codeExpiresAt = NULL, resolvedAt = ${nowSql()}, note = 'substituído por um pedido novo'
        WHERE userId = ${userId} AND kind = 'link' AND status = 'pending'`);
    },
    async insert(row) {
      const d = await database();
      const res: any = await d.execute(sql`INSERT INTO account_link_requests (kind, userId, googleEmail, claimedEmail, claimedPhone, employeeId, matchedEmployeeId, matchedApplicationId, status, attempts, note)
        VALUES (${row.kind}, ${row.userId}, ${row.googleEmail}, ${row.claimedEmail}, ${row.claimedPhone}, ${row.employeeId}, ${row.matchedEmployeeId}, ${row.matchedApplicationId}, ${row.status}, 0, ${row.note ?? null})`);
      return Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
    },
    async update(id, patch) {
      const d = await database();
      const allowed = ["status", "codeHash", "codeExpiresAt", "attempts", "note", "matchedEmployeeId", "resolvedById", "resolvedAt"] as const;
      const sets = allowed.filter((k) => (patch as any)[k] !== undefined).map((k) => sql`${sql.raw(`\`${k}\``)} = ${(patch as any)[k]}`);
      if (!sets.length) return;
      await d.execute(sql`UPDATE account_link_requests SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    },
    async get(id) {
      const d = await database();
      const [r] = rowsOf(await d.execute(sql`SELECT * FROM account_link_requests WHERE id = ${id} LIMIT 1`));
      return r ? toRow(r) : null;
    },
    findMatches: findLinkMatches,
    async sendCode(to, code) {
      const { sendEmail } = await import("./mail/systemMail");
      return sendEmail({
        to, from: "recursos-humanos@multipark.pt", fromName: "Multipark Recrutamento",
        subject: `Código para ligar a tua conta: ${code}`,
        text: `Olá,\n\nAlguém entrou na aplicação Multipark com uma conta Google e disse que este email é seu.\n\nSe foste tu, escreve este código na aplicação (vale ${ACCOUNT_LINK_LIMITS.codeMinutes} minutos):\n\n${code}\n\nSe não foste tu, ignora este email — sem o código nada é ligado.\n\nMultipark Recrutamento`,
      });
    },
    async notifyRh(req) {
      let city: string | null = null;
      if (!req.employeeId && req.applicationId) {
        const d = await database();
        city = rowsOf(await d.execute(sql`SELECT city FROM driver_applications WHERE id = ${req.applicationId} LIMIT 1`))[0]?.city ?? null;
      }
      await notifyRecruitment("account_link_request", {
        title: req.summary.slice(0, 200), body: "Confirma quem é e liga a conta (ou recusa) em Leads de Extras → Candidaturas.",
        employeeId: req.employeeId, city, entity: { type: "account_link_request", id: req.id },
      });
    },
    async linkTarget(target, user) {
      if (target.kind === "employee") return (await linkClaimedAccount(target.employeeId, user, { how: "código enviado por email" })).employeeId;
      return linkFromApplication(target.applicationId, user, { how: "código enviado por email" });
    },
    async log(userId, action, entityId, details) {
      const { logActivity } = await import("./db");
      await logActivity({ userId, action, entity: "account_link_requests", entityId: entityId ?? undefined, details: details.slice(0, 1000), source: "ui" } as any);
    },
    randomCode: randomLinkCode,
    hash: (id, code) => hashLinkCode(id, code),
  };
}

function toRow(r: any): LinkRequestRow {
  const n = (v: any) => (v == null ? null : Number(v));
  const dt = (v: any) => (v == null ? null : v instanceof Date ? nowSql(v) : String(v));
  return {
    id: Number(r.id), kind: String(r.kind ?? "link"), userId: Number(r.userId), googleEmail: r.googleEmail ?? null,
    claimedEmail: r.claimedEmail ?? null, claimedPhone: r.claimedPhone ?? null, employeeId: n(r.employeeId),
    matchedEmployeeId: n(r.matchedEmployeeId), matchedApplicationId: n(r.matchedApplicationId), status: String(r.status),
    codeHash: r.codeHash ?? null, codeExpiresAt: dt(r.codeExpiresAt), attempts: Number(r.attempts ?? 0), note: r.note ?? null, createdAt: dt(r.createdAt),
  };
}

// ─── "Sou novo — quero candidatar-me" ───────────────────────────────────────

export type CandidateOutcome = "already" | "linked" | "created" | "pending_rh";

export interface CandidateDeps {
  myEmployeeId(userId: number): Promise<number | null>;
  findEmployeeByEmail(email: string): Promise<{ id: number; position: string | null; isActive: number; deactivationReason: string | null } | null>;
  findApplicationByEmail(email: string): Promise<{ id: number; employeeId: number | null } | null>;
  employeeInfo(id: number): Promise<{ id: number; position: string | null; isActive: number; deactivationReason: string | null } | null>;
  createApplication(c: { email: string; fullName: string; city?: string | null }): Promise<number>;
  linkEmployee(employeeId: number, user: LinkUser): Promise<void>;
  createFromApplication(applicationId: number, user: LinkUser): Promise<number>;
  requestRh(c: { user: LinkUser; employeeId: number }): Promise<void>;
}

/** "Sou novo": liga ao que já existe com o email Google ou cria a ficha de candidato (+ candidatura). Nunca duplica. */
export async function startCandidate(deps: CandidateDeps, user: LinkUser, opts: { city?: string | null } = {}): Promise<{ outcome: CandidateOutcome; employeeId: number | null }> {
  const mine = await deps.myEmployeeId(user.id);
  if (mine) return { outcome: "already", employeeId: mine };
  const email = normalizeEmail(user.email);
  if (!isPlausibleEmail(email)) throw new TRPCError({ code: "BAD_REQUEST", message: "A tua conta Google não tem um email válido. Entra com outra conta." });
  const existing = await deps.findEmployeeByEmail(email);
  if (existing) {
    if (!selfLinkableEmployee(existing)) {
      await deps.requestRh({ user, employeeId: existing.id });
      return { outcome: "pending_rh", employeeId: null };
    }
    if (!(await linkOrAskRh(deps, user, existing.id))) return { outcome: "pending_rh", employeeId: null };
    return { outcome: "linked", employeeId: existing.id };
  }
  const app = await deps.findApplicationByEmail(email);
  // Candidatura já aprovada (tem ficha, com outro email) → essa ficha.
  const approved = app?.employeeId ? await deps.employeeInfo(app.employeeId) : null;
  if (approved) {
    if (!selfLinkableEmployee(approved)) {
      await deps.requestRh({ user, employeeId: approved.id });
      return { outcome: "pending_rh", employeeId: null };
    }
    if (!(await linkOrAskRh(deps, user, approved.id))) return { outcome: "pending_rh", employeeId: null };
    return { outcome: "linked", employeeId: approved.id };
  }
  const appId = app?.id ?? (await deps.createApplication({ email, fullName: String(user.name ?? "").trim() || email.split("@")[0], city: opts.city ?? null }));
  const employeeId = await deps.createFromApplication(appId, user);
  return { outcome: "created", employeeId };
}

/** Liga; se a regra disser que só o RH liga (FORBIDDEN), faz o pedido ao RH e devolve false. */
async function linkOrAskRh(deps: CandidateDeps, user: LinkUser, employeeId: number): Promise<boolean> {
  try {
    await deps.linkEmployee(employeeId, user);
    return true;
  } catch (err) {
    if (!(err instanceof TRPCError) || err.code !== "FORBIDDEN") throw err;
    await deps.requestRh({ user, employeeId });
    return false;
  }
}

export function realCandidateDeps(): CandidateDeps {
  return {
    async myEmployeeId(userId) {
      const { getEmployeeByUserId } = await import("./db");
      return (await getEmployeeByUserId(userId))?.employee.id ?? null;
    },
    async findEmployeeByEmail(email) {
      const { getDb } = await import("./db");
      const { findEmployeeByEmail } = await import("./identity");
      const hit = await findEmployeeByEmail((await getDb()) as any, email);
      return hit ? this.employeeInfo(hit.id) : null;
    },
    async employeeInfo(id) {
      const d = await database();
      const [r] = rowsOf(await d.execute(sql`SELECT id, position, isActive, deactivationReason FROM employees WHERE id = ${id} LIMIT 1`));
      return r ? { id: Number(r.id), position: r.position ?? null, isActive: Number(r.isActive), deactivationReason: r.deactivationReason ?? null } : null;
    },
    async findApplicationByEmail(email) {
      const d = await database();
      const [r] = rowsOf(await d.execute(sql`SELECT id, employeeId FROM driver_applications WHERE LOWER(TRIM(email)) = ${email} ORDER BY id LIMIT 1`));
      return r ? { id: Number(r.id), employeeId: r.employeeId == null ? null : Number(r.employeeId) } : null;
    },
    async createApplication(c) {
      const { upsertDriverApplication } = await import("./webIntake");
      const r = await upsertDriverApplication({ email: c.email, firstName: c.fullName.slice(0, 128), lastName: "", city: c.city ?? null, payload: { origem: "app", nota: "Entrou na app com a Google e carregou em \"Sou novo — quero candidatar-me\"" } } as any, { source: "app" });
      return r.id;
    },
    async linkEmployee(employeeId, user) {
      await linkClaimedAccount(employeeId, user, { how: "\"Sou novo\" com o mesmo email Google" });
    },
    createFromApplication: (applicationId, user) => linkFromApplication(applicationId, user, { how: "\"Sou novo — quero candidatar-me\"" }),
    async requestRh({ user, employeeId }) {
      const d = await database();
      const google = normalizeEmail(user.email) || null;
      await d.execute(sql`UPDATE account_link_requests SET status = 'expired', resolvedAt = ${nowSql()}, note = 'substituído por um pedido novo' WHERE userId = ${user.id} AND kind = 'link' AND status = 'pending'`);
      const res: any = await d.execute(sql`INSERT INTO account_link_requests (kind, userId, googleEmail, claimedEmail, matchedEmployeeId, status, note)
        VALUES ('link', ${user.id}, ${google}, ${google}, ${employeeId}, 'pending', 'Sou novo: o email Google já está numa ficha que só o RH liga')`);
      const id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
      await notifyRecruitment("account_link_request", {
        title: linkRequestSummary({ googleEmail: google, claimedEmail: google, claimedPhone: null }).slice(0, 200),
        body: "Carregou em \"Sou novo\", mas o email já está numa ficha que só o RH liga (estrutura ou desativada). Decide em Leads de Extras → Candidaturas.",
        employeeId, entity: { type: "account_link_request", id },
      });
    },
  };
}

// ─── "Voltei, quero trabalhar" ──────────────────────────────────────────────

export async function requestComeback(user: LinkUser): Promise<{ at: string }> {
  const { getEmployeeByUserId, logActivity } = await import("./db");
  const me = await getEmployeeByUserId(user.id);
  if (!me) {
    const { noLinkedRecordMessage } = await import("../shared/ownAccess");
    throw new TRPCError({ code: "FORBIDDEN", message: noLinkedRecordMessage(user.email) });
  }
  const e: any = me.employee;
  if (!canSayComeback(e)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: on(e.isActive) ? "A tua ficha já está ativa." : isCandidateFicha(e) ? "A tua candidatura está à espera do RH." : "Fala com o RH." });
  }
  const at = nowSql();
  const d = await database();
  await d.execute(sql`UPDATE employees SET comebackRequestedAt = ${at} WHERE id = ${e.id} AND isActive = 0`);
  await logActivity({ userId: user.id, action: "comeback_request", entity: "employee", entityId: e.id, details: `"Voltei, quero trabalhar": ${e.fullName} quer voltar (ficha inativa — ${deactivationReasonLabel(e.deactivationReason, e.deactivationReasonOther)})` } as any);
  await notifyRecruitment("employee_comeback", {
    title: `Quer voltar: ${e.fullName}`.slice(0, 200),
    body: "Estava inativo, entrou e carregou em \"Voltei, quero trabalhar\". Vê os dados e os dias livres e reativa no RH (ou em Leads de Extras → Candidaturas).",
    employeeId: e.id, entity: { type: "employee_comeback", id: `${e.id}:${at.slice(0, 10)}` },
  });
  return { at };
}

// ─── Possíveis duplicados (o próprio candidato grava telefone/NIF) ──────────

const nifKey = (v: unknown) => String(v ?? "").replace(/\D/g, "");

/**
 * Depois de o CANDIDATO gravar a ficha: telefone ou NIF iguais aos de outra
 * ficha ou candidatura → pedido "possível duplicado de #N" para o RH (uma vez
 * por par). Não bloqueia nada. Devolve quantos pedidos novos.
 */
export async function flagCandidateDuplicates(employeeId: number): Promise<number> {
  const d = await database();
  const [e] = rowsOf(await d.execute(sql`SELECT id, fullName, email, phone, nif, userId, isActive, deactivationReason, projectId FROM employees WHERE id = ${employeeId} LIMIT 1`));
  if (!e || !isCandidateFicha({ isActive: Number(e.isActive), deactivationReason: e.deactivationReason })) return 0;
  const phone = e.phone ? normalizePhoneE164(String(e.phone)) : null;
  const nif = nifKey(e.nif);
  if (!phone && nif.length < 9) return 0;
  const same = (p: unknown, n: unknown) => (!!phone && !!p && normalizePhoneE164(String(p)) === phone) || (nif.length >= 9 && nifKey(n) === nif);
  const emps = rowsOf(await d.execute(sql`SELECT id, phone, personalPhone, nif FROM employees WHERE id <> ${employeeId} AND (phone IS NOT NULL OR personalPhone IS NOT NULL OR nif IS NOT NULL)`))
    .filter((r) => same(r.phone, r.nif) || same(r.personalPhone, null));
  const apps = rowsOf(await d.execute(sql`SELECT id, phone, nif, employeeId FROM driver_applications WHERE (phone IS NOT NULL OR nif IS NOT NULL) AND LOWER(TRIM(email)) <> ${normalizeEmail(e.email)}`))
    .filter((r) => same(r.phone, r.nif) && Number(r.employeeId ?? 0) !== employeeId);
  const [acct] = e.userId ? rowsOf(await d.execute(sql`SELECT email FROM users WHERE id = ${Number(e.userId)} LIMIT 1`)) : [];
  let created = 0;
  const targets: Array<{ emp: number | null; app: number | null }> = [
    ...emps.map((r) => ({ emp: Number(r.id), app: null })),
    ...apps.filter((r) => !emps.some((x) => Number(x.id) === Number(r.employeeId))).map((r) => ({ emp: r.employeeId == null ? null : Number(r.employeeId), app: r.employeeId == null ? Number(r.id) : null })),
  ].slice(0, 10);
  for (const t of targets) {
    const [dup] = rowsOf(await d.execute(sql`SELECT id FROM account_link_requests WHERE kind = 'duplicate' AND employeeId = ${employeeId}
        AND ${t.emp == null ? sql`matchedEmployeeId IS NULL` : sql`matchedEmployeeId = ${t.emp}`}
        AND ${t.app == null ? sql`matchedApplicationId IS NULL` : sql`matchedApplicationId = ${t.app}`} LIMIT 1`));
    if (dup) continue;
    const res: any = await d.execute(sql`INSERT INTO account_link_requests (kind, userId, googleEmail, employeeId, matchedEmployeeId, matchedApplicationId, status, note)
      VALUES ('duplicate', ${Number(e.userId ?? 0)}, ${acct?.email ?? e.email ?? null}, ${employeeId}, ${t.emp}, ${t.app}, 'pending', ${`mesmo ${phone && nif.length >= 9 ? "telefone ou NIF" : phone ? "telefone" : "NIF"}`})`);
    const id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
    created++;
    await notifyRecruitment("account_link_request", {
      title: `Possível duplicado: ${e.fullName} (#${employeeId})${t.emp ? ` e a ficha #${t.emp}` : t.app ? ` e a candidatura #${t.app}` : ""}`.slice(0, 200),
      body: "O candidato gravou um telefone/NIF que já está noutro registo. Vê as duas e, se for a mesma pessoa, junta-as (RH → Ligações → Juntar fichas).",
      employeeId: t.emp ?? null, entity: { type: "account_link_duplicate", id },
    });
  }
  return created;
}
