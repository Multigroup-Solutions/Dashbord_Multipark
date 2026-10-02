/**
 * P3 lote 19c — Perfil: IBAN por pedido aprovado pelo RH, foto validada,
 * "Não enviar" só o RH, sessões, preferências que não se leram ≠ omissões.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { ibanError, maskIban, maskNif, normalizeIban, sameIban, formatIban } from "../shared/iban";
import { nibChangeAction } from "./rhBankChange";
import { isRhFor, employeeAccess, type RhViewer } from "./rhAccess";
import { checkProfilePhoto, PHOTO_MAX_BYTES } from "./photoUpload";
import { isPersonalAccessPath, ownRecordEmployeeId } from "./cityAccess";
import { notificationPrefsDiff, NOTIFICATION_KIND_DEFS } from "../shared/notificationRouting";
import { AUTOMATION_FLAGS, automationFlagDefault } from "../shared/appSettings";
import { SCHEMA_MIGRATION_IDS } from "./migrations";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const GOOD = "PT50 0002 0123 1234 5678 9015 4";

describe("19c IBAN", () => {
  it("valida o número de controlo e o comprimento; NIB de 21 dígitos vira PT50", () => {
    expect(ibanError(GOOD)).toBeNull();
    expect(normalizeIban(GOOD)).toBe("PT50000201231234567890154");
    expect(normalizeIban("0002 0123 1234 5678 9015 4")).toBe("PT50000201231234567890154");
    expect(ibanError("PT50000201231234567890155")).toMatch(/controlo/);
    expect(ibanError("PT5000020123123456789015")).toMatch(/25 caracteres/);
    expect(ibanError("olá")).toMatch(/inválido/);
    expect(ibanError("")).toMatch(/falta/);
  });
  it("mascarado nos registos e no ecrã; o mesmo IBAN com outra formatação não é mudança", () => {
    expect(maskIban(GOOD)).toBe("PT50 •••• 0154");
    expect(maskNif("123456789")).toBe("••••••789");
    expect(formatIban("PT50000201231234567890154")).toBe("PT50 0002 0123 1234 5678 9015 4");
    expect(sameIban("pt50000201231234567890154", GOOD)).toBe(true);
  });
  it("quem não é o RH deixa um PEDIDO; o RH muda logo; o mesmo valor não mexe; inválido é erro", () => {
    expect(nibChangeAction("PT50000201231234567890154", GOOD, false)).toEqual({ kind: "unchanged" });
    expect(nibChangeAction(null, GOOD, false)).toEqual({ kind: "request", value: "PT50000201231234567890154" });
    expect(nibChangeAction(null, GOOD, true)).toEqual({ kind: "apply", value: "PT50000201231234567890154" });
    expect(nibChangeAction(null, "PT50 123", false).kind).toBe("error");
    expect(nibChangeAction("PT50000201231234567890154", "", false)).toMatchObject({ kind: "error" });
    expect(nibChangeAction("PT50000201231234567890154", "", true)).toEqual({ kind: "apply", value: null });
    expect(nibChangeAction("PT50000201231234567890154", undefined, false)).toEqual({ kind: "unchanged" });
  });
  it("rh.update usa o pedido; aprovar exige RH, nunca a própria ficha nem quem pediu", () => {
    const r = read("server/rhRouter.ts");
    expect(r).toMatch(/nibChangeAction\(current\?\.nib \?\? null, input\.nib, isRhFor\(viewer, ref\)\)/);
    expect(r).toMatch(/createBankChangeRequest\(id, nibAct\.value, ctx\.user\.id\)/);
    expect(r).toMatch(/Quem fez o pedido não o pode aprovar/);
    expect(r).toMatch(/Só o RH aprova ou recusa pedidos de IBAN/);
    const svc = read("server/rhBankChange.ts");
    expect(svc).toMatch(/encryptSecret\(value\)/);            // o IBAN novo fica cifrado até à aprovação
    expect(svc).not.toMatch(/\.delete\(/);                    // nada se apaga
    expect(SCHEMA_MIGRATION_IDS).toContain("0400");
    expect(read("server/migrations/migration_0400.ts")).toMatch(/CREATE TABLE IF NOT EXISTS \\`employee_bank_change_requests/);
  });
  it("aviso ao RH: tipo novo atrás de interruptor DESLIGADO por omissão", () => {
    expect(NOTIFICATION_KIND_DEFS.some((d) => d.kind === "rh_bank_change")).toBe(true);
    expect(AUTOMATION_FLAGS.some((f) => f.name === "RH_BANK_CHANGE_NOTIFY")).toBe(true);
    expect(automationFlagDefault("RH_BANK_CHANGE_NOTIFY")).toBe(false);
  });
});

describe("19c quem é o RH da ficha", () => {
  const v = (role: string, employeeId: number | null = 1, scope: number[] | null = null): RhViewer => ({ id: 10, role, employeeId, scopeProjectIds: scope });
  const other = { id: 2, projectId: 5, role: "extra" as string | null };
  const own = { id: 1, projectId: 5, role: "backoffice" as string | null };
  it("front/back office e admin nas fichas dos outros; nunca na própria (só o super admin)", () => {
    expect(isRhFor(v("backoffice"), other)).toBe(true);
    expect(isRhFor(v("frontoffice"), other)).toBe(true);
    expect(isRhFor(v("admin"), other)).toBe(true);
    expect(isRhFor(v("backoffice"), own)).toBe(false);
    expect(isRhFor(v("super_admin"), { ...own, role: "super_admin" })).toBe(true);
  });
  it("supervisor e team leader não são o RH (o IBAN que mudam fica pedido; não mexem no Não enviar)", () => {
    expect(isRhFor(v("supervisor", 1, [5]), other)).toBe(false);
    expect(isRhFor(v("team_leader", 1, [5]), other)).toBe(false);
    expect(isRhFor(v("extra", 2), { ...other })).toBe(false);
    expect(employeeAccess(v("backoffice"), other)).toMatchObject({ isRh: true });
  });
  it("'Não enviar' só o RH", () => {
    expect(read("server/rhRouter.ts")).toMatch(/if \(!isRhFor\(viewer, ref\)\) throw new TRPCError\(\{ code: "FORBIDDEN", message: "Só o RH/);
  });
});

describe("19c foto de perfil", () => {
  const b64 = (bytes: number[], pad = 32) => Buffer.from([...bytes, ...new Array(pad).fill(0)]).toString("base64");
  it("aceita JPEG, PNG e WebP pelos primeiros bytes; extensão e tipo da lista", () => {
    expect(checkProfilePhoto(b64([0xff, 0xd8, 0xff, 0xe0]))).toMatchObject({ ok: true, mime: "image/jpeg", ext: "jpg" });
    expect(checkProfilePhoto(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toMatchObject({ ok: true, mime: "image/png", ext: "png" });
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]).toString("base64");
    expect(checkProfilePhoto(webp)).toMatchObject({ ok: true, mime: "image/webp" });
    expect(checkProfilePhoto(`data:image/jpeg;base64,${b64([0xff, 0xd8, 0xff])}`)).toMatchObject({ ok: true });
  });
  it("recusa HTML, SVG, vazio e acima de 4 MB", () => {
    expect(checkProfilePhoto(Buffer.from("<html><script>alert(1)</script></html>").toString("base64"))).toMatchObject({ ok: false });
    expect(checkProfilePhoto(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64"))).toMatchObject({ ok: false });
    expect(checkProfilePhoto("")).toMatchObject({ ok: false });
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(PHOTO_MAX_BYTES)]).toString("base64");
    expect(checkProfilePhoto(big)).toMatchObject({ ok: false, error: expect.stringMatching(/4 MB/) });
  });
  it("as duas rotas usam a validação e registam a troca", () => {
    const r = read("server/rhRouter.ts");
    expect(r.match(/return savePhoto\(/g)?.length).toBe(2);
    expect(r).toMatch(/action: "photo"/);
    expect(r).not.toMatch(/input\.mimeType\.split\("\/"\)/);
  });
});

describe("19c sem centro de custos: o que é de cada um passa", () => {
  it("foto, PDA, Drive e terminar sessões são caminhos pessoais", () => {
    for (const p of ["rh.uploadMyPhoto", "operational.pdas.mine", "googleDrive.status", "settings.security.endMySessions"]) expect(isPersonalAccessPath(p)).toBe(true);
    expect(isPersonalAccessPath("rh.list")).toBe(false);
  });
  it("a própria ficha (por id) passa; outro caminho ou sem id não", () => {
    expect(ownRecordEmployeeId("rh.byId", { id: 7 })).toBe(7);
    expect(ownRecordEmployeeId("rh.documents.upload", { employeeId: 7 })).toBe(7);
    expect(ownRecordEmployeeId("rh.list", { id: 7 })).toBeNull();
    expect(ownRecordEmployeeId("rh.byId", {})).toBeNull();
    const t = read("server/_core/trpc.ts");
    expect(t).toMatch(/mine !== target\) throw new TRPCError\(\{ code: 'FORBIDDEN', message: MISSING_COST_CENTRE_MESSAGE \}\)/);
    expect(t).toMatch(/requestAccess = \{ \.\.\.access, all: false, cityIds: \[\], projectIds: \[\] \}/);
  });
  it("a conta numa readmissão cai na ficha ATIVA", () => {
    expect(read("server/db.ts")).toMatch(/where\(eq\(employees\.userId, userId\)\)\.orderBy\(desc\(employees\.isActive\), desc\(employees\.id\)\)/);
  });
});

describe("19c notificações e preferências Google", () => {
  it("erro de leitura chega ao ecrã; gravar só o interruptor mexido; fica registado", () => {
    const r = read("server/routers.ts");
    expect(r).not.toMatch(/receivableKinds\(ctx\.user\.id\)\.catch/);
    expect(r).toMatch(/change: z\.object\(\{ kind: z\.string\(\)\.max\(32\)/);
    expect(r).toMatch(/action: "notification_prefs"/);
    expect(read("server/appSettings.ts")).toMatch(/if \(!db\) throw new Error\("Base de dados indisponível\."\);\n  const res = await db\.execute\(sql`SELECT notificationPrefs/);
  });
  it("diferença das preferências em português", () => {
    const kind = NOTIFICATION_KIND_DEFS.find((d) => d.kind === "complaint_new")!;
    expect(notificationPrefsDiff({ muted: [], email: {} }, { muted: ["complaint_new"], email: {} })).toEqual([`silenciou «${kind.label}»`]);
    expect(notificationPrefsDiff({ muted: ["complaint_new"], email: {} }, { muted: [], email: { incident_critical: false } })).toHaveLength(2);
  });
  it("preferências Google que não se leram ≠ omissões; gravar junta às guardadas", () => {
    expect(read("server/google/syncService.ts")).toMatch(/prefs: prefsError \? null :/);
    expect(read("server/google/contactsService.ts")).toMatch(/prefs: prefsError \? null :/);
    expect(read("server/google/router.ts")).toMatch(/const next = \{ \.\.\.current, \.\.\.changes \}/);
    expect(read("server/contactsRouter.ts")).toMatch(/const next = \{ \.\.\.current, \.\.\.changes \}/);
    expect(read("server/google/userAccounts.ts")).toMatch(/readError: readError as string \| null/);
  });
  it("o texto do URL nunca é o título do aviso; nome aparado e com limite", () => {
    const c = read("client/src/components/GoogleAccountCard.tsx");
    expect(c).toMatch(/toast\.error\("Não foi possível ligar a conta Google\.", \{ description: safeReturnMessage/);
    expect(read("server/routers.ts")).toMatch(/name: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)\.optional\(\)/);
  });
});
