import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { History, Loader2, Upload } from "lucide-react";
import { parseInitialPricesCsv } from "@shared/multiparkExports";

/**
 * Faturação → Correção de caixa → "Preços iniciais (histórico)": o CSV
 * exportado do History da Multipark com o preço com que cada reserva foi
 * criada. A nossa cópia foi escrita por cima; este passa a ser o "era" de
 * origem no Comparar e na ficha da reserva. O browser lê o ficheiro e manda
 * em lotes de 1000.
 */
const eur = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" }));
const BATCH = 1000;

export function InitialPricesPanel({ projectId }: { projectId?: number }) {
  const utils = trpc.useUtils();
  const scope = projectId !== undefined ? { projectId } : {};
  const report = trpc.cashCheck.initialPricesReport.useQuery(projectId !== undefined ? { projectId } : undefined, { retry: false });
  const save = trpc.cashCheck.importInitialPrices.useMutation();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function onFile(f: File | null) {
    if (!f) return;
    const { rows, errors } = parseInitialPricesCsv(await f.text());
    if (!rows.length) { toast.error(errors[0] ?? "O ficheiro não tem linhas."); return; }
    setProgress({ done: 0, total: rows.length });
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        await save.mutateAsync({ rows: rows.slice(i, i + BATCH), ...scope });
        setProgress({ done: Math.min(i + BATCH, rows.length), total: rows.length });
      }
      toast.success(`${rows.length} reservas importadas.${errors.length ? ` ${errors.length} linha(s) ignoradas.` : ""}`);
      utils.cashCheck.initialPricesReport.invalidate();
    } catch (e: any) {
      toast.error(`A importação parou: ${e?.message ?? e}. O que já entrou fica; podes voltar a carregar o ficheiro.`);
    } finally { setProgress(null); }
  }

  const r = report.data;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><History className="h-4 w-4" />Preços iniciais (histórico da Multipark)</CardTitle>
        <p className="text-xs text-muted-foreground">
          O preço com que cada reserva foi criada, tirado do histórico da Multipark. A nossa cópia antiga foi escrita por cima; a partir daqui o "era" do Comparar e da ficha da reserva começa neste preço. Voltar a importar atualiza, nunca apaga.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <Button asChild size="sm" variant="outline" disabled={!!progress}>
            <span>{progress ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}{progress ? `A importar ${progress.done}/${progress.total}…` : "Importar CSV (reservas.csv)"}</span>
          </Button>
          <input type="file" accept=".csv,text/csv" className="hidden" disabled={!!progress} onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        </label>
        {report.error && <p className="text-xs text-red-600">{report.error.message}</p>}
        {r && r.total > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {r.total} reservas criadas entre {r.firstCreated ?? "?"} e {r.lastCreated ?? "?"} (UTC) · importado em {r.lastImportAt ?? "?"} · {r.changedSinceCreation} mudaram de preço desde a criação.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {[
                ["igual", "Cópia = inicial"], ["reescrita", "Cópia reescrita (= preço de agora)"], ["diferente", "Cópia com outro valor"],
                ["sem_copia", "Não estão na cópia"], ["sem_inicial", "Sem preço na criação"],
              ].map(([k, label]) => (
                <div key={k} className="rounded border p-2">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="text-lg font-semibold tabular-nums">{(r.counts as any)[k] ?? 0}</div>
                </div>
              ))}
            </div>
            {r.samples.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">Cópia com outro valor (as {r.samples.length} maiores diferenças)</summary>
                <div className="max-h-72 overflow-auto mt-2">
                  <table className="w-full text-xs">
                    <thead><tr className="text-muted-foreground text-left"><th className="py-1 pr-2">Reserva</th><th className="pr-2">Parque</th><th className="pr-2 text-right">Inicial</th><th className="pr-2 text-right">Cópia</th><th className="text-right">Na exportação</th></tr></thead>
                    <tbody>
                      {r.samples.map((x) => (
                        <tr key={x.bookingId} className="border-t">
                          <td className="py-1 pr-2">{x.reference ?? x.bookingId}</td>
                          <td className="pr-2">{x.parkName ?? "—"}</td>
                          <td className="pr-2 text-right tabular-nums">{eur(x.initial)}</td>
                          <td className="pr-2 text-right tabular-nums">{eur(x.copy)}</td>
                          <td className="text-right tabular-nums">{eur(x.atExport)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        )}
        {r && r.total === 0 && <p className="text-xs text-muted-foreground">Ainda não foi importado nenhum ficheiro.</p>}
      </CardContent>
    </Card>
  );
}
