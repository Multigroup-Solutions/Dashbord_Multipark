import { trpc } from "@/lib/trpc";
import { CreateMeetingButton } from "@/components/google/CreateMeetingButton";
import FitAmount from "@/components/finance/FitAmount";
import { STICKY_FIRST_COL, TABS_SCROLL } from "@/components/finance/layoutClasses";
import { useTableSort, Th } from "@/components/SortableTable";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Fragment, useState, useMemo } from "react";
import {
  Handshake, Euro, Crown, ArrowRightLeft,
  Plus, Pencil, Trash2, Settings, Link2, AlertTriangle, Wallet,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { PARTNER_TYPES, PARTNER_CATEGORIES, getPartnerType, partnerCategoryOf, parsePartnerConfig, serializePartnerConfig, partnerFormFields } from "@shared/partnerTypes";
import { isPartnerUnconfigured, monthBoundsOf } from "@shared/partnerRules";
import { lisbonToday } from "@shared/expensePeriods";
import { toast } from "sonner";

const fmt = (v: number | null) => v == null ? "Indisponível" : new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);

// ── Partner Form Dialog ──────────────────────────────────────────────────────

function PartnerDialog({ open, onClose, partner, prefill, campaignOptions }: {
  open: boolean;
  onClose: () => void;
  partner?: any;
  /** Novo parceiro já preenchido (ex.: "Configurar" numa campanha da Análise). */
  prefill?: { name: string; campaignKey: string } | null;
  campaignOptions: string[];
}) {
  const utils = trpc.useUtils();
  const onSaved = () => {
    utils.partnerships.list.invalidate();
    utils.partnerships.invoicingSummary.invalidate();
    onClose();
  };
  const onError = (e: { message: string }) => toast.error(e.message || "Erro ao gravar o parceiro");
  const create = trpc.partnerships.create.useMutation({ onSuccess: onSaved, onError });
  const update = trpc.partnerships.update.useMutation({ onSuccess: onSaved, onError });

  const initialCfg = useMemo(() => parsePartnerConfig(partner?.notes), [partner?.notes]);
  const initialPlainNotes = useMemo(() => {
    if (!partner?.notes) return "";
    return partner.notes.trim().startsWith("{") ? "" : partner.notes;
  }, [partner?.notes]);

  const [form, setForm] = useState({
    name: partner?.name ?? prefill?.name ?? "",
    campaignKey: partner?.campaignKey ?? prefill?.campaignKey ?? "",
    partnerType: partner?.partnerType ?? "outro",
    contactName: partner?.contactName ?? "",
    contactEmail: partner?.contactEmail ?? "",
    contactPhone: partner?.contactPhone ?? "",
    commissionRate: partner?.commissionRate ?? 0,
    // Base da comissão: sem IVA por omissão (regra do dono); com IVA só como exceção
    commissionBase: (partner?.commissionBase === "gross" ? "gross" : "net") as "net" | "gross",
    monthlyFee: partner?.monthlyFee ?? 0,
    nif: partner?.partnerNif ?? "",
    billingAgreement: partner?.billingAgreement ?? "",
    notes: initialPlainNotes,
    operatesProjects: (initialCfg.operatesProjects ?? []) as number[],
    cashbackPercent: initialCfg.cashbackPercent ?? 0,
    prizeBudget: initialCfg.prizeBudget ?? 0,
    avencaDate: initialCfg.avencaDate ?? "",
    invoiceDay: initialCfg.invoiceDay ?? 0,
  });

  // Chave escrita à mão (não está na lista de campanhas): input controlado.
  const [manualKey, setManualKey] = useState(() => !!form.campaignKey && !campaignOptions.includes(form.campaignKey));

  // Projetos para multi-select (operacional)
  const { data: allProjects = [] } = trpc.projects.list.useQuery();

  const set = (k: string, v: any) => setForm(prev => ({ ...prev, [k]: v }));

  const isOperational = form.partnerType === "operacional";
  const isOwnCampaign = form.partnerType === "campanha_propria";
  const fields = partnerFormFields(form.partnerType);

  const toggleProject = (id: number) => {
    const has = form.operatesProjects.includes(id);
    set("operatesProjects", has ? form.operatesProjects.filter((x) => x !== id) : [...form.operatesProjects, id]);
  };

  const save = () => {
    const cfg = {
      operatesProjects: isOperational ? form.operatesProjects : undefined,
      cashbackPercent: isOwnCampaign ? Number(form.cashbackPercent) || undefined : undefined,
      prizeBudget: isOwnCampaign ? Number(form.prizeBudget) || undefined : undefined,
      avencaDate: fields.avencaDate ? (form.avencaDate || undefined) : undefined,
      invoiceDay: fields.invoiceTiming ? Number(form.invoiceDay) || undefined : undefined,
    };
    const serializedNotes = serializePartnerConfig(cfg, form.notes ?? "");
    const payload = {
      ...form,
      commissionRate: Number(form.commissionRate),
      monthlyFee: Number(form.monthlyFee),
      notes: serializedNotes,
    };
    // não enviar campos auxiliares
    delete (payload as any).operatesProjects;
    delete (payload as any).cashbackPercent;
    delete (payload as any).prizeBudget;
    delete (payload as any).avencaDate;
    delete (payload as any).invoiceDay;
    if (partner) {
      update.mutate({ id: partner.id, ...payload });
    } else {
      create.mutate(payload as any);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{partner ? "Editar Parceiro" : "Novo Parceiro"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label className="text-xs">Nome</Label>
            <Input value={form.name} onChange={e => set("name", e.target.value)} />
          </div>
          <div className="col-span-2">
            <Label className="text-xs">Campaign Key (da API Multipark)</Label>
            {campaignOptions.length > 0 ? (
              <Select
                value={manualKey ? "_manual" : form.campaignKey}
                onValueChange={v => {
                  if (v === "_manual") { setManualKey(true); set("campaignKey", ""); }
                  else { setManualKey(false); set("campaignKey", v); }
                }}
              >
                <SelectTrigger><SelectValue placeholder="Selecionar campaign..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_manual">Introduzir manualmente</SelectItem>
                  {campaignOptions.map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input value={form.campaignKey} onChange={e => set("campaignKey", e.target.value)} placeholder="ex: booking.com, trivago" />
            )}
            {campaignOptions.length > 0 && manualKey && (
              <Input className="mt-1" value={form.campaignKey} onChange={e => set("campaignKey", e.target.value)} placeholder="Escrever campaign key..." />
            )}
          </div>
          <div>
            <Label className="text-xs">Tipo</Label>
            <Select value={form.partnerType} onValueChange={(v) => set("partnerType", v)}>
              <SelectTrigger><SelectValue placeholder="Selecionar tipo..." /></SelectTrigger>
              <SelectContent>
                {PARTNER_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.partnerType && (
              <p className="text-[10px] text-muted-foreground mt-1">
                {getPartnerType(form.partnerType).description}
              </p>
            )}
          </div>
          <div>
            <Label className="text-xs">NIF</Label>
            <Input value={form.nif} onChange={e => set("nif", e.target.value)} />
          </div>
          {fields.commission && (
            <div>
              <Label className="text-xs">Comissão (%)</Label>
              <Input type="number" value={form.commissionRate} onChange={e => set("commissionRate", e.target.value)} />
            </div>
          )}
          {fields.commission && (
            <div>
              <Label className="text-xs">Base da comissão</Label>
              <select
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
                value={form.commissionBase}
                onChange={e => set("commissionBase", e.target.value)}
                aria-label="Base da comissão"
              >
                <option value="net">Valor sem IVA (regra)</option>
                <option value="gross">Valor com IVA (exceção)</option>
              </select>
            </div>
          )}
          {fields.invoiceTiming && (
            <div>
              <Label className="text-xs">Dia da fatura</Label>
              <Input type="number" min="1" max="31" value={form.invoiceDay} onChange={e => set("invoiceDay", e.target.value)} placeholder="dia do mês (1-31)" />
            </div>
          )}
          {fields.monthlyFee && (
            <div>
              <Label className="text-xs">Valor da avença (€/mês)</Label>
              <Input type="number" value={form.monthlyFee} onChange={e => set("monthlyFee", e.target.value)} />
            </div>
          )}
          {fields.avencaDate && (
            <div>
              <Label className="text-xs">Data da avença</Label>
              <Input type="date" value={form.avencaDate} onChange={e => set("avencaDate", e.target.value)} />
            </div>
          )}
          {fields.discountApplied && (
            <div className="col-span-2 text-[11px] text-muted-foreground bg-muted/40 rounded px-2 py-1.5">
              ℹ️ O desconto deste parceiro já vem aplicado na reserva — não é preciso configurar o valor aqui.
            </div>
          )}
          <div>
            <Label className="text-xs">Contacto</Label>
            <Input value={form.contactName} onChange={e => set("contactName", e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Email</Label>
            <Input value={form.contactEmail} onChange={e => set("contactEmail", e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Telefone</Label>
            <Input value={form.contactPhone} onChange={e => set("contactPhone", e.target.value)} />
          </div>
          <div className="col-span-2">
            <Label className="text-xs">Acordo de Faturação</Label>
            <Input value={form.billingAgreement} onChange={e => set("billingAgreement", e.target.value)} placeholder="Descrição do acordo..." />
          </div>
          <div className="col-span-2">
            <Label className="text-xs">Notas</Label>
            <Input value={form.notes} onChange={e => set("notes", e.target.value)} />
          </div>

          {/* Operacional: lista de projetos operados */}
          {isOperational && (
            <div className="col-span-2 border rounded p-3 bg-amber-50/40 dark:bg-amber-950/20">
              <Label className="text-xs font-medium block mb-1">Projetos operados</Label>
              <p className="text-[10px] text-muted-foreground mb-2">
                Selecciona os projetos onde este parceiro opera. A comissão será aplicada sobre
                TODAS as reservas destes projetos (incl. sub-projetos), independentemente do campaign.
                Permite dupla comissão (venda + operacional) na mesma reserva.
              </p>
              <div className="max-h-40 overflow-y-auto border rounded bg-white dark:bg-gray-900">
                {(allProjects as any[]).map((p: any) => (
                  <label key={p.id} className="flex items-center gap-2 px-2 py-1 hover:bg-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.operatesProjects.includes(p.id)}
                      onChange={() => toggleProject(p.id)}
                    />
                    <span className="text-xs">
                      <Badge variant="outline" className="text-[9px] mr-1 capitalize">{p.level}</Badge>
                      {p.name}
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {form.operatesProjects.length} {form.operatesProjects.length === 1 ? "projeto seleccionado" : "projetos seleccionados"}
              </p>
            </div>
          )}

          {/* Campanha própria: cashback + prémios */}
          {isOwnCampaign && (
            <>
              <div>
                <Label className="text-xs">Cashback (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.cashbackPercent}
                  onChange={e => set("cashbackPercent", e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">Prémios (€)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.prizeBudget}
                  onChange={e => set("prizeBudget", e.target.value)}
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} disabled={!form.name || create.isPending || update.isPending}>
            {partner ? "Guardar" : "Criar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function PartnershipsPage() {
  const filters = useGlobalFilters();
  // Dias de calendário de Lisboa (o toISOString de uma data local recuava um
  // dia no verão: 1 de setembro 00:00 PT = 31 de agosto 23:00 UTC).
  const today = lisbonToday();
  const { monthStart, monthEnd } = monthBoundsOf(today);

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [billingFrom, setBillingFrom] = useState(monthStart);
  const [billingTo, setBillingTo] = useState(monthEnd);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editPartner, setEditPartner] = useState<any>(null);
  const [prefill, setPrefill] = useState<{ name: string; campaignKey: string } | null>(null);
  const openEdit = (p: any) => { setPrefill(null); setEditPartner(p); setDialogOpen(true); };
  const openNew = (pre: { name: string; campaignKey: string } | null = null) => { setEditPartner(null); setPrefill(pre); setDialogOpen(true); };
  const [mgmtType, setMgmtType] = useState<string>("all"); // segmentação da tab Gestão por tipo

  const projectId = useMemo(() => {
    if (filters.brandId !== null) return filters.brandId;
    if (filters.cityId !== null) return filters.cityId;
    return undefined;
  }, [filters.cityId, filters.brandId]);

  // Queries
  const { data: analyticsData, isLoading: analyticsLoading } = trpc.partnerships.analytics.useQuery({ from, to, projectId });
  const { data: partnerList = [] } = trpc.partnerships.list.useQuery({ projectId });
  const utils = trpc.useUtils();
  const deleteMut = trpc.partnerships.delete.useMutation({ onSuccess: () => utils.partnerships.list.invalidate() });
  const syncApiMut = trpc.partnerships.syncFromApi.useMutation({
    onSuccess: (r) => {
      toast.success(
        `Parceiros sincronizados: ${r.created} criados, ${r.linkedToExisting} ligados a existentes, ` +
        `${r.proCreated} empresas Pro criadas, ${r.legacyTypesFixed} tipos corrigidos` +
        (r.unresolved.length ? ` — ${r.unresolved.length} por resolver` : ""),
      );
      utils.partnerships.list.invalidate();
      utils.partnerships.analytics.invalidate();
      utils.partnerships.invoicingSummary.invalidate();
    },
    onError: (e) => toast.error(e.message || "Erro na sincronização de parceiros"),
  });

  const partners = analyticsData?.partners ?? [];
  const proBookings = analyticsData?.proBookings ?? [];
  const totals = analyticsData?.totals ?? { partnerBookings: 0, partnerRevenue: 0, directBookings: 0, directRevenue: 0, proBookings: 0, proRevenue: 0 };

  const totalBookings = totals.partnerBookings + totals.directBookings;
  const totalRevenue = totals.partnerRevenue + totals.directRevenue;
  const partnerPct = totalBookings > 0 ? ((totals.partnerBookings / totalBookings) * 100).toFixed(1) : "0";

  // campanha (minúsculas) → parceiro: pelo nome (o resolver de aliases grava
  // o nome do parceiro em `campaign`) e pela campaign key.
  const partnerByCampaign = useMemo(() => {
    const m = new Map<string, any>();
    for (const p of partnerList as any[]) {
      for (const k of [p.name, p.campaignKey]) {
        const key = (k ?? "").trim().toLowerCase();
        if (key && !m.has(key)) m.set(key, p);
      }
    }
    return m;
  }, [partnerList]);
  const partnerForCampaign = (c: string) => partnerByCampaign.get(c.trim().toLowerCase());

  // Opções de campaign para o formulário: campanhas ainda sem parceiro
  const campaignOptions = useMemo(() => {
    const campaigns = new Set(partners.map(p => p.campaign).filter(Boolean) as string[]);
    return Array.from(campaigns).filter(c => !partnerByCampaign.has(c.trim().toLowerCase()));
  }, [partners, partnerByCampaign]);

  // Fila "Por configurar": parceiros que nenhum admin gravou (ex.: criados
  // pela sincronização automática com 0% e sem avença).
  const unconfigured = useMemo(() => (partnerList as any[]).filter(isPartnerUnconfigured), [partnerList]);

  // Group partners by campaign name
  const partnerSummary = useMemo(() => {
    const map = new Map<string, { count: number; revenue: number; discount: number; cities: Set<string>; parks: Set<string> }>();
    for (const p of partners) {
      const key = p.campaign ?? "Desconhecido";
      if (!map.has(key)) map.set(key, { count: 0, revenue: 0, discount: 0, cities: new Set(), parks: new Set() });
      const entry = map.get(key)!;
      entry.count += p.count;
      entry.revenue += p.totalRevenue;
      entry.discount += p.totalDiscount;
      if (p.city) entry.cities.add(p.city);
      if (p.parkName) entry.parks.add(p.parkName);
    }
    return Array.from(map.entries())
      .map(([name, d]) => ({
        name,
        count: d.count,
        revenue: d.revenue,
        avgPrice: d.count > 0 ? d.revenue / d.count : 0,
        discount: d.discount,
        cities: Array.from(d.cities),
        parks: Array.from(d.parks),
        partner: partnerByCampaign.get(name.trim().toLowerCase()) ?? null,
      }))
      .map(r => ({ ...r, configured: !!r.partner && !isPartnerUnconfigured(r.partner) }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [partners, partnerByCampaign]);
  const psSort = useTableSort(partnerSummary);

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">Parceiros, afiliados e reservas Pro da Multipark</p>

      <Tabs defaultValue="summary">
        <TabsList className={TABS_SCROLL}>
          <TabsTrigger value="summary"><Wallet className="w-3 h-3 mr-1" /> Resumo</TabsTrigger>
          <TabsTrigger value="analytics">Análise</TabsTrigger>
          <TabsTrigger value="management">
            <Settings className="w-3 h-3 mr-1" /> Gestão
            {unconfigured.length > 0 && <Badge variant="destructive" className="ml-1 h-4 px-1 text-[11px]">{unconfigured.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* ── TAB: RESUMO DE FATURAÇÃO POR PARCEIRO ─────────────────────────── */}
        <TabsContent value="summary" className="space-y-4">
          <InvoicingSummaryTab from={billingFrom} to={billingTo} onChangeFrom={setBillingFrom} onChangeTo={setBillingTo} />
        </TabsContent>

        {/* ── TAB: ANÁLISE ─────────────────────────────────────────────────── */}
        <TabsContent value="analytics" className="space-y-4">
          <div className="flex items-end gap-3 sm:justify-end">
            <div className="flex-1 sm:flex-none">
              <Label className="text-xs mb-1 block">De</Label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-full sm:w-[160px]" />
            </div>
            <div className="flex-1 sm:flex-none">
              <Label className="text-xs mb-1 block">Até</Label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-full sm:w-[160px]" />
            </div>
          </div>

          {analyticsLoading ? (
            <div className="flex justify-center py-20">
              <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
            </div>
          ) : (
            <>
              {/* KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-3 [&>*]:min-w-0 [&>*]:gap-1">
                <Card className="p-3">
                  <div className="flex items-center gap-1 mb-1">
                    <Handshake className="w-4 h-4 text-blue-600" />
                    <span className="text-xs text-muted-foreground">Reservas Parceiros</span>
                  </div>
                  <p className="text-lg sm:text-xl font-bold tabular-nums text-blue-700 dark:text-blue-400">{totals.partnerBookings.toLocaleString("pt-PT")}</p>
                  <p className="text-xs text-muted-foreground">{partnerPct}% do total</p>
                </Card>
                <Card className="p-3">
                  <div className="flex items-center gap-1 mb-1">
                    <Euro className="w-4 h-4 text-blue-600" />
                    <span className="text-xs text-muted-foreground">Receita Parceiros</span>
                  </div>
                  <FitAmount value={totals.partnerRevenue} className="text-lg sm:text-xl font-bold text-blue-700 dark:text-blue-400" />
                </Card>
                <Card className="p-3">
                  <div className="flex items-center gap-1 mb-1">
                    <ArrowRightLeft className="w-4 h-4 text-green-600" />
                    <span className="text-xs text-muted-foreground">Reservas Diretas</span>
                  </div>
                  <p className="text-lg sm:text-xl font-bold tabular-nums text-green-700 dark:text-green-400">{totals.directBookings.toLocaleString("pt-PT")}</p>
                </Card>
                <Card className="p-3">
                  <div className="flex items-center gap-1 mb-1">
                    <Euro className="w-4 h-4 text-green-600" />
                    <span className="text-xs text-muted-foreground">Receita Direta</span>
                  </div>
                  <FitAmount value={totals.directRevenue} className="text-lg sm:text-xl font-bold text-green-700 dark:text-green-400" />
                </Card>
                <Card className="p-3">
                  <div className="flex items-center gap-1 mb-1">
                    <Crown className="w-4 h-4 text-purple-600" />
                    <span className="text-xs text-muted-foreground">Reservas Pro</span>
                  </div>
                  <p className="text-lg sm:text-xl font-bold tabular-nums text-purple-700 dark:text-purple-400">{totals.proBookings.toLocaleString("pt-PT")}</p>
                </Card>
                <Card className="p-3">
                  <div className="flex items-center gap-1 mb-1">
                    <Euro className="w-4 h-4 text-purple-600" />
                    <span className="text-xs text-muted-foreground">Receita Pro</span>
                  </div>
                  <FitAmount value={totals.proRevenue} className="text-lg sm:text-xl font-bold text-purple-700 dark:text-purple-400" />
                </Card>
              </div>

              {/* Partner Summary Table */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Handshake className="w-4 h-4" /> Parceiros / Afiliados
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {partnerSummary.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-6">Sem reservas de parceiros no período</p>
                  ) : (
                    <div className="overflow-x-auto"><table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
                      <thead>
                        <tr className="border-b text-left">
                          <Th k="name" label="Parceiro" sortKey={psSort.sortKey} sortDir={psSort.sortDir} onToggle={psSort.toggle} />
                          <Th k="cities" label="Cidades" sortKey={psSort.sortKey} sortDir={psSort.sortDir} onToggle={psSort.toggle} />
                          <Th k="count" label="Reservas" align="right" sortKey={psSort.sortKey} sortDir={psSort.sortDir} onToggle={psSort.toggle} />
                          <Th k="revenue" label="Receita" align="right" sortKey={psSort.sortKey} sortDir={psSort.sortDir} onToggle={psSort.toggle} />
                          <Th k="avgPrice" label="Preço Médio" align="right" sortKey={psSort.sortKey} sortDir={psSort.sortDir} onToggle={psSort.toggle} />
                          <Th k="discount" label="Descontos" align="right" sortKey={psSort.sortKey} sortDir={psSort.sortDir} onToggle={psSort.toggle} />
                          <Th k="revenueShare" label="% Receita" align="right" sortKey={psSort.sortKey} sortDir={psSort.sortDir} onToggle={psSort.toggle} />
                          <th className="p-2 text-center">Config</th>
                        </tr>
                      </thead>
                      <tbody>
                        {psSort.sorted.map(p => (
                          <tr key={p.name} className="border-b hover:bg-muted/50">
                            <td className="p-2 font-medium min-w-[10rem] max-w-[16rem] break-words">
                              {p.name}
                              {p.configured
                                ? <Badge variant="secondary" className="ml-2 text-[11px]">Configurado</Badge>
                                : p.partner && <Badge variant="outline" className="ml-2 text-[11px] border-amber-400 text-amber-700 dark:text-amber-400">Por configurar</Badge>}
                            </td>
                            <td className="p-2">
                              <div className="flex gap-1 flex-wrap">
                                {p.cities.map(c => (
                                  <Badge key={c} variant="outline" className="text-[11px]">{c}</Badge>
                                ))}
                              </div>
                            </td>
                            <td className="p-2 text-right tabular-nums">{p.count}</td>
                            <td className="p-2 text-right tabular-nums font-medium">{fmt(p.revenue)}</td>
                            <td className="p-2 text-right tabular-nums">{fmt(p.avgPrice)}</td>
                            <td className="p-2 text-right tabular-nums text-red-700 dark:text-red-400">{fmt(p.discount)}</td>
                            <td className="p-2 text-right tabular-nums">
                              {totalRevenue > 0 ? ((p.revenue / totalRevenue) * 100).toFixed(1) : "0"}%
                            </td>
                            <td className="p-2 text-center">
                              {!p.configured && (
                                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => {
                                  if (p.partner) openEdit(p.partner);
                                  else openNew({ name: p.name, campaignKey: p.name });
                                }}>
                                  <Plus className="w-3 h-3 mr-1" /> Configurar
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                        <tr className="bg-muted/30 font-bold">
                          <td className="p-2">Total Parceiros</td>
                          <td className="p-2"></td>
                          <td className="p-2 text-right tabular-nums">{totals.partnerBookings}</td>
                          <td className="p-2 text-right tabular-nums">{fmt(totals.partnerRevenue)}</td>
                          <td className="p-2 text-right">{totals.partnerBookings > 0 ? fmt(totals.partnerRevenue / totals.partnerBookings) : "—"}</td>
                          <td className="p-2 text-right tabular-nums text-red-700 dark:text-red-400">{fmt(partnerSummary.reduce((s, p) => s + p.discount, 0))}</td>
                          <td className="p-2 text-right">{totalRevenue > 0 ? ((totals.partnerRevenue / totalRevenue) * 100).toFixed(1) : "0"}%</td>
                          <td className="p-2"></td>
                        </tr>
                      </tbody>
                    </table></div>
                  )}
                </CardContent>
              </Card>

              {/* Pro Bookings */}
              {proBookings.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Crown className="w-4 h-4 text-purple-600" /> Reservas Pro
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto"><table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
                      <thead>
                        <tr className="border-b text-left">
                          <th className="p-2">Parque</th>
                          <th className="p-2">Cidade</th>
                          <th className="p-2 text-right">Reservas</th>
                          <th className="p-2 text-right">Receita</th>
                        </tr>
                      </thead>
                      <tbody>
                        {proBookings.map((p: any, i: number) => (
                          <tr key={i} className="border-b hover:bg-muted/50">
                            <td className="p-2 font-medium">{p.parkName}</td>
                            <td className="p-2 text-muted-foreground">{p.city}</td>
                            <td className="p-2 text-right tabular-nums">{p.count}</td>
                            <td className="p-2 text-right tabular-nums font-medium">{fmt(p.totalRevenue)}</td>
                          </tr>
                        ))}
                        <tr className="bg-muted/30 font-bold">
                          <td className="p-2">Total Pro</td>
                          <td className="p-2"></td>
                          <td className="p-2 text-right">{totals.proBookings}</td>
                          <td className="p-2 text-right">{fmt(totals.proRevenue)}</td>
                        </tr>
                      </tbody>
                    </table></div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        {/* ── TAB: GESTÃO ──────────────────────────────────────────────────── */}
        <TabsContent value="management" className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm text-muted-foreground">Configurar parceiros: campaign key, comissão, NIF e dados de contacto</p>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm" variant="outline"
                disabled={syncApiMut.isPending}
                title="Resolve os parceiros mascarados da API (nome real via detalhe), cria as empresas Pro das campanhas 'Pro X' e normaliza tipos antigos"
                onClick={() => syncApiMut.mutate()}
              >
                <Link2 className={`w-4 h-4 mr-1 ${syncApiMut.isPending ? "animate-pulse" : ""}`} />
                {syncApiMut.isPending ? "A sincronizar…" : "Sincronizar parceiros da API"}
              </Button>
              <Link href="/parcerias/inferir">
                <Button size="sm" variant="ghost" title="Associar partnerIds e métodos de pagamento das reservas a parceiros">
                  Associar métodos de pagamento
                </Button>
              </Link>
              <Button size="sm" onClick={() => openNew()}>
                <Plus className="w-4 h-4 mr-1" /> Novo Parceiro
              </Button>
            </div>
          </div>

          {/* Fila "Por configurar" — parceiros novos (sincronização automática) sem taxa/avença confirmada */}
          {unconfigured.length > 0 && (
            <Card className="p-4 border-amber-300 bg-amber-50/60 dark:bg-amber-950/20">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <h3 className="font-semibold text-sm">Por configurar ({unconfigured.length})</h3>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Parceiros criados automaticamente (ou sem dados gravados). Até serem configurados, a comissão conta como
                "taxa em falta" nas finanças. Confirma o tipo, a comissão (mesmo que seja 0%) ou a avença.
              </p>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {unconfigured.map((p: any) => (
                  <div key={p.id} className="flex items-center gap-2 rounded border bg-background px-2 py-1.5 text-sm min-w-0">
                    <div className="min-w-0 flex-1">
                      <span className="font-medium block break-words leading-snug">{p.name}</span>
                      <Badge variant="outline" className="text-[11px] mt-0.5">{getPartnerType(p.partnerType).label}</Badge>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs shrink-0" onClick={() => openEdit(p)}>
                      Configurar
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Segmentação por CATEGORIA (Prós | Agências | Empresas | Agregadores | Operacional) */}
          {partnerList.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {[{ id: "all", label: "Todos" }, ...PARTNER_CATEGORIES.map(c => ({ id: c.id, label: c.label }))].map(t => {
                const count = t.id === "all"
                  ? partnerList.length
                  : (partnerList as any[]).filter((p: any) => partnerCategoryOf(p.partnerType) === t.id).length;
                if (t.id !== "all" && count === 0) return null;
                return (
                  <button
                    key={t.id}
                    onClick={() => setMgmtType(t.id)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${mgmtType === t.id ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted border-input"}`}
                  >
                    {t.label} <span className="opacity-80 tabular-nums">{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {partnerList.length === 0 ? (
            <Card className="p-8 text-center text-muted-foreground">
              Nenhum parceiro configurado. Usa "Sincronizar parceiros da API" ou cria um novo.
            </Card>
          ) : (
            <div className="grid gap-3">
              {(partnerList as any[]).filter((p: any) => mgmtType === "all" || partnerCategoryOf(p.partnerType) === mgmtType).map((p: any) => (
                <Card key={p.id} className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="font-semibold break-words min-w-0">{p.name}</h3>
                        <Badge variant={p.partnerStatus === "active" ? "default" : "secondary"} className="text-[11px]">
                          {p.partnerStatus === "active" ? "Ativo" : p.partnerStatus === "inactive" ? "Inativo" : "Pendente"}
                        </Badge>
                        <Badge variant="outline" className="text-[11px]">
                          {getPartnerType(p.partnerType).label}
                        </Badge>
                        {isPartnerUnconfigured(p) && (
                          <Badge variant="outline" className="text-[11px] border-amber-400 text-amber-700 dark:text-amber-400">Por configurar</Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-1 text-sm text-muted-foreground mt-2 [&>div]:min-w-0 [&>div]:break-words">
                        {p.campaignKey && (
                          <div><span className="text-xs font-medium text-foreground">Campaign:</span> {p.campaignKey}</div>
                        )}
                        <div><span className="text-xs font-medium text-foreground">Comissão:</span> {p.commissionRate ?? 0}% {p.commissionBase === "gross" ? "(c/ IVA)" : "(s/ IVA)"}</div>
                        {p.monthlyFee > 0 && (
                          <div><span className="text-xs font-medium text-foreground">Avença mensal:</span> {fmt(p.monthlyFee)}</div>
                        )}
                        {p.partnerNif && (
                          <div><span className="text-xs font-medium text-foreground">NIF:</span> {p.partnerNif}</div>
                        )}
                        {p.contactName && (
                          <div><span className="text-xs font-medium text-foreground">Contacto:</span> {p.contactName}</div>
                        )}
                        {p.contactEmail && (
                          <div><span className="text-xs font-medium text-foreground">Email:</span> {p.contactEmail}</div>
                        )}
                        {p.contactPhone && (
                          <div><span className="text-xs font-medium text-foreground">Tel:</span> {p.contactPhone}</div>
                        )}
                        {p.billingAgreement && (
                          <div className="sm:col-span-2"><span className="text-xs font-medium text-foreground">Acordo:</span> {p.billingAgreement}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                      <CreateMeetingButton entityType="partnership" entityId={p.id} defaultTitle={`Reunião — ${p.name}`} />
                      <Button size="sm" variant="ghost" onClick={() => openEdit(p)} aria-label={`Editar ${p.name}`}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-red-600" aria-label={`Eliminar ${p.name}`} onClick={() => {
                        if (confirm(`Eliminar parceiro "${p.name}"?`)) deleteMut.mutate({ id: p.id });
                      }}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

      </Tabs>

      {/* Dialog */}
      {dialogOpen && (
        <PartnerDialog
          open={dialogOpen}
          onClose={() => { setDialogOpen(false); setEditPartner(null); setPrefill(null); }}
          partner={editPartner}
          prefill={prefill}
          campaignOptions={campaignOptions as string[]}
        />
      )}
    </div>
  );
}

// ── INVOICING SUMMARY TAB ────────────────────────────────────────────────────

function InvoicingSummaryTab({
  from, to, onChangeFrom, onChangeTo,
}: {
  from: string; to: string; onChangeFrom: (v: string) => void; onChangeTo: (v: string) => void;
}) {
  const [, setLocation] = useLocation();
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const { projectId } = useGlobalFilters();

  const { data: rows = [], isLoading } = trpc.partnerships.invoicingSummary.useQuery({
    from, to, projectId,
    partnerType: typeFilter !== "all" ? typeFilter : undefined,
  });

  const { data: cityAccess } = trpc.permissions.myCityAccess.useQuery();
  const billingAvailable = !!cityAccess?.all && projectId == null;
  const amountsAvailable = rows.every(row => row.aFaturar != null);

  const totals = useMemo(() => {
    return rows.reduce((acc, r) => {
      acc.aFaturar += r.aFaturar ?? 0;
      acc.bookings += r.bookingsCount;
      acc.revenue += r.revenueGross;
      return acc;
    }, { aFaturar: 0, bookings: 0, revenue: 0 });
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-[9.5rem] sm:flex-none">
          <Label className="text-xs mb-1 block">De</Label>
          <Input type="date" value={from} onChange={e => onChangeFrom(e.target.value)} className="w-full sm:w-[160px] h-9" />
        </div>
        <div className="flex-1 min-w-[9.5rem] sm:flex-none">
          <Label className="text-xs mb-1 block">Até</Label>
          <Input type="date" value={to} onChange={e => onChangeTo(e.target.value)} className="w-full sm:w-[160px] h-9" />
        </div>
        <div className="w-full sm:w-auto">
          <Label className="text-xs mb-1 block">Tipo</Label>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-full sm:w-[200px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os tipos</SelectItem>
              {PARTNER_TYPES.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!billingAvailable && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">Reservas e receitas limitadas à cidade selecionada. As avenças não têm cidade atribuída e estão indisponíveis nesta vista.</p>}
      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 [&>*]:min-w-0 [&>*]:gap-1">
        <Card className="p-4">
          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Euro className="w-3 h-3" /> A faturar
          </p>
          {amountsAvailable ? <FitAmount value={totals.aFaturar} className="text-xl lg:text-2xl font-bold text-blue-700 dark:text-blue-400" /> : <p className="text-xl lg:text-2xl font-bold text-blue-700 dark:text-blue-400">{fmt(null)}</p>}
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Handshake className="w-3 h-3" /> Reservas concluídas
          </p>
          <p className="text-xl lg:text-2xl font-bold tabular-nums">{totals.bookings.toLocaleString("pt-PT")}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Wallet className="w-3 h-3" /> Receita
          </p>
          <FitAmount value={totals.revenue} className="text-xl lg:text-2xl font-bold text-emerald-700 dark:text-emerald-400" />
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resumo por parceiro</CardTitle>
          <p className="text-xs text-muted-foreground">
            <strong>A faturar</strong> = comissão das reservas concluídas (check-out no período) ou avença
            mensal/anual rateada pelos meses do período.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground text-center py-10">A carregar...</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">Sem parceiros para mostrar.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={`w-full text-sm ${STICKY_FIRST_COL}`}>
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="p-2">Parceiro</th>
                    <th className="p-2">Tipo</th>
                    <th className="p-2 text-right">Reservas</th>
                    <th className="p-2 text-right">Receita (c/ IVA)</th>
                    <th className="p-2 text-right" title="Comissão sobre o valor sem IVA (ou com IVA se o parceiro tiver essa exceção)">A faturar</th>
                  </tr>
                </thead>
                <tbody>
                  {PARTNER_CATEGORIES.map((cat) => {
                    const catRows = rows.filter((r) => partnerCategoryOf(r.partnerType) === cat.id);
                    if (catRows.length === 0) return null;
                    const sub = catRows.reduce((a, r) => ({
                      n: a.n + r.bookingsCount, rev: a.rev + r.revenueGross, af: a.af + (r.aFaturar ?? 0),
                    }), { n: 0, rev: 0, af: 0 });
                    return (
                      <Fragment key={cat.id}>
                        <tr className="bg-muted/70 border-b">
                          <td colSpan={2} className="p-2 font-semibold text-xs uppercase">{cat.label} · {catRows.length}</td>
                          <td className="p-2 text-right tabular-nums text-xs font-medium">{sub.n}</td>
                          <td className="p-2 text-right tabular-nums text-xs font-medium">{fmt(sub.rev)}</td>
                          <td className="p-2 text-right tabular-nums text-xs font-medium text-blue-700">{fmt(catRows.every(r => r.aFaturar != null) ? sub.af : null)}</td>
                        </tr>
                        {catRows.map((r: any) => {
                    const t = getPartnerType(r.partnerType);
                    return (
                      <tr
                        key={r.partnershipId}
                        className="border-b hover:bg-muted/50 cursor-pointer"
                        onClick={() => setLocation(`/parcerias/tipo/${t.id}`)}
                        title={`Abrir ${t.label}`}
                      >
                        <td className="p-2 font-medium min-w-[10rem] max-w-[18rem] break-words">{r.partnerName}</td>
                        <td className="p-2">
                          <Badge variant="outline" className="text-[11px] whitespace-nowrap">{t.label}</Badge>
                        </td>
                        <td className="p-2 text-right tabular-nums">{r.bookingsCount}</td>
                        <td className="p-2 text-right tabular-nums">{fmt(r.revenueGross)}</td>
                        <td className="p-2 text-right tabular-nums font-medium text-blue-700">{fmt(r.aFaturar)}</td>
                      </tr>
                    );
                  })}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/50 font-bold border-t-2">
                    <td className="p-2" colSpan={4}>TOTAL</td>
                    <td className="p-2 text-right tabular-nums text-blue-700">{fmt(amountsAvailable ? totals.aFaturar : null)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
