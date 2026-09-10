/**
 * Classificação de respostas de disponibilidade (email/WhatsApp) — pura.
 *
 * Antes: `/\b(sim|posso|ok|disponivel)\b/` sem negação → "Não posso" marcava
 * disponível. Agora:
 *   - "yes"   : afirmação sem negação por perto;
 *   - "no"    : negação ("não posso", "não estou disponível", "não dá", "não
 *               consigo", "impossível", "não vou");
 *   - "unclear": ambos, nenhum, ou condicional ("talvez", "se calhar", "só
 *               de manhã", "depende") → vai para revisão humana, NUNCA marca.
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
const CONDITIONAL = /\b(talvez|se calhar|depende|so de|so a partir|so ate|apenas|mas|porem|contudo|nao sei|ainda nao sei|vou ver|se der|se puder)\b/;

export function classifyAvailabilityReply(body: string): { verdict: AvailabilityVerdict; reason: string; excerpt: string } {
  const text = norm(replyOnly(body ?? ""));
  const excerpt = text.slice(0, 160);
  if (!text) return { verdict: "unclear", reason: "sem texto", excerpt };
  const hasNoPhrase = NO_PHRASES.test(text);
  const hasNeg = NEG.test(text);
  const hasYes = YES_TOKENS.test(text);
  const hasCond = CONDITIONAL.test(text);
  if (hasNoPhrase && !hasCond) return { verdict: "no", reason: "negação explícita", excerpt };
  if (hasCond) return { verdict: "unclear", reason: "resposta condicional/indecisa", excerpt };
  if (hasYes && !hasNeg) return { verdict: "yes", reason: "afirmação sem negação nem condição", excerpt };
  if (hasYes && hasNeg) return { verdict: "unclear", reason: "afirmação com negação no texto", excerpt };
  if (hasNeg) return { verdict: "no", reason: "negação", excerpt };
  return { verdict: "unclear", reason: "sem sinal claro", excerpt };
}
