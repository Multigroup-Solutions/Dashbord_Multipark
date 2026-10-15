/**
 * Conversas de WhatsApp rotuladas para avaliar a triagem (intenção +
 * urgência) — plano MPV F6b, T1: antes de pôr o raciocínio "minimal" na
 * `whatsapp_triage`, este conjunto tem de passar com ele
 * (scripts/eval-whatsapp-triage.ts). Casos FIXOS, escritos à mão, sem dados
 * pessoais reais. Quando a resposta certa admite duas leituras (ex.: cobrança
 * em dobro = faturação ou reclamação) vão as duas em `intents`.
 */
import type { WhatsappIntent } from "../../shared/commsAi";

export interface WhatsappTriageCase {
  id: string;
  messages: Array<{ direction: "in" | "out"; body: string }>;
  /** Intenções aceites (a 1.ª é a esperada). */
  intents: readonly WhatsappIntent[];
  urgency: "urgente" | "normal";
  note?: string;
}

const c = (id: string, body: string | Array<{ direction: "in" | "out"; body: string }>, intents: WhatsappIntent[], urgency: "urgente" | "normal" = "normal", note?: string): WhatsappTriageCase => ({
  id, messages: typeof body === "string" ? [{ direction: "in", body }] : body, intents, urgency, note,
});

export const WHATSAPP_TRIAGE_CORPUS: readonly WhatsappTriageCase[] = [
  c("wa-01", "Olá, queria reservar estacionamento de 12 a 19 de novembro no aeroporto de Lisboa. Quanto fica?", ["reserva"]),
  c("wa-02", "Boa tarde, tenho reserva para amanhã às 6h mas o voo mudou para as 9h. Podem passar a entrega para as 8h?", ["alteracao"]),
  c("wa-03", "Quero cancelar a minha reserva da próxima semana, já não vou viajar.", ["cancelamento"]),
  c("wa-04", "Deixei uns óculos de sol no vosso carro do transfer ontem à noite. Alguém os encontrou?", ["perdido_achado"]),
  c("wa-05", "Esqueci-me do portátil dentro do carro e o voo sai daqui a uma hora!! Preciso dele já", ["perdido_achado"], "urgente", "objeto de valor e voo a partir"),
  c("wa-06", "Estou nas chegadas há 40 minutos à espera do carro e ninguém atende o telefone. Isto é inaceitável", ["reclamacao"], "urgente", "à espera agora"),
  c("wa-07", "O meu carro veio com um risco na porta do condutor que não tinha quando o deixei. Quero uma explicação.", ["reclamacao"]),
  c("wa-08", "Boa tarde, vi o anúncio para condutor extra. Ainda estão a recrutar? Tenho carta há 10 anos.", ["recrutamento"]),
  c("wa-09", "Fazem lavagem do carro enquanto estou de férias? Quanto custa a lavagem completa?", ["servicos_extra"]),
  c("wa-10", "Somos uma agência de viagens no Porto e gostávamos de propor uma parceria para os nossos clientes.", ["parcerias"]),
  c("wa-11", "Podem enviar a fatura da reserva com o NIF da empresa? Preciso para as despesas.", ["faturacao"]),
  c("wa-12", "Obrigado pelo serviço, correu tudo muito bem!", ["outro"]),
  c("wa-13", [
    { direction: "in", body: "Olá" },
    { direction: "out", body: "Olá! Em que podemos ajudar?" },
    { direction: "in", body: "Já aterrei e estou à saída das chegadas, o carro ainda não apareceu e embarco outra vez daqui a nada" },
  ], ["reclamacao", "outro", "reserva"], "urgente", "à espera agora — várias leituras de intenção"),
  c("wa-14", "Cobraram-me duas vezes no cartão a mesma reserva. Quero o reembolso de uma delas.", ["faturacao", "reclamacao"]),
  c("wa-15", "Hi, I have a booking for tomorrow, can I change the drop-off time to 5am?", ["alteracao"]),
  c("wa-16", "Hello, I want to cancel my booking for next Friday please.", ["cancelamento"]),
  c("wa-17", "Encontrei uma carteira no banco de trás do carro que me entregaram hoje, não é minha.", ["perdido_achado"]),
  c("wa-18", "Qual é o horário de funcionamento ao fim de semana?", ["outro", "reserva"]),
  c("wa-19", "Têm carregamento para carros elétricos no parque?", ["servicos_extra"]),
  c("wa-20", "É a segunda vez que me entregam o carro sujo e atrasado. Estou farto, vou escrever no livro de reclamações hoje mesmo.", ["reclamacao"], "urgente", "muito irritado"),
  c("wa-21", "Quero mudar a matrícula da reserva, afinal vou levar o outro carro.", ["alteracao"]),
  c("wa-22", "Preciso do recibo do pagamento em dinheiro que fiz ontem na entrega.", ["faturacao"]),
  c("wa-23", "Boa noite, quanto custa uma semana de estacionamento coberto em Faro em dezembro?", ["reserva"]),
  c("wa-24", "Bom dia, a reserva já está paga? Recebi o email mas não diz nada sobre o pagamento.", ["faturacao", "reserva", "outro"]),
];
