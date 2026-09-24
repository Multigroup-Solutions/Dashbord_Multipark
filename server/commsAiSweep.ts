/**
 * Varrimento da IA na comunicação com clientes (cron /api/cron/ai-comms, a
 * cada 15 min pelo GitHub Actions). Cada passo tem lote pequeno e o prazo
 * total fica abaixo dos 60 s do Vercel; interruptores desligados / orçamento
 * esgotado → o passo salta sem erro. Nada é enviado a clientes.
 */
export interface CommsAiSweepReport {
  complaints?: unknown;
  reviews?: unknown;
  whatsapp?: unknown;
  lostFound?: unknown;
  errors: string[];
}

export async function runCommsAiSweep(opts: { deadlineAt?: number } = {}): Promise<CommsAiSweepReport> {
  const deadlineAt = opts.deadlineAt ?? Date.now() + 45_000;
  const report: CommsAiSweepReport = { errors: [] };
  const step = async (name: keyof Omit<CommsAiSweepReport, "errors">, fn: () => Promise<unknown>) => {
    if (Date.now() + 17_000 > deadlineAt) { report[name] = { skipped: "deadline" }; return; }
    try { report[name] = await fn(); }
    catch (err: any) { report.errors.push(`${name}: ${String(err?.message ?? err).slice(0, 160)}`); }
  };
  // WhatsApp primeiro: as urgentes alimentam o aviso de SLA do cron horário.
  await step("whatsapp", async () => (await import("./whatsappTriage")).runWhatsappTriageSweep({ limit: 8, deadlineAt }));
  await step("complaints", async () => (await import("./complaintTriage")).triagePendingComplaints({ limit: 3, deadlineAt }));
  await step("reviews", async () => (await import("./reviewAutoDraft")).draftPendingReviewReplies({ limit: 3, deadlineAt }));
  await step("lostFound", async () => (await import("./lostFoundMatch")).runLostFoundMatchSweep({ limit: 3, deadlineAt }));
  return report;
}
