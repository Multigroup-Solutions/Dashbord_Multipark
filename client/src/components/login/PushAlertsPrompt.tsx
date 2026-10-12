/**
 * Plano 56: depois de entrar, o TL e o supervisor veem "Ativar avisos" (para
 * receberem os códigos de entrada no telemóvel). Só com "Entrar com email e
 * código" ligado; uma vez por aparelho.
 */
import { useCodeLoginOption } from "@/lib/loginOptions";
import { PushAlertsBanner } from "./PushAlertsCard";

export function PushAlertsPrompt({ role }: { role: string | null }) {
  // Também mantém atualizado o interruptor guardado (para o getLoginUrl).
  const { codeLogin } = useCodeLoginOption();
  if (!codeLogin || (role !== "team_leader" && role !== "supervisor")) return null;
  return <PushAlertsBanner />;
}
