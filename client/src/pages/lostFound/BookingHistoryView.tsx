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

// ─── BOOKING HISTORY VIEW ────────────────────────────────────────────────────

export function BookingHistoryView({ onBack }: { onBack: () => void }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeSearch, setActiveSearch] = useState("");

  const { data: history = [], isLoading } = trpc.lostFound.bookingHistory.useQuery(
    { search: activeSearch || undefined },
    { enabled: !!activeSearch }
  );
  const { data: driverStats = [] } = trpc.lostFound.bookingHistoryDriverStats.useQuery();

  const handleSearch = () => setActiveSearch(searchTerm.trim());

  const fmtDate = (d: string | null) => d ? fmtPTDateTime(d) : "—";

  // Conta totais flagged
  const flaggedDrivers = driverStats.filter((d: any) => d.flagged).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Clock className="w-6 h-6 text-indigo-500" /> Histórico de Reservas
            </h1>
            <p className="text-muted-foreground">
              Histórico Multipark sincronizado (cron 15min). Condutores envolvidos em casos de perdidos/achados
              aparecem sinalizados.
            </p>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            placeholder="Pesquisar por ID reserva, matrícula ou condutor..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="pl-8"
          />
        </div>
        <Button onClick={handleSearch} disabled={isLoading}>
          {isLoading ? "A procurar..." : "Pesquisar"}
        </Button>
      </div>

      {/* Driver stats summary */}
      {driverStats.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              Actividade por Condutor (histórico total)
              {flaggedDrivers > 0 && (
                <Badge className="bg-red-500 text-white text-[10px]">
                  <Flag className="w-3 h-3 mr-1" /> {flaggedDrivers} envolvidos em casos
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="bg-muted/50 text-left">
                    <th className="p-2">Condutor</th>
                    <th className="p-2 text-right">Casos</th>
                    <th className="p-2 text-right">Total</th>
                    <th className="p-2 text-right">Check-ins</th>
                    <th className="p-2 text-right">Check-outs</th>
                    <th className="p-2 text-right">Movimentos</th>
                  </tr>
                </thead>
                <tbody>
                  {driverStats.filter((d: any) => d.userName).map((d: any) => (
                    <tr
                      key={d.userName}
                      className={`border-t cursor-pointer ${d.flagged ? "bg-red-50 hover:bg-red-100" : "hover:bg-muted/30"}`}
                      onClick={() => { setSearchTerm(d.userName); setActiveSearch(d.userName); }}
                    >
                      <td className="p-2 font-medium">
                        <div className="flex items-center gap-2">
                          <span>{d.userName}</span>
                          {d.flagged === 1 && (
                            <Badge className="bg-red-500 text-white text-[10px]">
                              <Flag className="w-3 h-3 mr-1" /> Envolvido
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="p-2 text-right">
                        {d.caseCount > 0 ? (
                          <Badge variant={d.caseCount > 2 ? "destructive" : "outline"}>{d.caseCount}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="p-2 text-right">{d.total}</td>
                      <td className="p-2 text-right text-green-600">{d.checkins}</td>
                      <td className="p-2 text-right text-violet-600">{d.checkouts}</td>
                      <td className="p-2 text-right text-amber-600">{d.movements}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {activeSearch && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Resultados para "{activeSearch}" — {history.length} registos
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {history.length === 0 ? (
              <p className="p-4 text-center text-muted-foreground">
                Sem resultados. Confirma que a reserva já foi sincronizada pela API Multipark.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      <th className="p-2">Data</th>
                      <th className="p-2">Tipo</th>
                      <th className="p-2">Condutor</th>
                      <th className="p-2">ID Reserva</th>
                      <th className="p-2">Matrícula</th>
                      <th className="p-2">Observações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h: any) => {
                      const cfg = CHANGE_TYPE_CONFIG[h.changeType] || { label: h.changeType, color: "bg-gray-100 text-gray-800" };
                      return (
                        <tr
                          key={h.id}
                          className={`border-t ${h.flagged ? "bg-red-50 hover:bg-red-100" : "hover:bg-muted/30"}`}
                        >
                          <td className="p-2 text-xs whitespace-nowrap">{fmtDate(h.actionDate)}</td>
                          <td className="p-2">
                            <Badge className={cfg.color}>{cfg.label}</Badge>
                          </td>
                          <td className="p-2 font-medium">
                            <div className="flex items-center gap-1">
                              <span>{[h.userName, h.userLastName].filter(Boolean).join(" ") || "—"}</span>
                              {h.flagged === 1 && (
                                <Flag className="w-3 h-3 text-red-500" />
                              )}
                            </div>
                          </td>
                          <td className="p-2 font-mono text-xs">{h.bookingId?.slice(-12)}</td>
                          <td className="p-2 font-mono">{h.licensePlate || "—"}</td>
                          <td className="p-2 text-xs text-muted-foreground">{(() => {
                            const lines = formatBookingHistoryDetails(h.remarks);
                            return lines.length ? lines.join(" · ") : "—";
                          })()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
