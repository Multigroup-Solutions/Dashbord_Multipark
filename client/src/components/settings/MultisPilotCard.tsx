// Definições → Estado: "Multis piloto" (plano MPV §8.3, F8). Só admin/super admin.
// Por versão (v1 / MPV), nível (lite/fast/smart) e pessoa: perguntas, €/pergunta,
// p95 do tempo de resposta, % erros, % MAX_TOKENS, % rondas finais forçadas,
// % 👎, % "não sei", % chamadas recusadas e as caches de contexto vivas. É daqui
// que leem os critérios do go/no-go. Só leitura; só carrega quando se abre.
import { Fragment, useState } from "react";
import { trpc } from "@/lib/trpc";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bot, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

const DAY_OPTIONS = [1, 7, 14, 31] as const;
/** Alarme do plano (§3.6): MAX_TOKENS acima de 2 %. */
const MAX_TOKENS_ALARM = 0.02;

const eur = (v: number | null) => (v == null ? "—" : `${v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 })} €`);
const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toLocaleString("pt-PT", { maximumFractionDigits: 1 })} %`);
const secs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toLocaleString("pt-PT", { maximumFractionDigits: 1 })} s`);
const n = (v: number) => v.toLocaleString("pt-PT");
const VARIANT: Record<string, string> = { mpv: "MPV", v1: "v1" };
const TIER: Record<string, string> = { smart: "smart", fast: "fast", lite: "lite" };

export function MultisPilotCard() {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(7);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const q = trpc.settings.aiPilotStats.useQuery({ days }, { enabled: open });
  const rows = q.data?.rows ?? [];
  const versions = rows.filter((r) => r.userId == null);
  const people = (v: string, t: string) => rows.filter((r) => r.userId != null && r.variant === v && r.tier === t);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Bot className="h-4 w-4" /> Multis piloto
          {open && q.isFetching && <Loader2 className="h-4 w-4 animate-spin" />}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Por versão do Multis (v1 ou MPV), nível do modelo e pessoa: perguntas, custo por pergunta, tempo de resposta (p95), erros, respostas cortadas (MAX_TOKENS), rondas finais forçadas, 👎, "não sei" e chamadas recusadas por falta de acesso. Os números do go/no-go vêm daqui.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!open ? (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Ver o Multis piloto</Button>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                <SelectTrigger className="h-8 w-36 text-xs" aria-label="Dias"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DAY_OPTIONS.map((d) => <SelectItem key={d} value={String(d)}>{d === 1 ? "Últimas 24 h" : `Últimos ${d} dias`}</SelectItem>)}
                </SelectContent>
              </Select>
              {q.data && (
                <span className="text-xs text-muted-foreground">
                  No piloto: {q.data.pilotUserIds.length ? `${n(q.data.pilotUserIds.length)} pessoa(s)` : "ninguém"} · caches vivas:{" "}
                  {q.data.caches.length ? q.data.caches.map((c) => `${c.model} (${n(c.live)})`).join(", ") : "nenhuma explícita (o Argon só tem a implícita)"}
                </span>
              )}
            </div>
            {q.data?.truncated && <p className="text-xs text-amber-700 dark:text-amber-400">A leitura chegou ao teto de linhas: os números são só da parte mais recente do período.</p>}
            {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o Multis piloto" />}
            {q.data && (versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sem perguntas ao Multis neste período.</p>
            ) : (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs min-w-[52rem]">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-1 px-1 font-medium">Versão · nível / pessoa</th>
                      <th className="py-1 px-1 font-medium text-right">Perguntas</th>
                      <th className="py-1 px-1 font-medium text-right" title="Custo por pergunta (na linha da versão, com o armazenamento das caches)">€/pergunta</th>
                      <th className="py-1 px-1 font-medium text-right" title="Tempo de resposta: 95 % das perguntas abaixo disto">p95</th>
                      <th className="py-1 px-1 font-medium text-right">Erros</th>
                      <th className="py-1 px-1 font-medium text-right" title="Respostas cortadas pelo teto de saída (alarme acima de 2 %)">MAX_TOKENS</th>
                      <th className="py-1 px-1 font-medium text-right" title="Chamada final sem ferramentas (voltas ou tempo esgotados)">Finais forçadas</th>
                      <th className="py-1 px-1 font-medium text-right">👎</th>
                      <th className="py-1 px-1 font-medium text-right" title="Respostas marcadas sozinhas: não sei, sem acesso, consulta com erro">"Não sei"</th>
                      <th className="py-1 px-1 font-medium text-right" title="Chamadas a ferramentas que a pessoa não pode usar (só no MPV)">Recusadas</th>
                      <th className="py-1 px-1 font-medium text-right hidden md:table-cell" title="Tokens de entrada lidos da cache">Da cache</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => {
                      const key = `${v.variant}|${v.tier}`;
                      const list = people(v.variant, v.tier);
                      const isOpen = !!expanded[key];
                      return (
                        <Fragment key={key}>
                          <tr className="border-b bg-muted/40 font-medium">
                            <td className="py-1 px-1">
                              <button type="button" className="inline-flex items-center gap-1" onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))} aria-expanded={isOpen}>
                                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                {VARIANT[v.variant] ?? v.variant} · {TIER[v.tier] ?? v.tier}
                                <span className="font-normal text-muted-foreground">({n(list.length)} pessoa{list.length === 1 ? "" : "s"})</span>
                              </button>
                            </td>
                            <Cells r={v} />
                          </tr>
                          {isOpen && list.map((p) => (
                            <tr key={`${key}|${p.userId}`} className="border-b last:border-0">
                              <td className="py-1 px-1 pl-6">
                                {p.name ?? `#${p.userId}`} {p.inPilot && <Badge variant="outline" className="text-[10px] ml-1">piloto</Badge>}
                              </td>
                              <Cells r={p} />
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Uma pergunta = uma linha do registo de uso. Bloqueadas pelo teto do piloto (o Multis respondeu no modelo de sempre, "modo económico") e pelo orçamento mensal global aparecem à parte em "Perguntas". As chamadas das ferramentas contam na versão da última resposta da conversa.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type Row = {
  questions: number; blockedOwn: number; blockedGlobal: number; eurPerQuestion: number | null; p95Ms: number | null; errorPct: number | null; maxTokensPct: number | null;
  forcedFinalPct: number | null; downPct: number | null; unansweredPct: number | null; refusedPct: number | null; toolCalls: number; answers: number; cachedPct: number | null;
};

function Cells({ r }: { r: Row }) {
  const alarm = r.maxTokensPct != null && r.maxTokensPct > MAX_TOKENS_ALARM;
  return (
    <>
      <td className="py-1 px-1 text-right tabular-nums whitespace-nowrap">
        {n(r.questions)}
        {r.blockedOwn > 0 && <span className="text-muted-foreground" title="Bloqueadas pelo teto do piloto: responderam no modelo de sempre (modo económico)"> (+{n(r.blockedOwn)} teto do piloto)</span>}
        {r.blockedGlobal > 0 && <span className="text-amber-700 dark:text-amber-400" title="Bloqueadas pelo orçamento mensal da IA (ou outro portão)"> (+{n(r.blockedGlobal)} orçamento global)</span>}
      </td>
      <td className="py-1 px-1 text-right tabular-nums">{eur(r.eurPerQuestion)}</td>
      <td className="py-1 px-1 text-right tabular-nums">{secs(r.p95Ms)}</td>
      <td className="py-1 px-1 text-right tabular-nums">{pct(r.errorPct)}</td>
      <td className={`py-1 px-1 text-right tabular-nums ${alarm ? "text-amber-700 dark:text-amber-400 font-semibold" : ""}`} title={alarm ? "Acima de 2 %: o teto de saída está curto" : undefined}>{pct(r.maxTokensPct)}</td>
      <td className="py-1 px-1 text-right tabular-nums">{pct(r.forcedFinalPct)}</td>
      <td className="py-1 px-1 text-right tabular-nums" title={`${n(r.answers)} respostas guardadas`}>{pct(r.downPct)}</td>
      <td className="py-1 px-1 text-right tabular-nums">{pct(r.unansweredPct)}</td>
      <td className="py-1 px-1 text-right tabular-nums" title={`${n(r.toolCalls)} chamadas`}>{pct(r.refusedPct)}</td>
      <td className="py-1 px-1 text-right tabular-nums hidden md:table-cell">{pct(r.cachedPct)}</td>
    </>
  );
}
