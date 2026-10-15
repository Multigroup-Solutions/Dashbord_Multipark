/**
 * Leituras lentas das ferramentas de dados do Multis do piloto (plano MPV
 * F4): prazo próprio, uma só leitura por chave e cache curta dos resultados
 * que chegam DEPOIS do prazo. Num ficheiro à parte (sem dependências) para o
 * middleware do tRPC poder limpar as entradas de uma pessoa quando ela faz uma
 * mutação, sem carregar as ferramentas.
 *
 * Os procedimentos chamados pelo createCaller não aceitam AbortSignal (as
 * leituras por baixo não se cancelam a meio). Por isso:
 *  - single-flight: uma 2.ª leitura IGUAL (a chave junta a pessoa) enquanto a
 *    1.ª corre espera pela 1.ª;
 *  - o resultado que chega depois do prazo de TODOS os que esperavam vai para
 *    a cache (com a hora da leitura); se alguém ainda o recebeu a tempo, não;
 *  - guarda-se só a PROJEÇÃO (o que a ferramenta usa), nunca a resposta
 *    inteira do procedimento;
 *  - no máximo LATE_CACHE_MAX entradas; as vencidas saem a cada escrita;
 *  - uma leitura pendurada sai do mapa ao fim de SLOW_CALL_INFLIGHT_MAX_MS;
 *  - uma mutação da pessoa (qualquer procedimento tRPC do tipo mutation)
 *    apaga as entradas dela (forgetSlowCallsOf, server/_core/trpc.ts).
 */

/** Um resultado que chegou DEPOIS do prazo fica guardado este tempo para a pergunta seguinte o aproveitar. */
export const SLOW_CALL_LATE_CACHE_MS = 5 * 60_000;
/** Uma leitura em curso há mais do que isto sai do mapa (nunca fica presa para sempre). */
export const SLOW_CALL_INFLIGHT_MAX_MS = 90_000;
/** Máximo de resultados atrasados guardados (o processo todo). */
export const LATE_CACHE_MAX = 20;

/** O prazo passou (o chamador transforma isto na mensagem para o modelo). */
export class SlowCallTimeout extends Error {}

interface Flight {
  at: number;
  userId: number;
  promise: Promise<unknown>;
  /** Quantos chamadores ainda esperam (dentro do prazo). */
  waiting: number;
  /** Algum chamador desistiu por prazo. */
  timedOut: boolean;
  /** A pessoa fez uma mutação entretanto: o resultado já não se guarda. */
  stale: boolean;
}

const inflight = new Map<string, Flight>();
const lateCache = new Map<string, { at: number; userId: number; value: unknown }>();

/** Só para os testes (o estado é do processo). */
export function resetSlowCallsForTests(): void { inflight.clear(); lateCache.clear(); }
/** Só para os testes: quantas entradas há. */
export function slowCallSizesForTests(): { inflight: number; cached: number } { return { inflight: inflight.size, cached: lateCache.size }; }

/** A pessoa mudou alguma coisa: as leituras guardadas (e as em curso) dela deixam de servir. Nunca lança. */
export function forgetSlowCallsOf(userId: number | null | undefined): void {
  if (userId == null) return;
  for (const [k, v] of lateCache) if (v.userId === userId) lateCache.delete(k);
  for (const [k, f] of inflight) if (f.userId === userId) { f.stale = true; inflight.delete(k); }
}

function sweep(now: number): void {
  for (const [k, v] of lateCache) if (now - v.at > SLOW_CALL_LATE_CACHE_MS) lateCache.delete(k);
  for (const [k, f] of inflight) if (now - f.at > SLOW_CALL_INFLIGHT_MAX_MS) inflight.delete(k);
}

function remember(key: string, userId: number, value: unknown): void {
  const now = Date.now();
  sweep(now);
  while (lateCache.size >= LATE_CACHE_MAX) lateCache.delete(lateCache.keys().next().value as string);
  lateCache.set(key, { at: now, userId, value });
}

/**
 * Uma leitura com prazo. `read` faz a chamada; `project` reduz a resposta ao
 * que a ferramenta usa (é isso que se partilha e se guarda). Devolve os dados e,
 * quando vêm da cache, a hora da leitura (`cachedAt`, ms).
 */
export async function slowRead<T>(o: {
  key: string; userId: number; ms: number;
  read: () => Promise<unknown>; project: (raw: any) => T;
}): Promise<{ data: T; cachedAt: number | null }> {
  const now = Date.now();
  sweep(now);
  const hit = lateCache.get(o.key);
  if (hit) {
    lateCache.delete(o.key);
    return { data: hit.value as T, cachedAt: hit.at };
  }
  let flight = inflight.get(o.key);
  if (!flight) {
    const promise = Promise.resolve().then(o.read).then((raw) => o.project(raw));
    const entry: Flight = { at: now, userId: o.userId, promise, waiting: 0, timedOut: false, stale: false };
    flight = entry;
    inflight.set(o.key, entry);
    // Leitura pendurada: sai do mapa ao fim do máximo (o temporizador não segura o processo).
    const hang = setTimeout(() => { if (inflight.get(o.key) === entry) inflight.delete(o.key); }, SLOW_CALL_INFLIGHT_MAX_MS);
    (hang as { unref?: () => void }).unref?.();
    // Corre ANTES das continuações de quem espera: `waiting` ainda conta quem o recebe a tempo.
    promise.then(
      (value) => {
        clearTimeout(hang);
        if (inflight.get(o.key) === entry) inflight.delete(o.key);
        if (entry.stale) return;
        if (entry.timedOut && entry.waiting === 0) remember(o.key, o.userId, value);
      },
      () => { clearTimeout(hang); if (inflight.get(o.key) === entry) inflight.delete(o.key); },
    );
  }
  const current = flight;
  current.waiting++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let left = false;
  const leave = () => { if (!left) { left = true; current.waiting--; } };
  try {
    const data = await Promise.race([
      current.promise.then((v) => { leave(); return v; }, (e) => { leave(); throw e; }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          leave();
          current.timedOut = true;
          reject(new SlowCallTimeout());
        }, o.ms);
      }),
    ]);
    return { data: data as T, cachedAt: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
