/**
 * "Avisar este turno" (pedido 8, Jorge 7 out 2026) — o envio no servidor:
 * canais escolhidos, email mesmo sem WhatsApp configurado (antes o
 * notifyAssignments lançava logo), nunca para dias passados, registo de atividade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ wa: [] as any[], email: [] as any[], logs: [] as any[], emailOn: true, waThrows: false }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => null,
  logActivity: async (x: any) => { state.logs.push(x); },
}));
vi.mock("./extrasAutomation", async (original) => ({
  ...(await original<object>()),
  notifyAssignments: async (date: string, opts: any) => {
    state.wa.push({ date, ...opts });
    if (state.waThrows) throw new Error("Meta em baixo");
    return { total: 1, sent: 1, failed: 0, skipped: 0, rulesSent: 0, optedOut: 0 };
  },
}));
vi.mock("./extrasSchedule", async (original) => ({
  ...(await original<object>()),
  sendScheduleEmails: async (date: string, city: string, opts: any) => { state.email.push({ date, city, ...opts }); return { sent: 1, failed: 0, noEmail: 0, skipped: 0 }; },
}));
vi.mock("./mail/systemMail", async (original) => ({
  ...(await original<object>()),
  isEmailSendConfigured: () => state.emailOn,
}));

import { sendShiftNotice } from "./extrasDiaShift";
import { addDays } from "../shared/lisbonDay";
import { lisbonNow } from "../shared/extrasSchedule";

const env = { t: process.env.WHATSAPP_TOKEN, p: process.env.WHATSAPP_PHONE_NUMBER_ID };
const future = () => addDays(lisbonNow().date, 2);

beforeEach(() => {
  state.wa = []; state.email = []; state.logs = []; state.emailOn = true; state.waThrows = false;
  delete process.env.WHATSAPP_TOKEN; delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});
afterEach(() => {
  if (env.t !== undefined) process.env.WHATSAPP_TOKEN = env.t;
  if (env.p !== undefined) process.env.WHATSAPP_PHONE_NUMBER_ID = env.p;
});

describe("avisar este turno — envio", () => {
  it("sem WhatsApp configurado, o email segue na mesma (só desse turno) e fica o aviso", async () => {
    const r = await sendShiftNotice({ date: future(), city: "lisbon", shift: "night", channels: ["whatsapp", "email"], userId: 7 });
    expect(state.wa).toEqual([]);
    expect(state.email).toEqual([{ date: future(), city: "lisbon", shift: "night" }]);
    expect(r.warnings).toContain("WhatsApp não configurado — só email");
    expect(r.errors).toEqual([]);
  });
  it("só os canais escolhidos; com WhatsApp configurado vai o turno do botão", async () => {
    process.env.WHATSAPP_TOKEN = "t"; process.env.WHATSAPP_PHONE_NUMBER_ID = "p";
    await sendShiftNotice({ date: future(), city: "porto", shift: "morning", channels: ["whatsapp"], userId: 7 });
    expect(state.wa).toEqual([{ date: future(), city: "porto", shift: "morning", createdById: 7 }]);
    expect(state.email).toEqual([]);
  });
  it("uma falha do WhatsApp não impede o email", async () => {
    process.env.WHATSAPP_TOKEN = "t"; process.env.WHATSAPP_PHONE_NUMBER_ID = "p";
    state.waThrows = true;
    const r = await sendShiftNotice({ date: future(), city: "lisbon", shift: "night", channels: ["whatsapp", "email"], userId: 7 });
    expect(r.errors).toEqual(["WhatsApp: Meta em baixo"]);
    expect(state.email).toHaveLength(1);
  });
  it("email por configurar → aviso, nada enviado", async () => {
    state.emailOn = false;
    const r = await sendShiftNotice({ date: future(), city: "lisbon", shift: "night", channels: ["email"], userId: 7 });
    expect(state.email).toEqual([]);
    expect(r.warnings).toContain("Envio de email (Gmail) não configurado — sem email");
  });
  it("dia passado ou sem canais → recusa; fica o registo de atividade do envio", async () => {
    await expect(sendShiftNotice({ date: "2020-01-06", city: "lisbon", shift: "night", channels: ["email"], userId: 7 })).rejects.toThrow(/já passou/);
    await expect(sendShiftNotice({ date: future(), city: "lisbon", shift: "night", channels: [], userId: 7 })).rejects.toThrow(/canal/);
    expect(state.email).toEqual([]);
    await sendShiftNotice({ date: future(), city: "faro", shift: "morning", channels: ["email"], userId: 9 });
    expect(state.logs.at(-1)).toMatchObject({ userId: 9, action: "extras_shift_notify", entity: "extras_dia_assignments" });
    expect(state.logs.at(-1).details).toContain("Avisar este turno");
    expect(state.logs.at(-1).details).toContain("Faro · manhã");
  });
});
