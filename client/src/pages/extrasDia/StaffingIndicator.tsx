/**
 * Extras-dia — indicador de necessidade de pessoal (pedido 7, Jorge 7 out
 * 2026). Por hora: "precisas N (além do TL) · escalados M · disponíveis por
 * escalar K". Regras: shared/extrasStaffing.ts; dados: extrasDia.staffing (a
 * mesma leitura da disponibilidade que a proposta automática usa).
 *
 * Jorge, 21 out 2026: com gente suficiente por escalar NÃO é "faltam
 * condutores" — é uma nota neutra "por escalar" (sem alarme). O aviso (âmbar
 * se ainda há alguém, vermelho se ninguém) fica só para as horas em que, mesmo
 * escalando todos os disponíveis, continua a faltar gente.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, UserPlus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import {
  describeFillableGap,
  describeStaffingGap,
  describeStaffingHour,
  isFillableGap,
  shortHours,
  splitStaffingGaps,
  staffingGaps,
  staffingHourState,
  type StaffingGap,
  type StaffingHour,
} from "@shared/extrasStaffing";

type CityId = "lisbon" | "porto" | "faro";

const hourLabel = (h: number) => (h < 24 ? `${String(h).padStart(2, "0")}h` : `${String(h - 24).padStart(2, "0")}h+1`);

const STATE_CLS: Record<ReturnType<typeof staffingHourState>, string> = {
  ok: "text-emerald-700 dark:text-emerald-300",
  fillable: "text-sky-800 dark:text-sky-300",
  short: "text-red-700 dark:text-red-300",
  idle: "text-muted-foreground",
};

/**
 * As faltas (agrupadas). Falta a sério: vermelho sem ninguém, âmbar quando há
 * alguém mas não chega. Com gente que chegue é só "por escalar" (neutro).
 */
export function StaffingGapList({ gaps, className = "" }: { gaps: readonly StaffingGap[]; className?: string }) {
  if (!gaps.length) return null;
  return (
    <ul className={`space-y-0.5 ${className}`}>
      {gaps.map((g) => {
        const fillable = isFillableGap(g);
        return (
          <li key={`${g.fromHour}-${g.toHour}`} className={`flex items-start gap-1.5 ${fillable ? "text-muted-foreground" : ""}`}>
            {fillable
              ? <UserPlus className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
              : g.available.length > 0
                ? <UserPlus className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-700" aria-hidden />
                : <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-red-600" aria-hidden />}
            <span>{fillable ? describeFillableGap(g) : describeStaffingGap(g)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Aviso + indicador por hora de um turno (na secção "Equipa"). Vermelho/âmbar
 * só quando falta gente mesmo escalando os disponíveis; com gente que chegue
 * é uma nota neutra "por escalar". O detalhe hora a hora abre-se à mão.
 */
export function StaffingBanner({ date, city, fromHour, toHour }: { date: string; city: CityId; fromHour: number; toHour: number }) {
  const q = trpc.extrasDia.staffing.useQuery({ date, city }, { enabled: !!date });
  const [open, setOpen] = useState(false);
  const hours = useMemo<StaffingHour[]>(
    () => (q.data?.hours ?? []).filter((h) => h.hour >= fromHour && h.hour < toHour),
    [q.data, fromHour, toHour],
  );
  // As faltas deste turno (recalculadas só com as horas do turno: uma falta 14h–16h fica dividida pelos dois).
  const gaps = useMemo<StaffingGap[]>(
    () => staffingGaps(hours, (q.data?.people ?? []).map((p) => ({ id: p.id, name: p.name, windows: [] }))),
    [hours, q.data],
  );
  const { short, fillable } = useMemo(() => splitStaffingGaps(gaps), [gaps]);
  const nameOf = useMemo(() => new Map((q.data?.people ?? []).map((p) => [p.id, p.name.split(/\s+/)[0] || p.name])), [q.data]);

  if (q.error) return <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="a falta de gente por hora" />;
  if (!q.data || !gaps.length) return null;
  const isShort = short.length > 0;
  const nobody = isShort && short.every((g) => g.available.length === 0);
  const hoursShort = shortHours(hours).length;
  const withNeed = hours.filter((h) => h.needed > 0);

  const boxCls = !isShort
    ? "border-border bg-muted/40 text-foreground"
    : nobody
      ? "border-red-300 bg-red-50/60 text-red-900 dark:bg-red-950/30 dark:text-red-200"
      : "border-amber-300 bg-amber-50/60 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100";

  return (
    <div className={`rounded-md border p-3 text-sm ${boxCls}`}>
      {isShort ? (
        <>
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" /> Faltam condutores em {hoursShort} hora(s) deste turno
          </div>
          <StaffingGapList gaps={short} className="mt-1 text-xs" />
          {fillable.length > 0 && (
            <div className="mt-2 text-xs">
              <div className="text-muted-foreground">Por escalar (há quem possa):</div>
              <StaffingGapList gaps={fillable} className="mt-0.5" />
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 font-medium text-muted-foreground">
            <UserPlus className="h-4 w-4" /> Por escalar neste turno (há quem possa)
          </div>
          <StaffingGapList gaps={fillable} className="mt-1 text-xs" />
        </>
      )}
      {q.data.incomplete && <div className="mt-1 text-[11px] opacity-80">Atenção: {q.data.incomplete}.</div>}
      <button
        type="button"
        className="mt-2 inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Ver hora a hora
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 text-xs">
          {withNeed.map((h) => (
            <li key={h.hour} className={STATE_CLS[staffingHourState(h)]}>
              <span className="font-mono">{hourLabel(h.hour)}</span>: {describeStaffingHour(h)}
              {h.availableIds.length > 0 && h.scheduled < h.needed && (
                <span className="text-muted-foreground"> ({h.availableIds.map((id) => nameOf.get(id) ?? `#${id}`).join(", ")})</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
