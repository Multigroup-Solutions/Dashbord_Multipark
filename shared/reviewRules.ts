/**
 * Críticas Google — regras PURAS das escritas (P3 lote 16d). Partilhadas pelo
 * router, pela página e pelos testes.
 *
 * - "Respondida" é PUBLICADA: guardar um texto é só rascunho. Nas críticas da
 *   API, publica o "Aprovar e publicar"; nas que vieram por email, quem
 *   respondeu no perfil Google carrega em "Já publiquei no Google".
 * - Uma crítica convertida em reclamação não volta atrás nem muda de estado
 *   cá (trata-se na reclamação); a resposta pública continua a ser aqui.
 * - A resposta de uma crítica de email marcada como publicada fica guardada tal
 *   como foi enviada (para a mudar, primeiro "Desfazer").
 */

export type ReviewStatus = "pending_response" | "ai_responded" | "manually_responded" | "converted_complaint" | "dismissed";

export interface ReviewState {
  status: string;
  complaintId?: number | null;
  respondedAt?: string | null;
  googleReply?: string | null;
  googleReviewName?: string | null;
  aiResponse?: string | null;
}

/** Prioridade e prazo da reclamação aberta a partir de uma crítica (os 3 caminhos iguais). */
export const REVIEW_COMPLAINT_SLA_HOURS = 24;
export function reviewComplaintPriority(rating: number): "urgent" | "high" {
  return rating === 1 ? "urgent" : "high";
}

/** Marcada como publicada à mão (crítica de email, sem resposta do Google cá). */
export function isMarkedPublished(r: ReviewState): boolean {
  return !r.googleReply && (r.respondedAt != null || r.status === "manually_responded");
}

export type ReviewUpdateInput = { aiResponse?: string; status?: ReviewStatus };
export type ReviewUpdateResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * O que `reviews.update` pode mudar. `aiResponse` = rascunho (por aprovar);
 * `manually_responded` = "Já publiquei no Google" (só críticas de email);
 * `pending_response` = reabrir uma dispensada ou "Desfazer" a marca de
 * publicada; `dismissed` = dispensar. Converter tem botão próprio. Numa
 * convertida o estado fica "Reclamação" (marcar/desfazer só mexe na data).
 */
export function reviewUpdatePatch(prev: ReviewState, input: ReviewUpdateInput, actorId: number, now: string): ReviewUpdateResult {
  const patch: Record<string, unknown> = {};
  const converted = !!prev.complaintId || prev.status === "converted_complaint";
  if (input.aiResponse !== undefined) {
    if (isMarkedPublished(prev)) return { ok: false, error: "A resposta já foi marcada como publicada. Para a mudar, primeiro \"Desfazer\"." };
    const text = input.aiResponse.trim();
    patch.aiResponse = text || null;
    patch.aiResponseApproved = 0;
  }
  const next = input.status;
  if (next !== undefined && next !== prev.status) {
    if (next === "converted_complaint") return { ok: false, error: "Para converter usa \"Criar Reclamação\"." };
    if (next === "ai_responded") return { ok: false, error: "Esse estado é só do rascunho da IA." };
    if (next === "manually_responded") {
      if (prev.googleReviewName) return { ok: false, error: "Esta crítica está ligada ao Google: usa \"Aprovar e publicar\"." };
      if (isMarkedPublished(prev)) return { ok: false, error: "Já está marcada como publicada." };
      const text = patch.aiResponse !== undefined ? (patch.aiResponse as string | null) : prev.aiResponse;
      if (!String(text ?? "").trim()) return { ok: false, error: "Escreve (ou gera) a resposta antes de a marcar como publicada." };
      Object.assign(patch, { aiResponseApproved: 1, respondedAt: now, respondedBy: actorId, ...(converted ? {} : { status: next }) });
    } else if (next === "pending_response") {
      if (prev.status === "dismissed") {
        // Reabrir: volta ao que era (respondida, se já tinha resposta publicada).
        patch.status = prev.googleReply || prev.respondedAt != null ? "manually_responded" : "pending_response";
      } else {
        // "Desfazer" a marca de publicada (a resposta do Google não se desfaz cá).
        if (prev.googleReply) return { ok: false, error: "A resposta já está publicada no Google." };
        if (!isMarkedPublished(prev)) return { ok: false, error: "Não há nada para desfazer." };
        Object.assign(patch, { respondedAt: null, respondedBy: null, ...(converted ? {} : { status: next }) });
      }
    } else if (next === "dismissed") {
      if (converted) return { ok: false, error: "Esta crítica já é uma reclamação: trata-a na reclamação." };
      patch.status = next;
    }
  }
  if (!Object.keys(patch).length) return { ok: false, error: "Nada para mudar." };
  return { ok: true, patch };
}

/** Novo rascunho da IA: estado só passa a "Rascunho IA" se ainda estava por responder. */
export function draftStatusAfterGenerate(prevStatus: string): ReviewStatus | undefined {
  return prevStatus === "pending_response" || prevStatus === "ai_responded" ? "ai_responded" : undefined;
}
