/**
 * 49c (Jorge, 8 out 2026): "Qualquer conta nova fica ativa como utilizador;
 * entra e tem acesso à sua ficha… Temos de separar o DESATIVADO do INATIVO…
 * Ao entrarem tem de ligar imediatamente à ficha certa SEM criar duplicados."
 * Regras puras e serviços com dependências falsas (sem BD).
 */
import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  BLOCKING_DEACTIVATION_REASONS, COMEBACK_DEACTIVATION_REASONS, DEACTIVATION_REASON_CODES, DEACTIVATION_REASON_GROUPS,
  DEACTIVATION_REASON_LABELS, DIALOG_DEACTIVATION_REASON_CODES, deactivationBlocksLogin, deactivationKind, resolveDeactivation,
} from "../shared/deactivationReasons";
import { canSayComeback, isCandidateFicha, loginComebackDecision, roleAfterActivation, type LoginFicha } from "../shared/comeback";
import { ACCOUNT_LINK_LIMITS, LINK_CODE_EXHAUSTED, LINK_CODE_WRONG, LINK_LIMIT_MESSAGE, linkRequestReply, parseLinkClaim, pickAutoTarget, codeUsable } from "../shared/accountLink";
import { leadFichaDecision } from "../shared/extraLeadsConvert";
import { confirmLinkCode, createLinkRequest, hashLinkCode, randomLinkCode, startCandidate, type CandidateDeps, type LinkDeps, type LinkRequestRow } from "./accountLink";
import { isPersonalAccessPath } from "./cityAccess";
import { SCHEMA_MIGRATION_IDS } from "./migrations";
import { IDEMPOTENT_ERROR_CODES_0585, MIGRATION_0585_STATEMENTS } from "./migrations/migration_0585";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

// ─── 1. Desativado vs inativo ────────────────────────────────────────────────
describe("49c: DESATIVADO (bloqueia) vs INATIVO (pode voltar)", () => {
  it("os motivos que bloqueiam e os que não bloqueiam são os decididos", () => {
    expect([...BLOCKING_DEACTIVATION_REASONS].sort()).toEqual(["comportamento", "conta_duplicada", "despedido", "faltas", "ficha_duplicada", "outro", "roubou", "seguranca", "trabalha_mal"]);
    expect([...COMEBACK_DEACTIVATION_REASONS].sort()).toEqual(["ausencia_prolongada", "candidato", "documentos", "fim_contrato", "fora_do_pais", "inatividade", "mudanca_funcao", "pedido_proprio"]);
    // todos os códigos estão num dos lados, só num
    for (const c of DEACTIVATION_REASON_CODES) {
      expect(Number((BLOCKING_DEACTIVATION_REASONS as readonly string[]).includes(c)) + Number((COMEBACK_DEACTIVATION_REASONS as readonly string[]).includes(c)), c).toBe(1);
    }
  });
  it("deactivationKind / deactivationBlocksLogin: sem motivo ou desconhecido = bloqueia (na dúvida)", () => {
    expect(deactivationKind("inatividade")).toBe("inativo");
    expect(deactivationKind("roubou")).toBe("desativado");
    expect(deactivationKind("candidato")).toBe("candidato");
    expect(deactivationBlocksLogin(null)).toBe(true);
    expect(deactivationBlocksLogin("motivo_antigo")).toBe(true);
    expect(deactivationBlocksLogin("fora_do_pais")).toBe(false);
  });
  it("diálogo: dois grupos com o efeito; 'candidato' não aparece nem se manda pela API", () => {
    expect(DEACTIVATION_REASON_GROUPS.map((g) => g.title)).toEqual(["Inativo — pode voltar", "Desativado — fica bloqueado"]);
    const all = DEACTIVATION_REASON_GROUPS.flatMap((g) => g.reasons.map((r) => r.code));
    expect(all).not.toContain("candidato");
    expect([...all].sort()).toEqual([...DIALOG_DEACTIVATION_REASON_CODES].sort());
    expect(DIALOG_DEACTIVATION_REASON_CODES).not.toContain("candidato");
    expect(DEACTIVATION_REASON_GROUPS[0].effect).toMatch(/voltar a entrar como utilizador/);
    expect(DEACTIVATION_REASON_GROUPS[1].effect).toMatch(/conta fica bloqueada/);
    expect(DEACTIVATION_REASON_LABELS.candidato).toBe("Candidato — por aprovar");
    expect(() => resolveDeactivation({ reason: "candidato" })).toThrow(/não se escolhe à mão/);
    // as rotas usam a lista do diálogo
    expect(read("server/rhRouter.ts")).toContain("reason: z.enum(DIALOG_DEACTIVATION_REASON_CODES).optional()");
    expect(read("server/routers.ts")).toContain("reason: z.enum(DIALOG_DEACTIVATION_REASON_CODES).optional()");
    const dlg = read("client/src/components/DeactivationDialog.tsx");
    expect(dlg).toContain("DEACTIVATION_REASON_GROUPS.map");
    expect(dlg).toContain("<SelectLabel");
  });
  it("'Suspender por inatividade' passa a 'Pôr inativo' (desativa com motivo inatividade, mesma cascata); o manual fica bloqueio", () => {
    const r = read("server/routers.ts");
    const block = r.slice(r.indexOf("    suspend: protectedProcedure"), r.indexOf("/** Retirar um agente da ficha (principal ou extra). */"));
    expect(block).toContain('resolveDeactivation({ reason: "inatividade"');
    expect(block).toContain("deactivateEmployeeCascade(ctx.user, id, deactivation");
    expect(block).toContain('if (input.why === "manual")');
    expect(block).toContain("suspendEmployee(id, reason)");
    expect(block).toContain("canManageEmployee(viewer, ref)");
  });
});

// ─── 2. Decisão no login ─────────────────────────────────────────────────────
describe("49c: decisão do login (regra pura)", () => {
  const f = (o: Partial<LoginFicha> = {}): LoginFicha => ({ id: 5, position: "extra", isActive: 0, deactivationReason: "inatividade", ...o });
  const acct = (o: Record<string, unknown> = {}) => ({ id: 9, role: "extra", isActive: 0, deactivationReason: "inatividade", ...o });
  it("inativo extra/condutor → volta como utilizador (a ficha mais recente)", () => {
    expect(loginComebackDecision(acct(), [f()])).toEqual({ kind: "reactivate", employeeId: 5 });
    expect(loginComebackDecision(acct({ role: "condutor" }), [f({ id: 3, position: "driver" }), f({ id: 8, position: "senior_driver", deactivationReason: "fora_do_pais" })])).toEqual({ kind: "reactivate", employeeId: 8 });
    expect(loginComebackDecision(acct({ deactivationReason: null }), [f({ deactivationReason: "candidato" })])).toMatchObject({ kind: "reactivate" });
  });
  it("staff, bloqueado, sem ficha, conta com motivo de bloqueio ou ficha ativa → nada (recusa como hoje)", () => {
    expect(loginComebackDecision(acct(), [])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct(), [f({ position: "team_leader" })])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct({ role: "backoffice" }), [f()])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct(), [f({ deactivationReason: "roubou" })])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct(), [f(), f({ id: 6, deactivationReason: "despedido" })])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct(), [f({ deactivationReason: null })])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct({ deactivationReason: "seguranca" }), [f()])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct({ deactivationReason: "conta_duplicada" }), [f()])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct(), [f({ isActive: 1 })])).toEqual({ kind: "none" });
  });
  it("conta ativa: só a suspensão por inatividade (41a) sozinha passa a inativo", () => {
    const susp = f({ isActive: 1, deactivationReason: null, blockedManually: 1, loginBlockedReason: "Suspenso: sem atividade há mais de 6 meses. Contacta o supervisor." });
    expect(loginComebackDecision(acct({ isActive: 1, deactivationReason: null }), [susp])).toEqual({ kind: "convert_suspension", employeeId: 5 });
    expect(loginComebackDecision(acct({ isActive: 1 }), [{ ...susp, blockedByDocs: 1 }])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct({ isActive: 1 }), [{ ...susp, loginBlockedReason: "Suspenso pelo RH" }])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct({ isActive: 1, role: "team_leader" }), [susp])).toEqual({ kind: "none" });
    expect(loginComebackDecision(acct({ isActive: 1 }), [f({ isActive: 1, deactivationReason: null })])).toEqual({ kind: "none" });
  });
  it("'Voltei' só para inativos (não candidatos, não desativados, não estrutura); papel do posto só a quem está como utilizador", () => {
    expect(canSayComeback({ isActive: 0, position: "extra", deactivationReason: "inatividade" })).toBe(true);
    expect(canSayComeback({ isActive: 0, position: "extra", deactivationReason: "candidato" })).toBe(false);
    expect(canSayComeback({ isActive: 0, position: "extra", deactivationReason: "roubou" })).toBe(false);
    expect(canSayComeback({ isActive: 0, position: "supervisor", deactivationReason: "inatividade" })).toBe(false);
    expect(canSayComeback({ isActive: 1, position: "extra", deactivationReason: null })).toBe(false);
    expect(isCandidateFicha({ isActive: 0, deactivationReason: "candidato" })).toBe(true);
    expect(roleAfterActivation("user", "extra")).toBe("extra");
    expect(roleAfterActivation("condutor", "extra")).toBeNull();
    expect(roleAfterActivation("admin", "supervisor")).toBeNull();
  });
  it("aprovar a candidatura de um candidato da app não pede confirmação de readmissão", () => {
    expect(leadFichaDecision({ id: 1, isActive: 0, deactivationReason: "candidato" }, false)).toEqual({ kind: "use", reactivate: true });
    expect(leadFichaDecision({ id: 1, isActive: 0, deactivationReason: "inatividade" }, false)).toMatchObject({ kind: "confirm" });
    expect(leadFichaDecision({ id: 1, isActive: 0, deactivationReason: "roubou" }, true)).toMatchObject({ kind: "blocked" });
    const w = read("server/webIntake.ts");
    expect(w).toContain("promoteRoleAfterActivation({ id: reviewedById }, employeeId)");
  });
});

// ─── 3. "Liga a tua conta" ───────────────────────────────────────────────────
describe("49c: pedido de ligação (email ou telefone)", () => {
  it("parseLinkClaim: email ou telefone; nunca nome", () => {
    expect(parseLinkClaim(" Ana@Gmail.com ")).toEqual({ kind: "email", email: "ana@gmail.com" });
    expect(parseLinkClaim("912 345 678")).toEqual({ kind: "phone", phone: "+351912345678" });
    expect(parseLinkClaim("Ana Sousa")).toBeNull();
    expect(parseLinkClaim("123")).toBeNull();
  });
  it("pickAutoTarget: só UMA pessoa, extra/condutor, não desativada, com email", () => {
    const emp = (o: Record<string, unknown> = {}) => ({ kind: "employee" as const, id: 7, email: "ana@x.pt", position: "extra", isActive: 0, deactivationReason: "inatividade", ...o });
    expect(pickAutoTarget([emp()])).toEqual({ kind: "employee", employeeId: 7, sendTo: "ana@x.pt" });
    expect(pickAutoTarget([emp(), emp({ id: 8 })])).toBeNull();
    expect(pickAutoTarget([emp({ position: "backoffice" })])).toBeNull();
    expect(pickAutoTarget([emp({ deactivationReason: "roubou" })])).toBeNull();
    expect(pickAutoTarget([emp({ email: null })])).toBeNull();
    expect(pickAutoTarget([{ kind: "application", id: 3, email: "Ana@X.pt" }])).toEqual({ kind: "application", applicationId: 3, sendTo: "ana@x.pt" });
    expect(pickAutoTarget([{ kind: "application", id: 3, email: "a@x.pt" }, { kind: "application", id: 4, email: "b@x.pt" }])).toBeNull();
    expect(pickAutoTarget([emp(), { kind: "application", id: 3, email: "z@x.pt", employeeId: 99 }])).toBeNull();
    expect(pickAutoTarget([])).toBeNull();
  });

  function fakeDeps(o: { flag?: boolean; matches?: any[]; recent?: number; now?: Date } = {}) {
    const rows = new Map<number, LinkRequestRow>();
    let next = 100;
    const calls = { notify: [] as any[], sent: [] as Array<[string, string]>, linked: [] as any[], logs: [] as string[] };
    let clock = o.now ?? new Date("2026-10-08T10:00:00Z");
    const deps: LinkDeps = {
      now: () => clock,
      flagOn: async () => !!o.flag,
      countRecent: async () => o.recent ?? 0,
      expirePending: async (userId) => { for (const r of rows.values()) if (r.userId === userId && r.status === "pending") r.status = "expired"; },
      insert: async (row) => { const id = next++; rows.set(id, { ...row, id } as LinkRequestRow); return id; },
      update: async (id, patch) => { rows.set(id, { ...rows.get(id)!, ...(patch as any) }); },
      get: async (id) => rows.get(id) ?? null,
      findMatches: async () => o.matches ?? [],
      sendCode: async (to, code) => { calls.sent.push([to, code]); return true; },
      notifyRh: async (r) => { calls.notify.push(r); },
      linkTarget: async (t, u) => { calls.linked.push([t, u.id]); return t.kind === "employee" ? t.employeeId : 555; },
      log: async (_u, _a, _e, d) => { calls.logs.push(d); },
      randomCode: () => "042137",
      hash: (id, code) => hashLinkCode(id, code, "segredo-teste"),
    };
    return { deps, rows, calls, tick: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
  }
  const user = { id: 31, email: "novo.gmail@gmail.com" };
  const match = [{ kind: "employee", id: 7, email: "ana@site.pt", position: "extra", isActive: 0, deactivationReason: "inatividade" }];

  it("a resposta é IGUAL com e sem correspondência (com o interruptor ligado e desligado)", async () => {
    for (const flag of [false, true]) {
      const a = await createLinkRequest(fakeDeps({ flag, matches: match }).deps, user, "ana@site.pt");
      const b = await createLinkRequest(fakeDeps({ flag, matches: [] }).deps, user, "ninguem@site.pt");
      expect({ ...a, requestId: 0 }).toEqual({ ...b, requestId: 0 });
      expect(a.message).toBe(linkRequestReply(flag));
      expect(a.codeExpected).toBe(flag);
    }
  });
  it("interruptor DESLIGADO → nenhum código; o pedido vai para o RH (sino) com a ficha encontrada", async () => {
    const f = fakeDeps({ flag: false, matches: match });
    const r = await createLinkRequest(f.deps, user, "ana@site.pt");
    expect(f.calls.sent).toEqual([]);
    expect(f.calls.notify).toEqual([expect.objectContaining({ id: r.requestId, employeeId: 7, summary: "Pedido de ligação: novo.gmail@gmail.com diz ser ana@site.pt" })]);
    expect(f.rows.get(r.requestId)).toMatchObject({ status: "pending", codeHash: null, matchedEmployeeId: 7, claimedEmail: "ana@site.pt", googleEmail: "novo.gmail@gmail.com" });
  });
  it("interruptor LIGADO + uma pessoa → código para o email da ficha, guardado SÓ em hash, 10 min", async () => {
    const f = fakeDeps({ flag: true, matches: match });
    const r = await createLinkRequest(f.deps, user, "912345678");
    expect(f.calls.sent).toEqual([["ana@site.pt", "042137"]]);
    const row = f.rows.get(r.requestId)!;
    expect(row.codeHash).toBe(hashLinkCode(r.requestId, "042137", "segredo-teste"));
    expect(JSON.stringify(row)).not.toContain("042137");
    expect(row.codeExpiresAt).toBe("2026-10-08 10:10:00");
    expect(f.calls.notify).toEqual([]);
    expect(row.claimedPhone).toBe("+351912345678");
  });
  it("pedido por EMAIL → o código vai para o email escrito (é um dos do registo encontrado)", async () => {
    const f = fakeDeps({ flag: true, matches: [{ ...match[0], email: "trabalho@multipark.pt" }] });
    await createLinkRequest(f.deps, user, "Ana.Pessoal@gmail.com");
    expect(f.calls.sent).toEqual([["ana.pessoal@gmail.com", "042137"]]);
  });
  it("código certo mas a ligação é do RH (p.ex. a conta principal é da estrutura) → não liga, anula o código e vai ao RH", async () => {
    const { TRPCError } = await import("@trpc/server");
    const f = fakeDeps({ flag: true, matches: match });
    f.deps.linkTarget = async () => { throw new TRPCError({ code: "FORBIDDEN", message: "Esta ficha só o RH a liga." }); };
    const { requestId } = await createLinkRequest(f.deps, user, "ana@site.pt");
    await expect(confirmLinkCode(f.deps, user, requestId, "042137")).rejects.toMatchObject({ message: expect.stringMatching(/tem de ser o RH/) });
    expect(f.rows.get(requestId)).toMatchObject({ status: "pending", codeHash: null });
    expect(f.calls.notify).toHaveLength(1);
  });
  it("interruptor LIGADO mas sem correspondência ou ficha da estrutura → RH (e a mesma resposta)", async () => {
    const f = fakeDeps({ flag: true, matches: [{ ...match[0], position: "supervisor" }] });
    await createLinkRequest(f.deps, user, "chefe@site.pt");
    expect(f.calls.sent).toEqual([]);
    expect(f.calls.notify).toHaveLength(1);
  });
  it("5 pedidos por dia; texto inválido recusa sem dizer nada sobre quem existe", async () => {
    await expect(createLinkRequest(fakeDeps({ recent: ACCOUNT_LINK_LIMITS.perDay }).deps, user, "ana@site.pt")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: LINK_LIMIT_MESSAGE });
    await expect(createLinkRequest(fakeDeps().deps, user, "Ana Sousa")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("código certo → liga à ficha e fecha o pedido; errado conta tentativas; 5 erradas → acabou e vai ao RH", async () => {
    const f = fakeDeps({ flag: true, matches: match });
    const { requestId } = await createLinkRequest(f.deps, user, "ana@site.pt");
    await expect(confirmLinkCode(f.deps, user, requestId, "000000")).rejects.toMatchObject({ message: LINK_CODE_WRONG });
    expect(f.rows.get(requestId)!.attempts).toBe(1);
    expect(await confirmLinkCode(f.deps, user, requestId, "042137")).toEqual({ employeeId: 7 });
    expect(f.calls.linked).toEqual([[{ kind: "employee", employeeId: 7, sendTo: "" }, 31]]);
    expect(f.rows.get(requestId)).toMatchObject({ status: "confirmed", codeHash: null, resolvedById: 31 });
    // já confirmado: o mesmo código já não serve
    await expect(confirmLinkCode(f.deps, user, requestId, "042137")).rejects.toMatchObject({ message: LINK_CODE_WRONG });

    const g = fakeDeps({ flag: true, matches: match });
    const second = await createLinkRequest(g.deps, user, "ana@site.pt");
    for (let i = 1; i < ACCOUNT_LINK_LIMITS.maxAttempts; i++) await expect(confirmLinkCode(g.deps, user, second.requestId, "111111")).rejects.toMatchObject({ message: LINK_CODE_WRONG });
    await expect(confirmLinkCode(g.deps, user, second.requestId, "111111")).rejects.toMatchObject({ message: LINK_CODE_EXHAUSTED });
    expect(g.rows.get(second.requestId)).toMatchObject({ status: "pending", codeHash: null, attempts: 5 });
    expect(g.calls.notify).toHaveLength(1);
    await expect(confirmLinkCode(g.deps, user, second.requestId, "042137")).rejects.toMatchObject({ message: LINK_CODE_WRONG });
    expect(g.calls.linked).toEqual([]);
  });
  it("código expirado (10 min) ou pedido de outra conta → 'Código errado ou expirado'", async () => {
    const f = fakeDeps({ flag: true, matches: match });
    const { requestId } = await createLinkRequest(f.deps, user, "ana@site.pt");
    await expect(confirmLinkCode(f.deps, { id: 999, email: "x@y.pt" }, requestId, "042137")).rejects.toMatchObject({ message: LINK_CODE_WRONG });
    f.tick(ACCOUNT_LINK_LIMITS.codeMinutes * 60_000 + 1000);
    await expect(confirmLinkCode(f.deps, user, requestId, "042137")).rejects.toMatchObject({ message: LINK_CODE_WRONG });
    expect(f.calls.linked).toEqual([]);
  });
  it("sem correspondência (com o interruptor ligado): qualquer código falha da mesma maneira e conta tentativas", async () => {
    const f = fakeDeps({ flag: true, matches: [] });
    const { requestId } = await createLinkRequest(f.deps, user, "ninguem@site.pt");
    await expect(confirmLinkCode(f.deps, user, requestId, "042137")).rejects.toMatchObject({ message: LINK_CODE_WRONG });
    expect(f.rows.get(requestId)!.attempts).toBe(1);
  });
  it("um pedido novo substitui o pendente anterior da mesma conta", async () => {
    const f = fakeDeps({ flag: false, matches: [] });
    const a = await createLinkRequest(f.deps, user, "a@site.pt");
    await createLinkRequest(f.deps, user, "b@site.pt");
    expect(f.rows.get(a.requestId)!.status).toBe("expired");
  });
  it("código: 6 algarismos aleatórios; hash depende do pedido e do segredo; codeUsable vê prazo e tentativas", () => {
    for (let i = 0; i < 20; i++) expect(randomLinkCode()).toMatch(/^\d{6}$/);
    expect(hashLinkCode(1, "123456", "s")).not.toBe(hashLinkCode(2, "123456", "s"));
    expect(hashLinkCode(1, "123456", "s")).not.toBe(hashLinkCode(1, "123456", "t"));
    const now = new Date("2026-10-08T10:00:00Z");
    expect(codeUsable({ codeHash: "h", codeExpiresAt: "2026-10-08 10:05:00", attempts: 0, status: "pending" }, now)).toBe(true);
    expect(codeUsable({ codeHash: "h", codeExpiresAt: "2026-10-08 09:59:00", attempts: 0, status: "pending" }, now)).toBe(false);
    expect(codeUsable({ codeHash: "h", codeExpiresAt: "2026-10-08 10:05:00", attempts: 5, status: "pending" }, now)).toBe(false);
    expect(codeUsable({ codeHash: null, codeExpiresAt: "2026-10-08 10:05:00", attempts: 0, status: "pending" }, now)).toBe(false);
  });
});

// ─── 4. "Sou novo — quero candidatar-me" ────────────────────────────────────
describe("49c: candidato pela app, sem duplicar", () => {
  function deps(o: { mine?: number | null; emp?: any; app?: any; info?: any } = {}) {
    const calls = { created: [] as any[], linked: [] as number[], fromApp: [] as number[], rh: [] as number[] };
    const d: CandidateDeps = {
      myEmployeeId: async () => o.mine ?? null,
      findEmployeeByEmail: async () => o.emp ?? null,
      findApplicationByEmail: async () => o.app ?? null,
      employeeInfo: async () => o.info ?? null,
      createApplication: async (c) => { calls.created.push(c); return 77; },
      linkEmployee: async (id) => { calls.linked.push(id); },
      createFromApplication: async (appId) => { calls.fromApp.push(appId); return 900; },
      requestRh: async ({ employeeId }) => { calls.rh.push(employeeId); },
    };
    return { d, calls };
  }
  const user = { id: 40, email: "Nova.Pessoa@Gmail.com", name: "Nova Pessoa" };
  it("sem nada → cria a candidatura (funil de sempre) e a ficha de candidato a partir dela", async () => {
    const { d, calls } = deps();
    expect(await startCandidate(d, user, { city: "Porto" })).toEqual({ outcome: "created", employeeId: 900 });
    expect(calls.created).toEqual([{ email: "nova.pessoa@gmail.com", fullName: "Nova Pessoa", city: "Porto" }]);
    expect(calls.fromApp).toEqual([77]);
    // a ficha de candidato herda a cidade da candidatura (o supervisor da cidade vê-a)
    expect(read("server/accountLink.ts")).toContain("const projectId = await cityProjectId(app.city ?? null);");
  });
  it("já há candidatura com o email Google → usa essa (não cria outra)", async () => {
    const { d, calls } = deps({ app: { id: 12, employeeId: null } });
    expect(await startCandidate(d, user)).toEqual({ outcome: "created", employeeId: 900 });
    expect(calls.created).toEqual([]);
    expect(calls.fromApp).toEqual([12]);
  });
  it("já há ficha com o email Google (inativa por inatividade) → liga a essa, não cria nada", async () => {
    const { d, calls } = deps({ emp: { id: 5, position: "extra", isActive: 0, deactivationReason: "inatividade" } });
    expect(await startCandidate(d, user)).toEqual({ outcome: "linked", employeeId: 5 });
    expect(calls).toMatchObject({ created: [], fromApp: [], linked: [5] });
  });
  it("ficha DESATIVADA ou da estrutura com esse email → não liga nem cria: pedido ao RH", async () => {
    for (const emp of [{ id: 5, position: "extra", isActive: 0, deactivationReason: "roubou" }, { id: 6, position: "backoffice", isActive: 1, deactivationReason: null }]) {
      const { d, calls } = deps({ emp });
      expect(await startCandidate(d, user)).toEqual({ outcome: "pending_rh", employeeId: null });
      expect(calls).toMatchObject({ created: [], fromApp: [], linked: [], rh: [emp.id] });
    }
  });
  it("a ligação que só o RH faz (FORBIDDEN) vira pedido ao RH em vez de erro", async () => {
    const { TRPCError } = await import("@trpc/server");
    const { d, calls } = deps({ emp: { id: 5, position: "extra", isActive: 1, deactivationReason: null } });
    d.linkEmployee = async () => { throw new TRPCError({ code: "FORBIDDEN", message: "Esta ficha só o RH a liga." }); };
    expect(await startCandidate(d, user)).toEqual({ outcome: "pending_rh", employeeId: null });
    expect(calls.rh).toEqual([5]);
  });
  it("candidatura já aprovada (ficha com outro email) → liga a essa ficha", async () => {
    const { d, calls } = deps({ app: { id: 12, employeeId: 66 }, info: { id: 66, position: "extra", isActive: 1, deactivationReason: null } });
    expect(await startCandidate(d, user)).toEqual({ outcome: "linked", employeeId: 66 });
    expect(calls.created).toEqual([]);
  });
  it("a conta já tem ficha → nada a fazer", async () => {
    const { d, calls } = deps({ mine: 3 });
    expect(await startCandidate(d, user)).toEqual({ outcome: "already", employeeId: 3 });
    expect(calls).toMatchObject({ created: [], fromApp: [], linked: [] });
  });
  it("a ficha de candidato nasce extra, INATIVA, motivo 'candidato', ligada à conta (e nunca pelo findOrCreateExtraByEmail, que cria ativa)", () => {
    const src = read("server/accountLink.ts");
    const fn = src.slice(src.indexOf("export async function createCandidateFicha"), src.indexOf("export async function linkFromApplication"));
    expect(fn).toContain("'extra', 'extra', ${c.userId}, ${c.projectId ?? null}, 0, ${CANDIDATE_REASON}");
    expect(src).not.toContain("findOrCreateExtraByEmail");
  });
});

// ─── 5. Acesso, migração e "nada se apaga" ──────────────────────────────────
describe("49c: acesso sem ficha, migração, nunca DELETE", () => {
  it("o ecrã 'Liga a tua conta' e o 'Voltei' abrem sem ficha nem cidade; a caixa do RH não", () => {
    for (const p of ["accountLink.mine", "accountLink.startCandidate", "accountLink.request", "accountLink.confirmCode", "rh.comeback"]) expect(isPersonalAccessPath(p), p).toBe(true);
    for (const p of ["accountLink.inbox", "accountLink.decide", "accountLink.forEmployee"]) expect(isPersonalAccessPath(p), p).toBe(false);
  });
  it("0585: só acrescenta (coluna + tabela), idempotente, registada", () => {
    expect(MIGRATION_0585_STATEMENTS[0]).toBe("ALTER TABLE `employees` ADD COLUMN `comebackRequestedAt` DATETIME NULL");
    expect(MIGRATION_0585_STATEMENTS[1]).toMatch(/^CREATE TABLE IF NOT EXISTS `account_link_requests`/);
    for (const col of ["userId", "googleEmail", "claimedEmail", "claimedPhone", "matchedEmployeeId", "matchedApplicationId", "status", "codeHash", "codeExpiresAt", "attempts", "createdAt", "resolvedById", "resolvedAt"]) {
      expect(MIGRATION_0585_STATEMENTS[1]).toContain(`\`${col}\``);
    }
    expect(MIGRATION_0585_STATEMENTS.join(" ")).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
    expect([...IDEMPOTENT_ERROR_CODES_0585].sort()).toEqual(["ER_DUP_FIELDNAME", "ER_TABLE_EXISTS_ERROR"]);
    expect(SCHEMA_MIGRATION_IDS).toContain("0585");
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('export const accountLinkRequests = mysqlTable("account_link_requests"');
    expect(schema).toContain("comebackRequestedAt: datetime({ mode: 'string' })");
  });
  it("nenhum dos módulos novos apaga dados (DELETE)", () => {
    for (const f of ["server/accountLink.ts", "server/accountLinkRouter.ts", "server/comebackStore.ts", "server/comebackLogin.ts", "server/employeeActivation.ts", "server/migrations/migration_0585.ts", "shared/comeback.ts", "shared/accountLink.ts"]) {
      expect(read(f), f).not.toMatch(/\bDELETE\s+FROM\b|\.delete\(/i);
    }
  });
  it("o interruptor do código entra DESLIGADO e o envio é pela recursos-humanos@", async () => {
    const { AUTOMATION_FLAGS, automationFlagDefault } = await import("../shared/appSettings");
    expect(AUTOMATION_FLAGS.some((f) => f.name === "ACCOUNT_LINK_EMAIL_CODE")).toBe(true);
    expect(automationFlagDefault("ACCOUNT_LINK_EMAIL_CODE")).toBe(false);
    expect(read("server/accountLink.ts")).toContain('from: "recursos-humanos@multipark.pt"');
  });
  it("cliente: 'Liga a tua conta' no lugar do aviso, cartão 'Voltei' com uma linha em cada página, painel no Recrutamento", () => {
    expect(read("client/src/components/OwnAccessNotice.tsx")).toContain("<LinkAccountScreen");
    const scr = read("client/src/components/LinkAccountScreen.tsx");
    expect(scr).toContain("Sou novo — quero candidatar-me");
    expect(scr).toContain("Já me candidatei / já trabalhei convosco com outro email");
    expect(read("client/src/pages/HRPage.tsx")).toContain("<ComeBackCard /><EmployeeDetail");
    expect(read("client/src/pages/DisponibilidadePage.tsx")).toContain("return <><ComeBackCard /><MyAvailability /></>;");
    expect(read("client/src/components/ComeBackCard.tsx")).toContain("Voltei, quero trabalhar");
    expect(read("client/src/components/CandidaturasSection.tsx")).toContain("<AccountRequestsPanel />");
    expect(read("client/src/pages/HRPage.tsx")).toContain('<SelectItem value="candidates">Candidatos (app)</SelectItem>');
  });
});

vi.restoreAllMocks();
