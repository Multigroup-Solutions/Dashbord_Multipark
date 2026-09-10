/**
 * Troca `phone` ↔ `nif` nas fichas de colaborador (`employees`) quando os
 * valores estão nas colunas erradas. As regras e as guardas de segurança estão
 * documentadas em `server/employeeContactSwap.ts` (planeador puro + apply).
 *
 * DRY-RUN POR DEFEITO — só escreve com `--apply`.
 *
 * Correr da raiz do dashboard:
 *   ./node_modules/.bin/tsx scripts/swap-employee-phone-nif.ts                 # simula
 *   ./node_modules/.bin/tsx scripts/swap-employee-phone-nif.ts --apply         # escreve
 *
 * Opções:
 *   --apply            escreve as trocas (transação + activity_logs por linha)
 *   --only-active      ignora fichas com isActive = 0 (por defeito vai a TODAS)
 *   --ids 12,34,56     restringe a estes ids
 *   --report <path>    grava o plano completo em JSON (em --apply, se omitido,
 *                      grava sempre uma cópia no temp do sistema — é o backup)
 *   --show-ok          lista também as linhas sem alteração
 *
 * Lê DATABASE_URL do `.env` do dashboard. Abre a sua própria pool (não passa
 * por `getDb()` para não disparar o `ensureRecentSchema`).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { and, asc, eq, inArray } from "drizzle-orm";
import { employees } from "../drizzle/schema";
import {
  applyContactSwap,
  planContactSwap,
  type ContactSwapPlan,
  type ContactSwapPlanItem,
} from "../server/employeeContactSwap";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });

interface CliOptions {
  apply: boolean;
  onlyActive: boolean;
  ids: number[] | null;
  report: string | null;
  showOk: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { apply: false, onlyActive: false, ids: null, report: null, showOk: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        opts.apply = true;
        break;
      case "--only-active":
        opts.onlyActive = true;
        break;
      case "--show-ok":
        opts.showOk = true;
        break;
      case "--ids": {
        const raw = argv[++i];
        if (!raw) throw new Error("--ids precisa de uma lista: --ids 12,34");
        const ids = raw.split(",").map((s) => Number(s.trim()));
        if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error(`--ids inválido: ${raw}`);
        opts.ids = ids;
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
  return opts;
}

function fmt(v: string | null | undefined): string {
  return v == null || v === "" ? "∅" : v;
}

function printSwaps(items: ContactSwapPlanItem[]) {
  if (!items.length) {
    console.log("Nenhuma troca a fazer.");
    return;
  }
  console.log(`\n▶ TROCAS (${items.length})`);
  console.table(
    items.map((i) => ({
      id: i.id,
      nome: i.fullName,
      ativo: i.isActive ? "sim" : "não",
      "phone (antes)": fmt(i.phone.raw),
      "phone (depois)": fmt(i.newPhone),
      "nif (antes)": fmt(i.nif.raw),
      "nif (depois)": fmt(i.newNif),
      motivo: i.reason,
    })),
  );
  const unverified = items.filter((i) => i.reason !== "swap").length;
  if (unverified) {
    console.log(
      `  ${unverified} troca(s) "*-unverified": o valor que muda de coluna NÃO foi validado (checksum/comprimento) — vai tal e qual, confirmar à mão.`,
    );
  }
}

function printReviews(items: ContactSwapPlanItem[]) {
  if (!items.length) return;
  console.log(`\n▶ REVISÃO MANUAL — não tocadas (${items.length})`);
  console.table(
    items.map((i) => ({
      id: i.id,
      nome: i.fullName,
      ativo: i.isActive ? "sim" : "não",
      phone: fmt(i.phone.raw),
      "phone é": i.phone.kind + (i.phone.detail ? ` (${i.phone.detail})` : ""),
      nif: fmt(i.nif.raw),
      "nif é": i.nif.kind + (i.nif.detail ? ` (${i.nif.detail})` : ""),
      motivo: i.reason,
    })),
  );
}

function printOk(items: ContactSwapPlanItem[]) {
  if (!items.length) return;
  console.log(`\n▶ SEM ALTERAÇÃO (${items.length})`);
  console.table(
    items.map((i) => ({
      id: i.id,
      nome: i.fullName,
      phone: fmt(i.phone.raw),
      "phone é": i.phone.kind,
      nif: fmt(i.nif.raw),
      "nif é": i.nif.kind,
    })),
  );
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
  try {
    const conditions = [];
    if (opts.onlyActive) conditions.push(eq(employees.isActive, 1));
    if (opts.ids) conditions.push(inArray(employees.id, opts.ids));

    const rows = await db
      .select({
        id: employees.id,
        fullName: employees.fullName,
        isActive: employees.isActive,
        phone: employees.phone,
        nif: employees.nif,
      })
      .from(employees)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(employees.id));

    const plan: ContactSwapPlan = planContactSwap(rows);
    const swaps = plan.items.filter((i) => i.decision === "swap");
    const reviews = plan.items.filter((i) => i.decision === "review");
    const ok = plan.items.filter((i) => i.decision === "ok");

    console.log(
      `${opts.apply ? "APPLY" : "DRY-RUN"} · ${plan.total} fichas lidas` +
        `${opts.onlyActive ? " (só ativas)" : ""}${opts.ids ? ` (ids ${opts.ids.join(",")})` : ""}` +
        ` · ${plan.swaps} a trocar · ${plan.reviews} para revisão · ${plan.ok} sem alteração`,
    );
    printSwaps(swaps);
    printReviews(reviews);
    if (opts.showOk) printOk(ok);

    let result: Awaited<ReturnType<typeof applyContactSwap>> | null = null;
    if (opts.apply && swaps.length) {
      result = await applyContactSwap(db, plan);
      console.log(`\n✔ ${result.applied.length} ficha(s) atualizada(s)`);
      if (result.stale.length) {
        console.warn(
          `⚠ ${result.stale.length} ficha(s) mudaram entre a leitura e a escrita e NÃO foram tocadas: ${result.stale.join(", ")} — volta a correr.`,
        );
      }
    } else if (opts.apply) {
      console.log("\nNada a escrever.");
    } else if (swaps.length) {
      console.log("\nSimulação. Para aplicar: --apply");
    }

    const reportPath =
      opts.report ??
      (opts.apply && swaps.length
        ? path.join(os.tmpdir(), `employee-contact-swap-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
        : null);
    if (reportPath) {
      writeReport(reportPath, {
        ranAt: new Date().toISOString(),
        mode: opts.apply ? "apply" : "dry-run",
        options: opts,
        summary: { total: plan.total, swaps: plan.swaps, reviews: plan.reviews, ok: plan.ok },
        applied: result?.applied ?? [],
        stale: result?.stale ?? [],
        swaps,
        reviews,
      });
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const cause = err instanceof Error && err.cause instanceof Error ? ` — causa: ${err.cause.message}` : "";
  console.error("Falhou:", err instanceof Error ? err.message + cause : err);
  process.exit(1);
});
