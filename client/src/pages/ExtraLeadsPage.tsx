/**
 * Leads de Extras — contactos que AINDA não são extras mas estão a ser recrutados.
 *
 * Um lead tem nome e telemóvel e/ou email (pelo menos um). Daqui contactam-se
 * por WhatsApp com o template `seja_motorista` (sem parâmetros) — um a um ou em
 * lote — e acompanha-se o estado: Novo → Contactado → Respondeu → Convertido /
 * Sem interesse. As candidaturas do site e os emails de recrutamento entram aqui
 * sozinhos (origem Site / Email); uma mensagem WhatsApp do lead marca-o como
 * "Respondeu". Em cima: o funil (origem × cidade × semana) e a faixa "Atenção"
 * (novos sem contacto >24h, contactados sem resposta >3 dias).
 * O envio usa o MESMO caminho dos extras (inspeção do template na Meta, conversa
 * no inbox com o nome do lead, mensagem gravada), ver server/extraLeads.ts.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { AlertTriangle, Clock, Filter, Mail, MapPin, MessageCircle, Pencil, Phone, Plus, Search, Send, Trash2, UserPlus, X } from "lucide-react";
import { findWhatsAppTemplate, LEAD_RECRUITMENT_TEMPLATE_ID } from "@shared/whatsappTemplate";
import { matchesContactQuery } from "@shared/contactSearch";
import { can } from "@shared/access";
import { useAuth } from "@/_core/hooks/useAuth";
import LeadScoreCell, { type LeadScoreRow } from "@/components/aiOps/LeadScoreCell";
import {
  LEAD_SLA,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  leadAttention,
  pct,
  type LeadAttention,
  type LeadStatus,
} from "@shared/extraLeadsFunnel";

const STATUS: Record<LeadStatus, { label: string; className: string }> = {
  new: { label: "Novo", className: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  contacted: { label: "Contactado", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  replied: { label: "Respondeu", className: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300" },
  converted: { label: "Convertido", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  declined: { label: "Sem interesse", className: "bg-muted text-muted-foreground" },
};
const STATUS_ORDER: LeadStatus[] = ["new", "contacted", "replied", "converted", "declined"];

const SOURCE_BADGE: Record<string, string> = {
  manual: "border-slate-300 text-slate-600 dark:text-slate-300",
  site: "border-sky-300 text-sky-700 dark:text-sky-300",
  email: "border-fuchsia-300 text-fuchsia-700 dark:text-fuchsia-300",
};

const ATTENTION_LABEL: Record<LeadAttention, string> = {
  new_stale: `Novos sem contacto há +${LEAD_SLA.newNoContactHours}h`,
  contacted_stale: `Contactados sem resposta há +${LEAD_SLA.contactedNoReplyDays} dias`,
};

type LeadRow = {
  id: number;
  fullName: string;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  status: LeadStatus;
  notes: string | null;
  source: string;
  projectId: number | null;
  contactCount: number;
  lastContactedAt: string | null;
  lastInboundAt: string | null;
  createdAt: string;
  employeeId?: number | null;
};

/** `city` = id do nó de cidade ("" = sem cidade) — só na edição. */
type LeadDraft = { fullName: string; phone: string; email: string; notes: string; city: string };
const EMPTY_DRAFT: LeadDraft = { fullName: "", phone: "", email: "", notes: "", city: "" };
const NO_CITY = "none";

/** Timestamp da BD ('YYYY-MM-DD HH:MM:SS', UTC) → "dd/mm hh:mm" local. */
function fmtWhen(s: string | null): string {
  if (!s) return "—";
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("pt-PT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Mesma regra do servidor (normalizeLeadInput): nome + telemóvel OU email. */
function validateDraft(d: LeadDraft): string | null {
  if (d.fullName.trim().length < 2) return "Indica o nome do contacto.";
  if (!d.phone.trim() && !d.email.trim()) return "Indica o telemóvel ou o email (pelo menos um).";
  if (d.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) return "Email inválido.";
  return null;
}

export default function ExtraLeadsPage() {
  const template = findWhatsAppTemplate(LEAD_RECRUITMENT_TEMPLATE_ID)!;

  const [statusFilter, setStatusFilter] = useState<LeadStatus | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [attentionFilter, setAttentionFilter] = useState<LeadAttention | null>(null);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Diálogo criar/editar
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<LeadRow | null>(null);
  const [draft, setDraft] = useState<LeadDraft>(EMPTY_DRAFT);

  // Diálogo de envio WhatsApp (1 lead ou o lote selecionado)
  const [contactOpen, setContactOpen] = useState(false);
  const [contactIds, setContactIds] = useState<number[]>([]);
  const [contactResult, setContactResult] = useState<null | {
    total: number; sent: number; failed: number; noPhone: number;
    results: { leadId: number; fullName: string; status: string; error?: string }[];
  }>(null);

  const [deleteFor, setDeleteFor] = useState<LeadRow | null>(null);

  // Converter em extra: escolher a cidade (centro de custos), como na aprovação
  // das candidaturas do site. `projects.list` já vem limitado às cidades do utilizador.
  const [convertFor, setConvertFor] = useState<LeadRow | null>(null);
  const [convertProjectId, setConvertProjectId] = useState<string>("");
  const projects = trpc.projects.list.useQuery();
  const cityProjects = useMemo(
    () =>
      (projects.data ?? [])
        .filter((p: any) => p.level === "city")
        .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), "pt")),
    [projects.data],
  );
  function openConvert(l: LeadRow) {
    setConvertProjectId(cityProjects.length === 1 ? String(cityProjects[0].id) : "");
    setConvertFor(l);
  }

  // Vem tudo e o estado filtra aqui: os contadores dos chips contam sempre
  // o total de cada estado (antes contavam só o estado escolhido).
  const list = trpc.extraLeads.list.useQuery(undefined, { refetchInterval: 60_000 });
  const allLeads = (list.data ?? []) as LeadRow[];
  const funnel = trpc.extraLeads.funnel.useQuery({ weeks: 12 }, { refetchInterval: 5 * 60_000 });
  const cityName = useMemo(() => new Map((projects.data ?? []).map((p: any) => [p.id as number, String(p.name)])), [projects.data]);

  // Faixa "Atenção" (mesma regra do cron: shared/extraLeadsFunnel.ts)
  const attentionById = useMemo(() => {
    const now = Date.now();
    const m = new Map<number, LeadAttention>();
    for (const l of allLeads) {
      const a = leadAttention(l, now);
      if (a) m.set(l.id, a);
    }
    return m;
  }, [allLeads]);
  const attentionCounts = useMemo(() => {
    const c: Record<LeadAttention, number> = { new_stale: 0, contacted_stale: 0 };
    attentionById.forEach((a) => { c[a]++; });
    return c;
  }, [attentionById]);

  // Origem e "Atenção" filtram antes do estado (os chips contam dentro da origem)
  const bySource = useMemo(
    () =>
      allLeads.filter(
        (l) => (sourceFilter === "all" || (l.source || "manual") === sourceFilter) && (!attentionFilter || attentionById.get(l.id) === attentionFilter),
      ),
    [allLeads, sourceFilter, attentionFilter, attentionById],
  );
  const leads = useMemo(
    () => (statusFilter === "all" ? bySource : bySource.filter((l) => l.status === statusFilter)),
    [bySource, statusFilter],
  );

  const trimmedSearch = search.trim();
  // Filtro local (a lista já vem completa): nome, email ou número, como no inbox.
  const shown = useMemo(
    () =>
      trimmedSearch
        ? leads.filter(
            (l) =>
              matchesContactQuery(trimmedSearch, { name: l.fullName, phone: l.phoneE164 ?? l.phone }) ||
              (l.email ?? "").toLowerCase().includes(trimmedSearch.toLowerCase()),
          )
        : leads,
    [leads, trimmedSearch],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: bySource.length };
    for (const s of STATUS_ORDER) c[s] = 0;
    for (const l of bySource) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [bySource]);

  const invalidate = () => { list.refetch(); funnel.refetch(); };
  const clearSelection = () => setSelectedIds(new Set());

  const bulk = trpc.extraLeads.bulkUpdate.useMutation({
    onSuccess: (r) => {
      if (r.skipped.length) {
        toast.warning(`${r.updated} atualizado(s) · ${r.skipped.length} de fora: ${r.skipped.slice(0, 3).map((x) => `${x.fullName ?? `#${x.leadId}`} (${x.error})`).join("; ")}${r.skipped.length > 3 ? "…" : ""}`);
      } else {
        toast.success(`${r.updated} lead${r.updated === 1 ? "" : "s"} atualizado${r.updated === 1 ? "" : "s"}.`);
      }
      clearSelection();
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const convert = trpc.extraLeads.convert.useMutation({
    onSuccess: (r) => {
      toast.success(r.created ? "Ficha de extra criada — já aparece na disponibilidade e na escala." : "Lead ligado à ficha de extra que já existia.");
      setConvertFor(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const create = trpc.extraLeads.create.useMutation({
    onSuccess: (r) => { toast.success(`Lead criado: ${r.fullName}`); setEditOpen(false); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.extraLeads.update.useMutation({
    onSuccess: () => { toast.success("Lead atualizado"); setEditOpen(false); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.extraLeads.remove.useMutation({
    onSuccess: () => { toast.success("Lead apagado"); setDeleteFor(null); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const contact = trpc.extraLeads.contact.useMutation({
    onSuccess: (r) => {
      setContactResult(r);
      if (r.sent === r.total) toast.success(`WhatsApp enviado a ${r.sent} lead${r.sent === 1 ? "" : "s"}.`);
      else toast.warning(`${r.sent} enviados · ${r.failed} falhas · ${r.noPhone} sem telemóvel`);
      setSelectedIds(new Set());
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // Texto REAL do template aprovado na Meta — só pedido com o diálogo aberto.
  const preview = trpc.whatsapp.templatePreview.useQuery(
    { templateName: template.name, languageCode: template.language },
    { enabled: contactOpen, staleTime: 5 * 60_000, retry: false },
  );

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setEditOpen(true);
  }
  function openEdit(l: LeadRow) {
    setEditing(l);
    setDraft({ fullName: l.fullName, phone: l.phone ?? "", email: l.email ?? "", notes: l.notes ?? "", city: l.projectId != null ? String(l.projectId) : "" });
    setEditOpen(true);
  }
  function submitDraft() {
    const problem = validateDraft(draft);
    if (problem) { toast.error(problem); return; }
    const payload = {
      fullName: draft.fullName.trim(),
      phone: draft.phone.trim() || null,
      email: draft.email.trim() || null,
      notes: draft.notes.trim() || null,
    };
    if (editing) {
      const projectId = draft.city ? Number(draft.city) : null;
      update.mutate({ id: editing.id, ...payload, ...(projectId !== editing.projectId ? { projectId } : {}) });
    } else create.mutate(payload);
  }
  function openContact(ids: number[]) {
    setContactIds(ids);
    setContactResult(null);
    setContactOpen(true);
  }

  const contactTargets = contactIds.map((id) => allLeads.find((l) => l.id === id)).filter((l): l is LeadRow => !!l);
  const contactWithPhone = contactTargets.filter((l) => !!l.phoneE164).length;
  const shownWithPhone = shown.filter((l) => !!l.phoneE164);
  // Pontuação (critérios explícitos, calculada no servidor) das leads mostradas.
  const { user } = useAuth();
  const canEditLeads = !!user && can(user as any, "leads_extras", "edit");
  const scoreIds = useMemo(() => shown.slice(0, 200).map((l) => l.id), [shown]);
  const scores = trpc.aiOps.leads.scores.useQuery({ leadIds: scoreIds }, { enabled: scoreIds.length > 0, staleTime: 60_000, retry: false });
  const scoreById = useMemo(() => new Map(((scores.data ?? []) as LeadScoreRow[]).map((r) => [r.leadId, r])), [scores.data]);
  const busy = create.isPending || update.isPending;
  const selectedWithPhone = allLeads.filter((l) => selectedIds.has(l.id) && !!l.phoneE164).length;
  const f = funnel.data;
  // Cidade de um lead sem acesso ao nó (não devia acontecer: a lista já vem filtrada)
  const cityLabel = (pid: number | null) => (pid == null ? null : cityName.get(pid) ?? `#${pid}`);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UserPlus className="h-6 w-6 text-primary" /> Leads de Extras
          </h1>
          <p className="text-sm text-muted-foreground">
            Contactos que ainda não são extras. Convida-os com o template “{template.label}” e acompanha quem responde.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="border-green-600 text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
            disabled={selectedWithPhone === 0}
            onClick={() => openContact(Array.from(selectedIds))}
            title={selectedIds.size === 0 ? "Seleciona leads na tabela para enviar em lote" : undefined}
          >
            <MessageCircle className="h-4 w-4 mr-2" />
            {selectedWithPhone > 0 ? `WhatsApp aos ${selectedWithPhone} selecionados` : "WhatsApp aos selecionados"}
          </Button>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" /> Novo lead
          </Button>
        </div>
      </div>

      {/* ── Funil (últimas 12 semanas) ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            <Filter className="h-4 w-4 text-primary" /> Funil
            <span className="text-xs font-normal text-muted-foreground">
              leads criados nas últimas {f?.weeks ?? 12} semanas
              {f?.medianHoursToFirstContact != null && <> · 1.º contacto em {f.medianHoursToFirstContact}h (mediana)</>}
              {f?.medianDaysToConversion != null && <> · conversão em {f.medianDaysToConversion} dias (mediana)</>}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {funnel.isLoading ? (
            <div className="text-sm text-muted-foreground">A calcular o funil…</div>
          ) : !f || f.totals.created === 0 ? (
            <div className="text-sm text-muted-foreground">Sem leads nas últimas semanas.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {([
                  ["created", "Novos", null],
                  ["contacted", "Contactados", "created"],
                  ["replied", "Responderam", "contacted"],
                  ["converted", "Convertidos", "replied"],
                ] as const).map(([k, label, prev]) => {
                  const v = f.totals[k];
                  const stage = prev ? pct(v, f.totals[prev]) : null;
                  const overall = k !== "created" ? pct(v, f.totals.created) : null;
                  return (
                    <div key={k} className="rounded-md border p-2">
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="text-xl font-semibold tabular-nums">{v}</div>
                      {prev && (
                        <div className="text-[11px] text-muted-foreground tabular-nums">
                          {stage != null ? `${stage}% da etapa anterior` : "—"}
                          {overall != null && ` · ${overall}% do total`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left py-1 px-2 font-medium">Origem</th>
                      <th className="text-right py-1 px-2 font-medium">Novos</th>
                      <th className="text-right py-1 px-2 font-medium">Contactados</th>
                      <th className="text-right py-1 px-2 font-medium">Responderam</th>
                      <th className="text-right py-1 px-2 font-medium">Convertidos</th>
                      <th className="text-right py-1 px-2 font-medium">Conversão</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.bySource.map((r) => (
                      <tr key={r.source} className="border-b last:border-0">
                        <td className="py-1 px-2">
                          <Badge variant="outline" className={`text-[10px] ${SOURCE_BADGE[r.source] ?? ""}`}>{LEAD_SOURCE_LABELS[r.source] ?? r.source}</Badge>
                        </td>
                        <td className="text-right py-1 px-2 tabular-nums">{r.created}</td>
                        <td className="text-right py-1 px-2 tabular-nums">{r.contacted}</td>
                        <td className="text-right py-1 px-2 tabular-nums">{r.replied}</td>
                        <td className="text-right py-1 px-2 tabular-nums">{r.converted}</td>
                        <td className="text-right py-1 px-2 tabular-nums">{pct(r.converted, r.created) ?? "—"}{pct(r.converted, r.created) != null ? "%" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {f.rows.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Por semana e cidade ({f.rows.length} linhas)</summary>
                  <div className="overflow-x-auto max-h-64 overflow-y-auto mt-2">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="text-left py-1 px-2 font-medium">Semana</th>
                          <th className="text-left py-1 px-2 font-medium">Origem</th>
                          <th className="text-left py-1 px-2 font-medium">Cidade</th>
                          <th className="text-right py-1 px-2 font-medium">Novos</th>
                          <th className="text-right py-1 px-2 font-medium">Contact.</th>
                          <th className="text-right py-1 px-2 font-medium">Resp.</th>
                          <th className="text-right py-1 px-2 font-medium">Conv.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {f.rows.map((r) => (
                          <tr key={`${r.week}|${r.source}|${r.city}`} className="border-b last:border-0">
                            <td className="py-1 px-2 whitespace-nowrap">{r.week}</td>
                            <td className="py-1 px-2">{LEAD_SOURCE_LABELS[r.source] ?? r.source}</td>
                            <td className="py-1 px-2">{r.city}</td>
                            <td className="text-right py-1 px-2 tabular-nums">{r.created}</td>
                            <td className="text-right py-1 px-2 tabular-nums">{r.contacted}</td>
                            <td className="text-right py-1 px-2 tabular-nums">{r.replied}</td>
                            <td className="text-right py-1 px-2 tabular-nums">{r.converted}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Atenção (SLA) ───────────────────────────────────────────────────── */}
      {(attentionCounts.new_stale > 0 || attentionCounts.contacted_stale > 0 || attentionFilter) && (
        <div className="flex items-center gap-2 flex-wrap rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-3 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <span className="font-medium text-amber-800 dark:text-amber-300">Atenção</span>
          {(["new_stale", "contacted_stale"] as LeadAttention[]).map((a) => (
            <Button
              key={a}
              size="sm"
              variant={attentionFilter === a ? "default" : "outline"}
              className="h-7 text-xs"
              disabled={attentionCounts[a] === 0 && attentionFilter !== a}
              onClick={() => { setAttentionFilter(attentionFilter === a ? null : a); setStatusFilter("all"); clearSelection(); }}
            >
              {ATTENTION_LABEL[a]} <span className="ml-1 font-semibold">{attentionCounts[a]}</span>
            </Button>
          ))}
          {attentionFilter && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAttentionFilter(null)}>
              <X className="h-3.5 w-3.5 mr-1" /> Limpar
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            Os contactados sem resposta recebem 1 lembrete automático (máx. {LEAD_SLA.maxSends} envios por lead).
          </span>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base">
              {shown.length}{shown.length !== leads.length ? ` de ${leads.length}` : ""} lead{leads.length === 1 ? "" : "s"}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {shownWithPhone.length} com telemóvel
              </span>
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  className="h-9 pl-8 pr-8 w-64"
                  placeholder="Pesquisar nome, número ou email…"
                  aria-label="Pesquisar leads"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setSelectedIds(new Set()); }}
                />
                {trimmedSearch && (
                  <button type="button" aria-label="Limpar pesquisa" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => { setSearch(""); setSelectedIds(new Set()); }}>
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <Select value={sourceFilter} onValueChange={(v) => { setSourceFilter(v); clearSelection(); }}>
                <SelectTrigger className="h-9 w-36 text-xs" aria-label="Filtrar por origem">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as origens</SelectItem>
                  {LEAD_SOURCES.map((src) => (
                    <SelectItem key={src} value={src}>{LEAD_SOURCE_LABELS[src]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1 flex-wrap">
                {(["all", ...STATUS_ORDER] as (LeadStatus | "all")[]).map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={statusFilter === s ? "default" : "outline"}
                    className="h-8 text-xs"
                    onClick={() => { setStatusFilter(s); setSelectedIds(new Set()); }}
                  >
                    {s === "all" ? "Todos" : STATUS[s].label}
                    <span className="ml-1 opacity-70">{counts[s] ?? 0}</span>
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {selectedIds.size > 0 && (
            <div className="mb-3 flex items-center gap-2 flex-wrap rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <span className="font-medium">{selectedIds.size} selecionado{selectedIds.size === 1 ? "" : "s"}</span>
              <Select value="" onValueChange={(v) => bulk.mutate({ leadIds: Array.from(selectedIds), status: v as LeadStatus })} disabled={bulk.isPending}>
                <SelectTrigger className="h-8 w-40 text-xs" aria-label="Mudar estado dos selecionados">
                  <SelectValue placeholder="Mudar estado…" />
                </SelectTrigger>
                <SelectContent>
                  {/* Convertido só pelo botão Converter, lead a lead */}
                  {STATUS_ORDER.filter((s) => s !== "converted").map((s) => (
                    <SelectItem key={s} value={s}>{STATUS[s].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value=""
                onValueChange={(v) => bulk.mutate({ leadIds: Array.from(selectedIds), projectId: v === NO_CITY ? null : Number(v) })}
                disabled={bulk.isPending || cityProjects.length === 0}
              >
                <SelectTrigger className="h-8 w-40 text-xs" aria-label="Mudar cidade dos selecionados">
                  <SelectValue placeholder="Mudar cidade…" />
                </SelectTrigger>
                <SelectContent>
                  {cityProjects.map((p: any) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                  <SelectItem value={NO_CITY}>Sem cidade</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                className="h-8 border-green-600 text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
                disabled={selectedWithPhone === 0}
                onClick={() => openContact(Array.from(selectedIds))}
              >
                <MessageCircle className="h-3.5 w-3.5 mr-1" /> WhatsApp ({selectedWithPhone})
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={clearSelection}>
                <X className="h-3.5 w-3.5 mr-1" /> Limpar seleção
              </Button>
            </div>
          )}
          {list.isLoading && <div className="text-sm text-muted-foreground">A carregar leads…</div>}
          {!list.isLoading && shown.length === 0 && (
            <div className="text-sm text-muted-foreground py-6 text-center">
              {trimmedSearch
                ? `Sem resultados para “${trimmedSearch}”.`
                : attentionFilter
                  ? "Nenhum lead nesta situação."
                  : statusFilter !== "all"
                  ? `Sem leads com estado “${STATUS[statusFilter].label}”.`
                  : "Ainda não há leads. Adiciona o primeiro com “Novo lead”."}
            </div>
          )}
          {shown.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase text-muted-foreground">
                    <th className="py-2 px-2 w-8">
                      <input
                        type="checkbox"
                        title="Selecionar todos os mostrados"
                        aria-label="Selecionar todos os mostrados"
                        checked={shown.length > 0 && shown.every((l) => selectedIds.has(l.id))}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            for (const l of shown) checked ? next.add(l.id) : next.delete(l.id);
                            return next;
                          });
                        }}
                      />
                    </th>
                    <th className="text-left py-2 px-2">Nome</th>
                    <th className="text-left py-2 px-2" title="Disponibilidade, cidade, experiência, anos de carta e rapidez de resposta">Pontuação</th>
                    <th className="text-left py-2 px-2">Telemóvel</th>
                    <th className="text-left py-2 px-2">Email</th>
                    <th className="text-left py-2 px-2">Cidade</th>
                    <th className="text-left py-2 px-2">Estado</th>
                    <th className="text-left py-2 px-2">Último contacto</th>
                    <th className="text-left py-2 px-2">Notas</th>
                    <th className="text-right py-2 px-2">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((l) => {
                    const st = STATUS[l.status] ?? STATUS.new;
                    return (
                      <tr key={l.id} className="border-b hover:bg-muted/40">
                        <td className="py-2 px-2">
                          <input
                            type="checkbox"
                            aria-label={`Selecionar ${l.fullName}`}
                            title={l.phoneE164 ? undefined : "Sem telemóvel — não recebe WhatsApp (estado e cidade em lote funcionam)"}
                            checked={selectedIds.has(l.id)}
                            onChange={(e) =>
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                e.target.checked ? next.add(l.id) : next.delete(l.id);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="py-2 px-2">
                          <div className="font-medium">{l.fullName}</div>
                          <div className="flex items-center gap-1 mt-0.5">
                            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${SOURCE_BADGE[l.source] ?? ""}`}>
                              {LEAD_SOURCE_LABELS[l.source] ?? l.source}
                            </Badge>
                            {attentionById.get(l.id) && (
                              <span title={ATTENTION_LABEL[attentionById.get(l.id)!]}>
                                <AlertTriangle className="h-3 w-3 text-amber-600" />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 px-2">
                          <LeadScoreCell leadId={l.id} row={scoreById.get(l.id)} canEdit={canEditLeads} />
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap">
                          {l.phone ? (
                            <span className="inline-flex items-center gap-1">
                              <Phone className="h-3 w-3 text-muted-foreground" />{l.phone}
                              {!l.phoneE164 && <Badge variant="outline" className="ml-1 text-[10px] border-amber-300 text-amber-700">inválido</Badge>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 px-2 break-all">
                          {l.email ? (
                            <a href={`mailto:${l.email}`} className="inline-flex items-center gap-1 hover:underline">
                              <Mail className="h-3 w-3 text-muted-foreground" />{l.email}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap text-xs">
                          {cityLabel(l.projectId) ? (
                            <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3 text-muted-foreground" />{cityLabel(l.projectId)}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 px-2">
                          {/* Mudar o estado é uma decisão do backoffice; o envio só muda Novo → Contactado
                              e uma mensagem recebida Novo/Contactado → Respondeu. */}
                          <Select
                            value={l.status}
                            disabled={!!l.employeeId}
                            onValueChange={(v) => update.mutate({ id: l.id, status: v as LeadStatus })}
                          >
                            <SelectTrigger className="h-7 w-36 text-xs border-0 bg-transparent px-1 shadow-none focus:ring-0">
                              <Badge variant="outline" className={st.className}>{st.label}</Badge>
                            </SelectTrigger>
                            <SelectContent>
                              {/* Convertido só pelo botão Converter (cria/liga a ficha) */}
                              {STATUS_ORDER.map((s) => (
                                <SelectItem key={s} value={s} disabled={s === "converted" && l.status !== "converted"}>{STATUS[s].label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap text-xs">
                          {l.lastContactedAt ? (
                            <span className="inline-flex items-center gap-1" title={`${l.contactCount} envio(s) de WhatsApp`}>
                              <Clock className="h-3 w-3 text-muted-foreground" />
                              {fmtWhen(l.lastContactedAt)}
                              <span className="text-muted-foreground">· {l.contactCount}×</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">nunca</span>
                          )}
                          {l.lastInboundAt && (
                            <div className="text-violet-700 dark:text-violet-300" title="Última mensagem recebida">
                              ↩ {fmtWhen(l.lastInboundAt)}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-2 max-w-[16rem]">
                          <span className="block truncate text-muted-foreground" title={l.notes ?? undefined}>{l.notes ?? "—"}</span>
                        </td>
                        <td className="py-2 px-2 text-right whitespace-nowrap">
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-green-600 text-green-700 hover:bg-green-50 dark:hover:bg-green-950 mr-1 h-8"
                            disabled={!l.phoneE164 || l.status === "converted" || l.status === "declined"}
                            title={!l.phoneE164 ? "Sem telemóvel válido" : l.status === "converted" ? "Já é extra" : l.status === "declined" ? "Sem interesse" : `Enviar “${template.label}”`}
                            onClick={() => openContact([l.id])}
                          >
                            <MessageCircle className="h-3.5 w-3.5" />
                          </Button>
                          {!l.employeeId && l.status !== "declined" && (
                            <Button size="sm" variant="outline" className="h-8 mr-1" title="Converter em extra (cria a ficha)" onClick={() => openConvert(l)}>
                              <UserPlus className="h-3.5 w-3.5 mr-1" /> Converter
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-8 mr-1" title="Editar" onClick={() => openEdit(l)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8 text-red-600 hover:text-red-700" title="Apagar" onClick={() => setDeleteFor(l)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Criar / editar lead ─────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={(o) => { if (!o && !busy) setEditOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-primary" /> {editing ? "Editar lead" : "Novo lead"}
            </DialogTitle>
            <DialogDescription>
              Nome obrigatório; telemóvel ou email, pelo menos um. Sem telemóvel válido não recebe WhatsApp.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Nome *</Label>
              <Input autoFocus value={draft.fullName} onChange={(e) => setDraft({ ...draft, fullName: e.target.value })} placeholder="Nome completo" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Telemóvel</Label>
                <Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="912 345 678" inputMode="tel" />
              </div>
              <div className="space-y-1">
                <Label>Email</Label>
                <Input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="nome@exemplo.pt" inputMode="email" />
              </div>
            </div>
            {editing && (
              <div className="space-y-1">
                <Label>Cidade</Label>
                <Select value={draft.city || NO_CITY} onValueChange={(v) => setDraft({ ...draft, city: v === NO_CITY ? "" : v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sem cidade" />
                  </SelectTrigger>
                  <SelectContent>
                    {cityProjects.map((p: any) => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                    ))}
                    {/* Sem cidade = visível a todas as cidades (o servidor só deixa a quem vê todas) */}
                    <SelectItem value={NO_CITY}>Sem cidade</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>Notas</Label>
              <Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Ex.: indicado pelo Rui; disponível fins de semana" maxLength={512} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={busy}>Cancelar</Button>
            <Button onClick={submitDraft} disabled={busy}>{busy ? "A guardar…" : editing ? "Guardar" : "Criar lead"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Enviar WhatsApp (seja_motorista) ────────────────────────────────── */}
      <Dialog open={contactOpen} onOpenChange={(o) => { if (!o && !contact.isPending) setContactOpen(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-green-600" /> Enviar “{template.label}”
            </DialogTitle>
            <DialogDescription>
              {contactTargets.length === 1
                ? `Para ${contactTargets[0]?.fullName} (${contactTargets[0]?.phone ?? "sem telemóvel"}).`
                : `Para ${contactWithPhone} lead${contactWithPhone === 1 ? "" : "s"} com telemóvel${contactTargets.length !== contactWithPhone ? ` (${contactTargets.length - contactWithPhone} sem telemóvel ficam de fora)` : ""}.`}
              {" "}Template sem campos a preencher — o texto é o aprovado na Meta.
            </DialogDescription>
          </DialogHeader>

          {!contactResult ? (
            <div className="space-y-1">
              <Label className="text-xs">Pré-visualização</Label>
              {preview.isLoading ? (
                <p className="text-xs text-muted-foreground">A ler o template na Meta…</p>
              ) : preview.data?.ok ? (
                <div className="rounded-md bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 p-3 text-sm whitespace-pre-wrap">
                  {preview.data.bodyText}
                </div>
              ) : (
                <p className="text-xs text-amber-700">
                  Sem pré-visualização: {preview.data && !preview.data.ok ? preview.data.reason : preview.error?.message ?? "template não inspecionado"}. O envio segue com o formato assumido.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-sm">
                <span className="text-emerald-700 font-medium">{contactResult.sent} enviados</span>
                {contactResult.failed > 0 && <> · <span className="text-red-700 font-medium">{contactResult.failed} falhas</span></>}
                {contactResult.noPhone > 0 && <> · <span className="text-amber-700">{contactResult.noPhone} sem telemóvel</span></>}
              </div>
              <ul className="max-h-56 overflow-y-auto text-xs space-y-1">
                {contactResult.results.map((r) => (
                  <li key={r.leadId} className="flex items-start gap-2">
                    <Badge
                      variant="outline"
                      className={
                        r.status === "sent"
                          ? "bg-emerald-100 text-emerald-800"
                          : r.status === "no_phone" || r.status === "invalid_phone" || r.status === "skipped" || r.status === "opted_out" || r.status === "duplicate_phone"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-red-100 text-red-800"
                      }
                    >
                      {r.status === "sent" ? "enviado" : r.status === "no_phone" ? "sem telemóvel" : r.status === "invalid_phone" ? "número inválido" : r.status === "opted_out" ? "não quer mensagens" : r.status === "duplicate_phone" ? "número repetido" : r.status === "skipped" ? `não enviado (${r.error ?? "estado"})` : "falhou"}
                    </Badge>
                    <span className="font-medium">{r.fullName}</span>
                    {r.error && <span className="text-muted-foreground break-words">— {r.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setContactOpen(false)} disabled={contact.isPending}>
              {contactResult ? "Fechar" : "Cancelar"}
            </Button>
            {!contactResult && (
              <Button
                className="bg-green-600 hover:bg-green-700 text-white"
                disabled={contact.isPending || contactWithPhone === 0}
                onClick={() => contact.mutate({ leadIds: contactIds, templateId: template.id })}
              >
                {contact.isPending ? <Clock className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                Enviar a {contactWithPhone}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Converter em extra ──────────────────────────────────────────────── */}
      <Dialog open={convertFor != null} onOpenChange={(o) => { if (!o && !convert.isPending) setConvertFor(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Converter {convertFor?.fullName} em extra</DialogTitle>
            <DialogDescription>
              Cria a ficha de extra{convertFor?.email ? ` com o email ${convertFor.email}` : " com o telemóvel do lead"} e aloca-a à
              cidade escolhida. Se já existir uma ficha com esse email, o lead fica ligado a ela.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Centro de Custos (cidade) *</Label>
            <Select value={convertProjectId} onValueChange={setConvertProjectId} disabled={convert.isPending}>
              <SelectTrigger className={!convertProjectId ? "border-amber-400" : undefined}>
                <SelectValue placeholder={projects.isLoading ? "A carregar cidades…" : "Escolher cidade..."} />
              </SelectTrigger>
              <SelectContent>
                {cityProjects.map((p: any) => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!projects.isLoading && cityProjects.length === 0 && (
              <p className="text-xs text-amber-600">Não tens nenhuma cidade disponível para alocar (verifica o teu centro de custos).</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertFor(null)} disabled={convert.isPending}>Cancelar</Button>
            <Button
              disabled={!convertProjectId || convert.isPending || !convertFor}
              onClick={() => convertFor && convert.mutate({ id: convertFor.id, projectId: Number(convertProjectId) })}
            >
              <UserPlus className="h-4 w-4 mr-2" /> {convert.isPending ? "A converter…" : "Criar ficha de extra"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Apagar ──────────────────────────────────────────────────────────── */}
      <Dialog open={deleteFor != null} onOpenChange={(o) => { if (!o && !remove.isPending) setDeleteFor(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Apagar lead?</DialogTitle>
            <DialogDescription>
              {deleteFor?.fullName} deixa de aparecer nesta lista. As mensagens WhatsApp já trocadas ficam no inbox.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteFor(null)} disabled={remove.isPending}>Cancelar</Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => deleteFor && remove.mutate({ id: deleteFor.id })}>
              <Trash2 className="h-4 w-4 mr-2" /> Apagar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
