/**
 * Extras-Dia → Pressão → "Diagnóstico dos tempos (calibração)" — plano 62, P0.
 * Só o super admin vê (e o servidor só deixa o super admin correr). Pede os
 * dias um a um (um dia operacional por pedido), junta-os aqui (as caixas
 * somam-se; os percentis calculam-se no fim) e mostra as medidas do §11.0,
 * cada uma com o parâmetro que calibra. "Copiar resumo" copia o texto todo.
 */
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ClipboardCopy, Loader2, Play, Square, Stethoscope } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { addDays, lisbonDayOf } from "@shared/lisbonDay";
import {
  PROBE_CITIES, PROBE_CITY_LABELS, PROBE_DAY_CHOICES, PROBE_DEFAULT_OFFSET_DAYS,
  buildSondaReport, emptySondaResult, mergeSondaResults, sondaReportText,
  type ProbeCity, type ReportSection, type SondaResult,
} from "@shared/sondaTempos";

type Scope = ProbeCity | "all";
interface RunRow { day: string; elapsedMs: number; truncated: boolean; failures: string[]; results: Partial<Record<ProbeCity, SondaResult>> }

const fmtDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

function SectionCard({ s }: { s: ReportSection }) {
  return (
    <section className="rounded-[14px] border bg-card p-3.5 space-y-2 min-w-0" aria-label={s.title}>
      <div>
        <h4 className="text-sm font-semibold">{s.item ? `${s.item}. ` : ""}{s.title}</h4>
        <p className="text-[11px] text-muted-foreground">Fecha: {s.closes}</p>
      </div>
      <dl className="space-y-1">
        {s.rows.map((r, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 text-xs">
            <dt className={`text-muted-foreground ${r.label.startsWith("  ") ? "sm:pl-3" : ""}`}>{r.label.trim()}</dt>
            <dd className="font-medium break-words">
              {r.value}
              {r.hint && <span className="block text-[11px] font-normal text-primary">{r.hint}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {s.table && s.table.rows.length > 0 && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-left text-muted-foreground">
                {s.table.head.map((h) => <th key={h} className="px-1 py-1 font-medium whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {s.table.rows.map((tr, i) => (
                <tr key={i} className="border-t">
                  {tr.map((c, j) => <td key={j} className="px-1 py-1 whitespace-nowrap">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function TimesProbeCard({ city }: { city: ProbeCity }) {
  const today = lisbonDayOf(Date.now());
  const [day, setDay] = useState(() => addDays(today, -PROBE_DEFAULT_OFFSET_DAYS));
  const [nDays, setNDays] = useState<number>(14);
  const [scope, setScope] = useState<Scope>(city);
  const [view, setView] = useState<Scope>("all");
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const stopRef = useRef(false);
  const probe = trpc.extrasDia.timesProbe.useMutation();

  const run = async () => {
    const days = Array.from({ length: nDays }, (_, i) => addDays(day, -i));
    const cities = scope === "all" ? [...PROBE_CITIES] : [scope];
    stopRef.current = false;
    setRuns([]);
    setView("all");
    const acc: RunRow[] = [];
    for (let i = 0; i < days.length; i++) {
      if (stopRef.current) break;
      setProgress({ done: i, total: days.length, current: days[i] });
      try {
        const r = await probe.mutateAsync({ day: days[i], cities });
        acc.push({ day: r.day, elapsedMs: r.elapsedMs, truncated: r.truncated, failures: r.failures, results: r.results as RunRow["results"] });
      } catch (err) {
        // O pedido inteiro falhou (rede, prazo da Vercel…): o dia conta como pedido e sem dados — "falhou", nunca "zero".
        const failures = [`falhou: ${(err as Error)?.message ?? "erro"}`];
        const results = Object.fromEntries(cities.map((c) => [c, { ...emptySondaResult(c, [days[i]]), failures }])) as RunRow["results"];
        acc.push({ day: days[i], elapsedMs: 0, truncated: false, failures, results });
      }
      setRuns([...acc]);
    }
    setProgress(null);
  };

  const merged = useMemo(() => {
    const perCity: Partial<Record<ProbeCity, SondaResult>> = {};
    for (const c of PROBE_CITIES) {
      const list = runs.map((r) => r.results[c]).filter((x): x is SondaResult => !!x);
      if (list.length) perCity[c] = mergeSondaResults(list, c);
    }
    const cities = Object.keys(perCity) as ProbeCity[];
    const all = cities.length ? mergeSondaResults(cities.map((c) => perCity[c]!)) : null;
    return { perCity, cities, all };
  }, [runs]);
  const shown: SondaResult | null = view === "all" ? merged.all : merged.perCity[view] ?? merged.all;
  const shownLabel = view === "all" ? merged.cities.map((c) => PROBE_CITY_LABELS[c]).join(" + ") : PROBE_CITY_LABELS[view];
  const report = useMemo(
    () => (shown ? buildSondaReport(shown, view === "all" && merged.cities.length > 1 ? merged.perCity : undefined) : []),
    [shown, view, merged],
  );

  const copy = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(sondaReportText(shown, report, { cities: shownLabel, ranAt: new Date().toISOString().slice(0, 16).replace("T", " ") }));
      toast.success("Resumo copiado.");
    } catch {
      toast.error("Não consegui copiar. Tenta outra vez.");
    }
  };

  const failures = runs.flatMap((r) => r.failures.map((f) => `${fmtDay(r.day)} — ${f}`));
  const partial = runs.filter((r) => r.truncated).length;

  return (
    <section className="rounded-[14px] border bg-card p-4 space-y-4" aria-label="Diagnóstico dos tempos">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold flex items-center gap-2">
            <Stethoscope className="h-5 w-5 text-primary" aria-hidden />
            Diagnóstico dos tempos (calibração)
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Mede o GPS, as chamadas e os estados da Multipark para acertar os parâmetros dos tempos de entrega e de recolha. Só lê; não grava nem avisa ninguém. Mostra só totais, nunca pessoas nem reservas.
          </p>
        </div>
        <Badge variant="outline" className="shrink-0">Só super admin</Badge>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Último dia</span>
          <Input type="date" className="h-9 w-[150px]" value={day} max={addDays(today, -1)} onChange={(e) => e.target.value && setDay(e.target.value)} disabled={!!progress} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Dias</span>
          <Select value={String(nDays)} onValueChange={(v) => setNDays(Number(v))} disabled={!!progress}>
            <SelectTrigger className="h-9 w-[120px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROBE_DAY_CHOICES.map((n) => <SelectItem key={n} value={String(n)}>{n === 1 ? "Só esse dia" : `${n} dias`}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Cidade</span>
          <Select value={scope} onValueChange={(v) => setScope(v as Scope)} disabled={!!progress}>
            <SelectTrigger className="h-9 w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROBE_CITIES.map((c) => <SelectItem key={c} value={c}>{PROBE_CITY_LABELS[c]}</SelectItem>)}
              <SelectItem value="all">Todas</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {progress ? (
          <Button type="button" variant="outline" className="h-9" onClick={() => { stopRef.current = true; }}>
            <Square className="h-4 w-4 mr-1" aria-hidden /> Parar
          </Button>
        ) : (
          <Button type="button" className="h-9" onClick={run}>
            <Play className="h-4 w-4 mr-1" aria-hidden /> Correr
          </Button>
        )}
        <Button type="button" variant="outline" className="h-9" onClick={copy} disabled={!shown || !!progress}>
          <ClipboardCopy className="h-4 w-4 mr-1" aria-hidden /> Copiar resumo
        </Button>
      </div>

      {progress && (
        <p className="text-xs text-muted-foreground flex items-center gap-2" role="status">
          <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
          A ler {fmtDay(progress.current)} ({progress.done + 1} de {progress.total}). Cada dia demora até um minuto; podes parar e ver o que já veio.
        </p>
      )}
      {!progress && !runs.length && (
        <p className="text-xs text-muted-foreground">
          Escolhe o último dia (por omissão D-3, para o GPS já ser o final), quantos dias para trás e a cidade, e carrega em <strong>Correr</strong>. No fim, <strong>Copiar resumo</strong> e cola na conversa.
        </p>
      )}

      {runs.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {runs.length} dia(s) lido(s): {fmtDay(runs[runs.length - 1].day)} a {fmtDay(runs[0].day)}
          {partial ? ` · ${partial} com leitura parcial` : ""} · cada corrida fica também no log do servidor (linhas [sonda62]).
        </p>
      )}
      {failures.length > 0 && (
        <div className="rounded-[14px] border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs space-y-1">
          <p className="font-medium flex items-center gap-1"><AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden /> O que falhou</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {failures.slice(0, 30).map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      )}

      {merged.cities.length > 1 && (
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Ver">
          {(["all", ...merged.cities] as Scope[]).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={view === c}
              onClick={() => setView(c)}
              className={`rounded-md border px-3 py-1 text-xs ${view === c ? "border-primary bg-primary/10 text-primary font-medium" : "hover:bg-muted/60"}`}
            >
              {c === "all" ? "Juntas" : PROBE_CITY_LABELS[c]}
            </button>
          ))}
        </div>
      )}

      {report.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {report.map((s) => <SectionCard key={s.id} s={s} />)}
        </div>
      )}
    </section>
  );
}
