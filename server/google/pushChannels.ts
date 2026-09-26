/**
 * Canais de notificação da Google (regras puras em shared/googlePush.ts):
 *
 *  - Calendário: events.watch no calendário "Multipark" de cada pessoa (com
 *    a conta dela) e nos calendários partilhados da escala (conta de serviço
 *    com delegação); Drive: changes.watch no Shared Drive das pastas da base
 *    de conhecimento (delegação). Endereço: `${APP_URL}/api/google/push`;
 *  - segurança do webhook público: cada canal tem um segredo aleatório (32
 *    bytes) enviado pela Google em X-Goog-Channel-Token; guardamos só o
 *    SHA-256 e comparamos em tempo constante, junto com o id do canal (nosso
 *    uuid) e o X-Goog-Resource-ID devolvido pela Google. Canal desconhecido,
 *    segredo errado ou recurso diferente → recusado sem efeitos;
 *  - a notificação só marca o âmbito como "pendente" e responde logo; a
 *    sincronização incremental (syncToken / pageToken) corre em segundo plano
 *    (server/google/pendingSync.ts);
 *  - expiração ≤ 7 dias → google-watch-renew (1×/dia): cria os que faltam,
 *    renova os que expiram nas próximas 48 h (novo canal primeiro, depois
 *    pára o antigo) e pára os órfãos (conta desligada, cidade desligada, …).
 * Só em produção (VERCEL_ENV=production ou servidor próprio) e com um
 * APP_URL https público; GOOGLE_PUSH_DISABLED=1 desliga tudo.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import {
  WATCH_TTL_SECONDS, WATCH_SCOPE_LABEL, channelHealth, isStaleMessage, parsePushHeaders, planWatchReconcile, pushChannelsAllowed, pushNeedsSync,
  pushWebhookUrl, type DesiredWatch, type WatchChannelRow, type WatchKind,
} from "../../shared/googlePush";
import { DWD_CALENDAR_SCOPES, SHARED_CALENDAR_CITIES, toSqlUtc } from "../../shared/googleSync";
import { DWD_DRIVE_SCOPES } from "../../shared/drive";
import { hasFeatureScopes } from "../../shared/mail";
import { appOrigin, delegatedClient, dwdConfigured, googleErrorMessage, httpStatusOf } from "./workspace";
import { calendarFor, wrapCalendar, withGoogleRetry, type CalendarApiLike } from "./apis";
import { affected, db, rowsOf } from "./syncStore";

// ─── Segredo do canal ───────────────────────────────────────────────────────

/** SHA-256 (hex) do segredo do canal — o que fica na BD. */
export function hashChannelToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Id + segredo novos (o segredo em claro só vai para a Google). */
export function newChannelSecret(): { id: string; token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { id: crypto.randomUUID(), token, tokenHash: hashChannelToken(token) };
}

/** O segredo recebido corresponde ao hash guardado? (tempo constante) */
export function channelTokenMatches(token: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashChannelToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── BD ─────────────────────────────────────────────────────────────────────

const toMs = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};

const toRow = (r: any): WatchChannelRow & { notifications: number } => ({
  id: String(r.id), kind: r.kind === "drive" ? "drive" : "calendar", scopeKey: String(r.scopeKey), resourceKey: r.resourceKey ?? null,
  userId: r.userId == null ? null : Number(r.userId), resourceId: r.resourceId ?? null, expiration: toMs(r.expiration),
  lastNotifiedAt: toMs(r.lastNotifiedAt), lastError: r.lastError ?? null, createdAt: toMs(r.createdAt), notifications: Number(r.notifications ?? 0),
});

export async function loadChannels(scopeKey?: string): Promise<Array<WatchChannelRow & { notifications: number }>> {
  const d = await db();
  const where = scopeKey ? sql`WHERE scopeKey = ${scopeKey}` : sql``;
  return rowsOf(await d.execute(sql`SELECT id, kind, scopeKey, resourceKey, userId, resourceId, expiration, lastNotifiedAt, notifications, lastError, createdAt
    FROM google_watch_channels ${where} ORDER BY scopeKey, expiration DESC LIMIT 2000`)).map(toRow);
}

async function deleteChannelRow(id: string): Promise<void> {
  const d = await db();
  await d.execute(sql`DELETE FROM google_watch_channels WHERE id = ${id}`);
}

// ─── Webhook ────────────────────────────────────────────────────────────────

/** Âmbito da fila "pendente" que uma notificação deste canal acorda. */
export function pendingKeyForChannel(c: Pick<WatchChannelRow, "kind" | "scopeKey">): string | null {
  if (c.kind === "drive") return c.scopeKey === "drive:kb" ? "drive:kb" : null;
  const u = /^user:(\d+)$/.exec(c.scopeKey);
  if (u) return `user-cal:${u[1]}`;
  if (/^shared:[a-z]{2,16}$/.test(c.scopeKey)) return c.scopeKey;
  return null;
}

export interface PushOutcome { status: 200 | 400 | 401 | 404; key: string | null }

/**
 * Trata uma notificação (só cabeçalhos; o corpo vem vazio). Nada é escrito
 * antes de o canal, o segredo e o recurso baterem certo. Devolve a chave a
 * sincronizar (a rota responde logo e corre-a em segundo plano).
 */
export async function handleGooglePush(headers: Record<string, unknown>, now = Date.now()): Promise<PushOutcome> {
  const h = parsePushHeaders(headers);
  if (!h) return { status: 400, key: null };
  const d = await db();
  const r = rowsOf(await d.execute(sql`SELECT id, kind, scopeKey, resourceId, tokenHash, lastMessageNumber, expiration
    FROM google_watch_channels WHERE id = ${h.channelId} LIMIT 1`))[0];
  if (!r) return { status: 404, key: null };
  if (!channelTokenMatches(h.token, r.tokenHash ?? null)) return { status: 401, key: null };
  // O resourceId só é conhecido depois da resposta do watch (o "sync" inicial pode chegar antes).
  if (r.resourceId && String(r.resourceId) !== h.resourceId) return { status: 401, key: null };
  const exp = toMs(r.expiration);
  if (exp != null && exp <= now) return { status: 404, key: null };
  if (!pushNeedsSync(h.resourceState)) return { status: 200, key: null };
  const last = r.lastMessageNumber == null ? null : Number(r.lastMessageNumber);
  if (isStaleMessage(h.messageNumber, last)) return { status: 200, key: null };
  const res = await d.execute(sql`UPDATE google_watch_channels
    SET lastNotifiedAt = ${toSqlUtc(now)}, notifications = notifications + 1
      ${h.messageNumber != null ? sql`, lastMessageNumber = ${h.messageNumber}` : sql``}
    WHERE id = ${h.channelId}${h.messageNumber != null ? sql` AND (lastMessageNumber IS NULL OR lastMessageNumber < ${h.messageNumber})` : sql``}`);
  if (affected(res) !== 1) return { status: 200, key: null }; // outra entrega da mesma mensagem ganhou
  return { status: 200, key: pendingKeyForChannel({ kind: r.kind === "drive" ? "drive" : "calendar", scopeKey: String(r.scopeKey) }) };
}

// ─── Criar / parar ──────────────────────────────────────────────────────────

/** Endereço do webhook, ou o motivo de não haver canais neste ambiente. */
export function pushTarget(env: Record<string, string | undefined> = process.env): { url: string | null; reason: string | null } {
  if (!pushChannelsAllowed(env)) {
    return { url: null, reason: String(env.GOOGLE_PUSH_DISABLED ?? "").trim() === "1" ? "Desligado (GOOGLE_PUSH_DISABLED=1)." : "Só em produção (este ambiente não cria canais)." };
  }
  const url = pushWebhookUrl(appOrigin(env as any));
  return url ? { url, reason: null } : { url: null, reason: "APP_URL tem de ser o domínio público https (ex.: https://dashboard.multipark.pt)." };
}

interface ScopeApis { calendar?: CalendarApiLike; drive?: import("@googleapis/drive").drive_v3.Drive }

async function sharedCalendarApi(deadlineAt: number): Promise<CalendarApiLike | null> {
  const { loadSharedCalendarsConfig } = await import("./syncService");
  const cfg = await loadSharedCalendarsConfig();
  if (!cfg.enabled || !cfg.ownerEmail || !dwdConfigured()) return null;
  return wrapCalendar(calendarFor(delegatedClient(cfg.ownerEmail, DWD_CALENDAR_SCOPES)), { deadlineAt });
}

async function userCalendarApi(userId: number, deadlineAt: number): Promise<CalendarApiLike> {
  const { userGoogleAuth } = await import("./userAccounts");
  const { client } = await userGoogleAuth(userId, "calendar");
  return wrapCalendar(calendarFor(client), { deadlineAt });
}

async function sharedDriveClient(): Promise<import("@googleapis/drive").drive_v3.Drive | null> {
  const { loadDriveConfig } = await import("./driveService");
  const cfg = await loadDriveConfig();
  if (!cfg.sharedEnabled || !cfg.ownerEmail || !dwdConfigured()) return null;
  const { driveFor } = await import("./driveApi");
  return driveFor(delegatedClient(cfg.ownerEmail, DWD_DRIVE_SCOPES));
}

async function apisFor(c: { kind: WatchKind; scopeKey: string; userId: number | null }, deadlineAt: number, cache: Map<string, ScopeApis>): Promise<ScopeApis> {
  const k = c.kind === "drive" ? "drive" : c.scopeKey.startsWith("shared:") ? "shared" : `user:${c.userId}`;
  const hit = cache.get(k);
  if (hit) return hit;
  let v: ScopeApis = {};
  if (c.kind === "drive") v = { drive: (await sharedDriveClient()) ?? undefined };
  else if (c.scopeKey.startsWith("shared:")) v = { calendar: (await sharedCalendarApi(deadlineAt)) ?? undefined };
  else if (c.userId != null) v = { calendar: await userCalendarApi(c.userId, deadlineAt) };
  cache.set(k, v);
  return v;
}

/** Cria um canal (linha primeiro — a Google manda logo um "sync" —, depois o watch). */
export async function createChannel(want: DesiredWatch, o: { deadlineAt: number; apis?: ScopeApis; cache?: Map<string, ScopeApis>; now?: number }): Promise<WatchChannelRow> {
  const target = pushTarget();
  if (!target.url) throw new Error(target.reason ?? "Sem endereço para as notificações.");
  const apis = o.apis ?? (await apisFor(want, o.deadlineAt, o.cache ?? new Map()));
  const { id, token, tokenHash } = newChannelSecret();
  const d = await db();
  await d.execute(sql`INSERT INTO google_watch_channels (id, kind, scopeKey, resourceKey, userId, tokenHash)
    VALUES (${id}, ${want.kind}, ${want.scopeKey}, ${want.resourceKey.slice(0, 255)}, ${want.userId}, ${tokenHash})`);
  try {
    let resourceId = "";
    let expiration: number | null = null;
    if (want.kind === "calendar") {
      if (!apis.calendar?.watchEvents) throw new Error("Calendário sem acesso para notificações.");
      const r = await apis.calendar.watchEvents(want.resourceKey, { id, address: target.url, token, ttlSeconds: WATCH_TTL_SECONDS });
      resourceId = r.resourceId;
      expiration = r.expiration;
    } else {
      const drive = apis.drive;
      if (!drive) throw new Error("Shared Drive sem acesso para notificações.");
      const { kbChangesPageToken } = await import("../knowledge/driveChanges");
      const { token: pageToken } = await kbChangesPageToken({
        driveId: want.resourceKey,
        startPageToken: async () => String((await drive.changes.getStartPageToken({ driveId: want.resourceKey, supportsAllDrives: true })).data.startPageToken ?? ""),
      });
      const res = await withGoogleRetry(() => drive.changes.watch({
        pageToken, driveId: want.resourceKey, supportsAllDrives: true, includeItemsFromAllDrives: true, includeRemoved: true,
        requestBody: { id, type: "web_hook", address: target.url!, token, expiration: String((o.now ?? Date.now()) + WATCH_TTL_SECONDS * 1000) },
      }), { deadlineAt: o.deadlineAt });
      resourceId = String(res.data.resourceId ?? "");
      const exp = Number(res.data.expiration ?? NaN);
      expiration = Number.isFinite(exp) ? exp : null;
    }
    if (!resourceId) throw new Error("A Google não devolveu o recurso do canal.");
    await d.execute(sql`UPDATE google_watch_channels SET resourceId = ${resourceId.slice(0, 255)},
      expiration = ${expiration != null ? toSqlUtc(expiration) : null}, lastError = NULL WHERE id = ${id}`);
    return { id, kind: want.kind, scopeKey: want.scopeKey, resourceKey: want.resourceKey, userId: want.userId, resourceId, expiration, lastNotifiedAt: null, lastError: null, createdAt: Date.now() };
  } catch (err) {
    await deleteChannelRow(id).catch(() => {});
    throw err;
  }
}

/** Pára um canal na Google (melhor esforço) e apaga a linha. */
export async function stopChannel(c: WatchChannelRow, o: { deadlineAt: number; cache?: Map<string, ScopeApis> }): Promise<void> {
  try {
    if (c.resourceId) {
      const apis = await apisFor(c, o.deadlineAt, o.cache ?? new Map());
      if (c.kind === "calendar" && apis.calendar?.stopChannel) await apis.calendar.stopChannel(c.id, c.resourceId);
      else if (c.kind === "drive" && apis.drive) {
        const drive = apis.drive;
        await withGoogleRetry(() => drive.channels.stop({ requestBody: { id: c.id, resourceId: c.resourceId! } }), { deadlineAt: o.deadlineAt })
          .catch((err) => { if (![404, 410].includes(httpStatusOf(err) ?? 0)) throw err; });
      }
    }
  } catch { /* conta desligada / sem acesso: o canal expira sozinho e as notificações dão 404 */ }
  await deleteChannelRow(c.id);
}

// ─── Garantir um canal (depois de uma sincronização) ────────────────────────

const FAIL_KEY = (scopeKey: string) => `watch:fail:${scopeKey}`.slice(0, 64);
const FAIL_BACKOFF_MS = 6 * 3600_000;

/**
 * Depois de sincronizar um calendário: se ainda não há canal válido para ele,
 * cria-o (a renovação diária trata do resto). Uma falha espera 6 h antes de
 * voltar a tentar. Nunca lança.
 */
export async function ensureWatch(want: DesiredWatch, o: { deadlineAt: number; apis?: ScopeApis }): Promise<void> {
  try {
    if (!pushTarget().url || Date.now() > o.deadlineAt - 3_000) return;
    const now = Date.now();
    const live = (await loadChannels(want.scopeKey)).filter((c) => c.kind === want.kind && c.resourceKey === want.resourceKey && c.expiration != null && c.expiration > now);
    if (live.length) return;
    const { getDriveState, setDriveState } = await import("./driveService");
    const failedAt = Number(await getDriveState(FAIL_KEY(want.scopeKey))) || 0;
    if (now - failedAt < FAIL_BACKOFF_MS) return;
    try {
      await createChannel(want, { deadlineAt: o.deadlineAt, apis: o.apis });
      if (failedAt) await setDriveState(FAIL_KEY(want.scopeKey), null);
    } catch (err) {
      await setDriveState(FAIL_KEY(want.scopeKey), String(now)).catch(() => {});
      console.warn("[google-push] canal não criado:", want.scopeKey, googleErrorMessage(err).slice(0, 160));
    }
  } catch { /* nunca parte a sincronização */ }
}

// ─── O que vigiar ───────────────────────────────────────────────────────────

export async function desiredWatches(deadlineAt: number): Promise<{ list: DesiredWatch[]; errors: string[] }> {
  const d = await db();
  const list: DesiredWatch[] = [];
  const errors: string[] = [];
  // Calendário "Multipark" de cada pessoa ativa com o Calendário autorizado.
  const users = rowsOf(await d.execute(sql`SELECT s.userId, s.calendarId, g.scopes FROM google_sync_state s
    JOIN google_user_accounts g ON g.userId = s.userId JOIN users u ON u.id = s.userId
    WHERE s.calendarId IS NOT NULL AND g.status = 'connected' AND g.refreshTokenEnc IS NOT NULL AND COALESCE(u.isActive, 1) = 1 LIMIT 1000`));
  for (const u of users) {
    if (!hasFeatureScopes(String(u.scopes ?? ""), "calendar")) continue;
    list.push({ kind: "calendar", scopeKey: `user:${Number(u.userId)}`, resourceKey: String(u.calendarId), userId: Number(u.userId) });
  }
  // Calendários partilhados da escala (cidades ligadas, da conta dona atual).
  const { loadSharedCalendarsConfig } = await import("./syncService");
  const cfg = await loadSharedCalendarsConfig();
  if (cfg.enabled && dwdConfigured()) {
    const rows = rowsOf(await d.execute(sql`SELECT city, ownerEmail, calendarId FROM google_shared_calendars WHERE calendarId IS NOT NULL`));
    for (const r of rows) {
      const city = String(r.city);
      if (!(SHARED_CALENDAR_CITIES as readonly string[]).includes(city) || !cfg.cities[city as keyof typeof cfg.cities] || String(r.ownerEmail) !== cfg.ownerEmail) continue;
      list.push({ kind: "calendar", scopeKey: `shared:${city}`, resourceKey: String(r.calendarId), userId: null });
    }
  }
  // Shared Drive das pastas da base de conhecimento.
  try {
    const { loadKnowledgeConfig } = await import("../knowledge/sync");
    const kcfg = await loadKnowledgeConfig();
    if (kcfg.driveEnabled && kcfg.folders.length) {
      const { kbDriveApi } = await import("../knowledge/drive");
      const kb = await kbDriveApi(deadlineAt);
      if (kb) list.push({ kind: "drive", scopeKey: "drive:kb", resourceKey: kb.driveId, userId: null });
    }
  } catch (err) { errors.push(`Drive (base de conhecimento): ${googleErrorMessage(err)}`); }
  return { list, errors };
}

// ─── Renovação diária (google-watch-renew) ──────────────────────────────────

export interface WatchRenewReport {
  ok: boolean;
  done: boolean;
  skipped: string | null;
  desired: number;
  created: number;
  stopped: number;
  forgotten: number;
  errors: string[];
}

export async function renewWatchChannels(opts: { deadlineAt: number; now?: number }): Promise<WatchRenewReport> {
  const report: WatchRenewReport = { ok: true, done: true, skipped: null, desired: 0, created: 0, stopped: 0, forgotten: 0, errors: [] };
  const target = pushTarget();
  if (!target.url) { report.skipped = target.reason; return report; }
  try {
    const now = opts.now ?? Date.now();
    const want = await desiredWatches(opts.deadlineAt);
    report.errors.push(...want.errors);
    report.desired = want.list.length;
    const plan = planWatchReconcile(want.list, await loadChannels(), now);
    for (const c of plan.forget) { await deleteChannelRow(c.id); report.forgotten++; }
    const cache = new Map<string, ScopeApis>();
    const renewedScopes = new Set<string>();
    for (const w of plan.create) {
      if (Date.now() > opts.deadlineAt - 5_000) { report.done = false; break; }
      try {
        await createChannel(w, { deadlineAt: opts.deadlineAt, cache, now });
        report.created++;
        renewedScopes.add(`${w.kind}|${w.scopeKey}`);
      } catch (err) {
        const msg = googleErrorMessage(err);
        // Conta por religar / sem âmbito → aviso da própria pessoa, não falha do trabalho.
        if (w.userId == null) report.errors.push(`${WATCH_SCOPE_LABEL(w.scopeKey)}: ${msg}`);
        const d = await db();
        await d.execute(sql`UPDATE google_watch_channels SET lastError = ${msg.slice(0, 500)} WHERE scopeKey = ${w.scopeKey}`).catch(() => {});
      }
    }
    // Pára os antigos: órfãos sempre; os que estavam a expirar só se o novo já existe.
    for (const c of plan.stop) {
      if (Date.now() > opts.deadlineAt - 3_000) { report.done = false; break; }
      const wanted = want.list.some((w) => w.kind === c.kind && w.scopeKey === c.scopeKey && w.resourceKey === c.resourceKey);
      if (wanted && !renewedScopes.has(`${c.kind}|${c.scopeKey}`) && (c.expiration ?? 0) > Date.now()) {
        // Renovação falhou: o antigo continua até expirar (duplicados com outro válido param).
        const others = (await loadChannels(c.scopeKey)).filter((x) => x.id !== c.id && (x.expiration ?? 0) > (c.expiration ?? 0));
        if (!others.length) continue;
      }
      await stopChannel(c, { deadlineAt: opts.deadlineAt, cache });
      report.stopped++;
    }
  } catch (err) {
    report.errors.push(googleErrorMessage(err));
  }
  report.ok = report.errors.length === 0;
  return report;
}

// ─── Estado (Definições e Perfil) ───────────────────────────────────────────

export async function pushStatusSummary(now = Date.now()) {
  const target = pushTarget();
  let channels: Array<WatchChannelRow & { notifications: number }> = [];
  let pending = 0;
  let pendingErrors: Array<{ scopeKey: string; attempts: number; lastError: string | null }> = [];
  try {
    channels = await loadChannels();
    const d = await db();
    pending = Number(rowsOf(await d.execute(sql`SELECT COUNT(*) AS n FROM google_sync_pending`))[0]?.n ?? 0);
    pendingErrors = rowsOf(await d.execute(sql`SELECT scopeKey, attempts, lastError FROM google_sync_pending WHERE attempts > 0 ORDER BY attempts DESC LIMIT 10`))
      .map((r) => ({ scopeKey: String(r.scopeKey), attempts: Number(r.attempts ?? 0), lastError: r.lastError ?? null }));
  } catch { /* tabelas por criar */ }
  const personal = channels.filter((c) => c.scopeKey.startsWith("user:"));
  const count = (xs: WatchChannelRow[], h: string) => xs.filter((c) => channelHealth(c, now) === h).length;
  return {
    webhookUrl: target.url,
    disabledReason: target.reason,
    shared: channels.filter((c) => !c.scopeKey.startsWith("user:")).map((c) => ({
      id: c.id.slice(0, 8), scopeKey: c.scopeKey, label: WATCH_SCOPE_LABEL(c.scopeKey), kind: c.kind, health: channelHealth(c, now),
      expiration: c.expiration, lastNotifiedAt: c.lastNotifiedAt, notifications: c.notifications, lastError: c.lastError,
    })),
    personal: { active: count(personal, "active"), expiring: count(personal, "expiring"), expired: count(personal, "expired"), lastNotifiedAt: personal.reduce<number | null>((m, c) => (c.lastNotifiedAt != null && (m == null || c.lastNotifiedAt > m) ? c.lastNotifiedAt : m), null) },
    pending,
    pendingErrors,
  };
}

/** Estado do canal do calendário da própria pessoa (Perfil → Google). */
export async function userPushStatus(userId: number, now = Date.now()) {
  const target = pushTarget();
  try {
    const chans = await loadChannels(`user:${userId}`);
    const best = chans.sort((a, b) => (b.expiration ?? 0) - (a.expiration ?? 0))[0] ?? null;
    const d = await db();
    const s = rowsOf(await d.execute(sql`SELECT lastOnlineSyncAt FROM google_sync_state WHERE userId = ${userId} LIMIT 1`))[0];
    return {
      enabled: !!target.url,
      calendar: best ? { health: channelHealth(best, now), expiration: best.expiration, lastNotifiedAt: best.lastNotifiedAt } : null,
      lastOnlineSyncAt: toMs(s?.lastOnlineSyncAt),
    };
  } catch {
    return { enabled: !!target.url, calendar: null, lastOnlineSyncAt: null };
  }
}
