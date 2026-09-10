import { beforeEach, describe, expect, it, vi } from 'vitest';
const fakes = vi.hoisted(() => ({ report: vi.fn(), upsert: vi.fn(), log: vi.fn() }));
vi.mock('../multipark', () => ({
  getBookingsReport: fakes.report, getBooking: vi.fn(), getBookingHistory: vi.fn(), getAgentHistory: vi.fn(),
  isMultiparkConfigured: () => true, getParkApiKey: () => 'unit-test-key', matchParkConfig: vi.fn(),
  getConfiguredParks: () => [{ id: 'TEST_PORTO', name: 'Parque teste', city: 'Porto', envKey: 'UNIT_TEST' }],
}));
vi.mock('../db', () => ({
  upsertMultiparkBooking: fakes.upsert, upsertBookingExtras: vi.fn(), createSyncLog: fakes.log,
  getProjects: async () => [], getLastSyncSuccessAt: async () => null,
  getDb: async () => ({ select: () => ({ from: () => ({ leftJoin: async () => [] }) }) }),
}));
import { runFutureCronSync, syncBookings } from './multiparkBookingSync';

beforeEach(() => { fakes.report.mockReset(); fakes.upsert.mockReset(); fakes.log.mockReset(); });

describe('recuperação e contagem da sincronização', () => {
  it('uma criação não é subtraída às atualizações', async () => {
    fakes.report.mockResolvedValue({ bookings: [{ id: 'one' }, { id: 'two' }] });
    fakes.upsert.mockResolvedValueOnce({ action: 'created' }).mockResolvedValueOnce({ action: 'updated' });
    const result = await syncBookings({ startDate: '2026-09-01', endDate: '2026-09-10', actionTypes: ['creation'] });
    expect(result).toMatchObject({ processed: 2, created: 1, updated: 1, success: true });
    expect(fakes.log).toHaveBeenCalledWith(expect.objectContaining({ recordsCreated: 1, recordsUpdated: 1 }));
  });
  it('não avança a janela futura quando uma ação falha', async () => {
    fakes.report.mockRejectedValueOnce(new Error('origem indisponível')).mockResolvedValue({ bookings: [] });
    const failed = await runFutureCronSync(1, { offsetDays: 0 });
    expect(failed).toMatchObject({ done: false, nextOffset: 0 });
    expect(failed.report.errors).toHaveLength(1);
    const retry = await runFutureCronSync(1, { offsetDays: failed.nextOffset });
    expect(retry.done).toBe(true);
    expect(retry.report.errors).toHaveLength(0);
  });
  it('a recuperação de um parque não marca a importação global como concluída', async () => {
    fakes.report.mockResolvedValue({ bookings: [] });
    await syncBookings({ startDate: '2026-09-01', endDate: '2026-09-10', parkIds: ['TEST_PORTO'] });
    expect(fakes.log).toHaveBeenCalledWith(expect.objectContaining({ syncType: 'api_sync_recovery' }));
    await expect(syncBookings({ startDate: '2026-09-01', endDate: '2026-09-10', parkIds: ['UNKNOWN'] })).rejects.toThrow();
  });
});
