import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { format, startOfMonth, endOfMonth } from "date-fns";

const fmtEur = (v: any) => parseFloat(String(v || 0)).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

// ─── DESPESAS RECORRENTES (modelos) ───────────────────────────────────────────
export function RecurringExpensesDialog({ open, onClose, categories, projects }: { open: boolean; onClose: () => void; categories: any[]; projects: any[] }) {
  const utils = trpc.useUtils();
  const { data: list = [] } = trpc.expenses.recurring.list.useQuery(undefined, { enabled: open });
  const [f, setF] = useState<any>({ description: "", supplier: "", amount: "", dayOfMonth: "1", categoryId: "", projectId: "" });
  const refresh = () => utils.expenses.recurring.list.invalidate();
  const create = trpc.expenses.recurring.create.useMutation({ onSuccess: () => { setF({ description: "", supplier: "", amount: "", dayOfMonth: "1", categoryId: "", projectId: "" }); refresh(); toast.success("Modelo criado"); }, onError: (e) => toast.error(e.message) });
  const update = trpc.expenses.recurring.update.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const remove = trpc.expenses.recurring.remove.useMutation({ onSuccess: () => { refresh(); toast.success("Removido"); }, onError: (e) => toast.error(e.message) });
  const projOpts = [{ value: "", label: "sem projeto" }, ...projects.map((p: any) => ({ value: String(p.id), label: p.name }))];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Despesas recorrentes (fixas do mes)</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground -mt-2">Cada modelo gera automaticamente uma despesa por mes (no dia indicado). Confirmas/pagas depois na lista normal.</p>
        <div className="grid grid-cols-2 gap-2 border rounded p-3 bg-muted/30">
          <div className="col-span-2"><Label className="text-xs">Descricao</Label><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="ex: Renda escritorio" /></div>
          <div><Label className="text-xs">Fornecedor</Label><Input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></div>
          <div><Label className="text-xs">Valor (EUR)</Label><Input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div><Label className="text-xs">Dia do mes</Label><Input type="number" min="1" max="28" value={f.dayOfMonth} onChange={(e) => setF({ ...f, dayOfMonth: e.target.value })} /></div>
          <div><Label className="text-xs">Categoria</Label>
            <Select value={f.categoryId} onValueChange={(v) => setF({ ...f, categoryId: v })}><SelectTrigger><SelectValue placeholder="categoria" /></SelectTrigger>
              <SelectContent>{categories.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="col-span-2"><Label className="text-xs">Projeto (centro de custos)</Label>
            <SearchableSelect className="w-full" value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} options={projOpts} placeholder="projeto" />
          </div>
          <div className="col-span-2 flex justify-end">
            <Button size="sm" disabled={!f.amount || create.isPending} onClick={() => create.mutate({ description: f.description || undefined, supplier: f.supplier || undefined, amount: Number(f.amount), dayOfMonth: Number(f.dayOfMonth) || 1, categoryId: f.categoryId ? Number(f.categoryId) : undefined, projectId: f.projectId ? Number(f.projectId) : undefined })}>+ Adicionar modelo</Button>
          </div>
        </div>
        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {(list as any[]).map((r: any) => (
            <div key={r.id} className={"flex items-center gap-2 text-sm border rounded px-2 py-1.5 " + (!r.active ? "opacity-50" : "")}>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{r.description || r.supplier || "-"}</div>
                <div className="text-[11px] text-muted-foreground">{fmtEur(r.amount)} - dia {r.dayOfMonth}{r.projectId ? " - " + (projects.find((p: any) => p.id === r.projectId)?.name ?? r.projectId) : ""}</div>
              </div>
              <label className="flex items-center gap-1 text-[11px] cursor-pointer select-none"><input type="checkbox" checked={!!r.active} onChange={(e) => update.mutate({ id: r.id, active: e.target.checked })} /> ativo</label>
              <Button size="sm" variant="ghost" className="text-red-600 h-7 w-7 p-0" onClick={() => { if (confirm("Remover modelo recorrente?")) remove.mutate({ id: r.id }); }}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          {(list as any[]).length === 0 && <p className="text-sm text-muted-foreground text-center py-4">Ainda nao ha modelos recorrentes.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── COMPARAR PERIODOS ────────────────────────────────────────────────────────
export function CompareExpensesDialog({ open, onClose, categories, projectId }: { open: boolean; onClose: () => void; categories: any[]; projectId?: number }) {
  const today = new Date();
  const ym = (d: Date) => ({ from: format(startOfMonth(d), "yyyy-MM-dd"), to: format(endOfMonth(d), "yyyy-MM-dd") });
  const [a, setA] = useState(ym(today));
  const [b, setB] = useState(ym(new Date(today.getFullYear(), today.getMonth() - 1, 1)));
  const sumA = trpc.expenses.summary.useQuery({ from: a.from, to: a.to, projectId }, { enabled: open });
  const sumB = trpc.expenses.summary.useQuery({ from: b.from, to: b.to, projectId }, { enabled: open });
  const catName = (id: number | null) => id == null ? "Sem categoria" : (categories.find((c: any) => c.id === id)?.name ?? "#" + id);
  const totalA = sumA.data?.total ?? 0, totalB = sumB.data?.total ?? 0;
  const delta = totalA - totalB; const pct = totalB > 0 ? (delta / totalB * 100) : null;

  const cats = useMemo(() => {
    const m = new Map<any, { a: number; b: number }>();
    for (const r of sumA.data?.byCategory ?? []) m.set(r.categoryId, { a: r.total, b: 0 });
    for (const r of sumB.data?.byCategory ?? []) { const e = m.get(r.categoryId) ?? { a: 0, b: 0 }; e.b = r.total; m.set(r.categoryId, e); }
    return [...m.entries()].map(([id, v]) => ({ id, ...v })).sort((x, y) => (y.a + y.b) - (x.a + x.b));
  }, [sumA.data, sumB.data]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Comparar periodos</DialogTitle></DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => { setA(ym(today)); setB(ym(new Date(today.getFullYear(), today.getMonth() - 1, 1))); }}>Este mes vs anterior</Button>
          <Button size="sm" variant="outline" onClick={() => { setA(ym(today)); setB(ym(new Date(today.getFullYear() - 1, today.getMonth(), 1))); }}>Mes homologo (ano anterior)</Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="border rounded p-2">
            <div className="text-xs font-medium mb-1">Periodo A</div>
            <div className="flex flex-wrap gap-1"><Input type="date" className="h-8" value={a.from} onChange={(e) => setA({ ...a, from: e.target.value })} /><Input type="date" className="h-8" value={a.to} onChange={(e) => setA({ ...a, to: e.target.value })} /></div>
            <div className="text-2xl font-bold mt-2">{fmtEur(totalA)}</div><div className="text-[11px] text-muted-foreground">{sumA.data?.count ?? 0} despesas</div>
          </div>
          <div className="border rounded p-2">
            <div className="text-xs font-medium mb-1">Periodo B</div>
            <div className="flex flex-wrap gap-1"><Input type="date" className="h-8" value={b.from} onChange={(e) => setB({ ...b, from: e.target.value })} /><Input type="date" className="h-8" value={b.to} onChange={(e) => setB({ ...b, to: e.target.value })} /></div>
            <div className="text-2xl font-bold mt-2">{fmtEur(totalB)}</div><div className="text-[11px] text-muted-foreground">{sumB.data?.count ?? 0} despesas</div>
          </div>
        </div>
        <div className={"text-center rounded p-2 " + (delta > 0 ? "bg-red-50 text-red-700" : delta < 0 ? "bg-emerald-50 text-emerald-700" : "bg-muted")}>
          Variacao: <strong>{delta >= 0 ? "+" : ""}{fmtEur(delta)}</strong> {pct != null && <>({delta >= 0 ? "+" : ""}{pct.toFixed(1)}%)</>}
        </div>
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground border-b"><th className="p-1">Categoria</th><th className="p-1 text-right">A</th><th className="p-1 text-right">B</th><th className="p-1 text-right">Delta</th></tr></thead>
            <tbody>{cats.map((c) => (<tr key={String(c.id)} className="border-b"><td className="p-1">{catName(c.id)}</td><td className="p-1 text-right">{fmtEur(c.a)}</td><td className="p-1 text-right">{fmtEur(c.b)}</td><td className={"p-1 text-right " + (c.a - c.b > 0 ? "text-red-600" : c.a - c.b < 0 ? "text-emerald-600" : "")}>{c.a - c.b >= 0 ? "+" : ""}{fmtEur(c.a - c.b)}</td></tr>))}</tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
