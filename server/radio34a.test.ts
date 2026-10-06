/**
 * P3 lote 34a — Rádio: provas (Jorge, 6 out 2026): "o rádio devia dar opção
 * para se guardar alguns registos com o histórico e a transcrição para servir
 * de prova para algumas situações; o som não está cá mas ok, a transcrição
 * chega."
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cleanEvidenceInput, evidenceSealInput, evidenceSnapshotOf, evidenceText, stableJson, EVIDENCE_MAX_PER_SAVE } from "../shared/radioEvidence";
import { fileAccessRule } from "./fileRoute";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Uma linha da pesquisa do Zello (32a), como o servidor a devolve
const ROW = {
  id: 77, type: "voice", at: Date.parse("2026-10-06T09:15:10Z"), sender: "pda7", senderName: "PDA 7", recipient: "Lisboa", recipientType: "channel",
  durationS: 4.3, mediaKey: "k77", transcription: "o carro tem um risco na porta", transcriptionInaccurate: true, text: null,
  person: { employeeId: 12, name: "Ana Silva", projectId: 3, via: "pda" },
  position: { at: 1, lat: 38.77, lon: -9.13, speed: 31.26, deltaS: -12 },
  actions: [{ userId: "u1", at: Date.parse("2026-10-06T09:16:00Z"), changeType: "CHECK_OUT", bookingCode: "B123", plate: "AA-00-AA", park: "Airpark", deltaS: 50 }],
  aiTranscription: null, evidenceId: null,
};

describe("34a — a fotografia da mensagem", () => {
  it("leva quem, quando, transcrição (Zello primeiro), GPS e Multipark; nada do que não interessa", () => {
    const s = evidenceSnapshotOf(ROW);
    expect(s).toEqual({
      zelloMessageId: 77, at: ROW.at, sender: "pda7", senderName: "PDA 7", recipient: "Lisboa", recipientType: "channel", durationS: 4.3,
      employeeId: 12, personName: "Ana Silva", personVia: "pda", projectId: 3,
      transcription: "o carro tem um risco na porta", transcriptionSource: "zello", transcriptionInaccurate: true, summary: null,
      position: { lat: 38.77, lon: -9.13, speed: 31.3, deltaS: -12 },
      actions: [{ at: ROW.actions[0].at, changeType: "CHECK_OUT", bookingCode: "B123", plate: "AA-00-AA", park: "Airpark", deltaS: 50 }],
      mediaKey: "k77",
    });
    // sem transcrição do Zello → a da IA, com o resumo
    const ia = evidenceSnapshotOf({ ...ROW, transcription: null, aiTranscription: { id: 5, text: "texto IA", summary: "resumo" } });
    expect(ia).toMatchObject({ transcription: "texto IA", transcriptionSource: "ia", transcriptionInaccurate: false, summary: "resumo" });
    // por identificar e sem GPS
    expect(evidenceSnapshotOf({ ...ROW, person: null, position: null, actions: [], transcription: null })).toMatchObject({ employeeId: null, personName: null, projectId: null, position: null, actions: [], transcription: null, transcriptionSource: null });
  });

  it("selo: JSON estável (a ordem das chaves não muda o selo; mudar o texto muda)", () => {
    expect(stableJson({ b: 1, a: [2, { d: null, c: "x" }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    const s = evidenceSnapshotOf(ROW);
    const meta = { situation: "Dano", reference: null, notes: null, savedById: 1, savedAtIso: "2026-10-06T10:00:00Z" };
    expect(evidenceSealInput(s, meta)).toBe(evidenceSealInput({ ...s }, { ...meta }));
    expect(evidenceSealInput(s, meta)).not.toBe(evidenceSealInput({ ...s, transcription: "outro" }, meta));
  });

  it("situação obrigatória; referência e notas limpas e com limites", () => {
    expect(cleanEvidenceInput({ situation: "  dano   na porta " , reference: "  ", notes: "" })).toEqual({ situation: "dano na porta", reference: null, notes: null });
    expect(cleanEvidenceInput({ situation: "ok" })).toEqual({ error: expect.stringMatching(/situação/) });
    expect(cleanEvidenceInput({ situation: "x".repeat(201) })).toEqual({ error: expect.stringMatching(/200/) });
    expect(cleanEvidenceInput({ situation: "Dano", reference: "r".repeat(101) })).toEqual({ error: expect.stringMatching(/100/) });
    expect(EVIDENCE_MAX_PER_SAVE).toBe(10);
  });

  it("texto para imprimir: hora de Lisboa, quem, transcrição, GPS, Multipark, áudio e selo", () => {
    const t = evidenceText({ ...evidenceSnapshotOf(ROW), id: 9, situation: "Dano na porta", reference: "B123", notes: "Cliente reclamou",
      savedByName: "Jorge", savedAt: "2026-10-06 10:00:00", contentHash: "a".repeat(64), hasAudio: false, audioNote: "O Zello ainda estava a preparar o áudio", archivedAt: null, archiveReason: null });
    expect(t).toContain("Prova #9 — Dano na porta");
    expect(t).toContain("Referência: B123");
    expect(t).toContain("06/10/2026, 10:15:10 (hora de Lisboa)");
    expect(t).toContain("Quem falou: Ana Silva (check-in no PDA pda7)");
    expect(t).toContain("Transcrição (Zello, pode ter erros): o carro tem um risco na porta");
    expect(t).toContain("Posição: 31 km/h em 38.77000, -9.13000 (GPS −12 s)");
    expect(t).toContain("10:16:00 Saída (check-out) · AA-00-AA · reserva B123 · Airpark (+50 s)");
    expect(t).toContain("Áudio: O Zello ainda estava a preparar o áudio");
    expect(t).toContain("selo aaaaaaaaaaaaaaaa");
  });
});

// ─── Guardar: volta a ler no Zello; nada vem do browser ─────────────────────
const h = vi.hoisted(() => ({ executed: [] as string[], params: [] as unknown[][], search: vi.fn(), existing: [] as any[] }));
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const chunks = q?.queryChunks ?? [];
      const text = chunks.map((c: any) => (typeof c === "string" ? c : Array.isArray(c?.value) ? c.value.join("") : "?")).join("");
      h.executed.push(text);
      if (/SELECT id, zelloMessageId FROM radio_evidence/.test(text)) return [h.existing];
      if (/INSERT INTO radio_evidence/.test(text)) return [{ insertId: 501 }];
      return [[]];
    },
  }),
}));
vi.mock("./radioZello", () => ({ searchZelloRadio: h.search }));

describe("34a — guardar como prova", () => {
  it("relê cada mensagem no Zello à volta da hora, do remetente, com o âmbito de cidade; grava a fotografia", async () => {
    h.executed = []; h.existing = [];
    h.search.mockResolvedValue({ available: true, messages: [{ ...ROW, mediaKey: null }], hasMore: false, notices: [] });
    const { saveRadioEvidence } = await import("./radioEvidence");
    const r = await saveRadioEvidence({ picks: [{ id: 77, at: ROW.at, sender: "pda7" }], input: { situation: "Dano na porta" }, userId: 4, scopeProjectIds: [3] });
    expect(h.search).toHaveBeenCalledWith({ fromMs: ROW.at - 30_000, toMs: ROW.at + 30_000, user: "pda7", scopeProjectIds: [3] });
    expect(r).toEqual({ saved: [{ messageId: 77, id: 501, audio: "none" }], already: [], failed: [] });
    expect(h.executed.some((t) => /INSERT INTO radio_evidence/.test(t))).toBe(true);
  });

  it("não encontrada (ou de outra cidade) falha só essa; já guardada não duplica; situação curta recusa tudo", async () => {
    h.executed = []; h.existing = [{ id: 300, zelloMessageId: 88 }];
    h.search.mockResolvedValue({ available: true, messages: [], hasMore: false, notices: [] });
    const { saveRadioEvidence } = await import("./radioEvidence");
    const r = await saveRadioEvidence({ picks: [{ id: 77, at: ROW.at, sender: "pda7" }, { id: 88, at: ROW.at, sender: "pda8" }], input: { situation: "Dano na porta" }, userId: 4 });
    expect(r.already).toEqual([{ messageId: 88, id: 300 }]);
    expect(r.failed).toEqual([{ messageId: 77, reason: expect.stringMatching(/Não a encontrei/) }]);
    expect(h.executed.some((t) => /INSERT INTO radio_evidence/.test(t))).toBe(false);
    await expect(saveRadioEvidence({ picks: [{ id: 1, at: 1, sender: "x" }], input: { situation: "ok" }, userId: 4 })).rejects.toThrow(/situação/);
    await expect(saveRadioEvidence({ picks: Array.from({ length: 11 }, (_, i) => ({ id: i + 1, at: 1, sender: "x" })), input: { situation: "Dano" }, userId: 4 })).rejects.toThrow(/10/);
  });
});

describe("34a — BD, rotas, ficheiros e ecrã", () => {
  it("tabela só acrescenta; provas nunca se apagam (arquivar com motivo)", () => {
    const m = src("server/migrations/migration_0485.ts");
    expect(m).toContain("CREATE TABLE IF NOT EXISTS `radio_evidence`");
    expect(m).not.toMatch(/DROP|DELETE|UPDATE /);
    expect(src("server/migrations/index.ts")).toContain(`["0485", () => import("./migration_0485")`);
    const s = src("server/radioEvidence.ts");
    expect(s).not.toMatch(/DELETE FROM radio_evidence/);
    expect(s).toContain("SET archivedAt = UTC_TIMESTAMP(), archivedById = ${userId}, archiveReason");
    // o áudio só do Zello e para o prefixo radio/
    expect(s).toContain(`if (!/(^|\\.)zellowork\\.com$/.test(host)) throw new Error("O áudio não veio do Zello.");`);
    expect(s).toContain("storagePut(`radio/evidence/${id}-${row.zelloMessageId}.${ext}`");
  });

  it("o áudio guardado só abre com o módulo Rádio", () => {
    expect(fileAccessRule("radio/evidence/5-77.mp3")).toEqual({ kind: "module", modules: ["radio"] });
  });

  it("rotas: guardar/juntar áudio = editar; ver = ver; arquivar = gerir; todas com o âmbito de cidade", () => {
    const r = src("server/operationalRouter.ts");
    expect(r).toMatch(/evidenceSave: protectedProcedure[\s\S]{0,500}requireAccess\(ctx\.user, "radio", "edit"\)/);
    expect(r).toMatch(/evidenceList: protectedProcedure[\s\S]{0,300}requireAccess\(ctx\.user, "radio", "view"\)/);
    expect(r).toMatch(/evidenceAttachAudio: protectedProcedure[\s\S]{0,200}requireAccess\(ctx\.user, "radio", "edit"\)[\s\S]{0,300}getRadioEvidence\(input\.id, scopedProjectIds\(\)\)/);
    expect(r).toMatch(/evidenceAudioUrl: protectedProcedure[\s\S]{0,200}requireAccess\(ctx\.user, "radio", "view"\)[\s\S]{0,400}getRadioEvidence\(input\.id, scopedProjectIds\(\)\)/);
    expect(r).toMatch(/evidenceArchive: protectedProcedure[\s\S]{0,200}requireAccess\(ctx\.user, "radio", "manage"\)/);
    expect(r).toContain("picks: z.array(z.object({");
  });

  it("ecrã: escolher mensagens, Prova #N, separador Provas com imprimir", () => {
    const z = src("client/src/components/radio/ZelloRadioSearch.tsx");
    expect(z).toContain('aria-label="Escolher para guardar como prova"');
    expect(z).toContain("Prova #{m.evidenceId}");
    expect(z).toContain("<EvidenceSaveDialog");
    const p = src("client/src/pages/RadioPage.tsx");
    expect(p).toContain('<TabsTrigger value="provas">Provas</TabsTrigger>');
    expect(p).toContain("<RadioEvidenceList />");
    const e = src("client/src/components/radio/RadioEvidence.tsx");
    expect(e).toContain("Imprimir / PDF");
    expect(e).toContain("const esc = ");
  });
});
