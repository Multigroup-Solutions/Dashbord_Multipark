/**
 * Plano 05 (F3): a sessão do dashboard aberta com a conta Multipark leva o id da
 * sessão do be-shared (`ss`). Se essa sessão acabar no be-shared (logout noutro
 * lado, "terminar sessões", conta Multipark desativada), o dashboard deixa de a
 * aceitar — no máximo 5 minutos depois.
 *
 * FALHA ABERTA (risco R4): be-shared indisponível ou sem configuração → a sessão
 * continua válida. Só uma resposta clara "esta sessão já não está ativa" expulsa.
 * Cache em memória por processo; pedidos simultâneos à mesma sessão partilham a
 * mesma consulta.
 */
import { SharedAuthError, sharedAuth } from "./_core/sharedAuth";

export const SHARED_SESSION_RECHECK_MS = 5 * 60 * 1000;
/** Depois de uma falha de rede, espera isto antes de voltar a perguntar (não martelar). */
export const SHARED_SESSION_RETRY_MS = 60 * 1000;
const MAX_CACHE = 20_000;

type Check = (sessionIds: string[]) => Promise<Set<string>>;

const cache = new Map<string, { active: boolean; at: number; ttl: number }>();
const inflight = new Map<string, Promise<boolean>>();

function remember(sid: string, active: boolean, ttl: number, now: number): void {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(sid, { active, at: now, ttl });
}

/** Testável: `check` e `now` injetáveis. */
export async function sharedSessionStillValidWith(sid: string, check: Check, now: number = Date.now()): Promise<boolean> {
  const hit = cache.get(sid);
  if (hit && now - hit.at < hit.ttl) return hit.active;
  const running = inflight.get(sid);
  if (running) return running;

  const p = (async () => {
    try {
      const active = (await check([sid])).has(sid);
      remember(sid, active, SHARED_SESSION_RECHECK_MS, now);
      if (!active) console.warn(`[SharedAuth] sessão Multipark terminada — sessão do dashboard recusada`);
      return active;
    } catch (err) {
      const code = err instanceof SharedAuthError ? err.code : "unavailable";
      if (code !== "not_configured") console.warn(`[SharedAuth] não confirmou a sessão (${code}) — continua aceite`);
      // Falha aberta: aceita e volta a tentar daqui a pouco.
      remember(sid, hit?.active ?? true, SHARED_SESSION_RETRY_MS, now);
      return hit?.active ?? true;
    } finally {
      inflight.delete(sid);
    }
  })();
  inflight.set(sid, p);
  return p;
}

export function sharedSessionStillValid(sid: string): Promise<boolean> {
  return sharedSessionStillValidWith(sid, (ids) => sharedAuth().activeSessions(ids));
}

/** Logout no dashboard: esquece já (a próxima verificação pergunta). */
export function forgetSharedSession(sid: string | null | undefined): void {
  if (sid) cache.delete(sid);
}

export function clearSharedSessionCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
