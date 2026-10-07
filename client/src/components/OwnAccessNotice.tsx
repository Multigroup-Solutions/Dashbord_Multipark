/**
 * Lote 46 (Jorge, 7 out 2026): quando a própria ficha ou a disponibilidade não
 * abrem, a pessoa vê PORQUÊ e o que fazer — em vez de "perfil ainda não
 * criado" ou de um erro genérico. Textos em shared/ownAccess.ts (os mesmos do
 * servidor). O login é só com a Google: tem de ser sempre o mesmo email.
 */
import { MapPin, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { noLinkedRecordMessage, NO_CITY_OWN_MESSAGE } from "@shared/ownAccess";

/** A conta Google com que a pessoa entrou não está ligada a nenhuma ficha. */
export function NoLinkedRecordNotice({ email }: { email?: string | null }) {
  const { logout } = useAuth();
  return (
    <div className="max-w-md mx-auto py-10 px-4">
      <Card role="status">
        <CardContent className="py-8 space-y-4 text-center">
          <UserX className="w-10 h-10 mx-auto text-amber-600" aria-hidden />
          <h2 className="text-lg font-semibold">A tua conta não está ligada a nenhuma ficha</h2>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{noLinkedRecordMessage(email)}</p>
          <ol className="text-left text-sm space-y-1 list-decimal pl-5">
            <li>Confirma que entraste com o email que deste ao RH. O login é só com a Google e tem de ser sempre com o mesmo email.</li>
            <li>Se tens outra conta Google (a que deste ao RH), sai e entra com essa.</li>
            <li>Se é este o teu email, pede ao RH para o pôr na tua ficha. Depois sai e volta a entrar.</li>
          </ol>
          <Button variant="outline" onClick={() => { Promise.resolve(logout()).finally(() => { window.location.href = "/"; }); }}>
            Sair (para entrar com outra conta)
          </Button>
        </CardContent>
      </Card>
    </div>
  );
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
