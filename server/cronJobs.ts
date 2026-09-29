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
  // Memória do webhook: repetir a leitura da BD da Multipark que falhou no
  // momento do webhook (linha nova "#db"; a original não é tocada).
  let memoryRetry: unknown = null;
  try {
    const { retryWebhookMemoryReads } = await import("./webhookMemory");
    memoryRetry = await retryWebhookMemoryReads({ deadlineAt: o.deadlineAt, limit: 30 });
  } catch (err) {
    console.warn("[cron multipark-deliveries] memória do webhook:", await errCode(err));
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
  return { httpStatus: verdict.ok ? 200 : 503, body: { ...verdict, ranAt: ranAt(), ...(queue ?? {}), queue, details, memoryRetry, alert }, done: true };
}

/** Ligações automáticas funcionário ↔ utilizador ↔ agente Multipark (conservador e idempotente). */
export async function identitySweepCron(): Promise<CronJobRun> {
  try {
    const { runIdentitySweep } = await import("./identityLink");
    const report = await runIdentitySweep();
    return { httpStatus: 200, body: { ok: report.errors.length === 0, ranAt: ranAt(), ...report }, done: true };
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
    console.error("[cron crm-sync] falhou:", msg(err, 200));
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

// ─── Serviços das reservas → tarefas ─────────────────────────────────────────

/**
 * Serviços extra das reservas (BD Multipark ao vivo) → tarefas, pelas regras
 * de Definições → Parâmetros → "Serviços → tarefas" (server/serviceTasks.ts).
 * Idempotente; sem BD da Multipark ou sem nenhum tipo ligado → nota (ok).
 */
export async function serviceTasksCron(o: { deadlineAt: number }): Promise<CronJobRun> {
  try {
    const { runServiceTasks } = await import("./serviceTasks");
    const r = await runServiceTasks({ deadlineAt: o.deadlineAt - 2_000 });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: r.done };
  } catch (err) {
    console.error("[cron services-tasks] falhou:", msg(err, 200));
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
 * Manutenção diária (despesas, avaliação semanal, tarefas, ponto, possíveis
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
        const { generateRecurringExpensesForMonth } = await import("./expenseRecurring");
        const { lisbonToday } = await import("../shared/expensePeriods");
        const [y, m] = lisbonToday().split("-").map(Number);
        const r = await generateRecurringExpensesForMonth(y, m, null);
        if (r.created > 0) console.log(`[daily-ops] recorrentes ${r.period}: ${r.created} lançada(s), ${r.skipped} já existiam`);
      });
      // Segunda-feira (Lisboa): gera automaticamente a avaliação da semana ANTERIOR
      await step("weekly-evaluation", "avaliação semanal", async () => {
        const lisbonNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
        if (lisbonNow.getDay() !== 1) return;
        const prev = new Date(lisbonNow); prev.setDate(prev.getDate() - 7);
        const d = new Date(Date.UTC(prev.getFullYear(), prev.getMonth(), prev.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
        const { generateWeeklyEvaluation } = await import("./db");
        const r = await generateWeeklyEvaluation(week, d.getUTCFullYear());
        console.log(`[daily-ops] avaliação semanal S${week} gerada (${r.length} condutores)`);
      });
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
      // RH: "possíveis faltas" de ontem (pendentes de validação; não
      // bloqueiam). A regra documental passou para o trabalho semanal
      // rh-docs-weekly (segunda-feira, rhDocsWeeklyCron).
      await step("rh-no-shows", "RH possíveis faltas", async () => {
        const { detectExtraDiaNoShows } = await import("./rhService");
        const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - 86400000));
        const n = await detectExtraDiaNoShows(yesterday);
        console.log(`[daily-ops] RH: possíveis faltas ${yesterday}: ${n.created} novas (${n.alreadyPending} já registadas)`);
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
      // ligação a cliente/reserva/caso são apagados (os ligados ficam).
      await step("mail-retention", "retenção emails", async () => {
        const { runMailRetention } = await import("./mail/store");
        const r = await runMailRetention({ deadlineAt: cap(5_000) });
        if (r.messages > 0) console.log(`[daily-ops] emails: ${r.messages} mensagem(ns) e ${r.threads} conversa(s) antes de ${r.cutoff} apagadas${r.partial ? ", continua amanhã" : ""}`);
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

/** Avaliação (motor único): recalcula as últimas 4 semanas em fatias de 7 dias. */
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
 * "Pressão" do Extras-Dia: 60 dias da BD Multipark agregados por grupo de
 * parques (um grupo de cada vez; `cursor` retoma no grupo seguinte). Sem
 * DATABASE_URL_MULTIPARK → nota (ok, saltado); grupos que falham → vermelho.
 */
export async function extrasPressureCron(o: { deadlineAt: number; cursor?: string | null }): Promise<CronJobRun> {
  try {
    const { runExtrasPressure } = await import("./extrasPressure");
    const { getSetting } = await import("./appSettings");
    const excludedParkIds = (await getSetting("operations.excludedParks")) ?? [];
    const r = await runExtrasPressure({ deadlineAt: o.deadlineAt - 3_000, cursor: o.cursor ?? null, excludedParkIds });
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

/** Google Ads: daily (última semana) | monthly (mês anterior); hourly/nightly = daily. */
export async function googleAdsCron(o: { deadlineAt: number; kind: string }): Promise<CronJobRun> {
  const { normalizeSyncKind } = await import("./integrations/googleAds/metrics");
  try {
    const { runGoogleAdsSync } = await import("./integrations/googleAds/sync");
    const r = await runGoogleAdsSync({ kind: normalizeSyncKind(o.kind), deadlineAt: o.deadlineAt, triggeredById: null });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: r.status === "skipped" || r.done !== false };
  } catch (err) { return { httpStatus: 500, body: { ok: false, done: true, error: msg(err) } }; }
}

/** Meta Ads: mesma cadência do Google Ads; não configurada → ok:true + skipped. */
export async function metaAdsCron(o: { deadlineAt: number; kind: string }): Promise<CronJobRun> {
  const { normalizeSyncKind } = await import("./integrations/googleAds/metrics");
  try {
    const { runMetaAdsSync } = await import("./integrations/meta/sync");
    const r = await runMetaAdsSync({ kind: normalizeSyncKind(o.kind), deadlineAt: o.deadlineAt, triggeredById: null });
    return { httpStatus: 200, body: { ranAt: ranAt(), ...r }, done: r.status === "skipped" || !!(r as any).skipped || r.done !== false };
  } catch (err) { return { httpStatus: 500, body: { ok: false, done: true, error: msg(err) } }; }
}

/** `?offsetDays=N` → N (só dígitos); resto → 0. */
export function offsetParam(v: unknown): number {
  return typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : 0;
}
