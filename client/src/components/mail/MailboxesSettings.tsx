// Definições → Comunicação: caixas de email partilhadas (só o super admin
// edita; os admins veem), estado das contas Gmail e "Sincronizar agora".
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { MODULES, ROLES, ROLE_LABELS, type Role } from "@shared/access";
import {
  MAILBOX_CITY_RULE_LABELS, MAILBOX_MODULES, MAIL_BRAND_IDS, MAIL_BRAND_LABELS, MAIL_PIPELINES, isMailBrand, mailboxConfigSchema,
  type MailboxConfig, type MailBrand,
} from "@shared/mail";
import { fmtPTDateTime } from "@/lib/lisbonTime";

const EMPTY: MailboxConfig = {
  key: "", label: "", addresses: [{ address: "", brand: "multipark" }], sourceKind: "dwd", sourceEmail: "", sourceUserId: null,
  module: "comunicacao", pipeline: null, cityRule: "all", visibleRoles: [], signatures: {}, catchAll: false, notify: true, active: true, sortOrder: 100,
};

const moduleLabel = (id: string) => MODULES.find((m) => m.id === id)?.label ?? id;

function addressesToText(list: MailboxConfig["addresses"]): string {
  return list.map((a) => `${a.address} ${a.brand}`).join("\n");
}
function textToAddresses(text: string): MailboxConfig["addresses"] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [address, brand] = l.split(/[\s,;]+/);
    return { address: (address ?? "").toLowerCase(), brand: (isMailBrand(brand) ? brand : "multipark") as MailBrand };
  });
}

function MailboxDialog({ initial, isNew, googleUsers, onClose }: {
  initial: MailboxConfig; isNew: boolean; googleUsers: Array<{ userId: number; name: string; email: string }>; onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [m, setM] = useState<MailboxConfig>(initial);
  const [addr, setAddr] = useState(addressesToText(initial.addresses));
  const save = trpc.mail.settings.save.useMutation({
    onSuccess: () => { toast.success("Caixa guardada."); utils.mail.settings.list.invalidate(); utils.mail.overview.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const set = <K extends keyof MailboxConfig>(k: K, v: MailboxConfig[K]) => setM((p) => ({ ...p, [k]: v }));
  const submit = () => {
    const r = mailboxConfigSchema.safeParse({ ...m, addresses: textToAddresses(addr) });
    if (!r.success) { toast.error(r.error.issues.map((i) => i.message).join(" ")); return; }
    save.mutate(r.data);
  };
  const brands = Array.from(new Set(textToAddresses(addr).map((a) => a.brand)));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isNew ? "Nova caixa" : `Caixa: ${initial.label}`}</DialogTitle></DialogHeader>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <div className="space-y-1"><Label className="text-xs">Chave</Label><Input value={m.key} disabled={!isNew} onChange={(e) => set("key", e.target.value.toLowerCase())} placeholder="ex.: info" /></div>
          <div className="space-y-1"><Label className="text-xs">Nome</Label><Input value={m.label} onChange={(e) => set("label", e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Endereços / aliases (um por linha: "email marca")</Label>
            <Textarea rows={4} value={addr} onChange={(e) => setAddr(e.target.value)} className="font-mono text-xs" placeholder={"info@multipark.pt multipark\ninfo@skypark.pt skypark"} />
            <p className="text-[11px] text-muted-foreground">Marcas: {MAIL_BRAND_IDS.join(", ")}. Cada alias tem de estar em "Enviar email como" na conta de origem para se poder responder.</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Conta Google de onde se lê</Label>
            <Select value={m.sourceKind} onValueChange={(v) => set("sourceKind", v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="dwd">Conta do Workspace (delegação)</SelectItem>
                <SelectItem value="user">Conta ligada de um utilizador</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {m.sourceKind === "dwd" ? (
            <div className="space-y-1"><Label className="text-xs">Conta a ler (email real, não alias)</Label><Input value={m.sourceEmail} onChange={(e) => set("sourceEmail", e.target.value.trim().toLowerCase())} placeholder="reservas@multipark.pt" /></div>
          ) : (
            <div className="space-y-1">
              <Label className="text-xs">Utilizador</Label>
              <Select value={m.sourceUserId ? String(m.sourceUserId) : ""} onValueChange={(v) => set("sourceUserId", Number(v))}>
                <SelectTrigger><SelectValue placeholder="Quem ligou a conta" /></SelectTrigger>
                <SelectContent>{googleUsers.map((u) => <SelectItem key={u.userId} value={String(u.userId)}>{u.name} ({u.email})</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Quem vê (módulo da matriz)</Label>
            <Select value={m.module} onValueChange={(v) => set("module", v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{MAILBOX_MODULES.map((id) => <SelectItem key={id} value={id}>{moduleLabel(id)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Cidade</Label>
            <Select value={m.cityRule} onValueChange={(v) => set("cityRule", v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(MAILBOX_CITY_RULE_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Processamento automático (como o IMAP)</Label>
            <Select value={m.pipeline ?? "none"} onValueChange={(v) => set("pipeline", v === "none" ? null : v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nenhum (só caixa)</SelectItem>
                {MAIL_PIPELINES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label className="text-xs">Ordem</Label><Input type="number" value={m.sortOrder} onChange={(e) => set("sortOrder", Number(e.target.value) || 0)} /></div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Só estes papéis (vazio = todos com acesso ao módulo)</Label>
            <div className="flex flex-wrap gap-1.5">
              {ROLES.filter((r) => r !== "user" && r !== "extra" && r !== "condutor").map((r) => {
                const on = m.visibleRoles.includes(r);
                return (
                  <button key={r} type="button" onClick={() => set("visibleRoles", on ? m.visibleRoles.filter((x) => x !== r) : [...m.visibleRoles, r as Role])}
                    className={`text-xs px-2 py-1 rounded border ${on ? "bg-primary text-primary-foreground border-primary" : "bg-card"}`}>{ROLE_LABELS[r as Role]}</button>
                );
              })}
            </div>
          </div>
          {brands.map((b) => (
            <div key={b} className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Assinatura — {MAIL_BRAND_LABELS[b]}</Label>
              <Textarea rows={3} value={m.signatures[b] ?? ""} onChange={(e) => set("signatures", { ...m.signatures, [b]: e.target.value })} className="text-xs" />
            </div>
          ))}
          <label className="flex items-center gap-2 text-xs"><Switch checked={m.active} onCheckedChange={(v) => set("active", v)} /> Ativa</label>
          <label className="flex items-center gap-2 text-xs"><Switch checked={m.notify} onCheckedChange={(v) => set("notify", v)} /> Avisar quando chega conversa nova</label>
          <label className="flex items-center gap-2 text-xs sm:col-span-2"><Switch checked={m.catchAll} onCheckedChange={(v) => set("catchAll", v)} /> Recebe o resto do que chega à conta (sem outra caixa)</label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={submit} disabled={save.isPending}>{save.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MailboxesSettings() {
  const utils = trpc.useUtils();
  const q = trpc.mail.settings.list.useQuery();
  const [editing, setEditing] = useState<{ cfg: MailboxConfig; isNew: boolean } | null>(null);
  const remove = trpc.mail.settings.remove.useMutation({
    onSuccess: () => { toast.success("Caixa apagada."); utils.mail.settings.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const sync = trpc.mail.settings.syncNow.useMutation({
    onSuccess: (r) => { r.ok ? toast.success(`Sincronizado: ${r.stored} email(s) novos${r.done ? "" : " (continua no próximo ciclo)"}.`) : toast.error(r.errors.join(" · ") || "Falhou."); q.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  if (q.isLoading) return <Loader2 className="h-4 w-4 animate-spin" />;
  if (!q.data) return <p className="text-sm text-muted-foreground">{q.error?.message ?? "Sem acesso."}</p>;
  const d = q.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Ligação ao Google Workspace</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1.5">
          <div>Conta de serviço (delegação): {d.env.dwd ? <Badge variant="outline" className="border-emerald-400 text-emerald-700">configurada</Badge> : <Badge variant="outline" className="border-amber-400 text-amber-700">em falta</Badge>}
            {d.env.serviceAccountEmail && <span className="text-xs text-muted-foreground ml-2 break-all">{d.env.serviceAccountEmail}</span>}</div>
          <div>OAuth "Ligar a minha conta Google": {d.env.oauth ? <Badge variant="outline" className="border-emerald-400 text-emerald-700">configurado</Badge> : <Badge variant="outline" className="border-amber-400 text-amber-700">em falta</Badge>}
            <span className="text-xs text-muted-foreground ml-2">domínios: {d.env.domains.join(", ") || "—"}</span></div>
          <div>Push do Gmail (Pub/Sub): {d.env.pushTopic ? "tópico configurado (ligar o interruptor MAIL_PUSH nas Automações)" : "sem tópico — só o cron de 5 em 5 min"}</div>
          <div className="pt-1">
            <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}Sincronizar agora
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Caixas partilhadas</CardTitle>
          {d.canEdit && <Button size="sm" onClick={() => setEditing({ cfg: { ...EMPTY }, isNew: true })}><Plus className="h-4 w-4 mr-1" />Nova caixa</Button>}
        </CardHeader>
        <CardContent className="space-y-2">
          {!d.canEdit && <p className="text-xs text-muted-foreground">Só o super admin altera as caixas.</p>}
          {d.mailboxes.map((m) => (
            <div key={m.key} className="border rounded-lg p-2.5 text-sm flex flex-wrap items-start gap-2">
              <div className="flex-1 min-w-[220px]">
                <div className="font-semibold">{m.label} <span className="text-xs text-muted-foreground font-normal">({m.key})</span> {!m.active && <Badge variant="secondary">inativa</Badge>}</div>
                <div className="text-xs text-muted-foreground break-all">{m.addresses.map((a) => `${a.address} (${MAIL_BRAND_LABELS[a.brand]})`).join(" · ")}</div>
                <div className="text-xs text-muted-foreground">
                  Lê de: {m.sourceKind === "dwd" ? m.sourceEmail : `conta de #${m.sourceUserId}`} · Quem vê: {moduleLabel(m.module)}{m.visibleRoles.length ? ` (só ${m.visibleRoles.map((r) => ROLE_LABELS[r]).join(", ")})` : ""}
                  {m.pipeline ? ` · processa: ${m.pipeline}` : ""}{m.catchAll ? " · apanha o resto" : ""}{m.cityRule === "linked" ? " · por cidade" : ""}
                </div>
              </div>
              {d.canEdit && (
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing({ cfg: m, isNew: false })} aria-label="Editar"><Pencil className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Apagar" onClick={() => { if (window.confirm(`Apagar a caixa "${m.label}"? Os emails guardados ficam, mas deixam de aparecer numa caixa.`)) remove.mutate({ key: m.key }); }}><Trash2 className="h-4 w-4" /></Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Contas a sincronizar</CardTitle></CardHeader>
        <CardContent className="space-y-1.5">
          {d.accounts.length === 0 && <p className="text-xs text-muted-foreground">Ainda nenhuma conta sincronizada.</p>}
          {d.accounts.map((a) => (
            <div key={a.accountKey} className="text-xs border-b pb-1.5 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold break-all">{a.email ?? a.accountKey}</span>
                <span className="text-muted-foreground">{a.ownerUserId ? "conta pessoal" : "delegação"}</span>
                <Badge variant="outline" className={a.status === "ok" ? "border-emerald-400 text-emerald-700" : a.status === "pending" ? "" : "border-red-400 text-red-700"}>{a.status}</Badge>
                <span className="text-muted-foreground">{a.backfillDoneAt ? "importação inicial feita" : a.historyId ? "" : "a importar…"}</span>
                <span className="text-muted-foreground ml-auto">{a.lastSyncAt ? fmtPTDateTime(a.lastSyncAt) : "—"} · {a.messagesStored} emails</span>
              </div>
              {a.lastError && <div className="text-red-700 dark:text-red-300 break-words">{a.lastError}</div>}
            </div>
          ))}
        </CardContent>
      </Card>

      {editing && <MailboxDialog initial={editing.cfg} isNew={editing.isNew} googleUsers={d.googleUsers} onClose={() => setEditing(null)} />}
    </div>
  );
}
