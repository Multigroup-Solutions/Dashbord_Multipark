import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { fmtPTDate, fmtPTDateTime, fmtPTTime } from "@/lib/lisbonTime";
import type { HandoverCity } from "@shared/shiftHandover";
import type { LiveCar, LivePhase, LiveUpcoming, ShiftState } from "../../../server/multiparkDb/shiftState";

// ─── "Estado do parque (ao vivo)" — separador da Passagem de turno ──────────
// Lido AO VIVO da BD da Multipark (só leitura): carros no parque por
// garagem/lugar, operações em curso, próximas recolhas/entregas (com voo e
// ETA), ocorrências por resolver, caixa por fechar e bloqueios de amanhã.

const PHASE_LABELS: Record<LivePhase, string> = {
  checking_in: "A fazer check-in",
  in_park: "No parque",
  moving: "Em movimento",
  pending_checkout: "Entrega pendente",
  baggage_waiting: "À espera das malas",
  at_delivery: "No local de entrega",
  checking_out: "A fazer check-out",
};
const PHASE_TONE: Partial<Record<LivePhase, string>> = {
  pending_checkout: "border-red-300 text-red-700",
  baggage_waiting: "border-amber-300 text-amber-700",
  at_delivery: "border-blue-300 text-blue-700",
  checking_out: "border-blue-300 text-blue-700",
  checking_in: "border-emerald-300 text-emerald-700",
  moving: "border-violet-300 text-violet-700",
};
const APPLIES_LABELS: Record<string, string> = { CHECK_IN: "recolhas", CHECK_OUT: "entregas", BOTH: "recolhas e entregas" };
const eur = (n: number | null) => (n == null ? "" : `${n.toFixed(2).replace(".", ",")} €`);
const place = (c: { garage: string | null; spot: string | null }) => [c.garage, c.spot].filter(Boolean).join(" · ");

function Section({ title, count, tone, open, children }: { title: string; count: number; tone?: "warn" | "bad"; open?: boolean; children?: React.ReactNode }) {
  const badgeCls = count === 0 ? "" : tone === "bad" ? "border-red-300 text-red-700" : tone === "warn" ? "border-amber-300 text-amber-700" : "";
  return (
    <details className="border rounded-lg" open={open}>
      <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer select-none text-sm">
        <span className="font-medium min-w-0">{title}</span>
        <Badge variant="outline" className={`tabular-nums shrink-0 ${badgeCls}`}>{count}</Badge>
      </summary>
      {count > 0 && children && <div className="px-3 pb-3 text-xs space-y-1 max-h-96 overflow-y-auto">{children}</div>}
    </details>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number | string; tone?: "warn" | "bad" }) {
  const cls = tone === "bad" ? "border-red-300 bg-red-50/50 dark:bg-red-950/20" : tone === "warn" ? "border-amber-300 bg-amber-50/50 dark:bg-amber-950/20" : "";
  return (
    <Card className={`p-3 ${cls}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
    </Card>
  );
}

function CarLine({ c }: { c: LiveCar }) {
  return (
    <p>
      <span className="font-mono">{c.plate ?? "sem matrícula"}</span> · {c.code ?? c.id.slice(0, 8)}
      {place(c) ? ` · ${place(c)}` : ""}
      {c.parkName ? <span className="text-muted-foreground"> · {c.parkName}</span> : null}
      {c.checkOut ? ` · saída ${fmtPTDateTime(c.checkOut)}` : ""}
      {c.returnFlight ? ` · ✈ ${c.returnFlight}${c.returnFlightEta ? ` (ETA ${fmtPTTime(c.returnFlightEta)})` : ""}` : ""}
      {c.covered ? " · coberto" : ""}
      {c.overdue ? <span className="text-red-700"> · passou a hora de saída</span> : null}
    </p>
  );
}

function UpcomingLine({ u }: { u: LiveUpcoming }) {
  return (
    <p className={u.done ? "text-muted-foreground line-through" : undefined}>
      {u.at ? fmtPTTime(u.at) : "—"} · <span className="font-mono">{u.plate ?? "sem matrícula"}</span> · {u.clientName ?? "—"}
      {u.flight ? ` · ✈ ${u.flight}${u.flightEta ? ` (ETA ${fmtPTTime(u.flightEta)})` : ""}` : ""}
      {u.parkName ? <span className="text-muted-foreground"> · {u.parkName}</span> : null}
      {place(u) ? ` · ${place(u)}` : ""}
      {u.covered ? " · coberto" : ""}
      {u.kind === "checkout" && (u.toPay ?? 0) > 0 ? <span className="text-amber-700"> · a pagar {eur(u.toPay)}</span> : null}
    </p>
  );
}

export function ShiftHandoverLiveState({ city, citySelect }: { city: HandoverCity; citySelect: React.ReactNode }) {
  const [hours, setHours] = useState(8);
  const q = trpc.shiftHandover.liveState.useQuery({ city, windowHours: hours }, { staleTime: 60_000, refetchOnWindowFocus: false });
  const d = q.data;

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2 flex-wrap">
        {citySelect}
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Próximas</span>
          <Select value={String(hours)} onValueChange={(v) => setHours(parseInt(v, 10))}>
            <SelectTrigger className="w-24 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[4, 8, 12, 24].map((n) => <SelectItem key={n} value={String(n)}>{n} h</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching} title="Atualizar">
          {q.isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </Button>
        {d?.available && <p className="text-[11px] text-muted-foreground pb-2">Lido às {fmtPTTime(d.generatedAt)} da BD da Multipark (só leitura)</p>}
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />A ler a BD da Multipark…</p>
      ) : q.error ? (
        <Card><CardContent className="p-4 text-sm text-red-700">{q.error.message}</CardContent></Card>
      ) : !d ? null : !d.available ? (
        <Card className="border-amber-300 bg-amber-50/60 dark:bg-amber-950/20">
          <CardContent className="p-4 text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-700 shrink-0" />
            <span>{d.reason} O separador "Preencher" continua a funcionar com as cópias do dashboard.</span>
          </CardContent>
        </Card>
      ) : <LiveBody d={d} hours={hours} />}
    </div>
  );
}

function LiveBody({ d, hours }: { d: ShiftState; hours: number }) {
  const checkinsLeft = d.upcoming.checkins.filter((u) => !u.done).length;
  const checkoutsLeft = d.upcoming.checkouts.filter((u) => !u.done).length;
  const inParkOnly = d.inPark.cars.filter((c) => c.phase === "in_park");
  if (!d.parks.length) return <Card><CardContent className="p-6 text-sm text-muted-foreground text-center">Sem parques da Multipark nesta cidade.</CardContent></Card>;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Carros no parque" value={d.inPark.total} />
        <Kpi label="Operações em curso" value={d.inProgress.length} tone={d.inProgress.length ? "warn" : undefined} />
        <Kpi label={`Recolhas / entregas (${hours} h)`} value={`${checkinsLeft} / ${checkoutsLeft}`} />
        <Kpi label="Passou a hora de saída" value={d.inPark.overdue} tone={d.inPark.overdue ? "bad" : undefined} />
        <Kpi label="Caixa por fechar (turno)" value={d.cash.notCashierClosed} tone={d.cash.notCashierClosed ? "bad" : undefined} />
        <Kpi label="Validação de caixa / condutor em falta" value={`${d.cash.notCashValidated} / ${d.cash.notDriverValidated}`} />
        <Kpi label={`Bloqueios ${fmtPTDate(`${d.blocksDay}T12:00:00Z`)}`} value={d.blocks == null ? "—" : d.blocks.length} tone={d.blocks?.length ? "warn" : undefined} />
      </div>

      {(d.inPark.truncated || d.upcoming.truncated || d.cash.truncated) && (
        <p className="text-xs text-amber-700">Algumas listas foram cortadas no limite de linhas.</p>
      )}

      {/* 44b (Jorge, 7 out 2026): por tipo de lugar em vez de por parque — a cidade já está escolhida em cima. */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Carros no parque por tipo de lugar</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {(d.inPark.byType ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Sem carros no parque.</p> : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {d.inPark.byType.map((t) => (
                <div key={t.type} className="border rounded-lg p-2.5">
                  <p className="text-xs text-muted-foreground">{t.label}</p>
                  <p className="text-2xl font-semibold tabular-nums leading-tight">{t.total}</p>
                  {/* 44e (Jorge): as garagens em vez das marcas — para ver o que está mal arrumado (ex.: coberto na PD) */}
                  {(t.byParkGarage ?? []).map((p) => (
                    <p key={p.parkName} className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                      {(t.byParkGarage ?? []).length > 1 && <span className="font-medium text-foreground/70">{p.parkName.replace(/\s*-\s*(Lisboa|Porto|Faro)$/i, "")}: </span>}
                      {p.garages.map((g) => `${g.garage} ${g.count}`).join(" · ")}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Só os carros parados no parque (as operações em curso estão em baixo). O tipo é o do lugar atribuído (n.º de alocação); sem ele, o do produto reservado. Por baixo, em que garagem de cada parque estão: se a garagem não bate com o tipo (ex.: um coberto na PD), está mal arrumado.</p>
          {d.inPark.byPark.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer select-none text-muted-foreground">Ver por parque e garagem</summary>
              <div className="space-y-2 mt-2">
                {d.inPark.byPark.map((p) => (
                  <div key={p.parkId} className="border rounded-lg p-2.5">
                    <p className="text-sm font-medium">{p.parkName} <span className="text-muted-foreground tabular-nums">· {p.total}</span></p>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {p.garages.map((g) => <Badge key={g.garage} variant="outline" className="text-xs">{g.garage}: {g.count}</Badge>)}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Section title="Operações em curso (check-in, movimento, entrega pendente, malas, check-out)" count={d.inProgress.length} tone="warn" open={d.inProgress.length > 0}>
          {d.inProgress.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={`text-[11px] ${PHASE_TONE[c.phase] ?? ""}`}>{PHASE_LABELS[c.phase]}{c.phaseSince ? ` desde ${fmtPTTime(c.phaseSince)}` : ""}</Badge>
              <CarLine c={c} />
            </div>
          ))}
        </Section>
        <Section title={`Próximas entregas (${hours} h)`} count={d.upcoming.checkouts.length}>
          {d.upcoming.checkouts.map((u) => <UpcomingLine key={u.id} u={u} />)}
        </Section>
        <Section title={`Próximas recolhas (${hours} h)`} count={d.upcoming.checkins.length}>
          {d.upcoming.checkins.map((u) => <UpcomingLine key={u.id} u={u} />)}
        </Section>
        {/* 44b: ocorrências saíram da passagem de turno (Jorge: "sou eu que estou a tratar") — estão na página Ocorrências. */}
        <Section title={`Caixa do turno por fechar/validar (desde ${fmtPTTime(d.cashWindow.start)})`} count={d.cash.total} tone="bad">
          {d.cash.list.map((c) => (
            <p key={c.id}>
              {c.at ? fmtPTTime(c.at) : "—"} · <span className="font-mono">{c.plate ?? "sem matrícula"}</span> · {c.code ?? c.id.slice(0, 8)}
              {c.driver ? ` · ${c.driver}` : ""}{c.paymentMethod ? ` · ${c.paymentMethod}` : ""}{c.paid ? ` · pago ${eur(c.paid)}` : ""}
              <span className="text-muted-foreground">
                {!c.cashierClosed ? " · caixa por fechar" : ""}{!c.cashValidated ? " · caixa por validar" : ""}{!c.driverValidated ? " · condutor por validar" : ""}
              </span>
            </p>
          ))}
        </Section>
        <Section title="Carros no parque (lista)" count={inParkOnly.length}>
          {inParkOnly.map((c) => <CarLine key={c.id} c={c} />)}
        </Section>
        <Section title={`Bloqueios e horário — ${fmtPTDate(`${d.blocksDay}T12:00:00Z`)}`} count={(d.blocks?.length ?? 0) + (d.hours?.length ?? 0)} tone={d.blocks?.length ? "warn" : undefined}>
          {(d.blocks ?? []).map((b) => (
            <p key={b.id} className="text-amber-800 dark:text-amber-300">
              ⛔ {b.parkName ?? "Parque"} · {APPLIES_LABELS[b.appliesTo] ?? b.appliesTo}
              {b.startTime || b.endTime ? ` · ${b.startTime ?? "00:00"}–${b.endTime ?? "24:00"}` : " · dia todo"}
              {b.label ? ` · ${b.label}` : ""}
            </p>
          ))}
          {(d.hours ?? []).map((h, i) => <p key={`h${i}`}>🕒 {h.parkName ?? "Parque"} · {h.openTime}–{h.closeTime}</p>)}
        </Section>
        {d.blocks == null && <p className="text-xs text-muted-foreground">Não foi possível ler os bloqueios de disponibilidade.</p>}
      </div>
    </>
  );
}
