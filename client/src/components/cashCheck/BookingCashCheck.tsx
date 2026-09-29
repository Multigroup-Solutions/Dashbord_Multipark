import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronRight, Info, Scale } from "lucide-react";

/**
 * Ficha da reserva → "Conferência (era / é)". Só para quem tem a Faturação
 * e os totais financeiros. Compara, A PEDIDO (ao abrir a secção), a memória
 * do webhook (o que a Multipark nos disse, guardado sem nunca ser reescrito)
 * com a BD da Multipark agora, e mostra as alterações de dinheiro da
 * História (quem, quando, antes → depois).
 */

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const show = (v: string | null | undefined) => (v == null || v === "" ? "—" : ISO_RE.test(v) ? fmtPTDateTime(v) : v);
const eur = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" }));

export const SEVERITY_TONE: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-red-100 text-red-800",
  medium: "bg-amber-100 text-amber-800",
};
export const SEVERITY_LABEL: Record<string, string> = { critical: "crítica", high: "alta", medium: "média" };

export default function BookingCashCheck({ id, scope }: { id: string; scope: { projectId?: number } }) {
  const access = trpc.cashCheck.access.useQuery(undefined, { staleTime: 5 * 60_000, retry: false });
  const [open, setOpen] = useState(false);
  const q = trpc.cashCheck.booking.useQuery({ id, ...scope }, { enabled: open && !!access.data?.allowed, staleTime: 30_000, retry: false });
  if (!access.data?.allowed) return null;
  const d = q.data;

  return (
    <Card>
      <CardHeader className="py-3">
        <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
          <CardTitle className="flex items-center gap-2 text-sm"><Scale className="w-4 h-4" /> Conferência (era / é)</CardTitle>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {d && (d.divergences.length ? <Badge className="bg-red-100 text-red-800">{d.divergences.length} divergência(s)</Badge> : <span>sem divergências</span>)}
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 pt-0 text-sm">
          <p className="text-[11px] text-muted-foreground">
            <strong>Era</strong> = o que a Multipark nos mandou pelo webhook (guardado, nunca reescrito). <strong>É</strong> = a BD da Multipark agora.
            Só leitura; compara quando abres esta secção.
          </p>
          {q.isLoading || !d ? <p className="text-xs text-muted-foreground">A comparar…</p> : (
            <>
              {"available" in d.live && d.live.available === false && <Note text={`Multipark indisponível: ${(d.live as any).reason}`} />}
              {d.live.available && !(d.live as any).found && <Note text="A Multipark não devolve esta reserva nas tuas cidades." />}
              {d.memoryError && <Note text={d.memoryError} />}
              {d.memory.length === 0 && !d.memoryError && <Note text="Nunca nos chegou nenhum webhook desta reserva (ou chegou antes de a memória existir, a 28 set 2026): não há “era” para comparar." />}

              {d.divergences.length > 0 && (
                <ul className="space-y-1">
                  {d.divergences.map((x, i) => (
                    <li key={i} className="rounded-md border border-red-200 bg-red-50/60 p-2 text-xs">
                      <Badge className={`${SEVERITY_TONE[x.severity] ?? ""} mr-2`}>{SEVERITY_LABEL[x.severity] ?? x.severity}</Badge>
                      <strong>{x.label}.</strong> {x.detail}
                    </li>
                  ))}
                </ul>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-1 pr-2 font-medium">Campo</th>
                      <th className="py-1 pr-2 font-medium">1.º webhook</th>
                      <th className="py-1 pr-2 font-medium">Último webhook</th>
                      <th className="py-1 font-medium">Multipark agora</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r) => (
                      <tr key={r.key} className={`border-b last:border-0 ${r.changed ? "bg-red-50 dark:bg-red-950/30" : ""}`}>
                        <td className="py-1 pr-2">{r.label}</td>
                        <td className="py-1 pr-2 tabular-nums">{r.notInWebhook ? <span className="text-muted-foreground">não vem no webhook</span> : show(r.first)}</td>
                        <td className="py-1 pr-2 tabular-nums">{r.notInWebhook ? "" : show(r.last)}</td>
                        <td className={`py-1 tabular-nums ${r.changed ? "font-semibold text-red-700 dark:text-red-400" : ""}`}>{show(r.live)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {d.memory.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Webhooks recebidos ({d.memory.length})</summary>
                  <ol className="mt-1 space-y-0.5">
                    {d.memory.map((s) => (
                      <li key={s.id}>
                        {show(s.receivedAt)} · {s.eventType} · {s.status ?? "—"} · {eur(s.bookingPrice)} · {s.paymentMethod ?? "—"}
                      </li>
                    ))}
                  </ol>
                </details>
              )}

              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Alterações de dinheiro na Multipark (História, ao vivo)</div>
                {d.historyUnavailable && <Note text={d.historyUnavailable} />}
                {d.history.length === 0 && !d.historyUnavailable && <p className="text-xs text-muted-foreground">Sem alterações de preço, pagamento, parceiro, pro ou caixa na História (a Multipark só guarda História desde 2 mar 2026).</p>}
                <ol className="space-y-1">
                  {d.history.map((h) => (
                    <li key={h.id} className="rounded-md border p-2 text-xs">
                      <div className="flex flex-wrap gap-2">
                        <span className="font-medium">{show(h.at)}</span>
                        <Badge variant="outline">{h.kindLabel}</Badge>
                        {h.who && <span>{h.who}</span>}
                        {h.platform && <span className="text-muted-foreground">· {h.platform}</span>}
                      </div>
                      <ul className="mt-1">
                        {h.changes.map((c, i) => (
                          <li key={i}><span className="text-muted-foreground">{c.label}</span>: <span className="line-through decoration-slate-400">{show(c.from)}</span> → <span className="font-medium">{show(c.to)}</span></li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function Note({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /> <span>{text}</span>
    </div>
  );
}
