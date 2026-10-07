/**
 * Pedir os documentos em falta aos extras (pauta do Rafael, 7 out 2026) —
 * leitura da BD, envio e registo. As regras são puras e partilhadas
 * (shared/docsRequest.ts): a pré-visualização e o envio usam o MESMO plano.
 *
 *  - à mão: ficha de um extra ("Pedir documentos em falta") ou em grupo na
 *    lista do RH (quem valida documentos, no seu âmbito — server/rhAccess.ts);
 *  - automático: trabalho semanal rh-docs-request (interruptor
 *    EXTRAS_DOCS_REQUEST, desligado por omissão);
 *  - WhatsApp: template da cidade da pessoa (Definições → Parâmetros), gravado na
 *    conversa do WhatsApp como os outros envios (reserva antes de chamar a
 *    Meta — um pedido repetido não reenvia); email: o de trabalho ou o pessoal,
 *    como envio automático da aplicação ("Comunicações automáticas" da ficha);
 *  - registo em employee_docs_requests (requestKey único: o mesmo clique, ou a
 *    mesma semana do automático, nunca envia duas vezes) e no registo de
 *    atividade. Nada se apaga.
 */
import { sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import {
  DOCS_REQUEST_CHANNELS,
  DOCS_REQUEST_CHANNEL_LABELS,
  DOCS_REQUEST_MODE_LABELS,
  DOCS_REQUEST_UPLOAD_PATH,
  docsPlanIgnoredReasons,
  docsPlanWillSend,
  docsRequestCadence,
  docsRequestLine,
  docsRequestStatusLabel,
  docsRequestWhatsappBody,
  docsTemplatesByCity,
  lastDocsRequestLabel,
  planDocsRequests,
  type DocsRequestChannel,
  type DocsRequestCity,
  type DocsRequestLogRow,
  type DocsRequestMode,
  type DocsRequestPerson,
  type DocsRequestPersonPlan,
  type DocsRequestPlan,
  type DocsTemplateRef,
  type LastDocsRequest,
} from "../shared/docsRequest";
import { docChecklist } from "../shared/employeeDocuments";
import { normalizePhoneE164 } from "../shared/phone";
import { utcMs } from "../shared/lisbonDay";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function rowsOf(res: unknown): any[] {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
}
const inList = (ids: number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);
const isDuplicateKey = (err: unknown) => {
  const e = err as any;
  return (e?.code ?? e?.cause?.code) === "ER_DUP_ENTRY" || (e?.errno ?? e?.cause?.errno) === 1062;
};

export function docsRequestAppUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.APP_URL || env.PUBLIC_APP_URL || "https://dashboard.multipark.pt").replace(/\/+$/, "");
}

function whatsappConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
}

async function emailConfigured(): Promise<boolean> {
  try {
    const { isEmailSendConfigured } = await import("./mail/systemMail");
    return isEmailSendConfigured();
  } catch {
    return false;
  }
}

/** "r***@gmail.com" (o detalhe do registo não precisa do endereço inteiro). PURA. */
export function maskEmailAddress(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 1)}***@${domain}`;
}

// ─── Leitura ────────────────────────────────────────────────────────────────

/** Uma ficha com o que o pedido precisa (+ o necessário às permissões). */
export interface DocsCandidateRow extends DocsRequestPerson {
  projectId: number | null;
  /** Papel da conta associada (fichas de admin ficam protegidas). */
  accountRole: string | null;
}

const CITY_FROM_KEY: Record<string, DocsRequestCity> = { lisboa: "lisbon", porto: "porto", faro: "faro" };

/**
 * Fichas para o pedido: `ids` = estas; `activeExtras` = todos os extras
 * ativos, opcionalmente só destes centros (`projectIds`; undefined = todos) e
 * depois da ficha `afterId` (retoma do automático), por ordem de id.
 */
export async function loadDocsCandidates(filter: { ids?: number[]; activeExtras?: boolean; projectIds?: number[]; afterId?: number; limit?: number }): Promise<DocsCandidateRow[]> {
  const db = await getDb();
  if (!db) return [];
  const conds = [sql`1 = 1`];
  if (filter.ids) {
    const ids = Array.from(new Set(filter.ids)).filter((n) => Number.isSafeInteger(n) && n > 0);
    if (!ids.length) return [];
    conds.push(sql`e.id IN (${inList(ids)})`);
  }
  if (filter.activeExtras) conds.push(sql`e.position = 'extra' AND e.isActive = 1`);
  if (filter.projectIds) {
    if (!filter.projectIds.length) return [];
    conds.push(sql`e.projectId IN (${inList(filter.projectIds)})`);
  }
  if (filter.afterId) conds.push(sql`e.id > ${filter.afterId}`);
  const limit = filter.limit ? sql`LIMIT ${Math.max(1, Math.min(2000, filter.limit))}` : sql``;
  const rows = rowsOf(await db.execute(sql`
    SELECT e.id, e.fullName, e.position, e.isActive, e.projectId, e.email, e.personalEmail, e.phone, e.personalPhone,
           e.noAutoEmail, e.noAutoWhatsapp, u.id AS accountId, u.isActive AS accountActive, u.role AS accountRole
      FROM employees e LEFT JOIN users u ON u.id = e.userId
     WHERE ${sql.join(conds, sql` AND `)}
     ORDER BY e.id ${limit}`));
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));

  // Documentos ATIVOS (não arquivados), o mais recente primeiro (motivo da recusa mais recente).
  const docsBy = new Map<number, { docType: string; status: string; rejectedReason: string | null }[]>();
  const docRows = rowsOf(await db.execute(sql`
    SELECT employeeId, docType, status, rejectedReason FROM employee_documents
     WHERE archivedAt IS NULL AND employeeId IN (${inList(ids)})
     ORDER BY createdAt DESC, id DESC`));
  for (const d of docRows) {
    const id = Number(d.employeeId);
    docsBy.set(id, [...(docsBy.get(id) ?? []), { docType: String(d.docType), status: String(d.status), rejectedReason: d.rejectedReason ? String(d.rejectedReason) : null }]);
  }

  let optedOut = new Set<string>();
  let unreachable = new Set<string>();
  try {
    const { optedOutPhones, unreachablePhones } = await import("./whatsappStore");
    [optedOut, unreachable] = await Promise.all([optedOutPhones(db as any), unreachablePhones(db as any)]);
  } catch { /* sem tabelas do WhatsApp: ninguém marcado */ }

  let cities = new Map<number, { city: string | null }>();
  try {
    const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
    cities = await resolveCitiesForEmployeeIds(ids);
  } catch { /* sem cidade: o WhatsApp fica de fora ("sem cidade") */ }

  return rows.map((r) => {
    const id = Number(r.id);
    const rawPhone = String(r.phone ?? "").trim() || String(r.personalPhone ?? "").trim();
    const phoneE164 = rawPhone ? normalizePhoneE164(rawPhone) : null;
    const cityKey = cities.get(id)?.city ?? null;
    return {
      id,
      fullName: String(r.fullName ?? ""),
      position: r.position == null ? null : String(r.position),
      isActive: Number(r.isActive) === 1,
      hasAccount: r.accountId != null && Number(r.accountActive) === 1,
      email: r.email ? String(r.email) : null,
      personalEmail: r.personalEmail ? String(r.personalEmail) : null,
      phoneE164,
      noAutoEmail: Number(r.noAutoEmail ?? 0) === 1,
      noAutoWhatsapp: Number(r.noAutoWhatsapp ?? 0) === 1,
      whatsappOptedOut: !!phoneE164 && optedOut.has(phoneE164),
      whatsappUnreachable: !!phoneE164 && unreachable.has(phoneE164),
      city: cityKey ? CITY_FROM_KEY[cityKey] ?? null : null,
      checklist: docChecklist(docsBy.get(id) ?? []),
      projectId: r.projectId == null ? null : Number(r.projectId),
      accountRole: r.accountRole ? String(r.accountRole) : null,
    };
  });
}

/** Registo dos pedidos destas fichas (vazio se a tabela ainda não existir). */
async function loadDocsLog(db: Db, ids: number[]): Promise<DocsRequestLogRow[]> {
  if (!ids.length) return [];
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT r.employeeId, r.mode, r.createdAt, r.whatsappStatus, r.emailStatus, u.name AS byName
        FROM employee_docs_requests r LEFT JOIN users u ON u.id = r.requestedById
       WHERE r.employeeId IN (${inList(ids)})`));
    return rows.map((r) => ({
      employeeId: Number(r.employeeId),
      mode: String(r.mode) === "auto" ? "auto" : "manual",
      atMs: utcMs(r.createdAt instanceof Date ? r.createdAt : String(r.createdAt)),
      whatsappStatus: r.whatsappStatus ? String(r.whatsappStatus) : null,
      emailStatus: r.emailStatus ? String(r.emailStatus) : null,
      byName: r.byName ? String(r.byName) : null,
    }));
  } catch (err) {
    console.warn("[docs-request] registo indisponível:", String((err as any)?.message ?? err).slice(0, 160));
    return [];
  }
}

async function loadTemplates(): Promise<Record<DocsRequestCity, DocsTemplateRef | null>> {
  try {
    const { getSetting } = await import("./appSettings");
    return docsTemplatesByCity((await getSetting("rh.docsRequestTemplates")) as Record<string, unknown> | null);
  } catch {
    return docsTemplatesByCity(null);
  }
}

export interface DocsRequestPreview extends DocsRequestPlan {
  mode: DocsRequestMode;
  configured: Record<DocsRequestChannel, boolean>;
  templates: Record<DocsRequestCity, DocsTemplateRef | null>;
}

/** O plano (sem efeitos): quem recebe, o texto exato por canal, quem fica de fora e porquê. */
export async function buildDocsPlan(people: readonly DocsRequestPerson[], o: { mode: DocsRequestMode; channels: readonly DocsRequestChannel[]; force?: boolean; nowMs?: number }): Promise<DocsRequestPreview> {
  const db = await getDb();
  const [log, templates, email] = await Promise.all([
    db ? loadDocsLog(db, people.map((p) => p.id)) : Promise.resolve([]),
    loadTemplates(),
    emailConfigured(),
  ]);
  const configured = { whatsapp: whatsappConfigured(), email };
  const plan = planDocsRequests({
    people, log, mode: o.mode, channels: o.channels, configured, templates,
    nowMs: o.nowMs ?? Date.now(), appUrl: docsRequestAppUrl(), force: o.force,
  });
  return { ...plan, mode: o.mode, configured, templates };
}

// ─── Envio ──────────────────────────────────────────────────────────────────

export interface DocsChannelOutcome {
  status: string;
  label: string;
  detail: string | null;
}

export interface DocsRequestPersonResult {
  employeeId: number;
  name: string;
  whatsapp: DocsChannelOutcome | null;
  email: DocsChannelOutcome | null;
  /** Este pedido (mesma chave) já tinha sido feito — nada reenviado. */
  already: boolean;
}

const outcome = (status: string | null, detail: string | null): DocsChannelOutcome | null =>
  status ? { status, label: docsRequestStatusLabel(status), detail } : null;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTML do email a partir das linhas (o link da ficha fica clicável). PURA. */
export function docsRequestEmailHtml(lines: readonly string[], appUrl: string): string {
  const link = `${appUrl.replace(/\/+$/, "")}${DOCS_REQUEST_UPLOAD_PATH}`;
  return lines
    .map((l) => `<p>${esc(l).replace(/\n/g, "<br/>").replace(esc(link), `<a href="${esc(link)}">${esc(link)}</a>`)}</p>`)
    .join("");
}

/** Envia o template do pedido a UMA pessoa e grava-o na conversa do WhatsApp. Nunca lança. */
async function sendDocsWhatsApp(db: Db, o: { employeeId: number; phoneE164: string; template: DocsTemplateRef; params: [string, string]; sentById: number | null; requestRowId: number }): Promise<{ status: "sent" | "unknown" | "failed"; detail: string | null }> {
  try {
    const { upsertConversation } = await import("./whatsappBroadcast");
    const { reserveOutboundMessage, finishOutboundMessage, duplicateRequestOutcome } = await import("./whatsappStore");
    const { sendTemplateMessage } = await import("./whatsapp");
    const { sanitizeTemplateParam } = await import("../shared/whatsappTemplate");
    const params = o.params.map((p) => sanitizeTemplateParam(p)) as [string, string];
    const conversationId = await upsertConversation(db, o.phoneE164, o.employeeId);
    const row = { conversationId, type: "template" as const, body: docsRequestWhatsappBody(params[0], params[1]), templateName: o.template.name };
    const reserved = await reserveOutboundMessage(db as any, { ...row, sentById: o.sentById, clientRequestId: `docsreq:${o.requestRowId}`, language: o.template.language });
    if (!reserved.reserved) {
      const dup = duplicateRequestOutcome(reserved.existing);
      if (dup.kind === "sent") return { status: "sent", detail: "já tinha saído" };
      if (dup.kind === "in_doubt") return { status: "unknown", detail: dup.error.slice(0, 300) };
      return { status: "failed", detail: "envio repetido" };
    }
    const res = await sendTemplateMessage(o.phoneE164, o.template.name, o.template.language, [
      { type: "body", parameters: params.map((text) => ({ type: "text", text })) },
    ]);
    try {
      await finishOutboundMessage(db as any, reserved.id, row, res.ok ? res : { ok: false, error: res.error, uncertain: res.uncertain, code: res.code });
    } catch (err) {
      console.warn("[docs-request] gravar o resultado do WhatsApp falhou:", String((err as any)?.message ?? err).slice(0, 160));
    }
    if (res.ok) return { status: "sent", detail: null };
    return { status: res.uncertain ? "unknown" : "failed", detail: String(res.error ?? "erro").slice(0, 300) };
  } catch (err) {
    return { status: "failed", detail: `Erro no envio: ${String((err as any)?.message ?? err).slice(0, 260)}` };
  }
}

/** Envia o email do pedido. Nunca lança. */
async function sendDocsEmail(p: DocsRequestPersonPlan, appUrl: string): Promise<{ status: "sent" | "failed" | "skipped"; detail: string | null }> {
  try {
    const { sendEmailDetailed } = await import("./mail/systemMail");
    const r = await sendEmailDetailed({
      to: p.emailTo!,
      subject: p.emailSubject,
      text: p.emailLines.join("\n\n"),
      html: docsRequestEmailHtml(p.emailLines, appUrl),
      auto: { kind: "docs_request", employeeId: p.employeeId },
    });
    if (r.ok) return { status: "sent", detail: `para ${maskEmailAddress(p.emailTo!)}` };
    if (r.blocked) {
      const { NO_AUTO_EMAIL_ERROR } = await import("../shared/contactPrefs");
      return { status: "skipped", detail: NO_AUTO_EMAIL_ERROR };
    }
    return { status: "failed", detail: String(r.error ?? "falhou o envio do email").slice(0, 300) };
  } catch (err) {
    return { status: "failed", detail: `Erro no envio: ${String((err as any)?.message ?? err).slice(0, 260)}` };
  }
}

/**
 * Faz o pedido a UMA pessoa (o plano diz que canais seguem). Reserva a linha
 * do registo ANTES de enviar (requestKey único): repetir a mesma chave não
 * reenvia e devolve o que ficou registado. null = nada a enviar.
 */
export async function requestDocsFromPerson(p: DocsRequestPersonPlan, o: { mode: DocsRequestMode; userId: number | null; requestKey: string; channels: readonly DocsRequestChannel[]; phoneE164: string | null; appUrl?: string }): Promise<DocsRequestPersonResult | null> {
  if (!docsPlanWillSend(p)) return null;
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const appUrl = o.appUrl ?? docsRequestAppUrl();
  const initial = (c: DocsRequestChannel): { status: string | null; detail: string | null } => {
    const plan = p.channels[c];
    if (plan.action === "send") return { status: "sending", detail: null };
    if (plan.action === "skip" && o.channels.includes(c)) return { status: "skipped", detail: plan.reason.slice(0, 300) };
    return { status: null, detail: null };
  };
  const wa = initial("whatsapp");
  const em = initial("email");
  const line = docsRequestLine(p.docs);
  let rowId = 0;
  try {
    const res = await db.execute(sql`
      INSERT INTO employee_docs_requests
        (employeeId, mode, requestedById, requestKey, docTypes, docsText, whatsappStatus, whatsappDetail, templateName, emailStatus, emailDetail)
      VALUES (${p.employeeId}, ${o.mode}, ${o.userId}, ${o.requestKey.slice(0, 96)}, ${p.docs.map((d) => d.docType).join(",").slice(0, 255)},
              ${line.slice(0, 700)}, ${wa.status}, ${wa.detail}, ${p.channels.whatsapp.action === "send" ? p.template?.name ?? null : null}, ${em.status}, ${em.detail})`);
    rowId = Number((res as any)?.[0]?.insertId ?? (res as any)?.insertId ?? 0);
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const [prev] = rowsOf(await db.execute(sql`
      SELECT whatsappStatus, whatsappDetail, emailStatus, emailDetail FROM employee_docs_requests WHERE requestKey = ${o.requestKey.slice(0, 96)} LIMIT 1`));
    return {
      employeeId: p.employeeId, name: p.name, already: true,
      whatsapp: outcome(prev?.whatsappStatus ?? null, prev?.whatsappDetail ?? null),
      email: outcome(prev?.emailStatus ?? null, prev?.emailDetail ?? null),
    };
  }
  if (!rowId) {
    const [r] = rowsOf(await db.execute(sql`SELECT id FROM employee_docs_requests WHERE requestKey = ${o.requestKey.slice(0, 96)} LIMIT 1`));
    rowId = Number(r?.id ?? 0);
  }
  // Sem o id do registo não se envia (a mensagem do WhatsApp fica presa a ele, para não repetir).
  if (!rowId) throw new Error("não foi possível registar o pedido — nada enviado");

  let waOut = { status: wa.status, detail: wa.detail };
  if (p.channels.whatsapp.action === "send" && p.template && o.phoneE164) {
    waOut = await sendDocsWhatsApp(db, { employeeId: p.employeeId, phoneE164: o.phoneE164, template: p.template, params: p.whatsappParams, sentById: o.userId, requestRowId: rowId });
  } else if (p.channels.whatsapp.action === "send") {
    waOut = { status: "failed", detail: "sem telemóvel ou template na hora de enviar" };
  }
  let emOut = { status: em.status, detail: em.detail };
  if (p.channels.email.action === "send") emOut = await sendDocsEmail(p, appUrl);

  await db.execute(sql`
    UPDATE employee_docs_requests
       SET whatsappStatus = ${waOut.status}, whatsappDetail = ${waOut.detail ? waOut.detail.slice(0, 300) : null},
           emailStatus = ${emOut.status}, emailDetail = ${emOut.detail ? emOut.detail.slice(0, 300) : null},
           finishedAt = CURRENT_TIMESTAMP
     WHERE id = ${rowId}`);

  const per = (c: DocsRequestChannel, s: { status: string | null; detail: string | null }) =>
    s.status ? `${DOCS_REQUEST_CHANNEL_LABELS[c]}: ${docsRequestStatusLabel(s.status)}${s.detail && s.status !== "sent" ? ` (${s.detail})` : ""}` : null;
  await logActivity({
    userId: o.userId ?? 0,
    ...(o.mode === "auto" ? { source: "cron" } : {}),
    action: "employee_docs_request",
    entity: "employee",
    entityId: p.employeeId,
    details: [`Pedido de documentos em falta (${DOCS_REQUEST_MODE_LABELS[o.mode]}): ${line}`, per("whatsapp", waOut), per("email", emOut)].filter(Boolean).join(" · ").slice(0, 1000),
  } as any).catch(() => undefined);

  return {
    employeeId: p.employeeId, name: p.name, already: false,
    whatsapp: outcome(waOut.status, waOut.detail),
    email: outcome(emOut.status, emOut.detail),
  };
}

export interface DocsRequestSendResult {
  people: DocsRequestPersonResult[];
  /** Enviados AGORA (não conta o que já tinha seguido com a mesma chave). */
  sent: Record<DocsRequestChannel, number>;
  failed: Record<DocsRequestChannel, number>;
  /** Ficaram de fora (e porquê). */
  ignored: { employeeId: number; name: string; reasons: string[] }[];
  /** Ficaram por enviar por falta de tempo — carregar outra vez continua. */
  remaining: number;
  errors: string[];
}

/** Executa um plano (à mão): pessoa a pessoa, até ao prazo. Nunca envia a quem o plano deixa de fora. */
export async function executeDocsPlan(plan: DocsRequestPreview, o: {
  people: readonly DocsRequestPerson[];
  mode: DocsRequestMode;
  userId: number | null;
  channels: readonly DocsRequestChannel[];
  keyFor: (employeeId: number) => string;
  deadlineAt: number;
}): Promise<DocsRequestSendResult> {
  const out: DocsRequestSendResult = { people: [], sent: { whatsapp: 0, email: 0 }, failed: { whatsapp: 0, email: 0 }, ignored: [], remaining: 0, errors: [] };
  const phoneOf = new Map(o.people.map((p) => [p.id, p.phoneE164]));
  const appUrl = docsRequestAppUrl();
  const todo = plan.people.filter(docsPlanWillSend);
  for (const p of plan.people) if (!docsPlanWillSend(p)) out.ignored.push({ employeeId: p.employeeId, name: p.name, reasons: docsPlanIgnoredReasons(p) });
  for (let i = 0; i < todo.length; i++) {
    if (Date.now() >= o.deadlineAt) {
      out.remaining = todo.length - i;
      break;
    }
    const p = todo[i];
    try {
      const r = await requestDocsFromPerson(p, { mode: o.mode, userId: o.userId, requestKey: o.keyFor(p.employeeId), channels: o.channels, phoneE164: phoneOf.get(p.employeeId) ?? null, appUrl });
      if (!r) continue;
      out.people.push(r);
      if (r.already) continue;
      for (const c of DOCS_REQUEST_CHANNELS) {
        const s = r[c]?.status;
        if (s === "sent" || s === "unknown") out.sent[c]++;
        else if (s === "failed") out.failed[c]++;
      }
    } catch (err: any) {
      out.errors.push(`${p.name}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
  return out;
}

// ─── Histórico (ficha) ──────────────────────────────────────────────────────

export interface DocsRequestHistoryRow {
  id: number;
  atMs: number;
  mode: DocsRequestMode;
  byName: string | null;
  docsText: string | null;
  whatsapp: DocsChannelOutcome | null;
  email: DocsChannelOutcome | null;
}

/** Últimos pedidos de uma ficha + o "Último pedido: dd/mm por X (canais)". */
export async function listDocsRequestHistory(employeeId: number, limit = 5): Promise<{ last: LastDocsRequest | null; label: string | null; autoCount: number; rows: DocsRequestHistoryRow[] }> {
  const db = await getDb();
  if (!db) return { last: null, label: null, autoCount: 0, rows: [] };
  const log = await loadDocsLog(db, [employeeId]);
  const cad = docsRequestCadence(log, Date.now());
  let rows: DocsRequestHistoryRow[] = [];
  try {
    rows = rowsOf(await db.execute(sql`
      SELECT r.id, r.mode, r.createdAt, r.docsText, r.whatsappStatus, r.whatsappDetail, r.emailStatus, r.emailDetail, u.name AS byName
        FROM employee_docs_requests r LEFT JOIN users u ON u.id = r.requestedById
       WHERE r.employeeId = ${employeeId}
       ORDER BY r.createdAt DESC, r.id DESC
       LIMIT ${Math.max(1, Math.min(20, limit))}`)).map((r) => ({
      id: Number(r.id),
      atMs: utcMs(r.createdAt instanceof Date ? r.createdAt : String(r.createdAt)),
      mode: String(r.mode) === "auto" ? "auto" : "manual",
      byName: r.byName ? String(r.byName) : null,
      docsText: r.docsText ? String(r.docsText) : null,
      whatsapp: outcome(r.whatsappStatus ? String(r.whatsappStatus) : null, r.whatsappDetail ? String(r.whatsappDetail) : null),
      email: outcome(r.emailStatus ? String(r.emailStatus) : null, r.emailDetail ? String(r.emailDetail) : null),
    }));
  } catch { /* sem tabela: sem histórico */ }
  return { last: cad.last, label: lastDocsRequestLabel(cad.last), autoCount: cad.autoCount, rows };
}

// ─── Automático (semanal) ───────────────────────────────────────────────────

export interface DocsAutoRunResult {
  skipped?: string;
  checked: number;
  requested: number;
  sent: Record<DocsRequestChannel, number>;
  failed: Record<DocsRequestChannel, number>;
  ignored: number;
  done: boolean;
  /** Última ficha tratada (retoma no tick seguinte). */
  lastId: number | null;
  errors: string[];
}

export interface DocsAutoDeps {
  flagOn(): Promise<boolean>;
  /** Extras ativos depois da ficha `afterId`, por ordem de id. */
  loadBatch(afterId: number, limit: number): Promise<DocsRequestPerson[]>;
  plan(people: readonly DocsRequestPerson[], nowMs: number): Promise<DocsRequestPlan>;
  request(p: DocsRequestPersonPlan, key: string, phoneE164: string | null): Promise<DocsRequestPersonResult | null>;
  now(): number;
}

const AUTO_CHANNELS: readonly DocsRequestChannel[] = ["whatsapp", "email"];

const realAutoDeps: DocsAutoDeps = {
  async flagOn() {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides().catch(() => undefined);
    return isFeatureEnabled("EXTRAS_DOCS_REQUEST", { defaultEnabled: automationFlagDefault("EXTRAS_DOCS_REQUEST") });
  },
  loadBatch: (afterId, limit) => loadDocsCandidates({ activeExtras: true, afterId, limit }),
  plan: (people, nowMs) => buildDocsPlan(people, { mode: "auto", channels: AUTO_CHANNELS, nowMs }),
  request: (p, key, phoneE164) => requestDocsFromPerson(p, { mode: "auto", userId: null, requestKey: key, channels: AUTO_CHANNELS, phoneE164 }),
  now: () => Date.now(),
};

/**
 * Pedido automático da semana a todos os extras ativos com documentos em
 * falta (1× por 7 dias por pessoa, máximo 4 automáticos). Interruptor
 * desligado = não lê nem envia nada. Chave por pessoa e semana ISO: um tick
 * repetido nunca reenvia. Com prazo: devolve done:false e a última ficha
 * tratada para o tick seguinte continuar.
 */
export async function runDocsRequestAuto(o: { deadlineAt: number; afterId?: number; batchSize?: number }, deps: DocsAutoDeps = realAutoDeps): Promise<DocsAutoRunResult> {
  const out: DocsAutoRunResult = { checked: 0, requested: 0, sent: { whatsapp: 0, email: 0 }, failed: { whatsapp: 0, email: 0 }, ignored: 0, done: true, lastId: null, errors: [] };
  if (!(await deps.flagOn())) return { ...out, skipped: "desligado (Definições → Automações: Pedir documentos em falta aos extras)" };
  const { isoWeekKey } = await import("./cronSchedule");
  const { lisbonDayOf } = await import("../shared/lisbonDay");
  const week = isoWeekKey(lisbonDayOf(deps.now()));
  const size = Math.max(1, Math.min(200, o.batchSize ?? 50));
  let after = o.afterId ?? 0;
  for (;;) {
    if (deps.now() >= o.deadlineAt) {
      out.done = false;
      out.lastId = after;
      return out;
    }
    const batch = await deps.loadBatch(after, size);
    if (!batch.length) break;
    const plan = await deps.plan(batch, deps.now());
    const byId = new Map(plan.people.map((p) => [p.employeeId, p]));
    for (const person of [...batch].sort((a, b) => a.id - b.id)) {
      if (deps.now() >= o.deadlineAt) {
        out.done = false;
        out.lastId = after;
        return out;
      }
      out.checked++;
      const p = byId.get(person.id);
      if (p && docsPlanWillSend(p)) {
        try {
          const r = await deps.request(p, `auto:${week}:${person.id}`, person.phoneE164);
          if (r && !r.already) {
            out.requested++;
            for (const c of DOCS_REQUEST_CHANNELS) {
              const s = r[c]?.status;
              if (s === "sent" || s === "unknown") out.sent[c]++;
              else if (s === "failed") out.failed[c]++;
            }
          }
        } catch (err: any) {
          out.errors.push(`#${person.id}: ${String(err?.message ?? err).slice(0, 200)}`);
        }
      } else if (p && p.skip?.kind !== "no_missing") {
        out.ignored++;
      }
      after = person.id;
    }
    if (batch.length < size) break;
  }
  out.lastId = after || null;
  return out;
}
