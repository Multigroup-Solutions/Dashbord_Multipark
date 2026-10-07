/**
 * Pedir os documentos em falta aos extras (pauta do Rafael, 7 out 2026):
 * regras puras (o que falta, texto, cadência 7 dias / máximo 4 automáticos,
 * quem fica de fora e porquê), interruptor, permissões e âmbito, registo.
 * Nada é enviado de verdade: o trabalho automático corre com dependências falsas.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DOCS_REQUEST_AUTO_MAX,
  DOCS_REQUEST_COOLDOWN_DAYS,
  DOCS_REQUEST_PERSON_DOC_TYPES,
  docsPlanIgnoredReasons,
  docsPlanWillSend,
  docsRequestCadence,
  docsRequestCounted,
  docsRequestEmailLines,
  docsRequestFirstName,
  docsRequestLine,
  docsTemplatesByCity,
  docsToRequest,
  lastDocsRequestLabel,
  parseDocsTemplate,
  planDocsRequests,
  requestedDocLabel,
  type DocsRequestLogRow,
  type DocsRequestPerson,
} from "../shared/docsRequest";
import { MANDATORY_DOC_TYPES, docChecklist } from "../shared/employeeDocuments";
import { NO_AUTO_EMAIL_ERROR, NO_AUTO_WHATSAPP_ERROR } from "../shared/contactPrefs";
import { AUTOMATION_FLAGS, CRON_JOBS, SETTINGS, automationFlagDefault, validateSetting } from "../shared/appSettings";
import { AUTO_MAIL_KIND_LABELS } from "../shared/mail";
import { SELF_UPLOAD_DOC_TYPES, canRequestDocuments, docsRequestableRows, type EmployeeRef, type RhViewer } from "./rhAccess";
import { TICK_JOBS, describeCadence } from "./cronSchedule";
import { MIGRATION_0560_STATEMENTS, IDEMPOTENT_ERROR_CODES_0560 } from "./migrations/migration_0560";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { docsRequestEmailHtml, maskEmailAddress, runDocsRequestAuto, type DocsAutoDeps } from "./rhDocsRequest";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const DAY = 86_400_000;
// Segunda, 12 out 2026, 10:00 em Lisboa (09:00 UTC).
const NOW = Date.UTC(2026, 9, 12, 9, 0, 0);
const APP = "https://dashboard.multipark.pt";
const TEMPLATES = { lisbon: { name: "documentos_em_falta", language: "pt_PT" }, porto: null, faro: null };

const allValidated = MANDATORY_DOC_TYPES.map((t) => ({ docType: t, status: "validated" }));
/** Checklist com tudo validado menos o indicado: null = em falta (sem ficheiro). */
const checklistWith = (over: Record<string, { status: string; rejectedReason?: string } | null>) =>
  docChecklist([
    ...allValidated.filter((d) => !(d.docType in over)),
    ...Object.entries(over).flatMap(([docType, v]) => (v ? [{ docType, status: v.status, rejectedReason: v.rejectedReason ?? null }] : [])),
  ]);

function person(over: Partial<DocsRequestPerson> = {}): DocsRequestPerson {
  return {
    id: 1, fullName: "Rui Santos", position: "extra", isActive: true, hasAccount: true,
    email: null, personalEmail: "rui@example.com", phoneE164: "+351912345678",
    noAutoEmail: false, noAutoWhatsapp: false, whatsappOptedOut: false, whatsappUnreachable: false,
    city: "lisbon",
    // Falta a fotografia; a carta foi recusada; o CC está pendente (conta como entregue).
    checklist: checklistWith({
      photo: null,
      driving_license: { status: "rejected", rejectedReason: "Ilegível\nrefaz" },
      id_card: { status: "pending" },
    }),
    ...over,
  };
}

const plan = (people: DocsRequestPerson[], o: Partial<Parameters<typeof planDocsRequests>[0]> = {}) => planDocsRequests({
  people, log: [], mode: "manual", channels: ["whatsapp", "email"], configured: { whatsapp: true, email: true },
  templates: TEMPLATES, nowMs: NOW, appUrl: APP, ...o,
});
const logRow = (over: Partial<DocsRequestLogRow>): DocsRequestLogRow => ({ employeeId: 1, mode: "manual", atMs: NOW - DAY, whatsappStatus: "sent", emailStatus: "sent", ...over });

describe("o que falta — pendente conta como entregue, recusado volta a faltar", () => {
  it("pede à pessoa só o que ela entrega; contrato e termo ficam com o RH", () => {
    const list = docChecklist([
      { docType: "id_card", status: "pending" },
      { docType: "driving_license", status: "rejected", rejectedReason: "Fora da validade" },
      { docType: "nib_proof", status: "validated" },
    ]);
    const { request, rhOnly } = docsToRequest(list);
    expect(request.map((d) => d.docType)).toEqual(["photo", "driving_license", "address_proof"]);
    expect(request.find((d) => d.docType === "driving_license")).toMatchObject({ state: "rejected", rejectedReason: "Fora da validade", label: "Carta de Condução" });
    expect(request.find((d) => d.docType === "photo")).toMatchObject({ state: "missing", rejectedReason: null });
    expect(rhOnly.map((d) => d.docType)).toEqual(["contract", "responsibility_term"]);
  });
  it("tudo entregue (validado ou pendente) → nada a pedir", () => {
    const pend = MANDATORY_DOC_TYPES.map((t) => ({ docType: t, status: "pending" }));
    expect(docsToRequest(docChecklist(pend))).toEqual({ request: [], rhOnly: [] });
  });
  it("os tipos pedidos à pessoa = obrigatórios que ela própria carrega (rhAccess)", () => {
    const expected = MANDATORY_DOC_TYPES.filter((t) => (SELF_UPLOAD_DOC_TYPES as readonly string[]).includes(t));
    expect([...DOCS_REQUEST_PERSON_DOC_TYPES].sort()).toEqual([...expected].sort());
  });
});

describe("texto do pedido", () => {
  const docs = docsToRequest(checklistWith({ photo: { status: "rejected", rejectedReason: "Desfocada" }, nib_proof: null })).request;
  it("uma linha para o {{2}} do WhatsApp, com o motivo da recusa e sem quebras", () => {
    expect(requestedDocLabel(docs[0])).toBe("Fotografia (recusado: Desfocada)");
    expect(docsRequestLine(docs)).toBe("Fotografia (recusado: Desfocada), Comprovativo NIB");
    const long = Array.from({ length: 40 }, () => docs[0]);
    const line = docsRequestLine(long);
    expect(line.length).toBeLessThanOrEqual(500);
    expect(line).not.toMatch(/[\r\n\t]/);
  });
  it("email: lista legível e onde carregar (com conta → link da ficha; sem conta → responder com fotografia)", () => {
    const withAccount = docsRequestEmailLines({ fullName: "Rui Santos", docs, hasAccount: true, appUrl: `${APP}/` });
    expect(withAccount[0]).toBe("Olá Rui,");
    expect(withAccount[2]).toBe("• Fotografia — recusado: Desfocada\n• Comprovativo NIB");
    expect(withAccount[3]).toContain(`${APP}/rh`);
    const without = docsRequestEmailLines({ fullName: "", docs, hasAccount: false, appUrl: APP });
    expect(without[0]).toBe("Olá colega,");
    expect(without[3]).toContain("Responde a este email");
    expect(without.join("\n")).not.toContain("/rh");
    expect(docsRequestEmailHtml(withAccount, APP)).toContain(`<a href="${APP}/rh">`);
    expect(docsRequestEmailHtml(["<b>x</b>"], APP)).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>");
  });
  it("primeiro nome e email mascarado no registo", () => {
    expect(docsRequestFirstName("  Ana  Maria Silva ")).toBe("Ana");
    expect(docsRequestFirstName(null)).toBe("colega");
    expect(maskEmailAddress("rui.santos@gmail.com")).toBe("r***@gmail.com");
  });
  it("o plano leva o texto exato: {{1}}, {{2}}, assunto e corpo do email", () => {
    const p = plan([person()]).people[0];
    expect(p.whatsappParams).toEqual(["Rui", "Fotografia, Carta de Condução (recusado: Ilegível refaz)"]);
    expect(p.template).toEqual(TEMPLATES.lisbon);
    expect(p.emailTo).toBe("rui@example.com");
    expect(p.emailLines.join("\n")).toContain("• Carta de Condução — recusado: Ilegível refaz");
    expect(p.rhOnly).toEqual([]);
  });
});

describe("template do WhatsApp por cidade (Definições)", () => {
  it("nome|língua; vazio ou mal escrito = por configurar", () => {
    expect(parseDocsTemplate("documentos_em_falta|pt_PT")).toEqual({ name: "documentos_em_falta", language: "pt_PT" });
    expect(parseDocsTemplate("")).toBeNull();
    expect(parseDocsTemplate("Documentos Em Falta|pt")).toBeNull();
    expect(docsTemplatesByCity({ lisbon: "a_b|pt_PT", porto: "", faro: 3 as any })).toEqual({ lisbon: { name: "a_b", language: "pt_PT" }, porto: null, faro: null });
  });
  it("a definição valida o formato e começa vazia (só email até alguém pôr o template)", () => {
    expect((SETTINGS as any)["rh.docsRequestTemplates"].defaultValue).toEqual({ lisbon: "", porto: "", faro: "" });
    expect(validateSetting("rh.docsRequestTemplates", { lisbon: "documentos_em_falta|pt_PT", porto: "", faro: "" }).ok).toBe(true);
    expect(validateSetting("rh.docsRequestTemplates", { lisbon: "documentos em falta", porto: "", faro: "" }).ok).toBe(false);
  });
  it("sem template na cidade → WhatsApp fica de fora com \"template por configurar\" e segue só o email", () => {
    const p = plan([person({ city: "porto" })]).people[0];
    expect(p.channels.whatsapp).toMatchObject({ action: "skip", kind: "template_missing" });
    expect((p.channels.whatsapp as any).reason).toContain("template por configurar (Porto)");
    expect(p.channels.email).toEqual({ action: "send" });
    expect(docsPlanWillSend(p)).toBe(true);
  });
  it("sem cidade nunca assume Lisboa", () => {
    const p = plan([person({ city: null })]).people[0];
    expect(p.channels.whatsapp).toMatchObject({ action: "skip", kind: "no_city" });
  });
});

describe("cadência: 1 pedido a cada 7 dias, máximo 4 automáticos", () => {
  it("conta o que saiu (ou a Meta não confirmou); falhado e ignorado não contam", () => {
    expect(docsRequestCounted({ whatsappStatus: "failed", emailStatus: "sent" })).toBe(true);
    expect(docsRequestCounted({ whatsappStatus: "unknown", emailStatus: null })).toBe(true);
    expect(docsRequestCounted({ whatsappStatus: "failed", emailStatus: "skipped" })).toBe(false);
    expect(docsRequestCounted({ whatsappStatus: null, emailStatus: null })).toBe(false);
  });
  it("pedido há 6 dias → fica de fora; há 7 dias → volta a receber", () => {
    expect(DOCS_REQUEST_COOLDOWN_DAYS).toBe(7);
    const six = plan([person()], { log: [logRow({ atMs: NOW - 6 * DAY, byName: "Márcia" })] }).people[0];
    expect(six.skip).toMatchObject({ kind: "cooldown" });
    expect(six.skip!.reason).toBe("já pedido a 06/10 (há 6 dias) — pode voltar a pedir-se a 13/10");
    expect(docsPlanWillSend(six)).toBe(false);
    expect(docsPlanIgnoredReasons(six)).toEqual([six.skip!.reason]);
    const seven = plan([person()], { log: [logRow({ atMs: NOW - 7 * DAY })] }).people[0];
    expect(seven.skip).toBeNull();
  });
  it("um pedido automático também conta para os 7 dias do envio à mão; um falhado não", () => {
    expect(plan([person()], { log: [logRow({ mode: "auto", atMs: NOW - DAY })] }).people[0].skip?.kind).toBe("cooldown");
    expect(plan([person()], { log: [logRow({ atMs: NOW - DAY, whatsappStatus: "failed", emailStatus: "failed" })] }).people[0].skip).toBeNull();
  });
  it("à mão, numa ficha, \"enviar mesmo assim\" passa por cima dos 7 dias; o automático nunca", () => {
    const log = [logRow({ atMs: NOW - DAY })];
    expect(plan([person()], { log, force: true }).people[0].skip).toBeNull();
    expect(plan([person()], { log, force: true, mode: "auto" }).people[0].skip?.kind).toBe("cooldown");
  });
  it("4 pedidos automáticos → o automático para (só à mão); à mão continua", () => {
    expect(DOCS_REQUEST_AUTO_MAX).toBe(4);
    const four = [1, 2, 3, 4].map((w) => logRow({ mode: "auto", atMs: NOW - w * 8 * DAY }));
    const auto = plan([person()], { log: four, mode: "auto" }).people[0];
    expect(auto.skip).toMatchObject({ kind: "auto_cap" });
    expect(auto.skip!.reason).toContain("só à mão");
    expect(plan([person()], { log: four, mode: "manual" }).people[0].skip).toBeNull();
    const three = four.slice(0, 3);
    expect(plan([person()], { log: three, mode: "auto" }).people[0].skip).toBeNull();
    // falhados não gastam pedidos automáticos
    const failed = [...three, logRow({ mode: "auto", atMs: NOW - 40 * DAY, whatsappStatus: "failed", emailStatus: "failed" })];
    expect(docsRequestCadence(failed, NOW).autoCount).toBe(3);
  });
  it("\"Último pedido: dd/mm por X (canais)\"", () => {
    const cad = docsRequestCadence([logRow({ atMs: NOW - 2 * DAY, byName: "Márcia Nunes", whatsappStatus: "skipped" }), logRow({ atMs: NOW - 20 * DAY })], NOW);
    expect(lastDocsRequestLabel(cad.last)).toBe("Último pedido: 10/10 por Márcia Nunes (Email)");
    const auto = docsRequestCadence([logRow({ mode: "auto", atMs: NOW })], NOW);
    expect(lastDocsRequestLabel(auto.last)).toBe("Último pedido: 12/10 automático (WhatsApp, Email)");
    expect(lastDocsRequestLabel(null)).toBeNull();
  });
});

describe("quem fica de fora e porquê", () => {
  const reasonsOf = (over: Partial<DocsRequestPerson>, o: Partial<Parameters<typeof planDocsRequests>[0]> = {}) => docsPlanIgnoredReasons(plan([person(over)], o).people[0]);
  it("sem telefone / sem email / \"Não enviar\" / STOP / sem WhatsApp", () => {
    const p = plan([person({ phoneE164: null, noAutoEmail: true })]).people[0];
    expect(p.channels.whatsapp).toMatchObject({ action: "skip", kind: "no_contact", reason: "sem telemóvel válido na ficha" });
    expect(p.channels.email).toMatchObject({ action: "skip", kind: "opted_out", reason: NO_AUTO_EMAIL_ERROR });
    expect(docsPlanIgnoredReasons(p)).toEqual(["WhatsApp: sem telemóvel válido na ficha", `Email: ${NO_AUTO_EMAIL_ERROR}`]);
    expect(reasonsOf({ noAutoWhatsapp: true, personalEmail: null })).toEqual([`WhatsApp: ${NO_AUTO_WHATSAPP_ERROR}`, "Email: sem email (de trabalho nem pessoal) na ficha"]);
    expect(reasonsOf({ whatsappOptedOut: true, personalEmail: null })[0]).toBe("WhatsApp: pediu STOP no WhatsApp");
    expect(reasonsOf({ whatsappUnreachable: true, personalEmail: null })[0]).toContain("sem WhatsApp");
  });
  it("canal não configurado", () => {
    expect(reasonsOf({}, { configured: { whatsapp: false, email: false } })).toEqual(["WhatsApp: WhatsApp não configurado", "Email: Envio de email não configurado"]);
  });
  it("só os canais escolhidos: sem o WhatsApp escolhido, segue só o email", () => {
    const p = plan([person()], { channels: ["email"] }).people[0];
    expect(p.channels.whatsapp).toEqual({ action: "off" });
    expect(p.channels.email).toEqual({ action: "send" });
  });
  it("não extra, inativo, nada em falta, só documentos do RH", () => {
    expect(reasonsOf({ position: "driver" })).toEqual(["não é extra (o pedido é só para extras)"]);
    expect(reasonsOf({ isActive: false })).toEqual(["ficha inativa"]);
    const done = docChecklist(allValidated);
    expect(plan([person({ checklist: done })]).people[0].skip?.kind).toBe("no_missing");
    const rh = docChecklist(allValidated.filter((d) => d.docType !== "contract"));
    expect(reasonsOf({ checklist: rh })).toEqual(["só faltam documentos do RH (Contrato de Trabalho)"]);
  });
  it("contagens por canal e pessoas que recebem", () => {
    const p = plan([person({ id: 1 }), person({ id: 2, fullName: "Ana", city: "faro" }), person({ id: 3, fullName: "Zé", isActive: false })]);
    expect(p.recipients).toBe(2);
    expect(p.toSend).toEqual({ whatsapp: 1, email: 2 });
    expect(p.people.map((x) => x.name)).toEqual(["Ana", "Rui Santos", "Zé"]);
  });
});

describe("pedido automático semanal", () => {
  const fakeDeps = (over: Partial<DocsAutoDeps> & { people?: DocsRequestPerson[]; log?: DocsRequestLogRow[]; clock?: { t: number } } = {}) => {
    const people = over.people ?? [person({ id: 5 }), person({ id: 7, noAutoEmail: true, phoneE164: null }), person({ id: 9, checklist: docChecklist(allValidated) })];
    const clock = over.clock ?? { t: NOW };
    const calls = { loadBatch: 0, request: [] as string[] };
    const deps: DocsAutoDeps = {
      flagOn: async () => true,
      loadBatch: async (after, limit) => { calls.loadBatch++; return people.filter((p) => p.id > after).slice(0, limit); },
      plan: async (batch, nowMs) => planDocsRequests({ people: batch, log: over.log ?? [], mode: "auto", channels: ["whatsapp", "email"], configured: { whatsapp: true, email: true }, templates: TEMPLATES, nowMs, appUrl: APP }),
      request: async (p, key) => {
        calls.request.push(key);
        clock.t += 1_000;
        return { employeeId: p.employeeId, name: p.name, already: false, whatsapp: { status: "sent", label: "enviado", detail: null }, email: { status: "sent", label: "enviado", detail: null } };
      },
      now: () => clock.t,
      ...over,
    };
    return { deps, calls };
  };

  it("interruptor desligado (omissão) = não lê nem envia nada", async () => {
    expect(automationFlagDefault("EXTRAS_DOCS_REQUEST")).toBe(false);
    expect(AUTOMATION_FLAGS.find((f) => f.name === "EXTRAS_DOCS_REQUEST")).toMatchObject({ label: "Pedir documentos em falta aos extras", defaultEnabled: false });
    const loadBatch = vi.fn(async () => []);
    const request = vi.fn();
    const { deps } = fakeDeps({ flagOn: async () => false, loadBatch, request });
    const r = await runDocsRequestAuto({ deadlineAt: NOW + 40_000 }, deps);
    expect(r.skipped).toContain("desligado");
    expect(r.done).toBe(true);
    expect(loadBatch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("ligado: pede só a quem recebe, uma chave por pessoa e semana ISO", async () => {
    const { deps, calls } = fakeDeps();
    const r = await runDocsRequestAuto({ deadlineAt: NOW + 40_000 }, deps);
    expect(calls.request).toEqual(["auto:2026-W42:5"]);
    expect(r).toMatchObject({ checked: 3, requested: 1, ignored: 1, done: true, lastId: 9, sent: { whatsapp: 1, email: 1 } });
  });

  it("respeita os 7 dias e o máximo de 4 automáticos", async () => {
    const log = [logRow({ employeeId: 5, mode: "manual", atMs: NOW - 2 * DAY })];
    const { deps, calls } = fakeDeps({ people: [person({ id: 5 }), person({ id: 6 })], log: [...log, ...[1, 2, 3, 4].map((w) => logRow({ employeeId: 6, mode: "auto", atMs: NOW - w * 8 * DAY }))] });
    const r = await runDocsRequestAuto({ deadlineAt: NOW + 40_000 }, deps);
    expect(calls.request).toEqual([]);
    expect(r).toMatchObject({ requested: 0, ignored: 2 });
  });

  it("sem tempo: para, devolve a última ficha tratada e continua daí", async () => {
    const people = [1, 2, 3, 4].map((id) => person({ id }));
    const clock = { t: NOW };
    const first = fakeDeps({ people, clock });
    const r1 = await runDocsRequestAuto({ deadlineAt: NOW + 1_500 }, first.deps);
    expect(r1.done).toBe(false);
    expect(first.calls.request).toEqual(["auto:2026-W42:1", "auto:2026-W42:2"]);
    expect(r1.lastId).toBe(2);
    const second = fakeDeps({ people, clock: { t: NOW } });
    const r2 = await runDocsRequestAuto({ deadlineAt: NOW + 40_000, afterId: r1.lastId! }, second.deps);
    expect(second.calls.request).toEqual(["auto:2026-W42:3", "auto:2026-W42:4"]);
    expect(r2.done).toBe(true);
  });

  it("um pedido que já tinha seguido (mesma chave) não conta outra vez", async () => {
    const { deps } = fakeDeps({ request: async (p) => ({ employeeId: p.employeeId, name: p.name, already: true, whatsapp: null, email: null }) });
    const r = await runDocsRequestAuto({ deadlineAt: NOW + 40_000 }, deps);
    expect(r.requested).toBe(0);
  });

  it("agendado à segunda de manhã (Lisboa), semanal, com função e entrada nos crons conhecidos", async () => {
    const job = TICK_JOBS.find((j) => j.key === "rh-docs-request")!;
    expect(job.cadence).toEqual({ kind: "weekly", dow: 1, from: "10:00" });
    expect(describeCadence(job.cadence)).toBe("semanal, segunda a partir das 10:00");
    expect(CRON_JOBS.find((c) => c.name === "rh-docs-request")?.intervalMinutes).toBe(10080);
    const { JOB_RUNNERS } = await import("./cronScheduler");
    expect(typeof JOB_RUNNERS["rh-docs-request"]).toBe("function");
    expect(src("server/_core/api-entry.ts")).toContain('app.get("/api/cron/rh-docs-request"');
    expect(src("server/cronJobs.ts").split("export async function rhDocsRequestCron")[1]?.slice(0, 600)).toContain("runDocsRequestAuto");
  });
});

describe("permissões e âmbito", () => {
  const back: RhViewer = { id: 3, role: "backoffice", employeeId: 30, scopeProjectIds: null };
  const front: RhViewer = { id: 4, role: "frontoffice", employeeId: 40, scopeProjectIds: null };
  const sup: RhViewer = { id: 5, role: "supervisor", employeeId: 50, scopeProjectIds: [10, 11] };
  const tl: RhViewer = { id: 6, role: "team_leader", employeeId: 60, scopeProjectIds: [10] };
  const extraSelf: RhViewer = { id: 8, role: "extra", employeeId: 80, scopeProjectIds: null };
  const extra: EmployeeRef = { id: 80, projectId: 10, role: "extra", position: "extra" };
  const extraOther: EmployeeRef = { id: 82, projectId: 99, role: null, position: "extra" };
  const driver: EmployeeRef = { id: 83, projectId: 10, role: "condutor", position: "driver" };

  it("pede quem valida os documentos (o RH da ficha), só a extras, nunca a própria; o team leader não", () => {
    expect(canRequestDocuments(sup, extra)).toBe(true);
    expect(canRequestDocuments(sup, extraOther)).toBe(false);
    expect(canRequestDocuments(back, extraOther)).toBe(true);
    expect(canRequestDocuments(front, extra)).toBe(true);
    expect(canRequestDocuments(tl, extra)).toBe(false);
    expect(canRequestDocuments(extraSelf, extra)).toBe(false);
    expect(canRequestDocuments(back, driver)).toBe(false);
  });

  it("em grupo: só as fichas das cidades do pedido e a quem se pode pedir", () => {
    const rows = [
      { id: 80, projectId: 10, accountRole: "extra", position: "extra" },
      { id: 81, projectId: 11, accountRole: null, position: "extra" },
      { id: 82, projectId: 99, accountRole: null, position: "extra" },
      { id: 84, projectId: null, accountRole: null, position: "extra" },
      { id: 83, projectId: 10, accountRole: "condutor", position: "driver" },
    ];
    expect(docsRequestableRows(sup, rows, [10, 11]).map((r) => r.id)).toEqual([80, 81]);
    // back office limitado a Lisboa pelas cidades do pedido: só Lisboa; sem centro fica de fora
    expect(docsRequestableRows(back, rows, [10, 11]).map((r) => r.id)).toEqual([80, 81]);
    // todas as cidades: entra também a ficha sem centro (o back office é nacional)
    expect(docsRequestableRows(back, rows, undefined).map((r) => r.id)).toEqual([80, 81, 82, 84]);
    expect(docsRequestableRows(tl, rows, undefined)).toEqual([]);
  });

  it("o router: rh:edit + canRequestDocuments + cidade; o envio volta a calcular o plano no servidor", () => {
    const r = src("server/rhDocsRequestRouter.ts");
    const guard = r.split("async function assertCanRequest")[1]?.slice(0, 700) ?? "";
    expect(guard).toMatch(/requireAccess\(user as any, "rh", "edit"\)/);
    expect(guard).toMatch(/canRequestDocuments\(viewer, ref\)/);
    expect(guard).toMatch(/assertEmployeeAccess\(employeeId\)/);
    const scoped = r.split("async function scopedCandidates")[1]?.slice(0, 800) ?? "";
    expect(scoped).toMatch(/scopedProjectIds\(\)/);
    expect(scoped).toMatch(/docsRequestableRows\(viewer, rows, scoped\)/);
    const bulk = r.split("bulkSend: protectedProcedure")[1]?.slice(0, 1200) ?? "";
    expect(bulk).toMatch(/scopedCandidates\(ctx\.user/);
    expect(bulk).toMatch(/buildDocsPlan\(people/);
    expect(src("server/rhRouter.ts")).toContain("docsRequest: docsRequestRouter");
  });
});

describe("registo (migração 0560) e envio", () => {
  it("tabela com chave única do pedido, registada no fim e espelhada no schema; nada se apaga", () => {
    expect(SCHEMA_MIGRATION_IDS[SCHEMA_MIGRATION_IDS.length - 1]).toBe("0560");
    const sql = MIGRATION_0560_STATEMENTS.join("\n");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `employee_docs_requests`/);
    expect(sql).toMatch(/UNIQUE KEY `uq_employee_docs_requests_key` \(`requestKey`\)/);
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b/i);
    expect(IDEMPOTENT_ERROR_CODES_0560.has("ER_TABLE_EXISTS_ERROR")).toBe(true);
    const schema = src("drizzle/schema.ts");
    expect(schema).toContain('export const employeeDocsRequests = mysqlTable("employee_docs_requests"');
    expect(schema).toContain('uniqueIndex("uq_employee_docs_requests_key").on(table.requestKey)');
    expect(src("server/rhDocsRequest.ts")).not.toMatch(/DELETE\s+FROM/i);
  });
  it("reserva antes de enviar, WhatsApp na conversa (sem repetir), email como envio automático, registo de atividade", () => {
    const s = src("server/rhDocsRequest.ts");
    const one = s.split("export async function requestDocsFromPerson")[1] ?? "";
    expect(one.indexOf("INSERT INTO employee_docs_requests")).toBeLessThan(one.indexOf("sendDocsWhatsApp(db"));
    expect(one).toMatch(/isDuplicateKey\(err\)/);
    expect(one).toMatch(/action: "employee_docs_request"/);
    expect(s).toMatch(/clientRequestId: `docsreq:\$\{o\.requestRowId\}`/);
    expect(s).toMatch(/auto: \{ kind: "docs_request", employeeId: p\.employeeId \}/);
    expect(AUTO_MAIL_KIND_LABELS.docs_request).toBe("Pedido de documentos em falta");
  });
});
