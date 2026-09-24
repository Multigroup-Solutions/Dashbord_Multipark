import { trpc } from "@/lib/trpc";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState, useMemo } from "react";
import { usePersistedState } from "@/hooks/usePersistedState";
import { Button } from "@/components/ui/button";
import { QuickRangeBar, thisMonthRange } from "@/components/QuickRangeBar";
import { useTableSort, Th } from "@/components/SortableTable";
import DateRangeNav from "@/components/DateRangeNav";
import BookingDetailDialog from "@/components/BookingDetailDialog";
import { toast } from "sonner";
import { StatValue } from "@/components/StatValue";

import {
  Sparkles, Euro, TrendingUp, CheckCircle2, Clock, Droplets, Zap, Car, Package, Download,
} from "lucide-react";

const fmtN = (n: number) => n.toLocaleString("pt-PT");
const fmtE = (n: number) => n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

const SERVICE_ICONS: Record<string, any> = {
  lavagem: Droplets,
  carregamento: Zap,
  valet: Car,
};

function getServiceIcon(name: string) {
  const lower = name.toLowerCase();
  for (const [key, Icon] of Object.entries(SERVICE_ICONS)) {
    if (lower.includes(key)) return Icon;
  }
  return Package;
}

// Normalização dos tipos vindos da API ("FLEX"/"Flexivel" são o mesmo) e
// separação entre SERVIÇOS COM VALOR e FLAGS OPERACIONAIS (marcas a ~0€
// tipo "No pay"/"After hour collections" que não são serviços vendidos).
function normalizeServiceName(name: string): string {
  const n = (name ?? "").trim();
  const lower = n.toLowerCase();
  if (lower === "flex" || lower === "flexivel" || lower === "flexível") return "Flexível";
  if (lower.startsWith("carregamento")) return n.includes("El") || n.includes("el") ? "Carregamento Elétrico" : n;
  return n;
}
const OPERATIONAL_FLAGS = new Set([
  "no pay", "after hour collections", "aeroporto faro partidas", "aeroporto lisboa partidas", "aeroporto porto partidas",
]);
function isOperationalFlag(name: string, price: number): boolean {
  const lower = (name ?? "").trim().toLowerCase();
  return OPERATIONAL_FLAGS.has(lower) || (price === 0 && lower.includes("aeroporto"));
}

export default function ServicesPage() {
  const [defFrom, defTo] = thisMonthRange();
  // Mesmo período das Reservas & Operações (chaves partilhadas)
  const [startDate, setStartDate] = usePersistedState("mpk.shared.start", defFrom);
  const [endDate, setEndDate] = usePersistedState("mpk.shared.end", defTo);
  const [activeRange, setActiveRange] = usePersistedState<string>("mpk.shared.range", "thisMonth");
  // Cidade/projeto do filtro global (o servidor aplica sempre o âmbito do utilizador)
  const globalFilters = useGlobalFilters();

  const { data, isLoading } = trpc.services.multiparkExtras.useQuery({ startDate, endDate, projectId: globalFilters.projectId });
  const [showFlags, setShowFlags] = usePersistedState<boolean>("servicos.flags", false);
  const [detailExternalId, setDetailExternalId] = useState<string | null>(null);
  const detailQ = trpc.multipark.bookingByExternalId.useQuery(
    { externalId: detailExternalId ?? "" },
    { enabled: !!detailExternalId },
  );
  const utils = trpc.useUtils();
  const setDoneMut = trpc.services.setExtraDone.useMutation({
    onSuccess: () => { utils.services.multiparkExtras.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  // Normaliza nomes e separa flags operacionais (fora por defeito)
  const services = useMemo(() => {
    const all = (data?.services || []).map((s: any) => ({
      ...s,
      serviceName: normalizeServiceName(s.serviceName),
      isFlag: isOperationalFlag(s.serviceName, s.price || 0),
    }));
    return showFlags ? all : all.filter((s: any) => !s.isFlag);
  }, [data, showFlags]);
  const flagCount = useMemo(
    () => (data?.services || []).filter((s: any) => isOperationalFlag(s.serviceName, s.price || 0)).length,
    [data],
  );

  const stats = useMemo(() => {
    const done = services.filter((s: any) => s.done);
    const pending = services.filter((s: any) => !s.done);
    const totalValue = services.reduce((sum: number, s: any) => sum + (s.price || 0), 0);
    const doneValue = done.reduce((sum: number, s: any) => sum + (s.price || 0), 0);
    const pendingValue = pending.reduce((sum: number, s: any) => sum + (s.price || 0), 0);

    const byType: Record<string, { count: number; done: number; pending: number; value: number }> = {};
    for (const s of services) {
      const key = (s as any).serviceName || "Desconhecido";
      if (!byType[key]) byType[key] = { count: 0, done: 0, pending: 0, value: 0 };
      byType[key].count++;
      byType[key].value += (s as any).price || 0;
      if ((s as any).done) byType[key].done++;
      else byType[key].pending++;
    }

    const byPark: Record<string, { count: number; value: number }> = {};
    for (const s of services) {
      const key = (s as any).parkName || "Desconhecido";
      if (!byPark[key]) byPark[key] = { count: 0, value: 0 };
      byPark[key].count++;
      byPark[key].value += (s as any).price || 0;
    }

    return {
      total: services.length,
      done: done.length,
      pending: pending.length,
      totalValue,
      doneValue,
      pendingValue,
      byType,
      byPark,
    };
  }, [services]);

  const [filterType, setFilterType] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

  const filtered = useMemo(() => {
    let list = services;
    if (filterType !== "all") list = list.filter((s: any) => s.serviceName === filterType);
    if (filterStatus === "done") list = list.filter((s: any) => s.done);
    if (filterStatus === "pending") list = list.filter((s: any) => !s.done);
    return list;
  }, [services, filterType, filterStatus]);

  // Ordenação por coluna
  const { sorted: sortedServices, sortKey, sortDir, toggle } = useTableSort(filtered as any[]);

  const typeOptions = useMemo(() => {
    return Object.keys(stats.byType).sort();
  }, [stats.byType]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <p className="text-muted-foreground">Serviços extra das reservas Multipark (lavagens, carregamentos, etc.)</p>
        <QuickRangeBar
          active={activeRange}
          onPick={(f, t, id) => { setStartDate(f); setEndDate(t); setActiveRange(id); }}
        />
        <div className="flex flex-wrap items-end gap-3">
          <DateRangeNav
            start={startDate}
            end={endDate}
            gran={(activeRange === "thisWeek" || activeRange === "lastWeek" ? "week" : activeRange === "thisMonth" || activeRange === "lastMonth" ? "month" : "custom") as any}
            showAll={false}
            onChange={(s2, e2) => { setStartDate(s2); setEndDate(e2); setActiveRange(""); }}
          />
          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none mb-2" title="Marcas operacionais a 0€ (No pay, After hour, Aeroporto…) — não são serviços vendidos">
            <input type="checkbox" checked={showFlags} onChange={(e) => setShowFlags(e.target.checked)} />
            Mostrar flags operacionais{flagCount > 0 ? ` (${flagCount})` : ""}
          </label>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : services.length === 0 ? (
        <Card className="p-10 text-center">
          <Sparkles className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">Sem serviços extra neste período</p>
        </Card>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Card className="p-3 gap-1 min-w-0">
              <div className="flex items-center gap-2"><Sparkles className="w-4 h-4" /><span className="text-xs text-muted-foreground truncate">Total</span></div>
              <StatValue value={fmtN(stats.total)} max={24} />
            </Card>
            <Card className="p-3 gap-1 min-w-0">
              <div className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-green-500" /><span className="text-xs text-muted-foreground truncate">Feitos</span></div>
              <StatValue value={fmtN(stats.done)} max={24} className="text-green-700" />
            </Card>
            <Card className="p-3 gap-1 min-w-0">
              <div className="flex items-center gap-2"><Clock className="w-4 h-4 text-amber-500" /><span className="text-xs text-muted-foreground truncate">Pendentes</span></div>
              <StatValue value={fmtN(stats.pending)} max={24} className="text-amber-700" />
            </Card>
            <Card className="p-3 gap-1 min-w-0">
              <div className="flex items-center gap-2"><Euro className="w-4 h-4 text-blue-500" /><span className="text-xs text-muted-foreground truncate">Valor Total</span></div>
              <StatValue value={fmtE(stats.totalValue)} max={24} />
            </Card>
            <Card className="p-3 gap-1 min-w-0">
              <div className="flex items-center gap-2"><Euro className="w-4 h-4 text-green-500" /><span className="text-xs text-muted-foreground truncate">Valor Feitos</span></div>
              <StatValue value={fmtE(stats.doneValue)} max={24} className="text-green-700" />
            </Card>
            <Card className="p-3 gap-1 min-w-0">
              <div className="flex items-center gap-2"><Euro className="w-4 h-4 text-amber-500" /><span className="text-xs text-muted-foreground truncate">Valor Pendente</span></div>
              <StatValue value={fmtE(stats.pendingValue)} max={24} className="text-amber-700" />
            </Card>
          </div>

          {/* By Type */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.entries(stats.byType).map(([name, d]) => {
              const Icon = getServiceIcon(name);
              return (
                <Card key={name} className="p-3 gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 shrink-0 text-primary" />
                    <span className="text-xs font-medium truncate" title={name}>{name}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 tabular-nums">
                    <p className="text-lg font-bold">{fmtN(d.count)}</p>
                    <span className="text-xs text-green-700 whitespace-nowrap">{fmtN(d.done)} feitos</span>
                    {d.pending > 0 && <span className="text-xs text-amber-700 whitespace-nowrap">{fmtN(d.pending)} pend.</span>}
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">{fmtE(d.value)}</p>
                </Card>
              );
            })}
          </div>

          {/* By Park */}
          {Object.keys(stats.byPark).length > 1 && (
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Por Parque</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {Object.entries(stats.byPark)
                    .sort(([, a], [, b]) => b.count - a.count)
                    .map(([park, d]) => (
                      <div key={park} className="flex items-center justify-between gap-3 p-2 rounded bg-muted">
                        <span className="text-sm font-medium min-w-0 truncate" title={park}>{park}</span>
                        <div className="flex items-center gap-2 sm:gap-4 text-sm shrink-0 tabular-nums">
                          <span className="whitespace-nowrap">{fmtN(d.count)} <span className="hidden sm:inline">serviços</span><span className="sm:hidden">serv.</span></span>
                          <Badge variant="secondary">{fmtE(d.value)}</Badge>
                        </div>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Filters */}
          <div className="flex gap-3 flex-wrap items-end">
            <div>
              <Label className="text-xs">Tipo</Label>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {typeOptions.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Estado</Label>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="done">Feitos</SelectItem>
                  <SelectItem value="pending">Pendentes</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={filtered.length === 0}
              onClick={() => {
                const headers = ["Serviço","Cliente","Matrícula","Parque","Preço","Check-out","Estado"];
                const rows = filtered.map((s: any) => [
                  (s.serviceName || "").replace(/;/g, ","),
                  (s.clientName || "").replace(/;/g, ","),
                  s.licensePlate || "",
                  (s.parkName || "").replace(/;/g, ","),
                  (s.price || 0).toFixed(2),
                  s.checkOut ? new Date(s.checkOut).toISOString().slice(0, 10) : "",
                  s.done ? "Feito" : "Pendente",
                ]);
                const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
                const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = `servicos_${startDate}_${endDate}.csv`; a.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download className="w-4 h-4 mr-1" /> CSV
            </Button>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b text-left">
                  <Th k="serviceName" label="Serviço" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <Th k="clientName" label="Cliente" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <Th k="licensePlate" label="Matrícula" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <Th k="parkName" label="Parque" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <Th k="price" label="Preço" align="right" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <Th k="checkOut" label="Check-out" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <Th k="done" label="Estado" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {sortedServices.map((s: any, i: number) => (
                  <tr
                    key={`${s.bookingId}-${i}`}
                    className="border-b hover:bg-muted/50 cursor-pointer"
                    onClick={() => setDetailExternalId(s.bookingId)}
                  >
                    <td className="p-2 font-medium min-w-[12rem]">
                      {s.serviceName}
                      {s.isFlag && <Badge variant="outline" className="ml-1 text-[11px] text-muted-foreground">flag</Badge>}
                    </td>
                    <td className="p-2 text-xs">{(s as any).clientName || "—"}</td>
                    <td className="p-2 font-mono text-xs whitespace-nowrap">{s.licensePlate || "—"}</td>
                    <td className="p-2">{s.parkName || "—"}</td>
                    <td className="p-2 text-right tabular-nums whitespace-nowrap">{fmtE(s.price || 0)}</td>
                    <td className="p-2 text-xs whitespace-nowrap">{s.checkOut ? fmtPTDate(s.checkOut) : "—"}</td>
                    <td className="p-2">
                      {/* Clicar dá baixa / reabre (guardado na app; o sync respeita) */}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); if (s.id) setDoneMut.mutate({ id: s.id, done: !s.done }); }}
                        title={s.done ? "Clique para reabrir" : "Clique para dar baixa (feito)"}
                        disabled={setDoneMut.isPending}
                      >
                        <Badge variant={s.done ? "default" : "secondary"} className="cursor-pointer hover:opacity-80">
                          {s.done ? "Feito ✓" : "Pendente"}
                        </Badge>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-6">Sem resultados com os filtros selecionados</p>
            )}
          </div>

          {detailExternalId && detailQ.data && (
            <BookingDetailDialog booking={detailQ.data} onClose={() => setDetailExternalId(null)} />
          )}
        </>
      )}
    </div>
  );
}
