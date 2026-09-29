/**
 * Stripe — leitura (caixa, fase 4, R20): pagamentos online (PaymentIntent e a
 * cobrança), reembolsos e disputas, para comparar com o que a Multipark diz.
 *
 * Chave na Vercel (nunca no código nem no chat): STRIPE_READ_KEY — uma chave
 * RESTRITA só de leitura (começa por "rk_"). Chaves secretas completas
 * ("sk_") são recusadas de propósito. Só pedidos GET, sem SDK.
 */

export const STRIPE_TIMEOUT_MS = 8_000;
const API = "https://api.stripe.com/v1";

export type StripeKeyState = "not_configured" | "not_restricted" | "ok";
export function stripeKeyState(env: NodeJS.ProcessEnv = process.env): StripeKeyState {
  const k = env.STRIPE_READ_KEY?.trim();
  if (!k) return "not_configured";
  return /^rk_(live|test)_/.test(k) ? "ok" : "not_restricted";
}

export interface StripePayment {
  id: string; status: string | null; amount: number | null; received: number | null;
  refunded: number | null; disputed: boolean; chargeId: string | null;
}
export interface StripeEvent { kind: "refund" | "dispute"; id: string; paymentIntent: string | null; charge: string | null; amount: number; status: string | null; created: number }

const cents = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)) / 100);

/** PaymentIntent (com a cobrança expandida) → pagamento. PURA. */
export function mapPaymentIntent(pi: any): StripePayment | null {
  if (!pi || typeof pi !== "object" || !pi.id) return null;
  const ch = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  return {
    id: String(pi.id), status: pi.status ?? null, amount: cents(pi.amount), received: cents(pi.amount_received),
    refunded: ch ? cents(ch.amount_refunded) : null, disputed: !!ch?.disputed, chargeId: ch?.id ?? (typeof pi.latest_charge === "string" ? pi.latest_charge : null),
  };
}

/** Lista de reembolsos/disputas → eventos. PURA. */
export function mapStripeList(kind: "refund" | "dispute", body: any): StripeEvent[] {
  const data = Array.isArray(body?.data) ? body.data : [];
  return data.map((x: any) => ({
    kind, id: String(x.id), paymentIntent: typeof x.payment_intent === "string" ? x.payment_intent : x.payment_intent?.id ?? null,
    charge: typeof x.charge === "string" ? x.charge : x.charge?.id ?? null, amount: cents(x.amount) ?? 0, status: x.status ?? null, created: Number(x.created ?? 0),
  }));
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function get(path: string, o: { env?: NodeJS.ProcessEnv; fetch?: Fetch }): Promise<{ ok: true; body: any } | { ok: false; status: number | null; detail: string }> {
  const env = o.env ?? process.env;
  const state = stripeKeyState(env);
  if (state !== "ok") return { ok: false, status: null, detail: state };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STRIPE_TIMEOUT_MS);
  try {
    const res = await (o.fetch ?? fetch)(`${API}${path}`, { method: "GET", headers: { Authorization: `Bearer ${env.STRIPE_READ_KEY!.trim()}` }, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, status: null, detail: (err as Error)?.name === "AbortError" ? "sem resposta (tempo esgotado)" : "falha de rede" };
  } finally {
    clearTimeout(timer);
  }
}

/** Um pagamento online. `null` = a Stripe não o mostra com esta chave (ex.: conta ligada). Nunca lança. */
export async function stripeGetPayment(paymentIntentId: string, o: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}): Promise<{ ok: true; payment: StripePayment | null } | { ok: false; detail: string }> {
  const r = await get(`/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`, o);
  if (!r.ok) return r.status === 404 ? { ok: true, payment: null } : { ok: false, detail: r.detail };
  return { ok: true, payment: mapPaymentIntent(r.body) };
}

/** Reembolsos e disputas criados desde `sinceSec` (até 100 de cada). Nunca lança. */
export async function stripeRecentEvents(sinceSec: number, o: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}): Promise<{ ok: true; events: StripeEvent[] } | { ok: false; detail: string }> {
  const [rf, dp] = await Promise.all([
    get(`/refunds?limit=100&created[gte]=${Math.floor(sinceSec)}`, o),
    get(`/disputes?limit=100&created[gte]=${Math.floor(sinceSec)}`, o),
  ]);
  if (!rf.ok) return { ok: false, detail: rf.detail };
  if (!dp.ok) return { ok: false, detail: dp.detail };
  return { ok: true, events: [...mapStripeList("refund", rf.body), ...mapStripeList("dispute", dp.body)] };
}
