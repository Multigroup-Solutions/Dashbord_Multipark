/**
 * Passagem de turno → Despesas do turno (29d, Jorge 6 out 2026: "na passagem
 * de turno pode-se colocar despesas do turno e elas entram diretamente para a
 * caixa e para as despesas"). Cada linha (descrição, valor, foto do talão)
 * entra logo nas Despesas como paga em dinheiro, no centro da cidade, e abate
 * ao dinheiro que tem de estar na caixa do dia (Financeiro → Caixa → Por dia).
 * "Anular" deixa-a cancelada (nunca se apaga).
 *
 * 12 out 2026 (Jorge: "o team leader envia as despesas por aqui e não pelo
 * Financeiro, com as mesmas funcionalidades: tirar fotografia e a IA ler o
 * talão"): a foto é comprimida como nas Despesas, carregada e lida pela MESMA
 * IA (shiftHandover.readReceipt → expense_ocr), que preenche descrição, valor
 * e os dados do talão (fornecedor, NIF, n.º, data, IVA, categoria) — tudo
 * editável antes de "Lançar". A IA nunca escreve por cima do que a pessoa
 * escreveu. Se estiver desligada ou falhar, preenche-se à mão como antes.
 * Cada despesa lançada tem "Abrir nas Despesas" (para quem a pode ver lá).
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { prepareInvoiceFile } from "@/lib/invoiceFile";
import { can } from "@shared/access";
import { expenseLink } from "@shared/expenseLink";
import { normalizeSupplierNif } from "@shared/supplierNif";
import { parseVatInput, shiftReceiptDateProblem, shiftReceiptVatProblem } from "@shared/shiftReceipt";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Camera, ChevronDown, ChevronUp, ExternalLink, Loader2, Paperclip, Plus, Sparkles, Undo2 } from "lucide-react";

const eur = (v: number) => new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);
const num = (v: number | null | undefined) => (v == null ? "" : v.toFixed(2).replace(".", ","));

type Extras = { supplier: string; supplierNif: string; documentNumber: string; invoiceDate: string; vatAmount: string; categoryId: string };
const EMPTY: Extras = { supplier: "", supplierNif: "", documentNumber: "", invoiceDate: "", vatAmount: "", categoryId: "" };
type Phase = "idle" | "uploading" | "reading";
type Reading = {
  selfInvoice: boolean; nifValid: boolean | null;
  category: { id: number; name: string } | null;
  duplicate: { id: number | null; documentNumber: string | null } | null;
};

/** A IA só preenche o que está vazio ou o que ela própria tinha preenchido antes (nova foto). */
const fillAi = (cur: string, prevAi: string | undefined, next: string) =>
  !next ? cur : (cur.trim() === "" || cur === prevAi ? next : cur);

export function ShiftExpensesCard({ date, shift, city, canEdit, onTotal }: {
  date: string; shift: "morning" | "night"; city: "lisbon" | "porto" | "faro"; canEdit: boolean; onTotal?: (total: number) => void;
}) {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const q = trpc.shiftHandover.expenses.useQuery({ date, shift, city }, { retry: false });
  // A lista das categorias é a das Despesas: só para quem as vê; os outros ficam com a sugerida pela IA.
  const canSeeCategories = can(user, "despesas", "view");
  const cats = trpc.categories.list.useQuery(undefined, { enabled: canEdit && canSeeCategories, retry: false, staleTime: 5 * 60_000 });
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [extras, setExtras] = useState<Extras>(EMPTY);
  const [showExtras, setShowExtras] = useState(false);
  const [receipt, setReceipt] = useState<{ key: string; url: string; name: string } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [reading, setReading] = useState<Reading | null>(null);
  const [aiUsed, setAiUsed] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  // O que a IA preencheu da última vez (uma nova foto pode substituir isso, nunca o que a pessoa escreveu).
  const lastAi = useRef<Partial<Record<keyof Extras | "desc" | "amount", string>>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => { utils.shiftHandover.expenses.invalidate(); };
  const upload = trpc.shiftHandover.uploadReceipt.useMutation();
  const read = trpc.shiftHandover.readReceipt.useMutation();
  const reset = () => {
    setDesc(""); setAmount(""); setExtras(EMPTY); setShowExtras(false); setReceipt(null);
    setReading(null); setAiUsed(false); setAiNote(null); lastAi.current = {};
  };
  const add = trpc.shiftHandover.addExpense.useMutation({
    onSuccess: () => { reset(); refresh(); toast.success("Despesa lançada — já está nas Despesas e abate à caixa do dia"); },
    onError: (e) => toast.error(e.message),
  });
  const cancel = trpc.shiftHandover.cancelExpense.useMutation({ onSuccess: () => { refresh(); toast.success("Despesa anulada (fica cancelada no histórico)"); }, onError: (e) => toast.error(e.message) });
  const total = q.data?.total ?? 0;
  useEffect(() => { if (q.data) onTotal?.(total); }, [q.data, total]); // eslint-disable-line react-hooks/exhaustive-deps
  const setX = (k: keyof Extras, v: string) => setExtras((p) => ({ ...p, [k]: v }));

  const pickFile = async (file: File) => {
    setAiNote(null);
    let prepared: Awaited<ReturnType<typeof prepareInvoiceFile>>;
    setPhase("uploading");
    try {
      prepared = await prepareInvoiceFile(file);
      const out = await upload.mutateAsync({ fileName: prepared.upload.fileName, fileBase64: prepared.upload.base64, mimeType: prepared.upload.mimeType });
      setReceipt({ ...out, name: file.name });
    } catch (e: any) {
      toast.error(e?.message ?? "Não foi possível carregar o talão");
      setPhase("idle");
      return;
    }
    // A IA lê o talão (a mesma das Despesas). Falhar nunca bloqueia: preenche-se à mão.
    setPhase("reading");
    try {
      const r = await read.mutateAsync({ imageBase64: prepared.ai.base64, mimeType: prepared.ai.mimeType });
      const prev = lastAi.current;
      const next = {
        desc: (r.description ?? r.supplier ?? "").slice(0, 255),
        amount: num(r.amount),
        supplier: r.supplier ?? "",
        supplierNif: r.supplierNif ?? "",
        documentNumber: r.documentNumber ?? "",
        invoiceDate: r.invoiceDate ?? "",
        vatAmount: num(r.vatAmount),
        categoryId: r.category ? String(r.category.id) : "",
      };
      setDesc((cur) => fillAi(cur, prev.desc, next.desc));
      setAmount((cur) => fillAi(cur, prev.amount, next.amount));
      setExtras((cur) => ({
        supplier: fillAi(cur.supplier, prev.supplier, next.supplier),
        supplierNif: fillAi(cur.supplierNif, prev.supplierNif, next.supplierNif),
        documentNumber: fillAi(cur.documentNumber, prev.documentNumber, next.documentNumber),
        invoiceDate: fillAi(cur.invoiceDate, prev.invoiceDate, next.invoiceDate),
        vatAmount: fillAi(cur.vatAmount, prev.vatAmount, next.vatAmount),
        categoryId: fillAi(cur.categoryId, prev.categoryId, next.categoryId),
      }));
      lastAi.current = next;
      setReading({ selfInvoice: r.selfInvoice, nifValid: r.nifValid, category: r.category, duplicate: r.duplicate });
      const readSomething = !!(r.amount || r.supplier || r.description || r.documentNumber);
      setAiUsed(readSomething);
      if (readSomething) setShowExtras(true);
      else setAiNote("A IA não conseguiu ler o talão — preenche à mão.");
    } catch (e: any) {
      setAiNote(`A IA não leu o talão${e?.message ? ` (${String(e.message).slice(0, 120)})` : ""} — preenche à mão.`);
    } finally {
      setPhase("idle");
    }
  };

  const submit = () => {
    const v = Number(String(amount).replace(",", "."));
    if (!desc.trim() || !(v > 0)) { toast.error("Escreve a descrição e o valor."); return; }
    const nif = normalizeSupplierNif(extras.supplierNif);
    if (!nif.ok) { setShowExtras(true); toast.error(nif.message); return; }
    const dateProblem = shiftReceiptDateProblem(extras.invoiceDate, date);
    if (dateProblem) { setShowExtras(true); toast.error(dateProblem); return; }
    const vat = parseVatInput(extras.vatAmount);
    const vatProblem = vat != null && Number.isNaN(vat) ? "IVA inválido (ex.: 2,30)." : shiftReceiptVatProblem(vat, v);
    if (vatProblem) { setShowExtras(true); toast.error(vatProblem); return; }
    add.mutate({
      date, shift, city, description: desc.trim(), amount: v, invoiceKey: receipt?.key ?? null, invoiceUrl: receipt?.url ?? null,
      supplier: extras.supplier.trim() || null, supplierNif: nif.nif, documentNumber: extras.documentNumber.trim() || null,
      invoiceDate: extras.invoiceDate || null, vatAmount: vat, categoryId: extras.categoryId ? Number(extras.categoryId) : null,
      extractedByAi: aiUsed,
    });
  };

  const busy = phase !== "idle";
  const nifCheck = normalizeSupplierNif(extras.supplierNif);
  const dateProblem = shiftReceiptDateProblem(extras.invoiceDate, date);
  // Categorias: a lista das Despesas (quem a vê) ou só a sugerida pela IA.
  const catOptions: Array<{ id: number; name: string }> = canSeeCategories && cats.data
    ? (cats.data as any[]).map((c) => ({ id: Number(c.id), name: String(c.name) }))
    : reading?.category ? [reading.category] : [];

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-sm font-medium flex-1">Despesas do turno (pagas com o dinheiro da caixa)</p>
        <span className="text-sm tabular-nums">Total: <b>{eur(total)}</b></span>
      </div>
      <p className="text-[11px] text-muted-foreground">Cada despesa entra logo nas <b>Despesas</b> (paga, dinheiro, com o talão) e abate ao dinheiro que tem de estar na <b>caixa do dia</b>. Tira a foto do talão: a IA lê-o e preenche — confirma antes de lançar.</p>
      {q.error ? <p className="text-xs text-destructive">{q.error.message}</p> : (q.data?.rows ?? []).length > 0 && (
        <ul className="space-y-1.5 text-sm">
          {(q.data?.rows ?? []).map((r) => (
            <li key={r.id} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className={`break-words ${r.status === "cancelled" ? "text-muted-foreground line-through" : ""}`}>
                  {r.description}{r.supplier && r.supplier !== r.description ? <span className="text-muted-foreground"> · {r.supplier}</span> : null}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {r.canOpen ? (
                    <a href={expenseLink(r.id)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                      Abrir nas Despesas (n.º {r.id})<ExternalLink className="h-3 w-3" />
                    </a>
                  ) : <span>Já está nas Despesas (n.º {r.id})</span>}
                  {r.status === "cancelled" && <span> · anulada</span>}
                </p>
              </div>
              {r.hasReceipt ? <Paperclip className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="Com talão" /> : <span className="mt-0.5 shrink-0 text-[10px] text-amber-700">sem talão</span>}
              <span className={`tabular-nums shrink-0 ${r.status === "cancelled" ? "text-muted-foreground line-through" : ""}`}>{eur(r.amount)}</span>
              {canEdit && r.status !== "cancelled" && (
                <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5 shrink-0" title="Anular (fica cancelada no histórico)" aria-label={`Anular ${r.description}`} disabled={cancel.isPending}
                  onClick={() => { if (confirm(`Anular "${r.description}"? Sai da caixa e fica cancelada nas Despesas.`)) cancel.mutate({ id: r.id }); }}>
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_7rem_auto_auto]">
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="ex.: Combustível carrinha, lavagem…" aria-label="Descrição da despesa do turno" maxLength={255} />
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="€" aria-label="Valor da despesa do turno" />
            <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ""; }} />
            <Button type="button" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()} title="Foto do talão (a IA lê-o)">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
              <span className="ml-1">{phase === "uploading" ? "A carregar…" : phase === "reading" ? "A ler o talão…" : receipt ? "Talão ✓" : "Talão"}</span>
            </Button>
            <Button type="button" disabled={add.isPending || busy} onClick={submit}><Plus className="h-4 w-4 mr-1" />Lançar</Button>
          </div>
          {phase === "reading" && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />A ler o talão… (podes continuar a escrever)</p>}
          {aiNote && <p className="text-xs text-amber-700 dark:text-amber-400">{aiNote}</p>}
          {reading?.selfInvoice && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />Este documento parece uma fatura <b>emitida pela Multipark</b> a um cliente — não é uma despesa. Confirma antes de lançar.</p>
          )}
          {reading?.duplicate && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Este talão{reading.duplicate.documentNumber ? ` (${reading.duplicate.documentNumber})` : ""} parece já estar nas Despesas{reading.duplicate.id ? <> — <a href={expenseLink(reading.duplicate.id)} target="_blank" rel="noopener noreferrer" className="underline">n.º {reading.duplicate.id}</a></> : ""}. Confirma antes de lançar outra vez.</span>
            </p>
          )}
          <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowExtras((v) => !v)} aria-expanded={showExtras}>
            {showExtras ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {aiUsed ? <><Sparkles className="h-3.5 w-3.5 text-violet-600" />O que a IA leu do talão (confirma e corrige)</> : "Dados do talão (opcional): fornecedor, NIF, n.º, data, IVA, categoria"}
          </button>
          {showExtras && (
            <div className="grid grid-cols-1 gap-2 rounded-md bg-muted/40 p-2 sm:grid-cols-3">
              <label className="space-y-0.5 text-[11px] text-muted-foreground">Fornecedor
                <Input className="h-8 text-sm" value={extras.supplier} onChange={(e) => setX("supplier", e.target.value)} maxLength={256} />
              </label>
              <label className="space-y-0.5 text-[11px] text-muted-foreground">NIF
                <Input className={`h-8 text-sm ${!nifCheck.ok ? "border-destructive" : ""}`} value={extras.supplierNif} onChange={(e) => setX("supplierNif", e.target.value)} inputMode="numeric" maxLength={40} aria-invalid={!nifCheck.ok} />
                {!nifCheck.ok && <span className="block text-destructive">{nifCheck.message}</span>}
              </label>
              <label className="space-y-0.5 text-[11px] text-muted-foreground">N.º do documento
                <Input className="h-8 text-sm" value={extras.documentNumber} onChange={(e) => setX("documentNumber", e.target.value)} maxLength={64} />
              </label>
              <label className="space-y-0.5 text-[11px] text-muted-foreground">Data do talão
                <Input className={`h-8 text-sm ${dateProblem ? "border-destructive" : ""}`} type="date" value={extras.invoiceDate} onChange={(e) => setX("invoiceDate", e.target.value)} aria-invalid={!!dateProblem} />
                {dateProblem && <span className="block text-destructive">{dateProblem}</span>}
              </label>
              <label className="space-y-0.5 text-[11px] text-muted-foreground">IVA (€)
                <Input className="h-8 text-sm" value={extras.vatAmount} onChange={(e) => setX("vatAmount", e.target.value)} inputMode="decimal" placeholder="ex.: 2,30" />
              </label>
              <label className="space-y-0.5 text-[11px] text-muted-foreground">Categoria
                <select className="h-8 w-full rounded-md border bg-background px-2 text-sm text-foreground" value={extras.categoryId} onChange={(e) => setX("categoryId", e.target.value)}>
                  <option value="">Sem categoria</option>
                  {catOptions.map((c) => <option key={c.id} value={String(c.id)}>{c.name}{reading?.category?.id === c.id ? " (sugerida pela IA)" : ""}</option>)}
                </select>
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
