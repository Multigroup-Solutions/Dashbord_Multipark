/**
 * Todo o email pela API do Gmail + encaminhamento por alias (migração 0195):
 * resolução do alias pelos cabeçalhos (multi-domínio, "Por classificar"),
 * tabela de aliases, avisos, serviço único de envio (sem SMTP), cadência do
 * mail-sync com o push e fim do IMAP. Sem rede nem BD.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  aliasPipeline, aliasTableOf, applyAliasTable, classifyMessage, configuredPipelines, mailboxConfigSchema, mailRoutingWarnings, parseMailOwner,
  resolveAlias, MAIL_AUTOMATED_SYSTEM, SYSTEM_MAIL_HEADER, type MailboxConfig,
} from "../shared/mail";
import { parseGmailMessage } from "./mail/parse";
import { accountForAlias, clearSendAsCache, isEmailSendConfigured, sendMailWith, type SenderApi, type SystemMailDeps } from "./mail/systemMail";
import {
  MAIL_SYNC_MINUTES, MAIL_SYNC_SAFETY_NET_MINUTES, TICK_JOBS, describeCadence, effectiveTickJobs, emptyState, isDue, mailPushHealthy,
} from "./cronSchedule";
import { MIGRATION_0195_STATEMENTS, IDEMPOTENT_ERROR_CODES_0195 } from "./migrations/migration_0195";

const root = resolve(import.meta.dirname, "..");

const mb = (over: Partial<MailboxConfig>): MailboxConfig => mailboxConfigSchema.parse({
  key: "info", label: "Info", addresses: [{ address: "info@multipark.pt", brand: "multipark" }], sourceKind: "dwd",
  sourceEmail: "reservas@multipark.pt", module: "comunicacao", ...over,
});

// As duas caixas reais do desenho do Jorge: reservas@ e info@, cada uma com
// aliases de vários domínios/marcas (a lista concreta vem depois — aqui só exemplos de teste).
const boxes: MailboxConfig[] = [
  mb({
    key: "reservas", label: "Reservas", module: "reservas_operacoes", sourceEmail: "reservas@multipark.pt", catchAll: true,
    addresses: [
      { address: "reservas@multipark.pt", brand: "multipark" },
      { address: "reservas@skypark.pt", brand: "skypark", cityId: 2, tag: "Skypark Porto", owner: "role:backoffice" },
      { address: "reservas@airpark.pt", brand: "airpark", cityId: 3 },
    ] as any,
  }),
  mb({
    key: "reclamacoes", label: "Reclamações", module: "reclamacoes", pipeline: "reclamacoes", sourceEmail: "reservas@multipark.pt",
    addresses: [{ address: "reclamacoes@multipark.pt", brand: "multipark" }, { address: "reclamacoes@redpark.pt", brand: "redpark", active: false }] as any,
  }),
  mb({
    key: "info", label: "Info", sourceEmail: "info@multipark.pt",
    addresses: [
      { address: "info@multipark.pt", brand: "multipark" },
      { address: "info@multipark.app", brand: "multipark", destination: "geral" },
      { address: "perdidos@airpark.pt", brand: "airpark", destination: "perdidos", owner: "user:7", tag: "Perdidos Faro" },
    ] as any,
  }),
];
const account = ["reservas@multipark.pt"];

// ─── 1. Resolução do alias pelos cabeçalhos ─────────────────────────────────

describe("alias pelos cabeçalhos (Delivered-To → X-Original-To → To → Cc)", () => {
  it("o Delivered-To da própria caixa é saltado; o alias vem do To (outro domínio)", () => {
    const r = resolveAlias({ deliveredTo: ["reservas@multipark.pt"], to: ["Reservas@Skypark.pt"] }, boxes, { accountEmails: account });
    expect(r).toMatchObject({ mailboxKey: "reservas", matchedAddress: "reservas@skypark.pt", via: "to" });
    expect(r.alias).toMatchObject({ brand: "skypark", cityId: 2, tag: "Skypark Porto", owner: "role:backoffice" });
  });
  it("ordem: Delivered-To (alias) → X-Original-To → To → Cc", () => {
    expect(resolveAlias({ deliveredTo: ["reclamacoes@multipark.pt"], to: ["info@multipark.pt"] }, boxes, { accountEmails: account })).toMatchObject({ mailboxKey: "reclamacoes", via: "delivered-to" });
    expect(resolveAlias({ deliveredTo: ["reservas@multipark.pt"], xOriginalTo: ["perdidos@airpark.pt"], to: ["info@multipark.pt"] }, boxes, { accountEmails: account })).toMatchObject({ mailboxKey: "info", via: "x-original-to" });
    expect(resolveAlias({ to: ["cliente@gmail.com"], cc: ["info@multipark.app"] }, boxes)).toMatchObject({ mailboxKey: "info", via: "cc", matchedAddress: "info@multipark.app" });
  });
  it("mesmo nome local em domínios diferentes vai para caixas/marcas diferentes", () => {
    expect(classifyMessage({ to: ["reservas@airpark.pt"] }, boxes)).toMatchObject({ mailboxKey: "reservas", brand: "airpark" });
    expect(classifyMessage({ to: ["info@multipark.app"] }, boxes)).toMatchObject({ mailboxKey: "info", brand: "multipark" });
  });
  it("o endereço da conta conta quando vem no To (escrito diretamente para reservas@)", () => {
    expect(classifyMessage({ deliveredTo: ["reservas@multipark.pt"], to: ["reservas@multipark.pt"] }, boxes, { accountEmails: account }))
      .toMatchObject({ mailboxKey: "reservas", triage: false, via: "to" });
  });
  it("Bcc (só o Delivered-To da conta) → Por classificar (fica na caixa 'apanha tudo' até ser atribuído)", () => {
    const c = classifyMessage({ deliveredTo: ["reservas@multipark.pt"], to: ["outra@empresa.pt"] }, boxes, { accountEmails: account });
    expect(c).toMatchObject({ triage: true, alias: null, mailboxKey: "reservas" });
    const noCatch = boxes.map((m) => ({ ...m, catchAll: false }));
    expect(classifyMessage({ deliveredTo: ["reservas@multipark.pt"], to: ["outra@empresa.pt"] }, noCatch, { accountEmails: account }))
      .toMatchObject({ triage: true, mailboxKey: null });
  });
  it("endereço da empresa fora da tabela (ex.: alias novo, domínio novo) → Por classificar, marca pelo domínio", () => {
    const c = classifyMessage({ deliveredTo: ["reservas@multipark.pt"], to: ["geral@redpark.pt"] }, boxes, { accountEmails: account });
    expect(c).toMatchObject({ triage: true, brand: "redpark", matchedAddress: "geral@redpark.pt" });
  });
  it("alias inativo não encaminha", () => {
    expect(classifyMessage({ to: ["reclamacoes@redpark.pt"] }, boxes, { accountEmails: account })).toMatchObject({ triage: true, alias: null });
  });
  it("enviadas classificam-se pelo From e nunca vão para Por classificar; conta pessoal nunca vai", () => {
    expect(classifyMessage({ from: "perdidos@airpark.pt", to: ["x@gmail.com"] }, boxes, { outbound: true })).toMatchObject({ mailboxKey: "info", triage: false });
    expect(classifyMessage({ from: "desconhecido@multipark.pt" }, boxes, { outbound: true }).triage).toBe(false);
    expect(classifyMessage({ to: ["jorge@multipark.pt"] }, [], { personalOwner: true })).toMatchObject({ personal: true, triage: false });
  });
  it("parse: Delivered-To (todos os saltos), X-Original-To/Envelope-To e o cabeçalho de sistema", () => {
    const m = parseGmailMessage({
      id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: String(Date.UTC(2026, 8, 26)),
      payload: { mimeType: "text/plain", body: { data: "" }, headers: [
        { name: "Delivered-To", value: "reservas@multipark.pt" }, { name: "Delivered-To", value: "reservas@skypark.pt" },
        { name: "Envelope-To", value: "info@multipark.app" }, { name: "To", value: "Cliente <c@x.pt>" }, { name: "From", value: "a@b.pt" },
        { name: SYSTEM_MAIL_HEADER, value: "1" },
      ] },
    }, { accountEmail: "reservas@multipark.pt" });
    expect(m.deliveredTo).toEqual(["reservas@multipark.pt", "reservas@skypark.pt"]);
    expect(m.xOriginalTo).toEqual(["info@multipark.app"]);
    expect(m.systemMail).toBe(true);
    expect(resolveAlias(m, boxes, { accountEmails: account })).toMatchObject({ mailboxKey: "reservas", matchedAddress: "reservas@skypark.pt", via: "delivered-to" });
  });
});

// ─── 2. Destino, responsável e avisos ───────────────────────────────────────

describe("destino/pipeline, responsável e avisos do encaminhamento", () => {
  it("o destino do alias manda; 'como a caixa' usa o pipeline da caixa", () => {
    const info = boxes[2];
    expect(aliasPipeline(info, info.addresses[2], "x")).toBe("perdidos");
    expect(aliasPipeline(boxes[1], boxes[1].addresses[0], "x")).toBe("reclamacoes");
    expect(aliasPipeline(boxes[1], { destination: "geral" }, "x")).toBeNull();
    expect(aliasPipeline(boxes[0], null, "Fwd: ocorrência", ["ocorrencias"])).toBe("ocorrencias");
    expect([...configuredPipelines(boxes).keys()].sort()).toEqual(["perdidos", "reclamacoes"]);
  });
  it("responsável: pessoa ou equipa (papel)", () => {
    expect(parseMailOwner("user:7")).toEqual({ kind: "user", userId: 7 });
    expect(parseMailOwner("role:backoffice")).toEqual({ kind: "role", role: "backoffice" });
    expect(parseMailOwner("role:extra")).toBeNull();
    expect(parseMailOwner("x")).toBeNull();
    expect(() => mb({ addresses: [{ address: "a@multipark.pt", brand: "multipark", owner: "role:extra" }] as any })).toThrow();
  });
  it("avisa pipelines sem alias e caixas sem Gmail saudável (nunca em silêncio)", () => {
    const now = Date.UTC(2026, 8, 26, 12);
    const ok = new Date(now - 10 * 60_000).toISOString().slice(0, 19).replace("T", " ");
    const w = mailRoutingWarnings({
      mailboxes: boxes, dwdAvailable: true, now,
      accounts: [{ accountKey: "dwd:reservas@multipark.pt", status: "ok", lastOkAt: ok }, { accountKey: "dwd:info@multipark.pt", status: "error", lastOkAt: null }],
    });
    expect(w.some((x) => x.startsWith("Críticas: nenhum alias"))).toBe(true);
    expect(w.some((x) => x.startsWith("Reclamações: nenhum alias"))).toBe(false);
    expect(w.find((x) => x.includes('Caixa "Info"'))).toContain("Perdidos e Achados");
    expect(w.some((x) => x.includes('Caixa "Reservas"'))).toBe(false);
    const noDwd = mailRoutingWarnings({ mailboxes: boxes, dwdAvailable: false, accounts: [], now });
    expect(noDwd.filter((x) => x.includes("delegação")).length).toBe(3);
  });
});

// ─── 3. Tabela de aliases ───────────────────────────────────────────────────

describe("tabela de aliases (extensão das caixas, sem sistema paralelo)", () => {
  it("caixas antigas (só endereço + marca) continuam válidas com omissões", () => {
    const m = mb({});
    expect(m.addresses[0]).toEqual({ address: "info@multipark.pt", brand: "multipark", cityId: null, destination: "caixa", owner: null, tag: "", active: true });
  });
  it("tabela plana ↔ caixas; mover um alias de caixa; recusa repetidos, caixas vazias e desconhecidas", () => {
    const rows = aliasTableOf(boxes);
    expect(rows).toHaveLength(8);
    const moved = rows.map((r) => (r.address === "info@multipark.app" ? { ...r, mailboxKey: "reservas" } : r));
    const ok = applyAliasTable(boxes, moved);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.changed.map((m) => m.key).sort()).toEqual(["info", "reservas"]);
    expect(applyAliasTable(boxes, rows)).toEqual({ ok: true, changed: [] });
    const dup = applyAliasTable(boxes, [...rows, { ...rows[0], mailboxKey: "info" }]);
    expect(dup.ok).toBe(false);
    const empty = applyAliasTable(boxes, rows.filter((r) => r.mailboxKey !== "reclamacoes"));
    expect(empty.ok ? "" : empty.error).toContain("ficaria sem endereços");
    expect(applyAliasTable(boxes, [...rows, { ...rows[0], address: "novo@x.pt", mailboxKey: "nao-existe" }]).ok).toBe(false);
  });
  it("migração 0195: idempotente, sem sementes, registada no fim do ensureRecentSchema", () => {
    expect(MIGRATION_0195_STATEMENTS.every((s) => /^ALTER TABLE `mail_threads` ADD (COLUMN|INDEX)/.test(s))).toBe(true);
    expect([...IDEMPOTENT_ERROR_CODES_0195].sort()).toEqual(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    const i190 = db.indexOf('import("./migrations/migration_0190")');
    const i195 = db.indexOf('import("./migrations/migration_0195")');
    expect(i190).toBeGreaterThan(0);
    expect(i195).toBeGreaterThan(i190);
  });
});

// ─── 4. Serviço único de envio (Gmail API, sem SMTP) ────────────────────────

function fakeDeps(o: { sendAs?: Record<string, string[]>; failSend?: boolean; dwd?: boolean } = {}) {
  const sent: Array<{ accountKey: string; raw: string }> = [];
  const deps: SystemMailDeps = {
    async systemSender() { return "notificacoes@multipark.pt"; },
    async mailboxes() { return boxes; },
    async apiFor(accountKey): Promise<SenderApi> {
      return {
        async listSendAs() {
          return [{ sendAsEmail: accountKey.replace(/^dwd:/, ""), isPrimary: true, verificationStatus: null }, ...(o.sendAs?.[accountKey] ?? []).map((e) => ({ sendAsEmail: e, verificationStatus: "accepted" }))];
        },
        async sendRaw(raw) {
          if (o.failSend) throw new Error("Precondition check failed.");
          sent.push({ accountKey, raw: raw.toString("utf8") });
          return { id: "g1", threadId: null };
        },
      };
    },
    dwdAvailable: () => o.dwd ?? true,
  };
  return { deps, sent };
}

describe("envio de email pela API do Gmail (serviço único)", () => {
  it("email de sistema: sai do remetente de sistema, marcado como automático (não polui a Comunicação)", async () => {
    clearSendAsCache();
    const { deps, sent } = fakeDeps();
    const r = await sendMailWith(deps, { to: "a@x.pt, b@y.pt", subject: "Briefing", text: "olá", html: "<p>olá</p>" });
    expect(r).toMatchObject({ ok: true, from: "notificacoes@multipark.pt", accountKey: "dwd:notificacoes@multipark.pt" });
    expect(r.messageId).toMatch(/^<[0-9a-f-]+@multipark\.pt>$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].raw).toMatch(/X-Multipark-System: 1/i);
    expect(sent[0].raw).toMatch(/Auto-Submitted: auto-generated/i);
    expect(sent[0].raw).toMatch(/To: a@x\.pt, b@y\.pt/);
    expect(sent[0].raw).toContain(r.messageId!);
  });
  it("email a cliente com alias: sai da conta de origem da caixa ('Enviar como'), sem marca de sistema, com threading", async () => {
    clearSendAsCache();
    const { deps, sent } = fakeDeps({ sendAs: { "dwd:reservas@multipark.pt": ["reclamacoes@multipark.pt"] } });
    const r = await sendMailWith(deps, { to: "cliente@gmail.com", subject: "[REC-1] Resposta", text: "x", from: "Reclamacoes@multipark.pt", inReplyTo: "<a@b>", references: ["<a@b>"] });
    expect(r).toMatchObject({ ok: true, from: "reclamacoes@multipark.pt", accountKey: "dwd:reservas@multipark.pt" });
    expect(sent[0].raw).not.toMatch(/X-Multipark-System/i);
    expect(sent[0].raw).toMatch(/In-Reply-To: <a@b>/);
    expect(accountForAlias("perdidos@airpark.pt", boxes)).toBe("dwd:info@multipark.pt");
  });
  it("alias fora do 'Enviar como' → sai do remetente de sistema com Reply-To = alias", async () => {
    clearSendAsCache();
    const log = vi.fn();
    const { deps, sent } = fakeDeps();
    const r = await sendMailWith({ ...deps, log }, { to: "c@x.pt", subject: "s", text: "t", from: "perdidos@airpark.pt" });
    expect(r).toMatchObject({ ok: true, from: "notificacoes@multipark.pt" });
    expect(sent[0].raw).toMatch(/Reply-To: perdidos@airpark\.pt/);
    expect(log).toHaveBeenCalled();
  });
  it("sem conta de serviço / sem destinatários / erro da API → ok:false (nunca lança)", async () => {
    clearSendAsCache();
    expect((await sendMailWith(fakeDeps({ dwd: false }).deps, { to: "a@x.pt", subject: "s" })).ok).toBe(false);
    expect((await sendMailWith(fakeDeps().deps, { to: "sem-email", subject: "s" })).ok).toBe(false);
    const f = await sendMailWith(fakeDeps({ failSend: true }).deps, { to: "a@x.pt", subject: "s" });
    expect(f).toMatchObject({ ok: false, error: "Precondition check failed." });
  });
  it("configurado = conta de serviço (SMTP_* já não conta)", () => {
    expect(isEmailSendConfigured({ GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sa@x", private_key: "k" }) })).toBe(true);
    expect(isEmailSendConfigured({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" })).toBe(false);
  });
  it("mensagem de sistema guardada pela sincronização fica automática (3) e escondida", () => {
    const store = readFileSync(resolve(root, "server/mail/store.ts"), "utf8");
    expect(MAIL_AUTOMATED_SYSTEM).toBe(3);
    expect(store).toContain("extra.systemMail ? MAIL_AUTOMATED_SYSTEM");
    expect(store).toMatch(/automated IN \(\$\{MAIL_AUTOMATED_RESERVATION\}, \$\{MAIL_AUTOMATED_SYSTEM\}\)/);
  });
});

// ─── 5. Cadência do mail-sync com o push ────────────────────────────────────

describe("cadência do mail-sync com o push do Gmail", () => {
  const now = Date.UTC(2026, 8, 26, 10, 20);
  it("push saudável = interruptor + tópico + push nas últimas 6 h", () => {
    expect(mailPushHealthy({ flagOn: true, topicConfigured: true, lastPushAt: now - 30 * 60_000, now })).toBe(true);
    expect(mailPushHealthy({ flagOn: false, topicConfigured: true, lastPushAt: now - 60_000, now })).toBe(false);
    expect(mailPushHealthy({ flagOn: true, topicConfigured: false, lastPushAt: now - 60_000, now })).toBe(false);
    expect(mailPushHealthy({ flagOn: true, topicConfigured: true, lastPushAt: null, now })).toBe(false);
    expect(mailPushHealthy({ flagOn: true, topicConfigured: true, lastPushAt: now - 7 * 3_600_000, now })).toBe(false);
    // Uma conta sem watch em dia só seria lida pelo agendador → mantém os 5 min.
    expect(mailPushHealthy({ flagOn: true, topicConfigured: true, lastPushAt: now - 60_000, now, allWatched: false })).toBe(false);
  });
  it("5 min sem push; de hora a hora com push (e volta aos 5 min quando o push cala)", () => {
    const off = effectiveTickJobs(TICK_JOBS, { mailPushHealthy: false }).find((j) => j.key === "mail-sync")!;
    const on = effectiveTickJobs(TICK_JOBS, { mailPushHealthy: true }).find((j) => j.key === "mail-sync")!;
    expect(describeCadence(off.cadence)).toBe(`a cada ${MAIL_SYNC_MINUTES} min`);
    expect(describeCadence(on.cadence)).toBe("de hora a hora");
    expect(MAIL_SYNC_SAFETY_NET_MINUTES).toBe(60);
    const st = { ...emptyState("mail-sync"), lastStartedAt: now - 10 * 60_000, lastStatus: "ok" as const };
    expect(isDue(off, st, now).due).toBe(true);   // outra fatia de 5 min
    expect(isDue(on, st, now).due).toBe(false);   // mesma hora
    expect(isDue(on, { ...st, lastStartedAt: now - 61 * 60_000 }, now).due).toBe(true);
    // Os outros trabalhos não mudam.
    expect(effectiveTickJobs(TICK_JOBS, { mailPushHealthy: true }).filter((j) => j.key !== "mail-sync")).toEqual(TICK_JOBS.filter((j) => j.key !== "mail-sync"));
  });
  it("o watch do push é renovado dentro do mail-sync (corre pelo menos de hora a hora → diário garantido)", () => {
    const src = readFileSync(resolve(root, "server/mail/service.ts"), "utf8");
    expect(src).toMatch(/report\.watchRenewed = await renewWatches\(/);
    expect(src).toMatch(/const soon = Date\.now\(\) \+ 24 \* 3_600_000;/);
    const sched = readFileSync(resolve(root, "server/cronScheduler.ts"), "utf8");
    expect(sched).toContain("effectiveTickJobs(TICK_JOBS, await loadDynamicCadence(now))");
  });
});

// ─── 6. Fim do SMTP e do IMAP; acessos ──────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".generated.ts")) out.push(p);
  }
  return out;
}

describe("sem SMTP nem IMAP", () => {
  it("nenhum código do servidor usa transporte SMTP, IMAP ou as variáveis SMTP_/IMAP_", () => {
    for (const f of [...walk(resolve(root, "server")), ...walk(resolve(root, "shared"))]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/createTransport|imapflow|mailparser|process\.env\.(SMTP|IMAP)_|\benv\.(SMTP|IMAP)_/);
    }
    const env = readFileSync(resolve(root, ".env.example"), "utf8");
    expect(env).not.toMatch(/^(SMTP|IMAP)_/m);
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.dependencies.imapflow).toBeUndefined();
    expect(pkg.dependencies.mailparser).toBeUndefined();
  });
  it("o email-inbound saiu do agendador, dos endpoints e do workflow", () => {
    expect(TICK_JOBS.some((j) => j.key === "email-inbound")).toBe(false);
    expect(readFileSync(resolve(root, "server/_core/api-entry.ts"), "utf8")).not.toContain("/api/cron/email-inbound");
    expect(readFileSync(resolve(root, ".github/workflows/multipark-cron.yml"), "utf8")).not.toContain("email-inbound");
  });
  it("tabela de aliases, remetente e 'Por classificar': só admin/super_admin (verificação em cada procedimento)", () => {
    const src = readFileSync(resolve(root, "server/mail/router.ts"), "utf8");
    const settings = src.slice(src.indexOf("  settings: router({"), src.indexOf("  /** Sincronizar já a MINHA caixa pessoal"));
    const blocks = settings.split(/\n {4}(?=\w+: protectedProcedure)/).slice(1);
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    for (const b of blocks) expect(/adminOnly\(ctx\.user as CtxUser\)|superOnly\(ctx\.user as CtxUser\)/.test(b), b.slice(0, 60)).toBe(true);
    expect(src).toMatch(/assignTriage: protectedProcedure[\s\S]*?adminOnly\(ctx\.user as CtxUser\)/);
    const inbox = readFileSync(resolve(root, "server/mail/inbox.ts"), "utf8");
    expect(inbox).toMatch(/assignTriagedThread[\s\S]*?if \(!canTriageMail\(viewer\)\) throw forbidden/);
  });
});
