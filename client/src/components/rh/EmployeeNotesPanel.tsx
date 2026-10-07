/**
 * Notas internas da ficha (Jorge, 7 out 2026: "Os extras devem ter notas
 * internas (ex. este extra trabalhou mal no dia ...)"). Team leader e acima,
 * no âmbito de cada um; a própria pessoa nunca as vê (o servidor confirma:
 * rh.notes.*). Usado no separador "Notas internas" da ficha e no atalho da
 * linha da escala do Extras-dia (pré-preenche o dia e a linha).
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Archive, CalendarDays, Lock, Pencil } from "lucide-react";
import { isNoteKind, NOTE_BODY_MAX, NOTE_KIND_CLASSES, NOTE_KIND_LABELS, NOTE_KINDS, NOTE_PRIVACY_HINT, type NoteKind } from "@shared/employeeNotes";

const fmtDay = (day: string) => day.split("-").reverse().join("/");

function KindSelect({ value, onChange, id }: { value: NoteKind; onChange: (k: NoteKind) => void; id?: string }) {
  return (
    <Select value={value} onValueChange={(v) => isNoteKind(v) && onChange(v)}>
      <SelectTrigger id={id} className="h-9 w-full sm:w-44"><SelectValue /></SelectTrigger>
      <SelectContent>
        {NOTE_KINDS.map((k) => <SelectItem key={k} value={k}>{NOTE_KIND_LABELS[k]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function EmployeeNotesPanel({ employeeId, workDate: presetDay, assignmentId, limit, onSaved }: {
  employeeId: number;
  /** Dia de trabalho pré-preenchido (atalho do Extras-dia). */
  workDate?: string | null;
  /** Linha da escala a que a nota fica presa (atalho do Extras-dia). */
  assignmentId?: number | null;
  /** Mostra só as N mais recentes (no atalho). */
  limit?: number;
  onSaved?: () => void;
}) {
  const utils = trpc.useUtils();
  const notes = trpc.rh.notes.list.useQuery({ employeeId });
  const [kind, setKind] = useState<NoteKind>("general");
  const [body, setBody] = useState("");
  const [day, setDay] = useState(presetDay ?? "");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editKind, setEditKind] = useState<NoteKind>("general");
  const refresh = () => utils.rh.notes.list.invalidate({ employeeId });

  const add = trpc.rh.notes.add.useMutation({
    onSuccess: () => { setBody(""); setKind("general"); refresh(); toast.success("Nota guardada."); onSaved?.(); },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.rh.notes.update.useMutation({
    onSuccess: () => { setEditingId(null); refresh(); toast.success("Nota alterada."); },
    onError: (e) => toast.error(e.message),
  });
  const archive = trpc.rh.notes.archive.useMutation({
    onSuccess: () => { refresh(); toast.success("Nota arquivada."); },
    onError: (e) => toast.error(e.message),
  });

  const list = notes.data ?? [];
  const shown = limit ? list.slice(0, limit) : list;
  const trimmed = body.trim();

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={`note-kind-${employeeId}`} className="text-xs">Tipo</Label>
            <KindSelect id={`note-kind-${employeeId}`} value={kind} onChange={setKind} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`note-day-${employeeId}`} className="text-xs">Dia de trabalho (opcional)</Label>
            <Input id={`note-day-${employeeId}`} type="date" className="h-9 w-full sm:w-44" value={day} onChange={(e) => setDay(e.target.value)} />
          </div>
        </div>
        <Textarea
          aria-label="Nota interna"
          placeholder="Ex.: chegou 40 min atrasado e deixou um carro sem chave no quadro."
          value={body}
          maxLength={NOTE_BODY_MAX}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex min-w-0 flex-1 items-start gap-1 text-[11px] text-muted-foreground">
            <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            <span>Só a chefia vê (nunca a própria pessoa). {NOTE_PRIVACY_HINT}</span>
          </p>
          <Button
            size="sm"
            disabled={!trimmed || add.isPending}
            onClick={() => add.mutate({ employeeId, body: trimmed, kind, workDate: day || null, assignmentId: assignmentId ?? null })}
          >
            {add.isPending ? "A guardar…" : "Guardar nota"}
          </Button>
        </div>
      </div>

      {notes.isLoading ? (
        <p className="text-sm text-muted-foreground">A carregar notas…</p>
      ) : notes.error ? (
        <p role="alert" className="text-sm text-destructive">{notes.error.message}</p>
      ) : shown.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Sem notas internas.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((n) => {
            const k: NoteKind = isNoteKind(n.kind) ? n.kind : "general";
            const editing = editingId === n.id;
            return (
              <li key={n.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn("border-transparent text-[11px]", NOTE_KIND_CLASSES[k])}>{NOTE_KIND_LABELS[k]}</Badge>
                  {n.workDate && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Dia de trabalho">
                      <CalendarDays className="h-3 w-3" aria-hidden /> dia {fmtDay(n.workDate)}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {n.authorName ?? "—"} · {fmtPTDateTime(n.createdAt)}{n.editedAt ? " · editada" : ""}
                  </span>
                  {n.canEdit && !editing && (
                    <span className="ml-auto flex gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Editar nota" onClick={() => { setEditingId(n.id); setEditBody(n.body); setEditKind(k); }}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Arquivar nota" disabled={archive.isPending}
                        onClick={() => { if (confirm("Arquivar esta nota? Deixa de aparecer (fica no histórico).")) archive.mutate({ id: n.id }); }}>
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  )}
                </div>
                {editing ? (
                  <div className="mt-2 space-y-2">
                    <KindSelect value={editKind} onChange={setEditKind} />
                    <Textarea aria-label="Editar nota" value={editBody} maxLength={NOTE_BODY_MAX} rows={3} onChange={(e) => setEditBody(e.target.value)} />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Cancelar</Button>
                      <Button size="sm" disabled={!editBody.trim() || update.isPending} onClick={() => update.mutate({ id: n.id, body: editBody.trim(), kind: editKind })}>Guardar</Button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{n.body}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {limit && list.length > limit && (
        <p className="text-xs text-muted-foreground">+{list.length - limit} nota(s) mais antiga(s) na ficha (RH → Notas internas).</p>
      )}
    </div>
  );
}
