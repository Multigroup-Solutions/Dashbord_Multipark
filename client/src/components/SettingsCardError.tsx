import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { isForbidden } from "@/lib/queryRetry";

/**
 * Cartão das Definições cuja leitura falhou (20b): diz o quê e deixa tentar de
 * novo, em vez de desaparecer. Sem permissão (FORBIDDEN) continua escondido —
 * o cartão não é para esta pessoa.
 */
export function SettingsCardError({ title, error, onRetry, retrying }: {
  title: string;
  error: { message: string };
  onRetry: () => void;
  retrying?: boolean;
}) {
  if (isForbidden(error)) return null;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent><QueryErrorNote error={error} onRetry={onRetry} retrying={retrying} what="este cartão" /></CardContent>
    </Card>
  );
}
