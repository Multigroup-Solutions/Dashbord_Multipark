/**
 * Lote 39a — Central Vodafone (Integrações): os acessos da consola, por
 * pessoa, e o que ela já mandou. Só o super admin. O segredo de cada acesso
 * só se mostra quando se cria; revoga-se (nunca se apaga).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "./_core/trpc";
import { getDb, logActivity } from "./db";
import { generateCentralSecret, hashCentralSecret } from "./centralSugar";
import { CENTRAL_SUGAR_BASE_PATH, CENTRAL_SUGAR_FLAG, centralCallTotals, normalizeCentralUsername, parseContactRef } from "../shared/centralSugar";
import { ENV } from "./_core/env";

const superOnly = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin gere a central." });
  return next({ ctx });
});
const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  return db;
}
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const iso = (v: unknown) => (v ? `${String(v).replace(" ", "T").slice(0, 19)}Z` : null);

type Db = Awaited<ReturnType<typeof dbOrThrow>>;
interface CallContact { name: string; kind: "Equipa" | "Cliente" | "Contacto" | "Sem ficha" | "Interna"; href: string | null }
/** 39e: com quem foi cada chamada (ficha do RH, cliente ou contacto do CRM), lido por lotes. */
async function callContacts(db: Db, refs: Array<string | null>): Promise<Map<string, CallContact>> {
  const out = new Map<string, CallContact>();
  const ids = { emp: new Set<number>(), crm: new Set<number>(), ct: new Set<number>() };
  for (const r of refs) {
    const p = parseContactRef(r);
    if (!p) continue;
    if (p.kind === "tel") out.set(String(r), { name: `+${p.id}`, kind: "Sem ficha", href: null });
    else if (p.kind === "ext") out.set(String(r), { name: `Extensão ${p.id}`, kind: "Interna", href: null }); // 39f
    else ids[p.kind].add(Number(p.id));
  }
  const list = (s: Set<number>) => sql.join([...s].map((n) => sql`${n}`), sql`, `);
  const read = async (q: ReturnType<typeof sql>) => rowsOf(await db.execute(q).catch(() => [[]]));
  if (ids.emp.size) for (const e of await read(sql`SELECT id, fullName FROM employees WHERE id IN (${list(ids.emp)})`))
    out.set(`emp-${e.id}`, { name: String(e.fullName ?? `Ficha #${e.id}`), kind: "Equipa", href: "/rh" });
  if (ids.crm.size) for (const c of await read(sql`SELECT id, displayName, firstName, lastName FROM crm_clients WHERE id IN (${list(ids.crm)})`))
    out.set(`crm-${c.id}`, { name: String(c.displayName || `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || `Cliente #${c.id}`), kind: "Cliente", href: `/clientes/${c.id}` });
  if (ids.ct.size) for (const c of await read(sql`SELECT id, name FROM crm_contacts WHERE id IN (${list(ids.ct)})`))
    out.set(`ct-${c.id}`, { name: String(c.name ?? `Contacto #${c.id}`), kind: "Contacto", href: "/clientes" });
  return out;
}

export const centralRouter = router({
  status: superOnly.query(async () => {
    const db = await dbOrThrow();
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    const enabled = isFeatureEnabled(CENTRAL_SUGAR_FLAG, { defaultEnabled: automationFlagDefault(CENTRAL_SUGAR_FLAG) });
    const accounts = rowsOf(await db.execute(sql`SELECT a.id, a.username, a.label, a.userId, u.name AS userName, a.createdAt, a.lastUsedAt, a.revokedAt, rb.name AS revokedByName
        FROM central_accounts a LEFT JOIN users u ON u.id = a.userId LEFT JOIN users rb ON rb.id = a.revokedById ORDER BY a.revokedAt IS NOT NULL, a.username LIMIT 200`));
    const calls = rowsOf(await db.execute(sql`SELECT c.id, c.direction, c.held, c.startedAt, c.durationS, c.phone, c.subject, c.contactRef, c.source, u.name AS userName
        FROM central_calls c LEFT JOIN users u ON u.id = c.userId ORDER BY c.startedAt DESC LIMIT 30`));
    const contacts = await callContacts(db, calls.map((c) => (c.contactRef ? String(c.contactRef) : null)));
    const requests = rowsOf(await db.execute(sql`SELECT id, at, method, path, status, accountId, note, bodyJson FROM central_requests ORDER BY id DESC LIMIT 40`));
    return {
      enabled, hasSecret: !!ENV.cookieSecret, basePath: CENTRAL_SUGAR_BASE_PATH,
      accounts: accounts.map((a) => ({ id: Number(a.id), username: String(a.username), label: a.label ? String(a.label) : null, userId: Number(a.userId),
        userName: a.userName ? String(a.userName) : null, createdAt: iso(a.createdAt), lastUsedAt: iso(a.lastUsedAt), revokedAt: iso(a.revokedAt),
        revokedByName: a.revokedByName ? String(a.revokedByName) : null })),
      calls: calls.map((c) => ({ id: Number(c.id), direction: c.direction === "out" ? "out" as const : "in" as const, held: Number(c.held) === 1, startedAt: iso(c.startedAt),
        durationS: c.durationS == null ? null : Number(c.durationS), phone: c.phone ? String(c.phone) : null, subject: c.subject ? String(c.subject) : null,
        source: String(c.source), userName: c.userName ? String(c.userName) : null,
        contact: c.contactRef ? contacts.get(String(c.contactRef)) ?? null : null })),
      requests: requests.map((q) => ({ id: Number(q.id), at: iso(q.at), method: String(q.method), path: String(q.path), status: Number(q.status),
        accountId: q.accountId == null ? null : Number(q.accountId), note: q.note ? String(q.note) : null, body: q.bodyJson ? String(q.bodyJson) : null })),
    };
  }),

  /**
   * Lote 45 (Jorge: "cada um vê as SUAS chamadas, nós vemos todas"): as chamadas
   * que a consola registou. Módulo "central": alcance "own" → só as da pessoa;
   * "national" (admin, super admin) → todas, com filtro por pessoa. Só lê.
   */
  myCalls: protectedProcedure
    .input(z.object({
      days: z.number().int().min(1).max(366).default(7),
      direction: z.enum(["in", "out"]).nullish(),
      userId: z.number().int().positive().nullish(),
    }).default({ days: 7 }))
    .query(async ({ ctx, input }) => {
      const { requireAccess } = await import("./_core/access");
      // "own" → só as da própria pessoa; "national" (admin, super admin) → todas.
      const seesAll = requireAccess(ctx.user, "central", "view", { allowOwn: true }) === "national";
      const db = await dbOrThrow();
      const who = seesAll ? (input.userId ?? null) : ctx.user.id;
      const since = utc(Date.now() - input.days * 86_400_000);
      const calls = rowsOf(await db.execute(sql`SELECT c.id, c.userId, c.direction, c.held, c.startedAt, c.durationS, c.phone, c.contactRef, u.name AS userName
          FROM central_calls c LEFT JOIN users u ON u.id = c.userId
          WHERE c.startedAt >= ${since} ${who != null ? sql`AND c.userId = ${who}` : sql``} ${input.direction ? sql`AND c.direction = ${input.direction}` : sql``}
          ORDER BY c.startedAt DESC LIMIT 500`));
      const contacts = await callContacts(db, calls.map((c) => (c.contactRef ? String(c.contactRef) : null)));
      const hasAccount = rowsOf(await db.execute(sql`SELECT 1 AS x FROM central_accounts WHERE userId = ${ctx.user.id} AND revokedAt IS NULL LIMIT 1`)).length > 0;
      const people = seesAll
        ? rowsOf(await db.execute(sql`SELECT DISTINCT a.userId, u.name FROM central_accounts a LEFT JOIN users u ON u.id = a.userId ORDER BY u.name LIMIT 200`))
          .map((p) => ({ userId: Number(p.userId), name: String(p.name ?? `#${p.userId}`) }))
        : [];
      const rows = calls.map((c) => ({
        id: Number(c.id), userId: Number(c.userId), userName: c.userName ? String(c.userName) : null,
        direction: c.direction === "out" ? "out" as const : "in" as const, held: Number(c.held) === 1, startedAt: iso(c.startedAt),
        durationS: c.durationS == null ? null : Number(c.durationS), phone: c.phone ? String(c.phone) : null,
        contact: c.contactRef ? contacts.get(String(c.contactRef)) ?? null : null,
      }));
      return { seesAll, hasAccount, people, calls: rows, truncated: calls.length >= 500, totals: centralCallTotals(rows) };
    }),

  /** Contas da dashboard para dar acesso (ativas). */
  users: superOnly.query(async () => {
    const db = await dbOrThrow();
    return rowsOf(await db.execute(sql`SELECT id, name, email, role FROM users WHERE isActive = 1 ORDER BY name LIMIT 2000`))
      .map((u) => ({ id: Number(u.id), name: String(u.name ?? u.email ?? `#${u.id}`), email: u.email ? String(u.email) : null, role: String(u.role) }));
  }),

  /** Cria o acesso de uma pessoa; devolve o segredo UMA vez. */
  createAccount: superOnly
    .input(z.object({ userId: z.number().int().positive(), username: z.string().max(60), label: z.string().max(200).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const username = normalizeCentralUsername(input.username);
      if (!username) throw new TRPCError({ code: "BAD_REQUEST", message: "Utilizador: 3 a 60 caracteres, só letras minúsculas, números, ponto, hífen e _." });
      const db = await dbOrThrow();
      const u = rowsOf(await db.execute(sql`SELECT id, name FROM users WHERE id = ${input.userId} AND isActive = 1 LIMIT 1`))[0];
      if (!u) throw new TRPCError({ code: "BAD_REQUEST", message: "Essa conta não existe ou está desativada." });
      const taken = rowsOf(await db.execute(sql`SELECT id FROM central_accounts WHERE username = ${username} LIMIT 1`))[0];
      if (taken) throw new TRPCError({ code: "CONFLICT", message: "Já existe um acesso com esse utilizador (mesmo revogado). Escolhe outro." });
      const secret = generateCentralSecret();
      await db.execute(sql`INSERT INTO central_accounts (username, secretHash, userId, label, createdById, createdAt)
          VALUES (${username}, ${hashCentralSecret(secret)}, ${input.userId}, ${input.label?.trim() || null}, ${ctx.user.id}, ${utc(Date.now())})`);
      await logActivity({ userId: ctx.user.id, action: "create", entity: "central_account", details: `Acesso da central "${username}" para ${String(u.name ?? `#${u.id}`)}` }).catch(() => null);
      return { username, secret };
    }),

  // ── 40a: Xsi da One Net ──
  /** Configuração do Xsi e o último "Testar" (nunca a palavra-passe). */
  xsiStatus: superOnly.query(async () => {
    const { xsiConfigView } = await import("./centralXsi");
    const { encryptionKeyInfo } = await import("./integrations/googleAds/crypto");
    let keySource: "env" | "derived" | "none" | "invalid" = "none";
    try { keySource = encryptionKeyInfo().source; } catch { keySource = "invalid"; }
    return { ...(await xsiConfigView()), keySource };
  }),

  xsiSave: superOnly
    .input(z.object({ baseUrl: z.string().max(300), userId: z.string().max(120), readUserId: z.string().max(120).nullable().optional(), password: z.string().max(200).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { saveXsiConfig } = await import("./centralXsi");
      const r = await saveXsiConfig(input, ctx.user.id);
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error });
      await logActivity({ userId: ctx.user.id, action: "update", entity: "central_xsi", details: `Xsi da One Net configurado${input.password ? " (palavra-passe nova)" : ""}` }).catch(() => null);
      return { ok: true };
    }),

  /** Lê o perfil, o diretório e os registos de chamadas no Xsi; não escreve nada lá. */
  xsiTest: superOnly.mutation(async () => {
    const { testXsi } = await import("./centralXsi");
    return testXsi();
  }),

  revokeAccount: superOnly
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = rowsOf(await db.execute(sql`SELECT id, username, revokedAt FROM central_accounts WHERE id = ${input.id} LIMIT 1`))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Acesso não encontrado." });
      if (a.revokedAt) return { ok: true, already: true };
      await db.execute(sql`UPDATE central_accounts SET revokedAt = ${utc(Date.now())}, revokedById = ${ctx.user.id} WHERE id = ${input.id} AND revokedAt IS NULL`);
      await logActivity({ userId: ctx.user.id, action: "revoke", entity: "central_account", entityId: input.id, details: `Acesso da central "${String(a.username)}" revogado` }).catch(() => null);
      return { ok: true, already: false };
    }),

  /**
   * Jorge (7 out 2026: "não me deixa entrar, diz que o acesso está revogado"):
   * um acesso revogado por engano volta a funcionar com a MESMA palavra-passe
   * que a consola já tem. Só se a conta da pessoa estiver ativa; a revogação
   * antiga (quem e quando) fica no histórico.
   */
  reactivateAccount: superOnly
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = rowsOf(await db.execute(sql`SELECT a.id, a.username, a.revokedAt, a.revokedById, u.isActive FROM central_accounts a
          LEFT JOIN users u ON u.id = a.userId WHERE a.id = ${input.id} LIMIT 1`))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Acesso não encontrado." });
      if (!a.revokedAt) return { ok: true, already: true };
      if (Number(a.isActive) !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "A conta dessa pessoa está desativada: reativa primeiro a conta." });
      await db.execute(sql`UPDATE central_accounts SET revokedAt = NULL, revokedById = NULL WHERE id = ${input.id} AND revokedAt IS NOT NULL`);
      await logActivity({ userId: ctx.user.id, action: "reactivate", entity: "central_account", entityId: input.id,
        details: `Acesso da central "${String(a.username)}" reativado (estava revogado desde ${iso(a.revokedAt) ?? "?"}${a.revokedById ? ` por #${Number(a.revokedById)}` : ""})` }).catch(() => null);
      return { ok: true, already: false };
    }),

  // ─── Lote 45: a central toca no dashboard (cada pessoa só vê a sua consola) ───
  /** Liga o toque para esta pessoa? (interruptor CENTRAL_RING + acesso da consola ativo). */
  ringSetup: protectedProcedure.query(async ({ ctx }) => {
    const { centralRingEnabled, hasCentralAccount } = await import("./centralRing");
    if (!(await centralRingEnabled())) return { enabled: false };
    return { enabled: await hasCentralAccount(ctx.user.id) };
  }),
  /** A chamada a tocar na consola desta pessoa (ou null). Só lê. */
  myRing: protectedProcedure.query(async ({ ctx }) => {
    const { centralRingEnabled, ringForUser } = await import("./centralRing");
    if (!(await centralRingEnabled())) return null;
    return ringForUser(ctx.user.id);
  }),
});
