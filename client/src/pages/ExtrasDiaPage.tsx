import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Fragment, useState, useMemo } from "react";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Droplets,
  Users,
  Euro,
  Clock,
  CalendarDays,
  Plus,
  Home,
  Trash2,
  ChevronRight,
  ChevronDown,
  Send,
  Mail,
  CheckCircle2,
  Sun,
  Moon,
  MessageCircle,
  XCircle,
  AlertTriangle,
  MapPin,
} from "lucide-react";
import {
  CITY_KEYS,
  CITY_LABELS,
  CITY_SOURCE_LABELS,
  type CityKey,
} from "@shared/city";
import {
  AVAILABILITY_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_LANGUAGE,
} from "@shared/whatsappTemplate";

// Defaults para o preview do UI — devem coincidir com a tabela `extra_rates`
// na BD (migration 0044). O custo real é sempre calculado no backend a partir
// de `extra_rates`; estes valores só servem para mostrar previsões enquanto
// o admin compõe a escala.
const LEVELS = [
  { id: "junior", label: "Júnior", hourlyRate: 4.5 },
  { id: "senior", label: "Sénior", hourlyRate: 5 },
  { id: "terminal", label: "Terminal", hourlyRate: 5.5 },
  { id: "master", label: "Master", hourlyRate: 6 },
] as const;
type LevelId = (typeof LEVELS)[number]["id"];

/** Devolve os 4 níveis de extras-dia com taxas vivas da BD (fallback aos
 *  defaults se o endpoint ainda não respondeu). */
function useLiveLevels() {
  const { data: rates = [] } = trpc.rh.extraRates.list.useQuery();
  return useMemo(() => {
    const byName = new Map<string, number>();
    for (const r of rates as any[]) {
      if (r.levelName) byName.set(String(r.levelName), parseFloat(String(r.hourlyRate)));
    }
    return LEVELS.map(l => ({
      ...l,
      hourlyRate: byName.get(l.id) ?? l.hourlyRate,
    }));
  }, [rates]);
}

// 0-26 cobre 00:00 do dia alvo até 02:00 do dia seguinte (último slot da noite).
const HOURS_24 = Array.from({ length: 27 }, (_, i) => i);
// 1-27 para fim do turno (27 = 03:00 do dia seguinte).
const HOURS_25 = Array.from({ length: 28 }, (_, i) => i);

type ShiftId = "morning" | "night";

const SHIFTS: { id: ShiftId; label: string; defaultStart: number; defaultEnd: number }[] = [
  { id: "morning", label: "Manhã (03–15)", defaultStart: 3, defaultEnd: 15 },
  { id: "night", label: "Noite (15–03+1)", defaultStart: 15, defaultEnd: 27 },
];

const fmtEur = (n: number) =>
  n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
const fmtHour = (h: number) => {
  if (h < 24) return `${String(h).padStart(2, "0")}h`;
  return `${String(h - 24).padStart(2, "0")}h+1`;
};
const fmtDate = (s: string) => {
  const d = new Date(s + "T00:00:00");
  return d.toLocaleDateString("pt-PT", { weekday: "long", day: "2-digit", month: "long" });
};

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function ExtrasDiaPage() {
  const [baseDate, setBaseDate] = useState(todayISO());

  const { data, isLoading, error } = trpc.extrasDia.forecast.useQuery({ baseDate });
  const targetDate = data?.targetDate ?? "";
  const assignmentsQ = trpc.extrasDia.assignments.useQuery(
    { date: targetDate },
    { enabled: !!targetDate },
  );
  const assignments = assignmentsQ.data ?? [];

  const actuals = useMemo(() => {
    const cost = assignments.reduce((s, a) => s + a.cost, 0);
    const hours = assignments.reduce((s, a) => s + a.hoursBilled, 0);
    return { cost, hours, count: assignments.length };
  }, [assignments]);

  const peakHour = useMemo(() => {
    if (!data) return null;
    let max = 0;
    let hour = -1;
    for (const row of data.hourly) {
      const total = row.checkins + row.checkouts;
      if (total > max) {
        max = total;
        hour = row.hour;
      }
    }
    return hour >= 0 ? { hour, total: max } : null;
  }, [data]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarDays className="h-6 w-6 text-blue-600" />
            Extras Dia — Previsão Lisboa
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Planeamento de chegadas, saídas, lavagens e condutores para o dia seguinte.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="baseDate" className="text-xs">Data base</Label>
          <Input
            id="baseDate"
            type="date"
            value={baseDate}
            onChange={(e) => setBaseDate(e.target.value)}
            className="w-44"
          />
        </div>
      </div>

      {isLoading && (
        <div className="text-sm text-muted-foreground">A carregar previsão...</div>
      )}
      {error && (
        <div className="text-sm text-red-600">Erro: {error.message}</div>
      )}

      {data && (
        <>
          <div className="text-sm text-muted-foreground">
            A mostrar previsão para <strong>{fmtDate(data.targetDate)}</strong>
            {peakHour && (
              <span className="ml-2">
                · Hora de pico: <strong>{fmtHour(peakHour.hour)}</strong> ({peakHour.total} operações)
              </span>
            )}
            <span className="ml-2">
              · Parques: <strong>{data.parksQueried.length}</strong>
            </span>
          </div>

          {data.parksFailed.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3 text-xs">
              <div className="font-medium mb-1">Avisos ({data.parksFailed.length})</div>
              <ul className="space-y-0.5 text-amber-900">
                {data.parksFailed.slice(0, 5).map((f, i) => (
                  <li key={i}>
                    <span className="font-mono">{f.park}</span>: {f.error}
                  </li>
                ))}
                {data.parksFailed.length > 5 && (
                  <li>... e mais {data.parksFailed.length - 5}</li>
                )}
              </ul>
            </div>
          )}

          {data.parksQueried.length === 0 && (
            <div className="rounded-md border border-red-300 bg-red-50/60 p-3 text-sm">
              Nenhuma chave de API Lisboa configurada. Define{" "}
              <code className="font-mono">MULTIPARK_API_KEY_LISBON_*</code> nas env vars.
            </div>
          )}


          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              icon={<ArrowDownToLine className="h-4 w-4 text-emerald-600" />}
              label="Recolhas"
              value={data.totals.checkins}
              breakdown={data.spotTypeByDirection?.checkin}
            />
            <KpiCard
              icon={<ArrowUpFromLine className="h-4 w-4 text-orange-600" />}
              label="Entregas"
              value={data.totals.checkouts}
              breakdown={data.spotTypeByDirection?.checkout}
            />
            <KpiCard
              icon={<Users className="h-4 w-4 text-blue-600" />}
              label={actuals.count > 0 ? "Pessoas escaladas" : "Condutores (pico)"}
              value={actuals.count > 0 ? actuals.count : data.allocation.cheapest.peakDrivers}
              hint={
                actuals.count > 0
                  ? `${actuals.hours}h pagas · pico previsto ${data.allocation.cheapest.peakDrivers}`
                  : `${data.allocation.cheapest.totalDriverHours}h totais`
              }
            />
            <KpiCard
              icon={<Euro className="h-4 w-4 text-purple-600" />}
              label={actuals.count > 0 ? "Custo real" : "Estimativa (Júnior)"}
              value={fmtEur(actuals.count > 0 ? actuals.cost : data.allocation.cheapest.totalCost)}
              hint={
                actuals.count > 0
                  ? `Estimativa: ${fmtEur(data.allocation.cheapest.totalCost)}`
                  : undefined
              }
            />
          </div>

          {/* Hourly table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Por hora — {fmtDate(data.targetDate)}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Clica numa hora para ver os blocos de 20min. Clica num bloco para ver as reservas.
                <span className="inline-block w-3 h-3 rounded-sm bg-yellow-100 border border-yellow-300 align-text-bottom mx-1"></span>
                hora com Terminal 2 (30min/reserva) ·
                <span className="inline-block w-3 h-3 rounded-sm bg-red-100 border border-red-300 align-text-bottom mx-1"></span>
                hora com Outro (60min/reserva — Partidas, Oriente, Rossio, etc.)
              </p>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs uppercase text-muted-foreground">
                      <th className="text-left py-2 px-2 w-6"></th>
                      <th className="text-left py-2 px-2">Hora</th>
                      <th className="text-right py-2 px-2">Chegadas</th>
                      <th className="text-right py-2 px-2">Saídas</th>
                      <th className="text-right py-2 px-2">Total</th>
                      <th className="text-right py-2 px-2">Condutores</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.hourly
                      .filter(h => h.checkins + h.checkouts > 0)
                      .map(row => (
                        <HourRow
                          key={row.hour}
                          row={row}
                          targetDate={data.targetDate}
                          isPeak={peakHour?.hour === row.hour}
                        />
                      ))}
                    {data.hourly.every(h => h.checkins + h.checkouts === 0) && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-muted-foreground">
                          Sem operações previstas neste dia.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Lavagens */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Droplets className="h-4 w-4 text-cyan-600" />
                Lavagens
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <WashTile
                  title="Saídas hoje com lavagem"
                  date={data.washes.base.date}
                  count={data.washes.base.exitsWithWash}
                />
                <WashTile
                  title="Saídas amanhã com lavagem"
                  date={data.washes.target.date}
                  count={data.washes.target.exitsWithWash}
                  highlight
                />
                <WashTile
                  title="Saídas depois de amanhã"
                  date={data.washes.next.date}
                  count={data.washes.next.exitsWithWash}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Lavagens não consomem condutores. Os carros listados em "amanhã" / "depois de
                amanhã" precisam de ser lavados antes da entrega.
              </p>
            </CardContent>
          </Card>

          {/* Equipa do dia (real) — vem antes da estimativa */}
          {SHIFTS.map(s => (
            <TeamSection
              key={s.id}
              targetDate={data.targetDate}
              shift={s.id}
              shiftLabel={s.label}
              defaultStart={s.defaultStart}
              defaultEnd={s.defaultEnd}
            />
          ))}

          {/* Estimativa de referência — vazia/colapsa quando há atribuições */}
          {(() => {
            const remainingSuggested = data.allocation.cheapest.shifts.slice(actuals.count);
            const remainingHours = remainingSuggested.reduce((s, x) => s + x.hours, 0);
            const remainingCost = remainingSuggested.reduce((s, x) => s + x.cost, 0);
            const allCovered = data.allocation.cheapest.shifts.length > 0 && actuals.count >= data.allocation.cheapest.shifts.length;

            return (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Estimativa de referência (3 carros/hora · turnos 3–12h)
                  </CardTitle>
                  {actuals.count > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {allCovered
                        ? "Todos os slots previstos já estão cobertos pela equipa acima."
                        : `${actuals.count} de ${data.allocation.cheapest.shifts.length} slots previstos cobertos pela equipa. Restam ${remainingSuggested.length} por escalar.`}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  {data.allocation.cheapest.shifts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Sem turnos necessários previstos.</p>
                  ) : (
                    <div>
                      <h3 className="font-medium text-sm mb-2">
                        {actuals.count > 0 ? "Slots ainda por cobrir" : "Turnos propostos (Júnior — mais barato)"}
                      </h3>
                      {remainingSuggested.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Sem slots por cobrir.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b text-xs uppercase text-muted-foreground">
                                <th className="text-left py-2 px-2">#</th>
                                <th className="text-left py-2 px-2">Tipo</th>
                                <th className="text-right py-2 px-2">Início</th>
                                <th className="text-right py-2 px-2">Fim</th>
                                <th className="text-right py-2 px-2">Horas</th>
                                <th className="text-right py-2 px-2">€/h</th>
                                <th className="text-right py-2 px-2">Custo</th>
                              </tr>
                            </thead>
                            <tbody>
                              {remainingSuggested.map((s, i) => (
                                <tr key={i} className="border-b text-muted-foreground">
                                  <td className="py-1.5 px-2">{actuals.count + i + 1}</td>
                                  <td className="py-1.5 px-2">{s.label}</td>
                                  <td className="py-1.5 px-2 text-right font-mono">{fmtHour(s.startHour)}</td>
                                  <td className="py-1.5 px-2 text-right font-mono">{fmtHour(s.endHour)}</td>
                                  <td className="py-1.5 px-2 text-right">{s.hours}h</td>
                                  <td className="py-1.5 px-2 text-right">{fmtEur(s.hourlyRate)}</td>
                                  <td className="py-1.5 px-2 text-right">{fmtEur(s.cost)}</td>
                                </tr>
                              ))}
                              <tr className="font-semibold bg-muted/40">
                                <td colSpan={4} className="py-2 px-2 text-right">Em falta</td>
                                <td className="py-2 px-2 text-right">{remainingHours}h</td>
                                <td></td>
                                <td className="py-2 px-2 text-right">{fmtEur(remainingCost)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <h3 className="font-medium text-sm mb-2">Estimativa por nível (referência)</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {data.allocation.bySingleLevel.map(l => (
                        <div
                          key={l.level}
                          className="border rounded-md p-3 bg-card"
                        >
                          <div className="text-xs text-muted-foreground">{l.label}</div>
                          <div className="text-lg font-semibold">{fmtEur(l.totalCost)}</div>
                          <div className="text-xs text-muted-foreground">{l.totalHours}h totais</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })()}
        </>
      )}
    </div>
  );
}

// ─── Equipa do dia (atribuições) ───────────────────────────────────────────────

function TeamSection({
  targetDate,
  shift,
  shiftLabel,
  defaultStart,
  defaultEnd,
}: {
  targetDate: string;
  shift: ShiftId;
  shiftLabel: string;
  defaultStart: number;
  defaultEnd: number;
}) {
  const utils = trpc.useUtils();
  const assignmentsQuery = trpc.extrasDia.assignments.useQuery({ date: targetDate });
  const candidatesQuery = trpc.extrasDia.candidates.useQuery({ date: targetDate });

  const upsert = trpc.extrasDia.upsertAssignment.useMutation({
    onSuccess: () => {
      utils.extrasDia.assignments.invalidate({ date: targetDate });
      toast.success("Turno guardado");
    },
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.extrasDia.deleteAssignment.useMutation({
    onSuccess: () => {
      utils.extrasDia.assignments.invalidate({ date: targetDate });
      toast.success("Turno removido");
    },
    onError: (e) => toast.error(e.message),
  });

  const allAssignments = assignmentsQuery.data ?? [];
  const allCandidates = candidatesQuery.data ?? [];
  // Mostra TODOS os extras ativos para podermos tentar/insistir com mais gente:
  // disponíveis primeiro, depois sem-resposta, depois quem disse que não pode.
  const candidates = useMemo(() => {
    const rank = (s?: string | null) => (s === "available" ? 0 : s === "no_response" ? 1 : 2);
    return allCandidates
      .slice()
      .sort((a, b) => {
        const r = rank(a.availability?.status) - rank(b.availability?.status);
        return r !== 0 ? r : a.fullName.localeCompare(b.fullName);
      });
  }, [allCandidates]);

  const assignments = allAssignments.filter(a => a.shift === shift);
  const tl = assignments.find(a => a.isTeamLeader);
  const drivers = assignments.filter(a => !a.isTeamLeader);

  const totalCost = assignments.reduce((s, a) => s + a.cost, 0);
  const totalHours = drivers.reduce((s, a) => s + a.hoursBilled, 0);

  const [adding, setAdding] = useState(false);
  const [addingTL, setAddingTL] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className={`h-4 w-4 ${shift === "morning" ? "text-blue-600" : "text-indigo-600"}`} />
              Equipa {shiftLabel} — {fmtDate(targetDate)}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Atribui pessoas, edita horários e "manda para casa" quando não há trabalho.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Custo escalado</div>
              <div className="text-lg font-bold">{fmtEur(totalCost)}</div>
              <div className="text-xs text-muted-foreground">{totalHours}h pagas</div>
            </div>
            <Button size="sm" variant="default" onClick={() => setAdding(v => !v)}>
              <Plus className="h-4 w-4 mr-1" /> {adding ? "Cancelar" : "Adicionar"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* TL banner */}
        <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-amber-900">Team Leader (obrigatório)</div>
              {tl ? (
                <div className="font-semibold flex items-center gap-2 min-w-0">
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={(tl as any).photoUrl ?? undefined} className="object-cover" />
                    <AvatarFallback className="text-[10px]">{tl.personName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="truncate">{tl.personName}</span>{" "}
                  <span className="font-normal text-sm text-muted-foreground">
                    · {fmtHour(tl.startHour)}–{fmtHour(tl.sentHomeHour ?? tl.endHour)} · {fmtEur(tl.cost)}/dia
                  </span>
                </div>
              ) : (
                <div className="text-sm text-amber-900">
                  Ainda não há TL definido. Define para arrancar.
                </div>
              )}
            </div>
            {!tl && (
              <Button size="sm" variant="outline" onClick={() => setAddingTL(v => !v)}>
                {addingTL ? "Cancelar" : "Definir Team Leader"}
              </Button>
            )}
            {tl && (
              <Button size="sm" variant="ghost" onClick={() => del.mutate({ id: tl.id })}>
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>

          {addingTL && !tl && (
            <div className="mt-3">
              <AssignmentForm
                targetDate={targetDate}
                candidates={candidates}
                asTeamLeader
                shift={shift}
                defaultStart={defaultStart}
                defaultEnd={defaultEnd}
                onSubmit={async (values) => {
                  await upsert.mutateAsync(values);
                  setAddingTL(false);
                }}
                onCancel={() => setAddingTL(false)}
                submitting={upsert.isPending}
              />
            </div>
          )}
        </div>

        {adding && (
          <AssignmentForm
            targetDate={targetDate}
            candidates={candidates}
            shift={shift}
            defaultStart={defaultStart}
            defaultEnd={defaultEnd}
            onSubmit={async (values) => {
              await upsert.mutateAsync(values);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
            submitting={upsert.isPending}
          />
        )}

        {assignmentsQuery.isLoading && (
          <div className="text-sm text-muted-foreground">A carregar...</div>
        )}

        {!assignmentsQuery.isLoading && drivers.length === 0 && !adding && (
          <div className="text-sm text-muted-foreground py-4 text-center">
            Nenhum condutor escalado. Clica em "Adicionar" para começar.
          </div>
        )}

        {drivers.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs uppercase text-muted-foreground">
                  <th className="text-left py-2 px-2">Pessoa</th>
                  <th className="text-left py-2 px-2">Nível</th>
                  <th className="text-right py-2 px-2">Início</th>
                  <th className="text-right py-2 px-2">Fim</th>
                  <th className="text-right py-2 px-2">Mandado p/ casa</th>
                  <th className="text-right py-2 px-2">Horas pagas</th>
                  <th className="text-right py-2 px-2">Custo</th>
                  <th className="text-right py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {drivers.map((a) => (
                  <AssignmentRow
                    key={a.id}
                    assignment={a}
                    onSave={(payload) => upsert.mutate({ ...payload, id: a.id })}
                    onDelete={() => del.mutate({ id: a.id })}
                    busy={upsert.isPending || del.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface AssignmentFormValues {
  assignmentDate: string;
  employeeId: number | null;
  personName: string;
  level: LevelId | null;
  isTeamLeader: boolean;
  shift: ShiftId;
  startHour: number;
  endHour: number;
  sentHomeHour: number | null;
}

function AssignmentForm({
  targetDate,
  candidates,
  asTeamLeader,
  shift,
  defaultStart,
  defaultEnd,
  onSubmit,
  onCancel,
  submitting,
}: {
  targetDate: string;
  candidates: {
    id: number;
    fullName: string;
    suggestedLevel: LevelId;
    photoUrl?: string | null;
    availability?: { status: "available" | "unavailable" | "no_response"; morning: boolean; night: boolean } | null;
  }[];
  asTeamLeader?: boolean;
  shift: ShiftId;
  defaultStart: number;
  defaultEnd: number;
  onSubmit: (values: AssignmentFormValues) => void | Promise<void>;
  onCancel: () => void;
  submitting: boolean;
}) {
  const levels = useLiveLevels();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [personName, setPersonName] = useState("");
  const [level, setLevel] = useState<LevelId>("junior");
  const [startHour, setStartHour] = useState(defaultStart);
  const [endHour, setEndHour] = useState(defaultEnd);

  const span = endHour - startHour;
  const rate = levels.find(l => l.id === level)?.hourlyRate ?? 0;
  const previewCost = Math.max(0, span) * rate;
  // TL must be linked to an employee (we need monthlySalary). Otherwise need a name.
  const valid = asTeamLeader
    ? employeeId != null && span >= 3 && span <= 12
    : personName.trim().length > 0 && span >= 3 && span <= 12;

  return (
    <div className="border rounded-md p-3 bg-muted/30 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Empregado (RH)</Label>
          <Select
            value={employeeId ? String(employeeId) : "none"}
            onValueChange={(v) => {
              if (v === "none") {
                setEmployeeId(null);
                return;
              }
              const id = parseInt(v, 10);
              const c = candidates.find(c => c.id === id);
              if (c) {
                setEmployeeId(id);
                setPersonName(c.fullName);
                setLevel(c.suggestedLevel);
              }
            }}
          >
            <SelectTrigger><SelectValue placeholder="Escolher..." /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— Nenhum (escrever nome) —</SelectItem>
              {candidates.map(c => (
                <SelectItem key={c.id} value={String(c.id)}>
                  <span className="flex items-center gap-1.5">
                    <Avatar className="h-5 w-5">
                      <AvatarImage src={c.photoUrl ?? undefined} className="object-cover" />
                      <AvatarFallback className="text-[9px]">{c.fullName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    {c.availability?.status === "available" && (
                      <span className="inline-flex gap-0.5">
                        {c.availability.morning && <Sun className="h-3 w-3 text-amber-500" />}
                        {c.availability.night && <Moon className="h-3 w-3 text-indigo-500" />}
                        {!c.availability.morning && !c.availability.night && <CheckCircle2 className="h-3 w-3 text-green-500" />}
                      </span>
                    )}
                    {c.availability?.status === "no_response" && (
                      <span className="h-2 w-2 inline-block rounded-full bg-muted-foreground/30" title="Sem resposta" />
                    )}
                    {c.availability?.status === "unavailable" && (
                      <span className="text-[10px] text-red-500" title="Disse que não está disponível">✕</span>
                    )}
                    <span className={c.availability?.status === "unavailable" ? "text-muted-foreground" : undefined}>{c.fullName}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Nome</Label>
          <Input
            value={personName}
            onChange={e => setPersonName(e.target.value)}
            placeholder="Nome da pessoa"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Nível</Label>
          {asTeamLeader ? (
            <div className="h-9 px-3 flex items-center text-sm border rounded-md bg-muted/60">
              Team Leader
            </div>
          ) : (
            <Select value={level} onValueChange={v => setLevel(v as LevelId)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {levels.map(l => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.label} ({fmtEur(l.hourlyRate)}/h)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div className="space-y-1">
          <Label className="text-xs">Início</Label>
          <Select value={String(startHour)} onValueChange={v => setStartHour(parseInt(v, 10))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {HOURS_24.map(h => (
                <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Fim</Label>
          <Select value={String(endHour)} onValueChange={v => setEndHour(parseInt(v, 10))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {HOURS_25.map(h => (
                <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="text-sm">
          <div className="text-xs text-muted-foreground">Pré-visualização</div>
          {asTeamLeader ? (
            <div className="font-semibold">
              Custo diário do TL (salário/15)
            </div>
          ) : (
            <div className="font-semibold">
              {span}h × {fmtEur(rate)} = {fmtEur(previewCost)}
            </div>
          )}
          {span < 3 && <div className="text-xs text-red-600">Mínimo 3h</div>}
          {span > 12 && <div className="text-xs text-red-600">Máximo 12h</div>}
          {asTeamLeader && employeeId == null && (
            <div className="text-xs text-red-600">TL tem de vir de RH (precisa de salário)</div>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} size="sm">Cancelar</Button>
        <Button
          size="sm"
          disabled={!valid || submitting}
          onClick={() => onSubmit({
            assignmentDate: targetDate,
            employeeId,
            personName: personName.trim(),
            level: asTeamLeader ? null : level,
            isTeamLeader: !!asTeamLeader,
            shift,
            startHour,
            endHour,
            sentHomeHour: null,
          })}
        >
          {asTeamLeader ? "Definir TL" : "Adicionar"}
        </Button>
      </div>
    </div>
  );
}

function AssignmentRow({
  assignment,
  onSave,
  onDelete,
  busy,
}: {
  assignment: {
    id: number;
    assignmentDate: string;
    employeeId: number | null;
    personName: string;
    level: LevelId | null;
    isTeamLeader: boolean;
    shift: ShiftId;
    startHour: number;
    endHour: number;
    sentHomeHour: number | null;
    notes: string | null;
    hoursBilled: number;
    cost: number;
  };
  onSave: (payload: AssignmentFormValues) => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const a = assignment;
  const levels = useLiveLevels();
  const [editing, setEditing] = useState(false);
  const [level, setLevel] = useState<LevelId>((a.level ?? "junior") as LevelId);
  const [startHour, setStartHour] = useState(a.startHour);
  const [endHour, setEndHour] = useState(a.endHour);
  const [sentHomeHour, setSentHomeHour] = useState<number | null>(a.sentHomeHour);

  const span = (sentHomeHour ?? endHour) - startHour;
  const rate = levels.find(l => l.id === level)?.hourlyRate ?? 0;
  const computedCost = Math.max(0, span) * rate;

  if (!editing) {
    return (
      <tr className="border-b hover:bg-muted/30">
        <td className="py-2 px-2">
          <span className="flex items-center gap-2">
            <Avatar className="h-6 w-6">
              <AvatarImage src={(a as any).photoUrl ?? undefined} className="object-cover" />
              <AvatarFallback className="text-[10px]">{a.personName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            {a.personName}
          </span>
        </td>
        <td className="py-2 px-2">
          <Badge variant="secondary">{levels.find(l => l.id === a.level)?.label}</Badge>
        </td>
        <td className="py-2 px-2 text-right font-mono">{fmtHour(a.startHour)}</td>
        <td className="py-2 px-2 text-right font-mono">{fmtHour(a.endHour)}</td>
        <td className="py-2 px-2 text-right font-mono">
          {a.sentHomeHour != null ? fmtHour(a.sentHomeHour) : "—"}
        </td>
        <td className="py-2 px-2 text-right">{a.hoursBilled}h</td>
        <td className="py-2 px-2 text-right font-semibold">{fmtEur(a.cost)}</td>
        <td className="py-2 px-2 text-right">
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Editar</Button>
            <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b bg-muted/20">
      <td className="py-2 px-2">{a.personName}</td>
      <td className="py-2 px-2">
        <Select value={level} onValueChange={v => setLevel(v as LevelId)}>
          <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
          <SelectContent>
            {levels.map(l => (
              <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
      <td className="py-2 px-2 text-right">
        <Select value={String(startHour)} onValueChange={v => setStartHour(parseInt(v, 10))}>
          <SelectTrigger className="h-8 w-20"><SelectValue /></SelectTrigger>
          <SelectContent>
            {HOURS_24.map(h => <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>)}
          </SelectContent>
        </Select>
      </td>
      <td className="py-2 px-2 text-right">
        <Select value={String(endHour)} onValueChange={v => setEndHour(parseInt(v, 10))}>
          <SelectTrigger className="h-8 w-20"><SelectValue /></SelectTrigger>
          <SelectContent>
            {HOURS_25.map(h => <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>)}
          </SelectContent>
        </Select>
      </td>
      <td className="py-2 px-2 text-right">
        <Select
          value={sentHomeHour == null ? "none" : String(sentHomeHour)}
          onValueChange={v => setSentHomeHour(v === "none" ? null : parseInt(v, 10))}
        >
          <SelectTrigger className="h-8 w-24"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— Não —</SelectItem>
            {HOURS_25
              .filter(h => h >= startHour && h <= endHour)
              .map(h => (
                <SelectItem key={h} value={String(h)}>
                  <span className="flex items-center gap-1"><Home className="h-3 w-3" />{fmtHour(h)}</span>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </td>
      <td className="py-2 px-2 text-right">{Math.max(0, span)}h</td>
      <td className="py-2 px-2 text-right font-semibold">{fmtEur(computedCost)}</td>
      <td className="py-2 px-2 text-right">
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            disabled={busy || endHour - startHour < 3 || endHour - startHour > 12}
            onClick={() => {
              onSave({
                assignmentDate: a.assignmentDate,
                employeeId: a.employeeId,
                personName: a.personName,
                level,
                isTeamLeader: false,
                shift: a.shift,
                startHour,
                endHour,
                sentHomeHour,
              });
              setEditing(false);
            }}
          >
            Guardar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancelar
          </Button>
        </div>
      </td>
    </tr>
  );
}

function KpiCard({
  icon,
  label,
  value,
  hint,
  breakdown,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  hint?: string;
  breakdown?: { covered: number; uncovered: number; indoor: number; unknown: number };
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="text-2xl font-bold mt-1">{value}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
        {breakdown && (breakdown.uncovered + breakdown.covered + breakdown.indoor + breakdown.unknown > 0) && (
          <div className="text-[10px] text-muted-foreground mt-1 leading-tight">
            {breakdown.uncovered > 0 && <span>{breakdown.uncovered} desc.</span>}
            {breakdown.covered > 0 && <span className="ml-1">{breakdown.covered} cob.</span>}
            {breakdown.indoor > 0 && <span className="ml-1">{breakdown.indoor} ind.</span>}
            {breakdown.unknown > 0 && <span className="ml-1">{breakdown.unknown} ?</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Hour / Slot drill-down ──────────────────────────────────────────────────

const fmtHM = (h: number, m: number) =>
  `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

function HourRow({
  row,
  targetDate,
  isPeak,
}: {
  row: {
    hour: number;
    checkins: number;
    checkouts: number;
    driversNeeded: number;
    hasT2: boolean;
    hasOther: boolean;
    slots: { hour: number; slot: number; checkins: number; checkouts: number; weightedDemand: number; driversNeeded: number }[];
  };
  targetDate: string;
  isPeak: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = row.checkins + row.checkouts;
  // Prioridade: Outro (vermelho) > T2 (amarelo) > pico (azul) > default
  const rowBg = row.hasOther
    ? "bg-red-50 hover:bg-red-100/70"
    : row.hasT2
      ? "bg-yellow-50 hover:bg-yellow-100/70"
      : isPeak
        ? "bg-blue-50/50 hover:bg-muted/40"
        : "hover:bg-muted/40";
  return (
    <>
      <tr
        className={`border-b cursor-pointer ${rowBg}`}
        onClick={() => setExpanded(v => !v)}
      >
        <td className="py-1.5 px-2 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </td>
        <td className="py-1.5 px-2 font-mono">{fmtHour(row.hour)}</td>
        <td className="py-1.5 px-2 text-right text-emerald-700">{row.checkins || ""}</td>
        <td className="py-1.5 px-2 text-right text-orange-700">{row.checkouts || ""}</td>
        <td className="py-1.5 px-2 text-right font-semibold">{total}</td>
        <td className="py-1.5 px-2 text-right">
          <Badge variant="secondary">{row.driversNeeded}</Badge>
        </td>
      </tr>
      {expanded && row.slots.map(s => (
        <SlotRow key={s.slot} slot={s} targetDate={targetDate} />
      ))}
    </>
  );
}

function SlotRow({
  slot,
  targetDate,
}: {
  slot: { hour: number; slot: number; checkins: number; checkouts: number; weightedDemand: number; driversNeeded: number };
  targetDate: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const minuteStart = slot.slot * 20;
  const minuteEnd = minuteStart + 20;
  const label = `${fmtHM(slot.hour, minuteStart)}–${fmtHM(slot.hour, minuteEnd)}`;
  const total = slot.checkins + slot.checkouts;
  const hasData = total > 0;

  return (
    <>
      <tr
        className={`border-b ${hasData ? "cursor-pointer hover:bg-muted/30" : ""} bg-muted/10`}
        onClick={() => hasData && setExpanded(v => !v)}
      >
        <td className="py-1 px-2 pl-6 text-muted-foreground">
          {hasData && (expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />)}
        </td>
        <td className="py-1 px-2 font-mono text-xs text-muted-foreground">{label}</td>
        <td className="py-1 px-2 text-right text-emerald-700 text-xs">{slot.checkins || ""}</td>
        <td className="py-1 px-2 text-right text-orange-700 text-xs">{slot.checkouts || ""}</td>
        <td className="py-1 px-2 text-right text-xs">{total || ""}</td>
        <td className="py-1 px-2 text-right text-xs text-muted-foreground">
          {slot.driversNeeded || ""}
          {slot.weightedDemand > total && total > 0 && (
            <span className="ml-1 text-amber-700" title="Procura aumentada por T2/Outro">⚠</span>
          )}
        </td>
      </tr>
      {expanded && hasData && (
        <tr>
          <td colSpan={6} className="bg-blue-50/30 px-6 py-2">
            <SlotBookings targetDate={targetDate} hour={slot.hour} slot={slot.slot} />
          </td>
        </tr>
      )}
    </>
  );
}

function SlotBookings({
  targetDate,
  hour,
  slot,
}: {
  targetDate: string;
  hour: number;
  slot: number;
}) {
  const checkinsQ = trpc.extrasDia.bookingsInSlot.useQuery(
    { date: targetDate, hour, slot, type: "checkin" },
  );
  const checkoutsQ = trpc.extrasDia.bookingsInSlot.useQuery(
    { date: targetDate, hour, slot, type: "checkout" },
  );

  const checkins = checkinsQ.data ?? [];
  const checkouts = checkoutsQ.data ?? [];
  const loading = checkinsQ.isLoading || checkoutsQ.isLoading;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
      <BookingList title="Chegadas" tone="emerald" items={checkins} loading={loading} />
      <BookingList title="Saídas" tone="orange" items={checkouts} loading={loading} />
    </div>
  );
}

function BookingList({
  title,
  tone,
  items,
  loading,
}: {
  title: string;
  tone: "emerald" | "orange";
  items: { id: number; clientName: string; licensePlate: string | null; parkName: string | null; time: string; bookingNumber: string | null; deliveryType: string | null }[];
  loading: boolean;
}) {
  const accent = tone === "emerald" ? "text-emerald-700" : "text-orange-700";
  return (
    <div>
      <div className={`font-semibold mb-1 ${accent}`}>{title}</div>
      {loading && <div className="text-muted-foreground">A carregar...</div>}
      {!loading && items.length === 0 && (
        <div className="text-muted-foreground">Sem reservas neste intervalo.</div>
      )}
      {items.length > 0 && (
        <ul className="space-y-0.5">
          {items.map(b => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-2">
              <span className="font-mono">{b.time}</span>
              <span className="font-mono text-muted-foreground">{b.licensePlate || "—"}</span>
              <span>{b.clientName}</span>
              {b.deliveryType && (
                <Badge variant="outline" className="text-[10px] py-0 h-4">
                  {b.deliveryType}
                </Badge>
              )}
              {b.parkName && (
                <span className="text-muted-foreground">· {b.parkName}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WashTile({
  title,
  date,
  count,
  highlight,
}: {
  title: string;
  date: string;
  count: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`border rounded-md p-3 ${
        highlight ? "bg-cyan-50/60 border-cyan-200" : "bg-card"
      }`}
    >
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="text-xs text-muted-foreground">{fmtDate(date)}</div>
      <div className="text-2xl font-bold mt-1">{count}</div>
    </div>
  );
}

// ─── Disponibilidade semanal dos extras (backoffice) ─────────────────────────
// ─── Candidaturas de condutores vindas do website multidriver ────────────────
// Novas candidaturas do formulário "Be a Driver" chegam via /api/v1 e ficam
// aqui para revisão. Aprovar cria (ou liga a) um employee extra com o mesmo
// email — a partir daí o extra aparece nos candidatos e na disponibilidade.

const APP_STATUS: Record<string, { label: string; className: string }> = {
  new: { label: "Nova", className: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  reviewed: { label: "Revista", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  approved: { label: "Aprovada", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  rejected: { label: "Rejeitada", className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
};

// Exportada: rende agora na página Disponibilidade (hub de gestão), não aqui —
// a Extras Dia ficou só com previsão + equipa do dia (pedido do Jorge, jul 2026).
export function CandidaturasSection() {
  const [statusFilter, setStatusFilter] = useState<string>("new");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // refetchInterval: candidaturas chegam do site a qualquer hora — o badge
  // "N novas" tem de atualizar com a página aberta, sem reload.
  const list = trpc.driverApplications.list.useQuery({
    status: statusFilter === "all" ? null : (statusFilter as any),
  }, { refetchInterval: 60_000 });
  const newCount = trpc.driverApplications.list.useQuery({ status: "new" }, { refetchInterval: 60_000 });

  const approve = trpc.driverApplications.approve.useMutation({
    onSuccess: (r) => {
      toast.success(r.employeeCreated ? "Candidatura aprovada — extra criado" : "Candidatura aprovada — ligada a extra existente");
      list.refetch();
      newCount.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const setStatus = trpc.driverApplications.setStatus.useMutation({
    onSuccess: () => {
      list.refetch();
      newCount.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const apps = list.data ?? [];
  const pending = newCount.data?.length ?? 0;

  const fmtWhen = (s: string) => {
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
    return isNaN(d.getTime()) ? s : d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric" });
  };

  return (
    <Card className="border-emerald-200">
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-emerald-600" />
            Candidaturas do site (Be a Driver)
            {pending > 0 && (
              <Badge className="bg-blue-600 text-white hover:bg-blue-600">{pending} nova{pending > 1 ? "s" : ""}</Badge>
            )}
          </CardTitle>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">Novas</SelectItem>
              <SelectItem value="reviewed">Revistas</SelectItem>
              <SelectItem value="approved">Aprovadas</SelectItem>
              <SelectItem value="rejected">Rejeitadas</SelectItem>
              <SelectItem value="all">Todas</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {list.isLoading && <div className="text-sm text-muted-foreground">A carregar candidaturas...</div>}
        {!list.isLoading && apps.length === 0 && (
          <div className="text-sm text-muted-foreground py-2">
            Sem candidaturas {statusFilter !== "all" ? `com estado "${APP_STATUS[statusFilter]?.label ?? statusFilter}"` : ""}.
          </div>
        )}
        {apps.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs uppercase text-muted-foreground">
                  <th className="text-left py-2 px-2 w-6"></th>
                  <th className="text-left py-2 px-2">Nome</th>
                  <th className="text-left py-2 px-2">Email</th>
                  <th className="text-left py-2 px-2">Telefone</th>
                  <th className="text-left py-2 px-2">Cidade</th>
                  <th className="text-left py-2 px-2">Recebida</th>
                  <th className="text-left py-2 px-2">Estado</th>
                  <th className="text-right py-2 px-2">Ações</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((a: any) => {
                  const st = APP_STATUS[a.status] ?? APP_STATUS.new;
                  const expanded = expandedId === a.id;
                  const payload = (a.payload ?? {}) as Record<string, unknown>;
                  return (
                    <Fragment key={a.id}>
                      <tr className="border-b hover:bg-muted/40">
                        <td className="py-2 px-2">
                          <button
                            className="text-muted-foreground"
                            onClick={() => setExpandedId(expanded ? null : a.id)}
                            title={expanded ? "Fechar detalhes" : "Ver detalhes"}
                          >
                            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        </td>
                        <td className="py-2 px-2 font-medium">
                          {a.fullName}
                          {a.submissionCount > 1 && (
                            <span className="ml-1 text-xs text-muted-foreground">({a.submissionCount}× submetida)</span>
                          )}
                        </td>
                        <td className="py-2 px-2 break-all">{a.email}</td>
                        <td className="py-2 px-2">{a.phone ?? "—"}</td>
                        <td className="py-2 px-2">{a.city ?? "—"}</td>
                        <td className="py-2 px-2 whitespace-nowrap">{fmtWhen(a.lastSubmittedAt)}</td>
                        <td className="py-2 px-2">
                          <Badge variant="outline" className={st.className}>{st.label}</Badge>
                        </td>
                        <td className="py-2 px-2 text-right whitespace-nowrap">
                          {a.status !== "approved" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-emerald-600 text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950 mr-1"
                              disabled={approve.isPending}
                              onClick={() => {
                                if (confirm(`Aprovar ${a.fullName} e criar/ligar o extra?`)) approve.mutate({ id: a.id });
                              }}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Aprovar
                            </Button>
                          )}
                          {a.status !== "rejected" && a.status !== "approved" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-red-300 text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                              disabled={setStatus.isPending}
                              onClick={() => setStatus.mutate({ id: a.id, status: "rejected" })}
                            >
                              <XCircle className="h-3.5 w-3.5 mr-1" /> Rejeitar
                            </Button>
                          )}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-b bg-muted/20">
                          <td colSpan={8} className="py-3 px-4">
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-xs">
                              {a.nif && <div><span className="text-muted-foreground">NIF:</span> {a.nif}</div>}
                              {a.country && <div><span className="text-muted-foreground">País:</span> {a.country}</div>}
                              {a.drivingExperience && <div><span className="text-muted-foreground">Experiência:</span> {a.drivingExperience}</div>}
                              {a.expectedHourlyRate && <div><span className="text-muted-foreground">€/h esperado:</span> {a.expectedHourlyRate}</div>}
                              {a.howDidYouKnow && <div><span className="text-muted-foreground">Como conheceu:</span> {a.howDidYouKnow}</div>}
                              {a.employeeId && <div><span className="text-muted-foreground">Employee:</span> #{a.employeeId}</div>}
                              {Object.entries(payload)
                                .filter(([, v]) => v != null && v !== "" && (typeof v !== "object" || Array.isArray(v)))
                                .map(([k, v]) => (
                                  <div key={k}>
                                    <span className="text-muted-foreground">{k}:</span>{" "}
                                    {Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Sim" : "Não") : String(v)}
                                  </div>
                                ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Exportada: rende agora na página Disponibilidade (hub de gestão) — ver nota
// na CandidaturasSection.
export function AvailabilitySection() {
  const hints = trpc.extrasAvailability.weekHints.useQuery();
  const [weekStart, setWeekStart] = useState<string>("");
  const [note, setNote] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // A tabela lista TODOS os extras ativos por defeito — é a lista de contactos
  // da operação, e o caso de uso principal é falar com quem AINDA NÃO
  // respondeu. Este filtro reduz a quem já marcou disponibilidade.
  const [onlyWithAvailability, setOnlyWithAvailability] = useState(false);
  // Filtro de cidade. "all" = sem filtro; "none" = fichas sem cidade
  // identificada (ver server/employeeCity.ts — a cidade é DERIVADA).
  const [cityFilter, setCityFilter] = useState<CityKey | "all" | "none">("all");

  // assim que chegam as sugestões, default = próxima segunda
  const effectiveWeek = weekStart || hints.data?.next || "";

  const overview = trpc.extrasAvailability.overview.useQuery(
    { weekStart: effectiveWeek },
    { enabled: !!effectiveWeek },
  );

  const send = trpc.extrasAvailability.sendRequest.useMutation({
    onSuccess: (r) => {
      toast.success(`Pedido enviado: ${r.sent} extras${r.failed ? `, ${r.failed} falhas` : ""}${r.noEmail ? `, ${r.noEmail} sem email` : ""}`);
      overview.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const o = overview.data;
  // Os dois filtros COMPÕEM-SE: cidade primeiro, disponibilidade depois. O
  // conjunto resultante é o que a tabela mostra E o alvo de "a todos" (email e
  // WhatsApp) — invariante "o que envio é o que vejo".
  const shownExtras = useMemo(() => {
    if (!o) return [];
    let list = o.extras;
    if (cityFilter === "none") list = list.filter(e => e.city === null);
    else if (cityFilter !== "all") list = list.filter(e => e.city === cityFilter);
    if (onlyWithAvailability) list = list.filter(e => e.availableDays > 0);
    return list;
  }, [o, cityFilter, onlyWithAvailability]);

  // Contagens do cabeçalho seguem o conjunto FILTRADO (as do servidor são
  // sempre o universo completo e mentiriam com um filtro aplicado).
  const shownResponded = shownExtras.filter(e => e.responded).length;
  const shownWithPhone = shownExtras.filter(e => !!e.phoneE164).length;
  // Totais por dia recalculados sobre o conjunto visível — os do servidor
  // contam o universo todo e deixariam de bater certo com a tabela filtrada.
  const shownPerDay = useMemo(
    () =>
      (o?.dayHeaders ?? []).map(h => {
        let morning = 0;
        let night = 0;
        for (const e of shownExtras) {
          const d = e.days.find(x => x.day === h.day);
          if (d?.morning) morning++;
          if (d?.night) night++;
        }
        return { day: h.day, morning, night };
      }),
    [o, shownExtras],
  );
  const cityCounts = useMemo(() => {
    const counts = { all: o?.extras.length ?? 0, none: 0 } as Record<string, number>;
    for (const key of CITY_KEYS) counts[key] = 0;
    for (const e of o?.extras ?? []) counts[e.city ?? "none"]++;
    return counts;
  }, [o]);

  /** Mudar de alvo limpa a seleção — nunca enviar a quem já não se vê. */
  function changeCityFilter(next: CityKey | "all" | "none") {
    setCityFilter(next);
    setSelectedIds(new Set());
  }

  // ── WhatsApp broadcast ────────────────────────────────────────────────────
  const [waOpen, setWaOpen] = useState(false);
  // Template e língua são os aprovados na Meta (shared/whatsappTemplate.ts).
  // {{1}} = nome do extra (automático, por destinatário, no servidor).
  // {{2}} = este campo, igual para todos os destinatários.
  const [waParam2, setWaParam2] = useState("");
  const [waTestPhone, setWaTestPhone] = useState("");
  type WaRecipient = {
    employeeId: number | null;
    name: string | null;
    phone: string;
    phoneE164: string | null;
    status: "sent" | "failed" | "invalid_phone";
    error?: string;
  };
  const [waResult, setWaResult] = useState<
    null | { total: number; sent: number; failed: number; invalidPhone: number; recipients: WaRecipient[] }
  >(null);

  const broadcast = trpc.whatsapp.sendBroadcast.useMutation({
    onSuccess: (r) => {
      setWaResult(r);
      toast.success(
        `WhatsApp: ${r.sent} enviados${r.failed ? `, ${r.failed} falhas` : ""}${r.invalidPhone ? `, ${r.invalidPhone} sem número` : ""}`,
      );
      overview.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  // Alvo do broadcast = selecionados (se houver) ou todos os mostrados.
  // `phoneE164` vem calculado do servidor — a MESMA normalização que o envio
  // usa, para o resumo "válidos/inválidos" nunca divergir do resultado real.
  const waTargets = selectedIds.size > 0 ? shownExtras.filter(e => selectedIds.has(e.employeeId)) : shownExtras;
  const waValidCount = waTargets.filter(e => !!e.phoneE164).length;
  const waInvalidCount = waTargets.length - waValidCount;

  function submitBroadcast(testPhone?: string) {
    const bodyParam2 = waParam2.trim();
    if (!bodyParam2) {
      toast.error("Indica a semana.");
      return;
    }
    setWaResult(null);
    // Invariante mantida (Decisão 1 do Jorge): "a todos" = o conjunto MOSTRADO
    // na tabela — o que envio é o que vejo. Envio de teste ignora o alvo.
    const targetIds = selectedIds.size > 0
      ? Array.from(selectedIds)
      : shownExtras.map(e => e.employeeId);
    broadcast.mutate({
      templateName: AVAILABILITY_TEMPLATE_NAME,
      languageCode: DEFAULT_TEMPLATE_LANGUAGE,
      bodyParam2,
      // O botão com link do formulário é detetado pelos metadados do template
      // na Meta (server/whatsappTemplateMeta.ts) — sem override manual na UI.
      employeeIds: testPhone ? undefined : targetIds,
      weekStart: effectiveWeek || null,
      note: note.trim() || null,
      testPhone: testPhone ? testPhone.trim() : undefined,
    });
  }

  return (
    <Card className="border-blue-200">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4 text-blue-600" />
          Disponibilidade dos extras
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1">
            <Label className="text-xs">Semana (começa em)</Label>
            <Input
              type="date"
              className="w-44"
              value={effectiveWeek}
              onChange={(e) => setWeekStart(e.target.value)}
            />
          </div>
          {hints.data && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setWeekStart(hints.data!.current)}>
                Esta semana
              </Button>
              <Button variant="outline" size="sm" onClick={() => setWeekStart(hints.data!.next)}>
                Próxima semana
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Mensagem opcional no email</Label>
          <Input
            placeholder="Ex: Reforço para o fim de semana do festival..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {/* Teste: enviar só para um endereço (não toca nos extras) */}
        <div className="rounded-md border border-dashed p-3 space-y-2">
          <Label className="text-xs font-medium">Testar primeiro (envia só para 1 email)</Label>
          <div className="flex gap-2 flex-wrap">
            <Input
              type="email"
              placeholder="o-teu-email@multipark.pt"
              className="w-64"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={!effectiveWeek || !testEmail.includes("@") || send.isPending}
              onClick={() => send.mutate({
                weekStart: effectiveWeek,
                origin: window.location.origin,
                note: note.trim() || null,
                testEmail: testEmail.trim(),
              })}
            >
              <Send className="h-4 w-4 mr-2" /> Enviar teste
            </Button>
          </div>
        </div>

        {/* Envio real: a todos OU só aos selecionados na tabela abaixo */}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!effectiveWeek || send.isPending || shownExtras.length === 0}
            onClick={() => {
              // "A todos" = o conjunto VISÍVEL (mesma invariante do WhatsApp).
              // Manda-se sempre a lista explícita: com um filtro de cidade
              // aplicado, deixar o servidor decidir "todos" enviaria a gente
              // que não está na tabela.
              const ids = selectedIds.size > 0 ? Array.from(selectedIds) : shownExtras.map(e => e.employeeId);
              const alvo = selectedIds.size > 0
                ? `aos ${ids.length} extras selecionados`
                : `aos ${ids.length} extras mostrados na tabela`;
              if (!confirm(`Enviar pedido de disponibilidade ${alvo} para a semana de ${effectiveWeek}?`)) return;
              send.mutate({
                weekStart: effectiveWeek,
                origin: window.location.origin,
                note: note.trim() || null,
                employeeIds: ids,
              });
            }}
          >
            {send.isPending ? <Clock className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
            {selectedIds.size > 0 ? `Email aos ${selectedIds.size} selecionados` : `Email aos ${shownExtras.length} mostrados`}
          </Button>

          {/* WhatsApp: abre um dialog dedicado (template + teste + resultado) */}
          <Button
            variant="outline"
            className="border-green-600 text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
            onClick={() => { setWaResult(null); setWaOpen(true); }}
          >
            <MessageCircle className="h-4 w-4 mr-2" />
            {selectedIds.size > 0 ? `WhatsApp aos ${selectedIds.size} selecionados` : `WhatsApp aos ${shownExtras.length} mostrados`}
          </Button>
        </div>

        {o && (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm text-muted-foreground">
                {shownExtras.length}
                {shownExtras.length !== o.totalExtras ? ` de ${o.totalExtras}` : ""} extras ativos ·{" "}
                {shownResponded} responderam para {o.weekStart} – {o.weekEnd} ·{" "}
                <span className={shownWithPhone === 0 ? "text-amber-600" : undefined}>
                  {shownWithPhone} com número válido
                </span>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyWithAvailability}
                  onChange={(e) => {
                    setOnlyWithAvailability(e.target.checked);
                    setSelectedIds(new Set()); // o alvo mudou — não enviar a quem já não se vê
                  }}
                />
                Mostrar só quem marcou disponibilidade
              </label>
            </div>

            {/* Filtro por cidade. A cidade é DERIVADA (projeto → candidatura →
                morada); "sem cidade" é um estado real e filtrável, não um erro. */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              {([
                { key: "all" as const, label: "Todas" },
                ...CITY_KEYS.map(k => ({ key: k, label: CITY_LABELS[k] })),
                { key: "none" as const, label: "Sem cidade" },
              ]).map(({ key, label }) => (
                <Button
                  key={key}
                  size="sm"
                  variant={cityFilter === key ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => changeCityFilter(key)}
                >
                  {label}
                  <span className="ml-1 opacity-70">{cityCounts[key] ?? 0}</span>
                </Button>
              ))}
            </div>

            {/* Contagem por dia */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-1 pr-1 w-6">
                      <input
                        type="checkbox"
                        title="Selecionar todos"
                        checked={selectedIds.size > 0 && selectedIds.size === shownExtras.length}
                        onChange={(e) => {
                          setSelectedIds(e.target.checked ? new Set(shownExtras.map(x => x.employeeId)) : new Set());
                        }}
                      />
                    </th>
                    <th className="py-1 pr-2">Extra</th>
                    <th className="py-1 pr-2">Cidade</th>
                    <th className="py-1 pr-2">Telefone</th>
                    {o.dayHeaders.map((h) => (
                      <th key={h.day} className="px-1 text-center whitespace-nowrap">{h.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shownExtras.map((ex) => (
                    <tr key={ex.employeeId} className="border-b last:border-0">
                      <td className="py-1 pr-1">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(ex.employeeId)}
                          onChange={(e) => {
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(ex.employeeId);
                              else next.delete(ex.employeeId);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        <span className="flex items-center gap-1">
                          {ex.responded
                            ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                            : <span className="h-3.5 w-3.5 inline-block rounded-full border border-muted-foreground/30" />}
                          {ex.fullName}
                        </span>
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap text-xs">
                        {ex.city ? (
                          <span
                            className="text-muted-foreground"
                            title={ex.citySource ? `Cidade obtida da ${CITY_SOURCE_LABELS[ex.citySource]}` : undefined}
                          >
                            {CITY_LABELS[ex.city]}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40" title="Sem projeto, candidatura ou morada que identifique a cidade">
                            —
                          </span>
                        )}
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap text-xs">
                        {ex.phoneE164 ? (
                          <span className="text-muted-foreground" title={ex.phone ?? undefined}>{ex.phoneE164}</span>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-amber-400 text-amber-600 gap-1 font-normal"
                            title={ex.phone ? `Número não reconhecido: ${ex.phone}` : "Ficha sem telefone"}
                          >
                            <AlertTriangle className="h-3 w-3" /> {ex.phone ? "número não reconhecido" : "sem número"}
                          </Badge>
                        )}
                      </td>
                      {ex.days.map((d) => (
                        <td key={d.day} className="px-1 text-center align-top">
                          {(d.morning || d.night || d.fromHour != null) ? (
                            <span
                              className="inline-flex flex-col items-center leading-tight"
                              title={d.note ?? undefined}
                            >
                              <span className="inline-flex gap-0.5 justify-center items-center">
                                {d.morning && <Sun className="h-3.5 w-3.5 text-amber-500" />}
                                {d.night && <Moon className="h-3.5 w-3.5 text-indigo-500" />}
                                {d.note && <span className="text-muted-foreground text-xs" aria-label="tem nota">✱</span>}
                              </span>
                              {(d.fromHour != null || d.toHour != null) && (
                                <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                  {d.fromHour ?? "?"}h–{d.toHour ?? "?"}h
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/30">·</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {shownExtras.length === 0 && (
                    <tr>
                      <td colSpan={o.dayHeaders.length + 4} className="py-3 text-center text-muted-foreground">
                        {cityFilter !== "all"
                          ? "Nenhum extra neste filtro de cidade."
                          : onlyWithAvailability
                            ? "Ainda ninguém marcou disponibilidade para esta semana."
                            : "Não há extras ativos (RH → colaboradores com função “extra”)."}
                      </td>
                    </tr>
                  )}
                  {/* Totais por dia */}
                  <tr className="font-medium border-t-2">
                    <td className="py-1 pr-1" />
                    <td className="py-1 pr-2">Disponíveis</td>
                    <td className="py-1 pr-2" />
                    <td className="py-1 pr-2" />
                    {shownPerDay.map((p) => (
                      <td key={p.day} className="px-1 text-center text-xs">
                        <span className="text-amber-600">{p.morning}</span>
                        {" / "}
                        <span className="text-indigo-600">{p.night}</span>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
              <div className="text-xs text-muted-foreground mt-1">
                <Sun className="h-3 w-3 inline text-amber-500" /> manhã · <Moon className="h-3 w-3 inline text-indigo-500" /> noite · horas = janela indicada pela pessoa · ✱ tem nota (passa o rato por cima) · totais = nº disponíveis por turno
              </div>
            </div>
          </div>
        )}

        {/* ── Dialog do broadcast WhatsApp ─────────────────────────────────── */}
        <Dialog open={waOpen} onOpenChange={(open) => { if (!broadcast.isPending) setWaOpen(open); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-green-600" />
                Enviar WhatsApp
              </DialogTitle>
              <DialogDescription>
                {selectedIds.size > 0
                  ? `${selectedIds.size} extra(s) selecionado(s)`
                  : `Todos os ${shownExtras.length} extras da tabela`}
                {waInvalidCount > 0 ? ` · ${waInvalidCount} sem número válido` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1">
                <Label className="text-xs">Semana</Label>
                <Input
                  autoFocus
                  placeholder="ex: semana de 12 a 19 de agosto"
                  value={waParam2}
                  onChange={(e) => setWaParam2(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Número de teste</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="+351912345678"
                    value={waTestPhone}
                    onChange={(e) => setWaTestPhone(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    className="shrink-0"
                    disabled={!waParam2.trim() || !waTestPhone.trim() || broadcast.isPending}
                    onClick={() => submitBroadcast(waTestPhone)}
                  >
                    {broadcast.isPending ? <Clock className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                    Enviar teste
                  </Button>
                </div>
              </div>

              {/* Resultado por destinatário (só depois de enviar) */}
              {waResult && (
                <div className="rounded-md border p-3 space-y-2">
                  <div className="text-sm font-medium">
                    {waResult.sent} enviados · {waResult.failed} falhas · {waResult.invalidPhone} sem número
                  </div>
                  <div className="max-h-48 overflow-y-auto text-xs divide-y">
                    {waResult.recipients.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 py-1">
                        {r.status === "sent" && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />}
                        {r.status === "failed" && <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                        {r.status === "invalid_phone" && <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
                        <span className="flex-1 truncate">
                          {r.name || r.phone}
                          {r.phoneE164 ? <span className="text-muted-foreground"> · {r.phoneE164}</span> : null}
                        </span>
                        {r.error && <span className="text-red-500 truncate max-w-[45%]">{r.error}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setWaOpen(false)} disabled={broadcast.isPending}>
                Fechar
              </Button>
              <Button
                className="bg-green-600 hover:bg-green-700 text-white"
                disabled={!waParam2.trim() || broadcast.isPending || waValidCount === 0}
                onClick={() => submitBroadcast()}
              >
                {broadcast.isPending ? <Clock className="h-4 w-4 mr-2 animate-spin" /> : <MessageCircle className="h-4 w-4 mr-2" />}
                Enviar a {waValidCount} extra(s)
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
