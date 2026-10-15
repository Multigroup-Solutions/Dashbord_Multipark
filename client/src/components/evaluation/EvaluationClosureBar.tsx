/**
 * Fecho mensal da Avaliação (tarefa 62, P2d): "Fechado até DD/MM/AAAA" e, para
 * o super admin e as pessoas autorizadas (Definições → "Avaliação: quem fecha
 * o mês"), fechar até uma data ou reabrir. Os dias fechados já não se
 * recalculam, ajustam nem contestam (o servidor recusa).
 */
import { useState } from "react";
import { toast } from "sonner";
import { Lock, LockOpen } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addDays, operationalDayOf } from "@shared/lisbonDay";
import { fmtClosedUntil } from "@shared/evaluationClose";

/** Último dia do mês anterior ao dia dado (AAAA-MM-DD). */
const endOfPreviousMonth = (day: string) => addDays(`${day.slice(0, 7)}-01`, -1);

export function EvaluationClosureBar({ from, to }: { from: string; to: string }) {
  const utils = trpc.useUtils();
  const q = trpc.evaluation.closure.useQuery(undefined, { staleTime: 60_000, refetchOnWindowFocus: false });
  const today = operationalDayOf(Date.now());
  const [day, setDay] = useState(() => endOfPreviousMonth(today));
  const set = trpc.evaluation.setClosedUntil.useMutation({
    onSuccess: (r) => {
      toast.success(r.closedUntil ? `Avaliação fechada até ${fmtClosedUntil(r.closedUntil)}.` : "Avaliação reaberta: nenhum dia fechado.");
      utils.evaluation.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const d = q.data;
  if (!d) return null;
  const { closedUntil, canClose, readFailed } = d;
  if (!closedUntil && !canClose && !readFailed) return null;
  const allClosed = !!closedUntil && to <= closedUntil;
  const partClosed = !!closedUntil && !allClosed && from <= closedUntil;
  const close = () => {
    if (!day) return;
    if (!window.confirm(`Fechar a Avaliação até ${fmtClosedUntil(day)}? Os dias até lá deixam de mudar (recálculo, ajustes e contestações). Dá para reabrir depois.`)) return;
    set.mutate({ closedUntil: day });
  };
  const reopen = () => {
    if (!window.confirm("Reabrir a Avaliação (nenhum dia fechado)? O recálculo da noite volta a poder mexer nos últimos 31 dias.")) return;
    set.mutate({ closedUntil: null });
  };
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-[14px] border px-3 py-2 text-sm ${closedUntil ? "border-[#0055D2]/30 bg-[#0055D2]/5" : ""}`} data-evaluation-closure>
      {closedUntil ? <Lock className="h-4 w-4 shrink-0 text-[#0055D2]" aria-hidden /> : <LockOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="min-w-0">
        {readFailed ? "Não deu para ler o fecho do mês: por agora nada se recalcula nem se ajusta."
          : closedUntil ? <>Fechado até <b className="tabular-nums">{fmtClosedUntil(closedUntil)}</b>{allClosed ? " — este período já não muda." : partClosed ? " — os dias até lá já não mudam." : "."}</>
          : "Nenhum mês fechado."}
      </span>
      {canClose && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Input type="date" className="h-8 w-40 rounded-[10px]" value={day} max={addDays(today, -1)} aria-label="Fechar até (último dia fechado)"
            onChange={(e) => setDay(e.target.value)} />
          <Button size="sm" className="rounded-[10px]" disabled={set.isPending || !day} onClick={close}>
            <Lock className="h-4 w-4 mr-1" aria-hidden />Fechar até esta data
          </Button>
          {closedUntil && (
            <Button size="sm" variant="outline" className="rounded-[10px]" disabled={set.isPending} onClick={reopen}>
              <LockOpen className="h-4 w-4 mr-1" aria-hidden />Reabrir
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
