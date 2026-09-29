/**
 * InvoiceExpress — leitura (caixa, fase 4, R19): o documento de cada fatura
 * que a Multipark diz ter emitido (`Billing.invoiceExpressId`), para comparar
 * o valor e o estado reais com o que a Multipark guarda e com o pago.
 *
 * Chaves na Vercel (nunca no código nem no chat): INVOICEXPRESS_ACCOUNT (o
 * nome da conta, o "xxx" de xxx.app.invoicexpress.com) e INVOICEXPRESS_API_KEY.
 * Só se fazem pedidos GET. Sem chaves → "não configurado" (nada falha).
 */

export const IX_TIMEOUT_MS = 8_000;

export interface IxDocument { id: string; type: string; status: string | null; total: number | null; date: string | null; number: string | null }
export type IxResult = { ok: true; doc: IxDocument } | { ok: false; reason: "not_configured" | "not_found" | "error"; detail?: string };

export function ixConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.INVOICEXPRESS_ACCOUNT?.trim() && env.INVOICEXPRESS_API_KEY?.trim());
}

/** Tipo da Multipark ("INVOICE_RECEIPT", "CREDIT_NOTE"…) → caminho da API. PURA. */
export function ixPathFor(type: string | null | undefined): string {
  const t = String(type ?? "").toUpperCase();
  if (t.includes("CREDIT")) return "credit_notes";
  if (t.includes("SIMPLIFIED")) return "simplified_invoices";
  if (t.includes("INVOICE") && t.includes("RECEIPT")) return "invoice_receipts";
  if (t.includes("RECEIPT")) return "receipts";
  if (t.includes("DEBIT")) return "debit_notes";
  return "invoices";
}

/** Resposta da API → documento. A chave de topo depende do tipo ({ invoice: … }, { credit_note: … }). PURA. */
export function mapIxDocument(body: unknown, path: string): IxDocument | null {
  if (!body || typeof body !== "object") return null;
  const values = Object.values(body as Record<string, unknown>);
  const d = (values.length === 1 ? values[0] : (body as any)[path.replace(/s$/, "")]) as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object" || d.id == null) return null;
  const total = d.total != null ? Number(d.total) : d.sum != null ? Number(d.sum) : null;
  return {
    id: String(d.id), type: path, status: d.status != null ? String(d.status) : null,
    total: total != null && Number.isFinite(total) ? Math.round(total * 100) / 100 : null,
    date: d.date != null ? String(d.date) : null, number: d.inverted_sequence_number != null ? String(d.inverted_sequence_number) : d.sequence_number != null ? String(d.sequence_number) : null,
  };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Um documento. Nunca lança. */
export async function ixGetDocument(id: string, type: string | null | undefined, o: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}): Promise<IxResult> {
  const env = o.env ?? process.env;
  if (!ixConfigured(env)) return { ok: false, reason: "not_configured" };
  const account = env.INVOICEXPRESS_ACCOUNT!.trim().replace(/[^a-zA-Z0-9-]/g, "");
  const path = ixPathFor(type);
  const url = `https://${account}.app.invoicexpress.com/${path}/${encodeURIComponent(id)}.json?api_key=${encodeURIComponent(env.INVOICEXPRESS_API_KEY!.trim())}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IX_TIMEOUT_MS);
  try {
    const res = await (o.fetch ?? fetch)(url, { method: "GET", headers: { Accept: "application/json" }, signal: ctrl.signal });
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (!res.ok) return { ok: false, reason: "error", detail: `HTTP ${res.status}` };
    const doc = mapIxDocument(await res.json(), path);
    return doc ? { ok: true, doc } : { ok: false, reason: "error", detail: "resposta sem documento" };
  } catch (err) {
    return { ok: false, reason: "error", detail: (err as Error)?.name === "AbortError" ? "sem resposta (tempo esgotado)" : "falha de rede" };
  } finally {
    clearTimeout(timer);
  }
}
