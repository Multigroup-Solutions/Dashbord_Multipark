/**
 * Varrimento da IA na comunicação com clientes (trabalho ai-comms do
 * agendador /api/cron/tick, de 15 em 15 min). Cada passo tem lote pequeno e o prazo
 * total fica abaixo dos 60 s do Vercel; interruptores desligados / orçamento
 * esgotado → o passo salta sem erro. Nada é enviado a clientes.
 */
export interface CommsAiSweepReport {
  complaints?: unknown;
  reviews?: unknown;
  whatsapp?: unknown;
  lostFound?: unknown;
  /** D39: anexos dos emails do RH (interruptor AI_HR_EMAIL_ATTACHMENTS). */
  rhAttachments?: unknown;
  /** Emails que ficaram por separar pelas caixas na sincronização (interruptor AI_MAIL_ROUTING). */
  routing?: unknown;
  /** Lote 57: reclamações vistas pela IA noutras caixas cuja criação falhou — nova tentativa (AI_MAIL_COMPLAINTS). */
  complaintIntake?: unknown;
  errors: string[];
}

export async function runCommsAiSweep(opts: { deadlineAt?: number } = {}): Promise<CommsAiSweepReport> {
  const deadlineAt = opts.deadlineAt ?? Date.now() + 45_000;
  const report: CommsAiSweepReport = { errors: [] };
  const step = async (name: keyof Omit<CommsAiSweepReport, "errors">, fn: () => Promise<unknown>) => {
    if (Date.now() + 22_000 > deadlineAt) { report[name] = { skipped: "deadline" }; return; }
    try { report[name] = await fn(); }
    catch (err: any) { report.errors.push(`${name}: ${String(err?.message ?? err).slice(0, 160)}`); }
  };
  // WhatsApp primeiro: as urgentes alimentam o aviso de SLA do cron horário.
  await step("whatsapp", async () => (await import("./whatsappTriage")).runWhatsappTriageSweep({ limit: 8, deadlineAt }));
  await step("complaints", async () => (await import("./complaintTriage")).triagePendingComplaints({ limit: 3, deadlineAt }));
  await step("reviews", async () => (await import("./reviewAutoDraft")).draftPendingReviewReplies({ limit: 3, deadlineAt }));
  await step("lostFound", async () => (await import("./lostFoundMatch")).runLostFoundMatchSweep({ limit: 3, deadlineAt }));
  await step("rhAttachments", async () => (await import("./rhAttachmentReader")).runRhAttachmentSweep({ limit: 2, deadlineAt }));
  // Separar pelas caixas: os emails novos que não couberam no teto da sincronização (por último: não tira tempo aos outros).
  await step("routing", async () => (await import("./commsRouting")).runPendingEmailRoutings({ limit: 4, deadlineAt }));
  // Reclamações que a IA viu noutra caixa e não se conseguiram criar (Gmail/BD em baixo): sem IA, só volta a tentar.
  await step("complaintIntake", async () => (await import("./complaintMailIntake")).retryFailedIntakes({ limit: 2, deadlineAt }));
  return report;
}

/**
 * 14 out 2026 — trabalho mail-backfill do agendador (de 15 em 15 min, prazo
 * próprio para não tirar tempo à IA da comunicação):
 *  - casos dos pipelines (reclamacoes@, perdidos@…) que falharam: nova
 *    tentativa (antes só a sincronização agendada o fazia — com o push do Gmail
 *    saudável, 1×/dia);
 *  - os emails que já estão nas caixas, sem caso: a mesma triagem
 *    (interruptor AI_MAIL_BACKFILL; Definições → Parâmetros → IA, "ai.mailBackfill").
 * Nada é enviado a clientes.
 */
export interface MailBackfillJobReport { pipelineRetry?: unknown; backfill?: unknown; errors: string[] }

export async function runMailBackfillJob(opts: { deadlineAt?: number } = {}): Promise<MailBackfillJobReport> {
  const deadlineAt = opts.deadlineAt ?? Date.now() + 30_000;
  const report: MailBackfillJobReport = { errors: [] };
  try {
    const { retryFailedPipelines } = await import("./mail/service");
    const r: any = { ok: true, configured: true, done: true, accounts: [], stored: 0, pipelineCreated: 0, errors: [] };
    await retryFailedPipelines(r, Math.min(deadlineAt - 15_000, Date.now() + 12_000), { limit: 3 });
    report.pipelineRetry = { created: r.pipelineCreated, failed: r.errors.length };
    if (r.errors.length) report.errors.push(...r.errors.slice(0, 3).map((x: string) => `casos: ${x}`));
  } catch (err: any) {
    report.errors.push(`casos: ${String(err?.message ?? err).slice(0, 160)}`);
  }
  if (Date.now() + 20_000 > deadlineAt) report.backfill = { skipped: "deadline" };
  else {
    try {
      const r = await (await import("./commsRouting")).runMailBackfill({ deadlineAt });
      report.backfill = r;
      if (r.read) console.log(`[triagem-email] varrimento: ${r.read} lido(s), ${r.ai} pela IA, ${r.cases} caso(s)${r.skipped ? ` (${r.skipped})` : ""}`);
    } catch (err: any) {
      report.errors.push(`varrimento: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
  return report;
}
