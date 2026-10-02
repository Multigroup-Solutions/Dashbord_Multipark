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
 * Para onde a IA pode mandar uma conversa (email ou WhatsApp), com a
 * descrição que vai no pedido à IA. Só as que existirem e estiverem ativas.
 */
export const ROUTING_TARGETS: ReadonlyArray<{ key: string; hint: string }> = [
  { key: "rh", hint: "recursos humanos: candidaturas, condutores/extras, colaboradores, escalas, disponibilidade, salários" },
  { key: "reservas", hint: "reservas novas, preços, disponibilidade de lugares, como funciona o serviço" },
  { key: "alteracoes", hint: "alterar ou cancelar uma reserva existente: datas, horas, voo, matrícula" },
  { key: "servicos_extra", hint: "serviços extra: lavagem, carregamento elétrico, inspeção, outros serviços ao carro" },
  { key: "reclamacoes", hint: "reclamações: danos, atrasos, mau serviço, cliente insatisfeito" },
  { key: "perdidos", hint: "objetos perdidos ou esquecidos no carro ou no shuttle" },
  { key: "parcerias", hint: "parcerias: empresas, agências, hotéis, propostas comerciais B2B" },
  { key: "faturacao", hint: "faturação: faturas, recibos, NIF, pagamentos, reembolsos" },
];

/** Intenção da triagem do WhatsApp → caixa. */
export const INTENT_BOX: Record<WhatsappIntent, string> = {
  reserva: "reservas",
  alteracao: "alteracoes",
  cancelamento: "alteracoes",
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

/** Destinos válidos para a IA (os de ROUTING_TARGETS que existem e estão ativos). */
export function availableTargets(boxes: ReadonlyArray<{ key: string; active: boolean }>): Array<{ key: string; hint: string }> {
  const active = new Set(boxes.filter((b) => b.active).map((b) => b.key));
  return ROUTING_TARGETS.filter((t) => active.has(t.key));
}

/** Resposta da IA → caixa válida (ou null = fica onde está). */
export function parseRoutingAnswer(raw: unknown, targets: ReadonlyArray<{ key: string }>): string | null {
  const k = String(raw ?? "").trim().toLowerCase().replace(/[^a-z_]/g, "");
  return targets.some((t) => t.key === k) ? k : null;
}
