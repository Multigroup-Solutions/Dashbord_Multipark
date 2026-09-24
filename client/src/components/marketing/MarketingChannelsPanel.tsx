/**
 * Marketing → Canais e clientes (Jorge, 24 set 2026) — ver server/marketingChannels.ts.
 *
 *  - De onde vêm as reservas: grupo "Anúncios Google" (Marketplace, site das
 *    marcas, telefone; custo = gasto Google Ads), parceiros (comissões),
 *    campanhas sem parceiro e outros. O gclid é só prova de clique.
 *  - Ligação ao CRM: clientes novos por canal de entrada (canal da 1.ª
 *    reserva), custo por cliente novo, peso dos repetentes e quanto vale um
 *    cliente de cada canal.
 */
import { Fragment, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import DateRangeNav from "@/components/DateRangeNav";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Handshake, Repeat, ShoppingCart, UserPlus } from "lucide-react";
import { STICKY_FIRST_COL } from "@/components/finance/layoutClasses";
import FitAmount from "@/components/finance/FitAmount";
import { eurCompact } from "@/lib/financeFormat";

function lisbonDay(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
const eur = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: digits, minimumFractionDigits: digits });
const num = (v: number | null | undefined, digits = 0) => (v == null ? "—" : Number(v).toLocaleString("pt-PT", { maximumFractionDigits: digits }));
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

function Kpi({ icon: Icon, label, value, compact, hint }: { icon: any; label: string; value: string; compact?: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-3 min-w-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="w-3.5 h-3.5 shrink-0" /> {label}</div>
      <FitAmount full={value} compact={compact ?? value} className="text-xl sm:text-2xl font-bold mt-1" />
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

  const groups = (data?.groups ?? []).filter((g) => g.bookings > 0 || g.newClients > 0);
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
            <Kpi icon={Handshake} label="Comissões de parceiros" value={eur(data.partners.reduce((s, p) => s + p.commission, 0))} compact={eurCompact(data.partners.reduce((s, p) => s + p.commission, 0))} hint={`${data.partners.length} parceiro(s) com reservas`} />
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">De onde vêm as reservas</CardTitle></CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table className={`tabular-nums ${STICKY_FIRST_COL}`}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Canal</TableHead>
                    <TableHead className="text-right">Reservas</TableHead>
                    <TableHead>Quota</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead className="text-right" title="Reservas com gclid/utm pago no link de origem — prova de clique, não decide o canal">Com prova de clique</TableHead>
                    <TableHead className="text-right">Custo</TableHead>
                    <TableHead className="text-right">Custo / reserva</TableHead>
                    <TableHead className="text-right">Clientes novos</TableHead>
                    <TableHead className="text-right">Custo / cliente novo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.length === 0 && <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Sem reservas no período.</TableCell></TableRow>}
                  {groups.map((g) => (
                    <Fragment key={g.key}>
                      <TableRow className="bg-muted/40">
                        <TableCell className="font-semibold">
                          {g.label}
                          {g.key === "anuncios" && data.googleConversions > 0 && (
                            <div className="text-[11px] font-normal text-muted-foreground">
                              a Google conta {num(Math.round(data.googleConversions))} conversões · {eur(g.cost != null ? g.cost / data.googleConversions : null, 2)}/conv.
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{num(g.bookings)}</TableCell>
                        <TableCell><Share value={g.bookings} total={total} /></TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{eur(g.revenue)}</TableCell>
                        <TableCell className="text-right tabular-nums">{g.key === "anuncios" || g.key === "organico" ? num(g.paidProof) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{g.cost == null ? <span className="text-muted-foreground" title="Sem custo registado">—</span> : eur(g.cost)}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{eur(g.costPerBooking, 2)}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{num(g.newClients)}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{eur(g.costPerNewClient, 2)}</TableCell>
                      </TableRow>
                      {g.channels.length > 1 && g.channels.filter((c) => c.bookings > 0 || c.newClients > 0).map((c) => (
                        <TableRow key={c.key}>
                          <TableCell className="pl-8 text-sm">{c.label}</TableCell>
                          <TableCell className="text-right tabular-nums">{num(c.bookings)}</TableCell>
                          <TableCell><Share value={c.bookings} total={total} /></TableCell>
                          <TableCell className="text-right tabular-nums">{eur(c.revenue)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{num(c.paidProof)}</TableCell>
                          <TableCell className="text-right text-muted-foreground" colSpan={2}>—</TableCell>
                          <TableCell className="text-right tabular-nums">{num(c.newClients)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
              <p className="text-[11px] text-muted-foreground px-4 py-2">
                Marketplace, site das marcas e telefone: a reserva de um cliente novo (1.ª reserva daquele email, ou sem email) conta como <b>Anúncios Google</b> — custo = gasto do Google Ads (detalhe por marca no separador Google Ads); a de quem já era cliente conta como <b>Orgânico</b>. "Com prova de clique" = reservas em que o gclid chegou (só informação). Custo / cliente novo = custo do grupo ÷ clientes novos que entraram por ele.
              </p>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Quanto vale um cliente, por canal de entrada</CardTitle></CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table className={`tabular-nums ${STICKY_FIRST_COL}`}>
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
                <Table className={`tabular-nums ${STICKY_FIRST_COL}`}>
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
