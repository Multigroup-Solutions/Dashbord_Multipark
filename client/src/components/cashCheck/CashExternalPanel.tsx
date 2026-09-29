import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeftRight, Loader2, Upload } from "lucide-react";

/**
 * Faturação → Correção de caixa → "Cruzamentos externos" (fase 4):
 * o estado das ligações só de leitura (InvoiceExpress, Stripe) com a última
 * corrida diária, e a importação dos extratos em CSV (terminal multibanco de
 * um parque, banco, parceiros). As diferenças abrem casos na fila de cima.
 */

const eur = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" }));
const KIND_LABEL: Record<string, string> = { tpa: "Terminal multibanco", banco: "Banco", parceiro: "Parceiro" };
const STATE_LABEL: Record<string, string> = { bate: "Bate", diferenca: "Diferença", sem_reserva: "Sem reserva", sem_referencia: "Sem referência", por_ver: "Por ver" };
const KEY_LABEL: Record<string, string> = {
  ok: "Ligada", not_configured: "Por configurar (chave na Vercel)", not_restricted: "Chave recusada: tem de ser restrita (rk_)", error: "Erro na última corrida",
};

export default function CashExternalPanel({ projectId }: { projectId?: number }) {
  const scope = projectId !== undefined ? { projectId } : {};
  const utils = trpc.useUtils();
  const status = trpc.cashCheck.externalStatus.useQuery(projectId !== undefined ? { projectId } : undefined, { retry: false, staleTime: 60_000 });
  const parksQ = trpc.cashCheck.parks.useQuery(projectId !== undefined ? { projectId } : undefined, { staleTime: 10 * 60_000, retry: false });
  const parks = useMemo(() => (parksQ.data?.available ? parksQ.data.parks.filter((p) => p.ours) : []), [parksQ.data]);
  const list = trpc.cashCheck.statements.useQuery(projectId !== undefined ? { projectId } : undefined, { retry: false });
  const [kind, setKind] = useState<"tpa" | "banco" | "parceiro">("tpa");
  const [parkId, setParkId] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const lines = trpc.cashCheck.statementLines.useQuery({ id: openId ?? 0, ...scope }, { enabled: openId != null, retry: false });
  const imp = trpc.cashCheck.importStatement.useMutation({
    onSuccess: (r) => {
      toast[r.casesOpened ? "warning" : "success"](`${r.lines} linha(s), ${r.matched} bateram${r.casesOpened ? `, ${r.casesOpened} caso(s) aberto(s)` : ""}.${r.errors.length ? ` ${r.errors.length} linha(s) ignoradas.` : ""}`);
      setFile(null); setOpenId(r.batchId);
      utils.cashCheck.statements.invalidate(); utils.cashCheck.cases.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  async function send() {
    if (!file) return;
    if (file.size > 2_000_000) { toast.error("Ficheiro grande demais (máx. 2 MB)."); return; }
    const csv = await file.text();
    imp.mutate({ kind, csv, fileName: file.name, ...(kind === "tpa" ? { parkId } : {}), ...(kind === "parceiro" && partnerName.trim() ? { partnerName: partnerName.trim() } : {}), ...scope });
  }

  const s = status.data;
  const last = s?.last?.summary;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><ArrowLeftRight className="h-4 w-4 text-primary" /> Cruzamentos externos</CardTitle>
        <p className="text-xs text-muted-foreground">Faturas na InvoiceExpress e pagamentos na Stripe (todos os dias, saídas de ontem e anteontem) e extratos que importas em CSV. As diferenças abrem casos na fila.</p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {status.error && <p className="text-red-600">{status.error.message}</p>}
        {s && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md bg-muted/50 p-2"><div className="text-xs text-muted-foreground">InvoiceExpress</div><div className="font-medium">{KEY_LABEL[s.invoiceExpress] ?? s.invoiceExpress}</div>
              {last && last.invoices.state === "ok" && <div className="text-xs text-muted-foreground">Última: {last.invoices.read} lida(s), {last.invoices.notFound} inexistente(s), {last.invoices.findings} com diferença</div>}
            </div>
            <div className="rounded-md bg-muted/50 p-2"><div className="text-xs text-muted-foreground">Stripe</div><div className="font-medium">{KEY_LABEL[last?.stripe.state === "error" ? "error" : s.stripe] ?? s.stripe}</div>
              {last && last.stripe.state === "ok" && <div className="text-xs text-muted-foreground">Última: {last.stripe.read} pagamento(s), {last.stripe.events} reembolso(s)/disputa(s), {last.stripe.findings} com diferença</div>}
            </div>
            {s.last && <p className="text-xs text-muted-foreground sm:col-span-2">Última corrida: {s.last.at} UTC{last ? ` · dias ${last.days.join(" e ")} · ${last.bookings} reserva(s)${last.partial ? " · incompleta (retoma amanhã)" : ""}` : ""}</p>}
          </div>
        )}

        <div className="space-y-2 rounded-md border p-3">
          <div className="text-xs font-medium text-muted-foreground">Importar extrato (CSV com data e valor; referência nos parceiros)</div>
          <div className="flex flex-wrap gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="h-8 w-48"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(KIND_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
            </Select>
            {kind === "tpa" && (
              <Select value={parkId} onValueChange={setParkId}>
                <SelectTrigger className="h-8 w-60"><SelectValue placeholder="Parque do terminal" /></SelectTrigger>
                <SelectContent>{parks.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.city ? ` (${p.city})` : ""}</SelectItem>)}</SelectContent>
              </Select>
            )}
            {kind === "parceiro" && <Input className="h-8 w-48" placeholder="Parceiro (ex.: Parkos)" value={partnerName} onChange={(e) => setPartnerName(e.target.value)} />}
            <Input type="file" accept=".csv,text/csv,text/plain" className="h-8 w-64" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button size="sm" disabled={!file || imp.isPending || (kind === "tpa" && !parkId)} onClick={send}>
              {imp.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Importar
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Terminal: soma do dia = pagamentos por cartão/multibanco desse parque. Banco: cada transferência registada tem de aparecer até 5 dias depois. Parceiro: o valor de cada reserva = devido na Multipark.
          </p>
        </div>

        {list.data && list.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">Importado</th><th className="pr-2">Tipo</th><th className="pr-2">Período</th><th className="pr-2">Linhas</th><th className="pr-2">Bateram</th><th className="pr-2">Casos</th><th /></tr></thead>
              <tbody>
                {list.data.map((b) => (
                  <tr key={b.id} className="border-t">
                    <td className="py-1 pr-2 whitespace-nowrap">{b.at} · {b.byName ?? "—"}</td>
                    <td className="pr-2">{KIND_LABEL[b.kind] ?? b.kind}{b.partnerName ? ` · ${b.partnerName}` : ""}{b.fileName ? <span className="text-muted-foreground"> ({b.fileName})</span> : null}</td>
                    <td className="pr-2 whitespace-nowrap">{b.periodStart} → {b.periodEnd}</td>
                    <td className="pr-2">{b.lines}</td><td className="pr-2">{b.matched}</td><td className="pr-2">{b.casesOpened}</td>
                    <td><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setOpenId(openId === b.id ? null : b.id)}>{openId === b.id ? "Fechar" : "Linhas"}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {openId != null && (
          <div className="max-h-80 overflow-auto rounded-md border">
            {lines.isLoading && <p className="p-2 text-muted-foreground">A carregar…</p>}
            {lines.error && <p className="p-2 text-red-600">{lines.error.message}</p>}
            {lines.data && (
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted-foreground"><th className="p-1">#</th><th>Dia</th><th>Valor</th><th>Referência</th><th>Descrição</th><th>Resultado</th><th>Reserva</th></tr></thead>
                <tbody>
                  {lines.data.map((l) => (
                    <tr key={l.lineNo} className={`border-t ${l.state === "bate" ? "" : "bg-amber-50 dark:bg-amber-950/30"}`}>
                      <td className="p-1">{l.lineNo}</td><td>{l.day}</td><td>{eur(l.amount)}</td><td>{l.reference ?? "—"}</td><td className="max-w-60 truncate">{l.description ?? ""}</td>
                      <td>{STATE_LABEL[l.state] ?? l.state}</td>
                      <td>{l.bookingId ? <a className="text-primary underline" href={`/reserva/${l.bookingId}`}>#{l.bookingCode ?? l.bookingId}</a> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
