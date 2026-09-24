import { beforeEach, describe, expect, it, vi } from 'vitest';
const fakes = vi.hoisted(() => ({ report: vi.fn(), upsert: vi.fn(), log: vi.fn(), busy: false }));
vi.mock('../multipark', () => ({
  getBookingsReport: fakes.report, getBooking: vi.fn(), getBookingHistory: vi.fn(), getAgentHistory: vi.fn(),
  isMultiparkConfigured: () => true, getParkApiKey: () => 'unit-test-key', matchParkConfig: vi.fn(), PARK_CONFIGS: [],
  getConfiguredParks: () => [
    { id: 'TEST_PORTO', name: 'Parque teste', city: 'Porto', envKey: 'UNIT_TEST' },
    { id: 'TEST_FARO', name: 'Outro teste', city: 'Faro', envKey: 'UNIT_TEST_2' },
  ],
}));
vi.mock('../db', () => ({
  upsertMultiparkBooking: fakes.upsert, upsertBookingExtras: vi.fn(), createSyncLog: fakes.log,
  getProjects: async () => [], getLastSyncSuccessAt: async () => null,
  getDb: async () => ({ select: () => ({ from: () => ({ leftJoin: async () => [] }) }) }),
}));
vi.mock('../syncLock', () => ({
  withSyncLock: async (_owner: string, fn: () => Promise<unknown>) => (fakes.busy ? { busy: true } : { busy: false, value: await fn() }),
}));
import { chunkNeedsRetry, runFutureCronSync, runRepairSync, syncBookings } from './multiparkBookingSync';

beforeEach(() => { fakes.report.mockReset(); fakes.upsert.mockReset(); fakes.log.mockReset(); fakes.busy = false; });

describe('recuperação e contagem da sincronização', () => {
  it('uma criação não é subtraída às atualizações', async () => {
    fakes.report.mockResolvedValueOnce({ bookings: [{ id: 'one' }, { id: 'two' }] }).mockResolvedValue({ bookings: [] });
    fakes.upsert.mockResolvedValueOnce({ action: 'created' }).mockResolvedValueOnce({ action: 'updated' });
    const result = await syncBookings({ startDate: '2026-09-01', endDate: '2026-09-10', actionTypes: ['creation'] });
    expect(result).toMatchObject({ processed: 2, created: 1, updated: 1, success: true, partial: false });
    expect(fakes.log).toHaveBeenCalledWith(expect.objectContaining({ recordsCreated: 1, recordsUpdated: 1, syncType: 'manual' }));
  });
  it('não avança a janela futura quando uma ação falha', async () => {
    fakes.report.mockRejectedValueOnce(new Error('origem indisponível')).mockResolvedValue({ bookings: [] });
    const failed = await runFutureCronSync(1, { offsetDays: 0 });
    expect(failed).toMatchObject({ done: false, nextOffset: 0, needsRetry: true, parkErrors: ['TEST_PORTO'] });
    expect(failed.report.errors).toHaveLength(1);
    const retry = await runFutureCronSync(1, { offsetDays: failed.nextOffset });
    expect(retry.done).toBe(true);
    expect(retry.report.errors).toHaveLength(0);
  });
  it('avança a janela futura quando só falham reservas individuais (não trava o marcador)', async () => {
    fakes.report.mockResolvedValue({ bookings: [{ id: 'bad' }, { id: 'ok' }] });
    fakes.upsert.mockRejectedValueOnce(new Error('data inválida')).mockResolvedValue({ action: 'updated' });
    const result = await runFutureCronSync(1, { offsetDays: 0 });
    expect(result.done).toBe(true);
    expect(result.nextOffset).toBeUndefined();
    expect(result.report.errors).toEqual([expect.stringMatching(/^Booking bad: /)]);
    expect(result.report.processed).toBeGreaterThan(0);
  });
  it('o sync futuro grava api_sync_future (não encolhe a janela do recente)', async () => {
    fakes.report.mockResolvedValue({ bookings: [] });
    await runFutureCronSync(1, { offsetDays: 0 });
    expect(fakes.log).toHaveBeenCalledWith(expect.objectContaining({ syncType: 'api_sync_future' }));
    expect(fakes.log).not.toHaveBeenCalledWith(expect.objectContaining({ syncType: 'api_sync' }));
  });
  it('chunkNeedsRetry distingue falha do report de erro por reserva', () => {
    expect(chunkNeedsRetry([])).toBe(false);
    expect(chunkNeedsRetry(['Booking abc: data inválida'])).toBe(false);
    expect(chunkNeedsRetry(['Parque teste Porto/checkin: origem indisponível'])).toBe(true);
    expect(chunkNeedsRetry(['Booking abc: x', 'global/checkout: 429'])).toBe(true);
  });
  it('estado por parque: um parque partido não afeta o outro', async () => {
    fakes.report.mockImplementation(async (_s: string, _e: string, _a: string) => ({ bookings: [] }));
    fakes.report.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 502 }));
    const r = await syncBookings({ startDate: '2026-09-01', endDate: '2026-09-02', actionTypes: ['creation'], syncType: 'api_sync_recent' });
    expect(r.parkStatus.TEST_PORTO).toEqual({ state: 'error', errorCode: 'API_HTTP_502' });
    expect(r.parkStatus.TEST_FARO).toEqual({ state: 'ok' });
    expect(r.parkErrors).toEqual(['TEST_PORTO']);
  });
  it('usa o início de cada parque e regista a janela', async () => {
    fakes.report.mockResolvedValue({ bookings: [] });
    await syncBookings({ startDate: '2026-09-01', endDate: '2026-09-04', actionTypes: ['creation'],
      parkStartDates: { TEST_FARO: '2026-09-03' }, syncType: 'api_sync_recent', windowStart: '2026-09-01 10:00:00', windowEnd: '2026-09-04 10:00:00' });
    const starts = fakes.report.mock.calls.map((c) => c[0]).sort();
    expect(starts).toEqual(['2026-09-01', '2026-09-03']);
    expect(fakes.log).toHaveBeenCalledWith(expect.objectContaining({ windowStart: '2026-09-01 10:00:00', windowEnd: '2026-09-04 10:00:00', syncType: 'api_sync_recent' }));
  });
  it('com o prazo esgotado não pega em trabalhos novos e fica parcial', async () => {
    fakes.report.mockResolvedValue({ bookings: [] });
    const r = await syncBookings({ startDate: '2026-09-01', endDate: '2026-09-02', deadlineAt: Date.now() - 1 });
    expect(fakes.report).not.toHaveBeenCalled();
    expect(r).toMatchObject({ partial: true, success: false, skippedJobs: 8, parkErrors: [] });
    expect(r.parkStatus.TEST_PORTO.state).toBe('incomplete');
    expect(fakes.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'partial' }));
  });
  it('regista total ≠ lista do report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakes.report.mockResolvedValueOnce({ total: 3, bookings: [{ id: 'a' }] }).mockResolvedValue({ bookings: [] });
    fakes.upsert.mockResolvedValue({ action: 'updated' });
    const r = await syncBookings({ startDate: '2026-09-01', endDate: '2026-09-01', actionTypes: ['creation'] });
    expect(r.totalMismatches).toEqual([{ parkId: 'TEST_PORTO', actionType: 'creation', total: 3, length: 1 }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('o trinco ocupado devolve busy sem chamar a API', async () => {
    fakes.busy = true;
    expect(await runRepairSync({ startDate: '2026-09-01', endDate: '2026-09-01' })).toEqual({ busy: true });
    expect((await runFutureCronSync(1)).busy).toBe(true);
    expect(fakes.report).not.toHaveBeenCalled();
  });
});
