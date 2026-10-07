/**
 * Lote 43a — o trajeto de um dia pintado pela velocidade (Histórico Diário →
 * Trajeto). Google Maps (a mesma chave do Ao Vivo): linhas por troço, mais
 * escuras quanto mais depressa e a vermelho acima do limite; início, fim e o
 * ponto da velocidade máxima marcados.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { loadGoogleMaps } from "@/lib/googleMaps";
import { speedBand, SPEED_BANDS, type TrackPointView } from "@shared/speedBands";

const API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? "").trim();
const MAP_ID = (import.meta.env.VITE_GOOGLE_MAPS_MAP_ID ?? "").trim();

export function SpeedTrackMap({ points, threshold, maxAt }: { points: TrackPointView[]; threshold: number | null; maxAt: number | null }) {
  const divRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!API_KEY || !MAP_ID || !divRef.current || points.length < 2) return;
    let cancelled = false;
    const drawn: Array<google.maps.Polyline | google.maps.marker.AdvancedMarkerElement> = [];
    let map: google.maps.Map | null = null;
    setStatus("loading");
    const timeout = window.setTimeout(() => { if (!cancelled) setStatus("error"); }, 20_000);
    void loadGoogleMaps(API_KEY).then(({ maps }) => {
      if (cancelled || !divRef.current) return;
      map = new maps.Map(divRef.current, { center: { lat: points[0].lat, lng: points[0].lng }, zoom: 11, mapId: MAP_ID, mapTypeControl: true, fullscreenControl: true, streetViewControl: false, gestureHandling: "cooperative" });
      // troços seguidos com a mesma cor numa só linha (milhares de pontos → dezenas de linhas)
      let run: google.maps.LatLngLiteral[] = [];
      let band = speedBand(points[0].speed, threshold);
      const flush = () => {
        if (run.length < 2) return;
        // contorno branco por baixo: a cor lê-se em cima do mapa, do satélite e do trânsito
        drawn.push(new maps.Polyline({ map, path: run, strokeColor: "#ffffff", strokeOpacity: 0.9, strokeWeight: 7, zIndex: 1 }));
        drawn.push(new maps.Polyline({ map, path: run, strokeColor: band.color, strokeOpacity: 1, strokeWeight: 4, zIndex: band.over ? 3 : 2 }));
      };
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const b = speedBand(p.speed, threshold);
        if (b.key !== band.key && run.length) {
          run.push({ lat: p.lat, lng: p.lng });
          flush();
          run = [{ lat: p.lat, lng: p.lng }];
          band = b;
        } else run.push({ lat: p.lat, lng: p.lng });
      }
      flush();
      const pin = (pos: TrackPointView, text: string, bg: string) => {
        const el = document.createElement("span");
        el.className = "rounded px-1.5 py-0.5 text-[11px] font-semibold text-white shadow";
        el.style.background = bg;
        el.textContent = text; // nunca innerHTML
        drawn.push(new google.maps.marker.AdvancedMarkerElement({ map, position: { lat: pos.lat, lng: pos.lng }, content: el, title: text }));
      };
      pin(points[0], "Início", "#334155");
      pin(points[points.length - 1], "Fim", "#334155");
      const top = maxAt != null ? points.find((p) => p.ts === maxAt) : null;
      if (top) pin(top, `${Math.round(top.speed)} km/h`, threshold != null && top.speed > threshold ? "#b91c1c" : "#104281");
      const bounds = new google.maps.LatLngBounds();
      for (const p of points) bounds.extend({ lat: p.lat, lng: p.lng });
      map.fitBounds(bounds, 40);
      map.addListener("tilesloaded", () => { window.clearTimeout(timeout); if (!cancelled) setStatus("ready"); });
    }).catch(() => { window.clearTimeout(timeout); if (!cancelled) setStatus("error"); });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      for (const d of drawn) { if (d instanceof google.maps.Polyline) d.setMap(null); else d.map = null; }
      if (map) google.maps.event.clearInstanceListeners(map);
      divRef.current?.replaceChildren();
    };
  }, [points, threshold, maxAt, attempt]);

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-md border">
        <div ref={divRef} className="h-[360px] w-full sm:h-[460px]" aria-label="Mapa do trajeto pintado pela velocidade" />
        {(!API_KEY || !MAP_ID || status !== "ready" || points.length < 2) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted px-6 text-center text-sm" role="status">
            <p>{points.length < 2 ? "Sem pontos com posição suficientes para desenhar o trajeto."
              : !API_KEY || !MAP_ID ? "O mapa Google aguarda configuração (a mesma do Ao Vivo). O gráfico de baixo tem as velocidades."
              : status === "error" ? "Não foi possível carregar o Google Maps."
              : "A carregar o mapa…"}</p>
            {API_KEY && MAP_ID && status === "error" && <Button size="sm" variant="outline" onClick={() => setAttempt((v) => v + 1)}>Tentar novamente</Button>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" aria-label="Legenda das velocidades">
        {SPEED_BANDS(threshold).map((b) => (
          <span key={b.key} className="inline-flex items-center gap-1"><span className="inline-block h-1.5 w-6 rounded-full" style={{ background: b.color }} />{b.label}</span>
        ))}
      </div>
    </div>
  );
}
