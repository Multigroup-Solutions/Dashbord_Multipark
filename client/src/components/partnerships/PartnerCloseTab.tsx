import { Fragment, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, RefreshCw, Lock, Unlock, ChevronDown, ChevronRight } from "lucide-react";
import { CLOSE_DIFF_LABELS, type CloseDiffCode } from "@shared/partnerClose";

/**
 * Parcerias → Fecho do mês: como uma caixa. Parceiro a parceiro, as saídas do
 * mês na Multipark contra a nossa memória do webhook (reservas, valor, nosso
 * e faturas) e as diferenças reserva a reserva. "Fechar" congela a linha; com
 * diferenças, é preciso escrever porquê.
 */
const eur = (n: number | null | undefined) => n == null ? "—" : new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(n);
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const prevMonth = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mm - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export function PartnerCloseTab() {
  const utils = trpc.useUtils();
  const [month, setMonth] = useState(() => prevMonth(thisMonth()));
  const [open, setOpen] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const list = trpc.partnerships.closeMonthList.useQuery({ month });
  const refresh = trpc.partnerships.closeMonthRefresh.useMutation({
    onSuccess: (r) => {
      if (!r.available) { toast.error(`A Multipark não respondeu: ${r.reason ?? ""}`); return; }
      toast.success(`${r.partners} parceiros comparados · ${r.diffs} diferença(s).`);
      utils.partnerships.closeMonthList.invalidate({ month });
    },
    onError: (e) => toast.error(e.message),
  });
  const close = trpc.partnerships.closeMonthClose.useMutation({
    onSuccess: () => { toast.success("Fechado."); utils.partnerships.closeMonthList.invalidate({ month }); },
    onError: (e) => toast.error(e.message),
  });
  const reopen = trpc.partnerships.closeMonthReopen.useMutation({
    onSuccess: () => { toast.success("Reaberto."); utils.partnerships.closeMonthList.invalidate({ month }); },
    onError: (e) => toast.error(e.message),
  });
  const rows = list.data ?? [];
  const tot = rows.reduce((a, r) => ({
    mpN: a.mpN + r.mp.bookings, cpN: a.cpN + r.copy.bookings, mpV: a.mpV + r.mp.ours, cpV: a.cpV + r.copy.ours, inv: a.inv + r.mp.invoices, d: a.d + r.diffs, closed: a.closed + (r.state === "fechado" ? 1 : 0),
  }), { mpN: 0, cpN: 0, mpV: 0, cpV: 0, inv: 0, d: 0, closed: 0 });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="text-xs block mb-1">Mês (saídas)</label>
          <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-9 w-40" />
        </div>
        <Button size="sm" onClick={() => refresh.mutate({ month })} disabled={refresh.isPending}>
          {refresh.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}Comparar agora
        </Button>
        {rows.length > 0 && (
          <span className="text-xs text-muted-foreground ml-auto">
            {rows.length} parceiros · {tot.closed} fechados · {tot.d} diferença(s){rows[0]?.computedAt ? ` · comparado ${rows[0].computedAt}` : ""}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Reservas de parceiros <strong>concluídas com saída no mês</strong>: a <strong>Multipark</strong> (agora) contra a <strong>nossa memória do webhook</strong> (o último retrato de cada reserva que nos chegou).
        Compara-se o número de reservas, o valor, o <strong>nosso</strong> (devido) e as faturas emitidas; o que não bate aparece reserva a reserva. A comparação corre sozinha todas as manhãs;
        <strong> Fechar</strong> congela o parceiro nesse mês (com diferenças, escreve porquê). A memória do webhook começa a 28/09/2026 19:23: as saídas antes disso não têm nada nosso para comparar.
      </p>
      {list.isLoading ? <p className="text-sm text-muted-foreground text-center py-8">A carregar...</p>
        : rows.length === 0 ? <Card className="p-6 text-center text-sm text-muted-foreground">Sem comparação para {month}. Carrega em <strong>Comparar agora</strong>.</Card>
        : (
          <Card className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="p-2">Parceiro</th>
                    <th className="p-2 text-right">Reservas<br /><span className="normal-case">Multipark / nossa</span></th>
                    <th className="p-2 text-right">Nosso (devido)<br /><span className="normal-case">Multipark / nossa</span></th>
                    <th className="p-2 text-right">Faturas</th>
                    <th className="p-2 text-right">Diferenças</th>
                    <th className="p-2">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const k = r.partnerKey;
                    const isOpen = open === k;
                    const mismatchN = r.mp.bookings - r.beforeMemory !== r.copy.bookings;
                    const mismatchV = Math.abs(r.mp.ours - r.copy.ours) > 0.01 && r.beforeMemory === 0;
                    return (
                      <Fragment key={k}>
                        <tr className="border-b hover:bg-muted/40 cursor-pointer" onClick={() => setOpen(isOpen ? null : k)}>
                          <td className="p-2 font-medium min-w-[12rem] break-words">
                            {isOpen ? <ChevronDown className="inline w-3 h-3 mr-1" /> : <ChevronRight className="inline w-3 h-3 mr-1" />}
                            {r.partnershipName ?? r.partnerName ?? r.partnerKey}
                            {r.partnershipName && r.partnerName && r.partnershipName !== r.partnerName && <span className="block text-[11px] font-normal text-muted-foreground">Multipark: {r.partnerName}</span>}
                            {r.beforeMemory > 0 && <span className="block text-[11px] font-normal text-muted-foreground">{r.beforeMemory} antes da memória do webhook</span>}
                          </td>
                          <td className={`p-2 text-right tabular-nums ${mismatchN ? "text-amber-700 font-medium" : ""}`}>{r.mp.bookings} / {r.copy.bookings}</td>
                          <td className={`p-2 text-right tabular-nums ${mismatchV ? "text-amber-700 font-medium" : ""}`}>{eur(r.mp.ours)} / {eur(r.copy.ours)}
                            {r.mp.noDue > 0 && <span className="block text-[11px] text-amber-700">{r.mp.noDue} sem devido</span>}
                          </td>
                          <td className="p-2 text-right tabular-nums">{r.mp.invoices}{r.mp.noInvoice > 0 && <span className="block text-[11px] text-amber-700">{r.mp.noInvoice} sem fatura</span>}</td>
                          <td className="p-2 text-right tabular-nums">{r.diffs > 0 ? <Badge className="bg-amber-600">{r.diffs}</Badge> : <span className="text-emerald-700">0</span>}</td>
                          <td className="p-2 text-xs">
                            {r.state === "fechado"
                              ? <span className="text-emerald-700"><Lock className="inline w-3 h-3 mr-1" />Fechado {r.closedAt}{r.closedByName ? ` · ${r.closedByName}` : ""}</span>
                              : <span className="text-muted-foreground">Aberto</span>}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b bg-muted/20">
                            <td colSpan={6} className="p-3 space-y-2">
                              <div className="text-xs text-muted-foreground">
                                Valor (o que o parceiro recebeu): Multipark {eur(r.mp.value)} · nossa {eur(r.copy.value)}
                              </div>
                              {r.diffList.length > 0 ? (
                                <div className="max-h-72 overflow-auto">
                                  <table className="w-full text-xs">
                                    <tbody>
                                      {r.diffList.map((d) => (
                                        <tr key={d.bookingId} className="border-t align-top">
                                          <td className="py-1 pr-2 whitespace-nowrap">
                                            <a className="text-primary hover:underline" href={`/reserva/${encodeURIComponent(d.code ?? d.bookingId)}`} onClick={(e) => e.stopPropagation()}>{d.code ?? d.bookingId.slice(0, 10)}</a>
                                          </td>
                                          <td className="py-1 pr-2">{d.codes.map((c) => <Badge key={c} variant="outline" className="mr-1 mb-0.5 text-[10px]">{CLOSE_DIFF_LABELS[c as CloseDiffCode] ?? c}</Badge>)}</td>
                                          <td className="py-1 text-muted-foreground [overflow-wrap:anywhere]">{d.detail}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : <p className="text-xs text-emerald-700">Sem diferenças.</p>}
                              {r.state === "fechado" ? (
                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                  {r.closeNote && <span className="text-muted-foreground">Nota: {r.closeNote}</span>}
                                  <Button size="sm" variant="outline" className="h-7" disabled={reopen.isPending} onClick={() => { if (confirm("Reabrir este parceiro neste mês? Volta a ser comparado.")) reopen.mutate({ month, partnerKey: k }); }}>
                                    <Unlock className="w-3 h-3 mr-1" />Reabrir
                                  </Button>
                                </div>
                              ) : (
                                <div className="flex flex-wrap items-center gap-2">
                                  <Input className="h-8 flex-1 min-w-[14rem] text-xs" placeholder={r.diffs > 0 ? "Porque fechas com diferenças? (obrigatório)" : "Nota (opcional)"}
                                    value={notes[k] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [k]: e.target.value }))} onClick={(e) => e.stopPropagation()} />
                                  <Button size="sm" className="h-8" disabled={close.isPending} onClick={() => close.mutate({ month, partnerKey: k, note: notes[k]?.trim() || null })}>
                                    <Lock className="w-3 h-3 mr-1" />Fechar
                                  </Button>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/50 font-semibold border-t-2">
                    <td className="p-2">TOTAL</td>
                    <td className="p-2 text-right tabular-nums">{tot.mpN} / {tot.cpN}</td>
                    <td className="p-2 text-right tabular-nums">{eur(tot.mpV)} / {eur(tot.cpV)}</td>
                    <td className="p-2 text-right tabular-nums">{tot.inv}</td>
                    <td className="p-2 text-right tabular-nums">{tot.d}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        )}
    </div>
  );
}
