import { trpc } from "@/lib/trpc";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMemo, useState } from "react";
import { AlertTriangle, Bug } from "lucide-react";
import { STICKY_FIRST_COL } from "@/components/finance/layoutClasses";
import { rangeFor } from "@/components/DateRangeNav";

const fmt = (v: number) =>
  new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(Number.isFinite(v) ? v : 0);

export default function BillingDiagnosePage() {
  const filters = useGlobalFilters();
  // Mês corrente em dias locais — o mesmo da Faturação. (Com toISOString, no
  // horário de verão o mês começava e acabava um dia antes: 30 set → 30 out.)
  const month = rangeFor("month", new Date());

  const [from, setFrom] = useState(month.start);
  const [to, setTo] = useState(month.end);

  const projectId = useMemo(() => {
    if (filters.brandId !== null) return filters.brandId;
    if (filters.cityId !== null) return filters.cityId;
    return undefined;
  }, [filters.cityId, filters.brandId]);

  const { data, isLoading, error, refetch, isFetching } = trpc.invoices.diagnose.useQuery({ from, to, projectId }, {
    // sem permissão / pedido inválido mostra logo o erro; falha passageira tenta mais 2 vezes
    retry: (count, err) => count < 2 && !["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"].includes(String((err as { data?: { code?: string } })?.data?.code ?? "")),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="basis-full lg:basis-0 lg:flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
            <Bug className="w-5 h-5 shrink-0 text-amber-600" /> Diagnóstico de Faturação
          </h1>
          <p className="text-sm text-muted-foreground">
            Compara várias somas de receita com filtros progressivos para isolar onde os números divergem.
          </p>
        </div>
        <div className="flex-1 min-w-[9.5rem] sm:flex-none">
          <Label className="text-xs mb-1 block">De</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full sm:w-[160px] h-9" />
        </div>
        <div className="flex-1 min-w-[9.5rem] sm:flex-none">
          <Label className="text-xs mb-1 block">Até</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full sm:w-[160px] h-9" />
        </div>
        <Button onClick={() => refetch()} disabled={isFetching} className="w-full sm:w-auto">{isFetching ? "A atualizar…" : "Atualizar"}</Button>
      </div>

      {filters.brandId === null && filters.cityId === null && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-3 text-sm">
            <AlertTriangle className="w-4 h-4 inline mr-1 text-amber-600" />
            Sem filtro de marca/cidade ativo — o diagnóstico cobre <strong>todos</strong> os nossos parques. Escolhe
            uma cidade ou marca no topo da aplicação para focar.
          </CardContent>
        </Card>
      )}

      {error && !data ? (
        // Erro ≠ "sem dados": a BD da Multipark sem resposta ou sem permissão diz-se como é
        <Card className="border-red-200 bg-red-50/50">
          <CardContent className="p-3 text-sm text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">Não foi possível fazer o diagnóstico.</p>
              <p className="text-xs mt-0.5 break-words">{error.message}</p>
              <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" disabled={isFetching} onClick={() => refetch()}>
                {isFetching ? "A tentar…" : "Tentar de novo"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : isLoading || !data ? (
        <p className="text-sm text-muted-foreground">A carregar...</p>
      ) : (
        <>
          {/* Filtros progressivos */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Somas com filtros progressivos</CardTitle>
              <p className="text-xs text-muted-foreground">
                A "Faturação" usa o filtro mais restritivo (a última linha). Compara com cada passo para ver onde aparece a diferença.
              </p>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto"><table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="p-2">Filtro</th>
                    <th className="p-2 text-right">Bookings</th>
                    <th className="p-2 text-right">Receita</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="p-2">saída no período (dia de Lisboa), qualquer estado</td>
                    <td className="p-2 text-right tabular-nums">{data.sumByCheckoutPeriod.count}</td>
                    <td className="p-2 text-right tabular-nums">{fmt(data.sumByCheckoutPeriod.sum)}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="p-2">+ status = 'CHECKED_OUT' (receita realizada)</td>
                    <td className="p-2 text-right tabular-nums">{data.sumExcludingCancelled.count}</td>
                    <td className="p-2 text-right tabular-nums">{fmt(data.sumExcludingCancelled.sum)}</td>
                  </tr>
                  <tr className="border-b bg-emerald-50 font-medium">
                    <td className="p-2">+ filtro de projeto/hierarquia <Badge variant="outline" className="text-[11px] ml-1">USADO NA FATURAÇÃO</Badge></td>
                    <td className="p-2 text-right tabular-nums">{data.sumWithProjectFilter.count}</td>
                    <td className="p-2 text-right tabular-nums">{fmt(data.sumWithProjectFilter.sum)}</td>
                  </tr>
                </tbody>
              </table></div>
              {data.projectIds && (
                <p className="text-xs text-muted-foreground mt-2">
                  Projeto expandido para IDs: <code>{data.projectIds.join(", ")}</code>
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                Canceladas no período: <strong>{data.cancelledCount} bookings, {fmt(data.cancelledSum)}</strong>
              </p>
            </CardContent>
          </Card>

          {/* Breakdown por projeto */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Receita por projeto (com filtros finais aplicados)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto"><table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="p-2">Projeto</th>
                    <th className="p-2 text-right">Bookings</th>
                    <th className="p-2 text-right">Receita</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byProject.map((p, i) => (
                    <tr key={i} className="border-b hover:bg-muted/50">
                      <td className="p-2">
                        {p.projectName ?? <span className="text-muted-foreground">— sem projeto —</span>}
                        <span className="text-[11px] text-muted-foreground ml-1">#{p.projectId ?? "null"}</span>
                      </td>
                      <td className="p-2 text-right tabular-nums">{p.count}</td>
                      <td className="p-2 text-right tabular-nums">{fmt(p.sum)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </CardContent>
          </Card>

          {/* Breakdown por campaign */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Receita por campaign</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto"><table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="p-2">Campaign</th>
                    <th className="p-2 text-right">Bookings</th>
                    <th className="p-2 text-right">Receita</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byCampaign.map((c, i) => (
                    <tr key={i} className="border-b hover:bg-muted/50">
                      <td className="p-2">
                        {c.campaign ? <code>{c.campaign}</code> : <span className="text-muted-foreground">— null —</span>}
                      </td>
                      <td className="p-2 text-right tabular-nums">{c.count}</td>
                      <td className="p-2 text-right tabular-nums">{fmt(c.sum)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </CardContent>
          </Card>

          {/* By status */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Por estado da reserva</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto"><table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="p-2">Status</th>
                    <th className="p-2 text-right">Bookings</th>
                    <th className="p-2 text-right">Receita</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byStatus.map((s, i) => (
                    <tr key={i} className="border-b hover:bg-muted/50">
                      <td className="p-2">{s.status ?? "—"}</td>
                      <td className="p-2 text-right tabular-nums">{s.count}</td>
                      <td className="p-2 text-right tabular-nums">{fmt(s.sum)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </CardContent>
          </Card>

          {/* Top 20 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top 20 bookings por valor</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className={`w-full text-xs whitespace-nowrap ${STICKY_FIRST_COL}`}>
                  <thead>
                    <tr className="border-b text-left uppercase text-muted-foreground">
                      <th className="p-2">externalId</th>
                      <th className="p-2">Nº Reserva</th>
                      <th className="p-2">Projeto</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">checkOut</th>
                      <th className="p-2 text-right">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topBookings.map((b) => (
                      <tr key={b.id} className="border-b">
                        <td className="p-2 font-mono">{b.externalId.slice(0, 16)}</td>
                        <td className="p-2">{b.bookingNumber ?? "—"}</td>
                        <td className="p-2">{b.projectName ?? "—"}</td>
                        <td className="p-2">{b.status ?? "—"}</td>
                        <td className="p-2">{b.checkOut?.slice(0, 16) ?? "—"}</td>
                        <td className="p-2 text-right tabular-nums">{fmt(b.totalPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
