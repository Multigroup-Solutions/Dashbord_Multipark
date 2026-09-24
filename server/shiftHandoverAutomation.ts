/**
 * Passagem de turno — automação à volta da gravação:
 *  - depois de gravar: fotografia do resumo automático, resumo por IA (se
 *    houver LLM), pendentes resolvidos na passagem anterior, notificação e
 *    EMAIL ao(s) team leader(s) do turno seguinte (idempotente por versão);
 *  - "Recebi" do team leader que entra;
 *  - lembretes do cron horário (~15:30 / ~03:30) quando falta a passagem;
 *  - cumprimento para o "Resumo do dia".
 * Nada disto pode fazer falhar a gravação: tudo em try/catch.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { cityNameScope } from "./cityScope";
import { extractAffectedRows } from "./availabilityFormToken";
import {
  buildClaimEmailVersion,
  buildHandoverAck,
  buildHandoverCurrent,
  buildHandoverMetaUpdate,
  buildHandoverOpenItemsUpdate,
  buildHandoverRange,
} from "./shiftHandoverSql";
import { buildHandoverDraft, draftSnapshot, type HandoverDraft } from "./shiftHandoverDraft";
import { HANDOVER_CITIES, HANDOVER_CITY_LABELS, type HandoverCity, type HandoverShift } from "../shared/shiftHandover";
import {
  SHIFT_LABELS,
  buildHandoverEmail,
  cashDifference,
  citiesNeedingReminder,
  complianceStatus,
  compliancePercent,
  draftKeyLines,
  nextShiftOf,
  normalizeAiBullets,
  parseOpenItems,
  previousShiftOf,
  remindersDue,
  type ComplianceStatus,
  type OpenItem,
  type ShiftRef,
} from "../shared/shiftHandoverAuto";
import { addDays } from "../shared/lisbonDay";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];

export function appOrigin(): string {
  return (process.env.APP_URL || process.env.PUBLIC_APP_URL || "https://dashboard.multipark.pt").replace(/\/+$/, "");
}

export function llmConfigured(): boolean {
  return !!(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

/** Email ligado? (`HANDOVER_EMAIL=off` desliga; sem SMTP salta em silêncio.) */
export function handoverEmailEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if ((env.HANDOVER_EMAIL ?? "").trim().toLowerCase() === "off") return false;
  return !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

/** CC opcional (`HANDOVER_EMAIL_CC`, separado por vírgulas/;), sem repetidos nem os "to". */
export function handoverEmailCc(raw: string | undefined, to: string[]): string[] {
  const seen = new Set(to.map((e) => e.toLowerCase()));
  const out: string[] = [];
  for (const e of String(raw ?? "").split(/[,;\s]+/)) {
    const v = e.trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]);
  } finally { if (t) clearTimeout(t); }
}

// ─── Team leaders de um turno (escala Extras-Dia) ───────────────────────────

export interface ShiftLeader { employeeId: number | null; name: string; userId: number | null; email: string | null }

export async function shiftTeamLeaders(s: ShiftRef, city: string): Promise<ShiftLeader[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = rowsOf(await db.execute(sql`
    SELECT a.employeeId, a.personName, e.userId, COALESCE(NULLIF(e.email, ''), u.email) AS email
    FROM extras_dia_assignments a
    LEFT JOIN employees e ON e.id = a.employeeId
    LEFT JOIN users u ON u.id = e.userId AND u.isActive = 1
    WHERE a.assignmentDate = ${s.date} AND a.shift = ${s.shift} AND a.city = ${city} AND a.isTeamLeader = 1`));
  return rows.map((r) => ({
    employeeId: r.employeeId == null ? null : Number(r.employeeId),
    name: String(r.personName ?? ""),
    userId: r.userId == null ? null : Number(r.userId),
    email: typeof r.email === "string" && r.email.includes("@") ? r.email.trim().toLowerCase() : null,
  }));
}

// ─── IA ─────────────────────────────────────────────────────────────────────

export function aiPrompt(d: HandoverDraft | null, input: { city: HandoverCity; shift: ShiftRef; notes: string | null; openItems: OpenItem[] }): string {
  const lines = [
    `Cidade: ${HANDOVER_CITY_LABELS[input.city]}. Turno que termina: ${input.shift.date} ${SHIFT_LABELS[input.shift.shift]}.`,
    ...(d ? draftKeyLines(d.counts) : []),
    d?.people.next.length ? `Equipa do turno seguinte: ${d.people.next.map((p) => `${p.name}${p.isTeamLeader ? " (TL)" : ""}`).join(", ")}` : "",
    d?.byHour.length ? `Picos (recolhas/entregas por hora): ${d.byHour.filter((h) => h.checkins + h.checkouts > 0).map((h) => `${h.label} ${h.checkins}/${h.checkouts}`).join("; ")}` : "",
    input.notes?.trim() ? `Notas do team leader: ${input.notes.trim().slice(0, 1500)}` : "",
    input.openItems.filter((i) => !i.resolved).length ? `Pendentes: ${input.openItems.filter((i) => !i.resolved).map((i) => i.text).slice(0, 25).join(" | ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** 5 pontos em PT-PT para o turno seguinte; null se a IA não estiver configurada ou falhar. */
export async function generateAiSummary(d: HandoverDraft | null, input: { city: HandoverCity; shift: ShiftRef; notes: string | null; openItems: OpenItem[] }): Promise<string | null> {
  if (!llmConfigured()) return null;
  try {
    const { invokeLLM } = await import("./_core/llm");
    const r = await withTimeout(invokeLLM({
      messages: [
        { role: "system", content: "És o assistente de operações da Multipark (parque de estacionamento com recolha e entrega de carros no aeroporto). Escreve em português de Portugal (PT-PT), nunca em português do Brasil. Responde APENAS com 5 pontos curtos (uma linha cada, a começar por \"- \") para o team leader do turno seguinte: prioridades, picos de trabalho, pendentes e riscos. Não inventes dados." },
        { role: "user", content: aiPrompt(d, input) },
      ],
      maxTokens: 600,
    }), 20_000);
    const content = r.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? "").join("") : "";
    return normalizeAiBullets(text);
  } catch (err: any) {
    console.warn("[handover] IA falhou:", String(err?.message ?? err).slice(0, 200));
    return null;
  }
}

/** Guarda o resumo IA pedido no ecrã, se a passagem já existir. */
export async function saveHandoverAiSummary(key: { handoverDate: string; shift: HandoverShift; city: HandoverCity }, text: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const row = rowsOf(await db.execute(buildHandoverCurrent(key)))[0];
  const q = row ? buildHandoverMetaUpdate(Number(row.id), { aiSummary: text }) : null;
  if (!q) return false;
  await db.execute(q);
  return true;
}

// ─── Depois de gravar ───────────────────────────────────────────────────────

export interface AfterSaveResult { aiSummary: boolean; emailed: number; notified: number; previousResolved: number }

export async function afterHandoverSave(input: {
  key: { handoverDate: string; shift: HandoverShift; city: HandoverCity };
  mode: "insert" | "update";
  userId: number;
  userName: string | null;
}): Promise<AfterSaveResult> {
  const out: AfterSaveResult = { aiSummary: false, emailed: 0, notified: 0, previousResolved: 0 };
  const db = await getDb();
  if (!db) return out;
  const ref: ShiftRef = { date: input.key.handoverDate, shift: input.key.shift };
  const row = rowsOf(await db.execute(buildHandoverCurrent(input.key)))[0];
  if (!row) return out;
  const id = Number(row.id);
  const version = Number(row.version ?? 1);
  const openItems = parseOpenItems(row.openItems);

  let draft: HandoverDraft | null = null;
  try { draft = await buildHandoverDraft({ date: ref.date, shift: ref.shift, city: input.key.city }); } catch (err: any) {
    console.warn("[handover] rascunho falhou:", String(err?.message ?? err).slice(0, 200));
  }

  // 1. Pendentes resolvidos agora → marca-os também na passagem anterior
  try {
    const prev = previousShiftOf(ref);
    const prevRow = rowsOf(await db.execute(buildHandoverCurrent({ handoverDate: prev.date, shift: prev.shift, city: input.key.city })))[0];
    if (prevRow) {
      const resolvedNow = new Map(openItems.filter((i) => i.resolved).map((i) => [i.key, i]));
      let changed = 0;
      const prevItems = parseOpenItems(prevRow.openItems).map((i) => {
        const r = resolvedNow.get(i.key);
        if (!i.resolved && r) { changed++; return { ...i, resolved: true, resolvedAt: r.resolvedAt ?? new Date().toISOString(), resolvedByName: r.resolvedByName ?? input.userName }; }
        return i;
      });
      if (changed) {
        await db.execute(buildHandoverOpenItemsUpdate(Number(prevRow.id), JSON.stringify(prevItems)));
        out.previousResolved = changed;
      }
    }
  } catch (err: any) { console.warn("[handover] pendentes anteriores:", String(err?.message ?? err).slice(0, 200)); }

  // 2. Resumo automático + IA (nunca bloqueia a gravação)
  const ai = await generateAiSummary(draft, { city: input.key.city, shift: ref, notes: row.notes ?? null, openItems });
  out.aiSummary = !!ai;
  try {
    const q = buildHandoverMetaUpdate(id, { ...(draft ? { autoSummary: draftSnapshot(draft) } : {}), ...(ai ? { aiSummary: ai } : {}) });
    if (q) await db.execute(q);
  } catch (err: any) { console.warn("[handover] guardar resumo:", String(err?.message ?? err).slice(0, 200)); }

  // 3. Team leader(s) do turno seguinte: notificação (1.ª gravação) + email (por versão)
  const next = nextShiftOf(ref);
  let leaders: ShiftLeader[] = [];
  try { leaders = await shiftTeamLeaders(next, input.key.city); } catch { /* sem escala */ }
  const cityLabel = HANDOVER_CITY_LABELS[input.key.city];
  if (input.mode === "insert") {
    try {
      const { createNotification } = await import("./complaintsExtended");
      for (const uid of new Set(leaders.map((l) => l.userId).filter((u): u is number => u != null && u !== input.userId))) {
        await createNotification({
          userId: uid,
          title: `Passagem de turno — ${cityLabel} ${SHIFT_LABELS[ref.shift]}`,
          body: `${input.userName ?? "O team leader"} entregou a passagem de ${ref.date}. Abre e carrega em "Recebi".`,
          kind: "handover",
          link: "/passagem-turno",
        });
        out.notified++;
      }
    } catch (err: any) { console.warn("[handover] notificação:", String(err?.message ?? err).slice(0, 200)); }
  }

  if (handoverEmailEnabled()) {
    try {
      const to = [...new Set(leaders.map((l) => l.email).filter((e): e is string => !!e))];
      const cc = handoverEmailCc(process.env.HANDOVER_EMAIL_CC, to);
      if ((to.length || cc.length) && extractAffectedRows(await db.execute(buildClaimEmailVersion(id, version))) > 0) {
        const mail = buildHandoverEmail({
          city: input.key.city, shift: ref, authorName: row.createdByName ?? input.userName,
          aiSummary: ai ?? row.aiSummary ?? null, counts: draft?.counts ?? null, notes: row.notes ?? null,
          openItems, link: `${appOrigin()}/passagem-turno`,
        });
        const { sendEmail } = await import("./_core/notification");
        const recipients = to.length ? to : cc;
        const ok = await sendEmail({
          to: recipients.join(", "),
          ...(to.length && cc.length ? { cc: cc.join(", ") } : {}),
          subject: mail.subject, text: mail.text, html: mail.html,
        });
        if (ok) out.emailed = recipients.length + (to.length ? cc.length : 0);
        else {
          // Falhou: devolve a versão para a próxima gravação voltar a tentar.
          const q = buildHandoverMetaUpdate(id, { emailSentVersion: row.emailSentVersion == null ? null : Number(row.emailSentVersion) });
          if (q) await db.execute(q);
        }
      }
    } catch (err: any) { console.warn("[handover] email:", String(err?.message ?? err).slice(0, 200)); }
  }
  return out;
}

// ─── "Recebi" ────────────────────────────────────────────────────────────────

export async function ackHandover(id: number, city: HandoverCity, user: { id: number; name: string | null }): Promise<{ ok: true } | { ok: false; message: string }> {
  const db = await getDb();
  if (!db) return { ok: false, message: "BD indisponível" };
  const row = rowsOf(await db.execute(sql`SELECT id, city, createdById, ackAt FROM shift_handovers WHERE id = ${id} AND city = ${city} AND ${cityNameScope(sql`city`)} LIMIT 1`))[0];
  if (!row) return { ok: false, message: "Passagem de turno não encontrada" };
  if (row.createdById != null && Number(row.createdById) === user.id) return { ok: false, message: "Quem entrega a passagem não a pode confirmar — é o team leader do turno seguinte que carrega em \"Recebi\"" };
  if (row.ackAt != null) return { ok: false, message: "Esta passagem já foi confirmada" };
  const n = extractAffectedRows(await db.execute(buildHandoverAck(id, user)));
  return n > 0 ? { ok: true } : { ok: false, message: "Esta passagem já foi confirmada" };
}

// ─── Lembretes (cron horário) ───────────────────────────────────────────────

export async function runHandoverReminders(now: Date = new Date()): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (process.env.HANDOVER_REMINDERS === "off") return out;
  const db = await getDb();
  if (!db) return out;
  for (const s of remindersDue(now.getTime())) {
    const k = `${s.date}:${s.shift}`;
    const withShift = rowsOf(await db.execute(sql`SELECT DISTINCT city FROM extras_dia_assignments WHERE assignmentDate = ${s.date} AND shift = ${s.shift}`)).map((r) => String(r.city));
    if (!withShift.length) continue;
    const withHandover = rowsOf(await db.execute(sql`SELECT city FROM shift_handovers WHERE handoverDate = ${s.date} AND shift = ${s.shift}`)).map((r) => String(r.city));
    const reminded = rowsOf(await db.execute(sql`SELECT city FROM shift_handover_reminders WHERE handoverDate = ${s.date} AND shift = ${s.shift}`)).map((r) => String(r.city));
    const due = citiesNeedingReminder({ citiesWithShift: withShift.filter((c) => (HANDOVER_CITIES as readonly string[]).includes(c)), citiesWithHandover: withHandover, citiesAlreadyReminded: reminded });
    for (const city of due) {
      // Reserva (dia, turno, cidade): só quem insere envia — idempotente entre corridas.
      const claimed = extractAffectedRows(await db.execute(sql`INSERT IGNORE INTO shift_handover_reminders (handoverDate, shift, city, recipients) VALUES (${s.date}, ${s.shift}, ${city}, 0)`)) > 0;
      if (!claimed) continue;
      const label = HANDOVER_CITY_LABELS[city as HandoverCity] ?? city;
      const title = `Falta a passagem de turno — ${label} ${SHIFT_LABELS[s.shift]}`;
      const body = `A passagem de turno de ${s.date} (${SHIFT_LABELS[s.shift].toLowerCase()}) em ${label} ainda não foi preenchida.`;
      let sent = 0;
      try {
        const { createNotification } = await import("./complaintsExtended");
        const leaders = await shiftTeamLeaders(s, city);
        for (const uid of new Set(leaders.map((l) => l.userId).filter((u): u is number => u != null))) {
          await createNotification({ userId: uid, title, body, kind: "handover", link: "/passagem-turno" });
          sent++;
        }
        const { notifyBackoffice } = await import("./extrasAutomation");
        await notifyBackoffice(title, body, "/passagem-turno");
      } catch (err: any) { console.warn("[handover] lembrete:", String(err?.message ?? err).slice(0, 200)); }
      await db.execute(sql`UPDATE shift_handover_reminders SET recipients = ${sent} WHERE handoverDate = ${s.date} AND shift = ${s.shift} AND city = ${city}`);
      (out[k] ??= []).push(city);
    }
  }
  return out;
}

// ─── Cumprimento ("Resumo do dia") ──────────────────────────────────────────

export interface ComplianceRow {
  date: string; shift: HandoverShift; city: HandoverCity;
  status: ComplianceStatus; late: boolean;
  ackByName: string | null; authorName: string | null;
  cashDiff: number | null; reminded: boolean;
}

export async function getHandoverCompliance(date: string, city: HandoverCity | null, nowMs: number = Date.now()): Promise<{ day: ComplianceRow[]; percent30: number | null; expected30: number }> {
  const db = await getDb();
  if (!db) return { day: [], percent30: null, expected30: 0 };
  const from = addDays(date, -30); // um dia a mais: a passagem anterior da 1.ª manhã
  const scope = cityNameScope(sql`city`);
  const handovers = rowsOf(await db.execute(buildHandoverRange(from, date, city, scope)));
  const shifts = rowsOf(await db.execute(sql`SELECT DISTINCT assignmentDate, shift, city FROM extras_dia_assignments
    WHERE assignmentDate >= ${from} AND assignmentDate <= ${date} AND ${scope} ${city ? sql`AND city = ${city}` : sql``}`));
  const reminders = rowsOf(await db.execute(sql`SELECT handoverDate, shift, city FROM shift_handover_reminders
    WHERE handoverDate >= ${from} AND handoverDate <= ${date} AND ${scope} ${city ? sql`AND city = ${city}` : sql``}`));
  const k = (d: string, s: string, c: string) => `${d}|${s}|${c}`;
  const hMap = new Map(handovers.map((h) => [k(h.handoverDate, h.shift, h.city), h]));
  const remindedSet = new Set(reminders.map((r) => k(r.handoverDate, r.shift, r.city)));
  const expected = new Set<string>();
  for (const s of shifts) expected.add(k(s.assignmentDate, s.shift, s.city));
  for (const h of handovers) expected.add(k(h.handoverDate, h.shift, h.city));

  const rows: ComplianceRow[] = [];
  for (const key of expected) {
    const [d, s, c] = key.split("|");
    if (d === from || !(HANDOVER_CITIES as readonly string[]).includes(c)) continue;
    const ref: ShiftRef = { date: d, shift: s as HandoverShift };
    const h = hMap.get(key);
    const st = complianceStatus(ref, h ? { createdAtMs: h.createdAtUnix != null ? Number(h.createdAtUnix) * 1000 : null, ackAtMs: h.ackAtUnix != null ? Number(h.ackAtUnix) * 1000 : null } : null, nowMs);
    const prev = previousShiftOf(ref);
    rows.push({
      date: d, shift: ref.shift, city: c as HandoverCity, status: st.status, late: st.late,
      ackByName: h?.ackByName ?? null, authorName: h ? (h.createdByName ?? h.filledByName ?? null) : null,
      cashDiff: h ? cashDifference(h, hMap.get(k(prev.date, prev.shift, c)) ?? null) : null,
      reminded: remindedSet.has(key),
    });
  }
  const order = (r: ComplianceRow) => `${r.date}|${r.shift === "morning" ? 0 : 1}|${r.city}`;
  rows.sort((a, b) => order(a).localeCompare(order(b)));
  const last30 = rows.filter((r) => r.date > addDays(date, -30));
  return {
    day: rows.filter((r) => r.date === date),
    percent30: compliancePercent(last30),
    expected30: last30.filter((r) => r.status !== "pending").length,
  };
}
