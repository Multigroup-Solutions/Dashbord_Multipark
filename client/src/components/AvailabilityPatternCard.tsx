/**
 * Dias livres HABITUAIS (Jorge, 8 out 2026): "um esboço da escala dele, onde
 * ele pode colocar os dias que tem livres. Não precisa de ser os dias exatos."
 *
 *  - `MyAvailabilityPatternCard` — topo de /disponibilidade (a própria pessoa,
 *    também com a ficha inativa: candidatos e inativos que voltam);
 *  - `EmployeeAvailabilityPattern` — cartão Disponibilidade da ficha no RH
 *    (só leitura para quem só vê; editável para quem pode editar);
 *  - `HabitualLine` — "Habitual: Ter tarde · Fins de semana" nas listas da
 *    gestão, para quem ainda não preencheu a semana concreta.
 * Regras (resumo, atalhos, turnos) em shared/availabilityPattern.ts. É só uma
 * dica: nada daqui muda nenhuma escala.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { CalendarHeart, Check, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { isForbidden } from "@/lib/queryRetry";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import {
  PATTERN_DAYS,
  PATTERN_DAY_LABELS,
  PATTERN_NOTE_MAX,
  PATTERN_PERIODS,
  PATTERN_PERIOD_LABELS,
  PATTERN_SHORTCUTS,
  applyShortcut,
  hasSlot,
  normalizeSlots,
  serializeSlots,
  shortcutActive,
  summarizePattern,
  toggleSlot,
  type PatternSlots,
} from "@shared/availabilityPattern";

type PatternData = {
  slots: PatternSlots;
  note: string | null;
  summary: string;
  updatedAt: string | null;
  updatedByName: string | null;
  own?: boolean;
  canEdit?: boolean;
};

/** Grelha 7 dias × 3 períodos + atalhos + nota. Toques grandes no telemóvel. */
export function PatternEditor({
  slots,
  note,
  onSlots,
  onNote,
  disabled,
}: {
  slots: PatternSlots;
  note: string;
  onSlots: (next: PatternSlots) => void;
  onNote: (next: string) => void;
  disabled?: boolean;
}) {
  const noteId = useId();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Atalhos">
        {PATTERN_SHORTCUTS.map((s) => {
          const on = s.id !== "clear" && shortcutActive(slots, s.id);
          return (
            <Button
              key={s.id}
              type="button"
              size="sm"
              variant={on ? "selected" : "outline"}
              className="h-9"
              disabled={disabled}
              aria-pressed={s.id === "clear" ? undefined : on}
              onClick={() => onSlots(applyShortcut(slots, s.id))}
            >
              {s.label}
            </Button>
          );
        })}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-sm">
          <thead>
            <tr>
              <th className="w-14" aria-hidden />
              {PATTERN_PERIODS.map((p) => (
                <th key={p} scope="col" className="font-medium text-center">
                  <span className="block">{PATTERN_PERIOD_LABELS[p].label}</span>
                  <span className="block text-[11px] font-normal text-muted-foreground">{PATTERN_PERIOD_LABELS[p].hours}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PATTERN_DAYS.map((d) => (
              <tr key={d}>
                <th scope="row" className="pr-1 text-left font-medium">
                  <span className="sm:hidden">{PATTERN_DAY_LABELS[d].short}</span>
                  <span className="hidden sm:inline">{PATTERN_DAY_LABELS[d].long}</span>
                </th>
                {PATTERN_PERIODS.map((p) => {
                  const on = hasSlot(slots, d, p);
                  return (
                    <td key={p} className="p-0">
                      <button
                        type="button"
                        disabled={disabled}
                        aria-pressed={on}
                        aria-label={`${PATTERN_DAY_LABELS[d].long} ${PATTERN_PERIOD_LABELS[p].word}`}
                        onClick={() => onSlots(toggleSlot(slots, d, p))}
                        className={`flex h-11 w-full items-center justify-center rounded-md border text-sm transition-colors disabled:opacity-60 ${
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input bg-background text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        {on ? <Check className="h-4 w-4" aria-hidden /> : <span aria-hidden>—</span>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor={noteId}>
          Nota (opcional) — ex.: "não posso em agosto", "só depois das 20h às sextas"
        </label>
        <Textarea
          id={noteId}
          value={note}
          maxLength={PATTERN_NOTE_MAX}
          disabled={disabled}
          rows={2}
          onChange={(e) => onNote(e.target.value)}
        />
      </div>
    </div>
  );
}

function UpdatedLine({ data }: { data: PatternData }) {
  if (!data.updatedAt) return null;
  const by = data.updatedByName && data.own === false ? ` por ${data.updatedByName}` : "";
  return <p className="text-[11.5px] text-muted-foreground">Atualizado em {fmtPTDateTime(data.updatedAt)}{by}.</p>;
}

/** Estado local da edição (parte do que veio do servidor). */
function usePatternDraft(data: PatternData | undefined) {
  const [slots, setSlots] = useState<PatternSlots>({});
  const [note, setNote] = useState("");
  const savedKey = data ? `${serializeSlots(data.slots)}|${data.note ?? ""}` : "";
  useEffect(() => {
    if (!data) return;
    setSlots(normalizeSlots(data.slots));
    setNote(data.note ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  const dirty = !!data && `${serializeSlots(slots)}|${note.trim()}` !== `${serializeSlots(data.slots)}|${(data.note ?? "").trim()}`;
  const summary = useMemo(() => summarizePattern(slots), [slots]);
  return { slots, setSlots, note, setNote, dirty, summary };
}

/** Topo de /disponibilidade: os dias livres habituais da própria pessoa. */
export function MyAvailabilityPatternCard() {
  const utils = trpc.useUtils();
  const q = trpc.extrasAvailability.myPattern.useQuery(undefined, { retry: false });
  const draft = usePatternDraft(q.data);
  const save = trpc.extrasAvailability.setMyPattern.useMutation({
    onSuccess: (r) => {
      utils.extrasAvailability.myPattern.setData(undefined, r);
      toast.success("Dias habituais guardados. Obrigado!");
    },
    onError: (e) => toast.error(e.message),
  });

  // Sem ficha ligada: a disponibilidade da semana, por baixo, já explica o que fazer.
  if (q.error && isForbidden(q.error)) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarHeart className="h-5 w-5 text-primary" />
          Os meus dias livres habituais
        </CardTitle>
        <CardDescription>
          Não precisam de ser datas: marca os dias e as alturas em que costumas estar livre (ex.: terças à tarde,
          quartas de manhã e todos os fins de semana). Ajuda a gestão a lembrar-se de ti. A disponibilidade de cada
          semana marca-se por baixo, como sempre.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading ? (
          <div className="py-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : q.error ? (
          <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="os teus dias habituais" />
        ) : (
          <>
            <PatternEditor
              slots={draft.slots}
              note={draft.note}
              onSlots={draft.setSlots}
              onNote={draft.setNote}
              disabled={save.isPending}
            />
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Resumo: </span>
              <span className="font-medium">{draft.summary || "ainda nenhum dia marcado"}</span>
            </div>
            {q.data && <UpdatedLine data={q.data} />}
            <div className="flex justify-end">
              <Button
                disabled={save.isPending || !draft.dirty}
                onClick={() => save.mutate({ slots: draft.slots, note: draft.note.trim() || null })}
              >
                {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {draft.dirty || !q.data?.updatedAt ? "Guardar dias habituais" : "Guardado"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Ficha no RH (cartão Disponibilidade): o resumo dos dias habituais e, para
 * quem pode editar (a própria pessoa ou quem gere a disponibilidade dos
 * extras), o botão para os mudar.
 */
export function EmployeeAvailabilityPattern({ employeeId }: { employeeId: number }) {
  const utils = trpc.useUtils();
  const q = trpc.extrasAvailability.patternFor.useQuery({ employeeId }, { retry: false });
  const [editing, setEditing] = useState(false);
  const draft = usePatternDraft(q.data);
  const done = () => {
    setEditing(false);
    toast.success("Dias habituais guardados.");
    void utils.extrasAvailability.invalidate();
  };
  const saveMine = trpc.extrasAvailability.setMyPattern.useMutation({ onSuccess: done, onError: (e) => toast.error(e.message) });
  const saveFor = trpc.extrasAvailability.setPatternFor.useMutation({ onSuccess: done, onError: (e) => toast.error(e.message) });
  const pending = saveMine.isPending || saveFor.isPending;

  if (q.isLoading) return <p className="text-sm text-muted-foreground">A carregar os dias habituais…</p>;
  if (q.error) return isForbidden(q.error) ? null : <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="os dias habituais" />;
  const d = q.data;
  if (!d) return null;

  function submit() {
    const payload = { slots: draft.slots, note: draft.note.trim() || null };
    if (d!.own) saveMine.mutate(payload);
    else saveFor.mutate({ ...payload, employeeId });
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Dias livres habituais</p>
          <p className="text-sm [overflow-wrap:anywhere]">
            {d.summary || <span className="text-muted-foreground">{d.own ? "Ainda não indicaste." : "Não indicou."}</span>}
          </p>
          {d.note && <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">Nota: {d.note}</p>}
          <UpdatedLine data={d} />
        </div>
        {d.canEdit && !editing && (
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5 mr-1.5" />{d.summary || d.note ? "Mudar" : "Indicar"}
          </Button>
        )}
      </div>
      {editing && (
        <div className="space-y-3 border-t pt-3">
          <PatternEditor slots={draft.slots} note={draft.note} onSlots={draft.setSlots} onNote={draft.setNote} disabled={pending} />
          <p className="text-xs text-muted-foreground">Resumo: <span className="font-medium text-foreground">{draft.summary || "nenhum dia"}</span></p>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => { setEditing(false); draft.setSlots(normalizeSlots(d.slots)); draft.setNote(d.note ?? ""); }}
            >
              Cancelar
            </Button>
            <Button size="sm" disabled={pending || !draft.dirty} onClick={submit}>
              {pending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Guardar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Habitual: Ter tarde · Fins de semana" (linha pequena nas listas da gestão). */
export function HabitualLine({ habitual, note }: { habitual: string | null | undefined; note?: string | null }) {
  if (!habitual && !note) return null;
  return (
    <span
      className="block max-w-[18rem] truncate text-[11px] text-sky-700 dark:text-sky-300"
      title={`Dias livres habituais (só uma dica): ${habitual || "—"}${note ? ` — ${note}` : ""}`}
    >
      Habitual: {habitual || "ver nota"}
    </span>
  );
}
