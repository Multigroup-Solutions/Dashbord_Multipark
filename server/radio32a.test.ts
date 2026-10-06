/**
 * P3 lote 32a — Rádio (Jorge, 6 out 2026): "o utilizador escolhe uma data e
 * hora, um intervalo ou um utilizador; a app vai buscar as gravações e/ou
 * transcrições à API do Zello e cruza com as localizações e velocidades e com
 * as movimentações e o histórico da Multipark."
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { actionsNear, holderAt, mapZelloMessage, nearestPoint, radioRange, fmtDelta, changeLabel } from "../shared/radioCross";
import { buildRadioActionsSql, mapRadioAction } from "./multiparkDb/radioActions";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const zello = vi.hoisted(() => ({ meta: [] as any[], calls: [] as any[] }));
vi.mock("./zello", () => ({
  isZelloConfigured: () => true,
  getZelloHistoryMetadata: vi.fn(async (f: any) => { zello.calls.push(f); return { messages: zello.meta, total: zello.meta.length }; }),
  getZelloUserHistory: vi.fn(async () => ({ features: [
    { properties: { timestamp: 1791280000, speed: 30, accuracy: 10 }, geometry: { type: "Point", coordinates: [-9.13, 38.77] } },
    { properties: { timestamp: 1791281000, speed: 0, accuracy: 10 }, geometry: { type: "Point", coordinates: [-9.14, 38.78] } },
  ] })),
  getZelloMedia: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: async () => null }));

describe("32a — intervalo, mensagem, GPS, PDA e Multipark", () => {
  it("dia + de/até em hora de Lisboa; 'até' antes do 'de' = dia seguinte; erros", () => {
    expect(radioRange("2026-10-06", "10:00", "11:30")).toEqual({ fromMs: Date.parse("2026-10-06T09:00:00Z"), toMs: Date.parse("2026-10-06T10:30:00Z") });
    expect(radioRange("2026-10-06", "22:00", "02:00")).toEqual({ fromMs: Date.parse("2026-10-06T21:00:00Z"), toMs: Date.parse("2026-10-07T01:00:00Z") });
    expect(radioRange("2026-12-10", "00:00", "23:59")).toEqual({ fromMs: Date.parse("2026-12-10T00:00:00Z"), toMs: Date.parse("2026-12-11T00:00:00Z") });
    expect(radioRange("2026-10-06", "25:00", "11:00")).toEqual({ error: "Hora inválida (HH:MM)." });
    expect(radioRange("06/10/2026", "10:00", "11:00")).toEqual({ error: "Dia inválido." });
  });

  it("mensagem do Zello: ts em segundos, duração em ms, transcrição e 'pode ter erros'", () => {
    expect(mapZelloMessage({ id: 9, type: "voice", ts: 1791280010, sender: "pda7", author_full_name: "PDA 7", recipient: "Lisboa", recipient_type: "channel", duration: 4300, media_key: "abc123", transcription: "vou buscar o carro", transcription_inaccurate: "yes" }))
      .toEqual({ id: 9, type: "voice", at: 1791280010000, sender: "pda7", senderName: "PDA 7", recipient: "Lisboa", recipientType: "channel", durationS: 4.3, mediaKey: "abc123", transcription: "vou buscar o carro", transcriptionInaccurate: true, text: null });
    expect(mapZelloMessage({ id: 1, ts: 0, sender: "x" })).toBeNull();
  });

  it("GPS: o ponto mais perto até 5 min; PDA: quem tinha o check-in nessa hora", () => {
    const pts = [{ at: 1000_000, lat: 1, lon: 2, speed: 30 }, { at: 1600_000, lat: 3, lon: 4, speed: 0 }];
    expect(nearestPoint(pts, 1010_000)).toMatchObject({ speed: 30, deltaS: -10 });
    expect(nearestPoint(pts, 1_800_000)).toMatchObject({ speed: 0, deltaS: -200 });
    expect(nearestPoint(pts, 2_000_000)).toBeNull(); // 400 s > 5 min
    expect(holderAt([{ employeeId: 1, start: 0, end: 100 }, { employeeId: 2, start: 100, end: 200 }], 150)).toBe(2);
    expect(holderAt([{ employeeId: 1, start: 0, end: 100 }], 500)).toBeNull();
  });

  it("Multipark: só os agentes da pessoa, 10 min à volta, os mais perto primeiro", () => {
    const at = 10_000_000;
    const acts = [
      { userId: "a", at: at + 30_000, changeType: "CHECK_OUT", bookingCode: "B1", plate: "AA-00-AA", park: "Airpark" },
      { userId: "a", at: at - 5_000, changeType: "MOVEMENT", bookingCode: "B2", plate: null, park: null },
      { userId: "a", at: at + 11 * 60_000, changeType: "CHECK_IN", bookingCode: "B3", plate: null, park: null },
      { userId: "b", at, changeType: "CHECK_IN", bookingCode: "B4", plate: null, park: null },
    ];
    expect(actionsNear(acts, new Set(["a"]), at).map((x) => [x.bookingCode, x.deltaS])).toEqual([["B2", -5], ["B1", 30]]);
    expect(changeLabel("CHECK_OUT")).toBe("Saída (check-out)");
    expect(fmtDelta(-40)).toBe("−40 s");
    expect(fmtDelta(180)).toBe("+3 min");
  });

  it("leitura da Multipark só de leitura, com parâmetros e LIMIT", () => {
    const q = buildRadioActionsSql({ agentIds: ["u1", "u2"], from: "2026-10-06 09:00:00", to: "2026-10-06 10:00:00" });
    expect(q.sql).toContain(`FROM "History" h`);
    expect(q.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(q.params).toEqual(["u1", "u2", "2026-10-06 09:00:00", "2026-10-06 10:00:00", 3000]);
    expect(mapRadioAction({ user_id: "u1", at: "2026-10-06 09:15:00", change_type: "CHECK_IN", booking_code: "X", plate: "", park_name: "Airpark" }))
      .toEqual({ userId: "u1", at: Date.parse("2026-10-06T09:15:00Z"), changeType: "CHECK_IN", bookingCode: "X", plate: null, park: "Airpark" });
  });
});

describe("32a — a pesquisa no Zello", () => {
  it("pede só voz, no intervalo, do utilizador; junta o GPS mais perto; cidade: quem não se sabe de onde é fica de fora", async () => {
    zello.meta = [{ id: 1, type: "voice", ts: 1791280010, sender: "pda7", duration: 3000, media_key: "k1" }];
    zello.calls = [];
    const { searchZelloRadio } = await import("./radioZello");
    const r = await searchZelloRadio({ fromMs: 1791279000_000, toMs: 1791283000_000, user: "pda7" });
    expect(zello.calls[0]).toMatchObject({ startTs: 1791279000, endTs: 1791283000, type: "voice", sender: "pda7", max: 100, start: 0 });
    if (!r.available) throw new Error("devia estar disponível");
    expect(r.messages[0]).toMatchObject({ id: 1, person: null, position: { speed: 30, deltaS: -10, lat: 38.77, lon: -9.13 }, actions: [] });
    const scoped = await searchZelloRadio({ fromMs: 1791279000_000, toMs: 1791283000_000, scopeProjectIds: [5] });
    if (!scoped.available) throw new Error("devia estar disponível");
    expect(scoped.messages).toEqual([]);
    expect(scoped.notices[0]).toMatch(/outras cidades/);
  });

  it("quem falou: check-in no PDA a essa hora, senão a ficha; transcrição IA só com áudio do Zello e sem pagar duas vezes", () => {
    const s = src("server/radioZello.ts");
    expect(s).toContain("FROM pda_checkins c LEFT JOIN pdas p ON p.id = c.pdaId");
    expect(s).toContain("SELECT id, zelloUsername FROM employees WHERE zelloUsername IN");
    expect(s).toContain(`if (!/(^|\\.)zellowork\\.com$/.test(host)) throw new Error("O áudio não veio do Zello.");`);
    expect(s).toContain("WHERE zelloMessageId = ${o.messageId}");
    expect(src("server/migrations/migration_0480.ts")).not.toMatch(/DROP|DELETE|UPDATE /);
  });

  it("rotas: ver = módulo Rádio; transcrever = editar; a chave do áudio é validada", () => {
    const r = src("server/operationalRouter.ts");
    expect(r).toMatch(/zelloSearch: protectedProcedure[\s\S]{0,700}requireAccess\(ctx\.user, "radio", "view"\)/);
    expect(r).toMatch(/zelloTranscribe: protectedProcedure[\s\S]{0,400}requireAccess\(ctx\.user, "radio", "edit"\)/);
    expect(r).toContain("z.string().trim().regex(/^[A-Za-z0-9_.-]{4,200}$/)");
    const ui = src("client/src/pages/RadioPage.tsx");
    expect(ui).toContain(`<Tabs defaultValue="zello"`);
    expect(ui).toContain("<ZelloRadioSearch />");
  });
});
