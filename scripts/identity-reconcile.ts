/**
 * Reconciliação de identidade por EMAIL — corrige o que `identity-audit.ts` mostra.
 *
 * REGRA (Jorge, 2026-09-10): um email = uma pessoa.
 *   1. Ficha com email válido e sem utilizador → cria utilizador com ESSE email
 *      (ou liga ao que já existe) e grava `employees.userId`.
 *   2. Agente Multipark com o email de uma ficha → anexa à ficha
 *      (`multiparkAgentUserId` + nome canónico em `multiparkAgentName`).
 *   3. Utilizadores com o mesmo email → fica um; os outros são fundidos
 *      (referências re-apontadas, ficha movida) e removidos.
 *   4. Fichas duplicadas auto-criadas pelo site → `mergeDuplicateExtras`
 *      (mesmas regras de sempre: dry-run, só funde auto-criadas, nunca apaga).
 * O que precisa de decisão humana NÃO é tocado e sai listado.
 *
 * DRY-RUN POR DEFEITO — só escreve com `--apply`.
 *
 * Correr da raiz do dashboard:
 *   ./node_modules/.bin/tsx scripts/identity-reconcile.ts                     # simula tudo
 *   ./node_modules/.bin/tsx scripts/identity-reconcile.ts --apply             # escreve
 *   ./node_modules/.bin/tsx scripts/identity-reconcile.ts --only users        # só 1.
 *   ./node_modules/.bin/tsx scripts/identity-reconcile.ts --only agents       # só 2.
 *   ./node_modules/.bin/tsx scripts/identity-reconcile.ts --only merge-users  # só 3.
 *   ./node_modules/.bin/tsx scripts/identity-reconcile.ts --only merge-employees # só 4.
 *
 * Opções:
 *   --apply              escreve (activity_logs por ação, userId = 0 = sistema)
 *   --only <fase>        users | agents | merge-users | merge-employees (repetível)
 *   --include-inactive   também trata fichas com isActive = 0
 *   --report <path>      grava plano + resultado em JSON (em --apply, se
 *                        omitido, grava sempre uma cópia no temp do sistema)
 *
 * Lê DATABASE_URL do `.env` do dashboard. Abre a sua própria pool (não passa
 * por `getDb()` para não disparar o `ensureRecentSchema`), EXCETO a fase
 * merge-employees, que reutiliza `mergeDuplicateExtras` (usa getDb()).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import {
  applyReconcile,
  buildIdentityAudit,
  loadIdentitySnapshot,
  planReconcile,
  type ApplyResult,
  type ReconcilePlan,
} from "../server/identityReconcile";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });

type Phase = "users" | "agents" | "merge-users" | "merge-employees";
const PHASES: Phase[] = ["users", "agents", "merge-users", "merge-employees"];

interface CliOptions {
  apply: boolean;
  only: Set<Phase>;
  includeInactive: boolean;
  report: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { apply: false, only: new Set(), includeInactive: false, report: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        opts.apply = true;
        break;
      case "--include-inactive":
        opts.includeInactive = true;
        break;
      case "--only": {
        const p = argv[++i] as Phase;
        if (!PHASES.includes(p)) throw new Error(`--only inválido: ${p} (usa ${PHASES.join(" | ")})`);
        opts.only.add(p);
        break;
      }
      case "--report": {
        const p = argv[++i];
        if (!p) throw new Error("--report precisa de um caminho");
        opts.report = path.resolve(p);
        break;
      }
      default:
        throw new Error(`Opção desconhecida: ${arg}`);
    }
  }
  if (!opts.only.size) for (const p of PHASES) opts.only.add(p);
  return opts;
}

function table(title: string, rows: Record<string, unknown>[]) {
  console.log(`\n▶ ${title} (${rows.length})`);
  if (rows.length) console.table(rows);
}

function printPlan(plan: ReconcilePlan, only: Set<Phase>) {
  if (only.has("users")) {
    table(
      "CRIAR utilizador (mesmo email da ficha) + ligar",
      plan.createUsers.map((a) => ({ ficha: a.employeeId, nome: a.fullName, email: a.email, função: a.position, role: a.role })),
    );
    table(
      "LIGAR ficha a utilizador que já existe com o mesmo email",
      plan.linkUsers.map((a) => ({ ficha: a.employeeId, nome: a.fullName, email: a.email, user: a.userId })),
    );
  }
  if (only.has("agents")) {
    table(
      "ANEXAR agente Multipark à ficha com o mesmo email",
      plan.attachAgents.map((a) => ({
        ficha: a.employeeId,
        nome: a.fullName,
        email: a.email,
        agente: a.agentUserId,
        "nome agente": a.agentName,
        "antes (nome/id)": `${a.previousAgentName ?? "—"} / ${a.previousAgentUserId ?? "—"}`,
        ações: a.actions,
      })),
    );
  }
  if (only.has("merge-users")) {
    table(
      "FUNDIR utilizadores duplicados (fica um)",
      plan.mergeUsers.map((m) => ({ email: m.email, fica: m.keepUserId, removidos: m.removeUserIds.join(", ") })),
    );
  }
  const skipped = plan.skipped.filter((s) =>
    (s.what === "create_user" || s.what === "link_user") ? only.has("users") : s.what === "attach_agent" ? only.has("agents") : only.has("merge-users"),
  );
  table("NÃO TOCADO — decisão humana", skipped.map((s) => ({ o_quê: s.what, ref: s.ref, motivo: s.reason })));
}

function filterPlan(plan: ReconcilePlan, only: Set<Phase>): ReconcilePlan {
  return {
    createUsers: only.has("users") ? plan.createUsers : [],
    linkUsers: only.has("users") ? plan.linkUsers : [],
    attachAgents: only.has("agents") ? plan.attachAgents : [],
    mergeUsers: only.has("merge-users") ? plan.mergeUsers : [],
    skipped: plan.skipped,
  };
}

function writeReport(file: string, payload: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\nRelatório gravado em: ${file}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL em falta no .env");
    process.exit(1);
  }

  const pool = mysql.createPool({ uri: url, connectionLimit: 2 });
  const db = drizzle(pool);
  let result: ApplyResult | null = null;
  let plan: ReconcilePlan | null = null;
  let mergeEmployeesReport: unknown = null;
  try {
    const snap = await loadIdentitySnapshot(db);
    const audit = buildIdentityAudit(snap);
    plan = filterPlan(planReconcile(snap, audit, { includeInactive: opts.includeInactive }), opts.only);

    const total = plan.createUsers.length + plan.linkUsers.length + plan.attachAgents.length + plan.mergeUsers.length;
    console.log(
      `${opts.apply ? "APPLY" : "DRY-RUN"} · fases: ${[...opts.only].join(", ")}` +
        `${opts.includeInactive ? " (inclui inativas)" : ""}` +
        ` · ${plan.createUsers.length} criar · ${plan.linkUsers.length} ligar · ${plan.attachAgents.length} anexar · ${plan.mergeUsers.length} fundir · ${plan.skipped.length} para decisão humana`,
    );
    printPlan(plan, opts.only);

    if (opts.apply && total) {
      result = await applyReconcile(db, plan);
      console.log(
        `\n✔ ${result.createdUsers.length} utilizador(es) criado(s) · ${result.linkedUsers.length} ficha(s) ligada(s) · ${result.attachedAgents.length} agente(s) anexado(s) · ${result.mergedUsers.length} email(s) fundido(s)`,
      );
      if (result.errors.length) {
        console.warn(`⚠ ${result.errors.length} erro(s):`);
        console.table(result.errors);
      }
    } else if (opts.apply) {
      console.log("\nNada a escrever nas fases escolhidas.");
    } else if (total) {
      console.log("\nSimulação. Para aplicar: --apply");
    }

    if (opts.only.has("merge-employees")) {
      console.log("\n▶ FICHAS duplicadas auto-criadas pelo site (mergeDuplicateExtras)");
      const { mergeDuplicateExtras } = await import("../server/mergeDuplicateExtras");
      mergeEmployeesReport = await mergeDuplicateExtras({ apply: opts.apply });
      console.log(JSON.stringify(mergeEmployeesReport, null, 2));
      // Fichas com o mesmo email que NÃO são auto-criadas ficam na auditoria
      // (identity-audit.ts → "FICHAS duplicadas") — decisão humana.
    }
  } finally {
    await pool.end();
  }

  const reportPath =
    opts.report ??
    (opts.apply
      ? path.join(os.tmpdir(), `identity-reconcile-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
      : null);
  if (reportPath) {
    writeReport(reportPath, {
      ranAt: new Date().toISOString(),
      mode: opts.apply ? "apply" : "dry-run",
      options: { ...opts, only: [...opts.only] },
      plan,
      result,
      mergeEmployeesReport,
    });
  }
  // mergeDuplicateExtras usa getDb() (pool própria do servidor) — fechar o processo.
  process.exit(0);
}

main().catch((err: unknown) => {
  const cause = err instanceof Error && err.cause instanceof Error ? ` — causa: ${err.cause.message}` : "";
  console.error("Falhou:", err instanceof Error ? err.message + cause : err);
  process.exit(1);
});
