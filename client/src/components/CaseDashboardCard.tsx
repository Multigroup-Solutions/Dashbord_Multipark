import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlarmClock, Clock, MapPin, ShieldAlert, Tags, Timer } from "lucide-react";

export interface CaseDashboardData {
  open: number;
  ageBuckets: { lt1d: number; d1to3: number; d3to7: number; gt7d: number };
  overdue: number;
  noCity: number;
  unconfirmedDriver: number;
  avgResolveHours: number | null;
  byType: Array<{ key: string; label: string; count: number }>;
  byCity: Array<{ city: string; count: number }>;
  repeatDrivers: Array<{ key: string; name: string; caseCount: number; incidents: number; complaints: number }>;
}

function fmtHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 48) return `${h.toLocaleString("pt-PT", { maximumFractionDigits: 1 })} h`;
  return `${(h / 24).toLocaleString("pt-PT", { maximumFractionDigits: 1 })} dias`;
}

/**
 * Painel de um módulo de casos (Ocorrências / Perdidos): abertos por idade,
 * em atraso, tempo médio de resolução, por tipo e cidade, e os condutores que
 * se repetem nos casos (top 5 do Cruzamento — só aparece a team leader+).
 */
export default function CaseDashboardCard({ data, onOpenCrossRef, onShowNoCity, resolveLabel = "Tempo médio p/ resolver" }: {
  data: CaseDashboardData | undefined;
  onOpenCrossRef?: () => void;
  onShowNoCity?: () => void;
  resolveLabel?: string;
}) {
  if (!data) return null;
  const buckets = [
    { k: "lt1d", label: "< 1 dia", v: data.ageBuckets.lt1d, cls: "text-slate-700" },
    { k: "d1to3", label: "1–3 dias", v: data.ageBuckets.d1to3, cls: "text-amber-600" },
    { k: "d3to7", label: "3–7 dias", v: data.ageBuckets.d3to7, cls: "text-orange-600" },
    { k: "gt7d", label: "> 7 dias", v: data.ageBuckets.gt7d, cls: "text-red-600" },
  ];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Timer className="w-4 h-4" /> Painel</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          <div className="rounded border p-2">
            <p className="text-xs text-muted-foreground">Abertos</p>
            <p className="text-lg font-bold">{data.open}</p>
          </div>
          {buckets.map((b) => (
            <div key={b.k} className="rounded border p-2">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> {b.label}</p>
              <p className={`text-lg font-bold ${b.cls}`}>{b.v}</p>
            </div>
          ))}
          <div className={`rounded border p-2 ${data.overdue ? "border-red-300 bg-red-50 dark:bg-red-950/30" : ""}`}>
            <p className="text-xs text-muted-foreground flex items-center gap-1"><AlarmClock className="w-3 h-3" /> Em atraso</p>
            <p className={`text-lg font-bold ${data.overdue ? "text-red-600" : ""}`}>{data.overdue}</p>
          </div>
          <div className="rounded border p-2">
            <p className="text-xs text-muted-foreground">{resolveLabel}</p>
            <p className="text-lg font-bold">{fmtHours(data.avgResolveHours)}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <Tags className="w-3.5 h-3.5 text-muted-foreground" />
          {data.byType.length === 0 ? <span className="text-xs text-muted-foreground">Sem casos abertos</span> :
            data.byType.map((t) => <Badge key={t.key} variant="secondary">{t.label}: {t.count}</Badge>)}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
          {data.byCity.map((c) => <Badge key={c.city} variant={c.city === "Sem cidade" ? "destructive" : "outline"}>{c.city}: {c.count}</Badge>)}
          {data.noCity > 0 && onShowNoCity && (
            <button type="button" className="text-xs underline text-red-600" onClick={onShowNoCity}>
              {data.noCity} sem cidade — atribuir
            </button>
          )}
          {data.unconfirmedDriver > 0 && (
            <Badge variant="outline" className="text-amber-700 border-amber-300">{data.unconfirmedDriver} com condutor por confirmar</Badge>
          )}
        </div>

        {data.repeatDrivers.length > 0 && (
          <div className="border-t pt-2">
            <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
              <ShieldAlert className="w-3.5 h-3.5 text-red-500" /> Condutores que se repetem em casos (90 dias)
              {onOpenCrossRef && <button type="button" className="ml-2 underline" onClick={onOpenCrossRef}>ver cruzamento</button>}
            </p>
            <div className="flex flex-wrap gap-2">
              {data.repeatDrivers.map((d) => (
                <Badge key={d.key} variant="destructive" className="font-normal">
                  {d.name}: {d.caseCount} casos · {d.incidents} ocorr. · {d.complaints} recl.
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
