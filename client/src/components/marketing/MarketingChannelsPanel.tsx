/**
 * Marketing → Canais e clientes (Jorge, 24 set 2026) — ver server/marketingChannels.ts.
 *
 *  - De onde vêm as reservas e quanto custa cada canal (gasto Google Ads,
 *    comissões dos parceiros).
 *  - Ligação ao CRM: clientes novos por canal de entrada (canal da 1.ª
 *    reserva), custo por cliente novo, peso dos repetentes e quanto vale um
 *    cliente de cada canal.
 */
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import DateRangeNav from "@/components/DateRangeNav";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Handshake, Repeat, ShoppingCart, UserPlus } from "lucide-react";

function lisbonDay(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
const eur = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: digits, minimumFractionDigits: digits });
const num = (v: number | null | undefined, digits = 0) => (v == null ? "—" : Number(v).toLocaleString("pt-PT", { maximumFractionDigits: digits }));
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

function Kpi({ icon: Icon, label, value, hint }: { icon: any; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

/** Barra de quota (uma só cor, com o valor escrito ao lado — nunca só cor). */
function Share({ value, total }: { value: number; total: number }) {
  const w = total > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary" style={{ width: `${w}%` }} /></div>
      <span className="text-xs tabular-nums text-muted-foreground w-9 text-right">{pct(value, total)}</span>
    </div>
  );
}

export default function MarketingChannelsPanel() {
  const today = lisbonDay();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const { projectId } = useGlobalFilters();
  const { data, isLoading, error } = trpc.marketing.channels.useQuery({ from, to, projectId });

  const channels = (data?.channels ?? []).filter((c) => c.bookings > 0 || c.newClients > 0);
  const total = data?.bookingsTotal ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground max-w-2xl">
          Reservas pela data de criação, sem canceladas. Custo = gasto do Google Ads e comissões dos parceiros (as das Parcerias). Um cliente é um email, como no <Link href="/clientes" className="underline">CRM</Link>; o canal de entrada é o da sua primeira reserva.
        </p>
        <DateRangeNav start={from} end={to} gran="month" showAll={false} onChange={(s, e) => { setFrom(s); setTo(e); }} />
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {isLoading && <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Kpi icon={ShoppingCart} label="Reservas" value={num(total)} hint={data.bookingsWithoutEmail ? `${num(data.bookingsWithoutEmail)} sem email (fora dos clientes)` : "todas com email"} />
            <Kpi icon={UserPlus} label="Clientes novos" value={num(data.newClients)} hint="primeira reserva neste período" />
            <Kpi icon={Repeat} label="Reservas de repetentes" value={num(data.returningBookings)} hint={`${pct(data.returningBookings, total)} das reservas vêm de quem já tinha reservado`} />
            <Kpi icon={Handshake} label="Comissões de parceiros" value={eur(data.partners.reduce((s, p) => s + p.commission, 0))} hint={`${data.partners.length} parceiro(s) com reservas`} />
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">De onde vêm as reservas</CardTitle></CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Canal</TableHead>
                    <TableHead className="text-right">Reservas</TableHead>
                    <TableHead>Quota</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead className="text-right">Custo</TableHead>
                    <TableHead className="text-right">Custo / reserva</TableHead>
                    <TableHead className="text-right">Clientes novos</TableHead>
                    <TableHead className="text-right">Custo / cliente novo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {channels.length === 0 && <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Sem reservas no período.</TableCell></TableRow>}
                  {channels.map((c) => (
                    <TableRow key={c.key}>
                      <TableCell className="font-medium">
                        {c.label}
                        {c.key === "google_ads" && data.googleConversions > c.bookings && (
                          <div className="text-[11px] font-normal text-muted-foreground" title="A Google conta as conversões com a tag do site; nós só ligamos as reservas em que o gclid chega. Custo por conversão Google em vez do custo por reserva ligada.">
                            a Google conta {num(Math.round(data.googleConversions))} conversões · {eur(c.cost != null && data.googleConversions > 0 ? c.cost / data.googleConversions : null, 2)}/conv.
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num(c.bookings)}</TableCell>
                      <TableCell><Share value={c.bookings} total={total} /></TableCell>
                      <TableCell className="text-right tabular-nums">{eur(c.revenue)}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.cost == null ? <span className="text-muted-foreground" title="Sem custo registado para este canal">—</span> : eur(c.cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{eur(c.costPerBooking, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(c.newClients)}</TableCell>
                      <TableCell className="text-right tabular-nums">{eur(c.costPerNewClient, 2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-[11px] text-muted-foreground px-4 py-2">
                Google Ads = reservas com prova de clique pago no link de origem (se a atribuição estiver partida, aparecem em "Site"; ver o Dashboard). Custo / cliente novo reparte todo o custo do canal pelos clientes novos — é o custo de aquisição.
              </p>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Quanto vale um cliente, por canal de entrada</CardTitle></CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Entrou por</TableHead>
                      <TableHead className="text-right">Clientes</TableHead>
                      <TableHead className="text-right">Reservas / cliente</TableHead>
                      <TableHead className="text-right">Voltaram</TableHead>
                      <TableHead className="text-right">Valor / cliente</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.valueByChannel.map((v) => (
                      <TableRow key={v.key}>
                        <TableCell className="font-medium">{v.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{num(v.clients)}</TableCell>
                        <TableCell className="text-right tabular-nums">{num(v.avgBookings, 1)}</TableCell>
                        <TableCell className="text-right tabular-nums">{Math.round(v.repeatRate * 100)}%</TableCell>
                        <TableCell className="text-right tabular-nums">{eur(v.avgValue)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-[11px] text-muted-foreground px-4 py-2">Todo o histórico dos clientes (não só o período). Valor = estadias em que o carro entrou no parque. Compara com o custo por cliente novo: se o valor não paga a aquisição, o canal não compensa.</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Parceiros no período</CardTitle></CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Parceiro</TableHead>
                      <TableHead className="text-right">Reservas</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead className="text-right">Taxa</TableHead>
                      <TableHead className="text-right">Comissão</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.partners.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Sem reservas de parceiros no período.</TableCell></TableRow>}
                    {data.partners.slice(0, 20).map((p) => (
                      <TableRow key={p.name}>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{num(p.bookings)}</TableCell>
                        <TableCell className="text-right tabular-nums">{eur(p.revenue)}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.commissionRate}%</TableCell>
                        <TableCell className="text-right tabular-nums">{eur(p.commission)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
