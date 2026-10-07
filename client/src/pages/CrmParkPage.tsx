/**
 * CRM fase 3 — página de um PARQUE que não é nosso, em que somos o agregador
 * (marketplace), lida ao vivo da BD da Multipark (/clientes/parques/:parkId):
 * o dono e os contactos, as reservas que lhes levámos e a nossa comissão.
 */
import { Link, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ExternalLink, Loader2 } from "lucide-react";
import { Pill, eur, fmtPhone, monthYear, num } from "@/components/crm/crmUi";
import { telHref } from "@shared/phone";
import { Card, CrmNotesCard, Kpi, MonthsTable, RecentTable, TopClients } from "@/components/crm/PartnerBlocks";

const STATUS_LABEL: Record<string, string> = { ACTIVE: "ativo", PENDING: "pendente", INACTIVE: "inativo" };
const LISTING_LABEL: Record<string, string> = { ON_PLATFORM: "reservas pela plataforma", DIRECTORY: "só diretório" };

export default function CrmParkPage() {
  const { id } = useParams<{ id: string }>();
  const q = trpc.crm.park.useQuery({ parkId: id ?? "" }, { enabled: !!id, retry: false });

  if (q.isLoading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (q.error) return <Back message={q.error.message} />;
  const d = q.data;
  if (!d) return <Back message="Parque não encontrado." />;
  if (!d.available) return <Back message={d.reason} />;
  const p = d.park;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="ghost" asChild><Link href="/clientes"><ChevronLeft className="h-4 w-4" />Clientes</Link></Button>
        <h1 className="font-display text-[22px] font-bold tracking-[-0.02em]">{p.name}</h1>
        <Pill className="bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">Nós agregamos</Pill>
        {p.status && <Pill className={p.status === "ACTIVE" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" : "bg-muted text-muted-foreground"}>{STATUS_LABEL[p.status] ?? p.status}</Pill>}
        {p.listingType && <Pill className="bg-muted text-foreground">{LISTING_LABEL[p.listingType] ?? p.listingType}</Pill>}
        {p.createdAt && <Pill className="bg-muted text-foreground">desde {monthYear(p.createdAt)}</Pill>}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Este mês (entradas)" value={num(d.thisMonth.bookings)} note={`${eur(d.thisMonth.value, 2)} · nossa comissão ${eur(d.thisMonth.commission, 2)}`} />
        <Kpi label="Últimos 12 meses" value={num(d.last12.bookings)} note={`reservas · ${num(d.last12.cancelled)} canceladas`} />
        <Kpi label="Valor (12 meses)" value={eur(d.last12.value, 2)} note="reservas que lhes levámos" />
        <Kpi label="Nossa comissão (12 meses)" value={eur(d.last12.commission, 2)} note="o que nos cabe" />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card title="Mês a mês"><MonthsTable months={d.months} mode="park" /></Card>
          <Card title={`Últimas reservas (${num(d.recent.length)})`}><RecentTable rows={d.recent} mode="park" /></Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card title="Dono do parque">
            <Row label="Empresa">{p.companyName ?? p.taxName ?? "—"}</Row>
            <Row label="NIF">{p.nif ?? "—"}</Row>
            <Row label="Email">{p.email ? <a href={`mailto:${p.email}`} className="text-primary hover:underline">{p.email}</a> : "—"}</Row>
            <Row label="Telefone">{p.phone ? <a href={telHref(p.phone)} className="text-primary hover:underline">{fmtPhone(p.phone)}</a> : "—"}</Row>
            <Row label="Cidade">{[p.city, p.country].filter(Boolean).join(", ") || "—"}</Row>
            {p.address && <div className="text-[13px] text-muted-foreground">{p.address}</div>}
            {p.totalSpots != null && <Row label="Lugares">{num(p.totalSpots)}</Row>}
            {p.website && <a href={p.website.startsWith("http") ? p.website : `https://${p.website}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline">Site<ExternalLink className="h-3 w-3" /></a>}
          </Card>
          <CrmNotesCard kind="park" mpId={p.id} link={d.link} canEdit={d.canEdit} onSaved={() => q.refetch()} />
          <Card title="Clientes que lhes levámos"><TopClients rows={d.topClients} /></Card>
        </div>
      </div>
      {!d.canSeeTotals && <p className="text-xs text-muted-foreground">Os valores em euros só aparecem a quem vê totais financeiros.</p>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex justify-between gap-3 text-[13px]"><span className="text-muted-foreground">{label}</span><strong className="truncate text-right">{children}</strong></div>;
}

function Back({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <p className="text-sm font-semibold">{message}</p>
      <Button variant="outline" asChild><Link href="/clientes"><ChevronLeft className="h-4 w-4" />Voltar aos clientes</Link></Button>
    </div>
  );
}
