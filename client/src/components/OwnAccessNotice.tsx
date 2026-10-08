/**
 * Lote 46 (Jorge, 7 out 2026): quando a própria ficha ou a disponibilidade não
 * abrem, a pessoa vê PORQUÊ e o que fazer — em vez de "perfil ainda não
 * criado" ou de um erro genérico. Textos em shared/ownAccess.ts (os mesmos do
 * servidor). O login é só com a Google: tem de ser sempre o mesmo email.
 */
import { MapPin } from "lucide-react";
import { noLinkedRecordMessage, NO_CITY_OWN_MESSAGE } from "@shared/ownAccess";
import { LinkAccountScreen } from "@/components/LinkAccountScreen";

/**
 * A conta Google com que a pessoa entrou não está ligada a nenhuma ficha.
 * 49c (Jorge, 8 out 2026): em vez de só dizer "pede ao RH", o ecrã "Liga a
 * tua conta" — "Sou novo" ou "Já me candidatei com outro email".
 */
export function NoLinkedRecordNotice({ email }: { email?: string | null }) {
  return <LinkAccountScreen email={email} fallbackMessage={noLinkedRecordMessage(email)} />;
}

/** A ficha não tem cidade (centro de custos): o que é da pessoa abre na mesma. */
export function NoCityNotice() {
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-100">
      <MapPin className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
      <span>{NO_CITY_OWN_MESSAGE}</span>
    </div>
  );
}
