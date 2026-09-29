import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calculator, Loader2, Plus, Trash2 } from "lucide-react";

/**
 * Faturação → Correção de caixa → "Contagem" (R24): por parque e dia,
 * recebido em dinheiro (Multipark ao vivo) − gastos pagos da caixa = esperado;
 * o back office grava o valor contado. Diferença → caso crítico "Contagem ≠
 * esperado". Cada gravação fica no registo (quem, quando, quanto).
 */

const eur = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" }));
function lisbonToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export default function CashCountPanel({ projectId }: { projectId?: number }) {
  const scope = projectId !== undefined ? { projectId } : {};
  const utils = trpc.useUtils();
  const parksQ = trpc.cashCheck.parks.useQuery(projectId !== undefined ? { projectId } : undefined, { staleTime: 10 * 60_000, retry: false });
  const parks = useMemo(() => (parksQ.data?.available ? parksQ.data.parks.filter((p) => p.ours) : []), [parksQ.data]);
  const [parkId, setParkId] = useState<string>("");
  const [day, setDay] = useState(lisbonToday());
  useEffect(() => { if (!parkId && parks[0]) setParkId(parks[0].id); }, [parks, parkId]);
  const q = trpc.cashCheck.countDay.useQuery({ parkId, day, ...scope }, { enabled: !!parkId, retry: false });
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Array<{ description: string; amount: string; receipt: string }>>([]);
  useEffect(() => {
    const d = q.data?.available ? q.data : null;
    setCounted(d?.count ? String(d.count.counted) : "");
    setNote(d?.count?.note ?? "");
    setLines(d ? d.expenses.map((e) => ({ description: e.description, amount: String(e.amount), receipt: e.receipt ?? "" })) : []);
  }, [q.data]);
  const save = trpc.cashCheck.saveCount.useMutation({
    onSuccess: (r) => {
      toast[r.caseOpened ? "warning" : "success"](r.caseOpened ? `Gravado. Diferença de ${eur(r.difference)}: abriu um caso crítico.` : `Gravado. Diferença: ${eur(r.difference)}.`);
      utils.cashCheck.countDay.invalidate(); utils.cashCheck.cases.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const d = q.data?.available ? q.data : null;
  const num = (s: string) => Number(String(s).replace(",", "."));
  const expensesTotal = lines.reduce((s, l) => s + (Number.isFinite(num(l.amount)) ? num(l.amount) : 0), 0);
  const expected = d?.received ? d.received.amount - expensesTotal : null;
  const diff = expected != null && counted.trim() !== "" && Number.isFinite(num(counted)) ? num(counted) - expected : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Calculator className="h-4 w-4 text-primary" /> Contagem da caixa</CardTitle>
        <p className="text-xs text-muted-foreground">Recebido em dinheiro no dia (pagamentos registados na Multipark) − gastos pagos da caixa = esperado. Grava o que contaste; se não bater, abre um caso crítico.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Select value={parkId} onValueChange={setParkId}>
            <SelectTrigger className="h-8 w-60"><SelectValue placeholder="Parque" /></SelectTrigger>
            <SelectContent>{parks.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.city ? ` (${p.city})` : ""}</SelectItem>)}</SelectContent>
          </Select>
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="h-8 w-40" />
          {q.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        {q.data && !q.data.available && <p className="text-red-600">{q.data.reason}</p>}
        {q.error && <p className="text-red-600">{q.error.message}</p>}
        {d && (
          <>
            {d.receivedError && <p className="text-amber-700">{d.receivedError}</p>}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md bg-muted/50 p-2"><div className="text-xs text-muted-foreground">Recebido em dinheiro</div><div className="font-semibold">{eur(d.received?.amount)}</div><div className="text-xs text-muted-foreground">{d.received?.count ?? 0} pagamento(s)</div></div>
              <div className="rounded-md bg-muted/50 p-2"><div className="text-xs text-muted-foreground">Gastos pagos da caixa</div><div className="font-semibold">{eur(expensesTotal)}</div></div>
              <div className="rounded-md bg-muted/50 p-2"><div className="text-xs text-muted-foreground">Esperado</div><div className="font-semibold">{eur(expected)}</div></div>
              <div className={`rounded-md p-2 ${diff != null && Math.abs(diff) > 0.01 ? "bg-red-50 text-red-800" : "bg-muted/50"}`}><div className="text-xs text-muted-foreground">Diferença</div><div className="font-semibold">{eur(diff)}</div></div>
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Gastos pagos da caixa neste dia</div>
              {lines.map((l, i) => (
                <div key={i} className="flex flex-wrap gap-2">
                  <Input className="h-8 flex-1 min-w-40" placeholder="Descrição" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                  <Input className="h-8 w-28" placeholder="Valor" inputMode="decimal" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                  <Input className="h-8 w-40" placeholder="N.º recibo (opcional)" value={l.receipt} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, receipt: e.target.value } : x)))} />
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={() => setLines([...lines, { description: "", amount: "", receipt: "" }])}><Plus className="h-4 w-4" /> Gasto</Button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div><div className="text-xs text-muted-foreground">Valor contado</div><Input className="h-8 w-36" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} /></div>
              <Input className="h-8 flex-1 min-w-48" placeholder="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button size="sm" disabled={save.isPending || !parkId || counted.trim() === "" || !Number.isFinite(num(counted)) || lines.some((l) => l.description.trim().length < 2 || !Number.isFinite(num(l.amount)))}
                onClick={() => save.mutate({ parkId, day, counted: num(counted), ...(note.trim() ? { note: note.trim() } : {}), expenses: lines.map((l) => ({ description: l.description.trim(), amount: num(l.amount), ...(l.receipt.trim() ? { receipt: l.receipt.trim() } : {}) })), ...scope })}>
                Gravar contagem
              </Button>
            </div>
            {d.count && <p className="text-xs text-muted-foreground">Última contagem: {eur(d.count.counted)} por {d.count.byName ?? "—"} em {d.count.countedAt} UTC (esperado {eur(d.count.expected)}, diferença {eur(d.count.difference)}).</p>}
            {d.log.length > 1 && (
              <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Gravações ({d.log.length})</summary>
                <ol className="mt-1 space-y-0.5">{d.log.map((l, i) => <li key={i}>{l.at} · {l.byName ?? "—"} · contado {eur(l.counted)} · esperado {eur(l.expected)} · diferença {eur(l.difference)}</li>)}</ol>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
