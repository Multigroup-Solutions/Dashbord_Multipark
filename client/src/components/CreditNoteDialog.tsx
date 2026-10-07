/**
 * Nota de crédito de uma fatura (Jorge, 7 out 2026: "foi paga, mas depois foi
 * devolvida parte das peças e veio uma nota de crédito"). Documento próprio
 * (valor, data, n.º e PDF da NC) ligado à fatura; nunca passa do que falta
 * creditar. Serve para lançar (a partir da fatura) e para mudar (na NC).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Paperclip } from "lucide-react";
import { CREDIT_NOTE_STATES, CREDIT_NOTE_STATE_HELP, CREDIT_NOTE_STATE_LABELS, type CreditNoteState } from "@shared/creditNotes";
import { lisbonDayOf } from "@shared/lisbonDay";
const lisbonDay = () => lisbonDayOf(Date.now());

const eur = (v: number) => v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
const MAX_BYTES = 10 * 1024 * 1024;
const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

export interface CreditNoteTarget {
  /** fatura (para lançar) — com o que já foi creditado */
  invoice?: { id: number; supplier: string | null; documentNumber: string | null; amount: string; credited: number };
  /** NC existente (para mudar) */
  creditNote?: { id: number; amount: string; expenseDate: string | null; documentNumber: string | null; notes: string | null; creditNoteState: string | null; hasDocument: boolean; invoiceAmount?: string | null; invoiceCreditedOthers?: number };
}

export function CreditNoteDialog({ target, onClose }: { target: CreditNoteTarget | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const editing = !!target?.creditNote;
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(lisbonDay());
  const [doc, setDoc] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<CreditNoteState>("to_receive");
  const [file, setFile] = useState<{ key: string; url: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!target) return;
    const nc = target.creditNote;
    setAmount(nc ? String(Math.abs(Number(nc.amount))).replace(".", ",") : "");
    setDate(nc?.expenseDate ? String(nc.expenseDate).slice(0, 10) : lisbonDay());
    setDoc(nc?.documentNumber ?? "");
    setReason(nc?.notes ?? "");
    setState((nc?.creditNoteState as CreditNoteState) ?? "to_receive");
    setFile(null);
  }, [target]);

  const done = (msg: string) => () => { toast.success(msg); utils.expenses.list.invalidate(); onClose(); };
  const create = trpc.expenses.creditNote.create.useMutation({ onSuccess: done("Nota de crédito lançada."), onError: (e) => toast.error(e.message) });
  const update = trpc.expenses.creditNote.update.useMutation({ onSuccess: done("Nota de crédito atualizada."), onError: (e) => toast.error(e.message) });
  const upload = trpc.expenses.uploadInvoice.useMutation();

  const left = target?.invoice
    ? Math.max(0, Number(target.invoice.amount) - target.invoice.credited)
    : target?.creditNote?.invoiceAmount != null ? Math.max(0, Number(target.creditNote.invoiceAmount) - (target.creditNote.invoiceCreditedOthers ?? 0)) : null;

  const onFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (!f) return;
    if (f.size > MAX_BYTES) { toast.error("O ficheiro pode ter até 10 MB."); return; }
    setUploading(true);
    try {
      const r = await upload.mutateAsync({ fileName: f.name.slice(0, 200), fileBase64: await toBase64(f), mimeType: f.type || "application/pdf" });
      setFile({ key: r.key, url: r.url, name: f.name });
    } catch (e: any) { toast.error(e?.message ?? "Não deu para carregar o ficheiro."); }
    finally { setUploading(false); }
  };

  const submit = () => {
    const base = { amount, date, documentNumber: doc || null, reason: reason || null, state };
    if (editing) update.mutate({ id: target!.creditNote!.id, ...base, ...(file ? { invoiceImageKey: file.key, invoiceImageUrl: file.url } : {}) });
    else create.mutate({ invoiceId: target!.invoice!.id, ...base, ...(file ? { invoiceImageKey: file.key, invoiceImageUrl: file.url } : {}) });
  };
  const busy = create.isPending || update.isPending || uploading;

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Nota de crédito" : "Nova nota de crédito"}</DialogTitle>
          <DialogDescription>
            {target?.invoice
              ? <>Da fatura {target.invoice.documentNumber ? <b>{target.invoice.documentNumber}</b> : `#${target.invoice.id}`} de {target.invoice.supplier ?? "—"} ({eur(Number(target.invoice.amount))}).</>
              : "Documento próprio, ligado à fatura."}
            {left != null && <> Falta creditar no máximo <b>{eur(left)}</b>.</>}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="nc-amount">Valor da NC (€)</Label>
              <Input id="nc-amount" inputMode="decimal" placeholder="ex.: 45,90" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="nc-date">Data da NC</Label>
              <Input id="nc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="nc-doc">N.º da nota de crédito</Label>
            <Input id="nc-doc" maxLength={64} placeholder="ex.: NC 2026/15" value={doc} onChange={(e) => setDoc(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nc-reason">Motivo</Label>
            <Textarea id="nc-reason" rows={2} maxLength={500} placeholder="ex.: devolução de parte das peças" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Estado</Label>
            <Select value={state} onValueChange={(v) => setState(v as CreditNoteState)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{CREDIT_NOTE_STATES.map((s) => <SelectItem key={s} value={s}>{CREDIT_NOTE_STATE_LABELS[s]}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{CREDIT_NOTE_STATE_HELP[state]}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="cursor-pointer">
              <input type="file" accept="application/pdf,image/*" className="hidden" onChange={onFile} disabled={busy} />
              <Button type="button" variant="outline" size="sm" asChild disabled={busy}>
                <span>{uploading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Paperclip className="mr-1 h-4 w-4" />}{file ? "Trocar o documento" : target?.creditNote?.hasDocument ? "Trocar o documento" : "Juntar a nota de crédito"}</span>
              </Button>
            </label>
            <span className="truncate text-xs text-muted-foreground">{file ? file.name : target?.creditNote?.hasDocument ? "Documento já junto." : "PDF ou fotografia, até 10 MB."}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">Conta nos totais no mês da data da NC (desconta à fatura). A fatura não muda.</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={submit} disabled={busy || !amount.trim() || !date}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{editing ? "Guardar" : "Lançar nota de crédito"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
