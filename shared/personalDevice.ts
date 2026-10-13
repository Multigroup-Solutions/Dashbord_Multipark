/**
 * Telemóveis pessoais (Jorge, 13 out 2026) — regras PURAS partilhadas entre o
 * servidor (server/personalDevices.ts) e o cliente (Perfil → Este telemóvel,
 * Operacional → PDAs).
 *
 * Dois tipos de aparelho:
 *  - PDA partilhado (tabela `pdas`): anda de mão em mão entre extras e
 *    condutores; regista-se pelo QR; quem entra fica com ele e com o Zello do
 *    PDA até sair; com "Entrar com email e código", a sessão fica presa ao PDA
 *    e acaba na saída do ponto.
 *  - Telemóvel pessoal (tabela `personal_devices`): o telemóvel de UMA pessoa
 *    (TL, supervisor, qualquer um), registado por ela no próprio aparelho. Não
 *    tem sessão presa, não acaba na saída do ponto, não tem check-ins de PDA
 *    e não tira o Zello a ninguém: o Zello é o da ficha do dono (a conta Zello
 *    instalada no telemóvel). O nome que aparece é o de quem tem sessão nele.
 *
 * Os dois nunca se cruzam: o token do telemóvel pessoal fica no browser com
 * outra chave e noutra tabela; um PDA não passa a pessoal por aqui (só a
 * conversão feita por uma chefia) e um pessoal não lê o QR de um PDA.
 */
import { checkPdaZello, type PdaZelloStatus } from "./pdaZelloMatch";

/** Chave do localStorage do token do telemóvel pessoal (a do PDA é `mp.pda.deviceToken`). */
export const PERSONAL_TOKEN_KEY = "mp.device.personalToken";

/** Token de aparelho (base64url/hex, 16–64). PURA. */
export function isDeviceToken(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v);
}

export const PERSONAL_DEVICE_HELP =
  "Telemóvel de uma pessoa (TL, supervisor, qualquer um). Não é um PDA partilhado: a sessão não fica presa a ele, não acaba na saída do ponto e não tira o Zello a ninguém.";

export const personalIsPdaMsg = (pdaName: string): string =>
  `Este aparelho é o ${pdaName} (PDA partilhado). Um PDA não passa a telemóvel pessoal por aqui: se é mesmo o telemóvel de alguém, uma chefia converte-o em Operacional → PDAs → botão "Pessoal?" nesse PDA.`;

export const personalOtherOwnerMsg = (ownerName: string): string =>
  `Este telemóvel já está registado como pessoal de ${ownerName}. Quem entra nele aparece com o seu nome; para mudar o dono, ${ownerName} (ou uma chefia) carrega primeiro em "Deixar de ser pessoal".`;

export const PDA_ON_PERSONAL_MSG =
  "Este telemóvel está registado como pessoal. Um telemóvel pessoal não passa a PDA partilhado: se é mesmo para ser PDA, carrega primeiro em \"Deixar de ser pessoal\" (Perfil → Este telemóvel) e lê o QR outra vez.";

export const CONVERT_NOT_REGISTERED_MSG =
  "Este PDA ainda não está registado em nenhum aparelho: não há telemóvel para converter. Se for o telemóvel de alguém, essa pessoa regista-o no Perfil → Este telemóvel (e o PDA retira-se).";

export const CONVERT_RACE_MSG = "O PDA mudou de aparelho entretanto. Vê outra vez a lista antes de converter.";

/** "Gelson Manuel Leão Sousa" → "Gelson Sousa". PURA. */
export function shortPersonName(full: string | null | undefined): string {
  const parts = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length <= 2 ? parts.join(" ") : `${parts[0]} ${parts[parts.length - 1]}`;
}

export interface PersonalDeviceNames {
  /** Quem tem sessão nele agora. */
  currentName?: string | null;
  /** Quem lá esteve por último (sessão já fechada). */
  lastName?: string | null;
  /** Quem o registou. */
  ownerName?: string | null;
}

/** De quem é o nome a mostrar: quem tem sessão agora; senão quem lá esteve por último; senão o dono. PURA. */
export function personalDeviceWho(n: PersonalDeviceNames): string | null {
  const who = [n.currentName, n.lastName, n.ownerName].map((x) => String(x ?? "").trim()).find(Boolean);
  return who || null;
}

/** "Telemóvel de Márcia Silva" — o nome de quem lá está. PURA. */
export function personalDeviceTitle(n: PersonalDeviceNames): string {
  const who = personalDeviceWho(n);
  return who ? `Telemóvel de ${shortPersonName(who)}` : "Telemóvel pessoal";
}

/**
 * O Zello do telemóvel: o da ficha do DONO (é a conta Zello instalada nele).
 * Sem dono conhecido (convertido sem escolher a pessoa), o de quem tem sessão
 * nele ou lá esteve por último. Quem entra no telemóvel de outra pessoa não
 * lhe tira nem lhe muda o Zello. PURA.
 */
export function personalDeviceZello(d: { hasOwner: boolean; ownerZello?: string | null; currentZello?: string | null; lastZello?: string | null }): string | null {
  const clean = (z: string | null | undefined) => (String(z ?? "").trim() || null);
  if (d.hasOwner) return clean(d.ownerZello);
  return clean(d.currentZello) ?? clean(d.lastZello);
}

/** Zello do telemóvel pessoal contra a lista do Zello: "sem Zello" não é erro (há quem não use). PURA. */
export interface PersonalZelloCheck { status: Exclude<PdaZelloStatus, "duplicado">; problem: boolean; suggestion: string | null; detail: string }

export function personalZelloCheck(zello: string | null | undefined, personName: string | null | undefined, users: ReadonlyArray<{ name: string }>): PersonalZelloCheck {
  // Um de cada vez: dois telemóveis da mesma pessoa têm o mesmo Zello e não é "repetido".
  const [c] = checkPdaZello([{ id: 0, name: String(personName ?? ""), zelloUsername: zello ?? null }], users);
  const status = (c.status === "duplicado" ? "ok" : c.status) as PersonalZelloCheck["status"];
  if (status === "sem_zello") {
    return { status, problem: false, suggestion: c.suggestion, detail: personName ? `A ficha de ${shortPersonName(personName)} não tem Zello.` : "Sem Zello na ficha." };
  }
  return { status, problem: status !== "ok", suggestion: c.suggestion, detail: c.detail };
}

/** O aparelho parece um telemóvel/tablet (para só propor "Registar este telemóvel" onde faz sentido). PURA. */
export function looksLikePhone(ua: string | null | undefined): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(String(ua ?? ""));
}
