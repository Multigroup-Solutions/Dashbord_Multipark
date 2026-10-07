/**
 * Lote 43b/43c — Atividade diária (Jorge, 7 out 2026): o Rádio passa para
 * dentro da Atividade diária; os alertas "sem PDA ou Zello" pequenos e de
 * lado; as tarefas da disponibilidade já não vão para a Kamila por omissão.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { operationalAccess } from "../shared/operationalTabs";
import { availabilityTaskAssigneeEmail, DEFAULT_AVAILABILITY_TASK_ASSIGNEE_EMAIL } from "../shared/taskRules";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("43b — Rádio dentro da Atividade diária", () => {
  it("separador para quem vê o Rádio; quem só tem o Rádio também entra; o condutor não perde o próprio histórico", () => {
    expect(operationalAccess({ role: "supervisor" } as any).tabs).toContain("radio");
    expect(operationalAccess({ role: "condutor" } as any).ownSpeedOnly).toBe(true);
    // a regra: o Rádio entra depois de decidir o "só o próprio histórico"
    expect(src("shared/operationalTabs.ts")).toMatch(/const ownSpeedOnly = [^\n]+\n\s*if \(can\(user, "radio", "view"\)\) tabs\.push\("radio"\);/);
  });

  it("o endereço antigo vai lá ter; o menu tem uma entrada só (Actividade Diária também para quem só tem o Rádio)", () => {
    const app = src("client/src/App.tsx");
    expect(app).toMatch(/<Route path="\/radio">\s*\{\(\) => <Redirect to="\/operacional\?tab=radio" replace \/>\}/);
    expect(app).not.toContain("<RadioPage />");
    const menu = src("client/src/components/DashboardLayout.tsx");
    expect(menu).toContain('anyOf: ["atividade_diaria", "historico_diario", "radio"]');
    expect(menu).not.toContain('label: "Rádio", path: "/radio"');
    expect(src("shared/globalSearch.ts")).toContain('path: "/operacional?tab=radio"');
    const page = src("client/src/pages/OperationalPage.tsx");
    expect(page).toContain('{has("radio") && <TabsContent value="radio">{tab === "radio" && <RadioPage />}</TabsContent>}');
  });
});

describe("43b — alertas sem PDA ou Zello de lado", () => {
  it("pequenos, encolhem, a nota só abre se for preciso; na aba PDAs ficam ao lado", () => {
    const panel = src("client/src/components/OpsPresencePanel.tsx");
    expect(panel).toContain('usePersistedState("pdas.presence.collapsed", false)');
    expect(panel).toContain("+ nota");
    expect(panel).toContain("{!isLoading && !failed && open.length === 0"); // erro ≠ vazio continua
    const page = src("client/src/pages/OperationalPage.tsx");
    expect(page).toContain('<aside className="order-first min-w-0 lg:order-last lg:sticky lg:top-4"><OpsPresencePanel /></aside>');
  });
});

describe("43c — disponibilidade sem a Kamila por omissão", () => {
  it("ninguém escrito no código; Definições ou env mandam; sem nenhum fica sem responsável", () => {
    expect(DEFAULT_AVAILABILITY_TASK_ASSIGNEE_EMAIL).toBe("");
    expect(availabilityTaskAssigneeEmail({})).toBe("");
    expect(availabilityTaskAssigneeEmail({ AVAILABILITY_TASK_ASSIGNEE_EMAIL: "rh@multipark.pt" })).toBe("rh@multipark.pt");
    const t = src("server/tasksService.ts");
    expect(t).toContain("const owner = ownerEmail ? await findEmployeeByEmailOrName(ownerEmail) : null;");
    for (const f of ["shared/taskRules.ts", "server/tasksService.ts", "shared/appSettings.ts"]) expect(src(f)).not.toMatch(/kamilafagundes@/i);
  });
});

// ─── 43b: PDAs com dono e o Zello a bater certo ──────────────────────────────
import { zelloKey } from "../shared/zelloKey";
import { holdersForDay, splitByHolder, type GpsPoint } from "./zelloGps";
import { checkPdaZello } from "../shared/pdaZelloMatch";
import { evaluatePresence, CLOCK_GRACE_MINUTES } from "../shared/opsPresence";

describe("43b — o Zello é a mesma chave em todo o lado", () => {
  it("sem espaços e em minúsculas; não junta contas diferentes", () => {
    expect(zelloKey("  Extra12 ")).toBe("extra12");
    expect(zelloKey(null)).toBe("");
    expect(zelloKey("extra_12")).not.toBe(zelloKey("extra12"));
  });
  it("quem teve o PDA no dia: Extra12 e extra12 são o mesmo", () => {
    const m = holdersForDay([{ zello: "Extra12", employeeId: 7, start: 0, end: 10 }, { zello: "extra12", employeeId: 7, start: 10, end: 20 }], 0, 100, 100);
    expect([...m.entries()]).toEqual([["extra12", 7]]);
  });
});

describe("43b — o dono do PDA fica com o GPS fora dos check-ins", () => {
  const pt = (ts: number, lat: number): GpsPoint => ({ ts, speed: 30, lat, lon: -9.1, accurate: true });
  const pts = [pt(0, 38.70), pt(60, 38.701), pt(120, 38.702), pt(180, 38.703), pt(240, 38.704)];
  it("com check-in só no meio: o resto vai para o dono (antes ficava 'sem login')", () => {
    const shares = splitByHolder(pts, [{ employeeId: 5, start: 60_000, end: 180_000 }], 120, 9);
    expect(shares.map((s) => s.employeeId).sort()).toEqual([5, 9]);
    expect(shares.find((s) => s.employeeId === 9)!.points).toBe(3);
    expect(shares.find((s) => s.employeeId === 5)!.points).toBe(2);
  });
  it("sem dono: como antes, o resto não é de ninguém", () => {
    const shares = splitByHolder(pts, [{ employeeId: 5, start: 60_000, end: 180_000 }], 120);
    expect(shares.map((s) => s.employeeId)).toEqual([5]);
  });

  it("o resto vai para o dono na Atividade do Dia e no Histórico; a recolha e a re-divisão passam o dono", () => {
    const act = src("server/dayActivity.ts");
    expect(act).toContain("const owner = owners.get(zelloKey(zello));");
    const col = src("server/jobs/dailyDriverCollection.ts");
    expect(col).toContain("splitByHolder(gpsPointsFromGeoJson(data), zi, threshold, owners.get(zelloKey(zello)) ?? null)");
    expect(col).toContain("splitByHolder(gpsPointsFromGeoJson(historyData), zIntervals, threshold, owners.get(zelloKey(user.name)) ?? null)");
    expect(col).toContain("intervals.get(zelloKey(user.name))");
    const db = src("server/db.ts");
    expect(db).toContain(`const CHECKIN_ZELLO = sql.raw("COALESCE(NULLIF(c.zelloUsername, ''), NULLIF(p.zelloUsername, ''))");`);
    expect(db).toContain("export async function fixedZelloOwners()");
    expect(db).toContain("leftoverOwnerName");
    expect(db).not.toContain("attachZelloToEmployeeIfUnset"); // morto
  });

  it("no Ao Vivo o dono escolhe-se também nos Zellos de PDA; só pessoas das tuas cidades", () => {
    const z = src("client/src/components/ZelloLiveTab.tsx");
    expect(z).toContain('placeholder="— dono do PDA (fixo) —"');
    expect(z).not.toContain("trpc.operational.pdas.list.useQuery"); // os PDAs vêm de todos, pelo servidor
    const r = src("server/operationalRouter.ts");
    expect(r).toMatch(/mapUserToEmployee: protectedProcedure[\s\S]{0,600}await assertEmployeeAccess\(input\.employeeId\)/);
    expect(r).toContain("pda: pdaBy.get(zelloKey(u.name)) ?? null, owner: ownerBy.get(zelloKey(u.name)) ?? null");
  });
});

describe("43b — o Zello do PDA bate certo?", () => {
  const users = [{ name: "Extra_12" }, { name: "pda5" }, { name: "Rui" }];
  it("certo, maiúsculas, escrito de outra maneira, não existe, sem Zello e repetido", () => {
    const c = checkPdaZello([
      { id: 1, name: "PDA 5", zelloUsername: "pda5" },
      { id: 2, name: "PDA 6", zelloUsername: "PDA5x" },
      { id: 3, name: "Extra 12", zelloUsername: "extra12" },
      { id: 4, name: "PDA 7", zelloUsername: "rui" },
      { id: 5, name: "Extra 12", zelloUsername: null },
      { id: 6, name: "PDA 8", zelloUsername: "dup" },
      { id: 7, name: "PDA 9", zelloUsername: "DUP" },
    ], users);
    const by = new Map(c.map((x) => [x.pdaId, x]));
    expect(by.get(1)!.status).toBe("ok");
    expect(by.get(2)!.status).toBe("nao_existe");
    expect(by.get(3)).toMatchObject({ status: "parecido", suggestion: "Extra_12" });
    expect(by.get(4)).toMatchObject({ status: "maiusculas", suggestion: "Rui" });
    expect(by.get(5)).toMatchObject({ status: "sem_zello", suggestion: "Extra_12" });
    expect(by.get(6)!.status).toBe("duplicado");
    expect(by.get(7)!.status).toBe("duplicado");
  });
  it("na aba PDAs: o Zello no cartão, o aviso e Corrigir (quem edita PDAs)", () => {
    const p = src("client/src/pages/OperationalPage.tsx");
    expect(p).toContain("trpc.operational.pdas.zelloCheck.useQuery");
    expect(p).toContain("Corrigir para {zc!.suggestion}");
    expect(src("server/operationalRouter.ts")).toMatch(/zelloCheck: protectedProcedure\.query\(async \(\{ ctx \}\) => \{\s*requireAccess\(ctx\.user, "pdas", "view"\)/);
  });
  it("o histórico do PDA mostra 'Em uso' (lia c.status em vez de checkinStatus)", () => {
    expect(src("client/src/pages/OperationalPage.tsx")).toContain('(c.checkinStatus ?? c.status) === "checked_in" ? "Em uso" : "Devolvido"');
  });
});

describe("43b — alerta 'sem PDA' com o Zello fixo", () => {
  const NOW = Date.UTC(2026, 9, 7, 10);
  const base = { employeeId: 1, name: "Rui", position: "driver", city: "lisbon" as const, clockOpenSince: NOW - (CLOCK_GRACE_MINUTES + 5) * 60_000 };
  it("sem PDA mas com o Zello fixo a reportar → nada; desligado → 'o Zello não reporta'; sem nenhum → sem PDA", () => {
    const loc = (d: number) => new Map([["rui", { username: "rui", status: "available", lastReportDelay: d }]]);
    expect(evaluatePresence({ now: NOW, people: [{ ...base, pdaName: null, zelloUsername: "rui" }], movements: [], locations: loc(10) as any })).toEqual([]);
    const off = evaluatePresence({ now: NOW, people: [{ ...base, pdaName: null, zelloUsername: "rui" }], movements: [], locations: loc(9999) as any });
    expect(off.map((p) => p.kind)).toEqual(["clock_zello_off"]);
    expect(off[0].detail).toMatch(/^O Zello \(rui\) não reporta/);
    expect(evaluatePresence({ now: NOW, people: [{ ...base, pdaName: null, zelloUsername: null }], movements: [], locations: loc(10) as any }).map((p) => p.kind)).toEqual(["clock_no_pda"]);
  });
  it("o aparelho do dono que está agora com outra pessoa não conta; o dono de um PDA sem check-in tem esse PDA", () => {
    const s = src("server/opsPresence.ts");
    expect(s).toContain("if (holder != null && holder !== id) zello = null;");
    expect(s).toContain("else pdaName = pdaNameByZello.get(zelloKey(fixed)) ?? null;");
  });
});
