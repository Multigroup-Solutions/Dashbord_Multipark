import { loginUrlWithReturn } from "@shared/loginReturn";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Login URL — redirects to our server which handles Google OAuth.
// `returnTo`: caminho desta app para onde voltar depois de entrar (ex.: o convite).
export const getLoginUrl = (returnTo?: string | null) => loginUrlWithReturn(returnTo);

/** O caminho atual (com a query), para voltar a ele depois do login. */
export const currentPath = () =>
  typeof window === "undefined" ? null : `${window.location.pathname}${window.location.search}`;
