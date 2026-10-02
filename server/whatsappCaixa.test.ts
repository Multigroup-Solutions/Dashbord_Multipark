/**
 * P3 lote 17a — Caixa do WhatsApp: uma mensagem nunca chega duas vezes ao
 * cliente (sem repetição automática quando o envio é incerto, código único
 * por envio, "sem confirmação" em vez de "falhou"), leitura falhada ≠ vazio,
 * responsáveis = quem responde e vê a cidade, respostas rápidas arquivam.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({ reply: null as any, replies: [] as any[] }));
const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  logActivity: async () => {},
}));
vi.mock("./whatsappInbox", async (original) => ({
  ...(await original<object>()),
  conversationVisible: async () => true,
  replyToConversation: async (...args: any[]) => { state.replies.push(args); return state.reply; },
}));

import { appRouter } from "./routers";
import { isPreConnectError, sendTextMessage } from "./whatsapp";
import { duplicateRequestOutcome, nextStatus, reserveOutboundMessage } from "./whatsappStore";
import { conversationSearchSql, inboundMediaState } from "./whatsappInbox";
import { ASSIGNABLE_ROLES } from "./whatsappInboxOps";
import { MIGRATION_0350_STATEMENTS } from "./migrations/migration_0350";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { daySeparatorLabel } from "../shared/whatsappInboxView";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const compile = (q: any) => new MySqlDialect().sqlToQuery(q);

describe("Envio para a Meta: incerto nunca se repete sozinho", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
  });
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("5xx da Meta → 1 só pedido e `uncertain` (a mensagem pode ter saído)", async () => {
    const f = vi.fn(async () => json(500, { error: { message: "boom", code: 1 } }));
    vi.stubGlobal("fetch", f);
    const r = await sendTextMessage("+351912345678", "olá");
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, uncertain: true });
  });
  it("ligação cortada a meio → 1 só pedido e `uncertain`", async () => {
    const f = vi.fn(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); });
    vi.stubGlobal("fetch", f);
    const r = await sendTextMessage("+351912345678", "olá");
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, uncertain: true });
  });
  it("antes de o pedido sair (DNS/recusado) e 429 → repete uma vez (a Meta não recebeu)", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      return json(200, { messages: [{ id: "wamid.1" }] });
    }));
    expect(await sendTextMessage("+351912345678", "olá")).toEqual({ ok: true, waMessageId: "wamid.1" });
    let m = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++m === 1 ? json(429, { error: { message: "rate", code: 130429 } }) : json(200, { messages: [{ id: "wamid.2" }] }))));
    expect(await sendTextMessage("+351912345678", "olá")).toEqual({ ok: true, waMessageId: "wamid.2" });
  });
  it("erro de aplicação (4xx) → falhou de certeza, sem `uncertain`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(400, { error: { message: "bad", code: 131026 } })));
    const r = await sendTextMessage("+351912345678", "olá");
    expect(r.ok).toBe(false);
    expect((r as any).uncertain).toBeUndefined();
  });
  it("isPreConnectError só para erros antes de enviar", () => {
    expect(isPreConnectError({ cause: { code: "ENOTFOUND" } })).toBe(true);
    expect(isPreConnectError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isPreConnectError({ cause: { code: "ECONNRESET" } })).toBe(false);
    expect(isPreConnectError(new Error("Sem resposta de graph.facebook.com em 15s"))).toBe(false);
  });
});

describe("Código único por envio", () => {
  it("pedido repetido: enviada → ok sem reenviar; a enviar/sem confirmação → não reenvia; falhou → pode tentar", () => {
    expect(duplicateRequestOutcome({ status: "sent", waMessageId: "w" })).toEqual({ kind: "sent", waMessageId: "w" });
    expect(duplicateRequestOutcome({ status: "read", waMessageId: "w" }).kind).toBe("sent");
    expect(duplicateRequestOutcome({ status: "pending", waMessageId: null }).kind).toBe("in_doubt");
    expect(duplicateRequestOutcome({ status: "unknown", waMessageId: null }).kind).toBe("in_doubt");
    expect(duplicateRequestOutcome({ status: "failed", waMessageId: null }).kind).toBe("retry");
  });
  it("'sem confirmação' avança quando a Meta confirma depois; 'falhou' continua final", () => {
    expect(nextStatus("unknown", "delivered")).toBe("delivered");
    expect(nextStatus("pending", "sent")).toBe("sent");
    expect(nextStatus("failed", "read")).toBeNull();
  });

  function fakeDb(existing: any, affected = 1) {
    const calls: string[] = [];
    const db: any = {
      insert: () => ({ values: async () => { calls.push("insert"); throw Object.assign(new Error("dup"), { cause: { code: "ER_DUP_ENTRY", errno: 1062 } }); } }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => (existing ? [existing] : []) }) }) }),
      update: () => ({ set: (v: any) => ({ where: async () => { calls.push(`update:${v.status}`); return [{ affectedRows: affected }]; } }) }),
    };
    return { db, calls };
  }
  const row = { conversationId: 5, type: "text" as const, body: "olá", clientRequestId: "req-12345678" };

  it("mesmo código já enviado → não reserva (não volta a chamar a Meta)", async () => {
    const { db, calls } = fakeDb({ id: 9, conversationId: 5, status: "sent", waMessageId: "w", errorDetail: null });
    const r = await reserveOutboundMessage(db, row);
    expect(r).toMatchObject({ reserved: false, existing: { id: 9, status: "sent" } });
    expect(calls).toEqual(["insert"]);
  });
  it("mesmo código que falhou de certeza → reserva a mesma linha (uma só ganha a corrida)", async () => {
    const { db, calls } = fakeDb({ id: 9, conversationId: 5, status: "failed", waMessageId: null, errorDetail: "x" });
    expect(await reserveOutboundMessage(db, row)).toEqual({ reserved: true, id: 9 });
    expect(calls).toEqual(["insert", "update:pending"]);
    const lost = fakeDb({ id: 9, conversationId: 5, status: "failed", waMessageId: null, errorDetail: "x" }, 0);
    expect((await reserveOutboundMessage(lost.db, row)).reserved).toBe(false);
  });
  it("código de outra conversa → não reaproveita", async () => {
    const { db } = fakeDb({ id: 9, conversationId: 6, status: "failed", waMessageId: null, errorDetail: null });
    expect((await reserveOutboundMessage(db, row)).reserved).toBe(false);
  });
});

describe("Router: resposta sem confirmação não é erro; código passa ao servidor", () => {
  beforeEach(() => { state.replies = []; });
  it("uncertain volta como resultado (a mensagem fica na conversa), não como erro", async () => {
    state.reply = { ok: false, uncertain: true, error: "Sem resposta da Meta" };
    const r = await caller("team_leader").whatsapp.reply({ conversationId: 5, text: "olá", clientRequestId: "req-12345678" });
    expect(r).toMatchObject({ ok: false, uncertain: true });
    expect(state.replies[0][3]).toMatchObject({ clientRequestId: "req-12345678" });
  });
  it("falhou de certeza → erro", async () => {
    state.reply = { ok: false, error: "Janela de 24h fechada" };
    await expect(caller("team_leader").whatsapp.reply({ conversationId: 5, text: "olá" })).rejects.toThrow(/Janela/);
  });
  it("arquivar respostas rápidas é de quem gere (TL não); 'apagar' deixou de existir", async () => {
    const procs = (appRouter as any)._def.procedures as Record<string, unknown>;
    expect(procs["whatsapp.quickReplies.delete"]).toBeUndefined();
    expect(procs["whatsapp.quickReplies.archive"]).toBeDefined();
    await expect(caller("team_leader").whatsapp.quickReplies.archive({ id: 1 })).rejects.toThrow();
  });
});

describe("Responsáveis = quem responde e vê a conversa", () => {
  it("os papéis que podem responder (inclui TL e frontoffice, que ficavam com conversas sem estar na lista)", () => {
    expect(ASSIGNABLE_ROLES).toEqual(expect.arrayContaining(["team_leader", "supervisor", "frontoffice", "backoffice", "admin", "super_admin"]));
    expect(ASSIGNABLE_ROLES).not.toContain("condutor");
    expect(ASSIGNABLE_ROLES).not.toContain("extra");
  });
  it("atribuir confirma a cidade da conversa para a pessoa escolhida", () => {
    const ops = src("server/whatsappInboxOps.ts");
    expect(ops).toContain("const ok = (await listAssignees(conversationId)).some((u) => u.id === userId);");
    expect(ops).toContain("conversationVisibleTo(facts, access.all ? undefined : access.projectIds)");
  });
});

describe("Lista, pesquisa e media", () => {
  it("pesquisa no servidor: vazia = nada; número só com ≥3 dígitos; % e _ escapados", () => {
    expect(conversationSearchSql("  ")).toBeNull();
    const q = compile(conversationSearchSql("Ana 50%")!);
    expect(q.params).toContain("%Ana 50\\%%");
    expect(q.sql).not.toContain("phoneE164` LIKE");
    const p = compile(conversationSearchSql("912 345")!);
    expect(p.params).toContain("%912345%");
  });
  it("ficheiro recebido: a descarregar vs desistiu (5 tentativas, demasiado grande ou > 25 dias)", () => {
    const now = Date.parse("2026-10-02T10:00:00Z");
    expect(inboundMediaState({ mediaType: null, mediaAvailable: false, mediaAttempts: 0, createdAt: "2026-10-02 09:00:00" }, now)).toBeNull();
    expect(inboundMediaState({ mediaType: "image", mediaAvailable: true, mediaAttempts: 0, createdAt: "2026-10-02 09:00:00" }, now)).toBe("ok");
    expect(inboundMediaState({ mediaType: "image", mediaAvailable: false, mediaAttempts: 2, createdAt: "2026-10-02 09:00:00" }, now)).toBe("retrying");
    expect(inboundMediaState({ mediaType: "document", mediaAvailable: false, mediaAttempts: 5, createdAt: "2026-10-02 09:00:00" }, now)).toBe("gave_up");
    expect(inboundMediaState({ mediaType: "image", mediaAvailable: false, mediaAttempts: 1, createdAt: "2026-09-01 09:00:00" }, now)).toBe("gave_up");
    const inbound = src("server/whatsappInbound.ts");
    expect(inbound).toContain("giveUp = /demasiado grande/i.test(dl.error);");
  });
  it("dias da conversa em hora de Lisboa", () => {
    const now = Date.UTC(2026, 9, 1, 14, 0);
    expect(daySeparatorLabel(Date.UTC(2026, 8, 30, 23, 30), now)).toBe("Hoje");
  });
});

describe("Migração 0350", () => {
  it("registada; código único, estado 'unknown' e arquivo das respostas rápidas; nada se apaga", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0350");
    expect(SCHEMA_MIGRATION_IDS.indexOf("0350")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0345"));
    const all = MIGRATION_0350_STATEMENTS.join("\n");
    for (const c of ["`clientRequestId`", "`uq_whatsapp_messages_client_request`", "'unknown'", "`archivedAt`"]) expect(all).toContain(c);
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b/);
  });
});

describe("Ecrã: erro ≠ vazio, Enter no telemóvel, automação com interruptor", () => {
  const page = src("client/src/pages/WhatsAppInboxPage.tsx");
  it("lista, conversa e respostas rápidas dizem quando a leitura falha", () => {
    expect(page).toContain('what="as conversas"');
    expect(page).toContain('what="esta conversa"');
    expect(page).toContain("Não foi possível carregar as respostas rápidas.");
    expect(page).toContain('"Não foi possível carregar a conversa."');
    expect(src("client/src/components/whatsapp/WhatsAppContextSheet.tsx")).toContain('what="as reservas"');
  });
  it("cada envio leva o seu código; repetir o mesmo texto reutiliza-o", () => {
    expect(page).toContain("const clientRequestId = prev && prev.text === body ? prev.id : newRequestId();");
    expect(page).toContain("clientRequestId: tplReqId,");
  });
  it("no telemóvel Enter muda de linha; o texto previsivo não envia", () => {
    expect(page).toContain("if (isMobile || COARSE_POINTER) return;");
    expect(page).toContain("!e.nativeEvent.isComposing");
  });
  it("respostas automáticas de disponibilidade respeitam EXTRAS_AUTOMATION (lido fresco no webhook)", () => {
    const auto = src("server/extrasAutomation.ts");
    const fn = auto.slice(auto.indexOf("export async function handleWhatsappReply"));
    expect(fn.indexOf('isFeatureEnabled("EXTRAS_AUTOMATION")')).toBeGreaterThan(-1);
    expect(fn.indexOf("await ensureFeatureFlagOverrides();")).toBeLessThan(fn.indexOf("latestRequestFor("));
  });
  it("a ajuda não promete 'nada é enviado sozinho' e explica 'sem confirmação'", () => {
    const doc = src("docs/ajuda/whatsapp.md");
    expect(doc).not.toContain("Nada é enviado sozinho");
    expect(doc).toContain("Sem confirmação da Meta");
  });
});
