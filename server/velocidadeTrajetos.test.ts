/**
 * Ronda 2 da auditoria (14 out 2026): trajetos realistas contra as regras dos
 * excessos de velocidade (shared/speedRules.ts) — autoestrada sustentada,
 * pico isolado, GPS com saltos, pontos espaçados do Zello e cidade.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SPEED_RULE, speedExcesses, speedSpikes, trustedMaxSpeed, type SpeedPoint } from "../shared/speedRules";

/** Um trajeto em linha reta para norte: [segundos desde o início, km/h], com a posição a andar à velocidade de cada troço. */
function route(samples: Array<[number, number]>, o: { lat0?: number; posKmh?: (i: number, v: number) => number } = {}): SpeedPoint[] {
  const base = 1_760_000_000;
  let lat = o.lat0 ?? 38.7;
  const out: SpeedPoint[] = [];
  samples.forEach(([t, v], i) => {
    if (i > 0) {
      const [pt, pv] = samples[i - 1];
      const real = o.posKmh ? o.posKmh(i, v) : (pv + v) / 2; // a posição anda à média dos dois pontos
      lat += ((real * (t - pt)) / 3600) / 111.2;
    }
    out.push({ ts: base + t, speed: v, accurate: true, lat, lon: -9.1 });
  });
  return out;
}
const every = (step: number, speeds: number[], t0 = 0): Array<[number, number]> => speeds.map((v, i) => [t0 + i * step, v]);

describe("trajetos realistas (limite 120 + 10 % = 132, 2 pontos)", () => {
  // Tarefa 62: a omissão passou a 120 sem tolerância; estes trajetos foram desenhados à volta de 132 e
  // continuam a testar a mecânica com essa regra (a de antes, que alguém pode voltar a escolher em Definições).
  const R = { ...DEFAULT_SPEED_RULE, tolerancePercent: 10 };

  it("autoestrada sustentada a 135–145 com pontos de 5 em 5 s: UM excesso, máxima real", () => {
    const pts = route(every(5, [60, 90, 110, 125, ...Array.from({ length: 60 }, (_, i) => 135 + (i % 11)), 120, 100, 60]));
    expect(speedSpikes(pts).size).toBe(0);
    const ex = speedExcesses(pts, R);
    expect(ex).toHaveLength(1);
    expect(ex[0].maxSpeed).toBe(145);
    expect(ex[0].confirmedBy).toBe("points");
    expect(trustedMaxSpeed(pts, { rule: R }).maxSpeed).toBe(145);
  });

  it("pico isolado na cidade (50 → 141 → 48 em 4 s): não é excesso nem conta para a máxima", () => {
    const pts = route(every(4, [45, 50, 52, 141, 48, 50, 47]));
    expect([...speedSpikes(pts).keys()]).toEqual([3]);
    expect(speedExcesses(pts, R)).toHaveLength(0);
    expect(trustedMaxSpeed(pts, { rule: R }).maxSpeed).toBe(52);
  });

  it("GPS aos saltos (3 pontos a 150–160 entre 40 e 40, 3 s cada): pico, não excesso", () => {
    const pts = route(every(3, [38, 40, 155, 160, 150, 40, 42]));
    expect(speedSpikes(pts).size).toBe(3);
    expect(speedExcesses(pts, R)).toHaveLength(0);
    expect(trustedMaxSpeed(pts, { rule: R }).maxSpeed).toBe(42);
  });

  it("um valor absurdo (300 km/h) no meio da autoestrada não apaga o excesso real à volta", () => {
    const pts = route(every(5, [120, 138, 140, 300, 141, 139, 118]), { posKmh: () => 139 });
    expect(speedSpikes(pts).get(3)).toBe("absurd");
    const ex = speedExcesses(pts, R);
    expect(ex).toHaveLength(1);
    expect(ex[0].maxSpeed).toBe(141);
  });

  it("Zello com pontos espaçados (1 a cada 90 s) numa autoestrada a 140: um excesso", () => {
    const pts = route(every(90, [100, 140, 142, 141, 139, 100]), { posKmh: () => 140 });
    const ex = speedExcesses(pts, R);
    expect(ex).toHaveLength(1);
    expect(ex[0].points).toBe(4);
  });

  it("Zello muito espaçado (1 ponto a 145, vizinhos a 3 min): só conta se a posição o confirmar", () => {
    // andou mesmo a ~140 (a posição confirma)
    const real = route(every(180, [110, 145, 115]), { posKmh: () => 140 });
    expect(speedExcesses(real, R).map((e) => e.confirmedBy)).toEqual(["position"]);
    // o mesmo ponto, mas a posição diz que andou a 100: não conta, e a máxima mostrada não é o 145 por confirmar
    const fake = route(every(180, [110, 145, 115]), { posKmh: () => 100 });
    expect(speedExcesses(fake, R)).toHaveLength(0);
    expect(trustedMaxSpeed(fake, { rule: R }).maxSpeed).toBe(115);
  });

  it("o mesmo troço de autoestrada com o Zello a mandar pontos de 3 em 3 min: UM excesso (antes eram 5)", () => {
    const pts = route(every(180, [100, 140, 141, 142, 140, 139, 100]), { posKmh: () => 140 });
    const ex = speedExcesses(pts, R);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ points: 5, confirmedBy: "points", maxSpeed: 142 });
    // com um ponto abaixo do limite pelo meio já são dois troços
    const split = route(every(180, [100, 140, 141, 110, 140, 139, 100]), { posKmh: () => 130 });
    expect(speedExcesses(split, R)).toHaveLength(2);
  });

  it("GPS a tremer com pontos de 5 em 5 s (precisão até 100 m): um ponto a 135 entre 125 e 126 não é excesso", () => {
    // a posição salta 150 m para a frente no ponto do meio: em 5 s isso dava ~230 km/h — antes "confirmava" o excesso
    const pts = route(every(5, [125, 135, 126]), { posKmh: (i) => (i === 1 ? 230 : 20) });
    expect(speedExcesses(pts, R)).toHaveLength(0);
    expect(trustedMaxSpeed(pts, { rule: R }).maxSpeed).toBe(126);
  });

  it("cidade (30–60 km/h com paragens e pontos a 0): nada", () => {
    const speeds = Array.from({ length: 200 }, (_, i) => (i % 25 < 3 ? 0 : 30 + ((i * 7) % 31)));
    const pts = route(every(5, speeds));
    expect(speedExcesses(pts, R)).toHaveLength(0);
    expect(trustedMaxSpeed(pts, { rule: R }).maxSpeed).toBeLessThanOrEqual(60);
  });

  it("autoestrada a 125–131 (abaixo de 132 com a tolerância): nada, mas a máxima mostra 131", () => {
    const pts = route(every(5, Array.from({ length: 40 }, (_, i) => 125 + (i % 7))));
    expect(speedExcesses(pts, R)).toHaveLength(0);
    expect(trustedMaxSpeed(pts, { rule: R }).maxSpeed).toBe(131);
    // com a omissão da tarefa 62 (120, sem tolerância) é UM excesso, máxima 131
    expect(speedExcesses(pts, DEFAULT_SPEED_RULE)).toHaveLength(1);
    expect(trustedMaxSpeed(pts, { rule: DEFAULT_SPEED_RULE }).maxSpeed).toBe(131);
  });

  it("dois troços acima do limite separados por 10 min a 110: dois excessos", () => {
    const pts = route([...every(5, [140, 141, 142]), ...every(30, Array(20).fill(110), 15), ...every(5, [138, 139], 630)]);
    expect(speedExcesses(pts, R)).toHaveLength(2);
  });

  it("pontos imprecisos (precisão > 100 m) a 150 não contam", () => {
    const pts = route(every(5, [120, 150, 152, 151, 120])).map((p, i) => (i >= 1 && i <= 3 ? { ...p, accurate: false } : p));
    expect(speedExcesses(pts, R)).toHaveLength(0);
    expect(trustedMaxSpeed(pts, { rule: R }).maxSpeed).toBe(120);
  });
});
