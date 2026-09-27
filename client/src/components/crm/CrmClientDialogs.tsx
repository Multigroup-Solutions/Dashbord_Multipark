/**
 * CRM — diálogos da ficha: editar dados, carro, ligação (pessoa ↔ empresa,
 * familiar), juntar com outra ficha e IBAN. Tudo fica no registo de ações.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Search } from "lucide-react";
import { Pill } from "./crmUi";

const AGE_BANDS = ["<25", "25-34", "35-44", "45-54", "55-64", "65+"] as const;
const NONE = "__none";

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={cn("grid gap-1.5", className)}><Label className="text-xs">{label}</Label>{children}</div>;
}

export type EditableClient = {
  id: number; kind: string; displayName: string | null; firstName: string | null; lastName: string | null;
  nif: string | null; taxName: string | null; taxAddress: string | null; address: string | null; zone: string | null;
  gender: string | null; ageBand: string | null; birthDate: string | null; language: string | null;
  isPro: boolean; proDiscount: number | null; originChannel: string | null; tags: string[];
  consentEmail: boolean | null; consentWhatsapp: boolean | null; consentSms: boolean | null;
};

/** Consentimento: sim / não / por saber. */
function Tri({ label, value, onChange }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <Field label={label}>
      <Select value={value == null ? NONE : value ? "1" : "0"} onValueChange={(v) => onChange(v === NONE ? null : v === "1")}>
        <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={NONE}>Por saber</SelectItem><SelectItem value="1">Aceita</SelectItem><SelectItem value="0">Não aceita</SelectItem></SelectContent>
      </Select>
    </Field>
  );
}

export function EditClientDialog({ c, open, onOpenChange, onSaved }: { c: EditableClient; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const init = () => ({
    displayName: c.displayName ?? "", firstName: c.firstName ?? "", lastName: c.lastName ?? "", kind: c.kind as "person" | "company",
    nif: c.nif ?? "", taxName: c.taxName ?? "", taxAddress: c.taxAddress ?? "", address: c.address ?? "", zone: c.zone ?? "",
    gender: c.gender ?? "", ageBand: c.ageBand ?? "", birthDate: c.birthDate ?? "", language: c.language ?? "",
    isPro: c.isPro, proDiscount: c.proDiscount == null ? "" : String(c.proDiscount), originChannel: c.originChannel ?? "",
    tags: c.tags.join(", "), consentEmail: c.consentEmail, consentWhatsapp: c.consentWhatsapp, consentSms: c.consentSms,
  });
  const [f, setF] = useState(init);
  useEffect(() => { if (open) setF(init()); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const up = (p: Partial<ReturnType<typeof init>>) => setF((x) => ({ ...x, ...p }));
  const save = trpc.crm.update.useMutation({ onSuccess: () => { toast.success("Ficha guardada"); onOpenChange(false); onSaved(); }, onError: (e) => toast.error(e.message) });
  const t = (s: string) => (s.trim() ? s.trim() : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Editar ficha N.º {c.id.toLocaleString("pt-PT")}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome a mostrar" className="sm:col-span-2"><Input value={f.displayName} onChange={(e) => up({ displayName: e.target.value })} /></Field>
          <Field label="Nome próprio"><Input value={f.firstName} onChange={(e) => up({ firstName: e.target.value })} /></Field>
          <Field label="Apelido"><Input value={f.lastName} onChange={(e) => up({ lastName: e.target.value })} /></Field>
          <Field label="Tipo">
            <Select value={f.kind} onValueChange={(v) => up({ kind: v as "person" | "company" })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="person">Pessoa</SelectItem><SelectItem value="company">Empresa</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Canal de origem"><Input value={f.originChannel} onChange={(e) => up({ originChannel: e.target.value })} placeholder="ex.: site, telefone, balcão" /></Field>
          <Field label="NIF"><Input value={f.nif} onChange={(e) => up({ nif: e.target.value })} /></Field>
          <Field label="Nome na fatura"><Input value={f.taxName} onChange={(e) => up({ taxName: e.target.value })} /></Field>
          <Field label="Morada na fatura" className="sm:col-span-2"><Input value={f.taxAddress} onChange={(e) => up({ taxAddress: e.target.value })} /></Field>
          <Field label="Morada" className="sm:col-span-2"><Input value={f.address} onChange={(e) => up({ address: e.target.value })} /></Field>
          <Field label="Zona"><Input value={f.zone} onChange={(e) => up({ zone: e.target.value })} placeholder="ex.: Cascais" /></Field>
          <Field label="Língua"><Input value={f.language} onChange={(e) => up({ language: e.target.value })} placeholder="PT, EN, FR…" maxLength={8} /></Field>
          <Field label="Sexo">
            <Select value={f.gender || NONE} onValueChange={(v) => up({ gender: v === NONE ? "" : v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>Por preencher</SelectItem><SelectItem value="F">Feminino</SelectItem><SelectItem value="M">Masculino</SelectItem><SelectItem value="O">Outro</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Faixa etária">
            <Select value={f.ageBand || NONE} onValueChange={(v) => up({ ageBand: v === NONE ? "" : v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>Por preencher</SelectItem>{AGE_BANDS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Data de nascimento"><Input type="date" value={f.birthDate} onChange={(e) => up({ birthDate: e.target.value })} /></Field>
          <div className="flex items-end gap-3">
            <label className="flex h-9 items-center gap-2 text-sm"><Switch checked={f.isPro} onCheckedChange={(v) => up({ isPro: v })} />Cliente Pro</label>
            {f.isPro && <Field label="Desconto Pro (%)" className="flex-1"><Input type="number" min={0} max={100} value={f.proDiscount} onChange={(e) => up({ proDiscount: e.target.value })} /></Field>}
          </div>
          <Tri label="Aceita email" value={f.consentEmail} onChange={(v) => up({ consentEmail: v })} />
          <Tri label="Aceita WhatsApp" value={f.consentWhatsapp} onChange={(v) => up({ consentWhatsapp: v })} />
          <Tri label="Aceita SMS" value={f.consentSms} onChange={(v) => up({ consentSms: v })} />
          <Field label="Etiquetas (separadas por vírgula)" className="sm:col-span-2"><Input value={f.tags} onChange={(e) => up({ tags: e.target.value })} placeholder="viaja em trabalho, lavagem sempre" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate({
            id: c.id,
            patch: {
              displayName: t(f.displayName), firstName: t(f.firstName), lastName: t(f.lastName), kind: f.kind,
              nif: t(f.nif), taxName: t(f.taxName), taxAddress: t(f.taxAddress), address: t(f.address), zone: t(f.zone),
              gender: (t(f.gender) as "F" | "M" | "O" | null), ageBand: (t(f.ageBand) as (typeof AGE_BANDS)[number] | null),
              birthDate: t(f.birthDate), language: t(f.language), isPro: f.isPro,
              proDiscount: f.isPro && f.proDiscount.trim() ? Number(f.proDiscount) : null, originChannel: t(f.originChannel),
              consentEmail: f.consentEmail, consentWhatsapp: f.consentWhatsapp, consentSms: f.consentSms,
              tags: f.tags.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 40),
            },
          })}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type VehicleForm = { id?: number; plate: string; brand: string | null; model: string | null; color: string | null; vehicleType: string | null };

export function VehicleDialog({ clientId, vehicle, open, onOpenChange, onSaved }: { clientId: number; vehicle: VehicleForm | null; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const blank = { plate: "", brand: "", model: "", color: "", vehicleType: "" };
  const [f, setF] = useState(blank);
  useEffect(() => {
    if (open) setF(vehicle ? { plate: vehicle.plate, brand: vehicle.brand ?? "", model: vehicle.model ?? "", color: vehicle.color ?? "", vehicleType: vehicle.vehicleType ?? "" } : blank);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = trpc.crm.contact.useMutation({ onSuccess: () => { onOpenChange(false); onSaved(); }, onError: (e) => toast.error(e.message) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{vehicle?.id ? "Editar carro" : "Acrescentar carro"}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Matrícula" className="col-span-2"><Input value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value.toUpperCase() })} placeholder="AA-12-BB" className="font-mono" /></Field>
          <Field label="Marca"><Input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} /></Field>
          <Field label="Modelo"><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
          <Field label="Cor"><Input value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} placeholder="vermelho" /></Field>
          <Field label="Tipo">
            <Select value={f.vehicleType || NONE} onValueChange={(v) => setF({ ...f, vehicleType: v === NONE ? "" : v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>—</SelectItem><SelectItem value="CAR">Carro</SelectItem><SelectItem value="MOTORCYCLE">Mota</SelectItem><SelectItem value="VAN">Carrinha</SelectItem></SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!f.plate.trim() || save.isPending} onClick={() => save.mutate({
            op: "saveVehicle", clientId, itemId: vehicle?.id, plate: f.plate.trim(),
            brand: f.brand.trim() || null, model: f.model.trim() || null, color: f.color.trim() || null, vehicleType: f.vehicleType || null,
          })}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Procurar outra ficha (nome, email, telefone, matrícula, n.º). */
export function ClientPicker({ excludeId, value, onChange }: { excludeId: number; value: { id: number; name: string | null } | null; onChange: (v: { id: number; name: string | null } | null) => void }) {
  const [text, setText] = useState("");
  const [deb, setDeb] = useState("");
  useEffect(() => { const t = setTimeout(() => setDeb(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const q = trpc.crm.pick.useQuery({ text: deb, excludeId }, { enabled: deb.length >= 2 });
  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-muted px-3 py-2 text-sm">
        <span className="flex-1"><strong>{value.name ?? "Sem nome"}</strong> <span className="text-muted-foreground">· N.º {value.id.toLocaleString("pt-PT")}</span></span>
        <button type="button" className="text-xs font-semibold text-primary" onClick={() => onChange(null)}>Trocar</button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Nome, email, telefone, matrícula ou n.º" className="pl-8" />
      </div>
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {q.isFetching && <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />}
        {(q.data ?? []).map((x) => (
          <button key={x.id} type="button" onClick={() => onChange({ id: x.id, name: x.name })}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">
            <span className="min-w-0 flex-1 truncate"><strong>{x.name ?? "Sem nome"}</strong> <span className="text-xs text-muted-foreground">N.º {x.id.toLocaleString("pt-PT")}{x.email ? ` · ${x.email}` : ""}</span></span>
            {x.isPro && <Pill className="bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">Pro</Pill>}
            {x.kind === "company" && <Pill className="bg-muted text-foreground">Empresa</Pill>}
          </button>
        ))}
        {deb.length >= 2 && !q.isFetching && (q.data ?? []).length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">Nenhuma ficha encontrada.</p>}
      </div>
    </div>
  );
}

/** Tipos de ligação vistos a partir desta ficha. */
const REL_OPTIONS = [
  { id: "employee", label: "Trabalha em (empresa)" },
  { id: "manager", label: "É gestor de (empresa)" },
  { id: "family", label: "Familiar" },
  { id: "other", label: "Outra ligação" },
] as const;

export function RelationDialog({ clientId, open, onOpenChange, onSaved }: { clientId: number; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [other, setOther] = useState<{ id: number; name: string | null } | null>(null);
  const [kind, setKind] = useState<(typeof REL_OPTIONS)[number]["id"]>("employee");
  const [label, setLabel] = useState("");
  const [pays, setPays] = useState(false);
  useEffect(() => { if (open) { setOther(null); setKind("employee"); setLabel(""); setPays(false); } }, [open]);
  const save = trpc.crm.relation.useMutation({ onSuccess: () => { toast.success("Ligação guardada"); onOpenChange(false); onSaved(); }, onError: (e) => toast.error(e.message) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ligar a outra ficha</DialogTitle>
          <DialogDescription>Pessoa e empresa ficam em fichas separadas, ligadas. Fichas ligadas nunca são sugeridas para juntar.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Tipo de ligação">
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{REL_OPTIONS.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Outra ficha"><ClientPicker excludeId={clientId} value={other} onChange={setOther} /></Field>
          {(kind === "family" || kind === "other") && <Field label="Descrição"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "family" ? "irmão, mãe…" : ""} /></Field>}
          {(kind === "employee" || kind === "manager") && <label className="flex items-center gap-2 text-sm"><Switch checked={pays} onCheckedChange={setPays} />A empresa paga as reservas</label>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!other || save.isPending} onClick={() => other && save.mutate({ op: "add", clientId, relatedClientId: other.id, kind, label: label.trim() || null, pays })}>Ligar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MergeDialog({ clientId, clientName, preset, open, onOpenChange, onMerged }: {
  clientId: number; clientName: string | null; preset?: { id: number; name: string | null } | null;
  open: boolean; onOpenChange: (o: boolean) => void; onMerged: (survivorId: number) => void;
}) {
  const [other, setOther] = useState<{ id: number; name: string | null } | null>(null);
  const [keepThis, setKeepThis] = useState(true);
  const [reason, setReason] = useState("");
  useEffect(() => { if (open) { setOther(preset ?? null); setKeepThis(true); setReason(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const merge = trpc.crm.merge.useMutation({ onError: (e) => toast.error(e.message) });
  const survivor = keepThis ? { id: clientId, name: clientName } : other;
  const absorbed = keepThis ? other : { id: clientId, name: clientName };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Juntar fichas</DialogTitle>
          <DialogDescription>Os emails, telefones, carros e reservas passam para a ficha que fica. Fica guardado o que foi movido, para se poder separar.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Juntar esta ficha com"><ClientPicker excludeId={clientId} value={other} onChange={setOther} /></Field>
          {other && (
            <div className="grid gap-2 rounded-lg border p-3 text-sm">
              <Label className="text-xs">Qual fica?</Label>
              {[true, false].map((k) => {
                const s = k ? { id: clientId, name: clientName } : other;
                return (
                  <label key={String(k)} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2", keepThis === k && "border-primary bg-secondary")}>
                    <input type="radio" checked={keepThis === k} onChange={() => setKeepThis(k)} />
                    <span>Fica <strong>{s.name ?? "Sem nome"}</strong> (N.º {s.id.toLocaleString("pt-PT")})</span>
                  </label>
                );
              })}
            </div>
          )}
          <Field label="Motivo (opcional)"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex.: mesmo telefone e matrícula, confirmado com o cliente" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!survivor || !absorbed || merge.isPending} onClick={() => survivor && absorbed && merge.mutate(
            { survivorId: survivor.id, mergedId: absorbed.id, reason: reason.trim() || null },
            { onSuccess: () => { toast.success("Fichas juntas"); onOpenChange(false); onMerged(survivor.id); } },
          )}>
            {merge.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Juntar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function IbanDialog({ clientId, hasIban, open, onOpenChange, onSaved }: { clientId: number; hasIban: boolean; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [iban, setIban] = useState("");
  useEffect(() => { if (open) setIban(""); }, [open]);
  const save = trpc.crm.setIban.useMutation({ onSuccess: () => { toast.success("IBAN guardado"); onOpenChange(false); onSaved(); }, onError: (e) => toast.error(e.message) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>IBAN do cliente</DialogTitle>
          <DialogDescription>Guardado cifrado. Só o backoffice financeiro o vê, e só os últimos 4 dígitos.</DialogDescription>
        </DialogHeader>
        <Field label="IBAN"><Input value={iban} onChange={(e) => setIban(e.target.value.toUpperCase())} placeholder="PT50 …" className="font-mono" /></Field>
        <DialogFooter className="gap-2">
          {hasIban && <Button variant="outline" className="mr-auto text-destructive" disabled={save.isPending} onClick={() => save.mutate({ clientId, iban: null })}>Apagar IBAN</Button>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!iban.trim() || save.isPending} onClick={() => save.mutate({ clientId, iban: iban.trim() })}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
