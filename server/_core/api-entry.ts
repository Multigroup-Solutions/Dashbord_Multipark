import express from "express";
import { registerOAuthRoutes } from "./oauth";
import { registerGoogleAdsRoutes } from "../integrations/googleAds/routes";
import { registerMetaAdsRoutes } from "../integrations/meta/routes";
import { registerGoogleBusinessRoutes } from "../integrations/googleBusiness/routes";
import { registerGoogleAccountRoutes } from "../google/routes";
import { registerMailRoutes } from "../mail/routes";
import { syncReviews as syncGoogleBusinessReviews } from "../integrations/googleBusiness/service";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { createExternalApiRouter } from "../externalApi";
import { createMcpApiRouter } from "../mcpApi";
import { createWhatsappWebhookRouter } from "../whatsappWebhook";
import { createMultiparkWebhookRouter, retryMultiparkDeliveries } from "../multiparkWebhook";
import { waitUntil } from "@vercel/functions";
import { deliveryErrorCode } from "../bookingDeliveryQueue";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { sdk } from "./sdk";
import { requireSession } from "./requireSession";
import { cronAuthOk as cronBearerAuthOk } from "../cronAuth";
import { cronRunRecorder } from "../cronRuns";

const app = express();
app.set("trust proxy", 1);
// WhatsApp webhook (Meta) — MONTADO ANTES do express.json global: a validação
// da assinatura HMAC precisa do raw body intacto (usa express.raw internamente).
app.use("/api/whatsapp/webhook", createWhatsappWebhookRouter());
// Webhook das Conexões Multipark (reservas em tempo real) — também precisa do
// raw body para o HMAC, por isso monta antes do express.json.
app.use("/api/multipark/webhook", createMultiparkWebhookRouter({
  afterReceive: () => waitUntil(retryMultiparkDeliveries(Date.now() + 35_000).catch(error => {
    console.error('[MultiparkWebhook] recuperação adiada:', deliveryErrorCode(error));
  })),
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
// Registo de TODAS as corridas de /api/cron/* (tabela cron_runs → Definições →
// Estado do sistema). Montado antes das rotas; waitUntil mantém a função viva
// até a linha final estar escrita.
app.use("/api/cron", cronRunRecorder({ defer: (p) => waitUntil(p) }));

let initError: string | null = null;

try {
  registerOAuthRoutes(app);
  registerGoogleAdsRoutes(app);
  registerMetaAdsRoutes(app);
  registerGoogleBusinessRoutes(app, () => waitUntil(syncGoogleBusinessReviews().catch(() => {
    console.error('[Google Business] A recolha será retomada pelo cron.');
  })));
  // Comunicação: "Ligar a minha conta Google" (OAuth por utilizador), cron
  // /api/cron/mail-sync, push do Gmail e anexos a pedido.
  registerGoogleAccountRoutes(app);
  registerMailRoutes(app, { defer: (p) => waitUntil(p) });
  app.use("/api/external", createExternalApiRouter());
  app.use("/api/v1", createMcpApiRouter());

  // Upload multipart (paridade com o index.ts do Railway — os PDAs usam isto
  // p/ a foto de entrada/saída do check-in; sem isto o Vercel dava 404).
  // NOTA: o Vercel limita o body a ~4.5MB — o cliente redimensiona antes.
  app.post("/api/upload", requireSession, async (req, res, next) => {
    const multer = (await import("multer")).default;
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });
    upload.single("file")(req as any, res as any, async (err: any) => {
      if (err) return res.status(400).json({ error: err.message || "Upload inválido" });
      try {
        const file = (req as any).file;
        if (!file) return res.status(400).json({ error: "No file" });
        const { storagePut } = await import("../storage");
        const ext = file.originalname?.split(".").pop() || "bin";
        const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { url } = await storagePut(key, file.buffer, file.mimetype);
        return res.json({ url, key });
      } catch (e: any) {
        console.error("[Upload] Error:", e);
        return res.status(500).json({ error: e.message || "Upload failed" });
      }
    });
  });

  // Resolve um ficheiro do storage pela KEY (ex.: training/manuals/...).
  // Necessário porque URLs relativas "/uploads/..." gravadas na BD não são
  // servidas no Vercel (o rewrite manda tudo o que não é /api p/ o index.html).
  app.get(/^\/api\/file\/(.+)/, requireSession, async (req, res) => {
    try {
      // O Express já decodifica os grupos capturados — um 2º decodeURIComponent
      // lançava URIError (500) com nomes que contêm "%".
      const key = String((req.params as any)[0] ?? "");
      if (!key || key.includes("..")) return res.status(400).json({ error: "Key inválida" });
      const { storageGet } = await import("../storage");
      const { url } = await storageGet(key);
      if (url && /^https?:\/\//.test(url)) return res.redirect(302, url);
      // Modo local (sem BLOB_READ_WRITE_TOKEN): serve do disco com o
      // content-type inferido da extensão, em vez de 404.
      const fs = await import("fs");
      const path = await import("path");
      const uploadsRoot = path.resolve(process.cwd(), "uploads");
      const localPath = path.resolve(uploadsRoot, key);
      if (localPath.startsWith(uploadsRoot) && fs.existsSync(localPath)) {
        return res.sendFile(localPath);
      }
      return res.status(404).json({ error: "Ficheiro não encontrado no storage" });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Falha a resolver ficheiro" });
    }
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
} catch (err: any) {
  initError = err.stack || err.message || String(err);
  console.error("[API Init Error]", initError);
}

// ─── Crons (GitHub Actions) ──────────────────────────────────────────────────
// O agendador é o GitHub Actions (.github/workflows/*.yml), que chama estes
// endpoints com Authorization: Bearer <CRON_SECRET>. Em ausência da env var,
// nenhuma chamada é permitida. Comparação em tempo constante (server/cronAuth).
function cronAuthOk(req: any): boolean {
  return cronBearerAuthOk(req.headers?.["authorization"]);
}

/** Código do erro para a resposta/log — nunca a mensagem (pode trazer PII). */
const errCode = (err: unknown) => deliveryErrorCode(err);

// Fila de notificações + detalhe + histórico, de 5 em 5 minutos. Falhas de
// itens (reserva ainda incompleta, histórico que falhou) são repetidas pela
// fila com backoff → vão em `warnings` e o cron fica verde. ok:false só quando
// uma fase inteira falha (fila/BD indisponível).
app.get("/api/cron/multipark-deliveries", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const startedAt = Date.now();
  const phaseErrors: string[] = [];
  let queue: Awaited<ReturnType<typeof retryMultiparkDeliveries>> | null = null;
  let details: { scanned: number; enriched: number; errors: number; noKey: number; closed?: number } | null = null;
  let history: { scanned: number; fetched: number; errors: number; noKey: number; closed?: number } | null = null;
  let alert: unknown = null;
  try {
    queue = await retryMultiparkDeliveries(startedAt + 20_000);
  } catch (err) {
    console.error("[cron multipark-deliveries] fila:", errCode(err));
    phaseErrors.push(`fila indisponível (${errCode(err)})`);
  }
  try {
    const { enrichBookingsBatch, syncBookingHistoryBatch } = await import("../jobs/multiparkBookingSync");
    // O detalhe tem um ciclo próprio: um report demorado não pode impedir
    // para sempre a atualização de matrículas, clientes e campanhas.
    try {
      details = await enrichBookingsBatch({ limit: 40, deadlineAt: startedAt + 32_000 });
    } catch (err) {
      console.error("[cron multipark-deliveries] detalhe:", errCode(err));
      phaseErrors.push(`detalhe falhou (${errCode(err)})`);
    }
    try {
      history = await syncBookingHistoryBatch(20, startedAt + 45_000);
    } catch (err) {
      console.error("[cron multipark-deliveries] histórico:", errCode(err));
      phaseErrors.push(`histórico falhou (${errCode(err)})`);
    }
  } catch (err) {
    console.error("[cron multipark-deliveries] módulo:", errCode(err));
    phaseErrors.push(`sync indisponível (${errCode(err)})`);
  }
  // Alerta "sem webhooks em horário de operação" (1 aviso por transição).
  try {
    const { checkWebhookStaleAlert } = await import("../syncHealth");
    alert = await checkWebhookStaleAlert();
  } catch (err) {
    console.warn("[cron multipark-deliveries] alerta webhooks:", errCode(err));
  }
  const { deliveriesVerdict } = await import("../syncRules");
  const verdict = deliveriesVerdict({ phaseErrors, queue, details, history });
  res.status(verdict.ok ? 200 : 503).json({ ...verdict, ranAt: new Date().toISOString(), ...(queue ?? {}), queue, details, history, alert });
});

app.get("/api/cron/multipark-sync", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runRecentCronSync } = await import("../jobs/multiparkBookingSync");
    const result = await runRecentCronSync(30);
    if (result.busy) {
      // Outro sync (botão, MCP) tem o trinco: não é falha, repete na hora seguinte.
      return res.json({ ok: true, skipped: "busy", message: "Sincronização já a correr", ranAt: new Date().toISOString() });
    }
    // Descoberta automática de parceiros (partnerIds novos → partnership +
    // alias; campanhas "Pro X" → empresa Pro). Melhor esforço: nunca parte o
    // sync. Os parceiros novos nascem "Por configurar" (Gestão das Parcerias).
    let partners: Record<string, unknown> | { error: string } | undefined;
    try {
      const { syncPartnersFromApi } = await import("../partnerSync");
      const r = await syncPartnersFromApi({ maxLookups: 5 });
      partners = { created: r.created, linkedToExisting: r.linkedToExisting, proCreated: r.proCreated, unresolved: r.unresolved.length };
      console.log("[cron multipark-sync] parceiros:", JSON.stringify(partners));
    } catch (err: any) {
      partners = { error: errCode(err) };
      console.warn("[cron multipark-sync] sincronização de parceiros falhou:", partners.error);
    }
    const { recentSyncVerdict } = await import("../syncRules");
    // ok:false quando há parques cujo report falhou (a cobertura deles não
    // avançou e o próximo ciclo repete) ou quando a descoberta de parceiros
    // falhou — o workflow fica vermelho e abre issue.
    const verdict = recentSyncVerdict({
      parkErrors: result.parkErrors,
      errors: result.report.errors,
      partnersError: partners && "error" in partners ? String(partners.error) : null,
    });
    if (!verdict.ok) console.warn("[cron multipark-sync]", verdict.error);
    res.json({ ...verdict, ranAt: new Date().toISOString(), ...result, report: { ...result.report, errors: result.report.errors.slice(0, 20) }, partners });
  } catch (err: any) {
    console.error("[cron multipark-sync] falhou:", errCode(err));
    res.status(500).json({ ok: false, error: `sync recente falhou (${errCode(err)})` });
  }
});

// Ligações automáticas funcionário ↔ utilizador ↔ agente Multipark (Fase 1),
// de hora a hora. Conservador e idempotente — ver server/identityLink.ts.
app.get("/api/cron/identity-sweep", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runIdentitySweep } = await import("../identityLink");
    const report = await runIdentitySweep();
    res.json({ ok: report.errors.length === 0, ranAt: new Date().toISOString(), ...report });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

app.get("/api/cron/multipark-future", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runFutureCronSync } = await import("../jobs/multiparkBookingSync");
    // ?offsetDays=N retoma a varredura a partir desse dia da janela — a janela
    // completa não cabe nos 60s do Vercel; a resposta traz done/nextOffset e o
    // workflow repete até done:true.
    const offsetDays = typeof req.query?.offsetDays === "string" && /^\d+$/.test(req.query.offsetDays)
      ? Number(req.query.offsetDays)
      : 0;
    const result = await runFutureCronSync(4, { offsetDays });
    if (result.busy) {
      // Trinco ocupado: não é falha. done:true para o workflow não ciclar;
      // a janela futura é refeita no ciclo seguinte (2 h).
      return res.json({ ok: true, skipped: "busy", message: "Sincronização já a correr", done: true, ranAt: new Date().toISOString() });
    }
    const { futureSyncVerdict } = await import("../syncRules");
    // ok:false só quando não acabou E não avançou (report falhado ou prazo
    // esgotado na 1.ª fatia) — avançar uma fatia já é progresso.
    const verdict = futureSyncVerdict(result);
    if (!verdict.ok) console.warn("[cron multipark-future]", verdict.error);
    res.json({ ...verdict, ranAt: new Date().toISOString(), ...result, report: { ...result.report, errors: result.report.errors.slice(0, 20) } });
  } catch (err: any) {
    console.error("[cron multipark-future] falhou:", errCode(err));
    res.status(500).json({ ok: false, error: `sync futuro falhou (${errCode(err)})` });
  }
});

// Recolha diária de operações (driver history do Zello + alertas gps_off).
// Substitui o startDailyCollectionScheduler() que só corre no server Railway —
// em Vercel é preciso este cron (GitHub Actions, 1×/dia).
app.get("/api/cron/daily-ops", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const startedAt = Date.now();
    // Passos de manutenção que falharam: antes só iam para o log e o cron ficava
    // verde; agora vão na resposta e o workflow falha no fim (depois da recolha).
    const stepErrors: string[] = [];
    // Tarefas de manutenção só na 1.ª chamada: as repetições (done:false) trazem
    // ?collectOnly=1 e usam os 45s todos na recolha — antes voltavam a correr
    // tudo e a recolha podia passar dos 60s do Vercel (504).
    if (req.query?.collectOnly !== "1") {
      // Despesas: marca vencidas como "overdue" (antes só existia um botão
      // manual super_admin que ninguém carregava — os KPIs de "Em Atraso"
      // nunca mexiam) e lança as despesas recorrentes do mês em nome do
      // utilizador de sistema (antes era quem abrisse a página primeiro).
      try {
        const { markOverdueExpenses } = await import("../db");
        await markOverdueExpenses();
      } catch (err) {
        console.warn("[daily-ops] markOverdueExpenses:", err);
        stepErrors.push(`markOverdueExpenses: ${String((err as any)?.message ?? err).slice(0, 200)}`);
      }
      // Recorrentes do mês corrente (Lisboa): idempotente (lock + UNIQUE por
      // modelo/mês). Deixou de correr ao abrir a página de despesas.
      try {
        const { generateRecurringExpensesForMonth } = await import("../expenseRecurring");
        const { lisbonToday } = await import("../../shared/expensePeriods");
        const [y, m] = lisbonToday().split("-").map(Number);
        const r = await generateRecurringExpensesForMonth(y, m, null);
        if (r.created > 0) console.log(`[daily-ops] recorrentes ${r.period}: ${r.created} lançada(s), ${r.skipped} já existiam`);
      } catch (err) {
        console.warn("[daily-ops] recorrentes:", err);
        stepErrors.push(`recorrentes: ${String((err as any)?.message ?? err).slice(0, 200)}`);
      }

      // Segunda-feira (Lisboa): gera automaticamente a avaliação da semana ANTERIOR
      try {
        const lisbonNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
        if (lisbonNow.getDay() === 1) {
          const prev = new Date(lisbonNow); prev.setDate(prev.getDate() - 7);
          const d = new Date(Date.UTC(prev.getFullYear(), prev.getMonth(), prev.getDate()));
          const dayNum = d.getUTCDay() || 7;
          d.setUTCDate(d.getUTCDate() + 4 - dayNum);
          const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
          const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
          const { generateWeeklyEvaluation } = await import("../db");
          const r = await generateWeeklyEvaluation(week, d.getUTCFullYear());
          console.log(`[daily-ops] avaliação semanal S${week} gerada (${r.length} condutores)`);
        }
      } catch (err) {
        console.warn("[daily-ops] avaliação semanal:", err);
        stepErrors.push(`avaliação semanal: ${String((err as any)?.message ?? err).slice(0, 200)}`);
      }

      // Tarefas (rede de segurança do extras-auto horário): checklists do dia
      // + avisos de atraso/conclusão. Idempotente.
      try {
        const { runTaskAutomation } = await import("../tasksService");
        await runTaskAutomation(new Date());
      } catch (err) {
        console.warn("[daily-ops] tarefas:", err);
        stepErrors.push(`tarefas: ${String((err as any)?.message ?? err).slice(0, 200)}`);
      }

      // Fecha check-ins esquecidos (>16h abertos → check-out a +12h, [SUSPEITO])
      try {
        const { autoCloseStaleCheckIns } = await import("../db");
        const r = await autoCloseStaleCheckIns();
        if (r.closed > 0) console.log(`[daily-ops] auto-checkout de ${r.closed} ponto(s) esquecido(s)`);
      } catch (err) {
        console.warn("[daily-ops] autoCloseStaleCheckIns:", err);
        stepErrors.push(`autoCloseStaleCheckIns: ${String((err as any)?.message ?? err).slice(0, 200)}`);
      }
      // RH: regra documental (escrita SÓ aqui e na ação admin — nunca no auth.me)
      // e "possíveis faltas" de ontem (pendentes de validação; não bloqueiam).
      try {
        const { applyDocsComplianceAll, detectExtraDiaNoShows } = await import("../rhService");
        const d = await applyDocsComplianceAll();
        const { lisbonToday } = await import("../../shared/expensePeriods");
        const y = new Date(Date.now() - 86400000);
        const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(y);
        void lisbonToday;
        const n = await detectExtraDiaNoShows(yesterday);
        console.log(`[daily-ops] RH: docs verificados ${d.checked}; possíveis faltas ${yesterday}: ${n.created} novas (${n.alreadyPending} já registadas)`);
      } catch (err) {
        console.warn("[daily-ops] RH docs/faltas:", err);
        stepErrors.push(`RH docs/faltas: ${String((err as any)?.message ?? err).slice(0, 200)}`);
      }
      // Retenção do registo de atividade: apaga > 12 meses, em lotes de 5000
      // (DELETE … LIMIT, sem subquery) e com prazo curto — o resto fica para
      // o dia seguinte.
      // Fila de notificações Multipark: apaga concluídos com mais de 30 dias.
      try {
        const { purgeCompletedDeliveries } = await import("../bookingDeliveryQueue");
        const r = await purgeCompletedDeliveries({ days: 30, deadlineAt: startedAt + 8_000 });
        if (r.deleted > 0) console.log(`[daily-ops] fila Multipark: ${r.deleted} concluído(s) antigos apagados${r.done ? "" : ", continua amanhã"}`);
      } catch (err) {
        console.warn("[daily-ops] limpeza da fila Multipark:", errCode(err));
        stepErrors.push(`limpeza fila Multipark: ${errCode(err)}`);
      }
      try {
        const { purgeOldActivityLogs } = await import("../db");
        const r = await purgeOldActivityLogs({ deadlineAt: startedAt + 15_000 });
        if (r.deleted > 0) console.log(`[daily-ops] activity_logs: ${r.deleted} registo(s) antigos apagados (${r.batches} lote(s)${r.done ? "" : ", continua amanhã"})`);
      } catch (err) {
        console.warn("[daily-ops] retenção activity_logs:", err);
        stepErrors.push(`retenção logs: ${String((err as any)?.message ?? err).slice(0, 200)}`);
      }
      // Assistente (chat): conversas e mensagens com mais de 30 dias.
      try {
        const { purgeOldChats } = await import("./ai/chat/store");
        const r = await purgeOldChats({ deadlineAt: startedAt + 18_000 });
        if (r.deleted > 0) console.log(`[daily-ops] assistente: ${r.deleted} mensagem(ns)/conversa(s) antigas apagadas${r.done ? "" : ", continua amanhã"}`);
      } catch (err) {
        console.warn("[daily-ops] retenção do assistente:", errCode(err));
        stepErrors.push(`retenção assistente: ${errCode(err)}`);
      }
      // Comunicação: emails mais antigos do que `mail.retentionYears` e SEM
      // ligação a cliente/reserva/caso são apagados (os ligados ficam).
      try {
        const { runMailRetention } = await import("../mail/store");
        const r = await runMailRetention({ deadlineAt: startedAt + 22_000 });
        if (r.messages > 0) console.log(`[daily-ops] emails: ${r.messages} mensagem(ns) e ${r.threads} conversa(s) antes de ${r.cutoff} apagadas${r.partial ? ", continua amanhã" : ""}`);
      } catch (err) {
        console.warn("[daily-ops] retenção dos emails:", errCode(err));
        stepErrors.push(`retenção emails: ${errCode(err)}`);
      }
    }

    // Reconciliação Multipark (report D-1/D-2 vs BD). Retomável: corre em
    // todas as chamadas (também ?collectOnly=1) até verificar tudo.
    let reconciliation: { done: boolean; checked: number; remaining: number; errors: number; summary: unknown } | null = null;
    try {
      const { runDailyReconciliation } = await import("../jobs/multiparkReconciliation");
      const r = await runDailyReconciliation({ deadlineAt: Date.now() + 12_000 });
      reconciliation = { done: r.done, checked: r.checked, remaining: r.remaining, errors: r.errors, summary: r.summary };
    } catch (err) {
      console.warn("[daily-ops] reconciliação Multipark:", errCode(err));
      stepErrors.push(`reconciliação Multipark: ${errCode(err)}`);
    }

    // Zello não configurado: a recolha GPS não pode correr — antes devolvia
    // "0 condutores, sucesso" em silêncio. Agora o cron fica vermelho com o
    // motivo (a manutenção acima já correu).
    const { isZelloConfigured } = await import("../zello");
    if (!isZelloConfigured()) {
      return res.json({
        ok: false, ranAt: new Date().toISOString(), done: reconciliation == null || reconciliation.done, stepErrors, reconciliation, skipped: "zello_not_configured",
        error: "Zello não configurado (ZELLO_API_KEY/ZELLO_USERNAME/ZELLO_PASSWORD): recolha GPS diária não correu.",
        warnings: ["Recolha GPS saltada: Zello não configurado."],
      });
    }
    const { collectDailyDriverData } = await import("../jobs/dailyDriverCollection");
    // ?date=YYYY-MM-DD permite recolher um dia específico (backfill de dias
    // falhados); por omissão, o dia anterior.
    const qDate = typeof req.query?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? new Date(`${req.query.date}T12:00:00Z`)
      : null;
    const yesterday = qDate ?? new Date(Date.now() - 24 * 60 * 60 * 1000); // dia anterior
    // Prazo < maxDuration (60s): sem isto a recolha morria com 504 a meio e a
    // corrida seguinte via registos parciais e desistia. done:false → o
    // workflow chama outra vez até done:true (a recolha é retomável).
    const result = await collectDailyDriverData(yesterday, { deadlineAt: startedAt + 45_000 });
    // Fase 0: recalcula o histórico GPS antigo (velocidades ×3,6, sem
    // funcionário) com o tempo que sobrar; o workflow repete até acabar.
    let recompute: { updated: number; remaining: number } | null = null;
    if (result.done && Date.now() < startedAt + 40_000) {
      try {
        const { recomputeDriverHistory } = await import("../jobs/dailyDriverCollection");
        recompute = await recomputeDriverHistory({ deadlineAt: startedAt + 45_000 });
      } catch (err: any) {
        stepErrors.push(`recalcular GPS: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
    // Recolha Zello falhada (login, API em baixo…) → ok:false com o motivo.
    res.json({
      ok: result.success, ranAt: new Date().toISOString(), date: yesterday.toISOString().slice(0, 10), stepErrors, ...result,
      ...(result.success ? {} : { error: `Recolha Zello falhou: ${String(result.errors[result.errors.length - 1] ?? "sem detalhe").slice(0, 300)}` }),
      recompute,
      reconciliation,
      done: result.done && (recompute == null || recompute.remaining === 0) && (reconciliation == null || reconciliation.done),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Avaliação (motor único): recalcula TODOS os dias das últimas 4 semanas em
// employee_day_metrics (ações, ponto sem [SUSPEITO], escala, ocorrências,
// reclamações, velocidade). Fatias de 7 dias dentro do prazo: devolve
// done:false + nextOffset e o workflow repete com ?offsetDays=N.
app.get("/api/cron/evaluation-recompute", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const offsetDays = typeof req.query?.offsetDays === "string" && /^\d+$/.test(req.query.offsetDays)
      ? Number(req.query.offsetDays)
      : 0;
    const { runEvaluationRecompute } = await import("../evaluationEngine");
    const result = await runEvaluationRecompute({ offsetDays, deadlineAt: Date.now() + 40_000 });
    res.json({ ok: true, ranAt: new Date().toISOString(), ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Automação dos extras (pedido de disponibilidade à quinta, lembrete ao
// sábado, aviso de escala e alerta de cobertura às 18h). Chamado de hora a
// hora; o próprio módulo decide pela hora de Lisboa o que está na altura.
app.get("/api/cron/extras-auto", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runExtrasAutomation } = await import("../extrasAutomation");
    const report = await runExtrasAutomation();
    res.json({ ok: report.errors.length === 0, ranAt: new Date().toISOString(), ...report });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Briefing diário por cidade (07:30 Lisboa), anomalias e, à segunda,
// relatórios semanais (server/aiOps/cron.ts). Idempotente; o próprio módulo
// decide pela hora de Lisboa. done:false → o workflow repete (prazo de 45 s).
app.get("/api/cron/ops-briefing", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runOpsBriefingCron } = await import("../aiOps/cron");
    const report = await runOpsBriefingCron({ deadlineAt: Date.now() + 45_000, force: req.query?.force === "1" });
    res.json({ ranAt: new Date().toISOString(), ...report });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Escala automática dos extras (propor às 14h, confirmar e avisar às 18h, por
// omissão — Definições → Parâmetros → Extras-dia). O GitHub Actions chama de
// 30 em 30 min entre as 08h e as 23h de Lisboa; tudo idempotente (propor duas
// vezes não duplica, confirmar duas vezes não reenvia). ok:false só com erros.
app.get("/api/cron/extras-schedule", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runScheduleAutomation } = await import("../extrasSchedule");
    const report = await runScheduleAutomation();
    res.json({ ranAt: new Date().toISOString(), ...report });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Leitor de email inbound: lê a caixa reservas@ por IMAP e cria registos nos
// módulos (Críticas/Reclamações/Perdidos/RH) a partir dos emails reencaminhados
// para os aliases. Substitui o fluxo Make.com. O GitHub Actions chama-o de hora
// a hora (multipark-cron.yml, minuto 7). O agendador in-process do servidor Node
// (Railway) só corre com INPROCESS_SCHEDULERS=on (desligado por omissão).
app.get("/api/cron/email-inbound", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runEmailInboundSync } = await import("../jobs/emailInboundSync");
    // Prazo < maxDuration (60s): o scan IMAP dos 4 aliases × 30d passava dos
    // 60s e morria SEMPRE com 504. partial:true → o workflow repete a chamada
    // (dedup por messageId torna cada corrida incremental).
    const result = await runEmailInboundSync({ deadlineAt: Date.now() + 45_000 });
    // Erros do próprio IMAP (pesquisa por alias falhou) → ok:false, para o
    // workflow ficar vermelho; erros de UM email ficam só na lista (repetem-se).
    const imapErrors = result.errors.filter((e) => e.startsWith("search "));
    res.json({ ok: result.configured && imapErrors.length === 0, done: !result.partial, ranAt: new Date().toISOString(), imapErrors: imapErrors.length, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// IA na comunicação com clientes: triagem do WhatsApp (debounce vencido),
// reclamações por triar, rascunhos das críticas novas e correspondências dos
// Perdidos — lotes pequenos, prazo < 60 s. GitHub Actions a cada 15 min
// (.github/workflows/ai-comms.yml). Nunca envia nada a clientes.
app.get("/api/cron/ai-comms", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runCommsAiSweep } = await import("../commsAiSweep");
    const report = await runCommsAiSweep({ deadlineAt: Date.now() + 45_000 });
    res.json({ ok: report.errors.length === 0, ranAt: new Date().toISOString(), ...report });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Health check. Público: só { ok, version? }. Com sessão admin/super_admin
// ou Authorization: Bearer <CRON_SECRET> → presença (booleana) das variáveis
// críticas. O erro/stack de arranque NUNCA sai na resposta — só no log.
app.get("/api/health", async (req, res) => {
  const { buildHealthBody, cronBearerOk } = await import("../opsRules");
  let detailed = cronBearerOk(req.headers["authorization"]);
  if (!detailed && !initError) {
    try {
      const user = await sdk.authenticateRequest(req);
      detailed = !!user && (user.role === "admin" || user.role === "super_admin");
    } catch { /* sem sessão → resposta pública */ }
  }
  res.status(initError ? 503 : 200).json(buildHealthBody({ initFailed: !!initError, detailed }));
});

// Handler for Vercel serverless
const handler = async (req: any, res: any) => {
  if (initError && !req.url.includes("/api/health")) {
    // Detalhe (stack) só no log do servidor — nunca na resposta.
    return res.status(500).json({ error: "Server init failed" });
  }
  app(req, res);
};

export default handler;
