/** Export original bookingPrice evidence for reservations CREATED since 2026-05-01. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { closeMultiparkDb, getMultiparkDb, MULTIPARK_DB_ENV, redactSecrets } from "../server/multiparkDb/client";
import { collectPrices, collectPricesFromPages, makePeriod, renderCsv } from "../server/multiparkDb/initialBookingPrice";
import { createRemotePriceReader } from "../server/multiparkDb/initialBookingPriceRemote";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const help = `Exporta o bookingPrice inicial do histórico, sem alterar a base de dados.

pnpm export:initial-booking-price [opções]
  --from AAAA-MM-DD    Data de CRIAÇÃO inicial, inclusive (2026-05-01)
  --to AAAA-MM-DD      Data de criação final, inclusive (por omissão: agora)
  --page-size N        Registos por consulta (local: 2000; remoto: 500)
  --remote URL         Usar a ligação no servidor da dashboard (HTTPS)
  --env-file FICHEIRO  Ler a configuração de um ficheiro existente
  --out-dir PASTA      Pasta de destino (exports/initial-booking-price)
  --dry-run           Mostra os filtros; não liga à base de dados
  --help              Mostra esta ajuda

Datas em Europe/Lisbon. Todos os parques e estados, incluindo canceladas.
Ligação: DATABASE_URL_MULTIPARK no ambiente, .env.local ou .env.
Saída: CSV e resumo JSON numa subpasta nova por execução.`;

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--help") { console.log(help); return; }
    if (key === "--dry-run") { dryRun = true; continue; }
    if (!["--from", "--to", "--page-size", "--out-dir", "--remote", "--env-file"].includes(key)) throw new Error(`Opção desconhecida: ${key}`);
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Falta o valor de ${key}.`);
    if (options.has(key)) throw new Error(`Opção repetida: ${key}`);
    options.set(key, args[++i]);
  }
  const period = makePeriod(options.get("--from"), options.get("--to"));
  const remote = options.get("--remote");
  const pageSize = Number(options.get("--page-size") ?? (remote ? 500 : 2000));
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10000) throw new Error("page-size deve estar entre 1 e 10000.");
  if (remote && pageSize > 1000) throw new Error("O modo remoto admite no máximo 1000 registos por lote.");
  console.log(JSON.stringify({ filtro: "Booking.createdAt", fuso: "Europe/Lisbon", ...period, pageSize }, null, 2));
  if (dryRun) return;
  if (options.has("--env-file")) {
    const result = dotenv.config({ path: path.resolve(root, options.get("--env-file")!), quiet: true });
    if (result.error) throw new Error("Não foi possível ler o ficheiro de configuração indicado.");
  }
  dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
  dotenv.config({ path: path.join(root, ".env"), quiet: true });
  const progress = (stage: string, count: number) => console.log(`${stage}: ${count}`);
  const output = await (async () => {
    if (remote) return collectPricesFromPages(createRemotePriceReader(remote, process.env.CRON_SECRET ?? "", period), pageSize, progress);
    if (!process.env[MULTIPARK_DB_ENV]?.trim()) throw new Error(`${MULTIPARK_DB_ENV} não está definida localmente. Usa --remote para a ligação existente no servidor.`);
    const db = await getMultiparkDb();
    if (db.engine !== "postgres") throw new Error("Este script exige a base de dados PostgreSQL operacional da Multipark.");
    if (!await db.readOnlyCheck()) throw new Error("A ligação não confirmou o modo só de leitura. Execução interrompida.");
    return collectPrices(db, period, pageSize, progress);
  })();
  const counts: Record<string, number> = {};
  for (const row of output.rows) counts[row.verificacao] = (counts[row.verificacao] ?? 0) + 1;
  const summary = {
    complete: true, completedAt: new Date().toISOString(), filters: period, timezone: "Europe/Lisbon", mode: remote ? "remote" : "local",
    filterColumn: "Booking.createdAt", bookings: output.rows.length, historyRows: output.histories,
    unmatchedHistoryRows: output.unmatchedHistories, statuses: counts,
    multipleCreatedEvents: output.rows.filter(r => r.registos_created > 1).length,
    consistency: "Consultas paginadas só de leitura; sem snapshot transacional único. Alterações concorrentes podem afetar o resultado.",
    priceRule: "Preço confirmado apenas no primeiro CREATED. Primeiro preço observado é uma coluna separada, sem garantia de ser o da criação.",
  };
  // Only publish complete output after every page succeeds. A failed write has no summary.json.
  const base = path.resolve(root, options.get("--out-dir") ?? "exports/initial-booking-price");
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  await fs.writeFile(path.join(dir, "reservas.csv.partial"), renderCsv(output.rows), { encoding: "utf8", flag: "wx" });
  await fs.rename(path.join(dir, "reservas.csv.partial"), path.join(dir, "reservas.csv"));
  await fs.writeFile(path.join(dir, "resumo.json.partial"), JSON.stringify(summary, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  await fs.rename(path.join(dir, "resumo.json.partial"), path.join(dir, "resumo.json"));
  console.log(`${output.rows.length} reservas exportadas para ${dir}`);
  console.log(JSON.stringify(counts));
}

main().catch(error => { console.error(redactSecrets(error)); process.exitCode = 1; }).finally(() => closeMultiparkDb());
