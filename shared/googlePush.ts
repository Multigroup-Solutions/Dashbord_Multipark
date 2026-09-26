/**
 * Google por eventos (decisão do Jorge, 26 set 2026) — regras PURAS:
 *
 *  - Calendário (pessoal "Multipark" e partilhados "Escala Multipark —
 *    <cidade>") e Drive (pastas da base de conhecimento no Shared Drive):
 *    canais de notificação da Google (events.watch / changes.watch) para o
 *    endereço público `${APP_URL}/api/google/push`. Cada canal tem um
 *    segredo próprio (X-Goog-Channel-Token, guardado só como hash) e expira
 *    (≤ 7 dias) → renovação diária (google-watch-renew);
 *  - Tarefas e Contactos não têm notificações da Google → sincronizam quando
 *    a pessoa abre o dashboard e de 5 em 5 min enquanto o tem aberto
 *    (heartbeat do browser, limitado por pessoa no servidor);
 *  - o que muda no dashboard vai logo para o Google (fila "pendente" por
 *    âmbito, corrida imediata em segundo plano; o agendador repete o que
 *    falhar de 15 em 15 min);
 *  - rede de segurança: google-sync completo de 4 em 4 horas.
 *
 * Sem BD nem rede: o servidor está em server/google/pushChannels.ts e
 * server/google/pendingSync.ts.
 */

/** Caminho do webhook público (sem sessão; autenticado pelo segredo do canal). */
export const GOOGLE_PUSH_PATH = "/api/google/push";

/** Validade pedida para um canal (a Google pode devolver menos). */
export const WATCH_TTL_SECONDS = 7 * 24 * 3600;
/** Renova os canais que expiram nas próximas 48 h (a renovação corre 1×/dia). */
export const WATCH_RENEW_HORIZON_MS = 48 * 3600_000;
/** Intervalo do heartbeat do browser e limite mínimo por pessoa no servidor. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
/** Folga do limite por pessoa (duas abas / relógios desencontrados não duplicam). */
export const HEARTBEAT_MIN_GAP_MS = 4.5 * 60_000;
/** Tentativas de um âmbito pendente antes de desistir (fica para o google-sync de 4 h). */
export const PENDING_MAX_ATTEMPTS = 8;

export type WatchKind = "calendar" | "drive";

/** Âmbitos da fila "pendente" (o que sincronizar já). */
export type PendingScope =
  | { kind: "user"; userId: number }          // Tarefas + Calendário da pessoa (alteração no dashboard)
  | { kind: "user-cal"; userId: number }      // só o Calendário da pessoa (notificação da Google)
  | { kind: "shared"; city: string }          // calendário partilhado da cidade
  | { kind: "drive-kb" }                      // pastas da base de conhecimento (alterações no Drive)
  | { kind: "drive-mirror" };                 // espelho das provas das reclamações no Shared Drive

export function pendingKey(s: PendingScope): string {
  switch (s.kind) {
    case "user": return `user:${s.userId}`;
    case "user-cal": return `user-cal:${s.userId}`;
    case "shared": return `shared:${s.city}`;
    case "drive-kb": return "drive:kb";
    case "drive-mirror": return "drive:mirror";
  }
}

const SHARED_CITY = /^[a-z]{2,16}$/;

/** Chave → âmbito (null se desconhecida). PURA. */
export function parsePendingKey(key: string): PendingScope | null {
  let m = /^user:(\d{1,10})$/.exec(key);
  if (m) return { kind: "user", userId: Number(m[1]) };
  m = /^user-cal:(\d{1,10})$/.exec(key);
  if (m) return { kind: "user-cal", userId: Number(m[1]) };
  m = /^shared:(.+)$/.exec(key);
  if (m && SHARED_CITY.test(m[1])) return { kind: "shared", city: m[1] };
  if (key === "drive:kb") return { kind: "drive-kb" };
  if (key === "drive:mirror") return { kind: "drive-mirror" };
  return null;
}

/** Espera antes da tentativa seguinte de um âmbito que falhou: 2, 4, 8… min, no máximo 2 h. PURA. */
export function pendingBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(2 * 60_000 * 2 ** (n - 1), 2 * 3600_000);
}

// ─── Endereço do webhook ────────────────────────────────────────────────────

/**
 * URL do webhook a partir da origem pública da app (APP_URL). A Google só
 * aceita https com certificado válido: http, localhost, IPs e URLs de
 * pré-visualização do Vercel (*.vercel.app) → null (sem canais; fica o
 * google-sync de 4 h e o heartbeat). PURA.
 */
export function pushWebhookUrl(origin: string | null | undefined): string | null {
  let u: URL;
  try { u = new URL(String(origin ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.includes(":")) return null;
  if (host.endsWith(".vercel.app")) return null;
  return `https://${u.host}${GOOGLE_PUSH_PATH}`;
}

/** Os canais podem ser criados neste ambiente? (Só produção, e não com GOOGLE_PUSH_DISABLED=1.) PURA. */
export function pushChannelsAllowed(env: Record<string, string | undefined>): boolean {
  if (String(env.GOOGLE_PUSH_DISABLED ?? "").trim() === "1") return false;
  const vercelEnv = String(env.VERCEL_ENV ?? "").trim();
  if (vercelEnv && vercelEnv !== "production") return false;
  return true;
}

// ─── Cabeçalhos da notificação ──────────────────────────────────────────────

export interface PushHeaders {
  channelId: string;
  token: string;
  resourceId: string;
  resourceState: string;
  messageNumber: number | null;
}

const CHANNEL_ID = /^[A-Za-z0-9_-]{8,64}$/;
const RESOURCE_ID = /^[A-Za-z0-9_\-+/=.]{1,255}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,256}$/;
const STATE = /^[a-z_]{1,24}$/;

const one = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "").trim();

/**
 * Lê e valida os cabeçalhos X-Goog-* (nomes em minúsculas, como no Express).
 * Qualquer coisa fora do formato → null (a rota responde 400 sem tocar na BD). PURA.
 */
export function parsePushHeaders(h: Record<string, unknown>): PushHeaders | null {
  const channelId = one(h["x-goog-channel-id"]);
  const token = one(h["x-goog-channel-token"]);
  const resourceId = one(h["x-goog-resource-id"]);
  const resourceState = one(h["x-goog-resource-state"]).toLowerCase();
  const num = one(h["x-goog-message-number"]);
  if (!CHANNEL_ID.test(channelId) || !TOKEN.test(token) || !RESOURCE_ID.test(resourceId) || !STATE.test(resourceState)) return null;
  if (num && !/^\d{1,18}$/.test(num)) return null;
  return { channelId, token, resourceId, resourceState, messageNumber: num ? Number(num) : null };
}

/** A notificação pede sincronização? ("sync" é só o aperto de mão inicial.) PURA. */
export function pushNeedsSync(resourceState: string): boolean {
  return resourceState !== "sync";
}

/** Mensagem já vista (reenvio / fora de ordem)? PURA. */
export function isStaleMessage(messageNumber: number | null, lastMessageNumber: number | null): boolean {
  return messageNumber != null && lastMessageNumber != null && messageNumber <= lastMessageNumber;
}

// ─── Plano de canais (criar / renovar / parar) ──────────────────────────────

export interface DesiredWatch {
  kind: WatchKind;
  /** "user:<id>" | "shared:<cidade>" | "drive:kb" */
  scopeKey: string;
  /** O que é vigiado: id do calendário ou id do Shared Drive. */
  resourceKey: string;
  userId: number | null;
}

export interface WatchChannelRow {
  id: string;
  kind: WatchKind;
  scopeKey: string;
  resourceKey: string | null;
  userId: number | null;
  resourceId: string | null;
  /** epoch ms; null = desconhecida (trata-se como a expirar). */
  expiration: number | null;
  lastNotifiedAt: number | null;
  lastError: string | null;
  createdAt: number | null;
}

export interface WatchPlan {
  /** Âmbitos sem canal válido, ou com canal a expirar dentro do horizonte. */
  create: DesiredWatch[];
  /** Canais a parar: âmbito que já não se quer, calendário/drive diferente, ou substituídos por um novo. */
  stop: WatchChannelRow[];
  /** Linhas de canais já expirados (só apagar da BD; a Google já os esqueceu). */
  forget: WatchChannelRow[];
}

/**
 * Compara o que se quer vigiar com os canais existentes. Um âmbito com um
 * canal que ainda dura mais do que o horizonte fica como está; com um canal
 * a expirar dentro do horizonte → cria-se outro (e o antigo pára só depois
 * de o novo existir: o executor para os `stop` no fim). PURA.
 */
export function planWatchReconcile(desired: readonly DesiredWatch[], existing: readonly WatchChannelRow[], now: number, horizonMs = WATCH_RENEW_HORIZON_MS): WatchPlan {
  const plan: WatchPlan = { create: [], stop: [], forget: [] };
  const live: WatchChannelRow[] = [];
  for (const c of existing) {
    if (c.expiration != null && c.expiration <= now) plan.forget.push(c);
    else live.push(c);
  }
  const wanted = new Map<string, DesiredWatch>();
  for (const d of desired) wanted.set(`${d.kind}|${d.scopeKey}`, d);
  const byScope = new Map<string, WatchChannelRow[]>();
  for (const c of live) {
    const k = `${c.kind}|${c.scopeKey}`;
    const d = wanted.get(k);
    if (!d || c.resourceKey !== d.resourceKey || (d.userId ?? null) !== (c.userId ?? null)) { plan.stop.push(c); continue; }
    if (!byScope.has(k)) byScope.set(k, []);
    byScope.get(k)!.push(c);
  }
  for (const [k, d] of wanted) {
    const chans = (byScope.get(k) ?? []).slice().sort((a, b) => (b.expiration ?? 0) - (a.expiration ?? 0));
    const best = chans[0];
    const bestOk = !!best && best.expiration != null && best.expiration - now > horizonMs;
    if (!bestOk) {
      plan.create.push(d);
      plan.stop.push(...chans); // todos a expirar: param depois de o novo existir
    } else {
      plan.stop.push(...chans.slice(1)); // duplicados (ex.: renovação a meio) → fica só o mais longo
    }
  }
  return plan;
}

/** Estado de um canal para o cartão ("ativo" / "a expirar" / "expirado"). PURA. */
export function channelHealth(c: Pick<WatchChannelRow, "expiration">, now: number, horizonMs = WATCH_RENEW_HORIZON_MS): "active" | "expiring" | "expired" {
  if (c.expiration == null || c.expiration <= now) return "expired";
  return c.expiration - now <= horizonMs ? "expiring" : "active";
}

// ─── Heartbeat (Tarefas e Contactos enquanto o dashboard está aberto) ───────

/** A última sincronização "online" desta pessoa já passou o limite? PURA. */
export function heartbeatDue(lastOnlineSyncAt: number | null, now: number, minGapMs = HEARTBEAT_MIN_GAP_MS): boolean {
  return lastOnlineSyncAt == null || now - lastOnlineSyncAt >= minGapMs;
}

/** O browser deve mandar o heartbeat agora? (aba visível e ≥ 5 min desde o último). PURA. */
export function clientHeartbeatDue(visible: boolean, lastSentAt: number | null, now: number, intervalMs = HEARTBEAT_INTERVAL_MS): boolean {
  if (!visible) return false;
  return lastSentAt == null || now - lastSentAt >= intervalMs;
}

export const WATCH_SCOPE_LABEL = (scopeKey: string): string => {
  if (scopeKey === "drive:kb") return "Drive — base de conhecimento";
  const m = /^shared:(\w+)$/.exec(scopeKey);
  if (m) return `Calendário partilhado — ${m[1] === "lisbon" ? "Lisboa" : m[1] === "porto" ? "Porto" : m[1] === "faro" ? "Faro" : m[1]}`;
  if (/^user:\d+$/.test(scopeKey)) return "Calendário pessoal";
  return scopeKey;
};
