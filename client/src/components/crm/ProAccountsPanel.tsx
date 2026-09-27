/**
 * CRM fase 2 — separador "Pro" da lista de clientes: as contas Pro (da BD da
 * Multipark) com a conta corrente resumida. Em dívida primeiro.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { ExternalLink, Loader2, Search } from "lucide-react";
import { monthLabel } from "@shared/crmPro";
import { ClientAvatar, Pill, eur, num, shortDate, shortDateTime } from "./crmUi";

/** `onShowProFichas`: abre a lista de fichas marcadas Pro (também as sem conta na Multipark). */
export function ProAccountsPanel({ onShowProFichas }: { onShowProFichas?: () => void }) {
  const [, navigate] = useLocation();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [onlyDue, setOnlyDue] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSearch(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const q = trpc.crm.proList.useQuery({ search: search || null, onlyDue }, { placeholderData: (p) => p });
  const rows = q.data?.rows ?? [];
  const totalDue = q.data?.canSeeTotals ? rows.reduce((s, r) => s + (r.summary.due ?? 0), 0) : null;
  const withDue = rows.filter((r) => r.hasDue).length;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-3 rounded-[10px] border bg-card p-3.5">
        <div className="flex h-10 min-w-[260px] flex-1 items-center gap-2 rounded-lg border bg-card px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Procurar conta Pro (nome, email, NIF)…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        </div>
        <label className="flex items-center gap-2 text-[13px]"><Switch checked={onlyDue} onCheckedChange={setOnlyDue} />Só com saldo em dívida</label>
        <div className="text-[13px]">
          <strong>{num(rows.length)} {rows.length === 1 ? "conta" : "contas"}</strong>
          {withDue > 0 && <span className="text-muted-foreground"> · {num(withDue)} com dívida{totalDue != null ? ` (${eur(totalDue, 2)})` : ""}</span>}
        </div>
      </div>

      {q.isLoading && <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
      {q.error && <p className="text-sm text-destructive">{q.error.message}</p>}
      {!q.isLoading && !q.error && rows.length === 0 && (
        <div className="rounded-[10px] border bg-card py-12 text-center text-sm text-muted-foreground">
          {search || onlyDue ? "Nenhuma conta Pro com este filtro." : "Ainda não há contas Pro. São lidas da BD da Multipark de 30 em 30 minutos."}
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-[10px] border bg-card">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead>
              <tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground">
                <th className="px-3.5 py-2.5">Conta</th><th className="px-3 py-2.5">Parques</th>
                <th className="px-3 py-2.5 text-right">Em dívida</th><th className="px-3 py-2.5 text-right">Este mês</th>
                <th className="px-3 py-2.5 text-right">Pago este ano</th><th className="px-3 py-2.5">Último pagamento</th><th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = r.summary;
                const open = () => { if (r.crmClientId) navigate(`/clientes/${r.crmClientId}`); };
                return (
                  <tr key={r.id} onClick={open} className={cn("border-t", r.crmClientId && "cursor-pointer hover:bg-muted/60")}>
                    <td className="px-3.5 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <ClientAvatar name={r.name} photoUrl={r.photoUrl} size={32} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5"><strong className="truncate">{r.name ?? "Sem nome"}</strong>{!r.active && <Pill className="bg-muted text-muted-foreground">desativado</Pill>}</div>
                          <div className="truncate text-xs text-muted-foreground">{[r.email, r.nif ? `NIF ${r.nif}` : null].filter(Boolean).join(" · ")}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{r.parks.map((p) => p.name).filter(Boolean).join(", ") || "—"}</td>
                    <td className="px-3 py-2.5 text-right">
                      {r.hasDue
                        ? <><strong className="text-amber-800 dark:text-amber-200">{eur(s.due, 2)}</strong><div className="text-xs text-muted-foreground">{s.oldestDue ? `desde ${monthLabel(s.oldestDue)}` : ""}</div></>
                        : <Pill className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">em dia</Pill>}
                    </td>
                    <td className="px-3 py-2.5 text-right">{eur(s.currentMonthDebit, 2)}<div className="text-xs text-muted-foreground">{num(s.currentMonthBookings)} {s.currentMonthBookings === 1 ? "reserva" : "reservas"}</div></td>
                    <td className="px-3 py-2.5 text-right">{eur(s.paidThisYear, 2)}</td>
                    <td className="px-3 py-2.5">{s.lastPaidAt ? shortDate(s.lastPaidAt) : "—"}{s.avgPayDays != null && <div className="text-xs text-muted-foreground">paga em média {s.avgPayDays} dias depois do fim do mês</div>}</td>
                    <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <a href={r.multiparkUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-primary hover:underline">Multipark<ExternalLink className="h-3 w-3" /></a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        {onShowProFichas
          ? <button type="button" onClick={onShowProFichas} className="font-semibold text-primary hover:underline">Ver todas as fichas marcadas Pro (também as que não têm conta na Multipark)</button>
          : <span />}
        {q.data?.lastSync && <span>Lido da BD da Multipark · atualizado {shortDateTime(q.data.lastSync)}</span>}
      </div>
    </div>
  );
}
