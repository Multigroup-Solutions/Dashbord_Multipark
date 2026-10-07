/**
 * Lote 45 (Jorge: opção "a"): o "Drive" do menu abre o Google Drive num
 * separador novo. Esta página só aparece a quem chega a /drive por um link
 * (ou se o browser bloquear o separador novo): os mesmos atalhos, num clique.
 */
import { ExternalLink, HardDrive } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GOOGLE_DRIVE_URL } from "@/components/DashboardLayout";

const LINKS = [
  { label: "O meu Drive", href: GOOGLE_DRIVE_URL },
  { label: "Partilhados comigo", href: "https://drive.google.com/drive/shared-with-me" },
  { label: "Drives partilhados", href: "https://drive.google.com/drive/shared-drives" },
  { label: "Recentes", href: "https://drive.google.com/drive/recent" },
] as const;

export default function DrivePage() {
  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-lg font-semibold flex items-center gap-2"><HardDrive className="h-5 w-5" />Drive</h1>
      <Card>
        <CardContent className="p-4 space-y-3 text-sm">
          <p className="text-muted-foreground">O Google Drive abre num separador ao lado, com a conta Google com que estás no browser.</p>
          <div className="flex flex-wrap gap-2">
            {LINKS.map((l) => (
              <Button key={l.href} variant="outline" asChild>
                <a href={l.href} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4 mr-1" />{l.label}</a>
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Os ficheiros ligados a um cliente, reclamação, tarefa ou colaborador continuam na ficha de cada um (separador Drive).</p>
        </CardContent>
      </Card>
    </div>
  );
}
