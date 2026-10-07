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
import { employees, whatsappBroadcasts, whatsappConversations, whatsappMessages } from "../drizzle/schema";
import { NO_AUTO_WHATSAPP_ERROR } from "../shared/contactPrefs";
import { OPTED_OUT_ERROR, duplicateRequestOutcome, finishOutboundMessage, optedOutPhones, reserveOutboundMessage, sqlLaterTs, unreachablePhones } from "./whatsappStore";
import { FORM_TOKEN_PLACEHOLDER, UNREACHABLE_ERROR } from "./whatsappFailurePolicy";
import { normalizePhoneE164 } from "../shared/phone";
import {
  findActiveEmployeeByPhoneE164,
  listActiveExtras,
  type ActiveExtra,
} from "./extrasAvailability";
import { sendTemplateMessage } from "./whatsapp";
import { runConcurrent } from "./_core/concurrency";
import { issueAvailabilityFormToken } from "./availabilityFormToken";
import {
  NEUTRAL_RECIPIENT_NAME,
  UNKNOWN_RECIPIENT_NAME,
  findWhatsAppTemplate,
  templateForCity,
  templateHasBodyParams,
  firstNameOf,
  isTeamRetryTemplate,
  orderBodyValues,
  previewTemplateBody,
  resolveBodyParamRoles,
  sanitizeTemplateParam,
  type TemplateBodyRoles,
} from "../shared/whatsappTemplate";
import { DRIVER_CITIES, driverCityLabel, isDriverCity, type City } from "../shared/driverTemplates";
import {
  buildBodyComponent,
  describeLookupFailure,
  getTemplateMeta,
  validateTemplateUsage,
  type TemplateAnalysis,
} from "./whatsappTemplateMeta";

const BROADCAST_CONCURRENCY = 4;

/**
 * `opted_out` = o número pediu STOP (não se envia); `duplicate_phone` = o mesmo
 * número já estava noutro destinatário deste envio (1 mensagem por número);
 * `recent_template` = já recebeu ESTE template nas últimas 24 h (D32) — não sai outra vez.
 */
export type RecipientStatus = "sent" | "failed" | "invalid_phone" | "opted_out" | "duplicate_phone" | "recent_template";

/** D32 (Jorge, 3 out 2026): o mesmo template não volta ao mesmo número antes de 24 h. */
export const RECENT_TEMPLATE_HOURS = 24;
export const RECENT_TEMPLATE_ERROR = "Já recebeu este template nas últimas 24 h — não foi enviado outra vez.";

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
  /** Já tinha sido enviado por este mesmo envio (retoma, 17b): não saiu outra vez. */
  resumed?: true;
  /** Cidade do template usado (registo por cidade, 0530). */
  city?: City;
}

/** Código da mensagem de UM destinatário dentro de um envio em massa (≤ 64). PURA. */
export function recipientRequestKey(sendKey: string, phoneE164: string): string {
  return `b:${sendKey}:${phoneE164.replace(/\D/g, "")}`.slice(0, 64);
}

export interface BroadcastSummary {
  broadcastId: number | null;
  total: number;
  sent: number;
  failed: number;
  invalidPhone: number;
  /** Não enviados porque o número pediu STOP. */
  optedOut: number;
  /** Não enviados porque já tinham recebido este template nas últimas 24 h (D32). */
  recentTemplate?: number;
  recipients: BroadcastRecipient[];
  /** Uma difusão por cidade (lote com várias cidades). */
  byCity?: CityBroadcast[];
}

export interface CityBroadcast {
  city: City;
  templateName: string;
  languageCode: string;
  broadcastId: number;
  total: number;
  sent: number;
  notSent: number;
}

export interface SendBroadcastOptions {
  /** Id do catálogo (`WHATSAPP_TEMPLATES`); nome e língua vêm do registo por cidade. */
  templateId: string;
  /**
   * Cidade de CADA destinatário (modo normal). Só recebe quem estiver aqui:
   * nunca se assume Lisboa. Um lote com várias cidades dá uma difusão por cidade.
   */
  cityByEmployee?: Record<number, City> | null;
  /** Cidade do template no modo teste. */
  testCity?: City | null;
  /**
   * Valor partilhado do {{2}} do body (ex.: "semana de 11/08" ou "sexta à
   * noite"). O {{1}} NUNCA vem daqui — é sempre o nome do destinatário,
   * resolvido por destinatário no servidor.
   */
  bodyParam2?: string | null;
  /**
   * {{2}} diferente por colaborador (ex.: aviso de escala com o dia/horas de
   * cada um num só envio). Sobrepõe `bodyParam2` para os ids presentes.
   */
  bodyParam2ByEmployee?: Record<number, string> | null;
  /**
   * Só quando o template TEM um botão "Visit website" com URL dinâmico: injeta
   * o token single-use do formulário externo como {{1}} do botão (Fase 4).
   * Default OFF — mandar um componente de botão para um template sem botão faz
   * a Meta rejeitar o envio inteiro (132000/100).
   */
  includeFormLink?: boolean;
  /** Código único do envio (do ecrã, 17b): carregar outra vez retoma, não duplica. */
  sendKey?: string | null;
  weekStart?: string | null; // YYYY-MM-DD (contexto; obrigatório p/ includeFormLink)
  note?: string | null;
  testPhone?: string | null; // modo teste: envia SÓ a este número
  createdById?: number | null;
  /**
   * D32: difusão feita por uma pessoa — quem recebeu este template nas últimas
   * 24 h fica de fora. Os envios automáticos (escala, disponibilidade, regras)
   * têm o seu próprio controlo e podem reenviar (ex.: a escala mudou).
   */
  blockRecentSameTemplate?: boolean;
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
  // null/undefined = todos; [] = NINGUÉM (17b — antes uma tabela filtrada vazia mandava a todos).
  if (employeeIds) {
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

/**
 * Parâmetros do body para UM destinatário (PURA — núcleo testável).
 *
 *   {{1}} = nome do destinatário (primeiro nome; sem nome utilizável usa
 *           `fallbackName` — "Teste" SÓ no envio de teste explícito, nos
 *           envios reais um neutro)
 *   {{2}} = texto partilhado escrito no dialog (semana/dia)
 *
 * O {{2}} só entra quando foi preenchido: um template com um único {{1}} tem de
 * receber exactamente 1 parâmetro, senão a Meta devolve 132000.
 */
export function buildBodyParams(
  recipientName: string | null,
  bodyParam2?: string | null,
  fallbackName: string = NEUTRAL_RECIPIENT_NAME,
): string[] {
  const name = firstNameOf(recipientName) ?? fallbackName;
  const params = [name];
  const second = bodyParam2 ? sanitizeTemplateParam(bodyParam2) : "";
  if (second) params.push(second);
  return params;
}

/**
 * Componentes do template. PURA.
 *
 * Com metadados do template (`analysis`), o body é montado à medida dele:
 * parâmetros NOMEADOS levam `parameter_name` (sem isso a Meta devolve
 * `(#100) Parameter name is missing or empty`), posicionais vão simples, e um
 * template sem parâmetros não leva componente de body nenhum.
 *
 * `values` é semântico: [nome do destinatário, valor partilhado do dialog]. Com
 * `roles` (catálogo em shared/whatsappTemplate.ts) os valores são REORDENADOS
 * para a ordem real dos parâmetros do template — sem isso, um template que
 * escreva o dia antes do nome receberia os dois trocados. Sem `roles` mantém-se
 * o mapeamento por posição, que é o comportamento histórico.
 *
 * Sem metadados (inspeção indisponível), mantém-se o comportamento antigo:
 * body posicional com os valores que temos.
 *
 * O botão só é preenchido quando há token — e o token só é pedido quando o
 * template TEM mesmo um botão com URL dinâmico.
 */
export function buildComponents(opts: {
  analysis?: TemplateAnalysis | null;
  values: string[];
  roles?: TemplateBodyRoles | null;
  buttonToken?: string;
}): unknown[] | undefined {
  const comps: unknown[] = [];
  const { analysis, values, roles, buttonToken } = opts;

  if (analysis) {
    const slots = resolveBodyParamRoles(analysis.paramNames, analysis.paramCount, roles);
    const ordered = orderBodyValues(slots, { recipient: values[0] ?? "", shared: values[1] ?? "" });
    const body = buildBodyComponent(analysis, ordered);
    if (body) comps.push(body);
  } else if (values.length) {
    comps.push({ type: "body", parameters: values.map((p) => ({ type: "text", text: String(p) })) });
  }

  if (buttonToken) {
    comps.push({
      type: "button",
      sub_type: "url",
      index: String(analysis?.dynamicUrlButtonIndex ?? 0),
      parameters: [{ type: "text", text: buttonToken }],
    });
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
    city: City;
    languageCode: string;
    note: string | null;
    createdById: number | null;
    weekStart: string | null;
    totalCount: number;
    sendKey?: string | null;
  },
): Promise<number> {
  const result = await db.insert(whatsappBroadcasts).values({
    templateName: data.templateName,
    city: data.city,
    languageCode: data.languageCode,
    note: data.note,
    createdById: data.createdById,
    weekStart: data.weekStart,
    totalCount: data.totalCount,
    sendKey: data.sendKey ?? null,
  });
  return Number((result as any)[0].insertId);
}

/**
 * Difusão deste envio. Com `sendKey` já usado (a pessoa carregou outra vez
 * depois de um corte), devolve a MESMA difusão — os destinatários que já
 * receberam são saltados pelo código de cada mensagem (17b).
 */
async function openBroadcast(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  data: Parameters<typeof insertBroadcast>[1],
): Promise<{ id: number; resumed: boolean }> {
  if (!data.sendKey) return { id: await insertBroadcast(db, data), resumed: false };
  const find = async () => (await db.select({ id: whatsappBroadcasts.id }).from(whatsappBroadcasts).where(eq(whatsappBroadcasts.sendKey, data.sendKey!)).limit(1))[0];
  const prev = await find();
  if (prev) return { id: prev.id, resumed: true };
  try {
    return { id: await insertBroadcast(db, data), resumed: false };
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code !== "ER_DUP_ENTRY") throw err;
    const again = await find(); // corrida: outro pedido com o mesmo código ganhou
    if (!again) throw err;
    return { id: again.id, resumed: true };
  }
}

/**
 * Upsert da conversa por `phoneE164` (unique). Associa o employeeId na primeira
 * vez (mantém o já existente) e avança `lastMessageAt`. NUNCA toca em
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
      statusChangedAt: now,
    })
    .onDuplicateKeyUpdate({
      set: {
        lastMessageAt: sqlLaterTs(whatsappConversations.lastMessageAt, now),
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

/**
 * Texto da mensagem tal como o destinatário a recebeu, para ficar GRAVADO na
 * `whatsapp_messages.body`. PURA.
 *
 * Sem isto o inbox mostrava uma bolha vazia nos envios de template (só o nome do
 * template), e quem respondia deixava o backoffice sem saber ao que a pessoa
 * estava a responder.
 *
 * Com metadados, usa o texto REAL aprovado na Meta e a MESMA substituição por
 * papéis da pré-visualização — o que fica na BD é o que a Meta entregou.
 * Sem metadados (inspeção indisponível), grava na mesma uma linha legível com o
 * template e os valores enviados: nunca uma bolha vazia.
 */
export function renderOutboundBody(opts: {
  templateName: string;
  analysis: TemplateAnalysis | null;
  roles: TemplateBodyRoles | null;
  /** Semântico: [nome do destinatário, valor partilhado do diálogo]. */
  values: string[];
}): string {
  const { templateName, analysis, roles, values } = opts;
  const [recipient = "", shared = ""] = values;

  if (analysis?.bodyText) {
    const slots = resolveBodyParamRoles(analysis.paramNames, analysis.paramCount, roles);
    return previewTemplateBody(analysis.bodyText, slots, { recipient, shared });
  }

  return [`Template ${templateName}`, ...values.filter((v) => v.trim())].join(" · ");
}

/** Envia o template a UM destinatário válido e persiste a whatsapp_messages. */
async function sendOne(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  r: ResolvedRecipient,
  cfg: {
    templateName: string;
    languageCode: string;
    city: City;
    components?: unknown[];
    /** Texto enviado, já substituído (ver `renderOutboundBody`). */
    body: string;
    broadcastId: number;
    sentById: number | null;
    /** Motivo de a inspeção do template não estar disponível (anexado ao erro). */
    metaUnavailableReason?: string | null;
    clientRequestId?: string | null;
    /** 0375: categoria do template (metadados) e payload da nova tentativa (mensagens de equipa). */
    category?: string | null;
    sendPayload?: string | null;
  },
): Promise<BroadcastRecipient> {
  const phoneE164 = r.phoneE164!; // garantido pelo chamador
  const conversationId = await upsertConversation(db, phoneE164, r.employeeId);
  // Conteúdo REAL enviado a este destinatário — é o que o inbox mostra na
  // bolha e no preview da lista de conversas. A linha fica gravada ANTES de
  // chamar a Meta (17a): sem resposta dela fica "sem confirmação", não "falhou".
  const row = { conversationId, type: "template" as const, body: cfg.body || null, templateName: cfg.templateName };
  const reserved = await reserveOutboundMessage(db, {
    ...row,
    sentById: cfg.sentById,
    broadcastId: cfg.broadcastId,
    clientRequestId: cfg.clientRequestId ?? null,
    language: cfg.languageCode,
    category: cfg.category ?? null,
    city: cfg.city,
    sendPayload: cfg.sendPayload ?? null,
  });
  if (!reserved.reserved) {
    const dup = duplicateRequestOutcome(reserved.existing);
    return dup.kind === "sent"
      ? { ...r, status: "sent", waMessageId: dup.waMessageId ?? undefined, resumed: true }
      : { ...r, status: "failed", error: dup.kind === "in_doubt" ? dup.error : "Envio repetido.", resumed: true };
  }
  const res = await sendTemplateMessage(phoneE164, cfg.templateName, cfg.languageCode, cfg.components);
  // A nota da inspeção entra ANTES de persistir, para a linha da BD e a UI
  // contarem exactamente a mesma história.
  const error = res.ok ? null : withMetaHint(res.error, cfg.metaUnavailableReason ?? null);
  try {
    await finishOutboundMessage(db, reserved.id, row, res.ok ? res : { ok: false, error: error!, uncertain: res.uncertain, code: res.code });
  } catch (err: any) {
    // A Meta já respondeu: o resultado conta na mesma (a linha fica 'pending').
    console.warn("[WhatsApp] gravar o resultado do envio falhou:", String(err?.message ?? err).slice(0, 160));
  }

  return res.ok
    ? { ...r, status: "sent", waMessageId: res.waMessageId }
    : { ...r, status: "failed", error: error! };
}

/** Config de envio partilhada pelos dois modos (teste e normal). */
interface DispatchConfig {
  templateName: string;
  languageCode: string;
  city: City;
  bodyParam2: string | null;
  /** Metadados do template quando a inspeção correu bem; null = modo antigo. */
  analysis: TemplateAnalysis | null;
  /** Papéis dos parâmetros deste template (catálogo); null = mapeamento por posição. */
  roles: TemplateBodyRoles | null;
  /** Template declarado SEM parâmetros de body: não enviar nome nem campo. */
  noBodyParams: boolean;
  /** Porque é que a inspeção falhou (anexado aos erros, para diagnóstico). */
  metaUnavailableReason: string | null;
  includeFormLink: boolean;
  weekStart: string | null;
  broadcastId: number;
  sentById: number | null;
  /** Números com opt-out (STOP) — nunca recebem nada. */
  optedOut: Set<string>;
  /** Números "sem WhatsApp" (2× 131026 seguidos, 0375) — sem templates até escreverem. */
  unreachable: Set<string>;
  /** Fichas com "Não enviar WhatsApp" (17g) — nunca recebem envios em massa. */
  noAutoEmployees?: Set<number>;
  /** {{1}} quando o destinatário não tem nome utilizável ("Teste" só no modo teste). */
  fallbackName: string;
  /** {{2}} específico deste destinatário (sobrepõe `bodyParam2`). */
  bodyParam2Override?: string | null;
  /** Código único do envio feito por uma pessoa (inbox, 17a): repetir não reenvia. */
  clientRequestId?: string | null;
  /** Código do envio em massa (17b): cada destinatário fica com `recipientRequestKey`. */
  sendKey?: string | null;
  /** Números que já receberam este template nas últimas 24 h noutro envio (D32). */
  recentTemplate?: Set<string>;
}

/**
 * Acrescenta ao erro de um envio a nota de que a inspeção automática do template
 * não estava disponível — sem isto, um erro de formato de template parece um
 * mistério quando na verdade sabíamos que estávamos a enviar às cegas.
 */
function withMetaHint(error: string, reason: string | null): string {
  if (!reason) return error;
  return (
    `${error} — Nota: não foi possível inspecionar o template automaticamente (${reason}), ` +
    `por isso o envio foi feito com o formato assumido. Definir WHATSAPP_WABA_ID resolve a inspeção.`
  );
}

/**
 * Prepara e envia a UM destinatário: monta o {{1}} com o nome DESTE
 * destinatário, junta o {{2}} partilhado e, quando pedido, emite o token
 * single-use do formulário para o botão URL.
 *
 * Único ponto de envio dos dois modos — o modo teste deixou de ter um caminho
 * próprio para não voltar a divergir do envio real (era assim que um envio de
 * teste podia passar e o real falhar).
 */
async function dispatchOne(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  r: ResolvedRecipient,
  cfg: DispatchConfig,
): Promise<BroadcastRecipient> {
  // Opt-out ganha a tudo: nem token, nem conversa nova, nem chamada à Meta.
  if (r.phoneE164 && cfg.optedOut.has(r.phoneE164)) {
    return { ...r, status: "opted_out", error: OPTED_OUT_ERROR };
  }
  // 2× 131026 seguidos (0375): repetir não resolve — volta quando a pessoa escrever.
  if (r.phoneE164 && cfg.unreachable.has(r.phoneE164)) {
    return { ...r, status: "failed", error: UNREACHABLE_ERROR };
  }
  // "Não enviar WhatsApp" na ficha (17g): o mesmo efeito do STOP, com o motivo certo.
  if (r.employeeId != null && cfg.noAutoEmployees?.has(r.employeeId)) {
    return { ...r, status: "opted_out", error: NO_AUTO_WHATSAPP_ERROR };
  }
  const requestId = cfg.clientRequestId ?? (cfg.sendKey && r.phoneE164 ? recipientRequestKey(cfg.sendKey, r.phoneE164) : null);
  // Retoma (17b): este destinatário já foi tratado por este envio → nem token
  // novo do formulário, nem chamada à Meta.
  if (requestId) {
    const [prev] = await db
      .select({ status: whatsappMessages.status, waMessageId: whatsappMessages.waMessageId, errorDetail: whatsappMessages.errorDetail })
      .from(whatsappMessages)
      .where(eq(whatsappMessages.clientRequestId, requestId))
      .limit(1);
    if (prev) {
      const dup = duplicateRequestOutcome(prev);
      if (dup.kind === "sent") return { ...r, status: "sent", waMessageId: dup.waMessageId ?? undefined, resumed: true };
      if (dup.kind === "in_doubt") return { ...r, status: "failed", error: dup.error, resumed: true };
    }
  }
  // D32: o mesmo template já lhe chegou nas últimas 24 h (noutro envio) → não sai outra vez.
  if (r.phoneE164 && cfg.recentTemplate?.has(r.phoneE164)) {
    return { ...r, status: "recent_template", error: RECENT_TEMPLATE_ERROR };
  }
  // Template sem parâmetros → nenhum valor de body (com ou sem metadados). Sem
  // isto, o modo "sem inspeção" mandava o nome como {{1}} e a Meta recusava.
  const params = cfg.noBodyParams
    ? []
    : buildBodyParams(r.name, cfg.bodyParam2Override ?? cfg.bodyParam2, cfg.fallbackName);
  let buttonToken: string | undefined;

  if (cfg.includeFormLink && cfg.weekStart && r.employeeId != null) {
    try {
      const issued = await issueAvailabilityFormToken(db, r.employeeId, cfg.weekStart);
      buttonToken = issued.token;
    } catch (err: any) {
      // Falha a emitir token → regista como falha do destinatário SEM enviar
      // (o link seria inútil e o template tem o botão obrigatório).
      return { ...r, status: "failed", error: `Falha ao gerar link do formulário: ${err?.message || err}` };
    }
  } else if (cfg.includeFormLink && cfg.weekStart && r.employeeId == null) {
    // Número solto (ex.: teste) sem ficha: sem employeeId não há token possível.
    return {
      ...r,
      status: "failed",
      error: "Link do formulário pedido mas o número não corresponde a nenhum colaborador — sem token para o botão.",
    };
  }

  return sendOne(db, r, {
    templateName: cfg.templateName,
    languageCode: cfg.languageCode,
    city: cfg.city,
    components: buildComponents({ analysis: cfg.analysis, values: params, roles: cfg.roles, buttonToken }),
    body: renderOutboundBody({
      templateName: cfg.templateName,
      analysis: cfg.analysis,
      roles: cfg.roles,
      values: params,
    }),
    broadcastId: cfg.broadcastId,
    sentById: cfg.sentById,
    metaUnavailableReason: cfg.metaUnavailableReason,
    clientRequestId: requestId,
    category: cfg.analysis?.category ?? null,
    sendPayload: teamSendPayload(cfg, r, params, buttonToken),
  });
}

/**
 * O que é preciso para repetir uma mensagem de EQUIPA retida por 131049
 * (whatsappFailurePolicy): língua e components, com o token do formulário
 * trocado por um marcador — o token verdadeiro nunca fica na BD e a nova
 * tentativa emite um novo. null para tudo o resto.
 */
function teamSendPayload(cfg: DispatchConfig, r: ResolvedRecipient, params: string[], buttonToken: string | undefined): string | null {
  if (!isTeamRetryTemplate(cfg.templateName) || r.employeeId == null) return null;
  const components = buildComponents({
    analysis: cfg.analysis,
    values: params,
    roles: cfg.roles,
    buttonToken: buttonToken ? FORM_TOKEN_PLACEHOLDER : undefined,
  });
  return JSON.stringify({ languageCode: cfg.languageCode, components, formWeekStart: buttonToken ? cfg.weekStart : null });
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
/** Tudo o que um envio precisa de saber ANTES de tocar num destinatário. */
interface PreparedSend {
  /** Cidade do template (registo por cidade). */
  city: City;
  /** Etiqueta da mensagem no catálogo (para mensagens de erro). */
  label: string;
  templateName: string;
  languageCode: string;
  bodyParam2: string | null;
  weekStart: string | null;
  roles: TemplateBodyRoles | null;
  /** Template do catálogo declarado SEM parâmetros de body → nunca enviar `components.body`. */
  noBodyParams: boolean;
  analysis: TemplateAnalysis | null;
  metaUnavailableReason: string | null;
  includeFormLink: boolean;
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  /** Números com opt-out, lidos 1× por envio. */
  optedOut: Set<string>;
  /** Números "sem WhatsApp" (0375), lidos 1× por envio. */
  unreachable: Set<string>;
}

/**
 * Validação de env, catálogo e metadados — partilhada pelo broadcast aos extras
 * e pelo envio a contactos soltos (leads). Falha CEDO com mensagem clara, antes
 * de gastar uma única chamada de envio e antes de criar a linha do broadcast.
 *
 * O nome e a LÍNGUA vêm SEMPRE do registo por cidade (shared/driverTemplates.ts):
 * nada que o cliente mande decide a língua do envio (132001).
 */
async function prepareSend(opts: {
  templateId: string;
  city: City;
  bodyParam2?: string | null;
  weekStart?: string | null;
  includeFormLink?: boolean;
  /** O {{2}} vem por destinatário (bodyParam2ByEmployee) — conta como preenchido. */
  perRecipientParam2?: boolean;
}): Promise<PreparedSend> {
  // Guarda de env — falha cedo com mensagem clara.
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error(
      "WhatsApp não está configurado (faltam WHATSAPP_TOKEN e/ou WHATSAPP_PHONE_NUMBER_ID). Configura as env vars antes de enviar.",
    );
  }

  const def = findWhatsAppTemplate(opts.templateId);
  if (!def) throw new Error(`Mensagem desconhecida: ${opts.templateId}`);
  if (!isDriverCity(opts.city)) throw new Error(`Cidade sem templates de WhatsApp: ${String(opts.city)}`);
  const tpl = templateForCity(def, opts.city);
  if (!tpl) throw new Error(`${driverCityLabel(opts.city)} ainda não tem template de "${def.label}".`);
  const { name: templateName, language: languageCode, city } = tpl;
  // Papéis dos parâmetros vêm do registo do SERVIDOR, nunca do cliente.
  // `params: null` = template SEM parâmetros de body.
  const roles = tpl.params;
  const noBodyParams = !templateHasBodyParams(def);
  // Templates sem campo do diálogo nunca levam {{2}}, mesmo que a UI mande um.
  const bodyParam2 = def.sharedParam ? opts.bodyParam2?.trim() || null : null;
  const weekStart = opts.weekStart ?? null;

  // ── Inspeção do template (uma vez por broadcast) ───────────────────────────
  // O envio ADAPTA-SE ao template: parâmetros nomeados vs posicionais, quantos
  // são, e se há mesmo botão com link. Quando a inspeção corre bem, os erros de
  // configuração são apanhados AQUI — antes de gastar uma única chamada de envio
  // e antes de criar a linha do broadcast.
  const meta = await getTemplateMeta(templateName, languageCode);
  let analysis: TemplateAnalysis | null = null;
  let metaUnavailableReason: string | null = null;
  let includeFormLink = opts.includeFormLink === true;

  if (meta.available) {
    if (!meta.lookup.ok) throw new Error(`${driverCityLabel(city)}: ${describeLookupFailure(meta.lookup, templateName, languageCode)}`);
    analysis = meta.lookup.analysis;
    // Os metadados MANDAM sobre a checkbox: o template ou tem botão dinâmico
    // (e então precisa mesmo do token) ou não tem (e mandá-lo rebentava o envio).
    includeFormLink = analysis.hasDynamicUrlButton;
    if (noBodyParams && analysis.paramCount > 0) {
      throw new Error(
        `O template "${templateName}" está declarado no catálogo como SEM parâmetros, mas na Meta tem ` +
          `${analysis.paramCount}. Corrige o registo (shared/driverTemplates.ts) ou o template no WhatsApp Manager.`,
      );
    }
    const problem = validateTemplateUsage(analysis, {
      hasBodyParam2: !!bodyParam2 || opts.perRecipientParam2 === true,
      hasWeekStart: !!weekStart,
      roles,
    });
    if (problem) throw new Error(`${driverCityLabel(city)}: ${problem}`);
  } else {
    metaUnavailableReason = meta.reason;
    console.warn(
      `[WhatsApp] Inspeção do template "${templateName}" (${languageCode}) indisponível: ${meta.reason}. ` +
        `A enviar com o formato assumido.`,
    );
    // Sem metadados vale a checkbox — e a regra antiga de precisar de semana.
    if (includeFormLink && !weekStart) {
      throw new Error("Link do formulário pedido sem semana selecionada — escolhe a semana antes de enviar.");
    }
  }

  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");

  const optedOut = await optedOutPhones(db);
  const unreachable = await unreachablePhones(db);
  return { city, label: def.label, templateName, languageCode, bodyParam2, weekStart, roles, noBodyParams, analysis, metaUnavailableReason, includeFormLink, db, optedOut, unreachable };
}

/**
 * Índice do PRIMEIRO destinatário com o mesmo número, para cada posição
 * (-1 = é o primeiro / sem número). PURA — base da dedup: um número recebe
 * no máximo uma mensagem por envio, mesmo que apareça em duas fichas.
 */
export function duplicatePhoneIndexes(list: readonly { phoneE164: string | null }[]): number[] {
  const first = new Map<string, number>();
  return list.map((r, i) => {
    if (!r.phoneE164) return -1;
    const seen = first.get(r.phoneE164);
    if (seen !== undefined) return seen;
    first.set(r.phoneE164, i);
    return -1;
  });
}

/**
 * Contagens finais de um envio. PURA. Duplicados não são falha (a pessoa
 * recebeu pelo outro), nem quem já tinha recebido o template há menos de 24 h.
 */
export function summarize(recipients: readonly BroadcastRecipient[]): {
  sent: number;
  failed: number;
  invalidPhone: number;
  optedOut: number;
  recentTemplate: number;
  notSent: number;
} {
  const count = (st: RecipientStatus) => recipients.filter((r) => r.status === st).length;
  const sent = count("sent");
  const invalidPhone = count("invalid_phone");
  const optedOut = count("opted_out");
  const failed = count("failed");
  const recentTemplate = count("recent_template");
  return { sent, failed, invalidPhone, optedOut, recentTemplate, notSent: failed + invalidPhone + optedOut };
}

/**
 * Números que receberam `templateName` nas últimas 24 h noutro envio (D32).
 * Conta o que pode ter chegado (a enviar, aceite, enviado, entregue, lido, sem
 * confirmação); um envio que falhou de certeza não bloqueia. As mensagens do
 * PRÓPRIO envio (retoma, 17b) não contam.
 */
async function recentTemplatePhones(db: PreparedSend["db"], templateName: string, broadcastId: number): Promise<Set<string>> {
  const res = (await db.execute(sql`SELECT DISTINCT c.phoneE164 AS phone
      FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id = m.conversationId
     WHERE m.direction = 'out' AND m.type = 'template' AND m.templateName = ${templateName}
       AND m.status <> 'failed'
       AND m.createdAt >= NOW() - INTERVAL ${RECENT_TEMPLATE_HOURS} HOUR
       AND (m.broadcastId IS NULL OR m.broadcastId <> ${broadcastId})`)) as any;
  const rows = (Array.isArray(res?.[0]) ? res[0] : res) as Array<{ phone: string | null }>;
  return new Set(rows.map((r) => r.phone).filter((p): p is string => !!p));
}

/**
 * Corre o envio a uma lista já resolvida: número inválido → `invalid_phone`,
 * número repetido → `duplicate_phone`, resto → `dispatchOne` (que trata o
 * opt-out). A ordem da resposta é a ordem de `resolved`.
 */
async function dispatchAll(
  db: PreparedSend["db"],
  resolved: ResolvedRecipient[],
  cfgFor: (r: ResolvedRecipient) => DispatchConfig,
): Promise<BroadcastRecipient[]> {
  const dup = duplicatePhoneIndexes(resolved);
  const recipients: BroadcastRecipient[] = new Array(resolved.length);
  await runConcurrent(resolved.map((r, i) => ({ r, i })), BROADCAST_CONCURRENCY, async ({ r, i }) => {
    if (!r.phoneE164) {
      // Número inválido/ausente → regista falha SEM chamar a API. Não cria
      // conversa/mensagem: não há phoneE164 válido para lhes servir de chave.
      recipients[i] = { ...r, status: "invalid_phone", error: r.phone ? "Número inválido" : "Sem número" };
      return;
    }
    if (dup[i] >= 0) {
      const other = resolved[dup[i]];
      recipients[i] = { ...r, status: "duplicate_phone", error: `Mesmo número de ${other.name ?? "outro destinatário"} — enviado só uma vez.` };
      return;
    }
    // Um erro num destinatário nunca deixa buracos na lista (17b): antes o
    // runConcurrent engolia-o e quem lia `recipients[i]` rebentava — e o pedido
    // automático voltava a sair para todos na hora seguinte.
    try {
      recipients[i] = await dispatchOne(db, r, cfgFor(r));
    } catch (err: any) {
      recipients[i] = { ...r, status: "failed", error: `Erro no envio: ${String(err?.message ?? err).slice(0, 200)}` };
    }
  });
  for (let i = 0; i < recipients.length; i++) {
    if (!recipients[i]) recipients[i] = { ...resolved[i], status: "failed", error: "Envio interrompido." };
  }
  return recipients;
}

/** Um contacto solto (sem ficha de colaborador) a quem enviar um template. */
export interface ContactRecipient {
  name: string;
  phone: string;
}

function baseDispatch(prep: PreparedSend, broadcastId: number, sentById: number | null, fallbackName: string): DispatchConfig {
  return {
    templateName: prep.templateName,
    languageCode: prep.languageCode,
    city: prep.city,
    bodyParam2: prep.bodyParam2,
    analysis: prep.analysis,
    roles: prep.roles,
    noBodyParams: prep.noBodyParams,
    metaUnavailableReason: prep.metaUnavailableReason,
    includeFormLink: prep.includeFormLink,
    weekStart: prep.weekStart,
    broadcastId,
    sentById,
    optedOut: prep.optedOut,
    unreachable: prep.unreachable,
    fallbackName,
  };
}

/** Cidades por ordem do registo, sem repetições. PURA. */
export function orderedCities(cities: Iterable<City>): City[] {
  const set = new Set(cities);
  return DRIVER_CITIES.filter((c) => set.has(c));
}

/**
 * Código de envio (`sendKey`, ≤ 40) de UMA cidade dentro de um envio por
 * cidades. Determinístico: carregar outra vez retoma cada cidade (17b). PURA.
 */
export function citySendKey(sendKey: string | null | undefined, city: City): string | null {
  if (!sendKey) return null;
  return `${sendKey.slice(0, 33)}:${city.slice(0, 6)}`;
}

/**
 * Prepara (e valida) o template de CADA cidade antes de enviar a quem quer que
 * seja: num lote Lisboa + Porto com o template do Porto por aprovar não sai
 * nada, em vez de metade do lote seguir e a outra metade falhar.
 */
async function prepareCities(
  cities: City[],
  base: Omit<Parameters<typeof prepareSend>[0], "city">,
): Promise<Map<City, PreparedSend>> {
  const out = new Map<City, PreparedSend>();
  for (const city of cities) out.set(city, await prepareSend({ ...base, city }));
  return out;
}

/**
 * Envia um template a contactos SEM ficha (leads de extras), agrupados por
 * cidade (uma difusão por cidade). Mesmo caminho de envio dos extras
 * (`dispatchOne`): inspeção do template, conversa no inbox (sem employeeId),
 * linha em whatsapp_messages e difusão auditável. Sem campo do diálogo nem
 * link do formulário: um contacto sem ficha não tem token.
 * Em cada grupo, a ordem de `recipients` é a ordem de `contacts`, para o
 * chamador associar cada resultado ao seu lead.
 */
export async function sendTemplateToContacts(opts: {
  templateId: string;
  groups: { city: City; contacts: ContactRecipient[] }[];
  note?: string | null;
  createdById?: number | null;
  /** Código único do envio (do ecrã, 17b): carregar outra vez retoma, não duplica. */
  sendKey?: string | null;
}): Promise<{ city: City; summary: BroadcastSummary }[]> {
  const groups = opts.groups.filter((g) => g.contacts.length > 0);
  const preps = await prepareCities(orderedCities(groups.map((g) => g.city)), { templateId: opts.templateId });
  for (const prep of Array.from(preps.values())) {
    if (prep.includeFormLink) {
      throw new Error(
        `O template "${prep.templateName}" tem um botão com link dinâmico, que precisa do token pessoal de um ` +
          `colaborador — não pode ser enviado a contactos sem ficha.`,
      );
    }
    if (prep.roles && !prep.noBodyParams && prep.analysis && resolveBodyParamRoles(prep.analysis.paramNames, prep.analysis.paramCount, prep.roles).includes("shared")) {
      throw new Error(`O template "${prep.templateName}" precisa do campo do diálogo, que o envio a contactos não tem.`);
    }
  }

  const out: { city: City; summary: BroadcastSummary }[] = [];
  for (const g of groups) {
    const prep = preps.get(g.city)!;
    const { db } = prep;
    const sendKey = citySendKey(opts.sendKey, g.city);
    const resolved: ResolvedRecipient[] = g.contacts.map((c) => {
      const raw = (c.phone ?? "").trim();
      return {
        employeeId: null,
        name: c.name?.trim() || null,
        phone: raw,
        phoneE164: raw ? normalizePhoneE164(raw) : null,
      };
    });

    const { id: broadcastId } = await openBroadcast(db, {
      templateName: prep.templateName,
      city: prep.city,
      languageCode: prep.languageCode,
      note: `[LEADS] ${opts.note ?? ""}`.trim(),
      createdById: opts.createdById ?? null,
      weekStart: null,
      totalCount: resolved.length,
      sendKey,
    });

    const cfg: DispatchConfig = {
      ...baseDispatch(prep, broadcastId, opts.createdById ?? null, NEUTRAL_RECIPIENT_NAME),
      bodyParam2: null,
      includeFormLink: false,
      weekStart: null,
      sendKey,
      // D32: aos leads (à mão ou no lembrete automático) o mesmo template não volta antes de 24 h.
      recentTemplate: await recentTemplatePhones(db, prep.templateName, broadcastId),
    };
    const recipients = (await dispatchAll(db, resolved, () => cfg)).map((r) => ({ ...r, city: g.city }));
    const sum = summarize(recipients);
    await updateBroadcastCounts(db, broadcastId, { sentCount: sum.sent, failedCount: sum.notSent });
    out.push({
      city: g.city,
      summary: { broadcastId, total: resolved.length, sent: sum.sent, failed: sum.failed, invalidPhone: sum.invalidPhone, optedOut: sum.optedOut, recentTemplate: sum.recentTemplate, recipients },
    });
  }
  return out;
}

/**
 * Template a UMA conversa do inbox (janela fechada ou sem resposta ainda).
 * Envio NORMAL (não é teste): o {{1}} é o nome real — ficha → lead → nome de
 * perfil WhatsApp → neutro, nunca "Teste" — e fica registado como envio do
 * inbox. Conversa em opt-out → recusa (lança).
 */
export async function sendTemplateToConversation(opts: {
  conversationId: number;
  templateId: string;
  /** Cidade escolhida no diálogo (obrigatória: nunca se assume Lisboa). */
  city: City;
  bodyParam2?: string | null;
  weekStart?: string | null;
  createdById: number | null;
  /** Código único do envio (do ecrã, 17a): repetir o pedido não reenvia nem cria outra difusão. */
  clientRequestId?: string | null;
}): Promise<BroadcastSummary> {
  const def = findWhatsAppTemplate(opts.templateId);
  if (!def) throw new Error(`Template desconhecido: ${opts.templateId}`);
  const db0 = await getDb();
  if (!db0) throw new Error("Base de dados indisponível.");
  if (opts.clientRequestId) {
    const [prev] = await db0
      .select({ id: whatsappMessages.id, conversationId: whatsappMessages.conversationId, status: whatsappMessages.status, waMessageId: whatsappMessages.waMessageId, errorDetail: whatsappMessages.errorDetail, broadcastId: whatsappMessages.broadcastId })
      .from(whatsappMessages)
      .where(eq(whatsappMessages.clientRequestId, opts.clientRequestId))
      .limit(1);
    if (prev && prev.conversationId === opts.conversationId) {
      const dup = duplicateRequestOutcome(prev);
      if (dup.kind !== "retry") {
        const sent = dup.kind === "sent";
        return {
          broadcastId: prev.broadcastId ?? null, total: 1, sent: sent ? 1 : 0, failed: sent ? 0 : 1, invalidPhone: 0, optedOut: 0,
          recipients: [{ employeeId: null, name: null, phone: "", phoneE164: null, status: sent ? "sent" : "failed", ...(sent ? { waMessageId: dup.waMessageId ?? undefined } : { error: dup.error }) }],
        };
      }
    }
  }
  const [conv] = await db0
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      employeeId: whatsappConversations.employeeId,
      optedOutAt: whatsappConversations.optedOutAt,
      profileName: whatsappConversations.profileName,
      employeeName: employees.fullName,
      leadName: sql<string | null>`(SELECT ln.fullName FROM extra_leads ln WHERE ln.phoneE164 = ${whatsappConversations.phoneE164} COLLATE utf8mb4_unicode_ci ORDER BY ln.id DESC LIMIT 1)`,
    })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .where(eq(whatsappConversations.id, opts.conversationId))
    .limit(1);
  if (!conv) throw new Error("Conversa não encontrada.");
  if (conv.optedOutAt) throw new Error("Este contacto pediu para não receber mensagens (STOP) — não é possível enviar templates.");

  const prep = await prepareSend({
    templateId: def.id,
    city: opts.city,
    bodyParam2: opts.bodyParam2 ?? null,
    weekStart: opts.weekStart ?? null,
  });
  if (prep.includeFormLink && conv.employeeId == null) {
    throw new Error(`O template "${def.label}" leva o link pessoal do formulário — só pode ir para um colaborador com ficha.`);
  }
  const broadcastId = await insertBroadcast(prep.db, {
    templateName: prep.templateName,
    city: prep.city,
    languageCode: prep.languageCode,
    note: `[INBOX] conversa ${conv.id}`,
    createdById: opts.createdById,
    weekStart: prep.weekStart,
    totalCount: 1,
  });
  const recipient: ResolvedRecipient = {
    employeeId: conv.employeeId,
    name: conv.employeeName || conv.leadName || conv.profileName || null,
    phone: conv.phoneE164,
    phoneE164: conv.phoneE164,
  };
  const [r] = await dispatchAll(prep.db, [recipient], () =>
    ({ ...baseDispatch(prep, broadcastId, opts.createdById, NEUTRAL_RECIPIENT_NAME), clientRequestId: opts.clientRequestId ?? null }),
  );
  const sum = summarize([r]);
  await updateBroadcastCounts(prep.db, broadcastId, { sentCount: sum.sent, failedCount: sum.notSent });
  return { broadcastId, total: 1, sent: sum.sent, failed: sum.failed, invalidPhone: sum.invalidPhone, optedOut: sum.optedOut, recipients: [{ ...r, city: prep.city }] };
}

/**
 * Envio de um template aos motoristas extra, AGRUPADO POR CIDADE.
 *
 * Cada destinatário recebe o template da SUA cidade (`cityByEmployee`, decidido
 * no diálogo ou pelo job a partir da cidade do motorista/turno). Um lote com
 * Lisboa + Porto dá uma difusão por cidade, todas validadas antes de sair
 * qualquer mensagem. Quem não estiver no mapa não recebe nada.
 *
 * Modo teste (`testPhone` + `testCity`): um número, o template dessa cidade.
 */
export async function sendBroadcast(opts: SendBroadcastOptions): Promise<BroadcastSummary> {
  const perRecipient = opts.bodyParam2ByEmployee ?? null;
  const sentById = opts.createdById ?? null;
  const base = {
    templateId: opts.templateId,
    bodyParam2: opts.bodyParam2,
    weekStart: opts.weekStart,
    includeFormLink: opts.includeFormLink,
    perRecipientParam2: !!perRecipient && Object.keys(perRecipient).length > 0,
  };

  // ── MODO TESTE: 1 número, não toca nos extras ──────────────────────────────
  if (opts.testPhone) {
    if (!opts.testCity) throw new Error("Escolhe a cidade do template a testar.");
    const prep = await prepareSend({ ...base, city: opts.testCity });
    const { db } = prep;
    const rawTest = opts.testPhone.trim();
    const phoneE164 = normalizePhoneE164(rawTest);
    const note = `[TESTE] ${opts.note ?? ""}`.trim();
    const broadcastId = await insertBroadcast(db, {
      templateName: prep.templateName,
      city: prep.city,
      languageCode: prep.languageCode,
      note,
      createdById: sentById,
      weekStart: prep.weekStart,
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
        optedOut: 0,
        recipients: [
          { employeeId: null, name: UNKNOWN_RECIPIENT_NAME, phone: rawTest, phoneE164: null, status: "invalid_phone", error: "Número de teste inválido", city: prep.city },
        ],
      };
    }

    // Se o número de teste for de um colaborador ativo, o {{1}} leva o nome
    // REAL dele (e a conversa do inbox nasce associada à ficha) — assim o teste
    // é mesmo representativo do envio real. Só aqui é que o "Teste" é usado.
    const match = await findActiveEmployeeByPhoneE164(phoneE164);
    const recipient = await dispatchOne(
      db,
      { employeeId: match?.id ?? null, name: match?.fullName ?? null, phone: rawTest, phoneE164 },
      baseDispatch(prep, broadcastId, sentById, UNKNOWN_RECIPIENT_NAME),
    );
    const sum = summarize([recipient]);
    await updateBroadcastCounts(db, broadcastId, { sentCount: sum.sent, failedCount: sum.notSent });
    return { broadcastId, total: 1, sent: sum.sent, failed: sum.failed, invalidPhone: sum.invalidPhone, optedOut: sum.optedOut, recipients: [{ ...recipient, city: prep.city }] };
  }

  // ── MODO NORMAL ────────────────────────────────────────────────────────────
  const cityByEmployee = opts.cityByEmployee ?? {};
  const employeeIds = Object.keys(cityByEmployee).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (!employeeIds.length) throw new Error("Nenhum destinatário com cidade atribuída.");
  for (const id of employeeIds) {
    if (!isDriverCity(cityByEmployee[id])) throw new Error(`Cidade inválida para o colaborador ${id}.`);
  }
  // Só EXTRAS ativos (Jorge, 2 out 2026: disponibilidade e escala nunca vão
  // a funcionários). Um id de outra função pedido à mão fica de fora.
  const pool = await listActiveExtras();
  const resolved = resolveRecipients(pool, employeeIds);
  if (!resolved.length) throw new Error("Nenhum destinatário para este envio.");
  const preps = await prepareCities(orderedCities(resolved.map((r) => cityByEmployee[r.employeeId!])), base);
  const db = Array.from(preps.values())[0].db;

  const { employeesWithNoAuto } = await import("./contactPrefs");
  const noAutoEmployees = await employeesWithNoAuto(resolved.map((r) => r.employeeId).filter((id): id is number => id != null), "whatsapp");

  // Dedup GLOBAL por número (antes de partir por cidade): o mesmo número em
  // duas fichas de cidades diferentes recebe uma só mensagem.
  const dup = duplicatePhoneIndexes(resolved);
  const recipients: BroadcastRecipient[] = new Array(resolved.length);
  resolved.forEach((r, i) => {
    if (dup[i] >= 0) {
      const other = resolved[dup[i]];
      recipients[i] = {
        ...r,
        status: "duplicate_phone",
        error: `Mesmo número de ${other.name ?? "outro destinatário"} — enviado só uma vez.`,
        city: cityByEmployee[r.employeeId!],
      };
    }
  });

  const byCity: CityBroadcast[] = [];
  for (const [city, prep] of Array.from(preps.entries())) {
    const idx = resolved.map((_, i) => i).filter((i) => !recipients[i] && cityByEmployee[resolved[i].employeeId!] === city);
    const group = idx.map((i) => resolved[i]);
    const sendKey = citySendKey(opts.sendKey, city);
    const { id: broadcastId } = await openBroadcast(db, {
      templateName: prep.templateName,
      city,
      languageCode: prep.languageCode,
      note: opts.note ?? null,
      createdById: sentById,
      weekStart: prep.weekStart,
      totalCount: group.length,
      sendKey,
    });
    const recentTemplate = opts.blockRecentSameTemplate ? await recentTemplatePhones(db, prep.templateName, broadcastId) : undefined;
    const cfg = { ...baseDispatch(prep, broadcastId, sentById, NEUTRAL_RECIPIENT_NAME), sendKey, noAutoEmployees, recentTemplate };
    const sent = await dispatchAll(db, group, (r) =>
      r.employeeId != null && perRecipient?.[r.employeeId] ? { ...cfg, bodyParam2Override: perRecipient[r.employeeId] } : cfg,
    );
    sent.forEach((r, k) => {
      recipients[idx[k]] = { ...r, city };
    });
    const sum = summarize(sent);
    // Decisão 2 (Jorge): guarda a lista de extras (com employeeId) que falharam
    // por número inválido/ausente, para mais tarde "mostrar extras com número
    // inválido" e corrigir na origem. Não gera linha em whatsapp_messages.
    const invalidEmployeeIds = sent
      .filter((r) => r.status === "invalid_phone" && r.employeeId != null)
      .map((r) => r.employeeId as number);
    // failedCount na BD = tudo o que não foi enviado (falhas de API + inválidos + STOP).
    await updateBroadcastCounts(db, broadcastId, {
      sentCount: sum.sent,
      failedCount: sum.notSent,
      invalidEmployeeIds: invalidEmployeeIds.length ? invalidEmployeeIds : null,
    });
    byCity.push({ city, templateName: prep.templateName, languageCode: prep.languageCode, broadcastId, total: group.length, sent: sum.sent, notSent: sum.notSent });
  }

  const sum = summarize(recipients);
  return {
    broadcastId: byCity[0]?.broadcastId ?? null,
    total: resolved.length,
    sent: sum.sent,
    failed: sum.failed,
    invalidPhone: sum.invalidPhone,
    optedOut: sum.optedOut,
    recentTemplate: sum.recentTemplate,
    recipients,
    byCity,
  };
}
