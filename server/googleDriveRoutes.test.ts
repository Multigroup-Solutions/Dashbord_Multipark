import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ load: vi.fn(), account: vi.fn(), queries: [] as string[] }));
vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: f.load }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({
    execute: async (q: any) => {
      let text = "";
      try { text = JSON.stringify(q?.queryChunks ?? q ?? "").slice(0, 600); } catch { text = ""; }
      f.queries.push(text);
      return [[], []];
    },
  }),
  getUserModuleOverrides: async () => ({}),
}));
vi.mock("./google/userAccounts", async (original) => ({ ...(await original<object>()), getGoogleAccount: f.account }));

import { appRouter } from "./routers";

const caller = (role = "supervisor", id = 123) => appRouter.createCaller({ user: { id, role, name: "X", email: "x@multipark.pt" }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  vi.clearAllMocks();
  f.queries = [];
  f.account.mockResolvedValue(null);
  f.load.mockResolvedValue({ all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false });
});

describe("Google Drive — rotas e permissões", () => {
  it("ficheiros de uma reclamação de outra cidade → FORBIDDEN (a cidade do pedido é aplicada)", async () => {
    await expect(caller("team_leader").googleDrive.links.list({ entityType: "complaint", entityId: "7" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.queries.some((q) => q.includes("complaints") && q.includes("projectId"))).toBe(true);
  });

  it("extra (reclamações só 'próprias') não liga nem gera documentos", async () => {
    await expect(caller("extra").googleDrive.links.attach({ entityType: "complaint", entityId: "7", link: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", source: "link" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("extra").googleDrive.generate({ templateId: 1, entityType: "complaint", entityId: "7", destination: "user" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("exportar para Sheets exige a ação 'exportar' do módulo; com permissão, pede o Drive primeiro", async () => {
    await expect(caller("backoffice").googleDrive.sheets.export({ report: "clientes" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("supervisor").googleDrive.sheets.export({ report: "avaliacoes", from: "2026-09-01", to: "2026-09-25" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("admin").googleDrive.sheets.export({ report: "faturacao", from: "2026-09-01", to: "2026-09-25" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("admin").googleDrive.sheets.export({ report: "clientes" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(f.queries.some((q) => q.includes("multipark_bookings"))).toBe(false); // o relatório nem chegou a ser calculado
  });

  it("importar de uma folha exige gerir o módulo de destino", async () => {
    await expect(caller("supervisor").googleDrive.sheets.readCsv({ link: "1AbCdEfGhIjKlMnOp", purpose: "extras" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Anual: só o super admin gere
    await expect(caller("admin").googleDrive.sheets.readCsv({ link: "1AbCdEfGhIjKlMnOp", purpose: "financial_history" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("admin").googleDrive.sheets.readCsv({ link: "1AbCdEfGhIjKlMnOp", purpose: "extras" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("definições e modelos: admin gere modelos, só o super admin grava o Shared Drive", async () => {
    await expect(caller("backoffice").googleDrive.settings.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("supervisor").googleDrive.templates.all()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("supervisor").googleDrive.templates.save({ name: "Contrato", templateType: "contrato_trabalho", link: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const cfg = {
      sharedEnabled: false, ownerEmail: "", sharedDriveName: "Multipark", rhDriveName: "", mirrorRhDocuments: false, mirrorComplaintEvidence: false,
      liveReports: { enabled: false, reports: ["financeiro"], hour: 6 }, liveRunAsUserId: null,
    } as any;
    await expect(caller("admin").googleDrive.settings.save(cfg)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("supervisor").googleDrive.settings.runNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("token do Picker: sem Drive autorizado → null (fica o colar o link)", async () => {
    expect(await caller("supervisor").googleDrive.pickerToken()).toBeNull();
  });

  it("guardar no Drive uma prova que não existe / não se pode ver → recusado", async () => {
    await expect(caller("extra").googleDrive.save({ source: { kind: "complaint_photo", id: 1 } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("relatórios ao vivo: só o super admin vê a configuração e o link; os admins não", async () => {
    const a = await caller("admin").googleDrive.settings.get();
    expect(a.canSeeLive).toBe(false);
    expect(a.liveSpreadsheetUrl).toBeNull();
    expect(a.liveLastRunAt).toBeNull();
    expect(a.config.liveReports.enabled).toBe(false);
    expect(a.config.liveDriveName).toBe("");
    const s = await caller("super_admin").googleDrive.settings.get();
    expect(s.canSeeLive).toBe(true);
    await expect(caller("supervisor").googleDrive.settings.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("documentos do RH nunca vão para o Drive: 'Guardar no Drive' e 'Gerar documento' para o Drive recusados, mesmo ao super admin", async () => {
    await expect(caller("super_admin").googleDrive.save({ source: { kind: "employee_document", id: 1 } as any })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    for (const destination of ["shared", "user"] as const) {
      await expect(caller("super_admin").googleDrive.generate({ templateId: 1, entityType: "employee", entityId: "1", destination })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});
