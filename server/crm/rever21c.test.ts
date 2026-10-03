/**
 * P3 lote 21c — Rever fichas: as regras de identidade do dono (3 out 2026),
 * a IA só nas dúvidas (sem contactos), recusas que acompanham as fichas,
 * aceitar/recusar só o que está pendente, a reserva de outra pessoa não leva
 * os contactos para a ficha, e o email de balcão troca-se numa só vez.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sync", () => ({ recomputeMetrics: vi.fn(async () => {}) }));
const logged = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("../db", () => ({ logActivity: vi.fn(async (x: any) => { logged.calls.push(x); }) }));
const ai = vi.hoisted(() => ({ available: true, calls: [] as any[], output: { results: [] as any[] } as any }));
vi.mock("../_core/ai/status", () => ({ aiFeatureAvailableFresh: vi.fn(async () => ai.available) }));
vi.mock("../_core/ai/run", () => ({ runAi: vi.fn(async (o: any) => { ai.calls.push(o); return { output: ai.output }; }) }));

import {
  decideLink, identityFactsForAi, identityVerdict, isGenericLocalPart, isPersonalEmail, isPersonalNif, nameTokens, sameFirstLast,
  type Candidate, type IdentitySide, type Observation,
} from "../../shared/crmIdentity";
import { MiniDb, ficha } from "./miniDb.testutil";
import { autoMergeConfident, mergeClients, splitMerge } from "./merge";
import { dismissSuggestion, replaceGenericEmail, undismissSuggestion } from "./edit";
import { planBatch, type BookingRow } from "./plan";
import { clampOffset } from "./review";

beforeEach(() => { logged.calls = []; ai.available = true; ai.calls = []; ai.output = { results: [] }; });

const side = (id: number, p: Partial<IdentitySide> = {}): IdentitySide => ({ id, name: "António Gonçalves", emails: [], phones: [], plates: [], nif: null, ...p });

describe("21c — o mesmo nome (1.º e último, sem acentos, pontos, traços, números…)", () => {
  it("as variantes do António Gonçalves são o mesmo nome", () => {
    const base = "António Gonçalves";
    for (const v of ["antonio gonçalves", "antonio goncalves", "antonio_gonçalves", "António Gonçalves1", "ANTÓNIO* GONÇALVES", "Antonio-Goncalves", "antónio.gonçalves", "António Manuel Gonçalves", "D'António Gonçalves"]) {
      expect(sameFirstLast(base, v), v).toBe(v !== "D'António Gonçalves");
    }
    expect(nameTokens("Gonçalves1")).toEqual(["goncalves"]);
  });
  it("uma palavra só, inicial, ou outro 1.º/último nome não é o mesmo nome", () => {
    expect(sameFirstLast("António Gonçalves", "António")).toBe(false);
    expect(sameFirstLast("António Gonçalves", "A. Gonçalves")).toBe(false);
    expect(sameFirstLast("António Gonçalves", "Alice Gonçalves")).toBe(false);
    expect(sameFirstLast("António Gonçalves", "António Silva")).toBe(false);
  });
});

describe("21c — emails de empresa e NIF", () => {
  it("info@, reservas2@, geral.porto@ são genéricos; ana.info@ não", () => {
    expect(isGenericLocalPart("info@x.pt")).toBe(true);
    expect(isGenericLocalPart("reservas2@hotel.pt")).toBe(true);
    expect(isGenericLocalPart("geral.porto@empresa.pt")).toBe(true);
    expect(isGenericLocalPart("Admin@Empresa.PT")).toBe(true);
    expect(isGenericLocalPart("ana.info@x.pt")).toBe(false);
    expect(isPersonalEmail("antonio.goncalves@gmail.com")).toBe(true);
    expect(isPersonalEmail("reservas@airpark.pt")).toBe(false);
  });
  it("NIF pessoal (1, 2, 3, 45) vs de empresa (5, 6, 9…)", () => {
    expect(isPersonalNif("123456789")).toBe(true);
    expect(isPersonalNif("451234567")).toBe(true);
    expect(isPersonalNif("501234567")).toBe(false);
    expect(isPersonalNif("")).toBe(false);
  });
});

describe("21c — juntar sozinho (identityVerdict)", () => {
  it("mesmo nome + email, telefone, matrícula ou NIF → junta", () => {
    expect(identityVerdict(side(1, { phones: ["+351912000000"] }), side(2, { name: "antonio_goncalves1", phones: ["+351912000000"] }))).toMatchObject({ verdict: "same", rule: "nome+telefone" });
    expect(identityVerdict(side(1, { emails: ["ag@gmail.com"] }), side(2, { emails: ["ag@gmail.com"] })).rule).toBe("nome+email");
    expect(identityVerdict(side(1, { plates: ["AA12BB"] }), side(2, { plates: ["AA12BB"] })).rule).toBe("nome+matrícula");
    expect(identityVerdict(side(1, { nif: "123456789" }), side(2, { nif: "123456789" })).rule).toBe("nome+NIF");
  });
  it("nome diferente (a Alice) com o mesmo email E telefone → junta; só um deles → dúvida", () => {
    const a = side(1, { emails: ["ag@gmail.com"], phones: ["+351912000000"], plates: ["AA12BB"] });
    expect(identityVerdict(a, side(2, { name: "Alice Costa", emails: ["ag@gmail.com"], phones: ["+351912000000"] }))).toMatchObject({ verdict: "same", rule: "email+telefone" });
    const v = identityVerdict(a, side(2, { name: "Alice Costa", emails: ["ag@gmail.com"], plates: ["AA12BB"] }));
    expect(v.verdict).toBe("doubt");
    expect(v.signals).toContain("name_diff");
  });
  it("empresas, Pro e NIF pessoais diferentes → nunca sozinho (nem a IA)", () => {
    const p = { phones: ["+351912000000"] };
    expect(identityVerdict(side(1, { ...p, kind: "company" }), side(2, p))).toMatchObject({ verdict: "block", signals: expect.arrayContaining(["company"]) });
    expect(identityVerdict(side(1, { ...p, name: "Gonçalves & Filhos, Lda" }), side(2, { ...p, name: "Gonçalves & Filhos Lda" })).verdict).toBe("block");
    expect(identityVerdict(side(1, { ...p, isPro: true }), side(2, p)).signals).toContain("pro");
    expect(identityVerdict(side(1, { ...p, nif: "123456789" }), side(2, { ...p, nif: "234567890" })).signals).toContain("nif_diff");
    // NIF de empresa (faturação à empresa) não impede
    expect(identityVerdict(side(1, { ...p, nif: "123456789" }), side(2, { ...p, nif: "501234567" })).verdict).toBe("same");
    // "Maria Sa" é a Maria Sá, não uma S.A.
    expect(identityVerdict(side(1, { ...p, name: "Maria Sa" }), side(2, { ...p, name: "Maria Sá" })).verdict).toBe("same");
  });
  it("email genérico e dados em mais de 2 fichas não contam", () => {
    const g = identityVerdict(side(1, { emails: ["info@empresa.pt"] }), side(2, { emails: ["info@empresa.pt"] }));
    expect(g).toMatchObject({ verdict: "doubt", signals: expect.arrayContaining(["generic_email"]) });
    const shared = identityVerdict(side(1, { phones: ["+351912000000"] }), side(2, { phones: ["+351912000000"] }), (k) => (k === "phone" ? 3 : 2));
    expect(shared).toMatchObject({ verdict: "doubt", signals: expect.arrayContaining(["shared_phone"]) });
  });
  it("à IA só vão comparações e o 1.º nome — nunca emails, telefones, matrículas, NIF ou apelidos", () => {
    const f = identityFactsForAi(
      side(1, { name: "Alice Ferreira", emails: ["antonio.goncalves@gmail.com"], phones: ["+351912000000"], plates: ["AA12BB"], nif: "123456789" }),
      side(2, { emails: ["antonio.goncalves@gmail.com"], phones: ["+351912000000"], nif: "123456789" }),
    );
    const text = JSON.stringify(f);
    for (const secret of ["antonio.goncalves", "912000000", "AA12BB", "123456789", "goncalves", "ferreira"]) expect(text.toLowerCase()).not.toContain(secret);
    expect(f.a.firstName).toBe("alice");
    expect(f.facts).toEqual(expect.arrayContaining(["1.º nome diferente", "último nome diferente", "telefone igual, só nestas 2 fichas", "NIF igual"]));
    expect(f.facts.some((x) => x.startsWith("email igual, só nestas 2 fichas; o email tem o nome da ficha B"))).toBe(true);
  });
});

describe("21c — ligar a reserva (decideLink)", () => {
  const obs = (p: Partial<Observation> = {}): Observation => ({ email: "ag@gmail.com", emailGeneric: false, phone: "+351912000000", plate: "AA12BB", name: "António Gonçalves", ...p });
  const cand = (p: Partial<Candidate> = {}): Candidate => ({ id: 1, names: ["Antonio Goncalves"], emails: ["ag@gmail.com"], phones: ["+351912000000"], plates: ["AA12BB"], ...p });
  it("telefone em mais de 2 fichas não liga sozinho", () => {
    expect(decideLink(obs({ email: "" }), [cand()], { phone: 3, plate: 3 }).clientId).toBeNull();
    expect(decideLink(obs({ email: "" }), [cand()], { phone: 2 }).rule).toBe("phone+name");
  });
  it("nome diferente nunca liga a uma ficha Pro; NIF pessoais diferentes nunca ligam", () => {
    expect(decideLink(obs({ name: "Alice Costa" }), [cand({ isPro: true })]).clientId).toBeNull();
    expect(decideLink(obs({ nif: "123456789" }), [cand({ nif: "234567890" })]).clientId).toBeNull();
    expect(decideLink(obs({ nif: "123456789" }), [cand({ nif: "501234567" })]).clientId).toBe(1);
  });
  it("info@ da empresa não liga (mesmo sem estar marcado como genérico)", () => {
    const o = obs({ email: "info@empresa.pt", phone: "", plate: "" });
    expect(decideLink({ ...o, emailGeneric: !isPersonalEmail(o.email) }, [cand({ emails: ["info@empresa.pt"] })]).clientId).toBeNull();
  });
});

describe("21c — reserva já ligada com o nome de outra pessoa", () => {
  const row = (p: Partial<BookingRow> = {}): BookingRow => ({
    externalId: "b1", firstName: "Rui", lastName: "Costa", email: "rui@x.pt", phone: "936000000", nif: null, plate: "45-TR-89",
    brand: null, model: null, color: null, vehicleType: null, partnerId: null, partnerName: null, pro: false, origin: null, seenAt: "2026-10-01 10:00:00", ...p,
  });
  it("fica ligada onde está, mas não leva o telefone, o email e o carro do Rui para a ficha da Marta", () => {
    const p = planBatch([row()], new Set(), new Map([["b1", 7]]), [], new Map([[7, ["Marta Silva"]]]));
    expect(p.links[0]).toMatchObject({ clientId: 7, rule: "kept" });
    expect(p.emails).toHaveLength(0);
    expect(p.phones).toHaveLength(0);
    expect(p.vehicles).toHaveLength(0);
    expect(p.touched[0]).toMatchObject({ clientId: 7, displayName: null, seenAt: "2026-10-01 10:00:00" });
    expect(p.stats.keptOtherName).toBe(1);
  });
  it("o mesmo nome (escrito de outra forma) continua a juntar os contactos", () => {
    const p = planBatch([row({ firstName: "Marta", lastName: "silva" })], new Set(), new Map([["b1", 7]]), [], new Map([[7, ["Marta Silva"]]]));
    expect(p.phones).toHaveLength(1);
  });
});

describe("21c — recusas que acompanham as fichas", () => {
  function three() {
    const db = new MiniDb();
    ficha(db, 1, { displayName: "Ana Silva", bookings: 1 });
    ficha(db, 2, { displayName: "Ana Silva", bookings: 5 });
    ficha(db, 3, { displayName: "Ana Sofia Silva", bookings: 1 });
    db.insert("crm_merge_suggestions", { id: 501, clientA: 1, clientB: 3, score: 40, reasons: "same_phone", status: "dismissed", decidedBy: 9, decidedAt: "2026-10-01 10:00:00" });
    db.insert("crm_merge_suggestions", { id: 502, clientA: 1, clientB: 2, score: 70, reasons: "same_phone,similar_name", status: "pending" });
    return db;
  }
  it("juntar a 1 à 2: a recusa 1↔3 passa a 2↔3; separar volta tudo e a 1↔2 fica recusada", async () => {
    const db = three();
    const { eventId } = await mergeClients(db as any, { survivorId: 2, mergedId: 1, userId: 9, suggestionId: 502, source: "ui" });
    const copied = db.rows("crm_merge_suggestions", (r) => r.clientA === 2 && r.clientB === 3)[0];
    expect(copied).toMatchObject({ status: "dismissed", decidedBy: 9 });
    expect(db.rows("crm_merge_events")[0]).toMatchObject({ source: "ui" });
    await splitMerge(db as any, { eventId, userId: 9 });
    expect(db.rows("crm_merge_suggestions", (r) => r.id === copied.id)[0].status).toBe("obsolete");
    expect(db.rows("crm_merge_suggestions", (r) => r.id === 501)[0].status).toBe("dismissed");
    expect(db.rows("crm_merge_suggestions", (r) => r.id === 502)[0].status).toBe("dismissed");
  });
  it("uma pendente 2↔3 fica recusada pela junção e volta a pendente ao separar", async () => {
    const db = three();
    db.insert("crm_merge_suggestions", { id: 503, clientA: 2, clientB: 3, score: 40, reasons: "same_plate", status: "pending" });
    const { eventId } = await mergeClients(db as any, { survivorId: 2, mergedId: 1, userId: 9 });
    expect(db.rows("crm_merge_suggestions", (r) => r.id === 503)[0].status).toBe("dismissed");
    await splitMerge(db as any, { eventId, userId: 9 });
    expect(db.rows("crm_merge_suggestions", (r) => r.id === 503)[0].status).toBe("pending");
  });
  it("aceitar uma sugestão que alguém recusou entretanto → erro, nada muda", async () => {
    const db = three();
    db.rows("crm_merge_suggestions", (r) => r.id === 502)[0].status = "dismissed";
    await expect(mergeClients(db as any, { survivorId: 2, mergedId: 1, userId: 9, suggestionId: 502 })).rejects.toThrow(/recusada/);
    expect(db.rows("crm_clients", (r) => r.id === 1)[0].status).toBe("active");
  });
  it("recusar só o que está pendente; fica no registo das duas fichas; Desfazer volta a pendente", async () => {
    const db = three();
    await dismissSuggestion(db as any, 9, 502);
    expect(logged.calls.filter((c) => c.action === "crm_suggestion_dismiss").map((c) => c.entityId).sort()).toEqual([1, 2]);
    await expect(dismissSuggestion(db as any, 9, 502)).rejects.toThrow(/já foi recusada/);
    expect(await undismissSuggestion(db as any, 9, 502)).toEqual({ status: "pending" });
    expect(db.rows("crm_merge_suggestions", (r) => r.id === 502)[0]).toMatchObject({ status: "pending", decidedBy: null });
  });
});

describe("21c — junção automática: regras e IA", () => {
  function pairs() {
    const db = new MiniDb();
    ficha(db, 1, { displayName: "António Gonçalves", bookings: 3 });
    ficha(db, 2, { displayName: "antonio_goncalves1", bookings: 1 });
    ficha(db, 3, { displayName: "Alice Ferreira", bookings: 2 });
    ficha(db, 4, { displayName: "Alice F.", bookings: 1 });
    ficha(db, 5, { displayName: "Transportes Lda", kind: "company", bookings: 9 });
    ficha(db, 6, { displayName: "Transportes Lda", kind: "company", bookings: 1 });
    db.insert("crm_client_phones", { clientId: 1, phone: "+351912000001" });
    db.insert("crm_client_phones", { clientId: 2, phone: "+351912000001" });
    db.insert("crm_client_phones", { clientId: 3, phone: "+351912000003" });
    db.insert("crm_client_phones", { clientId: 4, phone: "+351912000003" });
    db.insert("crm_client_phones", { clientId: 5, phone: "+351210000000" });
    db.insert("crm_client_phones", { clientId: 6, phone: "+351210000000" });
    db.insert("crm_merge_suggestions", { id: 601, clientA: 1, clientB: 2, score: 60, reasons: "same_phone", status: "pending" });
    db.insert("crm_merge_suggestions", { id: 602, clientA: 3, clientB: 4, score: 50, reasons: "same_phone", status: "pending" });
    db.insert("crm_merge_suggestions", { id: 603, clientA: 5, clientB: 6, score: 70, reasons: "same_phone,similar_name", status: "pending" });
    return db;
  }
  it("as regras juntam o António; a dúvida (Alice F.) vai à IA, que só junta com ≥ 85 %; a empresa nunca", async () => {
    const db = pairs();
    ai.output = { results: [{ id: 602, verdict: "same", confidence: 0.92, reason: "inicial do apelido compatível" }] };
    const r = await autoMergeConfident(db as any, { deadlineAt: Date.now() + 60_000, userId: 0 });
    expect(r).toMatchObject({ merged: 1, mergedByAi: 1, aiChecked: 1, errors: 0 });
    const ev = db.rows("crm_merge_events");
    expect(ev.map((e) => [e.survivorId, e.mergedId, e.source])).toEqual([[1, 2, "auto"], [3, 4, "ai"]]);
    expect(ev[0].reason).toBe("automático: mesmo nome e mesmo telefone");
    expect(ev[1].reason).toMatch(/^IA \(92 %\)/);
    expect(db.rows("crm_clients", (c) => c.id === 6)[0].status).toBe("active");
    // a IA só viu a dúvida, sem telefones nem apelidos
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].input).not.toMatch(/912000003|ferreira/i);
    expect(ai.calls[0].input).toMatch(/Par 602/);
    // registo nas duas fichas, como trabalho da madrugada
    const merges = logged.calls.filter((c) => c.action === "crm_merge" || c.action === "crm_merged_into");
    expect(merges).toHaveLength(4);
    expect(merges.every((c) => c.source === "cron" && c.userId === 0)).toBe(true);
  });
  it("IA pouco certa ou desligada → fica em Rever (com o parecer à vista)", async () => {
    const db = pairs();
    ai.output = { results: [{ id: 602, verdict: "same", confidence: 70, reason: "talvez" }, { id: 999, verdict: "same", confidence: 99, reason: "inventado" }] };
    const r = await autoMergeConfident(db as any, { deadlineAt: Date.now() + 60_000, userId: 0 });
    expect(r.mergedByAi).toBe(0);
    expect(db.rows("crm_merge_suggestions", (s) => s.id === 602)[0]).toMatchObject({ status: "pending", aiVerdict: "same", aiConfidence: 70 });
    const db2 = pairs();
    ai.available = false;
    ai.calls = [];
    const r2 = await autoMergeConfident(db2 as any, { deadlineAt: Date.now() + 60_000, userId: 0 });
    expect(r2).toMatchObject({ merged: 1, mergedByAi: 0, aiChecked: 0 });
    expect(ai.calls).toHaveLength(0);
  });
});

describe("21c — email de balcão → o verdadeiro numa só vez", () => {
  it("o verdadeiro fica principal e o de balcão vai para os Retirados (bloqueado)", async () => {
    const db = new MiniDb();
    ficha(db, 1);
    db.insert("crm_client_emails", { id: 11, clientId: 1, email: "reservas@agregador.com", generic: 1, isPrimary: 1 });
    const r = await replaceGenericEmail(db as any, 9, 1, { email: "Ana@Gmail.com" });
    expect(r).toEqual({ email: "ana@gmail.com", removed: 1 });
    expect(db.rows("crm_client_emails").map((e) => [e.email, e.isPrimary])).toEqual([["ana@gmail.com", 1]]);
    expect(db.rows("crm_removed_items")[0]).toMatchObject({ kind: "email", value: "reservas@agregador.com" });
    expect(db.rows("crm_blocked_identifiers")[0]).toMatchObject({ kind: "email", value: "reservas@agregador.com" });
  });
  it("sem email de balcão e sem email novo → erro, nada muda", async () => {
    const db = new MiniDb();
    ficha(db, 1);
    await expect(replaceGenericEmail(db as any, 9, 1, { email: null })).rejects.toThrow(/já não tem/);
  });
});

describe("21c — páginas", () => {
  it("a última página que ficou vazia volta à anterior", () => {
    expect(clampOffset(20, 20, 10)).toBe(10);
    expect(clampOffset(20, 21, 10)).toBe(20);
    expect(clampOffset(30, 0, 10)).toBe(0);
    expect(clampOffset(0, 5, 10)).toBe(0);
  });
});

describe("21c — info@ de empresa", () => {
  it("não liga pessoas, mas continua a ser o email da ficha (não fica como email de balcão)", () => {
    const row: BookingRow = {
      externalId: "b9", firstName: "Hotel", lastName: "Central", email: "info@hotelcentral.pt", phone: null, nif: null, plate: null,
      brand: null, model: null, color: null, vehicleType: null, partnerId: null, partnerName: null, pro: false, origin: null, seenAt: null,
    };
    const p = planBatch([row], new Set(), new Map(), []);
    expect(p.newClients[0].primaryEmail).toBe("info@hotelcentral.pt");
    expect(p.emails[0]).toMatchObject({ email: "info@hotelcentral.pt", generic: false });
  });
});
