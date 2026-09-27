/**
 * CRM fase 3 — peças das páginas de parceiro e de parque (dados ao vivo da
 * Multipark): mês a mês, últimas reservas, clientes que vieram e o cartão do
 * CRM (notas, contacto, ligação às Parcerias).
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExternalLink } from "lucide-react";
import { monthLabel } from "@shared/crmPro";
import { BookingStatusPill, ClientAvatar, Lbl, eur, num, shortDate } from "./crmUi";
import type { CrmMonthRow, CrmRecentBooking } from "./crmTypes";

export function Card({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-[10px] border bg-card p-4", className)}>
      <div className="flex items-center"><span className="flex-1 font-display text-[15px] font-bold">{title}</span>{action}</div>
      {children}
    </div>
  );
}

export function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[10px] border bg-card p-3.5">
      <Lbl>{label}</Lbl>
      <span className="font-display text-2xl font-bold">{value}</span>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

/** Mês a mês (mês da ENTRADA do carro). `mode`: parceiro (valor, comissão deles, nosso) ou parque (valor, nossa comissão). */
export function MonthsTable({ months, mode }: { months: CrmMonthRow[]; mode: "partner" | "park" }) {
  if (!months.length) return <p className="text-sm text-muted-foreground">Sem reservas nos últimos 24 meses.</p>;
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead>
          <tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground">
            <th className="px-4 py-2">Mês (entrada)</th><th className="px-3 py-2 text-right">Reservas</th><th className="px-3 py-2 text-right">Canceladas</th>
            <th className="px-3 py-2 text-right">Valor</th>
            {mode === "partner"
              ? <><th className="px-3 py-2 text-right">Comissão deles</th><th className="px-3 py-2 text-right">Nosso</th><th className="px-3 py-2 text-right">Pago</th></>
              : <th className="px-3 py-2 text-right">Nossa comissão</th>}
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month} className="border-t">
              <td className="px-4 py-2 font-semibold capitalize">{monthLabel(m.month)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{num(m.bookings - m.cancelled)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{m.cancelled ? num(m.cancelled) : ""}</td>
              <td className="px-3 py-2 text-right tabular-nums">{eur(m.value, 2)}</td>
              {mode === "partner"
                ? <>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{eur(m.commission, 2)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{eur(m.ours, 2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.paid ? eur(m.paid, 2) : ""}</td>
                  </>
                : <td className="px-3 py-2 text-right font-semibold tabular-nums">{eur(m.commission, 2)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RecentTable({ rows, mode }: { rows: (Omit<CrmRecentBooking, "parkName"> & { parkName?: string | null })[]; mode: "partner" | "park" }) {
  const [limit, setLimit] = useState(40);
  if (!rows.length) return <p className="text-sm text-muted-foreground">Sem reservas.</p>;
  return (
    <>
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground">
              <th className="px-4 py-2">Reserva</th><th className="px-3 py-2">Entrada → saída</th><th className="px-3 py-2">Cliente</th>
              {mode === "partner" && <th className="px-3 py-2">Parque</th>}
              <th className="px-3 py-2">Estado</th><th className="px-3 py-2 text-right">Valor</th>
              <th className="px-3 py-2 text-right">{mode === "partner" ? "Nosso" : "Nossa comissão"}</th><th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((b) => (
              <tr key={b.id} className="border-t align-top">
                <td className="px-4 py-2 font-semibold">{b.code ? `N.º ${b.code}` : b.id.slice(0, 10)}{b.plate && <div className="font-mono text-xs font-normal text-muted-foreground">{b.plate}</div>}</td>
                <td className="whitespace-nowrap px-3 py-2">{shortDate(b.checkIn)} → {shortDate(b.checkOut)}</td>
                <td className="px-3 py-2">{b.client ? <Link href={`/clientes/${b.client.id}`} className="font-semibold text-primary hover:underline">{b.client.name ?? b.clientName ?? "Ficha"}</Link> : b.clientName ?? "—"}</td>
                {mode === "partner" && <td className="px-3 py-2 text-muted-foreground">{b.parkName ?? ""}</td>}
                <td className="px-3 py-2"><BookingStatusPill status={b.status} /></td>
                <td className="px-3 py-2 text-right tabular-nums">{eur(b.value, 2)}{mode === "partner" && b.feePct != null && <div className="text-xs text-muted-foreground">{b.feePct} % deles</div>}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{eur(mode === "partner" ? b.ours : b.marketplaceCommission, 2)}</td>
                <td className="px-3 py-2 text-right"><a href={b.multiparkUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-primary hover:underline">Multipark<ExternalLink className="h-3 w-3" /></a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && <Button variant="ghost" size="sm" className="self-center" onClick={() => setLimit(limit + 40)}>Mostrar mais</Button>}
    </>
  );
}

export function TopClients({ rows }: { rows: { key: string; clientId: number | null; name: string; bookings: number }[] }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">Sem clientes nas últimas reservas.</p>;
  return (
    <div className="flex flex-col">
      {rows.map((c) => (
        <div key={c.key} className="flex items-center gap-2.5 p-1.5 text-[13px]">
          <ClientAvatar name={c.name} size={28} />
          <span className="min-w-0 flex-1 truncate">{c.clientId ? <Link href={`/clientes/${c.clientId}`} className="font-semibold text-primary hover:underline">{c.name}</Link> : c.name}</span>
          <span className="text-xs text-muted-foreground">{num(c.bookings)} {c.bookings === 1 ? "reserva" : "reservas"}</span>
        </div>
      ))}
      <p className="mt-1 text-xs text-muted-foreground">Das últimas 200 reservas. Com ligação quando já há ficha no CRM.</p>
    </div>
  );
}

type LinkData = { notes: string | null; contactName: string | null; contactEmail: string | null; contactPhone: string | null } | null;

/** Cartão do CRM: contacto, notas e (parceiros) ligação ao registo nas Parcerias. */
export function CrmNotesCard({ kind, mpId, link, canEdit, partnership, partnerships, onSaved }: {
  kind: "partner" | "park"; mpId: string; link: LinkData; canEdit: boolean;
  partnership?: { id: number; name: string; how: string; contactName: string | null; contactEmail: string | null; contactPhone: string | null } | null;
  partnerships?: { id: number; name: string }[];
  onSaved: () => void;
}) {
  const init = () => ({
    notes: link?.notes ?? "", contactName: link?.contactName ?? "", contactEmail: link?.contactEmail ?? "", contactPhone: link?.contactPhone ?? "",
    partnershipId: partnership && partnership.how === "manual" ? String(partnership.id) : "auto",
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [link, partnership]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = trpc.crm.saveExternalLink.useMutation({ onSuccess: () => { toast.success("Guardado"); onSaved(); }, onError: (e) => toast.error(e.message) });
  const t = (s: string) => (s.trim() ? s.trim() : null);
  return (
    <Card title="No CRM">
      {kind === "partner" && (
        <div className="text-[13px]">
          <Lbl>Nas Parcerias</Lbl>
          {partnership
            ? <div className="mt-1"><Link href="/parcerias" className="font-semibold text-primary hover:underline">{partnership.name}</Link>
                <span className="text-xs text-muted-foreground"> · {partnership.how === "manual" ? "ligado à mão" : partnership.how === "nif" ? "pelo NIF" : "pelo id da Multipark"}</span>
                {(partnership.contactName || partnership.contactEmail || partnership.contactPhone) && (
                  <div className="mt-0.5 text-xs text-muted-foreground">{[partnership.contactName, partnership.contactEmail, partnership.contactPhone].filter(Boolean).join(" · ")}</div>
                )}
              </div>
            : <div className="mt-1 text-xs text-muted-foreground">Sem registo ligado nas Parcerias.</div>}
          {canEdit && partnerships && (
            <Select value={f.partnershipId} onValueChange={(v) => setF({ ...f, partnershipId: v })}>
              <SelectTrigger className="mt-2 h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Ligar sozinho (id da Multipark ou NIF)</SelectItem>
                {partnerships.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      <div className="grid gap-2 text-[13px]">
        <Lbl>Contacto</Lbl>
        {canEdit ? (
          <>
            <Input className="h-8" placeholder="Nome" value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} />
            <Input className="h-8" placeholder="Email" type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} />
            <Input className="h-8" placeholder="Telefone" value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} />
          </>
        ) : <span>{[link?.contactName, link?.contactEmail, link?.contactPhone].filter(Boolean).join(" · ") || "—"}</span>}
      </div>
      <div className="grid gap-2 text-[13px]">
        <Lbl>Notas</Lbl>
        {canEdit
          ? <Textarea rows={4} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Condições combinadas, quem contactar, avisos…" />
          : <p className="whitespace-pre-wrap">{link?.notes ?? "—"}</p>}
      </div>
      {canEdit && (
        <div className="flex justify-end">
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({
            kind, mpId, partnershipId: f.partnershipId === "auto" ? null : Number(f.partnershipId),
            notes: t(f.notes), contactName: t(f.contactName), contactEmail: t(f.contactEmail), contactPhone: t(f.contactPhone),
          })}>Guardar</Button>
        </div>
      )}
    </Card>
  );
}
