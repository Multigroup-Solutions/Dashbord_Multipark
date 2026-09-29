/**
 * Google por eventos (shared/googlePush.ts, server/google/pushChannels.ts,
 * server/google/pendingSync.ts): segredo dos canais, cabeçalhos do webhook,
 * plano de renovação, heartbeat limitado por pessoa, fila "sincronizar já" e
 * cadência no agendador.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({ exec: null as null | ((q: { sql: string; params: unknown[] }) => unknown) }));
vi.mock("./google/syncStore", async (orig) => {
  const real = await orig<any>();
  const { MySqlDialect: D } = await import("drizzle-orm/mysql-core");
  const dialect = new D();
  return {
    ...real,
    db: async () => ({ execute: async (q: any) => h.exec!(dialect.sqlToQuery(q)) }),
    ensureStateRow: async () => undefined,
  };
});

import {
  GOOGLE_PUSH_PATH, HEARTBEAT_MIN_GAP_MS, PENDING_MAX_ATTEMPTS, channelHealth, clientHeartbeatDue, heartbeatDue, isStaleMessage, parsePendingKey,
  parsePushHeaders, pendingBackoffMs, pendingKey, planWatchReconcile, pushChannelsAllowed, pushNeedsSync, pushWebhookUrl,
  type DesiredWatch, type WatchChannelRow,
} from "../shared/googlePush";
import { channelTokenMatches, handleGooglePush, hashChannelToken, newChannelSecret, pendingKeyForChannel, pushTarget } from "./google/pushChannels";
import { drainPending, markPending, onlineHeartbeat } from "./google/pendingSync";
import { TICK_JOBS, describeCadence } from "./cronSchedule";
import { CRON_JOBS } from "../shared/appSettings";
import { MIGRATION_0200_STATEMENTS } from "./migrations/migration_0200";

void MySqlDialect;
const root = resolve(__dirname, "..");
const ok = (n = 1) => [{ affectedRows: n }];
const rows = (r: unknown[]) => [r];

// ─── Segredo do canal ───────────────────────────────────────────────────────

describe("segredo do canal (X-Goog-Channel-Token)", () => {
  it("guarda só o SHA-256 e compara em tempo constante", () => {
    const s = newChannelSecret();
    expect(s.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.tokenHash).toBe(hashChannelToken(s.token));
    expect(s.tokenHash).not.toContain(s.token);
    expect(channelTokenMatches(s.token, s.tokenHash)).toBe(true);
    expect(channelTokenMatches(s.token + "x", s.tokenHash)).toBe(false);
    expect(channelTokenMatches(newChannelSecret().token, s.tokenHash)).toBe(false);
  });
  it("hash vazio/estragado nunca aceita", () => {
    const s = newChannelSecret();
    expect(channelTokenMatches(s.token, null)).toBe(false);
    expect(channelTokenMatches(s.token, "")).toBe(false);
    expect(channelTokenMatches(s.token, s.tokenHash.slice(0, 63))).toBe(false);
    expect(channelTokenMatches(s.token, s.tokenHash.toUpperCase())).toBe(false);
  });
  it("id e segredo novos passam na validação dos cabeçalhos e são únicos", () => {
    const a = newChannelSecret();
    const b = newChannelSecret();
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    expect(parsePushHeaders({ "x-goog-channel-id": a.id, "x-goog-channel-token": a.token, "x-goog-resource-id": "abc", "x-goog-resource-state": "exists" })).not.toBeNull();
  });
});

describe("cabeçalhos da notificação", () => {
  const base = { "x-goog-channel-id": "0f7c9a52-1b2c-4d5e-8f90-123456789abc", "x-goog-channel-token": "a".repeat(43), "x-goog-resource-id": "ret08u3rv24htgh289g", "x-goog-resource-state": "exists", "x-goog-message-number": "12" };
  it("lê os X-Goog-*", () => {
    expect(parsePushHeaders(base)).toEqual({ channelId: base["x-goog-channel-id"], token: "a".repeat(43), resourceId: "ret08u3rv24htgh289g", resourceState: "exists", messageNumber: 12 });
  });
  it("recusa o que está fora do formato (sem tocar na BD)", () => {
    for (const k of Object.keys(base)) {
      if (k === "x-goog-message-number") continue;
      expect(parsePushHeaders({ ...base, [k]: "" }), k).toBeNull();
    }
    expect(parsePushHeaders({ ...base, "x-goog-channel-id": "x'; DROP TABLE" })).toBeNull();
    expect(parsePushHeaders({ ...base, "x-goog-channel-token": "curto" })).toBeNull();
    expect(parsePushHeaders({ ...base, "x-goog-channel-token": "a".repeat(300) })).toBeNull();
    expect(parsePushHeaders({ ...base, "x-goog-message-number": "1e9" })).toBeNull();
  });
  it("'sync' é só o aperto de mão; reenvios ignorados", () => {
    expect(pushNeedsSync("sync")).toBe(false);
    expect(pushNeedsSync("exists")).toBe(true);
    expect(pushNeedsSync("change")).toBe(true);
    expect(isStaleMessage(5, 5)).toBe(true);
    expect(isStaleMessage(4, 5)).toBe(true);
    expect(isStaleMessage(6, 5)).toBe(false);
    expect(isStaleMessage(null, 5)).toBe(false);
    expect(isStaleMessage(3, null)).toBe(false);
  });
});

describe("endereço do webhook", () => {
  it("só https público (nunca pré-visualizações do Vercel nem localhost)", () => {
    expect(pushWebhookUrl("https://dashboard.multipark.pt")).toBe(`https://dashboard.multipark.pt${GOOGLE_PUSH_PATH}`);
    expect(pushWebhookUrl("https://dashboard.multipark.pt/")).toBe("https://dashboard.multipark.pt/api/google/push");
    expect(pushWebhookUrl("http://dashboard.multipark.pt")).toBeNull();
    expect(pushWebhookUrl("https://dashbord-multipark-git-x.vercel.app")).toBeNull();
    expect(pushWebhookUrl("https://localhost:3000")).toBeNull();
    expect(pushWebhookUrl("https://127.0.0.1")).toBeNull();
    expect(pushWebhookUrl("")).toBeNull();
    expect(pushWebhookUrl("não é url")).toBeNull();
  });
  it("só produção cria canais; GOOGLE_PUSH_DISABLED=1 desliga", () => {
    expect(pushChannelsAllowed({ VERCEL_ENV: "production" })).toBe(true);
    expect(pushChannelsAllowed({})).toBe(true);
    expect(pushChannelsAllowed({ VERCEL_ENV: "preview" })).toBe(false);
    expect(pushChannelsAllowed({ VERCEL_ENV: "production", GOOGLE_PUSH_DISABLED: "1" })).toBe(false);
    expect(pushTarget({ VERCEL_ENV: "production", APP_URL: "https://dashboard.multipark.pt" }).url).toBe("https://dashboard.multipark.pt/api/google/push");
    expect(pushTarget({ VERCEL_ENV: "preview", APP_URL: "https://dashboard.multipark.pt" }).url).toBeNull();
    // Sem APP_URL: a origem de produção por omissão.
    expect(pushTarget({ VERCEL_ENV: "production" }).url).toBe("https://dashboard.multipark.pt/api/google/push");
  });
});

// ─── Webhook ────────────────────────────────────────────────────────────────

describe("webhook /api/google/push", () => {
  const secret = newChannelSecret();
  const row = (over: Record<string, unknown> = {}) => ({ id: secret.id, kind: "calendar", scopeKey: "user:5", resourceId: "res-1", tokenHash: secret.tokenHash, lastMessageNumber: 3, expiration: "2099-01-01 00:00:00", ...over });
  const headers = (over: Record<string, string> = {}) => ({ "x-goog-channel-id": secret.id, "x-goog-channel-token": secret.token, "x-goog-resource-id": "res-1", "x-goog-resource-state": "exists", "x-goog-message-number": "4", ...over });
  let updates: Array<{ sql: string; params: unknown[] }>;
  const setup = (r: unknown | null) => {
    updates = [];
    h.exec = (q) => {
      if (/^select/i.test(q.sql)) return rows(r ? [r] : []);
      updates.push(q);
      return ok(1);
    };
  };
  beforeEach(() => { updates = []; });

  it("canal desconhecido → 404; formato inválido → 400", async () => {
    setup(null);
    expect((await handleGooglePush(headers())).status).toBe(404);
    expect((await handleGooglePush({ ...headers(), "x-goog-channel-id": "!" })).status).toBe(400);
  });
  it("segredo errado ou recurso diferente → 401, sem escrever nada", async () => {
    setup(row());
    expect((await handleGooglePush(headers({ "x-goog-channel-token": newChannelSecret().token }))).status).toBe(401);
    expect((await handleGooglePush(headers({ "x-goog-resource-id": "outro" }))).status).toBe(401);
    expect(updates).toHaveLength(0);
  });
  it("canal expirado → 404", async () => {
    setup(row({ expiration: "2000-01-01 00:00:00" }));
    expect((await handleGooglePush(headers())).status).toBe(404);
  });
  it("'sync' inicial → 200 sem sincronizar (aceite antes de sabermos o resourceId)", async () => {
    setup(row({ resourceId: null }));
    expect(await handleGooglePush(headers({ "x-goog-resource-state": "sync", "x-goog-message-number": "1" }))).toEqual({ status: 200, key: null });
    expect(updates).toHaveLength(0);
  });
  it("alteração no calendário de uma pessoa → sincroniza só esse calendário", async () => {
    setup(row());
    expect(await handleGooglePush(headers())).toEqual({ status: 200, key: "user-cal:5" });
    expect(updates[0].sql).toMatch(/UPDATE google_watch_channels/);
    expect(updates[0].sql).toMatch(/lastMessageNumber < \?/);
  });
  it("mensagem repetida/antiga → 200 sem sincronizar", async () => {
    setup(row({ lastMessageNumber: 9 }));
    expect(await handleGooglePush(headers())).toEqual({ status: 200, key: null });
    expect(updates).toHaveLength(0);
  });
  it("âmbito de cada canal", () => {
    expect(pendingKeyForChannel({ kind: "calendar", scopeKey: "shared:porto" })).toBe("shared:porto");
    expect(pendingKeyForChannel({ kind: "drive", scopeKey: "drive:kb" })).toBe("drive:kb");
    expect(pendingKeyForChannel({ kind: "calendar", scopeKey: "user:12" })).toBe("user-cal:12");
    expect(pendingKeyForChannel({ kind: "calendar", scopeKey: "lixo" })).toBeNull();
  });
  it("a rota é pública mas montada no api-entry com waitUntil", () => {
    const entry = readFileSync(resolve(root, "server/_core/api-entry.ts"), "utf8");
    expect(entry).toContain("registerGoogleAccountRoutes(app, { defer: (p) => waitUntil(p) })");
    const routes = readFileSync(resolve(root, "server/google/routes.ts"), "utf8");
    expect(routes).toMatch(/app\.post\(GOOGLE_PUSH_PATH/);
    // Responde antes de sincronizar.
    expect(routes.indexOf("res.status(out.status).end()")).toBeLessThan(routes.indexOf("drainPending({"));
  });
});

// ─── Renovação ──────────────────────────────────────────────────────────────

describe("renovação dos canais (plano)", () => {
  const H = 3600_000;
  const now = Date.UTC(2026, 8, 26, 3, 40);
  const want = (scopeKey: string, resourceKey = "cal-" + scopeKey, userId: number | null = null): DesiredWatch => ({ kind: scopeKey === "drive:kb" ? "drive" : "calendar", scopeKey, resourceKey, userId });
  const chan = (id: string, scopeKey: string, expInH: number, over: Partial<WatchChannelRow> = {}): WatchChannelRow => ({
    id, kind: scopeKey === "drive:kb" ? "drive" : "calendar", scopeKey, resourceKey: "cal-" + scopeKey, userId: null, resourceId: "r", expiration: now + expInH * H,
    lastNotifiedAt: null, lastError: null, createdAt: null, ...over,
  });

  it("cria os que faltam e deixa os saudáveis", () => {
    const p = planWatchReconcile([want("shared:lisbon"), want("shared:porto")], [chan("a", "shared:lisbon", 100)], now);
    expect(p.create.map((c) => c.scopeKey)).toEqual(["shared:porto"]);
    expect(p.stop).toEqual([]);
    expect(p.forget).toEqual([]);
  });
  it("expira nas próximas 48 h → novo canal e pára o antigo", () => {
    const old = chan("a", "shared:lisbon", 47);
    const p = planWatchReconcile([want("shared:lisbon")], [old], now);
    expect(p.create.map((c) => c.scopeKey)).toEqual(["shared:lisbon"]);
    expect(p.stop.map((c) => c.id)).toEqual(["a"]);
  });
  it("exatamente no limite (48 h) também renova; 49 h não", () => {
    expect(planWatchReconcile([want("shared:lisbon")], [chan("a", "shared:lisbon", 48)], now).create).toHaveLength(1);
    expect(planWatchReconcile([want("shared:lisbon")], [chan("a", "shared:lisbon", 49)], now).create).toHaveLength(0);
  });
  it("órfãos (conta desligada, cidade desligada) e calendário trocado → parar", () => {
    const p = planWatchReconcile(
      [want("user:5", "novo-cal", 5)],
      [chan("x", "user:9", 100, { userId: 9 }), chan("y", "user:5", 100, { userId: 5, resourceKey: "cal-antigo" })],
      now,
    );
    expect(p.stop.map((c) => c.id).sort()).toEqual(["x", "y"]);
    expect(p.create.map((c) => c.resourceKey)).toEqual(["novo-cal"]);
  });
  it("expirados só se esquecem (a Google já os largou)", () => {
    const p = planWatchReconcile([want("drive:kb")], [chan("e", "drive:kb", -1)], now);
    expect(p.forget.map((c) => c.id)).toEqual(["e"]);
    expect(p.create).toHaveLength(1);
    expect(p.stop).toEqual([]);
  });
  it("duplicados (renovação a meio) → fica o que dura mais", () => {
    const p = planWatchReconcile([want("shared:faro")], [chan("curto", "shared:faro", 60), chan("longo", "shared:faro", 160)], now);
    expect(p.create).toEqual([]);
    expect(p.stop.map((c) => c.id)).toEqual(["curto"]);
  });
  it("sem expiração conhecida → trata-se como a renovar", () => {
    const p = planWatchReconcile([want("shared:faro")], [chan("n", "shared:faro", 0, { expiration: null })], now);
    expect(p.create).toHaveLength(1);
  });
  it("estado para o cartão", () => {
    expect(channelHealth({ expiration: now + 100 * H }, now)).toBe("active");
    expect(channelHealth({ expiration: now + 10 * H }, now)).toBe("expiring");
    expect(channelHealth({ expiration: now - 1 }, now)).toBe("expired");
    expect(channelHealth({ expiration: null }, now)).toBe("expired");
  });
});

// ─── Heartbeat ──────────────────────────────────────────────────────────────

describe("heartbeat (Tarefas e Contactos com o dashboard aberto)", () => {
  it("regras puras: 5 min no browser, ~4,5 min no servidor, só com a aba visível", () => {
    const t = 1_000_000_000;
    expect(heartbeatDue(null, t)).toBe(true);
    expect(heartbeatDue(t - HEARTBEAT_MIN_GAP_MS + 1, t)).toBe(false);
    expect(heartbeatDue(t - HEARTBEAT_MIN_GAP_MS, t)).toBe(true);
    expect(clientHeartbeatDue(false, null, t)).toBe(false);
    expect(clientHeartbeatDue(true, null, t)).toBe(true);
    expect(clientHeartbeatDue(true, t - 60_000, t)).toBe(false);
    expect(clientHeartbeatDue(true, t - 5 * 60_000, t)).toBe(true);
  });

  /** Emula google_user_accounts + google_sync_state.lastOnlineSyncAt. */
  const fakeDb = (o: { connected: boolean; scopes?: string }) => {
    const st = { last: null as string | null };
    h.exec = (q) => {
      if (/FROM google_user_accounts/.test(q.sql)) return rows(o.connected ? [{ scopes: o.scopes ?? "https://www.googleapis.com/auth/tasks" }] : []);
      if (/UPDATE google_sync_state SET lastOnlineSyncAt/.test(q.sql)) {
        const [at, , cutoff] = q.params as string[];
        if (st.last == null || st.last <= cutoff) { st.last = at; return ok(1); }
        return ok(0);
      }
      return ok(0);
    };
    return st;
  };

  it("várias abas / pedidos seguidos: 1 corrida por pessoa a cada ~5 min", async () => {
    fakeDb({ connected: true });
    const deferred: unknown[] = [];
    const defer = (p: Promise<unknown>) => { deferred.push(p); p.catch(() => {}); };
    const t0 = Date.UTC(2026, 8, 26, 10, 0);
    expect(await onlineHeartbeat(7, { now: t0, defer })).toEqual({ ran: true, reason: "started" });
    expect(await onlineHeartbeat(7, { now: t0 + 1_000, defer })).toEqual({ ran: false, reason: "throttled" });
    expect(await onlineHeartbeat(7, { now: t0 + 4 * 60_000, defer })).toEqual({ ran: false, reason: "throttled" });
    expect(await onlineHeartbeat(7, { now: t0 + 5 * 60_000, defer })).toEqual({ ran: true, reason: "started" });
    expect(deferred).toHaveLength(2);
  });
  it("sem conta ligada ou sem Tarefas/Contactos → não faz nada", async () => {
    fakeDb({ connected: false });
    expect(await onlineHeartbeat(7, { defer: () => {} })).toEqual({ ran: false, reason: "not_connected" });
    fakeDb({ connected: true, scopes: "https://www.googleapis.com/auth/gmail.modify" });
    expect(await onlineHeartbeat(7, { defer: () => {} })).toEqual({ ran: false, reason: "nothing_to_sync" });
  });
  it("o dashboard chama o heartbeat (só a própria pessoa, protectedProcedure)", () => {
    const layout = readFileSync(resolve(root, "client/src/components/DashboardLayout.tsx"), "utf8");
    expect(layout).toContain("<GoogleOnlineSync enabled={!!user} />");
    const router = readFileSync(resolve(root, "server/google/router.ts"), "utf8");
    expect(router).toMatch(/heartbeat: protectedProcedure\.mutation\(async \(\{ ctx \}\) => \{[\s\S]{0,120}onlineHeartbeat\(ctx\.user\.id\)/);
    expect(router).toMatch(/status: protectedProcedure\.query\(async \(\{ ctx \}\) => \{\s*adminOnly\(ctx\.user as CtxUser\);\s*const \{ pushStatusSummary \}/);
    expect(router).toMatch(/renewNow: protectedProcedure\.mutation\(async \(\{ ctx \}\) => \{\s*superOnly\(ctx\.user as CtxUser\);/);
  });
});

// ─── Fila "sincronizar já" ──────────────────────────────────────────────────

describe("fila 'sincronizar já'", () => {
  it("chaves e espera crescente", () => {
    for (const s of [{ kind: "user", userId: 3 }, { kind: "user-cal", userId: 3 }, { kind: "shared", city: "lisbon" }, { kind: "drive-kb" }, { kind: "drive-mirror" }] as const) {
      expect(parsePendingKey(pendingKey(s))).toEqual(s);
    }
    expect(parsePendingKey("shared:../x")).toBeNull();
    expect(parsePendingKey("user:abc")).toBeNull();
    expect(pendingBackoffMs(1)).toBe(2 * 60_000);
    expect(pendingBackoffMs(2)).toBe(4 * 60_000);
    expect(pendingBackoffMs(20)).toBe(2 * 3600_000);
  });

  /** Emula google_sync_pending. */
  const fakeQueue = () => {
    const t = new Map<string, { version: number; runningUntil: string | null; attempts: number; nextAttemptAt: string | null; lastError: string | null; dirtyAt: string }>();
    h.exec = (q) => {
      const s = q.sql.replace(/\s+/g, " ");
      const p = q.params as any[];
      if (s.startsWith("insert into google_sync_pending") || s.startsWith("INSERT INTO google_sync_pending")) {
        const [key, , at] = p;
        const cur = t.get(key);
        if (cur) Object.assign(cur, { version: cur.version + 1, dirtyAt: at, attempts: 0, nextAttemptAt: null, lastError: null });
        else t.set(key, { version: 1, runningUntil: null, attempts: 0, nextAttemptAt: null, lastError: null, dirtyAt: at });
        return ok(1);
      }
      if (/^SELECT scopeKey, version, attempts/.test(s)) {
        const list = /scopeKey IN/.test(s) ? p.filter((k) => t.has(k)) : Array.from(t.keys()).filter((k) => { const r = t.get(k)!; return r.nextAttemptAt == null || r.nextAttemptAt <= p[0]; });
        return rows(list.map((k) => ({ scopeKey: k, version: t.get(k)!.version, attempts: t.get(k)!.attempts })));
      }
      if (/^SELECT version FROM/.test(s)) { const r = t.get(p[0]); return rows(r ? [{ version: r.version }] : []); }
      if (/^UPDATE google_sync_pending SET runningUntil = \? WHERE/.test(s)) {
        const [until, key, now1, now2] = p;
        const r = t.get(key);
        if (!r || (r.runningUntil != null && r.runningUntil >= now1) || (r.nextAttemptAt != null && r.nextAttemptAt > now2)) return ok(0);
        r.runningUntil = until;
        return ok(1);
      }
      if (/^DELETE FROM google_sync_pending WHERE scopeKey = \? AND version = \?/.test(s)) {
        const r = t.get(p[0]);
        if (r && r.version === Number(p[1])) { t.delete(p[0]); return ok(1); }
        return ok(0);
      }
      if (/^DELETE FROM google_sync_pending WHERE scopeKey = \?/.test(s)) { t.delete(p[0]); return ok(1); }
      if (/^UPDATE google_sync_pending SET runningUntil = NULL, attempts/.test(s)) {
        const [attempts, lastError, next, key] = p;
        const r = t.get(key);
        if (r) Object.assign(r, { runningUntil: null, attempts, lastError, nextAttemptAt: next });
        return ok(r ? 1 : 0);
      }
      if (/^UPDATE google_sync_pending SET runningUntil = NULL WHERE/.test(s)) { const r = t.get(p[0]); if (r) r.runningUntil = null; return ok(r ? 1 : 0); }
      throw new Error(`SQL inesperado: ${s}`);
    };
    return t;
  };

  it("corre e apaga; marcações durante a corrida fazem-na correr outra vez (nunca se perdem)", async () => {
    const t = fakeQueue();
    await markPending(["user:1", "lixo"], "task");
    expect(Array.from(t.keys())).toEqual(["user:1"]);
    let calls = 0;
    const r = await drainPending({
      deadlineAt: Date.now() + 60_000, keys: ["user:1"],
      runner: async () => { calls++; if (calls === 1) await markPending(["user:1"], "task"); return { status: "ok" }; },
    });
    expect(calls).toBe(2);
    expect(r.succeeded).toBe(2);
    expect(t.size).toBe(0);
  });
  it("falha → espera crescente e fica na fila; ao fim de 8 falhas desiste", async () => {
    const t = fakeQueue();
    await markPending(["shared:porto"], "push");
    const r = await drainPending({ deadlineAt: Date.now() + 60_000, runner: async () => ({ status: "error", error: "Google em baixo" }) });
    expect(r.failed).toBe(1);
    expect(t.get("shared:porto")).toMatchObject({ attempts: 1, lastError: "Google em baixo", runningUntil: null });
    expect(t.get("shared:porto")!.nextAttemptAt).not.toBeNull();
    // Ainda à espera → a corrida seguinte não lhe toca.
    const again = await drainPending({ deadlineAt: Date.now() + 60_000, runner: async () => ({ status: "ok" }) });
    expect(again.ran).toBe(0);
    // Última tentativa falhada → sai da fila (o google-sync de 4 h apanha).
    Object.assign(t.get("shared:porto")!, { attempts: PENDING_MAX_ATTEMPTS - 1, nextAttemptAt: null });
    const last = await drainPending({ deadlineAt: Date.now() + 60_000, runner: async () => ({ status: "error", error: "x" }) });
    expect(last.gaveUp).toBe(1);
    expect(t.size).toBe(0);
  });
  it("a meio (prazo/limite da Google) → fica para a próxima, sem contar como falha", async () => {
    const t = fakeQueue();
    await markPending(["drive:kb"], "push");
    const r = await drainPending({ deadlineAt: Date.now() + 60_000, runner: async () => ({ status: "partial" }) });
    expect(r.partial).toBe(1);
    expect(t.get("drive:kb")).toMatchObject({ attempts: 0, runningUntil: null });
  });
  it("outra corrida com o lease → não corre em paralelo", async () => {
    const t = fakeQueue();
    await markPending(["user:2"], "task");
    t.get("user:2")!.runningUntil = "2999-01-01 00:00:00";
    let calls = 0;
    const r = await drainPending({ deadlineAt: Date.now() + 60_000, keys: ["user:2"], runner: async () => { calls++; return { status: "ok" }; } });
    expect(calls).toBe(0);
    expect(r.remaining).toBe(true);
  });
});

// ─── Agendador e migração ───────────────────────────────────────────────────

describe("agendador e migração 0200", () => {
  it("google-sync de 4 em 4 h (rede de segurança), repetição de 15 min e renovação diária", () => {
    const c = Object.fromEntries(TICK_JOBS.map((j) => [j.key, describeCadence(j.cadence)]));
    expect(c["google-sync"]).toBe("a cada 4 h");
    expect(c["google-pending"]).toBe("a cada 15 min");
    expect(c["google-watch-renew"]).toBe("diário a partir das 03:40");
    const known = Object.fromEntries(CRON_JOBS.map((j) => [j.name, j.intervalMinutes]));
    expect(known["google-sync"]).toBe(240);
    expect(known["google-pending"]).toBe(15);
    expect(known["google-watch-renew"]).toBe(1440);
  });
  it("tabelas dos canais e da fila, e a coluna do heartbeat", () => {
    expect(MIGRATION_0200_STATEMENTS[0]).toMatch(/CREATE TABLE IF NOT EXISTS `google_watch_channels`/);
    expect(MIGRATION_0200_STATEMENTS[0]).toMatch(/`tokenHash` CHAR\(64\) NOT NULL/);
    expect(MIGRATION_0200_STATEMENTS[0]).not.toMatch(/`token` /);
    expect(MIGRATION_0200_STATEMENTS[1]).toMatch(/CREATE TABLE IF NOT EXISTS `google_sync_pending`/);
    expect(MIGRATION_0200_STATEMENTS[2]).toMatch(/ADD COLUMN `lastOnlineSyncAt`/);
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    expect(db.indexOf("migration_0200")).toBeGreaterThan(db.indexOf("migration_0190"));
  });
});
