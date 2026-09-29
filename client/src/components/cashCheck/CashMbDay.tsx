import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Camera, CheckCircle2, Loader2, Trash2 } from "lucide-react";

/**
 * Contagem da caixa → "Multibanco do dia" (R30): os pagamentos por multibanco
 * que a Multipark tem nesse parque e dia, e os talões fotografados. Cada talão
 * liga-se sozinho a um pagamento com o mesmo valor (ou ao da reserva
 * escolhida). "Confirmar multibanco do dia" regista quem confirmou; o que
 * ficar sem talão (ou talões a mais) abre um caso.
 */

const eur = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" }));
const num = (s: string) => Number(String(s).replace(",", "."));

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

export default function CashMbDay({ parkId, day, projectId }: { parkId: string; day: string; projectId?: number }) {
  const scope = projectId !== undefined ? { projectId } : {};
  const utils = trpc.useUtils();
  const q = trpc.cashCheck.mbDay.useQuery({ parkId, day, ...scope }, { enabled: !!parkId, retry: false });
  const [amount, setAmount] = useState("");
  const [bookingId, setBookingId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => { utils.cashCheck.mbDay.invalidate(); utils.cashCheck.cases.invalidate(); };
  const add = trpc.cashCheck.addMbReceipt.useMutation({ onError: (e) => toast.error(e.message) });
  const remove = trpc.cashCheck.removeMbReceipt.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const confirm = trpc.cashCheck.confirmMbDay.useMutation({
    onSuccess: (r) => { toast[r.caseOpened || r.unmatched || r.extra ? "warning" : "success"](r.unmatched || r.extra ? `Confirmado com ${r.unmatched} sem talão e ${r.extra} talão(ões) a mais: ficou um caso.` : "Multibanco do dia confirmado: tudo com talão."); refresh(); },
    onError: (e) => toast.error(e.message),
  });

  async function save() {
    if (!Number.isFinite(num(amount)) || num(amount) <= 0) { toast.error("Indica o valor do talão."); return; }
    if (file && file.size > 8 * 1024 * 1024) { toast.error("Foto maior do que 8 MB."); return; }
    setBusy(true);
    try {
      const photoBase64 = file ? await fileToBase64(file) : undefined;
      await add.mutateAsync({ parkId, day, amount: num(amount), ...(bookingId ? { bookingId } : {}), ...(photoBase64 ? { photoBase64, mimeType: file!.type || "image/jpeg" } : {}), ...scope });
      setAmount(""); setBookingId(""); setFile(null);
      refresh();
    } finally { setBusy(false); }
  }

  const d = q.data?.available ? q.data : null;
  if (q.data && !q.data.available) return <p className="text-sm text-red-600">{q.data.reason}</p>;
  const pending = d ? d.payments.filter((p) => p.receiptId == null) : [];
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">Multibanco do dia {d ? `· ${d.payments.length} pagamento(s), ${eur(d.total)}` : ""}</div>
        {q.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>
      {d?.paymentsError && <p className="text-xs text-amber-700">{d.paymentsError}</p>}
      {d && d.payments.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {d.payments.map((p, i) => (
            <li key={`${p.bookingId}-${i}`} className="flex items-center gap-2">
              {p.receiptId != null ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <span className="inline-block h-3.5 w-3.5 rounded-full border border-amber-500" />}
              <a className="text-primary underline" href={`/reserva/${p.bookingId}`}>#{p.code ?? p.bookingId}</a>
              <span>{eur(p.amount)}</span>
              <span className="text-muted-foreground">{p.method}</span>
              {p.receiptId == null && <span className="text-amber-700">sem talão</span>}
            </li>
          ))}
        </ul>
      )}
      {d && d.payments.length === 0 && !d.paymentsError && <p className="text-xs text-muted-foreground">Sem pagamentos por multibanco registados neste dia.</p>}

      <div className="flex flex-wrap items-end gap-2">
        <Input className="h-8 w-28" inputMode="decimal" placeholder="Valor do talão" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <select className="h-8 rounded-md border bg-background px-2 text-xs" value={bookingId} onChange={(e) => setBookingId(e.target.value)}>
          <option value="">Ligar pelo valor</option>
          {pending.map((p, i) => <option key={`${p.bookingId}-${i}`} value={p.bookingId}>#{p.code ?? p.bookingId} · {eur(p.amount)}</option>)}
        </select>
        <label className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border px-2 text-xs">
          <Camera className="h-4 w-4" /> {file ? file.name.slice(0, 18) : "Foto do talão"}
          <input type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <Button size="sm" disabled={busy || !amount.trim()} onClick={save}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Juntar talão"}</Button>
      </div>

      {d && d.receipts.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {d.receipts.map((r) => (
            <li key={r.id} className={`flex items-center gap-2 ${r.matched ? "" : "text-amber-700"}`}>
              <span>Talão {eur(r.amount)}</span>
              {r.photoUrl ? <a className="text-primary underline" href={r.photoUrl} target="_blank" rel="noreferrer">foto</a> : <span className="text-muted-foreground">sem foto</span>}
              {!r.matched && <span>sem pagamento com este valor</span>}
              <span className="text-muted-foreground">{r.byName ?? "—"} · {r.at}</span>
              <Button size="icon" variant="ghost" className="h-6 w-6" title="Tirar (fica registado)" onClick={() => remove.mutate({ id: r.id, ...scope })}><Trash2 className="h-3.5 w-3.5" /></Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={confirm.isPending || !d} onClick={() => confirm.mutate({ parkId, day, ...scope })}>Confirmar multibanco do dia</Button>
        {d?.confirmed && <span className="text-xs text-muted-foreground">Confirmado por {d.confirmed.byName ?? "—"} em {d.confirmed.at} UTC{d.confirmed.unmatched || d.confirmed.extraReceipts ? ` (${d.confirmed.unmatched} sem talão, ${d.confirmed.extraReceipts} a mais)` : ""}.</span>}
      </div>
    </div>
  );
}
