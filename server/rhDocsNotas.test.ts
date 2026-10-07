/**
 * Frente A — Documentos com validação e notas internas (Jorge, 7 out 2026):
 *  - "Os utilizadores devem conseguir submeter os seus documentos a 1a vez,
 *    não os devem conseguir editar/substituir depois de validados. Quando
 *    submetem os documentos deve ficar flagged com 'pendente de validação'"
 *  - "Os extras devem ter notas internas (ex. este extra trabalhou mal no
 *    dia ...)" — team leader e acima no seu âmbito; o próprio nunca vê.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canDeleteDocument, canEditInternalNote, canValidateDocuments, canViewInternalNotes, canWriteInternalNotes,
  documentUploadError, initialDocumentStatus, type EmployeeRef, type RhViewer,
} from "./rhAccess";
import {
  docChecklist, docStatusOf, docsSummary, docsSummaryLabel, docTypeState, DOC_STATUS_LABELS, MANDATORY_DOC_TYPES,
} from "../shared/employeeDocuments";
import { isNoteKind, NOTE_EDIT_WINDOW_MS, NOTE_KIND_LABELS, NOTE_KINDS } from "../shared/employeeNotes";
import { MIGRATION_0530_STATEMENTS, IDEMPOTENT_ERROR_CODES_0530, SEED_0530_ID } from "./migrations/migration_0530";
import { MIGRATION_0535_STATEMENTS, IDEMPOTENT_ERROR_CODES_0535 } from "./migrations/migration_0535";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { noteTimestampMs } from "./employeeNotes";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

// Âmbitos: centro 10/11 = Lisboa; 99 = outra cidade.
const superAdmin: RhViewer = { id: 1, role: "super_admin", employeeId: 10, scopeProjectIds: null };
const admin: RhViewer = { id: 2, role: "admin", employeeId: 20, scopeProjectIds: null };
const back: RhViewer = { id: 3, role: "backoffice", employeeId: 30, scopeProjectIds: null };
const front: RhViewer = { id: 4, role: "frontoffice", employeeId: 40, scopeProjectIds: null };
const sup: RhViewer = { id: 5, role: "supervisor", employeeId: 50, scopeProjectIds: [10, 11] };
const tl: RhViewer = { id: 6, role: "team_leader", employeeId: 60, scopeProjectIds: [10] };
const condutor: RhViewer = { id: 7, role: "condutor", employeeId: 75, scopeProjectIds: [10] };
const extraSelf: RhViewer = { id: 8, role: "extra", employeeId: 80, scopeProjectIds: null };

const extraFile: EmployeeRef = { id: 80, projectId: 10, role: "extra", position: "extra" };
const extraNoAccount: EmployeeRef = { id: 81, projectId: 10, role: null, position: "extra" };
const extraOtherCity: EmployeeRef = { id: 82, projectId: 99, role: "extra", position: "extra" };
const tlFile: EmployeeRef = { id: 61, projectId: 10, role: "team_leader", position: "team_leader" };
const adminFile: EmployeeRef = { id: 21, projectId: 10, role: "admin", position: "director" };
const superFile: EmployeeRef = { id: 10, projectId: 10, role: "super_admin", position: "director" };

describe("documentos — regras puras do estado", () => {
  it("estado do tipo: validado > pendente > recusado > em falta; linhas antigas = validado", () => {
    expect(docTypeState([])).toBe("missing");
    expect(docTypeState([{ status: "rejected" }])).toBe("rejected");
    expect(docTypeState([{ status: "rejected" }, { status: "pending" }])).toBe("pending");
    expect(docTypeState([{ status: "pending" }, { status: "validated" }])).toBe("validated");
    expect(docStatusOf({ status: undefined })).toBe("validated");
    expect(DOC_STATUS_LABELS).toEqual({ pending: "Pendente de validação", validated: "Validado", rejected: "Recusado" });
  });

  it("checklist: pendente conta como entregue (não bloqueia o login); recusado volta a faltar, com o motivo", () => {
    const list = docChecklist([
      { docType: "id_card", status: "pending" },
      { docType: "driving_license", status: "rejected", rejectedReason: "Ilegível" },
      { docType: "photo", status: "validated" },
      { docType: "other", status: "pending" },
    ]);
    expect(list.map((c) => c.docType)).toEqual([...MANDATORY_DOC_TYPES]);
    const by = Object.fromEntries(list.map((c) => [c.docType, c]));
    expect(by.id_card).toMatchObject({ present: true, state: "pending" });
    expect(by.driving_license).toMatchObject({ present: false, state: "rejected", rejectedReason: "Ilegível" });
    expect(by.photo).toMatchObject({ present: true, state: "validated", rejectedReason: null });
    expect(by.contract).toMatchObject({ present: false, state: "missing" });
  });

  it("resumo da lista: completos / em falta e, à parte, N por validar (todos os tipos)", () => {
    const all = MANDATORY_DOC_TYPES.map((t) => ({ docType: t, status: "validated" }));
    expect(docsSummaryLabel(docsSummary(all))).toBe("Completos");
    const s = docsSummary([...all.slice(1), { docType: "photo", status: "pending" }, { docType: "other", status: "pending" }]);
    expect(s).toMatchObject({ total: 7, present: 7, validated: 6, pendingCount: 2, missing: [] });
    expect(docsSummaryLabel(s)).toBe("Completos · 2 por validar");
    expect(docsSummaryLabel(docsSummary([{ docType: "photo", status: "pending" }]))).toBe("6 em falta · 1 por validar");
  });
});

describe("documentos — quem valida, quem entrega, quem retira", () => {
  it("valida o RH da ficha (supervisor da cidade, front/back office, admin+) — nunca a própria, nunca o team leader", () => {
    expect(canValidateDocuments(sup, extraFile)).toBe(true);
    expect(canValidateDocuments(sup, extraOtherCity)).toBe(false);
    expect(canValidateDocuments(back, extraOtherCity)).toBe(true);
    expect(canValidateDocuments(front, extraOtherCity)).toBe(true);
    expect(canValidateDocuments(admin, extraFile)).toBe(true);
    expect(canValidateDocuments(admin, superFile)).toBe(false);
    expect(canValidateDocuments(tl, extraFile)).toBe(false);
    expect(canValidateDocuments(extraSelf, extraFile)).toBe(false);
    expect(canValidateDocuments(sup, { id: 50, projectId: 10, role: "supervisor" })).toBe(false);
    expect(canValidateDocuments(superAdmin, { id: 10, projectId: 10, role: "super_admin" })).toBe(false); // nem o super admin valida os seus
    expect(canValidateDocuments(superAdmin, adminFile)).toBe(true);
  });

  it("o que o RH carrega entra validado; o que a pessoa ou o team leader carregam fica pendente", () => {
    expect(initialDocumentStatus(extraSelf, extraFile)).toBe("pending");
    expect(initialDocumentStatus(tl, extraFile)).toBe("pending");
    expect(initialDocumentStatus(sup, extraFile)).toBe("validated");
    expect(initialDocumentStatus(back, extraFile)).toBe("validated");
    expect(initialDocumentStatus(superAdmin, { id: 10, projectId: 10, role: "super_admin" })).toBe("pending");
  });

  it("a pessoa entrega a 1.ª vez, volta a entregar se pendente/recusado, nunca depois de validado", () => {
    expect(documentUploadError(extraSelf, extraFile, "id_card", [])).toBeNull();
    expect(documentUploadError(extraSelf, extraFile, "id_card", ["pending"])).toBeNull();
    expect(documentUploadError(extraSelf, extraFile, "id_card", ["rejected"])).toBeNull();
    expect(documentUploadError(extraSelf, extraFile, "id_card", ["rejected", "validated"])).toMatch(/já foi validado pelo RH e já não o podes substituir/);
    // "Outros" não tranca (documentos soltos)
    expect(documentUploadError(extraSelf, extraFile, "other", ["validated"])).toBeNull();
    // quem carrega por ela sem ser RH também não substitui
    expect(documentUploadError(tl, extraFile, "driving_license", ["validated"])).toMatch(/só o RH o substitui/);
    // o RH substitui sempre
    expect(documentUploadError(sup, extraFile, "driving_license", ["validated"])).toBeNull();
    expect(documentUploadError(admin, extraFile, "driving_license", ["validated"])).toBeNull();
  });

  it("retirar = arquivar: o RH sempre; quem carregou só enquanto não está validado", () => {
    expect(canDeleteDocument(extraSelf, extraFile, extraSelf.id, "pending")).toBe(true);
    expect(canDeleteDocument(extraSelf, extraFile, extraSelf.id, "rejected")).toBe(true);
    expect(canDeleteDocument(extraSelf, extraFile, extraSelf.id, "validated")).toBe(false);
    expect(canDeleteDocument(extraSelf, extraFile, 999, "pending")).toBe(false);
    expect(canDeleteDocument(tl, extraFile, tl.id, "validated")).toBe(false);
    expect(canDeleteDocument(tl, extraFile, tl.id, "pending")).toBe(true);
    expect(canDeleteDocument(sup, extraFile, 999, "validated")).toBe(true);
    expect(canDeleteDocument(back, extraOtherCity, 999, "validated")).toBe(true);
    expect(canDeleteDocument(sup, extraOtherCity, 999, "pending")).toBe(false);
  });

  it("servidor: upload grava o estado do plano; validar/recusar com guarda própria e registo; apagar arquiva", () => {
    const r = src("server/rhRouter.ts");
    expect(r.match(/const plan = await documentUploadPlan\(ctx\.user, input\.employeeId, input\.docType\);/g)?.length).toBe(2);
    expect(r.match(/uploadedById: ctx\.user\.id,\n\s+\.\.\.plan,/g)?.length).toBe(2);
    const validate = r.split("validate: protectedProcedure")[1]?.slice(0, 900) ?? "";
    expect(validate).toMatch(/await assertCanValidateDocuments\(ctx\.user, doc\.employeeId\);/);
    expect(validate).toMatch(/action: "employee_document_validate"/);
    const reject = r.split("reject: protectedProcedure")[1]?.slice(0, 1300) ?? "";
    expect(reject).toMatch(/await assertCanValidateDocuments\(ctx\.user, doc\.employeeId\);/);
    expect(reject).toMatch(/action: "employee_document_reject"/);
    expect(reject).toMatch(/notifyDocumentRejected\(/);
    const del = r.split("    delete: protectedProcedure")[1]?.slice(0, 1200) ?? "";
    expect(del).toMatch(/archiveEmployeeDocument\(input\.id, ctx\.user\.id\)/);
    expect(del).not.toMatch(/deleteEmployeeDocument/);
    expect(src("server/db.ts")).not.toMatch(/db\.delete\(employeeDocuments\)/);
    // as leituras só veem os ativos
    expect(src("server/db.ts")).toMatch(/isNull\(employeeDocuments\.archivedAt\)\)\)\n\s+\.orderBy\(desc\(employeeDocuments\.createdAt\)\)/);
    // o que o RH gera (Drive) entra validado
    expect(src("server/google/driveService.ts")).toMatch(/status: "validated", validatedById: user\.id/);
  });

  it("guarda de validação: rh:edit + canValidateDocuments + cidade; a carta só com data real até hoje", () => {
    const r = src("server/rhRouter.ts");
    const guard = r.split("async function assertCanValidateDocuments")[1]?.slice(0, 700) ?? "";
    expect(guard).toMatch(/requireAccess\(user as any, "rh", "edit"\)/);
    expect(guard).toMatch(/canValidateDocuments\(viewer, ref\)/);
    expect(guard).toMatch(/assertEmployeeAccess\(employeeId\)/);
    const lic = r.split("validateDrivingLicence: protectedProcedure")[1]?.slice(0, 1600) ?? "";
    expect(lic).toMatch(/input\.issuedAt > today/);
    expect(lic).toMatch(/assertCanValidateDocuments\(ctx\.user, input\.employeeId\)/);
    expect(lic).toMatch(/action: "driving_licence_validate"/);
  });
});

describe("notas internas — quem lê/escreve (TL e acima no âmbito; nunca o próprio)", () => {
  it("nunca a própria ficha — nem o super admin", () => {
    expect(canViewInternalNotes(extraSelf, extraFile)).toBe(false);
    expect(canViewInternalNotes(tl, { id: 60, projectId: 10, role: "team_leader" })).toBe(false);
    expect(canViewInternalNotes(superAdmin, superFile)).toBe(false);
  });
  it("abaixo do team leader: ninguém (extra, condutor, utilizador)", () => {
    expect(canViewInternalNotes(condutor, extraFile)).toBe(false);
    expect(canViewInternalNotes({ id: 9, role: "user", employeeId: null, scopeProjectIds: null }, extraFile)).toBe(false);
  });
  it("team leader: quem está abaixo dele, no seu centro", () => {
    expect(canViewInternalNotes(tl, extraFile)).toBe(true);
    expect(canViewInternalNotes(tl, extraNoAccount)).toBe(true);
    expect(canViewInternalNotes(tl, extraOtherCity)).toBe(false);
    expect(canViewInternalNotes(tl, tlFile)).toBe(false);
  });
  it("supervisor: a sua cidade; front/back office e admin: todas; ninguém vê fichas de quem está acima", () => {
    expect(canViewInternalNotes(sup, extraFile)).toBe(true);
    expect(canViewInternalNotes(sup, tlFile)).toBe(true);
    expect(canViewInternalNotes(sup, extraOtherCity)).toBe(false);
    expect(canViewInternalNotes(front, extraOtherCity)).toBe(true);
    expect(canViewInternalNotes(back, extraOtherCity)).toBe(true);
    expect(canViewInternalNotes(admin, extraOtherCity)).toBe(true);
    expect(canViewInternalNotes(sup, adminFile)).toBe(false);
    expect(canViewInternalNotes(admin, superFile)).toBe(false);
    expect(canViewInternalNotes(superAdmin, adminFile)).toBe(true);
    expect(canWriteInternalNotes).toBe(canViewInternalNotes);
  });

  it("editar/arquivar: o autor nas primeiras 24 h, ou admin; sempre dentro do âmbito", () => {
    const t0 = Date.UTC(2026, 9, 7, 10, 0, 0);
    const mine = { authorId: tl.id, createdAtMs: t0 };
    expect(canEditInternalNote(tl, extraFile, mine, t0 + 60_000)).toBe(true);
    expect(canEditInternalNote(tl, extraFile, mine, t0 + NOTE_EDIT_WINDOW_MS)).toBe(true);
    expect(canEditInternalNote(tl, extraFile, mine, t0 + NOTE_EDIT_WINDOW_MS + 1)).toBe(false);
    expect(canEditInternalNote(sup, extraFile, mine, t0 + 60_000)).toBe(false);          // não é o autor
    expect(canEditInternalNote(admin, extraFile, mine, t0 + 30 * NOTE_EDIT_WINDOW_MS)).toBe(true);
    expect(canEditInternalNote(tl, extraOtherCity, mine, t0 + 60_000)).toBe(false);      // perdeu o âmbito
    expect(canEditInternalNote(tl, extraFile, { authorId: tl.id, createdAtMs: NaN }, t0)).toBe(false);
  });

  it("timestamps da BD (UTC) → ms", () => {
    expect(noteTimestampMs("2026-10-07 10:00:00")).toBe(Date.UTC(2026, 9, 7, 10, 0, 0));
    expect(noteTimestampMs("2026-10-07T10:00:00Z")).toBe(Date.UTC(2026, 9, 7, 10, 0, 0));
    expect(Number.isNaN(noteTimestampMs(null))).toBe(true);
  });

  it("tipos e etiquetas PT-PT", () => {
    expect(NOTE_KINDS.map((k) => NOTE_KIND_LABELS[k])).toEqual(["Geral", "Desempenho", "Comportamento", "Elogio"]);
    expect(isNoteKind("praise")).toBe(true);
    expect(isNoteKind("health")).toBe(false);
  });

  it("as notas só saem em rh.notes.* (guarda própria) — nunca no byId/me nem na disponibilidade do extra", () => {
    const r = src("server/rhRouter.ts");
    const notes = r.split("  notes: router({")[1] ?? "";
    expect(notes.match(/await notesContext\(ctx\.user, /g)?.length).toBe(4);
    const guard = r.split("async function notesContext")[1]?.slice(0, 700) ?? "";
    expect(guard).toMatch(/canViewInternalNotes\(viewer, ref\)/);
    expect(guard).toMatch(/requireAccess\(user as any, "rh", "view"\)/);
    expect(guard).toMatch(/assertEmployeeAccess\(employeeId\)/);
    // o módulo das notas só é usado pelo router das notas
    expect(r.match(/import\("\.\/employeeNotes"\)/g)?.length).toBe(4);
    const byId = r.split("  byId: protectedProcedure")[1]?.split("  create: protectedProcedure")[0] ?? "";
    expect(byId).not.toMatch(/employeeNotes|listEmployeeNotes/);
    const me = r.split("  me: protectedProcedure")[1]?.slice(0, 300) ?? "";
    expect(me).not.toMatch(/notes/i);
    expect(src("server/routers.ts")).not.toMatch(/employeeNotes|employee_notes/);
    // o texto da nota não vai para o registo de atividade
    expect(notes).not.toMatch(/details: `[^`]*input\.body/);
  });
});

describe("migrações 0530 e 0535 (só acrescentam; idempotentes)", () => {
  it("0530: estado dos documentos, arquivo, índice, carta na ficha e no lead; backfill antigo → validado UMA vez", () => {
    const s = MIGRATION_0530_STATEMENTS.join("\n");
    expect(s).toMatch(/ADD COLUMN `status` ENUM\('pending','validated','rejected'\) NOT NULL DEFAULT 'pending'/);
    for (const c of ["validatedById", "validatedAt", "rejectedReason", "archivedAt", "archivedById"]) expect(s).toContain(`ADD COLUMN \`${c}\``);
    expect(s).toMatch(/ADD INDEX `idx_employee_documents_emp_type_status` \(`employeeId`, `docType`, `status`\)/);
    for (const c of ["drivingLicenseIssuedAt` DATE", "drivingLicenseValidatedAt` DATETIME", "drivingLicenseValidatedById` INT"]) expect(s).toContain(`\`employees\` ADD COLUMN \`${c}`);
    expect(s).toContain("`extra_leads` ADD COLUMN `drivingLicenseIssuedAt` DATE NULL");
    const backfill = MIGRATION_0530_STATEMENTS.find((x) => x.startsWith("UPDATE `employee_documents`"))!;
    expect(backfill).toMatch(/SET `status` = 'validated'/);
    expect(backfill).toContain(`mk.\`id\` = '${SEED_0530_ID}'`);
    // a marca grava-se DEPOIS do backfill
    expect(MIGRATION_0530_STATEMENTS.indexOf(backfill)).toBeLessThan(MIGRATION_0530_STATEMENTS.findIndex((x) => x.includes(`VALUES ('${SEED_0530_ID}')`)));
    expect(s).not.toMatch(/\bDROP\b|\bDELETE\b/);
    expect([...IDEMPOTENT_ERROR_CODES_0530].sort()).toEqual(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
  });
  it("0535: tabela employee_notes com arquivo e índices", () => {
    const s = MIGRATION_0535_STATEMENTS.join("\n");
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS `employee_notes`/);
    for (const c of ["employeeId` INT NOT NULL", "body` TEXT NOT NULL", "kind` VARCHAR(16)", "workDate` VARCHAR(10) NULL", "assignmentId` INT NULL", "authorId` INT NOT NULL", "archivedAt` TIMESTAMP NULL", "archivedById` INT NULL"]) expect(s).toContain(`\`${c}`);
    expect(s).toContain("KEY `idx_employee_notes_emp_created` (`employeeId`, `createdAt`)");
    expect([...IDEMPOTENT_ERROR_CODES_0535]).toEqual(["ER_TABLE_EXISTS_ERROR"]);
  });
  it("registadas no fim da lista e espelhadas no schema", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0530");
    expect(SCHEMA_MIGRATION_IDS).toContain("0535");
    expect(SCHEMA_MIGRATION_IDS.indexOf("0535")).toBe(SCHEMA_MIGRATION_IDS.indexOf("0530") + 1);
    const schema = src("drizzle/schema.ts");
    expect(schema).toMatch(/export const employeeNotes = mysqlTable\("employee_notes"/);
    expect(schema).toMatch(/status: mysqlEnum\(\['pending','validated','rejected'\]\)\.default\('pending'\)\.notNull\(\)/);
    expect(schema).toMatch(/drivingLicenseIssuedAt: date\(\{ mode: 'string' \}\)/);
  });
});
