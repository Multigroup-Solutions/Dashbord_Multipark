/**
 * D34 (Jorge, 3 out 2026): a triagem do WhatsApp PROPÕE criar o caso.
 *
 * Quando a IA classifica a conversa de um cliente como reclamação ou
 * perdido/achado, a conversa mostra "Criar reclamação / Criar perdido" e
 * "Não é". Nada é criado sozinho: só quando uma pessoa carrega. O caso nasce
 * com o nome, telefone, email e reserva ligados à conversa e com as últimas
 * mensagens do cliente; depois segue os mesmos passos de um caso criado à mão
 * (liga a reserva pelos sinais, avisa a equipa, fica no registo).
 *
 * Um caso por conversa: a conversa é reservada ANTES de criar (dois cliques ao
 * mesmo tempo não dão dois casos) e, se a criação falhar, a reserva é desfeita.
 */
import { and, eq, isNull } from "drizzle-orm";
import { whatsappConversations } from "../drizzle/schema";
import { getDb, createComplaint, createLostFoundItem, logActivity } from "./db";
import { caseDraftFromMessages, type CaseProposalKind } from "../shared/whatsappConversation";

export class CaseProposalError extends Error {
  constructor(message: string, readonly code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST") {
    super(message);
  }
}

const nowStr = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/**
 * Cria o caso proposto. Lança `CaseProposalError` com mensagem para o ecrã.
 * Cidade: a da reserva do número; sem ela, `fallbackProjectId` (a de quem só
 * vê a sua cidade — senão o caso desaparecia-lhe da lista, como no criar à mão).
 */
export async function createCaseFromConversation(
  conversationId: number,
  kind: CaseProposalKind,
  userId: number,
  fallbackProjectId: number | null,
): Promise<{ kind: CaseProposalKind; id: number }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const [conv] = await db
    .select({
      id: whatsappConversations.id,
      employeeId: whatsappConversations.employeeId,
      bookingProjectId: whatsappConversations.bookingProjectId,
      caseKind: whatsappConversations.caseKind,
      caseId: whatsappConversations.caseId,
    })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!conv) throw new CaseProposalError("Conversa não encontrada.", "NOT_FOUND");
  if (conv.employeeId != null) throw new CaseProposalError("É um colaborador — os casos são de clientes.", "BAD_REQUEST");
  if (conv.caseKind) {
    throw new CaseProposalError(
      conv.caseId ? "Já foi criado um caso a partir desta conversa." : "O caso desta conversa está a ser criado — espera um pouco.",
      "CONFLICT",
    );
  }

  // Reserva (só um ganha): caseKind preenchido, caseId ainda vazio.
  const res = await db
    .update(whatsappConversations)
    .set({ caseKind: kind, caseId: null })
    .where(and(eq(whatsappConversations.id, conversationId), isNull(whatsappConversations.caseKind)));
  if (Number((res as any)?.[0]?.affectedRows ?? 0) !== 1) {
    throw new CaseProposalError("Já foi criado um caso a partir desta conversa.", "CONFLICT");
  }

  try {
    const { getConversationThread } = await import("./whatsappInbox");
    const t = await getConversationThread(conversationId, 30);
    if (!t) throw new CaseProposalError("Conversa não encontrada.", "NOT_FOUND");
    // `messages` vem da mais recente para a mais antiga.
    const draft = caseDraftFromMessages([...t.messages].reverse().map((m) => ({ direction: m.direction, body: m.body })));
    const clientName = t.name;
    const projectId = conv.bookingProjectId ?? fallbackProjectId;
    let id: number;
    if (kind === "complaint") {
      id = Number(await createComplaint({
        title: draft.title.slice(0, 255),
        description: `${draft.description}\n\n(Criada a partir da conversa de WhatsApp #${conversationId}.)`,
        complaintType: "other",
        complaintPriority: "medium",
        complaintStatus: "new",
        clientName: clientName.slice(0, 255),
        clientEmail: t.linkedClientEmail ?? null,
        clientPhone: t.phoneE164,
        reservationRef: t.linkedBookingRef ?? null,
        projectId,
        createdById: userId,
      } as any));
      if (!id) throw new Error("A reclamação não foi gravada.");
      await logActivity({ userId, action: "create", entity: "complaint", entityId: id, details: `Reclamação a partir do WhatsApp (conversa ${conversationId}): ${draft.title}` });
      try {
        const { autoLinkComplaintBooking } = await import("./complaintDossier");
        await autoLinkComplaintBooking(id);
      } catch (err) {
        console.warn("[whatsapp case] ligar reserva falhou:", err);
      }
      try {
        const { notifyComplaintCreated } = await import("./complaintsExtended");
        await notifyComplaintCreated(id);
      } catch (err) {
        console.warn("[whatsapp case] aviso falhou:", err);
      }
    } else {
      id = Number(await createLostFoundItem({
        projectId,
        clientName: clientName.slice(0, 255),
        clientEmail: t.linkedClientEmail ?? null,
        clientPhone: t.phoneE164,
        bookingRef: t.linkedBookingRef ?? null,
        itemType: "other",
        description: `${draft.description}\n\n(Criado a partir da conversa de WhatsApp #${conversationId}.)`.slice(0, 5000),
        status: "new",
        priority: "medium",
        createdBy: userId,
      } as any));
      if (!id) throw new Error("O perdido não foi gravado.");
      await logActivity({ userId, action: "create", entity: "lost_found", entityId: id, details: `Perdido a partir do WhatsApp (conversa ${conversationId}): ${draft.title}` });
      try {
        const { autoLinkLostFoundBooking } = await import("./complaintDossier");
        await autoLinkLostFoundBooking(id);
      } catch (err) {
        console.warn("[whatsapp case] ligar reserva falhou:", err);
      }
      try {
        const { notify } = await import("./notify");
        await notify({
          kind: "lost_found_new", projectId,
          title: "Novo Perdido",
          body: `${clientName}: ${draft.description.slice(0, 300)}`,
          link: "/perdidos-achados", entity: { type: "lost_found", id },
        });
      } catch (err) {
        console.warn("[whatsapp case] aviso falhou:", err);
      }
    }
    await db.update(whatsappConversations).set({ caseId: id }).where(eq(whatsappConversations.id, conversationId));
    return { kind, id };
  } catch (err) {
    // Desfaz a reserva para se poder tentar outra vez.
    await db
      .update(whatsappConversations)
      .set({ caseKind: null, caseId: null })
      .where(and(eq(whatsappConversations.id, conversationId), isNull(whatsappConversations.caseId)))
      .catch(() => undefined);
    throw err;
  }
}

/** "Não é": a proposta desta conversa não volta. */
export async function dismissCaseProposal(conversationId: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  await db
    .update(whatsappConversations)
    .set({ caseProposalDismissedAt: nowStr() })
    .where(and(eq(whatsappConversations.id, conversationId), isNull(whatsappConversations.caseProposalDismissedAt)));
  await logActivity({ userId, action: "update", entity: "whatsapp_conversation", entityId: conversationId, details: "Proposta de caso da triagem: \"Não é\"" });
}
