/**
 * Despesas → Para a contabilista (30b, Jorge 6 out 2026: "export mensal só
 * com as faturas e as datas, a pedido do utilizador"). Escolhe-se o mês e sai
 * um ZIP com os ficheiros das faturas (data da fatura nesse mês) e a folha das
 * datas. Nada é enviado sozinho: quem exporta é que manda à contabilista.
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileArchive, Loader2 } from "lucide-react";
import { buildZip, previousMonthOf } from "@shared/accountantExport";
import { lisbonDayOf } from "@shared/lisbonDay";

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const eur = (v: number) => new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);

export function AccountantExportDialog({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId?: number }) {
  const [month, setMonth] = useState(() => previousMonthOf(lisbonDayOf(new Date())));
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const list = trpc.expenses.accountantExport.useMutation();
  const file = trpc.expenses.accountantExportFile.useMutation();
  const busy = progress !== null || list.isPending;

  async function run() {
    try {
      const r = await list.mutateAsync({ month, projectId });
      const parts: Array<{ name: string; data: Uint8Array }> = [{ name: r.sheetName, data: fromBase64(r.sheetBase64) }];
      const left: string[] = [];
      setProgress({ done: 0, total: r.files.length });
      let next = 0, done = 0;
      // 4 de cada vez: cada fatura vem num pedido (as respostas da Vercel não podem ser grandes)
      const worker = async () => {
        while (next < r.files.length) {
          const f = r.files[next++];
          try {
            const got = await file.mutateAsync({ id: f.id });
            if (got.tooLarge) left.push(`${f.name} — ficheiro grande (${(got.size / 1_000_000).toFixed(1)} MB): abre a despesa #${f.id} na app`);
            else parts.push({ name: f.name, data: fromBase64(got.base64) });
          } catch (e: any) {
            left.push(`${f.name} — não foi possível ler (${e?.message ?? "erro"}): abre a despesa #${f.id} na app`);
          }
          setProgress({ done: ++done, total: r.files.length });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (left.length) parts.push({ name: "FALTAM-NO-ZIP.txt", data: new TextEncoder().encode(`Faturas que não entraram no ZIP (${left.length}):\n\n${left.join("\n")}\n`) });
      const zip = buildZip(parts);
      const url = URL.createObjectURL(new Blob([zip.buffer as ArrayBuffer], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url; a.download = r.zipName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const ok = parts.length - 1 - (left.length ? 1 : 0);
      toast[left.length ? "warning" : "success"](`${r.zipName}: ${ok} fatura(s), ${eur(r.total)}${left.length ? ` · ${left.length} ficaram de fora (ver FALTAM-NO-ZIP.txt)` : ""}${r.missing ? ` · ${r.missing} despesa(s) sem fatura na folha` : ""}`);
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "Não foi possível gerar o ZIP.");
    } finally {
      setProgress(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !busy) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileArchive className="h-4 w-4" /> Para a contabilista</DialogTitle>
          <DialogDescription>
            Um ZIP com as faturas do mês (pela data da fatura, sem as canceladas) e a folha com as datas: data da fatura, data de pagamento, fornecedor, NIF, nº do documento e valor. As despesas sem fatura aparecem numa folha à parte. Não é enviado a ninguém: descarregas e mandas tu.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <label htmlFor="acc-month" className="text-sm">Mês</label>
          <Input id="acc-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-9 w-44" disabled={busy} />
        </div>
        {progress && <p role="status" className="text-sm text-muted-foreground">A juntar as faturas: {progress.done}/{progress.total}…</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Fechar</Button>
          <Button onClick={run} disabled={busy || !/^\d{4}-\d{2}$/.test(month)}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileArchive className="mr-2 h-4 w-4" />} Gerar ZIP
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
