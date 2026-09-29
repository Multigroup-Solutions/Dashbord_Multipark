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

// Configuração partilhada da página Perdidos (estados, tipos, prioridades).
export const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  new: { label: "Novo", color: "bg-blue-100 text-blue-800 border-blue-200", icon: AlertCircle },
  investigating: { label: "Em Investigação", color: "bg-yellow-100 text-yellow-800 border-yellow-200", icon: Hourglass },
  found: { label: "Encontrado", color: "bg-emerald-100 text-emerald-800 border-emerald-200", icon: CheckCircle2 },
  returned: { label: "Devolvido", color: "bg-green-100 text-green-800 border-green-200", icon: CheckCircle2 },
  closed: { label: "Fechado", color: "bg-gray-100 text-gray-800 border-gray-200", icon: XCircle },
  converted: { label: "Convertido", color: "bg-violet-100 text-violet-800 border-violet-200", icon: XCircle },
};

export const TYPE_CONFIG: Record<string, { label: string; icon: any }> = {
  money: { label: "Dinheiro", icon: DollarSign },
  electronics: { label: "Eletrónica", icon: Smartphone },
  clothing: { label: "Roupa", icon: Shirt },
  documents: { label: "Documentos", icon: FileText },
  accessories: { label: "Acessórios", icon: Glasses },
  other: { label: "Outro", icon: HelpCircle },
};

export const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  low: { label: "Baixa", color: "bg-slate-100 text-slate-700" },
  medium: { label: "Média", color: "bg-blue-100 text-blue-700" },
  high: { label: "Alta", color: "bg-red-100 text-red-700" },
};

export const KANBAN_COLUMNS = ["new", "investigating", "found", "returned", "closed"] as const;

export const BASE_PATH = "/perdidos-achados";

export const CHANGE_TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  CREATED: { label: "Criada", color: "bg-blue-100 text-blue-800" },
  CHECKING_IN: { label: "A fazer check-in", color: "bg-cyan-100 text-cyan-800" },
  CHECK_IN: { label: "Check-in", color: "bg-green-100 text-green-800" },
  MOVEMENT: { label: "Movimento", color: "bg-amber-100 text-amber-800" },
  PENDING_CHECKOUT: { label: "Pend. Check-out", color: "bg-purple-100 text-purple-800" },
  CHECKING_OUT: { label: "A fazer check-out", color: "bg-indigo-100 text-indigo-800" },
  CHECK_OUT: { label: "Check-out", color: "bg-violet-100 text-violet-800" },
  ocorrencia: { label: "Ocorrência", color: "bg-red-100 text-red-800" },
};
