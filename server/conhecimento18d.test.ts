/**
 * P3 lote 18d — Base de conhecimento. Nada se apaga (excluir em vez de apagar),
 * documentos presos em "a processar" voltam à fila e desistem à 3.ª, a
 * visibilidade das pastas aplica-se ao gravar (a mais específica manda),
 * carregar o mesmo ficheiro não duplica, consulta falhada ≠ "os manuais não
 * falam disso", e o markdown da IA não traz HTML nem imagens de fora.
 */
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import { appendCitations, escapeMdLabel, foldersBySpecificity, KB_MAX_UPLOAD_BYTES, KB_MAX_UPLOAD_MB, mostSpecificKbFolder } from "../shared/knowledge";
import { MIGRATION_0390_STATEMENTS } from "./migrations/migration_0390";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { KB_MAX_ATTEMPTS, pendingDocIds } from "./knowledge/store";
import { KB_UNAVAILABLE_BLOCK } from "./assistant/service";
import { TUTOR_KB_UNAVAILABLE } from "./trainingTutor";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (file: string, start: string, len = 900) => { const s = src(file); const i = s.indexOf(start); expect(i).toBeGreaterThan(-1); return s.slice(i, i + len); };

describe("Pastas: a mais específica manda", () => {
  const folders = [
    { path: "Procedimentos/Porto", visibility: { roles: [], cities: ["Porto"] } },
    { path: "Procedimentos", visibility: { roles: [], cities: [] } },
    { path: "Formação", visibility: { roles: ["driver"], cities: [] } },
  ];
  it("seja qual for a ordem nas Definições", () => {
    expect(mostSpecificKbFolder(folders, "Procedimentos/Porto/Caixa")?.path).toBe("Procedimentos/Porto");
    expect(mostSpecificKbFolder([...folders].reverse(), "Procedimentos/Porto")?.path).toBe("Procedimentos/Porto");
    expect(mostSpecificKbFolder(folders, "Procedimentos/Lisboa")?.path).toBe("Procedimentos");
    expect(mostSpecificKbFolder(folders, "/procedimentos/porto/")?.path).toBe("Procedimentos/Porto");
  });
  it("prefixo sem ser pasta não conta; fora de todas → null", () => {
    expect(mostSpecificKbFolder(folders, "Procedimentos2/Porto")).toBeNull();
    expect(mostSpecificKbFolder(folders, "Outra")).toBeNull();
  });
  it("aplicar da mais geral para a mais específica", () => {
    expect(foldersBySpecificity(folders).map((f) => f.path)).toEqual(["Formação", "Procedimentos", "Procedimentos/Porto"]);
  });
  it("a descoberta usa a mais específica; gravar as Definições aplica já e pede nova volta", () => {
    expect(src("server/knowledge/sync.ts")).toContain("mostSpecificKbFolder(folders, top.path) ?? folder");
    const save = fnBody("server/knowledge/router.ts", "const config = parseKnowledgeConfig(r.value);", 500);
    expect(save).toContain("await applyFolderVisibility(d, config.folders);");
    expect(save).toContain("await forceNextDiscovery(d);");
    const apply = fnBody("server/knowledge/sync.ts", "export async function applyFolderVisibility(", 1200);
    expect(apply).toContain("foldersBySpecificity(folders)");
    expect(apply).toContain("visibilityCustom = 0"); // a visibilidade personalizada de um documento não se perde
  });
});

describe("Nada se apaga", () => {
  it("migração 0390 depois da 0385, só acrescenta", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0390")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0385"));
    expect(MIGRATION_0390_STATEMENTS.every((s) => s.startsWith("ALTER TABLE `kb_documents` ADD"))).toBe(true);
  });
  it("sem DELETE de documentos: 'Remover' exclui (carregados incluídos) e 'Voltar a incluir' traz de volta", () => {
    const all = ["server/knowledge/store.ts", "server/knowledge/router.ts", "server/knowledge/sync.ts", "server/knowledge/driveChanges.ts"].map(src).join("\n");
    expect(all).not.toMatch(/DELETE FROM kb_documents/);
    expect(all).not.toContain("deleteDocHard");
    const remove = fnBody("server/knowledge/router.ts", "remove: protectedProcedure", 600);
    expect(remove).toContain("await store.excludeDoc(d, input.id);");
    expect(remove).toContain('"exclude"');
    const include = fnBody("server/knowledge/router.ts", "include: protectedProcedure", 800);
    expect(include).toContain('if (doc.status !== "skipped")');
    expect(include).toContain('"include"');
  });
  it("mudanças de visibilidade ficam no registo (antes → depois)", () => {
    expect(fnBody("server/knowledge/router.ts", "updateVisibility: protectedProcedure", 1500)).toContain("→");
  });
});

describe("Presos em 'a processar'", () => {
  it("3 tentativas no máximo", () => expect(KB_MAX_ATTEMPTS).toBe(3));
  it("a reserva reapanha um preso há > 10 min (e conta a tentativa antes de mudar o estado)", () => {
    const claim = fnBody("server/knowledge/store.ts", "export async function claimForProcessing(", 500);
    expect(claim).toContain("SET attempts = IF(status = 'processing', attempts + 1, attempts), status = 'processing'");
    expect(claim).toContain("updatedAt < NOW() - INTERVAL 10 MINUTE AND attempts < ${KB_MAX_ATTEMPTS}");
  });
  it("à 3.ª passa a Erro; a corrida não repete o que já falhou", () => {
    expect(fnBody("server/knowledge/store.ts", "export async function failStuckProcessing(", 600)).toContain("status = 'error'");
    const run = src("server/knowledge/sync.ts");
    expect(run).toContain("await store.failStuckProcessing(d)");
    expect(run).toContain("store.pendingDocIds(d, 3, opts.now, tried)");
  });
  it("pendingDocIds compara horas na BD e exclui os já tentados", async () => {
    const dialect = new MySqlDialect();
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const d = { async execute(q: any) { seen.push(dialect.sqlToQuery(q)); return [[{ id: 4 }]]; } };
    expect(await pendingDocIds(d, 3, new Date(), [1, 2])).toEqual([4]);
    expect(seen[0].sql).toContain("NOW() - INTERVAL 10 MINUTE");
    expect(seen[0].sql).toContain("d.id NOT IN (?, ?)");
    expect(seen[0].params).toEqual(expect.arrayContaining([1, 2]));
    await pendingDocIds(d, 3);
    expect(seen[1].sql).not.toContain("NOT IN");
  });
  it("'Voltar a sincronizar' recusa um documento que está a processar", () => {
    expect(fnBody("server/knowledge/router.ts", "resync: protectedProcedure", 900)).toContain('code: "CONFLICT"');
  });
});

describe("Drive: ficheiro recuperado volta a ser lido", () => {
  it("restored → por processar e checksum limpo (nos dois caminhos)", () => {
    for (const f of ["server/knowledge/sync.ts", "server/knowledge/driveChanges.ts"]) {
      const s = src(f);
      expect(s).toMatch(/const restored = (r|known)\.deletedAt != null;/);
      expect(s).toContain("${restored ? sql`, checksum = NULL` : sql``}");
    }
  });
});

describe("Carregar", () => {
  it("3 MB (cabe no limite do pedido da Vercel em base64)", () => {
    expect(KB_MAX_UPLOAD_MB).toBe(3);
    expect(KB_MAX_UPLOAD_BYTES).toBe(3 * 1024 * 1024);
  });
  it("o mesmo ficheiro outra vez → usa o que existe", () => {
    const up = src("server/knowledge/router.ts");
    expect(up).toContain("const dup = await store.uploadByChecksum(await store.kbDb(), sha);");
    expect(up).toContain("duplicateOf: dup.title");
    expect(src("client/src/pages/KnowledgeBasePage.tsx")).toContain("Não foi carregado outra vez.");
  });
});

describe("Consulta falhada ≠ 'os manuais não falam disso'", () => {
  it("retrieve marca failed; o assistente e o tutor dizem que não conseguiram consultar", () => {
    expect(src("server/knowledge/retrieve.ts")).toContain("return { ...empty, failed: true };");
    expect(src("server/assistant/service.ts")).toContain("if (r.failed) return { block: KB_UNAVAILABLE_BLOCK, citations: [] };");
    expect(KB_UNAVAILABLE_BLOCK).toContain("não digas que os manuais não falam disso");
    expect(TUTOR_KB_UNAVAILABLE).toMatch(/Não consegui consultar os manuais/);
    expect(src("server/trainingTutor.ts")).toContain("if (!hits.length && !kbHits.length && kb.failed)");
  });
  it("pesquisa global: uma fonte com erro aparece 'sem resposta' (não desaparece)", () => {
    const g = fnBody("server/globalSearch.ts", "if (r.ok) {", 400);
    expect(g).toContain("} else {");
    expect(g).toContain("put(src.group, [], true);");
    expect(src("client/src/components/GlobalSearch.tsx")).toContain("Sem resposta (lenta ou com erro)");
  });
});

describe("Markdown seguro", () => {
  it("título com [ ] ( ) não injeta ligações nas Fontes", () => {
    expect(escapeMdLabel("Caixa [v2](https://mau.example)")).toBe("Caixa \\[v2\\]\\(https://mau.example\\)");
    const r = appendCitations("Usa o terminal [K1].", [{ tag: "K1", docId: 1, title: "x](https://mau.example) [y", section: null, href: "javascript:alert(1)" }]);
    expect(r.text).not.toContain("](https://mau.example)");
    expect(r.text).not.toContain("javascript:");
  });
  it("respostas da IA sem HTML embutido nem imagens de fora", () => {
    const s = fnBody("client/src/lib/safeMarkdown.ts", "  return [", 400);
    expect(s).toContain("defaultRehypePlugins.katex");
    expect(s).not.toContain("defaultRehypePlugins.raw");
    expect(s).toContain("allowedImagePrefixes: [origin]");
    expect(s).toContain("allowDataImages: false");
    for (const f of ["client/src/components/assistant/AssistantWidget.tsx", "client/src/components/AIChatBox.tsx"]) {
      expect(src(f)).toContain("<Streamdown rehypePlugins={aiRehypePlugins()}>");
    }
  });
});

describe("Erro ≠ vazio na página", () => {
  it("documentos, estado, categorias e pré-visualização mostram o erro", () => {
    const p = src("client/src/pages/KnowledgeBasePage.tsx");
    for (const w of ['what="os documentos"', 'what="o estado da base de conhecimento"', 'what="as categorias"', 'what="o documento"']) expect(p).toContain(w);
  });
  it("estado: contagens já não engolem o erro", () => {
    expect(fnBody("server/knowledge/store.ts", "export async function statusCounts(", 300)).not.toContain("catch");
  });
});
