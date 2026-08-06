import { useState, useRef, useEffect, useMemo } from "react";
import { usePersistedState } from "@/hooks/usePersistedState";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useAuth } from "@/_core/hooks/useAuth";
import { RecruitmentSection } from "@/components/RecruitmentSection";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime, fmtPTDate } from "@/lib/lisbonTime";
import { fileHref } from "@/lib/fileHref";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import CameraCapture from "@/components/CameraCapture";
import { Progress } from "@/components/ui/progress";
import {
  Users, UserPlus, Search, FileText, Clock, Calendar,
  Upload, Trash2, Eye, ChevronLeft, Camera, MapPin,
  Euro, Building2, Phone, Mail, CreditCard, Shield,
  CheckCircle2, XCircle, AlertTriangle, Image, FolderOpen, Plus, Pencil, Save, X,
  Download, Wallet, Banknote, ChevronRight, ArrowUpDown, MoreVertical, BarChart3
} from "lucide-react";
import RhDashboardPage from "./RhDashboardPage";
import UsersPage from "./UsersPage";

// ─── TYPES ────────────────────────────────────────────────────────────────────
type Position =
  | "director" | "supervisor" | "team_leader" | "backoffice"
  | "frontoffice" | "senior_driver" | "driver" | "extra";

type ContractType = "permanent" | "fixed_term" | "extra";

type DocType =
  | "id_card" | "residence_permit" | "driving_license" | "nib_proof"
  | "address_proof" | "contract" | "extra_contract" | "contract_annex"
  | "responsibility_term" | "work_accident_insurance" | "photo" | "other";

const POSITION_LABELS: Record<Position, string> = {
  director: "Director",
  supervisor: "Supervisor",
  team_leader: "Team Leader",
  backoffice: "Backoffice",
  frontoffice: "Frontoffice",
  senior_driver: "Condutor Sénior",
  driver: "Condutor",
  extra: "Extra",
};

const CONTRACT_LABELS: Record<ContractType, string> = {
  permanent: "Permanente",
  fixed_term: "Termo Certo",
  extra: "Extra",
};

const DOC_LABELS: Record<DocType, string> = {
  id_card: "Bilhete de Identidade",
  residence_permit: "Título de Residência",
  driving_license: "Carta de Condução",
  nib_proof: "Comprovativo NIB",
  address_proof: "Comprovativo de Morada",
  contract: "Contrato de Trabalho",
  extra_contract: "Contrato Extra",
  contract_annex: "Anexo de Contrato",
  responsibility_term: "Termo de Responsabilidade",
  work_accident_insurance: "Seguro de Acidentes de Trabalho",
  photo: "Fotografia",
  other: "Outro",
};

const MANDATORY_DOC_TYPES: DocType[] = [
  "photo", "id_card", "driving_license", "nib_proof",
  "address_proof", "contract", "responsibility_term",
];

const LEVEL_LABEL: Record<string, string> = {
  group: "Grupo", city: "Cidade", brand: "Marca", project: "Projeto",
};
const LEVEL_COLOR: Record<string, string> = {
  group: "bg-violet-100 text-violet-700 border-violet-200",
  city: "bg-blue-100 text-blue-700 border-blue-200",
  brand: "bg-emerald-100 text-emerald-700 border-emerald-200",
  project: "bg-amber-100 text-amber-700 border-amber-200",
};

function sortProjectsHierarchical<T extends { id: number; name: string; parentId?: number | null; level?: string | null }>(
  list: T[],
): Array<T & { __depth: number }> {
  const byParent = new Map<number | null, T[]>();
  for (const p of list) {
    const key = p.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(p);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.name.localeCompare(b.name, "pt"));
  const out: Array<T & { __depth: number }> = [];
  function walk(parentId: number | null, depth: number) {
    const children = byParent.get(parentId) ?? [];
    for (const c of children) {
      out.push({ ...c, __depth: depth });
      walk(c.id, depth + 1);
    }
  }
  walk(null, 0);
  const seen = new Set(out.map((p) => p.id));
  for (const p of list) if (!seen.has(p.id)) out.push({ ...p, __depth: 0 });
  return out;
}

const POSITION_COLORS: Record<Position, string> = {
  director: "bg-purple-100 text-purple-800",
  supervisor: "bg-blue-100 text-blue-800",
  team_leader: "bg-indigo-100 text-indigo-800",
  backoffice: "bg-cyan-100 text-cyan-800",
  frontoffice: "bg-teal-100 text-teal-800",
  senior_driver: "bg-green-100 text-green-800",
  driver: "bg-emerald-100 text-emerald-800",
  extra: "bg-amber-100 text-amber-800",
};

// ─── STATS BAR ────────────────────────────────────────────────────────────────
function HRStatsBar() {
  const { data: stats } = trpc.rh.stats.useQuery();
  if (!stats) return null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      {[
        { label: "Total Ativos", value: stats.totalActive, icon: Users, color: "text-blue-600" },
        { label: "Permanentes", value: stats.totalPermanent, icon: Shield, color: "text-green-600" },
        { label: "Extras", value: stats.totalExtras, icon: Clock, color: "text-amber-600" },
        { label: "Horas este Mês", value: `${stats.monthlyHours.toFixed(1)}h`, icon: Calendar, color: "text-purple-600" },
      ].map((s) => (
        <Card key={s.label}>
          <CardContent className="p-4 flex items-center gap-3">
            <s.icon className={`w-8 h-8 ${s.color}`} />
            <div>
              <p className="text-2xl font-bold">{s.value}</p>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── CREATE EMPLOYEE DIALOG ───────────────────────────────────────────────────
// Normaliza para "Primeiro Último" — útil para casar com a API Multipark
function multiparkNameOf(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

function CreateEmployeeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const { data: allUsers = [] } = trpc.users.list.useQuery();
  const { data: projectsList = [] } = trpc.projects.list.useQuery();
  const [form, setForm] = useState({
    fullName: "", email: "", multiparkAgentName: "",
    phone: "", nif: "", nib: "",
    address: "", birthDate: "", nationality: "Portuguesa",
    position: "driver" as Position,
    extraLevel: 1,
    department: "",
    projectId: null as number | null,
    contractType: "permanent" as ContractType,
    contractStart: "", contractEnd: "",
    monthlySalary: "",
    mealAllowancePerDay: "",
    userId: null as number | null,
  });
  const [confirmStep, setConfirmStep] = useState(false);

  const create = trpc.rh.create.useMutation({
    onSuccess: () => {
      utils.rh.list.invalidate();
      utils.rh.stats.invalidate();
      toast.success("Colaborador criado com sucesso!");
      onClose();
      setConfirmStep(false);
      setForm({
        fullName: "", email: "", multiparkAgentName: "",
        phone: "", nif: "", nib: "",
        address: "", birthDate: "", nationality: "Portuguesa",
        position: "driver", extraLevel: 1, department: "",
        projectId: null,
        contractType: "permanent", contractStart: "", contractEnd: "",
        monthlySalary: "", mealAllowancePerDay: "", userId: null,
      });
    },
    onError: (e) => toast.error(e.message),
  });

  const set = (k: string, v: string | number | null) => setForm(f => {
    const next = { ...f, [k]: v };
    // Auto-preenche o nome Multipark com a normalização sempre que o nome muda
    if (k === "fullName" && typeof v === "string") {
      next.multiparkAgentName = multiparkNameOf(v);
    }
    return next;
  });

  const canSubmit = !!form.fullName && !!form.email && !!form.multiparkAgentName && form.projectId != null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setConfirmStep(false); onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {confirmStep ? "Confirmar nome Multipark" : "Novo Colaborador"}
          </DialogTitle>
        </DialogHeader>

        {confirmStep ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Confirma que este é o nome exacto que o colaborador tem na <strong>aplicação Multipark</strong>.
              É por aqui que as reservas operadas por ele serão atribuídas.
            </p>
            <div className="rounded border bg-muted/30 p-4">
              <p className="text-xs text-muted-foreground">Nome Multipark</p>
              <Input
                value={form.multiparkAgentName}
                onChange={e => setForm(f => ({ ...f, multiparkAgentName: e.target.value }))}
                className="mt-1 font-medium"
              />
              <p className="text-xs text-muted-foreground mt-2">
                Sugerido a partir do nome completo: <strong>{multiparkNameOf(form.fullName)}</strong>
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmStep(false)}>Voltar</Button>
              <Button
                disabled={!form.multiparkAgentName.trim() || create.isPending}
                onClick={() => create.mutate({
                  fullName: form.fullName,
                  email: form.email,
                  multiparkAgentName: form.multiparkAgentName,
                  phone: form.phone || undefined,
                  nif: form.nif || undefined,
                  nib: form.nib || undefined,
                  address: form.address || undefined,
                  birthDate: form.birthDate || undefined,
                  nationality: form.nationality || undefined,
                  position: form.position,
                  extraLevel: form.position === "extra" ? form.extraLevel : undefined,
                  department: form.department || undefined,
                  projectId: form.projectId!,
                  contractType: form.contractType,
                  contractStart: form.contractStart || undefined,
                  contractEnd: form.contractType === "fixed_term" ? form.contractEnd || undefined : undefined,
                  monthlySalary: form.monthlySalary || undefined,
                  mealAllowancePerDay: form.mealAllowancePerDay || undefined,
                  userId: form.userId ?? undefined,
                })}
              >
                {create.isPending ? "A criar..." : "Confirmar e criar"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
        <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <Label>Nome Completo *</Label>
            <Input value={form.fullName} onChange={e => set("fullName", e.target.value)} placeholder="Nome completo" />
          </div>
          <div>
            <Label>Email * <span className="text-xs text-muted-foreground">(login Google)</span></Label>
            <Input type="email" value={form.email} onChange={e => set("email", e.target.value)} placeholder="email@empresa.pt" />
          </div>
          <div>
            <Label>Telefone</Label>
            <Input value={form.phone} onChange={e => set("phone", e.target.value)} placeholder="+351 9XX XXX XXX" />
          </div>
          <div>
            <Label>NIF</Label>
            <Input value={form.nif} onChange={e => set("nif", e.target.value)} placeholder="123456789" />
          </div>
          <div>
            <Label>NIB / IBAN</Label>
            <Input value={form.nib} onChange={e => set("nib", e.target.value)} placeholder="PT50..." />
          </div>
          <div>
            <Label>Data de Nascimento</Label>
            <Input type="date" value={form.birthDate} onChange={e => set("birthDate", e.target.value)} />
          </div>
          <div>
            <Label>Nacionalidade</Label>
            <Input value={form.nationality} onChange={e => set("nationality", e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Label>Morada</Label>
            <Input value={form.address} onChange={e => set("address", e.target.value)} placeholder="Rua, nº, cidade" />
          </div>
          <div>
            <Label>Posto *</Label>
            <Select value={form.position} onValueChange={v => set("position", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.entries(POSITION_LABELS) as [Position, string][]).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {form.position === "extra" && (
            <div>
              <Label>Nível Extra</Label>
              <Select value={String(form.extraLevel)} onValueChange={v => set("extraLevel", parseInt(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Júnior (€4,50/h)</SelectItem>
                  <SelectItem value="2">Sénior (€5,00/h)</SelectItem>
                  <SelectItem value="3">Terminal (€5,50/h)</SelectItem>
                  <SelectItem value="4">Master (€6,00/h)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="sm:col-span-2">
            <Label>Centro de Custos *</Label>
            <Select
              value={form.projectId ? String(form.projectId) : ""}
              onValueChange={v => setForm(f => ({ ...f, projectId: parseInt(v) }))}
            >
              <SelectTrigger className={!form.projectId ? "border-amber-400" : undefined}>
                <SelectValue placeholder="Escolher centro de custos..." />
              </SelectTrigger>
              <SelectContent>
                {sortProjectsHierarchical(projectsList as any[]).map((p: any) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    <span style={{ paddingLeft: `${p.__depth * 12}px` }} className="inline-flex items-center gap-2">
                      <Badge variant="outline" className={`text-[10px] ${LEVEL_COLOR[p.level ?? "project"] ?? ""}`}>
                        {LEVEL_LABEL[p.level ?? "project"] ?? p.level}
                      </Badge>
                      {p.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Departamento</Label>
            <Input value={form.department} onChange={e => set("department", e.target.value)} placeholder="Ex: Lisboa" />
          </div>
          <div>
            <Label>Tipo de Contrato</Label>
            <Select value={form.contractType} onValueChange={v => set("contractType", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.entries(CONTRACT_LABELS) as [ContractType, string][]).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Início do Contrato</Label>
            <Input type="date" value={form.contractStart} onChange={e => set("contractStart", e.target.value)} />
          </div>
          {form.contractType === "fixed_term" && (
            <div>
              <Label>Fim do Contrato</Label>
              <Input type="date" value={form.contractEnd} onChange={e => set("contractEnd", e.target.value)} />
            </div>
          )}
          {form.position !== "extra" && (
            <>
              <div>
                <Label>Salário Mensal (€)</Label>
                <Input type="number" value={form.monthlySalary} onChange={e => set("monthlySalary", e.target.value)} placeholder="1200.00" />
              </div>
              <div>
                <Label>Sub. Alimentação (€/dia)</Label>
                <Input type="number" value={form.mealAllowancePerDay} onChange={e => set("mealAllowancePerDay", e.target.value)} placeholder="6.00" />
              </div>
            </>
          )}
          <div className="sm:col-span-2">
            <Label>Utilizador Associado</Label>
            <Select value={form.userId ? String(form.userId) : "none"} onValueChange={v => setForm(f => ({ ...f, userId: v === "none" ? null : parseInt(v) }))}>
              <SelectTrigger><SelectValue placeholder="Nenhum" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nenhum</SelectItem>
                {allUsers.map((u: any) => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.name ?? u.email} ({u.email})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Liga este colaborador a um utilizador da plataforma (para picar ponto, etc.)</p>
          </div>
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button
            onClick={() => setConfirmStep(true)}
            disabled={!canSubmit || create.isPending}
          >
            Continuar
          </Button>
        </DialogFooter>
        </>)}
      </DialogContent>
    </Dialog>
  );
}

// ─── DOCUMENT UPLOAD (MULTI-FILE + CHECKLIST) ───────────────────────────────
function DocumentsTab({ employeeId }: { employeeId: number }) {
  const utils = trpc.useUtils();
  const { data: docs = [] } = trpc.rh.documents.list.useQuery({ employeeId });
  const { data: checklist = [] } = trpc.rh.documents.checklist.useQuery({ employeeId });
  const [uploading, setUploading] = useState(false);
  const [uploadingCategory, setUploadingCategory] = useState<DocType | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<DocType | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeDocTypeRef = useRef<DocType>("id_card");

  const uploadBatch = trpc.rh.documents.uploadBatch.useMutation({
    onSuccess: () => {
      utils.rh.documents.list.invalidate({ employeeId });
      utils.rh.documents.checklist.invalidate({ employeeId });
      utils.rh.documents.allStatus.invalidate();
      toast.success("Documentos carregados!");
      setUploading(false);
      setUploadingCategory(null);
    },
    onError: (e) => { toast.error(e.message); setUploading(false); setUploadingCategory(null); },
  });

  const del = trpc.rh.documents.delete.useMutation({
    onSuccess: () => {
      utils.rh.documents.list.invalidate({ employeeId });
      utils.rh.documents.checklist.invalidate({ employeeId });
      utils.rh.documents.allStatus.invalidate();
      toast.success("Documento eliminado");
    },
  });

  const handleMultiFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadingCategory(activeDocTypeRef.current);
    const files: { fileBase64: string; mimeType: string; fileName: string }[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve((ev.target?.result as string).split(",")[1]);
        reader.readAsDataURL(file);
      });
      files.push({ fileBase64: base64, mimeType: file.type, fileName: file.name });
    }
    uploadBatch.mutate({ employeeId, docType: activeDocTypeRef.current, files });
    if (fileRef.current) fileRef.current.value = "";
  };

  const triggerUpload = (docType: DocType) => {
    activeDocTypeRef.current = docType;
    fileRef.current?.click();
  };

  // Group docs by category
  type DocItem = (typeof docs)[number];
  const docsByType = useMemo(() => {
    const map = new Map<string, DocItem[]>();
    for (const d of docs) {
      if (!map.has(d.docType)) map.set(d.docType, []);
      map.get(d.docType)!.push(d);
    }
    return map;
  }, [docs]);

  const completedCount = checklist.filter(c => c.present).length;
  const totalMandatory = checklist.length;
  const progressPct = totalMandatory > 0 ? Math.round((completedCount / totalMandatory) * 100) : 0;

  const isImage = (mime?: string | null) => mime?.startsWith("image/");

  return (
    <div className="space-y-5">
      <input ref={fileRef} type="file" className="hidden" accept="image/*,.pdf" multiple onChange={handleMultiFile} />

      {/* Checklist de documentos obrigatórios */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Shield className="w-4 h-4" /> Checklist de Documentos Obrigatórios
            </CardTitle>
            <Badge variant={completedCount === totalMandatory ? "default" : "secondary"} className={completedCount === totalMandatory ? "bg-green-100 text-green-700" : ""}>
              {completedCount}/{totalMandatory}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Progress value={progressPct} className="h-2" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {checklist.map((item) => (
              <div
                key={item.docType}
                className={`flex items-center justify-between p-2.5 rounded-lg border transition-colors ${
                  item.present ? "border-green-200 bg-green-50/50" : "border-orange-200 bg-orange-50/50"
                }`}
              >
                <div className="flex items-center gap-2">
                  {item.present ? (
                    <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-orange-500 shrink-0" />
                  )}
                  <span className="text-sm">{DOC_LABELS[item.docType as DocType]}</span>
                </div>
                {!item.present && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => triggerUpload(item.docType as DocType)}>
                    <Plus className="w-3 h-3 mr-1" /> Carregar
                  </Button>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Galeria por categoria */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium flex items-center gap-2"><FolderOpen className="w-4 h-4" /> Documentos por Categoria</h3>
        {(Object.entries(DOC_LABELS) as [DocType, string][]).map(([type, label]) => {
          const typeDocs = docsByType.get(type) || [];
          const isExpanded = expandedCategory === type;
          const isMandatory = MANDATORY_DOC_TYPES.includes(type);
          const hasFiles = typeDocs.length > 0;

          return (
            <Card key={type} className={`overflow-hidden ${!hasFiles && !isMandatory ? "opacity-60" : ""}`}>
              <div
                className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => setExpandedCategory(isExpanded ? null : type)}
              >
                <div className="flex items-center gap-2">
                  <FolderOpen className={`w-4 h-4 ${hasFiles ? "text-primary" : "text-muted-foreground"}`} />
                  <span className="text-sm font-medium">{label}</span>
                  {isMandatory && <Badge variant="outline" className="text-[10px] h-4 px-1">Obrigatório</Badge>}
                  {hasFiles && <Badge variant="secondary" className="text-[10px] h-4 px-1.5">{typeDocs.length}</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  {uploading && uploadingCategory === type ? (
                    <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full" />
                  ) : (
                    <Button size="sm" variant="ghost" className="h-7" onClick={(e) => { e.stopPropagation(); triggerUpload(type); }}>
                      <Upload className="w-3 h-3 mr-1" /> Carregar
                    </Button>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="border-t px-3 pb-3">
                  {typeDocs.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground">
                      <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p className="text-xs">Sem documentos nesta categoria</p>
                      <Button size="sm" variant="outline" className="mt-2" onClick={() => triggerUpload(type)}>
                        <Upload className="w-3 h-3 mr-1" /> Carregar ficheiros
                      </Button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 pt-3">
                      {typeDocs.map((doc) => (
                        <div key={doc.id} className="group relative border rounded-lg overflow-hidden bg-muted/30">
                          {/* Preview */}
                          {isImage(doc.mimeType) ? (
                            <div
                              className="aspect-[4/3] bg-cover bg-center cursor-pointer"
                              style={{ backgroundImage: `url(${fileHref(doc.fileUrl, doc.fileKey)})` }}
                              onClick={() => setPreviewUrl(fileHref(doc.fileUrl, doc.fileKey))}
                            />
                          ) : (
                            <div
                              className="aspect-[4/3] flex items-center justify-center cursor-pointer"
                              onClick={() => window.open(fileHref(doc.fileUrl, doc.fileKey) ?? undefined, "_blank")}
                            >
                              <FileText className="w-10 h-10 text-muted-foreground" />
                            </div>
                          )}
                          {/* Info */}
                          <div className="p-2">
                            <p className="text-xs font-medium truncate">{doc.label || doc.fileKey?.split("/").pop()}</p>
                            <p className="text-[10px] text-muted-foreground">{new Date(doc.createdAt).toLocaleDateString("pt-PT")}</p>
                          </div>
                          {/* Actions overlay */}
                          <div className="absolute top-1 right-1 flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                            <Button size="icon" variant="secondary" className="w-6 h-6" onClick={() => isImage(doc.mimeType) ? setPreviewUrl(fileHref(doc.fileUrl, doc.fileKey)) : window.open(fileHref(doc.fileUrl, doc.fileKey) ?? undefined, "_blank")}>
                              <Eye className="w-3 h-3" />
                            </Button>
                            <Button size="icon" variant="secondary" className="w-6 h-6 text-destructive" onClick={() => del.mutate({ id: doc.id })}>
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* Image preview dialog */}
      {previewUrl && (
        <Dialog open onOpenChange={() => setPreviewUrl(null)}>
          <DialogContent className="sm:max-w-3xl p-2">
            <img src={previewUrl} alt="Preview" className="w-full h-auto rounded" />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── CAMERA CAPTURE COMPONENT ─────────────────────────────────────────────────
// (extraído para componente partilhado — também usado no atalho de ponto do avatar)

// ─── TIME RECORDS TAB ─────────────────────────────────────────────────────────
function TimeRecordsTab({ employeeId }: { employeeId: number }) {
  const utils = trpc.useUtils();
  const now = new Date();
  const [year] = useState(now.getFullYear());
  const [month] = useState(now.getMonth() + 1);
  const { data: records = [] } = trpc.rh.timeRecords.list.useQuery({ employeeId });
  const { data: monthly } = trpc.rh.timeRecords.monthlyHours.useQuery({ employeeId, year, month });
  const [cameraMode, setCameraMode] = useState<"check_in" | "check_out" | null>(null);
  const [expandedRecord, setExpandedRecord] = useState<number | null>(null);

  const checkIn = trpc.rh.timeRecords.checkIn.useMutation({
    onSuccess: (data: any) => {
      utils.rh.timeRecords.list.invalidate();
      utils.rh.timeRecords.monthlyHours.invalidate();
      toast.success("Check-in registado com foto e GPS!");
      if (data?.pdaAttached) {
        toast.info(
          `📟 Ficaste com o ${data.pdaAttached.pdaName}` +
          (data.pdaAttached.zelloUsername ? ` (Zello: ${data.pdaAttached.zelloUsername})` : "") +
          (data.pdaAttached.replacedName ? ` — substituíste ${data.pdaAttached.replacedName}` : ""),
          { duration: 10000 }
        );
      }
      if (data?.warning) toast.warning(data.warning, { duration: 10000 });
      if (data?.outsideGeofence) toast.warning("Atenção: check-in dado FORA do raio do local de trabalho — ficou marcado.", { duration: 10000 });
      setCameraMode(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const checkOut = trpc.rh.timeRecords.checkOut.useMutation({
    onSuccess: (data: any) => {
      utils.rh.timeRecords.list.invalidate();
      utils.rh.timeRecords.monthlyHours.invalidate();
      toast.success(`Check-out registado! ${data.hoursWorked}h trabalhadas`);
      if (data?.zello) {
        const z = data.zello;
        toast.info(
          `Turno no Zello: ${Number(z.km).toFixed(1)} km · vel. máx ${Math.round(z.maxSpeed)} km/h` +
          (z.offlineMinutes > 10 ? ` · ⚠ ${z.offlineMinutes} min com Zello desligado` : ""),
          { duration: 10000 }
        );
      }
      setCameraMode(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const submitWithPhoto = (base64: string, mimeType: string) => {
    const doSubmit = (lat: number, lng: number) => {
      const payload: any = {
        employeeId,
        photoBase64: base64,
        mimeType,
        latitude: String(lat),
        longitude: String(lng),
        locationName: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
        // Se este browser é um PDA registado, o servidor liga a pessoa ao
        // PDA/Zello automaticamente no check-in
        pdaDeviceToken: localStorage.getItem("mp.pda.deviceToken") || undefined,
      };
      if (cameraMode === "check_in") checkIn.mutate(payload);
      else checkOut.mutate(payload);
    };

    // Regra do Jorge: o ponto EXIGE localização exata (a app já não bloqueia
    // globalmente — a exigência vive aqui, no check-in/check-out).
    if (!navigator.geolocation) {
      toast.error("Este dispositivo não tem GPS — o ponto exige localização exata.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (pos.coords.accuracy > 2000) {
          toast.error("A localização está aproximada (Wi-Fi/IP). Liga a localização EXATA do dispositivo e tenta outra vez.");
          return;
        }
        doSubmit(pos.coords.latitude, pos.coords.longitude);
      },
      () => toast.error("Sem acesso à localização. Autoriza a localização exata nas permissões do browser para picar o ponto."),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const openGoogleMaps = (lat: string, lng: string) => {
    window.open(`https://www.google.com/maps?q=${lat},${lng}&z=17`, "_blank");
  };

  return (
    <div className="space-y-4">
      {/* Camera capture mode */}
      {cameraMode && (
        <Card className="border-2 border-primary">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Camera className="w-4 h-4" />
              {cameraMode === "check_in" ? "Foto de Entrada" : "Foto de Saída"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CameraCapture
              onCapture={submitWithPhoto}
              onCancel={() => setCameraMode(null)}
            />
            {(checkIn.isPending || checkOut.isPending) && (
              <p className="text-sm text-muted-foreground text-center mt-2 animate-pulse">A registar ponto com foto e GPS...</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Buttons */}
      {!cameraMode && (
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() => setCameraMode("check_in")}
            disabled={checkIn.isPending}
            className="flex-1 bg-green-600 hover:bg-green-700"
          >
            <Camera className="w-4 h-4 mr-2" /> Entrada (Foto + GPS)
          </Button>
          <Button
            onClick={() => setCameraMode("check_out")}
            disabled={checkOut.isPending}
            variant="outline"
            className="flex-1 border-red-300 text-red-600 hover:bg-red-50"
          >
            <Camera className="w-4 h-4 mr-2" /> Saída (Foto + GPS)
          </Button>
        </div>
      )}

      {monthly && (
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Calendar className="w-8 h-8 text-blue-600" />
            <div>
              <p className="text-xl font-bold">{monthly.totalHours.toFixed(1)}h</p>
              <p className="text-xs text-muted-foreground">Horas trabalhadas este mês</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Records list */}
      <div className="space-y-2">
        {records.slice(0, 30).map((r) => {
          const isExpanded = expandedRecord === r.id;
          const hasCoords = r.latitude && r.longitude;
          // Ponto suspeito (check-out esquecido cortado a 12h) ou fora do raio → VERMELHO
          const isFlagged = /\[(SUSPEITO|FORA DO RAIO)\]/.test(r.notes ?? "");
          return (
            <div
              key={r.id}
              className={`border rounded-lg overflow-hidden cursor-pointer transition-colors ${isFlagged ? "border-red-400 bg-red-50/60 hover:bg-red-50" : "hover:bg-muted/30"}`}
              onClick={() => setExpandedRecord(isExpanded ? null : r.id)}
            >
              <div className="flex items-center justify-between p-3">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${r.type === "check_in" ? "bg-green-500" : "bg-red-500"}`} />
                  {r.photoUrl && (
                    <img src={r.photoUrl} alt="" className="w-8 h-8 rounded-full object-cover border" />
                  )}
                  <div>
                    <p className="text-sm font-medium">
                      {r.type === "check_in" ? "Entrada" : "Saída"}
                      {isFlagged && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">⚠ rever</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">{fmtPTDateTime(r.recordedAt)}</p>
                    {isFlagged && r.notes && <p className="text-[11px] text-red-700 mt-0.5">{r.notes}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {hasCoords && (
                    <Badge variant="outline" className="text-xs gap-1">
                      <MapPin className="w-3 h-3" /> GPS
                    </Badge>
                  )}
                  {r.photoUrl && (
                    <Badge variant="outline" className="text-xs gap-1">
                      <Camera className="w-3 h-3" /> Foto
                    </Badge>
                  )}
                  {(r as any).zelloKm != null && (
                    <Badge variant="outline" className="text-xs gap-1">
                      🚗 {parseFloat(String((r as any).zelloKm)).toFixed(1)} km
                    </Badge>
                  )}
                  {((r as any).zelloOfflineMinutes ?? 0) > 10 && (
                    <Badge variant="outline" className="text-xs gap-1 border-amber-300 text-amber-700 bg-amber-50">
                      ⚠ {(r as any).zelloOfflineMinutes} min s/ Zello
                    </Badge>
                  )}
                  {r.hoursWorked && <p className="text-sm font-semibold">{parseFloat(String(r.hoursWorked)).toFixed(1)}h</p>}
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="px-3 pb-3 space-y-3 border-t bg-muted/10">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3">
                    {/* Photo */}
                    {r.photoUrl && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Foto</p>
                        <img
                          src={r.photoUrl}
                          alt="Foto do ponto"
                          className="w-full max-w-[200px] rounded-lg border cursor-pointer hover:opacity-80"
                          onClick={(e) => { e.stopPropagation(); window.open(r.photoUrl!, "_blank"); }}
                        />
                      </div>
                    )}
                    {/* GPS */}
                    {hasCoords && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Localização GPS</p>
                        <div className="space-y-2">
                          <div className="text-xs bg-background p-2 rounded border font-mono">
                            <p>Lat: {r.latitude}</p>
                            <p>Lng: {r.longitude}</p>
                            {r.locationName && <p className="mt-1 text-muted-foreground">{r.locationName}</p>}
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full text-xs"
                            onClick={(e) => { e.stopPropagation(); openGoogleMaps(String(r.latitude), String(r.longitude)); }}
                          >
                            <MapPin className="w-3 h-3 mr-1" /> Ver no Google Maps
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                  {r.hoursWorked && (
                    <div className="text-xs text-muted-foreground">
                      Horas trabalhadas: <span className="font-semibold text-foreground">{parseFloat(String(r.hoursWorked)).toFixed(2)}h</span>
                    </div>
                  )}
                  {(r as any).zelloKm != null && (
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p className="font-medium text-foreground">Turno no Zello (automático)</p>
                      <p>Percorreu <span className="font-semibold text-foreground">{parseFloat(String((r as any).zelloKm)).toFixed(1)} km</span>
                        {" · "}vel. média {Math.round(parseFloat(String((r as any).zelloAvgSpeed ?? 0)))} km/h
                        {" · "}vel. máxima {Math.round(parseFloat(String((r as any).zelloMaxSpeed ?? 0)))} km/h</p>
                      <p>
                        Zello ligado {Math.floor(((r as any).zelloOnlineMinutes ?? 0) / 60)}h{String(((r as any).zelloOnlineMinutes ?? 0) % 60).padStart(2, "0")}
                        {((r as any).zelloOfflineMinutes ?? 0) > 10 && (
                          <span className="text-amber-700 font-medium"> · desligado {Math.floor(((r as any).zelloOfflineMinutes ?? 0) / 60)}h{String(((r as any).zelloOfflineMinutes ?? 0) % 60).padStart(2, "0")}</span>
                        )}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {records.length === 0 && <p className="text-center text-muted-foreground py-8">Sem registos de ponto</p>}
      </div>
    </div>
  );
}

// ─── SCHEDULES TAB ────────────────────────────────────────────────────────────
type ScheduleDraft = { startTime: string; endTime: string; isWorkDay: boolean };

function SchedulesTab({ employeeId }: { employeeId: number }) {
  const utils = trpc.useUtils();
  const { data: schedules = [] } = trpc.rh.schedules.list.useQuery({ employeeId });
  const upsert = trpc.rh.schedules.upsert.useMutation({
    onSuccess: () => { utils.rh.schedules.list.invalidate({ employeeId }); toast.success("Horário guardado!"); },
    onError: (e) => toast.error(e.message),
  });
  const deleteSchedule = trpc.rh.schedules.delete.useMutation({
    onSuccess: () => { utils.rh.schedules.list.invalidate({ employeeId }); toast.success("Horário removido"); },
    onError: (e) => toast.error(e.message),
  });

  const DAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  const [drafts, setDrafts] = useState<Record<number, ScheduleDraft>>({});

  useEffect(() => {
    const next: Record<number, ScheduleDraft> = {};
    for (let d = 0; d < 7; d++) {
      const s = schedules.find(x => x.weekday === d);
      next[d] = {
        startTime: s?.startTime ?? "09:00",
        endTime: s?.endTime ?? "18:00",
        isWorkDay: s ? Boolean(s.isWorkDay) : (d !== 0 && d !== 6),
      };
    }
    setDrafts(next);
  }, [schedules]);

  const setDraft = (weekday: number, patch: Partial<ScheduleDraft>) =>
    setDrafts(d => ({ ...d, [weekday]: { ...d[weekday], ...patch } }));

  return (
    <div className="space-y-3">
      {DAYS.map((day, idx) => {
        const d = drafts[idx] ?? { startTime: "09:00", endTime: "18:00", isWorkDay: true };
        return (
          <div key={idx} className={`flex items-center gap-3 flex-wrap p-3 border rounded-lg ${d.isWorkDay ? "" : "bg-muted/30"}`}>
            <div className="w-10 text-sm font-medium text-muted-foreground">{day}</div>
            <Button
              size="sm"
              variant={d.isWorkDay ? "outline" : "secondary"}
              className="w-20"
              onClick={() => setDraft(idx, { isWorkDay: !d.isWorkDay })}
            >
              {d.isWorkDay ? "Trabalha" : "Folga"}
            </Button>
            <Input
              type="time"
              value={d.startTime}
              disabled={!d.isWorkDay}
              onChange={e => setDraft(idx, { startTime: e.target.value })}
              className="w-28"
            />
            <span className="text-muted-foreground">—</span>
            <Input
              type="time"
              value={d.endTime}
              disabled={!d.isWorkDay}
              onChange={e => setDraft(idx, { endTime: e.target.value })}
              className="w-28"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => upsert.mutate({
                employeeId,
                weekday: idx,
                startTime: d.startTime,
                endTime: d.endTime,
                isWorkDay: d.isWorkDay,
              })}
            >
              Guardar
            </Button>
            {schedules.some(s => s.weekday === idx) && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => deleteSchedule.mutate({ employeeId, weekday: idx })}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── RESUMO DO MÊS — horas + valor a receber ─────────────────────────────────
function MyMonthSummaryCard({ employeeId }: { employeeId: number }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  // Salários: admin+ vê de todos; os restantes só o próprio resumo
  const { user } = useAuth();
  const isAdmin = ["admin", "super_admin"].includes(user?.role ?? "");
  const { data: meEmp } = trpc.rh.me.useQuery(undefined, { enabled: !isAdmin });
  const isOwn = meEmp?.employee?.id === employeeId;
  const canSee = isAdmin || isOwn;
  const { data, isLoading } = trpc.rh.myMonthSummary.useQuery({ employeeId, year, month }, { enabled: canSee });

  const fmt = (v: number | null | undefined) =>
    new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(Number(v ?? 0));

  if (!canSee) return null;

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wallet className="w-4 h-4" /> Resumo do mês
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={String(month)} onValueChange={v => setMonth(parseInt(v))}>
              <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={String(year)} onValueChange={v => setYear(parseInt(v))}>
              <SelectTrigger className="w-24 h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-4 text-center">A calcular...</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Sem dados para este mês</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div>
              <p className="text-[10px] text-muted-foreground uppercase">Horas</p>
              <p className="text-lg font-bold">{fmt(0).replace("0,00 €", "")}{Number(data.totalHours).toFixed(1)}h</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase">Dias</p>
              <p className="text-lg font-bold">{data.daysWorked}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase">€/hora</p>
              <p className="text-lg font-bold">{fmt(data.hourlyRate)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase">A receber (bruto)</p>
              <p className="text-lg font-bold text-primary">{fmt(data.totalPayment)}</p>
            </div>
            <div>
              <p className="text-[10px] text-amber-700 uppercase">Líquido est.</p>
              <p className="text-lg font-bold text-amber-700">{fmt(data.netEstimate)}</p>
              <p className="text-[9px] text-amber-700">TSU 11% + IRS 15%</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── ALERTAS: docs em falta, penalizações, bloqueio ──────────────────────────
function EmployeeAlertsCard({ employeeId }: { employeeId: number }) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const { data: docsStatus } = trpc.rh.checkDocs.useQuery({ employeeId });
  const { data: penalties = [] } = trpc.rh.penalties.list.useQuery({ employeeId });
  const { data: emp } = trpc.rh.byId.useQuery({ id: employeeId });

  const unblock = trpc.rh.unblock.useMutation({
    onSuccess: () => { utils.rh.byId.invalidate({ id: employeeId }); utils.auth.me.invalidate(); toast.success("Login desbloqueado"); },
    onError: (e) => toast.error(e.message),
  });
  const clearPenalty = trpc.rh.penalties.clear.useMutation({
    onSuccess: () => { utils.rh.penalties.list.invalidate({ employeeId }); toast.success("Penalização levantada"); },
    onError: (e) => toast.error(e.message),
  });

  const isSupervisor = user?.role && ["supervisor", "admin", "super_admin"].includes(user.role);
  const isBlocked = Boolean(emp?.employee?.loginBlocked);
  const totalPoints = penalties.reduce((s, p) => s + Number(p.points ?? 0), 0);

  if (!docsStatus?.warning && penalties.length === 0 && !isBlocked) return null;

  return (
    <div className="space-y-2">
      {isBlocked && (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="p-4 flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold text-red-900">Login bloqueado</p>
              <p className="text-sm text-red-800">{emp?.employee?.loginBlockedReason ?? "—"}</p>
            </div>
            {isSupervisor && (
              <Button
                variant="outline"
                size="sm"
                disabled={unblock.isPending}
                onClick={() => unblock.mutate({ employeeId })}
              >
                Desbloquear
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      {docsStatus?.warning && !isBlocked && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold text-amber-900">
                Documentos em falta há {docsStatus.daysSinceStart} dias
              </p>
              <p className="text-sm text-amber-800">
                Faltam: {docsStatus.missingDocs.map(d => DOC_LABELS[d as DocType] ?? d).join(", ")}.
                {docsStatus.daysSinceStart >= 14 && docsStatus.daysSinceStart < 21 && " Bloqueio aos 21 dias."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {penalties.length > 0 && (
        <Card className={`border ${totalPoints >= 3 ? "border-red-300 bg-red-50" : "border-amber-300 bg-amber-50"}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              {totalPoints} ponto{totalPoints > 1 ? "s" : ""} de penalização aberto{totalPoints > 1 ? "s" : ""}
              {totalPoints >= 3 && <Badge variant="destructive" className="text-xs">Bloqueia escalas</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {penalties.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center justify-between text-sm border-b last:border-0 py-1.5">
                  <div>
                    <span className="font-medium">{p.reason.replace(/_/g, " ")}</span>
                    {p.notes && <span className="text-xs text-muted-foreground ml-2">{p.notes}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">{p.points} pt</Badge>
                    {isSupervisor && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs"
                        disabled={clearPenalty.isPending}
                        onClick={() => clearPenalty.mutate({ id: p.id })}
                      >
                        Levantar
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── EMPLOYEE DETAIL ──────────────────────────────────────────────────────────
function EmployeeDetail({ employeeId, onBack }: { employeeId: number; onBack: () => void }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.rh.byId.useQuery({ id: employeeId });
  const { data: allUsers = [] } = trpc.users.list.useQuery();
  const { data: projectsList = [] } = trpc.projects.list.useQuery();
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, any>>({});

  const updateEmployee = trpc.rh.update.useMutation({
    onSuccess: () => {
      utils.rh.byId.invalidate({ id: employeeId });
      utils.rh.list.invalidate();
      toast.success("Colaborador atualizado!");
      setEditing(false);
    },
    onError: (e) => toast.error(e.message),
  });
  const setActive = trpc.rh.setActive.useMutation({
    onSuccess: (r) => {
      utils.rh.byId.invalidate({ id: employeeId });
      utils.rh.list.invalidate();
      toast.success(r.cascadedUser ? "Estado alterado (colaborador + login)" : "Estado alterado");
    },
    onError: (e) => toast.error(e.message),
  });
  const photoRef = useRef<HTMLInputElement>(null);
  const uploadPhoto = trpc.rh.uploadPhoto.useMutation({
    onSuccess: () => { utils.rh.byId.invalidate({ id: employeeId }); toast.success("Foto atualizada!"); },
    onError: (e) => toast.error(e.message),
  });

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = (ev.target?.result as string).split(",")[1];
      uploadPhoto.mutate({ employeeId, fileBase64: base64, mimeType: file.type });
    };
    reader.readAsDataURL(file);
  };

  const startEditing = () => {
    if (!data) return;
    const emp = data.employee;
    setEditForm({
      fullName: emp.fullName ?? "",
      email: emp.email ?? "",
      phone: emp.phone ?? "",
      nif: emp.nif ?? "",
      nib: emp.nib ?? "",
      address: emp.address ?? "",
      birthDate: emp.birthDate ? new Date(emp.birthDate).toISOString().split("T")[0] : "",
      nationality: emp.nationality ?? "",
      position: emp.position ?? "driver",
      extraLevel: emp.extraLevel ?? 1,
      department: emp.department ?? "",
      projectId: emp.projectId ?? null,
      contractType: emp.contractType ?? "permanent",
      contractStart: emp.contractStart ? new Date(emp.contractStart).toISOString().split("T")[0] : "",
      contractEnd: emp.contractEnd ? new Date(emp.contractEnd).toISOString().split("T")[0] : "",
      monthlySalary: emp.monthlySalary ? String(emp.monthlySalary) : "",
      mealAllowancePerDay: emp.mealAllowancePerDay ? String(emp.mealAllowancePerDay) : "",
      userId: emp.userId ?? null,
    });
    setEditing(true);
  };

  const handleSave = () => {
    updateEmployee.mutate({
      id: employeeId,
      fullName: editForm.fullName || undefined,
      email: editForm.email || undefined,
      phone: editForm.phone || undefined,
      nif: editForm.nif || undefined,
      nib: editForm.nib || undefined,
      address: editForm.address || undefined,
      birthDate: editForm.birthDate || undefined,
      nationality: editForm.nationality || undefined,
      position: editForm.position || undefined,
      extraLevel: editForm.position === "extra" ? editForm.extraLevel : undefined,
      department: editForm.department || undefined,
      projectId: editForm.projectId != null ? Number(editForm.projectId) : undefined,
      contractType: editForm.contractType || undefined,
      contractStart: editForm.contractStart || undefined,
      contractEnd: editForm.contractType === "fixed_term" ? editForm.contractEnd || undefined : undefined,
      monthlySalary: editForm.monthlySalary || undefined,
      mealAllowancePerDay: editForm.mealAllowancePerDay || undefined,
      userId: editForm.userId,
    });
  };

  const ef = (k: string, v: any) => setEditForm(f => ({ ...f, [k]: v }));

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">A carregar...</div>;
  if (!data) return <div className="p-8 text-center text-muted-foreground">Colaborador não encontrado</div>;

  const emp = data.employee;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Voltar</Button>
        <h2 className="text-xl font-semibold truncate min-w-0">{emp.fullName}</h2>
        <Badge className={POSITION_COLORS[emp.position as Position]}>{POSITION_LABELS[emp.position as Position]}</Badge>
        <Badge variant={emp.isActive ? "default" : "secondary"} className={emp.isActive ? "bg-green-600" : "bg-muted text-muted-foreground"}>
          {emp.isActive ? "Ativo" : "Inativo"}
        </Badge>
        <div className="flex-1" />
        {!editing && (
          <Button
            variant={emp.isActive ? "outline" : "default"}
            disabled={setActive.isPending}
            onClick={() => {
              const turningOff = !!emp.isActive;
              if (!confirm(turningOff
                ? `Desativar ${emp.fullName}? O login e as notificações por email ficam imediatamente bloqueados.`
                : `Reativar ${emp.fullName}? Volta a ter acesso e a receber emails.`)) return;
              setActive.mutate({ id: employeeId, isActive: !emp.isActive });
            }}
          >
            {emp.isActive ? <X className="w-4 h-4 mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
            {emp.isActive ? "Desativar" : "Reativar"}
          </Button>
        )}
        {!editing ? (
          <Button variant="outline" onClick={startEditing}>
            <Pencil className="w-4 h-4 mr-2" /> Editar
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(false)}>
              <X className="w-4 h-4 mr-2" /> Cancelar
            </Button>
            <Button onClick={handleSave} disabled={updateEmployee.isPending}>
              <Save className="w-4 h-4 mr-2" /> {updateEmployee.isPending ? "A guardar..." : "Guardar"}
            </Button>
          </div>
        )}
      </div>

      {/* Resumo do mês actual: horas, dias, bruto e estimativa líquido */}
      <MyMonthSummaryCard employeeId={employeeId} />

      {/* Alertas (docs, penalizações, bloqueio) */}
      <EmployeeAlertsCard employeeId={employeeId} />

      {/* Profile card — VIEW MODE */}
      {!editing ? (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-start gap-6">
              <div className="relative">
                <Avatar className="w-24 h-24">
                  <AvatarImage src={emp.photoUrl ?? undefined} />
                  <AvatarFallback className="text-2xl bg-primary/10 text-primary">
                    {emp.fullName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <Button
                  size="icon"
                  variant="outline"
                  className="absolute -bottom-2 -right-2 w-7 h-7 rounded-full"
                  onClick={() => photoRef.current?.click()}
                >
                  <Camera className="w-3 h-3" />
                </Button>
                <input ref={photoRef} type="file" className="hidden" accept="image/*" onChange={handlePhoto} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 flex-1">
                {emp.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="w-4 h-4 text-muted-foreground" />
                    <span className="break-all">{emp.email}</span>
                  </div>
                )}
                {emp.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="w-4 h-4 text-muted-foreground" />
                    <span>{emp.phone}</span>
                  </div>
                )}
                {emp.nif && (
                  <div className="flex items-center gap-2 text-sm">
                    <CreditCard className="w-4 h-4 text-muted-foreground" />
                    <span>NIF: {emp.nif}</span>
                  </div>
                )}
                {emp.nib && (
                  <div className="flex items-center gap-2 text-sm">
                    <Euro className="w-4 h-4 text-muted-foreground" />
                    <span className="break-all">NIB: {emp.nib}</span>
                  </div>
                )}
                {emp.address && (
                  <div className="flex items-center gap-2 text-sm sm:col-span-2">
                    <MapPin className="w-4 h-4 text-muted-foreground" />
                    <span className="break-words">{emp.address}</span>
                  </div>
                )}
                {emp.nationality && (
                  <div className="flex items-center gap-2 text-sm">
                    <Shield className="w-4 h-4 text-muted-foreground" />
                    <span>{emp.nationality}</span>
                  </div>
                )}
                {emp.birthDate && (
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                    <span>Nasc: {new Date(emp.birthDate).toLocaleDateString("pt-PT")}</span>
                  </div>
                )}
                {emp.department && (
                  <div className="flex items-center gap-2 text-sm">
                    <Building2 className="w-4 h-4 text-muted-foreground" />
                    <span>{emp.department}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm">
                  <Building2 className={`w-4 h-4 ${emp.projectId ? "text-muted-foreground" : "text-amber-600"}`} />
                  {(() => {
                    const proj = (projectsList as any[]).find(p => p.id === emp.projectId);
                    if (!proj) return <span className="text-amber-600 font-medium">Sem centro de custos — editar para atribuir</span>;
                    return <span>Centro: <span className="font-medium">{proj.name}</span></span>;
                  })()}
                </div>
                {emp.monthlySalary && (
                  <div className="flex items-center gap-2 text-sm font-medium text-green-700">
                    <Euro className="w-4 h-4" />
                    <span>{parseFloat(String(emp.monthlySalary)).toFixed(2)}€/mês</span>
                  </div>
                )}
                {emp.contractType && (
                  <div className="flex items-center gap-2 text-sm">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    <span>{CONTRACT_LABELS[emp.contractType as ContractType]}</span>
                  </div>
                )}
                {emp.contractStart && (
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                    <span>Desde {new Date(emp.contractStart).toLocaleDateString("pt-PT")}</span>
                  </div>
                )}
              </div>
            </div>
            {/* Linked user */}
            <div className="mt-4 pt-4 border-t">
              <div className="flex items-center gap-3">
                <Users className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">Utilizador Associado:</span>
                {emp.userId ? (
                  <Badge variant="secondary">{allUsers.find((u: any) => u.id === emp.userId)?.name ?? "User #" + emp.userId}</Badge>
                ) : (
                  <span className="text-sm text-orange-500">Nenhum</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        /* EDIT MODE */
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Editar Dados do Colaborador</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-6">
              <div className="relative">
                <Avatar className="w-24 h-24">
                  <AvatarImage src={emp.photoUrl ?? undefined} />
                  <AvatarFallback className="text-2xl bg-primary/10 text-primary">
                    {(editForm.fullName || emp.fullName).split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <Button
                  size="icon"
                  variant="outline"
                  className="absolute -bottom-2 -right-2 w-7 h-7 rounded-full"
                  onClick={() => photoRef.current?.click()}
                >
                  <Camera className="w-3 h-3" />
                </Button>
                <input ref={photoRef} type="file" className="hidden" accept="image/*" onChange={handlePhoto} />
              </div>
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Label>Nome Completo *</Label>
                  <Input value={editForm.fullName} onChange={e => ef("fullName", e.target.value)} />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input type="email" value={editForm.email} onChange={e => ef("email", e.target.value)} placeholder="email@empresa.pt" />
                </div>
                <div>
                  <Label>Telefone</Label>
                  <Input value={editForm.phone} onChange={e => ef("phone", e.target.value)} placeholder="+351 9XX XXX XXX" />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>NIF</Label>
                <Input value={editForm.nif} onChange={e => ef("nif", e.target.value)} placeholder="123456789" />
              </div>
              <div>
                <Label>NIB / IBAN</Label>
                <Input value={editForm.nib} onChange={e => ef("nib", e.target.value)} placeholder="PT50..." />
              </div>
              <div className="sm:col-span-2">
                <Label>Morada</Label>
                <Input value={editForm.address} onChange={e => ef("address", e.target.value)} placeholder="Rua, nº, cidade" />
              </div>
              <div>
                <Label>Data de Nascimento</Label>
                <Input type="date" value={editForm.birthDate} onChange={e => ef("birthDate", e.target.value)} />
              </div>
              <div>
                <Label>Nacionalidade</Label>
                <Input value={editForm.nationality} onChange={e => ef("nationality", e.target.value)} />
              </div>
              <div>
                <Label>Posto *</Label>
                <Select value={editForm.position} onValueChange={v => ef("position", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.entries(POSITION_LABELS) as [Position, string][]).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {editForm.position === "extra" && (
                <div>
                  <Label>Nível Extra (1-5)</Label>
                  <Select value={String(editForm.extraLevel)} onValueChange={v => ef("extraLevel", parseInt(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5].map(n => <SelectItem key={n} value={String(n)}>Nível {n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div>
                <Label>Departamento</Label>
                <Input value={editForm.department} onChange={e => ef("department", e.target.value)} placeholder="Ex: Lisboa" />
              </div>
              <div className="sm:col-span-2">
                <Label>Centro de Custos *</Label>
                <Select
                  value={editForm.projectId ? String(editForm.projectId) : ""}
                  onValueChange={v => ef("projectId", parseInt(v))}
                >
                  <SelectTrigger className={!editForm.projectId ? "border-amber-400" : undefined}>
                    <SelectValue placeholder="Escolher centro de custos..." />
                  </SelectTrigger>
                  <SelectContent>
                    {sortProjectsHierarchical(projectsList as any[]).map((p: any) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        <span style={{ paddingLeft: `${p.__depth * 12}px` }} className="inline-flex items-center gap-2">
                          <Badge variant="outline" className={`text-[10px] ${LEVEL_COLOR[p.level ?? "project"] ?? ""}`}>
                            {LEVEL_LABEL[p.level ?? "project"] ?? p.level}
                          </Badge>
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!editForm.projectId && (
                  <p className="text-xs text-amber-600 mt-1">
                    Atribui um centro de custos para o colaborador entrar nas contas de RH/Anual.
                  </p>
                )}
              </div>
              <div>
                <Label>Tipo de Contrato</Label>
                <Select value={editForm.contractType} onValueChange={v => ef("contractType", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.entries(CONTRACT_LABELS) as [ContractType, string][]).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Início do Contrato</Label>
                <Input type="date" value={editForm.contractStart} onChange={e => ef("contractStart", e.target.value)} />
              </div>
              {editForm.contractType === "fixed_term" && (
                <div>
                  <Label>Fim do Contrato</Label>
                  <Input type="date" value={editForm.contractEnd} onChange={e => ef("contractEnd", e.target.value)} />
                </div>
              )}
              {editForm.position !== "extra" && (
                <>
                  <div>
                    <Label>Salário Mensal (€)</Label>
                    <Input type="number" value={editForm.monthlySalary} onChange={e => ef("monthlySalary", e.target.value)} placeholder="1200.00" />
                  </div>
                  <div>
                    <Label>Sub. Alimentação (€/dia)</Label>
                    <Input type="number" value={editForm.mealAllowancePerDay} onChange={e => ef("mealAllowancePerDay", e.target.value)} placeholder="6.00" />
                  </div>
                </>
              )}
              <div className="sm:col-span-2">
                <Label>Utilizador Associado</Label>
                <Select value={editForm.userId ? String(editForm.userId) : "none"} onValueChange={v => ef("userId", v === "none" ? null : parseInt(v))}>
                  <SelectTrigger><SelectValue placeholder="Nenhum" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nenhum</SelectItem>
                    {allUsers.map((u: any) => (
                      <SelectItem key={u.id} value={String(u.id)}>{u.name ?? u.email} ({u.email})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs defaultValue="documents">
        <TabsList className="grid grid-cols-3 w-full">
          <TabsTrigger value="documents"><FileText className="w-4 h-4 mr-2" />Documentos</TabsTrigger>
          <TabsTrigger value="timerecords"><Clock className="w-4 h-4 mr-2" />Ponto</TabsTrigger>
          <TabsTrigger value="schedules"><Calendar className="w-4 h-4 mr-2" />Horário</TabsTrigger>
        </TabsList>
        <TabsContent value="documents" className="mt-4"><DocumentsTab employeeId={employeeId} /></TabsContent>
        <TabsContent value="timerecords" className="mt-4"><TimeRecordsTab employeeId={employeeId} /></TabsContent>
        <TabsContent value="schedules" className="mt-4"><SchedulesTab employeeId={employeeId} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─── MIGRATION 0044 ONE-SHOT BUTTON (super_admin only) ────────────────────────
function RunMigration0044Button() {
  const run = trpc.admin.runMigration0044.useMutation({
    onSuccess: (r) => {
      if (r.failed > 0) toast.error(`Migration falhou em ${r.failed} statements: ${r.errors[0] ?? ""}`);
      else toast.success(`Migration aplicada: ${r.ok} ok, ${r.skipped} já existiam`);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={run.isPending}
      onClick={() => {
        if (!confirm("Aplicar a migration 0044 (tabelas RH + reset extra_rates)?")) return;
        run.mutate();
      }}
    >
      {run.isPending ? "A aplicar..." : "DB: 0044"}
    </Button>
  );
}

// ─── MIGRATION 0046 ONE-SHOT BUTTON (super_admin only) ────────────────────────
function RunMigration0046Button() {
  const run = trpc.admin.runMigration0046.useMutation({
    onSuccess: (r) => {
      if (r.failed > 0) toast.error(`Migration falhou em ${r.failed} statements: ${r.errors[0] ?? ""}`);
      else toast.success(`Migration aplicada: ${r.ok} ok, ${r.skipped} já existiam`);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={run.isPending}
      onClick={() => {
        if (!confirm("Aplicar a migration 0046 (campos novos do /report + tabela multipark_booking_extras)?")) return;
        run.mutate();
      }}
    >
      {run.isPending ? "A aplicar..." : "DB: 0046"}
    </Button>
  );
}

// ─── MIGRATION 0049 ONE-SHOT BUTTON (super_admin only) ────────────────────────
function RunMigration0049Button() {
  const run = trpc.admin.runMigration0049.useMutation({
    onSuccess: (r) => {
      if (r.failed > 0) toast.error(`Migration falhou em ${r.failed} statements: ${r.errors[0] ?? ""}`);
      else toast.success(`Migration aplicada: ${r.ok} ok, ${r.skipped} já existiam`);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={run.isPending}
      onClick={() => {
        if (!confirm("Aplicar a migration 0049 (tabela inbound_emails — leitor de email)?")) return;
        run.mutate();
      }}
    >
      {run.isPending ? "A aplicar..." : "DB: 0049"}
    </Button>
  );
}

// ─── MIGRATION 0050 ONE-SHOT BUTTON (super_admin only) ────────────────────────
function RunMigration0050Button() {
  const run = trpc.admin.runMigration0050.useMutation({
    onSuccess: (r) => {
      if (r.failed > 0) toast.error(`Migration falhou em ${r.failed} statements: ${r.errors[0] ?? ""}`);
      else toast.success(`Migration aplicada: ${r.ok} ok, ${r.skipped} já existiam`);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={run.isPending}
      onClick={() => {
        if (!confirm("Aplicar a migration 0050 (tabela extras_availability — disponibilidade dos extras)?")) return;
        run.mutate();
      }}
    >
      {run.isPending ? "A aplicar..." : "DB: 0050"}
    </Button>
  );
}

// ─── MIGRATION 0051 ONE-SHOT BUTTON (super_admin only) ────────────────────────
function RunMigration0051Button() {
  const run = trpc.admin.runMigration0051.useMutation({
    onSuccess: (r) => {
      if (r.failed > 0) toast.error(`Migration falhou em ${r.failed} statements: ${r.errors[0] ?? ""}`);
      else toast.success(`Migration aplicada: ${r.ok} ok, ${r.skipped} já existiam`);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={run.isPending}
      onClick={() => {
        if (!confirm("Aplicar a migration 0051 (threading de emails: gmThreadId + headerRefs)?")) return;
        run.mutate();
      }}
    >
      {run.isPending ? "A aplicar..." : "DB: 0051"}
    </Button>
  );
}

function BackfillEmployeeProjectButton() {
  const utils = trpc.useUtils();
  const { data: projectsList = [] } = trpc.projects.list.useQuery();
  const [projectId, setProjectId] = useState<number | null>(null);
  const [onlyExtras, setOnlyExtras] = useState(true);
  const run = trpc.admin.backfillEmployeeProject.useMutation({
    onSuccess: (r) => {
      toast.success(`${r.affected} colaboradores atribuídos a ${r.projectName}`);
      utils.rh.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const projName = (projectsList as any[]).find(p => p.id === projectId)?.name ?? "";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={projectId ? String(projectId) : ""} onValueChange={v => setProjectId(parseInt(v))}>
        <SelectTrigger className="w-56" size="sm">
          <SelectValue placeholder="Centro de custos (ex: Lisboa)..." />
        </SelectTrigger>
        <SelectContent>
          {sortProjectsHierarchical(projectsList as any[]).map((p: any) => (
            <SelectItem key={p.id} value={String(p.id)}>
              <span style={{ paddingLeft: `${p.__depth * 12}px` }} className="inline-flex items-center gap-2">
                <Badge variant="outline" className={`text-[10px] ${LEVEL_COLOR[p.level ?? "project"] ?? ""}`}>
                  {LEVEL_LABEL[p.level ?? "project"] ?? p.level}
                </Badge>
                {p.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
        <input type="checkbox" checked={onlyExtras} onChange={e => setOnlyExtras(e.target.checked)} className="h-4 w-4" />
        só extras
      </label>
      <Button
        variant="outline"
        size="sm"
        disabled={run.isPending || !projectId}
        onClick={() => {
          if (!projectId) return;
          const alvo = onlyExtras ? "os extras sem centro" : "todos os colaboradores activos sem centro";
          if (!confirm(`Atribuir o centro de custos "${projName}" a ${alvo}? Vais poder editar individualmente depois.`)) return;
          run.mutate({ projectId, onlyExtras });
        }}
      >
        {run.isPending ? "A atribuir..." : "Atribuir aos sem centro"}
      </Button>
    </div>
  );
}

// ─── EXTRA RATES DIALOG ───────────────────────────────────────────────────────
function ExtraRatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const { data: rates = [] } = trpc.rh.extraRates.list.useQuery();
  const update = trpc.rh.extraRates.update.useMutation({
    onSuccess: () => { utils.rh.extraRates.list.invalidate(); toast.success("Taxa atualizada!"); },
    onError: (e) => toast.error(e.message),
  });

  const [drafts, setDrafts] = useState<Record<number, string>>({});

  useEffect(() => {
    const next: Record<number, string> = {};
    for (const r of rates) next[r.level] = String(r.hourlyRate);
    setDrafts(next);
  }, [rates]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Taxas Horárias — Extras</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {rates.map((r) => (
            <div key={r.level} className="flex items-center gap-3 flex-wrap">
              <Badge variant="outline" className="w-20 justify-center">Nível {r.level}</Badge>
              <Input
                type="number"
                step="0.01"
                value={drafts[r.level] ?? ""}
                onChange={(e) => setDrafts(d => ({ ...d, [r.level]: e.target.value }))}
                className="flex-1"
              />
              <span className="text-sm text-muted-foreground">€/h</span>
              <Button
                size="sm"
                variant="outline"
                disabled={update.isPending}
                onClick={() => update.mutate({ level: r.level, hourlyRate: drafts[r.level] ?? String(r.hourlyRate) })}
              >
                OK
              </Button>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
// ─── PAYROLL TAB ──────────────────────────────────────────────────────────────
const MONTH_NAMES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function PayrollPage({ onBack }: { onBack: () => void }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [sortField, setSortField] = useState<string>("fullName");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailDialog, setEmailDialog] = useState(false);
  const [accountantEmail, setAccountantEmail] = useState("");

  const pdfMutation = trpc.rh.payrollPdf.useMutation();
  const emailMutation = trpc.rh.sendPayrollEmail.useMutation();
  const payslipMutation = trpc.rh.payslipPdf.useMutation();
  const allPayslipsMutation = trpc.rh.allPayslipsPdf.useMutation();
  const [generatingPayslips, setGeneratingPayslips] = useState(false);
  const [payslipResults, setPayslipResults] = useState<Array<{ fullName: string; url: string }> | null>(null);
  const [generatingFor, setGeneratingFor] = useState<number | null>(null);

  const { data: payroll = [], isLoading } = trpc.rh.payroll.useQuery({ year, month });

  const sorted = useMemo(() => {
    return [...payroll].sort((a: any, b: any) => {
      const va = a[sortField] ?? "";
      const vb = b[sortField] ?? "";
      if (typeof va === "number" && typeof vb === "number") return sortDir === "asc" ? va - vb : vb - va;
      return sortDir === "asc" ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
  }, [payroll, sortField, sortDir]);

  const totals = useMemo(() => {
    return payroll.reduce((acc: any, r: any) => ({
      totalHours: acc.totalHours + r.totalHours,
      overtimeHours: acc.overtimeHours + (r.overtimeHours ?? 0),
      nightHours: acc.nightHours + (r.nightHours ?? 0),
      weekendHours: acc.weekendHours + (r.weekendHours ?? 0),
      baseSalary: acc.baseSalary + r.baseSalary,
      extraPayment: acc.extraPayment + r.extraPayment,
      overtimePayment: acc.overtimePayment + r.overtimePayment,
      nightPayment: acc.nightPayment + (r.nightPayment ?? 0),
      weekendPayment: acc.weekendPayment + (r.weekendPayment ?? 0),
      thirteenthProvision: acc.thirteenthProvision + r.thirteenthProvision,
      fourteenthProvision: acc.fourteenthProvision + (r.fourteenthProvision ?? 0),
      mealAllowance: acc.mealAllowance + (r.mealAllowance ?? 0),
      totalPayment: acc.totalPayment + r.totalPayment,
      tsuEmployee: acc.tsuEmployee + (r.tsuEmployee ?? 0),
      irsEstimate: acc.irsEstimate + (r.irsEstimate ?? 0),
      netEstimate: acc.netEstimate + (r.netEstimate ?? 0),
    }), { totalHours: 0, overtimeHours: 0, nightHours: 0, weekendHours: 0, baseSalary: 0, extraPayment: 0, overtimePayment: 0, nightPayment: 0, weekendPayment: 0, thirteenthProvision: 0, fourteenthProvision: 0, mealAllowance: 0, totalPayment: 0, tsuEmployee: 0, irsEstimate: 0, netEstimate: 0 });
  }, [payroll]);

  const toggleSort = (field: string) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  };

  const SortHeader = ({ field, children }: { field: string; children: React.ReactNode }) => (
    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none" onClick={() => toggleSort(field)}>
      <span className="flex items-center gap-1">{children} <ArrowUpDown className="w-3 h-3" /></span>
    </th>
  );

  const fmt = (v: number) => v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const exportPayrollCSV = () => {
    const headers = ["Nome","Posto","Departamento","NIF","NIB","Horas","Dias","Salário Base","Pag. Extra","H.Extra","Pag. H.Extra","H.Noturnas","Pag. Noturnas","H.FDS","Pag. FDS","Prov. 13º","Prov. 14º","Sub. Alim.","Total"];
    const rows = sorted.map((r: any) => [
      r.fullName, r.position, r.department ?? "", r.nif ?? "", r.nib ?? "",
      r.totalHours, r.daysWorked, fmt(r.baseSalary), fmt(r.extraPayment),
      r.overtimeHours, fmt(r.overtimePayment),
      r.nightHours ?? 0, fmt(r.nightPayment ?? 0),
      r.weekendHours ?? 0, fmt(r.weekendPayment ?? 0),
      fmt(r.thirteenthProvision), fmt(r.fourteenthProvision ?? 0),
      fmt(r.mealAllowance ?? 0), fmt(r.totalPayment)
    ]);
    const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `folha_ordenados_${year}_${String(month).padStart(2,"0")}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportTimesheetCSV = () => {
    const headers = ["Nome","Posto","Departamento","Horas Totais","Dias Trabalhados","Horas Extra","Valor/Hora"];
    const rows = sorted.map((r: any) => [
      r.fullName, r.position, r.department ?? "",
      r.totalHours, r.daysWorked, r.overtimeHours, fmt(r.hourlyRate)
    ]);
    const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `folha_ponto_${year}_${String(month).padStart(2,"0")}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Voltar</Button>
        <Wallet className="w-5 h-5 text-primary" />
        <h2 className="text-xl font-semibold">Folha de Ordenados</h2>
      </div>

      {/* Month/Year selector + Export buttons */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={String(month)} onValueChange={v => setMonth(parseInt(v))}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MONTH_NAMES.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={String(year)} onValueChange={v => setYear(parseInt(v))}>
          <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[2024, 2025, 2026, 2027].map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={exportTimesheetCSV}>
          <Download className="w-4 h-4 mr-2" /> Folha de Ponto
        </Button>
        <Button variant="outline" size="sm" onClick={exportPayrollCSV}>
          <Download className="w-4 h-4 mr-2" /> Folha de Ordenados
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={generatingPdf}
          onClick={async () => {
            setGeneratingPdf(true);
            try {
              const result = await pdfMutation.mutateAsync({ year, month });
              window.open(result.url, "_blank");
              toast.success("PDF gerado com sucesso!");
            } catch (e: any) { toast.error(e.message ?? "Erro ao gerar PDF"); }
            setGeneratingPdf(false);
          }}
        >
          <FileText className="w-4 h-4 mr-2" /> {generatingPdf ? "A gerar..." : "PDF"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={generatingPayslips}
          onClick={async () => {
            setGeneratingPayslips(true);
            try {
              const result = await allPayslipsMutation.mutateAsync({ year, month });
              setPayslipResults(result.payslips);
              toast.success(`${result.count} recibos gerados!`);
            } catch (e: any) { toast.error(e.message ?? "Erro ao gerar recibos"); }
            setGeneratingPayslips(false);
          }}
        >
          <FileText className="w-4 h-4 mr-2" /> {generatingPayslips ? "A gerar..." : "Todos os Recibos"}
        </Button>
        <Button
          size="sm"
          disabled={sendingEmail}
          onClick={() => setEmailDialog(true)}
        >
          <Mail className="w-4 h-4 mr-2" /> Enviar ao Contabilista
        </Button>
      </div>

      {/* Email dialog */}
      {emailDialog && (
        <Dialog open onOpenChange={() => setEmailDialog(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Enviar Folha ao Contabilista</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">Email do contabilista</label>
                <Input
                  type="email"
                  placeholder="contabilista@exemplo.pt"
                  value={accountantEmail}
                  onChange={e => setAccountantEmail(e.target.value)}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Será enviado um email com o PDF da folha de ordenados de {MONTH_NAMES[month - 1]} {year} em anexo.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEmailDialog(false)}>Cancelar</Button>
                <Button
                  disabled={!accountantEmail || sendingEmail}
                  onClick={async () => {
                    setSendingEmail(true);
                    try {
                      await emailMutation.mutateAsync({ year, month, email: accountantEmail });
                      toast.success(`Folha enviada para ${accountantEmail}!`);
                      setEmailDialog(false);
                    } catch (e: any) { toast.error(e.message ?? "Erro ao enviar email"); }
                    setSendingEmail(false);
                  }}
                >
                  {sendingEmail ? "A enviar..." : "Enviar"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Payslip results dialog */}
      {payslipResults && (
        <Dialog open onOpenChange={() => setPayslipResults(null)}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Recibos de Vencimento — {MONTH_NAMES[month - 1]} {year}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{payslipResults.length} recibos gerados com sucesso</p>
              {payslipResults.map((ps, i) => (
                <div key={i} className="flex items-center justify-between p-2 rounded-lg border hover:bg-muted/30">
                  <span className="text-sm font-medium truncate min-w-0">{ps.fullName}</span>
                  <Button variant="outline" size="sm" onClick={() => window.open(ps.url, "_blank")}>
                    <Download className="w-3 h-3 mr-1" /> PDF
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex justify-end mt-4">
              <Button variant="outline" onClick={() => setPayslipResults(null)}>Fechar</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Salários Base</p>
            <p className="text-xl font-bold">{fmt(totals.baseSalary)}€</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Prov. 13º + 14º</p>
            <p className="text-xl font-bold">{fmt(totals.thirteenthProvision + totals.fourteenthProvision)}€</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Sub. Alimentação</p>
            <p className="text-xl font-bold">{fmt(totals.mealAllowance)}€</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Noturnas + FDS</p>
            <p className="text-xl font-bold">{fmt(totals.nightPayment + totals.weekendPayment)}€</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Extras + H.Extra</p>
            <p className="text-xl font-bold">{fmt(totals.extraPayment + totals.overtimePayment)}€</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Bruto</p>
            <p className="text-xl font-bold text-primary">{fmt(totals.totalPayment)}€</p>
          </CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50/30">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">
              Estimativa Líquido <span className="text-[10px] text-amber-700">(TSU 11% + IRS 15%)</span>
            </p>
            <p className="text-xl font-bold text-amber-700">{fmt(totals.netEstimate)}€</p>
          </CardContent>
        </Card>
      </div>

      {/* Payroll table */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">A calcular...</div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Banknote className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>Nenhum colaborador ativo encontrado</p>
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/30">
                  <tr>
                    <SortHeader field="fullName">Nome</SortHeader>
                    <SortHeader field="position">Posto</SortHeader>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Dept.</th>
                    <SortHeader field="totalHours">Horas</SortHeader>
                    <SortHeader field="daysWorked">Dias</SortHeader>
                    <SortHeader field="baseSalary">Sal. Base</SortHeader>
                    <SortHeader field="extraPayment">Extra</SortHeader>
                    <SortHeader field="overtimeHours">H. Extra</SortHeader>
                    <SortHeader field="overtimePayment">Pag. H.Extra</SortHeader>
                    <SortHeader field="nightPayment">Noturnas</SortHeader>
                    <SortHeader field="weekendPayment">FDS</SortHeader>
                    <SortHeader field="thirteenthProvision">Prov. 13º</SortHeader>
                    <SortHeader field="fourteenthProvision">Prov. 14º</SortHeader>
                    <SortHeader field="mealAllowance">Sub. Alim.</SortHeader>
                    <SortHeader field="totalPayment">Total</SortHeader>
                    <SortHeader field="netEstimate">Líq. est.</SortHeader>
                    <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Recibo</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r: any) => (
                    <tr key={r.employeeId} className="border-b hover:bg-muted/20">
                      <td className="px-3 py-2 font-medium">{r.fullName}</td>
                      <td className="px-3 py-2">
                        <Badge className={`text-xs ${POSITION_COLORS[r.position as Position]}`}>
                          {POSITION_LABELS[r.position as Position]}
                          {r.isExtra && r.extraLevel ? ` N${r.extraLevel}` : ""}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{r.department ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(r.totalHours)}h</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.daysWorked}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.isExtra ? "—" : fmt(r.baseSalary) + "€"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.isExtra ? fmt(r.extraPayment) + "€" : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.isExtra ? "—" : fmt(r.overtimeHours) + "h"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.isExtra ? "—" : fmt(r.overtimePayment) + "€"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.isExtra ? "—" : fmt(r.nightPayment ?? 0) + "€"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.isExtra ? "—" : fmt(r.weekendPayment ?? 0) + "€"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.isExtra ? "—" : fmt(r.thirteenthProvision) + "€"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.isExtra ? "—" : fmt(r.fourteenthProvision ?? 0) + "€"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.isExtra ? "—" : fmt(r.mealAllowance ?? 0) + "€"}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-primary">{fmt(r.totalPayment)}€</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-700">{fmt(r.netEstimate ?? 0)}€</td>
                      <td className="px-3 py-2 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={generatingFor === r.employeeId}
                          onClick={async (e) => {
                            e.stopPropagation();
                            setGeneratingFor(r.employeeId);
                            try {
                              const result = await payslipMutation.mutateAsync({ year, month, employeeId: r.employeeId });
                              window.open(result.url, "_blank");
                            } catch (err: any) { toast.error(err.message ?? "Erro ao gerar recibo"); }
                            setGeneratingFor(null);
                          }}
                        >
                          {generatingFor === r.employeeId ? (
                            <span className="animate-spin">⏳</span>
                          ) : (
                            <FileText className="w-4 h-4" />
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 bg-muted/30 font-semibold">
                  <tr>
                    <td className="px-3 py-2" colSpan={3}>Totais</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.totalHours)}h</td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.baseSalary)}€</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.extraPayment)}€</td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.overtimePayment)}€</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.nightPayment)}€</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.weekendPayment)}€</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.thirteenthProvision)}€</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.fourteenthProvision)}€</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.mealAllowance)}€</td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold text-primary">{fmt(totals.totalPayment)}€</td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold text-amber-700">{fmt(totals.netEstimate)}€</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Aba RECRUTAMENTO: extraída para components/RecruitmentSection (partilhada
// com o hub da página Disponibilidade) — com email completo, anexos e notas.

export default function HRPage() {
  const { user } = useAuth();
  const userRole = user?.role ?? "user";
  const isExtra = userRole === "extra" || userRole === "user";

  // Extra users: show only their own profile
  const { data: myEmployee } = trpc.rh.me.useQuery(undefined, { enabled: isExtra });

  // Filtros persistem à navegação (sessionStorage) — voltar de uma ficha ou de
  // outra página mantém pesquisa, posto, conta, ativo/inativo e projeto.
  const [search, setSearch] = usePersistedState("hr.search", "");
  const [showCreate, setShowCreate] = useState(false);
  const [showRates, setShowRates] = useState(false);
  const [selectedId, setSelectedId] = usePersistedState<number | null>("hr.selectedId", null);
  const [filterPosition, setFilterPosition] = usePersistedState<string>("hr.position", "all");
  const [filterAccount, setFilterAccount] = usePersistedState<string>("hr.account", "all");
  const [filterActive, setFilterActive] = usePersistedState<string>("hr.active", "active");
  const [filterProject, setFilterProject] = usePersistedState<string>("hr.project", "all");
  // Separador Colaboradores/Extras/Recrutamento também persiste — voltar de
  // uma ficha de extra mantém-nos nos Extras (bug reportado pelo Jorge)
  const [activeTab, setActiveTab] = usePersistedState<string>("hr.tab", "employees");
  const [showPayroll, setShowPayroll] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showUsers, setShowUsers] = useState(false);

  const { data: employees = [], isLoading } = trpc.rh.list.useQuery({
    isActive: filterActive === "inactive" ? false : true,
    position: filterPosition !== "all" ? filterPosition : undefined,
  }, { enabled: !isExtra });
  const { data: docStatus = {} } = trpc.rh.documents.allStatus.useQuery(undefined, { enabled: !isExtra });
  const { data: allProjects = [] } = trpc.projects.list.useQuery(undefined, { enabled: !isExtra });

  // Descendentes do projeto filtrado (cidade/marca/projeto), para filtrar por centro de custos
  const projectFilterIds = useMemo(() => {
    if (filterProject === "all") return null;
    const root = Number(filterProject);
    const ids = new Set<number>([root]);
    const walk = (pid: number) => {
      for (const p of allProjects as any[]) {
        if (p.parentId === pid) { ids.add(p.id); walk(p.id); }
      }
    };
    walk(root);
    return ids;
  }, [filterProject, allProjects]);

  // Extra users go directly to their profile
  if (isExtra) {
    if (!myEmployee) {
      return (
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center space-y-2">
            <Users className="w-12 h-12 mx-auto text-muted-foreground" />
            <p className="text-muted-foreground">O seu perfil de colaborador ainda não foi criado.</p>
            <p className="text-sm text-muted-foreground">Contacte a administração.</p>
          </div>
        </div>
      );
    }
    return <EmployeeDetail employeeId={myEmployee.employee.id} onBack={() => {}} />;
  }

  const filtered = employees.filter(({ employee: e }) => {
    const matchesSearch = e.fullName.toLowerCase().includes(search.toLowerCase()) ||
      (e.email ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (e.department ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesAccount = filterAccount === "all" ? true
      : filterAccount === "with" ? !!e.userId
      : !e.userId;
    const matchesProject = !projectFilterIds || (e.projectId != null && projectFilterIds.has(e.projectId));
    return matchesSearch && matchesAccount && matchesProject;
  });

  if (showPayroll) {
    return <PayrollPage onBack={() => setShowPayroll(false)} />;
  }

  if (showDashboard) {
    return <RhDashboardPage onBack={() => setShowDashboard(false)} />;
  }

  if (showUsers) {
    return <UsersPage onBack={() => setShowUsers(false)} />;
  }

  if (selectedId !== null) {
    return <EmployeeDetail employeeId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  const exportEmployeesCSV = () => {
    const headers = ["Nome","Email","Telefone","NIF","NIB","Morada","Posto","Departamento","Contrato","Salário","Conta Ativa"];
    const rows = filtered.map(({ employee: e }) => [
      e.fullName, e.email ?? "", e.phone ?? "", e.nif ?? "", e.nib ?? "",
      e.address ?? "", POSITION_LABELS[e.position as Position] ?? e.position,
      e.department ?? "", CONTRACT_LABELS[(e.contractType ?? "permanent") as ContractType] ?? e.contractType,
      e.monthlySalary ? parseFloat(String(e.monthlySalary)).toFixed(2) : "",
      e.userId ? "Sim" : "Não"
    ]);
    const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `lista_funcionarios_${new Date().toISOString().split("T")[0]}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const employeesList = filtered.filter(({ employee: e }) => e.position !== "extra");
  const extrasList = filtered.filter(({ employee: e }) => e.position === "extra");

  const renderCard = ({ employee: emp }: { employee: any }) => (
    <Card
      key={emp.id}
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={() => setSelectedId(emp.id)}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <Avatar className="w-12 h-12">
            <AvatarImage src={emp.photoUrl ?? undefined} />
            <AvatarFallback className="bg-primary/10 text-primary font-semibold">
              {emp.fullName.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="font-semibold truncate">{emp.fullName}</p>
            <Badge className={`text-xs mt-1 ${POSITION_COLORS[emp.position as Position]}`}>
              {POSITION_LABELS[emp.position as Position]}
              {emp.position === "extra" && emp.extraLevel ? ` N${emp.extraLevel}` : ""}
            </Badge>
          </div>
        </div>
        <div className="mt-3 space-y-1">
          {emp.email && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
              <Mail className="w-3 h-3 shrink-0" /> <span className="truncate">{emp.email}</span>
            </p>
          )}
          {emp.department && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Building2 className="w-3 h-3" /> {emp.department}
            </p>
          )}
          {emp.monthlySalary && (
            <p className="text-xs font-medium text-green-700 flex items-center gap-1">
              <Euro className="w-3 h-3" /> {parseFloat(String(emp.monthlySalary)).toFixed(2)}€/mês
            </p>
          )}
          {emp.userId ? (
            <p className="text-xs text-blue-600 flex items-center gap-1">
              <Shield className="w-3 h-3" /> Conta ativa
            </p>
          ) : (
            <p className="text-xs text-orange-500 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Sem conta
            </p>
          )}
          {(() => {
            const status = (docStatus as Record<number, { total: number; present: number; missing: string[] }>)[emp.id];
            const missing = status ? status.total - status.present : 7;
            if (missing === 0) return (
              <p className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Docs completos
              </p>
            );
            return (
              <p className="text-xs text-orange-600 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> {missing} doc{missing > 1 ? "s" : ""} em falta
              </p>
            );
          })()}
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto w-full">
      {/* Header com novo colaborador destacado + dropdown de ações */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-muted-foreground text-sm">Gestão de colaboradores, ponto e documentação</p>
        <div className="flex items-center gap-2 flex-wrap">
          {userRole === "super_admin" && <BackfillEmployeeProjectButton />}
          {userRole === "super_admin" && (
            <Button variant="outline" size="sm" onClick={() => setShowDashboard(true)}>
              <BarChart3 className="w-4 h-4 mr-2" /> Dashboard
            </Button>
          )}
          <Button onClick={() => setShowCreate(true)} size="sm">
            <UserPlus className="w-4 h-4 mr-2" /> Novo Colaborador
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <MoreVertical className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={exportEmployeesCSV}>
                <Download className="w-4 h-4 mr-2" /> Exportar lista (CSV)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowPayroll(true)}>
                <Wallet className="w-4 h-4 mr-2" /> Folha de Ordenados
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowRates(true)}>
                <Euro className="w-4 h-4 mr-2" /> Taxas Extra
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowImport(true)}>
                <Upload className="w-4 h-4 mr-2" /> Importar Extras (CSV)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowUsers(true)}>
                <Shield className="w-4 h-4 mr-2" /> Utilizadores e Permissões
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <HRStatsBar />

      {/* Aviso de dados em falta nos FIXOS (o que trava a folha de ordenados) */}
      {(() => {
        if (filterActive === "inactive") return null;
        const fixosIncompletos = employees
          .filter(({ employee: e }: any) => e.position !== "extra")
          .map(({ employee: e }: any) => {
            const faltas: string[] = [];
            if (!e.monthlySalary || parseFloat(String(e.monthlySalary)) === 0) faltas.push("salário");
            if (!e.nif) faltas.push("NIF");
            if (!e.nib) faltas.push("NIB");
            return { nome: e.fullName, id: e.id, faltas };
          })
          .filter((x) => x.faltas.length > 0);
        if (fixosIncompletos.length === 0) return null;
        return (
          <Card className="border-amber-300 bg-amber-50/60">
            <CardContent className="p-3 text-sm">
              <p className="font-medium text-amber-800 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" /> {fixosIncompletos.length} colaborador(es) fixo(s) com dados em falta para a folha de ordenados:
              </p>
              <p className="text-xs text-amber-700 mt-1">
                {fixosIncompletos.slice(0, 8).map((x) => `${x.nome} (${x.faltas.join(", ")})`).join(" · ")}
                {fixosIncompletos.length > 8 ? ` · +${fixosIncompletos.length - 8}` : ""}
              </p>
            </CardContent>
          </Card>
        );
      })()}

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Pesquisar colaborador..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <Select value={filterPosition} onValueChange={setFilterPosition}>
          <SelectTrigger className="w-full sm:w-44"><SelectValue placeholder="Todos os postos" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os postos</SelectItem>
            {(Object.entries(POSITION_LABELS) as [Position, string][]).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterAccount} onValueChange={setFilterAccount}>
          <SelectTrigger className="w-full sm:w-40"><SelectValue placeholder="Conta" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as contas</SelectItem>
            <SelectItem value="with">Com conta</SelectItem>
            <SelectItem value="without">Sem conta</SelectItem>
          </SelectContent>
        </Select>
        {/* Cidade / centro de custos / projeto */}
        <Select value={filterProject} onValueChange={setFilterProject}>
          <SelectTrigger className="w-full sm:w-52"><SelectValue placeholder="Centro de custos" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os centros</SelectItem>
            {(() => {
              const result: any[] = [];
              const walk = (parentId: number | null, depth: number) => {
                (allProjects as any[]).filter((p) => p.parentId === parentId).forEach((p) => {
                  result.push({ ...p, depth });
                  walk(p.id, depth + 1);
                });
              };
              walk(null, 0);
              return result.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {" ".repeat(p.depth * 2)}{p.level === "city" ? "📍" : p.level === "brand" ? "🏷" : p.level === "group" ? "🏢" : "📁"} {p.name}
                </SelectItem>
              ));
            })()}
          </SelectContent>
        </Select>
        {/* Ativos / desativados — os desativados mantêm histórico e podem ser reativados */}
        <Select value={filterActive} onValueChange={setFilterActive}>
          <SelectTrigger className="w-full sm:w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Ativos</SelectItem>
            <SelectItem value="inactive">Desativados</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Tabs Colaboradores / Extras */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">A carregar colaboradores...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>Nenhum colaborador encontrado</p>
          <Button className="mt-4" onClick={() => setShowCreate(true)}>
            <UserPlus className="w-4 h-4 mr-2" /> Adicionar primeiro colaborador
          </Button>
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="employees">
              Colaboradores <Badge variant="secondary" className="ml-2">{employeesList.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="extras">
              Extras <Badge variant="secondary" className="ml-2">{extrasList.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="agentes">
              Agentes s/ funcionário <UnlinkedAgentsBadge />
            </TabsTrigger>
            <TabsTrigger value="recrutamento">
              <Mail className="w-4 h-4 mr-2" />Recrutamento
            </TabsTrigger>
          </TabsList>
          <TabsContent value="employees" className="mt-4">
            {employeesList.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">Sem colaboradores nesta categoria</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {employeesList.map(renderCard)}
              </div>
            )}
          </TabsContent>
          <TabsContent value="extras" className="mt-4">
            {extrasList.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">Sem extras nesta categoria</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {extrasList.map(renderCard)}
              </div>
            )}
          </TabsContent>
          <TabsContent value="agentes" className="mt-4">
            <UnlinkedAgentsSection />
          </TabsContent>
          <TabsContent value="recrutamento" className="mt-4">
            <RecruitmentSection />
          </TabsContent>
        </Tabs>
      )}

      <CreateEmployeeDialog open={showCreate} onClose={() => setShowCreate(false)} />
      <ImportExtrasDialog open={showImport} onClose={() => setShowImport(false)} />
      <ExtraRatesDialog open={showRates} onClose={() => setShowRates(false)} />
    </div>
  );
}

// ─── Importar extras via CSV ──────────────────────────────────────────────────

function ImportExtrasDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<{
    parsed: number;
    created: number;
    errors: { rowIndex: number; nome?: string; reason: string }[];
    unknownColumns: string[];
  } | null>(null);

  const importMutation = trpc.rh.importExtras.useMutation({
    onSuccess: (r) => {
      setReport(r);
      utils.rh.list.invalidate();
      utils.rh.stats.invalidate();
      if (r.created > 0) toast.success(`${r.created} extras criados`);
      if (r.errors.length > 0) toast.warning(`${r.errors.length} linhas com erro`);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleFile = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setReport(null);
  };

  const handleImport = () => {
    if (!csv.trim()) {
      toast.error("Cola um CSV ou seleciona um ficheiro.");
      return;
    }
    setReport(null);
    importMutation.mutate({ csv });
  };

  const TEMPLATE_HEADERS = [
    "nome",
    "nivel",
    "salario_mensal",
    "subsidio_alim_dia",
    "nif",
    "nib",
    "telefone",
    "email",
    "morada",
    "nacionalidade",
    "data_nascimento",
  ];
  const exampleCsv =
    TEMPLATE_HEADERS.join(",") +
    "\nJoão Silva,junior,800,7.63,123456789,PT50001801234567890123456,912345678,joao@example.pt,Rua Exemplo 1,Portuguesa,1990-05-15";

  const downloadTemplate = () => {
    // BOM ensures Excel opens with UTF-8 (preserves ç, ã, etc.)
    const csvBody = TEMPLATE_HEADERS.join(",") + "\n,,,,,,,,,,";
    const blob = new Blob(["﻿" + csvBody], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "modelo_extras.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Importar Extras de CSV</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={downloadTemplate}>
              <Download className="w-3.5 h-3.5 mr-1" /> Descarregar modelo CSV
            </Button>
          </div>

          <div>
            <Label htmlFor="csv-file" className="text-xs">Ficheiro CSV</Label>
            <Input
              id="csv-file"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Cabeçalho obrigatório: <code>nome</code>, <code>nivel</code> (junior/senior/terminal/master).
              Opcional: <code>salario_mensal</code>, <code>subsidio_alim_dia</code>, <code>nif</code>, <code>nib</code>,{" "}
              <code>telefone</code>, <code>email</code>, <code>morada</code>, <code>nacionalidade</code>, <code>data_nascimento</code> (YYYY-MM-DD).
            </p>
          </div>

          <div>
            <Label className="text-xs">Ou cola conteúdo CSV</Label>
            <textarea
              className="mt-1 w-full font-mono text-xs border rounded-md p-2 min-h-[120px] bg-card"
              value={csv}
              onChange={(e) => { setCsv(e.target.value); setReport(null); }}
              placeholder={exampleCsv}
            />
          </div>

          {report && (
            <div className="rounded-md border p-3 space-y-2 text-xs">
              <div>
                <strong>Resultado:</strong> {report.created} criados de {report.parsed} linhas.
              </div>
              {report.unknownColumns.length > 0 && (
                <div className="text-amber-700">
                  Colunas desconhecidas (ignoradas): {report.unknownColumns.join(", ")}
                </div>
              )}
              {report.errors.length > 0 && (
                <div className="text-red-700">
                  <div className="font-medium">{report.errors.length} erro(s):</div>
                  <ul className="space-y-0.5 mt-1">
                    {report.errors.slice(0, 20).map((e, i) => (
                      <li key={i}>
                        Linha {e.rowIndex}{e.nome ? ` (${e.nome})` : ""}: {e.reason}
                      </li>
                    ))}
                    {report.errors.length > 20 && (
                      <li>...e mais {report.errors.length - 20}</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
          <Button onClick={handleImport} disabled={importMutation.isPending || !csv.trim()}>
            {importMutation.isPending ? "A importar..." : "Importar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── AGENTES MULTIPARK SEM FUNCIONÁRIO (pedido Jorge 2026-08-06) ─────────────
// Agentes com atividade no histórico que não estão ligados a nenhum
// colaborador nem parceiro. Daqui liga-se a um colaborador existente, a um
// parceiro (agências que marcam pelo portal), ou cria-se o funcionário.
function UnlinkedAgentsBadge() {
  const { data = [] } = trpc.multipark.unlinkedAgents.useQuery();
  if (data.length === 0) return null;
  return <Badge variant="secondary" className="ml-2">{data.length}</Badge>;
}

function UnlinkedAgentsSection() {
  const utils = trpc.useUtils();
  const { data: agents = [], isLoading } = trpc.multipark.unlinkedAgents.useQuery();
  const { data: employees = [] } = trpc.multipark.employeesForMapping.useQuery();
  const { data: partnershipsList = [] } = trpc.partnerships.list.useQuery({} as any);
  const refresh = () => { utils.multipark.unlinkedAgents.invalidate(); utils.multipark.employeesForMapping.invalidate(); };
  const mapMut = trpc.multipark.mapAgentToEmployee.useMutation({
    onSuccess: () => { refresh(); toast.success("Agente ligado ao colaborador"); },
    onError: (e) => toast.error(e.message),
  });
  const partnerMut = trpc.multipark.setAgentPartner.useMutation({
    onSuccess: () => { refresh(); toast.success("Agente ligado ao parceiro"); },
    onError: (e) => toast.error(e.message),
  });
  const createMut = trpc.multipark.createEmployeeFromAgent.useMutation({
    onSuccess: () => { refresh(); utils.rh.list.invalidate(); toast.success("Funcionário criado a partir do agente — completa a ficha (email, morada, nível)"); },
    onError: (e) => toast.error(e.message),
  });
  const { data: ignoredList = [] } = trpc.multipark.ignoredAgents.useQuery();
  const [showIgnored, setShowIgnored] = useState(false);
  const ignoreMut = trpc.multipark.ignoreAgent.useMutation({
    onSuccess: (_d, vars) => {
      refresh(); utils.multipark.ignoredAgents.invalidate();
      toast.success(vars.ignored ? "Marcado como \"não é funcionário\" — saiu da lista" : "Reposto na lista de agentes por ligar");
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-3">
      <Card className="border-amber-200 bg-amber-50/40">
        <CardContent className="p-3 text-sm text-amber-900">
          Estes agentes têm atividade na Multipark mas não estão ligados a ninguém.
          Liga cada um a um <strong>colaborador</strong>, a um <strong>parceiro</strong> (agências que marcam pelo portal),
          cria o funcionário — ou marca <strong>"não é funcionário"</strong> (testes, integrações, reservas de sistema) para o tirar da lista.
        </CardContent>
      </Card>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">A carregar…</p>
      ) : agents.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Todos os agentes estão ligados ✓</CardContent></Card>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="p-2">Agente</th>
                <th className="p-2 text-right">Ações</th>
                <th className="p-2 text-right">In / Out / Mov</th>
                <th className="p-2">Última atividade</th>
                <th className="p-2">Ligar a</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a: any) => (
                <tr key={a.agentName} className="border-b hover:bg-muted/30 align-top">
                  <td className="p-2 font-medium max-w-[200px]">{a.agentName}</td>
                  <td className="p-2 text-right font-semibold tabular-nums">{a.total}</td>
                  <td className="p-2 text-right text-xs tabular-nums">
                    <span className="text-emerald-700">{a.checkins}</span> / <span className="text-blue-700">{a.checkouts}</span> / {a.movements}
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">{a.lastSeen ? fmtPTDate(a.lastSeen) : "—"}</td>
                  <td className="p-2">
                    <div className="flex flex-col gap-1">
                      <SearchableSelect
                        className="h-8 w-64"
                        value=""
                        onChange={(v: string) => v && mapMut.mutate({ agentName: a.agentName, employeeId: Number(v) })}
                        placeholder="— colaborador existente —"
                        options={(employees as any[]).map((e) => ({ value: String(e.id), label: e.fullName }))}
                      />
                      <div className="flex items-center gap-1.5">
                        <SearchableSelect
                          className="h-7 w-44 text-xs"
                          value=""
                          onChange={(v: string) => v && partnerMut.mutate({ agentName: a.agentName, partnershipId: Number(v) })}
                          placeholder="— parceiro —"
                          options={((partnershipsList as any[]) ?? []).map((pp: any) => ({ value: String(pp.id ?? pp.partnership?.id), label: pp.name ?? pp.partnership?.name ?? `#${pp.id}` }))}
                        />
                        <Button
                          size="sm" variant="outline" className="h-7 text-xs"
                          disabled={createMut.isPending}
                          onClick={() => { if (confirm(`Criar funcionário extra "${a.agentName}" (cidade Lisboa por defeito)?`)) createMut.mutate({ agentName: a.agentName }); }}
                        >
                          + Criar funcionário
                        </Button>
                        <Button
                          size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-red-600"
                          disabled={ignoreMut.isPending}
                          title="Teste, integração ou reserva de sistema — não é uma pessoa"
                          onClick={() => { if (confirm(`"${a.agentName}" não é funcionário nem parceiro? Sai da lista (reversível).`)) ignoreMut.mutate({ agentName: a.agentName, ignored: true }); }}
                        >
                          🚫 Não é funcionário
                        </Button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Ignorados ("não é funcionário") — reversível */}
      {ignoredList.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            className="text-xs text-muted-foreground hover:underline"
            onClick={() => setShowIgnored((v) => !v)}
          >
            {showIgnored ? "▾" : "▸"} {ignoredList.length} marcado(s) como "não é funcionário"
          </button>
          {showIgnored && (
            <div className="flex flex-wrap gap-2">
              {(ignoredList as string[]).map((name) => (
                <Badge key={name} variant="outline" className="gap-2 text-xs">
                  {name}
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    title="Repor na lista"
                    onClick={() => ignoreMut.mutate({ agentName: name, ignored: false })}
                  >
                    ↩
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
