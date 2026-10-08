/**
 * Comunicação com clientes — prompts CURTOS (custo) + schemas zod:
 * triagem de reclamações, triagem do WhatsApp e semelhança perdido ↔ achado.
 */
import { z } from "zod";
import { COMPANY_CONTEXT, PLACEHOLDER_RULE, PT_PT_RULE } from "./common";

// Schemas sem limites de tamanho/intervalo: a IA às vezes devolve 85 em vez de
// 0,85 ou um texto maior — isso não pode dar "resposta inválida"; o código
// normaliza e corta depois (shared/commsAi.ts).

/** Tetos de entrada (caracteres) — nunca mandar emails/conversas inteiras. */
export const COMPLAINT_INPUT_MAX = 2500;
export const WHATSAPP_INPUT_MAX = 1500;
export const LOST_DESC_MAX = 300;

// ─── Reclamações ────────────────────────────────────────────────────────────

export const COMPLAINT_TRIAGE_SYSTEM = [
  `Fazes a triagem de reclamações de clientes. ${COMPANY_CONTEXT}`,
  PT_PT_RULE,
  PLACEHOLDER_RULE,
  "type: damage (dano no carro), dirt (sujidade), delay (atraso na entrega/recolha), overcharge (cobrança/preço), staff (atendimento/condutor), other.",
  "priority: urgent (Livro de Reclamações, dano grave, ameaça legal, cliente sem carro), high (dano, atraso grande), medium, low.",
  "confidence: 0 a 1 para type e priority.",
  "bookingRef/plate: só se aparecerem no texto (copia o marcador tal como está); senão vazio.",
  "draft: resposta curta (máx. 5 frases) ao cliente, cordial, sem saudação inicial nem assinatura (são acrescentadas depois), que refere a reserva escrevendo exatamente [RESERVA], diz que o caso está a ser analisado e pede o que faltar. NUNCA prometas reembolsos, descontos, vouchers, compensações nem admitas culpa.",
].join("\n");

export const complaintTriageSchema = z.object({
  type: z.string(),
  typeConfidence: z.number(),
  priority: z.string(),
  priorityConfidence: z.number(),
  reason: z.string(),
  bookingRef: z.string(),
  plate: z.string(),
  draft: z.string(),
});
export type ComplaintTriageOutput = z.infer<typeof complaintTriageSchema>;

export function complaintTriageInput(p: { firstName: string; subject: string; body: string; knownBooking: boolean }): string {
  return [
    `Cliente: ${p.firstName}${p.knownBooking ? " (reserva já identificada)" : ""}`,
    `Assunto: ${p.subject.slice(0, 200)}`,
    `Mensagem:\n"""\n${p.body.slice(0, COMPLAINT_INPUT_MAX)}\n"""`,
  ].join("\n");
}

// ─── WhatsApp ───────────────────────────────────────────────────────────────

export const WHATSAPP_TRIAGE_SYSTEM = [
  `Classificas mensagens de WhatsApp recebidas pelo apoio ao cliente. ${COMPANY_CONTEXT} A empresa também recruta condutores extra.`,
  "intent: reserva, alteracao, cancelamento, perdido_achado, reclamacao, recrutamento, servicos_extra (lavagem, carregamento, outros serviços ao carro), parcerias (empresas, agências, propostas B2B), faturacao (faturas, recibos, NIF, pagamentos, reembolsos), outro.",
  "urgency: urgente só se o cliente está à espera agora (no aeroporto, carro não entregue, voo a partir), perdeu algo de valor ou está muito irritado; senão normal.",
  "confidence: 0 a 1, quão certa estás da intenção. reason: motivo curto (máx. 10 palavras, PT-PT, sem dados pessoais).",
  "Responde só com o JSON pedido.",
].join("\n");

// confidence/reason opcionais: uma resposta sem eles (fornecedor antigo) continua válida.
export const whatsappTriageSchema = z.object({
  intent: z.string(),
  urgency: z.string(),
  confidence: z.number().optional(),
  reason: z.string().optional(),
});

// ─── Email: separar pelas caixas (17f; Jorge, 8 out 2026: todas as caixas partilhadas) ──

export const MAIL_ROUTING_SYSTEM = [
  `Separas emails recebidos nas caixas partilhadas da empresa pela caixa do tema certo. ${COMPANY_CONTEXT} A empresa também recruta condutores extra.`,
  PT_PT_RULE,
  PLACEHOLDER_RULE,
  "Recebes as caixas possíveis (chave: descrição) e o email. Responde com a chave da caixa certa em `box`,",
  "ou `geral` se não for claro ou não encaixar em nenhuma. Não inventes chaves.",
  "confidence: 0 a 1, quão certa estás. reason: motivo curto (máx. 10 palavras, sem dados pessoais).",
  "candidate: true SÓ se for uma pessoa a candidatar-se a trabalhar connosco (enviar CV, pedir emprego, perguntar por vagas); falso para colaboradores, fornecedores e clientes.",
  "Se candidate for true, preenche o que aparecer (senão vazio): candidateName (nome completo), candidatePhone e candidateEmail (copia o marcador tal como está, ex. [TELEFONE_1]), candidateCity (onde vive ou quer trabalhar), hasLicense (sim/nao/desconhecido), licenseYears (anos de carta, número ou null), availability (disponibilidade, texto curto).",
  "Responde só com o JSON pedido.",
].join("\n");

export const mailRoutingSchema = z.object({
  box: z.string(),
  confidence: z.number(),
  reason: z.string(),
  candidate: z.boolean().optional(),
  candidateName: z.string().optional(),
  candidatePhone: z.string().optional(),
  candidateEmail: z.string().optional(),
  candidateCity: z.string().optional(),
  hasLicense: z.string().optional(),
  licenseYears: z.number().nullable().optional(),
  availability: z.string().optional(),
});
export type MailRoutingOutput = z.infer<typeof mailRoutingSchema>;

export function mailRoutingInput(p: {
  targets: ReadonlyArray<{ key: string; hint: string }>;
  subject: string;
  body: string;
  /** Caixa por onde entrou (ex.: "Geral (info@)"). */
  fromBox?: string | null;
  /** Só o primeiro nome de quem escreve. */
  senderFirstName?: string | null;
  /** Nomes dos anexos (ex.: "CV.pdf") — ajudam a reconhecer candidaturas. */
  attachmentNames?: readonly string[];
}): string {
  return [
    "Caixas:",
    ...p.targets.map((t) => `- ${t.key}: ${t.hint}`),
    "",
    ...(p.fromBox ? [`Entrou pela caixa: ${p.fromBox}`] : []),
    ...(p.senderFirstName ? [`Remetente: ${p.senderFirstName}`] : []),
    ...(p.attachmentNames?.length ? [`Anexos: ${p.attachmentNames.slice(0, 6).map((n) => n.slice(0, 60)).join(", ")}`] : []),
    `Assunto: ${p.subject.slice(0, 200)}`,
    `Email:\n"""\n${p.body.slice(0, 2500)}\n"""`,
  ].join("\n");
}

// ─── Perdidos & Achados ─────────────────────────────────────────────────────

export const LOST_MATCH_SYSTEM = [
  "Num parque de estacionamento, comparas a descrição de um objeto (perdido por um cliente ou encontrado pela equipa) com candidatos do lado oposto.",
  PT_PT_RULE,
  PLACEHOLDER_RULE,
  "Para cada candidato dá score 0–100 (probabilidade de ser o mesmo objeto) e reason curta (máx. 12 palavras). Sê conservador: descrições vagas = score baixo.",
].join("\n");

export const lostMatchSchema = z.object({
  matches: z.array(z.object({ id: z.number(), score: z.number(), reason: z.string() })),
});

export function lostMatchInput(item: { side: "lost" | "found"; text: string }, candidates: { id: number; text: string }[]): string {
  const lines = candidates.map((c) => `${c.id}: ${c.text.slice(0, LOST_DESC_MAX)}`);
  const [a, b] = item.side === "lost" ? ["Perdido", "Encontrados"] : ["Encontrado", "Perdidos reportados"];
  return `${a}: ${item.text.slice(0, LOST_DESC_MAX)}\n${b}:\n${lines.join("\n")}`;
}
