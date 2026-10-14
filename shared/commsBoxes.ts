/**
 * Comunicação única (P3 lote 17f): as CAIXAS por tema servem o email e o
 * WhatsApp (Jorge, 2 out 2026: "separar por recursos humanos, reservas,
 * alterações, serviços extra, reclamações, parcerias, faturação; e só abre a
 * cidade que tens acesso ou aqueles que não têm cidade").
 *
 * As caixas são as `mail_mailboxes` (as que já existiam + as novas por tema,
 * `sourceKind: "tema"`, sem conta Gmail própria). Uma conversa de email muda
 * de caixa quando a IA (ou uma pessoa) a move; uma de WhatsApp tem
 * `boxKey` (null = Geral). PURAS.
 */
import { grantFor, type AccessOverrides, type ModuleId } from "./access";
import type { WhatsappIntent } from "./commsAi";

/** Caixa "Geral": onde fica o que ainda não foi separado (email do info@ e WhatsApp sem caixa). */
export const GENERAL_BOX_KEY = "info";

/** Caixas por tema que a migração 0365 cria (as outras do Jorge — RH, Reservas, Reclamações — já existiam). */
export const TOPIC_BOX_SEEDS = [
  { key: "alteracoes", label: "Alterações", module: "reservas_operacoes", cityRule: "linked", sortOrder: 15 },
  { key: "servicos_extra", label: "Serviços extra", module: "servicos", cityRule: "linked", sortOrder: 16 },
  { key: "parcerias", label: "Parcerias", module: "parcerias", cityRule: "all", sortOrder: 85 },
  // Faturação: no módulo financeiro só os admins a veriam — fica com quem tem a Comunicação (o super admin muda nas Definições).
  { key: "faturacao", label: "Faturação", module: "comunicacao", cityRule: "all", sortOrder: 86 },
] as const;

/**
 * D40 (Jorge, 3 out 2026): os cancelamentos têm caixa própria (antes iam para
 * Alterações). Criada pela migração 0455 — fica fora de TOPIC_BOX_SEEDS porque
 * a 0365 já correu (uma vez) com essa lista.
 */
export const CANCELLATIONS_BOX = { key: "cancelamentos", label: "Cancelamentos", module: "reservas_operacoes", cityRule: "linked", sortOrder: 14 } as const;

/**
 * Para onde a IA pode mandar uma conversa de email, com o que cada caixa QUER
 * DIZER (vai no pedido à IA). Frases sobre a intenção de quem escreve — nunca
 * listas de palavras: a IA decide pelo sentido (Jorge, 14 out 2026: "não por
 * palavra-chave: tem de perceber"). Só se move para as que existirem e
 * estiverem ativas (shared/mailTriage.ts decideMailTriage). Críticas e
 * Ocorrências (14 out 2026) só com o interruptor dos avisos ligado.
 */
export const ROUTING_TARGETS: ReadonlyArray<{ key: string; hint: string }> = [
  { key: "rh", hint: "a pessoa quer trabalhar connosco (candidatura, vagas) ou é um colaborador a tratar do seu trabalho, horários, disponibilidade ou salário" },
  { key: "reservas", hint: "alguém quer fazer uma reserva nova ou saber preços, lugares livres ou como funciona o serviço" },
  { key: "alteracoes", hint: "o cliente quer mudar uma reserva que já tem (datas, horas, voo ou carro) sem desistir dela" },
  { key: "cancelamentos", hint: "o cliente quer cancelar uma reserva que já tem, ou pede o reembolso de uma reserva que cancelou" },
  { key: "servicos_extra", hint: "o cliente pede ou pergunta por um serviço extra ao carro durante a estadia, como a lavagem ou o carregamento elétrico" },
  { key: "reclamacoes", hint: "o cliente diz que algo correu mal com o serviço que usou ou está a usar e mostra-se descontente ou quer que se resolva, explique ou compense — mesmo que o diga com calma, em poucas palavras, a responder ou dentro de outro pedido" },
  { key: "perdidos", hint: "alguém diz que deixou, perdeu ou esqueceu um objeto no carro, no parque ou no transfer, ou pergunta por um objeto que encontrámos" },
  { key: "parcerias", hint: "uma empresa, agência ou hotel propõe trabalhar connosco ou fazer negócio" },
  { key: "faturacao", hint: "o pedido é sobre faturas, recibos ou pagamentos já feitos (pedir ou corrigir uma fatura, um comprovativo), sem queixa do serviço" },
  { key: "criticas", hint: "aviso de uma avaliação publicada num site de avaliações, ou um elogio ou opinião sobre o serviço sem nada para resolver; uma opinião negativa de um cliente que quer resposta é reclamação" },
  { key: "ocorrencias", hint: "um colaborador ou a app da operação relata um incidente com um carro de cliente ou no parque, para registo interno da operação" },
];

/** Intenção da triagem do WhatsApp → caixa. */
export const INTENT_BOX: Record<WhatsappIntent, string> = {
  reserva: "reservas",
  alteracao: "alteracoes",
  cancelamento: "cancelamentos",
  perdido_achado: "perdidos",
  reclamacao: "reclamacoes",
  recrutamento: "rh",
  servicos_extra: "servicos_extra",
  parcerias: "parcerias",
  faturacao: "faturacao",
  outro: GENERAL_BOX_KEY,
};

export type BoxSource = "rule" | "ai" | "manual";

/**
 * Caixa de uma conversa de WhatsApp. A escolha à mão nunca muda sozinha;
 * colaborador ou candidato (lead) → RH; senão a intenção da IA; sem nada →
 * fica como está (Geral). Devolve null quando não há nada a mudar.
 */
export function whatsappBoxFor(c: {
  boxKey: string | null; boxSource: BoxSource | null; employeeId: number | null; isLead: boolean; intent: WhatsappIntent | null;
}): { boxKey: string; boxSource: BoxSource } | null {
  if (c.boxSource === "manual") return null;
  if (c.employeeId != null || c.isLead) return c.boxKey === "rh" && c.boxSource === "rule" ? null : { boxKey: "rh", boxSource: "rule" };
  if (c.intent) {
    const k = INTENT_BOX[c.intent];
    return k === c.boxKey ? null : { boxKey: k, boxSource: "ai" };
  }
  return null;
}

export interface BoxViewer { id: number; role: string | null | undefined; accessOverrides?: AccessOverrides | null }

/**
 * Vê a caixa pelo módulo e papéis — sem exigir o módulo Comunicação (quem só
 * tem o WhatsApp continua a ver as conversas de WhatsApp das caixas do seu
 * módulo). Caixa inativa: só o super admin.
 */
export function canSeeBoxModule(
  v: BoxViewer | null | undefined,
  box: { module: string; visibleRoles: readonly string[]; active: boolean },
): boolean {
  if (!v) return false;
  if (v.role === "super_admin") return true;
  if (!box.active) return false;
  const g = grantFor(v as any, box.module as ModuleId);
  if (g.access === "none" || g.access === "own" || !g.actions.includes("view")) return false;
  if (box.visibleRoles.length && !box.visibleRoles.includes(String(v.role))) return false;
  return true;
}

// ─── Quem é (17f): nome e histórico do CRM / RH numa conversa ──────────────

const POSITION_LABELS: Record<string, string> = {
  director: "Diretor", supervisor: "Supervisor", team_leader: "Team leader", backoffice: "Backoffice", frontoffice: "Frontoffice",
  senior_driver: "Condutor sénior", driver: "Condutor", extra: "Extra",
};
const LEAD_STATUS_LABELS: Record<string, string> = { new: "novo", contacted: "contactado", replied: "respondeu", converted: "convertido", declined: "recusado" };

export type ContactIdentity =
  | { kind: "employee"; name: string; detail: string }
  | { kind: "lead"; name: string; detail: string }
  | { kind: "client"; name: string | null; detail: string; clientId: number; email: string | null }
  | { kind: "unknown"; name: null; detail: string };

const ptDate = (s: string | null | undefined): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
};

/** Uma linha "quem é" a partir do que se sabe (ficha → candidato → cliente do CRM). PURA. */
export function describeIdentity(f: {
  employee?: { fullName: string; position: string | null; city: string | null } | null;
  lead?: { fullName: string; status: string | null; city: string | null } | null;
  client?: { id: number; name: string | null; email: string | null; bookings: number; upcoming: number; lastVisit: string | null } | null;
}): ContactIdentity {
  if (f.employee) {
    return { kind: "employee", name: f.employee.fullName, detail: ["Colaborador", f.employee.position ? POSITION_LABELS[f.employee.position] ?? f.employee.position : null, f.employee.city].filter(Boolean).join(" · ") };
  }
  if (f.lead) {
    return { kind: "lead", name: f.lead.fullName, detail: ["Candidato a extra", f.lead.status ? LEAD_STATUS_LABELS[f.lead.status] ?? f.lead.status : null, f.lead.city].filter(Boolean).join(" · ") };
  }
  if (f.client) {
    const c = f.client;
    const parts = [`Cliente · ${c.bookings} reserva${c.bookings === 1 ? "" : "s"}${c.upcoming ? ` (${c.upcoming} por vir)` : ""}`];
    const last = ptDate(c.lastVisit);
    if (last) parts.push(`última ${last}`);
    return { kind: "client", name: c.name, detail: parts.join(" · "), clientId: c.id, email: c.email };
  }
  return { kind: "unknown", name: null, detail: "Número sem ficha, candidatura nem cliente no CRM" };
}
