import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
const receive = vi.hoisted(() => vi.fn());
const remember = vi.hoisted(() => vi.fn());
const afterReceive = vi.fn();
vi.mock('./webhookMemory', async (original) => ({ ...await original<object>(), recordWebhookSnapshot: remember }));
vi.mock('./bookingDeliveryQueue', async (original) => ({
  ...await original<object>(), createDeliveryStore: vi.fn(async () => ({ receive })),
}));
import { createMultiparkWebhookRouter } from './multiparkWebhook';

let server: Server;
let url: string;
beforeEach(async () => {
  vi.stubEnv('MULTIPARK_WEBHOOK_SECRET', 'unit-test-only');
  receive.mockReset().mockResolvedValue(undefined);
  remember.mockReset().mockResolvedValue('stored');
  afterReceive.mockReset();
  server = createServer(express().use('/hook', createMultiparkWebhookRouter({ afterReceive })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  vi.unstubAllEnvs();
});
const body = JSON.stringify({ id: 'd1', event: 'BOOKING_UPDATED', data: { id: 'b1' } });
const post = (authorized = true) => fetch(url, { method: 'POST', body,
  headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer unit-test-only' } : {}) } });

describe('confirmação durável do webhook HTTP', () => {
  it('responde 202 só depois de guardar; recebe o mesmo reenvio com o mesmo ID', async () => {
    let release!: () => void;
    receive.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    let replied = false;
    const request = post().then(r => { replied = true; return r; });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(replied).toBe(false);
    expect(afterReceive).not.toHaveBeenCalled();
    release();
    expect((await request).status).toBe(202);
    expect(afterReceive).toHaveBeenCalledOnce();
    expect((await post()).status).toBe(202);
    expect(receive.mock.calls[0][0].deliveryId).toBe(receive.mock.calls[1][0].deliveryId);
  });
  it('devolve erro recuperável se a persistência falhar', async () => {
    receive.mockRejectedValueOnce(new Error('offline'));
    expect((await post()).status).toBe(500);
    expect(afterReceive).not.toHaveBeenCalled();
    expect((await post()).status).toBe(202);
  });
  it('não aceita notificações sem autenticação', async () => {
    expect((await post(false)).status).toBe(401);
    expect(receive).not.toHaveBeenCalled();
    expect(afterReceive).not.toHaveBeenCalled();
  });
  it('mantém a confirmação durável se o processamento imediato não arrancar', async () => {
    afterReceive.mockImplementationOnce(() => { throw new Error('runtime unavailable'); });
    expect((await post()).status).toBe(202);
    expect(receive).toHaveBeenCalledOnce();
  });
});

describe('memória do webhook (só acréscimo) antes de tudo', () => {
  it('guarda o payload antes da fila, com o corpo original', async () => {
    const order: string[] = [];
    remember.mockImplementation(async () => { order.push('memória'); return 'stored'; });
    receive.mockImplementation(async () => { order.push('fila'); });
    expect((await post()).status).toBe(202);
    expect(order).toEqual(['memória', 'fila']);
    expect(remember.mock.calls[0][0]).toMatchObject({ id: 'd1', data: { id: 'b1' } });
    expect(remember.mock.calls[0][1]).toMatchObject({ signatureValid: false });
    expect(Buffer.isBuffer(remember.mock.calls[0][1].rawBody)).toBe(true);
  });
  it('fica guardado mesmo que a fila falhe depois', async () => {
    receive.mockRejectedValueOnce(new Error('offline'));
    expect((await post()).status).toBe(500);
    expect(remember).toHaveBeenCalledOnce();
  });
  it('se não conseguir guardar a memória: 500 (a Multipark repete) e não segue para a fila', async () => {
    remember.mockRejectedValueOnce(new Error('db down'));
    expect((await post()).status).toBe(500);
    expect(receive).not.toHaveBeenCalled();
    expect(afterReceive).not.toHaveBeenCalled();
  });
  it('eventos desconhecidos também ficam na memória (a fila ignora-os)', async () => {
    const r = await fetch(url, { method: 'POST', body: JSON.stringify({ id: 'd2', event: 'BOOKING_PAID', data: { id: 'b1' } }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer unit-test-only' } });
    expect(r.status).toBe(200);
    expect(remember).toHaveBeenCalledOnce();
    expect(receive).not.toHaveBeenCalled();
  });
  it('sem autenticação não guarda nada', async () => {
    expect((await post(false)).status).toBe(401);
    expect(remember).not.toHaveBeenCalled();
  });
});
