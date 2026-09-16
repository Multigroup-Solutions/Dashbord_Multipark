import { accountPattern, locationPattern, type GoogleReview } from './domain';
export type GoogleLocation = { name: string; title: string; storefrontAddress?: { addressLines?: string[]; locality?: string; postalCode?: string }; metadata?: { mapsUri?: string } };

export class BusinessClient {
  constructor(private token: string) {}
  private async get<T>(host: string, path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, `https://${host}`);
    url.search = new URLSearchParams(params).toString();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10_000) });
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
}
