/**
 * Diagnóstico da atribuição de reservas aos anúncios (Dashboard de Marketing).
 * A atribuição depende de o link de origem da reserva trazer o clique do
 * Google (gclid/gbraid/wbraid) — se se perde, o "via anúncios" e o ROAS real
 * ficam a zero e enganam. Só reservas feitas no site contam (as outras nunca
 * trazem clique).
 */
export type AttributionQuality = { siteBookings: number; withOriginUrl: number; withClickId: number; attributed: number };

/** Diagnóstico da atribuição — puro, para testes. */
export function attributionHealth(q: AttributionQuality, spend: number, googleConversions?: number | null): { level: "ok" | "warning" | "critical" | "none"; message: string } {
  if (q.siteBookings === 0) return { level: "none", message: "Sem reservas feitas no site neste período." };
  if (q.withOriginUrl / q.siteBookings < 0.5) {
    return { level: "warning", message: "Mais de metade das reservas do site não tem link de origem: sem link não há como saber se vieram dos anúncios. Pode ser o enriquecimento das reservas em atraso ou a Multipark a não enviar o URL." };
  }
  if (spend > 0 && q.withClickId === 0) {
    return { level: "critical", message: "Há gasto em anúncios mas nenhuma reserva traz o clique do Google (gclid): o identificador perde-se pelo caminho. Confirma o auto-tagging no Google Ads e se o site passa o gclid até ao checkout. Até lá, o \"via anúncios\" e o ROAS real ficam a zero." };
  }
  // A Google conta as conversões do lado dela (tag no site): se ligamos muito
  // menos reservas do que isso, o gclid perde-se em parte do caminho e os
  // números "via anúncios" ficam por baixo — as conversões da Google medem melhor.
  if (googleConversions != null && googleConversions >= MIN_CONVERSIONS_TO_COMPARE && q.attributed < googleConversions * MIN_MATCH_RATIO) {
    const share = Math.round((q.attributed / googleConversions) * 100);
    return {
      level: "warning",
      message: `A Google conta ${Math.round(googleConversions)} conversões e só conseguimos ligar ${q.attributed} reservas aos anúncios (${share}%): o gclid perde-se em parte das reservas. Até se corrigir, usa as conversões da Google como medida dos anúncios (custo por conversão, ROAS da Google).`,
    };
  }
  return { level: "ok", message: "As reservas do site trazem o clique do Google e batem com as conversões que a Google conta." };
}

/** Abaixo disto a comparação com as conversões da Google é ruído. */
export const MIN_CONVERSIONS_TO_COMPARE = 10;
/** Reservas atribuídas / conversões Google abaixo disto = atribuição incompleta. */
export const MIN_MATCH_RATIO = 0.7;

/** A medida de "resultados dos anúncios" a usar: as conversões da Google quando a nossa atribuição apanha menos. */
export function adResultsMeasure(attributed: number, googleConversions: number): { value: number; source: "google" | "bookings" } {
  return googleConversions > attributed ? { value: googleConversions, source: "google" } : { value: attributed, source: "bookings" };
}
