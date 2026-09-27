/**
 * Parcerias (fase 6) — tabs lidas AO VIVO da BD da Multipark:
 *   - Parceiros: agências e agregadores dos nossos parques (taxa, reservas,
 *     valor e o nosso — "partnerAmountDue"), ligados ao nosso registo das
 *     Parcerias (contrato/notas/contacto) e à página do CRM;
 *   - Parques: os nossos e os de terceiros em que somos o marketplace
 *     (divisão 80 % parque / 20 % nosso — shared/marketplace.ts);
 *   - Pró e avenças: SÓ informativa (a conta corrente é do CRM Pro).
 * Servidor: server/multiparkDb/partnerships.ts e partnershipsPro.ts.
 */
import { Fragment, useMemo, useState } from "react";
import { Link } from "wouter";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { STICKY_FIRST_COL } from "@/components/finance/layoutClasses";
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Link2, Loader2, Pencil, Plus, Unlink } from "lucide-react";
import { getPartnerType } from "@shared/partnerTypes";
import { toast } from "sonner";

type Out = inferRouterOutputs<AppRouter>["partnerships"];
type LiveOk = Extract<Out["live"], { available: true }>;
type LivePartnerRow = LiveOk["partners"][number];
type ProOk = Extract<Out["proLive"], { available: true }>;

/** Registo das Parcerias (nossa BD) — o que a lista `partnerships.list` devolve. */
export interface PartnershipRecord { id: number; name: string; partnerType: string | null; multiparkPartnerId?: string | null; contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null; notes?: string | null; [k: string]: unknown }

const eur = (v: number | null | undefined) => v == null ? "—" : new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);
const int = (v: number) => v.toLocaleString("pt-PT");
const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("pt-PT", { month: "short", year: "numeric", timeZone: "UTC" });
};
const TYPE_LABEL: Record<string, string> = { AGGREGATOR: "Agregador", AGENCY: "Agência", PARTNER: "Parceiro" };
/** Tipo do nosso registo ao criar a partir de um parceiro da Multipark. */
export const RECORD_TYPE_FOR: Record<string, string> = { AGGREGATOR: "agregador", AGENCY: "agencia_viagem" };
/** Tipos dos registos que pertencem à tab Parceiros (vista de recurso sem a BD da Multipark). */
const PARTNER_RECORD_TYPES = new Set(["agregador", "agencia_viagem"]);

function Unavailable({ reason }: { reason: string }) {
  return (
    <p role="status" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{reason} A lista abaixo mostra só os nossos registos.</span>
    </p>
  );
}

function Loading() {
  return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
}

function feeText(p: { feeType: string | null; feePct: number | null; feeFixed: number | null }): string | null {
  if (p.feeType === "FIXED" && p.feeFixed != null) return eur(p.feeFixed);
  if (p.feePct != null) return `${p.feePct.toLocaleString("pt-PT")} %`;
  if (p.feeFixed != null) return eur(p.feeFixed);
  return null;
}

// ─── Parceiros ──────────────────────────────────────────────────────────────

export function PartnersLiveTab({ records, onEdit, onCreate }: {
  records: PartnershipRecord[];
  onEdit: (record: PartnershipRecord) => void;
  onCreate: (prefill: { name: string; partnerType: string; multiparkPartnerId: string }) => void;
}) {
  const q = trpc.partnerships.live.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const [type, setType] = useState<"all" | "AGGREGATOR" | "AGENCY" | "PARTNER">("all");
  const [search, setSearch] = useState("");

  if (q.isLoading) return <Loading />;
  if (q.error) return <p role="alert" className="text-sm text-destructive">{q.error.message}</p>;
  const d = q.data;
  if (!d || !d.available) {
    const own = records.filter((r) => PARTNER_RECORD_TYPES.has(r.partnerType ?? ""));
    return (
      <div className="space-y-3">
        <Unavailable reason={d?.reason ?? "A BD da Multipark não está disponível."} />
        <RecordsFallback records={own} onEdit={onEdit} />
      </div>
    );
  }

  const t = search.trim().toLowerCase();
  const rows = d.partners.filter((p) => (type === "all" || p.type === type) && (!t || p.name.toLowerCase().includes(t)));
  const counts = { all: d.partners.length, AGGREGATOR: 0, AGENCY: 0, PARTNER: 0 } as Record<string, number>;
  for (const p of d.partners) counts[p.type] = (counts[p.type] ?? 0) + 1;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Agências de viagens e agregadores dos nossos parques, lidos ao vivo da Multipark. Mês = entrada do carro (Lisboa).
        <strong> Nosso</strong> = o valor devido gravado na reserva (o parceiro fica com o resto).
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {(["all", "AGGREGATOR", "AGENCY", "PARTNER"] as const).map((k) => (counts[k] || k === "all") ? (
          <button key={k} onClick={() => setType(k)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${type === k ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted border-input"}`}>
            {k === "all" ? "Todos" : TYPE_LABEL[k]} <span className="opacity-80 tabular-nums">{counts[k] ?? 0}</span>
          </button>
        ) : null)}
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Procurar parceiro…" className="h-8 w-full sm:ml-auto sm:w-56" aria-label="Procurar parceiro" />
      </div>
      {rows.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Sem parceiros para mostrar.</Card>
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="p-2">Parceiro</th>
                  <th className="p-2">Parques · taxa</th>
                  <th className="p-2 text-right" colSpan={3}>Este mês ({monthLabel(d.periods.thisMonth)})</th>
                  <th className="p-2 text-right" colSpan={3}>Últimos 12 meses</th>
                  <th className="p-2">Registo</th>
                </tr>
                <tr className="border-b text-right text-[11px] text-muted-foreground">
                  <th /><th />
                  <th className="p-1">Reservas</th><th className="p-1">Valor</th><th className="p-1">Nosso</th>
                  <th className="p-1">Reservas</th><th className="p-1">Valor</th><th className="p-1">Nosso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => <PartnerRow key={p.userId} p={p} records={records} onEdit={onEdit} onCreate={onCreate} />)}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function PartnerRow({ p, records, onEdit, onCreate }: {
  p: LivePartnerRow; records: PartnershipRecord[];
  onEdit: (record: PartnershipRecord) => void;
  onCreate: (prefill: { name: string; partnerType: string; multiparkPartnerId: string }) => void;
}) {
  const utils = trpc.useUtils();
  const link = trpc.partnerships.linkMultipark.useMutation({
    onSuccess: () => { utils.partnerships.live.invalidate(); utils.partnerships.list.invalidate(); },
    onError: (e) => toast.error(e.message || "Não foi possível ligar o registo"),
  });
  const record = p.record ? records.find((r) => r.id === p.record!.id) ?? null : null;
  const candidates = useMemo(() => records.filter((r) => !r.multiparkPartnerId).sort((a, b) => a.name.localeCompare(b.name, "pt")), [records]);
  const missing = (n: number) => n > 0 ? <span className="block text-[10px] text-amber-700 dark:text-amber-400" title="Reservas sem valor devido gravado na Multipark">{n} sem devido</span> : null;

  return (
    <tr className="border-b align-top hover:bg-muted/40">
      <td className="p-2 min-w-[11rem] max-w-[16rem]">
        <span className="font-medium break-words">{p.name}</span>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <Badge variant="outline" className="text-[11px]">{TYPE_LABEL[p.type] ?? p.type}</Badge>
          {!p.active && <Badge variant="secondary" className="text-[11px]">Inativo</Badge>}
          <a href={`/clientes/parceiros/${encodeURIComponent(p.userId)}`} className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">
            Ficha no CRM <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </td>
      <td className="p-2 min-w-[10rem]">
        <ul className="space-y-0.5 text-xs">
          {p.parks.map((x) => (
            <li key={x.partnerId} className={x.active ? "" : "text-muted-foreground line-through"}>
              {x.parkName}{feeText(x) ? <span className="text-muted-foreground"> · {feeText(x)}</span> : null}
            </li>
          ))}
        </ul>
      </td>
      <td className="p-2 text-right tabular-nums">{int(p.thisMonth.bookings)}</td>
      <td className="p-2 text-right tabular-nums">{eur(p.thisMonth.value)}</td>
      <td className="p-2 text-right tabular-nums font-medium">{eur(p.thisMonth.ours)}{missing(p.thisMonth.missing)}</td>
      <td className="p-2 text-right tabular-nums">{int(p.last12.bookings)}</td>
      <td className="p-2 text-right tabular-nums">{eur(p.last12.value)}</td>
      <td className="p-2 text-right tabular-nums font-medium">{eur(p.last12.ours)}{missing(p.last12.missing)}</td>
      <td className="p-2 min-w-[11rem]">
        {p.record ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs font-medium break-words">{p.record.name}</span>
            {record && (
              <Button size="sm" variant="ghost" className="h-7 px-1.5" aria-label={`Editar registo ${p.record.name}`} onClick={() => onEdit(record)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 px-1.5" aria-label="Desligar registo" title="Desligar deste parceiro"
              disabled={link.isPending} onClick={() => link.mutate({ id: p.record!.id, multiparkPartnerId: null })}>
              <Unlink className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            <select aria-label={`Ligar ${p.name} a um registo`} className="h-7 max-w-[10rem] rounded-md border bg-background px-1 text-xs" value=""
              disabled={link.isPending}
              onChange={(e) => { const id = Number(e.target.value); if (id) link.mutate({ id, multiparkPartnerId: p.userId }); }}>
              <option value="">Ligar a registo…</option>
              {candidates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
              onClick={() => onCreate({ name: p.name, partnerType: RECORD_TYPE_FOR[p.type] ?? "outro", multiparkPartnerId: p.userId })}>
              <Plus className="mr-0.5 h-3 w-3" /> Criar
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

function RecordsFallback({ records, onEdit }: { records: PartnershipRecord[]; onEdit: (r: PartnershipRecord) => void }) {
  if (!records.length) return <Card className="p-8 text-center text-sm text-muted-foreground">Sem registos de agências nem agregadores.</Card>;
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {records.map((r) => (
        <Card key={r.id} className="flex items-start gap-2 p-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium break-words">{r.name}</p>
            <Badge variant="outline" className="mt-0.5 text-[11px]">{getPartnerType(r.partnerType ?? "outro").label}</Badge>
            {(r.contactName || r.contactEmail || r.contactPhone) && (
              <p className="mt-1 text-xs text-muted-foreground break-words">{[r.contactName, r.contactEmail, r.contactPhone].filter(Boolean).join(" · ")}</p>
            )}
          </div>
          <Button size="sm" variant="ghost" aria-label={`Editar ${r.name}`} onClick={() => onEdit(r)}><Pencil className="h-4 w-4" /></Button>
        </Card>
      ))}
    </div>
  );
}

// ─── Parques ────────────────────────────────────────────────────────────────

export function ParksLiveTab() {
  const q = trpc.partnerships.live.useQuery(undefined, { retry: false, staleTime: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <p role="alert" className="text-sm text-destructive">{q.error.message}</p>;
  const d = q.data;
  if (!d || !d.available) {
    return (
      <p role="status" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {d?.reason ?? "A BD da Multipark não está disponível."}
      </p>
    );
  }
  const month = monthLabel(d.periods.thisMonth);
  const pct = Math.round(d.marketplaceRate * 100);
  return (
    <Tabs defaultValue="ours" className="space-y-3">
      <TabsList>
        <TabsTrigger value="ours">Nossos <span className="ml-1 opacity-70 tabular-nums">{d.parks.ours.length}</span></TabsTrigger>
        <TabsTrigger value="third">Terceiros (marketplace) <span className="ml-1 opacity-70 tabular-nums">{d.parks.third.length}</span></TabsTrigger>
      </TabsList>
      <TabsContent value="ours">
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="p-2">Parque</th><th className="p-2">Cidade</th>
                  <th className="p-2 text-right">Reservas ({month})</th>
                  <th className="p-2 text-right">Das quais de parceiros</th>
                  <th className="p-2 text-right">Valor</th>
                </tr>
              </thead>
              <tbody>
                {d.parks.ours.map((p) => (
                  <tr key={p.id} className="border-b hover:bg-muted/40">
                    <td className="p-2 font-medium">{p.label}<span className="block text-[11px] font-normal text-muted-foreground">{p.name}</span></td>
                    <td className="p-2 text-muted-foreground">{p.city ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums">{int(p.bookings)}</td>
                    <td className="p-2 text-right tabular-nums">{int(p.partnerBookings)}</td>
                    <td className="p-2 text-right tabular-nums">{eur(p.value)}</td>
                  </tr>
                ))}
                {d.parks.ours.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Sem parques nossos no teu âmbito.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </TabsContent>
      <TabsContent value="third" className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Parques de terceiros em que <strong>nós somos o marketplace</strong>: só as reservas que nós lhes levámos, entradas em {month}.
          Divisão do valor: <strong>{100 - pct} % parque / {pct} % nosso</strong> (regra única, a tornar configurável por parque).
          A comissão gravada na Multipark aparece ao lado só para comparar.
        </p>
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="p-2">Parque</th><th className="p-2">Cidade</th>
                  <th className="p-2 text-right">Reservas</th><th className="p-2 text-right">Valor</th>
                  <th className="p-2 text-right">Parque ({100 - pct} %)</th><th className="p-2 text-right">Nosso ({pct} %)</th>
                  <th className="p-2 text-right" title='"commissionAmount" das reservas na Multipark'>Comissão gravada</th>
                </tr>
              </thead>
              <tbody>
                {d.parks.third.map((p) => (
                  <tr key={p.id} className="border-b hover:bg-muted/40">
                    <td className="p-2 min-w-[10rem]">
                      <span className="font-medium break-words">{p.name}</span>
                      <a href={`/clientes/parques/${encodeURIComponent(p.id)}`} className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">
                        Ficha no CRM <ExternalLink className="h-3 w-3" />
                      </a>
                      {p.status && p.status !== "ACTIVE" && <Badge variant="secondary" className="ml-1 text-[10px]">{p.status}</Badge>}
                    </td>
                    <td className="p-2 text-muted-foreground">{p.city ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums">{int(p.bookings)}</td>
                    <td className="p-2 text-right tabular-nums">{eur(p.value)}</td>
                    <td className="p-2 text-right tabular-nums">{eur(p.parkShare)}</td>
                    <td className="p-2 text-right tabular-nums font-medium">{eur(p.ourShare)}</td>
                    <td className="p-2 text-right tabular-nums text-muted-foreground">{eur(p.commission)}</td>
                  </tr>
                ))}
                {d.parks.third.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Sem parques de terceiros no teu âmbito.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

// ─── Pró e avenças (informativo) ────────────────────────────────────────────

export function ProLiveTab() {
  const q = trpc.partnerships.proLive.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <p role="alert" className="text-sm text-destructive">{q.error.message}</p>;
  const d = q.data;
  if (!d || !d.available) {
    return (
      <p role="status" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {d?.reason ?? "A BD da Multipark não está disponível."}
      </p>
    );
  }
  const rows: ProOk["rows"] = d.rows;
  const month = monthLabel(d.periods.thisMonth);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <strong>Só informativo</strong> (não é contabilidade): reservas dos clientes Pro e das avenças, a <strong>entrar</strong> (mês da entrada)
        e a <strong>sair</strong> (mês da saída), em Lisboa. A conta corrente dos Pro está no CRM (Clientes › Pro).
      </p>
      {rows.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Sem clientes Pro nem avenças no teu âmbito.</Card>
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="p-2">Conta</th>
                  <th className="p-2 text-right" colSpan={2}>Entradas {month}</th>
                  <th className="p-2 text-right" colSpan={2}>Saídas {month}</th>
                  <th className="p-2 text-right" colSpan={2}>Entradas 12 meses</th>
                  <th className="p-2 text-right" colSpan={2}>Saídas 12 meses</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const id = `${r.kind}:${r.key}`;
                  const isOpen = open === id;
                  return (
                    <Fragment key={id}>
                      <tr className="border-b align-top hover:bg-muted/40 cursor-pointer" onClick={() => setOpen(isOpen ? null : id)}>
                        <td className="p-2 min-w-[12rem] max-w-[18rem]">
                          <span className="inline-flex items-start gap-1">
                            {isOpen ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                            <span className="font-medium break-words">{r.name}</span>
                          </span>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1 pl-4">
                            <Badge variant="outline" className="text-[11px]">{r.kind === "pro" ? "Pro" : "Avença"}</Badge>
                            {!r.active && <Badge variant="secondary" className="text-[11px]">Inativo</Badge>}
                            {r.detail && <span className="text-[11px] text-muted-foreground">{r.detail}</span>}
                            {r.price != null && <span className="text-[11px] text-muted-foreground">{eur(r.price)}{r.cadence ? ` / ${r.cadence.toLowerCase()}` : ""}</span>}
                            {r.crmClientId != null && (
                              <Link href={`/clientes/${r.crmClientId}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">
                                <Link2 className="h-3 w-3" /> Conta no CRM
                              </Link>
                            )}
                          </div>
                          {r.parks.length > 0 && <p className="pl-4 text-[11px] text-muted-foreground">{r.parks.join(" · ")}</p>}
                        </td>
                        <td className="p-2 text-right tabular-nums">{int(r.thisMonth.inBookings)}</td>
                        <td className="p-2 text-right tabular-nums">{eur(r.thisMonth.inValue)}</td>
                        <td className="p-2 text-right tabular-nums">{int(r.thisMonth.outBookings)}</td>
                        <td className="p-2 text-right tabular-nums">{eur(r.thisMonth.outValue)}</td>
                        <td className="p-2 text-right tabular-nums">{int(r.last12.inBookings)}</td>
                        <td className="p-2 text-right tabular-nums">{eur(r.last12.inValue)}</td>
                        <td className="p-2 text-right tabular-nums">{int(r.last12.outBookings)}</td>
                        <td className="p-2 text-right tabular-nums">{eur(r.last12.outValue)}</td>
                      </tr>
                      {isOpen && r.months.map((m) => (
                        <tr key={`${id}:${m.month}`} className="border-b bg-muted/20 text-xs">
                          <td className="p-1.5 pl-8 capitalize">{monthLabel(m.month)}</td>
                          <td className="p-1.5 text-right tabular-nums">{int(m.inBookings)}</td>
                          <td className="p-1.5 text-right tabular-nums">{eur(m.inValue)}</td>
                          <td className="p-1.5 text-right tabular-nums">{int(m.outBookings)}</td>
                          <td className="p-1.5 text-right tabular-nums">{eur(m.outValue)}</td>
                          <td colSpan={4} />
                        </tr>
                      ))}
                      {isOpen && r.months.length === 0 && (
                        <tr className="border-b bg-muted/20 text-xs"><td colSpan={9} className="p-1.5 pl-8 text-muted-foreground">Sem reservas nos últimos 12 meses.</td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
