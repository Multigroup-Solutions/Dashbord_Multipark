// Definições → Estado: "IA — uso por dia" (plano MPV, F0a). Só admin/super admin.
// Chamadas, erros, bloqueadas (incl. "só UE" do RH), tokens e custo por dia ×
// funcionalidade, com a primeira/última chamada do dia; e as leituras
// repetidas (a mesma coisa lida pela IA mais de uma vez). Só leitura; só
// carrega quando se abre.
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart3, Loader2 } from "lucide-react";
import { AI_FEATURES, AI_FEATURE_IDS } from "@shared/aiFeatures";

const ALL = "__all";
const DAY_OPTIONS = [7, 14, 31, 62] as const;

function eur(v: number): string {
  return `${v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 })} €`;
}
const n = (v: number) => v.toLocaleString("pt-PT");
/** "AAAA-MM-DD HH:MM:SS" (UTC) → "HH:MM" */
const hhmm = (v: string | null) => (v ? v.slice(11, 16) : "—");

export function AiUsageDailyCard() {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(14);
  const [feature, setFeature] = useState<string>(ALL);
  const filter = feature === ALL ? null : feature;
  const daily = trpc.settings.aiUsageDaily.useQuery({ days, feature: filter }, { enabled: open });
  const repeats = trpc.settings.aiUsageRepeats.useQuery({ days: Math.min(days, 31), feature: filter }, { enabled: open });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <BarChart3 className="h-4 w-4" /> IA — uso por dia
          {open && (daily.isFetching || repeats.isFetching) && <Loader2 className="h-4 w-4 animate-spin" />}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Por dia (UTC) e funcionalidade: chamadas, erros, bloqueadas (orçamento ou "só UE" do RH), tokens, custo e a hora da primeira e da última chamada. Em baixo, as leituras repetidas (a mesma coisa lida mais de uma vez).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!open ? (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Ver o uso por dia</Button>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                <SelectTrigger className="h-8 w-36 text-xs" aria-label="Dias"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DAY_OPTIONS.map((d) => <SelectItem key={d} value={String(d)}>Últimos {d} dias</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={feature} onValueChange={setFeature}>
                <SelectTrigger className="h-8 w-full max-w-xs min-w-0 text-xs" aria-label="Funcionalidade"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todas as funcionalidades</SelectItem>
                  {AI_FEATURE_IDS.map((f) => <SelectItem key={f} value={f}>{AI_FEATURES[f].label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {daily.error && <QueryErrorNote error={daily.error} onRetry={() => daily.refetch()} retrying={daily.isFetching} what="o uso por dia" />}
            {daily.data && (daily.data.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sem chamadas à IA neste período.</p>
            ) : (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-1 px-1 font-medium">Dia</th>
                      <th className="py-1 px-1 font-medium">Funcionalidade</th>
                      <th className="py-1 px-1 font-medium text-right">Chamadas</th>
                      <th className="py-1 px-1 font-medium text-right">Erros</th>
                      <th className="py-1 px-1 font-medium text-right">Bloq.</th>
                      <th className="py-1 px-1 font-medium text-right hidden md:table-cell" title="Texto de recurso / chamada final sem ferramentas / cortadas por MAX_TOKENS">Recurso / final / máx.</th>
                      <th className="py-1 px-1 font-medium text-right hidden sm:table-cell">Tokens (entrada/saída)</th>
                      <th className="py-1 px-1 font-medium text-right">Custo</th>
                      <th className="py-1 px-1 font-medium text-right hidden sm:table-cell">1.ª–última (UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {daily.data.rows.map((r) => (
                      <tr key={`${r.day}|${r.feature}`} className="border-b last:border-0">
                        <td className="py-1 px-1 tabular-nums whitespace-nowrap">{r.day}</td>
                        <td className="py-1 px-1">{r.label}</td>
                        <td className="py-1 px-1 text-right tabular-nums">{n(r.calls)}</td>
                        <td className="py-1 px-1 text-right tabular-nums">{r.errors ? n(r.errors) : "—"}</td>
                        <td className="py-1 px-1 text-right tabular-nums">
                          {r.blocked ? n(r.blocked) : "—"}
                          {r.euOnly > 0 && <span className="text-muted-foreground"> ({n(r.euOnly)} só UE)</span>}
                        </td>
                        <td className="py-1 px-1 text-right tabular-nums hidden md:table-cell whitespace-nowrap" title="Texto de recurso / chamada final sem ferramentas / cortadas por MAX_TOKENS">
                          {r.fallbacks || r.forcedFinal || r.maxTokens ? `${n(r.fallbacks)} / ${n(r.forcedFinal)} / ${n(r.maxTokens)}` : "—"}
                        </td>
                        <td className="py-1 px-1 text-right tabular-nums hidden sm:table-cell">{n(r.inputTokens)} / {n(r.outputTokens)}</td>
                        <td className="py-1 px-1 text-right tabular-nums">{eur(r.costEur)}</td>
                        <td className="py-1 px-1 text-right tabular-nums hidden sm:table-cell whitespace-nowrap">{hhmm(r.firstAt)}–{hhmm(r.lastAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            <div className="pt-2">
              <div className="text-sm font-semibold">Leituras repetidas <span className="text-xs font-normal text-muted-foreground">(últimos {Math.min(days, 31)} dias; sem as conversas do Multis; as 100 primeiras)</span></div>
              {repeats.error && <QueryErrorNote error={repeats.error} onRetry={() => repeats.refetch()} retrying={repeats.isFetching} what="as leituras repetidas" />}
              {repeats.data && (repeats.data.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma coisa lida mais de uma vez.</p>
              ) : (
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground border-b">
                        <th className="py-1 px-1 font-medium">Funcionalidade</th>
                        <th className="py-1 px-1 font-medium">O quê</th>
                        <th className="py-1 px-1 font-medium text-right">Vezes</th>
                        <th className="py-1 px-1 font-medium text-right">Custo</th>
                        <th className="py-1 px-1 font-medium text-right hidden sm:table-cell">Primeira → última (UTC)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {repeats.data.rows.map((r) => (
                        <tr key={`${r.feature}|${r.entity}|${r.entityId}`} className="border-b last:border-0">
                          <td className="py-1 px-1">{r.label}</td>
                          <td className="py-1 px-1 font-mono break-all">{r.entity} #{r.entityId}</td>
                          <td className="py-1 px-1 text-right tabular-nums">{n(r.calls)}</td>
                          <td className="py-1 px-1 text-right tabular-nums">{eur(r.costEur)}</td>
                          <td className="py-1 px-1 text-right tabular-nums hidden sm:table-cell whitespace-nowrap">{r.firstAt?.slice(5, 16) ?? "—"} → {r.lastAt?.slice(5, 16) ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
