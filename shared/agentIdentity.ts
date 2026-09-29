/**
 * Que agentes da Multipark podem ser ligados a uma pessoa (ficha). PURO.
 *
 *  - "system", "api", "API User"… são ações automáticas da Multipark: o nome
 *    que lá aparece é o de quem estava do outro lado, por isso o nome bate
 *    com meia equipa e ligava-se a fichas erradas. Nunca são pessoas.
 *  - Agentes de teste, agências e textos de formulário ("NOME DO RESPONSÁVEL
 *    PELA GESTÃO DAS RESERVAS") também não são pessoas.
 */
import { agentListKind } from "./multiparkExports";

const SYSTEM_IDS = new Set(["system", "api", "apiuser", "api user", "webhook", "cron", "admin", "bot", "integration", "import"]);

/** Id de agente que não é uma pessoa (sistema/API). Os reais são ids sem espaços (cuid). PURA. */
export function isSystemAgentId(id: string | null | undefined): boolean {
  const s = String(id ?? "").trim();
  if (!s) return true;
  if (SYSTEM_IDS.has(s.toLowerCase())) return true;
  return /\s/.test(s);
}

const PLACEHOLDER_RE = /(nome do respons[aá]vel|respons[aá]vel pela|gest[aã]o das reservas|preencher|nome do agente|sem nome|^n\/?a$)/i;

/** Nome de agente que não é de uma pessoa (teste, agência, texto de formulário). PURA. */
export function isNonPersonAgentName(name: string | null | undefined, email?: string | null): boolean {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!n) return false;
  if (PLACEHOLDER_RE.test(n)) return true;
  const kind = agentListKind({ name: n, email: email ? String(email).toLowerCase() : null, cities: [] });
  return kind === "teste" || kind === "agencia";
}

/** Pode ser ligado a uma ficha? PURA. */
export function isLinkableAgent(id: string | null | undefined, name?: string | null, email?: string | null): boolean {
  return !isSystemAgentId(id) && !isNonPersonAgentName(name, email);
}
