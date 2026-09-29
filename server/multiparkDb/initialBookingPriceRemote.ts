import type { Period, PricePageReader, BookingRow, HistoryRow } from "./initialBookingPrice";

export function createRemoteExportPageReader(origin: string, secret: string, period: Period, endpointPath: string, fetcher: typeof fetch = fetch) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("--remote exige a origem HTTPS da dashboard, sem caminho, credenciais ou parâmetros.");
  }
  if (!secret.trim()) throw new Error("Falta BOOKING_PRICE_EXPORT_SECRET (ou CRON_SECRET) para autenticar a exportação no servidor.");
  const url = new URL(endpointPath, base).href;
  async function page<T>(stage: string, cursor: string, limit: number): Promise<T[]> {
    if (limit > 1000) throw new Error("O modo remoto admite no máximo 1000 registos por lote.");
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(50_000),
          headers: { Authorization: `Bearer ${secret.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ stage, from: period.from, to: period.to,
            asOf: period.asOfUtc.replace(" ", "T") + "Z", cursor, pageSize: limit }),
        });
      } catch {
        if (attempt === 2) throw new Error("Não foi possível contactar o servidor da dashboard.");
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`Exportação remota: HTTP ${response.status}. ${response.status === 401 ? "Credencial de acesso rejeitada." : "O lote não foi concluído."}`);
      const result = await response.json();
      if (result.ok !== true || result.stage !== stage || JSON.stringify(result.period) !== JSON.stringify(period) || !Array.isArray(result.rows) || result.rows.length > limit) {
        throw new Error("O servidor devolveu um lote inválido ou com filtros diferentes.");
      }
      if (result.rows.some((r: unknown) => !r || typeof r !== "object" || typeof (r as { id?: unknown }).id !== "string" || !(r as { id: string }).id)) throw new Error("Lote sem identificadores válidos.");
      return result.rows as T[];
    }
    throw new Error("Não foi possível obter o lote.");
  }
  return page;
}

export function createRemotePriceReader(origin: string, secret: string, period: Period, fetcher: typeof fetch = fetch): PricePageReader {
  const page = createRemoteExportPageReader(origin, secret, period, "/api/exports/initial-booking-price", fetcher);
  return { bookings: (cursor, limit) => page<BookingRow>("bookings", cursor, limit), history: (cursor, limit) => page<HistoryRow>("history", cursor, limit) };
}
