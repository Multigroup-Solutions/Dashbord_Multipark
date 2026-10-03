/**
 * P3 lote 25c — decisões do Jorge (3 out 2026):
 *  - D50: Ocorrência crítica + A trabalhar sem PDA/Zello obrigatórias, mas só
 *    com um interruptor (desligado);
 *  - D51: desligar uma integração avisa os admins e o super admin;
 *  - D52: interruptor do push do Google Business;
 *  - D53: a chave de API de quem ficou inativo deixa de funcionar;
 *  - D57: cron que salta há dias por falta de configuração = problema;
 *  - D59: separador Caixa nos Logs;
 *  - D61: num PDA, o login da Google pede para escolher a conta.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CRITICAL_ALERTS_MANDATORY_FLAG, kindDef, parseNotificationPrefs, resolveRecipients, routingTable, type RoutingCandidate,
} from "../shared/notificationRouting";
import { AUTOMATION_FLAGS, cronSkipProblem, isProblemSkip } from "../shared/appSettings";
import { notifyWith, type NotifyDeps } from "./notify";
import { disconnectNoticeText, notifyIntegrationDisconnectedWith } from "./integrationDisconnectNotify";
import { checkPresentedKey, creatorStillActive, hashApiKey, type ApiKeyRow } from "./apiKeyAuth";
import { caseEventDetail, mergeCashLogs, type CashLogRow } from "./cashLogs";
import { googlePromptFor, loginUrlForDevice, loginUrlWithReturn } from "../shared/loginReturn";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const flag = (name: string) => AUTOMATION_FLAGS.find((f) => f.name === name);

describe("D50 — obrigatórias com interruptor", () => {
  const tl = (muted: string[]): RoutingCandidate => ({ id: 7, role: "team_leader", isActive: true, cities: ["lisbon"], prefs: { muted, email: {} } } as any);

  it("os dois tipos ficam presos ao interruptor (desligado por omissão); os silêncios guardados não se perdem", () => {
    expect(CRITICAL_ALERTS_MANDATORY_FLAG).toBe("NOTIFY_CRITICAL_MANDATORY");
    for (const k of ["incident_critical", "ops_presence"]) {
      expect(kindDef(k)).toMatchObject({ mandatoryFlag: CRITICAL_ALERTS_MANDATORY_FLAG });
      expect(kindDef(k)?.mandatory).toBeFalsy();
    }
    expect(flag("NOTIFY_CRITICAL_MANDATORY")?.defaultEnabled).toBe(false);
    // a escolha da pessoa fica gravada (volta quando se desliga o interruptor)
    expect(parseNotificationPrefs({ muted: ["incident_critical", "ops_presence"] }).muted).toEqual(["incident_critical", "ops_presence"]);
    expect(routingTable().find((r) => r.kind === "incident_critical")).toMatchObject({ mandatory: false, mandatoryFlag: CRITICAL_ALERTS_MANDATORY_FLAG });
  });

  it("interruptor ligado → chega a quem silenciou; desligado → respeita o silêncio; outros tipos nunca", () => {
    const c = tl(["incident_critical", "lost_found_new"]);
    expect(resolveRecipients({ kind: "incident_critical", city: "lisbon" }, [c])).toEqual([]);
    expect(resolveRecipients({ kind: "incident_critical", city: "lisbon", forceMandatory: true }, [c]).map((r) => r.userId)).toEqual([7]);
    expect(resolveRecipients({ kind: "lost_found_new", city: "lisbon", forceMandatory: true }, [c])).toEqual([]);
    const p = tl(["ops_presence"]);
    expect(resolveRecipients({ kind: "ops_presence", city: "lisbon", targetUserIds: [7], forceMandatory: true }, [p]).map((r) => r.userId)).toEqual([7]);
  });

  it("notify lê o interruptor só nos tipos com interruptor; falha a ler = desligado", async () => {
    const base = (flagOn: NotifyDeps["flagOn"]) => {
      const insert = vi.fn(async () => undefined);
      const deps: NotifyDeps = {
        loadCandidates: async () => [tl(["incident_critical"])], loadRouting: async () => ({ roles: {}, kinds: {}, homeCityOnly: [] } as any),
        cityOfProject: async () => "lisbon", projectOfEmployee: async () => null, recentRecipients: async () => new Set(),
        insert, emailOf: () => null, sendEmail: async () => false, flagOn,
      };
      return { deps, insert };
    };
    const on = base(async () => true);
    expect((await notifyWith(on.deps, { kind: "incident_critical", city: "lisbon", title: "x" })).recipients).toEqual([7]);
    const off = base(async () => false);
    expect((await notifyWith(off.deps, { kind: "incident_critical", city: "lisbon", title: "x" })).recipients).toEqual([]);
    const broken = base(async () => { throw new Error("bd"); });
    expect((await notifyWith(broken.deps, { kind: "incident_critical", city: "lisbon", title: "x" })).recipients).toEqual([]);
  });

  it("o Perfil tranca o que o interruptor tornou obrigatório", () => {
    expect(src("client/src/pages/ProfilePage.tsx")).toContain("(data?.forcedMandatory ?? []).includes(k.kind)");
    expect(src("server/routers.ts")).toContain("forcedMandatory: await forcedMandatoryKinds()");
  });
});

describe("D51 — desligar uma integração avisa", () => {
  it("aviso aos admins/super admin, nunca a quem desligou; atrás do interruptor (desligado)", async () => {
    expect(flag("INTEGRATION_DISCONNECT_NOTIFY")?.defaultEnabled).toBe(false);
    const notify = vi.fn(async (_n: Record<string, any>) => undefined);
    expect(await notifyIntegrationDisconnectedWith({ flagOn: async () => false, notify }, { integration: "Google Ads", byUserId: 1 })).toBe("flag_off");
    expect(notify).not.toHaveBeenCalled();
    expect(await notifyIntegrationDisconnectedWith({ flagOn: async () => true, notify }, { integration: "Google Ads", byUserId: 1, byName: "Jorge", accountEmail: "ads@x.pt", nowMs: 5 })).toBe("notified");
    const n = notify.mock.calls[0][0];
    expect(n).toMatchObject({ kind: "integration_alert", title: "Google Ads foi desligado", link: "/integracoes", entity: { type: "integration_disconnect", id: "Google Ads:5" } });
    expect(n.recipientFilter({ id: 1 })).toBe(false);
    expect(n.recipientFilter({ id: 2 })).toBe(true);
    expect(disconnectNoticeText({ integration: "Google Business", byUserId: 3, revoked: false }).body).toContain("não foi possível revogar");
    expect(kindDef("integration_alert")?.roles).toEqual([]); // admin (pela matriz) + super admin
  });
  it("ligado nos dois 'desligar'", () => {
    expect(src("server/integrations/googleBusiness/router.ts")).toContain("notifyIntegrationDisconnected({ integration: 'Google Business'");
    expect(src("server/integrations/googleAds/router.ts")).toContain('notifyIntegrationDisconnected({ integration: "Google Ads"');
  });
});

describe("D52 — push do Google Business", () => {
  it("interruptor (ligado por omissão: era assim); desligado confirma sem marcar nada", () => {
    expect(flag("GBP_PUSH")).toBeTruthy();
    expect(flag("GBP_PUSH")?.defaultEnabled).not.toBe(false);
    const r = src("server/integrations/googleBusiness/routes.ts");
    const hook = r.slice(r.indexOf("google-business/webhook"));
    expect(hook.indexOf("verifyPush")).toBeLessThan(hook.indexOf("gbpPushOn()"));
    expect(hook).toContain("if (!(await gbpPushOn())) { res.status(204).end(); return; }");
  });
});

describe("D53 — chave de quem ficou inativo", () => {
  const row = (over: Partial<ApiKeyRow> = {}): ApiKeyRow => ({ id: 1, name: "Site", keyPrefix: "mp_ab", permissions: "[]", active: 1, expiresAt: null, lastUsedAt: null, createdById: 5, revokedAt: null, ...over });
  it("criador inativo → a mesma resposta 403; ativo ou sem autor → funciona", async () => {
    const key = "mp_" + "a".repeat(40);
    const lookup = (r: ApiKeyRow) => async (h: string) => (h === hashApiKey(key) ? r : null);
    expect(await checkPresentedKey(key, lookup(row({ creatorActive: false })))).toEqual({ ok: false, status: 403, error: "Invalid or inactive API key" });
    expect((await checkPresentedKey(key, lookup(row({ creatorActive: true })))).ok).toBe(true);
    expect((await checkPresentedKey(key, lookup(row({ createdById: null })))).ok).toBe(true);
  });
  it("conta junta a outra → conta a que ficou; conta que não existe → inativa; sem ciclos", async () => {
    const users: Record<number, { isActive: unknown; loginMethod?: string | null }> = {
      5: { isActive: 0, loginMethod: "merged_into_9" }, 9: { isActive: 1 }, 6: { isActive: 0, loginMethod: "google" },
      7: { isActive: 0, loginMethod: "merged_into_8" }, 8: { isActive: 0, loginMethod: "merged_into_7" }, 10: { isActive: true },
    };
    const load = async (id: number) => users[id] ?? null;
    expect(await creatorStillActive(5, load)).toBe(true);
    expect(await creatorStillActive(10, load)).toBe(true);
    expect(await creatorStillActive(6, load)).toBe(false);
    expect(await creatorStillActive(404, load)).toBe(false);
    expect(await creatorStillActive(7, load)).toBe(false);
  });
  it("a lista diz porquê", () => {
    expect(src("server/apiKeysRouter.ts")).toContain("creatorActive: k.createdById == null ? true : await creatorActive(k.createdById)");
    expect(src("client/src/pages/ApiKeysPage.tsx")).toContain("Criador inativo");
  });
});

describe("D57 — salta há dias = problema", () => {
  const day = 86_400_000, now = 100 * day;
  it("só saltos por falta de configuração/ligação contam; interruptor desligado não", () => {
    for (const n of ["saltado: zello_not_configured", "saltado: DATABASE_URL_MULTIPARK não está definida", "saltado: not_connected — Google Ads não está ligado", "saltado: disconnected", "saltado: reauth_required"]) expect(isProblemSkip(n)).toBe(true);
    for (const n of ["saltado: disabled", "saltado: CRM_AUTO_MERGE desligado", "saltado: fora de horas", "saltado: locked", "saltado: sim — IA desligada ou não configurada.", "not_configured", null]) expect(isProblemSkip(n)).toBe(false);
  });
  it("> 2 dias sem trabalho feito (desde o último OK, ou desde a 1.ª corrida)", () => {
    const last = { ok: true, error: "saltado: zello_not_configured" };
    expect(cronSkipProblem(last, now - 3 * day, null, now)).toBe(true);
    expect(cronSkipProblem(last, now - 1 * day, null, now)).toBe(false);
    expect(cronSkipProblem(last, null, now - 3 * day, now)).toBe(true);
    expect(cronSkipProblem(last, null, now - day, now)).toBe(false);
    expect(cronSkipProblem({ ok: true, error: null }, null, now - 9 * day, now)).toBe(false);
    expect(cronSkipProblem({ ok: false, error: "saltado: zello_not_configured" }, null, now - 9 * day, now)).toBe(false);
  });
  it("Estado conta como problema", () => {
    expect(src("server/cronRuns.ts")).toContain('health0 === "ok" && cronSkipProblem(last, okAt, firstAt.get(name) ?? null, now) ? "skipping" : health0');
    const p = src("client/src/pages/DefinicoesPage.tsx");
    expect(p).toContain('skipping: { label: "Salta há dias"');
    expect(p).toContain('c.health === "failed" || c.health === "stale" || c.health === "skipping"');
  });
});

describe("D59 — separador Caixa nos Logs", () => {
  it("junta as tabelas da caixa, mais recente primeiro, pesquisa no texto", () => {
    const r = (key: string, at: string, detail: string): CashLogRow => ({ key, at, userId: null, userName: null, kind: "case", action: "x", detail, parkId: "P1", day: null });
    const out = mergeCashLogs([[r("a", "2026-10-01 10:00:00", "Caso #1")], [r("b", "2026-10-02 09:00:00", "Talão 12,00 €"), r("c", "2026-09-30 08:00:00", "Contagem #3")]], undefined, 2);
    expect(out.map((x) => x.key)).toEqual(["b", "a"]);
    expect(mergeCashLogs([[r("a", "2026-10-01 10:00:00", "Caso #1"), r("b", "2026-10-02 09:00:00", "Talão 12,00 €")]], "talão", 10).map((x) => x.key)).toEqual(["b"]);
    expect(caseEventDetail({ caseId: 4, label: "Multibanco sem talão", action: "resolvido", note: "ok" })).toBe("Caso #4 (Multibanco sem talão): resolvido — ok");
  });
  it("só leitura, sem UNION; pela matriz dos Logs; separador na página", () => {
    const m = src("server/cashLogs.ts");
    expect(m).not.toMatch(/UNION (ALL )?SELECT|INSERT INTO|UPDATE \w+ SET|DELETE FROM|\.delete\(|\.update\(|\.insert\(/i);
    for (const t of ["cash_case_events", "cash_count_log", "cash_mb_receipts", "cash_mb_days", "cash_viva_imports", "cash_monthly_receipts"]) expect(m).toContain(t);
    const r = src("server/routers.ts");
    const route = r.slice(r.indexOf("cash: protectedProcedure"), r.indexOf("cash: protectedProcedure") + 900);
    expect(route).toContain('requireAccess(ctx.user, "logs", "view");');
    expect(src("client/src/pages/LogsPage.tsx")).toContain('<TabsTrigger value="caixa">Caixa</TabsTrigger>');
  });
});

describe("D61 — PDA escolhe a conta Google", () => {
  it("o link de login leva pda=1 num PDA; o pedido à Google pede para escolher a conta", () => {
    expect(loginUrlForDevice(loginUrlWithReturn(), true)).toBe("/api/oauth/login?pda=1");
    expect(loginUrlForDevice(loginUrlWithReturn("/rh"), true)).toBe("/api/oauth/login?next=%2Frh&pda=1");
    expect(loginUrlForDevice(loginUrlWithReturn("/rh"), false)).toBe("/api/oauth/login?next=%2Frh");
    expect(googlePromptFor("1")).toBe("consent select_account");
    expect(googlePromptFor(undefined)).toBe("consent");
    expect(googlePromptFor(["1"])).toBe("consent");
    expect(src("server/_core/oauth.ts")).toContain('url.searchParams.set("prompt", googlePromptFor(req.query.pda));');
    expect(src("client/src/const.ts")).toContain("loginUrlForDevice(loginUrlWithReturn(returnTo), !!getPdaToken())");
  });
});
