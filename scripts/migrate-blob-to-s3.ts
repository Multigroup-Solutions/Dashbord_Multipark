/**
 * Migração dos ficheiros do Vercel Blob para o S3.
 *
 * ── PORQUÊ ──────────────────────────────────────────────────────────────────
 * Desde 2026-08-20 os uploads novos vão para o S3, mas os anteriores NUNCA
 * foram migrados: continuam no Vercel Blob, com a URL absoluta gravada na BD.
 * Em 2026-09-18 a store do Blob apareceu bloqueada (403 "Your store is
 * blocked"), tornando TODO o arquivo histórico inacessível de um momento para
 * o outro. Este script tira os ficheiros de lá e põe-nos no bucket, que é
 * nosso e não depende do plano do Vercel.
 *
 * ── PRÉ-REQUISITO QUE NÃO TEM VOLTA ─────────────────────────────────────────
 * A store TEM de estar desbloqueada. Um blob bloqueado responde 403 tanto ao
 * browser como a este script — não há como ler o conteúdo sem isso. O script
 * deteta o 403 e pára de imediato com a explicação, em vez de marcar centenas
 * de ficheiros como falhados.
 *
 * ── SEGURANÇA ───────────────────────────────────────────────────────────────
 * - **Simulação por omissão.** Sem `--apply` não escreve nada, nem no S3 nem
 *   na BD: lista o que faria.
 * - **Nunca apaga do Blob.** O original fica onde está; a BD é que passa a
 *   apontar para o S3. Se algo correr mal, reverter é repor a URL antiga.
 * - **Só toca em URLs do Blob.** Qualquer outra (S3, YouTube num
 *   `training_videos.videoUrl`, um link externo) é ignorada — o filtro é o
 *   host, não o formato.
 * - **Verifica antes de reescrever.** Só depois de o `storagePut` devolver a
 *   URL do S3 é que a linha é actualizada, e uma linha de cada vez: uma
 *   interrupção a meio deixa tudo consistente e o script retoma onde ficou.
 * - **Idempotente.** Correr duas vezes não duplica nada: as linhas já
 *   migradas deixam de ter uma URL do Blob e são saltadas.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────
 *   ./node_modules/.bin/tsx scripts/migrate-blob-to-s3.ts                  # simulação
 *   ./node_modules/.bin/tsx scripts/migrate-blob-to-s3.ts --apply          # a sério
 *   ./node_modules/.bin/tsx scripts/migrate-blob-to-s3.ts --table expenses # só uma tabela
 *   ./node_modules/.bin/tsx scripts/migrate-blob-to-s3.ts --limit 20 --apply
 *   ./node_modules/.bin/tsx scripts/migrate-blob-to-s3.ts --report mig.json
 *   ./node_modules/.bin/tsx scripts/migrate-blob-to-s3.ts --verify         # confirmar antes de esvaziar o Blob
 *
 * ── DEPOIS DA MIGRAÇÃO: ESVAZIAR A STORE ────────────────────────────────────
 * No Hobby o bloqueio levanta-se sozinho ao fim de 30 dias, mas volta a cair
 * se a store continuar acima do limite (1 GB). Migrar não baixa a utilização —
 * os originais continuam lá. Por isso, depois de `--verify` dar 100%, esvaziar
 * a store é o que impede isto de se repetir.
 *
 * O esvaziamento NÃO é feito aqui de propósito: apagar o único outro exemplar
 * dos ficheiros é irreversível e merece um passo humano deliberado, depois de
 * a verificação passar. Faz-se no dashboard do Vercel ou com
 * `vercel blob empty-store <store-id>`. `del()` no Blob é gratuito.
 *
 * Lê `DATABASE_URL` e as quatro `AWS_S3_*` do `.env`. Abre a sua própria pool
 * (não passa por `getDb()`, para não disparar o `ensureRecentSchema`).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
// O critério de "isto é um blob nosso" vive à parte, puro e testado
// (`shared/blobUrls.test.ts`) — é o que decide que URLs são reescritas.
import { BLOB_HOST_SUFFIX, isVercelBlobUrl, keyFromBlobUrl } from "../shared/blobUrls";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });

// ---------------------------------------------------------------------------
// Alvos
// ---------------------------------------------------------------------------

/**
 * Uma coluna de ficheiro a migrar.
 *
 * `keyColumn` é `null` nas tabelas que só guardam a URL (nunca houve key) —
 * nesse caso migra-se na mesma, só não há key para escrever.
 */
interface Target {
  table: string;
  /** Chave primária, para identificar a linha no UPDATE e no relatório. */
  idColumn: string;
  urlColumn: string;
  keyColumn: string | null;
}

/**
 * Todas as colunas que guardam um ficheiro, extraídas de `drizzle/schema.ts`.
 *
 * ⚠️ Ao acrescentar uma coluna de ficheiro ao schema, acrescenta-a aqui também
 * — senão fica de fora da migração sem ninguém dar por isso.
 *
 * Deliberadamente FORA: `ad_campaign_mappings.keyValue`, `api keys`,
 * `google_reviews.googleReviewKey` e afins — são chaves de negócio, não
 * ficheiros. `parks.geoJsonUrl` / `rawDataUrl` também não: apontam para dados
 * externos, nunca para o nosso storage.
 */
const TARGETS: readonly Target[] = [
  { table: "expenses", idColumn: "id", urlColumn: "invoiceImageUrl", keyColumn: "invoiceImageKey" },
  { table: "expense_payments", idColumn: "id", urlColumn: "proofUrl", keyColumn: "proofKey" },
  { table: "employee_documents", idColumn: "id", urlColumn: "fileUrl", keyColumn: "fileKey" },
  { table: "employees", idColumn: "id", urlColumn: "photoUrl", keyColumn: "photoKey" },
  { table: "invoices", idColumn: "id", urlColumn: "fileUrl", keyColumn: "fileKey" },
  { table: "marketing_expenses", idColumn: "id", urlColumn: "invoiceUrl", keyColumn: "invoiceKey" },
  { table: "complaint_photos", idColumn: "id", urlColumn: "url", keyColumn: "fileKey" },
  { table: "lost_found_items", idColumn: "id", urlColumn: "returnPhotoUrl", keyColumn: "returnPhotoKey" },
  { table: "lost_found_photos", idColumn: "id", urlColumn: "url", keyColumn: "fileKey" },
  { table: "time_records", idColumn: "id", urlColumn: "photoUrl", keyColumn: "photoKey" },
  { table: "training_manuals", idColumn: "id", urlColumn: "fileUrl", keyColumn: "fileKey" },
  { table: "whatsapp_messages", idColumn: "id", urlColumn: "mediaUrl", keyColumn: "mediaKey" },
  // Sem coluna de key — migra-se a URL na mesma.
  { table: "payslip_history", idColumn: "id", urlColumn: "url", keyColumn: null },
  { table: "pda_checkins", idColumn: "id", urlColumn: "photoEntryUrl", keyColumn: null },
  { table: "pda_checkins", idColumn: "id", urlColumn: "photoExitUrl", keyColumn: null },
  { table: "pdas", idColumn: "id", urlColumn: "photoUrl", keyColumn: null },
  { table: "radio_transcriptions", idColumn: "id", urlColumn: "audioUrl", keyColumn: null },
  { table: "training_videos", idColumn: "id", urlColumn: "videoUrl", keyColumn: null },
  { table: "training_videos", idColumn: "id", urlColumn: "thumbnailUrl", keyColumn: null },
];

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const verify = args.includes("--verify");
const tableIdx = args.indexOf("--table");
const onlyTable = tableIdx >= 0 ? args[tableIdx + 1] : null;
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const reportIdx = args.indexOf("--report");
const reportPath = reportIdx >= 0 ? path.resolve(args[reportIdx + 1] ?? "") : null;

const required = ["DATABASE_URL", "AWS_S3_REGION", "AWS_S3_BUCKET_NAME", "AWS_S3_ACCESS_KEY", "AWS_S3_SECRET_ACCESS_KEY"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Envs em falta no .env: ${missing.join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Blob
// ---------------------------------------------------------------------------

/** Erro que representa "a store está bloqueada" — aborta tudo. */
class StoreBlockedError extends Error {}

async function downloadBlob(url: string): Promise<{ body: Buffer; contentType: string }> {
  const res = await fetch(url);
  if (res.status === 403) {
    const text = await res.text().catch(() => "");
    throw new StoreBlockedError(text.trim() || "403 Forbidden");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    body: buf,
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

interface RowResult {
  table: string;
  column: string;
  id: number | string;
  key: string;
  bytes: number;
  status: "migrado" | "simulado" | "falhou";
  error?: string;
}

/**
 * Confirma que TODAS as linhas que já apontam para o S3 têm lá mesmo o ficheiro.
 *
 * É o passo que autoriza esvaziar a store do Blob: enquanto isto não der 100%,
 * apagar os originais destrói o único exemplar de alguma coisa. Lê através do
 * `storageGet`, cuja URL vazia significa "não existe" (usa `HeadObject`, que a
 * permissão `s3:GetObject` já cobre).
 */
async function runVerify(pool: mysql.Pool, storageGet: (k: string) => Promise<{ url: string }>): Promise<number> {
  const targets = onlyTable ? TARGETS.filter((t) => t.table === onlyTable) : TARGETS;
  let checked = 0, missing = 0, stillOnBlob = 0;

  for (const t of targets) {
    let rows: any[];
    try {
      const [r] = await pool.query(
        `SELECT \`${t.idColumn}\` AS id, \`${t.urlColumn}\` AS url FROM \`${t.table}\`
         WHERE \`${t.urlColumn}\` IS NOT NULL AND \`${t.urlColumn}\` <> '' ORDER BY \`${t.idColumn}\``,
      );
      rows = r as any[];
    } catch {
      continue; // tabela inexistente neste ambiente
    }

    for (const row of rows) {
      if (isVercelBlobUrl(row.url)) {
        stillOnBlob++;
        console.error(`  [por migrar] ${t.table}#${row.id}.${t.urlColumn}`);
        continue;
      }
      // Só interessam as que apontam para o nosso storage.
      if (!/^https?:\/\//i.test(row.url)) continue;
      let key: string;
      try {
        key = decodeURIComponent(new URL(row.url).pathname.replace(/^\/+/, ""));
      } catch {
        continue;
      }
      checked++;
      const got = await storageGet(key);
      if (!got.url) {
        missing++;
        console.error(`  [EM FALTA]   ${t.table}#${row.id}.${t.urlColumn}  ${key}`);
      }
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Verificadas: ${checked}   Em falta no S3: ${missing}   Ainda no Blob: ${stillOnBlob}`);
  if (missing === 0 && stillOnBlob === 0) {
    console.log("✓ Tudo no S3. Podes esvaziar a store do Blob em segurança.");
    return 0;
  }
  console.log("✗ NÃO esvazies a store do Blob — há ficheiros por migrar ou em falta.");
  return 1;
}

async function main() {
  const targets = onlyTable ? TARGETS.filter((t) => t.table === onlyTable) : TARGETS;
  if (!targets.length) {
    console.error(`Tabela desconhecida: ${onlyTable}. Conhecidas: ${[...new Set(TARGETS.map((t) => t.table))].join(", ")}`);
    process.exit(1);
  }

  // O storage.ts é importado DEPOIS do dotenv, para ler as envs já carregadas.
  const { storagePut, storageGet } = await import("../server/storage");
  const pool = mysql.createPool(process.env.DATABASE_URL!);

  if (verify) {
    console.log("VERIFICAÇÃO — confirma que o que a BD aponta está mesmo no S3\n");
    try {
      process.exit(await runVerify(pool, storageGet));
    } finally {
      await pool.end();
    }
  }

  console.log(apply ? "MODO REAL — escreve no S3 e na BD\n" : "SIMULAÇÃO — nada é escrito (usa --apply para migrar)\n");

  const results: RowResult[] = [];
  let migrated = 0, failed = 0, bytes = 0, blocked = false;

  try {
    for (const t of targets) {
      if (results.length >= limit) break;

      // A tabela pode não existir num ambiente mais antigo — não é motivo para
      // abortar a migração das outras.
      let rows: any[];
      try {
        const [r] = await pool.query(
          `SELECT \`${t.idColumn}\` AS id, \`${t.urlColumn}\` AS url FROM \`${t.table}\`
           WHERE \`${t.urlColumn}\` LIKE ? ORDER BY \`${t.idColumn}\``,
          [`%${BLOB_HOST_SUFFIX}%`],
        );
        rows = r as any[];
      } catch (err: any) {
        console.log(`  ${t.table}.${t.urlColumn}: ignorada (${String(err?.message ?? err).slice(0, 80)})`);
        continue;
      }

      // O LIKE é um pré-filtro barato feito na BD; o host é confirmado aqui.
      const pending = rows.filter((r) => isVercelBlobUrl(r.url));
      if (!pending.length) {
        console.log(`  ${t.table}.${t.urlColumn}: nada a migrar`);
        continue;
      }

      console.log(`\n${t.table}.${t.urlColumn} — ${pending.length} ficheiro(s)`);

      for (const row of pending) {
        if (results.length >= limit) break;
        const key = keyFromBlobUrl(row.url);

        try {
          const { body, contentType } = await downloadBlob(row.url);

          if (!apply) {
            results.push({ table: t.table, column: t.urlColumn, id: row.id, key, bytes: body.length, status: "simulado" });
            bytes += body.length;
            console.log(`  [sim] #${row.id}  ${key}  (${(body.length / 1024).toFixed(0)} KB)`);
            continue;
          }

          const put = await storagePut(key, body, contentType);

          // Só depois do upload confirmado é que a linha passa a apontar para
          // o S3 — e uma de cada vez, para uma interrupção não deixar nada a meio.
          const sets = [`\`${t.urlColumn}\` = ?`];
          const params: unknown[] = [put.url];
          if (t.keyColumn) {
            sets.push(`\`${t.keyColumn}\` = ?`);
            params.push(put.key);
          }
          params.push(row.id);
          await pool.query(`UPDATE \`${t.table}\` SET ${sets.join(", ")} WHERE \`${t.idColumn}\` = ?`, params);

          results.push({ table: t.table, column: t.urlColumn, id: row.id, key, bytes: body.length, status: "migrado" });
          migrated++;
          bytes += body.length;
          console.log(`  [ok]  #${row.id}  ${key}  (${(body.length / 1024).toFixed(0)} KB)`);
        } catch (err: any) {
          if (err instanceof StoreBlockedError) {
            blocked = true;
            console.error(`\n✗ A STORE DO BLOB ESTÁ BLOQUEADA — "${err.message}"`);
            console.error(`  Nenhum ficheiro pode ser lido enquanto assim estiver. Desbloqueia em`);
            console.error(`  Vercel → Storage → a store do Blob, e volta a correr. Nada foi perdido:`);
            console.error(`  as ${migrated} linha(s) já migradas ficam migradas e o resto é retomado.`);
            break;
          }
          failed++;
          results.push({ table: t.table, column: t.urlColumn, id: row.id, key, bytes: 0, status: "falhou", error: String(err?.message ?? err).slice(0, 200) });
          console.error(`  [erro] #${row.id}  ${key}  ${String(err?.message ?? err).slice(0, 120)}`);
        }
      }

      if (blocked) break;
    }
  } finally {
    await pool.end();
  }

  const simulated = results.filter((r) => r.status === "simulado").length;
  console.log(`\n${"─".repeat(60)}`);
  if (apply) console.log(`Migrados: ${migrated}   Falhados: ${failed}   Total: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  else console.log(`A migrar: ${simulated} ficheiro(s), ${(bytes / 1024 / 1024).toFixed(1)} MB. Usa --apply para migrar.`);
  if (failed) console.log(`⚠️  ${failed} falha(s) — voltar a correr retoma só essas.`);
  console.log("Os originais do Blob NÃO foram apagados.");

  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({ apply, migrated, failed, blocked, results }, null, 2), "utf8");
    console.log(`Relatório: ${reportPath}`);
  }

  process.exit(blocked || failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
