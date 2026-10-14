/**
 * Passagem de turno → Resumo do dia (Jorge, 12 out 2026):
 *  - `DriverDaySheet`: a linha de "Quem trabalhou" abre o dia dessa pessoa —
 *    recolhas, entregas e movimentos com a reserva (Ficha da reserva), o
 *    tempo pendente→entregue e a velocidade máxima em cada entrega, mais km,
 *    velocidade, excessos e horas do dia;
 *  - `SlowDeliveryDialog`: uma entrega lenta e o que se passava na mesma
 *    cidade nesse horário (pedidos à espera, quem entregou);
 *  - `HandoverShiftCard`: cada turno com a passagem (feita ou não) e, por
 *    chefe de turno, o que a equipa fez a tempo e atrasado.
 * Regras em shared/shiftDayReview.ts; leituras em server/shiftDayDetail.ts.
 */
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { retryTransient } from "@/lib/queryRetry";
import { fmtPTTime } from "@/lib/lisbonTime";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fmtHours } from "@shared/dayWorkSummary";
import { HANDOVER_CITY_LABELS, type HandoverCity, type HandoverShift } from "@shared/shiftHandover";
import { COMPLIANCE_LABELS, type ComplianceStatus } from "@shared/shiftHandoverAuto";
import { DELIVERY_LATE_MIN, DELIVERY_VERY_LATE_MIN, PICKUP_LATE_MIN, deliveryBand, type TeamLine } from "@shared/shiftDayReview";

const CITY_LABELS: Record<string, string> = HANDOVER_CITY_LABELS;
const CHANGE_LABEL: Record<string, string> = { CHECK_IN: "Recolha", CHECK_OUT: "Entrega", MOVEMENT: "Movimento", SPOT_CHANGE: "Mudança de lugar" };
const BAND_TONE: Record<string, string> = { ok: "text-emerald-700", late: "text-amber-700 font-semibold", very_late: "text-red-700 font-semibold" };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Link para a Ficha da reserva (aceita o n.º ou o id da Multipark). */
function BookingLink({ code, id }: { code: string | null | undefined; id: string }) {
  return (
    <Link href={`/reserva/${encodeURIComponent(code || id)}`} className="font-mono text-primary underline" onClick={(e) => e.stopPropagation()}>
      {code || `${id.slice(0, 10)}…`}
    </Link>
  );
}

// ─── O dia de um condutor ────────────────────────────────────────────────────

export interface DriverRow {
  key: string; name: string; kind: string; employeeId: number | null; isTeamLeader?: boolean;
  checkins: number; checkouts: number; movements: number; totalActions: number;
  totalKm: number | null; maxSpeed: number | null; violations: number; provisionalKm?: boolean;
  workedH: number | null; workedSrc: "ponto" | "zello" | null;
  stoppedH: number | null; stoppedSrc: "ponto" | "escala" | "dia" | null;
}

function Stat({ label, value, tone, sub }: { label: string; value: React.ReactNode; tone?: string; sub?: React.ReactNode }) {
  return (
    <div className="rounded-md border p-2 min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-base font-semibold tabular-nums truncate ${tone ?? ""}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground leading-snug">{sub}</p>}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { ponto: "picagens", escala: "escala" };

/** Gaveta com o dia de UMA pessoa do Resumo (o mesmo padrão da Atividade diária). */
export function DriverDaySheet({ date, city, person, onClose, onOpenEmployee }: {
  date: string; city: HandoverCity; person: DriverRow; onClose: () => void;
  onOpenEmployee: (employeeId: number) => void;
}) {
  const noActions = person.kind === "sem_login";
  const q = trpc.shiftHandover.driverDay.useQuery({ date, city, key: person.key }, { enabled: !noActions, retry: retryTransient, refetchOnWindowFocus: false, staleTime: 5 * 60_000 });
  const d = q.data;
  const gps = d?.gps ?? null;
  const shiftLabel = (d?.shifts ?? []).map((s) => `${s.shift === "morning" ? "☀️ Manhã" : "🌙 Noite"} ${String(s.startHour % 24).padStart(2, "0")}h–${String(s.endHour % 24).padStart(2, "0")}h${s.isTeamLeader ? " (TL)" : ""}`).join(" · ");
  const deliveries = (d?.actions ?? []).filter((a) => a.changeType === "CHECK_OUT");
  const measured = deliveries.filter((a) => a.mins != null);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {person.employeeId != null ? (
              <button type="button" className="text-primary hover:underline text-left" title="Abrir a ficha no RH" onClick={() => onOpenEmployee(person.employeeId!)}>{person.name}</button>
            ) : person.name}
            {person.isTeamLeader && <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-[11px] px-1.5 py-0">TL</Badge>}
          </SheetTitle>
          <SheetDescription>{date.split("-").reverse().join("/")}{shiftLabel ? ` · ${shiftLabel}` : ""} — o que fez neste dia, com a reserva de cada ação.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Stat label="Km do dia" value={person.totalKm != null && person.totalKm > 0 ? `${person.totalKm} km` : "—"} sub={person.provisionalKm ? "provisório (ponto)" : undefined} />
            <Stat label="Vel. máx. do dia" value={person.maxSpeed != null && person.maxSpeed > 0 ? `${Math.round(person.maxSpeed)} km/h` : "—"} />
            <Stat label="Excessos" value={person.violations || 0} tone={person.violations > 0 ? "text-red-700" : undefined} />
            <Stat label="Horas trabalhadas" value={<>{fmtHours(person.workedH)}{person.workedSrc === "zello" ? <span className="text-muted-foreground"> ~</span> : null}</>} sub={person.workedSrc === "ponto" ? "do ponto" : person.workedSrc === "zello" ? "sem picagens: Zello ligado" : undefined} />
            <Stat label="Horas paradas" value={<>{fmtHours(person.stoppedH)}{person.stoppedSrc === "dia" ? <span className="text-muted-foreground"> ~</span> : null}</>}
              sub={person.stoppedSrc === "dia" ? "dia inteiro (sem turno)" : person.stoppedSrc ? `no turno (${SOURCE_LABEL[person.stoppedSrc]})` : undefined} />
            <Stat label="Recolhas · entregas · movs" value={`${person.checkins || 0} · ${person.checkouts || 0} · ${person.movements || 0}`}
              sub={measured.length ? `${measured.filter((a) => a.mins! > DELIVERY_LATE_MIN).length} de ${measured.length} entregas >${DELIVERY_LATE_MIN} min` : undefined} />
          </div>
          {gps && gps.windows.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Turno considerado ({SOURCE_LABEL[gps.source ?? ""] ?? "—"}): {gps.windows.map((w) => `${fmtPTTime(w.start)}–${fmtPTTime(w.end)}`).join(", ")}
              {gps.movingHours != null && ` · em movimento ${fmtHours(gps.movingHours)}`}
              {gps.maxSpeed != null && ` · máx. no turno ${gps.maxSpeed} km/h`}
              {gps.partial && <span className="text-amber-700"> · GPS incompleto (algum ficheiro por ler ou dia ainda por recolher)</span>}
            </p>
          )}
          {noActions ? (
            <p className="text-sm text-muted-foreground">PDA sem ninguém com login: não há ações na Multipark para mostrar. O trajeto e as velocidades estão em Actividade Diária → Histórico Diário.</p>
          ) : q.error && !d ? (
            <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o dia desta pessoa" />
          ) : q.isLoading || !d ? (
            <p className="text-sm text-muted-foreground">A carregar…</p>
          ) : (
            <section>
              <h3 className="text-sm font-semibold mb-1">Recolhas, entregas e movimentos ({d.actions.length})</h3>
              {d.truncated && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-1">Dia com movimentos a mais para ler de uma vez: a lista pode estar incompleta.</p>}
              {d.actions.length === 0 ? <p className="text-xs text-muted-foreground">Sem recolhas, entregas nem movimentos neste dia.</p> : (
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-xs min-w-[34rem]">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="p-1">Hora</th><th className="p-1">Ação</th><th className="p-1">Reserva</th><th className="p-1">Matrícula</th><th className="p-1">Parque</th>
                        <th className="p-1 text-right" title="Entregas: do pedido (pendente) à entrega. Recolhas: face à entrada prevista.">Tempo</th>
                        <th className="p-1 text-right" title="Velocidade máxima do GPS dele entre o pedido (ou, sem pedido, quando pegou no carro) e a entrega">Vel. máx.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.actions.map((a, i) => {
                        const band = deliveryBand(a.mins);
                        const overLimit = a.maxSpeed != null && gps?.threshold != null && a.maxSpeed > gps.threshold;
                        return (
                          <tr key={`${a.booking}-${a.at}-${i}`} className="border-b align-top">
                            <td className="p-1 tabular-nums">{fmtPTTime(a.at)}</td>
                            <td className="p-1">{CHANGE_LABEL[a.changeType] ?? a.changeType}</td>
                            <td className="p-1"><BookingLink code={a.bookingCode} id={a.booking} /></td>
                            <td className="p-1 font-mono">{a.plate ?? ""}</td>
                            <td className="p-1 text-muted-foreground">{a.parkName ?? ""}</td>
                            <td className="p-1 text-right tabular-nums">
                              {a.changeType === "CHECK_OUT" ? (
                                a.mins != null
                                  ? <span className={band ? BAND_TONE[band] : ""} title={`Pedido às ${fmtPTTime(a.pendingAt)}${a.takenAt ? ` · pegou às ${fmtPTTime(a.takenAt)}` : ""}`}>{a.mins} min</span>
                                  : <span className="text-muted-foreground" title="Sem pedido (pendente) registado antes desta entrega">sem pedido</span>
                              ) : a.changeType === "CHECK_IN" && a.delayMins != null ? (
                                <span className={a.delayMins > PICKUP_LATE_MIN ? "text-amber-700 font-semibold" : "text-muted-foreground"} title={`Prevista às ${fmtPTTime(a.plannedIn)}`}>{a.delayMins > 0 ? "+" : ""}{a.delayMins} min</span>
                              ) : ""}
                            </td>
                            <td className={`p-1 text-right tabular-nums ${overLimit ? "text-red-700 font-semibold" : ""}`}>
                              {a.changeType === "CHECK_OUT" ? (a.maxSpeed != null ? `${a.maxSpeed} km/h` : <span className="text-muted-foreground">—</span>) : ""}
                              {a.violations ? <span className="block text-[10px]">{plural(a.violations, "excesso", "excessos")}</span> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground mt-1">
                Contam as ações do dia do TURNO (a noite que passa a meia-noite fica no dia em que começou), como na Atividade diária. Tempo da entrega: do pedido (pendente) até entregue — a amarelo acima de {DELIVERY_LATE_MIN} min, a vermelho acima de {DELIVERY_VERY_LATE_MIN}.
                Vel. máx.: o GPS do PDA/telemóvel dele entre o pedido (sem pedido, desde que pegou no carro) e a entrega{gps?.threshold != null ? ` (excesso acima de ${Math.round(gps.threshold)} km/h)` : ""}.
                {gps && !gps.available && " Ainda sem GPS recolhido para este dia (a recolha do próprio dia corre às 23h; a final, dois dias depois)."}
              </p>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Entrega lenta e o que havia no mesmo horário ────────────────────────────

export interface SlowDelivery {
  booking: string; mins: number; agent: string | null; pendingAt: string; deliveredAt: string;
  bookingCode: string | null; plate: string | null; parkName: string | null; city: string | null;
}

export function SlowDeliveryDialog({ date, city, item, onClose }: { date: string; city: HandoverCity; item: SlowDelivery; onClose: () => void }) {
  const q = trpc.shiftHandover.deliveryContext.useQuery(
    { date, city, booking: item.booking, pendingAt: item.pendingAt, deliveredAt: item.deliveredAt },
    { retry: retryTransient, refetchOnWindowFocus: false, staleTime: 10 * 60_000 },
  );
  const c = q.data;
  const t = c?.target;
  const band = deliveryBand(item.mins);
  const sinceReq = (at: string | null | undefined) => (at ? Math.round((Date.parse(`${at.replace(" ", "T")}Z`) - Date.parse(`${item.pendingAt.replace(" ", "T")}Z`)) / 60_000) : null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Entrega lenta <span className={band ? BAND_TONE[band] : ""}>{item.mins} min</span>
          </DialogTitle>
          <DialogDescription>Do pedido (pendente) à entrega, e o que se passava na mesma cidade enquanto esperava.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm min-w-0">
          <section className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Stat label="Reserva" value={<BookingLink code={t?.bookingCode ?? item.bookingCode} id={item.booking} />} />
            <Stat label="Matrícula" value={<span className="font-mono">{t?.plate ?? item.plate ?? "—"}</span>} />
            <Stat label="Parque" value={t?.parkName ?? item.parkName ?? "—"} sub={t?.city ?? item.city ?? undefined} />
            {t?.plannedOut && <Stat label="Saída prevista" value={fmtPTTime(t.plannedOut)} />}
            {t?.status && <Stat label="Estado agora" value={t.status} />}
          </section>
          <section>
            <h3 className="text-sm font-semibold mb-1">Linha do tempo</h3>
            <ol className="space-y-1 text-xs">
              <li><b className="tabular-nums">{fmtPTTime(item.pendingAt)}</b> — pedido (pendente){t?.pendingBy ? ` por ${t.pendingBy}` : ""}</li>
              {t?.takenAt && <li><b className="tabular-nums">{fmtPTTime(t.takenAt)}</b> — {t.takenBy ?? "—"} pegou no carro (a fazer check-out) · +{sinceReq(t.takenAt)} min</li>}
              <li><b className="tabular-nums">{fmtPTTime(item.deliveredAt)}</b> — entregue{(t?.deliveredBy ?? item.agent) ? ` por ${t?.deliveredBy ?? item.agent}` : ""} · <span className={band ? BAND_TONE[band] : ""}>{item.mins} min</span> desde o pedido</li>
            </ol>
          </section>
          {q.error && !c ? (
            <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o que se passava nesse horário" />
          ) : q.isLoading || !c ? (
            <p className="text-xs text-muted-foreground">A ler o histórico da cidade nesse horário…</p>
          ) : !c.found ? (
            <p className="text-xs text-muted-foreground">Esta entrega não aparece no histórico da cidade (fora do teu acesso ou da janela lida).</p>
          ) : (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">O que se passava nesse horário</h3>
              <p className="text-xs">
                Quando ficou pendente já {c.waitingWhenRequested === 1 ? "havia 1 pedido" : `havia ${c.waitingWhenRequested} pedidos`} à espera; no pior momento estavam <b>{c.peakWaiting}</b> à espera ao mesmo tempo (com este).
                {" "}Entre o pedido e a entrega fizeram-se <b>{plural(c.deliveredMeanwhile, "outra entrega", "outras entregas")}</b> na cidade
                {c.byDriver.length > 0 && <>: {c.byDriver.map((b) => `${b.name} ${b.count}`).join(" · ")}</>}.
              </p>
              {c.truncated && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">Movimentos a mais nesse intervalo: a lista pode estar incompleta.</p>}
              {c.others.length === 0 ? <p className="text-xs text-muted-foreground">Nenhum outro pedido à espera na cidade nesse intervalo — a demora não foi por excesso de pedidos.</p> : (
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-xs min-w-[30rem]">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="p-1">Reserva</th><th className="p-1">Pedido</th><th className="p-1">Entregue</th><th className="p-1">Por</th><th className="p-1 text-right">Demorou</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.others.map((o) => {
                        const ob = deliveryBand(o.mins);
                        return (
                          <tr key={`${o.booking}-${o.pendingAt}`} className={`border-b ${o.waitingBefore ? "bg-amber-50/50 dark:bg-amber-950/20" : ""}`}>
                            <td className="p-1"><BookingLink code={o.bookingCode} id={o.booking} />{o.parkName ? <span className="block text-[10px] text-muted-foreground">{o.parkName}</span> : null}</td>
                            <td className="p-1 tabular-nums">{fmtPTTime(o.pendingAt)}{o.waitingBefore && <span className="block text-[10px] text-amber-800">já à espera</span>}</td>
                            <td className="p-1 tabular-nums">{o.deliveredAt ? fmtPTTime(o.deliveredAt) : <span className="text-muted-foreground">por entregar</span>}</td>
                            <td className="p-1">{o.deliveredBy ?? (o.takenBy ? `${o.takenBy} (a sair)` : "—")}</td>
                            <td className={`p-1 text-right tabular-nums ${ob ? BAND_TONE[ob] : ""}`}>{o.mins != null ? `${o.mins} min` : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">Pedidos da mesma cidade feitos antes da entrega desta e ainda por entregar quando esta ficou pendente (a amarelo: os que já estavam à espera). Lido ao vivo da BD da Multipark.</p>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Passagens de turno por chefe de turno ──────────────────────────────────

export interface ComplianceDayRow {
  date: string; shift: HandoverShift; city: string; status: ComplianceStatus; late: boolean;
  ackByName: string | null; authorName: string | null; cashDiff: number | null; reminded: boolean; createdAtMs?: number | null;
}

const COMPLIANCE_TONE: Record<ComplianceStatus, string> = {
  pending: "text-muted-foreground",
  missing: "border-red-300 text-red-700 bg-red-50/60",
  late: "border-amber-300 text-amber-700 bg-amber-50/60",
  on_time: "border-emerald-300 text-emerald-700",
  confirmed: "border-emerald-400 text-emerald-800 bg-emerald-50/60",
};

/** "12 entregas — 9 a tempo · 3 atrasadas (>15) · 1 >30 · 2 sem medida". */
function TallyLine({ label, count, onTime, late, veryLate, unmeasured, lateLabel }: {
  label: string; count: number; onTime: number; late: number; veryLate?: number; unmeasured: number; lateLabel: string;
}) {
  if (!count) return <p className="text-muted-foreground">{label}: 0</p>;
  return (
    <p>
      {label}: <b className="tabular-nums">{count}</b>
      {" — "}<span className="text-emerald-700 tabular-nums">{onTime} a tempo</span>
      {" · "}<span className={late > 0 ? "text-amber-700 font-semibold tabular-nums" : "text-muted-foreground tabular-nums"}>{late} {late === 1 ? "atrasada" : "atrasadas"} ({lateLabel})</span>
      {veryLate != null && veryLate > 0 && <>{" · "}<span className="text-red-700 font-semibold tabular-nums">{veryLate} &gt;{DELIVERY_VERY_LATE_MIN} min</span></>}
      {unmeasured > 0 && <span className="text-muted-foreground"> · {unmeasured} sem medida</span>}
    </p>
  );
}

/** Um turno: a passagem (feita ou não) e, por chefe de turno, a equipa a tempo e atrasada. */
export function HandoverShiftCard({ row, teams }: { row: ComplianceDayRow; teams: TeamLine[] }) {
  const done = row.status === "on_time" || row.status === "late" || row.status === "confirmed";
  return (
    <div className="border rounded-lg px-3 py-2 text-xs space-y-1.5 min-w-0 w-full sm:w-auto sm:min-w-[18rem] sm:flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{row.shift === "morning" ? "☀️ Manhã" : "🌙 Noite"} · {CITY_LABELS[row.city] ?? row.city}</p>
        <Badge variant="outline" className={COMPLIANCE_TONE[row.status]}>{COMPLIANCE_LABELS[row.status]}{row.status === "confirmed" && row.late ? " · entregue atrasada" : ""}</Badge>
      </div>
      {done ? (
        <p className={row.late ? "text-amber-700" : "text-emerald-800"}>
          Passagem feita{row.createdAtMs ? ` às ${fmtPTTime(row.createdAtMs)}` : ""}{row.authorName ? ` por ${row.authorName}` : ""}{row.late ? " (atrasada)" : ""}
          {row.ackByName ? <span className="text-muted-foreground"> · recebida por {row.ackByName}</span> : null}
        </p>
      ) : row.status === "missing" ? (
        <p className="text-red-700 font-semibold">Sem passagem de turno</p>
      ) : (
        <p className="text-muted-foreground">Turno a decorrer — ainda sem passagem</p>
      )}
      {row.cashDiff != null && <p className={row.cashDiff < 0 ? "text-red-700" : "text-amber-700"}>Caixa vs passagem anterior: {row.cashDiff > 0 ? "+" : ""}{row.cashDiff.toFixed(2).replace(".", ",")} €</p>}
      {row.reminded && <p className="text-muted-foreground">lembrete enviado</p>}
      {teams.length === 0 ? (
        <p className="text-muted-foreground">Sem chefe de turno na escala.</p>
      ) : teams.map((t, i) => (
        <div key={`${t.tl?.employeeId ?? t.tl?.name ?? "sem"}-${i}`} className="border-t pt-1.5 space-y-0.5">
          <p className="font-medium">
            {t.tl ? <>Chefe de turno: {t.tl.name}</> : <span className="text-muted-foreground">Sem chefe de turno na escala</span>}
            <span className="font-normal text-muted-foreground"> · equipa de {plural(t.members.length, "pessoa", "pessoas")}</span>
          </p>
          <TallyLine label="Entregas" count={t.deliveries.count} onTime={t.deliveries.onTime} late={t.deliveries.over15} veryLate={t.deliveries.over30}
            unmeasured={t.deliveries.count - t.deliveries.measured} lateLabel={`>${DELIVERY_LATE_MIN} min`} />
          <TallyLine label="Recolhas" count={t.pickups.count} onTime={t.pickups.onTime} late={t.pickups.late}
            unmeasured={t.pickups.count - t.pickups.measured} lateLabel={`>${PICKUP_LATE_MIN} min`} />
          {t.tl && (t.tlOwn.deliveries > 0 || t.tlOwn.pickups > 0) && (
            <p className="text-muted-foreground">O próprio TL: {plural(t.tlOwn.deliveries, "entrega", "entregas")} · {plural(t.tlOwn.pickups, "recolha", "recolhas")} (fora da conta da equipa)</p>
          )}
        </div>
      ))}
    </div>
  );
}
