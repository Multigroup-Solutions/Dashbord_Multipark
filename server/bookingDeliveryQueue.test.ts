import { describe, expect, it, vi } from 'vitest';
import { drainDeliveries, retryDelaySeconds, type DeliveryJob, type DeliveryStore } from './bookingDeliveryQueue';
import { parseMultiparkWebhook } from './multiparkWebhook';

const event = parseMultiparkWebhook({ id: 'delivery-1', event: 'BOOKING_UPDATED', data: { id: 'booking-1' } })!;

function storeFixture() {
  let pending: DeliveryJob | null = { event, token: 'lease-1', attempts: 1 };
  let finished = false;
  const store: DeliveryStore = {
    receive: vi.fn(async () => {}),
    claim: vi.fn(async () => { const next = pending; pending = null; return next; }),
    complete: vi.fn(async () => { finished = true; return true; }),
    retry: vi.fn(async () => {}),
  };
  return { store, finished: () => finished, retryLater: () => { pending = { event, token: 'lease-2', attempts: 2 }; } };
}

describe('fila de notificações', () => {
  it('só conclui depois de a reserva ficar atualizada', async () => {
    const f = storeFixture();
    const process = vi.fn(async () => { expect(f.finished()).toBe(false); return { ok: true, detail: 'ok' }; });
    expect(await drainDeliveries(f.store, process)).toEqual({ completed: 1, failed: 0, lostLease: 0 });
    expect(f.store.retry).not.toHaveBeenCalled();
  });
  it('não marca falha como duplicado e aceita a recuperação posterior', async () => {
    const f = storeFixture();
    const process = vi.fn().mockRejectedValueOnce(new Error('HTTP com informação privada')).mockResolvedValueOnce({ ok: true, detail: 'ok' });
    expect((await drainDeliveries(f.store, process)).failed).toBe(1);
    expect(f.store.complete).not.toHaveBeenCalled();
    expect(f.store.retry).toHaveBeenCalledWith(expect.anything(), 'PROCESSING_FAILED', 30);
    f.retryLater();
    expect((await drainDeliveries(f.store, process)).completed).toBe(1);
  });
  it('um detalhe incompleto permanece pendente, mesmo sem exceção HTTP', async () => {
    const f = storeFixture();
    await drainDeliveries(f.store, async () => ({ ok: false, detail: 'chave em falta' }));
    expect(f.store.retry).toHaveBeenCalledWith(expect.anything(), 'DETAIL_INCOMPLETE', 30);
    expect(f.store.complete).not.toHaveBeenCalled();
  });
  it('não conta como concluído um trabalho cuja lease pertence a outro processo', async () => {
    const f = storeFixture();
    vi.mocked(f.store.complete).mockResolvedValue(false);
    expect((await drainDeliveries(f.store, async () => ({ ok: true, detail: 'ok' }))).lostLease).toBe(1);
  });
  it('deixa trabalhos para o ciclo seguinte quando não há tempo', async () => {
    const f = storeFixture();
    await drainDeliveries(f.store, vi.fn(), { deadlineAt: Date.now() - 1 });
    expect(f.store.claim).not.toHaveBeenCalled();
    expect(retryDelaySeconds(999)).toBe(3600);
  });
});
