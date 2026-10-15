/**
 * Plano MPV F4 (cache das leituras lentas): as mutations do appRouter que NÃO
 * limpam a cache da pessoa (mutationClearsSlowCalls, server/assistant/
 * slowCallCache.ts) estão todas aprovadas aqui. Uma mutation nova apanhada por
 * um padrão da lista (`*Preview`, `*.markRead`, `notifications.*`, `assistant.*`…)
 * falha este teste até alguém confirmar que não muda o que as ferramentas leem
 * e a juntar a APPROVED (ou mudar-lhe o nome / o padrão).
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "../routers";
import { mutationClearsSlowCalls } from "./slowCallCache";

/** Aprovadas (revistas uma a uma): não mudam os dados que as ferramentas do Multis guardam. */
const APPROVED: readonly string[] = [
  // O próprio Multis (pergunta, memória, 👍/👎, conversas).
  "assistant.ask", "assistant.deleteConversation",
  // Batimentos, presença e aparelhos.
  "googleAccount.sync.heartbeat",
  "operational.pdas.claimOnLogin", "operational.pdas.releaseOnLogout", "operational.pdas.deviceInfo",
  // Marcar como lido.
  "notifications.markRead", "notifications.markAllRead",
  // Só leem.
  "knowledge.open", "googleDrive.sheets.readCsv",
];
/** Prefixos aprovados em bloco (tudo o que está debaixo deles é do mesmo género). */
const APPROVED_PREFIXES: readonly string[] = ["assistant.memory.", "assistant.feedback.", "operational.personalDevices.", "googleAccount.sync."];

const procs = (appRouter as any)._def.procedures as Record<string, { _def: { type: string } }>;
const mutations = Object.entries(procs).filter(([, p]) => p?._def?.type === "mutation").map(([k]) => k).sort();
const skipped = mutations.filter((m) => !mutationClearsSlowCalls(m));

describe("mutations que não limpam a cache do Multis: todas aprovadas", () => {
  it("o appRouter tem mutations e a introspeção funciona", () => {
    expect(mutations.length).toBeGreaterThan(100);
    expect(mutations).toContain("assistant.ask");
    expect(mutations).toContain("expenses.create");
  });

  it("cada mutation apanhada pelos padrões está na lista aprovada (as *Preview e *.markRead/markUnread também)", () => {
    const isPatternApproved = (m: string) => /\.(markRead|markAllRead|markUnread)$/.test(m) || /Preview$/.test(m);
    const unknown = skipped.filter((m) => !APPROVED.includes(m) && !APPROVED_PREFIXES.some((p) => m.startsWith(p)) && !isPatternApproved(m));
    expect(unknown, `Mutations novas que não limpam a cache — rever e aprovar: ${unknown.join(", ")}`).toEqual([]);
  });

  it("as *Preview e *.markRead/markUnread apanhadas: revistas (só pré-visualizam ou marcam como lido)", () => {
    const REVIEWED_PATTERN: readonly string[] = [
      "mail.threads.markRead", "partnerships.mergePreview", "partnerships.mpSyncPreview", "whatsapp.markRead", "whatsapp.markUnread",
    ];
    const byPattern = skipped.filter((m) => /\.(markRead|markAllRead|markUnread)$/.test(m) || /Preview$/.test(m)).filter((m) => !APPROVED.includes(m));
    const notReviewed = byPattern.filter((m) => !REVIEWED_PATTERN.includes(m));
    expect(notReviewed, `Rever (mutations com nome de pré-visualização/lido que não limpam a cache): ${notReviewed.join(", ")}`).toEqual([]);
  });

  it("as aprovadas existem (não fica lixo na lista) e as de negócio limpam", () => {
    for (const m of APPROVED) expect(mutations, m).toContain(m);
    for (const m of ["expenses.create", "reviews.publishReply", "extrasDia.confirmSchedule", "partnerships.update"]) expect(mutationClearsSlowCalls(m), m).toBe(true);
    // training.markItem: abrir (completed:false) não limpa; concluir limpa; sem input, limpa (o lado seguro).
    expect(mutationClearsSlowCalls("training.markItem", { itemType: "video", itemId: 1, completed: false })).toBe(false);
    expect(mutationClearsSlowCalls("training.markItem", { itemType: "video", itemId: 1, completed: true })).toBe(true);
    expect(mutationClearsSlowCalls("training.markItem")).toBe(true);
    expect(mutations).toContain("training.markItem");
    // Caminhos exatos: um nome parecido não é apanhado por engano.
    expect(mutationClearsSlowCalls("operational.pdas.deviceInfoReset")).toBe(true);
  });
});
