/**
 * P3 lote 32a — Rádio: gravações do Zello × GPS × Multipark (regras em
 * shared/radioCross.ts).
 *
 * Para um intervalo (máx. 24 h) e, se se quiser, um utilizador do Zello ou um
 * canal: lê as mensagens de voz do histórico do Zello (com a transcrição do
 * Zello quando a rede a tem), descobre QUEM falou (o PDA é partilhado: quem
 * tinha o check-in no PDA a essa hora; senão a ficha com esse Zello), e junta
 * a cada mensagem o ponto GPS mais perto (posição e velocidade, do histórico
 * de localização do Zello) e as ações dessa pessoa na Multipark à volta da
 * hora (entradas, saídas, movimentos — com reserva, matrícula e parque).
 * Só lê. Quem só vê a sua cidade só vê quem é dessa cidade.
 */
import { sql } from "drizzle-orm";
import { holderAt, mapZelloMessage, nearestPoint, actionsNear, type GpsPoint, type MpAction, type RadioMessage } from "../shared/radioCross";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const mysqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const toMs = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(`${String(v).replace(" ", "T")}Z`));
export const RADIO_PAGE = 100;
const MAX_SENDERS_GPS = 20;

export interface RadioPerson { employeeId: number; name: string; projectId: number | null; via: "pda" | "ficha" }

export interface RadioSearchRow extends RadioMessage {
  person: RadioPerson | null;
  position: (GpsPoint & { deltaS: number }) | null;
  actions: Array<MpAction & { deltaS: number }>;
  aiTranscription: { id: number; text: string; summary: string | null } | null;
  /** 34a: prova ativa desta mensagem (se já foi guardada) */
  evidenceId: number | null;
}

export async function searchZelloRadio(o: {
  fromMs: number; toMs: number; user?: string | null; channel?: string | null; includeReceived?: boolean; start?: number;
  scopeProjectIds?: number[] | undefined;
}) {
  const { getZelloHistoryMetadata, getZelloUserHistory, isZelloConfigured } = await import("./zello");
  if (!isZelloConfigured()) return { available: false as const, reason: "O Zello não está configurado (Integrações)." };
  const notices: string[] = [];
  const startTs = Math.floor(o.fromMs / 1000), endTs = Math.ceil(o.toMs / 1000);
  const base = { startTs, endTs, type: "voice" as const, max: RADIO_PAGE, start: o.start ?? 0, viaChannel: o.channel ?? undefined };
  let raw: any[] = [];
  let total: number | null = null;
  try {
    const sent = await getZelloHistoryMetadata({ ...base, sender: o.user ?? undefined });
    raw = sent.messages; total = sent.total;
    if (o.user && o.includeReceived) {
      const got = await getZelloHistoryMetadata({ ...base, recipient: o.user });
      const seen = new Set(raw.map((m) => Number(m.id)));
      raw = [...raw, ...got.messages.filter((m) => !seen.has(Number(m.id)))];
      if (got.total != null) total = (total ?? 0) + got.total;
    }
  } catch (err) {
    return { available: false as const, reason: `O Zello não respondeu: ${String((err as Error)?.message ?? err).slice(0, 160)}` };
  }
  const messages = raw.map(mapZelloMessage).filter((m): m is RadioMessage => !!m).sort((a, b) => a.at - b.at || a.id - b.id);
  const hasMore = raw.length >= RADIO_PAGE;

  // ── Quem falou: PDA com check-in a essa hora; senão a ficha com esse Zello ──
  const { getDb } = await import("./db");
  const db = await getDb();
  const senders = [...new Set(messages.map((m) => m.sender))];
  const intervals = new Map<string, Array<{ employeeId: number; start: number; end: number }>>();
  const byZello = new Map<string, number>();
  const emps = new Map<number, { name: string; projectId: number | null; agentIds: string[] }>();
  if (db && senders.length) {
    const list = sql.join(senders.map((s) => sql`${s}`), sql`, `);
    for (const r of rowsOf(await db.execute(sql`SELECT COALESCE(p.zelloUsername, c.zelloUsername) AS zu, c.employeeId, c.checkinAt, c.checkoutAt
        FROM pda_checkins c LEFT JOIN pdas p ON p.id = c.pdaId
       WHERE COALESCE(p.zelloUsername, c.zelloUsername) IN (${list}) AND c.employeeId IS NOT NULL
         AND c.checkinAt < ${mysqlTs(o.toMs)} AND (c.checkoutAt IS NULL OR c.checkoutAt >= ${mysqlTs(o.fromMs)})`).catch(() => [[]]))) {
      const l = intervals.get(String(r.zu)) ?? [];
      l.push({ employeeId: Number(r.employeeId), start: toMs(r.checkinAt), end: r.checkoutAt ? toMs(r.checkoutAt) : Date.now() });
      intervals.set(String(r.zu), l);
    }
    for (const r of rowsOf(await db.execute(sql`SELECT id, zelloUsername FROM employees WHERE zelloUsername IN (${list}) ORDER BY isActive DESC, id`))) {
      if (!byZello.has(String(r.zelloUsername))) byZello.set(String(r.zelloUsername), Number(r.id));
    }
    const ids = [...new Set([...[...intervals.values()].flat().map((i) => i.employeeId), ...byZello.values()])];
    if (ids.length) {
      const idList = sql.join(ids.map((x) => sql`${x}`), sql`, `);
      const aliases = rowsOf(await db.execute(sql`SELECT employeeId, agentUserId FROM employee_agents WHERE employeeId IN (${idList})`).catch(() => [[]]));
      for (const r of rowsOf(await db.execute(sql`SELECT id, fullName, projectId, multiparkAgentUserId FROM employees WHERE id IN (${idList})`))) {
        const id = Number(r.id);
        emps.set(id, {
          name: String(r.fullName ?? ""), projectId: r.projectId == null ? null : Number(r.projectId),
          agentIds: [...new Set([String(r.multiparkAgentUserId ?? "").trim(), ...aliases.filter((a) => Number(a.employeeId) === id).map((a) => String(a.agentUserId))].filter(Boolean))],
        });
      }
    }
  }
  const personOf = (m: RadioMessage): RadioPerson | null => {
    const pda = holderAt(intervals.get(m.sender), m.at);
    const id = pda ?? byZello.get(m.sender) ?? null;
    const e = id != null ? emps.get(id) : undefined;
    return e && id != null ? { employeeId: id, name: e.name, projectId: e.projectId, via: pda != null ? "pda" : "ficha" } : null;
  };
  let rows = messages.map((m) => ({ m, person: personOf(m) }));
  // Âmbito de cidade: só quem se sabe ser das cidades de quem vê
  if (o.scopeProjectIds) {
    const scope = new Set(o.scopeProjectIds);
    const before = rows.length;
    rows = rows.filter((r) => r.person?.projectId != null && scope.has(r.person.projectId));
    if (rows.length < before) notices.push(`${before - rows.length} mensagem(ns) de pessoas de outras cidades (ou por identificar) não aparecem.`);
  }

  // ── GPS: o histórico de localização de cada utilizador do Zello no intervalo ──
  const gps = new Map<string, GpsPoint[]>();
  const { zelloTimestamp, zelloAccuracyOk, zelloSpeedKmh } = await import("./zelloGps");
  const gpsSenders = [...new Set(rows.map((r) => r.m.sender))].slice(0, MAX_SENDERS_GPS);
  if ([...new Set(rows.map((r) => r.m.sender))].length > MAX_SENDERS_GPS) notices.push(`GPS só dos primeiros ${MAX_SENDERS_GPS} utilizadores (escolhe um utilizador para ver o de todos).`);
  const readGps = async (u: string) => {
    try {
      const data = await getZelloUserHistory(u, startTs - 300, endTs + 300);
      const pts: GpsPoint[] = [];
      for (const f of Array.isArray(data?.features) ? data.features : []) {
        const p = f?.properties ?? {};
        const ts = zelloTimestamp(p);
        if (ts <= 0) continue;
        const ok = zelloAccuracyOk(p);
        const c = f?.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
        const lat = ok && c && Number.isFinite(c[1]) && (c[0] !== 0 || c[1] !== 0) ? Number(c[1]) : null;
        const lon = lat != null ? Number(c[0]) : null;
        pts.push({ at: ts * 1000, lat, lon, speed: ok ? zelloSpeedKmh(p) : 0 });
      }
      gps.set(u, pts);
    } catch { /* sem GPS desse utilizador */ }
  };
  // 5 de cada vez (a API do Zello não gosta de rajadas)
  for (let i = 0; i < gpsSenders.length; i += 5) await Promise.all(gpsSenders.slice(i, i + 5).map(readGps));
  if (gpsSenders.length && gps.size < gpsSenders.length) notices.push("O GPS de alguns utilizadores não veio do Zello.");

  // ── Multipark: ações dos agentes de quem falou, 15 min à volta do intervalo ──
  const agentIds = [...new Set(rows.flatMap((r) => (r.person ? emps.get(r.person.employeeId)?.agentIds ?? [] : [])))];
  let actions: MpAction[] = [];
  if (agentIds.length) {
    const [{ readRadioActions }, { safeMultiparkRead }] = await Promise.all([import("./multiparkDb/radioActions"), import("./multiparkDb/read")]);
    const r = await safeMultiparkRead("rádio (ações)", () => readRadioActions({ agentIds, fromMs: o.fromMs - 15 * 60_000, toMs: o.toMs + 15 * 60_000 }));
    if (r.available) actions = r.data; else notices.push(`A Multipark não respondeu: ${r.reason}`);
  }

  // ── Transcrições feitas cá (IA) para mensagens do Zello sem transcrição ──
  const ai = new Map<number, { id: number; text: string; summary: string | null }>();
  if (db && rows.length) {
    const ids = sql.join(rows.map((r) => sql`${r.m.id}`), sql`, `);
    for (const r of rowsOf(await db.execute(sql`SELECT id, zelloMessageId, transcription, summary FROM radio_transcriptions WHERE zelloMessageId IN (${ids}) ORDER BY id`).catch(() => [[]]))) {
      ai.set(Number(r.zelloMessageId), { id: Number(r.id), text: String(r.transcription ?? ""), summary: r.summary ?? null });
    }
  }

  // 34a: mensagens já guardadas como prova
  const { activeEvidenceByMessage } = await import("./radioEvidence");
  const evidence = await activeEvidenceByMessage(rows.map((r) => r.m.id));

  const out: RadioSearchRow[] = rows.map(({ m, person }) => ({
    ...m, person,
    position: nearestPoint(gps.get(m.sender) ?? [], m.at),
    actions: person ? actionsNear(actions, new Set(emps.get(person.employeeId)?.agentIds ?? []), m.at) : [],
    aiTranscription: ai.get(m.id) ?? null,
    evidenceId: evidence.get(m.id) ?? null,
  }));
  return { available: true as const, messages: out, hasMore, total, nextStart: (o.start ?? 0) + RADIO_PAGE, notices };
}

/** Link temporário do áudio de uma mensagem do Zello (MP3). */
export async function zelloMediaUrl(key: string) {
  const { getZelloMedia } = await import("./zello");
  return getZelloMedia(key);
}

/**
 * Transcreve com a IA uma mensagem do Zello que o Zello não transcreveu; fica
 * gravada ligada à mensagem (não se paga duas vezes). O áudio vem do próprio
 * Zello (link pedido aqui, nunca um endereço vindo do browser).
 */
export async function transcribeZelloMessage(o: { messageId: number; mediaKey: string; durationS?: number | null; userId: number }) {
  const { getDb, createRadioTranscription } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const existing = rowsOf(await db.execute(sql`SELECT id, transcription, summary FROM radio_transcriptions WHERE zelloMessageId = ${o.messageId} ORDER BY id LIMIT 1`))[0];
  if (existing) return { id: Number(existing.id), transcription: String(existing.transcription ?? ""), summary: existing.summary ?? null, reused: true };
  const media = await zelloMediaUrl(o.mediaKey);
  if (!media.ready || !media.url) return { pending: true as const, progress: media.progress };
  const host = new URL(media.url).hostname;
  if (!/(^|\.)zellowork\.com$/.test(host)) throw new Error("O áudio não veio do Zello.");
  const { transcribeAndSummarizeRadio } = await import("./radioAi");
  const { transcription, summary } = await transcribeAndSummarizeRadio(media.url, { userId: o.userId });
  const id = await createRadioTranscription({
    audioUrl: null, transcription, summary, employeeId: null, vehicleId: null,
    duration: o.durationS == null ? null : Math.round(o.durationS),
    transcribedAt: mysqlTs(Date.now()), createdById: o.userId, zelloMessageId: o.messageId,
  } as any);
  return { id: Number(id), transcription, summary, reused: false };
}
