/**
 * Entrar com email + código + palavra-passe (plano 56, A1) — regras PURAS
 * partilhadas entre o servidor (server/loginCode.ts, server/loginRouter.ts) e
 * o cliente (página de entrada, Perfil, Utilizadores).
 *
 *  - Interruptor ENTRAR_COM_CODIGO (desligado por omissão): desligado, tudo
 *    fica como antes (só Google).
 *  - O código (6 algarismos, 10 min, 5 tentativas) vai para o TL de serviço e
 *    para os supervisores da cidade da pessoa (sem cidade → RH/admins); fica
 *    preso ao aparelho que o pediu (cookie `app_login_nonce`).
 *  - Palavra-passe só para utilizador/extra/condutor; TL e acima entram com
 *    Google. O código também é só para esses papéis, menos num PDA registado
 *    (A2): aí os funcionários entram com código (sem palavra-passe).
 *  - A2: com a definição `login.codeDelivery` = "email" o código vai para o
 *    email da própria pessoa, pela acesso@multipark.pt (falha → TL/supervisor).
 */
import { ROLE_LABELS, isRole, roleRank } from "./access";
import { addDays, lisbonDayOf, lisbonMidnightUtcMs } from "./lisbonDay";

export const LOGIN_CODE_FLAG = "ENTRAR_COM_CODIGO";

/** Cookie httpOnly que prende o código ao aparelho que o pediu. */
export const LOGIN_NONCE_COOKIE = "app_login_nonce";

export const LOGIN_CODE = {
  length: 6,
  /** Validade de cada código. */
  minutes: 10,
  /** Tentativas por código. */
  maxAttempts: 5,
  /** Vida do cookie do aparelho (renova-se a cada pedido). */
  nonceMinutes: 15,
  /** Códigos válidos ao mesmo tempo no mesmo aparelho (os mais recentes). */
  perDevice: 3,
  /** "Pedir outro" só passado este tempo. */
  resendSeconds: 60,
  /** Depois de entrar com um código, pode criar a palavra-passe sem a antiga durante este tempo. */
  setWithoutCurrentMinutes: 15,
  /** Palavras-passe erradas por conta e por dia até bloquear (até ao fim do dia). */
  passwordMaxFailsPerDay: 5,
} as const;

/** Limites (checkRateLimit). */
export const LOGIN_LIMITS = {
  emailDevicePerHour: 5,
  emailPerHour: 15,
  networkPerHour: 200,
  /** Emails que não existem: no máximo isto por dia (no país todo) chega ao RH. */
  unknownPerDay: 60,
  /** Tentativas de código/palavra-passe por rede. */
  verifyNetworkPerHour: 200,
  passwordEmailPerHour: 30,
} as const;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

// ─── Textos (curtos, para quem tem pouca prática) ───────────────────────────

export const CODE_REQUESTED_MSG = "Pedimos o código ao TL e ao supervisor de serviço. Pede-lhes o código de 6 algarismos.";
/** A2, modo "email": o código foi para o email da pessoa (pela acesso@). */
export const CODE_EMAILED_MSG = "Enviámos o código para o teu email. Escreve-o neste aparelho.";
/** A2, modo "email": o email não saiu — o código foi para o TL/supervisor de serviço. */
export const CODE_EMAIL_FAILED_MSG = "Não conseguimos enviar o email agora — pede o código ao TL.";
export const CODE_WRONG_MSG = "Código errado. Confirma os 6 algarismos.";
export const CODE_EXPIRED_MSG = "Código errado ou fora do prazo. Pede um código novo neste aparelho.";
export const PASSWORD_WRONG_MSG = "Email ou palavra-passe errados.";
export const PASSWORD_LOCKED_MSG = "Hoje já não dá para entrar com a palavra-passe (demasiadas tentativas erradas). Entra com um código.";
export const ROLE_GOOGLE_MSG = "Com o teu papel entra-se com Google.";
export const TOO_MANY_MSG = "Muitos pedidos seguidos. Espera um pouco e tenta de novo.";
export const CODE_LOGIN_OFF_MSG = "A entrada com email ainda não está ligada. Entra com Google.";
export const EMAIL_INVALID_MSG = "Escreve o teu email (por exemplo nome@gmail.com).";

// ─── Papéis × forma de entrar ───────────────────────────────────────────────

export type LoginMethod = "google" | "code" | "password";
export const PASSWORD_ROLES = ["user", "extra", "condutor"] as const;

/**
 * A2: funcionários (TL e acima) entram com código só num PDA registado (o
 * `deviceToken` do aparelho validado no servidor). Nunca com palavra-passe.
 */
export const STAFF_CODE_ON_REGISTERED_PDA = true;

/** A2: o código por email sai desta conta própria (DWD), nunca de uma caixa da Comunicação. */
export const LOGIN_CODE_SENDER = "acesso@multipark.pt";

/** Assunto e texto do email com o código (sem link). PURA. */
export function loginCodeEmail(code: string): { subject: string; text: string } {
  const c = formatCode(code);
  return {
    subject: `Código de entrada Multipark: ${c}`,
    text: [
      `O teu código de entrada é ${c}.`,
      "",
      `Escreve-o no aparelho onde pediste. Vale ${LOGIN_CODE.minutes} minutos.`,
      "",
      "Se não foste tu que pediste, ignora este email.",
    ].join("\n"),
  };
}

/** Este papel pode ter/usar palavra-passe? (utilizador, extra, condutor). PURA. */
export function canUsePassword(role: string | null | undefined): boolean {
  return (PASSWORD_ROLES as readonly string[]).includes(String(role ?? ""));
}

/** Este papel pode entrar desta forma? PURA. */
export function methodAllowedForRole(method: LoginMethod, role: string | null | undefined, opts: { registeredPda?: boolean } = {}): boolean {
  if (method === "google") return true;
  if (canUsePassword(role)) return true;
  if (method === "code" && STAFF_CODE_ON_REGISTERED_PDA && opts.registeredPda && roleRank(role) >= roleRank("team_leader")) return true;
  return false;
}

// ─── Email ──────────────────────────────────────────────────────────────────

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Gmail com pontos ou "+" conta como o mesmo ("jo.ao+x@gmail.com" = "joao@gmail.com"). PURA. */
export function gmailCanonical(email: string | null | undefined): string {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  const domain = e.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return e;
  const local = e.slice(0, at).split("+")[0].replace(/\./g, "");
  return `${local}@gmail.com`;
}

/** É um endereço Gmail? (para a comparação canónica em SQL). PURA. */
export function isGmail(email: string | null | undefined): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  return GMAIL_DOMAINS.has(e.slice(e.lastIndexOf("@") + 1));
}

/** Os dois emails são da mesma pessoa? (minúsculas; Gmail sem pontos/"+"). PURA. */
export function sameLoginEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = gmailCanonical(a), y = gmailCanonical(b);
  return !!x && x === y;
}

/** Email nos logs e no ecrã de quem não é o próprio: "an***@gmail.com". PURA. */
export function maskLoginEmail(email: string | null | undefined): string {
  const e = String(email ?? "").trim();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e ? "***" : "sem email";
  return `${e.slice(0, Math.min(2, at))}***${e.slice(at)}`;
}

// ─── Código ─────────────────────────────────────────────────────────────────

/** Só os algarismos (aceita colar "482 913" ou "482-913"). PURA. */
export function cleanCode(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "").slice(0, 12);
}

/** "482913" → "482 913". PURA. */
export function formatCode(code: string): string {
  const c = cleanCode(code);
  return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

/** Título do aviso ao TL/supervisor (o código vai no fim). PURA. */
export function loginCodeTitle(input: { who: string; device?: string | null; code: string }): string {
  const who = String(input.who ?? "").trim() || "alguém";
  const device = String(input.device ?? "").trim();
  return `Código de entrada para ${who}${device ? ` (${device})` : ""}: ${formatCode(input.code)}`.slice(0, 255);
}

/** O código no fim do título do aviso (para o cartão "Códigos de entrada"). PURA. */
export function codeFromLoginCodeTitle(title: string | null | undefined): string | null {
  const m = /:\s(\d{3}) (\d{3})$/.exec(String(title ?? ""));
  return m ? `${m[1]}${m[2]}` : null;
}

export interface DeviceCodeRow {
  id: number;
  codeHash: string;
  /** ms */
  expiresAt: number;
  attempts: number;
  /** ms (null = por usar) */
  usedAt: number | null;
}

/**
 * Códigos que ainda valem neste aparelho: dos `perDevice` mais recentes
 * (pedir outro não anula os anteriores), os que não foram usados, estão no
 * prazo e têm tentativas. `rows` em qualquer ordem. PURA.
 */
export function usableDeviceCodes<T extends DeviceCodeRow>(rows: readonly T[], now: number): T[] {
  return [...rows]
    .sort((a, b) => b.id - a.id)
    .slice(0, LOGIN_CODE.perDevice)
    .filter((r) => r.usedAt == null && r.expiresAt > now && r.attempts < LOGIN_CODE.maxAttempts);
}

/** Aparelho a partir do User-Agent ("Android · Chrome"). PURA. */
export function deviceLabelFromUserAgent(ua: string | null | undefined): string {
  const s = String(ua ?? "");
  if (!s) return "aparelho desconhecido";
  const os = /iPhone|iPad|iPod/i.test(s) ? (/iPad/i.test(s) ? "iPad" : "iPhone")
    : /Android/i.test(s) ? "Android"
    : /Windows/i.test(s) ? "Windows"
    : /Mac OS X|Macintosh/i.test(s) ? "Mac"
    : /Linux/i.test(s) ? "Linux" : "";
  const browser = /EdgA?\//i.test(s) ? "Edge"
    : /SamsungBrowser/i.test(s) ? "Samsung Internet"
    : /OPR\/|Opera/i.test(s) ? "Opera"
    : /Firefox|FxiOS/i.test(s) ? "Firefox"
    : /CriOS|Chrome\//i.test(s) ? "Chrome"
    : /Safari\//i.test(s) ? "Safari" : "";
  return [os, browser].filter(Boolean).join(" · ") || "aparelho desconhecido";
}

// ─── Para quem vai o código ─────────────────────────────────────────────────

export interface DutyPools {
  /** Contas dos TL escalados no turno atual na cidade (extras_dia_assignments). */
  scheduledTeamLeaders: readonly number[];
  /** Supervisores da cidade e se têm o ponto aberto. */
  supervisors: ReadonlyArray<{ userId: number; clockOpen: boolean }>;
  /** RH (quem trata das Leads de Extras) e admins — para quem não tem cidade. */
  rhAdmins: readonly number[];
}

/**
 * Destinatários do código: TL de serviço + supervisores da cidade com ponto
 * aberto (nenhum com ponto → todos os da cidade). Sem cidade, ou sem ninguém
 * na cidade → RH/admins. Nunca a própria pessoa. PURA.
 */
export function pickCodeRecipients(city: string | null, pools: DutyPools, exclude: readonly number[] = []): { userIds: number[]; via: "duty" | "rh" } {
  const out = new Set<number>(exclude);
  const fresh = (ids: readonly number[]) => Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0 && !out.has(id))));
  const rh = () => ({ userIds: fresh(pools.rhAdmins), via: "rh" as const });
  if (!city) return rh();
  const open = pools.supervisors.filter((s) => s.clockOpen).map((s) => s.userId);
  const sups = open.length ? open : pools.supervisors.map((s) => s.userId);
  const list = fresh([...pools.scheduledTeamLeaders, ...sups]);
  return list.length ? { userIds: list, via: "duty" } : rh();
}

/**
 * A2: o código de um FUNCIONÁRIO (só num PDA registado) só vai a quem está ao
 * mesmo nível ou acima — um TL nunca recebe o código de um supervisor ou de um
 * admin (podia entrar como ele). Utilizador/extra/condutor: todos. PURA.
 */
export function codeRecipientsForRole(targetRole: string | null | undefined, ids: readonly number[], roles: ReadonlyMap<number, string>): number[] {
  const need = roleRank(targetRole);
  if (need < roleRank("team_leader")) return [...ids];
  return ids.filter((id) => roleRank(roles.get(id)) >= need);
}

/** "TL Rui", "supervisor Ana", "back office Marta". PURA. */
export function recipientLabel(role: string | null | undefined, name: string | null | undefined): string {
  const r = String(role ?? "");
  const who = String(name ?? "").trim().split(/\s+/).slice(0, 2).join(" ") || "sem nome";
  if (r === "team_leader") return `TL ${who}`;
  const label = isRole(r) ? ROLE_LABELS[r].toLowerCase() : "";
  return label ? `${label === "backoffice" ? "back office" : label === "frontoffice" ? "front office" : label} ${who}` : who;
}

/** Aviso à pessoa: "Entraste com um código enviado a TL X / supervisor Y às 14:05." PURA. */
export function codeUsedNotice(labels: readonly string[], hhmm: string, mode: "duty" | "email" = "duty"): string {
  if (mode === "email") return `Entraste com um código enviado para o teu email às ${hhmm}.`;
  const to = labels.length ? labels.join(" / ") : "quem estava de serviço";
  return `Entraste com um código enviado a ${to} às ${hhmm}.`;
}

// ─── Palavra-passe ──────────────────────────────────────────────────────────

const EASY = new Set([
  "12345678", "123456789", "1234567890", "87654321", "11111111", "00000000", "12341234", "12121212", "11223344",
  "password", "password1", "passw0rd", "palavrapasse", "palavra-passe", "qwertyui", "qwerty123", "azertyui", "asdfghjk",
  "abcdefgh", "abcd1234", "abc12345", "iloveyou", "multipark", "multipark1", "multipark123", "benfica1", "portugal",
  "aeroporto", "parking1", "estacionamento", "senha123", "123qweasd", "1q2w3e4r", "zaq12wsx",
]);

const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

function isValidDate(d: number, m: number, y: number): boolean {
  if (y < 1900 || y > 2099 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Tem uma data ddmmaaaa (ou aaaammdd) seguida? PURA. */
export function containsDate(pw: string): boolean {
  const digits = String(pw ?? "").match(/\d{8,}/g) ?? [];
  for (const run of digits) {
    for (let i = 0; i + 8 <= run.length; i++) {
      const s = run.slice(i, i + 8);
      const [d1, m1, y1] = [Number(s.slice(0, 2)), Number(s.slice(2, 4)), Number(s.slice(4))];
      if (isValidDate(d1, m1, y1)) return true;
      const [y2, m2, d2] = [Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6))];
      if (isValidDate(d2, m2, y2)) return true;
    }
  }
  return false;
}

function isSequence(s: string): boolean {
  if (s.length < 6) return false;
  const codes = Array.from(s).map((c) => c.charCodeAt(0));
  const up = codes.every((c, i) => i === 0 || c === codes[i - 1] + 1);
  const down = codes.every((c, i) => i === 0 || c === codes[i - 1] - 1);
  return up || down;
}

/**
 * O que está mal na palavra-passe (ou null se serve): mínimo 8, não pode ser
 * fácil (12345678, password, só o mesmo carácter, sequências), nem ter o nome
 * (ou o início do email), nem uma data ddmmaaaa. PURA.
 */
export function passwordProblem(pw: string, ctx: { name?: string | null; email?: string | null } = {}): string | null {
  const p = String(pw ?? "");
  if (p.length < PASSWORD_MIN) return `A palavra-passe tem de ter pelo menos ${PASSWORD_MIN} caracteres.`;
  if (p.length > PASSWORD_MAX) return `No máximo ${PASSWORD_MAX} caracteres.`;
  const low = stripAccents(p.toLowerCase());
  const compact = low.replace(/[\s._-]/g, "");
  if (EASY.has(low) || EASY.has(compact) || /^(.)\1+$/.test(compact) || isSequence(compact) || /^(.{1,4})\1+$/.test(compact)) {
    return "Essa palavra-passe é demasiado fácil. Escolhe outra.";
  }
  const letters = compact.replace(/[^a-z]/g, "");
  const nameParts = stripAccents(String(ctx.name ?? "").toLowerCase()).split(/[^a-z]+/).filter((t) => t.length >= 3);
  const local = stripAccents(String(ctx.email ?? "").toLowerCase().split("@")[0] ?? "").replace(/[^a-z]/g, "");
  if (nameParts.some((t) => letters.includes(t)) || (local.length >= 4 && letters.includes(local))) {
    return "Não uses o teu nome (nem o email) na palavra-passe.";
  }
  if (containsDate(p)) return "Não uses uma data (como o dia de anos) na palavra-passe.";
  return null;
}

/** Último segundo de hoje em Lisboa (ms UTC) — o bloqueio da palavra-passe dura até aqui. PURA. */
export function lisbonEndOfDayMs(now: number): number {
  return lisbonMidnightUtcMs(addDays(lisbonDayOf(now), 1)) - 1000;
}

// ─── Conta por usar (criada à mão pelo backoffice) ──────────────────────────

/**
 * Conta de login criada à mão pelo admin e ainda não usada para entrar
 * (`manual_…`). Uma conta fundida noutra (`merged_into_…`) nunca é; uma conta
 * que já entrou com código (`email_…`), com palavra-passe ou ligada a uma
 * Google (googleSub) também não. PURA.
 */
export function isPlaceholderAccount(u: { openId: string; loginMethod: string | null; googleSub?: string | null; hasPassword?: boolean | number | null }): boolean {
  if ((u.loginMethod ?? "").startsWith("merged_into_")) return false;
  if (u.openId.startsWith("email_")) return false;
  if (u.hasPassword === true || Number(u.hasPassword) === 1) return false;
  if (u.googleSub && !u.openId.startsWith("google_")) return false;
  return u.openId.startsWith("manual_") || u.loginMethod === "manual";
}

// ─── "Entra com" (Utilizadores) ─────────────────────────────────────────────

export type EntersWith = "google" | "password" | "code";
export const ENTERS_WITH_LABELS: Record<EntersWith, string> = { google: "Google", password: "Palavra-passe", code: "Código" };

/** Como esta conta entra (Utilizadores → "Entra com"). PURA. */
export function entersWith(u: { openId?: string | null; googleSub?: string | null; hasPassword?: boolean | number | null; loginMethod?: string | null }): EntersWith[] {
  const out: EntersWith[] = [];
  const openId = String(u.openId ?? "");
  if (u.googleSub || openId.startsWith("google_")) out.push("google");
  if (u.hasPassword === true || Number(u.hasPassword) === 1) out.push("password");
  if (openId.startsWith("email_") || u.loginMethod === "email_code" || u.loginMethod === "password") out.push("code");
  return out;
}
