/**
 * Peças partilhadas do Marketing → Web & SEO (painel Web e Google Business):
 * formatação PT-PT, variação com seta (nunca só cor), cartão KPI e chips
 * verde/âmbar/vermelho dos limiares Google.
 */
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { StatValue } from "@/components/StatValue";
import { psLevel, type PsLevel, type PsMetric } from "@shared/webAnalytics";

export function lisbonDay(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
export const num = (v: number | null | undefined, digits = 0) => (v == null ? "—" : Number(v).toLocaleString("pt-PT", { maximumFractionDigits: digits }));
export const eur = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: digits, minimumFractionDigits: digits });
export const pctOf = (v: number | null | undefined, digits = 1) => (v == null ? "—" : `${(v * 100).toLocaleString("pt-PT", { maximumFractionDigits: digits, minimumFractionDigits: digits })}%`);
export const posFmt = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT", { maximumFractionDigits: 1, minimumFractionDigits: 1 }));
export const shortDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export const fmtDay = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
export const change = (cur: number | null | undefined, prev: number | null | undefined) => (cur == null || prev == null || prev === 0 ? null : (cur - prev) / Math.abs(prev));

// Paleta: atual = Royal Blue (#0055D2 / escuro #4f8aec); comparação = cinzento a tracejado; posição = laranja.
export const SERIES = "[--wb-1:#0055d2] [--wb-2:#16a34a] [--wb-3:#c2410c] dark:[--wb-1:#4f8aec] dark:[--wb-3:#ea580c]";

/** Variação com seta + texto (nunca só cor). `invert`: descer é bom (posição). */
export function Delta({ cur, prev, invert, abs }: { cur: number | null | undefined; prev: number | null | undefined; invert?: boolean; abs?: (d: number) => string }) {
  if (cur == null || prev == null) return <span className="text-muted-foreground">sem comparação</span>;
  const d = abs ? cur - prev : change(cur, prev);
  if (d == null || !Number.isFinite(d)) return <span className="text-muted-foreground">sem base</span>;
  if (Math.abs(d) < (abs ? 0.05 : 0.005)) return <span className="text-muted-foreground">= estável</span>;
  const up = d > 0;
  const good = invert ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 ${good ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}>
      <Icon className="w-3 h-3" aria-hidden />
      <span className="sr-only">{up ? "subiu" : "desceu"}</span>
      {abs ? abs(d) : `${up ? "+" : "−"}${Math.round(Math.abs(d) * 100)}%`}
    </span>
  );
}

export function Kpi({ icon: Icon, label, value, cur, prev, invert, hint, abs }: { icon: any; label: string; value: string; cur?: number | null; prev?: number | null; invert?: boolean; hint?: string; abs?: (d: number) => string }) {
  return (
    <div className="rounded-xl border bg-card p-3 min-w-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">{label}</span></div>
      <StatValue value={value} className="mt-1" max={26} />
      <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-2">
        {cur !== undefined && <Delta cur={cur} prev={prev} invert={invert} abs={abs} />}
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}

export const LEVEL_CLS: Record<PsLevel, string> = {
  good: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200",
  needs_improvement: "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200",
  poor: "bg-rose-100 text-rose-900 border-rose-200 dark:bg-rose-950/40 dark:text-rose-200",
};
export const LEVEL_LABEL: Record<PsLevel, string> = { good: "Bom", needs_improvement: "A melhorar", poor: "Fraco" };

export function PsChip({ metric, value, text }: { metric: PsMetric; value: number | null | undefined; text: string }) {
  const lvl = psLevel(metric, value);
  if (!lvl) return <span className="text-muted-foreground">—</span>;
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs tabular-nums ${LEVEL_CLS[lvl]}`} title={LEVEL_LABEL[lvl]}>{text}<span className="sr-only"> ({LEVEL_LABEL[lvl]})</span></span>;
}

