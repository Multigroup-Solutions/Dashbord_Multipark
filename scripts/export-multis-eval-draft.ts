/**
 * Eval do Multis (plano MPV §8.2, F8) — exporta o RASCUNHO do conjunto A: as
 * perguntas do "/multis/falhas" (marcadas sozinhas) e do 👎 dos últimos N
 * dias, ANONIMIZADAS (server/assistant/multisEvalDraft.ts), para um ficheiro
 * que o Jorge revê. Não exporta respostas nem quem perguntou (só o papel).
 * Nunca entram sozinhas no conjunto A: o Jorge completa a secção, a
 * ferramenta e os factos e passa as boas para server/fixtures/multisEval/conjuntoA/.
 *
 * SÓ LÊ a NOSSA base de dados (assistant_feedback, users, employees), numa
 * sessão só de leitura (SET SESSION TRANSACTION READ ONLY). Abre a sua
 * própria ligação (não passa por getDb() para não disparar o ensureRecentSchema).
 * Só se corre quando o Jorge o pede.
 *
 *   pnpm tsx scripts/export-multis-eval-draft.ts                 (90 dias)
 *   pnpm tsx scripts/export-multis-eval-draft.ts --days 30 --out server/fixtures/multisEval/rascunhoA/rascunho.json
 *
 * Lê DATABASE_URL do `.env` do dashboard (ou do ambiente).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { buildSetADraft, type FailedFeedbackRow } from "../server/assistant/multisEvalDraft";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("Falta o DATABASE_URL (no .env ou no ambiente)."); process.exit(2); }
  const days = Math.max(1, Math.min(365, Number(opt("--days") ?? 90) || 90));
  const out = path.resolve(opt("--out") ?? path.join(here, "..", "server", "fixtures", "multisEval", "rascunhoA", `rascunho-A-${new Date().toISOString().slice(0, 10)}.json`));
  const conn = await mysql.createConnection(url);
  try {
    // Só leitura: qualquer escrita nesta sessão falha.
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    const [rows] = await conn.query(
      `SELECT f.id, u.role, f.reason, f.comment, f.question, f.path, f.tools, f.helpFiles, f.auto, (f.resolvedAt IS NOT NULL) AS resolved,
              DATE_FORMAT(f.createdAt, '%Y-%m-%d %H:%i:%s') AS createdAt
         FROM assistant_feedback f LEFT JOIN users u ON u.id = f.userId
        WHERE f.createdAt >= ? AND f.rating = -1
        ORDER BY f.createdAt DESC LIMIT 2000`, [since]);
    const [people] = await conn.query(
      `SELECT name AS n FROM users WHERE name IS NOT NULL AND name <> ''
        UNION SELECT fullName AS n FROM employees WHERE fullName IS NOT NULL AND fullName <> ''`);
    const list = (rows as any[]).map((r): FailedFeedbackRow => ({
      id: Number(r.id), role: r.role ?? null, reason: r.reason ?? null, comment: r.comment ?? null, question: r.question ?? null,
      path: r.path ?? null, tools: r.tools ?? null, helpFiles: r.helpFiles ?? null, auto: Number(r.auto) === 1, resolved: Number(r.resolved) === 1, createdAt: r.createdAt ?? null,
    }));
    const draft = buildSetADraft(list, (people as any[]).map((p) => String(p.n)));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      nota: `RASCUNHO do conjunto A (${days} dias, ${list.length} linhas do 👎 e das falhas). Anonimizado. Rever cada pergunta, preencher seccaoEsperada, ferramentaEsperada, factos e gravações, e só depois passar para server/fixtures/multisEval/conjuntoA/.`,
      perguntas: draft.questions,
    }, null, 2) + "\n");
    console.log(`${draft.questions.length} perguntas de rascunho (${draft.skipped} sem texto) em ${out}`);
    console.log("Revê o ficheiro antes de o partilhar: a anonimização tapa contactos, matrículas, NIF/IBAN e os nomes da equipa, mas confirma.");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("Falhou:", String(err?.message ?? err));
  process.exit(2);
});
