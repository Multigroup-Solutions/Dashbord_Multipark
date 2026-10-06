/**
 * P3 lote 34a — Rádio: provas (regras em shared/radioEvidence.ts).
 *
 * Guardar: o browser só diz QUAIS mensagens (id, hora, remetente); o servidor
 * volta a lê-las no Zello e cruza outra vez com o GPS e a Multipark (nada do
 * que fica gravado vem do browser), grava a fotografia com o selo (sha256) e
 * tenta juntar o áudio do Zello ao nosso armazenamento. Uma mensagem só tem
 * uma prova ativa. Não se edita nem se apaga: arquiva-se com motivo.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import {
  cleanEvidenceInput, evidenceSealInput, evidenceSnapshotOf, EVIDENCE_MAX_PER_SAVE,
  type EvidenceAction, type EvidenceInput, type EvidencePosition, type EvidenceRecord, type EvidenceSnapshot,
} from "../shared/radioEvidence";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const mysqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const toMs = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(`${String(v).replace(" ", "T")}Z`));
/** Janela à volta da mensagem para a voltar a encontrar no Zello. */
const FIND_WINDOW_MS = 30_000;
/** Áudio até 15 MB (uma mensagem de rádio tem poucos segundos). */
const AUDIO_MAX_BYTES = 15 * 1024 * 1024;

async function db() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}

export const sealOf = (s: EvidenceSnapshot, meta: Parameters<typeof evidenceSealInput>[1]) =>
  crypto.createHash("sha256").update(evidenceSealInput(s, meta)).digest("hex");

export interface EvidencePick { id: number; at: number; sender: string }
export interface SaveEvidenceResult {
  saved: Array<{ messageId: number; id: number; audio: "saved" | "pending" | "none" | "failed" }>;
  already: Array<{ messageId: number; id: number }>;
  failed: Array<{ messageId: number; reason: string }>;
}

/** Ids de provas ativas por mensagem do Zello (para o "Prova #N" na pesquisa). */
export async function activeEvidenceByMessage(messageIds: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!messageIds.length) return out;
  try {
    const d = await db();
    const list = sql.join(messageIds.map((x) => sql`${x}`), sql`, `);
    for (const r of rowsOf(await d.execute(sql`SELECT id, zelloMessageId FROM radio_evidence WHERE zelloMessageId IN (${list}) AND archivedAt IS NULL ORDER BY id`))) {
      if (!out.has(Number(r.zelloMessageId))) out.set(Number(r.zelloMessageId), Number(r.id));
    }
  } catch { /* tabela por criar: sem provas */ }
  return out;
}

/** Guarda as mensagens escolhidas como prova (máx. 10 de cada vez). */
export async function saveRadioEvidence(o: {
  picks: readonly EvidencePick[]; input: EvidenceInput; userId: number; scopeProjectIds?: number[] | undefined; deadlineAt?: number;
}): Promise<SaveEvidenceResult> {
  const clean = cleanEvidenceInput(o.input);
  if ("error" in clean) throw new Error(clean.error);
  const picks = [...new Map(o.picks.map((p) => [p.id, p])).values()];
  if (!picks.length) throw new Error("Escolhe pelo menos uma mensagem.");
  if (picks.length > EVIDENCE_MAX_PER_SAVE) throw new Error(`No máximo ${EVIDENCE_MAX_PER_SAVE} mensagens de cada vez.`);
  const deadlineAt = o.deadlineAt ?? Date.now() + 45_000;
  const d = await db();
  const out: SaveEvidenceResult = { saved: [], already: [], failed: [] };
  const existing = await activeEvidenceByMessage(picks.map((p) => p.id));
  const { searchZelloRadio } = await import("./radioZello");
  for (const p of picks) {
    const prev = existing.get(p.id);
    if (prev) { out.already.push({ messageId: p.id, id: prev }); continue; }
    if (Date.now() > deadlineAt) { out.failed.push({ messageId: p.id, reason: "Sem tempo nesta volta — guarda esta outra vez." }); continue; }
    try {
      // Volta a ler no Zello: o que fica gravado nunca vem do browser
      const r = await searchZelloRadio({ fromMs: p.at - FIND_WINDOW_MS, toMs: p.at + FIND_WINDOW_MS, user: p.sender, scopeProjectIds: o.scopeProjectIds });
      if (!r.available) { out.failed.push({ messageId: p.id, reason: r.reason }); continue; }
      const m = r.messages.find((x) => x.id === p.id);
      if (!m) { out.failed.push({ messageId: p.id, reason: "Não a encontrei no Zello (ou é de outra cidade)." }); continue; }
      const snap = evidenceSnapshotOf(m);
      const savedAtIso = new Date().toISOString().slice(0, 19) + "Z";
      const contentHash = sealOf(snap, { ...clean, savedById: o.userId, savedAtIso });
      const res = await d.execute(sql`INSERT INTO radio_evidence (zelloMessageId, messageAt, sender, senderName, recipient, recipientType, durationS,
          employeeId, personName, personVia, projectId, transcription, transcriptionSource, transcriptionInaccurate, summary,
          positionJson, actionsJson, mediaKey, situation, reference, notes, contentHash, savedById, savedAt)
        VALUES (${snap.zelloMessageId}, ${mysqlTs(snap.at)}, ${snap.sender.slice(0, 128)}, ${snap.senderName?.slice(0, 200) ?? null}, ${snap.recipient?.slice(0, 128) ?? null},
          ${snap.recipientType?.slice(0, 20) ?? null}, ${snap.durationS}, ${snap.employeeId}, ${snap.personName?.slice(0, 200) ?? null}, ${snap.personVia},
          ${snap.projectId}, ${snap.transcription}, ${snap.transcriptionSource}, ${snap.transcriptionInaccurate ? 1 : 0}, ${snap.summary},
          ${snap.position ? JSON.stringify(snap.position) : null}, ${JSON.stringify(snap.actions)}, ${snap.mediaKey?.slice(0, 200) ?? null},
          ${clean.situation}, ${clean.reference}, ${clean.notes}, ${contentHash}, ${o.userId}, ${savedAtIso.slice(0, 19).replace("T", " ")})`);
      const id = Number((Array.isArray(res) ? res[0] : res as any)?.insertId);
      let audio: SaveEvidenceResult["saved"][number]["audio"] = "none";
      if (snap.mediaKey && Date.now() < deadlineAt - 8_000) {
        try { audio = (await attachEvidenceAudio(id)).status === "saved" ? "saved" : "pending"; }
        catch { audio = "failed"; }
      }
      out.saved.push({ messageId: p.id, id, audio });
    } catch (err) {
      out.failed.push({ messageId: p.id, reason: String((err as Error)?.message ?? err).slice(0, 200) });
    }
  }
  return out;
}

/**
 * Junta o áudio do Zello à prova (nosso armazenamento, prefixo radio/ — só
 * quem tem o módulo Rádio o abre). O Zello pode estar ainda a converter:
 * "pending" e tenta-se outra vez. O motivo de falhar fica na prova.
 */
export async function attachEvidenceAudio(id: number): Promise<{ status: "saved" | "already" | "pending"; progress?: number | null }> {
  const d = await db();
  const row = rowsOf(await d.execute(sql`SELECT id, zelloMessageId, mediaKey, audioKey FROM radio_evidence WHERE id = ${id} LIMIT 1`))[0];
  if (!row) throw new Error("Prova não encontrada.");
  if (row.audioKey) return { status: "already" };
  if (!row.mediaKey) throw new Error("Esta mensagem não tem áudio no Zello.");
  const note = async (msg: string | null) => { await d.execute(sql`UPDATE radio_evidence SET audioNote = ${msg?.slice(0, 255) ?? null} WHERE id = ${id}`); };
  try {
    const { getZelloMedia } = await import("./zello");
    const media = await getZelloMedia(String(row.mediaKey));
    if (!media.ready || !media.url) {
      await note(`O Zello ainda estava a preparar o áudio${media.progress != null ? ` (${media.progress}%)` : ""} — tenta "Juntar o áudio" outra vez.`);
      return { status: "pending", progress: media.progress };
    }
    const host = new URL(media.url).hostname;
    if (!/(^|\.)zellowork\.com$/.test(host)) throw new Error("O áudio não veio do Zello.");
    const { fetchWithTimeout } = await import("./_core/fetchWithTimeout");
    const res = await fetchWithTimeout(media.url, { timeoutMs: 20_000 });
    if (!res.ok) throw new Error(`O Zello não deu o ficheiro (erro ${res.status}).`);
    const type = (res.headers.get("content-type") || "audio/mpeg").split(";")[0].trim();
    if (!/^audio\//.test(type) && type !== "application/octet-stream") throw new Error("O Zello não devolveu um áudio.");
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("O áudio veio vazio.");
    if (buf.length > AUDIO_MAX_BYTES) throw new Error("O áudio é grande demais.");
    const { storagePut } = await import("./storage");
    const ext = type === "audio/ogg" ? "ogg" : type === "audio/wav" || type === "audio/x-wav" ? "wav" : "mp3";
    const stored = await storagePut(`radio/evidence/${id}-${row.zelloMessageId}.${ext}`, buf, /^audio\//.test(type) ? type : "audio/mpeg");
    await d.execute(sql`UPDATE radio_evidence SET audioKey = ${stored.key}, audioUrl = ${stored.url}, audioSavedAt = UTC_TIMESTAMP(), audioNote = NULL
      WHERE id = ${id} AND audioKey IS NULL`);
    return { status: "saved" };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).replace(/sid=[^&\s]+/g, "sid=…");
    await note(`Áudio não guardado: ${msg}`.slice(0, 255)).catch(() => {});
    throw new Error(msg.slice(0, 200));
  }
}

const parseJson = <T>(v: unknown, fallback: T): T => { try { return v == null ? fallback : JSON.parse(String(v)) as T; } catch { return fallback; } };

function recordOf(r: any): EvidenceRecord & { audioKey: string | null; audioUrl: string | null } {
  return {
    id: Number(r.id), zelloMessageId: Number(r.zelloMessageId), at: toMs(r.messageAt), sender: String(r.sender),
    senderName: r.senderName ?? null, recipient: r.recipient ?? null, recipientType: r.recipientType ?? null,
    durationS: r.durationS == null ? null : Number(r.durationS),
    employeeId: r.employeeId == null ? null : Number(r.employeeId), personName: r.personName ?? null,
    personVia: r.personVia === "pda" || r.personVia === "ficha" ? r.personVia : null,
    projectId: r.projectId == null ? null : Number(r.projectId),
    transcription: r.transcription ?? null, transcriptionSource: r.transcriptionSource === "zello" || r.transcriptionSource === "ia" ? r.transcriptionSource : null,
    transcriptionInaccurate: Number(r.transcriptionInaccurate) === 1, summary: r.summary ?? null,
    position: parseJson<EvidencePosition | null>(r.positionJson, null), actions: parseJson<EvidenceAction[]>(r.actionsJson, []),
    mediaKey: r.mediaKey ?? null,
    situation: String(r.situation), reference: r.reference ?? null, notes: r.notes ?? null,
    savedByName: r.savedByName ?? null, savedAt: String(r.savedAt instanceof Date ? r.savedAt.toISOString().slice(0, 19).replace("T", " ") : r.savedAt),
    contentHash: String(r.contentHash), hasAudio: !!r.audioKey, audioNote: r.audioNote ?? null,
    archivedAt: r.archivedAt == null ? null : String(r.archivedAt instanceof Date ? r.archivedAt.toISOString().slice(0, 19).replace("T", " ") : r.archivedAt),
    archiveReason: r.archiveReason ?? null, audioKey: r.audioKey ?? null, audioUrl: r.audioUrl ?? null,
  };
}

/** Âmbito de cidade: quem só vê umas cidades só vê provas de pessoas dessas cidades. PURA. */
export function evidenceScopeSql(scope: number[] | undefined) {
  if (scope === undefined) return sql`1 = 1`;
  return scope.length ? sql`e.projectId IN (${sql.join(scope.map((x) => sql`${x}`), sql`, `)})` : sql`1 = 0`;
}

export async function listRadioEvidence(o: { q?: string | null; includeArchived?: boolean; beforeId?: number | null; limit?: number; scopeProjectIds?: number[] | undefined }) {
  const d = await db();
  const limit = Math.min(Math.max(o.limit ?? 30, 1), 100);
  const conds = [evidenceScopeSql(o.scopeProjectIds)];
  if (!o.includeArchived) conds.push(sql`e.archivedAt IS NULL`);
  if (o.beforeId) conds.push(sql`e.id < ${o.beforeId}`);
  const q = (o.q ?? "").trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(e.situation LIKE ${like} OR e.reference LIKE ${like} OR e.personName LIKE ${like} OR e.sender LIKE ${like} OR e.transcription LIKE ${like} OR e.notes LIKE ${like})`);
  }
  const rows = rowsOf(await d.execute(sql`SELECT e.*, u.name AS savedByName FROM radio_evidence e LEFT JOIN users u ON u.id = e.savedById
    WHERE ${sql.join(conds, sql` AND `)} ORDER BY e.id DESC LIMIT ${limit + 1}`));
  const items = rows.slice(0, limit).map(recordOf).map(({ audioKey: _k, audioUrl: _u, ...rest }) => rest);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
}

/** Uma prova (com o âmbito de cidade) — para o áudio e o arquivo. */
export async function getRadioEvidence(id: number, scopeProjectIds: number[] | undefined) {
  const d = await db();
  const r = rowsOf(await d.execute(sql`SELECT e.*, u.name AS savedByName FROM radio_evidence e LEFT JOIN users u ON u.id = e.savedById
    WHERE e.id = ${id} AND ${evidenceScopeSql(scopeProjectIds)} LIMIT 1`))[0];
  return r ? recordOf(r) : null;
}

export async function archiveRadioEvidence(id: number, userId: number, reason: string) {
  const why = reason.replace(/\s+/g, " ").trim();
  if (why.length < 3) throw new Error("Diz porque arquivas esta prova.");
  const d = await db();
  const res = await d.execute(sql`UPDATE radio_evidence SET archivedAt = UTC_TIMESTAMP(), archivedById = ${userId}, archiveReason = ${why.slice(0, 255)}
    WHERE id = ${id} AND archivedAt IS NULL`);
  const n = Number((Array.isArray(res) ? res[0] : res as any)?.affectedRows ?? 0);
  if (!n) throw new Error("Esta prova já estava arquivada (ou não existe).");
}
