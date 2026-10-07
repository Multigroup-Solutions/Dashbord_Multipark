/**
 * Jorge (7 out 2026): nos Parceiros/Agências, um botão para "ligar o agente
 * Multipark àquele parceiro" — as pessoas que marcam pelo portal da agência
 * passam a contar para essa parceria (agent_partner_map). Nada a ver com os
 * clientes. Ligar/tirar pede Parcerias (gerir); ver pede Parcerias (ver).
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link2, Loader2, Search, X } from "lucide-react";
import { Card } from "@/components/crm/PartnerBlocks";

export function PartnerAgentsCard({ partnership, canManage }: { partnership: { id: number; name: string } | null; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const utils = trpc.useUtils();
  const list = trpc.multipark.partnerAgents.useQuery({ partnershipId: partnership?.id ?? 0 }, { enabled: !!partnership, retry: false });
  const search = trpc.multipark.searchAgentsForPartner.useQuery({ q: q.trim() }, { enabled: open && canManage && q.trim().length >= 2, retry: false });
  const set = trpc.multipark.setAgentPartner.useMutation({
    onSuccess: (_r, v) => {
      toast.success(v.partnershipId ? `${v.agentName} ligado a ${partnership?.name}.` : `${v.agentName} tirado de ${partnership?.name}.`);
      utils.multipark.partnerAgents.invalidate();
      utils.multipark.searchAgentsForPartner.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card title="Agentes da Multipark" action={partnership && canManage ? (
      <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => setOpen((v) => !v)}>
        <Link2 className="h-3.5 w-3.5" />{open ? "Fechar" : "Ligar agente"}
      </Button>
    ) : undefined}>
      {!partnership ? (
        <p className="text-xs text-muted-foreground">Este parceiro ainda não está ligado a um registo das Parcerias. Liga-o primeiro em "No CRM → Nas Parcerias" para lhe juntares agentes.</p>
      ) : list.error ? (
        <p className="text-xs text-rose-700 dark:text-rose-300" role="alert">Não deu para ler os agentes ligados: {list.error.message}</p>
      ) : list.isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          {list.data && list.data.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {list.data.map((a) => (
                <li key={a.agentName} className="flex items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{a.agentName}</span>
                  {canManage && (
                    <Button variant="ghost" size="icon" className="h-6 w-6" title="Tirar deste parceiro" aria-label={`Tirar ${a.agentName}`} disabled={set.isPending}
                      onClick={() => { if (window.confirm(`Tirar ${a.agentName} de ${partnership.name}?`)) set.mutate({ agentName: a.agentName, partnershipId: null }); }}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Nenhum agente ligado a {partnership.name}.</p>
          )}
          {open && canManage && (
            <div className="flex flex-col gap-2 border-t pt-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar agente da Multipark (nome ou email)…" className="h-8 pl-7 text-xs" />
              </div>
              {search.error && <p className="text-xs text-rose-700 dark:text-rose-300" role="alert">{search.error.message}</p>}
              {search.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              {search.data && search.data.length === 0 && <p className="text-xs text-muted-foreground">Nenhum agente com esse nome.</p>}
              <ul className="flex flex-col gap-1">
                {(search.data ?? []).map((a) => {
                  const here = a.partnershipId === partnership.id;
                  return (
                    <li key={a.agentUserId} className="flex items-center gap-2 text-[13px]">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{a.agentName}{!a.active && <span className="text-xs font-normal text-muted-foreground"> · inativo</span>}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {[a.email, a.employeeName ? `ficha: ${a.employeeName}` : null, a.partnerName && !here ? `hoje em ${a.partnerName}` : null].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </div>
                      {here ? <span className="text-xs text-muted-foreground">já ligado</span> : (
                        <Button size="sm" className="h-7 px-2 text-xs" disabled={set.isPending}
                          onClick={() => {
                            if (a.partnerName && !window.confirm(`${a.agentName} está ligado a ${a.partnerName}. Passar para ${partnership.name}?`)) return;
                            set.mutate({ agentName: a.agentName, partnershipId: partnership.id });
                          }}>Ligar</Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
