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
import { getDeadline, waitUntil } from "@vercel/functions";
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

// ─── Crons ───────────────────────────────────────────────────────────────────
// Agendador OFICIAL: /api/cron/tick, chamado de 5 em 5 min pelo cron-job.org
// (docs/ajuda/agendador.md) e de hora a hora pelo GitHub Actions como rede de
// segurança (.github/workflows/cron-tick.yml). O tick decide pela hora de
// Lisboa o que está na altura (server/cronSchedule.ts) e corre os trabalhos
// com lease, prazo e retoma (server/cronScheduler.ts). Os endpoints de cada
// trabalho ficam para uso manual (workflow_dispatch / curl) e partilham o
// código com o tick (server/cronJobs.ts). Todos exigem Authorization: Bearer
// <CRON_SECRET>; sem a env var, nenhuma chamada é permitida (server/cronAuth).
function cronAuthOk(req: any): boolean {
  return cronBearerAuthOk(req.headers?.["authorization"]);
}

/** Prazo de um endpoint manual: < 50 s (maxDuration 60 s, margem para responder). */
const manualDeadline = (ms = 45_000) => Date.now() + ms;

// Agendador único. Responde logo 202 com o que vai arrancar e continua em
// segundo plano (waitUntil do Vercel mantém a função viva até ~60 s — o
// orçamento do tick é 50 s desde a chegada do pedido e respeita o prazo real
// da função, getDeadline). ?wait=1 → corre tudo e devolve o relatório
// completo (ok:false se algum trabalho falhou) — usado pelo GitHub Actions.
app.get("/api/cron/tick", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const startedAt = Date.now();
  try {
    const { planDueJobs, runTick } = await import("../cronScheduler");
    const { tickBudgetEnd } = await import("../cronSchedule");
    const budgetEndAt = tickBudgetEnd(startedAt, getDeadline()?.getTime() ?? null);
    const plan = await planDueJobs(startedAt);
    if (req.query?.wait === "1") {
      const report = await runTick(plan, budgetEndAt);
      return res.json({ ranAt: new Date().toISOString(), ...report });
    }
    const work = runTick(plan, budgetEndAt)
      .then((r) => { if (!r.ok) console.warn("[cron tick]", r.errors.join(" | ").slice(0, 500)); })
      .catch((err) => console.error("[cron tick] falhou:", String(err?.message ?? err).slice(0, 200)));
    waitUntil(work);
    return res.status(202).json({ ok: true, accepted: true, ranAt: new Date().toISOString(), budgetMs: budgetEndAt - startedAt, starting: plan.planned });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: String(err?.message ?? err).slice(0, 300) });
  }
});

// Fila de notificações + detalhe + histórico (tick: de 15 em 15 min). Falhas
// de itens vão em `warnings` e o cron fica verde; 503 só se uma fase falhar.
app.get("/api/cron/multipark-deliveries", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { multiparkDeliveriesCron, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await multiparkDeliveriesCron({ deadlineAt: manualDeadline() }));
});

app.get("/api/cron/multipark-sync", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { multiparkSyncCron, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await multiparkSyncCron({ deadlineAt: manualDeadline() }));
});

// Ligações automáticas funcionário ↔ utilizador ↔ agente Multipark (Fase 1).
// Conservador e idempotente — ver server/identityLink.ts.
app.get("/api/cron/identity-sweep", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { identitySweepCron, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await identitySweepCron());
});

// ?offsetDays=N retoma a varredura a partir desse dia da janela — a janela
// completa não cabe nos 60 s do Vercel; a resposta traz done/nextOffset.
app.get("/api/cron/multipark-future", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { multiparkFutureCron, offsetParam, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await multiparkFutureCron({ deadlineAt: manualDeadline(), offsetDays: offsetParam(req.query?.offsetDays) }));
});

// Manutenção diária + reconciliação + recolha GPS FINAL do Zello (D-2 e dias
// em falta), tudo dentro do prazo e retomável (done:false → chamar outra vez).
// ?collectOnly=1 salta a manutenção; ?date=YYYY-MM-DD recolhe esse dia.
app.get("/api/cron/daily-ops", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { dailyOpsCron, sendCronRun } = await import("../cronJobs");
  const date = typeof req.query?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  sendCronRun(res, await dailyOpsCron({ deadlineAt: manualDeadline(), collectOnly: req.query?.collectOnly === "1", date }));
});

// GPS do Zello — passagem provisória do dia de hoje (tick: 23:15–23:55 de
// Lisboa). À mão só faz sentido antes da meia-noite.
app.get("/api/cron/zello-sameday", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { zelloSameDayCron, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await zelloSameDayCron({ deadlineAt: manualDeadline() }));
});

// RH — regra documental dos extras (tick: segunda a partir das 04:45).
app.get("/api/cron/rh-docs-weekly", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { rhDocsWeeklyCron, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await rhDocsWeeklyCron());
});

// Avaliação (motor único): recalcula as últimas 4 semanas em fatias de 7
// dias; done:false + nextOffset → repetir com ?offsetDays=N.
app.get("/api/cron/evaluation-recompute", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { evaluationRecomputeCron, offsetParam, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await evaluationRecomputeCron({ deadlineAt: manualDeadline(), offsetDays: offsetParam(req.query?.offsetDays) }));
});

// Automação dos extras (pedido de disponibilidade à quinta, lembrete ao
// sábado, aviso de escala e alerta de cobertura às 18h, …). O módulo decide
// pela hora de Lisboa; com prazo — done:false + nextStep → ?from=<passo>.
app.get("/api/cron/extras-auto", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { extrasAutoCron, sendCronRun } = await import("../cronJobs");
  const from = typeof req.query?.from === "string" && /^[a-z-]{1,40}$/.test(req.query.from) ? req.query.from : null;
  sendCronRun(res, await extrasAutoCron({ deadlineAt: manualDeadline(), from }));
});

// Briefing diário por cidade (07:30 Lisboa), anomalias e, à segunda,
// relatórios semanais (server/aiOps/cron.ts). Idempotente; done:false → repetir.
app.get("/api/cron/ops-briefing", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { opsBriefingCron, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await opsBriefingCron({ deadlineAt: manualDeadline(), force: req.query?.force === "1" }));
});

// Escala automática dos extras (propor às 14h, confirmar e avisar às 18h, por
// omissão — Definições → Parâmetros → Extras-dia). Tick: de hora a hora das
// 08h às 23h de Lisboa; tudo idempotente. ok:false só com erros.
app.get("/api/cron/extras-schedule", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { extrasScheduleCron, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await extrasScheduleCron());
});

// Leitor de email inbound: lê a caixa reservas@ por IMAP e cria registos nos
// módulos (Críticas/Reclamações/Perdidos/RH). partial → done:false (repetir).
app.get("/api/cron/email-inbound", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { emailInboundCron, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await emailInboundCron({ deadlineAt: manualDeadline() }));
});

// IA na comunicação com clientes: triagem do WhatsApp, reclamações por
// triar, rascunhos das críticas e Perdidos — lotes pequenos. Nunca envia nada.
app.get("/api/cron/ai-comms", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { aiCommsCron, sendCronRun } = await import("../cronJobs");
  sendCronRun(res, await aiCommsCron({ deadlineAt: manualDeadline() }));
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
