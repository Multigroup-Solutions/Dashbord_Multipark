/**
 * 14 out 2026 (Jorge): nas caixas partilhadas "está um bocado confuso" — abriam
 * em "Abertas" (estado de trabalho), lido como "já lidas"; e o "Drive" do menu
 * "abre um drive qualquer" (com várias contas Google abria a pessoal).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIL_LIST_VIEW_LABELS, MAIL_THREAD_STATUS_FILTER_LABELS, MAIL_THREAD_STATUS_LABELS, mailActiveFilterCount, mailInitialView,
} from "../shared/mail";
import { driveAuthEmail, googleDriveUrl, isDriveIdLike, looksLikeEmail } from "../shared/drive";

const f = vi.hoisted(() => ({ account: vi.fn(), load: vi.fn(), state: null as string | null, cfg: null as unknown }));
vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: f.load }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({
    execute: async (q: any) => {
      let text = "";
      try { text = JSON.stringify(q?.queryChunks ?? q ?? ""); } catch { text = ""; }
      if (text.includes("google_drive_state")) return [f.state ? [{ value: f.state }] : [], []];
      return [[], []];
    },
  }),
  getUserModuleOverrides: async () => ({}),
}));
vi.mock("./google/userAccounts", async (original) => ({ ...(await original<object>()), getGoogleAccount: f.account }));
vi.mock("./appSettings", async (original) => {
  const o = await original<any>();
  return { ...o, getSetting: async (k: string) => (k === "google.drive" ? f.cfg : o.getSetting(k)) };
});

import { appRouter } from "./routers";

const src = (p: string) => readFileSync(p, "utf8");
const caller = (id = 7) => appRouter.createCaller({ user: { id, role: "supervisor", name: "X", email: "x@multipark.pt" }, req: { headers: {} }, res: {} } as any);

describe("Caixas partilhadas: abrem nas não lidas", () => {
  it("vista inicial: partilhadas → Não lidas; O meu email e ?q= → Todas", () => {
    expect(mailInitialView({ personal: false })).toBe("unread");
    expect(mailInitialView({ personal: false, search: null })).toBe("unread");
    expect(mailInitialView({ personal: false, search: "  " })).toBe("unread");
    expect(mailInitialView({ personal: false, search: "AA-11-BB" })).toBe("all");
    expect(mailInitialView({ personal: true })).toBe("all");
    expect(MAIL_LIST_VIEW_LABELS).toEqual({ unread: "Não lidas", awaiting: "Por responder", all: "Todas" });
  });
  it("'Aberta' passa a 'Por tratar' (só o texto; o valor continua 'aberto')", () => {
    expect(MAIL_THREAD_STATUS_LABELS.aberto).toBe("Por tratar");
    expect(MAIL_THREAD_STATUS_FILTER_LABELS).toEqual({ aberto: "Por tratar", pendente: "Pendentes", resolvido: "Resolvidas" });
    expect(Object.values(MAIL_THREAD_STATUS_LABELS).join(" ")).not.toMatch(/Abert/);
  });
  it("número no botão Filtros: só os filtros secundários (responsável não conta no O meu email)", () => {
    const base = { status: "all", assigned: "all", brand: "all", showAutomatic: false, archived: false, personal: false };
    expect(mailActiveFilterCount(base)).toBe(0);
    expect(mailActiveFilterCount({ ...base, status: "pendente", brand: "airpark", showAutomatic: true })).toBe(3);
    expect(mailActiveFilterCount({ ...base, assigned: "me" })).toBe(1);
    expect(mailActiveFilterCount({ ...base, assigned: "me", personal: true })).toBe(0);
    expect(mailActiveFilterCount({ ...base, archived: true })).toBe(1);
  });
  it("a página: vista principal + Filtros; O meu email continua em Todas; Arquivo mostra tudo", () => {
    const page = src("client/src/pages/ComunicacaoPage.tsx");
    expect(page).toContain('useState<MailListView>(() => mailInitialView({ personal, search: params.get("q") }))');
    expect(page).toContain('useState<MailThreadStatus | "all">("all")');
    expect(page).not.toContain('"aberto")');
    expect(page).toContain('if (key === ME) { setView("all"); setStatus("all"); navigate("/comunicacao/meu-email"); }');
    expect(page).toContain('else { if (isMe) setView("unread"); navigate(`/comunicacao?caixa=${encodeURIComponent(key)}`); }');
    expect(page).toContain('const toggleArchived = () => { setArchived((x) => !x); if (!archived) { setStatus("all"); setView("all"); } };');
    expect(page).toContain('role="radiogroup" aria-label="Mostrar"');
    expect(page).toContain("{filtersButton}");
    expect(page).toContain("archived: archived && !!overview.data?.isSuperAdmin");
    expect(page).toContain("awaiting, unread,");
  });
});

describe("Drive: a conta certa e o Shared Drive da empresa", () => {
  it("URL: Shared Drive pelo id, authuser com o email; sem id → Drives partilhados", () => {
    expect(googleDriveUrl("shared", { email: "ana@multipark.pt", sharedDriveId: "0AbCdEfGhIjK_-12" }))
      .toBe("https://drive.google.com/drive/folders/0AbCdEfGhIjK_-12?authuser=ana%40multipark.pt");
    expect(googleDriveUrl("shared", { email: "ana@multipark.pt" })).toBe("https://drive.google.com/drive/shared-drives?authuser=ana%40multipark.pt");
    expect(googleDriveUrl("shared")).toBe("https://drive.google.com/drive/shared-drives");
    expect(googleDriveUrl("my", { email: "ana@multipark.pt" })).toBe("https://drive.google.com/drive/my-drive?authuser=ana%40multipark.pt");
    expect(googleDriveUrl("sharedWithMe")).toBe("https://drive.google.com/drive/shared-with-me");
    expect(googleDriveUrl("recent", { email: "não é email" })).toBe("https://drive.google.com/drive/recent");
    // Nada estranho entra no URL.
    expect(googleDriveUrl("shared", { sharedDriveId: "../x?y=1" })).toBe("https://drive.google.com/drive/shared-drives");
    expect(isDriveIdLike("0AbCdEf")).toBe(true);
    expect(isDriveIdLike("a/b")).toBe(false);
    expect(looksLikeEmail("pda12")).toBe(false);
    expect(looksLikeEmail("a@b.pt")).toBe(true);
    expect(looksLikeEmail("a@b.pt&authuser=x")).toBe(false);
  });
  it("conta: a Google ligada no Perfil; senão o email do login; senão nenhuma", () => {
    expect(driveAuthEmail("ana@multipark.pt", "ana.pessoal@gmail.com")).toBe("ana@multipark.pt");
    expect(driveAuthEmail(null, " ana.pessoal@gmail.com ")).toBe("ana.pessoal@gmail.com");
    expect(driveAuthEmail(null, "PDA 3")).toBeNull();
  });

  beforeEach(() => {
    f.account.mockReset(); f.state = null; f.cfg = null;
    f.load.mockResolvedValue({ all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false });
  });
  it("googleDrive.sharedDriveLink: id guardado + email Google; nunca falha", async () => {
    f.cfg = { sharedEnabled: true, ownerEmail: "dono@multipark.pt", sharedDriveName: "Multipark" };
    f.state = "0AbCdEfGhIjK";
    f.account.mockResolvedValue({ email: "ana@multipark.pt", status: "connected" });
    expect(await caller(7).googleDrive.sharedDriveLink()).toEqual({ userId: 7, sharedDriveId: "0AbCdEfGhIjK", googleEmail: "ana@multipark.pt" });
    // Shared Drive desligado → sem id; conta desligada → sem email.
    f.cfg = { sharedEnabled: false };
    f.account.mockResolvedValue({ email: "ana@multipark.pt", status: "disconnected" });
    expect(await caller(8).googleDrive.sharedDriveLink()).toEqual({ userId: 8, sharedDriveId: null, googleEmail: null });
    f.account.mockRejectedValue(new Error("BD em baixo"));
    expect(await caller(9).googleDrive.sharedDriveLink()).toEqual({ userId: 9, sharedDriveId: null, googleEmail: null });
  });
  it("menu e página: o clique usa o URL em cache (window.open não espera) e só a resposta do próprio conta", () => {
    const layout = src("client/src/components/DashboardLayout.tsx");
    expect(layout).toContain('if (item.external === GOOGLE_DRIVE_URL) item = { ...item, external: driveUrl("shared") };');
    expect(layout).toContain("useDriveLinkContext(user);");
    const lib = src("client/src/lib/driveLink.ts");
    expect(lib).toContain("q.data.userId === user.id");
    expect(lib).toContain('export function driveUrl(view: GoogleDriveView = "shared"): string {\n  return googleDriveUrl(view, cached);\n}');
    const page = src("client/src/pages/DrivePage.tsx");
    expect(page).toContain("googleDriveUrl(l.view, link)");
    expect(page).toContain('{ label: "Drive da empresa", view: "shared" }');
  });
});
