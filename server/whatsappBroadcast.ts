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
import { employees, whatsappBroadcasts, whatsappConversations } from "../drizzle/schema";
import { OPTED_OUT_ERROR, optedOutPhones, recordOutboundMessage, sqlLaterTs } from "./whatsappStore";
import { normalizePhoneE164 } from "../shared/phone";
import {
  findActiveEmployeeByPhoneE164,
  listActiveEmployeesByIds,
  listActiveExtras,
  type ActiveExtra,
} from "./extrasAvailability";
import { sendTemplateMessage } from "./whatsapp";
import { runConcurrent } from "./_core/concurrency";
import { issueAvailabilityFormToken } from "./availabilityFormToken";
import {
  DEFAULT_TEMPLATE_LANGUAGE,
  NEUTRAL_RECIPIENT_NAME,
  UNKNOWN_RECIPIENT_NAME,
  findWhatsAppTemplate,
  findWhatsAppTemplateByName,
  templateHasBodyParams,
  firstNameOf,
  orderBodyValues,
  previewTemplateBody,
  resolveBodyParamRoles,
  sanitizeTemplateParam,
  type TemplateBodyRoles,
} from "../shared/whatsappTemplate";
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
 * número já estava noutro destinatário deste envio (1 mensagem por número).
 */
export type RecipientStatus = "sent" | "failed" | "invalid_phone" | "opted_out" | "duplicate_phone";

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
  /** Não enviados porque o número pediu STOP. */
  optedOut: number;
  recipients: BroadcastRecipient[];
}

export interface SendBroadcastOptions {
  templateName: string;
  languageCode?: string;
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
  employeeIds?: number[] | null; // subset; se vazio/null → todos os extras ativos
  weekStart?: string | null; // YYYY-MM-DD (contexto; obrigatório p/ includeFormLink)
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
    components?: unknown[];
    /** Texto enviado, já substituído (ver `renderOutboundBody`). */
    body: string;
    broadcastId: number;
    sentById: number | null;
    /** Motivo de a inspeção do template não estar disponível (anexado ao erro). */
    metaUnavailableReason?: string | null;
  },
): Promise<BroadcastRecipient> {
  const phoneE164 = r.phoneE164!; // garantido pelo chamador
  const conversationId = await upsertConversation(db, phoneE164, r.employeeId);
  const res = await sendTemplateMessage(phoneE164, cfg.templateName, cfg.languageCode, cfg.components);
  // A nota da inspeção entra ANTES de persistir, para a linha da BD e a UI
  // contarem exactamente a mesma história.
  const error = res.ok ? null : withMetaHint(res.error, cfg.metaUnavailableReason ?? null);

  await recordOutboundMessage(db, {
    conversationId,
    waMessageId: res.ok ? res.waMessageId : null,
    type: "template",
    // Conteúdo REAL enviado a este destinatário — é o que o inbox mostra na
    // bolha e no preview da lista de conversas.
    body: cfg.body || null,
    templateName: cfg.templateName,
    status: res.ok ? "sent" : "failed",
    errorDetail: error,
    sentById: cfg.sentById,
    broadcastId: cfg.broadcastId,
  });

  return res.ok
    ? { ...r, status: "sent", waMessageId: res.waMessageId }
    : { ...r, status: "failed", error: error! };
}

/** Config de envio partilhada pelos dois modos (teste e normal). */
interface DispatchConfig {
  templateName: string;
  languageCode: string;
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
  /** {{1}} quando o destinatário não tem nome utilizável ("Teste" só no modo teste). */
  fallbackName: string;
  /** {{2}} específico deste destinatário (sobrepõe `bodyParam2`). */
  bodyParam2Override?: string | null;
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
  });
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
}

/**
 * Validação de env, catálogo e metadados — partilhada pelo broadcast aos extras
 * e pelo envio a contactos soltos (leads). Falha CEDO com mensagem clara, antes
 * de gastar uma única chamada de envio e antes de criar a linha do broadcast.
 */
async function prepareSend(opts: {
  templateName: string;
  languageCode?: string | null;
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

  const templateName = opts.templateName.trim();
  if (!templateName) throw new Error("Nome do template em falta.");
  const languageCode = (opts.languageCode || DEFAULT_TEMPLATE_LANGUAGE).trim();
  const bodyParam2 = opts.bodyParam2?.trim() || null;
  const weekStart = opts.weekStart ?? null;
  // Papéis dos parâmetros vêm do catálogo do SERVIDOR (pelo nome do template),
  // nunca do cliente. Template fora do catálogo (ex.: nome escrito à mão no
  // dialog do inbox) → null = mapeamento por posição, como sempre foi.
  // Template do catálogo com `roles: null` = SEM parâmetros de body.
  const def = findWhatsAppTemplateByName(templateName, languageCode);
  const roles = def?.roles ?? null;
  const noBodyParams = !!def && !templateHasBodyParams(def);

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
    if (!meta.lookup.ok) throw new Error(describeLookupFailure(meta.lookup, templateName, languageCode));
    analysis = meta.lookup.analysis;
    // Os metadados MANDAM sobre a checkbox: o template ou tem botão dinâmico
    // (e então precisa mesmo do token) ou não tem (e mandá-lo rebentava o envio).
    includeFormLink = analysis.hasDynamicUrlButton;
    if (noBodyParams && analysis.paramCount > 0) {
      throw new Error(
        `O template "${templateName}" está declarado no catálogo como SEM parâmetros, mas na Meta tem ` +
          `${analysis.paramCount}. Corrige o catálogo (shared/whatsappTemplate.ts) ou o template no WhatsApp Manager.`,
      );
    }
    const problem = validateTemplateUsage(analysis, {
      hasBodyParam2: !!bodyParam2 || opts.perRecipientParam2 === true,
      hasWeekStart: !!weekStart,
      roles,
    });
    if (problem) throw new Error(problem);
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
  return { templateName, languageCode, bodyParam2, weekStart, roles, noBodyParams, analysis, metaUnavailableReason, includeFormLink, db, optedOut };
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

/** Contagens finais de um envio. PURA. Duplicados não são falha (a pessoa recebeu pelo outro). */
export function summarize(recipients: readonly BroadcastRecipient[]): {
  sent: number;
  failed: number;
  invalidPhone: number;
  optedOut: number;
  notSent: number;
} {
  const count = (st: RecipientStatus) => recipients.filter((r) => r.status === st).length;
  const sent = count("sent");
  const invalidPhone = count("invalid_phone");
  const optedOut = count("opted_out");
  const failed = count("failed");
  return { sent, failed, invalidPhone, optedOut, notSent: failed + invalidPhone + optedOut };
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
    recipients[i] = await dispatchOne(db, r, cfgFor(r));
  });
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
    fallbackName,
  };
}

/**
 * Envia um template a contactos SEM ficha (leads de extras). Mesmo caminho de
 * envio dos extras (`dispatchOne`) — inspeção do template, conversa no inbox
 * (sem employeeId), linha em whatsapp_messages e broadcast auditável — mas sem
 * campo do diálogo nem link do formulário: um contacto sem ficha não tem token.
 * A ordem de `recipients` na resposta é a ordem de `contacts`, para o chamador
 * associar cada resultado ao seu lead.
 */
export async function sendTemplateToContacts(opts: {
  templateName: string;
  languageCode?: string | null;
  contacts: ContactRecipient[];
  note?: string | null;
  createdById?: number | null;
}): Promise<BroadcastSummary> {
  const prep = await prepareSend({ templateName: opts.templateName, languageCode: opts.languageCode });
  if (prep.includeFormLink) {
    throw new Error(
      `O template "${prep.templateName}" tem um botão com link dinâmico, que precisa do token pessoal de um ` +
        `colaborador — não pode ser enviado a contactos sem ficha.`,
    );
  }
  if (prep.roles && !prep.noBodyParams && prep.analysis && resolveBodyParamRoles(prep.analysis.paramNames, prep.analysis.paramCount, prep.roles).includes("shared")) {
    throw new Error(`O template "${prep.templateName}" precisa do campo do diálogo, que o envio a contactos não tem.`);
  }
  const { db } = prep;

  const resolved: ResolvedRecipient[] = opts.contacts.map((c) => {
    const raw = (c.phone ?? "").trim();
    return {
      employeeId: null,
      name: c.name?.trim() || null,
      phone: raw,
      phoneE164: raw ? normalizePhoneE164(raw) : null,
    };
  });

  const broadcastId = await insertBroadcast(db, {
    templateName: prep.templateName,
    note: `[LEADS] ${opts.note ?? ""}`.trim(),
    createdById: opts.createdById ?? null,
    weekStart: null,
    totalCount: resolved.length,
  });

  const cfg: DispatchConfig = {
    ...baseDispatch(prep, broadcastId, opts.createdById ?? null, NEUTRAL_RECIPIENT_NAME),
    bodyParam2: null,
    includeFormLink: false,
    weekStart: null,
  };
  const recipients = await dispatchAll(db, resolved, () => cfg);
  const sum = summarize(recipients);
  await updateBroadcastCounts(db, broadcastId, { sentCount: sum.sent, failedCount: sum.notSent });
  return { broadcastId, total: resolved.length, sent: sum.sent, failed: sum.failed, invalidPhone: sum.invalidPhone, optedOut: sum.optedOut, recipients };
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
  bodyParam2?: string | null;
  weekStart?: string | null;
  createdById: number | null;
}): Promise<BroadcastSummary> {
  const def = findWhatsAppTemplate(opts.templateId);
  if (!def) throw new Error(`Template desconhecido: ${opts.templateId}`);
  const db0 = await getDb();
  if (!db0) throw new Error("Base de dados indisponível.");
  const [conv] = await db0
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      employeeId: whatsappConversations.employeeId,
      optedOutAt: whatsappConversations.optedOutAt,
      profileName: whatsappConversations.profileName,
      employeeName: employees.fullName,
      leadName: sql<string | null>`(SELECT ln.fullName FROM extra_leads ln WHERE ln.phoneE164 = ${whatsappConversations.phoneE164} ORDER BY ln.id DESC LIMIT 1)`,
    })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .where(eq(whatsappConversations.id, opts.conversationId))
    .limit(1);
  if (!conv) throw new Error("Conversa não encontrada.");
  if (conv.optedOutAt) throw new Error("Este contacto pediu para não receber mensagens (STOP) — não é possível enviar templates.");

  const prep = await prepareSend({
    templateName: def.name,
    languageCode: def.language,
    bodyParam2: def.sharedParam ? (opts.bodyParam2 ?? null) : null,
    weekStart: opts.weekStart ?? null,
  });
  if (prep.includeFormLink && conv.employeeId == null) {
    throw new Error(`O template "${def.label}" leva o link pessoal do formulário — só pode ir para um colaborador com ficha.`);
  }
  const broadcastId = await insertBroadcast(prep.db, {
    templateName: prep.templateName,
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
    baseDispatch(prep, broadcastId, opts.createdById, NEUTRAL_RECIPIENT_NAME),
  );
  const sum = summarize([r]);
  await updateBroadcastCounts(prep.db, broadcastId, { sentCount: sum.sent, failedCount: sum.notSent });
  return { broadcastId, total: 1, sent: sum.sent, failed: sum.failed, invalidPhone: sum.invalidPhone, optedOut: sum.optedOut, recipients: [r] };
}

export async function sendBroadcast(opts: SendBroadcastOptions): Promise<BroadcastSummary> {
  const perRecipient = opts.bodyParam2ByEmployee ?? null;
  const prep = await prepareSend({ ...opts, perRecipientParam2: !!perRecipient && Object.keys(perRecipient).length > 0 });
  const { db } = prep;
  const sentById = opts.createdById ?? null;

  // ── MODO TESTE: 1 número, não toca nos extras ──────────────────────────────
  if (opts.testPhone) {
    const rawTest = opts.testPhone.trim();
    const phoneE164 = normalizePhoneE164(rawTest);
    const note = `[TESTE] ${opts.note ?? ""}`.trim();
    const broadcastId = await insertBroadcast(db, {
      templateName: prep.templateName,
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
          { employeeId: null, name: UNKNOWN_RECIPIENT_NAME, phone: rawTest, phoneE164: null, status: "invalid_phone", error: "Número de teste inválido" },
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
    return { broadcastId, total: 1, sent: sum.sent, failed: sum.failed, invalidPhone: sum.invalidPhone, optedOut: sum.optedOut, recipients: [recipient] };
  }

  // ── MODO NORMAL ────────────────────────────────────────────────────────────
  const extras = await listActiveExtras();
  // A tabela do backoffice também mostra quem respondeu ao formulário sem ter
  // função "extra"; se o alvo explícito incluir algum, vai buscá-lo à ficha
  // (só ATIVOS) para não desaparecer do envio sem aviso.
  let pool = extras;
  if (opts.employeeIds && opts.employeeIds.length) {
    const known = new Set(extras.map((e) => e.id));
    const missing = opts.employeeIds.filter((id) => !known.has(id));
    if (missing.length > 0) pool = [...extras, ...(await listActiveEmployeesByIds(missing))];
  }
  const resolved = resolveRecipients(pool, opts.employeeIds ?? null);

  const broadcastId = await insertBroadcast(db, {
    templateName: prep.templateName,
    note: opts.note ?? null,
    createdById: sentById,
    weekStart: prep.weekStart,
    totalCount: resolved.length,
  });

  const base = baseDispatch(prep, broadcastId, sentById, NEUTRAL_RECIPIENT_NAME);
  const recipients = await dispatchAll(db, resolved, (r) =>
    r.employeeId != null && perRecipient?.[r.employeeId] ? { ...base, bodyParam2Override: perRecipient[r.employeeId] } : base,
  );
  const sum = summarize(recipients);

  // Decisão 2 (Jorge): guarda a lista de extras (com employeeId) que falharam
  // por número inválido/ausente, para mais tarde "mostrar extras com número
  // inválido" e corrigir na origem. Não gera linha em whatsapp_messages.
  const invalidEmployeeIds = recipients
    .filter((r) => r.status === "invalid_phone" && r.employeeId != null)
    .map((r) => r.employeeId as number);

  // failedCount na BD = tudo o que não foi enviado (falhas de API + inválidos + STOP).
  await updateBroadcastCounts(db, broadcastId, {
    sentCount: sum.sent,
    failedCount: sum.notSent,
    invalidEmployeeIds: invalidEmployeeIds.length ? invalidEmployeeIds : null,
  });

  return { broadcastId, total: resolved.length, sent: sum.sent, failed: sum.failed, invalidPhone: sum.invalidPhone, optedOut: sum.optedOut, recipients };
}
