/**
 * Despesas → Anúncios do período (29f, Jorge 6 out 2026: "nas despesas de
 * marketing o que deve lá ficar é o gasto dos anúncios, por projeto; quando
 * entra a fatura, trocamos pelo valor da fatura"). É o que entra como despesa
 * de marketing na Faturação.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Megaphone } from "lucide-react";

const eur = (v: number) => new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);
const PROVIDER: Record<string, string> = { google_ads: "Google Ads", meta: "Meta" };

export function ExpenseAdCostsCard({ startDate, endDate, projectId }: { startDate: string; endDate: string; projectId?: number }) {
  const [open, setOpen] = useState(false);
  const q = trpc.expenses.adCosts.useQuery({ startDate, endDate, projectId }, { enabled: !!startDate && !!endDate && startDate <= endDate, retry: false });
  if (!startDate || !endDate || q.error || !q.data) return null;
  const d = q.data;
  const total = d.totals.platform + d.totals.invoice;
  if (total < 0.01 && d.invoicesWithoutPeriod.length === 0) return null;
  return (
    <Card>
      <CardContent className="py-3 space-y-2">
        <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Megaphone className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium flex-1">Anúncios no período (despesa de marketing na Faturação): <b className="tabular-nums">{eur(total)}</b></span>
          <span className="text-xs text-muted-foreground">faturas {eur(d.totals.invoice)} · gasto das plataformas à espera da fatura {eur(d.totals.platform)}</span>
        </button>
        {d.invoicesWithoutPeriod.length > 0 && (
          <p className="text-xs text-amber-700">{d.invoicesWithoutPeriod.length} fatura(s) do Google/Meta sem período de consumo — não contam. Abre a despesa e indica o período (de/até) para trocar o gasto pela fatura.</p>
        )}
        {open && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="p-1.5">Projeto</th><th className="p-1.5">Plataforma</th><th className="p-1.5 text-right">Fatura</th><th className="p-1.5 text-right">Gasto (à espera da fatura)</th></tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={`${r.projectId}|${r.provider}`} className="border-b last:border-0">
                    <td className="p-1.5">{r.label}</td><td className="p-1.5 text-muted-foreground">{PROVIDER[r.provider] ?? r.provider}</td>
                    <td className="p-1.5 text-right">{r.invoice ? eur(r.invoice) : "—"}</td><td className="p-1.5 text-right">{r.platform ? eur(r.platform) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
