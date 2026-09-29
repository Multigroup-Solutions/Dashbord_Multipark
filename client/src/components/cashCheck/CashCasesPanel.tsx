import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, ExternalLink, Loader2, ShieldAlert } from "lucide-react";
import { SEVERITY_LABEL, SEVERITY_TONE } from "./BookingCashCheck";

/**
 * Faturação → Correção de caixa → "Casos": a fila que a varredura automática
 * (cash-sweep, de 10 em 10 min) enche. Cada caso = reserva (ou contagem,
 * agente, parque) × regra. Fecha-se com motivo e explicação obrigatória; a
 * varredura resolve sozinha o que a Multipark deixou de ter e reabre o que volta.
 */

export const STATE_LABEL: Record<string, string> = {
  aberto: "aberto", em_analise: "em análise", justificado: "justificado", perda_aceite: "perda aceite",
  corrigido_na_multipark: "corrigido na Multipark", resolvido_sozinho: "resolvido sozinho",
};
const STATE_TONE: Record<string, string> = {
  aberto: "bg-red-100 text-red-800", em_analise: "bg-amber-100 text-amber-800", justificado: "bg-emerald-100 text-emerald-800",
  perda_aceite: "bg-slate-200 text-slate-800", corrigido_na_multipark: "bg-emerald-100 text-emerald-800", resolvido_sozinho: "bg-emerald-50 text-emerald-700",
};
const REASONS: Array<[string, string]> = [
  ["desconto_autorizado", "Desconto autorizado"], ["erro_corrigido", "Erro de introdução corrigido"], ["cortesia", "Cortesia"],
  ["pago_noutro_canal", "Pago noutro canal"], ["parceiro_ou_pro", "Parceiro ou Pro (fatura à parte)"], ["perda", "Perda aceite"], ["outro", "Outro"],
];
const SUBJECT: Record<string, string> = { booking: "Reserva", count: "Contagem", agent: "Agente", park: "Parque", mb_dia: "Multibanco do dia", mensal: "Recebimento mensal" };
const show = (v: unknown) => (v == null || v === "" ? "—" : String(v));
const eur = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" }));

function initialCase(): number | null {
  try { const v = Number(new URLSearchParams(window.location.search).get("case")); return Number.isInteger(v) && v > 0 ? v : null; } catch { return null; }
}

export default function CashCasesPanel({ projectId }: { projectId?: number }) {
  const [view, setView] = useState<"abertos" | "fechados" | "todos">("abertos");
  const [severity, setSeverity] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<number | null>(initialCase());
  const scope = projectId !== undefined ? { projectId } : {};
  const q = trpc.cashCheck.cases.useQuery({ view, ...(severity !== "all" ? { severity: severity as any } : {}), offset, limit: 50, ...scope }, { placeholderData: (p) => p, retry: false });
  useEffect(() => setOffset(0), [view, severity]);
  const d = q.data;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-primary" /> Casos da varredura automática
          {d && (
            <span className="flex flex-wrap gap-1 text-xs font-normal">
              {(["critical", "high", "medium"] as const).map((s) => d.openBySeverity[s] ? <Badge key={s} className={SEVERITY_TONE[s]}>{d.openBySeverity[s]} {SEVERITY_LABEL[s]}</Badge> : null)}
              {!Object.keys(d.openBySeverity).length && <Badge variant="outline">nenhum caso aberto</Badge>}
            </span>
          )}
          {q.isFetching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </CardTitle>
        <p className="text-xs text-muted-foreground">A varredura corre de 10 em 10 minutos nos nossos parques e todas as manhãs para as saídas de ontem e anteontem. Carrega num caso para ver o era/é, quem mexeu no dinheiro e fechá-lo com explicação.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Select value={view} onValueChange={(v) => setView(v as any)}>
            <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="abertos">Por explicar</SelectItem>
              <SelectItem value="fechados">Fechados / resolvidos</SelectItem>
              <SelectItem value="todos">Todos</SelectItem>
            </SelectContent>
          </Select>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as gravidades</SelectItem>
              <SelectItem value="critical">Críticas</SelectItem>
              <SelectItem value="high">Altas</SelectItem>
              <SelectItem value="medium">Médias</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {q.error && <p className="text-sm text-red-600">{q.error.message}</p>}
        {d && d.rows.length === 0 && <p className="text-sm text-muted-foreground">Sem casos {view === "abertos" ? "por explicar" : ""}.</p>}
        {d && d.rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-1 pr-2 font-medium">Gravidade</th><th className="py-1 pr-2 font-medium">Caso</th><th className="py-1 pr-2 font-medium">Sobre</th>
                  <th className="py-1 pr-2 font-medium">Parque · dia</th><th className="py-1 pr-2 font-medium">Estado</th><th className="py-1 font-medium">Visto</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 cursor-pointer hover:bg-muted/50" onClick={() => setOpenId(r.id)}>
                    <td className="py-1 pr-2"><Badge className={SEVERITY_TONE[r.severity] ?? ""}>{SEVERITY_LABEL[r.severity] ?? r.severity}</Badge></td>
                    <td className="py-1 pr-2"><div className="font-medium">{r.label}{r.rule ? <span className="text-muted-foreground"> · {r.rule}</span> : null}</div><div className="text-muted-foreground line-clamp-2 max-w-xl">{r.detail}</div></td>
                    <td className="py-1 pr-2 whitespace-nowrap">{SUBJECT[r.subjectType] ?? r.subjectType} {r.subjectType === "booking" ? `#${r.bookingCode ?? r.subjectId}` : ""}</td>
                    <td className="py-1 pr-2 whitespace-nowrap">{show(r.parkName ?? r.parkId)} · {show(r.day)}</td>
                    <td className="py-1 pr-2"><Badge className={STATE_TONE[r.state] ?? ""}>{STATE_LABEL[r.state] ?? r.state}</Badge>{r.reopenCount > 0 && <span className="ml-1 text-amber-700">↺{r.reopenCount}</span>}</td>
                    <td className="py-1 whitespace-nowrap text-muted-foreground">{show(r.lastSeenAt).slice(0, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d && d.total > d.limit && (
          <div className="flex items-center gap-2 text-xs">
            <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - d.limit))}>Anteriores</Button>
            <span>{offset + 1}–{Math.min(offset + d.limit, d.total)} de {d.total}</span>
            <Button size="sm" variant="outline" disabled={offset + d.limit >= d.total} onClick={() => setOffset(offset + d.limit)}>Seguintes</Button>
          </div>
        )}
      </CardContent>
      {openId != null && <CashCaseDialog id={openId} projectId={projectId} onClose={() => setOpenId(null)} />}
    </Card>
  );
}

function CashCaseDialog({ id, projectId, onClose }: { id: number; projectId?: number; onClose: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.cashCheck.caseDetail.useQuery({ id, ...(projectId !== undefined ? { projectId } : {}) }, { retry: false });
  const [reason, setReason] = useState("");
  const [text, setText] = useState("");
  const act = trpc.cashCheck.caseAction.useMutation({
    onSuccess: () => { toast.success("Caso atualizado"); setText(""); setReason(""); utils.cashCheck.cases.invalidate(); q.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const c = q.data;
  const run = (action: "analise" | "fechar" | "reabrir" | "nota") =>
    act.mutate({ id, action, ...(reason ? { reason: reason as any } : {}), ...(text.trim() ? { explanation: text.trim() } : {}), ...(projectId !== undefined ? { projectId } : {}) });
  const open = c && (c.state === "aberto" || c.state === "em_analise");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Caso #{id}{c ? ` — ${c.label}` : ""}</DialogTitle></DialogHeader>
        {q.isLoading && <Loader2 className="h-5 w-5 animate-spin" />}
        {q.error && <p className="text-sm text-red-600">{q.error.message}</p>}
        {c && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={SEVERITY_TONE[c.severity] ?? ""}>{SEVERITY_LABEL[c.severity] ?? c.severity}</Badge>
              <Badge className={STATE_TONE[c.state] ?? ""}>{STATE_LABEL[c.state] ?? c.state}</Badge>
              {c.rule && <Badge variant="outline">{c.rule}</Badge>}
              <span className="text-xs text-muted-foreground">aberto {show(c.openedAt).slice(0, 16)} · visto {show(c.lastSeenAt).slice(0, 16)} UTC</span>
              {c.subjectType === "booking" && (
                <Link href={`/reserva/${encodeURIComponent(c.subjectId)}`} className="ml-auto inline-flex items-center gap-1 text-xs text-primary underline">Ficha da reserva <ExternalLink className="h-3 w-3" /></Link>
              )}
            </div>
            <p className="rounded-md bg-muted/50 p-2">{c.detail}</p>
            {c.explanation && <p className="text-xs"><strong>Explicação ({show(c.closeReason)}, {show(c.closedByName)}):</strong> {c.explanation}</p>}

            {c.booking && (
              <div className="space-y-3">
                {c.booking.flags?.samePerson && (
                  <p className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800"><AlertTriangle className="h-4 w-4" /> <strong>Mesma pessoa (R25):</strong> {c.booking.flags.samePerson} mexeu no preço ou no método e também validou ou fechou a caixa desta reserva.</p>
                )}
                {c.booking.flags?.noTrace && (
                  <p className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800"><AlertTriangle className="h-4 w-4" /> <strong>Sem rasto na Multipark (R9):</strong> o dinheiro mudou e a História da reserva não tem nenhuma alteração de preço ou de método que o explique.</p>
                )}
                {c.booking.liveUnavailable && <p className="text-xs text-amber-700">BD da Multipark: {c.booking.liveUnavailable}</p>}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-muted-foreground border-b"><th className="py-1 pr-2 font-medium">Campo</th><th className="py-1 pr-2 font-medium">1.º retrato</th><th className="py-1 pr-2 font-medium">Último retrato</th><th className="py-1 font-medium">Multipark agora</th></tr></thead>
                    <tbody>
                      {c.booking.rows.map((r) => (
                        <tr key={r.key} className={`border-b last:border-0 ${r.changed ? "bg-red-50 dark:bg-red-950/30" : ""}`}>
                          <td className="py-1 pr-2">{r.label}</td><td className="py-1 pr-2">{show(r.first)}</td><td className="py-1 pr-2">{show(r.last)}</td>
                          <td className={`py-1 ${r.changed ? "font-semibold text-red-700" : ""}`}>{show(r.live)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Quem mexeu no dinheiro (História da Multipark)</div>
                  {c.booking.historyUnavailable && <p className="text-xs text-amber-700">{c.booking.historyUnavailable}</p>}
                  {!c.booking.history.length && !c.booking.historyUnavailable && <p className="text-xs text-muted-foreground">Nenhuma alteração de dinheiro registada.</p>}
                  <ul className="space-y-1 text-xs">
                    {c.booking.history.map((h, i) => (
                      <li key={i}><strong>{show(h.at).slice(0, 16).replace("T", " ")}</strong> · {show(h.who)} · {h.kindLabel}{h.platform ? ` (${h.platform})` : ""}: {h.changes.map((ch) => `${ch.field} ${show(ch.from)} → ${show(ch.to)}`).join("; ")}</li>
                    ))}
                  </ul>
                </div>
                {c.booking.snapshots.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Retratos da varredura ({c.booking.snapshots.length}) · webhooks guardados: {c.booking.memoryCount}</summary>
                    <ol className="mt-1 space-y-0.5">
                      {c.booking.snapshots.map((s, i) => <li key={i}>{show(s.at).slice(0, 16).replace("T", " ")} · {show(s.status)} · preço {eur(s.bookingPrice)} · linhas {eur(s.linesTotal)} · pago {eur(s.paymentsTotal)} · {show(s.paymentMethod)}{s.cashierClosed ? " · caixa fechada" : ""}</li>)}
                    </ol>
                  </details>
                )}
              </div>
            )}

            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Histórico do caso</div>
              <ul className="space-y-0.5 text-xs">
                {c.events.map((e) => <li key={e.id}>{show(e.at).slice(0, 16)} · <strong>{e.action}</strong>{e.byName ? ` · ${e.byName}` : " · varredura"}{e.note ? ` — ${e.note}` : ""}</li>)}
              </ul>
            </div>

            {c.canManage ? (
              <div className="space-y-2 border-t pt-3">
                {open && (
                  <Select value={reason} onValueChange={setReason}>
                    <SelectTrigger className="h-8 w-64"><SelectValue placeholder="Motivo (para fechar)" /></SelectTrigger>
                    <SelectContent>{REASONS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                )}
                <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={open ? "Explicação (obrigatória para fechar) ou nota" : "Nota ou motivo para reabrir"} rows={3} />
                <div className="flex flex-wrap gap-2">
                  {c.state === "aberto" && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => run("analise")}>Em análise (vou corrigir na Multipark)</Button>}
                  {open && <Button size="sm" disabled={act.isPending || !reason || text.trim().length < 10} onClick={() => run("fechar")}>Fechar com explicação</Button>}
                  {!open && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => run("reabrir")}>Reabrir</Button>}
                  <Button size="sm" variant="ghost" disabled={act.isPending || text.trim().length < 2} onClick={() => run("nota")}>Só juntar nota</Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground border-t pt-3">Só quem confere a caixa (Faturação → gerir) pode mudar o estado.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
