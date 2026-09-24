import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { Link2, Check, X, RefreshCw, ExternalLink } from "lucide-react";
import { fmtPTDate } from "@/lib/lisbonTime";
import { lostFoundSide } from "@shared/commsAi";
import { BASE_PATH, TYPE_CONFIG } from "./config";

function scoreCls(score: number): string {
  if (score >= 75) return "bg-emerald-100 text-emerald-800";
  if (score >= 50) return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

/**
 * "Possíveis correspondências" perdido ↔ achado (pré-filtro por data,
 * matrícula/reserva e parque + semelhança da IA). Confirmar só deixa nota
 * interna nos dois casos: contactar o cliente é sempre uma pessoa.
 */
export function MatchesPanel({ item, canEdit }: { item: any; canEdit: boolean }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const side = lostFoundSide(item);
  const q = trpc.lostFound.matches.useQuery({ id: item.id }, { enabled: !!side, retry: false });
  const recompute = trpc.lostFound.recomputeMatches.useMutation({
    onSuccess: (r) => {
      utils.lostFound.matches.invalidate({ id: item.id });
      toast.info(r.candidates ? `${r.candidates} candidato(s)${r.ai ? "" : " (sem IA: só filtro por data/matrícula/parque)"}` : "Sem candidatos no período");
    },
    onError: () => toast.error("Não foi possível procurar agora"),
  });
  const decide = trpc.lostFound.decideMatch.useMutation({
    onSuccess: (_r, v) => {
      utils.lostFound.matches.invalidate({ id: item.id });
      utils.lostFound.getMessages.invalidate({ itemId: item.id });
      toast.success(v.decision === "confirmed" ? "Confirmada — nota interna nos dois casos. Contacta o cliente." : "Descartada");
    },
    onError: (e) => toast.error(e.message || "Erro ao guardar"),
  });
  if (!side) return null;
  const rows = q.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Link2 className="w-4 h-4 text-violet-600" /> Possíveis correspondências
          <Badge variant="outline" className="text-[11px]">{side === "lost" ? "objetos encontrados" : "perdidos reportados"}</Badge>
          {canEdit && (
            <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs" disabled={recompute.isPending} onClick={() => recompute.mutate({ id: item.id })}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${recompute.isPending ? "animate-spin" : ""}`} /> Procurar
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!rows.length && <p className="text-xs text-muted-foreground">{q.isLoading ? "A carregar…" : "Sem correspondências sugeridas."}</p>}
        {rows.map((m) => (
          <div key={m.id} className="rounded-md border p-2 space-y-1.5">
            <div className="flex items-center gap-1.5 flex-wrap text-sm">
              <Badge className={`${scoreCls(m.score)} text-[11px]`} title={m.aiScore != null ? `IA ${m.aiScore} · filtro ${m.prefilterScore}` : `Filtro ${m.prefilterScore} (sem IA)`}>{m.score}%</Badge>
              <span className="font-medium">#{m.otherId}</span>
              <span className="text-xs text-muted-foreground">{TYPE_CONFIG[m.other.itemType]?.label ?? m.other.itemType}</span>
              {m.other.createdAt && <span className="text-xs text-muted-foreground">· {fmtPTDate(m.other.createdAt)}</span>}
              {m.status === "confirmed" && <Badge className="bg-emerald-100 text-emerald-800 text-[11px]">confirmada</Badge>}
            </div>
            <p className="text-xs line-clamp-3 break-words">{m.other.description}</p>
            {m.reason && <p className="text-[11px] text-muted-foreground break-words">{m.reason}</p>}
            <div className="flex gap-1.5 flex-wrap">
              <Button size="sm" variant="outline" className="h-8" onClick={() => navigate(`${BASE_PATH}/caso/${m.otherId}`)}>
                <ExternalLink className="w-4 h-4 mr-1" /> Abrir
              </Button>
              {canEdit && m.status === "suggested" && (
                <>
                  <Button size="sm" className="h-8" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, matchId: m.id, decision: "confirmed" })}>
                    <Check className="w-4 h-4 mr-1" /> Confirmar
                  </Button>
                  <Button size="sm" variant="outline" className="h-8" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, matchId: m.id, decision: "dismissed" })}>
                    <X className="w-4 h-4 mr-1" /> Descartar
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground">Contactar o cliente é sempre feito por uma pessoa.</p>
      </CardContent>
    </Card>
  );
}
