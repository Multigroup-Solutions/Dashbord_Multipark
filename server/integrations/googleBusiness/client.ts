import { accountPattern, locationPattern, reviewPattern, type GoogleReview } from './domain';

/** Limite da Business Profile API para o texto da resposta. */
export const REPLY_MAX_LENGTH = 4096;
export type GoogleLocation = { name: string; title: string; storefrontAddress?: { addressLines?: string[]; locality?: string; postalCode?: string }; metadata?: { mapsUri?: string } };

export class BusinessClient {
  constructor(private token: string) {}
  private async get<T>(host: string, path: string, params: Record<string, string> = {}): Promise<T> {
    return this.request<T>('GET', host, path, params);
  }
  private async request<T>(method: 'GET' | 'PUT', host: string, path: string, params: Record<string, string> = {}, body?: unknown): Promise<T> {
    const url = new URL(path, `https://${host}`);
    url.search = new URLSearchParams(params).toString();
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // No response body: upstream errors may contain credentials or customer data.
      if (res.status === 429) throw new Error('Google: quota esgotada ou projeto ainda sem aprovação Business Profile (quota 0).');
      if (res.status === 403) throw new Error('Google: acesso recusado. Verifica a aprovação do projeto, as APIs e as permissões da conta.');
      if (res.status === 401) throw new Error('Google: autorização inválida. Volta a ligar a conta.');
      throw new Error(`Google Business Profile: erro HTTP ${res.status}.`);
    }
    return res.json() as Promise<T>;
  }
  accounts(pageToken = '') {
    return this.get<{ accounts?: { name: string; accountName?: string }[]; nextPageToken?: string }>(
      'mybusinessaccountmanagement.googleapis.com', '/v1/accounts', { pageSize: '20', ...(pageToken ? { pageToken } : {}) });
  }
  locations(account: string, pageToken = '') {
    if (!accountPattern.test(account)) throw new Error('Conta Google inválida.');
    return this.get<{ locations?: GoogleLocation[]; nextPageToken?: string }>('mybusinessbusinessinformation.googleapis.com',
      `/v1/${account}/locations`, { readMask: 'name,title,storefrontAddress', pageSize: '100', ...(pageToken ? { pageToken } : {}) });
  }
  reviews(account: string, location: string, pageToken = '') {
    if (!accountPattern.test(account) || !locationPattern.test(location)) throw new Error('Estabelecimento Google inválido.');
    return this.get<{ reviews?: GoogleReview[]; nextPageToken?: string; totalReviewCount?: number }>('mybusiness.googleapis.com',
      `/v4/${account}/${location}/reviews`, { pageSize: '50', orderBy: 'updateTime desc', ...(pageToken ? { pageToken } : {}) });
  }
  /** Publica (ou substitui) a resposta pública do estabelecimento a uma crítica. */
  reply(reviewName: string, comment: string) {
    if (!reviewPattern.test(reviewName)) throw new Error('Crítica Google inválida.');
    const text = comment.trim();
    if (!text || text.length > REPLY_MAX_LENGTH) throw new Error(`A resposta tem de ter entre 1 e ${REPLY_MAX_LENGTH} caracteres.`);
    return this.request<{ comment?: string; updateTime?: string }>('PUT', 'mybusiness.googleapis.com', `/v4/${reviewName}/reply`, {}, { comment: text });
  }
}
