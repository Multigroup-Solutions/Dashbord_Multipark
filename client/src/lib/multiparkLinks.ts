// Link para abrir uma reserva NO painel da Multipark (pedido Jorge:
// botão "Ver na Multipark" nos detalhes). O formato do URL vive SÓ aqui.
// Painel: www.multipark.app/admin — a reserva abre pelo NÚMERO (ex.: 27060).
export const multiparkBookingUrl = (bookingNumber: string | number) =>
  `https://www.multipark.app/admin/reservations/${encodeURIComponent(String(bookingNumber))}`;

export function openInMultipark(bookingNumber: string | number | null | undefined) {
  if (bookingNumber == null || bookingNumber === "") return;
  window.open(multiparkBookingUrl(bookingNumber), "_blank", "noopener");
}
