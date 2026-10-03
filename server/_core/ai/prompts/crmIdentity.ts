/**
 * CRM — "estas duas fichas são a mesma pessoa?" (P3 lote 21c, AI_CRM_IDENTITY).
 *
 * Só vão à IA as DÚVIDAS (as regras do dono não as resolvem e nada as
 * impede). RGPD (docs/ia.md §5): dos nomes só vai o primeiro; emails,
 * telefones, matrículas e NIF NUNCA vão — só factos calculados aqui
 * ("telefone igual, só nestas 2 fichas", "apelido diferente", "o email em
 * comum tem o apelido da ficha A").
 */
import { z } from "zod";
import { PT_PT_RULE } from "./common";

export const CRM_IDENTITY_SYSTEM = [
  "És o assistente do CRM de uma empresa de estacionamento (parques de aeroporto). Recebes pares de fichas de clientes que PODEM ser a mesma pessoa e decides, para cada par, se são a mesma pessoa.",
  PT_PT_RULE,
  "Regras do dono: o mesmo 1.º e último nome + o mesmo email, telefone ou matrícula = a mesma pessoa. Com nome diferente, o mesmo email E o mesmo telefone também (quem atende o telefone e lê o email é a mesma pessoa). Família (o mesmo apelido, 1.º nome diferente) a partilhar o telefone ou o carro NÃO é a mesma pessoa. Um dado partilhado por várias fichas é de família/empresa e vale pouco.",
  "Erros de escrita, nomes do meio a mais ou a menos, nome de solteira/casada, iniciais e trocas de ordem contam a favor; nomes próprios diferentes (Ana vs Rui) contam muito contra.",
  "Para cada par devolve: verdict = \"same\" (a mesma pessoa), \"different\" (pessoas diferentes) ou \"unsure\" (não dá para saber); confidence 0–100 (quão certo estás do veredicto); reason curta (máx. 15 palavras, sem inventar dados). Sê conservador: na dúvida, \"unsure\".",
].join("\n");

export const crmIdentitySchema = z.object({
  results: z.array(z.object({
    id: z.number(),
    verdict: z.enum(["same", "different", "unsure"]),
    confidence: z.number(),
    reason: z.string(),
  })),
});

/** Um par já reduzido a factos (sem contactos). */
export interface CrmIdentityPairFacts {
  id: number;
  a: { firstName: string; words: number; bookings: number };
  b: { firstName: string; words: number; bookings: number };
  facts: string[];
}

export function crmIdentityInput(pairs: CrmIdentityPairFacts[]): string {
  return pairs.map((p) => [
    `Par ${p.id}:`,
    `  Ficha A: 1.º nome «${p.a.firstName || "?"}», ${p.a.words} ${p.a.words === 1 ? "palavra" : "palavras"} no nome, ${p.a.bookings} reservas`,
    `  Ficha B: 1.º nome «${p.b.firstName || "?"}», ${p.b.words} ${p.b.words === 1 ? "palavra" : "palavras"} no nome, ${p.b.bookings} reservas`,
    ...p.facts.map((f) => `  - ${f}`),
  ].join("\n")).join("\n\n");
}
