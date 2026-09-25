/**
 * Métricas dos Extras (ponto 12) + extras parados há mais de 90 dias (ponto 13).
 * Mostrado no hub de Disponibilidades (gestão).
 */
import { useMemo, useState } from "react";
import { ExportToSheetsButton } from "@/components/google/DriveActions";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DeactivationDialog } from "@/components/DeactivationDialog";
import { BarChart3, Loader2, UserX } from "lucide-react";
import { toast } from "sonner";

const CITIES = [
  { id: "lisbon", label: "Lisboa" },
  { id: "porto", label: "Porto" },
  { id: "faro", label: "Faro" },
] as const;
type CityId = (typeof CITIES)[number]["id"];

const eur = (n: number) => n.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const WEEKDAY = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const wd = (iso: string) => WEEKDAY[new Date(`${iso}T12:00:00Z`).getUTCDay()];

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export function ExtrasMetricsSection() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const globalFilters = useGlobalFilters();
  const [days, setDays] = useState<number>(30);
  const allowedCities = CITIES.filter((c) => globalFilters.cities.some((p) => p.name.toLowerCase() === c.label.toLowerCase()));
  const [city, setCity] = useState<CityId | null>(null);
  const activeCity: CityId = city ?? allowedCities[0]?.id ?? "lisbon";

  const metrics = trpc.extrasDia.metrics.useQuery({ days });
  const outlook = trpc.extrasDia.coverageOutlook.useQuery({ city: activeCity, days: 7 });

  const canDeactivate = ["admin", "super_admin"].includes(user?.role ?? "");
  const [deactivate, setDeactivate] = useState<{ id: number; name: string } | null>(null);
  const setActive = trpc.rh.setActive.useMutation({
    onSuccess: () => {
      toast.success("Extra desativado");
      setDeactivate(null);
      utils.extrasDia.metrics.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const m = metrics.data;
  const nextWeek = m?.responseRate[m.responseRate.length - 1];
  const noShowTotal = useMemo(() => (m?.noShows ?? []).reduce((s, n) => s + n.confirmed, 0), [m]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" /> Métricas dos extras
            </CardTitle>
            <CardDescription>
              {m ? `De ${dm(m.period.from)} a ${dm(m.period.to)}` : "A carregar…"} · só as tuas cidades
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="30">Últimos 30 dias</SelectItem>
                <SelectItem value="90">Últimos 90 dias</SelectItem>
              </SelectContent>
            </Select>
            <ExportToSheetsButton input={{ report: "extras_metricas", days }} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {metrics.isLoading && (
          <div className="py-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        )}
        {metrics.error && <div className="text-sm text-red-600">{metrics.error.message}</div>}
        {m && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Tile
                label="Responderam (próxima semana)"
                value={nextWeek ? pct(nextWeek.responded, nextWeek.total) : "—"}
                sub={nextWeek ? `${nextWeek.responded} de ${nextWeek.total} extras` : undefined}
              />
              <Tile
                label="Custo previsto (escala)"
                value={eur(m.cost.planned)}
                sub={`${m.cost.plannedHours}h escaladas`}
              />
              <Tile
                label="Custo pago (ponto)"
                value={eur(m.cost.paid)}
                sub={`${m.cost.paidHours}h de ponto · ${m.cost.planned > 0 ? `${m.cost.paid >= m.cost.planned ? "+" : ""}${Math.round(((m.cost.paid - m.cost.planned) / m.cost.planned) * 100)}% vs previsto` : "sem escala"}`}
              />
              <Tile
                label="Candidatura → 1.º turno"
                value={m.timeToFirstShift.medianDays != null ? `${Math.round(m.timeToFirstShift.medianDays)} dias` : "—"}
                sub={`mediana · ${m.timeToFirstShift.worked} de ${m.timeToFirstShift.approved} aprovados já trabalharam`}
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <div className="text-sm font-medium mb-2">Resposta ao pedido de disponibilidade</div>
                <table className="w-full text-sm">
                  <tbody>
                    {m.responseRate.map((w, i) => (
                      <tr key={w.weekStart} className="border-b last:border-0">
                        <td className="py-1.5">Semana de {dm(w.weekStart)}{i === m.responseRate.length - 1 ? " (próxima)" : i === m.responseRate.length - 2 ? " (esta)" : ""}</td>
                        <td className="py-1.5 text-right tabular-nums">{w.responded}/{w.total}</td>
                        <td className="py-1.5 text-right tabular-nums w-14 font-medium">{pct(w.responded, w.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="text-sm font-medium">Cobertura dos próximos 7 dias (horas-condutor)</div>
                  {allowedCities.length > 1 && (
                    <Select value={activeCity} onValueChange={(v) => setCity(v as CityId)}>
                      <SelectTrigger className="h-8 w-[110px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {allowedCities.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {outlook.isLoading ? (
                  <div className="text-sm text-muted-foreground">A calcular previsão…</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground border-b">
                        <th className="text-left py-1 font-normal">Dia</th>
                        <th className="text-right py-1 font-normal">Previstas</th>
                        <th className="text-right py-1 font-normal">Escaladas</th>
                        <th className="text-right py-1 font-normal"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(outlook.data ?? []).map((d) => {
                        const short = d.neededHours > 0 && d.scheduledHours < d.neededHours;
                        return (
                          <tr key={d.date} className="border-b last:border-0">
                            <td className="py-1.5">{wd(d.date)} {dm(d.date)}</td>
                            <td className="py-1.5 text-right tabular-nums">{d.neededHours}h</td>
                            <td className="py-1.5 text-right tabular-nums">{d.scheduledHours}h</td>
                            <td className="py-1.5 text-right">
                              {d.neededHours === 0 ? (
                                <span className="text-xs text-muted-foreground">sem reservas</span>
                              ) : short ? (
                                <Badge variant="outline" className="border-red-300 text-red-700">faltam {d.neededHours - d.scheduledHours}h</Badge>
                              ) : (
                                <Badge variant="outline" className="border-emerald-300 text-emerald-700">coberto</Badge>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <div className="text-sm font-medium mb-2">Faltas por extra <span className="text-muted-foreground font-normal">({noShowTotal} confirmadas)</span></div>
                {m.noShows.length === 0 ? (
                  <div className="text-sm text-muted-foreground">Sem faltas no período. 👌</div>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {m.noShows.map((n) => (
                        <tr key={n.employeeId} className="border-b last:border-0">
                          <td className="py-1.5">{n.fullName}</td>
                          <td className="py-1.5 text-right tabular-nums">{n.confirmed} confirmada(s)</td>
                          <td className="py-1.5 text-right tabular-nums text-muted-foreground">{n.pending ? `${n.pending} por rever` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div>
                <div className="text-sm font-medium mb-2">
                  Parados há mais de 90 dias <span className="text-muted-foreground font-normal">({m.stale.length})</span>
                </div>
                {m.stale.length === 0 ? (
                  <div className="text-sm text-muted-foreground">Todos os extras ativos trabalharam nos últimos 90 dias.</div>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground mb-2">Sugestão: desativar quem já não conta — sai dos pedidos de disponibilidade e da escala.</p>
                    <table className="w-full text-sm">
                      <tbody>
                        {m.stale.slice(0, 30).map((s) => (
                          <tr key={s.employeeId} className="border-b last:border-0">
                            <td className="py-1.5">{s.fullName}</td>
                            <td className="py-1.5 text-right text-muted-foreground text-xs">
                              {s.lastWorked ? `último trabalho ${dm(s.lastWorked)}` : "nunca trabalhou"} · {s.idleDays} dias
                            </td>
                            <td className="py-1.5 text-right">
                              {canDeactivate && (
                                <Button size="sm" variant="ghost" className="h-7 text-red-600" onClick={() => setDeactivate({ id: s.employeeId, name: s.fullName })}>
                                  <UserX className="h-3.5 w-3.5 mr-1" /> Desativar
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {m.stale.length > 30 && <div className="text-xs text-muted-foreground mt-1">…e mais {m.stale.length - 30}</div>}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
      <DeactivationDialog
        open={deactivate != null}
        subjectName={deactivate?.name ?? ""}
        subjectKind="colaborador"
        effectNote="Sai dos pedidos de disponibilidade e da escala; o login fica bloqueado."
        pending={setActive.isPending}
        onOpenChange={(o) => { if (!o) setDeactivate(null); }}
        onConfirm={(values) => deactivate && setActive.mutate({ id: deactivate.id, isActive: false, ...values })}
      />
    </Card>
  );
}
