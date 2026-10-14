/**
 * Plano 62, P5 — definições dos tempos: zonas da operação, papéis das
 * garagens, parâmetros, a recusa do P2 colado ao terminal e o "Sugerir".
 */
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ enabled: false, calls: [] as string[], airports: null as unknown }));

vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getDb: async () => (fake.enabled
    ? {
        execute: async (q: any) => {
          const text = JSON.stringify(q?.queryChunks ?? q).slice(0, 400);
          fake.calls.push(text);
          // 1.ª leitura: os aeroportos gravados (getSettingFresh); 2.ª: a linha antiga da própria definição
          if (fake.calls.length === 1) return [[{ value: JSON.stringify(fake.airports), updatedAt: "2026-10-14 10:00:00", updatedByName: "Jorge" }]];
          if (fake.calls.length === 2) return [[]];
          return [{ affectedRows: 1 }];
        },
      }
    : null),
}));

import { appRouter } from "./routers";
import { setSetting } from "./appSettings";
import {
  GARAGE_ROLES_SETTING_KEY, PARK_ZONES_SETTING_KEY, SETTINGS, SERVICE_TIMES_SETTING_KEYS, parkZonesConflictError, settingSuperAdminOnly, validateSetting, validateSettingForWrite,
} from "../shared/appSettings";
import { DEFAULT_GARAGE_ROLES, DEFAULT_GPS_GATE } from "../shared/serviceTimes";
import { assertReadOnlySql } from "./multiparkDb/client";
import { buildGaragesSql, buildMovementGarageMediansSql, buildParkCentersSql, garageCoordsOf, kindOfGarageName, suggestZoneCenters } from "./multiparkDb/parkZonesSuggest";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Rita", accessOverrides: {} }, req: { headers: {} }, res: {} } as any);
const T1 = { label: "T1", lat: 38.7742, lng: -9.1342, radiusM: 200 };
const airports = { lisbon: { lat: 38.7742, lng: -9.1342, radiusM: 1500, zones: [T1] }, porto: { lat: 41.2481, lng: -8.6814, radiusM: 1500 }, faro: { lat: 37.0144, lng: -7.9659, radiusM: 1500 } };
const p2 = (lat: number, lng: number) => ({ lisbon: [{ label: "P2", kind: "p2", lat, lng, radiusM: 150, garages: ["P2"] }], porto: [], faro: [] });

beforeEach(() => { fake.enabled = false; fake.calls = []; fake.airports = airports; });

describe("definições novas (§5.2, §5.3, §10)", () => {
  it("omissões: zonas vazias, papéis do §5.3, meta 15, T2 15 (Q4), desde 3 abr / 15 set, chamadas ligadas, briefing desligado, portão fechado", () => {
    expect(SETTINGS[PARK_ZONES_SETTING_KEY].defaultValue).toEqual({ lisbon: [], porto: [], faro: [] });
    expect(SETTINGS[GARAGE_ROLES_SETTING_KEY].defaultValue).toEqual(DEFAULT_GARAGE_ROLES);
    expect(SETTINGS["serviceTimes.targetMinutes"].defaultValue).toBe(15);
    expect(SETTINGS["serviceTimes.pickupT2TargetMinutes"].defaultValue).toBe(15); // Q4
    expect(SETTINGS["serviceTimes.since"].defaultValue).toBe("2026-04-03");
    expect(SETTINGS["serviceTimes.gpsSince"].defaultValue).toBe("2026-09-15");
    expect(SETTINGS["serviceTimes.useCalls"].defaultValue).toBe(true);
    expect(SETTINGS["serviceTimes.inBriefing"].defaultValue).toBe(false);
    expect(SETTINGS["serviceTimes.gpsGate"].defaultValue).toEqual(DEFAULT_GPS_GATE);
    for (const k of [PARK_ZONES_SETTING_KEY, GARAGE_ROLES_SETTING_KEY, ...SERVICE_TIMES_SETTING_KEYS]) {
      expect(settingSuperAdminOnly(k), k).toBe(true);
      expect(validateSetting(k, SETTINGS[k as keyof typeof SETTINGS].defaultValue).ok, k).toBe(true);
    }
  });

  it("zonas (Q6: só exceções): só a garagem chega; raio 50–1 000 m; latitude e longitude juntas; tipo conhecido; garagem sem repetir", () => {
    expect(validateSetting(PARK_ZONES_SETTING_KEY, { lisbon: [{ label: "PD", radiusM: 300 }], porto: [], faro: [] }).ok).toBe(true);
    expect(validateSetting(PARK_ZONES_SETTING_KEY, { lisbon: [{ label: "PD", lat: 38.7 }], porto: [], faro: [] })).toMatchObject({ ok: false, error: expect.stringContaining("latitude E a longitude") });
    const ok = { lisbon: [{ label: "P2", kind: "p2", lat: 38.78, lng: -9.12, radiusM: 150, garages: ["P2"] }], porto: [], faro: [] };
    expect(validateSetting(PARK_ZONES_SETTING_KEY, ok).ok).toBe(true);
    expect(validateSetting(PARK_ZONES_SETTING_KEY, { ...ok, lisbon: [{ ...ok.lisbon[0], radiusM: 1500 }] })).toMatchObject({ ok: false, error: expect.stringContaining("1000 m") });
    expect(validateSetting(PARK_ZONES_SETTING_KEY, { ...ok, lisbon: [{ ...ok.lisbon[0], kind: "garagem" }] }).ok).toBe(false);
    expect(validateSetting(PARK_ZONES_SETTING_KEY, { ...ok, lisbon: [ok.lisbon[0], { ...ok.lisbon[0], label: "p 2" }] })).toMatchObject({ ok: false, error: expect.stringContaining("repetida") });
    // sem garagens nem campos → fica só o que veio
    const bare = validateSetting(PARK_ZONES_SETTING_KEY, { ...ok, lisbon: [{ label: "PD" }] });
    expect(bare.ok && (bare.value as any).lisbon[0]).toEqual({ label: "PD" });
  });

  it("papéis das garagens: provisoria/parque/final, sem garagem repetida; portão: só as três chaves", () => {
    expect(validateSetting(GARAGE_ROLES_SETTING_KEY, [{ garage: "P2", role: "provisoria" }, { garage: "PD", role: "final" }]).ok).toBe(true);
    expect(validateSetting(GARAGE_ROLES_SETTING_KEY, [{ garage: "P2", role: "outro" }]).ok).toBe(false);
    expect(validateSetting(GARAGE_ROLES_SETTING_KEY, [{ garage: "PD fora", role: "final" }, { garage: "PD FORA", role: "parque" }])).toMatchObject({ ok: false, error: expect.stringContaining("repetida") });
    expect(validateSetting("serviceTimes.gpsGate", { visible: true, minCoveragePct: 60, minN: 20 }).ok).toBe(true);
    expect(validateSetting("serviceTimes.gpsGate", { visible: true, minCoveragePct: 160, minN: 20 }).ok).toBe(false);
    expect(validateSetting("serviceTimes.gpsGate", { visible: true, minCoveragePct: 60, minN: 20, extra: 1 }).ok).toBe(false);
    expect(validateSetting("serviceTimes.since", "2024-01-01").ok).toBe(false);
    expect(validateSettingForWrite("serviceTimes.targetMinutes", 15).ok).toBe(true);
  });
});

describe("P2 colado ao terminal: recusado ao gravar (§5.2)", () => {
  it("texto do erro (servidor e editor usam a mesma regra)", () => {
    expect(parkZonesConflictError(p2(38.7742, -9.1342 + 0.003) as any, airports)).toMatch(/A zona P2 não pode tocar numa zona do terminal: P2 toca na zona T1 do terminal \(Lisboa, centros a \d+ m\)/);
    expect(parkZonesConflictError(p2(38.80, -9.10) as any, airports)).toBeNull();
  });

  it("setSetting recusa (lê os aeroportos gravados agora) e não escreve; longe do terminal grava com auditoria", async () => {
    fake.enabled = true;
    await expect(setSetting(PARK_ZONES_SETTING_KEY, p2(38.7742, -9.1342 + 0.003), 1)).rejects.toThrow(/não pode tocar numa zona do terminal/);
    expect(fake.calls).toHaveLength(1);
    fake.calls = [];
    const r = await setSetting(PARK_ZONES_SETTING_KEY, p2(38.80, -9.10), 1);
    expect(r.changed).toBe(true);
    expect(fake.calls.length).toBe(4); // aeroportos, linha antiga, gravação, auditoria
  });
});

describe("\"Sugerir\" (centros das garagens, só leitura)", () => {
  it("Q6: as garagens da Multipark (base das zonas) — o centro sai do link do mapa (\"Garage\" não tem lat/lng), a cidade pelo parque", async () => {
    const coords = garageCoordsOf(
      [{ name: "P2", park_id: "pL", map_link: "https://www.google.com/maps/@38.776,-9.128,18z" }, { name: "PD", park_id: "pL", map_link: "https://maps.app.goo.gl/x" }, { name: "X", park_id: "?", map_link: null }],
      [{ id: "pL", name: "Airpark Lisboa", city: "Lisboa", lat: 38.79, lng: -9.11 }],
    );
    // link curto (maps.app.goo.gl): o servidor não o abre → sem coordenadas, e o editor diz porquê
    expect(coords).toEqual([
      { garage: "P2", city: "lisbon", lat: 38.776, lng: -9.128, parkName: "Airpark Lisboa", link: "coordenadas" },
      { garage: "PD", city: "lisbon", lat: null, lng: null, parkName: "Airpark Lisboa", link: "curto" },
    ]);
    // admin vê a lista (só leitura); sem ligação à Multipark diz porquê
    const r = await caller("admin").settings.values.multiparkGarages();
    expect(r.available).toBe(false);
    expect(read("server/settingsRouter.ts")).toMatch(/multiparkGarages: adminOnly\.query/);
    expect(read("docs/multipark-db/schema.md")).toMatch(/## Garage[\s\S]*\| mapLink \| `text` \| sim/);
  });

  it("só o super admin; o SQL passa a guarda de só leitura, sem barras invertidas", async () => {
    await expect(caller("admin").settings.values.parkZonesSuggest()).rejects.toThrow(/super admin/);
    for (const q of [buildGaragesSql(), buildParkCentersSql(), buildMovementGarageMediansSql("2026-09-16 00:00:00")]) {
      expect(() => assertReadOnlySql(q.sql)).not.toThrow();
      expect(q.sql).not.toMatch(/\\/);
    }
    expect(buildMovementGarageMediansSql("2026-09-16 00:00:00").sql).toMatch(/percentile_cont\(0\.5\)/);
    expect(read("server/settingsRouter.ts")).toMatch(/parkZonesSuggest: adminOnly\.query\(async \(\{ ctx \}\) => \{\s*requireSuperAdmin\(ctx\.user\.role\);/);
  });

  it("ordem das fontes: link do mapa → mediana da app → centro do parque; cidade pelo parque; garagens só dos movimentos também", () => {
    const parks = [
      { id: "pL", name: "Airpark Lisboa", city: "Lisboa", lat: 38.79, lng: -9.11 },
      { id: "pP", name: "Airpark Porto", city: "Porto", lat: 41.24, lng: -8.67 },
    ];
    const garages = [
      { id: "g1", name: "PD", park_id: "pL", map_link: "https://www.google.com/maps/@38.781,-9.121,18z" },
      { id: "g2", name: "CENTRAL", park_id: "pL", map_link: null },
      { id: "g3", name: "COBERTO", park_id: "pL", map_link: null },
      { id: "g4", name: "PD", park_id: "pP", map_link: null },
    ];
    const medians = [
      { city: "lisbon", garage: "CENTRAL", n: 40, lat: 38.785, lng: -9.115 },
      { city: "lisbon", garage: "P2", n: 12, lat: 38.776, lng: -9.128 },
      { city: "porto", garage: "PD", n: 9, lat: 41.241, lng: -8.671 },
    ];
    const r = suggestZoneCenters({ garages, parks, medians });
    expect(r.lisbon.map((s) => [s.garage, s.source, s.kind])).toEqual([["CENTRAL", "app", "central"], ["COBERTO", "parque", "coberto"], ["P2", "app", "p2"], ["PD", "mapa", "pd"]]);
    expect(r.lisbon.find((s) => s.garage === "PD")).toMatchObject({ lat: 38.781, lng: -9.121 });
    expect(r.porto).toEqual([expect.objectContaining({ garage: "PD", source: "app", n: 9 })]);
    expect(r.faro).toEqual([]);
    expect(kindOfGarageName("PD FORA")).toBe("pd");
    expect(kindOfGarageName("Central Coberto")).toBe("central");
  });
});

describe("ecrã (Definições → Parâmetros → Operação)", () => {
  it("editores próprios (mapa, avisos, Sugerir; papéis) e aviso de rótulo T1/T2 nos aeroportos", () => {
    const page = read("client/src/pages/DefinicoesPage.tsx");
    expect(page).toContain("const isParkZones = item.key === PARK_ZONES_SETTING_KEY;");
    expect(page).toContain("const isGarageRoles = item.key === GARAGE_ROLES_SETTING_KEY;");
    expect(page).toMatch(/isCityMap = !isPhones && !isAirports && !isParkZones/);
    expect(page).toContain("unlabeledTerminalZones(airportsValue())");
    expect(page).toContain("parkZonesConflictError(zonesInForce(r.value), savedValue(TERMINAL_AIRPORTS_SETTING_KEY) as any)");
    const ed = read("client/src/components/settings/ServiceZonesEditor.tsx");
    expect(ed).toContain("trpc.settings.values.parkZonesSuggest.useQuery(undefined, { enabled: false");
    expect(ed).toContain("trpc.settings.values.multiparkGarages.useQuery(");
    expect(ed).toContain("effectiveParkZones(garages, value)");
    expect(ed).toContain("parkZoneOverlaps(");
    expect(ed).toContain("parksInsideZones(");
    expect(ed).toContain('#0055D2');
    expect(ed).toMatch(/rounded-\[14px\]/);
    expect(ed).toMatch(/rounded-\[10px\]/);
    expect(ed).toContain("Ver no mapa");
    expect(read("docs/ajuda/definicoes.md")).toMatch(/Zonas da operação \(GPS\)[\s\S]*Sugerir[\s\S]*Papéis das garagens/);
  });
});
