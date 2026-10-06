/**
 * Financeiro → Caixa → Por dia (29d, Jorge 6 out 2026): a caixa de cada dia
 * por cidade, só nos parques que operamos — recebido por método, despesas do
 * turno (Passagem de turno), esperado vs contado, quem entregou o dinheiro e
 * quem fechou a caixa, e a correção do dia ("dia certo / não certo" com motivo).
 * 30a: o dia da caixa vai das 03:00 às 03:00 do dia seguinte (fim do turno da noite).
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { addDays } from "@shared/lisbonDay";
import { CASH_DAY_CLOSE_HOUR, lastClosedCashDay } from "@shared/cashDayWindow";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Loader2 } from "lucide-react";

const eur = (v: number | null | undefined) => (v == null ? "—" : new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v));

export default function CashDayBoard({ projectId }: { projectId?: number }) {
  const { user } = useAuth();
  const canEdit = can(user as any, "caixa", "edit") || can(user as any, "faturacao", "edit");
  // Por omissão: a última caixa já fechada (30a: a caixa fecha às 03:00 do dia seguinte)
  const [day, setDay] = useState(() => lastClosedCashDay());
  const q = trpc.cashCheck.dayBoard.useQuery({ day, projectId }, { retry: false });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="icon" variant="outline" aria-label="Dia anterior" onClick={() => setDay((d) => addDays(d, -1))}><ChevronLeft className="h-4 w-4" /></Button>
        <Input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9 w-40" aria-label="Dia" />
        <Button size="icon" variant="outline" aria-label="Dia seguinte" onClick={() => setDay((d) => addDays(d, 1))}><ChevronRight className="h-4 w-4" /></Button>
        <p className="text-xs text-muted-foreground">
          Dia da caixa: {q.data?.available ? q.data.window : `${String(CASH_DAY_CLOSE_HOUR).padStart(2, "0")}:00 → ${String(CASH_DAY_CLOSE_HOUR).padStart(2, "0")}:00 do dia seguinte`} (fecha no fim do turno da noite). Só os parques que operamos.
        </p>
        {q.data?.available && !q.data.closed && <Badge variant="outline" className="border-amber-300 text-amber-800">Em curso — fecha {q.data.closesAt}</Badge>}
      </div>
      {q.isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : q.error ? (
        <p role="alert" className="text-sm text-destructive">{q.error.message}</p>
      ) : !q.data?.available ? (
        <p role="status" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />A BD da Multipark não respondeu: {(q.data as any)?.reason ?? ""}. <button className="underline" onClick={() => q.refetch()}>Tentar de novo</button></p>
      ) : q.data.cities.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Sem parques operados no teu âmbito.</Card>
      ) : (
        q.data.cities.map((c) => <CityCard key={c.city} c={c} day={day} canEdit={canEdit} closed={q.data.available && q.data.closed} closesAt={q.data.available ? q.data.closesAt : ""} />)
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CityCard({ c, day, canEdit, closed, closesAt }: { c: any; day: string; canEdit: boolean; closed: boolean; closesAt: string }) {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState("");
  const [showLog, setShowLog] = useState(false);
  const review = trpc.cashCheck.dayReview.useMutation({
    onSuccess: () => { toast.success("Correção do dia gravada"); setReason(""); utils.cashCheck.dayBoard.invalidate(); utils.cashCheck.dayReviewLog.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const log = trpc.cashCheck.dayReviewLog.useQuery({ day, city: c.city }, { enabled: showLog });
  const diff: number | null = c.difference;
  const diffCls = diff == null ? "" : Math.abs(diff) < 0.01 ? "text-emerald-700" : "text-red-700";
  const rv = c.review;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {c.label}
          {rv?.status === "ok" && <Badge className="bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" />Dia certo</Badge>}
          {rv?.status === "not_ok" && <Badge variant="destructive"><CircleAlert className="mr-1 h-3 w-3" />Dia não certo</Badge>}
          {!rv && <Badge variant="outline">{closed ? "Por rever" : "Em curso"}</Badge>}
          {rv && <span className="text-xs font-normal text-muted-foreground">{rv.byName ?? "—"} · {rv.at ?? ""}{rv.reason ? ` — ${rv.reason}` : ""}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Cell label="Recebido em dinheiro" value={eur(c.receivedCash)} />
          <Cell label="Despesas do turno" value={`− ${eur(c.shiftExpenses)}`} hint={`${c.shiftExpensesCount} na Passagem de turno`} />
          {c.countExpenses > 0 && <Cell label="Gastos na contagem" value={`− ${eur(c.countExpenses)}`} hint="escritos à mão na contagem" />}
          <Cell label="Tem de estar em dinheiro" value={eur(c.expectedCash)} strong />
          <Cell label="Contado" value={eur(c.counted)} hint={`${c.countedParks}/${c.parks.length} parques contados`} />
          <Cell label="Diferença" value={diff == null ? "—" : `${diff > 0 ? "+" : ""}${eur(diff)}`} cls={diffCls} />
        </div>

        {c.byMethod.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {c.byMethod.map((m: any) => <span key={m.method} className="rounded border px-2 py-0.5">{m.label}: <b className="tabular-nums">{eur(m.amount)}</b> <span className="text-muted-foreground">({m.count})</span></span>)}
          </div>
        )}

        <div className="flex flex-wrap gap-3 text-xs">
          <span>Fecharam a caixa: <b>{c.closedBy.length ? c.closedBy.join(", ") : "ninguém"}</b></span>
          {c.notClosed > 0 && <span className="text-amber-700">Por fechar: <b>{c.notClosed}</b> reserva(s)</span>}
          {c.notDelivered > 0 && <span className="text-red-700">Dinheiro por entregar ao líder: <b>{c.notDelivered}</b> ({eur(c.notDeliveredPaid)})</span>}
        </div>

        {c.agents.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground">
                <th className="p-1.5">Condutor (saída)</th><th className="p-1.5 text-right">Saídas</th><th className="p-1.5 text-right">Valor</th>
                <th className="p-1.5 text-right">Em dinheiro</th><th className="p-1.5">Entregou ao líder</th><th className="p-1.5">Caixa fechada</th>
              </tr></thead>
              <tbody>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {c.agents.map((a: any) => (
                  <tr key={a.name} className="border-b">
                    <td className="p-1.5 font-medium">{a.name}</td>
                    <td className="p-1.5 text-right tabular-nums">{a.bookings}</td>
                    <td className="p-1.5 text-right tabular-nums">{eur(a.paid)}</td>
                    <td className="p-1.5 text-right tabular-nums">{a.cashBookings ? `${eur(a.cashPaid)} (${a.cashBookings})` : "—"}</td>
                    <td className="p-1.5 text-xs">{a.cashBookings === 0 ? "—" : a.notDelivered === 0 ? <span className="text-emerald-700">entregou</span> : <span className="text-red-700">falta {a.notDelivered} ({eur(a.notDeliveredPaid)})</span>}</td>
                    <td className="p-1.5 text-xs">{a.notClosed === 0 ? <span className="text-emerald-700">fechada{a.closedBy.length ? ` · ${a.closedBy.join(", ")}` : ""}</span> : <span className="text-amber-700">por fechar {a.notClosed}{a.closedBy.length ? ` · já fechou ${a.closedBy.join(", ")}` : ""}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canEdit && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-2">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder={diff != null && Math.abs(diff) >= 0.01 ? "Há diferença: diz o motivo (o que mudou, se está correto ou não…)" : "Motivo / nota (obrigatório se não estiver certo)"} aria-label={`Motivo — ${c.label}`} />
            {!closed && <p className="text-xs text-amber-800">A caixa deste dia só fecha {closesAt} (fim do turno da noite): a correção do dia faz-se depois.</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={review.isPending || !closed} onClick={() => review.mutate({ day, city: c.city, status: "ok", reason: reason || undefined })}><CheckCircle2 className="mr-1 h-4 w-4" />Dia certo</Button>
              <Button size="sm" variant="destructive" disabled={review.isPending || !closed} onClick={() => review.mutate({ day, city: c.city, status: "not_ok", reason: reason || undefined })}><CircleAlert className="mr-1 h-4 w-4" />Dia não certo</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? "Esconder histórico" : "Histórico"}</Button>
            </div>
            {showLog && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {(log.data ?? []).length === 0 ? <li>Sem correções gravadas.</li> : (log.data ?? []).map((l, i) => (
                  <li key={i}>{l.at} · {l.byName ?? "—"} · {l.status === "ok" ? "certo" : "não certo"} · esperado {eur(l.expected)} · contado {eur(l.counted)}{l.reason ? ` — ${l.reason}` : ""}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Cell({ label, value, hint, strong, cls }: { label: string; value: string; hint?: string; strong?: boolean; cls?: string }) {
  return (
    <div className="min-w-0 rounded-md border p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`tabular-nums ${strong ? "text-base font-bold" : "text-sm font-semibold"} ${cls ?? ""}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
