import { describe, expect, it, vi } from 'vitest';
import { deliveryDisposition, deliveryErrorCode, drainDeliveries, MAX_DELIVERY_ATTEMPTS, retryDelaySeconds, type DeliveryJob, type DeliveryStore } from './bookingDeliveryQueue';
import { parseMultiparkWebhook } from './multiparkWebhook';

const event = parseMultiparkWebhook({ id: 'delivery-1', event: 'BOOKING_UPDATED', data: { id: 'booking-1' } })!;

function storeFixture(attempts = 1) {
  let pending: DeliveryJob | null = { event, token: 'lease-1', attempts };
  let finished = false;
  const store: DeliveryStore = {
    receive: vi.fn(async () => {}),
    claim: vi.fn(async () => { const next = pending; pending = null; return next; }),
    complete: vi.fn(async () => { finished = true; return true; }),
    retry: vi.fn(async () => {}),
    dead: vi.fn(async () => {}),
  };
  return { store, finished: () => finished, retryLater: () => { pending = { event, token: 'lease-2', attempts: 2 }; } };
}

describe('fila de notificações', () => {
  it('distingue uma reserva ausente de erro de base de dados sem expor mensagens', () => {
    expect(deliveryErrorCode({ status: 404, message: 'dados privados' })).toBe('API_HTTP_404');
    expect(deliveryErrorCode({ cause: { code: 'ER_LOCK_DEADLOCK' } })).toBe('ER_LOCK_DEADLOCK');
  });
  it('só conclui depois de a reserva ficar atualizada', async () => {
    const f = storeFixture();
    const process = vi.fn(async () => { expect(f.finished()).toBe(false); return { ok: true, detail: 'ok' }; });
    expect(await drainDeliveries(f.store, process)).toEqual({ completed: 1, failed: 0, lostLease: 0, dead: 0 });
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
  it('dead-letter: parque sem acesso vai logo para dead; os outros ao fim de 10 tentativas', async () => {
    const f = storeFixture();
    const r = await drainDeliveries(f.store, async () => { throw Object.assign(new Error('x'), { code: 'PARK_ACCESS_MISSING' }); });
    expect(r).toMatchObject({ dead: 1, failed: 0 });
    expect(f.store.dead).toHaveBeenCalledWith(expect.anything(), 'PARK_ACCESS_MISSING');
    expect(f.store.retry).not.toHaveBeenCalled();

    const last = storeFixture(MAX_DELIVERY_ATTEMPTS);
    expect((await drainDeliveries(last.store, async () => { throw new Error('x'); })).dead).toBe(1);
    const early = storeFixture(MAX_DELIVERY_ATTEMPTS - 1);
    expect((await drainDeliveries(early.store, async () => { throw new Error('x'); })).failed).toBe(1);
  });
  it('regras do dead-letter', () => {
    expect(deliveryDisposition(1, 'PARK_NOT_MAPPED')).toBe('dead');
    expect(deliveryDisposition(1, 'PARK_ACCESS_MISSING')).toBe('dead');
    expect(deliveryDisposition(9, 'TIMEOUT')).toBe('retry');
    expect(deliveryDisposition(10, 'TIMEOUT')).toBe('dead');
    expect(deliveryDisposition(25, 'DETAIL_INCOMPLETE')).toBe('dead');
  });
  it('códigos de erro: nome, causa, errno/sqlState e timeout, nunca a mensagem', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(deliveryErrorCode(timeout)).toBe('TIMEOUT');
    expect(deliveryErrorCode(Object.assign(new Error('fetch failed'), { cause: timeout }))).toBe('TIMEOUT');
    expect(deliveryErrorCode(new TypeError('fetch failed: joao@exemplo.pt'))).toBe('TYPE_ERROR');
    expect(deliveryErrorCode(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe('ECONNRESET');
    expect(deliveryErrorCode({ cause: { errno: 1213 } })).toBe('ERRNO_1213');
    expect(deliveryErrorCode({ sqlState: '40001' })).toBe('SQLSTATE_40001');
    expect(deliveryErrorCode({ code: 'minúsculas com espaços' })).toBe('PROCESSING_FAILED');
    expect(deliveryErrorCode(null)).toBe('PROCESSING_FAILED');
    expect(deliveryErrorCode(new Error('Reserva 123 de Maria'))).toBe('PROCESSING_FAILED');
    expect(deliveryErrorCode({ name: 'DrizzleQueryError', cause: { code: 'ER_LOCK_DEADLOCK', errno: 1213 } })).toBe('ER_LOCK_DEADLOCK');
    const bad = deliveryErrorCode(Object.assign(new RangeError('valor 999 inválido')));
    expect(bad).toBe('RANGE_ERROR');
  });
});
