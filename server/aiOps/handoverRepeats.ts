/**
 * Passagem de turno: pendentes que se REPETEM entre passagens seguidas
 * (deteção no código, por semelhança de texto) e resumo semanal por cidade.
 * A IA só redige (as linhas e o parágrafo); a contagem é do código.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { parseOpenItems, type OpenItem } from "../../shared/shiftHandoverAuto";
import { HANDOVER_REPEATS_SYSTEM, HANDOVER_WEEKLY_SYSTEM } from "../_core/ai/prompts/ops";
import { AiCallCap, tryAi } from "./aiCall";
import { OPS_CITY_LABELS, type OpsCity } from "./cities";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];

// ─── Semelhança (PURA) ───────────────────────────────────────────────────────

const STOP = new Set(["a", "o", "as", "os", "de", "do", "da", "dos", "das", "e", "em", "no", "na", "nos", "nas", "um", "uma", "para", "por", "com", "que", "ao", "aos", "se", "ja", "ainda", "falta", "pendente"]);

export function normalizeItemText(s: string): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalizeItemText(s).split(" ").filter((t) => t.length > 1 && !STOP.has(t)));
}

function bigrams(s: string): string[] {
  const t = normalizeItemText(s).replace(/ /g, "");
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** Semelhança 0–1: o máximo entre Jaccard de palavras e Dice de bigramas. PURA. */
export function textSimilarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  let jac = 0;
  if (ta.size && tb.size) {
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    jac = inter / (ta.size + tb.size - inter);
  }
  const ba = bigrams(a), bb = bigrams(b);
  let dice = 0;
  if (ba.length && bb.length) {
    const counts = new Map<string, number>();
    for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
    let inter = 0;
    for (const g of bb) { const c = counts.get(g) ?? 0; if (c > 0) { inter++; counts.set(g, c - 1); } }
    dice = (2 * inter) / (ba.length + bb.length);
  }
  return Math.max(jac, dice);
}

export const SIMILARITY_THRESHOLD = 0.72;

export function sameItem(a: OpenItem, b: OpenItem, threshold = SIMILARITY_THRESHOLD): boolean {
  if (a.key && a.key === b.key) return true;
  return textSimilarity(a.text, b.text) >= threshold;
}

export interface HandoverSnapshot { date: string; shift: string; items: OpenItem[] }
export interface RepeatedItem { text: string; count: number; since: string; kind: string }

/**
 * Pendentes NÃO resolvidos da passagem mais recente que aparecem (por chave
 * ou texto parecido, resolvidos ou não) nas passagens imediatamente
 * anteriores. `count` = nº de passagens SEGUIDAS em que aparece (≥ minCount).
 * `snapshots` do mais recente para o mais antigo. PURA.
 */
export function detectRepeatedItems(snapshots: HandoverSnapshot[], opts: { minCount?: number; threshold?: number } = {}): RepeatedItem[] {
  const minCount = opts.minCount ?? 2;
  if (!snapshots.length) return [];
  const [latest, ...older] = snapshots;
  const out: RepeatedItem[] = [];
  for (const item of latest.items.filter((i) => !i.resolved)) {
    let count = 1;
    let since = `${latest.date} ${latest.shift}`;
    for (const snap of older) {
      if (!snap.items.some((o) => sameItem(item, o, opts.threshold))) break;
      count++;
      since = `${snap.date} ${snap.shift}`;
    }
    if (count >= minCount) out.push({ text: item.text, count, since, kind: item.kind });
  }
  return out.sort((a, b) => b.count - a.count);
}

// ─── BD ──────────────────────────────────────────────────────────────────────

/** Últimas `n` passagens da cidade (mais recente primeiro; noite depois da manhã). */
export async function loadHandoverSnapshots(city: OpsCity, n = 8, untilDay?: string): Promise<HandoverSnapshot[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = rowsOf(await db.execute(sql`
    SELECT handoverDate, shift, openItems FROM shift_handovers
     WHERE city = ${city} ${untilDay ? sql`AND handoverDate <= ${untilDay}` : sql``}
     ORDER BY handoverDate DESC, FIELD(shift, 'night', 'morning')
     LIMIT ${n}`));
  return rows.map((r) => ({ date: String(r.handoverDate), shift: String(r.shift), items: parseOpenItems(r.openItems) }));
}

export async function repeatedItemsFor(city: OpsCity): Promise<{ latest: HandoverSnapshot | null; pending: OpenItem[]; repeated: RepeatedItem[] }> {
  const snaps = await loadHandoverSnapshots(city);
  const latest = snaps[0] ?? null;
  return { latest, pending: latest ? latest.items.filter((i) => !i.resolved) : [], repeated: detectRepeatedItems(snaps) };
}

/** Linhas redigidas pela IA (mesma ordem); sem IA → o texto original com a contagem. */
export async function phraseRepeatedItems(items: RepeatedItem[], cap: AiCallCap): Promise<{ lines: string[]; ai: boolean }> {
  const fallback = items.map((i) => `- ${i.text} (há ${i.count} passagens seguidas)`);
  if (!items.length) return { lines: [], ai: false };
  const res = await tryAi({
    feature: "handover_repeats", system: HANDOVER_REPEATS_SYSTEM, cap, maxTokens: 60 * items.length + 80, entity: "shift_handover",
    input: items.slice(0, 12).map((i, n) => `${n + 1}. ${i.text.slice(0, 200)} — ${i.count} passagens seguidas`).join("\n"),
  });
  if (!res.ok) return { lines: fallback, ai: false };
  const lines = res.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("-")).slice(0, items.length);
  return lines.length === Math.min(items.length, 12) ? { lines, ai: true } : { lines: fallback, ai: false };
}

// ─── Resumo semanal por cidade ───────────────────────────────────────────────

export interface HandoverWeekData {
  city: OpsCity;
  from: string;
  to: string;
  expectedShifts: number;
  filled: number;
  acknowledged: number;
  pendingOpen: number;
  resolvedItems: number;
  repeated: RepeatedItem[];
}

/** Agregado da semana (PURO, a partir das linhas da BD). */
export function aggregateHandoverWeek(input: {
  city: OpsCity; from: string; to: string;
  shiftsWithScale: Array<{ date: string; shift: string }>;
  handovers: Array<{ date: string; shift: string; acked: boolean; items: OpenItem[] }>;
  repeated: RepeatedItem[];
}): HandoverWeekData {
  const key = (d: string, s: string) => `${d}|${s}`;
  const expected = new Set(input.shiftsWithScale.map((s) => key(s.date, s.shift)));
  for (const h of input.handovers) expected.add(key(h.date, h.shift));
  const latest = [...input.handovers].sort((a, b) => (a.date === b.date ? (a.shift === "night" ? -1 : 1) : a.date < b.date ? 1 : -1))[0];
  return {
    city: input.city, from: input.from, to: input.to,
    expectedShifts: expected.size,
    filled: input.handovers.length,
    acknowledged: input.handovers.filter((h) => h.acked).length,
    pendingOpen: latest ? latest.items.filter((i) => !i.resolved).length : 0,
    resolvedItems: input.handovers.reduce((s, h) => s + h.items.filter((i) => i.resolved).length, 0),
    repeated: input.repeated,
  };
}

export async function buildHandoverWeek(city: OpsCity, from: string, to: string): Promise<HandoverWeekData> {
  const db = await getDb();
  if (!db) return aggregateHandoverWeek({ city, from, to, shiftsWithScale: [], handovers: [], repeated: [] });
  const scale = rowsOf(await db.execute(sql`
    SELECT DISTINCT assignmentDate, shift FROM extras_dia_assignments
     WHERE city = ${city} AND assignmentDate >= ${from} AND assignmentDate <= ${to}`));
  const hs = rowsOf(await db.execute(sql`
    SELECT handoverDate, shift, openItems, ackAt FROM shift_handovers
     WHERE city = ${city} AND handoverDate >= ${from} AND handoverDate <= ${to}`));
  const snaps = await loadHandoverSnapshots(city, 10, to);
  return aggregateHandoverWeek({
    city, from, to,
    shiftsWithScale: scale.map((r) => ({ date: String(r.assignmentDate), shift: String(r.shift) })),
    handovers: hs.map((r) => ({ date: String(r.handoverDate), shift: String(r.shift), acked: r.ackAt != null, items: parseOpenItems(r.openItems) })),
    repeated: detectRepeatedItems(snaps),
  });
}

export function handoverWeekFacts(d: HandoverWeekData): string[] {
  return [
    `Cidade: ${OPS_CITY_LABELS[d.city]}. Semana ${d.from} a ${d.to}.`,
    `Passagens preenchidas: ${d.filled} de ${d.expectedShifts} turnos com escala; confirmadas ("Recebi"): ${d.acknowledged}.`,
    `Pendentes resolvidos na semana: ${d.resolvedItems}. Pendentes em aberto na última passagem: ${d.pendingOpen}.`,
    ...(d.repeated.length ? [`Pendentes que se repetem: ${d.repeated.slice(0, 8).map((r) => `${r.text.slice(0, 120)} (${r.count} passagens)`).join(" | ")}`] : ["Sem pendentes repetidos."]),
  ];
}

export function handoverWeekFallback(d: HandoverWeekData): string {
  const pct = d.expectedShifts ? Math.round((d.filled / d.expectedShifts) * 100) : null;
  return [
    `${OPS_CITY_LABELS[d.city]}: ${d.filled} passagens de ${d.expectedShifts} turnos${pct != null ? ` (${pct}%)` : ""}, ${d.acknowledged} confirmadas.`,
    `${d.resolvedItems} pendentes resolvidos; ${d.pendingOpen} em aberto na última passagem.`,
    d.repeated.length ? `${d.repeated.length} pendente(s) repetem-se entre turnos — o mais antigo há ${d.repeated[0].count} passagens.` : "",
  ].filter(Boolean).join(" ");
}

export async function handoverWeekNarrative(d: HandoverWeekData, cap: AiCallCap): Promise<{ text: string; ai: boolean }> {
  const res = await tryAi({ feature: "handover_repeats", system: HANDOVER_WEEKLY_SYSTEM, input: handoverWeekFacts(d).join("\n"), cap, maxTokens: 350, entity: "shift_handover" });
  return res.ok && res.output.trim() ? { text: res.output.trim().slice(0, 1500), ai: true } : { text: handoverWeekFallback(d), ai: false };
}


const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Email do resumo semanal da passagem de turno (cidade). PURA. */
export function renderHandoverWeekEmail(d: HandoverWeekData, narrative: string, appUrl: string): { subject: string; html: string; text: string } {
  const city = OPS_CITY_LABELS[d.city];
  const period = `${d.from.slice(8, 10)}/${d.from.slice(5, 7)}–${d.to.slice(8, 10)}/${d.to.slice(5, 7)}`;
  const subject = `Passagem de turno ${city} — semana ${period}: ${d.filled}/${d.expectedShifts} preenchidas`;
  const rep = d.repeated.length
    ? `<h3 style="font-size:15px;margin:16px 0 6px">A repetir-se entre turnos</h3><ul style="font-size:13px;padding-left:18px">${d.repeated.map((r) => `<li>${esc(r.text)} — <b>${r.count} passagens seguidas</b></li>`).join("")}</ul>`
    : "";
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#1b2430;max-width:720px">
    <h2 style="font-size:18px;margin:0 0 6px">Passagem de turno — ${esc(city)}, semana ${period}</h2>
    <p style="font-size:14px;line-height:1.45;background:#f4f6fa;border-radius:8px;padding:10px 12px">${esc(narrative)}</p>
    <p style="font-size:13px">${d.filled} de ${d.expectedShifts} passagens preenchidas · ${d.acknowledged} confirmadas · ${d.resolvedItems} pendentes resolvidos · ${d.pendingOpen} em aberto</p>
    ${rep}
    <p style="font-size:12px;color:#667;margin-top:18px"><a href="${appUrl}/passagem-turno">Abrir a Passagem de turno</a></p></div>`;
  const text = [`Passagem de turno — ${city}, semana ${period}`, "", narrative, "", `${d.filled}/${d.expectedShifts} preenchidas, ${d.acknowledged} confirmadas, ${d.resolvedItems} resolvidos, ${d.pendingOpen} em aberto`,
    ...d.repeated.map((r) => `- ${r.text} (${r.count} passagens)`), "", `${appUrl}/passagem-turno`].join("\n");
  return { subject, html, text };
}
