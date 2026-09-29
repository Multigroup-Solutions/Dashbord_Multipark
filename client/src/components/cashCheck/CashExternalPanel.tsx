import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeftRight, Loader2, Trash2, Upload } from "lucide-react";

/**
 * Faturação → Correção de caixa → "Confirmar pagamentos" (fase 4):
 *  - estado dos cruzamentos automáticos (Stripe, Viva Wallet, InvoiceExpress),
 *    desligados por omissão (Definições → Automações) — até lá confirma-se à mão;
 *  - CSV exportado da Viva Wallet (multibanco do terminal);
 *  - recebimentos do fim do mês (Pro, agentes, agregadores), conferidos à mão.
 * Os talões do multibanco estão na Contagem da caixa.
 */

const eur = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" }));
const num = (s: string) => Number(String(s).replace(",", "."));
const KIND_LABEL: Record<string, string> = { pro: "Cliente Pro", agente: "Agente", agregador: "Agregador" };
const KEY_LABEL: Record<string, string> = { ok: "chave posta", not_configured: "sem chave na Vercel", not_restricted: "chave recusada (tem de ser restrita rk_)" };
function lastMonth(): string {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}
function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] ?? ""); r.onerror = () => reject(r.error); r.readAsDataURL(f); });
}

function Source({ name, s }: { name: string; s: { on: boolean; key: string } }) {
  return (
    <div className="rounded-md bg-muted/50 p-2">
      <div className="text-xs text-muted-foreground">{name}</div>
      <div className="font-medium">{s.on ? "Ligado" : "Desligado (confirma-se à mão)"}</div>
      <div className="text-xs text-muted-foreground">{KEY_LABEL[s.key] ?? s.key}</div>
    </div>
  );
}

export default function CashExternalPanel({ projectId }: { projectId?: number }) {
  const scope = projectId !== undefined ? { projectId } : {};
  const utils = trpc.useUtils();
  const status = trpc.cashCheck.externalStatus.useQuery(projectId !== undefined ? { projectId } : undefined, { retry: false, staleTime: 60_000 });
  const imports = trpc.cashCheck.vivaImports.useQuery(projectId !== undefined ? { projectId } : undefined, { retry: false });
  const [vivaFile, setVivaFile] = useState<File | null>(null);
  const viva = trpc.cashCheck.importVivaCsv.useMutation({
    onSuccess: (r) => { toast[r.missing ? "warning" : "success"](`${r.txns} transação(ões) do terminal: ${r.matched} bateram, ${r.missing} reserva(s) com multibanco sem transação, ${r.extra} transação(ões) sem reserva.`); setVivaFile(null); utils.cashCheck.vivaImports.invalidate(); utils.cashCheck.cases.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const [month, setMonth] = useState(lastMonth());
  const monthly = trpc.cashCheck.monthly.useQuery({ month, ...scope }, { retry: false });
  const [form, setForm] = useState<{ key: string; amount: string; receivedOn: string; note: string; file: File | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const addMonthly = trpc.cashCheck.addMonthlyReceipt.useMutation({ onError: (e) => toast.error(e.message) });
  const removeMonthly = trpc.cashCheck.removeMonthlyReceipt.useMutation({ onSuccess: () => { utils.cashCheck.monthly.invalidate(); utils.cashCheck.cases.invalidate(); }, onError: (e) => toast.error(e.message) });

  const s = status.data;
  const last = s?.last?.summary;
  const m = monthly.data?.available ? monthly.data : null;

  async function saveMonthly(row: { kind: string; entityId: string; name: string }) {
    if (!form || !Number.isFinite(num(form.amount)) || num(form.amount) <= 0) { toast.error("Indica o valor recebido."); return; }
    setBusy(true);
    try {
      const proofBase64 = form.file ? await fileToBase64(form.file) : undefined;
      const r = await addMonthly.mutateAsync({
        kind: row.kind as "pro" | "agente" | "agregador", entityId: row.entityId, entityName: row.name, month, amount: num(form.amount),
        ...(form.receivedOn ? { receivedOn: form.receivedOn } : {}), ...(form.note.trim() ? { note: form.note.trim() } : {}),
        ...(proofBase64 ? { proofBase64, mimeType: form.file!.type || "application/pdf" } : {}), ...scope,
      });
      toast[r.caseOpened ? "warning" : "success"](r.caseOpened ? "Registado. Não bate com o devido: ficou um caso." : "Registado.");
      setForm(null);
      utils.cashCheck.monthly.invalidate(); utils.cashCheck.cases.invalidate();
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><ArrowLeftRight className="h-4 w-4 text-primary" /> Confirmar pagamentos</CardTitle>
        <p className="text-xs text-muted-foreground">Online: todos os dias confirma-se que a Multipark tem o pagamento Stripe de cada reserva paga online. Multibanco: talão na Contagem da caixa, ou o CSV da Viva Wallet. Transferências do fim do mês: registadas aqui. As diferenças abrem casos na fila.</p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {status.error && <p className="text-red-600">{status.error.message}</p>}
        {s && (
          <div className="grid gap-2 sm:grid-cols-3">
            <Source name="Stripe" s={s.stripe} />
            <Source name="Viva Wallet" s={s.viva} />
            <Source name="InvoiceExpress" s={s.invoiceExpress} />
            <p className="text-xs text-muted-foreground sm:col-span-3">
              Ligar ou desligar em Definições → Automações (só super admin).
              {s.last ? ` Última corrida: ${s.last.at} UTC${last ? ` · ${last.bookings} reserva(s) · online sem pagamento Stripe: ${last.online.findings}${last.partial ? " · incompleta" : ""}` : ""}.` : ""}
            </p>
          </div>
        )}

        <div className="space-y-2 rounded-md border p-3">
          <div className="text-xs font-medium text-muted-foreground">Viva Wallet: importar o extrato exportado (CSV com Date, Time, Amount, Channel)</div>
          <div className="flex flex-wrap gap-2">
            <Input type="file" accept=".csv,text/csv,text/plain" className="h-8 w-64" onChange={(e) => setVivaFile(e.target.files?.[0] ?? null)} />
            <Button size="sm" disabled={!vivaFile || viva.isPending} onClick={async () => { if (!vivaFile) return; if (vivaFile.size > 4_000_000) { toast.error("Ficheiro grande demais (máx. 4 MB)."); return; } viva.mutate({ csv: await vivaFile.text(), fileName: vivaFile.name, ...scope }); }}>
              {viva.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Importar
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Cada pagamento por multibanco da Multipark procura uma transação do terminal com o mesmo valor, no mesmo dia ou no seguinte.</p>
          {imports.data && imports.data.length > 0 && (
            <ul className="text-xs space-y-0.5">
              {imports.data.map((b) => <li key={b.id}>{b.at} · {b.byName ?? "—"} · {b.periodStart} → {b.periodEnd} · {b.txns} transação(ões), {b.matched} bateram, {b.extra} sem reserva, {b.casesOpened} caso(s){b.fileName ? ` · ${b.fileName}` : ""}</li>)}
            </ul>
          )}
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-xs font-medium text-muted-foreground">Recebimentos do fim do mês (Pro, agentes, agregadores)</div>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 w-40" />
            {monthly.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          {monthly.error && <p className="text-red-600">{monthly.error.message}</p>}
          {m?.duesError && <p className="text-xs text-amber-700">{m.duesError}</p>}
          {m && m.rows.length === 0 && <p className="text-xs text-muted-foreground">Sem reservas de parceiros nem de clientes Pro neste mês.</p>}
          {m && m.rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">Quem</th><th className="pr-2">Reservas</th><th className="pr-2">Devido (Multipark)</th><th className="pr-2">Recebido</th><th className="pr-2">Diferença</th><th /></tr></thead>
                <tbody>
                  {m.rows.map((row) => {
                    const key = `${row.kind}|${row.entityId}`;
                    return (
                      <tr key={key} className="border-t align-top">
                        <td className="py-1 pr-2"><div className="font-medium">{row.name}</div><div className="text-muted-foreground">{KIND_LABEL[row.kind] ?? row.kind}</div>
                          {row.receipts.map((r: any) => (
                            <div key={r.id} className="flex items-center gap-1 text-muted-foreground">
                              {eur(r.amount)}{r.receivedOn ? ` em ${r.receivedOn}` : ""} · {r.byName ?? "—"}
                              {r.proofUrl && <a className="text-primary underline" href={r.proofUrl} target="_blank" rel="noreferrer">comprovativo</a>}
                              <Button size="icon" variant="ghost" className="h-5 w-5" title="Tirar (fica registado)" onClick={() => removeMonthly.mutate({ id: r.id, ...scope })}><Trash2 className="h-3 w-3" /></Button>
                            </div>
                          ))}
                        </td>
                        <td className="pr-2">{row.bookings}</td>
                        <td className="pr-2">{eur(row.due)}{row.kind === "pro" ? <div className="text-muted-foreground">preço das reservas</div> : null}</td>
                        <td className="pr-2">{eur(row.received)}</td>
                        <td className={`pr-2 ${row.difference != null && Math.abs(row.difference) > 0.01 ? "text-red-700 font-medium" : ""}`}>{eur(row.difference)}</td>
                        <td className="pr-1">
                          {form?.key === key ? (
                            <div className="flex min-w-60 flex-col gap-1">
                              <Input className="h-7" inputMode="decimal" placeholder="Valor recebido" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                              <Input className="h-7" type="date" value={form.receivedOn} onChange={(e) => setForm({ ...form, receivedOn: e.target.value })} />
                              <Input className="h-7" placeholder="Nota (opcional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                              <Input className="h-7" type="file" accept="image/*,application/pdf" onChange={(e) => setForm({ ...form, file: e.target.files?.[0] ?? null })} />
                              <div className="flex gap-1">
                                <Button size="sm" className="h-7" disabled={busy} onClick={() => saveMonthly(row)}>{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Gravar"}</Button>
                                <Button size="sm" variant="ghost" className="h-7" onClick={() => setForm(null)}>Cancelar</Button>
                              </div>
                            </div>
                          ) : (
                            <Button size="sm" variant="outline" className="h-7" onClick={() => setForm({ key, amount: row.due != null ? String(Math.max(row.due - row.received, 0).toFixed(2)) : "", receivedOn: "", note: "", file: null })}>Registar recebido</Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
