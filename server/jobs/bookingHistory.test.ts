import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ fetch: vi.fn(), failSave: false,
  row: {} as Record<string, any>, entries: new Map<string, any>(), pending: [] as any[], updates: [] as any[],
}));
vi.mock('../multipark', () => ({
  getBookingHistory: f.fetch, getBookingsReport: vi.fn(), getBooking: vi.fn(), getAgentHistory: vi.fn(),
  isMultiparkConfigured: () => true, getConfiguredParks: () => [], getParkApiKey: () => undefined,
  matchParkConfig: () => undefined,
}));
vi.mock('../identityReconcile', () => ({ autoAttachAgentsByEmail: vi.fn() }));
vi.mock('../db', () => ({
  upsertMultiparkBooking: vi.fn(), upsertBookingExtras: vi.fn(), createSyncLog: vi.fn(),
  getProjects: async () => [], getLastSyncSuccessAt: async () => null,
  getDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => f.pending }) }) }) }),
    update: () => ({ set: (value: any) => ({ where: async () => { f.updates.push(value); Object.assign(f.row, value); } }) }),
    transaction: async (run: (tx: any) => Promise<void>) => {
      const entries = new Map(f.entries); const row = { ...f.row };
      await run({
        insert: () => ({ values: (value: any) => ({ onDuplicateKeyUpdate: async () => {
          entries.set(value.historyId, value);
          if (f.failSave) throw Object.assign(new Error('wrapped'), { cause: { code: 'ER_LOCK_DEADLOCK' } });
        } }) }),
        update: () => ({ set: (value: any) => ({ where: async () => { Object.assign(row, value); } }) }),
      });
      f.entries = entries; f.row = row;
    },
  }),
}));
import { syncBookingHistory, syncBookingHistoryBatch } from './multiparkBookingSync';

beforeEach(() => {
  f.fetch.mockReset(); f.failSave = false; f.entries.clear(); f.pending = []; f.updates = [];
  f.row = { historyFetchedAt: '2026-08-01 10:00:00', currentGarage: 'Anterior', historyAttempts: 0 };
});
const item = (id: string, time: string, garage: string) => ({ id, actionTime: time,
  modifiedFields: { garagem: garage, km: 123 }, changeType: 'MOVEMENT' });

describe('histórico recuperável', () => {
  it('preserva o sucesso anterior e agenda nova tentativa quando a origem falha', async () => {
    f.fetch.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    expect(await syncBookingHistory('b1', 'test')).toBe(false);
    expect(f.row).toMatchObject({ historyFetchedAt: '2026-08-01 10:00:00', currentGarage: 'Anterior', historyErrorCode: 'API_HTTP_404' });
    expect(f.updates[0]).toHaveProperty('historyRetryAt');
    expect(f.updates[0]).not.toHaveProperty('historyFetchedAt');
  });
  it('ordena eventos e repete a importação sem duplicar movimentos', async () => {
    f.fetch.mockResolvedValue({ bookingId: 'b1', total: 2, history: [
      item('new', '10/09/2026, 12:00', 'Nova'), item('old', '2026-09-09T12:00:00Z', 'Antiga'),
    ] });
    expect(await syncBookingHistory('b1', 'test')).toBe(true);
    expect(await syncBookingHistory('b1', 'test')).toBe(true);
    expect(f.entries.size).toBe(2);
    expect(f.row).toMatchObject({ currentGarage: 'Nova', lastKnownMileage: 123,
      historyErrorCode: null, historyRetryAt: null, historyAttempts: 0 });
    expect(f.row.historyFetchedAt).not.toBe('2026-08-01 10:00:00');
  });
  it('não grava metade do histórico nem declara sucesso se falhar a transação', async () => {
    f.fetch.mockResolvedValue({ bookingId: 'b1', total: 1, history: [item('new', '2026-09-10T12:00:00Z', 'Nova')] });
    f.failSave = true;
    expect(await syncBookingHistory('b1', 'test')).toBe(false);
    expect(f.entries.size).toBe(0);
    expect(f.row.historyFetchedAt).toBe('2026-08-01 10:00:00');
    expect(f.row.historyErrorCode).toBe('ER_LOCK_DEADLOCK');
    f.failSave = false;
    expect(await syncBookingHistory('b1', 'test')).toBe(true);
    expect(f.entries.size).toBe(1);
    expect(f.row.historyErrorCode).toBeNull();
  });
  it.each([
    { bookingId: 'other', history: [] }, { bookingId: 'b1', total: 1, history: [] },
    { bookingId: 'b1' }, { bookingId: 'b1', history: [item('x', '31/02/2026, 12:00', 'Nova')] },
  ])('não considera uma resposta incompleta/indevida como histórico vazio: %j', async response => {
    f.fetch.mockResolvedValue(response);
    expect(await syncBookingHistory('b1', 'test')).toBe(false);
    expect(f.row.historyFetchedAt).toBe('2026-08-01 10:00:00');
  });
  it('aceita uma lista vazia válida sem apagar os resumos anteriores', async () => {
    f.fetch.mockResolvedValue({ bookingId: 'b1', total: 0, history: [] });
    expect(await syncBookingHistory('b1', 'test')).toBe(true);
    expect(f.row.currentGarage).toBe('Anterior');
  });
  it('mantém pendente um parque sem chave e conta apenas tentativas realizadas', async () => {
    f.pending = [{ externalId: 'b1', parkName: 'Sem chave', city: 'Porto' }];
    expect(await syncBookingHistoryBatch(10)).toEqual({ scanned: 1, fetched: 0, errors: 0, noKey: 1 });
    expect(f.row.historyFetchedAt).toBe('2026-08-01 10:00:00');
    expect(f.row.historyErrorCode).toBe('PARK_ACCESS_MISSING');
    expect(await syncBookingHistoryBatch(10, Date.now() - 1)).toEqual({ scanned: 0, fetched: 0, errors: 0, noKey: 0 });
  });
});
