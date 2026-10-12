import { loginPageUrl, loginUrlForDevice, loginUrlWithReturn } from "@shared/loginReturn";
import { getPdaToken } from "@/lib/pdaDevice";
import { codeLoginCached } from "@/lib/loginOptions";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Login com a Google — redirects to our server which handles Google OAuth.
// `returnTo`: caminho desta app para onde voltar depois de entrar (ex.: o convite).
// D61: num PDA a Google pede sempre para escolher a conta.
export const getGoogleLoginUrl = (returnTo?: string | null) => loginUrlForDevice(loginUrlWithReturn(returnTo), !!getPdaToken());

// Onde se entra: com "Entrar com email e código" ligado (plano 56) é a página
// de entrada (email + palavra-passe, código ou Google); desligado, a Google
// como sempre.
export const getLoginUrl = (returnTo?: string | null) => (codeLoginCached() ? loginPageUrl(returnTo) : getGoogleLoginUrl(returnTo));

/** O caminho atual (com a query), para voltar a ele depois do login. */
export const currentPath = () =>
  typeof window === "undefined" ? null : `${window.location.pathname}${window.location.search}`;
