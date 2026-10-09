/**
 * Regras PURAS de apresentação do inbox WhatsApp (2026-10-01): avatar com
 * iniciais, separadores de dia na conversa e contagem de filtros ativos.
 * Ficam aqui (e não no componente) para serem testadas em
 * `server/whatsappInboxView.test.ts` sem DOM.
 */
import type { AssigneeFilter, StatusFilter } from "./whatsappConversation";
import type { CityKey } from "./city";
import { lisbonDayOf } from "./lisbonDay";

/** Máximo de conversas que a lista traz (as mais recentes); a pesquisa vai ao servidor. */
export const INBOX_LIST_LIMIT = 300;

/**
 * Filtro de cidade do inbox (2026-10-09): "all" = sem filtro; "none" = conversas
 * sem cidade conhecida (estado real, como na tabela de extras — nunca se adivinha).
 */
export const INBOX_CITY_FILTERS = ["all", "lisboa", "porto", "faro", "none"] as const;
export type InboxCityFilter = (typeof INBOX_CITY_FILTERS)[number];

/**
 * Quantas conversas (as mais recentes) o servidor classifica por cidade quando
 * há filtro. A cidade da ficha usa a morada (texto), por isso não se resolve em
 * SQL: classificam-se estas e devolvem-se as INBOX_LIST_LIMIT mais recentes da
 * cidade pedida.
 */
export const INBOX_CITY_SCAN_LIMIT = 5000;

/**
 * Cidade da PESSOA de uma conversa — regra ÚNICA do filtro. PURA.
 * Ordem: ficha do colaborador (projeto → candidatura → morada, ver
 * server/employeeCity.ts) → lead mais recente com o número (centro de custos)
 * → reserva com o mesmo telefone (só números soltos). Nada → null ("Sem cidade").
 */
export function conversationCityKey(f: {
  employeeCity: CityKey | null;
  leadCity: CityKey | null;
  bookingCity: CityKey | null;
}): CityKey | null {
  return f.employeeCity ?? f.leadCity ?? f.bookingCity ?? null;
}

/** A conversa passa no filtro de cidade? PURA. */
export function matchesCityFilter(cityKey: CityKey | null | undefined, filter: InboxCityFilter): boolean {
  if (filter === "all") return true;
  if (filter === "none") return cityKey == null;
  return cityKey === filter;
}

/** Iniciais para o avatar: 1.ª letra do primeiro e do último nome; número → últimos 2 dígitos. */
export function contactInitials(name: string | null | undefined): string {
  const clean = String(name ?? "").trim();
  if (!clean) return "?";
  // Conversa sem nome conhecido mostra o próprio número — iniciais de "+351…" não dizem nada.
  if (/^\+?[\d\s()-]+$/.test(clean)) {
    const digits = clean.replace(/\D/g, "");
    return digits.slice(-2) || "?";
  }
  const parts = clean.split(/\s+/).filter((p) => /\p{L}/u.test(p));
  if (!parts.length) return clean.slice(0, 1).toUpperCase();
  const first = Array.from(parts[0])[0] ?? "";
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] ?? "" : "";
  return (first + last).toUpperCase();
}

/**
 * Cor DETERMINÍSTICA do avatar a partir de uma chave (nome ou número): a mesma
 * pessoa tem sempre a mesma cor, em qualquer ecrã e em qualquer sessão. A paleta
 * (classes Tailwind) vive no componente `ContactAvatar` — aqui só o índice.
 */
export function avatarToneIndex(key: string | null | undefined, paletteSize: number): number {
  const s = String(key ?? "").trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return paletteSize > 0 ? h % paletteSize : 0;
}

/**
 * Chave do dia (yyyy-mm-dd) de um instante, em hora de LISBOA (17a) — para
 * agrupar a conversa por dias igual em qualquer browser.
 */
export function localDayKey(ms: number): string {
  return lisbonDayOf(ms);
}

/**
 * Rótulo do separador de dia na conversa (estilo WhatsApp), em dias de Lisboa:
 * "Hoje", "Ontem", dia da semana nos últimos 7 dias, senão dd/mm (com o ano se
 * não for o atual).
 */
export function daySeparatorLabel(ms: number, now: number): string {
  const day = lisbonDayOf(ms);
  const today = lisbonDayOf(now);
  // Datas sem hora → meia-noite UTC: a diferença é sempre um número inteiro de dias.
  const diffDays = Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Ontem";
  if (diffDays > 1 && diffDays < 7) {
    const wd = new Date(ms).toLocaleDateString("pt-PT", { weekday: "long", timeZone: "Europe/Lisbon" });
    return wd.charAt(0).toUpperCase() + wd.slice(1);
  }
  const [y, m, d] = day.split("-");
  return y === today.slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${y}`;
}

/** Filtros da lista do inbox (fora a pesquisa, que tem o seu próprio "limpar"). */
export interface InboxListFilters {
  assignee: AssigneeFilter;
  status: StatusFilter;
  intent: string;
  /** Caixa por tema (17f): "all", "geral" (sem caixa) ou a chave da caixa. */
  box: string;
  /** Cidade da pessoa (`conversationCityKey`); aplicada no servidor, antes do LIMIT. */
  city: InboxCityFilter;
  onlyUnread: boolean;
  onlyUrgent: boolean;
  onlyAlerts: boolean;
}

/** Valores por omissão — "limpar filtros" volta aqui. */
export const DEFAULT_INBOX_FILTERS: InboxListFilters = {
  assignee: "all",
  status: "all",
  intent: "all",
  box: "all",
  city: "all",
  onlyUnread: false,
  onlyUrgent: false,
  onlyAlerts: false,
};

/** A conversa está na caixa do filtro? ("geral" = sem caixa). PURA. */
export function matchesBoxFilter(boxKey: string | null | undefined, box: string): boolean {
  if (box === "all") return true;
  if (box === "geral") return !boxKey;
  return boxKey === box;
}

/** Quantos filtros estão diferentes do valor por omissão (badge do botão "Filtros"). */
export function activeInboxFilterCount(f: InboxListFilters): number {
  return (
    (f.assignee !== DEFAULT_INBOX_FILTERS.assignee ? 1 : 0) +
    (f.status !== DEFAULT_INBOX_FILTERS.status ? 1 : 0) +
    (f.intent !== DEFAULT_INBOX_FILTERS.intent ? 1 : 0) +
    (f.box !== DEFAULT_INBOX_FILTERS.box ? 1 : 0) +
    (f.city !== DEFAULT_INBOX_FILTERS.city ? 1 : 0) +
    (f.onlyUnread ? 1 : 0) +
    (f.onlyUrgent ? 1 : 0) +
    (f.onlyAlerts ? 1 : 0)
  );
}
