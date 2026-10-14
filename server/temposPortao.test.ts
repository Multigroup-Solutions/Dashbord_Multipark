/**
 * Portão dos tempos com GPS (§8.1) — aplicado NO SERVIDOR em todos os ecrãs
 * que leem a tabela dos tempos (ou os calculam ao vivo): com ele fechado,
 * quem não é super admin não recebe Trânsito, Cliente, Nosso, % na meta, No
 * terminal nem T2; aberto, "sem dados suficientes" abaixo de 60 % ou de 20
 * medições; o super admin vê sempre, marcado como provisório.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_GPS_GATE, gpsTimesVisible } from "../shared/serviceTimes";
import { SETTINGS, settingSuperAdminOnly } from "../shared/appSettings";
import { TIME_METRICS, metricView, type ServiceRow } from "./serviceTimesAgg";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("§8.1 — a regra", () => {
  const open = { visible: true, minCoveragePct: 60, minN: 20 };
  it("fechado por omissão; só o super admin o muda", () => {
    expect(DEFAULT_GPS_GATE).toEqual({ visible: false, minCoveragePct: 60, minN: 20 });
    expect(SETTINGS["serviceTimes.gpsGate"].defaultValue).toEqual(DEFAULT_GPS_GATE);
    expect(SETTINGS["serviceTimes.gpsGate"].wiring).toBe("live");
    expect(settingSuperAdminOnly("serviceTimes.gpsGate")).toBe(true);
  });
  it("fechado → Em calibração; aberto: 59 % → sem dados suficientes; 60 % com n = 19 → sem dados suficientes; 60 % e n ≥ 20 → mostra", () => {
    expect(gpsTimesVisible({ coveragePct: 95, n: 500, gate: DEFAULT_GPS_GATE, isSuperAdmin: false })).toEqual({ visible: false, label: "Em calibração" });
    expect(gpsTimesVisible({ coveragePct: 59, n: 200, gate: open, isSuperAdmin: false })).toEqual({ visible: false, label: "Sem dados suficientes (cobertura 59 %, n = 200)" });
    expect(gpsTimesVisible({ coveragePct: 60, n: 19, gate: open, isSuperAdmin: false }).visible).toBe(false);
    expect(gpsTimesVisible({ coveragePct: 60, n: 20, gate: open, isSuperAdmin: false })).toEqual({ visible: true, label: null });
    expect(gpsTimesVisible({ coveragePct: 0, n: 0, gate: DEFAULT_GPS_GATE, isSuperAdmin: true })).toEqual({ visible: true, label: "em calibração" });
  });
  it("os tempos atrás do portão são os do §8.1; os outros veem-se sempre", () => {
    const gps = Object.entries(TIME_METRICS).filter(([, d]) => d.gps).map(([k]) => k).sort();
    expect(gps).toEqual(["ate_garagem", "cliente", "nosso", "terminal", "transito"]);
    const always = Object.entries(TIME_METRICS).filter(([, d]) => !d.gps).map(([k]) => k).sort();
    expect(always).toEqual(["ate_arrumado", "cliente_recolha", "fila", "p2", "total"]);
  });
  it("sem linhas nenhumas, com o portão fechado, quem não é super admin vê \"Em calibração\" (nunca \"sem casos\")", () => {
    const rows: ServiceRow[] = [];
    expect(metricView(rows, "transito", { gate: DEFAULT_GPS_GATE, isSuperAdmin: false })).toMatchObject({ stats: null, hidden: "Em calibração" });
    expect(metricView(rows, "transito", { gate: DEFAULT_GPS_GATE, isSuperAdmin: true })).toMatchObject({ hidden: null, note: "em calibração" });
  });
});

describe("§8.1 — no servidor, em todos os ecrãs", () => {
  it("cada leitura da tabela dos tempos aplica o portão com o papel de quem pede", () => {
    const db = src("server/db.ts");
    const dash = db.slice(db.indexOf("export async function getSupervisorDayDashboard"), db.indexOf("// ─── LIGAÇÃO AGENTE→PARCEIRO"));
    expect(dash).toContain("loadServiceViewSettings()");
    expect(dash).toContain("isSuperAdmin: !!opts.isSuperAdmin");
    expect(src("server/shiftDayDetail.ts")).toContain("gate: { gate: st.gate, isSuperAdmin: !!opts.isSuperAdmin }");
    const views = src("server/serviceTimesViews.ts");
    expect(views).toContain("gate: { gate: o.gate, isSuperAdmin: o.isSuperAdmin }");
    expect(views).toContain("gate: { gate: st.gate, isSuperAdmin: o.isSuperAdmin }");
    expect(src("server/driverTimes.ts")).toContain("const gpsGate = { gate: o.gate, isSuperAdmin: o.isSuperAdmin };");
    expect(src("server/serviceTimesBooking.ts")).toContain("bookingTimesView(rows, { gate: st.gate, isSuperAdmin: o.isSuperAdmin, open })");
  });
  it("os procedimentos passam o papel do utilizador (nunca do browser)", () => {
    const r = src("server/routers.ts");
    expect(r.match(/isSuperAdmin: ctx\.user\.role === "super_admin"/g)!.length).toBeGreaterThanOrEqual(5);
    expect(src("server/bookingFileRouter.ts")).toContain('isSuperAdmin: ctx.user.role === "super_admin"');
    // nenhum procedimento aceita o papel ou o portão vindos do pedido
    for (const f of ["server/routers.ts", "server/bookingFileRouter.ts", "server/sondaTemposRouter.ts"]) expect(src(f)).not.toMatch(/input\.(isSuperAdmin|gate|gpsGate)/);
  });
  it("o MCP, o assistente e o briefing ainda não leem os tempos (fica para depois, com o portão)", () => {
    for (const f of ["server/mcpReportsApi.ts", "server/assistant/tools.ts", "server/aiOps/briefing.ts"]) {
      expect(src(f), f).not.toMatch(/serviceTimesRead|serviceTimesAgg|service_times|driverTimes/);
    }
  });
  it("o ecrã nunca esconde por si: só mostra o texto do portão que vem do servidor", () => {
    for (const f of ["client/src/components/shiftDay/DayTimesSection.tsx", "client/src/components/people/DriverTimesCard.tsx", "client/src/pages/extrasDia/PressureTab.tsx", "client/src/components/operacoes/WeekActivityTab.tsx"]) {
      expect(src(f), f).not.toMatch(/gpsGate|minCoveragePct|role === "super_admin"/);
    }
  });
});
