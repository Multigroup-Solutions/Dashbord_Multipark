import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { can, type AccessOverrides } from "../shared/access";
import {
  EMPTY_ROUTING, NOTIFICATION_KIND_DEFS, NOTIFY_CITIES, canReceiveKind, effectiveRoles, entityKeyOf, kindDef, kindFilterValues,
  notificationRoutingSchema, parseNotificationPrefs, parseRouting, resolveRecipients, routingTable,
  type NotificationKindDef, type NotificationRouting, type RoutingCandidate,
} from "../shared/notificationRouting";
import { renderNotificacoesDoc } from "../shared/notificationRoutingDoc";
import { notifyWith, type NotifyDeps, type NotifyRow } from "./notify";

const root = resolve(__dirname, "..");

let nextId = 1;
function person(role: string, cities: RoutingCandidate["cities"], extra: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return { id: nextId++, role, isActive: true, email: `p${nextId}@multipark.pt`, cities, accessOverrides: {}, prefs: { muted: [], email: {} }, ...extra };
}

const who = (kind: string, city: "lisbon" | "porto" | "faro" | null, people: RoutingCandidate[], routing?: NotificationRouting, extra: { targetUserIds?: number[]; alsoUserIds?: number[] } = {}) =>
  resolveRecipients({ kind, city, ...extra }, people, routing).map((r) => r.userId).sort((a, b) => a - b);

// Uma equipa típica: Lisboa e Porto.
const superAdmin = person("super_admin", "all");
const admin = person("admin", "all");
const backofficeLx = person("backoffice", ["lisbon"]);
const frontofficeLx = person("frontoffice", ["lisbon"]);
const supLx = person("supervisor", ["lisbon"]);
const supPorto = person("supervisor", ["porto"]);
const tlLx = person("team_leader", ["lisbon"]);
const tlPorto = person("team_leader", ["porto"]);
const condutorLx = person("condutor", ["lisbon"]);
const extraLx = person("extra", ["lisbon"]);
const everyone = [superAdmin, admin, backofficeLx, frontofficeLx, supLx, supPorto, tlLx, tlPorto, condutorLx, extraLx];

describe("catálogo das notificações", () => {
  it("cada tipo tem um módulo e ação que existem na matriz, e canais válidos", () => {
    const seen = new Set<string>();
    for (const d0 of NOTIFICATION_KIND_DEFS) {
      const d = d0 as NotificationKindDef;
      expect(seen.has(d.kind)).toBe(false);
      seen.add(d.kind);
      expect(d.kind.length).toBeLessThanOrEqual(32); // app_notifications.kind VARCHAR(32)
      expect(d.channels).toContain("in_app");
      if (d.personal) expect(d.roles).toEqual([]);
      if (d.emailDefault) expect(d.channels).toContain("email");
      // Os papéis por omissão têm sempre acesso ao módulo.
      for (const r of d.roles) expect(can(r, d.module, d.action), `${d.kind}/${r}`).toBe(true);
    }
  });
  it("passagem de turno é obrigatória e pessoal", () => {
    expect(kindDef("handover")?.mandatory).toBe(true);
    expect(kindDef("handover")?.personal).toBe(true);
  });
});

describe("destinatários por papel e cidade", () => {
  it("reclamação nova de Lisboa: backoffice, frontoffice e supervisor de Lisboa + admin/super_admin; team leader não", () => {
    expect(who("complaint_new", "lisbon", everyone)).toEqual([superAdmin.id, admin.id, backofficeLx.id, frontofficeLx.id, supLx.id].sort((a, b) => a - b));
  });
  it("team leader só recebe a reclamação quando é o responsável", () => {
    expect(who("complaint_new", "lisbon", everyone, undefined, { alsoUserIds: [tlLx.id] })).toContain(tlLx.id);
    expect(who("complaint_new", "lisbon", everyone)).not.toContain(tlLx.id);
  });
  it("ocorrência crítica do Porto: supervisor e team leader do Porto (não os de Lisboa)", () => {
    const r = who("incident_critical", "porto", everyone);
    expect(r).toContain(supPorto.id);
    expect(r).toContain(tlPorto.id);
    expect(r).not.toContain(supLx.id);
    expect(r).not.toContain(tlLx.id);
    expect(r).not.toContain(condutorLx.id);
  });
  it("documentos em falta: backoffice + supervisor da cidade, nunca team leader nem condutor", () => {
    const r = who("rh_docs_missing", "lisbon", everyone);
    expect(r).toEqual(expect.arrayContaining([backofficeLx.id, supLx.id]));
    expect(r).not.toContain(tlLx.id);
    expect(r).not.toContain(condutorLx.id);
  });
  it("faltam condutores: team leader + supervisor da cidade", () => {
    const r = who("extras_gap", "porto", everyone);
    expect(r).toEqual(expect.arrayContaining([tlPorto.id, supPorto.id]));
    expect(r).not.toContain(tlLx.id);
    expect(r).not.toContain(backofficeLx.id);
  });
  it("sistema (integrações, crons, IA): só super_admin + admin", () => {
    for (const k of ["integration_alert", "cron_stale", "sync_alert", "ai_budget"]) {
      expect(who(k, null, everyone), k).toEqual([superAdmin.id, admin.id].sort((a, b) => a - b));
    }
  });
  it("aviso de cidade sem cidade conhecida → só quem vê todas as cidades", () => {
    const r = who("complaint_new", null, everyone);
    expect(r).toEqual(expect.arrayContaining([superAdmin.id, admin.id]));
    expect(r).not.toContain(supLx.id);
  });
  it("papéis nacionais: só da própria cidade POR OMISSÃO; o super_admin pode desligar; super_admin recebe tudo", () => {
    // Omissão (26 set 2026): ligado para frontoffice, backoffice e admin.
    expect(EMPTY_ROUTING.homeCityOnly).toEqual(["frontoffice", "backoffice", "admin"]);
    expect(parseRouting({}).homeCityOnly).toEqual(["frontoffice", "backoffice", "admin"]);
    const def = who("complaint_new", "porto", everyone);
    expect(def).not.toContain(backofficeLx.id);
    expect(def).not.toContain(frontofficeLx.id);
    expect(def).toContain(superAdmin.id);
    expect(who("complaint_new", "lisbon", everyone)).toContain(backofficeLx.id);
    // Desligado explicitamente pelo super_admin → todas as cidades.
    const off = parseRouting({ homeCityOnly: [] });
    expect(who("complaint_new", "porto", everyone, off)).toContain(backofficeLx.id);
    const partial = parseRouting({ homeCityOnly: ["backoffice"] });
    expect(who("complaint_new", "porto", everyone, partial)).not.toContain(backofficeLx.id);
    expect(who("complaint_new", "porto", everyone, partial)).toContain(frontofficeLx.id);
  });
  it("quem está inativo nunca recebe", () => {
    const off = person("supervisor", ["lisbon"], { isActive: false });
    expect(who("complaint_new", "lisbon", [...everyone, off])).not.toContain(off.id);
  });
});

describe("pessoa de cidade nunca recebe de outra cidade", () => {
  const cityPeople = everyone.filter((p) => p.cities !== "all" && !["backoffice", "frontoffice"].includes(p.role));
  for (const d0 of NOTIFICATION_KIND_DEFS.filter((d) => d.cityScoped && !d.personal)) {
    it(d0.kind, () => {
      for (const city of NOTIFY_CITIES) {
        const got = new Set(who(d0.kind, city, everyone));
        for (const p of cityPeople) if (got.has(p.id)) expect((p.cities as readonly string[]).includes(city), `${p.role}@${String(p.cities)} ← ${city}`).toBe(true);
      }
    });
  }
});

describe("super_admin", () => {
  it("recebe TODOS os tipos não pessoais, em todas as cidades", () => {
    for (const d of NOTIFICATION_KIND_DEFS.filter((x) => !x.personal)) {
      for (const city of [...NOTIFY_CITIES, null]) expect(who(d.kind, city, [superAdmin]), `${d.kind}@${city}`).toEqual([superAdmin.id]);
    }
  });
  it("pode silenciar qualquer tipo não obrigatório", () => {
    const muted = person("super_admin", "all", { prefs: parseNotificationPrefs({ muted: ["complaint_new", "integration_alert"] }) });
    expect(who("complaint_new", "lisbon", [muted])).toEqual([]);
    expect(who("integration_alert", null, [muted])).toEqual([]);
    expect(who("incident_critical", "lisbon", [muted])).toEqual([muted.id]);
  });
  it("as regras não conseguem tirar o super_admin de um tipo", () => {
    const r = parseRouting({ kinds: { complaint_new: { roles: ["supervisor"] } } });
    expect(effectiveRoles("complaint_new", r)).toContain("super_admin");
  });
});

describe("obrigatórias", () => {
  it("não se silenciam (nem guardando o silêncio)", () => {
    expect(parseNotificationPrefs({ muted: ["handover", "task"] }).muted).toEqual(["task"]);
    const tl = person("team_leader", ["lisbon"], { prefs: { muted: ["handover"], email: {} } });
    expect(who("handover", "lisbon", [tl], undefined, { targetUserIds: [tl.id] })).toEqual([tl.id]);
  });
  it("silenciamentos antigos passam para os tipos novos", () => {
    expect(parseNotificationPrefs({ muted: ["extras", "complaint"] }).muted).toEqual(
      expect.arrayContaining(["extras_gap", "extras_schedule_reply", "complaint_new", "complaint_sla", "complaint_triage"]),
    );
    expect(kindFilterValues("complaint_new")).toContain("complaint");
  });
});

describe("overrides por pessoa", () => {
  it("um override do módulo dá a notificação a quem o papel não dá", () => {
    const ov: AccessOverrides = { rh: { access: "city", actions: ["view"] } };
    const tlWithRh = person("team_leader", ["lisbon"], { accessOverrides: ov });
    // team leader por omissão NÃO recebe documentos em falta…
    expect(who("rh_docs_missing", "lisbon", [tlLx])).toEqual([]);
    // …mas com override do RH recebe (na sua cidade).
    expect(who("rh_docs_missing", "lisbon", [tlWithRh])).toEqual([tlWithRh.id]);
    expect(who("rh_docs_missing", "porto", [tlWithRh])).toEqual([]);
  });
  it("override nacional dá todas as cidades", () => {
    const ov: AccessOverrides = { reclamacoes: { access: "national", actions: ["view", "edit"] } };
    const tl = person("team_leader", ["lisbon"], { accessOverrides: ov });
    expect(who("complaint_new", "faro", [tl])).toEqual([tl.id]);
  });
  it("override que retira o módulo tira a notificação", () => {
    const ov: AccessOverrides = { reclamacoes: { access: "none", actions: [] } };
    const sup = person("supervisor", ["lisbon"], { accessOverrides: ov });
    expect(who("complaint_new", "lisbon", [sup])).toEqual([]);
  });
});

describe("admin", () => {
  it("não recebe marketing, faturação, anual nem logs (a matriz não lhos dá)", () => {
    expect(who("marketing_alert", null, [admin, superAdmin])).toEqual([superAdmin.id]);
    for (const d of NOTIFICATION_KIND_DEFS) {
      if (!can("admin", d.module, d.action)) {
        expect(effectiveRoles(d.kind)).not.toContain("admin");
        expect(canReceiveKind(admin, d.kind)).toBe(false);
      }
    }
  });
  it("nem se o super_admin o tentar pôr nas regras", () => {
    const r = notificationRoutingSchema.safeParse({ kinds: { marketing_alert: { roles: ["admin"] } } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toMatch(/Admin não tem acesso/);
  });
  it("recebe os tipos de cidade de todas as cidades", () => {
    expect(who("extras_gap", "faro", [admin])).toEqual([admin.id]);
  });
});

describe("pessoais", () => {
  it("vão só à pessoa indicada (nem super_admin nem chefias)", () => {
    expect(who("task", null, everyone, undefined, { targetUserIds: [condutorLx.id] })).toEqual([condutorLx.id]);
    expect(who("my_docs_missing", null, everyone, undefined, { targetUserIds: [extraLx.id] })).toEqual([extraLx.id]);
    expect(who("task", null, everyone)).toEqual([]);
  });
  it("quem não tem centro de custos só recebe as pessoais", () => {
    const lost = person("supervisor", [], { personalOnly: true });
    expect(who("complaint_new", "lisbon", [lost], undefined, { alsoUserIds: [lost.id] })).toEqual([]);
    expect(who("task", null, [lost], undefined, { targetUserIds: [lost.id] })).toEqual([lost.id]);
    expect(canReceiveKind(lost, "complaint_new")).toBe(false);
  });
  it("respeitam o silêncio da pessoa (quando não são obrigatórias)", () => {
    const p = person("condutor", ["lisbon"], { prefs: { muted: ["task"], email: {} } });
    expect(who("task", null, [p], undefined, { targetUserIds: [p.id] })).toEqual([]);
  });
});

describe("email", () => {
  it("só nos tipos com email, com a omissão do tipo e a escolha da pessoa", () => {
    const off = person("supervisor", ["lisbon"], { prefs: { muted: [], email: { incident_critical: false } } });
    const on = person("supervisor", ["lisbon"]);
    const r = resolveRecipients({ kind: "incident_critical", city: "lisbon" }, [off, on]);
    expect(r.find((x) => x.userId === on.id)?.email).toBe(true);
    expect(r.find((x) => x.userId === off.id)?.email).toBe(false);
    expect(resolveRecipients({ kind: "complaint_new", city: "lisbon" }, [on])[0].email).toBe(false);
  });
});

describe("validação das regras (app_settings notifications.routing)", () => {
  it("aceita papéis com acesso e normaliza (super_admin sempre)", () => {
    const r = notificationRoutingSchema.parse({ kinds: { complaint_new: { roles: ["supervisor", "team_leader"] } } });
    expect(r.kinds.complaint_new.roles).toEqual(["team_leader", "supervisor", "super_admin"]);
    expect(effectiveRoles("complaint_new", r)).toContain("team_leader");
  });
  it("recusa tipo desconhecido, papel desconhecido, papéis num tipo pessoal, email num tipo sem email e campos a mais", () => {
    expect(notificationRoutingSchema.safeParse({ kinds: { nope: { roles: [] } } }).success).toBe(false);
    expect(notificationRoutingSchema.safeParse({ kinds: { complaint_new: { roles: ["chefe"] } } }).success).toBe(false);
    expect(notificationRoutingSchema.safeParse({ kinds: { task: { roles: ["supervisor"] } } }).success).toBe(false);
    expect(notificationRoutingSchema.safeParse({ kinds: { complaint_new: { email: true } } }).success).toBe(false);
    expect(notificationRoutingSchema.safeParse({ kinds: {}, extra: 1 }).success).toBe(false);
    expect(notificationRoutingSchema.safeParse({ homeCityOnly: ["supervisor"] }).success).toBe(false);
  });
  it("recusa dar a um papel um tipo cujo módulo ele não abre", () => {
    expect(notificationRoutingSchema.safeParse({ kinds: { rh_docs_missing: { roles: ["condutor"] } } }).success).toBe(false);
  });
  it("valor guardado inválido → omissões do código", () => {
    expect(parseRouting({ kinds: { nope: {} } })).toEqual({ kinds: {}, homeCityOnly: ["frontoffice", "backoffice", "admin"] });
    expect(parseRouting(null)).toEqual({ kinds: {}, homeCityOnly: ["frontoffice", "backoffice", "admin"] });
  });
  it("a definição está registada e validada no registo de Definições", async () => {
    const { validateSetting } = await import("../shared/appSettings");
    expect(validateSetting("notifications.routing", { kinds: { complaint_new: { roles: ["supervisor"] } } }).ok).toBe(true);
    expect(validateSetting("notifications.routing", { kinds: { marketing_alert: { roles: ["admin"] } } }).ok).toBe(false);
  });
  it("tirar um papel das regras tira-lhe a notificação", () => {
    const r = parseRouting({ kinds: { complaint_new: { roles: ["backoffice"] } } });
    expect(who("complaint_new", "lisbon", everyone, r)).not.toContain(supLx.id);
    expect(who("complaint_new", "lisbon", everyone, r)).toContain(backofficeLx.id);
  });
});

describe("notify(): deduplicação e entrega", () => {
  function fakeDeps(people: RoutingCandidate[]) {
    const rows: (NotifyRow & { at: number })[] = [];
    const mails: string[] = [];
    let now = 1_000_000;
    const deps: NotifyDeps = {
      loadCandidates: async () => people,
      loadRouting: async () => parseRouting(null),
      cityOfProject: async (pid) => (pid === 10 ? "lisbon" : pid === 20 ? "porto" : null),
      projectOfEmployee: async (eid) => (eid === 7 ? 20 : null),
      recentRecipients: async (kind, key, ids, minutes) =>
        new Set(rows.filter((r) => r.kind === kind && r.entityKey === key && ids.includes(r.userId) && now - r.at <= minutes * 60_000).map((r) => r.userId)),
      insert: async (list) => { for (const r of list) rows.push({ ...r, at: now }); },
      emailOf: (id) => people.find((p) => p.id === id)?.email ?? null,
      sendEmail: async (to) => { mails.push(to); return true; },
    };
    return { deps, rows, mails, advance: (ms: number) => { now += ms; } };
  }

  it("uma notificação por pessoa × tipo × registo dentro da janela", async () => {
    const f = fakeDeps(everyone);
    const input = { kind: "complaint_new" as const, projectId: 10, title: "Nova reclamação: X", entity: { type: "complaint", id: 5 } };
    const a = await notifyWith(f.deps, input);
    expect(a.city).toBe("lisbon");
    expect(a.recipients.length).toBeGreaterThan(0);
    const b = await notifyWith(f.deps, input);
    expect(b.recipients).toEqual([]);
    expect(b.duplicates).toBe(a.recipients.length);
    f.advance(31 * 60_000);
    const c = await notifyWith(f.deps, input);
    expect(c.recipients.sort()).toEqual(a.recipients.sort());
    // outro registo → entra logo
    const d = await notifyWith(f.deps, { ...input, entity: { type: "complaint", id: 6 } });
    expect(d.recipients.length).toBe(a.recipients.length);
  });
  it("sem registo, a MESMA mensagem não se repete; outra mensagem entra", async () => {
    const f = fakeDeps([superAdmin]);
    expect((await notifyWith(f.deps, { kind: "sync_alert", title: "Sem webhooks", body: "x" })).recipients).toEqual([superAdmin.id]);
    expect((await notifyWith(f.deps, { kind: "sync_alert", title: "Sem webhooks", body: "x" })).recipients).toEqual([]);
    expect((await notifyWith(f.deps, { kind: "sync_alert", title: "Sem webhooks", body: "y" })).recipients).toEqual([superAdmin.id]);
    expect(entityKeyOf({ title: "a", body: "b" })).not.toBe(entityKeyOf({ title: "a", body: "c" }));
  });
  it("grava a cidade e o tipo; a cidade vem do projeto ou da ficha", async () => {
    const f = fakeDeps(everyone);
    await notifyWith(f.deps, { kind: "speed_alert", employeeId: 7, title: "Velocidade" });
    expect(new Set(f.rows.map((r) => r.cityKey))).toEqual(new Set(["porto"]));
    expect(f.rows.map((r) => r.userId)).toContain(tlPorto.id);
    expect(f.rows.map((r) => r.userId)).not.toContain(tlLx.id);
  });
  it("email só a quem o tem ligado", async () => {
    const f = fakeDeps(everyone);
    await notifyWith(f.deps, { kind: "incident_critical", projectId: 10, title: "Ocorrência Crítica", entity: { type: "incident", id: 1 } });
    expect(f.mails.length).toBeGreaterThan(0);
    const f2 = fakeDeps(everyone);
    await notifyWith(f2.deps, { kind: "complaint_new", projectId: 10, title: "R", entity: { type: "complaint", id: 1 } });
    expect(f2.mails).toEqual([]);
  });
  it("tipo desconhecido não envia nada e nunca lança", async () => {
    const f = fakeDeps(everyone);
    expect((await notifyWith(f.deps, { kind: "nope" as any, title: "x" })).recipients).toEqual([]);
    const broken = { ...f.deps, loadCandidates: async () => { throw new Error("bd"); } };
    await expect(notifyWith(broken, { kind: "complaint_new", title: "x" })).resolves.toMatchObject({ recipients: [] });
  });
});

describe("todas as notificações passam por notify()", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "node_modules" || name.startsWith(".")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(resolve(root, "server"));
  walk(resolve(root, "shared"));

  it("ninguém cria notificações fora de server/notify.ts", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(root, f);
      if (rel === join("server", "notify.ts")) continue;
      const src = readFileSync(f, "utf8");
      if (/\bcreateNotification\s*\(/.test(src)) offenders.push(`${rel}: createNotification(`);
      if (/insert\(\s*appNotifications\s*\)/.test(src)) offenders.push(`${rel}: insert(appNotifications)`);
      if (/INSERT\s+(IGNORE\s+)?INTO\s+`?app_notifications`?/i.test(src) && !rel.includes("migrations")) offenders.push(`${rel}: INSERT INTO app_notifications`);
      if (/\bnotifyBackoffice\s*\(|\bnotifyAdmins\s*\(/.test(src)) offenders.push(`${rel}: broadcast antigo`);
    }
    expect(offenders).toEqual([]);
  });
  it("o email ao dono (notifyOwner) já não é usado como aviso", () => {
    const users = files.map((f) => relative(root, f)).filter((rel) => /\bnotifyOwner\s*\(/.test(readFileSync(resolve(root, rel), "utf8")));
    expect(users.sort()).toEqual([join("server", "_core", "notification.ts"), join("server", "_core", "systemRouter.ts")].sort());
  });
});

describe("migração 0140", () => {
  it("registada no ensureRecentSchema (por ordem), idempotente e espelhada no schema drizzle", async () => {
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    const nums = [...db.matchAll(/import\("\.\/migrations\/migration_(\d{4})"\)\.then\(m => \(\{ s: m\.MIGRATION_/g)].map((x) => Number(x[1]));
    expect(nums).toContain(140);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    const { MIGRATION_0140_STATEMENTS, IDEMPOTENT_ERROR_CODES_0140, CLEANUP_0140_ID } = await import("./migrations/migration_0140");
    for (const st of MIGRATION_0140_STATEMENTS) expect(st).toMatch(/^(CREATE TABLE IF NOT EXISTS|ALTER TABLE `\w+` ADD (COLUMN|INDEX)|UPDATE `app_notifications` SET `isRead` = 1 |INSERT IGNORE INTO `app_notification_maintenance`)/);
    expect(MIGRATION_0140_STATEMENTS.join("\n")).not.toMatch(/\bDROP\b|\bDELETE\b/i);
    // A limpeza só corre enquanto a marca não existir, e a marca é gravada a seguir.
    const upd = MIGRATION_0140_STATEMENTS.findIndex((s) => s.startsWith("UPDATE"));
    const mark = MIGRATION_0140_STATEMENTS.findIndex((s) => s.startsWith("INSERT IGNORE"));
    expect(MIGRATION_0140_STATEMENTS[upd]).toContain(`NOT EXISTS (SELECT 1 FROM \`app_notification_maintenance\``);
    expect(MIGRATION_0140_STATEMENTS[upd]).toContain(CLEANUP_0140_ID);
    expect(MIGRATION_0140_STATEMENTS[upd]).toContain("INTERVAL 14 DAY");
    expect(mark).toBeGreaterThan(upd);
    expect(IDEMPOTENT_ERROR_CODES_0140.has("ER_DUP_FIELDNAME")).toBe(true);
    const schema = readFileSync(resolve(root, "drizzle/schema.ts"), "utf8");
    expect(schema).toContain("cityKey: varchar({ length: 16 })");
    expect(schema).toContain("entityKey: varchar({ length: 96 })");
    expect(schema).toContain("idx_app_notifications_dedupe");
    expect(schema).toContain('mysqlTable("app_notification_maintenance"');
    expect(schema).toMatch(/slaDeadline: timestamp\(\{ mode: 'string' \}\),\n\t\/\/ 0140[^\n]*\n\tslaAlertedAt/);
  });
});

describe("docs/notificacoes.md", () => {
  it("está em dia com as regras (regenerar: pnpm tsx scripts/gen-notificacoes-doc.ts)", () => {
    expect(readFileSync(resolve(root, "docs/notificacoes.md"), "utf8")).toBe(renderNotificacoesDoc());
  });
  it("a tabela cobre todos os tipos", () => {
    expect(routingTable().map((r) => r.kind)).toEqual(NOTIFICATION_KIND_DEFS.map((d) => d.kind));
  });
});
