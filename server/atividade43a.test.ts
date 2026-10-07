/**
 * Lote 43a — Atividade diária (Jorge, 7 out 2026): o nome abre a ficha e o
 * resto da linha o histórico; escolher a pessoa; Histórico Diário a abrir num
 * dia que o Zello já dá, com o trajeto num mapa pintado pela velocidade (lido
 * do GeoJSON no servidor); o Atualizar do Ao Vivo lê tudo e reenquadra.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SPEED_BANDS, speedBand } from "../shared/speedBands";
import { downsampleTrack } from "./driverTrack";
import type { GpsPoint } from "./zelloGps";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("43a — cores da velocidade", () => {
  it("um tom do claro ao escuro e vermelho acima do limite", () => {
    expect(speedBand(10, 120).key).toBe("b0");
    expect(speedBand(45, 120).key).toBe("b1");
    expect(speedBand(75, 120).key).toBe("b2");
    expect(speedBand(110, 120).key).toBe("b3");
    expect(speedBand(121, 120)).toMatchObject({ key: "over", over: true });
    expect(SPEED_BANDS(120).map((b) => b.label)).toEqual(["até 30 km/h", "30–60", "60–90", "90–120", "acima de 120 (excesso)"]);
    // sem limite (ou limite baixo): sem faixa vermelha
    expect(SPEED_BANDS(null)).toHaveLength(4);
    expect(speedBand(200, null).key).toBe("b3");
  });
});

describe("43a — trajeto", () => {
  const pt = (i: number, speed: number, o: Partial<GpsPoint> = {}): GpsPoint => ({ ts: 1000 + i, speed, lat: 38.7 + i / 1000, lon: -9.1, accurate: true, ...o });

  it("tira os pontos sem posição ou imprecisos; velocidade impossível conta 0", () => {
    const r = downsampleTrack([pt(0, 10), pt(1, 20, { lat: null, lon: null }), pt(2, 30, { accurate: false }), pt(3, 999)], 100, 120);
    expect(r.map((p) => p.speed)).toEqual([10, 0]);
    expect(r[0]).toEqual({ lat: 38.7, lng: -9.1, speed: 10, ts: 1000 });
  });

  it("reduz um dia grande sem perder o início, o fim nem os excessos", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => pt(i, i === 7777 ? 140 : 50));
    const r = downsampleTrack(many, 500, 120);
    expect(r.length).toBeLessThanOrEqual(501);
    expect(r[0].ts).toBe(1000);
    expect(r[r.length - 1].ts).toBe(1000 + 9999);
    expect(r.some((p) => p.speed === 140)).toBe(true);
    // por ordem
    expect(r.every((p, i) => i === 0 || p.ts > r[i - 1].ts)).toBe(true);
  });
});

// ─── leitura do ficheiro no servidor (BD e armazenamento simulados) ─────────
const h = vi.hoisted(() => ({ row: null as any, fetched: [] as string[] }));
vi.mock("./db", () => ({ getDailyDriverHistoryRow: async () => h.row }));
vi.mock("./storageSign", () => ({ storageReadableUrl: async (u: string) => `https://assinado.example/${u}` }));
vi.mock("./dayActivity", () => ({ speedThreshold: async () => 120 }));

describe("43a — ler o trajeto", () => {
  it("lê o GeoJSON pelo endereço assinado e devolve os pontos, a máxima e o limite", async () => {
    h.row = { id: 5, employeeName: "Ana", zelloUsername: "extra1", date: "2026-10-05 00:00:00", geoJsonUrl: "driver-history/2026-10-05/extra1.geojson" };
    const feat = (lon: number, lat: number, speed: number, ts: number) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { speed, timestamp: ts, accuracy: 10 } });
    vi.stubGlobal("fetch", async (url: string) => {
      h.fetched.push(url);
      return { ok: true, status: 200, json: async () => ({ type: "FeatureCollection", features: [feat(-9.1, 38.7, 20, 100), feat(-9.11, 38.71, 131, 160), feat(-9.12, 38.72, 40, 220)] }) };
    });
    const { loadDriverTrack } = await import("./driverTrack");
    const r = await loadDriverTrack(5);
    expect(h.fetched[0]).toBe("https://assinado.example/driver-history/2026-10-05/extra1.geojson");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.track).toMatchObject({ id: 5, name: "Ana", date: "2026-10-05", total: 3, maxSpeed: 131, maxAt: 160, threshold: 120 });
      expect(r.track.points).toHaveLength(3);
    }
    vi.unstubAllGlobals();
  });

  it("sem registo no âmbito, sem ficheiro ou o ficheiro não responde: diz porquê (nunca lança)", async () => {
    const { loadDriverTrack } = await import("./driverTrack");
    h.row = null;
    expect(await loadDriverTrack(1)).toEqual({ ok: false, reason: expect.stringMatching(/não está no teu acesso/) });
    h.row = { id: 2, geoJsonUrl: null };
    expect(await loadDriverTrack(2)).toEqual({ ok: false, reason: expect.stringMatching(/sem pontos GPS/) });
    h.row = { id: 3, geoJsonUrl: "x.geojson", date: "2026-10-05" };
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 403, json: async () => ({}) }));
    expect(await loadDriverTrack(3)).toEqual({ ok: false, reason: "Não deu para ler o trajeto (HTTP 403)." });
    vi.unstubAllGlobals();
  });
});

describe("43a — rotas e ecrãs", () => {
  it("o trajeto: mesma permissão do Histórico e só a linha no âmbito de quem pede", () => {
    expect(src("server/operationalRouter.ts")).toMatch(/track: protectedProcedure\.input\(z\.object\(\{ id: z\.number\(\)\.int\(\)\.positive\(\) \}\)\)\.query\(async \(\{ ctx, input \}\) => \{\s*requireAccess\(ctx\.user, "historico_diario", "view"\)/);
    expect(src("server/db.ts")).toMatch(/export async function getDailyDriverHistoryRow\(id: number\)[\s\S]{0,300}where\(and\(historyScope\(\), eq\(dailyDriverHistory\.id, id\)\)\)/);
  });

  it("Atividade do Dia: o nome abre a ficha, o resto da linha o dia; escolher a pessoa", () => {
    const p = src("client/src/pages/OperationalPage.tsx");
    expect(p).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); openEmployee\(pers\.employeeId\); \}\}/);
    expect(p).toContain('const [who, setWho] = usePersistedState<string>("operacional.dia.who", "");');
    expect(p).toContain("<SearchableSelect options={whoOptions} value={who} onChange={setWho}");
  });

  it("Histórico Diário: abre no último dia do Zello; nome → ficha; Trajeto → mapa", () => {
    const p = src("client/src/pages/OperationalPage.tsx");
    expect(p).toContain('usePersistedState("operacional.hist.date", zelloLatestDay(Date.now()))');
    expect(p).toMatch(/openEmployee\(h\.resolvedEmployeeId\)/);
    expect(p).toContain("onClick={() => setTrackId(h.id)}");
    expect(p).not.toContain('<a href={h.geoJsonUrl} target="_blank"');
    expect(p).toContain("<SpeedTrackMap points={t.points}");
  });

  it("Ao Vivo: Atualizar lê posições, ligações e PDAs e volta a enquadrar", () => {
    const z = src("client/src/components/ZelloLiveTab.tsx");
    // 43b: os PDAs de cada Zello vêm com os utilizadores (usersQ)
    expect(z).toContain("await Promise.all([refetch(), usersQ.refetch(), mappingsQ.refetch()]);");
    expect(z).toContain("setFitSignal((n) => n + 1);");
    expect(z).toContain("<ZelloGoogleMap drivers={mapDrivers} fitSignal={fitSignal} />");
    expect(src("client/src/components/maps/ZelloGoogleMap.tsx")).toMatch(/if \(map && fitSignal && driversRef\.current\.length\) fitDrivers\(map, driversRef\.current\);/);
  });
});
