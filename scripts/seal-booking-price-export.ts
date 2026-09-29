import fs from "node:fs/promises";
import path from "node:path";
import { sealPriceExport } from "../server/multiparkDb/priceExportEnvelope";

const parent = process.argv[2];
const output = process.argv[3];
if (!parent || !output || !process.env.EXPORT_RECIPIENT_PUBLIC_KEY) throw new Error("Faltam a pasta, o destino cifrado ou a chave pública do destinatário.");
const dirs = (await fs.readdir(parent, { withFileTypes: true })).filter(d => d.isDirectory());
if (dirs.length !== 1) throw new Error("A pasta tem de conter exatamente uma execução.");
const dir = path.join(parent, dirs[0].name);
const files = { csv: await fs.readFile(path.join(dir, "reservas.csv"), "utf8"), summary: JSON.parse(await fs.readFile(path.join(dir, "resumo.json"), "utf8")) };
const envelope = sealPriceExport(files, process.env.EXPORT_RECIPIENT_PUBLIC_KEY);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(envelope), { flag: "wx" });
console.log("Exportação cifrada para o destinatário. O CSV não será publicado como artefacto.");
