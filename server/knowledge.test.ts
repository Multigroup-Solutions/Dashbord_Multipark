import { afterEach, describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { createFakeDb } from "./_core/ai/testUtils";
import { chunkText, normalizeExtracted, textChecksum } from "./knowledge/chunker";
import { docxToText, readZipEntry, wordXmlToText } from "./knowledge/docx";
import { citationsFor, fallbackTerms, knowledgeBlock, keywordScore, kbViewerFrom, rankCandidates, retrieveKnowledge } from "./knowledge/retrieve";
import { kbVisibilitySql } from "./knowledge/store";
import { discoverDrive, processDoc, upsertDriveFile, type KbSyncReport } from "./knowledge/sync";
import type { KbDriveApi } from "./knowledge/drive";
import { cosine, decodeVector, embedTexts, encodeVector } from "./_core/ai/embed";
import { setAiProvidersForTests } from "./_core/ai/client";
import { uploadMimeFor } from "./knowledge/router";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  KB_VISIBILITY_ALL, appendCitations, canSeeKbDoc, parseKnowledgeConfig, parseVisibility, safeCitationHref, visibilityLabel,
} from "../shared/knowledge";
import { COST_CENTRE_ALL_HINT, COST_CENTRE_ALL_LABEL, COST_CENTRE_TRIGGER_MAX_CHARS, costCentreTriggerLabel } from "../shared/taskRules";

const dialect = new MySqlDialect();
const render = (q: any) => dialect.sqlToQuery(q);

// ─── Trechos ────────────────────────────────────────────────────────────────

describe("chunker", () => {
  const para = (n: number, w = "procedimento") => Array.from({ length: n }, (_, i) => `${w} ${i} da receção do cliente no parque.`).join(" ");

  it("texto curto = um trecho com a secção do título", () => {
    const out = chunkText("# Receção\nO cliente entrega a chave ao condutor.\n\nConfirma a matrícula.");
    expect(out).toHaveLength(1);
    expect(out[0].section).toBe("Receção");
    expect(out[0].text).toContain("Confirma a matrícula.");
    expect(out[0].tokens).toBeGreaterThan(0);
  });

  it("texto longo: trechos entre ~800 e 1200 tokens, com sobreposição e sem passar o máximo", () => {
    const text = `# Manual\n${Array.from({ length: 30 }, () => para(20)).join("\n\n")}`;
    const out = chunkText(text);
    expect(out.length).toBeGreaterThan(3);
    for (const c of out) expect(c.tokens).toBeLessThanOrEqual(1200);
    for (const c of out.slice(0, -1)) expect(c.tokens).toBeGreaterThanOrEqual(800);
    // Sobreposição: o início do 2.º trecho repete o fim do 1.º.
    const head = out[1].text.slice(0, 80);
    expect(out[0].text).toContain(head.slice(0, 40));
    expect(out.map((c) => c.ord)).toEqual(out.map((_, i) => i));
  });

  it("parágrafo gigante sem pontuação é cortado (nunca acima do máximo)", () => {
    const out = chunkText("x".repeat(20_000), { targetTokens: 500, maxTokens: 600 });
    expect(out.length).toBeGreaterThan(5);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(600 * 4);
  });

  it("cada trecho fica com a secção em vigor", () => {
    const text = `# A\n${para(5)}\n\n## B\n${para(5, "entrega")}`;
    const out = chunkText(text, { targetTokens: 60, maxTokens: 80, overlapTokens: 10 });
    expect(out.some((c) => c.section === "A")).toBe(true);
    expect(out.some((c) => c.section === "B")).toBe(true);
    expect(out.find((c) => c.text.includes("entrega"))?.section).toBe("B");
  });

  it("vazio → nenhum trecho; checksum ignora espaços/quebras (mudanças só de formatação)", () => {
    expect(chunkText("   \n\n ")).toEqual([]);
    expect(textChecksum("Olá  mundo\r\n\r\n\r\nfim")).toBe(textChecksum("Olá mundo\n\nfim"));
    expect(textChecksum("Olá mundo")).not.toBe(textChecksum("Olá mundo!"));
    expect(normalizeExtracted("a   b")).toBe("a b");
  });
});

// ─── DOCX sem dependências ───────────────────────────────────────────────────

function zipOf(name: string, content: string): Buffer {
  const data = deflateRawSync(Buffer.from(content, "utf8"));
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(content.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(0, 42);
  const cenOff = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cen.length + nameBuf.length, 12); eocd.writeUInt32LE(cenOff, 16);
  return Buffer.concat([local, nameBuf, data, cen, nameBuf, eocd]);
}

describe("docx", () => {
  const xml = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chaves</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Guardar no cofre &amp; registar</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p></w:body></w:document>';

  it("XML do Word → texto com títulos", () => {
    expect(wordXmlToText(xml)).toBe("# Chaves\nGuardar no cofre & registar.");
  });

  it("lê word/document.xml de um ZIP (deflate) e recusa o que não é DOCX", () => {
    const zip = zipOf("word/document.xml", xml);
    expect(readZipEntry(zip, "word/document.xml")?.toString("utf8")).toBe(xml);
    expect(docxToText(zip)).toContain("Guardar no cofre");
    expect(docxToText(Buffer.from("não é um zip"))).toBeNull();
    expect(readZipEntry(zip, "outro.xml")).toBeNull();
  });
});

// ─── Visibilidade ────────────────────────────────────────────────────────────

describe("visibilidade dos documentos", () => {
  const porto = { role: "supervisor", allCities: false, cityNames: ["Porto"] };
  const admin = { role: "admin", allCities: true, cityNames: [] };

  it("canSeeKbDoc: todos / papéis / cidades", () => {
    expect(canSeeKbDoc(KB_VISIBILITY_ALL, porto)).toBe(true);
    expect(canSeeKbDoc({ roles: ["admin"], cities: [] }, porto)).toBe(false);
    expect(canSeeKbDoc({ roles: ["supervisor"], cities: ["Lisboa"] }, porto)).toBe(false);
    expect(canSeeKbDoc({ roles: [], cities: ["Porto"] }, porto)).toBe(true);
    expect(canSeeKbDoc({ roles: [], cities: ["Lisboa"] }, admin)).toBe(true);
    expect(canSeeKbDoc({ roles: [], cities: ["Lisboa"] }, { role: "extra", allCities: false, cityNames: ["lisbon"] })).toBe(true);
    expect(canSeeKbDoc({ roles: [], cities: ["Faro"] }, { role: "extra", allCities: false, cityNames: [] })).toBe(false);
  });

  it("parseVisibility ignora valores desconhecidos; rótulo curto", () => {
    expect(parseVisibility('["admin","hacker"]', '["Porto","Madrid"]')).toEqual({ roles: ["admin"], cities: ["Porto"] });
    expect(parseVisibility(null, "lixo")).toEqual({ roles: [], cities: [] });
    expect(visibilityLabel(KB_VISIBILITY_ALL)).toBe("Todos");
    expect(visibilityLabel({ roles: ["admin"], cities: ["Faro"] }, { admin: "Admin" })).toBe("Admin · Faro");
  });

  it("SQL: papel e cidades parametrizados; quem vê todas as cidades só filtra o papel", () => {
    const q = render(kbVisibilitySql(porto));
    expect(q.sql).toContain("JSON_CONTAINS(d.visibilityRoles");
    expect(q.sql).toContain("JSON_CONTAINS(d.visibilityCities");
    expect(q.params).toEqual(expect.arrayContaining(["supervisor", "Porto", "oporto"]));
    const a = render(kbVisibilitySql(admin));
    expect(a.sql).not.toContain("visibilityCities");
    const none = render(kbVisibilitySql({ role: "extra", allCities: false, cityNames: [] }));
    expect(none.sql).toContain("1 = 0");
  });

  it("kbViewerFrom: sem âmbito de cidade = nenhuma cidade (nunca todas)", () => {
    expect(kbViewerFrom("admin", undefined)).toEqual({ role: "admin", allCities: false, cityNames: [] });
    expect(kbViewerFrom("supervisor", { all: false, cityNames: ["Porto"] })).toEqual({ role: "supervisor", allCities: false, cityNames: ["Porto"] });
    expect(kbViewerFrom("admin", { all: true, cityName: "Lisboa" }).allCities).toBe(true);
  });
});

// ─── Recuperação ─────────────────────────────────────────────────────────────

const chunkRow = (o: Partial<Record<string, unknown>>) => ({
  id: 1, docId: 10, section: "Chaves", text: "As chaves ficam sempre no cofre da receção.", embedding: null, title: "Manual de receção",
  webViewLink: "https://docs.google.com/document/d/abc", source: "drive", visibilityRoles: "[]", visibilityCities: "[]", ft: 2, ...o,
});

describe("recuperação (visibilidade, FULLTEXT, embeddings)", () => {
  it("nunca devolve um trecho restrito, mesmo que o SQL o traga (2.ª barreira)", async () => {
    const d = createFakeDb((q) => q.sql.includes("MATCH(") ? [[
      chunkRow({ id: 1 }),
      chunkRow({ id: 2, docId: 11, title: "Salários (RH)", text: "As chaves do cofre dos salários…", visibilityRoles: '["super_admin"]' }),
      chunkRow({ id: 3, docId: 12, title: "Procedimento Lisboa", text: "As chaves em Lisboa ficam no cofre.", visibilityCities: '["Lisboa"]' }),
    ]] : [[]]);
    const r = await retrieveKnowledge({ question: "onde ficam as chaves do cofre?", viewer: { role: "supervisor", allCities: false, cityNames: ["Porto"] }, d, embedQuery: null });
    expect(r.hits.map((h) => h.docId)).toEqual([10]);
    expect(r.mode).toBe("fulltext");
    expect(r.citations[0]).toMatchObject({ tag: "K1", docId: 10, title: "Manual de receção" });
    const sqlText = d.queries[0].sql;
    expect(sqlText).toContain("d.status = 'synced'");
    expect(sqlText).toContain("JSON_CONTAINS(d.visibilityRoles");
  });

  it("sem índice FULLTEXT (erro) → cai para LIKE nas palavras longas", async () => {
    const d = createFakeDb((q) => {
      if (q.sql.includes("MATCH(")) throw new Error("ER_FT_MATCHING_KEY_NOT_FOUND");
      return [[chunkRow({})]];
    });
    const r = await retrieveKnowledge({ question: "chaves cofre", viewer: { role: "admin", allCities: true, cityNames: [] }, d, embedQuery: null });
    expect(r.mode).toBe("keywords");
    expect(r.hits).toHaveLength(1);
    const like = d.queries.find((q) => q.sql.includes("LIKE"))!;
    expect(like.params).toEqual(expect.arrayContaining(["%chaves%", "%cofre%"]));
  });

  it("embeddings: reordena pelo cosseno; se a IA falhar fica a ordem por palavras-chave", async () => {
    const near = encodeVector([1, 0, 0]);
    const far = encodeVector([0, 1, 0]);
    const rows = [
      chunkRow({ id: 1, docId: 1, text: "chaves cofre receção", embedding: far, ft: 3 }),
      chunkRow({ id: 2, docId: 2, text: "chaves cofre", embedding: near, ft: 1 }),
    ];
    const d = createFakeDb(() => [rows]);
    const viewer = { role: "admin", allCities: true, cityNames: [] };
    const withEmb = await retrieveKnowledge({ question: "chaves cofre", viewer, d, embedQuery: async () => [1, 0, 0] });
    expect(withEmb.mode).toBe("embeddings");
    expect(withEmb.hits[0].docId).toBe(2);
    const failing = await retrieveKnowledge({ question: "chaves cofre", viewer, d, embedQuery: async () => { throw new Error("orçamento"); } });
    expect(failing.mode).toBe("fulltext");
    expect(failing.hits[0].docId).toBe(1);
  });

  it("sem BD / pergunta curta → sem trechos (nunca lança)", async () => {
    const d = createFakeDb(() => { throw new Error("db em baixo"); });
    expect((await retrieveKnowledge({ question: "chaves do cofre", viewer: { role: "admin", allCities: true, cityNames: [] }, d, embedQuery: null })).hits).toEqual([]);
    expect((await retrieveKnowledge({ question: "ab", viewer: { role: "admin", allCities: true, cityNames: [] }, d, embedQuery: null })).mode).toBe("none");
  });

  it("palavras-chave, LIKE de recurso e no máximo 2 trechos por documento", async () => {
    expect(keywordScore("chaves do cofre", "o cofre das chaves")).toBe(1);
    expect(keywordScore("chaves do cofre", "horários")).toBe(0);
    expect(fallbackTerms("Onde ficam as chaves do cofre?")).toEqual(["chaves", "ficam", "cofre", "onde"]);
    const rows = [1, 2, 3].map((i) => ({ ...chunkRow({ id: i, docId: 5 }), ft: 1 })) as any;
    const r = await rankCandidates("chaves cofre", rows, null, 5);
    expect(r.hits).toHaveLength(2);
  });
});

describe("citações", () => {
  const hits = [
    { chunkId: 1, docId: 10, title: "Manual de receção", section: "Chaves", text: "As chaves ficam no cofre.", href: "https://docs.google.com/document/d/abc", source: "drive" as const, score: 1 },
    { chunkId: 2, docId: 11, title: "Procedimento", section: null, text: "x".repeat(5000), href: null, source: "upload" as const, score: 0.5 },
  ];

  it("bloco <conhecimento> com etiquetas e teto de caracteres", () => {
    const b = knowledgeBlock(hits, 2000);
    expect(b.startsWith("<conhecimento>")).toBe(true);
    expect(b).toContain("[K1] «Manual de receção» — secção «Chaves»");
    expect(b).toContain("[K2] «Procedimento»:");
    expect(b.length).toBeLessThan(2300);
  });

  it("Fontes: só as etiquetas usadas, com ligação segura", () => {
    const c = citationsFor(hits);
    const r = appendCitations("A chave fica no cofre [K1].", c);
    expect(r.text).toContain("Fontes:\n- [K1] [Manual de receção — Chaves](https://docs.google.com/document/d/abc)");
    expect(r.used.map((x) => x.docId)).toEqual([10]);
    expect(appendCitations("Não encontrei nos manuais.", c)).toEqual({ text: "Não encontrei nos manuais.", used: [] });
    expect(appendCitations("Resposta", [])).toEqual({ text: "Resposta", used: [] });
  });

  it("ligações: só Google (https) ou caminhos internos", () => {
    expect(safeCitationHref("https://docs.google.com/x")).toBe("https://docs.google.com/x");
    expect(safeCitationHref("/extras-dia")).toBe("/extras-dia");
    expect(safeCitationHref("javascript:alert(1)")).toBeNull();
    expect(safeCitationHref("//evil.com")).toBeNull();
    expect(safeCitationHref("https://evil.com/google.com")).toBeNull();
  });
});

// ─── Embeddings (camada de IA) ───────────────────────────────────────────────

describe("embeddings", () => {
  afterEach(() => setAiProvidersForTests(null));

  it("vetores: base64 Float32 ida e volta e cosseno", () => {
    const v = decodeVector(encodeVector([0.5, -1, 2]))!;
    expect(Array.from(v)).toEqual([0.5, -1, 2]);
    expect(decodeVector("")).toBeNull();
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it("embedTexts: lotes pelo fornecedor Gemini, com a tarefa e as dimensões", async () => {
    const calls: any[] = [];
    setAiProvidersForTests({
      gemini: {
        id: "gemini",
        generate: async () => { throw new Error("não usado"); },
        embed: async (req) => { calls.push(req); return req.texts.map(() => [0.1, 0.2]); },
      },
    });
    const r = await embedTexts({ feature: "knowledge_embed", texts: ["a", "b", "c"], taskType: "RETRIEVAL_DOCUMENT", env: { GEMINI_API_KEY: "k" } });
    expect(r.vectors).toHaveLength(3);
    expect(r.model).toBe("gemini-embedding-001");
    expect(calls[0]).toMatchObject({ taskType: "RETRIEVAL_DOCUMENT", dimensions: 768 });
  });

  it("sem Gemini (só o caminho antigo) → erro 'unsupported' (a recuperação cai para palavras-chave)", async () => {
    await expect(embedTexts({ feature: "knowledge_embed", texts: ["a"], taskType: "RETRIEVAL_QUERY", env: { AI_PROVIDER: "legacy", LLM_API_KEY: "x" } }))
      .rejects.toMatchObject({ code: "unsupported" });
    await expect(embedTexts({ feature: "knowledge_embed", texts: ["a"], taskType: "RETRIEVAL_QUERY", env: {} }))
      .rejects.toMatchObject({ code: "not_configured" });
  });
});

// ─── Sincronização incremental ───────────────────────────────────────────────

describe("sincronização incremental", () => {
  const folder = { path: "Formação", visibility: { roles: [], cities: ["Porto" as const] } };
  const file = { id: "f1", name: "Manual.pdf", mimeType: "application/pdf", modifiedTime: "2026-09-01T10:00:00Z", md5: "aaa", size: 100, webViewLink: "https://drive.google.com/f1" };

  it("ficheiro novo → INSERT por processar com a visibilidade da pasta", async () => {
    const d = createFakeDb(() => [[]]);
    expect(await upsertDriveFile(d as any, file, folder, "Formação", "2026-09-25 10:00:00")).toBe(true);
    const ins = d.queries.find((q) => q.sql.startsWith("INSERT INTO kb_documents"))!;
    expect(ins.params).toEqual(expect.arrayContaining(["drive", "f1", "Manual", '["Porto"]']));
  });

  it("mesmo modifiedTime/md5 → só marca como visto (não volta a processar)", async () => {
    const d = createFakeDb((q) => q.sql.startsWith("SELECT id, modifiedTime") ? [[{ id: 7, modifiedTime: file.modifiedTime, md5: "aaa", status: "synced", visibilityCustom: 0 }]] : [[]]);
    expect(await upsertDriveFile(d as any, file, folder, "Formação", "2026-09-25 10:00:00")).toBe(false);
    const upd = d.queries.find((q) => q.sql.startsWith("UPDATE kb_documents"))!;
    expect(upd.sql).not.toContain("status = 'pending'");
    expect(upd.sql).toContain("visibilityRoles"); // segue a pasta (não foi definida à mão)
  });

  it("ficheiro alterado → por processar; visibilidade definida à mão fica", async () => {
    const d = createFakeDb((q) => q.sql.startsWith("SELECT id, modifiedTime") ? [[{ id: 7, modifiedTime: "antigo", md5: "aaa", status: "synced", visibilityCustom: 1 }]] : [[]]);
    expect(await upsertDriveFile(d as any, file, folder, "Formação", "2026-09-25 10:00:00")).toBe(true);
    const upd = d.queries.find((q) => q.sql.startsWith("UPDATE kb_documents"))!;
    expect(upd.sql).toContain("status = 'pending'");
    expect(upd.sql).not.toContain("visibilityRoles");
  });

  const docRow = (o: Record<string, unknown> = {}) => ({
    id: 5, source: "drive", driveFileId: "f1", title: "Manual", mimeType: "application/vnd.google-apps.document", status: "pending",
    checksum: null, chunkCount: 0, embedded: 0, visibilityRoles: "[]", visibilityCities: "[]", ...o,
  });
  const fakeDrive = (text: string): KbDriveApi => ({
    driveId: "root", findFolder: async () => null, list: async () => ({ files: [], nextPageToken: null }),
    exportText: async () => text, download: async () => Buffer.from(text), convertToText: async () => text, uploadAndConvert: async () => text,
  });
  const dbFor = (row: Record<string, unknown>) => createFakeDb((q) => {
    if (q.sql.includes("FROM kb_documents d WHERE d.id")) return [[row]];
    if (q.sql.includes("SET status = 'processing'")) return [{ affectedRows: 1 }];
    if (q.sql.startsWith("SELECT id, ord")) return [[{ id: 1, ord: 0, section: null, text: "t", hasEmb: 0 }]];
    return [[]];
  });

  it("checksum igual → não volta a partir nem a gerar vetores", async () => {
    const text = "Procedimento de receção: confirmar a matrícula e guardar a chave no cofre.";
    const d = dbFor(docRow({ checksum: textChecksum(text), chunkCount: 1, embedded: 1 }));
    let embeds = 0;
    const r = await processDoc(d as any, 5, { drive: fakeDrive(text), embed: async (t) => { embeds++; return { vectors: t.map(() => [1]), model: "m" }; } }, Date.now() + 30_000);
    expect(r).toMatchObject({ status: "unchanged", embedded: true });
    expect(d.queries.some((q) => q.sql.startsWith("DELETE FROM kb_chunks"))).toBe(false);
    expect(embeds).toBe(0);
  });

  it("texto novo → novos trechos + vetores; IA em baixo → sincronizado só com palavras-chave", async () => {
    const text = "Procedimento de receção: confirmar a matrícula e guardar a chave no cofre.";
    const d = dbFor(docRow());
    const ok = await processDoc(d as any, 5, { drive: fakeDrive(text), embed: async (t) => ({ vectors: t.map(() => [1, 0]), model: "m" }) }, Date.now() + 30_000);
    expect(ok).toMatchObject({ status: "synced", embedded: true });
    expect(d.queries.some((q) => q.sql.startsWith("INSERT INTO kb_chunks"))).toBe(true);
    expect(d.queries.some((q) => q.sql.includes("UPDATE kb_chunks SET embedding"))).toBe(true);

    const d2 = dbFor(docRow());
    const down = await processDoc(d2 as any, 5, { drive: fakeDrive(text), embed: async () => { throw new Error("budget"); } }, Date.now() + 30_000);
    expect(down).toMatchObject({ status: "synced", embedded: false });
    expect(d2.queries.some((q) => q.sql.startsWith("UPDATE kb_documents SET status") && q.params.includes("synced"))).toBe(true);
  });

  it("documento sem texto → erro guardado (tenta outra vez até 3 vezes)", async () => {
    const d = dbFor(docRow());
    const r = await processDoc(d as any, 5, { drive: fakeDrive(" "), embed: null }, Date.now() + 30_000);
    expect(r.status).toBe("error");
    expect(d.queries.some((q) => q.sql.includes("status = 'error'") || q.params.includes("error"))).toBe(true);
  });

  it("descoberta retomável: guarda o cursor quando o prazo acaba; volta completa retira o que desapareceu", async () => {
    const state = new Map<string, string | null>();
    const d = createFakeDb((q) => {
      if (q.sql.startsWith("SELECT value FROM kb_sync_state")) return [[state.has(String(q.params[0])) && state.get(String(q.params[0])) != null ? { value: state.get(String(q.params[0])) } : undefined].filter(Boolean)];
      if (q.sql.startsWith("INSERT INTO kb_sync_state")) { state.set(String(q.params[0]), q.params[1] as any); return [{}]; }
      if (q.sql.startsWith("SELECT id FROM kb_documents WHERE source = 'drive'")) return [[{ id: 99 }]];
      return [[]];
    });
    const drive: KbDriveApi = {
      driveId: "root",
      findFolder: async (name) => (name === "Formação" ? "fold" : null),
      list: async (id, token) => (token ? { files: [{ ...file, id: "f2", name: "B.pdf" }], nextPageToken: null } : { files: [file, { ...file, id: "sub", name: "Sub", mimeType: "application/vnd.google-apps.folder" }], nextPageToken: id === "fold" ? "p2" : null }),
      exportText: async () => "", download: async () => Buffer.from(""), convertToText: async () => "", uploadAndConvert: async () => "",
    };
    const report = (): KbSyncReport => ({ ok: true, done: true, drive: { configured: true, scanned: 0, queued: 0, removed: 0, pass: "skipped" }, help: { updated: 0 }, processed: 0, failed: 0, embedded: 0, errors: [] });

    const r1 = report();
    await discoverDrive(d as any, drive, [folder], Date.now() + 1_000, r1); // prazo já curto
    expect(r1.drive.pass).toBe("partial");
    expect(state.get("drive:cursor")).toBeTruthy();

    const r2 = report();
    await discoverDrive(d as any, drive, [folder], Date.now() + 60_000, r2);
    expect(r2.drive.pass).toBe("complete");
    expect(r2.drive.queued).toBeGreaterThanOrEqual(2); // f1, f2 e o da subpasta
    expect(r2.drive.removed).toBe(1);
    expect(state.get("drive:cursor")).toBeNull();

    // Logo a seguir não volta a correr (1 volta por hora).
    const r3 = report();
    await discoverDrive(d as any, drive, [folder], Date.now() + 60_000, r3);
    expect(r3.drive.pass).toBe("skipped");
  });

  it("pasta em falta → não retira nada do índice (evita esvaziar por um erro de configuração)", async () => {
    const d = createFakeDb(() => [[]]);
    const drive: KbDriveApi = { driveId: "root", findFolder: async () => null, list: async () => ({ files: [], nextPageToken: null }), exportText: async () => "", download: async () => Buffer.from(""), convertToText: async () => "", uploadAndConvert: async () => "" };
    const r: KbSyncReport = { ok: true, done: true, drive: { configured: true, scanned: 0, queued: 0, removed: 0, pass: "skipped" }, help: { updated: 0 }, processed: 0, failed: 0, embedded: 0, errors: [] };
    await discoverDrive(d as any, drive, [{ path: "Não existe", visibility: KB_VISIBILITY_ALL }], Date.now() + 60_000, r);
    expect(r.errors.join(" ")).toContain("Não existe");
    expect(d.queries.some((q) => q.sql.includes("SET deletedAt"))).toBe(false);
  });
});

describe("definições e carregamento", () => {
  it("config por omissão: Formação e Procedimentos, sincronização desligada", () => {
    const c = parseKnowledgeConfig(null);
    expect(c.driveEnabled).toBe(false);
    expect(c.folders.map((f) => f.path)).toEqual(["Formação", "Procedimentos"]);
    expect(parseKnowledgeConfig('{"folders":[{"path":"X"}]}').folders[0].visibility).toEqual({ roles: [], cities: [] });
  });

  it("tipos aceites pelo nome E pelo tipo declarado", () => {
    expect(uploadMimeFor("Manual.PDF", "application/pdf")).toBe("application/pdf");
    expect(uploadMimeFor("a.docx", "")).toContain("wordprocessingml");
    expect(uploadMimeFor("a.md", "text/x-markdown")).toBe("text/markdown");
    expect(uploadMimeFor("a.exe", "application/pdf")).toBeNull();
    expect(uploadMimeFor("a.pdf", "text/html")).toBeNull();
  });
});

describe("tarefas: filtro do centro de custos cabe no botão", () => {
  it("rótulo curto no botão, texto completo na dica", () => {
    expect(COST_CENTRE_ALL_LABEL.length).toBeLessThanOrEqual(COST_CENTRE_TRIGGER_MAX_CHARS);
    expect(COST_CENTRE_ALL_HINT).toMatch(/grupo.*cidade.*marca.*projeto/);
    expect(costCentreTriggerLabel("all", [])).toBe(COST_CENTRE_ALL_LABEL);
    expect(costCentreTriggerLabel("3", [{ id: 3, name: "Porto" }])).toBe("Porto");
    const long = costCentreTriggerLabel("4", [{ id: 4, name: "Multipark Lisboa Aeroporto — Parque Coberto" }]);
    expect(long.length).toBe(COST_CENTRE_TRIGGER_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
});
