/**
 * Plano 56: depois de entrar, o TL e o supervisor veem "Ativar avisos" (para
 * receberem os códigos de entrada no telemóvel). Só com "Entrar com email e
 * código" ligado; uma vez por aparelho.
 * A2: também num PDA (sessão de PDA): os avisos do PDA são de quem tem a
 * sessão nesse momento e dizem só "Tens um aviso".
 */
import { useCodeLoginOption } from "@/lib/loginOptions";
import { PushAlertsBanner } from "./PushAlertsCard";

export function PushAlertsPrompt({ role, pdaSession }: { role: string | null; pdaSession?: boolean }) {
  // Também mantém atualizado o interruptor guardado (para o getLoginUrl).
  const { codeLogin } = useCodeLoginOption();
  if (!codeLogin || (role !== "team_leader" && role !== "supervisor" && !pdaSession)) return null;
  return <PushAlertsBanner pda={!!pdaSession} />;
}
