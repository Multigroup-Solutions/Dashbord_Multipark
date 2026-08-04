/**
 * Template WhatsApp de disponibilidade dos extras — constantes + helpers PUROS.
 *
 * Partilhado entre o cliente (defaults do dialog em ExtrasDiaPage) e o servidor
 * (montagem dos componentes do template). Ter isto num só sítio evita o clássico
 * "a UI manda pt_PT e o servidor assume pt" — a divergência de língua é uma das
 * causas do erro 132001 da Meta.
 *
 * Contrato do template (WhatsApp Manager, categoria Utility):
 *   {{1}} = nome do extra   → preenchido AUTOMATICAMENTE, por destinatário
 *   {{2}} = semana/dia      → texto único, escrito no dialog, igual para todos
 */

/** Nome EXATO do template aprovado no WhatsApp Manager. */
export const AVAILABILITY_TEMPLATE_NAME = "disponibilidade_extras";

/**
 * Código de língua Meta. `pt_PT` (português europeu) ≠ `pt_BR` ≠ `pt` — a Meta
 * trata-os como traduções DISTINTAS e devolve 132001 se o template não estiver
 * aprovado exatamente nesta.
 */
export const DEFAULT_TEMPLATE_LANGUAGE = "pt_PT";

/** Nome usado no {{1}} quando o destinatário não é um colaborador conhecido. */
export const UNKNOWN_RECIPIENT_NAME = "Teste";

/** A Meta rejeita parâmetros muito longos; 512 é folgado para nome/semana. */
export const MAX_TEMPLATE_PARAM_LEN = 512;

/**
 * Limpa um valor para poder ir como parâmetro de template.
 *
 * A Meta REJEITA parâmetros com newlines, tabs ou 5+ espaços seguidos
 * (erro 132000/100). Colapsa tudo para um espaço simples e corta ao limite.
 */
export function sanitizeTemplateParam(raw: string, maxLen = MAX_TEMPLATE_PARAM_LEN): string {
  return raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, maxLen);
}

/**
 * Primeiro nome de um nome completo — é assim que o email de disponibilidade
 * já trata os extras ("Olá João,"), por isso o WhatsApp usa o mesmo critério.
 * Devolve null quando não há nada aproveitável.
 */
export function firstNameOf(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const clean = sanitizeTemplateParam(fullName, 64);
  if (!clean) return null;
  return clean.split(" ")[0] || null;
}
