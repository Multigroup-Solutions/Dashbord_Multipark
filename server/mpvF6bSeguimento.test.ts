/**
 * Plano MPV F6b (seguimento): desfazer repetidas marcadas à entrada, urgência
 * só forte nas respostas de disponibilidade, memória da limpeza e a mesma
 * leitura de IA para duas cópias do mesmo email. Sem IA real nem BD.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as any[],
  sets: [] as any[],
  runAi: vi.fn(async (_o: any) => ({ output: { box: "info", confidence: 0.9, reason: "x" }, model: "m-1" })),
}));

vi.mock("./db", async (orig) => {
  const actual: any = await orig();
  const chain = (rows: any[]) => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) });
  return {
    ...actual,
    getDb: async () => ({
      select: () => chain(h.rows),
      update: () => ({ set: (x: any) => ({ where: async () => { h.sets.push(x); return [{ affectedRows: 1 }]; } }) }),
    }),
  };
});
vi.mock("./_core/ai/run", () => ({ runAi: h.runAi }));

import { entryDuplicateBackup, parseMarkBackup, rawEmailNeeded, undoReviewCleanup } from "./reviewCleanup";
import { whatsappTriageGate, whatsappUrgentByWords } from "../shared/commsAi";
import { urgencyByRule } from "./whatsappTriage";
import { classifyEmailWithAi, clearMailReadCache, mailReadCacheGet, mailReadCacheKey, mailReadCacheSet, MAIL_READ_CACHE_TTL_MS } from "./commsRouting";

beforeEach(() => {
  h.rows = [];
  h.sets = [];
  h.runAi.mockClear();
  clearMailReadCache();
});

describe("1 — desfazer uma repetida marcada à entrada", () => {
  it("a cópia da entrada diz que não havia tentativa de rascunho", () => {
    expect(parseMarkBackup(entryDuplicateBackup())).toMatchObject({ hasAttempted: true, aiDraftAttemptedAt: null });
    const src = readFileSync("server/jobs/emailInboundSync.ts", "utf8");
    expect(src).toContain("aiDraftAttemptedAt: markedAt, reviewMarkBackup: entryDuplicateBackup()");
  });

  it("desfazer repõe aiDraftAttemptedAt a NULL e limpa a cópia; marcada pela limpeza (sem cópia) não mexe na tentativa", async () => {
    h.rows = [{ id: 5, aiResponse: null, status: "pending_response", backup: entryDuplicateBackup() }];
    expect(await undoReviewCleanup("duplicate", [5])).toEqual({ undone: 1, ids: [5] });
    expect(h.sets[0]).toMatchObject({ duplicateOf: null, reviewMarkBackup: null, aiDraftAttemptedAt: null });

    h.sets = [];
    h.rows = [{ id: 6, aiResponse: null, status: "pending_response", backup: null }];
    await undoReviewCleanup("duplicate", [6]);
    expect(h.sets[0]).toMatchObject({ duplicateOf: null });
    expect("aiDraftAttemptedAt" in h.sets[0]).toBe(false);
  });
});

describe("2 — urgência por regra nas respostas de disponibilidade: só as palavras fortes", () => {
  const avail = whatsappTriageGate({ skipStaff: true, isStaff: true, urgentWords: true, intent: null, lastTriagedAt: null, nowMs: 0, availabilityAiRead: true });

  it("'obrigado pela ajuda' e 'abro o portão às 6h' não ficam urgentes na resposta de disponibilidade", () => {
    expect(urgencyByRule(avail, "Sim, posso. Obrigado pela ajuda")).toBe(false);
    expect(urgencyByRule(avail, "Posso, abro o portão às 6h")).toBe(false);
    expect(urgencyByRule(avail, "Não posso, tive um acidente ontem")).toBe(true);
    expect(urgencyByRule(avail, "Hoje não, o carro avariou")).toBe(true);
    expect(urgencyByRule(avail, "Sem urgência, posso sábado")).toBe(false);
  });

  it("nas conversas normais de colaboradores o conjunto alargado mantém-se (essas vão à IA)", () => {
    expect(whatsappUrgentByWords("Obrigado pela ajuda")).toBe(true);
    expect(whatsappUrgentByWords("abro o portão às 6h")).toBe(true);
    expect(whatsappUrgentByWords("Obrigado pela ajuda", { strongOnly: true })).toBe(false);
    expect(whatsappUrgentByWords("o portão não abre", { strongOnly: true })).toBe(false);
    // Só há urgência por regra no ramo da disponibilidade.
    const staff = whatsappTriageGate({ skipStaff: true, isStaff: true, urgentWords: false, intent: "recrutamento", lastTriagedAt: "1970-01-01 00:00:00", nowMs: 1000, availabilityAiRead: false });
    expect(urgencyByRule(staff, "tive um acidente")).toBe(false);
  });
});

describe("3 — memória da limpeza", () => {
  it("só se carrega o email das candidatas", () => {
    const email = { sourceEmailId: "<a>", googleReviewKey: null, notAReview: 0, duplicateOf: null };
    expect(rawEmailNeeded("duplicate", email, 5)).toBe(true);
    expect(rawEmailNeeded("duplicate", email, 0)).toBe(false);
    expect(rawEmailNeeded("not_review", email, 0)).toBe(true);
    expect(rawEmailNeeded("not_review", email, 4)).toBe(false);
    expect(rawEmailNeeded("duplicate", { ...email, googleReviewKey: "k" }, 5)).toBe(false);
    expect(rawEmailNeeded("duplicate", { ...email, duplicateOf: 3 }, 5)).toBe(false);
    expect(rawEmailNeeded("not_review", { ...email, notAReview: 1 }, 0)).toBe(false);
    expect(rawEmailNeeded("not_review", { ...email, sourceEmailId: null }, 0)).toBe(false);
  });
  it("o corpo lê-se cortado (SUBSTRING até 8000)", () => {
    const src = readFileSync("server/reviewCleanup.ts", "utf8");
    expect(src).toContain("SUBSTRING(bodyText, 1, ${RAW_BODY_MAX}) AS bodyText FROM inbound_emails");
    expect(src).toContain("SUBSTRING(bodyText, 1, ${RAW_BODY_MAX}) AS bodyText FROM mail_messages");
    expect(src).toContain("export const RAW_BODY_MAX = 8000;");
  });
});

describe("4 — duas cópias do mesmo email: uma só leitura de IA", () => {
  const msg = (messageId: number) => ({
    threadId: messageId, messageId, fromBoxKey: "info", subject: "Reserva de novembro", text: "Queria reservar de 3 a 9 de novembro.",
    fromName: "Ana", fromEmail: "ana@gmail.com", attachmentNames: [], projectId: null, senderKind: "external" as const,
  });
  it("a 2.ª cópia (outra conta, mesmo pedido) reaproveita a 1.ª leitura", async () => {
    const a = await classifyEmailWithAi(msg(1), "Info");
    const b = await classifyEmailWithAi(msg(2), "Info");
    expect(h.runAi).toHaveBeenCalledTimes(1);
    expect(b.output).toEqual(a.output);
  });
  it("outro texto ou outra caixa → outra leitura; a avaliação nunca usa a cache", async () => {
    await classifyEmailWithAi(msg(1), "Info");
    await classifyEmailWithAi({ ...msg(2), text: "Queria cancelar." }, "Info");
    await classifyEmailWithAi(msg(3), "Reservas");
    await classifyEmailWithAi(msg(4), "Info", { thinkingFromCaller: true });
    expect(h.runAi).toHaveBeenCalledTimes(4);
  });
  it("a leitura guardada expira (30 min)", () => {
    const k = mailReadCacheKey("s", "i");
    mailReadCacheSet(k, { output: { box: "info" } as any, model: "m" }, 0);
    expect(mailReadCacheGet(k, 1000)).toBeTruthy();
    expect(mailReadCacheGet(k, MAIL_READ_CACHE_TTL_MS + 1)).toBeNull();
  });
});
