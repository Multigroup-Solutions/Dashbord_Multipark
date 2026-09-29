/**
 * Ligação automática de emails a registos: cliente (email/telefone das
 * reservas), reserva (referência explícita ou matrícula/email/telefone/nome
 * ancorados na data), reclamação (mesma conversa ou aberta do mesmo cliente),
 * perdido aberto e o que o pipeline antigo criou. Cada ligação leva uma
 * confiança (0–100) e a razão; abaixo de AUTO_LINK_MIN_CONFIDENCE não liga.
 * Núcleo com dependências injetáveis (testes sem BD).
 */
import { AUTO_LINK_MIN_CONFIDENCE, normalizeAddress, type MailLinkType } from "../../shared/mail";
import { parseInboundBody } from "../emailParse";

export interface AutoLinkSignals {
  /** Parte externa da conversa (cliente). */
  contactEmail: string | null;
  contactName?: string | null;
  subject: string;
  bodyText: string;
  /** X-GM-THRID decimal + referências (agrupar com reclamações do IMAP). */
  gmThreadId: string | null;
  refs: string[];
  sentAt: string | null;
  /** O que o pipeline antigo fez com este email (se correu). */
  pipeline?: { targetModule: string; targetId?: number | null } | null;
}

export interface CaseRef { id: number; projectId: number | null }

export interface AutoLinkDeps {
  clientExists(email: string): Promise<boolean>;
  clientEmailByPhone(phone: string): Promise<string | null>;
  matchBooking(s: { ref?: string; plate?: string; email?: string; phone?: string; name?: string; anchorIso?: string }): Promise<{ externalId: string; projectId: number | null; score: number; matchedBy: string[] } | null>;
  complaintByThread(s: { gmThreadId: string | null; refs: string[] }): Promise<CaseRef | null>;
  openComplaintBySignals(email: string | null, plate: string | null, name: string | null): Promise<CaseRef | null>;
  openLostFoundBySignals(email: string | null, plate: string | null): Promise<CaseRef | null>;
  caseProject?(type: "complaint" | "lost_found" | "incident", id: number): Promise<number | null>;
}

export interface ProposedLink { entityType: MailLinkType; entityId: string; confidence: number; reason: string; projectId: number | null }

/** Pontuação do matchBookingForComplaint → confiança. PURA. */
export function bookingConfidence(score: number, byRef: boolean): number {
  if (byRef) return 95;
  if (score >= 70) return 85;
  if (score >= 40) return 70;
  if (score >= 30) return 55;
  return 0;
}

const PIPELINE_TYPE: Record<string, MailLinkType | undefined> = {
  complaint: "complaint", lostfound: "lost_found", incident: "incident", incident_dup: "incident",
};

export async function proposeLinks(s: AutoLinkSignals, deps: AutoLinkDeps): Promise<ProposedLink[]> {
  const out = new Map<string, ProposedLink>();
  const add = (l: ProposedLink) => {
    if (!l.entityId || l.confidence < AUTO_LINK_MIN_CONFIDENCE) return;
    const k = `${l.entityType}:${l.entityId}`;
    const cur = out.get(k);
    if (!cur || cur.confidence < l.confidence) out.set(k, l);
  };
  const parsed = parseInboundBody(`${s.subject}\n${s.bodyText}`.slice(0, 20_000));
  const email = normalizeAddress(s.contactEmail) || null;
  const bodyEmail = normalizeAddress(parsed.clientEmail) || null;
  const plate = parsed.vehiclePlate ?? null;
  const name = (parsed.clientName || s.contactName || "").trim() || null;

  // 1) O que o pipeline criou/juntou (certeza).
  const pt = s.pipeline?.targetModule ? PIPELINE_TYPE[s.pipeline.targetModule] : undefined;
  if (pt && s.pipeline?.targetId) {
    const projectId = deps.caseProject ? await deps.caseProject(pt as any, s.pipeline.targetId).catch(() => null) : null;
    add({ entityType: pt, entityId: String(s.pipeline.targetId), confidence: 100, reason: "registo criado/atualizado por este email", projectId });
  }

  // 2) Cliente (identidade = email das reservas).
  if (email && await deps.clientExists(email)) add({ entityType: "client", entityId: email, confidence: 90, reason: "email do cliente nas reservas", projectId: null });
  if (bodyEmail && bodyEmail !== email && await deps.clientExists(bodyEmail)) add({ entityType: "client", entityId: bodyEmail, confidence: 75, reason: "email do cliente no texto (reencaminhado)", projectId: null });
  if (parsed.clientPhone) {
    const byPhone = await deps.clientEmailByPhone(parsed.clientPhone);
    if (byPhone) add({ entityType: "client", entityId: normalizeAddress(byPhone), confidence: 60, reason: "telefone do cliente nas reservas", projectId: null });
  }

  // 3) Reserva.
  const anchorIso = s.sentAt ? new Date(s.sentAt.replace(" ", "T") + "Z").toISOString() : undefined;
  const bm = await deps.matchBooking({
    ref: parsed.bookingRef, plate: plate ?? undefined, email: bodyEmail ?? email ?? undefined, phone: parsed.clientPhone, name: name ?? undefined, anchorIso,
  });
  if (bm) {
    const byRef = bm.matchedBy.includes("ref");
    add({ entityType: "booking", entityId: bm.externalId, confidence: bookingConfidence(bm.score, byRef), reason: byRef ? "referência da reserva no email" : `reserva por ${bm.matchedBy.join(" + ")}`, projectId: bm.projectId });
  }

  // 4) Reclamação: mesma conversa (certo) ou aberta do mesmo cliente.
  const byThread = await deps.complaintByThread({ gmThreadId: s.gmThreadId, refs: s.refs });
  if (byThread) add({ entityType: "complaint", entityId: String(byThread.id), confidence: 95, reason: "mesma conversa da reclamação", projectId: byThread.projectId });
  if (email || plate) {
    const open = await deps.openComplaintBySignals(bodyEmail ?? email, plate, name);
    if (open) add({ entityType: "complaint", entityId: String(open.id), confidence: 70, reason: "reclamação aberta do mesmo cliente", projectId: open.projectId });
    const lf = await deps.openLostFoundBySignals(bodyEmail ?? email, plate);
    if (lf) add({ entityType: "lost_found", entityId: String(lf.id), confidence: 70, reason: "perdido aberto do mesmo cliente", projectId: lf.projectId });
  }
  return Array.from(out.values()).sort((a, b) => b.confidence - a.confidence);
}

/** Cidade (projeto) da conversa: a ligação mais confiante que tenha projeto. PURA. */
export function projectFromLinks(links: readonly ProposedLink[]): number | null {
  return links.find((l) => l.projectId != null)?.projectId ?? null;
}
