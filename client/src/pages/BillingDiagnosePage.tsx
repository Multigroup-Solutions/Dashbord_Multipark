import { trpc } from "@/lib/trpc";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Bug } from "lucide-react";

const fmt = (v: number) =>
  new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(Number.isFinite(v) ? v : 0);

export default function BillingDiagnosePage() {
  const filters = useGlobalFilters();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(monthEnd);

  const projectId = useMemo(() => {
    if (filters.brandId !== null) return filters.brandId;
    if (filters.cityId !== null) return filters.cityId;
    return undefined;
  }, [filters.cityId, filters.brandId]);

  const { data, isLoading, refetch } = trpc.invoices.diagnose.useQuery({ from, to, projectId });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bug className="w-5 h-5 text-amber-600" /> Diagnóstico de Faturação
          </h1>
          <p className="text-sm text-muted-foreground">
            Compara várias somas de receita com filtros progressivos para isolar onde os números divergem.
          </p>
        </div>
        <div>
          <Label className="text-xs mb-1 block">De</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[140px] h-9" />
        </div>
        <div>
          <Label className="text-xs mb-1 block">Até</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[140px] h-9" />
        </div>
        <Button onClick={() => refetch()}>Atualizar</Button>
      </div>

      {filters.brandId === null && filters.cityId === null && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-3 text-sm">
            <AlertTriangle className="w-4 h-4 inline mr-1 text-amber-600" />
            Sem filtro de marca/cidade activo — o diagnóstico cobre <strong>todos</strong> os projetos. Filtra
            no topo da aplicação por uma marca para focar em Airpark Lisboa.
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">A carregar...</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">Sem dados.</p>
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
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="p-2">Filtro</th>
                    <th className="p-2 text-right">Bookings</th>
                    <th className="p-2 text-right">Receita</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="p-2">checkOut no período</td>
                    <td className="p-2 text-right tabular-nums">{data.sumByCheckoutPeriod.count}</td>
                    <td className="p-2 text-right tabular-nums">{fmt(data.sumByCheckoutPeriod.sum)}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="p-2">+ checkOut IS NOT NULL</td>
                    <td className="p-2 text-right tabular-nums">{data.sumWithCheckoutNotNull.count}</td>
                    <td className="p-2 text-right tabular-nums">{fmt(data.sumWithCheckoutNotNull.sum)}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="p-2">+ status != 'CANCELLED' (exclui canceladas)</td>
                    <td className="p-2 text-right tabular-nums">{data.sumExcludingCancelled.count}</td>
                    <td className="p-2 text-right tabular-nums">{fmt(data.sumExcludingCancelled.sum)}</td>
                  </tr>
                  <tr className="border-b bg-emerald-50 font-medium">
                    <td className="p-2">+ filtro de projeto/hierarquia <Badge variant="outline" className="text-[10px] ml-1">USADO NA FATURAÇÃO</Badge></td>
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

          {/* Duplicados */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                {data.duplicatedExternalIds.length === 0 ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-red-600" />
                )}
                Duplicados em externalId
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm">
                Linhas totais: <strong>{data.rowsCount}</strong> · External IDs distintos: <strong>{data.distinctExternalIds}</strong>
              </p>
              {data.rowsCount !== data.distinctExternalIds ? (
                <>
                  <p className="text-sm text-red-700 mt-2">
                    <AlertTriangle className="w-4 h-4 inline mr-1" />
                    Há <strong>{data.rowsCount - data.distinctExternalIds}</strong> duplicados — a migration 0043 não terá sido aplicada.
                  </p>
                  {data.duplicatedExternalIds.length > 0 && (
                    <div className="mt-2 text-xs">
                      <p className="font-medium">Top duplicados:</p>
                      <ul className="list-disc list-inside text-muted-foreground">
                        {data.duplicatedExternalIds.map((d) => (
                          <li key={d.externalId}><code>{d.externalId}</code> · {d.count}x</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-emerald-700 mt-2">
                  <CheckCircle2 className="w-4 h-4 inline mr-1" />
                  Sem duplicados.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Breakdown por projeto */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Receita por projeto (com filtros finais aplicados)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto"><table className="w-full text-sm">
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
                        <span className="text-[10px] text-muted-foreground ml-1">#{p.projectId ?? "null"}</span>
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
              <div className="overflow-x-auto"><table className="w-full text-sm">
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
              <div className="overflow-x-auto"><table className="w-full text-sm">
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
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left uppercase text-muted-foreground">
                      <th className="p-2">externalId</th>
                      <th className="p-2">Nº Reserva</th>
                      <th className="p-2">Projeto</th>
                      <th className="p-2">Campaign</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">checkOut</th>
                      <th className="p-2">cancelledAt</th>
                      <th className="p-2 text-right">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topBookings.map((b) => (
                      <tr key={b.id} className="border-b">
                        <td className="p-2 font-mono">{b.externalId.slice(0, 16)}</td>
                        <td className="p-2">{b.bookingNumber ?? "—"}</td>
                        <td className="p-2">{b.projectName ?? "—"}</td>
                        <td className="p-2">{b.campaign ?? "—"}</td>
                        <td className="p-2">{b.status ?? "—"}</td>
                        <td className="p-2">{b.checkOut?.slice(0, 16) ?? "—"}</td>
                        <td className="p-2">{b.cancelledAt?.slice(0, 16) ?? "—"}</td>
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
