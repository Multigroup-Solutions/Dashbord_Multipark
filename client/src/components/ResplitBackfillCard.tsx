/**
 * Tarefa 62 (P1b): "Re-dividir os últimos 31 dias" — só para o super admin,
 * em Atividade diária → Histórico Diário. Corre em segundo plano no agendador
 * (5 em 5 min, retomável): volta a calcular a velocidade máxima e os excessos
 * dos dias já recolhidos com o limite de hoje (120 km/h), sem ir ao Zello nem
 * avisar ninguém. A Avaliação acerta-se no recálculo da noite.
 */
import { toast } from "sonner";
import { Loader2, RefreshCw, Square } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { fmtPTDateTime } from "@/lib/lisbonTime";

const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export function ResplitBackfillCard() {
  const { user } = useAuth();
  const isSuper = user?.role === "super_admin";
  const utils = trpc.useUtils();
  const q = trpc.operational.driverHistory.resplitBackfill.status.useQuery(undefined, {
    enabled: isSuper, retry: false, refetchInterval: (query) => (query.state.data?.state === "running" ? 30_000 : false),
  });
  const onDone = () => utils.operational.driverHistory.resplitBackfill.status.invalidate();
  const start = trpc.operational.driverHistory.resplitBackfill.start.useMutation({
    onSuccess: (s) => { toast.success(`Pedido: re-divisão de ${ddmm(s.from)} a ${ddmm(s.to)} em segundo plano.`); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  const stop = trpc.operational.driverHistory.resplitBackfill.stop.useMutation({ onSuccess: () => { toast.success("Parado."); onDone(); }, onError: (e) => toast.error(e.message) });
  if (!isSuper) return null;
  const s = q.data;
  const running = s?.state === "running";
  const total = s ? Math.round((Date.parse(`${s.to}T00:00:00Z`) - Date.parse(`${s.from}T00:00:00Z`)) / 86_400_000) + 1 : 0;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[14px] border px-3 py-2 text-sm" data-resplit-backfill>
      <RefreshCw className="h-4 w-4 shrink-0 text-[#0055D2]" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Re-dividir os últimos 31 dias com o limite de hoje</p>
        <p className="text-xs text-muted-foreground">
          {q.isError ? "Não deu para ler o estado."
            : !s ? "Volta a calcular a velocidade máxima e os excessos dos dias já recolhidos (setembro e outubro passam a contar acima de 120 km/h). Em segundo plano; não vai ao Zello nem avisa ninguém."
            : running ? <>A correr: {s.daysDone} de {total} dias ({s.rowsDone} linhas), próximo {ddmm(s.day)}.{s.errors.length ? ` ${s.errors.length} erro(s).` : ""}</>
            : s.state === "done" ? <>Concluído {s.finishedAt ? fmtPTDateTime(s.finishedAt) : ""}: {s.daysDone} dias ({ddmm(s.from)}–{ddmm(s.to)}), {s.rowsDone} linhas{s.errors.length ? `, ${s.errors.length} erro(s)` : ""}. A Avaliação acerta-se no recálculo da noite.</>
            : <>Parado em {ddmm(s.day)} ({s.daysDone} de {total} dias).</>}
        </p>
      </div>
      {running ? (
        <Button size="sm" variant="outline" className="rounded-[10px]" disabled={stop.isPending} onClick={() => stop.mutate()}>
          <Square className="h-4 w-4 mr-1" aria-hidden />Parar
        </Button>
      ) : (
        <Button size="sm" className="rounded-[10px]" disabled={start.isPending || q.isLoading}
          onClick={() => { if (window.confirm("Re-dividir em segundo plano o GPS dos últimos 31 dias com o limite de velocidade de hoje? Não avisa ninguém; os pontos da Avaliação acertam-se no recálculo da noite.")) start.mutate(); }}>
          {start.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4 mr-1" aria-hidden />}
          {s ? "Voltar a pedir" : "Re-dividir"}
        </Button>
      )}
    </div>
  );
}
