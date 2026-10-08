/**
 * 41a + 49c: pop-up na lista de Utilizadores (quem gere o RH) — pessoas de
 * ficha ativa sem atividade (agente da Multipark, ponto, extras, login) há
 * mais de "rh.suspendAfterDays" dias. PÔR INATIVO (Jorge, 8 out 2026): a ficha
 * fica inativa com o motivo "Inatividade" — sai das listas, da escala e dos
 * avisos, mas a pessoa pode voltar a entrar como utilizador e dizer "Voltei".
 * A ficha, a conta e o agente ficam ligados; nada se apaga.
 * "Agora não" esconde o aviso durante 7 dias (neste browser).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, PauseCircle } from "lucide-react";
import { toast } from "sonner";

const SNOOZE_KEY = "suspendSuggest.snoozeUntil";
const SNOOZE_DAYS = 7;

function snoozed(): boolean {
  try { return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now(); } catch { return false; }
}
function snooze() {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 86_400_000)); } catch { /* sem armazenamento: volta a aparecer */ }
}

const fmtDay = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "nunca");

export function SuspendSuggestionsDialog({ enabled }: { enabled: boolean }) {
  const utils = trpc.useUtils();
  const q = trpc.identityLinks.suspendSuggestions.useQuery(undefined, { enabled, staleTime: 10 * 60_000, retry: false });
  const items = q.data?.items ?? [];
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // abre sozinho uma vez por visita à página (o botão fica para voltar a abrir)
  const autoOpened = useRef(false);
  useEffect(() => {
    if (items.length && !autoOpened.current && !snoozed()) {
      autoOpened.current = true;
      setPicked(new Set(items.map((i) => i.employeeId)));
      setOpen(true);
    }
  }, [items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const suspend = trpc.identityLinks.suspend.useMutation({
    onSuccess: (r) => {
      toast.success(`${r.suspended} pessoa(s) posta(s) como inativa(s). Podem voltar a entrar e dizer "Voltei"; reativa-se na ficha do RH.`);
      utils.identityLinks.suspendSuggestions.invalidate();
      utils.users.invalidate();
      setOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });
  const allOn = picked.size === items.length;
  const span = useMemo(() => {
    const d = q.data?.days ?? 180;
    return d % 30 === 0 ? (d === 30 ? "1 mês" : `${d / 30} meses`) : `${d} dias`;
  }, [q.data?.days]);
  if (!enabled || !items.length) return null;
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <>
      {!open && (
        <Button variant="outline" size="sm" className="h-8" onClick={() => { setPicked(new Set(items.map((i) => i.employeeId))); setOpen(true); }}>
          <PauseCircle className="h-3.5 w-3.5 mr-1" /> {items.length} sem atividade há +{span}
        </Button>
      )}
      <Dialog open={open} onOpenChange={(o) => { if (!o) { snooze(); setOpen(false); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><PauseCircle className="h-5 w-5" /> Pôr inativo quem está parado há mais de {span}?</DialogTitle>
            <DialogDescription>
              Ficha ativa, mas sem trabalho (agente da Multipark, ponto, extras) nem entrada na app desde a data indicada. <b>Inativo não é desativado</b>:
              a ficha fica inativa com o motivo "Inatividade" (sai das listas, da escala e dos avisos), mas a pessoa pode voltar a entrar como utilizador,
              atualizar os dados e os dias livres e dizer "Voltei". A ficha, a conta e o agente ficam ligados e nada é apagado.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-2 text-xs">
            <button type="button" className="underline text-muted-foreground" onClick={() => setPicked(allOn ? new Set() : new Set(items.map((i) => i.employeeId)))}>
              {allOn ? "Tirar todos" : "Marcar todos"}
            </button>
            <span className="text-muted-foreground">{picked.size} de {items.length} marcados</span>
          </div>
          <ul className="divide-y rounded-md border text-sm">
            {items.map((i) => (
              <li key={i.employeeId} className="flex items-start gap-2 p-2">
                <Checkbox checked={picked.has(i.employeeId)} onCheckedChange={() => toggle(i.employeeId)} aria-label={`Pôr inativo ${i.fullName}`} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <Link href={`/rh?employeeId=${i.employeeId}`} className="font-medium hover:underline [overflow-wrap:anywhere]">{i.fullName}</Link>
                  <p className="text-xs text-muted-foreground">
                    {[i.position, i.projectName].filter(Boolean).join(" · ") || "sem cidade"} · última atividade {fmtDay(i.lastActivity)}
                    {i.lastActivity ? "" : ` (ficha de ${fmtDay(i.createdAt)})`}
                    {i.lastWorked && i.lastLogin ? ` · trabalhou ${fmtDay(i.lastWorked)}, entrou ${fmtDay(i.lastLogin)}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { snooze(); setOpen(false); }}>Agora não ({SNOOZE_DAYS} dias)</Button>
            <Button disabled={!picked.size || suspend.isPending} onClick={() => suspend.mutate({ employeeIds: [...picked].slice(0, 200), why: "inatividade" })}>
              {suspend.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}Pôr inativo ({picked.size})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
