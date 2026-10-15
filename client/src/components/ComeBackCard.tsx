/**
 * 49c (Jorge, 8 out 2026): quem estava INATIVO (deixou de vir, pode voltar)
 * entra como utilizador e vê no topo de "A minha ficha" e da Disponibilidade:
 * "Bem-vindo de volta — atualiza os teus dados e os teus dias livres" com
 * "Voltei, quero trabalhar" (avisa o RH no sino; sem WhatsApp nem email).
 * O candidato (por aprovar) vê só o estado da candidatura.
 * Não mostra nada a quem está ativo ou não tem ficha.
 */
import { CheckCircle2, Hand, Hourglass, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { canSayComeback, isCandidateFicha } from "@shared/comeback";
import { deactivationKind } from "@shared/deactivationReasons";
import { fmtPTDateTime } from "@/lib/lisbonTime";

export function ComeBackCard() {
  const utils = trpc.useUtils();
  const me = trpc.rh.me.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const comeback = trpc.rh.comeback.useMutation({
    onSuccess: () => {
      toast.success("Avisámos o RH de que queres voltar. Atualiza os teus dias livres na Disponibilidade.");
      utils.rh.me.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const e = me.data?.employee as { isActive?: number | boolean; position?: string | null; deactivationReason?: string | null; comebackRequestedAt?: string | null } | undefined;
  if (!e) return null;

  if (isCandidateFicha({ isActive: e.isActive ?? 1, deactivationReason: e.deactivationReason })) {
    return (
      <div role="status" className="mb-4 flex items-start gap-2 rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950/20 dark:text-sky-100">
        <Hourglass className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
        <span><strong>Candidatura por aprovar.</strong> Preenche os teus dados e carrega os documentos pedidos aqui na ficha. O supervisor revê e o RH aprova; depois a tua conta passa a extra.</span>
      </div>
    );
  }
  if (!canSayComeback({ isActive: e.isActive ?? 1, position: e.position ?? null, deactivationReason: e.deactivationReason })) return null;

  const asked = e.comebackRequestedAt;
  return (
    <div role="region" aria-label="Bem-vindo de volta" className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-100">
      <p className="flex items-center gap-2 font-semibold"><Hand className="w-4 h-4" aria-hidden />Bem-vindo de volta — atualiza os teus dados e os teus dias livres</p>
      <p className="mt-1 text-sm">A tua ficha está inativa. Quando quiseres voltar a trabalhar, carrega no botão: o RH vê o teu pedido e reativa-te.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={comeback.isPending} onClick={() => comeback.mutate()}>
          {comeback.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
          Voltei, quero trabalhar
        </Button>
        {asked && <span className="text-xs">Já avisaste o RH a {fmtPTDateTime(asked)}.</span>}
      </div>
    </div>
  );
}

/**
 * 49c: estado de uma ficha NÃO ativa na lista do RH — "Candidato", "Quer
 * voltar", "Inativo — pode voltar" ou "Desativado" (estes dois só para quem
 * vê o motivo; os outros veem "Inativo" no resto da ficha).
 */
export function PersonStateBadge({ emp, candidate }: { emp: { isActive?: number | boolean | null; deactivationReason?: string | null; comebackRequestedAt?: string | null }; candidate?: boolean }) {
  if (emp.isActive === 1 || emp.isActive === true) return null;
  if (candidate) return <Badge className="text-xs bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200">Candidato</Badge>;
  const kind = emp.deactivationReason ? deactivationKind(emp.deactivationReason) : null;
  return (
    <>
      {emp.comebackRequestedAt && <Badge className="text-xs bg-emerald-600 text-white hover:bg-emerald-600">Quer voltar</Badge>}
      {kind === "inativo" && <Badge variant="secondary" className="text-xs">Inativo — pode voltar</Badge>}
      {kind === "desativado" && <Badge variant="destructive" className="text-xs">Desativado</Badge>}
    </>
  );
}
