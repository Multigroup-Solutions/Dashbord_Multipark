/**
 * Páginas públicas e regresso depois do login (P1, 1 out 2026).
 *
 * `/convite/:token` e `/pda/registar` abrem-se SEM sessão. Antes, o filtro
 * global da app pedia dados protegidos também nelas: sem sessão dava 401, a
 * app mandava para o login e o callback voltava sempre para `/` — o convite
 * perdia-se. Agora essas páginas não pedem nada protegido, e o login leva o
 * caminho de volta (`/api/oauth/login?next=…`).
 */

/** Páginas que se abrem sem sessão (o filtro global não pede dados nelas). */
export const PUBLIC_PATH_PREFIXES = ["/convite/", "/pda/registar"] as const;

export function isPublicPath(path: string | null | undefined): boolean {
  const p = String(path ?? "");
  return PUBLIC_PATH_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, "") || p.startsWith(prefix));
}

const MAX_RETURN_PATH = 512;

/**
 * Caminho para onde voltar depois do login, ou null se não for seguro. Só
 * caminhos DESTA app (relativos, sem "//", sem barras invertidas nem espaços
 * ou caracteres de controlo — nada que o browser leia como outro site). Das
 * rotas /api só o /api/file/ (o link da folha no email).
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim();
  if (!p || p.length > MAX_RETURN_PATH) return null;
  if (!p.startsWith("/") || p.startsWith("//")) return null;
  if (/[\\\s\x00-\x1f\x7f]/.test(p)) return null;
  if (p.startsWith("/api/") && !p.startsWith("/api/file/")) return null;
  if (p === "/") return null; // é já o destino por omissão
  return p;
}

/** URL do login com regresso (o cliente usa-a; o servidor valida outra vez). */
export function loginUrlWithReturn(path?: string | null): string {
  const next = safeReturnPath(path);
  return next ? `/api/oauth/login?next=${encodeURIComponent(next)}` : "/api/oauth/login";
}

/**
 * D61 (Jorge, 3 out 2026): num PDA (aparelho partilhado) o login da Google
 * pede SEMPRE para escolher a conta — senão entra com a conta de quem usou o
 * PDA antes. O servidor não sabe que é um PDA (o token do aparelho vive no
 * browser), por isso o link de login leva `pda=1`. PURA.
 */
export function loginUrlForDevice(url: string, isPda: boolean): string {
  if (!isPda) return url;
  return `${url}${url.includes("?") ? "&" : "?"}pda=1`;
}

/**
 * `prompt` do pedido à Google: num PDA, escolher a conta; fora disso, nenhum.
 * 7 out 2026: deixou de pedir "consent" (e o acesso offline) no login. O login
 * só precisa da identidade; com "consent" + offline a Google emitia um token de
 * longa duração a CADA entrada e, no mesmo cliente OAuth, guarda no máximo 100
 * por conta — o mais antigo (o da ligação do Gmail/Calendário) caía sem aviso
 * e aparecia "Religar"; e nos PDA o ecrã de consentimento levava a
 * "Cancelar" → access_denied. PURA.
 */
export function googlePromptFor(pdaParam: unknown): string | null {
  return pdaParam === "1" ? "select_account" : null;
}
