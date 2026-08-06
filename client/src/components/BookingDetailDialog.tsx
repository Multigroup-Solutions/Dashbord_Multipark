import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtBookingDateTime } from "@/lib/lisbonTime";

// Detalhe completo de uma reserva (partilhado: folhas de Operações, Serviços…).
// Mostra tudo o que a BD já tem — cliente, carro, voos, pagamento, origem,
// agentes — sem ir à API.

const fmtEur = (v: number | string | null | undefined) => {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
};

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  BOOKED: { label: "Reservada", color: "bg-blue-100 text-blue-800" },
  PENDING: { label: "Pendente", color: "bg-yellow-100 text-yellow-800" },
  PENDING_PAYMENT: { label: "Pend. Pagamento", color: "bg-yellow-100 text-yellow-800" },
  CONFIRMED: { label: "Confirmada", color: "bg-blue-100 text-blue-800" },
  CHECKED_IN: { label: "Check-in", color: "bg-green-100 text-green-800" },
  MOVING: { label: "Em Movimento", color: "bg-green-100 text-green-700" },
  CHECKED_OUT: { label: "Check-out", color: "bg-purple-100 text-purple-800" },
  PENDING_CHECKOUT: { label: "Pend. Check-out", color: "bg-purple-100 text-purple-700" },
  CANCELLED: { label: "Cancelada", color: "bg-red-100 text-red-800" },
  COMPLETED: { label: "Concluída", color: "bg-gray-100 text-gray-800" },
};

const VEHICLE_LABELS: Record<string, string> = {
  MOTORCYCLE: "Mota", CAR: "Carro", VAN: "Carrinha", TRUCK: "Camião",
};

export default function BookingDetailDialog({ booking: b, onClose }: { booking: any; onClose: () => void }) {
  const Row = ({ label, value, mono }: { label: string; value?: any; mono?: boolean }) => {
    if (value == null || value === "" || value === "—") return null;
    return (
      <div className="flex justify-between items-start gap-3 text-sm">
        <span className="text-muted-foreground shrink-0">{label}</span>
        <span className={`font-medium text-right min-w-0 break-words ${mono ? "font-mono text-xs" : ""}`}>{String(value)}</span>
      </div>
    );
  };
  const statusCfg = STATUS_MAP[b.status ?? ""];
  const toPay = parseFloat(b.remainingToPay) || 0;
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <Card className="w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
            <span className="font-mono">{b.bookingNumber || b.externalId}</span>
            <Badge className={statusCfg?.color || "bg-gray-100 text-gray-800"}>{statusCfg?.label || b.status}</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">{b.parkName} {b.city} · {b.parkingType ?? ""} {b.vehicleType ? `· ${VEHICLE_LABELS[b.vehicleType] ?? b.vehicleType}` : ""}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Cliente</p>
            <Row label="Nome" value={`${b.clientFirstName ?? ""} ${b.clientLastName ?? ""}`.trim()} />
            <Row label="Email" value={b.clientEmail} />
            <Row label="Telefone" value={b.clientPhone} />
            <Row label="NIF" value={b.clientNif} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Viatura</p>
            <Row label="Matrícula" value={b.licensePlate} mono />
            <Row label="Marca/Modelo" value={[b.vehicleBrand, b.vehicleModel].filter(Boolean).join(" ")} />
            <Row label="Cor" value={b.vehicleColor} />
            <Row label="Localização atual" value={[b.currentGarage, b.currentSpot].filter(Boolean).join(" · ")} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Datas & voos</p>
            <Row label="Recolha" value={fmtBookingDateTime(b.checkIn)} />
            <Row label="Entrega" value={fmtBookingDateTime(b.checkOut)} />
            <Row label="Voo chegada" value={b.arrivalFlight ?? b.returnFlight} mono />
            <Row label="Voo partida" value={b.departureFlight ?? b.departingFlight} mono />
            <Row label="Tipo entrega" value={b.deliveryType} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Pagamento</p>
            <Row label="Preço total" value={fmtEur(b.totalPrice)} />
            <Row label="Estacionamento" value={b.parkingPrice != null ? fmtEur(b.parkingPrice) : null} />
            <Row label="Delivery" value={parseFloat(b.deliveryCharges) > 0 ? fmtEur(b.deliveryCharges) : null} />
            <Row label="Serviços extra" value={parseFloat(b.extrasTotal) > 0 ? fmtEur(b.extrasTotal) : null} />
            <Row label="Desconto" value={parseFloat(b.discount) > 0 ? `−${fmtEur(b.discount)}` : null} />
            <Row label="Pago" value={b.totalPaid != null ? fmtEur(b.totalPaid) : null} />
            {toPay > 0 && <Row label="⚠ Por cobrar" value={fmtEur(toPay)} />}
            <Row label="Método" value={b.paymentMethod} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Origem & operação</p>
            <Row label="Origem" value={b.origin} />
            <Row label="Campanha" value={b.campaignName ?? b.campaign} />
            <Row label="Parceiro" value={b.salesPartnerName ?? b.partnerName} />
            {Number(b.salesPartnerCommission ?? 0) > 0 && (
              <Row label="Comissão parceiro" value={`${fmtEur(b.salesPartnerCommission)} (${b.salesPartnerRate}%)`} />
            )}
            <Row label="Check-in por" value={b.checkinAgentName} />
            <Row label="Check-out por" value={b.checkoutAgentName} />
            <Row label="Criada em" value={fmtBookingDateTime(b.bookingCreatedAt)} />
            <Row label="Observações" value={b.remarks} />
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>Fechar</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
