/**
 * Passagem de turno → Despesas do turno (29d, Jorge 6 out 2026: "na passagem
 * de turno pode-se colocar despesas do turno e elas entram diretamente para a
 * caixa e para as despesas"). Cada linha (descrição, valor, foto do talão)
 * entra logo nas Despesas como paga em dinheiro, no centro da cidade, e abate
 * ao dinheiro que tem de estar na caixa do dia (Financeiro → Caixa → Por dia).
 * "Anular" deixa-a cancelada (nunca se apaga).
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Camera, Loader2, Paperclip, Plus, Undo2 } from "lucide-react";

const eur = (v: number) => new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);

export function ShiftExpensesCard({ date, shift, city, canEdit, onTotal }: {
  date: string; shift: "morning" | "night"; city: "lisbon" | "porto" | "faro"; canEdit: boolean; onTotal?: (total: number) => void;
}) {
  const utils = trpc.useUtils();
  const q = trpc.shiftHandover.expenses.useQuery({ date, shift, city }, { retry: false });
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [receipt, setReceipt] = useState<{ key: string; url: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => { utils.shiftHandover.expenses.invalidate(); };
  const upload = trpc.shiftHandover.uploadReceipt.useMutation();
  const add = trpc.shiftHandover.addExpense.useMutation({
    onSuccess: () => { setDesc(""); setAmount(""); setReceipt(null); refresh(); toast.success("Despesa lançada — já está nas Despesas e abate à caixa do dia"); },
    onError: (e) => toast.error(e.message),
  });
  const cancel = trpc.shiftHandover.cancelExpense.useMutation({ onSuccess: () => { refresh(); toast.success("Despesa anulada (fica cancelada no histórico)"); }, onError: (e) => toast.error(e.message) });
  const total = q.data?.total ?? 0;
  useEffect(() => { if (q.data) onTotal?.(total); }, [q.data, total]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickFile = async (file: File) => {
    setUploading(true);
    try {
      const base64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = rej; r.readAsDataURL(file); });
      const out = await upload.mutateAsync({ fileName: file.name, fileBase64: base64, mimeType: file.type || "image/jpeg" });
      setReceipt({ ...out, name: file.name });
    } catch (e: any) { toast.error(e?.message ?? "Não foi possível carregar o talão"); }
    finally { setUploading(false); }
  };
  const submit = () => {
    const v = Number(String(amount).replace(",", "."));
    if (!desc.trim() || !(v > 0)) { toast.error("Escreve a descrição e o valor."); return; }
    add.mutate({ date, shift, city, description: desc.trim(), amount: v, invoiceKey: receipt?.key ?? null, invoiceUrl: receipt?.url ?? null });
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-sm font-medium flex-1">Despesas do turno (pagas com o dinheiro da caixa)</p>
        <span className="text-sm tabular-nums">Total: <b>{eur(total)}</b></span>
      </div>
      <p className="text-[11px] text-muted-foreground">Cada despesa entra logo nas <b>Despesas</b> (paga, dinheiro, com o talão) e abate ao dinheiro que tem de estar na <b>caixa do dia</b>.</p>
      {q.error ? <p className="text-xs text-destructive">{q.error.message}</p> : (q.data?.rows ?? []).length > 0 && (
        <ul className="space-y-1 text-sm">
          {(q.data?.rows ?? []).map((r) => (
            <li key={r.id} className={`flex items-center gap-2 ${r.status === "cancelled" ? "text-muted-foreground line-through" : ""}`}>
              <span className="flex-1 min-w-0 break-words">{r.description}</span>
              {r.hasReceipt ? <Paperclip className="h-3.5 w-3.5 text-emerald-600" aria-label="Com talão" /> : <span className="text-[10px] text-amber-700">sem talão</span>}
              <span className="tabular-nums">{eur(r.amount)}</span>
              {canEdit && r.status !== "cancelled" && (
                <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5" title="Anular (fica cancelada no histórico)" aria-label={`Anular ${r.description}`} disabled={cancel.isPending}
                  onClick={() => { if (confirm(`Anular "${r.description}"? Sai da caixa e fica cancelada nas Despesas.`)) cancel.mutate({ id: r.id }); }}>
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_7rem_auto_auto]">
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="ex.: Combustível carrinha, lavagem…" aria-label="Descrição da despesa do turno" />
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="€" aria-label="Valor da despesa do turno" />
          <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ""; }} />
          <Button type="button" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()} title="Foto do talão">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}<span className="ml-1">{receipt ? "Talão ✓" : "Talão"}</span>
          </Button>
          <Button type="button" disabled={add.isPending || uploading} onClick={submit}><Plus className="h-4 w-4 mr-1" />Lançar</Button>
        </div>
      )}
    </div>
  );
}
