import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatValue } from "@/components/StatValue";
import BookingDetailDialog from "@/components/BookingDetailDialog";
import { fmtBookingDateTime } from "@/lib/lisbonTime";
import { addDays, lisbonDayOf } from "@shared/lisbonDay";
import { BOOKING_STATUS_COLORS, statusLabel, type BookingStatus } from "@shared/reservasDoDia";
import { BOOKING_CHANNEL_LABELS, type BookingChannel } from "@shared/multiparkParks";
import { operatedLabel } from "@shared/marketplace";
import {
  OPS_LIST_EVENT_LABELS, OPS_LIST_LABELS, OPS_LIST_MAX_DAYS, OPS_LIST_STATES, OPS_LIST_SUBTITLES, OPS_RANGE_PRESETS,
  OPS_RANGE_PRESET_LABELS, PARKING_TYPE_LABELS, deltaVs, matchPreset, presetRange, previousRange, rangeDays,
  type OpsListKind, type OpsListRow,
} from "@shared/opsLists";
import { AlertTriangle, ChevronLeft, ChevronRight, Download, RefreshCw, Search } from "lucide-react";

/** Cores do distintivo do canal (as mesmas das Reservas do dia). */
const CHANNEL_BADGE: Record<BookingChannel, string> = {
  direto: "border-sky-200 text-sky-700",
  parceiro: "border-violet-200 text-violet-700",
  marketplace: "border-rose-200 text-rose-700",
};

const PAGE_SIZE = 200;
const CSV_MAX = 2000;

const fmtEur = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
const fmtN = (n: number) => n.toLocaleString("pt-PT");

export const todayLisbon = () => lisbonDayOf(Date.now());

/** Filtros PARTILHADOS pelas quatro listas (o período fica ao mudar de aba). */
export interface OpsListShared {
  from: string;
  to: string;
  parkId: string;
  channel: BookingChannel | "";
  search: string;
}

/** Período por omissão: HOJE (dia de Lisboa). */
export function defaultOpsShared(seed?: { day?: string | null; q?: string }): OpsListShared {
  const d = seed?.day ?? todayLisbon();
  return { from: d, to: d, parkId: "", channel: "", search: seed?.q ?? "" };
}

/** Garante from ≤ to e no máximo 62 dias (encurta o fim). */
function clampRange(from: string, to: string): { from: string; to: string } {
  if (to < from) return { from, to: from };
  if (rangeDays(from, to) > OPS_LIST_MAX_DAYS) return { from, to: addDays(from, OPS_LIST_MAX_DAYS - 1) };
  return { from, to };
}

function Delta({ current, previous, invert }: { current: number; previous: number; invert?: boolean }) {
  const { diff, pct } = deltaVs(current, previous);
  const good = invert ? diff < 0 : diff > 0;
  const bad = invert ? diff > 0 : diff < 0;
  return (
    <span className={`text-[11px] font-medium tabular-nums ${good ? "text-emerald-700" : bad ? "text-red-600" : "text-muted-foreground"}`}>
      {diff >= 0 ? "+" : ""}{fmtN(diff)}{pct != null && ` (${diff >= 0 ? "+" : ""}${pct.toLocaleString("pt-PT")}%)`}
      <span className="text-muted-foreground font-normal"> vs ant. ({fmtN(previous)})</span>
    </span>
  );
}

function Kpi({ label, value, sub, className, children }: { label: string; value: string; sub?: string; className?: string; children?: React.ReactNode }) {
  return (
    <Card className={`py-0 gap-0 min-w-0 ${className ?? ""}`}>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <StatValue value={value} min={15} max={22} />
        {sub && <p className="text-[11px] text-muted-foreground leading-snug">{sub}</p>}
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * Uma lista das Operações (Reservas criadas / Recolhas / Entregas /
 * Cancelados) num período, lida ao vivo da BD da Multipark. O período abre
 * em HOJE; os contadores e a comparação com o período anterior vêm agregados
 * do servidor; a tabela é paginada.
 */
export default function OpsList({ kind, shared, onShared }: { kind: OpsListKind; shared: OpsListShared; onShared: (patch: Partial<OpsListShared>) => void }) {
  const utils = trpc.useUtils();
  const [state, setState] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState(shared.search);
  const [open, setOpen] = useState<OpsListRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const today = todayLisbon();

  // A pesquisa vai ao servidor com um pequeno atraso (não a cada tecla).
  useEffect(() => { setSearchInput(shared.search); }, [shared.search]);
  useEffect(() => {
    const t = setTimeout(() => { if (searchInput !== shared.search) onShared({ search: searchInput }); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const input = {
    kind, from: shared.from, to: shared.to,
    parkId: shared.parkId || undefined,
    channel: shared.channel,
    state,
    search: shared.search.trim() || undefined,
  };
  const filterKey = JSON.stringify(input);
  useEffect(() => { setPage(0); }, [filterKey]);

  const isToday = shared.from <= today && shared.to >= today;
  const q = trpc.multipark.opsList.useQuery(
    { ...input, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    { refetchOnWindowFocus: isToday, refetchInterval: isToday ? 120_000 : false, placeholderData: (prev) => prev },
  );
  const data = q.data?.available ? q.data : null;
  const s = data?.summary;
  const rows: OpsListRow[] = (data?.rows as OpsListRow[] | undefined) ?? [];

  // O parque escolhido pode não existir noutro âmbito — não fica preso.
  useEffect(() => {
    if (shared.parkId && data && !data.parks.some((p) => p.id === shared.parkId)) onShared({ parkId: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, shared.parkId]);

  const parksByGroup = useMemo(() => {
    const out = new Map<string, Array<{ id: string; name: string; cityName: string | null }>>();
    for (const p of data?.parks ?? []) (out.get(p.label) ?? out.set(p.label, []).get(p.label)!).push(p);
    return [...out.entries()];
  }, [data]);

  const preset = matchPreset(shared.from, shared.to, today);
  const days = rangeDays(shared.from, shared.to);
  const prev = previousRange(shared.from, shared.to);
  const setRange = (from: string, to: string) => onShared(clampRange(from, to));
  const shift = (dir: 1 | -1) => setRange(addDays(shared.from, dir * days), addDays(shared.to, dir * days));

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: OpsListRow[] = [];
      for (let offset = 0; offset < CSV_MAX; offset += 500) {
        const r = await utils.multipark.opsList.fetch({ ...input, limit: 500, offset });
        if (!r.available) { toast.error(r.reason); return; }
        all.push(...(r.rows as OpsListRow[]));
        if (!r.hasMore) break;
      }
      const esc = (v: unknown) => String(v ?? "").replace(/[;\n\r]/g, " ");
      const headers = [OPS_LIST_EVENT_LABELS[kind], "Reserva", "Cliente", "Email", "Matrícula", "Parque", "Cidade", "Grupo", "Canal", "Detalhe do canal", "Recolha", "Entrega", "Estado", "Tipo", "Valor (c/ IVA)", "Pago", "Falta pagar",
        ...(kind === "cancelados" ? ["Motivo", "Observações", "Reembolso", "Valor reembolsado", "Cancelada por", "Data aproximada"] : [])];
      const lines = all.map((b) => [
        fmtBookingDateTime(b.eventAt), b.code ?? b.id, b.clientName, b.clientEmail, b.plate, b.parkName, b.parkCity, b.groupLabel,
        BOOKING_CHANNEL_LABELS[b.channel], b.channelDetail, fmtBookingDateTime(b.checkIn), fmtBookingDateTime(b.checkOut), statusLabel(b.status),
        PARKING_TYPE_LABELS[b.parkingType ?? ""] ?? b.parkingType ?? "", (b.price ?? 0).toFixed(2), (b.paid ?? 0).toFixed(2), (b.toPay ?? 0).toFixed(2),
        ...(kind === "cancelados" ? [b.cancellation?.type, b.cancellation?.obs, b.cancellation?.refund ? (b.cancellation.refunded ? "Reembolsado" : "Pedido") : "Não", (b.cancellation?.refundedAmount ?? 0).toFixed(2), b.cancellation?.by, b.approxDate ? "sim" : ""] : []),
      ].map(esc).join(";"));
      const blob = new Blob(["﻿" + [headers.join(";"), ...lines].join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${kind}_${shared.from}_${shared.to}.csv`; a.click();
      URL.revokeObjectURL(url);
      if (all.length >= CSV_MAX) toast.warning(`CSV limitado às primeiras ${fmtN(CSV_MAX)} linhas — encurta o período ou filtra.`);
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao exportar");
    } finally {
      setExporting(false);
    }
  };

  const eventLabel = OPS_LIST_EVENT_LABELS[kind];
  const pageFrom = page * PAGE_SIZE;
  // Sem filtros a lista compara-se com o cartão do Dashboard (mesmo período).
  const unfiltered = state === "all" && !shared.channel && !shared.parkId && !shared.search.trim();

  return (
    <div className="space-y-4 min-w-0">
      <p className="text-sm text-muted-foreground">{OPS_LIST_SUBTITLES[kind]} — lido em tempo real da Multipark.</p>

      {/* Período */}
      <Card className="py-0 gap-0">
        <CardContent className="p-3 sm:p-4 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {OPS_RANGE_PRESETS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => { const r = presetRange(id, today); setRange(r.from, r.to); }}
                aria-pressed={preset === id}
                className={"text-xs px-2.5 py-1 rounded border transition-colors " + (preset === id ? "bg-primary text-primary-foreground border-primary" : "bg-muted/40 hover:bg-muted")}
              >
                {OPS_RANGE_PRESET_LABELS[id]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button variant="outline" size="icon" aria-label="Período anterior" onClick={() => shift(-1)}><ChevronLeft className="w-4 h-4" /></Button>
            <div>
              <Label className="text-xs mb-1 block">De</Label>
              <Input type="date" value={shared.from} className="w-40" aria-label="De"
                onChange={(e) => { const v = e.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) setRange(v, shared.to < v ? v : shared.to); }} />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Até</Label>
              <Input type="date" value={shared.to} className="w-40" aria-label="Até"
                onChange={(e) => { const v = e.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { if (v < shared.from) setRange(v, v); else if (rangeDays(shared.from, v) > OPS_LIST_MAX_DAYS) setRange(addDays(v, -(OPS_LIST_MAX_DAYS - 1)), v); else setRange(shared.from, v); } }} />
            </div>
            <Button variant="outline" size="icon" aria-label="Período seguinte" onClick={() => shift(1)}><ChevronRight className="w-4 h-4" /></Button>
            <div className="text-xs text-muted-foreground mb-2 min-w-0">
              {days === 1 ? "1 dia" : `${days} dias`} · compara com {prev.from === prev.to ? prev.from : `${prev.from} → ${prev.to}`}
              <span className="block">máximo {OPS_LIST_MAX_DAYS} dias</span>
            </div>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
                <RefreshCw className={`w-4 h-4 mr-1 ${q.isFetching ? "animate-spin" : ""}`} /> Atualizar
              </Button>
              <Button variant="outline" size="sm" disabled={!s?.total || exporting} onClick={exportCsv}>
                <Download className="w-4 h-4 mr-1" /> {exporting ? "A exportar…" : "CSV"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {q.data && !q.data.available && (
        <Card className="border-amber-300 bg-amber-50/60 dark:bg-amber-950/20">
          <CardContent className="p-4 text-sm flex gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{OPS_LIST_LABELS[kind]} indisponíveis</p>
              <p className="text-muted-foreground">{q.data.reason}</p>
            </div>
          </CardContent>
        </Card>
      )}
      {q.error && <p className="text-sm text-destructive">Erro a carregar: {q.error.message}</p>}

      {/* Contadores (c/ IVA) e comparação com o período anterior */}
      {s && (
        <div className="space-y-2">
          {kind === "reservas" && (
            <p className="text-sm text-muted-foreground">
              <b className="text-foreground">{fmtN(s.total)}</b> reservas criadas: <b className="text-foreground">{fmtN(s.active)}</b> não canceladas e <b className="text-foreground">{fmtN(s.cancelled)}</b> já canceladas ({fmtEur(s.cancelledValue)}). Os valores referem-se só às não canceladas.
            </p>
          )}
          {kind === "cancelados" && s.approx > 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              {fmtN(s.approx)} de {fmtN(s.total)} sem registo de cancelamento na Multipark — datadas pela última alteração da reserva (aproximado, assinaladas com ≈).
            </p>
          )}
          {unfiltered && s.ours - s.oursApprox !== s.total && (
            <p className="text-xs text-muted-foreground">
              No Dashboard das Operações: <b className="text-foreground">{fmtN(s.ours - s.oursApprox)}</b> (só parques nossos
              {s.oursApprox > 0 ? ", sem as de data aproximada" : ""}). Aqui entram também{" "}
              {[
                s.total > s.ours ? `${fmtN(s.total - s.ours)} de parques Marketplace` : null,
                s.oursApprox > 0 ? `${fmtN(s.oursApprox)} de parques nossos com data aproximada` : null,
              ].filter(Boolean).join(" e ")}.
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3">
            <Kpi label={kind === "cancelados" ? "Cancelamentos" : kind === "reservas" ? "Reservas criadas" : OPS_LIST_LABELS[kind]} value={fmtN(s.total)}
              sub={kind === "entradas" ? `${fmtN(s.done)} recolhidas · ${fmtN(s.pending)} por recolher` : kind === "saidas" ? `${fmtN(s.done)} entregues · ${fmtN(s.pending)} por entregar` : undefined}>
              <Delta current={s.total} previous={s.prevTotal} invert={kind === "cancelados"} />
            </Kpi>
            <Kpi label={kind === "cancelados" ? "Valor cancelado (c/ IVA)" : kind === "reservas" ? "Valor não cancelado (c/ IVA)" : "Valor (c/ IVA)"} value={fmtEur(s.value)} />
            {kind === "cancelados" ? (
              <>
                <Kpi label="Com reembolso" value={fmtN(s.refund)} sub={`${fmtEur(s.refunded)} reembolsados`} />
                <Kpi label="Pago antes de cancelar" value={fmtEur(s.paid)} />
              </>
            ) : (
              <>
                <Kpi label="Pago" value={fmtEur(s.paid)} />
                <Kpi label="Falta pagar" value={fmtEur(s.toPay)} className="border-amber-300 bg-amber-50/60 dark:bg-amber-950/20" />
              </>
            )}
          </div>

          {/* Canal (contabilidade) — clicar filtra */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-0.5">Canal:</span>
            {s.byChannel.map((c) => (
              <button
                key={c.channel}
                type="button"
                onClick={() => onShared({ channel: shared.channel === c.channel ? "" : c.channel })}
                aria-pressed={shared.channel === c.channel}
                title={`Período anterior: ${fmtN(c.prevCount)}`}
                className={`inline-flex items-center gap-1.5 rounded-md border text-xs py-1 px-2 transition-colors ${CHANNEL_BADGE[c.channel]} ${shared.channel === c.channel ? "bg-primary/10 ring-1 ring-primary" : "bg-background hover:bg-muted"}`}
              >
                <span className="font-medium">{c.label}</span>
                <span className="tabular-nums">{fmtN(c.count)}</span>
                <span className="tabular-nums text-muted-foreground">({fmtEur(c.value)})</span>
              </button>
            ))}
            {shared.channel && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onShared({ channel: "" })}>Todos os canais</Button>}
          </div>

          {/* Por grupo e por parque, com o período anterior */}
          {s.byGroup.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {s.byGroup.map((g) => (
                <Badge key={g.key} variant="outline" className={`text-xs py-1 px-2 font-normal ${g.ours ? "" : "border-dashed"}`} title={`Período anterior: ${fmtN(g.prevCount)}`}>
                  <span className="font-medium mr-1.5">{g.label}</span>
                  <span className="tabular-nums">{fmtN(g.count)}</span>
                  <span className="tabular-nums text-muted-foreground ml-1">· ant. {fmtN(g.prevCount)}</span>
                </Badge>
              ))}
            </div>
          )}
          {s.byPark.length > 1 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground select-none">Por parque ({s.byPark.length})</summary>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {s.byPark.map((p) => (
                  <button key={p.parkId} type="button" onClick={() => onShared({ parkId: shared.parkId === p.parkId ? "" : p.parkId })}
                    className={`inline-flex items-center gap-1 rounded-md border py-1 px-2 ${shared.parkId === p.parkId ? "bg-primary/10 ring-1 ring-primary" : "bg-background hover:bg-muted"}`}>
                    <span className="font-medium">{p.parkName}</span>
                    <span className="tabular-nums">{fmtN(p.count)}</span>
                    <span className="tabular-nums text-muted-foreground">({fmtEur(p.value)}) · ant. {fmtN(p.prevCount)}</span>
                  </button>
                ))}
              </div>
            </details>
          )}
          {kind === "cancelados" && s.byReason.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground mr-0.5">Motivo:</span>
              {s.byReason.map((r) => (
                <Badge key={r.reason} variant="outline" className="text-xs py-1 px-2 font-normal">
                  <span className="font-medium mr-1.5">{r.reason}</span>
                  <span className="tabular-nums">{fmtN(r.count)}</span>
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs mb-1 block">Parque</Label>
          <Select value={shared.parkId || "all"} onValueChange={(v) => onShared({ parkId: v === "all" ? "" : v })}>
            <SelectTrigger className="w-52 max-w-full"><SelectValue placeholder="Todos" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os parques</SelectItem>
              {parksByGroup.map(([label, parks]) => (
                <SelectGroup key={label}>
                  <SelectLabel>{label}</SelectLabel>
                  {parks.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}{p.cityName && !p.name.toLowerCase().includes(p.cityName.toLowerCase()) ? ` · ${p.cityName}` : ""}</SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs mb-1 block">Estado</Label>
          <Select value={state} onValueChange={setState}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {OPS_LIST_STATES[kind].map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="max-w-full">
          <Label className="text-xs mb-1 block">Pesquisar</Label>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input placeholder="N.º, matrícula, nome, email" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} className="pl-8 w-56 max-w-full" />
          </div>
        </div>
      </div>

      {data?.aggTruncated && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">Os contadores podem estar incompletos — encurta o período.</p>
      )}

      {q.isLoading ? (
        <div className="flex items-center justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : data && rows.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Sem resultados para o período selecionado.</CardContent></Card>
      ) : data ? (
        <Card className="py-0 gap-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <th className="p-2 font-medium">{eventLabel}</th>
                  <th className="p-2 font-medium">Reserva</th>
                  <th className="p-2 font-medium">Cliente</th>
                  <th className="p-2 font-medium">Matrícula</th>
                  <th className="p-2 font-medium">Parque</th>
                  {kind !== "entradas" && <th className="p-2 font-medium">Recolha</th>}
                  {kind !== "saidas" && <th className="p-2 font-medium">Entrega</th>}
                  {kind === "cancelados" && <th className="p-2 font-medium">Motivo</th>}
                  {kind === "cancelados" && <th className="p-2 font-medium">Reembolso</th>}
                  {kind === "cancelados" && <th className="p-2 font-medium">Por</th>}
                  <th className="p-2 font-medium">Canal</th>
                  <th className="p-2 font-medium">Estado</th>
                  <th className="p-2 font-medium">Tipo</th>
                  <th className="p-2 font-medium text-right">Valor (c/ IVA)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} className="border-t cursor-pointer hover:bg-muted/30" onClick={() => setOpen(b)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpen(b); }}>
                    <td className="p-2 text-xs whitespace-nowrap tabular-nums" title={b.approxDate ? "Sem registo de cancelamento — última alteração da reserva" : undefined}>
                      {b.approxDate ? "≈ " : ""}{fmtBookingDateTime(b.eventAt)}
                    </td>
                    <td className="p-2 font-mono text-xs whitespace-nowrap">{b.code ?? b.id.slice(0, 10)}{b.pro && <Badge variant="outline" className="ml-1 text-[10px]">PRO</Badge>}</td>
                    <td className="p-2 text-xs max-w-[160px]"><span className="truncate block" title={b.clientName ?? undefined}>{b.clientName ?? "—"}</span></td>
                    <td className="p-2 font-mono text-xs whitespace-nowrap">{b.plate ?? "—"}</td>
                    <td className="p-2 text-xs whitespace-nowrap">
                      <span className="font-medium">{b.parkName ?? "—"}</span>
                      <span className="block text-[11px] text-muted-foreground">{b.groupLabel}</span>
                    </td>
                    {kind !== "entradas" && <td className="p-2 text-xs whitespace-nowrap tabular-nums">{fmtBookingDateTime(b.checkIn)}</td>}
                    {kind !== "saidas" && <td className="p-2 text-xs whitespace-nowrap tabular-nums">{fmtBookingDateTime(b.checkOut)}</td>}
                    {kind === "cancelados" && (
                      <td className="p-2 text-xs max-w-[200px]">
                        <span className="block truncate font-medium" title={b.cancellation?.type ?? undefined}>{b.cancellation?.type ?? "—"}</span>
                        {b.cancellation?.obs && <span className="block truncate text-[11px] text-muted-foreground" title={b.cancellation.obs}>{b.cancellation.obs}</span>}
                      </td>
                    )}
                    {kind === "cancelados" && (
                      <td className="p-2 text-xs whitespace-nowrap">
                        {b.cancellation?.refund
                          ? <span className={b.cancellation.refunded ? "text-emerald-700" : "text-amber-700"}>{b.cancellation.refunded ? "Reembolsado" : "Pedido"}{b.cancellation.refundedAmount ? ` · ${fmtEur(b.cancellation.refundedAmount)}` : ""}</span>
                          : <span className="text-muted-foreground">Não</span>}
                      </td>
                    )}
                    {kind === "cancelados" && <td className="p-2 text-xs max-w-[140px]"><span className="truncate block" title={b.cancellation?.by ?? undefined}>{b.cancellation?.by ?? "—"}</span></td>}
                    <td className="p-2 text-xs max-w-[170px]">
                      <Badge variant="outline" className={`text-[11px] max-w-full ${CHANNEL_BADGE[b.channel]}`} title={b.channelBadge}>
                        <span className="truncate">{b.channelBadge}</span>
                      </Badge>
                      <span className="truncate block text-[11px] text-muted-foreground" title={b.channelDetail}>{b.channelDetail}</span>
                      {b.channel === "marketplace" && (
                        <span className={`block text-[11px] ${b.operated ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`} title="Parque operado por nós ou não (comissão do Marketplace diferente)">{operatedLabel(b.operated)}</span>
                      )}
                    </td>
                    <td className="p-2"><Badge className={BOOKING_STATUS_COLORS[b.status as BookingStatus] ?? "bg-gray-100 text-gray-800"}>{statusLabel(b.status)}</Badge></td>
                    <td className="p-2 text-xs whitespace-nowrap">{PARKING_TYPE_LABELS[b.parkingType ?? ""] ?? b.parkingType ?? "—"}</td>
                    <td className="p-2 text-xs text-right whitespace-nowrap tabular-nums">
                      {fmtEur(b.price)}
                      {b.toPay != null && b.toPay > 0 && b.status !== "CANCELLED" && <span className="block text-[11px] text-amber-700">falta {fmtEur(b.toPay)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap px-3 py-2 border-t text-xs text-muted-foreground">
            <span>A mostrar {fmtN(pageFrom + 1)}–{fmtN(pageFrom + rows.length)} de {fmtN(s?.total ?? rows.length)}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 0 || q.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>Anterior</Button>
              <Button variant="outline" size="sm" disabled={!data.hasMore || q.isFetching} onClick={() => setPage((p) => p + 1)}>Seguinte</Button>
            </div>
          </div>
        </Card>
      ) : null}

      {open && (
        <BookingDetailDialog
          booking={{
            externalId: open.id,
            bookingNumber: open.code,
            status: open.status,
            parkName: open.parkName,
            city: open.parkCity,
            vehicleType: open.vehicleType,
            clientFirstName: open.clientName,
            clientEmail: open.clientEmail,
            clientPhone: open.clientPhone,
            licensePlate: open.plate,
            vehicleBrand: open.vehicleBrand,
            vehicleModel: open.vehicleModel,
            checkIn: open.checkIn,
            checkOut: open.checkOut,
            deliveryType: open.deliveryType,
            parkingType: open.parkingType,
            totalPrice: open.price,
            totalPaid: open.paid,
            remainingToPay: open.toPay,
            paymentMethod: open.paymentMethod,
            origin: `${BOOKING_CHANNEL_LABELS[open.channel]} · ${open.channelDetail}`,
            partnerName: open.partnerName,
            checkinAgentName: open.checkInDriverName,
            checkoutAgentName: open.checkOutDriverName,
            bookingCreatedAt: open.createdAt,
            cancelledAt: open.cancellation?.at ?? null,
            remarks: [
              open.remarks,
              open.cancellation ? `Cancelada${open.cancellation.by ? ` por ${open.cancellation.by}` : ""}: ${[open.cancellation.type, open.cancellation.obs].filter(Boolean).join(" — ") || "sem motivo"}` : null,
            ].filter(Boolean).join(" · ") || null,
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
