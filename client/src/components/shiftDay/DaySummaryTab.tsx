/**
 * Atividade diária → "Resumo do dia" (supervisão). Até 12 out 2026 era um
 * separador da Passagem de turno; o Jorge pediu-o na Atividade diária (e saiu
 * de lá). Tudo o que o #361 lhe deu fica igual: "Quem trabalhou" clicável
 * (nome → ficha; linha → o dia da pessoa), velocidade e excessos, parado
 * limitado ao turno (peopleShiftGps), entregas lentas com o contexto e as
 * passagens por chefe de turno. Mesma permissão: "Passagem — Resumo do dia"
 * (o servidor exige-a em cada leitura: shiftHandover.supervisorDashboard &c.).
 * 12 out 2026: + reclamações dos carros que saíram nesse dia.
 * 15 out 2026: os tempos de entrega (Fila, Trânsito, Nosso e a meta, Cliente,
 * Total) e de recolha (no terminal, no P2, cliente, até arrumado, T2), da
 * tabela dos tempos ou ao vivo (components/shiftDay/DayTimesSection.tsx). Os
 * cartões "Pendente→Entrega", ">15/>30" e "Recolhas atrasadas" (pela hora
 * marcada) saíram: a hora marcada já não entra nos tempos.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { UniDateNav } from "@/components/DateRangeNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Clock, Gauge, Route } from "lucide-react";
import { useTableSort, Th } from "@/components/SortableTable";
import { fmtPTDate, fmtPTTime } from "@/lib/lisbonTime";
import { retryTransient } from "@/lib/queryRetry";
import { useOpenEmployee } from "@/hooks/useOpenEmployee";
import { DriverDaySheet, HandoverShiftCard, SlowDeliveryDialog, type ComplianceDayRow, type DriverRow, type SlowDelivery } from "@/components/shiftDay/ShiftDayReview";
import { CitySelect, useHandoverCity, type CityState } from "@/components/shiftDay/handoverCity";
import type { TeamLine } from "@shared/shiftDayReview";
import { findPersonShift, operationalShift } from "@shared/shiftHandover";
import { fmtHours, stoppedForDisplay, workedHours } from "@shared/dayWorkSummary";
import { DEPARTED_COMPLAINTS_HINT } from "@shared/departedComplaints";
import { TerminalDayCard } from "@/components/terminal/TerminalDayCard";
import { DayTimesSection, type DayTimes } from "@/components/shiftDay/DayTimesSection";
import type { SlowDeliveryItem } from "../../../../server/serviceTimesAgg";

/** O separador: escolhe a cidade (as do centro de custos) e mostra o resumo. */
export default function DaySummaryTab() {
  const cityState = useHandoverCity();
  if (cityState.loading) return <p className="text-sm text-muted-foreground mt-4">A carregar…</p>;
  if (cityState.error) return <div className="mt-4"><QueryErrorNote error={cityState.error} onRetry={cityState.retry} retrying={cityState.retrying} what="as tuas cidades" /></div>;
  if (!cityState.city) {
    return <Card className="mt-4"><CardContent className="p-8 text-center text-muted-foreground">Sem cidade atribuída — pede a um administrador para associar o teu centro de custos.</CardContent></Card>;
  }
  return <div className="mt-4"><SupervisorDashboard cityState={cityState as CityState} /></div>;
}

// ─── RESUMO DO DIA (supervisor+) ────────────────────────────────────────────
// 12 out 2026 (Jorge): "Quem trabalhou" clicável (nome → ficha; linha → o dia
// da pessoa), velocidade e excessos, parado limitado ao turno, entregas lentas
// com o que havia no mesmo horário e a passagem por chefe de turno (equipa).
function SupervisorDashboard({ cityState }: { cityState: CityState }) {
  const { city, allowed, setCity } = cityState;
  // Dia operacional (03:00 → 03:00): de madrugada ainda é o dia anterior.
  const [date, setDate] = useState(() => operationalShift().date);
  const dashQ = trpc.shiftHandover.supervisorDashboard.useQuery({ date, city });
  const data = dashQ.data;
  const openEmployee = useOpenEmployee();
  // Parado no TURNO (picagens; sem elas, a escala): lido à parte (os pontos do Zello), não atrasa o resumo.
  const employeeIds = useMemo(() => Array.from(new Set(((data?.people ?? []) as any[]).map((p) => p.employeeId).filter((x): x is number => typeof x === "number"))).sort((a, b) => a - b), [data]);
  const gpsQ = trpc.shiftHandover.peopleShiftGps.useQuery({ date, city, employeeIds }, { enabled: !!data && employeeIds.length > 0, refetchOnWindowFocus: false, staleTime: 5 * 60_000, retry: retryTransient });
  // 44b: horas trabalhadas (ponto; sem ele, Zello ligado) e tempo parado (Zello ligado sem andar).
  const people = useMemo(() => ((data?.people ?? []) as any[]).map((p) => {
    const w = workedHours(p);
    const shift = p.employeeId != null ? (gpsQ.data?.people as Record<number, any> | undefined)?.[p.employeeId] : undefined;
    const st = stoppedForDisplay(p, shift);
    return { ...p, workedH: w.hours, workedSrc: w.source, stoppedH: st.hours, stoppedSrc: st.source, stoppedPartial: !!shift?.partial };
  }), [data, gpsQ.data]);
  const peopleSort = useTableSort(people);
  const complianceQ = trpc.shiftHandover.compliance.useQuery({ date, city });
  const [driver, setDriver] = useState<DriverRow | null>(null);
  const [slow, setSlow] = useState<SlowDelivery | null>(null);
  const gpsPending = employeeIds.length > 0 && gpsQ.isLoading;

  // Pelo id do funcionário; só sem id se cai no nome (e na cidade).
  const shiftOf = (employeeId: number | null, name: string) => {
    const a = findPersonShift((data?.shifts ?? []) as any[], { employeeId, name }, city);
    return a ? (a.shift === "morning" ? "☀️" : "🌙") : "";
  };
  // Cartões novos: os mesmos números da tabela (Atividade diária para km/velocidade; o parado do turno).
  const speeders = people.filter((p) => (p.violations ?? 0) > 0).length;
  const maxSpeedOfDay = people.reduce((m, p) => Math.max(m, Number(p.maxSpeed ?? 0)), 0);
  // Horas paradas: das pessoas (um PDA sem login esquecido ligado não é ninguém parado).
  const withStopped = people.filter((p) => p.kind !== "sem_login" && p.stoppedH != null);
  const stoppedWholeDay = withStopped.filter((p) => p.stoppedSrc === "dia").length;
  const stoppedTotal = Math.round(withStopped.reduce((s, p) => s + Number(p.stoppedH), 0) * 10) / 10;

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2 flex-wrap">
        <div><Label className="text-xs mb-1 block">Dia</Label><UniDateNav date={date} onChange={setDate} /></div>
        <div><Label className="text-xs mb-1 block">Cidade</Label><CitySelect city={city} allowed={allowed} onChange={setCity} /></div>
        <p className="text-[11px] text-muted-foreground pb-2">Dia operacional: 03:00 → 03:00 do dia seguinte (inclui o turno da noite)</p>
      </div>
      {dashQ.isLoading ? <p className="text-sm text-muted-foreground">A carregar…</p> : dashQ.isError ? (
        <QueryErrorNote error={dashQ.error} onRetry={() => dashQ.refetch()} retrying={dashQ.isFetching} what="o resumo do dia" />
      ) : !data ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Base de dados indisponível — sem resumo do dia.</CardContent></Card>
      ) : (
        <>
          {data.timingsTruncated && (
            <p className="text-xs text-amber-700">Dia com movimentos a mais para ler de uma vez: as reclamações dos carros que saíram são só de uma parte do dia.</p>
          )}
          {/* KPIs do dia */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Card className="p-3 gap-0.5"><p className="text-xs text-muted-foreground">Recolhas</p><p className="text-xl font-bold text-emerald-700">{data.totals.checkins}</p></Card>
            <Card className="p-3 gap-0.5"><p className="text-xs text-muted-foreground">Entregas</p><p className="text-xl font-bold text-blue-700">{data.totals.checkouts}</p></Card>
            <Card className={`p-3 gap-0.5 ${data.complaintsToday > 0 ? "border-amber-300 bg-amber-50/50" : ""}`} title="Reclamações que chegaram (foram criadas) neste dia operacional, das 03h às 03h do dia seguinte — sem as arquivadas nem as convertidas, como os contadores das Reclamações">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Reclamações do dia</p>
              <p className="text-xl font-bold">{data.complaintsToday}</p>
              <p className="text-[11px] text-muted-foreground">dia operacional 03h–03h</p>
            </Card>
            <DepartedComplaintsCard value={data.complaintsDeparted} />
            <Card className="p-3 gap-0.5" title="Os km do GPS da Atividade diária (dia civil, PDAs partilhados partidos por quem os tinha)">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Route className="w-3 h-3" />Km da equipa</p>
              <p className="text-xl font-bold text-purple-700 tabular-nums">{Number(data.totals.totalKm).toLocaleString("pt-PT", { maximumFractionDigits: 1 })} km</p>
              <p className="text-[11px] text-muted-foreground">{(data.gpsMissingDays ?? []).includes(date) ? "provisório (GPS por recolher)" : `${people.filter((p) => (p.totalKm ?? 0) > 0).length} pessoas com GPS`}</p>
            </Card>
            <Card className={`p-3 gap-0.5 ${speeders > 0 ? "border-red-300 bg-red-50/50" : ""}`}>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Gauge className="w-3 h-3" />Excesso de velocidade</p>
              <p className={`text-xl font-bold tabular-nums ${speeders > 0 ? "text-red-700" : ""}`}>{speeders} {speeders === 1 ? "pessoa" : "pessoas"}</p>
              <p className="text-[11px] text-muted-foreground">máx. do dia {maxSpeedOfDay > 0 ? `${Math.round(maxSpeedOfDay)} km/h` : "—"} · {data.totals.violations} excessos</p>
            </Card>
            <Card className="p-3 gap-0.5" title="Com o Zello ligado mas sem andar, dentro do turno de cada pessoa (picagens; sem elas, a escala)">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />Horas paradas</p>
              <p className="text-xl font-bold tabular-nums">{gpsPending ? "…" : withStopped.length ? fmtHours(stoppedTotal) : "—"}</p>
              <p className="text-[11px] text-muted-foreground">{gpsPending ? "a ler o GPS do turno…" : withStopped.length ? `média ${fmtHours(Math.round((stoppedTotal / withStopped.length) * 10) / 10)} por pessoa${stoppedWholeDay ? ` · ${stoppedWholeDay} sem turno (~)` : ""}` : "sem GPS"}</p>
            </Card>
          </div>

          {/* Cumprimento das passagens de turno + equipa de cada chefe de turno */}
          {complianceQ.isError
            ? <QueryErrorNote error={complianceQ.error} onRetry={() => complianceQ.refetch()} retrying={complianceQ.isFetching} what="o cumprimento das passagens" />
            : <HandoverCompliance data={complianceQ.data} loading={complianceQ.isLoading} teams={(data.teams ?? []) as TeamLine[]} teamsHidden={data.teamsHidden} targetMinutes={data.times.targetMinutes} />}

          {/* Plano 56 B2: linha do tempo do terminal da cidade (só com PONTO_TERMINAL ligado) */}
          <TerminalDayCard date={date} city={city} />

          {/* 15 out 2026: tempos de entrega e de recolha (as mais lentas abrem o que se passava nesse horário) */}
          <DayTimesSection t={data.times as DayTimes} driverNames={data.driverNames ?? {}} onOpenSlow={(x) => setSlow(toSlow(x, data.driverNames ?? {}))} />

          {/* Condutores do dia */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Quem trabalhou — {fmtPTDate(date)}</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                Clica no <b>nome</b> para abrir a ficha; no resto da linha para ver o dia dessa pessoa (cada recolha e entrega, com a reserva e a velocidade).
                Horas = as do ponto (com "~" quando não há picagens e é o tempo com o Zello ligado). Km, Vel. máx. e Excessos = os da Atividade diária.
                Parado = com o Zello ligado mas sem andar, dentro do turno (picagens; sem elas, a escala); "~" = sem turno, o dia inteiro.
              </p>
              {gpsQ.isError && (
                <QueryErrorNote error={gpsQ.error} onRetry={() => gpsQ.refetch()} retrying={gpsQ.isFetching} what={`o GPS do turno (o "Parado" fica o do dia inteiro, com ~)`} />
              )}
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <Th k="name" label="Pessoa" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <th className="p-2">Turno</th>
                      <Th k="checkins" label="Recolhas" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="checkouts" label="Entregas" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="movements" label="Movs" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="totalActions" label="Total" align="right" className="font-bold" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="workedH" label="Horas" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="totalKm" label="Km" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="maxSpeed" label="Vel. máx." align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="violations" label="Excessos" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="stoppedH" label="Parado" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                    </tr>
                  </thead>
                  <tbody>
                    {(peopleSort.sorted as any[]).map((p) => {
                      const open = () => setDriver(p as DriverRow);
                      return (
                        <tr key={p.key} className="border-b hover:bg-muted/40 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={open} tabIndex={0} aria-label={`Ver o dia de ${p.name}`} onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
                          <td className="p-2 font-medium min-w-[9rem]">
                            {p.kind === "parceiro" ? "🤝 " : p.kind === "por_ligar" ? "⚠ " : ""}
                            {p.employeeId != null ? (
                              <button type="button" className="font-medium text-primary hover:underline text-left" title="Abrir a ficha no RH"
                                onClick={(e) => { e.stopPropagation(); openEmployee(p.employeeId); }}>{p.name}</button>
                            ) : p.name}
                            {p.isTeamLeader && <Badge className="ml-1 bg-amber-100 text-amber-800 border-amber-300 text-[11px] px-1.5 py-0">TL</Badge>}
                          </td>
                          <td className="p-2">{shiftOf(p.employeeId, p.name)}</td>
                          <td className="p-2 text-right text-emerald-700 tabular-nums">{p.checkins || ""}</td>
                          <td className="p-2 text-right text-blue-700 tabular-nums">{p.checkouts || ""}</td>
                          <td className="p-2 text-right tabular-nums">{p.movements || ""}</td>
                          <td className="p-2 text-right font-bold tabular-nums">{p.totalActions || ""}</td>
                          <td className="p-2 text-right tabular-nums" title={p.workedSrc === "zello" ? "Sem picagens: tempo com o Zello ligado" : p.workedSrc === "ponto" ? "Horas do ponto" : undefined}>
                            {fmtHours(p.workedH)}{p.workedSrc === "zello" ? <span className="text-muted-foreground"> ~</span> : null}
                          </td>
                          <td className="p-2 text-right tabular-nums">
                            {p.totalKm > 0 ? `${p.totalKm} km` : "—"}
                            {p.provisionalKm && <span className="block text-[11px] text-amber-700">provisório</span>}
                          </td>
                          <td className="p-2 text-right tabular-nums">{p.maxSpeed != null && p.maxSpeed > 0 ? `${Math.round(p.maxSpeed)} km/h` : "—"}</td>
                          <td className={`p-2 text-right tabular-nums ${p.violations > 0 ? "text-red-700 font-semibold" : "text-muted-foreground"}`} title={p.violations > 0 ? "Excessos de velocidade do dia (GPS)" : "Sem excessos"}>{p.violations > 0 ? p.violations : "não"}</td>
                          <td className="p-2 text-right tabular-nums" title={p.stoppedSrc === "dia" ? "Sem turno (nem picagens nem escala) ou sem GPS do turno: o dia inteiro" : p.stoppedSrc ? `Com o Zello ligado mas sem andar, dentro do turno (${p.stoppedSrc === "ponto" ? "picagens" : "escala"})` : undefined}>
                            {gpsPending && p.employeeId != null ? <span className="text-muted-foreground">…</span> : (
                              <>{fmtHours(p.stoppedH)}{p.stoppedSrc === "dia" ? <span className="text-muted-foreground"> ~</span> : null}{p.stoppedPartial ? <span className="text-amber-700" title="GPS incompleto"> *</span> : null}</>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
          {driver && (
            <DriverDaySheet date={date} city={city} person={driver} onClose={() => setDriver(null)}
              onOpenEmployee={(id) => { setDriver(null); openEmployee(id); }} />
          )}
          {slow && <SlowDeliveryDialog date={date} city={city} item={slow} onClose={() => setSlow(null)} />}
        </>
      )}
    </div>
  );
}

/** Uma entrega das mais lentas → o diálogo "o que se passava nesse horário" (do pendente à entrega). */
function toSlow(x: SlowDeliveryItem, names: Record<number, string>): SlowDelivery {
  const mins = x.pendingAt && x.deliveredAt ? Math.floor((Date.parse(`${x.deliveredAt.replace(" ", "T")}Z`) - Date.parse(`${x.pendingAt.replace(" ", "T")}Z`)) / 60_000) : 0;
  return {
    booking: x.bookingId, mins, agent: x.driverEmployeeId != null ? names[x.driverEmployeeId] ?? null : null,
    pendingAt: x.pendingAt ?? "", deliveredAt: x.deliveredAt ?? "", bookingCode: x.bookingCode, plate: null, parkName: null, city: null,
  };
}

// ─── Cumprimento das passagens (Resumo do dia) ──────────────────────────────
// 12 out 2026: cada turno diz se houve passagem (a que horas e por quem) e,
// por chefe de turno, o que a equipa dele fez a tempo e atrasado.
function HandoverCompliance({ data, loading, teams, teamsHidden, targetMinutes }: {
  data: { day: ComplianceDayRow[]; percent30: number | null; expected30: number } | undefined;
  loading: boolean;
  teams: TeamLine[];
  teamsHidden: string | null;
  targetMinutes: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm">Passagens de turno</CardTitle>
          {data?.percent30 != null && (
            <Badge variant="outline" className={data.percent30 >= 90 ? "border-emerald-300 text-emerald-700" : data.percent30 >= 70 ? "border-amber-300 text-amber-700" : "border-red-300 text-red-700"}>
              {data.percent30}% a tempo nos últimos 30 dias ({data.expected30} turnos)
            </Badge>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">Equipa = o turno do chefe de turno na escala (mesmo dia, cidade e turno), como no Desempenho. Entregas: de quem pegou no carro, dentro ou fora da meta pelo nosso tempo (Fila + Trânsito, {targetMinutes} min). Recolhas: de quem tirou o carro do terminal; só no T2 há atrasadas. A hora marcada não entra.{teamsHidden ? ` Dentro/fora da meta: ${teamsHidden}.` : ""}</p>
      </CardHeader>
      <CardContent>
        {loading ? <p className="text-sm text-muted-foreground">A carregar…</p> : !data?.day.length ? (
          <p className="text-sm text-muted-foreground">Sem turnos escalados nem passagens neste dia.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.day.map((r) => (
              <HandoverShiftCard key={`${r.shift}-${r.city}`} row={r} teams={teams.filter((t) => t.shift === r.shift && t.city === r.city)} targetMinutes={targetMinutes} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 12 out 2026 (Jorge): reclamações dos carros que SAÍRAM neste dia (entrega
 * feita no dia operacional), seja qual for o dia em que a reclamação chegou.
 * Só o número (a página de Reclamações não tem este filtro). Erro ≠ zero.
 */
export function DepartedComplaintsCard({ value, loading }: {
  value: { available: true; complaints: number; bookings: number; truncated: boolean } | { available: false; reason: string } | undefined | null;
  loading?: boolean;
}) {
  const ok = value && value.available ? value : null;
  const hint = `${DEPARTED_COMPLAINTS_HINT}${ok ? ` ${ok.bookings} ${ok.bookings === 1 ? "carro saiu" : "carros saíram"}.` : ""}${ok?.truncated ? " Dia com movimentos a mais para ler de uma vez: o número pode estar abaixo do real." : ""}`;
  return (
    <Card className={`p-3 gap-0.5 min-w-0 ${ok && ok.complaints > 0 ? "border-amber-300 bg-amber-50/50" : ""}`} title={value && !value.available ? `${DEPARTED_COMPLAINTS_HINT} ${value.reason}` : hint}>
      <p className="text-xs text-muted-foreground flex items-center gap-1"><AlertTriangle className="w-3 h-3 shrink-0" /><span className="truncate">Reclamações (carros que saíram)</span></p>
      <p className="text-xl font-bold tabular-nums">{loading ? "…" : ok ? ok.complaints : "—"}{ok?.truncated ? <span className="text-sm text-amber-700"> *</span> : null}</p>
      <p className="text-[11px] text-muted-foreground leading-snug truncate">
        {loading ? "a contar…" : ok ? `de ${ok.bookings} ${ok.bookings === 1 ? "saída" : "saídas"}` : value && !value.available ? <span className="text-amber-700">sem número: {value.reason}</span> : ""}
      </p>
    </Card>
  );
}
