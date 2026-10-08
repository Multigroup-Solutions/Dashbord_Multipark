/**
 * Corpo de cada cron (/api/cron/*), partilhado pelos endpoints manuais e pelo
 * agendador único /api/cron/tick (server/cronScheduler.ts). Cada função
 * recebe o prazo (`deadlineAt`) de quem chama e devolve `{ httpStatus, body }`
 * — o mesmo JSON que o endpoint sempre devolveu (ok/done/nextOffset/…), por
 * isso o registo de corridas (cronOutcome) e os workflows manuais continuam a
 * ler os mesmos campos. `done`/`cursor` (opcionais) dizem ao agendador se
 * acabou e de onde retomar.
 *
 * Tudo por import dinâmico: o bundle da função só carrega o que cada trabalho usa.
 */
import type { Response } from "express";

export interface CronJobRun {
  httpStatus: number;
  body: Record<string, any>;
  /** Acabou? (omissão: `body.done !== false`). */
  done?: boolean;
  /** Onde retomar na próxima corrida (texto; o agendador guarda-o). */
  cursor?: string | null;
}

/** Envia o resultado (status só quando não é 200 — como os handlers antigos). */
export function sendCronRun(res: Response, r: CronJobRun): void {
  if (r.httpStatus !== 200) res.status(r.httpStatus);
  res.json(r.body);
}

const ranAt = () => new Date().toISOString();
const msg = (err: any, n = 300) => String(err?.message ?? err).slice(0, n);
/** Código do erro para a resposta/log — nunca a mensagem (pode trazer PII). */
async function errCode(err: unknown): Promise<string> {
  const { deliveryErrorCode } = await import("./bookingDeliveryQueue");
  return deliveryErrorCode(err);
}
const fail = (err: any, extra: Record<string, unknown> = {}): CronJobRun => ({ httpStatus: 500, body: { ok: false, ...extra, error: msg(err) } });

// ─── Multipark ──────────────────────────────────────────────────────────────

/**
 * Fila de notificações (cópia `multipark_bookings` gravada a cada webhook).
 * A releitura periódica pela API está desligada: a app lê a Multipark ao vivo. Falhas de itens (reserva ainda incompleta) são repetidas pela fila
 * com backoff → vão em `warnings` e o cron fica verde. 503 só quando uma fase
 * inteira falha. As 2 fases dividem o prazo. O histórico já não é copiado
 * (multipark_booking_history fica só com o que já lá estava): lê-se da BD da
 * Multipark ao vivo (server/multiparkDb).
 */
export async function multiparkDeliveriesCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  const startedAt = Date.now();
  const total = Math.max(5_000, o.deadlineAt - startedAt);
  const phaseErrors: string[] = [];
  const { retryMultiparkDeliveries } = await import("./multiparkWebhook");
  let queue: Awaited<ReturnType<typeof retryMultiparkDeliveries>> | null = null;
  const details: { errors: number; noKey: number } | null = null;
  let alert: unknown = null;
  try {
    queue = await retryMultiparkDeliveries(startedAt + Math.round(total * 0.6));
  } catch (err) {
    console.error("[cron multipark-deliveries] fila:", await errCode(err));
    phaseErrors.push(`fila indisponível (${await errCode(err)})`);
  }
  // Releitura periódica das reservas pela API: DESLIGADA (reservas ao vivo,
  // parte B, 29 set 2026). Tudo o que a app mostra lê a BD da Multipark ao
  // vivo; a cópia `multipark_bookings` continua a ser gravada quando chega um
  // webhook (processMultiparkWebhookEvent) e nunca se apaga.
  // Tarefas dos serviços que falharam no webhook (service_task_retries).
  let serviceRetries: unknown = null;
  if (o.deadlineAt - Date.now() > 8_000) {
    try {
      const { retryServiceTasks } = await import("./serviceTasks");
      serviceRetries = await retryServiceTasks({ deadlineAt: o.deadlineAt - 2_000, limit: 50 });
    } catch (err) {
      console.warn("[cron multipark-deliveries] tarefas dos serviços por repetir:", await errCode(err));
      serviceRetries = { error: await errCode(err) };
    }
  }
  // Memória do webhook: repetir a leitura da BD da Multipark que falhou no
  // momento do webhook (linha nova "#db"; a original não é tocada).
  let memoryRetry: unknown = null;
  try {
    const { retryWebhookMemoryReads } = await import("./webhookMemory");
    // 120 por corrida: a fila passou a ser de hora a hora (antes 30 de 15 em 15 min)
    memoryRetry = await retryWebhookMemoryReads({ deadlineAt: o.deadlineAt, limit: 120 });
  } catch (err) {
    console.warn("[cron multipark-deliveries] memória do webhook:", await errCode(err));
  }
  // Parcerias por cidade: resumo parceria × centro (ao vivo), de 6 em 6 horas.
  let partnerPresence: unknown = null;
  try {
    const { maybeRefreshPartnerCityPresence } = await import("./partnerPresence");
    partnerPresence = await maybeRefreshPartnerCityPresence();
  } catch (err) {
    console.warn("[cron multipark-deliveries] parcerias por cidade:", await errCode(err));
    partnerPresence = { refreshed: false, error: await errCode(err) };
  }
  // Alerta "sem webhooks em horário de operação" (1 aviso por transição).
  try {
    const { checkWebhookStaleAlert } = await import("./syncHealth");
    alert = await checkWebhookStaleAlert();
  } catch (err) {
    console.warn("[cron multipark-deliveries] alerta webhooks:", await errCode(err));
  }
  const { deliveriesVerdict } = await import("./syncRules");
  const verdict = deliveriesVerdict({ phaseErrors, queue, details });
  return { httpStatus: verdict.ok ? 200 : 503, body: { ...verdict, ranAt: ranAt(), ...(queue ?? {}), queue, details, memoryRetry, serviceRetries, partnerPresence, alert }, done: true };
}

/** Ligações automáticas funcionário ↔ utilizador ↔ agente Multipark (conservador e idempotente). */
export async function identitySweepCron(): Promise<CronJobRun> {
  try {
    const { runIdentitySweep } = await import("./identityLink");
    const report = await runIdentitySweep();
    // Fichas sem cidade: agente da Multipark → candidatura/morada → tarefa para o RH.
    let cities: unknown = null;
    try {
      const { fixMissingEmployeeCities } = await import("./employeeCityFix");
      cities = await fixMissingEmployeeCities();
    } catch (err) { cities = { error: msg(err, 200) }; }
    return { httpStatus: 200, body: { ok: report.errors.length === 0, ranAt: ranAt(), ...report, cities }, done: true };
  } catch (err) { return fail(err); }
}

// ─── CRM (fichas de cliente) ─────────────────────────────────────────────────

/**
 * Fichas de cliente a partir das reservas, por lotes (cursor próprio em
 * multipark_db_cursors, stream "crm-bookings"). A 1.ª carga leva várias
 * passagens; `done:false` pede ao agendador para continuar logo.
 */
export async function crmSyncCron(o: { deadlineAt: number; restart?: boolean }): Promise<CronJobRun> {
  try {
    const { runCrmSync } = await import("./crm/sync");
    const r = await runCrmSync({ deadlineAt: o.deadlineAt, restart: o.restart });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: r.done, cursor: r.done ? null : "continuar" };
  } catch (err) {
    // o Drizzle só diz "Failed query: INSERT…"; o motivo real do MySQL vem no `cause`
    const { dbErrorReason } = await import("./crm/proSync");
    console.error("[cron crm-sync] falhou:", dbErrorReason(err));
    return fail(err);
  }
}

/** Conta corrente dos clientes Pro, lida da BD da Multipark (server/crm/proSync.ts). */
export async function crmProSyncCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runProSync } = await import("./crm/proSync");
    const r = await runProSync({ deadlineAt: o.deadlineAt });
    if (r.diagnostics) console.log("[cron crm-pro-sync]", JSON.stringify({ ...r.diagnostics, accounts: r.accounts, ledgerRows: r.ledgerRows, goneRows: r.goneRows, linked: r.linked }).slice(0, 900));
    // sem BD da Multipark (r.ok = false): não é erro nosso — fica registado e tenta na próxima vez
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: true };
  } catch (err) {
    // o Drizzle só diz "Failed query: INSERT…"; o motivo real do MySQL vem no `cause`
    const { dbErrorReason } = await import("./crm/proSync");
    const reason = dbErrorReason(err);
    console.error("[cron crm-pro-sync] falhou:", reason);
    return { httpStatus: 500, body: { ok: false, error: reason } };
  }
}

/** Sugestões para juntar fichas (telefone, matrícula, NIF, email partilhados). */
export async function crmSuggestionsCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return { httpStatus: 503, body: { ok: false, error: "BD indisponível" } };
    // "próxima reserva" que já passou (não veio / sem mudança na reserva): recalcular
    const { recomputeStaleUpcoming } = await import("./crm/sync");
    const stale = await recomputeStaleUpcoming(db, { deadlineAt: o.deadlineAt - 30_000 });
    const { refreshSuggestions } = await import("./crm/merge");
    const r = await refreshSuggestions(db, { deadlineAt: o.deadlineAt });
    return { httpStatus: 200, body: { ok: true, ranAt: ranAt(), staleRecomputed: stale, ...r }, done: true };
  } catch (err) {
    console.error("[cron crm-suggestions] falhou:", msg(err, 200));
    return fail(err);
  }
}

/**
 * CRM: juntar sozinho as fichas óbvias (mesmo nome + mesmo telefone/email/NIF)
 * e voltar a gerar as sugestões (as fusões criam pares novos com a que fica).
 * Interruptor CRM_AUTO_MERGE (ligado por omissão; cada fusão separa-se em Rever fichas).
 */
export async function crmAutoMergeCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    if (!isFeatureEnabled("CRM_AUTO_MERGE", { defaultEnabled: automationFlagDefault("CRM_AUTO_MERGE") })) return { httpStatus: 200, body: { ranAt: ranAt(), skipped: "CRM_AUTO_MERGE desligado" }, done: true };
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return { httpStatus: 503, body: { ok: false, error: "BD indisponível" } };
    const { autoMergeConfident, refreshSuggestions } = await import("./crm/merge");
    // 20c: fusão automática = autor 0 (o motivo "automático: …" fica na fusão), não o 1.º super admin.
    const r = await autoMergeConfident(db, { deadlineAt: o.deadlineAt - 15_000, userId: 0 });
    const s = r.merged && Date.now() < o.deadlineAt - 12_000 ? await refreshSuggestions(db, { deadlineAt: o.deadlineAt - 2_000 }) : null;
    // parou no prazo → "não acabei": o agendador repete no tick seguinte (1×/dia não chega para um atraso)
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r, suggestions: s }, done: !r.stoppedAtDeadline };
  } catch (err) {
    console.error("[cron crm-auto-merge] falhou:", msg(err, 200));
    return fail(err);
  }
}

/**
 * Parcerias ← Multipark (todas as madrugadas): liga, cria, arquiva e liga os
 * agentes dos parceiros. Interruptor PARTNER_MP_SYNC (desligado até o dono
 * aplicar a primeira vez no ecrã).
 */
export async function partnerMpSyncCron(): Promise<CronJobRun> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    if (!isFeatureEnabled("PARTNER_MP_SYNC", { defaultEnabled: automationFlagDefault("PARTNER_MP_SYNC") })) return { httpStatus: 200, body: { ranAt: ranAt(), skipped: "PARTNER_MP_SYNC desligado" }, done: true };
    const { applyPartnerSync } = await import("./partnerMultiparkSync");
    const r = await applyPartnerSync({ userId: 0 });
    if (!r.available) return { httpStatus: 503, body: { ok: false, error: r.reason ?? "Multipark indisponível" } };
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: true };
  } catch (err) {
    console.error("[cron partner-mp-sync] falhou:", msg(err, 200));
    return fail(err);
  }
}

/**
 * Fecho do mês de parceiros: compara o mês corrente e o anterior (só as linhas
 * abertas) e, com PARTNER_CLOSE_ALERTS ligado, avisa das diferenças novas.
 */
export async function partnerCloseCron(): Promise<CronJobRun> {
  try {
    const { refreshPartnerClose, currentMonthLisbon, previousMonth, markAlerted } = await import("./partnerClose");
    const cur = currentMonthLisbon();
    const out: Record<string, unknown> = {};
    const fresh: Array<{ month: string; partnerName: string | null; diffs: number }> = [];
    for (const m of [previousMonth(cur), cur]) {
      const r = await refreshPartnerClose(m);
      out[m] = { available: r.available, partners: r.partners, diffs: r.diffs, reason: r.reason };
      if (!r.available) return { httpStatus: 503, body: { ok: false, error: r.reason ?? "Multipark indisponível", ...out } };
      for (const n of r.newDiffs) fresh.push({ month: m, ...n });
    }
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    if (fresh.length && isFeatureEnabled("PARTNER_CLOSE_ALERTS", { defaultEnabled: automationFlagDefault("PARTNER_CLOSE_ALERTS") })) {
      const { notify } = await import("./notify");
      const lines = fresh.slice(0, 12).map((x) => `${x.month} · ${x.partnerName ?? "parceiro"}: ${x.diffs} diferença(s)`);
      await notify({ kind: "partner_close_alert", title: `Parceiros: ${fresh.length} com diferenças novas no fecho`, body: lines.join("\n"), link: "/parcerias?tab=fecho", entity: { type: "partner_close", id: cur } } as any);
      for (const m of [previousMonth(cur), cur]) await markAlerted(m);
    }
    return { httpStatus: 200, body: { ranAt: ranAt(), ...out, newDiffs: fresh.length }, done: true };
  } catch (err) {
    console.error("[cron partner-close] falhou:", msg(err, 200));
    return fail(err);
  }
}

// ─── Serviços das reservas → tarefas ─────────────────────────────────────────

/**
 * Serviços extra → tarefas, 1×/dia às 18:00 (as tarefas nascem no webhook da
 * reserva): volta de segurança da janela de 48 h (junta os team leaders que
 * entretanto foram escalados). Também à mão em /api/cron/services-tasks — já
 * não manda o aviso de amanhã (é o trabalho `services-tomorrow`).
 * Idempotente; sem BD da Multipark ou sem nenhum tipo ligado → nota (ok).
 */
export async function serviceTasksCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runServiceTasks } = await import("./serviceTasks");
    const r = await runServiceTasks({ deadlineAt: o.deadlineAt - 4_000 });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: r.done };
  } catch (err) {
    console.error("[cron services-tasks] falhou:", msg(err, 200));
    return fail(err);
  }
}

/**
 * Aviso das tarefas de AMANHÃ aos team leaders e supervisores da cidade, 1×/dia
 * a partir das 18:00 (a seguir à volta, no mesmo tick). Lê só a nossa BD: não
 * depende da Multipark. Interruptor SERVICE_TASKS_TOMORROW_ALERT (desligado
 * por omissão). Falha → o agendador repete (30 min, até 3×).
 */
export async function serviceTasksTomorrowCron(): Promise<CronJobRun> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    if (!isFeatureEnabled("SERVICE_TASKS_TOMORROW_ALERT", { defaultEnabled: automationFlagDefault("SERVICE_TASKS_TOMORROW_ALERT") })) {
      return { httpStatus: 200, body: { ranAt: ranAt(), skipped: "SERVICE_TASKS_TOMORROW_ALERT desligado" }, done: true };
    }
    const { sendServiceTasksTomorrowAlert } = await import("./serviceTasks");
    const r = await sendServiceTasksTomorrowAlert();
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: true };
  } catch (err) {
    console.error("[cron services-tomorrow] falhou:", msg(err, 200));
    return fail(err);
  }
}

/**
 * Caixa, fase 2 (detetar): varredura de 3 em 3 h (Jorge, 29 set 2026: a caixa só vem depois; o fecho das 06:15 apanha o resto) — reservas alteradas,
 * ativas e saídas de 48 h dos nossos parques, lidas ao vivo; retratos, regras
 * e casos da "Correção de caixa" (server/cashSweep.ts). Sem BD da Multipark → 503.
 */
export async function cashSweepCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runCashSweep, sweepJobDone } = await import("./cashSweep");
    const r = await runCashSweep({ deadlineAt: o.deadlineAt - 2_000 });
    // a meio → o agendador retoma no tick seguinte (antes esperava 3 h), até 3 seguidas
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: sweepJobDone(r) };
  } catch (err) {
    console.error("[cron cash-sweep] falhou:", msg(err, 200));
    return fail(err);
  }
}

/** Operacional: quem trabalha sem PDA ou Zello ligado (alertas + sino + WhatsApp). */
export async function opsPresenceCron(): Promise<CronJobRun> {
  try {
    const { runOpsPresence } = await import("./opsPresence");
    const r = await runOpsPresence();
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: true };
  } catch (err) {
    console.error("[cron ops-presence] falhou:", msg(err, 200));
    return fail(err);
  }
}

/** Caixa: fecho do dia — todas as saídas de ontem e anteontem, com as mesmas regras. */
export async function cashCloseCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runCashClose } = await import("./cashSweep");
    const r = await runCashClose({ deadlineAt: o.deadlineAt - 2_000 });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: !r.partial };
  } catch (err) {
    console.error("[cron cash-close] falhou:", msg(err, 200));
    return fail(err);
  }
}

/** Caixa, fase 4: saídas de ontem e anteontem contra a InvoiceExpress e a Stripe. */
export async function cashExternalCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runCashExternal } = await import("./cashExternal");
    const r = await runCashExternal({ deadlineAt: o.deadlineAt - 2_000 });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: !r.partial };
  } catch (err) {
    console.error("[cron cash-external] falhou:", msg(err, 200));
    return fail(err);
  }
}

// ─── Manutenção diária + recolha GPS (daily-ops) ─────────────────────────────

/** Folga mínima para arrancar um passo novo do daily-ops. */
const DAILY_STEP_MIN_MS = 8_000;

/** Cursor do daily-ops: passos feitos (s), dias recolhidos (d) e erros dos passos até agora (e). */
interface DailyOpsCursor { s: string[]; d: string[]; e: string[] }

export function parseDailyOpsCursor(raw: string | null | undefined): DailyOpsCursor {
  try {
    const v = raw ? JSON.parse(raw) : null;
    const list = (x: unknown, n: number) => (Array.isArray(x) ? x.map(String).slice(0, n) : []);
    return { s: list(v?.s, 50), d: list(v?.d, 20), e: list(v?.e, 5) };
  } catch { return { s: [], d: [], e: [] }; }
}

/** Meio-dia UTC de um dia "AAAA-MM-DD" (o dia de Lisboa é sempre esse). */
const noonUtc = (day: string) => new Date(`${day}T12:00:00Z`);

/**
 * Manutenção diária (despesas, tarefas, ponto, possíveis
 * faltas, retenções) e
 * recolha GPS FINAL do Zello, TUDO dentro de
 * `deadlineAt`: cada passo só arranca com tempo (≥ 8 s) e os que ficarem de
 * fora seguem na chamada seguinte (`done:false`; o agendador guarda no cursor
 * os passos e os dias já feitos). Antes a soma passava dos 60 s → 504.
 *
 * Recolha GPS: o Zello só liberta um dia depois da meia-noite do dia a seguir
 * ao seguinte → por omissão D-2 (Lisboa), mais os dias dos últimos 7 que
 * ficaram incompletos (o mais antigo primeiro). `date` força um dia.
 * `collectOnly` (endpoint manual, repetições) salta a manutenção.
 * `deferStepErrors` (agendador): os erros dos passos de manutenção vão no
 * cursor e só pintam a corrida de vermelho no fim (done:true) — senão um
 * passo falhado atrasava a retoma da recolha GPS.
 */
export async function dailyOpsCron(o: { deadlineAt: number; collectOnly?: boolean; date?: string | null; cursor?: string | null; deferStepErrors?: boolean }): Promise<CronJobRun> {
  try {
    const cur = parseDailyOpsCursor(o.cursor);
    const stepsDone = new Set(cur.s);
    const daysDone = new Set(cur.d);
    const stepErrors: string[] = o.deferStepErrors ? [...cur.e] : [];
    const pending: string[] = [];
    const hasTime = () => o.deadlineAt - Date.now() >= DAILY_STEP_MIN_MS;
    const step = async (key: string, label: string, fn: () => Promise<void>) => {
      if (stepsDone.has(key)) return;
      if (!hasTime()) { pending.push(key); return; }
      try { await fn(); } catch (err: any) {
        console.warn(`[daily-ops] ${label}:`, msg(err, 200));
        stepErrors.push(`${label}: ${msg(err, 200)}`);
      }
      // Feito (ou falhado → fica em stepErrors): não se repete neste dia.
      stepsDone.add(key);
    };
    /** Prazo de uma limpeza: no máximo `ms`, sempre antes do fim do orçamento. */
    const cap = (ms: number) => Math.min(Date.now() + ms, o.deadlineAt - 3_000);

    if (!o.collectOnly) {
      // Despesas: marca vencidas como "overdue" e lança as recorrentes do mês
      // (Lisboa) em nome do utilizador de sistema. Idempotente.
      await step("overdue", "markOverdueExpenses", async () => {
        const { markOverdueExpenses } = await import("./db");
        await markOverdueExpenses();
      });
      await step("recurring", "recorrentes", async () => {
        // 29b: cada modelo lança no SEU dia (não o mês inteiro no dia 1); o mês
        // anterior apanha o que tenha ficado por lançar (cron parado), só com os
        // modelos que já existiam nesse mês. Idempotente (UNIQUE modelo/mês).
        const { generateRecurringExpensesForMonth } = await import("./expenseRecurring");
        const { lisbonToday } = await import("../shared/expensePeriods");
        const [y, m, d] = lisbonToday().split("-").map(Number);
        const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
        const prev = await generateRecurringExpensesForMonth(py, pm, null, { createdBefore: `${y}-${String(m).padStart(2, "0")}-01 00:00:00` });
        const r = await generateRecurringExpensesForMonth(y, m, null, { upToDay: d });
        if (prev.created > 0) console.log(`[daily-ops] recorrentes ${prev.period} (atrasadas): ${prev.created} lançada(s)`);
        if (r.created > 0) console.log(`[daily-ops] recorrentes ${r.period}: ${r.created} lançada(s), ${r.skipped} já existiam`);
      });
      // (22c, D10 — Jorge 3 out) A avaliação semanal ANTIGA (performance_evaluations)
      // já não se gera: a avaliação é a das 4 semanas (evaluation-recompute). As
      // semanas já gravadas ficam como histórico.
      // Tarefas (rede de segurança do extras-auto horário): checklists do dia
      // + avisos de atraso/conclusão. Idempotente.
      await step("tasks", "tarefas", async () => {
        const { runTaskAutomation } = await import("./tasksService");
        await runTaskAutomation(new Date());
      });
      // Fecha check-ins esquecidos (>16h abertos → check-out a +12h, [SUSPEITO])
      await step("stale-checkins", "autoCloseStaleCheckIns", async () => {
        const { autoCloseStaleCheckIns } = await import("./db");
        const r = await autoCloseStaleCheckIns();
        if (r.closed > 0) console.log(`[daily-ops] auto-checkout de ${r.closed} ponto(s) esquecido(s)`);
      });
      // Terminal no ponto (interruptor PONTO_TERMINAL; desligado → nada): os
      // troços "por confirmar" dos últimos 7 dias voltam a ler a Multipark (só
      // leitura) — terminal até à última recolha/entrega feita pelo extra no
      // troço ("partial"). Sem ações → ficam para o RH. Nada se apaga.
      await step("terminal-pending", "terminal por confirmar", async () => {
        const { retryPendingTerminalShifts } = await import("./pontoTerminal");
        const r = await retryPendingTerminalShifts({ deadlineAt: cap(15_000) });
        if (!r.skipped && r.pending > 0) {
          console.log(`[daily-ops] terminal por confirmar: ${r.resolved} de ${r.pending} até à última recolha/entrega (${r.noActions} sem ações, ${r.noAgent} sem agente ligado${r.deferred ? `, ${r.deferred} para amanhã` : ""}${r.readFailed ? " — Multipark não lida" : ""})`);
        }
      });
      // RH: "possíveis faltas" de ontem (pendentes de validação; não
      // bloqueiam). A regra documental passou para o trabalho semanal
      // rh-docs-weekly (segunda-feira, rhDocsWeeklyCron).
      await step("rh-no-shows", "RH possíveis faltas", async () => {
        const { detectExtraDiaNoShows } = await import("./rhService");
        const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - 86400000));
        const n = await detectExtraDiaNoShows(yesterday);
        console.log(`[daily-ops] RH: possíveis faltas ${yesterday}: ${n.created} novas (${n.alreadyPending} já registadas; fora: ${n.skipped.proposed} só propostos, ${n.skipped.sent_home} mandados para casa, ${n.skipped.multipark} com movimentos na Multipark${n.multiparkRead ? "" : " — Multipark não lida"})`);
      });
      // Retenções, em lotes e com prazo curto — o resto fica para o dia seguinte.
      // Fila de notificações Multipark: apaga concluídos com mais de 30 dias.
      await step("purge-deliveries", "limpeza fila Multipark", async () => {
        const { purgeCompletedDeliveries } = await import("./bookingDeliveryQueue");
        const r = await purgeCompletedDeliveries({ days: 30, deadlineAt: cap(8_000) });
        if (r.deleted > 0) console.log(`[daily-ops] fila Multipark: ${r.deleted} concluído(s) antigos apagados${r.done ? "" : ", continua amanhã"}`);
      });
      // Registo de atividade: apaga > 12 meses, em lotes de 5000 (DELETE … LIMIT).
      await step("purge-activity", "retenção logs", async () => {
        const { purgeOldActivityLogs } = await import("./db");
        const r = await purgeOldActivityLogs({ deadlineAt: cap(7_000) });
        if (r.deleted > 0) console.log(`[daily-ops] activity_logs: ${r.deleted} registo(s) antigos apagados (${r.batches} lote(s)${r.done ? "" : ", continua amanhã"})`);
      });
      // Assistente (chat): conversas e mensagens com mais de 30 dias.
      await step("purge-chats", "retenção assistente", async () => {
        const { purgeOldChats } = await import("./_core/ai/chat/store");
        const r = await purgeOldChats({ deadlineAt: cap(4_000) });
        if (r.deleted > 0) console.log(`[daily-ops] assistente: ${r.deleted} mensagem(ns)/conversa(s) antigas apagadas${r.done ? "" : ", continua amanhã"}`);
      });
      // Comunicação: emails mais antigos do que `mail.retentionYears` e SEM
      // ligação a cliente/reserva/caso vão para o ARQUIVO (ficam guardados; só
      // o super admin os vê, a pedido). Nada se apaga (Jorge, 2 out 2026).
      await step("mail-retention", "retenção emails", async () => {
        const { runMailRetention } = await import("./mail/store");
        const r = await runMailRetention({ deadlineAt: cap(5_000) });
        if (r.messages > 0) console.log(`[daily-ops] emails: ${r.messages} mensagem(ns) e ${r.threads} conversa(s) antes de ${r.cutoff} arquivadas${r.partial ? ", continua amanhã" : ""}`);
      });
    }

    const maintenanceDone = pending.length === 0;
    const cursorOut = () => JSON.stringify({ s: Array.from(stepsDone), d: Array.from(daysDone), e: stepErrors.map((e) => e.slice(0, 120)).slice(0, 5) });
    /** Erros dos passos na resposta: já (manual) ou só no fim (agendador; a meio vão como aviso). */
    const errorsFor = (finished: boolean) => (!o.deferStepErrors || finished ? { stepErrors } : { stepErrors: [] as string[], warnings: stepErrors.map((e) => `passo falhado (conta no fim): ${e}`) });

    // Zello não configurado: a recolha GPS não pode correr → vermelho com o
    // motivo (a manutenção acima já correu).
    const { isZelloConfigured } = await import("./zello");
    if (!isZelloConfigured()) {
      return {
        httpStatus: 200,
        body: {
          ok: false, ranAt: ranAt(), done: maintenanceDone, stepErrors, pendingSteps: pending, skipped: "zello_not_configured",
          error: "Zello não configurado (ZELLO_API_KEY/ZELLO_USERNAME/ZELLO_PASSWORD): recolha GPS diária não correu.",
          warnings: ["Recolha GPS saltada: Zello não configurado."],
        },
        done: maintenanceDone, cursor: cursorOut(),
      };
    }

    // Dias a recolher: o pedido (`date`) ou os incompletos dos últimos 7 até D-2.
    const { collectDailyDriverData, incompleteCollectionDays } = await import("./jobs/dailyDriverCollection");
    const { zelloLatestDay } = await import("../shared/lisbonDay");
    const latest = zelloLatestDay(Date.now());
    let targets: string[];
    if (o.date) targets = [o.date];
    else {
      try { targets = await incompleteCollectionDays(latest); }
      catch (err) { console.warn("[daily-ops] dias em falta:", msg(err, 160)); targets = [latest]; }
    }
    targets = targets.filter((d) => !daysDone.has(d));
    const collected: Array<{ date: string; driversProcessed: number; done: boolean; success: boolean }> = [];
    const errors: string[] = [];
    let success = true;
    let collectionDone = true;
    for (const day of targets) {
      if (!hasTime()) { collectionDone = false; break; }
      // Prazo < maxDuration (60 s): a recolha é retomável (só os condutores sem registo).
      const r = await collectDailyDriverData(noonUtc(day), { deadlineAt: o.deadlineAt - 3_000, pass: "final" });
      collected.push({ date: day, driversProcessed: r.driversProcessed, done: r.done, success: r.success });
      errors.push(...r.errors.map((e) => `${day}: ${e}`));
      if (!r.success) { success = false; collectionDone = false; break; }
      if (!r.done) { collectionDone = false; break; }
      daysDone.add(day);
    }
    const done = maintenanceDone && collectionDone;
    // Recolha Zello falhada (login, API em baixo…) → ok:false com o motivo.
    return {
      httpStatus: 200,
      body: {
        ok: success, ranAt: ranAt(), date: collected[collected.length - 1]?.date ?? latest, dates: collected, ...errorsFor(done), pendingSteps: pending,
        success, driversProcessed: collected.reduce((s, c) => s + c.driversProcessed, 0), errors,
        ...(success ? {} : { error: `Recolha Zello falhou: ${String(errors[errors.length - 1] ?? "sem detalhe").slice(0, 300)}` }),
        done,
      },
      done, cursor: cursorOut(),
    };
  } catch (err) { return fail(err); }
}

/**
 * GPS do Zello — passagem PROVISÓRIA do dia de hoje (23:15–23:55 de Lisboa):
 * à meia-noite o Zello deixa de dar o dia e só o volta a dar ~2 dias depois;
 * assim o Histórico Diário/Atividade do Dia têm dados no próprio dia. A
 * passagem final (D-2, daily-ops) substitui estas linhas. Retomável dentro
 * da janela; nunca passa da meia-noite (prazo cortado 1 min antes).
 */
export async function zelloSameDayCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { isZelloConfigured } = await import("./zello");
    // Sem Zello: o daily-ops já fica vermelho com o motivo — aqui só nota.
    if (!isZelloConfigured()) return { httpStatus: 200, body: { ok: true, skipped: "zello_not_configured", ranAt: ranAt(), done: true }, done: true };
    const { lisbonDayOf, lisbonMidnightUtcMs, addDays } = await import("../shared/lisbonDay");
    const { ZELLO_SAMEDAY_WINDOW, hhmm, lisbonToUtc } = await import("./cronSchedule");
    const today = lisbonDayOf(Date.now());
    const deadlineAt = Math.min(o.deadlineAt, lisbonMidnightUtcMs(addDays(today, 1)) - 60_000);
    if (deadlineAt - Date.now() < 5_000) return { httpStatus: 200, body: { ok: true, skipped: "meia-noite", ranAt: ranAt(), done: true }, done: true };
    const { collectDailyDriverData } = await import("./jobs/dailyDriverCollection");
    // Quem já foi recolhido nesta janela (desde o início dela) não se repete.
    const passStartedAt = Math.min(lisbonToUtc(today, hhmm(ZELLO_SAMEDAY_WINDOW.from)), Date.now() - 15 * 60_000);
    const r = await collectDailyDriverData(noonUtc(today), { deadlineAt: deadlineAt - 3_000, pass: "sameday", passStartedAt });
    return {
      httpStatus: 200,
      body: { ok: r.success, ranAt: ranAt(), date: today, pass: "sameday", ...r, ...(r.success ? {} : { error: `Recolha Zello (provisória) falhou: ${String(r.errors[r.errors.length - 1] ?? "sem detalhe").slice(0, 300)}` }) },
      done: r.done,
    };
  } catch (err) { return fail(err); }
}

/**
 * RH — regra documental dos extras (avisos de documentos em falta; escrita SÓ
 * aqui e na ação admin por ficha — nunca no auth.me). Semanal: segunda a
 * partir das 04:45 de Lisboa (trabalho rh-docs-weekly).
 */
export async function rhDocsWeeklyCron(): Promise<CronJobRun> {
  try {
    const { applyDocsComplianceAll } = await import("./rhService");
    const d = await applyDocsComplianceAll();
    return { httpStatus: 200, body: { ok: true, ranAt: ranAt(), ...d }, done: true };
  } catch (err) { return fail(err); }
}

/**
 * RH — pedir os documentos em falta aos extras ativos (WhatsApp + email), à
 * segunda a partir das 10:00 de Lisboa (trabalho rh-docs-request). Interruptor
 * EXTRAS_DOCS_REQUEST (desligado por omissão). Retomável: o cursor é a última
 * ficha tratada; cada pessoa tem 1 pedido por semana ISO (chave única).
 */
export async function rhDocsRequestCron(o: { deadlineAt: number; cursor?: string | null }): Promise<CronJobRun> {
  try {
    const { runDocsRequestAuto } = await import("./rhDocsRequest");
    const after = o.cursor && /^\d{1,10}$/.test(o.cursor) ? Number(o.cursor) : 0;
    const r = await runDocsRequestAuto({ deadlineAt: o.deadlineAt - 3_000, afterId: after });
    return { httpStatus: 200, body: { ok: r.errors.length === 0, ranAt: ranAt(), ...r }, done: r.done, cursor: r.done ? null : String(r.lastId ?? after) };
  } catch (err) { return fail(err); }
}

/** Avaliação (motor único): recalcula o último mês (31 dias) em fatias de 7 dias. */
export async function evaluationRecomputeCron(o: { deadlineAt: number; offsetDays: number }): Promise<CronJobRun> {
  try {
    const { runEvaluationRecompute } = await import("./evaluationEngine");
    const result = await runEvaluationRecompute({ offsetDays: o.offsetDays, deadlineAt: o.deadlineAt - 5_000 });
    return { httpStatus: 200, body: { ok: true, ranAt: ranAt(), ...result }, done: result.done, cursor: result.nextOffset != null ? String(result.nextOffset) : null };
  } catch (err) { return fail(err); }
}

// ─── Extras, briefing, emails, IA ───────────────────────────────────────────

/** Automação dos extras (e companhia), com prazo; `from` retoma num passo. */
export async function extrasAutoCron(o: { deadlineAt: number; from?: string | null }): Promise<CronJobRun> {
  try {
    const { runExtrasAutomation } = await import("./extrasAutomation");
    const report = await runExtrasAutomation(new Date(), { deadlineAt: o.deadlineAt, from: o.from });
    return { httpStatus: 200, body: { ok: report.errors.length === 0, ranAt: ranAt(), ...report }, done: report.done, cursor: report.nextStep };
  } catch (err) { return fail(err); }
}

/**
 * "Pressão" do Extras-Dia: o histórico da BD Multipark (acumula desde abril)
 * agregado por grupo de parques (um grupo de cada vez; `cursor` retoma no grupo seguinte). Sem
 * DATABASE_URL_MULTIPARK → nota (ok, saltado); grupos que falham → vermelho.
 * 47c: da Multipark lê-se só os dias que faltam (um dia × grupo por leitura);
 * `reprocess` (só à mão) volta a ler os dias guardados desse intervalo.
 */
export async function extrasPressureCron(o: { deadlineAt: number; cursor?: string | null; reprocess?: import("./pressureDays").PressureReprocess | null }): Promise<CronJobRun> {
  try {
    const { runExtrasPressure } = await import("./extrasPressure");
    const { getSetting } = await import("./appSettings");
    const excludedParkIds = (await getSetting("operations.excludedParks")) ?? [];
    // 22d: desde quando se mede (acumula) e a tabela máxima por cidade (escalões de pessoas).
    const since = await getSetting("extras.timesSince").catch(() => null);
    const crewRules = await getSetting("extras.crewRules").catch(() => null);
    const r = await runExtrasPressure({ deadlineAt: o.deadlineAt - 3_000, cursor: o.cursor ?? null, excludedParkIds, since, crewRules, reprocess: o.reprocess ?? null });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: r.done, cursor: r.cursor };
  } catch (err) {
    console.error("[cron extras-pressure] falhou:", msg(err, 200));
    return fail(err);
  }
}

/** Briefing diário por cidade, anomalias e (à segunda) relatórios semanais. Idempotente. */
export async function opsBriefingCron(o: { deadlineAt: number; force?: boolean }): Promise<CronJobRun> {
  try {
    const { runOpsBriefingCron } = await import("./aiOps/cron");
    // Os passos (chamadas à IA, emails) só verificam o prazo entre si: folga de 8 s.
    const report = await runOpsBriefingCron({ deadlineAt: o.deadlineAt - 8_000, force: o.force });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...report }, done: report.done };
  } catch (err) { return fail(err); }
}

/** Escala automática dos extras (propor/confirmar/avisar). Idempotente. */
export async function extrasScheduleCron(): Promise<CronJobRun> {
  try {
    const { runScheduleAutomation } = await import("./extrasSchedule");
    const report = await runScheduleAutomation();
    return { httpStatus: 200, body: { ranAt: ranAt(), ...report }, done: true };
  } catch (err) { return fail(err); }
}

/** IA na comunicação com clientes (lotes pequenos; nunca envia nada a clientes). */
export async function aiCommsCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runCommsAiSweep } = await import("./commsAiSweep");
    const report = await runCommsAiSweep({ deadlineAt: o.deadlineAt });
    return { httpStatus: 200, body: { ok: report.errors.length === 0, ranAt: ranAt(), ...report }, done: true };
  } catch (err) { return fail(err); }
}

// ─── Google (Gmail, Tarefas/Calendário/Drive, conhecimento, Web & SEO, Ads) ──

export async function mailSyncCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runMailSync } = await import("./mail/service");
    const r = await runMailSync({ deadlineAt: o.deadlineAt });
    return { httpStatus: 200, body: { ...r, ranAt: ranAt() } };
  } catch (err) { return { httpStatus: 500, body: { ok: false, error: msg(err) } }; }
}

export async function googleSyncCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runGoogleSync } = await import("./google/syncService");
    const r = await runGoogleSync({ deadlineAt: o.deadlineAt });
    return { httpStatus: 200, body: { ...r, ranAt: ranAt() } };
  } catch (err) { return { httpStatus: 500, body: { ok: false, error: msg(err) } }; }
}

/** Fila "sincronizar já" do Google: repete o que falhou ou ficou a meio (lease + espera crescente). */
export async function googlePendingCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { drainPending } = await import("./google/pendingSync");
    const r = await drainPending({ deadlineAt: o.deadlineAt });
    // Falhas de um âmbito (ex.: conta de alguém) não pintam o trabalho de vermelho: esperam e repetem.
    return { httpStatus: 200, body: { ok: true, ...r, ranAt: ranAt() }, done: true };
  } catch (err) { return { httpStatus: 500, body: { ok: false, error: msg(err) } }; }
}

/** Canais de notificação da Google: cria os em falta, renova os que expiram em 48 h, pára os órfãos. */
export async function googleWatchRenewCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { renewWatchChannels } = await import("./google/pushChannels");
    const r = await renewWatchChannels({ deadlineAt: o.deadlineAt });
    return { httpStatus: 200, body: { ...r, ranAt: ranAt() }, done: r.done };
  } catch (err) { return { httpStatus: 500, body: { ok: false, error: msg(err) } }; }
}

export async function knowledgeSyncCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runKnowledgeSync } = await import("./knowledge/sync");
    const r = await runKnowledgeSync({ deadlineAt: o.deadlineAt });
    return { httpStatus: 200, body: { ...r, ranAt: ranAt() } };
  } catch (err) { return { httpStatus: 500, body: { ok: false, error: msg(err) } }; }
}

export async function webAnalyticsCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runWebAnalyticsSync } = await import("./webAnalytics/sync");
    const r = await runWebAnalyticsSync({ deadlineAt: o.deadlineAt });
    return { httpStatus: 200, body: { ...r, units: r.units.filter((u) => u.status !== "ok" || u.windows > 0), ranAt: ranAt() } };
  } catch (err) { return { httpStatus: 500, body: { ok: false, error: msg(err) } }; }
}

/** Hora (min do dia, Lisboa) da atualização diária do Web & SEO nas Definições. */
export async function webAnalyticsRefreshMinutes(): Promise<number | null> {
  try {
    const { loadWebAnalyticsConfig } = await import("./webAnalytics/service");
    return (await loadWebAnalyticsConfig()).refreshHour * 60;
  } catch { return null; }
}

/**
 * O período de uma recolha de anúncios fica fechado? Saltada por trinco
 * ocupado = NÃO (repete); saltada por não haver contas/configuração = sim. PURA.
 */
export function adsCronDone(r: { status?: string; done?: boolean; skipped?: string }): boolean {
  if (r.skipped === "locked") return false;
  if (r.status === "skipped" || r.skipped) return true;
  return r.done !== false;
}

/** Google Ads: daily (última semana) | recent (35 dias, semanal) | monthly (mês anterior); hourly/nightly = daily. */
export async function googleAdsCron(o: { deadlineAt: number; kind: string }): Promise<CronJobRun> {
  const { normalizeSyncKind } = await import("./integrations/googleAds/metrics");
  try {
    const { runGoogleAdsSync } = await import("./integrations/googleAds/sync");
    const r = await runGoogleAdsSync({ kind: normalizeSyncKind(o.kind), deadlineAt: o.deadlineAt, triggeredById: null });
    // 19b: trinco ocupado (outra recolha a correr ou uma que morreu a meio) ≠ feita —
    // repete no tick seguinte; antes o período (ex.: o mês do dia 2) ficava dado por fechado.
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: adsCronDone(r) };
  } catch (err) { return { httpStatus: 500, body: { ok: false, done: true, error: msg(err) } }; }
}

/**
 * Google Ads: cliques (click_view, gclid → campanha) de hora a hora — hoje,
 * ontem e, aos poucos, os dias em falta até 90 dias para trás. Interruptor
 * GOOGLE_ADS_CLICK_SYNC. Fica sempre "feita": o que o prazo cortou segue na
 * hora seguinte (não retoma de 5 em 5 min à frente dos outros trabalhos).
 */
export async function googleAdsClicksCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runGoogleAdsClickSync } = await import("./integrations/googleAds/clicks");
    const r = await runGoogleAdsClickSync({ deadlineAt: o.deadlineAt });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r, done: true }, done: true };
  } catch (err) { return { httpStatus: 500, body: { ok: false, done: true, error: msg(err) } }; }
}

/** Meta Ads: mesma cadência do Google Ads; não configurada → ok:true + skipped. */
export async function metaAdsCron(o: { deadlineAt: number; kind: string }): Promise<CronJobRun> {
  const { normalizeSyncKind } = await import("./integrations/googleAds/metrics");
  try {
    const { runMetaAdsSync } = await import("./integrations/meta/sync");
    const r = await runMetaAdsSync({ kind: normalizeSyncKind(o.kind), deadlineAt: o.deadlineAt, triggeredById: null });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: adsCronDone(r as any) };
  } catch (err) { return { httpStatus: 500, body: { ok: false, done: true, error: msg(err) } }; }
}

/** `?offsetDays=N` → N (só dígitos); resto → 0. */
export function offsetParam(v: unknown): number {
  return typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : 0;
}
