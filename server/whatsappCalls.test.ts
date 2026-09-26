import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyCallEvents, callBlockedReason, callState, claimCall, hangupCall, notePermissionRequested, parseCallWebhook, permissionInfo,
  rejectCall, releaseCall, answerCall, staleOutcome, startCall, sweepStaleCalls,
  type CallApi, type CallDeps, type CallRepo, type CallRow, type NewCallRow,
} from "./whatsappCalls";
import {
  buildCallActionPayload, buildCallingSettingsPayload, buildConnectPayload, buildPermissionRequestPayload, buildPermissionTemplatePayload,
  graphPhoneRequest, parseCallPermissionsResponse, summarizeCallingSettings,
} from "./whatsappCallsApi";
import { callsFieldInSubscriptions, describeCallingDiagnosis } from "./whatsappCallsDiagnostics";
import { hasCallContent } from "./whatsappWebhook";
import { messageBody, parseWebhookPayload } from "./whatsappInbound";
import { callScopeSql, groupPendingCallbacks } from "./whatsappCallsQueries";
import { visibilitySql } from "./whatsappInbox";
import {
  RING_TIMEOUT_MS, appendRequestTime, callTimelineLabel, canRequestPermission, describeCallError, effectivePermission, formatCallDuration,
  formatCallTimer, isRingingExpired, permissionFromReply, statusAfterMetaStatus, statusAfterTerminate, toDbUtc,
} from "../shared/whatsappCalls";
import { kindDef, resolveRecipients, type RoutingCandidate } from "../shared/notificationRouting";
import { can } from "../shared/access";

const root = resolve(__dirname, "..");
const T0 = Date.UTC(2026, 8, 26, 14, 32, 0); // 26 set 2026 14:32 UTC
const tsSec = (ms: number) => String(Math.floor(ms / 1000));

// ─── Payloads da Meta (docs, set 2026) ──────────────────────────────────────

function envelope(value: any, field = "calls") {
  return { object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PNID", display_phone_number: "351210000000" }, ...value } }] }] };
}
const SDP_OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
const connectIn = (callId = "wacid.IN1", at = T0) => envelope({
  contacts: [{ profile: { name: "Maria Silva" }, wa_id: "351912345678" }],
  calls: [{ id: callId, to: "351210000000", from: "351912345678", event: "connect", timestamp: tsSec(at), direction: "USER_INITIATED", session: { sdp_type: "offer", sdp: SDP_OFFER } }],
});
const terminateIn = (callId = "wacid.IN1", status = "COMPLETED", duration?: number, at = T0 + 30_000) => envelope({
  calls: [{ id: callId, to: "351210000000", from: "351912345678", event: "terminate", direction: "USER_INITIATED", timestamp: tsSec(at), status, ...(duration != null ? { duration } : {}) }],
});
const connectOut = (callId = "wacid.OUT1") => envelope({
  contacts: [{ profile: { name: "Maria" }, wa_id: "351912345678" }],
  calls: [{ id: callId, to: "351912345678", from: "351210000000", event: "connect", timestamp: tsSec(T0), direction: "BUSINESS_INITIATED", session: { sdp_type: "answer", sdp: "v=0 answer" } }],
});
const statusOut = (callId: string, status: string) => envelope({
  statuses: [{ id: callId, timestamp: tsSec(T0 + 5_000), type: "call", status, recipient_id: "351912345678" }],
});
const permissionReply = (response: "accept" | "reject", extra: Record<string, unknown> = {}) => envelope({
  contacts: [{ profile: { name: "Maria" }, wa_id: "351912345678" }],
  messages: [{
    from: "351912345678", id: "wamid.PERM1", timestamp: tsSec(T0), type: "interactive",
    context: { from: "351210000000", id: "wamid.REQ" },
    interactive: { type: "call_permission_reply", call_permission_reply: { response, is_permanent: false, expiration_timestamp: tsSec(T0 + 7 * 86_400_000), response_source: "user_action", ...extra } },
  }],
}, "messages");

// ─── Repositório falso (mesma semântica do real: callId único, UPDATE condicional) ──

function fakeRepo(opts: { names?: Record<number, string> } = {}) {
  const calls: CallRow[] = [];
  const perms = new Map<string, any>();
  let nextId = 1;
  const callbacksDone: string[] = [];
  const noticed = new Set<number>();
  const touched: any[] = [];
  const repo: CallRepo & { calls: CallRow[]; perms: Map<string, any>; callbacksDone: string[]; touched: any[] } = {
    calls, perms, callbacksDone, touched,
    async ensureConversation(phone) { return { conversationId: phone === "+351912345678" ? 10 : 11, projectId: 3 }; },
    async insertCall(row: NewCallRow) {
      if (calls.some((c) => c.callId === row.callId)) return false;
      calls.push({ id: nextId++, conversationId: null, sdpOffer: null, sdpAnswer: null, projectId: null, answeredAt: null, endedAt: null, durationSec: null, answeredByUserId: null, startedByUserId: null, missed: 0, callbackDoneAt: null, metaStatus: null, ...row } as CallRow);
      return true;
    },
    async upsertOutbound(row: NewCallRow) {
      const cur = calls.find((c) => c.callId === row.callId);
      if (!cur) { await repo.insertCall(row); return; }
      for (const k of ["conversationId", "projectId", "startedByUserId", "answeredByUserId", "sdpAnswer"] as const) if ((row as any)[k] != null) (cur as any)[k] = (row as any)[k];
    },
    async getByCallId(id) { const c = calls.find((x) => x.callId === id); return c ? { ...c } : null; },
    async getById(id) { const c = calls.find((x) => x.id === id); return c ? { ...c } : null; },
    async transition(id, from, set, o) {
      const c = calls.find((x) => x.id === id);
      if (!c || !from.includes(c.status)) return false;
      if (o?.startedAfter && !(c.startedAt > o.startedAfter)) return false;
      Object.assign(c, set);
      return true;
    },
    async markCallbacksDone(phone) { callbacksDone.push(phone); return 1; },
    async getPermission(phone) { return perms.get(phone) ?? null; },
    async savePermission(phone, patch) { perms.set(phone, { status: "none", expiresAt: null, isPermanent: 0, requestTimes: null, ...(perms.get(phone) ?? {}), ...patch }); },
    async userName(id) { return id ? opts.names?.[id] ?? `User ${id}` : null; },
    async countConnectedOutboundSince(phone, since) { return calls.filter((c) => c.phoneE164 === phone && c.direction === "out" && c.answeredAt && c.startedAt >= since).length; },
    async recentOutboundStatuses(phone, limit) { return calls.filter((c) => c.phoneE164 === phone && c.direction === "out").sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit).map((c) => c.status); },
    async hasLiveCall(phone) { return calls.some((c) => c.phoneE164 === phone && ["answering", "dialing", "connected"].includes(c.status)); },
    async listStale() { return calls.filter((c) => ["ringing", "answering", "dialing", "connected"].includes(c.status)).map((c) => ({ ...c })); },
    async claimMissedNotice(id) { if (noticed.has(id)) return false; noticed.add(id); return true; },
    async touchConversation(conversationId, patch) { touched.push({ conversationId, ...patch }); },
  };
  return repo;
}

function fakeApi(overrides: Partial<Record<string, { ok: boolean; error?: string; code?: number }>> = {}) {
  const log: Array<{ action: string; callId: string; sdp?: string | null }> = [];
  const api: CallApi & { log: typeof log } = {
    log,
    async callAction(action, callId, sdp) {
      log.push({ action, callId, sdp });
      const o = overrides[action];
      return o && !o.ok ? { ok: false, error: o.error ?? "erro", code: o.code } : { ok: true };
    },
    async connectCall(to, sdp) {
      log.push({ action: "connect", callId: to, sdp });
      const o = overrides.connect;
      return o && !o.ok ? { ok: false, error: o.error ?? "erro", code: o.code } : { ok: true, callId: "wacid.OUTNEW" };
    },
  };
  return api;
}

const depsWith = (repo: CallRepo, api: CallApi, now = T0 + 5_000): CallDeps => ({ repo, api, now: () => now });

// ─── Parse do webhook ───────────────────────────────────────────────────────

describe("parseCallWebhook", () => {
  it("connect recebido: id, direção, número, oferta SDP e nome", () => {
    const { events } = parseCallWebhook(connectIn(), "PNID");
    expect(events).toEqual([{ kind: "connect", callId: "wacid.IN1", direction: "in", phone: "351912345678", sdpType: "offer", sdp: SDP_OFFER, timestamp: toDbUtc(T0), profileName: "Maria Silva" }]);
  });
  it("connect de chamada nossa traz a resposta SDP e o cliente é o `to`", () => {
    const [e] = parseCallWebhook(connectOut(), "PNID").events;
    expect(e).toMatchObject({ kind: "connect", direction: "out", phone: "351912345678", sdpType: "answer", sdp: "v=0 answer" });
  });
  it("terminate: estado e duração (duration ou end-start)", () => {
    expect(parseCallWebhook(terminateIn("wacid.IN1", "COMPLETED", 180), "PNID").events[0]).toMatchObject({ kind: "terminate", status: "COMPLETED", durationSec: 180, direction: "in" });
    const p = envelope({ calls: [{ id: "x", from: "351912345678", event: "terminate", direction: "USER_INITIATED", start_time: "100", end_time: "220", status: "COMPLETED" }] });
    expect(parseCallWebhook(p, "PNID").events[0]).toMatchObject({ durationSec: 120 });
  });
  it("status de chamada (type=call) — os status de mensagens ficam de fora", () => {
    const p = envelope({ statuses: [
      { id: "wacid.OUT1", type: "call", status: "RINGING", recipient_id: "351912345678", timestamp: tsSec(T0) },
      { id: "wamid.MSG", status: "delivered", recipient_id: "351912345678", timestamp: tsSec(T0) },
    ] });
    const { events } = parseCallWebhook(p, "PNID");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "status", callId: "wacid.OUT1", status: "RINGING" });
  });
  it("resposta ao pedido de autorização", () => {
    const [e] = parseCallWebhook(permissionReply("accept"), "PNID").events;
    expect(e).toMatchObject({ kind: "permission_reply", phone: "351912345678", response: "accept", isPermanent: false, expirationTimestamp: Math.floor((T0 + 7 * 86_400_000) / 1000), source: "user_action" });
  });
  it("outro phone_number_id é ignorado", () => {
    const r = parseCallWebhook(connectIn(), "OUTRO");
    expect(r.events).toHaveLength(0);
    expect(r.ignored).toBe(1);
  });
  it("hasCallContent só é verdadeiro com chamadas / status de chamada / resposta de autorização", () => {
    expect(hasCallContent(connectIn())).toBe(true);
    expect(hasCallContent(statusOut("wacid.X", "RINGING"))).toBe(true);
    expect(hasCallContent(permissionReply("accept"))).toBe(true);
    expect(hasCallContent(envelope({ messages: [{ id: "m", from: "1", type: "text", text: { body: "olá" } }] }, "messages"))).toBe(false);
  });
  it("o parser das mensagens ignora status de chamada e mostra a resposta de autorização em texto", () => {
    expect(parseWebhookPayload(statusOut("wacid.X", "RINGING"), "PNID").statuses).toHaveLength(0);
    const m = permissionReply("accept").entry[0].changes[0].value.messages[0];
    expect(messageBody(m)).toBe("[Autorizou chamadas durante 7 dias]");
    expect(messageBody({ ...m, interactive: { type: "call_permission_reply", call_permission_reply: { response: "reject" } } })).toBe("[Não autorizou chamadas]");
  });
});

// ─── Aplicar eventos ────────────────────────────────────────────────────────

describe("applyCallEvents", () => {
  it("connect recebido → a tocar, com a conversa e a cidade; retry da Meta não duplica", async () => {
    const repo = fakeRepo();
    const deps = depsWith(repo, fakeApi());
    const r1 = await applyCallEvents(parseCallWebhook(connectIn(), "PNID").events, deps);
    const r2 = await applyCallEvents(parseCallWebhook(connectIn(), "PNID").events, deps);
    expect(r1.connects).toBe(1);
    expect(r2.deduped).toBe(1);
    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0]).toMatchObject({ status: "ringing", direction: "in", phoneE164: "+351912345678", conversationId: 10, projectId: 3, sdpOffer: SDP_OFFER });
  });

  it("terminate sem ninguém atender → perdida (missed) + aviso; oferta SDP apagada", async () => {
    const repo = fakeRepo();
    const deps = depsWith(repo, fakeApi());
    await applyCallEvents(parseCallWebhook(connectIn(), "PNID").events, deps);
    const r = await applyCallEvents(parseCallWebhook(terminateIn("wacid.IN1", "FAILED"), "PNID").events, deps);
    expect(r.missed).toEqual([1]);
    expect(repo.calls[0]).toMatchObject({ status: "missed", missed: 1, sdpOffer: null });
    // A chamada abre a janela de 24 h (regra da Meta); a perdida fica por ler/responder.
    expect(repo.touched).toEqual([
      { conversationId: 10, at: toDbUtc(T0), preview: "📞 Chamada recebida", inbound: true },
      { conversationId: 10, at: toDbUtc(T0 + 30_000), preview: "📞 Chamada perdida", inbound: false, needsAttention: true },
    ]);
    // Retry do terminate: nada muda, nada repete.
    const again = await applyCallEvents(parseCallWebhook(terminateIn("wacid.IN1", "FAILED"), "PNID").events, deps);
    expect(again.missed).toEqual([]);
  });

  it("terminate de chamada atendida → terminada com a duração", async () => {
    const repo = fakeRepo();
    const deps = depsWith(repo, fakeApi());
    await applyCallEvents(parseCallWebhook(connectIn(), "PNID").events, deps);
    repo.calls[0].status = "connected";
    repo.calls[0].answeredAt = toDbUtc(T0 + 5_000);
    await applyCallEvents(parseCallWebhook(terminateIn("wacid.IN1", "COMPLETED", 175), "PNID").events, deps);
    expect(repo.calls[0]).toMatchObject({ status: "ended", durationSec: 175, missed: 0 });
  });

  it("terminate sem connect visto (webhook perdido) regista a chamada como perdida", async () => {
    const repo = fakeRepo();
    const r = await applyCallEvents(parseCallWebhook(terminateIn("wacid.LOST"), "PNID").events, depsWith(repo, fakeApi()));
    expect(repo.calls[0]).toMatchObject({ callId: "wacid.LOST", status: "missed", conversationId: 10 });
    expect(r.missed).toHaveLength(1);
  });

  it("chamada nossa: resposta SDP antes da linha (upsert), RINGING → ACCEPTED → callbacks devolvidos", async () => {
    const repo = fakeRepo();
    const deps = depsWith(repo, fakeApi());
    await applyCallEvents(parseCallWebhook(connectOut("wacid.OUT1"), "PNID").events, deps);
    expect(repo.calls[0]).toMatchObject({ direction: "out", status: "dialing", sdpAnswer: "v=0 answer" });
    await repo.upsertOutbound({ callId: "wacid.OUT1", phoneE164: "+351912345678", direction: "out", status: "dialing", startedAt: toDbUtc(T0), startedByUserId: 7, conversationId: 10 });
    expect(repo.calls[0]).toMatchObject({ startedByUserId: 7, sdpAnswer: "v=0 answer", conversationId: 10 });
    await applyCallEvents(parseCallWebhook(statusOut("wacid.OUT1", "RINGING"), "PNID").events, deps);
    expect(repo.calls[0].status).toBe("ringing");
    await applyCallEvents(parseCallWebhook(statusOut("wacid.OUT1", "ACCEPTED"), "PNID").events, deps);
    expect(repo.calls[0].status).toBe("connected");
    expect(repo.calls[0].answeredAt).toBeTruthy();
    expect(repo.callbacksDone).toEqual(["+351912345678"]);
  });

  it("chamada nossa recusada / não atendida", async () => {
    const repo = fakeRepo();
    const deps = depsWith(repo, fakeApi());
    await applyCallEvents(parseCallWebhook(connectOut("wacid.A"), "PNID").events, deps);
    await applyCallEvents(parseCallWebhook(statusOut("wacid.A", "REJECTED"), "PNID").events, deps);
    expect(repo.calls[0]).toMatchObject({ status: "rejected", sdpAnswer: null });
    const out = envelope({ calls: [{ id: "wacid.B", to: "351912345678", event: "terminate", direction: "BUSINESS_INITIATED", status: "FAILED", timestamp: tsSec(T0) }] });
    await applyCallEvents(parseCallWebhook(connectOut("wacid.B"), "PNID").events, deps);
    const r = await applyCallEvents(parseCallWebhook(out, "PNID").events, deps);
    expect(repo.calls[1].status).toBe("failed");
    expect(r.missed).toEqual([]); // só recebidas vão para "por devolver"
  });

  it("autorização aceite (7 dias) / permanente / recusada", async () => {
    const repo = fakeRepo();
    const deps = depsWith(repo, fakeApi());
    await applyCallEvents(parseCallWebhook(permissionReply("accept"), "PNID").events, deps);
    expect(repo.perms.get("+351912345678")).toMatchObject({ status: "temporary", expiresAt: toDbUtc(Math.floor((T0 + 7 * 86_400_000) / 1000) * 1000), isPermanent: 0 });
    await applyCallEvents(parseCallWebhook(permissionReply("accept", { is_permanent: true }), "PNID").events, deps);
    expect(repo.perms.get("+351912345678")).toMatchObject({ status: "permanent", expiresAt: null, isPermanent: 1 });
    await applyCallEvents(parseCallWebhook(permissionReply("reject"), "PNID").events, deps);
    expect(repo.perms.get("+351912345678")).toMatchObject({ status: "rejected" });
  });
});

// ─── Atender: o primeiro ganha ──────────────────────────────────────────────

async function ringingRepo(at = T0) {
  const repo = fakeRepo({ names: { 1: "Ana", 2: "Bruno" } });
  await applyCallEvents(parseCallWebhook(connectIn("wacid.IN1", at), "PNID").events, depsWith(repo, fakeApi(), at));
  return repo;
}

describe("atender / recusar / desligar", () => {
  it("dois a carregar em Atender ao mesmo tempo: só um ganha, o outro vê 'atendida por'", async () => {
    const repo = await ringingRepo();
    const deps = depsWith(repo, fakeApi());
    const [a, b] = await Promise.all([claimCall(1, 1, deps), claimCall(1, 2, deps)]);
    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const loser = (a.ok ? b : a) as Extract<typeof a, { ok: false }>;
    expect(loser.reason).toBe("answered");
    expect(loser.message).toBe(`Chamada atendida por ${a.ok ? "Ana" : "Bruno"}.`);
    expect(repo.calls[0].status).toBe("answering");
    expect((winners[0] as any).sdpOffer).toBe(SDP_OFFER);
  });

  it("chamada a tocar há mais do que o prazo já não se atende", async () => {
    const repo = await ringingRepo();
    const r = await claimCall(1, 1, depsWith(repo, fakeApi(), T0 + RING_TIMEOUT_MS + 1_000));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toBe("expired");
  });

  it("atender: pre_accept e accept com a MESMA resposta SDP; ligada e oferta apagada", async () => {
    const repo = await ringingRepo();
    const api = fakeApi();
    const deps = depsWith(repo, api);
    await claimCall(1, 1, deps);
    expect(await answerCall(1, 2, "v=0 x", deps)).toEqual({ ok: false, error: "Esta chamada já não está contigo." });
    expect(await answerCall(1, 1, "v=0 answer-sdp", deps)).toEqual({ ok: true });
    expect(api.log.map((l) => l.action)).toEqual(["pre_accept", "accept"]);
    expect(api.log.every((l) => l.sdp === "v=0 answer-sdp" && l.callId === "wacid.IN1")).toBe(true);
    expect(repo.calls[0]).toMatchObject({ status: "connected", sdpOffer: null, answeredByUserId: 1 });
  });

  it("pre_accept recusado pela Meta → falhada + reject", async () => {
    const repo = await ringingRepo();
    const api = fakeApi({ pre_accept: { ok: false, error: "Chamada já não existe", code: 138002 } });
    const deps = depsWith(repo, api);
    await claimCall(1, 1, deps);
    const r = await answerCall(1, 1, "v=0", deps);
    expect(r.ok).toBe(false);
    expect(repo.calls[0].status).toBe("failed");
    expect(api.log.map((l) => l.action)).toEqual(["pre_accept", "reject"]);
  });

  it("microfone negado → a chamada volta a tocar para os outros", async () => {
    const repo = await ringingRepo();
    const deps = depsWith(repo, fakeApi());
    await claimCall(1, 1, deps);
    expect(await releaseCall(1, 2, deps)).toBe(false);
    expect(await releaseCall(1, 1, deps)).toBe(true);
    expect(repo.calls[0]).toMatchObject({ status: "ringing", answeredByUserId: null });
    expect((await claimCall(1, 2, deps)).ok).toBe(true);
  });

  it("recusar só enquanto toca; depois de atendida diz por quem", async () => {
    const repo = await ringingRepo();
    const api = fakeApi();
    const deps = depsWith(repo, api);
    await claimCall(1, 1, deps);
    expect(await rejectCall(1, 2, deps)).toEqual({ ok: false, error: "Chamada já atendida por Ana." });
    const repo2 = await ringingRepo();
    const api2 = fakeApi();
    expect(await rejectCall(1, 2, depsWith(repo2, api2))).toEqual({ ok: true });
    expect(repo2.calls[0]).toMatchObject({ status: "rejected", answeredByUserId: 2, sdpOffer: null });
    expect(api2.log).toEqual([{ action: "reject", callId: "wacid.IN1", sdp: undefined }]);
  });

  it("desligar: só quem está na chamada; terminate + duração", async () => {
    const repo = await ringingRepo();
    const api = fakeApi();
    const deps = depsWith(repo, api, T0 + 5_000);
    await claimCall(1, 1, deps);
    await answerCall(1, 1, "v=0", deps);
    expect(await hangupCall(1, { id: 2, role: "frontoffice" }, deps)).toEqual({ ok: false, error: "Só quem está na chamada a pode desligar." });
    const later = depsWith(repo, api, T0 + 5_000 + 125_000);
    expect(await hangupCall(1, { id: 1, role: "frontoffice" }, later)).toEqual({ ok: true });
    expect(repo.calls[0]).toMatchObject({ status: "ended", durationSec: 125 });
    expect(api.log.at(-1)).toMatchObject({ action: "terminate", callId: "wacid.IN1" });
  });

  it("estado: a resposta SDP só vai para quem ligou", async () => {
    const repo = fakeRepo({ names: { 7: "Carla" } });
    const deps = depsWith(repo, fakeApi());
    await applyCallEvents(parseCallWebhook(connectOut("wacid.O"), "PNID").events, deps);
    await repo.upsertOutbound({ callId: "wacid.O", phoneE164: "+351912345678", direction: "out", status: "dialing", startedAt: toDbUtc(T0), startedByUserId: 7, answeredByUserId: 7 });
    expect((await callState(1, 7, deps))!.sdpAnswer).toBe("v=0 answer");
    expect((await callState(1, 8, deps))!.sdpAnswer).toBeNull();
  });
});

// ─── Chamadas presas (prazo) ────────────────────────────────────────────────

describe("perdidas por prazo", () => {
  it("staleOutcome: a tocar > 75 s → perdida; antes disso nada", () => {
    const row = { status: "ringing", direction: "in" as const, startedAt: toDbUtc(T0), answeredAt: null };
    expect(staleOutcome(row, T0 + 60_000)).toBeNull();
    expect(staleOutcome(row, T0 + 76_000)).toBe("missed");
    expect(staleOutcome({ ...row, status: "answering", answeredAt: toDbUtc(T0) }, T0 + 3 * 60_000)).toBe("failed");
    expect(staleOutcome({ ...row, status: "dialing", direction: "out" }, T0 + 3 * 60_000)).toBe("missed");
    expect(staleOutcome({ ...row, status: "connected", answeredAt: toDbUtc(T0) }, T0 + 60 * 60_000)).toBeNull();
    expect(isRingingExpired(toDbUtc(T0), T0 + 59_000)).toBe(false);
    expect(isRingingExpired(toDbUtc(T0), T0 + 60_000)).toBe(true);
  });
  it("sweepStaleCalls fecha a chamada sem terminate e devolve-a para o aviso (1×)", async () => {
    const repo = await ringingRepo();
    expect((await sweepStaleCalls(depsWith(repo, fakeApi(), T0 + 30_000))).missed).toEqual([]);
    const r = await sweepStaleCalls(depsWith(repo, fakeApi(), T0 + 90_000));
    expect(r.missed).toEqual([1]);
    expect(repo.calls[0]).toMatchObject({ status: "missed", missed: 1, sdpOffer: null });
    expect((await sweepStaleCalls(depsWith(repo, fakeApi(), T0 + 120_000))).missed).toEqual([]);
  });
});

// ─── Autorização e limites ──────────────────────────────────────────────────

describe("autorização do cliente", () => {
  it("temporária expira; permanente não", () => {
    expect(effectivePermission({ status: "temporary", expiresAt: toDbUtc(T0 + 1000) }, T0)).toMatchObject({ valid: true, status: "temporary" });
    expect(effectivePermission({ status: "temporary", expiresAt: toDbUtc(T0 - 1000) }, T0)).toMatchObject({ valid: false, status: "none" });
    expect(effectivePermission({ status: "permanent", expiresAt: null, isPermanent: 1 }, T0)).toMatchObject({ valid: true });
    expect(effectivePermission(null, T0).valid).toBe(false);
  });
  it("resposta: aceite sem data → 7 dias; recusada", () => {
    expect(permissionFromReply({ response: "accept" }, T0)).toEqual({ status: "temporary", expiresAt: toDbUtc(T0 + 7 * 86_400_000), isPermanent: false });
    expect(permissionFromReply({ response: "reject" }, T0).status).toBe("rejected");
  });
  it("limites da Meta: 1 pedido por 24 h e 2 por 7 dias", () => {
    let times: string | null = null;
    expect(canRequestPermission(times, T0).ok).toBe(true);
    times = appendRequestTime(times, T0);
    const blocked = canRequestPermission(times, T0 + 3_600_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? "" : blocked.reason).toMatch(/últimas 24 h/);
    expect(canRequestPermission(times, T0 + 25 * 3_600_000).ok).toBe(true);
    times = appendRequestTime(times, T0 + 25 * 3_600_000);
    const week = canRequestPermission(times, T0 + 50 * 3_600_000);
    expect(week.ok ? "" : week.reason).toMatch(/2 pedidos de autorização nos últimos 7 dias/);
    expect(canRequestPermission(times, T0 + 8 * 86_400_000).ok).toBe(true);
  });
  it("permissionInfo: a Meta manda (revogada → sem autorização; temporária → guarda)", async () => {
    const repo = fakeRepo();
    await repo.savePermission("+351912345678", { status: "temporary", expiresAt: toDbUtc(T0 + 86_400_000) });
    const deps = depsWith(repo, fakeApi(), T0);
    const revoked = await permissionInfo("+351912345678", { ...deps, remote: async () => ({ ok: true, data: { status: "none", expiresAt: null, canRequest: true } }) });
    expect(revoked).toMatchObject({ valid: false, status: "none", canRequest: true, source: "meta" });
    const granted = await permissionInfo("+351912345678", { ...deps, remote: async () => ({ ok: true, data: { status: "temporary", expiresAt: T0 + 3 * 86_400_000, canRequest: false } }) });
    expect(granted).toMatchObject({ valid: true, status: "temporary", expiresAt: toDbUtc(T0 + 3 * 86_400_000) });
    const offline = await permissionInfo("+351912345678", { ...deps, remote: async () => ({ ok: false, error: "rede" }) });
    expect(offline).toMatchObject({ source: "local", valid: true });
  });
  it("pedido enviado fica 'à espera' e conta para o limite", async () => {
    const repo = fakeRepo();
    const deps = depsWith(repo, fakeApi(), T0);
    await notePermissionRequested("+351912345678", 7, deps);
    const info = await permissionInfo("+351912345678", deps);
    expect(info).toMatchObject({ status: "requested", valid: false, canRequest: false });
    expect(info.requestBlockedReason).toMatch(/24 h/);
  });
  it("aviso de chamadas seguidas sem resposta (2 → aviso; a Meta revoga às 4)", async () => {
    const repo = fakeRepo();
    for (const [i, id] of ["a", "b"].entries()) await repo.insertCall({ callId: id, phoneE164: "+351912345678", direction: "out", status: "missed", startedAt: toDbUtc(T0 - (i + 1) * 60_000) });
    const info = await permissionInfo("+351912345678", depsWith(repo, fakeApi(), T0));
    expect(info.unansweredStreak).toBe(2);
    expect(info.warning).toMatch(/4\.ª/);
  });
});

describe("ligar (chamada nossa)", () => {
  const perm = (valid: boolean, connectedLast24h = 0) => ({ status: valid ? "temporary" : "none", expiresAt: null, valid, canRequest: !valid, requestBlockedReason: null, connectedLast24h, unansweredStreak: 0, warning: null, source: "local" } as const);
  it("sem autorização / limite de 100 / chamada em curso → erro PT-PT, sem chamar a Meta", async () => {
    expect(callBlockedReason(perm(false), false)).toMatch(/ainda não autorizou/);
    expect(callBlockedReason(perm(true, 100), false)).toMatch(/100 chamadas ligadas em 24 h/);
    expect(callBlockedReason(perm(true), true)).toMatch(/Já há uma chamada em curso/);
    expect(callBlockedReason(perm(true), false)).toBeNull();
    const repo = fakeRepo();
    const api = fakeApi();
    const r = await startCall({ conversationId: 10, phoneE164: "+351912345678", projectId: 3, sdpOffer: "v=0", userId: 7 }, { ...depsWith(repo, api), permission: perm(false) });
    expect(r.ok).toBe(false);
    expect(api.log).toHaveLength(0);
  });
  it("com autorização: connect e linha 'a chamar' ligada à conversa/cidade/pessoa", async () => {
    const repo = fakeRepo();
    const api = fakeApi();
    const r = await startCall({ conversationId: 10, phoneE164: "+351912345678", projectId: 3, sdpOffer: "v=0 offer", userId: 7 }, { ...depsWith(repo, api), permission: perm(true) });
    expect(r).toEqual({ ok: true, id: 1 });
    expect(api.log[0]).toMatchObject({ action: "connect", sdp: "v=0 offer" });
    expect(repo.calls[0]).toMatchObject({ callId: "wacid.OUTNEW", status: "dialing", conversationId: 10, projectId: 3, startedByUserId: 7 });
  });
  it("Meta diz 138006 (sem autorização) → autorização local apagada", async () => {
    const repo = fakeRepo();
    await repo.savePermission("+351912345678", { status: "temporary", expiresAt: toDbUtc(T0 + 86_400_000) });
    const api = fakeApi({ connect: { ok: false, error: describeCallError(138006), code: 138006 } });
    const r = await startCall({ conversationId: 10, phoneE164: "+351912345678", projectId: 3, sdpOffer: "v=0", userId: 7 }, { ...depsWith(repo, api), permission: perm(true) });
    expect(r.ok ? "" : r.error).toMatch(/não deu autorização/);
    expect(repo.perms.get("+351912345678").status).toBe("none");
  });
});

// ─── Payloads da API ────────────────────────────────────────────────────────

describe("payloads da Calling API", () => {
  it("pre_accept / accept levam a resposta SDP; reject / terminate não", () => {
    expect(buildCallActionPayload("pre_accept", "wacid.1", "SDP")).toEqual({ messaging_product: "whatsapp", call_id: "wacid.1", action: "pre_accept", session: { sdp_type: "answer", sdp: "SDP" } });
    expect(buildCallActionPayload("accept", "wacid.1", "SDP")).toEqual({ messaging_product: "whatsapp", call_id: "wacid.1", action: "accept", session: { sdp_type: "answer", sdp: "SDP" } });
    expect(buildCallActionPayload("reject", "wacid.1")).toEqual({ messaging_product: "whatsapp", call_id: "wacid.1", action: "reject" });
    expect(buildCallActionPayload("terminate", "wacid.1", "ignorado")).toEqual({ messaging_product: "whatsapp", call_id: "wacid.1", action: "terminate" });
    expect(() => buildCallActionPayload("accept", "wacid.1", "")).toThrow(/resposta SDP/);
  });
  it("connect: número sem '+', oferta SDP", () => {
    expect(buildConnectPayload("+351 912 345 678", "OFFER", "u7")).toEqual({ messaging_product: "whatsapp", to: "351912345678", action: "connect", session: { sdp_type: "offer", sdp: "OFFER" }, biz_opaque_callback_data: "u7" });
    expect(() => buildConnectPayload("+351912345678", " ")).toThrow();
  });
  it("pedido de autorização: interativo (janela aberta) e template", () => {
    expect(buildPermissionRequestPayload("+351912345678", "Podemos ligar?")).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "351912345678", type: "interactive",
      interactive: { type: "call_permission_request", action: { name: "call_permission_request" }, body: { text: "Podemos ligar?" } },
    });
    expect(buildPermissionTemplatePayload("+351912345678", "pedir_ligar", "pt_PT")).toMatchObject({ type: "template", template: { name: "pedir_ligar", language: { code: "pt_PT" } } });
  });
  it("definições: ativar + horário (Lisboa) + pedido de autorização no ligar de volta", () => {
    expect(buildCallingSettingsPayload({
      enabled: true, callbackPermission: true,
      callHours: { enabled: true, timezoneId: "Europe/Lisbon", weekly: [{ day: "MONDAY", open: "0800", close: "2000" }] },
    })).toEqual({ calling: {
      status: "ENABLED", callback_permission_status: "ENABLED",
      call_hours: { status: "ENABLED", timezone_id: "Europe/Lisbon", weekly_operating_hours: [{ day_of_week: "MONDAY", open_time: "0800", close_time: "2000" }] },
    } });
    expect(() => buildCallingSettingsPayload({ enabled: true, callHours: { enabled: true, timezoneId: "Europe/Lisbon", weekly: [{ day: "MONDAY", open: "2000", close: "0800" }] } })).toThrow(/fecho/);
    expect(buildCallingSettingsPayload({ enabled: false })).toEqual({ calling: { status: "DISABLED" } });
  });
  it("GET call_permissions e GET settings → resumo", () => {
    expect(parseCallPermissionsResponse({ permission: { status: "temporary", expiration_time: 1745343479 }, actions: [{ action_name: "send_call_permission_request", can_perform_action: false }] }))
      .toEqual({ status: "temporary", expiresAt: 1745343479000, canRequest: false });
    const s = summarizeCallingSettings({ calling: { status: "ENABLED", callback_permission_status: "DISABLED", call_hours: { status: "ENABLED", timezone_id: "Europe/Lisbon", weekly_operating_hours: [{ day_of_week: "MONDAY", open_time: "0800", close_time: "2000" }] } } });
    expect(s).toMatchObject({ enabled: true, callbackPermission: false, callHours: "Europe/Lisbon: MON 0800-2000" });
  });
  it("executor: POST /{PNID}/calls com Bearer; erro 138006 em PT-PT", async () => {
    const seen: any[] = [];
    const fetch = (async (url: string, init: any) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ error: { code: 138006, message: "No approved call permission" } }), { status: 400 });
    }) as any;
    const r = await graphPhoneRequest("POST", "calls", { a: 1 }, { fetch, env: { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "123", WHATSAPP_API_VERSION: "v24.0" } });
    expect(seen[0].url).toBe("https://graph.facebook.com/v24.0/123/calls");
    expect(seen[0].init.headers.Authorization).toBe("Bearer tok");
    expect(r).toEqual({ ok: false, error: `${describeCallError(138006)} (código 138006)`, code: 138006 });
    expect(await graphPhoneRequest("GET", "settings", undefined, { fetch, env: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/não configurado/) });
  });
});

// ─── Diagnóstico (Integrações → Testar) ─────────────────────────────────────

describe("Testar — WhatsApp Chamadas", () => {
  it("chamadas desativadas / campo calls por subscrever → falha com o que fazer", () => {
    const off = describeCallingDiagnosis({ settingsError: null, summary: summarizeCallingSettings({ calling: { status: "DISABLED" } }), callsFieldSubscribed: false, subscriptionNote: null });
    expect(off.ok).toBe(false);
    expect(off.message).toMatch(/DESATIVADAS/);
    expect(off.message).toMatch(/"calls" NÃO está subscrito/);
    const ok = describeCallingDiagnosis({ settingsError: null, summary: summarizeCallingSettings({ calling: { status: "ENABLED" } }), callsFieldSubscribed: true, subscriptionNote: null });
    expect(ok).toMatchObject({ ok: true });
    const unknown = describeCallingDiagnosis({ settingsError: null, summary: summarizeCallingSettings({ calling: { status: "ENABLED" } }), callsFieldSubscribed: null, subscriptionNote: "sem permissão" });
    expect(unknown.ok).toBe(true);
    expect(unknown.message).toMatch(/não foi possível confirmar/);
  });
  it("lê as subscrições da app", () => {
    expect(callsFieldInSubscriptions({ data: [{ object: "whatsapp_business_account", fields: [{ name: "messages" }, { name: "calls" }] }] })).toBe(true);
    expect(callsFieldInSubscriptions({ data: [{ object: "whatsapp_business_account", fields: [{ name: "messages" }] }] })).toBe(false);
    expect(callsFieldInSubscriptions({})).toBeNull();
  });
});

// ─── Texto, estados ─────────────────────────────────────────────────────────

describe("linha do tempo e estados", () => {
  it("textos das entradas", () => {
    expect(callTimelineLabel({ direction: "in", status: "ended", durationSec: 180, answeredByName: "Ana" }, "14:32")).toBe("Chamada recebida 14:32 · 3 min · atendida por Ana");
    expect(callTimelineLabel({ direction: "in", status: "missed", durationSec: null }, "14:32")).toBe("Chamada perdida 14:32");
    expect(callTimelineLabel({ direction: "out", status: "ended", durationSec: 45, startedByName: "Rui" }, "15:00")).toBe("Chamada efetuada 15:00 · 45 s · por Rui");
    expect(callTimelineLabel({ direction: "out", status: "missed", durationSec: null }, "15:00")).toBe("Chamada efetuada 15:00 · não atendida");
    expect(formatCallDuration(3900)).toBe("1 h 05 min");
    expect(formatCallTimer(65_000)).toBe("1:05");
  });
  it("transições da Meta nunca voltam atrás", () => {
    expect(statusAfterTerminate("ringing", "in")).toBe("missed");
    expect(statusAfterTerminate("connected", "in")).toBe("ended");
    expect(statusAfterTerminate("answering", "in")).toBe("failed");
    expect(statusAfterTerminate("dialing", "out", "REJECTED")).toBe("rejected");
    expect(statusAfterMetaStatus("ended", "ACCEPTED")).toBeNull();
    expect(statusAfterMetaStatus("dialing", "RINGING")).toBe("ringing");
  });
});

// ─── Cidade, notificação e acessos ──────────────────────────────────────────

describe("cidade e aviso de chamada perdida", () => {
  it("o toque e a lista usam a MESMA regra de cidade das conversas", () => {
    for (const scope of [undefined, [], [3, 4]]) expect(callScopeSql(scope)).toEqual(visibilitySql(scope));
  });
  it("por devolver: uma linha por número, com as tentativas", () => {
    const g = groupPendingCallbacks([{ phoneE164: "+1", id: 3 }, { phoneE164: "+2", id: 2 }, { phoneE164: "+1", id: 1 }]);
    expect(g).toEqual([{ phoneE164: "+1", id: 3, attempts: 2 }, { phoneE164: "+2", id: 2, attempts: 1 }]);
  });
  it("whatsapp_missed_call vai à equipa da cidade da conversa (e ao super admin)", () => {
    const def = kindDef("whatsapp_missed_call")!;
    expect(def).toMatchObject({ module: "whatsapp", cityScoped: true, personal: false });
    let id = 1;
    const p = (role: string, cities: RoutingCandidate["cities"]): RoutingCandidate => ({ id: id++, role, isActive: true, cities, accessOverrides: {}, prefs: { muted: [], email: {} } });
    const sa = p("super_admin", "all"), tlLx = p("team_leader", ["lisbon"]), tlPo = p("team_leader", ["porto"]), cond = p("condutor", ["lisbon"]);
    const ids = resolveRecipients({ kind: "whatsapp_missed_call", city: "lisbon" }, [sa, tlLx, tlPo, cond]).map((r) => r.userId).sort();
    expect(ids).toEqual([sa.id, tlLx.id].sort());
  });
  it("docs das notificações citam a origem do tipo novo", () => {
    expect(readFileSync(resolve(root, "shared/notificationRoutingDoc.ts"), "utf8")).toContain("whatsapp_missed_call:");
  });
});

describe("acessos", () => {
  it("atender/ligar exige WhatsApp editar (condutor/extra não)", () => {
    for (const role of ["team_leader", "supervisor", "super_admin"]) expect(can(role, "whatsapp", "edit"), role).toBe(true);
    for (const role of ["condutor", "extra", "user"]) expect(can(role, "whatsapp", "edit"), role).toBe(false);
  });
  it("cada procedimento de whatsapp.calls verifica o acesso (e a cidade quando mexe numa chamada/conversa)", () => {
    const src = readFileSync(resolve(root, "server/whatsappCallsRouter.ts"), "utf8");
    const blocks = src.split(/\n  (?=\w+: protectedProcedure)/).slice(1);
    expect(blocks.length).toBeGreaterThanOrEqual(15);
    for (const b of blocks) {
      const name = b.slice(0, b.indexOf(":"));
      expect(/requireAccess\(ctx\.user, "whatsapp", "(view|edit)"\)|superOnly\(ctx\.user\.role\)/.test(b), name).toBe(true);
      if (/input\(z\.object\(\{ (id|conversationId)/.test(b)) expect(/assertCallVisible|assertConversation/.test(b), name).toBe(true);
    }
    expect(src).toMatch(/configure: protectedProcedure[\s\S]*?superOnly/);
  });
  it("interruptor WHATSAPP_CALLS: desligado por omissão e aplicado no toque, atender, ligar e webhook", async () => {
    const { automationFlagDefault, AUTOMATION_FLAGS } = await import("../shared/appSettings");
    expect(AUTOMATION_FLAGS.some((f) => f.name === "WHATSAPP_CALLS")).toBe(true);
    expect(automationFlagDefault("WHATSAPP_CALLS")).toBe(false);
    const src = readFileSync(resolve(root, "server/whatsappCallsRouter.ts"), "utf8");
    for (const name of ["claim", "answer", "start", "requestPermission"]) {
      expect(new RegExp(`\\n  ${name}: protectedProcedure[\\s\\S]*?requireCallsEnabled\\(\\)`).test(src), name).toBe(true);
    }
    expect(src).toMatch(/incoming: protectedProcedure[\s\S]*?whatsappCallsEnabled\(\)\)\) return \[\]/);
    const wh = readFileSync(resolve(root, "server/whatsappWebhook.ts"), "utf8");
    expect(wh).toMatch(/hasCallContent\(payload\) && \(await \(await import\("\.\/whatsappCalls"\)\)\.whatsappCallsEnabled\(\)\)/);
  });
  it("montado em whatsapp.calls (alcance de cidade do módulo whatsapp)", () => {
    const r = readFileSync(resolve(root, "server/routers.ts"), "utf8");
    expect(r).toContain("calls: whatsappCallsRouter,");
  });
});

describe("migração 0185", () => {
  it("registada no ensureRecentSchema (por ordem), idempotente e espelhada no schema drizzle", async () => {
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    const nums = [...db.matchAll(/import\("\.\/migrations\/migration_(\d{4})"\)\.then\(m => \(\{ s: m\.MIGRATION_/g)].map((x) => Number(x[1]));
    expect(nums).toContain(185);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    const { MIGRATION_0185_STATEMENTS, IDEMPOTENT_ERROR_CODES_0185 } = await import("./migrations/migration_0185");
    for (const st of MIGRATION_0185_STATEMENTS) expect(st).toMatch(/^CREATE TABLE IF NOT EXISTS/);
    expect(MIGRATION_0185_STATEMENTS.join("\n")).toContain("UNIQUE KEY `uq_whatsapp_calls_call_id` (`callId`)");
    expect(IDEMPOTENT_ERROR_CODES_0185.has("ER_DUP_KEYNAME")).toBe(true);
    const schema = readFileSync(resolve(root, "drizzle/schema.ts"), "utf8");
    expect(schema).toContain('mysqlTable("whatsapp_calls"');
    expect(schema).toContain('mysqlTable("whatsapp_call_permissions"');
  });
});
