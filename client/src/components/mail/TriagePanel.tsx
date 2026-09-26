// "Por classificar": conversa que entrou por um endereço fora da tabela de
// aliases (ex.: em Bcc, alias novo por configurar). A administração atribui-a
// a uma caixa (opcionalmente por um alias da tabela, e opcionalmente
// acrescentando o endereço à tabela para os próximos emails já chegarem
// classificados). Se o destino tiver pipeline, corre-o nas mensagens.
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Inbox, Loader2 } from "lucide-react";

export function TriagePanel({ threadId, matchedAddress, onDone }: { threadId: number; matchedAddress: string | null; onDone: () => void }) {
  const settings = trpc.mail.settings.list.useQuery(undefined, { staleTime: 5 * 60_000 });
  const [mailbox, setMailbox] = useState("");
  const [alias, setAlias] = useState("none");
  const [remember, setRemember] = useState(false);
  const [address, setAddress] = useState(matchedAddress ?? "");
  const boxes = settings.data?.mailboxes ?? [];
  const current = useMemo(() => boxes.find((b) => b.key === mailbox), [boxes, mailbox]);
  const assign = trpc.mail.threads.assignTriage.useMutation({
    onSuccess: (r) => {
      toast.success(r.processed ? `Classificada — ${r.created} registo(s) criado(s) pelo destino.` : "Classificada.");
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });
  if (settings.isLoading) return <Loader2 className="h-4 w-4 animate-spin" />;
  if (!settings.data) return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/60 dark:bg-amber-950/20 p-2.5 space-y-2">
      <div className="text-xs font-semibold flex items-center gap-1"><Inbox className="h-3.5 w-3.5" /> Por classificar</div>
      <p className="text-xs text-muted-foreground">
        Este email chegou por um endereço que não está na tabela de aliases{matchedAddress ? ` (${matchedAddress})` : " (ex.: em Bcc)"}. Escolhe a caixa — se o destino criar registos (reclamação, perdido…), são criados agora.
      </p>
      <div className="flex flex-wrap gap-1.5 items-center">
        <Select value={mailbox} onValueChange={(v) => { setMailbox(v); setAlias("none"); }}>
          <SelectTrigger className="h-7 w-[180px] text-xs"><SelectValue placeholder="Caixa" /></SelectTrigger>
          <SelectContent>{boxes.filter((b) => b.active).map((b) => <SelectItem key={b.key} value={b.key}>{b.label}</SelectItem>)}</SelectContent>
        </Select>
        {current && (
          <Select value={alias} onValueChange={setAlias}>
            <SelectTrigger className="h-7 w-[220px] text-xs"><SelectValue placeholder="Alias (opcional)" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sem alias (regras da caixa)</SelectItem>
              {current.addresses.map((a) => <SelectItem key={a.address} value={a.address}>{a.address}{a.tag ? ` — ${a.tag}` : ""}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>
      <label className="flex flex-wrap items-center gap-2 text-xs">
        <Switch checked={remember} onCheckedChange={setRemember} />
        Acrescentar este endereço à tabela da caixa
        {remember && <Input value={address} onChange={(e) => setAddress(e.target.value.trim().toLowerCase())} placeholder="alias@dominio.pt" className="h-7 text-xs w-[220px]" />}
      </label>
      <Button size="sm" className="h-7 text-xs" disabled={!mailbox || assign.isPending || (remember && !address)}
        onClick={() => assign.mutate({ id: threadId, mailbox, alias: alias === "none" ? null : alias, addAlias: remember ? address : null })}>
        {assign.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Atribuir à caixa
      </Button>
    </div>
  );
}
