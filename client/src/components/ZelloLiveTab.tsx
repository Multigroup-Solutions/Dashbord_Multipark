// Mapa ao vivo do Zello (pedido Jorge): posições/velocidades de todos os
// condutores em tempo real (polling 30s), alertas visuais e ecrã de ligação
// Zello↔funcionário. Google Maps com marcadores e trânsito.
// 43a (Jorge, 7 out 2026: "o Atualizar não faz nada… isto aqui em cima é só
// confusão"): Atualizar lê tudo de novo (posições, ligações, PDAs) e volta a
// enquadrar o mapa; em cima, uma linha só e os alertas contados (abrem a lista).
import { useMemo, useState } from "react";
import { ZelloGoogleMap } from "@/components/maps/ZelloGoogleMap";
import { hasValidMapPosition, type ZelloMapPosition } from "@shared/zelloMap";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toast } from "sonner";
import { Satellite, Gauge, Battery, WifiOff, Link as LinkIcon, RefreshCw } from "lucide-react";
import { fmtPTTime } from "@/lib/lisbonTime";
import { retryTransient } from "@/lib/queryRetry";
import { QueryErrorNote } from "@/components/QueryErrorNote";
const SPEED_ALERT_KMH = 130;
const BATTERY_ALERT = 15;
const OFFLINE_ALERT_S = 3600;

type LiveLoc = ZelloMapPosition;

function markerColor(l: LiveLoc): string {
  if (l.lastReportDelay > OFFLINE_ALERT_S) return "#94a3b8"; // offline — cinza
  if (l.speed > SPEED_ALERT_KMH) return "#ef4444"; // vermelho
  if (l.batteryLevel > 0 && l.batteryLevel < BATTERY_ALERT) return "#f59e0b"; // laranja
  return "#10b981"; // verde
}

export function ZelloLiveTab() {
  const utils = trpc.useUtils();
  const locQ = trpc.operational.zello.locations.useQuery(undefined, { refetchInterval: 30_000, retry: retryTransient });
  const { data: locations = [], isFetching, refetch, dataUpdatedAt } = locQ;
  const usersQ = trpc.operational.zello.users.useQuery();
  const mappingsQ = trpc.operational.zello.mappings.useQuery(undefined, { refetchInterval: 60_000 });
  const zelloUsers = usersQ.data ?? [];
  const mappings = mappingsQ.data ?? [];
  const { data: employees = [] } = trpc.rh.list.useQuery({ isActive: true });
  const [fitSignal, setFitSignal] = useState(0);
  const [openAlert, setOpenAlert] = useState<string | null>(null);
  const refreshing = isFetching || usersQ.isFetching || mappingsQ.isFetching;
  /** Atualizar: tudo de novo (posições, utilizadores e PDAs do Zello, ligações) e o mapa volta a mostrar toda a gente. */
  const refreshAll = async () => {
    await Promise.all([refetch(), usersQ.refetch(), mappingsQ.refetch()]);
    setFitSignal((n) => n + 1);
  };

  // Resolução Zello→pessoa: o check-in de PDA do DIA ganha à ligação fixa
  // (os "Extra NNN" vivem nos PDAs e cada dia é uma pessoa diferente)
  const mapByZello = useMemo(() => {
    const m = new Map<string, { employeeId: number; fullName: string; source: "pda" | "fixed"; pdaName: string | null }>();
    const sorted = [...(mappings as any[])].sort((a, b) => (a.source === "pda" ? 1 : 0) - (b.source === "pda" ? 1 : 0));
    for (const r of sorted) {
      if (r.zelloUsername) m.set(String(r.zelloUsername).toLowerCase(), { employeeId: r.employeeId, fullName: r.fullName, source: r.source, pdaName: r.pdaName ?? null });
    }
    return m;
  }, [mappings]);

  // Utilizadores Zello que pertencem a PDAs (o check-in do dia manda; o dono
  // fixo fica com o GPS quando ninguém fez check-in). 43b: vem do servidor,
  // com TODOS os PDAs — um PDA de outra cidade já não parece telemóvel pessoal.
  const pdaByZello = useMemo(() => {
    const m = new Map<string, { pdaName: string }>();
    for (const u of zelloUsers as any[]) {
      if (u.pda) m.set(String(u.name).toLowerCase(), { pdaName: u.pda.name });
    }
    return m;
  }, [zelloUsers]);

  const realName = (l: { username: string; displayName: string }) =>
    mapByZello.get(l.username.toLowerCase())?.fullName || l.displayName || l.username;

  const live = (locations as LiveLoc[]).filter(hasValidMapPosition);
  // Alertas contados por tipo (a lista de nomes abre ao carregar)
  const alertGroups = useMemo(() => {
    const groups = [
      { key: "speed", icon: Gauge, label: `acima de ${SPEED_ALERT_KMH} km/h`, color: "border-red-300 bg-red-50 text-red-800", items: [] as string[] },
      { key: "battery", icon: Battery, label: `bateria abaixo de ${BATTERY_ALERT}%`, color: "border-amber-300 bg-amber-50 text-amber-800", items: [] as string[] },
      { key: "offline", icon: WifiOff, label: "sem reportar há mais de 1 h", color: "border-slate-300 bg-slate-50 text-slate-700", items: [] as string[] },
    ];
    for (const l of live) {
      const name = realName(l);
      if (l.speed > SPEED_ALERT_KMH) groups[0].items.push(`${name} a ${Math.round(l.speed)} km/h`);
      if (l.batteryLevel > 0 && l.batteryLevel < BATTERY_ALERT) groups[1].items.push(`${name} com ${l.batteryLevel}%`);
      if (l.lastReportDelay > OFFLINE_ALERT_S) groups[2].items.push(`${name} há ${Math.round(l.lastReportDelay / 3600)} h`);
    }
    return groups.filter((g) => g.items.length);
  }, [live, mapByZello]);

  const mapDrivers = live.map((l) => {
    const resolved = mapByZello.get(l.username.toLowerCase());
    return {
      ...l, name: realName(l), color: markerColor(l),
      pdaName: resolved?.source === "pda" ? resolved.pdaName ?? "" : undefined,
    };
  });

  // ── Ligação Zello ↔ funcionário ──
  const mapMutation = trpc.operational.zello.mapUserToEmployee.useMutation({
    onSuccess: () => {
      utils.operational.zello.mappings.invalidate();
      utils.operational.zello.users.invalidate();
      toast.success("Ligação guardada!");
    },
    onError: (e) => toast.error(e.message),
  });

  const employeeOptions = useMemo(
    () => (employees as any[]).map((e) => {
      const emp = e.employee ?? e;
      return { value: String(emp.id), label: emp.fullName };
    }),
    [employees]
  );

  const unmappedCount = (zelloUsers as any[]).filter(
    (u: any) => !u.gpsExcluded && !mapByZello.has(String(u.name).toLowerCase()) && !pdaByZello.has(String(u.name).toLowerCase())
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Satellite className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{locQ.error && !locQ.data ? "Sem posições" : `${live.length} no mapa`}</span>
        <span className="text-xs text-muted-foreground">
          {dataUpdatedAt ? `atualizado às ${fmtPTTime(dataUpdatedAt)}` : ""} · sozinho a cada 30 s
        </span>
        {alertGroups.map((g) => (
          <button key={g.key} type="button" onClick={() => setOpenAlert(openAlert === g.key ? null : g.key)} aria-expanded={openAlert === g.key}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${g.color}`}>
            <g.icon className="h-3 w-3" /> {g.items.length} {g.label}
          </button>
        ))}
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => void refreshAll()} disabled={refreshing}
          title="Lê de novo as posições, as ligações Zello ↔ pessoas e os PDAs, e volta a mostrar toda a gente no mapa">
          <RefreshCw className={`w-3.5 h-3.5 mr-1 ${refreshing ? "animate-spin" : ""}`} /> Atualizar
        </Button>
      </div>
      {openAlert && (
        <p className="text-xs text-muted-foreground">{alertGroups.find((g) => g.key === openAlert)?.items.join(" · ")}</p>
      )}

      {locQ.error && (
        <QueryErrorNote error={locQ.error} onRetry={() => void refreshAll()} retrying={isFetching} what={locQ.data ? "as posições mais recentes (o mapa mostra as últimas que chegaram)" : "as posições do Zello"} />
      )}

      <Card>
        <CardContent className="p-0 overflow-hidden rounded-lg">
          <ZelloGoogleMap drivers={mapDrivers} fitSignal={fitSignal} />
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "#10b981" }} /> normal</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "#ef4444" }} /> &gt;{SPEED_ALERT_KMH} km/h</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "#f59e0b" }} /> bateria &lt;{BATTERY_ALERT}%</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "#94a3b8" }} /> sem reportar &gt;1h</span>
      </div>

      {/* Ligação Zello ↔ funcionário */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <LinkIcon className="w-4 h-4" />
            Utilizadores Zello ↔ Pessoas
            {unmappedCount > 0 && <Badge variant="secondary">{unmappedCount} por ligar</Badge>}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Nos <b>PDAs</b> manda o check-in do dia (aba PDAs). Se o PDA é de uma pessoa, escolhe-a como <b>dono</b>:
            fica com o GPS sempre que ninguém fez check-in nele. Nos telemóveis pessoais, escolhe a pessoa.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {(zelloUsers as any[])
              .filter((u: any) => !u.gpsExcluded)
              .sort((a: any, b: any) => {
                const rank = (u: any) => {
                  const k = String(u.name).toLowerCase();
                  if (pdaByZello.has(k)) return mapByZello.get(k)?.source === "pda" ? 2 : 1; // PDA sem check-in primeiro
                  return mapByZello.has(k) ? 3 : 0; // por ligar mesmo primeiro
                };
                return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
              })
              .map((u: any) => {
                const key = String(u.name).toLowerCase();
                const linked = mapByZello.get(key);
                const pda = pdaByZello.get(key);
                const isPda = !!pda;
                const hasToday = linked?.source === "pda";
                return (
                  <div key={u.name} className={`flex flex-wrap sm:flex-nowrap items-center gap-2 p-2 rounded-lg border ${isPda ? (hasToday ? "bg-muted/30" : "bg-blue-50/40 border-blue-200") : linked ? "bg-muted/30" : "bg-amber-50/50 border-amber-200"}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{u.fullName || u.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        Zello: {u.name}{isPda ? ` · PDA: ${pda.pdaName}` : ""}
                      </p>
                    </div>
                    {isPda ? (
                      <div className="flex w-full shrink-0 flex-col items-end gap-1 sm:w-52">
                        {hasToday ? (
                          <Badge variant="outline" className="gap-1 border-green-300 bg-green-50 text-green-800">
                            hoje: {linked!.fullName}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1 border-blue-300 bg-blue-50 text-blue-700">
                            sem check-in de PDA hoje
                          </Badge>
                        )}
                        <div className="w-full">
                          <SearchableSelect
                            options={employeeOptions}
                            value={u.owner ? String(u.owner.employeeId) : ""}
                            onChange={(v: string) => mapMutation.mutate({ zelloUsername: u.name, employeeId: v ? Number(v) : null })}
                            placeholder="— dono do PDA (fixo) —"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="w-full sm:w-52 shrink-0">
                        <SearchableSelect
                          options={employeeOptions}
                          value={linked ? String(linked.employeeId) : ""}
                          onChange={(v: string) =>
                            mapMutation.mutate({ zelloUsername: u.name, employeeId: v ? Number(v) : null })
                          }
                          placeholder="— ligar a pessoa (fixo) —"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
