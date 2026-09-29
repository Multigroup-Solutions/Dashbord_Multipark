/**
 * CRM fase 1 — RESUMO de uma ficha a partir das reservas lidas ao vivo da
 * Multipark (server/multiparkDb/crmLive.ts readCrmBookingFacts). É isto que
 * fica na ficha (crm_clients): contagens, datas, cidades, parques, canais e
 * parceiros — nenhuma reserva copiada. PURA.
 */
import { cityLabel, type ParkUse } from "../../shared/crmGeo";
import { plateKey } from "../../shared/crmIdentity";
import type { CrmBookingFact } from "../multiparkDb/crmLive";

/** Estados em que o carro entrou (estadia realizada). */
export const VISITED_STATUSES = ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT", "CHECKED_OUT"] as const;

export interface ClientSummary {
  bookings: number;
  cancelled: number;
  completed: number;
  upcoming: number;
  partnerBookings: number;
  totalSpent: number | null;
  firstVisit: string | null;
  lastVisit: string | null;
  nextCheckIn: string | null;
  /** cidades (etiquetas), separadas por vírgulas — como antes */
  cities: string | null;
  /** cidades em minúsculas ("lisboa,porto") — âmbito e filtros */
  cityKeys: string | null;
  parks: ParkUse[];
  preferredPark: string | null;
  channels: string | null;
  partners: string | null;
  anyPro: boolean;
  /** reservas por matrícula (plateKey) */
  plates: Map<string, number>;
}

const join = (vals: Iterable<string>, sep: string, max: number): string | null => {
  const list = [...new Set([...vals].map((v) => v.trim()).filter(Boolean))].sort();
  let out = list.join(sep);
  while (out.length > max && list.length > 1) { list.pop(); out = list.join(sep); }
  return out ? out.slice(0, max) : null;
};

/**
 * Data da Multipark utilizável numa coluna DATETIME: "AAAA-MM-DD HH:MM:SS"
 * com um ano plausível. Datas escritas mal na Multipark (ano 20260, 0202…)
 * partiam a gravação do lote inteiro no MySQL — ficam de fora. PURA.
 */
export function safeDateTime(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(String(v ?? "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 1990 || y > 2199 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  return m[0];
}

/** Maior valor que cabe em DECIMAL(12,2). */
export const MAX_TOTAL_SPENT = 9_999_999_999.99;

/** Reservas (factos) → resumo. `nowUtc` = "YYYY-MM-DD HH:MM:SS". PURA. */
export function summarizeBookings(facts: readonly CrmBookingFact[], nowUtc: string): ClientSummary {
  let cancelled = 0, completed = 0, upcoming = 0, partnerBookings = 0, spent = 0, anySpent = false, anyPro = false;
  let firstVisit: string | null = null, lastVisit: string | null = null, nextCheckIn: string | null = null;
  const cities = new Set<string>(), cityKeys = new Set<string>(), channels = new Set<string>(), partners = new Set<string>();
  const parks = new Map<string, ParkUse>();
  const plates = new Map<string, number>();
  for (const f0 of facts) {
    const f = { ...f0, checkIn: safeDateTime(f0.checkIn) };
    const st = String(f.status ?? "").toUpperCase();
    const isCancelled = st.includes("CANCEL");
    const visited = (VISITED_STATUSES as readonly string[]).includes(st);
    if (isCancelled) cancelled++;
    if (visited) {
      completed++;
      spent += f.total || 0; anySpent = true;
      if (f.checkIn) {
        if (!firstVisit || f.checkIn < firstVisit) firstVisit = f.checkIn;
        if (!lastVisit || f.checkIn > lastVisit) lastVisit = f.checkIn;
      }
    }
    if (!isCancelled && f.checkIn && f.checkIn > nowUtc) {
      upcoming++;
      if (!nextCheckIn || f.checkIn < nextCheckIn) nextCheckIn = f.checkIn;
    }
    if (f.partnerId || f.pro) partnerBookings++;
    if (f.pro) anyPro = true;
    const label = cityLabel(f.city);
    if (label) { cities.add(label); cityKeys.add(label.toLowerCase()); }
    if (f.origin) channels.add(f.origin);
    if (f.partnerName && !/unknown/i.test(f.partnerName)) partners.add(f.partnerName.replace(/\|/g, "/"));
    if (f.parkName) {
      const p = parks.get(f.parkName) ?? { park: f.parkName, city: label, bookings: 0 };
      p.bookings++;
      parks.set(f.parkName, p);
    }
    const k = plateKey(f.plate);
    if (k) plates.set(k, (plates.get(k) ?? 0) + 1);
  }
  const parkList = [...parks.values()].sort((a, b) => b.bookings - a.bookings || a.park.localeCompare(b.park));
  return {
    bookings: facts.length, cancelled, completed, upcoming, partnerBookings,
    totalSpent: anySpent && Number.isFinite(spent) && Math.abs(spent) <= MAX_TOTAL_SPENT ? Math.round(spent * 100) / 100 : null,
    firstVisit, lastVisit, nextCheckIn,
    cities: join(cities, ",", 128), cityKeys: join(cityKeys, ",", 255),
    parks: parkList, preferredPark: parkList[0]?.park ?? null,
    channels: join(channels, ",", 255), partners: join(partners, "|", 1000),
    anyPro, plates,
  };
}

/** Parques em JSON (≤ 2000 carateres, os mais usados primeiro). PURA. */
export function parksJsonOf(list: ParkUse[]): string | null {
  const l = [...list];
  let json = JSON.stringify(l);
  while (json.length > 1990 && l.length > 1) { l.pop(); json = JSON.stringify(l); }
  return l.length ? json : null;
}
