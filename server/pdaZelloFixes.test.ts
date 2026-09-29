import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SETTINGS, ZELLO_GPS_EXCLUDED_KEY, isZelloGpsExcluded, validateSetting, zelloExclusionSet,
} from "../shared/appSettings";

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

describe("pda_checkins: a coluna chama-se checkin_status (B1)", () => {
  it("o esquema mapeia checkinStatus → checkin_status", () => {
    expect(read("drizzle/schema.ts")).toContain(`checkinStatus: mysqlEnum("checkin_status"`);
    expect(read("drizzle/0021_lovely_madame_masque.sql")).toContain("`checkin_status` enum('checked_in','checked_out')");
  });

  it("nenhum SQL cru do servidor usa `checkinStatus` (só o ORM: pdaCheckins.checkinStatus / { checkinStatus: … })", () => {
    const bad: string[] = [];
    for (const f of tsFiles(resolve(root, "server"))) {
      read(f).split("\n").forEach((line, i) => {
        const cleaned = line.replace(/pdaCheckins\.checkinStatus/g, "").replace(/\bcheckinStatus\s*:/g, "");
        if (/\bcheckinStatus\b/.test(cleaned)) bad.push(`${f.slice(root.length + 1)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("os SQL crus corrigidos usam checkin_status (login, logout, ponto, mapa ao vivo, cartão do aparelho)", () => {
    const db = read("server/db.ts");
    for (const fn of ["getZelloLiveMappings", "attachPdaByDeviceToken", "releasePdaByDeviceToken", "closePdaCheckinsForEmployee", "getPdaByDeviceToken"]) {
      const start = db.indexOf(`export async function ${fn}`);
      const body = db.slice(start, db.indexOf("\nexport ", start + 10));
      expect(body, fn).toContain("checkin_status = 'checked_in'");
    }
  });

  it("falhas da ligação PDA deixam aviso no log (não são engolidas em silêncio)", () => {
    const r = read("server/routers.ts");
    expect(r).toContain(`console.warn("[pda] login→PDA falhou:", err)`);
    expect(r).toContain(`console.warn("[pda] logout→soltar PDA falhou:", err)`);
    expect(r).toContain(`console.warn("[pda] ponto→PDA automático (check-in) falhou:", err)`);
    expect(r).toContain(`console.warn("[pda] fecho do PDA no check-out do ponto falhou:", err)`);
    expect(read("client/src/components/PdaDeviceBinder.tsx")).toContain(`console.warn("[pda] login→PDA falhou:", e)`);
  });
});

describe("Zello: exclusão do GPS só por lista explícita (B5)", () => {
  it("definição 'Contas Zello excluídas do GPS', vazia por omissão", () => {
    const def = SETTINGS[ZELLO_GPS_EXCLUDED_KEY];
    expect(def.label).toBe("Contas Zello excluídas do GPS");
    expect(def.defaultValue).toEqual([]);
    expect(validateSetting(ZELLO_GPS_EXCLUDED_KEY, [" despacho ", "despacho", "teste1"])).toEqual({ ok: true, value: ["despacho", "teste1"] });
    expect(validateSetting(ZELLO_GPS_EXCLUDED_KEY, [""]).ok).toBe(false);
    expect(validateSetting(ZELLO_GPS_EXCLUDED_KEY, "despacho").ok).toBe(false);
  });

  it("comparação sem maiúsculas; lista vazia não exclui ninguém (nem os admin do Zello)", () => {
    const set = zelloExclusionSet(["Despacho"]);
    expect(isZelloGpsExcluded("despacho", set)).toBe(true);
    expect(isZelloGpsExcluded("jorge", set)).toBe(false);
    expect(isZelloGpsExcluded("jorge", zelloExclusionSet(null))).toBe(false);
    expect(isZelloGpsExcluded("", set)).toBe(false);
  });

  it("a recolha GPS e os alertas deixam de filtrar pela flag admin", () => {
    const job = read("server/jobs/dailyDriverCollection.ts");
    expect(job).not.toMatch(/\.admin\b/);
    expect(job).toContain("getZelloGpsUsers()");
    const r = read("server/routers.ts");
    expect(r).not.toContain("if (user.admin) continue");
    for (const f of ["client/src/components/ZelloLiveTab.tsx", "client/src/pages/OperationalPage.tsx"]) expect(read(f), f).not.toMatch(/!u\.admin\b/);
  });

  it("loadZelloGpsExclusions lê a definição e nunca lança", async () => {
    vi.resetModules();
    vi.doMock("./appSettings", () => ({ getSetting: async () => ["Consola"] }));
    const { loadZelloGpsExclusions } = await import("./zello");
    expect([...(await loadZelloGpsExclusions())]).toEqual(["consola"]);
    vi.doMock("./appSettings", () => ({ getSetting: async () => { throw new Error("x"); } }));
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const again = await import("./zello");
    expect((await again.loadZelloGpsExclusions()).size).toBe(0);
    warn.mockRestore();
    vi.doUnmock("./appSettings");
  });
});
