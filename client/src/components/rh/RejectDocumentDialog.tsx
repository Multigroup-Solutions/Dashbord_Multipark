/**
 * Recusar um documento entregue (Jorge, 7 out 2026): o RH diz porquê; a
 * pessoa recebe o aviso com o motivo e volta a carregar na ficha.
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DOC_REJECT_REASON_MAX } from "@shared/employeeDocuments";

const QUICK_REASONS = ["Ilegível ou desfocado", "Fora da validade", "Falta o verso", "Não é o documento pedido"];

export function RejectDocumentDialog({ doc, onClose, onDone }: { doc: { id: number; label: string }; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const reject = trpc.rh.documents.reject.useMutation({
    onSuccess: () => { toast.success("Documento recusado — a pessoa foi avisada com o motivo."); onDone(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const trimmed = reason.trim();
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Recusar documento</DialogTitle>
          <DialogDescription className="break-words">{doc.label} — a pessoa recebe o motivo e pode voltar a carregar.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_REASONS.map((r) => (
              <Button key={r} type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setReason(r)}>{r}</Button>
            ))}
          </div>
          <Label htmlFor="reject-reason">Motivo</Label>
          <Textarea id="reject-reason" rows={3} maxLength={DOC_REJECT_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: a fotografia está desfocada, não se lê o número." />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button variant="destructive" disabled={trimmed.length < 3 || reject.isPending} onClick={() => reject.mutate({ id: doc.id, reason: trimmed })}>
            {reject.isPending ? "A recusar…" : "Recusar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
