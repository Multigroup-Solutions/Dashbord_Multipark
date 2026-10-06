/**
 * P3 lote 33a — Google Business pela Windsor (Jorge, 6 out 2026): "consigo ir
 * buscar os dados do Business da Google através da Windsor para que me ponha
 * e responda através da dashboard?"
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  groupWindsorReviews, replyChannel, replyViaWindsor, reviewsToImport, scrubWindsor, windsorAction, windsorGet,
  windsorLocationOf, windsorReadUrl, windsorReviewToGoogle, windsorSyncWindow,
} from "./integrations/googleBusiness/windsor";
import { AUTOMATION_FLAGS, automationFlagDefault } from "../shared/appSettings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const KEY = "wsk_teste_1234567890abcdef";
afterEach(() => { vi.unstubAllEnvs(); });

// Linha como a Windsor devolve (formato confirmado no conector google_my_business)
const ROW = {
  location_id: "locations/6374026062832460440", google_account_id: "accounts/115405252230799996333",
  review_id: "AbFvOqnOpCW7A6CfaAUlunCjX3QuMwJPI15TiCBnOPcvVjdtl5yvjuA6OPeXTuhgpkOOud38CEGPBg",
  review_star_rating: "ONE", review_create_time: "2026-10-01T18:48:34.880800Z", review_update_time: "2026-10-05T10:57:56.232448Z",
  review_reviewer: "Cliente Teste", review_comment: "Demoraram muito", review_reply_comment: null, review_reply_update_time: null,
};

describe("33a — da Windsor para a forma da API da Google", () => {
  it("avaliação: estrelas, datas, autor, texto e resposta", () => {
    expect(windsorReviewToGoogle(ROW)).toEqual({
      reviewId: ROW.review_id, starRating: "ONE", createTime: "2026-10-01T18:48:34.880Z", updateTime: "2026-10-05T10:57:56.232Z",
      reviewer: { displayName: "Cliente Teste" }, comment: "Demoraram muito",
    });
    expect(windsorReviewToGoogle({ ...ROW, review_star_rating: 4, review_update_time: null, review_create_time: "2026-09-01 10:00:00",
      review_reply_comment: "Obrigado!", review_reply_update_time: "2026-09-02 08:00:00" }))
      .toMatchObject({ starRating: "FOUR", createTime: "2026-09-01T10:00:00.000Z", updateTime: "2026-09-01T10:00:00.000Z",
        reviewReply: { comment: "Obrigado!", updateTime: "2026-09-02T08:00:00.000Z" } });
    // nome completo do recurso também serve
    expect(windsorReviewToGoogle({ ...ROW, review_id: "accounts/1/locations/2/reviews/AbC_-9" })?.reviewId).toBe("AbC_-9");
    // perfis sem avaliações vêm com review_id vazio; ids estranhos e estrelas inválidas ficam de fora
    expect(windsorReviewToGoogle({ ...ROW, review_id: null })).toBeNull();
    expect(windsorReviewToGoogle({ ...ROW, review_id: "../x" })).toBeNull();
    expect(windsorReviewToGoogle({ ...ROW, review_star_rating: "SIX" })).toBeNull();
  });

  it("perfil: precisa do local e da conta Google (senão não se podia responder)", () => {
    expect(windsorLocationOf({ location_id: "locations/1", google_account_id: "accounts/9", location_title: "Airpark Porto",
      location_address_lines: ["Rua A, 1"], location_address_postal_code: "4455-000", location_address_locality: "Perafita",
      location_metadata_has_voice_of_merchant: true, location_open_info_status: "OPEN" }))
      .toMatchObject({ locationName: "locations/1", accountName: "accounts/9", title: "Airpark Porto", address: "Rua A, 1, 4455-000, Perafita",
        meta: { hasVoiceOfMerchant: 1, openStatus: "OPEN", hasPendingEdits: null } });
    expect(windsorLocationOf({ location_id: "locations/1", google_account_id: null })).toBeNull();
    expect(windsorLocationOf({ location_id: "x/1", google_account_id: "accounts/9" })).toBeNull();
  });

  it("agrupa por perfil, sem repetidas (fica a mais recente) e as mais antigas primeiro", () => {
    const older = { ...ROW, review_id: "A1", review_update_time: "2026-09-01T00:00:00Z", review_create_time: "2026-09-01T00:00:00Z" };
    const g = groupWindsorReviews([ROW, older, { ...ROW, review_update_time: "2026-10-04T00:00:00Z" }, { ...ROW, review_id: null }, { ...ROW, location_id: "bad" }]);
    expect([...g.keys()]).toEqual([ROW.location_id]);
    expect(g.get(ROW.location_id)!.map((r) => [r.reviewId, r.updateTime])).toEqual([["A1", "2026-09-01T00:00:00.000Z"], [ROW.review_id, "2026-10-05T10:57:56.232Z"]]);
  });

  it("janela: 1.ª importação até 3 anos; depois 60 dias", () => {
    const nowMs = Date.parse("2026-10-06T12:00:00Z");
    expect(windsorSyncWindow({ firstImport: true, nowMs })).toEqual({ dateFrom: "2023-10-07", dateTo: "2026-10-06" });
    expect(windsorSyncWindow({ firstImport: false, nowMs })).toEqual({ dateFrom: "2026-08-07", dateTo: "2026-10-06" });
  });

  it("só passa ao importReview o que mudou (e, fora da 1.ª vez, o que mexeu nos últimos 60 dias)", () => {
    const nowMs = Date.parse("2026-10-06T12:00:00Z");
    const fresh = windsorReviewToGoogle(ROW)!;
    const old = windsorReviewToGoogle({ ...ROW, review_id: "OLD", review_create_time: "2025-01-01T00:00:00Z", review_update_time: "2025-01-01T00:00:00Z" })!;
    const oldNewReply = { ...old, reviewId: "OLD2", reviewReply: { comment: "Obrigado", updateTime: "2026-10-01T00:00:00.000Z" } };
    const same = new Map([[fresh.reviewId, { updatedAt: "2026-10-05T10:57:56.232Z", reply: null }]]);
    expect(reviewsToImport([fresh, old, oldNewReply], { firstImport: false, nowMs, existing: new Map() }).map((r) => r.reviewId)).toEqual([fresh.reviewId, "OLD2"]);
    expect(reviewsToImport([fresh, old], { firstImport: true, nowMs, existing: same }).map((r) => r.reviewId)).toEqual(["OLD"]);
    // a resposta mudou cá fora → volta a passar
    expect(reviewsToImport([{ ...fresh, reviewReply: { comment: "Lamentamos" } }], { firstImport: false, nowMs, existing: same })).toHaveLength(1);
  });

  it("canal da resposta: Google direto manda; senão Windsor só com chave e interruptor", () => {
    expect(replyChannel({ oauthConnected: true, windsorConfigured: true, windsorReplyOn: true })).toBe("google");
    expect(replyChannel({ oauthConnected: false, windsorConfigured: true, windsorReplyOn: true })).toBe("windsor");
    expect(replyChannel({ oauthConnected: false, windsorConfigured: true, windsorReplyOn: false })).toBe("none");
    expect(replyChannel({ oauthConnected: false, windsorConfigured: false, windsorReplyOn: true })).toBe("none");
  });
});

describe("33a — REST da Windsor (a chave nunca aparece)", () => {
  it("URL de leitura: campos, datas, perfis e a chave só na query", () => {
    const u = new URL(windsorReadUrl({ key: KEY, fields: ["location_id", "review_id"], dateFrom: "2026-08-07", dateTo: "2026-10-06", accounts: ["locations/1", "locations/2"] }));
    expect(u.origin + u.pathname).toBe("https://connectors.windsor.ai/google_my_business");
    expect(u.searchParams.get("fields")).toBe("location_id,review_id");
    expect(u.searchParams.get("select_accounts")).toBe("locations/1,locations/2");
    expect(u.searchParams.get("_renderer")).toBe("json");
    expect(u.searchParams.get("api_key")).toBe(KEY);
    expect(scrubWindsor(`falhou ${u.toString()} com ${KEY}`, KEY)).not.toContain(KEY);
  });

  it("leitura: devolve as linhas de {data}; erros sem a chave; 'pending' é dito como tal", async () => {
    vi.stubEnv("WINDSOR_API_KEY", KEY);
    const ok = vi.fn(async () => new Response(JSON.stringify({ data: [ROW, null, 3] }), { status: 200 }));
    expect(await windsorGet({ fields: ["review_id"] }, ok)).toEqual([ROW]);
    const echo = vi.fn(async (url: string) => new Response(JSON.stringify({ error: `bad request ${url}` }), { status: 400 }));
    const e1 = await windsorGet({ fields: ["review_id"] }, echo).catch((e) => e as Error);
    expect(String(e1)).toMatch(/Windsor: erro 400/);
    expect(String(e1)).not.toContain(KEY);
    const denied = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(windsorGet({ fields: ["review_id"] }, denied)).rejects.toThrow(/recusou a chave/);
    const pending = vi.fn(async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    await expect(windsorGet({ fields: ["review_id"] }, pending)).rejects.toThrow(/próxima recolha/);
    vi.stubEnv("WINDSOR_API_KEY", "");
    await expect(windsorGet({ fields: ["review_id"] }, ok)).rejects.toThrow(/WINDSOR_API_KEY/);
  });

  it("responder: POST /actions com {account: locations/N, action, params} e erros claros", async () => {
    vi.stubEnv("WINDSOR_API_KEY", KEY);
    const calls: any[] = [];
    const ok = vi.fn(async (url: string, init: any) => { calls.push([url, init]); return new Response(JSON.stringify({ result: "ok" }), { status: 200 }); });
    const r = await replyViaWindsor("accounts/115/locations/6374/reviews/AbC_-9", "  Obrigado pela visita!  ", ok);
    expect(r.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const [url, init] = calls[0];
    expect(url.split("?")[0]).toBe("https://connectors.windsor.ai/google_my_business/actions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ account: "locations/6374", action: "reply_to_review", params: { review_id: "AbC_-9", comment: "Obrigado pela visita!" } });
    expect(init.body).not.toContain(KEY);
    const forbidden = vi.fn(async () => new Response(JSON.stringify({ detail: "write actions disabled" }), { status: 403 }));
    await expect(windsorAction("locations/1", "reply_to_review", { review_id: "x", comment: "y" }, forbidden)).rejects.toThrow(/ações de escrita/);
    const failed = vi.fn(async () => new Response(JSON.stringify({ status: "error", message: `quota ${KEY}` }), { status: 200 }));
    const e = await windsorAction("locations/1", "reply_to_review", { review_id: "x", comment: "y" }, failed).catch((x) => x as Error);
    expect(String(e)).toMatch(/Windsor: quota/);
    expect(String(e)).not.toContain(KEY);
    await expect(replyViaWindsor("accounts/1/locations/2/reviews/../x", "Olá", ok)).rejects.toThrow(/sem ligação/);
    await expect(windsorAction("accounts/1", "reply_to_review", {}, ok)).rejects.toThrow(/Perfil Google inválido/);
  });
});

describe("33a — interruptores, cron, rotas e ecrã", () => {
  it("os dois interruptores entram desligados", () => {
    for (const n of ["GBP_WINDSOR_SYNC", "GBP_WINDSOR_REPLY"]) {
      expect(AUTOMATION_FLAGS.some((f) => f.name === n)).toBe(true);
      expect(automationFlagDefault(n)).toBe(false);
    }
  });

  it("cron: a Windsor só entra quando a Google não está ligada; publicar escolhe o canal", () => {
    const routes = src("server/integrations/googleBusiness/routes.ts");
    expect(routes).toMatch(/reviews\?\.skipped === 'disconnected' \|\| reviews\?\.skipped === 'reauth_required'\) \{[\s\S]{0,200}syncReviewsFromWindsor/);
    const w = src("server/integrations/googleBusiness/windsor.ts");
    expect(w).toContain("if (await oauthConnected()) return { ok: true, skipped: 'oauth'");
    expect(w).toContain("if (!o.manual && !(await windsorFlagOn('GBP_WINDSOR_SYNC')))");
    // perfis: só acrescenta/atualiza; nunca desativa
    expect(w).not.toMatch(/SET available = 0/);
    expect(w).not.toMatch(/DELETE FROM/);
    const service = src("server/integrations/googleBusiness/service.ts");
    expect(service).toContain("windsorReplyOn: w.windsorConfigured() && await w.windsorFlagOn('GBP_WINDSOR_REPLY')");
  });

  it("rotas manuais só para admin (integrações) e o painel mostra a secção", () => {
    const r = src("server/integrations/googleBusiness/router.ts");
    expect(r).toMatch(/discoverWindsor: admin\.mutation/);
    expect(r).toMatch(/syncWindsor: admin\.mutation/);
    expect(r).toContain("windsor: await windsorStatus()");
    const ui = src("client/src/components/GoogleBusinessConnection.tsx");
    expect(ui).toContain('data-testid="gbp-windsor"');
    expect(ui).toContain("Ir buscar os perfis à Windsor");
    expect(ui).toContain("Importar avaliações pela Windsor");
  });
});
