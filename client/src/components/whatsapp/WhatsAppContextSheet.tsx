import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import { CalendarDays, Link2, Link2Off, MessageSquareWarning, Package, Search, UserRound, Clock } from "lucide-react";

/** 'YYYY-MM-DD HH:MM:SS' → DD/MM/AAAA (sem converter fuso: é só a data). */
function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s);
}

interface Props {
  conversationId: number | null;
  contactName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
}

/**
 * Contexto do contacto (ligar números desconhecidos): reserva ligada,
 * sugestões pelo telefone (reservas, reclamações, perdidos & achados) e
 * ligação manual a uma reserva ou a um cliente (email).
 */
export function WhatsAppContextSheet({ conversationId, contactName, open, onOpenChange, onLinked }: Props) {
  const enabled = open && conversationId != null;
  const ctx = trpc.whatsapp.context.useQuery({ conversationId: conversationId ?? 0 }, { enabled, retry: false });
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [email, setEmail] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) { setQ(""); setDebounced(""); setEmail(""); }
  }, [open]);
  const search = trpc.whatsapp.searchBookings.useQuery({ q: debounced }, { enabled: enabled && debounced.length >= 2, retry: false });

  const link = trpc.whatsapp.link.useMutation({
    onSuccess: () => {
      ctx.refetch();
      onLinked();
    },
    onError: (e) => toast.error(e.message),
  });

  const d = ctx.data;
  const linkedId = d?.linkedBooking?.id ?? null;

  function linkBooking(id: number) {
    if (conversationId == null) return;
    link.mutate({ conversationId, bookingId: id }, { onSuccess: () => toast.success("Conversa ligada à reserva.") });
  }

  function bookingRow(b: { id: number; bookingNumber: string | null; clientName: string; licensePlate: string | null; checkIn: string | null; checkOut: string | null; parkName: string | null; status: string | null }) {
    const isLinked = b.id === linkedId;
    return (
      <div key={b.id} className={`rounded-md border p-2 text-xs flex items-start gap-2 ${isLinked ? "border-green-500 bg-green-50 dark:bg-green-950/30" : ""}`}>
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">
            {b.clientName} {b.bookingNumber ? <span className="text-muted-foreground">· #{b.bookingNumber}</span> : null}
          </div>
          <div className="text-muted-foreground truncate">
            {fmtDate(b.checkIn)} → {fmtDate(b.checkOut)}
            {b.licensePlate ? ` · ${b.licensePlate}` : ""}
            {b.parkName ? ` · ${b.parkName}` : ""}
          </div>
          {b.status && <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{b.status}</div>}
        </div>
        {isLinked ? (
          <Badge className="bg-green-600 text-white shrink-0">Ligada</Badge>
        ) : (
          <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={link.isPending} onClick={() => linkBooking(b.id)}>
            <Link2 className="h-3.5 w-3.5 mr-1" /> Ligar
          </Button>
        )}
      </div>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <UserRound className="h-5 w-5 text-green-600" /> Contexto de {contactName}
          </SheetTitle>
          <SheetDescription>Reservas, reclamações e perdidos com o mesmo número — e ligação manual a uma reserva ou cliente.</SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-6">
          {ctx.isLoading && <p className="text-sm text-muted-foreground flex items-center gap-2"><Clock className="h-4 w-4 animate-spin" /> A procurar…</p>}
          {ctx.isError && <p className="text-sm text-red-600">{ctx.error.message}</p>}

          {d && (d.linkedBooking || d.linkedClientEmail) && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ligado a</h3>
              {d.linkedBooking && bookingRow(d.linkedBooking)}
              {d.linkedClientEmail && (
                <a className="block text-xs underline text-primary" href={`/clientes?email=${encodeURIComponent(d.linkedClientEmail)}`}>
                  Abrir ficha do cliente ({d.linkedClientEmail})
                </a>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={link.isPending}
                onClick={() => conversationId != null && link.mutate({ conversationId, bookingId: null, clientEmail: null }, { onSuccess: () => toast.success("Ligação removida.") })}
              >
                <Link2Off className="h-3.5 w-3.5 mr-1" /> Desligar
              </Button>
            </section>
          )}

          {d && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5" /> Reservas sugeridas · {d.bookings.length}
              </h3>
              {d.bookings.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nenhuma reserva com este número.</p>
              ) : (
                d.bookings.map(bookingRow)
              )}
            </section>
          )}

          {d && (d.complaints.length > 0 || d.lostFound.length > 0) && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Casos relacionados</h3>
              {d.complaints.map((c) => (
                <a key={`c${c.id}`} href={`/reclamacoes?id=${c.id}`} className="flex items-center gap-2 rounded-md border p-2 text-xs hover:bg-muted/50">
                  <MessageSquareWarning className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                  <span className="truncate flex-1">{c.title || `Reclamação #${c.id}`}</span>
                  <span className="text-muted-foreground shrink-0">{fmtDate(c.createdAt)}</span>
                </a>
              ))}
              {d.lostFound.map((l) => (
                <a key={`l${l.id}`} href={`/perdidos-achados/caso/${l.id}`} className="flex items-center gap-2 rounded-md border p-2 text-xs hover:bg-muted/50">
                  <Package className="h-3.5 w-3.5 text-violet-600 shrink-0" />
                  <span className="truncate flex-1">{l.description || `Perdido #${l.id}`}</span>
                  <span className="text-muted-foreground shrink-0">{fmtDate(l.createdAt)}</span>
                </a>
              ))}
            </section>
          )}

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ligar a uma reserva</h3>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                className="h-9 pl-8"
                placeholder="Nº da reserva, matrícula, email, nome…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            {debounced.length >= 2 && search.isLoading && <p className="text-xs text-muted-foreground">A pesquisar…</p>}
            {debounced.length >= 2 && search.data?.length === 0 && <p className="text-xs text-muted-foreground">Sem resultados.</p>}
            {search.data?.map(bookingRow)}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ou ligar a um cliente (email)</h3>
            <div className="flex gap-2">
              <Input
                type="email"
                className="h-9"
                placeholder="cliente@exemplo.pt"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-9 shrink-0"
                disabled={!email.trim() || link.isPending || conversationId == null}
                onClick={() =>
                  conversationId != null &&
                  link.mutate({ conversationId, clientEmail: email.trim() }, { onSuccess: () => { setEmail(""); toast.success("Conversa ligada ao cliente."); } })
                }
              >
                <Link2 className="h-3.5 w-3.5 mr-1" /> Ligar
              </Button>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
