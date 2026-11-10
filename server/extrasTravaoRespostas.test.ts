/**
 * Travão das respostas ESCRITAS ao aviso de escala (fase 1): com a resposta
 * automática ligada, uma resposta de um dia passado ou depois de um pedido de
 * disponibilidade não marca nada; "Confirmo" marca o aviso certo. BD simulada,
 * sem IA nem envios reais.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeQuery } from "./_core/ai/testUtils";

const m = vi.hoisted(() => ({
  db: null as unknown,
  classifyUnclear: vi.fn(),
  reply: vi.fn(),
  notify: vi.fn(),
  markDay: vi.fn(),
}));

vi.mock("./db", async (original) => ({ ...(await original<object>()), getDb: async () => m.db }));
vi.mock("./aiOps/availabilityAi", async (original) => ({ ...(await original<object>()), classifyUnclearAvailability: m.classifyUnclear }));
vi.mock("./whatsappInbox", async (original) => ({ ...(await original<object>()), replyToConversation: m.reply }));
vi.mock("./notify", async (original) => ({ ...(await original<object>()), notify: m.notify }));
vi.mock("./extrasAvailability", async (original) => ({ ...(await original<object>()), markDayAvailability: m.markDay }));

import { handleShiftNoticeButton, handleWhatsappReply } from "./extrasAutomation";

const TODAY = "2026-11-08";
const YESTERDAY = "2026-11-07";
const TOMORROW = "2026-11-09";
const SENT_AT = "2026-11-07 15:00:00";
const MSG = { employeeId: 42, conversationId: 5 };

const notice = (targetDate: string, id = 100) => ({ id, kind: "assignment", targetDate, weekStart: null, shift: null, fromHour: null, toHour: null, sentAtText: SENT_AT });
const weekRequest = { id: 200, kind: "week", targetDate: null, weekStart: "2026-11-16", shift: null, fromHour: null, toHour: null, sentAtText: SENT_AT };
const dayRequest = { id: 300, kind: "day", targetDate: TOMORROW, weekStart: null, shift: null, fromHour: null, toHour: null, sentAtText: SENT_AT };

interface Scenario {
  latest?: unknown;
  open?: unknown;
  conversations?: number[];
  templates?: string[];
  failOn?: RegExp;
  button?: unknown;
}

function setup(s: Scenario) {
  const fake = createFakeDb((q: FakeQuery) => {
    if (s.failOn?.test(q.sql)) throw new Error("ligação perdida");
    if (q.sql.startsWith("CREATE TABLE")) return [[]];
    if (q.sql.includes("FROM `availability_request_log` l")) return [s.open ? [s.open] : []];
    if (q.sql.includes("FROM `availability_request_log`")) return [s.latest ? [s.latest] : []];
    if (q.sql.includes("FROM `whatsapp_conversations`")) return [(s.conversations ?? []).map((id) => ({ id }))];
    if (q.sql.includes("FROM `whatsapp_messages`")) return [(s.templates ?? []).map((templateName) => ({ templateName }))];
    if (q.sql.includes("FROM whatsapp_messages m")) return [s.button ? [s.button] : []];
    if (q.sql.startsWith("INSERT IGNORE INTO `whatsapp_request_answers`")) return [{ affectedRows: 1 }];
    if (q.sql.startsWith("UPDATE `extras_dia_notices`")) return [{ affectedRows: 1 }];
    return [[]];
  });
  const noRows = () => ({ where: () => Object.assign(Promise.resolve([]), { limit: async () => [] }) });
  m.db = { ...fake, select: () => ({ from: noRows }) };
  return {
    queries: fake.queries,
    noticeUpdates: () => fake.queries.filter((q) => q.sql.startsWith("UPDATE `extras_dia_notices`")),
    claims: () => fake.queries.filter((q) => q.sql.startsWith("INSERT IGNORE INTO `whatsapp_request_answers`")),
    messageChecks: () => fake.queries.filter((q) => q.sql.includes("FROM `whatsapp_messages`")),
  };
}

function expectNothingHappened(t: ReturnType<typeof setup>) {
  expect(m.classifyUnclear).not.toHaveBeenCalled();
  expect(m.reply).not.toHaveBeenCalled();
  expect(m.notify).not.toHaveBeenCalled();
  expect(m.markDay).not.toHaveBeenCalled();
  expect(t.noticeUpdates()).toHaveLength(0);
  expect(t.claims()).toHaveLength(0);
}

const saved = { own: process.env.EXTRAS_AVAILABILITY_AUTO_REPLY, parent: process.env.EXTRAS_AUTOMATION };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  process.env.EXTRAS_AVAILABILITY_AUTO_REPLY = "on";
  m.classifyUnclear.mockReset().mockResolvedValue({ action: "review", reason: "pouco clara", ai: { intent: "unclear", days: [], fromHour: null, toHour: null, confidence: 0.3 } });
  m.reply.mockReset().mockResolvedValue(undefined);
  m.notify.mockReset().mockResolvedValue(undefined);
  m.markDay.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, v] of [["EXTRAS_AVAILABILITY_AUTO_REPLY", saved.own], ["EXTRAS_AUTOMATION", saved.parent]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("aviso de um dia passado", () => {
  it.each(["Sim", "Não posso", "Talvez, vou ver", "Confirmo"])("'%s' não chama a IA, não marca, não responde nem avisa", async (body) => {
    const t = setup({ latest: notice(YESTERDAY) });
    expect(await handleWhatsappReply({ ...MSG, body })).toEqual({ action: "none" });
    expectNothingHappened(t);
    expect(t.messageChecks()).toHaveLength(0);
  });

  it("o dia é o de Lisboa, não o UTC: às 00:30 de Lisboa o dia de ontem já passou", async () => {
    vi.setSystemTime(new Date("2026-07-14T23:30:00Z")); // 15 jul, 00:30 em Lisboa
    const t = setup({ latest: notice("2026-07-14") });
    expect(await handleWhatsappReply({ ...MSG, body: "Sim" })).toEqual({ action: "none" });
    expectNothingHappened(t);
  });

  it("'Confirmo' com outro aviso ainda aberto vai para esse", async () => {
    const t = setup({ latest: notice(YESTERDAY), open: notice(TOMORROW, 101) });
    expect((await handleWhatsappReply({ ...MSG, body: "Confirmo" })).action).toBe("confirmed");
    expect(t.noticeUpdates()[0].params).toEqual([MSG.employeeId, TOMORROW]);
    expect(t.claims()[0].params).toContain(101);
  });
});

describe("pedido de disponibilidade enviado depois do aviso", () => {
  const afterBroadcast = { latest: notice(TOMORROW), conversations: [7], templates: ["driver_availability"] };

  it.each(["Sim, posso segunda", "Sim", "Não consigo esta semana", "Talvez"])("'%s' não marca o turno nem chama a IA", async (body) => {
    const t = setup(afterBroadcast);
    expect(await handleWhatsappReply({ ...MSG, body })).toEqual({ action: "none" });
    expectNothingHappened(t);
  });

  it("'Confirmo' marca o aviso certo, sem precisar de ler as mensagens", async () => {
    const t = setup(afterBroadcast);
    expect((await handleWhatsappReply({ ...MSG, body: "Confirmo" })).action).toBe("confirmed");
    expect(t.noticeUpdates()).toHaveLength(1);
    expect(t.noticeUpdates()[0].params).toEqual([MSG.employeeId, TOMORROW]);
    expect(t.claims()[0].params).toContain(100);
    expect(t.messageChecks()).toHaveLength(0);
    expect(m.classifyUnclear).not.toHaveBeenCalled();
  });

  it("vê as cidades todas e as duas conversas da pessoa", async () => {
    const t = setup({ ...afterBroadcast, templates: ["disponibilidade_extras_porto"] });
    expect(await handleWhatsappReply({ ...MSG, body: "Sim" })).toEqual({ action: "none" });
    expect(t.noticeUpdates()).toHaveLength(0);
    const [check] = t.messageChecks();
    expect(check.params).toEqual(expect.arrayContaining([MSG.conversationId, 7, SENT_AT]));
  });

  it("procura a conversa desta mensagem mesmo sem conversa ligada à ficha", async () => {
    const t = setup({ ...afterBroadcast, conversations: [] });
    expect(await handleWhatsappReply({ ...MSG, body: "Sim" })).toEqual({ action: "none" });
    expect(t.messageChecks()[0].params).toEqual(expect.arrayContaining([MSG.conversationId, SENT_AT]));
  });

  it("só conta o que saiu de nós, depois do aviso e não falhado", async () => {
    const t = setup(afterBroadcast);
    await handleWhatsappReply({ ...MSG, body: "Sim" });
    const [check] = t.messageChecks();
    expect(check.sql).toContain("direction = 'out'");
    expect(check.sql).toContain("status <> 'failed'");
    expect(check.sql).toContain("createdAt >= ?");
  });

  it("outros templates não travam: o 'Sim' confirma", async () => {
    const t = setup({ ...afterBroadcast, templates: ["driver_shift_notice", "turno_confirmado_lisboa"] });
    expect((await handleWhatsappReply({ ...MSG, body: "Sim" })).action).toBe("confirmed");
    expect(t.noticeUpdates()).toHaveLength(1);
  });

  it("erro da BD na verificação: não marca, sem o texto da mensagem no registo", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup({ latest: notice(TOMORROW), failOn: /FROM `whatsapp_messages`/ });
    expect(await handleWhatsappReply({ ...MSG, body: "Sim, segredo" })).toEqual({ action: "none" });
    expectNothingHappened(t);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("segredo");
  });

  it("aviso sem data de envio: não se sabe se houve pedido depois, fica travado", async () => {
    const t = setup({ latest: { ...notice(TOMORROW), sentAtText: null } });
    expect(await handleWhatsappReply({ ...MSG, body: "Sim" })).toEqual({ action: "none" });
    expectNothingHappened(t);
  });
});

describe("'Confirmo' quando o último pedido é de disponibilidade", () => {
  it("com último pedido da semana e aviso de amanhã aberto, marca esse e não manda o link", async () => {
    const t = setup({ latest: weekRequest, open: notice(TOMORROW, 101) });
    expect((await handleWhatsappReply({ ...MSG, body: "Sim, confirmo" })).action).toBe("confirmed");
    expect(t.noticeUpdates()[0].params).toEqual([MSG.employeeId, TOMORROW]);
    expect(t.claims()[0].params).toContain(101);
  });

  it("a procura só aceita avisos de hoje em diante, dos últimos 10 dias e sem resposta", async () => {
    const t = setup({ latest: weekRequest, open: notice(TOMORROW, 101) });
    await handleWhatsappReply({ ...MSG, body: "Confirmo" });
    const lookup = t.queries.find((q) => q.sql.includes("FROM `availability_request_log` l"))!;
    expect(lookup.sql).toContain("l.kind = 'assignment'");
    expect(lookup.sql).toContain("l.targetDate >= ?");
    expect(lookup.sql).toContain("INTERVAL 10 DAY");
    expect(lookup.sql).toContain("NOT EXISTS (SELECT 1 FROM `whatsapp_request_answers` a WHERE a.requestId = l.id)");
    expect(lookup.sql).toContain("ORDER BY l.sentAt DESC, l.id DESC LIMIT 1");
    expect(lookup.params).toEqual([MSG.employeeId, TODAY]);
  });

  it("sem aviso aberto segue como hoje: link da semana", async () => {
    const t = setup({ latest: weekRequest });
    expect((await handleWhatsappReply({ ...MSG, body: "Confirmo" })).action).toBe("week_link");
    expect(t.noticeUpdates()).toHaveLength(0);
  });

  it("erro da BD na procura: não manda o link nem marca", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup({ latest: weekRequest, failOn: /FROM `availability_request_log` l/ });
    expect(await handleWhatsappReply({ ...MSG, body: "Confirmo" })).toEqual({ action: "none" });
    expectNothingHappened(t);
    expect(warn).toHaveBeenCalled();
  });
});

describe("o resto não muda", () => {
  it("aviso de hoje ou amanhã sem pedido depois: 'Sim' confirma, 'Não' recusa e avisa", async () => {
    for (const date of [TODAY, TOMORROW]) {
      const yes = setup({ latest: notice(date) });
      expect((await handleWhatsappReply({ ...MSG, body: "Sim" })).action).toBe("confirmed");
      expect(yes.noticeUpdates()[0].params).toEqual([MSG.employeeId, date]);
    }
    setup({ latest: notice(TOMORROW) });
    expect((await handleWhatsappReply({ ...MSG, body: "Não posso" })).action).toBe("declined");
    expect(m.notify).toHaveBeenCalledTimes(1);
  });

  it("resposta pouco clara a um aviso em aberto: continua a ir à IA", async () => {
    setup({ latest: notice(TOMORROW) });
    expect((await handleWhatsappReply({ ...MSG, body: "Talvez" })).action).toBe("none");
    expect(m.classifyUnclear).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledTimes(1);
  });

  it("pedido da semana e de um dia: 'Sim' como sempre, sem verificar mensagens", async () => {
    const week = setup({ latest: weekRequest, templates: ["driver_availability"] });
    expect((await handleWhatsappReply({ ...MSG, body: "Sim" })).action).toBe("week_link");
    expect(week.messageChecks()).toHaveLength(0);

    const day = setup({ latest: dayRequest, templates: ["driver_availability"] });
    expect((await handleWhatsappReply({ ...MSG, body: "Sim" })).action).toBe("day_marked");
    expect(m.markDay).toHaveBeenCalledTimes(1);
    expect(day.messageChecks()).toHaveLength(0);
  });

  it("interruptor desligado: não lê nada, a mensagem fica na caixa", async () => {
    process.env.EXTRAS_AVAILABILITY_AUTO_REPLY = "off";
    const t = setup({ latest: notice(TOMORROW) });
    expect(await handleWhatsappReply({ ...MSG, body: "Confirmo" })).toEqual({ action: "none" });
    expect(t.queries).toHaveLength(0);
  });
});

describe("leitura da IA 'disponível' num aviso de escala", () => {
  const aiYes = (fromHour: number | null, toHour: number | null) => ({ action: "apply_yes", days: [TOMORROW], fromHour, toHour, confidence: 0.95 });
  const BODY = "O máximo posso tentar entre as 16h e as 17h";

  it.each([[16, 17], [16, null], [null, 17]])("com horas (%s–%s): não confirma, vai para o sino com a nota da IA", async (fromHour, toHour) => {
    const t = setup({ latest: notice(TOMORROW) });
    m.classifyUnclear.mockResolvedValue(aiYes(fromHour, toHour));
    expect(await handleWhatsappReply({ ...MSG, body: BODY })).toEqual({ action: "none", aiRead: true });
    expect(t.noticeUpdates()).toHaveLength(0);
    expect(t.claims()).toHaveLength(0);
    expect(m.reply).not.toHaveBeenCalled();
    expect(m.notify).toHaveBeenCalledTimes(1);
    const sent = m.notify.mock.calls[0][0];
    expect(sent.kind).toBe("extras_schedule_reply");
    expect(sent.body).toContain("[IA: disponível");
    if (fromHour != null) expect(sent.body).toContain(`das ${fromHour}h`);
    if (toHour != null) expect(sent.body).toContain(`às ${toHour}h`);
    expect(sent.body).toContain(BODY);
  });

  it("sem horas: confirma como até aqui", async () => {
    const t = setup({ latest: notice(TOMORROW) });
    m.classifyUnclear.mockResolvedValue(aiYes(null, null));
    expect(await handleWhatsappReply({ ...MSG, body: "Talvez, mas acho que sim" })).toMatchObject({ action: "confirmed", aiRead: true });
    expect(t.noticeUpdates()).toHaveLength(1);
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("pedido de um dia e da semana com horas: não muda, marca com as horas lidas", async () => {
    setup({ latest: dayRequest });
    m.classifyUnclear.mockResolvedValue(aiYes(16, 17));
    expect((await handleWhatsappReply({ ...MSG, body: BODY })).action).toBe("day_marked");
    expect(m.markDay).toHaveBeenLastCalledWith(MSG.employeeId, TOMORROW, expect.objectContaining({ fromHour: 16, toHour: 17 }));

    setup({ latest: weekRequest });
    m.classifyUnclear.mockResolvedValue({ ...aiYes(16, 17), days: ["2026-11-17"] });
    expect((await handleWhatsappReply({ ...MSG, body: BODY })).action).toBe("day_marked");
    expect(m.markDay).toHaveBeenLastCalledWith(MSG.employeeId, "2026-11-17", expect.objectContaining({ fromHour: 16, toHour: 17 }));
    expect(m.notify).not.toHaveBeenCalled();
  });
});

describe("botão do aviso (não passa pelo travão)", () => {
  const button = (date: string) => ({ conversationId: MSG.conversationId, templateName: "driver_shift_notice", note: `Aviso de escala ${date}` });
  const press = (text: string) => handleShiftNoticeButton({ ...MSG, contextId: "wamid.aviso", text, payload: text });

  it.each([
    ["Confirmo", YESTERDAY],
    ["Confirmo", TOMORROW],
    ["Não posso", YESTERDAY],
  ])("'%s' no aviso de %s marca, mesmo com um pedido de disponibilidade depois", async (text, date) => {
    const t = setup({ button: button(date), latest: notice(date), templates: ["driver_availability"] });
    expect(await press(text)).toBe(true);
    expect(t.noticeUpdates()).toHaveLength(1);
    expect(t.noticeUpdates()[0].params).toEqual([MSG.employeeId, date]);
    expect(t.messageChecks()).toHaveLength(0);
  });

  it("botão de um template que não é o aviso: segue para a leitura do texto, que trava", async () => {
    const t = setup({ button: { ...button(TOMORROW), templateName: "driver_availability" }, latest: notice(YESTERDAY) });
    expect(await press("Confirmo")).toBe(false);
    expect(await handleWhatsappReply({ ...MSG, body: "Confirmo" })).toEqual({ action: "none" });
    expectNothingHappened(t);
  });
});
