import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, UserX } from "lucide-react";
import {
  DEACTIVATION_NOTES_MAX,
  DEACTIVATION_REASONS,
  DEACTIVATION_REASON_OTHER_MAX,
  DEFAULT_DEACTIVATION_REASON,
  OTHER_DEACTIVATION_REASON,
  type DeactivationReasonCode,
} from "@shared/deactivationReasons";

export type DeactivationSubmitValues = {
  reason: DeactivationReasonCode;
  /** Só preenchido quando o motivo é "Outro". */
  reasonOther?: string;
  notes?: string;
};

/**
 * Pop-up de DESATIVAÇÃO (pedido do Jorge, 2026-09-11): motivo (por defeito
 * "Inatividade") + notas, os dois OPCIONAIS. Usado pelos dois caminhos que
 * desativam alguém — a tabela de Utilizadores e a ficha de RH — para que o
 * motivo gravado venha sempre do mesmo vocabulário
 * (`shared/deactivationReasons.ts`).
 *
 * Só pede motivo a DESATIVAR; reativar não passa por aqui.
 */
export function DeactivationDialog({
  open,
  subjectName,
  subjectKind = "utilizador",
  effectNote,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  /** Nome de quem vai ser desativado — aparece no título e no aviso. */
  subjectName: string;
  /** "utilizador" (conta) ou "colaborador" (ficha de RH). */
  subjectKind?: "utilizador" | "colaborador";
  /** Uma linha a dizer o que acontece ao confirmar (login, emails, ...). */
  effectNote?: string;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (values: DeactivationSubmitValues) => void;
}) {
  const [reason, setReason] = useState<DeactivationReasonCode>(DEFAULT_DEACTIVATION_REASON);
  const [reasonOther, setReasonOther] = useState("");
  const [notes, setNotes] = useState("");

  // Cada abertura começa limpa (e no motivo por defeito) — senão o motivo
  // escolhido para uma pessoa ficava pré-selecionado na seguinte.
  useEffect(() => {
    if (open) {
      setReason(DEFAULT_DEACTIVATION_REASON);
      setReasonOther("");
      setNotes("");
    }
  }, [open]);

  const isOther = reason === OTHER_DEACTIVATION_REASON;
  // Regra igual à do servidor (`resolveDeactivation`): escolher "Outro" obriga
  // a escrever qual — o resto é opcional.
  const missingOther = isOther && !reasonOther.trim();

  function handleConfirm() {
    if (pending || missingOther) return;
    onConfirm({
      reason,
      reasonOther: isOther ? reasonOther.trim() : undefined,
      notes: notes.trim() || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!pending) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserX className="h-4 w-4 text-red-600" />
            Desativar {subjectKind}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <p className="text-sm text-muted-foreground">
            Vais desativar <span className="font-medium text-foreground">{subjectName}</span>.
            {effectNote ? ` ${effectNote}` : ""}
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="deactivation-reason">Motivo (opcional)</Label>
            <Select value={reason} onValueChange={(v) => setReason(v as DeactivationReasonCode)}>
              <SelectTrigger id="deactivation-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEACTIVATION_REASONS.map((r) => (
                  <SelectItem key={r.code} value={r.code}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Por defeito fica “Inatividade”.
            </p>
          </div>

          {isOther && (
            <div className="space-y-1.5">
              <Label htmlFor="deactivation-reason-other">Qual o motivo? *</Label>
              <Input
                id="deactivation-reason-other"
                autoFocus
                placeholder="Escreve o motivo"
                maxLength={DEACTIVATION_REASON_OTHER_MAX}
                value={reasonOther}
                onChange={(e) => setReasonOther(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="deactivation-notes">Notas (opcional)</Label>
            <Textarea
              id="deactivation-notes"
              rows={4}
              placeholder="Detalhes, contexto, o que foi combinado..."
              maxLength={DEACTIVATION_NOTES_MAX}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground text-right">
              {notes.length}/{DEACTIVATION_NOTES_MAX}
            </p>
          </div>

          <p className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-lg">
            O motivo e as notas ficam guardados na ficha e no histórico de atividade.
            Ao reativar, o motivo é limpo (o histórico mantém-se).
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending || missingOther}
            title={missingOther ? "Escreve o motivo para continuar" : undefined}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Desativar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
