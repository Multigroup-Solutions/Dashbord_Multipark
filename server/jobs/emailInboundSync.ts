// server/jobs/emailInboundSync.ts
// Leitor IMAP da caixa reservas@multipark.pt. Lê os emails que o backoffice
// REENCAMINHA para os aliases temáticos e cria o registo no módulo certo:
//   criticas@        → Google Reviews   (createGoogleReview + resposta IA)
//   reclamacoes@     → Reclamações      (createComplaint)
//   perdidos@        → Perdidos&Achados (createLostFoundItem)
//   recursos-humanos@→ inbound_emails (aba Recrutamento) + Tarefa p/ Kamila
//
// Substitui o fluxo Make.com (Gmail→críticas/ocorrências). Filtra automaticamente
// o ruído: só processa emails cujo Delivered-To é um dos aliases (as ~4000
// notificações automáticas de reserva têm Delivered-To=reservas@skypark.pt e
// nunca entram aqui). Dedup por Message-ID. Idempotente.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  routeAlias,
  isSystemEmail,
  parseInboundBody,
  type InboundAlias,
} from "../emailParse";
import {
  createGoogleReview,
  updateGoogleReview,
  createComplaint,
  createLostFoundItem,
  createTask,
  createInboundEmail,
  getInboundEmailByMessageId,
  findEmployeeByEmailOrName,
  getSystemUserId,
  assignTaskToEmployee,
  findComplaintByClientSignals,
  findRecentBookingByClientSignals,
  findOpenLostFoundByClient,
  findComplaintByThread,
  findOpenComplaintBySubject,
  updateComplaint,
  addComplaintMessage,
  addLostFoundMessage,
} from "../db";

const ALIASES: InboundAlias[] = ["criticas", "reclamacoes", "perdidos", "recursos-humanos"];
const RH_TASK_OWNER = "kamilafagundes@multipark.pt"; // tarefa de recrutamento atribuída a (Kamila Fagundes)

export type EmailSyncResult = {
  configured: boolean;
  scanned: number;
  created: number;
  skipped: number;
  errors: string[];
  byAlias: Record<string, number>;
};

function imapConfig() {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!user || !pass) return null;
  return {
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user, pass },
    logger: false as const,
  };
}

// Cria o registo no módulo de destino e devolve { module, id, taskId }.
async function routeToModule(
  alias: InboundAlias,
  parsed: ReturnType<typeof parseInboundBody>,
  ctx: {
    subject: string;
    bodyText: string;
    fromName?: string;
    fromEmail?: string;
    messageId: string;
    gmThreadId?: string | null;
    refs?: string[];
  },
): Promise<{ targetModule: string; targetId?: number; taskId?: number }> {
  const clientName = parsed.clientName || ctx.fromName || "Desconhecido";
  const desc = `${ctx.subject}\n\n${ctx.bodyText}`.trim().slice(0, 5000);

  if (alias === "criticas") {
    // Notificação do Google Business Profile: extrai estrelas + nome real do
    // avaliador + texto limpo (sem links de tracking/rodapé).
    const { parseGoogleReviewNotification } = await import("../emailParse");
    const g = parseGoogleReviewNotification(ctx.bodyText);
    // O GBP manda também notificações ADMINISTRATIVAS (recursos recusados,
    // mudanças de proprietário do perfil, verificações…) — não são críticas e
    // poluíam a lista com rating 0. Sem padrão de crítica + com padrão admin
    // → fica só em inbound_emails, sem criar avaliação.
    const haystack = `${ctx.subject}\n${ctx.bodyText}`;
    const isAdminNotice = g.rating === 0 && !g.reviewerName && (
      /recurso n[ãa]o foi aprovado/i.test(haystack) ||
      /(propriet[áa]ri[oa]s?|owner) do Perfil/i.test(haystack) ||
      /j[áa] pode gerir o Perfil/i.test(haystack) ||
      /perfil da empresa/i.test(haystack) ||
      /valide|verifica[çc][ãa]o do perfil/i.test(haystack)
    );
    if (isAdminNotice) {
      return { targetModule: "ignored" };
    }
    const reviewer = g.reviewerName || clientName;
    const text = g.rating > 0 || g.reviewerName
      ? `${ctx.subject}\n\n${g.cleanText}`.trim().slice(0, 5000)
      : desc;
    const id = await createGoogleReview({
      reviewerName: reviewer,
      reviewerEmail: parsed.clientEmail,
      rating: g.rating,
      reviewText: text,
      vehiclePlate: parsed.vehiclePlate,
      status: "pending_response",
      sourceEmailId: ctx.messageId,
      importedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
    } as any);
    // resposta IA best-effort (não bloqueia)
    if (id) {
      try {
        const { invokeLLM } = await import("../_core/llm");
        const resp = await invokeLLM({
          messages: [
            { role: "system", content: "És o gestor de atendimento de um parque de estacionamento premium. Responde a críticas de clientes de forma calorosa e profissional, em português. Máximo 3 frases." },
            { role: "user", content: `Crítica de ${reviewer}${g.rating ? ` (${g.rating} estrelas)` : ""}: "${text.slice(0, 800)}". Gera uma resposta.` },
          ],
        });
        const aiText = typeof resp?.choices?.[0]?.message?.content === "string" ? resp.choices[0].message.content : "";
        if (aiText) await updateGoogleReview(id, { aiResponse: aiText, status: "ai_responded" });
      } catch { /* LLM opcional */ }
    }
    return { targetModule: "review", targetId: id };
  }

  if (alias === "reclamacoes") {
    // Agrupa respostas/emails repetidos na MESMA reclamação. Ordem de sinais:
    //  1) thread do Gmail / referências (resposta ao mesmo email — o mais fiável)
    //  2) email do cliente (corpo) ou remetente / matrícula
    //  3) assunto normalizado (resposta reencaminhada que perdeu o thread)
    const existing =
      (await findComplaintByThread({ gmThreadId: ctx.gmThreadId, refs: ctx.refs })) ||
      (await findComplaintByClientSignals(parsed.clientEmail || ctx.fromEmail, parsed.vehiclePlate, clientName)) ||
      (await findOpenComplaintBySubject(ctx.subject));
    if (existing) {
      await addComplaintMessage({
        complaintId: existing.id,
        message: `📧 ${ctx.subject}\n\n${ctx.bodyText}`.trim().slice(0, 5000),
        isInternal: 0,
        authorName: clientName,
      } as any);
      // Uma nova mensagem do cliente reabre uma reclamação resolvida/fechada.
      if (existing.complaintStatus === "resolved" || existing.complaintStatus === "closed") {
        try { await updateComplaint(existing.id, { complaintStatus: "analyzing", resolvedAt: null } as any); } catch { /* best-effort */ }
      }
      return { targetModule: "complaint", targetId: existing.id };
    }
    // Auto-anexa a reserva: com matrícula/email/nome vai à nossa BD buscar a
    // reserva mais recente do cliente — reservationRef=externalId liga logo o
    // histórico da reserva e os condutores no detalhe.
    const booking = await findRecentBookingByClientSignals(
      parsed.clientEmail || ctx.fromEmail, parsed.vehiclePlate, clientName,
    );
    const id = await createComplaint({
      title: (ctx.subject || "Reclamação por email").slice(0, 255),
      description: desc,
      complaintType: "other",
      complaintStatus: "new",
      complaintPriority: "medium",
      clientName,
      clientEmail: parsed.clientEmail ?? (booking?.clientEmail || undefined),
      clientPhone: parsed.clientPhone ?? (booking?.clientPhone || undefined),
      vehiclePlate: parsed.vehiclePlate ?? (booking?.licensePlate || undefined),
      reservationRef: parsed.bookingRef ?? (booking?.externalId || undefined),
      reservationStart: booking?.checkIn ?? undefined,
      reservationEnd: booking?.checkOut ?? undefined,
    } as any);
    return { targetModule: "complaint", targetId: id };
  }

  if (alias === "perdidos") {
    const existing = await findOpenLostFoundByClient(parsed.clientEmail || ctx.fromEmail, parsed.vehiclePlate);
    if (existing) {
      await addLostFoundMessage({
        itemId: existing.id,
        userId: await getSystemUserId(),
        userName: clientName,
        message: `📧 ${ctx.subject}\n\n${ctx.bodyText}`.trim().slice(0, 5000),
        isInternal: 0,
      } as any);
      return { targetModule: "lostfound", targetId: existing.id };
    }
    const id = await createLostFoundItem({
      clientName,
      clientEmail: parsed.clientEmail,
      clientPhone: parsed.clientPhone,
      vehiclePlate: parsed.vehiclePlate,
      bookingRef: parsed.bookingRef,
      itemType: "other",
      description: desc || "(sem descrição)",
      status: "new",
      priority: "medium",
      createdBy: await getSystemUserId(),
    } as any);
    return { targetModule: "lostfound", targetId: id ?? undefined };
  }

  // recursos-humanos → tarefa de recrutamento para a Kamila (o email fica
  // guardado em inbound_emails para a aba "Recrutamento" do RH).
  const systemUser = await getSystemUserId();
  const taskId = await createTask({
    title: `Recrutamento: ${(ctx.subject || clientName).slice(0, 200)}`,
    description: desc,
    createdById: systemUser,
    taskStatus: "todo",
    taskPriority: "medium",
  } as any);
  try {
    const emp = await findEmployeeByEmailOrName(RH_TASK_OWNER);
    if (emp && taskId) await assignTaskToEmployee(taskId, emp.id);
  } catch { /* atribuição best-effort */ }
  return { targetModule: "rh", taskId };
}

export async function runEmailInboundSync(opts?: { sinceDays?: number }): Promise<EmailSyncResult> {
  const result: EmailSyncResult = { configured: false, scanned: 0, created: 0, skipped: 0, errors: [], byAlias: {} };
  const cfg = imapConfig();
  if (!cfg) {
    result.errors.push("IMAP não configurado (faltam IMAP_USER/IMAP_PASS)");
    return result;
  }
  result.configured = true;
  const sinceDays = opts?.sinceDays ?? Number(process.env.IMAP_SINCE_DAYS || 30);

  const client = new ImapFlow(cfg);
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    for (const alias of ALIASES) {
      // Gmail raw search: só emails entregues a este alias, dentro da janela.
      let uids: number[] = [];
      try {
        uids = (await client.search(
          { gmraw: `deliveredto:${alias}@multipark.pt newer_than:${sinceDays}d` },
          { uid: true },
        )) || [];
      } catch (e: any) {
        result.errors.push(`search ${alias}: ${e?.message ?? e}`);
        continue;
      }
      for (const uid of uids) {
        result.scanned++;
        try {
          const msg = await client.fetchOne(uid, { source: true, threadId: true }, { uid: true });
          if (!msg || !msg.source) { result.skipped++; continue; }
          const mail = await simpleParser(msg.source as Buffer);
          const messageId = mail.messageId || `uid:${alias}:${uid}`;
          // Thread do Gmail + referências de cabeçalho (p/ agrupar respostas).
          const gmThreadId = (msg as any).threadId ? String((msg as any).threadId) : null;
          const refsRaw = mail.references
            ? (Array.isArray(mail.references) ? mail.references : [mail.references])
            : [];
          const refs = [...(mail.inReplyTo ? [mail.inReplyTo] : []), ...refsRaw]
            .flatMap(r => String(r).split(/\s+/))
            .map(r => r.trim())
            .filter(Boolean);
          const headerRefs = refs.length ? refs.join(" ").slice(0, 4000) : null;

          // dedup
          const existing = await getInboundEmailByMessageId(messageId);
          if (existing) { result.skipped++; continue; }

          const fromAddr = mail.from?.value?.[0];
          const fromName = fromAddr?.name || undefined;
          const fromEmail = fromAddr?.address || undefined;
          const subject = mail.subject || "";

          // ignora ruído de sistema (confirmações de encaminhamento, etc.)
          if (isSystemEmail(fromEmail, subject)) {
            await createInboundEmail({
              messageId, alias, fromName, fromEmail, subject,
              status: "skipped", processedAt: now(),
            } as any);
            result.skipped++;
            continue;
          }

          const htmlText = typeof mail.html === "string" ? mail.html.replace(/<[^>]+>/g, " ") : "";
          const bodyText = (mail.text || htmlText || "").slice(0, 20000);
          const parsed = parseInboundBody(bodyText);
          const attachments = (mail.attachments || []).map((a) => ({
            filename: a.filename, contentType: a.contentType, size: a.size,
          }));

          const routed = await routeToModule(alias, parsed, {
            subject, bodyText, fromName, fromEmail, messageId, gmThreadId, refs,
          });

          await createInboundEmail({
            messageId, alias, fromName, fromEmail,
            clientName: parsed.clientName, clientEmail: parsed.clientEmail,
            clientPhone: parsed.clientPhone, vehiclePlate: parsed.vehiclePlate,
            bookingRef: parsed.bookingRef,
            subject, bodyText,
            attachmentsJson: attachments.length ? JSON.stringify(attachments) : null,
            targetModule: routed.targetModule, targetId: routed.targetId ?? null,
            taskId: routed.taskId ?? null,
            gmThreadId, headerRefs,
            status: "processed",
            receivedAt: mail.date ? new Date(mail.date).toISOString().slice(0, 19).replace("T", " ") : null,
            processedAt: now(),
          } as any);

          result.created++;
          result.byAlias[alias] = (result.byAlias[alias] || 0) + 1;
        } catch (e: any) {
          result.errors.push(`${alias} uid ${uid}: ${String(e?.message ?? e).slice(0, 160)}`);
        }
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return result;
}

function now(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Scheduler in-process para o servidor Railway: corre o sync de emails a cada
 * 15 minutos. Substitui o cron do GitHub Actions (workflow removido a 14/jul,
 * que deixou o email-inbound só com botões manuais). Self-skip quando o IMAP
 * não está configurado — seguro arrancar em qualquer ambiente.
 */
export function startEmailInboundScheduler() {
  const INTERVAL_MS = 15 * 60 * 1000;
  const run = async () => {
    try {
      const r = await runEmailInboundSync();
      if (r.errors.length && r.errors[0].includes("IMAP não configurado")) {
        console.log("[EmailInbound] Skipped — IMAP não configurado");
        return;
      }
      console.log(`[EmailInbound] scanned=${r.scanned} created=${r.created} skipped=${r.skipped} errors=${r.errors.length}`);
    } catch (err: any) {
      console.error("[EmailInbound] erro:", err?.message ?? err);
    }
  };
  setTimeout(run, 30_000); // arranque suave, depois de o servidor estabilizar
  setInterval(run, INTERVAL_MS);
  console.log("[EmailInbound] Scheduler started — runs every 15 minutes");
}
