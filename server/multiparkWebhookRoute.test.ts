import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
const receive = vi.hoisted(() => vi.fn());
const afterReceive = vi.fn();
vi.mock('./bookingDeliveryQueue', async (original) => ({
  ...await original<object>(), createDeliveryStore: vi.fn(async () => ({ receive })),
}));
import { createMultiparkWebhookRouter } from './multiparkWebhook';

let server: Server;
let url: string;
beforeEach(async () => {
  vi.stubEnv('MULTIPARK_WEBHOOK_SECRET', 'unit-test-only');
  receive.mockReset().mockResolvedValue(undefined);
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
