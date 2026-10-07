/**
 * Filtros das Tarefas (Jorge, 7 out 2026: "Tudo que de para filtrar bem").
 * Regras e estado em shared/taskFilters.ts; aqui só a apresentação:
 *  - botão "Filtros" com o nº de filtros ativos → painel (de baixo no
 *    telemóvel, à direita no computador) com as facetas e os contadores;
 *  - linha de chips dos filtros ativos (cada um sai com ×) + "Limpar filtros";
 *  - `useTaskFilters`: os filtros ficam guardados por utilizador neste aparelho.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/useMobile";
import { Loader2, SlidersHorizontal, X } from "lucide-react";
import { TASK_SOURCE_LABELS, TASK_SOURCE_MODULES, TASK_STATUS_LABELS, TASK_STATUSES } from "@shared/taskRules";
import {
  BOOKING_STATUS_UNKNOWN,
  TASK_BOOKING_FILTERS,
  TASK_DUE_FILTERS,
  TASK_DUE_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  activeTaskFilterCount,
  bookingFilterLabel,
  bookingStatusChip,
  clearTaskFilters,
  normalizeTaskFilters,
  patchTaskFilters,
  taskFiltersStorageKey,
  toggleTaskFilter,
  type TaskFacet,
  type TaskFacetCounts,
  type TaskFilters,
} from "@shared/taskFilters";

/** Filtros guardados por utilizador neste aparelho (localStorage); sem storage → só nesta visita. */
export function useTaskFilters(userId: number | null | undefined, initialQ?: string): [TaskFilters, (next: TaskFilters) => void] {
  const key = userId ? taskFiltersStorageKey(userId) : null;
  const read = useCallback((): TaskFilters => {
    let saved: unknown = null;
    try { if (key) saved = JSON.parse(localStorage.getItem(key) ?? "null"); } catch { /* JSON inválido ou sem storage */ }
    const f = normalizeTaskFilters(saved);
    return initialQ ? patchTaskFilters(f, { q: initialQ }) : f;
  }, [key, initialQ]);
  const [filters, setFilters] = useState<TaskFilters>(read);
  // O utilizador pode chegar depois do 1.º render (sessão a carregar).
  useEffect(() => { setFilters(read()); }, [read]);
  const set = useCallback((next: TaskFilters) => {
    setFilters(next);
    try { if (key) localStorage.setItem(key, JSON.stringify({ ...next, q: "" })); } catch { /* sem storage */ }
  }, [key]);
  return [filters, set];
}

type Option = { value: string; label: string; className?: string };

const FACET_OPTIONS: Record<TaskFacet, { title: string; options: Option[] }> = {
  sources: { title: "Origem", options: TASK_SOURCE_MODULES.map((v) => ({ value: v, label: TASK_SOURCE_LABELS[v] })) },
  statuses: { title: "Estado da tarefa", options: TASK_STATUSES.map((v) => ({ value: v, label: TASK_STATUS_LABELS[v] })) },
  priorities: { title: "Prioridade", options: TASK_PRIORITIES.map((v) => ({ value: v, label: TASK_PRIORITY_LABELS[v] })) },
  due: { title: "Prazo", options: TASK_DUE_FILTERS.map((v) => ({ value: v, label: TASK_DUE_LABELS[v] })) },
  bookingStatuses: {
    title: "Estado da reserva",
    options: TASK_BOOKING_FILTERS.map((v) => ({
      value: v, label: bookingFilterLabel(v), className: bookingStatusChip(v === BOOKING_STATUS_UNKNOWN ? null : v).className,
    })),
  },
};
const FACET_ORDER: TaskFacet[] = ["sources", "statuses", "due", "priorities", "bookingStatuses"];

export interface TaskFiltersProps {
  filters: TaskFilters;
  onChange: (next: TaskFilters) => void;
  counts?: TaskFacetCounts;
  countsLoading?: boolean;
  /** Nº de tarefas com os filtros atuais (o que está no ecrã). */
  resultCount?: number;
  /** "As minhas": o responsável é sempre a própria pessoa (sem esse filtro). */
  mine: boolean;
  /** Responsáveis possíveis (quem edita). */
  assignees?: Array<{ id: number; fullName: string }>;
  /** Nomes dos centros de custos (para o chip). */
  projectName?: (id: number) => string | undefined;
}

export function TaskFiltersButton({ filters, onChange, counts, countsLoading, resultCount, mine, assignees }: TaskFiltersProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  // Pesquisa e centro de custos têm o seu próprio campo na barra: não contam aqui.
  const n = activeTaskFilterCount({ ...filters, q: "", projectId: null }, { ignoreAssignee: mine });
  return (
    <>
      <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setOpen(true)} aria-label="Filtros" title="Filtrar por origem, estado, prazo, prioridade, estado da reserva e responsável">
        <SlidersHorizontal className="h-4 w-4" />
        <span className="hidden sm:inline">Filtros</span>
        {n > 0 && <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{n}</Badge>}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side={isMobile ? "bottom" : "right"} className={isMobile ? "max-h-[85dvh]" : "w-full sm:max-w-md overflow-y-auto"}>
          <SheetHeader className="pb-0">
            <SheetTitle className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4" />Filtrar tarefas</SheetTitle>
            <SheetDescription>
              Os filtros juntam-se (origem E estado E prazo…); dentro de cada grupo basta uma opção. O número diz quantas tarefas aparecem com essa opção.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 space-y-5 overflow-y-auto">
            {!mine && assignees && (
              <div className="space-y-1.5">
                <Label>Responsável</Label>
                <Select
                  value={filters.assignee == null ? "all" : String(filters.assignee)}
                  onValueChange={(v) => onChange(patchTaskFilters(filters, { assignee: v === "all" ? null : v === "none" ? "none" : Number(v) }))}
                >
                  <SelectTrigger className="w-full" aria-label="Responsável"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os responsáveis</SelectItem>
                    <SelectItem value="none">Sem responsável</SelectItem>
                    {assignees.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.fullName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {FACET_ORDER.map((facet) => {
              const def = FACET_OPTIONS[facet];
              const selected = filters[facet] as readonly string[];
              return (
                <fieldset key={facet} className="space-y-1.5">
                  <legend className="text-sm font-medium mb-1 flex items-center gap-2">
                    {def.title}
                    {facet === "bookingStatuses" && <span className="text-[11px] font-normal text-muted-foreground">(só tarefas de uma reserva)</span>}
                  </legend>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
                    {def.options.map((o) => {
                      const on = selected.includes(o.value);
                      const c = counts?.[facet]?.[o.value];
                      return (
                        <label key={o.value} className={`flex items-center gap-2 rounded px-1.5 py-1.5 cursor-pointer hover:bg-muted/50 ${!on && c === 0 ? "opacity-50" : ""}`}>
                          <Checkbox checked={on} onCheckedChange={() => onChange(toggleTaskFilter(filters, facet, o.value as any))} />
                          {o.className ? (
                            <span className={`text-xs rounded px-1.5 py-0.5 ${o.className}`}>{o.label}</span>
                          ) : (
                            <span className="text-sm">{o.label}</span>
                          )}
                          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {countsLoading && c === undefined ? <Loader2 className="h-3 w-3 animate-spin" /> : c ?? ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
          </div>
          <SheetFooter className="flex-row items-center justify-between gap-2 border-t">
            <Button variant="ghost" size="sm" onClick={() => onChange(patchTaskFilters(clearTaskFilters(), { q: filters.q, projectId: filters.projectId }))}>
              <X className="h-3.5 w-3.5 mr-1" />Limpar
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              Ver {resultCount ?? ""} tarefa{resultCount === 1 ? "" : "s"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Chips dos filtros ativos (cada um sai com ×) e "Limpar filtros". Nada ativo → nada. */
export function TaskActiveFilters({ filters, onChange, mine, assignees, projectName }: TaskFiltersProps) {
  const chips: Array<{ key: string; label: string; className?: string; remove: () => void }> = [];
  for (const facet of FACET_ORDER) {
    for (const v of filters[facet] as readonly string[]) {
      const o = FACET_OPTIONS[facet].options.find((x) => x.value === v);
      chips.push({
        key: `${facet}:${v}`,
        label: `${FACET_OPTIONS[facet].title}: ${o?.label ?? v}`,
        className: facet === "bookingStatuses" ? o?.className : undefined,
        remove: () => onChange(toggleTaskFilter(filters, facet, v as any)),
      });
    }
  }
  if (!mine && filters.assignee != null) {
    const who = filters.assignee === "none" ? "Sem responsável" : assignees?.find((a) => a.id === filters.assignee)?.fullName ?? `#${filters.assignee}`;
    chips.push({ key: "assignee", label: `Responsável: ${who}`, remove: () => onChange(patchTaskFilters(filters, { assignee: null })) });
  }
  if (filters.projectId != null) {
    chips.push({ key: "project", label: `Centro: ${projectName?.(filters.projectId) ?? `#${filters.projectId}`}`, remove: () => onChange(patchTaskFilters(filters, { projectId: null })) });
  }
  if (filters.q.trim()) chips.push({ key: "q", label: `Pesquisa: “${filters.q.trim()}”`, remove: () => onChange(patchTaskFilters(filters, { q: "" })) });
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Filtros ativos">
      {chips.map((c) => (
        <Badge key={c.key} variant="outline" className={`gap-1 pr-1 text-xs font-normal ${c.className ?? ""}`}>
          {c.label}
          <button type="button" className="rounded-sm p-0.5 hover:bg-black/10" aria-label={`Tirar o filtro ${c.label}`} onClick={c.remove}>
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange(clearTaskFilters())}>
        <X className="h-3.5 w-3.5 mr-1" />Limpar filtros
      </Button>
    </div>
  );
}

/** Chip do estado da reserva (cores dos 9 estados Multipark; desconhecido em cinzento). */
export function BookingStatusChip({ status }: { status: string | null | undefined }) {
  const c = bookingStatusChip(status);
  return (
    <Badge variant="outline" className={`text-xs border-transparent ${c.className}`} title={c.known ? "Estado da reserva (Multipark)" : "Estado da reserva desconhecido (ainda não sincronizada)"}>
      {c.label}
    </Badge>
  );
}
