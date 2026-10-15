/**
 * Cache curta, em memória, para leituras AO VIVO da BD da Multipark (só
 * leitura), com a PROMESSA partilhada: várias pessoas a abrir o mesmo ecrã no
 * mesmo minuto fazem UMA leitura — o pool tem só 2 ligações por instância
 * (server/multiparkDb/client.ts; plano 64, §7), como o loadMarketingBookings.
 *
 * A chave tem de levar TUDO o que muda a resposta, em particular os PARQUES
 * (o âmbito de cidade de quem pede): assim nunca se serve o âmbito de uma
 * pessoa a outra. Uma leitura que falha sai logo da cache (a seguinte tenta
 * de novo).
 */
export interface LiveCache {
  get<T>(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
  readonly size: number;
}

export function createLiveCache(ttlMs: number, max = 50): LiveCache {
  const entries = new Map<string, { at: number; value: Promise<unknown> }>();
  return {
    get<T>(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
      const value = load();
      entries.set(key, { at: Date.now(), value });
      value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
      if (entries.size > max) entries.delete(entries.keys().next().value as string);
      return value;
    },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}
