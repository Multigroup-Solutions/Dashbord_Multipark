/**
 * Worker-pool simples e partilhado: corre `fn` sobre `items` com no máximo
 * `limit` execuções em paralelo. Opcionalmente para quando `deadlineAt`
 * (epoch ms) é atingido — útil em jobs com budget de tempo.
 *
 * Réplica do `runConcurrent` que já vivia acoplado a
 * `server/jobs/multiparkBookingSync.ts` (mantido lá para não mexer no sync);
 * extraído para aqui para poder ser reutilizado pelo broadcast de WhatsApp e
 * por futuros consumidores. Erros de `fn` são engolidos por item (cada item é
 * independente) — o chamador é responsável por registar o resultado por item.
 */
export async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  deadlineAt?: number,
): Promise<void> {
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (idx < items.length) {
        if (deadlineAt && Date.now() >= deadlineAt) break;
        const i = idx++;
        try {
          await fn(items[i]);
        } catch {
          /* erro por item é da responsabilidade do fn registar */
        }
      }
    }),
  );
}
