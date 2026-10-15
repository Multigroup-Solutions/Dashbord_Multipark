/**
 * Base de conhecimento — sincronização (SEM agenda desde 26 set 2026: botão
 * "Sincronizar agora" ou /api/cron/knowledge-sync à mão, 45 s por corrida;
 * cada carregamento é processado logo; as alterações nas pastas do Drive
 * chegam por notificação da Google — server/knowledge/driveChanges.ts) e
 * processamento de um documento.
 *
 *  1. Ajuda da app (docs/ajuda, no bundle) → documentos "help" (só muda com
 *     um deploy; checksum igual = nada a fazer).
 *  2. Pastas do Shared Drive configuradas (Definições da base de
 *     conhecimento): descoberta RETOMÁVEL (cursor em kb_sync_state: pasta ×
 *     página × subpastas por visitar) — ficheiro novo ou com modifiedTime/md5
 *     diferente fica "por processar"; no fim de uma volta completa, o que não
 *     apareceu é retirado (apagado no Drive).
 *  3. Processamento, até ao prazo: extrair o texto (Google Doc → exportar;
 *     PDF/DOCX → cópia convertida em Google Doc pelo Drive; sem Drive: DOCX
 *     lido localmente e PDF pela IA, nível lite), checksum (igual → não
 *     volta a partir nem a gerar vetores), trechos, vetores (se ligados; se a
 *     IA falhar fica sincronizado só com palavras-chave e completa depois).
 *
 * Nunca regista conteúdo (só ids, contagens e mensagens de erro curtas).
 */
import { GOOGLE_MIME } from "../../shared/drive";
import { KB_VISIBILITY_ALL, mostSpecificKbFolder, parseKnowledgeConfig, type KbFolder, type KnowledgeConfig } from "../../shared/knowledge";
import { chunkText, normalizeExtracted, textChecksum } from "./chunker";
import { docxToText } from "./docx";
import { isSupportedKbMime, type KbDriveApi } from "./drive";
import * as store from "./store";

export interface KbSyncReport {
  ok: boolean;
  done: boolean;
  drive: { configured: boolean; scanned: number; queued: number; removed: number; pass: "complete" | "partial" | "skipped" };
  /**
   * `sections`: secções da ajuda que mudaram (MPV; ausente com o interruptor desligado).
   * `sectionsEmbedded`: secções que ganharam vetores nesta corrida (MPV F5, quota própria).
   */
  help: { updated: number; sections?: number; sectionsEmbedded?: number };
  processed: number;
  failed: number;
  embedded: number;
  errors: string[];
}

export async function loadKnowledgeConfig(): Promise<KnowledgeConfig> {
  try {
    const { getSetting } = await import("../appSettings");
    return parseKnowledgeConfig(await getSetting("knowledge.config" as any));
  } catch { return parseKnowledgeConfig(null); }
}

const errText = (err: unknown) => String((err as any)?.message ?? err ?? "erro").replace(/\s+/g, " ").slice(0, 200);

// ─── Ajuda da app ────────────────────────────────────────────────────────────

export async function syncHelpDocs(d: store.Db, files: ReadonlyArray<{ file: string; raw: string }>): Promise<number> {
  const { parseHelpDoc } = await import("../_core/ai/chat/retrieval");
  let updated = 0;
  for (const f of files) {
    const doc = parseHelpDoc(f.file, f.raw);
    const key = `help:${f.file}`.slice(0, 128);
    const checksum = textChecksum(doc.body);
    const existing = store.rowsOf(await d.execute(
      (await import("drizzle-orm")).sql`SELECT id, checksum FROM kb_documents WHERE driveFileId = ${key} LIMIT 1`,
    ))[0];
    if (existing && String(existing.checksum ?? "") === checksum) continue;
    const id = existing ? Number(existing.id) : await store.insertDoc(d, {
      source: "help", title: `Ajuda: ${doc.title}`, driveFileId: key, mimeType: "text/markdown",
      webViewLink: doc.routes[0] ?? null, visibility: KB_VISIBILITY_ALL,
    });
    const chunks = chunkText(doc.body);
    await store.saveExtraction(d, id, { text: doc.body, checksum, chunks });
    await store.markStatus(d, id, "synced");
    updated++;
  }
  return updated;
}

/**
 * Plano MPV (F3, §3.2): as SECÇÕES da ajuda → um documento "help_sec" por
 * secção com a referência NOVA `help:<ficheiro>.md#<secção>` (o id da árvore).
 * As `help:<ficheiro>.md` de sempre ficam (o v1 depende de
 * `^help:(.+\.md)$`). Só as que mudaram (checksum) voltam a partir; uma
 * secção que deixou de existir fica marcada (`deletedAt`), nunca apagada, e
 * volta se reaparecer. Para quando o prazo aperta (continua na próxima).
 * Devolve quantas mudaram e quantas saíram.
 */
export async function syncHelpSections(
  d: store.Db, files: ReadonlyArray<{ file: string; raw: string }>, opts: { deadlineAt?: number; maxPerRun?: number } = {},
): Promise<{ updated: number; retired: number; done: boolean }> {
  const { sql } = await import("drizzle-orm");
  const { buildHelpTree, treePages } = await import("../../shared/helpTree");
  const pages = treePages(buildHelpTree(files));
  const max = Math.max(1, opts.maxPerRun ?? HELP_SECTIONS_PER_RUN);
  const existing = new Map<string, { id: number; checksum: string; deleted: boolean; title: string; link: string | null }>();
  for (const r of store.rowsOf(await d.execute(sql`SELECT id, driveFileId, checksum, deletedAt, title, webViewLink FROM kb_documents WHERE source = 'help_sec'`))) {
    existing.set(String(r.driveFileId), {
      id: Number(r.id), checksum: String(r.checksum ?? ""), deleted: r.deletedAt != null,
      title: String(r.title ?? ""), link: r.webViewLink != null ? String(r.webViewLink) : null,
    });
  }
  const live = new Set<string>();
  let updated = 0;
  let done = true;
  for (const page of pages) {
    for (const s of page.sections) {
      if (!s.text.trim()) continue; // só arrumação (a lista dos filhos sai da árvore)
      const key = `help:${s.id}`;
      if (key.length > 128) continue;
      live.add(key);
      const title = (s.level === 1 ? `Ajuda: ${page.title}` : `Ajuda: ${page.title} → ${s.title}`).slice(0, 300);
      const link = page.routes[0] ?? null;
      const text = `${title.replace(/^Ajuda: /, "")}\n\n${s.text}`;
      const checksum = textChecksum(text);
      const had = existing.get(key);
      // Título ou ligação mudaram (a página mudou de rota, por exemplo) → atualiza, mesmo com o texto igual.
      if (had && (had.title !== title || had.link !== link)) {
        await d.execute(sql`UPDATE kb_documents SET title = ${title}, webViewLink = ${link} WHERE id = ${had.id}`);
      }
      if (had && !had.deleted && had.checksum === checksum) continue;
      // Por corrida, no máx. `max` secções (a 1.ª sincronização são centenas: não come o prazo do Drive).
      if (updated >= max || (opts.deadlineAt != null && Date.now() > opts.deadlineAt - 15_000)) { done = false; continue; }
      const id = had ? had.id : await store.insertDoc(d, {
        source: "help_sec", title, driveFileId: key, mimeType: "text/markdown", webViewLink: link, visibility: KB_VISIBILITY_ALL,
      });
      if (had?.deleted) await d.execute(sql`UPDATE kb_documents SET deletedAt = NULL WHERE id = ${had.id}`);
      await store.saveExtraction(d, id, { text, checksum, chunks: chunkText(text) });
      await store.markStatus(d, id, "synced");
      updated++;
    }
  }
  let retired = 0;
  for (const [key, row] of existing) {
    if (live.has(key) || row.deleted) continue;
    await d.execute(sql`UPDATE kb_documents SET deletedAt = ${store.nowMysql()}, chunkCount = 0 WHERE id = ${row.id} AND deletedAt IS NULL`);
    retired++;
  }
  return { updated, retired, done };
}

/** Secções da ajuda sincronizadas por corrida, no máximo (o resto fica para as seguintes). */
export const HELP_SECTIONS_PER_RUN = 80;

/** As secções da ajuda vão para a base? (interruptor MPV — só o piloto as usa). Nunca lança. */
export async function helpSectionsWanted(): Promise<boolean> {
  try {
    const { ensureFeatureFlagOverrides, isFeatureEnabled } = await import("../_core/featureFlags");
    const { automationFlagDefault } = await import("../../shared/appSettings");
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled("MPV", { defaultEnabled: automationFlagDefault("MPV") });
  } catch {
    return false;
  }
}

// ─── Descoberta no Drive (retomável) ─────────────────────────────────────────

interface DiscoveryCursor {
  startedAt: string;
  folderIdx: number;
  /** Pastas por visitar da pasta configurada atual (id + caminho). */
  queue: Array<{ id: string; path: string }>;
  pageToken: string | null;
  failed: boolean;
}

const CURSOR_KEY = "drive:cursor";
const LAST_PASS_KEY = "drive:lastPass";
/** Uma volta completa às pastas do Drive, no máximo, a cada 50 min. */
const PASS_EVERY_MS = 50 * 60_000;
const MAX_DEPTH = 4;

export async function resolveFolder(api: Pick<KbDriveApi, "driveId" | "findFolder">, path: string): Promise<string | null> {
  let parent = api.driveId;
  for (const seg of path.split("/").map((x) => x.trim()).filter(Boolean)) {
    const id = await api.findFolder(seg, parent);
    if (!id) return null;
    parent = id;
  }
  return parent;
}

/** Guarda o que o Drive diz de um ficheiro; devolve true se ficou por processar. */
export async function upsertDriveFile(d: store.Db, f: { id: string; name: string; mimeType: string; modifiedTime: string | null; md5: string | null; size: number | null; webViewLink: string | null },
  folder: KbFolder, path: string, seenAt: string): Promise<boolean> {
  const { sql } = await import("drizzle-orm");
  const r = store.rowsOf(await d.execute(sql`SELECT id, modifiedTime, md5, status, visibilityCustom, deletedAt FROM kb_documents WHERE driveFileId = ${f.id} LIMIT 1`))[0];
  const title = f.name.replace(/\.(pdf|docx|txt|md)$/i, "").slice(0, 300) || "(sem título)";
  if (!r) {
    await store.insertDoc(d, {
      source: "drive", title, driveFileId: f.id, folderPath: path, mimeType: f.mimeType, webViewLink: f.webViewLink,
      sizeBytes: f.size, modifiedTime: f.modifiedTime, md5: f.md5, visibility: folder.visibility, seenAt,
    });
    return true;
  }
  // Voltou (estava fora do índice: apagado/movido e reposto) → processa de novo:
  // os trechos tinham sido apagados (18d: ficava "Sincronizado" sem trechos).
  const restored = r.deletedAt != null;
  const changed = restored || String(r.modifiedTime ?? "") !== String(f.modifiedTime ?? "") || String(r.md5 ?? "") !== String(f.md5 ?? "");
  const excluded = String(r.status) === "skipped";
  const custom = Number(r.visibilityCustom ?? 0) === 1;
  await d.execute(sql`UPDATE kb_documents SET title = ${title}, folderPath = ${path}, mimeType = ${f.mimeType}, webViewLink = ${f.webViewLink},
      sizeBytes = ${f.size}, modifiedTime = ${f.modifiedTime}, md5 = ${f.md5}, seenAt = ${seenAt}, deletedAt = NULL
      ${custom ? sql`` : sql`, visibilityRoles = ${JSON.stringify(folder.visibility.roles)}, visibilityCities = ${JSON.stringify(folder.visibility.cities)}`}
      ${changed && !excluded ? sql`, status = 'pending', attempts = 0, error = NULL${restored ? sql`, checksum = NULL` : sql``}` : sql``}
    WHERE id = ${Number(r.id)}`);
  return changed && !excluded;
}

/**
 * Aplica JÁ a visibilidade das pastas aos documentos do Drive que a seguem
 * (não personalizados) — 18d: antes só na volta seguinte às pastas, até 4 h
 * depois, e o assistente continuava a mostrar o que se tinha restringido.
 * Da pasta mais geral para a mais específica (a mais específica manda).
 */
export async function applyFolderVisibility(d: store.Db, folders: readonly KbFolder[]): Promise<number> {
  const { sql } = await import("drizzle-orm");
  const { foldersBySpecificity } = await import("../../shared/knowledge");
  let n = 0;
  for (const f of foldersBySpecificity(folders)) {
    const p = f.path.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!p) continue;
    const like = `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
    const res = await d.execute(sql`UPDATE kb_documents SET visibilityRoles = ${JSON.stringify(f.visibility.roles)}, visibilityCities = ${JSON.stringify(f.visibility.cities)}
      WHERE source = 'drive' AND visibilityCustom = 0 AND deletedAt IS NULL AND (LOWER(folderPath) = ${p} OR LOWER(folderPath) LIKE ${like})`);
    n += Number((Array.isArray(res) ? (res[0] as any) : (res as any))?.affectedRows ?? 0);
  }
  return n;
}

/**
 * Pede uma volta completa às pastas na próxima corrida (ex.: o Drive avisou
 * de um ficheiro novo numa pasta da base de conhecimento), mesmo que a última
 * tenha sido há menos de 50 min.
 */
export async function forceNextDiscovery(d: store.Db): Promise<void> {
  await store.setState(d, LAST_PASS_KEY, "0");
}

export async function discoverDrive(d: store.Db, api: KbDriveApi, folders: readonly KbFolder[], deadlineAt: number, report: KbSyncReport, now: Date = new Date()): Promise<void> {
  const { sql } = await import("drizzle-orm");
  const raw = await store.getState(d, CURSOR_KEY);
  let cur: DiscoveryCursor | null = null;
  try { cur = raw ? (JSON.parse(raw) as DiscoveryCursor) : null; } catch { cur = null; }
  if (!cur) {
    const last = Number(await store.getState(d, LAST_PASS_KEY)) || 0;
    if (now.getTime() - last < PASS_EVERY_MS) { report.drive.pass = "skipped"; return; }
    cur = { startedAt: store.nowMysql(now), folderIdx: 0, queue: [], pageToken: null, failed: false };
  }
  while (cur.folderIdx < folders.length) {
    if (Date.now() > deadlineAt - 6_000) { await store.setState(d, CURSOR_KEY, JSON.stringify(cur)); report.drive.pass = "partial"; report.done = false; return; }
    const folder = folders[cur.folderIdx];
    if (!cur.queue.length && !cur.pageToken) {
      const rootId = await resolveFolder(api, folder.path).catch((err) => { report.errors.push(`Pasta "${folder.path}": ${errText(err)}`); return null; });
      if (!rootId) {
        if (!report.errors.some((e) => e.includes(`"${folder.path}"`))) report.errors.push(`Pasta "${folder.path}" não encontrada no Shared Drive.`);
        cur.failed = true;
        cur.folderIdx++;
        continue;
      }
      cur.queue = [{ id: rootId, path: folder.path }];
    }
    const top = cur.queue[0];
    try {
      const page = await api.list(top.id, cur.pageToken);
      for (const f of page.files) {
        if (f.mimeType === GOOGLE_MIME.folder) {
          if (top.path.split("/").length - folder.path.split("/").length < MAX_DEPTH) cur.queue.push({ id: f.id, path: `${top.path}/${f.name}` });
          continue;
        }
        report.drive.scanned++;
        if (!isSupportedKbMime(f.mimeType)) continue;
        // A pasta configurada mais específica manda na visibilidade (18d).
        if (await upsertDriveFile(d, f, mostSpecificKbFolder(folders, top.path) ?? folder, top.path, cur.startedAt)) report.drive.queued++;
      }
      cur.pageToken = page.nextPageToken;
      if (!cur.pageToken) cur.queue.shift();
    } catch (err) {
      report.errors.push(`Pasta "${top.path}": ${errText(err)}`);
      cur.failed = true;
      cur.queue.shift();
      cur.pageToken = null;
    }
    if (!cur.queue.length && !cur.pageToken) cur.folderIdx++;
  }
  // Volta completa: o que não apareceu foi apagado/movido no Drive → sai do índice.
  // Com falhas (pasta em falta, erro da Google) não se retira nada (evita esvaziar o índice).
  if (!cur.failed) {
    const gone = store.rowsOf(await d.execute(sql`SELECT id FROM kb_documents WHERE source = 'drive' AND deletedAt IS NULL
      AND (seenAt IS NULL OR seenAt < ${cur.startedAt}) LIMIT 500`));
    for (const g of gone) {
      await d.execute(sql`DELETE FROM kb_chunks WHERE docId = ${Number(g.id)}`);
      await d.execute(sql`UPDATE kb_documents SET deletedAt = ${store.nowMysql()}, chunkCount = 0 WHERE id = ${Number(g.id)}`);
      report.drive.removed++;
    }
  }
  await store.setState(d, CURSOR_KEY, null);
  await store.setState(d, LAST_PASS_KEY, String(now.getTime()));
  report.drive.pass = "complete";
}

// ─── Extração de texto ───────────────────────────────────────────────────────

const PDF_EXTRACT_SYSTEM = [
  "Transcreves documentos internos de uma empresa (manuais e procedimentos).",
  "Devolve SÓ o texto do documento, pela ordem, em texto simples; títulos em linhas próprias começadas por \"# \".",
  "Não resumas, não traduzas, não acrescentes nada. Tabelas: uma linha por linha da tabela, células separadas por \" | \".",
].join("\n");

export interface ExtractDeps {
  drive: KbDriveApi | null;
  loadFile?: (keyOrUrl: string, fallbackUrl: string | null) => Promise<Buffer>;
  pdfWithAi?: (bytes: Buffer, title: string, timeoutMs: number) => Promise<string>;
}

/** Lê um ficheiro do armazenamento (também para o carregamento direto). */
export const loadStoredFile = (keyOrUrl: string, fallbackUrl: string | null): Promise<Buffer> => defaultLoadFile(keyOrUrl, fallbackUrl);

async function defaultLoadFile(keyOrUrl: string, fallbackUrl: string | null): Promise<Buffer> {
  const { storagePresignGet } = await import("../storage");
  const { url } = await storagePresignGet(keyOrUrl, { fallbackUrl });
  if (!url) throw new Error("Ficheiro não encontrado no armazenamento.");
  if (url.startsWith("/uploads/")) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    return fs.readFileSync(path.join(process.cwd(), "uploads", url.slice("/uploads/".length)));
  }
  const { fetchWithTimeout } = await import("../_core/fetchWithTimeout");
  const resp = await fetchWithTimeout(url, { timeoutMs: 15_000 });
  if (!resp.ok) throw new Error(`Armazenamento respondeu ${resp.status}.`);
  return Buffer.from(await resp.arrayBuffer());
}

async function defaultPdfWithAi(bytes: Buffer, title: string, timeoutMs: number): Promise<string> {
  if (bytes.length > 4 * 1024 * 1024) throw new Error("PDF demasiado grande para ler sem o Drive (máx. 4 MB).");
  const { runAi } = await import("../_core/ai/run");
  const r = await runAi({
    feature: "knowledge_extract",
    system: PDF_EXTRACT_SYSTEM,
    input: [{ type: "text", text: `Documento: "${title}". Transcreve o texto.` }, { type: "pdf", data: bytes.toString("base64") }],
    maxTokens: 16_000,
    timeoutMs,
    retries: 1,
    entity: "kb_document",
  });
  return String(r.output ?? "");
}

/** Texto de um documento (conforme a origem e o tipo). */
export async function extractText(doc: store.KbDocRow, deps: ExtractDeps, deadlineAt: number): Promise<string> {
  const mime = String(doc.mimeType ?? "");
  const load = deps.loadFile ?? defaultLoadFile;
  const pdfAi = deps.pdfWithAi ?? defaultPdfWithAi;
  const aiTimeout = () => Math.max(5_000, Math.min(45_000, deadlineAt - Date.now() - 3_000));
  if (doc.source === "drive") {
    if (!deps.drive || !doc.driveFileId) throw new Error("Shared Drive não configurado.");
    if (mime === GOOGLE_MIME.doc || mime === GOOGLE_MIME.slides) return deps.drive.exportText(doc.driveFileId);
    if (mime === "text/plain" || mime === "text/markdown") return (await deps.drive.download(doc.driveFileId)).toString("utf8");
    if (mime === GOOGLE_MIME.pdf || mime === GOOGLE_MIME.docx) {
      try {
        return await deps.drive.convertToText(doc.driveFileId, doc.title);
      } catch (err) {
        // Conversão recusada (ex.: PDF protegido): DOCX lido localmente, PDF pela IA.
        const bytes = await deps.drive.download(doc.driveFileId);
        if (mime === GOOGLE_MIME.docx) { const t = docxToText(bytes); if (t) return t; throw err; }
        return pdfAi(bytes, doc.title, aiTimeout());
      }
    }
    throw new Error("Tipo de ficheiro não suportado.");
  }
  if (doc.source === "upload") {
    if (!doc.fileKey && !doc.fileUrl) throw new Error("Ficheiro em falta.");
    const bytes = await load(doc.fileKey || doc.fileUrl!, doc.fileUrl);
    if (mime === "text/plain" || mime === "text/markdown") return bytes.toString("utf8");
    if (mime === GOOGLE_MIME.docx) {
      const t = docxToText(bytes);
      if (t) return t;
      if (deps.drive) return deps.drive.uploadAndConvert(bytes, mime, doc.title);
      throw new Error("Não foi possível ler o DOCX.");
    }
    if (mime === GOOGLE_MIME.pdf) {
      if (deps.drive) {
        try { return await deps.drive.uploadAndConvert(bytes, mime, doc.title); } catch { /* segue para a IA */ }
      }
      return pdfAi(bytes, doc.title, aiTimeout());
    }
    throw new Error("Tipo de ficheiro não suportado.");
  }
  throw new Error("Origem sem extração.");
}

// ─── Vetores ─────────────────────────────────────────────────────────────────

export type EmbedFn = (texts: string[]) => Promise<{ vectors: number[][]; model: string }>;

export async function defaultEmbed(texts: string[]): Promise<{ vectors: number[][]; model: string }> {
  const { embedTexts } = await import("../_core/ai/embed");
  const { redactPii } = await import("../_core/ai/pii");
  const r = await embedTexts({ feature: "knowledge_embed", texts: texts.map((t) => redactPii(t).text), taskType: "RETRIEVAL_DOCUMENT", timeoutMs: 25_000 });
  return { vectors: r.vectors, model: r.model };
}

/**
 * Plano MPV (F5): vetores das SECÇÕES da ajuda ("help_sec"), com o mesmo
 * modelo e o mesmo texto do resto da base (título — secção + trecho), em lote
 * (um pedido de embeddings para várias secções: o embedTexts parte em lotes de
 * 50). Quota PRÓPRIA por corrida (`maxPerRun` secções) e corre DEPOIS do Drive
 * (processamento e vetores em falta), por isso nunca lhe tira lugar. A 1.ª vez
 * são ≈ 430 secções e ≈ 120 mil tokens (≈ 0,02 €, ver docs/ia.md): umas 4 corridas.
 * Devolve quantas ficaram com vetores e se ficou alguma por fazer.
 */
export async function embedHelpSections(d: store.Db, embed: EmbedFn, opts: { deadlineAt: number; maxPerRun?: number }): Promise<{ embedded: number; done: boolean }> {
  const { encodeVector } = await import("../_core/ai/embed");
  const max = Math.max(1, opts.maxPerRun ?? HELP_SECTIONS_EMBED_PER_RUN);
  // Margem: o pedido de embeddings tem 25 s de prazo; sem tempo para ele, fica para a próxima.
  if (Date.now() > opts.deadlineAt - 12_000) return { embedded: 0, done: false };
  const ids = await store.unembeddedDocIds(d, max + 1, { helpSections: true });
  if (!ids.length) return { embedded: 0, done: true };
  const batch = ids.slice(0, max);
  const chunks = await store.chunksToEmbed(d, batch);
  try {
    const r = chunks.length ? await embed(chunks.map((c) => embedText(c.title, c.section, c.text))) : { vectors: [] as number[][], model: "" };
    for (const docId of batch) {
      const mine = chunks.map((c, i) => ({ c, i })).filter((x) => x.c.docId === docId);
      await store.saveEmbeddings(d, docId, mine.map((x) => ({ chunkId: x.c.id, vector: encodeVector(r.vectors[x.i] ?? []) })), r.model || "", { bumpVersion: false });
    }
    // Uma só mudança de versão por lote: as instâncias voltam a ler os vetores (≤ 60 s).
    await store.bumpVectorsVersion(d);
    return { embedded: batch.length, done: ids.length <= max };
  } catch (err) {
    console.warn(`[knowledge] vetores das secções da ajuda por gerar: ${String((err as any)?.code ?? (err as any)?.name ?? "erro")}`);
    return { embedded: 0, done: false };
  }
}

/** O texto que vai para os embeddings (o mesmo para todas as fontes). PURA. */
export const embedText = (title: string, section: string | null, text: string) => `${title}${section ? ` — ${section}` : ""}\n${text}`;

/** Secções da ajuda que ganham vetores por corrida, no máximo (MPV F5; quota à parte da do Drive). */
export const HELP_SECTIONS_EMBED_PER_RUN = 120;

/** Gera os vetores de um documento (os trechos que ainda não os têm). Devolve false se a IA falhou. */
export async function embedDoc(d: store.Db, docId: number, title: string, embed: EmbedFn = defaultEmbed): Promise<boolean> {
  const { encodeVector } = await import("../_core/ai/embed");
  const chunks = (await store.chunksOf(d, docId)).filter((c) => !c.hasEmbedding);
  if (!chunks.length) return true;
  try {
    const r = await embed(chunks.map((c) => embedText(title, c.section, c.text)));
    await store.saveEmbeddings(d, docId, chunks.map((c, i) => ({ chunkId: c.id, vector: encodeVector(r.vectors[i] ?? []) })), r.model);
    return true;
  } catch (err) {
    console.warn(`[knowledge] vetores do documento ${docId} por gerar: ${String((err as any)?.code ?? (err as any)?.name ?? "erro")}`);
    return false;
  }
}

// ─── Processar um documento ──────────────────────────────────────────────────

export interface ProcessDeps extends ExtractDeps {
  embed?: EmbedFn | null;
}

export async function processDoc(d: store.Db, id: number, deps: ProcessDeps, deadlineAt: number): Promise<{ status: "synced" | "error" | "unchanged"; embedded: boolean; error?: string }> {
  const doc = await store.getDoc(d, id);
  if (!doc) return { status: "error", embedded: false, error: "Documento não encontrado." };
  if (!(await store.claimForProcessing(d, id))) return { status: "error", embedded: false, error: "Já está a ser processado." };
  try {
    const text = normalizeExtracted(await extractText(doc, deps, deadlineAt));
    if (text.length < 20) throw new Error("Sem texto legível (documento vazio ou só imagens).");
    const checksum = textChecksum(text);
    let status: "synced" | "unchanged" = "synced";
    if (checksum === doc.checksum && doc.chunkCount > 0) status = "unchanged";
    else await store.saveExtraction(d, id, { text, checksum, chunks: chunkText(text) });
    await store.markStatus(d, id, "synced");
    let embedded = doc.embedded && status === "unchanged";
    if (deps.embed && !embedded && Date.now() < deadlineAt - 5_000) embedded = await embedDoc(d, id, doc.title, deps.embed);
    return { status, embedded };
  } catch (err) {
    const msg = errText(err);
    await store.markStatus(d, id, "error", msg).catch(() => undefined);
    return { status: "error", embedded: false, error: msg };
  }
}

/** Vetores ligados? (definição + IA disponível). */
export async function embeddingsWanted(cfg: KnowledgeConfig): Promise<boolean> {
  if (!cfg.embeddings) return false;
  try {
    const { aiFeatureAvailableFresh } = await import("../_core/ai/status");
    const { selectProvider } = await import("../_core/ai/client");
    return (await aiFeatureAvailableFresh("knowledge_embed")) && selectProvider(process.env, "knowledge_embed") === "gemini";
  } catch { return false; }
}

// ─── Corrida do cron ─────────────────────────────────────────────────────────

export async function runKnowledgeSync(opts: {
  deadlineAt: number; d?: store.Db; drive?: KbDriveApi | null; embed?: EmbedFn | null; helpFiles?: ReadonlyArray<{ file: string; raw: string }>; now?: Date;
  /** As secções da ajuda (MPV, "help_sec"). Omisso = o interruptor MPV. */
  helpSections?: boolean;
}): Promise<KbSyncReport> {
  const report: KbSyncReport = {
    ok: true, done: true, drive: { configured: false, scanned: 0, queued: 0, removed: 0, pass: "skipped" }, help: { updated: 0 },
    processed: 0, failed: 0, embedded: 0, errors: [],
  };
  try {
    const d = opts.d ?? (await store.kbDb());
    const cfg = await loadKnowledgeConfig();
    const helpFiles = opts.helpFiles ?? (await import("../assistant/helpDocs.generated")).HELP_FILES;
    report.help.updated = await syncHelpDocs(d, helpFiles).catch((err) => { report.errors.push(`Ajuda: ${errText(err)}`); return 0; });
    const sectionsOn = opts.helpSections ?? (await helpSectionsWanted());
    if (sectionsOn) {
      const r = await syncHelpSections(d, helpFiles, { deadlineAt: opts.deadlineAt }).catch((err) => { report.errors.push(`Ajuda (secções): ${errText(err)}`); return null; });
      if (r) {
        report.help.sections = r.updated;
        if (!r.done) report.done = false;
      }
    }

    let drive: KbDriveApi | null = opts.drive !== undefined ? opts.drive : null;
    if (opts.drive === undefined && cfg.driveEnabled) {
      drive = await kbDriveOrNull(opts.deadlineAt, report);
    }
    report.drive.configured = !!drive;
    if (drive && cfg.driveEnabled && cfg.folders.length) await discoverDrive(d, drive, cfg.folders, opts.deadlineAt, report, opts.now);

    const embed = opts.embed !== undefined ? opts.embed : (await embeddingsWanted(cfg)) ? defaultEmbed : null;
    // Presos que já esgotaram as tentativas → erro visível (18d).
    await store.failStuckProcessing(d).catch((err) => { report.errors.push(`Presos: ${errText(err)}`); });
    // Os que falham nesta corrida saem da volta (18d: antes o mesmo voltava a
    // ser pedido até ao fim do prazo e contava milhares de "com erro").
    const tried: number[] = [];
    while (Date.now() < opts.deadlineAt - 10_000) {
      const ids = await store.pendingDocIds(d, 3, opts.now, tried);
      if (!ids.length) break;
      for (const id of ids) {
        if (Date.now() > opts.deadlineAt - 10_000) { report.done = false; break; }
        tried.push(id);
        const r = await processDoc(d, id, { drive, embed }, opts.deadlineAt);
        if (r.status === "error") { report.failed++; report.errors.push(`Documento ${id}: ${r.error}`); } else report.processed++;
        if (r.embedded) report.embedded++;
      }
    }
    if ((await store.pendingDocIds(d, 1, opts.now, tried)).length) report.done = false;
    // Completar vetores de documentos já sincronizados (ex.: IA ligada depois).
    if (embed) {
      for (const id of await store.unembeddedDocIds(d, 3)) {
        if (Date.now() > opts.deadlineAt - 8_000) { report.done = false; break; }
        const doc = await store.getDoc(d, id);
        if (doc && (await embedDoc(d, id, doc.title, embed))) report.embedded++;
        else break; // orçamento/IA em baixo: tenta na próxima corrida
      }
      // Plano MPV (F5): vetores das secções da ajuda — DEPOIS do Drive e com quota própria.
      if (sectionsOn) {
        const r = await embedHelpSections(d, embed, { deadlineAt: opts.deadlineAt }).catch((err) => { report.errors.push(`Ajuda (vetores das secções): ${errText(err)}`); return null; });
        if (r) {
          report.help.sectionsEmbedded = r.embedded;
          if (!r.done) report.done = false;
        }
      }
    }
  } catch (err) {
    report.errors.push(errText(err));
    report.ok = false;
  }
  // Erros de documentos/pastas isolados não fazem o cron falhar: ficam na
  // página da base de conhecimento (estado de cada documento e última corrida).
  try {
    const d = opts.d ?? (await store.kbDb());
    await store.setState(d, "lastRun", JSON.stringify({
      at: new Date().toISOString(), ok: report.ok, done: report.done, processed: report.processed, failed: report.failed,
      queued: report.drive.queued, removed: report.drive.removed, pass: report.drive.pass, errors: report.errors.slice(0, 8),
    }));
  } catch { /* estado da última corrida é só informativo */ }
  return report;
}

async function kbDriveOrNull(deadlineAt: number, report: KbSyncReport): Promise<KbDriveApi | null> {
  try {
    const { kbDriveApi } = await import("./drive");
    return await kbDriveApi(deadlineAt);
  } catch (err) {
    report.errors.push(`Drive: ${errText(err)}`);
    return null;
  }
}
