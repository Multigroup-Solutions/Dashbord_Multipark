export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

/**
 * Mensagem ÚNICA para "esta conta não tem acesso à plataforma".
 *
 * Cobre TODOS os casos em que o login é recusado depois de o Google confirmar
 * a identidade: conta desativada, conta que ainda não foi registada pelo
 * backoffice, ou registada mas sem acesso. É deliberadamente a MESMA em todos
 * eles — mensagens diferentes por caso (a) confundem quem liga a pedir ajuda e
 * (b) revelam a estranhos se um email existe ou não no sistema.
 *
 * Usada pelo servidor (redirect do callback OAuth + erro de sessão) e pelo
 * cliente (banner na página de entrada). NUNCA duplicar o texto.
 */
export const ACCESS_DENIED_MSG =
  'Esta conta não tem acesso à plataforma. Fala com o backoffice para ativarem o teu acesso.';

/** Query param com que o servidor sinaliza `ACCESS_DENIED_MSG` ao cliente. */
export const AUTH_DENIED_PARAM = 'auth';
export const AUTH_DENIED_VALUE = 'denied';
