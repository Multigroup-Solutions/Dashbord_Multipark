/**
 * Passagem de turno — AUTOMAÇÃO (regras puras, cliente + servidor).
 *
 *  - turno seguinte / anterior e janelas UTC de cada turno (Europe/Lisbon);
 *  - pendentes que passam de turno (carry-over) com `resolved` por item;
 *  - lembrete de passagem em falta (~15:30 manhã, ~03:30 noite);
 *  - estado de cumprimento (a tempo / atrasada / em falta / confirmada);
 *  - material simplificado ("Material OK?" + exceções) e campos por cidade;
 *  - texto do email para o team leader do turno seguinte.
 * Nada aqui toca na BD nem no relógio do browser.
 */
import { addDays, lisbonDayOf } from "./lisbonDay";
import {
  HANDOVER_CITY_LABELS,
  NIGHT_START_HOUR,
  OPERATIONAL_DAY_START_HOUR,
  lisbonLocalTimeUtcMs,
  type HandoverCity,
  type HandoverShift,
} from "./shiftHandover";

export interface ShiftRef { date: string; shift: HandoverShift }

export const SHIFT_LABELS: Record<HandoverShift, string> = { morning: "Manhã", night: "Noite" };

/** Turno que recebe a passagem: manhã D → noite D; noite D → manhã D+1. */
export function nextShiftOf(s: ShiftRef): ShiftRef {
  return s.shift === "morning" ? { date: s.date, shift: "night" } : { date: addDays(s.date, 1), shift: "morning" };
}

/** Turno anterior: manhã D → noite D-1; noite D → manhã D. */
export function previousShiftOf(s: ShiftRef): ShiftRef {
  return s.shift === "morning" ? { date: addDays(s.date, -1), shift: "night" } : { date: s.date, shift: "morning" };
}

/** Horas de relógio (Lisboa) em que o turno começa/acaba (a noite passa das 24). */
export function shiftHours(shift: HandoverShift): { start: number; end: number } {
  return shift === "morning"
    ? { start: OPERATIONAL_DAY_START_HOUR, end: NIGHT_START_HOUR }
    : { start: NIGHT_START_HOUR, end: 24 + OPERATIONAL_DAY_START_HOUR };
}

const mysqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Janela UTC [start, end) de um turno. */
export function shiftWindowUtc(s: ShiftRef): { start: string; end: string; startMs: number; endMs: number } {
  const h = shiftHours(s.shift);
  const startMs = lisbonLocalTimeUtcMs(s.date, h.start);
  const endMs = lisbonLocalTimeUtcMs(s.date, h.end);
  return { start: mysqlTs(startMs), end: mysqlTs(endMs), startMs, endMs };
}

/** Hora de Lisboa (0–26) de um instante relativo ao dia `date` (a noite passa das 24). */
export function lisbonHourInShift(date: string, ms: number): number {
  // Horas de relógio contadas pelo offset do próprio instante (DST).
  for (let h = 0; h < 30; h++) {
    if (lisbonLocalTimeUtcMs(date, h + 1) > ms) return h;
  }
  return 30;
}

// ─── Lembretes (cron horário, ~15:30 e ~03:30 de Lisboa) ────────────────────

/** Minutos depois do fim do turno a partir dos quais a passagem conta como atrasada / se lembra. */
export const HANDOVER_GRACE_MINUTES = 30;
/** Até quantas horas depois do prazo o cron ainda lembra (downtime não gera lembretes antigos). */
export const HANDOVER_REMINDER_WINDOW_HOURS = 6;

/** Instante (ms) em que a passagem de um turno passa a estar em atraso (fim + 30 min). */
export function handoverDueAtMs(s: ShiftRef): number {
  return shiftWindowUtc(s).endMs + HANDOVER_GRACE_MINUTES * 60_000;
}

/**
 * Turnos cujo lembrete está na altura: o prazo (fim + 30 min) já passou há
 * menos de 6h. Às 16:07 → manhã de hoje; às 04:07 → noite de ontem.
 */
export function remindersDue(nowMs: number): ShiftRef[] {
  const out: ShiftRef[] = [];
  // Candidatos: turnos de ontem/hoje (a noite de ontem acaba hoje às 03:00).
  const today = lisbonDayOf(nowMs);
  for (const date of [addDays(today, -2), addDays(today, -1), today]) {
    for (const shift of ["morning", "night"] as const) {
      const due = handoverDueAtMs({ date, shift });
      if (nowMs >= due && nowMs < due + HANDOVER_REMINDER_WINDOW_HOURS * 3_600_000) out.push({ date, shift });
    }
  }
  return out;
}

/** Decide quem precisa de lembrete: só cidades com turno ativo, sem passagem e ainda sem lembrete. */
export function citiesNeedingReminder(input: {
  citiesWithShift: string[];
  citiesWithHandover: string[];
  citiesAlreadyReminded: string[];
}): string[] {
  const done = new Set([...input.citiesWithHandover, ...input.citiesAlreadyReminded]);
  return [...new Set(input.citiesWithShift)].filter((c) => !done.has(c)).sort();
}

// ─── Cumprimento ("Resumo do dia") ──────────────────────────────────────────

export type ComplianceStatus = "pending" | "missing" | "late" | "on_time" | "confirmed";
export const COMPLIANCE_LABELS: Record<ComplianceStatus, string> = {
  pending: "turno a decorrer",
  missing: "em falta",
  late: "atrasada",
  on_time: "entregue a tempo",
  confirmed: "confirmada (Recebi)",
};

/**
 * Estado de uma passagem. `createdAtMs` = criação (autor original), `ackAtMs`
 * = "Recebi". Confirmada ganha a tudo; sem registo → em falta só depois do prazo.
 */
export function complianceStatus(s: ShiftRef, rec: { createdAtMs: number | null; ackAtMs: number | null } | null, nowMs: number): { status: ComplianceStatus; late: boolean } {
  const due = handoverDueAtMs(s);
  if (!rec || rec.createdAtMs == null) return { status: nowMs >= due ? "missing" : "pending", late: false };
  const late = rec.createdAtMs > due;
  if (rec.ackAtMs != null) return { status: "confirmed", late };
  return { status: late ? "late" : "on_time", late };
}

/** % de turnos (terminados) com passagem entregue a tempo. null sem turnos. */
export function compliancePercent(rows: Array<{ status: ComplianceStatus; late: boolean }>): number | null {
  const ended = rows.filter((r) => r.status !== "pending");
  if (!ended.length) return null;
  const ok = ended.filter((r) => r.status !== "missing" && !r.late).length;
  return Math.round((ok / ended.length) * 100);
}

/** Diferença de caixa (bolsas front + terminal) em relação à passagem anterior; null quando irrelevante. */
export const CASH_DIFF_THRESHOLD = 5;
export function cashDifference(
  cur: { frontPouchValue?: unknown; terminalPouchValue?: unknown } | null,
  prev: { frontPouchValue?: unknown; terminalPouchValue?: unknown } | null,
): number | null {
  const total = (r: typeof cur): number | null => {
    if (!r) return null;
    const vals = [r.frontPouchValue, r.terminalPouchValue].filter((v) => v != null && v !== "").map(Number).filter(Number.isFinite);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const a = total(cur);
  const b = total(prev);
  if (a == null || b == null) return null;
  const diff = Math.round((a - b) * 100) / 100;
  return Math.abs(diff) >= CASH_DIFF_THRESHOLD ? diff : null;
}

// ─── Pendentes que passam de turno (carry-over) ─────────────────────────────

export const OPEN_ITEM_KINDS = ["note", "complaint", "lost_found", "pda", "incident", "delivery"] as const;
export type OpenItemKind = (typeof OPEN_ITEM_KINDS)[number];
export const OPEN_ITEM_LABELS: Record<OpenItemKind, string> = {
  note: "Nota", complaint: "Reclamação", lost_found: "Perdidos e achados", pda: "PDA", incident: "Ocorrência", delivery: "Entrega pendente",
};
export const OPEN_ITEMS_MAX = 60;

export interface OpenItem {
  /** Chave estável: `kind:refId` para entidades, `note:<texto normalizado>` para notas. */
  key: string;
  kind: OpenItemKind;
  refId?: number | string | null;
  text: string;
  resolved: boolean;
  resolvedAt?: string | null;
  resolvedByName?: string | null;
  /** Turno em que apareceu pela 1.ª vez. */
  since?: string | null;
}

const normText = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export function openItemKey(kind: OpenItemKind, refIdOrText: number | string): string {
  return kind === "note" ? `note:${normText(String(refIdOrText)).slice(0, 120)}` : `${kind}:${refIdOrText}`;
}

/** Linhas das notas em lista ("- ", "* ", "• ", "[ ]") viram pendentes. */
export function extractNoteItems(notes: string | null | undefined, since?: string): OpenItem[] {
  const out: OpenItem[] = [];
  for (const raw of String(notes ?? "").split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:[-*•]|\[\s?\])\s+(.{3,})$/);
    if (!m) continue;
    const text = m[1].trim().slice(0, 300);
    out.push({ key: openItemKey("note", text), kind: "note", text, resolved: false, since: since ?? null });
  }
  return out;
}

/**
 * Lista sugerida para o turno que agora preenche:
 *  1. pendentes NÃO resolvidos da passagem anterior (mantêm `since`);
 *  2. entidades ainda abertas no rascunho (reclamações, perdidos, PDAs…);
 *  3. entidades que vinham da passagem anterior mas já não estão abertas no
 *     rascunho → resolvidas automaticamente ("sistema").
 * Os itens já presentes no formulário (`current`) prevalecem (flag do utilizador).
 */
export function mergeCarryOver(input: {
  previous: OpenItem[];
  draft: OpenItem[];
  current?: OpenItem[];
  /** Tipos que o rascunho consegue confirmar como ainda abertos. */
  draftKinds?: OpenItemKind[];
  nowIso?: string;
}): OpenItem[] {
  const draftKeys = new Set(input.draft.map((i) => i.key));
  const checkable = new Set(input.draftKinds ?? ["complaint", "lost_found", "pda", "incident", "delivery"]);
  const byKey = new Map<string, OpenItem>();
  for (const p of input.previous) {
    if (p.resolved) continue;
    const autoResolved = p.kind !== "note" && checkable.has(p.kind) && !draftKeys.has(p.key);
    byKey.set(p.key, autoResolved
      ? { ...p, resolved: true, resolvedAt: input.nowIso ?? null, resolvedByName: "sistema" }
      : { ...p });
  }
  for (const d of input.draft) if (!byKey.has(d.key)) byKey.set(d.key, { ...d });
  for (const c of input.current ?? []) byKey.set(c.key, { ...(byKey.get(c.key) ?? {}), ...c });
  return [...byKey.values()].slice(0, OPEN_ITEMS_MAX);
}

/**
 * Gravação: a resolução é monotónica — um item resolvido na BD (p.ex. pela
 * passagem seguinte) não volta a abrir porque um formulário antigo o trazia aberto.
 */
export function mergeStoredOpenItems(stored: OpenItem[], incoming: OpenItem[]): OpenItem[] {
  const prev = new Map(stored.map((i) => [i.key, i]));
  return incoming.slice(0, OPEN_ITEMS_MAX).map((i) => {
    const s = prev.get(i.key);
    if (s?.resolved && !i.resolved) return { ...i, resolved: true, resolvedAt: s.resolvedAt ?? null, resolvedByName: s.resolvedByName ?? null };
    return i;
  });
}

/** JSON da BD → lista válida (texto inválido → []). */
export function parseOpenItems(raw: unknown): OpenItem[] {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  return v
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .filter((i) => typeof i.key === "string" && typeof i.text === "string" && (OPEN_ITEM_KINDS as readonly string[]).includes(String(i.kind)))
    .map((i) => ({
      key: String(i.key).slice(0, 160),
      kind: i.kind as OpenItemKind,
      refId: (typeof i.refId === "number" || typeof i.refId === "string") ? i.refId : null,
      text: String(i.text).slice(0, 300),
      resolved: !!i.resolved,
      resolvedAt: typeof i.resolvedAt === "string" ? i.resolvedAt : null,
      resolvedByName: typeof i.resolvedByName === "string" ? i.resolvedByName : null,
      since: typeof i.since === "string" ? i.since : null,
    }))
    .slice(0, OPEN_ITEMS_MAX);
}

// ─── Material simplificado + campos por cidade ──────────────────────────────

export const MATERIAL_EXCEPTIONS = ["pens", "mb_rolls", "mb_rolls_pouch", "mb_battery", "terminal_pouch", "other"] as const;
export type MaterialException = (typeof MATERIAL_EXCEPTIONS)[number];
export const MATERIAL_EXCEPTION_LABELS: Record<MaterialException, string> = {
  pens: "Faltam canetas",
  mb_rolls: "Poucos rolos de MB",
  mb_rolls_pouch: "Faltam rolos MB na bolsa do terminal",
  mb_battery: "Bateria do MB baixa",
  terminal_pouch: "Problema na bolsa do terminal",
  other: "Outro",
};
export interface MaterialExceptionItem { code: MaterialException; note?: string | null }

export interface HandoverCityFields {
  /** Bolsa do terminal (valor, rolos e canetas na bolsa). */
  terminalPouch: boolean;
  /** Carros p/ coberto. */
  coveredCars: boolean;
}

/**
 * Configuração por cidade. Decisão do dono (set 2026): a bolsa do terminal
 * existe em TODAS as cidades (incluindo Faro e Porto) — já não há exceção.
 */
export const HANDOVER_CITY_FIELDS: Record<HandoverCity, HandoverCityFields> = {
  lisbon: { terminalPouch: true, coveredCars: true },
  porto: { terminalPouch: true, coveredCars: true },
  faro: { terminalPouch: true, coveredCars: true },
};

// ─── Carros p/ coberto (automático) ─────────────────────────────────────────
//
// REGRA (sinal escolhido — a Multipark não tem um evento "movido para o
// coberto"; o que existe é o evento de histórico `MOVEMENT`/`MOVE`, com
// `modifiedFields.garagem/lugar`, que regista qualquer mudança de lugar):
//  1. reserva de lugar COBERTO: `spotType = 'covered'` (classificado pelo nº de
//     allocation 5000–7999, ver server/spotClassification.ts) OU
//     `parkingType = 'COVERED'` (produto coberto comprado);
//  2. carro NO PARQUE: estado `CHECKED_IN` (recebido, ainda sem entrega —
//     CHECKING_OUT/PENDING_CHECKOUT/CHECKED_OUT já estão a sair/saíram);
//  3. SEM movimento depois da receção: nenhum evento MOVEMENT/MOVE com
//     `actionTime` >= último CHECK_IN (ou >= `checkIn` quando o evento de
//     CHECK_IN ainda não foi sincronizado). O 1.º movimento depois da receção
//     é, na operação, a ida do carro da zona de receção para o lugar coberto.

export interface CoveredCarCandidate {
  externalId: string;
  bookingNumber: string | null;
  plate: string | null;
  parkName: string | null;
  status: string | null;
  spotType: string | null;
  parkingType: string | null;
  /** Instante (ms) do último CHECK_IN (histórico) ou do `checkIn` previsto. */
  checkInMs: number | null;
  /** Instante (ms) do último MOVEMENT/MOVE. */
  lastMoveMs: number | null;
}

export const IN_PARK_STATUSES = ["CHECKED_IN"] as const;

export function isCoveredBooking(b: { spotType: string | null; parkingType: string | null }): boolean {
  return String(b.spotType ?? "").toLowerCase() === "covered" || String(b.parkingType ?? "").toUpperCase() === "COVERED";
}

/** Carros que ainda têm de ir para o coberto (ordenados por check-in). */
export function coveredCarsPending(rows: CoveredCarCandidate[], nowMs: number = Date.now()): CoveredCarCandidate[] {
  return rows
    .filter((b) => isCoveredBooking(b))
    .filter((b) => (IN_PARK_STATUSES as readonly string[]).includes(String(b.status ?? "").toUpperCase()))
    .filter((b) => b.checkInMs == null || b.checkInMs <= nowMs)
    .filter((b) => b.lastMoveMs == null || (b.checkInMs != null && b.lastMoveMs < b.checkInMs))
    .sort((a, b) => (a.checkInMs ?? 0) - (b.checkInMs ?? 0));
}

export function materialExceptionsFor(city: HandoverCity): MaterialException[] {
  const f = HANDOVER_CITY_FIELDS[city];
  return MATERIAL_EXCEPTIONS.filter((c) => f.terminalPouch || (c !== "mb_rolls_pouch" && c !== "terminal_pouch"));
}

export function parseMaterialExceptions(raw: unknown): MaterialExceptionItem[] {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  return v
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object" && (MATERIAL_EXCEPTIONS as readonly string[]).includes(String(i.code)))
    .map((i) => ({ code: i.code as MaterialException, note: typeof i.note === "string" && i.note.trim() ? i.note.trim().slice(0, 200) : null }))
    .slice(0, MATERIAL_EXCEPTIONS.length);
}

// ─── Resumo automático (forma partilhada) ───────────────────────────────────

export interface DraftBookingRow {
  externalId: string;
  bookingNumber: string | null;
  time: string; // HH:MM Lisboa
  clientName: string;
  plate: string | null;
  flight: string | null;
  remainingToPay: number | null;
  spotType: string | null;
  deliveryType: string | null;
}

export interface HandoverDraftCounts {
  checkinsNext: number;
  checkoutsNext: number;
  pendingDeliveries: number;
  complaintsNew: number;
  complaintsOpen: number;
  lostFoundOpen: number;
  incidentsOpen: number;
  whatsappUnread: number;
  pdasCheckedIn: number;
  clockInsOpen: number;
  speedAlerts: number;
  gpsAlerts: number;
  toCollectEur: number;
}

/** Contagens-chave (texto curto) — email, notificações e IA. */
export function draftKeyLines(c: HandoverDraftCounts): string[] {
  const eur = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;
  const lines = [
    `Recolhas no próximo turno: ${c.checkinsNext}`,
    `Entregas no próximo turno: ${c.checkoutsNext}${c.toCollectEur > 0 ? ` (a cobrar ${eur(c.toCollectEur)})` : ""}`,
    `Entregas pendentes (sem check-out): ${c.pendingDeliveries}`,
    `Reclamações novas no turno: ${c.complaintsNew} · abertas: ${c.complaintsOpen}`,
    `Perdidos e achados abertos: ${c.lostFoundOpen}`,
    `Ocorrências abertas: ${c.incidentsOpen}`,
    `WhatsApp por ler: ${c.whatsappUnread}`,
    `PDAs ainda com check-in: ${c.pdasCheckedIn}`,
    `Picagens de entrada sem saída: ${c.clockInsOpen}`,
    `Alertas de velocidade/GPS no turno: ${c.speedAlerts}/${c.gpsAlerts}`,
  ];
  return lines;
}

// ─── Email ao team leader do turno seguinte ─────────────────────────────────

export function handoverEmailSubject(city: HandoverCity, s: ShiftRef): string {
  return `Passagem de turno — ${HANDOVER_CITY_LABELS[city]} ${s.date} ${SHIFT_LABELS[s.shift]}`;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Corpo do email (texto + HTML): resumo IA (ou simples) + contagens + pendentes + link. */
export function buildHandoverEmail(input: {
  city: HandoverCity;
  shift: ShiftRef;
  authorName: string | null;
  aiSummary: string | null;
  counts: HandoverDraftCounts | null;
  notes: string | null;
  openItems: OpenItem[];
  link: string;
}): { subject: string; text: string; html: string } {
  const subject = handoverEmailSubject(input.city, input.shift);
  const summary = (input.aiSummary ?? "").trim()
    || [input.notes?.trim() ? `Notas: ${input.notes.trim()}` : "", "Sem resumo automático — vê os números abaixo."].filter(Boolean).join("\n");
  const keys = input.counts ? draftKeyLines(input.counts) : [];
  const open = input.openItems.filter((i) => !i.resolved);
  const text = [
    `${subject}${input.authorName ? ` (por ${input.authorName})` : ""}`,
    "",
    "Resumo:",
    summary,
    ...(keys.length ? ["", "Números-chave:", ...keys.map((l) => `- ${l}`)] : []),
    "",
    open.length ? `Pendentes (${open.length}):` : "Sem pendentes.",
    ...open.map((i) => `- [${OPEN_ITEM_LABELS[i.kind]}] ${i.text}`),
    "",
    `Abrir a passagem de turno: ${input.link}`,
  ].join("\n");
  const li = (s: string) => `<li>${escHtml(s)}</li>`;
  const html = [
    `<h2 style="margin:0 0 8px">${escHtml(subject)}</h2>`,
    input.authorName ? `<p style="color:#666;margin:0 0 12px">por ${escHtml(input.authorName)}</p>` : "",
    `<h3>Resumo</h3><p>${escHtml(summary).replace(/\n/g, "<br>")}</p>`,
    keys.length ? `<h3>Números-chave</h3><ul>${keys.map(li).join("")}</ul>` : "",
    open.length ? `<h3>Pendentes (${open.length})</h3><ul>${open.map((i) => li(`[${OPEN_ITEM_LABELS[i.kind]}] ${i.text}`)).join("")}</ul>` : "<p>Sem pendentes.</p>",
    `<p><a href="${escHtml(input.link)}">Abrir a passagem de turno</a></p>`,
  ].join("");
  return { subject, text, html };
}

/** Normaliza a resposta do LLM em até 5 linhas "• …". */
export function normalizeAiBullets(raw: string): string | null {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 1)
    .slice(0, 5);
  return lines.length ? lines.map((l) => `• ${l.slice(0, 300)}`).join("\n") : null;
}

/** Acrescenta aos pendentes as linhas em lista das notas (sem repetir). */
export function withNoteItems(items: OpenItem[], notes: string | null | undefined, since: string): OpenItem[] {
  const keys = new Set(items.map((i) => i.key));
  const extra = extractNoteItems(notes, since).filter((i) => !keys.has(i.key));
  return [...items, ...extra].slice(0, OPEN_ITEMS_MAX);
}
