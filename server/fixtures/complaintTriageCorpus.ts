/**
 * Reclamações rotuladas para avaliar a triagem (tipo + prioridade) — plano
 * MPV F6b, T1: antes de pôr o raciocínio "minimal" na `complaint_triage`,
 * este conjunto tem de passar com ele (scripts/eval-complaint-triage.ts).
 * Casos FIXOS, escritos à mão, sem dados pessoais reais. A prioridade aceita
 * mais de um valor quando a regra do pedido (prompts/comms.ts) admite as duas
 * leituras; `urgent` marca os casos que NUNCA podem sair abaixo de "alta".
 */
import type { ComplaintPriority, ComplaintType } from "../../shared/commsAi";

export interface ComplaintTriageCase {
  id: string;
  clientName: string;
  subject: string;
  body: string;
  /** Tipos aceites (o 1.º é o esperado). */
  types: readonly ComplaintType[];
  /** Prioridades aceites. */
  priorities: readonly ComplaintPriority[];
  /** Caso urgente: sair "medium"/"low" conta como urgência perdida. */
  urgent?: boolean;
  note?: string;
}

const c = (id: string, subject: string, body: string, types: ComplaintType[], priorities: ComplaintPriority[], urgent = false, note?: string): ComplaintTriageCase => ({
  id, clientName: "Ana", subject, body, types, priorities, urgent, note,
});

export const COMPLAINT_TRIAGE_CORPUS: readonly ComplaintTriageCase[] = [
  c("rc-01", "Carro amolgado", "Quando fui buscar o carro tinha uma amolgadela no guarda-lamas traseiro que não tinha quando o deixei. Tenho fotografias de antes.", ["damage"], ["high", "urgent"]),
  c("rc-02", "Interior sujo", "O carro foi-me devolvido com areia e lixo no chão e copos de café no porta-copos. Não é o que se espera de um serviço pago.", ["dirt"], ["medium", "low"]),
  c("rc-03", "Esperei quase uma hora", "Na chegada esperei 55 minutos pelo carro, apesar de ter avisado a hora do voo com antecedência.", ["delay"], ["high", "medium"]),
  c("rc-04", "Cobrança a mais", "A reserva dizia 42 € e no cartão foram debitados 72 €. Ninguém me explicou a diferença.", ["overcharge"], ["medium", "high"]),
  c("rc-05", "Condutor mal-educado", "O condutor que recebeu o carro foi muito mal-educado e respondeu-me aos gritos quando perguntei pela chave.", ["staff"], ["medium", "high"]),
  c("rc-06", "Livro de Reclamações", "Venho por este meio informar que vou registar esta situação no Livro de Reclamações: o carro chegou com o para-choques partido.", ["damage"], ["urgent"], true, "Livro de Reclamações"),
  c("rc-07", "Vou avançar com advogado", "Já é a terceira vez que escrevo sem resposta sobre o risco na porta. Se não me responderem até sexta, o meu advogado trata do assunto.", ["damage", "other"], ["urgent"], true, "ameaça legal"),
  c("rc-08", "Estou sem carro no aeroporto", "Aterrei há duas horas e continuo sem carro, com duas crianças. Ninguém atende o telefone. Preciso de uma solução agora.", ["delay"], ["urgent"], true, "cliente sem carro"),
  c("rc-09", "Quilómetros a mais", "O conta-quilómetros tem mais 40 km do que quando entreguei o carro. Quem andou com o meu carro?", ["staff", "damage", "other"], ["high", "urgent"]),
  c("rc-10", "Site não deixa alterar", "Tentei alterar a data da reserva no vosso site e dá sempre erro. Podem ajudar?", ["other"], ["low", "medium"]),
  c("rc-11", "Vidro partido", "O vidro de trás do lado direito está partido. Deixei o carro em perfeito estado. Exijo que paguem a reparação.", ["damage"], ["high", "urgent"], true, "dano grave"),
  c("rc-12", "Atraso pequeno", "O carro chegou com uns 10 minutos de atraso. Não foi grave, mas fica o reparo.", ["delay"], ["low", "medium"]),
  c("rc-13", "Fatura errada", "A fatura saiu sem o meu NIF e com o nome errado. Preciso que a corrijam.", ["overcharge", "other"], ["low", "medium"]),
  c("rc-14", "Cheiro a tabaco", "O carro veio com um cheiro forte a tabaco e eu não fumo. Alguém fumou lá dentro.", ["dirt", "staff"], ["medium", "high"]),
  c("rc-15", "Chave perdida", "Disseram-me que não encontram a chave do meu carro. Estou no parque há meia hora sem poder ir embora.", ["staff", "other", "delay"], ["urgent", "high"], true, "cliente sem carro"),
  c("rc-16", "Reembolso do cancelamento", "Cancelei a reserva com 5 dias de antecedência e ainda não recebi o reembolso passadas três semanas.", ["overcharge"], ["medium", "high"]),
];
