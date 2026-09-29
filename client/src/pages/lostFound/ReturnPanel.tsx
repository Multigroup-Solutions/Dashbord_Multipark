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

// ─── Devolução estruturada + email ao cliente ────────────────────────────────
export function ReturnPanel({ item }: { item: any }) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState({
    foundLocation: item.foundLocation || "",
    foundByName: item.foundByName || "",
    returnMethod: item.returnMethod || "",
    returnedAt: item.returnedAt ? String(item.returnedAt).slice(0, 10) : "",
  });
  const [emailOpen, setEmailOpen] = useState(false);
  const save = trpc.lostFound.update.useMutation({
    onSuccess: () => { utils.lostFound.getById.invalidate({ id: item.id }); toast.success("Devolução guardada"); },
    onError: (e) => toast.error(e.message),
  });
  const uploadReturn = trpc.lostFound.uploadReturnPhoto.useMutation({
    onSuccess: () => { utils.lostFound.getById.invalidate({ id: item.id }); toast.success("Foto da entrega guardada"); },
    onError: (e) => toast.error(e.message),
  });
  const onPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => uploadReturn.mutate({ itemId: item.id, base64: String(r.result).split(",")[1], filename: f.name });
    r.readAsDataURL(f);
    e.target.value = "";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span>Devolução ao cliente</span>
          {item.clientEmail && (
            <Button size="sm" variant="outline" onClick={() => setEmailOpen(true)}>
              <Mail className="w-4 h-4 mr-1" /> Avisar cliente
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label className="text-xs">Onde foi encontrado</Label>
            <Input value={form.foundLocation} onChange={e => setForm(f => ({ ...f, foundLocation: e.target.value }))} placeholder="Ex: porta-luvas, lugar A12" /></div>
          <div><Label className="text-xs">Quem encontrou</Label>
            <Input value={form.foundByName} onChange={e => setForm(f => ({ ...f, foundByName: e.target.value }))} placeholder="Condutor / agente" /></div>
          <div><Label className="text-xs">Como foi devolvido</Label>
            <Select value={form.returnMethod || "none"} onValueChange={v => setForm(f => ({ ...f, returnMethod: v === "none" ? "" : v }))}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">—</SelectItem>
                <SelectItem value="em_maos">Em mãos (no parque)</SelectItem>
                <SelectItem value="correio">Correio / transportadora</SelectItem>
                <SelectItem value="entrega">Entrega ao domicílio</SelectItem>
                <SelectItem value="outro">Outro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label className="text-xs">Data da devolução</Label>
            <Input type="date" value={form.returnedAt} onChange={e => setForm(f => ({ ...f, returnedAt: e.target.value }))} /></div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({
            id: item.id,
            foundLocation: form.foundLocation || null,
            foundByName: form.foundByName || null,
            returnMethod: form.returnMethod || null,
            returnedAt: form.returnedAt ? form.returnedAt + " 00:00:00" : null,
          })}>
            <CheckCircle2 className="w-4 h-4 mr-1" /> Guardar devolução
          </Button>
          <label className="text-xs text-blue-600 cursor-pointer inline-flex items-center gap-1">
            <Upload className="w-3 h-3" /> Foto/assinatura da entrega
            <input type="file" accept="image/*" className="hidden" onChange={onPhoto} />
          </label>
          {(item.returnPhotoUrl || item.returnPhotoKey) && <a href={fileHref(item.returnPhotoUrl, item.returnPhotoKey) ?? undefined} target="_blank" rel="noreferrer" className="text-xs underline">ver foto</a>}
        </div>
        {item.clientEmailSentAt && (
          <p className="text-xs text-muted-foreground">Cliente avisado por email em {fmtPTDateTime(item.clientEmailSentAt)}</p>
        )}
      </CardContent>
      {emailOpen && <ReturnEmailDialog item={item} onClose={() => setEmailOpen(false)} />}
    </Card>
  );
}

export function ReturnEmailDialog({ item, onClose }: { item: any; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [subject, setSubject] = useState(`Multipark — objeto encontrado`);
  const [body, setBody] = useState(
    `Informamos que foi encontrado um objeto associado à sua reserva${item.bookingRef ? ` ${item.bookingRef}` : ""}: ${item.description}.\n\n` +
    `Pode levantá-lo no parque ou responder a este email para combinarmos a devolução.\n\nObrigado.`
  );
  const send = trpc.lostFound.sendEmailToClient.useMutation({
    onSuccess: () => {
      utils.lostFound.getById.invalidate({ id: item.id });
      utils.lostFound.getMessages.invalidate({ itemId: item.id });
      toast.success("Email enviado ao cliente (e registado nas mensagens)");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Avisar cliente — {item.clientEmail}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Assunto</Label><Input value={subject} onChange={e => setSubject(e.target.value)} /></div>
          <div><Label>Modelo</Label>
            <Select onValueChange={(k) => { const t = REPLY_TEMPLATES.find(x => x.key === k); if (t) setBody(t.body); }}>
              <SelectTrigger><SelectValue placeholder="Escolher modelo…" /></SelectTrigger>
              <SelectContent>
                {REPLY_TEMPLATES.map(t => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Mensagem</Label><Textarea rows={6} value={body} onChange={e => setBody(e.target.value)} /></div>
          <p className="text-xs text-muted-foreground">Sai de perdidos@multipark.pt. A saudação ("Olá {"{nome}"}") é adicionada automaticamente.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={send.isPending || !subject || !body} onClick={() => send.mutate({ itemId: item.id, subject, body })}>
            <Mail className="w-4 h-4 mr-2" /> {send.isPending ? "A enviar…" : "Enviar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
