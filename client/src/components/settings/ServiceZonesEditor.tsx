/**
 * Definições → Parâmetros → Operação (plano 62, P5):
 *  - "Zonas da operação (GPS)": as zonas vêm das GARAGENS da Multipark (Q6 do
 *    Jorge: "a Multipark já tem as coordenadas" — o centro do link do mapa de
 *    cada garagem, o raio de omissão do tipo). Aqui só se gravam EXCEÇÕES:
 *    ajustar o raio, corrigir o centro ou o tipo, ou dar o centro a uma
 *    garagem sem coordenadas ("Sugerir" ajuda; nada se grava até Guardar).
 *    Mapa esquemático (à escala) com as zonas do terminal e os parques, e os
 *    avisos (P2 colado ao terminal: não grava);
 *  - "Papéis das garagens": provisória / já num parque / parque certo.
 * Só o super admin muda.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Check, ExternalLink, Loader2, MapPin, Plus, SlidersHorizontal, Sparkles, Trash2, Warehouse } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { parkZonesConflictError } from "@shared/appSettings";
import {
  DEFAULT_GARAGE_ZONE_RADIUS_M, PARK_ZONE_KINDS, PARK_ZONE_KIND_LABELS, effectiveParkZones, kindOfGarageName, parkZoneOverlaps,
  type EffectiveParkZone, type GarageCoord, type ParkZoneCity, type ParkZoneException, type ParkZoneExceptionsMap, type ParkZoneKind,
} from "@shared/serviceGps";
import { matchKey } from "@shared/textKey";
import { GARAGE_ROLES, GARAGE_ROLE_LABELS, type GarageRole } from "@shared/serviceTimes";
import { parksInsideZones, type ParkPoint } from "@shared/terminalWatch";
import type { AirportFence } from "@shared/pontoTerminal";

const CITIES: { id: ParkZoneCity; label: string }[] = [
  { id: "lisbon", label: "Lisboa" },
  { id: "porto", label: "Porto" },
  { id: "faro", label: "Faro" },
];
const CITY_LABEL: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
const FROM_NAME = "__nome__";

/** Cor de cada tipo de zona (o P2 no azul Multipark). */
const KIND_COLOR: Record<ParkZoneKind, string> = {
  p2: "#0055D2",
  pd: "#0F9D58",
  central: "#D97706",
  coberto: "#7C3AED",
  outra: "#64748B",
};
const TERMINAL_COLOR = "#0E2957";
const SOURCE_LABEL: Record<EffectiveParkZone["source"], string> = {
  multipark: "Multipark",
  multipark_ajustada: "Multipark, ajustada aqui",
  manual: "Só aqui",
};

// ─── Rascunho das exceções (texto nos campos; números só ao gravar) ────────

export interface ParkZoneDraft { label: string; kind: ParkZoneKind | ""; lat: string; lng: string; radiusM: string; garages: string }
export type ParkZonesDraft = Record<ParkZoneCity, ParkZoneDraft[]>;

const txt = (v: unknown) => (v == null || v === "" ? "" : String(v).replace(".", ","));
const num = (v: string) => { const t = String(v ?? "").trim().replace(",", "."); return t === "" ? undefined : Number(t); };

export function parkZonesToDraft(v: unknown): ParkZonesDraft {
  const cur = (v ?? {}) as Partial<ParkZoneExceptionsMap>;
  return Object.fromEntries(CITIES.map((c) => [c.id, (cur[c.id] ?? []).map((z) => ({
    label: z.label ?? "", kind: z.kind ?? "", lat: txt(z.lat), lng: txt(z.lng), radiusM: txt(z.radiusM), garages: (z.garages ?? []).join(", "),
  }))])) as ParkZonesDraft;
}

export function parkZonesFromDraft(d: ParkZonesDraft): ParkZoneExceptionsMap {
  return Object.fromEntries(CITIES.map((c) => [c.id, (d[c.id] ?? []).map((z) => {
    const e: ParkZoneException = { label: z.label.trim() };
    if (z.kind) e.kind = z.kind;
    const lat = num(z.lat), lng = num(z.lng), r = num(z.radiusM);
    if (lat !== undefined) e.lat = lat;
    if (lng !== undefined) e.lng = lng;
    if (r !== undefined) e.radiusM = r;
    const garages = z.garages.split(/[,;\n]+/).map((g) => g.trim()).filter(Boolean);
    if (garages.length) e.garages = garages;
    return e;
  })])) as ParkZoneExceptionsMap;
}

const okNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
/** As exceções que já se conseguem usar (números válidos) — para o mapa e os avisos enquanto se escreve. */
function usableExceptions(m: ParkZoneExceptionsMap): ParkZoneExceptionsMap {
  return Object.fromEntries(CITIES.map((c) => [c.id, m[c.id].filter((e) => e.label && (e.lat === undefined || okNum(e.lat)) && (e.lng === undefined || okNum(e.lng)) && (e.radiusM === undefined || okNum(e.radiusM)))])) as ParkZoneExceptionsMap;
}

// ─── Mapa esquemático (sem serviço de mapas: círculos à escala) ─────────────

interface MapCircle { lat: number; lng: number; radiusM: number; label: string; color: string; dashed?: boolean }

function ZonesMap({ circles, points }: { circles: MapCircle[]; points: Array<{ lat: number; lng: number; label: string }> }) {
  const shapes = circles.filter((c) => okNum(c.lat) && okNum(c.lng) && okNum(c.radiusM) && c.radiusM > 0);
  if (!shapes.length) {
    return (
      <div className="flex h-40 items-center justify-center rounded-[14px] border border-dashed bg-muted/30 px-4 text-center text-xs text-muted-foreground">
        <MapPin className="mr-1.5 h-4 w-4 shrink-0" />Sem zonas nesta cidade: as garagens da Multipark não têm coordenadas e ainda não há exceções.
      </div>
    );
  }
  const lat0 = shapes.reduce((s, c) => s + c.lat, 0) / shapes.length;
  const lng0 = shapes.reduce((s, c) => s + c.lng, 0) / shapes.length;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180), ky = 111_320;
  const xy = (lat: number, lng: number) => ({ x: (lng - lng0) * kx, y: -(lat - lat0) * ky });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of shapes) {
    const p = xy(c.lat, c.lng);
    minX = Math.min(minX, p.x - c.radiusM); maxX = Math.max(maxX, p.x + c.radiusM);
    minY = Math.min(minY, p.y - c.radiusM); maxY = Math.max(maxY, p.y + c.radiusM);
  }
  // os parques só entram se estiverem perto (até 3 km das zonas)
  const near = points.filter((d) => okNum(d.lat) && okNum(d.lng)).map((d) => ({ ...d, ...xy(d.lat, d.lng) }))
    .filter((d) => d.x > minX - 3000 && d.x < maxX + 3000 && d.y > minY - 3000 && d.y < maxY + 3000);
  for (const d of near) { minX = Math.min(minX, d.x); maxX = Math.max(maxX, d.x); minY = Math.min(minY, d.y); maxY = Math.max(maxY, d.y); }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.08 + 60;
  const w = maxX - minX + 2 * pad, h = Math.max(maxY - minY + 2 * pad, w * 0.35);
  const font = w / 45;
  const scaleM = [100, 200, 500, 1000, 2000, 5000].find((s) => s >= w / 6) ?? 5000;
  return (
    <figure className="overflow-hidden rounded-[14px] border bg-[#F6F8FC] dark:bg-muted/30">
      <svg viewBox={`${minX - pad} ${minY - pad} ${w} ${h}`} className="block h-56 w-full" role="img" aria-label="Mapa esquemático das zonas (à escala)">
        {shapes.map((c, i) => {
          const p = xy(c.lat, c.lng);
          return (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={c.radiusM} fill={c.color} fillOpacity={c.dashed ? 0.06 : 0.16} stroke={c.color} strokeWidth={font / 6} strokeDasharray={c.dashed ? `${font / 2} ${font / 3}` : undefined} />
              <text x={p.x} y={p.y} fontSize={font} textAnchor="middle" dominantBaseline="middle" fill={c.color} fontWeight={700}>{c.label}</text>
            </g>
          );
        })}
        {near.map((d, i) => (
          <g key={`p${i}`}>
            <circle cx={d.x} cy={d.y} r={font / 2.5} fill={TERMINAL_COLOR} />
            <text x={d.x + font / 1.6} y={d.y} fontSize={font * 0.8} dominantBaseline="middle" fill={TERMINAL_COLOR}>{d.label}</text>
          </g>
        ))}
        <line x1={minX - pad + font} x2={minX - pad + font + scaleM} y1={minY - pad + h - font} y2={minY - pad + h - font} stroke={TERMINAL_COLOR} strokeWidth={font / 5} />
        <text x={minX - pad + font} y={minY - pad + h - font * 1.6} fontSize={font * 0.8} fill={TERMINAL_COLOR}>{scaleM >= 1000 ? `${scaleM / 1000} km` : `${scaleM} m`}</text>
      </svg>
      <figcaption className="flex flex-wrap gap-x-3 gap-y-1 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        {PARK_ZONE_KINDS.map((k) => <span key={k} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: KIND_COLOR[k] }} />{PARK_ZONE_KIND_LABELS[k]}</span>)}
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full border border-dashed" style={{ borderColor: TERMINAL_COLOR }} />Terminal (Aeroportos)</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: TERMINAL_COLOR }} />Parque (centro de custos)</span>
      </figcaption>
    </figure>
  );
}

// ─── Zonas da operação ──────────────────────────────────────────────────────

export function ParkZonesEditor({ draft, onChange, locked, airports, parks }: {
  draft: ParkZonesDraft;
  onChange: (d: ParkZonesDraft) => void;
  locked?: boolean;
  airports: Partial<Record<string, AirportFence>> | null;
  parks: ParkPoint[];
}) {
  const [city, setCity] = useState<ParkZoneCity>("lisbon");
  const base = trpc.settings.values.multiparkGarages.useQuery(undefined, { staleTime: 5 * 60_000, retry: false });
  const suggest = trpc.settings.values.parkZonesSuggest.useQuery(undefined, { enabled: false, retry: false, staleTime: 5 * 60_000 });
  const garages: GarageCoord[] = base.data?.available ? base.data.garages : [];
  const exceptions = draft[city] ?? [];
  const value = useMemo(() => usableExceptions(parkZonesFromDraft(draft)), [draft]);
  const eff = useMemo(() => effectiveParkZones(garages, value), [garages, value]);
  const setExceptions = (list: ParkZoneDraft[]) => onChange({ ...draft, [city]: list });
  const patch = (i: number, p: Partial<ParkZoneDraft>) => setExceptions(exceptions.map((z, j) => (j === i ? { ...z, ...p } : z)));
  const excIndexFor = (garage: string) => exceptions.findIndex((e) => matchKey(e.label) === matchKey(garage) || e.garages.split(/[,;]+/).some((g) => matchKey(g) === matchKey(garage)));
  const adjust = (garage: string, p: Partial<ParkZoneDraft> = {}) => {
    const i = excIndexFor(garage);
    if (i >= 0) patch(i, p);
    else setExceptions([...exceptions, { label: garage, kind: "", lat: "", lng: "", radiusM: "", garages: "", ...p }]);
  };

  const conflict = parkZonesConflictError(eff.zones, airports);
  const overlaps = parkZoneOverlaps(eff.zones).filter((o) => o.city === city);
  const parksInTerminal = airports?.[city]?.zones?.length ? parksInsideZones({ [city]: airports[city]! }, parks) : [];
  const cityGarages = garages.filter((g) => g.city === city);
  const noCoords = eff.withoutCoords.filter((w) => w.city === city);

  const circles: MapCircle[] = [
    ...eff.zones[city].map((z) => ({ lat: z.lat, lng: z.lng, radiusM: z.radiusM, label: z.label, color: KIND_COLOR[z.kind] ?? KIND_COLOR.outra })),
    ...(airports?.[city]?.zones ?? []).map((z) => ({ lat: z.lat, lng: z.lng, radiusM: z.radiusM, label: z.label || "Terminal", color: TERMINAL_COLOR, dashed: true })),
  ];
  const suggestions = suggest.data?.available ? suggest.data.cities[city] ?? [] : [];

  return (
    <div className="max-w-4xl space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Cidade" className="inline-flex rounded-[10px] border bg-muted/40 p-0.5">
          {CITIES.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={city === c.id} onClick={() => setCity(c.id)}
              className={`rounded-[8px] px-3 py-1.5 text-xs font-semibold transition-colors ${city === c.id ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {c.label} · {eff.zones[c.id].length}
            </button>
          ))}
        </div>
        {base.isLoading && <span className="inline-flex items-center text-[11px] text-muted-foreground"><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />A ler as garagens da Multipark…</span>}
      </div>
      {base.data && !base.data.available && (
        <p className="rounded-[10px] border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Não deu para ler as garagens da Multipark ({base.data.reason}). Aparecem só as exceções gravadas aqui.
        </p>
      )}

      <ZonesMap circles={circles} points={parks.map((p) => ({ lat: p.lat, lng: p.lng, label: p.name }))} />

      {conflict && (
        <p className="rounded-[10px] border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />{conflict} Assim não grava.</p>
      )}
      {(overlaps.length > 0 || parksInTerminal.length > 0) && (
        <div className="rounded-[10px] border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Confirma no mapa:
          <ul className="mt-1 list-disc pl-5">
            {overlaps.map((o, i) => <li key={`o${i}`}>As zonas {o.a} e {o.b} tocam-se (são de tipos diferentes).</li>)}
            {parksInTerminal.map((w, i) => <li key={`p${i}`}>O parque {w.park} cai na zona {w.zone ?? "sem nome"} do terminal (a {w.distanceM} m do centro).</li>)}
          </ul>
        </div>
      )}

      {/* As zonas em vigor: garagens da Multipark (com as exceções por cima) e as zonas só daqui */}
      <div className="overflow-hidden rounded-[14px] border">
        <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs font-semibold">
          <Warehouse className="h-3.5 w-3.5 text-primary" />Zonas em vigor em {CITY_LABEL[city]}
          <span className="ml-auto font-normal text-muted-foreground">{cityGarages.length} garagens na Multipark</span>
        </div>
        {eff.zones[city].length === 0 && noCoords.length === 0 && <p className="p-3 text-xs text-muted-foreground">Sem garagens nem exceções nesta cidade.</p>}
        {eff.zones[city].map((z) => (
          <div key={`z${z.label}`} className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs last:border-0">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: KIND_COLOR[z.kind] }} aria-hidden />
            <span className="font-semibold">{z.label}</span>
            <span className="text-muted-foreground">{PARK_ZONE_KIND_LABELS[z.kind]} · {z.radiusM} m · {SOURCE_LABEL[z.source]}</span>
            <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`https://www.google.com/maps?q=${z.lat},${z.lng}&z=17`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" />Ver no mapa
            </a>
            {z.source === "multipark" && (
              <Button size="sm" variant="ghost" className="ml-auto h-7 rounded-[10px] text-xs" disabled={locked} onClick={() => adjust(z.label)}>
                <SlidersHorizontal className="mr-1 h-3.5 w-3.5" />Ajustar
              </Button>
            )}
          </div>
        ))}
        {noCoords.map((w) => (
          <div key={`n${w.garage}`} className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs last:border-0">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden />
            <span className="font-semibold">{w.garage}</span>
            <span className="text-muted-foreground">sem coordenadas na Multipark (o link do mapa não as tem) — fica sem zona</span>
            <Button size="sm" variant="ghost" className="ml-auto h-7 rounded-[10px] text-xs text-primary" disabled={locked}
              onClick={() => adjust(w.garage, { kind: kindOfGarageName(w.garage) === "outra" ? "" : kindOfGarageName(w.garage) })}>
              <Plus className="mr-1 h-3.5 w-3.5" />Dar o centro
            </Button>
          </div>
        ))}
      </div>

      {/* Exceções (o que se grava) */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold">Exceções gravadas aqui ({exceptions.length})</span>
          <span className="text-[11px] text-muted-foreground">Campos vazios = os da Multipark (centro) e os de omissão (raio, tipo pelo nome).</span>
          <Button size="sm" variant="outline" className="ml-auto h-8 rounded-[10px] text-xs" disabled={locked || suggest.isFetching} onClick={() => suggest.refetch()}>
            {suggest.isFetching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5 text-primary" />}Sugerir centros
          </Button>
        </div>
        {suggest.data && !suggest.data.available && <p className="text-xs text-amber-800"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Não deu para sugerir: {suggest.data.reason}</p>}
        {suggest.error && <p className="text-xs text-destructive">Não deu para sugerir: {suggest.error.message}</p>}
        {suggest.data?.available && (
          <div className="rounded-[14px] border p-2.5">
            <div className="mb-1.5 text-xs font-semibold">Centros sugeridos para {CITY_LABEL[city]} ({suggestions.length}) — só preenchem; ficam quando carregares em Guardar</div>
            {suggestions.length === 0 && <p className="text-xs text-muted-foreground">A Multipark não tem garagens nem movimentos com posição nesta cidade.</p>}
            {suggestions.map((s) => (
              <div key={s.garage} className="flex flex-wrap items-center gap-2 py-0.5 text-xs">
                <span className="font-medium">{s.garage}</span>
                <span className="text-muted-foreground">
                  {s.source === "mapa" ? "link do mapa" : s.source === "app" ? `posições da app (${s.n ?? 0} movimentos)` : `centro do parque${s.parkName ? ` ${s.parkName}` : ""}`}
                </span>
                <Button size="sm" variant="ghost" className="ml-auto h-7 rounded-[10px] text-xs text-primary" disabled={locked}
                  onClick={() => adjust(s.garage, { lat: txt(s.lat), lng: txt(s.lng) })}><Check className="mr-1 h-3.5 w-3.5" />Usar</Button>
              </div>
            ))}
          </div>
        )}
        {exceptions.map((z, i) => {
          const lat = num(z.lat), lng = num(z.lng);
          const fromMultipark = cityGarages.some((g) => matchKey(g.garage) === matchKey(z.label));
          const kind = (z.kind || kindOfGarageName(z.label)) as ParkZoneKind;
          return (
            <div key={i} className="rounded-[14px] border p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: KIND_COLOR[kind] }} aria-hidden />
                <Input className="h-8 w-36 rounded-[10px] text-xs" placeholder="Garagem (ex.: P2)" maxLength={80} disabled={locked}
                  aria-label={`${CITY_LABEL[city]} — garagem da exceção ${i + 1}`} value={z.label} onChange={(e) => patch(i, { label: e.target.value })} />
                <Select value={z.kind || FROM_NAME} onValueChange={(v) => patch(i, { kind: v === FROM_NAME ? "" : (v as ParkZoneKind) })} disabled={locked}>
                  <SelectTrigger className="h-8 w-44 rounded-[10px] text-xs" aria-label={`${CITY_LABEL[city]} — tipo da exceção ${i + 1}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={FROM_NAME}>Tipo pelo nome ({PARK_ZONE_KIND_LABELS[kindOfGarageName(z.label)]})</SelectItem>
                    {PARK_ZONE_KINDS.map((k) => <SelectItem key={k} value={k}>{PARK_ZONE_KIND_LABELS[k]}</SelectItem>)}
                  </SelectContent>
                </Select>
                <span className="text-[11px] text-muted-foreground">{fromMultipark ? "garagem da Multipark" : "zona só daqui (precisa de centro)"}</span>
                {lat !== undefined && lng !== undefined && okNum(lat) && okNum(lng) && (
                  <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={`https://www.google.com/maps?q=${lat},${lng}&z=17`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3" />Ver no mapa
                  </a>
                )}
                <Button variant="ghost" size="icon" className="ml-auto h-8 w-8 rounded-[10px]" disabled={locked} aria-label={`Tirar a exceção ${z.label || i + 1}`}
                  onClick={() => setExceptions(exceptions.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_7rem_2fr]">
                {([["lat", "Latitude", fromMultipark ? "a da Multipark" : "38,7712"], ["lng", "Longitude", fromMultipark ? "a da Multipark" : "-9,1301"], ["radiusM", "Raio (m)", String(DEFAULT_GARAGE_ZONE_RADIUS_M[kind])]] as const).map(([k, label, ph]) => (
                  <label key={k} className="space-y-1 text-[11px] text-muted-foreground">
                    <span>{label}</span>
                    <Input className="h-8 rounded-[10px] text-xs" inputMode="decimal" placeholder={ph} disabled={locked}
                      aria-label={`${CITY_LABEL[city]} — exceção ${i + 1} ${label.toLowerCase()}`} value={z[k]} onChange={(e) => patch(i, { [k]: e.target.value })} />
                  </label>
                ))}
                <label className="col-span-2 space-y-1 text-[11px] text-muted-foreground sm:col-span-1">
                  <span>Outras garagens da app nesta zona (vírgulas)</span>
                  <Input className="h-8 rounded-[10px] text-xs" placeholder="opcional" disabled={locked}
                    aria-label={`${CITY_LABEL[city]} — exceção ${i + 1} garagens`} value={z.garages} onChange={(e) => patch(i, { garages: e.target.value })} />
                </label>
              </div>
            </div>
          );
        })}
        {exceptions.length < 12 && (
          <Button size="sm" variant="outline" className="h-8 rounded-[10px] text-xs" disabled={locked}
            onClick={() => setExceptions([...exceptions, { label: "", kind: "", lat: "", lng: "", radiusM: "", garages: "" }])}>
            <Plus className="mr-1 h-3.5 w-3.5" />Exceção
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Papéis das garagens ────────────────────────────────────────────────────

export interface GarageRoleDraft { garage: string; role: GarageRole }

export function GarageRolesEditor({ rows, onChange, locked }: { rows: GarageRoleDraft[]; onChange: (r: GarageRoleDraft[]) => void; locked?: boolean }) {
  const patch = (i: number, p: Partial<GarageRoleDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="max-w-2xl space-y-2">
      <div className="overflow-hidden rounded-[14px] border">
        {rows.length === 0 && <p className="p-3 text-xs text-muted-foreground">Sem garagens: todas contam como "parque certo".</p>}
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 border-b p-2 last:border-0">
            <Warehouse className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <Input className="h-8 w-40 rounded-[10px] text-xs" placeholder="Nome na app (ex.: PD FORA)" maxLength={80} disabled={locked}
              aria-label={`Garagem ${i + 1}`} value={r.garage} onChange={(e) => patch(i, { garage: e.target.value })} />
            <Select value={r.role} onValueChange={(v) => patch(i, { role: v as GarageRole })} disabled={locked}>
              <SelectTrigger className="h-8 min-w-0 flex-1 rounded-[10px] text-xs" aria-label={`Papel da garagem ${r.garage || i + 1}`}><SelectValue /></SelectTrigger>
              <SelectContent>{GARAGE_ROLES.map((g) => <SelectItem key={g} value={g}>{GARAGE_ROLE_LABELS[g]}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-[10px]" disabled={locked} aria-label={`Tirar ${r.garage || `a garagem ${i + 1}`}`}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        ))}
      </div>
      {rows.length < 60 && (
        <Button size="sm" variant="outline" className="h-8 rounded-[10px] text-xs" disabled={locked} onClick={() => onChange([...rows, { garage: "", role: "final" }])}>
          <Plus className="mr-1 h-3.5 w-3.5" />Garagem
        </Button>
      )}
    </div>
  );
}
