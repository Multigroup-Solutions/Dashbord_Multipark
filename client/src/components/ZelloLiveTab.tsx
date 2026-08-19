// Mapa ao vivo do Zello (pedido Jorge): posições/velocidades de todos os
// condutores em tempo real (polling 30s), alertas visuais e ecrã de ligação
// Zello↔funcionário. Leaflet + OpenStreetMap — sem chave de API.
import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toast } from "sonner";
import { Satellite, Gauge, Battery, WifiOff, Link as LinkIcon, RefreshCw } from "lucide-react";

const SPEED_ALERT_KMH = 130;
const BATTERY_ALERT = 15;
const OFFLINE_ALERT_S = 3600;

type LiveLoc = {
  username: string;
  displayName: string;
  latitude: number;
  longitude: number;
  speed: number;
  batteryLevel: number;
  lastReportDelay: number;
};

function markerColor(l: LiveLoc): string {
  if (l.lastReportDelay > OFFLINE_ALERT_S) return "#94a3b8"; // offline — cinza
  if (l.speed > SPEED_ALERT_KMH) return "#ef4444"; // vermelho
  if (l.batteryLevel > 0 && l.batteryLevel < BATTERY_ALERT) return "#f59e0b"; // laranja
  return "#10b981"; // verde
}

export function ZelloLiveTab() {
  const utils = trpc.useUtils();
  const { data: locations = [], isFetching, refetch, dataUpdatedAt } =
    trpc.operational.zello.locations.useQuery(undefined, { refetchInterval: 30_000 });
  const { data: zelloUsers = [] } = trpc.operational.zello.users.useQuery();
  const { data: mappings = [] } = trpc.operational.zello.mappings.useQuery(undefined, { refetchInterval: 60_000 });
  const { data: pdas = [] } = trpc.operational.pdas.list.useQuery();
  const { data: employees = [] } = trpc.rh.list.useQuery({ isActive: true });

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

  // Utilizadores Zello que pertencem a PDAs (ligação é o check-in diário do
  // PDA, não a ficha)
  const pdaByZello = useMemo(() => {
    const m = new Map<string, { pdaName: string }>();
    for (const p of pdas as any[]) {
      if (p.zelloUsername) m.set(String(p.zelloUsername).toLowerCase(), { pdaName: p.name });
    }
    return m;
  }, [pdas]);

  const realName = (l: { username: string; displayName: string }) =>
    mapByZello.get(l.username.toLowerCase())?.fullName || l.displayName || l.username;

  const live = (locations as LiveLoc[]).filter((l) => l.latitude !== 0 || l.longitude !== 0);
  const alerts = useMemo(() => {
    const out: { key: string; icon: any; text: string; color: string }[] = [];
    for (const l of live) {
      const name = realName(l);
      if (l.speed > SPEED_ALERT_KMH)
        out.push({ key: `sp-${l.username}`, icon: Gauge, text: `${name} a ${Math.round(l.speed)} km/h`, color: "border-red-300 bg-red-50 text-red-800" });
      if (l.batteryLevel > 0 && l.batteryLevel < BATTERY_ALERT)
        out.push({ key: `bat-${l.username}`, icon: Battery, text: `${name} com ${l.batteryLevel}% de bateria`, color: "border-amber-300 bg-amber-50 text-amber-800" });
      if (l.lastReportDelay > OFFLINE_ALERT_S)
        out.push({ key: `off-${l.username}`, icon: WifiOff, text: `${name} sem reportar há ${Math.round(l.lastReportDelay / 3600)}h`, color: "border-slate-300 bg-slate-50 text-slate-700" });
    }
    return out;
  }, [live, mapByZello]);

  // ── Leaflet ──
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const didFitRef = useRef(false);

  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return;
    const map = L.map(mapDiv.current).setView([38.77, -9.13], 9); // Lisboa por defeito
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; layerRef.current = null; };
  }, []);

  useEffect(() => {
    const layer = layerRef.current, map = mapRef.current;
    if (!layer || !map) return;
    layer.clearLayers();
    for (const l of live) {
      const name = realName(l);
      const m = L.circleMarker([l.latitude, l.longitude], {
        radius: 9, weight: 2, color: "#ffffff", fillColor: markerColor(l), fillOpacity: 0.95,
      });
      const resolved = mapByZello.get(l.username.toLowerCase());
      m.bindTooltip(name, { permanent: true, direction: "top", offset: [0, -8], className: "zello-tooltip" });
      m.bindPopup(
        `<b>${name}</b><br/>` +
        `${resolved?.source === "pda" ? `via check-in de hoje no PDA ${resolved.pdaName ?? ""}<br/>` : ""}` +
        `${l.displayName !== name ? `Zello: ${l.displayName}<br/>` : ""}` +
        `Velocidade: ${Math.round(l.speed)} km/h<br/>` +
        `${l.batteryLevel > 0 ? `Bateria: ${l.batteryLevel}%<br/>` : ""}` +
        `${l.lastReportDelay > 60 ? `Último report há ${Math.round(l.lastReportDelay / 60)} min` : "A reportar agora"}`
      );
      m.addTo(layer);
    }
    if (!didFitRef.current && live.length > 0) {
      didFitRef.current = true;
      map.fitBounds(L.latLngBounds(live.map((l) => [l.latitude, l.longitude] as [number, number])), { padding: [40, 40], maxZoom: 13 });
    }
  }, [live, mapByZello]);

  // ── Ligação Zello ↔ funcionário ──
  const mapMutation = trpc.operational.zello.mapUserToEmployee.useMutation({
    onSuccess: () => {
      utils.operational.zello.mappings.invalidate();
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
    (u: any) => !u.admin && !mapByZello.has(String(u.name).toLowerCase()) && !pdaByZello.has(String(u.name).toLowerCase())
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Satellite className="w-4 h-4" />
          {live.length} condutor(es) com posição · atualiza a cada 30s
          {dataUpdatedAt ? ` · última: ${new Date(dataUpdatedAt).toLocaleTimeString("pt-PT")}` : ""}
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`w-3.5 h-3.5 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Atualizar
        </Button>
      </div>

      {alerts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {alerts.map((a) => (
            <Badge key={a.key} variant="outline" className={`gap-1 ${a.color}`}>
              <a.icon className="w-3 h-3" /> {a.text}
            </Badge>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="p-0 overflow-hidden rounded-lg">
          <div ref={mapDiv} className="w-full h-[520px] z-0" />
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
            Os utilizadores instalados em <b>PDAs</b> mudam de mãos todos os dias — a ligação vem do
            check-in do PDA (aba PDAs) e é automática. O seletor fixo é só para telemóveis pessoais.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {(zelloUsers as any[])
              .filter((u: any) => !u.admin)
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
                  <div key={u.name} className={`flex items-center gap-2 p-2 rounded-lg border ${isPda ? (hasToday ? "bg-muted/30" : "bg-blue-50/40 border-blue-200") : linked ? "bg-muted/30" : "bg-amber-50/50 border-amber-200"}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{u.fullName || u.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        Zello: {u.name}{isPda ? ` · PDA: ${pda.pdaName}` : ""}
                      </p>
                    </div>
                    {isPda ? (
                      <div className="shrink-0 text-right">
                        {hasToday ? (
                          <Badge variant="outline" className="gap-1 border-green-300 bg-green-50 text-green-800">
                            hoje: {linked!.fullName}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1 border-blue-300 bg-blue-50 text-blue-700">
                            sem check-in de PDA hoje
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <div className="w-52 shrink-0">
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
