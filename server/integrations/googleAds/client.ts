/**
 * Cliente REST da Google Ads API — SÓ leitura (searchStream). Nada aqui
 * altera campanhas, orçamentos ou conversões.
 *
 * Cabeçalhos: Authorization (access token), developer-token e, quando o
 * acesso é feito através de uma conta gestora, login-customer-id.
 * Respeita limites: repete 429/5xx com espera progressiva; erros de
 * autorização sobem para o chamador marcar a ligação.
 */
import { readGoogleAdsConfig } from "./config";
import { getAccessToken } from "./oauth";
import {
  GAQL_CUSTOMER, GAQL_CUSTOMER_CLIENTS, gaqlCampaignDaily, gaqlConversionActions,
  parseCampaignDailyRow, parseConversionActionRow, parseCustomerClientRow,
  type CampaignDailyRow, type ConversionActionRow, type CustomerClientRow,
} from "./gaql";
import { normalizeCustomerId } from "./metrics";

export class GoogleAdsApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public retryable = false) { super(message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(path: string, init: RequestInit, loginCustomerId?: string | null): Promise<any> {
  const cfg = readGoogleAdsConfig();
  if (!cfg.developerToken) throw new GoogleAdsApiError("GOOGLE_ADS_DEVELOPER_TOKEN em falta", 0, "config");
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": cfg.developerToken,
    "Content-Type": "application/json",
  };
  const login = loginCustomerId ?? cfg.loginCustomerId;
  if (login) headers["login-customer-id"] = normalizeCustomerId(login);
  const url = `https://googleads.googleapis.com/${cfg.apiVersion}/${path}`;

  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as any) } });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    let code: string | undefined;
    try { const j = JSON.parse(text); code = j?.error?.status ?? j?.error?.details?.[0]?.errors?.[0]?.errorCode ? JSON.stringify(j.error.details[0].errors[0].errorCode) : undefined; } catch { /* texto */ }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 4) { await sleep(500 * 2 ** attempt); continue; }
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
