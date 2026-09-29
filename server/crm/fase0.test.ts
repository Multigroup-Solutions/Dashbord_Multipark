import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { clipAccount, dbErrorReason, PRO_ACCOUNT_LIMITS } from "./proSync";
import { INTERNAL_EMAIL_DOMAINS, isGenericEmail, isHouseEmail } from "../../shared/crmIdentity";
import { restoreSuggestionsSql } from "./merge";
import { findEmailInMailbox } from "./review";

vi.mock("../mail/store", async (orig) => ({ ...(await orig<object>()), listMailboxes: vi.fn(async () => []) }));
import { visibleThreadsCondition } from "../mail/inbox";

const dialect = new MySqlDialect();
const render = (q: any) => dialect.sqlToQuery(q);

describe("crm-pro-sync: contas cortadas ao tamanho das colunas", () => {
  it("corta nome, email, telefone, NIF e nome fiscal; tira emoji (utf8mb3)", () => {
    const c = clipAccount({ mpClientId: "x".repeat(80), name: "N".repeat(300), email: "e".repeat(400), phone: "9".repeat(60), nif: "PT".repeat(30), taxName: "Empresa 🚗 Lda" });
    expect(c.mpClientId).toHaveLength(PRO_ACCOUNT_LIMITS.mpClientId);
    expect(c.name).toHaveLength(PRO_ACCOUNT_LIMITS.name);
    expect(c.email).toHaveLength(PRO_ACCOUNT_LIMITS.email);
    expect(c.phone).toHaveLength(PRO_ACCOUNT_LIMITS.phone);
    expect(c.nif).toHaveLength(PRO_ACCOUNT_LIMITS.nif);
    expect(c.taxName).toBe("Empresa  Lda");
    expect(clipAccount({ mpClientId: "1", name: null, email: null, phone: null, nif: null, taxName: null })).toMatchObject({ name: null, email: null });
  });
  it("o erro mostra o motivo do MySQL (do `cause`) sem os valores entre aspas", () => {
    const err = Object.assign(new Error("Failed query: INSERT INTO crm_pro_accounts …"), {
      cause: { code: "ER_DUP_ENTRY", sqlMessage: "Duplicate entry 'ana@x.pt' for key 'uq_crm_pro_mp_client'" },
    });
    const r = dbErrorReason(err);
    expect(r).toContain("ER_DUP_ENTRY");
    expect(r).not.toContain("ana@x.pt");
    expect(dbErrorReason({ code: "ER_DATA_TOO_LONG", sqlMessage: "Data too long for column 'nif' at row 3" })).toContain("Data too long");
  });
  it("o cron regista o motivo real (não só o SQL) e uma conta estranha não pára as outras", () => {
    const cron = readFileSync(join(__dirname, "..", "cronJobs.ts"), "utf8");
    expect(cron).toMatch(/crm-pro-sync\] falhou:", reason/);
    const src = readFileSync(join(__dirname, "proSync.ts"), "utf8");
    expect(src).toContain("fichaErrors");
    expect(src).toMatch(/clipAccount\(a\)/);
  });
});

describe("domínios da casa: lista única", () => {
  it("inclui as marcas e os domínios do Workspace da Comunicação", () => {
    for (const d of ["multipark.pt", "multipark.app", "multivalet.pt", "multibags.pt", "multibags.app", "multidriver.pt", "airpark.pt", "redpark.pt", "skypark.pt", "multigroup.pt"]) {
      expect(INTERNAL_EMAIL_DOMAINS).toContain(d);
    }
  });
  it("email da casa (e subdomínio) é genérico, nunca cliente", () => {
    expect(isHouseEmail("reservas@multibags.app")).toBe(true);
    expect(isHouseEmail("x@lisboa.multipark.pt")).toBe(true);
    expect(isHouseEmail("cliente@gmail.com")).toBe(false);
    expect(isHouseEmail("x@notmultipark.pt")).toBe(false);
    expect(isGenericEmail("staff@multivalet.pt")).toBe(true);
  });
  it("o sync marca como genéricos os emails da casa que já estavam nas fichas", () => {
    const src = readFileSync(join(__dirname, "sync.ts"), "utf8");
    expect(src).toMatch(/await markHouseEmailsGeneric\(db\)/);
    expect(src).toMatch(/UPDATE crm_client_emails SET generic = 1 WHERE generic = 0/);
  });
});

describe("sugestões depois de separar", () => {
  it("as obsoletas da ficha que volta passam a pendentes (se a outra estiver ativa)", () => {
    const q = render(restoreSuggestionsSql(42));
    expect(q.sql).toContain("SET s.status = 'pending'");
    expect(q.sql).toContain("WHERE s.status = 'obsolete'");
    expect(q.sql).toContain("a.status = 'active' AND b.status = 'active'");
    expect(q.params).toEqual([42, 42]);
  });
  it("a separação chama a reposição e o recálculo diário reabre as obsoletas", () => {
    const src = readFileSync(join(__dirname, "merge.ts"), "utf8");
    expect(src).toMatch(/restoreSuggestionsSql\(m\)/);
    expect(src).toContain("status = IF(status = 'obsolete', 'pending', status)");
  });
});

describe("procurar email na caixa", () => {
  it("super admin vê todas as conversas; os outros só as caixas visíveis e o próprio email", async () => {
    expect(render(await visibleThreadsCondition({ id: 1, role: "super_admin", accessOverrides: null })).sql).toBe("1 = 1");
    const q = render(await visibleThreadsCondition({ id: 7, role: "frontoffice", accessOverrides: null }));
    expect(q.sql).toContain("t.mailboxKey IS NULL AND t.ownerUserId = ?");
    expect(q.params).toEqual([7]);
  });
  it("a pesquisa junta as conversas e aplica a condição; % e _ escapados", async () => {
    const calls: any[] = [];
    const db = {
      execute: vi.fn(async (q: any) => {
        const r = render(q);
        calls.push(r);
        if (r.sql.startsWith("SELECT displayName")) return [[{ displayName: "Ana Maria_Silva" }]];
        if (r.sql.includes("FROM mail_messages")) return [[{ email: "ana@gmail.com", fromName: "Ana", n: 2, lastAt: "2026-09-01 10:00:00", subject: "Reserva" }]];
        return [[]];
      }),
    };
    const out = await findEmailInMailbox(db, 5, sql`t.ownerUserId = ${7}`);
    expect(out).toEqual([{ email: "ana@gmail.com", fromName: "Ana", messages: 2, lastAt: "2026-09-01 10:00:00", subject: "Reserva" }]);
    const mail = calls.find((c) => c.sql.includes("FROM mail_messages"));
    expect(mail.sql).toContain("JOIN mail_threads t ON t.id = m.threadId");
    expect(mail.sql).toContain("t.ownerUserId = ?");
    expect(mail.params).toContain("%Ana Maria\\_Silva%");
  });
});
