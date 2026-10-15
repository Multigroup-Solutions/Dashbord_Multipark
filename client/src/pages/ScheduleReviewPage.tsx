/**
 * Plano 63, passo 10a — RH → "Horários por rever". O que ver antes de ligar
 * as faltas automáticas de quem tem horário fixo (RH_FALTAS_HORARIO): quem
 * não tem horário, dias duplicados, horas que não se leem, quem não pica há
 * 14 dias (ainda na impressão digital?) e quem tem sábado ou domingo no
 * horário fixo. As listas só leem: corrige-se na ficha → Horário. A única
 * coisa que se muda aqui é a lista "Fora das faltas automáticas"
 * (rh.noShowSkip) e as possíveis faltas por validar (com motivo).
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { PendingNoShowsPanel } from "./RhDashboardPage";
import { WEEKDAY_LABELS } from "@shared/scheduleReview";
import { addDays } from "@shared/lisbonDay";
import {
  AlertTriangle, CalendarClock, CalendarOff, ChevronLeft, CircleSlash, Copy, Fingerprint, Info, Loader2, Plane, UserX,
} from "lucide-react";
import { toast } from "sonner";

const CITY_LABEL: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
const dayPt = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
/** Último dia do mês seguinte (o prazo por omissão de "Tirar das faltas"). */
const endOfNextMonth = (today: string) => {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const last = new Date(Date.UTC(y, m + 1, 0));
  return last.toISOString().slice(0, 10);
};

type Person = { employeeId: number; fullName: string; projectId?: number | null };

export default function ScheduleReviewPage({ onBack, onOpenEmployee }: { onBack: () => void; onOpenEmployee: (id: number) => void }) {
  const q = trpc.rh.schedules.review.useQuery(undefined, { staleTime: 30_000 });
  const d = q.data;
  const cityOf = (pid: number | null | undefined) => {
    const c = pid != null ? (d?.cityByProject as Record<string, string | null> | undefined)?.[String(pid)] : null;
    return c ? CITY_LABEL[c] ?? c : null;
  };
  const counts = d ? [
    { key: "noSchedule", label: "Sem horário", n: d.noSchedule.length, icon: UserX },
    { key: "duplicates", label: "Dias duplicados", n: d.duplicates.length, icon: Copy },
    { key: "invalid", label: "Horas inválidas", n: d.invalidTimes.length, icon: CircleSlash },
    { key: "noClock", label: `Sem picar há ${d.noClockInDays} dias`, n: d.noClockIn.filter((x) => !x.skipUntil).length, icon: Fingerprint },
    { key: "weekend", label: "Fim de semana no horário", n: d.weekendFixed.filter((x) => !x.skipUntil).length, icon: CalendarClock },
    { key: "skips", label: "Fora das faltas", n: d.skips.filter((x) => x.active).length, icon: CalendarOff },
  ] : [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="rounded-[10px]" onClick={onBack}><ChevronLeft className="mr-1 h-4 w-4" /> Voltar</Button>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Horários por rever</h2>
          <p className="text-xs text-muted-foreground">Antes de ligar as faltas automáticas de quem tem horário fixo. Só leitura: corrige-se na ficha → Horário.</p>
        </div>
      </div>

      {q.isLoading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> A ler os horários…</p>}
      {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="os horários" />}

      {d && (
        <>
          <section className={`rounded-[14px] border p-3 text-sm ${d.flagOn ? "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30" : "border-[#0055D2]/30 bg-[#0055D2]/5"}`}>
            <p className="flex flex-wrap items-center gap-2 font-medium">
              <Info className="h-4 w-4 shrink-0 text-[#0055D2]" />
              Faltas automáticas (horário fixo): {d.flagOn ? <Badge className="bg-amber-600 text-white">ligadas</Badge> : <Badge variant="secondary">desligadas</Badge>}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {d.flagOn
                ? "Todas as madrugadas, quem tinha horário ontem e não picou fica em \"Possíveis faltas por validar\" (0 pontos, sem bloqueio)."
                : "Ligam-se em Definições → Automações → \"RH: possíveis faltas de quem tem horário fixo\" (só o super admin). Ao ligar não acontece nada logo: na madrugada seguinte corre só para ontem."}
              {" "}Vistas {d.employeesChecked} fichas ativas (funcionários, sem extras) das tuas cidades.
            </p>
          </section>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {counts.map((c) => (
              <a key={c.key} href={`#rever-${c.key}`} className={`min-w-0 rounded-[14px] border bg-card p-3 transition-colors hover:bg-muted/40 ${c.n ? "border-amber-300 dark:border-amber-800" : ""}`}>
                <p className="flex items-center gap-1 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground"><c.icon className="h-3.5 w-3.5 shrink-0" />{c.label}</p>
                <p className={`text-xl font-bold tabular-nums ${c.n ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>{c.n}</p>
              </a>
            ))}
          </div>

          <ReviewSection id="rever-noSchedule" title="Funcionários sem horário" count={d.noSchedule.length}
            hint="Sem nenhum dia de trabalho no horário: para eles não há possível falta (nem atraso) e a folha de ordenados conta 176 h esperadas. Se trabalham com horário, preenche-o na ficha → Horário.">
            {d.noSchedule.map((p) => (
              <PersonRow key={p.employeeId} p={p} city={cityOf(p.projectId)} onOpen={onOpenEmployee}
                detail={p.onlyDaysOff ? <span className="text-amber-700 dark:text-amber-400">Horário só com folgas: a folha passou a contá-lo como sem horário (176 h esperadas; antes contava 0 h e pagava as horas todas como extra). A linha da folha mostra os dois valores.</span> : undefined} />
            ))}
          </ReviewSection>

          <ReviewSection id="rever-duplicates" title="Dias duplicados" count={d.duplicates.length}
            hint="O mesmo dia da semana em mais de uma linha. A ficha, a Avaliação, as faltas e a folha de ordenados usam a linha de trabalho mais antiga (antes, a folha usava a última: quando isso muda o valor, a linha da folha mostra os dois). Abre a ficha → Horário e carrega em Guardar nesse dia: as linhas ficam iguais (nenhuma se apaga).">
            {d.duplicates.map((x) => (
              <PersonRow key={`${x.employeeId}-${x.weekday}`} p={x} city={cityOf(x.projectId)} onOpen={onOpenEmployee}
                detail={<>{WEEKDAY_LABELS[x.weekday]}: {x.rows.map((r) => r.label).join(" · ")}{x.differ ? <span className="ml-1 font-medium text-amber-700 dark:text-amber-400">(diferentes)</span> : null}</>} />
            ))}
          </ReviewSection>

          <ReviewSection id="rever-invalid" title="Horas inválidas" count={d.invalidTimes.length}
            hint="Horas que não são HH:MM (ex.: &quot;9h&quot;) ou entrada igual à saída: a Avaliação e as faltas não as leem e a folha conta mal. Corrige na ficha → Horário.">
            {d.invalidTimes.map((x) => (
              <PersonRow key={`${x.employeeId}-${x.rowId}`} p={x} city={cityOf(x.projectId)} onOpen={onOpenEmployee}
                detail={<>{WEEKDAY_LABELS[x.weekday]}: “{x.startTime}” – “{x.endTime}” · {x.problem === "same" ? "entrada igual à saída" : "hora que não se lê"}</>} />
            ))}
          </ReviewSection>

          <ReviewSection id="rever-noClock" title={`Com horário e sem picar há ${d.noClockInDays} dias`} count={d.noClockIn.length}
            hint="Quase de certeza ainda picam na impressão digital (ou noutro sistema). Com as faltas automáticas ligadas, levavam uma possível falta por cada dia de trabalho. Tira-as das faltas até passarem a picar no nosso ponto.">
            {d.noClockIn.map((x) => (
              <PersonRow key={x.employeeId} p={x} city={cityOf(x.projectId)} onOpen={onOpenEmployee}
                detail={x.lastCheckInDay ? `Última entrada no ponto: ${dayPt(x.lastCheckInDay)} (há ${x.daysSince} dias)` : "Nenhuma entrada no ponto no último ano"}
                action={<SkipControl employeeId={x.employeeId} today={d.today} until={x.skipUntil} reason={x.skipReason} defaultReason="Ainda pica na impressão digital" />} />
            ))}
          </ReviewSection>

          <ReviewSection id="rever-weekend" title="Sábado ou domingo no horário fixo" count={d.weekendFixed.length}
            hint="O fim de semana roda. Até haver as exceções por data (fins de semana de serviço), quem tem o sábado ou o domingo no horário fixo e não está de serviço leva uma possível falta: dispensa-a, ou tira o dia do horário se não for fixo.">
            {d.weekendFixed.map((x) => (
              <PersonRow key={x.employeeId} p={x} city={cityOf(x.projectId)} onOpen={onOpenEmployee}
                detail={`${x.weekdays.map((w) => WEEKDAY_LABELS[w]).join(" e ")} no horário${x.skipUntil ? ` · fora das faltas até ${dayPt(x.skipUntil)}` : ""}`} />
            ))}
          </ReviewSection>

          <SkipsSection skips={d.skips} withSchedule={d.withSchedule} today={d.today} cityOf={cityOf} onOpen={onOpenEmployee} invalid={d.skipsInvalid} />

          <section className="rounded-[14px] border bg-card p-3 text-sm">
            <p className="flex items-center gap-2 font-medium"><Plane className="h-4 w-4 text-[#0055D2]" /> Férias deste mês</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Ausências lançadas que tocam este mês: <b className="tabular-nums text-foreground">{d.leavesThisMonth.rows}</b> ({d.leavesThisMonth.people} pessoa{d.leavesThisMonth.people === 1 ? "" : "s"}).
              Quem está de férias sem a ausência lançada leva uma possível falta por dia: dispensa-a com <b>Férias</b> (lança a ausência desse dia).
            </p>
          </section>

          {d.lostPunches.length > 0 && (
            <ReviewSection id="rever-lost" title="Dispensadas como picagem perdida (60 dias)" count={d.lostPunches.length} tone="info"
              hint="Possíveis faltas dispensadas com &quot;picou noutro sistema / picagem perdida&quot;. São a prova para a verificação do ponto (as horas que desapareceram).">
              {d.lostPunches.map((x) => (
                <PersonRow key={x.id} p={x} city={null} onOpen={onOpenEmployee} detail={`Dia ${dayPt(x.day)}`} />
              ))}
            </ReviewSection>
          )}

          <PendingNoShowsPanel onlyFixed defaultOpen={d.pendingFixed > 0} />
        </>
      )}
    </div>
  );
}

function ReviewSection({ id, title, count, hint, tone = "warn", children }: { id: string; title: string; count: number; hint: string; tone?: "warn" | "info"; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 rounded-[14px] border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {count && tone === "warn" ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /> : <Info className="h-4 w-4 shrink-0 text-[#0055D2]" />}
        <h3 className="min-w-0 flex-1 text-sm font-semibold">{title}</h3>
        <Badge variant={count ? "default" : "secondary"} className={count && tone === "warn" ? "bg-amber-600 text-white" : ""}>{count}</Badge>
      </div>
      <p className="px-3 pt-2 text-xs text-muted-foreground">{hint}</p>
      {count ? <div className="divide-y px-1 pb-1">{children}</div> : <p className="px-3 pb-3 pt-1 text-xs text-emerald-700 dark:text-emerald-400">Nada a rever.</p>}
    </section>
  );
}

function PersonRow({ p, city, detail, action, onOpen }: { p: Person; city: string | null; detail?: React.ReactNode; action?: React.ReactNode; onOpen: (id: number) => void }) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 px-2 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <button type="button" className="text-left font-medium text-[#0055D2] hover:underline dark:text-blue-400" onClick={() => onOpen(p.employeeId)}>{p.fullName}</button>
        {city && <span className="ml-1.5 text-xs text-muted-foreground">{city}</span>}
        {detail && <p className="break-words text-xs text-muted-foreground">{detail}</p>}
      </div>
      {action && <div className="w-full sm:w-auto">{action}</div>}
    </div>
  );
}

/** "Tirar das faltas até…" (rh.noShowSkip) de uma pessoa: pôr, mudar ou tirar. */
function SkipControl({ employeeId, today, until, reason, defaultReason, startOpen = false, onDone }: { employeeId: number; today: string; until: string | null; reason: string | null; defaultReason: string; startOpen?: boolean; onDone?: () => void }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(startOpen);
  const [date, setDate] = useState(until ?? endOfNextMonth(today));
  const [why, setWhy] = useState(reason ?? defaultReason);
  const save = trpc.rh.schedules.setNoShowSkip.useMutation({
    onSuccess: (r) => { utils.rh.schedules.review.invalidate(); setOpen(false); onDone?.(); toast.success(r.until ? `Fora das faltas automáticas até ${dayPt(r.until)}` : "Volta às faltas automáticas"); },
    onError: (e) => { toast.error(e.message); if (e.data?.code === "CONFLICT") utils.rh.schedules.review.invalidate(); },
  });
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {until && <span className="text-xs text-emerald-700 dark:text-emerald-400">Fora das faltas até {dayPt(until)}</span>}
        <Button size="sm" variant="outline" className="h-7 rounded-[10px] text-xs" onClick={() => { setDate(until ?? endOfNextMonth(today)); setWhy(reason ?? defaultReason); setOpen(true); }}>
          {until ? "Mudar" : "Tirar das faltas até…"}
        </Button>
        {until && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={save.isPending}
            onClick={() => { if (confirm("Voltar a contar as faltas automáticas desta pessoa?")) save.mutate({ employeeId, until: null }); }}>Tirar da lista</Button>
        )}
      </div>
    );
  }
  return (
    <form className="flex w-full flex-wrap items-end gap-2 rounded-[10px] border bg-muted/30 p-2 sm:w-auto" onSubmit={(e) => { e.preventDefault(); save.mutate({ employeeId, until: date, reason: why }); }}>
      <label className="space-y-0.5 text-xs">
        <span className="text-muted-foreground">Até (inclusive)</span>
        <Input type="date" className="h-8 w-40 rounded-[10px]" value={date} min={today} max={addDays(today, 366)} onChange={(e) => setDate(e.target.value)} required />
      </label>
      <label className="min-w-[12rem] flex-1 space-y-0.5 text-xs">
        <span className="text-muted-foreground">Motivo</span>
        <Input className="h-8 rounded-[10px]" value={why} maxLength={120} onChange={(e) => setWhy(e.target.value)} required />
      </label>
      <div className="flex gap-1">
        <Button type="submit" size="sm" className="h-8 rounded-[10px] bg-[#0055D2] text-xs text-white hover:bg-[#0047b0]" disabled={save.isPending || !date || !why.trim()}>Guardar</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={() => { setOpen(false); onDone?.(); }}>Cancelar</Button>
      </div>
    </form>
  );
}

function SkipsSection({ skips, withSchedule, today, cityOf, onOpen, invalid }: {
  skips: Array<{ employeeId: number; fullName: string; projectId: number | null; isActive: boolean; until: string; reason: string; active: boolean; byName: string | null; at: string | null }>;
  withSchedule: Array<{ employeeId: number; fullName: string }>;
  today: string;
  cityOf: (pid: number | null | undefined) => string | null;
  onOpen: (id: number) => void;
  invalid: boolean;
}) {
  const [adding, setAdding] = useState<number | null>(null);
  const listed = useMemo(() => new Set(skips.map((s) => s.employeeId)), [skips]);
  const options = withSchedule.filter((p) => !listed.has(p.employeeId)).map((p) => ({ value: String(p.employeeId), label: p.fullName }));
  return (
    <section id="rever-skips" className="scroll-mt-20 rounded-[14px] border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <CalendarOff className="h-4 w-4 shrink-0 text-[#0055D2]" />
        <h3 className="min-w-0 flex-1 text-sm font-semibold">Fora das faltas automáticas</h3>
        <Badge variant="secondary">{skips.filter((s) => s.active).length}</Badge>
      </div>
      <p className="px-3 pt-2 text-xs text-muted-foreground">
        Estas pessoas não levam possível falta pelo horário fixo até à data (inclusive). Serve para quem ainda pica noutro sistema, ou vai mudar de regime. O histórico fica em Definições → Parâmetros → Histórico.
      </p>
      {invalid && <p className="px-3 pt-1 text-xs text-red-700 dark:text-red-400">A lista gravada não é válida: até se gravar de novo, ninguém fica de fora.</p>}
      <div className="divide-y px-1">
        {skips.map((s) => (
          <PersonRow key={s.employeeId} p={s} city={cityOf(s.projectId)} onOpen={onOpen}
            detail={<>{s.active ? `Até ${dayPt(s.until)}` : `Acabou a ${dayPt(s.until)}`} · {s.reason}{s.byName ? ` · por ${s.byName}` : ""}{!s.isActive ? " · ficha inativa" : ""}</>}
            action={<SkipControl employeeId={s.employeeId} today={today} until={s.until} reason={s.reason} defaultReason={s.reason} />} />
        ))}
      </div>
      <div className="flex flex-wrap items-start gap-2 px-3 py-2">
        <SearchableSelect value="" className="h-8 w-full text-xs sm:w-72" options={options}
          placeholder="+ Pôr outra pessoa com horário" searchPlaceholder="Procurar pelo nome…" emptyText="Ninguém"
          onChange={(v) => setAdding(Number(v) || null)} />
        {adding != null && (
          <div className="w-full">
            <p className="mb-1 text-xs font-medium">{withSchedule.find((p) => p.employeeId === adding)?.fullName}</p>
            <SkipControl key={adding} employeeId={adding} today={today} until={null} reason={null} defaultReason="" startOpen onDone={() => setAdding(null)} />
          </div>
        )}
      </div>
    </section>
  );
}
