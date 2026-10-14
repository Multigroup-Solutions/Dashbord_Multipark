// Definições → Comunicação → "Testar a triagem" (14 out 2026; só o super
// admin). Corre os DOIS corpora rotulados de emails — o principal e o de
// controlo (escrito à parte, para a meta não ser medida só com os exemplos de
// quem escreveu as regras) — pelo MESMO pedido e pelas mesmas regras de
// produção, com o modelo real, por lotes (cada pedido cabe nos 60 s do
// servidor), e mostra recall e precisão por categoria de cada um. Não cria
// casos nem mexe na Comunicação; o resultado fica nos logs ("[triagem-eval]").
// Tem um teto de custo no servidor (lotes por hora e por dia).
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, FlaskConical, Loader2, XCircle } from "lucide-react";
import { MAIL_TRIAGE_CATEGORY_LABELS, TRIAGE_RECALL_TARGET, parseTriageCategory } from "@shared/mailTriage";

type EvalItem = { id: string; expected: string; predicted: string | null; via: string; subject: string; note: string | null; reason: string | null; caseKind?: string | null; uncertain?: boolean; error?: string };
type Metrics = {
  total: number; correct: number; failed: number; accuracy: number | null; recallComplaints: number | null; recallLostFound: number | null; passes: boolean; missing: number;
  byCategory: Array<{ category: string; label: string; support: number; predicted: number; correct: number; recall: number | null; precision: number | null }>;
};
type CorpusKey = "principal" | "controlo";
const CORPORA: ReadonlyArray<{ key: CorpusKey; label: string }> = [
  { key: "principal", label: "Corpus principal" },
  { key: "controlo", label: "Corpus de controlo (independente)" },
];
type CorpusResult = { key: CorpusKey; label: string; items: EvalItem[]; metrics: Metrics };

const BATCH = 12;
const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)} %`);
const catLabel = (k: string | null) => {
  const c = parseTriageCategory(k);
  return c ? MAIL_TRIAGE_CATEGORY_LABELS[c] : k ?? "falhou";
};

export function MailTriageEvalCard() {
  const evalMut = trpc.settings.mailTriageEval.useMutation();
  const reportMut = trpc.settings.mailTriageEvalReport.useMutation();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [results, setResults] = useState<CorpusResult[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true); setError(null); setResults([]);
    let usedModel: string | null = null;
    const done: CorpusResult[] = [];
    try {
      for (const c of CORPORA) {
        const started = Date.now();
        const all: EvalItem[] = [];
        let total = 0;
        let offset = 0;
        do {
          const r = await evalMut.mutateAsync({ offset, limit: BATCH, corpus: c.key });
          total = r.total;
          usedModel = usedModel ?? r.model;
          all.push(...(r.items as EvalItem[]));
          offset += r.items.length;
          setProgress({ label: c.label, done: offset, total });
          if (!r.items.length) break;
        } while (offset < total);
        const metrics = await reportMut.mutateAsync({ rows: all.map((i) => ({ id: i.id, predicted: i.predicted })), ms: Date.now() - started, model: usedModel, corpus: c.key }) as Metrics;
        done.push({ key: c.key, label: c.label, items: all, metrics });
        setResults([...done]);
      }
      setModel(usedModel);
    } catch (e: any) {
      setError(String(e?.message ?? e) || "Não foi possível testar.");
    } finally {
      setRunning(false);
    }
  }

  const passesAll = results.length === CORPORA.length && results.every((r) => r.metrics.passes);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <FlaskConical className="h-4 w-4" /> Testar a triagem dos emails (IA)
          {results.length === CORPORA.length && (passesAll
            ? <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:border-emerald-800"><CheckCircle2 className="h-3 w-3 mr-1" />Passa a meta nos dois</Badge>
            : <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-200 dark:border-red-800"><XCircle className="h-3 w-3 mr-1" />Abaixo da meta</Badge>)}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Corre uns 200 emails de exemplo (já rotulados, em português, inglês, espanhol e francês), em dois conjuntos — o principal e um de controlo escrito à parte —, pelo mesmo pedido à IA e pelas mesmas regras de produção, com o modelo real.
          Uma reclamação ou um perdido só contam como reconhecidos quando o caso abriria de facto (os "Por confirmar (IA)" contam).
          Não cria casos nem mexe na Comunicação; gasta um pouco de IA (uma leitura por email) e tem um limite de vezes por hora. Meta: mais de {Math.round(TRIAGE_RECALL_TARGET * 100)} % das reclamações e dos perdidos reconhecidos, nos dois conjuntos.
          O resultado fica também nos logs (linha "[triagem-eval]").
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={run} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FlaskConical className="h-4 w-4 mr-1" />}
            {running ? "A testar…" : "Testar a triagem"}
          </Button>
          {progress && running && <span className="text-xs text-muted-foreground tabular-nums">{progress.label}: {progress.done} de {progress.total}</span>}
          {model && !running && <span className="text-[11px] text-muted-foreground font-mono break-all">modelo: {model}</span>}
        </div>
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        {results.map((r) => <CorpusResultView key={r.key} result={r} />)}
      </CardContent>
    </Card>
  );
}

function CorpusResultView({ result }: { result: CorpusResult }) {
  const [showWrong, setShowWrong] = useState(false);
  const m = result.metrics;
  const wrong = result.items.filter((i) => i.predicted !== i.expected);
  const unsure = result.items.filter((i) => i.caseKind && i.uncertain).length;
  return (
    <section className="space-y-2 rounded-md border p-2" aria-label={result.label}>
      <h3 className="text-sm font-semibold flex items-center gap-2 flex-wrap">
        {result.label}
        {m.passes
          ? <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:border-emerald-800">Passa</Badge>
          : <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-200 dark:border-red-800">Abaixo</Badge>}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {[
          { label: "Reclamações reconhecidas", v: m.recallComplaints, goal: true },
          { label: "Perdidos reconhecidos", v: m.recallLostFound, goal: true },
          { label: "Acerto geral", v: m.accuracy, goal: false },
        ].map((x) => (
          <div key={x.label} className="rounded-md border p-2">
            <div className="text-xs text-muted-foreground">{x.label}</div>
            <div className={`text-lg font-semibold tabular-nums ${x.goal ? ((x.v ?? 0) >= TRIAGE_RECALL_TARGET ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300") : ""}`}>{pct(x.v)}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {m.correct} de {m.total} certos{m.failed ? ` · a IA falhou em ${m.failed}` : ""}{m.missing ? ` · faltaram ${m.missing}` : ""}{unsure ? ` · ${unsure} caso(s) ficariam "Por confirmar (IA)"` : ""}.
      </p>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b">
              <th className="py-1 px-1 font-medium">Categoria</th>
              <th className="py-1 px-1 font-medium text-right">Exemplos</th>
              <th className="py-1 px-1 font-medium text-right">Apanhou (recall)</th>
              <th className="py-1 px-1 font-medium text-right">Certas (precisão)</th>
            </tr>
          </thead>
          <tbody>
            {m.byCategory.map((c) => (
              <tr key={c.category} className="border-b last:border-0">
                <td className="py-1 px-1">{c.label}</td>
                <td className="py-1 px-1 text-right tabular-nums">{c.support}</td>
                <td className="py-1 px-1 text-right tabular-nums">{pct(c.recall)}</td>
                <td className="py-1 px-1 text-right tabular-nums">{pct(c.precision)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {wrong.length > 0 && (
        <div className="space-y-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowWrong((v) => !v)} aria-expanded={showWrong}>
            {showWrong ? "Esconder" : "Ver"} os {wrong.length} que não acertou
          </Button>
          {showWrong && (
            <ul className="space-y-1 text-xs">
              {wrong.map((w) => (
                <li key={w.id} className="rounded border p-2 min-w-0">
                  <div className="font-medium break-words">{w.subject}</div>
                  <div className="text-muted-foreground">
                    Devia ser <strong>{catLabel(w.expected)}</strong> · foi <strong>{catLabel(w.predicted)}</strong>
                    {w.reason ? ` — ${w.reason}` : ""}{w.error ? ` (erro: ${w.error})` : ""}
                  </div>
                  {w.note && <div className="text-muted-foreground italic">{w.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
