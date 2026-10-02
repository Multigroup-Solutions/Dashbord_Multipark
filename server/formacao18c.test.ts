/**
 * P3 lote 18c — Formação. Decisão do Jorge (2 out 2026): um percurso que
 * bloqueia a escala exige quiz/exame obrigatório (o "visto" é autodeclarado).
 * E ainda: leitura falhada não deixa escalar, itens retirados não prendem
 * ninguém, nada se apaga, promoções nunca pelo próprio nem pelo TL, submissão
 * idempotente, prazos ao fim do dia de Lisboa, erro ≠ vazio.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blockingPathProblem, computePathProgress, trainingDueAt } from "./trainingRules";
import { clearSendAsCache, sendMailWith, type SystemMailDeps } from "./mail/systemMail";
import { MIGRATION_0385_STATEMENTS } from "./migrations/migration_0385";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (file: string, start: string, len = 900) => { const s = src(file); const i = s.indexOf(start); expect(i).toBeGreaterThan(-1); return s.slice(i, i + len); };

describe("Percurso que bloqueia a escala: quiz ou exame obrigatório", () => {
  it("só vídeos/manuais → recusado; com quiz ou exame obrigatório → aceite; quiz opcional não chega", () => {
    expect(blockingPathProblem(1, [{ itemType: "video", required: 1 }, { itemType: "manual", required: 1 }])).toMatch(/quiz ou exame obrigatório/);
    expect(blockingPathProblem(1, [{ itemType: "video", required: 1 }, { itemType: "quiz", required: 1 }])).toBeNull();
    expect(blockingPathProblem(true, [{ itemType: "exam", required: true }])).toBeNull();
    expect(blockingPathProblem(1, [{ itemType: "video", required: 1 }, { itemType: "quiz", required: 0 }])).toMatch(/quiz ou exame/);
    expect(blockingPathProblem(0, [{ itemType: "video", required: 1 }])).toBeNull();
  });
  it("aplicado ao gravar os itens e ao editar o percurso; os antigos mostram aviso", () => {
    expect(src("server/trainingPaths.ts")).toContain("const problem = items.length ? blockingPathProblem(path.blocksEscala, items) : null;");
    expect(src("server/trainingPaths.ts")).toContain("const problem = items.length ? blockingPathProblem(1, items) : null;");
    expect(src("server/trainingPaths.ts")).toContain("gateProblem: blockingPathProblem(p.blocksEscala, its),");
    expect(src("client/src/pages/training/Management.tsx")).toContain("{p.gateProblem && p.items.length > 0 && (");
  });
});

describe("Itens retirados não prendem ninguém", () => {
  it("um obrigatório indisponível não conta", () => {
    const items = [{ itemType: "video", itemId: 1, required: 1, available: false }, { itemType: "quiz", itemId: 0, required: 1 }];
    const p = computePathProgress(items, [{ itemType: "quiz", itemId: 0, completedAt: "2026-10-02 10:00:00" }]);
    expect(p).toMatchObject({ requiredTotal: 1, requiredDone: 1, complete: true, pct: 100 });
    // sem a marca (antigo): ficava preso
    expect(computePathProgress(items.map(({ available, ...i }) => i), [{ itemType: "quiz", itemId: 0, completedAt: "2026-10-02 10:00:00" }]).complete).toBe(false);
  });
  it("vídeo/manual/exame arquivado, apagado ou manual por publicar = indisponível; refresh e 'a minha formação' usam isso", () => {
    const t = src("server/trainingPaths.ts");
    expect(t).toContain("isNull(trainingVideos.archivedAt)");
    expect(t).toContain("sql`COALESCE(${trainingManuals.published}, 1) = 1`");
    expect(t).toContain("isNull(careerExams.archivedAt)");
    expect(t.match(/await withAvailability\(/g)?.length).toBe(2);
  });
});

describe("Escala: leitura falhada não deixa escalar", () => {
  it("employeesMissingTraining lança (já não engole o erro)", () => {
    const body = fnBody("server/trainingPaths.ts", "export async function employeesMissingTraining(", 500);
    expect(body).not.toContain("catch");
  });
  it("seletor da escala: 'Formação por verificar' em vez de esconder o aviso", () => {
    expect(src("server/routers.ts")).toContain("trainingUnknown: missing == null");
    expect(src("client/src/pages/ExtrasDiaPage.tsx")).toContain("Formação por verificar");
  });
  it("verificação ao escalar à mão: refresh falhado = erro, não 'por concluir'", () => {
    expect(src("server/trainingPaths.ts")).toContain("Não foi possível verificar a formação (");
  });
});

describe("Nada se apaga", () => {
  it("migração 0385, depois da 0380", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0385")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0380"));
    expect(MIGRATION_0385_STATEMENTS.every((s) => s.startsWith("ALTER TABLE") && s.includes("ADD COLUMN"))).toBe(true);
    expect(MIGRATION_0385_STATEMENTS.join("\n")).toContain("`training_assignments` ADD COLUMN `removedAt`");
  });
  it("vídeos, manuais, FAQs, perguntas, percursos e atribuições: sem DELETE", () => {
    const all = ["server/db.ts", "server/trainingPaths.ts", "server/trainingRouter.ts"].map(src).join("\n");
    for (const t of ["trainingVideos", "trainingManuals", "faqs", "quizQuestions", "careerExamQuestions", "trainingAssignments", "trainingPaths"]) {
      expect(all).not.toContain(`.delete(${t}).where(eq(${t}.id`);
    }
    const u = fnBody("server/trainingPaths.ts", "export async function unassign(", 1200);
    expect(u).toContain("removedAt: toDbDate(new Date()), removedById: userId");
    expect(u).toContain("await assertEmployeeAccess(a.employeeId);");
    expect(u).toContain('action: "training_unassign"');
  });
  it("atribuições removidas não contam em lado nenhum (escala, lembretes, painel, Google)", () => {
    const t = src("server/trainingPaths.ts");
    expect((t.match(/activeAssignment\(\)/g) ?? []).length).toBeGreaterThanOrEqual(9);
    expect(src("server/google/syncService.ts")).toContain("ta.removedAt IS NULL");
  });
});

describe("Promoções", () => {
  it("o team leader não decide; ninguém decide a própria", () => {
    expect(src("server/trainingRouter.ts")).toContain('if (scopeFor(withOverrides(ctx.user), "formacao") === "below_city") throw new TRPCError({ code: "FORBIDDEN"');
    expect(src("server/trainingAttempts.ts")).toContain('if (emp.userId != null && emp.userId === user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes decidir a tua própria promoção." });');
  });
});

describe("Submeter quiz/exame", () => {
  it("reenviar devolve o resultado guardado; falhar a gravar liberta a tentativa", () => {
    const a = src("server/trainingAttempts.ts");
    expect(a).toContain("const stored = await storedResult(sessionId);");
    expect(a).toContain("await d.update(trainingAttemptSessions).set({ submittedAt: null })");
  });
});

describe("Prazos ao fim do dia de Lisboa", () => {
  it("hoje + N dias às 23:59:59 de Lisboa (verão e inverno, e depois da meia-noite)", () => {
    expect(trainingDueAt(new Date("2026-10-02T12:00:00Z"), 7)).toBe("2026-10-09 22:59:59");
    expect(trainingDueAt(new Date("2026-11-10T10:00:00Z"), 3)).toBe("2026-11-13 23:59:59");
    expect(trainingDueAt(new Date("2026-10-20T10:00:00Z"), 7)).toBe("2026-10-27 23:59:59"); // passa a hora de inverno
    expect(trainingDueAt(new Date("2026-10-02T23:30:00Z"), 1)).toBe("2026-10-04 22:59:59"); // 00:30 de Lisboa já é dia 3
  });
});

describe("'Não enviar email' sem conseguir ler → não envia", () => {
  it("a leitura falha → não sai e conta como falha (não como bloqueado)", async () => {
    clearSendAsCache();
    const sent: string[] = [];
    const d: SystemMailDeps = {
      async systemSender() { return "notificacoes@multipark.pt"; },
      async mailboxes() { return []; },
      async apiFor() {
        return {
          async listSendAs() { return [{ sendAsEmail: "notificacoes@multipark.pt", isPrimary: true, verificationStatus: null }]; },
          async sendRaw(raw) { sent.push(raw.toString("utf8")); return { id: "g1", threadId: null }; },
        };
      },
      dwdAvailable: () => true,
      async noAutoEmail() { throw new Error("BD em baixo"); },
    };
    const r = await sendMailWith(d, { to: "extra@gmail.com", subject: "Formação", text: "x", auto: { kind: "training_reminder", employeeId: 7 } } as any);
    expect(r.ok).toBe(false);
    expect((r as any).blocked).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});

describe("Erro ≠ vazio", () => {
  it("a minha formação, vídeos, manuais, FAQs, ranking, percursos e tutor mostram o erro", () => {
    expect(src("client/src/pages/training/Management.tsx")).toContain('what="a tua formação"');
    const c = src("client/src/pages/training/ContentTabs.tsx");
    for (const w of ['what="os vídeos"', 'what="os manuais"', 'what="as FAQs"']) expect(c).toContain(w);
    expect(src("client/src/pages/training/Assessments.tsx")).toContain('what="o ranking"');
    expect(src("client/src/pages/training/Management.tsx")).toContain('what="os percursos"');
    expect(src("client/src/pages/training/TutorPanel.tsx")).toContain('what="o tutor"');
  });
});
