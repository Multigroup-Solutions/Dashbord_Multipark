import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { fmtPTDate, fmtPTDateTime, fmtPTTime } from "@/lib/lisbonTime";
import type { HandoverCity } from "@shared/shiftHandover";
import { GARAGE_FIT_LABEL, groupMisplaced } from "@shared/garageFit";
import type { LiveCar, LiveUpcoming, ShiftState } from "../../../server/multiparkDb/shiftState";
import { BAGGAGE_WAITING_LABEL, LIVE_PHASE_LABELS, type LivePhase } from "@shared/livePhases";
import { liveTimer, type QueueTone } from "@shared/liveTimers";
import { useNow } from "@/hooks/useNow";

// ─── "Estado do parque (ao vivo)" — separador da Passagem de turno ──────────
// Lido AO VIVO da BD da Multipark (só leitura): carros no parque por
// garagem/lugar, operações em curso, próximas recolhas/entregas (com voo e
// ETA), ocorrências por resolver, caixa por fechar e bloqueios de amanhã.

// Tarefa 62 (P2c): os rótulos vêm de shared/livePhases.ts (fluxo A) — o cliente deixou de ter a sua cópia.
const PHASE_TONE: Partial<Record<LivePhase, string>> = {
  pending_checkout: "border-red-300 text-red-700",
  at_delivery: "border-blue-300 text-blue-700",
  checking_out: "border-blue-300 text-blue-700",
  checking_in: "border-emerald-300 text-emerald-700",
  moving: "border-violet-300 text-violet-700",
};
/** 15 out 2026: só "Na fila" tem a cor da meta (âmbar a partir da meta, vermelho a partir do dobro). */
const QUEUE_TONE: Record<Exclude<QueueTone, null>, string> = {
  warn: "border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300",
  late: "border-red-400 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300",
};
/** Na fila, ainda dentro da meta: sem cor de alerta (o vermelho de antes era para qualquer pendente). */
const QUEUE_OK = "border-slate-300 text-slate-700 dark:text-slate-300";
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
      {c.covered ? " · toldo" : ""}
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
      {u.covered ? " · toldo" : ""}
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

function LiveBody({ d, hours }: { d: ShiftState & { targetMinutes?: number }; hours: number }) {
  // 15 out 2026: cronómetros ("Na fila há 12 min", "Em entrega há 25 min", "Em recolha há 8 min"), a cada 30 s
  const now = useNow(30_000);
  const target = d.targetMinutes ?? 15;
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
                  {(t.misplaced > 0 || t.warned > 0) && (
                    <p className="flex items-center gap-1 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
                      <AlertTriangle className="h-3 w-3" />{t.misplaced > 0 ? `${t.misplaced} mal arrumado${t.misplaced > 1 ? "s" : ""}` : ""}{t.misplaced > 0 && t.warned > 0 ? " · " : ""}{t.warned > 0 ? <span className="text-amber-700 dark:text-amber-300">{t.warned} a passar p/ coberta</span> : null}
                    </p>
                  )}
                  {/* 44e (Jorge): as garagens em vez das marcas; a vermelho as que não servem para este tipo (shared/garageFit.ts) */}
                  {(t.byParkGarage ?? []).map((p) => (
                    <p key={p.parkName} className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                      {(t.byParkGarage ?? []).length > 1 && <span className="font-medium text-foreground/70">{p.parkName.replace(/\s*-\s*(Lisboa|Porto|Faro)$/i, "")}: </span>}
                      {p.garages.map((g, i) => (
                        <span key={g.garage}>
                          {i > 0 && " · "}
                          <span className={g.fit === "bad" ? "font-semibold text-rose-700 dark:text-rose-300" : g.fit === "warn" ? "font-semibold text-amber-700 dark:text-amber-300" : undefined}
                            title={g.fit === "bad" || g.fit === "warn" ? GARAGE_FIT_LABEL[g.fit] : undefined}>
                            {g.fit === "bad" ? "⚠ " : ""}{g.garage} {g.count}
                          </span>
                        </span>
                      ))}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Só os carros parados no parque (as operações em curso estão em baixo). O tipo é o do lugar atribuído (n.º de alocação); sem ele, o do produto reservado. Por baixo, em que garagem de cada parque estão. A vermelho (⚠) o que está mal arrumado: indoor fora de uma garagem coberta, ou descoberto numa coberta (COBERTO, CENTRAL COBERTO). A amarelo, toldos numa garagem descoberta (PD, PD FORA, CENTRAL): passam para a coberta se der.</p>
          <MisplacedCars cars={d.inPark.cars} />
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
        <Section title="Operações em curso (em recolha, em movimento, na fila, em entrega)" count={d.inProgress.length} tone="warn" open={d.inProgress.length > 0}>
          {d.inProgress.length > 0 && <p className="text-[11px] text-muted-foreground">"Na fila há X" fica a âmbar a partir de {target} min (a meta do nosso tempo) e a vermelho a partir de {2 * target}. "Em entrega" não tem cor: inclui a espera pelo cliente no terminal.</p>}
          {d.inProgress.map((c) => {
            const t = liveTimer(c.phase, c.phaseSince, now, target);
            return (
            <div key={c.id} className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={`text-[11px] tabular-nums ${t?.tone ? QUEUE_TONE[t.tone] : t && c.phase === "pending_checkout" ? QUEUE_OK : PHASE_TONE[c.phase] ?? ""}`} title={`${LIVE_PHASE_LABELS[c.phase]}${c.phaseSince ? ` desde ${fmtPTTime(c.phaseSince)}` : ""}`}>
                {t ? t.text : LIVE_PHASE_LABELS[c.phase]}{c.phaseSince ? <span className="opacity-70"> · {fmtPTTime(c.phaseSince)}</span> : null}
              </Badge>
              {c.baggageWaiting && <Badge variant="outline" className="text-[11px] border-amber-300 text-amber-700">{BAGGAGE_WAITING_LABEL}</Badge>}
              <CarLine c={c} />
            </div>
            );
          })}
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

/**
 * Mal arrumados, resumidos por tipo (Jorge, 14 out 2026): uma linha por tipo de
 * lugar × garagem com a contagem ("Descoberto em COBERTO · 11 carros"); clicar
 * abre os carros dessa linha (matrícula, lugar, parque). Vermelho só para o mal
 * arrumado, amarelo para o "se der, coberta". Agrupamento em shared/garageFit.ts.
 */
function MisplacedCars({ cars }: { cars: LiveCar[] }) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const groups = groupMisplaced(cars);
  if (!groups.length) return null;
  const bad = groups.filter((g) => g.fit === "bad").reduce((s, g) => s + g.items.length, 0);
  const warn = groups.filter((g) => g.fit === "warn").reduce((s, g) => s + g.items.length, 0);
  const toggle = (k: string) => setOpenKeys((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const carros = (n: number) => `${n} carro${n === 1 ? "" : "s"}`;
  return (
    <section className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-card p-3 space-y-2">
      <h4 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-secondary-foreground dark:text-slate-100">
        <span>Mal arrumados: <span className={bad ? "text-rose-700 dark:text-rose-300 tabular-nums" : "tabular-nums"}>{bad}</span></span>
        {warn > 0 && <span className="text-xs font-medium text-amber-700 dark:text-amber-300 tabular-nums">· {warn} toldo{warn === 1 ? "" : "s"} numa descoberta</span>}
      </h4>
      <ul className="space-y-1.5">
        {groups.map((g) => {
          const open = openKeys.has(g.key);
          const isBad = g.fit === "bad";
          return (
            <li key={g.key}>
              <button
                type="button"
                onClick={() => toggle(g.key)}
                aria-expanded={open}
                className={`w-full flex items-center gap-2 rounded-[10px] border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${isBad ? "border-rose-200 bg-rose-50/60 hover:bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/20" : "border-amber-200 bg-amber-50/60 hover:bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/20"}`}
              >
                <ChevronRight className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-90" : ""}`} />
                {isBad
                  ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" aria-label="mal arrumado" />
                  : <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden />}
                <span className="min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-slate-100">{g.label}</span>
                <span className={`shrink-0 tabular-nums text-xs font-semibold ${isBad ? "text-rose-700 dark:text-rose-300" : "text-amber-700 dark:text-amber-300"}`}>{carros(g.items.length)}</span>
              </button>
              {open && (
                <ul className="mt-1 ml-3 border-l border-slate-200 dark:border-slate-700 pl-3 py-1 space-y-1 text-xs max-h-72 overflow-y-auto">
                  {g.items.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-semibold text-slate-800 dark:text-slate-100">{c.plate ?? c.code ?? "—"}</span>
                      <span className="text-muted-foreground">{c.spot ? `lugar ${c.spot}` : "sem lugar"}{c.parkName ? ` · ${c.parkName}` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
