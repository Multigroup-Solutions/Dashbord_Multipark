import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Módulos falsos para as verificações de acesso (driveAccess.ts) ─────────
const f = vi.hoisted(() => ({
  inScope: vi.fn(),
  threadAccess: vi.fn(),
  canView: vi.fn(),
  canUpload: vi.fn(),
  loadTask: vi.fn(),
  rows: [] as any[],
}));
vi.mock("./mail/inbox", async (original) => ({ ...(await original<object>()), assertEntityInScope: f.inScope, threadAccess: f.threadAccess }));
vi.mock("./routers", () => ({ assertCanViewDocuments: f.canView, assertCanUploadDocuments: f.canUpload }));
vi.mock("./tasksRouter", () => ({ loadTaskFor: f.loadTask }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({ execute: async () => [f.rows, []] }),
  getEmployeeById: async (id: number) => ({ employee: { id, fullName: "Ana Silva", projectId: 7 } }),
  getProjects: async () => [{ id: 5, name: "Porto", level: "city", parentId: null }, { id: 7, name: "Parque Aeroporto", level: "park", parentId: 5 }],
}));

import { TRPCError } from "@trpc/server";
import {
  DWD_DRIVE_SCOPES, DRIVE_FILE_SCOPE, SHEET_EXPORT_GATES, buildPlaceholderValues, chunkSheetWrites, columnLetter, driveQueryLiteral, extractPlaceholders,
  fallbackViewLink, folderPathKey, generatedDocName, normalizeDriveEntityId, parseDriveConfig, parseDriveFileId, placeholdersFor, replaceAllTextRequests,
  safeGoogleLink, sanitizeDriveName, sanitizeSheetTitle, sharedFolderPath, sheetValuesToCsv, templateTypesFor, a1Range, driveFileKind,
  DEFAULT_DRIVE_CONFIG, GENERATE_DESTINATIONS, GOOGLE_MIME, driveConfigSchema, generateDestinationAllowed, liveDriveProblem,
} from "../shared/drive";
import { GOOGLE_FEATURES_ENABLED, GOOGLE_FEATURE_SCOPES, SHEETS_READONLY_SCOPE, hasFeatureScopes, hasSheetsReadScope } from "../shared/mail";
import { scopesFor } from "./google/workspace";
import { requestedFeatures } from "./google/userAccounts";
import { ensureFolderPath, type FolderStore } from "./google/driveFolders";
import { createSpreadsheet, refreshSpreadsheet, loadReportTabs, assertCanExportReport, liveReportInput, normalizeTabs } from "./google/sheetsExport";
import { prefixTabs } from "./google/driveJobs";
import {
  HR_NO_DRIVE_MESSAGE, generateDocument, generateEmployeePdf, loadSourceBytes, saveToUserDrive, sharedDriveContext, sheetImportDeniedMessage,
} from "./google/driveService";
import { liveSheetInDrive } from "./google/driveJobs";
import { multipartBody, type DriveApiLike, type DriveFileMeta, type SheetsApiLike } from "./google/driveApi";
import { assertDriveEntityAccess, cityNameOfProject } from "./google/driveAccess";
import { parseCsvLine } from "./extrasImport";
import { MIGRATION_0160_STATEMENTS } from "./migrations/migration_0160";
import { cityScope } from "./cityScope";

beforeEach(() => {
  vi.clearAllMocks();
  f.rows = [];
  f.inScope.mockResolvedValue(undefined);
});

// ─── 1. Âmbitos ─────────────────────────────────────────────────────────────

describe("Drive — âmbitos (mínimos)", () => {
  it("funcionalidade 'drive' ligada e pede drive.file + spreadsheets.readonly (importar de qualquer folha)", () => {
    expect(GOOGLE_FEATURES_ENABLED).toContain("drive");
    expect(GOOGLE_FEATURE_SCOPES.drive).toEqual([DRIVE_FILE_SCOPE, SHEETS_READONLY_SCOPE]);
    expect(DRIVE_FILE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
    expect(SHEETS_READONLY_SCOPE).toBe("https://www.googleapis.com/auth/spreadsheets.readonly");
    expect(scopesFor(["drive"])).toEqual(["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/spreadsheets.readonly"]);
    // nada de drive / drive.readonly / spreadsheets (escrita) / documents no OAuth por pessoa
    expect(scopesFor(["drive"]).some((s) => /auth\/(drive|drive\.readonly|spreadsheets|documents)$/.test(s))).toBe(false);
  });
  it("spreadsheets.readonly é opcional: quem só tem drive.file continua com o Drive ativo, mas sem ler folhas pelo link", () => {
    expect(hasFeatureScopes(`openid ${DRIVE_FILE_SCOPE}`, "drive")).toBe(true);
    expect(hasSheetsReadScope(`openid ${DRIVE_FILE_SCOPE}`)).toBe(false);
    expect(hasSheetsReadScope(`openid ${DRIVE_FILE_SCOPE} ${SHEETS_READONLY_SCOPE}`)).toBe(true);
    expect(hasFeatureScopes(`openid ${SHEETS_READONLY_SCOPE}`, "drive")).toBe(false);
    expect(sheetImportDeniedMessage(false)).toMatch(/Autorizar leitura de folhas/);
    expect(sheetImportDeniedMessage(true)).toMatch(/Não tens acesso a esta folha/);
  });
  it("autorização incremental: 'drive' pedido sozinho ou com outros", () => {
    expect(requestedFeatures("drive")).toEqual(["drive"]);
    expect(requestedFeatures("gmail,drive,x")).toEqual(["gmail", "drive"]);
    expect(hasFeatureScopes(`openid ${DRIVE_FILE_SCOPE}`, "drive")).toBe(true);
    expect(hasFeatureScopes("openid https://www.googleapis.com/auth/drive.readonly", "drive")).toBe(false);
  });
  it("delegação (Shared Drive, modelos): drive + documents, sem spreadsheets", () => {
    expect([...DWD_DRIVE_SCOPES]).toEqual(["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents"]);
  });
  it("migração 0160 idempotente (só CREATE TABLE IF NOT EXISTS)", () => {
    expect(MIGRATION_0160_STATEMENTS.length).toBe(5);
    for (const s of MIGRATION_0160_STATEMENTS) expect(s.startsWith("CREATE TABLE IF NOT EXISTS")).toBe(true);
    expect(MIGRATION_0160_STATEMENTS.join(" ")).toMatch(/uq_google_drive_links_entity_file/);
  });
  it("definições: omissões seguras; espelho/relatórios exigem o Shared Drive", () => {
    const d = parseDriveConfig(null);
    expect(d.sharedEnabled).toBe(false);
    expect(d.sharedDriveName).toBe("Multipark");
    expect(parseDriveConfig({ sharedEnabled: true, ownerEmail: "" }).sharedEnabled).toBe(false); // inválido → omissão
    expect(parseDriveConfig({ mirrorComplaintEvidence: true }).mirrorComplaintEvidence).toBe(false);
    expect(parseDriveConfig({ sharedEnabled: true, ownerEmail: "Drive@Multipark.pt", mirrorComplaintEvidence: true }).ownerEmail).toBe("drive@multipark.pt");
  });
  it("RH nunca no Drive: sem espelho do RH nem Shared Drive do RH (valores antigos ignorados)", () => {
    const old = parseDriveConfig({ sharedEnabled: true, ownerEmail: "drive@multipark.pt", mirrorRhDocuments: true, rhDriveName: "Multipark RH" }) as Record<string, unknown>;
    expect(old.sharedEnabled).toBe(true);
    expect("mirrorRhDocuments" in old).toBe(false);
    expect("rhDriveName" in old).toBe(false);
    expect("mirrorRhDocuments" in DEFAULT_DRIVE_CONFIG).toBe(false);
  });
});

// ─── 2. Links, nomes e pastas ───────────────────────────────────────────────

describe("Drive — links e nomes", () => {
  it("id a partir dos links do Drive/Docs/Sheets/Slides", () => {
    expect(parseDriveFileId("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing")).toBe("1AbCdEfGhIjKlMnOp");
    expect(parseDriveFileId("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp_-x/edit")).toBe("1AbCdEfGhIjKlMnOp_-x");
    expect(parseDriveFileId("https://docs.google.com/spreadsheets/u/0/d/1AbCdEfGhIjKlMnOp/edit#gid=0")).toBe("1AbCdEfGhIjKlMnOp");
    expect(parseDriveFileId("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit")).toBe("1AbCdEfGhIjKlMnOp");
    expect(parseDriveFileId("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp")).toBe("1AbCdEfGhIjKlMnOp");
    expect(parseDriveFileId(" 1AbCdEfGhIjKlMnOp ")).toBe("1AbCdEfGhIjKlMnOp");
  });
  it("recusa outros domínios, http e lixo", () => {
    expect(parseDriveFileId("https://evil.example/file/d/1AbCdEfGhIjKlMnOp/view")).toBeNull();
    expect(parseDriveFileId("http://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view")).toBeNull();
    expect(parseDriveFileId("javascript:alert(1)")).toBeNull();
    expect(parseDriveFileId("abc")).toBeNull();
    expect(parseDriveFileId("")).toBeNull();
  });
  it("só links https da Google chegam à UI", () => {
    expect(safeGoogleLink("https://docs.google.com/document/d/x/edit")).toBe("https://docs.google.com/document/d/x/edit");
    expect(safeGoogleLink("javascript:alert(1)")).toBeNull();
    expect(safeGoogleLink("https://google.com.evil.pt/x")).toBeNull();
    expect(fallbackViewLink("abc123XYZ_-", "application/vnd.google-apps.spreadsheet")).toBe("https://docs.google.com/spreadsheets/d/abc123XYZ_-/edit");
    expect(fallbackViewLink("abc123XYZ_-", null)).toBe("https://drive.google.com/file/d/abc123XYZ_-/view");
    expect(driveFileKind("application/pdf")).toBe("pdf");
    expect(driveFileKind("image/png")).toBe("image");
  });
  it("nomes seguros (sem barras, controlo, vazio, '..')", () => {
    expect(sanitizeDriveName("  Ana / Silva\\ \u0000 x  ")).toBe("Ana - Silva- x");
    expect(sanitizeDriveName("..")).toBe("Sem nome");
    expect(sanitizeDriveName("")).toBe("Sem nome");
    expect(sanitizeDriveName("a".repeat(300)).length).toBe(120);
    expect(driveQueryLiteral("O'Neil \\ x")).toBe("'O\\'Neil \\\\ x'");
  });
  it("estrutura do Shared Drive (Clientes, Reclamações/ano/id, Parcerias; sem RH)", () => {
    expect(sharedFolderPath({ kind: "client", name: "Ana Silva", email: "ana@x.pt" })).toEqual(["Clientes", "Ana Silva (ana@x.pt)"]);
    expect(sharedFolderPath({ kind: "client", name: null, email: "ana@x.pt" })).toEqual(["Clientes", "ana@x.pt"]);
    expect(sharedFolderPath({ kind: "complaint", id: 42, createdAt: "2026-03-01 10:00:00" })).toEqual(["Reclamações", "2026", "42"]);
    expect(sharedFolderPath({ kind: "complaint", id: 42, createdAt: null })).toEqual(["Reclamações", "Sem data", "42"]);
    // RH/<cidade>/<trabalhador> deixou de existir (os documentos do RH nunca vão para o Drive).
    expect(sharedFolderPath({ kind: "employee", id: 9, name: "João/Pé", city: null } as any)).toBeUndefined();
    expect(sharedFolderPath({ kind: "partner", id: 3, name: "Agência X" })).toEqual(["Parcerias", "Agência X"]);
    expect(folderPathKey(["RH", "Porto", "Ana (#1)"])).toBe("RH/Porto/Ana (#1)");
  });
  it("ids dos registos normalizados", () => {
    expect(normalizeDriveEntityId("client", " Ana@X.PT ")).toBe("ana@x.pt");
    expect(normalizeDriveEntityId("client", "nope")).toBeNull();
    expect(normalizeDriveEntityId("complaint", "0042")).toBe("42");
    expect(normalizeDriveEntityId("complaint", "-1")).toBeNull();
    expect(normalizeDriveEntityId("task", "1; DROP")).toBeNull();
  });
});

// ─── 3. Pastas a pedido (cache → procura → cria) ────────────────────────────

function fakeDrive(): DriveApiLike & { folders: Map<string, { name: string; parent: string }>; calls: string[] } {
  const folders = new Map<string, { name: string; parent: string }>();
  const calls: string[] = [];
  let n = 0;
  const meta = (id: string, name = "f", mimeType: string | null = null): DriveFileMeta => ({ id, name, mimeType, webViewLink: `https://docs.google.com/x/${id}`, iconLink: null, ownerEmail: null, ownerName: null, driveId: null, size: null });
  return {
    folders, calls,
    async getFile(id) { calls.push(`get:${id}`); if (!folders.has(id)) throw Object.assign(new Error("nf"), { response: { status: 404 } }); return meta(id); },
    async findFolder(name, parent) { calls.push(`find:${parent}/${name}`); for (const [id, f] of folders) if (f.name === name && f.parent === parent) return id; return null; },
    async createFolder(name, parent) { const id = `fold${++n}`; calls.push(`create:${parent}/${name}`); folders.set(id, { name, parent: parent ?? "root" }); return id; },
    async createFile(m) { calls.push(`createFile:${m.name}`); return meta(`sheet${++n}`, m.name, m.mimeType); },
    async upload(m) { calls.push(`upload:${m.name}`); return meta(`up${++n}`, m.name, m.convertTo ?? m.mimeType); },
    async copy(id, m) { calls.push(`copy:${id}`); return meta(`copy${++n}`, m.name); },
    async exportAs() { return Buffer.from(""); },
    async download() { return Buffer.from(""); },
    async shareWithUser() {},
    async findSharedDrive() { return "drive1"; },
    async remove() {},
  };
}
function memStore(): FolderStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(s, p) { return map.get(`${s}|${p}`) ?? null; },
    async put(s, p, id) { map.set(`${s}|${p}`, id); },
    async forget(s, p) { map.delete(`${s}|${p}`); },
  };
}

describe("Drive — pastas criadas a pedido", () => {
  it("cria o caminho uma vez e depois usa a cache", async () => {
    const api = fakeDrive();
    const store = memStore();
    const o = { scopeKey: "shared:drive1", rootId: "drive1", driveId: "drive1", segments: ["RH", "Porto", "Ana (#1)"] };
    const id1 = await ensureFolderPath(api, store, o);
    expect(api.calls.filter((c) => c.startsWith("create:"))).toEqual(["create:drive1/RH", "create:fold1/Porto", "create:fold2/Ana (#1)"]);
    api.calls.length = 0;
    const id2 = await ensureFolderPath(api, store, o);
    expect(id2).toBe(id1);
    expect(api.calls).toEqual([]); // sem pedidos à Google
    expect(store.map.get("shared:drive1|RH/Porto/Ana (#1)")).toBe(id1);
  });
  it("reaproveita pastas já existentes no Drive (procura antes de criar)", async () => {
    const api = fakeDrive();
    api.folders.set("existing", { name: "Clientes", parent: "drive1" });
    const id = await ensureFolderPath(api, memStore(), { scopeKey: "s", rootId: "drive1", segments: ["Clientes", "Ana"] });
    expect(api.calls).toContain("find:drive1/Clientes");
    expect(api.calls).not.toContain("create:drive1/Clientes");
    expect(api.folders.get(id)?.parent).toBe("existing");
  });
  it("pasta apagada no Drive (404) com verify → recria", async () => {
    const api = fakeDrive();
    const store = memStore();
    await store.put("user:1", "Multipark", "gone");
    const id = await ensureFolderPath(api, store, { scopeKey: "user:1", rootId: "root", segments: ["Multipark"], verify: true });
    expect(id).not.toBe("gone");
    expect(api.calls).toContain("create:root/Multipark");
  });
  it("nomes com barras nunca criam subpastas", async () => {
    const api = fakeDrive();
    await ensureFolderPath(api, memStore(), { scopeKey: "s", rootId: "r", segments: ["a/b"] });
    expect(api.calls).toContain("create:r/a-b");
  });
});

// ─── 4. Modelos: marcadores → replaceAllText ────────────────────────────────

describe("Docs — marcadores dos modelos", () => {
  const ctx = { today: "2026-09-25", user: { name: "Rita", email: "rita@multipark.pt" }, canSeeSalary: true, cityName: "Porto" };
  const emp = { fullName: "Ana Silva", nif: "123456789", address: "Rua A", nationality: "PT", birthDate: "1990-02-03 00:00:00", email: "ana@multipark.pt", phone: "+351912345678", position: "driver", contractType: "fixed_term", contractStart: "2026-10-01", contractEnd: "2027-03-31", monthlySalary: "950.5", mealAllowancePerDay: "6" };

  it("colaborador: campos, datas e ordenado (quem vê ordenados)", () => {
    const v = buildPlaceholderValues("employee", emp, ctx);
    expect(v).toMatchObject({
      nome: "Ana Silva", nif: "123456789", data_nascimento: "03/02/1990", cargo: "Condutor(a)", cidade: "Porto", tipo_contrato: "A termo certo",
      inicio_contrato: "01/10/2026", fim_contrato: "31/03/2027", data_hoje: "25/09/2026", data_hoje_extenso: "25 de setembro de 2026", utilizador_nome: "Rita",
    });
    expect(v.salario_mensal).toMatch(/^950[,.]50$/);
  });
  it("sem acesso aos ordenados → ordenado e subsídio em branco", () => {
    const v = buildPlaceholderValues("employee", emp, { ...ctx, canSeeSalary: false });
    expect(v.salario_mensal).toBe("");
    expect(v.subsidio_alimentacao).toBe("");
  });
  it("reclamação, cliente e parceria", () => {
    expect(buildPlaceholderValues("complaint", { id: 7, title: "Risco", clientName: "Rui", vehiclePlate: "aa-00-bb", complaintStatus: "analyzing", createdAt: "2026-09-01 10:00:00" }, ctx))
      .toMatchObject({ reclamacao_id: "7", cliente_nome: "Rui", matricula: "AA-00-BB", reclamacao_estado: "Em análise", reclamacao_data: "01/09/2026" });
    expect(buildPlaceholderValues("client", { email: "c@x.pt", name: "Carla", bookings: 3, firstCheckIn: "2025-01-02" }, ctx))
      .toMatchObject({ cliente_email: "c@x.pt", reservas: "3", primeira_reserva: "02/01/2025" });
    expect(buildPlaceholderValues("partner", { name: "Agência", partnerNif: "500", commissionRate: 10, monthlyFee: 0 }, ctx))
      .toMatchObject({ parceiro_nome: "Agência", comissao: "10" });
  });
  it("só chaves do catálogo (+ comuns) — nada de campos soltos do registo", () => {
    const v = buildPlaceholderValues("employee", { ...emp, nib: "PT50…", passwordHash: "x" }, ctx);
    const allowed = new Set(placeholdersFor("employee").map((p) => p.key));
    for (const k of Object.keys(v)) expect(allowed.has(k)).toBe(true);
    expect(Object.values(v)).not.toContain("PT50…");
  });
  it("pedidos replaceAllText: {{chave}} e {{ chave }}, sem maiúsculas a contar", () => {
    const r = replaceAllTextRequests({ nome: "Ana", nif: "1" });
    expect(r).toEqual([
      { replaceAllText: { containsText: { text: "{{nome}}", matchCase: false }, replaceText: "Ana" } },
      { replaceAllText: { containsText: { text: "{{ nome }}", matchCase: false }, replaceText: "Ana" } },
      { replaceAllText: { containsText: { text: "{{nif}}", matchCase: false }, replaceText: "1" } },
      { replaceAllText: { containsText: { text: "{{ nif }}", matchCase: false }, replaceText: "1" } },
    ]);
    expect(replaceAllTextRequests({ x: "a\r\nb" }, { variants: false })[0].replaceAllText.replaceText).toBe("a\nb");
  });
  it("marcadores de um modelo e nome do documento", () => {
    expect(extractPlaceholders("Eu, {{nome}}, NIF {{ nif }}, {{NOME}} {{x-y}} {{data_hoje}}")).toEqual(["nome", "nif", "data_hoje"]);
    expect(generatedDocName("contrato_trabalho", "Ana / Silva", "2026-09-25")).toBe("Contrato de trabalho — Ana - Silva — 2026-09-25");
    expect(templateTypesFor("employee")).toEqual(["contrato_trabalho", "declaracao"]);
    expect(templateTypesFor("complaint")).toEqual(["resposta_reclamacao"]);
    expect(templateTypesFor("task")).toEqual([]);
  });
});

// ─── 5. Sheets: blocos, criação, atualização ────────────────────────────────

function fakeSheets(): SheetsApiLike & { log: any[] } {
  const log: any[] = [];
  let tabs = [{ sheetId: 0, title: "Folha1" }];
  return {
    log,
    async listSheets() { return tabs; },
    async batchUpdate(_id, requests) {
      log.push({ batchUpdate: requests });
      for (const r of requests as any[]) {
        if (r.updateSheetProperties) tabs = tabs.map((t) => (t.sheetId === r.updateSheetProperties.properties.sheetId ? { ...t, title: r.updateSheetProperties.properties.title } : t));
        if (r.addSheet) tabs = [...tabs, { sheetId: tabs.length, title: r.addSheet.properties.title }];
      }
    },
    async writeValues(_id, data) { log.push({ write: data.map((d) => d.range) }); },
    async clearValues(_id, ranges) { log.push({ clear: ranges }); },
    async readValues() { return []; },
  };
}

describe("Sheets — exportador", () => {
  it("colunas A1 e títulos de separador válidos/únicos", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(26)).toBe("Z");
    expect(columnLetter(27)).toBe("AA");
    expect(columnLetter(703)).toBe("AAA");
    const used = new Set<string>();
    expect(sanitizeSheetTitle("Resumo", used)).toBe("Resumo");
    expect(sanitizeSheetTitle("resumo", used)).toBe("resumo (2)");
    expect(sanitizeSheetTitle("a/b:c*?[d]", used)).toBe("a b c d");
    expect(a1Range("O'Brien", 3, 2, 5)).toBe("'O''Brien'!A3:B7");
  });
  it("divide em blocos por células e por linhas, com os intervalos certos", () => {
    const rows = Array.from({ length: 25 }, (_, i) => [i, `n${i}`, null]);
    const req = chunkSheetWrites([{ name: "T", rows }], { maxCells: 30, maxRows: 100 });
    // 3 colunas → 10 linhas por bloco → 3 blocos, cada um num pedido (30 células)
    expect(req.length).toBe(3);
    expect(req.map((r) => r.map((x) => x.range))).toEqual([["'T'!A1:C10"], ["'T'!A11:C20"], ["'T'!A21:C25"]]);
    expect(req[0][0].values[0]).toEqual([0, "n0", ""]);
    const byRows = chunkSheetWrites([{ name: "T", rows }], { maxCells: 10_000, maxRows: 8 });
    expect(byRows.flat().map((x) => x.values.length)).toEqual([8, 8, 8, 1]);
    // vários separadores pequenos juntam-se no mesmo pedido
    const small = chunkSheetWrites([{ name: "A", rows: [[1]] }, { name: "B", rows: [[1, 2]] }]);
    expect(small.length).toBe(1);
    expect(small[0].map((x) => x.range)).toEqual(["'A'!A1:A1", "'B'!A1:B1"]);
  });
  it("linhas de larguras diferentes ficam retangulares; números não finitos em branco", () => {
    const [[w]] = chunkSheetWrites([{ name: "T", rows: [[1], [1, 2, 3], [Number.NaN]] }]);
    expect(w.values).toEqual([[1, "", ""], [1, 2, 3], ["", "", ""]]);
  });
  it("cria a folha na pasta, renomeia o 1.º separador, acrescenta os outros e escreve", async () => {
    const drive = fakeDrive();
    const sheets = fakeSheets();
    const r = await createSpreadsheet({ drive, sheets }, { name: "Clientes", parentId: "fold1", tabs: [{ name: "Resumo", rows: [["a"]] }, { name: "Série", rows: [["b"]] }], deadlineAt: Date.now() + 60_000 });
    expect(r.partial).toBe(false);
    expect(drive.calls).toContain("createFile:Clientes");
    expect(sheets.log[0].batchUpdate).toEqual([
      { updateSheetProperties: { properties: { sheetId: 0, title: "Resumo" }, fields: "title" } },
      { addSheet: { properties: { title: "Série" } } },
    ]);
    expect(sheets.log[1]).toEqual({ write: ["'Resumo'!A1:A1", "'Série'!A1:A1"] });
  });
  it("prazo a acabar → para e devolve 'partial'", async () => {
    const sheets = fakeSheets();
    let t = 0;
    const rows = Array.from({ length: 5000 }, (_, i) => Array.from({ length: 20 }, () => i));
    const r = await createSpreadsheet({ drive: fakeDrive(), sheets }, { name: "X", parentId: null, tabs: [{ name: "T", rows }], deadlineAt: 10_000, now: () => (t += 3_000) });
    expect(r.partial).toBe(true);
    expect(r.written).toBeLessThan(r.chunks);
  });
  it("relatório ao vivo: limpa só os separadores do relatório e reescreve", async () => {
    const sheets = fakeSheets();
    const tabs = prefixTabs("financeiro", [{ name: "Resumo", rows: [["x"]] }]);
    expect(tabs[0].name).toBe("Financeiro — Resumo");
    await refreshSpreadsheet(sheets, "id", tabs, Date.now() + 60_000);
    expect(sheets.log.find((l) => l.clear)).toEqual({ clear: ["'Financeiro — Resumo'"] });
    expect(sheets.log.find((l) => l.batchUpdate)?.batchUpdate).toEqual([{ addSheet: { properties: { title: "Financeiro — Resumo" } } }]);
  });
  it("sem dados → um separador 'Sem dados' (nunca uma folha vazia a rebentar)", () => {
    expect(normalizeTabs([])).toEqual([{ name: "Folha", rows: [["Sem dados"]] }]);
  });
  it("relatórios usam o procedimento da página (mesmas permissões) e mapeiam as colunas", async () => {
    const call = vi.fn(async (path: string, input: any) => {
      if (path === "clients.list") return input.page === 1
        ? { canSeeTotals: false, rows: Array.from({ length: 200 }, (_, i) => ({ name: `C${i}`, email: `c${i}@x.pt`, bookings: 1 })) }
        : { canSeeTotals: false, rows: [{ name: "Z", email: "z@x.pt", bookings: 2 }] };
      if (path === "evaluation.ranking") return [{ employeeName: "Ana", position: "driver", days: 2, score: { totalPoints: 10, positivePoints: 12, negativePoints: 2 }, openDisputes: 0, metrics: { actions: 5 } }];
      throw new Error(path);
    });
    const tabs = await loadReportTabs(call, { report: "clientes", projectId: 50 }, Date.now() + 60_000);
    expect(call).toHaveBeenCalledWith("clients.list", expect.objectContaining({ page: 1, pageSize: 200, projectId: 50 }));
    expect(call).toHaveBeenCalledWith("clients.list", expect.objectContaining({ page: 2 }));
    expect(tabs[0].rows.length).toBe(1 + 201);
    expect(tabs[0].rows[0]).not.toContain("Gasto total"); // sem totais financeiros → sem colunas de gasto
    const av = await loadReportTabs(call, { report: "avaliacoes", from: "2026-09-01", to: "2026-09-25" }, Date.now() + 60_000);
    expect(av[0].rows[1].slice(0, 4)).toEqual(["Ana", "driver", 2, 10]);
  });
  it("exportar exige a ação da matriz (clientes/avaliação/faturação: exportar; extras: gerir)", () => {
    expect(SHEET_EXPORT_GATES.extras_metricas).toEqual({ module: "extras_dia", action: "manage" });
    expect(() => assertCanExportReport({ role: "admin" }, "clientes")).not.toThrow();
    expect(() => assertCanExportReport({ role: "backoffice" }, "clientes")).toThrow(TRPCError);
    expect(() => assertCanExportReport({ role: "supervisor" }, "avaliacoes")).toThrow(TRPCError);
    expect(() => assertCanExportReport({ role: "admin" }, "faturacao")).toThrow(TRPCError); // Faturação: só super admin
    expect(() => assertCanExportReport({ role: "super_admin" }, "faturacao")).not.toThrow();
    expect(() => assertCanExportReport({ role: "team_leader" }, "extras_metricas")).toThrow(TRPCError);
  });
  it("relatórios ao vivo: período relativo ao dia", () => {
    expect(liveReportInput("financeiro", "2026-09-25")).toEqual({ report: "financeiro", from: "2026-09-01", to: "2026-09-25" });
    expect(liveReportInput("avaliacoes", "2026-09-25")).toEqual({ report: "avaliacoes", from: "2026-08-27", to: "2026-09-25" });
  });
  it("envio multipart: metadados JSON + conteúdo", () => {
    const b = multipartBody({ name: "a.pdf", parents: ["p"] }, Buffer.from("PDF"), "application/pdf", "BND").toString("utf8");
    expect(b).toContain('--BND\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.pdf","parents":["p"]}');
    expect(b).toContain("Content-Type: application/pdf\r\n\r\nPDF\r\n--BND--");
  });
});

// ─── 6. Importar de uma folha → o validador de CSV existente ────────────────

describe("Sheets — importação pelo caminho do CSV", () => {
  it("valores da folha → CSV que o parser das importações lê igual", () => {
    const values = [
      ["nome", "nivel", "email", "morada"],
      ["Ana, a Grande", "junior", "ana@x.pt", 'Rua "Nova"\n2.º'],
      ["Rui", "senior"],
      [],
      ["", ""],
    ];
    const csv = sheetValuesToCsv(values);
    const lines = csv.split("\n");
    expect(lines.length).toBe(3); // as linhas vazias no fim saem
    expect(parseCsvLine(lines[0])).toEqual(["nome", "nivel", "email", "morada"]);
    expect(parseCsvLine(lines[1])).toEqual(["Ana, a Grande", "junior", "ana@x.pt", 'Rua "Nova" 2.º']);
    expect(parseCsvLine(lines[2])).toEqual(["Rui", "senior", "", ""]);
  });
  it("números formatados (PT) mantêm-se como texto entre aspas", () => {
    const csv = sheetValuesToCsv([["2019", "1", "85.000,50"]]);
    expect(csv).toBe('2019,1,"85.000,50"');
    expect(sheetValuesToCsv(null)).toBe("");
  });
});

// ─── 7. Acesso aos registos (matriz + cidade) ───────────────────────────────

describe("Drive — acesso aos registos", () => {
  const inCity = <T>(fn: () => Promise<T>) => cityScope.run({ all: false, defaultCityId: 50, cityIds: [50], projectIds: [50], missingCostCenter: false }, fn);

  it("cliente: exige Clientes e a cidade do cliente", async () => {
    f.rows = [{ name: "Ana", n: 2 }];
    const r = await inCity(() => assertDriveEntityAccess({ id: 1, role: "team_leader" }, "client", "Ana@X.pt", "edit"));
    expect(f.inScope).toHaveBeenCalledWith("client", "ana@x.pt");
    expect(r.folder).toEqual({ kind: "client", name: "Ana", email: "ana@x.pt" });
    await expect(assertDriveEntityAccess({ id: 1, role: "condutor" }, "client", "ana@x.pt", "view")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("reclamação de outra cidade → FORBIDDEN (antes de qualquer pedido à Google)", async () => {
    f.inScope.mockRejectedValueOnce(new TRPCError({ code: "FORBIDDEN", message: "Este registo não pertence à tua cidade." }));
    await expect(inCity(() => assertDriveEntityAccess({ id: 1, role: "supervisor" }, "complaint", "7", "view"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    // extra só vê as reclamações "próprias" → não liga ficheiros
    await expect(assertDriveEntityAccess({ id: 1, role: "extra" }, "complaint", "7", "edit")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("RH: ver = quem vê os documentos da ficha; ligar/gerar = quem os carrega; SEM pasta no Drive", async () => {
    f.canView.mockResolvedValue(undefined);
    const r = await assertDriveEntityAccess({ id: 1, role: "supervisor" }, "employee", "9", "view");
    expect(f.canView).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 9, expect.any(String));
    expect(f.canUpload).not.toHaveBeenCalled();
    expect(r.folder).toBeNull();
    f.canUpload.mockRejectedValueOnce(new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" }));
    await expect(assertDriveEntityAccess({ id: 2, role: "user" }, "employee", "9", "edit")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("conversa de email: regras da Comunicação; ligar exige poder tratar a conversa", async () => {
    f.threadAccess.mockResolvedValue({ thread: { subject: "Olá" }, canAct: false });
    const r = await assertDriveEntityAccess({ id: 1, role: "backoffice" }, "mail_thread", "5", "view");
    expect(r.label).toBe("Email: Olá");
    await expect(assertDriveEntityAccess({ id: 1, role: "backoffice" }, "mail_thread", "5", "edit")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("tarefa: regras da tarefa (loadTaskFor); sem pasta no Shared Drive", async () => {
    f.loadTask.mockResolvedValue({ task: { title: "Limpar" } });
    const r = await assertDriveEntityAccess({ id: 1, role: "extra" }, "task", "3", "edit");
    expect(f.loadTask).toHaveBeenCalledWith({ user: expect.objectContaining({ id: 1 }) }, 3);
    expect(r.folder).toBeNull();
    await expect(assertDriveEntityAccess({ id: 1, role: "user" }, "task", "3", "view")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("parceria: módulo Parcerias (editar = admin+)", async () => {
    f.rows = [{ id: 3, name: "Agência" }];
    await expect(assertDriveEntityAccess({ id: 1, role: "backoffice" }, "partner", "3", "edit")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = await assertDriveEntityAccess({ id: 1, role: "admin" }, "partner", "3", "edit");
    expect(r.folder).toEqual({ kind: "partner", id: 3, name: "Agência" });
  });
  it("id inválido → BAD_REQUEST", async () => {
    await expect(assertDriveEntityAccess({ id: 1, role: "admin" }, "complaint", "abc", "view")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("cidade de um centro de custos sobe na árvore", async () => {
    expect(await cityNameOfProject(7)).toBe("Porto");
    expect(await cityNameOfProject(null)).toBeNull();
  });
});

// ─── Decisões do dono (26 set 2026): RH nunca no Drive; relatórios ao vivo restritos ─

describe("RH nunca vai para o Google Drive", () => {
  it("'Guardar no Drive' de um documento do RH é recusado (antes de ler o ficheiro)", async () => {
    await expect(saveToUserDrive({ id: 1, role: "super_admin" }, { kind: "employee_document", id: 5 } as any)).rejects.toMatchObject({ code: "FORBIDDEN", message: HR_NO_DRIVE_MESSAGE });
    await expect(loadSourceBytes({ id: 1, role: "super_admin" }, { kind: "employee_document", id: 5 } as any)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("'Gerar documento' no RH só para a app (PDF na ficha); Drive recusado — e os outros registos nunca 'app'", async () => {
    expect(GENERATE_DESTINATIONS).toEqual(["shared", "user", "app"]);
    expect(generateDestinationAllowed("employee", "app")).toBe(true);
    expect(generateDestinationAllowed("employee", "shared")).toBe(false);
    expect(generateDestinationAllowed("employee", "user")).toBe(false);
    expect(generateDestinationAllowed("complaint", "app")).toBe(false);
    expect(generateDestinationAllowed("client", "shared")).toBe(true);
    for (const destination of ["shared", "user"] as const) {
      await expect(generateDocument({ id: 1, role: "super_admin" }, { templateId: 1, entityType: "employee", entityId: "9", destination })).rejects.toMatchObject({ code: "FORBIDDEN", message: HR_NO_DRIVE_MESSAGE });
    }
  });
  it("gerar no RH: a cópia de trabalho é apagada do Drive (mesmo se falhar) e o PDF vai só para a ficha", async () => {
    const calls: string[] = [];
    const drive = {
      async exportAs(id: string, mime: string) { calls.push(`export:${id}:${mime}`); return Buffer.from(mime === GOOGLE_MIME.pdf ? "%PDF" : "docx"); },
      async upload(meta: { name: string; parents?: string[] }) { calls.push(`upload:${meta.parents ? "com-pasta" : "privado"}`); return { id: "tmp1", name: meta.name } as any; },
      async remove(id: string) { calls.push(`remove:${id}`); },
    };
    const docs = { async batchUpdate() { return { replaced: 3 }; } };
    const stored: Array<Record<string, unknown>> = [];
    const store = { async put(key: string) { calls.push(`s3:${key.split("/")[0]}`); return `https://s3/${key}`; }, async createDoc(row: Record<string, unknown>) { stored.push(row); return 77; } };
    const r = await generateEmployeePdf({ id: 4, role: "admin" }, { apis: { drive, docs } as any }, { template: { fileId: "tpl", templateType: "contrato_trabalho" }, requests: [], name: "Contrato — Ana", employeeId: 9 }, store);
    expect(r).toEqual({ replaced: 3, employeeDocumentId: 77 });
    expect(calls).toEqual([`export:tpl:${GOOGLE_MIME.docx}`, "upload:privado", `export:tmp1:${GOOGLE_MIME.pdf}`, "remove:tmp1", "s3:employees"]);
    expect(stored[0]).toMatchObject({ employeeId: 9, docType: "contract", mimeType: GOOGLE_MIME.pdf, uploadedById: 4 });
    // Falha a meio → a cópia é apagada na mesma e nada vai para a ficha.
    const calls2: string[] = [];
    const failing = { ...drive, async exportAs(id: string, mime: string) { if (id === "tmp1") throw new Error("boom"); return Buffer.from(mime); }, async remove(id: string) { calls2.push(`remove:${id}`); } };
    const stored2: unknown[] = [];
    await expect(generateEmployeePdf({ id: 4, role: "admin" }, { apis: { drive: failing, docs } as any }, { template: { fileId: "tpl", templateType: "declaracao" }, requests: [], name: "X", employeeId: 9 },
      { async put() { return "x"; }, async createDoc(row) { stored2.push(row); return 1; } })).rejects.toBeTruthy();
    expect(calls2).toEqual(["remove:tmp1"]);
    expect(stored2).toEqual([]);
  });
});

describe("Relatórios ao vivo: só num Shared Drive restrito próprio", () => {
  const base = { sharedEnabled: true, ownerEmail: "drive@multipark.pt", sharedDriveName: "Multipark" };
  it("sem Shared Drive restrito → não se podem ligar (mensagem clara)", () => {
    const r = driveConfigSchema.safeParse({ ...base, liveReports: { enabled: true, reports: ["financeiro"], hour: 6 } });
    expect(r.success).toBe(false);
    expect(liveDriveProblem({ liveDriveName: "", sharedDriveName: "Multipark" })).toMatch(/Shared Drive restrito/);
    expect(parseDriveConfig(null).liveDriveName).toBe("");
  });
  it("o Shared Drive restrito tem de ser diferente do geral", () => {
    expect(driveConfigSchema.safeParse({ ...base, liveDriveName: " multipark ", liveReports: { enabled: true } }).success).toBe(false);
    expect(liveDriveProblem({ liveDriveName: "multipark", sharedDriveName: "Multipark" })).toMatch(/diferente/);
    const ok = driveConfigSchema.safeParse({ ...base, liveDriveName: "Multipark Direção", liveReports: { enabled: true } });
    expect(ok.success).toBe(true);
    expect(liveDriveProblem(ok.data!)).toBeNull();
  });
  it("a folha só conta se estiver no Shared Drive restrito (a antiga, no geral, é substituída)", () => {
    expect(liveSheetInDrive({ driveId: "restrito" }, "restrito")).toBe(true);
    expect(liveSheetInDrive({ driveId: "geral" }, "restrito")).toBe(false);
    expect(liveSheetInDrive({ driveId: null }, "restrito")).toBe(false);
  });
  it("sem Shared Drive restrito, o contexto 'live' recusa (nunca cai no Shared Drive geral)", async () => {
    const cfg = driveConfigSchema.parse({ ...base });
    await expect(sharedDriveContext(Date.now() + 5_000, { cfg, live: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/Shared Drive restrito/) });
  });
});
