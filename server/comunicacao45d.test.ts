/**
 * Lote 45d (Jorge, 7 out 2026): na Comunicação, Drive (abre o Google Drive
 * num separador), Central ("cada um vê as SUAS chamadas, nós vemos todas") e
 * Tarefas.
 */
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it, vi } from "vitest";
import { can, grantFor, ROLES } from "../shared/access";
import { centralCallTotals, formatCallDuration } from "../shared/centralSugar";

const src = (p: string) => readFileSync(p, "utf8");

describe("Menu da Comunicação", () => {
  it("ordem: Caixas de email → O meu email → Drive → WhatsApp → Central → Calendário → Tarefas", () => {
    const layout = src("client/src/components/DashboardLayout.tsx");
    const group = layout.slice(layout.indexOf('label: "Comunicação"'), layout.indexOf('label: "Sistema"'));
    const order = ["Caixas de email", "O meu email", "Drive", "WhatsApp", "Central", "Calendário", "Tarefas"].map((l) => group.indexOf(`label: "${l}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // As Tarefas continuam também nas Operações.
    expect(layout.match(/label: "Tarefas", path: "\/tarefas"/g)).toHaveLength(2);
  });
  it("Drive abre o Google Drive num separador novo (menu e página dos módulos)", () => {
    const layout = src("client/src/components/DashboardLayout.tsx");
    expect(layout).toContain('{ icon: HardDrive, label: "Drive", path: "/drive", anyOf: ["ficha"], external: GOOGLE_DRIVE_URL }');
    expect(layout).toContain('window.open(item.external, "_blank", "noopener,noreferrer");');
    expect(layout).toContain("onClick={() => openMenuItem(item, navigate)}");
    expect(src("client/src/pages/ModulesPage.tsx")).toContain("onClick={() => openMenuItem(m, navigate)}");
    expect(src("client/src/App.tsx")).toContain('<Route path="/drive">');
  });
});

describe("Central: quem vê o quê", () => {
  it("cada um as suas (team leader até back office); admin e super admin todas; condutores e extras nada", () => {
    for (const r of ["team_leader", "supervisor", "frontoffice", "backoffice"] as const) expect(grantFor(r as any, "central").access).toBe("own");
    for (const r of ["admin", "super_admin"] as const) expect(grantFor(r as any, "central").access).toBe("national");
    for (const r of ["user", "extra", "condutor"] as const) expect(can(r, "central", "view")).toBe(false);
    expect(ROLES.filter((r) => can(r, "central", "edit"))).toEqual([]);
  });
  it("o servidor filtra pela própria pessoa quando o alcance não é nacional; só lê", () => {
    const r = src("server/centralRouter.ts");
    const body = r.slice(r.indexOf("myCalls: protectedProcedure"), r.indexOf("/** Contas da dashboard para dar acesso"));
    expect(body).toContain('const seesAll = requireAccess(ctx.user, "central", "view", { allowOwn: true }) === "national";');
    expect(body).toContain("const who = seesAll ? (input.userId ?? null) : ctx.user.id;");
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

describe("Central: as minhas chamadas (servidor)", () => {
  const h = vi.hoisted(() => ({ queries: [] as string[] }));
  vi.mock("./cityAccess", async (original) => ({
    ...(await original<object>()),
    loadCityAccess: async () => ({ all: true, defaultCityId: null, cityName: null, cityIds: [], projectIds: [], missingCostCenter: false }),
  }));
  vi.mock("./db", async (original) => ({
    ...(await original<object>()),
    getDb: async () => ({
      execute: async (q: any) => {
        const s = new MySqlDialect().sqlToQuery(q).sql;
        h.queries.push(s);
        if (s.includes("FROM central_calls")) return [[{ id: 1, userId: 9, direction: "in", held: 0, startedAt: "2026-10-07 10:00:00", durationS: 120, phone: "+351913225918", contactRef: "tel-351913225918", userName: "Ana" }]];
        if (s.includes("FROM central_accounts a LEFT JOIN")) return [[{ userId: 9, name: "Ana" }]];
        if (s.includes("FROM central_accounts")) return [[{ x: 1 }]];
        return [[]];
      },
    }),
    getUserModuleOverrides: async () => ({}),
  }));

  it("supervisor: só as suas, sem lista de pessoas", { timeout: 30_000 }, async () => {
    const { appRouter } = await import("./routers");
    h.queries.length = 0;
    const r = await appRouter.createCaller({ user: { id: 9, role: "supervisor" }, req: { headers: {} }, res: {} } as any).central.myCalls({ days: 7 });
    expect(r.seesAll).toBe(false);
    expect(r.people).toEqual([]);
    expect(r.calls[0]).toMatchObject({ direction: "in", durationS: 120, startedAt: "2026-10-07T10:00:00Z", contact: { kind: "Sem ficha" } });
    expect(h.queries.find((q) => q.includes("FROM central_calls"))).toContain("AND c.userId = ?");
  });

  it("super admin: todas, com a lista de pessoas; condutor recusado", async () => {
    const { appRouter } = await import("./routers");
    h.queries.length = 0;
    const r = await appRouter.createCaller({ user: { id: 1, role: "super_admin" }, req: { headers: {} }, res: {} } as any).central.myCalls({ days: 30 });
    expect(r.seesAll).toBe(true);
    expect(r.people).toEqual([{ userId: 9, name: "Ana" }]);
    expect(h.queries.find((q) => q.includes("FROM central_calls"))).not.toContain("c.userId = ?");
    await expect(appRouter.createCaller({ user: { id: 5, role: "condutor" }, req: { headers: {} }, res: {} } as any).central.myCalls({ days: 7 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Central: totais e duração", () => {
  it("recebidas, feitas, internas e tempo", () => {
    expect(centralCallTotals([
      { direction: "in", durationS: 60 },
      { direction: "out", durationS: 125, contact: { kind: "Interna" } },
      { direction: "in", durationS: null },
    ])).toEqual({ in: 2, out: 1, internal: 1, durationS: 185 });
  });
  it("a consola só manda minutos", () => {
    expect(formatCallDuration(null)).toBe("—");
    expect(formatCallDuration(30)).toBe("menos de 1 min");
    expect(formatCallDuration(180)).toBe("3 min");
    expect(formatCallDuration(3900)).toBe("1 h 05 min");
  });
});
