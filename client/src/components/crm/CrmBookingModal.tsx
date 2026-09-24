import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { openInMultipark } from "@/lib/multiparkLinks";
import type { CrmBooking } from "@shared/crm";
import { amount, crmDate } from "./CrmWorkspace";
export function CrmBookingModal({
  booking,
  close,
  demo,
}: {
  booking?: CrmBooking;
  close: () => void;
  demo?: boolean;
}) {
  return (
    <Dialog
      open={!!booking}
      onOpenChange={open => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Reserva {booking?.number ?? booking?.externalId}
          </DialogTitle>
          <DialogDescription>
            {demo
              ? "Reserva fictícia para demonstração."
              : "Dados da reserva sincronizada na Multipark."}
          </DialogDescription>
        </DialogHeader>
        {booking && (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-2 gap-3">
              <dt>Cliente</dt>
              <dd>{booking.name}</dd>
              <dt>Parque</dt>
              <dd>
                {booking.park} · {booking.city}
              </dd>
              <dt>Entrada prevista</dt>
              <dd>{crmDate(booking.checkIn)}</dd>
              <dt>Saída prevista</dt>
              <dd>{crmDate(booking.checkOut)}</dd>
              <dt>Estado</dt>
              <dd>{booking.status}</dd>
              <dt>Matrícula</dt>
              <dd>{booking.plate ?? "—"}</dd>
              {booking.value != null && booking.currency && (
                <>
                  <dt>Valor da reserva</dt>
                  <dd>{amount(booking.value, booking.currency)}</dd>
                </>
              )}
            </dl>
            {!demo && (
              <Button
                variant="outline"
                className="crm-button"
                onClick={() => openInMultipark(booking.externalId)}
              >
                Abrir reserva na Multipark
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
