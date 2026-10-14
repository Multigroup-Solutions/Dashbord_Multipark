/**
 * Plano 05 — textos e rótulos da identidade partilhada (conta Multipark), usados
 * pelo servidor e pelo cliente.
 */

export const SHARED_LOGIN_MSG = {
  off: "A entrada com a conta Multipark ainda não está ligada. Entra com Google.",
  invalid: "Email ou palavra-passe errados.",
  rateLimited: "Muitas tentativas seguidas. Espera uns minutos e tenta de novo.",
  unavailable: "A conta Multipark não está a responder. Tenta daqui a pouco ou entra com Google.",
  accessRequested: "A tua conta Multipark está certa, mas ainda não tem acesso ao dashboard. Enviámos um pedido ao administrador.",
} as const;

/** Como ficou ligada (users.sharedLinkMethod). */
export const SHARED_LINK_METHOD_LABEL: Record<string, string> = {
  google_shadow: "Google (automático)",
  password: "A própria pessoa (palavra-passe)",
  agent_confirmed: "Ficha + email iguais",
  proposal: "Proposta confirmada no email",
  created: "Conta criada pelo dashboard",
  email_verified: "Email confirmado na Multipark",
  access_request: "Pedido de acesso aprovado",
};

/** Mensagens de recusa das ações de ligação (servidor → toast). */
export const SHARED_LINK_REFUSAL: Record<string, string> = {
  taken: "Essa conta Multipark já está ligada a outra conta do dashboard.",
  linked_elsewhere: "Esta conta do dashboard já está ligada a outra conta Multipark. Um administrador tem de a desligar primeiro.",
  inactive_shared: "A conta Multipark está desativada.",
  missing_user: "Conta do dashboard não encontrada.",
  unavailable: "A conta Multipark não está a responder. Tenta daqui a pouco.",
  not_configured: "A ligação à conta Multipark não está configurada neste servidor.",
  invalid_credentials: "Email ou palavra-passe da conta Multipark errados.",
  account_deactivated: "A conta Multipark está desativada.",
  rate_limited: "Muitas tentativas seguidas. Espera uns minutos.",
  no_shared_account: "Não há conta Multipark com esse email. Usa \"Criar conta Multipark\".",
  already_linked: "Esta conta já está ligada.",
  email_failed: "O email não saiu. Tenta de novo mais tarde.",
  no_email: "Esta conta do dashboard não tem email.",
  exists: "Já existe uma conta Multipark com este email — não se liga sozinha. Usa \"Propor ligação\" (a pessoa confirma no email).",
  invalid: "Link inválido.",
  expired: "O link expirou. Pede uma nova proposta ao administrador.",
  used: "Este link já foi usado.",
  cancelled: "Esta proposta foi cancelada.",
  changed: "A conta Multipark mudou desde a proposta. Pede uma nova.",
  missing: "Pedido não encontrado.",
  decided: "Este pedido já foi decidido.",
};

export const sharedRefusal = (reason: string): string => SHARED_LINK_REFUSAL[reason] ?? "Não foi possível concluir.";
