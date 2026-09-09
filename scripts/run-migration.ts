/**
 * Aplica à mão UMA migração one-shot de `server/migrations/migration_NNNN.ts`
 * (as mesmas que o `ensureRecentSchema` corre no boot). Útil para aplicar
 * antes do deploy ou para confirmar que já está aplicada.
 *
 * Correr da raiz do dashboard:
 *   DATABASE_URL="mysql://..." ./node_modules/.bin/tsx scripts/run-migration.ts 0064
 *   ./node_modules/.bin/tsx scripts/run-migration.ts 0064 --db-url "mysql://..."
 *
 * Idempotente: cada statement é executado por ordem; os códigos MySQL listados
 * em `IDEMPOTENT_ERROR_CODES_NNNN` (coluna/índice/tabela já existe, tabela
 * ainda não existe quando é esperado) contam como "já aplicado". Qualquer outro
 * erro pára o script com exit 1 — nunca continua às cegas.
 *
 * Lê DATABASE_URL da shell (prioridade) ou do `.env` do dashboard. Abre a sua
 * própria pool (não passa por `getDb()`, que dispararia TODAS as migrações do
 * boot antes desta).
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });

function parseArgs(argv: string[]): { id: string; dbUrl: string | null } {
  let id: string | null = null;
  let dbUrl: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db-url") {
      dbUrl = argv[++i] ?? null;
      if (!dbUrl) throw new Error("--db-url precisa de um valor");
    } else if (/^\d{4}$/.test(a)) {
      id = a;
    } else {
      throw new Error(`Argumento desconhecido: ${a}`);
    }
  }
  if (!id) throw new Error("Indica o número da migração, ex.: 0064");
  return { id, dbUrl };
}

async function main() {
  const { id, dbUrl } = parseArgs(process.argv.slice(2));
  const url = dbUrl ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL em falta (shell ou .env) — ou usa --db-url");
    process.exit(1);
  }

  const mod = (await import(`../server/migrations/migration_${id}.ts`)) as Record<string, unknown>;
  const statements = mod[`MIGRATION_${id}_STATEMENTS`] as string[] | undefined;
  const okCodes = mod[`IDEMPOTENT_ERROR_CODES_${id}`] as Set<string> | undefined;
  const name = mod[`MIGRATION_${id}_NAME`] as string | undefined;
  if (!Array.isArray(statements) || !(okCodes instanceof Set)) {
    console.error(`migration_${id}.ts não exporta MIGRATION_${id}_STATEMENTS / IDEMPOTENT_ERROR_CODES_${id}`);
    process.exit(1);
  }

  const host = (() => { try { return new URL(url).hostname; } catch { return "?"; } })();
  console.log(`Migração ${name ?? id} → ${host} · ${statements.length} statement(s)`);

  const pool = mysql.createPool({ uri: url, connectionLimit: 1, multipleStatements: false });
  let applied = 0;
  let skipped = 0;
  try {
    for (const [i, stmt] of statements.entries()) {
      const label = stmt.replace(/\s+/g, " ").trim().slice(0, 96);
      try {
        await pool.query(stmt);
        applied++;
        console.log(`  ✔ [${i + 1}/${statements.length}] ${label}`);
      } catch (err: any) {
        const code = String(err?.code ?? "");
        if (okCodes.has(code)) {
          skipped++;
          console.log(`  · [${i + 1}/${statements.length}] já aplicado (${code}) ${label}`);
          continue;
        }
        console.error(`  ✖ [${i + 1}/${statements.length}] ${code || "ERR"}: ${err?.message ?? err}\n    ${label}`);
        process.exitCode = 1;
        return;
      }
    }
    console.log(`\nConcluído: ${applied} aplicado(s), ${skipped} já existia(m).`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("Falhou:", err instanceof Error ? err.message : err);
  process.exit(1);
});
