// Definições → Comunicação: tabela de encaminhamento por alias (admin e super
// admin editam) e remetente dos emails de sistema (Gmail API).
//
// Cada linha = um endereço (qualquer domínio: reservas@skypark.pt,
// info@multibacks.app…) que chega a uma das caixas Gmail ligadas → caixa,
// marca, cidade, destino (pipeline), responsável (pessoa ou equipa),
// etiqueta, ativo. Emails por endereços fora desta tabela vão para
// "Por classificar" na Comunicação.
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Plus, Save, Send, Trash2 } from "lucide-react";
import { ROLE_LABELS, type Role } from "@shared/access";
import {
  MAIL_ALIAS_DESTINATIONS, MAIL_ALIAS_DESTINATION_LABELS, MAIL_BRAND_IDS, MAIL_BRAND_LABELS, MAIL_OWNER_ROLES, brandOfAddress, mailAliasRowSchema,
  type MailAliasRow, type MailboxConfig,
} from "@shared/mail";

type Row = MailAliasRow & { _k: string };
let seq = 0;
const withKey = (r: MailAliasRow): Row => ({ ...r, _k: `r${++seq}` });

export function MailAliasTable({ rows, mailboxes, cities, staff, canEdit }: {
  rows: MailAliasRow[];
  mailboxes: Array<Pick<MailboxConfig, "key" | "label" | "active">>;
  cities: Array<{ id: number; name: string }>;
  staff: Array<{ id: number; name: string; role: string }>;
  canEdit: boolean;
}) {
  const utils = trpc.useUtils();
  const [list, setList] = useState<Row[]>(() => rows.map(withKey));
  const [filter, setFilter] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setList(rows.map(withKey)); }, [rows, dirty]);
  const save = trpc.mail.settings.saveAliases.useMutation({
    onSuccess: (r) => { toast.success(r.changed ? `Tabela guardada (${r.changed} caixa(s) alterada(s)).` : "Sem alterações."); setDirty(false); utils.mail.settings.list.invalidate(); utils.mail.overview.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const update = (k: string, patch: Partial<MailAliasRow>) => { setDirty(true); setList((l) => l.map((r) => (r._k === k ? { ...r, ...patch } : r))); };
  const remove = (k: string) => { setDirty(true); setList((l) => l.filter((r) => r._k !== k)); };
  const add = () => {
    setDirty(true);
    setList((l) => [...l, withKey({ address: "", brand: "multipark", cityId: null, destination: "caixa", owner: null, tag: "", active: true, mailboxKey: mailboxes[0]?.key ?? "" })]);
  };
  const submit = () => {
    const clean: MailAliasRow[] = [];
    for (const r of list) {
      const { _k, ...row } = r;
      const p = mailAliasRowSchema.safeParse(row);
      if (!p.success) { toast.error(`${row.address || "(linha sem endereço)"}: ${p.error.issues[0]?.message ?? "inválida"}`); return; }
      clean.push(p.data);
    }
    save.mutate({ rows: clean });
  };
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => (q ? list.filter((r) => `${r.address} ${r.tag} ${r.mailboxKey}`.toLowerCase().includes(q)) : list), [list, q]);
  const cell = "px-1.5 py-1 align-middle";
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Encaminhamento por alias</CardTitle>
        <div className="flex gap-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar" className="h-8 w-[160px] text-xs" />
          {canEdit && <Button size="sm" variant="outline" onClick={add}><Plus className="h-4 w-4 mr-1" />Alias</Button>}
          {canEdit && <Button size="sm" onClick={submit} disabled={!dirty || save.isPending}>{save.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}Guardar</Button>}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          O dashboard lê o alias pelo qual cada email chegou (Delivered-To → X-Original-To → To → Cc) e aplica esta tabela: caixa, marca, cidade (a conversa fica dessa cidade), destino (cria o registo: reclamação, perdido, crítica…), responsável (pessoa: fica atribuída e é avisada; equipa: quem tem o papel e vê a caixa é avisado) e etiqueta. Endereços fora da tabela vão para "Por classificar".
        </p>
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-xs min-w-[980px]">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className={cell}>Alias</th><th className={cell}>Caixa</th><th className={cell}>Marca</th><th className={cell}>Cidade</th>
                <th className={cell}>Destino</th><th className={cell}>Responsável</th><th className={cell}>Etiqueta</th><th className={cell}>Ativo</th><th className={cell} />
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={9} className="p-3 text-muted-foreground">Sem aliases{q ? " com este filtro" : ""}.</td></tr>}
              {shown.map((r) => (
                <tr key={r._k} className={`border-t ${r.active ? "" : "opacity-60"}`}>
                  <td className={cell}>
                    <Input value={r.address} disabled={!canEdit} className="h-7 text-xs min-w-[190px]" placeholder="reservas@skypark.pt"
                      onChange={(e) => {
                        const address = e.target.value.trim().toLowerCase();
                        const b = brandOfAddress(address);
                        update(r._k, { address, ...(b && !r.address ? { brand: b } : {}) });
                      }} />
                  </td>
                  <td className={cell}>
                    <Select value={r.mailboxKey} onValueChange={(v) => update(r._k, { mailboxKey: v })} disabled={!canEdit}>
                      <SelectTrigger className="h-7 text-xs w-[140px]"><SelectValue placeholder="Caixa" /></SelectTrigger>
                      <SelectContent>{mailboxes.map((m) => <SelectItem key={m.key} value={m.key}>{m.label}{m.active ? "" : " (inativa)"}</SelectItem>)}</SelectContent>
                    </Select>
                  </td>
                  <td className={cell}>
                    <Select value={r.brand} onValueChange={(v) => update(r._k, { brand: v as MailAliasRow["brand"] })} disabled={!canEdit}>
                      <SelectTrigger className="h-7 text-xs w-[110px]"><SelectValue /></SelectTrigger>
                      <SelectContent>{MAIL_BRAND_IDS.map((b) => <SelectItem key={b} value={b}>{MAIL_BRAND_LABELS[b]}</SelectItem>)}</SelectContent>
                    </Select>
                  </td>
                  <td className={cell}>
                    <Select value={r.cityId ? String(r.cityId) : "none"} onValueChange={(v) => update(r._k, { cityId: v === "none" ? null : Number(v) })} disabled={!canEdit}>
                      <SelectTrigger className="h-7 text-xs w-[110px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Todas</SelectItem>
                        {cities.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className={cell}>
                    <Select value={r.destination} onValueChange={(v) => update(r._k, { destination: v as MailAliasRow["destination"] })} disabled={!canEdit}>
                      <SelectTrigger className="h-7 text-xs w-[150px]"><SelectValue /></SelectTrigger>
                      <SelectContent>{MAIL_ALIAS_DESTINATIONS.map((d) => <SelectItem key={d} value={d}>{MAIL_ALIAS_DESTINATION_LABELS[d]}</SelectItem>)}</SelectContent>
                    </Select>
                  </td>
                  <td className={cell}>
                    <Select value={r.owner ?? "none"} onValueChange={(v) => update(r._k, { owner: v === "none" ? null : v })} disabled={!canEdit}>
                      <SelectTrigger className="h-7 text-xs w-[160px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Ninguém</SelectItem>
                        {MAIL_OWNER_ROLES.map((role) => <SelectItem key={role} value={`role:${role}`}>Equipa: {ROLE_LABELS[role as Role] ?? role}</SelectItem>)}
                        {staff.map((u) => <SelectItem key={u.id} value={`user:${u.id}`}>{u.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className={cell}><Input value={r.tag} disabled={!canEdit} maxLength={40} className="h-7 text-xs w-[130px]" placeholder="ex.: Skypark Porto" onChange={(e) => update(r._k, { tag: e.target.value })} /></td>
                  <td className={cell}><Switch checked={r.active} disabled={!canEdit} onCheckedChange={(v) => update(r._k, { active: v })} /></td>
                  <td className={cell}>
                    {canEdit && <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Apagar" onClick={() => remove(r._k)}><Trash2 className="h-3.5 w-3.5" /></Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!canEdit && <p className="text-xs text-muted-foreground">Só a administração (admin e super admin) altera esta tabela.</p>}
      </CardContent>
    </Card>
  );
}

export function SystemSenderCard({ current }: { current: string }) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState(current);
  useEffect(() => setEmail(current), [current]);
  const save = trpc.mail.settings.setSystemSender.useMutation({
    onSuccess: () => { toast.success("Remetente guardado."); utils.mail.settings.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const test = trpc.mail.settings.testSystemSender.useMutation({
    onSuccess: (r) => toast.success(r.sentTo ? `${r.message} Email de teste enviado para ${r.sentTo}.` : r.message),
    onError: (e) => toast.error(e.message),
  });
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Envio de email (Gmail)</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">
          Todos os emails da aplicação saem pela API do Gmail (sem SMTP). Os de sistema (notificações, briefing, escala, tarefas, formação, relatórios) saem desta conta do Workspace — tem de estar na delegação da conta de serviço (gmail.send) — e ficam marcados como automáticos (não aparecem como conversas de clientes). Os emails a clientes saem pelo alias da caixa (reclamacoes@, perdidos@…) quando está em "Enviar email como" na conta de origem.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <Input value={email} onChange={(e) => setEmail(e.target.value.trim().toLowerCase())} className="h-8 w-[260px] text-xs" placeholder="reservas@multipark.pt" />
          <Button size="sm" variant="outline" disabled={!email || email === current || save.isPending} onClick={() => save.mutate({ email })}>
            {save.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}Guardar
          </Button>
          <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}Testar (envia-me um email)
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
