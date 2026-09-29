import { describe, expect, it } from "vitest";
import { agentListKind, agentNameKey, copyVsInitial, isInactiveAgentState, isoToUtcStamp, parseAgentListCsv, parseAgentSheetRows, phoneKey, parseInitialPricesCsv, parseSemicolonCsv } from "../shared/multiparkExports";
import { compareAgentRows } from "./multiparkExportsImport";
import { compareWithInitialEra, dayRow, INITIAL_ERA_EVENT } from "./cashCheckRouter";
import { copyRowToSnapshot } from "./webhookMemory";
import type { LiveFinance } from "./cashCheck/rules";

const no = { done: false, at: null, by: null };
const live = (p: Partial<LiveFinance> = {}): LiveFinance => ({
  id: "bk", code: "123", parkId: "p1", parkName: "Airpark", status: "CHECKED_OUT", checkIn: null, checkOut: "2026-09-20T17:00:00.000Z",
  updatedAt: null, currency: "EUR", bookingPrice: 45, originalBookingPrice: 45, parkingPrice: null, deliveryPrice: null, discountAmount: null,
  discountApplied: null, paymentMethod: "Dinheiro", paymentSource: null, paymentBy: null, campaignId: null, partnerId: null, partnerAmountDue: null,
  partnerAmountPaid: null, partnerContributedAmount: null, pro: false, proClientId: null,
  linesCount: 1, linesTotal: 45, linesPaid: 45, paymentsCount: 1, paymentsTotal: 45, paymentMethods: ["Dinheiro"],
  cashierClosed: no, cashValidated: no, driverValidated: no, ...p,
});

describe("CSV da Multipark (;)", () => {
  it("aspas, ; dentro de aspas, BOM e linhas em branco", () => {
    expect(parseSemicolonCsv('﻿"a";"b"\r\n"x;y";"z ""q"""\n\n')).toEqual([["a", "b"], ["x;y", 'z "q"']]);
  });
  it("preços iniciais: colunas, datas UTC, números e duplicados", () => {
    const csv = [
      '"reserva_id";"referencia";"parque";"cidade";"criada_em_utc";"estado_reserva";"booking_price_inicial";"verificacao";"booking_price_atual"',
      '"b1";"13861";"Airpark - Lisboa";"lisbon";"2026-04-30T23:03:59.815Z";"CHECKED_OUT";"31";"CONFIRMADO_NO_CREATED";"45"',
      '"b1";"13861";"Airpark - Lisboa";"lisbon";"2026-04-30T23:03:59.815Z";"CHECKED_OUT";"31";"CONFIRMADO_NO_CREATED";"45"',
      '"b2";"1";"Redpark";"porto";"x";"BOOKED";"";"CREATED_SEM_PRECO";"10,5"',
      '"";"2";"";"";"";"";"";"";""',
    ].join("\n");
    const r = parseInitialPricesCsv(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ bookingId: "b1", reference: "13861", createdAt: "2026-04-30 23:03:59", initialPrice: 31, priceAtExport: 45 });
    expect(r.rows[1]).toMatchObject({ initialPrice: null, createdAt: null, priceAtExport: 10.5 });
    expect(r.errors).toHaveLength(1);
    expect(parseInitialPricesCsv('"a";"b"\n"1";"2"').errors[0]).toMatch(/Faltam colunas/);
    expect(isoToUtcStamp("20260-01-01T00:00:00Z")).toBeNull();
  });
  it("cópia contra o preço inicial", () => {
    expect(copyVsInitial(31, 45, 31)).toBe("igual");
    expect(copyVsInitial(31, 45, 45)).toBe("reescrita");
    expect(copyVsInitial(31, 45, 60)).toBe("diferente");
    expect(copyVsInitial(31, 45, null)).toBe("sem_copia");
    expect(copyVsInitial(null, 45, 45)).toBe("sem_inicial");
  });
});

describe("lista de agentes", () => {
  const rows = parseAgentListCsv([
    '"nome_agente";"email";"cidade"',
    '"Bruno Meireles - PORTO";"Bruno.Meireles2001@gmail.com";"Porto"',
    '"Agência Bestravel Maia";"";"Lisboa"',
    '"Rafael Teste";"rafael@multipark.pt";"Faro | Lisboa | Porto"',
    '"Marcia Nunes";"marcianunes@multipark.pt";"Faro | Lisboa | Porto"',
    '"Ana Sem Email";"";"Lisboa"',
    '"Luís Moraes1";"x@y.pt";"Lisboa"',
  ].join("\n")).rows;
  it("lê emails em minúsculas e as cidades separadas por |", () => {
    expect(rows[0]).toEqual({ name: "Bruno Meireles - PORTO", email: "bruno.meireles2001@gmail.com", cities: ["Porto"] });
    expect(rows[2].cities).toEqual(["Faro", "Lisboa", "Porto"]);
  });
  it("classifica pessoas, agências, testes e contas da casa", () => {
    expect(rows.map(agentListKind)).toEqual(["pessoa", "agencia", "teste", "casa", "pessoa", "pessoa"]);
    expect(agentNameKey("Bruno Meireles - PORTO")).toBe(agentNameKey("bruno meireles"));
    expect(agentNameKey("Luís Moraes1")).toBe(agentNameKey("Luis Moraes"));
  });
  it("encontra o agente pelo email ou pelo nome e sugere a ficha", () => {
    const liveAgents = [
      { agentUserId: "u1", names: ["Bruno Meireles"], email: "bruno.meireles2001@gmail.com" },
      { agentUserId: "u2", names: ["Marcia Nunes"], email: null },
      { agentUserId: "u3", names: ["Ana Sem Email"], email: null },
      { agentUserId: "u4", names: ["Luis Moraes"], email: null },
    ];
    const emps = [
      { id: 10, fullName: "Bruno Meireles", emails: ["bruno.meireles2001@gmail.com"], agentIds: [] },
      { id: 11, fullName: "Márcia Nunes", emails: [], agentIds: ["u2"] },
      { id: 12, fullName: "Outra Pessoa", emails: [], agentIds: [] },
    ];
    const r = compareAgentRows(rows, liveAgents, emps);
    expect(r[0]).toMatchObject({ agentUserId: "u1", agentMatch: "email", status: "sugestao_email", suggestion: { employeeId: 10, by: "email" } });
    expect(r[1].status).toBe("nao_encontrado"); // agência: não é "fora", é parceiro (aqui não está na Multipark)
    expect(r[2].status).toBe("fora");
    expect(r[3]).toMatchObject({ agentUserId: "u2", agentMatch: "nome", status: "ligado", linkedTo: { employeeId: 11 } });
    expect(r[4]).toMatchObject({ agentUserId: "u3", status: "sem_ficha", suggestion: null });
    expect(compareAgentRows([{ name: "Ninguém", email: null, cities: [] }], liveAgents, emps)[0].status).toBe("nao_encontrado");
  });
});

describe("exportação xlsx de agentes (folha Agentes)", () => {
  const sheet = [
    { Nome: "", Email: "", Telefone: "", Estado: "Ativo", "Cargo principal": "Administrador", "Parques ativos": "Skypark - Lisboa", "ID utilizador": "api" },
    { Nome: "ABOUT DESTINY", Email: "Reservas@QViagem.com", Telefone: "963781232", Estado: "Ativo", "Cargo principal": "Parceiro", "Parques ativos": "Airpark - Faro, Airpark - Lisboa", "ID utilizador": "cmpartner1" },
    { Nome: "Bruno Meireles", Email: "bruno@gmail.com", Telefone: "", Estado: "Ativo", "Cargo principal": "Condutor", "Parques ativos": "Airpark - Porto", "ID utilizador": "cmbruno" },
    { Nome: "Zé Telefone", Email: "ze.novo@gmail.com", Telefone: "+351 912 345 678", Estado: "Inativo", "Cargo principal": "Condutor", "Parques ativos": "", "Parques inativos": "Airpark - Lisboa", "ID utilizador": "cmze" },
    { Nome: "Ana Ligada", Email: "ana@gmail.com", Telefone: "", Estado: "Ativo", "Cargo principal": "Supervisor", "Parques ativos": "", "ID utilizador": "cmana" },
    { Nome: "Parceiro Novo", Email: "x@gmail.com", Telefone: "", Estado: "Convite expirado", "Cargo principal": "Parceiro", "Parques ativos": "", "ID utilizador": "cmp2" },
  ];
  const { rows, errors } = parseAgentSheetRows(sheet);
  it("lê ID, telefone, cargo, estado e as cidades dos parques", () => {
    expect(errors).toEqual([]);
    expect(rows[1]).toMatchObject({ name: "ABOUT DESTINY", email: "reservas@qviagem.com", phone: "963781232", role: "Parceiro", agentUserId: "cmpartner1", cities: ["Faro", "Lisboa"] });
    expect(rows[0].name).toBe("api");
    expect(rows[3].cities).toEqual(["Lisboa"]);
    expect(parseAgentSheetRows([{ Coisa: 1 }]).errors.length).toBe(1);
  });
  it("telefone e estado", () => {
    expect(phoneKey("+351 912 345 678")).toBe(phoneKey("912345678"));
    expect(phoneKey("123")).toBe("");
    expect(isInactiveAgentState("Inativo")).toBe(true);
    expect(isInactiveAgentState("Convite expirado")).toBe(true);
    expect(isInactiveAgentState("Ativo")).toBe(false);
  });
  it("liga pelo ID do ficheiro; telefone quando o email não bate; parceiros vão para as parcerias", () => {
    const emps = [
      { id: 1, fullName: "Bruno Meireles", emails: ["bruno@gmail.com"], agentIds: [] },
      { id: 2, fullName: "José Telefone Silva", emails: ["ze.antigo@gmail.com"], agentIds: [], phones: ["912345678"] },
      { id: 3, fullName: "Ana Ligada", emails: [], agentIds: ["cmana"] },
    ];
    const partners = { partnerships: [{ id: 50, name: "QViagem", contactEmail: "geral@qviagem.com" }], mapped: new Map<string, { partnershipId: number; name: string }>() };
    const r = compareAgentRows(rows, [], emps, partners);
    expect(r[0].status).toBe("fora");
    expect(r[1]).toMatchObject({ kind: "agencia", status: "parceiro", partnerSuggestion: { partnershipId: 50, by: "email" }, suggestion: null });
    expect(r[2]).toMatchObject({ agentUserId: "cmbruno", agentMatch: "id", status: "sugestao_email", suggestion: { employeeId: 1 } });
    expect(r[3]).toMatchObject({ agentUserId: "cmze", status: "sugestao_telefone", suggestion: { employeeId: 2, by: "telefone" }, inactive: true });
    expect(r[4]).toMatchObject({ status: "ligado", linkedTo: { employeeId: 3 } });
    expect(r[5]).toMatchObject({ status: "parceiro", partnerSuggestion: null, inactive: true });
    const mapped = new Map([["ABOUT DESTINY", { partnershipId: 50, name: "QViagem" }]]);
    expect(compareAgentRows(rows.slice(1, 2), [], emps, { ...partners, mapped })[0]).toMatchObject({ status: "ligado", partnerLinked: { partnershipId: 50 } });
  });
});

describe("Correção de caixa: o era começa no preço inicial do histórico", () => {
  const initial = { initialPrice: 31, createdAt: "2026-05-01T10:00:00.000Z" };
  it("sem webhooks: preço inicial + método da cópia (sem o preço reescrito da cópia)", () => {
    const copy = copyRowToSnapshot({ externalId: "bk", status: "CHECKED_OUT", parkId: "p1", totalPrice: "45", totalPaid: "45", paymentMethod: "Multibanco", pro: 0, syncedAt: "2026-09-21 03:00:00", rawBookingPrice: "45" });
    const r = compareWithInitialEra([], copy, initial, live());
    expect(r.era[0].eventType).toBe(INITIAL_ERA_EVENT);
    expect(r.era[1].bookingPrice).toBeNull();
    const codes = r.divergences.map((d) => d.code);
    expect(codes).toContain("price_after_creation");
    expect(codes).toContain("method_changed");
    expect(r.divergences.every((d) => d.detail.startsWith("[preço inicial do histórico]"))).toBe(true);
    expect(dayRow(live(), r.era, r.divergences)).toMatchObject({ eraSource: "historico", webhooks: 0, priceFirst: 31 });
  });
  it("com webhooks posteriores: o preço inicial entra antes; sem preço inicial fica como antes", () => {
    const wh = { ...copyRowToSnapshot({ externalId: "bk", totalPrice: "45", paymentMethod: "Dinheiro", syncedAt: "2026-09-28 20:00:00" }), id: 7, eventType: "BOOKING_UPDATED", source: "webhook" } as any;
    const r = compareWithInitialEra([wh], null, initial, live());
    expect(r.era.map((x) => x.eventType)).toEqual([INITIAL_ERA_EVENT, "BOOKING_UPDATED"]);
    expect(dayRow(live(), r.era, r.divergences)).toMatchObject({ eraSource: "webhook", webhooks: 1 });
    expect(compareWithInitialEra([wh], null, null, live()).era).toHaveLength(1);
    expect(compareWithInitialEra([], null, initial, live({ bookingPrice: 31, linesTotal: 31, linesPaid: 31, paymentsTotal: 31 })).divergences).toEqual([]);
  });
});
