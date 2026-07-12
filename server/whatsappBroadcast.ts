/**
 * Broadcast de templates WhatsApp aos extras (Fase 2).
 *
 * Espelha o padrão de `sendWeeklyAvailabilityRequest` (extrasAvailability.ts):
 * resolve os extras ativos (subset ou todos), normaliza os telefones e envia um
 * TEMPLATE por destinatário. Persiste um `whatsapp_broadcasts` + uma
 * `whatsapp_messages` por envio, com upsert de `whatsapp_conversations`.
 *
 * A lógica pura de resolução de destinatários (`resolveRecipients`) está
 * separada da orquestração com I/O (`sendBroadcast`) para ser testável sem BD
 * nem rede.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { whatsappBroadcasts, whatsappConversations, whatsappMessages } from "../drizzle/schema";
import { normalizePhoneE164 } from "../shared/phone";
import { listActiveExtras, type ActiveExtra } from "./extrasAvailability";
import { sendTemplateMessage } from "./whatsapp";
import { runConcurrent } from "./_core/concurrency";
import { issueAvailabilityFormToken } from "./availabilityFormToken";

const BROADCAST_CONCURRENCY = 4;
const DEFAULT_LANGUAGE = "pt_PT";

export type RecipientStatus = "sent" | "failed" | "invalid_phone";

/** Destinatário resolvido, ANTES de qualquer envio (pure). */
export interface ResolvedRecipient {
  employeeId: number | null;
  name: string | null;
  phone: string; // telefone tal como guardado (raw)
  phoneE164: string | null; // normalizado, ou null se inválido/ausente
}

/** Resultado por destinatário, DEPOIS do envio. */
export interface BroadcastRecipient extends ResolvedRecipient {
  status: RecipientStatus;
  error?: string;
  waMessageId?: string;
}

export interface BroadcastSummary {
  broadcastId: number | null;
  total: number;
  sent: number;
  failed: number;
  invalidPhone: number;
  recipients: BroadcastRecipient[];
}

export interface SendBroadcastOptions {
  templateName: string;
  languageCode?: string;
  templateParams?: string[];
  employeeIds?: number[] | null; // subset; se vazio/null → todos os extras ativos
  weekStart?: string | null; // YYYY-MM-DD (contexto, opcional)
  note?: string | null;
  testPhone?: string | null; // modo teste: envia SÓ a este número
  createdById?: number | null;
}

/**
 * Filtra os extras (subset `employeeIds` ou todos) e normaliza cada telefone.
 * Função pura — sem BD nem rede. É o núcleo testável do broadcast.
 */
export function resolveRecipients(
  extras: ActiveExtra[],
  employeeIds?: number[] | null,
): ResolvedRecipient[] {
  let list = extras;
  if (employeeIds && employeeIds.length) {
    const set = new Set(employeeIds);
    list = extras.filter((e) => set.has(e.id));
  }
  return list.map((e) => {
    const raw = (e.phone ?? "").trim();
    return {
      employeeId: e.id,
      name: e.fullName,
      phone: raw,
      phoneE164: raw ? normalizePhoneE164(raw) : null,
    };
  });
}

/** Componentes do template WhatsApp a partir de parâmetros de texto do body. */
/**
 * Componentes do template: parâmetros do body (opcional) + botão URL dinâmico
 * (opcional) que injeta o token do formulário. Para o botão URL funcionar, o
 * template no WhatsApp Manager tem de ter um botão do tipo "Visit website" com
 * URL dinâmico terminado em `{{1}}` (ex.: `https://form.app/disp?token={{1}}`);
 * enviamos o token como valor de `{{1}}`.
 */
function buildComponents(params?: string[], buttonToken?: string): unknown[] | undefined {
  const comps: unknown[] = [];
  if (params && params.length) {
    comps.push({ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p) })) });
  }
  if (buttonToken) {
    comps.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: buttonToken }] });
  }
  return comps.length ? comps : undefined;
}

function nowStr(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// ─── Helpers de persistência ────────────────────────────────────────────────

async function insertBroadcast(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  data: {
    templateName: string;
    note: string | null;
    createdById: number | null;
    weekStart: string | null;
    totalCount: number;
  },
): Promise<number> {
  const result = await db.insert(whatsappBroadcasts).values({
    templateName: data.templateName,
    note: data.note,
    createdById: data.createdById,
    weekStart: data.weekStart,
    totalCount: data.totalCount,
  });
  return Number((result as any)[0].insertId);
}

/**
 * Upsert da conversa por `phoneE164` (unique). Associa o employeeId na primeira
 * vez (mantém o já existente) e atualiza `lastMessageAt`. NUNCA toca em
 * `lastInboundAt` — em envios outbound a janela de 24h não abre; lastInboundAt
 * null continua a significar "aguarda primeira resposta" (a Fase 3 depende disto).
 * Devolve o id da conversa.
 */
async function upsertConversation(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  phoneE164: string,
  employeeId: number | null,
): Promise<number> {
  const now = nowStr();
  await db
    .insert(whatsappConversations)
    .values({
      phoneE164,
      employeeId: employeeId ?? null,
      lastMessageAt: now,
    })
    .onDuplicateKeyUpdate({
      set: {
        lastMessageAt: now,
        // Só preenche o employeeId se ainda estiver vazio (primeira associação vence).
        employeeId: sql`COALESCE(${whatsappConversations.employeeId}, ${employeeId ?? null})`,
      },
    });
  const rows = await db
    .select({ id: whatsappConversations.id })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.phoneE164, phoneE164))
    .limit(1);
  return rows[0].id;
}

/** Envia o template a UM destinatário válido e persiste a whatsapp_messages. */
async function sendOne(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  r: ResolvedRecipient,
  cfg: {
    templateName: string;
    languageCode: string;
    components?: unknown[];
    broadcastId: number;
    sentById: number | null;
  },
): Promise<BroadcastRecipient> {
  const phoneE164 = r.phoneE164!; // garantido pelo chamador
  const conversationId = await upsertConversation(db, phoneE164, r.employeeId);
  const res = await sendTemplateMessage(phoneE164, cfg.templateName, cfg.languageCode, cfg.components);

  await db.insert(whatsappMessages).values({
    conversationId,
    direction: "out",
    waMessageId: res.ok ? res.waMessageId : null,
    type: "template",
    body: null,
    templateName: cfg.templateName,
    status: res.ok ? "sent" : "failed",
    errorDetail: res.ok ? null : res.error,
    sentById: cfg.sentById,
    broadcastId: cfg.broadcastId,
  });

  return res.ok
    ? { ...r, status: "sent", waMessageId: res.waMessageId }
    : { ...r, status: "failed", error: res.error };
}

async function updateBroadcastCounts(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  broadcastId: number,
  counts: { sentCount: number; failedCount: number; invalidEmployeeIds?: number[] | null },
): Promise<void> {
  const set: Record<string, unknown> = {
    sentCount: counts.sentCount,
    failedCount: counts.failedCount,
  };
  if (counts.invalidEmployeeIds !== undefined) {
    set.invalidEmployeeIds = counts.invalidEmployeeIds ? JSON.stringify(counts.invalidEmployeeIds) : null;
  }
  await db.update(whatsappBroadcasts).set(set).where(eq(whatsappBroadcasts.id, broadcastId));
}

// ─── Orquestração ───────────────────────────────────────────────────────────

/**
 * Envia um broadcast de template. Falha CEDO se as envs WHATSAPP_* não
 * estiverem configuradas ou se a BD estiver indisponível — para não rebentar a
 * meio do loop.
 *
 * ⚠️ SEM FILA PERSISTENTE (decisão consciente do Jorge, Fase 2): o envio corre
 * em memória com `runConcurrent(4)` + o retry único que já vive em whatsapp.ts.
 * Um restart do Railway a meio de um broadcast PERDE os envios ainda não feitos
 * (os já persistidos com status 'sent' ficam; os pendentes desaparecem sem
 * rasto). Aceitável para esta escala (extras internos, dezenas de destinatários).
 * Revisitar (outbox/fila) se o volume crescer materialmente.
 */
export async function sendBroadcast(opts: SendBroadcastOptions): Promise<BroadcastSummary> {
  // Guarda de env — falha cedo com mensagem clara.
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error(
      "WhatsApp não está configurado (faltam WHATSAPP_TOKEN e/ou WHATSAPP_PHONE_NUMBER_ID). Configura as env vars antes de enviar.",
    );
  }

  const templateName = opts.templateName.trim();
  if (!templateName) throw new Error("Nome do template em falta.");
  const languageCode = (opts.languageCode || DEFAULT_LANGUAGE).trim();
  const components = buildComponents(opts.templateParams);

  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");

  // ── MODO TESTE: 1 número, não toca nos extras ──────────────────────────────
  if (opts.testPhone) {
    const rawTest = opts.testPhone.trim();
    const phoneE164 = normalizePhoneE164(rawTest);
    const note = `[TESTE] ${opts.note ?? ""}`.trim();
    const broadcastId = await insertBroadcast(db, {
      templateName,
      note,
      createdById: opts.createdById ?? null,
      weekStart: opts.weekStart ?? null,
      totalCount: 1,
    });

    if (!phoneE164) {
      await updateBroadcastCounts(db, broadcastId, { sentCount: 0, failedCount: 1 });
      return {
        broadcastId,
        total: 1,
        sent: 0,
        failed: 0,
        invalidPhone: 1,
        recipients: [
          { employeeId: null, name: "Teste", phone: rawTest, phoneE164: null, status: "invalid_phone", error: "Número de teste inválido" },
        ],
      };
    }

    const recipient = await sendOne(
      db,
      { employeeId: null, name: "Teste", phone: rawTest, phoneE164 },
      { templateName, languageCode, components, broadcastId, sentById: opts.createdById ?? null },
    );
    const sent = recipient.status === "sent" ? 1 : 0;
    await updateBroadcastCounts(db, broadcastId, { sentCount: sent, failedCount: 1 - sent });
    return { broadcastId, total: 1, sent, failed: 1 - sent, invalidPhone: 0, recipients: [recipient] };
  }

  // ── MODO NORMAL ────────────────────────────────────────────────────────────
  const extras = await listActiveExtras();
  const resolved = resolveRecipients(extras, opts.employeeIds ?? null);

  const broadcastId = await insertBroadcast(db, {
    templateName,
    note: opts.note ?? null,
    createdById: opts.createdById ?? null,
    weekStart: opts.weekStart ?? null,
    totalCount: resolved.length,
  });

  const recipients: BroadcastRecipient[] = new Array(resolved.length);
  const indexed = resolved.map((r, i) => ({ r, i }));

  await runConcurrent(indexed, BROADCAST_CONCURRENCY, async ({ r, i }) => {
    if (!r.phoneE164) {
      // Número inválido/ausente → regista falha SEM chamar a API (análogo ao
      // noEmail do envio por email). Não cria conversa/mensagem: não há
      // phoneE164 válido para lhes servir de chave.
      recipients[i] = {
        ...r,
        status: "invalid_phone",
        error: r.phone ? "Número inválido" : "Sem número",
      };
      return;
    }
    // Token single-use do formulário externo, por destinatário, quando há
    // weekStart e o destinatário é um extra registado. Injetado no botão URL
    // do template ({{1}}). Sem weekStart → template sem link (só notificação).
    let recipientComponents = components;
    if (opts.weekStart && r.employeeId != null) {
      try {
        const issued = await issueAvailabilityFormToken(db, r.employeeId, opts.weekStart);
        recipientComponents = buildComponents(opts.templateParams, issued.token);
      } catch (err: any) {
        // Falha a emitir token (ex.: secret em falta) → regista como falha do
        // destinatário SEM enviar (o link seria inútil).
        recipients[i] = { ...r, status: "failed", error: `Falha ao gerar link do formulário: ${err?.message || err}` };
        return;
      }
    }
    recipients[i] = await sendOne(db, r, {
      templateName,
      languageCode,
      components: recipientComponents,
      broadcastId,
      sentById: opts.createdById ?? null,
    });
  });

  const sent = recipients.filter((r) => r.status === "sent").length;
  const invalidPhone = recipients.filter((r) => r.status === "invalid_phone").length;
  const failed = recipients.filter((r) => r.status === "failed").length;

  // Decisão 2 (Jorge): guarda a lista de extras (com employeeId) que falharam
  // por número inválido/ausente, para mais tarde "mostrar extras com número
  // inválido" e corrigir na origem. Não gera linha em whatsapp_messages.
  const invalidEmployeeIds = recipients
    .filter((r) => r.status === "invalid_phone" && r.employeeId != null)
    .map((r) => r.employeeId as number);

  // failedCount na BD = tudo o que não foi enviado (falhas de API + inválidos).
  await updateBroadcastCounts(db, broadcastId, {
    sentCount: sent,
    failedCount: failed + invalidPhone,
    invalidEmployeeIds: invalidEmployeeIds.length ? invalidEmployeeIds : null,
  });

  return { broadcastId, total: resolved.length, sent, failed, invalidPhone, recipients };
}
