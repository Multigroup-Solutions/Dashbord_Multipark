import { accountPattern, locationPattern, reviewPattern, type GoogleReview } from './domain';
import { GbpApiError, parseGoogleErrorBody, type DiagnoseContext } from './diagnostics';
import { GBP_LOCATION_PATTERN, POST_NAME_PATTERN, keywordsParams, performanceParams } from '../../../shared/googleBusinessProfile';

/** Limite da Business Profile API para o texto da resposta. */
export const REPLY_MAX_LENGTH = 4096;
export type GoogleLocation = {
  name: string; title: string;
  storefrontAddress?: { addressLines?: string[]; locality?: string; postalCode?: string };
  metadata?: { mapsUri?: string; placeId?: string; hasGoogleUpdated?: boolean; hasPendingEdits?: boolean; hasVoiceOfMerchant?: boolean; canOperateLocalPost?: boolean };
  openInfo?: { status?: string };
};

/**
 * Ritmo: as quotas do Business Profile são pequenas (300 pedidos/min depois
 * da aprovação; 0 antes). Um pedido a cada 250 ms por processo (≤ 240/min) e,
 * num 429 que não seja quota 0, espera e repete no máximo 2× dentro do prazo.
 */
export const GBP_MIN_INTERVAL_MS = 250;
let lastRequestAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClientOptions { deadlineAt?: number; minIntervalMs?: number; context?: DiagnoseContext; timeoutMs?: number }
type Params = Record<string, string> | Array<[string, string]>;
type Method = 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';

export class BusinessClient {
  constructor(private token: string, private opts: ClientOptions = {}) {}
  private async get<T>(host: string, path: string, params: Params = {}): Promise<T> {
    return this.request<T>('GET', host, path, params);
  }
  private async pace() {
    const gap = this.opts.minIntervalMs ?? GBP_MIN_INTERVAL_MS;
    const wait = lastRequestAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }
  private async request<T>(method: Method, host: string, path: string, params: Params = {}, body?: unknown): Promise<T> {
    const url = new URL(path, `https://${host}`);
    url.search = new URLSearchParams(params as any).toString();
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (res.ok) {
        // DELETE devolve corpo vazio ({} ou nada).
        if (res.status === 204) return {} as T;
        return (await res.json().catch(() => ({}))) as T;
      }
      // Só os campos estruturais do erro (a mensagem livre pode trazer dados).
      const parsed = await res.json().catch(() => null);
      const err = new GbpApiError(parseGoogleErrorBody(res.status, host, parsed, res.headers?.get?.('retry-after') ?? null), this.opts.context);
      const transient = (res.status === 429 && !err.isConfigError) || res.status === 503;
      const delay = Math.min(8_000, (err.info.retryAfterSec ?? 0) * 1000 || 1_000 * 2 ** attempt);
      if (transient && attempt < 2 && this.opts.deadlineAt && Date.now() + delay + 10_000 < this.opts.deadlineAt) { await sleep(delay); continue; }
      throw err;
    }
  }
  accounts(pageToken = '') {
    return this.get<{ accounts?: { name: string; accountName?: string }[]; nextPageToken?: string }>(
      'mybusinessaccountmanagement.googleapis.com', '/v1/accounts', { pageSize: '20', ...(pageToken ? { pageToken } : {}) });
  }
  /** Perfis de uma conta — readMask mínimo (inclui o estado: verificação, edições pendentes, alterado pela Google). */
  locations(account: string, pageToken = '', readMask = 'name,title,storefrontAddress,metadata,openInfo') {
    if (!accountPattern.test(account)) throw new Error('Conta Google inválida.');
    return this.get<{ locations?: GoogleLocation[]; nextPageToken?: string }>('mybusinessbusinessinformation.googleapis.com',
      `/v1/${account}/locations`, { readMask, pageSize: '100', ...(pageToken ? { pageToken } : {}) });
  }
  /** Horário normal e especiais de um perfil. */
  getHours(location: string) {
    if (!GBP_LOCATION_PATTERN.test(location)) throw new Error('Perfil Google inválido.');
    return this.get<{ name?: string; regularHours?: any; specialHours?: any; metadata?: GoogleLocation['metadata'] }>('mybusinessbusinessinformation.googleapis.com',
      `/v1/${location}`, { readMask: 'name,regularHours,specialHours,metadata' });
  }
  /** locations.patch com updateMask (só os campos indicados mudam). */
  patchLocation(location: string, updateMask: string, body: Record<string, unknown>) {
    if (!GBP_LOCATION_PATTERN.test(location)) throw new Error('Perfil Google inválido.');
    if (!/^(regularHours|specialHours)(,(regularHours|specialHours))?$/.test(updateMask)) throw new Error('Campos a alterar inválidos.');
    return this.request<Record<string, unknown>>('PATCH', 'mybusinessbusinessinformation.googleapis.com', `/v1/${location}`, { updateMask }, body);
  }
  /** Métricas diárias (todas de uma vez) — Business Profile Performance API. */
  performance(location: string, from: string, to: string) {
    if (!GBP_LOCATION_PATTERN.test(location)) throw new Error('Perfil Google inválido.');
    return this.get<any>('businessprofileperformance.googleapis.com', `/v1/${location}:fetchMultiDailyMetricsTimeSeries`, performanceParams(from, to));
  }
  /** Pesquisas que mostraram o perfil num mês (AAAA-MM). */
  keywords(location: string, month: string, pageToken = '') {
    if (!GBP_LOCATION_PATTERN.test(location) || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Pedido de pesquisas inválido.');
    return this.get<any>('businessprofileperformance.googleapis.com', `/v1/${location}/searchkeywords/impressions/monthly`, keywordsParams(month, pageToken));
  }
  reviews(account: string, location: string, pageToken = '') {
    if (!accountPattern.test(account) || !locationPattern.test(location)) throw new Error('Estabelecimento Google inválido.');
    return this.get<{ reviews?: GoogleReview[]; nextPageToken?: string; totalReviewCount?: number }>('mybusiness.googleapis.com',
      `/v4/${account}/${location}/reviews`, { pageSize: '50', orderBy: 'updateTime desc', ...(pageToken ? { pageToken } : {}) });
  }
  /** Publicações (v4 localPosts). */
  listPosts(account: string, location: string, pageSize = 20) {
    if (!accountPattern.test(account) || !locationPattern.test(location)) throw new Error('Estabelecimento Google inválido.');
    return this.get<any>('mybusiness.googleapis.com', `/v4/${account}/${location}/localPosts`, { pageSize: String(Math.max(1, Math.min(100, pageSize))) });
  }
  createPost(account: string, location: string, body: Record<string, unknown>) {
    if (!accountPattern.test(account) || !locationPattern.test(location)) throw new Error('Estabelecimento Google inválido.');
    return this.request<any>('POST', 'mybusiness.googleapis.com', `/v4/${account}/${location}/localPosts`, {}, body);
  }
  deletePost(name: string) {
    if (!POST_NAME_PATTERN.test(name)) throw new Error('Publicação Google inválida.');
    return this.request<Record<string, never>>('DELETE', 'mybusiness.googleapis.com', `/v4/${name}`);
  }
  /** Publica (ou substitui) a resposta pública do estabelecimento a uma crítica. */
  reply(reviewName: string, comment: string) {
    if (!reviewPattern.test(reviewName)) throw new Error('Crítica Google inválida.');
    const text = comment.trim();
    if (!text || text.length > REPLY_MAX_LENGTH) throw new Error(`A resposta tem de ter entre 1 e ${REPLY_MAX_LENGTH} caracteres.`);
    return this.request<{ comment?: string; updateTime?: string }>('PUT', 'mybusiness.googleapis.com', `/v4/${reviewName}/reply`, {}, { comment: text });
  }
}
