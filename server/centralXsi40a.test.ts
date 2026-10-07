/**
 * Lote 40a — Xsi da One Net (Jorge, 7 out 2026: "O XSI está ativo. Como é que
 * tenho que configurar agora?"). Regras puras: endereço do servidor e leitura
 * das respostas XML do BroadWorks.
 */
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeXml, last9, normalizeXsiBase, normalizeXsiUserId, parseXsiCallLogs, parseXsiDirectory, parseXsiProfile, xmlBlocks, xmlText,
} from "../shared/centralXsi";

// ── BD e Xsi simulados ──
const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  fetches: [] as Array<{ url: string; auth: string | null }>,
  respond: (_url: string): { status: number; body: string } | Error => ({ status: 200, body: "" }),
}));
const dialect = new MySqlDialect();
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const { sql, params } = dialect.sqlToQuery(q);
      h.queries.push({ sql, params });
      if (/FROM central_xsi_config/.test(sql)) return [h.row ? [h.row] : []];
      if (/FROM employees WHERE isActive = 1/.test(sql)) return [[{ id: 7, fullName: "Ana Silva", userId: 12, phone: null, personalPhone: "+351 912 345 678" }, { id: 8, fullName: "Rui Fixo", userId: null, phone: "210000002", personalPhone: null }]];
      return [{ affectedRows: 1 }];
    },
  }),
}));
vi.mock("./_core/fetchWithTimeout", () => ({
  fetchWithTimeout: async (url: string, init: any) => {
    h.fetches.push({ url, auth: init?.headers?.Authorization ?? null });
    const r = h.respond(url);
    if (r instanceof Error) throw r;
    return new Response(r.body, { status: r.status });
  },
}));
process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-so-para-testes";

import { saveXsiConfig, testXsi, xsiConfigView, xsiStatusNote } from "./centralXsi";
import { encryptSecret } from "./integrations/googleAds/crypto";
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const PASS = "PalavraPasseDoXsi!9";

describe("40a — endereço e utilizador do Xsi", () => {
  it("aceita o anfitrião ou o URL completo e fica com a origem https", () => {
    expect(normalizeXsiBase("xsi.onenet.example.pt")).toBe("https://xsi.onenet.example.pt");
    expect(normalizeXsiBase("https://xsi.onenet.example.pt/com.broadsoft.xsi-actions/v2.0/user/x/profile")).toBe("https://xsi.onenet.example.pt");
    expect(normalizeXsiBase("https://portal.example.pt:8443/xsi/com.broadsoft.xsi-actions/v2.0")).toBe("https://portal.example.pt:8443/xsi");
    expect(normalizeXsiBase("https://xsi.example.pt/")).toBe("https://xsi.example.pt");
  });
  it("recusa http, credenciais no URL, localhost e IPs internos", () => {
    for (const bad of ["http://xsi.example.pt", "https://a:b@xsi.example.pt", "https://localhost", "https://10.0.0.5", "https://192.168.1.10", "https://127.0.0.1", "https://172.20.0.1", "https://169.254.169.254", "https://servidor", "", "ftp://x.y"]) {
      expect(normalizeXsiBase(bad)).toBeNull();
    }
    expect(normalizeXsiBase("https://81.20.30.40")).toBe("https://81.20.30.40"); // IP público serve
  });
  it("utilizador do BroadWorks", () => {
    expect(normalizeXsiUserId(" 351210000000@onenet.example.pt ")).toBe("351210000000@onenet.example.pt");
    expect(normalizeXsiUserId("+351210000000")).toBe("+351210000000");
    expect(normalizeXsiUserId("a b")).toBeNull();
    expect(normalizeXsiUserId("x")).toBeNull();
  });
});

describe("40a — XML do BroadWorks", () => {
  it("blocos e texto, com ou sem prefixo, e entidades", () => {
    const x = `<a xmlns="http://schema.broadsoft.com/xsi"><b>1</b><x:b>2</x:b><c/><d>R&amp;D &#233;</d></a>`;
    expect(xmlBlocks(x, "b")).toEqual(["1", "2"]);
    expect(xmlText(x, "c")).toBeNull();
    expect(xmlText(x, "d")).toBe("R&D é");
    expect(decodeXml("&lt;&gt;&quot;&apos;&#x41;")).toBe(`<>"'A`);
  });

  it("perfil", () => {
    const x = `<?xml version="1.0" encoding="UTF-8"?><Profile xmlns="http://schema.broadsoft.com/xsi"><details><userId>351210000000@onenet.pt</userId><firstName>Jorge</firstName><lastName>Tabuada</lastName><groupId>MULTIPARK</groupId><number>210000000</number><extension>410</extension></details></Profile>`;
    expect(parseXsiProfile(x)).toEqual({ userId: "351210000000@onenet.pt", firstName: "Jorge", lastName: "Tabuada", number: "210000000", extension: "410", groupId: "MULTIPARK" });
  });

  it("diretório da empresa", () => {
    const x = `<Enterprise xmlns="http://schema.broadsoft.com/xsi"><startIndex>1</startIndex><numberOfRecords>2</numberOfRecords><totalAvailableRecords>2</totalAvailableRecords><enterpriseDirectory>
      <directoryDetails><userId>a@onenet.pt</userId><firstName>Ana</firstName><lastName>Silva</lastName><groupId>G1</groupId><number>+351210000001</number><extension>411</extension><mobile>+351912345678</mobile><emailAddress>ana@x.pt</emailAddress></directoryDetails>
      <directoryDetails><userId>b@onenet.pt</userId><firstName>Rui</firstName><lastName/><extension>412</extension></directoryDetails>
    </enterpriseDirectory></Enterprise>`;
    const d = parseXsiDirectory(x);
    expect(d.total).toBe(2);
    expect(d.entries).toEqual([
      { userId: "a@onenet.pt", name: "Ana Silva", number: "+351210000001", extension: "411", mobile: "+351912345678", email: "ana@x.pt", groupId: "G1" },
      { userId: "b@onenet.pt", name: "Rui", number: null, extension: "412", mobile: null, email: null, groupId: null },
    ]);
  });

  it("registos de chamadas: feitas, recebidas e não atendidas", () => {
    const x = `<CallLogs xmlns="http://schema.broadsoft.com/xsi">
      <placed><callLogsEntry><countryCode>351</countryCode><phoneNumber>912345678</phoneNumber><name>Cliente</name><time>2026-10-07T10:00:00.000+01:00</time><callLogId>1:0</callLogId></callLogsEntry></placed>
      <received><callLogsEntry><countryCode>351</countryCode><phoneNumber>410</phoneNumber><time>2026-10-07T10:05:00.000+01:00</time><callLogId>2:0</callLogId></callLogsEntry></received>
      <missed><callLogsEntry><phoneNumber>+351934000000</phoneNumber><time>2026-10-07T10:10:00.000+01:00</time><callLogId>3:0</callLogId></callLogsEntry></missed>
    </CallLogs>`;
    expect(parseXsiCallLogs(x)).toEqual([
      { type: "placed", callLogId: "1:0", phone: "+351912345678", name: "Cliente", time: "2026-10-07T10:00:00.000+01:00" },
      { type: "received", callLogId: "2:0", phone: "410", name: null, time: "2026-10-07T10:05:00.000+01:00" },
      { type: "missed", callLogId: "3:0", phone: "+351934000000", name: null, time: "2026-10-07T10:10:00.000+01:00" },
    ]);
  });

  it("últimos 9 dígitos para cruzar com as fichas", () => {
    expect(last9("+351 912 345 678")).toBe("912345678");
    expect(last9("410")).toBeNull();
  });
});

describe("40a — guardar a configuração (palavra-passe cifrada)", () => {
  beforeEach(() => { h.queries.length = 0; h.row = null; });
  it("recusa endereço e utilizador maus; guarda cifrado; palavra-passe vazia mantém a que está", async () => {
    expect(await saveXsiConfig({ baseUrl: "http://xsi.example.pt", userId: "u@d" }, 1)).toMatchObject({ ok: false });
    expect(await saveXsiConfig({ baseUrl: "https://xsi.example.pt", userId: "a b" }, 1)).toMatchObject({ ok: false });
    expect(await saveXsiConfig({ baseUrl: "xsi.example.pt", userId: "351210000000@onenet.pt", password: PASS }, 1)).toEqual({ ok: true });
    const ins = h.queries.at(-1)!;
    expect(ins.sql).toContain("INSERT INTO central_xsi_config (id, baseUrl, userId, readUserId, passwordEnc, updatedById, updatedAt)");
    expect(ins.params[0]).toBe("https://xsi.example.pt");
    expect(String(ins.params[3])).toMatch(/^enc:v1:/);
    expect(JSON.stringify(ins.params)).not.toContain(PASS);
    await saveXsiConfig({ baseUrl: "https://xsi.example.pt", userId: "351210000000@onenet.pt", password: "" }, 1);
    expect(h.queries.at(-1)!.sql).not.toContain("passwordEnc");
  });
  it("o ecrã só sabe se há palavra-passe, nunca o valor", async () => {
    h.row = { baseUrl: "https://xsi.example.pt", userId: "u@d", readUserId: null, passwordEnc: encryptSecret(PASS), updatedAt: "2026-10-07 10:00:00", lastTestAt: null, lastTestOk: null, lastTestJson: null };
    const v = await xsiConfigView();
    expect(v).toMatchObject({ baseUrl: "https://xsi.example.pt", userId: "u@d", hasPassword: true });
    expect(JSON.stringify(v)).not.toContain(PASS);
    expect(JSON.stringify(v)).not.toContain("enc:v1:");
  });
});

describe("40a — Testar ligação", () => {
  const PROFILE = `<Profile xmlns="http://schema.broadsoft.com/xsi"><details><userId>351210000000@onenet.pt</userId><firstName>Jorge</firstName><lastName>Tabuada</lastName><extension>410</extension></details></Profile>`;
  const DIR = `<Enterprise><totalAvailableRecords>3</totalAvailableRecords><enterpriseDirectory>
    <directoryDetails><userId>a@onenet.pt</userId><firstName>Ana</firstName><lastName>S.</lastName><mobile>+351912345678</mobile><extension>411</extension></directoryDetails>
    <directoryDetails><userId>r@onenet.pt</userId><firstName>Rui</firstName><number>+351210000002</number></directoryDetails>
    <directoryDetails><userId>x@onenet.pt</userId><firstName>Sem</firstName><lastName>Ficha</lastName><number>+351210000099</number></directoryDetails>
  </enterpriseDirectory></Enterprise>`;
  const LOGS = `<CallLogs><placed><callLogsEntry><countryCode>351</countryCode><phoneNumber>913225918</phoneNumber><time>2026-10-07T10:00:00.000+01:00</time><callLogId>1:0</callLogId></callLogsEntry></placed><missed/></CallLogs>`;
  beforeEach(() => {
    h.queries.length = 0; h.fetches.length = 0;
    h.row = { baseUrl: "https://xsi.example.pt", userId: "351210000000@onenet.pt", readUserId: null, passwordEnc: encryptSecret(PASS) };
  });

  it("perfil, diretório × RH e registos; registos completos sem o serviço → só básicos", async () => {
    h.respond = (url) => url.endsWith("/profile") ? { status: 200, body: PROFILE } : url.includes("/directories/Enterprise") ? { status: 200, body: DIR }
      : url.includes("/directories/CallLogs") ? { status: 200, body: LOGS } : { status: 404, body: "" };
    const r = await testXsi();
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([["Perfil do utilizador", true], ["Diretório da empresa", true], ["Registos de chamadas", true], ["Registos completos (com durações)", false]]);
    expect(r.profile).toMatchObject({ firstName: "Jorge", extension: "410" });
    expect(r.directory).toMatchObject({ total: 3, count: 3, matched: 2 });
    expect(r.directory!.entries.map((e) => [e.name, e.employeeName, e.matchedBy, e.dashboardUserId])).toEqual([["Ana S.", "Ana Silva", "telemóvel", 12], ["Rui", "Rui Fixo", "número", null], ["Sem Ficha", null, null, null]]);
    expect(r.callLogs).toMatchObject({ count: 1, sample: [{ type: "placed", phone: "+351913225918" }] });
    expect(r.enhancedCallLogs).toBe(false);
    // o endereço e a autenticação certos; a palavra-passe nunca vai para o registo
    expect(h.fetches[0].url).toBe("https://xsi.example.pt/com.broadsoft.xsi-actions/v2.0/user/351210000000%40onenet.pt/profile");
    expect(h.fetches[0].auth).toBe(`Basic ${Buffer.from(`351210000000@onenet.pt:${PASS}`).toString("base64")}`);
    const logged = h.queries.filter((q) => /INSERT INTO central_requests/.test(q.sql));
    expect(logged).toHaveLength(4);
    expect(logged[0].params.slice(1, 4)).toEqual(["XSI GET", "/com.broadsoft.xsi-actions/v2.0/user/351210000000%40onenet.pt/profile", 200]);
    expect(JSON.stringify(h.queries.map((q) => q.params))).not.toContain(PASS);
    expect(h.queries.some((q) => /UPDATE central_xsi_config SET lastTestAt/.test(q.sql))).toBe(true);
  });

  it("palavra-passe errada: pára no perfil e explica", async () => {
    h.respond = () => ({ status: 401, body: "Unauthorized" });
    const r = await testXsi();
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(1);
    expect(r.error).toContain("utilizador ou palavra-passe errados");
  });

  it("sem resposta do servidor (firewall/IP): explica e não rebenta", async () => {
    h.respond = () => new Error("Sem resposta de xsi.example.pt em 10s");
    const r = await testXsi();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("não chegou ao servidor");
    expect(xsiStatusNote(403)).toContain("IP da dashboard não está autorizado");
  });

  it("administrador: lê o utilizador indicado em \"Utilizador a ler\"", async () => {
    h.row = { ...h.row!, userId: "admin@multipark", readUserId: "351210000000@onenet.pt" };
    h.respond = () => ({ status: 200, body: PROFILE });
    await testXsi();
    expect(h.fetches[0].url).toContain("/user/351210000000%40onenet.pt/profile");
    expect(h.fetches[0].auth).toBe(`Basic ${Buffer.from(`admin@multipark:${PASS}`).toString("base64")}`);
  });

  it("administrador sem \"Utilizador a ler\": o perfil dá 404 e a mensagem diz o que fazer", async () => {
    h.row = { ...h.row!, userId: "admin@multipark", readUserId: null };
    h.respond = () => ({ status: 404, body: "" });
    const r = await testXsi();
    expect(r.error).toContain('põe em "Utilizador a ler" o teu utilizador One Net');
  });

  it("sem configuração: diz o que falta e não chama o Xsi", async () => {
    h.row = null;
    const r = await testXsi();
    expect(r).toMatchObject({ ok: false, error: "Falta configurar o servidor e o utilizador do Xsi." });
    expect(h.fetches).toHaveLength(0);
  });
});

describe("40a — ligações", () => {
  it("só o super admin; o estado nunca devolve a palavra-passe; migração 0500; secção no cartão", () => {
    const r = src("server/centralRouter.ts");
    expect(r).toMatch(/xsiStatus: superOnly\.query/);
    expect(r).toMatch(/xsiSave: superOnly/);
    expect(r).toMatch(/xsiTest: superOnly\.mutation/);
    // o que vai para o ecrã só diz se há palavra-passe (o comportamento está testado acima)
    expect(src("server/centralXsi.ts")).toContain("hasPassword: !!r?.passwordEnc, updatedAt: iso(r?.updatedAt)");
    expect(src("server/migrations/index.ts")).toContain('["0500", () => import("./migration_0500")');
    const m = src("server/migrations/migration_0500.ts");
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS \\?`central_xsi_config\\?`/);
    expect(m).toMatch(/passwordEnc\\?` TEXT NULL/);
    expect(m).not.toMatch(/DROP|DELETE/);
    expect(src("client/src/components/central/CentralVodafoneCard.tsx")).toContain("<CentralXsiSection />");
    const ui = src("client/src/components/central/CentralXsiSection.tsx");
    expect(ui).toContain('type="password"');
    expect(ui).toContain('placeholder={q.data?.hasPassword ? "•••••• guardada — escreve só para mudar" : "palavra-passe do Xsi"}');
  });
});
