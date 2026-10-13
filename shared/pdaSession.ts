/**
 * Plano 56 (A2): a sessão de PDA — regras PURAS partilhadas entre o servidor
 * (server/pdaSession.ts, server/_core/sdk.ts) e o cliente (página de entrada,
 * fim de sessão depois da saída do ponto).
 *
 *  - Só com "Entrar com email e código" (ENTRAR_COM_CODIGO) ligado. Desligado,
 *    os PDAs entram como hoje (Google) e nenhuma sessão muda.
 *  - Quem entra num PDA registado (o `deviceToken` do aparelho validado em
 *    `pdas.deviceToken`) fica com uma "sessão de PDA": um nonce novo em `pdas`
 *    e no cookie. O cookie deixa de valer quando o nonce muda (outra pessoa
 *    entrou), quando se limpa (logout, saída do ponto, fecho automático do
 *    ponto) ou ao fim de 16 h.
 *  - GOOGLE_NOS_PDAS (ligado por omissão): desligado, o botão Google sai dos
 *    PDAs registados — só conta com ENTRAR_COM_CODIGO ligado (senão os PDAs
 *    ficavam sem forma de entrar).
 */

export const GOOGLE_ON_PDAS_FLAG = "GOOGLE_NOS_PDAS";

/** A sessão de PDA dura no máximo isto (o turno mais longo + folga). */
export const PDA_SESSION_HOURS = 16;
export const PDA_SESSION_MS = PDA_SESSION_HOURS * 3_600_000;

/** Depois da saída do ponto, o resumo fica no ecrã este tempo e a sessão termina. */
export const PDA_SESSION_END_SECONDS = 10;

/** No PDA o aviso no telemóvel não diz nada de ninguém: abre a app. */
export const PDA_PUSH = { type: "pda", title: "Multipark", body: "Tens um aviso", url: "/" } as const;

export const PDA_SESSION_FAILED_MSG = "Não foi possível abrir a sessão neste PDA. Tenta outra vez.";
export const GOOGLE_PDAS_NEEDS_CODE_MSG = "Liga primeiro \"Entrar com email e código\": sem ele, os PDAs ficavam sem forma de entrar.";
export const QR_TL_ONLY_MSG = "Só o team leader (ou acima) regista um PDA pelo QR. Pede ao TL de serviço.";

/** Nonce da sessão (base64url, 32–64). PURA. */
export function isPdaNonce(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(v);
}

/** O que está em `pdas` para a sessão aberta neste PDA. */
export interface PdaSessionRow {
  userId: number | null;
  nonce: string | null;
  /** ms (null = sem sessão) */
  startedAt: number | null;
}

/**
 * O cookie com este PDA + nonce ainda vale? Só se o nonce em `pdas` for o do
 * cookie, a conta for a mesma e não tiverem passado 16 h. PURA.
 */
export function pdaSessionOk(row: PdaSessionRow | null | undefined, claims: { userId: number; nonce: string | null | undefined }, now: number): boolean {
  if (!row || !row.nonce || row.startedAt == null || !claims.nonce) return false;
  if (row.nonce !== claims.nonce || row.userId !== claims.userId) return false;
  const age = now - row.startedAt;
  // (uma pequena folga para relógios desacertados entre servidores)
  return age > -5 * 60_000 && age < PDA_SESSION_MS;
}

/**
 * Auditoria A2: a subscrição de avisos de um PDA só recebe enquanto a sessão
 * nesse PDA for de quem a tem — nonce em `pdas`, a mesma conta, menos de 16 h
 * e o PDA ativo. Passaram as 16 h, o PDA foi retirado ou a sessão acabou de
 * outra forma → o PDA não recebe nada dessa pessoa (o aparelho pode já estar
 * nas mãos de outra). PURA.
 */
export function pdaPushLive(row: PdaSessionRow | null | undefined, userId: number, now: number): boolean {
  if (!row || !row.nonce || row.startedAt == null || row.userId !== userId) return false;
  const age = now - row.startedAt;
  return age > -5 * 60_000 && age < PDA_SESSION_MS;
}

/**
 * O botão Google aparece neste aparelho? Fora dos PDAs registados, sempre.
 * Num PDA registado sai só com GOOGLE_NOS_PDAS desligado E a entrada com
 * código ligada (senão o PDA ficava sem forma de entrar). PURA.
 */
export function googleShownOnDevice(o: { registeredPda: boolean; codeLogin: boolean; googleOnPdas: boolean }): boolean {
  return !o.registeredPda || o.googleOnPdas || !o.codeLogin;
}

/** Pode-se desligar o Google nos PDAs? (só com a entrada com código ligada). PURA. */
export function googleOnPdasChangeError(value: boolean | null, codeLogin: boolean): string | null {
  return value === false && !codeLogin ? GOOGLE_PDAS_NEEDS_CODE_MSG : null;
}

/** O resumo da saída do ponto (vem na resposta da própria saída). */
export interface CheckoutSummaryInput {
  hoursWorked?: string | number | null;
  zello?: { km?: number | string | null; maxSpeed?: number | string | null; offlineMinutes?: number | null } | null;
  terminalReleased?: { message: string } | null;
  terminal?: "auto" | "pending" | "partial" | null;
  terminalLabel?: string | null;
}

const hoursText = (h: string | number | null | undefined): string | null => {
  const n = Number(h);
  if (!Number.isFinite(n) || n < 0) return null;
  const whole = Math.floor(n);
  const min = Math.round((n - whole) * 60);
  return min === 60 ? `${whole + 1} h` : min ? `${whole} h ${String(min).padStart(2, "0")}` : `${whole} h`;
};

/** Linhas do resumo que ficam no ecrã antes de a sessão terminar. PURA. */
export function checkoutSummaryLines(r: CheckoutSummaryInput): string[] {
  const out: string[] = [];
  const h = hoursText(r.hoursWorked);
  out.push(h ? `Saída registada: ${h} de trabalho.` : "Saída registada.");
  if (r.zello) {
    const km = Number(r.zello.km);
    const max = Number(r.zello.maxSpeed);
    const parts = [Number.isFinite(km) ? `${km.toFixed(1).replace(".", ",")} km` : null, Number.isFinite(max) && max > 0 ? `velocidade máxima ${Math.round(max)} km/h` : null].filter(Boolean);
    if (parts.length) out.push(`Zello: ${parts.join(" · ")}.`);
    if ((r.zello.offlineMinutes ?? 0) > 10) out.push(`${r.zello.offlineMinutes} min com o Zello desligado.`);
  }
  if (r.terminalReleased?.message) out.push(r.terminalReleased.message);
  if (r.terminal === "partial" && r.terminalLabel) out.push(`${r.terminalLabel}.`);
  if (r.terminal === "pending") out.push("Terminal por confirmar (o RH decide).");
  return out;
}

/** "A sessão termina em 10 s" (contagem decrescente). PURA. */
export function sessionEndsInText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return s > 0 ? `A sessão termina em ${s} s.` : "A sessão terminou.";
}
