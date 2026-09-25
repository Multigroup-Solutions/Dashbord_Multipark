// Perfil → Google Drive: "Ativar Drive" (autorização incremental, só
// drive.file — a app vê apenas os ficheiros que ela criou ou que escolheres
// com ela). Usado por "Guardar no Drive", "Exportar para Sheets", documentos
// gerados em "O meu Drive" e importação de folhas. O token nunca chega ao
// browser (o Picker recebe um token curto só com drive.file).
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { CheckCircle2, HardDrive, Loader2, Sparkles } from "lucide-react";
import { googleFeaturesHref } from "./GoogleSyncCard";

export function GoogleDriveCard({ returnTo = "/perfil" }: { returnTo?: string }) {
  const q = trpc.googleDrive.status.useQuery(undefined, { staleTime: 30_000 });
  if (q.isLoading) return <div className="bg-card border border-border rounded-2xl p-4"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  const s = q.data;
  if (!s || !s.configured) return null;
  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <HardDrive className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">Google Drive, Docs e Sheets</div>
          <div className="text-[11.5px] text-muted-foreground">
            {s.connected ? "Guardar anexos e documentos no teu Drive, exportar relatórios para o Sheets e gerar documentos." : "Liga primeiro a tua conta Google (acima)."}
          </div>
        </div>
        {s.granted && <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" aria-label="Ativo" />}
      </div>
      {s.connected && !s.needsReauth && !s.granted && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
          <p className="text-xs text-foreground">
            A app só tem acesso aos ficheiros que ela própria cria (pasta "Multipark" no teu Drive) ou que escolhes com ela — nunca ao resto do teu Drive.
            O que já autorizaste mantém-se.
          </p>
          <Button asChild size="sm">
            <a href={googleFeaturesHref(["drive"], returnTo)}><Sparkles className="h-4 w-4 mr-1" />Ativar Drive</a>
          </Button>
        </div>
      )}
      {s.granted && (
        <p className="text-[11.5px] text-muted-foreground">
          Ativo. Os ficheiros que guardares ou exportares ficam na pasta "Multipark" do teu Google Drive.
          {s.sharedEnabled ? " Os documentos da empresa ficam no Shared Drive." : ""}
        </p>
      )}
    </div>
  );
}
