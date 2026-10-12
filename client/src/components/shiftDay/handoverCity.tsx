/**
 * Cidade das páginas da operação (Passagem de turno, Atividade diária →
 * Resumo do dia e Semana): só as do centro de custos do utilizador; uma →
 * essa, várias → a última usada (guardada no browser, partilhada pelas
 * páginas). 20d: o link do calendário/aviso (?city=porto) manda.
 * Saiu de ShiftHandoverPage.tsx (12 out 2026) quando o Resumo do dia passou
 * para a Atividade diária.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HANDOVER_CITY_LABELS, allowedHandoverCities, defaultHandoverCity, type HandoverCity } from "@shared/shiftHandover";

const CITY_LABELS: Record<string, string> = HANDOVER_CITY_LABELS;
const LAST_CITY_KEY = "mp.handover.lastCity";

export type CityState = { city: HandoverCity; allowed: HandoverCity[]; setCity: (c: HandoverCity) => void };

/** Cidade da página: só as do centro de custos; uma → essa, várias → a última usada. */
export function useHandoverCity(): {
  city: HandoverCity | null; allowed: HandoverCity[]; setCity: (c: HandoverCity) => void; loading: boolean;
  error: { message: string } | null; retry: () => void; retrying: boolean;
} {
  const { data: access, isLoading, error, refetch, isFetching } = trpc.permissions.myCityAccess.useQuery();
  const allowed = allowedHandoverCities(access);
  const [lastUsed, setLastUsed] = useState<string | null>(() => {
    // 20d: o link do calendário/aviso (?city=porto) manda; senão, a última usada.
    try { return new URLSearchParams(window.location.search).get("city") || localStorage.getItem(LAST_CITY_KEY); } catch { return null; }
  });
  const city = defaultHandoverCity(allowed, lastUsed);
  const setCity = (c: HandoverCity) => {
    setLastUsed(c);
    try { localStorage.setItem(LAST_CITY_KEY, c); } catch { /* armazenamento indisponível */ }
  };
  return { city, allowed, setCity, loading: isLoading, error: error ?? null, retry: () => { void refetch(); }, retrying: isFetching };
}

export function CitySelect({ city, allowed, onChange }: { city: HandoverCity | null; allowed: HandoverCity[]; onChange: (c: HandoverCity) => void }) {
  if (allowed.length <= 1) return <p className="h-9 flex items-center text-sm">📍 {city ? CITY_LABELS[city] : "—"}</p>;
  return (
    <Select value={city ?? undefined} onValueChange={(v) => onChange(v as HandoverCity)}>
      <SelectTrigger className="w-32 h-9"><SelectValue /></SelectTrigger>
      <SelectContent>
        {allowed.map((c) => <SelectItem key={c} value={c}>📍 {CITY_LABELS[c]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
