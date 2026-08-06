// Link para abrir uma reserva NO backoffice da Multipark (pedido Jorge:
// botão "Ver na Multipark" nos detalhes). O formato do URL vive SÓ aqui —
// se o backoffice deles usar outro caminho, muda-se esta linha.
export const multiparkBookingUrl = (externalId: string) =>
  `https://multipark.web.app/reservations/${encodeURIComponent(externalId)}`;

export function openInMultipark(externalId: string | null | undefined) {
  if (!externalId) return;
  window.open(multiparkBookingUrl(externalId), "_blank", "noopener");
}
