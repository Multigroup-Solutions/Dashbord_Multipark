/**
 * Lote 45 (Jorge: opção "a"): o "Drive" do menu abre o Google Drive num
 * separador novo. Esta página só aparece a quem chega a /drive por um link
 * (ou se o browser bloquear o separador novo): os mesmos atalhos, num clique.
 * 14 out 2026 ("abre um drive qualquer"): os links levam `authuser` (a conta
 * Google da pessoa) e o primeiro abre o Shared Drive da empresa.
 */
import { ExternalLink, HardDrive } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { useDriveLinkContext } from "@/lib/driveLink";
import { googleDriveUrl, type GoogleDriveView } from "@shared/drive";

const LINKS: ReadonlyArray<{ label: string; view: GoogleDriveView }> = [
  { label: "Drive da empresa", view: "shared" },
  { label: "O meu Drive", view: "my" },
  { label: "Partilhados comigo", view: "sharedWithMe" },
  { label: "Drives partilhados", view: "sharedDrives" },
  { label: "Recentes", view: "recent" },
];

export default function DrivePage() {
  const { user } = useAuth();
  const link = useDriveLinkContext(user);
  // Sem o id do Shared Drive, "Drive da empresa" seria igual a "Drives partilhados": fica só um.
  const links = link.sharedDriveId ? LINKS : LINKS.filter((l) => l.view !== "sharedDrives");
  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-lg font-semibold flex items-center gap-2"><HardDrive className="h-5 w-5" />Drive</h1>
      <Card>
        <CardContent className="p-4 space-y-3 text-sm">
          <p className="text-muted-foreground">
            O Google Drive abre num separador ao lado{link.email ? <>, na conta <strong>{link.email}</strong></> : ", com a conta Google com que estás no browser"}.
          </p>
          <div className="flex flex-wrap gap-2">
            {links.map((l) => {
              const a = <a href={googleDriveUrl(l.view, link)} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4 mr-1" />{l.label}</a>;
              // A entrada principal (Drive da empresa) em destaque; os outros atalhos ao lado.
              return l.view === "shared"
                ? <Button key={l.view} asChild>{a}</Button>
                : <Button key={l.view} variant="outline" asChild>{a}</Button>;
            })}
          </div>
          <p className="text-xs text-muted-foreground">Se abrir noutra conta, entra no Google com essa conta neste browser (ou liga-a no Perfil → Google). Os ficheiros ligados a um cliente, reclamação, tarefa ou colaborador continuam na ficha de cada um (separador Drive).</p>
        </CardContent>
      </Card>
    </div>
  );
}
