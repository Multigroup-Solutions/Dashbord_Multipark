/**
 * Briefing diário por cidade (07:30 Lisboa) no Dashboard/Tarefas. Os números
 * vêm do sistema; o parágrafo é da IA quando está ligada. O servidor já só
 * devolve as secções dos módulos a que a pessoa tem acesso.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Sparkles, Sunrise } from "lucide-react";

const CITY_LABEL: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
const shortDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" | "ok" }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2 min-w-0">
      <div className="text-[11px] text-muted-foreground leading-tight">{label}</div>
      <div className={`font-semibold tabular-nums truncate ${tone === "bad" ? "text-red-700" : tone === "ok" ? "text-green-700" : ""}`}>{value}</div>
    </div>
  );
}

function BriefingBlock({ b }: { b: any }) {
  const [open, setOpen] = useState(false);
  const d = b.data;
  const slaDue = d.sla.complaintsDueToday + d.sla.incidentsDueToday;
  const slaLate = d.sla.complaintsOverdue + d.sla.incidentsOverdue;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{CITY_LABEL[b.city] ?? b.city}</span>
        <span className="text-xs text-muted-foreground">{shortDay(b.day)}</span>
        {b.aiUsed && <Badge variant="outline" className="text-[11px] gap-1"><Sparkles className="h-3 w-3" />texto IA</Badge>}
      </div>
      {b.summary && <p className="text-sm leading-relaxed bg-muted/40 rounded-lg p-3">{b.summary}</p>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Entradas / saídas" value={`${d.bookings.checkins} / ${d.bookings.checkouts}`} />
        <Stat label="Pico" value={d.bookings.peak ? `${d.bookings.peak.label} (${d.bookings.peak.total})` : "—"} />
        <Stat label="Extras escalados / necessários" value={d.extras ? `${d.extras.scheduled} / ${d.extras.neededPeak}` : "—"} tone={d.extras?.gap ? "bad" : d.extras ? "ok" : undefined} />
        <Stat label="Prazos hoje (em atraso)" value={`${slaDue} (${slaLate})`} tone={slaLate ? "bad" : undefined} />
      </div>
      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
        {open ? "Esconder detalhe" : "Ver detalhe"}
      </Button>
      {open && (
        <div className="space-y-3 text-sm">
          {d.bookings.byHour.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1">Entradas/saídas por hora</div>
              <div className="flex flex-wrap gap-1">
                {d.bookings.byHour.map((h: any) => (
                  <span key={h.hour} className="rounded border px-1.5 py-0.5 text-[11px] tabular-nums">{h.label} <b>{h.checkins}</b>/<b>{h.checkouts}</b></span>
                ))}
              </div>
            </div>
          )}
          {d.sla.items.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1">Prazos (SLA)</div>
              <ul className="space-y-1">
                {d.sla.items.map((i: any) => (
                  <li key={`${i.type}-${i.id}`} className="break-words">
                    {i.overdue && <Badge variant="secondary" className="mr-1 bg-red-100 text-red-800 text-[11px]">em atraso</Badge>}
                    {i.type === "complaint" ? "Reclamação" : "Ocorrência"} #{i.id} — {i.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.handover.pending.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1">Pendentes da passagem de turno{d.handover.last ? ` (${d.handover.last})` : ""}</div>
              <ul className="list-disc pl-5 space-y-0.5">{d.handover.pending.map((t: string, n: number) => <li key={n} className="break-words">{t}</li>)}</ul>
            </div>
          )}
          {d.handover.repeated.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1">A repetir-se entre turnos</div>
              <ul className="list-disc pl-5 space-y-0.5">{d.handover.repeated.map((r: any, n: number) => <li key={n} className="break-words">{r.text} <span className="text-muted-foreground">({r.count} passagens)</span></li>)}</ul>
            </div>
          )}
          {d.anomalies.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1">Alertas</div>
              <ul className="space-y-1">{d.anomalies.map((a: any, n: number) => (
                <li key={n} className="break-words">{a.severity === "critical" && <Badge variant="destructive" className="mr-1 text-[11px]">crítico</Badge>}{a.detail}{a.explanation && <div className="text-xs text-muted-foreground italic">{a.explanation}</div>}</li>
              ))}</ul>
            </div>
          )}
          {d.marketingAlerts.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1">Marketing</div>
              <ul className="list-disc pl-5 space-y-0.5">{d.marketingAlerts.map((a: any, n: number) => <li key={n} className="break-words">{a.title} — {a.detail}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function OpsBriefingCard() {
  const { user } = useAuth();
  const allowed = !!user && can(user as any, "passagem_turno", "view");
  const q = trpc.aiOps.briefing.useQuery(undefined, { enabled: allowed, staleTime: 5 * 60_000, retry: false });
  if (!allowed || !q.data?.length) return null;
  return (
    <Card className="p-4 sm:p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Sunrise className="h-5 w-5 text-amber-600" />
        <h2 className="font-display font-bold text-base">Briefing do dia</h2>
      </div>
      <div className="space-y-5 divide-y">
        {q.data.map((b: any) => <div key={b.city} className="pt-4 first:pt-0"><BriefingBlock b={b} /></div>)}
      </div>
    </Card>
  );
}
