import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlarmClock,
  AlertTriangle,
  Clock,
  Inbox,
  Keyboard,
  MessageCircle,
  PhoneMissed,
  Search,
  SlidersHorizontal,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { formatWaiting, type AssigneeFilter, type StatusFilter } from "@shared/whatsappConversation";
import { WHATSAPP_INTENTS, WHATSAPP_INTENT_LABELS } from "@shared/commsAi";
import { activeInboxFilterCount, type InboxListFilters } from "@shared/whatsappInboxView";

export interface InboxCounts {
  /** Conversas (no âmbito responsável+estado) com mensagens por ler. */
  unread: number;
  urgent: number;
  mine: number;
  overdue: number;
  closing: number;
}

/** Chip de filtro rápido (estilo dos filtros do WhatsApp Web). */
function Chip({
  active,
  onClick,
  title,
  tone = "default",
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  tone?: "default" | "alert" | "warn";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 h-6 px-2 rounded-full border text-[11px] font-medium whitespace-nowrap transition-colors",
        active
          ? "bg-green-100 text-green-900 border-green-300 dark:bg-green-950 dark:text-green-200 dark:border-green-800"
          : tone === "alert"
            ? "bg-red-50 text-red-800 border-red-200 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900"
            : tone === "warn"
              ? "bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900"
              : "bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Topo da coluna de conversas (2026-10-01): título + atalhos, pesquisa, botão
 * "Filtros" (popover com TODOS os filtros + contagem + limpar) e UMA linha de
 * chips rápidos. O antigo banner de alertas passou a ser um chip.
 * A semântica dos filtros não mudou — o estado vive na página.
 */
export function InboxListHeader({
  search,
  onSearchChange,
  searchRef,
  filters,
  onFiltersChange,
  onClearFilters,
  counts,
  slaMinutes,
  shownCount,
  isFetching,
  showShortcuts,
  pendingCallbacks,
  pendingCallbacksError = false,
  onOpenCallbacks,
  boxes = [],
}: {
  search: string;
  onSearchChange: (v: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  filters: InboxListFilters;
  onFiltersChange: (patch: Partial<InboxListFilters>) => void;
  onClearFilters: () => void;
  counts: InboxCounts;
  slaMinutes: number;
  shownCount: number;
  isFetching: boolean;
  showShortcuts: boolean;
  pendingCallbacks: number;
  /** Leitura das chamadas por devolver falhou: mostra-se (não desaparece). */
  pendingCallbacksError?: boolean;
  onOpenCallbacks: () => void;
  /** Caixas por tema que a pessoa vê (17f). */
  boxes?: Array<{ key: string; label: string }>;
}) {
  const active = activeInboxFilterCount(filters);
  const hasSearch = search.trim().length > 0;
  const alertsTitle =
    [
      counts.overdue > 0 ? `${counts.overdue} sem resposta há +${formatWaiting(slaMinutes)}` : null,
      counts.closing > 0 ? `${counts.closing} com a janela de 24h a fechar` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Sem alertas";

  return (
    <div className="shrink-0 border-b">
      {/* Título (a página deixou de ter cabeçalho próprio) */}
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
        <MessageCircle className="h-4 w-4 text-green-600 shrink-0" />
        <span className="font-semibold text-sm">Conversas</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{shownCount}</span>
        {isFetching && <Clock className="h-3 w-3 animate-spin text-muted-foreground" aria-label="A atualizar" />}
        <div className="ml-auto flex items-center gap-1">
          {pendingCallbacks > 0 && (
            <button
              type="button"
              onClick={onOpenCallbacks}
              className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-medium bg-red-50 text-red-800 border border-red-200 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900"
              title="Chamadas de clientes que ninguém atendeu — ver e devolver"
            >
              <PhoneMissed className="h-3 w-3" />
              {pendingCallbacks} por devolver
            </button>
          )}
          {pendingCallbacksError && pendingCallbacks === 0 && (
            <button
              type="button"
              onClick={onOpenCallbacks}
              className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-medium bg-amber-50 text-amber-900 border border-amber-200 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900"
              title="Não foi possível ler as chamadas por devolver — abre para tentar de novo"
            >
              <PhoneMissed className="h-3 w-3" /> por devolver: ?
            </button>
          )}
          {showShortcuts && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                  aria-label="Atalhos de teclado"
                >
                  <Keyboard className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-left">
                <div className="font-medium mb-0.5">Atalhos</div>
                <div>/ pesquisar · Alt+↑/↓ mudar de conversa · Esc fechar</div>
                <div className="opacity-80">Só texto livre com a janela de 24h aberta.</div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Caixa por tema (17f): Geral = ainda por separar. */}
      {boxes.length > 0 && (
        <div className="px-2 pb-1.5">
          <Select value={filters.box} onValueChange={(v) => onFiltersChange({ box: v })}>
            <SelectTrigger size="sm" className="h-8 w-full text-xs" aria-label="Caixa">
              <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as caixas</SelectItem>
              <SelectItem value="geral">Geral (por separar)</SelectItem>
              {boxes.map((b) => <SelectItem key={b.key} value={b.key}>{b.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Pesquisa + Filtros */}
      <div className="flex items-center gap-1.5 px-2 pb-1.5">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            ref={searchRef}
            type="text"
            placeholder="Pesquisar nome, número ou texto…"
            aria-label="Pesquisar conversas por nome ou número"
            aria-keyshortcuts="/"
            className="h-8 pl-8 pr-7 text-sm"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {hasSearch && (
            <button
              type="button"
              aria-label="Limpar pesquisa"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => onSearchChange("")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant={active > 0 ? "selected" : "outline"}
              size="sm"
              className="h-8 px-2 gap-1 shrink-0"
              aria-label={active > 0 ? `Filtros (${active} ativos)` : "Filtros"}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="text-xs">Filtros</span>
              {active > 0 && (
                <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-green-600 text-white text-[10px] font-semibold tabular-nums">
                  {active}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-3 space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Responsável</Label>
              <div className="flex items-center gap-1" role="group" aria-label="Filtrar por responsável">
                {([
                  ["all", "Todas"],
                  ["mine", `Minhas${counts.mine ? ` · ${counts.mine}` : ""}`],
                  ["unassigned", "Sem atribuição"],
                ] as [AssigneeFilter, string][]).map(([v, label]) => (
                  <Button
                    key={v}
                    type="button"
                    size="sm"
                    variant={filters.assignee === v ? "selected" : "outline"}
                    className="h-7 px-2 text-xs flex-1"
                    aria-pressed={filters.assignee === v}
                    onClick={() => onFiltersChange({ assignee: v })}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1 min-w-0">
                <Label className="text-xs">Estado</Label>
                <Select value={filters.status} onValueChange={(v) => onFiltersChange({ status: v as StatusFilter })}>
                  <SelectTrigger size="sm" className="w-full text-xs" aria-label="Filtrar por estado">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Ativas</SelectItem>
                    <SelectItem value="aberto">Abertas</SelectItem>
                    <SelectItem value="pendente">Pendentes</SelectItem>
                    <SelectItem value="resolvido">Resolvidas</SelectItem>
                    <SelectItem value="all">Todos os estados</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 min-w-0">
                <Label className="text-xs">Intenção (IA)</Label>
                <Select value={filters.intent} onValueChange={(v) => onFiltersChange({ intent: v })}>
                  <SelectTrigger size="sm" className="w-full text-xs" aria-label="Filtrar por intenção (IA)">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    {WHATSAPP_INTENTS.map((i) => (
                      <SelectItem key={i} value={i}>{WHATSAPP_INTENT_LABELS[i]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <ToggleRow
                id="wa-f-unread"
                label="Só não lidas"
                hint={String(counts.unread)}
                checked={filters.onlyUnread}
                onChange={(v) => onFiltersChange({ onlyUnread: v })}
              />
              <ToggleRow
                id="wa-f-urgent"
                label="Só urgentes (IA)"
                hint={String(counts.urgent)}
                checked={filters.onlyUrgent}
                onChange={(v) => onFiltersChange({ onlyUrgent: v })}
              />
              <ToggleRow
                id="wa-f-alerts"
                label="Só com alerta (SLA / janela)"
                hint={String(counts.overdue + counts.closing)}
                checked={filters.onlyAlerts}
                onChange={(v) => onFiltersChange({ onlyAlerts: v })}
              />
            </div>
            <div className="flex justify-end pt-1 border-t">
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={active === 0} onClick={onClearFilters}>
                <X className="h-3.5 w-3.5 mr-1" /> Limpar filtros
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Chips rápidos (os mesmos filtros do popover) */}
      <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
        <Chip
          active={filters.onlyUnread}
          onClick={() => onFiltersChange({ onlyUnread: !filters.onlyUnread })}
          title="Mostrar só conversas com mensagens por ler"
        >
          Não lidas <span className="tabular-nums opacity-70">{counts.unread}</span>
        </Chip>
        <Chip
          active={filters.assignee === "mine"}
          onClick={() => onFiltersChange({ assignee: filters.assignee === "mine" ? "all" : "mine" })}
          title="Mostrar só conversas atribuídas a mim"
        >
          <UserRound className="h-3 w-3" /> Minhas
          {counts.mine > 0 && <span className="tabular-nums opacity-70">{counts.mine}</span>}
        </Chip>
        <Chip
          active={filters.onlyUrgent}
          onClick={() => onFiltersChange({ onlyUrgent: !filters.onlyUrgent })}
          title="Mostrar só conversas marcadas como urgentes pela IA"
        >
          <Zap className="h-3 w-3" /> Urgentes <span className="tabular-nums opacity-70">{counts.urgent}</span>
        </Chip>
        {(counts.overdue > 0 || counts.closing > 0 || filters.onlyAlerts) && (
          <Chip
            active={filters.onlyAlerts}
            tone={counts.overdue > 0 ? "alert" : "warn"}
            onClick={() => onFiltersChange({ onlyAlerts: !filters.onlyAlerts })}
            title={`${alertsTitle} — ${filters.onlyAlerts ? "clica para ver todas" : "clica para ver só estas"}`}
          >
            {counts.overdue > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <AlarmClock className="h-3 w-3" />
                <span className="tabular-nums">{counts.overdue}</span>
              </span>
            )}
            {counts.closing > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <AlertTriangle className="h-3 w-3" />
                <span className="tabular-nums">{counts.closing}</span>
              </span>
            )}
            {counts.overdue === 0 && counts.closing === 0 && "Sem alertas"}
          </Chip>
        )}
        {active > 0 && (
          <button
            type="button"
            onClick={onClearFilters}
            className="inline-flex items-center gap-0.5 h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            title="Limpar todos os filtros"
          >
            <X className="h-3 w-3" /> Limpar
          </button>
        )}
      </div>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor={id} className="text-xs font-normal flex-1 cursor-pointer">
        {label} <span className="text-muted-foreground tabular-nums">({hint})</span>
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
