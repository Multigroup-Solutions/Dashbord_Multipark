import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { closeMultiparkDb, getMultiparkDb, redactSecrets } from "../server/multiparkDb/client";
import { makePeriod, csvCell } from "../server/multiparkDb/initialBookingPrice";
import { createRemoteExportPageReader } from "../server/multiparkDb/initialBookingPriceRemote";
import { agentExportPage, bookingDriversPage, collectActiveAgents, agentExportCsv, type AgentExportRecord, type AgentExportReader, type BookingDriversRow } from "../server/multiparkDb/activeAgentsExport";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function main() {
  const options = new Map<string, string>();
  const args = process.argv.slice(2);
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--help") {
      console.log(`Exporta agentes com interações desde 1 de maio de 2026, em todas as cidades.
pnpm export:active-agents [--from AAAA-MM-DD] [--to AAAA-MM-DD]
  --remote URL         Ler através do servidor da dashboard (HTTPS)
  --env-file FICHEIRO  Configuração privada existente
  --page-size N        Registos por consulta (1000; máximo 1000)
  --out-dir PASTA      Destino (exports/active-agents)
  --dry-run           Verificar filtros sem consultar a base de dados
Local: DATABASE_URL_MULTIPARK. Remoto: AGENT_ACTIVITY_EXPORT_SECRET.
O filtro usa a DATA DA INTERAÇÃO. Não altera registos.`);
      return;
    }
    if (key === "--dry-run") { dryRun = true; continue; }
    if (!["--from", "--to", "--remote", "--env-file", "--page-size", "--out-dir"].includes(key) || options.has(key)) throw new Error(`Opção inválida ou repetida: ${key}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Falta o valor de ${key}.`);
    options.set(key, value);
  }
  const period = makePeriod(options.get("--from"), options.get("--to"));
  const pageSize = Number(options.get("--page-size") ?? 1000);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error("Lote inválido (1 a 1000).");
  console.log(JSON.stringify({ filtro: "data da interação", fuso: "Europe/Lisbon", ...period, pageSize }));
  if (dryRun) return;
  if (options.has("--env-file")) {
    const loaded = dotenv.config({ path: path.resolve(root, options.get("--env-file")!), quiet: true });
    if (loaded.error) throw new Error("Não foi possível ler o ficheiro de configuração.");
  }
  dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
  dotenv.config({ path: path.join(root, ".env"), quiet: true });
  let reader: AgentExportReader;
  let driverReader: (cursor: string, limit: number) => Promise<BookingDriversRow[]>;
  if (options.has("--remote")) {
    const secret = process.env.AGENT_ACTIVITY_EXPORT_SECRET?.trim();
    if (!secret) throw new Error("Falta AGENT_ACTIVITY_EXPORT_SECRET.");
    const page = createRemoteExportPageReader(options.get("--remote")!, secret, period, "/api/exports/active-agents");
    reader = (stage, cursor, limit) => page<AgentExportRecord>(stage, cursor, limit);
    driverReader = (cursor, limit) => page<BookingDriversRow>("booking-drivers", cursor, limit);
  } else {
    const db = await getMultiparkDb();
    if (db.engine !== "postgres" || !await db.readOnlyCheck()) throw new Error("É necessária uma ligação PostgreSQL só de leitura.");
    reader = (stage, cursor, limit) => { const q = agentExportPage(stage, period, cursor, limit); return db.query<AgentExportRecord>(q.sql, q.params); };
    driverReader = (cursor, limit) => { const q = bookingDriversPage(period, cursor, limit); return db.query<BookingDriversRow>(q.sql, q.params); };
  }
  const output = await collectActiveAgents(reader, pageSize, (stage, count) => console.log(`${stage}: ${count}`));
  const bookingDrivers: BookingDriversRow[] = [];
  let cursor = "";
  while (true) {
    const rows = await driverReader(cursor, pageSize);
    if (!rows.length) break;
    const next = rows.at(-1)!.id;
    if (!next || next === cursor) throw new Error("O cursor dos condutores não avançou.");
    bookingDrivers.push(...rows); cursor = next;
    console.log(`booking-drivers: ${bookingDrivers.length}`);
    if (rows.length < pageSize) break;
  }
  const summary = {
    complete: true, completedAt: new Date().toISOString(), filters: period, timezone: "Europe/Lisbon",
    agents: output.agents.length, otherActors: output.otherActors.length,
    agentsWithoutEmail: output.agents.filter(r => !r.email).length,
    agentsWithMultipleEmails: output.agents.filter(r => r.estado_email === "VARIOS_EMAILS_REGISTADOS").length,
    agentsWithoutCity: output.agents.filter(r => !r.cidade).length,
    agentsWithMultipleObservedCities: output.agents.filter(r => r.cidades_com_interacao.includes(" | ")).length,
    sourceRows: output.counts, withoutActorId: output.withoutActorId, identityConflicts: output.identityConflicts,
    bookingDrivers: { bookingsCreatedInPeriod: bookingDrivers.length, withCheckOutDriver: bookingDrivers.filter(b => b.check_out_driver_id || b.check_out_driver_name).length,
      withCheckInDriver: bookingDrivers.filter(b => b.check_in_driver_id || b.check_in_driver_name).length,
      filter: "Booking.createdAt no mesmo período, para cruzar com a exportação de preços. Campos atuais da reserva; não provam a data da entrega." },
    scope: "Agentes identificados por Agent.userId/Agent.id, incluindo inativos e parceiros, com History.actionTime ou ActivityEvent.timestamp no período. Outros autores ficam num CSV separado.",
    limitations: "Não inclui consultas ou logins sem evento guardado, nem histórico apagado. Os dois históricos podem representar a mesma ação; as contagens de registos são separadas. Leitura paginada sem snapshot transacional único. Cidades são as dos parques dos eventos, não uma prova da localização física da pessoa.",
  };
  const parent = path.resolve(root, options.get("--out-dir") ?? "exports/active-agents");
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  for (const [name, rows] of [["agentes.csv", output.agents], ["outros-autores.csv", output.otherActors], ["agentes-sem-email.csv", output.agents.filter(r => !r.email)]] as const) {
    await fs.writeFile(path.join(dir, name + ".partial"), agentExportCsv(rows), { encoding: "utf8", flag: "wx" });
    await fs.rename(path.join(dir, name + ".partial"), path.join(dir, name));
  }
  await fs.writeFile(path.join(dir, "resumo.json.partial"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  const driverColumns = ["id", "reference", "city", "created_at", "check_in_driver_id", "check_in_driver_name", "check_out_driver_id", "check_out_driver_name"] as const;
  const driverCsv = "\uFEFF" + [driverColumns.map(csvCell).join(";"), ...bookingDrivers.map(row => driverColumns.map(key => csvCell(row[key])).join(";"))].join("\r\n") + "\r\n";
  await fs.writeFile(path.join(dir, "reservas-condutores.csv.partial"), driverCsv, { encoding: "utf8", flag: "wx" });
  await fs.rename(path.join(dir, "reservas-condutores.csv.partial"), path.join(dir, "reservas-condutores.csv"));
  await fs.rename(path.join(dir, "resumo.json.partial"), path.join(dir, "resumo.json"));
  console.log(JSON.stringify({ directory: dir, ...summary }));
}
main().catch(error => { console.error(redactSecrets(error)); process.exitCode = 1; }).finally(() => closeMultiparkDb());
