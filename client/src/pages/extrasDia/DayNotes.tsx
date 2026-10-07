/**
 * Extras-dia → Pressão: notas internas do dia de trabalho (pedido 4, Jorge
 * 7 out 2026: "ao selecionar o dia, aparece a info e deve dar para guardar
 * várias notas para esse dia"). Várias notas por (cidade, dia), hora
 * opcional, autor e hora de escrita; arquivar = o autor ou admin+. Regras:
 * shared/extrasDayNotes.ts; dados: extrasDia.dayNotes.*.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Archive, ChevronLeft, ChevronRight, NotebookPen } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { useConfirm } from "../training/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { addDays } from "@shared/lisbonDay";
import { fmtDayPt } from "@shared/extrasSchedule";
import { DAY_NOTE_HOURS, DAY_NOTE_MAX_CHARS, dayNoteHourLabel, sortDayNotes } from "@shared/extrasDayNotes";

type CityId = "lisbon" | "porto" | "faro";

export interface DayNoteView {
  id: number;
  workDate: string;
  hour: number | null;
  body: string;
  authorName: string | null;
  createdAt: string;
  canArchive: boolean;
}

/** Uma nota (autor · quando · hora) — partilhada pelo cartão do dia e pelo detalhe da célula. */
export function DayNoteItem({ note, showDate, onArchive, archiving }: { note: DayNoteView; showDate?: boolean; onArchive?: () => void; archiving?: boolean }) {
  return (
    <li className="rounded-md border bg-background px-2.5 py-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {showDate && <span className="font-medium text-foreground">{fmtDayPt(note.workDate)}</span>}
        {note.hour != null && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{dayNoteHourLabel(note.hour)}</Badge>}
        <span>{note.authorName ?? "—"} · {fmtPTDateTime(note.createdAt)}</span>
        {onArchive && note.canArchive && (
          <Button
            type="button" size="sm" variant="ghost" className="ml-auto h-6 px-1.5 text-[11px]"
            disabled={archiving} onClick={onArchive} aria-label="Arquivar nota" title="Arquivar (deixa de aparecer; fica no registo)"
          >
            <Archive className="h-3 w-3" />
          </Button>
        )}
      </div>
      <p className="mt-0.5 whitespace-pre-wrap break-words">{note.body}</p>
    </li>
  );
}

/**
 * Cartão "Notas do dia DD/MM" com o seletor de dia (por omissão o dia da
 * escala da página). Quem edita o Extras-dia escreve; quem só vê, lê.
 */
export function DayNotesCard({
  city,
  date,
  defaultDate,
  onDateChange,
  canEdit,
}: {
  city: CityId;
  date: string;
  /** O dia da escala da página (botão "voltar ao dia da escala"). */
  defaultDate: string;
  onDateChange: (date: string) => void;
  canEdit: boolean;
}) {
  const utils = trpc.useUtils();
  const q = trpc.extrasDia.dayNotes.list.useQuery({ city, from: date, to: date }, { enabled: !!date });
  const [body, setBody] = useState("");
  const [hour, setHour] = useState<string>("day");
  const [confirmArchive, confirmUi] = useConfirm();
  const refresh = () => utils.extrasDia.dayNotes.list.invalidate();
  const add = trpc.extrasDia.dayNotes.add.useMutation({
    onSuccess: () => { setBody(""); setHour("day"); refresh(); toast.success("Nota guardada."); },
    onError: (e) => toast.error(e.message),
  });
  const archive = trpc.extrasDia.dayNotes.archive.useMutation({
    onSuccess: () => { refresh(); toast.success("Nota arquivada."); },
    onError: (e) => toast.error(e.message),
  });
  const notes = sortDayNotes(q.data ?? []);
  const askArchive = async (n: DayNoteView) => {
    const ok = await confirmArchive({
      title: "Arquivar esta nota?",
      description: "Deixa de aparecer no dia. Fica guardada no registo de atividade.",
      confirmLabel: "Arquivar",
      destructive: true,
    });
    if (ok) archive.mutate({ id: n.id });
  };
  const trimmed = body.trim();

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <NotebookPen className="h-4 w-4 text-blue-600" />
            Notas do dia {date ? `${date.slice(8, 10)}/${date.slice(5, 7)}` : ""}
            {date && <span className="text-sm font-normal text-muted-foreground">({fmtDayPt(date).split(" ")[0]})</span>}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label="Dia anterior" onClick={() => onDateChange(addDays(date, -1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Input
              type="date" className="h-8 w-[9.5rem]" value={date} aria-label="Dia das notas"
              onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onDateChange(e.target.value); }}
            />
            <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label="Dia seguinte" onClick={() => onDateChange(addDays(date, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            {defaultDate && date !== defaultDate && (
              <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={() => onDateChange(defaultDate)}>Dia da escala</Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Notas internas sobre este dia de trabalho (03h → 03h), só para a equipa. Aparecem também no detalhe das células do mapa com o mesmo dia da semana.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {confirmUi}
        {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="as notas do dia" />}
        {q.isLoading && <div className="text-sm text-muted-foreground">A carregar…</div>}
        {!q.isLoading && !q.error && notes.length === 0 && (
          <p className="text-sm text-muted-foreground">Sem notas para este dia.</p>
        )}
        {notes.length > 0 && (
          <ul className="space-y-1.5">
            {notes.map((n) => (
              <DayNoteItem key={n.id} note={n} onArchive={canEdit ? () => void askArchive(n) : undefined} archiving={archive.isPending} />
            ))}
          </ul>
        )}
        {canEdit && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-2">
            <Label htmlFor="day-note-body" className="text-xs">Nova nota</Label>
            <Textarea
              id="day-note-body" rows={2} maxLength={DAY_NOTE_MAX_CHARS} value={body}
              placeholder="Ex.: 2 extras faltaram; muito trânsito na 2.ª circular entre as 18h e as 20h…"
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Select value={hour} onValueChange={setHour}>
                <SelectTrigger className="h-8 w-44" aria-label="Hora da nota"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Dia todo</SelectItem>
                  {DAY_NOTE_HOURS.map((h) => <SelectItem key={h} value={String(h)}>Às {dayNoteHourLabel(h)}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button
                size="sm" disabled={!trimmed || add.isPending || !date}
                onClick={() => add.mutate({ city, workDate: date, hour: hour === "day" ? null : Number(hour), body: trimmed })}
              >
                {add.isPending ? "A guardar…" : "Guardar nota"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
