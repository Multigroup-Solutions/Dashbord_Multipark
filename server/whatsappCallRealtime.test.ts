import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CALL_STREAM_MAX_MS, CALL_STREAM_PATH, diffRinging, formatSseEvent, ringPollIntervalMs, ringingIds,
} from "../shared/whatsappCallSignal";
import {
  base64UrlToBytes, buildCallPushPayload, isGonePushStatus, pickPushDeliveries, pushSubscriptionError, vapidConfigFrom,
} from "../shared/webPush";

const root = resolve(__dirname, "..");
const src = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("stream do toque: diferença entre leituras", () => {
  it("só as chamadas a tocar contam", () => {
    const ids = ringingIds([{ id: 1, status: "ringing" }, { id: 2, status: "answering" }, { id: 3, status: "ringing" }, { id: 4, status: "rejected" }]);
    expect([...ids].sort()).toEqual([1, 3]);
  });

  it("nova chamada: ring; atendida/perdida/terminada: ring-cleared; sem mudança: nada", () => {
    expect(diffRinging(new Set(), new Set([5]))).toEqual([{ type: "ring", id: 5 }]);
    expect(diffRinging(new Set([5]), new Set())).toEqual([{ type: "ring-cleared", id: 5 }]);
    expect(diffRinging(new Set([5, 6]), new Set([5, 6]))).toEqual([]);
    expect(diffRinging(new Set([7, 5]), new Set([9, 5, 8]))).toEqual([
      { type: "ring", id: 8 }, { type: "ring", id: 9 }, { type: "ring-cleared", id: 7 },
    ]);
  });

  it("formato text/event-stream, só com o id (sem nome nem número)", () => {
    expect(formatSseEvent({ type: "ring", id: 42 })).toBe('event: ring\ndata: {"id":42}\n\n');
    expect(formatSseEvent({ type: "ring-cleared", id: 1 })).toBe('event: ring-cleared\ndata: {"id":1}\n\n');
  });

  it("polling fica como rede de segurança: 15 s com o stream, senão 3 s / 10 s", () => {
    expect(ringPollIntervalMs(true, true)).toBe(15_000);
    expect(ringPollIntervalMs(false, true)).toBe(15_000);
    expect(ringPollIntervalMs(true, false)).toBe(3_000);
    expect(ringPollIntervalMs(false, false)).toBe(10_000);
  });

  it("o stream fecha antes do maxDuration da função do Vercel", () => {
    const vercel = JSON.parse(src("vercel.json"));
    const maxDurationMs = vercel.functions["api/index.js"].maxDuration * 1000;
    expect(CALL_STREAM_MAX_MS).toBeLessThanOrEqual(maxDurationMs - 5_000);
  });

  it("rota montada nos dois entrypoints, com a mesma verificação do incoming", () => {
    for (const f of ["server/_core/index.ts", "server/_core/api-entry.ts"]) expect(src(f)).toContain("registerWhatsappCallStreamRoute(app)");
    const stream = src("server/whatsappCallStream.ts");
    expect(stream).toContain("streamScope: protectedProcedure");
    expect(stream).toContain('requireAccess(ctx.user, "whatsapp", "edit")');
    expect(stream).toContain("no-transform");
    expect(CALL_STREAM_PATH).toBe("/api/whatsapp/calls/stream");
  });
});

describe("web push: configuração e subscrições", () => {
  it("VAPID: as três envs, subject mailto:/https:, senão desligado", () => {
    expect(vapidConfigFrom({})).toBeNull();
    expect(vapidConfigFrom({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" })).toBeNull();
    expect(vapidConfigFrom({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", VAPID_SUBJECT: "geral" })).toBeNull();
    expect(vapidConfigFrom({ VAPID_PUBLIC_KEY: " a ", VAPID_PRIVATE_KEY: "b", VAPID_SUBJECT: "mailto:x@y.pt" })).toEqual({ publicKey: "a", privateKey: "b", subject: "mailto:x@y.pt" });
    expect(vapidConfigFrom({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", VAPID_SUBJECT: "https://dashboard.multipark.pt" })).not.toBeNull();
  });

  it("404/410 do serviço de push apagam a subscrição; o resto é temporário", () => {
    expect(isGonePushStatus(404)).toBe(true);
    expect(isGonePushStatus(410)).toBe(true);
    for (const c of [400, 401, 403, 413, 429, 500, 503, null, undefined]) expect(isGonePushStatus(c as any)).toBe(false);
  });

  it("subscrição do browser: endpoint https e chaves base64url", () => {
    const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
    expect(pushSubscriptionError({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys })).toBeNull();
    expect(pushSubscriptionError({ endpoint: "http://fcm.googleapis.com/x", keys })).toMatch(/inválido/);
    expect(pushSubscriptionError({ endpoint: "isto nao e url", keys })).toMatch(/inválido/);
    expect(pushSubscriptionError({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: "a b", auth: "c" } })).toMatch(/Chaves/);
  });

  it("base64url para bytes (chave pública VAPID)", () => {
    expect(Array.from(base64UrlToBytes("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(base64UrlToBytes("-_8"))).toEqual([251, 255]);
  });
});

describe("web push: quem recebe e o que diz", () => {
  const subs = [
    { id: 3, userId: 10 }, { id: 1, userId: 10 }, { id: 2, userId: 11 }, { id: 4, userId: 12 },
  ];

  it("só as subscrições de quem vê a chamada no toque (todas as dessa pessoa)", () => {
    expect(pickPushDeliveries(subs, new Set([10])).map((s) => s.id)).toEqual([1, 3]);
    expect(pickPushDeliveries(subs, new Set([11, 12])).map((s) => s.id)).toEqual([2, 4]);
    expect(pickPushDeliveries(subs, new Set())).toEqual([]);
    expect(pickPushDeliveries([...subs, { id: 1, userId: 10 }], new Set([10])).map((s) => s.id)).toEqual([1, 3]);
  });

  it("título com o nome; sem nome: número mascarado; link para a conversa", () => {
    const named = buildCallPushPayload({ callId: 7, name: "Ana Silva", phoneE164: "+351912345678", conversationId: 55 });
    expect(named).toEqual({ title: "Chamada WhatsApp de Ana Silva", body: "Abre o dashboard para atender.", url: "/whatsapp?c=55", tag: "wa-call-7" });
    const bare = buildCallPushPayload({ callId: 8, name: null, phoneE164: "+351912345678", conversationId: null });
    expect(bare.title).toBe("Chamada WhatsApp de +*********678");
    expect(bare.url).toBe("/whatsapp");
    // O "nome" que é só o número (conversa sem ficha nem perfil) também é mascarado.
    expect(buildCallPushPayload({ callId: 9, name: "+351 912 345 678", phoneE164: "+351912345678", conversationId: 1 }).title).not.toContain("345");
  });

  it("sem travessões nem emojis no texto do produto", () => {
    const p = buildCallPushPayload({ callId: 1, name: "Rui", phoneE164: "+351900000000", conversationId: 1 });
    for (const t of [p.title, p.body]) expect(t).not.toMatch(/[—–]|\p{Extended_Pictographic}/u);
  });

  it("push só DEPOIS do 200 do webhook, fora do caminho da resposta", () => {
    const hook = src("server/whatsappWebhook.ts");
    const ack = hook.indexOf("res.sendStatus(200);");
    const push = hook.indexOf('import("./webPush")');
    expect(ack).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(ack);
  });

  it("service worker só de push (não interceta pedidos)", () => {
    const sw = src("client/public/sw.js");
    expect(sw).toContain('addEventListener("push"');
    expect(sw).toContain('addEventListener("notificationclick"');
    expect(sw).not.toContain('addEventListener("fetch"');
  });
});

describe("migração 0330", () => {
  it("registada em server/migrations (por ordem), idempotente e espelhada no schema drizzle", async () => {
    const { SCHEMA_MIGRATION_IDS } = await import("./migrations/index");
    expect(SCHEMA_MIGRATION_IDS).toContain("0330");
    expect([...SCHEMA_MIGRATION_IDS].sort()).toEqual([...SCHEMA_MIGRATION_IDS]);
    const { MIGRATION_0330_STATEMENTS } = await import("./migrations/migration_0330");
    for (const st of MIGRATION_0330_STATEMENTS) expect(st).toMatch(/^CREATE TABLE IF NOT EXISTS/);
    expect(MIGRATION_0330_STATEMENTS.join("\n")).toContain("UNIQUE KEY `uq_web_push_endpoint` (`endpointHash`)");
    expect(src("drizzle/schema.ts")).toContain('mysqlTable("web_push_subscriptions"');
  });
});
