/**
 * Lote 39a — Central Vodafone: a dashboard responde como um "Sugar CRM" à
 * One Net Attendant Console (regras puras em shared/centralSugar.ts).
 *
 * Na consola: Ligar a um servidor CRM → Sugar CRM → Server URL = a origem da
 * dashboard + /api/central/sugar; utilizador e palavra-passe = o acesso da
 * pessoa (Integrações → Central Vodafone; o segredo só se mostra uma vez).
 *
 *  - API REST v10 (Sugar 7+): POST /rest/v10/oauth2/token (password e
 *    refresh_token), /me, /ping, Calls (criar, ler, alterar, ligar a um
 *    contacto) e as pesquisas (por agora sem resultados).
 *  - API v4_1 (/service/v4_1/rest.php): login, get_user_id, set_entry (Calls),
 *    get_entry_list / search_by_module (vazias), logout, get_server_info.
 *  - Cada pedido fica em `central_requests` sem segredos, para se ver o que
 *    a consola manda. Interruptor CENTRAL_SUGAR (desligado → 503, só regista).
 *  - Tokens assinados (HMAC com o JWT_SECRET), 1 h (refresh 30 dias); um
 *    acesso revogado deixa logo de funcionar. Tentativas falhadas limitadas.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { ENV } from "./_core/env";
import { CENTRAL_SUGAR_FLAG, flattenNameValueList, normalizeCentralUsername, parseSugarCall, redactForLog, type CentralCall } from "../shared/centralSugar";

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_MAX = 10;

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// ─── Segredos e tokens ──────────────────────────────────────────────────────

/** Segredo novo (24 caracteres, 144 bits). Mostra-se uma vez. */
export function generateCentralSecret(): string {
  return randomBytes(18).toString("base64url");
}
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
/** Guarda-se sha256(md5(segredo)): a v4_1 do Sugar manda o md5, a v10 o texto. */
export function hashCentralSecret(secretOrMd5: string, isMd5 = false): string {
  return createHash("sha256").update(isMd5 ? secretOrMd5.toLowerCase() : md5(secretOrMd5), "utf8").digest("hex");
}
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function tokenKey(): Buffer | null {
  const s = ENV.cookieSecret;
  return s ? createHmac("sha256", s).update("central-sugar-v1").digest() : null;
}
/** "c1.<conta>.<a|r>.<expira>.<nonce>.<assinatura>" */
export function signCentralToken(accountId: number, kind: "a" | "r", expMs: number, key: Buffer): string {
  const body = `c1.${accountId}.${kind}.${expMs}.${randomBytes(6).toString("base64url")}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
export function verifyCentralToken(token: string, kind: "a" | "r", now: number, key: Buffer): number | null {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 6 || parts[0] !== "c1" || parts[2] !== kind) return null;
  const body = parts.slice(0, 5).join(".");
  const want = createHmac("sha256", key).update(body).digest();
  const got = Buffer.from(parts[5], "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (!(Number(parts[3]) > now)) return null;
  const id = Number(parts[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ─── Base de dados ──────────────────────────────────────────────────────────

interface Account { id: number; userId: number; username: string; name: string | null }

async function accountByUsername(username: string): Promise<(Account & { secretHash: string }) | null> {
  const db = await getDb();
  if (!db) return null;
  const r = rowsOf(await db.execute(sql`SELECT a.id, a.userId, a.username, a.secretHash, u.name FROM central_accounts a
      LEFT JOIN users u ON u.id = a.userId WHERE a.username = ${username} AND a.revokedAt IS NULL LIMIT 1`))[0];
  return r ? { id: Number(r.id), userId: Number(r.userId), username: String(r.username), secretHash: String(r.secretHash), name: r.name ? String(r.name) : null } : null;
}
async function accountById(id: number): Promise<Account | null> {
  const db = await getDb();
  if (!db) return null;
  const r = rowsOf(await db.execute(sql`SELECT a.id, a.userId, a.username, u.name FROM central_accounts a
      LEFT JOIN users u ON u.id = a.userId WHERE a.id = ${id} AND a.revokedAt IS NULL LIMIT 1`))[0];
  return r ? { id: Number(r.id), userId: Number(r.userId), username: String(r.username), name: r.name ? String(r.name) : null } : null;
}
async function touch(accountId: number) {
  const db = await getDb();
  await db?.execute(sql`UPDATE central_accounts SET lastUsedAt = ${utc(Date.now())} WHERE id = ${accountId}`).catch(() => null);
}

async function logRequest(req: Request, status: number, accountId: number | null, note: string | null) {
  try {
    const db = await getDb();
    if (!db) return;
    const path = String(req.originalUrl || req.url).split("?")[0].slice(0, 255);
    const query = req.query && Object.keys(req.query).length ? { query: req.query } : {};
    // 39b: quem pediu (programa e formato) e se trazia token — nunca o valor do token
    const hdr = req.headers;
    const client = {
      client: {
        ...(hdr["user-agent"] ? { userAgent: String(hdr["user-agent"]).slice(0, 200) } : {}),
        ...(hdr["content-type"] ? { contentType: String(hdr["content-type"]).slice(0, 100) } : {}),
        withCredentials: !!(hdr["oauth-token"] || hdr.authorization),
      },
    };
    const body = redactForLog({ ...client, ...query, ...(req.body && typeof req.body === "object" && Object.keys(req.body).length ? { body: req.body } : {}) });
    await db.execute(sql`INSERT INTO central_requests (at, method, path, status, accountId, note, bodyJson)
        VALUES (${utc(Date.now())}, ${req.method.slice(0, 8)}, ${path}, ${status}, ${accountId}, ${note ? note.slice(0, 255) : null}, ${body})`);
  } catch { /* o registo nunca trava a consola */ }
}

/** Grava (ou, com `externalId` desta conta, atualiza) uma chamada. */
async function saveCall(acc: Account, call: CentralCall, source: "sugar_v10" | "sugar_v4", raw: unknown, externalId?: string | null): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const rawJson = redactForLog(raw);
  if (externalId) {
    const ex = rowsOf(await db.execute(sql`SELECT id FROM central_calls WHERE externalId = ${externalId} AND accountId = ${acc.id} LIMIT 1`))[0];
    if (ex) {
      await db.execute(sql`UPDATE central_calls SET direction = ${call.direction}, held = ${call.held ? 1 : 0}, startedAt = ${utc(call.startedAtMs)},
          durationS = ${call.durationS}, phone = COALESCE(${call.phone}, phone), subject = COALESCE(${call.subject}, subject),
          description = COALESCE(${call.description}, description), rawJson = ${rawJson} WHERE id = ${Number(ex.id)}`);
      return externalId;
    }
  }
  // o id que a consola mandar só se aproveita se for um UUID ainda livre
  let id = externalId && /^[0-9a-f-]{36}$/i.test(externalId) ? externalId.toLowerCase() : randomUUID();
  if (externalId && rowsOf(await db.execute(sql`SELECT 1 AS x FROM central_calls WHERE externalId = ${id} LIMIT 1`)).length) id = randomUUID();
  await db.execute(sql`INSERT INTO central_calls (externalId, accountId, userId, direction, held, startedAt, durationS, phone, subject, description, source, rawJson, createdAt)
      VALUES (${id}, ${acc.id}, ${acc.userId}, ${call.direction}, ${call.held ? 1 : 0}, ${utc(call.startedAtMs)}, ${call.durationS}, ${call.phone},
              ${call.subject}, ${call.description}, ${source}, ${rawJson}, ${utc(Date.now())})`);
  return id;
}

// ─── Proteções ──────────────────────────────────────────────────────────────

const failures = new Map<string, { n: number; until: number }>();
const ipOf = (req: Request) => String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "?").split(",")[0].trim();
function blocked(req: Request): boolean {
  const f = failures.get(ipOf(req));
  return !!f && f.until > Date.now() && f.n >= FAIL_MAX;
}
function fail(req: Request) {
  const k = ipOf(req);
  const f = failures.get(k);
  const now = Date.now();
  failures.set(k, f && f.until > now ? { n: f.n + 1, until: f.until } : { n: 1, until: now + FAIL_WINDOW_MS });
}

async function centralEnabled(): Promise<boolean> {
  const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
  const read = () => isFeatureEnabled(CENTRAL_SUGAR_FLAG, { defaultEnabled: automationFlagDefault(CENTRAL_SUGAR_FLAG) });
  await ensureFeatureFlagOverrides();
  if (read()) return true;
  // 39b: desligado na cache (30 s por instância) → confirma na BD antes de recusar,
  // para quem acabou de ligar o interruptor não levar com "desligada"
  await ensureFeatureFlagOverrides(true);
  return read();
}

/** Login com utilizador + segredo (texto, ou md5 na v4_1). */
async function login(username: unknown, secret: unknown, isMd5: boolean): Promise<Account | null> {
  const u = normalizeCentralUsername(String(username ?? ""));
  const s = String(secret ?? "");
  if (!u || !s || (isMd5 && !/^[0-9a-f]{32}$/i.test(s))) return null;
  const acc = await accountByUsername(u);
  if (!acc || !sameHash(acc.secretHash, hashCentralSecret(s, isMd5))) return null;
  return acc;
}

function sugarUser(acc: Account) {
  return { id: `u${acc.userId}`, user_name: acc.username, full_name: acc.name ?? acc.username, type: "user", status: "Active", is_admin: false, preferences: { timezone: "Europe/Lisbon", datepref: "Y-m-d", timepref: "H:i" } };
}
const EMPTY_LIST = { next_offset: -1, records: [] as unknown[] };

// ─── Router ─────────────────────────────────────────────────────────────────

type Authed = Request & { centralAccount?: Account };

export function createCentralSugarRouter(): Router {
  const r = Router();
  r.use(express.json({ limit: "512kb" }));
  r.use(express.urlencoded({ limit: "512kb", extended: true }));

  // desligado → 503 (o pedido fica registado, para se ver que a consola chegou cá)
  r.use(async (req: Request, res: Response, next: NextFunction) => {
    let on = false;
    try { on = await centralEnabled(); } catch { on = false; }
    if (on) return next();
    await logRequest(req, 503, null, "interruptor desligado");
    res.status(503).json({ error: "service_unavailable", error_message: "A central da dashboard está desligada (Definições → Automações → Central Vodafone)." });
  });

  // ── v10 ──
  r.post("/rest/:ver/oauth2/token", async (req, res) => {
    const key = tokenKey();
    if (!key) { await logRequest(req, 503, null, "sem JWT_SECRET"); return res.status(503).json({ error: "service_unavailable", error_message: "Servidor sem segredo de sessão." }); }
    if (blocked(req)) { await logRequest(req, 429, null, "demasiadas tentativas"); return res.status(429).json({ error: "too_many_requests", error_message: "Demasiadas tentativas. Espera 10 minutos." }); }
    const b = (req.body ?? {}) as Record<string, unknown>;
    let acc: Account | null = null;
    if (b.grant_type === "refresh_token") {
      const id = verifyCentralToken(String(b.refresh_token ?? ""), "r", Date.now(), key);
      acc = id ? await accountById(id) : null;
    } else {
      acc = await login(b.username, b.password, false);
    }
    if (!acc) { fail(req); await logRequest(req, 401, null, `login falhado (${String(b.grant_type ?? "password")})`); return res.status(401).json({ error: "need_login", error_message: "You must specify a valid username and password." }); }
    const now = Date.now();
    await touch(acc.id);
    await logRequest(req, 200, acc.id, `login ${acc.username}`);
    res.json({
      access_token: signCentralToken(acc.id, "a", now + ACCESS_TTL_MS, key), expires_in: ACCESS_TTL_MS / 1000, token_type: "bearer", scope: null,
      refresh_token: signCentralToken(acc.id, "r", now + REFRESH_TTL_MS, key), refresh_expires_in: REFRESH_TTL_MS / 1000, download_token: randomUUID(),
    });
  });

  const auth = async (req: Authed, res: Response, next: NextFunction) => {
    const key = tokenKey();
    const raw = String(req.headers["oauth-token"] ?? "") || String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const id = key && raw ? verifyCentralToken(raw, "a", Date.now(), key) : null;
    const acc = id ? await accountById(id) : null;
    // 39b: as mesmas respostas de um Sugar verdadeiro (sem token → need_login; token mau/expirado → invalid_grant)
    if (!acc && !raw) { await logRequest(req, 401, null, "sem token (precisa de login)"); return res.status(401).json({ error: "need_login", error_message: "No valid authentication for user." }); }
    if (!acc) { await logRequest(req, 401, null, "token inválido ou expirado"); return res.status(401).json({ error: "invalid_grant", error_message: "The access token provided is invalid." }); }
    req.centralAccount = acc;
    next();
  };

  r.post("/rest/:ver/oauth2/logout", async (req, res) => { await logRequest(req, 200, null, "logout"); res.json({ success: true }); });
  r.get("/rest/:ver/ping", auth, async (req: Authed, res) => { await logRequest(req, 200, req.centralAccount!.id, null); res.json("pong"); });
  r.get("/rest/:ver/me", auth, async (req: Authed, res) => {
    await logRequest(req, 200, req.centralAccount!.id, null);
    res.json({ current_user: sugarUser(req.centralAccount!) });
  });

  r.post("/rest/:ver/Calls", auth, async (req: Authed, res) => {
    const acc = req.centralAccount!;
    const fields = (req.body ?? {}) as Record<string, unknown>;
    try {
      const id = await saveCall(acc, parseSugarCall(fields, Date.now()), "sugar_v10", fields, typeof fields.id === "string" ? fields.id : null);
      await logRequest(req, 200, acc.id, `chamada ${id}`);
      res.json({ ...fields, id, _module: "Calls", assigned_user_id: `u${acc.userId}`, date_entered: new Date().toISOString() });
    } catch (e: any) {
      await logRequest(req, 500, acc.id, `erro: ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(500).json({ error: "fatal_error", error_message: "Não foi possível guardar a chamada." });
    }
  });
  r.put("/rest/:ver/Calls/:id", auth, async (req: Authed, res) => {
    const acc = req.centralAccount!;
    const fields = (req.body ?? {}) as Record<string, unknown>;
    try {
      const id = await saveCall(acc, parseSugarCall(fields, Date.now()), "sugar_v10", fields, req.params.id);
      await logRequest(req, 200, acc.id, `chamada ${id} (alterada)`);
      res.json({ ...fields, id, _module: "Calls" });
    } catch (e: any) {
      await logRequest(req, 500, acc.id, `erro: ${String(e?.message ?? e).slice(0, 200)}`);
      res.status(500).json({ error: "fatal_error", error_message: "Não foi possível guardar a chamada." });
    }
  });
  r.get("/rest/:ver/Calls/:id", auth, async (req: Authed, res) => {
    const db = await getDb();
    const row = db ? rowsOf(await db.execute(sql`SELECT externalId, direction, held, startedAt, durationS, subject, description FROM central_calls
        WHERE externalId = ${req.params.id} AND accountId = ${req.centralAccount!.id} LIMIT 1`))[0] : null;
    await logRequest(req, row ? 200 : 404, req.centralAccount!.id, null);
    if (!row) return res.status(404).json({ error: "not_found", error_message: "Chamada não encontrada." });
    const d = Number(row.durationS ?? 0);
    res.json({ id: row.externalId, _module: "Calls", name: row.subject, description: row.description, direction: row.direction === "out" ? "Outbound" : "Inbound",
      status: Number(row.held) ? "Held" : "Not Held", date_start: `${String(row.startedAt).replace(" ", "T")}Z`, duration_hours: Math.floor(d / 3600), duration_minutes: Math.floor((d % 3600) / 60) });
  });
  r.post("/rest/:ver/Calls/:id/link/:rel/:relId", auth, async (req: Authed, res) => {
    await logRequest(req, 200, req.centralAccount!.id, `ligar a ${req.params.rel}`);
    res.json({ record: { id: req.params.id, _module: "Calls" }, related_record: { id: req.params.relId } });
  });

  // pesquisas (Contacts, Accounts, Leads, search, globalsearch…): por agora sem resultados — fica registado o que procurou
  r.all("/rest/:ver/*", auth, async (req: Authed, res) => {
    await logRequest(req, 200, req.centralAccount!.id, "sem tratamento (resposta vazia)");
    res.json(req.method === "GET" ? EMPTY_LIST : {});
  });

  // ── v4_1 ──
  r.all("/service/:ver/rest.php", async (req, res) => {
    const src = { ...(req.query as Record<string, unknown>), ...((req.body ?? {}) as Record<string, unknown>) };
    const method = String(src.method ?? "");
    let data: any = src.rest_data ?? {};
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = {}; } }
    const key = tokenKey();
    if (!key) { await logRequest(req, 503, null, "sem JWT_SECRET"); return res.status(503).json({ name: "Server error", description: "Servidor sem segredo de sessão." }); }
    const sessionAcc = async (): Promise<Account | null> => {
      const s = Array.isArray(data) ? data[0] : data?.session;
      const id = verifyCentralToken(String(s ?? ""), "a", Date.now(), key);
      return id ? accountById(id) : null;
    };

    if (method === "login") {
      if (blocked(req)) { await logRequest(req, 429, null, "v4 demasiadas tentativas"); return res.status(429).json({ name: "Invalid Login", number: 10, description: "Demasiadas tentativas." }); }
      const ua = (Array.isArray(data) ? data[0] : data?.user_auth) ?? {};
      const pass = String(ua.password ?? "");
      const isMd5 = /^[0-9a-f]{32}$/i.test(pass) && String(ua.encryption ?? "").toUpperCase() !== "PLAIN";
      const acc = await login(ua.user_name, pass, isMd5);
      if (!acc) { fail(req); await logRequest(req, 200, null, "v4 login falhado"); return res.json({ name: "Invalid Login", number: 10, description: "Login attempt failed please check the username and password" }); }
      await touch(acc.id);
      await logRequest(req, 200, acc.id, `v4 login ${acc.username}`);
      return res.json({ id: signCentralToken(acc.id, "a", Date.now() + ACCESS_TTL_MS, key), module_name: "Users",
        name_value_list: { user_id: { name: "user_id", value: `u${acc.userId}` }, user_name: { name: "user_name", value: acc.username }, user_language: { name: "user_language", value: "pt_PT" } } });
    }
    if (method === "get_server_info") { await logRequest(req, 200, null, "v4 get_server_info"); return res.json({ flavor: "CE", version: "7.11.0", gmt_time: utc(Date.now()) }); }
    if (method === "logout") { await logRequest(req, 200, null, "v4 logout"); return res.json(null); }

    const acc = await sessionAcc();
    if (!acc) { await logRequest(req, 200, null, `v4 ${method || "?"} sem sessão`); return res.json({ name: "Invalid Session ID", number: 11, description: "The session ID is invalid" }); }
    if (method === "get_user_id") { await logRequest(req, 200, acc.id, "v4 get_user_id"); return res.json(`u${acc.userId}`); }
    if (method === "set_entry" && String(data?.module_name ?? (Array.isArray(data) ? data[1] : "")) === "Calls") {
      const fields = flattenNameValueList(Array.isArray(data) ? data[2] : data?.name_value_list);
      try {
        const id = await saveCall(acc, parseSugarCall(fields, Date.now()), "sugar_v4", fields, typeof fields.id === "string" ? fields.id : null);
        await logRequest(req, 200, acc.id, `v4 chamada ${id}`);
        return res.json({ id, entry_list: fields });
      } catch (e: any) {
        await logRequest(req, 500, acc.id, `v4 erro: ${String(e?.message ?? e).slice(0, 200)}`);
        return res.status(500).json({ name: "Server error", description: "Não foi possível guardar a chamada." });
      }
    }
    await logRequest(req, 200, acc.id, `v4 ${method || "?"} sem tratamento (resposta vazia)`);
    if (method === "search_by_module") return res.json({ entry_list: [] });
    if (method === "get_entry_list") return res.json({ result_count: 0, total_count: "0", next_offset: 0, entry_list: [], relationship_list: [] });
    return res.json({});
  });

  r.all("*", async (req, res) => { await logRequest(req, 404, null, "caminho desconhecido"); res.status(404).json({ error: "not_found", error_message: "Caminho desconhecido." }); });
  return r;
}
