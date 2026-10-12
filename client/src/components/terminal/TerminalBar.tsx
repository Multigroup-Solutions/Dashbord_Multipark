// Terminal pelo perfil (plano 56 B1): barra fina por baixo do cabeçalho
// ("Terminal Lisboa · desde 14:05 · Sair"), o pedido de troca (Passar /
// Ainda estou) e o ecrã "ocupado" ("Pedir ao João para passar").
import { useState } from "react";
import { Plane } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtPTTime } from "@/lib/lisbonTime";
import type { TerminalApi } from "./useTerminal";

const CITY_OF: Record<string, string> = { lisbon: "de Lisboa", porto: "do Porto", faro: "de Faro" };

export function TerminalBar({ t }: { t: TerminalApi }) {
  const [confirmStop, setConfirmStop] = useState(false);
  const s = t.status;
  if (!s?.enabled || (!s.session && !s.incoming && !s.outgoing)) return null;
  return (
    <div className="sticky top-16 z-30 border-b border-sky-200 bg-sky-50 px-4 lg:px-6 py-1.5 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-100" role="status">
      {s.session && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Plane className="h-4 w-4 shrink-0" aria-hidden />
          <span className="font-medium">Terminal {s.session.cityLabel}</span>
          <span aria-hidden>·</span>
          <span>desde {fmtPTTime(s.session.startedAt)}</span>
          <span aria-hidden>·</span>
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={t.working} onClick={() => setConfirmStop(true)}>Sair</Button>
        </div>
      )}
      {s.incoming && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span><strong>{s.incoming.requesterName}</strong> pede o terminal.</span>
          <Button size="sm" className="h-7 px-3" disabled={t.working} onClick={() => t.answer(s.incoming!.requestId, "pass")}>Passar</Button>
          <Button size="sm" variant="outline" className="h-7 px-3" disabled={t.working} onClick={() => t.answer(s.incoming!.requestId, "stay")}>Ainda estou</Button>
        </div>
      )}
      {!s.session && s.outgoing && (
        <div className="flex flex-wrap items-center gap-2">
          <Plane className="h-4 w-4 shrink-0" aria-hidden />
          <span>Pediste o terminal {CITY_OF[s.outgoing.cityKey] ?? ""} a {s.outgoing.holderFirstName}. À espera da resposta.</span>
        </div>
      )}
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sair do terminal?</AlertDialogTitle>
            <AlertDialogDescription>Deixas de estar no terminal {CITY_OF[s.session?.cityKey ?? ""] ?? ""}. O ponto continua aberto.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Ficar</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmStop(false); t.stop(); }}>Sair do terminal</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** "O terminal de Lisboa está com o João Silva desde 14:05" + "Pedir ao João para passar". */
export function TerminalBusyDialog({ t }: { t: TerminalApi }) {
  const b = t.busy;
  return (
    <Dialog open={!!b} onOpenChange={(o) => { if (!o) t.setBusy(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Plane className="h-4 w-4" />Terminal ocupado</DialogTitle>
          <DialogDescription>{b?.message}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{b?.holderFirstName} recebe o pedido na app e responde "Passar" ou "Ainda estou". O TL de serviço também é avisado.</p>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => t.setBusy(null)}>Fechar</Button>
          <Button disabled={t.working} onClick={() => t.askToPass()}>{b?.requestLabel ?? "Pedir para passar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
