/**
 * Extras-dia → linha da escala: atalho para as notas internas da pessoa
 * (Jorge, 7 out 2026: "ex. este extra trabalhou mal no dia ..."). Abre as
 * notas mais recentes e o formulário já com o dia e a linha da escala.
 * Só para team leader e acima com RH (o servidor confirma o âmbito).
 */
import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { can, roleRank } from "@shared/access";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NotebookPen } from "lucide-react";
import { EmployeeNotesPanel } from "@/components/rh/EmployeeNotesPanel";

/** Quem vê o atalho (o servidor decide o resto: âmbito, nunca a própria ficha). */
export function canSeeInternalNotes(user: { role?: string | null } | null | undefined): boolean {
  return !!user && roleRank(user.role) >= roleRank("team_leader") && can(user as any, "rh", "view");
}

export function QuickNoteButton({ employeeId, name, workDate, assignmentId }: { employeeId: number; name: string; workDate: string; assignmentId: number }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  if (!canSeeInternalNotes(user as any)) return null;
  return (
    <>
      <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" title="Notas internas" aria-label={`Notas internas de ${name}`} onClick={() => setOpen(true)}>
        <NotebookPen className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Notas internas · {name}</DialogTitle>
              <DialogDescription>Ficam na ficha do RH, presas a este dia de trabalho. A pessoa nunca as vê.</DialogDescription>
            </DialogHeader>
            <EmployeeNotesPanel employeeId={employeeId} workDate={workDate} assignmentId={assignmentId} limit={5} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
