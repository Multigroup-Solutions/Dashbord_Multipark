/**
 * Descoberta do esquema da BD da aplicação Multipark (DATABASE_URL_MULTIPARK).
 * SÓ LÊ e SÓ ESTRUTURA: tabelas, colunas (tipo, nulo), chaves primárias e
 * estrangeiras, índices, enums e contagens APROXIMADAS de linhas. Nunca lê
 * dados de reservas, clientes ou condutores — o resultado pode ir para o git.
 *
 * Correr da raiz do dashboard (num PC que chegue à BD da Multipark):
 *   pnpm tsx scripts/multipark-db-schema.ts
 *   pnpm tsx scripts/multipark-db-schema.ts --out docs/multipark-db/schema.md
 *   pnpm tsx scripts/multipark-db-schema.ts --schema public --json /tmp/esquema.json
 *   pnpm tsx scripts/multipark-db-schema.ts --print     # também mostra no terminal
 *
 * Lê DATABASE_URL_MULTIPARK do ambiente, do `.env.local` ou do `.env` (por
 * esta ordem). O URL e as credenciais nunca são impressos.
 * Passo seguinte: preencher server/multiparkDb/queries.ts (ver
 * docs/multipark-db/README.md).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { closeMultiparkDb, getMultiparkDb, redactSecrets, MULTIPARK_DB_ENV } from "../server/multiparkDb/client";
import { loadSchemaSnapshot, renderSchemaMarkdown } from "../server/multiparkDb/schemaDoc";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// .env.local primeiro (não sobrepõe o que já vem do ambiente).
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outPath = path.resolve(root, arg("--out") ?? process.env.MULTIPARK_DB_SCHEMA_OUT ?? "docs/multipark-db/schema.md");
const jsonPath = arg("--json") ? path.resolve(arg("--json")!) : null;
const schemas = arg("--schema")?.split(",").map((s) => s.trim()).filter(Boolean);
const print = args.includes("--print");

async function main() {
  if (!process.env[MULTIPARK_DB_ENV]?.trim()) {
    console.error(`${MULTIPARK_DB_ENV} não está definida (ambiente, .env.local ou .env).`);
    process.exit(2);
  }
  const db = await getMultiparkDb();
  const ro = await db.readOnlyCheck();
  console.log(`Ligado (${db.engine}); sessão só de leitura: ${ro ? "sim" : "NÃO — parar e rever o utilizador da BD"}.`);
  if (!ro) process.exit(3);

  const snap = await loadSchemaSnapshot(db, { schemas });
  const mdText = renderSchemaMarkdown(snap);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, mdText + "\n", "utf8");
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(snap, null, 2), "utf8");

  console.log(`${snap.tables.length} tabela(s), ${snap.enums.length} enum(s) → ${path.relative(root, outPath)}${jsonPath ? ` (+ ${jsonPath})` : ""}`);
  for (const t of snap.tables) {
    console.log(`  ${t.schema}.${t.name}  ~${t.approxRows ?? "?"} linha(s)  ${t.columns.length} coluna(s)  PK(${t.primaryKey.join(", ")})`);
  }
  if (print) console.log("\n" + mdText);
}

main()
  .catch((err) => {
    console.error("Falhou:", redactSecrets(err));
    process.exitCode = 1;
  })
  .finally(() => closeMultiparkDb());
