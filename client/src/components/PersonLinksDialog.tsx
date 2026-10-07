/**
 * 41a: "Ligações" de uma ficha num diálogo — contas de login e agentes da
 * Multipark (ligar / separar) sem sair da ficha do RH ou da lista de
 * Utilizadores. O mesmo cartão do RH → Ligações, com a ficha já escolhida.
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PersonIdentityCard } from "@/components/PersonIdentityCard";

export function PersonLinksDialog({ employeeId, name, open, onOpenChange }: { employeeId: number | null; name?: string | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open && !!employeeId} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Ligações{name ? ` — ${name}` : ""}</DialogTitle>
          <DialogDescription>Contas de login e agentes da Multipark desta ficha. Separar só desliga: a conta e o agente ficam como estão.</DialogDescription>
        </DialogHeader>
        {employeeId && <PersonIdentityCard employeeId={employeeId} canMerge={false} bare />}
      </DialogContent>
    </Dialog>
  );
}
