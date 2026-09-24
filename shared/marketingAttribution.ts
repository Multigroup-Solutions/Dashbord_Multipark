/**
 * Diagnóstico da atribuição de reservas aos anúncios (Dashboard de Marketing).
 * A atribuição depende de o link de origem da reserva trazer o clique do
 * Google (gclid/gbraid/wbraid) — se se perde, o "via anúncios" e o ROAS real
 * ficam a zero e enganam. Só reservas feitas no site contam (as outras nunca
 * trazem clique).
 */
export type AttributionQuality = { siteBookings: number; withOriginUrl: number; withClickId: number; attributed: number };

/** Diagnóstico da atribuição — puro, para testes. */
export function attributionHealth(q: AttributionQuality, spend: number): { level: "ok" | "warning" | "critical" | "none"; message: string } {
  if (q.siteBookings === 0) return { level: "none", message: "Sem reservas feitas no site neste período." };
  if (q.withOriginUrl / q.siteBookings < 0.5) {
    return { level: "warning", message: "Mais de metade das reservas do site não tem link de origem: sem link não há como saber se vieram dos anúncios. Pode ser o enriquecimento das reservas em atraso ou a Multipark a não enviar o URL." };
  }
  if (spend > 0 && q.withClickId === 0) {
    return { level: "critical", message: "Há gasto em anúncios mas nenhuma reserva traz o clique do Google (gclid): o identificador perde-se pelo caminho. Confirma o auto-tagging no Google Ads e se o site passa o gclid até ao checkout. Até lá, o \"via anúncios\" e o ROAS real ficam a zero." };
  }
  return { level: "ok", message: "As reservas do site trazem link de origem e o clique do Google chega às reservas." };
}
