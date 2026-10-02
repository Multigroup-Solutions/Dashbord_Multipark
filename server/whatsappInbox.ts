/**
 * Inbox de WhatsApp (Fase 3): listagem de conversas, thread, marcar-lido e
 * resposta 1-a-1 (só dentro da janela de 24h).
 *
 * `deriveWindowState` é pura e testável — é a fonte única do estado da janela,
 * usada quer pela UI (para não duplicar lógica) quer pela validação server-side
 * do `reply`.
 */
import { projectVisible, scopedProjectIds } from "./extrasCityFilter";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { employees, users, whatsappConversations, whatsappMessages } from "../drizzle/schema";
import { sendTextMessage } from "./whatsapp";
import { firstNameOf } from "../shared/whatsappTemplate";
import { OPTED_OUT_ERROR, duplicateRequestOutcome, finishOutboundMessage, previewFields, reserveOutboundMessage } from "./whatsappStore";
import type { ConversationStatus } from "../shared/whatsappConversation";
import { INBOX_LIST_LIMIT } from "../shared/whatsappInboxView";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export type WindowState = "awaiting_first_reply" | "open" | "expired";

export interface WindowInfo {
  windowState: WindowState;
  windowExpiresAt: string | null; // ISO (UTC), só quando 'open'
}

/**
 * Estado da janela de 24h a partir de `lastInboundAt`:
 *   - awaiting_first_reply: null → template enviado, nunca respondeu.
 *   - open: agora − lastInboundAt < 24h.
 *   - expired: já passaram 24h.
 * As timestamps da BD são wall-clock UTC ('YYYY-MM-DD HH:MM:SS' sem tz), por
 * isso são interpretadas como UTC (sufixo Z) para a matemática bater certo.
 */
export function deriveWindowState(lastInboundAt: string | null, now: Date = new Date()): WindowInfo {
  if (!lastInboundAt) return { windowState: "awaiting_first_reply", windowExpiresAt: null };
  const last = parseDbUtc(lastInboundAt);
  if (last == null) return { windowState: "expired", windowExpiresAt: null };
  const expires = last + WINDOW_MS;
  if (now.getTime() < expires) {
    return { windowState: "open", windowExpiresAt: new Date(expires).toISOString() };
  }
  return { windowState: "expired", windowExpiresAt: null };
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC) → epoch ms, ou null. Aceita já-ISO com Z/T. */
function parseDbUtc(s: string): number | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const t = new Date(withZ).getTime();
  return Number.isNaN(t) ? null : t;
}

// ─── Listagem de conversas ──────────────────────────────────────────────────

export interface ConversationRow {
  id: number;
  phoneE164: string;
  employeeId: number | null;
  name: string; // nome do extra ou o próprio número
  /**
   * Foto da ficha do colaborador ligado (`employees.photoUrl`, a MESMA URL que
   * o RH e o Extras-Dia mostram); null = sem ficha ou sem foto → a UI mostra as
   * iniciais. A Cloud API da Meta não dá a foto de perfil do WhatsApp.
   */
  photoUrl: string | null;
  unreadCount: number;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  preview: string | null;
  previewDirection: "in" | "out" | null;
  /** Pediu para não receber mensagens (STOP). */
  optedOut: boolean;
  windowState: WindowState;
  windowExpiresAt: string | null;
  /** aberto/pendente/resolvido (0097). */
  status: ConversationStatus;
  assignedUserId: number | null;
  assignedName: string | null;
  /** 1.ª mensagem recebida ainda sem resposta (SLA); null = respondida. */
  awaitingSince: string | null;
  linkedBookingRef: string | null;
  linkedBookingLabel: string | null;
  linkedClientEmail: string | null;
  /** Triagem por IA (0123): intenção e urgência (null = por classificar). */
  aiIntent: string | null;
  aiUrgency: string | null;
  /** Caixa por tema (17f): mailboxKey da caixa; null = Geral. */
  boxKey: string | null;
  /**
   * A leitura completa falhou e veio a de recurso: estado, responsável e
   * ligações NÃO são reais (17a) — o ecrã avisa.
   */
  partial?: true;
}

/**
 * Filtro SQL da pesquisa (nome da ficha / lead / perfil, número, resumo ou
 * responsável). Aplica-se ANTES do LIMIT, por isso uma conversa antiga fora
 * das mais recentes também aparece. null = sem pesquisa.
 */
export function conversationSearchSql(raw: string | null | undefined): SQL | null {
  const q = String(raw ?? "").trim().slice(0, 120);
  if (!q) return null;
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const digits = q.replace(/\D/g, "");
  const parts: SQL[] = [
    sql`${whatsappConversations.profileName} LIKE ${like}`,
    sql`${employees.fullName} LIKE ${like}`,
    sql`${whatsappConversations.lastPreview} LIKE ${like}`,
    sql`EXISTS (SELECT 1 FROM extra_leads sl WHERE sl.phoneE164 = ${whatsappConversations.phoneE164} COLLATE utf8mb4_unicode_ci AND sl.fullName LIKE ${like})`,
    sql`EXISTS (SELECT 1 FROM users su WHERE su.id = ${whatsappConversations.assignedUserId} AND su.name LIKE ${like})`,
  ];
  if (digits.length >= 3) parts.push(sql`${whatsappConversations.phoneE164} LIKE ${`%${digits}%`}`);
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * Ordem da lista do inbox (pedido Jorge 2026-09-10) — regra ÚNICA, pura e
 * testável; a UI só agrupa, nunca reordena:
 *   1. Conversas com a janela ABERTA primeiro, da que tem MENOS tempo para
 *      responder para a que tem mais (`windowExpiresAt` ascendente) — quem está
 *      prestes a fechar fica no topo.
 *   2. Depois as que estão FORA da janela (`expired` e `awaiting_first_reply`),
 *      pela última mensagem trocada: mais recente primeiro, mais antiga no fim.
 * Empates: dentro do grupo aberto, última mensagem mais recente primeiro; no
 * fim, id decrescente para a ordem ser determinística. `lastMessageAt` nulo
 * (não deve acontecer — a conversa nasce com mensagem) vai para o fim.
 */
export function sortConversations<T extends Pick<ConversationRow, "id" | "windowState" | "windowExpiresAt" | "lastMessageAt">>(
  rows: readonly T[],
): T[] {
  const NULL_LAST = Number.POSITIVE_INFINITY;
  const expiresMs = (r: T) => (r.windowExpiresAt ? new Date(r.windowExpiresAt).getTime() : NULL_LAST);
  const lastMsgMs = (r: T) => (r.lastMessageAt ? (parseDbUtc(r.lastMessageAt) ?? -1) : -1);

  return [...rows].sort((a, b) => {
    const aOpen = a.windowState === "open" ? 0 : 1;
    const bOpen = b.windowState === "open" ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    if (aOpen === 0) {
      const byExpiry = expiresMs(a) - expiresMs(b);
      if (byExpiry !== 0) return byExpiry;
    }
    const byLastMsg = lastMsgMs(b) - lastMsgMs(a);
    if (byLastMsg !== 0) return byLastMsg;
    return b.id - a.id;
  });
}

// ─── Visibilidade por cidade ────────────────────────────────────────────────

/** O que se sabe de uma conversa para decidir a cidade. */
export interface ConversationCityFacts {
  employeeId: number | null;
  employeeProjectId: number | null;
  /** projectId de cada lead com este número (vazio = não é lead). */
  leadProjectIds: (number | null)[];
  /** Cidade inferida pelo telefone de uma reserva (só números soltos). */
  bookingProjectId: number | null;
}

/**
 * Cidade (ponto 10), regra ÚNICA — `visibilitySql` é a mesma coisa em SQL. PURA.
 *  - quem vê todas as cidades (`scope` undefined) vê tudo;
 *  - extra: pela cidade da ficha (ficha sem cidade → visível);
 *  - lead: se ALGUM lead com o número é da cidade (ou sem cidade);
 *  - número solto (sem ficha nem lead): pela cidade da reserva com o mesmo
 *    telefone (últimos 9 dígitos); SEM cidade conhecida → todos os que têm o
 *    WhatsApp o veem (Jorge, 2 out 2026: "só abre a cidade que tens acesso ou
 *    aqueles que não têm cidade" — antes só quem via todas as cidades).
 */
export function conversationVisibleTo(c: ConversationCityFacts, scope: number[] | undefined): boolean {
  if (scope === undefined) return true;
  if (c.employeeId != null) return projectVisible(c.employeeProjectId, scope);
  if (c.leadProjectIds.length) return c.leadProjectIds.some((p) => projectVisible(p, scope));
  return c.bookingProjectId == null || scope.includes(c.bookingProjectId);
}

/** Mesma regra de `conversationVisibleTo`, em SQL (aplicada ANTES do LIMIT). */
export function visibilitySql(scope: number[] | undefined): SQL {
  if (scope === undefined) return sql`1 = 1`;
  if (!scope.length) return sql`1 = 0`;
  const inScope = (col: SQL) => sql`${col} IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})`;
  return sql`(
    (${whatsappConversations.employeeId} IS NOT NULL AND (${employees.projectId} IS NULL OR ${inScope(sql`${employees.projectId}`)}))
    OR (${whatsappConversations.employeeId} IS NULL AND EXISTS (
      SELECT 1 FROM extra_leads vis_lead WHERE vis_lead.phoneE164 = ${whatsappConversations.phoneE164} COLLATE utf8mb4_unicode_ci
        AND (vis_lead.projectId IS NULL OR ${inScope(sql`vis_lead.projectId`)})))
    OR (${whatsappConversations.employeeId} IS NULL
      AND NOT EXISTS (SELECT 1 FROM extra_leads vis_any WHERE vis_any.phoneE164 = ${whatsappConversations.phoneE164} COLLATE utf8mb4_unicode_ci)
      AND (${whatsappConversations.bookingProjectId} IS NULL OR ${inScope(sql`${whatsappConversations.bookingProjectId}`)}))
  )`;
}

// ─── Caixas por tema (17f) ───────────────────────────────────────────────────

type BoxUser = { id: number; role: string; accessOverrides?: unknown } | null | undefined;

/**
 * Caixas que esta pessoa NÃO vê (pelo módulo/papéis da caixa — a mesma regra
 * das caixas de email, sem exigir o módulo Comunicação). As conversas de
 * WhatsApp nessas caixas não lhe aparecem; as da "Geral" (sem caixa) e de
 * caixas desconhecidas aparecem. Super admin: nenhuma.
 */
export async function hiddenBoxKeys(user: BoxUser): Promise<string[]> {
  if (!user) return [];
  const { withOverrides } = await import("./_core/access");
  const v = withOverrides(user as any);
  if (v.role === "super_admin") return [];
  const { listMailboxes } = await import("./mail/store");
  const { canSeeBoxModule } = await import("../shared/commsBoxes");
  return (await listMailboxes()).filter((b) => !canSeeBoxModule({ id: v.id, role: v.role, accessOverrides: v.accessOverrides ?? null }, b)).map((b) => b.key);
}

/** Condição SQL das caixas visíveis (null = sem restrição). */
export function boxVisibleSql(hidden: readonly string[]): SQL | null {
  if (!hidden.length) return null;
  return sql`(${whatsappConversations.boxKey} IS NULL OR ${whatsappConversations.boxKey} NOT IN (${sql.join(hidden.map((k) => sql`${k}`), sql`, `)}))`;
}

/**
 * Colaborador ou candidato (lead) → caixa RH ("rule"), salvo escolha à mão.
 * Chamado a cada mensagem recebida. Nunca lança.
 */
export async function assignBoxByRule(conversationId: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`UPDATE whatsapp_conversations c SET c.boxKey = 'rh', c.boxSource = 'rule'
      WHERE c.id = ${conversationId} AND COALESCE(c.boxSource, '') <> 'manual' AND COALESCE(c.boxKey, '') <> 'rh'
        AND (c.employeeId IS NOT NULL OR EXISTS (SELECT 1 FROM extra_leads l WHERE l.phoneE164 = c.phoneE164 COLLATE utf8mb4_unicode_ci))`);
  } catch (err: any) {
    console.warn("[WhatsApp caixa] regra falhou:", conversationId, String(err?.message ?? err).slice(0, 160));
  }
}

/**
 * A conversa pertence às cidades do utilizador? (guarda da thread/resposta/lido)
 * Com `user`, também a caixa (17f): uma conversa numa caixa que a pessoa não
 * vê fica escondida como as de outra cidade.
 */
export async function conversationVisible(conversationId: number, user?: BoxUser): Promise<boolean> {
  const hidden = user ? await hiddenBoxKeys(user) : [];
  const boxCond = boxVisibleSql(hidden);
  const scope = scopedProjectIds();
  if (scope === undefined && !boxCond) return true;
  const db = await getDb();
  if (!db) return false;
  const exists = await db
    .select({ id: whatsappConversations.id })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!exists.length) return true; // inexistente → quem chama trata do "não encontrada"
  const rows = await db
    .select({ id: whatsappConversations.id })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .where(and(eq(whatsappConversations.id, conversationId), visibilitySql(scope), boxCond ?? sql`1 = 1`))
    .limit(1);
  return rows.length > 0;
}

/**
 * Nome do cliente do CRM de cada número (17f: saber quem é; o mais recente).
 * Uma consulta só, com os números como PARÂMETROS: o índice `idx_crm_phone`
 * serve seja qual for a collation das tabelas do CRM (uma subconsulta por
 * conversa com COLLATE podia ler a tabela toda 300 vezes). Se falhar, a lista
 * continua — só fica sem o nome do CRM (cai no nome do perfil).
 */
export async function crmNamesByPhone(db: any, phones: ReadonlyArray<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = Array.from(new Set(phones.filter((p) => !!p))).slice(0, INBOX_LIST_LIMIT);
  if (!uniq.length) return out;
  try {
    const [rows] = (await db.execute(sql`SELECT cp.phone AS phone, cc.displayName AS name FROM crm_client_phones cp
      JOIN crm_clients cc ON cc.id = cp.clientId AND cc.status = 'active'
      WHERE cp.phone IN (${sql.join(uniq.map((p) => sql`${p}`), sql`, `)}) AND cc.displayName IS NOT NULL AND cc.displayName <> ''
      ORDER BY cc.lastVisit DESC`)) as any;
    for (const r of (rows ?? []) as any[]) {
      const phone = String(r.phone);
      if (!out.has(phone)) out.set(phone, String(r.name));
    }
  } catch (err: any) {
    console.warn("[WhatsApp] nomes do CRM indisponíveis:", String(err?.message ?? err).slice(0, 200));
  }
  return out;
}

/** Nome do lead mais recente com o número da conversa (subquery escalar). */
export const leadNameSql = sql<string | null>`(SELECT ln.fullName FROM extra_leads ln WHERE ln.phoneE164 = ${whatsappConversations.phoneE164} COLLATE utf8mb4_unicode_ci ORDER BY ln.id DESC LIMIT 1)`;

/**
 * Conversas antigas sem resumo (escritas antes da 0094 e não apanhadas pelo
 * backfill): calcula-o a partir da última mensagem e grava-o, 1× por conversa.
 */
async function fillMissingPreviews(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, ids: number[]): Promise<Map<number, ReturnType<typeof previewFields>>> {
  const out = new Map<number, ReturnType<typeof previewFields>>();
  if (!ids.length) return out;
  const [rows] = (await db.execute(sql`
    SELECT m.conversationId, m.body, m.type, m.templateName, m.mediaType, m.direction
      FROM whatsapp_messages m
      JOIN (SELECT conversationId, MAX(id) AS maxId FROM whatsapp_messages
             WHERE conversationId IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
             GROUP BY conversationId) t ON t.maxId = m.id`)) as any;
  for (const r of rows as any[]) {
    const p = previewFields({ body: r.body, type: r.type, templateName: r.templateName, mediaType: r.mediaType, direction: r.direction });
    out.set(Number(r.conversationId), p);
    await db.update(whatsappConversations).set(p).where(and(eq(whatsappConversations.id, Number(r.conversationId)), isNull(whatsappConversations.lastDirection)));
  }
  return out;
}

export async function listConversations(opts: { search?: string | null; boxKey?: string | null; hiddenBoxes?: readonly string[] } = {}): Promise<ConversationRow[]> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const searchCond = conversationSearchSql(opts.search);
  // Caixa (17f): as que a pessoa não vê saem; filtro por uma caixa ("geral" = sem caixa).
  const conds: SQL[] = [visibilitySql(scopedProjectIds())];
  if (searchCond) conds.push(searchCond);
  const boxCond = boxVisibleSql(opts.hiddenBoxes ?? []);
  if (boxCond) conds.push(boxCond);
  if (opts.boxKey === "geral") conds.push(sql`${whatsappConversations.boxKey} IS NULL`);
  else if (opts.boxKey) conds.push(sql`${whatsappConversations.boxKey} = ${opts.boxKey}`);
  const whereList = and(...conds);

  // O filtro de cidade vai no WHERE, ANTES do LIMIT — senão quem só vê uma
  // cidade podia ficar com uma lista vazia porque as 300 mais recentes eram
  // de outra.
  const fullQuery = () => db
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      employeeId: whatsappConversations.employeeId,
      unreadCount: whatsappConversations.unreadCount,
      lastInboundAt: whatsappConversations.lastInboundAt,
      lastMessageAt: whatsappConversations.lastMessageAt,
      lastPreview: whatsappConversations.lastPreview,
      lastDirection: whatsappConversations.lastDirection,
      optedOutAt: whatsappConversations.optedOutAt,
      profileName: whatsappConversations.profileName,
      employeeName: employees.fullName,
      employeePhotoUrl: employees.photoUrl,
      leadName: leadNameSql,
      status: whatsappConversations.status,
      assignedUserId: whatsappConversations.assignedUserId,
      assignedName: users.name,
      awaitingSince: whatsappConversations.awaitingSince,
      linkedBookingRef: whatsappConversations.linkedBookingRef,
      linkedBookingLabel: whatsappConversations.linkedBookingLabel,
      linkedClientEmail: whatsappConversations.linkedClientEmail,
      aiIntent: whatsappConversations.aiIntent,
      aiUrgency: whatsappConversations.aiUrgency,
      boxKey: whatsappConversations.boxKey,
    })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .leftJoin(users, eq(whatsappConversations.assignedUserId, users.id))
    .where(whereList)
    .orderBy(desc(whatsappConversations.lastMessageAt))
    .limit(INBOX_LIST_LIMIT);

  // Rede de segurança: se a query completa falhar em produção (ex.: coluna da
  // 0097 em falta, JOIN a users), a caixa continua a mostrar as conversas com
  // os campos base — e o erro fica no log com a mensagem do MySQL.
  const baseQuery = () => db
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      employeeId: whatsappConversations.employeeId,
      unreadCount: whatsappConversations.unreadCount,
      lastInboundAt: whatsappConversations.lastInboundAt,
      lastMessageAt: whatsappConversations.lastMessageAt,
      lastPreview: whatsappConversations.lastPreview,
      lastDirection: whatsappConversations.lastDirection,
      optedOutAt: whatsappConversations.optedOutAt,
      profileName: whatsappConversations.profileName,
      employeeName: employees.fullName,
      employeePhotoUrl: employees.photoUrl,
      leadName: sql<string | null>`NULL`,
      status: sql<ConversationStatus>`'aberto'`,
      assignedUserId: sql<number | null>`NULL`,
      assignedName: sql<string | null>`NULL`,
      awaitingSince: sql<string | null>`NULL`,
      linkedBookingRef: sql<string | null>`NULL`,
      linkedBookingLabel: sql<string | null>`NULL`,
      linkedClientEmail: sql<string | null>`NULL`,
      aiIntent: sql<string | null>`NULL`,
      aiUrgency: sql<string | null>`NULL`,
      boxKey: sql<string | null>`NULL`,
    })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .where(whereList)
    .orderBy(desc(whatsappConversations.lastMessageAt))
    .limit(INBOX_LIST_LIMIT);

  let convs: Awaited<ReturnType<typeof fullQuery>>;
  let partial = false;
  try {
    convs = await fullQuery();
  } catch (err: any) {
    console.error("[WhatsApp] listConversations falhou, a usar query base:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 500));
    convs = (await baseQuery()) as typeof convs;
    partial = true;
  }

  const missing = convs.filter((c) => c.lastDirection == null && c.lastMessageAt != null).map((c) => c.id);
  const filled = await fillMissingPreviews(db, missing);
  // Sem ficha nem lead: o nome do cliente do CRM (17f).
  const crmNames = await crmNamesByPhone(db, convs.filter((c) => !c.employeeName?.trim() && !c.leadName?.trim()).map((c) => c.phoneE164));

  // A query vem por `lastMessageAt` desc só para o cap de 300 apanhar as
  // conversas ativas; a ordem que a UI mostra é a de `sortConversations`.
  const rows: ConversationRow[] = convs.map((c) => {
    const w = deriveWindowState(c.lastInboundAt);
    const f = filled.get(c.id);
    return {
      id: c.id,
      phoneE164: c.phoneE164,
      employeeId: c.employeeId,
      name: conversationDisplayName({ ...c, crmName: crmNames.get(c.phoneE164) ?? null }),
      photoUrl: c.employeePhotoUrl?.trim() || null,
      unreadCount: c.unreadCount,
      lastInboundAt: c.lastInboundAt,
      lastMessageAt: c.lastMessageAt,
      preview: (f?.lastPreview ?? c.lastPreview) || null,
      previewDirection: (f?.lastDirection ?? c.lastDirection) ?? null,
      optedOut: c.optedOutAt != null,
      windowState: w.windowState,
      windowExpiresAt: w.windowExpiresAt,
      status: c.status,
      assignedUserId: c.assignedUserId,
      assignedName: c.assignedName ?? null,
      awaitingSince: c.awaitingSince,
      linkedBookingRef: c.linkedBookingRef,
      linkedBookingLabel: c.linkedBookingLabel,
      linkedClientEmail: c.linkedClientEmail,
      aiIntent: c.aiIntent ?? null,
      aiUrgency: c.aiUrgency ?? null,
      boxKey: c.boxKey ?? null,
      ...(partial ? { partial: true as const } : {}),
    };
  });
  return sortConversations(rows);
}

/** Nome a mostrar: ficha → lead → cliente do CRM (17f) → nome de perfil WhatsApp → número. PURA. */
export function conversationDisplayName(c: {
  employeeName?: string | null;
  leadName?: string | null;
  crmName?: string | null;
  profileName?: string | null;
  phoneE164: string;
}): string {
  return c.employeeName?.trim() || c.leadName?.trim() || c.crmName?.trim() || c.profileName?.trim() || c.phoneE164;
}

// ─── Thread de uma conversa ─────────────────────────────────────────────────

export interface ThreadMessage {
  id: number;
  direction: "in" | "out";
  type: "text" | "template" | "image" | "audio" | "document" | "video";
  body: string | null;
  templateName: string | null;
  /** Media recebida. O ficheiro é privado: a UI pede um URL assinado (whatsapp.mediaUrl). */
  mediaType: "image" | "audio" | "video" | "document" | "sticker" | null;
  /** Há ficheiro guardado? false com `mediaType` preenchido = download falhou (o cron re-tenta). */
  mediaAvailable: boolean;
  /**
   * Sem ficheiro: "retrying" (o cron volta a tentar), "gave_up" (desistiu: 5
   * tentativas, demasiado grande ou mais de 25 dias — a Meta já não o tem).
   */
  mediaState: "ok" | "retrying" | "gave_up" | null;
  mediaMime: string | null;
  status: string;
  errorDetail: string | null;
  waTimestamp: string | null;
  createdAt: string;
}

export interface ConversationThread {
  conversationId: number;
  phoneE164: string;
  /** Ficha do colaborador associada (null = número sem ficha; o cabeçalho não fica clicável). */
  employeeId: number | null;
  name: string;
  /** Foto da ficha ligada (ver `ConversationRow.photoUrl`); null = iniciais. */
  photoUrl: string | null;
  /** Primeiro nome real do destinatário (ficha → lead → perfil); null = só temos o número. */
  recipientFirstName: string | null;
  /** Pediu para não receber mensagens (STOP). */
  optedOut: boolean;
  optedOutAt: string | null;
  windowState: WindowState;
  windowExpiresAt: string | null;
  status: ConversationStatus;
  assignedUserId: number | null;
  awaitingSince: string | null;
  unreadCount: number;
  linkedBookingRef: string | null;
  linkedBookingLabel: string | null;
  linkedClientEmail: string | null;
  aiIntent: string | null;
  aiUrgency: string | null;
  messages: ThreadMessage[];
}

/** Estado do ficheiro de uma mensagem recebida (mesmas regras do cron de re-tentativa). PURA. */
export function inboundMediaState(m: { mediaType: string | null; mediaAvailable: boolean; mediaAttempts: number | null; createdAt: string }, nowMs = Date.now()): ThreadMessage["mediaState"] {
  if (!m.mediaType) return null;
  if (m.mediaAvailable) return "ok";
  const ageDays = (nowMs - Date.parse(m.createdAt.replace(" ", "T") + "Z")) / 86_400_000;
  return (m.mediaAttempts ?? 0) >= 5 || ageDays > 25 ? "gave_up" : "retrying";
}

export async function getConversationThread(conversationId: number, limit = 100): Promise<ConversationThread | null> {
  const db = await getDb();
  if (!db) return null;

  const convRows = await db
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      employeeId: whatsappConversations.employeeId,
      lastInboundAt: whatsappConversations.lastInboundAt,
      optedOutAt: whatsappConversations.optedOutAt,
      profileName: whatsappConversations.profileName,
      employeeName: employees.fullName,
      employeePhotoUrl: employees.photoUrl,
      leadName: leadNameSql,
      status: whatsappConversations.status,
      assignedUserId: whatsappConversations.assignedUserId,
      awaitingSince: whatsappConversations.awaitingSince,
      unreadCount: whatsappConversations.unreadCount,
      linkedBookingRef: whatsappConversations.linkedBookingRef,
      linkedBookingLabel: whatsappConversations.linkedBookingLabel,
      linkedClientEmail: whatsappConversations.linkedClientEmail,
      aiIntent: whatsappConversations.aiIntent,
      aiUrgency: whatsappConversations.aiUrgency,
    })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!convRows.length) return null;
  const conv = convRows[0];

  const rows = await db
    .select({
      id: whatsappMessages.id,
      direction: whatsappMessages.direction,
      type: whatsappMessages.type,
      body: whatsappMessages.body,
      templateName: whatsappMessages.templateName,
      mediaType: whatsappMessages.mediaType,
      mediaKey: whatsappMessages.mediaKey,
      mediaUrl: whatsappMessages.mediaUrl,
      mediaMime: whatsappMessages.mediaMime,
      mediaAttempts: whatsappMessages.mediaAttempts,
      status: whatsappMessages.status,
      errorDetail: whatsappMessages.errorDetail,
      waTimestamp: whatsappMessages.waTimestamp,
      createdAt: whatsappMessages.createdAt,
    })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.conversationId, conversationId))
    .orderBy(desc(whatsappMessages.id))
    .limit(limit);

  const w = deriveWindowState(conv.lastInboundAt);
  const crmName = !conv.employeeName?.trim() && !conv.leadName?.trim() ? (await crmNamesByPhone(db, [conv.phoneE164])).get(conv.phoneE164) ?? null : null;
  const name = conversationDisplayName({ ...conv, crmName });
  const realName = conv.employeeName || conv.leadName || crmName || conv.profileName;
  return {
    conversationId: conv.id,
    phoneE164: conv.phoneE164,
    employeeId: conv.employeeId,
    name,
    photoUrl: conv.employeePhotoUrl?.trim() || null,
    recipientFirstName: realName ? firstNameOf(realName) : null,
    optedOut: conv.optedOutAt != null,
    optedOutAt: conv.optedOutAt,
    windowState: w.windowState,
    windowExpiresAt: w.windowExpiresAt,
    status: conv.status,
    assignedUserId: conv.assignedUserId,
    awaitingSince: conv.awaitingSince,
    unreadCount: conv.unreadCount,
    linkedBookingRef: conv.linkedBookingRef,
    linkedBookingLabel: conv.linkedBookingLabel,
    linkedClientEmail: conv.linkedClientEmail,
    aiIntent: conv.aiIntent ?? null,
    aiUrgency: conv.aiUrgency ?? null,
    // Nunca devolve o URL do storage: só se há ficheiro (o link assinado é pedido à parte).
    messages: rows
      .map(({ mediaKey, mediaUrl, mediaAttempts, ...m }) => {
        const mediaAvailable = !!(mediaKey || mediaUrl);
        return { ...m, mediaAvailable, mediaState: inboundMediaState({ mediaType: m.mediaType, mediaAvailable, mediaAttempts, createdAt: m.createdAt }) } as ThreadMessage;
      })
      .reverse(), // cronológico (antigo → recente)
  };
}

/**
 * URL ASSINADO (curta duração) do ficheiro de uma mensagem recebida. A guarda
 * de cidade é feita pela conversa da mensagem. null = mensagem sem ficheiro
 * ou fora do âmbito (quem chama responde "não encontrado").
 */
export async function getInboundMediaUrl(messageId: number): Promise<{ url: string; mime: string | null } | null> {
  const db = await getDb();
  if (!db) return null;
  const [m] = await db
    .select({
      conversationId: whatsappMessages.conversationId,
      mediaKey: whatsappMessages.mediaKey,
      mediaUrl: whatsappMessages.mediaUrl,
      mediaMime: whatsappMessages.mediaMime,
    })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.id, messageId))
    .limit(1);
  if (!m || !(m.mediaKey || m.mediaUrl)) return null;
  if (!(await conversationVisible(m.conversationId))) return null;
  const { storagePresignGet } = await import("./storage");
  const signed = await storagePresignGet(m.mediaKey || m.mediaUrl!, { fallbackUrl: m.mediaUrl, expiresSeconds: 600 });
  return signed.url ? { url: signed.url, mime: m.mediaMime } : null;
}

// ─── Marcar como lido ───────────────────────────────────────────────────────

export async function markConversationRead(conversationId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(whatsappConversations)
    .set({ unreadCount: 0 })
    .where(eq(whatsappConversations.id, conversationId));
}

/**
 * Marcar como NÃO lida (pedido do Jorge 2026-09-17): volta a pôr a conversa no
 * filtro "Não lidas" para ser retomada mais tarde. `unreadCount` é o mesmo
 * contador que o webhook incrementa; aqui garante-se pelo menos 1 sem nunca
 * BAIXAR um contador real (se entretanto chegaram 3 mensagens, ficam 3).
 * Devolve `false` quando a conversa não existe.
 */
export async function markConversationUnread(conversationId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [result] = await db
    .update(whatsappConversations)
    .set({ unreadCount: sql`GREATEST(${whatsappConversations.unreadCount}, 1)` })
    .where(eq(whatsappConversations.id, conversationId));
  return Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0;
}

// ─── Resposta 1-a-1 (texto livre, só janela aberta) ─────────────────────────

export interface ReplyResult {
  ok: boolean;
  waMessageId?: string;
  error?: string;
  /** O contacto pediu STOP — a UI pede confirmação e reenvia com `allowOptedOut`. */
  optedOut?: boolean;
  /** Sem confirmação da Meta: a mensagem pode ter saído. Reenviar pede confirmação (17a). */
  uncertain?: boolean;
  /** Pedido repetido com o mesmo código: não voltou a enviar. */
  duplicate?: boolean;
}

/**
 * Texto livre para uma conversa (só com a janela de 24h aberta). Usado pela
 * resposta manual do inbox E pelas respostas automáticas.
 *
 * Opt-out: um contacto que pediu STOP não recebe nada automático. A resposta
 * manual só passa com `allowOptedOut` (a UI pede confirmação antes); a
 * confirmação do próprio STOP também usa esta via.
 */
export async function replyToConversation(
  conversationId: number,
  text: string,
  userId: number | null,
  /** `clientRequestId`: código único do envio (do ecrã) — repetir o pedido não reenvia. */
  opts: { allowOptedOut?: boolean; clientRequestId?: string | null } = {},
): Promise<ReplyResult> {
  const body = text.trim();
  if (!body) return { ok: false, error: "Mensagem vazia." };

  const db = await getDb();
  if (!db) return { ok: false, error: "Base de dados indisponível." };

  const rows = await db
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      lastInboundAt: whatsappConversations.lastInboundAt,
      optedOutAt: whatsappConversations.optedOutAt,
    })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!rows.length) return { ok: false, error: "Conversa não encontrada." };
  const conv = rows[0];

  if (conv.optedOutAt && !opts.allowOptedOut) {
    return { ok: false, optedOut: true, error: OPTED_OUT_ERROR };
  }

  // Validação da janela NO SERVIDOR — a UI não é a fonte de verdade.
  const { windowState } = deriveWindowState(conv.lastInboundAt);
  if (windowState !== "open") {
    return {
      ok: false,
      error:
        windowState === "awaiting_first_reply"
          ? "Ainda sem resposta do contacto — só é possível escrever depois da primeira resposta. Inicia com um template."
          : "Janela de 24h fechada — inicia a conversa com um template.",
    };
  }

  // A linha fica gravada ANTES de chamar a Meta (17a): um pedido repetido com o
  // mesmo código encontra-a e não volta a mandar a mensagem ao cliente.
  const row = { conversationId, type: "text" as const, body };
  const reserved = await reserveOutboundMessage(db, { ...row, sentById: userId, clientRequestId: opts.clientRequestId ?? null });
  if (!reserved.reserved) {
    const dup = duplicateRequestOutcome(reserved.existing);
    if (dup.kind === "sent") return { ok: true, duplicate: true, waMessageId: dup.waMessageId ?? undefined };
    return { ok: false, uncertain: true, duplicate: true, error: dup.kind === "in_doubt" ? dup.error : "Envio repetido." };
  }
  const res = await sendTextMessage(conv.phoneE164, body);
  await finishOutboundMessage(db, reserved.id, row, res);

  if (res.ok) return { ok: true, waMessageId: res.waMessageId };
  return { ok: false, error: res.error, ...(res.uncertain ? { uncertain: true } : {}) };
}
