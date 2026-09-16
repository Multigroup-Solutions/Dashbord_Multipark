import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./oauth', () => ({ database: vi.fn(), accessToken: vi.fn(), connection: vi.fn(), saveConnection: vi.fn() }));
import { accessToken, database } from './oauth';
import { publishReply } from './service';
import { BusinessClient, REPLY_MAX_LENGTH } from './client';

const NAME = 'accounts/123/locations/456/reviews/AbC_-9';
let row: any, updates: any[], fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  row = { id: 5, name: NAME, complaintId: null };
  updates = [];
  const db: any = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
    update: () => ({ set: (data: any) => ({ where: async () => { updates.push(data); return [{ affectedRows: 1 }]; } }) }),
  };
  vi.mocked(database).mockResolvedValue(db);
  vi.mocked(accessToken).mockResolvedValue('ya29.token-de-teste');
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ comment: 'Obrigado!', updateTime: '2026-09-16T10:00:00Z' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('publicar resposta no Google', () => {
  it('faz PUT …/reviews/{id}/reply com o texto e só depois grava na BD', async () => {
    const result = await publishReply(5, '  Obrigado!  ', 42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(`https://mybusiness.googleapis.com/v4/${NAME}/reply`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ comment: 'Obrigado!' });
    expect((init.headers as any).Authorization).toBe('Bearer ya29.token-de-teste');
    expect(result.publishedAt).toBe('2026-09-16 10:00:00');
    expect(updates).toEqual([expect.objectContaining({ googleReply: 'Obrigado!', aiResponse: 'Obrigado!', aiResponseApproved: 1,
      respondedBy: 42, respondedAt: '2026-09-16 10:00:00', status: 'manually_responded' })]);
  });
  it('mantém o estado "convertida em reclamação" quando a crítica gerou reclamação', async () => {
    row.complaintId = 9;
    await publishReply(5, 'Lamentamos.', 42);
    expect(updates[0].status).toBe('converted_complaint');
  });
  it('recusa críticas vindas por email (sem ligação ao Google) sem chamar a API nem tocar na BD', async () => {
    row.name = null;
    await expect(publishReply(5, 'Olá', 42)).rejects.toThrow(/veio por email/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
  it('se a Google recusar (quota 0 / sem permissão), nada é gravado na BD', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(publishReply(5, 'Olá', 42)).rejects.toThrow(/quota/);
    expect(updates).toEqual([]);
  });
  it('valida o texto: vazio e acima do limite da API', async () => {
    await expect(publishReply(5, '   ', 42)).rejects.toThrow(/Escreve a resposta/);
    await expect(publishReply(5, 'x'.repeat(REPLY_MAX_LENGTH + 1), 42)).rejects.toThrow(/máximo/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('o cliente rejeita nomes de crítica malformados antes de sair para a rede', async () => {
    const client = new BusinessClient('t');
    expect(() => client.reply('accounts/1/locations/2/reviews/../x', 'Olá')).toThrow(/inválida/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
