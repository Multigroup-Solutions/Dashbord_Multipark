/**
 * Classificação de respostas de disponibilidade (email/WhatsApp) — pura.
 *
 * Antes: `/\b(sim|posso|ok|disponivel)\b/` sem negação → "Não posso" marcava
 * disponível. Agora:
 *   - "yes"   : afirmação sem negação por perto;
 *   - "no"    : negação ("não posso", "não estou disponível", "não dá", "não
 *               consigo", "impossível", "não vou");
 *   - "unclear": ambos, nenhum, ou condicional ("talvez", "se calhar", "só
 *               de manhã", "depende", "no máximo", "vou tentar", "posso às
 *               17h") → vai para revisão humana, NUNCA marca.
 * Só se usa o CORPO (não o assunto) e só as primeiras linhas (a citação do
 * pedido original fica de fora).
 */
export type AvailabilityVerdict = "yes" | "no" | "unclear";

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Corta a citação do email original ("On … wrote:", "> ", "Em … escreveu:", assinatura). */
export function replyOnly(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (/^>/.test(l)) break;
    if (/^(on .+wrote:|em .+escreveu:|no dia .+escreveu:|-{2,}\s*(original message|mensagem original)|from:|de:)\s*/i.test(l)) break;
    if (/^--\s*$/.test(l)) break;
    out.push(l);
    if (out.join(" ").length > 400) break;
  }
  return out.join(" ").trim();
}

const NEG = /\b(nao|nunca|jamais|impossivel|infelizmente|nem)\b/;
const NO_PHRASES = /\b(nao posso|nao consigo|nao da|nao vou|nao estou disponivel|nao estarei|nao tenho disponibilidade|nao vai dar|indisponivel|nao da para|nao poderei|nao vou poder|nao vou conseguir)\b/;
const YES_TOKENS = /\b(sim|yes|posso|ok|okay|claro|disponivel|confirmo|conto comigo|estou disponivel|pode contar|la estarei|tudo bem|combinado|bora|vou)\b/;
const CONDITIONAL = /\b(talvez|se calhar|depende|so de|so a partir|so ate|apenas|mas|porem|contudo|nao sei|ainda nao sei|vou ver|se der|se puder|o maximo|no maximo|tentar|so as)\b/;
/** Uma hora no texto: "17h", "17h30", "17 horas", "17:30", "às 17", "das 16", "pelas cinco", "até às 18", "entre 16", "meio-dia". */
const HOUR = /\b\d{1,2}\s*h(?:\d{2}|oras?)?\b|\b\d{1,2}[:.]\d{2}\b|\b(?:as|das|pelas|ate|entre)\s+(?:as\s+)?(?:\d{1,2}|uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\b|\bmeio[ -]dia\b|\bmeia[ -]noite\b/;
/** O que tira a um "confirmo" o valor de confirmação: pergunta, condição, adiamento, horas à parte ou fala da disponibilidade. */
const NOT_PLAIN_CONFIRM = /\?|\b(so|se|depois|logo|mais tarde|quando|ja|amanha confirmo|disponi\w*)\b/;

/**
 * "posso" (não negado) com uma hora é uma condição, não um "sim": "posso às
 * 17h", "posso das 16 às 18", "posso 17:30", "posso 17". "Não posso às 17h"
 * continua a ser um "não"; "Sim, posso segunda" continua a ser um "sim".
 */
function possoWithHour(text: string): boolean {
  if (!/\bposso\b/.test(text.replace(/\bnao posso\b/g, " "))) return false;
  return HOUR.test(text) || /\bposso\s+\d{1,2}\b/.test(text);
}

export function classifyAvailabilityReply(body: string): { verdict: AvailabilityVerdict; reason: string; excerpt: string } {
  const text = norm(replyOnly(body ?? ""));
  const excerpt = text.slice(0, 160);
  if (!text) return { verdict: "unclear", reason: "sem texto", excerpt };
  const hasNoPhrase = NO_PHRASES.test(text);
  const hasNeg = NEG.test(text);
  const hasYes = YES_TOKENS.test(text);
  const hasCond = CONDITIONAL.test(text) || possoWithHour(text);
  if (hasNoPhrase && !hasCond) return { verdict: "no", reason: "negação explícita", excerpt };
  if (hasCond) return { verdict: "unclear", reason: "resposta condicional/indecisa", excerpt };
  if (hasYes && !hasNeg) return { verdict: "yes", reason: "afirmação sem negação nem condição", excerpt };
  if (hasYes && hasNeg) return { verdict: "unclear", reason: "afirmação com negação no texto", excerpt };
  if (hasNeg) return { verdict: "no", reason: "negação", excerpt };
  return { verdict: "unclear", reason: "sem sinal claro", excerpt };
}

/**
 * A pessoa diz mesmo "confirmo", sem negação nem condição? PURA. Só esta palavra
 * responde a um aviso de turno depois de um pedido de disponibilidade: "Sim" e
 * "ok" podem estar a responder ao pedido (server/extrasAutomation.ts).
 */
export function isExplicitShiftConfirm(body: string): boolean {
  const text = norm(replyOnly(body ?? ""));
  if (!/\bconfirmo\b/.test(text) || NOT_PLAIN_CONFIRM.test(text) || HOUR.test(text)) return false;
  return classifyAvailabilityReply(body).verdict === "yes";
}
