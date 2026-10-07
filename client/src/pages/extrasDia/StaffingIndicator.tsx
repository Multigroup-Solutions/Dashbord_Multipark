/**
 * Extras-dia — indicador de necessidade de pessoal (pedido 7, Jorge 7 out
 * 2026). Por hora: "precisas N (além do TL) · escalados M · disponíveis por
 * escalar K", e o aviso distingue "Faltam escalar 2 às 02h (há 2 disponíveis:
 * Ana, Rui)" de "Falta gente às 02h (ninguém disponível)". Regras:
 * shared/extrasStaffing.ts; dados: extrasDia.staffing (a mesma leitura da
 * disponibilidade que a proposta automática usa).
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, UserPlus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { describeStaffingGap, describeStaffingHour, staffingGaps, staffingHourState, type StaffingGap, type StaffingHour } from "@shared/extrasStaffing";

type CityId = "lisbon" | "porto" | "faro";

const hourLabel = (h: number) => (h < 24 ? `${String(h).padStart(2, "0")}h` : `${String(h - 24).padStart(2, "0")}h+1`);

const STATE_CLS: Record<ReturnType<typeof staffingHourState>, string> = {
  ok: "text-emerald-700 dark:text-emerald-300",
  fillable: "text-amber-800 dark:text-amber-300",
  short: "text-red-700 dark:text-red-300",
  idle: "text-muted-foreground",
};

/** Os avisos de falta (agrupados): âmbar quando há quem escalar, vermelho quando não há ninguém. */
export function StaffingGapList({ gaps, className = "" }: { gaps: readonly StaffingGap[]; className?: string }) {
  if (!gaps.length) return null;
  return (
    <ul className={`space-y-0.5 ${className}`}>
      {gaps.map((g) => (
        <li key={`${g.fromHour}-${g.toHour}`} className="flex items-start gap-1.5">
          {g.available.length > 0
            ? <UserPlus className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-700" aria-hidden />
            : <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-red-600" aria-hidden />}
          <span>{describeStaffingGap(g)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Aviso + indicador por hora de um turno (na secção "Equipa"). Mostra-se só
 * quando há faltas; o detalhe hora a hora abre-se à mão.
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
  const nameOf = useMemo(() => new Map((q.data?.people ?? []).map((p) => [p.id, p.name.split(/\s+/)[0] || p.name])), [q.data]);

  if (q.error) return <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="a falta de gente por hora" />;
  if (!q.data || !gaps.length) return null;
  const nobody = gaps.every((g) => g.available.length === 0);
  const hoursShort = hours.filter((h) => h.needed > h.scheduled).length;
  const withNeed = hours.filter((h) => h.needed > 0);

  return (
    <div className={`rounded-md border p-3 text-sm ${nobody
      ? "border-red-300 bg-red-50/60 text-red-900 dark:bg-red-950/30 dark:text-red-200"
      : "border-amber-300 bg-amber-50/60 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"}`}>
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4" /> Faltam condutores em {hoursShort} hora(s) deste turno
      </div>
      <StaffingGapList gaps={gaps} className="mt-1 text-xs" />
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
