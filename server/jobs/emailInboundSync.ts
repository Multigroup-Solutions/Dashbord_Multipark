// server/jobs/emailInboundSync.ts
// Leitor IMAP da caixa reservas@multipark.pt. Lê os emails que o backoffice
// REENCAMINHA para os aliases temáticos e cria o registo no módulo certo:
//   criticas@        → Google Reviews   (createGoogleReview + resposta IA)
//   reclamacoes@     → Reclamações      (createComplaint)
//   perdidos@        → Perdidos&Achados (createLostFoundItem)
//   recursos-humanos@→ inbound_emails (aba Recrutamento; os Leads de Extras
//                      tratam-nos). Só respostas de disponibilidade que
//                      precisam de decisão humana viram tarefa (1 por pessoa × semana).
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
  isReservationNotification,
  parseInboundBody,
  type InboundAlias,
} from "../emailParse";
import { matchBookingForComplaint, autoLinkComplaintBooking, autoLinkLostFoundBooking } from "../complaintDossier";
import {
  createGoogleReview,
  updateGoogleReview,
  createComplaint,
  createLostFoundItem,
  claimInboundEmail,
  updateInboundEmail,
  deleteInboundEmail,
  addComplaintPhoto,
  getComplaintById,
  listExistingInboundMessageIds,
  getSystemUserId,
  findComplaintByClientSignals,
  findOpenLostFoundByClient,
  findComplaintByThread,
  findOpenComplaintBySubject,
  updateComplaint,
  addComplaintMessage,
  addLostFoundMessage,
} from "../db";
import {
  clientSignalEmail,
  complaintSlaDeadline,
  htmlToPlainText,
  isGenericSenderName,
  isLivroReclamacoes,
  parseComplaintCaseTag,
  COMPLAINT_DEFAULT_SLA_HOURS,
} from "../complaintEmail";

export type InboundAttachment = { filename?: string; contentType?: string; size?: number; url?: string; key?: string };

const ALIASES: InboundAlias[] = ["criticas", "reclamacoes", "perdidos", "recursos-humanos", "campanhas", "ocorrencias"];

export type EmailSyncResult = {
  configured: boolean;
  scanned: number;
  created: number;
  skipped: number;
  errors: string[];
  byAlias: Record<string, number>;
  /** true = parou no orçamento de tempo (Vercel 60s); o resto fica p/ a próxima corrida (dedup por messageId). */
  partial: boolean;
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
): Promise<{ targetModule: string; targetId?: number; taskId?: number; isNew?: boolean }> {
  // O remetente do cabeçalho é muitas vezes o BACKOFFICE que reencaminha
  // (reservas@/info@ "Multipark") — só conta como cliente se for externo e
  // com nome próprio; senão os reencaminhamentos misturavam clientes.
  const senderEmail = clientSignalEmail(ctx.fromEmail);
  const senderName = senderEmail && !isGenericSenderName(ctx.fromName) ? ctx.fromName?.trim() : undefined;
  const bodyName = parsed.clientName && !isGenericSenderName(parsed.clientName) ? parsed.clientName.trim() : undefined;
  const clientName = bodyName || senderName || "Desconhecido";
  const clientEmail = clientSignalEmail(parsed.clientEmail) || senderEmail;
  let desc = `${ctx.subject}\n\n${ctx.bodyText}`.trim().slice(0, 5000);

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
      /valide|verifica[çc][ãa]o do perfil/i.test(haystack) ||
      /adicione fotos/i.test(haystack) ||
      /relat[óo]rio de desempenho/i.test(haystack) ||
      /convite para gerir/i.test(haystack) ||
      /pedido de propriedade/i.test(haystack) ||
      /ficha de empresa.*publicada/i.test(haystack) ||
      /est[áa] a receber aten[çc][ãa]o/i.test(haystack)
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

  // Faturação automática de parceiros (ex.: "Auto-fatura" mensal do
  // Parkimeter) não é reclamação nem perdido — fica só em inbound_emails.
  // (Já criou 4 falsos casos de Perdidos por mês.)
  if (
    (alias === "reclamacoes" || alias === "perdidos") &&
    /^\s*((re|fwd?|enc):\s*)*auto-?fatura/i.test(ctx.subject || "")
  ) {
    return { targetModule: "ignored" };
  }

  if (alias === "reclamacoes") {
    // Ecos INTERNOS (acknowledgments da própria Multipark: "agradecemos o
    // vosso email… foi encaminhado…") não são reclamações — auditoria 6 ago
    if (
      /@(multipark|skypark)\.(pt|app)$/i.test(ctx.fromEmail ?? "") &&
      /agradecer o vosso (e-?mail|contacto)|foi encaminhad[oa]|ser[áa] analisad[oa] pelos servi[çc]os/i.test(ctx.bodyText)
    ) {
      return { targetModule: "ignored" };
    }

    // Notificações automáticas "Nova Reserva" enviadas DIRETAMENTE pelo
    // sistema (info@) não são reclamações — um forward humano (Fwd: de outra
    // pessoa) passa, porque pode trazer contexto de uma queixa.
    if (
      isReservationNotification(ctx.subject) &&
      /@(multipark|skypark)\.(pt|app)$/i.test(ctx.fromEmail ?? "")
    ) {
      return { targetModule: "ignored" };
    }
    // Agrupa respostas/emails repetidos na MESMA reclamação. Ordem de sinais:
    //  0) etiqueta [REC-<id>] no assunto (as nossas respostas levam-na)
    //  1) thread do Gmail / referências (resposta ao mesmo email — o mais fiável)
    //  2) email do cliente / matrícula / nome — só casos ABERTOS recentes e
    //     nunca com endereços internos ou nomes genéricos ("Multipark")
    //  3) assunto normalizado (resposta reencaminhada que perdeu o thread)
    const taggedId = parseComplaintCaseTag(ctx.subject);
    const existing =
      (taggedId ? await getComplaintById(taggedId) : null) ||
      (await findComplaintByThread({ gmThreadId: ctx.gmThreadId, refs: ctx.refs })) ||
      (await findComplaintByClientSignals(clientEmail, parsed.vehiclePlate, clientName)) ||
      (await findOpenComplaintBySubject(ctx.subject));
    if (existing) {
      await addComplaintMessage({
        complaintId: existing.id,
        message: `📧 ${ctx.subject}\n\n${ctx.bodyText}`.trim().slice(0, 5000),
        isInternal: 0,
        authorName: (clientName || "").slice(0, 200) || null,
      } as any);
      // Uma nova mensagem do cliente reabre uma reclamação resolvida/fechada.
      if (existing.complaintStatus === "resolved" || existing.complaintStatus === "closed") {
        try { await updateComplaint(existing.id, { complaintStatus: "analyzing", resolvedAt: null } as any); } catch { /* best-effort */ }
      }
      // Se ainda não tem reserva ligada, o email novo pode trazer sinais
      // suficientes — tenta ligar agora.
      if (!existing.reservationRef) {
        try { await autoLinkComplaintBooking(existing.id); } catch { /* best-effort */ }
      }
      return { targetModule: "complaint", targetId: existing.id, isNew: false };
    }
    // Auto-anexa a reserva DE QUE O CLIENTE SE QUEIXA: ref explícita do email
    // ganha; senão matrícula/email/telefone/nome ancorados na data de hoje
    // (evita apanhar uma reserva futura já marcada).
    const match = await matchBookingForComplaint({
      reservationRef: parsed.bookingRef,
      vehiclePlate: parsed.vehiclePlate,
      clientEmail,
      clientPhone: parsed.clientPhone,
      clientName,
    });
    const booking = match?.booking ?? null;
    // Livro de Reclamações oficial (nº ROR…): prazo legal de resposta —
    // entra logo como URGENTE. SLA igual ao da criação manual (48h por
    // omissão do formulário) — não há no código um prazo próprio para o ROR.
    const isLivro = isLivroReclamacoes(ctx.subject, ctx.bodyText);
    const id = await createComplaint({
      title: (ctx.subject || "Reclamação por email").slice(0, 255),
      description: desc,
      complaintType: "other",
      complaintStatus: "new",
      complaintPriority: isLivro ? "urgent" : "medium",
      clientName: clientName.slice(0, 200),
      clientEmail: clientEmail ?? (booking?.clientEmail || undefined),
      clientPhone: parsed.clientPhone ?? (booking?.clientPhone || undefined),
      vehiclePlate: parsed.vehiclePlate ?? (booking?.licensePlate || undefined),
      reservationRef: parsed.bookingRef ?? (booking?.externalId || undefined),
      reservationStart: booking?.checkIn ?? undefined,
      reservationEnd: booking?.checkOut ?? undefined,
      projectId: booking?.projectId ?? undefined,
      slaDeadline: complaintSlaDeadline(COMPLAINT_DEFAULT_SLA_HOURS),
    } as any);
    return { targetModule: "complaint", targetId: id, isNew: true };
  }

  if (alias === "perdidos") {
    const existing = await findOpenLostFoundByClient(clientEmail, parsed.vehiclePlate);
    if (existing) {
      await addLostFoundMessage({
        itemId: existing.id,
        userId: await getSystemUserId(),
        userName: clientName,
        message: `📧 ${ctx.subject}\n\n${ctx.bodyText}`.trim().slice(0, 5000),
        isInternal: 0,
      } as any);
      // Sem reserva ligada? O email novo pode trazer sinais suficientes.
      if (!existing.bookingRef) {
        try { await autoLinkLostFoundBooking(existing.id); } catch { /* best-effort */ }
      }
      return { targetModule: "lostfound", targetId: existing.id };
    }
    // Auto-anexa a reserva de que o cliente fala (ref explícita ganha; senão
    // matrícula/email/telefone/nome ancorados na data de hoje).
    const lfMatch = await matchBookingForComplaint({
      reservationRef: parsed.bookingRef,
      vehiclePlate: parsed.vehiclePlate,
      clientEmail: clientEmail,
      clientPhone: parsed.clientPhone,
      clientName,
    });
    const lfBooking = lfMatch?.booking ?? null;
    // Reclamação ABERTA do mesmo cliente: mesma reserva → o email junta-se à
    // reclamação (não duplica); só o mesmo cliente/matrícula → cria o perdido
    // mas fica "relacionado com reclamação #".
    const lfRef = parsed.bookingRef ?? lfBooking?.externalId ?? null;
    const openComplaint = await findComplaintByClientSignals(clientEmail, parsed.vehiclePlate ?? lfBooking?.licensePlate, clientName);
    if (openComplaint && lfRef && openComplaint.reservationRef && openComplaint.reservationRef === lfRef) {
      await addComplaintMessage({
        complaintId: openComplaint.id,
        message: `📦 Email para perdidos@ (possível objeto perdido) — ${ctx.subject}\n\n${ctx.bodyText}`.trim().slice(0, 5000),
        isInternal: 0,
        authorName: (clientName || "").slice(0, 200) || null,
      } as any);
      return { targetModule: "complaint", targetId: openComplaint.id, isNew: false };
    }
    const id = await createLostFoundItem({
      clientName,
      clientEmail: clientEmail ?? (lfBooking?.clientEmail || undefined),
      clientPhone: parsed.clientPhone ?? (lfBooking?.clientPhone || undefined),
      vehiclePlate: parsed.vehiclePlate ?? (lfBooking?.licensePlate || undefined),
      bookingRef: parsed.bookingRef ?? (lfBooking?.externalId || undefined),
      projectId: lfBooking?.projectId ?? undefined,
      relatedComplaintId: openComplaint?.id ?? undefined,
      itemType: "other",
      description: desc || "(sem descrição)",
      status: "new",
      priority: "medium",
      createdBy: await getSystemUserId(),
    } as any);
    return { targetModule: "lostfound", targetId: id ?? undefined };
  }

  // ocorrencias → OCORRÊNCIA a partir do email do painel Multipark (o Jorge
  // reencaminha; futuramente alias + regra automática). O corpo completo fica
  // em inbound_emails para afinar o parser ao formato real.
  if (alias === "ocorrencias") {
    // Formato REAL do email do painel (visto 6 ago):
    //   De: Sky Park <info@multipark.pt>
    //   Date: sexta, 31/07/2026 à(s) 10:37
    //   Tipo de ocorrência: *Outros*
    //   *Localização do carro:* https://…maps…query=41.23,-8.67
    //   *Matricula do carro:* 0173NFM
    //   Observações: …
    const body = ctx.bodyText;
    const typeM = body.match(/Tipo de ocorr[êe]ncia:\s*\*?\s*([^*\n]+?)\s*\*?\s*$/im);
    const rawType = (typeM?.[1] ?? "").trim().toLowerCase();
    const TYPE_MAP: Record<string, { t: string; s: string }> = {
      "outros": { t: "outro", s: "medium" },
      "outro": { t: "outro", s: "medium" },
      "dano": { t: "dano", s: "high" },
      "danos": { t: "dano", s: "high" },
      "vidro": { t: "vidro_aberto", s: "medium" },
      "vidro aberto": { t: "vidro_aberto", s: "medium" },
      "mal estacionado": { t: "mal_estacionado", s: "medium" },
      "chave": { t: "chave_errada", s: "medium" },
      "chave errada": { t: "chave_errada", s: "medium" },
      "combustivel": { t: "combustivel", s: "medium" },
      "combustível": { t: "combustivel", s: "medium" },
      "limpeza": { t: "limpeza", s: "low" },
      "documentos": { t: "documentos", s: "low" },
    };
    let mapped = TYPE_MAP[rawType];
    // Sem tipo útil ("Outros") tenta classificar pelas observações
    const obsM = body.match(/Observa[çc][õo]es:\s*([\s\S]*?)(?:\n{3,}|$)/i);
    const obs = (obsM?.[1] ?? "").trim();
    if ((!mapped || mapped.t === "outro") && obs) {
      const low = obs.toLowerCase();
      if (/dano|amassad|risc|batid|embat|colis|raspad|partid/.test(low)) mapped = { t: "dano", s: "high" };
      else if (/vidro|janela/.test(low)) mapped = { t: "vidro_aberto", s: "medium" };
      else if (/chav/.test(low)) mapped = { t: "chave_errada", s: "medium" };
      else if (/combust|gasolina|gas[oó]leo/.test(low)) mapped = { t: "combustivel", s: "medium" };
      else if (/suj|limpez|nodoa|mancha/.test(low)) mapped = { t: "limpeza", s: "low" };
    }
    const plateM = body.match(/Matr[ií]cula do carro:\s*\*?\s*([A-Z0-9-]{4,10})/i)
      ?? body.toUpperCase().match(/([A-Z]{2}-\d{2}-[A-Z0-9]{2}|\d{2}-[A-Z]{2}-\d{2}|\d{2}-\d{2}-[A-Z]{2})/);
    const gpsM = body.match(/query=(-?\d+\.\d+),(-?\d+\.\d+)/);
    const parkM = body.match(/^\s*De:\s*([^<\n]+?)\s*</im);
    // Data REAL da ocorrência (linha Date do forward): "sexta, 31/07/2026 à(s) 10:37"
    const dateM = body.match(/(\d{2})\/(\d{2})\/(\d{4})[^\d]{1,8}(\d{1,2}):(\d{2})/);
    const srcDate = dateM
      ? `${dateM[3]}-${dateM[2]}-${dateM[1]} ${dateM[4].padStart(2, "0")}:${dateM[5]}:00`
      : undefined;
    const cuidM = body.match(/c[a-z0-9]{20,30}/);
    const descParts = [
      obs || ctx.subject,
      parkM ? `Parque: ${parkM[1].trim()}` : null,
      rawType && !TYPE_MAP[rawType] ? `Tipo (Multipark): ${typeM![1].trim()}` : null,
    ].filter(Boolean);
    const { createIncident } = await import("../db");
    const { lisbonLocalToUtc } = await import("../../shared/caseRules");
    // A linha "Date" do forward é hora de LISBOA → grava-se em UTC.
    const srcDateUtc = srcDate ? lisbonLocalToUtc(srcDate) ?? undefined : undefined;
    const plate = plateM ? plateM[1].toUpperCase() : undefined;
    const bookingRefOcc = cuidM ? cuidM[0] : undefined;
    const { findDuplicateIncident, appendIncidentNote, deriveBookingForCase } = await import("../caseOps");
    // Dedup por CONTEÚDO (o mesmo email reencaminhado 2x tem messageId novo) e
    // contra a sincronização dos remarks Multipark: mesma matrícula + reserva
    // compatível + ±2h → fica como NOTA na ocorrência existente.
    if (plate && srcDateUtc) {
      const dup = await findDuplicateIncident({ plate, bookingRef: bookingRefOcc, atUtc: srcDateUtc });
      if (dup) {
        try {
          const { getIncidentById } = await import("../db");
          const cur = await getIncidentById(dup.id);
          const marker = `(email ${String(ctx.messageId).slice(0, 60)})`;
          const sameText = (cur?.description ?? "").trim() === descParts.join("\n").slice(0, 5000).trim();
          if (!sameText && !(cur?.resolution ?? "").includes(marker)) {
            await appendIncidentNote(dup.id, "Email", `${descParts.join(" · ").slice(0, 1500)} ${marker}`);
          }
        } catch { /* best-effort */ }
        return { targetModule: "incident_dup", targetId: dup.id };
      }
    }
    // Cidade da ocorrência = cidade da reserva (ref do email ou matrícula+data).
    const occBooking = await deriveBookingForCase({ bookingRef: bookingRefOcc, plate, atUtc: srcDateUtc ?? null });
    const id = await createIncident({
      incidentType: (mapped?.t ?? "outro") as any,
      severity: (mapped?.s ?? "medium") as any,
      description: descParts.join("\n").slice(0, 5000),
      vehiclePlate: plate,
      reservationLink: occBooking?.externalId ?? bookingRefOcc,
      projectId: occBooking?.projectId ?? undefined,
      gpsLatitude: gpsM ? gpsM[1] : undefined,
      gpsLongitude: gpsM ? gpsM[2] : undefined,
      status: "open",
      reportedBy: await getSystemUserId(),
      sourceEmailId: ctx.messageId?.slice(0, 100),
      ...(srcDateUtc ? { sourceEmailDate: srcDateUtc } : {}),
    } as any);
    return { targetModule: "incident", targetId: id ?? undefined };
  }

  // ── "SIM" automático (pedido Jorge): resposta de um extra ao pedido de
  // disponibilidade marca-o logo disponível naquela data/turno/horas. As
  // respostas chegam aqui porque o pedido sai de recursos-humanos@. Só depois
  // é que o resto vira tarefa de recrutamento.
  // Só para recursos-humanos@ (ocorrências/perdidos são classificados antes)
  if (alias === "recursos-humanos") try {
    const { matchPendingAvailabilityReply, markDayAvailability } = await import("../extrasAvailability");
    const pending = ctx.fromEmail ? await matchPendingAvailabilityReply(ctx.fromEmail) : null;
    // Classificação com NEGAÇÃO (server/availabilityReply.ts): só um "sim"
    // limpo marca; "não posso", condicionais e ambíguos ficam para revisão
    // humana (tarefa de RH com o veredicto anotado). Usa só o CORPO, não o assunto.
    const { classifyAvailabilityReply } = await import("../availabilityReply");
    const verdict = pending ? classifyAvailabilityReply(ctx.bodyText || desc || "") : null;
    const availabilityTask = async (label: string, detail: string) => {
      const { upsertAvailabilityTask } = await import("../tasksService");
      const day = pending!.weekStart ?? pending!.targetDate;
      if (!day) return null;
      const r = await upsertAvailabilityTask({
        employeeId: pending!.employeeId,
        day,
        detail: `[${label}] ${detail}${ctx.subject ? `\nAssunto: ${ctx.subject}` : ""}`,
      });
      return r.taskId;
    };
    if (pending && verdict && verdict.verdict !== "yes") {
      // não marca disponibilidade; UMA tarefa por pessoa × semana para decisão humana
      desc = `[DISPONIBILIDADE ${verdict.verdict === "no" ? "NÃO" : "A CONFIRMAR"} — ${verdict.reason}] ${pending.targetDate ?? pending.weekStart ?? ""} ${pending.shift ?? ""}: "${verdict.excerpt}"`.trim() + (desc ? `\n\n${desc}` : "");
      const taskId = await availabilityTask(verdict.verdict === "no" ? "Respondeu NÃO" : "Resposta pouco clara", desc.slice(0, 3000));
      if (taskId) return { targetModule: "availability_task", targetId: pending.employeeId, taskId };
    }
    const saidYes = verdict?.verdict === "yes";
    if (pending && saidYes) {
      const shiftNote = pending.shift === "morning" ? "manhã" : pending.shift === "afternoon" ? "tarde" : pending.shift === "night" ? "noite" : null;
      if (pending.targetDate) {
        await markDayAvailability(pending.employeeId, pending.targetDate, {
          // Turnos do extras-dia são manhã/noite; a tarde conta como manhã e
          // fica anotada. "que horas podes?" com só "sim" fica manhã + nota.
          morning: pending.shift !== "night",
          night: pending.shift === "night",
          fromHour: pending.fromHour,
          toHour: pending.toHour,
          note: `respondeu SIM por email${shiftNote ? ` (turno da ${shiftNote})` : ""}${pending.kind === "day_hours" ? " — horas por confirmar" : ""}`,
        });
        return { targetModule: "availability", targetId: pending.employeeId };
      }
      // pedido da semana inteira: o "sim" não diz que dias — fica em tarefa
      // "Disponibilidade a confirmar" (não dá para adivinhar os dias).
      const taskId = await availabilityTask("Respondeu SIM à semana inteira — confirmar dias", `"${verdict!.excerpt}"`);
      if (taskId) return { targetModule: "availability_task", targetId: pending.employeeId, taskId };
    }
  } catch (err) {
    console.warn("[inbound] verificação de resposta de disponibilidade falhou:", err);
  }

  // recursos-humanos → já NÃO cria tarefa de recrutamento: o email fica em
  // inbound_emails (aba "Recrutamento") e os Leads de Extras tratam-no.
  return { targetModule: "rh" };
}

/**
 * Pós-processamento de um email ligado a uma reclamação (best-effort, nunca
 * lança):
 *  - anexos: imagens → complaint_photos (aparecem na aba Fotos); os restantes
 *    ficam em inbound_emails.attachmentsJson e aparecem como links no detalhe;
 *  - reclamação NOVA: alerta in-app (notifyComplaintCreated) + aviso de
 *    receção automático ao cliente (1×, [REC-<id>], COMPLAINT_AUTO_ACK=off
 *    desliga).
 */
async function afterComplaintEmail(
  complaintId: number,
  ctx: { isNew: boolean; attachments: InboundAttachment[]; messageId: string; fromEmail?: string },
): Promise<void> {
  try {
    const systemUser = await getSystemUserId().catch(() => undefined);
    for (const a of ctx.attachments) {
      if (!a.url || !String(a.contentType || "").toLowerCase().startsWith("image/")) continue;
      if (a.url.length > 500) continue;
      await addComplaintPhoto({
        complaintId,
        url: a.url,
        fileKey: (a.key || a.url).slice(0, 500),
        label: `Email: ${a.filename || "imagem"}`.slice(0, 100),
        uploadedById: systemUser ?? null,
      } as any);
    }
  } catch (err) {
    console.warn("[EmailInbound] cópia de anexos para a reclamação falhou:", err);
  }
  if (!ctx.isNew) return;
  try {
    const { notifyComplaintCreated } = await import("../complaintsExtended");
    await notifyComplaintCreated(complaintId);
  } catch (err) {
    console.warn("[EmailInbound] notificação de reclamação falhou:", err);
  }
  try {
    const c = await getComplaintById(complaintId);
    // In-Reply-To só quando o email veio DIRETAMENTE do cliente (num
    // reencaminhamento o Message-ID é do backoffice, não do cliente).
    const direct = !!c?.clientEmail && !!ctx.fromEmail && c.clientEmail.toLowerCase() === ctx.fromEmail.toLowerCase();
    const { sendComplaintAutoAck } = await import("../complaintsExtended");
    const r = await sendComplaintAutoAck(complaintId, {
      inReplyTo: direct && !ctx.messageId.startsWith("uid:") ? ctx.messageId : null,
    });
    if (!r.sent && r.reason && r.reason !== "sem email externo do cliente") {
      console.log(`[EmailInbound] aviso de receção #${complaintId} não enviado: ${r.reason}`);
    }
  } catch (err) {
    console.warn("[EmailInbound] aviso de receção falhou:", err);
  }
}

export async function runEmailInboundSync(opts?: { sinceDays?: number; deadlineAt?: number }): Promise<EmailSyncResult> {
  const result: EmailSyncResult = { configured: false, scanned: 0, created: 0, skipped: 0, errors: [], byAlias: {}, partial: false };
  const cfg = imapConfig();
  if (!cfg) {
    result.errors.push("IMAP não configurado (faltam IMAP_USER/IMAP_PASS)");
    return result;
  }
  result.configured = true;
  const sinceDays = opts?.sinceDays ?? Number(process.env.IMAP_SINCE_DAYS || 30);
  // Sem deadline (Railway/manual) corre até ao fim; no Vercel o endpoint passa
  // um prazo < maxDuration para nunca morrer com 504 a meio de um email.
  const deadlineAt = opts?.deadlineAt ?? Number.POSITIVE_INFINITY;

  const client = new ImapFlow(cfg);
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    for (const alias of ALIASES) {
      if (Date.now() > deadlineAt) { result.partial = true; break; }
      // Gmail raw search: só emails entregues a este alias, dentro da janela.
      let uids: number[] = [];
      try {
        // "ocorrencias": além do alias próprio, apanha REENCAMINHADOS para a
        // caixa principal com "ocorrência" no assunto (o Jorge reencaminha o
        // email do painel Multipark até o alias existir / a regra automática)
        const gmQuery = alias === "ocorrencias"
          ? `newer_than:${sinceDays}d {deliveredto:ocorrencias@multipark.pt subject:ocorrencia subject:ocorrência subject:ocorrencias subject:ocorrências}`
          : `deliveredto:${alias}@multipark.pt newer_than:${sinceDays}d`;
        uids = (await client.search(
          { gmraw: gmQuery },
          { uid: true },
        )) || [];
      } catch (e: any) {
        result.errors.push(`search ${alias}: ${e?.message ?? e}`);
        continue;
      }
      // Pré-triagem BARATA: só envelopes (messageId) + dedup em lote na BD,
      // antes de descarregar qualquer corpo. Sem isto, cada corrida gastava o
      // orçamento de 45s a re-descarregar as mesmas dezenas de emails já
      // processados e nunca progredia para os aliases seguintes.
      const uidToMessageId = new Map<number, string>();
      let known = new Set<string>();
      try {
        if (uids.length > 0) {
          const envs = await client.fetchAll(uids.join(","), { envelope: true }, { uid: true });
          for (const e of envs as any[]) {
            uidToMessageId.set(e.uid, e.envelope?.messageId || `uid:${alias}:${e.uid}`);
          }
          known = await listExistingInboundMessageIds([...uidToMessageId.values()]);
        }
      } catch (e: any) {
        // Sem pré-triagem o dedup por-uid (abaixo) continua correto — só lento.
        console.warn(`[EmailInbound] pré-triagem ${alias} falhou:`, String(e?.message ?? e).slice(0, 120));
      }

      for (const uid of uids) {
        if (Date.now() > deadlineAt) { result.partial = true; break; }
        const preId = uidToMessageId.get(uid);
        if (preId && known.has(preId)) { result.skipped++; continue; }
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

          const fromAddr = mail.from?.value?.[0];
          const fromName = fromAddr?.name || undefined;
          const fromEmail = fromAddr?.address || undefined;
          const subject = mail.subject || "";
          const receivedAt = mail.date ? new Date(mail.date).toISOString().slice(0, 19).replace("T", " ") : null;

          // Dedup ATÓMICO: reserva o Message-ID (índice UNIQUE) ANTES de criar
          // o registo de destino. Duas corridas em paralelo (cron + botão)
          // nunca criam a mesma reclamação duas vezes — a 2ª leva duplicado.
          const claimId = await claimInboundEmail({
            messageId, alias, fromName, fromEmail, subject, gmThreadId, headerRefs, receivedAt,
          } as any);
          if (!claimId) { result.skipped++; continue; }

          let routedOk = false;
          try {
            // Relatório diário de campanhas por email: DESLIGADO (Jorge, 16 set
            // 2026). A fonte única do gasto é a Google Ads API; o email fica só
            // registado, sem tocar em campaign_daily_stats.
            if (alias === "campanhas") {
              await updateInboundEmail(claimId, {
                bodyText: "Ingestão por email desligada — o gasto vem da Google Ads API.",
                targetModule: "campaigns",
                status: "skipped",
                processedAt: now(),
              } as any);
              result.skipped++;
              continue;
            }

            // ignora ruído de sistema (confirmações de encaminhamento, etc.)
            if (isSystemEmail(fromEmail, subject)) {
              await updateInboundEmail(claimId, { status: "skipped", processedAt: now() } as any);
              result.skipped++;
              continue;
            }

            // HTML → texto com html-to-text (mantém quebras de linha para o
            // parsing "Etiqueta: valor", descodifica entidades, sem <style>).
            const htmlText = typeof mail.html === "string" ? htmlToPlainText(mail.html) : "";
            const bodyText = (mail.text || htmlText || "").slice(0, 20000);
            const parsed = parseInboundBody(bodyText);
            // Guarda os ficheiros no storage (antes só se registavam os nomes e o
            // conteúdo era deitado fora — impossível abrir um CV no backoffice).
            // Best-effort por anexo: falha de upload não perde o email.
            const attachments: InboundAttachment[] = [];
            for (const a of mail.attachments || []) {
              // imagens inline de assinatura/logótipo (cid:) não são anexos do cliente
              if ((a as any).related && String(a.contentType || "").startsWith("image/") && (a.size ?? 0) < 20 * 1024) continue;
              const meta: InboundAttachment = {
                filename: a.filename, contentType: a.contentType, size: a.size,
              };
              if (a.content && a.size && a.size <= 15 * 1024 * 1024) {
                try {
                  const { storagePut } = await import("../storage");
                  const safe = (a.filename || "anexo").replace(/[^\w.\-]+/g, "_").slice(0, 120);
                  const { url, key } = await storagePut(`inbound/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`, a.content, a.contentType || "application/octet-stream");
                  meta.url = url;
                  meta.key = key;
                } catch (err: any) {
                  console.warn("[EmailInbound] upload de anexo falhou:", String(err?.message ?? err).slice(0, 160));
                }
              }
              attachments.push(meta);
            }
            const attachmentsJson = attachments.length ? JSON.stringify(attachments) : null;

            const routed = await routeToModule(alias, parsed, {
              subject, bodyText, fromName, fromEmail, messageId, gmThreadId, refs,
            });
            routedOk = true;

            await updateInboundEmail(claimId, {
              clientName: parsed.clientName, clientEmail: parsed.clientEmail,
              clientPhone: parsed.clientPhone, vehiclePlate: parsed.vehiclePlate,
              bookingRef: parsed.bookingRef,
              bodyText,
              attachmentsJson,
              targetModule: routed.targetModule, targetId: routed.targetId ?? null,
              taskId: routed.taskId ?? null,
              status: "processed",
              processedAt: now(),
            } as any);

            if (routed.targetModule === "complaint" && routed.targetId) {
              await afterComplaintEmail(routed.targetId, {
                isNew: !!routed.isNew,
                attachments,
                messageId,
                fromEmail,
              });
            }
          } catch (e: any) {
            if (!routedOk) {
              // Falhou ANTES de criar o registo: liberta a reserva para a
              // próxima corrida tentar de novo.
              await deleteInboundEmail(claimId).catch(() => {});
            } else {
              // O registo já existe — nunca libertar (recriava-o); fica em erro.
              await updateInboundEmail(claimId, { status: "error", errorMsg: String(e?.message ?? e).slice(0, 500), processedAt: now() } as any).catch(() => {});
            }
            throw e;
          }

          result.created++;
          result.byAlias[alias] = (result.byAlias[alias] || 0) + 1;
        } catch (e: any) {
          // O DrizzleQueryError só traz a SQL na message; a razão real do MySQL
          // (ex.: "Data too long", "Incorrect string value") vive em e.cause.
          const cause = (e as any)?.cause?.message ? ` — ${(e as any).cause.message}` : "";
          result.errors.push(`${alias} uid ${uid}: ${String(e?.message ?? e).slice(0, 160)}${String(cause).slice(0, 200)}`);
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
 * Scheduler in-process (servidor Node persistente — `server/_core/index.ts`),
 * a cada 15 minutos. SÓ arranca com INPROCESS_SCHEDULERS=on (desligado por
 * omissão): o agendador oficial é o GitHub Actions, que chama
 * /api/cron/email-inbound DE HORA A HORA (.github/workflows/multipark-cron.yml),
 * mais o botão "Sincronizar emails". Self-skip quando o IMAP não está
 * configurado.
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
