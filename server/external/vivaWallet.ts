/**
 * Viva Wallet — leitura (caixa, fase 4): as transações de um dia (terminal
 * multibanco "Card Present" e links de pagamento "Smart Checkout"), para
 * confirmar os pagamentos por multibanco registados na Multipark.
 *
 * Chaves na Vercel (nunca no código nem no chat): VIVA_MERCHANT_ID e
 * VIVA_API_KEY (autenticação básica da API de transações). Só pedidos GET.
 * Interruptor CASH_VIVA_CHECK (desligado por omissão): até lá, o multibanco
 * confirma-se à mão com a foto do talão, ou importando o CSV exportado da Viva.
 */

export const VIVA_TIMEOUT_MS = 10_000;
const API = "https://www.vivapayments.com/api/transactions";

export interface VivaTxn { id: string; at: string | null; amount: number; channel: "terminal" | "link" | "other"; status: string | null; terminalId: string | null; sourceCode: string | null }

export function vivaConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.VIVA_MERCHANT_ID?.trim() && env.VIVA_API_KEY?.trim());
}

/** Canal da Viva → terminal (multibanco no parque), link (Smart Checkout) ou outro. PURA. */
export function vivaChannel(raw: unknown, terminalId?: unknown): VivaTxn["channel"] {
  const t = String(raw ?? "").toLowerCase();
  if (/card present|pos|terminal/.test(t) || (t === "" && terminalId)) return "terminal";
  if (/smart checkout|checkout|link|ecommerce|native/.test(t)) return "link";
  return "other";
}

/** Resposta da API → transações pagas (StatusId "F" = finalizada; reembolsos/anulações ficam de fora). PURA. */
export function mapVivaTransactions(body: any): VivaTxn[] {
  const list = Array.isArray(body?.Transactions) ? body.Transactions : Array.isArray(body) ? body : [];
  const out: VivaTxn[] = [];
  for (const x of list) {
    const status = x?.StatusId != null ? String(x.StatusId) : null;
    if (status && status.toUpperCase() !== "F") continue;
    const type = Number(x?.TransactionTypeId ?? 5);
    if ([4, 7, 13, 16].includes(type)) continue; // reembolsos / anulações
    const amount = Number(x?.Amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const terminalId = x?.TerminalId != null ? String(x.TerminalId) : null;
    out.push({
      id: String(x?.TransactionId ?? x?.Id ?? ""), at: x?.InsDate ? new Date(String(x.InsDate)).toISOString() : null, amount: Math.round(amount * 100) / 100,
      channel: vivaChannel(x?.Channel ?? x?.ChannelName ?? (terminalId ? "Card Present" : x?.Order?.OrderCode ? "Smart Checkout" : ""), terminalId),
      status, terminalId, sourceCode: x?.SourceCode != null ? String(x.SourceCode) : null,
    });
  }
  return out;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Transações de um dia (AAAA-MM-DD). Nunca lança. */
export async function vivaTransactionsOfDay(day: string, o: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}): Promise<{ ok: true; txns: VivaTxn[] } | { ok: false; detail: string }> {
  const env = o.env ?? process.env;
  if (!vivaConfigured(env)) return { ok: false, detail: "not_configured" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, detail: "dia inválido" };
  const auth = Buffer.from(`${env.VIVA_MERCHANT_ID!.trim()}:${env.VIVA_API_KEY!.trim()}`).toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VIVA_TIMEOUT_MS);
  try {
    const res = await (o.fetch ?? fetch)(`${API}?date=${day}`, { method: "GET", headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, txns: mapVivaTransactions(await res.json()) };
  } catch (err) {
    return { ok: false, detail: (err as Error)?.name === "AbortError" ? "sem resposta (tempo esgotado)" : "falha de rede" };
  } finally {
    clearTimeout(timer);
  }
}
