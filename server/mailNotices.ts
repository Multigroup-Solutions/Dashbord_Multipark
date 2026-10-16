/**
 * Avisos automáticos que chegam às caixas partilhadas (14 out 2026):
 *
 *  - aviso de OCORRÊNCIA da app Multipark ("Tipo de ocorrência:",
 *    "Matrícula:", "Observações:", "Link reserva:" — enviado do info@): a
 *    ocorrência já existe na BD da Multipark (fonte única, decisão 16a). Aqui
 *    só se PROCURA (só leitura): a mesma matrícula, criada perto da hora do
 *    email. Encontrada → o email liga-se a ela ("Ocorrência Multipark" nas
 *    ligações da conversa, abre /ocorrencias?mp=…), vai para a caixa das
 *    Ocorrências e fica LIDO. Nunca se escreve na BD da Multipark.
 *  - aviso de AVALIAÇÃO (Google Business Profile, Trustpilot, Tripadvisor):
 *    caixa das Críticas, LIDO — a crítica entra nas Críticas pela API do
 *    Google, daqui não se cria nada (um email só passa a crítica quando uma
 *    pessoa o importa — 15 out 2026).
 *
 * As regras puras (reconhecer o aviso) estão em shared/mailTriage.ts; quem
 * aplica é server/commsRouting.ts (applyRuleTriage). Interruptor AI_MAIL_NOTICES.
 */
import type { OccurrenceNotice } from "../shared/mailTriage";
import type { OccurrenceLookup } from "./commsRouting";

/** Procura a ocorrência do aviso na Multipark (só leitura). Nunca lança. */
export async function findOccurrenceForNotice(
  notice: OccurrenceNotice,
  sentAt: string | null,
  read: (n: { plate: string | null; type: string | null; atUtc: string | null }) => Promise<{ available: true; data: { id: string } | null } | { available: false }> = async (n) => {
    const { findMultiparkOccurrenceForNotice } = await import("./multiparkDb/read");
    return findMultiparkOccurrenceForNotice(n);
  },
): Promise<OccurrenceLookup> {
  try {
    const r = await read({ plate: notice.plate, type: notice.type, atUtc: sentAt });
    if (!r.available) return { status: "unavailable" };
    return r.data ? { status: "found", id: r.data.id } : { status: "none" };
  } catch {
    return { status: "unavailable" };
  }
}
