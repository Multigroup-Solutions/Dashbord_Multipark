/**
 * Extra sem cidade (P3 lote 17g-3 — Jorge, 2 out 2026: "quando chega um extra
 * que não tenha cidade ele tem que entrar em contacto e pedir a cidade, pois
 * senão não o vai chamar automaticamente; depois de pedir a cidade deve criar
 * uma tarefa e enviar um email para a Márcia Nunes […] com o prazo de uma
 * semana para contactar"). Textos e prazo. PURAS.
 */
import { addDaysIso, lisbonNow } from "./extrasSchedule";
import { dueDateFromDay } from "./taskRules";

/** Prazo da tarefa de quem trata das fichas sem cidade. */
export const CITY_TASK_DUE_DAYS = 7;

const firstName = (fullName: string): string => fullName.trim().split(/\s+/)[0] || "olá";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** A mensagem que pede a cidade (email e WhatsApp dizem o mesmo). */
export function cityRequestMessage(fullName: string): { subject: string; text: string; html: string; whatsapp: string } {
  const first = firstName(fullName);
  const ask = "Para te podermos chamar para turnos precisamos de saber em que cidade queres trabalhar: Lisboa, Porto ou Faro?";
  const text = `Olá ${first},\n\nObrigado pelo teu interesse em trabalhar connosco na Multipark!\n\n${ask}\n\nResponde a esta mensagem com a cidade.\n\nObrigado,\nMultipark — Recursos Humanos`;
  return {
    subject: "Multipark — em que cidade queres trabalhar?",
    text,
    html: `<p>Olá ${esc(first)},</p><p>Obrigado pelo teu interesse em trabalhar connosco na Multipark!</p><p>${esc(ask)}</p><p>Responde a esta mensagem com a cidade.</p><p>Obrigado,<br/>Multipark — Recursos Humanos</p>`,
    whatsapp: `Olá ${first}! ${ask} Responde só com a cidade. Obrigado!`,
  };
}

export interface CityAskOutcome {
  email: "sent" | "blocked" | "no_contact" | "failed";
  whatsapp: "sent" | "blocked" | "closed" | "no_contact" | "failed";
  /** Já tinha sido pedida antes (não se pede duas vezes). */
  previously?: boolean;
}

/** O que já se fez para pedir a cidade, numa frase (vai na tarefa e no email). */
export function askedSummary(o: CityAskOutcome | null): string {
  if (!o) return "Ainda não lhe foi pedida a cidade automaticamente (interruptor desligado ou não é extra).";
  if (o.previously) return "A cidade já lhe foi pedida antes; se ainda não respondeu, contacta-o(a).";
  const done = [o.email === "sent" ? "email" : null, o.whatsapp === "sent" ? "WhatsApp" : null].filter(Boolean);
  if (done.length) return `Já lhe pedimos a cidade por ${done.join(" e ")}; se não responder, contacta-o(a).`;
  return "Não foi possível pedir-lhe a cidade automaticamente (sem email/WhatsApp aberto ou com \"Não enviar\"): contacta-o(a).";
}

/** Prazo da tarefa: hoje (Lisboa) + 7 dias, no formato da coluna. */
export function cityTaskDueDate(now: Date = new Date()): string {
  return dueDateFromDay(addDaysIso(lisbonNow(now).date, CITY_TASK_DUE_DAYS))!;
}
