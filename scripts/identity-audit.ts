/**
 * Auditoria de identidade por EMAIL — utilizadores × fichas × agentes Multipark.
 * SÓ LÊ. Não escreve nada.
 *
 * Correr da raiz do dashboard:
 *   ./node_modules/.bin/tsx scripts/identity-audit.ts
 *   ./node_modules/.bin/tsx scripts/identity-audit.ts --report relatorio.json
 *   ./node_modules/.bin/tsx scripts/identity-audit.ts --full     # tabelas sem limite de linhas
 *
 * Lê DATABASE_URL do `.env` do dashboard (ou do ambiente). Abre a sua própria
 * pool (não passa por `getDb()` para não disparar o `ensureRecentSchema`).
 *
 * Para corrigir o que aqui aparece: `scripts/identity-reconcile.ts`.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { buildIdentityAudit, loadIdentitySnapshot, type IdentityAudit } from "../server/identityReconcile";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });

const args = process.argv.slice(2);
const full = args.includes("--full");
const reportIdx = args.indexOf("--report");
const reportPath = reportIdx >= 0 ? path.resolve(args[reportIdx + 1] ?? "") : null;
const LIMIT = full ? Infinity : 40;

function table(title: string, rows: Record<string, unknown>[]) {
  console.log(`\n▶ ${title} (${rows.length})`);
  if (!rows.length) return;
  console.table(rows.slice(0, LIMIT));
  if (rows.length > LIMIT) console.log(`  … mais ${rows.length - LIMIT} (usa --full ou --report)`);
}

function print(audit: IdentityAudit) {
  console.log("\n══ CONTAGENS ══");
  console.table(audit.counts);

  table(
    "FICHAS com email válido e SEM utilizador → criar/ligar utilizador",
    audit.employeesWithoutUser.map((e) => ({
      ficha: e.employeeId,
      nome: e.fullName,
      email: e.email,
      função: e.position,
      ativa: e.isActive ? "sim" : "não",
      "já existe user": e.existingUserId ?? "—",
    })),
  );
  table(
    "FICHAS com email INVÁLIDO (não dá para criar utilizador)",
    audit.employeesInvalidEmail.map((e) => ({ ficha: e.employeeId, nome: e.fullName, email: e.email, ativa: e.isActive ? "sim" : "não" })),
  );
  table(
    "FICHAS ligadas a utilizador com email DIFERENTE",
    audit.employeeUserEmailMismatch.map((m) => ({
      ficha: m.employeeId,
      nome: m.fullName,
      "email ficha": m.employeeEmail,
      user: m.userId,
      "email user": m.userEmail,
      "user ativo": m.userActive ? "sim" : "não",
    })),
  );
  table(
    "FICHAS ligadas a userId inexistente",
    audit.employeesDanglingUser.map((d) => ({ ficha: d.employeeId, nome: d.fullName, userId: d.userId })),
  );
  table(
    "UTILIZADORES duplicados (mesmo email)",
    audit.duplicateUsers.flatMap((g) =>
      g.rows.map((u) => ({
        email: g.email,
        user: u.id,
        nome: u.name,
        openId: u.openId.slice(0, 18),
        role: u.role,
        ativo: u.isActive ? "sim" : "não",
        "último login": u.lastSignedIn?.slice(0, 10),
      })),
    ),
  );
  table(
    "FICHAS duplicadas (mesmo email)",
    audit.duplicateEmployees.flatMap((g) =>
      g.rows.map((e) => ({ email: g.email, ficha: e.id, nome: e.fullName, função: e.position, ativa: e.isActive ? "sim" : "não", userId: e.userId ?? "—" })),
    ),
  );
  table(
    "UTILIZADORES com várias fichas ATIVAS",
    audit.usersWithSeveralActiveEmployees.map((x) => ({ user: x.userId, fichas: x.employeeIds.join(", ") })),
  );
  table(
    "UTILIZADORES ativos sem ficha nenhuma (info)",
    audit.usersWithoutEmployee.map((u) => ({ user: u.userId, nome: u.name, email: u.email, role: u.role })),
  );
  table(
    "AGENTES Multipark com email igual a uma ficha/utilizador mas NÃO anexados → anexar",
    audit.agentsToAttach.map((a) => ({
      agente: a.agentUserId,
      nomes: a.agentNames.join(" | "),
      email: a.agentEmails.join(" | "),
      ações: a.actions,
      "última ação": a.lastAction?.slice(0, 10),
      "fichas c/ email": a.emailMatchEmployeeIds.join(", ") || "—",
      "users c/ email": a.emailMatchUserIds.join(", ") || "—",
    })),
  );
  table(
    "AGENTES anexados a ficha com email DIFERENTE",
    audit.agentsEmailMismatch.map((a) => ({
      agente: a.agentUserId,
      nomes: a.agentNames.join(" | "),
      "email agente": a.agentEmails.join(" | "),
      fichas: a.linkedEmployeeIds.join(", "),
      "email ficha": a.employeeEmail,
      ações: a.actions,
    })),
  );
  table(
    "AGENTES sem ficha nem utilizador correspondente (nem por ligação nem por email)",
    audit.agentsUnmatched.map((a) => ({
      agente: a.agentUserId,
      nomes: a.agentNames.join(" | "),
      email: a.agentEmails.join(" | ") || "—",
      ações: a.actions,
      "última ação": a.lastAction?.slice(0, 10),
    })),
  );
  table(
    "O MESMO email usado por VÁRIOS agentes (mesma pessoa, várias contas Multipark)",
    audit.agentsSharingEmail.map((x) => ({ email: x.email, agentes: x.agentUserIds.join(", ") })),
  );
  table(
    "AGENTES anexados a MAIS do que uma ficha ativa",
    audit.agentsLinkedToSeveralEmployees.map((x) => ({ agente: x.agentUserId, fichas: x.employeeIds.join(", ") })),
  );
  table(
    "FICHAS ativas com agente indicado que NUNCA apareceu no histórico",
    audit.employeesWithUnknownAgent.map((e) => ({ ficha: e.employeeId, nome: e.fullName, agentName: e.multiparkAgentName, agentUserId: e.multiparkAgentUserId })),
  );
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL em falta (no .env ou no ambiente)");
    process.exit(1);
  }
  const pool = mysql.createPool({ uri: url, connectionLimit: 2 });
  const db = drizzle(pool);
  try {
    const snap = await loadIdentitySnapshot(db);
    const audit = buildIdentityAudit(snap);
    print(audit);
    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify({ ranAt: new Date().toISOString(), audit }, null, 2), "utf8");
      console.log(`\nRelatório gravado em: ${reportPath}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("Falhou:", err instanceof Error ? err.message : err);
  process.exit(1);
});
