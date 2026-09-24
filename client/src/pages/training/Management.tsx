import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { trpc } from "@/lib/trpc";
import { fmtPTDate } from "@/lib/lisbonTime";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowDown, ArrowUp, Award, BookOpen, CheckCircle, ClipboardList, GraduationCap, Gamepad2, Pencil, Play, Plus,
  Trash2, UserPlus, Users, XCircle,
} from "lucide-react";
import { CAREER_LEVEL_LABELS, CITY_OPTIONS, ITEM_TYPE_LABELS, STATUS_LABELS, TARGET_ROLES, useConfirm } from "./shared";
import { TutorPanel, TutorQuestionsCard } from "./TutorPanel";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";

const ITEM_ICONS: Record<string, any> = { video: Play, manual: BookOpen, exam: GraduationCap, quiz: Gamepad2 };
const cityLabel = (c: string | null | undefined) => CITY_OPTIONS.find((x) => x.id === c)?.label ?? "Sem cidade";

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABELS[status] ?? { label: status, cls: "" };
  return <Badge className={s.cls}>{s.label}</Badge>;
}

// ─── A MINHA FORMAÇÃO ──────────────────────────────────────────────────────

export function MyTrainingTab({ data, onOpenItem }: { data: any; onOpenItem: (item: { itemType: string; itemId: number }) => void }) {
  const assignments: any[] = data?.assignments ?? [];
  if (!data?.employeeId) {
    return <Card><CardContent className="py-12 text-center text-muted-foreground">Sem ficha de colaborador associada — não há formação atribuída.</CardContent></Card>;
  }
  if (!assignments.length) {
    return <Card><CardContent className="py-12 text-center text-muted-foreground">Não tens formação obrigatória atribuída. 🎉</CardContent></Card>;
  }
  return (
    <div className="space-y-4">
      {assignments.map((a) => (
        <Card key={a.id} className={a.status === "overdue" ? "border-red-300" : undefined}>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-lg flex items-center gap-2"><ClipboardList className="w-5 h-5 text-primary" />{a.pathName}</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={a.status} />
                {a.dueAt && a.status !== "completed" && <Badge variant="outline">Prazo: {fmtPTDate(a.dueAt)}</Badge>}
                {a.daysLate > 0 && <Badge className="bg-red-100 text-red-700">{a.daysLate} dia(s) em atraso</Badge>}
                {a.blocksEscala && a.status !== "completed" && <Badge className="bg-amber-100 text-amber-800">Necessária para a escala</Badge>}
              </div>
            </div>
            {a.description && <p className="text-sm text-muted-foreground">{a.description}</p>}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3"><Progress value={a.progress.pct} className="h-2 flex-1" /><span className="text-sm font-medium">{a.progress.requiredDone}/{a.progress.requiredTotal}</span></div>
            <div className="space-y-2">
              {a.items.map((it: any) => {
                const Icon = ITEM_ICONS[it.itemType] ?? BookOpen;
                return (
                  <div key={it.id} className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg border">
                    <div className="flex items-center gap-2 min-w-0">
                      {it.completedAt ? <CheckCircle className="w-5 h-5 text-green-600 shrink-0" /> : <Icon className="w-5 h-5 text-muted-foreground shrink-0" />}
                      <span className={`truncate ${it.completedAt ? "text-muted-foreground line-through" : ""}`}>{it.title}</span>
                      <Badge variant="outline" className="text-xs">{ITEM_TYPE_LABELS[it.itemType] ?? it.itemType}</Badge>
                      {!it.required && <Badge variant="secondary" className="text-xs">Opcional</Badge>}
                    </div>
                    {!it.completedAt && <Button size="sm" variant="outline" onClick={() => onOpenItem(it)}>{it.itemType === "exam" || it.itemType === "quiz" ? "Fazer" : "Abrir"}</Button>}
                  </div>
                );
              })}
            </div>
            <TutorPanel context={{ type: "path", id: a.pathId }} defaultOpen={false} title={`Tutor — ${a.pathName}`} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── PERCURSOS (admin) ─────────────────────────────────────────────────────

type PathForm = { id: number | null; name: string; description: string; targetRole: string; city: string; dueDays: string; active: boolean; isDefaultOnboarding: boolean; blocksEscala: boolean };
const emptyPath: PathForm = { id: null, name: "", description: "", targetRole: "extra", city: "", dueDays: "7", active: true, isDefaultOnboarding: false, blocksEscala: true };
type EditItem = { itemType: "video" | "manual" | "exam" | "quiz"; itemId: number; required: boolean; title: string };

export function PathsAdminTab({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<PathForm | null>(null);
  const [itemsFor, setItemsFor] = useState<{ pathId: number; name: string; items: EditItem[] } | null>(null);
  const [assignFor, setAssignFor] = useState<{ pathId: number; name: string } | null>(null);
  const [confirm, confirmUi] = useConfirm();
  const { data: paths = [], refetch } = trpc.training.paths.useQuery({ includeInactive: true });
  const onErr = (e: { message: string }) => toast.error(e.message);
  const refresh = () => { refetch(); void utils.training.myTraining.invalidate(); };
  const createPath = trpc.training.createPath.useMutation({ onSuccess: () => { refresh(); setForm(null); toast.success("Percurso criado — adiciona os itens"); }, onError: onErr });
  const updatePath = trpc.training.updatePath.useMutation({ onSuccess: () => { refresh(); setForm(null); toast.success("Percurso atualizado"); }, onError: onErr });
  const deletePath = trpc.training.deletePath.useMutation({ onSuccess: () => { refresh(); toast.success("Percurso eliminado"); }, onError: onErr });
  const setItems = trpc.training.setPathItems.useMutation({ onSuccess: () => { refresh(); setItemsFor(null); toast.success("Itens guardados"); }, onError: onErr });
  const bulk = trpc.training.assignToActiveExtras.useMutation({ onSuccess: (r) => { refresh(); toast.success(`Atribuído: ${r.created} novo(s) de ${r.total} extras ativos`); }, onError: onErr });

  const savePath = () => {
    if (!form) return;
    const payload = {
      name: form.name, description: form.description || null, targetRole: form.targetRole || null, city: (form.city || null) as any,
      dueDays: Math.max(1, Number(form.dueDays) || 7), active: form.active, isDefaultOnboarding: form.isDefaultOnboarding, blocksEscala: form.blocksEscala,
    };
    if (form.id) updatePath.mutate({ id: form.id, ...payload }); else createPath.mutate(payload);
  };

  return (
    <div className="space-y-4">
      {confirmUi}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2"><ClipboardList className="w-5 h-5" />Percursos de formação</h2>
          <p className="text-sm text-muted-foreground">O percurso marcado como <b>onboarding por defeito</b> é atribuído automaticamente a cada extra novo (lead convertido ou candidatura aprovada).</p>
        </div>
        {isAdmin && <Button onClick={() => setForm({ ...emptyPath })}><Plus className="w-4 h-4 mr-1" />Novo percurso</Button>}
      </div>

      {paths.length === 0 ? <Card><CardContent className="py-12 text-center text-muted-foreground">Ainda não há percursos. Cria o percurso de onboarding dos extras.</CardContent></Card> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(paths as any[]).map((p) => (
            <Card key={p.id} className={!p.active ? "opacity-60" : undefined}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  <div className="flex flex-wrap gap-1">
                    {p.isDefaultOnboarding ? <Badge className="bg-blue-100 text-blue-800">Onboarding por defeito</Badge> : null}
                    {p.blocksEscala ? <Badge className="bg-amber-100 text-amber-800">Bloqueia escala</Badge> : null}
                    {!p.active && <Badge variant="outline">Inativo</Badge>}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {TARGET_ROLES.find((r) => r.id === p.targetRole)?.label ?? "Todos"} · {p.city ? cityLabel(p.city) : "Todas as cidades"} · prazo {p.dueDays} dias · {p.assignedCount} atribuído(s)
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {p.items.length === 0 ? <p className="text-sm text-muted-foreground">Sem itens.</p> : (
                  <ol className="space-y-1 text-sm list-decimal pl-5">
                    {p.items.map((it: any) => <li key={it.id}><Badge variant="outline" className="text-xs mr-1">{ITEM_TYPE_LABELS[it.itemType]}</Badge>{it.title}{!it.required && <span className="text-xs text-muted-foreground"> (opcional)</span>}</li>)}
                  </ol>
                )}
                <div className="flex flex-wrap gap-2">
                  {isAdmin && <Button size="sm" variant="outline" onClick={() => setItemsFor({ pathId: p.id, name: p.name, items: p.items.map((i: any) => ({ itemType: i.itemType, itemId: i.itemId, required: !!i.required, title: i.title })) })}><ClipboardList className="w-4 h-4 mr-1" />Itens</Button>}
                  {isAdmin && <Button size="sm" variant="outline" onClick={() => setForm({ id: p.id, name: p.name, description: p.description ?? "", targetRole: p.targetRole ?? "", city: p.city ?? "", dueDays: String(p.dueDays), active: !!p.active, isDefaultOnboarding: !!p.isDefaultOnboarding, blocksEscala: !!p.blocksEscala })}><Pencil className="w-4 h-4 mr-1" />Editar</Button>}
                  <Button size="sm" variant="outline" disabled={!p.active} onClick={() => setAssignFor({ pathId: p.id, name: p.name })}><UserPlus className="w-4 h-4 mr-1" />Atribuir</Button>
                  {isAdmin && <Button size="sm" variant="outline" disabled={!p.active || bulk.isPending} onClick={async () => {
                    if (await confirm({ title: "Atribuir a todos os extras ativos?", description: `"${p.name}" é atribuído a todos os extras ativos da tua cidade que ainda não o tenham (prazo: ${p.dueDays} dias a partir de hoje).`, confirmLabel: "Atribuir a todos" })) bulk.mutate({ pathId: p.id });
                  }}><Users className="w-4 h-4 mr-1" />Atribuir a todos os extras ativos</Button>}
                  {isAdmin && <Button size="sm" variant="ghost" className="text-destructive" onClick={async () => {
                    if (p.assignedCount > 0) { toast.error(`Tem ${p.assignedCount} atribuição(ões) — desativa-o em vez de apagar.`); return; }
                    if (await confirm({ title: `Eliminar o percurso "${p.name}"?`, confirmLabel: "Eliminar", destructive: true })) deletePath.mutate({ id: p.id });
                  }}><Trash2 className="w-4 h-4" /></Button>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{form?.id ? "Editar percurso" : "Novo percurso"}</DialogTitle></DialogHeader>
          {form && (
            <div className="space-y-3">
              <div><Label>Nome</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Onboarding extras" /></div>
              <div><Label>Descrição</Label><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><Label>Função</Label>
                  <Select value={form.targetRole || "all"} onValueChange={(v) => setForm({ ...form, targetRole: v === "all" ? "" : v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="all">Todas</SelectItem>{TARGET_ROLES.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div><Label>Cidade</Label>
                  <Select value={form.city || "all"} onValueChange={(v) => setForm({ ...form, city: v === "all" ? "" : v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="all">Todas</SelectItem>{CITY_OPTIONS.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div><Label>Prazo (dias)</Label><Input type="number" min={1} value={form.dueDays} onChange={(e) => setForm({ ...form, dueDays: e.target.value })} /></div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2"><Switch id="p-def" checked={form.isDefaultOnboarding} onCheckedChange={(v) => setForm({ ...form, isDefaultOnboarding: v })} /><Label htmlFor="p-def">Onboarding por defeito (auto-atribuído a extras novos)</Label></div>
                <div className="flex items-center gap-2"><Switch id="p-blk" checked={form.blocksEscala} onCheckedChange={(v) => setForm({ ...form, blocksEscala: v })} /><Label htmlFor="p-blk">Obrigatório para ser escalado</Label></div>
                <div className="flex items-center gap-2"><Switch id="p-act" checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} /><Label htmlFor="p-act">Ativo</Label></div>
              </div>
              <Button className="w-full" disabled={!form.name || createPath.isPending || updatePath.isPending} onClick={savePath}>Guardar</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {itemsFor && <PathItemsDialog value={itemsFor} onClose={() => setItemsFor(null)} pending={setItems.isPending}
        onSave={(items) => setItems.mutate({ pathId: itemsFor.pathId, items: items.map(({ itemType, itemId, required }) => ({ itemType, itemId, required })) })} />}
      {assignFor && <AssignDialog value={assignFor} onClose={() => setAssignFor(null)} onDone={refresh} />}
    </div>
  );
}

function PathItemsDialog({ value, onClose, onSave, pending }: { value: { name: string; items: EditItem[] }; onClose: () => void; onSave: (items: EditItem[]) => void; pending: boolean }) {
  const [items, setItems] = useState<EditItem[]>(value.items);
  const [addType, setAddType] = useState<EditItem["itemType"]>("video");
  const [addId, setAddId] = useState("");
  const { data: videos = [] } = trpc.training.videos.useQuery({});
  const { data: manuals = [] } = trpc.training.manuals.useQuery({});
  const { data: exams = [] } = trpc.training.careerExams.useQuery();
  const { data: categories = [] } = trpc.training.categories.useQuery();
  const options = useMemo(() => {
    if (addType === "video") return (videos as any[]).map((v) => ({ id: v.id, title: v.title }));
    if (addType === "manual") return (manuals as any[]).map((m) => ({ id: m.id, title: m.title + (m.published === 0 ? " (não publicado)" : "") }));
    if (addType === "exam") return (exams as any[]).map((e) => ({ id: e.id, title: `${e.title} (${CAREER_LEVEL_LABELS[e.level] ?? e.level})` }));
    return [{ id: 0, title: "Quiz (qualquer categoria) — ≥70%" }, ...(categories as any[]).map((c) => ({ id: c.id, title: `Quiz — ${c.name} — ≥70%` }))];
  }, [addType, videos, manuals, exams, categories]);
  const move = (i: number, d: number) => setItems((p) => { const a = [...p]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Itens — {value.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {items.length === 0 && <p className="text-sm text-muted-foreground">Sem itens. Adiciona vídeos, manuais, exames ou quiz.</p>}
          {items.map((it, i) => (
            <div key={`${it.itemType}-${it.itemId}`} className="flex flex-wrap items-center gap-2 p-2 border rounded-lg">
              <span className="text-sm font-medium w-6">{i + 1}.</span>
              <Badge variant="outline" className="text-xs">{ITEM_TYPE_LABELS[it.itemType]}</Badge>
              <span className="text-sm flex-1 min-w-0 truncate">{it.title}</span>
              <label className="flex items-center gap-1 text-xs"><Checkbox checked={it.required} onCheckedChange={(v) => setItems((p) => p.map((x, j) => j === i ? { ...x, required: !!v } : x))} />Obrigatório</label>
              <Button size="icon" variant="ghost" className="h-7 w-7" disabled={i === 0} onClick={() => move(i, -1)} title="Subir"><ArrowUp className="w-4 h-4" /></Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" disabled={i === items.length - 1} onClick={() => move(i, 1)} title="Descer"><ArrowDown className="w-4 h-4" /></Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setItems((p) => p.filter((_, j) => j !== i))} title="Remover"><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-2 border-t pt-3">
            <div className="w-32"><Label>Tipo</Label>
              <Select value={addType} onValueChange={(v) => { setAddType(v as any); setAddId(""); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{(["video", "manual", "exam", "quiz"] as const).map((t) => <SelectItem key={t} value={t}>{ITEM_TYPE_LABELS[t]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="flex-1 min-w-[12rem]"><Label>Item</Label>
              <Select value={addId} onValueChange={setAddId}>
                <SelectTrigger><SelectValue placeholder="Escolher…" /></SelectTrigger>
                <SelectContent>{options.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.title}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <Button variant="outline" disabled={addId === ""} onClick={() => {
              const id = Number(addId);
              if (items.some((x) => x.itemType === addType && x.itemId === id)) { toast.error("Esse item já está no percurso"); return; }
              setItems((p) => [...p, { itemType: addType, itemId: id, required: true, title: options.find((o) => o.id === id)?.title ?? "" }]);
              setAddId("");
            }}><Plus className="w-4 h-4 mr-1" />Adicionar</Button>
          </div>
          <Button className="w-full" disabled={pending} onClick={() => onSave(items)}>Guardar itens</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({ value, onClose, onDone }: { value: { pathId: number; name: string }; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const { data: people = [] } = trpc.training.assignableEmployees.useQuery();
  const assign = trpc.training.assignPath.useMutation({
    onSuccess: (r) => { toast.success(`Atribuído: ${r.created} novo(s)${r.skipped ? ` · ${r.skipped} já tinham` : ""}`); onDone(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const filtered = (people as any[]).filter((p) => !q || p.fullName.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Atribuir — {value.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Procurar colaborador…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="max-h-80 overflow-y-auto border rounded-lg divide-y">
            {filtered.map((p) => (
              <label key={p.id} className="flex items-center gap-2 p-2 text-sm cursor-pointer hover:bg-accent/40">
                <Checkbox checked={sel.has(p.id)} onCheckedChange={(v) => setSel((s) => { const n = new Set(s); if (v) n.add(p.id); else n.delete(p.id); return n; })} />
                <span className="flex-1 truncate">{p.fullName}</span>
                <span className="text-xs text-muted-foreground">{p.position}</span>
              </label>
            ))}
          </div>
          <Button className="w-full" disabled={!sel.size || assign.isPending} onClick={() => assign.mutate({ pathId: value.pathId, employeeIds: Array.from(sel) })}>Atribuir a {sel.size} pessoa(s)</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── ACOMPANHAMENTO (dashboard supervisor/admin) ──────────────────────────

export function DashboardTab() {
  const { user } = useAuth();
  const isTrainer = can(user, "formacao", "manage");
  const [city, setCity] = useState<string>("all");
  const [pathId, setPathId] = useState<string>("all");
  const [person, setPerson] = useState<number | null>(null);
  const [confirm, confirmUi] = useConfirm();
  const utils = trpc.useUtils();
  const { data: paths = [] } = trpc.training.paths.useQuery({ includeInactive: true });
  const { data, isLoading, error } = trpc.training.dashboard.useQuery({ city: city === "all" ? null : (city as any), pathId: pathId === "all" ? null : Number(pathId) });
  const decide = trpc.training.decidePromotion.useMutation({
    onSuccess: (_r, v) => { void utils.training.dashboard.invalidate(); toast.success(v.approve ? "Promoção aprovada — certificado emitido" : "Promoção recusada"); },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-muted-foreground">A carregar…</p>;
  if (error) return <p className="text-destructive">{error.message}</p>;
  const d = data!;
  return (
    <div className="space-y-4">
      {confirmUi}
      <div className="flex flex-wrap gap-2">
        <Select value={city} onValueChange={setCity}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">Todas as cidades</SelectItem>{CITY_OPTIONS.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={pathId} onValueChange={setPathId}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">Todos os percursos</SelectItem>{(paths as any[]).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Atribuídas", value: d.totals.assigned },
          { label: "Concluídas", value: d.totals.completed },
          { label: "Em atraso", value: d.totals.overdue, cls: d.totals.overdue ? "text-red-600" : "" },
          { label: "% concluído", value: `${d.totals.pct}%` },
        ].map((k) => (
          <Card key={k.label}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{k.label}</p><p className={`text-2xl font-bold ${k.cls ?? ""}`}>{k.value}</p></CardContent></Card>
        ))}
      </div>

      {d.promotions.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Award className="w-5 h-5 text-amber-500" />Promoções por aprovar ({d.promotions.length})</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {d.promotions.map((p: any) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-2 border rounded-lg">
                <div className="text-sm min-w-0">
                  <button className="font-medium underline-offset-2 hover:underline" onClick={() => setPerson(p.employeeId)}>{p.fullName}</button>
                  <span className="text-muted-foreground"> · {p.examTitle} · {p.score}% → </span>
                  <Badge variant="outline">{CAREER_LEVEL_LABELS[p.level] ?? p.level}</Badge>
                  {p.currentLevel && <span className="text-xs text-muted-foreground"> (atual: {CAREER_LEVEL_LABELS[p.currentLevel] ?? p.currentLevel})</span>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" disabled={decide.isPending} onClick={async () => {
                    if (await confirm({ title: `Aprovar a promoção de ${p.fullName}?`, description: `Atualiza o nível na ficha para ${CAREER_LEVEL_LABELS[p.level] ?? p.level} e emite o certificado.`, confirmLabel: "Aprovar" })) decide.mutate({ id: p.id, approve: true });
                  }}><CheckCircle className="w-4 h-4 mr-1" />Aprovar</Button>
                  <Button size="sm" variant="outline" disabled={decide.isPending} onClick={async () => {
                    if (await confirm({ title: `Recusar a promoção de ${p.fullName}?`, confirmLabel: "Recusar", destructive: true })) decide.mutate({ id: p.id, approve: false });
                  }}><XCircle className="w-4 h-4 mr-1" />Recusar</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Conclusão por cidade e percurso</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {d.summary.length === 0 ? <p className="text-sm text-muted-foreground">Sem atribuições.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground border-b"><th className="py-1 pr-2">Cidade</th><th className="pr-2">Percurso</th><th className="pr-2">Função</th><th className="pr-2 text-right">Atrib.</th><th className="pr-2 text-right">Concl.</th><th className="pr-2 text-right">Atraso</th><th className="text-right">%</th></tr></thead>
              <tbody>
                {d.summary.map((g: any) => (
                  <tr key={`${g.city}-${g.pathId}`} className="border-b last:border-0">
                    <td className="py-1 pr-2">{cityLabel(g.city)}</td><td className="pr-2">{g.pathName}</td><td className="pr-2">{TARGET_ROLES.find((r) => r.id === g.targetRole)?.label ?? "—"}</td>
                    <td className="pr-2 text-right">{g.assigned}</td><td className="pr-2 text-right">{g.completed}</td><td className={`pr-2 text-right ${g.overdue ? "text-red-600 font-medium" : ""}`}>{g.overdue}</td><td className="text-right">{g.pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="w-5 h-5 text-red-500" />Em atraso ({d.overdue.length})</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {d.overdue.length === 0 ? <p className="text-sm text-muted-foreground">Ninguém em atraso. 👏</p> : d.overdue.map((o: any) => (
            <button key={o.assignmentId} className="w-full flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg hover:bg-accent/40 text-left" onClick={() => setPerson(o.employeeId)}>
              <span className="text-sm"><b>{o.fullName}</b> · {o.pathName} · {cityLabel(o.city)}</span>
              <Badge className="bg-red-100 text-red-700">{o.daysLate} dia(s)</Badge>
            </button>
          ))}
        </CardContent>
      </Card>

      {d.certificates.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Certificados expirados / a expirar</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {d.certificates.map((c: any) => (
              <button key={c.id} className="w-full flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg hover:bg-accent/40 text-left" onClick={() => setPerson(c.employeeId)}>
                <span className="text-sm"><b>{c.fullName}</b> · {c.examTitle} · até {c.validUntil ? fmtPTDate(c.validUntil) : "—"}{c.recertAssignedAt ? " · recertificação atribuída" : ""}</span>
                <Badge className={c.state === "expired" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}>{c.state === "expired" ? "Expirado" : "Expira em breve"}</Badge>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {isTrainer && <TutorQuestionsCard />}

      {person != null && <PersonProgressDialog employeeId={person} onClose={() => setPerson(null)} />}
    </div>
  );
}

function PersonProgressDialog({ employeeId, onClose }: { employeeId: number; onClose: () => void }) {
  const { data, isLoading, error } = trpc.training.personProgress.useQuery({ employeeId });
  const [confirm, confirmUi] = useConfirm();
  const utils = trpc.useUtils();
  const unassign = trpc.training.unassign.useMutation({ onSuccess: () => { void utils.training.personProgress.invalidate(); void utils.training.dashboard.invalidate(); toast.success("Atribuição removida"); }, onError: (e) => toast.error(e.message) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        {confirmUi}
        <DialogHeader><DialogTitle>{data?.employee?.fullName ?? "Progresso"}</DialogTitle></DialogHeader>
        {isLoading ? <p className="text-muted-foreground">A carregar…</p> : error ? <p className="text-destructive">{error.message}</p> : data && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Nível: {data.employee?.careerLevel ? CAREER_LEVEL_LABELS[data.employee.careerLevel] ?? data.employee.careerLevel : "—"}{data.employee?.extraLevel != null ? ` · nível extra ${data.employee.extraLevel}` : ""}</p>
            {data.assignments.length === 0 && <p className="text-sm">Sem percursos atribuídos.</p>}
            {data.assignments.map((a: any) => (
              <div key={a.id} className="border rounded-lg p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{a.pathName}</span>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={a.status} />
                    {a.dueAt && <span className="text-xs text-muted-foreground">prazo {fmtPTDate(a.dueAt)}</span>}
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Remover atribuição" onClick={async () => {
                      if (await confirm({ title: `Remover "${a.pathName}" desta pessoa?`, confirmLabel: "Remover", destructive: true })) unassign.mutate({ assignmentId: a.id });
                    }}><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>
                <Progress value={a.progress.pct} className="h-2" />
                <ul className="text-sm space-y-1">
                  {a.items.map((it: any) => (
                    <li key={it.id} className="flex items-center gap-2">
                      {it.completedAt ? <CheckCircle className="w-4 h-4 text-green-600" /> : it.viewedAt ? <BookOpen className="w-4 h-4 text-blue-500" /> : <XCircle className="w-4 h-4 text-muted-foreground" />}
                      <span>{it.title}</span>
                      <span className="text-xs text-muted-foreground">{it.completedAt ? `concluído ${fmtPTDate(it.completedAt)}` : it.viewedAt ? `aberto ${fmtPTDate(it.viewedAt)}` : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {data.certificates.length > 0 && (
              <div>
                <p className="font-medium text-sm mb-1">Certificados</p>
                {data.certificates.map((c: any) => (
                  <p key={c.id} className="text-sm">{CAREER_LEVEL_LABELS[c.level] ?? c.level} · {c.examTitle} · {fmtPTDate(c.issuedAt)}{c.validUntil ? ` → ${fmtPTDate(c.validUntil)}` : ""} {c.state === "expired" && <Badge className="bg-red-100 text-red-700 ml-1">Expirado</Badge>}</p>
                ))}
              </div>
            )}
            {data.attempts.length > 0 && (
              <div>
                <p className="font-medium text-sm mb-1">Exames</p>
                <div className="flex flex-wrap gap-2">{data.attempts.slice(0, 10).map((a: any) => <Badge key={a.id} className={a.passed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}>{a.examTitle}: {a.score}% · {fmtPTDate(a.createdAt)}</Badge>)}</div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
