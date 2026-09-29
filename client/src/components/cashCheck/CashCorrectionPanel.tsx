import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Info, Scale } from "lucide-react";
import { SEVERITY_LABEL, SEVERITY_TONE } from "./BookingCashCheck";

/**
 * Faturação → "Correção de caixa". Escolhe-se parque(s) e dia (Lisboa) e
 * carrega-se em "Comparar": as saídas desse dia são comparadas, NESSE
 * momento, entre a memória do webhook (era) e a BD da Multipark (é). Só
 * aparecem as reservas com divergência, com o motivo. Só leitura.
 */

const eur = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" }));

function lisbonYesterday(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

type DayOut = Extract<Awaited<ReturnType<ReturnType<typeof trpc.useUtils>["cashCheck"]["day"]["fetch"]>>, { available: true }>;
type Row = DayOut["rows"][number];

export default function CashCorrectionPanel({ projectId }: { projectId?: number }) {
  const utils = trpc.useUtils();
  const parksQ = trpc.cashCheck.parks.useQuery(projectId !== undefined ? { projectId } : undefined, { staleTime: 10 * 60_000, retry: false });
  const [day, setDay] = useState(lisbonYesterday());
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [onlyMemory, setOnlyMemory] = useState<Row[] | null>(null);
  const [meta, setMeta] = useState<{ scanned: number; nextCursor: string | null; truncated: boolean; memoryError: string | null; parks: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const parks = parksQ.data?.available ? parksQ.data.parks : [];
  const selected = useMemo(() => picked ?? new Set(parks.filter((p) => p.ours).map((p) => p.id)), [picked, parks]);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  async function run(cursor: string | null) {
    if (!selected.size) { setError("Escolhe pelo menos um parque."); return; }
    setLoading(true);
    setError(null);
    try {
      const r = await utils.cashCheck.day.fetch({ parkIds: [...selected].slice(0, 100), day, cursor, ...(projectId !== undefined ? { projectId } : {}) });
      if (!r.available) { setError(r.reason); return; }
      setRows((prev) => (cursor ? [...prev, ...r.rows] : r.rows));
      if (!cursor) setOnlyMemory(r.onlyMemory);
      setMeta((prev) => ({
        scanned: (cursor ? prev?.scanned ?? 0 : 0) + r.scanned,
        nextCursor: r.nextCursor,
        truncated: r.onlyMemoryTruncated || (cursor ? prev?.truncated ?? false : false),
        memoryError: r.memoryError,
        parks: r.parks.map((p) => p.name),
      }));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  if (parksQ.isLoading) return <p className="text-sm text-muted-foreground text-center py-6">A carregar…</p>;
  if (parksQ.error) return <Note text={parksQ.error.message} />;
  if (parksQ.data && !parksQ.data.available) return <Note text={`BD da Multipark indisponível: ${(parksQ.data as any).reason}`} />;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Scale className="w-4 h-4" /> Correção de caixa</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Para as reservas com <strong>saída</strong> no dia escolhido (hora de Lisboa), compara o que a Multipark nos disse pelo webhook
            (<strong>era</strong>, guardado sem nunca ser reescrito) com a BD da Multipark agora (<strong>é</strong>). Mostra só as divergências.
            Não corre sozinho: compara quando carregas em "Comparar".
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs">
              <span className="block text-muted-foreground mb-1">Dia (saídas)</span>
              <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-44" />
            </label>
            <Button onClick={() => run(null)} disabled={loading || !day}>{loading ? "A comparar…" : "Comparar"}</Button>
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set(parks.filter((p) => p.ours).map((p) => p.id)))}>Só os nossos</Button>
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>Limpar</Button>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {parks.map((p) => (
              <button key={p.id} type="button" onClick={() => toggle(p.id)}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${selected.has(p.id) ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted"}`}>
                {p.name}{p.city ? ` · ${p.city}` : ""}
              </button>
            ))}
          </div>
          {error && <Note text={error} />}
        </CardContent>
      </Card>

      {meta && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {rows.length} divergência(s) em {meta.scanned} saída(s) comparada(s){meta.nextCursor ? " (há mais)" : ""}
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">{meta.parks.join(", ")} · {day}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {meta.memoryError && <Note text={meta.memoryError} />}
            {rows.length === 0 && <p className="text-sm text-muted-foreground">Sem divergências nestas saídas.</p>}
            <RowList rows={rows} />
            {meta.nextCursor && (
              <Button variant="outline" size="sm" disabled={loading} onClick={() => run(meta.nextCursor)}>{loading ? "A comparar…" : "Comparar as seguintes"}</Button>
            )}
          </CardContent>
        </Card>
      )}

      {onlyMemory && onlyMemory.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Só na memória do webhook ({onlyMemory.length}{meta?.truncated ? "+" : ""})</CardTitle>
            <p className="text-[11px] text-muted-foreground">O webhook deu-as com saída neste dia, mas hoje a Multipark diz outra coisa (outro dia, outro parque, apagada).</p>
          </CardHeader>
          <CardContent><RowList rows={onlyMemory} /></CardContent>
        </Card>
      )}
    </div>
  );
}

function RowList({ rows }: { rows: Row[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="rounded-md border p-2 text-xs space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {r.severity && <Badge className={SEVERITY_TONE[r.severity] ?? ""}>{SEVERITY_LABEL[r.severity] ?? r.severity}</Badge>}
            <Link href={`/reserva/${encodeURIComponent(r.id)}`} className="font-semibold text-primary underline">#{r.code ?? r.id}</Link>
            <span>{r.parkName ?? "—"}</span>
            <span className="text-muted-foreground">{r.status ?? "—"}</span>
            <span className="text-muted-foreground">saída {r.checkOut ? fmtPTDateTime(r.checkOut) : "—"}</span>
            {r.cashierClosed && <Badge variant="outline">caixa fechada</Badge>}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums">
            <span>Era: {eur(r.priceFirst)}{r.priceCheckin != null && r.priceCheckin !== r.priceFirst ? ` · check-in ${eur(r.priceCheckin)}` : ""}{r.priceLast != null && r.priceLast !== r.priceFirst ? ` · último ${eur(r.priceLast)}` : ""}</span>
            <span>É: <strong>{eur(r.priceNow)}</strong></span>
            <span>Esperado {eur(r.expected)} · pago {eur(r.paid)}</span>
            <span>Método: {r.methodEra ?? "—"} → {r.methodNow ?? "—"}{r.paymentMethods.length ? ` (pagamentos: ${r.paymentMethods.join(", ")})` : ""}</span>
            <span className="text-muted-foreground">{r.eraSource === "copia" ? "era = cópia antiga (antes de 28/09; pode ter sido reescrita)" : r.eraSource === "historico" ? "era = preço inicial do histórico" : `${r.webhooks} webhook(s)`}</span>
          </div>
          <ul className="list-disc pl-5">
            {r.divergences.map((d, i) => <li key={i}><strong>{d.label}.</strong> {d.detail}</li>)}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function Note({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /> <span>{text}</span>
    </div>
  );
}
