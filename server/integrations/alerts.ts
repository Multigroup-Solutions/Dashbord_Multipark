/**
 * Alertas das integrações: quando uma ligação passa a `reauth_required` /
 * `error`, ou um cron fica parado ("stale"), os administradores recebem UMA
 * notificação na app e o dono um email (notifyOwner) — uma vez por
 * TRANSIÇÃO. O último estado alertado fica em integration_alert_state
 * (migração 0105); a troca de estado é um UPDATE condicional atómico, por
 * isso duas invocações em paralelo não avisam a dobrar.
 *
 * Quem chama: o registo dos crons (server/cronRuns.ts), no fim de cada
 * corrida — no máximo uma avaliação a cada 10 min por processo. Como a fila
 * Multipark corre de 5 em 5 min, um cron parado é detetado por outro que
 * ainda corre. Nunca lança.
 */
import { sql } from "drizzle-orm";

export type AlertState = "ok" | "reauth_required" | "error" | "stale";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/** Estado de alerta de uma ligação guardada. PURA. */
export function connectionAlertState(status: string | null | undefined): AlertState {
  if (status === "reauth_required") return "reauth_required";
  if (status === "error") return "error";
  return "ok";   // connected / disconnected (desligar é uma decisão, não um alarme)
}

/** O que fazer com uma mudança de estado: avisar só quando PASSA a mau. PURA. */
export function alertTransition(previous: string | null, next: AlertState): "alert" | "recovered" | "none" {
  if (previous === next) return "none";
  if (next !== "ok") return "alert";
  return previous != null && previous !== "ok" ? "recovered" : "none";
}

export const CONNECTION_LABELS: Record<string, { label: string; link: string }> = {
  google_ads: { label: "Google Ads", link: "/integracoes/google-ads" },
  meta: { label: "Meta Ads", link: "/integracoes/google-ads#meta" },
  google_business: { label: "Google Business Profile", link: "/criticas" },
  whatsapp: { label: "WhatsApp", link: "/integracoes" },
};

/** Texto do alerta. PURA. */
export function alertMessage(kind: "conn" | "cron", name: string, state: AlertState, detail: string | null, label?: string): { title: string; body: string } {
  const who = label ?? CONNECTION_LABELS[name]?.label ?? name;
  if (kind === "cron") {
    return { title: `Cron parado: ${who}`, body: `O cron "${who}" não corre há mais do dobro do intervalo esperado. Ver Definições → Estado e o GitHub Actions.${detail ? ` Última nota: ${detail}` : ""}` };
  }
  if (state === "reauth_required") {
    return { title: `${who} precisa de ser religado`, body: `A autorização de ${who} expirou ou foi revogada — a recolha está parada até alguém voltar a ligar em Integrações.${detail ? ` Detalhe: ${detail}` : ""}` };
  }
  return { title: `${who} com erro`, body: `A ligação a ${who} está em erro.${detail ? ` Detalhe: ${detail}` : ""} Ver Integrações.` };
}

type Db = { execute: (q: any) => Promise<any> };

/**
 * Grava o novo estado se MUDOU. Devolve o estado anterior (null = primeira
 * vez) ou `undefined` se nada mudou (ou outra invocação já tratou).
 */
async function claimTransition(db: Db, key: string, state: AlertState, detail: string | null): Promise<string | null | undefined> {
  const ins = await db.execute(sql`INSERT IGNORE INTO integration_alert_state (alertKey, state, detail) VALUES (${key}, ${state}, ${detail})`);
  const insHeader = Array.isArray(ins) ? ins[0] : ins;
  if (Number((insHeader as any)?.affectedRows ?? 0) === 1) return null;
  const prevRows = rowsOf(await db.execute(sql`SELECT state FROM integration_alert_state WHERE alertKey = ${key}`));
  const prev = prevRows[0]?.state != null ? String(prevRows[0].state) : null;
  if (prev === state) return undefined;
  const upd = await db.execute(sql`UPDATE integration_alert_state SET state = ${state}, detail = ${detail}, changedAt = UTC_TIMESTAMP()
    WHERE alertKey = ${key} AND state = ${prev}`);
  const updHeader = Array.isArray(upd) ? upd[0] : upd;
  return Number((updHeader as any)?.affectedRows ?? 0) === 1 ? prev : undefined;
}

async function sendAlert(db: Db, key: string, title: string, body: string, link: string): Promise<void> {
  try {
    const admins = rowsOf(await db.execute(sql`SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND isActive = 1`));
    const { createNotification } = await import("../complaintsExtended");
    for (const a of admins) {
      try { await createNotification({ userId: Number(a.id), title, body, kind: "integration", link }); } catch { /* segue */ }
    }
  } catch (err: any) {
    console.warn("[alerts] notificações na app falharam:", String(err?.message ?? err).slice(0, 160));
  }
  try {
    const { notifyOwner } = await import("../_core/notification");
    await notifyOwner({ title, content: body });
  } catch { /* o email é melhor-esforço */ }
  try { await db.execute(sql`UPDATE integration_alert_state SET alertedAt = UTC_TIMESTAMP() WHERE alertKey = ${key}`); } catch { /* indicador */ }
}

const EVAL_EVERY_MS = 10 * 60_000;
let lastEvalAt = 0;

/** Avalia (no máx. 1×/10 min por processo, salvo `force`) e envia os alertas das transições novas. */
export async function evaluateIntegrationAlerts(opts: { force?: boolean; now?: number } = {}): Promise<{ alerted: string[]; recovered: string[] }> {
  const out = { alerted: [] as string[], recovered: [] as string[] };
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastEvalAt < EVAL_EVERY_MS) return out;
  lastEvalAt = now;
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return out;

    const items: Array<{ key: string; kind: "conn" | "cron"; name: string; state: AlertState; detail: string | null; label?: string; link: string }> = [];
    const conns = rowsOf(await db.execute(sql`SELECT provider, status, lastError FROM integration_connections`));
    for (const c of conns) {
      const name = String(c.provider);
      items.push({ key: `conn:${name}`, kind: "conn", name, state: connectionAlertState(String(c.status)), detail: c.lastError ? String(c.lastError).slice(0, 300) : null, link: CONNECTION_LABELS[name]?.link ?? "/integracoes" });
    }
    try {
      const { getCronStatuses } = await import("../cronRuns");
      for (const c of await getCronStatuses(now)) {
        items.push({ key: `cron:${c.name}`, kind: "cron", name: c.name, label: c.label, state: c.health === "stale" ? "stale" : "ok", detail: c.last?.error ?? null, link: "/definicoes" });
      }
    } catch { /* sem crons → só ligações */ }

    for (const it of items) {
      const prev = await claimTransition(db as any, it.key, it.state, it.detail ? it.detail.slice(0, 500) : null);
      if (prev === undefined) continue;
      const t = alertTransition(prev, it.state);
      if (t === "alert") {
        const m = alertMessage(it.kind, it.name, it.state, it.detail, it.label);
        await sendAlert(db as any, it.key, m.title, m.body, it.link);
        out.alerted.push(it.key);
      } else if (t === "recovered") {
        out.recovered.push(it.key);
      }
    }
  } catch (err: any) {
    console.warn("[alerts] avaliação falhou:", String(err?.message ?? err).slice(0, 160));
  }
  return out;
}
