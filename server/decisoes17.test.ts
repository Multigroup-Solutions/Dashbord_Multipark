/**
 * P3 lote 17e — decisões do Jorge (2 out 2026) sobre o lote 17:
 *  - LEAD_AUTO_REPLY (escreve a gente de fora) desligado por omissão;
 *  - o email pessoal dos outros não aparece na caixa geral do super admin;
 *  - do email do RH, só os currículos vão para o Drive pessoal;
 *  - conversas (e chamadas) sem cidade são de todos os que têm o WhatsApp;
 *  - o toque lê a BD uma vez por processo a cada 2 s (não 1×/s por separador).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { automationFlagDefault } from "../shared/appSettings";
import { isCurriculumFilename, isHrMailThread, mailAttachmentDriveAllowed } from "../shared/mail";
import { parseNotificationPrefs, resolveRecipients, type RoutingCandidate } from "../shared/notificationRouting";
import { CALL_STREAM_TICK_MS, RING_PROBE_TTL_MS } from "../shared/whatsappCallSignal";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Interruptores", () => {
  it("LEAD_AUTO_REPLY desligado por omissão (como as outras automações que escrevem a gente de fora)", () => {
    expect(automationFlagDefault("LEAD_AUTO_REPLY")).toBe(false);
  });
});

describe("Email do RH → Drive pessoal: só currículos", () => {
  const rhBox = { module: "rh" as const, pipeline: null, addresses: [] };
  const infoBox = { module: "comunicacao" as const, pipeline: null, addresses: [{ address: "rh@multipark.pt", brand: "multipark", destination: "recursos-humanos" } as any] };
  it("reconhece o email do RH (caixa, pipeline, alias ou recursos-humanos@)", () => {
    expect(isHrMailThread(rhBox as any, "x@multipark.pt")).toBe(true);
    expect(isHrMailThread(infoBox as any, "rh@multipark.pt")).toBe(true);
    expect(isHrMailThread(null, "recursos-humanos@multipark.pt")).toBe(true);
    expect(isHrMailThread(infoBox as any, "info@multipark.pt")).toBe(false);
  });
  it("currículos pelo nome; o resto do RH não sai; fora do RH tudo pode", () => {
    for (const n of ["CV_Joao_Silva.pdf", "Joao Silva - CV.docx", "Currículo Ana.pdf", "curriculum_vitae.pdf", "resume-2026.pdf"]) expect(isCurriculumFilename(n)).toBe(true);
    for (const n of ["CC_frente.jpg", "certificado.pdf", "cvc.pdf", "IBAN.png"]) expect(isCurriculumFilename(n)).toBe(false);
    expect(mailAttachmentDriveAllowed(true, "CV.pdf")).toBe(true);
    expect(mailAttachmentDriveAllowed(true, "CC_frente.jpg")).toBe(false);
    expect(mailAttachmentDriveAllowed(false, "CC_frente.jpg")).toBe(true);
  });
  it("o servidor recusa e o ecrã esconde o botão", () => {
    expect(src("server/google/driveService.ts")).toContain("if (!mailAttachmentDriveAllowed(hr, a.filename)) throw new TRPCError({ code: \"FORBIDDEN\", message: HR_MAIL_NO_DRIVE_MESSAGE });");
    expect(src("server/mail/inbox.ts")).toContain("driveAllowed: mailAttachmentDriveAllowed(hrThread, a.filename),");
    expect(src("client/src/components/mail/MailThreadView.tsx")).toContain("{a.driveAllowed !== false && <SaveToDriveButton");
  });
});

describe("Sem cidade = de todos", () => {
  const cand = (id: number, role: string, cities: RoutingCandidate["cities"]): RoutingCandidate => ({ id, role, isActive: true, cities, prefs: parseNotificationPrefs(null) });
  const people = [cand(1, "team_leader", ["lisboa"] as any), cand(2, "team_leader", ["porto"] as any), cand(3, "frontoffice", "all")];
  it("chamada perdida sem cidade: com noCityToAll avisa todas as cidades; sem ele só quem vê tudo", () => {
    const all = resolveRecipients({ kind: "whatsapp_missed_call", city: null, noCityToAll: true }, people).map((r) => r.userId).sort();
    expect(all).toEqual([1, 2, 3]);
    const old = resolveRecipients({ kind: "whatsapp_missed_call", city: null }, people).map((r) => r.userId);
    expect(old).toEqual([3]);
    // Com cidade, continua só essa cidade.
    const lx = resolveRecipients({ kind: "whatsapp_missed_call", city: "lisboa" as any, noCityToAll: true }, people).map((r) => r.userId).sort();
    expect(lx).toEqual([1, 3]);
  });
  it("chamadas perdidas e SLA do WhatsApp usam a regra", () => {
    expect(src("server/whatsappCalls.ts")).toContain("noCityToAll: true,");
    expect(src("server/whatsappInboxOps.ts")).toContain("noCityToAll: true,");
  });
});

describe("Toque: menos leituras à BD", () => {
  it("uma leitura partilhada por processo a cada 2 s; o stream verifica de 2 em 2 s", () => {
    expect(CALL_STREAM_TICK_MS).toBe(2_000);
    expect(RING_PROBE_TTL_MS).toBe(2_000);
    const q = src("server/whatsappCallsQueries.ts");
    expect(q).toContain("if (probeCache && nowMs - probeCache.at < RING_PROBE_TTL_MS) return probeCache.value;");
    expect(src("server/whatsappCallStream.ts")).toContain("(await anyIncomingCallCached()) ? ringingIds(await listIncomingCalls(scope, Date.now(), { probed: true })) : new Set<number>()");
    expect(src("server/whatsappCallsRouter.ts")).toContain("if (!(await anyIncomingCallCached())) return [];");
  });
});

describe("Respostas automáticas obedecem ao interruptor (o STOP fica sempre)", () => {
  it("aviso de receção das reclamações lê o interruptor fresco", () => {
    const c = src("server/complaintsExtended.ts");
    expect(c.indexOf("await ensureFeatureFlagOverrides().catch(() => {});")).toBeGreaterThan(-1);
    expect(c.indexOf("await ensureFeatureFlagOverrides().catch(() => {});")).toBeLessThan(c.indexOf("if (!isComplaintAutoAckEnabled())"));
    // 24a (D30): interruptor próprio, que sem valor próprio segue EXTRAS_AUTOMATION.
    expect(src("server/extrasAutomation.ts")).toContain('if (!availabilityAutoReplyOn()) return { action: "none" };');
  });
});
