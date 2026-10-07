/**
 * Lote 39a — Central Vodafone (Jorge, 6 out 2026: "avança com o Sugar"): a
 * dashboard faz de "Sugar CRM" para a One Net Attendant Console registar as
 * chamadas, em nome de quem as atendeu ou fez.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import express from "express";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callContactRef, contactRedirect, extractPhone, flattenNameValueList, normalizeCentralUsername, parseContactRef, parseSugarCall, parseSugarDate, phoneFromSearchNote,
  redactForLog, searchNote, sugarSearchPhone,
} from "../shared/centralSugar";

const h = vi.hoisted(() => ({ enabled: true, enableOnRefresh: false, forced: 0, stored: undefined as boolean | undefined, queries: [] as Array<{ sql: string; params: unknown[] }>, calls: [] as unknown[][] }));
const dialect = new MySqlDialect();
vi.mock("./_core/env", () => ({ ENV: { cookieSecret: "segredo-so-para-testes" } }));
// 39c: o valor gravado nas Automações (lido direto quando a cache diz "desligado")
vi.mock("./appSettings", () => ({ loadFeatureFlagOverrides: async () => new Map(h.stored === undefined ? [] : [["CENTRAL_SUGAR", h.stored]]) }));
vi.mock("./_core/featureFlags", () => ({
  // 39b: com "force" relê a BD (aqui: o interruptor acabou de ser ligado noutra instância)
  ensureFeatureFlagOverrides: async (force?: boolean) => { if (force) { h.forced++; if (h.enableOnRefresh) h.enabled = true; } },
  isFeatureEnabled: () => h.enabled,
}));
const SECRET = "SegredoDaConsola123";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const STORED = createHash("sha256").update(md5(SECRET)).digest("hex");
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const { sql, params } = dialect.sqlToQuery(q);
      h.queries.push({ sql, params });
      if (/FROM central_accounts a/.test(sql) && /a\.username = \?/.test(sql)) return [params[0] === "ana.silva" ? [{ id: 7, userId: 12, username: "ana.silva", secretHash: STORED, name: "Ana Silva" }] : []];
      if (/FROM central_accounts a/.test(sql) && /a\.id = \?/.test(sql)) return [params[0] === 7 ? [{ id: 7, userId: 12, username: "ana.silva", name: "Ana Silva" }] : []];
      if (/INSERT INTO central_calls/.test(sql)) { h.calls.push(params); return [{ affectedRows: 1 }]; }
      // 39d: quem liga — equipa (RH) pelo fim do número, ficha do CRM pelo E.164
      if (/FROM employees/.test(sql) && /REGEXP_REPLACE/.test(sql)) return [params.includes("934000000") ? [{ id: 7, fullName: "Rui Condutor", position: "driver", email: null }] : []];
      if (/FROM crm_client_phones cp JOIN crm_clients c/.test(sql)) return [params[0] === "+351913225918" ? [{ id: 55, displayName: "Maria Cliente", primaryEmail: "maria@ex.pt", isPro: 1, bookings: 12 }] : []];
      if (/SELECT phone FROM crm_client_phones WHERE clientId/.test(sql)) return [params[0] === 55 ? [{ phone: "+351913225918" }] : []];
      // 39e: a última pesquisa desta conta que deu o contacto (o LIKE sobre a nota do registo)
      if (/SELECT note FROM central_requests/.test(sql)) {
        const [acc, , like] = params as [number, string, string];
        const re = new RegExp(`^${String(like).split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
        const hit = h.queries.filter((x) => /INSERT INTO central_requests/.test(x.sql) && x.params[4] === acc && re.test(String(x.params[5]))).at(-1);
        return [hit ? [{ note: hit.params[5] }] : []];
      }
      return [[]];
    },
  }),
}));

import { createCentralSugarRouter, hashCentralSecret, signCentralToken, verifyCentralToken } from "./centralSugar";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("39a — regras puras", () => {
  it("lê a chamada do Sugar: direção, atendida ou não, hora com fuso, duração e o telefone", () => {
    const now = Date.UTC(2026, 9, 6, 12);
    const a = parseSugarCall({ name: "Chamada de +351 912 345 678", direction: "Inbound", status: "Held", date_start: "2026-10-06T22:10:00+01:00", duration_hours: 0, duration_minutes: 3 }, now);
    expect(a).toMatchObject({ direction: "in", held: true, startedAtMs: Date.UTC(2026, 9, 6, 21, 10), durationS: 180, phone: "+351912345678" });
    const b = parseSugarCall({ Name: "Outbound call 21 000 0000", Status: "Not Held", date_start: "2026-10-06 09:00:00" }, now);
    expect(b).toMatchObject({ direction: "out", held: false, startedAtMs: Date.UTC(2026, 9, 6, 9), durationS: null, phone: "210000000" });
    expect(parseSugarCall({}, now)).toMatchObject({ direction: "in", held: true, startedAtMs: now, phone: null });
    expect(parseSugarDate("lixo")).toBeNull();
    expect(extractPhone("ext 12", "sem número")).toBeNull();
  });

  it("v4_1: name_value_list em lista ou em objeto", () => {
    expect(flattenNameValueList([{ name: "direction", value: "Outbound" }, { name: "name", value: "x" }])).toEqual({ direction: "Outbound", name: "x" });
    expect(flattenNameValueList({ direction: { name: "direction", value: "Inbound" } })).toEqual({ direction: "Inbound" });
  });

  it("o registo dos pedidos nunca guarda segredos (nem dentro do rest_data da v4_1)", () => {
    const s = redactForLog({ username: "ana", password: "x1", body: { refresh_token: "t", client_secret: "c" }, rest_data: JSON.stringify({ user_auth: { user_name: "ana", password: "abc" } }) })!;
    expect(s).not.toMatch(/x1|"t"|"c"|abc/);
    expect(s).toContain("ana");
    expect(redactForLog({})).toBeNull();
  });

  it("utilizador, segredo (texto e md5 dão o mesmo) e tokens assinados", () => {
    expect(normalizeCentralUsername(" Ana.Silva ")).toBe("ana.silva");
    expect(normalizeCentralUsername("a")).toBeNull();
    expect(normalizeCentralUsername("ana silva")).toBeNull();
    expect(hashCentralSecret(SECRET)).toBe(STORED);
    expect(hashCentralSecret(md5(SECRET), true)).toBe(STORED);
    const key = Buffer.alloc(32, 1);
    const now = 1_000_000;
    const t = signCentralToken(7, "a", now + 1000, key);
    expect(verifyCentralToken(t, "a", now, key)).toBe(7);
    expect(verifyCentralToken(t, "r", now, key)).toBeNull(); // um token de acesso não serve de refresh
    expect(verifyCentralToken(t, "a", now + 2000, key)).toBeNull(); // expirado
    expect(verifyCentralToken(t.replace(".7.", ".8."), "a", now, key)).toBeNull(); // mexido
    expect(verifyCentralToken(t, "a", now, Buffer.alloc(32, 2))).toBeNull(); // outra chave
  });
});

describe("39d — regras de quem liga", () => {
  it("o número da pesquisa da consola, as referências de contacto e para onde abre", () => {
    expect(sugarSearchPhone({ fields: "id,full_name", max_num: 1, q: "*+351913225918*" })).toBe("+351913225918");
    expect(sugarSearchPhone({ filter: [{ $or: [{ phone_work: { $contains: "913 225 918" } }] }] })).toBe("913225918");
    expect(sugarSearchPhone({ max_num: 1 })).toBeNull();
    expect(parseContactRef("crm-55")).toEqual({ kind: "crm", id: "55" });
    expect(parseContactRef("tel-351913225918")).toEqual({ kind: "tel", id: "351913225918" });
    expect(parseContactRef("x-1")).toBeNull();
    expect(callContactRef({ parent_type: "Contacts", parent_id: "crm-55" })).toBe("crm-55");
    expect(callContactRef({ contacts: { add: [{ id: "emp-7" }] } })).toBe("emp-7");
    expect(callContactRef({ parent_id: "abc" })).toBeNull();
    expect(contactRedirect("#Contacts/crm-55")).toBe("/clientes/55");
    expect(contactRedirect("#Contacts/emp-7")).toBe("/rh");
    expect(contactRedirect("#Contacts/tel-351913225918")).toBe("/clientes?q=%2B351913225918");
    expect(contactRedirect("#Calls/1")).toBe("/");
  });
});

describe("39e — o número e a duração da chamada", () => {
  it("o número sai da nota da pesquisa que deu esse contacto", () => {
    const n = searchNote("935625800", "emp-1", "Jorge Tabuada");
    expect(n).toBe("pesquisa 935625800 → emp-1 Jorge Tabuada");
    expect(phoneFromSearchNote(n, "emp-1")).toBe("935625800");
    expect(phoneFromSearchNote(searchNote("+351913225918", "crm-55", "Maria"), "crm-55")).toBe("+351913225918");
    expect(phoneFromSearchNote(n, "emp-12")).toBeNull(); // outro contacto
    expect(phoneFromSearchNote("sem tratamento (resposta vazia)", "emp-1")).toBeNull();
    expect(phoneFromSearchNote(n, "x-1")).toBeNull();
  });

  it("a consola manda só minutos: \"0\" é menos de 1 min (0), sem campo continua sem dado", () => {
    const now = Date.UTC(2026, 9, 7);
    expect(parseSugarCall({ direction: "Outbound", status: "Held", duration_minutes: "0" }, now).durationS).toBe(0);
    expect(parseSugarCall({ direction: "Outbound", status: "Held", duration_hours: "1", duration_minutes: "5" }, now).durationS).toBe(3900);
    expect(parseSugarCall({ direction: "Outbound", status: "Held", duration_minutes: "" }, now).durationS).toBeNull();
    expect(parseSugarCall({ direction: "Outbound", status: "Held" }, now).durationS).toBeNull();
  });
});

describe("39a — a porta Sugar (HTTP)", () => {
  let server: Server;
  let url: string;
  beforeEach(async () => {
    h.enabled = true; h.enableOnRefresh = false; h.forced = 0; h.stored = undefined; h.queries.length = 0; h.calls.length = 0;
    server = createServer(express().use("/api/central/sugar", createCentralSugarRouter()));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/central/sugar`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
  const logged = () => h.queries.filter((q) => /INSERT INTO central_requests/.test(q.sql));

  it("desligada: 503 e só regista que a consola tentou", async () => {
    h.enabled = false;
    const r = await post("/rest/v10/oauth2/token", { grant_type: "password", username: "ana.silva", password: SECRET });
    expect(r.status).toBe(503);
    expect(h.calls).toHaveLength(0);
    expect(logged()).toHaveLength(1);
    expect(JSON.stringify(logged()[0].params)).not.toContain(SECRET);
  });

  it("39c: desligada diz porquê (nada gravado / gravado desligado); gravado ligado manda mesmo com a cache a dizer não", async () => {
    h.enabled = false;
    expect((await fetch(`${url}/rest/v10/ping`)).status).toBe(503);
    expect(logged().at(-1)!.params).toContain("interruptor desligado — nada gravado nas Automações (por omissão desligado)");
    h.stored = false;
    expect((await fetch(`${url}/rest/v10/ping`)).status).toBe(503);
    expect(logged().at(-1)!.params).toContain("interruptor desligado — gravado como desligado nas Automações");
    h.stored = true;
    expect((await fetch(`${url}/rest/v10/ping`)).status).toBe(401); // passou o interruptor; falta o login
  });

  it("39c: CORS — preflight responde 204 com os cabeçalhos; as respostas levam Allow-Origin; regista a origem", async () => {
    const pre = await fetch(`${url}/rest/v10/oauth2/token`, { method: "OPTIONS", headers: { Origin: "https://consola.exemplo", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, oauth-token" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/OAuth-Token/);
    expect(pre.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(logged().at(-1)!.params).toContain("preflight (CORS)");
    const r = await fetch(`${url}/rest/v10/ping`, { headers: { Origin: "https://consola.exemplo" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(String(logged().at(-1)!.params.find((p) => typeof p === "string" && p.startsWith("{")))).toContain('"origin":"https://consola.exemplo"');
  });

  it("39b: acabado de ligar — a cache dizia desligado, a porta confirma na BD e deixa passar", async () => {
    h.enabled = false; h.enableOnRefresh = true;
    const r = await fetch(`${url}/rest/v10/ping`, { headers: { "User-Agent": "OneNetConsole/1.0" } });
    expect(h.forced).toBe(1);
    // sem token: a mesma resposta de um Sugar verdadeiro
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "need_login", error_message: "No valid authentication for user." });
    const last = logged().at(-1)!;
    expect(last.params).toContain("sem token (precisa de login)");
    expect(String(last.params.find((p) => typeof p === "string" && p.startsWith("{")))).toContain('"userAgent":"OneNetConsole/1.0"');
    expect(String(last.params.find((p) => typeof p === "string" && p.startsWith("{")))).toContain('"withCredentials":false');
  });

  it("39b: token mau → invalid_grant; o registo diz que trazia token mas nunca o guarda", async () => {
    const r = await fetch(`${url}/rest/v10/me`, { headers: { "OAuth-Token": "c1.7.a.9999999999999.x.assinatura-falsa" } });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("invalid_grant");
    const body = String(logged().at(-1)!.params.find((p) => typeof p === "string" && p.startsWith("{")));
    expect(body).toContain('"withCredentials":true');
    expect(body).not.toContain("assinatura-falsa");
  });

  it("v10: login, /me e uma chamada registada em nome da pessoa; palavra-passe errada → 401", async () => {
    expect((await post("/rest/v10/oauth2/token", { grant_type: "password", username: "ana.silva", password: "errada" })).status).toBe(401);
    const tok = await (await post("/rest/v10/oauth2/token", { grant_type: "password", username: "Ana.Silva", password: SECRET, client_id: "sugar" })).json();
    expect(tok).toMatchObject({ token_type: "bearer", expires_in: 3600 });
    const me = await (await fetch(`${url}/rest/v10/me`, { headers: { "OAuth-Token": tok.access_token } })).json();
    expect(me.current_user).toMatchObject({ id: "u12", user_name: "ana.silva", full_name: "Ana Silva" });
    const c = await post("/rest/v10/Calls", { name: "Chamada recebida 912345678", direction: "Inbound", status: "Held", date_start: "2026-10-06T10:00:00+01:00", duration_minutes: 2 }, { "OAuth-Token": tok.access_token });
    expect(c.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    const [, accountId, userId, direction, held, startedAt, durationS, phone] = h.calls[0];
    expect({ accountId, userId, direction, held, startedAt, durationS, phone }).toEqual({ accountId: 7, userId: 12, direction: "in", held: 1, startedAt: "2026-10-06 09:00:00", durationS: 120, phone: "912345678" });
    // refresh dá novo acesso; um token de acesso não serve de refresh
    expect((await post("/rest/v10/oauth2/token", { grant_type: "refresh_token", refresh_token: tok.refresh_token })).status).toBe(200);
    expect((await post("/rest/v10/oauth2/token", { grant_type: "refresh_token", refresh_token: tok.access_token })).status).toBe(401);
    // sem token não regista nada
    expect((await post("/rest/v10/Calls", { name: "x" })).status).toBe(401);
    expect(h.calls).toHaveLength(1);
    // módulos que não tratamos (ex.: Meetings): lista vazia, e fica registado o que pediu
    const s = await (await fetch(`${url}/rest/v10/Meetings?max_num=1`, { headers: { "OAuth-Token": tok.access_token } })).json();
    expect(s).toEqual({ next_offset: -1, records: [] });
    expect(logged().some((q) => q.params.includes("sem tratamento (resposta vazia)"))).toBe(true);
    // nenhum pedido registado leva a palavra-passe
    expect(JSON.stringify(logged().map((q) => q.params))).not.toContain(SECRET);
  });

  it("39d: a pesquisa da consola encontra a ficha do CRM, a equipa ou devolve \"Sem ficha\"; a chamada fica ligada ao contacto", async () => {
    const tok = await (await post("/rest/v10/oauth2/token", { grant_type: "password", username: "ana.silva", password: SECRET, client_id: "sugar", platform: "apicalls" })).json();
    const auth = { "OAuth-Token": tok.access_token };
    const q = (num: string) => post("/rest/v10/Contacts/filter", { fields: "id,full_name,title,department,phone_work,email1", max_num: 1, q: `*${num}*` }, auth).then((r) => r.json());
    const cli = await q("+351913225918");
    expect(cli.records).toHaveLength(1);
    expect(cli.records[0]).toMatchObject({ id: "crm-55", _module: "Contacts", full_name: "Maria Cliente", title: "Cliente Pro · 12 reservas", phone_work: "+351913225918", email1: "maria@ex.pt" });
    const emp = await q("+351934000000");
    expect(emp.records[0]).toMatchObject({ id: "emp-7", full_name: "Rui Condutor", title: "Equipa · driver" });
    const none = await q("+351210000001");
    expect(none.records[0]).toMatchObject({ id: "tel-351210000001", full_name: "Sem ficha (+351210000001)" });
    expect(logged().some((x) => x.params.includes("pesquisa +351913225918 → crm-55 Maria Cliente"))).toBe(true);
    // detalhe do contacto
    const det = await (await fetch(`${url}/rest/v10/Contacts/crm-55`, { headers: auth })).json();
    expect(det).toMatchObject({ id: "crm-55", full_name: "Maria Cliente" });
    // a chamada ligada ao contacto guarda a referência; "tel-…" dá o número quando a chamada não o traz
    await post("/rest/v10/Calls", { name: "Chamada", direction: "Inbound", status: "Held", parent_type: "Contacts", parent_id: "tel-351210000001" }, auth);
    const ins = h.calls.at(-1)!;
    expect(ins[7]).toBe("+351210000001"); // phone
    expect(ins[10]).toBe("tel-351210000001"); // contactRef
  });

  it("39e: a chamada da consola (só com o contacto) fica com o número da pesquisa — o pedido real de 7 out 01:48", async () => {
    const tok = await (await post("/rest/v10/oauth2/token", { grant_type: "password", username: "ana.silva", password: SECRET, client_id: "sugar", platform: "apicalls" })).json();
    const auth = { "OAuth-Token": tok.access_token };
    const fields = "id,full_name,title,department,phone_home,phone_work,phone_mobile,phone_other,phone_fax,email1";
    const found = await (await post("/rest/v10/Contacts/filter", { fields, max_num: 1, q: "*934000000*" }, auth)).json();
    expect(found.records[0]).toMatchObject({ id: "emp-7", full_name: "Rui Condutor" });
    expect(logged().some((x) => x.params.includes("pesquisa 934000000 → emp-7 Rui Condutor"))).toBe(true);
    const r = await post("/rest/v10/Calls", {
      assigned_user_id: "u12", contact_id: "emp-7", date_start: "2026-10-07T00:48:05Z", description: "Descrição da chamada OC", direction: "Outbound",
      duration_minutes: "0", name: "Chamada OC", parent_id: "emp-7", parent_type: "Contacts", status: "Held",
    }, auth);
    expect(r.status).toBe(200);
    const [, accountId, userId, direction, held, startedAt, durationS, phone, subject, , contactRef] = h.calls.at(-1)!;
    expect({ accountId, userId, direction, held, startedAt, durationS, phone, subject, contactRef }).toEqual({
      accountId: 7, userId: 12, direction: "out", held: 1, startedAt: "2026-10-07 00:48:05", durationS: 0, phone: "+351934000000", subject: "Chamada OC", contactRef: "emp-7",
    });
    const look = h.queries.find((x) => /SELECT note FROM central_requests/.test(x.sql))!;
    expect(look.sql).toMatch(/accountId = \? AND at >= \? AND note LIKE \?/);
    expect(look.params[2]).toBe("pesquisa % → emp-7 %");
    // contacto que esta conta nunca pesquisou: fica sem número (não se inventa)
    await post("/rest/v10/Calls", { direction: "Inbound", status: "Held", parent_type: "Contacts", parent_id: "crm-99" }, auth);
    expect(h.calls.at(-1)![7]).toBeNull();
    expect(h.calls.at(-1)![10]).toBe("crm-99");
  });

  it("39d: abrir o contacto na consola ({Server URL}/#Contacts/…) dá uma página que manda para a ficha", async () => {
    const r = await fetch(`${url}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toContain('to="/clientes/"+m[3]');
    expect(html).toContain("location.replace(to)");
  });

  it("v4_1: login com md5, set_entry de uma chamada; sessão inválida não grava", async () => {
    const form = (method: string, rest: unknown) => fetch(`${url}/service/v4_1/rest.php`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ method, input_type: "JSON", response_type: "JSON", rest_data: JSON.stringify(rest) }).toString(),
    });
    const bad = await (await form("login", { user_auth: { user_name: "ana.silva", password: md5("errada") } })).json();
    expect(bad.name).toBe("Invalid Login");
    const ok = await (await form("login", { user_auth: { user_name: "ana.silva", password: md5(SECRET) }, application_name: "One Net" })).json();
    expect(ok.module_name).toBe("Users");
    const r = await (await form("set_entry", { session: ok.id, module_name: "Calls", name_value_list: [{ name: "direction", value: "Outbound" }, { name: "name", value: "Para 213 000 000" }, { name: "duration_minutes", value: "1" }] })).json();
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0][3]).toBe("out");
    const inv = await (await form("set_entry", { session: "c1.7.a.9999999999999.x.y", module_name: "Calls", name_value_list: [] })).json();
    expect(inv.name).toBe("Invalid Session ID");
    expect(h.calls).toHaveLength(1);
  });
});

describe("39a — ligações no resto da dashboard", () => {
  it("montada na Vercel e no servidor local; interruptor desligado por omissão e só do super admin", async () => {
    for (const f of ["server/_core/api-entry.ts", "server/_core/index.ts"]) expect(src(f)).toContain("app.use(CENTRAL_SUGAR_BASE_PATH, createCentralSugarRouter());");
    const { AUTOMATION_FLAGS } = await import("../shared/appSettings");
    expect(AUTOMATION_FLAGS.find((f) => f.name === "CENTRAL_SUGAR")).toMatchObject({ defaultEnabled: false, superAdminOnly: true });
    expect(src("server/migrations/index.ts")).toContain('["0490", () => import("./migration_0490")');
    const m = src("server/migrations/migration_0490.ts");
    for (const t of ["central_accounts", "central_calls", "central_requests"]) expect(m).toContain(`CREATE TABLE IF NOT EXISTS \`${t}\``);
    expect(m).not.toMatch(/DROP|DELETE/);
    expect(src("server/migrations/index.ts")).toContain('["0495", () => import("./migration_0495")');
    expect(src("server/migrations/migration_0495.ts")).toContain("ALTER TABLE `central_calls` ADD COLUMN `contactRef` VARCHAR(40) NULL");
  });

  it("os acessos: só o super admin; o segredo só em hash e só se mostra ao criar; revoga-se, não se apaga", () => {
    const r = src("server/centralRouter.ts");
    expect(r).toContain('if (ctx.user.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN"');
    expect(r).toContain("${hashCentralSecret(secret)}");
    expect(r).toContain("return { username, secret };");
    expect(r).not.toMatch(/DELETE FROM/);
    expect(r).not.toMatch(/SELECT[^`]*secretHash[^`]*FROM central_accounts a LEFT JOIN users/); // a lista não devolve o hash
    expect(src("server/routers.ts")).toContain("central: centralRouter,");
    const page = src("client/src/pages/IntegrationsHubPage.tsx");
    expect(page).toContain('{(user as any).role === "super_admin" && <div id="central-vodafone" className="scroll-mt-20"><CentralVodafoneCard /></div>}');
  });

  it("as chamadas da central contam no Desempenho de quem atendeu ou fez", () => {
    const s = src("server/peoplePerformance.ts");
    expect(s).toContain("src(\"callsAnswered\", \"chamadas da central (atendidas)\", sql`central_calls`, sql`userId`, sql`startedAt`, sql`direction = 'in' AND held = 1`)");
    expect(s).toContain("src(\"callsMade\", \"chamadas da central (feitas)\", sql`central_calls`, sql`userId`, sql`startedAt`, sql`direction = 'out'`)");
    expect(s).not.toContain("ainda não há ligação");
  });

  it("39e: as últimas chamadas mostram com quem foi (ficha do RH, cliente ou contacto), lido por lotes", () => {
    const r = src("server/centralRouter.ts");
    expect(r).toContain("SELECT c.id, c.direction, c.held, c.startedAt, c.durationS, c.phone, c.subject, c.contactRef, c.source, u.name AS userName");
    expect(r).toContain("SELECT id, fullName FROM employees WHERE id IN (${list(ids.emp)})");
    expect(r).toContain("SELECT id, displayName, firstName, lastName FROM crm_clients WHERE id IN (${list(ids.crm)})");
    expect(r).toContain("SELECT id, name FROM crm_contacts WHERE id IN (${list(ids.ct)})");
    expect(r).toContain("contact: c.contactRef ? contacts.get(String(c.contactRef)) ?? null : null");
    const card = src("client/src/components/central/CentralVodafoneCard.tsx");
    expect(card).toContain('s === 0 ? "menos de 1 min"');
    expect(card).toContain('{c.contact.href ? <Link href={c.contact.href} className="underline">{c.contact.name}</Link> : <span>{c.contact.name}</span>}');
    expect(card).toContain('{c.direction === "out" ? "ligou a" : "chamada de"}');
    // sem número, a ficha não aparece duas vezes; sem ficha, o número; sem nada, o texto da consola
    expect(card).toContain('<span>{c.phone ?? (c.contact?.kind === "Sem ficha" ? c.contact.name : c.contact ? "" : c.subject ?? "")}</span>');
  });
});
