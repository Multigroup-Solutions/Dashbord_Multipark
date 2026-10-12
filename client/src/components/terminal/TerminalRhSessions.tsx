// RH → ficha → Ponto (plano 56 B2): os troços do terminal pelo perfil de cada
// turno, com até que hora contou e porquê. Quem gere o ponto da ficha confirma,
// corrige (das–às) ou desmarca os "por confirmar", sempre com motivo. O
// servidor não deixa sobrepor dois troços na mesma cidade e não mexe em meses
// já fechados. Nada se apaga (o resultado automático fica guardado).
// Interruptor PONTO_TERMINAL desligado → não aparece.
import { useState } from "react";
import { toast } from "sonner";
import { Plane } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtPTTime } from "@/lib/lisbonTime";
import { correctionRange } from "@shared/terminalWatch";

export type RhTerminalSession = {
  id: number; cityLabel: string; startedAt: string; endedAt: string | null; open: boolean; sourceLabel: string; endReasonLabel: string | null;
  endNote: string | null; countedFrom: string | null; countedUntil: string | null; countedBasis: string | null; countedLabel: string; paid: boolean;
  payUplift: boolean; needsReview: boolean; claimUnproven: boolean; reviewNote: string | null; autoCountedUntil: string | null;
  autoCountedBasis: string | null; closedMonth: string | null;
};

const ms = (v: string | null | undefined): number => {
  if (!v) return NaN;
  return Date.parse(v.includes("T") ? v : v.replace(" ", "T") + "Z");
};

/** Os troços de terminal da ficha (últimos 45 dias). Erro ≠ vazio: quem usa mostra o erro (`error`). */
export function useTerminalRh(employeeId: number, enabled: boolean) {
  const q = trpc.terminal.rh.list.useQuery({ employeeId }, { enabled, retry: false, staleTime: 30_000 });
  return {
    enabled: !!q.data?.enabled, canManage: !!q.data?.canManage, sessions: (q.data?.sessions ?? []) as RhTerminalSession[],
    error: enabled ? q.error : null, refetch: () => q.refetch(), fetching: q.isFetching,
  };
}

/** Os troços que tocam o turno [inAt, outAt] (sem saída = até agora). */
export function sessionsInShift(list: RhTerminalSession[], inAt: string | null | undefined, outAt: string | null | undefined): RhTerminalSession[] {
  const a = ms(inAt ?? null), b = outAt ? ms(outAt) : Date.now();
  if (!Number.isFinite(a)) return [];
  return list.filter((s) => ms(s.startedAt) < b && (s.endedAt ? ms(s.endedAt) : Date.now()) > a);
}

type Mode = { kind: "confirm" | "correct" | "reject"; s: RhTerminalSession };

export function TerminalShiftSessions({ sessions, canManage }: { sessions: RhTerminalSession[]; canManage: boolean }) {
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<Mode | null>(null);
  const [note, setNote] = useState("");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const done = (r: { message: string }) => {
    toast.success(r.message);
    setMode(null); setNote("");
    utils.terminal.rh.list.invalidate();
    utils.rh.payroll.invalidate();
  };
  const onError = (e: { message: string }) => toast.error(e.message, { duration: 10000 });
  const confirm = trpc.terminal.rh.confirm.useMutation({ onSuccess: done, onError });
  const correct = trpc.terminal.rh.correct.useMutation({ onSuccess: done, onError });
  const reject = trpc.terminal.rh.reject.useMutation({ onSuccess: done, onError });
  const pending = confirm.isPending || correct.isPending || reject.isPending;
  if (!sessions.length) return null;

  const open = (kind: Mode["kind"], s: RhTerminalSession) => {
    setNote("");
    setFrom(fmtPTTime(s.countedFrom ?? s.startedAt));
    setUntil(fmtPTTime(s.countedUntil ?? s.endedAt ?? s.startedAt));
    setMode({ kind, s });
  };
  const range = mode?.kind === "correct" ? correctionRange(mode.s.startedAt, from, until) : null;
  const submit = () => {
    if (!mode) return;
    const n = note.trim();
    if (mode.kind === "confirm") confirm.mutate({ sessionId: mode.s.id, note: n });
    else if (mode.kind === "reject") reject.mutate({ sessionId: mode.s.id, note: n });
    else if (range) correct.mutate({ sessionId: mode.s.id, from: range.from, until: range.until, note: n });
  };

  return (
    <div className="mt-1 space-y-1" onClick={(e) => e.stopPropagation()}>
      {sessions.map((s) => {
        const tone = s.countedBasis === "rejected" ? "border-border text-muted-foreground" : s.needsReview ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100" : "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-100";
        return (
          <div key={s.id} className={`rounded border px-2 py-1 text-[11px] ${tone}`}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <Plane className="h-3 w-3" aria-hidden />
              <span className="font-medium">Terminal {s.cityLabel} {fmtPTTime(s.startedAt)}–{s.endedAt ? fmtPTTime(s.endedAt) : "agora"}</span>
              <span>· {s.countedLabel}</span>
              {s.claimUnproven && <span>· disse "Ainda estou" sem prova — o resto está por confirmar</span>}
              {!s.payUplift && <span className="text-muted-foreground">· sem nível +1 (não é extra)</span>}
            </div>
            <div className="text-muted-foreground">
              {s.sourceLabel}{s.endReasonLabel ? ` · ${s.endReasonLabel}` : ""}{s.endNote ? ` · ${s.endNote}` : ""}
              {s.reviewNote ? ` · motivo do RH: ${s.reviewNote}` : ""}
              {s.autoCountedBasis && s.autoCountedBasis !== s.countedBasis ? ` · antes: ${s.autoCountedBasis === "pending" ? "por confirmar" : `até ${s.autoCountedUntil ? fmtPTTime(s.autoCountedUntil) : "?"}`}` : ""}
              {s.closedMonth ? ` · ordenado de ${s.closedMonth} fechado` : ""}
            </div>
            {canManage && !s.open && !s.closedMonth && (
              <div className="mt-0.5 flex flex-wrap gap-1">
                {s.countedBasis !== "confirmed" && <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled={pending} onClick={() => open("confirm", s)}>Confirmar</Button>}
                <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled={pending} onClick={() => open("correct", s)}>Corrigir horas</Button>
                {s.countedBasis !== "rejected" && <Button size="sm" variant="ghost" className="h-6 text-[11px]" disabled={pending} onClick={() => open("reject", s)}>Desmarcar</Button>}
              </div>
            )}
          </div>
        );
      })}
      <Dialog open={!!mode} onOpenChange={(o) => { if (!o) setMode(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{mode?.kind === "confirm" ? "Confirmar o terminal" : mode?.kind === "correct" ? "Corrigir as horas de terminal" : "Desmarcar o terminal"}</DialogTitle>
            <DialogDescription>
              {mode?.kind === "confirm" ? `Conta o troço todo (${mode ? `${fmtPTTime(mode.s.startedAt)}–${fmtPTTime(mode.s.endedAt)}` : ""}).`
                : mode?.kind === "correct" ? "Conta só entre estas horas (hora de Lisboa). Não pode sobrepor outro troço na mesma cidade."
                  : "Nenhuma hora deste troço paga terminal."}
              {mode && !mode.s.payUplift ? " Esta pessoa não é extra: o valor não muda." : ""}
            </DialogDescription>
          </DialogHeader>
          {mode?.kind === "correct" && (
            <div className="grid max-w-xs grid-cols-2 gap-2">
              <div className="space-y-1"><Label htmlFor="term-from">Das</Label><Input id="term-from" type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full" /></div>
              <div className="space-y-1"><Label htmlFor="term-until">Às</Label><Input id="term-until" type="time" value={until} onChange={(e) => setUntil(e.target.value)} className="w-full" /></div>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="term-note">Motivo</Label>
            <Textarea id="term-note" rows={2} value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} placeholder="ex.: confirmado com o TL — esteve no terminal até às 18h" />
          </div>
          <p className="text-[11px] text-muted-foreground">Fica registado quem mudou, quando e porquê. Nada se apaga.</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMode(null)}>Cancelar</Button>
            <Button disabled={pending || note.trim().length < 3 || (mode?.kind === "correct" && !range)} onClick={submit}>
              {mode?.kind === "confirm" ? "Confirmar" : mode?.kind === "correct" ? "Corrigir" : "Desmarcar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
