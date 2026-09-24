import { describe, expect, it } from "vitest";
import {
  AttemptError, assertCanStartAttempt, assignmentStatusFor, attemptsLeftToday, certificateStatus, certificateValidUntil,
  computePathProgress, escalaEligibility, isReminderHour, pickQuestions, promotionPatch, rankBestScores, selectReminders,
  trainingBlocksEscalaEnabled, trainingRemindersEnabled, validateSubmission,
} from "./trainingRules";
import { parseDraftQuestions } from "./trainingAttempts";
import { MIGRATION_0090_STATEMENTS, IDEMPOTENT_ERROR_CODES_0090 } from "./migrations/migration_0090";

const NOW = new Date("2026-09-24T10:00:00Z"); // 11:00 em Lisboa

describe("elegibilidade para a escala", () => {
  const pending = { pathName: "Onboarding extras", status: "in_progress", pathActive: 1, blocksEscala: 1 };
  it("bloqueia com formação obrigatória por concluir", () => {
    const r = escalaEligibility({ assignments: [pending], enabled: true });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["Onboarding extras"]);
    expect(r.message).toMatch(/Formação obrigatória por concluir/);
  });
  it("deixa passar concluída, inativa ou que não bloqueia", () => {
    expect(escalaEligibility({ assignments: [{ ...pending, status: "completed" }], enabled: true }).ok).toBe(true);
    expect(escalaEligibility({ assignments: [{ ...pending, pathActive: 0 }], enabled: true }).ok).toBe(true);
    expect(escalaEligibility({ assignments: [{ ...pending, blocksEscala: 0 }], enabled: true }).ok).toBe(true);
    expect(escalaEligibility({ assignments: [], enabled: true }).ok).toBe(true);
  });
  it("override só conta para quem pode forçar", () => {
    expect(escalaEligibility({ assignments: [pending], enabled: true, override: true, canOverride: false }).ok).toBe(false);
    const r = escalaEligibility({ assignments: [pending], enabled: true, override: true, canOverride: true });
    expect(r).toMatchObject({ ok: true, overridden: true, missing: ["Onboarding extras"] });
  });
  it("feature flag TRAINING_BLOCKS_ESCALA=off desliga", () => {
    expect(trainingBlocksEscalaEnabled({ TRAINING_BLOCKS_ESCALA: "off" })).toBe(false);
    expect(trainingBlocksEscalaEnabled({ TRAINING_BLOCKS_ESCALA: "OFF " })).toBe(false);
    expect(trainingBlocksEscalaEnabled({})).toBe(true);
    expect(escalaEligibility({ assignments: [pending], enabled: false }).ok).toBe(true);
  });
});

describe("validação de tentativas", () => {
  const base = { servedIds: [1, 2, 3], startedAt: "2026-09-24 09:50:00", deadlineAt: "2026-09-24 10:20:00", submittedAt: null, now: NOW };
  const all = [{ questionId: 1, answer: "A" }, { questionId: 2, answer: "B" }, { questionId: 3, answer: "C" }];
  it("aceita todas respondidas dentro do tempo", () => {
    expect(validateSubmission({ ...base, answers: all })).toBe("ok");
  });
  it("recusa submissão parcial antes do prazo (sondar respostas)", () => {
    expect(() => validateSubmission({ ...base, answers: all.slice(0, 1) })).toThrow(/todas as perguntas/);
  });
  it("recusa perguntas não servidas, repetidas ou tentativa já submetida", () => {
    expect(() => validateSubmission({ ...base, answers: [...all, { questionId: 9, answer: "A" }] })).toThrow(AttemptError);
    expect(() => validateSubmission({ ...base, answers: [all[0], all[0], all[1]] })).toThrow(/uma resposta/);
    expect(() => validateSubmission({ ...base, submittedAt: "2026-09-24 09:55:00", answers: all })).toThrow(/já foi submetida/);
  });
  it("tempo: parcial aceite depois do prazo (até +30s) e expira para lá da tolerância", () => {
    const after = new Date("2026-09-24T10:20:10Z");
    expect(validateSubmission({ ...base, now: after, answers: all.slice(0, 2) })).toBe("timed_out");
    expect(validateSubmission({ ...base, now: after, answers: all })).toBe("ok");
    const late = new Date("2026-09-24T10:20:31Z");
    expect(validateSubmission({ ...base, now: late, answers: all })).toBe("expired");
  });
  it("sem limite de tempo nunca expira mas exige todas", () => {
    expect(validateSubmission({ ...base, deadlineAt: null, now: new Date("2027-01-01T00:00:00Z"), answers: all })).toBe("ok");
    expect(() => validateSubmission({ ...base, deadlineAt: null, answers: [] })).toThrow();
  });
  it("tentativas por dia contam o dia de Lisboa", () => {
    // 23:30 UTC de 23/09 = 00:30 de 24/09 em Lisboa (verão) → conta hoje
    const starts = ["2026-09-23 23:30:00", "2026-09-24 08:00:00", "2026-09-23 10:00:00"];
    expect(attemptsLeftToday(starts, NOW, 3)).toBe(1);
    expect(() => assertCanStartAttempt(starts, NOW, 2)).toThrow(/2 tentativa/);
    expect(() => assertCanStartAttempt(starts, NOW, 3)).not.toThrow();
  });
  it("pickQuestions baralha sem repetir e corta", () => {
    let i = 0; const seq = [0.1, 0.9, 0.5, 0.3];
    const out = pickQuestions([1, 2, 3, 4, 5], 3, () => seq[i++ % seq.length]);
    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(3);
  });
});

describe("ranking por melhor pontuação", () => {
  it("ordena pela melhor pontuação (não pela soma) e desempata por menos jogos", () => {
    const r = rankBestScores([
      { employeeId: 1, bestScore: 80, attempts: 20 }, // muitos jogos, não ganha por volume
      { employeeId: 2, bestScore: 100, attempts: 3 },
      { employeeId: 3, bestScore: 80, attempts: 2 },
    ]);
    expect(r.map(x => x.employeeId)).toEqual([2, 3, 1]);
    expect(r[0].position).toBe(1);
  });
  it("respeita o limite", () => {
    expect(rankBestScores([{ employeeId: 1, bestScore: 1, attempts: 1 }, { employeeId: 2, bestScore: 2, attempts: 1 }], 1)).toHaveLength(1);
  });
});

describe("lembretes", () => {
  const row = (o: Partial<Parameters<typeof selectReminders>[0][number]>) => ({ id: 1, status: "assigned", dueAt: "2026-09-25 10:00:00", lastReminderAt: null, escalatedAt: null, ...o });
  it("lembra quem vence em ≤2 dias ou está em atraso, 1×/dia", () => {
    const r = selectReminders([
      row({ id: 1 }), // vence amanhã
      row({ id: 2, dueAt: "2026-09-30 10:00:00" }), // longe
      row({ id: 3, status: "completed" }),
      row({ id: 4, lastReminderAt: "2026-09-24 08:00:00" }), // já hoje
      row({ id: 5, lastReminderAt: "2026-09-23 08:00:00" }), // ontem → volta a lembrar
      row({ id: 6, dueAt: null }),
    ], NOW);
    expect(r.remind).toEqual([1, 5]);
  });
  it("escala 3 dias depois do prazo, uma vez", () => {
    const r = selectReminders([
      row({ id: 7, status: "overdue", dueAt: "2026-09-21 09:00:00" }),
      row({ id: 8, status: "overdue", dueAt: "2026-09-22 09:00:00" }), // 2 dias
      row({ id: 9, status: "overdue", dueAt: "2026-09-20 09:00:00", escalatedAt: "2026-09-23 09:00:00" }),
    ], NOW);
    expect(r.escalate).toEqual([7]);
    expect(r.remind).toEqual([7, 8, 9]);
  });
  it("flag e horas", () => {
    expect(trainingRemindersEnabled({ TRAINING_REMINDERS: "off" })).toBe(false);
    expect(trainingRemindersEnabled({})).toBe(true);
    expect(isReminderHour(8)).toBe(false);
    expect(isReminderHour(9)).toBe(true);
    expect(isReminderHour(21)).toBe(false);
  });
});

describe("certificados", () => {
  it("validade em meses (fim de mês seguro)", () => {
    expect(certificateValidUntil(new Date("2026-09-24T10:00:00Z"), 12)).toBe("2027-09-24");
    expect(certificateValidUntil(new Date("2026-01-31T10:00:00Z"), 1)).toBe("2026-02-28");
    expect(certificateValidUntil(new Date("2026-01-31T10:00:00Z"), 0)).toBeNull();
  });
  it("estado: válido, a expirar, expirado, sem prazo", () => {
    expect(certificateStatus("2027-09-24", NOW)).toBe("valid");
    expect(certificateStatus("2026-10-10", NOW)).toBe("expiring");
    expect(certificateStatus("2026-09-24", NOW)).toBe("expiring");
    expect(certificateStatus("2026-09-23", NOW)).toBe("expired");
    expect(certificateStatus(null, NOW)).toBe("permanent");
  });
  it("promoção: nível sobe, nunca desce", () => {
    expect(promotionPatch("condutor_3", { extraLevel: 1, position: "extra" })).toEqual({ careerLevel: "condutor_3", extraLevel: 3 });
    expect(promotionPatch("condutor_2", { extraLevel: 4, position: "extra" })).toEqual({ careerLevel: "condutor_2" });
    expect(promotionPatch("team_leader", { extraLevel: null, position: "driver" })).toEqual({ careerLevel: "team_leader", position: "team_leader" });
    expect(promotionPatch("team_leader", { extraLevel: null, position: "supervisor" })).toEqual({ careerLevel: "team_leader" });
    expect(promotionPatch("front_2", { extraLevel: 1, position: "extra" })).toEqual({ careerLevel: "front_2" });
  });
});

describe("progresso de um percurso", () => {
  const items = [
    { itemType: "video", itemId: 1, required: true },
    { itemType: "manual", itemId: 2, required: 1 },
    { itemType: "quiz", itemId: 0, required: false },
  ];
  it("conta só os obrigatórios e marca iniciado ao abrir", () => {
    const p = computePathProgress(items, [
      { itemType: "video", itemId: 1, completedAt: "2026-09-24 09:00:00" },
      { itemType: "manual", itemId: 2, completedAt: null, viewedAt: "2026-09-24 09:10:00" },
      { itemType: "manual", itemId: 99, completedAt: "2026-09-24 09:00:00" }, // fora do percurso
    ]);
    expect(p).toMatchObject({ requiredTotal: 2, requiredDone: 1, pct: 50, complete: false, started: true });
    expect(assignmentStatusFor(p, "2026-09-30 00:00:00", NOW)).toBe("in_progress");
    expect(assignmentStatusFor(p, "2026-09-20 00:00:00", NOW)).toBe("overdue");
  });
  it("conclui com todos os obrigatórios (opcionais não contam)", () => {
    const p = computePathProgress(items, [
      { itemType: "video", itemId: 1, completedAt: "x" }, { itemType: "manual", itemId: 2, completedAt: "y" },
    ]);
    expect(p.complete).toBe(true);
    expect(assignmentStatusFor(p, "2026-09-20 00:00:00", NOW)).toBe("completed");
  });
  it("sem nada feito = por começar", () => {
    const p = computePathProgress(items, []);
    expect(assignmentStatusFor(p, null, NOW)).toBe("assigned");
    expect(computePathProgress([], []).complete).toBe(true);
  });
});

describe("perguntas geradas por IA", () => {
  it("aceita JSON em bloco de código e descarta inválidas", () => {
    const text = "```json\n" + JSON.stringify({ questions: [
      { question: "Qual é a velocidade máxima no parque?", optionA: "10", optionB: "20", optionC: "30", optionD: "50", correctOption: "b", explanation: "Regra interna." },
      { question: "x", optionA: "", optionB: "", optionC: "", optionD: "", correctOption: "Z" },
    ] }) + "\n```";
    const out = parseDraftQuestions(text);
    expect(out).toHaveLength(1);
    expect(out[0].correctOption).toBe("B");
  });
  it("texto sem JSON → lista vazia", () => {
    expect(parseDraftQuestions("desculpa, não consigo")).toEqual([]);
  });
});

describe("migration 0090", () => {
  it("é idempotente e cobre as colunas em falta", () => {
    const all = MIGRATION_0090_STATEMENTS.join("\n");
    expect(all).toMatch(/training_videos` ADD COLUMN `careerLevel`/);
    expect(all).toMatch(/training_manuals` ADD COLUMN `careerLevel`/);
    expect(all).toMatch(/MODIFY COLUMN `type` VARCHAR\(32\)/);
    for (const s of MIGRATION_0090_STATEMENTS.filter(x => x.startsWith("CREATE TABLE"))) expect(s).toMatch(/IF NOT EXISTS/);
    expect(IDEMPOTENT_ERROR_CODES_0090.has("ER_DUP_FIELDNAME")).toBe(true);
  });
});
