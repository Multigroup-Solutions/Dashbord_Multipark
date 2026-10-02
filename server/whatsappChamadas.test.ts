/**
 * P3 lote 17c — Chamadas do WhatsApp: uma chamada recebida que nunca ligou
 * (perdida OU "atender" que falhou) entra em "por devolver" e avisa a equipa;
 * uma chamada com duração conta como atendida; desligar uma recebida por
 * atender recusa-a; os erros aparecem; horas de Lisboa.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canRequestPermission, countsAsMissed, statusAfterTerminate, toDbUtc } from "../shared/whatsappCalls";
import { answerCall, hangupCall, sweepStaleCalls } from "./whatsappCalls";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const T0 = Date.parse("2026-10-02T10:00:00Z");

function miniDeps(row: any, failing: Record<string, boolean> = {}, now = T0 + 5_000) {
  const sets: any[] = [];
  const actions: string[] = [];
  const touched: any[] = [];
  const repo: any = {
    async getById() { return { ...row }; },
    async transition(_id: number, from: string[], set: any) { if (!from.includes(row.status)) return false; sets.push(set); Object.assign(row, set); return true; },
    async listStale() { return [{ ...row }]; },
    async touchConversation(conversationId: number, patch: any) { touched.push({ conversationId, ...patch }); },
  };
  const api: any = { async callAction(action: string) { actions.push(action); return failing[action] ? { ok: false, error: "erro da Meta" } : { ok: true }; } };
  return { deps: { repo, api, now: () => now } as any, sets, actions, touched };
}
const baseRow = (o: any) => ({ id: 1, callId: "wacid.1", conversationId: 10, phoneE164: "+351912345678", direction: "in", status: "ringing", startedAt: toDbUtc(T0), answeredAt: null, answeredByUserId: null, startedByUserId: null, sdpOffer: "v=0", ...o });

describe("Recebida que nunca ligou = perdida (por devolver + aviso)", () => {
  it("regra: perdida ou 'falhou' a atender, só nas recebidas", () => {
    expect(countsAsMissed("in", "missed")).toBe(true);
    expect(countsAsMissed("in", "failed")).toBe(true);
    expect(countsAsMissed("in", "ended")).toBe(false);
    expect(countsAsMissed("out", "failed")).toBe(false);
  });
  it("a Meta recusa o atender → 'falhou' com perdida = 1", async () => {
    const { deps, sets } = miniDeps(baseRow({ status: "answering", answeredByUserId: 7 }), { pre_accept: true });
    const r = await answerCall(1, 7, "v=0 answer", deps);
    expect(r).toMatchObject({ ok: false, missed: true });
    expect(sets[0]).toMatchObject({ status: "failed", missed: 1 });
  });
  it("'já não está contigo' (outra pessoa atendeu) não marca nem avisa", async () => {
    const { deps, sets } = miniDeps(baseRow({ status: "connected", answeredByUserId: 9 }));
    const r = await answerCall(1, 7, "v=0 answer", deps);
    expect(r.ok).toBe(false);
    expect((r as any).missed).toBeUndefined();
    expect(sets).toEqual([]);
  });
  it("a atender há demasiado tempo → 'falhou', perdida e na lista do aviso", async () => {
    const { deps, sets, touched } = miniDeps(baseRow({ status: "answering", answeredAt: toDbUtc(T0) }), {}, T0 + 10 * 60_000);
    const r = await sweepStaleCalls(deps);
    expect(sets[0]).toMatchObject({ status: "failed", missed: 1 });
    expect(r.missed).toEqual([1]);
    expect(touched[0]).toMatchObject({ preview: "📞 Chamada perdida", needsAttention: true });
  });
  it("'por devolver' e 'devolvida' contam as perdidas marcadas (não só missed/rejected)", () => {
    expect(src("server/whatsappCallsQueries.ts")).toContain("AND (k.status IN ('missed','rejected') OR k.missed = 1) AND k.callbackDoneAt IS NULL");
    expect(src("server/whatsappCalls.ts")).toContain('or(inArray(whatsappCalls.status, ["missed", "rejected"]), eq(whatsappCalls.missed, 1))');
  });
  it("o atender que falhou avisa a equipa", () => {
    const r = src("server/whatsappCallsRouter.ts");
    expect(r).toContain("if (r.missed) {");
    expect(r.indexOf("if (r.missed) {")).toBeLessThan(r.indexOf("await notifyMissedByIds([input.id]).catch(() => undefined);"));
  });
});

describe("Estados", () => {
  it("com duração = atendida, mesmo que o 'atendida' chegue depois; sem duração não", () => {
    expect(statusAfterTerminate("dialing", "out", "COMPLETED", 95)).toBe("ended");
    expect(statusAfterTerminate("ringing", "in", "COMPLETED", 30)).toBe("ended");
    expect(statusAfterTerminate("ringing", "in", "COMPLETED")).toBe("missed");
    expect(statusAfterTerminate("dialing", "out", "COMPLETED")).toBe("missed");
    expect(statusAfterTerminate("answering", "in", "COMPLETED")).toBe("failed");
  });
  it("desligar uma recebida que ainda não ligou → 'reject' na Meta (e 'terminate' se recusar)", async () => {
    const a = miniDeps(baseRow({ status: "answering", answeredByUserId: 7 }));
    await hangupCall(1, { id: 7, role: "team_leader" }, a.deps);
    expect(a.actions).toEqual(["reject"]);
    expect(a.sets[0]).toMatchObject({ status: "failed", missed: 1 });
    const b = miniDeps(baseRow({ status: "answering", answeredByUserId: 7 }), { reject: true });
    await hangupCall(1, { id: 7, role: "team_leader" }, b.deps);
    expect(b.actions).toEqual(["reject", "terminate"]);
    const c = miniDeps(baseRow({ status: "connected", answeredByUserId: 7, answeredAt: toDbUtc(T0) }));
    await hangupCall(1, { id: 7, role: "team_leader" }, c.deps);
    expect(c.actions).toEqual(["terminate"]);
    expect(c.sets[0]).toMatchObject({ status: "ended", missed: 0 });
  });
});

describe("Browser", () => {
  const lib = src("client/src/lib/whatsappCall.ts");
  it("erro ao 'Atender' não deixa os botões presos; falha antes de responder devolve a chamada aos outros", () => {
    expect(lib).toContain("claim = await client.whatsapp.calls.claim.mutate({ id: call.id });");
    expect(lib).toContain("if (!answerSent) await client.whatsapp.calls.release.mutate({ id: call.id }).catch(() => undefined);");
    expect(src("client/src/components/whatsapp/WhatsAppCallManager.tsx")).toContain("} finally {\n      // Os botões nunca ficam presos (17c).\n      setBusyId(null);");
  });
  it("'Desligar' durante a preparação cancela a chamada que acabou de nascer", () => {
    expect(lib).toContain("if (!id && active?.direction === \"out\" && active.phase === \"connecting\") cancelPendingStart = true;");
    expect(lib).toContain("await client.whatsapp.calls.hangup.mutate({ id: r.id }).catch(() => undefined);");
  });
  it("o aviso do sistema fecha-se sozinho ~1 min depois", () => {
    const sw = src("client/public/sw.js");
    expect(sw).toContain("await new Promise((resolve) => setTimeout(resolve, 70000));");
    expect(sw).toContain("self.registration.getNotifications({ tag })");
  });
});

describe("Ecrã: erros e horas", () => {
  const panels = src("client/src/components/whatsapp/WhatsAppCallsPanels.tsx");
  it("'por devolver', chamadas da conversa e configuração dizem quando falham", () => {
    expect(panels).toContain('what="as chamadas por devolver"');
    expect(panels).toContain("!list.isLoading && !list.error && !(list.data ?? []).length");
    expect(panels).toContain('what="a configuração das chamadas"');
    expect(src("client/src/pages/WhatsAppInboxPage.tsx")).toContain('what="as chamadas desta conversa"');
    expect(src("client/src/components/whatsapp/InboxListHeader.tsx")).toContain("por devolver: ?");
  });
  it("horas em hora de Lisboa (painéis e limite de pedidos de autorização)", () => {
    expect(panels).toContain('timeZone: "Europe/Lisbon"');
    // 2 pedidos nos últimos 7 dias → próxima data em Lisboa, sem "UTC"
    const now = Date.parse("2026-10-02T12:00:00Z");
    const times = JSON.stringify([now - 3 * 86_400_000, now - 2 * 86_400_000]);
    const r = canRequestPermission(times, now);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toContain("UTC");
      expect(r.reason).toContain("06/10 13:00"); // 29/09 12:00 UTC + 7 dias = 06/10 13:00 em Lisboa
    }
  });
  it("as mensagens apontam para o sítio certo da configuração", () => {
    expect(src("shared/whatsappCalls.ts")).toContain("WhatsApp → Por devolver → Configuração das chamadas");
    expect(src("server/whatsappCallsDiagnostics.ts")).not.toContain("WhatsApp → Chamadas → Configuração");
  });
});
