import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { loadGoogleMaps } from "@/lib/googleMaps";
import type { ZelloMapPosition } from "@shared/zelloMap";

export type DriverMapPosition = ZelloMapPosition & {
  name: string;
  color: string;
  pdaName?: string | null;
};

const API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? "").trim();
const MAP_ID = (import.meta.env.VITE_GOOGLE_MAPS_MAP_ID ?? "").trim();

function markerContent(driver: DriverMapPosition) {
  const container = document.createElement("div");
  container.className = "flex flex-col items-center";
  const label = document.createElement("span");
  label.className = "rounded bg-white px-2 py-1 text-xs font-medium text-slate-900 shadow";
  label.textContent = driver.name;
  const dot = document.createElement("span");
  dot.className = "mt-1 h-5 w-5 rounded-full border-2 border-white shadow";
  dot.style.backgroundColor = driver.color;
  container.append(label, dot);
  return container;
}

function popupContent(driver: DriverMapPosition) {
  const container = document.createElement("div");
  container.className = "text-sm text-slate-900";
  const title = document.createElement("strong");
  title.textContent = driver.name;
  container.append(title);
  const lines = [
    ...(driver.pdaName != null ? [`via check-in de hoje no PDA ${driver.pdaName}`] : []),
    ...(driver.displayName !== driver.name ? [`Zello: ${driver.displayName}`] : []),
    `Velocidade: ${Math.round(driver.speed)} km/h`,
    ...(driver.batteryLevel > 0 ? [`Bateria: ${driver.batteryLevel}%`] : []),
    driver.lastReportDelay > 60
      ? `Último reporte há ${Math.round(driver.lastReportDelay / 60)} min`
      : "A reportar agora",
  ];
  for (const line of lines) {
    const row = document.createElement("div");
    row.textContent = line; // Dados externos nunca passam por innerHTML.
    container.append(row);
  }
  return container;
}

export function ZelloGoogleMap({ drivers }: { drivers: DriverMapPosition[] }) {
  const divRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [traffic, setTraffic] = useState(false);
  const trafficRef = useRef<google.maps.TrafficLayer | null>(null);
  const markersRef = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>());
  const popupRef = useRef<google.maps.InfoWindow | null>(null);
  const selectedRef = useRef<string | null>(null);
  const driversRef = useRef(drivers);
  driversRef.current = drivers;
  const didFitRef = useRef(false);

  useEffect(() => {
    if (!API_KEY || !MAP_ID || !divRef.current) return;
    let cancelled = false;
    let authFailed = false;
    let instance: google.maps.Map | null = null;
    setStatus("loading");
    const previousAuthFailure = window.gm_authFailure;
    const authFailure = () => {
      authFailed = true;
      if (!cancelled) setStatus("error");
      previousAuthFailure?.();
    };
    window.gm_authFailure = authFailure;
    const timeout = window.setTimeout(() => {
      if (!cancelled) setStatus("error");
    }, 20_000);
    void loadGoogleMaps(API_KEY).then(({ maps }) => {
      if (cancelled || !divRef.current) return;
      const createdMap: google.maps.Map = new maps.Map(divRef.current, {
        center: { lat: 38.77, lng: -9.13 }, zoom: 9, mapId: MAP_ID,
        mapTypeControl: true, fullscreenControl: true,
        streetViewControl: true, gestureHandling: "cooperative",
      });
      trafficRef.current = new maps.TrafficLayer();
      const popup: google.maps.InfoWindow = new maps.InfoWindow();
      popupRef.current = popup;
      popup.addListener("closeclick", () => { selectedRef.current = null; });
      createdMap.addListener("tilesloaded", () => {
        window.clearTimeout(timeout);
        if (!cancelled && !authFailed) setStatus("ready");
      });
      instance = createdMap;
      setMap(createdMap);
    }).catch(() => {
      window.clearTimeout(timeout);
      if (!cancelled) setStatus("error");
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (window.gm_authFailure === authFailure) window.gm_authFailure = previousAuthFailure;
      for (const marker of markersRef.current.values()) {
        google.maps.event.clearInstanceListeners(marker);
        marker.map = null;
      }
      markersRef.current.clear();
      popupRef.current?.close();
      if (popupRef.current) google.maps.event.clearInstanceListeners(popupRef.current);
      popupRef.current = null;
      trafficRef.current?.setMap(null);
      trafficRef.current = null;
      if (instance) google.maps.event.clearInstanceListeners(instance);
      divRef.current?.replaceChildren();
      selectedRef.current = null;
      didFitRef.current = false;
      setMap(null);
    };
  }, [attempt]);

  useEffect(() => {
    if (!map) return;
    trafficRef.current?.setMap(traffic ? map : null);
  }, [map, traffic]);

  useEffect(() => {
    if (!map) return;
    const markers = markersRef.current;
    const active = new Set(drivers.map((d) => d.username));
    for (const [username, marker] of markers) {
      if (active.has(username)) continue;
      google.maps.event.clearInstanceListeners(marker);
      marker.map = null;
      markers.delete(username);
      if (selectedRef.current === username) {
        popupRef.current?.close();
        selectedRef.current = null;
      }
    }
    for (const driver of drivers) {
      const position = { lat: driver.latitude, lng: driver.longitude };
      let marker = markers.get(driver.username);
      if (!marker) {
        marker = new google.maps.marker.AdvancedMarkerElement({ map, position, title: driver.name });
        const anchor = marker;
        marker.addListener("click", () => {
          const latest = driversRef.current.find((d) => d.username === driver.username);
          if (!latest || !popupRef.current) return;
          selectedRef.current = latest.username;
          popupRef.current.setContent(popupContent(latest));
          popupRef.current.open({ map, anchor, shouldFocus: false });
        });
        markers.set(driver.username, marker);
      }
      marker.position = position;
      marker.title = driver.name;
      marker.content = markerContent(driver);
      if (selectedRef.current === driver.username) popupRef.current?.setContent(popupContent(driver));
    }
    if (!didFitRef.current && drivers.length) {
      didFitRef.current = true;
      fitDrivers(map, drivers);
    }
  }, [map, drivers]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 p-2">
        <span className="text-xs text-muted-foreground">Google Maps · GPS Zello</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={!map || status !== "ready" || !drivers.length} onClick={() => map && fitDrivers(map, drivers)}>Ver todos</Button>
          <Button size="sm" variant={traffic ? "selected" : "outline"} aria-pressed={traffic} disabled={!map || status !== "ready"} onClick={() => setTraffic((v) => !v)}>Trânsito</Button>
        </div>
      </div>
      <div className="relative">
        <div ref={divRef} className="w-full h-[360px] sm:h-[520px]" aria-label="Mapa das posições dos condutores" />
        {(!API_KEY || !MAP_ID || status !== "ready") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted px-6 text-center text-sm" role="status">
            <p>{!API_KEY || !MAP_ID
              ? "O mapa Google aguarda configuração. Os dados do Zello continuam a atualizar."
              : status === "error"
                ? "Não foi possível carregar o Google Maps. Os dados do Zello continuam a atualizar."
                : "A carregar o Google Maps…"}</p>
            {API_KEY && MAP_ID && status === "error" && <Button size="sm" variant="outline" onClick={() => setAttempt((v) => v + 1)}>Tentar novamente</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

function fitDrivers(map: google.maps.Map, drivers: DriverMapPosition[]) {
  if (drivers.length === 1) {
    map.setCenter({ lat: drivers[0].latitude, lng: drivers[0].longitude });
    map.setZoom(13);
    return;
  }
  const bounds = new google.maps.LatLngBounds();
  for (const driver of drivers) bounds.extend({ lat: driver.latitude, lng: driver.longitude });
  map.fitBounds(bounds, 60);
  google.maps.event.addListenerOnce(map, "idle", () => {
    if ((map.getZoom() ?? 0) > 13) map.setZoom(13);
  });
}

declare global {
  interface Window { gm_authFailure?: () => void; }
}
