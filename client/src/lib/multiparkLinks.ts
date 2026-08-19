// Link para abrir uma reserva NO painel da Multipark (botão "Ver na
// Multipark"). Formato CONFIRMADO pelo Jorge com um URL real do painel:
//   https://www.multipark.app/pt-PT/agent/booking/<externalId>?tab=booking
export const multiparkBookingUrl = (externalId: string) =>
  `https://www.multipark.app/pt-PT/agent/booking/${encodeURIComponent(externalId)}?tab=booking`;

export function openInMultipark(externalId: string | null | undefined) {
  if (!externalId) return;
  window.open(multiparkBookingUrl(externalId), "_blank", "noopener");
}
