/**
 * P3 lote 34a — Rádio: guardar mensagens como prova (Jorge, 6 out 2026): "o
 * rádio devia dar opção para se guardar alguns registos com o histórico e a
 * transcrição para servir de prova para algumas situações; o som não está cá,
 * mas ok, a transcrição chega."
 *
 * Uma "prova" é a fotografia de uma mensagem do Zello tal como estava quando
 * foi guardada: quem falou, quando, para quem, a transcrição (Zello ou IA), a
 * posição/velocidade e o que a pessoa fez na Multipark à volta da hora —
 * mais a situação (motivo), a referência e quem guardou. Não se edita nem se
 * apaga; arquiva-se com motivo. Regras PURAS.
 */

/** No máximo isto de mensagens de uma vez (cada uma volta a ser lida no Zello). */
export const EVIDENCE_MAX_PER_SAVE = 10;
export const EVIDENCE_SITUATION_MAX = 200;
export const EVIDENCE_REFERENCE_MAX = 100;
export const EVIDENCE_NOTES_MAX = 2000;

export interface EvidencePosition { lat: number | null; lon: number | null; speed: number; deltaS: number }
export interface EvidenceAction { at: number; changeType: string; bookingCode: string | null; plate: string | null; park: string | null; deltaS: number }

/** O que fica gravado de uma mensagem (e entra no "selo" de integridade). */
export interface EvidenceSnapshot {
  zelloMessageId: number;
  /** instante UTC (ms) */
  at: number;
  sender: string;
  senderName: string | null;
  recipient: string | null;
  recipientType: string | null;
  durationS: number | null;
  employeeId: number | null;
  personName: string | null;
  personVia: "pda" | "ficha" | null;
  projectId: number | null;
  transcription: string | null;
  transcriptionSource: "zello" | "ia" | null;
  transcriptionInaccurate: boolean;
  summary: string | null;
  position: EvidencePosition | null;
  actions: EvidenceAction[];
  mediaKey: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SearchRowLike = any;

/** Linha da pesquisa do Zello (32a) → fotografia da prova. PURA. */
export function evidenceSnapshotOf(m: SearchRowLike): EvidenceSnapshot {
  const zello = typeof m.transcription === "string" && m.transcription.trim() ? m.transcription.trim() : null;
  const ia = typeof m.aiTranscription?.text === "string" && m.aiTranscription.text.trim() ? m.aiTranscription.text.trim() : null;
  const p = m.position;
  return {
    zelloMessageId: Number(m.id),
    at: Number(m.at),
    sender: String(m.sender),
    senderName: m.senderName ?? null,
    recipient: m.recipient ?? null,
    recipientType: m.recipientType ?? null,
    durationS: m.durationS == null ? null : Number(m.durationS),
    employeeId: m.person?.employeeId ?? null,
    personName: m.person?.name ?? null,
    personVia: m.person?.via ?? null,
    projectId: m.person?.projectId ?? null,
    transcription: zello ?? ia,
    transcriptionSource: zello ? "zello" : ia ? "ia" : null,
    transcriptionInaccurate: zello ? !!m.transcriptionInaccurate : false,
    summary: zello ? null : (m.aiTranscription?.summary ?? null),
    position: p ? { lat: p.lat ?? null, lon: p.lon ?? null, speed: Math.round(Number(p.speed) * 10) / 10, deltaS: Number(p.deltaS) } : null,
    actions: Array.isArray(m.actions) ? m.actions.map((a: SearchRowLike) => ({
      at: Number(a.at), changeType: String(a.changeType ?? ""), bookingCode: a.bookingCode ?? null, plate: a.plate ?? null, park: a.park ?? null, deltaS: Number(a.deltaS),
    })) : [],
    mediaKey: m.mediaKey ?? null,
  };
}

/** JSON estável (chaves por ordem) — a base do selo. PURA. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

/** O que se escreve no selo: a fotografia + situação/referência/notas + quem e quando. PURA. */
export function evidenceSealInput(s: EvidenceSnapshot, meta: { situation: string; reference: string | null; notes: string | null; savedById: number; savedAtIso: string }): string {
  return stableJson({ ...s, ...meta });
}

export interface EvidenceInput { situation: string; reference?: string | null; notes?: string | null }
/** Valida e limpa a situação/referência/notas. PURA. */
export function cleanEvidenceInput(i: EvidenceInput): { situation: string; reference: string | null; notes: string | null } | { error: string } {
  const situation = String(i.situation ?? "").replace(/\s+/g, " ").trim();
  if (situation.length < 3) return { error: "Diz em poucas palavras a situação (para que serve esta prova)." };
  if (situation.length > EVIDENCE_SITUATION_MAX) return { error: `A situação tem de ter no máximo ${EVIDENCE_SITUATION_MAX} caracteres.` };
  const reference = String(i.reference ?? "").replace(/\s+/g, " ").trim() || null;
  if (reference && reference.length > EVIDENCE_REFERENCE_MAX) return { error: `A referência tem de ter no máximo ${EVIDENCE_REFERENCE_MAX} caracteres.` };
  const notes = String(i.notes ?? "").trim() || null;
  if (notes && notes.length > EVIDENCE_NOTES_MAX) return { error: `As notas têm de ter no máximo ${EVIDENCE_NOTES_MAX} caracteres.` };
  return { situation, reference, notes };
}

const CHANGE: Record<string, string> = { CHECK_IN: "Entrada (check-in)", CHECK_OUT: "Saída (check-out)", MOVEMENT: "Movimento", CHECKING_IN: "A entrar", CHECKING_OUT: "A sair" };
const lisbon = (ms: number, withDate = true) => new Intl.DateTimeFormat("pt-PT", {
  timeZone: "Europe/Lisbon", ...(withDate ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", second: "2-digit",
}).format(new Date(ms));
const delta = (s: number) => { const a = Math.abs(s); const sign = s > 0 ? "+" : s < 0 ? "−" : ""; return a < 90 ? `${sign}${a} s` : `${sign}${Math.round(a / 60)} min`; };

export interface EvidenceRecord extends EvidenceSnapshot {
  id: number; situation: string; reference: string | null; notes: string | null;
  savedByName: string | null; savedAt: string; contentHash: string;
  hasAudio: boolean; audioNote: string | null; archivedAt: string | null; archiveReason: string | null;
}

/** A prova em texto (imprimir / copiar). Horas de Lisboa. PURA. */
export function evidenceText(e: EvidenceRecord): string {
  const who = e.personName ?? e.senderName ?? e.sender;
  const lines = [
    `Prova #${e.id} — ${e.situation}`,
    ...(e.reference ? [`Referência: ${e.reference}`] : []),
    `Mensagem de rádio (Zello #${e.zelloMessageId}) — ${lisbon(e.at)} (hora de Lisboa)`,
    `Quem falou: ${who}${e.personVia === "pda" ? ` (check-in no PDA ${e.sender})` : e.personVia === "ficha" ? ` (Zello ${e.sender})` : ` (Zello ${e.sender}, pessoa por identificar)`}`,
    ...(e.recipient ? [`Para: ${e.recipientType === "channel" ? `canal ${e.recipient}` : e.recipient}`] : []),
    ...(e.durationS != null ? [`Duração: ${e.durationS} s`] : []),
    `Transcrição${e.transcriptionSource === "zello" ? ` (Zello${e.transcriptionInaccurate ? ", pode ter erros" : ""})` : e.transcriptionSource === "ia" ? " (IA)" : ""}: ${e.transcription ?? "sem transcrição"}`,
    ...(e.summary ? [`Resumo (IA): ${e.summary}`] : []),
    e.position
      ? `Posição: ${Math.round(e.position.speed)} km/h${e.position.lat != null && e.position.lon != null ? ` em ${e.position.lat.toFixed(5)}, ${e.position.lon.toFixed(5)}` : ""} (GPS ${delta(e.position.deltaS)})`
      : "Posição: sem GPS do Zello nesses 5 minutos",
    e.actions.length
      ? `Multipark (10 min antes/depois):\n${e.actions.map((a) => `  - ${lisbon(a.at, false)} ${CHANGE[a.changeType] ?? a.changeType}${a.plate ? ` · ${a.plate}` : ""}${a.bookingCode ? ` · reserva ${a.bookingCode}` : ""}${a.park ? ` · ${a.park}` : ""} (${delta(a.deltaS)})`).join("\n")}`
      : `Multipark: ${e.employeeId == null ? "sem pessoa identificada" : "sem ações 10 min antes ou depois"}`,
    ...(e.notes ? [`Notas: ${e.notes}`] : []),
    `Áudio: ${e.hasAudio ? "guardado" : e.audioNote ?? "não guardado"}`,
    `Guardada por ${e.savedByName ?? "—"} em ${e.savedAt} (UTC) · selo ${e.contentHash.slice(0, 16)}`,
    ...(e.archivedAt ? [`ARQUIVADA em ${e.archivedAt} (UTC)${e.archiveReason ? `: ${e.archiveReason}` : ""}`] : []),
  ];
  return lines.join("\n");
}
