/**
 * Orçamentos de marketing (Jorge, 24 set 2026): objetivo mensal por cidade ou
 * marca (e fornecedor opcional) e o RITMO — gasto do dia 1 até ONTEM contra o
 * esperado pelos dias completos do mês (hoje está a meio e não conta).
 * Acima de 110 % ou abaixo de 80 % do esperado → alerta no Marketing.
 * Ver: backoffice (âmbito de cidade). Definir: admin.
 */
import { useMemo, useState } from "react";
import { can, roleRank, seesBeyondOwn } from "@shared/access";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Copy, Loader2, Plus, Trash2 } from "lucide-react";

const EUR = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0, minimumFractionDigits: 0 });
const eur = (v: number | null | undefined) => (v == null ? "—" : EUR.format(v));
const PROVIDERS: Array<{ value: "all" | "google_ads" | "meta"; label: string }> = [
  { value: "all", label: "Todos (Google + Meta)" }, { value: "google_ads", label: "Google Ads" }, { value: "meta", label: "Meta" },
];

function lisbonMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}`;
}
const shiftMonth = (m: string, n: number) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
const monthLabel = (m: string) => new Intl.DateTimeFormat("pt-PT", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T12:00:00Z`));

export default function MarketingBudgetsPanel() {
  const { user } = useAuth();
  const isAdmin = can(user?.role, "marketing", "manage");
  const { projectId } = useGlobalFilters();
  const [month, setMonth] = useState(lisbonMonth());
  const utils = trpc.useUtils();
  const { data: rows = [], isLoading } = trpc.marketing.budgets.list.useQuery({ month, projectId });
  const { data: projects = [] } = trpc.projects.list.useQuery();
  const refresh = () => { utils.marketing.budgets.list.invalidate(); utils.marketing.alerts.invalidate(); };
  const upsert = trpc.marketing.budgets.upsert.useMutation({ onSuccess: () => { refresh(); toast.success("Orçamento guardado"); setAmount(""); }, onError: (e) => toast.error(e.message) });
  const remove = trpc.marketing.budgets.remove.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const copy = trpc.marketing.budgets.copyFromPrevious.useMutation({ onSuccess: (r) => { refresh(); toast.success(`${r.copied} orçamento(s) copiado(s) do mês anterior`); }, onError: (e) => toast.error(e.message) });

  const options = useMemo(() => {
    const byId = new Map<number, any>((projects as any[]).map((p) => [p.id, p]));
    return (projects as any[])
      .filter((p) => p.level === "city" || p.level === "brand")
      .map((p) => {
        const parent = p.parentId != null ? byId.get(p.parentId) : null;
        return { id: p.id as number, name: p.level === "brand" && parent ? `${p.name} ${parent.name}` : `${p.name} (cidade)` };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "pt"));
  }, [projects]);
  const [target, setTarget] = useState<string>("");
  const [provider, setProvider] = useState<"all" | "google_ads" | "meta">("all");
  const [amount, setAmount] = useState("");

  const totals = rows.reduce((t, r) => ({ amount: t.amount + r.amount, spent: t.spent + r.spentToDate, expected: t.expected + r.pacing.expected }), { amount: 0, spent: 0, expected: 0 });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground max-w-2xl">
          Gasto até ontem (Google Ads + Meta, a mesma fonte do Dashboard; nacional repartido pelas cidades) contra o esperado pelos dias completos do mês. Hoje não conta — está a meio. Acima de 110 % ou abaixo de 80 % do esperado aparece um alerta.
        </p>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="Mês anterior" onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft className="w-4 h-4" /></Button>
          <span className="text-sm font-medium w-36 text-center capitalize">{monthLabel(month)}</span>
          <Button size="icon" variant="ghost" aria-label="Mês seguinte" onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight className="w-4 h-4" /></Button>
        </div>
      </div>

      {isAdmin && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Definir orçamento mensal</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div>
              <Label className="text-xs">Cidade ou marca</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="h-9 w-64"><SelectValue placeholder="Escolher…" /></SelectTrigger>
                <SelectContent>{options.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Plataforma</Label>
              <Select value={provider} onValueChange={(v) => setProvider(v as any)}>
                <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
                <SelectContent>{PROVIDERS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs" htmlFor="budget-amount">Valor (€ / mês)</Label>
              <Input id="budget-amount" className="h-9 w-32" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </div>
            <Button size="sm" disabled={!target || !(Number(amount.replace(",", ".")) >= 0) || amount.trim() === "" || upsert.isPending}
              onClick={() => upsert.mutate({ month, projectId: Number(target), provider, amount: Number(amount.replace(",", ".")) })}>
              {upsert.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />} Guardar
            </Button>
            <Button size="sm" variant="outline" disabled={copy.isPending} onClick={() => copy.mutate({ month })} title="Copia os objetivos do mês anterior que ainda não existem neste mês">
              <Copy className="w-4 h-4 mr-1" /> Copiar do mês anterior
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6 text-center">Sem orçamentos definidos para {monthLabel(month)}.{isAdmin ? " Define um acima." : ""}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Objetivo</th>
                  <th className="text-right px-4 py-2 font-medium">Orçamento</th>
                  <th className="text-right px-4 py-2 font-medium">Gasto até ontem</th>
                  <th className="text-right px-4 py-2 font-medium">Esperado</th>
                  <th className="text-left px-4 py-2 font-medium w-56">Ritmo</th>
                  <th className="text-right px-4 py-2 font-medium">Projeção do mês</th>
                  {isAdmin && <th className="px-2 py-2" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pct = r.pacing.ratio != null ? Math.round(r.pacing.ratio * 100) : null;
                  const status = r.pacing.status;
                  const badge = status === "over" ? { t: "acima", c: "border-rose-200 bg-rose-50 text-rose-800 dark:bg-rose-950/30 dark:text-rose-200" }
                    : status === "under" ? { t: "abaixo", c: "border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200" }
                    : status === "ok" ? { t: "no ritmo", c: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200" }
                    : { t: "início do mês", c: "text-muted-foreground" };
                  const fill = Math.min(100, r.amount > 0 ? (r.spentToDate / r.amount) * 100 : 0);
                  const mark = Math.min(100, r.amount > 0 ? (r.pacing.expected / r.amount) * 100 : 0);
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-4 py-2 font-medium">{r.label}{r.notes && <div className="text-[11px] text-muted-foreground font-normal">{r.notes}</div>}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{eur(r.amount)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{eur(r.spentToDate)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{eur(r.pacing.expected)}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <div className="relative h-2 flex-1 rounded bg-muted" aria-hidden>
                            <div className="absolute inset-y-0 left-0 rounded bg-primary" style={{ width: `${fill}%` }} />
                            <div className="absolute -top-0.5 h-3 w-0.5 bg-foreground" style={{ left: `${mark}%` }} title="Esperado até ontem" />
                          </div>
                          <Badge variant="outline" className={`text-[10px] ${badge.c}`}>{badge.t}{pct != null ? ` ${pct}%` : ""}</Badge>
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{eur(r.pacing.projected)}</td>
                      {isAdmin && (
                        <td className="px-2 py-2 text-right">
                          <Button size="icon" variant="ghost" aria-label={`Apagar orçamento ${r.label}`} onClick={() => { if (confirm(`Apagar o orçamento de ${r.label}?`)) remove.mutate({ id: r.id }); }}><Trash2 className="w-4 h-4" /></Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
                <tr className="bg-muted/40 font-semibold">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right tabular-nums">{eur(totals.amount)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{eur(totals.spent)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{eur(totals.expected)}</td>
                  <td colSpan={isAdmin ? 3 : 2} className="px-4 py-2 text-xs font-normal text-muted-foreground">Objetivos podem sobrepor-se (cidade e marca dentro dela) — o total é só a soma das linhas.</td>
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
