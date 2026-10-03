/**
 * "Foi um acidente?" na ocorrência da app Multipark (P3 lote 22c, D15 — Jorge,
 * 3 out 2026: acidente = −6000 pontos na avaliação).
 *
 * Só conta depois de um team leader (ou acima) confirmar quem conduzia. A
 * sugestão são os agentes das últimas ações na reserva antes da ocorrência.
 * Desfazer não apaga: fica no histórico com quem e porquê.
 */
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Undo2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EVALUATION_POINTS } from "@shared/evaluationRules";
import { movementLabel } from "@shared/multiparkMovements";

const PTS = new Intl.NumberFormat("pt-PT").format(EVALUATION_POINTS.accidentOrDamage);
const fmtDay = (d: string | null | undefined) => (d ? d.split("-").reverse().join("/") : "—");
/** "YYYY-MM-DD HH:MM:SS" (UTC, da BD) → data/hora de Lisboa. */
const fmtUtc = (v: string | null | undefined) => (v ? fmtPTDateTime(`${v.slice(0, 19).replace(" ", "T")}Z`) : "—");

export function AccidentConfirmPanel({ occurrenceId }: { occurrenceId: string }) {
  const utils = trpc.useUtils();
  const q = trpc.incidents.accident.useQuery({ occurrenceId }, { retry: false });
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [sure, setSure] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [reason, setReason] = useState("");
  const refresh = () => { void utils.incidents.accident.invalidate({ occurrenceId }); void utils.incidents.multipark.invalidate(); };
  const confirm = trpc.incidents.confirmAccident.useMutation({
    onSuccess: (r) => { toast.success(`Acidente confirmado: ${PTS} pontos na avaliação de ${fmtDay(r.day)}.`); setSure(false); setNote(""); refresh(); },
    onError: (e) => { toast.error(e.message); setSure(false); refresh(); },
  });
  const undo = trpc.incidents.voidAccident.useMutation({
    onSuccess: () => { toast.success("Confirmação desfeita: deixa de contar na avaliação."); setUndoOpen(false); setReason(""); refresh(); },
    onError: (e) => { toast.error(e.message); refresh(); },
  });

  if (q.isLoading) return <p className="text-xs text-muted-foreground">A ver se há acidente confirmado…</p>;
  if (q.error) return <QueryErrorNote error={q.error} what="o acidente desta ocorrência" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const d = q.data;
  if (!d || !d.available) return null;

  const history = d.history.length > 0 && (
    <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
      {d.history.map((h) => (
        <li key={h.id} className="break-words">
          Desfeito: {h.employeeName ?? `#${h.employeeId}`} ({fmtDay(h.day)}) · por {h.voidedByName ?? "—"} em {fmtUtc(h.voidedAt)}{h.voidReason ? ` — ${h.voidReason}` : ""}
        </li>
      ))}
    </ul>
  );

  if (d.active) {
    const a = d.active;
    return (
      <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            <p><span className="font-semibold">Acidente confirmado</span>: {PTS} pontos a <span className="font-semibold">{a.employeeName ?? `#${a.employeeId}`}</span> na avaliação de {fmtDay(a.day)}.</p>
            <p className="text-xs">Confirmado por {a.confirmedByName ?? "—"} em {fmtUtc(a.confirmedAt)}.{a.note ? ` Nota: ${a.note}` : ""}</p>
            {d.canConfirm && !undoOpen && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setUndoOpen(true)}><Undo2 className="w-3 h-3 mr-1" /> Desfazer</Button>
            )}
            {d.canConfirm && undoOpen && (
              <div className="flex flex-wrap items-end gap-2 pt-1">
                <div className="min-w-0 flex-1 basis-48 space-y-1">
                  <Label htmlFor={`undo-${a.id}`} className="text-xs">Porquê?</Label>
                  <Input id={`undo-${a.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} placeholder="ex.: não era ele quem conduzia" className="h-8 bg-white" />
                </div>
                <Button size="sm" className="h-8" disabled={undo.isPending || reason.trim().length < 3} onClick={() => undo.mutate({ id: a.id, reason: reason.trim() })}>
                  {undo.isPending ? "A desfazer…" : "Desfazer"}
                </Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={() => { setUndoOpen(false); setReason(""); }}>Cancelar</Button>
              </div>
            )}
            {history}
          </div>
        </div>
      </div>
    );
  }

  // Os acidentes só contam a partir de 3 out 2026 (os antigos não contam).
  if (d.tooOld) {
    return d.looksLikeAccident || d.history.length > 0 ? (
      <div className="text-xs text-muted-foreground">
        <p>Ocorrência anterior a {fmtDay(d.countsFrom)}: os acidentes só contam na avaliação a partir desse dia.</p>
        {history}
      </div>
    ) : null;
  }

  if (!d.canConfirm) {
    return d.looksLikeAccident ? (
      <p className="text-xs text-muted-foreground">Se foi um acidente, um team leader confirma aqui quem conduzia ({PTS} pontos na avaliação).</p>
    ) : null;
  }

  const chosen = d.candidates.find((c) => c.employeeId === employeeId) ?? null;
  return (
    <div className={`rounded border p-3 text-sm ${d.looksLikeAccident ? "border-amber-300 bg-amber-50 text-amber-950" : "border-slate-200 bg-slate-50"}`}>
      <p className="font-semibold">Foi um acidente?</p>
      <p className="text-xs mt-0.5">Escolhe quem conduzia e confirma: conta {PTS} pontos na avaliação de {fmtDay(d.day)}. Só conta depois de confirmares.</p>
      {d.candidatesError && <p className="text-xs text-amber-800 mt-2">{d.candidatesError}</p>}
      {d.candidates.length === 0 && !d.candidatesError ? (
        <p className="text-xs text-muted-foreground mt-2">Sem movimentos nesta reserva nos 3 dias antes da ocorrência. Se souberes quem foi, faz um ajuste na Avaliação (Acidentes / danos).</p>
      ) : (
        <fieldset className="mt-2 space-y-1">
          <legend className="sr-only">Quem conduzia</legend>
          {d.candidates.map((c, i) => {
            const id = `acc-${occurrenceId}-${i}`;
            const disabled = c.employeeId == null;
            return (
              <label key={id} htmlFor={id} className={`flex items-start gap-2 rounded px-2 py-1.5 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-white"} ${employeeId != null && c.employeeId === employeeId ? "bg-white ring-1 ring-amber-400" : ""}`}>
                <input id={id} type="radio" name={`acc-${occurrenceId}`} className="mt-1" disabled={disabled} checked={employeeId != null && c.employeeId === employeeId} onChange={() => { setEmployeeId(c.employeeId); setSure(false); }} />
                <span className="min-w-0 break-words">
                  <span className="font-medium">{c.name}</span>
                  {i === 0 && <span className="ml-1 text-[11px] text-amber-800">(última ação antes da ocorrência)</span>}
                  <span className="block text-[11px] text-muted-foreground">{movementLabel(c.changeType)} · {fmtUtc(c.at)}{disabled ? " · sem ficha: liga-o à ficha no RH" : ""}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {d.candidates.some((c) => c.employeeId != null) && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-48 space-y-1">
            <Label htmlFor={`acc-note-${occurrenceId}`} className="text-xs">Nota (opcional)</Label>
            <Input id={`acc-note-${occurrenceId}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="h-8 bg-white" />
          </div>
          {!sure ? (
            <Button size="sm" className="h-8" disabled={!chosen} onClick={() => setSure(true)}>Confirmar acidente</Button>
          ) : (
            <>
              <Button size="sm" variant="destructive" className="h-8" disabled={confirm.isPending || !chosen}
                onClick={() => chosen?.employeeId != null && confirm.mutate({ occurrenceId, employeeId: chosen.employeeId, note: note.trim() || undefined })}>
                {confirm.isPending ? "A confirmar…" : `Sim, ${PTS} a ${chosen?.name ?? ""}`}
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setSure(false)}>Cancelar</Button>
            </>
          )}
        </div>
      )}
      {history}
    </div>
  );
}
