/**
 * Perfil → "O meu horário" (plano 63, passo 10b; interruptor FINS_DE_SEMANA):
 * o horário fixo da pessoa, os próximos fins de semana (de serviço ou não) e
 * as outras exceções por data (folgas de compensação, trocas…). Só leitura.
 * Desligado ou sem ficha: não aparece.
 */
import { CalendarClock } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { OVERRIDE_REASON_LABELS, type OverrideReason } from "@shared/workSchedule";
import { dayLabelPt, isWeekendDay } from "@shared/weekendRotation";

const WEEKDAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export function MyScheduleCard() {
  const { data } = trpc.rh.weekends.mine.useQuery(undefined, { staleTime: 60_000 });
  if (!data || !data.enabled || data.employeeId == null) return null;
  const duty = data.weekends.filter((w) => w.work);
  const others = data.exceptions.filter((e) => !isWeekendDay(e.day));
  const hasFixed = data.fixed.some((f) => f.isWorkDay);
  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm p-3.5 space-y-3">
      <div className="flex items-center gap-3">
        <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0"><CalendarClock className="w-4 h-4" /></span>
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">O meu horário</div>
          <div className="text-[11.5px] text-muted-foreground">O fixo e os próximos fins de semana. Quem muda é o RH ou o teu supervisor.</div>
        </div>
      </div>
      {hasFixed ? (
        <div className="grid grid-cols-7 gap-1 text-center">
          {data.fixed.map((f) => (
            <div key={f.weekday} className={`rounded-lg border px-0.5 py-1.5 ${f.isWorkDay ? "" : "bg-muted/40"}`}>
              <div className="text-[11px] font-semibold text-muted-foreground">{WEEKDAY_LABELS[f.weekday]}</div>
              {f.isWorkDay ? (
                <div className="text-[11px] leading-tight text-foreground">{f.startTime}<br />{f.endTime ?? ""}</div>
              ) : <div className="text-[11px] text-muted-foreground">folga</div>}
            </div>
          ))}
        </div>
      ) : <p className="text-xs text-muted-foreground">Ainda não tens horário fixo na ficha. Fala com o RH.</p>}
      <div>
        <div className="text-[12px] font-semibold text-foreground mb-1">Próximos fins de semana</div>
        {duty.length === 0 ? (
          <p className="text-xs text-muted-foreground">Não estás de serviço nos próximos 8 fins de semana.</p>
        ) : (
          <ul className="space-y-1">
            {duty.map((w) => (
              <li key={w.day} className="flex items-center justify-between gap-2 rounded-lg bg-primary/5 px-2.5 py-1.5 text-[12.5px]">
                <span className="font-medium">{dayLabelPt(w.day)}</span>
                <span className="text-primary font-semibold">{w.work!.startTime}–{w.work!.endTime ?? "?"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {others.length > 0 && (
        <div>
          <div className="text-[12px] font-semibold text-foreground mb-1">Outros dias diferentes</div>
          <ul className="space-y-1">
            {others.slice(0, 10).map((e) => (
              <li key={e.day} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[12.5px]">
                <span className="font-medium">{dayLabelPt(e.day)}</span>
                <span className={e.kind === "work" ? "text-primary font-semibold" : "text-amber-700 dark:text-amber-300 font-semibold"}>
                  {e.kind === "work" ? `${e.startTime}–${e.endTime}` : "Folga"}
                  <span className="ml-1 font-normal text-muted-foreground">· {OVERRIDE_REASON_LABELS[e.reason as OverrideReason] ?? e.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
