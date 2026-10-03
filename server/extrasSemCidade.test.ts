/**
 * P3 lote 17g (parte 3) — extra sem cidade: pede-se a cidade (uma vez, por
 * email e por WhatsApp se a conversa estiver aberta; com interruptor desligado
 * por omissão) e cria-se a tarefa para a Márcia com prazo de uma semana.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  email: { ok: true } as { ok: boolean; blocked?: boolean },
  reply: { ok: true } as { ok: boolean; optedOut?: boolean },
  noAutoWa: new Set<number>(),
  sentEmails: [] as any[],
  replies: [] as Array<{ id: number; text: string }>,
}));
vi.mock("./mail/systemMail", () => ({ sendEmailDetailed: async (o: any) => { h.sentEmails.push(o); return h.email; } }));
vi.mock("./contactPrefs", () => ({ employeesWithNoAuto: async (ids: number[]) => new Set(ids.filter((i) => h.noAutoWa.has(i))) }));
vi.mock("./whatsappInbox", () => ({ replyToConversation: async (id: number, text: string) => { h.replies.push({ id, text }); return h.reply; } }));
vi.mock("./db", () => ({ getSystemUserId: async () => 1 }));

import { askExtraCity } from "./employeeCityFix";
import { askedSummary, cityRequestMessage, cityTaskDueDate } from "../shared/extrasCityRequest";
import { automationFlagDefault } from "../shared/appSettings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const text = (q: any): string => (q?.queryChunks ?? []).map((c: any) => (c && typeof c === "object" && Array.isArray(c.value) ? c.value.join("") : "?")).join("");

function fakeDb(o: { askedBefore?: boolean; conv?: boolean } = {}) {
  const writes: string[] = [];
  return {
    writes,
    async execute(q: any) {
      const t = text(q);
      // 20c: o "já pedida" vive na ficha (employees.cityRequestedAt), não nos logs.
      if (t.includes("SELECT cityRequestedAt FROM employees")) return [[{ cityRequestedAt: o.askedBefore ? "2026-01-01 10:00:00" : null }]];
      if (t.includes("FROM whatsapp_conversations WHERE employeeId")) return [o.conv === false ? [] : [{ id: 9 }]];
      writes.push(t);
      return [{ insertId: 1 }];
    },
  };
}
const extra = { id: 42, fullName: "Ana Sousa", position: "extra", email: "ana@gmail.com", personalEmail: null };

beforeEach(() => {
  h.email = { ok: true }; h.reply = { ok: true }; h.noAutoWa = new Set(); h.sentEmails = []; h.replies = [];
});

describe("Pedir a cidade a um extra", () => {
  it("email pela recursos-humanos@ e WhatsApp com a conversa aberta; fica registado (não volta a pedir)", async () => {
    const d = fakeDb();
    expect(await askExtraCity(d, extra)).toEqual({ email: "sent", whatsapp: "sent" });
    expect(h.sentEmails[0]).toMatchObject({ to: "ana@gmail.com", from: "recursos-humanos@multipark.pt", auto: { kind: "city_request", employeeId: 42 } });
    expect(h.replies).toEqual([{ id: 9, text: cityRequestMessage("Ana Sousa").whatsapp }]);
    expect(d.writes.some((w) => w.includes("'extra_city_requested'"))).toBe(true);
  });
  it("já pedida antes → não pede outra vez", async () => {
    const d = fakeDb({ askedBefore: true });
    expect(await askExtraCity(d, extra)).toMatchObject({ previously: true });
    expect(h.sentEmails).toHaveLength(0);
    expect(h.replies).toHaveLength(0);
  });
  it("janela fechada → só email; 'Não enviar' → nada sai por esse canal", async () => {
    h.reply = { ok: false };
    expect(await askExtraCity(fakeDb(), extra)).toEqual({ email: "sent", whatsapp: "closed" });
    h.noAutoWa = new Set([42]); h.email = { ok: false, blocked: true }; h.replies = [];
    expect(await askExtraCity(fakeDb(), extra)).toEqual({ email: "blocked", whatsapp: "blocked" });
    expect(h.replies).toHaveLength(0);
  });
  it("o email falhou → não fica registado (tenta na próxima hora)", async () => {
    h.email = { ok: false };
    const d = fakeDb({ conv: false });
    expect(await askExtraCity(d, extra)).toEqual({ email: "failed", whatsapp: "no_contact" });
    expect(d.writes.some((w) => w.includes("'extra_city_requested'"))).toBe(false);
  });
});

describe("Textos, prazo e interruptor", () => {
  it("pergunta Lisboa, Porto ou Faro, pelo primeiro nome", () => {
    const m = cityRequestMessage("Ana Maria Sousa");
    expect(m.text).toContain("Olá Ana,");
    expect(m.whatsapp).toContain("Lisboa, Porto ou Faro?");
    expect(m.subject).toBe("Multipark — em que cidade queres trabalhar?");
  });
  it("a tarefa diz o que já se fez", () => {
    expect(askedSummary({ email: "sent", whatsapp: "sent" })).toBe("Já lhe pedimos a cidade por email e WhatsApp; se não responder, contacta-o(a).");
    expect(askedSummary({ email: "blocked", whatsapp: "closed" })).toContain("Não foi possível pedir-lhe a cidade automaticamente");
    expect(askedSummary(null)).toContain("interruptor desligado ou não é extra");
  });
  it("prazo: hoje (Lisboa) + 7 dias", () => {
    expect(cityTaskDueDate(new Date("2026-10-02T10:00:00Z"))).toBe("2026-10-09 00:00:00");
    expect(cityTaskDueDate(new Date("2026-10-31T23:30:00Z"))).toBe("2026-11-07 00:00:00"); // inverno: Lisboa = UTC
  });
  it("o pedido ao extra fica desligado por omissão; a tarefa leva o prazo e o resumo", () => {
    expect(automationFlagDefault("EXTRAS_ASK_CITY")).toBe(false);
    const f = src("server/employeeCityFix.ts");
    expect(f).toContain("INSERT INTO tasks (title, description, createdById, taskStatus, taskPriority, dueDate, sourceModule, sourceId, sourceKey)");
    expect(f).toContain("${systemUser}, 'todo', 'high', ${cityTaskDueDate()}, 'rh', ${e.id}, ${key})");
    expect(f).toContain('const asked = askOn && e.position === "extra" ? await askExtraCity(d, e) : null;');
  });
});
