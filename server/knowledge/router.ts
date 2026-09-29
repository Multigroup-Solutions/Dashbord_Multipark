/**
 * tRPC `knowledge.*` — Base de conhecimento (Formação → Base de conhecimento).
 *
 *  - Gerir (lista, estado, carregar, visibilidade, voltar a sincronizar,
 *    excluir/apagar, definições, perguntas de quiz): quem tem Formação
 *    "manage" (admin / super_admin pela matriz);
 *  - `open`: qualquer pessoa, SÓ para documentos que pode ver (papel +
 *    cidades) — devolve a ligação do Drive ou uma ligação temporária ao ficheiro.
 *
 * Nunca regista o texto dos documentos (só ids e títulos na auditoria).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess, withOverrides } from "../_core/access";
import { cityScope } from "../cityScope";
import {
  KB_MAX_UPLOAD_BYTES, KB_SOURCES, KB_STATUSES, KB_UPLOAD_MIME, canSeeKbDoc, knowledgeConfigSchema, kbVisibilitySchema, parseKnowledgeConfig,
  safeCitationHref,
} from "../../shared/knowledge";
import { kbViewerFrom } from "./retrieve";
import * as store from "./store";

type CtxUser = { id: number; role: string; name?: string | null };

const manage = (u: CtxUser) => requireAccess(u, "formacao", "manage");
const log = async (userId: number, action: string, entityId: number | null, details: string) => {
  try {
    const { logActivity } = await import("../db");
    await logActivity({ userId, action, entity: "kb_document", entityId, details: details.slice(0, 300) } as any);
  } catch { /* auditoria nunca parte o pedido */ }
};

const MIME_BY_EXT: Record<string, string> = { pdf: KB_UPLOAD_MIME.pdf, docx: KB_UPLOAD_MIME.docx, txt: KB_UPLOAD_MIME.txt, md: KB_UPLOAD_MIME.md };

/** Tipo aceite pelo nome e pelo tipo declarado (nunca só pelo que o browser diz). PURA. */
export function uploadMimeFor(fileName: string, declared: string): string | null {
  const ext = String(fileName).toLowerCase().split(".").pop() ?? "";
  const byExt = MIME_BY_EXT[ext];
  if (!byExt) return null;
  const d = String(declared ?? "").toLowerCase();
  if (d && d !== "application/octet-stream" && d !== byExt && !(byExt.startsWith("text/") && d.startsWith("text/"))) return null;
  return byExt;
}

/** Processa já um documento (≤ 40 s), com o Drive se houver. */
async function processNow(id: number): Promise<{ status: string; error?: string }> {
  const d = await store.kbDb();
  const { processDoc, embeddingsWanted, loadKnowledgeConfig, defaultEmbed } = await import("./sync");
  const deadlineAt = Date.now() + 40_000;
  let drive = null;
  try { drive = await (await import("./drive")).kbDriveApi(deadlineAt); } catch { drive = null; }
  const cfg = await loadKnowledgeConfig();
  const r = await processDoc(d, id, { drive, embed: (await embeddingsWanted(cfg)) ? defaultEmbed : null }, deadlineAt);
  return { status: r.status, error: r.error };
}

export const knowledgeRouter = router({
  /** Estado geral: definições, Drive, contagens, última corrida, IA. */
  status: protectedProcedure.query(async ({ ctx }) => {
    manage(ctx.user);
    const d = await store.kbDb();
    const { loadKnowledgeConfig, embeddingsWanted } = await import("./sync");
    const cfg = await loadKnowledgeConfig();
    const { loadDriveConfig } = await import("../google/driveService");
    const { dwdConfigured } = await import("../google/workspace");
    const drive = await loadDriveConfig();
    let lastRun: unknown = null;
    try { lastRun = JSON.parse((await store.getState(d, "lastRun")) ?? "null"); } catch { lastRun = null; }
    return {
      config: cfg,
      drive: { sharedEnabled: drive.sharedEnabled, sharedDriveName: drive.sharedDriveName, ownerEmail: drive.ownerEmail, delegation: dwdConfigured() },
      counts: await store.statusCounts(d).catch(() => ({})),
      embeddingsActive: await embeddingsWanted(cfg),
      lastRun,
    };
  }),

  list: protectedProcedure
    .input(z.object({ q: z.string().max(100).optional(), status: z.enum(KB_STATUSES).optional(), source: z.enum(KB_SOURCES).optional() }).optional())
    .query(async ({ ctx, input }) => {
      manage(ctx.user);
      return store.listDocs(await store.kbDb(), { q: input?.q, status: input?.status ?? null, source: input?.source ?? null });
    }),

  /** Pré-visualização do texto extraído (primeiros 20 000 caracteres) + trechos. */
  get: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
    manage(ctx.user);
    const d = await store.kbDb();
    const doc = await store.getDoc(d, input.id, { withText: true });
    if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." });
    const chunks = await store.chunksOf(d, input.id);
    return {
      ...doc,
      textContent: doc.textContent ? doc.textContent.slice(0, 20_000) : null,
      textTruncated: (doc.textContent?.length ?? 0) > 20_000,
      chunks: chunks.slice(0, 50).map((c) => ({ ord: c.ord, section: c.section, chars: c.text.length, embedded: c.hasEmbedding })),
    };
  }),

  saveConfig: protectedProcedure.input(knowledgeConfigSchema).mutation(async ({ ctx, input }) => {
    manage(ctx.user);
    const { setSetting } = await import("../appSettings");
    try {
      const r = await setSetting("knowledge.config", input, ctx.user.id);
      return { changed: r.changed, config: parseKnowledgeConfig(r.value) };
    } catch (err: any) {
      throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? "Definições inválidas.") });
    }
  }),

  upload: protectedProcedure
    .input(z.object({
      fileName: z.string().trim().min(1).max(255),
      fileBase64: z.string().min(1),
      mimeType: z.string().max(160).default(""),
      title: z.string().trim().max(300).optional(),
      visibility: kbVisibilitySchema.default({ roles: [], cities: [] }),
    }))
    .mutation(async ({ ctx, input }) => {
      manage(ctx.user);
      const mime = uploadMimeFor(input.fileName, input.mimeType);
      if (!mime) throw new TRPCError({ code: "BAD_REQUEST", message: "Tipo de ficheiro não suportado (PDF, DOCX, TXT ou MD)." });
      const buffer = Buffer.from(input.fileBase64, "base64");
      if (!buffer.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Ficheiro vazio." });
      if (buffer.length > KB_MAX_UPLOAD_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Ficheiro demasiado grande (máx. 4 MB)." });
      const { storagePut } = await import("../storage");
      const safe = input.fileName.replace(/[^\w.\-]+/g, "_").slice(-120);
      const { key, url } = await storagePut(`knowledge/${Date.now()}-${safe}`, buffer, mime);
      const d = await store.kbDb();
      const title = (input.title?.trim() || input.fileName.replace(/\.[a-z0-9]+$/i, "")).slice(0, 300);
      const id = await store.insertDoc(d, {
        source: "upload", title, mimeType: mime, fileKey: key, fileUrl: url, sizeBytes: buffer.length,
        visibility: input.visibility, visibilityCustom: true, createdById: ctx.user.id,
      });
      await log(ctx.user.id, "create", id, `Base de conhecimento: carregado "${title}"`);
      const r = await processNow(id).catch((err) => ({ status: "error", error: String(err?.message ?? err).slice(0, 200) }));
      return { id, status: r.status, error: r.error ?? null };
    }),

  updateVisibility: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), visibility: kbVisibilitySchema, followFolder: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      manage(ctx.user);
      const d = await store.kbDb();
      const doc = await store.getDoc(d, input.id);
      if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." });
      // "Seguir a pasta" (Drive): a próxima sincronização volta a aplicar a visibilidade da pasta.
      await store.setVisibility(d, input.id, input.visibility, !(input.followFolder && doc.source === "drive"));
      await log(ctx.user.id, "update", input.id, `Base de conhecimento: visibilidade de "${doc.title}"`);
      return { success: true };
    }),

  resync: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    manage(ctx.user);
    const d = await store.kbDb();
    const doc = await store.getDoc(d, input.id);
    if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." });
    if (doc.source === "help") throw new TRPCError({ code: "BAD_REQUEST", message: "A ajuda da app atualiza-se sozinha com cada versão." });
    // Força nova extração (checksum limpo) — ex.: depois de corrigir o ficheiro.
    const { sql } = await import("drizzle-orm");
    await d.execute(sql`UPDATE kb_documents SET status = 'pending', attempts = 0, error = NULL, checksum = NULL WHERE id = ${input.id}`);
    await log(ctx.user.id, "update", input.id, `Base de conhecimento: voltar a sincronizar "${doc.title}"`);
    return processNow(input.id).catch((err) => ({ status: "error", error: String(err?.message ?? err).slice(0, 200) }));
  }),

  /** Sincronizar agora (pastas do Drive + pendentes), até ~45 s. */
  syncNow: protectedProcedure.mutation(async ({ ctx }) => {
    manage(ctx.user);
    const { runKnowledgeSync } = await import("./sync");
    const r = await runKnowledgeSync({ deadlineAt: Date.now() + 45_000 });
    await log(ctx.user.id, "sync", null, `Base de conhecimento: sincronizar agora (${r.processed} processados, ${r.failed} com erro)`);
    return r;
  }),

  /** Carregados: apaga (ficheiro + trechos). Drive/ajuda: exclui do índice (não volta na sincronização). */
  remove: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    manage(ctx.user);
    const d = await store.kbDb();
    const doc = await store.getDoc(d, input.id);
    if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." });
    if (doc.source === "upload") {
      await store.deleteDocHard(d, input.id);
      try { const { storageDelete } = await import("../storage"); await storageDelete(doc.fileKey || doc.fileUrl); } catch { /* ficheiro já não existe */ }
    } else {
      await store.excludeDoc(d, input.id);
    }
    await log(ctx.user.id, "delete", input.id, `Base de conhecimento: ${doc.source === "upload" ? "apagado" : "excluído"} "${doc.title}"`);
    return { success: true, excluded: doc.source !== "upload" };
  }),

  /** Volta a incluir um documento excluído (Drive). */
  include: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    manage(ctx.user);
    const d = await store.kbDb();
    const { sql } = await import("drizzle-orm");
    await d.execute(sql`UPDATE kb_documents SET status = 'pending', attempts = 0, error = NULL, checksum = NULL WHERE id = ${input.id} AND status = 'skipped'`);
    return processNow(input.id).catch((err) => ({ status: "error", error: String(err?.message ?? err).slice(0, 200) }));
  }),

  /**
   * Abrir um documento a partir da pesquisa ou de uma citação — só se a
   * pessoa o puder ver. Drive → ligação do Drive; carregado → ligação temporária.
   */
  open: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const d = await store.kbDb();
    const doc = await store.getDoc(d, input.id);
    const user = withOverrides(ctx.user);
    if (!doc || doc.status !== "synced" || !canSeeKbDoc(doc.visibility, kbViewerFrom(user.role, cityScope.getStore()))) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." });
    }
    if (doc.source === "drive") return { url: safeCitationHref(doc.webViewLink), title: doc.title };
    if (doc.source === "help") return { url: safeCitationHref(doc.webViewLink) ?? "/", title: doc.title };
    const { storagePresignGet } = await import("../storage");
    const { url } = await storagePresignGet(doc.fileKey || doc.fileUrl || "", { fallbackUrl: doc.fileUrl, expiresSeconds: 600 });
    if (!url) throw new TRPCError({ code: "NOT_FOUND", message: "Ficheiro não encontrado." });
    return { url, title: doc.title };
  }),

  /**
   * Perguntas de quiz a partir de um documento (rascunhos, nível lite): ficam
   * por publicar até um formador as rever (Formação → Quiz).
   */
  generateQuiz: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), count: z.number().int().min(1).max(15).default(5), categoryId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      manage(ctx.user);
      const d = await store.kbDb();
      const doc = await store.getDoc(d, input.id, { withText: true });
      if (!doc || doc.status !== "synced" || !doc.textContent) throw new TRPCError({ code: "BAD_REQUEST", message: "O documento ainda não tem texto sincronizado." });
      const { generateKbQuizDrafts } = await import("./quiz");
      const r = await generateKbQuizDrafts({ docId: doc.id, title: doc.title, text: doc.textContent, count: input.count, categoryId: input.categoryId ?? null, userId: ctx.user.id });
      await log(ctx.user.id, "create", doc.id, `${r.created} rascunhos de perguntas a partir de "${doc.title}"`);
      return r;
    }),
});
