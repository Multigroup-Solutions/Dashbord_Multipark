import { trpc } from "@/lib/trpc";
import { formatBookingHistoryDetails } from "@/lib/bookingHistoryFormat";
import { openInMultipark } from "@/lib/multiparkLinks";
import { fileHref } from "@/lib/fileHref";
import CaseMessageList from "@/components/CaseMessageList";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { filterBookingHistory } from "@/lib/bookingHistory";
import { REPLY_TEMPLATES } from "@/lib/replyTemplates";
import { useAuth } from "@/_core/hooks/useAuth";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import BookingSearchField from "@/components/BookingSearchField";
import ClientHistoryCard from "@/components/ClientHistoryCard";
import CaseAssignmentCard from "@/components/CaseAssignmentCard";
import LinkInboundEmailButton from "@/components/LinkInboundEmailButton";
import {
  Search, Plus, Clock, User, Car,
  ChevronRight, ChevronLeft, Send, Eye, Trash2, Upload, Pencil,
  BarChart3, AlertCircle, CheckCircle2, Hourglass, XCircle,
  Package, DollarSign, Smartphone, Shirt, FileText, Glasses,
  HelpCircle, TrendingUp, ShieldAlert, Flag, Mail, Download, Truck, GripVertical, MessageSquareWarning, RefreshCw, ExternalLink } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { STATUS_CONFIG, TYPE_CONFIG, PRIORITY_CONFIG, KANBAN_COLUMNS, BASE_PATH, CHANGE_TYPE_CONFIG } from "./config";

// ─── CREATE DIALOG ────────────────────────────────────────────────────────────

// ─── RESERVATION PREVIEW (auto-fetches timeline from API) ────────────────────

export function LostFoundReservationPreview({ bookingId }: { bookingId: string }) {
  const { data, isLoading } = trpc.lostFound.bookingTimeline.useQuery(
    { bookingId },
    { enabled: bookingId.length >= 4 }
  );

  if (!bookingId || bookingId.length < 4) return null;
  if (isLoading) return <p className="text-xs text-muted-foreground mt-2 animate-pulse">A carregar histórico da API...</p>;

  const history = data?.history || [];
  if (history.length === 0) return <p className="text-xs text-amber-600 mt-2">Nenhum histórico encontrado para este ID.</p>;

  return (
    <div className="mt-2 max-h-40 overflow-y-auto space-y-1 border rounded p-2 bg-white dark:bg-gray-900">
      <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{history.length} eventos encontrados</p>
      {history.slice(0, 10).map((h: any) => {
        const cfg = CHANGE_TYPE_CONFIG[h.changeType] || { label: h.changeType, color: "bg-gray-100 text-gray-800" };
        return (
          <div key={h.id} className="flex items-center justify-between text-xs p-1.5 rounded bg-muted">
            <div className="flex items-center gap-1.5">
              <Badge className={`${cfg.color} text-[11px] px-1`}>{cfg.label}</Badge>
              <span>{h.user?.firstName || h.agentName || "Sistema"} {h.user?.lastName || ""}</span>
            </div>
            <span className="text-muted-foreground">{h.actionTime ? fmtPTDateTime(h.actionTime) : "—"}</span>
          </div>
        );
      })}
      {history.length > 10 && <p className="text-xs text-muted-foreground">... e mais {history.length - 10} eventos</p>}
    </div>
  );
}

export function CreateDialog({ user, onClose }: { user: any; onClose: () => void }) {
  const [form, setForm] = useState({
    clientName: "",
    clientEmail: "",
    clientPhone: "",
    bookingRef: "",
    vehiclePlate: "",
    itemType: "other" as const,
    description: "",
    estimatedValue: "",
    priority: "medium" as const,
  });
  const createMut = trpc.lostFound.create.useMutation();
  const utils = trpc.useUtils();

  const handleSubmit = async () => {
    if (!form.clientName.trim() || !form.description.trim()) {
      toast.error("Nome do cliente e descrição são obrigatórios");
      return;
    }
    if (!form.bookingRef.trim()) {
      toast.error("ID da reserva é obrigatório");
      return;
    }
    try {
      await createMut.mutateAsync({
        clientName: form.clientName,
        clientEmail: form.clientEmail || undefined,
        clientPhone: form.clientPhone || undefined,
        bookingRef: form.bookingRef || undefined,
        vehiclePlate: form.vehiclePlate || undefined,
        itemType: form.itemType,
        description: form.description,
        estimatedValue: form.estimatedValue ? parseInt(form.estimatedValue) : undefined,
        priority: form.priority,
      });
      utils.lostFound.list.invalidate();
      toast.success("Registo criado com sucesso");
      onClose();
    } catch (e: any) {
      toast.error(e.message || "Erro ao criar registo");
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5 text-amber-500" /> Novo Perdido/Achado
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pr-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <Label>Nome do Cliente *</Label>
              <Input value={form.clientName} onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))} placeholder="Nome completo" />
            </div>
            <div>
              <Label>Email</Label>
              <Input value={form.clientEmail} onChange={e => setForm(f => ({ ...f, clientEmail: e.target.value }))} placeholder="email@exemplo.com" />
            </div>
            <div>
              <Label>Telefone</Label>
              <Input value={form.clientPhone} onChange={e => setForm(f => ({ ...f, clientPhone: e.target.value }))} placeholder="+351 ..." />
            </div>
            <div className="sm:col-span-2">
              <BookingSearchField
                accent="emerald"
                label="Buscar reserva (nº reserva, matrícula, email, nome) *"
                hint="Escolhe uma reserva e os dados do cliente / matrícula são preenchidos automaticamente"
                onSelect={(b, details) => {
                  const ref = b.externalId || b.bookingNumber || "";
                  const client = details?.customer || details?.client;
                  setForm(f => ({
                    ...f,
                    bookingRef: ref,
                    clientName: f.clientName || [client?.firstName, client?.lastName, b.clientFirstName, b.clientLastName].filter(Boolean).slice(0, 2).join(" "),
                    clientEmail: f.clientEmail || client?.email || b.clientEmail || "",
                    clientPhone: f.clientPhone || client?.phoneNumber || b.clientPhone || "",
                    vehiclePlate: f.vehiclePlate || details?.vehicle?.licensePlate || b.licensePlate || "",
                  }));
                }}
              />
              {form.bookingRef && (
                <div className="mt-2 p-2 rounded border bg-muted text-xs flex items-center justify-between">
                  <span className="font-mono">Reserva: {form.bookingRef}</span>
                  <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setForm(f => ({ ...f, bookingRef: "" }))}>limpar</button>
                </div>
              )}
              {form.bookingRef && <LostFoundReservationPreview bookingId={form.bookingRef} />}
            </div>
            <div>
              <Label>Matrícula</Label>
              <Input value={form.vehiclePlate} onChange={e => setForm(f => ({ ...f, vehiclePlate: e.target.value.toUpperCase() }))} placeholder="AA-00-BB" />
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Tipo de Item *</Label>
              <Select value={form.itemType} onValueChange={(v: any) => setForm(f => ({ ...f, itemType: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Prioridade</Label>
              <Select value={form.priority} onValueChange={(v: any) => setForm(f => ({ ...f, priority: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PRIORITY_CONFIG).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Valor Estimado (€)</Label>
              <Input type="number" value={form.estimatedValue} onChange={e => setForm(f => ({ ...f, estimatedValue: e.target.value }))} placeholder="0" />
            </div>
          </div>
          <div>
            <Label>Descrição *</Label>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Descrever o item perdido/achado..." rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={createMut.isPending}>
            {createMut.isPending ? "A criar..." : "Criar Registo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
