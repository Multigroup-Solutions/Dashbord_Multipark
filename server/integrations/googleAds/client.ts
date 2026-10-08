/**
 * Cliente REST da Google Ads API — SÓ leitura (searchStream). Nada aqui
 * altera campanhas, orçamentos ou conversões.
 *
 * Cabeçalhos: Authorization (access token) e, quando o
 * acesso é feito através de uma conta gestora, login-customer-id.
 * Respeita limites: repete 429/5xx com espera progressiva; erros de
 * autorização sobem para o chamador marcar a ligação.
 */
import { readGoogleAdsConfig } from "./config";
import { getAccessToken } from "./oauth";
import {
  GAQL_CUSTOMER, GAQL_CUSTOMER_CLIENTS, gaqlCampaignDaily, gaqlClickView, gaqlConversionActions,
  parseCampaignDailyRow, parseClickViewRow, parseConversionActionRow, parseCustomerClientRow,
  type CampaignDailyRow, type ClickViewRow, type ConversionActionRow, type CustomerClientRow,
} from "./gaql";
import { normalizeCustomerId } from "./metrics";
import { fetchWithTimeout } from "../../_core/fetchWithTimeout";

export class GoogleAdsApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public retryable = false) { super(message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Prazo da corrida em curso (19b). Cada pedido usa só o tempo que resta e não
 * repete se a repetição já não cabe — antes um pedido podia levar 30 s × 4
 * tentativas e a Vercel cortava a função a meio, deixando o trinco preso.
 */
let apiDeadlineAt: number | null = null;
export function setGoogleAdsApiDeadline(at: number | null | undefined): void { apiDeadlineAt = at ?? null; }
/** Erro de "sem tempo": a corrida fica parcial e retoma (não é falha da conta). */
export class DeadlineError extends Error { readonly deadline = true; }
const timeLeft = () => (apiDeadlineAt == null ? Infinity : apiDeadlineAt - Date.now() - 2_000);

/**
 * Código do erro da Google Ads API: `error.status` (ex.: PERMISSION_DENIED) ou,
 * na falta dele, o primeiro `errorCode` dos detalhes. PURA.
 * (Antes: `a ?? b ? c : d` — o `??` ligava primeiro e o status nunca saía.)
 */
export function errorCodeOf(body: any): string | undefined {
  const status = body?.error?.status;
  if (typeof status === "string" && status) return status;
  const detail = body?.error?.details?.[0]?.errors?.[0]?.errorCode;
  return detail ? JSON.stringify(detail) : undefined;
}

async function apiFetch(path: string, init: RequestInit, loginCustomerId?: string | null): Promise<any> {
  const cfg = readGoogleAdsConfig();
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const login = loginCustomerId ?? cfg.loginCustomerId;
  if (login) headers["login-customer-id"] = normalizeCustomerId(login);
  const url = `https://googleads.googleapis.com/${cfg.apiVersion}/${path}`;

  let attempt = 0;
  for (;;) {
    attempt++;
    const left = timeLeft();
    if (left < 3_000) throw new DeadlineError("Sem tempo para mais um pedido à Google nesta corrida (continua na próxima).");
    const res = await fetchWithTimeout(url, { ...init, headers: { ...headers, ...(init.headers as any) }, timeoutMs: Math.min(30_000, left) });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    let code: string | undefined;
    try { code = errorCodeOf(JSON.parse(text)); } catch { /* texto */ }
    const retryable = res.status === 429 || res.status >= 500;
    const wait = 500 * 2 ** attempt;
    if (retryable && attempt < 4 && timeLeft() > wait + 5_000) { await sleep(wait); continue; }
    throw new GoogleAdsApiError(`Google Ads API ${res.status}: ${text.slice(0, 400)}`, res.status, code, retryable);
  }
}

/** searchStream devolve um array de blocos {results:[…]}; junta tudo. */
async function searchStream(customerId: string, query: string, loginCustomerId?: string | null): Promise<any[]> {
  const cid = normalizeCustomerId(customerId);
  const json = await apiFetch(`customers/${cid}/googleAds:searchStream`, { method: "POST", body: JSON.stringify({ query }) }, loginCustomerId);
  const blocks = Array.isArray(json) ? json : [json];
  const out: any[] = [];
  for (const b of blocks) for (const r of b?.results ?? []) out.push(r);
  return out;
}

/** Contas a que o utilizador autorizado tem acesso direto. */
export async function listAccessibleCustomers(): Promise<string[]> {
  const json = await apiFetch("customers:listAccessibleCustomers", { method: "GET" });
  return (json?.resourceNames ?? []).map((r: string) => r.replace(/^customers\//, ""));
}

/** Dados de uma conta (nome, moeda, fuso, se é gestora). */
export async function getCustomer(customerId: string, loginCustomerId?: string | null): Promise<CustomerClientRow | null> {
  const rows = await searchStream(customerId, GAQL_CUSTOMER, loginCustomerId);
  const c = rows[0]?.customer;
  if (!c) return null;
  return { customerId: String(c.id), name: String(c.descriptiveName ?? c.id), currency: c.currencyCode ?? null, timezone: c.timeZone ?? null, manager: Boolean(c.manager), status: "ENABLED", level: 0 };
}

/** Contas filhas de uma conta gestora (nível 1). */
export async function listCustomerClients(managerId: string): Promise<CustomerClientRow[]> {
  const rows = await searchStream(managerId, GAQL_CUSTOMER_CLIENTS, managerId);
  return rows.map(parseCustomerClientRow).filter((r): r is CustomerClientRow => Boolean(r));
}

export async function fetchCampaignDaily(customerId: string, from: string, to: string, loginCustomerId?: string | null): Promise<CampaignDailyRow[]> {
  const rows = await searchStream(customerId, gaqlCampaignDaily(from, to), loginCustomerId);
  return rows.map(parseCampaignDailyRow).filter((r): r is CampaignDailyRow => Boolean(r));
}

export async function fetchConversionActions(customerId: string, from: string, to: string, loginCustomerId?: string | null): Promise<ConversionActionRow[]> {
  const rows = await searchStream(customerId, gaqlConversionActions(from, to), loginCustomerId);
  return rows.map(parseConversionActionRow).filter((r): r is ConversionActionRow => Boolean(r));
}

/** Cliques (gclid → campanha) de UM dia da conta — click_view, só leitura. */
export async function fetchClickView(customerId: string, day: string, loginCustomerId?: string | null): Promise<ClickViewRow[]> {
  const rows = await searchStream(customerId, gaqlClickView(day), loginCustomerId);
  return rows.map(parseClickViewRow).filter((r): r is ClickViewRow => Boolean(r));
}
