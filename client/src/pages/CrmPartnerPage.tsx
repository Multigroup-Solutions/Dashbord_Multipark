/**
 * CRM fase 3 — página de um PARCEIRO (agregador ou agência), lida ao vivo da
 * BD da Multipark (/clientes/parceiros/:userId).
 * Agregadores: ficam com a percentagem deles; no fim do mês mandamos-lhes o
 * extrato e faturamos o NOSSO (mês = entrada do carro). Agências: a
 * percentagem é nossa e vão pagando. A comissão deles é margem, não custo.
 */
import { Link, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Loader2 } from "lucide-react";
import { Pill, eur, monthYear, num } from "@/components/crm/crmUi";
import { Card, CrmNotesCard, Kpi, MonthsTable, RecentTable, TopClients } from "@/components/crm/PartnerBlocks";

export const PARTNER_TYPE_LABEL: Record<string, string> = { AGGREGATOR: "Agregador", AGENCY: "Agência", PARTNER: "Parceiro" };

export default function CrmPartnerPage() {
  const { id } = useParams<{ id: string }>();
  const q = trpc.crm.partner.useQuery({ userId: id ?? "" }, { enabled: !!id, retry: false });

  if (q.isLoading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (q.error) return <Back message={q.error.message} />;
  const d = q.data;
  if (!d) return <Back message="Parceiro não encontrado." />;
  if (!d.available) return <Back message={d.reason} />;
  const p = d.partner;
  const fees = [...new Set(p.parks.map((x) => x.feePct).filter((x): x is number => x != null))].sort((a, b) => a - b);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="ghost" asChild><Link href="/clientes"><ChevronLeft className="h-4 w-4" />Clientes</Link></Button>
        <h1 className="font-display text-[22px] font-bold tracking-[-0.02em]">{p.name}</h1>
        <Pill className="bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">{PARTNER_TYPE_LABEL[p.type] ?? p.type}</Pill>
        {fees.length > 0 && <Pill className="bg-secondary text-secondary-foreground">Ficam com {fees.join(" / ")} %</Pill>}
        {!p.active && <Pill className="bg-muted text-muted-foreground">inativo</Pill>}
        {p.since && <Pill className="bg-muted text-foreground">desde {monthYear(p.since)}</Pill>}
      </div>
      <p className="-mt-2 text-[13px] text-muted-foreground">
        {p.type === "AGGREGATOR"
          ? "Cobram o cliente e ficam com a percentagem deles. No fim do mês mandamos o extrato e faturamos o que é nosso (reservas pelo mês de entrada)."
          : "A percentagem é nossa; vão pagando. O que é nosso vem já em cada reserva da Multipark."}
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Este mês (entradas)" value={num(d.thisMonth.bookings - d.thisMonth.cancelled)} note={`${eur(d.thisMonth.value, 2)} · nosso ${eur(d.thisMonth.ours, 2)}`} />
        <Kpi label="Últimos 12 meses" value={num(d.last12.bookings - d.last12.cancelled)} note={`reservas · ${num(d.last12.cancelled)} canceladas`} />
        <Kpi label="Valor (12 meses)" value={eur(d.last12.value, 2)} note={`comissão deles ${eur(d.last12.commission, 2)}`} />
        <Kpi label="Nosso (12 meses)" value={eur(d.last12.ours, 2)} note={d.last12.paid ? `pago registado ${eur(d.last12.paid, 2)}` : "o que nos cabe"} />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card title="Mês a mês"><MonthsTable months={d.months} mode="partner" /></Card>
          <Card title={`Últimas reservas (${num(d.recent.length)})`}><RecentTable rows={d.recent} mode="partner" /></Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card title="Parques e percentagens">
            {p.parks.map((x) => (
              <div key={x.partnerId} className="flex justify-between gap-2 text-[13px]">
                <span className={x.active ? "" : "text-muted-foreground line-through"}>{x.parkName}</span>
                <span className="text-muted-foreground">{x.feeType === "FIXED" ? eur(x.feeFixed, 2) : x.feePct != null ? `${x.feePct} %` : "—"}{!x.active ? " · inativo" : ""}</span>
              </div>
            ))}
          </Card>
          <Card title="Dados fiscais">
            <div className="flex justify-between gap-3 text-[13px]"><span className="text-muted-foreground">Nome fiscal</span><strong className="truncate text-right">{p.taxName ?? "—"}</strong></div>
            <div className="flex justify-between gap-3 text-[13px]"><span className="text-muted-foreground">NIF</span><strong>{p.taxNumber ?? "—"}</strong></div>
            {p.taxAddress && <div className="text-[13px] text-muted-foreground">{p.taxAddress}</div>}
          </Card>
          <CrmNotesCard kind="partner" mpId={p.userId} link={d.link} canEdit={d.canEdit} partnership={d.partnership} partnerships={d.partnerships} onSaved={() => q.refetch()} />
          <Card title="Clientes que vieram por eles"><TopClients rows={d.topClients} /></Card>
        </div>
      </div>
      {!d.canSeeTotals && <p className="text-xs text-muted-foreground">Os valores em euros só aparecem a quem vê totais financeiros.</p>}
      <p className="text-xs text-muted-foreground">Lido ao vivo da BD da Multipark.</p>
    </div>
  );
}

function Back({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <p className="text-sm font-semibold">{message}</p>
      <Button variant="outline" asChild><Link href="/clientes"><ChevronLeft className="h-4 w-4" />Voltar aos clientes</Link></Button>
    </div>
  );
}
