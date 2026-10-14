import { useEffect, useMemo, useRef, type ComponentProps } from "react";
import { Th } from "@/components/SortableTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HabitualLine } from "@/components/AvailabilityPatternCard";
import { cn } from "@/lib/utils";
import { fmtPTDate } from "@/lib/lisbonTime";
import { AlertTriangle, BellOff, ChevronDown, ChevronRight, MapPin, Moon, Pencil, Sun } from "lucide-react";
import { CITY_LABELS, CITY_SOURCE_LABELS } from "@shared/city";
import { availabilityCellDisplay } from "@shared/availabilityWindow";
import { contactPrefsLabel } from "@shared/contactPrefs";
import {
  AVAILABILITY_PAGE_SIZE,
  AVAILABILITY_STATUS_LABELS,
  availabilityStatus,
  countAvailabilityStatuses,
  groupByCity,
  visibleSlice,
  type AvailabilityStatus,
  type AvailabilityStatusFilter,
  type CityGroupKey,
} from "@shared/availabilityGroups";
import {
  STATUS_SECTION_HINTS,
  isSectionOpen as sectionOpenRule,
  searchListKey,
  type GridViewState,
  perDayShiftTotals,
  sectionKey,
  shortDayHeader,
  splitByStatus,
  statusCountLabel,
  statusSectionTitle,
} from "@shared/availabilityFilters";
import type { AvailabilityDayHeader, AvailabilityRow } from "./availabilityTypes";

/** Cor de cada estado — a mesma nos quadrados de cima, nas secções e nos pontos das linhas. */
export const STATUS_TONE: Record<AvailabilityStatus, { dot: string; text: string; soft: string }> = {
  available: { dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400", soft: "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900" },
  no_answer: { dot: "bg-amber-400", text: "text-amber-700 dark:text-amber-400", soft: "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900" },
  unavailable: { dot: "bg-slate-400", text: "text-slate-600 dark:text-slate-300", soft: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700" },
};

/**
 * Caixa de selecionar com o estado "alguns" (indeterminate) — para a cidade, a
 * secção e "Selecionar os N": cheia = todos, traço = alguns, vazia = nenhum.
 */
export function TriCheckbox({ checked, indeterminate, className, ...rest }: Omit<ComponentProps<"input">, "type"> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={cn("h-4 w-4 shrink-0 accent-primary", className)}
      checked={checked}
      aria-checked={indeterminate && !checked ? "mixed" : checked ? "true" : "false"}
      {...rest}
    />
  );
}

/**
 * Estado de abertura e paginação da grelha — vive na página para a barra de
 * envio saber quem vai no envio sem estar à vista (`hiddenGridRowIds`).
 */
export type GridOpenState = GridViewState;

const cityGroupLabel = (key: CityGroupKey) => (key === "none" ? "Sem cidade" : CITY_LABELS[key]);

type Sort = { sortKey: string | null; sortDir: 1 | -1; toggle: (k: string) => void };

/**
 * Grelha semanal da Disponibilidade: uma caixa por cidade (todas abertas, com
 * as contagens no cabeçalho) e, dentro de cada uma, as secções por estado —
 * "Disponíveis" aberta, "Sem resposta" e "Indisponíveis" fechadas com o número
 * à vista (`defaultOpenStatuses`). A pesquisar, cada cidade é uma lista só,
 * pela relevância do nome (44a). Cada secção mostra 25 de cada vez.
 *
 * Só muda o que se VÊ: o conjunto filtrado (seleção, totais e envio) é o
 * mesmo, venha a secção aberta ou fechada.
 */
export function AvailabilityGrid({
  rows,
  dayHeaders,
  selectedIds,
  onToggleMany,
  sort,
  status,
  searching,
  openState,
  onOpenStateChange,
  canEdit,
  lastWorkedLoading,
  onEdit,
  onOpenEmployee,
}: {
  /** Já filtradas e ordenadas (`applyAvailabilityFilters` + ordenação da coluna). */
  rows: AvailabilityRow[];
  dayHeaders: AvailabilityDayHeader[];
  selectedIds: ReadonlySet<number>;
  onToggleMany: (rows: { employeeId: number }[], checked: boolean) => void;
  sort: Sort;
  status: AvailabilityStatusFilter;
  searching: boolean;
  /** Cidades fechadas, secções abertas/fechadas à mão e linhas mostradas (a página guarda-o e repõe-no ao mudar de filtro). */
  openState: GridOpenState;
  onOpenStateChange: (next: GridOpenState) => void;
  canEdit: boolean;
  lastWorkedLoading: boolean;
  onEdit: (row: AvailabilityRow) => void;
  onOpenEmployee: (employeeId: number) => void;
}) {
  const groups = useMemo(() => groupByCity(rows), [rows]);
  const { closedCities, sectionOverrides, shownPer } = openState;
  const isSectionOpen = (city: CityGroupKey, st: AvailabilityStatus) => sectionOpenRule(sectionOverrides, city, st, status);
  const toggleSection = (city: CityGroupKey, st: AvailabilityStatus) =>
    onOpenStateChange({ ...openState, sectionOverrides: { ...sectionOverrides, [sectionKey(city, st)]: !isSectionOpen(city, st) } });
  const toggleCity = (city: CityGroupKey) => {
    const next = new Set(closedCities);
    if (next.has(city)) next.delete(city);
    else next.add(city);
    onOpenStateChange({ ...openState, closedCities: next });
  };
  const showMore = (key: string, by: number) =>
    onOpenStateChange({ ...openState, shownPer: { ...shownPer, [key]: (shownPer[key] ?? AVAILABILITY_PAGE_SIZE) + by } });
  function openEverything() {
    const all: Record<string, boolean> = {};
    for (const g of groups) for (const s of splitByStatus(g.rows)) all[sectionKey(g.key, s.status)] = true;
    onOpenStateChange({ ...openState, closedCities: new Set(), sectionOverrides: all });
  }
  const dayKeys = useMemo(() => dayHeaders.map((h) => h.day), [dayHeaders]);
  const colCount = 3 + dayHeaders.length;

  const renderRow = (ex: AvailabilityRow, showStatus: boolean) => {
    const st = availabilityStatus(ex);
    const checked = selectedIds.has(ex.employeeId);
    return (
      <tr key={ex.employeeId} className={cn("border-b last:border-0 hover:bg-muted/30", checked && "bg-primary/5")}>
        <td className={cn("sticky left-0 z-[1] py-1.5 pl-3 pr-2 align-top shadow-[1px_0_0_var(--border)]", checked ? "bg-accent" : "bg-card")}>
          <div className="flex items-start gap-2 min-w-[11rem] max-w-[16rem]">
            <TriCheckbox
              className="mt-1"
              aria-label={`Selecionar ${ex.fullName}`}
              checked={checked}
              onChange={(e) => onToggleMany([ex], e.target.checked)}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className={cn("h-2 w-2 rounded-full shrink-0", STATUS_TONE[st].dot)}
                  title={AVAILABILITY_STATUS_LABELS[st]}
                  aria-label={AVAILABILITY_STATUS_LABELS[st]}
                />
                <button
                  type="button"
                  className="truncate text-left font-medium hover:underline"
                  title={`Abrir ficha de ${ex.fullName}${ex.citySource ? ` · cidade obtida da ${CITY_SOURCE_LABELS[ex.citySource]}` : ""}`}
                  onClick={() => onOpenEmployee(ex.employeeId)}
                >
                  {ex.fullName}
                </button>
                {canEdit && (
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground/60 hover:text-foreground"
                    title="Marcar a disponibilidade desta semana por este extra"
                    aria-label={`Marcar disponibilidade de ${ex.fullName}`}
                    onClick={() => onEdit(ex)}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1 mt-0.5">
                {showStatus && (
                  <span className={cn("inline-flex items-center rounded-full border px-1.5 text-[10px] font-medium", STATUS_TONE[st].soft)}>
                    {AVAILABILITY_STATUS_LABELS[st]}
                  </span>
                )}
                {(ex.noAutoWhatsapp || ex.noAutoEmail) && (
                  <span
                    className="inline-flex items-center gap-0.5 rounded border px-1 text-[10px] text-amber-700 dark:text-amber-400"
                    title={`Ficha com "${contactPrefsLabel(ex) ?? ""}": não recebe pedidos nem avisos por ${ex.noAutoWhatsapp && ex.noAutoEmail ? "WhatsApp nem email" : ex.noAutoWhatsapp ? "WhatsApp" : "email"}.`}
                  >
                    <BellOff className="h-3 w-3" />{ex.noAutoWhatsapp && ex.noAutoEmail ? "nada" : ex.noAutoWhatsapp ? "sem WA" : "sem email"}
                  </span>
                )}
              </div>
              {/* Dias livres habituais (8 out 2026): só para quem ainda não preencheu a semana. */}
              {!ex.responded && <HabitualLine habitual={ex.habitual} note={ex.habitualNote} />}
            </div>
          </div>
        </td>
        <td className="py-1.5 px-2 whitespace-nowrap text-xs text-muted-foreground align-top">
          {ex.lastWorked ? fmtPTDate(ex.lastWorked) : lastWorkedLoading ? "…" : "nunca"}
        </td>
        <td className="py-1.5 px-2 whitespace-nowrap text-xs align-top">
          {ex.phoneE164 ? (
            <span className="text-muted-foreground" title={ex.phone ?? undefined}>{ex.phoneE164}</span>
          ) : (
            <Badge
              variant="outline"
              className="border-amber-400 text-amber-700 gap-1 font-normal"
              title={ex.phone ? `Número não reconhecido: ${ex.phone}` : "Ficha sem telefone"}
            >
              <AlertTriangle className="h-3 w-3" /> {ex.phone ? "número não reconhecido" : "sem número"}
            </Badge>
          )}
        </td>
        {ex.days.map((d) => {
          const marked = d.morning || d.night || d.fromHour != null || d.toHour != null;
          // Pedido 7: com horas, mostram-se as horas reais (o slot do site "18H-01H"
          // aparecia com a lua de "Noite 15h–03h" e parecia cobrir até às 03h).
          const cell = marked ? availabilityCellDisplay(d) : null;
          const content = cell ? (
            <span className="inline-flex flex-col items-center leading-tight">
              <span className="inline-flex gap-0.5 justify-center items-center">
                {cell.morning && <Sun className="h-3.5 w-3.5 text-amber-500" />}
                {cell.night && <Moon className="h-3.5 w-3.5 text-indigo-500" />}
                {d.note && <span className="text-muted-foreground text-xs" aria-label="tem nota">✱</span>}
              </span>
              {cell.hours && <span className="text-[11px] text-muted-foreground whitespace-nowrap">{cell.hours}</span>}
            </span>
          ) : (
            <span className="text-muted-foreground/40" aria-hidden>·</span>
          );
          return (
            <td key={d.day} className={cn("px-1 py-1 text-center align-top", marked && "bg-emerald-50/60 dark:bg-emerald-950/20")}>
              {/* A célula é um botão: clicar num dia abre o editor da semana desta pessoa. */}
              {canEdit ? (
                <button
                  type="button"
                  className="w-full min-h-7 rounded px-0.5 hover:bg-muted/60"
                  title={d.note ? `${d.note} — clicar para editar` : "Editar disponibilidade"}
                  onClick={() => onEdit(ex)}
                >
                  {content}
                </button>
              ) : (
                <span className="block min-h-7 px-0.5" title={d.note ?? undefined}>{content}</span>
              )}
            </td>
          );
        })}
      </tr>
    );
  };

  const renderMore = (key: string, remaining: number, total: number) =>
    remaining > 0 && (
      <tr>
        <td colSpan={colCount} className="py-2">
          <div className="sticky left-0 flex items-center gap-2 px-3 w-max">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => showMore(key, AVAILABILITY_PAGE_SIZE)}>
              Mostrar mais {Math.min(AVAILABILITY_PAGE_SIZE, remaining)}
            </Button>
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => showMore(key, remaining)}>
              Mostrar todos ({total})
            </Button>
          </div>
        </td>
      </tr>
    );

  return (
    <div className="space-y-3">
      {groups.length > 0 && (
        <div className="flex items-center justify-end gap-1 text-xs">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={openEverything}>Abrir tudo</Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onOpenStateChange({ ...openState, closedCities: new Set(groups.map((g) => g.key)) })}>
            Fechar tudo
          </Button>
        </div>
      )}
      {groups.map((g) => {
        const cityOpen = !closedCities.has(g.key);
        const counts = countAvailabilityStatuses(g.rows);
        const selectedInGroup = g.rows.filter((x) => selectedIds.has(x.employeeId)).length;
        const allInGroup = g.rows.length > 0 && selectedInGroup === g.rows.length;
        const sections = searching ? null : splitByStatus(g.rows);
        return (
          <section key={g.key} className="rounded-[14px] border bg-card overflow-hidden" aria-label={cityGroupLabel(g.key)}>
            <div className="flex items-center gap-2 px-3 py-2.5 bg-secondary/50 dark:bg-secondary/30">
              <TriCheckbox
                aria-label={`Selecionar todos de ${cityGroupLabel(g.key)}`}
                title="Selecionar todos desta cidade"
                checked={allInGroup}
                indeterminate={selectedInGroup > 0}
                onChange={(e) => onToggleMany(g.rows, e.target.checked)}
              />
              <button
                type="button"
                className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-left min-w-0"
                onClick={() => toggleCity(g.key)}
                aria-expanded={cityOpen}
              >
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  {cityOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                  <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
                  <span className="font-display font-semibold text-[15px] text-secondary-foreground">{cityGroupLabel(g.key)}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{g.rows.length}</span>
                </span>
                <span className="inline-flex flex-wrap items-center gap-1">
                  {(["available", "no_answer", "unavailable"] as const).filter((s) => counts[s] > 0 || s === "available").map((s) => (
                    <span key={s} className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 text-[11px] tabular-nums", STATUS_TONE[s].soft)}>
                      {statusCountLabel(s, counts[s])}
                    </span>
                  ))}
                </span>
                {selectedInGroup > 0 && (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[11px] ml-auto shrink-0">{selectedInGroup} selec.</Badge>
                )}
              </button>
            </div>
            {cityOpen && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm border-collapse">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b bg-muted">
                      <Th k="fullName" label="Extra" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} className="sticky left-0 z-[2] bg-muted pl-10" />
                      <Th k="lastWorked" label="Últ. trabalho" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />
                      <Th k="phoneE164" label="Telefone" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />
                      {dayHeaders.map((h) => {
                        const short = shortDayHeader(h.label);
                        return (
                          <th key={h.day} className="px-1 py-1.5 text-center font-medium whitespace-nowrap" title={h.label}>
                            <span className="block text-foreground">{short.weekday}</span>
                            <span className="block text-[10px] font-normal">{short.date}</span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  {/* Cidade sem ninguém disponível: dizê-lo (senão só se viam secções fechadas). */}
                  {sections && status === "all" && counts.available === 0 && (
                    <tbody>
                      <tr className="border-b">
                        <td colSpan={colCount} className="py-2">
                          <span className="sticky left-0 block w-max px-3 text-xs text-muted-foreground">Ninguém disponível nesta cidade nesta semana (ainda).</span>
                        </td>
                      </tr>
                    </tbody>
                  )}
                  {sections ? (
                    sections.map((sec) => {
                      const key = sectionKey(g.key, sec.status);
                      const open = isSectionOpen(g.key, sec.status);
                      const { visible, remaining } = visibleSlice(sec.rows, shownPer[key] ?? AVAILABILITY_PAGE_SIZE);
                      const selectedInSec = sec.rows.filter((x) => selectedIds.has(x.employeeId)).length;
                      return (
                        <tbody key={sec.status}>
                          <tr className="border-b bg-muted/20">
                            <td colSpan={colCount} className="py-0">
                              <div className="sticky left-0 flex items-center gap-2 px-3 py-1.5 w-max max-w-full">
                                <TriCheckbox
                                  aria-label={`Selecionar todos: ${AVAILABILITY_STATUS_LABELS[sec.status]} de ${cityGroupLabel(g.key)}`}
                                  title="Selecionar todos desta secção (ex.: lembrar só quem não respondeu)"
                                  checked={selectedInSec === sec.rows.length}
                                  indeterminate={selectedInSec > 0}
                                  onChange={(e) => onToggleMany(sec.rows, e.target.checked)}
                                />
                                <button
                                  type="button"
                                  className="flex items-center gap-1.5 text-left"
                                  onClick={() => toggleSection(g.key, sec.status)}
                                  aria-expanded={open}
                                >
                                  {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                                  <span className={cn("h-2 w-2 rounded-full shrink-0", STATUS_TONE[sec.status].dot)} aria-hidden />
                                  <span className={cn("text-xs font-semibold uppercase tracking-wide", STATUS_TONE[sec.status].text)}>
                                    {statusSectionTitle(sec.status, sec.rows.length)}
                                  </span>
                                  <span className="text-[11px] text-muted-foreground hidden sm:inline">
                                    — {STATUS_SECTION_HINTS[sec.status]}{open ? "" : " (carrega para ver)"}
                                  </span>
                                </button>
                                {selectedInSec > 0 && <span className="text-[11px] text-primary font-medium">{selectedInSec} selec.</span>}
                              </div>
                            </td>
                          </tr>
                          {open && visible.map((ex) => renderRow(ex, false))}
                          {open && renderMore(key, remaining, sec.rows.length)}
                          {/* Totais por dia de quem está disponível nesta cidade. */}
                          {open && sec.status === "available" && (
                            <tr className="border-t-2 font-medium bg-emerald-50/40 dark:bg-emerald-950/10">
                              <td className="sticky left-0 z-[1] bg-card py-1.5 pl-10 pr-2 text-xs shadow-[1px_0_0_var(--border)]">Total por turno</td>
                              <td />
                              <td />
                              {perDayShiftTotals(dayKeys, sec.rows).map((p) => (
                                <td key={p.day} className="px-1 text-center text-xs whitespace-nowrap">
                                  <span className="text-amber-700 dark:text-amber-400">{p.morning}</span>
                                  {" / "}
                                  <span className="text-indigo-600 dark:text-indigo-400">{p.night}</span>
                                </td>
                              ))}
                            </tr>
                          )}
                        </tbody>
                      );
                    })
                  ) : (
                    // A pesquisar: lista única por relevância, com o estado em cada linha.
                    <tbody>
                      {(() => {
                        const key = searchListKey(g.key);
                        const { visible, remaining } = visibleSlice(g.rows, shownPer[key] ?? AVAILABILITY_PAGE_SIZE);
                        return (
                          <>
                            {visible.map((ex) => renderRow(ex, true))}
                            {renderMore(key, remaining, g.rows.length)}
                          </>
                        );
                      })()}
                    </tbody>
                  )}
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
